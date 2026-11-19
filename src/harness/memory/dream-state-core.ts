import { DREAM_STATE_SCHEMA } from "./personal-memory-contracts";
import { emptyDreamCorrectionState, parseDreamCorrectionState, type DreamCorrectionState } from "./dream-correction-core";
export interface DreamAssociationSelection {
  readonly memoryId: string; readonly mode: "full" | "association";
  readonly catalogCount: number; readonly sentCount: number; readonly sentIds: readonly string[];
  readonly selectedIds: readonly string[]; readonly reason?: string; readonly elapsedMs: number;
  readonly batchIndex?: number; readonly batchSize?: number;
  readonly inputTokens?: number; readonly outputTokenReserve?: number;
}
export interface DreamState {
  readonly reconciliation?: DreamCorrectionState;
  readonly runSummary?: DreamRunSummary;
  readonly associationSelections?: readonly DreamAssociationSelection[];
  readonly schema: typeof DREAM_STATE_SCHEMA;
  readonly revision: number;
  readonly lastRunAt: number;
  readonly lastSuccessAt: number;
  readonly lastProcessedMemoryRevision: number;
  /** Per-Memory success ledger; independent from USER profile source links. */
  readonly processedMemorySources: readonly DreamProcessedMemorySource[];
  readonly pendingMemoryIds: readonly string[];
  readonly backfillCursor: string | null;
  readonly updatedAt: number;
}

export interface DreamRunSummary {
  readonly startedAt: number; readonly finishedAt: number;
  readonly batches: number; readonly processedMemories: number; readonly evaluatedExperiences: number;
  readonly modelCalls: number; readonly rateLimitRetries: number;
  readonly stopReason: "running" | "completed" | "failed" | "cancelled" | "no_progress";
}

export interface DreamProcessedMemorySource {
  readonly memoryId: string;
  readonly memoryRevision: number;
  readonly processedAt: number;
  readonly associationRevision?: number;
}

export const DREAM_STATE_RELATIVE_PATH = "shared-user/.runtime/dream-state.json";

/** Hard cap so the pending queue cannot grow unboundedly. */
export const DREAM_PENDING_CAP = 500;

export function defaultDreamState(): DreamState {
  return Object.freeze({
    reconciliation: emptyDreamCorrectionState(),
    schema: DREAM_STATE_SCHEMA,
    revision: 0,
    lastRunAt: 0,
    lastSuccessAt: 0,
    lastProcessedMemoryRevision: 0,
    processedMemorySources: Object.freeze([]),
    pendingMemoryIds: Object.freeze([]),
    backfillCursor: null,
    updatedAt: 0
  });
}

export function parseDreamState(raw: Record<string, unknown>): DreamState | null {
  if (raw.schema !== DREAM_STATE_SCHEMA) return null;
  const reconciliation = parseDreamCorrectionState(raw.reconciliation);
  if (!reconciliation) return null;
  if (raw.runSummary !== undefined) {
    if (!raw.runSummary || typeof raw.runSummary !== "object") return null;
    const run = raw.runSummary as Record<string, unknown>;
    if (![run.startedAt, run.finishedAt, run.batches, run.processedMemories, run.evaluatedExperiences, run.modelCalls, run.rateLimitRetries]
      .every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
      || !["running", "completed", "failed", "cancelled", "no_progress"].includes(String(run.stopReason))) return null;
  }
  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const pending = Array.isArray(raw.pendingMemoryIds)
    ? raw.pendingMemoryIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, DREAM_PENDING_CAP)
    : [];
  const processedById = new Map<string, DreamProcessedMemorySource>();
  if (Array.isArray(raw.processedMemorySources)) {
    for (const value of raw.processedMemorySources) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const source = value as Record<string, unknown>;
      if (typeof source.memoryId !== "string" || !source.memoryId
        || typeof source.memoryRevision !== "number"
        || !Number.isSafeInteger(source.memoryRevision)
        || source.memoryRevision < 1
        || typeof source.processedAt !== "number"
        || !Number.isFinite(source.processedAt)) return null;
      if (source.associationRevision !== undefined && (!Number.isSafeInteger(source.associationRevision) || Number(source.associationRevision) < 1)) return null;
      const parsed = Object.freeze({
        memoryId: source.memoryId,
        memoryRevision: source.memoryRevision,
        ...(source.associationRevision === undefined ? {} : { associationRevision: source.associationRevision as number }),
        processedAt: source.processedAt
      });
      const previous = processedById.get(parsed.memoryId);
      if (!previous || parsed.memoryRevision > previous.memoryRevision
        || (parsed.memoryRevision === previous.memoryRevision && parsed.processedAt > previous.processedAt)) {
        processedById.set(parsed.memoryId, parsed);
      }
    }
  }
  const associationSelections = Array.isArray(raw.associationSelections) ? raw.associationSelections as unknown[] : [];
  if (associationSelections.some(value => {
    if (!value || typeof value !== "object") return true;
    const item = value as Record<string, unknown>;
    return typeof item.memoryId !== "string" || !["full", "association"].includes(String(item.mode))
      || ![item.catalogCount, item.sentCount, item.elapsedMs].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
      || [item.batchIndex, item.batchSize, item.inputTokens, item.outputTokenReserve].some(n => n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 1))
      || ![item.sentIds, item.selectedIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{3,96}$/u.test(id)));
  })) return null;
  return Object.freeze({
    reconciliation,
    ...(raw.runSummary ? { runSummary: raw.runSummary as DreamRunSummary } : {}),
    ...(associationSelections.length ? { associationSelections: associationSelections as DreamAssociationSelection[] } : {}),
    schema: DREAM_STATE_SCHEMA,
    revision: numberOr(raw.revision, 0),
    lastRunAt: numberOr(raw.lastRunAt, 0),
    lastSuccessAt: numberOr(raw.lastSuccessAt, 0),
    lastProcessedMemoryRevision: numberOr(raw.lastProcessedMemoryRevision, 0),
    processedMemorySources: Object.freeze([...processedById.values()]
      .sort((left, right) => left.memoryId.localeCompare(right.memoryId))),
    pendingMemoryIds: Object.freeze(pending),
    backfillCursor: typeof raw.backfillCursor === "string" ? raw.backfillCursor : null,
    updatedAt: numberOr(raw.updatedAt, 0)
  });
}

/** Add ids to the pending queue (deduped, capped). Pure helper. */
export function enqueuePendingMemoryIds(
  state: DreamState,
  ids: readonly string[],
  now: number
): DreamState {
  const merged = [...state.pendingMemoryIds];
  const known = new Set(merged);
  for (const id of ids) {
    if (!known.has(id)) {
      known.add(id);
      merged.push(id);
    }
  }
  const trimmed = merged.slice(Math.max(0, merged.length - DREAM_PENDING_CAP));
  if (
    trimmed.length === state.pendingMemoryIds.length
    && trimmed.every((id, index) => id === state.pendingMemoryIds[index])
  ) {
    return state;
  }
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    pendingMemoryIds: Object.freeze(trimmed),
    updatedAt: now
  });
}
