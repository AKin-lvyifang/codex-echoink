import { COLLECTION_DOCUMENT_TYPES, COLLECTION_IMAGE_TYPES } from "./collection-file-types";
import { KNOWLEDGE_ROOT_NAMES, KNOWLEDGE_ROOT_ROLES, knowledgeRootRole, rebaseKnowledgePath, type KnowledgeRootRole } from "./root-paths-core";

export const KNOWLEDGE_COLLECTION_KINDS = ["web", "wechat", "files", "images", "text", "fileText"] as const;
export type KnowledgeCollectionKind = typeof KNOWLEDGE_COLLECTION_KINDS[number];
export const KNOWLEDGE_COLLECTION_LABELS: Record<KnowledgeCollectionKind, string> = { web: "网页链接", wechat: "公众号文章", files: "拖入或附加的文档", images: "拖入或附加的图片", text: "对话栏内容", fileText: "拖入或附加的文档" };
export type KnowledgeCollectionTargets = { web: string | null; wechat: string | null; files?: string | null; images?: string | null; text?: string | null; fileText?: string | null };

export interface KnowledgeFolderBinding {
  enabled: boolean;
  /** Read-only retrieval consent, independent from organization/write consent. */
  searchEnabled?: boolean;
  readPaths: string[];
  writePath: string | null;
  /** Legacy child metadata, retained for module output setup and capture migration only. */
  allowedSubdirectories: string[];
  /** Roots to which the legacy relative approvals belong. Missing means legacy readPaths. */
  allowedSubdirectoryRoots?: string[];
  /** Legacy input/history only; never grants Agent classification permission. */
  autoOrganizePaths?: string[];
  compatibilityReadScopes?: boolean;
  native?: boolean;
}
export interface KnowledgeOrganizationSettings {
  enabled: boolean;
  scope: "all" | "selected";
  /** Vault-relative paths; each selected folder includes all descendants. */
  paths: string[];
}
export interface KnowledgeFolderBindings {
  schemaVersion: 1;
  revision: number;
  /** An explicitly saved directory setup; separate from knowledge extraction. */
  configured?: boolean;
  /** Unified classification consent. Absence migrates every legacy choice to enabled/all. */
  organization?: KnowledgeOrganizationSettings;
  /** Legacy input only; never used for classification authorization. */
  allowAgentSubfolders?: boolean;
  /** Each capture entry owns a literal destination. Missing fields are migrated once. */
  collectionTargets?: KnowledgeCollectionTargets;
  /** Only the new default location can be created once, by an explicit save. */
  conversationDirectoryPending?: boolean;
  /** Former Inbox roots withdrawn from ordinary-chat recall consent. */
  inboxRecallExclusions?: string[];
  roles: Record<KnowledgeRootRole, KnowledgeFolderBinding>;
  migrationIssues: string[];
}
export type KnowledgeFolderStatus = "ready" | "disabled" | "unbound" | "invalid";

export function normalizeKnowledgeDirectory(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/\/$/u, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".") || Array.from(part).some(character => character.charCodeAt(0) <= 31))) {
    throw new Error("请选择合法的 Vault 相对目录。");
  }
  return normalized;
}
export function emptyKnowledgeFolderBindings(): KnowledgeFolderBindings {
  return { schemaVersion: 1, revision: 1, organization: { enabled: true, scope: "all", paths: [] }, roles: Object.fromEntries(KNOWLEDGE_ROOT_ROLES.map((role) => [role,
    { enabled: false, readPaths: [], writePath: null, allowedSubdirectories: [] }])) as unknown as KnowledgeFolderBindings["roles"], migrationIssues: [] };
}
export function normalizeKnowledgeFolderBindings(value: unknown): KnowledgeFolderBindings | null {
  if (!value || typeof value !== "object" || (value as KnowledgeFolderBindings).schemaVersion !== 1) return null;
  const input = value as KnowledgeFolderBindings;
  const result = emptyKnowledgeFolderBindings();
  result.revision = Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : 1;
  if (input.configured === true) result.configured = true;
  result.organization = knowledgeOrganizationSettings(input);
  if (Array.isArray(input.inboxRecallExclusions)) result.inboxRecallExclusions = [...new Set(input.inboxRecallExclusions.flatMap(value => {
    try { return typeof value === "string" ? [normalizeKnowledgeDirectory(value)] : []; } catch { return []; }
  }))];
  result.migrationIssues = Array.isArray(input.migrationIssues) ? input.migrationIssues.filter((item) => typeof item === "string") : [];
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const saved = input.roles?.[role];
    if (!saved) continue;
    const paths = (items: unknown): string[] => typeof items === "string" ? paths([items]) : Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === "string").map((item) => {
      try { return normalizeKnowledgeDirectory(item); } catch { return ""; }
    }).filter(Boolean))] : [];
    const readPaths = paths(saved.readPaths ?? saved.writePath);
    result.roles[role] = { enabled: saved.enabled === true, searchEnabled: saved.searchEnabled !== false, readPaths,
      writePath: paths([saved.writePath])[0] ?? null,
      allowedSubdirectories: paths(saved.allowedSubdirectories), allowedSubdirectoryRoots: paths(Array.isArray(saved.allowedSubdirectoryRoots) ? saved.allowedSubdirectoryRoots : saved.readPaths).filter(directory => readPaths.includes(directory)),
      compatibilityReadScopes: saved.compatibilityReadScopes === true, native: (role === "journal" || role === "templates") && saved.native === true };
  }
  const collectionInput = { ...result, collectionTargets: input.collectionTargets, conversationDirectoryPending: input.conversationDirectoryPending };
  result.collectionTargets = knowledgeCollectionTargets(collectionInput);
  result.conversationDirectoryPending = knowledgeConversationLocation(collectionInput).createIfMissing;
  // Collection migration still needs legacy child destinations. Materialize before retiring grants.
  for (const role of ["raw", "wiki", "projects", "inbox"] as const) {
    result.roles[role].allowedSubdirectories = [];
    delete result.roles[role].allowedSubdirectoryRoots;
    delete result.roles[role].autoOrganizePaths;
  }
  return result;
}

/** New defaults intentionally replace all legacy grants and opt-outs on first upgrade. */
export function knowledgeOrganizationSettings(config: KnowledgeFolderBindings | null | undefined): KnowledgeOrganizationSettings {
  const saved = config?.organization;
  return { enabled: typeof saved?.enabled === "boolean" ? saved.enabled : true,
    scope: saved?.scope === "selected" ? "selected" : "all",
    paths: [...new Set((Array.isArray(saved?.paths) ? saved.paths : []).flatMap(value => {
      try { return typeof value === "string" ? [normalizeKnowledgeDirectory(value)] : []; } catch { return []; }
    }))] };
}

export const DEFAULT_CONVERSATION_CONTENT_DIRECTORY = "收藏/对话";

/** Preserve the old text collector first, including its pre-migration literal location. */
export function knowledgeConversationLocation(config: KnowledgeFolderBindings | null | undefined): { directory: string; createIfMissing: boolean } {
  const text = config?.collectionTargets?.text;
  if (typeof text === "string" && text.length) return { directory: text, createIfMissing: config?.conversationDirectoryPending === true && text === DEFAULT_CONVERSATION_CONTENT_DIRECTORY };
  const raw = config?.roles.raw;
  const legacyRaw = raw?.writePath ?? (raw?.readPaths.length === 1 ? raw.readPaths[0] : null);
  if (legacyRaw) {
    const child = raw!.allowedSubdirectories.includes("articles/手动收集") && (raw!.allowedSubdirectoryRoots ?? raw!.readPaths).includes(legacyRaw) ? "/articles/手动收集" : "";
    return { directory: `${legacyRaw}${child}`, createIfMissing: false };
  }
  const output = config?.roles.outputs.writePath;
  if (output) return { directory: output, createIfMissing: false };
  return { directory: DEFAULT_CONVERSATION_CONTENT_DIRECTORY, createIfMissing: true };
}

/** Materialize the legacy effective destinations; later source edits never retarget them. */
export function knowledgeCollectionTargets(config: KnowledgeFolderBindings): Required<Pick<KnowledgeCollectionTargets, "web" | "wechat" | "files" | "images" | "text">> & Pick<KnowledgeCollectionTargets, "fileText"> {
  const raw = config.roles.raw;
  const legacy = raw.writePath ?? (raw.readPaths.length === 1 ? raw.readPaths[0] : null);
  const saved = config.collectionTargets && typeof config.collectionTargets === "object" ? config.collectionTargets : undefined;
  const child = (name: string) => legacy && raw.allowedSubdirectories?.includes(name) && (raw.allowedSubdirectoryRoots ?? raw.readPaths).includes(legacy) ? `${legacy}/${name}` : legacy;
  const target = (value: unknown): string | null => {
    try { return typeof value === "string" ? normalizeKnowledgeDirectory(value) : null; } catch { return null; }
  };
  const legacyFiles = child("attachments"), legacyTextFiles = child("articles/文件收藏");
  const result = {
    web: target(saved && "web" in saved ? saved.web : legacy),
    wechat: target(saved && "wechat" in saved ? saved.wechat : legacy),
    files: target(saved && "files" in saved ? saved.files : legacyFiles),
    text: knowledgeConversationLocation(config).directory
  };
  return { ...result, images: target(saved && "images" in saved ? saved.images : result.files), ...(saved && Object.hasOwn(saved, "fileText") ? { fileText: target(saved.fileText) }
    : (!saved || !Object.hasOwn(saved, "files")) && legacyTextFiles !== legacyFiles ? { fileText: target(legacyTextFiles) } : {}) };
}
export function knowledgeCollectionKinds(config: KnowledgeFolderBindings): KnowledgeCollectionKind[] {
  const targets = knowledgeCollectionTargets(config);
  return KNOWLEDGE_COLLECTION_KINDS.filter(kind => kind !== "fileText" || Object.hasOwn(targets, kind));
}

export function knowledgeCollectionLabel(kind: KnowledgeCollectionKind, config?: KnowledgeFolderBindings, language: "zh" | "en" = "zh"): string {
  const textOnly = kind === "fileText";
  const separateText = config && Object.hasOwn(knowledgeCollectionTargets(config), "fileText");
  const types: readonly { readonly label: string; readonly extensions: readonly string[] }[] = kind === "images" ? COLLECTION_IMAGE_TYPES : kind === "files" || textOnly
    ? COLLECTION_DOCUMENT_TYPES.filter(type => textOnly ? type.label === "Markdown" || type.label === "TXT" : !separateText || type.label !== "Markdown" && type.label !== "TXT") : [];
  const title = language === "zh" ? KNOWLEDGE_COLLECTION_LABELS[kind] : ({ web: "Web links", wechat: "WeChat articles", files: "Dragged or attached documents", images: "Dragged or attached images", text: "Conversation content", fileText: "Dragged or attached documents" })[kind];
  const formats = types.map(type => type.label).join(language === "zh" ? "、" : ", ");
  return `${title}${formats ? language === "zh" ? `（${formats}）` : ` (${formats})` : ""}`;
}

/** An explicit missing/invalid choice must never fall back to another source. */
export function knowledgeCollectionDirectory(config: KnowledgeFolderBindings | null | undefined, kind: KnowledgeCollectionKind): string | null {
  if (kind === "text") {
    const location = knowledgeConversationLocation(config).directory;
    try { return normalizeKnowledgeDirectory(location) === location ? location : null; } catch { return null; }
  }
  const raw = config?.roles.raw;
  if (!raw?.enabled) return null;
  const selected = knowledgeCollectionTargets(config!)[kind];
  if (!selected || !raw.readPaths.some(root => pathInKnowledgeDirectory(selected, root))) return null;
  try { return normalizeKnowledgeDirectory(selected) === selected ? selected : null; } catch { return null; }
}

/** Desktop selection rule only; existing shared/legacy bindings keep their scopes. */
export function knowledgeWikiFolderSelectionIssues(config: KnowledgeFolderBindings): string[] {
  const wiki = config.roles.wiki;
  if (!wiki.enabled) return [];
  if (wiki.readPaths.length !== 1) return ["知识成果：请选择一个文件夹"];
  try {
    const selected = normalizeKnowledgeDirectory(wiki.readPaths[0]);
    if (selected !== wiki.readPaths[0]) return ["知识成果：请选择一个文件夹"];
  } catch { return ["知识成果：请选择一个文件夹"]; }
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
  const migrated = preferExistingBilingualKnowledgeDefaults(result, directories);
  if (migrated.roles.raw.readPaths.length) migrated.collectionTargets = knowledgeCollectionTargets(migrated);
  return migrated;
}

/** Correct exact legacy default paths using observed folders only; custom destinations remain literal. */
export function preferExistingBilingualKnowledgeDefaults(config: KnowledgeFolderBindings, directories: readonly string[]): KnowledgeFolderBindings {
  if (config.configured) return config;
  const next = structuredClone(config);
  let changed = false;
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const binding = next.roles[role], chinese = KNOWLEDGE_ROOT_NAMES[role];
    const anotherPurpose = KNOWLEDGE_ROOT_ROLES.some(other => other !== role &&
      [...config.roles[other].readPaths, ...(config.roles[other].writePath ? [config.roles[other].writePath] : [])]
        .some(directory => pathInKnowledgeDirectory(chinese, directory) || pathInKnowledgeDirectory(directory, chinese)));
    if (!binding.enabled || binding.native || !directories.includes(chinese)
      || anotherPurpose
      || binding.writePath !== role || binding.readPaths.some(directory => directory !== role && directory !== chinese)
      || binding.autoOrganizePaths?.length || binding.allowedSubdirectories.length
      || next.migrationIssues.some(issue => issue.startsWith(`${role}：`))) continue;
    binding.readPaths = [...new Set([...binding.readPaths, chinese])];
    binding.writePath = chinese;
    binding.compatibilityReadScopes = binding.readPaths.length > 1;
    if (role === "raw" && next.collectionTargets) for (const kind of KNOWLEDGE_COLLECTION_KINDS) {
      if (next.collectionTargets[kind] === role) next.collectionTargets[kind] = chinese;
    }
    changed = true;
  }
  if (!changed) return config;
  next.revision++;
  return next;
}
export function rebaseKnowledgeFolderBindings(config: KnowledgeFolderBindings, from: string, to: string): KnowledgeFolderBindings {
  const next = structuredClone(config);
  for (const binding of Object.values(next.roles)) {
    binding.readPaths = binding.readPaths.map((item) => rebaseKnowledgePath(item, from, to));
    if (binding.allowedSubdirectoryRoots) binding.allowedSubdirectoryRoots = binding.allowedSubdirectoryRoots.map((item) => rebaseKnowledgePath(item, from, to));
    if (binding.autoOrganizePaths) binding.autoOrganizePaths = binding.autoOrganizePaths.map((item) => rebaseKnowledgePath(item, from, to));
    if (binding.writePath) binding.writePath = rebaseKnowledgePath(binding.writePath, from, to);
  }
  if (next.collectionTargets) for (const kind of KNOWLEDGE_COLLECTION_KINDS) {
    if (next.collectionTargets[kind]) next.collectionTargets[kind] = rebaseKnowledgePath(next.collectionTargets[kind], from, to);
  }
  if (next.organization) next.organization.paths = [...new Set(next.organization.paths.map(item => rebaseKnowledgePath(item, from, to)))];
  if (next.inboxRecallExclusions) next.inboxRecallExclusions = [...new Set(next.inboxRecallExclusions.map(item => rebaseKnowledgePath(item, from, to)))];
  if (knowledgeFolderBindingsSignature(next) !== knowledgeFolderBindingsSignature(config)) next.revision += 1;
  return next;
}

/** Compare effective drafts without revision numbers, order, or absent legacy defaults. */
export function knowledgeFolderBindingsSignature(config: KnowledgeFolderBindings | null | undefined): string {
  return JSON.stringify({ organization: { ...knowledgeOrganizationSettings(config), paths: knowledgeOrganizationSettings(config).paths.sort() },
    collectionTargets: config ? knowledgeCollectionTargets(config) : null,
    conversationDirectoryPending: knowledgeConversationLocation(config).createIfMissing,
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
  const policy = knowledgeOrganizationSettings(config);
  const roots = roleScope.filter(role => ["raw", "wiki", "projects", "inbox"].includes(role)).flatMap(role => {
    const binding = config.roles[role];
    return binding.enabled ? binding.readPaths : [];
  });
  return `Agent 分类整理：${policy.enabled ? "开启" : "关闭"}；已绑定根文件夹：${JSON.stringify(roots)}；范围：${policy.scope === "all" ? "全部已绑定根文件夹" : JSON.stringify(policy.paths)}。选定文件夹包含其子文件夹，实际操作仍核对路径归属。只可在同一个原始绑定根内新建分类子文件夹和移动文件；不能跨根或跨用途搬迁，不增加删除或正文修改授权，整理前仍逐次展示方案并确认。关闭时禁止分类建目录和移动；知识维护仍可写入已有知识成果位置。`;
}
