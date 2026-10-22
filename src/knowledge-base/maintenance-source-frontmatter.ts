import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Node, Pair } from "yaml";
import type { MaintenanceSourceFields } from "./maintenance-p1-contract";

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
    && !/[\u0000-\u001f\u007f\\[\]|#^:*?"<>]/u.test(value)
    && !value.startsWith("/") && !value.startsWith("~/")
    && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function frontmatterSlice(markdown: string): FrontmatterSlice | null {
  const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
  const opening = /^---[ \t]*(\r\n|\n|\r|$)/u.exec(markdown.slice(bom));
  if (!opening) return null;
  if (!opening[1]) throw new Error("Source frontmatter is not closed.");
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
  throw new Error("Source frontmatter is not closed.");
}

function parseSourceFrontmatter(markdown: string) {
  const slice = frontmatterSlice(markdown);
  if (!slice) return null;
  const document = parseDocument(slice.source, { keepSourceTokens: true, uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length
    || (document.contents && !isMap(document.contents))) {
    throw new Error("Source frontmatter must be an unambiguous YAML mapping.");
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

function managedPairValue(pair: Pair, key: ManagedKey): string | null | string[] {
  const node = pair.value;
  if (isScalar(pair.key) && (pair.key.anchor || pair.key.tag)) {
    throw new Error(`Managed source key ${key} is anchored or tagged.`);
  }
  if (isScalar(node) && !node.anchor && !node.tag && node.value === null) return null;
  if (key !== "提炼到" && isScalar(node) && !node.anchor && !node.tag && typeof node.value === "string") {
    return node.value;
  }
  if (key === "提炼到" && isSeq(node) && !node.anchor && !node.tag) {
    return node.items.map((item) => {
      if (!isScalar(item) || item.anchor || item.tag || typeof item.value !== "string"
        || (item.type !== "QUOTE_DOUBLE" && item.type !== "QUOTE_SINGLE")) {
        throw new Error("Source targets must be quoted wiki links in a YAML list.");
      }
      const match = /^\[\[(.+)\]\]$/u.exec(item.value);
      if (!match || !isMaintenanceSourceTargetPath(match[1])) {
        throw new Error("Source target is not a safe wiki link.");
      }
      return match[1];
    });
  }
  throw new Error(`Managed source field ${key} has an unsupported value.`);
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
  if (!node.range) throw new Error("Managed source field has no safe source range.");
  const [start, end] = node.range;
  const raw = source.slice(start, end);
  const lastNewline = /(?:\r\n|\n|\r)$/u.exec(raw)?.[0] ?? "";
  const comments = commentsWithin(node.srcToken, start, end);
  let replacement = encoded;
  if (isScalar(node) && (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED")) {
    // A block header's comment belongs to the property, not to its old text.
    if (comments.length > 1) throw new Error("Managed block scalar has ambiguous comments.");
    if (comments.length) {
      const header = node.srcToken;
      const headerEnd = header?.type === "block-scalar" ? header.props[0] : undefined;
      if (!headerEnd || headerEnd.type !== "block-scalar-header") throw new Error("Managed block header has no safe range.");
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
    throw new Error("Flow-style source frontmatter cannot be patched safely.");
  }
  const edits: { start: number; end: number; content: string }[] = [];
  const missing = new Set<ManagedKey>(MANAGED_KEYS);
  if (isMap(document.contents)) {
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new Error("Source frontmatter has a complex key.");
      }
      const key = pair.key.value as ManagedKey;
      if (!missing.has(key)) continue;
      missing.delete(key);
      const current = managedPairValue(pair, key);
      const node = pair.value;
      const keyStart = pair.key.range?.[0];
      const lineStart = keyStart === undefined ? -1 : Math.max(source.lastIndexOf("\n", keyStart - 1), source.lastIndexOf("\r", keyStart - 1)) + 1;
      if (keyStart === undefined || keyStart !== lineStart || !node || !node.range) {
        throw new Error("Managed source field has no unambiguous top-level range.");
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
  const verified = parseSourceFrontmatter(result);
  if (!verified || !isMap(verified.document.contents)) throw new Error("Source frontmatter patch could not be verified.");
  for (const key of MANAGED_KEYS) {
    const pair = verified.document.contents.items.find((item) => isScalar(item.key) && item.key.value === key);
    if (!pair || !sameValue(managedPairValue(pair, key), desired[key])) {
      throw new Error("Source frontmatter patch did not preserve the requested values.");
    }
  }
  return result;
}
