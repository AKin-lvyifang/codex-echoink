import type { SelectionAnchor, SelectionCapture } from "../types/selection-annotations";
const HOST_UI = ".mod-ui,.markdown-preview-pusher,.metadata-container,script,style,input,textarea,button";
export function readingBodyProjection(root: HTMLElement): { text: string; nodes: Array<{ node: Text; from: number; to: number }> } {
  const nodes: Array<{ node: Text; from: number; to: number }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4); let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(HOST_UI)) continue;
    const from = text.length; text += node.textContent ?? ""; nodes.push({ node: node as Text, from, to: text.length });
  }
  return { text, nodes };
}
function offsetAtPoint(root: HTMLElement, projection: ReturnType<typeof readingBodyProjection>, container: Node, offset: number): number {
  const prefix = root.ownerDocument.createRange(); prefix.selectNodeContents(root); prefix.setEnd(container, offset);
  let result = 0;
  for (const entry of projection.nodes) {
    if (entry.node === container) return entry.from + offset;
    if (prefix.intersectsNode(entry.node)) result = entry.to;
  }
  return result;
}
function rangeAtOffsets(root: HTMLElement, projection: ReturnType<typeof readingBodyProjection>, from: number, to: number): Range | null {
  const start = projection.nodes.find((entry) => from >= entry.from && from < entry.to);
  const end = projection.nodes.find((entry) => to > entry.from && to <= entry.to);
  if (!start || !end) return null;
  const range = root.ownerDocument.createRange(); range.setStart(start.node, from - start.from); range.setEnd(end.node, to - end.from); return range;
}
export function captureReadingSelection(root: HTMLElement, selection: Selection, path: string, fileName: string): { capture: SelectionCapture; range: Range } | null {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)
    || range.startContainer.parentElement?.closest(HOST_UI) || range.endContainer.parentElement?.closest(HOST_UI)) return null;
  const projection = readingBodyProjection(root);
  const from = offsetAtPoint(root, projection, range.startContainer, range.startOffset), to = offsetAtPoint(root, projection, range.endContainer, range.endOffset);
  const selectedText = projection.text.slice(from, to); if (!selectedText.trim()) return null;
  const start = (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement)?.closest<HTMLElement>("[data-echoink-section-start]");
  const end = (range.endContainer.nodeType === 1 ? range.endContainer as Element : range.endContainer.parentElement)?.closest<HTMLElement>("[data-echoink-section-end]");
  return { range: rangeAtOffsets(root, projection, from, to) ?? range, capture: { selectedText, vaultRelativePath: path, fileName, anchor: { mode: "reading", from, to, before: projection.text.slice(Math.max(0, from - 48), from), after: projection.text.slice(to, to + 48),
    ...(start ? { sectionStart: Number(start.dataset.echoinkSectionStart) } : {}), ...(end ? { sectionEnd: Number(end.dataset.echoinkSectionEnd) } : {}) } } };
}
/** All offsets address the same filtered rendered-body projection, never Markdown. */
export function resolveReadingRange(root: HTMLElement, anchor: SelectionAnchor, selectedText: string): Range | null {
  if (anchor.mode !== "reading" || anchor.invalid) return null;
  const projection = readingBodyProjection(root), text = projection.text, matches: number[] = [];
  for (let from = text.indexOf(selectedText); from >= 0; from = text.indexOf(selectedText, from + 1)) {
    const to = from + selectedText.length;
    if (text.slice(Math.max(0, from - anchor.before.length), from) === anchor.before && text.slice(to, to + anchor.after.length) === anchor.after) matches.push(from);
  }
  if (matches.length !== 1) return null;
  return rangeAtOffsets(root, projection, matches[0], matches[0] + selectedText.length);
}
export function resolveProjectedReadingRange(root: HTMLElement, projected: { text: string; before: string; after: string; index?: number; documentText?: string }): Range | null {
  const projection = readingBodyProjection(root), raw = projection.text, offsets: number[] = []; let text = "";
  for (let index = 0; index < raw.length; index++) if (!/\s/u.test(raw[index])) { offsets.push(index); text += raw[index]; }
  const matches: number[] = [];
  if (projected.documentText === text && projected.index !== undefined && text.slice(projected.index, projected.index + projected.text.length) === projected.text) matches.push(projected.index);
  for (let index = matches.length ? -1 : text.indexOf(projected.text); index >= 0 && projected.text; index = text.indexOf(projected.text, index + 1)) {
    if (text.slice(0, index).endsWith(projected.before) && text.slice(index + projected.text.length).startsWith(projected.after)) matches.push(index);
  }
  if (matches.length !== 1) return null;
  return rangeAtOffsets(root, projection, offsets[matches[0]], offsets[matches[0] + projected.text.length - 1] + 1);
}
