import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  DurableAppendOnlyCasError,
  ensureDurableRelativeParent,
  readDurableRegularFile,
  resolveExistingDurableRelativeFile,
  resolveDurablePlainRoot,
  sameDurableIdentity,
  syncDurableDirectory,
  validateDurableRelativePath,
  writeDurableNewFile
} from "../storage/durable-append-only-cas";
import {
  parseRecordRootBindingRef,
  sameRecordRootBindingRef,
  type RecordRootBindingRef
} from "../storage/record-root-registry";
import {
  recordMutationDigest,
  stableRecordMutationStringify
} from "./record-mutation-contract";

const TRASH_RECEIPT_SCHEMA_VERSION = 1;
const MAX_TRASH_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_TRASH_TREE_ENTRIES = 4_096;
const MAX_TRASH_TREE_DEPTH = 64;
const SAFE_ROOT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/;
const SAFE_MUTATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
let recordMutationTrashLaneTail: Promise<void> = Promise.resolve();

export type RecordMutationTrashErrorCode =
  | "invalid_path"
  | "unsafe_entry"
  | "source_missing"
  | "trash_conflict"
  | "receipt_corrupt"
  | "root_mismatch"
  | "restore_conflict"
  | "retirement_conflict";

export class RecordMutationTrashError extends Error {
  constructor(
    public readonly code: RecordMutationTrashErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RecordMutationTrashError";
  }
}

export interface RecordMutationTrashLocator {
  sourceRootId: string;
  sourceRelativePath: string;
  trashRootId: string;
  trashRelativePath: string;
  receiptRelativePath: string;
  retirementRelativePath: string;
  finalizationRelativePath: string;
}

export interface RecordMutationTrashContentReceipt {
  entryKind: "file" | "directory";
  sha256: string;
  size: number;
  mode: number;
  entryCount: number;
}

export interface RecordMutationTrashReceipt {
  schemaVersion: typeof TRASH_RECEIPT_SCHEMA_VERSION;
  kind: "record-mutation-trash-receipt";
  mutationId: string;
  locator: RecordMutationTrashLocator;
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  transfer: "copy" | "move";
  sourceDisposition: "retained";
  content: RecordMutationTrashContentReceipt;
  stagedAt: number;
  digest: string;
}

export interface RecordMutationTrashFinalizationReceipt {
  schemaVersion: 1;
  kind: "record-mutation-trash-finalization";
  mutationId: string;
  preparedReceiptDigest: string;
  locator: RecordMutationTrashLocator;
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  sourceDisposition: "retired";
  finalizedAt: number;
  digest: string;
}

export interface RecordMutationTrashRoots {
  sourceRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootPath: string;
  trashRootBinding: RecordRootBindingRef;
}

export interface StageRecordMutationTrashInput extends RecordMutationTrashRoots {
  mutationId: string;
  sourceRelativePath: string;
  transfer: "copy" | "move";
  stagedAt: number;
}

export const RECORD_MUTATION_TRASH_NODE_THREAT_BOUNDARY =
  "canonical-plugin-owned-roots-with-cooperative-writers" as const;

export type RecordMutationTrashRestoreJudgment =
  | { status: "restore-required"; reason: "source-missing-trash-exact" }
  | { status: "restore-required"; reason: "source-partial-trash-exact" }
  | { status: "already-restored"; reason: "source-and-trash-exact" }
  | {
      status: "blocked";
      reason:
        | "trash-missing"
        | "trash-conflict"
        | "source-conflict"
        | "source-and-trash-share-inode";
    };

export async function stageRecordMutationTrash(
  input: StageRecordMutationTrashInput
): Promise<RecordMutationTrashReceipt> {
  return await withRecordMutationTrashLane(
    async () => await stageRecordMutationTrashUnlocked(input)
  );
}

async function stageRecordMutationTrashUnlocked(
  input: StageRecordMutationTrashInput
): Promise<RecordMutationTrashReceipt> {
  try {
    const mutationId = requireSafeToken(
      input.mutationId,
      SAFE_MUTATION_ID,
      "mutationId"
    );
    const sourceRootBinding = parseTrashRootBinding(
      input.sourceRootBinding,
      "sourceRootBinding"
    );
    const trashRootBinding = parseTrashRootBinding(
      input.trashRootBinding,
      "trashRootBinding"
    );
    assertDistinctTrashRootBindings(sourceRootBinding, trashRootBinding);
    const sourceRootId = sourceRootBinding.rootId;
    const trashRootId = trashRootBinding.rootId;
    const sourceRelativePath = validateDurableRelativePath(
      input.sourceRelativePath
    );
    if (input.transfer !== "copy" && input.transfer !== "move") {
      throw new RecordMutationTrashError("receipt_corrupt", "transfer 非法");
    }
    requireSafeInteger(input.stagedAt, "stagedAt", 0);
    const sourceRootPath = await resolveDurablePlainRoot(
      input.sourceRootPath,
      "trash source root"
    );
    const trashRootPath = await resolveDurablePlainRoot(
      input.trashRootPath,
      "record mutation trash root"
    );
    const paths = trashPathsFor(
      mutationId,
      sourceRootId,
      sourceRelativePath
    );
    const locator: RecordMutationTrashLocator = {
      sourceRootId,
      sourceRelativePath,
      trashRootId,
      ...paths
    };

    const persisted = await readPersistedPreparedReceipt(
      trashRootPath,
      locator.receiptRelativePath
    );
    if (persisted) {
      assertPreparedReceiptMatchesRequest(persisted, {
        mutationId,
        locator,
        sourceRootBinding,
        trashRootBinding,
        transfer: input.transfer
      });
      await assertPreparedTrashContentExact(
        persisted,
        sourceRootPath,
        trashRootPath,
        true
      );
      return persisted;
    }

    const source = await captureRelativeEntry(sourceRootPath, sourceRelativePath);
    if (!source) {
      throw new RecordMutationTrashError(
        "source_missing",
        `trash source 不存在：${sourceRelativePath}`
      );
    }
    const expectedContent = capturedContentReceipt(source);
    const target = await ensureDurableRelativeParent(
      trashRootPath,
      locator.trashRelativePath
    );
    if (path.resolve(target.absolutePath) === path.resolve(
      path.join(sourceRootPath, ...sourceRelativePath.split("/"))
    )) {
      throw new RecordMutationTrashError(
        "invalid_path",
        "trash target 与 source 相同"
      );
    }

    // `stage` is deliberately prepare-only. Even a legacy `transfer: "move"`
    // request first creates durable, independently restorable trash and leaves
    // the source in place. Source retirement requires an explicit finalize.
    await copyCapturedEntry(source, target.absolutePath, target.parentPath);

    const trashReadback = await captureRelativeEntry(
      trashRootPath,
      locator.trashRelativePath
    );
    if (!trashReadback || !matchesCapturedContent(trashReadback, expectedContent)) {
      throw new RecordMutationTrashError(
        "trash_conflict",
        "prepare 后 trash readback 不匹配"
      );
    }
    const sourceReadback = await captureRelativeEntry(
      sourceRootPath,
      sourceRelativePath
    );
    if (!sourceReadback || !capturedEntriesEqual(sourceReadback, source)) {
      throw new RecordMutationTrashError(
        "trash_conflict",
        "prepare 后 source identity/content 已变化"
      );
    }

    const receiptWithoutDigest: Omit<RecordMutationTrashReceipt, "digest"> = {
      schemaVersion: TRASH_RECEIPT_SCHEMA_VERSION,
      kind: "record-mutation-trash-receipt",
      mutationId,
      locator,
      sourceRootBinding,
      trashRootBinding,
      transfer: input.transfer,
      sourceDisposition: "retained",
      content: expectedContent,
      stagedAt: input.stagedAt
    };
    const receipt = parseRecordMutationTrashReceipt({
      ...receiptWithoutDigest,
      digest: recordMutationDigest(receiptWithoutDigest)
    });
    const durableReceipt = await persistPreparedReceipt(trashRootPath, receipt);
    const finalSourceReadback = await captureRelativeEntry(
      sourceRootPath,
      sourceRelativePath
    );
    if (
      !finalSourceReadback
      || !capturedEntriesEqual(finalSourceReadback, source)
    ) {
      throw new RecordMutationTrashError(
        "trash_conflict",
        "prepared receipt 落盘后 source identity/content 已变化"
      );
    }
    return durableReceipt;
  } catch (error) {
    throw mapTrashError(error);
  }
}

export function parseRecordMutationTrashReceipt(
  value: unknown
): RecordMutationTrashReceipt {
  try {
    const record = requirePlainRecord(value, "trash receipt");
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECEIPT_BYTES) {
      throw receiptCorrupt("trash receipt 超过大小上限");
    }
    assertExactKeys(record, [
      "schemaVersion",
      "kind",
      "mutationId",
      "locator",
      "sourceRootBinding",
      "trashRootBinding",
      "transfer",
      "sourceDisposition",
      "content",
      "stagedAt",
      "digest"
    ], "trash receipt");
    if (record.schemaVersion !== TRASH_RECEIPT_SCHEMA_VERSION) {
      throw receiptCorrupt(
        `trash receipt schema 不受支持：${String(record.schemaVersion)}`
      );
    }
    if (record.kind !== "record-mutation-trash-receipt") {
      throw receiptCorrupt("trash receipt kind 非法");
    }
    const mutationId = requireSafeToken(
      record.mutationId,
      SAFE_MUTATION_ID,
      "receipt.mutationId"
    );
    const locator = parseLocator(record.locator);
    const sourceRootBinding = parseTrashRootBinding(
      record.sourceRootBinding,
      "receipt.sourceRootBinding"
    );
    const trashRootBinding = parseTrashRootBinding(
      record.trashRootBinding,
      "receipt.trashRootBinding"
    );
    assertDistinctTrashRootBindings(sourceRootBinding, trashRootBinding);
    assertLocatorMatchesRootBindings(
      locator,
      sourceRootBinding,
      trashRootBinding
    );
    if (record.transfer !== "copy" && record.transfer !== "move") {
      throw receiptCorrupt("receipt.transfer 非法");
    }
    if (
      record.sourceDisposition !== "retained"
    ) {
      throw receiptCorrupt("receipt.sourceDisposition 非法");
    }
    // A prepared receipt never claims that the source has moved. Retirement is
    // represented by a separate durable finalization receipt.
    if (
      stableRecordMutationStringify(locator)
      !== stableRecordMutationStringify(
        {
          sourceRootId: locator.sourceRootId,
          sourceRelativePath: locator.sourceRelativePath,
          trashRootId: locator.trashRootId,
          ...trashPathsFor(
            mutationId,
            locator.sourceRootId,
            locator.sourceRelativePath
          )
        } satisfies RecordMutationTrashLocator
      )
    ) {
      throw receiptCorrupt("trash locator token/path 不匹配");
    }
    const content = parseContentReceipt(record.content);
    const stagedAt = requireSafeInteger(record.stagedAt, "receipt.stagedAt", 0);
    const digest = requireDigest(record.digest, "receipt.digest");
    const parsed: RecordMutationTrashReceipt = {
      schemaVersion: TRASH_RECEIPT_SCHEMA_VERSION,
      kind: "record-mutation-trash-receipt",
      mutationId,
      locator,
      sourceRootBinding,
      trashRootBinding,
      transfer: record.transfer,
      sourceDisposition: record.sourceDisposition,
      content,
      stagedAt,
      digest
    };
    const { digest: _digest, ...withoutDigest } = parsed;
    if (digest !== recordMutationDigest(withoutDigest)) {
      throw receiptCorrupt("trash receipt digest 不匹配");
    }
    return parsed;
  } catch (error) {
    throw mapTrashError(error, "receipt_corrupt");
  }
}

export async function finalizeRecordMutationTrash(
  input: RecordMutationTrashRoots & {
    receipt: RecordMutationTrashReceipt;
    finalizedAt?: number;
  }
): Promise<RecordMutationTrashFinalizationReceipt> {
  return await withRecordMutationTrashLane(
    async () => await finalizeRecordMutationTrashUnlocked(input)
  );
}

async function finalizeRecordMutationTrashUnlocked(
  input: RecordMutationTrashRoots & {
    receipt: RecordMutationTrashReceipt;
    finalizedAt?: number;
  }
): Promise<RecordMutationTrashFinalizationReceipt> {
  try {
    const receipt = parseRecordMutationTrashReceipt(input.receipt);
    if (receipt.transfer !== "move") {
      throw new RecordMutationTrashError(
        "retirement_conflict",
        "copy-only prepared receipt 不允许退休 source"
      );
    }
    assertRootsMatch(receipt, input);
    const durableReceipt = await requirePersistedPreparedReceipt(
      input.trashRootPath,
      receipt
    );
    const trash = await captureRelativeEntry(
      input.trashRootPath,
      durableReceipt.locator.trashRelativePath
    );
    if (!trash || !matchesCapturedContent(trash, durableReceipt.content)) {
      throw new RecordMutationTrashError(
        "trash_conflict",
        "finalize 前 prepared trash 不完整"
      );
    }

    const existingFinalization = await readPersistedFinalizationReceipt(
      input.trashRootPath,
      durableReceipt.locator.finalizationRelativePath
    );
    if (existingFinalization) {
      assertFinalizationMatchesPrepared(existingFinalization, durableReceipt);
    }

    const source = await captureRelativeEntry(
      input.sourceRootPath,
      durableReceipt.locator.sourceRelativePath
    );
    const retired = await captureRelativeEntry(
      input.trashRootPath,
      durableReceipt.locator.retirementRelativePath
    );
    if (source && !matchesCapturedContent(source, durableReceipt.content)) {
      throw new RecordMutationTrashError(
        "retirement_conflict",
        "finalize source 与 prepared receipt 不匹配"
      );
    }
    if (retired && !matchesCapturedContent(retired, durableReceipt.content)) {
      throw new RecordMutationTrashError(
        "retirement_conflict",
        "retirement evidence 与 prepared receipt 不匹配"
      );
    }
    if (source && retired) {
      throw new RecordMutationTrashError(
        "retirement_conflict",
        "source 与 retirement evidence 同时存在"
      );
    }
    if (!source && !retired) {
      throw new RecordMutationTrashError(
        "retirement_conflict",
        "source 与 retirement evidence 同时缺失"
      );
    }

    if (source) {
      const sourceRootPath = await resolveDurablePlainRoot(
        input.sourceRootPath,
        "trash source root"
      );
      const sourceAbsolutePath = path.join(
        sourceRootPath,
        ...durableReceipt.locator.sourceRelativePath.split("/")
      );
      const retirementTarget = await ensureDurableRelativeParent(
        input.trashRootPath,
        durableReceipt.locator.retirementRelativePath
      );
      if (await durableEntryExists(retirementTarget.absolutePath)) {
        throw new RecordMutationTrashError(
          "retirement_conflict",
          "retirement target 已存在"
        );
      }
      try {
        await fsp.rename(sourceAbsolutePath, retirementTarget.absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "EXDEV") {
          throw new RecordMutationTrashError(
            "retirement_conflict",
            "source 与 retirement root 不在同一文件系统；拒绝永久删除"
          );
        }
        throw error;
      }
      await syncDurableDirectory(path.dirname(sourceAbsolutePath));
      if (retirementTarget.parentPath !== path.dirname(sourceAbsolutePath)) {
        await syncDurableDirectory(retirementTarget.parentPath);
      }
    }

    const sourceReadback = await captureRelativeEntry(
      input.sourceRootPath,
      durableReceipt.locator.sourceRelativePath
    );
    const retiredReadback = await captureRelativeEntry(
      input.trashRootPath,
      durableReceipt.locator.retirementRelativePath
    );
    if (
      sourceReadback
      || !retiredReadback
      || !matchesCapturedContent(retiredReadback, durableReceipt.content)
    ) {
      throw new RecordMutationTrashError(
        "retirement_conflict",
        "finalize readback 不匹配"
      );
    }

    const finalizedAt = requireSafeInteger(
      input.finalizedAt ?? Date.now(),
      "finalizedAt",
      0
    );
    const withoutDigest: Omit<
      RecordMutationTrashFinalizationReceipt,
      "digest"
    > = {
      schemaVersion: 1,
      kind: "record-mutation-trash-finalization",
      mutationId: durableReceipt.mutationId,
      preparedReceiptDigest: durableReceipt.digest,
      locator: durableReceipt.locator,
      sourceRootBinding: durableReceipt.sourceRootBinding,
      trashRootBinding: durableReceipt.trashRootBinding,
      sourceDisposition: "retired",
      finalizedAt
    };
    const finalization = parseRecordMutationTrashFinalizationReceipt({
      ...withoutDigest,
      digest: recordMutationDigest(withoutDigest)
    });
    if (existingFinalization) return existingFinalization;
    return await persistFinalizationReceipt(input.trashRootPath, finalization);
  } catch (error) {
    throw mapTrashError(error);
  }
}

export function parseRecordMutationTrashFinalizationReceipt(
  value: unknown
): RecordMutationTrashFinalizationReceipt {
  try {
    const record = requirePlainRecord(value, "trash finalization receipt");
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECEIPT_BYTES) {
      throw receiptCorrupt("trash finalization receipt 超过大小上限");
    }
    assertExactKeys(record, [
      "schemaVersion",
      "kind",
      "mutationId",
      "preparedReceiptDigest",
      "locator",
      "sourceRootBinding",
      "trashRootBinding",
      "sourceDisposition",
      "finalizedAt",
      "digest"
    ], "trash finalization receipt");
    if (record.schemaVersion !== 1) {
      throw receiptCorrupt("trash finalization receipt schema 非法");
    }
    if (record.kind !== "record-mutation-trash-finalization") {
      throw receiptCorrupt("trash finalization receipt kind 非法");
    }
    if (record.sourceDisposition !== "retired") {
      throw receiptCorrupt("trash finalization sourceDisposition 非法");
    }
    const locator = parseLocator(record.locator);
    const sourceRootBinding = parseTrashRootBinding(
      record.sourceRootBinding,
      "finalization.sourceRootBinding"
    );
    const trashRootBinding = parseTrashRootBinding(
      record.trashRootBinding,
      "finalization.trashRootBinding"
    );
    assertDistinctTrashRootBindings(sourceRootBinding, trashRootBinding);
    assertLocatorMatchesRootBindings(
      locator,
      sourceRootBinding,
      trashRootBinding
    );
    const parsed: RecordMutationTrashFinalizationReceipt = {
      schemaVersion: 1,
      kind: "record-mutation-trash-finalization",
      mutationId: requireSafeToken(
        record.mutationId,
        SAFE_MUTATION_ID,
        "finalization.mutationId"
      ),
      preparedReceiptDigest: requireDigest(
        record.preparedReceiptDigest,
        "finalization.preparedReceiptDigest"
      ),
      locator,
      sourceRootBinding,
      trashRootBinding,
      sourceDisposition: "retired",
      finalizedAt: requireSafeInteger(
        record.finalizedAt,
        "finalization.finalizedAt",
        0
      ),
      digest: requireDigest(record.digest, "finalization.digest")
    };
    const { digest: _digest, ...withoutDigest } = parsed;
    if (parsed.digest !== recordMutationDigest(withoutDigest)) {
      throw receiptCorrupt("trash finalization receipt digest 不匹配");
    }
    return parsed;
  } catch (error) {
    throw mapTrashError(error, "receipt_corrupt");
  }
}

export async function judgeRecordMutationTrashRestore(
  input: RecordMutationTrashRoots & { receipt: RecordMutationTrashReceipt }
): Promise<RecordMutationTrashRestoreJudgment> {
  try {
    const receipt = parseRecordMutationTrashReceipt(input.receipt);
    assertRootsMatch(receipt, input);
    const durableReceipt = await requirePersistedPreparedReceipt(
      input.trashRootPath,
      receipt
    );
    const source = await captureRelativeEntry(
      input.sourceRootPath,
      durableReceipt.locator.sourceRelativePath
    );
    const trash = await captureRelativeEntry(
      input.trashRootPath,
      durableReceipt.locator.trashRelativePath
    );
    if (!trash) return { status: "blocked", reason: "trash-missing" };
    if (!matchesCapturedContent(trash, durableReceipt.content)) {
      return { status: "blocked", reason: "trash-conflict" };
    }
    if (!source) {
      return {
        status: "restore-required",
        reason: "source-missing-trash-exact"
      };
    }
    if (
      source.kind === "file"
      && trash.kind === "file"
      && sameDurableIdentity(source.identity, trash.identity)
    ) {
      return {
        status: "blocked",
        reason: "source-and-trash-share-inode"
      };
    }
    if (matchesCapturedContent(source, durableReceipt.content)) {
      return {
        status: "already-restored",
        reason: "source-and-trash-exact"
      };
    }
    if (isCapturedSubset(source, trash)) {
      return {
        status: "restore-required",
        reason: "source-partial-trash-exact"
      };
    }
    if (!matchesCapturedContent(source, durableReceipt.content)) {
      return { status: "blocked", reason: "source-conflict" };
    }
    return {
      status: "already-restored",
      reason: "source-and-trash-exact"
    };
  } catch (error) {
    throw mapTrashError(error);
  }
}

export async function restoreRecordMutationTrash(
  input: RecordMutationTrashRoots & { receipt: RecordMutationTrashReceipt }
): Promise<RecordMutationTrashRestoreJudgment> {
  return await withRecordMutationTrashLane(
    async () => await restoreRecordMutationTrashUnlocked(input)
  );
}

async function restoreRecordMutationTrashUnlocked(
  input: RecordMutationTrashRoots & { receipt: RecordMutationTrashReceipt }
): Promise<RecordMutationTrashRestoreJudgment> {
  try {
    const receipt = parseRecordMutationTrashReceipt(input.receipt);
    const judgment = await judgeRecordMutationTrashRestore({
      ...input,
      receipt
    });
    if (judgment.status === "blocked") {
      throw new RecordMutationTrashError(
        "restore_conflict",
        `trash restore 被阻断：${judgment.reason}`
      );
    }
    if (judgment.status === "already-restored") return judgment;
    const trash = await captureRelativeEntry(
      input.trashRootPath,
      receipt.locator.trashRelativePath
    );
    if (!trash || !matchesCapturedContent(trash, receipt.content)) {
      throw new RecordMutationTrashError(
        "restore_conflict",
        "trash restore readback 不匹配"
      );
    }
    const target = await ensureDurableRelativeParent(
      input.sourceRootPath,
      receipt.locator.sourceRelativePath
    );
    await copyCapturedEntry(trash, target.absolutePath, target.parentPath);
    const readback = await captureRelativeEntry(
      input.sourceRootPath,
      receipt.locator.sourceRelativePath
    );
    if (!readback || !matchesCapturedContent(readback, receipt.content)) {
      throw new RecordMutationTrashError(
        "restore_conflict",
        "trash restore source readback 不匹配"
      );
    }
    return {
      status: "already-restored",
      reason: "source-and-trash-exact"
    };
  } catch (error) {
    throw mapTrashError(error);
  }
}

interface CapturedEntryIdentity {
  dev: number;
  ino: number;
}

interface CapturedFileEntry {
  kind: "file";
  mode: number;
  identity: CapturedEntryIdentity;
  content: Buffer;
  sha256: string;
}

interface CapturedDirectoryEntry {
  kind: "directory";
  mode: number;
  identity: CapturedEntryIdentity;
  children: Array<{ name: string; entry: CapturedEntry }>;
}

type CapturedEntry = CapturedFileEntry | CapturedDirectoryEntry;

type CapturedManifestEntry =
  | {
      relativePath: string;
      kind: "file";
      mode: number;
      size: number;
      sha256: string;
    }
  | {
      relativePath: string;
      kind: "directory";
      mode: number;
    };

async function captureRelativeEntry(
  rootPathInput: string,
  relativePathInput: string
): Promise<CapturedEntry | null> {
  const resolved = await resolveSafeRelativeEntry(
    rootPathInput,
    relativePathInput
  );
  if (!resolved) return null;
  return await captureAbsoluteEntry(resolved.absolutePath, {
    entries: 0,
    bytes: 0
  }, 0);
}

async function resolveSafeRelativeEntry(
  rootPathInput: string,
  relativePathInput: string
): Promise<{ rootPath: string; absolutePath: string } | null> {
  const rootPath = await resolveDurablePlainRoot(
    rootPathInput,
    "trash entry root"
  );
  const relativePath = validateDurableRelativePath(relativePathInput);
  const segments = relativePath.split("/");
  let currentPath = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    const stat = await lstatOrNull(currentPath);
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
      throw new RecordMutationTrashError(
        "unsafe_entry",
        `trash entry 经过 symlink：${relativePath}`
      );
    }
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) {
        throw new RecordMutationTrashError(
          "unsafe_entry",
          `trash entry parent 不是目录：${relativePath}`
        );
      }
      const real = path.resolve(await fsp.realpath(currentPath));
      if (real !== currentPath) {
        throw new RecordMutationTrashError(
          "unsafe_entry",
          `trash entry parent canonical path 不匹配：${relativePath}`
        );
      }
    }
  }
  const relative = path.relative(rootPath, currentPath);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new RecordMutationTrashError("invalid_path", "trash entry 越界");
  }
  return { rootPath, absolutePath: currentPath };
}

async function captureAbsoluteEntry(
  absolutePath: string,
  limits: { entries: number; bytes: number },
  depth: number
): Promise<CapturedEntry> {
  if (depth > MAX_TRASH_TREE_DEPTH) {
    throw new RecordMutationTrashError(
      "unsafe_entry",
      "trash directory tree 超过深度上限"
    );
  }
  const before = await fsp.lstat(absolutePath);
  if (before.isSymbolicLink()) {
    throw new RecordMutationTrashError(
      "unsafe_entry",
      `trash directory tree 含 symlink：${absolutePath}`
    );
  }
  limits.entries += 1;
  if (limits.entries > MAX_TRASH_TREE_ENTRIES) {
    throw new RecordMutationTrashError(
      "unsafe_entry",
      "trash directory tree 超过条目上限"
    );
  }
  if (before.isFile()) {
    const read = await readDurableRegularFile(
      absolutePath,
      MAX_TRASH_FILE_BYTES
    );
    if (!sameDurableIdentity(before, read.snapshot)) {
      throw new RecordMutationTrashError(
        "unsafe_entry",
        `trash file identity 在读取期间变化：${absolutePath}`
      );
    }
    limits.bytes += read.content.byteLength;
    if (limits.bytes > MAX_TRASH_FILE_BYTES) {
      throw new RecordMutationTrashError(
        "unsafe_entry",
        "trash directory tree 超过内容上限"
      );
    }
    return {
      kind: "file",
      mode: read.snapshot.mode,
      identity: {
        dev: read.snapshot.dev,
        ino: read.snapshot.ino
      },
      content: read.content,
      sha256: `sha256:${createHash("sha256")
        .update(read.content)
        .digest("hex")}`
    };
  }
  if (!before.isDirectory()) {
    throw new RecordMutationTrashError(
      "unsafe_entry",
      `trash directory tree 含特殊文件：${absolutePath}`
    );
  }

  const names = (await fsp.readdir(absolutePath)).sort(compareText);
  const children: CapturedDirectoryEntry["children"] = [];
  for (const name of names) {
    validateDurableRelativePath(name);
    children.push({
      name,
      entry: await captureAbsoluteEntry(
        path.join(absolutePath, name),
        limits,
        depth + 1
      )
    });
  }
  const afterNames = (await fsp.readdir(absolutePath)).sort(compareText);
  const after = await fsp.lstat(absolutePath);
  if (
    !sameDurableIdentity(before, after)
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || stableRecordMutationStringify(names)
      !== stableRecordMutationStringify(afterNames)
  ) {
    throw new RecordMutationTrashError(
      "unsafe_entry",
      `trash directory tree 在读取期间变化：${absolutePath}`
    );
  }
  return {
    kind: "directory",
    mode: before.mode & 0o777,
    identity: {
      dev: Number(before.dev),
      ino: Number(before.ino)
    },
    children
  };
}

async function copyCapturedEntry(
  source: CapturedEntry,
  targetPath: string,
  targetParentPath: string
): Promise<void> {
  const existing = await captureAbsoluteEntryOrNull(targetPath);
  if (existing && !isCapturedSubset(existing, source)) {
    throw new RecordMutationTrashError(
      "trash_conflict",
      `copy target 含冲突内容：${targetPath}`
    );
  }
  if (source.kind === "file") {
    if (!existing) {
      await writeDurableNewFile(
        targetPath,
        source.content,
        MAX_TRASH_FILE_BYTES,
        source.mode
      );
      await syncDurableDirectory(targetParentPath);
    }
  } else {
    if (!existing) {
      try {
        await fsp.mkdir(targetPath, { mode: source.mode });
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
      const created = await fsp.lstat(targetPath);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new RecordMutationTrashError(
          "trash_conflict",
          `copy target 不是安全目录：${targetPath}`
        );
      }
      await fsp.chmod(targetPath, source.mode);
      await syncDurableDirectory(targetParentPath);
    }
    for (const child of source.children) {
      await copyCapturedEntry(
        child.entry,
        path.join(targetPath, child.name),
        targetPath
      );
    }
    await fsp.chmod(targetPath, source.mode);
    await syncDurableDirectory(targetPath);
  }
  const readback = await captureAbsoluteEntryOrNull(targetPath);
  if (!readback || !matchesCapturedContent(
    readback,
    capturedContentReceipt(source)
  )) {
    throw new RecordMutationTrashError(
      "trash_conflict",
      `copy target readback 不匹配：${targetPath}`
    );
  }
}

async function captureAbsoluteEntryOrNull(
  absolutePath: string
): Promise<CapturedEntry | null> {
  if (!await durableEntryExists(absolutePath)) return null;
  return await captureAbsoluteEntry(absolutePath, { entries: 0, bytes: 0 }, 0);
}

function capturedContentReceipt(
  source: CapturedEntry
): RecordMutationTrashContentReceipt {
  const entries = capturedManifest(source);
  const size = entries.reduce(
    (total, entry) => total + (entry.kind === "file" ? entry.size : 0),
    0
  );
  const sha256 = source.kind === "file"
    ? source.sha256
    : recordMutationDigest({
        entryKind: "directory",
        entries
      });
  return {
    entryKind: source.kind,
    sha256,
    size,
    mode: source.mode,
    entryCount: entries.length
  };
}

function capturedManifest(source: CapturedEntry): CapturedManifestEntry[] {
  const result: CapturedManifestEntry[] = [];
  appendCapturedManifest(source, "", result);
  return result;
}

function appendCapturedManifest(
  source: CapturedEntry,
  relativePath: string,
  result: CapturedManifestEntry[]
): void {
  if (source.kind === "file") {
    result.push({
      relativePath,
      kind: "file",
      mode: source.mode,
      size: source.content.byteLength,
      sha256: source.sha256
    });
    return;
  }
  result.push({
    relativePath,
    kind: "directory",
    mode: source.mode
  });
  for (const child of source.children) {
    appendCapturedManifest(
      child.entry,
      relativePath ? `${relativePath}/${child.name}` : child.name,
      result
    );
  }
}

function capturedIdentityManifest(source: CapturedEntry): unknown[] {
  const result: unknown[] = [];
  appendCapturedIdentityManifest(source, "", result);
  return result;
}

function appendCapturedIdentityManifest(
  source: CapturedEntry,
  relativePath: string,
  result: unknown[]
): void {
  result.push({
    relativePath,
    kind: source.kind,
    mode: source.mode,
    dev: source.identity.dev,
    ino: source.identity.ino,
    ...(source.kind === "file"
      ? {
          size: source.content.byteLength,
          sha256: source.sha256
        }
      : {})
  });
  if (source.kind === "directory") {
    for (const child of source.children) {
      appendCapturedIdentityManifest(
        child.entry,
        relativePath ? `${relativePath}/${child.name}` : child.name,
        result
      );
    }
  }
}

function capturedEntriesEqual(
  left: CapturedEntry,
  right: CapturedEntry
): boolean {
  return stableRecordMutationStringify(capturedIdentityManifest(left))
    === stableRecordMutationStringify(capturedIdentityManifest(right));
}

function matchesCapturedContent(
  source: CapturedEntry,
  expected: RecordMutationTrashContentReceipt
): boolean {
  return stableRecordMutationStringify(capturedContentReceipt(source))
    === stableRecordMutationStringify(expected);
}

function isCapturedSubset(
  candidate: CapturedEntry,
  expected: CapturedEntry
): boolean {
  if (candidate.kind !== expected.kind) return false;
  const candidateEntries = capturedManifest(candidate);
  const expectedEntries = new Map(
    capturedManifest(expected).map((entry) => [entry.relativePath, entry])
  );
  return candidateEntries.every((entry) => {
    const expectedEntry = expectedEntries.get(entry.relativePath);
    return expectedEntry !== undefined
      && stableRecordMutationStringify(entry)
        === stableRecordMutationStringify(expectedEntry);
  });
}

function parseLocator(value: unknown): RecordMutationTrashLocator {
  const record = requirePlainRecord(value, "trash locator");
  assertExactKeys(record, [
    "sourceRootId",
    "sourceRelativePath",
    "trashRootId",
    "trashRelativePath",
    "receiptRelativePath",
    "retirementRelativePath",
    "finalizationRelativePath"
  ], "trash locator");
  return {
    sourceRootId: requireSafeToken(
      record.sourceRootId,
      SAFE_ROOT_ID,
      "locator.sourceRootId"
    ),
    sourceRelativePath: validateDurableRelativePath(
      requireString(record.sourceRelativePath, "locator.sourceRelativePath")
    ),
    trashRootId: requireSafeToken(
      record.trashRootId,
      SAFE_ROOT_ID,
      "locator.trashRootId"
    ),
    trashRelativePath: validateDurableRelativePath(
      requireString(record.trashRelativePath, "locator.trashRelativePath")
    ),
    receiptRelativePath: validateDurableRelativePath(
      requireString(
        record.receiptRelativePath,
        "locator.receiptRelativePath"
      )
    ),
    retirementRelativePath: validateDurableRelativePath(
      requireString(
        record.retirementRelativePath,
        "locator.retirementRelativePath"
      )
    ),
    finalizationRelativePath: validateDurableRelativePath(
      requireString(
        record.finalizationRelativePath,
        "locator.finalizationRelativePath"
      )
    )
  };
}

function parseContentReceipt(value: unknown): RecordMutationTrashContentReceipt {
  const record = requirePlainRecord(value, "trash content receipt");
  assertExactKeys(record, [
    "entryKind",
    "sha256",
    "size",
    "mode",
    "entryCount"
  ], "trash content receipt");
  if (record.entryKind !== "file" && record.entryKind !== "directory") {
    throw receiptCorrupt("content.entryKind 非法");
  }
  const size = requireSafeInteger(
    record.size,
    "content.size",
    0,
    MAX_TRASH_FILE_BYTES
  );
  const mode = requireSafeInteger(record.mode, "content.mode", 0, 0o777);
  const entryCount = requireSafeInteger(
    record.entryCount,
    "content.entryCount",
    1,
    MAX_TRASH_TREE_ENTRIES
  );
  if (record.entryKind === "file" && entryCount !== 1) {
    throw receiptCorrupt("file content.entryCount 必须为 1");
  }
  return {
    entryKind: record.entryKind,
    sha256: requireDigest(record.sha256, "content.sha256"),
    size,
    mode,
    entryCount
  };
}

function trashPathsFor(
  mutationId: string,
  sourceRootId: string,
  sourceRelativePath: string
): Pick<
  RecordMutationTrashLocator,
  | "trashRelativePath"
  | "receiptRelativePath"
  | "retirementRelativePath"
  | "finalizationRelativePath"
> {
  const mutationToken = createHash("sha256")
    .update(Buffer.from(mutationId, "utf8"))
    .digest("hex")
    .slice(0, 24);
  const rootToken = createHash("sha256")
    .update(Buffer.from(sourceRootId, "utf8"))
    .digest("hex")
    .slice(0, 16);
  const sourceToken = createHash("sha256")
    .update(Buffer.from(sourceRelativePath, "utf8"))
    .digest("hex");
  const base = `record-mutations/${mutationToken}/${rootToken}`;
  return {
    trashRelativePath: validateDurableRelativePath(
      `${base}/payload/${sourceRelativePath}`
    ),
    receiptRelativePath: validateDurableRelativePath(
      `${base}/receipts/${sourceToken}.json`
    ),
    retirementRelativePath: validateDurableRelativePath(
      `${base}/retired/${sourceRelativePath}`
    ),
    finalizationRelativePath: validateDurableRelativePath(
      `${base}/finalizations/${sourceToken}.json`
    )
  };
}

async function readPersistedPreparedReceipt(
  trashRootPath: string,
  receiptRelativePath: string
): Promise<RecordMutationTrashReceipt | null> {
  const stored = await resolveExistingDurableRelativeFile(
    trashRootPath,
    receiptRelativePath,
    MAX_RECEIPT_BYTES
  );
  if (!stored) return null;
  return parseRecordMutationTrashReceipt(parseJsonBytes(
    stored.content,
    "prepared trash receipt"
  ));
}

async function persistPreparedReceipt(
  trashRootPath: string,
  receipt: RecordMutationTrashReceipt
): Promise<RecordMutationTrashReceipt> {
  const existing = await readPersistedPreparedReceipt(
    trashRootPath,
    receipt.locator.receiptRelativePath
  );
  if (existing) {
    if (existing.digest !== receipt.digest) {
      throw new RecordMutationTrashError(
        "trash_conflict",
        "prepared receipt 已存在但 digest 不匹配"
      );
    }
    return existing;
  }
  const target = await ensureDurableRelativeParent(
    trashRootPath,
    receipt.locator.receiptRelativePath
  );
  const bytes = receiptBytes(receipt);
  try {
    await writeDurableNewFile(
      target.absolutePath,
      bytes,
      MAX_RECEIPT_BYTES,
      0o600
    );
    await syncDurableDirectory(target.parentPath);
  } catch (error) {
    if (
      !(error instanceof DurableAppendOnlyCasError)
      || error.code !== "already_exists"
    ) {
      throw error;
    }
  }
  const readback = await readPersistedPreparedReceipt(
    trashRootPath,
    receipt.locator.receiptRelativePath
  );
  if (!readback || readback.digest !== receipt.digest) {
    throw new RecordMutationTrashError(
      "trash_conflict",
      "prepared receipt durable readback 不匹配"
    );
  }
  return readback;
}

async function requirePersistedPreparedReceipt(
  trashRootPath: string,
  receipt: RecordMutationTrashReceipt
): Promise<RecordMutationTrashReceipt> {
  const durable = await readPersistedPreparedReceipt(
    trashRootPath,
    receipt.locator.receiptRelativePath
  );
  if (
    !durable
    || stableRecordMutationStringify(durable)
      !== stableRecordMutationStringify(receipt)
  ) {
    throw new RecordMutationTrashError(
      "receipt_corrupt",
      "prepared receipt 缺失或与 durable receipt 不匹配"
    );
  }
  return durable;
}

async function readPersistedFinalizationReceipt(
  trashRootPath: string,
  relativePath: string
): Promise<RecordMutationTrashFinalizationReceipt | null> {
  const stored = await resolveExistingDurableRelativeFile(
    trashRootPath,
    relativePath,
    MAX_RECEIPT_BYTES
  );
  if (!stored) return null;
  return parseRecordMutationTrashFinalizationReceipt(parseJsonBytes(
    stored.content,
    "trash finalization receipt"
  ));
}

async function persistFinalizationReceipt(
  trashRootPath: string,
  receipt: RecordMutationTrashFinalizationReceipt
): Promise<RecordMutationTrashFinalizationReceipt> {
  const existing = await readPersistedFinalizationReceipt(
    trashRootPath,
    receipt.locator.finalizationRelativePath
  );
  if (existing) {
    if (
      existing.mutationId !== receipt.mutationId
      || existing.preparedReceiptDigest !== receipt.preparedReceiptDigest
      || stableRecordMutationStringify(existing.locator)
        !== stableRecordMutationStringify(receipt.locator)
    ) {
      throw new RecordMutationTrashError(
        "retirement_conflict",
        "已存在 finalization receipt 与请求不匹配"
      );
    }
    return existing;
  }
  const target = await ensureDurableRelativeParent(
    trashRootPath,
    receipt.locator.finalizationRelativePath
  );
  try {
    await writeDurableNewFile(
      target.absolutePath,
      receiptBytes(receipt),
      MAX_RECEIPT_BYTES,
      0o600
    );
    await syncDurableDirectory(target.parentPath);
  } catch (error) {
    if (
      !(error instanceof DurableAppendOnlyCasError)
      || error.code !== "already_exists"
    ) {
      throw error;
    }
  }
  const readback = await readPersistedFinalizationReceipt(
    trashRootPath,
    receipt.locator.finalizationRelativePath
  );
  if (!readback || readback.digest !== receipt.digest) {
    throw new RecordMutationTrashError(
      "retirement_conflict",
      "finalization receipt durable readback 不匹配"
    );
  }
  return readback;
}

function assertPreparedReceiptMatchesRequest(
  receipt: RecordMutationTrashReceipt,
  expected: {
    mutationId: string;
    locator: RecordMutationTrashLocator;
    sourceRootBinding: RecordRootBindingRef;
    trashRootBinding: RecordRootBindingRef;
    transfer: "copy" | "move";
  }
): void {
  if (
    receipt.mutationId !== expected.mutationId
    || receipt.transfer !== expected.transfer
    || !sameRecordRootBindingRef(
      receipt.sourceRootBinding,
      expected.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      receipt.trashRootBinding,
      expected.trashRootBinding
    )
    || stableRecordMutationStringify(receipt.locator)
      !== stableRecordMutationStringify(expected.locator)
  ) {
    throw new RecordMutationTrashError(
      "trash_conflict",
      "已存在 prepared receipt 与请求不匹配"
    );
  }
}

async function assertPreparedTrashContentExact(
  receipt: RecordMutationTrashReceipt,
  sourceRootPath: string,
  trashRootPath: string,
  allowFinalized: boolean
): Promise<void> {
  const trash = await captureRelativeEntry(
    trashRootPath,
    receipt.locator.trashRelativePath
  );
  if (!trash || !matchesCapturedContent(trash, receipt.content)) {
    throw new RecordMutationTrashError(
      "trash_conflict",
      "prepared trash 与 receipt 不匹配"
    );
  }
  const source = await captureRelativeEntry(
    sourceRootPath,
    receipt.locator.sourceRelativePath
  );
  if (source && matchesCapturedContent(source, receipt.content)) return;
  if (allowFinalized && !source) {
    const retired = await captureRelativeEntry(
      trashRootPath,
      receipt.locator.retirementRelativePath
    );
    if (retired && matchesCapturedContent(retired, receipt.content)) return;
  }
  throw new RecordMutationTrashError(
    "trash_conflict",
    "source/retirement evidence 与 prepared receipt 不匹配"
  );
}

function assertFinalizationMatchesPrepared(
  finalization: RecordMutationTrashFinalizationReceipt,
  prepared: RecordMutationTrashReceipt
): void {
  if (
    finalization.mutationId !== prepared.mutationId
    || finalization.preparedReceiptDigest !== prepared.digest
    || !sameRecordRootBindingRef(
      finalization.sourceRootBinding,
      prepared.sourceRootBinding
    )
    || !sameRecordRootBindingRef(
      finalization.trashRootBinding,
      prepared.trashRootBinding
    )
    || stableRecordMutationStringify(finalization.locator)
      !== stableRecordMutationStringify(prepared.locator)
  ) {
    throw new RecordMutationTrashError(
      "retirement_conflict",
      "finalization receipt 与 prepared receipt 不匹配"
    );
  }
}

function receiptBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw receiptCorrupt("trash receipt 超过大小上限");
  }
  return bytes;
}

function parseJsonBytes(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw receiptCorrupt(`${label} JSON 非法`);
  }
}

function assertRootsMatch(
  receipt: RecordMutationTrashReceipt,
  input: RecordMutationTrashRoots
): void {
  const sourceRootBinding = parseTrashRootBinding(
    input.sourceRootBinding,
    "sourceRootBinding"
  );
  const trashRootBinding = parseTrashRootBinding(
    input.trashRootBinding,
    "trashRootBinding"
  );
  if (
    !sameRecordRootBindingRef(sourceRootBinding, receipt.sourceRootBinding)
    || !sameRecordRootBindingRef(trashRootBinding, receipt.trashRootBinding)
  ) {
    throw new RecordMutationTrashError(
      "root_mismatch",
      "trash receipt root identity 不匹配"
    );
  }
}

function parseTrashRootBinding(
  value: unknown,
  label: string
): RecordRootBindingRef {
  try {
    return parseRecordRootBindingRef(value);
  } catch {
    throw receiptCorrupt(`${label} 非法`);
  }
}

function assertDistinctTrashRootBindings(
  sourceRootBinding: RecordRootBindingRef,
  trashRootBinding: RecordRootBindingRef
): void {
  if (sourceRootBinding.rootId === trashRootBinding.rootId) {
    throw receiptCorrupt("source/trash Root Binding 必须使用不同 rootId");
  }
}

function assertLocatorMatchesRootBindings(
  locator: RecordMutationTrashLocator,
  sourceRootBinding: RecordRootBindingRef,
  trashRootBinding: RecordRootBindingRef
): void {
  if (
    locator.sourceRootId !== sourceRootBinding.rootId
    || locator.trashRootId !== trashRootBinding.rootId
  ) {
    throw receiptCorrupt("trash locator 与 Root Binding 不匹配");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw receiptCorrupt(`${label} 字段集合非法`);
  }
}

function requirePlainRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw receiptCorrupt(`${label} 不是对象`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw receiptCorrupt(`${label} 不是 plain object`);
  }
  return value as Record<string, unknown>;
}

function requireSafeToken(
  value: unknown,
  pattern: RegExp,
  label: string
): string {
  if (
    typeof value !== "string"
    || !pattern.test(value)
    || value !== value.trim()
    || value !== value.normalize("NFC")
  ) {
    throw receiptCorrupt(`${label} 非法`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw receiptCorrupt(`${label} 非法`);
  return value;
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw receiptCorrupt(`${label} 非法`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw receiptCorrupt(`${label} 非法`);
  }
  return value;
}

function mapTrashError(
  error: unknown,
  fallback: RecordMutationTrashErrorCode = "unsafe_entry"
): Error {
  if (error instanceof RecordMutationTrashError) return error;
  if (error instanceof DurableAppendOnlyCasError) {
    const code: RecordMutationTrashErrorCode = (
      error.code === "invalid_path" ? "invalid_path"
        : error.code === "missing" ? "source_missing"
          : error.code === "already_exists" || error.code === "revision_conflict"
            ? "trash_conflict"
            : "unsafe_entry"
    );
    return new RecordMutationTrashError(code, error.message);
  }
  return new RecordMutationTrashError(
    fallback,
    error instanceof Error ? error.message : String(error)
  );
}

function receiptCorrupt(message: string): RecordMutationTrashError {
  return new RecordMutationTrashError("receipt_corrupt", message);
}

async function durableEntryExists(absolutePath: string): Promise<boolean> {
  return (await lstatOrNull(absolutePath)) !== null;
}

async function lstatOrNull(absolutePath: string): Promise<Awaited<
  ReturnType<typeof fsp.lstat>
> | null> {
  return await fsp.lstat(absolutePath).catch((error) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? ""
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Pure Node cannot make ancestor path swaps syscall-safe. Serializing every
 * plugin-owned trash mutation still closes normal in-process races and makes
 * prepare/finalize/restore replay deterministic for cooperative writers.
 */
async function withRecordMutationTrashLane<T>(
  action: () => Promise<T>
): Promise<T> {
  const previous = recordMutationTrashLaneTail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate
  );
  recordMutationTrashLaneTail = tail;
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (recordMutationTrashLaneTail === tail) {
      recordMutationTrashLaneTail = Promise.resolve();
    }
  }
}
