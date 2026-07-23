import type { ContextSection } from "../contracts/context";
import type { HarnessEvent } from "../contracts/event";
import type { HarnessRunRequest, HarnessWorkflow, HarnessWorkspace } from "../contracts/run";
import type { MemorySyncResult } from "./v2-engine";

export interface MemoryRetrievalRequest {
  runId: string;
  sessionId: string;
  workspace: HarnessWorkspace;
  workflow?: HarnessWorkflow;
  query: string;
  maxItems: number;
}

export interface MemoryBundle {
  providerId: string;
  items: MemoryItem[];
  sections: ContextSection[];
}

export interface MemoryItem {
  id: string;
  kind: "current-state" | "preference" | "decision" | "constraint" | "open-loop" | "task-state" | "workflow-rule" | "lesson";
  scope?: string;
  statement: string;
  evidenceRefs?: string[];
  sourceRunId?: string;
  sourceConversationIds?: string[];
  sourceDeletions?: Array<{
    mutationId: string;
    conversationId: string;
    deletedAt: number;
    forwardTransactionId: string;
    restoredAt?: number;
    restoreTransactionId?: string;
  }>;
  confidence: number;
  createdAt?: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface MemoryProposalRequest {
  runId: string;
  sessionId: string;
  workspace: HarnessWorkspace;
  transcript: string;
}

export interface MemoryCandidate {
  id: string;
  kind: MemoryItem["kind"];
  scope?: string;
  statement: string;
  evidenceRefs: string[];
  sourceRunId: string;
  sourceConversationIds?: string[];
  confidence: number;
  requiresConfirmation?: boolean;
  confirmed?: boolean;
  duplicateOf?: string;
  conflictsWith?: string[];
}

export interface MemoryCommitResult {
  committed: string[];
  skipped: string[];
  pendingConfirmation?: string[];
  conflicts?: string[];
}

export interface MemoryProvider {
  retrieve(request: MemoryRetrievalRequest): Promise<MemoryBundle>;
  propose(request: MemoryProposalRequest): Promise<MemoryCandidate[]>;
  commit(candidates: MemoryCandidate[]): Promise<MemoryCommitResult>;
  supersede(memoryId: string, reason: string): Promise<void>;
  beginRun?(request: HarnessRunRequest): Promise<void>;
  observeRunEvent?(event: HarnessEvent): Promise<MemorySyncResult | void>;
  syncPending?(): Promise<MemorySyncResult>;
  recover?(): Promise<unknown>;
}
