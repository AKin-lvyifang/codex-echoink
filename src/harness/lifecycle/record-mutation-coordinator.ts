import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delayTimer } from "node:timers/promises";
import {
  durableLstatOrNull,
  readDurableRegularFile,
  resolveDurablePlainRoot,
  syncDurableDirectory,
  validateDurableRelativePath
} from "../storage/durable-append-only-cas";
import {
  parseRecordRootBindingRef,
  sameRecordRootBindingRef,
  verifyRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  beginRecordMutationCompensation,
  loadRecordMutationJournal,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "./record-mutation-journal";
import {
  recordMutationDigest,
  stableRecordMutationStringify,
  type RecordMutationParticipant,
  type RecordMutationStepAction
} from "./record-mutation-contract";
import {
  RECORD_MUTATION_MAX_EXECUTION_BUNDLE_ITEMS as MAX_BUNDLE_ITEMS,
  recordMutationExecutionBundleParticipantId
} from "./record-mutation-execution-plan";
import {
  finalizeRecordMutationTrash,
  inspectRecordMutationTrashFinalization,
  judgeRecordMutationTrashRestore,
  parseRecordMutationTrashFinalizationReceipt,
  parseRecordMutationTrashReceipt,
  restoreRecordMutationTrash,
  stageRecordMutationTrash,
  type RecordMutationTrashFinalizationReceipt,
  type RecordMutationTrashReceipt,
  type RecordMutationTrashRestoreJudgment
} from "./record-mutation-trash";

export const RECORD_MUTATION_GLOBAL_LOCK_FILE =
  ".echoink-record-mutation.lock" as const;

const COORDINATOR_LOCK_VERSION = 1;
const MAX_COORDINATOR_LOCK_BYTES = 16 * 1024;
const LOCK_PUBLICATION_GRACE_MS = 1_000;
const LOCK_TOKEN_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_BUNDLE_ID_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_BUNDLE_RECEIPT_BYTES = 8 * 1024 * 1024;
const coordinatorLaneTails = new Map<string, Promise<void>>();
const coordinatorAuthorityContext = new AsyncLocalStorage<{
  storageRootPath: string;
  mutationId: string;
}>();

class CoordinatorLockPublicationPending extends Error {
  constructor() {
    super("RecordMutation authority lock 正在发布");
    this.name = "CoordinatorLockPublicationPending";
  }
}

export type RecordMutationCoordinatorErrorCode =
  | "authority_locked"
  | "authority_corrupt"
  | "journal_mismatch"
  | "authorization_missing";

export class RecordMutationCoordinatorError extends Error {
  constructor(
    public readonly code: RecordMutationCoordinatorErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordMutationCoordinatorError";
  }
}

export type RecordMutationCoordinatorFaultPoint =
  | "after-authority-acquired"
  | "after-roots-preflight"
  | "after-trash-prepared"
  | "after-trash-authorized"
  | "after-root-bindings-verified"
  | "after-source-retired"
  | "after-source-retired-journaled"
  | "after-trash-restored"
  | "after-trash-restore-journaled";

export interface RecordMutationCoordinatorRoots {
  storageRootPath: string;
  sourceRootPath: string;
  sourceBoundaryRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootPath: string;
  trashBoundaryRootPath: string;
  trashRootBinding: RecordRootBindingRef;
}

export interface RecordMutationTrashAuthorityBaseInput
extends RecordMutationCoordinatorRoots {
  mutationId: string;
  now?: () => number;
  faultInjector?: (
    point: RecordMutationCoordinatorFaultPoint
  ) => void | Promise<void>;
}

export interface RecordMutationTrashAuthorityPrepareInput
extends RecordMutationTrashAuthorityBaseInput {
  sourceRelativePath: string;
}

export interface RecordMutationTrashAuthorityFinalizeInput
extends RecordMutationTrashAuthorityBaseInput {
  receipt: RecordMutationTrashReceipt;
}

export interface RecordMutationCoordinatorBaseInput
extends RecordMutationCoordinatorRoots {
  journal: LoadedRecordMutationJournal;
  participantId: string;
  now?: () => number;
  faultInjector?: (
    point: RecordMutationCoordinatorFaultPoint
  ) => void | Promise<void>;
}

export interface CoordinateRecordMutationTrashRetirementInput
extends RecordMutationCoordinatorBaseInput {
  sourceRelativePath: string;
}

export interface CoordinateRecordMutationTrashPrepareInput
extends RecordMutationCoordinatorBaseInput {
  sourceRelativePath: string;
}

export interface CoordinatedRecordMutationTrashPrepare {
  journal: LoadedRecordMutationJournal;
  preparedReceipt: RecordMutationTrashReceipt;
}

export interface CoordinatedRecordMutationTrashRetirement {
  journal: LoadedRecordMutationJournal;
  preparedReceipt: RecordMutationTrashReceipt;
  finalizationReceipt: RecordMutationTrashFinalizationReceipt;
}

export interface CoordinateRecordMutationTrashRestoreInput
extends RecordMutationCoordinatorBaseInput {
  receipt: RecordMutationTrashReceipt;
}

export interface CoordinatedRecordMutationTrashRestore {
  journal: LoadedRecordMutationJournal;
  judgment: RecordMutationTrashRestoreJudgment;
}

export interface RecordMutationTrashBundleItem {
  itemId: string;
  sourceRelativePath: string;
}

export interface RecordMutationTrashBundleLeafReceipt {
  itemId: string;
  receipt: RecordMutationTrashReceipt;
}

export interface RecordMutationTrashBundlePreparedReceipt {
  schemaVersion: 1;
  kind: "record-mutation-trash-bundle-prepared";
  mutationId: string;
  participantId: string;
  selectionDigest: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  leaves: Array<{
    itemId: string;
    sourceRelativePath: string;
    receiptDigest: string;
  }>;
  stagedAt: number;
  digest: string;
}

export interface RecordMutationTrashBundleFinalizationReceipt {
  schemaVersion: 1;
  kind: "record-mutation-trash-bundle-finalization";
  mutationId: string;
  participantId: string;
  preparedReceiptDigest: string;
  leaves: Array<{
    itemId: string;
    finalizationDigest: string;
  }>;
  finalizedAt: number;
  digest: string;
}

export interface RecordMutationTrashBundleInput
extends RecordMutationCoordinatorBaseInput {
  selectionDigest: string;
  items: readonly RecordMutationTrashBundleItem[];
}

export interface RecordMutationTrashBundleEvidenceInput
extends RecordMutationTrashBundleInput {
  preparedReceipt: RecordMutationTrashBundlePreparedReceipt;
  leafReceipts: readonly RecordMutationTrashBundleLeafReceipt[];
}

export interface CoordinatedRecordMutationTrashBundlePrepare {
  journal: LoadedRecordMutationJournal;
  preparedReceipt: RecordMutationTrashBundlePreparedReceipt;
  leafReceipts: RecordMutationTrashBundleLeafReceipt[];
}

export interface CoordinatedRecordMutationTrashBundleRetirement
extends CoordinatedRecordMutationTrashBundlePrepare {
  finalizationReceipt: RecordMutationTrashBundleFinalizationReceipt;
}

export interface InspectedRecordMutationTrashBundleRecovery {
  journal: LoadedRecordMutationJournal;
  preparedReceipt: RecordMutationTrashBundlePreparedReceipt;
  judgments: Array<{
    itemId: string;
    judgment: RecordMutationTrashRestoreJudgment;
  }>;
}

export type CoordinatedRecordMutationTrashBundleRestore =
  InspectedRecordMutationTrashBundleRecovery;

export interface InspectRecordMutationTrashRecoveryInput
extends RecordMutationCoordinatorBaseInput {
  receipt: RecordMutationTrashReceipt;
}

export interface InspectedRecordMutationTrashRecovery {
  journal: LoadedRecordMutationJournal;
  judgment: RecordMutationTrashRestoreJudgment;
}

/**
 * Acquires the one global record-mutation authority without imposing a
 * Conversation RecordMutation Journal. Retention keeps its own immutable plan
 * and progress Journal, then calls the journal-neutral Trash operations below
 * while this authority and the Run Store mutation lane are both held.
 */
export async function withRecordMutationGlobalAuthority<T>(
  storageRootPath: string,
  mutationId: string,
  action: () => Promise<T>
): Promise<T> {
  return await withGlobalMutationAuthority(
    storageRootPath,
    requireBundleId(mutationId, "mutationId"),
    async () => await action()
  );
}

/**
 * Prepare-only Trash operation for authorities such as Run retention that
 * already own a separate durable Journal. It verifies frozen Root Registry
 * bindings before and after the durable copy and never retires the source.
 */
export async function coordinateRecordMutationTrashAuthorityPrepare(
  input: RecordMutationTrashAuthorityPrepareInput
): Promise<RecordMutationTrashReceipt> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    requireBundleId(input.mutationId, "mutationId"),
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-roots-preflight");
      const receipt = await stageRecordMutationTrash({
        mutationId: input.mutationId,
        sourceRootPath: input.sourceRootPath,
        sourceRootBinding: input.sourceRootBinding,
        sourceRelativePath: input.sourceRelativePath,
        trashRootPath: input.trashRootPath,
        trashRootBinding: input.trashRootBinding,
        transfer: "move",
        stagedAt: clockTimestamp(input.now)
      });
      await input.faultInjector?.("after-trash-prepared");
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-trash-authorized");
      return receipt;
    }
  );
}

/**
 * Finalizes an already prepared Trash receipt under the same global authority.
 * The caller's Journal remains the only owner of progress publication.
 */
export async function coordinateRecordMutationTrashAuthorityFinalize(
  input: RecordMutationTrashAuthorityFinalizeInput
): Promise<RecordMutationTrashFinalizationReceipt> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    requireBundleId(input.mutationId, "mutationId"),
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      const receipt = parseRecordMutationTrashReceipt(input.receipt);
      if (receipt.mutationId !== input.mutationId) {
        throw new RecordMutationCoordinatorError(
          "journal_mismatch",
          "Trash finalization receipt 不属于当前 mutation authority"
        );
      }
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-root-bindings-verified");
      const finalization = await finalizeRecordMutationTrash({
        receipt,
        sourceRootPath: input.sourceRootPath,
        sourceRootBinding: input.sourceRootBinding,
        trashRootPath: input.trashRootPath,
        trashRootBinding: input.trashRootBinding,
        finalizedAt: clockTimestamp(input.now)
      });
      await input.faultInjector?.("after-source-retired");
      return finalization;
    }
  );
}

export async function inspectRecordMutationTrashAuthorityFinalization(
  input: RecordMutationTrashAuthorityFinalizeInput
): Promise<RecordMutationTrashFinalizationReceipt | null> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    requireBundleId(input.mutationId, "mutationId"),
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      const receipt = parseRecordMutationTrashReceipt(input.receipt);
      if (receipt.mutationId !== input.mutationId) {
        throw new RecordMutationCoordinatorError(
          "journal_mismatch",
          "Trash inspection receipt 不属于当前 mutation authority"
        );
      }
      await verifyCoordinatorRoots(input, storageRootPath);
      return await inspectRecordMutationTrashFinalization({
        receipt,
        sourceRootPath: input.sourceRootPath,
        sourceRootBinding: input.sourceRootBinding,
        trashRootPath: input.trashRootPath,
        trashRootBinding: input.trashRootBinding
      });
    }
  );
}

/**
 * Read-only recovery probe under the same global authority used by effects.
 * It proves that the durable receipt belongs to the Journal, both frozen roots
 * still resolve to their registered physical directories, and Trash content
 * remains exact.
 */
export async function inspectRecordMutationTrashRecovery(
  input: InspectRecordMutationTrashRecoveryInput
): Promise<InspectedRecordMutationTrashRecovery> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      const current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "inspect"
      );
      const receipt = parseRecordMutationTrashReceipt(input.receipt);
      assertReceiptAuthorizedByIntent(current, input.participantId, receipt);
      const trashStaged = findParticipantStep(
        current,
        input.participantId,
        "forward",
        "trash-staged"
      );
      if (!trashStaged) {
        throw new RecordMutationCoordinatorError(
          "authorization_missing",
          "Trash recovery inspection 缺少 durable trash-staged 授权"
        );
      }
      requireEvidenceDigest(
        trashStaged.evidenceDigest,
        receipt.digest,
        "trash-staged"
      );
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-root-bindings-verified");
      return {
        journal: current,
        judgment: await judgeRecordMutationTrashRestore({
          receipt,
          sourceRootPath: input.sourceRootPath,
          sourceRootBinding: input.sourceRootBinding,
          trashRootPath: input.trashRootPath,
          trashRootBinding: input.trashRootBinding
        })
      };
    }
  );
}

export async function inspectRecordMutationTrashBundleRecovery(
  input: RecordMutationTrashBundleEvidenceInput
): Promise<InspectedRecordMutationTrashBundleRecovery> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      const current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "inspect"
      );
      const evidence = validateTrashBundleEvidence(current, input);
      const trashStaged = findParticipantStep(
        current,
        input.participantId,
        "forward",
        "trash-staged"
      );
      if (!trashStaged) {
        throw new RecordMutationCoordinatorError(
          "authorization_missing",
          "Trash bundle recovery 缺少 durable trash-staged 授权"
        );
      }
      requireEvidenceDigest(
        trashStaged.evidenceDigest,
        evidence.preparedReceipt.digest,
        "trash-staged"
      );
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-root-bindings-verified");
      const judgments: InspectedRecordMutationTrashBundleRecovery[
        "judgments"
      ] = [];
      for (const leaf of evidence.leafReceipts) {
        judgments.push({
          itemId: leaf.itemId,
          judgment: await judgeRecordMutationTrashRestore({
            receipt: leaf.receipt,
            sourceRootPath: input.sourceRootPath,
            sourceRootBinding: input.sourceRootBinding,
            trashRootPath: input.trashRootPath,
            trashRootBinding: input.trashRootBinding
          })
        });
      }
      return {
        journal: current,
        preparedReceipt: evidence.preparedReceipt,
        judgments
      };
    }
  );
}

/**
 * Establishes the durable, independently restorable Trash copy and publishes
 * its Journal authorization without retiring the source. Live destructive
 * product flows use this before the Conversation target commit so a failed
 * local commit can still abort without any source-side destructive effect.
 */
export async function coordinateRecordMutationTrashPrepare(
  input: CoordinateRecordMutationTrashPrepareInput
): Promise<CoordinatedRecordMutationTrashPrepare> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      const current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "forward"
      );
      return await prepareTrashUnderAuthority(
        input,
        current,
        storageRootPath
      );
    }
  );
}

export async function coordinateRecordMutationTrashBundlePrepare(
  input: RecordMutationTrashBundleInput
): Promise<CoordinatedRecordMutationTrashBundlePrepare> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      const current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "forward"
      );
      return await prepareTrashBundleUnderAuthority(
        input,
        current,
        storageRootPath
      );
    }
  );
}

/**
 * The only production-grade path from a durable trash prepare to source
 * retirement. The low-level Trash functions remain separately testable
 * primitives, but callers that mutate a real record root must use this
 * coordinator so Journal authorization, global serialization, and current
 * physical Root Binding verification are one indivisible protocol.
 */
export async function coordinateRecordMutationTrashRetirement(
  input: CoordinateRecordMutationTrashRetirementInput
): Promise<CoordinatedRecordMutationTrashRetirement> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      let current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "forward"
      );
      const prepared = await prepareTrashUnderAuthority(
        input,
        current,
        storageRootPath
      );
      current = prepared.journal;
      const preparedReceipt = prepared.preparedReceipt;

      // The prepare is non-destructive. The second verification is the actual
      // authorization boundary immediately before source retirement.
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-root-bindings-verified");
      const finalizationReceipt = await finalizeRecordMutationTrash({
        receipt: preparedReceipt,
        sourceRootPath: input.sourceRootPath,
        sourceRootBinding: input.sourceRootBinding,
        trashRootPath: input.trashRootPath,
        trashRootBinding: input.trashRootBinding,
        finalizedAt: clockTimestamp(input.now)
      });
      await input.faultInjector?.("after-source-retired");

      const sourceRetired = findParticipantStep(
        current,
        input.participantId,
        "forward",
        "source-retired"
      );
      if (sourceRetired) {
        requireEvidenceDigest(
          sourceRetired.evidenceDigest,
          finalizationReceipt.digest,
          "source-retired"
        );
      } else {
        requireForwardAppendable(current);
        current = await stageRecordMutationJournal(current.handle, {
          expectedRevision: current.record.revision,
          expectedDigest: current.record.digest,
          step: {
            direction: "forward",
            ordinal: nextDirectionOrdinal(current, "forward"),
            participantId: input.participantId,
            action: "source-retired",
            evidenceDigest: finalizationReceipt.digest
          },
          updatedAt: nextJournalTimestamp(current, input.now)
        });
      }
      await input.faultInjector?.("after-source-retired-journaled");
      return { journal: current, preparedReceipt, finalizationReceipt };
    }
  );
}

export async function coordinateRecordMutationTrashBundleRetirement(
  input: RecordMutationTrashBundleInput
): Promise<CoordinatedRecordMutationTrashBundleRetirement> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      let current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "forward"
      );
      const prepared = await prepareTrashBundleUnderAuthority(
        input,
        current,
        storageRootPath
      );
      current = prepared.journal;
      const finalizedLeaves: Array<{
        itemId: string;
        receipt: RecordMutationTrashFinalizationReceipt;
      }> = [];
      for (const leaf of prepared.leafReceipts) {
        await verifyCoordinatorRoots(input, storageRootPath);
        await input.faultInjector?.("after-root-bindings-verified");
        finalizedLeaves.push({
          itemId: leaf.itemId,
          receipt: await finalizeRecordMutationTrash({
            receipt: leaf.receipt,
            sourceRootPath: input.sourceRootPath,
            sourceRootBinding: input.sourceRootBinding,
            trashRootPath: input.trashRootPath,
            trashRootBinding: input.trashRootBinding,
            finalizedAt: clockTimestamp(input.now)
          })
        });
        await input.faultInjector?.("after-source-retired");
      }
      await verifyCoordinatorRoots(input, storageRootPath);
      const finalizationReceipt = createTrashBundleFinalizationReceipt({
        current,
        participantId: input.participantId,
        preparedReceipt: prepared.preparedReceipt,
        finalizedLeaves
      });
      const sourceRetired = findParticipantStep(
        current,
        input.participantId,
        "forward",
        "source-retired"
      );
      if (sourceRetired) {
        requireEvidenceDigest(
          sourceRetired.evidenceDigest,
          finalizationReceipt.digest,
          "source-retired"
        );
      } else {
        requireForwardAppendable(current);
        current = await stageRecordMutationJournal(current.handle, {
          expectedRevision: current.record.revision,
          expectedDigest: current.record.digest,
          step: {
            direction: "forward",
            ordinal: nextDirectionOrdinal(current, "forward"),
            participantId: input.participantId,
            action: "source-retired",
            evidenceDigest: finalizationReceipt.digest
          },
          updatedAt: nextJournalTimestamp(current, input.now)
        });
      }
      await input.faultInjector?.("after-source-retired-journaled");
      return {
        journal: current,
        preparedReceipt: prepared.preparedReceipt,
        leafReceipts: prepared.leafReceipts,
        finalizationReceipt
      };
    }
  );
}

async function prepareTrashUnderAuthority(
  input: CoordinateRecordMutationTrashPrepareInput,
  journal: LoadedRecordMutationJournal,
  storageRootPath: string
): Promise<CoordinatedRecordMutationTrashPrepare> {
  let current = journal;
  await verifyCoordinatorRoots(input, storageRootPath);
  await input.faultInjector?.("after-roots-preflight");

  const preparedReceipt = await stageRecordMutationTrash({
    mutationId: current.record.mutationId,
    sourceRootPath: input.sourceRootPath,
    sourceRootBinding: input.sourceRootBinding,
    sourceRelativePath: input.sourceRelativePath,
    trashRootPath: input.trashRootPath,
    trashRootBinding: input.trashRootBinding,
    transfer: "move",
    stagedAt: clockTimestamp(input.now)
  });
  assertReceiptAuthorizedByIntent(
    current,
    input.participantId,
    preparedReceipt
  );
  await input.faultInjector?.("after-trash-prepared");

  const trashStaged = findParticipantStep(
    current,
    input.participantId,
    "forward",
    "trash-staged"
  );
  if (trashStaged) {
    requireEvidenceDigest(
      trashStaged.evidenceDigest,
      preparedReceipt.digest,
      "trash-staged"
    );
  } else {
    requireForwardAppendable(current);
    current = await stageRecordMutationJournal(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      step: {
        direction: "forward",
        ordinal: nextDirectionOrdinal(current, "forward"),
        participantId: input.participantId,
        action: "trash-staged",
        evidenceDigest: preparedReceipt.digest
      },
      updatedAt: nextJournalTimestamp(current, input.now)
    });
  }
  await input.faultInjector?.("after-trash-authorized");
  return { journal: current, preparedReceipt };
}

async function prepareTrashBundleUnderAuthority(
  input: RecordMutationTrashBundleInput,
  journal: LoadedRecordMutationJournal,
  storageRootPath: string
): Promise<CoordinatedRecordMutationTrashBundlePrepare> {
  let current = journal;
  const items = parseTrashBundleItems(input.items);
  const selectionDigest = requireBundleDigest(
    input.selectionDigest,
    "selectionDigest"
  );
  assertTrashBundleParticipantIdentity(
    current,
    input,
    selectionDigest,
    items
  );
  await verifyCoordinatorRoots(input, storageRootPath);
  await input.faultInjector?.("after-roots-preflight");

  const leafReceipts: RecordMutationTrashBundleLeafReceipt[] = [];
  for (const item of items) {
    // Root identity is re-verified immediately before every leaf effect. The
    // global coordinator lock serializes plugin writers, but it cannot assume
    // that an external process did not replace a physical directory.
    await verifyCoordinatorRoots(input, storageRootPath);
    const receipt = await stageRecordMutationTrash({
      mutationId: current.record.mutationId,
      sourceRootPath: input.sourceRootPath,
      sourceRootBinding: input.sourceRootBinding,
      sourceRelativePath: item.sourceRelativePath,
      trashRootPath: input.trashRootPath,
      trashRootBinding: input.trashRootBinding,
      transfer: "move",
      stagedAt: clockTimestamp(input.now)
    });
    assertReceiptAuthorizedByIntent(
      current,
      input.participantId,
      receipt
    );
    leafReceipts.push({ itemId: item.itemId, receipt });
    // Bundle tests may count this existing fault point to interrupt after an
    // arbitrary leaf. No aggregate Journal step is published until all leaves
    // have completed and read back successfully.
    await input.faultInjector?.("after-trash-prepared");
  }
  await verifyCoordinatorRoots(input, storageRootPath);
  const preparedReceipt = createTrashBundlePreparedReceipt({
    current,
    participantId: input.participantId,
    selectionDigest,
    items,
    leafReceipts,
    sourceRootBinding: input.sourceRootBinding,
    trashRootBinding: input.trashRootBinding
  });

  const trashStaged = findParticipantStep(
    current,
    input.participantId,
    "forward",
    "trash-staged"
  );
  if (trashStaged) {
    requireEvidenceDigest(
      trashStaged.evidenceDigest,
      preparedReceipt.digest,
      "trash-staged"
    );
  } else {
    requireForwardAppendable(current);
    current = await stageRecordMutationJournal(current.handle, {
      expectedRevision: current.record.revision,
      expectedDigest: current.record.digest,
      step: {
        direction: "forward",
        ordinal: nextDirectionOrdinal(current, "forward"),
        participantId: input.participantId,
        action: "trash-staged",
        evidenceDigest: preparedReceipt.digest
      },
      updatedAt: nextJournalTimestamp(current, input.now)
    });
  }
  await input.faultInjector?.("after-trash-authorized");
  return { journal: current, preparedReceipt, leafReceipts };
}

function createTrashBundlePreparedReceipt(input: {
  current: LoadedRecordMutationJournal;
  participantId: string;
  selectionDigest: string;
  items: readonly RecordMutationTrashBundleItem[];
  leafReceipts: readonly RecordMutationTrashBundleLeafReceipt[];
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
}): RecordMutationTrashBundlePreparedReceipt {
  const items = parseTrashBundleItems(input.items);
  const leaves = normalizeTrashBundleLeafReceipts(
    input.current,
    input.participantId,
    items,
    input.leafReceipts,
    input.sourceRootBinding,
    input.trashRootBinding
  );
  const withoutDigest: Omit<
    RecordMutationTrashBundlePreparedReceipt,
    "digest"
  > = {
    schemaVersion: 1,
    kind: "record-mutation-trash-bundle-prepared",
    mutationId: input.current.record.mutationId,
    participantId: requireBundleId(
      input.participantId,
      "participantId"
    ),
    selectionDigest: requireBundleDigest(
      input.selectionDigest,
      "selectionDigest"
    ),
    sourceRootBinding: parseRecordRootBindingRef(input.sourceRootBinding),
    trashRootBinding: parseRecordRootBindingRef(input.trashRootBinding),
    leaves: leaves.map((leaf, index) => ({
      itemId: leaf.itemId,
      sourceRelativePath: items[index].sourceRelativePath,
      receiptDigest: leaf.receipt.digest
    })),
    stagedAt: Math.max(...leaves.map((leaf) => leaf.receipt.stagedAt))
  };
  return parseTrashBundlePreparedReceipt({
    ...withoutDigest,
    digest: recordMutationDigest(withoutDigest)
  });
}

function parseTrashBundlePreparedReceipt(
  value: unknown
): RecordMutationTrashBundlePreparedReceipt {
  try {
    assertBundleReceiptSize(value, "Trash bundle prepared receipt");
    const record = requireBundleRecord(
      value,
      "Trash bundle prepared receipt"
    );
    assertBundleExactKeys(record, [
      "schemaVersion",
      "kind",
      "mutationId",
      "participantId",
      "selectionDigest",
      "sourceRootBinding",
      "trashRootBinding",
      "leaves",
      "stagedAt",
      "digest"
    ], "Trash bundle prepared receipt");
    if (
      record.schemaVersion !== 1
      || record.kind !== "record-mutation-trash-bundle-prepared"
      || !Array.isArray(record.leaves)
      || record.leaves.length < 1
      || record.leaves.length > MAX_BUNDLE_ITEMS
    ) {
      throw bundleMismatch("Trash bundle prepared receipt 结构非法");
    }
    const leaves = record.leaves.map((value, index) => {
      const leaf = requireBundleRecord(
        value,
        `Trash bundle prepared leaves[${index}]`
      );
      assertBundleExactKeys(
        leaf,
        ["itemId", "sourceRelativePath", "receiptDigest"],
        `Trash bundle prepared leaves[${index}]`
      );
      return {
        itemId: requireBundleId(
          leaf.itemId,
          `Trash bundle prepared leaves[${index}].itemId`
        ),
        sourceRelativePath: requireBundleRelativePath(
          leaf.sourceRelativePath,
          `Trash bundle prepared leaves[${index}].sourceRelativePath`
        ),
        receiptDigest: requireBundleDigest(
          leaf.receiptDigest,
          `Trash bundle prepared leaves[${index}].receiptDigest`
        )
      };
    });
    assertTrashBundleLeafOrder(
      leaves.map(({ itemId, sourceRelativePath }) => ({
        itemId,
        sourceRelativePath
      }))
    );
    const parsed: RecordMutationTrashBundlePreparedReceipt = {
      schemaVersion: 1,
      kind: "record-mutation-trash-bundle-prepared",
      mutationId: requireBundleId(record.mutationId, "mutationId"),
      participantId: requireBundleId(record.participantId, "participantId"),
      selectionDigest: requireBundleDigest(
        record.selectionDigest,
        "selectionDigest"
      ),
      sourceRootBinding: parseRecordRootBindingRef(record.sourceRootBinding),
      trashRootBinding: parseRecordRootBindingRef(record.trashRootBinding),
      leaves,
      stagedAt: requireBundleTimestamp(record.stagedAt, "stagedAt"),
      digest: requireBundleDigest(record.digest, "digest")
    };
    const { digest: _digest, ...withoutDigest } = parsed;
    if (parsed.digest !== recordMutationDigest(withoutDigest)) {
      throw bundleMismatch("Trash bundle prepared receipt digest 不匹配");
    }
    return parsed;
  } catch (error) {
    if (error instanceof RecordMutationCoordinatorError) throw error;
    throw bundleMismatch(
      `Trash bundle prepared receipt 非法：${errorMessage(error)}`
    );
  }
}

function validateTrashBundleEvidence(
  current: LoadedRecordMutationJournal,
  input: RecordMutationTrashBundleEvidenceInput
): {
  preparedReceipt: RecordMutationTrashBundlePreparedReceipt;
  leafReceipts: RecordMutationTrashBundleLeafReceipt[];
} {
  const items = parseTrashBundleItems(input.items);
  const selectionDigest = requireBundleDigest(
    input.selectionDigest,
    "selectionDigest"
  );
  assertTrashBundleParticipantIdentity(
    current,
    input,
    selectionDigest,
    items
  );
  const leafReceipts = normalizeTrashBundleLeafReceipts(
    current,
    input.participantId,
    items,
    input.leafReceipts,
    input.sourceRootBinding,
    input.trashRootBinding
  );
  const preparedReceipt = parseTrashBundlePreparedReceipt(
    input.preparedReceipt
  );
  if (
    preparedReceipt.mutationId !== current.record.mutationId
    || preparedReceipt.participantId !== input.participantId
    || preparedReceipt.selectionDigest !== selectionDigest
    || !sameRecordRootBindingRef(
      preparedReceipt.sourceRootBinding,
      input.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      preparedReceipt.trashRootBinding,
      input.trashRootBinding
    )
  ) {
    throw bundleMismatch(
      "Trash bundle prepared receipt 与 Journal/input 不匹配"
    );
  }
  const rebuilt = createTrashBundlePreparedReceipt({
    current,
    participantId: input.participantId,
    selectionDigest,
    items,
    leafReceipts,
    sourceRootBinding: input.sourceRootBinding,
    trashRootBinding: input.trashRootBinding
  });
  if (
    stableRecordMutationStringify(rebuilt)
    !== stableRecordMutationStringify(preparedReceipt)
  ) {
    throw bundleMismatch(
      "Trash bundle aggregate receipt 与逐叶 durable receipt 不匹配"
    );
  }
  return { preparedReceipt, leafReceipts };
}

function assertTrashBundleParticipantIdentity(
  current: LoadedRecordMutationJournal,
  input: Pick<
    RecordMutationTrashBundleInput,
    "participantId" | "sourceRootBinding" | "trashRootBinding"
  >,
  selectionDigest: string,
  items: readonly RecordMutationTrashBundleItem[]
): void {
  const participant = current.record.intent.participants.find(
    (candidate) => candidate.id === input.participantId
  );
  if (!participant) {
    throw bundleMismatch("Trash bundle participant 不属于 Journal intent");
  }
  const expectedParticipantId = recordMutationExecutionBundleParticipantId({
    recordKind: participant.recordKind,
    action: participant.action,
    execution: {
      kind: "trash-bundle",
      sourceRootId: input.sourceRootBinding.rootId,
      trashRootId: input.trashRootBinding.rootId,
      selectionDigest,
      items: items.map((item) => ({ ...item }))
    }
  });
  if (input.participantId !== expectedParticipantId) {
    throw bundleMismatch(
      "Trash bundle participantId 未绑定完整 selection/items/Root"
    );
  }
}

function normalizeTrashBundleLeafReceipts(
  current: LoadedRecordMutationJournal,
  participantId: string,
  items: readonly RecordMutationTrashBundleItem[],
  leafReceiptsInput: readonly RecordMutationTrashBundleLeafReceipt[],
  sourceRootBinding: RecordRootBindingRef,
  trashRootBinding: RecordRootBindingRef
): RecordMutationTrashBundleLeafReceipt[] {
  if (
    !Array.isArray(leafReceiptsInput)
    || leafReceiptsInput.length !== items.length
  ) {
    throw bundleMismatch("Trash bundle leaf receipt 数量不匹配");
  }
  const leaves = leafReceiptsInput.map((value, index) => {
    const leaf = requireBundleRecord(
      value,
      `Trash bundle leafReceipts[${index}]`
    );
    assertBundleExactKeys(
      leaf,
      ["itemId", "receipt"],
      `Trash bundle leafReceipts[${index}]`
    );
    const itemId = requireBundleId(
      leaf.itemId,
      `Trash bundle leafReceipts[${index}].itemId`
    );
    const receipt = parseRecordMutationTrashReceipt(leaf.receipt);
    const item = items[index];
    assertReceiptAuthorizedByIntent(current, participantId, receipt);
    if (
      itemId !== item.itemId
      || receipt.locator.sourceRelativePath !== item.sourceRelativePath
      || receipt.transfer !== "move"
      || !sameRecordRootBindingRef(
        receipt.sourceRootBinding,
        sourceRootBinding
      )
      || !sameRecordRootBindingRef(
        receipt.trashRootBinding,
        trashRootBinding
      )
    ) {
      throw bundleMismatch(
        `Trash bundle leaf ${itemId} 与冻结 item/Root 不匹配`
      );
    }
    return { itemId, receipt };
  });
  if (new Set(leaves.map((leaf) => leaf.itemId)).size !== leaves.length) {
    throw bundleMismatch("Trash bundle leaf receipt itemId 重复");
  }
  return leaves;
}

function parseTrashBundleItems(
  value: readonly RecordMutationTrashBundleItem[]
): RecordMutationTrashBundleItem[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_BUNDLE_ITEMS
  ) {
    throw bundleMismatch("Trash bundle items 数量非法");
  }
  const items = value.map((candidate, index) => {
    const item = requireBundleRecord(
      candidate,
      `Trash bundle items[${index}]`
    );
    assertBundleExactKeys(
      item,
      ["itemId", "sourceRelativePath"],
      `Trash bundle items[${index}]`
    );
    return {
      itemId: requireBundleId(
        item.itemId,
        `Trash bundle items[${index}].itemId`
      ),
      sourceRelativePath: requireBundleRelativePath(
        item.sourceRelativePath,
        `Trash bundle items[${index}].sourceRelativePath`
      )
    };
  });
  assertTrashBundleLeafOrder(items);
  return items;
}

function assertTrashBundleLeafOrder(
  items: readonly RecordMutationTrashBundleItem[]
): void {
  const keys = items.map(
    (item) => `${item.itemId}\0${item.sourceRelativePath}`
  );
  const sorted = [...keys].sort((left, right) => left.localeCompare(right));
  const sourcePaths = items.map((item) => item.sourceRelativePath);
  const sourcePathSet = new Set(sourcePaths);
  const hasNestedSourcePath = sourcePaths.some((sourcePath) => {
    const segments = sourcePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (sourcePathSet.has(segments.slice(0, index).join("/"))) {
        return true;
      }
    }
    return false;
  });
  if (
    new Set(items.map((item) => item.itemId)).size !== items.length
    || new Set(items.map((item) => item.sourceRelativePath)).size
      !== items.length
    || keys.some((key, index) => key !== sorted[index])
    || hasNestedSourcePath
  ) {
    throw bundleMismatch(
      "Trash bundle items 必须按 itemId/path 唯一、稳定排序且路径不嵌套"
    );
  }
}

function createTrashBundleFinalizationReceipt(input: {
  current: LoadedRecordMutationJournal;
  participantId: string;
  preparedReceipt: RecordMutationTrashBundlePreparedReceipt;
  finalizedLeaves: readonly {
    itemId: string;
    receipt: RecordMutationTrashFinalizationReceipt;
  }[];
}): RecordMutationTrashBundleFinalizationReceipt {
  const preparedReceipt = parseTrashBundlePreparedReceipt(
    input.preparedReceipt
  );
  if (
    preparedReceipt.mutationId !== input.current.record.mutationId
    || preparedReceipt.participantId !== input.participantId
    || input.finalizedLeaves.length !== preparedReceipt.leaves.length
  ) {
    throw bundleMismatch(
      "Trash bundle finalization 与 prepared receipt 不匹配"
    );
  }
  const finalizedLeaves = input.finalizedLeaves.map((value, index) => {
    const expected = preparedReceipt.leaves[index];
    const itemId = requireBundleId(
      value.itemId,
      `Trash bundle finalization leaves[${index}].itemId`
    );
    const receipt = parseRecordMutationTrashFinalizationReceipt(
      value.receipt
    );
    if (
      itemId !== expected.itemId
      || receipt.mutationId !== preparedReceipt.mutationId
      || receipt.preparedReceiptDigest !== expected.receiptDigest
      || receipt.locator.sourceRelativePath !== expected.sourceRelativePath
      || !sameRecordRootBindingRef(
        receipt.sourceRootBinding,
        preparedReceipt.sourceRootBinding
      )
      || !sameRecordRootBindingRef(
        receipt.trashRootBinding,
        preparedReceipt.trashRootBinding
      )
    ) {
      throw bundleMismatch(
        `Trash bundle finalization leaf ${itemId} 与 prepared receipt 不匹配`
      );
    }
    return { itemId, receipt };
  });
  const withoutDigest: Omit<
    RecordMutationTrashBundleFinalizationReceipt,
    "digest"
  > = {
    schemaVersion: 1,
    kind: "record-mutation-trash-bundle-finalization",
    mutationId: preparedReceipt.mutationId,
    participantId: preparedReceipt.participantId,
    preparedReceiptDigest: preparedReceipt.digest,
    leaves: finalizedLeaves.map((leaf) => ({
      itemId: leaf.itemId,
      finalizationDigest: leaf.receipt.digest
    })),
    finalizedAt: Math.max(
      ...finalizedLeaves.map((leaf) => leaf.receipt.finalizedAt)
    )
  };
  return parseTrashBundleFinalizationReceipt({
    ...withoutDigest,
    digest: recordMutationDigest(withoutDigest)
  });
}

function parseTrashBundleFinalizationReceipt(
  value: unknown
): RecordMutationTrashBundleFinalizationReceipt {
  try {
    assertBundleReceiptSize(value, "Trash bundle finalization receipt");
    const record = requireBundleRecord(
      value,
      "Trash bundle finalization receipt"
    );
    assertBundleExactKeys(record, [
      "schemaVersion",
      "kind",
      "mutationId",
      "participantId",
      "preparedReceiptDigest",
      "leaves",
      "finalizedAt",
      "digest"
    ], "Trash bundle finalization receipt");
    if (
      record.schemaVersion !== 1
      || record.kind !== "record-mutation-trash-bundle-finalization"
      || !Array.isArray(record.leaves)
      || record.leaves.length < 1
      || record.leaves.length > MAX_BUNDLE_ITEMS
    ) {
      throw bundleMismatch("Trash bundle finalization receipt 结构非法");
    }
    const leaves = record.leaves.map((value, index) => {
      const leaf = requireBundleRecord(
        value,
        `Trash bundle finalization leaves[${index}]`
      );
      assertBundleExactKeys(
        leaf,
        ["itemId", "finalizationDigest"],
        `Trash bundle finalization leaves[${index}]`
      );
      return {
        itemId: requireBundleId(
          leaf.itemId,
          `Trash bundle finalization leaves[${index}].itemId`
        ),
        finalizationDigest: requireBundleDigest(
          leaf.finalizationDigest,
          `Trash bundle finalization leaves[${index}].finalizationDigest`
        )
      };
    });
    const sortedItemIds = leaves
      .map((leaf) => leaf.itemId)
      .sort((left, right) => left.localeCompare(right));
    if (
      new Set(leaves.map((leaf) => leaf.itemId)).size !== leaves.length
      || leaves.some((leaf, index) => leaf.itemId !== sortedItemIds[index])
    ) {
      throw bundleMismatch(
        "Trash bundle finalization leaves 必须唯一且稳定排序"
      );
    }
    const parsed: RecordMutationTrashBundleFinalizationReceipt = {
      schemaVersion: 1,
      kind: "record-mutation-trash-bundle-finalization",
      mutationId: requireBundleId(record.mutationId, "mutationId"),
      participantId: requireBundleId(record.participantId, "participantId"),
      preparedReceiptDigest: requireBundleDigest(
        record.preparedReceiptDigest,
        "preparedReceiptDigest"
      ),
      leaves,
      finalizedAt: requireBundleTimestamp(
        record.finalizedAt,
        "finalizedAt"
      ),
      digest: requireBundleDigest(record.digest, "digest")
    };
    const { digest: _digest, ...withoutDigest } = parsed;
    if (parsed.digest !== recordMutationDigest(withoutDigest)) {
      throw bundleMismatch("Trash bundle finalization receipt digest 不匹配");
    }
    return parsed;
  } catch (error) {
    if (error instanceof RecordMutationCoordinatorError) throw error;
    throw bundleMismatch(
      `Trash bundle finalization receipt 非法：${errorMessage(error)}`
    );
  }
}

async function loadTrashBundleFinalizationReceipt(input: {
  current: LoadedRecordMutationJournal;
  participantId: string;
  preparedReceipt: RecordMutationTrashBundlePreparedReceipt;
  leafReceipts: readonly RecordMutationTrashBundleLeafReceipt[];
  sourceRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootPath: string;
  trashRootBinding: RecordRootBindingRef;
}): Promise<RecordMutationTrashBundleFinalizationReceipt> {
  const finalizedLeaves: Array<{
    itemId: string;
    receipt: RecordMutationTrashFinalizationReceipt;
  }> = [];
  for (const leaf of input.leafReceipts) {
    const receipt = await inspectRecordMutationTrashFinalization({
      receipt: leaf.receipt,
      sourceRootPath: input.sourceRootPath,
      sourceRootBinding: input.sourceRootBinding,
      trashRootPath: input.trashRootPath,
      trashRootBinding: input.trashRootBinding
    });
    if (!receipt) {
      throw bundleMismatch(
        `Trash bundle leaf ${leaf.itemId} 缺少 durable finalization receipt`
      );
    }
    finalizedLeaves.push({ itemId: leaf.itemId, receipt });
  }
  return createTrashBundleFinalizationReceipt({
    current: input.current,
    participantId: input.participantId,
    preparedReceipt: input.preparedReceipt,
    finalizedLeaves
  });
}

/**
 * Restore is intentionally a separate coordinator entry. It requires a
 * durable `compensation-prepared` Journal authorization and re-verifies both
 * frozen roots before the no-clobber restore effect.
 */
export async function coordinateRecordMutationTrashRestore(
  input: CoordinateRecordMutationTrashRestoreInput
): Promise<CoordinatedRecordMutationTrashRestore> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      let current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "compensating"
      );
      const receipt = parseRecordMutationTrashReceipt(input.receipt);
      assertReceiptAuthorizedByIntent(current, input.participantId, receipt);
      requireAuthorizedRecoveryChain(current, input.participantId, receipt);
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-root-bindings-verified");

      const judgment = await restoreRecordMutationTrash({
        receipt,
        sourceRootPath: input.sourceRootPath,
        sourceRootBinding: input.sourceRootBinding,
        trashRootPath: input.trashRootPath,
        trashRootBinding: input.trashRootBinding
      });
      await input.faultInjector?.("after-trash-restored");

      const restored = findParticipantStep(
        current,
        input.participantId,
        "compensating",
        "trash-restored"
      );
      if (restored) {
        requireEvidenceDigest(
          restored.evidenceDigest,
          receipt.digest,
          "trash-restored"
        );
      } else {
        if (current.record.state !== "compensating") {
          throw new RecordMutationCoordinatorError(
            "authorization_missing",
            "trash restore 只能追加到 compensating Journal"
          );
        }
        current = await beginRecordMutationCompensation(current.handle, {
          expectedRevision: current.record.revision,
          expectedDigest: current.record.digest,
          step: {
            direction: "compensating",
            ordinal: nextDirectionOrdinal(current, "compensating"),
            participantId: input.participantId,
            action: "trash-restored",
            evidenceDigest: receipt.digest
          },
          updatedAt: nextJournalTimestamp(current, input.now)
        });
      }
      await input.faultInjector?.("after-trash-restore-journaled");
      return { journal: current, judgment };
    }
  );
}

export async function coordinateRecordMutationTrashBundleRestore(
  input: RecordMutationTrashBundleEvidenceInput
): Promise<CoordinatedRecordMutationTrashBundleRestore> {
  return await withGlobalMutationAuthority(
    input.storageRootPath,
    input.journal.record.mutationId,
    async (storageRootPath) => {
      await input.faultInjector?.("after-authority-acquired");
      let current = await loadAndValidateJournal(
        input,
        storageRootPath,
        "compensating"
      );
      const evidence = validateTrashBundleEvidence(current, input);
      const recovery = requireAuthorizedTrashBundleRecoveryChain(
        current,
        input.participantId,
        evidence.preparedReceipt
      );
      await verifyCoordinatorRoots(input, storageRootPath);
      await input.faultInjector?.("after-root-bindings-verified");
      const finalizationReceipt = await loadTrashBundleFinalizationReceipt({
        current,
        participantId: input.participantId,
        preparedReceipt: evidence.preparedReceipt,
        leafReceipts: evidence.leafReceipts,
        sourceRootPath: input.sourceRootPath,
        sourceRootBinding: input.sourceRootBinding,
        trashRootPath: input.trashRootPath,
        trashRootBinding: input.trashRootBinding
      });
      requireEvidenceDigest(
        recovery.sourceRetired.evidenceDigest,
        finalizationReceipt.digest,
        "source-retired"
      );

      // Inspect the whole bundle before writing the first restored leaf. This
      // cannot make a multi-file restore physically atomic, but it prevents a
      // known conflicting leaf from causing an avoidable partial restore.
      const preflightJudgments: InspectedRecordMutationTrashBundleRecovery[
        "judgments"
      ] = [];
      for (const leaf of evidence.leafReceipts) {
        preflightJudgments.push({
          itemId: leaf.itemId,
          judgment: await judgeRecordMutationTrashRestore({
            receipt: leaf.receipt,
            sourceRootPath: input.sourceRootPath,
            sourceRootBinding: input.sourceRootBinding,
            trashRootPath: input.trashRootPath,
            trashRootBinding: input.trashRootBinding
          })
        });
      }
      const blocked = preflightJudgments.find(
        (entry) => entry.judgment.status === "blocked"
      );
      if (blocked && blocked.judgment.status === "blocked") {
        throw bundleMismatch(
          `Trash bundle restore 被 leaf ${blocked.itemId} 阻断：`
          + blocked.judgment.reason
        );
      }

      const judgments: InspectedRecordMutationTrashBundleRecovery[
        "judgments"
      ] = [];
      for (const leaf of evidence.leafReceipts) {
        await verifyCoordinatorRoots(input, storageRootPath);
        await input.faultInjector?.("after-root-bindings-verified");
        judgments.push({
          itemId: leaf.itemId,
          judgment: await restoreRecordMutationTrash({
            receipt: leaf.receipt,
            sourceRootPath: input.sourceRootPath,
            sourceRootBinding: input.sourceRootBinding,
            trashRootPath: input.trashRootPath,
            trashRootBinding: input.trashRootBinding
          })
        });
        await input.faultInjector?.("after-trash-restored");
      }
      await verifyCoordinatorRoots(input, storageRootPath);

      const restored = findParticipantStep(
        current,
        input.participantId,
        "compensating",
        "trash-restored"
      );
      if (restored) {
        requireEvidenceDigest(
          restored.evidenceDigest,
          evidence.preparedReceipt.digest,
          "trash-restored"
        );
      } else {
        if (current.record.state !== "compensating") {
          throw new RecordMutationCoordinatorError(
            "authorization_missing",
            "Trash bundle restore 只能追加到 compensating Journal"
          );
        }
        current = await beginRecordMutationCompensation(current.handle, {
          expectedRevision: current.record.revision,
          expectedDigest: current.record.digest,
          step: {
            direction: "compensating",
            ordinal: nextDirectionOrdinal(current, "compensating"),
            participantId: input.participantId,
            action: "trash-restored",
            evidenceDigest: evidence.preparedReceipt.digest
          },
          updatedAt: nextJournalTimestamp(current, input.now)
        });
      }
      await input.faultInjector?.("after-trash-restore-journaled");
      return {
        journal: current,
        preparedReceipt: evidence.preparedReceipt,
        judgments
      };
    }
  );
}

async function loadAndValidateJournal(
  input: RecordMutationCoordinatorBaseInput,
  storageRootPath: string,
  direction: "forward" | "compensating" | "inspect"
): Promise<LoadedRecordMutationJournal> {
  const journalStorageRootPath = await resolveDurablePlainRoot(
    input.journal.handle.storageRootPath,
    "RecordMutation Journal storage root"
  );
  if (journalStorageRootPath !== storageRootPath) {
    throw new RecordMutationCoordinatorError(
      "journal_mismatch",
      "RecordMutation Journal 与全局 mutation authority 不属于同一 storage root"
    );
  }
  const current = await loadRecordMutationJournal(input.journal.handle);
  if (current.record.mutationId !== input.journal.record.mutationId) {
    throw new RecordMutationCoordinatorError(
      "journal_mismatch",
      "RecordMutation Journal mutationId 已变化"
    );
  }
  const participant = current.record.intent.participants.find(
    (candidate) => candidate.id === input.participantId
  );
  requireDestructiveParticipant(current, participant);
  assertInputBindingsMatchIntent(current, input);
  if (
    direction === "forward"
    && (
      current.record.state === "compensating"
      || current.record.state === "aborted"
    )
  ) {
    throw new RecordMutationCoordinatorError(
      "authorization_missing",
      `Journal ${current.record.state} 不允许继续退休 source`
    );
  }
  return current;
}

function requireDestructiveParticipant(
  journal: LoadedRecordMutationJournal,
  participant: RecordMutationParticipant | undefined
): asserts participant is RecordMutationParticipant {
  if (
    journal.record.intent.trashPolicy !== "required"
    || !participant
    || (participant.action !== "stage" && participant.action !== "discard")
  ) {
    throw new RecordMutationCoordinatorError(
      "authorization_missing",
      "Journal 未授权该 participant 执行 destructive Trash mutation"
    );
  }
}

function assertInputBindingsMatchIntent(
  journal: LoadedRecordMutationJournal,
  input: RecordMutationCoordinatorRoots
): void {
  const sourceRootBinding = parseRecordRootBindingRef(input.sourceRootBinding);
  const trashRootBinding = parseRecordRootBindingRef(input.trashRootBinding);
  if (
    sourceRootBinding.rootId === trashRootBinding.rootId
    || !containsRootBinding(journal, sourceRootBinding)
    || !containsRootBinding(journal, trashRootBinding)
  ) {
    throw new RecordMutationCoordinatorError(
      "journal_mismatch",
      "coordinator Root Binding 不属于 destructive intent"
    );
  }
}

function assertReceiptAuthorizedByIntent(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  receipt: RecordMutationTrashReceipt
): void {
  if (
    receipt.mutationId !== journal.record.mutationId
    || receipt.sourceRootBinding.rootId !== receipt.locator.sourceRootId
    || receipt.trashRootBinding.rootId !== receipt.locator.trashRootId
    || !containsRootBinding(journal, receipt.sourceRootBinding)
    || !containsRootBinding(journal, receipt.trashRootBinding)
    || !journal.record.intent.participants.some(
      (participant) => participant.id === participantId
    )
  ) {
    throw new RecordMutationCoordinatorError(
      "journal_mismatch",
      "Trash receipt 未被当前 Journal intent 授权"
    );
  }
}

function requireAuthorizedRecoveryChain(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  receipt: RecordMutationTrashReceipt
): void {
  const trashStaged = findParticipantStep(
    journal,
    participantId,
    "forward",
    "trash-staged"
  );
  const sourceRetired = findParticipantStep(
    journal,
    participantId,
    "forward",
    "source-retired"
  );
  const compensationPrepared = findParticipantStep(
    journal,
    participantId,
    "compensating",
    "compensation-prepared"
  );
  if (!trashStaged || !sourceRetired || !compensationPrepared) {
    throw new RecordMutationCoordinatorError(
      "authorization_missing",
      "Trash restore 缺少 trash-staged/source-retired/compensation-prepared 授权链"
    );
  }
  requireEvidenceDigest(
    trashStaged.evidenceDigest,
    receipt.digest,
    "trash-staged"
  );
  requireEvidenceDigest(
    compensationPrepared.evidenceDigest,
    receipt.digest,
    "compensation-prepared"
  );
}

function requireAuthorizedTrashBundleRecoveryChain(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  preparedReceipt: RecordMutationTrashBundlePreparedReceipt
): {
  sourceRetired: { evidenceDigest: string };
} {
  const trashStaged = findParticipantStep(
    journal,
    participantId,
    "forward",
    "trash-staged"
  );
  const sourceRetired = findParticipantStep(
    journal,
    participantId,
    "forward",
    "source-retired"
  );
  const compensationPrepared = findParticipantStep(
    journal,
    participantId,
    "compensating",
    "compensation-prepared"
  );
  if (!trashStaged || !sourceRetired || !compensationPrepared) {
    throw new RecordMutationCoordinatorError(
      "authorization_missing",
      "Trash bundle restore 缺少 trash-staged/source-retired/"
      + "compensation-prepared 授权链"
    );
  }
  requireEvidenceDigest(
    trashStaged.evidenceDigest,
    preparedReceipt.digest,
    "trash-staged"
  );
  requireEvidenceDigest(
    compensationPrepared.evidenceDigest,
    preparedReceipt.digest,
    "compensation-prepared"
  );
  return { sourceRetired };
}

async function verifyCoordinatorRoots(
  input: RecordMutationCoordinatorRoots,
  storageRootPath: string
): Promise<void> {
  await Promise.all([
    verifyRecordRootBindingRef(input.sourceRootBinding, {
      storageRootPath,
      rootPath: input.sourceRootPath,
      boundaryRootPath: input.sourceBoundaryRootPath
    }),
    verifyRecordRootBindingRef(input.trashRootBinding, {
      storageRootPath,
      rootPath: input.trashRootPath,
      boundaryRootPath: input.trashBoundaryRootPath
    })
  ]);
  const [sourceRootPath, trashRootPath] = await Promise.all([
    resolveDurablePlainRoot(input.sourceRootPath, "RecordMutation source root"),
    resolveDurablePlainRoot(input.trashRootPath, "RecordMutation trash root")
  ]);
  if (
    sourceRootPath === trashRootPath
    || isPathInside(sourceRootPath, trashRootPath)
    || isPathInside(trashRootPath, sourceRootPath)
  ) {
    throw new RecordMutationCoordinatorError(
      "journal_mismatch",
      "RecordMutation source/trash root 必须是互不重叠的独立目录"
    );
  }
}

function findParticipantStep(
  journal: LoadedRecordMutationJournal,
  participantId: string,
  direction: "forward" | "compensating",
  action: RecordMutationStepAction
): { evidenceDigest: string } | null {
  for (const revision of journal.chain) {
    if (
      revision.step?.participantId === participantId
      && revision.step.direction === direction
      && revision.step.action === action
    ) {
      return { evidenceDigest: revision.step.evidenceDigest };
    }
  }
  return null;
}

function nextDirectionOrdinal(
  journal: LoadedRecordMutationJournal,
  direction: "forward" | "compensating"
): number {
  const ordinals = journal.chain.flatMap((revision) => (
    revision.step?.direction === direction ? [revision.step.ordinal] : []
  ));
  return (ordinals.length ? Math.max(...ordinals) : 0) + 1;
}

function requireForwardAppendable(journal: LoadedRecordMutationJournal): void {
  if (
    journal.record.state !== "planned"
    && journal.record.state !== "staged"
  ) {
    throw new RecordMutationCoordinatorError(
      "authorization_missing",
      `Journal ${journal.record.state} 不允许追加 forward mutation step`
    );
  }
}

function requireEvidenceDigest(
  actual: string,
  expected: string,
  label: string
): void {
  if (actual !== expected) {
    throw new RecordMutationCoordinatorError(
      "journal_mismatch",
      `${label} evidenceDigest 与 durable receipt 不匹配`
    );
  }
}

function containsRootBinding(
  journal: LoadedRecordMutationJournal,
  expected: RecordRootBindingRef
): boolean {
  return journal.record.intent.rootBindings.some((binding) => (
    sameRecordRootBindingRef(binding, expected)
  ));
}

function nextJournalTimestamp(
  journal: LoadedRecordMutationJournal,
  now: (() => number) | undefined
): number {
  return Math.max(clockTimestamp(now), journal.record.updatedAt + 1);
}

function clockTimestamp(now: (() => number) | undefined): number {
  const value = now ? now() : Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecordMutationCoordinatorError(
      "journal_mismatch",
      "RecordMutation coordinator clock 非法"
    );
  }
  return value;
}

interface CoordinatorLockPayload {
  version: typeof COORDINATOR_LOCK_VERSION;
  pid: number;
  token: string;
  mutationId: string;
  createdAt: number;
}

interface AcquiredCoordinatorLock {
  handle: fsp.FileHandle;
  lockPath: string;
  dev: number;
  ino: number;
}

async function withGlobalMutationAuthority<T>(
  storageRootPathInput: string,
  mutationId: string,
  action: (storageRootPath: string) => Promise<T>
): Promise<T> {
  const storageRootPath = await resolveDurablePlainRoot(
    storageRootPathInput,
    "RecordMutation coordinator storage root"
  );
  const active = coordinatorAuthorityContext.getStore();
  if (active?.storageRootPath === storageRootPath) {
    return await action(storageRootPath);
  }
  return await withCoordinatorLane(storageRootPath, async () => {
    const lock = await acquireCoordinatorLock(
      path.join(storageRootPath, RECORD_MUTATION_GLOBAL_LOCK_FILE),
      {
        version: COORDINATOR_LOCK_VERSION,
        pid: process.pid,
        token: randomUUID(),
        mutationId,
        createdAt: Date.now()
      }
    );
    try {
      return await coordinatorAuthorityContext.run(
        { storageRootPath, mutationId },
        async () => await action(storageRootPath)
      );
    } finally {
      await releaseCoordinatorLock(lock);
    }
  });
}

async function acquireCoordinatorLock(
  lockPath: string,
  payload: CoordinatorLockPayload
): Promise<AcquiredCoordinatorLock> {
  const parentPath = path.dirname(lockPath);
  for (let attempt = 0; attempt < 250; attempt += 1) {
    let acquired: AcquiredCoordinatorLock | null = null;
    try {
      const handle = await fsp.open(
        lockPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | noFollowFlag(),
        0o600
      );
      const stat = await handle.stat();
      acquired = {
        handle,
        lockPath,
        dev: Number(stat.dev),
        ino: Number(stat.ino)
      };
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.sync();
      await syncDurableDirectory(parentPath);
      return acquired;
    } catch (error) {
      if (acquired) await releaseCoordinatorLock(acquired);
      if (!isAlreadyExists(error)) throw error;
      let owner: CoordinatorLockPayload;
      try {
        owner = await readCoordinatorLockOwner(lockPath);
      } catch (readError) {
        if (readError instanceof CoordinatorLockPublicationPending) {
          await delay(10);
          continue;
        }
        throw readError;
      }
      if (isProcessAlive(owner.pid)) {
        await delay(10);
        continue;
      }
      const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fsp.rename(lockPath, quarantinePath);
        await syncDurableDirectory(parentPath);
        await fsp.rm(quarantinePath, { force: true });
        await syncDurableDirectory(parentPath);
      } catch (renameError) {
        if (!isNotFound(renameError)) throw renameError;
      }
    }
  }
  throw new RecordMutationCoordinatorError(
    "authority_locked",
    "全局 RecordMutation authority 正被另一个存活进程持有"
  );
}

async function readCoordinatorLockOwner(
  lockPath: string
): Promise<CoordinatorLockPayload> {
  try {
    const { content } = await readDurableRegularFile(
      lockPath,
      MAX_COORDINATOR_LOCK_BYTES
    );
    const parsed = JSON.parse(content.toString("utf8")) as unknown;
    if (!isPlainRecord(parsed)) throw new Error("lock 不是对象");
    assertExactKeys(parsed, [
      "version",
      "pid",
      "token",
      "mutationId",
      "createdAt"
    ]);
    if (
      parsed.version !== COORDINATOR_LOCK_VERSION
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.token !== "string"
      || !LOCK_TOKEN_PATTERN.test(parsed.token)
      || typeof parsed.mutationId !== "string"
      || !parsed.mutationId
      || !Number.isSafeInteger(parsed.createdAt)
      || Number(parsed.createdAt) < 0
    ) {
      throw new Error("lock 字段非法");
    }
    return {
      version: COORDINATOR_LOCK_VERSION,
      pid: Number(parsed.pid),
      token: parsed.token,
      mutationId: parsed.mutationId,
      createdAt: Number(parsed.createdAt)
    };
  } catch (error) {
    if (isNotFound(error)) {
      return {
        version: COORDINATOR_LOCK_VERSION,
        pid: -1,
        token: randomUUID(),
        mutationId: "missing",
        createdAt: 0
      };
    }
    const stat = await durableLstatOrNull(lockPath).catch(() => null);
    const publicationAge = stat
      ? Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs)
      : Number.POSITIVE_INFINITY;
    if (
      stat
      && !stat.isSymbolicLink()
      && stat.isFile()
      && publicationAge >= -LOCK_PUBLICATION_GRACE_MS
      && publicationAge <= LOCK_PUBLICATION_GRACE_MS
    ) {
      throw new CoordinatorLockPublicationPending();
    }
    throw new RecordMutationCoordinatorError(
      "authority_corrupt",
      `全局 RecordMutation authority lock 损坏，拒绝自动删除：${errorMessage(error)}`
    );
  }
}

async function releaseCoordinatorLock(
  lock: AcquiredCoordinatorLock
): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const stat = await durableLstatOrNull(lock.lockPath);
  if (
    stat
    && !stat.isSymbolicLink()
    && stat.isFile()
    && Number(stat.dev) === lock.dev
    && Number(stat.ino) === lock.ino
  ) {
    await fsp.rm(lock.lockPath, { force: true });
    await syncDurableDirectory(path.dirname(lock.lockPath));
  }
}

async function withCoordinatorLane<T>(
  key: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = coordinatorLaneTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  coordinatorLaneTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (coordinatorLaneTails.get(key) === tail) {
      coordinatorLaneTails.delete(key);
    }
  }
}

function requireBundleRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw bundleMismatch(`${label} 必须是对象`);
  }
  return value;
}

function assertBundleExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw bundleMismatch(`${label} 字段集合非法`);
  }
}

function assertBundleReceiptSize(value: unknown, label: string): void {
  const bytes = Buffer.byteLength(
    stableRecordMutationStringify(value),
    "utf8"
  );
  if (bytes > MAX_BUNDLE_RECEIPT_BYTES) {
    throw bundleMismatch(`${label} 超过大小上限`);
  }
}

function requireBundleId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_BUNDLE_ID_PATTERN.test(value)) {
    throw bundleMismatch(`${label} 非法`);
  }
  return value;
}

function requireBundleDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw bundleMismatch(`${label} 非法`);
  }
  return value;
}

function requireBundleRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw bundleMismatch(`${label} 非法`);
  }
  try {
    return validateDurableRelativePath(value);
  } catch {
    throw bundleMismatch(`${label} 非法`);
  }
}

function requireBundleTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw bundleMismatch(`${label} 非法`);
  }
  return Number(value);
}

function bundleMismatch(message: string): RecordMutationCoordinatorError {
  return new RecordMutationCoordinatorError("journal_mismatch", message);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("lock 字段集合非法");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "missing";
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
  await delayTimer(milliseconds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
