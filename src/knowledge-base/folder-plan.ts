import { assertKnowledgeModulePath, knowledgeModuleLabels, type KnowledgeEnglishDirectoryModes } from "./module-directories";
import { KNOWLEDGE_ROOT_ROLES } from "./root-paths-core";
import { classifyKnowledgePath, knowledgeFolderBindingsSignature, knowledgeFolderIssues, knowledgeInboxRecallExclusions, knowledgeMaintenanceFolderIssues, knowledgeWikiFolderSelectionIssues, normalizeKnowledgeDirectory, pathInKnowledgeDirectory, type KnowledgeFolderBinding, type KnowledgeFolderBindings } from "./folder-bindings";
import type { KnowledgeRootRole } from "./root-paths-core";

export type KnowledgeDirectoryMode = "existing" | "build";
export interface KnowledgeDirectoryFile { path: string; size: number; mtime: number; symbolicLink?: boolean }
export interface KnowledgeDirectoryMove { from: string; to: string; size: number; mtime: number }
export interface KnowledgeModuleDirectories { journal?: string; review?: string; english?: string; expressions?: string; pdfOriginal?: string }
export interface KnowledgeDirectoryPlanOptions { mode?: KnowledgeDirectoryMode; wikiChanged?: boolean; moduleDirectories?: KnowledgeModuleDirectories }
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
  /** Snapshot of module/native settings used to protect their existing files. */
  baseSettingsSignature?: string;
  wikiChanged?: boolean;
  moduleDirectories?: KnowledgeModuleDirectories;
  moduleDirectoryModes?: KnowledgeEnglishDirectoryModes;
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
  baseSettingsSignature?: string;
  wikiChanged?: boolean;
  moduleDirectories?: KnowledgeModuleDirectories;
  /** Consumption scope only; all shared roles remain in the saved bindings. */
  roleScope?: readonly KnowledgeRootRole[];
}): Promise<KnowledgeDirectoryPlan> {
  const roleScope = input.roleScope ?? KNOWLEDGE_ROOT_ROLES;
  const bindings = structuredClone(input.bindings);
  // A desktop draft cannot overwrite roles owned by the mobile compatibility path.
  for (const role of KNOWLEDGE_ROOT_ROLES) if (!roleScope.includes(role) && input.baseline) bindings.roles[role] = structuredClone(input.baseline.roles[role]);
  const inboxRecallExclusions = knowledgeInboxRecallExclusions(input.baseline, bindings);
  if (inboxRecallExclusions.length || bindings.inboxRecallExclusions) bindings.inboxRecallExclusions = inboxRecallExclusions;
  bindings.migrationIssues = bindings.migrationIssues.filter(issue => KNOWLEDGE_ROOT_ROLES.some(role => !roleScope.includes(role) && issue.startsWith(`${role}：`)));
  for (const role of roleScope) {
    const binding = bindings.roles[role];
    binding.autoOrganizePaths = (binding.autoOrganizePaths ?? []).filter(directory => binding.readPaths.includes(directory));
    if (binding.readPaths.length === 1) binding.writePath = binding.readPaths[0];
  }
  const mode = input.mode ?? "existing";
  const issues = [...knowledgeFolderIssues(bindings, roleScope), ...knowledgeMaintenanceFolderIssues(bindings, input.baseline, mode === "build")];
  if (input.wikiChanged) issues.push(...knowledgeWikiFolderSelectionIssues(bindings));
  const approved = new Set(input.createPaths.flatMap((value, index) => {
    const label = `新建目录（第 ${index + 1} 项）`;
    try {
      const directory = normalizeKnowledgeDirectory(value); assertKnowledgeModulePath(directory, label); return [directory];
    } catch { issues.push(`${label}：请选择合法的 Vault 相对目录（${JSON.stringify(value)}）。`); return []; }
  }));
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
  const moduleDirectories: KnowledgeModuleDirectories = {};
  for (const key of ["journal", "review", "english", "expressions", "pdfOriginal"] as const) {
    const value = input.moduleDirectories?.[key];
    if (value === undefined) continue;
    if (key === "journal" && value.trim() === "") { moduleDirectories.journal = ""; continue; }
    let directory: string;
    try { directory = normalizeKnowledgeDirectory(value); }
    catch { issues.push(`${knowledgeModuleLabels[key]}：请选择合法的 Vault 相对目录（${JSON.stringify(value)}）。`); continue; }
    try { assertKnowledgeModulePath(directory, knowledgeModuleLabels[key]); } catch (error) { issues.push((error as Error).message); continue; }
    moduleDirectories[key] = directory;
    const kind = await input.kind(directory);
    if (kind === "folder") reuse.add(directory);
    else if (kind === "missing" && mode === "build") await addParents(directory);
    else issues.push(`${knowledgeModuleLabels[key]}：${directory}：原位置已失效或不是目录`);
  }
  for (const role of roleScope) {
    const binding = bindings.roles[role];
    if (!binding.enabled) continue;
    for (const directory of [...binding.readPaths, ...binding.allowedSubdirectories]) {
      const label = { raw: "资料来源", wiki: "知识成果", projects: "项目", inbox: "收件箱", journal: "日记", outputs: "输出", templates: "模板", assets: "附件", work: "工作", archive: "归档" }[role];
      try { assertKnowledgeModulePath(directory, `${label}目录`); } catch (error) { issues.push((error as Error).message); }
    }
    if (binding.native && (role === "journal" || role === "templates")) { for (const directory of binding.readPaths) if (await input.kind(directory) === "folder") reuse.add(directory); continue; }
    for (const directory of binding.readPaths) {
      const kind = await input.kind(directory);
      if (kind === "folder") reuse.add(directory);
      else if (kind !== "missing" || !approved.has(directory)) issues.push(`${directory}：原位置已失效或不是目录`);
      else {
        await addParents(directory);
      }
      // Existing-directory setup only saves consent. Legacy child approvals do
      // not implicitly create folders when no new root was explicitly selected.
      if (mode === "existing" && !approved.has(directory)) continue;
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
    if (!raw.writePath || !raw.readPaths.includes(raw.writePath)) issues.push("资料来源：请选择一个明确的搬迁目的地。");
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
  const changes = roleScope.filter(role => knowledgeFolderBindingsSignature({ ...bindings, roles: { ...bindings.roles, [role]: input.baseline?.roles[role] ?? { enabled: false, readPaths: [], writePath: null, allowedSubdirectories: [] } } }) !== knowledgeFolderBindingsSignature(bindings))
    .map(role => ({ role, before: structuredClone(input.baseline?.roles[role] ?? { enabled: false, readPaths: [], writePath: null, allowedSubdirectories: [] }), after: structuredClone(bindings.roles[role]) }));
  return { baseRevision: input.baseRevision, baseSignature: knowledgeFolderBindingsSignature(input.baseline), baseSettingsSignature: input.baseSettingsSignature, wikiChanged: input.wikiChanged,
    moduleDirectories: Object.keys(moduleDirectories).length ? moduleDirectories : undefined, mode, bindings, changes, moves, excluded,
    fileSnapshot: JSON.stringify(files),
    reuse: [...reuse].sort(), create: [...create].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)),
    sources: [...new Set(sources)].sort(), issues: [...new Set(issues)] };
}

export function knowledgeDirectoryPlanSignature(plan: KnowledgeDirectoryPlan): string {
  return JSON.stringify({ mode: plan.mode, baseRevision: plan.baseRevision, baseSignature: plan.baseSignature, baseSettingsSignature: plan.baseSettingsSignature, wikiChanged: plan.wikiChanged, moduleDirectories: plan.moduleDirectories, moduleDirectoryModes: plan.moduleDirectoryModes,
    bindings: knowledgeFolderBindingsSignature(plan.bindings), reuse: plan.reuse, create: plan.create,
    moves: plan.moves, sources: plan.sources, issues: plan.issues, fileSnapshot: plan.fileSnapshot });
}
