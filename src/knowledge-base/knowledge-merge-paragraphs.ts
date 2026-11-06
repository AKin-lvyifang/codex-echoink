import { createMaintenanceSectionSnapshot } from "./maintenance-section-patch";

export interface MergeParagraph {
  start: number;
  end: number;
  text: string;
  key?: string;
}

/** Only prose can fold whitespace. Markdown blocks with formatting keep their original bytes. */
export function mergeParagraphs(body: string): MergeParagraph[] {
  const result: MergeParagraph[] = [];
  let cursor = 0, start = 0, fence = "", protectedBlock = false;
  const flush = (end: number) => {
    const text = body.slice(start, end);
    if (text.trim()) result.push({ start, end, text,
      ...(!protectedBlock ? { key: text.trim().replace(/\s+/gu, " ") } : {}) });
    start = end;
    protectedBlock = !!fence;
  };
  for (const line of body.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence || marker || /^(?: {4}|\t| {0,3}(?:>|[-+*]\s|\d+[.)]\s|#{1,6}\s|<|!\[))/u.test(line) ||
      /[|`$]/u.test(line) || /^ {0,3}(?:[-*_]\s*){3,}$/u.test(line)) protectedBlock = true;
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    }
    if (!line.trim()) { flush(cursor); start = cursor + line.length; }
    cursor += line.length;
  }
  flush(body.length);
  return result;
}

export function mergeProseIndex(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const region of createMaintenanceSectionSnapshot(content).regions) {
    if (["sources", "related"].includes(region.kind)) continue;
    for (const paragraph of mergeParagraphs(content.slice(region.contentStart, region.end)))
      if (paragraph.key && !result.has(paragraph.key)) result.set(paragraph.key, region.title);
  }
  return result;
}
