export type AgentInputModality = "text" | "image" | "pdf";
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

/** Phase 3 durable pointer to one exact excerpt in the current Vault. */
export interface KnowledgeReference {
  totalLines?: number;
  hasMore?: boolean;
  related?: import("./knowledge-relations").KnowledgeRelationPage;
  applicability?: import("./knowledge-relations").KnowledgeApplicability;
  referenceId: string;
  vaultRelativePath: string;
  title: string;
  excerpt: string;
  contentRevision: string;
  lineStart: number;
  lineEnd: number;
  /** Vault collection that owns this source. */
  sourceType?: "wiki" | "projects" | "raw";
  /** File modification time observed while the exact revision was read. */
  recordedAt?: number;
  /** Optional publication date declared in Markdown frontmatter. */
  publishedAt?: string;
  /** Local revision/source-link verification only; never implies web freshness. */
  verificationStatus?: "local_revision_verified" | "source_link_changed";
}

export interface KnowledgeRetrievalRequest {
  question: string;
  /** Exact Vault-relative Markdown paths explicitly named by the user. */
  explicitPaths?: readonly string[];
  /** Set only when the user explicitly asks for Raw/Inbox or unrefined material. */
  includeUnrefined?: boolean;
  /** Hard-capped at 20 for each disclosed page. */
  limit?: number;
  /** Opaque continuation returned by the Knowledge Agent index. */
  cursor?: string;
}

export interface KnowledgeRetrievalReadyResult {
  localIssues?: { vaultRelativePath: string; status: string }[];
  status: "ready";
  shouldInvokePi: true;
  references: KnowledgeReference[];
  total?: number;
  returned?: number;
  remaining?: number;
  hasMore?: boolean;
  exhausted?: boolean;
  continuationCursor?: string;
}

export interface KnowledgeRetrievalNoEvidenceResult {
  localIssues?: { vaultRelativePath: string; status: string }[];
  status: "no_evidence";
  /** New Knowledge Agent index paths invoke Pi; legacy scan callers may not. */
  shouldInvokePi: boolean;
  references: [];
  fixedResponse: string;
  total?: number;
  returned?: 0;
  remaining?: number;
  hasMore?: boolean;
  exhausted?: boolean;
  continuationCursor?: string;
}

export type KnowledgeRetrievalResult =
  | KnowledgeRetrievalReadyResult
  | KnowledgeRetrievalNoEvidenceResult;

export interface KnowledgeReferenceVerificationValid {
  status: "valid";
  references: KnowledgeReference[];
}

export interface KnowledgeReferenceVerificationChanged {
  status: "source_changed";
  references: [];
  changedReferenceIds: string[];
  fixedResponse: string;
}

export type KnowledgeReferenceVerificationResult =
  | KnowledgeReferenceVerificationValid
  | KnowledgeReferenceVerificationChanged;

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
  /** Detailed success outcome while the legacy status stays "success". */
  completion?: KnowledgeBaseRunCompletion;
  pendingSources?: string[];
  warnings?: KnowledgeBaseRunWarning[];
  structure?: StructureNormalizationResult;
  externalRawAdditions?: string[];
  digestEvidencePaths?: Record<string, string[]>;
  calibration?: KnowledgeBaseRawCalibrationResult;
  performance?: KnowledgeBaseRunPerformance;
  error?: string;
}

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
