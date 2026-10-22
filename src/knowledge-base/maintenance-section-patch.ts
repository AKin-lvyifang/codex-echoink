import { sha256Hex } from "../utils/sha256";
import type {
  MaintenanceSectionPatch,
  MaintenanceSectionRegion,
  MaintenanceSectionSnapshot
} from "./maintenance-p1-contract";

export type MaintenanceSectionPatchErrorCode =
  | "STALE_SNAPSHOT"
  | "INVALID_SNAPSHOT"
  | "UNKNOWN_REGION"
  | "DUPLICATE_REGION_PATCH"
  | "INVALID_PATCH"
  | "BOUNDARY_CHANGE"
  | "WHOLE_PAGE_REPLACE";

/** The caller can re-list these current IDs instead of guessing a heading. */
export class MaintenanceSectionPatchError extends Error {
  readonly name = "MaintenanceSectionPatchError";

  constructor(
    readonly code: MaintenanceSectionPatchErrorCode,
    message: string,
    readonly currentSnapshot: MaintenanceSectionSnapshot
  ) {
    super(`${message} 请重新列出区域并使用当前编号：${JSON.stringify(currentSnapshot.regions.map(({ id, title, kind }) => ({ id, title, kind })))}`);
  }
}

interface MarkdownLine {
  start: number;
  end: number;
  text: string;
}

interface Heading {
  start: number;
  contentStart: number;
  title: string;
  level: number;
  standalone: boolean;
}

/**
 * Every heading ends at the next heading, including nested headings. Regions
 * never contain a child region, so replacing a parent cannot erase its children.
 * The document's sole leading H1 keeps its heading bytes and exposes its body as
 * 导语; any text before that H1 remains a separate 前言 region.
 */
export function createMaintenanceSectionSnapshot(markdown: string, newSections: readonly string[] = []): MaintenanceSectionSnapshot {
  const revision = `sha256:${sha256Hex(markdown)}`;
  const bodyStart = frontmatterEnd(markdown);
  const headings = readHeadings(markdown, bodyStart);
  const hasDocumentTitle = headings[0]?.level === 1 && headings[0].standalone && headings.filter(heading => heading.level === 1).length === 1;
  const regions: MaintenanceSectionRegion[] = [{
    id: regionId(revision, 0),
    title: hasDocumentTitle ? "前言" : "导语",
    kind: "introduction",
    start: bodyStart,
    contentStart: bodyStart,
    end: headings[0]?.start ?? markdown.length
  }];
  headings.forEach((heading, index) => {
    const introduction = hasDocumentTitle && index === 0;
    regions.push({
      id: regionId(revision, index + 1),
      title: introduction ? "导语" : heading.title,
      kind: introduction ? "introduction" : regionKind(heading.title),
      start: heading.start,
      contentStart: heading.contentStart,
      end: headings[index + 1]?.start ?? markdown.length
    });
  });
  if (!Array.isArray(newSections) || newSections.length > 20) throw new Error("newSections须为最多20个新H2标题的数组。");
  const titles = new Set(regions.map(region => region.title.normalize("NFKC").toLowerCase()));
  const insertion = regions.find(region => region.kind === "sources" || region.kind === "related" || isMaintenanceQuoteSectionTitle(region.title))?.start ?? markdown.length;
  for (const [index, title] of newSections.entries()) {
    if (isMaintenanceQuoteSectionTitle(title)) throw new Error("不生成关键原句小节；原句只用于内部核对。");
    if (typeof title !== "string" || !title.trim() || title !== title.trim() || title.length > 120 || /[\r\n#`*_[\]<>]/u.test(title) || regionKind(title) !== "section" || titles.has(title.normalize("NFKC").toLowerCase())) throw new Error(`newSections[${index}]须是尚不存在的普通语义H2标题；已有对应小节用真实编号，来源/相关条目由程序管理。`);
    titles.add(title.normalize("NFKC").toLowerCase());
    regions.push({ id: `section:${revision.slice(7)}:new:${index + 1}`, title, kind: "new-section", start: insertion, contentStart: insertion, end: insertion });
  }
  return { revision, regions, ...(newSections.length ? { newSections: [...newSections] } : {}) };
}

/**
 * All patches address the same original snapshot. Duplicate targets are rejected
 * rather than silently overwriting one another. Append preserves the old content
 * verbatim and adds a paragraph separator when needed. No whole-page fallback is
 * available: a document without headings supports append, but not replace.
 */
export function applyMaintenanceSectionPatches(
  markdown: string,
  snapshot: MaintenanceSectionSnapshot,
  patches: readonly MaintenanceSectionPatch[]
): string {
  const plain = createMaintenanceSectionSnapshot(markdown);
  if (snapshot?.revision !== plain.revision) throw new MaintenanceSectionPatchError("STALE_SNAPSHOT", "文档已变化，区域快照已过期，未应用修改。", plain);
  const current = createMaintenanceSectionSnapshot(markdown, snapshot.newSections ?? []);
  const fail: (code: MaintenanceSectionPatchErrorCode, message: string) => never = (code, message) => {
    throw new MaintenanceSectionPatchError(code, message, current);
  };
  if (snapshot?.revision !== current.revision) fail("STALE_SNAPSHOT", "文档已变化，区域快照已过期，未应用修改。");
  if (!sameSnapshot(snapshot, current)) fail("INVALID_SNAPSHOT", "区域快照的目录或边界不匹配，未应用修改。");
  if (!Array.isArray(patches)) fail("INVALID_PATCH", "分区补丁必须是数组，未应用修改。");

  const byId = new Map(current.regions.map(region => [region.id, region]));
  const replacements = new Map<string, string>();
  const additions = new Map<string, string>();
  const lineEnding = markdown.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  for (const patch of patches) {
    if (!patch || typeof patch.regionId !== "string" || typeof patch.content !== "string"
      || (patch.operation !== "append" && patch.operation !== "replace")) {
      fail("INVALID_PATCH", "分区补丁需要有效编号、append/replace 操作和正文，未应用修改。");
    }
    const region = byId.get(patch.regionId);
    if (!region) fail("UNKNOWN_REGION", `区域编号 ${JSON.stringify(patch.regionId)} 不属于当前快照，未应用修改。`);
    if (region.kind !== "new-section" && maintenanceQuoteSections(markdown).some(section => region.start >= section.start && region.start < section.end)) fail("INVALID_PATCH", "已有关键原句小节为用户内容，须逐字保留，不能追加或替换。");
    if (replacements.has(region.id) || additions.has(region.id)) fail("DUPLICATE_REGION_PATCH", "同一区域不能在一批补丁中修改两次，未应用修改。");
    if (patch.operation === "replace" && current.regions.filter(region => region.kind !== "new-section").length === 1) {
      fail("WHOLE_PAGE_REPLACE", "无标题文档不能整页替换，请先明确分区；本次未应用修改。");
    }
    // Reject even code-like/indented variants conservatively. Region editing is
    // content maintenance, not a way to create, remove, or rename headings.
    if (hasBoundarySyntax(patch.content) || /^\s*(?:\*\*[^*]+\*\*|__[^_]+__)\s*[:：]?\s*$/mu.test(patch.content)) {
      fail("BOUNDARY_CHANGE", "补丁正文不能塞标题、加粗伪标题或代码围栏；缺少语义小节须在plan.newSections声明，再用sections给出的新编号。");
    }
    const fragment = normalizeMaintenanceFragment(patch.content, lineEnding);
    if (region.kind === "new-section") {
      if (patch.operation !== "append" || !fragment) fail("INVALID_PATCH", "新H2虚拟区域只接受非空append正文，由程序生成标题。");
      additions.set(region.id, fragment);
      continue;
    }
    const previous = markdown.slice(region.contentStart, region.end);
    let content = patch.operation === "replace" ? fragment : appendContent(previous, fragment, lineEnding);
    if (content && patch.operation === "replace" && region.start < region.contentStart) {
      const heading = markdown.slice(region.start, region.contentStart);
      content = lineEnding.repeat(/[\r\n]$/u.test(heading) ? 1 : 2) + content;
    } else if (content && region.contentStart > 0 && !(region.contentStart === 1 && markdown.startsWith("\uFEFF"))
      && !/[\r\n]$/u.test(markdown.slice(0, region.contentStart))) {
      content = lineEnding + content;
    }
    if (content && region.end < markdown.length) {
      const next = current.regions.find(candidate => candidate.start === region.end && candidate.start < candidate.contentStart);
      const nextHeading = next && markdown.slice(next.start, next.contentStart);
      // Setext headings can absorb the preceding paragraph without a blank line.
      const requiredEndings = nextHeading ? 2 : 1;
      content = content.replace(/(?:\r\n|\n|\r)+$/u, "") + lineEnding.repeat(requiredEndings);
    }
    replacements.set(region.id, content);
  }

  let result = markdown;
  for (const region of [...current.regions].filter(region => region.kind !== "new-section").reverse()) {
    const content = replacements.get(region.id);
    if (content !== undefined) result = result.slice(0, region.contentStart) + content + result.slice(region.end);
  }
  const insertedTitles = new Set<string>();
  if (additions.size) {
    const at = createMaintenanceSectionSnapshot(result).regions.find(region => region.kind === "sources" || region.kind === "related" || isMaintenanceQuoteSectionTitle(region.title))?.start ?? result.length;
    const block = current.regions.filter(region => additions.has(region.id)).map(region => { insertedTitles.add(region.title); return `## ${region.title}${lineEnding}${lineEnding}${additions.get(region.id)}`; }).join(lineEnding.repeat(2));
    result = appendMaintenanceBlock(result.slice(0, at), block + lineEnding.repeat(2) + result.slice(at), lineEnding);
  }
  // Also catch context changes, e.g. an unclosed HTML comment hiding an existing
  // heading, or Setext syntax spanning a content/heading boundary.
  const after = createMaintenanceSectionSnapshot(result);
  assertMaintenanceQuoteSectionsPreserved(markdown, result);
  const existing = current.regions.filter(region => region.kind !== "new-section"), updatedExisting = after.regions.filter(region => !insertedTitles.has(region.title));
  if (after.regions.length !== existing.length + additions.size || updatedExisting.length !== existing.length || existing.some((region, index) => {
    const updated = updatedExisting[index];
    const heading = markdown.slice(region.start, region.contentStart);
    const updatedHeading = result.slice(updated.start, updated.contentStart);
    const insertedFirstLineEnding = region.contentStart === markdown.length && heading && !/[\r\n]$/u.test(heading)
      && updatedHeading === heading + lineEnding;
    return region.title !== updated.title || region.kind !== updated.kind
      || (heading !== updatedHeading && !insertedFirstLineEnding);
  })) fail("BOUNDARY_CHANGE", "补丁会改变已有标题边界，未应用修改。");
  return result;
}

export function isMaintenanceQuoteSectionTitle(title: string): boolean {
  return typeof title === "string" && title.normalize("NFKC").replace(/[\s*_`\[\]：:]/gu, "") === "关键原句";
}
function maintenanceQuoteSections(markdown: string): { start: number; end: number; bytes: string }[] {
  const headings = readHeadings(markdown, frontmatterEnd(markdown));
  return headings.flatMap((heading, index) => {
    if (!isMaintenanceQuoteSectionTitle(heading.title)) return [];
    const end = headings.slice(index + 1).find(next => next.level <= heading.level)?.start ?? markdown.length;
    return [{ start: heading.start, end, bytes: markdown.slice(heading.start, end) }];
  });
}
/** No inference about authorship: every existing protected section is retained verbatim. */
export function assertMaintenanceQuoteSectionsPreserved(before: string | undefined, after: string): void {
  const previous = maintenanceQuoteSections(before ?? ""), next = maintenanceQuoteSections(after);
  if (previous.length !== next.length || previous.some((section, index) => section.bytes !== next[index].bytes)) throw new Error("不得生成或修改关键原句小节；已有用户小节须逐字保留，原句仅供内部核对。");
}

/** Insert new managed sections before a retained quotation section, never after its EOF bytes. */
export function appendMaintenanceManagedBlock(markdown: string, block: string, eol: string): string {
  const at = maintenanceQuoteSections(markdown)[0]?.start ?? markdown.length;
  return appendMaintenanceBlock(markdown.slice(0, at), block + (at < markdown.length ? eol : ""), eol) + markdown.slice(at);
}

/** Only newly supplied prose is normalized; the page's untouched text is never compressed. */
export function normalizeMaintenanceFragment(content: string, eol = "\n"): string {
  return content.replace(/\r\n|\r|\n/gu, "\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/gu, "").replace(/\n(?:[ \t]*\n){2,}/gu, "\n\n").replace(/\n/gu, eol);
}

/** Appending a managed block must not trim an unselected user's trailing bytes. */
export function appendMaintenanceBlock(prefix: string, block: string, eol = "\n"): string {
  return terminateContent(prefix,eol,2) + block;
}

function regionId(revision: string, index: number): string {
  return `section:${revision.slice("sha256:".length)}:${index + 1}`;
}

function regionKind(title: string): MaintenanceSectionRegion["kind"] {
  if (/^(?:来源|资料来源|参考来源|参考资料|参考文献|sources?|references?)$/iu.test(title)) return "sources";
  if (/^(?:相关条目|相关页面|相关笔记|related(?: entries| pages| notes)?)$/iu.test(title)) return "related";
  return "section";
}

function sameSnapshot(left: MaintenanceSectionSnapshot, right: MaintenanceSectionSnapshot): boolean {
  return Array.isArray(left.regions) && left.regions.length === right.regions.length
    && left.regions.every((region, index) => {
      const expected = right.regions[index];
      return region?.id === expected.id && region.title === expected.title && region.kind === expected.kind
        && region.start === expected.start && region.contentStart === expected.contentStart && region.end === expected.end;
    });
}

function appendContent(previous: string, addition: string, lineEnding: string): string {
  if (!addition) return previous;
  if (!previous) return addition;
  return previous.replace(/(?:\r\n|\n|\r)+$/u, "") + lineEnding.repeat(2) + addition;
}

function hasBoundarySyntax(content: string): boolean {
  return content.split(/\r\n|\n|\r/u).some(line => {
    let text = line;
    let prefix: RegExpMatchArray | null;
    // Conservatively include heading/fence markers inside quotes and lists.
    while ((prefix = text.match(/^[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/u))) text = text.slice(prefix[0].length);
    return /^[ \t]*(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|(?:=+|-+)[ \t]*$)/u.test(text);
  });
}

function terminateContent(content: string, lineEnding: string, count: number): string {
  const trailing = content.match(/(?:\r\n|\n|\r)+$/u)?.[0] ?? "";
  const existing = trailing.match(/\r\n|\n|\r/gu)?.length ?? 0;
  return content + lineEnding.repeat(Math.max(0, count - existing));
}

function linesOf(markdown: string, start = 0): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const ending = /\r\n|\n|\r/gu;
  ending.lastIndex = start;
  let cursor = start;
  let match: RegExpExecArray | null;
  while ((match = ending.exec(markdown))) {
    lines.push({ start: cursor, end: ending.lastIndex, text: markdown.slice(cursor, match.index) });
    cursor = ending.lastIndex;
  }
  if (cursor < markdown.length) lines.push({ start: cursor, end: markdown.length, text: markdown.slice(cursor) });
  return lines;
}

function frontmatterEnd(markdown: string): number {
  const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
  const lines = linesOf(markdown, bom);
  if (!/^---[ \t]*$/u.test(lines[0]?.text ?? "")) return bom;
  const closing = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(line.text));
  return closing < 0 ? bom : lines[closing].end;
}

const HTML_BLOCK_TAG = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$)/iu;

/** Line-based Markdown block scanning; offsets always refer to the raw string. */
function readHeadings(markdown: string, bodyStart: number): Heading[] {
  const lines = linesOf(markdown, bodyStart);
  const headings: Heading[] = [];
  let paragraphStart: number | undefined;
  let fence: { marker: string; length: number; quoteDepth: number; listIndent: number } | undefined;
  let htmlEnd: RegExp | "blank" | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let text = line.text;
    let quoteDepth = 0;
    let quotePrefix: RegExpMatchArray | null;
    while ((quotePrefix = text.match(/^ {0,3}>[ \t]?/u))) {
      quoteDepth++;
      text = text.slice(quotePrefix[0].length);
    }
    if (fence && (quoteDepth < fence.quoteDepth
      || (fence.listIndent > 0 && text.trim() && !text.startsWith(" ".repeat(fence.listIndent))))) fence = undefined;
    if (fence) {
      const closing = text.match(/^ {0,3}(`+|~+)[ \t]*$/u);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (htmlEnd) {
      if (htmlEnd === "blank" ? !text.trim() : htmlEnd.test(text)) htmlEnd = undefined;
      paragraphStart = undefined;
      continue;
    }

    const listPrefix = text.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u);
    const fenceText = listPrefix ? text.slice(listPrefix[0].length) : text;
    const opening = fenceText.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
      fence = { marker: opening[1][0], length: opening[1].length, quoteDepth, listIndent: listPrefix?.[0].length ?? 0 };
      paragraphStart = undefined;
      continue;
    }
    if (/^ {0,3}<!--/u.test(text)) htmlEnd = /-->/u;
    else if (/^ {0,3}<\?/u.test(text)) htmlEnd = /\?>/u;
    else if (/^ {0,3}<!\[CDATA\[/u.test(text)) htmlEnd = /\]\]>/u;
    else if (/^ {0,3}<![A-Z]/u.test(text)) htmlEnd = />/u;
    else {
      const rawHtml = text.match(/^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/iu);
      if (rawHtml) htmlEnd = new RegExp(`</${rawHtml[1]}\\s*>`, "iu");
      else if (HTML_BLOCK_TAG.test(text)) htmlEnd = "blank";
    }
    if (htmlEnd) {
      if (htmlEnd !== "blank" && htmlEnd.test(text)) htmlEnd = undefined;
      paragraphStart = undefined;
      continue;
    }
    if (!text.trim()) {
      paragraphStart = undefined;
      continue;
    }
    if (/^(?: {4}| {0,3}\t)/u.test(text)) {
      if (paragraphStart === undefined) continue;
      // An indented continuation cannot itself start a heading.
      continue;
    }
    const atx = (listPrefix ? text.slice(listPrefix[0].length) : text).match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/u);
    if (atx) {
      headings.push({ start: line.start, contentStart: line.end, title: headingTitle((atx[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/u, "")), level: atx[1].length,
        standalone: quoteDepth === 0 && !listPrefix });
      paragraphStart = undefined;
      continue;
    }
    const setext = text.match(/^ {0,3}(=+|-+)[ \t]*$/u);
    if (setext && paragraphStart !== undefined) {
      headings.push({ start: lines[paragraphStart].start, contentStart: line.end,
        title: headingTitle(lines.slice(paragraphStart, index).map(part => part.text.replace(/^(?: {0,3}>[ \t]?)+/u, "").trim()).join(" ")),
        level: setext[1][0] === "=" ? 1 : 2, standalone: !/^ {0,3}>/u.test(lines[paragraphStart].text) });
      paragraphStart = undefined;
      continue;
    }
    if (setext || listPrefix || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(text)) {
      paragraphStart = undefined;
      continue;
    }
    paragraphStart ??= index;
  }
  return headings;
}

function headingTitle(text: string): string {
  return text.trim() || "（空标题）";
}
