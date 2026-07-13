export type KnowledgeLedgerMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox" | "ask" | "journal" | "calibrate";
export type KnowledgeLedgerStatus = "success" | "failed" | "canceled" | "running";

export interface SourceRunRecord {
  path: string;
  fingerprint: string;
  status: "pending" | "processed" | "skipped" | "failed";
  message?: string;
}

export interface KnowledgeOperationRecord {
  type: "create-page" | "upsert-page" | "update-index" | "update-tracker" | "raw-managed-metadata" | "move-page";
  targetPath: string;
  sourcePath?: string;
  status: "proposed" | "applied" | "reverted" | "failed";
  message?: string;
}

export interface ValidationRecord {
  id: string;
  status: "passed" | "failed" | "warning";
  message: string;
}

export interface WorkflowWarning {
  id: string;
  message: string;
}

export interface RollbackRecord {
  status: "not-needed" | "completed" | "failed";
  message: string;
}

export interface ArtifactRecord {
  kind: "markdown-report" | "ui-card" | "tracker" | "history";
  path: string;
}

export interface KnowledgeRunLedger {
  runId: string;
  mode: KnowledgeLedgerMode;
  startedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  sources: SourceRunRecord[];
  operations: KnowledgeOperationRecord[];
  validations: ValidationRecord[];
  warnings: WorkflowWarning[];
  rollback?: RollbackRecord;
  artifacts: ArtifactRecord[];
  agentFinalText?: string;
}

export interface CreateKnowledgeRunLedgerInput {
  runId: string;
  mode: KnowledgeLedgerMode;
  startedAt: number;
}

export interface KnowledgeRunSummary {
  runId: string;
  mode: KnowledgeLedgerMode;
  status: KnowledgeLedgerStatus;
  processedSourceCount: number;
  appliedOperationCount: number;
  failedValidationCount: number;
  reportPath: string;
}

export function createKnowledgeRunLedger(input: CreateKnowledgeRunLedgerInput): KnowledgeRunLedger {
  return {
    runId: input.runId,
    mode: input.mode,
    startedAt: input.startedAt,
    sources: [],
    operations: [],
    validations: [],
    warnings: [],
    artifacts: []
  };
}

export function knowledgeRunStatus(ledger: KnowledgeRunLedger): KnowledgeLedgerStatus {
  if (ledger.cancelledAt) return "canceled";
  if (ledger.validations.some((validation) => validation.status === "failed")) return "failed";
  if (ledger.operations.some((operation) => operation.status === "failed")) return "failed";
  if (ledger.rollback?.status === "failed") return "failed";
  if (!ledger.completedAt && !ledger.artifacts.some((artifact) => artifact.kind === "markdown-report")) return "running";
  return "success";
}

export function summarizeKnowledgeRunLedger(ledger: KnowledgeRunLedger): KnowledgeRunSummary {
  return {
    runId: ledger.runId,
    mode: ledger.mode,
    status: knowledgeRunStatus(ledger),
    processedSourceCount: ledger.sources.filter((source) => source.status === "processed").length,
    appliedOperationCount: ledger.operations.filter((operation) => operation.status === "applied").length,
    failedValidationCount: ledger.validations.filter((validation) => validation.status === "failed").length,
    reportPath: ledger.artifacts.find((artifact) => artifact.kind === "markdown-report")?.path ?? ""
  };
}
