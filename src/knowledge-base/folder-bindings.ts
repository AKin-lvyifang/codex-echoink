import { KNOWLEDGE_ROOT_ROLES, knowledgeRootRole, rebaseKnowledgePath, type KnowledgeRootRole } from "./root-paths-core";

export interface KnowledgeFolderBinding {
  enabled: boolean;
  readPaths: string[];
  writePath: string | null;
  /** Only these relative child directories were explicitly approved for creation. */
  allowedSubdirectories: string[];
  compatibilityReadScopes?: boolean;
  native?: boolean;
}
export interface KnowledgeFolderBindings {
  schemaVersion: 1;
  revision: number;
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
    { enabled: false, readPaths: [], writePath: null, allowedSubdirectories: [] }])) as unknown as KnowledgeFolderBindings["roles"], migrationIssues: [] };
}
export function normalizeKnowledgeFolderBindings(value: unknown): KnowledgeFolderBindings | null {
  if (!value || typeof value !== "object" || (value as KnowledgeFolderBindings).schemaVersion !== 1) return null;
  const input = value as KnowledgeFolderBindings;
  const result = emptyKnowledgeFolderBindings();
  result.revision = Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : 1;
  result.migrationIssues = Array.isArray(input.migrationIssues) ? input.migrationIssues.filter((item) => typeof item === "string") : [];
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const saved = input.roles?.[role];
    if (!saved) continue;
    const paths = (items: unknown): string[] => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === "string").map((item) => {
      try { return normalizeKnowledgeDirectory(item); } catch { return ""; }
    }).filter(Boolean))] : [];
    result.roles[role] = { enabled: saved.enabled === true, readPaths: paths(saved.readPaths),
      writePath: paths([saved.writePath])[0] ?? null, allowedSubdirectories: paths(saved.allowedSubdirectories), compatibilityReadScopes: saved.compatibilityReadScopes === true, native: (role === "journal" || role === "templates") && saved.native === true };
  }
  return result;
}
export function pathInKnowledgeDirectory(value: string, directory: string): boolean {
  return value === directory || value.startsWith(`${directory}/`);
}
export function classifyKnowledgePath(config: KnowledgeFolderBindings, value: string): KnowledgeRootRole | null {
  const normalized = value.replace(/\\/gu, "/");
  const matches = KNOWLEDGE_ROOT_ROLES.flatMap((role) => config.roles[role].enabled
    ? config.roles[role].readPaths.filter((directory) => pathInKnowledgeDirectory(normalized, directory)).map((directory) => ({ role, directory })) : []);
  matches.sort((a, b) => b.directory.length - a.directory.length || (a.role === "raw" ? -1 : b.role === "raw" ? 1 : a.role.localeCompare(b.role)));
  return matches[0]?.role ?? null;
}
export function knowledgeFolderIssues(config: KnowledgeFolderBindings): string[] {
  const issues: string[] = [];
  for (const role of KNOWLEDGE_ROOT_ROLES) {
    const binding = config.roles[role];
    if (!binding.enabled) continue;
    if (binding.native && (role === "journal" || role === "templates")) continue;
    if (!binding.readPaths.length) issues.push(`${role}：尚未选择位置`);
    if (role !== "raw" && binding.readPaths.length > 1 && !binding.compatibilityReadScopes) issues.push(`${role}：只能选择一个位置`);
    if (binding.writePath && !binding.readPaths.includes(binding.writePath)) issues.push(`${role}：默认保存位置不在读取范围中`);
    if (role === "raw" && binding.readPaths.length > 1 && !binding.writePath) issues.push("资料来源：请选择默认保存位置");
  }
  for (const role of ["wiki", "projects"] as const) if (config.roles[role].enabled && config.roles.raw.enabled) {
    for (const directory of config.roles[role].readPaths) if (config.roles.raw.readPaths.includes(directory)) issues.push(`资料来源与${role}不能使用同一路径：${directory}`);
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
    if (binding.writePath) binding.writePath = rebaseKnowledgePath(binding.writePath, from, to);
  }
  if (JSON.stringify(next.roles) !== JSON.stringify(config.roles)) next.revision += 1;
  return next;
}
