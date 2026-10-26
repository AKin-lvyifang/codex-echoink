import { anchorAt, intersects, locateInstruction } from "./document";
import type { InlineModelCandidate, InlineModelOutput } from "./protocol";
import type { InlineContext, InlineRequest, InlineTarget } from "./types";

export interface InlineCandidate extends InlineModelCandidate { from: number; to: number }
export function sectionAt(document: string, position: number): string {
  let section = "正文";
  for (const match of document.slice(0, position).matchAll(/^#{1,6}\s+(.+)$/gmu)) section = match[1].trim();
  return section;
}
export function buildInlineCandidates(document: string, context: InlineContext, request: InlineRequest): InlineCandidate[] {
  const result: InlineCandidate[] = [], instruction = locateInstruction(document, request);
  if (!instruction) throw new Error("正文位置已删除，无法判断修改范围。");
  for (const segment of context.segments) {
    const text = document.slice(segment.sourceFrom, segment.sourceTo);
    const pattern = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/gu;
    for (const match of text.matchAll(pattern)) {
      const from = segment.sourceFrom + match.index, to = from + match[0].length;
      if (!match[0].trim() || intersects(instruction, { from, to })) continue;
      result.push({ id: `p-${result.length}`, kind: "replace", text: document.slice(from, to), label: sectionAt(document, from), from, to });
    }
  }
  const nearest = result.filter(c => c.to <= instruction.from && !/^#{1,6}\s/u.test(c.text)).at(-1);
  if (nearest) result[result.indexOf(nearest)] = { ...nearest, label: nearest.label + " · 指令前最近一段" };
  result.push({ id: "insert-here", kind: "insert", text: "", label: `${sectionAt(document, instruction.from)} · 在指令位置补写`, from: instruction.to, to: instruction.to });
  if (instruction.to !== document.length) result.push({ id: "insert-end", kind: "insert", text: "", label: "在笔记末尾补写", from: document.length, to: document.length });
  return result;
}
export function proposalTarget(document: string, candidates: readonly InlineCandidate[], output: Extract<InlineModelOutput, { kind: "proposal" }>): InlineTarget {
  const candidate = candidates.find(c => c.id === output.candidateId);
  if (!candidate) throw new Error("提案目标不存在，请重试。");
  let from = candidate.from, to = candidate.to;
  if (candidate.kind === "replace") {
    const offset = candidate.text.indexOf(output.original);
    if (!output.original || offset < 0 || candidate.text.indexOf(output.original, offset + 1) >= 0) throw new Error("提案原文无法唯一定位，请重新说明范围。");
    from += offset; to = from + output.original.length;
    if (document.slice(from, to) !== output.original) throw new Error("提案对应的正文已变化。");
  }
  return { ...anchorAt(document, { from, to }), kind: candidate.kind };
}
