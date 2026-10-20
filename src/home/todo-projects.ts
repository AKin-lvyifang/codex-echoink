import { TFolder } from "obsidian";
import type { App } from "obsidian";
import { normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";

export interface TodoProjectHost {
  app: Pick<App, "vault">;
  settings: { knowledgeBase?: { folderBindings?: KnowledgeFolderBindings | null } };
  settingsKnowledgeBindings?(): KnowledgeFolderBindings | null | undefined;
}

export interface TodoProject {
  path: string;
  name: string;
  rootPath: string;
  parentPath: string;
  label: string;
  /** Markdown value: unique name or disambiguating Vault-relative path. */
  value: string;
}

export interface TodoProjectResolution {
  status: "none" | "resolved" | "missing" | "ambiguous";
  value: string;
  name: string;
  label: string;
  project?: TodoProject;
}

/** Only existing, enabled project roots and their direct child folders qualify. */
export function getTodoProjects(host: TodoProjectHost): TodoProject[] {
  const bindings = host.settingsKnowledgeBindings?.() ?? host.settings.knowledgeBase?.folderBindings;
  const binding = bindings?.roles.projects;
  if (!binding?.enabled) return [];
  const projects = new Map<string, TodoProject>();
  for (const savedRoot of binding.readPaths) {
    let rootPath: string;
    try { rootPath = normalizeKnowledgeDirectory(savedRoot); } catch { continue; }
    const root = host.app.vault.getAbstractFileByPath(rootPath);
    if (!(root instanceof TFolder)) continue;
    for (const child of root.children) {
      if (!(child instanceof TFolder) || child.path.slice(0, child.path.lastIndexOf("/")) !== rootPath) continue;
      const name = child.path.slice(child.path.lastIndexOf("/") + 1);
      projects.set(child.path, { path: child.path, name, rootPath, parentPath: rootPath, label: name, value: name });
    }
  }
  const result = [...projects.values()];
  const counts = new Map<string, number>();
  for (const project of result) counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  for (const project of result) if ((counts.get(project.name) ?? 0) > 1) {
    project.value = project.path;
    project.label = `${project.name} · ${project.parentPath}`;
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export function resolveTodoProject(value: string | undefined, projects: readonly TodoProject[]): TodoProjectResolution {
  const saved = value?.trim() ?? "";
  const name = saved.slice(saved.lastIndexOf("/") + 1);
  if (!saved) return { status: "none", value: "", name: "", label: "—" };
  const matches = saved.includes("/") ? projects.filter(project => project.path === saved) : projects.filter(project => project.name === saved);
  if (matches.length === 1) return { status: "resolved", value: saved, name, label: matches[0].label, project: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", value: saved, name, label: "有同名项目，请重新选择" };
  return { status: "missing", value: saved, name, label: "项目已不存在" };
}

/** Selects use paths so a later duplicate name cannot silently switch the choice. */
export function serializeTodoProject(value: string | TodoProject | undefined, projects: readonly TodoProject[]): string {
  const selected = typeof value === "string" ? value.trim() : value?.path ?? "";
  if (!selected) return "";
  const result = resolveTodoProject(selected, projects);
  if (result.status !== "resolved" || !result.project) throw new Error(result.label);
  return result.project.value;
}
