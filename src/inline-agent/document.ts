import { ChangeSet, Text, type ChangeDesc } from "@codemirror/state";
import type { InlineChange, InlineContext, InlineRequest, SourceAnchor, TextSpan } from "./types";

export const markerFor = (id: string): string => `%%echoink:${id}%%`;
export const markerPattern = (): RegExp => /%%echoink:([a-zA-Z0-9-]+)%%/gu;
export function anchorAt(text: string, span: TextSpan): SourceAnchor {
  if (!Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to) || span.from < 0 || span.to < span.from || span.to > text.length) throw new Error("正文范围无效。");
  return { ...span, text: text.slice(span.from, span.to), before: text.slice(Math.max(0, span.from - 48), span.from), after: text.slice(span.to, span.to + 48) };
}
export function intersects(a: TextSpan, b: TextSpan): boolean {
  if (a.from === a.to && b.from === b.to) return a.from === b.from;
  if (a.from === a.to) return a.from > b.from && a.from < b.to;
  if (b.from === b.to) return b.from > a.from && b.from < a.to;
  return a.from < b.to && b.from < a.to;
}
/** Context is auxiliary evidence. A duplicate or damaged instruction is never relocated. */
export function locateInstruction(document: string, request: InlineRequest): SourceAnchor | null {
  const marker = request.instruction.marker;
  const end = document.indexOf(marker);
  if (end < 0 || document.indexOf(marker, end + marker.length) >= 0) return null;
  const from = end + marker.length - request.instruction.text.length;
  if (from < 0 || document.slice(from, end + marker.length) !== request.instruction.text) return null;
  return anchorAt(document, { from, to: end + marker.length });
}
export function locateTarget(document: string, target: SourceAnchor, exactDocument: boolean): SourceAnchor | null {
  if (exactDocument && document.slice(target.from, target.to) === target.text) return anchorAt(document, target);
  const candidates: number[] = [];
  for (let from = 0; from <= document.length; from++) {
    if (!document.startsWith(target.text, from)) continue;
    if (document.slice(Math.max(0, from - target.before.length), from) !== target.before || !document.startsWith(target.after, from + target.text.length)) continue;
    candidates.push(from);
    if (candidates.length > 1) return null;
  }
  return candidates.length === 1 ? anchorAt(document, { from: candidates[0], to: candidates[0] + target.text.length }) : null;
}
/** Range endpoints exclude new boundary typing. An insertion point stays before new typing. */
export function mapAnchor(anchor: SourceAnchor, changes: ChangeDesc, next: string): SourceAnchor {
  if (anchor.from === anchor.to) { const from = changes.mapPos(anchor.from, -1); return anchorAt(next, { from, to: from }); }
  const from = changes.mapPos(anchor.from, 1), to = changes.mapPos(anchor.to, -1);
  return anchorAt(next, { from: Math.min(from, to), to: Math.max(from, to) });
}
export function touchesInterior(span: TextSpan, changes: ChangeDesc): boolean {
  let touched = false;
  changes.iterChangedRanges((from, to) => {
    if (span.from === span.to ? from < span.from && to > span.from : from < span.to && to > span.from || from === to && from > span.from && from < span.to) touched = true;
  });
  return touched;
}
/** Only recognized instruction substrings are omitted, retaining all surrounding prose. */
export function cleanDocument(document: string, controls: readonly TextSpan[]): InlineContext {
  const ranges = [...controls].sort((a, b) => a.from - b.from), segments: InlineContext["segments"] = [];
  let text = "", cursor = 0;
  for (const range of [...ranges, { from: document.length, to: document.length }]) {
    anchorAt(document, range);
    if (range.from < cursor) throw new Error("指令范围重叠，无法组装正文。");
    if (range.from > cursor) {
      segments.push({ cleanFrom: text.length, cleanTo: text.length + range.from - cursor, sourceFrom: cursor, sourceTo: range.from });
      text += document.slice(cursor, range.from);
    }
    cursor = range.to;
  }
  return { text, segments };
}
export function sourceSpanForContext(context: InlineContext, span: TextSpan): TextSpan | null {
  const segment = context.segments.find(item => span.from >= item.cleanFrom && span.to <= item.cleanTo);
  return segment ? { from: segment.sourceFrom + span.from - segment.cleanFrom, to: segment.sourceFrom + span.to - segment.cleanFrom } : null;
}
export function instructionDeletion(document: string, span: TextSpan): InlineChange {
  let { from, to } = span;
  const lineStart = document.lastIndexOf("\n", from - 1) + 1;
  const nextNewline = document.indexOf("\n", to), lineEnd = nextNewline < 0 ? document.length : nextNewline;
  // A line containing even whitespace or user text is retained verbatim.
  if (document.slice(lineStart, from) + document.slice(to, lineEnd) === "") {
    from = lineStart;
    if (nextNewline >= 0) to = nextNewline + 1;
    else if (from > 0) { from--; to = lineEnd; }
  }
  // Keep one existing ASCII space where removing a command joins two spaces.
  else if (document[from - 1] === " " && document[to] === " ") to++;
  return { from, to, insert: "" };
}
export function commitChanges(document: string, instruction: TextSpan, target?: TextSpan, text = ""): InlineChange[] {
  const deletion = instructionDeletion(document, instruction);
  if (!target) return [deletion];
  if (intersects(instruction, target)) throw new Error("目标包含本次指令，请重新选择正文范围。");
  if (target.from === target.to && target.from >= deletion.from && target.from <= deletion.to) return [{ ...deletion, insert: text }];
  if (intersects(deletion, target)) return [{ from: Math.min(deletion.from, target.from), to: Math.max(deletion.to, target.to), insert: text }];
  return [deletion, { ...target, insert: text }].sort((a, b) => a.from - b.from);
}
export function applyChanges(document: string, changes: readonly InlineChange[]): string {
  return ChangeSet.of(changes, document.length).apply(Text.of(document.split("\n"))).toString();
}
