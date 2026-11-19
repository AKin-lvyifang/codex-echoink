/** Persistent diagnostic allowlist. No question, memory text, title or credentials. */
export interface MemoryRecallAttempt {
  readonly orderEnsemble?: "full" | "partial";
  readonly catalogCount?: number;
  readonly sentCount?: number;
  readonly sentIds?: readonly string[];
  readonly prefilterReason?: string;
  readonly route: "decisions" | "directory";
  readonly status: "selected" | "fallback" | "skipped";
  readonly reason?: string;
  readonly threshold?: number;
  readonly selectedIds: readonly string[];
  readonly elapsedMs: number;
}

export interface MemoryRecallReceipt {
  readonly associationThreshold?: number;
  readonly expandedSources?: Readonly<Record<string, import("./memory-association").MemoryAssociationOrigin>>;
  readonly schemaVersion: 1;
  readonly expandedIds?: readonly string[];
  readonly expandedFrom?: Readonly<Record<string, string>>;
  readonly navigation?: Readonly<{ total: number; listed: number; truncated: boolean; tokens: number }>;
  readonly route: "decisions" | "directory" | "lexical" | "skipped";
  readonly reason?: string;
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly injectedCount: number;
  readonly selectedIds: readonly string[];
  readonly injectedIds: readonly string[];
  readonly coreIds: readonly string[];
  readonly elapsedMs: number;
  readonly attempts: readonly MemoryRecallAttempt[];
}

export const MEMORY_RECALL_RECEIPT_ENTRY_TYPE = "echoink.memory-recall-receipt.v1";
