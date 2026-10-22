import { createHash } from "node:crypto";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { MaintenanceKnowledgeEvidence, MaintenanceKnowledgeSource, MaintenanceKnowledgeType, MaintenanceKnowledgeUnit } from "./maintenance-p2-contract";
import { MAINTENANCE_KNOWLEDGE_TYPES } from "./maintenance-knowledge-types";

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function knownType(value: unknown): value is MaintenanceKnowledgeType {
  return typeof value === "string" && (MAINTENANCE_KNOWLEDGE_TYPES as readonly string[]).includes(value);
}

function evidenceLocation(unitId: string, sourcePath: unknown): string {
  return `[unit.id=${JSON.stringify(unitId)}, sourcePath=${typeof sourcePath === "string" ? JSON.stringify(sourcePath) : "<missing>"}]`;
}

/** note_read exposes a bare digest; accept only that exact alternate spelling. */
function evidenceRevision(value: unknown, location: string): string {
  if (typeof value === "string" && /^[a-f\d]{64}$/iu.test(value)) return `sha256:${value.toLowerCase()}`;
  if (typeof value === "string" && /^sha256:[a-f\d]{64}$/u.test(value)) return value;
  throw new Error(`${location} 版本格式非法：sourceRevision must be exactly 64 hex characters or sha256:<64 lowercase hex>.`);
}

function normalizedAlias(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

const MANAGEMENT_SECTION_TITLES = new Set([
  "来源", "资料来源", "原始来源", "参考来源", "引用来源", "来源与引用", "参考", "参考资料", "参考文献", "引用",
  "相关条目", "相关知识", "相关页面", "相关笔记", "相关链接", "相关文章", "延伸阅读",
  "source", "sources", "reference", "references", "citation", "citations", "related", "relatedentries", "relatedpages",
  "relatednotes", "relatedlinks", "relatedknowledge", "relatedarticles", "seealso", "furtherreading"
]);

function isManagementSection(title: string): boolean {
  const normalized = title.normalize("NFKC").replace(/[*_`]/gu, "").replace(/^\s*\d+[.)、:：-]\s*/u, "").trim();
  const compact = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  if (MANAGEMENT_SECTION_TITLES.has(compact(normalized))) return true;
  // Bilingual labels such as “来源 / Sources” remain management sections.
  const parts = normalized.split(/[/|()（）:：]/u).map(compact).filter(Boolean);
  return parts.length > 1 && parts.every((part) => MANAGEMENT_SECTION_TITLES.has(part));
}

function frontmatter(content: string): { yaml: string | null; body: string; bodyStart: number } {
  const bomLength = content.startsWith("\uFEFF") ? 1 : 0;
  const withoutBom = content.replace(/^\uFEFF/u, "");
  const opening = /^---[ \t]*(?:\r\n|\n|\r)/u.exec(withoutBom);
  if (!opening) return { yaml: null, body: withoutBom, bodyStart: bomLength };
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gmu;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(withoutBom);
  if (!match) throw new Error("Knowledge frontmatter is not closed.");
  const bodyStart = bomLength + match.index + match[0].length;
  return { yaml: withoutBom.slice(opening[0].length, match.index), body: content.slice(bodyStart), bodyStart };
}

interface TextRange { start: number; end: number }
interface GroundingSource {
  content: string;
  revision: string;
  body: string;
  bodyStart: number;
  proseRanges?: TextRange[];
}

/** Split around inline code; a normalized quote may never bridge a code span. */
function inlineProseRanges(content: string, range: TextRange): TextRange[] {
  const ranges: TextRange[] = [];
  const backticks = /`+/gu;
  backticks.lastIndex = range.start;
  let plainStart = range.start;
  let opening: RegExpExecArray | null;
  while ((opening = backticks.exec(content)) && opening.index < range.end) {
    if (opening.index > plainStart) ranges.push({ start: plainStart, end: opening.index });
    let closing: RegExpExecArray | null;
    let found = false;
    while ((closing = backticks.exec(content)) && closing.index < range.end) {
      if (closing[0].length === opening[0].length) {
        plainStart = closing.index + closing[0].length;
        found = true;
        break;
      }
    }
    // An unmatched delimiter is conservatively excluded from normalization.
    if (!found) return ranges;
  }
  if (plainStart < range.end) ranges.push({ start: plainStart, end: range.end });
  return ranges;
}

const HTML_VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function hasCodeIndent(line: string): boolean {
  let columns = 0;
  for (const character of line) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - columns % 4;
    else return false;
    if (columns >= 4) return true;
  }
  return false;
}

/** Conservative Markdown prose blocks. Literal matching is intentionally broader. */
function ordinaryProseRanges(content: string, bodyStart: number): TextRange[] {
  const ranges: TextRange[] = [];
  let paragraph: TextRange | undefined;
  let fence: { character: string; length: number } | undefined;
  let htmlTag: { name: string; depth: number } | undefined;
  let htmlComment = false;
  let htmlTerminator: string | undefined;
  let inlineDelimiter: number | undefined;
  const flush = () => {
    if (paragraph) ranges.push(...inlineProseRanges(content, paragraph));
    paragraph = undefined;
  };
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
  linePattern.lastIndex = bodyStart;
  let line: RegExpExecArray | null;
  while ((line = linePattern.exec(content)) && line[0].length) {
    const text = line[1];
    const marker = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      flush();
      inlineDelimiter = undefined;
      continue;
    }
    if (marker && !htmlTag && !htmlComment && !htmlTerminator) {
      fence = { character: marker[1][0], length: marker[1].length };
      flush();
      inlineDelimiter = undefined;
      continue;
    }
    if (!htmlTag && !htmlComment && !htmlTerminator && (!text.trim() || hasCodeIndent(text))) {
      flush();
      inlineDelimiter = undefined;
      continue;
    }
    if (/^ {0,3}(?:#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d{1,9}[.)])[ \t]+)/u.test(text)) inlineDelimiter = undefined;
    let htmlInput = text;
    if (!htmlTag && !htmlComment && !htmlTerminator) {
      htmlInput = "";
      let cursor = 0;
      for (const delimiter of text.matchAll(/`+/gu)) {
        if (!inlineDelimiter) htmlInput += text.slice(cursor, delimiter.index);
        if (!inlineDelimiter) inlineDelimiter = delimiter[0].length;
        else if (inlineDelimiter === delimiter[0].length) inlineDelimiter = undefined;
        cursor = delimiter.index + delimiter[0].length;
      }
      if (!inlineDelimiter) htmlInput += text.slice(cursor);
    }
    let htmlBoundary = !!htmlTag || htmlComment || !!htmlTerminator;
    if (htmlTerminator) {
      if (text.includes(htmlTerminator)) htmlTerminator = undefined;
      flush();
      continue;
    }
    let visible = "";
    let cursor = 0;
    while (cursor < htmlInput.length) {
      if (htmlComment) {
        const end = htmlInput.indexOf("-->", cursor);
        htmlBoundary = true;
        if (end < 0) { cursor = htmlInput.length; break; }
        cursor = end + 3;
        htmlComment = false;
      } else {
        const start = htmlInput.indexOf("<!--", cursor);
        if (start < 0) { visible += htmlInput.slice(cursor); break; }
        visible += htmlInput.slice(cursor, start);
        cursor = start + 4;
        htmlComment = true;
        htmlBoundary = true;
      }
    }
    const declaration = /<(!\[CDATA\[|\?|!)/u.exec(visible);
    if (declaration) {
      const terminator = declaration[1] === "![CDATA[" ? "]]>" : declaration[1] === "?" ? "?>" : ">";
      if (!visible.slice(declaration.index + declaration[0].length).includes(terminator)) htmlTerminator = terminator;
      htmlBoundary = true;
    }
    for (const tag of visible.matchAll(/<(\/?)([A-Za-z][A-Za-z\d-]*)(?=[\s/>]|$)([^<>]*?)(?:>|$)/gu)) {
      htmlBoundary = true;
      const name = tag[2].toLowerCase();
      const closing = !!tag[1];
      const selfClosing = /\/\s*$/u.test(tag[3]) || HTML_VOID_TAGS.has(name);
      if (htmlTag) {
        if (name === htmlTag.name) {
          if (closing) htmlTag.depth -= 1;
          else if (!selfClosing) htmlTag.depth += 1;
          if (!htmlTag.depth) htmlTag = undefined;
        }
      } else if (!closing && !selfClosing) htmlTag = { name, depth: 1 };
    }
    if (htmlBoundary || !text.trim() || hasCodeIndent(text) || /^ {0,3}>/u.test(text)) { flush(); inlineDelimiter = undefined; continue; }
    if (/^ {0,3}(?:=+|-+)[ \t]*$/u.test(text)) {
      // A setext underline makes the preceding paragraph a heading, not prose.
      paragraph = undefined;
      continue;
    }
    if (/^ {0,3}(?:#{1,6}(?:[ \t]+|$)|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$|(?:-[ \t]*){3,}$)/u.test(text)) { flush(); continue; }
    if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u.test(text)) flush();
    if (!paragraph) paragraph = { start: line.index, end: line.index + text.length };
    else paragraph.end = line.index + text.length;
  }
  flush();
  return ranges;
}

function collapseWhitespace(value: string): string {
  return value.replace(/[\p{Zs}\t\r\n]+/gu, " ").trim();
}

function normalizedRange(content: string, range: TextRange): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = range.start; index < range.end;) {
    const start = index;
    if (/[\p{Zs}\t\r\n]/u.test(content[index])) {
      while (index < range.end && /[\p{Zs}\t\r\n]/u.test(content[index])) index += 1;
      if (!text || index === range.end) continue;
      text += " ";
    } else text += content[index++];
    starts.push(start);
    ends.push(index);
  }
  return { text, starts, ends };
}

function findQuote(source: GroundingSource, quote: string): { start: number; end: number; match: "literal" | "whitespace" } | null {
  const literal = source.body.indexOf(quote);
  if (literal >= 0) return { start: source.bodyStart + literal, end: source.bodyStart + literal + quote.length, match: "literal" };
  const trimmed = quote.trim();
  if (trimmed.split(/\r\n|\n|\r/u).some((line) => !line.trim())) return null;
  const normalizedQuote = collapseWhitespace(trimmed);
  if (!normalizedQuote) return null;
  source.proseRanges ??= ordinaryProseRanges(source.content, source.bodyStart);
  for (const range of source.proseRanges) {
    const normalized = normalizedRange(source.content, range);
    const index = normalized.text.indexOf(normalizedQuote);
    if (index >= 0) return { start: normalized.starts[index], end: normalized.ends[index + normalizedQuote.length - 1], match: "whitespace" };
  }
  return null;
}

interface QuoteFailure { unitId: string; sourcePath: string; quoteIndex: number; quote: unknown }
const MAX_QUOTE_FAILURES = 12;
const MAX_QUOTE_ERROR_BYTES = 6500;

function utf8Preview(value: string, maximum: number, label: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maximum) return value;
  let prefix = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maximum) break;
    prefix += character;
    used += size;
  }
  return `${prefix}…（${label}已截短，原展示为${bytes} UTF8字节）`;
}

function quoteFailureError(failures: readonly QuoteFailure[], total: number): Error {
  const header = `知识引文校验失败，共${total}条。知识点ID可沿用；修正下列quote后重发完整批次，不必删来源或换ID。quoteIndex从0起始。quote 不是连续正文原句：仅允许同一普通正文段内的排版空白差异，请保留原文换行、重读该来源；不作语义或模糊匹配。`;
  const footer = (shown: number) => `已列出${shown}条，遗漏${total - shown}条（条数上限${MAX_QUOTE_FAILURES}，整条消息上限${MAX_QUOTE_ERROR_BYTES} UTF8字节）。`;
  const entries: string[] = [];
  for (const failure of failures) {
    const location = evidenceLocation(utf8Preview(failure.unitId, 160, "unit.id"), utf8Preview(failure.sourcePath, 320, "sourcePath"));
    const quote = utf8Preview(JSON.stringify(failure.quote) ?? String(failure.quote), 700, "收到的quote");
    const entry = `${location}, quoteIndex=${failure.quoteIndex}（从0起始）, 收到的quote=${quote}`;
    if (Buffer.byteLength([header, ...entries, entry, footer(entries.length + 1)].join("\n"), "utf8") > MAX_QUOTE_ERROR_BYTES) break;
    entries.push(entry);
  }
  return new Error([header, ...entries, footer(entries.length)].join("\n"));
}

/**
 * Checks quote grounding and the full-file revision only.
 * It does not establish that a quote semantically supports a unit's points.
 * The caller additionally checks that each unit cites its decomposition source.
 */
export function validateMaintenanceKnowledgeUnits(
  units: readonly MaintenanceKnowledgeUnit[],
  sources: readonly MaintenanceKnowledgeSource[]
): void {
  groundMaintenanceKnowledgeUnits(units, sources);
}

/** Pure grounding: return source slices and recomputed UTF-16 locations, never edit Raw or inputs. */
export function groundMaintenanceKnowledgeUnits(
  units: readonly MaintenanceKnowledgeUnit[],
  sources: readonly MaintenanceKnowledgeSource[]
): MaintenanceKnowledgeUnit[] {
  if (!Array.isArray(units) || !Array.isArray(sources)) throw new Error("Knowledge units and sources must be arrays.");
  const sourceByPath = new Map<string, GroundingSource>();
  for (const source of sources) {
    if (!source || !nonempty(source.path) || typeof source.content !== "string" || !nonempty(source.contentRevision)) throw new Error("Knowledge source requires a path, full content and contentRevision.");
    if (sourceByPath.has(source.path)) throw new Error("Knowledge source paths must be unique.");
    const referencingUnits = units.filter((unit) => unit && Array.isArray(unit.evidence) && unit.evidence.some((evidence) => evidence?.sourcePath === source.path));
    const location = evidenceLocation(referencingUnits.map((unit) => unit.id).join(", ") || "<unreferenced>", source.path);
    if (!/^sha256:[a-f\d]{64}$/u.test(source.contentRevision)) throw new Error(`${location} 版本格式非法：host contentRevision must use sha256:<64 lowercase hex>.`);
    const actualRevision = `sha256:${createHash("sha256").update(source.content, "utf8").digest("hex")}`;
    if (source.contentRevision !== actualRevision) throw new Error(`${location} 全文版本不匹配：source contentRevision must match its full content.`);
    const parsed = frontmatter(source.content);
    sourceByPath.set(source.path, { content: source.content, revision: source.contentRevision, body: parsed.body, bodyStart: parsed.bodyStart });
  }
  const ids = new Set<string>();
  const groundedUnits: MaintenanceKnowledgeUnit[] = [];
  const failures: QuoteFailure[] = [];
  let failureCount = 0;
  for (const unit of units) {
    if (!unit || !nonempty(unit.id) || !knownType(unit.type) || !nonempty(unit.domain) || !nonempty(unit.title)) throw new Error("Knowledge unit requires a nonempty id, one of seven types, domain and title.");
    if (ids.has(unit.id)) throw new Error("Knowledge unit ids must be unique.");
    ids.add(unit.id);
    if (unit.typePendingConfirmation !== undefined && typeof unit.typePendingConfirmation !== "boolean") throw new Error("Knowledge typePendingConfirmation must be boolean.");
    if (!Array.isArray(unit.aliases) || !unit.aliases.every(nonempty)) throw new Error("Knowledge unit aliases must be a string list.");
    if (!Array.isArray(unit.points) || !unit.points.length || !unit.points.every(nonempty)) throw new Error("Knowledge unit points must be a nonempty string list.");
    if (!Array.isArray(unit.evidence) || !unit.evidence.length) throw new Error("Knowledge unit evidence must be nonempty.");
    const groundedEvidence: MaintenanceKnowledgeEvidence[] = [];
    for (const [quoteIndex, evidence] of unit.evidence.entries()) {
      const location = evidenceLocation(unit.id, evidence?.sourcePath);
      if (!evidence || !nonempty(evidence.sourcePath)) throw new Error(`${location} sourcePath 缺失或为空，须指定本批来源路径。`);
      const source = sourceByPath.get(evidence.sourcePath);
      if (!source) throw new Error(`${location} sourcePath is outside this batch's sources，须重读本批允许的来源。`);
      if (evidenceRevision(evidence.sourceRevision, location) !== source.revision) throw new Error(`${location} 全文版本不匹配：sourceRevision does not match the source's full-file revision，请重读该来源。`);
      const match = nonempty(evidence.quote) ? findQuote(source, evidence.quote) : null;
      if (!match) {
        failureCount += 1;
        if (failures.length < MAX_QUOTE_FAILURES) failures.push({ unitId: unit.id, sourcePath: evidence.sourcePath, quoteIndex, quote: evidence.quote });
        continue;
      }
      groundedEvidence.push({ ...evidence, sourceRevision: source.revision, quote: source.content.slice(match.start, match.end), quoteLocation: { ...match, unit: "utf16", submittedQuote: evidence.quote } });
    }
    groundedUnits.push({ ...unit, aliases: [...unit.aliases], points: [...unit.points], evidence: groundedEvidence });
  }
  if (failureCount) throw quoteFailureError(failures, failureCount);
  return groundedUnits;
}

/** Validate new pages only; existing-page metadata is deliberately outside this API. */
export function validateMaintenanceNewPage(content: string, units: readonly MaintenanceKnowledgeUnit[]): void {
  if (!nonempty(content) || !Array.isArray(units) || !units.length || !units.every((unit) => unit && knownType(unit.type))) throw new Error("New knowledge pages require content and typed knowledge units.");
  const parsed = frontmatter(content);
  if (parsed.yaml === null) throw new Error("New knowledge pages require YAML frontmatter.");
  const document = parseDocument(parsed.yaml, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error("New knowledge frontmatter must be an unambiguous YAML mapping.");
  const field = (name: string) => document.contents && isMap(document.contents)
    ? document.contents.items.find((pair) => isScalar(pair.key) && !pair.key.anchor && !pair.key.tag && pair.key.value === name)?.value
    : undefined;
  const type = field("类型");
  if (!isScalar(type) || type.anchor || type.tag || !knownType(type.value) || type.value !== units[0].type) throw new Error("New page 类型 must be one of seven types and match its primary unit.");
  const aliases = field("aliases");
  if (!isSeq(aliases) || aliases.anchor || aliases.tag || !aliases.items.every((item) => isScalar(item) && !item.anchor && !item.tag && nonempty(item.value))) throw new Error("New page aliases must be a standard string list, including [] when empty.");
  if (document.contents.items.some((pair) => isScalar(pair.key) && pair.key.value === "别名")) throw new Error("New page aliases must use only the standard aliases field, not 别名.");
  const pageAliases = new Set(aliases.items.map((item) => normalizedAlias(String(isScalar(item) ? item.value : ""))));
  for (const unit of units) {
    if (!Array.isArray(unit.aliases) || !unit.aliases.every(nonempty)) throw new Error("Knowledge unit aliases must be a string list.");
    if (unit.aliases.some((alias) => !pageAliases.has(normalizedAlias(alias)))) throw new Error("New page aliases must preserve all knowledge unit aliases.");
  }
  const pending = field("类型待确认");
  if (pending !== undefined && (!isScalar(pending) || pending.anchor || pending.tag || typeof pending.value !== "boolean")) throw new Error("New page 类型待确认 must be boolean.");
  if (units.some((unit) => unit.typePendingConfirmation) && (!isScalar(pending) || pending.value !== true)) throw new Error("Uncertain knowledge types require 类型待确认: true.");

  // Mask code and comments before detecting headings, so examples cannot supply structure.
  let fence: { character: string; length: number } | undefined;
  const bodyLines = parsed.body.replace(/<!--[\s\S]*?-->/gu, "").split(/\r\n|\n|\r/u);
  const lines = bodyLines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return ""; }
    return line;
  });
  const headings = lines.flatMap((line, index) => {
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/u.exec(line);
    return match && nonempty(match[2]) ? [{ index, level: match[1].length, title: match[2] }] : [];
  });
  const h1 = headings.filter((heading) => heading.level === 1);
  if (h1.length !== 1 || headings[0] !== h1[0]) throw new Error("New knowledge pages require one H1 before their sections.");
  const firstSection = headings.find((heading) => heading.level > 1);
  const readable = (values: readonly string[]) => values.some((line) => /[\p{L}\p{N}]/u.test(line));
  if (!firstSection || !readable(lines.slice(h1[0].index + 1, firstSection.index))) throw new Error("New knowledge pages require a nonempty lead after H1 and structured content.");
  const sectionLines = bodyLines.map((line) => /^ {0,3}(?:`{3,}|~{3,})/u.test(line) ? "" : line);
  let managementLevel: number | undefined;
  const hasKnowledgeContent = headings.some((heading, index) => {
    if (managementLevel !== undefined && heading.level <= managementLevel) managementLevel = undefined;
    if (heading.level > 1 && isManagementSection(heading.title) && managementLevel === undefined) managementLevel = heading.level;
    return heading.level > 1 && managementLevel === undefined && readable(sectionLines.slice(heading.index + 1, headings[index + 1]?.index));
  });
  if (!hasKnowledgeContent) throw new Error("New knowledge pages require a section with knowledge content beyond sources/related entries; section titles may be customized.");
}
