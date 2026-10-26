import { anchorAt, intersects, locateInstruction } from "./document";
import { resolveInlineRangeCandidates } from "./protocol";
import type { InlineModelCandidate, InlineModelOutput } from "./protocol";
import type { InlineContext, InlineRequest, InlineTarget, TextSpan } from "./types";

export interface InlineCandidate extends InlineModelCandidate { from: number; to: number }

interface Heading {
  from: number;
  to: number;
  level: number;
  title: string;
  parent?: Heading;
  occurrence: number;
  siblings: number;
}

/** A small ATX/fence scanner, not a general Markdown parser. */
function headingsIn(document: string): Heading[] {
  const headings: Heading[] = [], stack: Heading[] = [], siblings = new Map<string, Heading[]>();
  const frontmatter = /^(?:\uFEFF)?---[\t ]*\r?\n[\s\S]*?^(?:---|\.\.\.)[\t ]*\r?$/mu.exec(document);
  const frontmatterTo = frontmatter?.index === 0 ? frontmatter[0].length : 0;
  let fence: { marker: string; length: number } | undefined;
  for (const match of document.matchAll(/[^\n]+/gu)) {
    if (match.index < frontmatterTo) continue;
    const line = match[0].replace(/\r$/u, ""), fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = undefined;
      continue;
    }
    if (fenceMatch && (fenceMatch[1][0] !== "`" || !fenceMatch[2].includes("`"))) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    const headingMatch = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/u.exec(line);
    if (!headingMatch) continue;
    const level = headingMatch[1].length, title = (headingMatch[2] ?? "").replace(/(?:^|[\t ]+)#+[\t ]*$/u, "").trim() || "（空标题）";
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.at(-1), key = JSON.stringify([parent?.from ?? -1, title]);
    const group = siblings.get(key) ?? [];
    const heading: Heading = { from: match.index, to: match.index + match[0].length, level, title, parent, occurrence: group.length + 1, siblings: 1 };
    group.push(heading); siblings.set(key, group); headings.push(heading); stack.push(heading);
  }
  for (const group of siblings.values()) for (const heading of group) heading.siblings = group.length;
  return headings;
}

function headingAt(headings: readonly Heading[], position: number): Heading | undefined {
  for (let index = headings.length - 1; index >= 0; index--) if (headings[index].from <= position) return headings[index];
  return undefined;
}
function headingPath(heading: Heading | undefined): string {
  if (!heading) return "正文";
  const title = heading.title + (heading.siblings > 1 ? `（第${heading.occurrence}处）` : "");
  return heading.parent ? `${headingPath(heading.parent)} › ${title}` : title;
}
export function sectionAt(document: string, position: number): string {
  return headingPath(headingAt(headingsIn(document), position));
}

/** The end is exclusive; heading identity, rather than its name, decides whether a range crosses sections. */
export function sectionForRange(document: string, range: TextSpan): string {
  const headings = headingsIn(document), start = headingAt(headings, range.from), end = headingAt(headings, range.to > range.from ? range.to - 1 : range.from);
  return start === end ? headingPath(start) : `${headingPath(start)} › ${headingPath(end)}`;
}

export function buildInlineCandidates(document: string, context: InlineContext, request: InlineRequest): InlineCandidate[] {
  const result: InlineCandidate[] = [], instruction = locateInstruction(document, request);
  if (!instruction) throw new Error("正文位置已删除，无法判断修改范围。");
  const headings = headingsIn(document), headingStarts = new Set(headings.map(heading => heading.from));
  for (const [segmentIndex, segment] of context.segments.entries()) {
    const text = document.slice(segment.sourceFrom, segment.sourceTo);
    let paragraph: TextSpan | undefined, previousTo: number | undefined;
    const add = ({ from, to }: TextSpan) => {
      if (!document.slice(from, to).trim() || intersects(instruction, { from, to })) return;
      result.push({ id: `p-${result.length}`, kind: "replace", text: document.slice(from, to), label: headingPath(headingAt(headings, from)),
        boundaryGroup: `body-${segmentIndex}`, from, to });
    };
    const flush = () => { if (paragraph) add(paragraph); paragraph = undefined; };
    for (const match of text.matchAll(/[^\n]+/gu)) {
      const from = segment.sourceFrom + match.index, to = from + match[0].length;
      if (!match[0].trim() || previousTo !== undefined && from > previousTo + 1) flush();
      if (match[0].trim()) {
        if (headingStarts.has(from)) { flush(); add({ from, to }); }
        else if (paragraph) paragraph.to = to;
        else paragraph = { from, to };
      }
      previousTo = to;
    }
    flush();
  }
  const nearest = result.filter(c => c.to <= instruction.from && !headingStarts.has(c.from)).at(-1);
  if (nearest) result[result.indexOf(nearest)] = { ...nearest, label: nearest.label + " · 指令前最近一段" };
  result.push({ id: "insert-here", kind: "insert", text: "", label: `${sectionAt(document, instruction.from)} · 在指令位置补写`, from: instruction.to, to: instruction.to });
  if (instruction.to !== document.length) result.push({ id: "insert-end", kind: "insert", text: "", label: "在笔记末尾补写", from: document.length, to: document.length });
  return result;
}
export function proposalTarget(document: string, candidates: readonly InlineCandidate[], output: Extract<InlineModelOutput, { kind: "proposal" }>): InlineTarget {
  if ("startCandidateId" in output) {
    const range = resolveInlineRangeCandidates(candidates, output.startCandidateId, output.endCandidateId);
    for (const [index, candidate] of range.entries()) {
      if (document.slice(candidate.from, candidate.to) !== candidate.text) throw new Error("提案对应的正文已变化。");
      if (index > 0) {
        const previous = range[index - 1];
        if (candidate.from < previous.to) throw new Error("提案候选的正文顺序无效，请重试。");
        if (document.slice(previous.to, candidate.from).trim()) throw new Error("修改范围包含控制文字，请把 @ 指令移到要改的范围外再试。");
      }
    }
    return { ...anchorAt(document, { from: range[0].from, to: range[range.length - 1].to }), kind: "replace" };
  }
  const candidate = candidates.find(c => c.id === output.candidateId);
  if (!candidate) throw new Error("提案目标不存在，请重试。");
  let from = candidate.from, to = candidate.to;
  if (candidate.kind === "replace") {
    const offset = candidate.text.indexOf(output.original);
    if (!output.original || offset < 0 || candidate.text.indexOf(output.original, offset + 1) >= 0) throw new Error("提案原文无法唯一定位，请重新说明范围。");
    from += offset; to = from + output.original.length;
    if (document.slice(from, to) !== output.original) throw new Error("提案对应的正文已变化。");
  } else if (output.original !== "") throw new Error("插入提案不能包含替换原文。");
  return { ...anchorAt(document, { from, to }), kind: candidate.kind };
}
