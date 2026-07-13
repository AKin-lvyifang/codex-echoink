export type HistoryAuthority = "echoink" | "backend" | "hybrid";

export type NativeExecutionKind = "thread" | "session" | "run" | "process";

export type NativeExecutionPersistence = "none" | "process-local" | "provider-persistent" | "unknown";

export type NativeExecutionMode = "ephemeral-run" | "leased-conversation" | "persistent-native";

export type NativeDisposition = "process-exit" | "archive" | "delete" | "retain";

export interface NativeExecutionRef {
  backendId: string;
  id: string;
  kind: NativeExecutionKind;
  persistence: NativeExecutionPersistence;
  providerEndpoint?: string;
  deviceKey: string;
  vaultId: string;
  createdAt: number;
}

export interface NativeSessionPolicy {
  historyAuthority: HistoryAuthority;
  mode: NativeExecutionMode;
  preferredDisposition: NativeDisposition[];
  retainWhenLocalCommitFails: boolean;
  cleanupRequiredForTaskSuccess: false;
}

export interface NativeExecutionCapabilities {
  persistence: NativeExecutionPersistence;
  dispositions: {
    processExit: boolean;
    archive: boolean;
    delete: boolean;
  };
  idempotentDisposition: boolean;
  canInspectExistence: boolean;
}

export interface NativeExecutionDispositionRequest {
  ref: NativeExecutionRef;
  requested: NativeDisposition;
  reason: "knowledge-run-completed" | "knowledge-run-failed" | "knowledge-run-cancelled" | "recovery" | "manual";
}

export interface NativeExecutionDispositionResult {
  outcome: "disposed" | "already-disposed" | "retained" | "unsupported" | "failed";
  applied?: NativeDisposition;
  message?: string;
}

export interface LocalRunCommitResult {
  committed: boolean;
  conversationCommitted: boolean;
  runLedgerCommitted: boolean;
  artifactsCommitted: boolean;
  historyIndexCommitted: boolean;
  error?: string;
}

export type NativeRunOutcome = "success" | "failed" | "cancelled";

export type NativeLocalCommitStatus = "pending" | "committed" | "failed";

export type NativeCleanupStatus = "not-needed" | "pending" | "disposed" | "unsupported" | "failed" | "retained-for-recovery" | "retained";

export interface NativeExecutionRecord {
  id: string;
  runId: string;
  sessionId: string;
  surface: "knowledge" | "editor" | "review" | "chat";
  workflow: string;
  native: NativeExecutionRef;
  policy: NativeSessionPolicy;
  runOutcome?: NativeRunOutcome;
  localCommit: NativeLocalCommitStatus;
  cleanup: NativeCleanupStatus;
  requestedDisposition?: NativeDisposition;
  appliedDisposition?: NativeDisposition;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  createdAt: number;
  settledAt: number;
  committedAt: number;
  disposedAt: number;
  emitEvents?: boolean;
  dispositionReason?: NativeExecutionDispositionRequest["reason"];
}

export interface NativeSessionLease {
  leaseId: string;
  echoInkSessionId: string;
  backendId: string;
  native: NativeExecutionRef;
  mode: "leased-conversation";
  status: "active" | "expired" | "cleanup-pending" | "disposed" | "failed";
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  turnCount: number;
  maxTurns: number;
  contextCheckpointMessageId?: string;
  providerContextWindow?: number;
  contextChars?: number;
  maxContextChars?: number;
}
