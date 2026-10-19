import type { AgentRunSnapshot } from "../agents/types";
import type { EchoInkQuestionAnswer, EchoInkQuestionPrompt } from "../types/conversation-turn";
import type { MobilePermission } from "./store";

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
}

export interface MobileTaskSubmission {
  taskId: string;
  queued: boolean;
  completion: Promise<void>;
}
