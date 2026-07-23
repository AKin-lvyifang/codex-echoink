import type { AgentBackendKind, AgentInputModality } from "../agent/types";
import type { HarnessEventType } from "../harness/contracts/event";

export type KnowledgeBaseRunMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox";
export type KnowledgeBaseCommandUiMode = KnowledgeBaseRunMode | "calibrate";
export type KnowledgeWorkflowPhaseId = "prepare" | "digest" | "organize" | "report" | "complete";

export interface KnowledgeBaseRunPhasePerformance {
  id: KnowledgeWorkflowPhaseId;
  title: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  status: "success" | "failed" | "canceled";
}

export interface KnowledgeBaseRunPerformance {
  startedAt: number;
  completedAt: number;
  totalMs: number;
  agentCalled: boolean;
  phases: KnowledgeBaseRunPhasePerformance[];
  index?: {
    reused: number;
    refreshed: number;
    targets: number;
  };
}

export interface KnowledgeWorkflowEvent {
  type: Extract<HarnessEventType,
    | "workflow.started"
    | "workflow.phase.started"
    | "workflow.phase.progress"
    | "workflow.phase.completed"
    | "workflow.phase.failed"
    | "workflow.validation.result"
    | "workflow.transaction.committed"
    | "workflow.transaction.rolled_back"
    | "workflow.artifact.created"
    | "workflow.report.ready"
    | "workflow.completed">;
  phaseId?: KnowledgeWorkflowPhaseId;
  title?: string;
  status?: "running" | "success" | "failed" | "canceled";
  current?: number;
  total?: number;
  message?: string;
  createdAt: number;
}

export type KnowledgeBaseCitationBucket = "wiki" | "journal" | "outputs";
export type KnowledgeBaseEvidenceStatus = "strong" | "weak" | "none";

export interface KnowledgeBaseSource {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtime: number;
  fingerprint: string;
  mime: string;
  modality: AgentInputModality;
  changed: boolean;
  readStrategy?: {
    kind: "chunked-text";
    maxChunkBytes: number;
  };
}

export interface KnowledgeBaseSkippedSource {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtime: number;
  fingerprint: string;
  mime: string;
  modality: AgentInputModality;
  changed: true;
  reason: string;
}

export type KnowledgeBaseRawDigestState = "digested" | "pending" | "changed" | "calibration" | "failed";

export interface KnowledgeBaseRawDigestStatus {
  digested: number;
  pending: number;
  changed: number;
  calibration: number;
  failed: number;
}

export interface KnowledgeBaseCitation {
  bucket: KnowledgeBaseCitationBucket;
  title: string;
  path: string;
  excerptLines: string[];
  relevance: Exclude<KnowledgeBaseEvidenceStatus, "none">;
  reason: string;
  score: number;
}

export interface KnowledgeBaseCitationSummary {
  status: KnowledgeBaseEvidenceStatus;
  counts: Record<KnowledgeBaseCitationBucket, number>;
  citations: KnowledgeBaseCitation[];
}

export interface KnowledgeBaseDiscovery {
  vaultPath: string;
  sources: KnowledgeBaseSource[];
  changedSources: KnowledgeBaseSource[];
  skippedSources: KnowledgeBaseSkippedSource[];
  reportPath: string;
  trackerPath: string;
  indexStats?: {
    reused: number;
    refreshed: number;
  };
}

export type KnowledgeBaseRunCompletion = "full" | "partial" | "recovered" | "noop";
export type KnowledgeRunAttemptTerminalStatus = "completed" | "failed" | "canceled";
export type KnowledgeRunAttemptNativeKind = "thread" | "session" | "run" | "process";
export type KnowledgeRunAttemptPhase =
  | "preflight"
  | "execution"
  | "verification"
  | "commit"
  | "cleanup";

export type KnowledgeBaseRunTerminalPhase =
  | KnowledgeRunAttemptPhase
  | "finalized"
  | "recovery-blocked";
export type KnowledgeBaseRunCommitState =
  | "pre-wal"
  | "wal-persisted"
  | "committed";

export interface KnowledgeRunAttemptNativeRecord {
  id: string;
  /** Omitted when the backend exposed only an opaque native id. */
  kind?: KnowledgeRunAttemptNativeKind;
  persistence?: "none" | "process-local" | "provider-persistent" | "unknown";
}

export interface KnowledgeRunAttemptSubmissionRecord {
  at: number;
  harnessRunId: string;
}

export interface KnowledgeRunAttemptTerminalRecord {
  status: KnowledgeRunAttemptTerminalStatus;
  at: number;
  message?: string;
}

export interface KnowledgeRunAttemptFailureRecord {
  code: string;
  at: number;
  message: string;
  phase: KnowledgeRunAttemptPhase;
  retryable: boolean;
  failoverEligible: boolean;
}

export interface KnowledgeRunAttemptTerminationRecord {
  requestedAt?: number;
  confirmedAt?: number;
  failedAt?: number;
  message?: string;
}

export interface KnowledgeRunAttemptStagingRecord {
  path: string;
  preparedAt: number;
  promotedAt?: number;
  discardedAt?: number;
  failedAt?: number;
  message?: string;
}

/**
 * Compact, serializable attempt evidence exposed by the maintenance Harness.
 * The field is optional on run results so older callers remain valid.
 */
export interface KnowledgeRunAttemptRecord {
  attemptId: string;
  ordinal: number;
  backend: AgentBackendKind;
  native?: KnowledgeRunAttemptNativeRecord;
  submitted?: KnowledgeRunAttemptSubmissionRecord;
  terminal?: KnowledgeRunAttemptTerminalRecord;
  failure?: KnowledgeRunAttemptFailureRecord;
  termination?: KnowledgeRunAttemptTerminationRecord;
  staging?: KnowledgeRunAttemptStagingRecord;
}

export interface KnowledgeBaseRunWarning {
  id: string;
  message: string;
}

export interface KnowledgeBaseRunResult {
  status: "success" | "failed" | "canceled";
  reportPath: string;
  summary: string;
  processedSources: KnowledgeBaseSource[];
  /** Stable trigger id shared by UI, WAL, settings history and recovery. */
  workflowRunId?: string;
  /** Agent selected synchronously when this maintenance invocation started. */
  selectedBackend?: AgentBackendKind;
  /**
   * Agent whose sealed outcome became the workflow winner. Deterministic
   * no-op runs explicitly use null because no Agent was invoked.
   */
  winnerBackend?: AgentBackendKind | null;
  /** Last trusted business/workflow phase reached by this result. */
  terminalPhase?: KnowledgeBaseRunTerminalPhase;
  /** Durable commit boundary reached by this run. */
  commitState?: KnowledgeBaseRunCommitState;
  /** Detailed success outcome while the legacy status stays "success". */
  completion?: KnowledgeBaseRunCompletion;
  attempts?: KnowledgeRunAttemptRecord[];
  pendingSources?: string[];
  /** Null is the explicit success value for durable maintenance terminals. */
  failureCode?: string | null;
  warnings?: KnowledgeBaseRunWarning[];
  structure?: StructureNormalizationResult;
  externalRawAdditions?: string[];
  digestEvidencePaths?: Record<string, string[]>;
  calibration?: KnowledgeBaseRawCalibrationResult;
  performance?: KnowledgeBaseRunPerformance;
  error?: string;
}

/**
 * Canonical result contract for the WAL-backed maintain/reingest workflow.
 * Other knowledge-base modes intentionally keep the backward-compatible,
 * optional KnowledgeBaseRunResult metadata above.
 */
export type KnowledgeBaseDurableMaintenanceResult = Omit<
  KnowledgeBaseRunResult,
  | "workflowRunId"
  | "selectedBackend"
  | "winnerBackend"
  | "terminalPhase"
  | "commitState"
  | "attempts"
  | "failureCode"
> & {
  workflowRunId: string;
  selectedBackend: AgentBackendKind;
  winnerBackend: AgentBackendKind | null;
  terminalPhase: KnowledgeBaseRunTerminalPhase;
  commitState: KnowledgeBaseRunCommitState;
  attempts: KnowledgeRunAttemptRecord[];
  /** Null on success; a stable non-empty code on failed/canceled projections. */
  failureCode: string | null;
};

export interface KnowledgeBaseRawCalibrationResult {
  marked: KnowledgeBaseSource[];
  review: KnowledgeBaseSource[];
  changed: KnowledgeBaseSource[];
  evidencePaths: Record<string, string[]>;
}

export interface StructureNormalizationMove {
  from: string;
  to: string;
  kind: "file" | "directory";
  reason: string;
}

export interface StructureNormalizationSkipped {
  from: string;
  to?: string;
  reason: string;
}

export interface StructureNormalizationUpdatedLink {
  path: string;
  replacements: number;
}

export interface StructureNormalizationPathRewrite {
  from: string;
  to: string;
  kind: "file" | "directory";
}

export interface StructureNormalizationResult {
  moves: StructureNormalizationMove[];
  skipped: StructureNormalizationSkipped[];
  updatedLinks: StructureNormalizationUpdatedLink[];
  remainingRootNotes: string[];
  remainingChineseDirs: string[];
  risks: string[];
  pathRewrites: StructureNormalizationPathRewrite[];
  updatedLastReportPath?: string;
}
