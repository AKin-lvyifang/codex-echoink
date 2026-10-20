import type { BodySearchDocument, KnowledgeAnchorLocation, KnowledgeDocumentOutline, KnowledgeLinkCue, KnowledgeOutlineEntry } from "./contracts";
import type { KnowledgeLink, KnowledgeRelation, KnowledgeRelationPage, KnowledgeRelationTarget } from "../knowledge-relations";

export interface MarkdownHeading { heading: string; line: number; level: number }

export const KNOWLEDGE_BODY_FRAGMENT_LIMITS = Object.freeze({ lines: 24, characters: 2400 });
export const KNOWLEDGE_LINK_LIMITS = Object.freeze({ targetsPerSource: 16, candidates: 20, boost: 0.03, cues: 3, supporters: 3, cueBytes: 2400 });

function hasNavigationControlCharacters(value: string, allowLineWhitespace = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code <= 31 && !(allowLineWhitespace && (code === 9 || code === 10 || code === 13))) || code === 127) return true;
  }
  return false;
}

export const KNOWLEDGE_OUTLINE_LIMITS = Object.freeze({
  longDocumentLines: 120,
  longDocumentCharacters: 8000,
  sectionedDocumentHeadings: 3,
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

export function createKnowledgeDocumentOutline(headings: readonly MarkdownHeading[], lines: readonly string[], contentRevision: string): Readonly<KnowledgeDocumentOutline> | undefined {
  if (!headings.length) return undefined;
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    bodyStart = 1;
    while (bodyStart < lines.length && !/^(?:---|\.\.\.)\s*$/u.test(lines[bodyStart])) bodyStart++;
    bodyStart = Math.min(lines.length, bodyStart + 1);
  }
  const bodyLines = lines.length - bodyStart;
  let bodyCharacters = Math.max(0, bodyLines - 1);
  for (let index = bodyStart; index < lines.length; index++) bodyCharacters += lines[index].length;
  const extremeLength = bodyLines >= KNOWLEDGE_OUTLINE_LIMITS.longDocumentLines || bodyCharacters >= KNOWLEDGE_OUTLINE_LIMITS.longDocumentCharacters;
  const spansFragments = bodyLines > KNOWLEDGE_BODY_FRAGMENT_LIMITS.lines || bodyCharacters > KNOWLEDGE_BODY_FRAGMENT_LIMITS.characters;
  if (!extremeLength && !(headings.length >= KNOWLEDGE_OUTLINE_LIMITS.sectionedDocumentHeadings && spansFragments)) return undefined;
  return limitKnowledgeOutline({ schemaVersion: 1, readStatus: "unread", contentRevision,
    entries: outlineEntries(headings, lines.length), totalHeadings: headings.length, truncated: false },
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

/** New relation navigation yields before any previously deliverable body is removed. */
export function fitKnowledgeNavigation<T extends { readonly outline?: Readonly<KnowledgeDocumentOutline>; readonly related?: Readonly<KnowledgeRelationPage>; readonly linkCues?: readonly KnowledgeLinkCue[] }>(values: readonly T[], fits: (values: readonly T[]) => boolean): T[] {
  const result = [...values];
  for (let index = result.length - 1; index >= 0 && !fits(result); index--) {
    if (result[index].linkCues) { const { linkCues: _cues, ...body } = result[index]; result[index] = Object.freeze(body) as T; }
  }
  for (let index = result.length - 1; index >= 0 && !fits(result); index--) {
    if (result[index].related) { const { related: _related, ...body } = result[index]; result[index] = Object.freeze(body) as T; }
  }
  return fitKnowledgeOutlines(result, fits);
}

/** Only actual authored wiki/inline Markdown links; no body/graph traversal. */
export function extractMarkdownLinkTargets(content: string): readonly string[] {
  if (!content.includes("[[") && !content.includes("](")) return Object.freeze([]);
  const targets = new Set<string>();
  const add = (raw: string) => {
    let target = raw.trim();
    try { target = decodeURIComponent(target); } catch { /* Literal malformed escapes cannot widen resolution. */ }
    target = target.split("#")[0].replace(/\\([\\ ()])/gu, "$1").replace(/\\/gu, "/");
    if (target && !target.startsWith("//") && target.length <= 1024 && !target.includes(":") && !hasNavigationControlCharacters(target)) targets.add(target);
  };
  const visible = anchorVisibleLines(content.split(/\r\n|\n|\r/u)).map(line => line ?? "").join("\n");
  const escaped = (index: number) => { let count = 0; while (index > 0 && visible[--index] === "\\") count++; return (count & 1) !== 0; };
  const pieces: string[] = []; let copied = 0;
  for (let index = 0; index < visible.length; index++) {
    if (visible[index] !== "`" || escaped(index)) continue;
    const run = visible.slice(index).match(/^`+/u)![0];
    let close = visible.indexOf(run, index + run.length);
    while (close >= 0 && (visible[close - 1] === "`" || visible[close + run.length] === "`")) close = visible.indexOf(run, close + run.length);
    if (close < 0) { index += run.length - 1; continue; }
    const end = close + run.length;
    pieces.push(visible.slice(copied, index), visible.slice(index, end).replace(/[^\n]/g, " ")); copied = end; index = end - 1;
  }
  const prose = pieces.length ? pieces.join("") + visible.slice(copied) : visible;
  for (const match of prose.matchAll(/\[\[([^\]\r\n]+)\]\]|\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^()\s])+(?:\([^()\r\n]*\)(?:\\.|[^()\s])*)?))(?:\s+["'][^\r\n]*["'])?\s*\)/gu)) {
    if (escaped(match.index)) continue;
    add(match[1] === undefined ? match[2] ?? match[3] : match[1].split("|")[0]);
    if (targets.size >= KNOWLEDGE_LINK_LIMITS.targetsPerSource) return Object.freeze([...targets]);
  }
  return Object.freeze([...targets]);
}

interface LinkCandidate { vaultRelativePath: string; contentRevision: string; targets: readonly string[] }

/** Bounded metadata-only neighborhood of the existing keyword candidates. */
export function knowledgeLinkNeighborhood(candidates: readonly LinkCandidate[], documents: readonly Pick<BodySearchDocument, "vaultRelativePath" | "title" | "aliases">[], matchedPaths: ReadonlySet<string>) {
  const selected = candidates.slice(0, KNOWLEDGE_LINK_LIMITS.candidates);
  const byPath = new Map(documents.map(document => [document.vaultRelativePath, document]));
  const byName = new Map<string, Set<string>>();
  const name = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  const safePath = (value: string) => value.length <= 1024 && !value.startsWith("/") && !/[\\:]/u.test(value) && !hasNavigationControlCharacters(value) && value.split("/").every(part => part && !part.startsWith("."));
  for (const document of documents) for (const title of [document.title, ...(document.aliases ?? [])]) {
    const key = name(title); if (!byName.has(key)) byName.set(key, new Set()); byName.get(key)!.add(document.vaultRelativePath);
  }
  const resolve = (target: string, source: string): string | undefined => {
    if (target.startsWith("//") || target.includes(":") || hasNavigationControlCharacters(target)) return undefined;
    const directory = source.slice(0, Math.max(0, source.lastIndexOf("/")));
    const paths = target.startsWith(".") ? [`${directory}/${target}`] : target.includes("/") ? [target, `${directory}/${target}`] : [];
    for (const candidate of paths) {
      const parts: string[] = [];
      for (const part of candidate.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") { if (!parts.length) return undefined; parts.pop(); } else parts.push(part);
      }
      const path = parts.join("/");
      const exact = [path, `${path}.md`, `${path}.markdown`].filter(path => byPath.has(path) && safePath(path));
      if (exact.length) return exact.length === 1 ? exact[0] : undefined;
    }
    if (target.includes("/")) return undefined;
    const matches = [...(byName.get(name(target.replace(/\.(?:md|markdown)$/iu, ""))) ?? [])].filter(safePath);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const edges = new Map(selected.map(candidate => [candidate.vaultRelativePath, new Set(candidate.targets.flatMap(target => {
    const resolved = resolve(target, candidate.vaultRelativePath); return resolved && resolved !== candidate.vaultRelativePath ? [resolved] : [];
  }))]));
  const boosted = new Set<string>();
  const shared = new Map<string, LinkCandidate[]>();
  for (const candidate of selected) for (const target of edges.get(candidate.vaultRelativePath)!) {
    if (edges.get(target)?.has(candidate.vaultRelativePath)) { boosted.add(candidate.vaultRelativePath); boosted.add(target); }
    if (!shared.has(target)) shared.set(target, []); shared.get(target)!.push(candidate);
  }
  const cues = new Map<string, readonly KnowledgeLinkCue[]>();
  const allCues: KnowledgeLinkCue[] = [];
  for (const [target, supporters] of shared) {
    if (supporters.length < 2) continue;
    supporters.forEach(supporter => boosted.add(supporter.vaultRelativePath));
    if (matchedPaths.has(target) || allCues.length >= KNOWLEDGE_LINK_LIMITS.cues) continue;
    const document = byPath.get(target)!;
    const via = supporters.slice(0, KNOWLEDGE_LINK_LIMITS.supporters).map(({ vaultRelativePath, contentRevision }) => Object.freeze({ vaultRelativePath, contentRevision }));
    if (!document.title || document.title.length > 200 || hasNavigationControlCharacters(document.title) || !via.every(item => safePath(item.vaultRelativePath) && /^sha256:[a-f0-9]{64}$/u.test(item.contentRevision))) continue;
    const cue: KnowledgeLinkCue = Object.freeze({ schemaVersion: 1, readStatus: "unread", label: "可能相关", vaultRelativePath: target, title: document.title, via: Object.freeze(via) });
    const owner = via[0].vaultRelativePath;
    const ownerCues = Object.freeze([...(cues.get(owner) ?? []), cue]);
    const bytes = [...cues].reduce((sum, [path, items]) => sum + (path === owner ? 0 : new TextEncoder().encode(JSON.stringify({ linkCues: items })).length), 0)
      + new TextEncoder().encode(JSON.stringify({ linkCues: ownerCues })).length;
    if (bytes > KNOWLEDGE_LINK_LIMITS.cueBytes) continue;
    allCues.push(cue); cues.set(owner, ownerCues);
  }
  return { boosted, cues };
}

export function normalizeKnowledgeLinkCues(value: unknown, sourcePath: string, sourceRevision: string): readonly KnowledgeLinkCue[] {
  const invalid = (): never => { throw new TypeError("knowledge_link_cues_invalid"); };
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
  const exact = (value: Record<string, unknown>, keys: readonly string[]) => { if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(); };
  const path = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !/[\\:]/u.test(value) && !hasNavigationControlCharacters(value) && value.split("/").every(part => part && !part.startsWith(".")) ? value : invalid();
  if (!Array.isArray(value) || !value.length || value.length > KNOWLEDGE_LINK_LIMITS.cues) return invalid();
  const targets = new Set<string>();
  const cues = value.map(raw => {
    const cue = object(raw); exact(cue, ["schemaVersion", "readStatus", "label", "vaultRelativePath", "title", "via"]);
    const target = path(cue.vaultRelativePath);
    if (cue.schemaVersion !== 1 || cue.readStatus !== "unread" || cue.label !== "可能相关" || typeof cue.title !== "string" || !cue.title || cue.title.length > 200 || hasNavigationControlCharacters(cue.title)
      || targets.has(target) || !Array.isArray(cue.via) || cue.via.length < 2 || cue.via.length > KNOWLEDGE_LINK_LIMITS.supporters) return invalid();
    targets.add(target);
    const sources = new Set<string>();
    const via = cue.via.map(raw => {
      const item = object(raw); exact(item, ["vaultRelativePath", "contentRevision"]);
      const source = path(item.vaultRelativePath);
      if (source === target || sources.has(source) || typeof item.contentRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.contentRevision)) return invalid();
      sources.add(source); return Object.freeze({ vaultRelativePath: source, contentRevision: item.contentRevision });
    });
    if (!via.some(item => item.vaultRelativePath === sourcePath && item.contentRevision === sourceRevision)) return invalid();
    return Object.freeze({ schemaVersion: 1 as const, readStatus: "unread" as const, label: "可能相关" as const, vaultRelativePath: target, title: cue.title, via: Object.freeze(via) });
  });
  if (new TextEncoder().encode(JSON.stringify({ linkCues: cues })).length > KNOWLEDGE_LINK_LIMITS.cueBytes) return invalid();
  return Object.freeze(cues);
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
  const result: KnowledgeDocumentOutline = { schemaVersion: 1, readStatus: "unread", contentRevision, entries: Object.freeze(entries), totalHeadings: outline.totalHeadings as number, truncated: outline.truncated };
  if (knowledgeOutlineCharacters(result) > KNOWLEDGE_OUTLINE_LIMITS.totalCharacters) return invalid();
  return Object.freeze(result);
}

export function verifyKnowledgeOutlineLines(outline: Readonly<KnowledgeDocumentOutline>, lines: readonly string[]): boolean {
  const entries = outlineEntries(parseMarkdownHeadings(lines), lines.length);
  return entries.length === outline.totalHeadings && outline.entries.every(entry => entries.some(actual =>
    actual.heading === entry.heading && actual.level === entry.level && actual.lineStart === entry.lineStart && actual.lineEnd === entry.lineEnd));
}

/** Undefined lines are non-prose boundaries; real blank lines retain their position. */
function anchorVisibleLines(lines: readonly string[]): (string | undefined)[] {
  let properties = lines[0]?.trim() === "---";
  let fence: { character: string; length: number } | undefined;
  let comment = false;
  let obsidianComment = false;
  return lines.map((raw, index) => {
    if (properties) { if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(raw)) properties = false; return undefined; }
    const marker = raw.match(/^ {0,3}(?:>[\t ]?)* {0,3}(?:(?:[-+*]|\d+[.)])[\t ]+)?(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return undefined;
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return undefined; }
    if (/^(?: {4}|\t)/u.test(raw)) return undefined;
    let line = raw;
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) return undefined;
      line = " ".repeat(end + 3) + line.slice(end + 3); comment = false;
    }
    line = line.replace(/<!--.*?-->/gu, value => " ".repeat(value.length));
    const start = line.indexOf("<!--");
    if (start >= 0) { line = line.slice(0, start); comment = true; }
    if (obsidianComment) {
      const end = line.indexOf("%%");
      if (end < 0) return undefined;
      line = " ".repeat(end + 2) + line.slice(end + 2); obsidianComment = false;
    }
    line = line.replace(/%%.*?%%/gu, value => " ".repeat(value.length));
    const hidden = line.indexOf("%%");
    if (hidden >= 0) { line = line.slice(0, hidden); obsidianComment = true; }
    return line;
  });
}

/** Only outgoing wiki anchors are needed here; no graph or target body is scanned. */
export function extractMarkdownAnchorLinks(content: string, limit = 4): { links: readonly KnowledgeLink[]; total: number } {
  const lines = content.split(/\r\n|\n|\r/u);
  const links: KnowledgeLink[] = [];
  let total = 0;
  anchorVisibleLines(lines).forEach((line, index) => {
    if (line === undefined) return;
    const prose = line.replace(/(`+).*?\1/gu, value => " ".repeat(value.length));
    for (const match of prose.matchAll(/!?\[\[([^\]\r\n]+)\]\]/gu)) {
      if (((lines[index].slice(0, match.index).match(/\\+$/u)?.[0].length ?? 0) & 1) !== 0) continue;
      let target = match[1].split("|")[0].trim();
      try { target = decodeURIComponent(target); } catch { /* Preserve the literal target. */ }
      const hash = target.indexOf("#");
      if (hash < 0 || hash === target.length - 1 || target.length > 2048 || target.length - hash - 1 > 1024) continue;
      total++;
      if (links.length < limit) links.push({ original: lines[index].slice(match.index, match.index + match[0].length).slice(0, 400),
        target: target.slice(0, hash).replace(/\\/gu, "/"), anchor: target.slice(hash + 1), line: index + 1, context: lines[index].trim().slice(0, 200) });
    }
  });
  return { links: Object.freeze(links.map(link => Object.freeze(link))), total };
}

function blockRange(lines: readonly string[], visible: readonly (string | undefined)[], marker: number, standalone: boolean): { lineStart: number; lineEnd: number } | undefined {
  let end = marker;
  if (standalone) {
    end--;
    while (end >= 0 && visible[end] !== undefined && !visible[end]!.trim()) end--;
  }
  if (end < 0 || visible[end] === undefined || !visible[end]!.trim()) return undefined;
  const isHeading = (index: number) => /^ {0,3}#{1,6}(?:\s|$)/u.test(lines[index]) || /^ {0,3}(?:=+|-+)\s*$/u.test(lines[index]);
  if (isHeading(end)) return undefined;
  const quote = /^ {0,3}>/u;
  const list = /^ {0,3}(?:[-+*]|\d+[.)])[\t ]+/u;
  let start = end;
  if (quote.test(lines[end])) {
    while (start > 0) {
      let previous = start - 1;
      while (previous >= 0 && !lines[previous].trim()) previous--;
      if (previous < 0 || !quote.test(lines[previous])) break;
      start = previous;
    }
  } else {
    let candidate = end;
    let firstItem = list.test(lines[end]) ? end : -1;
    while (candidate > 0 && (standalone || firstItem < 0)) {
      const previous = candidate - 1;
      if (!lines[previous].trim() || list.test(lines[previous]) || /^[\t ]+\S/u.test(lines[previous])) {
        candidate = previous; if (list.test(lines[previous])) firstItem = previous;
      } else break;
    }
    if (firstItem >= 0) start = firstItem;
    else {
      while (start > 0 && visible[start - 1] !== undefined && visible[start - 1]!.trim() && !isHeading(start - 1)
        && !quote.test(lines[start - 1]) && !list.test(lines[start - 1])) start--;
    }
  }
  if (!standalone) {
    const itemIndent = list.test(lines[start]) ? lines[start].match(/^ */u)![0].length : undefined;
    while (end + 1 < lines.length) {
      if (itemIndent !== undefined) {
        let next = end + 1;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next >= lines.length || (lines[next].match(/^ */u)?.[0].length ?? 0) <= itemIndent) break;
        end = next;
      } else {
        if (visible[end + 1] === undefined || !visible[end + 1]!.trim() || isHeading(end + 1) || quote.test(lines[end + 1]) || list.test(lines[end + 1])) break;
        end++;
      }
    }
  }
  return { lineStart: start + 1, lineEnd: standalone ? marker + 1 : end + 1 };
}

/** Resolve exactly one real heading or block against this snapshot, never cached lines. */
export function locateKnowledgeAnchor(vaultRelativePath: string, contentRevision: string, lines: readonly string[], requestedAnchor: string): KnowledgeAnchorLocation {
  const anchor = requestedAnchor.trim();
  const kind: KnowledgeAnchorLocation["kind"] = anchor.startsWith("^") ? "block" : "heading";
  const base = { schemaVersion: 1 as const, readStatus: "unread" as const, vaultRelativePath, contentRevision, anchor, kind: kind };
  const missing = (reason: "missing" | "ambiguous" | "invalid"): KnowledgeAnchorLocation => Object.freeze({ ...base, status: "not_located", reason });
  if (!anchor || anchor.length > 1024 || hasNavigationControlCharacters(anchor) || (kind === "block" && !/^\^[A-Za-z0-9-]+$/u.test(anchor))) return missing("invalid");
  const visible = anchorVisibleLines(lines);
  if (kind === "heading") {
    const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
    const entries = outlineEntries(parseMarkdownHeadings(visible.map(line => line ?? "")), lines.length);
    const found = entries.filter(entry => normalize(entry.heading) === normalize(anchor));
    if (found.length !== 1) return missing(found.length ? "ambiguous" : "missing");
    return Object.freeze({ ...base, status: "located", lineStart: found[0].lineStart, lineEnd: found[0].lineEnd });
  }
  const found: { marker: number; standalone: boolean }[] = [];
  visible.forEach((line, index) => {
    if (line === undefined) return;
    const prose = line.replace(/(`+).*?\1/gu, value => " ".repeat(value.length));
    const id = prose.match(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/u);
    if (id && `^${id[1]}` === anchor) found.push({ marker: index, standalone: prose.trim() === anchor });
  });
  if (found.length !== 1) return missing(found.length ? "ambiguous" : "missing");
  const range = blockRange(lines, visible, found[0].marker, found[0].standalone);
  return range ? Object.freeze({ ...base, status: "located", ...range }) : missing("invalid");
}

export function normalizeKnowledgeAnchorLocation(value: unknown, vaultRelativePath: string, contentRevision?: string, totalLines?: number): KnowledgeAnchorLocation {
  const invalid = () => { throw new TypeError("knowledge_anchor_location_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const location = value as Record<string, unknown>;
  const located = location.status === "located";
  const keys = ["schemaVersion", "readStatus", "vaultRelativePath", "anchor", "kind", "status", ...(located ? ["contentRevision", "lineStart", "lineEnd"] : ["reason", ...(Object.hasOwn(location, "contentRevision") ? ["contentRevision"] : [])])];
  if (Object.keys(location).length !== keys.length || keys.some(key => !Object.hasOwn(location, key)) || location.schemaVersion !== 1 || location.readStatus !== "unread"
    || location.vaultRelativePath !== vaultRelativePath || typeof location.anchor !== "string" || location.anchor.length > 1024
    || location.kind !== (location.anchor.startsWith("^") ? "block" : "heading") || (located ? typeof location.contentRevision !== "string" : location.status !== "not_located")
    || (Object.hasOwn(location, "contentRevision") && (typeof location.contentRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(location.contentRevision) || (contentRevision !== undefined && location.contentRevision !== contentRevision)))) return invalid();
  if (located) {
    if (!Number.isSafeInteger(location.lineStart) || !Number.isSafeInteger(location.lineEnd) || (location.lineStart as number) < 1
      || (location.lineEnd as number) < (location.lineStart as number) || (totalLines !== undefined && (location.lineEnd as number) > totalLines)) return invalid();
  } else if (!["missing", "ambiguous", "unavailable", "invalid"].includes(location.reason as string)) return invalid();
  return Object.freeze({ ...location }) as KnowledgeAnchorLocation;
}

/** A delivered page is bounded unread navigation, never another source reference. */
export function normalizeKnowledgeRelationPage(value: unknown, vaultRelativePath: string, contentRevision: string): Readonly<KnowledgeRelationPage> {
  const invalid = (): never => { throw new TypeError("knowledge_related_invalid"); };
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
  const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
    if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  };
  const string = (value: unknown, max: number): string => typeof value === "string" && value.length > 0 && value.length <= max && !hasNavigationControlCharacters(value) ? value : invalid();
  const path = (value: unknown): string => {
    const result = string(value, 1024);
    if (result.startsWith("/") || result.includes("\\") || result.includes(":") || result.split("/").some(part => !part || part === "." || part === "..")) invalid();
    return result;
  };
  const revision = (value: unknown): string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : invalid();
  const integer = (value: unknown, minimum = 0): number => Number.isSafeInteger(value) && (value as number) >= minimum ? value as number : invalid();
  const target = (value: unknown): KnowledgeRelationTarget => {
    const item = object(value); keys(item, ["vaultRelativePath", "title", "contentRevision"]);
    return Object.freeze({ vaultRelativePath: path(item.vaultRelativePath), title: string(item.title, 1024), contentRevision: revision(item.contentRevision) });
  };
  const page = object(value);
  keys(page, ["vaultRelativePath", "contentRevision", "total", "returned", "remaining", "hasMore", "exhausted", "items"], ["continuationCursor"]);
  if (path(page.vaultRelativePath) !== vaultRelativePath || revision(page.contentRevision) !== contentRevision || !Array.isArray(page.items) || page.items.length > 8) return invalid();
  const total = integer(page.total); const returned = integer(page.returned); const remaining = integer(page.remaining);
  if (returned !== page.items.length || returned + remaining > total || page.hasMore !== (remaining > 0) || page.exhausted !== (remaining === 0)
    || (page.hasMore && !Object.hasOwn(page, "continuationCursor"))) return invalid();
  let candidatesTotal = 0;
  const items = page.items.map(value => {
    const item = object(value);
    keys(item, ["direction", "status", "relation", "original", "source"], ["anchor", "anchorStatus", "anchorLocation", "target", "candidates"]);
    if (!["outgoing", "incoming"].includes(item.direction as string) || !["available", "ambiguous", "unresolved"].includes(item.status as string) || item.relation !== "link") return invalid();
    const sourceObject = object(item.source); keys(sourceObject, ["vaultRelativePath", "title", "contentRevision", "line", "context"]);
    const source = Object.freeze({ vaultRelativePath: path(sourceObject.vaultRelativePath), title: string(sourceObject.title, 1024), contentRevision: revision(sourceObject.contentRevision),
      line: integer(sourceObject.line, 1), context: typeof sourceObject.context === "string" && sourceObject.context.length <= 2048 && !hasNavigationControlCharacters(sourceObject.context, true) ? sourceObject.context : invalid() });
    const destination = Object.hasOwn(item, "target") ? target(item.target) : undefined;
    if (item.status === "available" ? !destination : destination !== undefined) return invalid();
    if (item.direction === "outgoing" ? source.vaultRelativePath !== vaultRelativePath || source.contentRevision !== contentRevision
      : !destination || destination.vaultRelativePath !== vaultRelativePath || destination.contentRevision !== contentRevision) return invalid();
    const anchor = Object.hasOwn(item, "anchor") ? string(item.anchor, 1024) : undefined;
    if (Object.hasOwn(item, "anchorStatus") && (!anchor || !["located", "not_located"].includes(item.anchorStatus as string))) return invalid();
    let anchorLocation: KnowledgeAnchorLocation | undefined;
    if (Object.hasOwn(item, "anchorLocation")) {
      const raw = object(item.anchorLocation);
      anchorLocation = normalizeKnowledgeAnchorLocation(raw, destination?.vaultRelativePath ?? path(raw.vaultRelativePath), destination?.contentRevision);
      if (!anchor || anchorLocation.anchor !== anchor.trim() || item.anchorStatus !== anchorLocation.status
        || (destination && anchorLocation.contentRevision !== destination.contentRevision)
        || (anchorLocation.status === "located" && !destination)
        || (!destination && (anchorLocation.status !== "not_located" || anchorLocation.reason !== "unavailable" || anchorLocation.contentRevision !== undefined))) return invalid();
    } else if (item.anchorStatus === "located") return invalid();
    let candidates: KnowledgeRelationTarget[] | undefined;
    if (Object.hasOwn(item, "candidates")) {
      if (!Array.isArray(item.candidates) || !item.candidates.length || (candidatesTotal += item.candidates.length) > 32) return invalid();
      candidates = item.candidates.map(target);
    }
    return Object.freeze({ direction: item.direction, status: item.status, relation: "link", original: string(item.original, 2048), source,
      ...(anchor ? { anchor } : {}), ...(item.anchorStatus ? { anchorStatus: item.anchorStatus } : {}), ...(anchorLocation ? { anchorLocation } : {}),
      ...(destination ? { target: destination } : {}), ...(candidates ? { candidates: Object.freeze(candidates) } : {}) }) as KnowledgeRelation;
  });
  const normalized = { vaultRelativePath, contentRevision, total, returned, remaining, hasMore: remaining > 0, exhausted: remaining === 0,
    items: Object.freeze(items), ...(Object.hasOwn(page, "continuationCursor") ? { continuationCursor: string(page.continuationCursor, 4096) } : {}) };
  if (new TextEncoder().encode(JSON.stringify(normalized)).length > 24_000) return invalid();
  return Object.freeze(normalized) as Readonly<KnowledgeRelationPage>;
}

export function knowledgeAnchorCoversSpan(location: KnowledgeAnchorLocation, span: { lineStart: number; lineEnd: number }): boolean {
  return location.status !== "located" || (span.lineStart >= location.lineStart && span.lineEnd <= location.lineEnd);
}

export function verifyKnowledgeAnchorLines(location: KnowledgeAnchorLocation, contentRevision: string, lines: readonly string[]): boolean {
  const actual = locateKnowledgeAnchor(location.vaultRelativePath, contentRevision, lines, location.anchor);
  return actual.status === location.status && actual.kind === location.kind && (actual.status === "located" && location.status === "located"
    ? actual.lineStart === location.lineStart && actual.lineEnd === location.lineEnd
    : actual.status === "not_located" && location.status === "not_located" && actual.reason === location.reason);
}
