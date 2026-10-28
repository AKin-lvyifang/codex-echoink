export const PI_OUTPUT_CONTINUATION_ENTRY_TYPE = "echoink.output-continuation.v1";

export interface PiOutputContinuationRecord {
  readonly schemaVersion: 1;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly assistantEntryIds: readonly string[];
  readonly status: "running" | "completed" | "failed" | "cancelled";
}

/** Only the selected Session's explicit custom Entry owns a continuation. */
export function outputContinuationFromSessionEntry(
  entry: unknown,
  piSessionId: string
): PiOutputContinuationRecord | null {
  if (!identity(piSessionId)) return null;
  const root = object(entry);
  if (root?.type !== "custom" || root.customType !== PI_OUTPUT_CONTINUATION_ENTRY_TYPE) return null;
  const data = object(root.data);
  if (!data || data.schemaVersion !== 1 || data.piSessionId !== piSessionId
    || !identity(data.productRunId) || !Array.isArray(data.assistantEntryIds)
    || !data.assistantEntryIds.length || !data.assistantEntryIds.every(identity)
    || new Set(data.assistantEntryIds).size !== data.assistantEntryIds.length
    || (data.status !== "running" && data.status !== "completed"
      && data.status !== "failed" && data.status !== "cancelled")) return null;
  return Object.freeze({
    schemaVersion: 1,
    piSessionId,
    productRunId: data.productRunId,
    assistantEntryIds: Object.freeze([...data.assistantEntryIds]),
    status: data.status
  });
}

/** Exact substring/overlap matching only; one linear scan, with no prose rewriting. */
export function appendOutputContinuationText(
  previous: string,
  next: string
): { text: string; addedCharacters: number } {
  if (!next.trim()) return { text: previous, addedCharacters: 0 };
  if (!previous) return { text: next, addedCharacters: next.length };
  // KMP tracks both a complete repeated segment and the longest suffix-prefix overlap.
  const prefix = new Uint32Array(next.length);
  for (let index = 1, matched = 0; index < next.length; index++) {
    while (matched && next[index] !== next[matched]) matched = prefix[matched - 1];
    if (next[index] === next[matched]) matched++;
    prefix[index] = matched;
  }
  let matched = 0;
  for (let index = 0; index < previous.length; index++) {
    while (matched && previous[index] !== next[matched]) matched = prefix[matched - 1];
    if (previous[index] === next[matched]) matched++;
    if (matched === next.length) return { text: previous, addedCharacters: 0 };
  }
  const added = next.slice(matched);
  return added.trim()
    ? { text: previous + added, addedCharacters: added.length }
    : { text: previous, addedCharacters: 0 };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identity(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
}
