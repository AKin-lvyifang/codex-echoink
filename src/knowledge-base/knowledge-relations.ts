import * as path from "node:path";

/** Text-authored hints, never programmatic claims that two facts agree. */
export interface KnowledgeApplicability {
  subjects?: string[];
  applicableTime?: string;
  documentKind?: string;
}

export interface KnowledgeLink {
  original: string;
  target: string;
  anchor?: string;
  line: number;
  context: string;
}

export interface KnowledgeRelationTarget {
  vaultRelativePath: string;
  title: string;
  contentRevision: string;
}

export interface KnowledgeRelation {
  direction: "outgoing" | "incoming";
  status: "available" | "ambiguous" | "unresolved";
  relation: "link";
  original: string;
  anchor?: string;
  /** Anchor is a navigation hint; the file revision is the read authority. */
  anchorStatus?: "not_located";
  source: KnowledgeRelationTarget & { line: number; context: string };
  target?: KnowledgeRelationTarget;
  candidates?: KnowledgeRelationTarget[];
}

export interface KnowledgeRelationPage {
  vaultRelativePath: string;
  contentRevision: string;
  total: number;
  returned: number;
  remaining: number;
  hasMore: boolean;
  exhausted: boolean;
  continuationCursor?: string;
  items: KnowledgeRelation[];
}

export type KnowledgeLinkResolver = (linkpath: string, sourcePath: string) => string | null | undefined;

export interface KnowledgeBodyLinkSpan {
  start: number;
  end: number;
  target: string;
  text: string;
  kind: "wiki" | "markdown";
  embed: boolean;
}

/** Offsets remain indices into the original, including CRLF and surrogate pairs. */
export function knowledgeBodyMask(content: string, excludeLinks = true): string {
  const chars = content.split("");
  if (content.startsWith("\uFEFF")) chars[0] = " ";
  const hide = (start: number, end: number) => {
    for (let i = start; i < end; i += 1) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  };
  let offset = content.startsWith("\uFEFF") ? 1 : 0;
  const opening = content.slice(offset).match(/^---[ \t]*(?:\r\n|\n|\r)/u);
  if (opening) {
    const rest = offset + opening[0].length;
    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gmu;
    closing.lastIndex = rest;
    const match = closing.exec(content);
    const end = match ? match.index + match[0].length : content.length;
    hide(0, end); offset = end;
  }
  while (offset < content.length) {
    const atLineStart = offset === 0 || (offset === 1 && content[0] === "\uFEFF") || /[\r\n]/u.test(content[offset - 1]);
    if (atLineStart) {
      const lineEnd = content.slice(offset).search(/[\r\n]/u);
      const end = lineEnd < 0 ? content.length : offset + lineEnd;
      const line = content.slice(offset, end);
      const fence = line.match(/^ {0,3}(?:>[ \t]?)* {0,3}(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u);
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        const closing = new RegExp(`^ {0,3}(?:>[ \\t]?)* {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|\\r|$)`, "gm");
        closing.lastIndex = end;
        const match = closing.exec(content);
        const stop = match ? match.index + match[0].length : content.length;
        hide(offset, stop); offset = stop; continue;
      }
      if (/^(?: {4}|\t)/u.test(line)) { hide(offset, end); offset = end; continue; }
    }
    if (content.startsWith("<!--", offset)) {
      const close = content.indexOf("-->", offset + 4);
      const stop = close < 0 ? content.length : close + 3;
      hide(offset, stop); offset = stop; continue;
    }
    if (content.startsWith("%%", offset) && !escapedAt(content, offset)) {
      const close = content.indexOf("%%", offset + 2);
      const stop = close < 0 ? content.length : close + 2;
      hide(offset, stop); offset = stop; continue;
    }
    if (content[offset] === "`" && !escapedAt(content, offset)) {
      const run = content.slice(offset).match(/^`+/u)![0];
      let close = content.indexOf(run, offset + run.length);
      while (close >= 0 && (content[close - 1] === "`" || content[close + run.length] === "`")) close = content.indexOf(run, close + run.length);
      if (close >= 0) { hide(offset, close + run.length); offset = close + run.length; continue; }
    }
    offset += 1;
  }
  const base = chars.join("");
  if (excludeLinks) for (const span of knowledgeBodyLinkSpans(content, base)) hide(span.start, span.end);
  // A reference definition is syntax, not prose (including its label).
  if (excludeLinks) for (const match of base.matchAll(/^ {0,3}\[[^\]\r\n]+\]:[^\r\n]*/gmu)) hide(match.index, match.index + match[0].length);
  return chars.join("");
}

/** Includes full syntax so existing links can be protected without reserializing them. */
export function knowledgeBodyLinkSpans(content: string, bodyMask = knowledgeBodyMask(content, false)): KnowledgeBodyLinkSpan[] {
  const spans: KnowledgeBodyLinkSpan[] = [];
  const definitions = new Map<string, string>();
  const definitionStarts = new Set<number>();
  for (const match of bodyMask.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:\s*(?:<([^>]+)>|(\S+))/gmu)) {
    definitions.set(match[1].trim().toLowerCase(), match[2] ?? match[3]);
    definitionStarts.add(match.index + match[0].indexOf("["));
  }
  for (let i = 0; i < bodyMask.length; i += 1) {
    if (bodyMask[i] !== "[" || escapedAt(content, i)) continue;
    if (definitionStarts.has(i)) continue;
    const start = i > 0 && content[i - 1] === "!" && !escapedAt(content, i - 1) ? i - 1 : i;
    if (bodyMask[i + 1] === "[") {
      const close = bodyMask.indexOf("]]", i + 2);
      if (close < 0) continue;
      const inside = content.slice(i + 2, close);
      if (/[\r\n]/u.test(inside)) continue;
      const pipe = inside.indexOf("|");
      const target = pipe < 0 ? inside : inside.slice(0, pipe);
      spans.push({ start, end: close + 2, target, text: pipe < 0 ? target : inside.slice(pipe + 1), kind: "wiki", embed: start !== i });
      i = close + 1; continue;
    }
    let close = i + 1, depth = 1;
    for (; close < bodyMask.length; close += 1) {
      if (escapedAt(content, close)) continue;
      if (bodyMask[close] === "[") depth += 1;
      if (bodyMask[close] === "]") { depth -= 1; if (depth === 0) break; }
    }
    if (depth || close >= bodyMask.length) continue;
    let end = close + 1, target: string | undefined;
    if (bodyMask[end] === "(") {
      let cursor = end + 1, parens = 1;
      const targetStart = cursor;
      for (; cursor < bodyMask.length; cursor += 1) {
        if (escapedAt(content, cursor)) continue;
        if (bodyMask[cursor] === "(") parens += 1;
        if (bodyMask[cursor] === ")") { parens -= 1; if (parens === 0) break; }
      }
      if (!parens) {
        const inside = content.slice(targetStart, cursor).trim();
        target = inside.startsWith("<") ? inside.slice(1, inside.indexOf(">")) : inside.match(/^(?:\\.|[^\s])*/u)?.[0];
        end = cursor + 1;
      }
    } else if (bodyMask[end] === "[") {
      const labelEnd = bodyMask.indexOf("]", end + 1);
      if (labelEnd >= 0) { target = definitions.get((content.slice(end + 1, labelEnd) || content.slice(i + 1, close)).trim().toLowerCase()) ?? ""; end = labelEnd + 1; }
    } else target = definitions.get(content.slice(i + 1, close).trim().toLowerCase());
    if (target !== undefined) { spans.push({ start, end, target, text: content.slice(i + 1, close), kind: "markdown", embed: start !== i }); i = end - 1; }
  }
  return spans;
}

function escapedAt(content: string, offset: number): boolean {
  let count = 0;
  while (offset > 0 && content[--offset] === "\\") count += 1;
  return count % 2 === 1;
}

/** Keep source line numbers while removing comments, fenced and inline examples. */
function knowledgeVisibleLines(content: string): string[] {
  let fence: { marker: string; length: number } | null = null;
  let comment = false;
  return content.split(/\r\n|\n|\r/u).map((rawLine) => {
    const fenced = rawLine.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (fenced && fenced[1][0] === fence.marker && fenced[1].length >= fence.length && !fenced[2].trim()) fence = null;
      return "";
    }
    if (fenced) { fence = { marker: fenced[1][0], length: fenced[1].length }; return ""; }
    let line = rawLine.replace(/<!--.*?-->/gu, "");
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) return "";
      line = line.slice(end + 3); comment = false;
    }
    const start = line.indexOf("<!--");
    if (start >= 0) { line = line.slice(0, start); comment = true; }
    return line.replace(/(`+).*?\1/gu, "");
  });
}

export function extractKnowledgeLinks(content: string): KnowledgeLink[] {
  const result: KnowledgeLink[] = [];
  knowledgeVisibleLines(content).forEach((line, index) => {
    const matches: { offset: number; original: string; rawTarget: string }[] = [];
    for (const match of line.matchAll(/!?\[\[([^\]\n]+)\]\]/gu)) matches.push({ offset: match.index, original: match[0], rawTarget: match[1].split("|")[0] });
    for (const match of line.matchAll(/!?\[[^\]\n]*\]\(/gu)) {
      const start = match.index + match[0].length;
      let end = start, depth = 1, rawTarget = "", angled = false, targetDone = false;
      for (; end < line.length; end += 1) {
        const char = line[end];
        if (char === "\\" && end + 1 < line.length) { if (!targetDone) rawTarget += line[++end]; continue; }
        if (end === start && char === "<") { angled = true; continue; }
        if (angled) { if (char === ">") { angled = false; targetDone = true; } else rawTarget += char; continue; }
        if (char === "(" && !targetDone) depth += 1;
        if (char === ")") { depth -= 1; if (!depth) break; }
        if (/\s/u.test(char) && depth === 1) targetDone = true;
        if (!targetDone) rawTarget += char;
      }
      if (depth === 0) matches.push({ offset: match.index, original: line.slice(match.index, end + 1), rawTarget });
    }
    for (const match of matches.sort((left, right) => left.offset - right.offset)) {
      const rawTarget = match.rawTarget.trim();
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(rawTarget)) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(rawTarget); } catch { decoded = rawTarget; }
      const hash = decoded.indexOf("#");
      const target = (hash < 0 ? decoded : decoded.slice(0, hash)).replace(/\\/gu, "/");
      const anchor = hash < 0 ? undefined : decoded.slice(hash + 1);
      result.push({ original: match.original, target, ...(anchor ? { anchor } : {}), line: index + 1, context: line.trim().slice(0, 400) });
    }
  });
  return result;
}

export function extractKnowledgeApplicability(content: string): KnowledgeApplicability {
  const result: KnowledgeApplicability = {};
  for (const line of knowledgeVisibleLines(content)) {
    const field = line.match(/^\s*(?:[-*]\s*)?(对象|主题|subjects|适用时间|适用条件|applicableTime|资料性质|documentKind)\s*[：:]\s*(.+)$/u);
    if (!field) continue;
    const value = field[2].trim().slice(0, 500);
    if (["对象", "主题", "subjects"].includes(field[1])) result.subjects = [value];
    else if (["资料性质", "documentKind"].includes(field[1])) result.documentKind = value;
    else result.applicableTime = value;
  }
  return result;
}

/** Only indexed, authorized paths enter candidate results. Host lookups never widen scope. */
export function resolveKnowledgeLink(input: {
  link: KnowledgeLink;
  sourcePath: string;
  paths: readonly string[];
  /** Explicit H1 titles and YAML aliases from the same authorized index. */
  names?: Readonly<Record<string, readonly string[]>>;
  resolveAlias: (value: string) => string;
  hostResolver?: KnowledgeLinkResolver;
}): string[] {
  const { link, sourcePath, paths } = input;
  if (!link.target) return [sourcePath];
  const target = link.target.replace(/^\//u, "");
  const withExtension = (value: string) => path.posix.extname(value) ? [value] : [value + ".md", value + ".markdown", value];
  const exact = withExtension(input.resolveAlias(target));
  const relative = withExtension(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target)));
  const explicit = target.startsWith(".") ? relative : target.includes("/") ? [...exact, ...relative] : [];
  for (const candidate of explicit) if (paths.includes(candidate)) return [candidate];
  if (input.names && !target.includes("/")) {
    const name = target.replace(/\.(?:md|markdown)$/iu, "").toLowerCase();
    const matches = paths.filter((value) => path.posix.basename(value, path.posix.extname(value)).toLowerCase() === name
      || input.names?.[value]?.some((candidate) => candidate.toLowerCase() === name));
    if (matches.length) return matches.sort();
  }
  let host: string | null | undefined;
  try { host = input.hostResolver?.(target, sourcePath); } catch { /* Local hint unavailable. */ }
  if (host && paths.includes(host)) return [host];
  const named = paths.filter((value) => withExtension(target).includes(path.posix.basename(value)));
  if (named.length > 1) return named.sort();
  if (named.length === 1) return named;
  return [];
}
