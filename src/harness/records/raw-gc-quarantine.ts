import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import {
  canonicalRunRecordDigest
} from "../contracts/run-record";
import {
  coordinateRecordMutationTrashAuthorityFinalize,
  coordinateRecordMutationTrashAuthorityPrepare,
  inspectRecordMutationTrashAuthorityFinalization,
  withRecordMutationGlobalAuthority,
  type RecordMutationCoordinatorRoots
} from "../lifecycle/record-mutation-coordinator";
import {
  parseRecordMutationTrashFinalizationReceipt,
  parseRecordMutationTrashReceipt,
  type RecordMutationTrashFinalizationReceipt,
  type RecordMutationTrashReceipt
} from "../lifecycle/record-mutation-trash";
import {
  assertDurableDirectoryStat,
  assertDurableRegularFileStat,
  durableAppendOnlyChainPath,
  durableLstatOrNull,
  publishDurableAppendOnlyChain,
  publishDurableAppendOnlyEntry,
  readDurableRegularFile,
  resolveDurableAppendOnlyLayout,
  sameDurableIdentity,
  unlinkDurableFileIfIdentityMatches,
  validateDurableRelativePath,
  type DurableAppendOnlyLayout
} from "../storage/durable-append-only-cas";
import {
  parseRecordRootBindingRef,
  sameRecordRootBindingRef,
  verifyRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  inventoryRawGcPreview,
  rawGcSubjectRef,
  type RawGcPreview
} from "./conversation-record-inventory";

export const RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY =
  "raw-gc-quarantine-transactions-v1";
export const RAW_GC_MINIMUM_QUARANTINE_MS =
  7 * 24 * 60 * 60 * 1_000;

const RAW_GC_SCHEMA_VERSION = 1;
const PLAN_FILE_NAME = "plan.json";
const RECHECK_FILE_NAME = "purge-recheck.json";
const STEP_FILE_PATTERN = /^step-([0-9]{6})\.json$/;
const PREPARED_FILE_PATTERN = /^prepared-([0-9]{6})\.json$/;
const FINALIZATION_FILE_PATTERN = /^finalization-([0-9]{6})\.json$/;
const PURGE_FILE_PATTERN = /^purge-([0-9]{6})\.json$/;
const CHAIN_TOKEN_PATTERN = /^raw-gc-[a-f0-9]{24}$/;
const SAFE_TRANSACTION_ID =
  /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RAW_FILE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,160}\.txt$/;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_ACTIONS = 4_096;

export type RawGcQuarantineErrorCode =
  | "invalid-input"
  | "inventory-blocked"
  | "inventory-drift"
  | "journal-corrupt"
  | "plan-conflict"
  | "quarantine-too-young"
  | "effect-conflict";

export class RawGcQuarantineError extends Error {
  constructor(
    public readonly code: RawGcQuarantineErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RawGcQuarantineError";
  }
}

export interface RawGcStableOwnerAuthority {
  withStableOwners<T>(action: () => Promise<T>): Promise<T>;
}

export type RawGcQuarantineRoots = RecordMutationCoordinatorRoots;

export interface RawGcQuarantineActionV1 {
  ordinal: number;
  subjectRef: string;
  rawRef: string;
  sourceRelativePath: string;
  sourceIdentity: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  };
  digest: string;
}

export interface RawGcQuarantinePlanV1 {
  schemaVersion: typeof RAW_GC_SCHEMA_VERSION;
  recordType: "raw-gc-quarantine-plan";
  transactionId: string;
  createdAt: number;
  confirmedAt: number;
  previewDigest: string;
  sourceSnapshotDigest: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  actions: RawGcQuarantineActionV1[];
  automaticActionAllowed: false;
  explicitlyConfirmed: true;
  digest: string;
}

export type RawGcQuarantineStepPhase =
  | "trash-prepared"
  | "source-quarantined"
  | "purge-authorized"
  | "trash-copy-purged"
  | "retired-source-purged"
  | "purged";

export interface RawGcQuarantineStepV1 {
  schemaVersion: typeof RAW_GC_SCHEMA_VERSION;
  recordType: "raw-gc-quarantine-step";
  transactionId: string;
  planDigest: string;
  ordinal: number;
  actionOrdinal: number | null;
  phase: RawGcQuarantineStepPhase;
  evidenceDigest: string;
  previousDigest: string;
  committedAt: number;
  digest: string;
}

export interface RawGcPurgeRecheckV1 {
  schemaVersion: typeof RAW_GC_SCHEMA_VERSION;
  recordType: "raw-gc-purge-recheck";
  transactionId: string;
  planDigest: string;
  recheckedAt: number;
  stableOwnerSnapshotDigest: string;
  quarantinedSubjectDigest: string;
  minimumQuarantineMs: number;
  digest: string;
}

export interface RawGcPurgeReceiptV1 {
  schemaVersion: typeof RAW_GC_SCHEMA_VERSION;
  recordType: "raw-gc-purge-receipt";
  transactionId: string;
  planDigest: string;
  actionOrdinal: number;
  actionDigest: string;
  preparedReceiptDigest: string;
  finalizationReceiptDigest: string;
  recheckDigest: string;
  purgedAt: number;
  digest: string;
}

export type RawGcQuarantineFaultPoint =
  | "after-plan-publish"
  | "after-trash-prepare"
  | "after-trash-prepared-progress"
  | "after-source-quarantined"
  | "after-source-quarantined-progress"
  | "after-purge-recheck"
  | "after-purge-authorization"
  | "after-trash-copy-unlink"
  | "after-trash-copy-purged"
  | "after-retired-source-unlink"
  | "after-retired-source-purged"
  | "after-purge-receipt"
  | "after-purge-progress";

export interface BeginRawGcQuarantineInput {
  vaultPath: string;
  pluginDir: string;
  transactionId: string;
  expectedPreviewDigest: string;
  selectedSubjectRefs: readonly string[];
  confirmedAt: number;
  roots: RawGcQuarantineRoots;
  ownerAuthority: RawGcStableOwnerAuthority;
  now?: () => number;
  faultInjector?: (
    point: RawGcQuarantineFaultPoint,
    ordinal: number
  ) => void | Promise<void>;
}

export interface AuthorizeRawGcPurgeInput {
  vaultPath: string;
  pluginDir: string;
  transactionId: string;
  roots: RawGcQuarantineRoots;
  ownerAuthority: RawGcStableOwnerAuthority;
  now?: () => number;
  faultInjector?: BeginRawGcQuarantineInput["faultInjector"];
}

export interface RecoverStartedRawGcQuarantinesInput {
  vaultPath: string;
  pluginDir: string;
  roots: RawGcQuarantineRoots;
  ownerAuthority: RawGcStableOwnerAuthority;
  now?: () => number;
  faultInjector?: BeginRawGcQuarantineInput["faultInjector"];
}

export interface RawGcQuarantineResult {
  transactionId: string;
  planDigest: string;
  quarantinedCount: number;
  state: "quarantined";
}

export interface RawGcPurgeResult {
  transactionId: string;
  planDigest: string;
  purgedCount: number;
  state: "purged";
}

export interface RawGcQuarantineJournalInspection {
  planDigest: string;
  createdAt: number;
  actionCount: number;
  quarantinedCount: number;
  purgeAuthorized: boolean;
  purgedCount: number;
  stepCount: number;
  preparedReceiptCount: number;
  finalizationReceiptCount: number;
}

interface RawFileMetadata {
  rawRef: string;
  sourceRelativePath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface RawFileSnapshot {
  files: RawFileMetadata[];
  snapshotDigest: string;
}

interface LoadedRawGcJournal {
  layout: DurableAppendOnlyLayout;
  chainToken: string;
  chainRootPath: string;
  plan: RawGcQuarantinePlanV1;
  steps: RawGcQuarantineStepV1[];
  preparedReceipts: Map<number, RecordMutationTrashReceipt>;
  finalizationReceipts: Map<number, RecordMutationTrashFinalizationReceipt>;
  recheck: RawGcPurgeRecheckV1 | null;
  purgeReceipts: Map<number, RawGcPurgeReceiptV1>;
  created: boolean;
}

/**
 * Begins a user-confirmed Raw quarantine. The current owner graph must still
 * match the exact read-only preview digest. The immutable plan is published
 * before the first Trash copy, and every source move remains replayable.
 */
export async function beginRawGcQuarantine(
  input: BeginRawGcQuarantineInput
): Promise<RawGcQuarantineResult> {
  const transactionId = requireTransactionId(input.transactionId);
  const expectedPreviewDigest = requireDigest(
    input.expectedPreviewDigest,
    "expectedPreviewDigest"
  );
  const selectedSubjectRefs = normalizeSubjectRefs(
    input.selectedSubjectRefs
  );
  if (!selectedSubjectRefs.length) {
    throw invalidInput("Raw GC quarantine selection is empty");
  }
  const confirmedAt = requireTimestamp(input.confirmedAt, "confirmedAt");
  const roots = parseRoots(input.roots);
  const authority = requireOwnerAuthority(input.ownerAuthority);
  return await authority.withStableOwners(async () =>
    await withRecordMutationGlobalAuthority(
      roots.storageRootPath,
      transactionId,
      async () => {
        const preview = await inventoryRawGcPreview({
          vaultPath: input.vaultPath,
          pluginDir: input.pluginDir,
          now: input.now
        });
        requireReadyPreview(preview);
        if (preview.snapshotDigest !== expectedPreviewDigest) {
          throw new RawGcQuarantineError(
            "inventory-drift",
            "Raw GC owner inventory changed after user confirmation"
          );
        }
        const raw = await scanRawFiles(roots.sourceRootPath);
        if (raw.snapshotDigest !== preview.sourceSnapshot.raw) {
          throw new RawGcQuarantineError(
            "inventory-drift",
            "Raw Store changed between owner preview and quarantine planning"
          );
        }
        const plan = buildPlan({
          transactionId,
          createdAt: nowTimestamp(input.now),
          confirmedAt,
          preview,
          selectedSubjectRefs,
          raw,
          roots
        });
        const journal = await loadOrCreateJournal(
          roots.storageRootPath,
          plan
        );
        if (journal.created) {
          await input.faultInjector?.("after-plan-publish", -1);
        }
        await executeQuarantineJournal({
          journal,
          roots,
          preview,
          now: input.now,
          faultInjector: input.faultInjector
        });
        return {
          transactionId,
          planDigest: plan.digest,
          quarantinedCount: plan.actions.length,
          state: "quarantined"
        };
      }
    )
  );
}

/**
 * Performs the mandatory full stable owner rescan after at least seven days,
 * publishes durable purge authorization, then retires only the exact Trash
 * bytes bound to the original quarantine receipts.
 */
export async function authorizeAndPurgeRawGcQuarantine(
  input: AuthorizeRawGcPurgeInput
): Promise<RawGcPurgeResult> {
  const transactionId = requireTransactionId(input.transactionId);
  const roots = parseRoots(input.roots);
  const authority = requireOwnerAuthority(input.ownerAuthority);
  return await authority.withStableOwners(async () =>
    await withRecordMutationGlobalAuthority(
      roots.storageRootPath,
      transactionId,
      async () => {
        const journal = await loadJournalByTransaction(
          roots.storageRootPath,
          transactionId
        );
        assertRootsMatchPlan(journal.plan, roots);
        requireFullyQuarantined(journal);
        const now = nowTimestamp(input.now);
        assertMinimumQuarantineAge(journal, now);
        if (!hasPhase(journal.steps, "purge-authorized", null)) {
          const preview = await inventoryRawGcPreview({
            vaultPath: input.vaultPath,
            pluginDir: input.pluginDir,
            now: input.now
          });
          requireReadyPreview(preview);
          assertQuarantinedSubjectsRemainAbsent(journal.plan, preview);
          const recheck = finalizePurgeRecheck({
            transactionId,
            planDigest: journal.plan.digest,
            recheckedAt: now,
            stableOwnerSnapshotDigest: preview.snapshotDigest,
            quarantinedSubjectDigest: canonicalRunRecordDigest(
              {
                subjectRefs: journal.plan.actions.map(
                  (action) => action.subjectRef
                )
              }
            ),
            minimumQuarantineMs: RAW_GC_MINIMUM_QUARANTINE_MS
          });
          journal.recheck = await publishOrReadEvidence(
            journal,
            RECHECK_FILE_NAME,
            recheck,
            parsePurgeRecheck
          );
          await input.faultInjector?.("after-purge-recheck", -1);
          await appendJournalStep(
            journal,
            null,
            "purge-authorized",
            journal.recheck.digest,
            now
          );
          await input.faultInjector?.("after-purge-authorization", -1);
        }
        await executePurgeJournal({
          journal,
          roots,
          now: input.now,
          faultInjector: input.faultInjector
        });
        return {
          transactionId,
          planDigest: journal.plan.digest,
          purgedCount: journal.plan.actions.length,
          state: "purged"
        };
      }
    )
  );
}

/**
 * Startup recovery resumes only durable intent that already exists. A plan
 * may finish quarantine; a published purge authorization may finish unlink.
 * Merely aging in quarantine never creates purge authorization at startup.
 */
export async function recoverStartedRawGcQuarantines(
  input: RecoverStartedRawGcQuarantinesInput
): Promise<number> {
  const roots = parseRoots(input.roots);
  const authority = requireOwnerAuthority(input.ownerAuthority);
  const journals = await listRawGcJournals(roots.storageRootPath);
  let recovered = 0;
  for (const journal of journals) {
    assertRootsMatchPlan(journal.plan, roots);
    const completeQuarantine = isFullyQuarantined(journal);
    const purgeAuthorized = hasPhase(
      journal.steps,
      "purge-authorized",
      null
    );
    const fullyPurged = isFullyPurged(journal);
    if (completeQuarantine && (!purgeAuthorized || fullyPurged)) continue;
    await authority.withStableOwners(async () =>
      await withRecordMutationGlobalAuthority(
        roots.storageRootPath,
        journal.plan.transactionId,
        async () => {
          const current = await loadJournalByTransaction(
            roots.storageRootPath,
            journal.plan.transactionId
          );
          if (!isFullyQuarantined(current)) {
            const preview = await inventoryRawGcPreview({
              vaultPath: input.vaultPath,
              pluginDir: input.pluginDir,
              now: input.now
            });
            requireReadyPreview(preview);
            await executeQuarantineJournal({
              journal: current,
              roots,
              preview,
              now: input.now,
              faultInjector: input.faultInjector
            });
          }
          if (
            hasPhase(current.steps, "purge-authorized", null)
            && !isFullyPurged(current)
          ) {
            await executePurgeJournal({
              journal: current,
              roots,
              now: input.now,
              faultInjector: input.faultInjector
            });
          }
        }
      )
    );
    recovered += 1;
  }
  return recovered;
}

export function inspectRawGcQuarantineJournalSnapshot(input: {
  chainToken: string;
  files: readonly { name: string; value: unknown }[];
}): RawGcQuarantineJournalInspection {
  const snapshot = parseJournalSnapshot(input.chainToken, input.files);
  return {
    planDigest: snapshot.plan.digest,
    createdAt: snapshot.plan.createdAt,
    actionCount: snapshot.plan.actions.length,
    quarantinedCount: snapshot.plan.actions.filter((action) =>
      hasPhase(snapshot.steps, "source-quarantined", action.ordinal)
    ).length,
    purgeAuthorized: hasPhase(snapshot.steps, "purge-authorized", null),
    purgedCount: snapshot.plan.actions.filter((action) =>
      hasPhase(snapshot.steps, "purged", action.ordinal)
    ).length,
    stepCount: snapshot.steps.length,
    preparedReceiptCount: snapshot.preparedReceipts.size,
    finalizationReceiptCount: snapshot.finalizationReceipts.size
  };
}

async function executeQuarantineJournal(input: {
  journal: LoadedRawGcJournal;
  roots: RawGcQuarantineRoots;
  preview: RawGcPreview;
  now?: () => number;
  faultInjector?: BeginRawGcQuarantineInput["faultInjector"];
}): Promise<void> {
  const { journal, roots, preview } = input;
  assertRootsMatchPlan(journal.plan, roots);
  requireReadyPreview(preview);
  const raw = await scanRawFiles(roots.sourceRootPath);
  if (raw.snapshotDigest !== preview.sourceSnapshot.raw) {
    throw new RawGcQuarantineError(
      "inventory-drift",
      "Raw Store changed after the stable owner scan"
    );
  }
  validateCurrentQuarantineSubjects(journal, preview, raw);
  for (const action of journal.plan.actions) {
    let prepared = journal.preparedReceipts.get(action.ordinal);
    if (!prepared) {
      prepared = await coordinateRecordMutationTrashAuthorityPrepare({
        ...roots,
        mutationId: journal.plan.transactionId,
        sourceRelativePath: action.sourceRelativePath,
        now: input.now
      });
      assertPreparedMatchesAction(prepared, journal.plan, action);
      journal.preparedReceipts.set(
        action.ordinal,
        await publishOrReadEvidence(
          journal,
          preparedFileName(action.ordinal),
          prepared,
          parseRecordMutationTrashReceipt
        )
      );
      await input.faultInjector?.("after-trash-prepare", action.ordinal);
    }
    if (!hasPhase(journal.steps, "trash-prepared", action.ordinal)) {
      await appendJournalStep(
        journal,
        action.ordinal,
        "trash-prepared",
        prepared.digest,
        nowTimestamp(input.now)
      );
      await input.faultInjector?.(
        "after-trash-prepared-progress",
        action.ordinal
      );
    }

    let finalization = journal.finalizationReceipts.get(action.ordinal);
    if (!finalization) {
      finalization =
        await inspectRecordMutationTrashAuthorityFinalization({
          ...roots,
          mutationId: journal.plan.transactionId,
          receipt: prepared,
          now: input.now
        })
        ?? await coordinateRecordMutationTrashAuthorityFinalize({
          ...roots,
          mutationId: journal.plan.transactionId,
          receipt: prepared,
          now: input.now
        });
      assertFinalizationMatchesPrepared(finalization, prepared);
      journal.finalizationReceipts.set(
        action.ordinal,
        await publishOrReadEvidence(
          journal,
          finalizationFileName(action.ordinal),
          finalization,
          parseRecordMutationTrashFinalizationReceipt
        )
      );
      await input.faultInjector?.(
        "after-source-quarantined",
        action.ordinal
      );
    }
    if (!hasPhase(journal.steps, "source-quarantined", action.ordinal)) {
      await appendJournalStep(
        journal,
        action.ordinal,
        "source-quarantined",
        finalization.digest,
        nowTimestamp(input.now)
      );
      await input.faultInjector?.(
        "after-source-quarantined-progress",
        action.ordinal
      );
    }
  }
}

async function executePurgeJournal(input: {
  journal: LoadedRawGcJournal;
  roots: RawGcQuarantineRoots;
  now?: () => number;
  faultInjector?: BeginRawGcQuarantineInput["faultInjector"];
}): Promise<void> {
  const { journal, roots } = input;
  requireFullyQuarantined(journal);
  if (!hasPhase(journal.steps, "purge-authorized", null)) {
    throw new RawGcQuarantineError(
      "plan-conflict",
      "Raw GC purge lacks durable authorization"
    );
  }
  if (!journal.recheck) {
    throw journalCorrupt("Raw GC purge authorization lacks recheck evidence");
  }
  await verifyFrozenRoots(roots);
  for (const action of journal.plan.actions) {
    const prepared = journal.preparedReceipts.get(action.ordinal);
    const finalization = journal.finalizationReceipts.get(action.ordinal);
    if (!prepared || !finalization) {
      throw journalCorrupt(
        "Raw GC purge lacks quarantine Trash evidence"
      );
    }
    await inspectRecordMutationTrashAuthorityFinalization({
      ...roots,
      mutationId: journal.plan.transactionId,
      receipt: prepared,
      now: input.now
    }).then((observed) => {
      if (!observed || observed.digest !== finalization.digest) {
        throw new RawGcQuarantineError(
          "effect-conflict",
          "Raw GC Trash finalization evidence changed before purge"
        );
      }
    });
    if (!hasPhase(
      journal.steps,
      "retired-source-purged",
      action.ordinal
    )) {
      await assertExactTrashFile({
        absolutePath: trashAbsolutePath(
          roots.trashRootPath,
          prepared.locator.retirementRelativePath
        ),
        content: prepared.content,
        // The durable purge authorization permits replay after unlink even
        // when the process crashed before this phase was journaled.
        allowAlreadyMissing: true
      });
    }
    if (!hasPhase(journal.steps, "trash-copy-purged", action.ordinal)) {
      await assertExactTrashFile({
        absolutePath: trashAbsolutePath(
          roots.trashRootPath,
          prepared.locator.trashRelativePath
        ),
        content: prepared.content,
        // A crash after the first authorized unlink but before progress
        // publication leaves this copy absent while the exact retired source
        // still proves the recoverable payload.
        allowAlreadyMissing: true
      });
    }

    if (!hasPhase(journal.steps, "trash-copy-purged", action.ordinal)) {
      await purgeExactTrashFile({
        absolutePath: trashAbsolutePath(
          roots.trashRootPath,
          prepared.locator.trashRelativePath
        ),
        content: prepared.content,
        allowAlreadyMissing: true
      });
      await input.faultInjector?.(
        "after-trash-copy-unlink",
        action.ordinal
      );
      await appendJournalStep(
        journal,
        action.ordinal,
        "trash-copy-purged",
        purgePhaseDigest(journal, action, "trash-copy-purged"),
        nowTimestamp(input.now)
      );
      await input.faultInjector?.(
        "after-trash-copy-purged",
        action.ordinal
      );
    }
    if (!hasPhase(
      journal.steps,
      "retired-source-purged",
      action.ordinal
    )) {
      await purgeExactTrashFile({
        absolutePath: trashAbsolutePath(
          roots.trashRootPath,
          prepared.locator.retirementRelativePath
        ),
        content: prepared.content,
        allowAlreadyMissing: true
      });
      await input.faultInjector?.(
        "after-retired-source-unlink",
        action.ordinal
      );
      await appendJournalStep(
        journal,
        action.ordinal,
        "retired-source-purged",
        purgePhaseDigest(journal, action, "retired-source-purged"),
        nowTimestamp(input.now)
      );
      await input.faultInjector?.(
        "after-retired-source-purged",
        action.ordinal
      );
    }
    let purgeReceipt = journal.purgeReceipts.get(action.ordinal);
    if (!purgeReceipt) {
      purgeReceipt = finalizePurgeReceipt({
        transactionId: journal.plan.transactionId,
        planDigest: journal.plan.digest,
        actionOrdinal: action.ordinal,
        actionDigest: action.digest,
        preparedReceiptDigest: prepared.digest,
        finalizationReceiptDigest: finalization.digest,
        recheckDigest: journal.recheck.digest,
        purgedAt: nowTimestamp(input.now)
      });
      journal.purgeReceipts.set(
        action.ordinal,
        await publishOrReadEvidence(
          journal,
          purgeFileName(action.ordinal),
          purgeReceipt,
          parsePurgeReceipt
        )
      );
      await input.faultInjector?.("after-purge-receipt", action.ordinal);
    }
    if (!hasPhase(journal.steps, "purged", action.ordinal)) {
      await appendJournalStep(
        journal,
        action.ordinal,
        "purged",
        purgeReceipt.digest,
        nowTimestamp(input.now)
      );
      await input.faultInjector?.("after-purge-progress", action.ordinal);
    }
  }
}

function buildPlan(input: {
  transactionId: string;
  createdAt: number;
  confirmedAt: number;
  preview: RawGcPreview;
  selectedSubjectRefs: string[];
  raw: RawFileSnapshot;
  roots: RawGcQuarantineRoots;
}): RawGcQuarantinePlanV1 {
  const previewByRef = new Map(
    input.preview.subjects.map((subject) => [subject.subjectRef, subject])
  );
  const filesByRef = new Map(
    input.raw.files.map((file) => [
      rawGcSubjectRef("raw", file.rawRef),
      file
    ])
  );
  const actions = input.selectedSubjectRefs.map((subjectRef, ordinal) => {
    const subject = previewByRef.get(subjectRef);
    const file = filesByRef.get(subjectRef);
    if (
      !subject
      || !file
      || subject.disposition !== "quarantine-candidate"
      || !subject.eligibleForQuarantine
      || subject.ownerCount !== 0
      || subject.byteSize !== file.size
      || subject.modifiedAt !== Math.trunc(file.mtimeMs)
    ) {
      throw new RawGcQuarantineError(
        "plan-conflict",
        "Raw GC selected subject is no longer an exact quarantine candidate"
      );
    }
    const withoutDigest: Omit<RawGcQuarantineActionV1, "digest"> = {
      ordinal,
      subjectRef,
      rawRef: file.rawRef,
      sourceRelativePath: file.sourceRelativePath,
      sourceIdentity: {
        dev: file.dev,
        ino: file.ino,
        size: file.size,
        mtimeMs: file.mtimeMs,
        ctimeMs: file.ctimeMs
      }
    };
    return {
      ...withoutDigest,
      digest: canonicalRunRecordDigest(withoutDigest)
    };
  });
  const withoutDigest: Omit<RawGcQuarantinePlanV1, "digest"> = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-quarantine-plan",
    transactionId: input.transactionId,
    createdAt: input.createdAt,
    confirmedAt: input.confirmedAt,
    previewDigest: input.preview.snapshotDigest,
    sourceSnapshotDigest: input.raw.snapshotDigest,
    sourceRootBinding: input.roots.sourceRootBinding,
    trashRootBinding: input.roots.trashRootBinding,
    actions,
    automaticActionAllowed: false,
    explicitlyConfirmed: true
  };
  return parsePlan({
    ...withoutDigest,
    digest: canonicalRunRecordDigest(withoutDigest)
  });
}

function validateCurrentQuarantineSubjects(
  journal: LoadedRawGcJournal,
  preview: RawGcPreview,
  raw: RawFileSnapshot
): void {
  const currentByRef = new Map(
    preview.subjects.map((subject) => [subject.subjectRef, subject])
  );
  const metadataByRef = new Map(
    raw.files.map((file) => [rawGcSubjectRef("raw", file.rawRef), file])
  );
  for (const action of journal.plan.actions) {
    const current = currentByRef.get(action.subjectRef);
    const metadata = metadataByRef.get(action.subjectRef);
    const quarantined = hasPhase(
      journal.steps,
      "source-quarantined",
      action.ordinal
    );
    const prepared = hasPhase(
      journal.steps,
      "trash-prepared",
      action.ordinal
    );
    if (quarantined) {
      if (current || metadata) {
        throw new RawGcQuarantineError(
          "inventory-drift",
          "A quarantined Raw path was recreated before transaction recovery"
        );
      }
      continue;
    }
    if (!current || !metadata) {
      if (prepared) continue;
      throw new RawGcQuarantineError(
        "inventory-drift",
        "A pending Raw quarantine source disappeared before Trash prepare"
      );
    }
    if (
      current.disposition !== "quarantine-candidate"
      || !current.eligibleForQuarantine
      || current.ownerCount !== 0
      || current.byteSize !== action.sourceIdentity.size
      || current.modifiedAt !== Math.trunc(action.sourceIdentity.mtimeMs)
      || metadata.sourceRelativePath !== action.sourceRelativePath
      || metadata.dev !== action.sourceIdentity.dev
      || metadata.ino !== action.sourceIdentity.ino
      || metadata.size !== action.sourceIdentity.size
      || metadata.mtimeMs !== action.sourceIdentity.mtimeMs
      || metadata.ctimeMs !== action.sourceIdentity.ctimeMs
    ) {
      throw new RawGcQuarantineError(
        "inventory-drift",
        "A pending Raw quarantine source gained an owner or changed metadata"
      );
    }
  }
}

function assertQuarantinedSubjectsRemainAbsent(
  plan: RawGcQuarantinePlanV1,
  preview: RawGcPreview
): void {
  const current = new Set(
    preview.subjects.map((subject) => subject.subjectRef)
  );
  if (plan.actions.some((action) => current.has(action.subjectRef))) {
    throw new RawGcQuarantineError(
      "inventory-drift",
      "A quarantined Raw path was recreated before permanent purge"
    );
  }
}

function requireReadyPreview(preview: RawGcPreview): void {
  if (
    preview.status !== "ready"
    || preview.blockers.length
    || !preview.safetyReceipt.metadataOnly
    || preview.safetyReceipt.rawBodiesRead
    || preview.safetyReceipt.actionsApplied !== 0
    || preview.safetyReceipt.destructiveActionCount !== 0
    || preview.safetyReceipt.automaticActionAllowed
  ) {
    throw new RawGcQuarantineError(
      "inventory-blocked",
      "Raw GC stable owner inventory is blocked"
    );
  }
}

async function scanRawFiles(rootPathInput: string): Promise<RawFileSnapshot> {
  const first = await scanRawFilesOnce(rootPathInput);
  const second = await scanRawFilesOnce(rootPathInput);
  if (first.snapshotDigest !== second.snapshotDigest) {
    throw new RawGcQuarantineError(
      "inventory-drift",
      "Raw Store changed during quarantine authority scan"
    );
  }
  return first;
}

async function scanRawFilesOnce(
  rootPathInput: string
): Promise<RawFileSnapshot> {
  const rootPath = path.resolve(rootPathInput);
  const root = await durableLstatOrNull(rootPath);
  if (!root) return rawFileSnapshot([]);
  assertDurableDirectoryStat(root, "Raw GC source root");
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: RawFileMetadata[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || !RAW_FILE_NAME_PATTERN.test(entry.name)
      || entry.name.includes("..")
    ) {
      throw new RawGcQuarantineError(
        "inventory-blocked",
        "Raw Store contains an unsafe entry"
      );
    }
    const stats = await durableLstatOrNull(path.join(rootPath, entry.name));
    if (!stats) {
      throw new RawGcQuarantineError(
        "inventory-drift",
        "Raw Store entry disappeared during quarantine scan"
      );
    }
    assertDurableRegularFileStat(stats, "Raw GC source");
    files.push({
      rawRef: `raw/${entry.name}`,
      sourceRelativePath: validateDurableRelativePath(entry.name),
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      ctimeMs: Number(stats.ctimeMs)
    });
  }
  return rawFileSnapshot(files);
}

function rawFileSnapshot(filesInput: RawFileMetadata[]): RawFileSnapshot {
  const files = [...filesInput].sort((left, right) =>
    left.rawRef.localeCompare(right.rawRef)
  );
  return {
    files,
    snapshotDigest: canonicalRunRecordDigest({ files })
  };
}

async function loadOrCreateJournal(
  storageRootPath: string,
  plan: RawGcQuarantinePlanV1
): Promise<LoadedRawGcJournal> {
  const layout = await resolveDurableAppendOnlyLayout(
    storageRootPath,
    RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY,
    true
  );
  if (!layout) throw journalCorrupt("Raw GC journal layout is unavailable");
  const chainToken = rawGcChainToken(plan.transactionId);
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  const existing = await durableLstatOrNull(chainRootPath);
  let created = false;
  if (!existing) {
    try {
      await publishDurableAppendOnlyChain(
        layout,
        chainToken,
        PLAN_FILE_NAME,
        jsonBytes(plan),
        { maxBytes: MAX_PLAN_BYTES }
      );
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw mapError(error);
    }
  } else {
    assertDurableDirectoryStat(existing, "Raw GC journal chain");
  }
  const journal = await loadExistingJournal(layout, chainToken);
  if (journal.plan.digest !== plan.digest) {
    throw new RawGcQuarantineError(
      "plan-conflict",
      "Raw GC transaction ID is already bound to another plan"
    );
  }
  journal.created = created;
  return journal;
}

async function loadJournalByTransaction(
  storageRootPath: string,
  transactionId: string
): Promise<LoadedRawGcJournal> {
  const layout = await resolveDurableAppendOnlyLayout(
    storageRootPath,
    RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY,
    false
  );
  if (!layout) throw journalCorrupt("Raw GC journal layout is missing");
  return await loadExistingJournal(layout, rawGcChainToken(transactionId));
}

async function listRawGcJournals(
  storageRootPath: string
): Promise<LoadedRawGcJournal[]> {
  const root = await durableLstatOrNull(storageRootPath);
  if (!root) return [];
  assertDurableDirectoryStat(root, "Raw GC storage root");
  const layout = await resolveDurableAppendOnlyLayout(
    storageRootPath,
    RAW_GC_QUARANTINE_TRANSACTION_DIRECTORY,
    false
  );
  if (!layout) return [];
  const staging = await readdir(layout.stagingRootPath, {
    withFileTypes: true
  });
  if (staging.length) {
    throw journalCorrupt("Raw GC journal has unresolved staging entries");
  }
  const entries = await readdir(layout.namespaceRootPath, {
    withFileTypes: true
  });
  if (entries.some((entry) =>
    entry.isSymbolicLink()
    || (
      entry.name === ".staging"
        ? !entry.isDirectory()
        : (
          !entry.isDirectory()
          || !CHAIN_TOKEN_PATTERN.test(entry.name)
        )
    )
  )) {
    throw journalCorrupt("Raw GC journal contains an unsafe chain");
  }
  const journals: LoadedRawGcJournal[] = [];
  for (const entry of entries
    .filter((entry) => entry.name !== ".staging")
    .sort((left, right) => left.name.localeCompare(right.name))) {
    journals.push(await loadExistingJournal(layout, entry.name));
  }
  return journals;
}

async function loadExistingJournal(
  layout: DurableAppendOnlyLayout,
  chainToken: string
): Promise<LoadedRawGcJournal> {
  if (!CHAIN_TOKEN_PATTERN.test(chainToken)) {
    throw journalCorrupt("Raw GC chain token is invalid");
  }
  const chainRootPath = durableAppendOnlyChainPath(layout, chainToken);
  const chain = await durableLstatOrNull(chainRootPath);
  if (!chain) throw journalCorrupt("Raw GC journal chain is missing");
  assertDurableDirectoryStat(chain, "Raw GC journal chain");
  const entries = await readdir(chainRootPath, { withFileTypes: true });
  const files: Array<{ name: string; value: unknown }> = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw journalCorrupt("Raw GC journal contains an unsafe entry");
    }
    const maxBytes = entry.name === PLAN_FILE_NAME
      ? MAX_PLAN_BYTES
      : MAX_EVIDENCE_BYTES;
    const { content } = await readDurableRegularFile(
      path.join(chainRootPath, entry.name),
      maxBytes
    );
    files.push({
      name: entry.name,
      value: parseJson(content, entry.name)
    });
  }
  const parsed = parseJournalSnapshot(chainToken, files);
  return {
    layout,
    chainToken,
    chainRootPath,
    ...parsed,
    created: false
  };
}

function parseJournalSnapshot(
  chainToken: string,
  filesInput: readonly { name: string; value: unknown }[]
): Omit<
  LoadedRawGcJournal,
  "layout" | "chainToken" | "chainRootPath" | "created"
> {
  if (!CHAIN_TOKEN_PATTERN.test(chainToken)) {
    throw journalCorrupt("Raw GC chain token is invalid");
  }
  const files = new Map<string, unknown>();
  for (const file of filesInput) {
    if (
      files.has(file.name)
      || (
        file.name !== PLAN_FILE_NAME
        && file.name !== RECHECK_FILE_NAME
        && !STEP_FILE_PATTERN.test(file.name)
        && !PREPARED_FILE_PATTERN.test(file.name)
        && !FINALIZATION_FILE_PATTERN.test(file.name)
        && !PURGE_FILE_PATTERN.test(file.name)
      )
    ) {
      throw journalCorrupt("Raw GC journal contains an unknown entry");
    }
    files.set(file.name, file.value);
  }
  const planValue = files.get(PLAN_FILE_NAME);
  if (!planValue) throw journalCorrupt("Raw GC journal lacks plan.json");
  const plan = parsePlan(planValue);
  if (rawGcChainToken(plan.transactionId) !== chainToken) {
    throw journalCorrupt("Raw GC plan does not match its chain token");
  }
  const preparedReceipts = new Map<number, RecordMutationTrashReceipt>();
  const finalizationReceipts =
    new Map<number, RecordMutationTrashFinalizationReceipt>();
  const purgeReceipts = new Map<number, RawGcPurgeReceiptV1>();
  for (const [name, value] of files) {
    const preparedMatch = PREPARED_FILE_PATTERN.exec(name);
    const finalizationMatch = FINALIZATION_FILE_PATTERN.exec(name);
    const purgeMatch = PURGE_FILE_PATTERN.exec(name);
    const ordinal = Number(
      preparedMatch?.[1]
      ?? finalizationMatch?.[1]
      ?? purgeMatch?.[1]
    );
    if (!preparedMatch && !finalizationMatch && !purgeMatch) continue;
    const action = plan.actions[ordinal];
    if (!action) {
      throw journalCorrupt("Raw GC evidence action ordinal is invalid");
    }
    if (preparedMatch) {
      const receipt = parseRecordMutationTrashReceipt(value);
      assertPreparedMatchesAction(receipt, plan, action);
      preparedReceipts.set(ordinal, receipt);
    } else if (finalizationMatch) {
      const finalization =
        parseRecordMutationTrashFinalizationReceipt(value);
      finalizationReceipts.set(ordinal, finalization);
    } else {
      const receipt = parsePurgeReceipt(value);
      assertPurgeReceiptMatches(receipt, plan, action);
      purgeReceipts.set(ordinal, receipt);
    }
  }
  for (const action of plan.actions) {
    const prepared = preparedReceipts.get(action.ordinal);
    const finalization = finalizationReceipts.get(action.ordinal);
    if (finalization) {
      if (!prepared) {
        throw journalCorrupt(
          "Raw GC finalization lacks its prepared receipt"
        );
      }
      assertFinalizationMatchesPrepared(finalization, prepared);
    }
  }
  const recheck = files.has(RECHECK_FILE_NAME)
    ? parsePurgeRecheck(files.get(RECHECK_FILE_NAME))
    : null;
  if (
    recheck
    && (
      recheck.transactionId !== plan.transactionId
      || recheck.planDigest !== plan.digest
    )
  ) {
    throw journalCorrupt("Raw GC purge recheck does not match its plan");
  }
  const steps: RawGcQuarantineStepV1[] = [];
  let previousDigest = plan.digest;
  const expected = expectedStepSequence(plan);
  for (let ordinal = 0; ; ordinal += 1) {
    const value = files.get(stepFileName(ordinal));
    if (value === undefined) break;
    const step = parseStep(value);
    const descriptor = expected[ordinal];
    if (
      !descriptor
      || step.transactionId !== plan.transactionId
      || step.planDigest !== plan.digest
      || step.ordinal !== ordinal
      || step.actionOrdinal !== descriptor.actionOrdinal
      || step.phase !== descriptor.phase
      || step.previousDigest !== previousDigest
    ) {
      throw journalCorrupt("Raw GC journal step chain is invalid");
    }
    assertStepEvidence(
      step,
      plan,
      preparedReceipts,
      finalizationReceipts,
      recheck,
      purgeReceipts
    );
    steps.push(step);
    previousDigest = step.digest;
  }
  if (
    [...files.keys()].some((name) => {
      const match = STEP_FILE_PATTERN.exec(name);
      return match && Number(match[1]) >= steps.length;
    })
  ) {
    throw journalCorrupt("Raw GC journal steps are not contiguous");
  }
  return {
    plan,
    steps,
    preparedReceipts,
    finalizationReceipts,
    recheck,
    purgeReceipts
  };
}

async function appendJournalStep(
  journal: LoadedRawGcJournal,
  actionOrdinal: number | null,
  phase: RawGcQuarantineStepPhase,
  evidenceDigest: string,
  committedAt: number
): Promise<void> {
  const expected = expectedStepSequence(journal.plan)[journal.steps.length];
  if (
    !expected
    || expected.actionOrdinal !== actionOrdinal
    || expected.phase !== phase
  ) {
    throw journalCorrupt("Raw GC step is out of order");
  }
  const withoutDigest: Omit<RawGcQuarantineStepV1, "digest"> = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-quarantine-step",
    transactionId: journal.plan.transactionId,
    planDigest: journal.plan.digest,
    ordinal: journal.steps.length,
    actionOrdinal,
    phase,
    evidenceDigest: requireDigest(evidenceDigest, "evidenceDigest"),
    previousDigest:
      journal.steps.at(-1)?.digest ?? journal.plan.digest,
    committedAt
  };
  const step = parseStep({
    ...withoutDigest,
    digest: canonicalRunRecordDigest(withoutDigest)
  });
  await publishDurableAppendOnlyEntry(
    journal.layout,
    journal.chainToken,
    stepFileName(step.ordinal),
    jsonBytes(step),
    { maxBytes: MAX_EVIDENCE_BYTES }
  ).catch((error) => {
    throw mapError(error);
  });
  journal.steps.push(step);
}

async function publishOrReadEvidence<T>(
  journal: LoadedRawGcJournal,
  name: string,
  value: T,
  parse: (value: unknown) => T
): Promise<T> {
  const existingPath = path.join(journal.chainRootPath, name);
  const existing = await durableLstatOrNull(existingPath);
  if (existing) {
    const { content } = await readDurableRegularFile(
      existingPath,
      MAX_EVIDENCE_BYTES
    );
    const parsed = parse(parseJson(content, name));
    if (
      canonicalRunRecordDigest(parsed)
      !== canonicalRunRecordDigest(value)
    ) {
      throw journalCorrupt(`Raw GC evidence ${name} conflicts`);
    }
    return parsed;
  }
  await publishDurableAppendOnlyEntry(
    journal.layout,
    journal.chainToken,
    name,
    jsonBytes(value),
    { maxBytes: MAX_EVIDENCE_BYTES }
  ).catch((error) => {
    throw mapError(error);
  });
  const { content } = await readDurableRegularFile(
    existingPath,
    MAX_EVIDENCE_BYTES
  );
  return parse(parseJson(content, name));
}

function expectedStepSequence(
  plan: RawGcQuarantinePlanV1
): Array<{
  actionOrdinal: number | null;
  phase: RawGcQuarantineStepPhase;
}> {
  return [
    ...plan.actions.flatMap((action) => [
      {
        actionOrdinal: action.ordinal,
        phase: "trash-prepared" as const
      },
      {
        actionOrdinal: action.ordinal,
        phase: "source-quarantined" as const
      }
    ]),
    { actionOrdinal: null, phase: "purge-authorized" as const },
    ...plan.actions.flatMap((action) => [
      {
        actionOrdinal: action.ordinal,
        phase: "trash-copy-purged" as const
      },
      {
        actionOrdinal: action.ordinal,
        phase: "retired-source-purged" as const
      },
      {
        actionOrdinal: action.ordinal,
        phase: "purged" as const
      }
    ])
  ];
}

function assertStepEvidence(
  step: RawGcQuarantineStepV1,
  plan: RawGcQuarantinePlanV1,
  prepared: ReadonlyMap<number, RecordMutationTrashReceipt>,
  finalizations: ReadonlyMap<number, RecordMutationTrashFinalizationReceipt>,
  recheck: RawGcPurgeRecheckV1 | null,
  purge: ReadonlyMap<number, RawGcPurgeReceiptV1>
): void {
  const action = step.actionOrdinal === null
    ? null
    : plan.actions[step.actionOrdinal];
  const expected = step.phase === "trash-prepared"
    ? prepared.get(action!.ordinal)?.digest
    : step.phase === "source-quarantined"
      ? finalizations.get(action!.ordinal)?.digest
      : step.phase === "purge-authorized"
        ? recheck?.digest
        : step.phase === "purged"
          ? purge.get(action!.ordinal)?.digest
          : action
            ? purgePhaseDigestFromValues(
              plan,
              action,
              recheck,
              step.phase
            )
            : undefined;
  if (!expected || expected !== step.evidenceDigest) {
    throw journalCorrupt("Raw GC step evidence does not match");
  }
}

function parsePlan(value: unknown): RawGcQuarantinePlanV1 {
  const record = requireExactRecord(value, [
    "schemaVersion",
    "recordType",
    "transactionId",
    "createdAt",
    "confirmedAt",
    "previewDigest",
    "sourceSnapshotDigest",
    "sourceRootBinding",
    "trashRootBinding",
    "actions",
    "automaticActionAllowed",
    "explicitlyConfirmed",
    "digest"
  ], "Raw GC plan");
  if (
    record.schemaVersion !== RAW_GC_SCHEMA_VERSION
    || record.recordType !== "raw-gc-quarantine-plan"
    || record.automaticActionAllowed !== false
    || record.explicitlyConfirmed !== true
  ) {
    throw invalidInput("Raw GC plan schema or authorization is invalid");
  }
  if (!Array.isArray(record.actions) || !record.actions.length) {
    throw invalidInput("Raw GC plan actions are invalid");
  }
  if (record.actions.length > MAX_ACTIONS) {
    throw invalidInput("Raw GC plan exceeds the action limit");
  }
  const actions = record.actions.map(parseAction);
  if (actions.some((action, index) =>
    action.ordinal !== index
    || (
      index > 0
      && actions[index - 1].subjectRef.localeCompare(action.subjectRef) >= 0
    )
  )) {
    throw invalidInput("Raw GC plan actions are not unique and sorted");
  }
  const parsed: RawGcQuarantinePlanV1 = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-quarantine-plan",
    transactionId: requireTransactionId(record.transactionId),
    createdAt: requireTimestamp(record.createdAt, "createdAt"),
    confirmedAt: requireTimestamp(record.confirmedAt, "confirmedAt"),
    previewDigest: requireDigest(record.previewDigest, "previewDigest"),
    sourceSnapshotDigest: requireDigest(
      record.sourceSnapshotDigest,
      "sourceSnapshotDigest"
    ),
    sourceRootBinding: parseRecordRootBindingRef(
      record.sourceRootBinding
    ),
    trashRootBinding: parseRecordRootBindingRef(record.trashRootBinding),
    actions,
    automaticActionAllowed: false,
    explicitlyConfirmed: true,
    digest: requireDigest(record.digest, "plan.digest")
  };
  const { digest, ...withoutDigest } = parsed;
  if (digest !== canonicalRunRecordDigest(withoutDigest)) {
    throw invalidInput("Raw GC plan digest is invalid");
  }
  return parsed;
}

function parseAction(value: unknown): RawGcQuarantineActionV1 {
  const record = requireExactRecord(value, [
    "ordinal",
    "subjectRef",
    "rawRef",
    "sourceRelativePath",
    "sourceIdentity",
    "digest"
  ], "Raw GC action");
  const identity = requireExactRecord(record.sourceIdentity, [
    "dev",
    "ino",
    "size",
    "mtimeMs",
    "ctimeMs"
  ], "Raw GC source identity");
  const rawRef = requireString(record.rawRef, "rawRef");
  const sourceRelativePath = validateDurableRelativePath(
    requireString(record.sourceRelativePath, "sourceRelativePath")
  );
  if (
    rawRef !== `raw/${sourceRelativePath}`
    || rawGcSubjectRef("raw", rawRef)
      !== requireDigest(record.subjectRef, "subjectRef")
  ) {
    throw invalidInput("Raw GC action identity is inconsistent");
  }
  const parsed: RawGcQuarantineActionV1 = {
    ordinal: requireSafeInteger(record.ordinal, "ordinal"),
    subjectRef: record.subjectRef as string,
    rawRef,
    sourceRelativePath,
    sourceIdentity: {
      dev: requireSafeInteger(identity.dev, "sourceIdentity.dev"),
      ino: requireSafeInteger(identity.ino, "sourceIdentity.ino"),
      size: requireSafeInteger(identity.size, "sourceIdentity.size"),
      mtimeMs: requireFiniteNumber(
        identity.mtimeMs,
        "sourceIdentity.mtimeMs"
      ),
      ctimeMs: requireFiniteNumber(
        identity.ctimeMs,
        "sourceIdentity.ctimeMs"
      )
    },
    digest: requireDigest(record.digest, "action.digest")
  };
  const { digest, ...withoutDigest } = parsed;
  if (digest !== canonicalRunRecordDigest(withoutDigest)) {
    throw invalidInput("Raw GC action digest is invalid");
  }
  return parsed;
}

function parseStep(value: unknown): RawGcQuarantineStepV1 {
  const record = requireExactRecord(value, [
    "schemaVersion",
    "recordType",
    "transactionId",
    "planDigest",
    "ordinal",
    "actionOrdinal",
    "phase",
    "evidenceDigest",
    "previousDigest",
    "committedAt",
    "digest"
  ], "Raw GC step");
  const phases: RawGcQuarantineStepPhase[] = [
    "trash-prepared",
    "source-quarantined",
    "purge-authorized",
    "trash-copy-purged",
    "retired-source-purged",
    "purged"
  ];
  if (
    record.schemaVersion !== RAW_GC_SCHEMA_VERSION
    || record.recordType !== "raw-gc-quarantine-step"
    || !phases.includes(record.phase as RawGcQuarantineStepPhase)
  ) {
    throw journalCorrupt("Raw GC step schema is invalid");
  }
  const parsed: RawGcQuarantineStepV1 = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-quarantine-step",
    transactionId: requireTransactionId(record.transactionId),
    planDigest: requireDigest(record.planDigest, "step.planDigest"),
    ordinal: requireSafeInteger(record.ordinal, "step.ordinal"),
    actionOrdinal: record.actionOrdinal === null
      ? null
      : requireSafeInteger(record.actionOrdinal, "step.actionOrdinal"),
    phase: record.phase as RawGcQuarantineStepPhase,
    evidenceDigest: requireDigest(
      record.evidenceDigest,
      "step.evidenceDigest"
    ),
    previousDigest: requireDigest(
      record.previousDigest,
      "step.previousDigest"
    ),
    committedAt: requireTimestamp(record.committedAt, "step.committedAt"),
    digest: requireDigest(record.digest, "step.digest")
  };
  const { digest, ...withoutDigest } = parsed;
  if (digest !== canonicalRunRecordDigest(withoutDigest)) {
    throw journalCorrupt("Raw GC step digest is invalid");
  }
  return parsed;
}

function finalizePurgeRecheck(
  value: Omit<RawGcPurgeRecheckV1, "schemaVersion" | "recordType" | "digest">
): RawGcPurgeRecheckV1 {
  const withoutDigest: Omit<RawGcPurgeRecheckV1, "digest"> = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-purge-recheck",
    ...value
  };
  return parsePurgeRecheck({
    ...withoutDigest,
    digest: canonicalRunRecordDigest(withoutDigest)
  });
}

function parsePurgeRecheck(value: unknown): RawGcPurgeRecheckV1 {
  const record = requireExactRecord(value, [
    "schemaVersion",
    "recordType",
    "transactionId",
    "planDigest",
    "recheckedAt",
    "stableOwnerSnapshotDigest",
    "quarantinedSubjectDigest",
    "minimumQuarantineMs",
    "digest"
  ], "Raw GC purge recheck");
  if (
    record.schemaVersion !== RAW_GC_SCHEMA_VERSION
    || record.recordType !== "raw-gc-purge-recheck"
    || record.minimumQuarantineMs !== RAW_GC_MINIMUM_QUARANTINE_MS
  ) {
    throw journalCorrupt("Raw GC purge recheck schema is invalid");
  }
  const parsed: RawGcPurgeRecheckV1 = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-purge-recheck",
    transactionId: requireTransactionId(record.transactionId),
    planDigest: requireDigest(record.planDigest, "recheck.planDigest"),
    recheckedAt: requireTimestamp(record.recheckedAt, "recheckedAt"),
    stableOwnerSnapshotDigest: requireDigest(
      record.stableOwnerSnapshotDigest,
      "stableOwnerSnapshotDigest"
    ),
    quarantinedSubjectDigest: requireDigest(
      record.quarantinedSubjectDigest,
      "quarantinedSubjectDigest"
    ),
    minimumQuarantineMs: RAW_GC_MINIMUM_QUARANTINE_MS,
    digest: requireDigest(record.digest, "recheck.digest")
  };
  const { digest, ...withoutDigest } = parsed;
  if (digest !== canonicalRunRecordDigest(withoutDigest)) {
    throw journalCorrupt("Raw GC purge recheck digest is invalid");
  }
  return parsed;
}

function finalizePurgeReceipt(
  value: Omit<RawGcPurgeReceiptV1, "schemaVersion" | "recordType" | "digest">
): RawGcPurgeReceiptV1 {
  const withoutDigest: Omit<RawGcPurgeReceiptV1, "digest"> = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-purge-receipt",
    ...value
  };
  return parsePurgeReceipt({
    ...withoutDigest,
    digest: canonicalRunRecordDigest(withoutDigest)
  });
}

function parsePurgeReceipt(value: unknown): RawGcPurgeReceiptV1 {
  const record = requireExactRecord(value, [
    "schemaVersion",
    "recordType",
    "transactionId",
    "planDigest",
    "actionOrdinal",
    "actionDigest",
    "preparedReceiptDigest",
    "finalizationReceiptDigest",
    "recheckDigest",
    "purgedAt",
    "digest"
  ], "Raw GC purge receipt");
  if (
    record.schemaVersion !== RAW_GC_SCHEMA_VERSION
    || record.recordType !== "raw-gc-purge-receipt"
  ) {
    throw journalCorrupt("Raw GC purge receipt schema is invalid");
  }
  const parsed: RawGcPurgeReceiptV1 = {
    schemaVersion: RAW_GC_SCHEMA_VERSION,
    recordType: "raw-gc-purge-receipt",
    transactionId: requireTransactionId(record.transactionId),
    planDigest: requireDigest(record.planDigest, "purge.planDigest"),
    actionOrdinal: requireSafeInteger(
      record.actionOrdinal,
      "purge.actionOrdinal"
    ),
    actionDigest: requireDigest(record.actionDigest, "purge.actionDigest"),
    preparedReceiptDigest: requireDigest(
      record.preparedReceiptDigest,
      "purge.preparedReceiptDigest"
    ),
    finalizationReceiptDigest: requireDigest(
      record.finalizationReceiptDigest,
      "purge.finalizationReceiptDigest"
    ),
    recheckDigest: requireDigest(
      record.recheckDigest,
      "purge.recheckDigest"
    ),
    purgedAt: requireTimestamp(record.purgedAt, "purgedAt"),
    digest: requireDigest(record.digest, "purge.digest")
  };
  const { digest, ...withoutDigest } = parsed;
  if (digest !== canonicalRunRecordDigest(withoutDigest)) {
    throw journalCorrupt("Raw GC purge receipt digest is invalid");
  }
  return parsed;
}

async function purgeExactTrashFile(input: {
  absolutePath: string;
  content: RecordMutationTrashReceipt["content"];
  allowAlreadyMissing: boolean;
}): Promise<void> {
  const read = await assertExactTrashFile(input);
  if (!read) return;
  await unlinkDurableFileIfIdentityMatches(
    input.absolutePath,
    read
  );
  if (await durableLstatOrNull(input.absolutePath)) {
    throw new RawGcQuarantineError(
      "effect-conflict",
      "Raw GC purge target still exists after unlink"
    );
  }
}

async function assertExactTrashFile(input: {
  absolutePath: string;
  content: RecordMutationTrashReceipt["content"];
  allowAlreadyMissing: boolean;
}): Promise<{ dev: number; ino: number } | null> {
  const current = await durableLstatOrNull(input.absolutePath);
  if (!current) {
    if (input.allowAlreadyMissing) return null;
    throw new RawGcQuarantineError(
      "effect-conflict",
      "Raw GC purge target is missing before authorized unlink"
    );
  }
  assertDurableRegularFileStat(current, "Raw GC purge target");
  const read = await readDurableRegularFile(
    input.absolutePath,
    MAX_RAW_BYTES
  );
  const digest = `sha256:${createHash("sha256")
    .update(read.content)
    .digest("hex")}`;
  if (
    !sameDurableIdentity(current, read.snapshot)
    || input.content.entryKind !== "file"
    || input.content.entryCount !== 1
    || read.content.byteLength !== input.content.size
    || digest !== input.content.sha256
  ) {
    throw new RawGcQuarantineError(
      "effect-conflict",
      "Raw GC purge target content or identity changed"
    );
  }
  return {
    dev: Number(read.snapshot.dev),
    ino: Number(read.snapshot.ino)
  };
}

function assertMinimumQuarantineAge(
  journal: LoadedRawGcJournal,
  now: number
): void {
  for (const action of journal.plan.actions) {
    const finalization = journal.finalizationReceipts.get(action.ordinal);
    if (
      !finalization
      || now - finalization.finalizedAt < RAW_GC_MINIMUM_QUARANTINE_MS
    ) {
      throw new RawGcQuarantineError(
        "quarantine-too-young",
        "Raw GC quarantine has not reached the seven-day minimum"
      );
    }
  }
}

async function verifyFrozenRoots(
  roots: RawGcQuarantineRoots
): Promise<void> {
  await verifyRecordRootBindingRef(roots.sourceRootBinding, {
    storageRootPath: roots.storageRootPath,
    rootPath: roots.sourceRootPath,
    boundaryRootPath: roots.sourceBoundaryRootPath
  });
  await verifyRecordRootBindingRef(roots.trashRootBinding, {
    storageRootPath: roots.storageRootPath,
    rootPath: roots.trashRootPath,
    boundaryRootPath: roots.trashBoundaryRootPath
  });
}

function parseRoots(input: RawGcQuarantineRoots): RawGcQuarantineRoots {
  const storageRootPath = requireAbsolutePath(
    input.storageRootPath,
    "storageRootPath"
  );
  const sourceRootPath = requireAbsolutePath(
    input.sourceRootPath,
    "sourceRootPath"
  );
  const sourceBoundaryRootPath = requireAbsolutePath(
    input.sourceBoundaryRootPath,
    "sourceBoundaryRootPath"
  );
  const trashRootPath = requireAbsolutePath(
    input.trashRootPath,
    "trashRootPath"
  );
  const trashBoundaryRootPath = requireAbsolutePath(
    input.trashBoundaryRootPath,
    "trashBoundaryRootPath"
  );
  const sourceRootBinding = parseRecordRootBindingRef(
    input.sourceRootBinding
  );
  const trashRootBinding = parseRecordRootBindingRef(input.trashRootBinding);
  if (
    sourceRootBinding.rootId === trashRootBinding.rootId
    || sourceRootPath === trashRootPath
    || isWithin(sourceRootPath, trashRootPath)
    || isWithin(trashRootPath, sourceRootPath)
  ) {
    throw invalidInput("Raw GC source and Trash roots overlap");
  }
  return {
    storageRootPath,
    sourceRootPath,
    sourceBoundaryRootPath,
    sourceRootBinding,
    trashRootPath,
    trashBoundaryRootPath,
    trashRootBinding
  };
}

function assertRootsMatchPlan(
  plan: RawGcQuarantinePlanV1,
  roots: RawGcQuarantineRoots
): void {
  if (
    !sameRecordRootBindingRef(
      plan.sourceRootBinding,
      roots.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      plan.trashRootBinding,
      roots.trashRootBinding
    )
  ) {
    throw new RawGcQuarantineError(
      "plan-conflict",
      "Raw GC runtime roots do not match the immutable plan"
    );
  }
}

function assertPreparedMatchesAction(
  receipt: RecordMutationTrashReceipt,
  plan: RawGcQuarantinePlanV1,
  action: RawGcQuarantineActionV1
): void {
  if (
    receipt.mutationId !== plan.transactionId
    || receipt.transfer !== "move"
    || receipt.locator.sourceRelativePath !== action.sourceRelativePath
    || !sameRecordRootBindingRef(
      receipt.sourceRootBinding,
      plan.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      receipt.trashRootBinding,
      plan.trashRootBinding
    )
  ) {
    throw journalCorrupt(
      "Raw GC prepared Trash receipt does not match its action"
    );
  }
}

function assertFinalizationMatchesPrepared(
  finalization: RecordMutationTrashFinalizationReceipt,
  prepared: RecordMutationTrashReceipt
): void {
  if (
    finalization.mutationId !== prepared.mutationId
    || finalization.preparedReceiptDigest !== prepared.digest
    || finalization.locator.sourceRelativePath
      !== prepared.locator.sourceRelativePath
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
      "Raw GC finalization receipt does not match Trash prepare"
    );
  }
}

function assertPurgeReceiptMatches(
  receipt: RawGcPurgeReceiptV1,
  plan: RawGcQuarantinePlanV1,
  action: RawGcQuarantineActionV1
): void {
  if (
    receipt.transactionId !== plan.transactionId
    || receipt.planDigest !== plan.digest
    || receipt.actionOrdinal !== action.ordinal
    || receipt.actionDigest !== action.digest
  ) {
    throw journalCorrupt("Raw GC purge receipt does not match its action");
  }
}

function purgePhaseDigest(
  journal: LoadedRawGcJournal,
  action: RawGcQuarantineActionV1,
  phase: "trash-copy-purged" | "retired-source-purged"
): string {
  return purgePhaseDigestFromValues(
    journal.plan,
    action,
    journal.recheck,
    phase
  );
}

function purgePhaseDigestFromValues(
  plan: RawGcQuarantinePlanV1,
  action: RawGcQuarantineActionV1,
  recheck: RawGcPurgeRecheckV1 | null,
  phase: "trash-copy-purged" | "retired-source-purged"
): string {
  if (!recheck) throw journalCorrupt("Raw GC purge recheck is missing");
  return canonicalRunRecordDigest({
    transactionId: plan.transactionId,
    planDigest: plan.digest,
    actionDigest: action.digest,
    recheckDigest: recheck.digest,
    phase
  });
}

function requireFullyQuarantined(journal: LoadedRawGcJournal): void {
  if (!isFullyQuarantined(journal)) {
    throw new RawGcQuarantineError(
      "plan-conflict",
      "Raw GC purge cannot start before every source is quarantined"
    );
  }
}

function isFullyQuarantined(journal: LoadedRawGcJournal): boolean {
  return journal.plan.actions.every((action) =>
    hasPhase(journal.steps, "source-quarantined", action.ordinal)
  );
}

function isFullyPurged(journal: LoadedRawGcJournal): boolean {
  return journal.plan.actions.every((action) =>
    hasPhase(journal.steps, "purged", action.ordinal)
  );
}

function hasPhase(
  steps: readonly RawGcQuarantineStepV1[],
  phase: RawGcQuarantineStepPhase,
  actionOrdinal: number | null
): boolean {
  return steps.some((step) =>
    step.phase === phase && step.actionOrdinal === actionOrdinal
  );
}

function normalizeSubjectRefs(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) {
    throw invalidInput("Raw GC selected subject list is invalid");
  }
  const refs = value.map((item) => requireDigest(item, "subjectRef"));
  const sorted = [...refs].sort((left, right) => left.localeCompare(right));
  if (
    new Set(refs).size !== refs.length
    || refs.some((ref, index) => ref !== sorted[index])
  ) {
    throw invalidInput("Raw GC selected subjects must be unique and sorted");
  }
  return refs;
}

function requireOwnerAuthority(
  value: RawGcStableOwnerAuthority
): RawGcStableOwnerAuthority {
  if (!value || typeof value.withStableOwners !== "function") {
    throw invalidInput("Raw GC stable owner authority is missing");
  }
  return value;
}

function rawGcChainToken(transactionId: string): string {
  return `raw-gc-${createHash("sha256")
    .update(Buffer.from(transactionId, "utf8"))
    .digest("hex")
    .slice(0, 24)}`;
}

function stepFileName(ordinal: number): string {
  return `step-${String(ordinal).padStart(6, "0")}.json`;
}

function preparedFileName(ordinal: number): string {
  return `prepared-${String(ordinal).padStart(6, "0")}.json`;
}

function finalizationFileName(ordinal: number): string {
  return `finalization-${String(ordinal).padStart(6, "0")}.json`;
}

function purgeFileName(ordinal: number): string {
  return `purge-${String(ordinal).padStart(6, "0")}.json`;
}

function trashAbsolutePath(rootPath: string, relativePath: string): string {
  const safe = validateDurableRelativePath(relativePath);
  return path.join(rootPath, ...safe.split("/"));
}

function requireTransactionId(value: unknown): string {
  const transactionId = requireString(value, "transactionId");
  if (!SAFE_TRANSACTION_ID.test(transactionId)) {
    throw invalidInput("Raw GC transactionId is invalid");
  }
  return transactionId;
}

function requireDigest(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!SHA256_PATTERN.test(digest)) {
    throw invalidInput(`${label} is not a SHA-256 digest`);
  }
  return digest;
}

function requireTimestamp(value: unknown, label: string): number {
  return requireSafeInteger(value, label);
}

function requireSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw invalidInput(`${label} is invalid`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidInput(`${label} is invalid`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.includes("\0")
  ) {
    throw invalidInput(`${label} is invalid`);
  }
  return value;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const raw = requireString(value, label);
  if (!path.isAbsolute(raw)) throw invalidInput(`${label} is not absolute`);
  return path.resolve(raw);
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidInput(`${label} is not a plain object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidInput(`${label} keys are invalid`);
  }
  return record;
}

function nowTimestamp(now?: () => number): number {
  return requireTimestamp(now?.() ?? Date.now(), "now");
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function parseJson(content: Buffer, label: string): unknown {
  try {
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch (error) {
    throw new RawGcQuarantineError(
      "journal-corrupt",
      `Raw GC ${label} is not valid JSON: ${errorMessage(error)}`
    );
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "already_exists"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidInput(message: string): RawGcQuarantineError {
  return new RawGcQuarantineError("invalid-input", message);
}

function journalCorrupt(message: string): RawGcQuarantineError {
  return new RawGcQuarantineError("journal-corrupt", message);
}

function mapError(error: unknown): RawGcQuarantineError {
  if (error instanceof RawGcQuarantineError) return error;
  return new RawGcQuarantineError(
    "journal-corrupt",
    `Raw GC durable journal failed: ${errorMessage(error)}`
  );
}
