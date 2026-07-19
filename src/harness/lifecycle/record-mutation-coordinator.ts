import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delayTimer } from "node:timers/promises";
import {
  durableLstatOrNull,
  readDurableRegularFile,
  resolveDurablePlainRoot,
  syncDurableDirectory
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
import type {
  RecordMutationParticipant,
  RecordMutationStepAction
} from "./record-mutation-contract";
import {
  finalizeRecordMutationTrash,
  judgeRecordMutationTrashRestore,
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
const coordinatorLaneTails = new Map<string, Promise<void>>();

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

interface RecordMutationCoordinatorBaseInput
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

export interface InspectRecordMutationTrashRecoveryInput
extends RecordMutationCoordinatorBaseInput {
  receipt: RecordMutationTrashReceipt;
}

export interface InspectedRecordMutationTrashRecovery {
  journal: LoadedRecordMutationJournal;
  judgment: RecordMutationTrashRestoreJudgment;
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
      return await action(storageRootPath);
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
