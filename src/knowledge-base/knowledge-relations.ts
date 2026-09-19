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
  let host: string | null | undefined;
  try { host = input.hostResolver?.(target, sourcePath); } catch { /* Local hint unavailable. */ }
  if (host && paths.includes(host)) return [host];
  const named = paths.filter((value) => withExtension(target).includes(path.posix.basename(value)));
  if (named.length > 1) return named.sort();
  if (named.length === 1) return named;
  return [];
}
