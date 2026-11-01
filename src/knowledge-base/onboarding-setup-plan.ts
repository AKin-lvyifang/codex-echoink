import { emptyKnowledgeFolderBindings, knowledgeCollectionTargets, normalizeKnowledgeDirectory, pathInKnowledgeDirectory, type KnowledgeFolderBindings } from "./folder-bindings";
import type { KnowledgeDirectoryFile, KnowledgeDirectoryPlan, KnowledgeDirectoryPlanOptions, KnowledgeModuleDirectories } from "./folder-plan";
import { KNOWLEDGE_ROOT_NAMES, type KnowledgeRootRole } from "./root-paths-core";

const NAMES = {
  zh: { raw: "资料来源", wiki: "知识成果", projects: "项目", inbox: "收件箱", outputs: "产出", journal: "日记" },
  en: { raw: "raw", wiki: "wiki", projects: "projects", inbox: "inbox", outputs: "outputs", journal: "journal" }
} as const;
type SetupRole = keyof typeof NAMES.zh;
export interface OnboardingProtectedPath { path: string; reason: string }
export interface OnboardingSetupPlan {
  /** Pass this unchanged to the existing directory executor after confirmation. */
  directoryPlan: KnowledgeDirectoryPlan;
  sources: { path: string; noteCount: number; existingBinding: boolean }[];
  skipped: { path: string; reason: string; noteCount: number }[];
  rootNotes: { count: number; description: string };
  noteCount: number;
  outputLocations: { answer: string; generation: string };
  guide: { path: string; action: "create" | "preserve" | "blocked" };
}
export interface OnboardingSetupInput {
  language: "zh" | "en";
  baseline?: KnowledgeFolderBindings | null;
  /** Actual directory topology, including empty and excluded directories. */
  folders: readonly string[];
  /** Host file-list/cache metadata only. Never read note bodies to populate this. */
  files: readonly KnowledgeDirectoryFile[];
  protectedPaths: readonly OnboardingProtectedPath[];
  /** Explicit module/native journal location; empty means native root journals. */
  journalDirectory?: string;
  moduleDirectories?: KnowledgeModuleDirectories;
  preview(bindings: KnowledgeFolderBindings, createPaths: readonly string[], options: KnowledgeDirectoryPlanOptions): Promise<KnowledgeDirectoryPlan>;
}

const overlaps = (a: string, b: string) => pathInKnowledgeDirectory(a, b) || pathInKnowledgeDirectory(b, a);
const fold = (value: string) => value.toLowerCase();
/** Yield to the host between batches, rather than monopolizing its UI thread. */
export const yieldOnboardingScan = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));

/** Read-only: choose purposes first, then bind eligible top-level sources in place. */
export async function generateOnboardingSetupPlan(input: OnboardingSetupInput): Promise<OnboardingSetupPlan> {
  const bindings = structuredClone(input.baseline ?? emptyKnowledgeFolderBindings());
  const folders = new Set(input.folders);
  const occupied = new Set([...input.folders, ...input.files.map(file => file.path)].map(fold));
  const protectedPaths = [...input.protectedPaths];
  const create = new Set<string>();
  const selected: string[] = [];
  const issues: string[] = [];
  const modulePaths = (["journal", "review", "english", "expressions", "pdfOriginal"] as const)
    .map(key => input.moduleDirectories?.[key]).filter((directory): directory is string => !!directory);
  for (const [role, binding] of Object.entries(bindings.roles)) {
    for (const path of binding.readPaths) protectedPaths.push({ path, reason: `已有${role}用途` });
  }
  for (const directory of [input.journalDirectory, ...modulePaths]) {
    if (directory) protectedPaths.push({ path: directory, reason: "已有模块位置" });
  }
  for (const kind of ["answer", "generation"] as const) {
    const saved = input.baseline?.collectionTargets?.[kind];
    const pending = kind === "answer" ? input.baseline?.answerDirectoryPending : input.baseline?.generationDirectoryPending;
    if (saved && !pending) protectedPaths.push({ path: saved, reason: "已有产出位置" });
  }
  // Protect conventional native/module locations even before they have settings.
  const specialNames = new Set(["日记", "journal", "日记（journal）", "模板", "templates", "模板（templates）", "财务", "finance", "财务（finance）", "复盘", "review", "英文日记", "表达库"]);
  let batch = 0;
  for (const directory of input.folders) {
    const leaf = directory.split("/").at(-1)!;
    if (leaf.startsWith(".") || fold(leaf) === "node_modules" || specialNames.has(fold(leaf))) protectedPaths.push({ path: directory, reason: "模块、配置或私有目录" });
    if (++batch % 512 === 0) await yieldOnboardingScan();
  }
  const conflicts = (directory: string, role?: SetupRole) => protectedPaths.some(item => overlaps(fold(directory), fold(item.path))
    && !(role === "journal" && directory === item.path && item.reason === "模块、配置或私有目录"))
    || selected.some(path => overlaps(fold(directory), fold(path)));
  const addCreate = (directory: string) => { if (!folders.has(directory)) create.add(directory); };
  const choose = (role: SetupRole): string => {
    const candidates = [...new Set([NAMES[input.language][role], NAMES.en[role], NAMES.zh[role], KNOWLEDGE_ROOT_NAMES[role]])];
    const existing = candidates.find(directory => folders.has(directory) && !conflicts(directory, role));
    let directory: string = existing ?? candidates[0];
    if (!existing) {
      let suffix = 2;
      while (occupied.has(fold(directory)) || conflicts(directory, role)) directory = `${candidates[0]} ${suffix++}`;
      occupied.add(fold(directory)); addCreate(directory);
    }
    if (role !== "raw") selected.push(directory);
    return directory;
  };
  const bind = (role: KnowledgeRootRole, directory: string) => {
    Object.assign(bindings.roles[role], { enabled: true, searchEnabled: true, readPaths: [directory], writePath: directory, native: false });
  };
  for (const role of ["wiki", "projects", "inbox", "outputs"] as const) {
    const binding = bindings.roles[role];
    if (binding.readPaths.length) { selected.push(...binding.readPaths); continue; }
    bind(role, choose(role));
  }
  const modules: KnowledgeModuleDirectories = {};
  if (bindings.roles.journal.readPaths.length || bindings.roles.journal.native) {
    selected.push(...bindings.roles.journal.readPaths);
  } else if (input.journalDirectory === "") {
    Object.assign(bindings.roles.journal, { enabled: true, native: true, readPaths: [], writePath: null });
  } else {
    const journal = input.journalDirectory ?? choose("journal");
    bind("journal", journal); selected.push(journal);
    // Only a new default changes the module location. Explicit custom settings stay put.
    if (input.journalDirectory === undefined) modules.journal = journal;
    addCreate(journal);
  }
  for (const directory of modulePaths) { selected.push(directory); addCreate(directory); }
  for (const directory of selected) protectedPaths.push({ path: directory, reason: "保留给其他用途" });

  const raw = bindings.roles.raw;
  const originalSources = new Set(raw.readPaths);
  // Existing defaults win; supply one only where none was chosen.
  let defaultSource = raw.writePath ?? (raw.readPaths.length === 1 ? raw.readPaths[0] : null);
  const missingSourceDefault = raw.enabled && raw.readPaths.length > 1 && !defaultSource;
  if (!raw.readPaths.length) {
    defaultSource = choose("raw");
    bind("raw", defaultSource);
  } else if (missingSourceDefault) {
    defaultSource = raw.readPaths.find(directory => [NAMES[input.language].raw, NAMES.en.raw, NAMES.zh.raw].some(name => name === directory)) ?? choose("raw");
    if (!raw.readPaths.includes(defaultSource)) raw.readPaths.push(defaultSource);
  }
  const counts = new Map<string, number>();
  const notes: string[] = [];
  let rootCount = 0;
  batch = 0;
  for (const file of input.files) {
    if (/\.(?:md|markdown)$/iu.test(file.path) && !file.symbolicLink) {
      notes.push(file.path);
      const parts = file.path.split("/");
      if (parts.length === 1) rootCount++;
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join("/");
        counts.set(directory, (counts.get(directory) ?? 0) + 1);
      }
    }
    if (++batch % 512 === 0) await yieldOnboardingScan();
  }
  const skipped: OnboardingSetupPlan["skipped"] = [];
  for (const directory of [...folders].filter(path => !path.includes("/")).sort()) {
    if (raw.readPaths.some(root => pathInKnowledgeDirectory(directory, root))) continue;
    const nestedSource = raw.readPaths.find(root => pathInKnowledgeDirectory(root, directory));
    if (nestedSource) { skipped.push({ path: directory, reason: `保留已有资料来源范围：${nestedSource}`, noteCount: counts.get(directory) ?? 0 }); continue; }
    const protection = protectedPaths.find(item => overlaps(fold(directory), fold(item.path)));
    if (protection) skipped.push({ path: directory, reason: `${protection.reason}：${protection.path}`, noteCount: counts.get(directory) ?? 0 });
    else raw.readPaths.push(directory);
    if (++batch % 512 === 0) await yieldOnboardingScan();
  }
  // A former single source had an implicit default; materialize it before the
  // added sources would make that default ambiguous.
  if (!raw.writePath) raw.writePath = defaultSource;
  // Never silently repair conflicting saved purposes by dropping a user's binding.
  for (const role of ["wiki", "projects", "inbox", "outputs", "journal"] as const) for (const directory of bindings.roles[role].readPaths) {
    if (raw.enabled && bindings.roles[role].enabled && raw.readPaths.some(source => fold(source) === fold(directory))) {
      issues.push(`${directory}：资料来源与其他用途冲突，请先调整绑定。`);
    }
  }
  for (const binding of Object.values(bindings.roles)) {
    if (binding.enabled) for (const directory of binding.readPaths) addCreate(directory);
  }
  const targets = knowledgeCollectionTargets(bindings);
  if (!originalSources.size || missingSourceDefault) for (const kind of ["web", "wechat", "files", "images"] as const) {
    if (!originalSources.size || !targets[kind]) targets[kind] = defaultSource;
  }
  const output = bindings.roles.outputs.writePath ?? bindings.roles.outputs.readPaths[0];
  for (const kind of ["answer", "generation"] as const) {
    const pending = kind === "answer" ? input.baseline?.answerDirectoryPending : input.baseline?.generationDirectoryPending;
    const saved = input.baseline?.collectionTargets;
    if (!saved || !Object.hasOwn(saved, kind) || pending) targets[kind] = output;
    if (targets[kind]) addCreate(targets[kind]);
    else issues.push(`${kind}：已有产出位置无效，请先调整设置。`);
  }
  bindings.collectionTargets = targets;
  bindings.answerDirectoryPending = false; bindings.generationDirectoryPending = false;
  for (const directory of create) {
    try { normalizeKnowledgeDirectory(directory); } catch { issues.push(`${directory}：目录无效，请先调整已有设置。`); }
  }
  const directoryPlan = await input.preview(bindings, [...create], { mode: "build", moduleDirectories: modules });
  directoryPlan.issues.push(...issues);
  const guidePath = `${output}/${input.language === "zh" ? "开始使用 EchoInk" : "Getting started with EchoInk"}.md`;
  const fileExists = input.files.some(file => fold(file.path) === fold(guidePath));
  const folderExists = input.folders.some(directory => fold(directory) === fold(guidePath));
  if (folderExists) directoryPlan.issues.push(`${guidePath}：指南路径已被文件夹占用。`);
  const sourcePaths = raw.readPaths;
  let noteCount = 0;
  // Count the union of the /ask roles, avoiding double counts from nested roots.
  const owners = new Map<string, KnowledgeRootRole>();
  for (const [role, binding] of Object.entries(directoryPlan.bindings.roles)) if (binding.enabled) {
    for (const directory of binding.readPaths) owners.set(directory, role as KnowledgeRootRole);
  }
  for (const note of notes) {
    const parts = note.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const owner = owners.get(parts.slice(0, i).join("/"));
      if (owner) { if (["raw", "wiki", "projects"].includes(owner)) noteCount++; break; }
    }
    if (++batch % 512 === 0) await yieldOnboardingScan();
  }
  return {
    directoryPlan,
    sources: sourcePaths.map(path => ({ path, noteCount: counts.get(path) ?? 0, existingBinding: originalSources.has(path) })),
    skipped, rootNotes: { count: rootCount, description: input.language === "zh" ? "留在原位（对话能搜到，/ask 默认不含）" : "Stay in place (searchable in chat, excluded from /ask by default)" },
    noteCount, outputLocations: { answer: targets.answer ?? "", generation: targets.generation ?? "" },
    guide: { path: guidePath, action: fileExists ? "preserve" : folderExists ? "blocked" : "create" }
  };
}
