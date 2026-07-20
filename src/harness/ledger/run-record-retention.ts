import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  RUN_RECORD_DAY_MS,
  RUN_RECORD_DEFAULT_SUMMARY_RETENTION_DAYS,
  canonicalRunRecordDigest,
  finalizeAttemptPayloadRetirementReceipt,
  finalizeRetentionTombstone,
  previewRunRecordRetention as previewRetentionSubject,
  runRecordSubjectDigest,
  validateRetentionTombstone,
  type AttemptRunSummaryV1,
  type AttemptPayloadRetirementReceiptV1,
  type RunRecordRetentionDecision,
  type RunRecordRetentionHoldReason,
  type RunRetentionTombstoneScope,
  type RunRetentionTombstoneV1,
  type WorkflowRunSummaryV1
} from "../contracts/run-record";
import {
  coordinateRecordMutationTrashAuthorityFinalize,
  coordinateRecordMutationTrashAuthorityPrepare,
  inspectRecordMutationTrashAuthorityFinalization,
  withRecordMutationGlobalAuthority
} from "../lifecycle/record-mutation-coordinator";
import {
  parseRecordMutationTrashFinalizationReceipt,
  parseRecordMutationTrashReceipt,
  type RecordMutationTrashFinalizationReceipt,
  type RecordMutationTrashReceipt
} from "../lifecycle/record-mutation-trash";
import {
  assertDurableDirectoryStat,
  DurableAppendOnlyCasError,
  durableAppendOnlyChainPath,
  durableLstatOrNull,
  publishDurableAppendOnlyChain,
  publishDurableAppendOnlyEntry,
  readDurableRegularFile,
  resolveDurableAppendOnlyLayout,
  validateDurableRelativePath,
  type DurableAppendOnlyLayout
} from "../storage/durable-append-only-cas";
import {
  parseRecordRootBindingRef,
  sameRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  FileRunRecordStore,
  RunRecordStoreConflictError,
  type ConversationAttemptPayloadInventory,
  type ConversationAttemptRunInventory,
  type ConversationWorkflowRunInventory,
  type RunRecordStoreInventory
} from "./run-record-store";

export const RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY =
  "run-record-retention-transactions-v1";

const RUN_RECORD_RETENTION_SCHEMA_VERSION = 1;
const RUN_RECORD_RETENTION_MAX_PLAN_BYTES = 2 * 1024 * 1024;
const RUN_RECORD_RETENTION_MAX_STEP_BYTES = 64 * 1024;
const RUN_RECORD_RETENTION_MAX_SUBJECTS = 4_096;
const PLAN_FILE_NAME = "plan.json";
const STEP_FILE_PATTERN = /^step-([0-9]{6})\.json$/;
const EXECUTION_FILE_PATTERN = /^execution-([0-9]{6})\.json$/;
const PREPARED_FILE_PATTERN = /^prepared-([0-9]{6})\.json$/;
const FINALIZATION_FILE_PATTERN = /^finalization-([0-9]{6})\.json$/;
const RETENTION_CHAIN_TOKEN_PATTERN = /^retention-[a-f0-9]{24}$/;
const SAFE_TRANSACTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_RECORD_GENERATION_PATTERN =
  /^\d{12}-[a-f0-9]{16}-[a-f0-9-]{36}$/;

export type RunRecordRetentionErrorCode =
  | "invalid-input"
  | "inventory-drift"
  | "inventory-blocked"
  | "plan-conflict"
  | "journal-corrupt"
  | "effect-conflict";

export class RunRecordRetentionError extends Error {
  constructor(
    public readonly code: RunRecordRetentionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RunRecordRetentionError";
  }
}

export type RunRecordRetentionSubjectState =
  | "present"
  | "expired"
  | "not-captured"
  | "missing";

export type RunRecordRetentionSubjectDecision =
  | RunRecordRetentionDecision
  | "already-expired"
  | "not-captured"
  | "blocked";

export interface RunRecordRetentionSubjectV1 {
  subjectKey: string;
  scope: RunRetentionTombstoneScope;
  workflowRunId: string;
  attemptId?: string;
  harnessRunId?: string;
  state: RunRecordRetentionSubjectState;
  recordDigest: string | null;
  revision: number | null;
  terminalAt: number | null;
  retentionDays: number | null;
  expiresAt: number | null;
  holdReasons: RunRecordRetentionHoldReason[];
  decision: RunRecordRetentionSubjectDecision;
}

export interface RunRecordRetentionActionV1 {
  ordinal: number;
  subjectKey: string;
  tombstone: RunRetentionTombstoneV1;
  digest: string;
}

export interface RunRecordRetentionPlanV1 {
  schemaVersion: typeof RUN_RECORD_RETENTION_SCHEMA_VERSION;
  recordType: "run-record-retention-plan";
  transactionId: string;
  createdAt: number;
  sourceSnapshotDigest: string;
  sourceInventoryDigest: string;
  subjects: RunRecordRetentionSubjectV1[];
  actions: RunRecordRetentionActionV1[];
  blockers: string[];
  automaticActionAllowed: boolean;
  digest: string;
}

export type RunRecordRetentionStepPhase =
  | "trash-prepared"
  | "tombstone-published"
  | "source-retired";

export interface RunRecordRetentionStepV1 {
  schemaVersion: typeof RUN_RECORD_RETENTION_SCHEMA_VERSION;
  recordType: "run-record-retention-step";
  transactionId: string;
  planDigest: string;
  ordinal: number;
  actionOrdinal: number;
  actionDigest: string;
  phase: RunRecordRetentionStepPhase;
  evidenceDigest: string;
  previousDigest: string;
  committedAt: number;
  digest: string;
}

export interface RunRecordRetentionPreviewInput {
  storageRootPath: string;
  transactionId: string;
  now: number;
  recoveryEvidenceAuthority: RunRecordRetentionRecoveryEvidenceAuthority;
}

export type RunRecordRetentionHoldSnapshot = Readonly<
  Record<string, readonly RunRecordRetentionHoldReason[]>
>;

export interface RunRecordRetentionRecoveryEvidenceAuthority {
  withStableHolds<T>(
    action: (holds: RunRecordRetentionHoldSnapshot) => Promise<T>
  ): Promise<T>;
}

export type RunRecordRetentionFaultPoint =
  | "after-journal-create"
  | "after-execution-header"
  | "after-trash-prepare"
  | "after-trash-prepared-progress"
  | "after-tombstone-publish"
  | "after-source-retired"
  | "after-retirement-receipt-publish"
  | "after-progress-publish";

export interface ExecuteRunRecordRetentionInput {
  storageRootPath: string;
  plan: RunRecordRetentionPlanV1;
  recoveryEvidenceAuthority: RunRecordRetentionRecoveryEvidenceAuthority;
  retirementRoots?: RunRecordRetentionRetirementRoots;
  faultInjector?: (
    point: RunRecordRetentionFaultPoint,
    ordinal: number
  ) => void | Promise<void>;
}

export interface RunRecordRetentionExecutionResult {
  transactionId: string;
  planDigest: string;
  applied: number;
  total: number;
  state: "completed";
}

export interface RecoverStartedRunRecordRetentionInput {
  storageRootPath: string;
  recoveryEvidenceAuthority: RunRecordRetentionRecoveryEvidenceAuthority;
  retirementRoots?: RunRecordRetentionRetirementRoots;
  resolveRetirementRoots?():
    Promise<RunRecordRetentionRetirementRoots>;
  faultInjector?: ExecuteRunRecordRetentionInput["faultInjector"];
}

export interface RunRecordRetentionRetirementRoots {
  sourceRootPath: string;
  sourceBoundaryRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootPath: string;
  trashBoundaryRootPath: string;
  trashRootBinding: RecordRootBindingRef;
}

export interface RunRecordRetentionExecutionHeaderV1 {
  schemaVersion: typeof RUN_RECORD_RETENTION_SCHEMA_VERSION;
  recordType: "run-record-retention-execution-header";
  transactionId: string;
  planDigest: string;
  actionOrdinal: number;
  actionDigest: string;
  trashMutationId: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  sourceRelativePath: string;
  priorGeneration: string;
  priorGenerationManifestDigest: string;
  priorPayloadDigest: string;
  payloadSha256: string;
  createdAt: number;
  digest: string;
}

interface LoadedRetentionJournal {
  layout: DurableAppendOnlyLayout;
  chainToken: string;
  plan: RunRecordRetentionPlanV1;
  steps: RunRecordRetentionStepV1[];
  executionHeaders: Map<number, RunRecordRetentionExecutionHeaderV1>;
  preparedReceipts: Map<number, RecordMutationTrashReceipt>;
  finalizationReceipts: Map<number, RecordMutationTrashFinalizationReceipt>;
  created: boolean;
}

export interface RunRecordRetentionJournalSnapshotInput {
  chainToken: string;
  files: readonly {
    name: string;
    value: unknown;
  }[];
}

export interface RunRecordRetentionJournalInspection {
  planDigest: string;
  transactionDigest: string;
  createdAt: number;
  actionCount: number;
  stepCount: number;
  completedActionCount: number;
  pendingActionCount: number;
  executionHeaderCount: number;
  preparedReceiptCount: number;
  finalizationReceiptCount: number;
}

/**
 * Produces a metadata-only, twice-stable global retention plan. It does not
 * publish a journal, tombstone, Trash receipt, move, or deletion.
 */
export async function previewRunRecordRetentionSweep(
  input: RunRecordRetentionPreviewInput
): Promise<RunRecordRetentionPlanV1> {
  const storageRootPath = requireAbsolutePath(
    input.storageRootPath,
    "storageRootPath"
  );
  const transactionId = requireTransactionId(input.transactionId);
  const now = requireTimestamp(input.now, "now");
  const store = new FileRunRecordStore({ storageRootPath });
  return await requireRecoveryEvidenceAuthority(
    input.recoveryEvidenceAuthority
  ).withStableHolds(async (holdSnapshot) => {
    const additionalHolds = normalizeAdditionalHolds(holdSnapshot);
    const first = await store.inventoryRunRecords();
    const second = await store.inventoryRunRecords();
    if (first.snapshotDigest !== second.snapshotDigest) {
      throw new RunRecordRetentionError(
        "inventory-drift",
        "Run Record Store changed between the two retention inventory scans"
      );
    }
    return buildRetentionPlan(
      transactionId,
      now,
      second,
      additionalHolds
    );
  });
}

/**
 * Applies the immutable plan in payload -> Attempt summary -> Workflow summary
 * order. The append-only transaction journal makes a crash after a tombstone
 * but before progress publication safely replayable.
 */
export async function executeRunRecordRetentionSweep(
  input: ExecuteRunRecordRetentionInput
): Promise<RunRecordRetentionExecutionResult> {
  const storageRootPath = requireAbsolutePath(
    input.storageRootPath,
    "storageRootPath"
  );
  const plan = parseRetentionPlan(input.plan);
  if (!plan.automaticActionAllowed || !plan.actions.length) {
    throw new RunRecordRetentionError(
      "inventory-blocked",
      "Run retention plan does not authorize automatic actions"
    );
  }
  const store = new FileRunRecordStore({ storageRootPath });
  const retirementRoots = plan.actions.some(
    (action) => action.tombstone.scope === "attempt-payload"
  )
    ? parseRetentionRetirementRoots(
        input.retirementRoots,
        storageRootPath,
        store.rootPath
      )
    : undefined;
  return await requireRecoveryEvidenceAuthority(
    input.recoveryEvidenceAuthority
  ).withStableHolds(async (holdSnapshot) => {
    const additionalHolds = normalizeAdditionalHolds(holdSnapshot);
    return await withRecordMutationGlobalAuthority(
      storageRootPath,
      plan.transactionId,
      async () => await store.withMutation(async () => {
        const journal = await loadOrCreateRetentionJournal(
          storageRootPath,
          plan
        );
        if (journal.created) {
          await input.faultInjector?.("after-journal-create", -1);
        }
        await executeRetentionJournal({
          store,
          journal,
          retirementRoots,
          additionalHolds,
          faultInjector: input.faultInjector
        });
        await assertCurrentInventoryMatchesPlan(
          store,
          plan,
          plan.actions.length,
          additionalHolds
        );
        return {
          transactionId: plan.transactionId,
          planDigest: plan.digest,
          applied: plan.actions.length,
          total: plan.actions.length,
          state: "completed"
        };
      })
    );
  });
}

/**
 * Startup recovery only enumerates transactions whose immutable plan.json was
 * already atomically published. It never previews inventory, invents a
 * transaction ID, or creates a new retention sweep.
 */
export async function recoverStartedRunRecordRetentionSweeps(
  input: RecoverStartedRunRecordRetentionInput
): Promise<number> {
  if (input.retirementRoots && input.resolveRetirementRoots) {
    throw invalidInput(
      "Run retention recovery roots must be static or lazily resolved, not both"
    );
  }
  const storageRootPath = requireAbsolutePath(
    input.storageRootPath,
    "storageRootPath"
  );
  const storageRootStat = await durableLstatOrNull(storageRootPath);
  if (!storageRootStat) return 0;
  assertDurableDirectoryStat(
    storageRootStat,
    "Run retention startup storage root"
  );
  const layout = await resolveDurableAppendOnlyLayout(
    storageRootPath,
    RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY,
    false
  );
  if (!layout) return 0;
  const stagingEntries = await readdir(
    layout.stagingRootPath,
    { withFileTypes: true }
  );
  if (stagingEntries.length) {
    throw journalCorrupt(
      "Run retention startup recovery found unresolved staging entries"
    );
  }
  const namespaceEntries = await readdir(
    layout.namespaceRootPath,
    { withFileTypes: true }
  );
  const chainEntries = namespaceEntries.filter(
    (entry) => entry.name !== ".staging"
  );
  if (
    namespaceEntries.some((entry) =>
      entry.isSymbolicLink()
      || (
        entry.name === ".staging"
          ? !entry.isDirectory()
          : (
              !entry.isDirectory()
              || !RETENTION_CHAIN_TOKEN_PATTERN.test(entry.name)
            )
      )
    )
  ) {
    throw journalCorrupt(
      "Run retention startup recovery found an unsafe transaction entry"
    );
  }

  // Validate every existing transaction before the first recovery effect.
  const journals: LoadedRetentionJournal[] = [];
  for (const entry of chainEntries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    journals.push(await loadExistingRetentionJournal(
      layout,
      entry.name
    ));
  }
  const pendingJournals = journals.filter((journal) =>
    completedRetentionActionCount(
      journal.plan,
      journal.steps
    ) !== journal.plan.actions.length
  );
  const requiresRetirementRoots = pendingJournals.some((journal) =>
    journal.plan.actions.some(
      (action) => action.tombstone.scope === "attempt-payload"
    )
  );
  const retirementRoots = input.retirementRoots
    ?? (
      requiresRetirementRoots
        ? await input.resolveRetirementRoots?.()
        : undefined
    );
  let recovered = 0;
  for (const journal of pendingJournals) {
    await executeRunRecordRetentionSweep({
      storageRootPath,
      plan: journal.plan,
      recoveryEvidenceAuthority: input.recoveryEvidenceAuthority,
      ...(retirementRoots
        ? { retirementRoots }
        : {}),
      ...(input.faultInjector
        ? { faultInjector: input.faultInjector }
        : {})
    });
    recovered += 1;
  }
  return recovered;
}

/**
 * Shared strict parser for startup recovery and Storage Inventory. The result
 * is metadata-only; subject IDs, filesystem paths, and root bindings never
 * leave this contract boundary.
 */
export function inspectRunRecordRetentionJournalSnapshot(
  input: RunRecordRetentionJournalSnapshotInput
): RunRecordRetentionJournalInspection {
  if (!RETENTION_CHAIN_TOKEN_PATTERN.test(input.chainToken)) {
    throw journalCorrupt("Run retention chain token is invalid");
  }
  const files = new Map<string, unknown>();
  for (const file of input.files) {
    if (
      typeof file.name !== "string"
      || files.has(file.name)
      || (
        file.name !== PLAN_FILE_NAME
        && !STEP_FILE_PATTERN.test(file.name)
        && !EXECUTION_FILE_PATTERN.test(file.name)
        && !PREPARED_FILE_PATTERN.test(file.name)
        && !FINALIZATION_FILE_PATTERN.test(file.name)
      )
    ) {
      throw journalCorrupt(
        "Run retention journal snapshot contains an unknown file"
      );
    }
    files.set(file.name, file.value);
  }
  const planValue = files.get(PLAN_FILE_NAME);
  if (!planValue) {
    throw journalCorrupt("Run retention journal snapshot lacks plan.json");
  }
  const plan = parseRetentionPlan(planValue);
  if (retentionChainToken(plan.transactionId) !== input.chainToken) {
    throw journalCorrupt(
      "Run retention plan does not match its chain token"
    );
  }
  const expected = expectedRetentionStepDescriptors(plan);
  const steps: RunRecordRetentionStepV1[] = [];
  let previousDigest = plan.digest;
  for (let ordinal = 0; ; ordinal += 1) {
    const name = stepFileName(ordinal);
    const value = files.get(name);
    if (value === undefined) break;
    const descriptor = expected[ordinal];
    const step = parseRetentionStep(value);
    const action = descriptor
      ? plan.actions[descriptor.actionOrdinal]
      : undefined;
    if (
      !descriptor
      || !action
      || step.ordinal !== ordinal
      || step.actionOrdinal !== descriptor.actionOrdinal
      || step.actionDigest !== action.digest
      || step.phase !== descriptor.phase
      || step.previousDigest !== previousDigest
    ) {
      throw journalCorrupt(
        "Run retention journal snapshot step chain is invalid"
      );
    }
    steps.push(step);
    previousDigest = step.digest;
  }
  if (
    [...files.keys()].some((name) => {
      const match = STEP_FILE_PATTERN.exec(name);
      return match && Number(match[1]) >= steps.length;
    })
  ) {
    throw journalCorrupt(
      "Run retention journal snapshot steps are not contiguous"
    );
  }

  const headers = new Map<number, RunRecordRetentionExecutionHeaderV1>();
  const prepared = new Map<number, RecordMutationTrashReceipt>();
  const finalized = new Map<number, RecordMutationTrashFinalizationReceipt>();
  for (const [name, value] of files) {
    const executionMatch = EXECUTION_FILE_PATTERN.exec(name);
    const preparedMatch = PREPARED_FILE_PATTERN.exec(name);
    const finalizationMatch = FINALIZATION_FILE_PATTERN.exec(name);
    if (!executionMatch && !preparedMatch && !finalizationMatch) continue;
    const ordinal = Number(
      executionMatch?.[1] ?? preparedMatch?.[1] ?? finalizationMatch?.[1]
    );
    const action = plan.actions[ordinal];
    if (
      !Number.isSafeInteger(ordinal)
      || !action
      || action.tombstone.scope !== "attempt-payload"
    ) {
      throw journalCorrupt(
        "Run retention journal snapshot evidence action is invalid"
      );
    }
    if (executionMatch) {
      const header = parseRetentionExecutionHeader(value);
      assertExecutionHeaderMatchesPlan(header, plan, action);
      headers.set(ordinal, header);
    } else if (preparedMatch) {
      prepared.set(ordinal, parseRecordMutationTrashReceipt(value));
    } else {
      finalized.set(
        ordinal,
        parseRecordMutationTrashFinalizationReceipt(value)
      );
    }
  }
  for (const action of plan.actions) {
    const actionSteps = retentionActionSteps(steps, action.ordinal);
    if (action.tombstone.scope !== "attempt-payload") {
      if (
        actionSteps[0]
        && actionSteps[0].evidenceDigest !== action.tombstone.digest
      ) {
        throw journalCorrupt(
          "Run retention summary step evidence does not match tombstone"
        );
      }
      continue;
    }
    const header = headers.get(action.ordinal);
    const preparedReceipt = prepared.get(action.ordinal);
    const finalization = finalized.get(action.ordinal);
    if ((preparedReceipt || finalization || actionSteps.length) && !header) {
      throw journalCorrupt(
        "Run retention payload evidence lacks execution header"
      );
    }
    if (header) assertExecutionHeaderMatchesPlan(header, plan, action);
    if (preparedReceipt) {
      assertPreparedReceiptMatchesExecutionHeader(
        preparedReceipt,
        header!
      );
    }
    if (finalization) {
      if (!preparedReceipt) {
        throw journalCorrupt(
          "Run retention finalization lacks prepared receipt"
        );
      }
      assertTrashFinalizationMatchesPrepared(
        finalization,
        preparedReceipt
      );
    }
    for (const step of actionSteps) {
      const expectedEvidence = step.phase === "trash-prepared"
        ? preparedReceipt?.digest
        : step.phase === "tombstone-published"
          ? action.tombstone.digest
          : finalization?.digest;
      if (!expectedEvidence || step.evidenceDigest !== expectedEvidence) {
        throw journalCorrupt(
          "Run retention payload step evidence is incomplete or mismatched"
        );
      }
    }
  }
  const completed = completedRetentionActionCount(plan, steps);
  return {
    planDigest: plan.digest,
    transactionDigest: canonicalRunRecordDigest({
      transactionId: plan.transactionId
    }),
    createdAt: plan.createdAt,
    actionCount: plan.actions.length,
    stepCount: steps.length,
    completedActionCount: completed,
    pendingActionCount: plan.actions.length - completed,
    executionHeaderCount: headers.size,
    preparedReceiptCount: prepared.size,
    finalizationReceiptCount: finalized.size
  };
}

async function executeRetentionJournal(input: {
  store: FileRunRecordStore,
  journal: LoadedRetentionJournal,
  retirementRoots: RunRecordRetentionRetirementRoots | undefined;
  additionalHolds: ReadonlyMap<
    string,
    readonly RunRecordRetentionHoldReason[]
  >;
  faultInjector: ExecuteRunRecordRetentionInput["faultInjector"];
}): Promise<void> {
  const {
    store,
    journal,
    retirementRoots,
    additionalHolds,
    faultInjector
  } = input;
  let previousDigest = journal.steps.at(-1)?.digest ?? journal.plan.digest;
  for (const action of journal.plan.actions) {
    const completedBefore = completedRetentionActionCount(
      journal.plan,
      journal.steps
    );
    if (completedBefore > action.ordinal) continue;
    if (completedBefore < action.ordinal) {
      throw new RunRecordRetentionError(
        "journal-corrupt",
        "Run retention completed actions are not an ordered prefix"
      );
    }
    if (action.tombstone.scope === "attempt-payload") {
      if (!retirementRoots) {
        throw new RunRecordRetentionError(
          "invalid-input",
          "Payload retention requires frozen Run/Trash retirement roots"
        );
      }
      previousDigest = await executePayloadRetentionAction({
        store,
        journal,
        action,
        roots: retirementRoots,
        additionalHolds,
        previousDigest,
        faultInjector
      });
    } else {
      previousDigest = await executeSummaryRetentionAction({
        store,
        journal,
        action,
        additionalHolds,
        previousDigest,
        faultInjector
      });
    }
  }
}

async function executeSummaryRetentionAction(input: {
  store: FileRunRecordStore;
  journal: LoadedRetentionJournal;
  action: RunRecordRetentionActionV1;
  additionalHolds: ReadonlyMap<
    string,
    readonly RunRecordRetentionHoldReason[]
  >;
  previousDigest: string;
  faultInjector: ExecuteRunRecordRetentionInput["faultInjector"];
}): Promise<string> {
  const existing = retentionActionSteps(
    input.journal.steps,
    input.action.ordinal
  );
  if (existing.length) {
    assertActionStepPhases(input.action, existing);
    return existing.at(-1)!.digest;
  }
  const observed = await observeRetentionAction(input.store, input.action);
  if (observed === "pending") {
    await assertCurrentInventoryMatchesPlan(
      input.store,
      input.journal.plan,
      input.action.ordinal,
      input.additionalHolds
    );
    assertNoNewRetentionHolds(
      input.journal.plan,
      input.action,
      input.additionalHolds
    );
    await publishRetentionAction(input.store, input.action);
    await input.faultInjector?.(
      "after-tombstone-publish",
      input.action.ordinal
    );
  }
  await assertRetentionActionApplied(input.store, input.action);
  const step = await appendRetentionStep(
    input.journal,
    input.action,
    "tombstone-published",
    input.action.tombstone.digest,
    input.previousDigest,
    input.action.tombstone.committedAt
  );
  await input.faultInjector?.(
    "after-progress-publish",
    input.action.ordinal
  );
  return step.digest;
}

async function executePayloadRetentionAction(input: {
  store: FileRunRecordStore;
  journal: LoadedRetentionJournal;
  action: RunRecordRetentionActionV1;
  roots: RunRecordRetentionRetirementRoots;
  additionalHolds: ReadonlyMap<
    string,
    readonly RunRecordRetentionHoldReason[]
  >;
  previousDigest: string;
  faultInjector: ExecuteRunRecordRetentionInput["faultInjector"];
}): Promise<string> {
  const {
    store,
    journal,
    action,
    roots,
    additionalHolds,
    faultInjector
  } = input;
  const header = await loadOrCreateRetentionExecutionHeader(
    store,
    journal,
    action,
    roots
  );
  if (!journal.executionHeaders.has(action.ordinal)) {
    journal.executionHeaders.set(action.ordinal, header);
  }
  await faultInjector?.("after-execution-header", action.ordinal);
  let previousDigest = input.previousDigest;
  const existingSteps = retentionActionSteps(
    journal.steps,
    action.ordinal
  );
  assertActionStepPhases(action, existingSteps);

  let prepared = journal.preparedReceipts.get(action.ordinal);
  if (!existingSteps.some((step) => step.phase === "trash-prepared")) {
    if (!prepared) {
      if (await observeRetentionAction(store, action) === "applied") {
        throw new RunRecordRetentionError(
          "journal-corrupt",
          "Payload tombstone exists without durable Trash prepare evidence"
        );
      }
      await assertCurrentInventoryMatchesPlan(
        store,
        journal.plan,
        action.ordinal,
        additionalHolds
      );
      assertNoNewRetentionHolds(
        journal.plan,
        action,
        additionalHolds
      );
      prepared = await coordinateRecordMutationTrashAuthorityPrepare({
        mutationId: header.trashMutationId,
        storageRootPath: journal.layout.storageRootPath,
        sourceRootPath: roots.sourceRootPath,
        sourceBoundaryRootPath: roots.sourceBoundaryRootPath,
        sourceRootBinding: roots.sourceRootBinding,
        sourceRelativePath: header.sourceRelativePath,
        trashRootPath: roots.trashRootPath,
        trashBoundaryRootPath: roots.trashBoundaryRootPath,
        trashRootBinding: roots.trashRootBinding,
        now: () => action.tombstone.committedAt
      });
      assertPreparedReceiptMatchesExecutionHeader(prepared, header);
      await publishRetentionEvidence(
        journal,
        preparedFileName(action.ordinal),
        prepared
      );
      journal.preparedReceipts.set(action.ordinal, prepared);
      await faultInjector?.("after-trash-prepare", action.ordinal);
    } else {
      assertPreparedReceiptMatchesExecutionHeader(prepared, header);
    }
    const step = await appendRetentionStep(
      journal,
      action,
      "trash-prepared",
      prepared.digest,
      previousDigest,
      prepared.stagedAt
    );
    previousDigest = step.digest;
    await faultInjector?.(
      "after-trash-prepared-progress",
      action.ordinal
    );
  } else {
    if (!prepared) {
      throw new RunRecordRetentionError(
        "journal-corrupt",
        "trash-prepared step lacks its durable receipt"
      );
    }
    assertPreparedReceiptMatchesExecutionHeader(prepared, header);
    previousDigest = existingSteps.find(
      (step) => step.phase === "trash-prepared"
    )!.digest;
  }

  const tombstoneStep = existingSteps.find(
    (step) => step.phase === "tombstone-published"
  );
  if (!tombstoneStep) {
    assertNoNewRetentionHolds(journal.plan, action, additionalHolds);
    const observed = await observeRetentionAction(store, action);
    if (observed === "pending") {
      await assertCurrentInventoryMatchesPlan(
        store,
        journal.plan,
        action.ordinal,
        additionalHolds
      );
      await publishRetentionAction(store, action);
      await faultInjector?.("after-tombstone-publish", action.ordinal);
    }
    await assertRetentionActionApplied(store, action);
    const step = await appendRetentionStep(
      journal,
      action,
      "tombstone-published",
      action.tombstone.digest,
      previousDigest,
      action.tombstone.committedAt
    );
    previousDigest = step.digest;
    await faultInjector?.("after-progress-publish", action.ordinal);
  } else {
    previousDigest = tombstoneStep.digest;
  }

  const sourceRetiredStep = existingSteps.find(
    (step) => step.phase === "source-retired"
  );
  if (sourceRetiredStep) {
    const read = await readExactRetiredPayload(store, action);
    assertRetirementEvidenceMatches(
      read.retirementReceipt,
      header,
      prepared,
      journal.finalizationReceipts.get(action.ordinal)
    );
    return sourceRetiredStep.digest;
  }

  assertNoNewRetentionHolds(journal.plan, action, additionalHolds);
  let finalization = journal.finalizationReceipts.get(action.ordinal);
  if (!finalization) {
    finalization = await inspectRecordMutationTrashAuthorityFinalization({
      mutationId: header.trashMutationId,
      storageRootPath: journal.layout.storageRootPath,
      sourceRootPath: roots.sourceRootPath,
      sourceBoundaryRootPath: roots.sourceBoundaryRootPath,
      sourceRootBinding: roots.sourceRootBinding,
      trashRootPath: roots.trashRootPath,
      trashBoundaryRootPath: roots.trashBoundaryRootPath,
      trashRootBinding: roots.trashRootBinding,
      receipt: prepared
    }) ?? await coordinateRecordMutationTrashAuthorityFinalize({
      mutationId: header.trashMutationId,
      storageRootPath: journal.layout.storageRootPath,
      sourceRootPath: roots.sourceRootPath,
      sourceBoundaryRootPath: roots.sourceBoundaryRootPath,
      sourceRootBinding: roots.sourceRootBinding,
      trashRootPath: roots.trashRootPath,
      trashBoundaryRootPath: roots.trashBoundaryRootPath,
      trashRootBinding: roots.trashRootBinding,
      receipt: prepared,
      now: () => action.tombstone.committedAt + 1
    });
    await publishRetentionEvidence(
      journal,
      finalizationFileName(action.ordinal),
      finalization
    );
    journal.finalizationReceipts.set(action.ordinal, finalization);
  }
  await faultInjector?.("after-source-retired", action.ordinal);
  const retirementReceipt = retirementReceiptFor(
    action,
    header,
    prepared,
    finalization
  );
  await store.publishAttemptPayloadRetirementReceipt(
    retirementReceipt,
    {
      expectedRevision: action.tombstone.revision,
      expectedDigest: action.tombstone.digest
    }
  );
  await faultInjector?.(
    "after-retirement-receipt-publish",
    action.ordinal
  );
  const read = await readExactRetiredPayload(store, action);
  assertRetirementEvidenceMatches(
    read.retirementReceipt,
    header,
    prepared,
    finalization
  );
  const step = await appendRetentionStep(
    journal,
    action,
    "source-retired",
    finalization.digest,
    previousDigest,
    finalization.finalizedAt
  );
  await faultInjector?.("after-progress-publish", action.ordinal);
  return step.digest;
}

async function appendRetentionStep(
  journal: LoadedRetentionJournal,
  action: RunRecordRetentionActionV1,
  phase: RunRecordRetentionStepPhase,
  evidenceDigest: string,
  previousDigest: string,
  committedAt: number
): Promise<RunRecordRetentionStepV1> {
  const ordinal = journal.steps.length;
  const step = finalizeRetentionStep({
    schemaVersion: RUN_RECORD_RETENTION_SCHEMA_VERSION,
    recordType: "run-record-retention-step",
    transactionId: journal.plan.transactionId,
    planDigest: journal.plan.digest,
    ordinal,
    actionOrdinal: action.ordinal,
    actionDigest: action.digest,
    phase,
    evidenceDigest,
    previousDigest,
    committedAt
  });
  try {
    await publishDurableAppendOnlyEntry(
      journal.layout,
      journal.chainToken,
      stepFileName(ordinal),
      jsonLine(step),
      { maxBytes: RUN_RECORD_RETENTION_MAX_STEP_BYTES }
    );
  } catch (error) {
    throw mapJournalError(error);
  }
  journal.steps.push(step);
  return step;
}

function parseRetentionRetirementRoots(
  value: RunRecordRetentionRetirementRoots | undefined,
  storageRootPath: string,
  runStoreRootPath: string
): RunRecordRetentionRetirementRoots {
  if (!value) {
    throw invalidInput(
      "Run retention payload execution requires retirementRoots"
    );
  }
  const parsed: RunRecordRetentionRetirementRoots = {
    sourceRootPath: requireAbsolutePath(
      value.sourceRootPath,
      "retirementRoots.sourceRootPath"
    ),
    sourceBoundaryRootPath: requireAbsolutePath(
      value.sourceBoundaryRootPath,
      "retirementRoots.sourceBoundaryRootPath"
    ),
    sourceRootBinding: parseRecordRootBindingRef(
      value.sourceRootBinding
    ),
    trashRootPath: requireAbsolutePath(
      value.trashRootPath,
      "retirementRoots.trashRootPath"
    ),
    trashBoundaryRootPath: requireAbsolutePath(
      value.trashBoundaryRootPath,
      "retirementRoots.trashBoundaryRootPath"
    ),
    trashRootBinding: parseRecordRootBindingRef(
      value.trashRootBinding
    )
  };
  if (
    parsed.sourceRootPath !== runStoreRootPath
    || parsed.sourceBoundaryRootPath !== storageRootPath
    || parsed.trashBoundaryRootPath !== storageRootPath
    || parsed.sourceRootBinding.rootId === parsed.trashRootBinding.rootId
  ) {
    throw invalidInput(
      "Run retention retirement roots do not match the Run Store boundary"
    );
  }
  return parsed;
}

function expectedRetentionStepDescriptors(
  plan: RunRecordRetentionPlanV1
): Array<{
  actionOrdinal: number;
  phase: RunRecordRetentionStepPhase;
}> {
  return plan.actions.flatMap((action) => (
    action.tombstone.scope === "attempt-payload"
      ? [
          { actionOrdinal: action.ordinal, phase: "trash-prepared" as const },
          {
            actionOrdinal: action.ordinal,
            phase: "tombstone-published" as const
          },
          { actionOrdinal: action.ordinal, phase: "source-retired" as const }
        ]
      : [{
          actionOrdinal: action.ordinal,
          phase: "tombstone-published" as const
        }]
  ));
}

function completedRetentionActionCount(
  plan: RunRecordRetentionPlanV1,
  steps: readonly RunRecordRetentionStepV1[]
): number {
  let completed = 0;
  for (const action of plan.actions) {
    const phases = retentionActionSteps(steps, action.ordinal);
    const expected = action.tombstone.scope === "attempt-payload"
      ? ["trash-prepared", "tombstone-published", "source-retired"]
      : ["tombstone-published"];
    if (
      phases.length !== expected.length
      || phases.some((step, index) => step.phase !== expected[index])
    ) {
      break;
    }
    completed += 1;
  }
  return completed;
}

function retentionActionSteps(
  steps: readonly RunRecordRetentionStepV1[],
  actionOrdinal: number
): RunRecordRetentionStepV1[] {
  return steps.filter((step) => step.actionOrdinal === actionOrdinal);
}

function assertActionStepPhases(
  action: RunRecordRetentionActionV1,
  steps: readonly RunRecordRetentionStepV1[]
): void {
  const expected = action.tombstone.scope === "attempt-payload"
    ? ["trash-prepared", "tombstone-published", "source-retired"]
    : ["tombstone-published"];
  if (
    steps.length > expected.length
    || steps.some((step, index) =>
      step.actionDigest !== action.digest
      || step.phase !== expected[index]
    )
  ) {
    throw journalCorrupt(
      "Run retention action phases are not an ordered prefix"
    );
  }
}

function assertNoNewRetentionHolds(
  plan: RunRecordRetentionPlanV1,
  action: RunRecordRetentionActionV1,
  additionalHolds: ReadonlyMap<
    string,
    readonly RunRecordRetentionHoldReason[]
  >
): void {
  const tombstone = action.tombstone;
  const protectedKeys = [
    action.subjectKey,
    ...(tombstone.scope === "attempt-payload" && tombstone.attemptId
      ? [runRecordRetentionSubjectKey({
          scope: "attempt-summary",
          workflowRunId: tombstone.workflowRunId,
          attemptId: tombstone.attemptId
        })]
      : []),
    ...(tombstone.scope !== "workflow-summary"
      ? [runRecordRetentionSubjectKey({
          scope: "workflow-summary",
          workflowRunId: tombstone.workflowRunId
        })]
      : [])
  ];
  const newlyHeld = protectedKeys.find(
    (key) => (additionalHolds.get(key)?.length ?? 0) > 0
  );
  if (newlyHeld) {
    throw new RunRecordRetentionError(
      "plan-conflict",
      `Retention hold or eligibility changed: ${action.subjectKey}`
    );
  }
  const original = plan.subjects.find(
    (subject) => subject.subjectKey === action.subjectKey
  );
  if (!original || original.holdReasons.length) {
    throw new RunRecordRetentionError(
      "plan-conflict",
      `Retention subject is no longer unheld: ${action.subjectKey}`
    );
  }
}

async function loadOrCreateRetentionExecutionHeader(
  store: FileRunRecordStore,
  journal: LoadedRetentionJournal,
  action: RunRecordRetentionActionV1,
  roots: RunRecordRetentionRetirementRoots
): Promise<RunRecordRetentionExecutionHeaderV1> {
  const existing = journal.executionHeaders.get(action.ordinal);
  if (existing) {
    assertExecutionHeaderMatchesPlan(existing, journal.plan, action);
    assertExecutionHeaderMatchesRoots(existing, roots);
    return existing;
  }
  if (action.tombstone.scope !== "attempt-payload") {
    throw journalCorrupt(
      "Run retention execution header is only valid for payload actions"
    );
  }
  const candidate = await store.inspectAttemptPayloadRetirementCandidate({
    workflowRunId: action.tombstone.workflowRunId,
    attemptId: action.tombstone.attemptId!
  });
  if (
    candidate.status !== "eligible"
    || candidate.manifest.harnessRunId !== action.tombstone.harnessRunId
    || candidate.manifest.subjectDigest !== action.tombstone.subjectDigest
    || candidate.manifest.digest !== action.tombstone.prior.digest
    || candidate.manifest.revision + 1 !== action.tombstone.revision
    || candidate.manifest.eventCount
      !== action.tombstone.prior.eventCount
    || candidate.manifest.byteCount
      !== action.tombstone.prior.byteCount
    || candidate.manifest.terminalAt
      !== action.tombstone.prior.terminalAt
  ) {
    throw new RunRecordRetentionError(
      "effect-conflict",
      "Run payload no longer matches the planned retirement identity"
    );
  }
  const draft = {
    schemaVersion: RUN_RECORD_RETENTION_SCHEMA_VERSION,
    recordType: "run-record-retention-execution-header" as const,
    transactionId: journal.plan.transactionId,
    planDigest: journal.plan.digest,
    actionOrdinal: action.ordinal,
    actionDigest: action.digest,
    trashMutationId: retentionTrashMutationId(
      journal.plan.transactionId,
      action.ordinal
    ),
    sourceRootBinding: roots.sourceRootBinding,
    trashRootBinding: roots.trashRootBinding,
    sourceRelativePath: candidate.sourceRelativePath,
    priorGeneration: candidate.priorGeneration,
    priorGenerationManifestDigest:
      candidate.priorGenerationManifestDigest,
    priorPayloadDigest: candidate.manifest.digest,
    payloadSha256: candidate.manifest.payloadSha256,
    createdAt: journal.plan.createdAt
  };
  const header = parseRetentionExecutionHeader({
    ...draft,
    digest: canonicalRunRecordDigest(draft)
  });
  await publishRetentionEvidence(
    journal,
    executionFileName(action.ordinal),
    header
  );
  journal.executionHeaders.set(action.ordinal, header);
  return header;
}

function parseRetentionExecutionHeader(
  value: unknown
): RunRecordRetentionExecutionHeaderV1 {
  const record = requireExactRecord(value, [
    "schemaVersion",
    "recordType",
    "transactionId",
    "planDigest",
    "actionOrdinal",
    "actionDigest",
    "trashMutationId",
    "sourceRootBinding",
    "trashRootBinding",
    "sourceRelativePath",
    "priorGeneration",
    "priorGenerationManifestDigest",
    "priorPayloadDigest",
    "payloadSha256",
    "createdAt",
    "digest"
  ], "Run retention execution header");
  if (
    record.schemaVersion !== RUN_RECORD_RETENTION_SCHEMA_VERSION
    || record.recordType !== "run-record-retention-execution-header"
  ) {
    throw journalCorrupt("Run retention execution header schema is invalid");
  }
  const priorGeneration = requireSafeId(
    record.priorGeneration,
    "priorGeneration"
  );
  if (!RUN_RECORD_GENERATION_PATTERN.test(priorGeneration)) {
    throw journalCorrupt(
      "Run retention execution header generation is invalid"
    );
  }
  let sourceRelativePath: string;
  try {
    sourceRelativePath = validateDurableRelativePath(
      requireSafeId(record.sourceRelativePath, "sourceRelativePath")
    );
  } catch {
    throw journalCorrupt(
      "Run retention execution header source path is invalid"
    );
  }
  const parsed: RunRecordRetentionExecutionHeaderV1 = {
    schemaVersion: RUN_RECORD_RETENTION_SCHEMA_VERSION,
    recordType: "run-record-retention-execution-header",
    transactionId: requireTransactionId(record.transactionId),
    planDigest: requireDigest(record.planDigest, "planDigest"),
    actionOrdinal: requireNonNegativeInteger(
      record.actionOrdinal,
      "actionOrdinal"
    ),
    actionDigest: requireDigest(record.actionDigest, "actionDigest"),
    trashMutationId: requireTransactionId(record.trashMutationId),
    sourceRootBinding: parseRecordRootBindingRef(
      record.sourceRootBinding
    ),
    trashRootBinding: parseRecordRootBindingRef(
      record.trashRootBinding
    ),
    sourceRelativePath,
    priorGeneration,
    priorGenerationManifestDigest: requireDigest(
      record.priorGenerationManifestDigest,
      "priorGenerationManifestDigest"
    ),
    priorPayloadDigest: requireDigest(
      record.priorPayloadDigest,
      "priorPayloadDigest"
    ),
    payloadSha256: requireDigest(
      record.payloadSha256,
      "payloadSha256"
    ),
    createdAt: requireTimestamp(record.createdAt, "createdAt"),
    digest: requireDigest(record.digest, "header.digest")
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (canonicalRunRecordDigest(withoutDigest) !== parsed.digest) {
    throw journalCorrupt("Run retention execution header digest is invalid");
  }
  return parsed;
}

function assertExecutionHeaderMatchesPlan(
  header: RunRecordRetentionExecutionHeaderV1,
  plan: RunRecordRetentionPlanV1,
  action: RunRecordRetentionActionV1
): void {
  if (
    action.tombstone.scope !== "attempt-payload"
    || header.transactionId !== plan.transactionId
    || header.planDigest !== plan.digest
    || header.actionOrdinal !== action.ordinal
    || header.actionDigest !== action.digest
    || header.priorPayloadDigest !== action.tombstone.prior.digest
    || header.trashMutationId
      !== retentionTrashMutationId(plan.transactionId, action.ordinal)
  ) {
    throw journalCorrupt(
      "Run retention execution header does not match its plan action"
    );
  }
}

function assertExecutionHeaderMatchesRoots(
  header: RunRecordRetentionExecutionHeaderV1,
  roots: RunRecordRetentionRetirementRoots
): void {
  if (
    !sameRecordRootBindingRef(
      header.sourceRootBinding,
      roots.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      header.trashRootBinding,
      roots.trashRootBinding
    )
  ) {
    throw new RunRecordRetentionError(
      "plan-conflict",
      "Run retention execution roots changed after planning"
    );
  }
}

function assertPreparedReceiptMatchesExecutionHeader(
  receipt: RecordMutationTrashReceipt,
  header: RunRecordRetentionExecutionHeaderV1
): void {
  if (
    receipt.mutationId !== header.trashMutationId
    || receipt.transfer !== "move"
    || receipt.sourceDisposition !== "retained"
    || receipt.locator.sourceRelativePath !== header.sourceRelativePath
    || !sameRecordRootBindingRef(
      receipt.sourceRootBinding,
      header.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      receipt.trashRootBinding,
      header.trashRootBinding
    )
  ) {
    throw journalCorrupt(
      "Run retention prepared Trash receipt does not match execution header"
    );
  }
}

function assertTrashFinalizationMatchesPrepared(
  finalization: RecordMutationTrashFinalizationReceipt,
  prepared: RecordMutationTrashReceipt
): void {
  if (
    finalization.mutationId !== prepared.mutationId
    || finalization.preparedReceiptDigest !== prepared.digest
    || finalization.sourceDisposition !== "retired"
    || canonicalRunRecordDigest(finalization.locator)
      !== canonicalRunRecordDigest(prepared.locator)
    || !sameRecordRootBindingRef(
      finalization.sourceRootBinding,
      prepared.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      finalization.trashRootBinding,
      prepared.trashRootBinding
    )
  ) {
    throw journalCorrupt(
      "Run retention Trash finalization does not match prepared receipt"
    );
  }
}

function retirementReceiptFor(
  action: RunRecordRetentionActionV1,
  header: RunRecordRetentionExecutionHeaderV1,
  prepared: RecordMutationTrashReceipt,
  finalization: RecordMutationTrashFinalizationReceipt
): AttemptPayloadRetirementReceiptV1 {
  const tombstone = action.tombstone;
  if (
    tombstone.scope !== "attempt-payload"
    || !tombstone.attemptId
    || !tombstone.harnessRunId
  ) {
    throw journalCorrupt(
      "Run retention payload receipt requires payload tombstone identity"
    );
  }
  assertPreparedReceiptMatchesExecutionHeader(prepared, header);
  assertTrashFinalizationMatchesPrepared(finalization, prepared);
  return finalizeAttemptPayloadRetirementReceipt({
    schemaVersion: 1,
    recordType: "attempt-payload-retirement-receipt",
    workflowRunId: tombstone.workflowRunId,
    attemptId: tombstone.attemptId,
    harnessRunId: tombstone.harnessRunId,
    subjectDigest: tombstone.subjectDigest,
    tombstoneDigest: tombstone.digest,
    tombstoneRevision: tombstone.revision,
    priorGeneration: header.priorGeneration,
    priorGenerationManifestDigest:
      header.priorGenerationManifestDigest,
    priorPayloadDigest: header.priorPayloadDigest,
    payloadSha256: header.payloadSha256,
    preparedTrashReceiptDigest: prepared.digest,
    trashFinalizationDigest: finalization.digest,
    retentionTransactionId: tombstone.retentionTransactionId,
    retiredAt: finalization.finalizedAt,
    revision: tombstone.revision + 1
  });
}

async function readExactRetiredPayload(
  store: FileRunRecordStore,
  action: RunRecordRetentionActionV1
): Promise<{
  tombstone: RunRetentionTombstoneV1;
  retirementReceipt: AttemptPayloadRetirementReceiptV1;
}> {
  const tombstone = action.tombstone;
  const read = await store.readAttemptPayload({
    workflowRunId: tombstone.workflowRunId,
    attemptId: tombstone.attemptId!
  });
  if (
    read.state !== "expired"
    || !read.retirementReceipt
    || read.tombstone.digest !== tombstone.digest
  ) {
    throw new RunRecordRetentionError(
      "effect-conflict",
      `Payload retirement readback failed: ${action.subjectKey}`
    );
  }
  return {
    tombstone: read.tombstone,
    retirementReceipt: read.retirementReceipt
  };
}

function assertRetirementEvidenceMatches(
  receipt: AttemptPayloadRetirementReceiptV1,
  header: RunRecordRetentionExecutionHeaderV1,
  prepared: RecordMutationTrashReceipt,
  finalization: RecordMutationTrashFinalizationReceipt | undefined
): void {
  if (
    !finalization
    || receipt.priorGeneration !== header.priorGeneration
    || receipt.priorGenerationManifestDigest
      !== header.priorGenerationManifestDigest
    || receipt.priorPayloadDigest !== header.priorPayloadDigest
    || receipt.payloadSha256 !== header.payloadSha256
    || receipt.preparedTrashReceiptDigest !== prepared.digest
    || receipt.trashFinalizationDigest !== finalization.digest
  ) {
    throw new RunRecordRetentionError(
      "effect-conflict",
      "Run payload retirement receipt does not match durable Trash evidence"
    );
  }
}

async function publishRetentionEvidence(
  journal: LoadedRetentionJournal,
  fileName: string,
  value: unknown
): Promise<void> {
  try {
    await publishDurableAppendOnlyEntry(
      journal.layout,
      journal.chainToken,
      fileName,
      jsonLine(value),
      { maxBytes: RUN_RECORD_RETENTION_MAX_STEP_BYTES }
    );
  } catch (error) {
    throw mapJournalError(error);
  }
}

function retentionTrashMutationId(
  transactionId: string,
  actionOrdinal: number
): string {
  return `retention-trash-${createHash("sha256")
    .update(`${transactionId}\0${String(actionOrdinal)}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

export function runRecordRetentionSubjectKey(input: {
  scope: RunRetentionTombstoneScope;
  workflowRunId: string;
  attemptId?: string;
  harnessRunId?: string;
}): string {
  const digest = canonicalRunRecordDigest({
    scope: input.scope,
    workflowRunId: input.workflowRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.harnessRunId ? { harnessRunId: input.harnessRunId } : {})
  });
  return `${input.scope}:${digest.slice("sha256:".length, 31)}`;
}

function buildRetentionPlan(
  transactionId: string,
  now: number,
  inventory: RunRecordStoreInventory,
  additionalHolds: ReadonlyMap<
    string,
    readonly RunRecordRetentionHoldReason[]
  >
): RunRecordRetentionPlanV1 {
  const subjects: RunRecordRetentionSubjectV1[] = [];
  const blockers = inventory.blockers.map((blocker) =>
    `inventory:${blocker.code}:${retentionIdentityDigest({
      workflowRunId: blocker.workflowRunId,
      attemptId: blocker.attemptId
    })}`
  );
  const eligible = new Map<
    string,
    {
      subject: RunRecordRetentionSubjectV1;
      prior: AttemptRunSummaryV1 | WorkflowRunSummaryV1
        | ConversationAttemptPayloadInventory;
    }
  >();
  const attemptsByWorkflow = new Map<
    string,
    ConversationAttemptRunInventory[]
  >();

  for (const workflow of inventory.workflowRuns) {
    attemptsByWorkflow.set(
      workflow.summary.workflowRunId,
      workflow.attempts
    );
    const workflowHolds = mergeHoldReasons(
      workflow.summary.retention.holdReasons,
      deriveWorkflowHoldReasons(workflow.summary),
      additionalHolds.get(runRecordRetentionSubjectKey({
        scope: "workflow-summary",
        workflowRunId: workflow.summary.workflowRunId
      })) ?? []
    );
    const attemptHoldSets: RunRecordRetentionHoldReason[][] = [];
    for (const attempt of workflow.attempts) {
      const harnessRunId = payloadHarnessRunId(attempt.payload)
        ?? attempt.summary?.harnessRunId;
      const payloadSubjectKey = runRecordRetentionSubjectKey({
        scope: "attempt-payload",
        workflowRunId: workflow.summary.workflowRunId,
        attemptId: attempt.attemptId,
        ...(harnessRunId
          ? { harnessRunId }
          : {})
      });
      const attemptSubjectKey = runRecordRetentionSubjectKey({
        scope: "attempt-summary",
        workflowRunId: workflow.summary.workflowRunId,
        attemptId: attempt.attemptId
      });
      const attemptHolds = attempt.summary
        ? mergeHoldReasons(
            workflowHolds,
            attempt.summary.retention.holdReasons,
            deriveAttemptHoldReasons(attempt.summary),
            additionalHolds.get(payloadSubjectKey) ?? [],
            additionalHolds.get(attemptSubjectKey) ?? []
          )
        : mergeHoldReasons(
            workflowHolds,
            ["record-missing"],
            additionalHolds.get(payloadSubjectKey) ?? [],
            additionalHolds.get(attemptSubjectKey) ?? []
          );
      attemptHoldSets.push(attemptHolds);
      const payloadSubject = buildPayloadSubject(
        workflow,
        attempt,
        now,
        attemptHolds
      );
      subjects.push(payloadSubject);
      if (
        payloadSubject.decision === "eligible"
        && attempt.payload.state === "present"
      ) {
        eligible.set(payloadSubject.subjectKey, {
          subject: payloadSubject,
          prior: attempt.payload
        });
      }

      const attemptSubject = buildAttemptSummarySubject(
        workflow,
        attempt,
        now,
        attemptHolds
      );
      subjects.push(attemptSubject);
      if (
        attemptSubject.decision === "eligible"
        && attempt.summary
        && !attempt.summaryTombstone
      ) {
        eligible.set(attemptSubject.subjectKey, {
          subject: attemptSubject,
          prior: attempt.summary
        });
      }
    }
    const summarySubject = buildWorkflowSummarySubject(
      workflow,
      now,
      mergeHoldReasons(
        workflowHolds,
        ...attemptHoldSets
      )
    );
    subjects.push(summarySubject);
    if (
      summarySubject.decision === "eligible"
      && !workflow.summaryTombstone
    ) {
      eligible.set(summarySubject.subjectKey, {
        subject: summarySubject,
        prior: workflow.summary
      });
    }
  }

  subjects.sort(compareRetentionSubjects);
  if (subjects.length > RUN_RECORD_RETENTION_MAX_SUBJECTS) {
    blockers.push("inventory:subject-limit-exceeded");
  }

  const settledKeys = new Set(
    subjects
      .filter((subject) =>
        subject.state === "expired" || subject.state === "not-captured"
      )
      .map((subject) => subject.subjectKey)
  );
  const actions: RunRecordRetentionActionV1[] = [];
  for (const subject of subjects) {
    const candidate = eligible.get(subject.subjectKey);
    if (!candidate) continue;
    if (
      subject.scope === "attempt-summary"
      && !attemptPayloadIsSettled(
        subjects,
        settledKeys,
        subject.workflowRunId,
        subject.attemptId!
      )
    ) {
      continue;
    }
    if (
      subject.scope === "workflow-summary"
      && !(attemptsByWorkflow.get(subject.workflowRunId) ?? []).every(
        (attempt) => attemptSummaryIsSettled(
          subjects,
          settledKeys,
          subject.workflowRunId,
          attempt.attemptId
        )
      )
    ) {
      continue;
    }
    const tombstone = retentionTombstoneFor(
      transactionId,
      now,
      subject,
      candidate.prior
    );
    const actionWithoutDigest = {
      ordinal: 0,
      subjectKey: subject.subjectKey,
      tombstone
    };
    actions.push({
      ...actionWithoutDigest,
      digest: canonicalRunRecordDigest(actionWithoutDigest)
    });
    settledKeys.add(subject.subjectKey);
  }
  actions.sort(compareRetentionActions);
  const orderedActions = actions.map((action, ordinal) => {
    const withoutDigest = {
      ordinal,
      subjectKey: action.subjectKey,
      tombstone: action.tombstone
    };
    return {
      ...withoutDigest,
      digest: canonicalRunRecordDigest(withoutDigest)
    };
  });
  blockers.sort((left, right) => left.localeCompare(right));
  const uniqueBlockers = [...new Set(blockers)];
  const sourceInventoryDigest = retentionInventoryDigest(subjects);
  const draft = {
    schemaVersion: RUN_RECORD_RETENTION_SCHEMA_VERSION,
    recordType: "run-record-retention-plan" as const,
    transactionId,
    createdAt: now,
    sourceSnapshotDigest: inventory.snapshotDigest,
    sourceInventoryDigest,
    subjects,
    actions: orderedActions,
    blockers: uniqueBlockers,
    automaticActionAllowed:
      uniqueBlockers.length === 0 && orderedActions.length > 0
  };
  return parseRetentionPlan({
    ...draft,
    digest: canonicalRunRecordDigest(draft)
  });
}

function buildPayloadSubject(
  workflow: ConversationWorkflowRunInventory,
  attempt: ConversationAttemptRunInventory,
  now: number,
  holdReasons: RunRecordRetentionHoldReason[]
): RunRecordRetentionSubjectV1 {
  const payload = attempt.payload;
  const harnessRunId = payloadHarnessRunId(payload)
    ?? attempt.summary?.harnessRunId
    ?? null;
  const identity = {
    scope: "attempt-payload" as const,
    workflowRunId: workflow.summary.workflowRunId,
    attemptId: attempt.attemptId,
    ...(harnessRunId ? { harnessRunId } : {})
  };
  const subjectKey = runRecordRetentionSubjectKey(identity);
  if (payload.state === "expired") {
    return {
      subjectKey,
      ...identity,
      state: "expired",
      recordDigest: payload.tombstone.digest,
      revision: payload.tombstone.revision,
      terminalAt: payload.tombstone.prior.terminalAt,
      retentionDays: payload.tombstone.policy.retentionDays,
      expiresAt: payload.tombstone.eligibleAt,
      holdReasons: [],
      decision: "already-expired"
    };
  }
  if (payload.state === "not-captured") {
    return {
      subjectKey,
      ...identity,
      state: "not-captured",
      recordDigest: canonicalRunRecordDigest({
        state: payload.state,
        reasonCode: payload.reasonCode
      }),
      revision: null,
      terminalAt: null,
      retentionDays: null,
      expiresAt: null,
      holdReasons: [],
      decision: "not-captured"
    };
  }
  if (payload.state === "missing") {
    return {
      subjectKey,
      ...identity,
      state: "missing",
      recordDigest: null,
      revision: null,
      terminalAt: null,
      retentionDays: null,
      expiresAt: null,
      holdReasons: mergeHoldReasons(holdReasons, ["record-missing"]),
      decision: "blocked"
    };
  }
  const retentionDays = exactRetentionDays(
    payload.manifest.terminalAt,
    payload.manifest.expiresAt,
    "Attempt payload"
  );
  const preview = previewRetentionSubject({
    scope: "attempt-payload",
    terminalAt: payload.manifest.terminalAt,
    retentionDays,
    now,
    holdReasons
  });
  return {
    subjectKey,
    ...identity,
    state: "present",
    recordDigest: payload.manifest.digest,
    revision: payload.manifest.revision,
    terminalAt: payload.manifest.terminalAt,
    retentionDays,
    expiresAt: preview.expiresAt,
    holdReasons: preview.holdReasons,
    decision: preview.decision
  };
}

function buildAttemptSummarySubject(
  workflow: ConversationWorkflowRunInventory,
  attempt: ConversationAttemptRunInventory,
  now: number,
  holdReasons: RunRecordRetentionHoldReason[]
): RunRecordRetentionSubjectV1 {
  const identity = {
    scope: "attempt-summary" as const,
    workflowRunId: workflow.summary.workflowRunId,
    attemptId: attempt.attemptId
  };
  const subjectKey = runRecordRetentionSubjectKey(identity);
  if (!attempt.summary) {
    return {
      subjectKey,
      ...identity,
      state: "missing",
      recordDigest: null,
      revision: null,
      terminalAt: null,
      retentionDays: null,
      expiresAt: null,
      holdReasons: mergeHoldReasons(holdReasons, ["record-missing"]),
      decision: "blocked"
    };
  }
  if (attempt.summaryTombstone) {
    return expiredSummarySubject(
      subjectKey,
      identity,
      attempt.summaryTombstone
    );
  }
  return presentSummarySubject(
    subjectKey,
    identity,
    attempt.summary,
    now,
    holdReasons
  );
}

function buildWorkflowSummarySubject(
  workflow: ConversationWorkflowRunInventory,
  now: number,
  holdReasons: RunRecordRetentionHoldReason[]
): RunRecordRetentionSubjectV1 {
  const identity = {
    scope: "workflow-summary" as const,
    workflowRunId: workflow.summary.workflowRunId
  };
  const subjectKey = runRecordRetentionSubjectKey(identity);
  if (workflow.summaryTombstone) {
    return expiredSummarySubject(
      subjectKey,
      identity,
      workflow.summaryTombstone
    );
  }
  return presentSummarySubject(
    subjectKey,
    identity,
    workflow.summary,
    now,
    holdReasons
  );
}

function presentSummarySubject(
  subjectKey: string,
  identity: {
    scope: "attempt-summary" | "workflow-summary";
    workflowRunId: string;
    attemptId?: string;
  },
  summary: AttemptRunSummaryV1 | WorkflowRunSummaryV1,
  now: number,
  holdReasons: RunRecordRetentionHoldReason[]
): RunRecordRetentionSubjectV1 {
  const retentionDays = summaryRetentionDays(summary);
  const preview = previewRetentionSubject({
    scope: identity.scope,
    ...(summary.terminalAt !== undefined
      ? { terminalAt: summary.terminalAt }
      : {}),
    retentionDays,
    now,
    holdReasons
  });
  return {
    subjectKey,
    ...identity,
    state: "present",
    recordDigest: summary.digest,
    revision: summary.revision,
    terminalAt: summary.terminalAt ?? null,
    retentionDays,
    expiresAt: preview.expiresAt,
    holdReasons: preview.holdReasons,
    decision: preview.decision
  };
}

function expiredSummarySubject(
  subjectKey: string,
  identity: {
    scope: "attempt-summary" | "workflow-summary";
    workflowRunId: string;
    attemptId?: string;
  },
  tombstone: RunRetentionTombstoneV1
): RunRecordRetentionSubjectV1 {
  return {
    subjectKey,
    ...identity,
    state: "expired",
    recordDigest: tombstone.digest,
    revision: tombstone.revision,
    terminalAt: tombstone.prior.terminalAt,
    retentionDays: tombstone.policy.retentionDays,
    expiresAt: tombstone.eligibleAt,
    holdReasons: [],
    decision: "already-expired"
  };
}

function retentionTombstoneFor(
  transactionId: string,
  now: number,
  subject: RunRecordRetentionSubjectV1,
  prior: AttemptRunSummaryV1 | WorkflowRunSummaryV1
    | ConversationAttemptPayloadInventory
): RunRetentionTombstoneV1 {
  if (
    subject.state !== "present"
    || subject.recordDigest === null
    || subject.revision === null
    || subject.terminalAt === null
    || subject.retentionDays === null
    || subject.expiresAt === null
  ) {
    throw new RunRecordRetentionError(
      "plan-conflict",
      `Retention subject is not eligible: ${subject.subjectKey}`
    );
  }
  const payload = (
    "state" in prior
    && prior.state === "present"
    && "manifest" in prior
  ) ? prior : null;
  return finalizeRetentionTombstone({
    schemaVersion: 1,
    recordType: "run-retention-tombstone",
    scope: subject.scope,
    workflowRunId: subject.workflowRunId,
    ...(subject.attemptId ? { attemptId: subject.attemptId } : {}),
    ...(subject.harnessRunId ? { harnessRunId: subject.harnessRunId } : {}),
    subjectDigest: runRecordSubjectDigest(
      subject.scope,
      subject.workflowRunId,
      subject.attemptId,
      subject.harnessRunId
    ),
    reasonCode: "policy-expired",
    eligibleAt: subject.expiresAt,
    expiredAt: now,
    prior: {
      schemaVersion: 1,
      digest: subject.recordDigest,
      ...(payload
        ? {
            eventCount: payload.manifest.eventCount,
            byteCount: payload.manifest.byteCount
          }
        : {}),
      terminalAt: subject.terminalAt
    },
    policy: {
      version: 1,
      retentionDays: subject.retentionDays
    },
    retentionTransactionId: transactionId,
    committedAt: now,
    revision: subject.revision + 1
  });
}

async function publishRetentionAction(
  store: FileRunRecordStore,
  action: RunRecordRetentionActionV1
): Promise<void> {
  const tombstone = action.tombstone;
  const cas = {
    expectedRevision: tombstone.revision - 1,
    expectedDigest: tombstone.prior.digest
  };
  if (tombstone.scope === "attempt-payload") {
    await store.publishAttemptPayloadTombstone(tombstone, cas);
  } else if (tombstone.scope === "attempt-summary") {
    await store.publishAttemptRunSummaryTombstone(tombstone, cas);
  } else {
    await store.publishWorkflowRunSummaryTombstone(tombstone, cas);
  }
}

async function assertRetentionActionApplied(
  store: FileRunRecordStore,
  action: RunRecordRetentionActionV1
): Promise<void> {
  if (await observeRetentionAction(store, action) === "applied") return;
  throw new RunRecordRetentionError(
    "effect-conflict",
    `Retention tombstone readback failed: ${action.subjectKey}`
  );
}

async function observeRetentionAction(
  store: FileRunRecordStore,
  action: RunRecordRetentionActionV1
): Promise<"pending" | "applied"> {
  const tombstone = action.tombstone;
  const read = tombstone.scope === "attempt-payload"
    ? await store.readAttemptPayload({
        workflowRunId: tombstone.workflowRunId,
        attemptId: tombstone.attemptId!
      })
    : tombstone.scope === "attempt-summary"
      ? await store.readAttemptRunSummary({
          workflowRunId: tombstone.workflowRunId,
          attemptId: tombstone.attemptId!
        })
      : await store.readWorkflowRunSummary(tombstone.workflowRunId);
  if (read.state === "expired") {
    if (read.tombstone.digest === tombstone.digest) return "applied";
    throw new RunRecordRetentionError(
      "effect-conflict",
      `Retention subject has a different tombstone: ${action.subjectKey}`
    );
  }
  if (read.state === "present") {
    const digest = "record" in read
      ? read.record.digest
      : read.manifest.digest;
    if (digest === tombstone.prior.digest) return "pending";
  }
  throw new RunRecordRetentionError(
    "effect-conflict",
    `Retention subject changed before effect: ${action.subjectKey}`
  );
}

async function assertCurrentInventoryMatchesPlan(
  store: FileRunRecordStore,
  plan: RunRecordRetentionPlanV1,
  applied: number,
  additionalHolds: ReadonlyMap<
    string,
    readonly RunRecordRetentionHoldReason[]
  >
): Promise<void> {
  const first = await store.inventoryRunRecords();
  const second = await store.inventoryRunRecords();
  if (first.snapshotDigest !== second.snapshotDigest) {
    throw new RunRecordRetentionError(
      "inventory-drift",
      "Run Record Store changed during retention recovery validation"
    );
  }
  if (second.blockers.length) {
    throw new RunRecordRetentionError(
      "inventory-blocked",
      "Run Record Store has blockers during retention recovery"
    );
  }
  const current = inventorySubjectsForComparison(second);
  if (
    current.length !== plan.subjects.length
    || current.some(
      (subject, index) =>
        plan.subjects[index]?.subjectKey !== subject.subjectKey
    )
  ) {
    throw new RunRecordRetentionError(
      "plan-conflict",
      "Run Record Store subject set changed after retention planning"
    );
  }
  if (
    applied === 0
    && second.snapshotDigest !== plan.sourceSnapshotDigest
  ) {
    throw new RunRecordRetentionError(
      "plan-conflict",
      "Run Record Store snapshot changed after retention planning"
    );
  }
  const currentByKey = new Map(
    current.map((subject) => [subject.subjectKey, subject])
  );
  const appliedByKey = new Map(
    plan.actions
      .slice(0, applied)
      .map((action) => [action.subjectKey, action.tombstone])
  );
  for (const original of plan.subjects) {
    const observed = currentByKey.get(original.subjectKey);
    if (!observed) {
      throw new RunRecordRetentionError(
        "plan-conflict",
        `Retention subject disappeared: ${original.subjectKey}`
      );
    }
    const tombstone = appliedByKey.get(original.subjectKey);
    const expected = tombstone
      ? subjectStateEvidence({
          ...original,
          state: "expired",
          recordDigest: tombstone.digest,
          revision: tombstone.revision
        })
      : subjectStateEvidence(original);
    if (
      canonicalRunRecordDigest(subjectStateEvidence(observed))
      !== canonicalRunRecordDigest(expected)
    ) {
      throw new RunRecordRetentionError(
        "plan-conflict",
        `Retention subject changed after planning: ${original.subjectKey}`
      );
    }
  }
  if (applied < plan.actions.length) {
    const currentPlan = buildRetentionPlan(
      plan.transactionId,
      plan.createdAt,
      second,
      additionalHolds
    );
    const currentActions = new Map(
      currentPlan.actions.map((action) => [action.subjectKey, action])
    );
    for (const planned of plan.actions.slice(applied)) {
      if (
        currentActions.get(planned.subjectKey)?.tombstone.digest
        !== planned.tombstone.digest
      ) {
        throw new RunRecordRetentionError(
          "plan-conflict",
          `Retention hold or eligibility changed: ${planned.subjectKey}`
        );
      }
    }
  }
}

function inventorySubjectsForComparison(
  inventory: RunRecordStoreInventory
): RunRecordRetentionSubjectV1[] {
  const subjects: RunRecordRetentionSubjectV1[] = [];
  for (const workflow of inventory.workflowRuns) {
    for (const attempt of workflow.attempts) {
      subjects.push(buildPayloadSubject(workflow, attempt, 0, []));
      subjects.push(buildAttemptSummarySubject(
        workflow,
        attempt,
        0,
        []
      ));
    }
    subjects.push(buildWorkflowSummarySubject(workflow, 0, []));
  }
  return subjects.sort(compareRetentionSubjects);
}

async function loadOrCreateRetentionJournal(
  storageRootPath: string,
  plan: RunRecordRetentionPlanV1
): Promise<LoadedRetentionJournal> {
  const layout = await resolveDurableAppendOnlyLayout(
    storageRootPath,
    RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY,
    true
  );
  if (!layout) {
    throw new RunRecordRetentionError(
      "journal-corrupt",
      "Run retention journal layout could not be created"
    );
  }
  const chainToken = retentionChainToken(plan.transactionId);
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  const current = await durableLstatOrNull(chainRootPath);
  let created = false;
  if (!current) {
    try {
      await publishDurableAppendOnlyChain(
        layout,
        chainToken,
        PLAN_FILE_NAME,
        jsonLine(plan),
        { maxBytes: RUN_RECORD_RETENTION_MAX_PLAN_BYTES }
      );
      created = true;
    } catch (error) {
      if (
        !(error instanceof DurableAppendOnlyCasError)
        || error.code !== "already_exists"
      ) {
        throw mapJournalError(error);
      }
    }
  } else {
    assertDurableDirectoryStat(current, "Run retention journal chain");
  }
  const loadedPlan = parseRetentionPlan(
    await readJsonFile(
      path.join(chainRootPath, PLAN_FILE_NAME),
      RUN_RECORD_RETENTION_MAX_PLAN_BYTES
    )
  );
  if (loadedPlan.digest !== plan.digest) {
    throw new RunRecordRetentionError(
      "plan-conflict",
      "Run retention transaction ID is already bound to a different plan"
    );
  }
  const steps = await readRetentionSteps(chainRootPath, loadedPlan);
  const evidence = await readRetentionEvidenceFiles(
    chainRootPath,
    loadedPlan
  );
  return {
    layout,
    chainToken,
    plan: loadedPlan,
    steps,
    ...evidence,
    created
  };
}

async function loadExistingRetentionJournal(
  layout: DurableAppendOnlyLayout,
  chainToken: string
): Promise<LoadedRetentionJournal> {
  if (!RETENTION_CHAIN_TOKEN_PATTERN.test(chainToken)) {
    throw journalCorrupt(
      "Run retention startup recovery chain token is invalid"
    );
  }
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  const chainStat = await durableLstatOrNull(chainRootPath);
  if (!chainStat) {
    throw journalCorrupt(
      "Run retention startup recovery chain disappeared"
    );
  }
  assertDurableDirectoryStat(chainStat, "Run retention journal chain");
  const plan = parseRetentionPlan(
    await readJsonFile(
      path.join(chainRootPath, PLAN_FILE_NAME),
      RUN_RECORD_RETENTION_MAX_PLAN_BYTES
    )
  );
  if (retentionChainToken(plan.transactionId) !== chainToken) {
    throw journalCorrupt(
      "Run retention startup recovery plan does not match its chain"
    );
  }
  const steps = await readRetentionSteps(chainRootPath, plan);
  const evidence = await readRetentionEvidenceFiles(chainRootPath, plan);
  return {
    layout,
    chainToken,
    plan,
    steps,
    ...evidence,
    created: false
  };
}

async function readRetentionSteps(
  chainRootPath: string,
  plan: RunRecordRetentionPlanV1
): Promise<RunRecordRetentionStepV1[]> {
  const entries = await readdir(chainRootPath, { withFileTypes: true });
  const stepEntries = entries.filter((entry) =>
    STEP_FILE_PATTERN.test(entry.name)
  );
  if (
    entries.some((entry) =>
      entry.isSymbolicLink()
      || !entry.isFile()
      || (
        entry.name !== PLAN_FILE_NAME
        && !STEP_FILE_PATTERN.test(entry.name)
        && !EXECUTION_FILE_PATTERN.test(entry.name)
        && !PREPARED_FILE_PATTERN.test(entry.name)
        && !FINALIZATION_FILE_PATTERN.test(entry.name)
      )
    )
  ) {
    throw new RunRecordRetentionError(
      "journal-corrupt",
      "Run retention journal contains an unknown or unsafe entry"
    );
  }
  const steps: RunRecordRetentionStepV1[] = [];
  const expectedPhases = expectedRetentionStepDescriptors(plan);
  let previousDigest = plan.digest;
  for (const entry of stepEntries.sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    const match = STEP_FILE_PATTERN.exec(entry.name);
    const ordinal = Number(match?.[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal !== steps.length) {
      throw new RunRecordRetentionError(
        "journal-corrupt",
        "Run retention journal steps are not contiguous"
      );
    }
    const step = parseRetentionStep(
      await readJsonFile(
        path.join(chainRootPath, entry.name),
        RUN_RECORD_RETENTION_MAX_STEP_BYTES
      )
    );
    const expected = expectedPhases[ordinal];
    const action = expected
      ? plan.actions[expected.actionOrdinal]
      : undefined;
    if (
      !action
      || step.transactionId !== plan.transactionId
      || step.planDigest !== plan.digest
      || step.ordinal !== ordinal
      || step.actionOrdinal !== expected.actionOrdinal
      || step.actionDigest !== action.digest
      || step.phase !== expected.phase
      || step.previousDigest !== previousDigest
    ) {
      throw new RunRecordRetentionError(
        "journal-corrupt",
        "Run retention journal step does not match its immutable plan"
      );
    }
    steps.push(step);
    previousDigest = step.digest;
  }
  return steps;
}

async function readRetentionEvidenceFiles(
  chainRootPath: string,
  plan: RunRecordRetentionPlanV1
): Promise<Pick<
  LoadedRetentionJournal,
  "executionHeaders" | "preparedReceipts" | "finalizationReceipts"
>> {
  const entries = await readdir(chainRootPath, { withFileTypes: true });
  const executionHeaders =
    new Map<number, RunRecordRetentionExecutionHeaderV1>();
  const preparedReceipts = new Map<number, RecordMutationTrashReceipt>();
  const finalizationReceipts =
    new Map<number, RecordMutationTrashFinalizationReceipt>();
  for (const entry of entries) {
    const executionMatch = EXECUTION_FILE_PATTERN.exec(entry.name);
    const preparedMatch = PREPARED_FILE_PATTERN.exec(entry.name);
    const finalizationMatch = FINALIZATION_FILE_PATTERN.exec(entry.name);
    if (!executionMatch && !preparedMatch && !finalizationMatch) continue;
    const ordinal = Number(
      executionMatch?.[1] ?? preparedMatch?.[1] ?? finalizationMatch?.[1]
    );
    const action = plan.actions[ordinal];
    if (
      !Number.isSafeInteger(ordinal)
      || !action
      || action.tombstone.scope !== "attempt-payload"
    ) {
      throw journalCorrupt(
        "Run retention evidence file does not match a payload action"
      );
    }
    const value = await readJsonFile(
      path.join(chainRootPath, entry.name),
      RUN_RECORD_RETENTION_MAX_STEP_BYTES
    );
    if (executionMatch) {
      const header = parseRetentionExecutionHeader(value);
      assertExecutionHeaderMatchesPlan(header, plan, action);
      executionHeaders.set(ordinal, header);
    } else if (preparedMatch) {
      preparedReceipts.set(
        ordinal,
        parseRecordMutationTrashReceipt(value)
      );
    } else {
      finalizationReceipts.set(
        ordinal,
        parseRecordMutationTrashFinalizationReceipt(value)
      );
    }
  }
  for (const ordinal of new Set([
    ...preparedReceipts.keys(),
    ...finalizationReceipts.keys()
  ])) {
    const header = executionHeaders.get(ordinal);
    if (!header) {
      throw journalCorrupt(
        "Run retention Trash evidence lacks its execution header"
      );
    }
    const prepared = preparedReceipts.get(ordinal);
    if (prepared) {
      assertPreparedReceiptMatchesExecutionHeader(prepared, header);
    }
    const finalization = finalizationReceipts.get(ordinal);
    if (finalization) {
      if (!prepared) {
        throw journalCorrupt(
          "Run retention finalization lacks its prepared receipt"
        );
      }
      assertTrashFinalizationMatchesPrepared(finalization, prepared);
    }
  }
  return {
    executionHeaders,
    preparedReceipts,
    finalizationReceipts
  };
}

function parseRetentionPlan(value: unknown): RunRecordRetentionPlanV1 {
  const record = requireExactRecord(value, [
    "schemaVersion",
    "recordType",
    "transactionId",
    "createdAt",
    "sourceSnapshotDigest",
    "sourceInventoryDigest",
    "subjects",
    "actions",
    "blockers",
    "automaticActionAllowed",
    "digest"
  ], "Run retention plan");
  if (
    record.schemaVersion !== RUN_RECORD_RETENTION_SCHEMA_VERSION
    || record.recordType !== "run-record-retention-plan"
  ) {
    throw invalidInput("Run retention plan schema is invalid");
  }
  const transactionId = requireTransactionId(record.transactionId);
  const createdAt = requireTimestamp(record.createdAt, "createdAt");
  const sourceSnapshotDigest = requireDigest(
    record.sourceSnapshotDigest,
    "sourceSnapshotDigest"
  );
  const sourceInventoryDigest = requireDigest(
    record.sourceInventoryDigest,
    "sourceInventoryDigest"
  );
  if (!Array.isArray(record.subjects)) {
    throw invalidInput("Run retention plan subjects are invalid");
  }
  if (record.subjects.length > RUN_RECORD_RETENTION_MAX_SUBJECTS) {
    throw invalidInput("Run retention plan exceeds the subject limit");
  }
  const subjects = record.subjects.map(parseRetentionSubject);
  if (
    subjects.some((subject, index) =>
      index > 0
      && compareRetentionSubjects(subjects[index - 1], subject) >= 0
    )
  ) {
    throw invalidInput("Run retention plan subjects are not unique and sorted");
  }
  if (!Array.isArray(record.actions)) {
    throw invalidInput("Run retention plan actions are invalid");
  }
  const actions = record.actions.map(parseRetentionAction);
  if (
    actions.some((action, index) =>
      action.ordinal !== index
      || (
        index > 0
        && compareRetentionActions(actions[index - 1], action) >= 0
      )
    )
  ) {
    throw invalidInput("Run retention plan actions are not unique and ordered");
  }
  if (!Array.isArray(record.blockers)) {
    throw invalidInput("Run retention plan blockers are invalid");
  }
  const blockers: string[] = [];
  for (const item of record.blockers as unknown[]) {
    if (typeof item !== "string" || !item || item.length > 512) {
      throw invalidInput("Run retention plan blockers are invalid");
    }
    blockers.push(item);
  }
  if (
    blockers.some((item, index) =>
      index > 0 && blockers[index - 1].localeCompare(item) >= 0
    )
  ) {
    throw invalidInput("Run retention plan blockers are not unique and sorted");
  }
  if (typeof record.automaticActionAllowed !== "boolean") {
    throw invalidInput("Run retention automatic action flag is invalid");
  }
  if (
    record.automaticActionAllowed
    !== (blockers.length === 0 && actions.length > 0)
  ) {
    throw invalidInput("Run retention automatic action flag is inconsistent");
  }
  const digest = requireDigest(record.digest, "digest");
  const parsed: RunRecordRetentionPlanV1 = {
    schemaVersion: RUN_RECORD_RETENTION_SCHEMA_VERSION,
    recordType: "run-record-retention-plan",
    transactionId,
    createdAt,
    sourceSnapshotDigest,
    sourceInventoryDigest,
    subjects,
    actions,
    blockers,
    automaticActionAllowed: record.automaticActionAllowed,
    digest
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (canonicalRunRecordDigest(withoutDigest) !== digest) {
    throw invalidInput("Run retention plan digest is invalid");
  }
  if (retentionInventoryDigest(subjects) !== sourceInventoryDigest) {
    throw invalidInput("Run retention source inventory digest is invalid");
  }
  return parsed;
}

function parseRetentionSubject(value: unknown): RunRecordRetentionSubjectV1 {
  const record = requireExactRecord(value, [
    "subjectKey",
    "scope",
    "workflowRunId",
    "attemptId",
    "harnessRunId",
    "state",
    "recordDigest",
    "revision",
    "terminalAt",
    "retentionDays",
    "expiresAt",
    "holdReasons",
    "decision"
  ], "Run retention subject");
  const scope = requireScope(record.scope);
  const workflowRunId = requireSafeId(record.workflowRunId, "workflowRunId");
  const attemptId = optionalSafeId(record.attemptId, "attemptId");
  const harnessRunId = optionalSafeId(record.harnessRunId, "harnessRunId");
  if (
    record.state !== "present"
    && record.state !== "expired"
    && record.state !== "not-captured"
    && record.state !== "missing"
  ) {
    throw invalidInput("Run retention subject state is invalid");
  }
  const state = record.state;
  validateScopeIdentity(scope, attemptId, harnessRunId, state);
  const subjectKey = runRecordRetentionSubjectKey({
    scope,
    workflowRunId,
    ...(attemptId ? { attemptId } : {}),
    ...(harnessRunId ? { harnessRunId } : {})
  });
  if (record.subjectKey !== subjectKey) {
    throw invalidInput("Run retention subject key is invalid");
  }
  const recordDigest = record.recordDigest === null
    ? null
    : requireDigest(record.recordDigest, "recordDigest");
  const revision = record.revision === null
    ? null
    : requireNonNegativeInteger(record.revision, "revision");
  const terminalAt = record.terminalAt === null
    ? null
    : requireTimestamp(record.terminalAt, "terminalAt");
  const retentionDays = record.retentionDays === null
    ? null
    : requireRetentionDays(record.retentionDays);
  const expiresAt = record.expiresAt === null
    ? null
    : requireTimestamp(record.expiresAt, "expiresAt");
  const holdReasons = parseHoldReasons(record.holdReasons);
  const decisions = new Set<RunRecordRetentionSubjectDecision>([
    "not-terminal",
    "forever",
    "retained",
    "held",
    "eligible",
    "already-expired",
    "not-captured",
    "blocked"
  ]);
  if (!decisions.has(record.decision as RunRecordRetentionSubjectDecision)) {
    throw invalidInput("Run retention subject decision is invalid");
  }
  return {
    subjectKey,
    scope,
    workflowRunId,
    ...(attemptId ? { attemptId } : {}),
    ...(harnessRunId ? { harnessRunId } : {}),
    state,
    recordDigest,
    revision,
    terminalAt,
    retentionDays,
    expiresAt,
    holdReasons,
    decision: record.decision as RunRecordRetentionSubjectDecision
  };
}

function parseRetentionAction(value: unknown): RunRecordRetentionActionV1 {
  const record = requireExactRecord(value, [
    "ordinal",
    "subjectKey",
    "tombstone",
    "digest"
  ], "Run retention action");
  const ordinal = requireNonNegativeInteger(record.ordinal, "ordinal");
  if (typeof record.subjectKey !== "string") {
    throw invalidInput("Run retention action subject key is invalid");
  }
  const tombstone = validateRetentionTombstone(record.tombstone);
  const expectedKey = runRecordRetentionSubjectKey(tombstone);
  if (record.subjectKey !== expectedKey) {
    throw invalidInput("Run retention action identity is invalid");
  }
  const digest = requireDigest(record.digest, "action.digest");
  const parsed = {
    ordinal,
    subjectKey: expectedKey,
    tombstone,
    digest
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (canonicalRunRecordDigest(withoutDigest) !== digest) {
    throw invalidInput("Run retention action digest is invalid");
  }
  return parsed;
}

function finalizeRetentionStep(
  input: Omit<RunRecordRetentionStepV1, "digest">
): RunRecordRetentionStepV1 {
  return parseRetentionStep({
    ...input,
    digest: canonicalRunRecordDigest(input)
  });
}

function parseRetentionStep(value: unknown): RunRecordRetentionStepV1 {
  const record = requireExactRecord(value, [
    "schemaVersion",
    "recordType",
    "transactionId",
    "planDigest",
    "ordinal",
    "actionOrdinal",
    "actionDigest",
    "phase",
    "evidenceDigest",
    "previousDigest",
    "committedAt",
    "digest"
  ], "Run retention step");
  if (
    record.schemaVersion !== RUN_RECORD_RETENTION_SCHEMA_VERSION
    || record.recordType !== "run-record-retention-step"
  ) {
    throw journalCorrupt("Run retention step schema is invalid");
  }
  if (
    record.phase !== "trash-prepared"
    && record.phase !== "tombstone-published"
    && record.phase !== "source-retired"
  ) {
    throw journalCorrupt("Run retention step phase is invalid");
  }
  const parsed: RunRecordRetentionStepV1 = {
    schemaVersion: RUN_RECORD_RETENTION_SCHEMA_VERSION,
    recordType: "run-record-retention-step",
    transactionId: requireTransactionId(record.transactionId),
    planDigest: requireDigest(record.planDigest, "planDigest"),
    ordinal: requireNonNegativeInteger(record.ordinal, "ordinal"),
    actionOrdinal: requireNonNegativeInteger(
      record.actionOrdinal,
      "actionOrdinal"
    ),
    actionDigest: requireDigest(record.actionDigest, "actionDigest"),
    phase: record.phase,
    evidenceDigest: requireDigest(
      record.evidenceDigest,
      "evidenceDigest"
    ),
    previousDigest: requireDigest(record.previousDigest, "previousDigest"),
    committedAt: requireTimestamp(record.committedAt, "committedAt"),
    digest: requireDigest(record.digest, "step.digest")
  };
  const { digest: _digest, ...withoutDigest } = parsed;
  if (canonicalRunRecordDigest(withoutDigest) !== parsed.digest) {
    throw journalCorrupt("Run retention step digest is invalid");
  }
  return parsed;
}

function deriveWorkflowHoldReasons(
  summary: WorkflowRunSummaryV1
): RunRecordRetentionHoldReason[] {
  const holds: RunRecordRetentionHoldReason[] = [];
  if (summary.status === "running") holds.push("run-active");
  if (summary.localMutation.state === "pending") {
    holds.push("local-commit-pending");
  }
  if (summary.localMutation.state === "recovery-required") {
    holds.push("local-commit-recovery-required");
  }
  return holds;
}

function deriveAttemptHoldReasons(
  summary: AttemptRunSummaryV1
): RunRecordRetentionHoldReason[] {
  const holds: RunRecordRetentionHoldReason[] = [];
  if (summary.status === "created" || summary.status === "running") {
    holds.push("run-active");
  }
  if (summary.localCommit.state === "pending") {
    holds.push("local-commit-pending");
  }
  if (summary.localCommit.state === "recovery-required") {
    holds.push("local-commit-recovery-required");
  }
  if (
    summary.cleanup.status === "awaiting-local-commit"
    || summary.cleanup.status === "pending"
    || summary.cleanup.status === "disposing"
  ) {
    holds.push("cleanup-pending");
  }
  if (
    summary.cleanup.status === "failed"
    || summary.cleanup.status === "retained-for-recovery"
  ) {
    holds.push("cleanup-failed");
  }
  if (summary.cleanup.status === "quarantined") {
    holds.push("cleanup-quarantined");
  }
  return holds;
}

function attemptPayloadIsSettled(
  subjects: readonly RunRecordRetentionSubjectV1[],
  settledKeys: ReadonlySet<string>,
  workflowRunId: string,
  attemptId: string
): boolean {
  const payload = subjects.find((subject) =>
    subject.scope === "attempt-payload"
    && subject.workflowRunId === workflowRunId
    && subject.attemptId === attemptId
  );
  return payload ? settledKeys.has(payload.subjectKey) : false;
}

function attemptSummaryIsSettled(
  subjects: readonly RunRecordRetentionSubjectV1[],
  settledKeys: ReadonlySet<string>,
  workflowRunId: string,
  attemptId: string
): boolean {
  const attempt = subjects.find((subject) =>
    subject.scope === "attempt-summary"
    && subject.workflowRunId === workflowRunId
    && subject.attemptId === attemptId
  );
  return attempt ? settledKeys.has(attempt.subjectKey) : false;
}

function inventorySubjectsForDigest(
  subjects: readonly RunRecordRetentionSubjectV1[]
): ReturnType<typeof subjectStateEvidence>[] {
  return subjects.map(subjectStateEvidence);
}

function retentionInventoryDigest(
  subjects: readonly RunRecordRetentionSubjectV1[]
): string {
  return canonicalRunRecordDigest({
    subjects: inventorySubjectsForDigest(subjects)
  });
}

function subjectStateEvidence(subject: RunRecordRetentionSubjectV1): {
  subjectKey: string;
  scope: RunRetentionTombstoneScope;
  workflowRunId: string;
  attemptId?: string;
  harnessRunId?: string;
  state: RunRecordRetentionSubjectState;
  recordDigest: string | null;
  revision: number | null;
  terminalAt: number | null;
} {
  return {
    subjectKey: subject.subjectKey,
    scope: subject.scope,
    workflowRunId: subject.workflowRunId,
    ...(subject.attemptId ? { attemptId: subject.attemptId } : {}),
    ...(subject.harnessRunId ? { harnessRunId: subject.harnessRunId } : {}),
    state: subject.state,
    recordDigest: subject.recordDigest,
    revision: subject.revision,
    terminalAt: subject.terminalAt
  };
}

function compareRetentionSubjects(
  left: RunRecordRetentionSubjectV1,
  right: RunRecordRetentionSubjectV1
): number {
  return retentionScopeRank(left.scope) - retentionScopeRank(right.scope)
    || left.workflowRunId.localeCompare(right.workflowRunId)
    || (left.attemptId ?? "").localeCompare(right.attemptId ?? "")
    || (left.harnessRunId ?? "").localeCompare(right.harnessRunId ?? "");
}

function compareRetentionActions(
  left: RunRecordRetentionActionV1,
  right: RunRecordRetentionActionV1
): number {
  return retentionScopeRank(left.tombstone.scope)
    - retentionScopeRank(right.tombstone.scope)
    || left.tombstone.workflowRunId.localeCompare(
      right.tombstone.workflowRunId
    )
    || (left.tombstone.attemptId ?? "").localeCompare(
      right.tombstone.attemptId ?? ""
    );
}

function retentionScopeRank(scope: RunRetentionTombstoneScope): number {
  if (scope === "attempt-payload") return 0;
  if (scope === "attempt-summary") return 1;
  return 2;
}

function summaryRetentionDays(
  summary: AttemptRunSummaryV1 | WorkflowRunSummaryV1
): number {
  if (
    summary.terminalAt === undefined
    || summary.retention.summaryExpiresAt === undefined
  ) {
    return RUN_RECORD_DEFAULT_SUMMARY_RETENTION_DAYS;
  }
  return exactRetentionDays(
    summary.terminalAt,
    summary.retention.summaryExpiresAt,
    "Run summary"
  );
}

function exactRetentionDays(
  terminalAt: number,
  expiresAt: number,
  label: string
): number {
  const delta = expiresAt - terminalAt;
  const days = delta / RUN_RECORD_DAY_MS;
  if (!Number.isSafeInteger(days) || days <= 0 || days > 36_500) {
    throw new RunRecordRetentionError(
      "invalid-input",
      `${label} retention boundary is not an exact positive day count`
    );
  }
  return days;
}

function payloadHarnessRunId(
  payload: ConversationAttemptPayloadInventory
): string | null {
  if (payload.state === "present") return payload.manifest.harnessRunId;
  if (payload.state === "expired") {
    return payload.tombstone.harnessRunId ?? null;
  }
  return null;
}

function normalizeAdditionalHolds(
  input: Readonly<Record<string, readonly RunRecordRetentionHoldReason[]>>
): ReadonlyMap<string, readonly RunRecordRetentionHoldReason[]> {
  const result = new Map<
    string,
    readonly RunRecordRetentionHoldReason[]
  >();
  for (const [key, holds] of Object.entries(input)) {
    if (
      typeof key !== "string"
      || !/^(attempt-payload|attempt-summary|workflow-summary):[a-f0-9]{24}$/
        .test(key)
    ) {
      throw invalidInput("Additional retention hold subject key is invalid");
    }
    result.set(key, parseHoldReasons(holds));
  }
  return result;
}

function requireRecoveryEvidenceAuthority(
  value: RunRecordRetentionRecoveryEvidenceAuthority
): RunRecordRetentionRecoveryEvidenceAuthority {
  if (!value || typeof value.withStableHolds !== "function") {
    throw invalidInput("Run retention recovery evidence authority is required");
  }
  return value;
}

function mergeHoldReasons(
  ...inputs: readonly (readonly RunRecordRetentionHoldReason[])[]
): RunRecordRetentionHoldReason[] {
  return [...new Set(inputs.flat())].sort(
    (left, right) => left.localeCompare(right)
  );
}

function parseHoldReasons(value: unknown): RunRecordRetentionHoldReason[] {
  if (!Array.isArray(value)) {
    throw invalidInput("Run retention hold reasons are invalid");
  }
  const allowed = new Set<RunRecordRetentionHoldReason>([
    "run-active",
    "payload-unsealed",
    "local-commit-pending",
    "local-commit-recovery-required",
    "wal-present",
    "wal-blocked",
    "cleanup-pending",
    "cleanup-failed",
    "cleanup-quarantined",
    "artifact-lineage-pending",
    "record-missing",
    "record-corrupt",
    "future-schema",
    "manual-hold"
  ]);
  const holds = value.map((item) => {
    if (!allowed.has(item as RunRecordRetentionHoldReason)) {
      throw invalidInput("Run retention hold reason is invalid");
    }
    return item as RunRecordRetentionHoldReason;
  });
  const sorted = [...new Set(holds)].sort(
    (left, right) => left.localeCompare(right)
  );
  if (
    holds.length !== sorted.length
    || holds.some((hold, index) => hold !== sorted[index])
  ) {
    throw invalidInput("Run retention hold reasons are not unique and sorted");
  }
  return sorted;
}

function validateScopeIdentity(
  scope: RunRetentionTombstoneScope,
  attemptId: string | undefined,
  harnessRunId: string | undefined,
  state: RunRecordRetentionSubjectState
): void {
  if (
    scope === "workflow-summary"
      ? attemptId !== undefined || harnessRunId !== undefined
      : attemptId === undefined
  ) {
    throw invalidInput("Run retention subject identity does not match scope");
  }
  if (
    scope === "attempt-payload"
      ? harnessRunId === undefined && state !== "missing"
      : harnessRunId !== undefined
  ) {
    throw invalidInput("Run retention payload identity is incomplete");
  }
}

function requireScope(value: unknown): RunRetentionTombstoneScope {
  if (
    value !== "attempt-payload"
    && value !== "attempt-summary"
    && value !== "workflow-summary"
  ) {
    throw invalidInput("Run retention scope is invalid");
  }
  return value;
}

function retentionIdentityDigest(input: {
  workflowRunId: string;
  attemptId?: string;
}): string {
  return canonicalRunRecordDigest(input).slice("sha256:".length, 31);
}

function retentionChainToken(transactionId: string): string {
  return `retention-${createHash("sha256")
    .update(transactionId, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function stepFileName(ordinal: number): string {
  return `step-${String(ordinal).padStart(6, "0")}.json`;
}

function executionFileName(actionOrdinal: number): string {
  return `execution-${String(actionOrdinal).padStart(6, "0")}.json`;
}

function preparedFileName(actionOrdinal: number): string {
  return `prepared-${String(actionOrdinal).padStart(6, "0")}.json`;
}

function finalizationFileName(actionOrdinal: number): string {
  return `finalization-${String(actionOrdinal).padStart(6, "0")}.json`;
}

async function readJsonFile(
  absolutePath: string,
  maxBytes: number
): Promise<unknown> {
  try {
    const content = (await readDurableRegularFile(
      absolutePath,
      maxBytes,
      [1, 2]
    )).content.toString("utf8");
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw mapJournalError(error);
  }
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function requireExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidInput(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...allowedKeys]
    .filter((key) => record[key] !== undefined)
    .sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidInput(`${label} contains unknown fields`);
  }
  return record;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || path.resolve(value) !== value
  ) {
    throw invalidInput(`${label} must be a normalized absolute path`);
  }
  return value;
}

function requireTransactionId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TRANSACTION_ID.test(value)) {
    throw invalidInput("Run retention transactionId is invalid");
  }
  return value;
}

function requireSafeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !value
    || value.length > 512
    || Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw invalidInput(`Run retention ${label} is invalid`);
  }
  return value;
}

function optionalSafeId(
  value: unknown,
  label: string
): string | undefined {
  return value === undefined ? undefined : requireSafeId(value, label);
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidInput(`Run retention ${label} is invalid`);
  }
  return value as number;
}

function requireNonNegativeInteger(
  value: unknown,
  label: string
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidInput(`Run retention ${label} is invalid`);
  }
  return value as number;
}

function requireRetentionDays(value: unknown): number {
  const days = requireNonNegativeInteger(value, "retentionDays");
  if (days > 36_500) {
    throw invalidInput("Run retention retentionDays is too large");
  }
  return days;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidInput(`Run retention ${label} is invalid`);
  }
  return value;
}

function invalidInput(message: string): RunRecordRetentionError {
  return new RunRecordRetentionError("invalid-input", message);
}

function journalCorrupt(message: string): RunRecordRetentionError {
  return new RunRecordRetentionError("journal-corrupt", message);
}

function mapJournalError(error: unknown): RunRecordRetentionError {
  if (error instanceof RunRecordRetentionError) return error;
  if (error instanceof RunRecordStoreConflictError) {
    return new RunRecordRetentionError("effect-conflict", error.message);
  }
  if (error instanceof DurableAppendOnlyCasError) {
    return new RunRecordRetentionError(
      error.code === "revision_conflict"
        ? "journal-corrupt"
        : "journal-corrupt",
      error.message
    );
  }
  return new RunRecordRetentionError(
    "journal-corrupt",
    error instanceof Error ? error.message : String(error)
  );
}
