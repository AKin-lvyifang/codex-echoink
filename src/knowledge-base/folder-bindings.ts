import { KNOWLEDGE_ROOT_ROLES, knowledgeRootRole, rebaseKnowledgePath, type KnowledgeRootRole } from "./root-paths-core";

export interface KnowledgeFolderBinding {
  enabled: boolean;
  /** Read-only retrieval consent, independent from organization/write consent. */
  searchEnabled?: boolean;
  readPaths: string[];
  writePath: string | null;
  /** Only these relative child directories were explicitly approved for creation. */
  allowedSubdirectories: string[];
  /** Roots to which the legacy relative approvals belong. Missing means legacy readPaths. */
  allowedSubdirectoryRoots?: string[];
  /** Ongoing organization consent belongs to each exact bound root, never the role. */
  autoOrganizePaths?: string[];
  compatibilityReadScopes?: boolean;
  native?: boolean;
}
export interface KnowledgeFolderBindings {
  schemaVersion: 1;
  revision: number;
  /** An explicitly saved directory setup; separate from knowledge extraction. */
  configured?: boolean;
  /** Desktop consent to create new child folders in approved wiki/projects roots only. */
  allowAgentSubfolders?: boolean;
  /** Missing legacy choices resolve to the existing raw write destination. */
  collectionTargets?: { web: string | null; wechat: string | null };
  /** Former Inbox roots withdrawn from ordinary-chat recall consent. */
  inboxRecallExclusions?: string[];
  roles: Record<KnowledgeRootRole, KnowledgeFolderBinding>;
  migrationIssues: string[];
}
export type KnowledgeFolderStatus = "ready" | "disabled" | "unbound" | "invalid";

export function normalizeKnowledgeDirectory(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/$/u, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[\0-\x1f]/u.test(part))) {
    throw new Error("请选择合法的 Vault 相对目录。");
  }
  return normalized;
}
export function emptyKnowledgeFolderBindings(): KnowledgeFolderBindings {
  return { schemaVersion: 1, revision: 1, roles: Object.fromEntries(KNOWLEDGE_ROOT_ROLES.map((role) => [role,
    { enabled: false, readPaths: [], writePath: null, allowedSubdirectories: [], autoOrganizePaths: [] }])) as unknown as KnowledgeFolderBindings["roles"], migrationIssues: [] };
}
export function normalizeKnowledgeFolderBindings(value: unknown): KnowledgeFolderBindings | null {
  if (!value || typeof value !== "object" || (value as KnowledgeFolderBindings).schemaVersion !== 1) return null;
  const input = value as KnowledgeFolderBindings;
  const result = emptyKnowledgeFolderBindings();
  result.revision = Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : 1;
  if (input.configured === true) result.configured = true;
  if (typeof input.allowAgentSubfolders === "boolean") result.allowAgentSubfolders = input.allowAgentSubfolders;
  if (input.collectionTargets && typeof input.collectionTargets === "object") {
    const target = (value: unknown): string | null => {
      try { return typeof value === "string" ? normalizeKnowledgeDirectory(value) : null; } catch { return null; }
    };
    result.collectionTargets = { web: target(input.collectionTargets.web), wechat: target(input.collectionTargets.wechat) };
  }
  if (Array.isArray(input.inboxRecallExclusions)) result.inboxRecallExclusions = [...new Set(input.inboxRecallExclusions.flatMap(value => {
    try { return typeof value === "string" ? [normalizeKnowledgeDirectory(value)] : []; } catch { return []; }
  }))];
  result.migrationIssues = Array.isArray(input.migrationIssues) ? input.migrationIssues.filter((item) => typeof item === "string") : [];
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const saved = input.roles?.[role];
    if (!saved) continue;
    const paths = (items: unknown): string[] => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === "string").map((item) => {
      try { return normalizeKnowledgeDirectory(item); } catch { return ""; }
    }).filter(Boolean))] : [];
    const readPaths = paths(saved.readPaths);
    result.roles[role] = { enabled: saved.enabled === true, searchEnabled: saved.searchEnabled !== false, readPaths,
      writePath: paths([saved.writePath])[0] ?? null,
      allowedSubdirectories: paths(saved.allowedSubdirectories), allowedSubdirectoryRoots: paths(Array.isArray(saved.allowedSubdirectoryRoots) ? saved.allowedSubdirectoryRoots : saved.readPaths).filter(directory => readPaths.includes(directory)),
      autoOrganizePaths: paths(saved.autoOrganizePaths).filter(directory => readPaths.includes(directory)),
      compatibilityReadScopes: saved.compatibilityReadScopes === true, native: (role === "journal" || role === "templates") && saved.native === true };
  }
  return result;
}

/** An explicit missing/invalid choice must never fall back to another source. */
export function knowledgeCollectionDirectory(config: KnowledgeFolderBindings | null | undefined, kind: "web" | "wechat"): string | null {
  const raw = config?.roles.raw;
  if (!raw?.enabled) return null;
  const selected = config?.collectionTargets ? config.collectionTargets[kind] : raw.writePath;
  if (!selected || !raw.readPaths.includes(selected)) return null;
  try { return normalizeKnowledgeDirectory(selected) === selected ? selected : null; } catch { return null; }
}

/** Desktop selection rule only; existing shared/legacy bindings keep their scopes. */
export function knowledgeWikiFolderSelectionIssues(config: KnowledgeFolderBindings): string[] {
  const wiki = config.roles.wiki;
  if (!wiki.enabled) return [];
  if (wiki.readPaths.length !== 1) return ["知识成果：请选择一个一级文件夹"];
  try {
    const selected = normalizeKnowledgeDirectory(wiki.readPaths[0]);
    if (selected !== wiki.readPaths[0] || selected.includes("/")) return ["知识成果：请选择一个一级文件夹"];
  } catch { return ["知识成果：请选择一个一级文件夹"]; }
  return [];
}

/** Remember withdrawn Inbox roots without changing any other role's consent. */
export function knowledgeInboxRecallExclusions(previous: KnowledgeFolderBindings | null | undefined, next: KnowledgeFolderBindings): string[] {
  const enabledPaths = (value: KnowledgeFolderBindings | null | undefined): string[] => {
    const inbox = value?.roles.inbox;
    return inbox?.enabled && inbox.searchEnabled !== false ? inbox.readPaths : [];
  };
  const active = new Set(enabledPaths(next));
  return [...new Set([...(previous?.inboxRecallExclusions ?? []), ...(next.inboxRecallExclusions ?? []), ...enabledPaths(previous)])]
    .filter(directory => !active.has(directory)).sort();
}
export function pathInKnowledgeDirectory(value: string, directory: string): boolean {
  return value === directory || value.startsWith(`${directory}/`);
}
export function classifyKnowledgePath(config: KnowledgeFolderBindings, value: string, roleScope: readonly KnowledgeRootRole[] = KNOWLEDGE_ROOT_ROLES): KnowledgeRootRole | null {
  const normalized = value.replace(/\\/gu, "/");
  const matches = KNOWLEDGE_ROOT_ROLES.flatMap((role) => config.roles[role].enabled
    ? config.roles[role].readPaths.filter((directory) => pathInKnowledgeDirectory(normalized, directory)).map((directory) => ({ role, directory })) : []);
  matches.sort((a, b) => b.directory.length - a.directory.length || (a.role === "raw" ? -1 : b.role === "raw" ? 1 : a.role.localeCompare(b.role)));
  const owner = matches[0]?.role;
  // Retiring a nested purpose must not widen an ancestor Raw/Wiki recall scope.
  return owner && roleScope.includes(owner) ? owner : null;
}
export function knowledgeFolderIssues(config: KnowledgeFolderBindings, roleScope: readonly KnowledgeRootRole[] = KNOWLEDGE_ROOT_ROLES): string[] {
  const issues: string[] = [];
  const labels: Record<KnowledgeRootRole, string> = { raw: "资料来源", wiki: "知识成果", projects: "项目", outputs: "输出", inbox: "收件箱", journal: "日记", work: "工作", archive: "归档", templates: "模板", assets: "附件" };
  for (const role of roleScope) {
    const binding = config.roles[role];
    if (!binding.enabled) continue;
    if (binding.native && (role === "journal" || role === "templates")) continue;
    if (!binding.readPaths.length) issues.push(`${labels[role]}：尚未选择位置`);
    if (role !== "raw" && binding.readPaths.length > 1 && !binding.compatibilityReadScopes) issues.push(`${labels[role]}：只能选择一个位置`);
    if (binding.writePath && !binding.readPaths.includes(binding.writePath)) issues.push(`${labels[role]}：默认保存位置不在读取范围中`);
    if (role === "raw" && binding.readPaths.length > 1 && !binding.writePath) issues.push("资料来源：请选择默认保存位置");
  }
  for (const role of ["wiki", "projects"] as const) if (config.roles[role].enabled && config.roles.raw.enabled) {
    for (const directory of config.roles[role].readPaths) if (config.roles.raw.readPaths.includes(directory)) issues.push(`资料来源与${labels[role]}不能使用同一路径：${directory}`);
  }
  return issues;
}
/** Upgrade only from observed folders; never create or infer missing default roots. */
export function migrateKnowledgeFolderBindings(directories: readonly string[], mobilePaths?: Partial<Record<"raw" | "wiki" | "inbox", string>>): KnowledgeFolderBindings {
  const result = emptyKnowledgeFolderBindings();
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const observed = directories.filter((directory) => !directory.includes("/") && knowledgeRootRole(directory) === role);
    const mobile = mobilePaths?.[role as "raw" | "wiki" | "inbox"];
    let selected: string | null = null;
    if (mobile && ![role, ""].includes(mobile)) {
      try {
        selected = normalizeKnowledgeDirectory(mobile);
        if (observed.length && !observed.includes(selected)) result.migrationIssues.push(`${role}：保留移动位置 ${selected}；原桌面位置 ${observed.join("、")} 请确认`);
      } catch { result.migrationIssues.push(`${role}：移动位置无效，请重新选择`); }
    }
    const readPaths = [...new Set([...observed, ...(selected ? [selected] : [])])];
    result.roles[role] = { enabled: readPaths.length > 0, readPaths,
      writePath: result.migrationIssues.some((issue) => issue.startsWith(`${role}：`)) ? null : selected ?? (readPaths.length === 1 ? readPaths[0] : readPaths.includes(role) ? role : null), allowedSubdirectories: [], compatibilityReadScopes: observed.length > 1 };
  }
  for (const role of ["wiki", "projects"] as const) if (result.roles[role].readPaths.some((directory) => result.roles.raw.readPaths.includes(directory))) {
    result.migrationIssues.push(`raw：与 ${role} 位置冲突`, `${role}：与资料来源位置冲突`);
  }
  for (const role of KNOWLEDGE_ROOT_ROLES) if (result.migrationIssues.some((issue) => issue.startsWith(`${role}：`))) result.roles[role].writePath = null;
  return result;
}
export function rebaseKnowledgeFolderBindings(config: KnowledgeFolderBindings, from: string, to: string): KnowledgeFolderBindings {
  const next = structuredClone(config);
  for (const binding of Object.values(next.roles)) {
    binding.readPaths = binding.readPaths.map((item) => rebaseKnowledgePath(item, from, to));
    if (binding.allowedSubdirectoryRoots) binding.allowedSubdirectoryRoots = binding.allowedSubdirectoryRoots.map((item) => rebaseKnowledgePath(item, from, to));
    if (binding.autoOrganizePaths) binding.autoOrganizePaths = binding.autoOrganizePaths.map((item) => rebaseKnowledgePath(item, from, to));
    if (binding.writePath) binding.writePath = rebaseKnowledgePath(binding.writePath, from, to);
  }
  if (next.collectionTargets) for (const kind of ["web", "wechat"] as const) {
    if (next.collectionTargets[kind]) next.collectionTargets[kind] = rebaseKnowledgePath(next.collectionTargets[kind]!, from, to);
  }
  if (next.inboxRecallExclusions) next.inboxRecallExclusions = [...new Set(next.inboxRecallExclusions.map(item => rebaseKnowledgePath(item, from, to)))];
  if (knowledgeFolderBindingsSignature(next) !== knowledgeFolderBindingsSignature(config)) next.revision += 1;
  return next;
}

/** Compare effective drafts without revision numbers, order, or absent legacy defaults. */
export function knowledgeFolderBindingsSignature(config: KnowledgeFolderBindings | null | undefined): string {
  return JSON.stringify({ allowAgentSubfolders: config?.allowAgentSubfolders === true,
    collectionTargets: config?.collectionTargets ?? { web: config?.roles.raw.writePath ?? null, wechat: config?.roles.raw.writePath ?? null },
    inboxRecallExclusions: [...(config?.inboxRecallExclusions ?? [])].sort(),
    roles: KNOWLEDGE_ROOT_ROLES.map(role => {
    const binding = config?.roles[role];
    return { role, enabled: binding?.enabled === true, searchEnabled: binding?.searchEnabled !== false, readPaths: [...(binding?.readPaths ?? [])].sort(),
      writePath: binding?.readPaths.length === 1 ? binding.readPaths[0] : binding?.writePath ?? null,
      allowedSubdirectories: [...(binding?.allowedSubdirectories ?? [])].sort(),
      allowedSubdirectoryRoots: binding?.allowedSubdirectories.length ? [...(binding.allowedSubdirectoryRoots ?? binding.readPaths)].filter(directory => binding.readPaths.includes(directory)).sort() : [],
      autoOrganizePaths: [...(binding?.autoOrganizePaths ?? [])].filter(directory => binding?.readPaths.includes(directory)).sort(),
      native: binding?.native === true, compatibilityReadScopes: binding?.compatibilityReadScopes === true };
  }) });
}

export function knowledgeMaintenanceFolderIssues(config: KnowledgeFolderBindings, baseline?: KnowledgeFolderBindings | null, build = false): string[] {
  const sources = (value: KnowledgeFolderBindings) => value.roles.raw.enabled && value.roles.raw.readPaths.length > 0;
  const outcomes = (value: KnowledgeFolderBindings) => (["wiki", "projects"] as const).some(role => value.roles[role].enabled && !!value.roles[role].writePath);
  if (!build && !(baseline && sources(baseline) && outcomes(baseline))) return [];
  const issues: string[] = [];
  if (!sources(config)) issues.push("维护需要资料来源，请保留或换绑至少一个来源目录。");
  if (build ? !(config.roles.wiki.enabled && config.roles.wiki.writePath) : !outcomes(config)) issues.push(build
    ? "帮我搭建需要知识成果位置，请选择 Wiki 目录。"
    : "维护需要知识成果或项目位置，请保留或换绑至少一个成果目录。");
  return issues;
}

/** A consumption view only. Never persist it over the complete shared roles. */
export function projectedKnowledgeFolderRoles(config: KnowledgeFolderBindings, roleScope: readonly KnowledgeRootRole[] = KNOWLEDGE_ROOT_ROLES): Partial<KnowledgeFolderBindings["roles"]> {
  return Object.fromEntries(roleScope.map(role => [role, config.roles[role]]));
}

export function knowledgeFolderOrganizationPrompt(config: KnowledgeFolderBindings, roleScope: readonly KnowledgeRootRole[] = KNOWLEDGE_ROOT_ROLES): string {
  const allowed = roleScope.flatMap(role => {
    const binding = config.roles[role];
    return binding.enabled ? (binding.autoOrganizePaths ?? []).filter(directory => binding.readPaths.includes(directory)) : [];
  });
  return `允许 Agent 自动整理的实际目录：${JSON.stringify(allowed)}。只可在同一个已授权绑定目录内创建分类文件夹和移动文件；不能跨绑定或跨用途搬迁，不增加删除或正文修改授权，仍遵守会话写权限及逐次确认。其他绑定沿用已有目录或该路径原先显式批准的子目录，不任意创建分类或移动。知识维护候选仍只写已选知识成果或项目位置。`;
}
