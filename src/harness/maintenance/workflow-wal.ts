import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import type { AgentBackendKind } from "../../agent/types";
import {
  canonicalizeKnowledgeBaseMaintenanceHistoryEntry,
  type KnowledgeBaseMaintenanceHistoryEntry,
  type KnowledgeBaseNativeLifecycleRecoveryReceipt,
  type KnowledgeBaseProcessedSource,
  type KnowledgeBaseRunStatus
} from "../../settings/settings";
import type {
  KnowledgeBaseRunCompletion,
  KnowledgeBaseRunWarning,
  KnowledgeRunAttemptRecord
} from "../../knowledge-base/types";
import {
  RAW_DIGEST_MANAGED_KEYS,
  RAW_DIGEST_SCHEMA_VERSION,
  RAW_DIGEST_STATUS_DIGESTED,
  buildRawDigestRegistryContent,
  isRawMarkdownPath,
  normalizeRawDigestRegistry,
  rawDigestFingerprint,
  rawDigestPreservesUserFrontmatterBytes,
  rawDigestRecordFromMarkdown,
  rawDigestRecordIsTrusted,
  rawDigestUserFrontmatterProjectionBytes,
  type RawDigestRegistryEntry
} from "../../knowledge-base/raw-digest";
import {
  MaintenanceShadowError,
  loadMaintenanceShadowChangeSet,
  markMaintenanceShadowCommittedFromJournal,
  type MaintenanceShadowChange,
  type MaintenanceShadowHandle,
  type MaintenanceShadowMetadataSuccessorPolicy,
  type MaintenanceShadowMetadataSuccessorProof
} from "./shadow-vault";
import {
  maintenanceMarkdownUpdatedMayBeInserted,
  maintenanceMarkdownUpdatedSuccessorEvidence,
  type MaintenanceMarkdownUpdatedSuccessorWindow
} from "./markdown-metadata-successor";
import {
  withRecordMutationGlobalAuthority
} from "../lifecycle/record-mutation-coordinator";

const WAL_VERSION = 1;
const STATE_VERSION = 1;
const MANAGED_JOURNAL_VERSION = 1;
const NOOP_RECEIPT_SCHEMA_VERSION = 1;
const WAL_DIRECTORY = "workflow-wal";
const BLOB_DIRECTORY = "blobs";
const INTENT_FILE = "intent.json";
const STATE_FILE = "state.json";
const MANAGED_APPLY_DIRECTORY = "managed-apply";
const MANAGED_JOURNAL_FILE = "journal.json";
const STAGING_DIRECTORY = ".staging";
const LOCK_DIRECTORY = ".locks";
const MAX_CONTROL_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 256 * 1024 * 1024;
const FILE_CAS_SNAPSHOT_MAX_ATTEMPTS = 3;
const FILE_CAS_SNAPSHOT_RETRY_DELAY_MS = 5;
const MANAGED_METADATA_SUCCESSOR_WINDOW_MS = 5 * 60_000;
const RUN_TOKEN_PATTERN = /^run-[a-f0-9]{24}$/;
export const MAINTENANCE_WORKFLOW_WAL_VERSION = WAL_VERSION;
export const MAINTENANCE_WORKFLOW_NOOP_RECEIPT_SCHEMA_VERSION =
  NOOP_RECEIPT_SCHEMA_VERSION;

export type MaintenanceWorkflowWalPhase =
  | "prepared"
  | "shadow_committed"
  | "managed_committed"
  | "settings_committed"
  | "finalized";

export type MaintenanceWorkflowWalErrorCode =
  | "invalid_path"
  | "unsafe_entry"
  | "intent_corrupt"
  | "state_corrupt"
  | "blob_corrupt"
  | "wal_exists"
  | "wal_blocked"
  | "phase_conflict"
  | "managed_journal_corrupt"
  | "managed_cas_conflict"
  | "settings_cas_conflict"
  | "settings_persist_failed";

export class MaintenanceWorkflowWalError extends Error {
  constructor(
    public readonly code: MaintenanceWorkflowWalErrorCode,
    message: string,
    public readonly relativePath?: string
  ) {
    super(message);
    this.name = "MaintenanceWorkflowWalError";
  }
}

/**
 * Test-only abrupt-stop sentinel. Production callers should never pass a fault
 * injector, but the sentinel lets tests leave the durable journal exactly as a
 * killed process would have left it.
 */
export class MaintenanceWorkflowSimulatedCrash extends Error {
  constructor(message = "simulated workflow crash") {
    super(message);
    this.name = "MaintenanceWorkflowSimulatedCrash";
  }
}

export interface MaintenanceWorkflowCasMissing {
  kind: "missing";
}

export interface MaintenanceWorkflowCasFile {
  kind: "file";
  sha256: string;
  size: number;
  mode: number;
}

export type MaintenanceWorkflowFileCas =
  | MaintenanceWorkflowCasMissing
  | MaintenanceWorkflowCasFile;

export interface MaintenanceWorkflowSourceRecord {
  relativePath: string;
  size: number;
  mtime: number;
  fingerprint: string;
}

export interface MaintenanceWorkflowPendingSourceRecord {
  source: MaintenanceWorkflowSourceRecord;
  reason: {
    code: string;
    message: string;
    relatedSources?: string[];
    targetPaths?: string[];
  };
}

export interface MaintenanceWorkflowIndexCommitRecord {
  relativePath: string;
  result: MaintenanceWorkflowCasFile;
  sourcePaths: string[];
}

export interface MaintenanceWorkflowIndexDeferredRecord {
  relativePath: string;
  sourcePaths: string[];
  reason: string;
}

export interface MaintenanceWorkflowIndexReconciliation {
  committed: MaintenanceWorkflowIndexCommitRecord[];
  deferred: MaintenanceWorkflowIndexDeferredRecord[];
  warnings: KnowledgeBaseRunWarning[];
}

export interface MaintenanceWorkflowShadowCommitDraft {
  controlRootPath: string;
  changeSetDigest: string;
  selectionDigest: string;
  liveVaultFingerprint: string;
  allowPaths: string[];
  expectedAppliedPaths: string[];
  skippedPaths: string[];
}

export interface MaintenanceWorkflowShadowCommitProof {
  applyJournalDigest: string;
  commitReceipt: string;
  liveTargets: Array<{
    relativePath: string;
    /** Sealed Shadow result; managed write baselines bind to this CAS. */
    result: MaintenanceWorkflowFileCas;
    /** CAS actually observed after the metadata plugin settled. */
    observedResult?: MaintenanceWorkflowFileCas;
    metadataSuccessor?: MaintenanceShadowMetadataSuccessorProof;
  }>;
}

export interface MaintenanceWorkflowNoopProof {
  liveVaultFingerprint: string;
  discoveryDigest: string;
  sourceSnapshotDigest: string;
  sourceSnapshot: MaintenanceWorkflowSourceRecord[];
  sourceCount: number;
  changedSourceCount: 0;
}

export type MaintenanceWorkflowManagedWriteKind =
  | "index"
  | "raw-metadata"
  | "raw-registry"
  | "report"
  | "tracker";

export interface MaintenanceWorkflowManagedUpsertDraft {
  kind: MaintenanceWorkflowManagedWriteKind;
  operation: "upsert";
  relativePath: string;
  expected: MaintenanceWorkflowFileCas;
  /**
   * Required for raw-metadata writes so prepare can prove the Raw body is
   * byte-identical and only frontmatter changed.
   */
  expectedContent?: Buffer;
  desiredContent: Buffer;
  desiredMode: number;
}

export interface MaintenanceWorkflowManagedDeleteDraft {
  kind: MaintenanceWorkflowManagedWriteKind;
  operation: "delete";
  relativePath: string;
  expected: MaintenanceWorkflowFileCas;
}

export type MaintenanceWorkflowManagedWriteDraft =
  | MaintenanceWorkflowManagedUpsertDraft
  | MaintenanceWorkflowManagedDeleteDraft;

export interface MaintenanceWorkflowManagedWrite {
  kind: MaintenanceWorkflowManagedWriteKind;
  operation: "upsert" | "delete";
  relativePath: string;
  expected: MaintenanceWorkflowFileCas;
  desired: MaintenanceWorkflowFileCas;
  blobDigest?: string;
  expectedBlobDigest?: string;
  rawBodyDigest?: string;
  rawUnmanagedFrontmatterDigest?: string;
  rawMetadataProof?: {
    processed: true;
    status: typeof RAW_DIGEST_STATUS_DIGESTED;
    fingerprint: string;
    digestedAt: number;
    reportPath: string;
    evidencePaths: string[];
  };
  rawRegistryProof?: {
    schemaVersion: typeof RAW_DIGEST_SCHEMA_VERSION;
    updatedAt: string;
    entriesDigest: string;
    entries: Record<string, RawDigestRegistryEntry>;
    /** New WALs require byte-canonical registry JSON; absent only on V1 legacy WALs. */
    canonicalBytes?: true;
  };
}

export interface MaintenanceWorkflowTerminalSettings {
  lastRunAt: number;
  lastRunStatus: KnowledgeBaseRunStatus;
  lastReportPath: string;
  lastError: string;
  lastSummary: string;
  lastCompletion: KnowledgeBaseRunCompletion | "";
  lastAttempts: KnowledgeRunAttemptRecord[];
  lastPendingSources: string[];
  lastFailureCode: string;
  lastWarnings: KnowledgeBaseRunWarning[];
}

export interface MaintenanceWorkflowScheduledSettings {
  lastScheduledRunAt: number;
  lastScheduledRunStatus: KnowledgeBaseRunStatus;
  lastScheduledRunId: string;
}

export interface MaintenanceWorkflowScheduledProjection {
  baseline: MaintenanceWorkflowScheduledSettings;
  target: MaintenanceWorkflowScheduledSettings;
}

export interface MaintenanceWorkflowSettingsPlanDraft {
  baselineProcessedSources: Record<string, KnowledgeBaseProcessedSource>;
  targetProcessedSources: Record<string, KnowledgeBaseProcessedSource>;
  removedProcessedSourcePaths: string[];
  baselineTerminal: MaintenanceWorkflowTerminalSettings;
  targetTerminal: MaintenanceWorkflowTerminalSettings;
  historyEntry: KnowledgeBaseMaintenanceHistoryEntry;
  /**
   * Scheduled runs atomically project their scheduler terminal in the same
   * settings transaction as the ordinary maintenance terminal. Manual runs
   * must use null so replay never reads or mutates scheduler-owned fields.
   */
  scheduled: MaintenanceWorkflowScheduledProjection | null;
}

export interface MaintenanceWorkflowSettingsPlan extends MaintenanceWorkflowSettingsPlanDraft {
  baselineProcessedSourcesDigest: string;
  targetProcessedSourcesDigest: string;
  baselineTerminalDigest: string;
  targetTerminalDigest: string;
}

export interface MaintenanceWorkflowWalIntentDraft {
  workflowRunId: string;
  mode: "maintain" | "reingest" | "lint" | "outputs" | "inbox";
  startedAt: number;
  createdAt: string;
  selectedBackend: AgentBackendKind;
  candidateBackends: AgentBackendKind[];
  winner: {
    attemptId: string;
    ordinal: number;
    backend: AgentBackendKind;
  } | null;
  completion: KnowledgeBaseRunCompletion;
  attempts: KnowledgeRunAttemptRecord[];
  verifiedSources: MaintenanceWorkflowSourceRecord[];
  pendingSources: MaintenanceWorkflowPendingSourceRecord[];
  evidencePaths: Record<string, string[]>;
  warnings: KnowledgeBaseRunWarning[];
  summary: string;
  shadow: MaintenanceWorkflowShadowCommitDraft | null;
  noopProof?: MaintenanceWorkflowNoopProof;
  /**
   * New no-op intents use a run-scoped audit report and no tracker/index/Raw
   * managed writes. Missing means a pre-cutover WAL loaded only for recovery;
   * fresh prepares are never allowed to omit this contract.
   */
  noopReceipt?: MaintenanceWorkflowNoopReceiptContract;
  report: {
    relativePath: string;
    finalBlockDigest: string;
  };
  indexReconciliation: MaintenanceWorkflowIndexReconciliation;
  settings: MaintenanceWorkflowSettingsPlanDraft;
}

export interface MaintenanceWorkflowNoopReceiptContract {
  schemaVersion: typeof NOOP_RECEIPT_SCHEMA_VERSION;
  kind: "run-scoped-report";
  pathStrategy: "workflow-run-id-sha256-v1";
  dateKey: string;
}

export interface MaintenanceWorkflowReportIntent {
  relativePath: string;
  finalBlockDigest: string;
  expectedPostShadow: MaintenanceWorkflowFileCas;
  desired: MaintenanceWorkflowFileCas;
}

export interface MaintenanceWorkflowWalIntent
  extends Omit<MaintenanceWorkflowWalIntentDraft, "report" | "settings" | "shadow"> {
  version: typeof WAL_VERSION;
  /**
   * Immutable precommit plan. The durable postcommit journal proof belongs to
   * WAL state and is written only after the live Shadow apply succeeds.
   */
  shadow: MaintenanceWorkflowShadowCommitDraft | null;
  report: MaintenanceWorkflowReportIntent;
  managedWrites: MaintenanceWorkflowManagedWrite[];
  settings: MaintenanceWorkflowSettingsPlan;
  digest: string;
}

export interface MaintenanceWorkflowWalBlockedState {
  code: string;
  message: string;
  blockedAt: string;
}

export interface MaintenanceWorkflowManagedMetadataSuccessorLease {
  version: 1;
  relativePath: string;
  intentDigest: string;
  entryDigest: string;
  createdAt: string;
  window: MaintenanceMarkdownUpdatedSuccessorWindow;
  provenanceDigest: string;
  digest: string;
}

export interface MaintenanceWorkflowWalState {
  version: typeof STATE_VERSION;
  workflowRunId: string;
  intentDigest: string;
  phase: MaintenanceWorkflowWalPhase;
  sequence: number;
  updatedAt: string;
  shadowCommitProof?: MaintenanceWorkflowShadowCommitProof;
  noopConfirmationDigest?: string;
  settingsGeneration?: string;
  settingsTargetProjectionDigest?: string;
  /** Cross-file authority for recovery-only per-entry successor windows. */
  managedMetadataSuccessorLeases?: MaintenanceWorkflowManagedMetadataSuccessorLease[];
  blocked?: MaintenanceWorkflowWalBlockedState;
  digest: string;
}

export interface MaintenanceWorkflowWalLocation {
  storageRootPath: string;
  walRootPath: string;
  runRootPath: string;
  runToken: string;
  intentPath: string;
  statePath: string;
  blobRootPath: string;
  managedJournalPath: string;
}

export interface MaintenanceWorkflowWalHandle extends MaintenanceWorkflowWalLocation {
  workflowRunId: string;
}

export interface LoadedMaintenanceWorkflowWal {
  handle: MaintenanceWorkflowWalHandle;
  intent: MaintenanceWorkflowWalIntent;
  state: MaintenanceWorkflowWalState;
}

export type MaintenanceWorkflowWalListEntry =
  | {
      status: "ready" | "blocked";
      wal: LoadedMaintenanceWorkflowWal;
    }
  | {
      status: "invalid";
      location: MaintenanceWorkflowWalLocation;
      error: string;
    };

export interface PrepareMaintenanceWorkflowWalInput {
  storageRootPath: string;
  draft: MaintenanceWorkflowWalIntentDraft;
  managedWrites: MaintenanceWorkflowManagedWriteDraft[];
  faultInjector?: (
    point:
      | "after-staging-create"
      | "after-blobs"
      | "after-intent"
      | "after-state"
      | "after-publish"
  ) => void | Promise<void>;
}

export interface MaintenanceWorkflowSettingsSnapshot
  extends MaintenanceWorkflowTerminalSettings {
  processedSources: Record<string, KnowledgeBaseProcessedSource>;
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
  lastScheduledRunAt: number;
  lastScheduledRunStatus: KnowledgeBaseRunStatus;
  lastScheduledRunId: string;
  nativeLifecycleRecoveryReceipt?: KnowledgeBaseNativeLifecycleRecoveryReceipt | null;
}

export interface MaintenanceWorkflowSettingsMergeResult<
  T extends MaintenanceWorkflowSettingsSnapshot
> {
  settings: T;
  changed: boolean;
}

export interface MaintenanceWorkflowSettingsReadback<
  T extends MaintenanceWorkflowSettingsSnapshot
> {
  settings: T;
  /**
   * Opaque generation for the persisted knowledge-base settings transaction.
   * The Host must change it whenever this settings section changes.
   */
  generation: string;
}

export interface MaintenanceWorkflowSettingsTransaction<
  T extends MaintenanceWorkflowSettingsSnapshot
> {
  readWithGeneration():
    | MaintenanceWorkflowSettingsReadback<T>
    | Promise<MaintenanceWorkflowSettingsReadback<T>>;
  persistCas(
    expectedGeneration: string,
    settings: T
  ):
    | MaintenanceWorkflowSettingsReadback<T>
    | Promise<MaintenanceWorkflowSettingsReadback<T>>;
}

export interface MaintenanceWorkflowSettingsHost<
  T extends MaintenanceWorkflowSettingsSnapshot
> {
  withExclusiveTransaction<R>(
    action: (transaction: MaintenanceWorkflowSettingsTransaction<T>) => Promise<R>
  ): Promise<R>;
}

type ManagedJournalState = "prepared" | "applying" | "committed" | "blocked";

interface MaintenanceWorkflowManagedJournalEntry {
  write: MaintenanceWorkflowManagedWrite;
  installTempRelativePath?: string;
  displacedLiveRelativePath?: string;
}

interface MaintenanceWorkflowManagedApplyJournal {
  version: typeof MANAGED_JOURNAL_VERSION;
  workflowRunId: string;
  intentDigest: string;
  state: ManagedJournalState;
  entries: MaintenanceWorkflowManagedJournalEntry[];
  metadataSuccessorPolicy?: {
    version: 1;
    kind: "managed-markdown-updated-only";
    window: MaintenanceMarkdownUpdatedSuccessorWindow;
  };
  metadataSuccessorInstallWindows?: Array<{
    relativePath: string;
    createdAt: string;
    window: MaintenanceMarkdownUpdatedSuccessorWindow;
    leaseDigest: string;
  }>;
  acceptedMetadataBaselines?: MaintenanceShadowMetadataSuccessorProof[];
  metadataSuccessors?: MaintenanceShadowMetadataSuccessorProof[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  digest: string;
}

export type MaintenanceWorkflowManagedFaultPoint =
  | "before-entry"
  | "after-displace"
  | "after-install"
  | "before-install-temp-unlink"
  | "after-journal-commit"
  | "after-cleanup-link";

export interface ApplyMaintenanceWorkflowManagedWritesOptions {
  resumeBlocked?: {
    stateSequence: number;
    stateDigest: string;
  };
  faultInjector?: (input: {
    point: MaintenanceWorkflowManagedFaultPoint;
    index: number;
    relativePath: string;
  }) => void | Promise<void>;
}

export interface MaintenanceWorkflowBlockedResumeToken {
  stateSequence: number;
  stateDigest: string;
}

export interface MaintenanceWorkflowFinalizeCleanupEvidence {
  /**
   * Shadow metadata successors that the committed managed journal consumed as
   * exact baselines before replacing overlapping Shadow targets.
   */
  acceptedShadowMetadataSuccessors: MaintenanceShadowMetadataSuccessorProof[];
  /** Digest of the committed managed journal that produced this evidence. */
  managedJournalDigest?: string;
  /** Allowed post-managed metadata successors already re-proved against live. */
  managedResultSuccessors: MaintenanceShadowMetadataSuccessorProof[];
}

const PHASES: MaintenanceWorkflowWalPhase[] = [
  "prepared",
  "shadow_committed",
  "managed_committed",
  "settings_committed",
  "finalized"
];

export function maintenanceWorkflowWalRoot(storageRootPath: string): string {
  return path.join(path.resolve(storageRootPath), WAL_DIRECTORY);
}

export function maintenanceWorkflowNoopReceiptPath(input: {
  mode: MaintenanceWorkflowWalIntentDraft["mode"];
  workflowRunId: string;
  receipt: MaintenanceWorkflowNoopReceiptContract;
}): string {
  const prefix = input.mode === "lint" ? "kb-check" : "kb-maintenance";
  const runIdDigest = createHash("sha256")
    .update(input.workflowRunId)
    .digest("hex");
  return `outputs/maintenance/${prefix}-noop-${input.receipt.dateKey}-${runIdDigest}.md`;
}

export async function prepareMaintenanceWorkflowWal(
  input: PrepareMaintenanceWorkflowWalInput
): Promise<LoadedMaintenanceWorkflowWal> {
  const storageRootPath = await ensurePlainDirectory(
    input.storageRootPath,
    "maintenance storage root"
  );
  return await withRecordMutationGlobalAuthority(
    storageRootPath,
    workflowWalAuthorityId(input.draft.workflowRunId),
    async () => await prepareMaintenanceWorkflowWalUnderAuthority({
      ...input,
      storageRootPath
    })
  );
}

async function prepareMaintenanceWorkflowWalUnderAuthority(
  input: PrepareMaintenanceWorkflowWalInput
): Promise<LoadedMaintenanceWorkflowWal> {
  const storageRootPath = await ensurePlainDirectory(input.storageRootPath, "maintenance storage root");
  const walRootPath = maintenanceWorkflowWalRoot(storageRootPath);
  await ensurePlainDirectory(walRootPath, "workflow WAL root", true);
  await syncDirectory(storageRootPath);

  const managedWrites = input.managedWrites.map(buildManagedWrite);
  const reportWrite = managedWrites.find(
    (write) => write.kind === "report" && write.relativePath === input.draft.report.relativePath
  );
  if (!reportWrite) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      `报告写入计划不存在：${input.draft.report.relativePath}`,
      input.draft.report.relativePath
    );
  }
  const settings = buildSettingsPlan(input.draft.settings);
  let shadow = cloneJson(input.draft.shadow);
  if (input.draft.shadow) {
    const controlRootPath = await ensurePlainDescendantDirectory(
      input.storageRootPath,
      input.draft.shadow.controlRootPath,
      "Shadow control root"
    );
    shadow = {
      ...shadow!,
      controlRootPath
    };
  }
  const intent = withIntentDigest({
    version: WAL_VERSION,
    ...cloneJson(input.draft),
    shadow,
    report: {
      ...cloneJson(input.draft.report),
      expectedPostShadow: cloneCas(reportWrite.expected),
      desired: cloneCas(reportWrite.desired)
    },
    managedWrites,
    settings
  });
  assertValidMaintenanceWorkflowWalIntent(intent);

  const location = walLocation(storageRootPath, runTokenForWorkflow(input.draft.workflowRunId));
  await assertIntentBoundToLocation(location, intent);
  if (await lstatOrNull(location.runRootPath)) {
    const existing = await loadMaintenanceWorkflowWal(location);
    if (existing.intent.digest !== intent.digest) {
      throw new MaintenanceWorkflowWalError(
        "wal_exists",
        `workflow WAL 已存在且 intent 不一致：${input.draft.workflowRunId}`
      );
    }
    return existing;
  }

  const stagingRootPath = path.join(walRootPath, STAGING_DIRECTORY);
  await ensurePlainDirectory(stagingRootPath, "workflow WAL staging root", true);
  await syncDirectory(walRootPath);
  const stagedRunRootPath = path.join(
    stagingRootPath,
    `${location.runToken}-${randomUUID()}`
  );
  await fsp.mkdir(stagedRunRootPath, { mode: 0o700 });
  await syncDirectory(stagingRootPath);
  const stagedLocation = walLocationAtRunRoot(
    storageRootPath,
    location.runToken,
    stagedRunRootPath
  );
  await ensurePlainDirectory(stagedLocation.blobRootPath, "workflow blob root", true);
  await ensurePlainDirectory(
    path.dirname(stagedLocation.managedJournalPath),
    "managed apply root",
    true
  );
  await syncDirectory(stagedRunRootPath);
  await input.faultInjector?.("after-staging-create");

  const contentByDigest = new Map<string, Buffer>();
  for (const write of input.managedWrites) {
    if (write.operation !== "upsert") continue;
    for (const content of [
      durableManagedWriteDesiredContent(write),
      ...(write.kind === "raw-metadata" && write.expectedContent
        ? [write.expectedContent]
        : [])
    ]) {
      const digest = sha256(content);
      const existing = contentByDigest.get(digest);
      if (existing && !existing.equals(content)) {
        throw new MaintenanceWorkflowWalError("blob_corrupt", `blob digest 碰撞：${digest}`);
      }
      contentByDigest.set(digest, Buffer.from(content));
    }
  }
  try {
    for (const [digest, content] of contentByDigest) {
      await writeContentAddressedBlob(stagedLocation.blobRootPath, digest, content);
    }
    await input.faultInjector?.("after-blobs");

    await writeJsonDurably(stagedLocation.intentPath, intent);
    await input.faultInjector?.("after-intent");
    const state = withStateDigest({
      version: STATE_VERSION,
      workflowRunId: intent.workflowRunId,
      intentDigest: intent.digest,
      phase: "prepared",
      sequence: 0,
      updatedAt: new Date().toISOString()
    });
    await writeJsonDurably(stagedLocation.statePath, state);
    await input.faultInjector?.("after-state");
    await syncDirectory(stagedRunRootPath);
    try {
      await fsp.rename(stagedRunRootPath, location.runRootPath);
      await syncDirectory(walRootPath);
      await input.faultInjector?.("after-publish");
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await loadMaintenanceWorkflowWal(location);
      if (existing.intent.digest !== intent.digest) {
        throw new MaintenanceWorkflowWalError(
          "wal_exists",
          `workflow WAL 已并发创建且 intent 不一致：${input.draft.workflowRunId}`
        );
      }
      await makeTreeOwnerWritable(stagedRunRootPath);
      await fsp.rm(stagedRunRootPath, { recursive: true, force: true });
      await syncDirectory(stagingRootPath);
      return existing;
    }
    return await loadMaintenanceWorkflowWal(location);
  } catch (error) {
    if (error instanceof MaintenanceWorkflowSimulatedCrash) throw error;
    await makeTreeOwnerWritable(stagedRunRootPath).catch(() => undefined);
    await fsp.rm(stagedRunRootPath, { recursive: true, force: true }).catch(() => undefined);
    await syncDirectory(stagingRootPath).catch(() => undefined);
    throw error;
  }
}

export async function loadMaintenanceWorkflowWal(
  locationOrHandle: MaintenanceWorkflowWalLocation | MaintenanceWorkflowWalHandle
): Promise<LoadedMaintenanceWorkflowWal> {
  const location = normalizeWalLocation(locationOrHandle);
  await assertPlainExistingDirectory(location.storageRootPath, "maintenance storage root");
  await assertPlainExistingDirectory(location.walRootPath, "workflow WAL root");
  await assertPlainExistingDirectory(location.runRootPath, "workflow WAL run root");
  let intent: MaintenanceWorkflowWalIntent;
  try {
    intent = JSON.parse(
      (await readIndependentRegularFile(
        location.intentPath,
        "workflow intent",
        MAX_CONTROL_FILE_BYTES
      )).toString("utf8")
    ) as MaintenanceWorkflowWalIntent;
  } catch (error) {
    if (error instanceof MaintenanceWorkflowWalError) throw error;
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      `workflow intent 无法解析：${errorMessage(error)}`
    );
  }
  assertValidMaintenanceWorkflowWalIntent(intent, {
    allowLegacyNoopReceipt: true,
    allowLegacyRegistryOrdering: true
  });
  if (runTokenForWorkflow(intent.workflowRunId) !== location.runToken) {
    throw new MaintenanceWorkflowWalError("intent_corrupt", "workflow WAL run token 与 intent 不匹配");
  }
  await assertIntentBoundToLocation(location, intent);
  await validateIntentBlobs(location, intent);

  const state = await readStateOrNull(location.statePath);
  if (!state) {
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      "已发布 workflow WAL 缺少 state；禁止猜测并回退到 prepared"
    );
  }
  assertValidState(state, intent);
  return {
    handle: { ...location, workflowRunId: intent.workflowRunId },
    intent,
    state
  };
}

export async function listMaintenanceWorkflowWals(
  storageRootPathInput: string
): Promise<MaintenanceWorkflowWalListEntry[]> {
  const storageRootPath = await ensurePlainDirectory(storageRootPathInput, "maintenance storage root");
  const walRootPath = maintenanceWorkflowWalRoot(storageRootPath);
  const rootStat = await fsp.lstat(walRootPath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new MaintenanceWorkflowWalError("unsafe_entry", "workflow WAL root 不是安全目录");
  }

  const entries = await fsp.readdir(walRootPath, { withFileTypes: true });
  const result: MaintenanceWorkflowWalListEntry[] = [];
  for (const entry of entries.sort((left, right) =>
    compareCanonicalText(left.name, right.name))) {
    if (entry.name === STAGING_DIRECTORY || entry.name === LOCK_DIRECTORY) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        const location = walLocation(storageRootPath, runTokenForWorkflow(entry.name));
        result.push({
          status: "invalid",
          location,
          error: `workflow WAL 内部目录不安全：${entry.name}`
        });
      }
      continue;
    }
    const location = walLocation(storageRootPath, entry.name);
    if (
      !RUN_TOKEN_PATTERN.test(entry.name)
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      result.push({
        status: "invalid",
        location,
        error: `workflow WAL 含不安全目录项：${entry.name}`
      });
      continue;
    }
    try {
      const wal = await loadMaintenanceWorkflowWal(location);
      result.push({ status: wal.state.blocked ? "blocked" : "ready", wal });
    } catch (error) {
      result.push({
        status: "invalid",
        location,
        error: errorMessage(error)
      });
    }
  }
  return result.sort((left, right) => {
    const leftCreated = left.status === "invalid" ? "" : left.wal.intent.createdAt;
    const rightCreated = right.status === "invalid" ? "" : right.wal.intent.createdAt;
    if (!leftCreated && rightCreated) return 1;
    if (leftCreated && !rightCreated) return -1;
    return compareCanonicalText(leftCreated, rightCreated);
  });
}

export async function markMaintenanceWorkflowWalBlocked(
  handle: MaintenanceWorkflowWalHandle,
  input: { code: string; message: string }
): Promise<MaintenanceWorkflowWalState> {
  const blocked: MaintenanceWorkflowWalBlockedState = {
    code: requireNonEmptyText(input.code, "blocked code", 160),
    message: requireNonEmptyText(input.message, "blocked message", 4000),
    blockedAt: new Date().toISOString()
  };
  return await withWalStateLock(handle, async () => {
    let loaded = await loadMaintenanceWorkflowWal(handle);
    if (
      loaded.state.blocked?.code === blocked.code
      && loaded.state.blocked.message === blocked.message
    ) {
      return loaded.state;
    }
    return await writeNextWalState(loaded, {
      ...withoutStateDigest(loaded.state),
      sequence: loaded.state.sequence + 1,
      updatedAt: new Date().toISOString(),
      blocked
    });
  });
}

async function clearMaintenanceWorkflowWalBlockedInternal(
  handle: MaintenanceWorkflowWalHandle,
  expected: { stateSequence: number; stateDigest: string }
): Promise<MaintenanceWorkflowWalState> {
  return await withWalStateLock(handle, async () => {
    const loaded = await loadMaintenanceWorkflowWal(handle);
    if (!loaded.state.blocked) return loaded.state;
    if (
      loaded.state.sequence !== expected.stateSequence
      || loaded.state.digest !== expected.stateDigest
    ) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        "解除 workflow blocker 时 state 已变化"
      );
    }
    const { blocked: _blocked, ...state } = withoutStateDigest(loaded.state);
    return await writeNextWalState(loaded, {
      ...state,
      sequence: loaded.state.sequence + 1,
      updatedAt: new Date().toISOString()
    });
  });
}

export async function removeFinalizedMaintenanceWorkflowWal(
  handle: MaintenanceWorkflowWalHandle
): Promise<void> {
  await withWalStateLock(handle, async () => {
    const loaded = await loadMaintenanceWorkflowWal(handle);
    if (loaded.state.phase !== "finalized" || loaded.state.blocked) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `只有 finalized 且未阻断的 workflow WAL 才能清理：${loaded.state.phase}`
      );
    }
    await makeTreeOwnerWritable(handle.runRootPath);
    await fsp.rm(handle.runRootPath, { recursive: true, force: true });
    await syncDirectory(handle.walRootPath);
  });
}

function buildManagedWrite(
  draft: MaintenanceWorkflowManagedWriteDraft
): MaintenanceWorkflowManagedWrite {
  const relativePath = normalizeRelativePath(draft.relativePath);
  const expected = cloneCas(draft.expected);
  if (draft.operation === "delete") {
    return {
      kind: draft.kind,
      operation: "delete",
      relativePath,
      expected,
      desired: { kind: "missing" }
    };
  }
  const desiredContent = durableManagedWriteDesiredContent(draft);
  if (desiredContent.byteLength > MAX_BLOB_BYTES) {
    throw new MaintenanceWorkflowWalError(
      "blob_corrupt",
      `managed blob 过大：${relativePath}`,
      relativePath
    );
  }
  const digest = sha256(desiredContent);
  let rawBodyDigest: string | undefined;
  let rawUnmanagedFrontmatterDigest: string | undefined;
  let expectedBlobDigest: string | undefined;
  let rawMetadataProof: MaintenanceWorkflowManagedWrite["rawMetadataProof"];
  let rawRegistryProof: MaintenanceWorkflowManagedWrite["rawRegistryProof"];
  if (draft.kind === "raw-metadata") {
    if (expected.kind !== "file" || !draft.expectedContent) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw metadata 写入缺少 expectedContent：${relativePath}`,
        relativePath
      );
    }
    if (
      sha256(draft.expectedContent) !== expected.sha256
      || draft.expectedContent.byteLength !== expected.size
      || normalizeMode(draft.desiredMode) !== expected.mode
    ) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw metadata baseline 与 expected CAS 不匹配：${relativePath}`,
        relativePath
      );
    }
    expectedBlobDigest = sha256(draft.expectedContent);
    const baselineBody = markdownBodyBytes(draft.expectedContent, relativePath);
    const desiredBody = markdownBodyBytes(desiredContent, relativePath);
    if (!baselineBody.equals(desiredBody)) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw metadata 写入改变了 Raw 正文：${relativePath}`,
        relativePath
      );
    }
    rawBodyDigest = sha256(desiredBody);
    let userFrontmatterPreserved = false;
    try {
      userFrontmatterPreserved =
        rawDigestPreservesUserFrontmatterBytes(
          draft.expectedContent,
          desiredContent
        );
    } catch {
      userFrontmatterPreserved = false;
    }
    if (!userFrontmatterPreserved) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw metadata 写入改变了用户 frontmatter：${relativePath}`,
        relativePath
      );
    }
    rawUnmanagedFrontmatterDigest = sha256(
      rawDigestUserFrontmatterProjectionBytes(desiredContent)
    );
    const record = rawDigestRecordFromMarkdown(desiredContent);
    if (
      !record
      || !rawDigestRecordIsTrusted(record, record.fingerprint)
      || record.status !== RAW_DIGEST_STATUS_DIGESTED
      || !Number.isFinite(record.digestedAt)
      || record.digestedAt < 0
    ) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw metadata 写入缺少可信提炼记录：${relativePath}`,
        relativePath
      );
    }
    const reportPath = normalizeRelativePath(record.reportPath);
    const evidencePaths = record.evidencePaths.map(normalizeRelativePath);
    if (
      new Set(evidencePaths).size !== evidencePaths.length
      || evidencePaths.length === 0
    ) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw metadata 写入证据路径非法：${relativePath}`,
        relativePath
      );
    }
    rawMetadataProof = {
      processed: true,
      status: RAW_DIGEST_STATUS_DIGESTED,
      fingerprint: record.fingerprint,
      digestedAt: record.digestedAt,
      reportPath,
      evidencePaths
    };
  } else if (draft.kind === "raw-registry") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(desiredContent.toString("utf8"));
    } catch (error) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw registry 不是合法 JSON：${errorMessage(error)}`,
        relativePath
      );
    }
    const registry = normalizeRawDigestRegistry(parsed);
    if (
      registry.schemaVersion !== RAW_DIGEST_SCHEMA_VERSION
      || !isIsoDate(registry.updatedAt)
      || !buildCanonicalRawDigestRegistryContent(registry).equals(desiredContent)
    ) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `Raw registry 不是规范 durable projection：${relativePath}`,
        relativePath
      );
    }
    const entries = cloneJson(registry.entries);
    rawRegistryProof = {
      schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
      updatedAt: registry.updatedAt,
      entriesDigest: digestJson(entries),
      entries,
      canonicalBytes: true
    };
  }
  return {
    kind: draft.kind,
    operation: "upsert",
    relativePath,
    expected,
    desired: {
      kind: "file",
      sha256: digest,
      size: desiredContent.byteLength,
      mode: normalizeMode(draft.desiredMode)
    },
    blobDigest: digest,
    ...(expectedBlobDigest ? { expectedBlobDigest } : {}),
    ...(rawBodyDigest ? { rawBodyDigest } : {}),
    ...(rawUnmanagedFrontmatterDigest
      ? { rawUnmanagedFrontmatterDigest }
      : {}),
    ...(rawMetadataProof ? { rawMetadataProof } : {}),
    ...(rawRegistryProof ? { rawRegistryProof } : {})
  };
}

function durableManagedWriteDesiredContent(
  draft: MaintenanceWorkflowManagedWriteDraft
): Buffer {
  if (draft.operation !== "upsert" || draft.kind !== "raw-registry") {
    return Buffer.from(draft.operation === "upsert"
      ? draft.desiredContent
      : Buffer.alloc(0));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft.desiredContent.toString("utf8"));
  } catch (error) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      `Raw registry 不是合法 JSON：${errorMessage(error)}`,
      normalizeRelativePath(draft.relativePath)
    );
  }
  const registry = normalizeRawDigestRegistry(parsed);
  const canonical = buildCanonicalRawDigestRegistryContent(registry);
  const plannerProjection = buildRawDigestRegistryContent(registry);
  if (
    registry.schemaVersion !== RAW_DIGEST_SCHEMA_VERSION
    || !isIsoDate(registry.updatedAt)
    || (
      !draft.desiredContent.equals(plannerProjection)
      && !draft.desiredContent.equals(canonical)
    )
  ) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      `Raw registry 不是规范 durable projection：${normalizeRelativePath(draft.relativePath)}`,
      normalizeRelativePath(draft.relativePath)
    );
  }
  return canonical;
}

function buildCanonicalRawDigestRegistryContent(
  registry: ReturnType<typeof normalizeRawDigestRegistry>
): Buffer {
  const entries = Object.fromEntries(
    Object.entries(registry.entries).sort(([left], [right]) =>
      compareCanonicalText(left, right)
    )
  );
  return Buffer.from(`${JSON.stringify({
    schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
    updatedAt: registry.updatedAt,
    entries
  }, null, 2)}\n`, "utf8");
}

function buildSettingsPlan(
  draft: MaintenanceWorkflowSettingsPlanDraft
): MaintenanceWorkflowSettingsPlan {
  const cloned = cloneJson(draft);
  return {
    ...cloned,
    baselineProcessedSourcesDigest: digestJson(cloned.baselineProcessedSources),
    targetProcessedSourcesDigest: digestJson(cloned.targetProcessedSources),
    baselineTerminalDigest: digestJson(cloned.baselineTerminal),
    targetTerminalDigest: digestJson(cloned.targetTerminal)
  };
}

function markdownBodyBytes(content: Buffer, relativePath: string): Buffer {
  const firstLineEnd = content.indexOf(0x0a);
  const firstLine = content.subarray(
    0,
    firstLineEnd < 0 ? content.length : firstLineEnd
  );
  const normalizedFirstLine =
    firstLine.length && firstLine[firstLine.length - 1] === 0x0d
      ? firstLine.subarray(0, -1)
      : firstLine;
  if (normalizedFirstLine.toString("utf8") !== "---") {
    return Buffer.from(content);
  }
  let cursor = firstLineEnd < 0 ? content.length : firstLineEnd + 1;
  while (cursor <= content.length) {
    const newline = content.indexOf(0x0a, cursor);
    const lineEnd = newline < 0 ? content.length : newline;
    const line = content.subarray(cursor, lineEnd);
    const normalizedLine =
      line.length && line[line.length - 1] === 0x0d
        ? line.subarray(0, -1)
        : line;
    if (
      normalizedLine.toString("utf8") === "---"
      || normalizedLine.toString("utf8") === "..."
    ) {
      return Buffer.from(content.subarray(
        newline < 0 ? content.length : newline + 1
      ));
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  throw new MaintenanceWorkflowWalError(
    "intent_corrupt",
    `Raw Markdown frontmatter 未闭合：${relativePath}`,
    relativePath
  );
}

function walLocation(
  storageRootPathInput: string,
  runToken: string
): MaintenanceWorkflowWalLocation {
  const storageRootPath = path.resolve(storageRootPathInput);
  const walRootPath = maintenanceWorkflowWalRoot(storageRootPath);
  return walLocationAtRunRoot(
    storageRootPath,
    runToken,
    path.join(walRootPath, runToken)
  );
}

function walLocationAtRunRoot(
  storageRootPathInput: string,
  runToken: string,
  runRootPathInput: string
): MaintenanceWorkflowWalLocation {
  const storageRootPath = path.resolve(storageRootPathInput);
  const walRootPath = maintenanceWorkflowWalRoot(storageRootPath);
  const runRootPath = path.resolve(runRootPathInput);
  return {
    storageRootPath,
    walRootPath,
    runRootPath,
    runToken,
    intentPath: path.join(runRootPath, INTENT_FILE),
    statePath: path.join(runRootPath, STATE_FILE),
    blobRootPath: path.join(runRootPath, BLOB_DIRECTORY),
    managedJournalPath: path.join(runRootPath, MANAGED_APPLY_DIRECTORY, MANAGED_JOURNAL_FILE)
  };
}

function normalizeWalLocation(
  location: MaintenanceWorkflowWalLocation | MaintenanceWorkflowWalHandle
): MaintenanceWorkflowWalLocation {
  if (!RUN_TOKEN_PATTERN.test(location.runToken)) {
    throw new MaintenanceWorkflowWalError(
      "invalid_path",
      `workflow WAL run token 非法：${location.runToken}`
    );
  }
  const expected = walLocation(location.storageRootPath, location.runToken);
  for (const key of [
    "walRootPath",
    "runRootPath",
    "intentPath",
    "statePath",
    "blobRootPath",
    "managedJournalPath"
  ] as const) {
    if (path.resolve(location[key]) !== path.resolve(expected[key])) {
      throw new MaintenanceWorkflowWalError("invalid_path", `workflow WAL location 不一致：${key}`);
    }
  }
  return expected;
}

function runTokenForWorkflow(workflowRunId: string): string {
  return `run-${createHash("sha256").update(workflowRunId).digest("hex").slice(0, 24)}`;
}

interface MaintenanceShadowCommitJournalProof {
  version: 1;
  state: "committed";
  attemptId: string;
  liveVaultFingerprint: string;
  changeSetDigest: string;
  selectionDigest: string;
  selectedPaths: string[];
  entries: Array<{
    change: MaintenanceShadowChange;
    baselineBlobRelativePath?: string;
    displacedLiveRelativePath?: string;
    installTempRelativePath?: string;
  }>;
  metadataSuccessorPolicy?: MaintenanceShadowMetadataSuccessorPolicy;
  metadataSuccessors?: MaintenanceShadowMetadataSuccessorProof[];
  digest: string;
  [key: string]: unknown;
}

async function readShadowCommitJournal(
  storageRootPath: string,
  controlRootPathInput: string
): Promise<MaintenanceShadowCommitJournalProof> {
  const controlRootPath = await ensurePlainDescendantDirectory(
    storageRootPath,
    controlRootPathInput,
    "Shadow control root"
  );
  const journalRootPath = path.join(controlRootPath, "apply-journal");
  await assertPlainExistingDirectory(journalRootPath, "Shadow apply journal root");
  const journalPath = path.join(journalRootPath, "journal.json");
  try {
    return JSON.parse(
      (await readIndependentRegularFile(
        journalPath,
        "Shadow apply journal",
        MAX_CONTROL_FILE_BYTES
      )).toString("utf8")
    ) as MaintenanceShadowCommitJournalProof;
  } catch (error) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      `Shadow commit journal 无法复验：${errorMessage(error)}`
    );
  }
}

async function assertShadowCommitJournalMatches(
  journal: MaintenanceShadowCommitJournalProof,
  shadow: MaintenanceWorkflowShadowCommitDraft,
  winnerAttemptId: string
): Promise<void> {
  if (!Array.isArray(journal.selectedPaths) || !Array.isArray(journal.entries)) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow commit journal selectedPaths/entries 非法"
    );
  }
  const { digest: _digest, ...journalWithoutDigest } = journal;
  const selectedPaths = normalizedUniquePaths(journal.selectedPaths);
  const metadataSuccessors = shadowJournalMetadataSuccessors(journal);
  for (const successor of metadataSuccessors) {
    if (!selectedPaths.includes(successor.relativePath)) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `Shadow metadata successor 不属于 selected paths：${successor.relativePath}`,
        successor.relativePath
      );
    }
  }
  const shadowHandle = maintenanceShadowHandleFromCommitDraft(
    shadow,
    winnerAttemptId
  );
  let changeSet;
  try {
    changeSet = await loadMaintenanceShadowChangeSet(shadowHandle);
  } catch (error) {
    throw shadowProofWalError(
      error,
      "Shadow sealed changeset 无法复验"
    );
  }
  if (
    changeSet.digest !== shadow.changeSetDigest
    || changeSet.attemptId !== winnerAttemptId
    || changeSet.liveVaultFingerprint !== shadow.liveVaultFingerprint
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow sealed changeset 与 workflow intent 不匹配"
    );
  }
  const sealedByPath = new Map(
    changeSet.changes.map((change) => [
      normalizeRelativePath(change.relativePath),
      change
    ])
  );
  const entryPaths: string[] = [];
  for (const [index, entry] of journal.entries.entries()) {
    const change = entry?.change;
    if (
      !change
      || !["upsert", "delete"].includes(change.operation)
    ) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        "Shadow commit journal entry 非法"
      );
    }
    const relativePath = normalizeRelativePath(change.relativePath);
    entryPaths.push(relativePath);
    const sealed = sealedByPath.get(relativePath);
    if (
      relativePath !== journal.selectedPaths[index]
      || !sealed
      || stableStringify(change) !== stableStringify(sealed)
    ) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `Shadow apply journal entry 不属于 sealed changeset：${relativePath}`,
        relativePath
      );
    }
    assertValidCas(change.expectedLive, `Shadow expected CAS ${relativePath}`);
    if (change.operation === "upsert") {
      if (
        !isSha256(change.shadowSha256)
        || !Number.isSafeInteger(change.size)
        || change.size < 0
        || change.blobRelativePath
          !== `${change.shadowSha256.slice("sha256:".length)}.blob`
      ) {
        throw new MaintenanceWorkflowWalError(
          "phase_conflict",
          `Shadow upsert result 非法：${relativePath}`
        );
      }
    } else if (change.expectedLive.kind !== "file") {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `Shadow delete baseline 非法：${relativePath}`
      );
    }
  }
  if (
    journal.version !== 1
    || journal.state !== "committed"
    || journal.attemptId !== winnerAttemptId
    || journal.liveVaultFingerprint !== shadow.liveVaultFingerprint
    || journal.changeSetDigest !== shadow.changeSetDigest
    || journal.selectionDigest !== shadow.selectionDigest
    || journal.selectionDigest !== digestJson(journal.selectedPaths)
    || !sameStringArray(
      selectedPaths,
      normalizedUniquePaths(shadow.expectedAppliedPaths)
    )
    || !sameStringArray(
      normalizedUniquePaths(entryPaths),
      selectedPaths
    )
    || entryPaths.length !== selectedPaths.length
    || journal.digest !== digestJson(journalWithoutDigest)
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow durable apply journal 与 workflow intent 不匹配"
    );
  }
}

function maintenanceShadowHandleFromCommitDraft(
  shadow: MaintenanceWorkflowShadowCommitDraft,
  winnerAttemptId: string
): MaintenanceShadowHandle {
  const rootPath = path.resolve(shadow.controlRootPath);
  return {
    attemptId: winnerAttemptId,
    rootPath,
    agentVaultPath: path.join(rootPath, "vault"),
    manifestPath: path.join(rootPath, "manifest.json")
  };
}

function shadowProofWalError(
  error: unknown,
  prefix: string
): MaintenanceWorkflowWalError {
  if (error instanceof MaintenanceWorkflowWalError) return error;
  return new MaintenanceWorkflowWalError(
    error instanceof MaintenanceShadowError && error.code === "cas_conflict"
      ? "managed_cas_conflict"
      : "phase_conflict",
    `${prefix}：${errorMessage(error)}`,
    error instanceof MaintenanceShadowError
      ? error.relativePath
      : undefined
  );
}

function shadowJournalMetadataSuccessors(
  journal: MaintenanceShadowCommitJournalProof
): MaintenanceShadowMetadataSuccessorProof[] {
  const raw = journal.metadataSuccessors ?? [];
  const policy = journal.metadataSuccessorPolicy;
  if (
    !Array.isArray(raw)
    || (
      raw.length > 0
      && (
        !policy
        || policy.version !== 1
        || policy.kind !== "markdown-updated-only"
        || !Number.isFinite(policy.window?.lowerBoundMs)
        || !Number.isFinite(policy.window?.upperBoundMs)
        || policy.window.upperBoundMs < policy.window.lowerBoundMs
      )
    )
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow metadata successor policy/proof 非法"
    );
  }
  const seen = new Set<string>();
  const result = raw.map((proof) => {
    const relativePath = normalizeRelativePath(proof.relativePath);
    if (
      seen.has(relativePath)
      || proof.result?.kind !== "file"
      || !isSha256(proof.result.sha256)
      || !Number.isSafeInteger(proof.result.size)
      || proof.result.size < 0
      || !Number.isSafeInteger(proof.result.mode)
      || !Number.isFinite(proof.updatedAt)
      || !isSha256(proof.projectionDigest)
    ) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `Shadow metadata successor proof 非法：${relativePath}`,
        relativePath
      );
    }
    seen.add(relativePath);
    return {
      ...cloneJson(proof),
      relativePath,
      result: {
        ...proof.result,
        mode: normalizeMode(proof.result.mode)
      }
    };
  });
  return result.sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
}

function shadowCommitReceipt(
  journal: MaintenanceShadowCommitJournalProof,
  selectedPaths: readonly string[] = journal.selectedPaths
): string {
  return digestJson({
    journalDigest: journal.digest,
    attemptId: journal.attemptId,
    liveVaultFingerprint: journal.liveVaultFingerprint,
    changeSetDigest: journal.changeSetDigest,
    selectionDigest: journal.selectionDigest,
    // Journal and state digests bind the accepted recorded orders. Verification
    // may pass the legacy proof order when confirm happened under a different
    // locale than the original journal apply.
    selectedPaths: selectedPaths.map(normalizeRelativePath),
    metadataSuccessorPolicy: journal.metadataSuccessorPolicy,
    metadataSuccessors: shadowJournalMetadataSuccessors(journal),
    state: journal.state
  });
}

function legacyShadowCommitReceipt(
  journal: MaintenanceShadowCommitJournalProof,
  selectedPaths: readonly string[] = journal.selectedPaths
): string {
  return digestJson({
    journalDigest: journal.digest,
    attemptId: journal.attemptId,
    liveVaultFingerprint: journal.liveVaultFingerprint,
    changeSetDigest: journal.changeSetDigest,
    selectionDigest: journal.selectionDigest,
    selectedPaths: selectedPaths.map(normalizeRelativePath),
    state: journal.state
  });
}

async function verifyShadowJournalLiveTargets(
  liveVaultPath: string,
  journal: MaintenanceShadowCommitJournalProof,
  ignoredPaths: ReadonlySet<string> = new Set()
): Promise<void> {
  await verifyShadowProofLiveTargets(
    liveVaultPath,
    shadowJournalLiveTargets(journal).filter(
      (target) => !ignoredPaths.has(target.relativePath)
    )
  );
}

function shadowJournalLiveTargets(
  journal: MaintenanceShadowCommitJournalProof
): MaintenanceWorkflowShadowCommitProof["liveTargets"] {
  const successorsByPath = new Map(
    shadowJournalMetadataSuccessors(journal).map((proof) => [
      proof.relativePath,
      proof
    ])
  );
  return journal.entries.map((entry) => {
    const change = entry.change;
    const relativePath = normalizeRelativePath(change.relativePath);
    const result: MaintenanceWorkflowFileCas = change.operation === "delete"
      ? { kind: "missing" }
      : {
        kind: "file",
        sha256: change.shadowSha256,
        size: change.size,
        mode: change.expectedLive.kind === "file"
          ? normalizeMode(change.expectedLive.mode)
          : 0o644
      };
    const metadataSuccessor = successorsByPath.get(relativePath);
    return {
      relativePath,
      result,
      observedResult: metadataSuccessor?.result ?? result,
      ...(metadataSuccessor ? { metadataSuccessor } : {})
    };
  }).sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
}

function sameShadowLiveTargets(
  left: MaintenanceWorkflowShadowCommitProof["liveTargets"],
  right: MaintenanceWorkflowShadowCommitProof["liveTargets"]
): boolean {
  const canonical = (
    targets: MaintenanceWorkflowShadowCommitProof["liveTargets"]
  ) => targets.map((target) => ({
    ...target,
    observedResult: target.observedResult ?? target.result
  })).sort((first, second) => compareCanonicalText(
    first.relativePath,
    second.relativePath
  ));
  return stableStringify(canonical(left)) === stableStringify(canonical(right));
}

function assertShadowCommitProofSuccessor(
  previous: MaintenanceWorkflowShadowCommitProof,
  next: MaintenanceWorkflowShadowCommitProof
): void {
  if (stableStringify(previous) === stableStringify(next)) return;
  const previousByPath = new Map(previous.liveTargets.map((target) => [
    normalizeRelativePath(target.relativePath),
    target
  ]));
  const nextByPath = new Map(next.liveTargets.map((target) => [
    normalizeRelativePath(target.relativePath),
    target
  ]));
  if (
    previousByPath.size !== nextByPath.size
    || [...previousByPath.keys()].some((relativePath) => !nextByPath.has(relativePath))
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow commit proof selected paths 发生变化"
    );
  }
  for (const [relativePath, previousTarget] of previousByPath) {
    const nextTarget = nextByPath.get(relativePath)!;
    if (!sameCas(previousTarget.result, nextTarget.result)) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `Shadow commit sealed result 发生变化：${relativePath}`,
        relativePath
      );
    }
    const previousObserved = previousTarget.observedResult
      ?? previousTarget.result;
    const nextObserved = nextTarget.observedResult ?? nextTarget.result;
    const previousSuccessor = previousTarget.metadataSuccessor;
    const nextSuccessor = nextTarget.metadataSuccessor;
    if (sameCas(previousObserved, nextObserved)) {
      if (
        stableStringify(previousSuccessor)
        !== stableStringify(nextSuccessor)
      ) {
        throw new MaintenanceWorkflowWalError(
          "phase_conflict",
          `Shadow commit 相同 live CAS 的 successor proof 发生变化：${relativePath}`,
          relativePath
        );
      }
      continue;
    }
    if (
      !nextSuccessor
      || !sameCas(nextSuccessor.result, nextObserved)
      || normalizeRelativePath(nextSuccessor.relativePath) !== relativePath
      || (
        previousSuccessor
        && (
          nextSuccessor.updatedAt <= previousSuccessor.updatedAt
          || nextSuccessor.projectionDigest !== previousSuccessor.projectionDigest
          || (
            previousSuccessor.result.kind === "file"
            && nextSuccessor.result.kind === "file"
            && nextSuccessor.result.mode !== previousSuccessor.result.mode
          )
        )
      )
    ) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `Shadow metadata successor 不得倒退或改变投影：${relativePath}`,
        relativePath
      );
    }
  }
}

async function verifyShadowProofLiveTargets(
  liveVaultPath: string,
  liveTargets: MaintenanceWorkflowShadowCommitProof["liveTargets"]
): Promise<void> {
  for (const target of liveTargets) {
    const current = await snapshotMaintenanceWorkflowFileCas(
      liveVaultPath,
      target.relativePath
    );
    if (!sameCas(current, target.observedResult ?? target.result)) {
      throw new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `Shadow committed target CAS 不匹配：${target.relativePath}`,
        target.relativePath
      );
    }
  }
}

async function verifyShadowCommitJournal(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  liveVaultPathInput: string,
  proof: MaintenanceWorkflowShadowCommitProof,
  options: {
    ignoredLiveTargetPaths?: ReadonlySet<string>;
    acceptedIgnoredMetadataSuccessors?: readonly MaintenanceShadowMetadataSuccessorProof[];
  } = {}
): Promise<MaintenanceWorkflowShadowCommitProof> {
  if (!intent.shadow || !intent.winner) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "noop workflow 不存在 Shadow commit"
    );
  }
  const liveVaultPath = await ensurePlainDirectory(liveVaultPathInput, "live Vault");
  if (vaultFingerprint(liveVaultPath) !== intent.shadow.liveVaultFingerprint) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow commit proof 不属于当前 live Vault"
    );
  }
  let journal = await readShadowCommitJournal(
    handle.storageRootPath,
    intent.shadow.controlRootPath
  );
  await assertShadowCommitJournalMatches(
    journal,
    intent.shadow,
    intent.winner.attemptId
  );
  let verification: Awaited<
    ReturnType<typeof markMaintenanceShadowCommittedFromJournal>
  >;
  try {
    verification = await markMaintenanceShadowCommittedFromJournal(
      maintenanceShadowHandleFromCommitDraft(
        intent.shadow,
        intent.winner.attemptId
      ),
      liveVaultPath,
      {
        ignoredTargetPaths: [
          ...(options.ignoredLiveTargetPaths ?? new Set<string>())
        ],
        acceptedIgnoredMetadataSuccessors:
          (options.acceptedIgnoredMetadataSuccessors ?? []).filter(
            (accepted) => options.ignoredLiveTargetPaths?.has(
              normalizeRelativePath(accepted.relativePath)
            ) === true
          )
      }
    );
  } catch (error) {
    throw shadowProofWalError(
      error,
      "Shadow canonical apply journal 未通过复验"
    );
  }
  journal = await readShadowCommitJournal(
    handle.storageRootPath,
    intent.shadow.controlRootPath
  );
  await assertShadowCommitJournalMatches(
    journal,
    intent.shadow,
    intent.winner.attemptId
  );
  const journalLiveTargets = shadowJournalLiveTargets(journal);
  if (
    stableStringify(verification.metadataSuccessors)
    !== stableStringify(shadowJournalMetadataSuccessors(journal))
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow canonical verification 与 durable successor proof 不一致"
    );
  }
  const liveTargetsMatch = sameShadowLiveTargets(proof.liveTargets, journalLiveTargets);
  const proofSelectedPaths = proof.liveTargets.map(
    (target) => target.relativePath
  );
  const legacyReceiptAllowed =
    journal.metadataSuccessorPolicy === undefined
    && shadowJournalMetadataSuccessors(journal).length === 0;
  const receiptMatches =
    proof.commitReceipt === shadowCommitReceipt(journal)
    || (
      liveTargetsMatch
      && proof.commitReceipt === shadowCommitReceipt(
        journal,
        proofSelectedPaths
      )
    )
    || (
      legacyReceiptAllowed
      && (
        proof.commitReceipt === legacyShadowCommitReceipt(journal)
        || (
          liveTargetsMatch
          && proof.commitReceipt === legacyShadowCommitReceipt(
            journal,
            proofSelectedPaths
          )
        )
      )
    );
  const currentProof: MaintenanceWorkflowShadowCommitProof = {
    applyJournalDigest: journal.digest,
    commitReceipt: shadowCommitReceipt(journal),
    liveTargets: journalLiveTargets
  };
  if (journal.digest === proof.applyJournalDigest) {
    if (!liveTargetsMatch || !receiptMatches) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        "Shadow commit receipt 未通过 durable apply journal 复验"
      );
    }
  } else {
    assertShadowCommitProofSuccessor(proof, currentProof);
  }
  await verifyShadowJournalLiveTargets(
    liveVaultPath,
    journal,
    options.ignoredLiveTargetPaths
  );
  return currentProof;
}

async function verifyNoopLiveEvidence(
  liveVaultPathInput: string,
  proof: MaintenanceWorkflowNoopProof
): Promise<void> {
  const liveVaultPath = await ensurePlainDirectory(liveVaultPathInput, "live Vault");
  if (
    vaultFingerprint(liveVaultPath) !== proof.liveVaultFingerprint
    || proof.changedSourceCount !== 0
    || proof.discoveryDigest !== digestJson({
      discoveredSources: proof.sourceSnapshot,
      changedSources: []
    })
    || proof.sourceSnapshotDigest !== digestJson(proof.sourceSnapshot)
    || proof.sourceCount !== proof.sourceSnapshot.length
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "noop proof 未绑定当前 live Vault 的规范零变更快照"
    );
  }
  for (const source of proof.sourceSnapshot) {
    const relativePath = assertValidSourceRecord(source, "noop source snapshot");
    const parentChain = await captureSafeDirectoryChain(
      liveVaultPath,
      path.posix.dirname(relativePath)
    );
    if (!parentChain.complete) {
      throw new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `noop source snapshot 已缺失：${relativePath}`,
        relativePath
      );
    }
    const absolutePath = resolveInsideRoot(liveVaultPath, relativePath);
    const stat = await lstatOrNull(absolutePath);
    if (
      !stat
      || !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.size !== source.size
      || stat.mtimeMs !== source.mtime
    ) {
      throw new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `noop source snapshot 已变化：${relativePath}`,
        relativePath
      );
    }
    const content = await readIndependentRegularFile(
      absolutePath,
      `noop source ${relativePath}`,
      MAX_BLOB_BYTES
    );
    const after = await lstatOrNull(absolutePath);
    if (
      !after
      || after.size !== source.size
      || after.mtimeMs !== source.mtime
      || rawDigestFingerprint(relativePath, content) !== source.fingerprint
    ) {
      throw new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `noop source fingerprint 已变化：${relativePath}`,
        relativePath
      );
    }
    await assertSafeDirectoryChainUnchanged(parentChain);
  }
}

async function verifyWorkflowLiveEvidence(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  state: MaintenanceWorkflowWalState,
  liveVaultPathInput: string,
  options: {
    allowMissingShadowControlRoot?: boolean;
    allowManagedShadowOverrides?: boolean;
    acceptedIgnoredMetadataSuccessors?: readonly MaintenanceShadowMetadataSuccessorProof[];
  } = {}
): Promise<MaintenanceWorkflowWalState> {
  if (intent.completion === "noop") {
    if (
      !intent.noopProof
      || state.noopConfirmationDigest !== digestJson(intent.noopProof)
    ) {
      throw new MaintenanceWorkflowWalError(
        "state_corrupt",
        "noop workflow 缺少 durable confirmation"
      );
    }
    await verifyNoopLiveEvidence(liveVaultPathInput, intent.noopProof);
    return state;
  }
  if (!state.shadowCommitProof) {
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      "非 noop workflow 缺少 durable Shadow commit proof"
    );
  }
  const managedTargetsMayBeApplied =
    options.allowManagedShadowOverrides === true
    || PHASES.indexOf(state.phase) >= PHASES.indexOf("managed_committed");
  const managedWritesByPath = new Map(
    intent.managedWrites.map((write) => [
      normalizeRelativePath(write.relativePath),
      write
    ])
  );
  if (managedTargetsMayBeApplied) {
    for (const target of state.shadowCommitProof.liveTargets) {
      const managedWrite = managedWritesByPath.get(target.relativePath);
      if (
        managedWrite
        && !sameCas(managedWrite.expected, target.result)
      ) {
        throw new MaintenanceWorkflowWalError(
          "intent_corrupt",
          `managed write baseline 未绑定 Shadow commit proof：${target.relativePath}`,
          target.relativePath
        );
      }
    }
  }
  const ignoredLiveTargetPaths = managedTargetsMayBeApplied
    ? new Set(
      state.shadowCommitProof.liveTargets
        .map((target) => target.relativePath)
        .filter((relativePath) =>
          managedWritesByPath.has(relativePath)
        )
    )
    : new Set<string>();
  assertAcceptedIgnoredShadowMetadataSuccessors(
    state.shadowCommitProof,
    ignoredLiveTargetPaths,
    options.acceptedIgnoredMetadataSuccessors ?? []
  );
  if (
    options.allowMissingShadowControlRoot
    && intent.shadow
    && !await lstatOrNull(intent.shadow.controlRootPath)
  ) {
    const liveVaultPath = await ensurePlainDirectory(
      liveVaultPathInput,
      "live Vault"
    );
    if (vaultFingerprint(liveVaultPath) !== intent.shadow.liveVaultFingerprint) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        "Shadow commit proof 不属于当前 live Vault"
      );
    }
    await verifyShadowProofLiveTargets(
      liveVaultPath,
      state.shadowCommitProof.liveTargets.filter(
        (target) => !ignoredLiveTargetPaths.has(target.relativePath)
      )
    );
    return state;
  }
  const refreshedProof = await verifyShadowCommitJournal(
    handle,
    intent,
    liveVaultPathInput,
    state.shadowCommitProof,
    {
      ignoredLiveTargetPaths,
      acceptedIgnoredMetadataSuccessors:
        options.acceptedIgnoredMetadataSuccessors ?? []
    }
  );
  if (
    stableStringify(refreshedProof)
    !== stableStringify(state.shadowCommitProof)
  ) {
    return await persistRefreshedShadowCommitProof(
      handle,
      refreshedProof
    );
  }
  return state;
}

async function persistRefreshedShadowCommitProof(
  handle: MaintenanceWorkflowWalHandle,
  proof: MaintenanceWorkflowShadowCommitProof
): Promise<MaintenanceWorkflowWalState> {
  return await withWalStateLock(handle, async () => {
    const current = await loadMaintenanceWorkflowWal(handle);
    if (
      PHASES.indexOf(current.state.phase)
      < PHASES.indexOf("shadow_committed")
      || !current.state.shadowCommitProof
    ) {
      throw new MaintenanceWorkflowWalError(
        "state_corrupt",
        "Shadow proof refresh 缺少已提交的 WAL authority"
      );
    }
    if (
      stableStringify(current.state.shadowCommitProof)
      === stableStringify(proof)
    ) return current.state;
    assertShadowCommitProofSuccessor(
      current.state.shadowCommitProof,
      proof
    );
    return await writeNextWalState(current, {
      ...withoutStateDigest(current.state),
      sequence: current.state.sequence + 1,
      updatedAt: new Date().toISOString(),
      shadowCommitProof: proof
    });
  });
}

function assertAcceptedIgnoredShadowMetadataSuccessors(
  proof: MaintenanceWorkflowShadowCommitProof,
  ignoredPaths: ReadonlySet<string>,
  acceptedProofs: readonly MaintenanceShadowMetadataSuccessorProof[]
): void {
  const acceptedByPath = new Map(
    [...managedJournalProofsByPath(acceptedProofs)].filter(
      ([relativePath]) => ignoredPaths.has(relativePath)
    )
  );
  const consumed = new Set<string>();
  for (const target of proof.liveTargets) {
    const relativePath = normalizeRelativePath(target.relativePath);
    if (!ignoredPaths.has(relativePath)) continue;
    const accepted = acceptedByPath.get(relativePath);
    if (target.metadataSuccessor) {
      if (
        !accepted
        || stableStringify(accepted)
          !== stableStringify(target.metadataSuccessor)
      ) {
        throw new MaintenanceWorkflowWalError(
          "managed_cas_conflict",
          `ignored Shadow successor 缺少 managed accepted proof：${relativePath}`,
          relativePath
        );
      }
      consumed.add(relativePath);
    } else if (accepted) {
      throw new MaintenanceWorkflowWalError(
        "state_corrupt",
        `managed accepted proof 不属于 Shadow successor：${relativePath}`,
        relativePath
      );
    }
  }
  if (consumed.size !== acceptedByPath.size) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "managed accepted proof 不属于 ignored Shadow target"
    );
  }
}

function acceptedShadowMetadataSuccessorsForCleanup(
  state: MaintenanceWorkflowWalState,
  managedJournal: MaintenanceWorkflowManagedApplyJournal | undefined
): MaintenanceShadowMetadataSuccessorProof[] {
  if (!state.shadowCommitProof || !managedJournal) return [];
  const acceptedByPath = managedJournalProofsByPath(
    managedJournal.acceptedMetadataBaselines
  );
  const result: MaintenanceShadowMetadataSuccessorProof[] = [];
  for (const target of state.shadowCommitProof.liveTargets) {
    if (!target.metadataSuccessor) continue;
    const accepted = acceptedByPath.get(
      normalizeRelativePath(target.relativePath)
    );
    if (
      accepted
      && stableStringify(accepted)
        === stableStringify(target.metadataSuccessor)
    ) {
      result.push(cloneJson(accepted));
    }
  }
  return result.sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
}

export async function confirmMaintenanceWorkflowShadowCommitted(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPathInput: string,
  input: {
    changeSetDigest: string;
    selectionDigest: string;
    appliedPaths: string[];
  }
): Promise<MaintenanceWorkflowWalState> {
  const loaded = await loadMaintenanceWorkflowWal(handle);
  if (!loaded.intent.shadow || !loaded.intent.winner) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "noop workflow 必须使用 noop proof gate"
    );
  }
  if (
    input.changeSetDigest !== loaded.intent.shadow.changeSetDigest
    || input.selectionDigest !== loaded.intent.shadow.selectionDigest
    || !sameStringArray(
      normalizedUniquePaths(input.appliedPaths),
      normalizedUniquePaths(loaded.intent.shadow.expectedAppliedPaths)
    )
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow commit evidence 与 workflow intent 不匹配"
    );
  }
  let journal = await readShadowCommitJournal(
    handle.storageRootPath,
    loaded.intent.shadow.controlRootPath
  );
  await assertShadowCommitJournalMatches(
    journal,
    loaded.intent.shadow,
    loaded.intent.winner.attemptId
  );
  let verification: Awaited<
    ReturnType<typeof markMaintenanceShadowCommittedFromJournal>
  >;
  try {
    verification = await markMaintenanceShadowCommittedFromJournal(
      maintenanceShadowHandleFromCommitDraft(
        loaded.intent.shadow,
        loaded.intent.winner.attemptId
      ),
      liveVaultPathInput
    );
  } catch (error) {
    throw shadowProofWalError(
      error,
      "Shadow canonical apply journal 未通过复验"
    );
  }
  journal = await readShadowCommitJournal(
    handle.storageRootPath,
    loaded.intent.shadow.controlRootPath
  );
  await assertShadowCommitJournalMatches(
    journal,
    loaded.intent.shadow,
    loaded.intent.winner.attemptId
  );
  if (
    stableStringify(verification.metadataSuccessors)
    !== stableStringify(shadowJournalMetadataSuccessors(journal))
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow confirm 未消费 canonical metadata successor proof"
    );
  }
  let proof: MaintenanceWorkflowShadowCommitProof = {
    applyJournalDigest: journal.digest,
    commitReceipt: shadowCommitReceipt(journal),
    liveTargets: shadowJournalLiveTargets(journal)
  };
  proof = await verifyShadowCommitJournal(
    handle,
    loaded.intent,
    liveVaultPathInput,
    proof
  );
  return await withWalStateLock(handle, async () => {
    const current = await loadMaintenanceWorkflowWal(handle);
    if (
      PHASES.indexOf(current.state.phase)
      >= PHASES.indexOf("shadow_committed")
    ) {
      const existingProof = current.state.shadowCommitProof;
      if (!existingProof) {
        throw new MaintenanceWorkflowWalError(
          "state_corrupt",
          "Shadow committed WAL 缺少 commit proof"
        );
      }
      if (stableStringify(existingProof) === stableStringify(proof)) {
        return current.state;
      }
      assertShadowCommitProofSuccessor(existingProof, proof);
      const updatedAt = new Date().toISOString();
      return await writeNextWalState(current, {
        ...withoutStateDigest(current.state),
        sequence: current.state.sequence + 1,
        updatedAt,
        shadowCommitProof: proof
      });
    }
    if (current.state.phase !== "prepared") {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `Shadow commit 只能确认 prepared WAL：${current.state.phase}`
      );
    }
    if (current.state.blocked) {
      throw new MaintenanceWorkflowWalError(
        "wal_blocked",
        `workflow WAL 已阻断：${current.state.blocked.message}`
      );
    }
    return await advancePhaseLoadedUnlocked(current, "shadow_committed", {
      shadowCommitProof: proof
    });
  });
}

export async function createMaintenanceWorkflowNoopProof(input: {
  liveVaultPath: string;
  discoveredSources: MaintenanceWorkflowSourceRecord[];
  changedSources: MaintenanceWorkflowSourceRecord[];
}): Promise<MaintenanceWorkflowNoopProof> {
  const liveVaultPath = await ensurePlainDirectory(input.liveVaultPath, "live Vault");
  if (input.changedSources.length !== 0) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "noop proof 只允许零变更来源"
    );
  }
  const sourceSnapshot = input.discoveredSources
    .map((source) => cloneJson(source))
    .sort((left, right) => compareCanonicalText(
      left.relativePath,
      right.relativePath
    ));
  const sourcePaths = new Set<string>();
  for (const source of sourceSnapshot) {
    const relativePath = assertValidSourceRecord(source, "noop discovered source");
    if (sourcePaths.has(relativePath)) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `noop discovery source 重复：${relativePath}`
      );
    }
    sourcePaths.add(relativePath);
  }
  return {
    liveVaultFingerprint: vaultFingerprint(liveVaultPath),
    discoveryDigest: digestJson({
      discoveredSources: sourceSnapshot,
      changedSources: []
    }),
    sourceSnapshotDigest: digestJson(sourceSnapshot),
    sourceSnapshot,
    sourceCount: sourceSnapshot.length,
    changedSourceCount: 0
  };
}

export async function confirmMaintenanceWorkflowNoop(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPathInput: string,
  proof: MaintenanceWorkflowNoopProof
): Promise<MaintenanceWorkflowWalState> {
  const loaded = await loadMaintenanceWorkflowWal(handle);
  if (
    loaded.intent.completion !== "noop"
    || loaded.intent.shadow !== null
    || loaded.intent.winner !== null
    || !loaded.intent.noopProof
    || stableStringify(proof) !== stableStringify(loaded.intent.noopProof)
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "noop proof 与 workflow intent 不匹配"
    );
  }
  await verifyNoopLiveEvidence(liveVaultPathInput, loaded.intent.noopProof);
  const noopConfirmationDigest = digestJson(loaded.intent.noopProof);
  return await withWalStateLock(handle, async () => {
    const current = await loadMaintenanceWorkflowWal(handle);
    if (current.state.phase === "shadow_committed") {
      if (current.state.noopConfirmationDigest !== noopConfirmationDigest) {
        throw new MaintenanceWorkflowWalError(
          "state_corrupt",
          "noop confirmation 与已持久化 WAL state 不一致"
        );
      }
      return current.state;
    }
    if (current.state.phase !== "prepared") {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `noop 只能确认 prepared WAL：${current.state.phase}`
      );
    }
    if (current.state.blocked) {
      throw new MaintenanceWorkflowWalError(
        "wal_blocked",
        `workflow WAL 已阻断：${current.state.blocked.message}`
      );
    }
    return await advancePhaseLoadedUnlocked(current, "shadow_committed", {
      noopConfirmationDigest
    });
  });
}

export async function applyMaintenanceWorkflowManagedWrites(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPathInput: string,
  options: ApplyMaintenanceWorkflowManagedWritesOptions = {}
): Promise<{ appliedPaths: string[]; state: MaintenanceWorkflowWalState }> {
  const loaded = await loadMaintenanceWorkflowWal(handle);
  return await withVaultCommitLock(handle, loaded.intent, async () => {
    return await applyMaintenanceWorkflowManagedWritesLocked(
      handle,
      liveVaultPathInput,
      options
    );
  });
}

async function applyMaintenanceWorkflowManagedWritesLocked(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPathInput: string,
  options: ApplyMaintenanceWorkflowManagedWritesOptions
): Promise<{ appliedPaths: string[]; state: MaintenanceWorkflowWalState }> {
  let loaded = await loadMaintenanceWorkflowWal(handle);
  if (loaded.state.phase === "managed_committed") {
    const managedVerification =
      await finalizationManagedTargetVerificationOptions(
        handle,
        loaded,
        liveVaultPathInput
      );
    if (!managedVerification.managedJournal) {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        "managed_committed WAL 缺少 durable managed journal"
      );
    }
    loaded = {
      ...loaded,
      state: await verifyWorkflowLiveEvidence(
      handle,
      loaded.intent,
      loaded.state,
      liveVaultPathInput,
      {
        allowManagedShadowOverrides: true,
        acceptedIgnoredMetadataSuccessors:
          managedVerification.managedJournal.acceptedMetadataBaselines ?? []
      }
      )
    };
    await verifyAllManagedTargets(
      liveVaultPathInput,
      loaded.intent.managedWrites,
      managedVerification
    );
    return {
      appliedPaths: loaded.intent.managedWrites.map((write) => write.relativePath),
      state: loaded.state
    };
  }
  if (loaded.state.phase !== "shadow_committed") {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      `managed apply 需要 shadow_committed，当前为 ${loaded.state.phase}`
    );
  }
  if (loaded.state.blocked) {
    if (!options.resumeBlocked) {
      throw new MaintenanceWorkflowWalError(
        "wal_blocked",
        `workflow WAL 已阻断：${loaded.state.blocked.message}`
      );
    }
    assertMatchingBlockedResume(loaded.state, options.resumeBlocked);
  }
  const liveVaultPath = await ensurePlainDirectory(liveVaultPathInput, "live Vault");
  let journal = await readManagedJournalOrNull(handle.managedJournalPath);
  if (journal) {
    assertValidManagedJournal(journal, loaded.intent);
    // Validate cross-file authority before any policy upgrade or recovery
    // rewrite. A journal-only forged window must never be "repaired" into a
    // valid-looking record.
    assertManagedJournalLeaseBindings(journal, loaded.state, loaded.intent);
    journal = await ensureManagedJournalMetadataSuccessorPolicy(
      handle,
      journal,
      loaded.intent
    );
  }
  if (!journal) {
    try {
      loaded = {
        ...loaded,
        state: await verifyWorkflowLiveEvidence(
        handle,
        loaded.intent,
        loaded.state,
        liveVaultPath
        )
      };
    } catch (error) {
      const normalized = error instanceof MaintenanceWorkflowWalError
        ? error
        : new MaintenanceWorkflowWalError(
          "managed_cas_conflict",
          `workflow live evidence 无法复验：${errorMessage(error)}`
        );
      await markMaintenanceWorkflowWalBlocked(handle, {
        code: normalized.code,
        message: normalized.message
      }).catch(() => undefined);
      throw normalized;
    }
    journal = await prepareManagedJournal(handle, loaded.intent);
  }
  try {
    const preflight = await preflightManagedJournal(
      liveVaultPath,
      handle,
      loaded.intent,
      loaded.state,
      journal
    );
    journal = preflight.journal;
    loaded = { ...loaded, state: preflight.state };
    loaded = {
      ...loaded,
      state: await verifyWorkflowLiveEvidence(
      handle,
      loaded.intent,
      loaded.state,
      liveVaultPath,
      {
        allowManagedShadowOverrides: true,
        acceptedIgnoredMetadataSuccessors:
          journal.acceptedMetadataBaselines ?? []
      }
      )
    };
  } catch (error) {
    const normalized = error instanceof MaintenanceWorkflowWalError
      ? error
      : new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `managed preflight 无法安全继续：${errorMessage(error)}`
      );
    await updateManagedJournal(handle.managedJournalPath, journal, {
      state: "blocked",
      error: normalized.message
    }).catch(() => undefined);
    await markMaintenanceWorkflowWalBlocked(handle, {
      code: normalized.code,
      message: normalized.message
    }).catch(() => undefined);
    throw normalized;
  }

  if (journal.state === "committed") {
    journal = await refreshCommittedManagedMetadataSuccessors(
      handle,
      loaded.intent,
      liveVaultPath,
      journal
    );
    await verifyAllManagedTargets(
      liveVaultPath,
      loaded.intent.managedWrites,
      { handle, intent: loaded.intent, managedJournal: journal }
    );
    await cleanupManagedJournalArtifacts(
      liveVaultPath,
      handle,
      loaded.intent,
      journal,
      options
    );
    if (loaded.state.blocked) {
      await clearMaintenanceWorkflowWalBlockedInternal(handle, {
        stateSequence: loaded.state.sequence,
        stateDigest: loaded.state.digest
      });
      loaded = await loadMaintenanceWorkflowWal(handle);
    }
    const state = await advancePhaseInternal(
      handle,
      "shadow_committed",
      "managed_committed"
    );
    return {
      appliedPaths: journal.entries.map((entry) => entry.write.relativePath),
      state
    };
  }
  if (journal.state === "blocked" && !options.resumeBlocked) {
    throw new MaintenanceWorkflowWalError(
      "wal_blocked",
      journal.error || "managed apply journal 已阻断"
    );
  }
  if (journal.state === "blocked" || loaded.state.blocked) {
    journal = await updateManagedJournal(handle.managedJournalPath, journal, {
      state: "applying",
      error: undefined
    });
    if (loaded.state.blocked) {
      await clearMaintenanceWorkflowWalBlockedInternal(handle, {
        stateSequence: loaded.state.sequence,
        stateDigest: loaded.state.digest
      });
    }
  } else if (journal.state === "prepared") {
    journal = await updateManagedJournal(handle.managedJournalPath, journal, {
      state: "applying"
    });
  }

  try {
    for (const [index, entry] of journal.entries.entries()) {
      await options.faultInjector?.({
        point: "before-entry",
        index,
        relativePath: entry.write.relativePath
      });
      const effectiveInstall = await effectiveManagedInstallForEntry(
        handle,
        liveVaultPath,
        journal,
        entry
      );
      const lease = await ensureManagedJournalInstallWindowForEntry(
        handle,
        loaded.intent,
        liveVaultPath,
        loaded.state,
        journal,
        entry,
        effectiveInstall
      );
      journal = lease.journal;
      loaded = { ...loaded, state: lease.state };
      await applyManagedJournalEntry(
        liveVaultPath,
        handle,
        journal,
        entry,
        index,
        options
      );
    }
    const metadataSuccessors = await collectManagedMetadataSuccessors(
      handle,
      loaded.intent,
      liveVaultPath,
      journal
    );
    journal = await persistCommittedManagedJournal(
      handle,
      loaded.intent,
      liveVaultPath,
      journal,
      metadataSuccessors
    );
    await options.faultInjector?.({
      point: "after-journal-commit",
      index: journal.entries.length,
      relativePath: ""
    });
    await cleanupManagedJournalArtifacts(
      liveVaultPath,
      handle,
      loaded.intent,
      journal,
      options
    );
    const state = await advancePhaseInternal(
      handle,
      "shadow_committed",
      "managed_committed"
    );
    return {
      appliedPaths: journal.entries.map((entry) => entry.write.relativePath),
      state
    };
  } catch (error) {
    if (error instanceof MaintenanceWorkflowSimulatedCrash) throw error;
    const normalized = error instanceof MaintenanceWorkflowWalError
      ? error
      : new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `managed apply 无法安全继续：${errorMessage(error)}`
      );
    await updateManagedJournal(handle.managedJournalPath, journal, {
      state: "blocked",
      error: normalized.message
    }).catch(() => undefined);
    await markMaintenanceWorkflowWalBlocked(handle, {
      code: normalized.code,
      message: normalized.message
    }).catch(() => undefined);
    throw normalized;
  }
}

export async function commitMaintenanceWorkflowSettingsDurably<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPathInput: string,
  host: MaintenanceWorkflowSettingsHost<T> & {
    faultInjector?: (point: "after-atomic-persist") => void | Promise<void>;
    resumeBlocked?: {
      stateSequence: number;
      stateDigest: string;
    };
  }
): Promise<{ settings: T; changed: boolean; state: MaintenanceWorkflowWalState }> {
  const initial = await loadMaintenanceWorkflowWal(handle);
  return await withVaultCommitLock(handle, initial.intent, async () => {
    let loaded = await loadMaintenanceWorkflowWal(handle);
    if (loaded.state.phase === "settings_committed") {
      if (loaded.state.blocked) {
        if (!host.resumeBlocked) {
          throw new MaintenanceWorkflowWalError(
            "wal_blocked",
            `workflow WAL 已阻断：${loaded.state.blocked.message}`
          );
        }
        assertMatchingBlockedResume(loaded.state, host.resumeBlocked);
      }
      const managedVerification =
        await finalizationManagedTargetVerificationOptions(
          handle,
          loaded,
          liveVaultPathInput
        );
      loaded = {
        ...loaded,
        state: await verifyWorkflowLiveEvidence(
        handle,
        loaded.intent,
        loaded.state,
        liveVaultPathInput,
        {
          allowManagedShadowOverrides: true,
          acceptedIgnoredMetadataSuccessors:
            managedVerification.managedJournal
              ?.acceptedMetadataBaselines ?? []
        }
        )
      };
      await verifyManagedTargetsOrBlock(
        handle,
        liveVaultPathInput,
        loaded.intent.managedWrites,
        managedVerification
      );
      const readback = await host.withExclusiveTransaction(async (transaction) => {
        const current = await transaction.readWithGeneration();
        assertSettingsReadback(current, "settings replay readback");
        assertMaintenanceWorkflowSettingsTarget(current.settings, loaded.intent);
        if (
          loaded.state.settingsTargetProjectionDigest
          && loaded.state.settingsTargetProjectionDigest
            !== settingsTargetProjectionDigest(current.settings, loaded.intent)
        ) {
          throw new MaintenanceWorkflowWalError(
            "settings_cas_conflict",
            "settings replay target projection 与 WAL state 不一致"
          );
        }
        return current;
      });
      if (loaded.state.blocked) {
        const state = await clearMaintenanceWorkflowWalBlockedInternal(handle, {
          stateSequence: loaded.state.sequence,
          stateDigest: loaded.state.digest
        });
        return { settings: readback.settings, changed: false, state };
      }
      return { settings: readback.settings, changed: false, state: loaded.state };
    }
    if (loaded.state.phase !== "managed_committed") {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `settings commit 需要 managed_committed，当前为 ${loaded.state.phase}`
      );
    }
    if (loaded.state.blocked) {
      if (!host.resumeBlocked) {
        throw new MaintenanceWorkflowWalError(
          "wal_blocked",
          `workflow WAL 已阻断：${loaded.state.blocked.message}`
        );
      }
      assertMatchingBlockedResume(loaded.state, host.resumeBlocked);
    }
    try {
      const managedVerification =
        await finalizationManagedTargetVerificationOptions(
          handle,
          loaded,
          liveVaultPathInput
        );
      loaded = {
        ...loaded,
        state: await verifyWorkflowLiveEvidence(
        handle,
        loaded.intent,
        loaded.state,
        liveVaultPathInput,
        {
          allowManagedShadowOverrides: true,
          acceptedIgnoredMetadataSuccessors:
            managedVerification.managedJournal
              ?.acceptedMetadataBaselines ?? []
        }
        )
      };
      await verifyAllManagedTargets(
        liveVaultPathInput,
        loaded.intent.managedWrites,
        managedVerification
      );
      return await host.withExclusiveTransaction(async (transaction) => {
        const before = await transaction.readWithGeneration();
        assertSettingsReadback(before, "settings transaction baseline");
        const merged = mergeMaintenanceWorkflowSettings(
          cloneJson(before.settings),
          loaded.intent
        );
        const persisted = await transaction.persistCas(
          before.generation,
          cloneJson(merged.settings)
        );
        assertSettingsReadback(persisted, "settings transaction persist receipt");
        if (merged.changed && persisted.generation === before.generation) {
          throw new MaintenanceWorkflowWalError(
            "settings_persist_failed",
            "settings CAS 写入成功后 generation 未变化"
          );
        }
        const readback = await transaction.readWithGeneration();
        assertSettingsReadback(readback, "settings transaction durable readback");
        if (
          readback.generation !== persisted.generation
          || stableStringify(readback.settings)
            !== stableStringify(persisted.settings)
        ) {
          throw new MaintenanceWorkflowWalError(
            "settings_cas_conflict",
            "settings persist receipt 与同事务 readback 不一致"
          );
        }
        assertMaintenanceWorkflowSettingsTarget(readback.settings, loaded.intent);
        const targetProjectionDigest = settingsTargetProjectionDigest(
          readback.settings,
          loaded.intent
        );
        await host.faultInjector?.("after-atomic-persist");
        const phaseReadback = await transaction.readWithGeneration();
        assertSettingsReadback(
          phaseReadback,
          "settings pre-phase durable readback"
        );
        const phaseProjectionDigest = settingsTargetProjectionDigest(
          phaseReadback.settings,
          loaded.intent
        );
        if (
          phaseReadback.generation !== readback.generation
          || phaseProjectionDigest !== targetProjectionDigest
          || stableStringify(phaseReadback.settings)
            !== stableStringify(readback.settings)
        ) {
          throw new MaintenanceWorkflowWalError(
            "settings_cas_conflict",
            "settings durable readback 到 WAL phase 落盘前发生变化"
          );
        }
        assertMaintenanceWorkflowSettingsTarget(
          phaseReadback.settings,
          loaded.intent
        );
        if (loaded.state.blocked) {
          await clearMaintenanceWorkflowWalBlockedInternal(handle, {
            stateSequence: loaded.state.sequence,
            stateDigest: loaded.state.digest
          });
        }
        const state = await advancePhaseInternalWithPatch(
          handle,
          "managed_committed",
          "settings_committed",
          {
            settingsGeneration: phaseReadback.generation,
            settingsTargetProjectionDigest: phaseProjectionDigest
          }
        );
        if (
          state.settingsGeneration !== phaseReadback.generation
          || state.settingsTargetProjectionDigest !== phaseProjectionDigest
        ) {
          throw new MaintenanceWorkflowWalError(
            "state_corrupt",
            "settings WAL phase proof 与最后一次 durable readback 不一致"
          );
        }
        return {
          settings: phaseReadback.settings,
          changed: merged.changed,
          state
        };
      });
    } catch (error) {
      if (error instanceof MaintenanceWorkflowSimulatedCrash) throw error;
      if (
        error instanceof MaintenanceWorkflowWalError
        && (
          error.code === "settings_cas_conflict"
          || error.code === "managed_cas_conflict"
        )
      ) {
        await markMaintenanceWorkflowWalBlocked(handle, {
          code: error.code,
          message: error.message
        }).catch(() => undefined);
        throw error;
      }
      const normalized = error instanceof MaintenanceWorkflowWalError
        ? error
        : new MaintenanceWorkflowWalError(
          "settings_persist_failed",
          `settings durable commit 失败：${errorMessage(error)}`
        );
      throw normalized;
    }
  });
}

export async function finalizeMaintenanceWorkflowWal<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPathInput: string,
  cleanup: (
    intent: MaintenanceWorkflowWalIntent,
    evidence: MaintenanceWorkflowFinalizeCleanupEvidence
  ) => void | Promise<void>,
  options: {
    settingsHost?: MaintenanceWorkflowSettingsHost<T>;
    resumeBlocked?: MaintenanceWorkflowBlockedResumeToken;
  } = {}
): Promise<MaintenanceWorkflowWalState> {
  const initial = await loadMaintenanceWorkflowWal(handle);
  if (initial.state.phase === "finalized") return initial.state;
  if (initial.state.phase !== "settings_committed") {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      `finalize 需要 settings_committed，当前为 ${initial.state.phase}`
    );
  }
  if (initial.state.blocked) {
    if (!options.resumeBlocked) {
      throw new MaintenanceWorkflowWalError(
        "wal_blocked",
      `workflow WAL 已阻断：${initial.state.blocked.message}`
    );
    }
    assertMatchingBlockedResume(initial.state, options.resumeBlocked);
  }
  if (!options.settingsHost) {
    throw new MaintenanceWorkflowWalError(
      "settings_persist_failed",
      "finalize 缺少 settings 排他事务 Host"
    );
  }
  try {
    return await withVaultCommitLock(handle, initial.intent, async () => {
      let beforeTransaction = await loadMaintenanceWorkflowWal(handle);
      if (beforeTransaction.state.phase === "finalized") {
        return beforeTransaction.state;
      }
      if (beforeTransaction.state.phase !== "settings_committed") {
        throw new MaintenanceWorkflowWalError(
          "phase_conflict",
          `finalize 需要 settings_committed，当前为 ${beforeTransaction.state.phase}`
        );
      }
      if (beforeTransaction.state.blocked) {
        if (!options.resumeBlocked) {
          throw new MaintenanceWorkflowWalError(
            "wal_blocked",
            `workflow WAL 已阻断：${beforeTransaction.state.blocked.message}`
          );
        }
        assertMatchingBlockedResume(
          beforeTransaction.state,
          options.resumeBlocked
        );
      }
      const beforeManagedVerification =
        await finalizationManagedTargetVerificationOptions(
          handle,
          beforeTransaction,
          liveVaultPathInput
        );
      beforeTransaction = {
        ...beforeTransaction,
        state: await verifyWorkflowLiveEvidence(
        handle,
        beforeTransaction.intent,
        beforeTransaction.state,
        liveVaultPathInput,
        {
          allowMissingShadowControlRoot: true,
          allowManagedShadowOverrides: true,
          acceptedIgnoredMetadataSuccessors:
            beforeManagedVerification.managedJournal
              ?.acceptedMetadataBaselines ?? []
        }
        )
      };
      await verifyManagedTargetsOrBlock(
        handle,
        liveVaultPathInput,
        beforeTransaction.intent.managedWrites,
        beforeManagedVerification
      );
      return await options.settingsHost!.withExclusiveTransaction(
        async (transaction) => {
          const beforeCleanup = await transaction.readWithGeneration();
          assertSettingsReadback(beforeCleanup, "finalize settings readback");
          assertMaintenanceWorkflowSettingsTarget(
            beforeCleanup.settings,
            beforeTransaction.intent
          );
          assertFinalSettingsProjection(
            beforeCleanup.settings,
            beforeTransaction
          );
          const beforeCleanupProjectionDigest =
            settingsTargetProjectionDigest(
              beforeCleanup.settings,
              beforeTransaction.intent
            );
          await cleanupShadowControlRootReplayably(
            beforeTransaction.intent,
            cleanup,
            {
              acceptedShadowMetadataSuccessors:
                acceptedShadowMetadataSuccessorsForCleanup(
                  beforeTransaction.state,
                  beforeManagedVerification.managedJournal
                ),
              ...(beforeManagedVerification.managedJournal
                ? {
                  managedJournalDigest:
                    beforeManagedVerification.managedJournal.digest
                }
                : {}),
              managedResultSuccessors: cloneJson(
                beforeManagedVerification.managedJournal
                  ?.metadataSuccessors ?? []
              )
            }
          );
          const afterCleanup = await transaction.readWithGeneration();
          assertSettingsReadback(
            afterCleanup,
            "finalize settings post-cleanup readback"
          );
          assertMaintenanceWorkflowSettingsTarget(
            afterCleanup.settings,
            beforeTransaction.intent
          );
          assertFinalSettingsProjection(afterCleanup.settings, beforeTransaction);
          if (
            afterCleanup.generation !== beforeCleanup.generation
            || settingsTargetProjectionDigest(
              afterCleanup.settings,
              beforeTransaction.intent
            ) !== beforeCleanupProjectionDigest
            || stableStringify(afterCleanup.settings)
              !== stableStringify(beforeCleanup.settings)
          ) {
            throw new MaintenanceWorkflowWalError(
              "settings_cas_conflict",
              "finalize cleanup 到 WAL phase 落盘前 settings 发生变化"
            );
          }
          // Re-prove the live evidence after cleanup without holding the WAL
          // state lock. The final state CAS below then guarantees the blocker
          // token did not change while these file checks were running.
          const afterManagedVerification =
            await finalizationManagedTargetVerificationOptions(
              handle,
              beforeTransaction,
              liveVaultPathInput
            );
          beforeTransaction = {
            ...beforeTransaction,
            state: await verifyWorkflowLiveEvidence(
            handle,
            beforeTransaction.intent,
            beforeTransaction.state,
            liveVaultPathInput,
            {
              allowMissingShadowControlRoot: true,
              allowManagedShadowOverrides: true,
              acceptedIgnoredMetadataSuccessors:
                afterManagedVerification.managedJournal
                  ?.acceptedMetadataBaselines ?? []
            }
            )
          };
          await verifyAllManagedTargets(
            liveVaultPathInput,
            beforeTransaction.intent.managedWrites,
            afterManagedVerification
          );
          return await withWalStateLock(handle, async () => {
            const loaded = await loadMaintenanceWorkflowWal(handle);
            if (loaded.state.phase === "finalized") return loaded.state;
            if (
              loaded.state.phase !== "settings_committed"
              || loaded.state.sequence !== beforeTransaction.state.sequence
              || loaded.state.digest !== beforeTransaction.state.digest
            ) {
              throw new MaintenanceWorkflowWalError(
                "phase_conflict",
                "finalize 复验后 workflow WAL state 已变化"
              );
            }
            if (loaded.state.blocked) {
              if (!options.resumeBlocked) {
                throw new MaintenanceWorkflowWalError(
                  "wal_blocked",
                  `workflow WAL 已阻断：${loaded.state.blocked.message}`
                );
              }
              assertMatchingBlockedResume(loaded.state, options.resumeBlocked);
            }
            const { blocked: _blocked, ...state } = withoutStateDigest(
              loaded.state
            );
            return await writeNextWalState(loaded, {
              ...state,
              phase: "finalized",
              sequence: loaded.state.sequence + 1,
              updatedAt: new Date().toISOString()
            });
          });
        }
      );
    });
  } catch (error) {
    if (error instanceof MaintenanceWorkflowSimulatedCrash) throw error;
    const normalized = error instanceof MaintenanceWorkflowWalError
      ? error
      : new MaintenanceWorkflowWalError(
        "settings_persist_failed",
        `finalize 无法安全完成：${errorMessage(error)}`
      );
    if (
      normalized.code === "settings_cas_conflict"
      || normalized.code === "settings_persist_failed"
      || normalized.code === "managed_cas_conflict"
      || normalized.code === "unsafe_entry"
    ) {
      await markMaintenanceWorkflowWalBlocked(handle, {
        code: normalized.code,
        message: normalized.message
      }).catch(() => undefined);
    }
    throw normalized;
  }
}

/**
 * Returns a CAS-bound resume token for blockers whose durable transaction can
 * be replayed without trusting the old error text. An early managed retry
 * requires a matching blocked journal plus WAL lease authority; replay still
 * re-proves every live CAS before either blocker is cleared. Finalization keeps
 * the stricter target/settings proof used for post-commit metadata successors.
 */
export async function maintenanceWorkflowSafeBlockedResumeToken<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  loaded: LoadedMaintenanceWorkflowWal,
  liveVaultPathInput: string,
  settingsHost?: MaintenanceWorkflowSettingsHost<T>
): Promise<MaintenanceWorkflowBlockedResumeToken | null> {
  const blockerCode = loaded.state.blocked?.code;
  if (
    loaded.state.phase === "shadow_committed"
    && blockerCode === "managed_cas_conflict"
  ) {
    try {
      const journal = await readManagedJournalOrNull(
        loaded.handle.managedJournalPath
      );
      if (
        !journal
        || journal.state !== "blocked"
        || !journal.error
        || journal.error !== loaded.state.blocked?.message
      ) return null;
      assertValidManagedJournal(journal, loaded.intent);
      assertManagedJournalLeaseBindings(
        journal,
        loaded.state,
        loaded.intent
      );
      return {
        stateSequence: loaded.state.sequence,
        stateDigest: loaded.state.digest
      };
    } catch {
      return null;
    }
  }
  if (
    loaded.state.phase === "managed_committed"
    && (
      blockerCode === "settings_cas_conflict"
      || blockerCode === "settings_persist_failed"
    )
  ) {
    if (!settingsHost) return null;
    try {
      const options = await finalizationManagedTargetVerificationOptions(
        loaded.handle,
        loaded,
        liveVaultPathInput
      );
      if (!options.managedJournal) return null;
      loaded = {
        ...loaded,
        state: await verifyWorkflowLiveEvidence(
          loaded.handle,
          loaded.intent,
          loaded.state,
          liveVaultPathInput,
          {
            allowManagedShadowOverrides: true,
            acceptedIgnoredMetadataSuccessors:
              options.managedJournal.acceptedMetadataBaselines ?? []
          }
        )
      };
      await verifyAllManagedTargets(
        liveVaultPathInput,
        loaded.intent.managedWrites,
        options
      );
      await settingsHost.withExclusiveTransaction(async (transaction) => {
        const current = await transaction.readWithGeneration();
        assertSettingsReadback(
          current,
          "blocked managed settings recovery preflight"
        );
        // This is a dry three-way merge. It grants a token only while every
        // managed settings field is still baseline, target, or a permitted
        // newer run; a third value remains blocked and is never overwritten.
        mergeMaintenanceWorkflowSettings(
          cloneJson(current.settings),
          loaded.intent
        );
      });
      return {
        stateSequence: loaded.state.sequence,
        stateDigest: loaded.state.digest
      };
    } catch {
      return null;
    }
  }
  if (
    loaded.state.phase !== "settings_committed"
    || (
      blockerCode !== "managed_cas_conflict"
      && blockerCode !== "settings_cas_conflict"
    )
  ) {
    return null;
  }
  try {
    const options = await finalizationManagedTargetVerificationOptions(
      loaded.handle,
      loaded,
      liveVaultPathInput
    );
    if (!options.managedJournal) return null;
    loaded = {
      ...loaded,
      state: await verifyWorkflowLiveEvidence(
      loaded.handle,
      loaded.intent,
      loaded.state,
      liveVaultPathInput,
      {
        allowMissingShadowControlRoot: true,
        allowManagedShadowOverrides: true,
        acceptedIgnoredMetadataSuccessors:
          options.managedJournal.acceptedMetadataBaselines ?? []
      }
      )
    };
    await verifyAllManagedTargets(
      liveVaultPathInput,
      loaded.intent.managedWrites,
      options
    );
    if (
      blockerCode === "settings_cas_conflict"
      && (
        !settingsHost
        || !await settingsConflictCurrentlyMatchesWalTarget(
          loaded,
          settingsHost
        )
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    stateSequence: loaded.state.sequence,
    stateDigest: loaded.state.digest
  };
}

function assertFinalSettingsProjection(
  current: MaintenanceWorkflowSettingsSnapshot,
  loaded: LoadedMaintenanceWorkflowWal
): void {
  if (
    !isSha256(loaded.state.settingsTargetProjectionDigest)
    || settingsTargetProjectionDigest(current, loaded.intent)
      !== loaded.state.settingsTargetProjectionDigest
  ) {
    throw new MaintenanceWorkflowWalError(
      "settings_cas_conflict",
      "finalize settings target projection 与 WAL state 不一致"
    );
  }
}

async function cleanupShadowControlRootReplayably(
  intent: MaintenanceWorkflowWalIntent,
  cleanup: (
    intent: MaintenanceWorkflowWalIntent,
    evidence: MaintenanceWorkflowFinalizeCleanupEvidence
  ) => void | Promise<void>,
  evidence: MaintenanceWorkflowFinalizeCleanupEvidence
): Promise<void> {
  if (intent.completion === "noop") return;
  if (!intent.shadow) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "非 noop workflow 缺少 Shadow cleanup target"
    );
  }
  const before = await lstatOrNull(intent.shadow.controlRootPath);
  if (!before) {
    // The previous process may have removed the Shadow and crashed before the
    // finalized phase write. Absence is the durable cleanup receipt.
    return;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new MaintenanceWorkflowWalError(
      "unsafe_entry",
      "Shadow cleanup target 不是安全目录"
    );
  }
  await cleanup(intent, evidence);
  const after = await lstatOrNull(intent.shadow.controlRootPath);
  if (after) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "Shadow cleanup 返回后 control root 仍存在"
    );
  }
}

export function mergeMaintenanceWorkflowSettings<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  current: T,
  intent: MaintenanceWorkflowWalIntent
): MaintenanceWorkflowSettingsMergeResult<T> {
  const processedEntries = new Map(
    Object.entries(cloneJson(current.processedSources))
  );
  for (const key of managedProcessedSourceKeys(intent.settings)) {
    const baseline = recordEntry(intent.settings.baselineProcessedSources, key);
    const target = recordEntry(intent.settings.targetProcessedSources, key);
    const currentEntry = mapEntry(processedEntries, key);
    if (sameOptionalJsonEntry(currentEntry, target)) {
      continue;
    }
    if (!sameOptionalJsonEntry(currentEntry, baseline)) {
      throw new MaintenanceWorkflowWalError(
        "settings_cas_conflict",
        `processedSources 同一来源出现第三值：${key}`
      );
    }
    if (target.present) {
      processedEntries.set(key, cloneJson(target.value));
    } else {
      processedEntries.delete(key);
    }
  }
  const processedSources = Object.fromEntries(
    Array.from(processedEntries.entries())
      .sort(([left], [right]) => compareCanonicalText(left, right))
  ) as Record<string, KnowledgeBaseProcessedSource>;

  const currentTerminal = terminalSettingsFromSnapshot(current);
  const currentTerminalDigest = digestJson(currentTerminal);
  const terminalMatchesBaseline =
    currentTerminalDigest === intent.settings.baselineTerminalDigest;
  const targetProjectionTerminal = terminalSettingsForWalTargetProjection(
    current,
    intent
  );
  const terminalMatchesTarget =
    digestJson(targetProjectionTerminal)
      === intent.settings.targetTerminalDigest;
  const terminalIsNewer =
    Number.isFinite(currentTerminal.lastRunAt)
    && currentTerminal.lastRunAt > intent.settings.targetTerminal.lastRunAt;
  if (!terminalMatchesBaseline && !terminalMatchesTarget && !terminalIsNewer) {
    throw new MaintenanceWorkflowWalError(
      "settings_cas_conflict",
      "知识库终态字段与 WAL baseline/target 均不匹配"
    );
  }

  const scheduledProjection = intent.settings.scheduled;
  let scheduledTarget:
    | MaintenanceWorkflowScheduledSettings
    | null = null;
  if (scheduledProjection) {
    const currentScheduled = scheduledSettingsFromSnapshot(current);
    const scheduledMatchesBaseline =
      sameScheduledSettings(
        currentScheduled,
        scheduledProjection.baseline
      );
    const scheduledMatchesTarget =
      sameScheduledSettings(
        currentScheduled,
        scheduledProjection.target
      );
    const scheduledIsNewer =
      isNewerUnrelatedScheduledSettings(
        currentScheduled,
        scheduledProjection
      );
    if (
      !scheduledMatchesBaseline
      && !scheduledMatchesTarget
      && !scheduledIsNewer
    ) {
      throw new MaintenanceWorkflowWalError(
        "settings_cas_conflict",
        "每日维护终态字段与 WAL baseline/target 均不匹配，且不是更晚的独立 run"
      );
    }
    scheduledTarget = scheduledMatchesBaseline
      ? cloneJson(scheduledProjection.target)
      : currentScheduled;
  }

  const historyEntry = cloneJson(intent.settings.historyEntry);
  const runId = historyEntry.runId;
  if (!runId || runId !== intent.workflowRunId) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "settings history entry 缺少 matching workflowRunId"
    );
  }
  const existingHistory = current.maintenanceHistory.find(
    (entry) => entry.runId === runId
  );
  if (existingHistory && stableStringify(existingHistory) !== stableStringify(historyEntry)) {
    throw new MaintenanceWorkflowWalError(
      "settings_cas_conflict",
      `maintenanceHistory runId 冲突：${runId}`
    );
  }
  const maintenanceHistory = existingHistory
    ? cloneJson(current.maintenanceHistory)
    : [...cloneJson(current.maintenanceHistory), historyEntry];
  const next = {
    ...cloneJson(current),
    processedSources,
    ...(terminalMatchesBaseline
      ? cloneJson(intent.settings.targetTerminal)
      : cloneJson(currentTerminal)),
    ...(scheduledTarget ?? {}),
    maintenanceHistory
  } as T;
  assertMaintenanceWorkflowSettingsTarget(next, intent);
  return {
    settings: next,
    changed: stableStringify(next) !== stableStringify(current)
  };
}

export function assertMaintenanceWorkflowSettingsTarget(
  current: MaintenanceWorkflowSettingsSnapshot,
  intent: MaintenanceWorkflowWalIntent
): void {
  for (const key of managedProcessedSourceKeys(intent.settings)) {
    const currentEntry = recordEntry(current.processedSources, key);
    const target = recordEntry(intent.settings.targetProcessedSources, key);
    if (!sameOptionalJsonEntry(currentEntry, target)) {
      throw new MaintenanceWorkflowWalError(
        "settings_cas_conflict",
        `持久化 processedSources 未达到 WAL target：${key}`
      );
    }
  }
  const terminal = terminalSettingsFromSnapshot(current);
  const targetProjectionTerminal = terminalSettingsForWalTargetProjection(
    current,
    intent
  );
  const terminalMatchesTarget =
    digestJson(targetProjectionTerminal)
      === intent.settings.targetTerminalDigest;
  const terminalIsNewer =
    Number.isFinite(terminal.lastRunAt)
    && terminal.lastRunAt > intent.settings.targetTerminal.lastRunAt;
  if (!terminalMatchesTarget && !terminalIsNewer) {
    throw new MaintenanceWorkflowWalError(
      "settings_cas_conflict",
      "持久化知识库终态字段未达到 WAL target"
    );
  }
  if (intent.settings.scheduled) {
    const scheduled = scheduledSettingsFromSnapshot(current);
    if (
      !sameScheduledSettings(
        scheduled,
        intent.settings.scheduled.target
      )
      && !isNewerUnrelatedScheduledSettings(
        scheduled,
        intent.settings.scheduled
      )
    ) {
      throw new MaintenanceWorkflowWalError(
        "settings_cas_conflict",
        "持久化每日维护终态字段未达到 WAL target，且未被更晚独立 run 取代"
      );
    }
  }
  const targetHistory = current.maintenanceHistory.find(
    (entry) => entry.runId === intent.workflowRunId
  );
  if (
    !targetHistory
    || stableStringify(targetHistory)
      !== stableStringify(intent.settings.historyEntry)
  ) {
    throw new MaintenanceWorkflowWalError(
      "settings_cas_conflict",
      `持久化 maintenanceHistory 缺少 matching runId：${intent.workflowRunId}`
    );
  }
}

function assertSettingsReadback<T extends MaintenanceWorkflowSettingsSnapshot>(
  readback: MaintenanceWorkflowSettingsReadback<T>,
  label: string
): void {
  if (
    !readback
    || typeof readback !== "object"
    || !readback.settings
    || typeof readback.settings !== "object"
    || typeof readback.generation !== "string"
    || !readback.generation.trim()
    || readback.generation.includes("\0")
    || readback.generation.length > 512
  ) {
    throw new MaintenanceWorkflowWalError(
      "settings_persist_failed",
      `${label} 缺少可信 generation`
    );
  }
}

function settingsTargetProjectionDigest(
  current: MaintenanceWorkflowSettingsSnapshot,
  intent: MaintenanceWorkflowWalIntent
): string {
  const processedSources = Object.fromEntries(
    managedProcessedSourceKeys(intent.settings).map((key) => [
      key,
      recordEntry(current.processedSources, key)
    ])
  );
  const historyEntry = current.maintenanceHistory.find(
    (entry) => entry.runId === intent.workflowRunId
  ) ?? null;
  return digestJson({
    processedSources,
    terminal: terminalSettingsForWalTargetProjection(current, intent),
    ...(intent.settings.scheduled
      ? {
        scheduled: {
          accepted: "target-or-newer",
          target: cloneJson(intent.settings.scheduled.target)
        }
      }
      : {}),
    historyEntry
  });
}

async function settingsConflictCurrentlyMatchesWalTarget<
  T extends MaintenanceWorkflowSettingsSnapshot
>(
  loaded: LoadedMaintenanceWorkflowWal,
  settingsHost: MaintenanceWorkflowSettingsHost<T>
): Promise<boolean> {
  try {
    return await settingsHost.withExclusiveTransaction(async (transaction) => {
      const readback = await transaction.readWithGeneration();
      assertSettingsReadback(readback, "blocked settings recovery preflight");
      assertMaintenanceWorkflowSettingsTarget(readback.settings, loaded.intent);
      assertFinalSettingsProjection(readback.settings, loaded);
      const terminal = terminalSettingsFromSnapshot(readback.settings);
      const projected = terminalSettingsForWalTargetProjection(
        readback.settings,
        loaded.intent
      );
      const rawMatchesTarget =
        digestJson(terminal) === loaded.intent.settings.targetTerminalDigest;
      const exactNativeCleanupProjection =
        !rawMatchesTarget
        && digestJson(projected)
          === loaded.intent.settings.targetTerminalDigest;
      return rawMatchesTarget || exactNativeCleanupProjection;
    });
  } catch {
    return false;
  }
}

/**
 * Native Execution cleanup runs after the business result is durable. Its
 * structured receipt decorates the visible terminal error/summary/warnings,
 * but must not turn that same committed maintenance terminal into a WAL CAS
 * conflict. Only an exact, post-run native-cleanup projection is unwrapped;
 * local-persistence receipts and every other terminal drift remain visible to
 * the normal digest checks and therefore fail closed.
 */
function terminalSettingsForWalTargetProjection(
  current: MaintenanceWorkflowSettingsSnapshot,
  intent: MaintenanceWorkflowWalIntent
): MaintenanceWorkflowTerminalSettings {
  const terminal = terminalSettingsFromSnapshot(current);
  if (digestJson(terminal) === intent.settings.targetTerminalDigest) {
    return terminal;
  }
  const receipt = current.nativeLifecycleRecoveryReceipt;
  if (!isExactPostRunNativeCleanupProjection(
    terminal,
    receipt,
    intent.settings.targetTerminal
  )) {
    return terminal;
  }
  return {
    ...terminal,
    lastError: receipt.projection.lastErrorBefore,
    lastSummary: receipt.projection.lastSummaryBefore,
    lastWarnings: terminal.lastWarnings.filter(
      (warning) => warning.id !== receipt.warningId
    )
  };
}

function isExactPostRunNativeCleanupProjection(
  terminal: MaintenanceWorkflowTerminalSettings,
  receipt: KnowledgeBaseNativeLifecycleRecoveryReceipt | null | undefined,
  target: MaintenanceWorkflowTerminalSettings
): receipt is KnowledgeBaseNativeLifecycleRecoveryReceipt {
  if (
    !receipt
    || receipt.schemaVersion !== 1
    || receipt.issue !== "native-cleanup"
    || receipt.warningId !== "native-cleanup-recovery"
    || (
      receipt.localCommitStatus !== "committed"
      && receipt.localCommitStatus !== "unknown"
    )
    || !Array.isArray(receipt.cleanupStatuses)
    || receipt.cleanupStatuses.some((status) =>
      typeof status !== "string" || !status.trim()
    )
    || typeof receipt.cleanupAttempted !== "boolean"
    || !Array.isArray(receipt.recordIds)
    || receipt.recordIds.some((recordId) =>
      typeof recordId !== "string" || !recordId.trim()
    )
    || !Number.isSafeInteger(receipt.firstObservedAt)
    || !Number.isSafeInteger(receipt.updatedAt)
    || receipt.firstObservedAt < target.lastRunAt
    || receipt.updatedAt < receipt.firstObservedAt
    || typeof receipt.message !== "string"
    || !receipt.message.startsWith(NATIVE_CLEANUP_RECOVERY_ERROR_PREFIX)
    || !receipt.message.slice(
      NATIVE_CLEANUP_RECOVERY_ERROR_PREFIX.length
    ).trim()
    || !receipt.projection
    || typeof receipt.projection !== "object"
    || typeof receipt.projection.lastErrorBefore !== "string"
    || typeof receipt.projection.lastSummaryBefore !== "string"
    || typeof receipt.projection.lastErrorWithRecovery !== "string"
    || typeof receipt.projection.lastSummaryWithRecovery !== "string"
    || receipt.projection.lastErrorBefore !== target.lastError
    || receipt.projection.lastSummaryBefore !== target.lastSummary
    || receipt.projection.lastErrorWithRecovery
      !== appendNativeLifecycleRecoveryProjection(
        target.lastError,
        receipt.message
      )
    || receipt.projection.lastSummaryWithRecovery
      !== appendNativeLifecycleRecoveryProjection(
        target.lastSummary,
        NATIVE_CLEANUP_RECOVERY_SUMMARY_PROJECTION
      )
    || terminal.lastError !== receipt.projection.lastErrorWithRecovery
    || terminal.lastSummary !== receipt.projection.lastSummaryWithRecovery
    || target.lastWarnings.some((warning) =>
      warning.id === "native-cleanup-recovery"
      || warning.id === "native-local-commit-recovery"
    )
  ) {
    return false;
  }
  const nativeRecoveryWarnings = terminal.lastWarnings.filter((warning) =>
    warning.id === "native-cleanup-recovery"
    || warning.id === "native-local-commit-recovery"
  );
  return nativeRecoveryWarnings.length === 1
    && nativeRecoveryWarnings[0]?.id === receipt.warningId
    && nativeRecoveryWarnings[0]?.message === receipt.message;
}

const NATIVE_CLEANUP_RECOVERY_ERROR_PREFIX = "自动维护结果已保存；";
const NATIVE_CLEANUP_RECOVERY_SUMMARY_PROJECTION =
  "Native Execution 清理待恢复，不影响已保存的维护结果。";

function appendNativeLifecycleRecoveryProjection(
  previous: string,
  warning: string
): string {
  const normalized = previous.trim();
  if (!normalized) return warning;
  if (normalized.includes(warning)) return normalized;
  return `${normalized}；${warning}`;
}

export async function snapshotMaintenanceWorkflowFileCas(
  rootPathInput: string,
  relativePathInput: string
): Promise<MaintenanceWorkflowFileCas> {
  return await snapshotRootRelativeFileCas(
    rootPathInput,
    relativePathInput,
    "CAS target"
  );
}

async function snapshotRootRelativeFileCas(
  rootPathInput: string,
  relativePathInput: string,
  label: string,
  allowedLinkCounts: readonly number[] = [1]
): Promise<MaintenanceWorkflowFileCas> {
  const rootPath = await ensurePlainDirectory(rootPathInput, `${label} root`);
  const relativePath = normalizeRelativePath(relativePathInput);
  const chain = await captureSafeDirectoryChain(
    rootPath,
    path.posix.dirname(relativePath)
  );
  if (!chain.complete) return { kind: "missing" };
  await assertSafeDirectoryChainUnchanged(chain);
  const result = await snapshotAbsoluteFileCas(
    resolveInsideRoot(rootPath, relativePath),
    allowedLinkCounts
  );
  await assertSafeDirectoryChainUnchanged(chain);
  return result;
}

async function snapshotAbsoluteFileCas(
  absolutePath: string,
  allowedLinkCounts: readonly number[] = [1]
): Promise<MaintenanceWorkflowFileCas> {
  for (let attempt = 0; attempt < FILE_CAS_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    const pathBefore = await lstatOrNull(absolutePath);
    if (!pathBefore) return { kind: "missing" };
    if (
      !pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || !allowedLinkCounts.includes(pathBefore.nlink)
    ) {
      throw new MaintenanceWorkflowWalError(
        "unsafe_entry",
        `CAS 目标不是独立普通文件：${absolutePath}`
      );
    }
    const handle = await fsp.open(
      absolutePath,
      fsConstants.O_RDONLY | noFollowFlag()
    );
    let snapshot: MaintenanceWorkflowFileCas | undefined;
    try {
      const before = await handle.stat();
      assertSafeRegularStat(before, absolutePath, allowedLinkCounts);
      if (before.size > MAX_BLOB_BYTES) {
        throw new MaintenanceWorkflowWalError(
          "blob_corrupt",
          `CAS 文件过大：${absolutePath}`
        );
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      const pathAfter = await lstatOrNull(absolutePath);
      if (
        sameOpenFileVersion(pathBefore, before)
        && sameOpenFileVersion(before, after)
        && pathAfter
        && sameOpenFileVersion(after, pathAfter)
        && content.byteLength === before.size
      ) {
        snapshot = {
          kind: "file",
          sha256: sha256(content),
          size: content.byteLength,
          mode: normalizeMode(before.mode)
        };
      }
    } finally {
      await handle.close();
    }
    if (snapshot) return snapshot;
    if (attempt === FILE_CAS_SNAPSHOT_MAX_ATTEMPTS - 1) break;
    await new Promise<void>((resolve) => {
      const delayMs = FILE_CAS_SNAPSHOT_RETRY_DELAY_MS * (attempt + 1);
      if (typeof window === "undefined") {
        nodeSetTimeout(resolve, delayMs);
      } else {
        window.setTimeout(resolve, delayMs);
      }
    });
  }
  throw new MaintenanceWorkflowWalError(
    "managed_cas_conflict",
    `读取 CAS 时文件持续变化：${absolutePath}`
  );
}

type ManagedMetadataSuccessorPolicy = NonNullable<
  MaintenanceWorkflowManagedApplyJournal["metadataSuccessorPolicy"]
>;

function managedMetadataSuccessorPolicyForWrite(
  journal: MaintenanceWorkflowManagedApplyJournal,
  relativePathInput: string
): ManagedMetadataSuccessorPolicy | undefined {
  const policy = journal.metadataSuccessorPolicy;
  if (!policy) return undefined;
  const relativePath = normalizeRelativePath(relativePathInput);
  const installWindow = journal.metadataSuccessorInstallWindows?.find(
    (entry) => normalizeRelativePath(entry.relativePath) === relativePath
  );
  return installWindow
    ? { ...policy, window: { ...installWindow.window } }
    : policy;
}

function managedMetadataSuccessorPolicyFor(
  intent: MaintenanceWorkflowWalIntent
): ManagedMetadataSuccessorPolicy {
  const terminalAt = intent.settings.targetTerminal.lastRunAt;
  const workflowAnchorMs = Math.max(
    intent.startedAt,
    Number.isFinite(terminalAt) ? terminalAt : intent.startedAt
  );
  if (!Number.isFinite(workflowAnchorMs)) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "managed metadata successor 缺少 immutable workflow 时间"
    );
  }
  return {
    version: 1,
    kind: "managed-markdown-updated-only",
    window: {
      lowerBoundMs: workflowAnchorMs,
      upperBoundMs: workflowAnchorMs + MANAGED_METADATA_SUCCESSOR_WINDOW_MS
    }
  };
}

async function ensureManagedJournalMetadataSuccessorPolicy(
  handle: MaintenanceWorkflowWalHandle,
  journal: MaintenanceWorkflowManagedApplyJournal,
  intent: MaintenanceWorkflowWalIntent
): Promise<MaintenanceWorkflowManagedApplyJournal> {
  if (journal.metadataSuccessorPolicy) return journal;
  const policy = managedMetadataSuccessorPolicyFor(intent);
  const upgraded = await updateManagedJournal(
    handle.managedJournalPath,
    journal,
    { metadataSuccessorPolicy: policy }
  );
  await syncDirectory(path.dirname(handle.managedJournalPath));
  const readBack = await readManagedJournalOrNull(handle.managedJournalPath);
  if (
    !readBack
    || readBack.digest !== upgraded.digest
    || stableStringify(readBack.metadataSuccessorPolicy)
      !== stableStringify(policy)
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "legacy managed successor policy durable read-back 失败"
    );
  }
  return readBack;
}

async function prepareManagedJournal(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent
): Promise<MaintenanceWorkflowManagedApplyJournal> {
  const entries = intent.managedWrites.map((write, index) =>
    derivedManagedJournalEntry(intent.workflowRunId, write, index)
  );
  const now = new Date().toISOString();
  const journal = withManagedJournalDigest({
    version: MANAGED_JOURNAL_VERSION,
    workflowRunId: intent.workflowRunId,
    intentDigest: intent.digest,
    state: "prepared",
    entries,
    metadataSuccessorPolicy: managedMetadataSuccessorPolicyFor(intent),
    createdAt: now,
    updatedAt: now
  });
  await writeJsonDurably(handle.managedJournalPath, journal);
  return journal;
}

interface ManagedInstallRecoveryObservation {
  target: MaintenanceWorkflowFileCas;
  installTemp: MaintenanceWorkflowFileCas;
  displaced: MaintenanceWorkflowFileCas;
  targetTempSameIdentity: boolean;
}

async function observeManagedInstallRecovery(
  liveVaultPath: string,
  entry: MaintenanceWorkflowManagedJournalEntry
): Promise<ManagedInstallRecoveryObservation> {
  const targetPath = resolveInsideRoot(liveVaultPath, entry.write.relativePath);
  const installTempPath = entry.installTempRelativePath
    ? resolveInsideRoot(liveVaultPath, entry.installTempRelativePath)
    : null;
  const [targetStat, tempStat] = await Promise.all([
    lstatOrNull(targetPath),
    installTempPath ? lstatOrNull(installTempPath) : Promise.resolve(null)
  ]);
  const targetTempSameIdentity = Boolean(
    targetStat
    && tempStat
    && targetStat.isFile()
    && !targetStat.isSymbolicLink()
    && tempStat.isFile()
    && !tempStat.isSymbolicLink()
    && targetStat.dev === tempStat.dev
    && targetStat.ino === tempStat.ino
  );
  const [target, installTemp, displaced] = await Promise.all([
    snapshotRootRelativeFileCas(
      liveVaultPath,
      entry.write.relativePath,
      "managed recovery lease target",
      targetTempSameIdentity ? [2] : [1]
    ),
    entry.installTempRelativePath
      ? snapshotRootRelativeFileCas(
        liveVaultPath,
        entry.installTempRelativePath,
        "managed recovery lease temp",
        targetTempSameIdentity ? [2] : [1]
      )
      : Promise.resolve<MaintenanceWorkflowFileCas>({ kind: "missing" }),
    entry.displacedLiveRelativePath
      ? snapshotRootRelativeFileCas(
        liveVaultPath,
        entry.displacedLiveRelativePath,
        "managed recovery lease displaced",
        [1, 2]
      )
      : Promise.resolve<MaintenanceWorkflowFileCas>({ kind: "missing" })
  ]);
  return { target, installTemp, displaced, targetTempSameIdentity };
}

function managedInstallRecoveryEligible(
  observation: ManagedInstallRecoveryObservation,
  entry: MaintenanceWorkflowManagedJournalEntry,
  effectiveExpected: MaintenanceWorkflowFileCas,
  effectiveDesired: MaintenanceWorkflowFileCas
): boolean {
  const displacedSafe = observation.displaced.kind === "missing"
    || sameCas(observation.displaced, effectiveExpected);
  const tempMissing = observation.installTemp.kind === "missing";
  const tempExactDesired = sameCas(
    observation.installTemp,
    effectiveDesired
  );
  const stillBaseline = sameCas(observation.target, effectiveExpected)
    && observation.displaced.kind === "missing"
    && (tempMissing || tempExactDesired);
  const readyToInstall = observation.target.kind === "missing"
    && (tempMissing || tempExactDesired)
    && (
      effectiveExpected.kind === "missing"
        ? observation.displaced.kind === "missing"
        : sameCas(observation.displaced, effectiveExpected)
    );
  const unsettledHardlink = observation.targetTempSameIdentity
    && observation.target.kind === "file"
    && observation.installTemp.kind === "file"
    && displacedSafe;
  const unsettledAtomicReplace = tempExactDesired
    && observation.target.kind === "file"
    && displacedSafe;
  const installedWithRecoveryBaseline = tempMissing
    && observation.target.kind === "file"
    && effectiveExpected.kind === "file"
    && sameCas(observation.displaced, effectiveExpected);
  return stillBaseline
    || readyToInstall
    || unsettledHardlink
    || unsettledAtomicReplace
    || installedWithRecoveryBaseline;
}

function managedMetadataLeaseDigest(
  lease: Omit<MaintenanceWorkflowManagedMetadataSuccessorLease, "digest">
): string {
  return digestJson(lease);
}

async function persistManagedMetadataSuccessorLease(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  entry: MaintenanceWorkflowManagedJournalEntry,
  observation: ManagedInstallRecoveryObservation,
  journal: MaintenanceWorkflowManagedApplyJournal
): Promise<MaintenanceWorkflowWalState> {
  return await withWalStateLock(handle, async () => {
    const loaded = await loadMaintenanceWorkflowWal(handle);
    if (loaded.state.phase !== "shadow_committed") {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `managed recovery lease 只能写入 shadow_committed：${loaded.state.phase}`
      );
    }
    const now = Date.now();
    const relativePath = normalizeRelativePath(entry.write.relativePath);
    const existing = [...(loaded.state.managedMetadataSuccessorLeases ?? [])]
      .filter((lease) => normalizeRelativePath(lease.relativePath) === relativePath)
      .sort((left, right) => right.window.upperBoundMs - left.window.upperBoundMs)[0];
    if (existing && existing.window.upperBoundMs >= now) return loaded.state;
    const createdAt = new Date(now).toISOString();
    const policy = managedMetadataSuccessorPolicyFor(intent);
    const leaseWithoutDigest: Omit<
      MaintenanceWorkflowManagedMetadataSuccessorLease,
      "digest"
    > = {
      version: 1,
      relativePath,
      intentDigest: intent.digest,
      entryDigest: digestJson(entry),
      createdAt,
      window: {
        lowerBoundMs: policy.window.lowerBoundMs,
        upperBoundMs: now + MANAGED_METADATA_SUCCESSOR_WINDOW_MS
      },
      provenanceDigest: digestJson(observation)
    };
    const lease: MaintenanceWorkflowManagedMetadataSuccessorLease = {
      ...leaseWithoutDigest,
      digest: managedMetadataLeaseDigest(leaseWithoutDigest)
    };
    const journalLeaseDigests = new Set(
      (journal.metadataSuccessorInstallWindows ?? []).map(
        (window) => window.leaseDigest
      )
    );
    const leases = [
      ...(loaded.state.managedMetadataSuccessorLeases ?? []).filter(
        (candidate) =>
          normalizeRelativePath(candidate.relativePath) !== relativePath
          || journalLeaseDigests.has(candidate.digest)
      ),
      lease
    ].sort((left, right) => {
      const pathOrder = compareCanonicalText(left.relativePath, right.relativePath);
      if (pathOrder !== 0) return pathOrder;
      return left.window.upperBoundMs - right.window.upperBoundMs;
    });
    return await writeNextWalState(loaded, {
      ...withoutStateDigest(loaded.state),
      sequence: loaded.state.sequence + 1,
      updatedAt: createdAt,
      managedMetadataSuccessorLeases: leases
    });
  });
}

async function ensureManagedJournalInstallWindowForEntry(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  liveVaultPath: string,
  state: MaintenanceWorkflowWalState,
  journal: MaintenanceWorkflowManagedApplyJournal,
  entry: MaintenanceWorkflowManagedJournalEntry,
  effectiveInstall: ManagedEffectiveInstall
): Promise<{
  state: MaintenanceWorkflowWalState;
  journal: MaintenanceWorkflowManagedApplyJournal;
}> {
  assertManagedJournalLeaseBindings(journal, state, intent);
  const relativePath = normalizeRelativePath(entry.write.relativePath);
  const now = Date.now();
  const existingWindow = journal.metadataSuccessorInstallWindows?.find(
    (candidate) => normalizeRelativePath(candidate.relativePath) === relativePath
  );
  const stateLease = [...(state.managedMetadataSuccessorLeases ?? [])]
    .filter((lease) => normalizeRelativePath(lease.relativePath) === relativePath)
    .sort((left, right) => right.window.upperBoundMs - left.window.upperBoundMs)[0];
  if (
    existingWindow
    && stateLease
    && existingWindow.leaseDigest === stateLease.digest
    && stableStringify(existingWindow.window) === stableStringify(stateLease.window)
    && existingWindow.createdAt === stateLease.createdAt
    && existingWindow.window.upperBoundMs >= now
  ) {
    return { state, journal };
  }

  const acceptedBaseline = managedJournalProofsByPath(
    journal.acceptedMetadataBaselines
  ).get(relativePath);
  const effectiveExpected = acceptedBaseline?.result ?? entry.write.expected;
  const observation = await observeManagedInstallRecovery(liveVaultPath, entry);
  if (!managedInstallRecoveryEligible(
    observation,
    entry,
    effectiveExpected,
    effectiveInstall.desired
  )) {
    return { state, journal };
  }

  let durableState = stateLease && stateLease.window.upperBoundMs >= now
    ? state
    : await persistManagedMetadataSuccessorLease(
      handle,
      intent,
      entry,
      observation,
      journal
    );
  const durableLease = [...(durableState.managedMetadataSuccessorLeases ?? [])]
    .filter((lease) => normalizeRelativePath(lease.relativePath) === relativePath)
    .sort((left, right) => right.window.upperBoundMs - left.window.upperBoundMs)[0];
  if (!durableLease) {
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      `managed recovery lease 写后丢失：${relativePath}`,
      relativePath
    );
  }
  const installWindow = {
    relativePath,
    createdAt: durableLease.createdAt,
    window: { ...durableLease.window },
    leaseDigest: durableLease.digest
  };
  const windows = [
    ...(journal.metadataSuccessorInstallWindows ?? []).filter(
      (candidate) => normalizeRelativePath(candidate.relativePath) !== relativePath
    ),
    installWindow
  ].sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
  const updated = await updateManagedJournal(
    handle.managedJournalPath,
    journal,
    { metadataSuccessorInstallWindows: windows }
  );
  await syncDirectory(path.dirname(handle.managedJournalPath));
  const readBack = await readManagedJournalOrNull(handle.managedJournalPath);
  if (!readBack || readBack.digest !== updated.digest) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `managed install window durable read-back 失败：${relativePath}`,
      relativePath
    );
  }
  assertValidManagedJournal(readBack, intent);
  assertManagedJournalLeaseBindings(readBack, durableState, intent);
  const observedAgain = await observeManagedInstallRecovery(liveVaultPath, entry);
  if (!managedInstallRecoveryEligible(
    observedAgain,
    entry,
    effectiveExpected,
    effectiveInstall.desired
  )) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed recovery lease 后 artifact 已变化：${relativePath}`,
      relativePath
    );
  }
  return { state: durableState, journal: readBack };
}

async function managedMetadataSuccessorEvidence(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPath: string,
  write: MaintenanceWorkflowManagedWrite,
  current: MaintenanceWorkflowFileCas,
  policy: ManagedMetadataSuccessorPolicy,
  basis: "expected" | "desired",
  effectiveInstall?: ManagedEffectiveInstall
): Promise<MaintenanceShadowMetadataSuccessorProof | null> {
  return await managedMetadataSuccessorEvidenceAtPath(
    handle,
    liveVaultPath,
    write,
    current,
    policy,
    basis,
    write.relativePath,
    [1],
    effectiveInstall
  );
}

async function managedMetadataSuccessorEvidenceAtPath(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPath: string,
  write: MaintenanceWorkflowManagedWrite,
  current: MaintenanceWorkflowFileCas,
  policy: ManagedMetadataSuccessorPolicy,
  basis: "expected" | "desired",
  currentRelativePathInput: string,
  allowedLinkCounts: readonly number[] = [1],
  effectiveInstall?: ManagedEffectiveInstall
): Promise<MaintenanceShadowMetadataSuccessorProof | null> {
  if (
    write.operation !== "upsert"
    || current.kind !== "file"
    || !["index", "raw-metadata", "report"].includes(write.kind)
  ) return null;
  const baseline = basis === "desired" && effectiveInstall
    ? effectiveInstall.desired
    : basis === "desired" ? write.desired : write.expected;
  if (baseline.kind !== "file") return null;
  const desiredContent = basis === "desired" && effectiveInstall?.content
    ? Buffer.from(effectiveInstall.content)
    : await managedMetadataBaselineContent(handle, write, basis);
  if (!desiredContent) return null;
  const relativePath = normalizeRelativePath(write.relativePath);
  const currentRelativePath = normalizeRelativePath(currentRelativePathInput);
  const parentChain = await captureSafeDirectoryChain(
    liveVaultPath,
    path.posix.dirname(currentRelativePath)
  );
  if (!parentChain.complete) return null;
  const currentContent = await readIndependentRegularFile(
    resolveInsideRoot(liveVaultPath, currentRelativePath),
    `managed metadata ${basis} successor`,
    MAX_BLOB_BYTES,
    allowedLinkCounts
  );
  await assertSafeDirectoryChainUnchanged(parentChain);
  if (
    currentContent.byteLength !== current.size
    || sha256(currentContent) !== current.sha256
  ) return null;

  const evidence = maintenanceMarkdownUpdatedSuccessorEvidence({
    relativePath,
    desiredContent,
    currentContent,
    desiredMode: baseline.mode,
    currentMode: current.mode,
    window: policy.window,
    allowInsertedUpdated:
      basis === "desired"
      && write.kind === "report"
      && maintenanceMarkdownUpdatedMayBeInserted(relativePath),
    allowRawMetadata:
      write.kind === "raw-metadata"
      || write.kind === "index"
  });
  return evidence
    ? {
      relativePath,
      result: current,
      updatedAt: evidence.updatedAt,
      projectionDigest: evidence.projectionDigest
    }
    : null;
}

async function managedMetadataBaselineContent(
  handle: MaintenanceWorkflowWalHandle,
  write: MaintenanceWorkflowManagedWrite,
  basis: "expected" | "desired"
): Promise<Buffer | null> {
  const baseline = basis === "desired" ? write.desired : write.expected;
  if (baseline.kind !== "file" || write.operation !== "upsert") return null;
  const directDigest = basis === "desired"
    ? write.blobDigest
    : write.expectedBlobDigest;
  if (directDigest) {
    if (directDigest !== baseline.sha256) return null;
    const content = await readIndependentRegularFile(
      path.join(handle.blobRootPath, blobFileName(directDigest)),
      `managed metadata ${basis} blob`,
      MAX_BLOB_BYTES
    );
    return content.byteLength === baseline.size
      && sha256(content) === baseline.sha256
      ? content
      : null;
  }
  if (
    basis !== "expected"
    || write.kind !== "raw-metadata"
    || !write.blobDigest
    || write.desired.kind !== "file"
  ) return null;
  const desiredContent = await readIndependentRegularFile(
    path.join(handle.blobRootPath, blobFileName(write.blobDigest)),
    "legacy Raw desired blob",
    MAX_BLOB_BYTES
  );
  for (const candidate of rawUserOwnedContentCandidates(desiredContent)) {
    if (
      candidate.byteLength === baseline.size
      && sha256(candidate) === baseline.sha256
    ) return candidate;
  }
  return null;
}

interface RawMarkdownByteLine {
  start: number;
  end: number;
  text: string;
}

function readRawMarkdownByteLine(
  content: Buffer,
  start: number
): RawMarkdownByteLine | null {
  if (start < 0 || start >= content.length) return null;
  const newlineIndex = content.indexOf(0x0a, start);
  const contentEnd = newlineIndex < 0 ? content.length : newlineIndex;
  const lineEnd = contentEnd > start && content[contentEnd - 1] === 0x0d
    ? contentEnd - 1
    : contentEnd;
  return {
    start,
    end: newlineIndex < 0 ? content.length : newlineIndex + 1,
    text: content.subarray(start, lineEnd).toString("utf8")
  };
}

function rawUserOwnedContentCandidates(content: Buffer): Buffer[] {
  const opening = readRawMarkdownByteLine(content, 0);
  if (!opening || opening.text !== "---") return [Buffer.from(content)];
  let cursor = opening.end;
  let closing: RawMarkdownByteLine | null = null;
  const frontmatterLines: RawMarkdownByteLine[] = [];
  while (cursor < content.length) {
    const line = readRawMarkdownByteLine(content, cursor);
    if (!line) break;
    if (line.text === "---" || line.text === "...") {
      closing = line;
      break;
    }
    frontmatterLines.push(line);
    cursor = line.end;
  }
  if (!closing) return [];
  const kept: Buffer[] = [];
  let skipping = false;
  for (const line of frontmatterLines) {
    const key = rawFrontmatterColumnZeroKey(line.text);
    if (key) {
      skipping = RAW_DIGEST_MANAGED_KEYS.has(key);
      if (!skipping) kept.push(Buffer.from(content.subarray(line.start, line.end)));
    } else if (skipping && /^\s+/.test(line.text)) {
      // Continuation of an EchoInk-owned list field.
    } else {
      skipping = false;
      kept.push(Buffer.from(content.subarray(line.start, line.end)));
    }
  }
  const unmanaged = Buffer.concat(kept);
  const withFrontmatter = Buffer.concat([
    Buffer.from(content.subarray(0, opening.end)),
    unmanaged,
    Buffer.from(content.subarray(closing.start))
  ]);
  const candidates = [withFrontmatter];
  if (unmanaged.length === 0) {
    candidates.push(Buffer.from(content.subarray(closing.end)));
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const digest = sha256(candidate);
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

function rawFrontmatterColumnZeroKey(line: string): string | null {
  const match = line.match(/^([^\s:#\n][^:\n]*):(?:\s|$)/);
  return match?.[1]?.trim() || null;
}

interface ManagedEffectiveInstall {
  desired: MaintenanceWorkflowFileCas;
  content?: Buffer;
  metadataSuccessor?: MaintenanceShadowMetadataSuccessorProof;
}

interface ValidatedRawAcceptedBaseline {
  content: Buffer;
  proof: MaintenanceShadowMetadataSuccessorProof;
}

async function validateRawAcceptedBaselineFromArtifacts(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPath: string,
  journal: MaintenanceWorkflowManagedApplyJournal,
  entry: MaintenanceWorkflowManagedJournalEntry,
  accepted: MaintenanceShadowMetadataSuccessorProof
): Promise<ValidatedRawAcceptedBaseline> {
  const write = entry.write;
  if (
    write.kind !== "raw-metadata"
    || write.expected.kind !== "file"
    || accepted.result.kind !== "file"
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `Raw accepted baseline 类型非法：${write.relativePath}`,
      write.relativePath
    );
  }
  const policy = managedMetadataSuccessorPolicyForWrite(
    journal,
    write.relativePath
  ) ?? journal.metadataSuccessorPolicy;
  if (!policy) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `Raw accepted baseline 缺少 successor policy：${write.relativePath}`,
      write.relativePath
    );
  }
  const expectedContent = await managedMetadataBaselineContent(
    handle,
    write,
    "expected"
  );
  if (!expectedContent) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `Raw accepted baseline 缺少可复验 expected blob：${write.relativePath}`,
      write.relativePath
    );
  }
  const candidatePaths = [
    write.relativePath,
    entry.displacedLiveRelativePath
  ].filter((value): value is string => Boolean(value));
  for (const candidatePath of candidatePaths) {
    const absolutePath = resolveInsideRoot(liveVaultPath, candidatePath);
    const stat = await lstatOrNull(absolutePath);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink)) {
      continue;
    }
    const candidateCas = await snapshotRootRelativeFileCas(
      liveVaultPath,
      candidatePath,
      "Raw accepted baseline artifact",
      [1, 2]
    );
    if (candidateCas.kind !== "file") continue;
    const artifactContent = await readIndependentRegularFile(
      absolutePath,
      "Raw accepted baseline artifact",
      MAX_BLOB_BYTES,
      [1, 2]
    );
    const possibleBaselines = sameCas(candidateCas, accepted.result)
      ? [artifactContent]
      : await rawBaselineCandidatesFromManagedSuccessor(
        handle,
        liveVaultPath,
        write,
        candidatePath,
        candidateCas,
        artifactContent,
        policy,
        accepted
      );
    for (const currentContent of possibleBaselines) {
      const currentCas: MaintenanceWorkflowCasFile = {
        kind: "file",
        sha256: sha256(currentContent),
        size: currentContent.byteLength,
        mode: accepted.result.mode
      };
      if (!sameCas(currentCas, accepted.result)) continue;
      const evidence = maintenanceMarkdownUpdatedSuccessorEvidence({
        relativePath: write.relativePath,
        desiredContent: expectedContent,
        currentContent,
        desiredMode: write.expected.mode,
        currentMode: currentCas.mode,
        window: policy.window,
        allowRawMetadata: true
      });
      const reproved = evidence ? {
        relativePath: normalizeRelativePath(write.relativePath),
        result: currentCas,
        updatedAt: evidence.updatedAt,
        projectionDigest: evidence.projectionDigest
      } : null;
      if (
        reproved
        && stableStringify(reproved) === stableStringify(accepted)
      ) {
        return { content: currentContent, proof: reproved };
      }
    }
  }
  throw new MaintenanceWorkflowWalError(
    "managed_journal_corrupt",
    `Raw accepted baseline 无法从真实 artifact 重证明：${write.relativePath}`,
    write.relativePath
  );
}

async function rawBaselineCandidatesFromManagedSuccessor(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPath: string,
  write: MaintenanceWorkflowManagedWrite,
  candidatePath: string,
  candidateCas: MaintenanceWorkflowCasFile,
  artifactContent: Buffer,
  policy: ManagedMetadataSuccessorPolicy,
  accepted: MaintenanceShadowMetadataSuccessorProof
): Promise<Buffer[]> {
  const desiredProof = await managedMetadataSuccessorEvidenceAtPath(
    handle,
    liveVaultPath,
    write,
    candidateCas,
    policy,
    "desired",
    candidatePath,
    [1, 2]
  );
  if (!desiredProof) return [];
  const result: Buffer[] = [];
  for (const candidate of rawUserOwnedContentCandidates(artifactContent)) {
    result.push(candidate);
    const rewound = rewriteTopLevelUpdatedAt(candidate, accepted.updatedAt);
    if (rewound) result.push(rewound);
  }
  const seen = new Set<string>();
  return result.filter((candidate) => {
    const digest = sha256(candidate);
    if (seen.has(digest)) return false;
    seen.add(digest);
    return true;
  });
}

async function effectiveManagedInstallForEntry(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPath: string,
  journal: MaintenanceWorkflowManagedApplyJournal,
  entry: MaintenanceWorkflowManagedJournalEntry
): Promise<ManagedEffectiveInstall> {
  const write = entry.write;
  const accepted = managedJournalProofsByPath(
    journal.acceptedMetadataBaselines
  ).get(normalizeRelativePath(write.relativePath));
  if (
    !accepted
    || write.kind !== "raw-metadata"
    || write.operation !== "upsert"
    || write.desired.kind !== "file"
  ) return { desired: write.desired };
  const validated = await validateRawAcceptedBaselineFromArtifacts(
    handle,
    liveVaultPath,
    journal,
    entry,
    accepted
  );
  const desiredContent = await managedMetadataBaselineContent(
    handle,
    write,
    "desired"
  );
  if (!desiredContent) {
    throw new MaintenanceWorkflowWalError(
      "blob_corrupt",
      `Raw carry-forward 缺少 desired blob：${write.relativePath}`,
      write.relativePath
    );
  }
  const carriedContent = carryForwardTopLevelUpdated(
    desiredContent,
    validated.content,
    write.relativePath
  );
  const carried: MaintenanceWorkflowCasFile = {
    kind: "file",
    sha256: sha256(carriedContent),
    size: carriedContent.byteLength,
    mode: write.desired.mode
  };
  const policy = managedMetadataSuccessorPolicyForWrite(
    journal,
    write.relativePath
  ) ?? journal.metadataSuccessorPolicy;
  if (!policy) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `Raw carry-forward 缺少 successor policy：${write.relativePath}`,
      write.relativePath
    );
  }
  const evidence = maintenanceMarkdownUpdatedSuccessorEvidence({
    relativePath: write.relativePath,
    desiredContent,
    currentContent: carriedContent,
    desiredMode: write.desired.mode,
    currentMode: carried.mode,
    window: policy.window,
    allowRawMetadata: true
  });
  if (!evidence || evidence.updatedAt !== validated.proof.updatedAt) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `Raw carry-forward 无法证明 updated 单调前进：${write.relativePath}`,
      write.relativePath
    );
  }
  return {
    desired: carried,
    content: carriedContent,
    metadataSuccessor: {
      relativePath: normalizeRelativePath(write.relativePath),
      result: carried,
      updatedAt: evidence.updatedAt,
      projectionDigest: evidence.projectionDigest
    }
  };
}

function carryForwardTopLevelUpdated(
  desiredContent: Buffer,
  acceptedContent: Buffer,
  relativePath: string
): Buffer {
  const desired = topLevelUpdatedScalar(desiredContent);
  const accepted = topLevelUpdatedScalar(acceptedContent);
  if (!desired || !accepted) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `Raw carry-forward 缺少唯一顶层 updated：${relativePath}`,
      relativePath
    );
  }
  const desiredText = desiredContent.toString("utf8");
  const carried = [
    desiredText.slice(0, desired.valueStart),
    accepted.value,
    desiredText.slice(desired.valueEnd)
  ].join("");
  return Buffer.from(carried, "utf8");
}

function topLevelUpdatedScalar(content: Buffer): {
  value: string;
  valueStart: number;
  valueEnd: number;
} | null {
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) return null;
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  if (!lines.length || !/^---\r?\n$/.test(lines[0])) return null;
  let offset = lines[0].length;
  let result: { value: string; valueStart: number; valueEnd: number } | null = null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^(?:---|\.\.\.)\r?\n$/.test(line)) return result;
    const match = line.match(
      /^((?:updated|["']updated["'])\s*:\s*)(.*?)([ \t]*)(\r?\n)$/i
    );
    if (match) {
      if (result) return null;
      const value = match[2] ?? "";
      const valueStart = offset + (match[1]?.length ?? 0);
      result = { value, valueStart, valueEnd: valueStart + value.length };
    }
    offset += line.length;
  }
  return null;
}

function rewriteTopLevelUpdatedAt(
  content: Buffer,
  updatedAt: number
): Buffer | null {
  const scalar = topLevelUpdatedScalar(content);
  if (!scalar) return null;
  const formatted = formatUpdatedScalarAt(scalar.value, updatedAt);
  if (!formatted) return null;
  const text = content.toString("utf8");
  return Buffer.from([
    text.slice(0, scalar.valueStart),
    formatted,
    text.slice(scalar.valueEnd)
  ].join(""), "utf8");
}

function formatUpdatedScalarAt(templateValue: string, updatedAt: number): string | null {
  const raw = templateValue.trim();
  const quoted = raw.match(/^(?:"([^"]*)"|'([^']*)')$/);
  const quote = quoted ? (raw.startsWith("\"") ? "\"" : "'") : "";
  const timestamp = quoted ? (quoted[1] ?? quoted[2] ?? "") : raw;
  const match = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))?$/
  );
  if (!match || !Number.isFinite(updatedAt)) return null;
  const zone = match[8];
  let shifted = new Date(updatedAt);
  let useUtc = false;
  if (zone) {
    useUtc = true;
    if (zone !== "Z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const offsetMinutes = sign * (
        Number(match[9]) * 60 + Number(match[10])
      );
      shifted = new Date(updatedAt + offsetMinutes * 60_000);
    }
  }
  const component = (utc: number, local: number, width = 2) =>
    String(useUtc ? utc : local).padStart(width, "0");
  const year = component(
    shifted.getUTCFullYear(),
    shifted.getFullYear(),
    4
  );
  const month = component(
    shifted.getUTCMonth() + 1,
    shifted.getMonth() + 1
  );
  const day = component(shifted.getUTCDate(), shifted.getDate());
  const hour = component(shifted.getUTCHours(), shifted.getHours());
  const minute = component(shifted.getUTCMinutes(), shifted.getMinutes());
  let next = `${year}-${month}-${day}T${hour}:${minute}`;
  if (match[6] !== undefined) {
    next += `:${component(shifted.getUTCSeconds(), shifted.getSeconds())}`;
    if (match[7] !== undefined) {
      next += `.${component(
        shifted.getUTCMilliseconds(),
        shifted.getMilliseconds(),
        3
      ).slice(0, match[7].length)}`;
    }
  }
  next += zone ?? "";
  if (Date.parse(next) !== updatedAt) return null;
  return quote ? `${quote}${next}${quote}` : next;
}

function managedJournalProofsByPath(
  proofs: readonly MaintenanceShadowMetadataSuccessorProof[] | undefined
): Map<string, MaintenanceShadowMetadataSuccessorProof> {
  return new Map((proofs ?? []).map((proof) => [
    normalizeRelativePath(proof.relativePath),
    proof
  ]));
}

function managedMetadataSuccessorTransition(
  previous: MaintenanceShadowMetadataSuccessorProof,
  next: MaintenanceShadowMetadataSuccessorProof,
  relativePathInput: string
): "same" | "advance" {
  const relativePath = normalizeRelativePath(relativePathInput);
  if (stableStringify(previous) === stableStringify(next)) return "same";
  if (
    normalizeRelativePath(previous.relativePath) !== relativePath
    || normalizeRelativePath(next.relativePath) !== relativePath
    || previous.result.kind !== "file"
    || next.result.kind !== "file"
    || next.updatedAt <= previous.updatedAt
    || next.projectionDigest !== previous.projectionDigest
    || next.result.mode !== previous.result.mode
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed metadata successor 不得倒退或改变投影：${relativePath}`,
      relativePath
    );
  }
  return "advance";
}

function shadowAcceptedBaselineProof(
  state: MaintenanceWorkflowWalState,
  write: MaintenanceWorkflowManagedWrite,
  current: MaintenanceWorkflowFileCas
): MaintenanceShadowMetadataSuccessorProof | null {
  const target = state.shadowCommitProof?.liveTargets.find(
    (candidate) => normalizeRelativePath(candidate.relativePath)
      === normalizeRelativePath(write.relativePath)
  );
  if (
    !target?.metadataSuccessor
    || !sameCas(target.result, write.expected)
    || !sameCas(target.observedResult ?? target.result, current)
    || !sameCas(target.metadataSuccessor.result, current)
  ) return null;
  return cloneJson(target.metadataSuccessor);
}

async function preflightManagedJournal(
  liveVaultPath: string,
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  state: MaintenanceWorkflowWalState,
  journal: MaintenanceWorkflowManagedApplyJournal
): Promise<{
  state: MaintenanceWorkflowWalState;
  journal: MaintenanceWorkflowManagedApplyJournal;
}> {
  const policy = journal.metadataSuccessorPolicy;
  if (!policy) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "managed preflight 缺少固定 metadata successor policy"
    );
  }
  const acceptedByPath = managedJournalProofsByPath(
    journal.acceptedMetadataBaselines
  );
  const resultSuccessorsByPath = managedJournalProofsByPath(
    journal.metadataSuccessors
  );
  let proofsChanged = false;
  let resultProofsChanged = false;
  let workflowState = state;
  assertManagedJournalLeaseBindings(journal, workflowState, intent);
  for (const entry of journal.entries) {
    const relativePath = normalizeRelativePath(entry.write.relativePath);
    let acceptedBaseline = acceptedByPath.get(relativePath);
    let effectiveExpected = acceptedBaseline?.result ?? entry.write.expected;
    if (acceptedBaseline) {
      const shadowProof = shadowAcceptedBaselineProof(
        workflowState,
        entry.write,
        acceptedBaseline.result
      );
      if (
        (!shadowProof
          || stableStringify(shadowProof)
            !== stableStringify(acceptedBaseline))
        && entry.write.kind !== "raw-metadata"
      ) {
        throw new MaintenanceWorkflowWalError(
          "managed_journal_corrupt",
          `managed accepted baseline 缺少 Shadow/Raw authority：${relativePath}`,
          relativePath
        );
      }
    }
    let effectiveInstall = await effectiveManagedInstallForEntry(
      handle,
      liveVaultPath,
      journal,
      entry
    );
    const lease = await ensureManagedJournalInstallWindowForEntry(
      handle,
      intent,
      liveVaultPath,
      workflowState,
      journal,
      entry,
      effectiveInstall
    );
    journal = lease.journal;
    workflowState = lease.state;
    const relativeDirectory = path.posix.dirname(entry.write.relativePath);
    const chain = await captureSafeDirectoryChain(
      liveVaultPath,
      relativeDirectory
    );
    if (chain.complete) {
      await assertSafeDirectoryChainUnchanged(chain);
    }
    const targetPath = resolveInsideRoot(liveVaultPath, entry.write.relativePath);
    const installTempPath = entry.installTempRelativePath
      ? resolveInsideRoot(liveVaultPath, entry.installTempRelativePath)
      : null;
    const displacedPath = entry.displacedLiveRelativePath
      ? resolveInsideRoot(liveVaultPath, entry.displacedLiveRelativePath)
      : null;
    if (installTempPath) {
      await repairManagedExclusiveInstallLink(
        liveVaultPath,
        handle,
        journal,
        entry.write,
        targetPath,
        installTempPath,
        effectiveInstall
      );
    }
    if (displacedPath && entry.write.expected.kind === "file") {
      await repairExclusiveDisplacementLink(
        targetPath,
        displacedPath,
        effectiveExpected.kind === "file"
          ? effectiveExpected
          : entry.write.expected
      );
    }
    const [target, installTemp, displaced] = await Promise.all([
      snapshotRootRelativeFileCas(
        liveVaultPath,
        entry.write.relativePath,
        "managed preflight target"
      ),
      installTempPath
        ? snapshotManagedCleanupAwareArtifactCas(
          liveVaultPath,
          entry.installTempRelativePath!,
          "managed preflight install"
        )
        : Promise.resolve<MaintenanceWorkflowFileCas>({ kind: "missing" }),
      displacedPath
        ? snapshotManagedCleanupAwareArtifactCas(
          liveVaultPath,
          entry.displacedLiveRelativePath!,
          "managed preflight displaced"
        )
        : Promise.resolve<MaintenanceWorkflowFileCas>({ kind: "missing" })
    ]);
    if (chain.complete) {
      await assertSafeDirectoryChainUnchanged(chain);
    }
    if (
      installTemp.kind !== "missing"
      && !sameCas(installTemp, effectiveInstall.desired)
    ) {
      throw managedCasConflict(
        entry.write.relativePath,
        installTemp,
        { kind: "missing" },
        effectiveInstall.desired
      );
    }
    if (
      displaced.kind !== "missing"
      && !sameCas(displaced, effectiveExpected)
    ) {
      throw managedCasConflict(
        entry.write.relativePath,
        displaced,
        effectiveExpected,
        entry.write.desired
      );
    }
    if (
      !acceptedBaseline
      && displaced.kind === "missing"
      && installTemp.kind === "missing"
      && !sameCas(target, entry.write.expected)
      && !sameCas(target, entry.write.desired)
    ) {
      const proof = shadowAcceptedBaselineProof(
        workflowState,
        entry.write,
        target
      ) ?? await managedMetadataSuccessorEvidence(
        handle,
        liveVaultPath,
        entry.write,
        target,
        managedMetadataSuccessorPolicyForWrite(journal, relativePath)
          ?? policy,
        "expected"
      );
      if (proof) {
        acceptedBaseline = proof;
        acceptedByPath.set(relativePath, proof);
        effectiveExpected = proof.result;
        proofsChanged = true;
        if (entry.write.kind === "raw-metadata") {
          const provisionalJournal: MaintenanceWorkflowManagedApplyJournal = {
            ...journal,
            acceptedMetadataBaselines: [...acceptedByPath.values()]
          };
          effectiveInstall = await effectiveManagedInstallForEntry(
            handle,
            liveVaultPath,
            provisionalJournal,
            entry
          );
        }
      }
    }
    let resultSuccessor = resultSuccessorsByPath.get(relativePath);
    const currentResultSuccessor = sameCas(
      target,
      effectiveInstall.desired
    )
      ? effectiveInstall.metadataSuccessor
      : await managedMetadataSuccessorEvidence(
        handle,
        liveVaultPath,
        entry.write,
        target,
        managedMetadataSuccessorPolicyForWrite(journal, relativePath)
          ?? policy,
        "desired",
        effectiveInstall
      );
    if (currentResultSuccessor) {
      const transition = resultSuccessor
        ? managedMetadataSuccessorTransition(
          resultSuccessor,
          currentResultSuccessor,
          relativePath
        )
        : "advance";
      if (!resultSuccessor || transition === "advance") {
        resultSuccessor = currentResultSuccessor;
        resultSuccessorsByPath.set(relativePath, currentResultSuccessor);
        resultProofsChanged = true;
      }
    } else if (resultSuccessor) {
        throw new MaintenanceWorkflowWalError(
          "managed_cas_conflict",
          `managed durable result successor 不再匹配 live target：${relativePath}`,
          relativePath
        );
    }
    const isBaseline =
      sameCas(target, effectiveExpected)
      && displaced.kind === "missing";
    const isDisplaced =
      target.kind === "missing"
      && effectiveExpected.kind === "file"
      && sameCas(displaced, effectiveExpected);
    const isInstalled =
      (
        sameCas(target, effectiveInstall.desired)
        || Boolean(
          resultSuccessor
          && sameCas(target, resultSuccessor.result)
        )
      )
      && (
        displaced.kind === "missing"
        || sameCas(displaced, effectiveExpected)
      );
    if (!isBaseline && !isDisplaced && !isInstalled) {
      throw managedCasConflict(
        entry.write.relativePath,
        target,
        effectiveExpected,
        entry.write.desired
      );
    }
  }
  if (proofsChanged || resultProofsChanged) {
    journal = await updateManagedJournal(
      handle.managedJournalPath,
      journal,
      {
        ...(proofsChanged ? {
          acceptedMetadataBaselines: [...acceptedByPath.values()].sort(
            (left, right) => compareCanonicalText(
              left.relativePath,
              right.relativePath
            )
          )
        } : {}),
        ...(resultProofsChanged ? {
          metadataSuccessors: [...resultSuccessorsByPath.values()].sort(
            (left, right) => compareCanonicalText(
              left.relativePath,
              right.relativePath
            )
          )
        } : {})
      }
    );
    await syncDirectory(path.dirname(handle.managedJournalPath));
    const readBack = await readManagedJournalOrNull(
      handle.managedJournalPath
    );
    if (!readBack || readBack.digest !== journal.digest) {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        "managed accepted baseline durable read-back 失败"
      );
    }
    journal = readBack;
  }
  if (proofsChanged) {
    // A newly accepted baseline (notably Raw updated T1) changes both the
    // effective expected CAS and the bytes that will be installed. Acquire
    // the per-entry recovery lease only after that proof is durable, before
    // apply is allowed to mutate live files.
    for (const entry of journal.entries) {
      const effectiveInstall = await effectiveManagedInstallForEntry(
        handle,
        liveVaultPath,
        journal,
        entry
      );
      const lease = await ensureManagedJournalInstallWindowForEntry(
        handle,
        intent,
        liveVaultPath,
        workflowState,
        journal,
        entry,
        effectiveInstall
      );
      workflowState = lease.state;
      journal = lease.journal;
    }
  }
  assertManagedJournalLeaseBindings(journal, workflowState, intent);
  return { state: workflowState, journal };
}

async function snapshotManagedCleanupAwareArtifactCas(
  liveVaultPath: string,
  relativePath: string,
  label: string
): Promise<MaintenanceWorkflowFileCas> {
  const absolutePath = resolveInsideRoot(liveVaultPath, relativePath);
  const quarantinePath = `${absolutePath}.cleanup`;
  const quarantine = await lstatOrNull(quarantinePath);
  if (!quarantine) {
    return await snapshotRootRelativeFileCas(
      liveVaultPath,
      relativePath,
      label
    );
  }
  if (!quarantine.isFile() || quarantine.isSymbolicLink()) {
    throw new MaintenanceWorkflowWalError(
      "unsafe_entry",
      `${label} cleanup quarantine 不安全：${relativePath}`,
      relativePath
    );
  }
  const source = await lstatOrNull(absolutePath);
  if (!source) {
    return await snapshotAbsoluteFileCas(quarantinePath);
  }
  if (
    !source.isFile()
    || source.isSymbolicLink()
    || source.dev !== quarantine.dev
    || source.ino !== quarantine.ino
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `${label} cleanup quarantine 未绑定原 artifact：${relativePath}`,
      relativePath
    );
  }
  return await snapshotAbsoluteFileCas(quarantinePath, [2]);
}

async function applyManagedJournalEntry(
  liveVaultPath: string,
  handle: MaintenanceWorkflowWalHandle,
  journal: MaintenanceWorkflowManagedApplyJournal,
  entry: MaintenanceWorkflowManagedJournalEntry,
  index: number,
  options: ApplyMaintenanceWorkflowManagedWritesOptions
): Promise<void> {
  const write = entry.write;
  const acceptedBaseline = managedJournalProofsByPath(
    journal.acceptedMetadataBaselines
  ).get(normalizeRelativePath(write.relativePath));
  const durableResultSuccessor = managedJournalProofsByPath(
    journal.metadataSuccessors
  ).get(normalizeRelativePath(write.relativePath));
  const effectiveExpected = acceptedBaseline?.result ?? write.expected;
  const effectiveInstall = await effectiveManagedInstallForEntry(
    handle,
    liveVaultPath,
    journal,
    entry
  );
  await ensureSafeParentDirectory(liveVaultPath, path.posix.dirname(write.relativePath));
  const parentChain = await captureSafeDirectoryChain(
    liveVaultPath,
    path.posix.dirname(write.relativePath)
  );
  if (!parentChain.complete) {
    throw new MaintenanceWorkflowWalError(
      "unsafe_entry",
      `managed parent 创建后仍不存在：${write.relativePath}`,
      write.relativePath
    );
  }
  await assertSafeDirectoryChainUnchanged(parentChain);
  const targetPath = resolveInsideRoot(liveVaultPath, write.relativePath);
  const installTempPath = entry.installTempRelativePath
    ? resolveInsideRoot(liveVaultPath, entry.installTempRelativePath)
    : null;
  const displacedPath = entry.displacedLiveRelativePath
    ? resolveInsideRoot(liveVaultPath, entry.displacedLiveRelativePath)
    : null;
  if (installTempPath) {
    await repairManagedExclusiveInstallLink(
      liveVaultPath,
      handle,
      journal,
      write,
      targetPath,
      installTempPath,
      effectiveInstall,
      async () => {
        await options.faultInjector?.({
          point: "before-install-temp-unlink",
          index,
          relativePath: write.relativePath
        });
      }
    );
    await assertSafeDirectoryChainUnchanged(parentChain);
  }
  if (displacedPath && effectiveExpected.kind === "file") {
    await repairExclusiveDisplacementLink(
      targetPath,
      displacedPath,
      effectiveExpected
    );
    await assertSafeDirectoryChainUnchanged(parentChain);
  }

  let current = await snapshotRootRelativeFileCas(
    liveVaultPath,
    write.relativePath,
    "managed apply target"
  );
  if (sameCas(current, effectiveInstall.desired)) {
    return;
  }
  const writeMetadataSuccessorPolicy =
    managedMetadataSuccessorPolicyForWrite(journal, write.relativePath);
  if (writeMetadataSuccessorPolicy) {
    const currentResultSuccessor = await managedMetadataSuccessorEvidence(
      handle,
      liveVaultPath,
      write,
      current,
      writeMetadataSuccessorPolicy,
      "desired",
      effectiveInstall
    );
    if (
      currentResultSuccessor
      && (
        !durableResultSuccessor
        || managedMetadataSuccessorTransition(
          durableResultSuccessor,
          currentResultSuccessor,
          write.relativePath
        )
      )
    ) return;
  }

  if (effectiveExpected.kind === "file") {
    if (!displacedPath) {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        `managed journal 缺少 displaced path：${write.relativePath}`
      );
    }
    let displaced = await snapshotRootRelativeFileCas(
      liveVaultPath,
      entry.displacedLiveRelativePath!,
      "managed apply displaced"
    );
    if (displaced.kind === "missing") {
      if (!sameCas(current, effectiveExpected)) {
        throw managedCasConflict(write.relativePath, current, effectiveExpected, effectiveInstall.desired);
      }
      await displaceLiveFileNoClobber(
        targetPath,
        displacedPath,
        effectiveExpected,
        parentChain
      );
      await options.faultInjector?.({
        point: "after-displace",
        index,
        relativePath: write.relativePath
      });
      displaced = await snapshotRootRelativeFileCas(
        liveVaultPath,
        entry.displacedLiveRelativePath!,
        "managed displaced readback"
      );
      current = await snapshotRootRelativeFileCas(
        liveVaultPath,
        write.relativePath,
        "managed target readback"
      );
    }
    if (!sameCas(displaced, effectiveExpected) || current.kind !== "missing") {
      throw managedCasConflict(write.relativePath, current, effectiveExpected, effectiveInstall.desired);
    }
  } else if (!sameCas(current, effectiveExpected)) {
    throw managedCasConflict(write.relativePath, current, effectiveExpected, effectiveInstall.desired);
  }

  if (write.operation === "delete") {
    await options.faultInjector?.({
      point: "after-install",
      index,
      relativePath: write.relativePath
    });
  } else {
    if (!installTempPath || !write.blobDigest || effectiveInstall.desired.kind !== "file") {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        `managed upsert 缺少安装证据：${write.relativePath}`
      );
    }
    await prepareInstallArtifact(
      path.join(handle.blobRootPath, blobFileName(write.blobDigest)),
      installTempPath,
      effectiveInstall.desired,
      effectiveInstall.content
    );
    await assertSafeDirectoryChainUnchanged(parentChain);
    try {
      await fsp.link(installTempPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const installed = await snapshotRootRelativeFileCas(
        liveVaultPath,
        write.relativePath,
        "managed concurrent install"
      );
      if (!sameCas(installed, effectiveInstall.desired)) {
        throw managedCasConflict(write.relativePath, installed, effectiveExpected, effectiveInstall.desired);
      }
    }
    await syncDirectory(path.dirname(targetPath));
    await assertSafeDirectoryChainUnchanged(parentChain);
    await options.faultInjector?.({
      point: "after-install",
      index,
      relativePath: write.relativePath
    });
    await repairManagedExclusiveInstallLink(
      liveVaultPath,
      handle,
      journal,
      write,
      targetPath,
      installTempPath,
      effectiveInstall,
      async () => {
        await options.faultInjector?.({
          point: "before-install-temp-unlink",
          index,
          relativePath: write.relativePath
        });
      }
    );
    await assertSafeDirectoryChainUnchanged(parentChain);
  }
  const installed = await snapshotRootRelativeFileCas(
    liveVaultPath,
    write.relativePath,
    "managed installed target"
  );
  if (sameCas(installed, effectiveInstall.desired)) return;
  const installedSuccessor = writeMetadataSuccessorPolicy
    ? await managedMetadataSuccessorEvidence(
      handle,
      liveVaultPath,
      write,
      installed,
      writeMetadataSuccessorPolicy,
      "desired",
      effectiveInstall
    )
    : null;
  if (!installedSuccessor) {
    throw managedCasConflict(
      write.relativePath,
      installed,
      effectiveExpected,
      effectiveInstall.desired
    );
  }
}

async function displaceLiveFileNoClobber(
  targetPath: string,
  displacedPath: string,
  expected: MaintenanceWorkflowCasFile,
  parentChain: SafeDirectoryChain
): Promise<void> {
  await assertSafeDirectoryChainUnchanged(parentChain);
  try {
    await fsp.link(targetPath, displacedPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await syncDirectory(path.dirname(targetPath));
  await assertSafeDirectoryChainUnchanged(parentChain);
  const targetStat = await lstatOrNull(targetPath);
  const displacedStat = await lstatOrNull(displacedPath);
  if (
    !targetStat
    || !displacedStat
    || !targetStat.isFile()
    || targetStat.isSymbolicLink()
    || !displacedStat.isFile()
    || displacedStat.isSymbolicLink()
    || targetStat.dev !== displacedStat.dev
    || targetStat.ino !== displacedStat.ino
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed displacement 拒绝覆盖既有备份：${displacedPath}`
    );
  }
  const linked = await snapshotAbsoluteFileCas(displacedPath, [1, 2]);
  if (!sameCas(linked, expected)) {
    throw managedCasConflict(displacedPath, linked, expected, { kind: "missing" });
  }
  await assertSafeDirectoryChainUnchanged(parentChain);
  const targetBeforeUnlink = await lstatOrNull(targetPath);
  const displacedBeforeUnlink = await lstatOrNull(displacedPath);
  if (
    !targetBeforeUnlink
    || !displacedBeforeUnlink
    || targetBeforeUnlink.dev !== displacedBeforeUnlink.dev
    || targetBeforeUnlink.ino !== displacedBeforeUnlink.ino
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed displacement unlink 前 inode 已变化：${targetPath}`
    );
  }
  await fsp.unlink(targetPath);
  await syncDirectory(path.dirname(targetPath));
  await assertSafeDirectoryChainUnchanged(parentChain);
  const displaced = await snapshotAbsoluteFileCas(displacedPath);
  if (!sameCas(displaced, expected)) {
    throw managedCasConflict(displacedPath, displaced, expected, { kind: "missing" });
  }
}

async function repairExclusiveDisplacementLink(
  targetPath: string,
  displacedPath: string,
  expected: MaintenanceWorkflowCasFile
): Promise<void> {
  const [target, displaced] = await Promise.all([
    lstatOrNull(targetPath),
    lstatOrNull(displacedPath)
  ]);
  if (!target || !displaced) return;
  if (
    !target.isFile()
    || target.isSymbolicLink()
    || !displaced.isFile()
    || displaced.isSymbolicLink()
    || target.dev !== displaced.dev
    || target.ino !== displaced.ino
  ) {
    return;
  }
  const linked = await snapshotAbsoluteFileCas(displacedPath, [1, 2]);
  if (!sameCas(linked, expected)) {
    throw managedCasConflict(displacedPath, linked, expected, { kind: "missing" });
  }
  const targetAgain = await lstatOrNull(targetPath);
  const displacedAgain = await lstatOrNull(displacedPath);
  if (
    !targetAgain
    || !displacedAgain
    || targetAgain.dev !== displacedAgain.dev
    || targetAgain.ino !== displacedAgain.ino
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed displacement repair 前 inode 已变化：${targetPath}`
    );
  }
  await fsp.unlink(targetPath);
  await syncDirectory(path.dirname(targetPath));
}

async function prepareInstallArtifact(
  blobPath: string,
  installTempPath: string,
  desired: MaintenanceWorkflowCasFile,
  contentOverride?: Buffer
): Promise<void> {
  const existingStat = await fsp.lstat(installTempPath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (existingStat) {
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      throw new MaintenanceWorkflowWalError(
        "unsafe_entry",
        `managed install artifact 不安全：${installTempPath}`
      );
    }
    const existing = await snapshotAbsoluteFileCas(installTempPath);
    if (sameCas(existing, desired)) return;
    await fsp.rm(installTempPath, { force: true });
    await syncDirectory(path.dirname(installTempPath));
  }
  const blob = contentOverride
    ? Buffer.from(contentOverride)
    : await readIndependentRegularFile(blobPath, "managed blob", MAX_BLOB_BYTES);
  if (
    sha256(blob) !== desired.sha256
    || blob.byteLength !== desired.size
  ) {
    throw new MaintenanceWorkflowWalError("blob_corrupt", `managed blob 校验失败：${blobPath}`);
  }
  const output = await fsp.open(
    installTempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    desired.mode
  );
  try {
    await output.writeFile(blob);
    await output.chmod(desired.mode);
    await output.sync();
  } finally {
    await output.close();
  }
  await syncDirectory(path.dirname(installTempPath));
}

async function repairManagedExclusiveInstallLink(
  liveVaultPath: string,
  handle: MaintenanceWorkflowWalHandle,
  journal: MaintenanceWorkflowManagedApplyJournal,
  write: MaintenanceWorkflowManagedWrite,
  targetPath: string,
  installTempPath: string,
  effectiveInstall: ManagedEffectiveInstall,
  beforeUnlink: () => void | Promise<void> = () => undefined
): Promise<void> {
  const [target, temp] = await Promise.all([
    fsp.lstat(targetPath).catch((error) => isNotFound(error) ? null : Promise.reject(error)),
    fsp.lstat(installTempPath).catch((error) => isNotFound(error) ? null : Promise.reject(error))
  ]);
  if (!target || !temp) return;
  if (
    !target.isFile()
    || target.isSymbolicLink()
    || !temp.isFile()
    || temp.isSymbolicLink()
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed exclusive install artifact 与目标冲突：${targetPath}`
    );
  }
  const sameIdentity = target.dev === temp.dev && target.ino === temp.ino;
  const tempCas = await snapshotAbsoluteFileCas(
    installTempPath,
    sameIdentity ? [2] : [1]
  );
  const targetCas = await snapshotRootRelativeFileCas(
    liveVaultPath,
    write.relativePath,
    "managed install target settle",
    sameIdentity ? [2] : [1]
  );
  const writePolicy = managedMetadataSuccessorPolicyForWrite(
    journal,
    write.relativePath
  );
  const successor = writePolicy
    ? await managedMetadataSuccessorEvidenceAtPath(
      handle,
      liveVaultPath,
      write,
      targetCas,
      writePolicy,
      "desired",
      write.relativePath,
      sameIdentity ? [2] : [1],
      effectiveInstall
    )
    : null;
  if (
    !(
      sameCas(targetCas, effectiveInstall.desired)
      || successor
    )
    || !(
      sameCas(tempCas, effectiveInstall.desired)
      || (sameIdentity && sameCas(tempCas, targetCas))
    )
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed exclusive install artifact 与目标冲突：${targetPath}`,
      write.relativePath
    );
  }
  await beforeUnlink();
  const [targetAgain, tempAgain] = await Promise.all([
    lstatOrNull(targetPath),
    lstatOrNull(installTempPath)
  ]);
  if (
    !targetAgain
    ||
    !tempAgain
    || !targetAgain.isFile()
    || targetAgain.isSymbolicLink()
    || !tempAgain.isFile()
    || tempAgain.isSymbolicLink()
    || tempAgain.dev !== temp.dev
    || tempAgain.ino !== temp.ino
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed install artifact 清理前 inode 已变化：${write.relativePath}`,
      write.relativePath
    );
  }
  const sameIdentityAgain = targetAgain.dev === tempAgain.dev
    && targetAgain.ino === tempAgain.ino;
  const [targetCasAgain, tempCasAgain] = await Promise.all([
    snapshotRootRelativeFileCas(
      liveVaultPath,
      write.relativePath,
      "managed install target pre-unlink",
      sameIdentityAgain ? [2] : [1]
    ),
    snapshotAbsoluteFileCas(
      installTempPath,
      sameIdentityAgain ? [2] : [1]
    )
  ]);
  const successorAgain = writePolicy
    ? await managedMetadataSuccessorEvidenceAtPath(
      handle,
      liveVaultPath,
      write,
      targetCasAgain,
      writePolicy,
      "desired",
      write.relativePath,
      sameIdentityAgain ? [2] : [1],
      effectiveInstall
    )
    : null;
  if (
    !(
      sameCas(targetCasAgain, effectiveInstall.desired)
      || successorAgain
    )
    || !(
      sameCas(tempCasAgain, effectiveInstall.desired)
      || (sameIdentityAgain && sameCas(tempCasAgain, targetCasAgain))
    )
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed install artifact 清理前 target/temp 已变化：${write.relativePath}`,
      write.relativePath
    );
  }
  await fsp.unlink(installTempPath);
  await syncDirectory(path.dirname(installTempPath));
}

async function cleanupManagedJournalArtifacts(
  liveVaultPath: string,
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  journal: MaintenanceWorkflowManagedApplyJournal,
  options: ApplyMaintenanceWorkflowManagedWritesOptions
): Promise<void> {
  if (journal.state !== "committed") {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      `managed journal 未 committed，禁止清理：${journal.state}`
    );
  }
  await verifyAllManagedTargets(
    liveVaultPath,
    journal.entries.map((entry) => entry.write),
    { handle, intent, managedJournal: journal }
  );
  const acceptedByPath = managedJournalProofsByPath(
    journal.acceptedMetadataBaselines
  );
  for (const [index, entry] of journal.entries.entries()) {
    const effectiveInstall = await effectiveManagedInstallForEntry(
      handle,
      liveVaultPath,
      journal,
      entry
    );
    const parentChain = await captureSafeDirectoryChain(
      liveVaultPath,
      path.posix.dirname(entry.write.relativePath)
    );
    if (!parentChain.complete) {
      throw new MaintenanceWorkflowWalError(
        "unsafe_entry",
        `managed cleanup 父目录缺失：${entry.write.relativePath}`
      );
    }
    for (const relativePath of [
      entry.installTempRelativePath,
      entry.displacedLiveRelativePath
    ]) {
      if (!relativePath) continue;
      await assertSafeDirectoryChainUnchanged(parentChain);
      const absolutePath = resolveInsideRoot(liveVaultPath, relativePath);
      const stat = await fsp.lstat(absolutePath).catch((error) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      const quarantineStat = await fsp.lstat(`${absolutePath}.cleanup`).catch(
        (error) => {
          if (isNotFound(error)) return null;
          throw error;
        }
      );
      if (!stat && !quarantineStat) continue;
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
        throw new MaintenanceWorkflowWalError(
          "unsafe_entry",
          `managed journal artifact 不安全：${relativePath}`,
          relativePath
        );
      }
      if (
        quarantineStat
        && (!quarantineStat.isFile() || quarantineStat.isSymbolicLink())
      ) {
        throw new MaintenanceWorkflowWalError(
          "unsafe_entry",
          `managed journal quarantine 不安全：${relativePath}`,
          relativePath
        );
      }
      const expected = relativePath === entry.installTempRelativePath
        ? effectiveInstall.desired
        : acceptedByPath.get(
          normalizeRelativePath(entry.write.relativePath)
        )?.result ?? entry.write.expected;
      await removeManagedArtifactDurably(
        absolutePath,
        expected,
        relativePath,
        parentChain,
        async () => {
          await options.faultInjector?.({
            point: "after-cleanup-link",
            index,
            relativePath
          });
        }
      );
    }
  }
}

async function removeManagedArtifactDurably(
  absolutePath: string,
  expected: MaintenanceWorkflowFileCas,
  relativePath: string,
  parentChain: SafeDirectoryChain,
  afterCleanupLink: () => void | Promise<void>
): Promise<void> {
  if (expected.kind !== "file") {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      `managed cleanup artifact 缺少 file CAS：${relativePath}`,
      relativePath
    );
  }
  await assertSafeDirectoryChainUnchanged(parentChain);
  const quarantinePath = `${absolutePath}.cleanup`;
  const existingQuarantine = await lstatOrNull(quarantinePath);
  if (existingQuarantine) {
    if (!existingQuarantine.isFile() || existingQuarantine.isSymbolicLink()) {
      throw new MaintenanceWorkflowWalError(
        "unsafe_entry",
        `managed cleanup quarantine 不安全：${relativePath}`,
        relativePath
      );
    }
    const source = await lstatOrNull(absolutePath);
    if (source) {
      if (!source.isFile() || source.isSymbolicLink()) {
        throw new MaintenanceWorkflowWalError(
          "unsafe_entry",
          `managed cleanup artifact 不安全：${relativePath}`,
          relativePath
        );
      }
      if (
        source.dev !== existingQuarantine.dev
        || source.ino !== existingQuarantine.ino
      ) {
        throw new MaintenanceWorkflowWalError(
          "managed_cas_conflict",
          `managed cleanup quarantine 与当前 artifact 不是同一 inode，保留现场：${relativePath}`,
          relativePath
        );
      }
      const linkedCas = await snapshotAbsoluteFileCas(quarantinePath, [2]);
      if (!sameCas(linkedCas, expected)) {
        throw new MaintenanceWorkflowWalError(
          "managed_cas_conflict",
          `managed cleanup linked artifact CAS 冲突，保留现场：${relativePath}`,
          relativePath
        );
      }
      await assertSafeDirectoryChainUnchanged(parentChain);
      const [sourceAgain, quarantineAgain] = await Promise.all([
        lstatOrNull(absolutePath),
        lstatOrNull(quarantinePath)
      ]);
      if (
        !sourceAgain
        || !quarantineAgain
        || sourceAgain.dev !== quarantineAgain.dev
        || sourceAgain.ino !== quarantineAgain.ino
      ) {
        throw new MaintenanceWorkflowWalError(
          "managed_cas_conflict",
          `managed cleanup unlink 前 inode 已变化：${relativePath}`,
          relativePath
        );
      }
      await fsp.unlink(absolutePath);
      await syncDirectory(path.dirname(absolutePath));
      await assertSafeDirectoryChainUnchanged(parentChain);
    }
    const quarantineCas = await snapshotAbsoluteFileCas(quarantinePath);
    if (!sameCas(quarantineCas, expected)) {
      throw new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `managed cleanup quarantine CAS 冲突，保留现场：${relativePath}`,
        relativePath
      );
    }
    await fsp.rm(quarantinePath, { force: true });
    await syncDirectory(path.dirname(quarantinePath));
    await assertSafeDirectoryChainUnchanged(parentChain);
  }
  const stat = await lstatOrNull(absolutePath);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new MaintenanceWorkflowWalError(
      "unsafe_entry",
      `managed cleanup artifact 不安全：${relativePath}`,
      relativePath
    );
  }
  const artifact = await snapshotAbsoluteFileCas(absolutePath);
  if (!sameCas(artifact, expected)) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed journal artifact CAS 冲突，拒绝清理：${relativePath}`,
      relativePath
    );
  }
  try {
    await fsp.link(absolutePath, quarantinePath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed cleanup quarantine 被并发占用：${relativePath}`,
      relativePath
    );
  }
  await syncDirectory(path.dirname(absolutePath));
  await afterCleanupLink();
  await assertSafeDirectoryChainUnchanged(parentChain);
  const [sourceLinked, quarantineLinked] = await Promise.all([
    lstatOrNull(absolutePath),
    lstatOrNull(quarantinePath)
  ]);
  if (
    !sourceLinked
    || !quarantineLinked
    || !sourceLinked.isFile()
    || sourceLinked.isSymbolicLink()
    || !quarantineLinked.isFile()
    || quarantineLinked.isSymbolicLink()
    || sourceLinked.dev !== quarantineLinked.dev
    || sourceLinked.ino !== quarantineLinked.ino
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed cleanup link 未绑定原 artifact，保留现场：${relativePath}`,
      relativePath
    );
  }
  const linkedCas = await snapshotAbsoluteFileCas(quarantinePath, [2]);
  if (!sameCas(linkedCas, expected)) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed cleanup link CAS 冲突，保留现场：${relativePath}`,
      relativePath
    );
  }
  await assertSafeDirectoryChainUnchanged(parentChain);
  const [sourceBeforeUnlink, quarantineBeforeUnlink] = await Promise.all([
    lstatOrNull(absolutePath),
    lstatOrNull(quarantinePath)
  ]);
  if (
    !sourceBeforeUnlink
    || !quarantineBeforeUnlink
    || sourceBeforeUnlink.dev !== quarantineBeforeUnlink.dev
    || sourceBeforeUnlink.ino !== quarantineBeforeUnlink.ino
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed cleanup unlink 前 inode 已变化：${relativePath}`,
      relativePath
    );
  }
  await fsp.unlink(absolutePath);
  await syncDirectory(path.dirname(absolutePath));
  await assertSafeDirectoryChainUnchanged(parentChain);
  const quarantined = await snapshotAbsoluteFileCas(quarantinePath);
  if (!sameCas(quarantined, expected)) {
    throw new MaintenanceWorkflowWalError(
      "managed_cas_conflict",
      `managed cleanup quarantine 写后 CAS 冲突，保留现场：${relativePath}`,
      relativePath
    );
  }
  await fsp.rm(quarantinePath, { force: true });
  await syncDirectory(path.dirname(quarantinePath));
  await assertSafeDirectoryChainUnchanged(parentChain);
}

interface ManagedTargetVerificationOptions {
  handle?: MaintenanceWorkflowWalHandle;
  intent?: MaintenanceWorkflowWalIntent;
  managedJournal?: MaintenanceWorkflowManagedApplyJournal;
}

async function finalizationManagedTargetVerificationOptions(
  handle: MaintenanceWorkflowWalHandle,
  loaded: LoadedMaintenanceWorkflowWal,
  liveVaultPathInput: string
): Promise<ManagedTargetVerificationOptions> {
  if (
    PHASES.indexOf(loaded.state.phase)
    < PHASES.indexOf("managed_committed")
  ) return {};
  let journal = await readManagedJournalOrNull(handle.managedJournalPath);
  if (!journal) return {};
  assertValidManagedJournal(journal, loaded.intent);
  assertManagedJournalLeaseBindings(journal, loaded.state, loaded.intent);
  journal = await ensureManagedJournalMetadataSuccessorPolicy(
    handle,
    journal,
    loaded.intent
  );
  if (journal.state !== "committed") return {};
  journal = await refreshCommittedManagedMetadataSuccessors(
    handle,
    loaded.intent,
    liveVaultPathInput,
    journal
  );
  return { handle, intent: loaded.intent, managedJournal: journal };
}

async function verifyAllManagedTargets(
  liveVaultPathInput: string,
  writes: readonly MaintenanceWorkflowManagedWrite[],
  options: ManagedTargetVerificationOptions = {}
): Promise<void> {
  const liveVaultPath = await ensurePlainDirectory(liveVaultPathInput, "live Vault");
  const successorByPath = managedJournalProofsByPath(
    options.managedJournal?.metadataSuccessors
  );
  const entryByPath = new Map(
    (options.managedJournal?.entries ?? []).map((entry) => [
      normalizeRelativePath(entry.write.relativePath),
      entry
    ])
  );
  const consumedSuccessors = new Set<string>();
  for (const write of writes) {
    const current = await snapshotRootRelativeFileCas(
      liveVaultPath,
      write.relativePath,
      "managed target verify"
    );
    const relativePath = normalizeRelativePath(write.relativePath);
    const durableSuccessor = successorByPath.get(relativePath);
    let effectiveInstall: ManagedEffectiveInstall = { desired: write.desired };
    if (options.handle && options.managedJournal) {
      const entry = entryByPath.get(relativePath);
      if (!entry) {
        throw new MaintenanceWorkflowWalError(
          "managed_journal_corrupt",
          `managed target 缺少 journal entry：${relativePath}`,
          relativePath
        );
      }
      effectiveInstall = await effectiveManagedInstallForEntry(
        options.handle,
        liveVaultPath,
        options.managedJournal,
        entry
      );
    }
    if (sameCas(current, effectiveInstall.desired)) {
      const effectiveSuccessor = effectiveInstall.metadataSuccessor;
      if (
        durableSuccessor
          ? !effectiveSuccessor
            || stableStringify(durableSuccessor)
              !== stableStringify(effectiveSuccessor)
          : Boolean(effectiveSuccessor)
      ) {
        throw new MaintenanceWorkflowWalError(
          "managed_journal_corrupt",
          `managed effective target 与 durable successor proof 不一致：${relativePath}`,
          relativePath
        );
      }
      if (durableSuccessor) consumedSuccessors.add(relativePath);
      continue;
    }
    if (
      options.handle
      && options.intent
      && options.managedJournal?.metadataSuccessorPolicy
      && durableSuccessor
    ) {
      const currentSuccessor = await managedMetadataSuccessorEvidence(
        options.handle,
        liveVaultPath,
        write,
        current,
        managedMetadataSuccessorPolicyForWrite(
          options.managedJournal,
          relativePath
        )!,
        "desired",
        effectiveInstall
      );
      if (
        currentSuccessor
        && stableStringify(currentSuccessor)
          === stableStringify(durableSuccessor)
      ) {
        consumedSuccessors.add(relativePath);
        continue;
      }
    }
    throw managedCasConflict(write.relativePath, current, write.expected, write.desired);
  }
  if (consumedSuccessors.size !== successorByPath.size) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "managed successor proof 未被当前 live target 完整消费"
    );
  }
}

async function verifyManagedTargetsOrBlock(
  handle: MaintenanceWorkflowWalHandle,
  liveVaultPathInput: string,
  writes: readonly MaintenanceWorkflowManagedWrite[],
  options: ManagedTargetVerificationOptions = {}
): Promise<void> {
  try {
    await verifyAllManagedTargets(liveVaultPathInput, writes, options);
  } catch (error) {
    const normalized = error instanceof MaintenanceWorkflowWalError
      ? error
      : new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `managed target 复验失败：${errorMessage(error)}`
      );
    await markMaintenanceWorkflowWalBlocked(handle, {
      code: normalized.code,
      message: normalized.message
    }).catch(() => undefined);
    throw normalized;
  }
}

async function collectManagedMetadataSuccessors(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  liveVaultPath: string,
  journal: MaintenanceWorkflowManagedApplyJournal
): Promise<MaintenanceShadowMetadataSuccessorProof[]> {
  const policy = journal.metadataSuccessorPolicy;
  if (!policy) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "managed committed proof 缺少固定 successor policy"
    );
  }
  const proofs: MaintenanceShadowMetadataSuccessorProof[] = [];
  const previousByPath = managedJournalProofsByPath(
    journal.metadataSuccessors
  );
  for (const entry of journal.entries) {
    const write = entry.write;
    const relativePath = normalizeRelativePath(write.relativePath);
    const effectiveInstall = await effectiveManagedInstallForEntry(
      handle,
      liveVaultPath,
      journal,
      entry
    );
    const current = await snapshotRootRelativeFileCas(
      liveVaultPath,
      write.relativePath,
      "managed successor collect"
    );
    const proof = sameCas(current, effectiveInstall.desired)
      ? effectiveInstall.metadataSuccessor
      : await managedMetadataSuccessorEvidence(
        handle,
        liveVaultPath,
        write,
        current,
        managedMetadataSuccessorPolicyForWrite(
          journal,
          write.relativePath
        ) ?? policy,
        "desired",
        effectiveInstall
      );
    const previous = previousByPath.get(relativePath);
    if (!proof && previous) {
      throw new MaintenanceWorkflowWalError(
        "managed_cas_conflict",
        `managed metadata successor 回退到旧基线：${relativePath}`,
        relativePath
      );
    }
    if (!proof && !sameCas(current, effectiveInstall.desired)) {
      throw managedCasConflict(
        write.relativePath,
        current,
        write.expected,
        effectiveInstall.desired
      );
    }
    if (!proof) continue;
    if (previous) {
      managedMetadataSuccessorTransition(previous, proof, relativePath);
    }
    proofs.push(proof);
  }
  return proofs.sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
}

async function persistCommittedManagedJournal(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  liveVaultPath: string,
  journal: MaintenanceWorkflowManagedApplyJournal,
  metadataSuccessors: MaintenanceShadowMetadataSuccessorProof[]
): Promise<MaintenanceWorkflowManagedApplyJournal> {
  const committed = await updateManagedJournal(
    handle.managedJournalPath,
    journal,
    {
      state: "committed",
      error: undefined,
      metadataSuccessors
    }
  );
  await syncDirectory(path.dirname(handle.managedJournalPath));
  const readBack = await readManagedJournalOrNull(handle.managedJournalPath);
  if (!readBack || readBack.digest !== committed.digest) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "managed successor committed journal durable read-back 失败"
    );
  }
  assertValidManagedJournal(readBack, intent);
  await verifyAllManagedTargets(
    liveVaultPath,
    intent.managedWrites,
    { handle, intent, managedJournal: readBack }
  );
  return readBack;
}

async function refreshCommittedManagedMetadataSuccessors(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  liveVaultPathInput: string,
  journal: MaintenanceWorkflowManagedApplyJournal
): Promise<MaintenanceWorkflowManagedApplyJournal> {
  if (journal.state !== "committed") return journal;
  const liveVaultPath = await ensurePlainDirectory(
    liveVaultPathInput,
    "live Vault"
  );
  const proofs = await collectManagedMetadataSuccessors(
    handle,
    intent,
    liveVaultPath,
    journal
  );
  if (
    stableStringify(proofs)
    === stableStringify(journal.metadataSuccessors ?? [])
  ) {
    await verifyAllManagedTargets(
      liveVaultPath,
      intent.managedWrites,
      { handle, intent, managedJournal: journal }
    );
    return journal;
  }
  return await persistCommittedManagedJournal(
    handle,
    intent,
    liveVaultPath,
    journal,
    proofs
  );
}

async function readManagedJournalOrNull(
  journalPath: string
): Promise<MaintenanceWorkflowManagedApplyJournal | null> {
  try {
    const parsed = JSON.parse(
      (await readIndependentRegularFile(journalPath, "managed apply journal", MAX_CONTROL_FILE_BYTES)).toString("utf8")
    ) as MaintenanceWorkflowManagedApplyJournal;
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function updateManagedJournal(
  journalPath: string,
  journal: MaintenanceWorkflowManagedApplyJournal,
  patch: {
    state?: ManagedJournalState;
    error?: string | undefined;
    metadataSuccessorPolicy?: ManagedMetadataSuccessorPolicy;
    metadataSuccessorInstallWindows?: NonNullable<
      MaintenanceWorkflowManagedApplyJournal["metadataSuccessorInstallWindows"]
    >;
    acceptedMetadataBaselines?: MaintenanceShadowMetadataSuccessorProof[];
    metadataSuccessors?: MaintenanceShadowMetadataSuccessorProof[];
  }
): Promise<MaintenanceWorkflowManagedApplyJournal> {
  const nextBase = {
    ...withoutManagedJournalDigest(journal),
    ...(patch.state ? { state: patch.state } : {}),
    ...(patch.metadataSuccessorPolicy
      ? { metadataSuccessorPolicy: patch.metadataSuccessorPolicy }
      : {}),
    ...("metadataSuccessorInstallWindows" in patch
      ? {
        metadataSuccessorInstallWindows:
          patch.metadataSuccessorInstallWindows ?? []
      }
      : {}),
    ...("acceptedMetadataBaselines" in patch
      ? { acceptedMetadataBaselines: patch.acceptedMetadataBaselines ?? [] }
      : {}),
    ...("metadataSuccessors" in patch
      ? { metadataSuccessors: patch.metadataSuccessors ?? [] }
      : {}),
    updatedAt: new Date().toISOString()
  };
  if (patch.error === undefined) delete nextBase.error;
  else nextBase.error = patch.error;
  const next = withManagedJournalDigest(nextBase);
  await writeJsonDurably(journalPath, next);
  return next;
}

function assertValidManagedJournal(
  journal: MaintenanceWorkflowManagedApplyJournal,
  intent: MaintenanceWorkflowWalIntent
): void {
  if (
    journal.version !== MANAGED_JOURNAL_VERSION
    || journal.workflowRunId !== intent.workflowRunId
    || journal.intentDigest !== intent.digest
    || !["prepared", "applying", "committed", "blocked"].includes(journal.state)
    || !isIsoDate(journal.createdAt)
    || !isIsoDate(journal.updatedAt)
    || Date.parse(journal.updatedAt) < Date.parse(journal.createdAt)
    || journal.digest !== digestJson(withoutManagedJournalDigest(journal))
    || !Array.isArray(journal.entries)
    || journal.entries.length !== intent.managedWrites.length
    || !managedMetadataSuccessorPolicyValid(journal.metadataSuccessorPolicy)
    || (
      journal.metadataSuccessorPolicy !== undefined
      && stableStringify(journal.metadataSuccessorPolicy)
        !== stableStringify(managedMetadataSuccessorPolicyFor(intent))
    )
  ) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "managed apply journal 校验失败"
    );
  }
  for (const [index, entry] of journal.entries.entries()) {
    const expectedEntry = derivedManagedJournalEntry(
      intent.workflowRunId,
      intent.managedWrites[index],
      index
    );
    if (stableStringify(entry) !== stableStringify(expectedEntry)) {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        `managed journal entry 与 intent 不匹配：${index}`
      );
    }
  }
  const entryPaths = new Set(
    journal.entries.map((entry) => normalizeRelativePath(
      entry.write.relativePath
    ))
  );
  const rawInstallWindows = journal.metadataSuccessorInstallWindows;
  if (rawInstallWindows !== undefined && !Array.isArray(rawInstallWindows)) {
    throw new MaintenanceWorkflowWalError(
      "managed_journal_corrupt",
      "managed successor install window list 非法"
    );
  }
  const installWindowPaths = new Set<string>();
  for (const installWindow of rawInstallWindows ?? []) {
    const relativePath = normalizeRelativePath(installWindow.relativePath);
    const createdAtMs = Date.parse(installWindow.createdAt);
    if (
      installWindowPaths.has(relativePath)
      || !entryPaths.has(relativePath)
      || !Number.isFinite(createdAtMs)
      || !isSha256(installWindow.leaseDigest)
      || installWindow.window?.lowerBoundMs
        !== managedMetadataSuccessorPolicyFor(intent).window.lowerBoundMs
      || installWindow.window?.upperBoundMs
        !== createdAtMs + MANAGED_METADATA_SUCCESSOR_WINDOW_MS
      || createdAtMs > Date.parse(journal.updatedAt)
    ) {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        `managed successor install window 非法：${relativePath}`,
        relativePath
      );
    }
    installWindowPaths.add(relativePath);
  }
  for (const [label, proofs] of [
    ["accepted baseline", journal.acceptedMetadataBaselines ?? []],
    ["result successor", journal.metadataSuccessors ?? []]
  ] as const) {
    if (!Array.isArray(proofs)) {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        `managed ${label} proof list 非法`
      );
    }
    const seen = new Set<string>();
    for (const proof of proofs) {
      const relativePath = normalizeRelativePath(proof.relativePath);
      const proofPolicy = managedMetadataSuccessorPolicyForWrite(
        journal,
        relativePath
      );
      if (
        seen.has(relativePath)
        || !entryPaths.has(relativePath)
        || proof.result?.kind !== "file"
        || !isSha256(proof.result.sha256)
        || !Number.isSafeInteger(proof.result.size)
        || proof.result.size < 0
        || !Number.isSafeInteger(proof.result.mode)
        || !Number.isFinite(proof.updatedAt)
        || !isSha256(proof.projectionDigest)
        || !proofPolicy
        || proof.updatedAt
          < Math.floor(
            proofPolicy.window.lowerBoundMs / 60_000
          ) * 60_000
        || proof.updatedAt
          > proofPolicy.window.upperBoundMs
      ) {
        throw new MaintenanceWorkflowWalError(
          "managed_journal_corrupt",
          `managed ${label} proof 非法：${relativePath}`,
          relativePath
        );
      }
      seen.add(relativePath);
    }
  }
}

function assertManagedJournalLeaseBindings(
  journal: MaintenanceWorkflowManagedApplyJournal,
  state: MaintenanceWorkflowWalState,
  intent: MaintenanceWorkflowWalIntent
): void {
  const leases = state.managedMetadataSuccessorLeases ?? [];
  const leaseByDigest = new Map(leases.map((lease) => [lease.digest, lease]));
  for (const installWindow of journal.metadataSuccessorInstallWindows ?? []) {
    const lease = leaseByDigest.get(installWindow.leaseDigest);
    if (
      !lease
      || normalizeRelativePath(lease.relativePath)
        !== normalizeRelativePath(installWindow.relativePath)
      || lease.intentDigest !== intent.digest
      || lease.createdAt !== installWindow.createdAt
      || stableStringify(lease.window) !== stableStringify(installWindow.window)
    ) {
      throw new MaintenanceWorkflowWalError(
        "managed_journal_corrupt",
        `managed install window 缺少 WAL state authority：${installWindow.relativePath}`,
        normalizeRelativePath(installWindow.relativePath)
      );
    }
  }
}

function managedMetadataSuccessorPolicyValid(
  policy: ManagedMetadataSuccessorPolicy | undefined
): boolean {
  return policy === undefined || (
    policy.version === 1
    && policy.kind === "managed-markdown-updated-only"
    && Number.isFinite(policy.window?.lowerBoundMs)
    && Number.isFinite(policy.window?.upperBoundMs)
    && policy.window.upperBoundMs >= policy.window.lowerBoundMs
  );
}

function derivedManagedJournalEntry(
  workflowRunId: string,
  write: MaintenanceWorkflowManagedWrite,
  index: number
): MaintenanceWorkflowManagedJournalEntry {
  const token = createHash("sha256")
    .update(`${workflowRunId}\0${index}\0${write.relativePath}`)
    .digest("hex")
    .slice(0, 24);
  const parent = path.posix.dirname(write.relativePath);
  const prefix = parent === "." ? "" : `${parent}/`;
  return {
    write: cloneJson(write),
    ...(write.operation === "upsert" ? {
      installTempRelativePath: `${prefix}.echoink-managed-${token}.tmp`
    } : {}),
    ...(write.expected.kind === "file" ? {
      displacedLiveRelativePath: `${prefix}.echoink-managed-${token}.bak`
    } : {})
  };
}

function withManagedJournalDigest(
  journal: Omit<MaintenanceWorkflowManagedApplyJournal, "digest">
): MaintenanceWorkflowManagedApplyJournal {
  return { ...journal, digest: digestJson(journal) };
}

function withoutManagedJournalDigest(
  journal: MaintenanceWorkflowManagedApplyJournal
): Omit<MaintenanceWorkflowManagedApplyJournal, "digest"> {
  const { digest: _digest, ...rest } = journal;
  return rest;
}

async function advancePhaseInternal(
  handle: MaintenanceWorkflowWalHandle,
  expectedPhase: MaintenanceWorkflowWalPhase,
  nextPhase: MaintenanceWorkflowWalPhase
): Promise<MaintenanceWorkflowWalState> {
  return await advancePhaseInternalWithPatch(
    handle,
    expectedPhase,
    nextPhase,
    {}
  );
}

async function advancePhaseInternalWithPatch(
  handle: MaintenanceWorkflowWalHandle,
  expectedPhase: MaintenanceWorkflowWalPhase,
  nextPhase: MaintenanceWorkflowWalPhase,
  patch: Partial<Pick<
    MaintenanceWorkflowWalState,
    | "shadowCommitProof"
    | "noopConfirmationDigest"
    | "settingsGeneration"
    | "settingsTargetProjectionDigest"
  >>
): Promise<MaintenanceWorkflowWalState> {
  return await withWalStateLock(handle, async () => {
    const loaded = await loadMaintenanceWorkflowWal(handle);
    if (loaded.state.phase === nextPhase) return loaded.state;
    if (loaded.state.phase !== expectedPhase) {
      throw new MaintenanceWorkflowWalError(
        "phase_conflict",
        `非法 workflow WAL phase：${loaded.state.phase} -> ${nextPhase}`
      );
    }
    return await advancePhaseLoadedUnlocked(loaded, nextPhase, patch);
  });
}

async function advancePhaseLoadedUnlocked(
  loaded: LoadedMaintenanceWorkflowWal,
  phase: MaintenanceWorkflowWalPhase,
  patch: Partial<Pick<
    MaintenanceWorkflowWalState,
    | "shadowCommitProof"
    | "noopConfirmationDigest"
    | "settingsGeneration"
    | "settingsTargetProjectionDigest"
  >> = {}
): Promise<MaintenanceWorkflowWalState> {
  if (loaded.state.blocked) {
    throw new MaintenanceWorkflowWalError(
      "wal_blocked",
      `workflow WAL 已阻断：${loaded.state.blocked.message}`
    );
  }
  const currentIndex = PHASES.indexOf(loaded.state.phase);
  const nextIndex = PHASES.indexOf(phase);
  if (nextIndex !== currentIndex + 1) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      `非法 workflow WAL phase：${loaded.state.phase} -> ${phase}`
    );
  }
  return await writeNextWalState(loaded, {
    ...withoutStateDigest(loaded.state),
    ...patch,
    phase,
    sequence: loaded.state.sequence + 1,
    updatedAt: new Date().toISOString()
  });
}

async function writeNextWalState(
  loaded: LoadedMaintenanceWorkflowWal,
  state: Omit<MaintenanceWorkflowWalState, "digest">
): Promise<MaintenanceWorkflowWalState> {
  const onDisk = await readStateOrNull(loaded.handle.statePath);
  if (
    !onDisk
    || onDisk.sequence !== loaded.state.sequence
    || onDisk.digest !== loaded.state.digest
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "workflow WAL state CAS 冲突"
    );
  }
  const next = withStateDigest(state);
  await writeJsonDurably(loaded.handle.statePath, next);
  const persisted = await readStateOrNull(loaded.handle.statePath);
  if (!persisted) {
    throw new MaintenanceWorkflowWalError("state_corrupt", "workflow WAL state 写后丢失");
  }
  assertValidState(persisted, loaded.intent);
  if (persisted.digest !== next.digest) {
    throw new MaintenanceWorkflowWalError("state_corrupt", "workflow WAL state 写后复验不一致");
  }
  return persisted;
}

async function blockAndReturnError(
  handle: MaintenanceWorkflowWalHandle,
  code: MaintenanceWorkflowWalErrorCode,
  message: string
): Promise<MaintenanceWorkflowWalError> {
  await markMaintenanceWorkflowWalBlocked(handle, { code, message }).catch(() => undefined);
  return new MaintenanceWorkflowWalError(code, message);
}

function managedCasConflict(
  relativePath: string,
  current: MaintenanceWorkflowFileCas,
  expected: MaintenanceWorkflowFileCas,
  desired: MaintenanceWorkflowFileCas
): MaintenanceWorkflowWalError {
  return new MaintenanceWorkflowWalError(
    "managed_cas_conflict",
    `managed CAS 冲突：${relativePath} current=${casLabel(current)} expected=${casLabel(expected)} desired=${casLabel(desired)}`,
    relativePath
  );
}

function terminalSettingsFromSnapshot(
  settings: MaintenanceWorkflowSettingsSnapshot
): MaintenanceWorkflowTerminalSettings {
  return {
    lastRunAt: settings.lastRunAt,
    lastRunStatus: settings.lastRunStatus,
    lastReportPath: settings.lastReportPath,
    lastError: settings.lastError,
    lastSummary: settings.lastSummary,
    lastCompletion: settings.lastCompletion,
    lastAttempts: cloneJson(settings.lastAttempts),
    lastPendingSources: [...settings.lastPendingSources],
    lastFailureCode: settings.lastFailureCode,
    lastWarnings: cloneJson(settings.lastWarnings)
  };
}

function scheduledSettingsFromSnapshot(
  settings: MaintenanceWorkflowSettingsSnapshot
): MaintenanceWorkflowScheduledSettings {
  return {
    lastScheduledRunAt: settings.lastScheduledRunAt,
    lastScheduledRunStatus: settings.lastScheduledRunStatus,
    lastScheduledRunId: settings.lastScheduledRunId
  };
}

function sameScheduledSettings(
  left: MaintenanceWorkflowScheduledSettings,
  right: MaintenanceWorkflowScheduledSettings
): boolean {
  return left.lastScheduledRunAt === right.lastScheduledRunAt
    && left.lastScheduledRunStatus === right.lastScheduledRunStatus
    && left.lastScheduledRunId === right.lastScheduledRunId;
}

function isNewerUnrelatedScheduledSettings(
  current: MaintenanceWorkflowScheduledSettings,
  projection: MaintenanceWorkflowScheduledProjection
): boolean {
  return Number.isSafeInteger(current.lastScheduledRunAt)
    && current.lastScheduledRunAt > projection.target.lastScheduledRunAt
    && typeof current.lastScheduledRunId === "string"
    && current.lastScheduledRunId.trim() === current.lastScheduledRunId
    && current.lastScheduledRunId.length > 0
    && current.lastScheduledRunId.length <= 512
    && current.lastScheduledRunId !== projection.target.lastScheduledRunId
    && ["idle", "running", "success", "failed", "canceled"]
      .includes(current.lastScheduledRunStatus);
}

type OptionalJsonEntry<T> =
  | { present: false }
  | { present: true; value: T };

function recordEntry<T>(
  record: Record<string, T>,
  key: string
): OptionalJsonEntry<T> {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? { present: true, value: record[key] }
    : { present: false };
}

function mapEntry<T>(map: ReadonlyMap<string, T>, key: string): OptionalJsonEntry<T> {
  return map.has(key)
    ? { present: true, value: map.get(key) as T }
    : { present: false };
}

function sameOptionalJsonEntry<T>(
  left: OptionalJsonEntry<T>,
  right: OptionalJsonEntry<T>
): boolean {
  return left.present === right.present
    && (!left.present || (
      right.present
      && stableStringify(left.value) === stableStringify(right.value)
    ));
}

function managedProcessedSourceKeys(
  settings: MaintenanceWorkflowSettingsPlan
): string[] {
  const keys = new Set([
    ...Object.keys(settings.baselineProcessedSources),
    ...Object.keys(settings.targetProcessedSources)
  ]);
  return Array.from(keys)
    .filter((key) => !sameOptionalJsonEntry(
      recordEntry(settings.baselineProcessedSources, key),
      recordEntry(settings.targetProcessedSources, key)
    ))
    .sort(compareCanonicalText);
}

function assertMatchingBlockedResume(
  state: MaintenanceWorkflowWalState,
  expected: { stateSequence: number; stateDigest: string }
): void {
  if (
    !state.blocked
    || state.sequence !== expected.stateSequence
    || state.digest !== expected.stateDigest
  ) {
    throw new MaintenanceWorkflowWalError(
      "phase_conflict",
      "resumeBlocked 未绑定当前 blocker state"
    );
  }
}

interface AcquiredWorkflowFileLock {
  handle: fsp.FileHandle;
  lockPath: string;
  dev: number;
  ino: number;
}

async function withWalStateLock<T>(
  handle: MaintenanceWorkflowWalHandle,
  action: () => Promise<T>
): Promise<T> {
  normalizeWalLocation(handle);
  return await withRecordMutationGlobalAuthority(
    handle.storageRootPath,
    workflowWalAuthorityId(handle.workflowRunId),
    async () => {
      const lockRootPath = path.join(handle.walRootPath, LOCK_DIRECTORY);
      await ensurePlainDirectory(lockRootPath, "workflow WAL lock root", true);
      await syncDirectory(handle.walRootPath);
      const lock = await acquireWorkflowFileLock(
        path.join(lockRootPath, `${handle.runToken}.lock`),
        {
          version: 1,
          pid: process.pid,
          token: randomUUID(),
          workflowRunId: handle.workflowRunId,
          createdAt: new Date().toISOString()
        },
        "workflow state lock"
      );
      try {
        return await action();
      } finally {
        await releaseWorkflowFileLock(lock);
      }
    }
  );
}

function workflowWalAuthorityId(workflowRunId: string): string {
  return `workflow-wal-${createHash("sha256")
    .update(String(workflowRunId), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

async function withVaultCommitLock<T>(
  handle: MaintenanceWorkflowWalHandle,
  intent: MaintenanceWorkflowWalIntent,
  action: () => Promise<T>
): Promise<T> {
  normalizeWalLocation(handle);
  const liveVaultFingerprint = workflowVaultFingerprint(intent);
  if (!isSha256(liveVaultFingerprint)) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "workflow intent live Vault fingerprint 非法"
    );
  }
  const lockPath = path.join(
    handle.storageRootPath,
    `.echoink-maintenance-${liveVaultFingerprint.slice("sha256:".length)}.lock`
  );
  const lock = await acquireWorkflowFileLock(
    lockPath,
    {
      version: 1,
      pid: process.pid,
      workflowRunId: intent.workflowRunId,
      winnerAttemptId: intent.winner?.attemptId ?? null,
      journalPath: handle.managedJournalPath,
      createdAt: new Date().toISOString()
    },
    "maintenance Vault commit lock"
  );
  try {
    return await action();
  } finally {
    await releaseWorkflowFileLock(lock);
  }
}

function workflowVaultFingerprint(
  intent: MaintenanceWorkflowWalIntent
): string {
  if (intent.shadow) return intent.shadow.liveVaultFingerprint;
  if (intent.noopProof) return intent.noopProof.liveVaultFingerprint;
  throw new MaintenanceWorkflowWalError(
    "intent_corrupt",
    "workflow intent 缺少 live Vault binding"
  );
}

async function acquireWorkflowFileLock(
  lockPath: string,
  payload: Record<string, unknown>,
  label: string
): Promise<AcquiredWorkflowFileLock> {
  const parentPath = path.dirname(lockPath);
  await ensurePlainDirectory(parentPath, `${label} parent`, true);
  for (let attempt = 0; attempt < 250; attempt += 1) {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(
        lockPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | noFollowFlag(),
        0o600
      );
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.sync();
      const stat = await handle.stat();
      await syncDirectory(parentPath);
      return {
        handle,
        lockPath,
        dev: Number(stat.dev),
        ino: Number(stat.ino)
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await fsp.rm(lockPath, { force: true }).catch(() => undefined);
      }
      if (!isAlreadyExists(error)) throw error;
      const owner = await readWorkflowLockOwner(lockPath, label);
      if (!isProcessAlive(owner.pid)) {
        const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await fsp.rename(lockPath, quarantinePath);
          await syncDirectory(parentPath);
          await fsp.rm(quarantinePath, { force: true });
          await syncDirectory(parentPath);
        } catch (renameError) {
          if (!isNotFound(renameError)) throw renameError;
        }
        continue;
      }
      await delay(10);
    }
  }
  throw new MaintenanceWorkflowWalError(
    "wal_blocked",
    `${label} 正被另一个存活进程持有`
  );
}

async function readWorkflowLockOwner(
  lockPath: string,
  label: string
): Promise<{ pid: number }> {
  try {
    const parsed = JSON.parse(
      (await readIndependentRegularFile(
        lockPath,
        label,
        MAX_CONTROL_FILE_BYTES
      )).toString("utf8")
    ) as { pid?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0) {
      throw new Error("lock pid 非法");
    }
    return { pid: Number(parsed.pid) };
  } catch (error) {
    if (isNotFound(error)) return { pid: -1 };
    throw new MaintenanceWorkflowWalError(
      "wal_blocked",
      `${label} 损坏，拒绝自动删除：${errorMessage(error)}`
    );
  }
}

async function releaseWorkflowFileLock(
  lock: AcquiredWorkflowFileLock
): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const stat = await lstatOrNull(lock.lockPath);
  if (
    stat
    && !stat.isSymbolicLink()
    && stat.isFile()
    && Number(stat.dev) === lock.dev
    && Number(stat.ino) === lock.ino
  ) {
    await fsp.rm(lock.lockPath, { force: true });
    await syncDirectory(path.dirname(lock.lockPath));
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function withIntentDigest(
  intent: Omit<MaintenanceWorkflowWalIntent, "digest">
): MaintenanceWorkflowWalIntent {
  return { ...intent, digest: digestJson(intent) };
}

function withoutIntentDigest(
  intent: MaintenanceWorkflowWalIntent
): Omit<MaintenanceWorkflowWalIntent, "digest"> {
  const { digest: _digest, ...rest } = intent;
  return rest;
}

function withStateDigest(
  state: Omit<MaintenanceWorkflowWalState, "digest">
): MaintenanceWorkflowWalState {
  return { ...state, digest: digestJson(state) };
}

function withoutStateDigest(
  state: MaintenanceWorkflowWalState
): Omit<MaintenanceWorkflowWalState, "digest"> {
  const { digest: _digest, ...rest } = state;
  return rest;
}

function assertValidMaintenanceWorkflowWalIntent(
  intent: MaintenanceWorkflowWalIntent,
  options: {
    allowLegacyNoopReceipt?: boolean;
    allowLegacyRegistryOrdering?: boolean;
  } = {}
): void {
  const fail = (message: string): never => {
    throw new MaintenanceWorkflowWalError("intent_corrupt", message);
  };
  if (!intent || typeof intent !== "object") fail("workflow intent 不是对象");
  if (intent.version !== WAL_VERSION) fail("workflow intent version 不受支持");
  requireNonEmptyText(intent.workflowRunId, "workflowRunId", 512);
  if (!Number.isFinite(intent.startedAt) || intent.startedAt < 0) {
    fail("workflow intent startedAt 非法");
  }
  if (!["maintain", "reingest", "lint", "outputs", "inbox"].includes(intent.mode)) {
    fail("workflow intent mode 非法");
  }
  if (!isIsoDate(intent.createdAt)) fail("workflow intent createdAt 非法");
  if (!isAgentBackendKind(intent.selectedBackend)) fail("workflow intent selectedBackend 非法");
  if (!["full", "partial", "recovered", "noop"].includes(intent.completion)) {
    fail("workflow intent completion 非法");
  }
  if (
    !Array.isArray(intent.candidateBackends)
    || intent.candidateBackends.some((backend) => !isAgentBackendKind(backend))
    || new Set(intent.candidateBackends).size !== intent.candidateBackends.length
    || !sameStringArray(
      intent.candidateBackends,
      canonicalMaintenanceCandidateBackends(intent.selectedBackend)
    )
  ) {
    fail("workflow intent candidateBackends 非法");
  }
  if (
    !Array.isArray(intent.attempts)
    || !Array.isArray(intent.verifiedSources)
    || !Array.isArray(intent.pendingSources)
    || !Array.isArray(intent.warnings)
    || !intent.report
    || !intent.indexReconciliation
    || !intent.settings
    || !Object.prototype.hasOwnProperty.call(intent.settings, "scheduled")
    || !Array.isArray(intent.managedWrites)
    || !intent.evidencePaths
    || typeof intent.evidencePaths !== "object"
    || Array.isArray(intent.evidencePaths)
  ) {
    fail("workflow intent 缺少必需集合");
  }

  const noop = intent.completion === "noop";
  const legacyNoopReceipt = noop && intent.noopReceipt === undefined;
  if (noop) {
    if (
      intent.winner !== null
      || intent.shadow !== null
      || intent.attempts.length !== 0
      || intent.verifiedSources.length !== 0
      || intent.pendingSources.length !== 0
      || Object.keys(intent.evidencePaths).length !== 0
      || !intent.noopProof
    ) {
      fail("noop workflow 必须是零 Agent、零变更来源、零 Shadow");
    }
    assertValidNoopProof(intent.noopProof as MaintenanceWorkflowNoopProof);
    if (legacyNoopReceipt) {
      if (!options.allowLegacyNoopReceipt) {
        fail("新 noop workflow 缺少 run-scoped receipt contract");
      }
    } else {
      assertValidNoopReceiptContract(
        intent.noopReceipt as MaintenanceWorkflowNoopReceiptContract
      );
    }
  } else {
    if (
      !intent.winner
      || !intent.shadow
      || intent.noopProof !== undefined
      || intent.noopReceipt !== undefined
      || !isAgentBackendKind(intent.winner.backend)
      || !intent.candidateBackends.includes(intent.winner.backend)
      || !Number.isSafeInteger(intent.winner.ordinal)
      || intent.winner.ordinal <= 0
      || !requireNonEmptyText(intent.winner.attemptId, "winner attemptId", 512)
      || intent.attempts.length === 0
    ) {
      fail("非 noop workflow winner/Shadow 非法");
    }
  }

  const attemptIds = new Set<string>();
  let previousCandidateIndex = -1;
  for (const [index, attempt] of intent.attempts.entries()) {
    const candidateIndex = intent.candidateBackends.indexOf(attempt.backend);
    if (
      !attempt
      || !requireNonEmptyText(attempt.attemptId, "attemptId", 512)
      || !Number.isSafeInteger(attempt.ordinal)
      || attempt.ordinal !== index + 1
      || !isAgentBackendKind(attempt.backend)
      || candidateIndex < 0
      || candidateIndex <= previousCandidateIndex
      || attemptIds.has(attempt.attemptId)
    ) {
      fail("workflow intent attempts 非法");
    }
    attemptIds.add(attempt.attemptId);
    previousCandidateIndex = candidateIndex;
    if (index === 0 && attempt.backend !== intent.selectedBackend) {
      fail("首个真实 attempt 必须是用户选中的 Agent");
    }
    if (index < intent.attempts.length - 1) {
      if (
        attempt.terminal?.status !== "failed"
        || !attempt.failure?.retryable
        || !attempt.failure.failoverEligible
        || (
          attempt.submitted
          && (
            !attempt.termination?.confirmedAt
            || !attempt.staging?.discardedAt
          )
        )
      ) {
        fail(`前序 attempt 缺少合法基础设施故障转移证据：${attempt.attemptId}`);
      }
    }
  }
  if (!noop) {
    const winner = intent.winner!;
    const winnerAttempt = intent.attempts[intent.attempts.length - 1];
    if (
      winnerAttempt.attemptId !== winner.attemptId
      || winnerAttempt.ordinal !== winner.ordinal
      || winnerAttempt.backend !== winner.backend
      || winnerAttempt.terminal?.status !== "completed"
    ) {
      fail("workflow winner 未绑定可解释的 terminal attempt");
    }
  }
  if (intent.completion === "partial" ? !intent.pendingSources.length : intent.pendingSources.length > 0) {
    fail("workflow completion 与 pendingSources 不一致");
  }
  const verifiedPaths = new Set<string>();
  const verifiedSourceByPath = new Map<
    string,
    MaintenanceWorkflowSourceRecord
  >();
  for (const source of intent.verifiedSources) {
    const relativePath = assertValidSourceRecord(source, "verified source");
    if (verifiedPaths.has(relativePath)) fail(`verified source 重复：${relativePath}`);
    verifiedPaths.add(relativePath);
    verifiedSourceByPath.set(relativePath, source);
  }
  const pendingPaths = new Set<string>();
  for (const pending of intent.pendingSources) {
    if (!pending?.source || !pending.reason) fail("pending source 非法");
    const relativePath = assertValidSourceRecord(pending.source, "pending source");
    if (verifiedPaths.has(relativePath) || pendingPaths.has(relativePath)) {
      fail(`verified/pending source 重叠或重复：${relativePath}`);
    }
    pendingPaths.add(relativePath);
    requireNonEmptyText(pending.reason.code, "pending reason code", 160);
    requireNonEmptyText(pending.reason.message, "pending reason message", 4000);
    for (const relatedPath of pending.reason.relatedSources ?? []) {
      normalizeRelativePath(relatedPath);
    }
    for (const targetPath of pending.reason.targetPaths ?? []) {
      normalizeRelativePath(targetPath);
    }
  }
  const evidenceKeys = Object.keys(intent.evidencePaths).sort();
  if (!sameStringArray(evidenceKeys, Array.from(verifiedPaths).sort())) {
    fail("workflow evidencePaths 必须与 verifiedSources 一一对应");
  }
  for (const [sourcePath, evidencePaths] of Object.entries(intent.evidencePaths)) {
    normalizeRelativePath(sourcePath);
    if (!Array.isArray(evidencePaths) || !evidencePaths.length) {
      fail(`verified source 缺少 evidence：${sourcePath}`);
    }
    for (const evidencePath of evidencePaths) normalizeRelativePath(evidencePath);
  }
  requireNonEmptyText(intent.summary, "workflow summary", 128_000);
  for (const digest of [
    intent.report.finalBlockDigest,
    intent.settings.baselineProcessedSourcesDigest,
    intent.settings.targetProcessedSourcesDigest,
    intent.settings.baselineTerminalDigest,
    intent.settings.targetTerminalDigest
  ]) {
    if (!isSha256(digest)) fail(`workflow intent digest 非法：${String(digest)}`);
  }
  if (!noop) {
    const shadow = intent.shadow!;
    for (const digest of [
      shadow.changeSetDigest,
      shadow.selectionDigest,
      shadow.liveVaultFingerprint
    ]) {
      if (!isSha256(digest)) fail(`workflow Shadow digest 非法：${String(digest)}`);
    }
    requireNonEmptyText(shadow.controlRootPath, "Shadow controlRootPath", 8192);
    for (const values of [
      shadow.allowPaths,
      shadow.expectedAppliedPaths,
      shadow.skippedPaths
    ]) {
      if (!Array.isArray(values)) fail("workflow intent Shadow path list 非法");
      for (const relativePath of values) normalizeRelativePath(relativePath);
      if (new Set(values).size !== values.length) {
        fail("workflow intent Shadow path list 含重复项");
      }
    }
    const allowedPaths = new Set(shadow.allowPaths);
    const skippedPaths = new Set(shadow.skippedPaths);
    if (
      shadow.expectedAppliedPaths.length === 0
      || shadow.expectedAppliedPaths.some(
        (relativePath) => !allowedPaths.has(relativePath) || skippedPaths.has(relativePath)
      )
    ) {
      fail("Shadow expectedAppliedPaths 为空、越权或与 skippedPaths 重叠");
    }
  }

  const reportPath = normalizeRelativePath(intent.report.relativePath);
  if (
    noop
    && !legacyNoopReceipt
    && reportPath !== maintenanceWorkflowNoopReceiptPath({
      mode: intent.mode,
      workflowRunId: intent.workflowRunId,
      receipt: intent.noopReceipt as MaintenanceWorkflowNoopReceiptContract
    })
  ) {
    fail("noop workflow report 未使用 run-scoped receipt 路径");
  }
  assertValidCas(intent.report.expectedPostShadow, "report expectedPostShadow");
  assertValidCas(intent.report.desired, "report desired");
  const seenPaths = new Set<string>();
  let matchingReports = 0;
  let trackerWrites = 0;
  let rawRegistryWrites = 0;
  let rawRegistryWrite: MaintenanceWorkflowManagedWrite | null = null;
  const indexWrites = new Map<string, MaintenanceWorkflowManagedWrite>();
  const rawMetadataWrites = new Map<
    string,
    MaintenanceWorkflowManagedWrite
  >();
  const hasNewRawExpectedBlobs = intent.managedWrites.some((write) =>
    write.kind === "raw-metadata" && write.expectedBlobDigest !== undefined
  );
  for (const write of intent.managedWrites) {
    if (!write || typeof write !== "object") fail("managed write 非法");
    const relativePath = normalizeRelativePath(write.relativePath);
    if (seenPaths.has(relativePath)) fail(`managed write 路径重复：${relativePath}`);
    seenPaths.add(relativePath);
    if (!["index", "raw-metadata", "raw-registry", "report", "tracker"].includes(write.kind)) {
      fail(`managed write kind 非法：${relativePath}`);
    }
    if (!["upsert", "delete"].includes(write.operation)) {
      fail(`managed write operation 非法：${relativePath}`);
    }
    assertValidCas(write.expected, `managed expected ${relativePath}`);
    assertValidCas(write.desired, `managed desired ${relativePath}`);
    if (write.operation === "delete") {
      if (
        write.desired.kind !== "missing"
        || write.blobDigest !== undefined
        || write.expectedBlobDigest !== undefined
      ) {
        fail(`managed delete 目标非法：${relativePath}`);
      }
    } else {
      if (
        write.desired.kind !== "file"
        || !write.blobDigest
        || write.blobDigest !== write.desired.sha256
      ) {
        fail(`managed upsert blob 非法：${relativePath}`);
      }
    }
    if (write.kind === "report" && relativePath === reportPath) {
      matchingReports += 1;
      if (
        !relativePath.startsWith("outputs/maintenance/")
        || write.operation !== "upsert"
        || write.desired.kind !== "file"
        ||
        !sameCas(write.expected, intent.report.expectedPostShadow)
        || !sameCas(write.desired, intent.report.desired)
      ) {
        fail(`report CAS 与 managed write 不一致：${relativePath}`);
      }
    }
    if (write.kind === "report" && relativePath !== reportPath) {
      fail(`存在未声明的 report managed write：${relativePath}`);
    }
    if (write.kind === "tracker") {
      trackerWrites += 1;
      if (
        relativePath !== "outputs/.ingest-tracker.md"
        || write.operation !== "upsert"
        || write.desired.kind !== "file"
      ) {
        fail(`tracker managed write 路径或操作非法：${relativePath}`);
      }
    }
    if (write.kind === "raw-registry") {
      rawRegistryWrites += 1;
      const proof = write.rawRegistryProof;
      if (
        relativePath !== "outputs/.raw-digest-registry.json"
        || write.operation !== "upsert"
        || write.desired.kind !== "file"
        || !proof
        || proof.schemaVersion !== RAW_DIGEST_SCHEMA_VERSION
        || !isIsoDate(proof.updatedAt)
        || !isSha256(proof.entriesDigest)
        || !proof.entries
        || typeof proof.entries !== "object"
        || Array.isArray(proof.entries)
        || proof.entriesDigest !== digestJson(proof.entries)
        || (
          proof.canonicalBytes !== true
          && (
            proof.canonicalBytes !== undefined
            ||
            !options.allowLegacyRegistryOrdering
            || hasNewRawExpectedBlobs
          )
        )
      ) {
        fail(`Raw registry managed write 路径或操作非法：${relativePath}`);
      }
      rawRegistryWrite = write;
    } else if (write.rawRegistryProof !== undefined) {
      fail(`非 Raw registry write 不得携带 registry proof：${relativePath}`);
    }
    if (write.kind === "index") {
      if (
        !isHarnessManagedIndexPath(relativePath)
        || write.operation !== "upsert"
        || write.desired.kind !== "file"
      ) {
        fail(`index managed write 路径或操作非法：${relativePath}`);
      }
      indexWrites.set(relativePath, write);
    }
    if (write.kind === "raw-metadata") {
      const source = verifiedSourceByPath.get(relativePath);
      const target = intent.settings.targetProcessedSources[relativePath];
      const proof = write.rawMetadataProof;
      const evidencePaths = normalizedUniquePaths(
        intent.evidencePaths[relativePath] ?? []
      );
      if (
        !relativePath.startsWith("raw/")
        || (intent.mode !== "maintain" && intent.mode !== "reingest")
        || !source
        || !target
        || write.operation !== "upsert"
        || write.desired.kind !== "file"
        || write.expected.kind !== "file"
        || (
          write.expectedBlobDigest !== undefined
          && write.expectedBlobDigest !== write.expected.sha256
        )
        || !isSha256(write.rawBodyDigest)
        || !isSha256(write.rawUnmanagedFrontmatterDigest)
        || !proof
        || proof.processed !== true
        || proof.status !== RAW_DIGEST_STATUS_DIGESTED
        || proof.fingerprint !== source.fingerprint
        || proof.digestedAt !== intent.startedAt
        || source.mtime !== proof.digestedAt
        || proof.reportPath !== intent.report.relativePath
        || !sameStringArray(
          normalizedUniquePaths(proof.evidencePaths),
          evidencePaths
        )
        || write.desired.size !== source.size
        || target.path !== source.relativePath
        || target.size !== source.size
        || target.mtime !== source.mtime
        || target.fingerprint !== source.fingerprint
        || target.digestedAt !== proof.digestedAt
        || target.runId !== intent.workflowRunId
        || target.reportPath !== proof.reportPath
        || !sameStringArray(
          normalizedUniquePaths(target.evidencePaths ?? []),
          evidencePaths
        )
        || target.confidence !== "verified"
        || (
          write.expected.kind === "file"
          && write.expected.mode !== write.desired.mode
        )
      ) {
        fail(`Raw metadata managed write 越权或未绑定 verified source：${relativePath}`);
      }
      rawMetadataWrites.set(relativePath, write);
    } else if (
      write.rawBodyDigest !== undefined
      || write.rawUnmanagedFrontmatterDigest !== undefined
      || write.rawMetadataProof !== undefined
      || write.expectedBlobDigest !== undefined
    ) {
      fail(`非 Raw metadata write 不得携带 Raw proof：${relativePath}`);
    }
  }
  if (matchingReports !== 1) fail("workflow intent 必须包含唯一报告 managed write");
  if (
    legacyNoopReceipt
    && (
      intent.managedWrites.length !== 2
      || trackerWrites !== 1
      || rawRegistryWrites !== 0
      || indexWrites.size !== 0
      || rawMetadataWrites.size !== 0
      || !isLegacyNoopReportPath(intent.mode, reportPath)
    )
  ) {
    fail("legacy noop workflow 不符合旧版 report + tracker 严格结构");
  }
  if (
    noop
      ? trackerWrites !== (legacyNoopReceipt ? 1 : 0)
      : (
        (intent.mode === "lint" && trackerWrites !== 0)
        || (intent.mode !== "lint" && trackerWrites !== 1)
      )
  ) {
    fail("workflow intent tracker managed write 与运行模式不一致");
  }
  if (rawRegistryWrites > 1) fail("workflow intent 最多包含一个 Raw registry managed write");
  const digestMode = intent.mode === "maintain"
    || intent.mode === "reingest";
  const verifiedRawPaths = Array.from(verifiedPaths)
    .filter((relativePath) => relativePath.startsWith("raw/"))
    .sort(compareCanonicalText);
  const expectedRawMetadataPaths = digestMode
    ? verifiedRawPaths.filter(isRawMarkdownPath)
    : [];
  const actualRawMetadataPaths = Array.from(rawMetadataWrites.keys())
    .sort(compareCanonicalText);
  if (!sameStringArray(actualRawMetadataPaths, expectedRawMetadataPaths)) {
    fail(
      intent.mode === "maintain" || intent.mode === "reingest"
        ? "verified Raw 与 raw-metadata upsert 必须一一对应"
        : "非 maintain/reingest workflow 禁止 raw-metadata write"
    );
  }
  if (
    digestMode
      ? rawRegistryWrites !== (verifiedRawPaths.length ? 1 : 0)
      : rawRegistryWrites !== 0
  ) {
    fail(
      digestMode
        ? "verified Raw 必须绑定唯一 raw-registry projection"
        : "非 maintain/reingest workflow 禁止 raw-registry write"
    );
  }
  if (rawRegistryWrite?.rawRegistryProof) {
    const proof = rawRegistryWrite.rawRegistryProof;
    if (proof.updatedAt !== new Date(intent.startedAt).toISOString()) {
      fail("Raw registry updatedAt 未绑定 workflow startedAt");
    }
    for (const relativePath of verifiedRawPaths) {
      const source = verifiedSourceByPath.get(relativePath);
      const target = intent.settings.targetProcessedSources[relativePath];
      const entry = proof.entries[relativePath];
      if (!source || !target || !entry) {
        throw new MaintenanceWorkflowWalError(
          "intent_corrupt",
          `verified Raw 缺少 registry/settings target：${relativePath}`
        );
      }
      const expectedEntry: RawDigestRegistryEntry = {
        rawPath: relativePath,
        fingerprint: source.fingerprint,
        size: source.size,
        mtime: source.mtime,
        digestedAt: intent.startedAt,
        runId: intent.workflowRunId,
        reportPath: intent.report.relativePath,
        evidencePaths: normalizedUniquePaths(
          intent.evidencePaths[relativePath] ?? []
        ),
        confidence: "verified"
      };
      if (
        stableStringify({
          ...entry,
          evidencePaths: normalizedUniquePaths(entry.evidencePaths ?? [])
        }) !== stableStringify(expectedEntry)
        || target.path !== entry.rawPath
        || target.fingerprint !== entry.fingerprint
        || target.size !== entry.size
        || target.mtime !== entry.mtime
        || target.digestedAt !== entry.digestedAt
        || target.runId !== entry.runId
        || target.reportPath !== entry.reportPath
        || !sameStringArray(
          normalizedUniquePaths(target.evidencePaths ?? []),
          normalizedUniquePaths(entry.evidencePaths)
        )
        || target.confidence !== entry.confidence
      ) {
        fail(`verified Raw 未严格绑定 registry/settings：${relativePath}`);
      }
    }
  }
  if (
    !Array.isArray(intent.indexReconciliation.committed)
    || !Array.isArray(intent.indexReconciliation.deferred)
    || !Array.isArray(intent.indexReconciliation.warnings)
  ) {
    fail("index reconciliation 非法");
  }
  for (const entry of intent.indexReconciliation.committed) {
    const relativePath = normalizeRelativePath(entry.relativePath);
    assertValidCas(entry.result, `index committed ${entry.relativePath}`);
    if (entry.result.kind !== "file") {
      fail(`index committed result 必须是 file CAS：${entry.relativePath}`);
    }
    for (const sourcePath of entry.sourcePaths) normalizeRelativePath(sourcePath);
    const managed = indexWrites.get(relativePath);
    if (
      !managed
      || !sameCas(managed.desired, entry.result)
      || entry.sourcePaths.some((sourcePath) => !verifiedPaths.has(sourcePath))
    ) {
      fail(`index reconciliation 未与 verified managed write 绑定：${relativePath}`);
    }
  }
  if (
    indexWrites.size !== intent.indexReconciliation.committed.length
  ) {
    fail("index managed writes 与 reconciliation committed 不一一对应");
  }
  for (const entry of intent.indexReconciliation.deferred) {
    normalizeRelativePath(entry.relativePath);
    requireNonEmptyText(entry.reason, "index deferred reason", 4000);
    for (const sourcePath of entry.sourcePaths) normalizeRelativePath(sourcePath);
  }
  if (
    noop
    && (
      intent.indexReconciliation.committed.length
      || intent.indexReconciliation.deferred.length
      || intent.indexReconciliation.warnings.length
    )
  ) {
    fail("noop workflow 不得夹带 index reconciliation 变化");
  }
  if (
    digestJson(intent.settings.baselineProcessedSources)
      !== intent.settings.baselineProcessedSourcesDigest
    || digestJson(intent.settings.targetProcessedSources)
      !== intent.settings.targetProcessedSourcesDigest
    || digestJson(intent.settings.baselineTerminal)
      !== intent.settings.baselineTerminalDigest
    || digestJson(intent.settings.targetTerminal)
      !== intent.settings.targetTerminalDigest
  ) {
    fail("workflow settings plan digest 不匹配");
  }
  assertValidProcessedSourcesPlan(
    intent,
    verifiedPaths,
    pendingPaths,
    noop
  );
  assertValidTerminalSettings(intent.settings.baselineTerminal, "baseline terminal");
  assertValidTerminalSettings(intent.settings.targetTerminal, "target terminal");
  assertValidScheduledProjection(intent);
  if (
    intent.settings.targetTerminal.lastRunAt < intent.settings.baselineTerminal.lastRunAt
    || intent.settings.targetTerminal.lastRunStatus !== "success"
    || intent.settings.targetTerminal.lastCompletion !== intent.completion
    || intent.settings.targetTerminal.lastReportPath !== intent.report.relativePath
    || intent.settings.targetTerminal.lastSummary !== intent.summary
    || intent.settings.targetTerminal.lastError !== ""
    || intent.settings.targetTerminal.lastFailureCode !== ""
    || stableStringify(intent.settings.targetTerminal.lastWarnings)
      !== stableStringify(intent.warnings)
    || !sameStringArray(
      [...intent.settings.targetTerminal.lastPendingSources].sort(),
      Array.from(pendingPaths).sort()
    )
    || stableStringify(intent.settings.targetTerminal.lastAttempts)
      !== stableStringify(intent.attempts)
  ) {
    fail("workflow target terminal 与业务终态不一致");
  }
  if (
    !intent.settings.historyEntry
    || intent.settings.historyEntry.runId !== intent.workflowRunId
    || intent.settings.historyEntry.status !== "success"
    || intent.settings.historyEntry.at !== intent.settings.targetTerminal.lastRunAt
    || intent.settings.historyEntry.mode !== intent.mode
    || intent.settings.historyEntry.completion !== intent.completion
    || intent.settings.historyEntry.reportPath !== intent.report.relativePath
    || intent.settings.historyEntry.selectedBackend
      !== intent.selectedBackend
    || !Object.prototype.hasOwnProperty.call(
      intent.settings.historyEntry,
      "winnerBackend"
    )
    || intent.settings.historyEntry.winnerBackend
      !== (intent.winner?.backend ?? null)
    || stableStringify(intent.settings.historyEntry.attempts ?? [])
      !== stableStringify(intent.attempts)
    || stableStringify(intent.settings.historyEntry.pendingSources ?? [])
      !== stableStringify(intent.settings.targetTerminal.lastPendingSources)
    || !Object.prototype.hasOwnProperty.call(
      intent.settings.historyEntry,
      "failureCode"
    )
    || intent.settings.historyEntry.failureCode !== null
    || intent.settings.historyEntry.terminalPhase !== "finalized"
    || intent.settings.historyEntry.commitState !== "committed"
    || stableStringify(intent.settings.historyEntry.warnings ?? [])
      !== stableStringify(intent.warnings)
  ) {
    fail("workflow settings history entry 与 runId 不匹配");
  }
  const canonicalHistoryEntry =
    canonicalizeKnowledgeBaseMaintenanceHistoryEntry(
      intent.settings.historyEntry
    );
  if (
    !canonicalHistoryEntry
    || stableStringify(canonicalHistoryEntry)
      !== stableStringify(intent.settings.historyEntry)
  ) {
    fail("workflow settings history entry 未通过 canonical round-trip");
  }
  if (intent.digest !== digestJson(withoutIntentDigest(intent))) {
    fail("workflow intent digest 校验失败");
  }
}

function canonicalMaintenanceCandidateBackends(
  selected: AgentBackendKind
): AgentBackendKind[] {
  const canonical: AgentBackendKind[] = ["codex-cli", "opencode", "hermes"];
  const selectedIndex = canonical.indexOf(selected);
  if (selectedIndex < 0) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "selected Agent 不在维护候选集合"
    );
  }
  return [
    ...canonical.slice(selectedIndex),
    ...canonical.slice(0, selectedIndex)
  ];
}

function isHarnessManagedIndexPath(relativePath: string): boolean {
  if (
    relativePath === "raw/index.md"
    || relativePath === "wiki/index.md"
    || relativePath === "projects/index.md"
    || relativePath === "projects/00-索引.md"
  ) {
    return true;
  }
  return (
    (relativePath.startsWith("wiki/") || relativePath.startsWith("projects/"))
    && path.posix.basename(relativePath) === "00-索引.md"
  );
}

function assertValidNoopProof(proof: MaintenanceWorkflowNoopProof): void {
  if (!proof || !Array.isArray(proof.sourceSnapshot)) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "noop proof 缺少 source snapshot"
    );
  }
  const normalizedSnapshot = proof.sourceSnapshot.map((source) => {
    assertValidSourceRecord(source, "noop source snapshot");
    return source;
  });
  const sourcePaths = normalizedSnapshot.map((source) => source.relativePath);
  if (
    typeof proof !== "object"
    || !isSha256(proof.liveVaultFingerprint)
    || !Number.isSafeInteger(proof.sourceCount)
    || proof.sourceCount < 0
    || proof.sourceCount !== normalizedSnapshot.length
    || proof.changedSourceCount !== 0
    || new Set(sourcePaths).size !== sourcePaths.length
    || proof.discoveryDigest !== digestJson({
      discoveredSources: normalizedSnapshot,
      changedSources: []
    })
    || proof.sourceSnapshotDigest !== digestJson(normalizedSnapshot)
  ) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "noop proof 不是规范零变更快照"
    );
  }
}

function assertValidNoopReceiptContract(
  receipt: MaintenanceWorkflowNoopReceiptContract
): void {
  if (
    !receipt
    || typeof receipt !== "object"
    || receipt.schemaVersion !== NOOP_RECEIPT_SCHEMA_VERSION
    || receipt.kind !== "run-scoped-report"
    || receipt.pathStrategy !== "workflow-run-id-sha256-v1"
    || !isCalendarDateKey(receipt.dateKey)
  ) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "noop receipt contract 非法"
    );
  }
}

function isCalendarDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isLegacyNoopReportPath(
  mode: MaintenanceWorkflowWalIntent["mode"],
  relativePath: string
): boolean {
  if (mode !== "maintain" && mode !== "reingest") return false;
  const match = relativePath.match(
    /^outputs\/maintenance\/kb-maintenance-(\d{4}-\d{2}-\d{2})\.md$/
  );
  return Boolean(match && isCalendarDateKey(match[1]));
}

function assertValidScheduledProjection(
  intent: MaintenanceWorkflowWalIntent
): void {
  const projection = intent.settings.scheduled;
  if (projection === null) return;
  const fail = (message: string): never => {
    throw new MaintenanceWorkflowWalError("intent_corrupt", message);
  };
  if (
    !projection
    || typeof projection !== "object"
    || !projection.baseline
    || !projection.target
  ) {
    fail("scheduled settings projection 非法");
  }
  const validate = (
    value: MaintenanceWorkflowScheduledSettings,
    label: string
  ): void => {
    if (
      !Number.isSafeInteger(value.lastScheduledRunAt)
      || value.lastScheduledRunAt < 0
      || !["idle", "running", "success", "failed", "canceled"]
        .includes(value.lastScheduledRunStatus)
      || requireNonEmptyText(
        value.lastScheduledRunId,
        `${label} lastScheduledRunId`,
        512
      ) !== value.lastScheduledRunId
    ) {
      fail(`${label} 非法`);
    }
  };
  validate(projection.baseline, "scheduled baseline");
  validate(projection.target, "scheduled target");
  if (
    intent.mode !== "maintain"
    || projection.baseline.lastScheduledRunStatus !== "running"
    || projection.target.lastScheduledRunStatus !== "success"
    || projection.baseline.lastScheduledRunAt !== intent.startedAt
    || projection.target.lastScheduledRunAt !== intent.startedAt
    || projection.baseline.lastScheduledRunId !== intent.workflowRunId
    || projection.target.lastScheduledRunId !== intent.workflowRunId
  ) {
    fail("scheduled projection 未绑定同一 maintain workflowRunId/startedAt");
  }
}

function assertValidProcessedSourcesPlan(
  intent: MaintenanceWorkflowWalIntent,
  verifiedPaths: ReadonlySet<string>,
  pendingPaths: ReadonlySet<string>,
  noop: boolean
): void {
  const fail = (message: string): never => {
    throw new MaintenanceWorkflowWalError("intent_corrupt", message);
  };
  const settings = intent.settings;
  if (!Array.isArray(settings.removedProcessedSourcePaths)) {
    fail("removedProcessedSourcePaths 非法");
  }
  const removedPaths = settings.removedProcessedSourcePaths
    .map(normalizeRelativePath);
  if (new Set(removedPaths).size !== removedPaths.length) {
    fail("removedProcessedSourcePaths 含重复项");
  }
  const removed = new Set(removedPaths);
  for (const [key, source] of Object.entries(settings.baselineProcessedSources)) {
    assertValidProcessedSourceValue(key, source, "baseline processed source");
  }
  for (const [key, source] of Object.entries(settings.targetProcessedSources)) {
    assertValidProcessedSourceValue(key, source, "target processed source");
  }

  const changed = managedProcessedSourceKeys(settings);
  const allowed = new Set([...verifiedPaths, ...removed]);
  if (
    changed.length !== allowed.size
    || changed.some((key) => !allowed.has(key))
  ) {
    fail("processedSources 变化必须严格来自 verified 或显式 removal");
  }
  for (const relativePath of removed) {
    if (
      verifiedPaths.has(relativePath)
      || pendingPaths.has(relativePath)
      || !Object.prototype.hasOwnProperty.call(
        settings.baselineProcessedSources,
        relativePath
      )
      || Object.prototype.hasOwnProperty.call(
        settings.targetProcessedSources,
        relativePath
      )
    ) {
      fail(`processedSources removal 非法：${relativePath}`);
    }
  }

  const sourceByPath = new Map(
    intent.verifiedSources.map((source) => [source.relativePath, source])
  );
  for (const relativePath of verifiedPaths) {
    const source = sourceByPath.get(relativePath);
    const target = settings.targetProcessedSources[relativePath];
    const evidence = normalizedUniquePaths(
      intent.evidencePaths[relativePath] ?? []
    );
    if (
      !source
      || !target
      || target.path !== relativePath
      || target.size !== source.size
      || target.mtime !== source.mtime
      || target.fingerprint !== source.fingerprint
      || target.digestedAt !== intent.startedAt
      || target.reportPath !== intent.report.relativePath
      || !sameStringArray(
        normalizedUniquePaths(target.evidencePaths ?? []),
        evidence
      )
      || target.runId !== intent.workflowRunId
      || target.confidence !== "verified"
    ) {
      fail(`verified processedSources target 未严格绑定来源证据：${relativePath}`);
    }
  }
  for (const relativePath of pendingPaths) {
    if (!sameOptionalJsonEntry(
      recordEntry(settings.baselineProcessedSources, relativePath),
      recordEntry(settings.targetProcessedSources, relativePath)
    )) {
      fail(`pending processedSources 不得变化：${relativePath}`);
    }
  }
  if (
    noop
    && (
      removed.size !== 0
      || settings.baselineProcessedSourcesDigest
        !== settings.targetProcessedSourcesDigest
    )
  ) {
    fail("noop workflow 不得改变 processedSources");
  }
}

function assertValidProcessedSourceValue(
  keyInput: string,
  source: KnowledgeBaseProcessedSource,
  label: string
): void {
  const key = normalizeRelativePath(keyInput);
  if (
    !source
    || typeof source !== "object"
    || source.path !== key
    || !Number.isSafeInteger(source.size)
    || source.size < 0
    || !Number.isFinite(source.mtime)
    || source.mtime < 0
    || !Number.isFinite(source.digestedAt)
    || source.digestedAt < 0
    || (
      source.fingerprint !== undefined
      && (
        typeof source.fingerprint !== "string"
        || !source.fingerprint.trim()
        || source.fingerprint.includes("\0")
      )
    )
    || (
      source.runId !== undefined
      && (
        typeof source.runId !== "string"
        || source.runId.includes("\0")
      )
    )
    || (
      source.confidence !== undefined
      && source.confidence !== "verified"
      && source.confidence !== "repaired"
    )
  ) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      `${label} 字段非法：${key}`
    );
  }
  if (source.reportPath !== undefined && source.reportPath !== "") {
    normalizeRelativePath(source.reportPath);
  }
  if (source.evidencePaths !== undefined) {
    if (
      !Array.isArray(source.evidencePaths)
      || new Set(source.evidencePaths).size !== source.evidencePaths.length
    ) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `${label} evidencePaths 非法：${key}`
      );
    }
    for (const evidencePath of source.evidencePaths) {
      normalizeRelativePath(evidencePath);
    }
  }
}

function assertValidState(
  state: MaintenanceWorkflowWalState,
  intent: MaintenanceWorkflowWalIntent
): void {
  const phaseIndex = PHASES.indexOf(state?.phase);
  if (
    !state
    || state.version !== STATE_VERSION
    || state.workflowRunId !== intent.workflowRunId
    || state.intentDigest !== intent.digest
    || !PHASES.includes(state.phase)
    || !Number.isSafeInteger(state.sequence)
    || state.sequence < 0
    || state.sequence < phaseIndex
    || !isIsoDate(state.updatedAt)
    || state.digest !== digestJson(withoutStateDigest(state))
  ) {
    throw new MaintenanceWorkflowWalError("state_corrupt", "workflow WAL state 校验失败");
  }
  const rawLeases = state.managedMetadataSuccessorLeases;
  if (rawLeases !== undefined && !Array.isArray(rawLeases)) {
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      "managed metadata successor lease list 非法"
    );
  }
  const leaseDigests = new Set<string>();
  const leaseCountByPath = new Map<string, number>();
  const immutableWindow = managedMetadataSuccessorPolicyFor(intent).window;
  for (const lease of rawLeases ?? []) {
    const relativePath = normalizeRelativePath(lease.relativePath);
    const writeIndex = intent.managedWrites.findIndex(
      (write) => normalizeRelativePath(write.relativePath) === relativePath
    );
    const createdAtMs = Date.parse(lease.createdAt);
    const { digest: _leaseDigest, ...leaseWithoutDigest } = lease;
    if (
      leaseDigests.has(lease.digest)
      || writeIndex < 0
      || lease.version !== 1
      || lease.intentDigest !== intent.digest
      || lease.entryDigest !== digestJson(derivedManagedJournalEntry(
        intent.workflowRunId,
        intent.managedWrites[writeIndex],
        writeIndex
      ))
      || !Number.isFinite(createdAtMs)
      || createdAtMs > Date.parse(state.updatedAt)
      || lease.window?.lowerBoundMs !== immutableWindow.lowerBoundMs
      || lease.window?.upperBoundMs
        !== createdAtMs + MANAGED_METADATA_SUCCESSOR_WINDOW_MS
      || !isSha256(lease.provenanceDigest)
      || lease.digest !== managedMetadataLeaseDigest(leaseWithoutDigest)
    ) {
      throw new MaintenanceWorkflowWalError(
        "state_corrupt",
        `managed metadata successor lease 非法：${relativePath}`,
        relativePath
      );
    }
    leaseDigests.add(lease.digest);
    const count = (leaseCountByPath.get(relativePath) ?? 0) + 1;
    if (count > 2) {
      throw new MaintenanceWorkflowWalError(
        "state_corrupt",
        `managed metadata successor lease 超出双阶段上限：${relativePath}`,
        relativePath
      );
    }
    leaseCountByPath.set(relativePath, count);
  }
  if ((rawLeases?.length ?? 0) > 0 && phaseIndex < PHASES.indexOf("shadow_committed")) {
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      "shadow commit 前不得存在 managed recovery lease"
    );
  }
  const shadowCommitted = phaseIndex >= PHASES.indexOf("shadow_committed");
  if (shadowCommitted) {
    if (intent.completion === "noop") {
      if (
        state.shadowCommitProof !== undefined
        || !intent.noopProof
        || state.noopConfirmationDigest !== digestJson(intent.noopProof)
      ) {
        throw new MaintenanceWorkflowWalError(
          "state_corrupt",
          "noop WAL state 缺少合法 confirmation"
        );
      }
    } else {
      if (
        state.noopConfirmationDigest !== undefined
        || !state.shadowCommitProof
        || !isSha256(state.shadowCommitProof.applyJournalDigest)
        || !isSha256(state.shadowCommitProof.commitReceipt)
        || !Array.isArray(state.shadowCommitProof.liveTargets)
        || !intent.shadow
      ) {
        throw new MaintenanceWorkflowWalError(
          "state_corrupt",
          "Shadow WAL state 缺少合法 commit proof"
        );
      }
      const targetPaths = new Set<string>();
      for (const target of state.shadowCommitProof.liveTargets) {
        const relativePath = normalizeRelativePath(target.relativePath);
        if (targetPaths.has(relativePath)) {
          throw new MaintenanceWorkflowWalError(
            "state_corrupt",
            `Shadow commit proof target 重复：${relativePath}`
          );
        }
        targetPaths.add(relativePath);
        assertValidCas(target.result, `Shadow commit proof ${relativePath}`);
        const observed = target.observedResult ?? target.result;
        assertValidCas(
          observed,
          `Shadow observed commit proof ${relativePath}`
        );
        if (target.metadataSuccessor) {
          const successor = target.metadataSuccessor;
          if (
            normalizeRelativePath(successor.relativePath) !== relativePath
            || successor.result.kind !== "file"
            || !sameCas(observed, successor.result)
            || !Number.isFinite(successor.updatedAt)
            || !isSha256(successor.projectionDigest)
          ) {
            throw new MaintenanceWorkflowWalError(
              "state_corrupt",
              `Shadow observed successor proof 非法：${relativePath}`
            );
          }
        } else if (!sameCas(observed, target.result)) {
          throw new MaintenanceWorkflowWalError(
            "state_corrupt",
            `Shadow observed CAS 缺少 successor proof：${relativePath}`
          );
        }
      }
      const expectedTargetPaths = new Set(
        intent.shadow.expectedAppliedPaths.map(normalizeRelativePath)
      );
      if (
        targetPaths.size !== expectedTargetPaths.size
        || Array.from(targetPaths).some(
          (relativePath) => !expectedTargetPaths.has(relativePath)
        )
      ) {
        throw new MaintenanceWorkflowWalError(
          "state_corrupt",
          "Shadow commit proof targets 与 intent 不一致"
        );
      }
    }
  } else if (
    state.shadowCommitProof !== undefined
    || state.noopConfirmationDigest !== undefined
  ) {
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      "prepared WAL 不得预先携带 postcommit proof"
    );
  }
  const settingsCommitted = phaseIndex >= PHASES.indexOf("settings_committed");
  if (settingsCommitted) {
    if (
      typeof state.settingsGeneration !== "string"
      || !state.settingsGeneration.trim()
      || state.settingsGeneration.includes("\0")
      || state.settingsGeneration.length > 512
      || !isSha256(state.settingsTargetProjectionDigest)
    ) {
      throw new MaintenanceWorkflowWalError(
        "state_corrupt",
        "settings_committed WAL 缺少 generation/projection proof"
      );
    }
  } else if (
    state.settingsGeneration !== undefined
    || state.settingsTargetProjectionDigest !== undefined
  ) {
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      "settings 提交前 WAL 不得携带 settings proof"
    );
  }
  if (state.blocked) {
    requireNonEmptyText(state.blocked.code, "blocked code", 160);
    requireNonEmptyText(state.blocked.message, "blocked message", 4000);
    if (!isIsoDate(state.blocked.blockedAt)) {
      throw new MaintenanceWorkflowWalError("state_corrupt", "workflow blockedAt 非法");
    }
  }
}

async function assertIntentBoundToLocation(
  location: MaintenanceWorkflowWalLocation,
  intent: MaintenanceWorkflowWalIntent
): Promise<void> {
  if (!intent.shadow) {
    if (intent.completion === "noop" && intent.noopProof) return;
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "非 noop workflow 缺少 Shadow location binding"
    );
  }
  const controlRootPath = path.resolve(intent.shadow.controlRootPath);
  if (
    intent.shadow.controlRootPath === controlRootPath
    && (
      controlRootPath === location.storageRootPath
      || controlRootPath.startsWith(`${location.storageRootPath}${path.sep}`)
    )
  ) {
    return;
  }
  try {
    await ensurePlainDescendantDirectory(
      location.storageRootPath,
      intent.shadow.controlRootPath,
      "Shadow controlRootPath"
    );
  } catch {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      "Shadow controlRootPath 不在 maintenance storage root 内"
    );
  }
}

async function validateIntentBlobs(
  location: MaintenanceWorkflowWalLocation,
  intent: MaintenanceWorkflowWalIntent
): Promise<void> {
  const expected = new Map<string, MaintenanceWorkflowCasFile>();
  for (const write of intent.managedWrites) {
    if (write.operation !== "upsert" || write.desired.kind !== "file" || !write.blobDigest) continue;
    expected.set(write.blobDigest, write.desired);
    if (
      write.expectedBlobDigest
      && write.expected.kind === "file"
    ) {
      expected.set(write.expectedBlobDigest, write.expected);
    }
  }
  const entries = await fsp.readdir(location.blobRootPath, { withFileTypes: true });
  const expectedNames = new Set(Array.from(expected.keys(), blobFileName));
  for (const entry of entries) {
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || !expectedNames.has(entry.name)
    ) {
      throw new MaintenanceWorkflowWalError(
        "blob_corrupt",
        `workflow blob 目录含未知或不安全条目：${entry.name}`
      );
    }
  }
  if (entries.length !== expected.size) {
    throw new MaintenanceWorkflowWalError("blob_corrupt", "workflow blob 数量不匹配");
  }
  for (const [digest, desired] of expected) {
    const content = await readIndependentRegularFile(
      path.join(location.blobRootPath, blobFileName(digest)),
      "workflow blob",
      MAX_BLOB_BYTES
    );
    if (sha256(content) !== digest || content.byteLength !== desired.size) {
      throw new MaintenanceWorkflowWalError("blob_corrupt", `workflow blob 校验失败：${digest}`);
    }
    const writes = intent.managedWrites.filter(
      (write) => write.blobDigest === digest && write.kind === "raw-metadata"
    );
    for (const write of writes) {
      const record = rawDigestRecordFromMarkdown(content);
      const proof = write.rawMetadataProof;
      if (
        !write.rawBodyDigest
        || sha256(markdownBodyBytes(content, write.relativePath)) !== write.rawBodyDigest
        || !write.rawUnmanagedFrontmatterDigest
        || sha256(rawDigestUserFrontmatterProjectionBytes(content))
          !== write.rawUnmanagedFrontmatterDigest
        || !proof
        || !record
        || !rawDigestRecordIsTrusted(record, proof.fingerprint)
        || rawDigestFingerprint(write.relativePath, content)
          !== proof.fingerprint
        || stableStringify({
          processed: record.processed,
          status: record.status,
          fingerprint: record.fingerprint,
          digestedAt: record.digestedAt,
          reportPath: normalizeRelativePath(record.reportPath),
          evidencePaths: record.evidencePaths.map(normalizeRelativePath)
        }) !== stableStringify(proof)
      ) {
        throw new MaintenanceWorkflowWalError(
          "blob_corrupt",
          `Raw metadata blob 正文、用户 frontmatter 或 proof 不匹配：${write.relativePath}`,
          write.relativePath
        );
      }
    }
    const registryWrites = intent.managedWrites.filter(
      (write) => write.blobDigest === digest && write.kind === "raw-registry"
    );
    for (const write of registryWrites) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content.toString("utf8"));
      } catch (error) {
        throw new MaintenanceWorkflowWalError(
          "blob_corrupt",
          `Raw registry blob 不是合法 JSON：${errorMessage(error)}`,
          write.relativePath
        );
      }
      const registry = normalizeRawDigestRegistry(parsed);
      const proof = write.rawRegistryProof;
      const computedProof = {
        schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
        updatedAt: registry.updatedAt,
        entriesDigest: digestJson(registry.entries),
        entries: registry.entries,
        ...(proof?.canonicalBytes === true ? { canonicalBytes: true as const } : {})
      };
      const canonicalBytes = buildCanonicalRawDigestRegistryContent(registry)
        .equals(content);
      const legacyOrderedBytes = proof?.canonicalBytes === undefined
        && legacyRawRegistryBytesMatch(content, parsed, registry);
      if (
        !proof
        || (!canonicalBytes && !legacyOrderedBytes)
        || stableStringify(proof) !== stableStringify(computedProof)
      ) {
        throw new MaintenanceWorkflowWalError(
          "blob_corrupt",
          `Raw registry blob 与 durable proof 不匹配：${write.relativePath}`,
          write.relativePath
        );
      }
    }
  }
}

function legacyRawRegistryBytesMatch(
  content: Buffer,
  parsed: unknown,
  registry: ReturnType<typeof normalizeRawDigestRegistry>
): boolean {
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) return false;
  const record = parsed as Record<string, unknown>;
  const rawEntries = record.entries;
  if (
    record.schemaVersion !== RAW_DIGEST_SCHEMA_VERSION
    || record.updatedAt !== registry.updatedAt
    || !rawEntries
    || typeof rawEntries !== "object"
    || Array.isArray(rawEntries)
    || !sameStringArray(
      Object.keys(record).sort(compareCanonicalText),
      ["entries", "schemaVersion", "updatedAt"].sort(compareCanonicalText)
    )
  ) return false;
  const orderedEntries: Record<string, RawDigestRegistryEntry> = {};
  const sourceKeys = Object.keys(rawEntries);
  if (sourceKeys.length !== Object.keys(registry.entries).length) return false;
  for (const key of sourceKeys) {
    const relativePath = normalizeRelativePath(key);
    if (relativePath !== key || !registry.entries[relativePath]) return false;
    orderedEntries[relativePath] = registry.entries[relativePath]!;
  }
  return Buffer.from(`${JSON.stringify({
    schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
    updatedAt: registry.updatedAt,
    entries: orderedEntries
  }, null, 2)}\n`, "utf8").equals(content);
}

async function readStateOrNull(
  statePath: string
): Promise<MaintenanceWorkflowWalState | null> {
  try {
    return JSON.parse(
      (await readIndependentRegularFile(
        statePath,
        "workflow state",
        MAX_CONTROL_FILE_BYTES
      )).toString("utf8")
    ) as MaintenanceWorkflowWalState;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof MaintenanceWorkflowWalError) throw error;
    throw new MaintenanceWorkflowWalError(
      "state_corrupt",
      `workflow WAL state 无法解析：${errorMessage(error)}`
    );
  }
}

async function writeContentAddressedBlob(
  blobRootPath: string,
  digest: string,
  content: Buffer
): Promise<void> {
  if (sha256(content) !== digest || content.byteLength > MAX_BLOB_BYTES) {
    throw new MaintenanceWorkflowWalError("blob_corrupt", `待写 blob 校验失败：${digest}`);
  }
  const blobPath = path.join(blobRootPath, blobFileName(digest));
  const existing = await fsp.lstat(blobPath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (existing) {
    const current = await readIndependentRegularFile(blobPath, "workflow blob", MAX_BLOB_BYTES);
    if (sha256(current) !== digest || !current.equals(content)) {
      throw new MaintenanceWorkflowWalError("blob_corrupt", `已存在 blob 内容不匹配：${digest}`);
    }
    return;
  }
  await writeBufferDurably(blobPath, content, 0o600, false);
}

function blobFileName(digest: string): string {
  if (!isSha256(digest)) {
    throw new MaintenanceWorkflowWalError("blob_corrupt", `blob digest 非法：${digest}`);
  }
  return `${digest.slice("sha256:".length)}.blob`;
}

async function writeJsonDurably(absolutePath: string, value: unknown): Promise<void> {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (content.byteLength > MAX_CONTROL_FILE_BYTES) {
    throw new MaintenanceWorkflowWalError("unsafe_entry", `control JSON 过大：${absolutePath}`);
  }
  await writeBufferDurably(absolutePath, content, 0o600, true);
  const readBack = await readIndependentRegularFile(
    absolutePath,
    "durable control JSON",
    MAX_CONTROL_FILE_BYTES
  );
  if (!readBack.equals(content)) {
    throw new MaintenanceWorkflowWalError("state_corrupt", `control JSON readback 不一致：${absolutePath}`);
  }
}

async function writeBufferDurably(
  absolutePath: string,
  content: Buffer,
  mode: number,
  replace: boolean
): Promise<void> {
  const parentPath = path.dirname(absolutePath);
  await assertPlainExistingDirectory(parentPath, "durable write parent");
  const tempPath = path.join(
    parentPath,
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`
  );
  const output = await fsp.open(
    tempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    mode
  );
  try {
    await output.writeFile(content);
    await output.chmod(mode);
    await output.sync();
  } finally {
    await output.close();
  }
  try {
    if (!replace) {
      await fsp.link(tempPath, absolutePath);
      await fsp.unlink(tempPath);
    } else {
      await fsp.rename(tempPath, absolutePath);
    }
    await syncDirectory(parentPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readIndependentRegularFile(
  absolutePath: string,
  label: string,
  maxBytes: number,
  allowedLinkCounts: readonly number[] = [1]
): Promise<Buffer> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(absolutePath, fsConstants.O_RDONLY | noFollowFlag());
  } catch (error) {
    throw error;
  }
  try {
    const before = await handle.stat();
    assertSafeRegularStat(before, label, allowedLinkCounts);
    if (before.size > maxBytes) {
      throw new MaintenanceWorkflowWalError("unsafe_entry", `${label} 超过安全读取上限`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!sameOpenFileVersion(before, after) || content.byteLength !== before.size) {
      throw new MaintenanceWorkflowWalError("unsafe_entry", `${label} 在读取时发生变化`);
    }
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensurePlainDirectory(
  absolutePathInput: string,
  label: string,
  create = false
): Promise<string> {
  const absolutePath = path.resolve(absolutePathInput);
  if (create) {
    await fsp.mkdir(absolutePath, { recursive: true, mode: 0o700 });
  }
  await assertPlainExistingDirectory(absolutePath, label);
  return path.resolve(await fsp.realpath(absolutePath));
}

async function assertPlainExistingDirectory(
  absolutePath: string,
  label: string
): Promise<void> {
  const stat = await fsp.lstat(absolutePath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MaintenanceWorkflowWalError("unsafe_entry", `${label} 不是安全目录`);
  }
}

async function ensurePlainDescendantDirectory(
  rootPathInput: string,
  absolutePathInput: string,
  label: string
): Promise<string> {
  const requestedRootPath = path.resolve(rootPathInput);
  const rootPath = await ensurePlainDirectory(rootPathInput, `${label} root`);
  const absolutePath = path.resolve(absolutePathInput);
  const traversalRoot = (
    absolutePath === requestedRootPath
    || absolutePath.startsWith(`${requestedRootPath}${path.sep}`)
  )
    ? requestedRootPath
    : (
      absolutePath === rootPath
      || absolutePath.startsWith(`${rootPath}${path.sep}`)
    )
      ? rootPath
      : null;
  if (absolutePathInput !== absolutePath || !traversalRoot) {
    throw new MaintenanceWorkflowWalError(
      "invalid_path",
      `${label} 越出可信 root`
    );
  }
  const relative = path.relative(traversalRoot, absolutePath);
  let current = traversalRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    if (!segment || segment === "." || segment === "..") {
      throw new MaintenanceWorkflowWalError(
        "invalid_path",
        `${label} 路径片段非法`
      );
    }
    current = path.join(current, segment);
    await assertPlainExistingDirectory(current, label);
  }
  const canonicalPath = path.resolve(await fsp.realpath(absolutePath));
  if (
    canonicalPath !== rootPath
    && !canonicalPath.startsWith(`${rootPath}${path.sep}`)
  ) {
    throw new MaintenanceWorkflowWalError(
      "invalid_path",
      `${label} 越出可信 root`
    );
  }
  return canonicalPath;
}

async function ensureSafeParentDirectory(
  rootPathInput: string,
  relativeDirectoryInput: string
): Promise<void> {
  if (!relativeDirectoryInput || relativeDirectoryInput === ".") return;
  const rootPath = path.resolve(rootPathInput);
  const relativeDirectory = normalizeRelativePath(relativeDirectoryInput);
  let current = rootPath;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    const stat = await fsp.lstat(current).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!stat) {
      await fsp.mkdir(current, { mode: 0o755 });
      await syncDirectory(path.dirname(current));
      const created = await fsp.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new MaintenanceWorkflowWalError("unsafe_entry", `新建父目录不安全：${current}`);
      }
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MaintenanceWorkflowWalError("unsafe_entry", `父目录链不安全：${current}`);
    }
  }
}

async function assertSafeExistingParentChainOrMissing(
  rootPathInput: string,
  relativeDirectoryInput: string
): Promise<boolean> {
  return (
    await captureSafeDirectoryChain(rootPathInput, relativeDirectoryInput)
  ).complete;
}

interface SafeDirectoryIdentity {
  absolutePath: string;
  dev: number;
  ino: number;
}

interface SafeDirectoryChain {
  rootPath: string;
  relativeDirectory: string;
  complete: boolean;
  identities: SafeDirectoryIdentity[];
}

async function captureSafeDirectoryChain(
  rootPathInput: string,
  relativeDirectoryInput: string
): Promise<SafeDirectoryChain> {
  const rootPath = path.resolve(rootPathInput);
  const rootStat = await fsp.lstat(rootPath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new MaintenanceWorkflowWalError(
      "unsafe_entry",
      `可信 root 不是安全目录：${rootPath}`
    );
  }
  const identities: SafeDirectoryIdentity[] = [{
    absolutePath: rootPath,
    dev: Number(rootStat.dev),
    ino: Number(rootStat.ino)
  }];
  if (!relativeDirectoryInput || relativeDirectoryInput === ".") {
    return {
      rootPath,
      relativeDirectory: ".",
      complete: true,
      identities
    };
  }
  const relativeDirectory = normalizeRelativePath(relativeDirectoryInput);
  let current = rootPath;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      return {
        rootPath,
        relativeDirectory,
        complete: false,
        identities
      };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MaintenanceWorkflowWalError(
        "unsafe_entry",
        `父目录链不安全：${current}`
      );
    }
    identities.push({
      absolutePath: current,
      dev: Number(stat.dev),
      ino: Number(stat.ino)
    });
  }
  return {
    rootPath,
    relativeDirectory,
    complete: true,
    identities
  };
}

async function assertSafeDirectoryChainUnchanged(
  chain: SafeDirectoryChain
): Promise<void> {
  for (const identity of chain.identities) {
    const stat = await lstatOrNull(identity.absolutePath);
    if (
      !stat
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || Number(stat.dev) !== identity.dev
      || Number(stat.ino) !== identity.ino
    ) {
      throw new MaintenanceWorkflowWalError(
        "unsafe_entry",
        `父目录链在操作期间被替换：${identity.absolutePath}`
      );
    }
  }
  if (chain.complete) {
    const refreshed = await captureSafeDirectoryChain(
      chain.rootPath,
      chain.relativeDirectory
    );
    if (
      !refreshed.complete
      || refreshed.identities.length !== chain.identities.length
      || refreshed.identities.some((identity, index) => (
        identity.dev !== chain.identities[index]?.dev
        || identity.ino !== chain.identities[index]?.ino
      ))
    ) {
      throw new MaintenanceWorkflowWalError(
        "unsafe_entry",
        "父目录链 inode 在操作期间发生变化"
      );
    }
  }
}

function resolveInsideRoot(rootPathInput: string, relativePathInput: string): string {
  const rootPath = path.resolve(rootPathInput);
  const relativePath = normalizeRelativePath(relativePathInput);
  const absolutePath = path.resolve(rootPath, ...relativePath.split("/"));
  if (!absolutePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new MaintenanceWorkflowWalError(
      "invalid_path",
      `路径越界：${relativePath}`,
      relativePath
    );
  }
  return absolutePath;
}

function normalizeRelativePath(input: string): string {
  if (
    typeof input !== "string"
    || !input
    || input !== input.trim()
    || input.includes("\0")
    || input.includes("\\")
  ) {
    throw new MaintenanceWorkflowWalError("invalid_path", `非法相对路径：${String(input)}`);
  }
  const normalized = input;
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new MaintenanceWorkflowWalError("invalid_path", `路径必须是安全相对路径：${input}`);
  }
  return normalized;
}

function normalizedUniquePaths(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeRelativePath)))
    .sort(compareCanonicalText);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCas(
  left: MaintenanceWorkflowFileCas,
  right: MaintenanceWorkflowFileCas
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" || right.kind === "missing") return true;
  return left.sha256 === right.sha256
    && left.size === right.size
    && normalizeMode(left.mode) === normalizeMode(right.mode);
}

function cloneCas(value: MaintenanceWorkflowFileCas): MaintenanceWorkflowFileCas {
  return value.kind === "missing"
    ? { kind: "missing" }
    : {
      kind: "file",
      sha256: value.sha256,
      size: value.size,
      mode: normalizeMode(value.mode)
    };
}

function assertValidCas(value: MaintenanceWorkflowFileCas, label: string): void {
  if (!value || (value.kind !== "missing" && value.kind !== "file")) {
    throw new MaintenanceWorkflowWalError("intent_corrupt", `${label} CAS 非法`);
  }
  if (value.kind === "file") {
    if (
      !isSha256(value.sha256)
      || !Number.isSafeInteger(value.size)
      || value.size < 0
      || value.size > MAX_BLOB_BYTES
      || !Number.isSafeInteger(value.mode)
      || normalizeMode(value.mode) !== value.mode
    ) {
      throw new MaintenanceWorkflowWalError("intent_corrupt", `${label} file CAS 非法`);
    }
  }
}

function casLabel(value: MaintenanceWorkflowFileCas): string {
  return value.kind === "missing"
    ? "missing"
    : `${value.sha256}/${value.size}/${value.mode.toString(8)}`;
}

function normalizeMode(mode: number): number {
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw new MaintenanceWorkflowWalError("intent_corrupt", `非法文件 mode：${mode}`);
  }
  return mode & 0o777;
}

function assertSafeRegularStat(
  stat: Stats,
  label: string,
  allowedLinkCounts: readonly number[] = [1]
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !allowedLinkCounts.includes(stat.nlink)
  ) {
    throw new MaintenanceWorkflowWalError("unsafe_entry", `${label} 不是独立普通文件`);
  }
}

function sameOpenFileVersion(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directory: fsp.FileHandle | undefined;
  try {
    directory = await fsp.open(directoryPath, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32"
      || !["EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")
    ) {
      throw error;
    }
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function makeTreeOwnerWritable(absolutePath: string): Promise<void> {
  const stat = await fsp.lstat(absolutePath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fsp.chmod(absolutePath, 0o700).catch(() => undefined);
    for (const child of await fsp.readdir(absolutePath).catch(() => [])) {
      await makeTreeOwnerWritable(path.join(absolutePath, child));
    }
  } else if (stat.isFile()) {
    await fsp.chmod(absolutePath, 0o600).catch(() => undefined);
  }
}

function sha256(content: Buffer | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return sha256(Buffer.from(stableStringify(value), "utf8"));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * Durable record ordering must not inherit the host language. `localeCompare`
 * can order the same Chinese and Latin paths differently after an Obsidian or
 * process locale change, which made otherwise intact legacy WALs unreadable.
 */
function compareCanonicalText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function vaultFingerprint(liveVaultPath: string): string {
  return sha256(Buffer.from(path.resolve(liveVaultPath), "utf8"));
}

function assertValidSourceRecord(
  source: MaintenanceWorkflowSourceRecord,
  label: string
): string {
  if (!source || typeof source !== "object") {
    throw new MaintenanceWorkflowWalError("intent_corrupt", `${label} 非法`);
  }
  const relativePath = normalizeRelativePath(source.relativePath);
  if (
    !Number.isSafeInteger(source.size)
    || source.size < 0
    || !Number.isFinite(source.mtime)
    || source.mtime < 0
  ) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      `${label} size/mtime 非法：${relativePath}`
    );
  }
  requireNonEmptyText(source.fingerprint, `${label} fingerprint`, 512);
  return relativePath;
}

function assertValidTerminalSettings(
  terminal: MaintenanceWorkflowTerminalSettings,
  label: string
): void {
  if (
    !terminal
    || !Number.isFinite(terminal.lastRunAt)
    || terminal.lastRunAt < 0
    || !["idle", "running", "success", "failed", "canceled"].includes(
      terminal.lastRunStatus
    )
    || !["", "full", "partial", "recovered", "noop"].includes(
      terminal.lastCompletion
    )
    || !Array.isArray(terminal.lastAttempts)
    || !Array.isArray(terminal.lastPendingSources)
    || !Array.isArray(terminal.lastWarnings)
  ) {
    throw new MaintenanceWorkflowWalError(
      "intent_corrupt",
      `${label} 字段非法`
    );
  }
  for (const [field, value] of Object.entries({
    lastReportPath: terminal.lastReportPath,
    lastError: terminal.lastError,
    lastSummary: terminal.lastSummary,
    lastFailureCode: terminal.lastFailureCode
  })) {
    if (
      typeof value !== "string"
      || value.includes("\0")
      || value.length > 128_000
    ) {
      throw new MaintenanceWorkflowWalError(
        "intent_corrupt",
        `${label}.${field} 非法`
      );
    }
  }
  for (const relativePath of terminal.lastPendingSources) {
    normalizeRelativePath(relativePath);
  }
}

function requireNonEmptyText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.includes("\0")
    || value.length > maxLength
  ) {
    throw new MaintenanceWorkflowWalError("intent_corrupt", `${label} 非法`);
  }
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isAgentBackendKind(value: unknown): value is AgentBackendKind {
  return value === "codex-cli" || value === "opencode" || value === "hermes";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? ""
  );
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  return await fsp.lstat(absolutePath).catch((error) => {
    if (isNotFound(error)) return null;
    throw error;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
