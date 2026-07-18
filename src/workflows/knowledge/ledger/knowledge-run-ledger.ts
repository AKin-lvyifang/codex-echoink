import type { AgentBackendKind } from "../../../agent/types";

export type KnowledgeLedgerMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox" | "ask" | "journal" | "calibrate";
export type KnowledgeLedgerStatus = "success" | "failed" | "canceled" | "running";
export type KnowledgeRunCompletion = "full" | "partial" | "recovered" | "noop";
export type KnowledgeAttemptTerminalStatus = "completed" | "failed" | "canceled";
export type KnowledgeAttemptNativeKind = "thread" | "session" | "run" | "process";

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

export interface KnowledgeAttemptNativeRecord {
  id: string;
  kind: KnowledgeAttemptNativeKind;
  persistence?: "none" | "process-local" | "provider-persistent" | "unknown";
}

export interface KnowledgeAttemptSubmissionRecord {
  at: number;
  harnessRunId: string;
}

export interface KnowledgeAttemptTerminalRecord {
  status: KnowledgeAttemptTerminalStatus;
  at: number;
  message?: string;
}

export interface KnowledgeAttemptFailureRecord {
  /** Stable machine-readable code. The failure classifier owns the code vocabulary. */
  code: string;
  at: number;
  message: string;
  retryable: boolean;
  failoverEligible: boolean;
}

export interface KnowledgeAttemptTerminationRecord {
  requestedAt: number;
  confirmedAt?: number;
  failedAt?: number;
  message?: string;
}

export interface KnowledgeAttemptStagingRecord {
  path: string;
  preparedAt: number;
  promotedAt?: number;
  discardedAt?: number;
  failedAt?: number;
  message?: string;
}

export interface KnowledgeRunAttemptRecord {
  attemptId: string;
  ordinal: number;
  backend: AgentBackendKind;
  native?: KnowledgeAttemptNativeRecord;
  submitted?: KnowledgeAttemptSubmissionRecord;
  terminal?: KnowledgeAttemptTerminalRecord;
  failure?: KnowledgeAttemptFailureRecord;
  termination?: KnowledgeAttemptTerminationRecord;
  staging?: KnowledgeAttemptStagingRecord;
}

export interface KnowledgeCheckpointMetadata {
  checkpointId: string;
  createdAt: number;
  stagingPath?: string;
}

export interface KnowledgeCommitMetadata {
  commitId: string;
  checkpointId?: string;
  committedAt: number;
  sourcePaths: string[];
  operationCount: number;
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
  /** Optional so ledgers persisted before the resilience model remain readable. */
  selectedBackend?: AgentBackendKind;
  /** Stable, selected-first failover order captured at workflow start. */
  candidateBackends?: AgentBackendKind[];
  /** One entry per backend submission/preflight attempt, ordered by ordinal. */
  attempts?: KnowledgeRunAttemptRecord[];
  completion?: KnowledgeRunCompletion;
  pendingSources?: string[];
  /** Final workflow failure code. Attempt-level failures stay on attempts. */
  failureCode?: string;
  checkpoint?: KnowledgeCheckpointMetadata;
  commit?: KnowledgeCommitMetadata;
}

export interface CreateKnowledgeRunLedgerInput {
  runId: string;
  mode: KnowledgeLedgerMode;
  startedAt: number;
  selectedBackend?: AgentBackendKind;
  candidateBackends?: AgentBackendKind[];
  pendingSources?: string[];
}

export interface RecordKnowledgeRunCompletionInput {
  completion: KnowledgeRunCompletion;
  completedAt: number;
  pendingSources?: string[];
  checkpoint?: KnowledgeCheckpointMetadata;
  commit?: KnowledgeCommitMetadata;
}

export interface RecordKnowledgeRunFailureInput {
  failureCode: string;
  completedAt: number;
  pendingSources?: string[];
  checkpoint?: KnowledgeCheckpointMetadata;
  commit?: KnowledgeCommitMetadata;
}

export interface KnowledgeRunSummary {
  runId: string;
  mode: KnowledgeLedgerMode;
  status: KnowledgeLedgerStatus;
  processedSourceCount: number;
  appliedOperationCount: number;
  failedValidationCount: number;
  reportPath: string;
  selectedBackend?: AgentBackendKind;
  candidateBackends?: AgentBackendKind[];
  attemptedBackends?: AgentBackendKind[];
  attemptCount?: number;
  completedBackend?: AgentBackendKind;
  completion?: KnowledgeRunCompletion;
  pendingSourceCount?: number;
  failureCode?: string;
  checkpointId?: string;
  commitId?: string;
}

export function createKnowledgeRunLedger(input: CreateKnowledgeRunLedgerInput): KnowledgeRunLedger {
  const selectedBackend = input.selectedBackend ?? input.candidateBackends?.[0];
  const candidateBackends = normalizeCandidateBackends(selectedBackend, input.candidateBackends ?? []);
  const usesResilienceModel = Boolean(selectedBackend || candidateBackends.length || input.pendingSources);
  return {
    runId: input.runId,
    mode: input.mode,
    startedAt: input.startedAt,
    sources: [],
    operations: [],
    validations: [],
    warnings: [],
    artifacts: [],
    ...(usesResilienceModel ? {
      ...(selectedBackend ? { selectedBackend } : {}),
      candidateBackends,
      attempts: [],
      pendingSources: normalizePaths(input.pendingSources ?? [])
    } : {})
  };
}

export function knowledgeRunStatus(ledger: KnowledgeRunLedger): KnowledgeLedgerStatus {
  if (ledger.cancelledAt !== undefined) return "canceled";
  if (ledger.failureCode) return "failed";
  if (ledger.rollback?.status === "failed") return "failed";
  if (ledger.completion) return "success";
  if (ledger.validations.some((validation) => validation.status === "failed")) return "failed";
  if (ledger.operations.some((operation) => operation.status === "failed")) return "failed";
  if (ledger.completedAt === undefined && !ledger.artifacts.some((artifact) => artifact.kind === "markdown-report")) return "running";
  return "success";
}

export function summarizeKnowledgeRunLedger(ledger: KnowledgeRunLedger): KnowledgeRunSummary {
  const base: KnowledgeRunSummary = {
    runId: ledger.runId,
    mode: ledger.mode,
    status: knowledgeRunStatus(ledger),
    processedSourceCount: ledger.sources.filter((source) => source.status === "processed").length,
    appliedOperationCount: ledger.operations.filter((operation) => operation.status === "applied").length,
    failedValidationCount: ledger.validations.filter((validation) => validation.status === "failed").length,
    reportPath: ledger.artifacts.find((artifact) => artifact.kind === "markdown-report")?.path ?? ""
  };
  if (!hasResilienceMetadata(ledger)) return base;

  const attempts = [...(ledger.attempts ?? [])].sort((left, right) => left.ordinal - right.ordinal);
  const completedBackend = [...attempts].reverse().find((attempt) => attempt.terminal?.status === "completed")?.backend;
  return {
    ...base,
    ...(ledger.selectedBackend ? { selectedBackend: ledger.selectedBackend } : {}),
    candidateBackends: [...(ledger.candidateBackends ?? [])],
    attemptedBackends: unique(attempts.map((attempt) => attempt.backend)),
    attemptCount: attempts.length,
    ...(completedBackend ? { completedBackend } : {}),
    ...(ledger.completion ? { completion: ledger.completion } : {}),
    pendingSourceCount: ledger.pendingSources?.length ?? 0,
    ...(ledger.failureCode ? { failureCode: ledger.failureCode } : {}),
    ...(ledger.checkpoint ? { checkpointId: ledger.checkpoint.checkpointId } : {}),
    ...(ledger.commit ? { commitId: ledger.commit.commitId } : {})
  };
}

/**
 * Adds or enriches an attempt without mutating the ledger. Replaying the same
 * record is a no-op; reusing an attempt id or ordinal for another identity is
 * rejected instead of silently corrupting failover history.
 */
export function recordKnowledgeRunAttempt(
  ledger: KnowledgeRunLedger,
  input: KnowledgeRunAttemptRecord
): KnowledgeRunLedger {
  assertValidAttempt(input);
  const candidates = ledger.candidateBackends ?? [];
  if (candidates.length && !candidates.includes(input.backend)) {
    throw new Error(`attempt backend is not in candidateBackends: ${input.backend}`);
  }

  const attempts = ledger.attempts ?? [];
  const existingIndex = attempts.findIndex((attempt) => attempt.attemptId === input.attemptId);
  if (existingIndex >= 0) {
    const existing = attempts[existingIndex];
    if (existing.backend !== input.backend || existing.ordinal !== input.ordinal) {
      throw new Error(`attempt identity conflict: ${input.attemptId}`);
    }
    const merged = mergeAttempt(existing, input);
    if (merged === existing) return ledger;
    const nextAttempts = [...attempts];
    nextAttempts[existingIndex] = merged;
    return { ...ledger, attempts: nextAttempts };
  }

  const ordinalOwner = attempts.find((attempt) => attempt.ordinal === input.ordinal);
  if (ordinalOwner) {
    throw new Error(`attempt ordinal conflict: ${input.ordinal}`);
  }
  const nextAttempts = [...attempts, cloneAttempt(input)]
    .sort((left, right) => left.ordinal - right.ordinal);
  return { ...ledger, attempts: nextAttempts };
}

export function recordKnowledgeRunCompletion(
  ledger: KnowledgeRunLedger,
  input: RecordKnowledgeRunCompletionInput
): KnowledgeRunLedger {
  if (ledger.failureCode) throw new Error("failed ledger cannot be completed");
  const pendingSources = normalizePaths(input.pendingSources ?? []);
  if (input.completion === "partial" && !pendingSources.length) {
    throw new Error("partial completion requires pending sources");
  }
  if (input.completion !== "partial" && pendingSources.length) {
    throw new Error(`${input.completion} completion cannot have pending sources`);
  }

  let next = recordOutcomeMetadata(ledger, input.checkpoint, input.commit);
  if (next.completion && next.completion !== input.completion) {
    throw new Error(`completion conflict: ${next.completion} -> ${input.completion}`);
  }
  if (next.completedAt !== undefined && next.completedAt !== input.completedAt) {
    throw new Error(`completedAt conflict: ${next.completedAt} -> ${input.completedAt}`);
  }
  if (next.completion && next.pendingSources && !sameStringArray(next.pendingSources, pendingSources)) {
    throw new Error("pendingSources conflict");
  }
  if (
    next.completion === input.completion
    && next.completedAt === input.completedAt
    && sameStringArray(next.pendingSources ?? [], pendingSources)
  ) {
    return next;
  }
  return {
    ...next,
    completion: input.completion,
    completedAt: input.completedAt,
    pendingSources
  };
}

export function recordKnowledgeRunFailure(
  ledger: KnowledgeRunLedger,
  input: RecordKnowledgeRunFailureInput
): KnowledgeRunLedger {
  const failureCode = input.failureCode.trim();
  if (!failureCode) throw new Error("failureCode is required");
  if (ledger.completion) throw new Error("completed ledger cannot be failed");
  const pendingSources = normalizePaths(input.pendingSources ?? []);
  let next = recordOutcomeMetadata(ledger, input.checkpoint, input.commit);
  if (next.failureCode && next.failureCode !== failureCode) {
    throw new Error(`failureCode conflict: ${next.failureCode} -> ${failureCode}`);
  }
  if (next.completedAt !== undefined && next.completedAt !== input.completedAt) {
    throw new Error(`completedAt conflict: ${next.completedAt} -> ${input.completedAt}`);
  }
  if (next.failureCode && next.pendingSources && !sameStringArray(next.pendingSources, pendingSources)) {
    throw new Error("pendingSources conflict");
  }
  if (
    next.failureCode === failureCode
    && next.completedAt === input.completedAt
    && sameStringArray(next.pendingSources ?? [], pendingSources)
  ) {
    return next;
  }
  return {
    ...next,
    failureCode,
    completedAt: input.completedAt,
    pendingSources
  };
}

export function recordKnowledgeRunCheckpoint(
  ledger: KnowledgeRunLedger,
  input: KnowledgeCheckpointMetadata
): KnowledgeRunLedger {
  const checkpoint = cloneCheckpoint(input);
  if (!checkpoint.checkpointId.trim()) throw new Error("checkpointId is required");
  if (!ledger.checkpoint) return { ...ledger, checkpoint };
  if (!sameCheckpoint(ledger.checkpoint, checkpoint)) {
    throw new Error(`checkpoint conflict: ${ledger.checkpoint.checkpointId}`);
  }
  return ledger;
}

export function recordKnowledgeRunCommit(
  ledger: KnowledgeRunLedger,
  input: KnowledgeCommitMetadata
): KnowledgeRunLedger {
  const commit = cloneCommit(input);
  if (!commit.commitId.trim()) throw new Error("commitId is required");
  if (!Number.isInteger(commit.operationCount) || commit.operationCount < 0) {
    throw new Error("commit operationCount must be a non-negative integer");
  }
  if (ledger.checkpoint && commit.checkpointId && ledger.checkpoint.checkpointId !== commit.checkpointId) {
    throw new Error(`commit checkpoint conflict: ${commit.checkpointId}`);
  }
  if (!ledger.commit) return { ...ledger, commit };
  if (!sameCommit(ledger.commit, commit)) {
    throw new Error(`commit conflict: ${ledger.commit.commitId}`);
  }
  return ledger;
}

function recordOutcomeMetadata(
  ledger: KnowledgeRunLedger,
  checkpoint?: KnowledgeCheckpointMetadata,
  commit?: KnowledgeCommitMetadata
): KnowledgeRunLedger {
  let next = ledger;
  if (checkpoint) next = recordKnowledgeRunCheckpoint(next, checkpoint);
  if (commit) next = recordKnowledgeRunCommit(next, commit);
  return next;
}

function assertValidAttempt(input: KnowledgeRunAttemptRecord): void {
  if (!input.attemptId.trim()) throw new Error("attemptId is required");
  if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
    throw new Error("attempt ordinal must be a positive integer");
  }
  if (input.terminal?.status === "completed" && input.failure) {
    throw new Error("completed attempt cannot contain failure");
  }
  if (input.termination?.confirmedAt !== undefined && input.termination.failedAt !== undefined) {
    throw new Error("attempt termination cannot be both confirmed and failed");
  }
  const stagingSettlements = [
    input.staging?.promotedAt,
    input.staging?.discardedAt,
    input.staging?.failedAt
  ].filter((value) => value !== undefined);
  if (stagingSettlements.length > 1) {
    throw new Error("attempt staging can have only one settlement");
  }
}

function mergeAttempt(
  existing: KnowledgeRunAttemptRecord,
  input: KnowledgeRunAttemptRecord
): KnowledgeRunAttemptRecord {
  const native = mergeEvidence("native", existing.native, input.native);
  const submitted = mergeEvidence("submitted", existing.submitted, input.submitted);
  const terminal = mergeEvidence("terminal", existing.terminal, input.terminal);
  const failure = mergeEvidence("failure", existing.failure, input.failure);
  const termination = mergeEvidence("termination", existing.termination, input.termination);
  const staging = mergeEvidence("staging", existing.staging, input.staging);
  if (
    native === existing.native
    && submitted === existing.submitted
    && terminal === existing.terminal
    && failure === existing.failure
    && termination === existing.termination
    && staging === existing.staging
  ) {
    return existing;
  }
  const merged: KnowledgeRunAttemptRecord = {
    attemptId: existing.attemptId,
    ordinal: existing.ordinal,
    backend: existing.backend,
    ...(native ? { native } : {}),
    ...(submitted ? { submitted } : {}),
    ...(terminal ? { terminal } : {}),
    ...(failure ? { failure } : {}),
    ...(termination ? { termination } : {}),
    ...(staging ? { staging } : {})
  };
  assertValidAttempt(merged);
  return merged;
}

function mergeEvidence<T extends object>(label: string, existing: T | undefined, input: T | undefined): T | undefined {
  if (!input) return existing;
  if (!existing) return { ...input };
  let changed = false;
  const merged = { ...existing } as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const current = (existing as Record<string, unknown>)[key];
    if (current === undefined) {
      merged[key] = value;
      changed = true;
      continue;
    }
    if (current !== value) throw new Error(`attempt ${label} conflict: ${key}`);
  }
  return changed ? merged as T : existing;
}

function cloneAttempt(input: KnowledgeRunAttemptRecord): KnowledgeRunAttemptRecord {
  return {
    attemptId: input.attemptId,
    ordinal: input.ordinal,
    backend: input.backend,
    ...(input.native ? { native: { ...input.native } } : {}),
    ...(input.submitted ? { submitted: { ...input.submitted } } : {}),
    ...(input.terminal ? { terminal: { ...input.terminal } } : {}),
    ...(input.failure ? { failure: { ...input.failure } } : {}),
    ...(input.termination ? { termination: { ...input.termination } } : {}),
    ...(input.staging ? { staging: { ...input.staging } } : {})
  };
}

function normalizeCandidateBackends(
  selectedBackend: AgentBackendKind | undefined,
  candidates: AgentBackendKind[]
): AgentBackendKind[] {
  return unique([
    ...(selectedBackend ? [selectedBackend] : []),
    ...candidates
  ]);
}

function normalizePaths(paths: string[]): string[] {
  return unique(paths.map((item) => item.trim()).filter(Boolean));
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function hasResilienceMetadata(ledger: KnowledgeRunLedger): boolean {
  return Boolean(
    ledger.selectedBackend
    || ledger.candidateBackends?.length
    || ledger.attempts?.length
    || ledger.completion
    || ledger.pendingSources?.length
    || ledger.failureCode
    || ledger.checkpoint
    || ledger.commit
  );
}

function cloneCheckpoint(input: KnowledgeCheckpointMetadata): KnowledgeCheckpointMetadata {
  return {
    checkpointId: input.checkpointId,
    createdAt: input.createdAt,
    ...(input.stagingPath ? { stagingPath: input.stagingPath } : {})
  };
}

function cloneCommit(input: KnowledgeCommitMetadata): KnowledgeCommitMetadata {
  return {
    commitId: input.commitId,
    ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
    committedAt: input.committedAt,
    sourcePaths: normalizePaths(input.sourcePaths),
    operationCount: input.operationCount
  };
}

function sameCheckpoint(left: KnowledgeCheckpointMetadata, right: KnowledgeCheckpointMetadata): boolean {
  return left.checkpointId === right.checkpointId
    && left.createdAt === right.createdAt
    && left.stagingPath === right.stagingPath;
}

function sameCommit(left: KnowledgeCommitMetadata, right: KnowledgeCommitMetadata): boolean {
  return left.commitId === right.commitId
    && left.checkpointId === right.checkpointId
    && left.committedAt === right.committedAt
    && left.operationCount === right.operationCount
    && sameStringArray(left.sourcePaths, right.sourcePaths);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
