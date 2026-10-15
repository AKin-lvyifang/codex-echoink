import { KNOWLEDGE_ROOT_ROLES } from "./root-paths-core";
import { classifyKnowledgePath, knowledgeFolderBindingsSignature, knowledgeFolderIssues, knowledgeMaintenanceFolderIssues, normalizeKnowledgeDirectory, pathInKnowledgeDirectory, type KnowledgeFolderBinding, type KnowledgeFolderBindings } from "./folder-bindings";
import type { KnowledgeRootRole } from "./root-paths-core";

export type KnowledgeDirectoryMode = "existing" | "build";
export interface KnowledgeDirectoryFile { path: string; size: number; mtime: number; symbolicLink?: boolean }
export interface KnowledgeDirectoryMove { from: string; to: string; size: number; mtime: number }
export interface KnowledgeDirectoryPlanOptions { mode?: KnowledgeDirectoryMode }
export interface KnowledgeDirectoryApplyResult {
  configured: true;
  created: string[];
  moved: KnowledgeDirectoryMove[];
  refinement: "not-started" | "started" | "failed";
  refinementError?: string;
}

export interface KnowledgeDirectoryPlan {
  baseRevision: number;
  bindings: KnowledgeFolderBindings;
  reuse: string[];
  create: string[];
  sources: string[];
  issues: string[];
  mode: KnowledgeDirectoryMode;
  baseSignature: string;
  changes: { role: KnowledgeRootRole; before: KnowledgeFolderBinding; after: KnowledgeFolderBinding }[];
  moves: KnowledgeDirectoryMove[];
  excluded: { path: string; reason: string }[];
  fileSnapshot: string;
}
export async function previewKnowledgeDirectoryPlan(input: {
  baseRevision: number;
  bindings: KnowledgeFolderBindings;
  createPaths: readonly string[];
  kind(path: string): Promise<"folder" | "missing" | "other">;
  sourcePaths: readonly string[];
  mode?: KnowledgeDirectoryMode;
  baseline?: KnowledgeFolderBindings | null;
  files?: readonly KnowledgeDirectoryFile[];
  protectedPaths?: readonly string[];
}): Promise<KnowledgeDirectoryPlan> {
  const bindings = structuredClone(input.bindings);
  bindings.migrationIssues = [];
  for (const binding of Object.values(bindings.roles)) {
    binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(directory => binding.readPaths.includes(directory));
    if (binding.readPaths.length === 1) binding.writePath = binding.readPaths[0];
  }
  const mode = input.mode ?? "existing";
  const issues = [...knowledgeFolderIssues(bindings), ...knowledgeMaintenanceFolderIssues(bindings, input.baseline, mode === "build")];
  const approved = new Set(input.createPaths.map(normalizeKnowledgeDirectory));
  const reuse = new Set<string>();
  const create = new Set<string>();
  const addParents = async (directory: string) => {
    const parts = directory.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      const parentKind = await input.kind(parent);
      if (parentKind === "missing") create.add(parent);
      else if (parentKind !== "folder") issues.push(`${parent}：父路径不是目录`);
    }
  };
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const binding = bindings.roles[role];
    if (!binding.enabled) continue;
    if (binding.native && (role === "journal" || role === "templates")) { for (const directory of binding.readPaths) if (await input.kind(directory) === "folder") reuse.add(directory); continue; }
    for (const directory of binding.readPaths) {
      const kind = await input.kind(directory);
      if (kind === "folder") reuse.add(directory);
      else if (kind !== "missing" || !approved.has(directory)) issues.push(`${directory}：原位置已失效或不是目录`);
      else {
        await addParents(directory);
      }
      for (const child of binding.allowedSubdirectories) {
        if (!(binding.allowedSubdirectoryRoots ?? binding.readPaths).includes(directory)) continue;
        const target = `${directory}/${normalizeKnowledgeDirectory(child)}`;
        if (await input.kind(target) === "missing") {
          await addParents(target);
        }
      }
    }
  }
  const moves: KnowledgeDirectoryMove[] = [];
  const excluded: KnowledgeDirectoryPlan["excluded"] = [];
  const files: KnowledgeDirectoryFile[] = [...(input.files ?? input.sourcePaths.map(relative => ({ path: relative, size: 0, mtime: 0 })))].sort((a, b) => a.path.localeCompare(b.path));
  if (mode === "build") {
    const raw = bindings.roles.raw;
    if (raw.readPaths.length !== 1) issues.push("帮我搭建使用一个资料来源目录。");
    const destination = raw.writePath;
    for (const file of files) {
      const segments = file.path.split("/");
      let reason = "";
      if (file.symbolicLink || segments.some(segment => segment.startsWith(".") || segment.toLowerCase() === "node_modules")
        || ["agents.md", "llm-wiki.md"].includes(segments.at(-1)?.toLowerCase() ?? "")) reason = "配置或私有状态保持原位";
      else if (input.protectedPaths?.some(directory => pathInKnowledgeDirectory(file.path, directory))) reason = "其他功能产物保持原位";
      else if (classifyKnowledgePath(bindings, file.path) || (input.baseline && classifyKnowledgePath(input.baseline, file.path) && classifyKnowledgePath(input.baseline, file.path) !== "raw")) reason = "已绑定资料保持原位";
      if (reason) { excluded.push({ path: file.path, reason }); continue; }
      if (!destination) continue;
      let from: string;
      try { from = normalizeKnowledgeDirectory(file.path); } catch { excluded.push({ path: file.path, reason: "路径不可安全搬迁" }); continue; }
      const to = `${destination}/${from}`;
      if (classifyKnowledgePath(bindings, to) !== "raw") { issues.push(`${to}：搬迁目标不属于资料来源`); continue; }
      if (await input.kind(to) !== "missing") issues.push(`${to}：搬迁目标已存在，不会覆盖`);
      const parent = to.slice(0, to.lastIndexOf("/"));
      await addParents(parent);
      moves.push({ from, to, size: file.size, mtime: file.mtime });
    }
  }
  const targetPaths = new Map(moves.map(move => [move.from, move.to]));
  const sources = input.sourcePaths.map(relative => targetPaths.get(relative) ?? relative).filter(relative => classifyKnowledgePath(bindings, relative) === "raw");
  const changes = KNOWLEDGE_ROOT_ROLES.filter(role => knowledgeFolderBindingsSignature({ ...bindings, roles: { ...bindings.roles, [role]: input.baseline?.roles[role] ?? { enabled: false, readPaths: [], writePath: null, allowedSubdirectories: [] } } }) !== knowledgeFolderBindingsSignature(bindings))
    .map(role => ({ role, before: structuredClone(input.baseline?.roles[role] ?? { enabled: false, readPaths: [], writePath: null, allowedSubdirectories: [] }), after: structuredClone(bindings.roles[role]) }));
  return { baseRevision: input.baseRevision, baseSignature: knowledgeFolderBindingsSignature(input.baseline), mode, bindings, changes, moves, excluded,
    fileSnapshot: JSON.stringify(files.filter(file => moves.some(move => move.from === file.path) || sources.includes(file.path))),
    reuse: [...reuse].sort(), create: [...create].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
    sources: [...new Set(sources)].sort(), issues: [...new Set(issues)] };
}

export function knowledgeDirectoryPlanSignature(plan: KnowledgeDirectoryPlan): string {
  return JSON.stringify({ mode: plan.mode, baseRevision: plan.baseRevision, baseSignature: plan.baseSignature,
    bindings: knowledgeFolderBindingsSignature(plan.bindings), reuse: plan.reuse, create: plan.create,
    moves: plan.moves, sources: plan.sources, issues: plan.issues, fileSnapshot: plan.fileSnapshot });
}
