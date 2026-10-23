import type { SelectionAnchor } from "../types/selection-annotations";
import type { ChangeDesc } from "@codemirror/state";

/** A conservative Markdown-to-visible-character projection, used only to propose
 * a unique source span. The captured rendered snapshot remains authoritative. */
export function markdownProjection(markdown: string): { text: string; offsets: number[] } {
  const hidden = new Uint8Array(markdown.length);
  const hide = (from: number, to: number) => hidden.fill(1, from, to);
  const patterns = [/^ {0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gmu, /^\s*\|?[ :|-]+\|[ :|-]*$/gmu, /<!--[^]*?-->/gu];
  for (const pattern of patterns) for (const match of markdown.matchAll(pattern)) hide(match.index, match.index + match[0].length);
  for (const match of markdown.matchAll(/!?\[([^\]\n]+)\]\([^\n)]*\)/gu)) {
    const start = match.index, labelStart = start + match[0].indexOf("[") + 1;
    hide(start, labelStart); hide(labelStart + match[1].length, start + match[0].length);
  }
  const markers = /\*\*|__|~~|`+|\*|_/gu;
  for (let match = markers.exec(markdown); match; match = markers.exec(markdown)) {
    // An escaped start may be followed by another, unescaped marker.
    if (markdown[match.index - 1] === "\\") { markers.lastIndex = match.index + 1; continue; }
    hide(match.index, match.index + match[0].length);
  }
  const offsets: number[] = []; let text = "";
  for (let index = 0; index < markdown.length; index++) if (!hidden[index] && !/\s|\|/u.test(markdown[index])) { text += markdown[index]; offsets.push(index); }
  return { text, offsets };
}
const compact = (value: string) => value.replace(/\s/gu, "");
export function attachSourceAnchor(markdown: string, anchor: SelectionAnchor, selectedText: string, renderedDocument?: string): void {
  if (anchor.source) return;
  if (anchor.mode === "editor") {
    if (markdown.slice(anchor.from, anchor.to) !== selectedText) { anchor.invalid = true; return; }
    anchor.source = sourceSpan(markdown, anchor.from, anchor.to); return;
  }
  const projection = markdownProjection(markdown), target = compact(selectedText), before = compact(anchor.before), after = compact(anchor.after);
  if (!target) return;
  if (renderedDocument !== undefined && compact(renderedDocument) === projection.text) {
    const index = compact(renderedDocument.slice(0, anchor.from)).length;
    if (projection.text.slice(index, index + target.length) === target) {
      anchor.source = sourceSpan(markdown, projection.offsets[index], projection.offsets[index + target.length - 1] + 1); return;
    }
  }
  const candidates: number[] = [];
  for (let index = projection.text.indexOf(target); index >= 0; index = projection.text.indexOf(target, index + 1)) {
    if (projection.text.slice(0, index).endsWith(before) && projection.text.slice(index + target.length).startsWith(after)) candidates.push(index);
  }
  if (candidates.length !== 1) return;
  const index = candidates[0], from = projection.offsets[index], to = projection.offsets[index + target.length - 1] + 1;
  anchor.source = sourceSpan(markdown, from, to);
}
function sourceSpan(markdown: string, from: number, to: number): NonNullable<SelectionAnchor["source"]> {
  return { from, to, text: markdown.slice(from, to), before: markdown.slice(Math.max(0, from - 48), from), after: markdown.slice(to, to + 48) };
}
export function resolveSourceSpan(markdown: string, anchor: SelectionAnchor, trustExact = false): { from: number; to: number } | null {
  const source = anchor.source;
  if (!source || !source.text || anchor.invalid) return null;
  if (trustExact && markdown.slice(source.from, source.to) === source.text && markdown.slice(Math.max(0, source.from - source.before.length), source.from) === source.before && markdown.slice(source.to, source.to + source.after.length) === source.after) return { from: source.from, to: source.to };
  const candidates: number[] = [];
  for (let from = markdown.indexOf(source.text); from >= 0; from = markdown.indexOf(source.text, from + 1)) {
    if (markdown.slice(Math.max(0, from - source.before.length), from) === source.before && markdown.slice(from + source.text.length, from + source.text.length + source.after.length) === source.after) candidates.push(from);
  }
  return candidates.length === 1 ? { from: candidates[0], to: candidates[0] + source.text.length } : null;
}
export function renderedSpanForSource(markdown: string, anchor: SelectionAnchor, trustExact = false): { text: string; before: string; after: string; index?: number; documentText?: string } | null {
  const span = resolveSourceSpan(markdown, anchor, trustExact); if (!span) return null;
  const projection = markdownProjection(markdown);
  const from = projection.offsets.findIndex((offset) => offset >= span.from);
  let to = projection.offsets.findIndex((offset) => offset >= span.to); if (to < 0) to = projection.text.length;
  return from < 0 ? null : { text: projection.text.slice(from, to), before: projection.text.slice(Math.max(0, from - 48), from), after: projection.text.slice(to, to + 48), ...(trustExact ? { index: from, documentText: projection.text } : {}) };
}

export function mapSelectionSource(anchor: SelectionAnchor, changes: ChangeDesc, previous: string, next: string): void {
  if (!anchor.source || anchor.invalid) return;
  const old = resolveSourceSpan(previous, anchor, true);
  if (!old) return;
  changes.iterChangedRanges((from, to) => { if (from < old.to && to > old.from || from === to && from > old.from && from < old.to) anchor.invalid = true; });
  const from = changes.mapPos(old.from, 1), to = changes.mapPos(old.to, -1);
  if (from >= to || next.slice(from, to) !== anchor.source.text) anchor.invalid = true;
  anchor.source = { ...anchor.source, from, to, before: next.slice(Math.max(0, from - 48), from), after: next.slice(to, to + 48) };
  if (anchor.mode === "editor") { anchor.from = from; anchor.to = to; anchor.before = anchor.source.before; anchor.after = anchor.source.after; }
}

export function mapSourceChangeOnce(versions: Map<string, string>, id: string, anchor: SelectionAnchor, changes: ChangeDesc, previous: string, next: string): void {
  const known = versions.get(id);
  if (known === next || known && known !== previous) return;
  mapSelectionSource(anchor, changes, previous, next);
  versions.set(id, next);
}
