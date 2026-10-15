import type { KnowledgeFolderBindings } from "./folder-bindings";
import { classifyKnowledgePath } from "./folder-bindings";
/** Stable roles are internal IDs; these names are suggestions, never implicit creation permission. */
export const KNOWLEDGE_ROOT_NAMES = Object.freeze({
  raw: "原始资料（raw）", wiki: "知识库（wiki）", projects: "项目（projects）",
  outputs: "输出（outputs）", inbox: "收件箱（inbox）", journal: "日记（journal）",
  work: "工作（work）", archive: "归档（archive）", templates: "模板（templates）", assets: "附件（assets）"
});
export type KnowledgeRootRole = keyof typeof KNOWLEDGE_ROOT_NAMES;
export const KNOWLEDGE_ROOT_ROLES = Object.freeze(Object.keys(KNOWLEDGE_ROOT_NAMES) as KnowledgeRootRole[]);

export function knowledgeRootRole(relativePath: string, bindings?: KnowledgeFolderBindings | null): KnowledgeRootRole | null {
  if (bindings) return classifyKnowledgePath(bindings, relativePath);
  const root = relativePath.replace(/\\/gu, "/").split("/")[0] ?? "";
  const id = (/^[^（）]+（([a-z]+)）$/u.exec(root)?.[1] ?? root).toLowerCase();
  return Object.hasOwn(KNOWLEDGE_ROOT_NAMES, id) ? id as KnowledgeRootRole : null;
}

/** For policy comparisons only. Never use this role path for filesystem IO. */
export function knowledgeRolePath(relativePath: string, bindings?: KnowledgeFolderBindings | null): string {
  relativePath = relativePath.replace(/\\/gu, "/");
  const role = knowledgeRootRole(relativePath, bindings);
  if (bindings) {
    if (!role) return `unbound:${relativePath}`;
    const directory = bindings.roles[role].readPaths.filter((value) => relativePath === value || relativePath.startsWith(`${value}/`)).sort((a, b) => b.length - a.length)[0];
    return role + relativePath.slice(directory.length);
  }
  const slash = relativePath.indexOf("/");
  return role ? role + (slash < 0 ? "" : relativePath.slice(slash)) : relativePath;
}

export function resolveKnowledgePathFromRoots(relativePath: string, roots: readonly string[], preferBilingual = true): string {
  const first = relativePath.split("/")[0];
  if (roots.includes(first)) return relativePath; // Explicit existing root always wins, including conflicts.
  const role = knowledgeRootRole(relativePath);
  if (!role) return relativePath;
  const matches = roots.filter((root) => knowledgeRootRole(root) === role);
  const root = matches.includes(role) ? role : matches.includes(KNOWLEDGE_ROOT_NAMES[role])
    ? KNOWLEDGE_ROOT_NAMES[role] : matches.sort()[0] ?? (preferBilingual ? KNOWLEDGE_ROOT_NAMES[role] : first);
  return root + relativePath.slice(first.length);
}

export function rebaseKnowledgePath(value: string, from: string, to: string): string {
  return value === from ? to : value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;
}

/** Existing path fields and map keys only; does not edit note bodies or free text. */
export function rebaseKnowledgePathRecords<T>(value: T, from: string, to: string): T {
  const pathFields = new Set(["path", "rawPath", "sourcePath", "targetPath", "relativePath", "vaultRelativePath", "guidePath", "reportPath", "lastReportPath", "trackerPath", "journalDirectory", "evidencePaths", "evidence", "sourcePaths", "pendingSourcePaths", "analyzedSourcePaths", "extractionQueue", "rawDirectory", "imageDirectory", "imagePaths", "englishDirectory", "expressionDirectory", "legacyEnglishDirectories", "legacyExpressionDirectories", "readPaths", "writePath"]);
  const walk = (item: unknown, field: string): unknown => {
    if (typeof item === "string") return pathFields.has(field) ? rebaseKnowledgePath(item, from, to) : item;
    if (Array.isArray(item)) return item.map((child) => walk(child, field));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) =>
      [key.includes("/") ? rebaseKnowledgePath(key, from, to) : key, walk(child, key)]));
    return item;
  };
  return walk(value, "") as T;
}
