import { GENERAL_ASSISTANT_ID } from "./types";
import { normalizeAgentId } from "./registry";

export type ConversationTaskStatus = "running" | "waiting" | "completed" | "interrupted";
export interface TaskPendingResponse {
  runId: string;
  questionId: string;
  kind: "question" | "confirmation";
}

/** Conversation.id is the taskId; Conversation.title is its task title. No second task store. */
export interface ConversationTaskMetadata {
  agentId?: string;
  businessKey?: string;
  taskStatus?: ConversationTaskStatus;
  taskStage?: string;
  taskStartedAt?: number;
  taskCompletedAt?: number;
  taskInterruptedAt?: number;
  pendingResponse?: TaskPendingResponse;
  unreadAnswerAt?: number;
  lastReadAt?: number;
  /** Catalog revision for metadata projections; unrelated to transcript/run timestamps. */
  taskMetadataUpdatedAt?: number;
}

/** Own undefined values explicitly clear fields. Omitted fields are unchanged. */
export type ConversationTaskMetadataPatch = Partial<Omit<ConversationTaskMetadata, "taskMetadataUpdatedAt">>;

export function patchConversationTaskMetadata(current: ConversationTaskMetadata, patch: ConversationTaskMetadataPatch): ConversationTaskMetadata {
  const next = normalizeConversationTaskMetadata(current);
  for (const key of CONVERSATION_TASK_METADATA_KEYS) {
    if (key === "taskMetadataUpdatedAt" || !Object.hasOwn(patch, key)) continue;
    Object.assign(next, { [key]: patch[key] });
  }
  return normalizeConversationTaskMetadata(next);
}

export const CONVERSATION_TASK_METADATA_KEYS = [
  "agentId", "businessKey", "taskStatus", "taskStage", "taskStartedAt", "taskCompletedAt",
  "taskInterruptedAt", "pendingResponse", "unreadAnswerAt", "lastReadAt", "taskMetadataUpdatedAt"
] as const;

export function normalizeConversationTaskMetadata(value: unknown): ConversationTaskMetadata {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: ConversationTaskMetadata = { agentId: normalizeAgentId(raw.agentId) ?? GENERAL_ASSISTANT_ID };
  for (const key of ["businessKey", "taskStage"] as const) {
    if (typeof raw[key] === "string" && raw[key].trim()) result[key] = raw[key].trim();
  }
  if (["running", "waiting", "completed", "interrupted"].includes(raw.taskStatus as string)) result.taskStatus = raw.taskStatus as ConversationTaskStatus;
  for (const key of ["taskStartedAt", "taskCompletedAt", "taskInterruptedAt", "unreadAnswerAt", "lastReadAt", "taskMetadataUpdatedAt"] as const) {
    const at = raw[key];
    if (typeof at === "number" && Number.isFinite(at) && at >= 0
      && (key === "unreadAnswerAt" ? at > 0 : Number.isSafeInteger(at))) result[key] = at;
  }
  const pending = raw.pendingResponse as Partial<TaskPendingResponse> | null;
  if (pending && typeof pending.runId === "string" && pending.runId.trim()
    && typeof pending.questionId === "string" && pending.questionId.trim()
    && (pending.kind === "question" || pending.kind === "confirmation")) {
    result.pendingResponse = { runId: pending.runId.trim(), questionId: pending.questionId.trim(), kind: pending.kind };
  }
  return result;
}

export function applyConversationTaskMetadata<T extends ConversationTaskMetadata>(target: T, source: ConversationTaskMetadata): T {
  const metadata = normalizeConversationTaskMetadata(source);
  for (const key of CONVERSATION_TASK_METADATA_KEYS) delete target[key];
  return Object.assign(target, metadata);
}

/** A stale settings shell must hydrate from Catalog rather than publish its old fields. */
export function taskMetadataProjectionIsCurrent(shell: ConversationTaskMetadata, catalog: ConversationTaskMetadata): boolean {
  return catalog.taskMetadataUpdatedAt === undefined || shell.taskMetadataUpdatedAt === catalog.taskMetadataUpdatedAt;
}

/** Merge only fields still equal to the snapshot taken before asynchronous IO. */
export function applySavedTaskMetadataWithoutLosingEdits<T extends ConversationTaskMetadata>(
  target: T,
  saved: ConversationTaskMetadata,
  before: ConversationTaskMetadata
): T {
  const current = normalizeConversationTaskMetadata(target);
  if ((current.taskMetadataUpdatedAt ?? -1) > (saved.taskMetadataUpdatedAt ?? -1)) return target;
  const next = normalizeConversationTaskMetadata(saved);
  for (const key of CONVERSATION_TASK_METADATA_KEYS) {
    if (key === "taskMetadataUpdatedAt") continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(before[key])) {
      // Assignment must also preserve a deletion made while the write awaited IO.
      Object.assign(next, { [key]: current[key] });
    }
  }
  return applyConversationTaskMetadata(target, next);
}

/** Safe only after the caller has stopped active runs; preserves task/session/run identity. */
export function handoffConversationTask<T extends ConversationTaskMetadata>(task: T, fromAgentId: string): T {
  return task.agentId === fromAgentId ? { ...task, agentId: GENERAL_ASSISTANT_ID } : task;
}
