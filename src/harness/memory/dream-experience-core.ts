import { sha256Hex } from "../../utils/sha256";
import { cognitiveJsonText, normalizeTextForDedupe } from "./cognitive-text";
export const DREAM_EXPERIENCE_INBOX_SCHEMA = "echoink.dream-experience-inbox.v1" as const;
export const DREAM_EXPERIENCE_INBOX_RELATIVE_PATH = "shared-user/.runtime/dream-experience-inbox.json";
export const DREAM_EXPERIENCE_MAX_ITEMS = 128;
export const DREAM_EXPERIENCE_MAX_BYTES = 512 * 1024;

export interface DreamTaskResultSummary {
  readonly terminalState: "completed" | "failed";
  readonly successfulToolNames: readonly string[];
  readonly failedToolNames: readonly string[];
}

export interface DreamPublicExperienceInput {
  readonly conversationId: string;
  readonly productRunId: string;
  readonly userEntryId: string;
  readonly assistantEntryId: string;
  readonly occurredAt: number;
  readonly userText: string;
  readonly assistantText: string;
  readonly taskResult: DreamTaskResultSummary;
}

export interface DreamPublicExperience extends DreamPublicExperienceInput {
  readonly fingerprint: string;
  readonly evaluatedAt: number | null;
  readonly reconciledAt?: number | null;
}

export interface DreamExperienceInboxState {
  readonly schema: typeof DREAM_EXPERIENCE_INBOX_SCHEMA;
  readonly revision: number;
  readonly entries: readonly DreamPublicExperience[];
  readonly duplicateCount: number;
  readonly droppedEvaluatedCount: number;
  readonly droppedUnevaluatedCount: number;
  readonly updatedAt: number;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,160}$/u;

export function defaultDreamExperienceInboxState(): DreamExperienceInboxState {
  return Object.freeze({
    schema: DREAM_EXPERIENCE_INBOX_SCHEMA,
    revision: 0,
    entries: Object.freeze([]),
    duplicateCount: 0,
    droppedEvaluatedCount: 0,
    droppedUnevaluatedCount: 0,
    updatedAt: 0
  });
}

export function normalizeDreamPublicExperience(
  input: DreamPublicExperienceInput
): DreamPublicExperience {
  const conversationId = boundedId(input.conversationId, "conversationId");
  const productRunId = boundedId(input.productRunId, "productRunId");
  const userEntryId = boundedId(input.userEntryId, "userEntryId");
  const assistantEntryId = boundedId(input.assistantEntryId, "assistantEntryId");
  const userText = publicText(input.userText);
  const assistantText = publicText(input.assistantText);
  if (!userText && !assistantText) throw new Error("dream_experience_empty");
  if (!Number.isFinite(input.occurredAt) || input.occurredAt < 0) {
    throw new Error("dream_experience_occurred_at_invalid");
  }
  const taskResult = normalizeTaskResult(input.taskResult);
  const fingerprint = sha256Hex(JSON.stringify({
    conversationId,
    productRunId,
    userEntryId,
    assistantEntryId,
    userText: normalizeTextForDedupe(userText),
    assistantText: normalizeTextForDedupe(assistantText),
    taskResult
  }));
  return Object.freeze({
    fingerprint,
    conversationId,
    productRunId,
    userEntryId,
    assistantEntryId,
    occurredAt: input.occurredAt,
    userText,
    assistantText,
    taskResult,
    evaluatedAt: null
  });
}

export function appendDreamPublicExperience(
  state: DreamExperienceInboxState,
  input: DreamPublicExperienceInput,
  now: number
): DreamExperienceInboxState {
  const entry = normalizeDreamPublicExperience(input);
  assertTimestamp(now);
  if (state.entries.some((candidate) => candidate.fingerprint === entry.fingerprint)) {
    return boundState({
      ...state,
      revision: state.revision + 1,
      duplicateCount: state.duplicateCount + 1,
      updatedAt: now
    });
  }
  return boundState({
    ...state,
    revision: state.revision + 1,
    entries: Object.freeze([...state.entries, entry]),
    updatedAt: now
  });
}

export function markDreamExperiencesEvaluated(
  state: DreamExperienceInboxState,
  fingerprints: ReadonlySet<string>,
  now: number
): DreamExperienceInboxState {
  if (fingerprints.size === 0) return state;
  assertTimestamp(now);
  let changed = false;
  const entries = state.entries.map((entry) => {
    if (entry.evaluatedAt !== null || !fingerprints.has(entry.fingerprint)) return entry;
    changed = true;
    return Object.freeze({ ...entry, evaluatedAt: now });
  });
  return changed
    ? boundState({
        ...state,
        revision: state.revision + 1,
        entries: Object.freeze(entries),
        updatedAt: now
      })
    : state;
}

export function dreamExperienceInboxJson(state: DreamExperienceInboxState): string {
  return cognitiveJsonText(finalizeState(state));
}

export function parseDreamExperienceInboxState(
  raw: Record<string, unknown>
): DreamExperienceInboxState | null {
  if (raw.schema !== DREAM_EXPERIENCE_INBOX_SCHEMA
    || !safeInteger(raw.revision)
    || !safeInteger(raw.duplicateCount)
    || !safeInteger(raw.droppedEvaluatedCount)
    || !safeInteger(raw.droppedUnevaluatedCount)
    || typeof raw.updatedAt !== "number"
    || !Number.isFinite(raw.updatedAt)
    || !Array.isArray(raw.entries)
    || raw.entries.length > DREAM_EXPERIENCE_MAX_ITEMS) return null;
  const fingerprints = new Set<string>();
  const entries: DreamPublicExperience[] = [];
  for (const value of raw.entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(item.fingerprint)) return null;
    if (fingerprints.has(item.fingerprint)) return null;
    fingerprints.add(item.fingerprint);
    if (typeof item.conversationId !== "string"
      || typeof item.productRunId !== "string"
      || typeof item.userEntryId !== "string"
      || typeof item.assistantEntryId !== "string"
      || typeof item.userText !== "string" || typeof item.assistantText !== "string"
      || typeof item.occurredAt !== "number" || !Number.isFinite(item.occurredAt)
      || (item.evaluatedAt !== null && (typeof item.evaluatedAt !== "number" || !Number.isFinite(item.evaluatedAt)))) {
      return null;
    }
    if (item.reconciledAt !== undefined && item.reconciledAt !== null && (typeof item.reconciledAt !== "number" || !Number.isFinite(item.reconciledAt))) return null;
    let normalized: DreamPublicExperience;
    try {
      normalized = normalizeDreamPublicExperience({
        conversationId: item.conversationId,
        productRunId: item.productRunId,
        userEntryId: item.userEntryId,
        assistantEntryId: item.assistantEntryId,
        occurredAt: item.occurredAt,
        userText: item.userText,
        assistantText: item.assistantText,
        taskResult: normalizeTaskResult(item.taskResult)
      });
    } catch {
      return null;
    }
    if (normalized.fingerprint !== item.fingerprint) return null;
    entries.push(Object.freeze({
      ...normalized,
      evaluatedAt: item.evaluatedAt,
      ...(item.reconciledAt === undefined ? {} : { reconciledAt: item.reconciledAt })
    }));
  }
  const state = finalizeState({
    schema: DREAM_EXPERIENCE_INBOX_SCHEMA,
    revision: raw.revision,
    entries: Object.freeze(entries),
    duplicateCount: raw.duplicateCount,
    droppedEvaluatedCount: raw.droppedEvaluatedCount,
    droppedUnevaluatedCount: raw.droppedUnevaluatedCount,
    updatedAt: raw.updatedAt
  });
  return new TextEncoder().encode(dreamExperienceInboxJsonUnchecked(state)).length <= DREAM_EXPERIENCE_MAX_BYTES
    ? state
    : null;
}

function boundState(input: DreamExperienceInboxState): DreamExperienceInboxState {
  const entries = [...input.entries];
  let droppedEvaluatedCount = input.droppedEvaluatedCount;
  let droppedUnevaluatedCount = input.droppedUnevaluatedCount;
  const overLimit = (): boolean => entries.length > DREAM_EXPERIENCE_MAX_ITEMS
    || new TextEncoder().encode(dreamExperienceInboxJsonUnchecked({
      ...input,
      entries,
      droppedEvaluatedCount,
      droppedUnevaluatedCount
    })).length > DREAM_EXPERIENCE_MAX_BYTES;
  while (entries.length > 0 && overLimit()) {
    let index = entries.findIndex((entry) => entry.evaluatedAt !== null && entry.reconciledAt != null);
    if (index < 0) index = entries.findIndex(entry => entry.evaluatedAt !== null || entry.reconciledAt != null);
    if (index < 0) index = 0;
    const [removed] = entries.splice(index, 1);
    if (removed.evaluatedAt === null) droppedUnevaluatedCount += 1;
    else droppedEvaluatedCount += 1;
  }
  return finalizeState({
    ...input,
    entries: Object.freeze(entries),
    droppedEvaluatedCount,
    droppedUnevaluatedCount
  });
}

function finalizeState(input: DreamExperienceInboxState): DreamExperienceInboxState {
  return Object.freeze({
    ...input,
    entries: Object.freeze([...input.entries])
  });
}

function dreamExperienceInboxJsonUnchecked(state: DreamExperienceInboxState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function boundedId(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512
    || normalized.includes("\u0000") || /[\r\n]/u.test(normalized)) {
    throw new Error(`dream_experience_${name}_invalid`);
  }
  return normalized;
}

function publicText(value: string): string {
  return value.replaceAll("\u0000", "").trim();
}

function normalizeTaskResult(value: unknown): DreamTaskResultSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dream_experience_task_result_invalid");
  }
  const taskResult = value as Record<string, unknown>;
  if (taskResult.terminalState !== "completed" && taskResult.terminalState !== "failed") {
    throw new Error("dream_experience_task_result_invalid");
  }
  return Object.freeze({
    terminalState: taskResult.terminalState,
    successfulToolNames: Object.freeze(normalizeToolNames(taskResult.successfulToolNames)),
    failedToolNames: Object.freeze(normalizeToolNames(taskResult.failedToolNames))
  });
}

function normalizeToolNames(values: unknown): string[] {
  if (!Array.isArray(values)) throw new Error("dream_experience_tool_names_invalid");
  const strings = values.filter((value): value is string => typeof value === "string");
  if (strings.length !== values.length) throw new Error("dream_experience_tool_names_invalid");
  const result = [...new Set(strings.map((value) => value.trim()).filter((value) => TOOL_NAME.test(value)))];
  return result.sort().slice(0, 64);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("dream_experience_timestamp_invalid");
}

export function markDreamExperiencesReconciled(current: DreamExperienceInboxState, fingerprints: ReadonlySet<string>, now: number): DreamExperienceInboxState {
 return { ...current, revision: current.revision + 1, updatedAt: now, entries: current.entries.map(entry => fingerprints.has(entry.fingerprint) ? { ...entry, reconciledAt: now } : entry) };
}
