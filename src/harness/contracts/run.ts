import type { ContextManifest, ContextSection, ContextSyncCursor } from "./context";
import type { NativeExecutionKind, NativeExecutionRef, NativeSessionLease } from "./native-execution";

export type HarnessSurface = "chat" | "knowledge" | "editor" | "review" | "system";

export type HarnessWorkflow =
  | "chat.generic"
  | "backend.probe"
  | "prompt.enhance"
  | "knowledge.ask"
  | "knowledge.check"
  | "knowledge.maintain"
  | "knowledge.reingest"
  | "knowledge.calibrate"
  | "knowledge.outputs"
  | "knowledge.inbox"
  | "knowledge.journal"
  | "editor.rewrite"
  | "editor.expand"
  | "editor.continue"
  | "editor.translate"
  | "review.weekly"
  | "memory.curate";

export interface HarnessWorkspace {
  vaultPath: string;
  cwd: string;
}

export interface HarnessUserInput {
  text: string;
  attachments: Array<{
    type: "file" | "image" | "pdf";
    path: string;
    name?: string;
    mime?: string;
  }>;
}

export interface HarnessPermissionPolicy {
  mode: "read-only" | "workspace-write" | "danger-full-access";
  writableRoots: string[];
  requireApproval: boolean;
}

export type ResourcePlane = "echoink-builtin" | "echoink-vault" | "agent-native" | "imported-copy";

export interface ResourceRef {
  plane: ResourcePlane;
  backendId?: string;
  resourceId: string;
}

export interface ResourceSelectionSnapshot {
  selected: ResourceRef[];
  resolvedAt: number;
  warnings: string[];
}

export interface MemoryPolicy {
  enabled: boolean;
  maxItems: number;
}

export interface OutputContract {
  kind: "plain-text" | "knowledge-ledger" | "editor-candidate" | "review-report";
}

export interface HarnessRunRequest {
  runId: string;
  sessionId: string;
  surface: HarnessSurface;
  workflow: HarnessWorkflow;
  backendId: string;
  workspace: HarnessWorkspace;
  input: HarnessUserInput;
  permissions: HarnessPermissionPolicy;
  resourceSelection: ResourceSelectionSnapshot;
  memoryPolicy: MemoryPolicy;
  outputContract: OutputContract;
  vaultProfileSections?: ContextSection[];
}

export interface BackendSessionBinding {
  backendId: string;
  nativeSessionId?: string;
  nativeThreadId?: string;
  nativeExecutionKind?: NativeExecutionKind;
  nativeExecutionRef?: NativeExecutionRef;
  leaseId?: string;
  leaseStatus?: NativeSessionLease["status"];
  leaseCreatedAt?: number;
  leaseLastUsedAt?: number;
  leaseExpiresAt?: number;
  leaseTurnCount?: number;
  leaseMaxTurns?: number;
  leaseContextChars?: number;
  leaseMaxContextChars?: number;
  contextCheckpointMessageId?: string;
  syncedThroughMessageId?: string;
  syncedSessionRevision: number;
  snapshotVersion?: string;
  contextCursor?: ContextSyncCursor;
  workspaceFingerprint?: string;
  vaultProfileFingerprint?: string;
  lastUsedAt: number;
  capabilitySnapshot?: unknown;
}

export interface HarnessRunResult {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  outputText?: string;
  nativeExecution?: NativeExecutionRef;
  nativeExecutionRecordIds?: string[];
  backendBinding?: BackendSessionBinding;
  contextManifest?: ContextManifest;
  effectiveModel?: {
    providerId: string;
    modelId: string;
  };
  error?: string;
}
