import type { KnowledgeDocumentOutline, KnowledgeOutlineEntry } from "./contracts";

export interface MarkdownHeading { heading: string; line: number; level: number }

export const KNOWLEDGE_OUTLINE_LIMITS = Object.freeze({
  longDocumentLines: 120,
  longDocumentCharacters: 8000,
  documents: 3,
  entriesPerDocument: 12,
  totalEntries: 24,
  totalCharacters: 2400
});

/** Structural headings only; property values and fenced code are never navigation. */
export function parseMarkdownHeadings(lines: readonly string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { character: string; length: number } | undefined;
  let frontmatter = lines[0]?.trim() === "---";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line)) frontmatter = false;
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; continue; }
    const atx = line.match(/^ {0,3}(#{1,6})(?:[\t ]+(.+?)|[\t ]*)$/u);
    if (atx) {
      headings.push({ heading: (atx[2] ?? "").replace(/[\t ]+#+[\t ]*$/u, "").trim(), line: index + 1, level: atx[1].length });
      continue;
    }
    if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/u.test(line) && lines[index - 1].trim()
      && !/^\s*(?:[-*+]>?|>|#{1,6}\s|`{3,}|~{3,})/u.test(lines[index - 1])
      && headings.at(-1)?.line !== index) {
      headings.push({ heading: lines[index - 1].trim(), line: index, level: line.trim()[0] === "=" ? 1 : 2 });
    }
  }
  return headings;
}

function outlineEntries(headings: readonly MarkdownHeading[], totalLines: number): KnowledgeOutlineEntry[] {
  const entries = headings.map(heading => ({ heading: heading.heading, level: heading.level, lineStart: heading.line, lineEnd: totalLines }));
  const parents: typeof entries = [];
  for (const entry of entries) {
    while (parents.length && parents.at(-1)!.level >= entry.level) {
      parents.pop()!.lineEnd = entry.lineStart - 1;
    }
    parents.push(entry);
  }
  return entries;
}

/** Exact extra JSON characters when adding the field to an existing result object. */
export function knowledgeOutlineCharacters(outline: Readonly<KnowledgeDocumentOutline>): number {
  return JSON.stringify({ outline }).length - 1;
}

export function limitKnowledgeOutline(outline: Readonly<KnowledgeDocumentOutline>, maxEntries: number, maxCharacters: number): Readonly<KnowledgeDocumentOutline> | undefined {
  const entries = outline.entries.slice(0, Math.max(0, Math.min(KNOWLEDGE_OUTLINE_LIMITS.entriesPerDocument, maxEntries)));
  while (entries.length) {
    const result: KnowledgeDocumentOutline = { ...outline, entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))), truncated: entries.length < outline.totalHeadings };
    if (knowledgeOutlineCharacters(result) <= maxCharacters) return Object.freeze(result);
    entries.pop();
  }
  return undefined;
}

export function createKnowledgeDocumentOutline(headings: readonly MarkdownHeading[], totalLines: number, characters: number, contentRevision: string): Readonly<KnowledgeDocumentOutline> | undefined {
  if (!headings.length || (totalLines < KNOWLEDGE_OUTLINE_LIMITS.longDocumentLines && characters < KNOWLEDGE_OUTLINE_LIMITS.longDocumentCharacters)) return undefined;
  return limitKnowledgeOutline({ schemaVersion: 1, readStatus: "unread", contentRevision,
    entries: outlineEntries(headings, totalLines), totalHeadings: headings.length, truncated: false },
  KNOWLEDGE_OUTLINE_LIMITS.entriesPerDocument, KNOWLEDGE_OUTLINE_LIMITS.totalCharacters);
}

/** Drop only optional navigation until the complete serialized payload fits. */
export function fitKnowledgeOutlines<T extends { readonly outline?: Readonly<KnowledgeDocumentOutline> }>(values: readonly T[], fits: (values: readonly T[]) => boolean): T[] {
  const result = [...values];
  for (let index = result.length - 1; index >= 0 && !fits(result); index--) {
    while (result[index].outline && !fits(result)) {
      const outline = result[index].outline!;
      const smaller = limitKnowledgeOutline(outline, outline.entries.length - 1, KNOWLEDGE_OUTLINE_LIMITS.totalCharacters);
      if (smaller) result[index] = Object.freeze({ ...result[index], outline: smaller });
      else { const { outline: _outline, ...body } = result[index]; result[index] = Object.freeze(body) as T; }
    }
  }
  return result;
}

/** Strict transport/storage validation; the source revision remains the authority. */
export function normalizeKnowledgeDocumentOutline(value: unknown, contentRevision: string, totalLines: number): Readonly<KnowledgeDocumentOutline> {
  const invalid = () => { throw new TypeError("knowledge_outline_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const outline = value as Record<string, unknown>;
  const keys = ["schemaVersion", "readStatus", "contentRevision", "entries", "totalHeadings", "truncated"];
  if (Object.keys(outline).length !== keys.length || keys.some(key => !Object.hasOwn(outline, key))
    || outline.schemaVersion !== 1 || outline.readStatus !== "unread" || outline.contentRevision !== contentRevision
    || !Number.isSafeInteger(totalLines) || totalLines < 1 || !Array.isArray(outline.entries)
    || !outline.entries.length || outline.entries.length > KNOWLEDGE_OUTLINE_LIMITS.entriesPerDocument
    || !Number.isSafeInteger(outline.totalHeadings) || (outline.totalHeadings as number) < outline.entries.length
    || outline.truncated !== ((outline.totalHeadings as number) > outline.entries.length)) return invalid();
  let previousLine = 0;
  const entries = Array.from(outline.entries, value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).length !== 4 || ["heading", "level", "lineStart", "lineEnd"].some(key => !Object.hasOwn(entry, key))
      || typeof entry.heading !== "string" || /[\r\n]/u.test(entry.heading) || !Number.isSafeInteger(entry.level) || (entry.level as number) < 1 || (entry.level as number) > 6
      || !Number.isSafeInteger(entry.lineStart) || !Number.isSafeInteger(entry.lineEnd) || (entry.lineStart as number) <= previousLine
      || (entry.lineEnd as number) < (entry.lineStart as number) || (entry.lineEnd as number) > totalLines) return invalid();
    previousLine = entry.lineStart as number;
    return Object.freeze({ heading: entry.heading, level: entry.level as number, lineStart: entry.lineStart as number, lineEnd: entry.lineEnd as number });
  });
  const result: KnowledgeDocumentOutline = { schemaVersion: 1, readStatus: "unread", contentRevision, entries: Object.freeze(entries), totalHeadings: outline.totalHeadings as number, truncated: outline.truncated as boolean };
  if (knowledgeOutlineCharacters(result) > KNOWLEDGE_OUTLINE_LIMITS.totalCharacters) return invalid();
  return Object.freeze(result);
}

export function verifyKnowledgeOutlineLines(outline: Readonly<KnowledgeDocumentOutline>, lines: readonly string[]): boolean {
  const entries = outlineEntries(parseMarkdownHeadings(lines), lines.length);
  return entries.length === outline.totalHeadings && outline.entries.every(entry => entries.some(actual =>
    actual.heading === entry.heading && actual.level === entry.level && actual.lineStart === entry.lineStart && actual.lineEnd === entry.lineEnd));
}
