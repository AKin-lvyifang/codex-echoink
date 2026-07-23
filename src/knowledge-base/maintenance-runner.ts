import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type {
  AgentBackendKind,
  AgentExactWriteFenceReceipt
} from "../agent/types";
import { isTrustedExactWriteFenceReceipt } from "../agent/write-fence";
import {
  abandonMaintenanceShadowVault,
  applyShadowChangeSet,
  attestMaintenanceShadowZeroResult,
  cleanupMaintenanceShadowVault,
  confirmMaintenanceShadowTransportConfigFence,
  createMaintenanceShadowTransportConfigReceipt,
  createMaintenanceShadowVault,
  maintenanceShadowExecutionBoundary,
  maintenanceShadowResultCasForPath,
  markMaintenanceShadowTerminal,
  quarantineMaintenanceShadowZeroResult,
  recoverMaintenanceShadowApplyTransactions,
  sealMaintenanceShadowVault,
  type MaintenanceShadowChangeSet,
  type MaintenanceShadowHandle,
  type MaintenanceShadowSourceChunk,
  type MaintenanceShadowZeroResultAttestation
} from "../harness/maintenance/shadow-vault";
import type {
  LoadedMaintenanceWorkflowWal,
  MaintenanceWorkflowIndexCommitRecord,
  MaintenanceWorkflowManagedWriteDraft,
  MaintenanceWorkflowNoopReceiptContract,
  MaintenanceWorkflowScheduledProjection,
  MaintenanceWorkflowSourceRecord,
  MaintenanceWorkflowWalPhase
} from "../harness/maintenance/workflow-wal";
import {
  MAINTENANCE_WORKFLOW_NOOP_RECEIPT_SCHEMA_VERSION,
  listMaintenanceWorkflowWals,
  loadMaintenanceWorkflowWal,
  maintenanceWorkflowNoopReceiptPath
} from "../harness/maintenance/workflow-wal";
import {
  createActiveMaintenanceRunJournal,
  listActiveMaintenanceRunJournals,
  removeActiveMaintenanceRunJournal,
  updateActiveMaintenanceRunJournal,
  type ActiveMaintenanceRunTerminalPhase,
  type LoadedActiveMaintenanceRunJournal
} from "../harness/maintenance/active-run-journal";
import {
  canonicalizeKnowledgeBaseMaintenanceHistoryEntry,
  recordKnowledgeBaseMaintenanceRun,
  type KnowledgeBaseManagedThreadKind,
  type KnowledgeBaseProcessedSource,
  type KnowledgeBaseSettings
} from "../settings/settings";
import type { PermissionMode } from "../types/app-server";
import {
  evaluateDigestEvidence,
  verifyDigestEvidence,
  type DigestEvidencePendingSource
} from "./digest-evidence";
import { isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import {
  buildKnowledgeBaseFallbackReportContent,
  buildKnowledgeBaseMaintenanceFinalBlock,
  ensureKnowledgeBaseFallbackReport,
  isLintOnlyKnowledgeBaseReport,
  readFreshKnowledgeBaseReportExcerpt,
  readKnowledgeBaseReportMtime,
  recoveredLintReportSummary,
  planKnowledgeBaseMaintenanceReportWrite,
  writeKnowledgeBaseMaintenanceFinalBlock,
  writeKnowledgeBaseNoopReport,
  writeKnowledgeBaseFailureReport
} from "./report";
import { discoverKnowledgeBaseSources, knowledgeBaseReportPathForMode } from "./discovery";
import { buildKnowledgeBasePrompt } from "./prompt";
import {
  classifyRawSnapshotChanges,
  formatRawIntegrityError,
  isRawIntegrityErrorMessage,
  rawSnapshotChangeMessages,
  restoreRawMetadata,
  restoreRawSnapshot,
  snapshotRawFileContents
} from "./raw-integrity";
import type { RawContentSnapshot, RawSnapshot } from "./raw-integrity";
import {
  assertSafeRawEntries,
  assertSafeRawRoot,
  fingerprintKnowledgeRawContentSnapshot,
  snapshotKnowledgeRawFiles,
  planRawDigestMetadataForSources,
  writeRawDigestMetadataForSources
} from "./raw-calibration";
import { extractRequestedRawPaths, processedSourcesForRunMode, selectSourcesForRunMode } from "./source-selection";
import {
  appendConflictDuplicateCleanupReport,
  appendExternalRawAdditionsReport,
  appendKnowledgeBaseWarning,
  appendStructureNormalizationReport,
  buildExternalRawAdditionsReportContent,
  buildMaintenanceSummary,
  cloneList,
  cloneProcessedSources,
  collectExternalRawAdditions,
  ensureKnowledgeBaseFolders,
  formatCancelResultMessage,
  labelForRunMode,
  normalizeProcessedSources,
  planKnowledgeBaseRawIndexWrite,
  planKnowledgeBaseTrackerWrite,
  rawIndexCommitRecord,
  rewriteProcessedSources,
  saveSettingsSafely,
  shouldWriteKnowledgeBaseFailureReportForMode,
  syncRewrittenRawProcessedSourceStats,
  writeKnowledgeBaseRawIndex,
  writeKnowledgeBaseTracker
} from "./maintenance";
import {
  readMaintenanceContentFileBaseline
} from "./maintenance-content-plan";
import {
  prepareAndCommitMaintenanceWorkflow,
  recoverPendingMaintenanceWorkflows
} from "./maintenance-workflow";
import { normalizeKnowledgeBaseStructure, rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";
import {
  maintenanceIndexCommitRecords,
  maintenanceIndexManagedWrites,
  maintenanceIndexReconciliationWarning,
  planMaintenanceIndexReconciliation,
  planMaintenancePartialCommit,
  reconcileMaintenanceIndexes
} from "./maintenance-partial-commit";
import {
  assertSafeKnowledgeTransactionCurrentState,
  assertSafeKnowledgeTransactionRoots,
  commitLintReportOnly,
  disposeKnowledgeTransactionSnapshot,
  knowledgeTransactionRootsForMode,
  quarantinePreexistingKnowledgeConflictDuplicates,
  restoreKnowledgeTransactionOnFailure,
  restoreOptionalFile,
  snapshotKnowledgeTransaction,
  snapshotOptionalFile,
  type KnowledgeConflictDuplicateCleanup,
  type KnowledgeTransactionSnapshot,
  type OptionalFileSnapshot
} from "./transaction-snapshot";
import type {
  KnowledgeBaseDurableMaintenanceResult,
  KnowledgeBaseDiscovery,
  KnowledgeBaseRunCompletion,
  KnowledgeBaseRunMode,
  KnowledgeBaseRunResult,
  KnowledgeBaseRunTerminalPhase,
  KnowledgeBaseRunWarning,
  KnowledgeBaseSource,
  KnowledgeRunAttemptRecord,
  KnowledgeRunAttemptStagingRecord
} from "./types";
import {
  assertDurableMaintenanceResult,
  durableMaintenanceResultFromHistory
} from "./maintenance-terminal";
import { exists } from "./utils";
import type { KnowledgeBaseTurnOptionOverrides } from "./command-router";
import type { KnowledgeAgentTaskOutput } from "./agent-runner";
import { KnowledgeAgentAttemptError } from "./agent-task-service";
import {
  classifyMaintenanceFailure,
  createMaintenanceS2FailoverProof,
  createMaintenanceRoutingWorkflow,
  issueMaintenanceSameLeaseTerminationReceipt,
  MAINTENANCE_FAILOVER_GATE,
  MAINTENANCE_POST_START_FAILOVER_GATE,
  resolveMaintenanceAttemptOutcome,
  startMaintenanceRouting,
  maintenanceBackendOrder,
  type MaintenanceAttemptPhase,
  type MaintenanceFailureClassification,
  type MaintenanceRoutingAttempt,
  type MaintenanceRoutingWorkflow,
  type MaintenanceS2FailoverProof
} from "./maintenance-routing";
import { nativeTerminationReceiptFrom } from "./native-termination";
import { formatDateForFile } from "./utils";
import {
  commitKnowledgeBaseIndexCheckpoint,
  isKnowledgeBaseInboxWorkItem,
  isKnowledgeBaseOutputWorkItem,
  refreshKnowledgeBaseIndex,
  selectKnowledgeBaseIncrementalScope,
  type KnowledgeBaseIndexCheckpoint,
  type KnowledgeBaseIndexEntry,
  type KnowledgeBaseIndexRefreshResult,
  type KnowledgeBaseIncrementalScope
} from "./incremental-index";
import { KnowledgeWorkflowProgress } from "./workflow-progress";

const MAX_ATTACHED_SOURCES = 20;

export interface KnowledgeBaseMaintenanceRunnerContext {
  isRunning(): boolean;
  beginRun(): void;
  finishRun(): void;
  isCancelRequested(): boolean;
  tryEnterCommitPhase(): boolean;
  isCommitPhaseLocked(): boolean;
  resolveRulesFile(): Promise<{ relativePath: string; absolutePath: string; exists: boolean; useCustomRulesFile: boolean }>;
  isMaintenanceBackendReady(backend: AgentBackendKind, sources: KnowledgeBaseSource[]): Promise<boolean>;
  runKnowledgeAgentTask(input: {
    prompt: string;
    sources: KnowledgeBaseSource[];
    permission: PermissionMode;
    codexWriteScope: "knowledge-base" | "knowledge-lint" | "journal";
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
    managedKind: KnowledgeBaseManagedThreadKind;
    backend?: AgentBackendKind;
    workflowRunId?: string;
    attemptId?: string;
    attemptOrdinal?: number;
    maintenanceResourceProfile?: boolean;
    vaultPathOverride?: string;
    writableRootsOverride?: string[];
    exactWriteFence?: import("../agent/types").AgentExactWriteFenceContext;
    onExactWriteFenceConfigured?: import("../agent/types").AgentTaskInput["onExactWriteFenceConfigured"];
  }): Promise<KnowledgeAgentTaskOutput>;
}

interface ExecuteMaintenanceShadowAttemptInput {
  attempt: MaintenanceRoutingAttempt;
  selectedBackend: AgentBackendKind;
  liveVaultPath: string;
  shadowStorageRoot: string;
  mode: KnowledgeBaseRunMode;
  userRequest: string;
  requestedRawPaths: string[];
  reportPath: string;
  reportMtimeBefore: number | null;
  sources: KnowledgeBaseSource[];
  skippedSources: KnowledgeBaseDiscovery["skippedSources"];
  remainingSources: KnowledgeBaseSource[];
  remainingSourceCount: number;
  targetPaths?: string[];
  fullScan?: boolean;
  rules: {
    relativePath: string;
    absolutePath: string;
    exists: boolean;
    useCustomRulesFile: boolean;
  };
  processedSourcesBeforeRun: ReturnType<typeof cloneProcessedSources>;
  turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
}

interface MaintenanceShadowAttemptSuccess {
  output: KnowledgeAgentTaskOutput;
  completion: KnowledgeBaseRunCompletion;
  verifiedSources: KnowledgeBaseSource[];
  pendingSources: DigestEvidencePendingSource[];
  evidencePaths: Record<string, string[]>;
  handle: MaintenanceShadowHandle;
  staging?: KnowledgeRunAttemptStagingRecord;
  changeSet: MaintenanceShadowChangeSet;
  allowPaths: string[];
  reportPath: string;
  structure?: import("./types").StructureNormalizationResult;
  conflictDuplicateCleanup: KnowledgeConflictDuplicateCleanup;
  skippedAgentIndexPaths: string[];
  reconciliationIndexPaths: string[];
  warnings: KnowledgeBaseRunWarning[];
}

type MaintenanceRunExecutionResult = Pick<
  MaintenanceShadowAttemptSuccess,
  "output" | "completion" | "verifiedSources" | "pendingSources" | "evidencePaths" | "warnings"
> & {
  attempt?: MaintenanceRoutingAttempt;
  handle?: MaintenanceShadowHandle;
  changeSet?: MaintenanceShadowChangeSet;
  allowPaths?: string[];
  reportPath?: string;
  structure?: import("./types").StructureNormalizationResult;
  conflictDuplicateCleanup?: KnowledgeConflictDuplicateCleanup;
  skippedAgentIndexPaths?: string[];
  reconciliationIndexPaths?: string[];
};

export class MaintenanceShadowAttemptError extends Error {
  readonly phase: MaintenanceAttemptPhase;
  readonly submittedAt: number | undefined;
  readonly harnessRunId: string;
  readonly nativeExecutionId: string;
  staging?: KnowledgeRunAttemptStagingRecord;

  constructor(
    readonly cause: unknown,
    readonly writeFenceReceipt?: AgentExactWriteFenceReceipt,
    readonly zeroResultAttestation?: MaintenanceShadowZeroResultAttestation,
    readonly terminationConfirmedAt?: number,
    phase?: MaintenanceAttemptPhase,
    readonly postStartFailoverProof?: MaintenanceS2FailoverProof,
    submittedAtOverride?: number
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MaintenanceShadowAttemptError";
    const attemptError = cause instanceof KnowledgeAgentAttemptError ? cause : null;
    this.phase = attemptError?.phase ?? phase ?? "preflight";
    this.submittedAt = attemptError?.submittedAt ?? submittedAtOverride;
    this.harnessRunId = attemptError?.harnessRunId ?? "";
    this.nativeExecutionId = attemptError?.nativeExecutionId ?? "";
    const code = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : "";
    if (code) Object.assign(this, { code });
  }

  withStaging(staging: KnowledgeRunAttemptStagingRecord): this {
    this.staging ??= staging;
    return this;
  }
}

function maintenanceShadowStorageRoot(vaultPath: string): string {
  const vaultToken = createHash("sha256").update(path.resolve(vaultPath)).digest("hex").slice(0, 24);
  return path.join(homedir(), ".codex-echoink", "maintenance-shadows", vaultToken);
}

function maintenanceShadowWritablePaths(mode: KnowledgeBaseRunMode): string[] {
  return mode === "lint"
    ? ["outputs/maintenance"]
    : ["wiki", "projects", "outputs/maintenance", "inbox"];
}

function remapMaintenanceSources(
  sources: KnowledgeBaseSource[],
  shadowVaultPath: string
): KnowledgeBaseSource[] {
  return sources.map((source) => ({
    ...source,
    absolutePath: path.join(shadowVaultPath, source.relativePath)
  }));
}

function chunkedMaintenanceSources(
  sources: readonly KnowledgeBaseSource[]
): Array<{ relativePath: string; maxChunkBytes: number }> {
  return sources.flatMap((source) =>
    source.readStrategy?.kind === "chunked-text"
      ? [{
        relativePath: source.relativePath,
        maxChunkBytes: source.readStrategy.maxChunkBytes
      }]
      : []
  );
}

function maintenanceAgentSources(
  logicalSources: readonly KnowledgeBaseSource[],
  shadowVaultPath: string,
  sourceChunks: readonly MaintenanceShadowSourceChunk[]
): KnowledgeBaseSource[] {
  const chunksBySource = new Map<string, MaintenanceShadowSourceChunk[]>();
  for (const chunk of sourceChunks) {
    const existing = chunksBySource.get(chunk.sourceRelativePath) ?? [];
    existing.push(chunk);
    chunksBySource.set(chunk.sourceRelativePath, existing);
  }
  return logicalSources.flatMap((source) => {
    if (source.readStrategy?.kind !== "chunked-text") {
      return [{
        ...source,
        absolutePath: path.join(shadowVaultPath, source.relativePath)
      }];
    }
    const chunks = (chunksBySource.get(source.relativePath) ?? [])
      .sort((left, right) => left.index - right.index);
    if (!chunks.length) {
      throw new Error(`分块来源缺少 Shadow 只读视图：${source.relativePath}`);
    }
    return chunks.map((chunk) => ({
      ...source,
      relativePath: chunk.relativePath,
      absolutePath: path.join(shadowVaultPath, chunk.relativePath),
      size: chunk.size,
      fingerprint: `${source.fingerprint}:chunk:${chunk.index}:${chunk.sha256}`,
      readStrategy: undefined
    }));
  });
}

function exactFenceReceiptDigest(receipt: AgentExactWriteFenceReceipt): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    version: receipt.version,
    backend: receipt.backend,
    attemptToken: receipt.attemptToken,
    leaseToken: receipt.leaseToken,
    enforcedWritableRoots: [...receipt.enforcedWritableRoots].map((entry) => path.resolve(entry)).sort(),
    deniedLivePaths: [...receipt.deniedLivePaths].map((entry) => path.resolve(entry)).sort(),
    deniedControlPaths: [...receipt.deniedControlPaths].map((entry) => path.resolve(entry)).sort(),
    transport: receipt.transport,
    configAckDigest: receipt.configAckDigest,
    configuredAt: receipt.configuredAt
  })).digest("hex")}`;
}

function maintenanceTerminationConfirmedAt(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { terminationConfirmedAt?: unknown }).terminationConfirmedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export class KnowledgeBaseMaintenanceRunner {
  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly context: KnowledgeBaseMaintenanceRunnerContext
  ) {}

  private async executeMaintenanceShadowAttempt(
    input: ExecuteMaintenanceShadowAttemptInput
  ): Promise<MaintenanceShadowAttemptSuccess> {
    let handle: MaintenanceShadowHandle | null = null;
    let shadowPreparedAt: number | undefined;
    let shadowTransaction: KnowledgeTransactionSnapshot | null = null;
    let shadowTerminal = false;
    let sealed = false;
    let sealedChangeSet: MaintenanceShadowChangeSet | undefined;
    let phase: MaintenanceAttemptPhase = "preflight";
    let agentResolved = false;
    let writeFenceReceipt: AgentExactWriteFenceReceipt | undefined;
    let fenceConfiguredAt: number | undefined;
    let agentOutput: KnowledgeAgentTaskOutput = { text: "" };
    let agentError: unknown = null;
    let conflictDuplicateCleanup: KnowledgeConflictDuplicateCleanup = {
      moved: [],
      backupRoot: ""
    };
    try {
      handle = await createMaintenanceShadowVault({
        liveVaultPath: input.liveVaultPath,
        attemptId: input.attempt.attemptId,
        storageRootPath: input.shadowStorageRoot,
        rulesPaths: [input.rules.relativePath],
        requiredSourcePaths: input.sources.map((source) => source.relativePath),
        copiedPaths: ["wiki", "projects", "outputs", "inbox"],
        writablePaths: maintenanceShadowWritablePaths(input.mode),
        chunkedTextSources: chunkedMaintenanceSources(input.sources)
      });
      shadowPreparedAt = Date.now();
      const boundary = await maintenanceShadowExecutionBoundary(handle);
      const shadowSources = remapMaintenanceSources(input.sources, handle.agentVaultPath);
      const agentSources = maintenanceAgentSources(
        input.sources,
        handle.agentVaultPath,
        handle.sourceChunks ?? []
      );
      const attemptStartedAt = Date.now();
      const beforeConflictCleanup = await snapshotKnowledgeTransaction(
        handle.agentVaultPath,
        knowledgeTransactionRootsForMode(input.mode)
      );
      try {
        conflictDuplicateCleanup =
          await quarantinePreexistingKnowledgeConflictDuplicates(
            handle.agentVaultPath,
            beforeConflictCleanup,
            attemptStartedAt,
            input.mode
          );
      } finally {
        await disposeKnowledgeTransactionSnapshot(beforeConflictCleanup);
      }
      shadowTransaction = await snapshotKnowledgeTransaction(
        handle.agentVaultPath,
        knowledgeTransactionRootsForMode(input.mode)
      );
      assertSafeKnowledgeTransactionRoots(shadowTransaction);
      const prompt = buildKnowledgeBasePrompt({
        vaultPath: handle.agentVaultPath,
        mode: input.mode,
        userRequest: input.userRequest,
        requestedRawPaths: input.requestedRawPaths,
        reportPath: input.reportPath,
        sources: shadowSources,
        sourceChunks: handle.sourceChunks,
        skippedSources: input.skippedSources,
        remainingSourceCount: input.remainingSourceCount,
        rulesFilePath: input.rules.relativePath,
        rulesFileExists: await exists(path.join(handle.agentVaultPath, input.rules.relativePath)),
        useCustomRulesFile: input.rules.useCustomRulesFile,
        hasRawIndex: await exists(path.join(handle.agentVaultPath, "raw", "index.md")),
        hasWikiIndex: await exists(path.join(handle.agentVaultPath, "wiki", "index.md")),
        hasTracker: await exists(path.join(handle.agentVaultPath, "outputs", ".ingest-tracker.md")),
        targetPaths: input.targetPaths,
        fullScan: input.fullScan
      });
      const leaseToken = randomUUID();
      const expectedDeniedPaths = [
        boundary.deniedParentPath,
        ...boundary.deniedPaths
      ].map((entry) => path.resolve(entry));
      const onExactWriteFenceConfigured = async (receipt: AgentExactWriteFenceReceipt): Promise<void> => {
        if (
          !isTrustedExactWriteFenceReceipt(receipt)
          || receipt.backend !== input.attempt.backend
          || receipt.attemptToken !== input.attempt.attemptId
          || receipt.leaseToken !== leaseToken
          || !receipt.deniedLivePaths.map((entry) => path.resolve(entry)).includes(path.resolve(input.liveVaultPath))
          || !expectedDeniedPaths.every((entry) =>
            receipt.deniedControlPaths.map((item) => path.resolve(item)).includes(entry))
        ) {
          throw Object.assign(
            new Error("Maintenance exact-write-fence receipt 与当前 attempt/Shadow 不匹配"),
            { code: "POLICY_DENIED" }
          );
        }
        const shadowReceipt = createMaintenanceShadowTransportConfigReceipt({
          backend: receipt.backend,
          attemptId: receipt.attemptToken,
          leaseId: receipt.leaseToken,
          enforcedWritableRootPaths: receipt.enforcedWritableRoots,
          enforcedDeniedShadowPaths: boundary.deniedPaths,
          deniedLiveVaultPath: input.liveVaultPath,
          deniedControlPath: boundary.deniedParentPath,
          transportAck: `${receipt.transport}:${receipt.configAckDigest}`,
          transportConfigDigest: exactFenceReceiptDigest(receipt),
          issuedAt: receipt.configuredAt
        });
        await confirmMaintenanceShadowTransportConfigFence(handle!, input.liveVaultPath, shadowReceipt);
        writeFenceReceipt = receipt;
        fenceConfiguredAt = Date.now();
      };

      phase = "execution";
      try {
        agentOutput = await this.context.runKnowledgeAgentTask({
          prompt,
          sources: agentSources,
          permission: "workspace-write",
          codexWriteScope: input.mode === "lint" ? "knowledge-lint" : "knowledge-base",
          turnOptionOverrides: maintenanceTurnOverridesForAttempt(
            input.turnOptionOverrides,
            input.selectedBackend,
            input.attempt.backend
          ),
          managedKind: input.mode,
          backend: input.attempt.backend,
          workflowRunId: input.attempt.workflowId,
          attemptId: input.attempt.attemptId,
          attemptOrdinal: input.attempt.ordinal,
          maintenanceResourceProfile: true,
          vaultPathOverride: handle.agentVaultPath,
          writableRootsOverride: boundary.writableRootPaths,
          exactWriteFence: {
            attemptToken: input.attempt.attemptId,
            leaseToken,
            deniedLivePaths: [input.liveVaultPath],
            deniedControlPaths: expectedDeniedPaths
          },
          onExactWriteFenceConfigured
        });
        agentResolved = true;
      } catch (error) {
        agentError = error;
      }

      if (
        this.context.isCancelRequested()
        || (
          agentError !== null
          && isKnowledgeBaseCancelError(agentError instanceof Error ? agentError.message : String(agentError))
        )
      ) {
        throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      }
      if (!writeFenceReceipt) {
        throw agentError ?? Object.assign(
          new Error("Maintenance Agent 未确认精确 Shadow 写入围栏"),
          { code: "POLICY_DENIED" }
        );
      }
      phase = "verification";

      if (agentError) {
        const attemptError = agentError instanceof KnowledgeAgentAttemptError ? agentError : null;
        const submittedAt = attemptError?.submittedAt;
        const failure = classifyMaintenanceFailure({
          // Exact fence configuration happens before prompt submission. It is
          // not evidence that a native Agent execution started. Preserve the
          // Service-issued preflight phase so a send/connect failure after the
          // fence ACK can still use the safe S1 fallback path.
          phase: attemptError?.phase ?? "execution",
          error: agentError,
          agentStarted: attemptError
            ? attemptError.phase === "execution" || submittedAt !== undefined
            : fenceConfiguredAt !== undefined
        });
        if (
          failure.retryable
          && failure.failoverGate === MAINTENANCE_FAILOVER_GATE
        ) {
          const changeSet = await sealMaintenanceShadowVault(handle);
          sealed = true;
          sealedChangeSet = changeSet;
          await markMaintenanceShadowTerminal(
            handle,
            changeSet.structuralResult === "zero-result" ? "noop" : "discarded"
          );
          shadowTerminal = true;
          phase = "cleanup";
          await cleanupMaintenanceShadowVault(handle);
          throw new MaintenanceShadowAttemptError(
            agentError,
            writeFenceReceipt,
            undefined,
            undefined,
            "preflight"
          );
        }
        if (
          failure.retryable
          && failure.failoverGate === MAINTENANCE_POST_START_FAILOVER_GATE
        ) {
          const nativeTerminationReceipt = attemptError?.nativeTerminationReceipt
            ?? nativeTerminationReceiptFrom(agentError);
          if (!nativeTerminationReceipt) {
            await abandonMaintenanceShadowVault(
              handle,
              "post-start failure without native termination acknowledgement; failover denied"
            );
            shadowTerminal = true;
            throw new MaintenanceShadowAttemptError(
              agentError,
              writeFenceReceipt,
              undefined,
              undefined,
              "execution",
              undefined,
              submittedAt
            );
          }
          const sameLeaseTerminationReceipt = issueMaintenanceSameLeaseTerminationReceipt({
            attempt: input.attempt,
            writeFenceReceipt,
            harnessRunId: attemptError?.harnessRunId || "",
            nativeTerminationReceipt
          });
          const changeSet = await sealMaintenanceShadowVault(handle);
          sealed = true;
          sealedChangeSet = changeSet;
          if (changeSet.structuralResult === "zero-result") {
            const zeroResultAttestation = await attestMaintenanceShadowZeroResult(handle, input.liveVaultPath);
            const quarantineReceipt = await quarantineMaintenanceShadowZeroResult(
              handle,
              input.liveVaultPath,
              {
                writeFenceReceipt,
                zeroResultAttestation,
                reason: failure.message
              }
            );
            const postStartFailoverProof = createMaintenanceS2FailoverProof({
              attempt: input.attempt,
              writeFenceReceipt,
              sameLeaseTerminationReceipt,
              quarantineReceipt,
              zeroResultAttestation
            });
            // Quarantine is intentionally durable and cleanup-revoked. The old
            // Shadow stays retained; a fallback Agent receives a fresh root
            // and lease.
            shadowTerminal = true;
            throw new MaintenanceShadowAttemptError(
              agentError,
              writeFenceReceipt,
              zeroResultAttestation,
              maintenanceTerminationConfirmedAt(agentError),
              "execution",
              postStartFailoverProof,
              submittedAt
            );
          }
        }
      }

      if (
        !sealed
        && (
          input.mode === "lint"
          || input.mode === "outputs"
          || input.mode === "inbox"
          || input.sources.length === 0
        )
      ) {
        await ensureKnowledgeBaseFallbackReport(handle.agentVaultPath, input.reportPath, {
          mode: input.mode,
          output: agentOutput.text,
          sources: processedSourcesForRunMode(input.mode, input.sources),
          startedAt: attemptStartedAt,
          previousMtimeMs: input.reportMtimeBefore
        });
      }

      const evidence = input.mode === "maintain" || input.mode === "reingest"
        ? await evaluateDigestEvidence({
          vaultPath: handle.agentVaultPath,
          reportPath: input.reportPath,
          sources: shadowSources,
          startedAt: attemptStartedAt,
          previousReportMtime: input.reportMtimeBefore,
          transactionBefore: shadowTransaction,
          processedSourcesBeforeRun: input.processedSourcesBeforeRun
        })
        : {
          verifiedSources: shadowSources,
          evidencePaths: {} as Record<string, string[]>,
          pendingSources: []
        };
      const verifiedSourcePaths = new Set(evidence.verifiedSources.map((source) => source.relativePath));
      const verifiedSources = input.sources.filter((source) => verifiedSourcePaths.has(source.relativePath));
      const pendingSources: DigestEvidencePendingSource[] = [
        ...evidence.pendingSources,
        ...input.skippedSources.map((source) => ({
          source: {
            relativePath: source.relativePath,
            absolutePath: source.absolutePath,
            size: source.size,
            mtime: source.mtime,
            fingerprint: source.fingerprint,
            mime: source.mime,
            modality: source.modality,
            changed: true
          },
          reason: {
            code: "resource-limit" as const,
            message: `${source.reason}：${source.relativePath}`
          }
        })),
        ...(input.remainingSources ?? []).map((source) => ({
          source,
          reason: {
            code: "batch-limit" as const,
            message: `来源超过单轮 ${MAX_ATTACHED_SOURCES} 个上限，保留到下一轮维护：${source.relativePath}`
          }
        }))
      ];
      const hasAllEvidence = pendingSources.length === 0;
      const hasSomeEvidence = verifiedSources.length > 0;
      let completion: KnowledgeBaseRunCompletion = agentError ? "recovered" : "full";
      if ((input.mode === "maintain" || input.mode === "reingest") && input.sources.length) {
        if (hasAllEvidence) completion = agentError ? "recovered" : "full";
        else if (hasSomeEvidence) completion = "partial";
      }

      if (
        (input.mode === "maintain" || input.mode === "reingest")
        && input.sources.length
        && !hasSomeEvidence
      ) {
        const zeroEvidenceChangeSet =
          sealedChangeSet ?? await sealMaintenanceShadowVault(handle);
        sealed = true;
        sealedChangeSet = zeroEvidenceChangeSet;
        if (agentError && zeroEvidenceChangeSet.structuralResult === "zero-result") {
          const zeroResultAttestation = await attestMaintenanceShadowZeroResult(handle, input.liveVaultPath);
          await abandonMaintenanceShadowVault(handle, "retryable Agent failure with trusted zero result");
          throw new MaintenanceShadowAttemptError(
            agentError,
            writeFenceReceipt,
            zeroResultAttestation,
            maintenanceTerminationConfirmedAt(agentError),
            "execution",
            undefined,
            agentError instanceof KnowledgeAgentAttemptError
              ? agentError.submittedAt
              : fenceConfiguredAt
          );
        }
        throw Object.assign(
          new Error(evidence.pendingSources[0]?.reason.message || "知识库维护未产生可验证的逐来源成果"),
          { code: "EVIDENCE_INVALID" }
        );
      }

      const structure = input.mode === "maintain"
        && completion !== "partial"
        ? await normalizeKnowledgeBaseStructure(handle.agentVaultPath, {
          lastReportPath: input.reportPath,
          includeRawMoves: false,
          skipAliasedCaseOnlyMoves: true
        })
        : undefined;
      const reportPath = structure
        ? rewriteKnowledgeBaseRelativePath(
          input.reportPath,
          structure.pathRewrites
        )
        : input.reportPath;
      const evidencePaths = Object.fromEntries(
        Object.entries(evidence.evidencePaths).map(([sourcePath, paths]) => [
          sourcePath,
          paths.map((evidencePath) => structure
            ? rewriteKnowledgeBaseRelativePath(
              evidencePath,
              structure.pathRewrites
            )
            : evidencePath)
        ])
      );
      if (structure) {
        await appendStructureNormalizationReport(
          handle.agentVaultPath,
          reportPath,
          structure
        );
      }
      if (conflictDuplicateCleanup.moved.length) {
        await appendConflictDuplicateCleanupReport(
          handle.agentVaultPath,
          reportPath,
          conflictDuplicateCleanup
        );
      }

      const changeSet =
        sealedChangeSet ?? await sealMaintenanceShadowVault(handle);
      sealed = true;
      sealedChangeSet = changeSet;
      if (changeSet.structuralResult === "zero-result") {
        throw Object.assign(
          new Error("Agent attempt 未产生可提交成果；noop 只允许零来源、零 Agent 的确定性流程"),
          { code: "EVIDENCE_INVALID" }
        );
      }
      const partialCommit = completion === "partial"
        ? planMaintenancePartialCommit({
          changeSet,
          reportPath,
          evidencePaths
        })
        : null;
      phase = "commit";
      return {
        output: agentOutput,
        completion,
        verifiedSources,
        pendingSources,
        evidencePaths,
        handle,
        staging: {
          path: handle.rootPath,
          preparedAt: shadowPreparedAt
        },
        changeSet,
        allowPaths: partialCommit?.allowPaths
          ?? changeSet.changes.map((change) => change.relativePath),
        reportPath,
        structure,
        conflictDuplicateCleanup,
        skippedAgentIndexPaths:
          partialCommit?.skippedAgentIndexPaths ?? [],
        reconciliationIndexPaths:
          partialCommit?.reconciliationIndexPaths ?? [],
        warnings: []
      };
    } catch (error) {
      if (handle && !shadowTerminal && !(error instanceof MaintenanceShadowAttemptError)) {
        const attemptError = agentError instanceof KnowledgeAgentAttemptError ? agentError : null;
        const cleanupSafe = agentResolved || attemptError?.submittedAt === undefined;
        if (cleanupSafe) {
          try {
            const changeSet = sealed
              ? undefined
              : await sealMaintenanceShadowVault(handle);
            sealed = true;
            await markMaintenanceShadowTerminal(
              handle,
              changeSet?.structuralResult === "zero-result" ? "noop" : "discarded"
            );
            shadowTerminal = true;
            await cleanupMaintenanceShadowVault(handle);
          } catch {
            await abandonMaintenanceShadowVault(
              handle,
              error instanceof Error ? error.message : String(error)
            ).catch(() => undefined);
          }
        } else {
          await abandonMaintenanceShadowVault(
            handle,
            error instanceof Error ? error.message : String(error)
          ).catch(() => undefined);
        }
      }
      const staging = handle && shadowPreparedAt !== undefined
        ? {
          path: handle.rootPath,
          preparedAt: shadowPreparedAt,
          failedAt: Date.now()
        }
        : undefined;
      if (error instanceof MaintenanceShadowAttemptError) {
        throw staging ? error.withStaging(staging) : error;
      }
      const attemptError = new MaintenanceShadowAttemptError(
        error,
        writeFenceReceipt,
        undefined,
        maintenanceTerminationConfirmedAt(agentError ?? error),
        phase,
        undefined,
        fenceConfiguredAt
      );
      throw staging ? attemptError.withStaging(staging) : attemptError;
    } finally {
      await disposeKnowledgeTransactionSnapshot(shadowTransaction);
      // Sealed/abandoned attempts are intentionally retained unless they
      // reached an explicit cleanup-safe terminal state.
      void sealed;
    }
  }

  async runMaintenance(
    mode: KnowledgeBaseRunMode = "maintain",
    userRequest = "",
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides,
    selectedBackend: AgentBackendKind = this.plugin.settings.agentBackend
  ): Promise<KnowledgeBaseRunResult> {
    if (usesDurableMaintenanceWorkflow(mode)) {
      return await this.runMaintenanceWithWorkflow(
        mode as "maintain" | "reingest",
        userRequest,
        turnOptionOverrides,
        selectedBackend
      );
    }
    if (this.context.isRunning()) {
      new Notice("知识库维护正在运行");
      return {
        status: "failed",
        reportPath: this.plugin.settings.knowledgeBase.lastReportPath,
        summary: "",
        processedSources: [],
        error: "已有任务正在运行"
      };
    }
    this.context.beginRun();
    const progress = new KnowledgeWorkflowProgress(turnOptionOverrides?.onWorkflowEvent);
    progress.phase("prepare", "准备", "读取增量清单");
    const startedAt = Date.now();
    const workflowRunId = `knowledge-${mode}-${startedAt}`;
    const settings = this.plugin.settings.knowledgeBase;
    const processedSourcesBeforeRun = cloneProcessedSources(settings.processedSources);
    const healthHistoryBeforeRun = cloneList(settings.healthHistory);
    const maintenanceHistoryBeforeRun = cloneList(settings.maintenanceHistory);
    let vaultPath = "";
    let rawBeforeContents: RawContentSnapshot | null = null;
    let rawBefore: RawSnapshot = new Map();
    let discovery: KnowledgeBaseDiscovery | null = null;
    let reportMtimeBefore: number | null = null;
    let trackerBeforeRun: OptionalFileSnapshot | null = null;
    let transactionBefore: KnowledgeTransactionSnapshot | null = null;
    let runSourcesForFailureReport: KnowledgeBaseSource[] = [];
    let trackerWritten = false;
    let lintReportRecoveryEligible = false;
    const runAttempts: KnowledgeRunAttemptRecord[] = [];
    let routingFailureCode = "";
    let indexRefresh: KnowledgeBaseIndexRefreshResult | null = null;
    let incrementalScope: KnowledgeBaseIncrementalScope | null = null;
    let indexCheckpoint: KnowledgeBaseIndexCheckpoint | null = null;
    let indexFilter: ((entry: KnowledgeBaseIndexEntry) => boolean) | undefined;
    let targetPaths: string[] = [];
    let indexedRunSources: KnowledgeBaseSource[] = [];
    const externalRawAdditionsDuringRun = new Set<string>();
    let conflictDuplicateCleanup: KnowledgeConflictDuplicateCleanup = { moved: [], backupRoot: "" };
    try {
      vaultPath = this.plugin.getVaultPath();
      const shadowStorageRoot = maintenanceShadowStorageRoot(vaultPath);
      await mkdir(shadowStorageRoot, { recursive: true, mode: 0o700 });
      // A prior crash may have left a durable live-Vault apply journal. Settle
      // it before this run captures any baseline or performs discovery, or a
      // later rollback could undo the recovered commit and rediscover stale
      // sources.
      await recoverMaintenanceShadowApplyTransactions(vaultPath, shadowStorageRoot);
      settings.lastRunStatus = "running";
      settings.lastError = "";
      settings.lastSummary = "";
      settings.lastRunAt = startedAt;
      settings.lastAttempts = [];
      settings.lastFailureCode = "";
      await this.plugin.saveSettings(true);
      this.throwIfCanceled();
      const rules = await this.context.resolveRulesFile();
      if (rules.useCustomRulesFile && !rules.exists) {
        throw new Error(`知识库操作指南文件不存在：${rules.relativePath}。请在设置里修正路径。`);
      }
      this.throwIfCanceled();
      discovery = mode === "maintain" || mode === "reingest"
        ? await discoverKnowledgeBaseSources(vaultPath, settings.processedSources, mode)
        : emptyDiscoveryForMode(vaultPath, mode);
      this.throwIfCanceled();
      const incremental = await prepareIncrementalRunScope(vaultPath, mode, userRequest);
      indexRefresh = incremental.refresh;
      incrementalScope = incremental.scope;
      indexCheckpoint = incremental.checkpoint;
      indexFilter = incremental.filter;
      targetPaths = incremental.targetPaths;
      indexedRunSources = incremental.sources;
      progress.progress(
        (discovery.indexStats?.reused ?? 0) + (indexRefresh?.reusedCount ?? 0),
        Math.max(1, discovery.sources.length + (indexRefresh?.entries.length ?? 0)),
        `变化目标 ${targetPaths.length} 个`
      );
      if (shouldUseNoopFastPath(mode, userRequest, discovery, incrementalScope, targetPaths)) {
        progress.phase("report", "报告", "没有变化，直接生成终态报告");
        await ensureKnowledgeBaseFolders(vaultPath, mode);
        const checkedCount = mode === "maintain"
          ? discovery.sources.length
          : indexRefresh?.entries.filter((entry) => indexFilter?.(entry) ?? true).length ?? 0;
        const summary = noOpSummary(mode);
        await writeKnowledgeBaseNoopReport(vaultPath, discovery.reportPath, {
          mode,
          startedAt,
          checkedCount,
          scopeLabel: noOpScopeLabel(mode),
          summary
        });
        this.throwIfCanceled();
        progress.phase("complete", "完成", "保存任务状态");
        settings.lastRunAt = Date.now();
        settings.lastRunStatus = "success";
        settings.lastReportPath = discovery.reportPath;
        settings.lastSummary = summary;
        settings.lastError = "";
        recordKnowledgeBaseMaintenanceRun(settings, { status: "success", mode, reportPath: discovery.reportPath });
        await this.plugin.saveSettings(true);
        if (indexRefresh && incrementalScope && indexCheckpoint) {
          await commitKnowledgeBaseIndexCheckpoint(vaultPath, indexRefresh, indexCheckpoint, incrementalScope, indexFilter)
            .catch((error) => console.warn("EchoInk knowledge index checkpoint failed", error));
        }
        this.throwIfCanceled();
        const performance = progress.complete(summary);
        performance.index = {
          reused: (discovery.indexStats?.reused ?? 0) + (indexRefresh?.reusedCount ?? 0),
          refreshed: (discovery.indexStats?.refreshed ?? 0) + (indexRefresh?.indexedCount ?? 0),
          targets: 0
        };
        new Notice(`知识库${labelForRunMode(mode)}完成`);
        return {
          status: "success",
          reportPath: discovery.reportPath,
          summary,
          processedSources: [],
          performance
        };
      }
      const transactionRoots = knowledgeTransactionRootsForMode(mode);
      transactionBefore = await snapshotKnowledgeTransaction(vaultPath, transactionRoots);
      this.throwIfCanceled();
      conflictDuplicateCleanup = await quarantinePreexistingKnowledgeConflictDuplicates(vaultPath, transactionBefore, startedAt, mode);
      if (conflictDuplicateCleanup.moved.length) {
        await disposeKnowledgeTransactionSnapshot(transactionBefore);
        transactionBefore = await snapshotKnowledgeTransaction(vaultPath, transactionRoots);
      }
      this.throwIfCanceled();
      assertSafeKnowledgeTransactionRoots(transactionBefore);
      trackerBeforeRun = await snapshotOptionalFile(path.join(vaultPath, "outputs", ".ingest-tracker.md"));
      this.throwIfCanceled();
      rawBeforeContents = await snapshotRawFileContents(vaultPath);
      this.throwIfCanceled();
      rawBefore = fingerprintKnowledgeRawContentSnapshot(rawBeforeContents);
      assertSafeRawRoot(rawBeforeContents);
      assertSafeRawEntries(rawBeforeContents);
      const runDiscovery = discovery ?? emptyDiscoveryForMode(vaultPath, mode);
      this.throwIfCanceled();
      reportMtimeBefore = await readKnowledgeBaseReportMtime(vaultPath, runDiscovery.reportPath);
      await ensureKnowledgeBaseFolders(vaultPath, mode);
      this.throwIfCanceled();
      const requestedRawPaths = extractRequestedRawPaths(userRequest);
      const promptSources = mode === "lint" || mode === "outputs" || mode === "inbox"
        ? indexedRunSources
        : selectSourcesForRunMode(mode, runDiscovery, userRequest);
      const runSources = promptSources.slice(0, MAX_ATTACHED_SOURCES);
      runSourcesForFailureReport = runSources;
      this.throwIfCanceled();

      lintReportRecoveryEligible = mode === "lint";
      progress.phase("digest", "执行", `交给模型处理 ${runSources.length || targetPaths.length} 个目标`);
      progress.markAgentCalled();
      const routedAgentOutput = await runSelectedMaintenanceAgentTask({
        workflowRunId,
        selectedBackend,
        attempts: runAttempts,
        isBackendReady: async (backend) => await this.context.isMaintenanceBackendReady(backend, runSources),
        execute: async (attempt) => await this.executeMaintenanceShadowAttempt({
          attempt,
          selectedBackend,
          liveVaultPath: vaultPath,
          shadowStorageRoot,
          mode,
          userRequest,
          requestedRawPaths,
          reportPath: runDiscovery.reportPath,
          reportMtimeBefore,
          sources: runSources,
          skippedSources: runDiscovery.skippedSources,
          remainingSources: promptSources.slice(MAX_ATTACHED_SOURCES),
          remainingSourceCount: Math.max(0, promptSources.length - runSources.length),
          targetPaths,
          fullScan: Boolean(incrementalScope?.full),
          rules,
          processedSourcesBeforeRun,
          turnOptionOverrides
        })
      });
      if (
        !routedAgentOutput.handle
        || !routedAgentOutput.changeSet
        || !routedAgentOutput.allowPaths
      ) {
        throw Object.assign(
          new Error("非 WAL 维护缺少 sealed Shadow 提交计划"),
          { code: "MAINTENANCE_SHADOW_COMMIT_MISSING" }
        );
      }
      const shadowApply = await applyShadowChangeSet(
        vaultPath,
        routedAgentOutput.changeSet,
        { allowPaths: routedAgentOutput.allowPaths }
      );
      if (!shadowApply.commitReceipt) {
        throw Object.assign(
          new Error("非 WAL Shadow apply 未返回 durable commit receipt"),
          { code: "MAINTENANCE_SHADOW_COMMIT_MISSING" }
        );
      }
      await markMaintenanceShadowTerminal(
        routedAgentOutput.handle,
        "committed",
        { commitReceipt: shadowApply.commitReceipt }
      );
      const appliedAttempt = runAttempts.find(
        (attempt) => attempt.attemptId === routedAgentOutput.attempt?.attemptId
      );
      if (appliedAttempt?.staging) {
        appliedAttempt.staging.promotedAt = Date.now();
      }
      try {
        await cleanupMaintenanceShadowVault(routedAgentOutput.handle);
      } catch (error) {
        routedAgentOutput.warnings.push({
          id: "shadow-cleanup-failed",
          message: `维护成果已提交，但 Shadow 清理失败，后续将自动恢复清理：${error instanceof Error ? error.message : String(error)}`
        });
      }
      const agentOutput = routedAgentOutput.output;
      const output = agentOutput.text;
      const committedRunSources = routedAgentOutput.verifiedSources;
      const pendingRunSources = routedAgentOutput.pendingSources;
      const pendingSourcePaths = pendingRunSources.map((item) => item.source.relativePath);
      const runWarnings = routedAgentOutput.warnings;
      const maintenanceCompletion = routedAgentOutput.completion;
      lintReportRecoveryEligible = false;
      this.throwIfCanceled();

      progress.phase("organize", "整理", "校验本轮改动与引用邻域");
      await assertSafeKnowledgeTransactionCurrentState(vaultPath, transactionRoots, {
        allowedUnsafePaths: mode === "maintain" || mode === "reingest" ? new Set(["outputs/.ingest-tracker.md"]) : undefined
      });

      const rawAfterAgent = await snapshotKnowledgeRawFiles(vaultPath, rawBefore);
      const rawAgentChanges = classifyRawSnapshotChanges(rawBefore, rawAfterAgent);
      collectExternalRawAdditions(externalRawAdditionsDuringRun, rawAgentChanges.externalAdditions);
      if (rawAgentChanges.blockingChanges.length) {
        const messages = rawSnapshotChangeMessages(rawAgentChanges.blockingChanges);
        if (mode === "lint") throw new Error(formatRawIntegrityError(messages, false));
        await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterAgent, [], { removeAdded: "unsafe" });
        throw new Error(formatRawIntegrityError(messages, true));
      }
      this.throwIfCanceled();

      const structure = mode === "maintain"
        && maintenanceCompletion !== "partial"
        && maintenanceCompletion !== "noop"
        ? await normalizeKnowledgeBaseStructure(vaultPath, { lastReportPath: settings.lastReportPath || discovery.reportPath })
        : undefined;
      this.throwIfCanceled();
      let nextProcessedSources = cloneProcessedSources(settings.processedSources);
      if (structure?.pathRewrites.length) {
        nextProcessedSources = rewriteProcessedSources(nextProcessedSources, structure.pathRewrites);
      }
      const reportPath = structure ? rewriteKnowledgeBaseRelativePath(discovery.reportPath, structure.pathRewrites) : discovery.reportPath;
      const rawAfter = await snapshotKnowledgeRawFiles(vaultPath, rawAfterAgent);
      const rawChanges = classifyRawSnapshotChanges(rawBefore, rawAfter, structure?.pathRewrites ?? []);
      collectExternalRawAdditions(externalRawAdditionsDuringRun, rawChanges.externalAdditions);
      if (rawChanges.blockingChanges.length) {
        const messages = rawSnapshotChangeMessages(rawChanges.blockingChanges);
        await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfter, structure?.pathRewrites ?? [], { removeAdded: "unsafe" });
        throw new Error(formatRawIntegrityError(messages, true));
      }
      this.throwIfCanceled();

      let processedChangedSources = await normalizeProcessedSources(vaultPath, committedRunSources, structure?.pathRewrites ?? []);
      this.throwIfCanceled();
      if (mode === "maintain" && structure?.pathRewrites.length) {
        nextProcessedSources = await syncRewrittenRawProcessedSourceStats(vaultPath, nextProcessedSources, structure.pathRewrites);
      }
      this.throwIfCanceled();
      let digestEvidencePaths: Record<string, string[]> = {};
      if (mode === "maintain" || mode === "reingest") {
        digestEvidencePaths = await verifyDigestEvidence({
          vaultPath,
          reportPath,
          sources: committedRunSources,
          startedAt,
          previousReportMtime: reportPath === discovery.reportPath ? reportMtimeBefore : null,
          transactionBefore,
          processedSourcesBeforeRun
        });
      }
      this.throwIfCanceled();
      if (mode === "maintain" || mode === "reingest") {
        processedChangedSources = await writeRawDigestMetadataForSources(vaultPath, processedChangedSources, {
          reportPath,
          startedAt,
          runId: workflowRunId,
          evidencePaths: digestEvidencePaths,
          confidence: "verified"
        });
        const rawAfterDigestMetadata = await snapshotKnowledgeRawFiles(vaultPath, rawAfter);
        const rawDigestChanges = classifyRawSnapshotChanges(rawBefore, rawAfterDigestMetadata, structure?.pathRewrites ?? [], {
          allowedManagedFrontmatterPaths: new Set(processedChangedSources.map((source) => source.relativePath))
        });
        collectExternalRawAdditions(externalRawAdditionsDuringRun, rawDigestChanges.externalAdditions);
        if (rawDigestChanges.blockingChanges.length) {
          const messages = rawSnapshotChangeMessages(rawDigestChanges.blockingChanges);
          await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterDigestMetadata, structure?.pathRewrites ?? [], { removeAdded: "unsafe" });
          throw new Error(formatRawIntegrityError(messages, true));
        }
      }
      this.throwIfCanceled();
      if (mode === "maintain" || mode === "reingest") {
        for (const source of processedChangedSources) {
          nextProcessedSources[source.relativePath] = {
            path: source.relativePath,
            size: source.size,
            mtime: source.mtime,
            fingerprint: source.fingerprint,
            digestedAt: startedAt,
            reportPath,
            evidencePaths: digestEvidencePaths[source.relativePath] ?? [],
            runId: workflowRunId,
            confidence: "verified"
          };
        }
      }
      progress.phase("report", "报告", "生成报告并提交本轮状态");
      const reportedSources = processedSourcesForRunMode(mode, processedChangedSources);
      await ensureKnowledgeBaseFallbackReport(vaultPath, reportPath, {
        mode,
        output,
        sources: reportedSources,
        startedAt,
        previousMtimeMs: reportPath === discovery.reportPath ? reportMtimeBefore : null
      });
      this.throwIfCanceled();
      if (mode === "lint") {
        await commitLintReportOnly(vaultPath, transactionBefore, reportPath);
      }
      this.throwIfCanceled();
      if (structure) await appendStructureNormalizationReport(vaultPath, reportPath, structure);
      if (conflictDuplicateCleanup.moved.length) {
        await appendConflictDuplicateCleanupReport(vaultPath, reportPath, conflictDuplicateCleanup);
      }
      this.throwIfCanceled();
      if (externalRawAdditionsDuringRun.size) {
        await appendExternalRawAdditionsReport(vaultPath, reportPath, Array.from(externalRawAdditionsDuringRun));
      }
      this.throwIfCanceled();
      if (mode === "maintain" || mode === "reingest") {
        await writeKnowledgeBaseMaintenanceFinalBlock(vaultPath, reportPath, {
          completion: maintenanceCompletion,
          workflowRunId,
          ...(routedAgentOutput.attempt ? {
            attemptId: routedAgentOutput.attempt.attemptId,
            backend: routedAgentOutput.attempt.backend
          } : {}),
          verifiedSources: processedChangedSources,
          pendingSources: pendingRunSources,
          warnings: runWarnings
        });
      }
      this.throwIfCanceled();
      if (mode === "maintain" || mode === "reingest") {
        await writeKnowledgeBaseRawIndex(vaultPath, nextProcessedSources, startedAt);
        this.throwIfCanceled();
        await writeKnowledgeBaseTracker(vaultPath, nextProcessedSources, startedAt);
        trackerWritten = true;
        this.throwIfCanceled();
        settings.processedSources = nextProcessedSources;
      }
      this.throwIfCanceled();
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "success";
      settings.lastReportPath = reportPath;
      settings.lastSummary = buildMaintenanceSummary(output, mode, structure, conflictDuplicateCleanup);
      settings.lastAttempts = runAttempts;
      settings.lastFailureCode = "";
      recordKnowledgeBaseMaintenanceRun(settings, {
        status: "success",
        mode,
        runId: workflowRunId,
        reportPath,
        completion: maintenanceCompletion,
        attempts: runAttempts,
        pendingSources: pendingSourcePaths,
        warnings: runWarnings
      });
      progress.phase("complete", "完成", "保存终态");
      await this.plugin.saveSettings(true);
      if (indexRefresh && incrementalScope && indexCheckpoint) {
        await commitKnowledgeBaseIndexCheckpoint(vaultPath, indexRefresh, indexCheckpoint, incrementalScope, indexFilter)
          .catch((error) => console.warn("EchoInk knowledge index checkpoint failed", error));
      }
      this.throwIfCanceled();
      const performance = progress.complete(settings.lastSummary);
      performance.index = {
        reused: (discovery?.indexStats?.reused ?? 0) + (indexRefresh?.reusedCount ?? 0),
        refreshed: (discovery?.indexStats?.refreshed ?? 0) + (indexRefresh?.indexedCount ?? 0),
        targets: runSources.length || targetPaths.length
      };
      new Notice(`知识库${labelForRunMode(mode)}完成`);
      return {
        status: "success",
        reportPath,
        summary: settings.lastSummary,
        processedSources: reportedSources,
        structure,
        externalRawAdditions: Array.from(externalRawAdditionsDuringRun),
        digestEvidencePaths,
        attempts: runAttempts,
        completion: maintenanceCompletion,
        pendingSources: pendingSourcePaths,
        warnings: runWarnings,
        performance
      };
    } catch (error) {
      if (error instanceof MaintenanceAgentRoutingError) {
        routingFailureCode = error.failure.code || error.failure.category;
      }
      let message = error instanceof Error ? error.message : String(error);
      let canceled = this.context.isCancelRequested() || isKnowledgeBaseCancelError(message);
      progress.phase("report", canceled ? "取消收口" : "失败收口", message);
      let rawAfterOnError: RawSnapshot | null = null;
      let rawSnapshotError: unknown = null;
      if (vaultPath) {
        try {
          rawAfterOnError = await snapshotKnowledgeRawFiles(vaultPath, rawBefore);
        } catch (error) {
          rawSnapshotError = error;
        }
      }
      if (rawBeforeContents && rawSnapshotError && !isRawIntegrityErrorMessage(message)) {
        const rawContents = rawBeforeContents;
        const restored = mode === "lint" ? false : await restoreRawMetadata(vaultPath, rawContents).then(async () => {
          const rawAfterRestore = await snapshotKnowledgeRawFiles(vaultPath, rawBefore).catch(() => rawBefore);
          const remainingChanges = classifyRawSnapshotChanges(rawBefore, rawAfterRestore);
          collectExternalRawAdditions(externalRawAdditionsDuringRun, remainingChanges.externalAdditions);
          if (remainingChanges.blockingChanges.length) await restoreRawSnapshot(vaultPath, rawContents, rawBefore, rawAfterRestore, [], { removeAdded: "unsafe" });
          return true;
        }, () => false);
        message = formatRawIntegrityError([`raw/ 文件权限被改写或无法读取（${rawSnapshotError instanceof Error ? rawSnapshotError.message : String(rawSnapshotError)}）`], restored);
        canceled = false;
      } else {
        const rawErrorChanges = classifyRawSnapshotChanges(rawBefore, rawAfterOnError ?? rawBefore);
        collectExternalRawAdditions(externalRawAdditionsDuringRun, rawErrorChanges.externalAdditions);
        if (rawBeforeContents && rawErrorChanges.blockingChanges.length && !isRawIntegrityErrorMessage(message)) {
          const messages = rawSnapshotChangeMessages(rawErrorChanges.blockingChanges);
          const restored = mode === "lint" ? false : await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterOnError ?? rawBefore, [], { removeAdded: "unsafe" }).then(() => true, () => false);
          message = formatRawIntegrityError(messages, restored);
          canceled = false;
        }
      }
      if (trackerWritten && trackerBeforeRun && !transactionBefore) {
        try {
          await restoreOptionalFile(trackerBeforeRun);
          trackerWritten = false;
        } catch (restoreError) {
          const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
          message = `${message}；tracker 回滚失败：${restoreMessage}`;
          canceled = false;
        }
      }
      const finishCanceledRun = async (cancelSourceMessage: string, priorSaveError: string | null = null): Promise<KnowledgeBaseRunResult> => {
        const restored = await restoreKnowledgeTransactionOnFailure(transactionBefore);
        let cancelMessage = formatCancelResultMessage(cancelSourceMessage, priorSaveError);
        if (restored.error) {
          cancelMessage = `${cancelMessage}；知识库写入回滚失败：${restored.error}`;
        }
        if (restored.restored) trackerWritten = false;
        settings.processedSources = processedSourcesBeforeRun;
        settings.healthHistory = cloneList(healthHistoryBeforeRun);
        settings.maintenanceHistory = cloneList(maintenanceHistoryBeforeRun);
        settings.lastRunAt = Date.now();
        settings.lastRunStatus = "canceled";
        if (discovery?.reportPath) settings.lastReportPath = discovery.reportPath;
        settings.lastError = cancelMessage;
        settings.lastSummary = "";
        settings.lastAttempts = runAttempts;
        settings.lastFailureCode = routingFailureCode || "cancelled";
        recordKnowledgeBaseMaintenanceRun(settings, {
          status: "canceled",
          mode,
          runId: workflowRunId,
          reportPath: discovery?.reportPath ?? "",
          attempts: runAttempts,
          failureCode: settings.lastFailureCode
        });
        const saveError = await saveSettingsSafely(this.plugin);
        if (saveError) {
          cancelMessage = appendKnowledgeBaseWarning(cancelMessage, `状态保存失败：${saveError}`);
          settings.lastError = cancelMessage;
          await saveSettingsSafely(this.plugin);
        }
        new Notice(`知识库${labelForRunMode(mode)}已取消`);
        return {
          status: "canceled",
          reportPath: discovery?.reportPath ?? "",
          summary: "",
          processedSources: [],
          error: cancelMessage,
          attempts: runAttempts,
          failureCode: settings.lastFailureCode,
          performance: progress.fail("canceled", cancelMessage)
        };
      };
      const saveFailureStatusWithRetry = async (failureMessage: string): Promise<string> => {
        const saveError = await saveSettingsSafely(this.plugin);
        if (!saveError) return failureMessage;
        let nextMessage = `${failureMessage}；状态保存失败：${saveError}`;
        settings.lastError = nextMessage;
        const retryError = await saveSettingsSafely(this.plugin);
        if (retryError) {
          nextMessage = `${nextMessage}；状态保存重试失败：${retryError}`;
          settings.lastError = nextMessage;
        }
        return nextMessage;
      };
      canceled = canceled || this.context.isCancelRequested();
      if (canceled) {
        return await finishCanceledRun(message);
      }
      if (lintReportRecoveryEligible && mode === "lint" && discovery?.reportPath && !isRawIntegrityErrorMessage(message)) {
        try {
          const reportExcerpt = await readFreshKnowledgeBaseReportExcerpt(vaultPath, discovery.reportPath, startedAt, { previousMtimeMs: reportMtimeBefore });
          if (reportExcerpt && isLintOnlyKnowledgeBaseReport(reportExcerpt)) {
            if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
            await commitLintReportOnly(vaultPath, transactionBefore, discovery.reportPath);
            if (externalRawAdditionsDuringRun.size) {
              await appendExternalRawAdditionsReport(vaultPath, discovery.reportPath, Array.from(externalRawAdditionsDuringRun));
            }
            if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
            trackerWritten = false;
            settings.lastRunAt = Date.now();
            settings.lastRunStatus = "success";
            settings.lastReportPath = discovery.reportPath;
            settings.lastError = "";
            settings.lastSummary = recoveredLintReportSummary(discovery.reportPath);
            settings.lastAttempts = runAttempts;
            settings.lastFailureCode = "";
            recordKnowledgeBaseMaintenanceRun(settings, {
              status: "success",
              mode,
              runId: workflowRunId,
              reportPath: discovery.reportPath,
              completion: "recovered",
              attempts: runAttempts
            });
            const saveError = await saveSettingsSafely(this.plugin);
            if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR, saveError);
            if (saveError) {
              let recoveredSaveMessage = `${message}；状态保存失败：${saveError}`;
              const restored = await restoreKnowledgeTransactionOnFailure(transactionBefore);
              if (restored.error) {
                recoveredSaveMessage = `${recoveredSaveMessage}；知识库写入回滚失败：${restored.error}`;
              }
              if (restored.restored) trackerWritten = false;
              settings.lastRunStatus = "failed";
              settings.lastError = recoveredSaveMessage;
              settings.processedSources = processedSourcesBeforeRun;
              settings.healthHistory = cloneList(healthHistoryBeforeRun);
              settings.maintenanceHistory = cloneList(maintenanceHistoryBeforeRun);
              settings.lastFailureCode = "settings-save-failed";
              recordKnowledgeBaseMaintenanceRun(settings, {
                status: "failed",
                mode,
                runId: workflowRunId,
                reportPath: discovery.reportPath,
                attempts: runAttempts,
                failureCode: settings.lastFailureCode
              });
              recoveredSaveMessage = await saveFailureStatusWithRetry(recoveredSaveMessage);
              new Notice(`知识库${labelForRunMode(mode)}失败：${recoveredSaveMessage}`);
              return {
                status: "failed",
                reportPath: discovery.reportPath,
                summary: "",
                processedSources: [],
                error: recoveredSaveMessage,
                attempts: runAttempts,
                failureCode: settings.lastFailureCode,
                performance: progress.fail("failed", recoveredSaveMessage)
              };
            }
            if (indexRefresh && incrementalScope && indexCheckpoint) {
              await commitKnowledgeBaseIndexCheckpoint(vaultPath, indexRefresh, indexCheckpoint, incrementalScope, indexFilter)
                .catch((error) => console.warn("EchoInk knowledge index checkpoint failed", error));
            }
            progress.phase("complete", "完成", "保存恢复后的体检终态");
            new Notice("知识库体检完成，Agent 状态有警告");
            return {
              status: "success",
              reportPath: discovery.reportPath,
              summary: settings.lastSummary,
              processedSources: [],
              externalRawAdditions: Array.from(externalRawAdditionsDuringRun),
              attempts: runAttempts,
              completion: "recovered",
              performance: progress.complete(settings.lastSummary)
            };
          }
        } catch (recoveryError) {
          if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
          const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          message = `${message}；体检报告恢复失败：${recoveryMessage}`;
          canceled = false;
        }
      }
      const restored = await restoreKnowledgeTransactionOnFailure(transactionBefore);
      if (restored.error) {
        message = `${message}；知识库写入回滚失败：${restored.error}`;
      }
      if (restored.restored) trackerWritten = false;
      let failureReportPath = "";
      if (vaultPath && discovery?.reportPath && shouldWriteKnowledgeBaseFailureReportForMode(mode)) {
        const reportError = await writeKnowledgeBaseFailureReport(vaultPath, discovery.reportPath, {
          mode,
          error: message,
          sources: runSourcesForFailureReport,
          startedAt,
          rollbackRestored: restored.restored,
          rollbackError: restored.error,
          externalRawAdditions: Array.from(externalRawAdditionsDuringRun)
        }).then(() => null, (error) => error instanceof Error ? error.message : String(error));
        if (reportError) {
          message = appendKnowledgeBaseWarning(message, `失败报告写入失败：${reportError}`);
        } else {
          failureReportPath = discovery.reportPath;
        }
      }
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "failed";
      settings.lastError = message;
      settings.lastSummary = "";
      settings.lastAttempts = runAttempts;
      settings.lastFailureCode = routingFailureCode || "maintenance-failed";
      settings.processedSources = processedSourcesBeforeRun;
      settings.healthHistory = cloneList(healthHistoryBeforeRun);
      settings.maintenanceHistory = cloneList(maintenanceHistoryBeforeRun);
      if (failureReportPath) settings.lastReportPath = failureReportPath;
      recordKnowledgeBaseMaintenanceRun(settings, {
        status: "failed",
        mode,
        runId: workflowRunId,
        reportPath: failureReportPath,
        attempts: runAttempts,
        failureCode: settings.lastFailureCode
      });
      message = await saveFailureStatusWithRetry(message);
      new Notice(`知识库${labelForRunMode(mode)}失败：${message}`);
      return {
        status: "failed",
        reportPath: failureReportPath,
        summary: "",
        processedSources: [],
        error: message,
        attempts: runAttempts,
        failureCode: settings.lastFailureCode,
        performance: progress.fail("failed", message)
      };
    } finally {
      await disposeKnowledgeTransactionSnapshot(transactionBefore);
      this.context.finishRun();
    }
  }

  private async runMaintenanceWithWorkflow(
    mode: "maintain" | "reingest",
    userRequest: string,
    turnOptionOverrides: KnowledgeBaseTurnOptionOverrides | undefined,
    selectedBackend: AgentBackendKind
  ): Promise<KnowledgeBaseDurableMaintenanceResult> {
    const requestedWorkflowRunId =
      turnOptionOverrides?.workflowRunId?.trim() ?? "";
    const scheduledStartedAt =
      turnOptionOverrides?.scheduledStartedAt;
    const invocationWorkflowRunId = isValidMaintenanceWorkflowRunId(
      requestedWorkflowRunId
    )
      ? requestedWorkflowRunId
      : `knowledge-${mode}-${Date.now()}`;
    if (this.context.isRunning()) {
      new Notice("知识库维护正在运行");
      return checkedDurableMaintenanceResult({
        status: "failed",
        reportPath: this.plugin.settings.knowledgeBase.lastReportPath,
        summary: "",
        processedSources: [],
        workflowRunId: invocationWorkflowRunId,
        selectedBackend,
        winnerBackend: null,
        terminalPhase: "preflight",
        commitState: "pre-wal",
        attempts: [],
        failureCode: "maintenance-already-running",
        error: "已有任务正在运行"
      });
    }

    this.context.beginRun();
    const progress = new KnowledgeWorkflowProgress(turnOptionOverrides?.onWorkflowEvent);
    progress.phase("prepare", "准备", "恢复维护状态并读取增量清单");
    let workflowRunId = "";
    let workflowReportPath = "";
    let discovery: KnowledgeBaseDiscovery | null = null;
    let sealedAttempt: MaintenanceRunExecutionResult | null = null;
    let activeRunJournal: LoadedActiveMaintenanceRunJournal | null = null;
    const preparedWorkflowWalRef: {
      current: LoadedMaintenanceWorkflowWal | null;
    } = { current: null };
    let storageRootPath = "";
    const runAttempts: KnowledgeRunAttemptRecord[] = [];
    const externalRawAdditions = new Set<string>();
    let pendingSourcePathsForFailure: string[] = [];
    let routingFailureCode = "";
    let terminalPhase: KnowledgeBaseRunTerminalPhase = "preflight";
    try {
      const vaultPath = this.plugin.getVaultPath();
      storageRootPath =
        this.plugin.getKnowledgeBaseWorkflowStorageRoot(vaultPath);
      await mkdir(storageRootPath, { recursive: true, mode: 0o700 });
      const recovered = await recoverPendingMaintenanceWorkflows({
        storageRootPath,
        liveVaultPath: vaultPath,
        settingsHost:
          this.plugin.getKnowledgeBaseWorkflowSettingsHost()
      });
      if (recovered.blocked > 0 || recovered.invalid > 0) {
        terminalPhase = "recovery-blocked";
        throw Object.assign(
          new Error(
            `知识库维护恢复被阻断：${recovered.issues.join("；") || "存在未解决的 workflow WAL"}`
          ),
          { code: "MAINTENANCE_RECOVERY_BLOCKED" }
        );
      }

      const startedAt =
        scheduledStartedAt ?? Date.now();
      workflowRunId = resolveMaintenanceWorkflowRunId(
        mode,
        startedAt,
        requestedWorkflowRunId
      );
      const settings = this.plugin.settings.knowledgeBase;
      const scheduledProjection =
        maintenanceWorkflowScheduledProjection(
          settings,
          workflowRunId,
          scheduledStartedAt
        );
      await reconcileTerminalActiveMaintenanceRunJournals(
        storageRootPath,
        settings
      );
      activeRunJournal = await createActiveMaintenanceRunJournal({
        storageRootPath,
        workflowRunId,
        mode,
        startedAt,
        selectedBackend,
        attempts: [],
        terminalPhase: "preflight"
      });
      const baselineProcessedSources = cloneProcessedSources(
        settings.processedSources
      );
      const baselineTerminal =
        maintenanceWorkflowTerminalSettings(settings);
      const rawBeforeContents = await snapshotRawFileContents(vaultPath);
      const rawBefore =
        fingerprintKnowledgeRawContentSnapshot(rawBeforeContents);
      assertSafeRawRoot(rawBeforeContents);
      assertSafeRawEntries(rawBeforeContents);
      discovery = await discoverKnowledgeBaseSources(
        vaultPath,
        baselineProcessedSources,
        mode
      );
      progress.progress(
        discovery.indexStats?.reused ?? 0,
        Math.max(1, discovery.sources.length),
        `变化来源 ${discovery.changedSources.length} 个`
      );
      const requestedRawPaths = extractRequestedRawPaths(userRequest);
      const promptSources = selectSourcesForRunMode(
        mode,
        discovery,
        userRequest
      );
      const runSources = promptSources.slice(0, MAX_ATTACHED_SOURCES);
      const remainingSources = promptSources.slice(MAX_ATTACHED_SOURCES);
      const deterministicNoop = runSources.length === 0
        && remainingSources.length === 0
        && requestedRawPaths.length === 0
        && discovery.changedSources.length === 0
        && discovery.skippedSources.length === 0;
      const noopReceipt: MaintenanceWorkflowNoopReceiptContract | undefined =
        deterministicNoop
          ? {
            schemaVersion:
              MAINTENANCE_WORKFLOW_NOOP_RECEIPT_SCHEMA_VERSION,
            kind: "run-scoped-report",
            pathStrategy: "workflow-run-id-sha256-v1",
            dateKey: formatDateForFile(new Date(startedAt))
          }
          : undefined;
      const reportPathForRun = noopReceipt
        ? maintenanceWorkflowNoopReceiptPath({
          mode,
          workflowRunId,
          receipt: noopReceipt
        })
        : discovery.reportPath;
      const reportMtimeBefore = await readKnowledgeBaseReportMtime(
        vaultPath,
        reportPathForRun
      );
      if (!deterministicNoop && runSources.length === 0) {
        pendingSourcePathsForFailure = Array.from(new Set([
          ...discovery.skippedSources.map((source) => source.relativePath),
          ...discovery.changedSources.map((source) => source.relativePath),
          ...requestedRawPaths
        ])).sort();
        throw Object.assign(
          new Error(
            pendingSourcePathsForFailure.length
              ? `仍有 ${pendingSourcePathsForFailure.length} 个来源待处理，但本轮没有可安全提交给 Agent 的来源：${pendingSourcePathsForFailure.join("、")}`
              : "本轮没有可安全提交给 Agent 的来源，不能误报为 noop"
          ),
          { code: "MAINTENANCE_SOURCES_PENDING" }
        );
      }
      this.throwIfCanceled();

      let routed: MaintenanceRunExecutionResult;
      if (deterministicNoop) {
        progress.phase("report", "报告", "没有变化，生成可审计终态报告");
        routed = {
          output: { text: "" },
          completion: "noop",
          verifiedSources: [],
          pendingSources: [],
          evidencePaths: {},
          warnings: [],
          reportPath: reportPathForRun
        };
      } else {
        progress.phase("digest", "执行", `交给所选 Agent 处理 ${runSources.length} 个来源`);
        progress.markAgentCalled();
        const rules = await this.context.resolveRulesFile();
        if (rules.useCustomRulesFile && !rules.exists) {
          throw new Error(
            `知识库操作指南文件不存在：${rules.relativePath}。请在设置里修正路径。`
          );
        }
        terminalPhase = "execution";
        activeRunJournal = await updateActiveMaintenanceRunState(
          activeRunJournal,
          runAttempts,
          "execution"
        );
        routed = await runSelectedMaintenanceAgentTask({
          workflowRunId,
          selectedBackend,
          attempts: runAttempts,
          onAttemptsChanged: async (attempts) => {
            activeRunJournal = await updateActiveMaintenanceRunState(
              activeRunJournal,
              attempts
            );
          },
          isBackendReady: async (backend) =>
            await this.context.isMaintenanceBackendReady(
              backend,
              runSources
            ),
          execute: async (attempt) =>
            await this.executeMaintenanceShadowAttempt({
              attempt,
              selectedBackend,
              liveVaultPath: vaultPath,
              shadowStorageRoot: storageRootPath,
              mode,
              userRequest,
              requestedRawPaths,
              reportPath: reportPathForRun,
              reportMtimeBefore,
              sources: runSources,
              skippedSources: discovery!.skippedSources,
              remainingSources,
              remainingSourceCount: Math.max(
                0,
                promptSources.length - runSources.length
              ),
              rules,
              processedSourcesBeforeRun: baselineProcessedSources,
              turnOptionOverrides
            })
        });
        sealedAttempt = routed;
      }
      progress.phase("organize", "整理", "校验 Shadow 成果与逐来源证据");
      terminalPhase = "verification";
      activeRunJournal = await updateActiveMaintenanceRunState(
        activeRunJournal,
        runAttempts,
        "verification"
      );
      this.throwIfCanceled();

      const rawAfterAttempt = await snapshotKnowledgeRawFiles(vaultPath);
      const rawChanges = classifyRawSnapshotChanges(
        rawBefore,
        rawAfterAttempt
      );
      collectExternalRawAdditions(
        externalRawAdditions,
        rawChanges.externalAdditions
      );
      if (rawChanges.blockingChanges.length) {
        throw new Error(
          formatRawIntegrityError(
            rawSnapshotChangeMessages(rawChanges.blockingChanges),
            false
          )
        );
      }

      const completion = routed.completion;
      const reportPath = routed.reportPath ?? reportPathForRun;
      workflowReportPath = reportPath;
      const structure = routed.structure;
      const conflictDuplicateCleanup =
        routed.conflictDuplicateCleanup ?? {
          moved: [],
          backupRoot: ""
        };
      let nextProcessedSources = rewriteProcessedSources(
        cloneProcessedSources(baselineProcessedSources),
        structure?.pathRewrites ?? []
      );
      const normalizedVerifiedSources = deterministicNoop
        ? []
        : await normalizeProcessedSources(
          vaultPath,
          routed.verifiedSources,
          []
        );
      const rawPlan = await planRawDigestMetadataForSources(
        vaultPath,
        normalizedVerifiedSources,
        {
          reportPath,
          startedAt,
          runId: workflowRunId,
          evidencePaths: routed.evidencePaths,
          confidence: "verified",
          checkCanceled: () => this.throwIfCanceled()
        }
      );
      for (const source of rawPlan.updatedSources) {
        nextProcessedSources[source.relativePath] = {
          path: source.relativePath,
          size: source.size,
          mtime: source.mtime,
          fingerprint: source.fingerprint,
          digestedAt: startedAt,
          reportPath,
          evidencePaths:
            routed.evidencePaths[source.relativePath] ?? [],
          runId: workflowRunId,
          confidence: "verified"
        };
      }

      const verifiedSourcePaths = rawPlan.updatedSources.map(
        (source) => source.relativePath
      );
      const partialIndexPlan =
        completion === "partial"
        && routed.reconciliationIndexPaths?.length
          ? await planMaintenanceIndexReconciliation(
            vaultPath,
            routed.reconciliationIndexPaths,
            {
              verifiedEvidencePaths:
                routed.evidencePaths,
              trustedSealedPagePaths:
                Object.values(routed.evidencePaths).flat(),
              skippedAgentIndexPaths:
                routed.skippedAgentIndexPaths
            }
          )
          : {
            committed: [],
            deferred: [],
            warnings: [],
            reconciledPaths: [],
            updatedPaths: []
          };
      const warnings = [
        ...routed.warnings,
        ...partialIndexPlan.warnings
      ];
      const indexWrites: MaintenanceWorkflowManagedWriteDraft[] = [];
      const indexCommitted: MaintenanceWorkflowIndexCommitRecord[] = [];
      if (!deterministicNoop) {
        const rawIndexWrite = await planKnowledgeBaseRawIndexWrite(
          vaultPath,
          nextProcessedSources,
          startedAt,
          { verifiedSourcePaths }
        );
        indexWrites.push(
          rawIndexWrite,
          ...maintenanceIndexManagedWrites(partialIndexPlan)
        );
        indexCommitted.push(
          rawIndexCommitRecord(rawIndexWrite),
          ...maintenanceIndexCommitRecords(partialIndexPlan)
        );
      }

      const trackerWrite = deterministicNoop
        ? null
        : await planKnowledgeBaseTrackerWrite(
          vaultPath,
          nextProcessedSources,
          startedAt
        );
      const reportBaseline = deterministicNoop
        ? await readMaintenanceContentFileBaseline(
          vaultPath,
          reportPath
        )
        : await readMaintenanceContentFileBaseline(
          routed.handle!.agentVaultPath,
          reportPath,
          { requireExisting: true }
        );
      if (deterministicNoop && reportBaseline.expected.kind !== "missing") {
        throw Object.assign(
          new Error(
            `noop 审计 receipt 已存在，拒绝覆盖：${reportPath}`
          ),
          { code: "MAINTENANCE_NOOP_RECEIPT_EXISTS" }
        );
      }
      if (!deterministicNoop) {
        progress.phase("report", "报告", "生成报告并准备原子提交");
      }
      if (!reportBaseline.content && !deterministicNoop) {
        throw new Error("sealed winner 缺少维护报告");
      }
      let reportExpectedPostShadow = reportBaseline.expected;
      let reportDesiredMode = reportBaseline.mode;
      if (!deterministicNoop) {
        const shadowResult = maintenanceShadowResultCasForPath(
          routed.changeSet!,
          reportPath
        );
        if (shadowResult?.kind === "missing") {
          throw new Error("sealed winner 删除了维护报告");
        }
        if (shadowResult?.kind === "file") {
          reportExpectedPostShadow = shadowResult;
          reportDesiredMode = shadowResult.mode;
        } else {
          const liveReportBaseline =
            await readMaintenanceContentFileBaseline(
              vaultPath,
              reportPath,
              { requireExisting: true }
            );
          reportExpectedPostShadow = liveReportBaseline.expected;
          reportDesiredMode = liveReportBaseline.mode;
        }
      }
      let reportBaselineContent =
        reportBaseline.content?.toString("utf8") ?? "";
      if (deterministicNoop) {
        reportBaselineContent = buildKnowledgeBaseNoopReportContent({
          mode,
          startedAt,
          checkedCount: discovery.sources.length,
          scopeLabel: noOpScopeLabel(mode),
          summary: noOpSummary(mode)
        });
      }
      reportBaselineContent =
        buildExternalRawAdditionsReportContent(
          reportBaselineContent,
          Array.from(externalRawAdditions)
        );
      const completedAt = Date.now();
      const historyEntry =
        canonicalizeKnowledgeBaseMaintenanceHistoryEntry({
          date: formatDateForFile(new Date(completedAt)),
          status: "success",
          at: completedAt,
          runId: workflowRunId,
          mode,
          reportPath,
          completion,
          selectedBackend,
          winnerBackend: routed.attempt?.backend ?? null,
          attempts: cloneList(runAttempts),
          pendingSources: routed.pendingSources.map(
            (item) => item.source.relativePath
          ),
          failureCode: null,
          terminalPhase: "finalized",
          commitState: "committed",
          warnings: cloneList(warnings)
        });
      if (
        !historyEntry
        || historyEntry.runId !== workflowRunId
        || historyEntry.completion === undefined
        || historyEntry.selectedBackend === undefined
        || !Object.prototype.hasOwnProperty.call(
          historyEntry,
          "winnerBackend"
        )
      ) {
        throw new Error("知识库维护终态元数据无法规范化");
      }
      const canonicalAttempts = cloneList(historyEntry.attempts ?? []);
      const canonicalPendingSourcePaths = [
        ...(historyEntry.pendingSources ?? [])
      ];
      const canonicalWarnings = cloneList(historyEntry.warnings ?? []);
      const canonicalWinnerBackend =
        historyEntry.winnerBackend ?? null;
      const pendingSourcesByPath = new Map(
        routed.pendingSources.map((pending) => [
          pending.source.relativePath,
          pending
        ])
      );
      const canonicalPendingSources =
        canonicalPendingSourcePaths.map((relativePath) => {
          const pending = pendingSourcesByPath.get(relativePath);
          if (!pending) {
            throw new Error(
              `知识库 pending source 无法绑定 canonical 路径：${relativePath}`
            );
          }
          return pending;
        });
      const canonicalWinnerAttempt = canonicalAttempts.at(-1) ?? null;
      if (
        canonicalWinnerBackend === null
          ? canonicalWinnerAttempt !== null
          : (
            !canonicalWinnerAttempt
            || canonicalWinnerAttempt.backend
              !== canonicalWinnerBackend
          )
      ) {
        throw new Error("知识库维护 winner 与 canonical attempt 不一致");
      }
      const finalBlockInput = {
        completion: historyEntry.completion,
        workflowRunId,
        ...(canonicalWinnerAttempt
          ? {
            attemptId: canonicalWinnerAttempt.attemptId,
            backend: canonicalWinnerAttempt.backend
          }
          : {}),
        verifiedSources: rawPlan.updatedSources,
        pendingSources: canonicalPendingSources,
        warnings: canonicalWarnings
      };
      const finalBlock =
        buildKnowledgeBaseMaintenanceFinalBlock(finalBlockInput);
      const reportWrite = planKnowledgeBaseMaintenanceReportWrite({
        reportPath,
        expected: reportExpectedPostShadow,
        baselineContent: Buffer.from(reportBaselineContent, "utf8"),
        desiredMode: reportDesiredMode,
        startedAt,
        completedAt,
        finalBlock: finalBlockInput
      });

      const output = routed.output.text;
      const summary = deterministicNoop
        ? noOpSummary(mode)
        : buildMaintenanceSummary(
          output,
          mode,
          structure,
          conflictDuplicateCleanup
        );
      const targetTerminal = {
        lastRunAt: completedAt,
        lastRunStatus: "success" as const,
        lastReportPath: reportPath,
        lastError: "",
        lastSummary: summary,
        lastCompletion: historyEntry.completion,
        lastAttempts: cloneList(canonicalAttempts),
        lastPendingSources: [...canonicalPendingSourcePaths],
        lastFailureCode: "",
        lastWarnings: cloneList(canonicalWarnings)
      };
      const managedWrites: MaintenanceWorkflowManagedWriteDraft[] = [
        ...rawPlan.managedWrites,
        ...indexWrites,
        reportWrite,
        ...(trackerWrite ? [trackerWrite] : [])
      ];
      const verifiedSourceRecords =
        rawPlan.updatedSources.map(maintenanceWorkflowSourceRecord);
      const pendingSourceRecords = canonicalPendingSources.map((pending) => ({
        source: maintenanceWorkflowSourceRecord(pending.source),
        reason: {
          code: pending.reason.code,
          message: pending.reason.message,
          ...(pending.reason.relatedSources
            ? {
              relatedSources: [...pending.reason.relatedSources]
            }
            : {}),
          ...(pending.reason.targetPaths
            ? { targetPaths: [...pending.reason.targetPaths] }
            : {})
        }
      }));
      this.throwIfCanceled();
      if (!this.context.tryEnterCommitPhase()) {
        throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      }
      progress.phase("complete", "完成", "提交 WAL 并保存终态");
      terminalPhase = "commit";
      await prepareAndCommitMaintenanceWorkflow({
        storageRootPath,
        liveVaultPath: vaultPath,
        draft: {
          workflowRunId,
          mode,
          startedAt,
          createdAt: new Date().toISOString(),
          selectedBackend,
          candidateBackends:
            maintenanceBackendOrder(selectedBackend),
          winner: canonicalWinnerAttempt
            ? {
              attemptId: canonicalWinnerAttempt.attemptId,
              ordinal: canonicalWinnerAttempt.ordinal,
              backend: canonicalWinnerAttempt.backend
            }
            : null,
          completion: historyEntry.completion,
          ...(noopReceipt ? { noopReceipt } : {}),
          attempts: cloneList(canonicalAttempts),
          verifiedSources: verifiedSourceRecords,
          pendingSources: pendingSourceRecords,
          evidencePaths: cloneEvidencePaths(routed.evidencePaths),
          warnings: cloneList(canonicalWarnings),
          summary,
          report: {
            relativePath: reportPath,
            finalBlockDigest:
              maintenanceWorkflowTextDigest(finalBlock)
          },
          indexReconciliation: {
            committed: indexCommitted,
            deferred: partialIndexPlan.deferred.map((entry) => ({
              relativePath: entry.relativePath,
              sourcePaths: [...entry.sourcePaths],
              reason: entry.reason
            })),
            warnings: cloneList(partialIndexPlan.warnings)
          },
          settings: {
            baselineProcessedSources,
            targetProcessedSources: nextProcessedSources,
            removedProcessedSourcePaths: [],
            baselineTerminal,
            targetTerminal,
            historyEntry,
            scheduled: scheduledProjection
          }
        },
        managedWrites,
        outcome: deterministicNoop
          ? {
            kind: "noop",
            discoveredSources:
              discovery.sources.map(
                maintenanceWorkflowSourceRecord
              ),
            changedSources: []
          }
          : {
            kind: "shadow",
            changeSet: routed.changeSet!,
            allowPaths: routed.allowPaths
          },
        settingsHost:
          this.plugin.getKnowledgeBaseWorkflowSettingsHost(),
        onWalPrepared: (prepared) => {
          preparedWorkflowWalRef.current = prepared;
        }
      });
      await removeTerminalActiveMaintenanceRunJournal(
        activeRunJournal,
        "committed"
      ).catch((error) => {
        console.warn(
          "知识库维护已提交，但 active-run journal 清理失败；下轮将按终态历史重试清理",
          error
        );
      });
      activeRunJournal = null;

      const current = this.plugin.settings.knowledgeBase;
      const performance = progress.complete(current.lastSummary || summary);
      performance.index = {
        reused: discovery.indexStats?.reused ?? 0,
        refreshed: discovery.indexStats?.refreshed ?? 0,
        targets: runSources.length
      };
      new Notice(`知识库${labelForRunMode(mode)}完成`);
      return checkedDurableMaintenanceResult({
        status: "success",
        reportPath,
        summary: current.lastSummary || summary,
        processedSources: processedSourcesForRunMode(
          mode,
          rawPlan.updatedSources
        ),
        workflowRunId,
        selectedBackend,
        winnerBackend: canonicalWinnerBackend,
        terminalPhase: "finalized",
        commitState: "committed",
        structure,
        externalRawAdditions: Array.from(externalRawAdditions),
        digestEvidencePaths: cloneEvidencePaths(
          routed.evidencePaths
        ),
        attempts: cloneList(canonicalAttempts),
        completion: historyEntry.completion,
        pendingSources: canonicalPendingSourcePaths,
        failureCode: null,
        warnings: canonicalWarnings,
        performance
      });
    } catch (error) {
      if (error instanceof MaintenanceAgentRoutingError) {
        routingFailureCode =
          error.failure.code || error.failure.category;
        terminalPhase = error.failure.phase;
      } else if (
        error
        && typeof error === "object"
        && "code" in error
        && String((error as { code?: unknown }).code ?? "")
          === "MAINTENANCE_RECOVERY_BLOCKED"
      ) {
        terminalPhase = "recovery-blocked";
      }
      const message = error instanceof Error
        ? error.message
        : String(error);
      const structuredFailureCode = maintenanceErrorCode(error);
      const walSnapshot = workflowRunId && storageRootPath
        ? await maintenanceWorkflowWalSnapshot(
          storageRootPath,
          workflowRunId,
          preparedWorkflowWalRef.current?.handle
        )
        : null;
      const walPersisted = walSnapshot !== null;
      if (!walPersisted && sealedAttempt?.handle) {
        try {
          await markMaintenanceShadowTerminal(
            sealedAttempt.handle,
            "discarded"
          );
          await cleanupMaintenanceShadowVault(
            sealedAttempt.handle
          );
        } catch {
          await abandonMaintenanceShadowVault(
            sealedAttempt.handle,
            message
          ).catch(() => undefined);
        }
      }
      if (walSnapshot) {
        const { intent, phase: walPhase } = walSnapshot;
        if (walPhase === "finalized") {
          await removeTerminalActiveMaintenanceRunJournal(
            activeRunJournal,
            "finalized"
          ).catch((cleanupError) => {
            console.warn(
              "finalized 维护的 active-run journal 清理失败；启动恢复会重试",
              cleanupError
            );
          });
          activeRunJournal = null;
          new Notice(`知识库${labelForRunMode(mode)}完成`);
          return checkedDurableMaintenanceResult({
            status: "success",
            reportPath: intent.report.relativePath,
            summary: intent.summary,
            processedSources: [],
            workflowRunId: intent.workflowRunId,
            selectedBackend: intent.selectedBackend,
            winnerBackend: intent.winner?.backend ?? null,
            terminalPhase: "finalized",
            commitState: "committed",
            completion: intent.completion,
            attempts: cloneList(intent.attempts),
            pendingSources: intent.pendingSources.map(
              (pending) => pending.source.relativePath
            ),
            failureCode: null,
            warnings: cloneList(intent.warnings),
            performance: progress.complete(intent.summary)
          });
        }
        const pendingTerminalPhase: KnowledgeBaseRunTerminalPhase =
          walPhase === "settings_committed"
            ? "cleanup"
            : "commit";
        const pendingMessage =
          `${message}；提交意图已持久化，后续只会恢复当前 winner，不会切换 Agent`;
        new Notice(`知识库${labelForRunMode(mode)}等待恢复`);
        return checkedDurableMaintenanceResult({
          status: "failed",
          reportPath: intent.report.relativePath
            || workflowReportPath
            || discovery?.reportPath
            || "",
          summary: "",
          processedSources: [],
          workflowRunId: intent.workflowRunId,
          selectedBackend: intent.selectedBackend,
          winnerBackend: intent.winner?.backend ?? null,
          terminalPhase: pendingTerminalPhase,
          commitState: "wal-persisted",
          completion: intent.completion,
          error: pendingMessage,
          attempts: cloneList(intent.attempts),
          pendingSources: intent.pendingSources.map(
            (pending) => pending.source.relativePath
          ),
          warnings: cloneList(intent.warnings),
          failureCode: "maintenance-commit-pending",
          performance: progress.fail("failed", pendingMessage)
        });
      }

      const canceled = !this.context.isCommitPhaseLocked()
        && (
          this.context.isCancelRequested()
          || isKnowledgeBaseCancelError(message)
        );
      const settings = this.plugin.settings.knowledgeBase;
      settings.lastRunAt = Date.now();
      settings.lastRunStatus =
        canceled ? "canceled" : "failed";
      settings.lastError = message;
      settings.lastSummary = "";
      settings.lastCompletion = "";
      settings.lastAttempts = cloneList(runAttempts);
      settings.lastPendingSources = [...pendingSourcePathsForFailure];
      settings.lastFailureCode = canceled
        ? "cancelled"
        : routingFailureCode
          || structuredFailureCode
          || "maintenance-failed";
      settings.lastWarnings = [];
      const terminalWorkflowRunId =
        workflowRunId || invocationWorkflowRunId;
      recordKnowledgeBaseMaintenanceRun(settings, {
        status: canceled ? "canceled" : "failed",
        mode,
        runId: terminalWorkflowRunId,
        reportPath: "",
        selectedBackend,
        winnerBackend: null,
        attempts: cloneList(runAttempts),
        pendingSources: [...pendingSourcePathsForFailure],
        failureCode: settings.lastFailureCode,
        terminalPhase,
        commitState: "pre-wal",
        errorCode: settings.lastFailureCode
      });
      const saveError = await saveSettingsSafely(this.plugin);
      let terminalStatePersisted = !saveError;
      let finalMessage = message;
      if (saveError) {
        finalMessage = appendKnowledgeBaseWarning(
          message,
          `状态保存失败：${saveError}`
        );
        settings.lastError = finalMessage;
        const retryError = await saveSettingsSafely(this.plugin);
        if (retryError) {
          finalMessage = appendKnowledgeBaseWarning(
            finalMessage,
            `状态保存重试失败：${retryError}`
          );
          settings.lastError = finalMessage;
        } else {
          terminalStatePersisted = true;
        }
      }
      if (terminalStatePersisted) {
        await removeTerminalActiveMaintenanceRunJournal(
          activeRunJournal,
          "pre-wal-terminal"
        ).catch((cleanupError) => {
          console.warn(
            "pre-WAL 维护终态已保存，但 active-run journal 清理失败；下轮将重试",
            cleanupError
          );
        });
        activeRunJournal = null;
      }
      new Notice(
        `知识库${labelForRunMode(mode)}${canceled ? "已取消" : `失败：${finalMessage}`}`
      );
      return checkedDurableMaintenanceResult({
        status: canceled ? "canceled" : "failed",
        reportPath: "",
        summary: "",
        processedSources: [],
        workflowRunId: terminalWorkflowRunId,
        selectedBackend,
        winnerBackend: null,
        terminalPhase,
        commitState: "pre-wal",
        error: finalMessage,
        attempts: cloneList(runAttempts),
        pendingSources: [...pendingSourcePathsForFailure],
        failureCode: settings.lastFailureCode,
        performance: progress.fail(
          canceled ? "canceled" : "failed",
          finalMessage
        )
      });
    } finally {
      this.context.finishRun();
    }
  }

  private throwIfCanceled(): void {
    if (this.context.isCancelRequested()) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
  }
}

function resolveMaintenanceWorkflowRunId(
  mode: "maintain" | "reingest",
  startedAt: number,
  requestedWorkflowRunId: string
): string {
  const workflowRunId =
    requestedWorkflowRunId || `knowledge-${mode}-${startedAt}`;
  if (!isValidMaintenanceWorkflowRunId(workflowRunId)) {
    throw Object.assign(
      new Error("知识库维护 workflowRunId 非法"),
      { code: "INVALID_WORKFLOW_RUN_ID" }
    );
  }
  return workflowRunId;
}

function isValidMaintenanceWorkflowRunId(value: string): boolean {
  return Boolean(
    value.trim()
    && value.length <= 512
    && !value.includes("\0")
  );
}

function checkedDurableMaintenanceResult(
  result: KnowledgeBaseDurableMaintenanceResult
): KnowledgeBaseDurableMaintenanceResult {
  assertDurableMaintenanceResult(result);
  return result;
}

function maintenanceWorkflowScheduledProjection(
  settings: KnowledgeBaseSettings,
  workflowRunId: string,
  scheduledStartedAt: number | undefined
): MaintenanceWorkflowScheduledProjection | null {
  if (scheduledStartedAt === undefined) return null;
  if (
    !Number.isSafeInteger(scheduledStartedAt)
    || scheduledStartedAt <= 0
    || settings.lastScheduledRunAt !== scheduledStartedAt
    || settings.lastScheduledRunStatus !== "running"
    || settings.lastScheduledRunId !== workflowRunId
  ) {
    throw Object.assign(
      new Error("每日知识库维护 running 基线与 workflowRunId/startedAt 不一致"),
      { code: "SCHEDULED_BASELINE_MISMATCH" }
    );
  }
  const baseline = {
    lastScheduledRunAt: scheduledStartedAt,
    lastScheduledRunStatus: "running" as const,
    lastScheduledRunId: workflowRunId
  };
  return {
    baseline,
    target: {
      ...baseline,
      lastScheduledRunStatus: "success"
    }
  };
}

function maintenanceErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = String((error as { code?: unknown }).code ?? "").trim();
  return code.length <= 160 ? code : code.slice(0, 160);
}

function maintenanceWorkflowTerminalSettings(
  settings: KnowledgeBaseSettings
) {
  return {
    lastRunAt: settings.lastRunAt,
    lastRunStatus: settings.lastRunStatus,
    lastReportPath: settings.lastReportPath,
    lastError: settings.lastError,
    lastSummary: settings.lastSummary,
    lastCompletion: settings.lastCompletion,
    lastAttempts: cloneList(settings.lastAttempts),
    lastPendingSources: [...settings.lastPendingSources],
    lastFailureCode: settings.lastFailureCode,
    lastWarnings: cloneList(settings.lastWarnings)
  };
}

function usesDurableMaintenanceWorkflow(
  mode: KnowledgeBaseRunMode
): boolean {
  return mode === "maintain" || mode === "reingest";
}

function maintenanceWorkflowSourceRecord(
  source: Pick<
    KnowledgeBaseSource,
    "relativePath" | "size" | "mtime" | "fingerprint"
  >
): MaintenanceWorkflowSourceRecord {
  return {
    relativePath: source.relativePath,
    size: source.size,
    mtime: source.mtime,
    fingerprint: source.fingerprint
  };
}

function cloneEvidencePaths(
  evidencePaths: Record<string, string[]>
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(evidencePaths).map(([sourcePath, paths]) => [
      sourcePath,
      [...paths]
    ])
  );
}

function maintenanceWorkflowTextDigest(text: string): string {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(text, "utf8"))
    .digest("hex")}`;
}

async function maintenanceWorkflowWalSnapshot(
  storageRootPath: string,
  workflowRunId: string,
  preparedHandle?: LoadedMaintenanceWorkflowWal["handle"]
): Promise<{
  phase: MaintenanceWorkflowWalPhase;
  intent: Extract<
    Awaited<ReturnType<typeof listMaintenanceWorkflowWals>>[number],
    { status: "ready" | "blocked" }
  >["wal"]["intent"];
} | null> {
  if (preparedHandle) {
    try {
      const loaded = await loadMaintenanceWorkflowWal(preparedHandle);
      if (loaded.intent.workflowRunId === workflowRunId) {
        return {
          phase: loaded.state.phase,
          intent: loaded.intent
        };
      }
    } catch {
      // Fall through to the complete inventory so an independently recovered
      // or relocated WAL can still be found without trusting stale memory.
    }
  }
  let entries: Awaited<
    ReturnType<typeof listMaintenanceWorkflowWals>
  >;
  try {
    entries = await listMaintenanceWorkflowWals(
      storageRootPath
    );
  } catch {
    return null;
  }
  const matching = entries.find((entry) =>
    entry.status !== "invalid"
    && entry.wal.intent.workflowRunId === workflowRunId
  );
  return matching && matching.status !== "invalid"
    ? {
      phase: matching.wal.state.phase,
      intent: matching.wal.intent
    }
    : null;
}

async function reconcileTerminalActiveMaintenanceRunJournals(
  storageRootPath: string,
  settings: KnowledgeBaseSettings
): Promise<void> {
  const activeRuns = await listActiveMaintenanceRunJournals(
    storageRootPath
  );
  for (const active of activeRuns) {
    const matchingHistory = settings.maintenanceHistory.filter(
      (entry) => entry.runId === active.record.workflowRunId
    );
    if (
      matchingHistory.length !== 1
      || !durableMaintenanceResultFromHistory(matchingHistory[0])
    ) {
      throw Object.assign(
        new Error(
          `存在未收口的 pre-WAL 维护运行：${active.record.workflowRunId}（${active.record.terminalPhase}）；缺少唯一且完整的 durable 终态历史`
        ),
        { code: "MAINTENANCE_RECOVERY_BLOCKED" }
      );
    }
  }
  for (const active of activeRuns) {
    await removeTerminalActiveMaintenanceRunJournal(
      active,
      "history-reconciled"
    );
  }
}

async function updateActiveMaintenanceRunState(
  current: LoadedActiveMaintenanceRunJournal | null,
  attempts: readonly KnowledgeRunAttemptRecord[],
  terminalPhase?: ActiveMaintenanceRunTerminalPhase
): Promise<LoadedActiveMaintenanceRunJournal> {
  if (!current) {
    throw Object.assign(
      new Error("pre-WAL active-run journal 缺失"),
      { code: "MAINTENANCE_ACTIVE_RUN_JOURNAL_MISSING" }
    );
  }
  return await updateActiveMaintenanceRunJournal(
    current.handle,
    {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      attempts,
      ...(terminalPhase ? { terminalPhase } : {})
    }
  );
}

async function removeTerminalActiveMaintenanceRunJournal(
  current: LoadedActiveMaintenanceRunJournal | null,
  _reason: string
): Promise<void> {
  if (!current) return;
  await removeActiveMaintenanceRunJournal(
    current.handle,
    {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest
    }
  );
}

export interface RunSelectedMaintenanceAgentTaskInput {
  workflowRunId: string;
  selectedBackend: AgentBackendKind;
  attempts: KnowledgeRunAttemptRecord[];
  onAttemptsChanged?(
    attempts: readonly KnowledgeRunAttemptRecord[]
  ): Promise<void>;
  isBackendReady(backend: AgentBackendKind): Promise<boolean>;
  execute(attempt: MaintenanceRoutingAttempt): Promise<MaintenanceShadowAttemptSuccess>;
}

export interface RunSelectedMaintenanceAgentTaskResult {
  output: KnowledgeAgentTaskOutput;
  workflow: MaintenanceRoutingWorkflow;
  attempt: MaintenanceRoutingAttempt;
  completion: KnowledgeBaseRunCompletion;
  verifiedSources: KnowledgeBaseSource[];
  pendingSources: DigestEvidencePendingSource[];
  evidencePaths: Record<string, string[]>;
  handle: MaintenanceShadowHandle;
  changeSet: MaintenanceShadowChangeSet;
  allowPaths: string[];
  reportPath: string;
  structure?: import("./types").StructureNormalizationResult;
  conflictDuplicateCleanup: KnowledgeConflictDuplicateCleanup;
  skippedAgentIndexPaths: string[];
  reconciliationIndexPaths: string[];
  warnings: KnowledgeBaseRunWarning[];
}

export class MaintenanceAgentRoutingError extends Error {
  readonly code: string;

  constructor(
    cause: unknown,
    readonly failure: MaintenanceFailureClassification,
    readonly workflow: MaintenanceRoutingWorkflow,
    readonly attempt: MaintenanceRoutingAttempt
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MaintenanceAgentRoutingError";
    this.code = failure.code || failure.category;
  }
}

class MaintenanceAttemptJournalSyncError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MaintenanceAttemptJournalSyncError";
  }
}

async function notifyMaintenanceAttemptsChanged(
  input: RunSelectedMaintenanceAgentTaskInput
): Promise<void> {
  try {
    await input.onAttemptsChanged?.(input.attempts);
  } catch (error) {
    throw new MaintenanceAttemptJournalSyncError(error);
  }
}

export function maintenanceTurnOverridesForAttempt(
  overrides: KnowledgeBaseTurnOptionOverrides | undefined,
  selectedBackend: AgentBackendKind,
  attemptBackend: AgentBackendKind
): KnowledgeBaseTurnOptionOverrides | undefined {
  if (!overrides || attemptBackend === selectedBackend) return overrides;
  const { model: _selectedBackendModel, harnessSession: _maintenanceSession, ...portable } = overrides;
  return {
    ...portable,
    // An empty Codex model means "resolve this backend's configured/default
    // model". A model chosen for the selected Agent must never leak into a
    // fallback Agent with a different provider namespace.
    model: ""
  };
}

/**
 * Runs the selected Agent first. Standby Agents are inspected only after a
 * definitive preflight failure or a submitted infrastructure failure carrying
 * the typed same-lease termination + quarantined zero-result proof. Callers
 * cannot fabricate either post-start capability.
 */
export async function runSelectedMaintenanceAgentTask(
  input: RunSelectedMaintenanceAgentTaskInput
): Promise<RunSelectedMaintenanceAgentTaskResult> {
  const started = startMaintenanceRouting(createMaintenanceRoutingWorkflow({
    workflowId: input.workflowRunId,
    selectedBackend: input.selectedBackend
  }));
  let workflow = started.workflow;
  let attempt = started.attempt;

  while (true) {
    const record: KnowledgeRunAttemptRecord = {
      attemptId: attempt.attemptId,
      ordinal: attempt.ordinal,
      backend: attempt.backend
    };
    input.attempts.push(record);
    await notifyMaintenanceAttemptsChanged(input);
    try {
      const execution = await input.execute(attempt);
      const output = execution.output;
      if (output.submittedAt !== undefined) {
        record.submitted = {
          at: output.submittedAt,
          harnessRunId: output.harnessRunId || attempt.attemptId
        };
      }
      const nativeExecution = output.harnessResult?.nativeExecution;
      if (nativeExecution) {
        record.native = {
          id: nativeExecution.id,
          kind: nativeExecution.kind,
          persistence: nativeExecution.persistence
        };
      }
      if (execution.staging) {
        record.staging = { ...execution.staging };
      }
      record.terminal = { status: "completed", at: Date.now() };
      await notifyMaintenanceAttemptsChanged(input);
      const completion = attempt.ordinal > 1 && execution.completion === "full"
        ? "recovered"
        : execution.completion;
      return {
        output,
        workflow,
        attempt,
        completion,
        verifiedSources: execution.verifiedSources,
        pendingSources: execution.pendingSources,
        evidencePaths: execution.evidencePaths,
        handle: execution.handle,
        changeSet: execution.changeSet,
        allowPaths: execution.allowPaths,
        reportPath: execution.reportPath,
        structure: execution.structure,
        conflictDuplicateCleanup: execution.conflictDuplicateCleanup,
        skippedAgentIndexPaths: execution.skippedAgentIndexPaths,
        reconciliationIndexPaths: execution.reconciliationIndexPaths,
        warnings: execution.warnings
      };
    } catch (error) {
      if (error instanceof MaintenanceAttemptJournalSyncError) throw error.cause;
      const pipelineError = error instanceof MaintenanceShadowAttemptError ? error : null;
      const cause = pipelineError?.cause ?? error;
      const attemptError = cause instanceof KnowledgeAgentAttemptError ? cause : null;
      const submittedAt = attemptError?.submittedAt ?? pipelineError?.submittedAt;
      const harnessRunId = attemptError?.harnessRunId || pipelineError?.harnessRunId || attempt.attemptId;
      const nativeExecutionId =
        pipelineError?.nativeExecutionId || attemptError?.nativeExecutionId || "";
      const terminationConfirmedAt =
        pipelineError?.terminationConfirmedAt ?? attemptError?.terminationConfirmedAt;
      const cancelled = isKnowledgeBaseCancelError(cause instanceof Error ? cause.message : String(cause));
      if (submittedAt !== undefined) {
        record.submitted = {
          at: submittedAt,
          harnessRunId
        };
      }
      const failure = classifyMaintenanceFailure({
        phase: pipelineError?.phase ?? attemptError?.phase ?? "preflight",
        error: cause,
        agentStarted: submittedAt !== undefined
      });
      if (nativeExecutionId) {
        // The provider exposed an opaque native id but not necessarily a
        // durable kind/persistence contract on the failure path.
        record.native = { id: nativeExecutionId };
      }
      if (terminationConfirmedAt !== undefined) {
        record.termination = { confirmedAt: terminationConfirmedAt };
      }
      if (pipelineError?.staging) {
        record.staging = { ...pipelineError.staging };
      }
      record.failure = {
        code: failure.code || failure.category,
        at: Date.now(),
        message: failure.message,
        phase: failure.phase,
        retryable: failure.retryable,
        failoverEligible: failure.failoverEligible
      };
      record.terminal = {
        status: cancelled ? "canceled" : "failed",
        at: Date.now(),
        message: failure.message
      };
      await notifyMaintenanceAttemptsChanged(input);

      const decision = await resolveMaintenanceAttemptOutcome({
        workflow,
        attempt,
        outcome: cancelled
          ? { status: "cancelled", failure }
          : {
            status: "failed",
            failure,
            ...(pipelineError?.postStartFailoverProof
              ? { postStartFailoverProof: pipelineError.postStartFailoverProof }
              : {})
          },
        isBackendReady: input.isBackendReady
      });
      if (decision.action === "retry") {
        workflow = decision.workflow;
        attempt = decision.attempt;
        continue;
      }
      throw new MaintenanceAgentRoutingError(error, failure, decision.workflow, attempt);
    }
  }
}

async function prepareIncrementalRunScope(
  vaultPath: string,
  mode: KnowledgeBaseRunMode,
  userRequest: string
): Promise<{
  refresh: KnowledgeBaseIndexRefreshResult | null;
  scope: KnowledgeBaseIncrementalScope | null;
  checkpoint: KnowledgeBaseIndexCheckpoint | null;
  filter?: (entry: KnowledgeBaseIndexEntry) => boolean;
  targetPaths: string[];
  sources: KnowledgeBaseSource[];
}> {
  if (mode === "maintain" || mode === "reingest") {
    return { refresh: null, scope: null, checkpoint: null, targetPaths: [], sources: [] };
  }
  const full = hasFullScanFlag(userRequest);
  const roots = mode === "lint" ? ["wiki", "projects"] as const : mode === "outputs" ? ["outputs"] as const : ["inbox"] as const;
  const checkpoint: KnowledgeBaseIndexCheckpoint = mode === "lint" ? "lint" : mode;
  const filter = mode === "outputs"
    ? isKnowledgeBaseOutputWorkItem
    : mode === "inbox"
      ? isKnowledgeBaseInboxWorkItem
      : undefined;
  const refresh = await refreshKnowledgeBaseIndex(vaultPath, { roots: [...roots] });
  const scope = selectKnowledgeBaseIncrementalScope(refresh, checkpoint, {
    full,
    includeNeighbors: mode === "lint",
    limit: mode === "lint" ? 80 : 200,
    filter
  });
  const targetPaths = scope.paths;
  const sources = targetPaths
    .map((relativePath) => refresh.index.entries[relativePath])
    .filter((entry): entry is KnowledgeBaseIndexEntry => Boolean(entry))
    .map((entry) => indexEntryToKnowledgeSource(vaultPath, entry));
  return { refresh, scope, checkpoint, filter, targetPaths, sources };
}

function indexEntryToKnowledgeSource(vaultPath: string, entry: KnowledgeBaseIndexEntry): KnowledgeBaseSource {
  return {
    relativePath: entry.path,
    absolutePath: path.join(vaultPath, entry.path),
    size: entry.size,
    mtime: entry.mtime,
    fingerprint: entry.fingerprint,
    mime: "text/markdown",
    modality: "text",
    changed: true
  };
}

function emptyDiscoveryForMode(vaultPath: string, mode: KnowledgeBaseRunMode): KnowledgeBaseDiscovery {
  return {
    vaultPath,
    sources: [],
    changedSources: [],
    skippedSources: [],
    reportPath: knowledgeBaseReportPathForMode(mode),
    trackerPath: path.join(vaultPath, "outputs", ".ingest-tracker.md")
  };
}

function shouldUseNoopFastPath(
  mode: KnowledgeBaseRunMode,
  userRequest: string,
  discovery: KnowledgeBaseDiscovery,
  scope: KnowledgeBaseIncrementalScope | null,
  targetPaths: string[]
): boolean {
  if (!isBareKnowledgeCommand(mode, userRequest)) return false;
  if (mode === "reingest") return false;
  if (mode === "maintain") {
    return discovery.changedSources.length === 0 && discovery.skippedSources.length === 0;
  }
  return Boolean(scope && targetPaths.length === 0 && scope.deletedPaths.length === 0);
}

function isBareKnowledgeCommand(mode: KnowledgeBaseRunMode, userRequest: string): boolean {
  const text = userRequest.trim();
  if (!text) return true;
  const commands: Record<KnowledgeBaseRunMode, string[]> = {
    maintain: ["maintain", "ingest", "digest", "维护"],
    lint: ["check", "lint", "doctor", "体检", "检查"],
    reingest: ["reingest", "redigest", "重新提炼"],
    outputs: ["outputs", "output", "处理outputs", "处理输出"],
    inbox: ["inbox", "处理inbox", "收件箱"]
  };
  const alternatives = commands[mode].map(escapeRegExp).join("|");
  return new RegExp(`^/(?:${alternatives})\\s*$`, "iu").test(text);
}

function hasFullScanFlag(userRequest: string): boolean {
  return /(?:^|\s)--full(?:\s|$)/i.test(userRequest) || /全库|完整体检|全量体检/.test(userRequest);
}

function buildKnowledgeBaseNoopReportContent(input: {
  mode: KnowledgeBaseRunMode;
  startedAt: number;
  checkedCount: number;
  scopeLabel: string;
  summary: string;
}): string {
  return [
    "---",
    `created: ${new Date(input.startedAt).toISOString()}`,
    "source: codex-echoink",
    `mode: ${input.mode}`,
    "status: success",
    "incremental: true",
    "agent_called: false",
    "---",
    "",
    `# 知识库${labelForRunMode(input.mode)}报告 — ${formatDateForFile(new Date(input.startedAt))}`,
    "",
    "## 一眼结论",
    "",
    input.summary,
    "",
    "## 本轮固定流程",
    "",
    `- 已检查范围：${input.scopeLabel}。`,
    `- 增量清单命中：${input.checkedCount} 个文件。`,
    "- 内容变化：0 个。",
    "- 没有变化时直接收口，不调用模型，也不重复扫描全部正文。",
    "",
    "## 未改动边界",
    "",
    "- 未改动 Raw 正文。",
    "- 未改动 Wiki / Projects 正文。",
    "- 未改动 tracker 和索引正文。",
    ""
  ].join("\n");
}

function noOpSummary(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "增量体检完成：自上次成功体检后没有知识文件变化，本轮未调用模型。";
  if (mode === "outputs") return "outputs 增量检查完成：没有新的待处理文件，本轮未调用模型。";
  if (mode === "inbox") return "inbox 增量检查完成：没有新的待分流文件，本轮未调用模型。";
  return "知识库增量维护完成：没有新增或变更 Raw，本轮未调用模型。";
}

function noOpScopeLabel(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "Wiki / Projects 指纹及引用邻域";
  if (mode === "outputs") return "outputs 待办区";
  if (mode === "inbox") return "inbox 待办区";
  return "Raw 增量清单";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
