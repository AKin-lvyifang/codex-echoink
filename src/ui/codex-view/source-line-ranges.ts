import type { KnowledgeReference } from "../../knowledge-base/types";
import type { SettingsLanguage } from "../../settings/settings";

export interface SourceLineRange {
  readonly lineStart: number;
  readonly lineEnd: number;
  /** The first original reference remains the authority for opening the range. */
  readonly reference: KnowledgeReference;
}

function mergeRanges(ranges: readonly SourceLineRange[]): SourceLineRange[] {
  const merged: SourceLineRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd)) {
    const previous = merged.at(-1);
    if (previous && range.lineStart <= previous.lineEnd + 1) {
      merged[merged.length - 1] = { ...previous, lineEnd: Math.max(previous.lineEnd, range.lineEnd) };
    } else merged.push(range);
  }
  return merged;
}

/** Unknown document lengths remain visible; another revision cannot prove a full read. */
export function sourceLineRanges(references: readonly KnowledgeReference[], hideWholeFileRanges = true): SourceLineRange[] {
  if (!hideWholeFileRanges) return mergeRanges(references.map((reference) => ({ lineStart: reference.lineStart, lineEnd: reference.lineEnd, reference })));
  const revisions = new Map<string, KnowledgeReference[]>();
  for (const reference of references) {
    const key = `${reference.vaultRelativePath}\0${reference.contentRevision}`;
    const group = revisions.get(key) ?? [];
    group.push(reference);
    revisions.set(key, group);
  }
  const partial: SourceLineRange[] = [];
  for (const group of revisions.values()) {
    const totals = new Set(group.flatMap((reference) => Number.isSafeInteger(reference.totalLines)
      && reference.totalLines! >= reference.lineEnd ? [reference.totalLines!] : []));
    const total = totals.size === 1 ? [...totals][0] : undefined;
    const isWhole = (start: number, end: number) => start === 1 && total !== undefined && end >= total;
    const ranges = group.filter((reference) => !isWhole(reference.lineStart, reference.lineEnd))
      .map((reference) => ({ lineStart: reference.lineStart, lineEnd: reference.lineEnd, reference }));
    partial.push(...mergeRanges(ranges).filter((range) => !isWhole(range.lineStart, range.lineEnd)));
  }
  return mergeRanges(partial);
}

export function sourceLineRangeLabel(ranges: readonly SourceLineRange[], language: SettingsLanguage): string {
  const spans = ranges.map(({ lineStart, lineEnd }) => lineStart === lineEnd ? `${lineStart}` : `${lineStart}–${lineEnd}`);
  return language === "en" ? `Lines ${spans.join(", ")}` : `第 ${spans.join("、")} 行`;
}
