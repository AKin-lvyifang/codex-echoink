import type { ContextSection } from "../contracts/context";
import type { HarnessWorkspace } from "../contracts/run";

export interface MemoryRetrievalRequest {
  runId: string;
  sessionId: string;
  workspace: HarnessWorkspace;
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
}
