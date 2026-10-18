import { sha256Hex } from "../utils/sha256";

export interface KnowledgeSourceSpan {
  lineStart: number;
  lineEnd: number;
  /** Zero-based UTF-16 columns, start inclusive and end exclusive. */
  columnStart?: number;
  columnEnd?: number;
}

export function sliceKnowledgeSourceSpan(lines: readonly string[], span: KnowledgeSourceSpan): string {
  const { lineStart, lineEnd, columnStart, columnEnd } = span;
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart || lineEnd > lines.length) throw new TypeError("knowledge_source_span_invalid");
  const selected = lines.slice(lineStart - 1, lineEnd);
  if (columnStart !== undefined || columnEnd !== undefined) {
    if (!Number.isSafeInteger(columnStart) || !Number.isSafeInteger(columnEnd) || columnStart! < 0 || columnEnd! < 0
      || columnStart! > selected[0].length || columnEnd! > selected.at(-1)!.length
      || (selected.length === 1 && columnEnd! < columnStart!)) throw new TypeError("knowledge_source_span_invalid");
    if (selected.length === 1) return selected[0].slice(columnStart, columnEnd);
    selected[0] = selected[0].slice(columnStart);
    selected[selected.length - 1] = selected.at(-1)!.slice(0, columnEnd);
  }
  return selected.join("\n");
}

/** Legacy full-line IDs remain byte compatible. */
export function knowledgeSpanReferenceId(path: string, revision: string, span: KnowledgeSourceSpan): string {
  const columns = span.columnStart === undefined && span.columnEnd === undefined ? "" : `:${span.columnStart}:${span.columnEnd}`;
  return `knowledge-reference:${sha256Hex(`${path}\0${revision}\0${span.lineStart}:${span.lineEnd}${columns}`)}`;
}

export function sourceSpanHasMore(lines: readonly string[], span: KnowledgeSourceSpan): boolean {
  return span.lineStart > 1 || span.lineEnd < lines.length || (span.columnStart ?? 0) > 0 || (span.columnEnd !== undefined && span.columnEnd < lines[span.lineEnd - 1].length);
}

export function boundKnowledgeSourceSpan(lines: readonly string[], span: KnowledgeSourceSpan, maxCharacters = 6000): KnowledgeSourceSpan {
  const excerpt = sliceKnowledgeSourceSpan(lines, span);
  if (excerpt.length <= maxCharacters) return span;
  const prefix = excerpt.slice(0, maxCharacters);
  const breaks = prefix.match(/\n/gu)?.length ?? 0;
  return { lineStart: span.lineStart, lineEnd: span.lineStart + breaks,
    columnStart: span.columnStart ?? 0,
    columnEnd: breaks ? prefix.length - prefix.lastIndexOf("\n") - 1 : (span.columnStart ?? 0) + prefix.length };
}
