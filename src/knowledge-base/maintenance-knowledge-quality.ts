import { isUnknownArray } from "../utils/unknown-array";
import { getDesktopCrypto } from "../platform/desktop-crypto";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { MaintenanceKnowledgeEvidence, MaintenanceKnowledgeSource, MaintenanceKnowledgeType, MaintenanceKnowledgeUnit } from "./maintenance-p2-contract";
import { MAINTENANCE_KNOWLEDGE_TYPES } from "./maintenance-knowledge-types";
import { assertMaintenanceShortTarget, MAINTENANCE_SHORT_TITLE_POLICY, type MaintenanceTitlePolicy } from "./maintenance-title";
import { throwMaintenanceDiagnostics } from "./maintenance-diagnostics";

const { createHash } = getDesktopCrypto();

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function knownType(value: unknown): value is MaintenanceKnowledgeType {
  return typeof value === "string" && (MAINTENANCE_KNOWLEDGE_TYPES as readonly string[]).includes(value);
}

function evidenceLocation(unitId: string, sourcePath: unknown): string {
  return `[unit.id=${JSON.stringify(utf8Preview(unitId, 160, "unit.id"))}, sourcePath=${typeof sourcePath === "string" ? JSON.stringify(utf8Preview(sourcePath, 320, "sourcePath")) : "<missing>"}]`;
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

function matchingBacktickEnd(content: string, start: number, length: number, end: number): number | null {
  const backticks = /`+/gu;
  backticks.lastIndex = start + length;
  for (let match = backticks.exec(content); match && match.index < end; match = backticks.exec(content)) {
    if (match[0].length === length && match.index + length <= end) return match.index + length;
  }
  return null;
}

/** Ambiguous paired Markdown code wins over legacy or mixed TeX quotation marks. */
function legacyQuoteEnd(content: string, start: number, end: number): TextRange | null {
  if (content.slice(start, start + 2) !== "``" || content[start - 1] === "`" || content[start + 2] === "`") return null;
  const closing = /''|"/gu;
  closing.lastIndex = start + 2;
  const match = closing.exec(content);
  if (!match || match.index + match[0].length > end || !content.slice(start + 2, match.index).trim() || content.slice(start + 2, match.index).includes("`")) return null;
  if (matchingBacktickEnd(content, start, 2, end) !== null) return null;
  return { start: match.index, end: match.index + match[0].length };
}

/** Split around inline code; a normalized quote may never bridge a code span. */
function inlineProseRanges(content: string, range: TextRange): TextRange[] {
  const ranges: TextRange[] = [];
  const backticks = /`+/gu;
  backticks.lastIndex = range.start;
  let plainStart = range.start;
  let opening: RegExpExecArray | null;
  while ((opening = backticks.exec(content)) && opening.index < range.end) {
    const codeEnd = matchingBacktickEnd(content, opening.index, opening[0].length, range.end);
    // Markdown only creates code spans from paired delimiters; unmatched runs stay literal prose.
    if (codeEnd === null) continue;
    if (opening.index > plainStart) ranges.push({ start: plainStart, end: opening.index });
    plainStart = codeEnd;
    backticks.lastIndex = codeEnd;
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

/** Limit inline-code lookahead to the current ordinary Markdown paragraph/item. */
function inlineParagraphEnd(content: string, nextLine: number): number {
  const lines = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
  lines.lastIndex = nextLine;
  for (let line = lines.exec(content); line && line[0].length; line = lines.exec(content)) {
    const text = line[1];
    if (!text.trim() || hasCodeIndent(text) || /^ {0,3}(?:>|#{1,6}(?:[ \t]+|$)|(?:[-+*]|\d{1,9}[.)])[ \t]+|`{3,}|~{3,}|(?:=+|-+)[ \t]*$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/u.test(text)) return line.index;
  }
  return content.length;
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
      const delimiters = /`+/gu;
      for (let delimiter = delimiters.exec(text); delimiter; delimiter = delimiters.exec(text)) {
        if (!inlineDelimiter) htmlInput += text.slice(cursor, delimiter.index);
        if (!inlineDelimiter) {
          const codeEnd = matchingBacktickEnd(content, line.index + delimiter.index, delimiter[0].length, inlineParagraphEnd(content, line.index + line[0].length));
          if (codeEnd !== null) inlineDelimiter = delimiter[0].length;
          else htmlInput += delimiter[0];
        }
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

// Deliberately not NFKC: fullwidth letters, numbers, case and wording stay distinct.
const TYPOGRAPHY_PUNCTUATION: Readonly<Record<string, string>> = Object.freeze({
  "！": "!", "＂": '"', "＃": "#", "＄": "$", "％": "%", "＆": "&", "＇": "'", "（": "(", "）": ")",
  "＊": "*", "＋": "+", "，": ",", "－": "-", "．": ".", "／": "/", "：": ":", "；": ";", "＜": "<", "＝": "=", "＞": ">", "？": "?", "＠": "@",
  "［": "[", "＼": "\\", "］": "]", "＾": "^", "＿": "_", "｀": "`", "｛": "{", "｜": "|", "｝": "}", "～": "~",
  "。": ".", "“": '"', "”": '"', "‘": "'", "’": "'"
});

function normalizedRange(content: string, range: TextRange, typography = false): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let legacyClosing: TextRange | null = null;
  for (let index = range.start; index < range.end;) {
    const start = index;
    if (/[\p{Zs}\t\r\n]/u.test(content[index])) {
      while (index < range.end && /[\p{Zs}\t\r\n]/u.test(content[index])) index += 1;
      if (!text || index === range.end) continue;
      text += " ";
    } else if (typography && legacyClosing === null && (legacyClosing = legacyQuoteEnd(content, index, range.end)) !== null) {
      text += '"';
      index += 2;
    } else if (typography && legacyClosing !== null && index === legacyClosing.start) {
      text += '"';
      index = legacyClosing.end;
      legacyClosing = null;
    } else {
      text += typography ? TYPOGRAPHY_PUNCTUATION[content[index]] ?? content[index] : content[index];
      index += 1;
    }
    starts.push(start);
    ends.push(index);
  }
  return { text, starts, ends };
}

function findQuote(source: GroundingSource, quote: string): { start: number; end: number; match: "literal" | "whitespace" | "typography" } | null {
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
  const typographyQuote = normalizedRange(trimmed, { start: 0, end: trimmed.length }, true).text;
  for (const range of source.proseRanges) {
    const normalized = normalizedRange(source.content, range, true);
    const index = normalized.text.indexOf(typographyQuote);
    if (index >= 0) return { start: normalized.starts[index], end: normalized.ends[index + typographyQuote.length - 1], match: "typography" };
  }
  return null;
}

interface QuoteFailure { unitIndex: number; unitId: string; sourcePath: unknown; quoteIndex: number; quote: unknown }
interface UnitFailure { unitIndex: number; unitId: string; sourcePath?: unknown; field: string; message: string }
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

function quoteFailureError(failures: readonly QuoteFailure[], quoteTotal: number, unitFailures: readonly UnitFailure[] = [], unitTotal = unitFailures.length): Error {
  const total = quoteTotal + unitTotal;
  const header = `${unitTotal ? "知识单元" : "知识引文"}校验失败，共${total}条${unitTotal ? `（字段/结构${unitTotal}条，引文${quoteTotal}条）` : ""}。知识点ID可沿用；修正下列字段/quote后重发完整批次，不必删来源或换ID。quoteIndex从0起始。quote 不是连续正文原句：仅允许同一普通正文段内的排版空白、明确全半角标点及引号等价，请重读该来源；不作大小写、换词或模糊匹配。`;
  const footer = (shown: number) => `已列出${shown}条，遗漏${total - shown}条（条数上限${MAX_QUOTE_FAILURES}，整条消息小于${MAX_QUOTE_ERROR_BYTES} UTF8字节）。`;
  const candidates = [
    ...unitFailures.map((failure) => `units[${failure.unitIndex}] ${evidenceLocation(failure.unitId, failure.sourcePath)}, field=${failure.field}: ${failure.message}`),
    ...failures.map((failure) => {
      const quote = typeof failure.quote === "string" ? utf8Preview(JSON.stringify(failure.quote), 700, "收到的quote")
        : failure.quote === undefined ? "<missing>" : failure.quote === null ? "null" : `<${isUnknownArray(failure.quote) ? "array" : typeof failure.quote}>`;
      return `units[${failure.unitIndex}] ${evidenceLocation(failure.unitId, failure.sourcePath)}, field=evidence[${failure.quoteIndex}].quote, quoteIndex=${failure.quoteIndex}（从0起始）, 收到的quote=${quote}；修复：使用该来源中连续的正文原句。`;
    })
  ];
  const entries: string[] = [];
  for (const entry of candidates) {
    if (entries.length === MAX_QUOTE_FAILURES || Buffer.byteLength([header, ...entries, entry, footer(entries.length + 1)].join("\n"), "utf8") >= MAX_QUOTE_ERROR_BYTES) break;
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
  if (!isUnknownArray(units) || !isUnknownArray(sources)) throw new Error("Knowledge units and sources must be arrays.");
  const sourceByPath = new Map<string, GroundingSource>();
  for (const source of sources) {
    if (!source || !nonempty(source.path) || typeof source.content !== "string" || !nonempty(source.contentRevision)) throw new Error("Knowledge source requires a path, full content and contentRevision.");
    if (sourceByPath.has(source.path)) throw new Error("Knowledge source paths must be unique.");
    const referencingUnits = units.filter((unit) => unit && isUnknownArray(unit.evidence) && unit.evidence.some((evidence) => evidence?.sourcePath === source.path));
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
  const unitFailures: UnitFailure[] = [];
  let failureCount = 0;
  let unitFailureCount = 0;
  for (const [unitIndex, unit] of units.entries()) {
    const unitId = unit && typeof unit.id === "string" ? unit.id : "<missing>";
    const fail = (field: string, message: string, sourcePath?: unknown) => {
      unitFailureCount += 1;
      if (unitFailures.length < MAX_QUOTE_FAILURES) unitFailures.push({ unitIndex, unitId, sourcePath, field, message });
    };
    if (!unit || typeof unit !== "object" || isUnknownArray(unit)) {
      fail("unit", "Knowledge unit must be an object；修复：提供包含 id/type/domain/title/points/evidence 的知识单元。");
      continue;
    }
    if (!nonempty(unit.id)) fail("id", "Knowledge unit id must be nonempty；修复：补充非空知识点ID。");
    else if (ids.has(unit.id)) fail("id", "Knowledge unit ids must be unique；修复：为重复单元使用唯一ID。");
    else ids.add(unit.id);
    if (!knownType(unit.type)) fail("type", "Knowledge unit type must be one of seven types；修复：选择七种知识类型之一。");
    if (!nonempty(unit.domain)) fail("domain", "Knowledge unit domain must be nonempty；修复：补充非空领域。");
    if (!nonempty(unit.title)) fail("title", "Knowledge unit title must be nonempty；修复：补充非空标题。");
    if (unit.typePendingConfirmation !== undefined && typeof unit.typePendingConfirmation !== "boolean") fail("typePendingConfirmation", "Knowledge typePendingConfirmation must be boolean；修复：使用 true/false 或省略该字段。");
    const aliases = unit.aliases === undefined ? [] : unit.aliases;
    if (!isUnknownArray(aliases)) fail("aliases", "Knowledge unit aliases must be a string list；修复：使用字符串数组，无别名时使用 []；null 不可作为缺省值。");
    else for (const [index, alias] of aliases.entries()) if (!nonempty(alias)) fail(`aliases[${index}]`, "Knowledge unit aliases must contain nonempty strings；修复：删除空项或替换为非空别名。");
    if (!isUnknownArray(unit.points) || !unit.points.length) fail("points", "Knowledge unit points must be a nonempty string list；修复：补充至少一条非空知识主张。");
    else for (const [index, point] of unit.points.entries()) if (!nonempty(point)) fail(`points[${index}]`, "Knowledge unit points must contain nonempty strings；修复：补充该条知识主张。");
    if (!isUnknownArray(unit.evidence) || !unit.evidence.length) {
      fail("evidence", "Knowledge unit evidence must be nonempty；修复：补充至少一条本批来源的连续正文原句。");
      continue;
    }
    const groundedEvidence: MaintenanceKnowledgeEvidence[] = [];
    for (const [quoteIndex, evidence] of unit.evidence.entries()) {
      const location = evidenceLocation(unitId, evidence?.sourcePath);
      if (!evidence || typeof evidence !== "object" || isUnknownArray(evidence)) {
        fail(`evidence[${quoteIndex}]`, "Evidence must be an object；修复：提供 sourcePath/sourceRevision/quote。");
        continue;
      }
      const field = (name: string) => `evidence[${quoteIndex}].${name}`;
      let revision: string | undefined;
      try {
        revision = evidenceRevision(evidence.sourceRevision, location);
      } catch {
        fail(field("sourceRevision"), "版本格式非法：sourceRevision must be exactly 64 hex characters or sha256:<64 lowercase hex>；修复：使用 note_read 返回的全文版本。", evidence.sourcePath);
      }
      if (!nonempty(evidence.quote)) {
        failureCount += 1;
        if (failures.length < MAX_QUOTE_FAILURES) failures.push({ unitIndex, unitId, sourcePath: evidence.sourcePath, quoteIndex, quote: evidence.quote });
      }
      if (!nonempty(evidence.sourcePath)) {
        fail(field("sourcePath"), "sourcePath 缺失或为空；修复：指定本批来源路径。", evidence.sourcePath);
        continue;
      }
      const source = sourceByPath.get(evidence.sourcePath);
      if (!source) {
        fail(field("sourcePath"), "sourcePath is outside this batch's sources；修复：重读本批允许的来源。", evidence.sourcePath);
        continue;
      }
      if (revision !== undefined && revision !== source.revision) fail(field("sourceRevision"), "全文版本不匹配：sourceRevision does not match the source's full-file revision；修复：重读该来源并使用全文版本。", evidence.sourcePath);
      if (!nonempty(evidence.quote)) continue;
      const match = findQuote(source, evidence.quote);
      if (!match) {
        failureCount += 1;
        if (failures.length < MAX_QUOTE_FAILURES) failures.push({ unitIndex, unitId, sourcePath: evidence.sourcePath, quoteIndex, quote: evidence.quote });
        continue;
      }
      groundedEvidence.push({ ...evidence, sourceRevision: source.revision, quote: source.content.slice(match.start, match.end), quoteLocation: { ...match, unit: "utf16", submittedQuote: evidence.quote } });
    }
    groundedUnits.push({ ...unit, aliases: isUnknownArray(aliases) ? [...aliases] : [], points: isUnknownArray(unit.points) ? [...unit.points] : [], evidence: groundedEvidence });
  }
  if (failureCount || unitFailureCount) throw quoteFailureError(failures, failureCount, unitFailures, unitFailureCount);
  return groundedUnits;
}

function newPageMetadata(content: string) {
  const parsed = frontmatter(content);
  if (parsed.yaml === null) throw new Error("New knowledge pages require YAML frontmatter.");
  const document = parseDocument(parsed.yaml, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error("New knowledge frontmatter must be an unambiguous YAML mapping.");
  const mapping = document.contents;
  const pair = (name: string) => mapping.items.find((item) => isScalar(item.key) && item.key.value === name);
  const field = (name: string) => pair(name)?.value;
  const plainKey = (name: string) => {
    const item = pair(name);
    return !item || (isScalar(item.key) && !item.key.anchor && !item.key.tag);
  };
  const aliases = field("aliases");
  const validAliases = isSeq(aliases) && !aliases.anchor && !aliases.tag && aliases.items.every((item) => isScalar(item) && !item.anchor && !item.tag && nonempty(item.value));
  return {
    parsed, document, pair, field, plainKey,
    aliases: validAliases && isSeq(aliases) ? aliases.items.map((item) => String(isScalar(item) ? item.value : "")) : undefined,
    aliasesRepairable: plainKey("aliases") && (!pair("aliases") || validAliases) && !pair("别名")
  };
}

function checkedNewPageUnits(content: string, units: readonly MaintenanceKnowledgeUnit[]): readonly string[][] {
  if (!nonempty(content) || !isUnknownArray(units) || !units.length || !units.every((unit) => unit && knownType(unit.type))) throw new Error("New knowledge pages require content and typed knowledge units.");
  return units.map((unit, index) => {
    const aliases = unit.aliases === undefined ? [] : unit.aliases;
    if (!isUnknownArray(aliases) || !aliases.every(nonempty)) throw new Error(`units[${index}] ${evidenceLocation(typeof unit.id === "string" ? unit.id : "<missing>", undefined)}, field=aliases: Knowledge unit aliases must be a string list；修复：使用非空字符串数组，无别名时用 []。`);
    return [...aliases];
  });
}

function targetPageTitle(targetPath: string): string {
  if (!nonempty(targetPath) || /[\r\n]/u.test(targetPath)) throw new Error("New page targetPath must name a Markdown page；修复：提供最终页面路径。");
  const basename = targetPath.split(/[\\/]/u).at(-1)?.replace(/\.md$/iu, "");
  if (!nonempty(basename)) throw new Error("New page targetPath must have a nonempty basename；修复：提供最终页面名称。");
  return basename;
}

function newPageBody(body: string) {
  const maskedComments = body.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\r\n]/g, " "));
  const bodyLines = maskedComments.split(/\r\n|\n|\r/u);
  let fence: { character: string; length: number } | undefined;
  const lines = bodyLines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return "";
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return ""; }
    return line;
  });
  const lineOffsets = [...body.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)].map((line) => line.index);
  const headings = lines.flatMap((line, index) => {
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/u.exec(line);
    return match && nonempty(match[2]) ? [{ index, level: match[1].length, title: match[2], start: lineOffsets[index], end: lineOffsets[index] + bodyLines[index].length }] : [];
  });
  return { bodyLines, lines, headings };
}

/** Fill only deterministic metadata/title gaps; all other content still passes strict validation. */
export function prepareMaintenanceNewPage(content: string, units: readonly MaintenanceKnowledgeUnit[], targetPath: string): string {
  const unitAliases = checkedNewPageUnits(content, units);
  const { parsed, document, pair, aliases, aliasesRepairable } = newPageMetadata(content);
  const title = targetPageTitle(targetPath);
  const combinedAliases = [...(aliases ?? [])];
  const aliasSet = new Set(combinedAliases.map(normalizedAlias));
  for (const alias of unitAliases.flat()) {
    if (!aliasSet.has(normalizedAlias(alias))) {
      combinedAliases.push(alias);
      aliasSet.add(normalizedAlias(alias));
    }
  }
  const aliasesChanged = aliasesRepairable && (aliases === undefined || aliases.length !== combinedAliases.length);
  if (aliasesChanged) document.set("aliases", combinedAliases);
  const pendingChanged = units.some((unit) => unit.typePendingConfirmation === true) && !pair("类型待确认");
  if (pendingChanged) document.set("类型待确认", true);
  const metadataChanged = aliasesChanged || pendingChanged;
  let body = parsed.body;
  const { headings } = newPageBody(body);
  const h1 = headings.filter((heading) => heading.level === 1);
  if (h1.length !== 1 || headings[0] !== h1[0]) throw new Error("New knowledge pages require one H1 before their sections；修复：提供唯一的页面H1，程序只会改正该标题而不删除其他结构。");
  if (h1[0].title !== title) {
    const newline = /\r\n|\n|\r/u.exec(content)?.[0] ?? "\n";
    const originalTitle = body.slice(h1[0].start, h1[0].end).replace(/^ {0,3}#[ \t]+/u, "").replace(/[ \t]+#+[ \t]*$/u, "");
    body = `${body.slice(0, h1[0].start)}# ${title}${newline}${newline}${originalTitle}${body.slice(h1[0].end)}`;
  }
  if (!metadataChanged) return content.slice(0, parsed.bodyStart) + body;
  const newline = /\r\n|\n|\r/u.exec(content)?.[0] ?? "\n";
  const yaml = document.toString().replace(/\r\n|\n|\r/gu, newline);
  return `${content.startsWith("\uFEFF") ? "\uFEFF" : ""}---${newline}${yaml}---${newline}${body}`;
}

/** Validate new pages only; existing-page metadata is deliberately outside this API. */
export function validateMaintenanceNewPage(content: string, units: readonly MaintenanceKnowledgeUnit[], targetPath?: string, titlePolicy?: MaintenanceTitlePolicy): void {
  if (targetPath !== undefined && titlePolicy === MAINTENANCE_SHORT_TITLE_POLICY) assertMaintenanceShortTarget(targetPath);
  const unitAliases = checkedNewPageUnits(content, units);
  const { parsed, pair, field, plainKey, aliases } = newPageMetadata(content);
  const errors: string[] = [];
  const fail = (fieldName: string, message: string) => errors.push(`field=${fieldName}: ${message}`);
  for (const name of ["类型", "aliases", "类型待确认"]) {
    if (!plainKey(name)) fail(`${name}.key`, `New page ${name} field must use a plain YAML key；修复：删除字段名上的 anchor/tag。`);
  }
  const type = field("类型");
  if (!isScalar(type) || type.anchor || type.tag || !knownType(type.value) || type.value !== units[0].type) fail("类型", "New page 类型 must be one of seven types and match its primary unit；修复：使用主知识单元的七类类型。");
  if (!aliases) fail("aliases", "New page aliases must be a standard string list, including [] when empty；修复：显式非法值不可自动覆盖，请改为非空字符串数组。");
  else {
    const pageAliases = new Set(aliases.map(normalizedAlias));
    if (unitAliases.flat().some((alias) => !pageAliases.has(normalizedAlias(alias)))) fail("aliases", "New page aliases must preserve all knowledge unit aliases；修复：补齐本页所有已验证单元的别名。");
  }
  if (pair("别名")) fail("别名", "New page aliases must use only the standard aliases field, not 别名；修复：将别名放入 aliases 字符串数组并删除 别名 字段。");
  const pending = field("类型待确认");
  const invalidPending = pending !== undefined && (!isScalar(pending) || pending.anchor || pending.tag || typeof pending.value !== "boolean");
  const missingRequiredPending = units.some((unit) => unit.typePendingConfirmation) && (!isScalar(pending) || pending.value !== true);
  if (invalidPending || missingRequiredPending) fail("类型待确认", `${invalidPending ? "New page 类型待确认 must be boolean. " : ""}${missingRequiredPending ? "Uncertain knowledge types require 类型待确认: true. " : ""}修复：使用 true/false，存在待确认单元时必须为 true。`);

  // Code and comments cannot supply headings or a readable lead.
  const { bodyLines, lines, headings } = newPageBody(parsed.body);
  const h1 = headings.filter((heading) => heading.level === 1);
  if (h1.length !== 1 || headings[0] !== h1[0]) {
    fail("body.H1", "New knowledge pages require one H1 before their sections；修复：在正文分节前提供唯一的页面H1。");
    throwMaintenanceDiagnostics(errors, "维护新页");
    return;
  }
  if (targetPath !== undefined) {
    try {
      if (h1[0].title !== targetPageTitle(targetPath)) fail("body.H1", "New page H1 must match its final targetPath basename；修复：按最终文件名修正H1，并将原描述性标题保留在导语。");
    } catch {
      fail("targetPath", "New page targetPath must have a nonempty page basename；修复：提供最终页面路径。");
    }
  }
  const firstSection = headings.find((heading) => heading.level > 1);
  const readable = (values: readonly string[]) => values.some((line) => /[\p{L}\p{N}]/u.test(line));
  if (!readable(lines.slice(h1[0].index + 1, firstSection?.index))) fail("body.lead", "New knowledge pages require a nonempty lead after H1；修复：在H1与首个小节之间补充有信息的导语。");
  const sectionLines = bodyLines.map((line) => /^ {0,3}(?:`{3,}|~{3,})/u.test(line) ? "" : line);
  let managementLevel: number | undefined;
  const hasKnowledgeContent = headings.some((heading, index) => {
    if (managementLevel !== undefined && heading.level <= managementLevel) managementLevel = undefined;
    if (heading.level > 1 && isManagementSection(heading.title) && managementLevel === undefined) managementLevel = heading.level;
    return heading.level > 1 && managementLevel === undefined && readable(sectionLines.slice(heading.index + 1, headings[index + 1]?.index));
  });
  if (!hasKnowledgeContent) fail("body.sections", "New knowledge pages require structured content: a section with knowledge content beyond sources/related entries; section titles may be customized；修复：至少补充一个包含知识正文的小节，来源或相关条目不能代替正文。");
  throwMaintenanceDiagnostics(errors, "维护新页");
}
