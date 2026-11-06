import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Node, Pair } from "yaml";
import type { MaintenanceSourceFields } from "./maintenance-p1-contract";
import type { MaintenanceCanonicalSourceStatus } from "./maintenance-upgrade-contract";

/** Only unsafe existing source metadata; internal/generated-patch failures stay fatal. */
export class SourceFrontmatterUnsafeError extends Error {
  constructor(message: string) { super(message); this.name = "SourceFrontmatterUnsafeError"; }
}

const MANAGED_KEYS = ["提炼状态", "摘要", "提炼到"] as const;
type ManagedKey = typeof MANAGED_KEYS[number];

interface FrontmatterSlice {
  start: number;
  close: number;
  source: string;
  newline: string;
}

/** Vault-relative note paths, without heading, alias, or traversal syntax. */
export function isMaintenanceSourceTargetPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && !/[\\[\]|#^:*?"<>]|(?=\p{ASCII})\p{Cc}/u.test(value)
    && !value.startsWith("/") && !value.startsWith("~/")
    && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function frontmatterSlice(markdown: string): FrontmatterSlice | null {
  const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
  const opening = /^---[ \t]*(\r\n|\n|\r|$)/u.exec(markdown.slice(bom));
  if (!opening) return null;
  if (!opening[1]) throw new SourceFrontmatterUnsafeError("Source frontmatter is not closed.");
  const start = bom + opening[0].length;
  let cursor = start;
  while (cursor < markdown.length) {
    const ending = /\r\n|\n|\r/gu;
    ending.lastIndex = cursor;
    const match = ending.exec(markdown);
    const end = match?.index ?? markdown.length;
    const line = markdown.slice(cursor, end);
    if (/^(?:---|\.\.\.)[ \t]*$/u.test(line)) {
      return { start, close: cursor, source: markdown.slice(start, cursor), newline: opening[1] };
    }
    if (!match) break;
    cursor = end + match[0].length;
  }
  throw new SourceFrontmatterUnsafeError("Source frontmatter is not closed.");
}

function parseSourceFrontmatter(markdown: string) {
  const slice = frontmatterSlice(markdown);
  if (!slice) return null;
  const document = parseDocument(slice.source, { keepSourceTokens: true, uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length
    || (document.contents && !isMap(document.contents))) {
    throw new SourceFrontmatterUnsafeError("Source frontmatter must be an unambiguous YAML mapping.");
  }
  return { ...slice, document };
}

/** Presence is separate from value: null/empty/invalid state must not revive legacy success. */
export function readMaintenanceSourceStateProperty(markdown: string): { present: boolean; value?: unknown; error?: string } {
  try {
    const parsed = parseSourceFrontmatter(markdown);
    if (!parsed || !isMap(parsed.document.contents)) return { present: false };
    const pair = parsed.document.contents.items.find((item) => isScalar(item.key) && item.key.value === "提炼状态");
    if (!pair) return { present: false };
    if (!isScalar(pair.key) || pair.key.anchor || pair.key.tag) return { present: true, error: "提炼状态属性带有锚点或标签，保留原值" };
    const value = pair.value;
    return isScalar(value) && !value.anchor && !value.tag ? { present: true, value: value.value } : { present: true, error: "提炼状态不是明确的标量，保留待处理" };
  } catch {
    return { present: true, error: "文件头无法明确解析，保留待处理" };
  }
}

/** Reading malformed or ambiguous metadata never marks a source as processed. */
export function readMaintenanceSourceStatus(markdown: string): unknown {
  return readMaintenanceSourceStateProperty(markdown).value;
}

/** Read one property without treating an empty or unsupported value as absence. */
export function readMaintenanceFrontmatterProperty(markdown: string, key: string): { present: boolean; value?: unknown; error?: string } {
  try {
    const parsed = parseSourceFrontmatter(markdown);
    if (!parsed || !isMap(parsed.document.contents)) return { present: false };
    const pair = parsed.document.contents.items.find(item => isScalar(item.key) && item.key.value === key);
    if (!pair) return { present: false };
    if (!isScalar(pair.key) || pair.key.anchor || pair.key.tag) return { present: true, error: `${key}属性不能安全读取，保留原值` };
    const value = pair.value;
    if (value === null) return { present: true, value: null };
    if (isScalar(value) && !value.anchor && !value.tag) return { present: true, value: value.value };
    if (isSeq(value) && !value.anchor && !value.tag && value.items.every(item => isScalar(item) && !item.anchor && !item.tag)) {
      return { present: true, value: value.items.map(item => isScalar(item) ? item.value : null) };
    }
    return { present: true, error: `${key}属性不是明确的普通值，保留原值` };
  } catch {
    return { present: true, error: "文件头无法明确解析，保留原文件" };
  }
}

/** Insert absent keys only. Original YAML, comments, delimiters and body are exact slices. */
export function appendMissingMaintenanceFrontmatterProperties(markdown: string, fields: Readonly<Record<string, string | boolean | number | readonly string[]>>): string {
  const parsed = parseSourceFrontmatter(markdown);
  const pairs = Object.entries(fields);
  if (!pairs.length) return markdown;
  if (parsed && isMap(parsed.document.contents) && (parsed.document.contents.flow
    || parsed.document.contents.items.some(pair => !isScalar(pair.key) || pair.key.anchor || pair.key.tag))) {
    throw new SourceFrontmatterUnsafeError("文件头不能安全追加属性，保留原文件。");
  }
  const missing = pairs.filter(([key]) => !parsed || !isMap(parsed.document.contents)
    || !parsed.document.contents.items.some(pair => isScalar(pair.key) && pair.key.value === key));
  if (!missing.length) return markdown;
  const newline = parsed?.newline ?? /\r\n|\n|\r/u.exec(markdown)?.[0] ?? "\n";
  const lines = missing.map(([key, value]) => `${/^[\p{L}_][\p{L}\p{N}_ -]*$/u.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)}${newline}`).join("");
  if (parsed) return markdown.slice(0, parsed.close) + lines + markdown.slice(parsed.close);
  const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
  return markdown.slice(0, bom) + `---${newline}${lines}---${newline}` + markdown.slice(bom);
}

/** P4 upgrade never changes a property that appeared after its preview. */
export function patchMaintenanceUpgradeSourceFrontmatter(markdown: string, fields: {
  status?: MaintenanceCanonicalSourceStatus;
  targetPaths?: readonly string[];
}): string {
  if (!fields || Object.keys(fields).some(key => key !== "status" && key !== "targetPaths")
    || (fields.status !== undefined && !["已提炼", "未提炼", "待重新提炼", "提炼失败", "待校准"].includes(fields.status))
    || (fields.targetPaths !== undefined && (!Array.isArray(fields.targetPaths) || fields.targetPaths.some(value => !isMaintenanceSourceTargetPath(value))))) {
    throw new Error("Invalid upgrade source fields.");
  }
  const additions: Record<string, string | readonly string[]> = {};
  if (fields.status !== undefined) additions.提炼状态 = fields.status;
  if (fields.targetPaths !== undefined) additions.提炼到 = [...new Set(fields.targetPaths)].map(value => `[[${value}]]`);
  return appendMissingMaintenanceFrontmatterProperties(markdown, additions);
}

function managedPairValue(pair: Pair, key: ManagedKey): string | null | string[] {
  const node = pair.value;
  if (isScalar(pair.key) && (pair.key.anchor || pair.key.tag)) {
    throw new SourceFrontmatterUnsafeError(`Managed source key ${key} is anchored or tagged.`);
  }
  if (isScalar(node) && !node.anchor && !node.tag && node.value === null) return null;
  if (key !== "提炼到" && isScalar(node) && !node.anchor && !node.tag && typeof node.value === "string") {
    return node.value;
  }
  if (key === "提炼到" && isSeq(node) && !node.anchor && !node.tag) {
    return node.items.map((item) => {
      if (!isScalar(item) || item.anchor || item.tag || typeof item.value !== "string"
        || (item.type !== "QUOTE_DOUBLE" && item.type !== "QUOTE_SINGLE")) {
        throw new SourceFrontmatterUnsafeError("Source targets must be quoted wiki links in a YAML list.");
      }
      const match = /^\[\[(.+)\]\]$/u.exec(item.value);
      if (!match || !isMaintenanceSourceTargetPath(match[1])) {
        throw new SourceFrontmatterUnsafeError("Source target is not a safe wiki link.");
      }
      return match[1];
    });
  }
  throw new SourceFrontmatterUnsafeError(`Managed source field ${key} has an unsupported value.`);
}

function sameValue(left: string | null | string[], right: string | string[]): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

function commentsWithin(token: unknown, start: number, end: number): { offset: number; source: string }[] {
  const comments: { offset: number; source: string }[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (record.type === "comment" && typeof record.offset === "number" && typeof record.source === "string"
      && record.offset >= start && record.offset < end) {
      comments.push({ offset: record.offset, source: record.source });
    } else Object.values(record).forEach(visit);
  }
  visit(token);
  return comments.sort((a, b) => a.offset - b.offset);
}

function replacementValue(source: string, node: Node, encoded: string, newline: string): string {
  if (!node.range) throw new SourceFrontmatterUnsafeError("Managed source field has no safe source range.");
  const [start, end] = node.range;
  const raw = source.slice(start, end);
  const lastNewline = /(?:\r\n|\n|\r)$/u.exec(raw)?.[0] ?? "";
  const comments = commentsWithin(node.srcToken, start, end);
  let replacement = encoded;
  if (isScalar(node) && (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED")) {
    // A block header's comment belongs to the property, not to its old text.
    if (comments.length > 1) throw new SourceFrontmatterUnsafeError("Managed block scalar has ambiguous comments.");
    if (comments.length) {
      const header = node.srcToken;
      const headerEnd = header?.type === "block-scalar" ? header.props[0] : undefined;
      if (!headerEnd || headerEnd.type !== "block-scalar-header") throw new SourceFrontmatterUnsafeError("Managed block header has no safe range.");
      const spacingStart = headerEnd.offset + headerEnd.source.length;
      replacement += source.slice(spacingStart, comments[0].offset) + comments[0].source;
    }
  } else if (comments.length) {
    // Keep comments inside a replaced list as standalone comments in that field.
    const lineStart = Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1;
    const before = source.slice(lineStart, start);
    const indent = /^[ \t]*$/u.test(before) ? before : "";
    replacement += newline + comments.map((comment) => indent + comment.source).join(newline);
  }
  replacement += lastNewline;
  if (!lastNewline && source[end] === "#") replacement += " ";
  if (source[start - 1] === ":") replacement = " " + replacement;
  return replacement;
}

/** Patch only the three source properties; all other bytes stay in their slices. */
export function patchMaintenanceSourceFrontmatter(markdown: string, fields: MaintenanceSourceFields): string {
  if (!fields || typeof fields !== "object" || Object.keys(fields).sort().join("\0") !== "status\0summary\0targetPaths" || (fields.status !== "未提炼" && fields.status !== "已提炼") || typeof fields.summary !== "string"
    || !Array.isArray(fields.targetPaths) || fields.targetPaths.some((value) => !isMaintenanceSourceTargetPath(value))) {
    throw new Error("Invalid managed source fields.");
  }
  const targetPaths = [...new Set(fields.targetPaths)];
  const desired: Record<ManagedKey, string | string[]> = {
    提炼状态: fields.status,
    摘要: fields.summary,
    提炼到: targetPaths
  };
  const encoded: Record<ManagedKey, string> = {
    提炼状态: JSON.stringify(fields.status),
    摘要: JSON.stringify(fields.summary),
    提炼到: `[${targetPaths.map((value) => JSON.stringify(`[[${value}]]`)).join(", ")}]`
  };
  const parsed = parseSourceFrontmatter(markdown);
  if (!parsed) {
    const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
    const newline = /\r\n|\n|\r/u.exec(markdown)?.[0] ?? "\n";
    return markdown.slice(0, bom) + `---${newline}`
      + MANAGED_KEYS.map((key) => `${key}: ${encoded[key]}${newline}`).join("")
      + `---${newline}` + markdown.slice(bom);
  }
  const { source, document, newline } = parsed;
  if (isMap(document.contents) && document.contents.flow) {
    throw new SourceFrontmatterUnsafeError("Flow-style source frontmatter cannot be patched safely.");
  }
  const edits: { start: number; end: number; content: string }[] = [];
  const missing = new Set<ManagedKey>(MANAGED_KEYS);
  if (isMap(document.contents)) {
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new SourceFrontmatterUnsafeError("Source frontmatter has a complex key.");
      }
      const key = pair.key.value as ManagedKey;
      if (!missing.has(key)) continue;
      missing.delete(key);
      const current = managedPairValue(pair, key);
      const node = pair.value;
      const keyStart = pair.key.range?.[0];
      const lineStart = keyStart === undefined ? -1 : Math.max(source.lastIndexOf("\n", keyStart - 1), source.lastIndexOf("\r", keyStart - 1)) + 1;
      if (keyStart === undefined || keyStart !== lineStart || !node || !node.range) {
        throw new SourceFrontmatterUnsafeError("Managed source field has no unambiguous top-level range.");
      }
      if (!sameValue(current, desired[key])) {
        edits.push({ start: node.range[0], end: node.range[1], content: replacementValue(source, node, encoded[key], newline) });
      }
    }
  }
  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.content + updated.slice(edit.end);
  }
  if (missing.size) {
    if (updated && !/[\r\n]$/u.test(updated)) updated += newline;
    updated += [...missing].map((key) => `${key}: ${encoded[key]}${newline}`).join("");
  }
  const result = markdown.slice(0, parsed.start) + updated + markdown.slice(parsed.close);
  let verified: ReturnType<typeof parseSourceFrontmatter>;
  try { verified = parseSourceFrontmatter(result); }
  catch { throw new Error("Source frontmatter patch could not be verified."); }
  if (!verified || !isMap(verified.document.contents)) throw new Error("Source frontmatter patch could not be verified.");
  for (const key of MANAGED_KEYS) {
    const pair = verified.document.contents.items.find((item) => isScalar(item.key) && item.key.value === key);
    let matches = false;
    try { matches = !!pair && sameValue(managedPairValue(pair, key), desired[key]); }
    catch { throw new Error("Source frontmatter patch could not be verified."); }
    if (!matches) {
      throw new Error("Source frontmatter patch did not preserve the requested values.");
    }
  }
  return result;
}


export type KnowledgePropertyValue = string | boolean | number | readonly string[];

/** Explicit, confirmed fields only. null removes a field; incompatible values are never coerced. */
export function patchKnowledgeProperties(
  markdown: string,
  fields: Readonly<Record<string, KnowledgePropertyValue | null>>,
  convertLists: readonly string[] = [],
): string {
  const parsed = parseSourceFrontmatter(markdown);
  const additions: Record<string, KnowledgePropertyValue> = {};
  const edits: { start: number; end: number; content: string }[] = [];
  const mapping = parsed?.document.contents;
  if (mapping && (!isMap(mapping) || mapping.flow || mapping.items.some(pair => !isScalar(pair.key) || pair.key.anchor || pair.key.tag))) {
    throw new SourceFrontmatterUnsafeError("属性不是明确的普通映射，保留原文件。");
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!key.trim() || /[\r\n]/u.test(key) || key !== key.trim()) throw new Error("属性名无效。");
    if (value !== null && typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value)) && !(Array.isArray(value) && value.every(item => typeof item === "string"))) throw new Error("属性值必须是文本、数字、布尔值或文本列表。");
    const pair = isMap(mapping) ? mapping.items.find(pair => isScalar(pair.key) && pair.key.value === key) : undefined;
    if (!pair) { if (value !== null) additions[key] = value; continue; }
    const current = readMaintenanceFrontmatterProperty(markdown, key);
    if (current.error || current.value === null || current.value === undefined || !["string", "boolean", "number"].includes(typeof current.value) && !Array.isArray(current.value)
      || Array.isArray(current.value) && !current.value.every(item => typeof item === "string")
      || value !== null && (Array.isArray(value) !== Array.isArray(current.value) || typeof value !== typeof current.value)
        && !(convertLists.includes(key) && typeof current.value === "string" && Array.isArray(value))) {
      throw new SourceFrontmatterUnsafeError(`${key}属性类型不兼容，保留原值。`);
    }
    if (JSON.stringify(current.value) === JSON.stringify(value)) continue;
    const node = pair.value;
    if (!parsed || !node?.range || !isScalar(pair.key) || !pair.key.range) throw new SourceFrontmatterUnsafeError("属性缺少明确范围。");
    const keyStart = pair.key.range[0];
    const lineStart = Math.max(parsed.source.lastIndexOf("\n", keyStart - 1), parsed.source.lastIndexOf("\r", keyStart - 1)) + 1;
    if (keyStart !== lineStart) throw new SourceFrontmatterUnsafeError("属性不是独立的顶层字段。");
    if (value === null) {
      // Remove only the selected pair, leaving comments outside its CST range intact.
      let end = node.range[2];
      if (!/[\r\n]$/u.test(parsed.source.slice(lineStart, end))) {
        const eol = /^(?:\r\n|\n|\r)/u.exec(parsed.source.slice(end));
        end += eol?.[0].length ?? 0;
      }
      edits.push({ start: lineStart, end, content: "" });
    } else edits.push({ start: node.range[0], end: node.range[1], content: replacementValue(parsed.source, node, JSON.stringify(value), parsed.newline) });
  }
  let result = markdown;
  if (parsed) {
    let source = parsed.source;
    for (const edit of edits.sort((a,b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.content + source.slice(edit.end);
    result = markdown.slice(0, parsed.start) + source + markdown.slice(parsed.close);
  }
  result = appendMissingMaintenanceFrontmatterProperties(result, additions);
  for (const [key, value] of Object.entries(fields)) {
    const actual = readMaintenanceFrontmatterProperty(result, key);
    if (value === null ? actual.present : actual.error || !actual.present || JSON.stringify(actual.value) !== JSON.stringify(value)) throw new Error("属性更新回读校验失败。");
  }
  return result;
}
