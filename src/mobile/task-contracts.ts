import type { AgentRunSnapshot } from "../agents/types";
import type { EchoInkQuestionAnswer, EchoInkQuestionPrompt } from "../types/conversation-turn";
import type { MobilePermission } from "./store";
import type { TaskInterruptionReason } from "../agents/task-resume";

export type MobileInterruptionReason = TaskInterruptionReason | "app_backgrounded";
export interface MobileTaskInterruption {
  at: number;
  reason: MobileInterruptionReason;
  stage: string;
}
/** Local effect facts; never a permission grant or an automatic retry instruction. */
export interface MobileWriteOperation {
  id: string;
  taskId: string;
  runId: string;
  toolCallId: string;
  toolName: "note_create" | "memory_write" | "mcp_write";
  /** External effect identity only; never authentication headers or arguments. */
  mcp?: { resourceId: string; toolName: string };
  semanticKey: string;
  status: "prepared" | "started" | "completed" | "uncertain";
  createdAt: number;
  updatedAt: number;
  target: string;
  expectedHash: string;
  targetWasMissing?: boolean;
  beforeRevision?: number;
  completedRevision?: number;
}
export interface MobileResumeIssue {
  operationId: string;
  target: string;
  status: "unknown" | "conflict";
  label: string;
}
export interface MobileResumeSnapshot {
  taskId: string;
  fingerprint: string;
  checkedAt: number;
  issues: MobileResumeIssue[];
  operations: MobileWriteOperation[];
  observations: { target: string; version: string }[];
}
export interface MobileToolExecutionContext {
  runId: string;
  resume?: MobileResumeSnapshot;
}

/** Provider identifiers only. Credentials never enter task storage. */
export interface MobileQueuedTurn {
  id: string;
  text: string;
  createdAt: number;
  agentSnapshot: AgentRunSnapshot;
  providerId: string;
  modelId: string;
  permission: MobilePermission;
  notePath: string;
  skillId?: string;
}

export interface MobileTaskInteraction {
  taskId: string;
  runId: string;
  questionId: string;
  kind: "question" | "confirmation";
  status: "pending" | "answered" | "cancelled";
  questions: EchoInkQuestionPrompt[];
  answers?: EchoInkQuestionAnswer[];
  createdAt: number;
}

export interface MobileContextSummary {
  text: string;
  throughMessageCount: number;
  sourceDigest: string;
  createdAt: number;
}

export interface MobileTaskViewState {
  taskId: string;
  busy: boolean;
  error: string;
  queuedCount: number;
  paused: boolean;
  interaction?: MobileTaskInteraction;
  interruption?: MobileTaskInterruption;
  resuming?: boolean;
  resumeReview?: MobileResumeSnapshot;
}

export interface MobileTaskSubmission {
  taskId: string;
  queued: boolean;
  completion: Promise<void>;
}
