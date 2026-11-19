import type { DreamPublicExperience } from "./dream-experience-core";
export interface MemoryQuotePointer {
  readonly vaultId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly entryId: string;
  readonly productRunId: string;
}
export interface MemoryOriginalQuote {
  readonly pointer: MemoryQuotePointer;
  readonly source: string;
  readonly text: string;
  readonly timestamp: number | null;
  readonly position: number;
}
export type MemoryQuoteResult = Readonly<{ quote: MemoryOriginalQuote; reason?: never } | { quote?: never; reason: string }>;
export interface MemoryOriginalQuotePort {
  source(source: string): Promise<MemoryQuoteResult>;
  experience(experience: DreamPublicExperience): Promise<MemoryQuoteResult>;
}
export function memoryQuoteSource(pointer: MemoryQuotePointer): string {
  return `pi://${[pointer.vaultId, pointer.conversationId, pointer.sessionId, pointer.entryId].map(encodeURIComponent).join("/")}?productRun=${encodeURIComponent(pointer.productRunId)}`;
}
export function parseMemoryQuoteSource(source: string): MemoryQuotePointer | null {
  try {
    if (!source.startsWith("pi://")) return null;
    const [address, query, extra] = source.slice(5).split("?");
    const parts = address.split("/").map(decodeURIComponent);
    const runs = new URLSearchParams(query).getAll("productRun");
    if (extra !== undefined || parts.length !== 4 || parts.some(part => !part.trim() || part.includes("\u0000") || /[\r\n]/u.test(part)) || runs.length !== 1 || !runs[0].trim()) return null;
    return { vaultId: parts[0], conversationId: parts[1], sessionId: parts[2], entryId: parts[3], productRunId: runs[0] };
  } catch { return null; }
}
/** Compare original user messages, never Memory dates or turn completion times. */
export function compareMemoryQuotes(left: MemoryOriginalQuote, right: MemoryOriginalQuote): number | null {
  if (left.source === right.source) return 0;
  if (left.pointer.vaultId !== right.pointer.vaultId) return null;
  if (left.pointer.sessionId === right.pointer.sessionId && left.pointer.conversationId === right.pointer.conversationId)
    return Math.sign(left.position - right.position);
  if (left.timestamp === null || right.timestamp === null || left.timestamp === right.timestamp) return null;
  return Math.sign(left.timestamp - right.timestamp);
}

/** Missing synchronized originals remain pending; invalid identities never become evidence. */
export function memoryQuoteRetryable(reason: string): boolean { return ['source_pending','conversation_missing','product_run_missing','session_missing','entry_missing','identity_unavailable'].includes(reason); }
