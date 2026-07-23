import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isTrustedExactWriteFenceReceipt } from "../../agent/write-fence";
import type { AgentExactWriteFenceReceipt } from "../../agent/types";
import {
  maintenanceMarkdownUpdatedMayBeInserted,
  maintenanceMarkdownUpdatedSuccessorEvidence,
  type MaintenanceMarkdownUpdatedSuccessorWindow
} from "./markdown-metadata-successor";

const MANIFEST_FILE = "manifest.json";
const CHANGESET_FILE = "changeset.json";
const SHADOW_VAULT_DIRECTORY = "vault";
const SEALED_BLOB_DIRECTORY = "sealed-blobs";
const APPLY_JOURNAL_DIRECTORY = "apply-journal";
const MANIFEST_VERSION = 1;
const CHANGESET_VERSION = 1;
const FILE_READ_CHUNK_SIZE = 1024 * 1024;
const MAX_CONTROL_JSON_BYTES = 64 * 1024 * 1024;
const SHADOW_SOURCE_CHUNK_ROOT = "raw/.echoink-source-chunks";

export const DEFAULT_MAINTENANCE_SHADOW_RAW_PATHS = ["raw"] as const;
export const DEFAULT_MAINTENANCE_SHADOW_RULES_PATHS = ["LLM-WIKI.md"] as const;
export const DEFAULT_MAINTENANCE_SHADOW_COPIED_PATHS = ["wiki", "projects", "outputs", "inbox"] as const;
export const DEFAULT_MAINTENANCE_SHADOW_WRITABLE_PATHS = [
  "wiki",
  "projects",
  "outputs/maintenance",
  "inbox"
] as const;
export const DEFAULT_MAINTENANCE_COMMIT_PATHS = ["wiki", "projects", "outputs", "inbox"] as const;
export const MAINTENANCE_PLUGIN_OWNED_PATHS = ["outputs/.ingest-tracker.md", "raw"] as const;
const MAINTENANCE_COMMIT_DIRECTORY_ROOTS = ["wiki", "projects", "outputs", "inbox"] as const;
const DEFAULT_MAX_CHANGED_FILE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_CHANGED_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CHANGED_FILES = 10_000;
const METADATA_SUCCESSOR_WINDOW_MS = 5 * 60_000;

export type MaintenanceShadowState = "active" | "sealed" | "abandoned" | "committed" | "discarded" | "noop";
export type MaintenanceShadowTerminalOutcome = Extract<MaintenanceShadowState, "committed" | "discarded" | "noop">;

export type MaintenanceShadowErrorCode =
  | "invalid_path"
  | "unsafe_entry"
  | "required_path_missing"
  | "source_changed"
  | "raw_modified"
  | "readonly_modified"
  | "write_outside_allowed_paths"
  | "unsafe_kind_change"
  | "invalid_state"
  | "manifest_corrupt"
  | "changeset_corrupt"
  | "cas_conflict"
  | "commit_path_denied"
  | "commit_locked";

export class MaintenanceShadowError extends Error {
  constructor(
    public readonly code: MaintenanceShadowErrorCode,
    message: string,
    public readonly relativePath?: string
  ) {
    super(message);
    this.name = "MaintenanceShadowError";
  }
}

/**
 * Test-only abrupt-stop sentinel. Throwing this from a fault injector leaves
 * the durable apply journal untouched, matching a process that exited between
 * two transaction phases.
 */
export class MaintenanceShadowSimulatedCrash extends Error {
  constructor(message = "simulated Shadow apply crash") {
    super(message);
    this.name = "MaintenanceShadowSimulatedCrash";
  }
}

async function acquireMaintenanceApplyLock(
  lockPath: string,
  payload: MaintenanceApplyLock
): Promise<fsp.FileHandle> {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.sync();
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (handle) await fsp.rm(lockPath, { force: true }).catch(() => undefined);
        throw error;
      }
      const existing = await readApplyLock(lockPath);
      if (isProcessAlive(existing.pid)) {
        throw new MaintenanceShadowError("commit_locked", "另一个维护提交正在写入此 Vault");
      }
      const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fsp.rename(lockPath, quarantinePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      await fsp.rm(quarantinePath, { force: true });
    }
  }
  throw new MaintenanceShadowError("commit_locked", "无法取得维护提交锁");
}

async function readApplyLock(lockPath: string): Promise<MaintenanceApplyLock> {
  try {
    const parsed = JSON.parse(
      (await readIndependentRegularFile(lockPath, "维护提交锁", MAX_CONTROL_JSON_BYTES)).toString("utf8")
    ) as MaintenanceApplyLock;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || typeof parsed.journalPath !== "string"
      || typeof parsed.attemptId !== "string"
    ) {
      throw new Error("invalid lock");
    }
    return parsed;
  } catch (error) {
    throw new MaintenanceShadowError(
      "commit_locked",
      `维护提交锁损坏，需人工检查：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function recoverPendingApplyJournals(
  liveVaultPath: string,
  storageRootPath: string,
  liveVaultFingerprint: string,
  options: { deferJournalPath?: string } = {}
): Promise<void> {
  const entries = await fsp.readdir(storageRootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("echoink-maintenance-")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new MaintenanceShadowError("unsafe_entry", `Shadow storage 含不安全 attempt：${entry.name}`);
    }
    const journalRootPath = path.join(storageRootPath, entry.name, APPLY_JOURNAL_DIRECTORY);
    const journalPath = path.join(journalRootPath, "journal.json");
    const journal = await readApplyJournalOrNull(journalPath);
    if (!journal || journal.liveVaultFingerprint !== liveVaultFingerprint) continue;
    // A global/orphan scan may only finish an already-authorized apply or roll
    // it back. Rolling a blocked transaction forward needs the caller's exact
    // attempt/change-set authority, which is handled below by applyShadowChangeSet.
    if (
      options.deferJournalPath
      && path.resolve(journalPath) === path.resolve(options.deferJournalPath)
    ) continue;
    const recovered = await recoverApplyJournal(
      liveVaultPath,
      journalRootPath,
      journal
    );
    if (recovered.state === "blocked") {
      throw new MaintenanceShadowError(
        "cas_conflict",
        recovered.error ?? `历史 attempt ${journal.attemptId} 的提交无法自动恢复`
      );
    }
  }
}

async function prepareApplyJournal(
  liveVaultPath: string,
  shadowVaultPath: string,
  sealedBlobRootPath: string,
  journalRootPath: string,
  changeSet: MaintenanceShadowChangeSet,
  selected: readonly MaintenanceShadowChange[],
  selectionDigest: string
): Promise<MaintenanceApplyJournal> {
  await fsp.mkdir(path.join(journalRootPath, "baseline"), { recursive: true, mode: 0o700 });
  const entries: MaintenanceApplyJournalEntry[] = [];
  try {
    for (const [index, change] of selected.entries()) {
      await assertExpectedParentChainUnchanged(
        liveVaultPath,
        change,
        "Shadow prepare"
      );
      await assertExpectedMissingParentState(
        liveVaultPath,
        change,
        [],
        "Shadow prepare"
      );
      await assertLiveCas(
        liveVaultPath,
        change.relativePath,
        change.expectedLive,
        change.expectedLiveIdentity
      );
      if (change.operation === "upsert") {
        const blobPath = resolveVaultRelativePath(sealedBlobRootPath, change.blobRelativePath);
        const blob = await inspectRegularFile(blobPath);
        if (blob.sha256 !== change.shadowSha256 || blob.size !== change.size) {
          throw new MaintenanceShadowError(
            "source_changed",
            `sealed blob 校验失败：${change.relativePath}`,
            change.relativePath
          );
        }
      } else if (await lstatOrNull(resolveVaultRelativePath(shadowVaultPath, change.relativePath))) {
        throw new MaintenanceShadowError(
          "source_changed",
          `seal 后被删除的 Shadow 文件重新出现：${change.relativePath}`,
          change.relativePath
        );
      }

      const targetDirectory = path.posix.dirname(change.relativePath);
      const transactionToken = createHash("sha256")
        .update(`${changeSet.attemptId}\0${change.relativePath}\0${index}`)
        .digest("hex")
        .slice(0, 24);
      const installTempRelativePath = normalizeVaultRelativePath(
        `${targetDirectory === "." ? "" : `${targetDirectory}/`}.echoink-txn-${transactionToken}.tmp`
      );
      if (await inspectRootRelativeFile(liveVaultPath, installTempRelativePath)) {
        throw new MaintenanceShadowError(
          "cas_conflict",
          `维护事务临时路径已存在：${installTempRelativePath}`,
          installTempRelativePath
        );
      }

      let baselineBlobRelativePath: string | undefined;
      let displacedLiveRelativePath: string | undefined;
      if (change.expectedLive.kind === "file") {
        baselineBlobRelativePath = `baseline/${String(index).padStart(6, "0")}.blob`;
        const livePath = resolveVaultRelativePath(liveVaultPath, change.relativePath);
        const baselineBlobPath = resolveVaultRelativePath(journalRootPath, baselineBlobRelativePath);
        await copyFileWithExpectedContent(
          livePath,
          baselineBlobPath,
          change.expectedLive.sha256,
          change.expectedLive.size
        );
        await assertExpectedParentChainUnchanged(
          liveVaultPath,
          change,
          "Shadow baseline capture"
        );
        displacedLiveRelativePath = normalizeVaultRelativePath(
          `${targetDirectory === "." ? "" : `${targetDirectory}/`}.echoink-txn-${transactionToken}.bak`
        );
        if (await inspectRootRelativeFile(liveVaultPath, displacedLiveRelativePath)) {
          throw new MaintenanceShadowError(
            "cas_conflict",
            `维护事务保留路径已存在：${displacedLiveRelativePath}`,
            displacedLiveRelativePath
          );
        }
      }
      entries.push({
        change,
        baselineBlobRelativePath,
        displacedLiveRelativePath,
        installTempRelativePath
      });
    }

    const now = new Date().toISOString();
    const journal = withApplyJournalDigest({
      version: 1,
      state: "prepared",
      attemptId: changeSet.attemptId,
      liveVaultFingerprint: changeSet.liveVaultFingerprint,
      changeSetDigest: changeSet.digest,
      selectionDigest,
      selectedPaths: selected.map((change) => change.relativePath),
      entries,
      createdDirectories: [],
      metadataSuccessorPolicy: metadataSuccessorPolicyFor(
        changeSet.createdAt,
        now
      ),
      createdAt: now,
      updatedAt: now
    });
    await writeJsonAtomic(path.join(journalRootPath, "journal.json"), journal);
    return journal;
  } catch (error) {
    await makeTreeOwnerWritable(journalRootPath);
    await fsp.rm(journalRootPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function applyJournalEntry(
  liveVaultPath: string,
  sealedBlobRootPath: string,
  entry: MaintenanceApplyJournalEntry,
  afterInstallLink?: () => void | Promise<void>
): Promise<void> {
  const { change } = entry;
  await assertExpectedParentChainUnchanged(
    liveVaultPath,
    change,
    "Shadow apply"
  );
  const relativeDirectory = path.posix.dirname(change.relativePath);
  const parentChain = await requireSafeDirectoryChain(
    liveVaultPath,
    relativeDirectory,
    "Shadow apply"
  );

  if (change.expectedLive.kind === "file") {
    const displacedRelativePath = entry.displacedLiveRelativePath;
    if (!displacedRelativePath) {
      throw new MaintenanceShadowError("changeset_corrupt", `缺少 displaced 路径：${change.relativePath}`);
    }
    const displaced = await inspectRootRelativeFile(
      liveVaultPath,
      displacedRelativePath
    );
    if (!displaced) {
      await assertLiveCas(
        liveVaultPath,
        change.relativePath,
        change.expectedLive,
        change.expectedLiveIdentity
      );
      await displaceLiveFileNoClobber(
        liveVaultPath,
        change.relativePath,
        displacedRelativePath,
        parentChain,
        change.expectedLive,
        change.expectedLiveIdentity
      );
    }
    try {
      const displacedAfter = await assertRootRelativeFileMatchesCas(
        liveVaultPath,
        displacedRelativePath,
        change.expectedLive,
        [1]
      );
      if (
        !change.expectedLiveIdentity
        || displacedAfter.dev !== change.expectedLiveIdentity.dev
        || displacedAfter.ino !== change.expectedLiveIdentity.ino
      ) {
        throw new MaintenanceShadowError(
          "cas_conflict",
          `displaced inode 与 live baseline 不一致：${change.relativePath}`,
          change.relativePath
        );
      }
    } catch (error) {
      const [targetAfterFailure, displacedAfterFailure] = await Promise.all([
        currentCas(liveVaultPath, change.relativePath),
        inspectRootRelativeFile(liveVaultPath, displacedRelativePath)
      ]);
      if (
        targetAfterFailure.kind === "missing"
        && displacedAfterFailure
        && inspectedFileMatchesCas(displacedAfterFailure, change.expectedLive)
        && change.expectedLiveIdentity
        && displacedAfterFailure.dev === change.expectedLiveIdentity.dev
        && displacedAfterFailure.ino === change.expectedLiveIdentity.ino
      ) {
        await moveFileNoClobber(
          liveVaultPath,
          displacedRelativePath,
          change.relativePath,
          parentChain,
          change.expectedLiveIdentity
        );
      }
      throw error;
    }
  } else {
    await assertLiveCas(
      liveVaultPath,
      change.relativePath,
      change.expectedLive,
      change.expectedLiveIdentity
    );
  }

  if (change.operation === "delete") return;
  if (!entry.installTempRelativePath) {
    throw new MaintenanceShadowError("changeset_corrupt", `缺少 install 临时路径：${change.relativePath}`);
  }
  const resultMode = change.expectedLive.kind === "file" ? change.expectedLive.mode & 0o777 : 0o644;
  const blobPath = resolveVaultRelativePath(sealedBlobRootPath, change.blobRelativePath);
  await installFileExclusively(
    liveVaultPath,
    blobPath,
    change.relativePath,
    entry.installTempRelativePath,
    parentChain,
    change.shadowSha256,
    change.size,
    resultMode || 0o644,
    change.relativePath,
    afterInstallLink
  );
}

async function displaceLiveFileNoClobber(
  liveVaultPath: string,
  relativePath: string,
  displacedRelativePath: string,
  parentChain: SafeDirectoryChain,
  expected: MaintenanceShadowCasFile,
  expectedIdentity?: MaintenanceShadowFileIdentity
): Promise<void> {
  const targetPath = resolveVaultRelativePath(liveVaultPath, relativePath);
  const displacedPath = resolveVaultRelativePath(
    liveVaultPath,
    displacedRelativePath
  );
  await assertSafeDirectoryChainUnchanged(parentChain);
  let linked = false;
  try {
    try {
      await fsp.link(targetPath, displacedPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new MaintenanceShadowError(
        "cas_conflict",
        `维护事务保留路径被并发占用：${relativePath}`,
        relativePath
      );
    }
    await syncDirectoryDurably(path.dirname(targetPath));
    await assertSafeDirectoryChainUnchanged(parentChain);
    const [target, displaced] = await Promise.all([
      lstatOrNull(targetPath),
      lstatOrNull(displacedPath)
    ]);
    if (
      !target
      || !displaced
      || !target.isFile()
      || target.isSymbolicLink()
      || !displaced.isFile()
      || displaced.isSymbolicLink()
      || target.dev !== displaced.dev
      || target.ino !== displaced.ino
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `维护事务保留项未绑定原目标：${relativePath}`,
        relativePath
      );
    }
    const inspected = await inspectRegularFile(displacedPath, [2]);
    if (
      !inspectedFileMatchesCas(inspected, expected)
      || !expectedIdentity
      || inspected.dev !== expectedIdentity.dev
      || inspected.ino !== expectedIdentity.ino
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `CAS 冲突，link 时目标已被并发修改：${relativePath}`,
        relativePath
      );
    }
    await assertSafeDirectoryChainUnchanged(parentChain);
    const [targetAgain, displacedAgain] = await Promise.all([
      lstatOrNull(targetPath),
      lstatOrNull(displacedPath)
    ]);
    if (
      !targetAgain
      || !displacedAgain
      || targetAgain.dev !== displacedAgain.dev
      || targetAgain.ino !== displacedAgain.ino
      || Number(targetAgain.dev) !== inspected.dev
      || Number(targetAgain.ino) !== inspected.ino
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `维护事务 unlink 前目标 inode 已变化：${relativePath}`,
        relativePath
      );
    }
    await fsp.unlink(targetPath);
    await syncDirectoryDurably(path.dirname(targetPath));
    await assertSafeDirectoryChainUnchanged(parentChain);
    linked = false;
    const displacedAfter = await assertRootRelativeFileMatchesCas(
      liveVaultPath,
      displacedRelativePath,
      expected,
      [1]
    );
    if (
      !expectedIdentity
      || displacedAfter.dev !== expectedIdentity.dev
      || displacedAfter.ino !== expectedIdentity.ino
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `维护事务 displaced inode 与基线不一致：${relativePath}`,
        relativePath
      );
    }
  } catch (error) {
    if (linked) {
      const [target, displaced] = await Promise.all([
        lstatOrNull(targetPath),
        lstatOrNull(displacedPath)
      ]);
      if (
        target
        && displaced
        && target.isFile()
        && !target.isSymbolicLink()
        && displaced.isFile()
        && !displaced.isSymbolicLink()
        && target.dev === displaced.dev
        && target.ino === displaced.ino
      ) {
        await unlinkRootRelativeFileIfMatches(
          liveVaultPath,
          displacedRelativePath,
          expected,
          {
            label: "Shadow displacement rollback artifact",
            allowedLinkCounts: [2],
            expectedIdentity: {
              dev: Number(displaced.dev),
              ino: Number(displaced.ino)
            }
          }
        ).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function installFileExclusively(
  liveVaultPath: string,
  sourcePath: string,
  targetRelativePath: string,
  tempRelativePath: string,
  parentChain: SafeDirectoryChain,
  expectedSha256: string,
  expectedSize: number,
  mode: number,
  relativePath: string,
  afterInstallLink?: () => void | Promise<void>
): Promise<void> {
  const targetPath = resolveVaultRelativePath(liveVaultPath, targetRelativePath);
  const tempPath = resolveVaultRelativePath(liveVaultPath, tempRelativePath);
  const expected: MaintenanceShadowCasFile = {
    kind: "file",
    sha256: expectedSha256,
    size: expectedSize,
    mode
  };
  let createdTemp: InspectedFile | undefined;
  try {
    createdTemp = await copyFileWithExpectedContent(
      sourcePath,
      tempPath,
      expectedSha256,
      expectedSize,
      mode,
      {
        vaultPath: liveVaultPath,
        relativePath: tempRelativePath,
        parentChain
      }
    );
    await assertSafeDirectoryChainUnchanged(parentChain);
    const temp = await inspectRegularFile(tempPath);
    if (!inspectedFileMatchesCas(temp, expected)) {
      throw new MaintenanceShadowError(
        "source_changed",
        `事务 install 临时项内容不匹配：${relativePath}`,
        relativePath
      );
    }
    try {
      await fsp.link(tempPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MaintenanceShadowError(
          "cas_conflict",
          `CAS 冲突，提交瞬间目标重新出现：${relativePath}`,
          relativePath
        );
      }
      throw error;
    }
    await syncDirectoryDurably(path.dirname(targetPath));
    await afterInstallLink?.();
    await assertSafeDirectoryChainUnchanged(parentChain);
    const [target, tempAgain] = await Promise.all([
      lstatOrNull(targetPath),
      lstatOrNull(tempPath)
    ]);
    if (
      !target
      || !tempAgain
      || !target.isFile()
      || target.isSymbolicLink()
      || !tempAgain.isFile()
      || tempAgain.isSymbolicLink()
      || target.dev !== tempAgain.dev
      || target.ino !== tempAgain.ino
      || Number(target.dev) !== temp.dev
      || Number(target.ino) !== temp.ino
      || Number(target.nlink) !== 2
      || Number(tempAgain.nlink) !== 2
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `事务 install 未绑定已验证临时项：${relativePath}`,
        relativePath
      );
    }
    await unlinkRootRelativeFileIfIdentityMatches(
      liveVaultPath,
      tempRelativePath,
      temp,
      {
        label: "Shadow install artifact",
        parentChain
      }
    );
    const installed = await assertRootRelativeFileMatchesCas(
      liveVaultPath,
      targetRelativePath,
      expected,
      [1]
    );
    if (installed.dev !== temp.dev || installed.ino !== temp.ino) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `事务 install 目标 inode 在临时链接移除后发生变化：${relativePath}`,
        relativePath
      );
    }
    return;
  } catch (error) {
    if (error instanceof MaintenanceShadowSimulatedCrash) throw error;
    if (createdTemp) {
      await unlinkRootRelativeFileIfMatches(
        liveVaultPath,
        tempRelativePath,
        expected,
        {
          label: "Shadow failed install artifact",
          allowedLinkCounts: [1, 2],
          expectedIdentity: createdTemp,
          allowMissing: true
        }
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function moveFileNoClobber(
  liveVaultPath: string,
  sourceRelativePath: string,
  targetRelativePath: string,
  parentChain: SafeDirectoryChain,
  expectedSourceIdentity?: MaintenanceShadowFileIdentity
): Promise<void> {
  const sourcePath = resolveVaultRelativePath(liveVaultPath, sourceRelativePath);
  const targetPath = resolveVaultRelativePath(liveVaultPath, targetRelativePath);
  const source = await inspectRootRelativeFile(
    liveVaultPath,
    sourceRelativePath
  );
  if (!source) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `恢复来源已缺失：${sourceRelativePath}`,
      sourceRelativePath
    );
  }
  if (
    expectedSourceIdentity
    && (
      source.dev !== expectedSourceIdentity.dev
      || source.ino !== expectedSourceIdentity.ino
    )
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `恢复来源 inode 与事务基线不一致：${sourceRelativePath}`,
      sourceRelativePath
    );
  }
  const expected = casFromInspectedFile(source);
  await assertSafeDirectoryChainUnchanged(parentChain);
  try {
    await fsp.link(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `恢复时目标已被并发创建：${targetRelativePath}`,
        targetRelativePath
      );
    }
    throw error;
  }
  await syncDirectoryDurably(path.dirname(targetPath));
  await assertSafeDirectoryChainUnchanged(parentChain);
  const [sourceAgain, targetAgain] = await Promise.all([
    lstatOrNull(sourcePath),
    lstatOrNull(targetPath)
  ]);
  if (
    !sourceAgain
    || !targetAgain
    || sourceAgain.dev !== targetAgain.dev
    || sourceAgain.ino !== targetAgain.ino
    || Number(sourceAgain.dev) !== source.dev
    || Number(sourceAgain.ino) !== source.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `恢复 hardlink 未绑定已验证来源：${sourceRelativePath}`,
      sourceRelativePath
    );
  }
  await unlinkRootRelativeFileIfMatches(
    liveVaultPath,
    sourceRelativePath,
    expected,
    {
      label: "Shadow recovery source",
      allowedLinkCounts: [2],
      expectedIdentity: source
    }
  );
  await assertRootRelativeFileMatchesCas(
    liveVaultPath,
    targetRelativePath,
    expected,
    [1]
  );
}

type ApplyEntryState =
  | "baseline"
  | "result"
  | "metadata-successor"
  | "intermediate"
  | "conflict";

interface ApplyJournalMetadataSuccessorContext {
  sealedBlobRootPath: string;
  window: MaintenanceMarkdownUpdatedSuccessorWindow;
  installWindows: ReadonlyMap<
    string,
    MaintenanceMarkdownUpdatedSuccessorWindow
  >;
}

function refreshApplyJournalMetadataSuccessorContext(
  context: ApplyJournalMetadataSuccessorContext | undefined,
  journal: MaintenanceApplyJournal
): ApplyJournalMetadataSuccessorContext | undefined {
  if (!context) return undefined;
  return {
    ...context,
    installWindows: new Map(
      (journal.metadataSuccessorInstallWindows ?? []).map((entry) => [
        normalizeVaultRelativePath(entry.relativePath),
        { ...entry.window }
      ])
    )
  };
}

async function classifyApplyJournalEntries(
  liveVaultPath: string,
  entries: readonly MaintenanceApplyJournalEntry[],
  metadataSuccessor?: ApplyJournalMetadataSuccessorContext
): Promise<ApplyEntryState[]> {
  const states: ApplyEntryState[] = [];
  for (const entry of entries) {
    states.push(await classifyApplyJournalEntry(
      liveVaultPath,
      entry,
      metadataSuccessor
    ));
  }
  return states;
}

async function classifyApplyJournalEntry(
  liveVaultPath: string,
  entry: MaintenanceApplyJournalEntry,
  metadataSuccessor?: ApplyJournalMetadataSuccessorContext
): Promise<ApplyEntryState> {
  await assertExpectedParentChainUnchanged(
    liveVaultPath,
    entry.change,
    "Shadow journal classify"
  );
  const currentInspected = await inspectRootRelativeFile(
    liveVaultPath,
    entry.change.relativePath
  );
  const current: MaintenanceShadowCasBaseline = currentInspected
    ? casFromInspectedFile(currentInspected)
    : { kind: "missing" };
  const baselineMatches = entry.change.expectedLive.kind === "missing"
    ? current.kind === "missing"
    : Boolean(
      currentInspected
      && inspectedFileMatchesCas(currentInspected, entry.change.expectedLive)
      && entry.change.expectedLiveIdentity
      && currentInspected.dev === entry.change.expectedLiveIdentity.dev
      && currentInspected.ino === entry.change.expectedLiveIdentity.ino
    );
  const resultMatches = casBaselinesEqual(current, resultCas(entry.change));
  let displacedMatches = false;
  if (entry.displacedLiveRelativePath) {
    const displaced = await inspectRootRelativeFile(
      liveVaultPath,
      entry.displacedLiveRelativePath
    );
    displacedMatches = Boolean(
      displaced
      && entry.change.expectedLive.kind === "file"
      && inspectedFileMatchesCas(displaced, entry.change.expectedLive)
      && entry.change.expectedLiveIdentity
      && displaced.dev === entry.change.expectedLiveIdentity.dev
      && displaced.ino === entry.change.expectedLiveIdentity.ino
    );
    if (displaced && !displacedMatches) return "conflict";
  }
  if (resultMatches && (entry.change.expectedLive.kind === "missing" || displacedMatches)) return "result";
  if (
    metadataSuccessor
    && (entry.change.expectedLive.kind === "missing" || displacedMatches)
    && await shadowEntryMetadataSuccessorEvidence(
      liveVaultPath,
      entry,
      metadataSuccessor
    )
  ) return "metadata-successor";
  if (baselineMatches) return "baseline";
  if (current.kind === "missing" && displacedMatches) return "intermediate";
  return "conflict";
}

async function shadowEntryMetadataSuccessorEvidence(
  liveVaultPath: string,
  entry: MaintenanceApplyJournalEntry,
  context: ApplyJournalMetadataSuccessorContext,
  options: {
    currentAllowedLinkCounts?: readonly number[];
    currentExpectedIdentity?: MaintenanceShadowFileIdentity;
  } = {}
): Promise<MaintenanceShadowMetadataSuccessorProof | null> {
  const change = entry.change;
  if (change.operation !== "upsert") return null;
  const expected = resultCas(change);
  if (expected.kind !== "file") return null;
  const desiredPath = resolveVaultRelativePath(
    context.sealedBlobRootPath,
    change.blobRelativePath
  );
  const currentPath = resolveVaultRelativePath(
    liveVaultPath,
    change.relativePath
  );
  let desiredContent: Buffer;
  let currentContent: Buffer;
  try {
    [desiredContent, currentContent] = await Promise.all([
      readIndependentRegularFile(
        desiredPath,
        `Shadow metadata successor desired ${change.relativePath}`,
        DEFAULT_MAX_CHANGED_FILE_BYTES
      ),
      readBoundRegularFile(
        currentPath,
        `Shadow metadata successor current ${change.relativePath}`,
        DEFAULT_MAX_CHANGED_FILE_BYTES,
        {
          allowedLinkCounts: options.currentAllowedLinkCounts ?? [1],
          expectedIdentity: options.currentExpectedIdentity
        }
      )
    ]);
  } catch {
    return null;
  }
  if (
    desiredContent.byteLength !== change.size
    || hashBuffer(desiredContent) !== change.shadowSha256
  ) return null;
  const current = await inspectRootRelativeFile(
    liveVaultPath,
    change.relativePath,
    options.currentAllowedLinkCounts ?? [1]
  );
  if (
    !current
    || current.size !== currentContent.byteLength
    || current.sha256 !== hashBuffer(currentContent)
    || (
      options.currentExpectedIdentity
      && (
        current.dev !== options.currentExpectedIdentity.dev
        || current.ino !== options.currentExpectedIdentity.ino
      )
    )
  ) return null;
  const evidence = maintenanceMarkdownUpdatedSuccessorEvidence({
    relativePath: change.relativePath,
    desiredContent,
    currentContent,
    desiredMode: expected.mode,
    currentMode: current.mode,
    window: context.installWindows.get(change.relativePath)
      ?? context.window,
    allowInsertedUpdated:
      maintenanceMarkdownUpdatedMayBeInserted(change.relativePath)
  });
  return evidence
    ? {
      relativePath: change.relativePath,
      result: casFromInspectedFile(current),
      updatedAt: evidence.updatedAt,
      projectionDigest: evidence.projectionDigest
    }
    : null;
}

async function recoverApplyJournal(
  liveVaultPath: string,
  journalRootPath: string,
  journal: MaintenanceApplyJournal,
  options: {
    forceRollback?: boolean;
    metadataSuccessor?: ApplyJournalMetadataSuccessorContext;
    recoverBlockedMetadataSuccessors?: boolean;
    faultInjector?: ApplyShadowChangeSetOptions["faultInjector"];
  } = {}
): Promise<MaintenanceApplyJournal> {
  const journalPath = path.join(journalRootPath, "journal.json");
  if (
    journal.state === "rolled-back"
    || (
      journal.state === "blocked"
      && !options.recoverBlockedMetadataSuccessors
    )
  ) return journal;
  let working = journal;
  try {
    await assertJournalCreatedDirectoriesUnchanged(
      liveVaultPath,
      working.createdDirectories,
      "Shadow journal recovery",
      working.state === "rolling-back"
    );
    for (const entry of working.entries) {
      await assertExpectedMissingParentState(
        liveVaultPath,
        entry.change,
        working.createdDirectories,
        "Shadow journal recovery"
      );
    }
    const artifactConflicts = await finishInterruptedExclusiveInstalls(
      liveVaultPath,
      working.entries,
      options.metadataSuccessor
    );
    if (working.state === "committed") {
      await cleanupCommittedDisplacedFiles(liveVaultPath, working.entries);
      if (artifactConflicts.length) {
        return await updateApplyJournal(journalPath, working, {
          state: "blocked",
          error: artifactConflicts[0]
        });
      }
      return working;
    }

    artifactConflicts.push(...await finishInterruptedNoClobberMoves(
      liveVaultPath,
      working.entries
    ));
    let metadataSuccessor = refreshApplyJournalMetadataSuccessorContext(
      options.metadataSuccessor,
      working
    );
    let states = await classifyApplyJournalEntries(
      liveVaultPath,
      working.entries,
      metadataSuccessor
    );
    const hasMetadataSuccessor = states.includes("metadata-successor");
    const hasConflict = states.includes("conflict");
    const canRecoverBlockedByRollingForward = Boolean(
      options.recoverBlockedMetadataSuccessors
      && metadataSuccessor
      && hasMetadataSuccessor
      && !hasConflict
      && artifactConflicts.length === 0
      && working.state !== "rolling-back"
    );
    if (
      !options.forceRollback
      && artifactConflicts.length === 0
      && states.every(isCommittedApplyEntryState)
    ) {
      working = await persistCommittedApplyJournal(
        journalPath,
        working,
        await collectApplyJournalMetadataSuccessors(
          liveVaultPath,
          working.entries,
          states,
          metadataSuccessor
        )
      );
      await cleanupCommittedDisplacedFiles(liveVaultPath, working.entries);
      return working;
    }
    if (
      working.state === "blocked"
      && options.recoverBlockedMetadataSuccessors
      && !canRecoverBlockedByRollingForward
    ) {
      return working;
    }
    if (canRecoverBlockedByRollingForward) {
      working = await updateApplyJournal(journalPath, working, {
        state: "applying",
        error: undefined
      });
      for (const [index, entry] of working.entries.entries()) {
        const state = states[index];
        if (state !== "baseline" && state !== "intermediate") continue;
        working = await ensureApplyJournalRecoveryInstallWindow(
          journalPath,
          working,
          entry.change.relativePath
        );
        metadataSuccessor = refreshApplyJournalMetadataSuccessorContext(
          metadataSuccessor,
          working
        );
        await assertExpectedParentChainUnchanged(
          liveVaultPath,
          entry.change,
          "Shadow metadata successor roll-forward"
        );
        await assertExpectedMissingParentState(
          liveVaultPath,
          entry.change,
          working.createdDirectories,
          "Shadow metadata successor roll-forward"
        );
        const createdDirectories = await ensureTrackedParentDirectories(
          liveVaultPath,
          path.posix.dirname(entry.change.relativePath)
        );
        if (createdDirectories.length) {
          working = await updateApplyJournal(journalPath, working, {
            createdDirectories: [
              ...working.createdDirectories,
              ...createdDirectories
            ]
          });
        }
        await assertJournalCreatedDirectoriesUnchanged(
          liveVaultPath,
          working.createdDirectories,
          "Shadow metadata successor roll-forward"
        );
        try {
          await applyJournalEntry(
            liveVaultPath,
            metadataSuccessor!.sealedBlobRootPath,
            entry,
            () => options.faultInjector?.({
              point: "after-install-link",
              attemptId: working.attemptId,
              relativePath: entry.change.relativePath,
              index
            })
          );
        } catch (error) {
          const relativePath = normalizeVaultRelativePath(
            entry.change.relativePath
          );
          const hasTrustedInstallWindow = Boolean(
            metadataSuccessor?.installWindows.has(relativePath)
          );
          if (
            !(error instanceof MaintenanceShadowError)
            || error.code !== "cas_conflict"
            || !hasTrustedInstallWindow
          ) throw error;

          const retryArtifactConflicts = await finishInterruptedExclusiveInstalls(
            liveVaultPath,
            working.entries,
            metadataSuccessor
          );
          const recoveredStates = await classifyApplyJournalEntries(
            liveVaultPath,
            working.entries,
            metadataSuccessor
          );
          if (
            retryArtifactConflicts.length > 0
            || recoveredStates[index] !== "metadata-successor"
            || recoveredStates.some((state) => state === "conflict")
            || !recoveredStates
              .slice(0, index + 1)
              .every(isCommittedApplyEntryState)
          ) throw error;
          states = recoveredStates;
        }
        await options.faultInjector?.({
          point: "after-entry",
          attemptId: working.attemptId,
          relativePath: entry.change.relativePath,
          index
        });
      }
      states = await classifyApplyJournalEntries(
        liveVaultPath,
        working.entries,
        metadataSuccessor
      );
      if (!states.every(isCommittedApplyEntryState)) {
        throw new MaintenanceShadowError(
          "cas_conflict",
          "metadata successor 恢复后的全量提交复验失败"
        );
      }
      working = await persistCommittedApplyJournal(
        journalPath,
        working,
        await collectApplyJournalMetadataSuccessors(
          liveVaultPath,
          working.entries,
          states,
          metadataSuccessor
        )
      );
      await cleanupCommittedDisplacedFiles(liveVaultPath, working.entries);
      return working;
    }
    working = await updateApplyJournal(journalPath, working, { state: "rolling-back" });
    for (let index = working.entries.length - 1; index >= 0; index -= 1) {
      const entry = working.entries[index];
      if (
        !entry
        || states[index] === "conflict"
        || states[index] === "metadata-successor"
      ) continue;
      await rollbackApplyJournalEntry(liveVaultPath, journalRootPath, entry);
    }
    await cleanupJournalCreatedDirectories(liveVaultPath, working.createdDirectories);
    if (
      artifactConflicts.length
      || states.some((state) => state === "conflict")
      || states.some((state) => state === "metadata-successor")
    ) {
      return await updateApplyJournal(journalPath, working, {
        state: "blocked",
        error: artifactConflicts[0]
          ?? (
            states.includes("metadata-successor")
              ? "提交回滚保留了已证明的 metadata successor；禁止伪装成 rolled-back"
              : "提交恢复保留了并发目标，并已回滚其余可安全恢复的路径"
          )
      });
    }
    return await updateApplyJournal(journalPath, working, {
      state: "rolled-back",
      error: undefined
    });
  } catch (error) {
    if (error instanceof MaintenanceShadowSimulatedCrash) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (working.state === "blocked") return working;
    return await updateApplyJournal(journalPath, working, {
      state: "blocked",
      error: message
    });
  }
}

function isCommittedApplyEntryState(state: ApplyEntryState): boolean {
  return state === "result" || state === "metadata-successor";
}

async function collectApplyJournalMetadataSuccessors(
  liveVaultPath: string,
  entries: readonly MaintenanceApplyJournalEntry[],
  states: readonly ApplyEntryState[],
  context: ApplyJournalMetadataSuccessorContext | undefined
): Promise<MaintenanceShadowMetadataSuccessorProof[]> {
  if (!context) return [];
  const proofs: MaintenanceShadowMetadataSuccessorProof[] = [];
  for (const [index, entry] of entries.entries()) {
    if (states[index] !== "metadata-successor") continue;
    const proof = await shadowEntryMetadataSuccessorEvidence(
      liveVaultPath,
      entry,
      context
    );
    if (!proof) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `metadata successor durable proof 复验失败：${entry.change.relativePath}`,
        entry.change.relativePath
      );
    }
    proofs.push(proof);
  }
  return proofs.sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
}

async function cleanupJournalCreatedDirectories(
  liveVaultPath: string,
  createdDirectories: readonly { relativePath: string; dev: number; ino: number }[]
): Promise<void> {
  const deepestFirst = [...createdDirectories].sort((left, right) =>
    right.relativePath.split("/").length - left.relativePath.split("/").length
  );
  for (const created of deepestFirst) {
    const relativePath = normalizeVaultRelativePath(created.relativePath);
    const parentChain = await captureSafeDirectoryChain(
      liveVaultPath,
      path.posix.dirname(relativePath)
    );
    if (!parentChain.complete) continue;
    await assertSafeDirectoryChainUnchanged(parentChain);
    const absolutePath = resolveVaultRelativePath(liveVaultPath, created.relativePath);
    const stat = await lstatOrNull(absolutePath);
    if (!stat) {
      await assertSafeDirectoryChainUnchanged(parentChain);
      continue;
    }
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || Number(stat.dev) !== created.dev
      || Number(stat.ino) !== created.ino
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `回滚保留了被替换的事务目录：${relativePath}`,
        relativePath
      );
    }
    await assertSafeDirectoryChainUnchanged(parentChain);
    const children = await fsp.readdir(absolutePath);
    const beforeRemove = await lstatOrNull(absolutePath);
    if (
      !beforeRemove
      || !beforeRemove.isDirectory()
      || beforeRemove.isSymbolicLink()
      || Number(beforeRemove.dev) !== created.dev
      || Number(beforeRemove.ino) !== created.ino
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `回滚清理前事务目录 inode 已变化：${relativePath}`,
        relativePath
      );
    }
    await assertSafeDirectoryChainUnchanged(parentChain);
    if (children.length) continue;
    try {
      await fsp.rmdir(absolutePath);
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        continue;
      }
      throw error;
    }
    await syncDirectoryDurably(path.dirname(absolutePath));
    await assertSafeDirectoryChainUnchanged(parentChain);
  }
}

async function assertJournalCreatedDirectoriesUnchanged(
  liveVaultPath: string,
  createdDirectories: readonly { relativePath: string; dev: number; ino: number }[],
  label: string,
  allowMissing = false
): Promise<void> {
  for (const created of createdDirectories) {
    const relativePath = normalizeVaultRelativePath(created.relativePath);
    const chain = await captureSafeDirectoryChain(
      liveVaultPath,
      relativePath
    );
    if (!chain.complete && allowMissing) continue;
    if (!chain.complete) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `${label} 检测到事务创建目录缺失：${relativePath}`,
        relativePath
      );
    }
    await assertSafeDirectoryChainUnchanged(chain);
    const identity = chain.identities[chain.identities.length - 1];
    if (
      !identity
      || identity.dev !== created.dev
      || identity.ino !== created.ino
    ) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `${label} 检测到事务创建目录被替换：${relativePath}`,
        relativePath
      );
    }
  }
}

async function finishInterruptedNoClobberMoves(
  liveVaultPath: string,
  entries: readonly MaintenanceApplyJournalEntry[]
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const entry of entries) {
    const displacedRelativePath = entry.displacedLiveRelativePath;
    if (!displacedRelativePath || entry.change.expectedLive.kind !== "file") continue;
    await assertExpectedParentChainUnchanged(
      liveVaultPath,
      entry.change,
      "Shadow displacement recovery"
    );
    const [target, displaced] = await Promise.all([
      inspectRootRelativeFile(
        liveVaultPath,
        entry.change.relativePath,
        [1, 2]
      ),
      inspectRootRelativeFile(
        liveVaultPath,
        displacedRelativePath,
        [1, 2]
      )
    ]);
    if (
      target
      && displaced
      && target.dev === displaced.dev
      && target.ino === displaced.ino
    ) {
      if (
        !inspectedFileMatchesCas(target, entry.change.expectedLive)
        || !inspectedFileMatchesCas(displaced, entry.change.expectedLive)
        || !entry.change.expectedLiveIdentity
        || target.dev !== entry.change.expectedLiveIdentity.dev
        || target.ino !== entry.change.expectedLiveIdentity.ino
        || displaced.dev !== entry.change.expectedLiveIdentity.dev
        || displaced.ino !== entry.change.expectedLiveIdentity.ino
      ) {
        conflicts.push(
          `中断的 displacement 已被并发修改，保留两条 hardlink：${entry.change.relativePath}`
        );
        continue;
      }
      await unlinkRootRelativeFileIfMatches(
        liveVaultPath,
        displacedRelativePath,
        entry.change.expectedLive,
        {
          label: "Shadow interrupted displacement",
          allowedLinkCounts: [2],
          expectedIdentity: displaced
        }
      );
      await assertRootRelativeFileMatchesCas(
        liveVaultPath,
        entry.change.relativePath,
        entry.change.expectedLive,
        [1]
      );
    } else if (
      displaced
      && (
        !inspectedFileMatchesCas(displaced, entry.change.expectedLive)
        || !entry.change.expectedLiveIdentity
        || displaced.dev !== entry.change.expectedLiveIdentity.dev
        || displaced.ino !== entry.change.expectedLiveIdentity.ino
      )
    ) {
      conflicts.push(
        `事务 displaced 路径含第三值，已保留：${displacedRelativePath}`
      );
    }
  }
  return conflicts;
}

async function finishInterruptedExclusiveInstalls(
  liveVaultPath: string,
  entries: readonly MaintenanceApplyJournalEntry[],
  metadataSuccessor?: ApplyJournalMetadataSuccessorContext
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const entry of entries) {
    const tempRelativePath = entry.installTempRelativePath;
    if (!tempRelativePath || entry.change.operation !== "upsert") continue;
    await assertExpectedParentChainUnchanged(
      liveVaultPath,
      entry.change,
      "Shadow install recovery"
    );
    const expected = resultCas(entry.change);
    if (expected.kind !== "file") {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `事务 install 缺少结果 CAS：${entry.change.relativePath}`,
        entry.change.relativePath
      );
    }
    const temp = await inspectRootRelativeFile(
      liveVaultPath,
      tempRelativePath,
      [1, 2]
    );
    if (!temp) continue;
    const target = await inspectRootRelativeFile(
      liveVaultPath,
      entry.change.relativePath,
      [1, 2]
    );
    if (!target) {
      if (!inspectedFileMatchesCas(temp, expected)) {
        conflicts.push(
          `事务 install 目标缺失且临时项含第三值，已保留：${tempRelativePath}`
        );
        continue;
      }
      throw new MaintenanceShadowError(
        "cas_conflict",
        `事务 install 目标缺失且临时项仍在，无法区分安装前崩溃与安装后并发删除：${entry.change.relativePath}`,
        entry.change.relativePath
      );
    }
    if (
      target.dev === temp.dev
      && target.ino === temp.ino
    ) {
      if (target.nlink !== 2 || temp.nlink !== 2) {
        conflicts.push(
          `事务 install hardlink 数量异常，已保留：${entry.change.relativePath}`
        );
        continue;
      }
      const successor = inspectedFileMatchesCas(temp, expected)
        ? null
        : (
          metadataSuccessor
            ? await shadowEntryMetadataSuccessorEvidence(
              liveVaultPath,
              entry,
              metadataSuccessor,
              {
                currentAllowedLinkCounts: [2],
                currentExpectedIdentity: {
                  dev: target.dev,
                  ino: target.ino
                }
              }
            )
            : null
        );
      const accepted = inspectedFileMatchesCas(temp, expected)
        ? expected
        : successor?.result;
      if (!accepted || !inspectedFileMatchesCas(temp, accepted)) {
        conflicts.push(
          `事务 install hardlink 含第三值，已保留：${entry.change.relativePath}`
        );
        continue;
      }
      await unlinkRootRelativeFileIfMatches(
        liveVaultPath,
        tempRelativePath,
        accepted,
        {
          label: "Shadow linked install temp",
          allowedLinkCounts: [2],
          expectedIdentity: temp
        }
      );
      await assertRootRelativeFileMatchesCas(
        liveVaultPath,
        entry.change.relativePath,
        accepted,
        [1]
      );
      continue;
    }
    const successor = metadataSuccessor
      ? await shadowEntryMetadataSuccessorEvidence(
        liveVaultPath,
        entry,
        metadataSuccessor
      )
      : null;
    if (
      inspectedFileMatchesCas(temp, expected)
      && (
        inspectedFileMatchesCas(target, expected)
        || Boolean(successor)
      )
    ) {
      await unlinkRootRelativeFileIfMatches(
        liveVaultPath,
        tempRelativePath,
        expected,
        {
          label: "Shadow detached install temp",
          allowedLinkCounts: [1],
          expectedIdentity: temp
        }
      );
      continue;
    }
    conflicts.push(
      `事务 install 临时项与第三值目标冲突，已保留：${entry.change.relativePath}`
    );
  }
  return conflicts;
}

async function rollbackApplyJournalEntry(
  liveVaultPath: string,
  journalRootPath: string,
  entry: MaintenanceApplyJournalEntry
): Promise<void> {
  const parentChain = await assertExpectedParentChainUnchanged(
    liveVaultPath,
    entry.change,
    "Shadow rollback"
  );
  const state = await classifyApplyJournalEntry(liveVaultPath, entry);
  if (state === "conflict") {
    throw new MaintenanceShadowError("cas_conflict", `回滚遇到并发内容：${entry.change.relativePath}`);
  }
  if (state === "baseline") {
    if (entry.displacedLiveRelativePath && entry.change.expectedLive.kind === "file") {
      const [target, displaced] = await Promise.all([
        inspectRootRelativeFile(liveVaultPath, entry.change.relativePath),
        inspectRootRelativeFile(liveVaultPath, entry.displacedLiveRelativePath)
      ]);
      if (displaced) {
        if (
          !target
          || target.dev !== displaced.dev
          || target.ino !== displaced.ino
        ) {
          throw new MaintenanceShadowError(
            "cas_conflict",
            `回滚保留了无法证明归属的 displaced 第三值：${entry.displacedLiveRelativePath}`,
            entry.displacedLiveRelativePath
          );
        }
        await unlinkRootRelativeFileIfMatches(
          liveVaultPath,
          entry.displacedLiveRelativePath,
          entry.change.expectedLive,
          {
            label: "Shadow baseline displacement cleanup",
            allowedLinkCounts: [2],
            expectedIdentity: displaced
          }
        );
      }
    }
    return;
  }
  if (entry.change.expectedLive.kind === "missing") {
    const result = resultCas(entry.change);
    if (state === "result" && result.kind === "file") {
      await unlinkRootRelativeFileIfMatches(
        liveVaultPath,
        entry.change.relativePath,
        result,
        {
          label: "Shadow rollback created target",
          allowedLinkCounts: [1]
        }
      );
    }
    return;
  }

  const displacedRelativePath = entry.displacedLiveRelativePath;
  if (!displacedRelativePath) {
    throw new MaintenanceShadowError("changeset_corrupt", `回滚缺少 displaced 路径：${entry.change.relativePath}`);
  }
  const displacedInspected = await inspectRootRelativeFile(
    liveVaultPath,
    displacedRelativePath
  );
  const displacedMatchesBaseline = Boolean(
    displacedInspected
    && inspectedFileMatchesCas(displacedInspected, entry.change.expectedLive)
    && entry.change.expectedLiveIdentity
    && displacedInspected.dev === entry.change.expectedLiveIdentity.dev
    && displacedInspected.ino === entry.change.expectedLiveIdentity.ino
  );
  if (displacedMatchesBaseline) {
    const current = await currentCas(liveVaultPath, entry.change.relativePath);
    const result = resultCas(entry.change);
    if (result.kind === "file" && casBaselinesEqual(current, result)) {
      await unlinkRootRelativeFileIfMatches(
        liveVaultPath,
        entry.change.relativePath,
        result,
        {
          label: "Shadow rollback result target",
          allowedLinkCounts: [1]
        }
      );
    } else if (current.kind !== "missing" && !casBaselinesEqual(current, entry.change.expectedLive)) {
      throw new MaintenanceShadowError("cas_conflict", `回滚不能覆盖并发目标：${entry.change.relativePath}`);
    }
    const targetAfterRemoval = await currentCas(
      liveVaultPath,
      entry.change.relativePath
    );
    if (targetAfterRemoval.kind !== "missing") {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `回滚恢复前目标不为空：${entry.change.relativePath}`,
        entry.change.relativePath
      );
    }
    await moveFileNoClobber(
      liveVaultPath,
      displacedRelativePath,
      entry.change.relativePath,
      parentChain,
      entry.change.expectedLiveIdentity
    );
    return;
  }
  if (displacedInspected) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `回滚保留了 displaced 第三值：${displacedRelativePath}`,
      displacedRelativePath
    );
  }

  if (!entry.baselineBlobRelativePath) {
    throw new MaintenanceShadowError("changeset_corrupt", `回滚缺少 baseline blob：${entry.change.relativePath}`);
  }
  const current = await currentCas(liveVaultPath, entry.change.relativePath);
  const result = resultCas(entry.change);
  if (result.kind === "file" && casBaselinesEqual(current, result)) {
    await unlinkRootRelativeFileIfMatches(
      liveVaultPath,
      entry.change.relativePath,
      result,
      {
        label: "Shadow rollback fallback target",
        allowedLinkCounts: [1]
      }
    );
  } else if (current.kind !== "missing" && !casBaselinesEqual(current, entry.change.expectedLive)) {
    throw new MaintenanceShadowError("cas_conflict", `回滚不能覆盖并发目标：${entry.change.relativePath}`);
  }
  const baselineBlobPath = resolveVaultRelativePath(journalRootPath, entry.baselineBlobRelativePath);
  if (!entry.installTempRelativePath) {
    throw new MaintenanceShadowError("changeset_corrupt", `回滚缺少 install 临时路径：${entry.change.relativePath}`);
  }
  await installFileExclusively(
    liveVaultPath,
    baselineBlobPath,
    entry.change.relativePath,
    entry.installTempRelativePath,
    parentChain,
    entry.change.expectedLive.sha256,
    entry.change.expectedLive.size,
    entry.change.expectedLive.mode & 0o777,
    entry.change.relativePath
  );
}

async function cleanupCommittedDisplacedFiles(
  liveVaultPath: string,
  entries: readonly MaintenanceApplyJournalEntry[]
): Promise<void> {
  for (const entry of entries) {
    if (!entry.displacedLiveRelativePath || entry.change.expectedLive.kind !== "file") continue;
    await assertExpectedParentChainUnchanged(
      liveVaultPath,
      entry.change,
      "Shadow committed cleanup"
    );
    const displaced = await inspectRootRelativeFile(
      liveVaultPath,
      entry.displacedLiveRelativePath
    );
    if (!displaced) continue;
    if (
      !inspectedFileMatchesCas(displaced, entry.change.expectedLive)
      || !entry.change.expectedLiveIdentity
      || displaced.dev !== entry.change.expectedLiveIdentity.dev
      || displaced.ino !== entry.change.expectedLiveIdentity.ino
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `committed cleanup 保留了 displaced 第三值：${entry.displacedLiveRelativePath}`,
        entry.displacedLiveRelativePath
      );
    }
    await unlinkRootRelativeFileIfMatches(
      liveVaultPath,
      entry.displacedLiveRelativePath,
      entry.change.expectedLive,
      {
        label: "Shadow committed displacement",
        allowedLinkCounts: [1],
        expectedIdentity: displaced
      }
    );
  }
}

async function currentCas(
  liveVaultPath: string,
  relativePathInput: string
): Promise<MaintenanceShadowCasBaseline> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const inspected = await inspectRootRelativeFile(liveVaultPath, relativePath);
  if (!inspected) return { kind: "missing" };
  return {
    kind: "file",
    sha256: inspected.sha256,
    size: inspected.size,
    mode: inspected.mode
  };
}

function resultCas(change: MaintenanceShadowChange): MaintenanceShadowCasBaseline {
  if (change.operation === "delete") return { kind: "missing" };
  return {
    kind: "file",
    sha256: change.shadowSha256,
    size: change.size,
    mode: change.expectedLive.kind === "file" ? change.expectedLive.mode : 0o644
  };
}

/**
 * Returns the exact CAS that applying one sealed Shadow change will publish.
 * This deliberately differs from inspecting the frozen Shadow tree: sealing
 * removes write bits, while the live apply preserves an existing file mode or
 * uses 0644 for a newly created file.
 */
export function maintenanceShadowResultCasForPath(
  changeSet: Pick<MaintenanceShadowChangeSet, "changes">,
  relativePathInput: string
): MaintenanceShadowCasBaseline | undefined {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const change = changeSet.changes.find(
    (candidate) => candidate.relativePath === relativePath
  );
  return change ? resultCas(change) : undefined;
}

function casBaselinesEqual(
  left: MaintenanceShadowCasBaseline,
  right: MaintenanceShadowCasBaseline
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "missing" || right.kind === "missing") return true;
  return left.sha256 === right.sha256
    && left.size === right.size
    && (left.mode & 0o777) === (right.mode & 0o777);
}

async function readApplyJournalOrNull(journalPath: string): Promise<MaintenanceApplyJournal | null> {
  const stat = await lstatOrNull(journalPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new MaintenanceShadowError("changeset_corrupt", "apply journal 不是独立普通文件");
  }
  const parsed = JSON.parse(await fsp.readFile(journalPath, "utf8")) as MaintenanceApplyJournal;
  if (parsed.version !== 1 || parsed.digest !== applyJournalDigest(parsed)) {
    throw new MaintenanceShadowError("changeset_corrupt", "apply journal digest 校验失败");
  }
  return parsed;
}

function assertApplyJournalMatches(
  journal: MaintenanceApplyJournal,
  changeSet: MaintenanceShadowChangeSet,
  selectionDigest: string
): void {
  const selectedPaths = journal.selectedPaths.map(normalizeVaultRelativePath);
  const changesByPath = new Map(
    changeSet.changes.map((change) => [
      normalizeVaultRelativePath(change.relativePath),
      change
    ])
  );
  const entriesMatch = journal.entries.length === selectedPaths.length
    && journal.entries.every((entry, index) => {
      const relativePath = normalizeVaultRelativePath(
        entry.change.relativePath
      );
      const sealed = changesByPath.get(relativePath);
      return relativePath === selectedPaths[index]
        && Boolean(sealed)
        && stableStringify(entry.change) === stableStringify(sealed);
    });
  const metadataSuccessors = Array.isArray(journal.metadataSuccessors)
    ? journal.metadataSuccessors
    : [];
  const rawInstallWindows = journal.metadataSuccessorInstallWindows;
  const installWindows = Array.isArray(rawInstallWindows)
    ? rawInstallWindows
    : [];
  const policy = journal.metadataSuccessorPolicy;
  const metadataSuccessorPolicyValid = policy === undefined || (
    policy.version === 1
    && policy.kind === "markdown-updated-only"
    && Number.isFinite(policy.window?.lowerBoundMs)
    && Number.isFinite(policy.window?.upperBoundMs)
    && policy.window.upperBoundMs >= policy.window.lowerBoundMs
  );
  const metadataSuccessorPolicyBound = policy === undefined
    || stableStringify(policy) === stableStringify(metadataSuccessorPolicyFor(
      changeSet.createdAt,
      journal.createdAt
    ));
  const metadataSuccessorPaths = new Set<string>();
  const metadataSuccessorsValid = metadataSuccessors.every((proof) => {
    const relativePath = normalizeVaultRelativePath(proof.relativePath);
    if (metadataSuccessorPaths.has(relativePath)) return false;
    metadataSuccessorPaths.add(relativePath);
    return selectedPaths.includes(relativePath)
      && proof.result?.kind === "file"
      && isSha256(proof.result.sha256)
      && Number.isSafeInteger(proof.result.size)
      && proof.result.size >= 0
      && Number.isSafeInteger(proof.result.mode)
      && Number.isFinite(proof.updatedAt)
      && isSha256(proof.projectionDigest);
  });
  const installWindowPaths = new Set<string>();
  const installWindowsValid = installWindows.every((entry) => {
    const relativePath = normalizeVaultRelativePath(entry.relativePath);
    const createdAtMs = Date.parse(entry.createdAt);
    if (installWindowPaths.has(relativePath)) return false;
    installWindowPaths.add(relativePath);
    return selectedPaths.includes(relativePath)
      && Number.isFinite(createdAtMs)
      && entry.window?.lowerBoundMs === createdAtMs
      && entry.window?.upperBoundMs
        === createdAtMs + METADATA_SUCCESSOR_WINDOW_MS
      && createdAtMs >= Date.parse(journal.createdAt)
      && createdAtMs <= Date.parse(journal.updatedAt);
  });
  if (
    journal.attemptId !== changeSet.attemptId
    || journal.liveVaultFingerprint !== changeSet.liveVaultFingerprint
    || journal.changeSetDigest !== changeSet.digest
    || journal.selectionDigest !== selectionDigest
    || journal.selectionDigest !== digestJson(selectedPaths)
    || selectedPaths.length === 0
    || new Set(selectedPaths).size !== selectedPaths.length
    || !entriesMatch
    || !Number.isFinite(Date.parse(journal.createdAt))
    || !Number.isFinite(Date.parse(journal.updatedAt))
    || !metadataSuccessorPolicyValid
    || !metadataSuccessorPolicyBound
    || (
      journal.metadataSuccessors !== undefined
      && !Array.isArray(journal.metadataSuccessors)
    )
    || (rawInstallWindows !== undefined && !Array.isArray(rawInstallWindows))
    || !installWindowsValid
    || (metadataSuccessors.length > 0 && !policy)
    || !metadataSuccessorsValid
  ) {
    throw new MaintenanceShadowError("changeset_corrupt", "已有 apply journal 与本次 changeset 不一致");
  }
}

function applyJournalMetadataSuccessorContext(
  changeSet: MaintenanceShadowChangeSet,
  journal: MaintenanceApplyJournal
): ApplyJournalMetadataSuccessorContext {
  const policy = journal.metadataSuccessorPolicy;
  if (!policy) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "metadata successor 恢复缺少固定 policy/window"
    );
  }
  return {
    sealedBlobRootPath: changeSet.sealedBlobRootPath,
    window: { ...policy.window },
    installWindows: new Map(
      (journal.metadataSuccessorInstallWindows ?? []).map((entry) => [
        normalizeVaultRelativePath(entry.relativePath),
        { ...entry.window }
      ])
    )
  };
}

function metadataSuccessorPolicyFor(
  changeSetCreatedAt: string,
  journalCreatedAt: string
): MaintenanceShadowMetadataSuccessorPolicy {
  const changeSetTime = Date.parse(changeSetCreatedAt);
  const journalCreatedTime = Date.parse(journalCreatedAt);
  if (!Number.isFinite(changeSetTime) || !Number.isFinite(journalCreatedTime)) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "metadata successor policy 缺少可信 immutable 时间"
    );
  }
  return {
    version: 1,
    kind: "markdown-updated-only",
    window: {
      lowerBoundMs: Math.min(changeSetTime, journalCreatedTime),
      upperBoundMs:
        Math.max(changeSetTime, journalCreatedTime)
        + METADATA_SUCCESSOR_WINDOW_MS
    }
  };
}

async function ensureApplyJournalMetadataSuccessorPolicy(
  journalPath: string,
  journal: MaintenanceApplyJournal,
  changeSet: MaintenanceShadowChangeSet
): Promise<MaintenanceApplyJournal> {
  if (journal.metadataSuccessorPolicy) return journal;
  const policy = metadataSuccessorPolicyFor(
    changeSet.createdAt,
    journal.createdAt
  );
  const upgraded = await updateApplyJournal(journalPath, journal, {
    metadataSuccessorPolicy: policy
  });
  await syncDirectoryDurably(path.dirname(journalPath));
  const readBack = await readApplyJournalOrNull(journalPath);
  if (
    !readBack
    || readBack.digest !== upgraded.digest
    || stableStringify(readBack.metadataSuccessorPolicy)
      !== stableStringify(policy)
  ) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "legacy metadata successor policy durable read-back 失败"
    );
  }
  return readBack;
}

async function ensureApplyJournalRecoveryInstallWindow(
  journalPath: string,
  journal: MaintenanceApplyJournal,
  relativePathInput: string
): Promise<MaintenanceApplyJournal> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const now = Date.now();
  const existing = (journal.metadataSuccessorInstallWindows ?? []).find(
    (entry) => normalizeVaultRelativePath(entry.relativePath) === relativePath
  );
  if (existing && existing.window.upperBoundMs >= now) return journal;

  // This is called only after classification proved the entry is still an
  // exact baseline/intermediate state. Therefore refreshing an expired window
  // cannot bless an earlier result; it durably authorizes only the install the
  // current matching attempt is about to perform.
  const nextWindow = {
    relativePath,
    createdAt: new Date(now).toISOString(),
    window: {
      lowerBoundMs: now,
      upperBoundMs: now + METADATA_SUCCESSOR_WINDOW_MS
    }
  };
  const windows = [
    ...(journal.metadataSuccessorInstallWindows ?? []).filter(
      (entry) => normalizeVaultRelativePath(entry.relativePath) !== relativePath
    ),
    nextWindow
  ].sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
  const updated = await updateApplyJournal(journalPath, journal, {
    metadataSuccessorInstallWindows: windows
  });
  await syncDirectoryDurably(path.dirname(journalPath));
  const readBack = await readApplyJournalOrNull(journalPath);
  if (
    !readBack
    || readBack.digest !== updated.digest
    || stableStringify(readBack.metadataSuccessorInstallWindows ?? [])
      !== stableStringify(windows)
  ) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      `metadata successor recovery install window durable read-back 失败：${relativePath}`,
      relativePath
    );
  }
  return readBack;
}

async function persistCommittedApplyJournal(
  journalPath: string,
  journal: MaintenanceApplyJournal,
  metadataSuccessors: MaintenanceShadowMetadataSuccessorProof[]
): Promise<MaintenanceApplyJournal> {
  if (!journal.metadataSuccessorPolicy) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "committed apply journal 缺少固定 metadata successor policy"
    );
  }
  const committed = await updateApplyJournal(journalPath, journal, {
    state: "committed",
    error: undefined,
    metadataSuccessors
  });
  await syncDirectoryDurably(path.dirname(journalPath));
  const readBack = await readApplyJournalOrNull(journalPath);
  if (
    !readBack
    || readBack.state !== "committed"
    || readBack.digest !== committed.digest
    || stableStringify(readBack.selectedPaths)
      !== stableStringify(committed.selectedPaths)
    || stableStringify(readBack.metadataSuccessorPolicy)
      !== stableStringify(committed.metadataSuccessorPolicy)
    || stableStringify(readBack.metadataSuccessors ?? [])
      !== stableStringify(committed.metadataSuccessors ?? [])
  ) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "successor committed journal durable read-back 失败"
    );
  }
  return readBack;
}

async function updateApplyJournal(
  journalPath: string,
  journal: MaintenanceApplyJournal,
  patch: Partial<Pick<
    MaintenanceApplyJournal,
    | "state"
    | "error"
    | "createdDirectories"
    | "metadataSuccessorPolicy"
    | "metadataSuccessorInstallWindows"
    | "metadataSuccessors"
  >>
): Promise<MaintenanceApplyJournal> {
  const next: Omit<MaintenanceApplyJournal, "digest"> = {
    ...withoutApplyJournalDigest(journal),
    ...(patch.state ? { state: patch.state } : {}),
    ...(patch.createdDirectories ? { createdDirectories: patch.createdDirectories } : {}),
    ...(patch.metadataSuccessorPolicy
      ? { metadataSuccessorPolicy: patch.metadataSuccessorPolicy }
      : {}),
    ...("metadataSuccessorInstallWindows" in patch
      ? {
        metadataSuccessorInstallWindows:
          patch.metadataSuccessorInstallWindows ?? []
      }
      : {}),
    ...(patch.metadataSuccessors
      ? { metadataSuccessors: patch.metadataSuccessors }
      : {}),
    updatedAt: new Date().toISOString()
  };
  if ("error" in patch) {
    if (patch.error === undefined) delete next.error;
    else next.error = patch.error;
  }
  const updated = withApplyJournalDigest(next);
  await writeJsonAtomic(journalPath, updated);
  return updated;
}

function withApplyJournalDigest(
  journal: Omit<MaintenanceApplyJournal, "digest">
): MaintenanceApplyJournal {
  return { ...journal, digest: digestJson(journal) };
}

function withoutApplyJournalDigest(
  journal: MaintenanceApplyJournal
): Omit<MaintenanceApplyJournal, "digest"> {
  const { digest: _digest, ...rest } = journal;
  return rest;
}

function applyJournalDigest(journal: MaintenanceApplyJournal): string {
  return digestJson(withoutApplyJournalDigest(journal));
}

function applyCommitReceipt(journal: MaintenanceApplyJournal): string {
  if (journal.state !== "committed") {
    throw new MaintenanceShadowError("invalid_state", "apply journal 尚未 committed");
  }
  return digestJson({
    journalDigest: journal.digest,
    attemptId: journal.attemptId,
    changeSetDigest: journal.changeSetDigest,
    selectionDigest: journal.selectionDigest,
    selectedPaths: journal.selectedPaths.map(normalizeVaultRelativePath),
    metadataSuccessorPolicy: journal.metadataSuccessorPolicy,
    metadataSuccessors: [...(journal.metadataSuccessors ?? [])]
      .sort((left, right) => compareCanonicalText(
        left.relativePath,
        right.relativePath
      )),
    state: journal.state
  });
}

export interface CreateMaintenanceShadowOptions {
  liveVaultPath: string;
  attemptId: string;
  /**
   * Persistent plugin-owned control storage. Production callers should use
   * `.obsidian/plugins/<plugin-id>/maintenance-shadows` or an Application
   * Support directory; implicit OS tmp storage is intentionally unsupported.
   */
  storageRootPath: string;
  rawPaths?: readonly string[];
  rulesPaths?: readonly string[];
  requiredSourcePaths?: readonly string[];
  copiedPaths?: readonly string[];
  writablePaths?: readonly string[];
  chunkedTextSources?: readonly MaintenanceShadowChunkedTextSource[];
  limits?: Partial<MaintenanceShadowLimits>;
}

export interface MaintenanceShadowChunkedTextSource {
  relativePath: string;
  maxChunkBytes: number;
}

export interface MaintenanceShadowSourceChunk {
  sourceRelativePath: string;
  relativePath: string;
  index: number;
  count: number;
  startByte: number;
  endByte: number;
  size: number;
  sha256: string;
}

export interface MaintenanceShadowLimits {
  maxChangedFileBytes: number;
  maxChangedTotalBytes: number;
  maxChangedFiles: number;
}

export interface MaintenanceShadowHandle {
  attemptId: string;
  rootPath: string;
  /**
   * This is the only path that should be passed to an Agent.
   * The manifest and live Vault location stay outside this directory.
   */
  agentVaultPath: string;
  manifestPath: string;
  sourceChunks?: MaintenanceShadowSourceChunk[];
}

export interface MaintenanceShadowCasMissing {
  kind: "missing";
}

export interface MaintenanceShadowCasFile {
  kind: "file";
  sha256: string;
  size: number;
  mode: number;
}

export type MaintenanceShadowCasBaseline = MaintenanceShadowCasMissing | MaintenanceShadowCasFile;

export interface MaintenanceShadowDirectoryIdentity {
  relativePath: string;
  dev: number;
  ino: number;
}

export interface MaintenanceShadowFileIdentity {
  dev: number;
  ino: number;
}

export interface MaintenanceShadowCommittedTargetOverride {
  relativePath: string;
  expected: MaintenanceShadowCasBaseline;
  desired: MaintenanceShadowCasBaseline;
}

export interface MaintenanceShadowMetadataSuccessorProof {
  relativePath: string;
  result: MaintenanceShadowCasFile;
  updatedAt: number;
  projectionDigest: string;
}

export interface MaintenanceShadowMetadataSuccessorPolicy {
  version: 1;
  kind: "markdown-updated-only";
  window: MaintenanceMarkdownUpdatedSuccessorWindow;
}

export interface MaintenanceShadowCommittedVerification {
  metadataSuccessors: MaintenanceShadowMetadataSuccessorProof[];
}

export interface MaintenanceShadowUpsertChange {
  operation: "upsert";
  relativePath: string;
  expectedLive: MaintenanceShadowCasBaseline;
  expectedLiveIdentity?: MaintenanceShadowFileIdentity;
  /**
   * Existing parent directories captured with the live baseline, rooted at
   * ".". Apply refuses a replaced directory even when the target bytes happen
   * to match the original CAS.
   */
  expectedParentChain?: MaintenanceShadowDirectoryIdentity[];
  expectedMissingParentPath?: string;
  shadowSha256: string;
  size: number;
  blobRelativePath: string;
}

export interface MaintenanceShadowDeleteChange {
  operation: "delete";
  relativePath: string;
  expectedLive: MaintenanceShadowCasFile;
  expectedLiveIdentity?: MaintenanceShadowFileIdentity;
  expectedParentChain?: MaintenanceShadowDirectoryIdentity[];
  expectedMissingParentPath?: string;
}

export type MaintenanceShadowChange = MaintenanceShadowUpsertChange | MaintenanceShadowDeleteChange;

export interface MaintenanceShadowChangeSet {
  version: typeof CHANGESET_VERSION;
  attemptId: string;
  liveVaultFingerprint: string;
  baselineDigest: string;
  shadowVaultPath: string;
  controlRootPath: string;
  sealedBlobRootPath: string;
  createdAt: string;
  changes: MaintenanceShadowChange[];
  excludedPluginOwnedPaths: string[];
  structuralResult: "committable" | "plugin-owned-only" | "zero-result";
  digest: string;
}

export interface MaintenanceShadowWriteFenceProof {
  backend: string;
  evidence: string;
  opaqueReceipt: string;
  enforcedWritableRootPaths: string[];
  enforcedDeniedPaths: string[];
  deniedProbeAttempts: Array<{
    path: string;
    outcome: "denied";
    errorCode: string;
  }>;
}

export interface MaintenanceShadowWriteFenceChallenge {
  token: string;
  writableShadowProbePath: string;
  deniedLiveProbePath: string;
  deniedControlProbePath: string;
  deniedWriteProbePaths: string[];
}

export interface CreateMaintenanceShadowTransportConfigReceiptInput {
  backend: string;
  attemptId: string;
  leaseId: string;
  enforcedWritableRootPaths: readonly string[];
  enforcedDeniedShadowPaths: readonly string[];
  deniedLiveVaultPath: string;
  deniedControlPath: string;
  transportAck: string;
  transportConfigDigest: string;
  issuedAt?: string;
}

export interface MaintenanceShadowTransportConfigReceipt {
  version: 1;
  backend: string;
  attemptId: string;
  leaseId: string;
  enforcedWritableRootPaths: string[];
  enforcedDeniedShadowPaths: string[];
  deniedLiveVaultPath: string;
  deniedControlPath: string;
  transportAck: string;
  transportConfigDigest: string;
  issuedAt: string;
  digest: string;
}

export interface MaintenanceShadowExecutionBoundary {
  agentVaultPath: string;
  writableRootPaths: string[];
  deniedPaths: string[];
  deniedParentPath: string;
  deniedLiveVaultFingerprint: string;
}

export interface ApplyShadowChangeSetOptions {
  /**
   * Selects a safe subset of the changeset. Every entry must be an exact file
   * path already present in the sealed changeset.
   */
  allowPaths?: readonly string[];
  /**
   * Optional transaction observer used by the Harness for phase events and
   * deterministic fault injection. Throwing triggers journaled rollback.
   */
  beforeApplyChange?: (input: {
    attemptId: string;
    relativePath: string;
    index: number;
  }) => void | Promise<void>;
  /**
   * Test-only crash barrier. Production callers must not provide it.
   */
  faultInjector?: (input: {
    point: "after-install-link" | "after-entry" | "after-journal-commit";
    attemptId: string;
    relativePath: string;
    index: number;
  }) => void | Promise<void>;
}

export interface ApplyShadowChangeSetResult {
  appliedPaths: string[];
  skippedPaths: string[];
  commitReceipt?: string;
}

export interface MaintenanceShadowZeroResultAttestationOptions {
  /**
   * Runtime sentinels are retained only for isolated module tests. Production
   * post-start failover must use a transport-config receipt issued before the
   * Agent prompt starts.
   */
  allowRuntimeSentinelForTests?: boolean;
}

const issuedTransportConfigReceipts = new WeakSet<object>();
const ZERO_RESULT_ATTESTATION_TOKEN = Symbol("maintenance-zero-result");
const issuedZeroResultAttestations = new WeakSet<MaintenanceShadowZeroResultAttestation>();
const QUARANTINE_RECEIPT_TOKEN = Symbol("maintenance-shadow-quarantine");
const issuedQuarantineReceipts = new WeakSet<MaintenanceShadowQuarantineReceipt>();

export class MaintenanceShadowZeroResultAttestation {
  readonly zeroCommittable = true;
  readonly zeroRecoverable = true;
  readonly noCommitIntent = true;
  readonly liveBaselineUnchanged = true;
  readonly sealed = true;
  readonly writeFenceVerified = true;

  constructor(
    token: typeof ZERO_RESULT_ATTESTATION_TOKEN,
    public readonly attemptId: string,
    public readonly manifestDigest: string,
    public readonly changeSetDigest: string,
    public readonly liveVaultFingerprint: string,
    public readonly issuedAt: string,
    public readonly digest: string
  ) {
    if (token !== ZERO_RESULT_ATTESTATION_TOKEN) {
      throw new MaintenanceShadowError("invalid_state", "zero-result attestation 不能由外部构造");
    }
  }
}

/**
 * Returns true only for an attestation issued by this module in this process.
 * `instanceof` alone is insufficient because `Object.create(prototype)` can
 * forge the prototype chain without running the private-token constructor.
 */
export function isTrustedMaintenanceShadowZeroResultAttestation(
  value: unknown
): value is MaintenanceShadowZeroResultAttestation {
  return value instanceof MaintenanceShadowZeroResultAttestation
    && issuedZeroResultAttestations.has(value)
    && Object.isFrozen(value)
    && value.zeroCommittable === true
    && value.zeroRecoverable === true
    && value.noCommitIntent === true
    && value.liveBaselineUnchanged === true
    && value.sealed === true
    && value.writeFenceVerified === true;
}

interface MaintenanceShadowQuarantineRecord {
  version: 1;
  attemptId: string;
  backend: AgentExactWriteFenceReceipt["backend"];
  leaseToken: string;
  writeFenceConfigAckDigest: string;
  exactWriteFenceBindingDigest: string;
  sealedManifestDigest: string;
  changeSetDigest: string;
  zeroResultDigest: string;
  quarantinedAt: string;
  reason: string;
  digest: string;
}

/**
 * Nominal, in-process proof that a sealed zero-result Shadow durably moved to
 * `abandoned` while holding the same per-Vault lock used by apply. The durable
 * manifest is the authority; this object only lets routing consume that fact
 * without accepting spread/JSON/prototype forgeries.
 */
export class MaintenanceShadowQuarantineReceipt {
  readonly commitAuthorityRevoked = true;
  readonly cleanupAuthorityRevoked = true;
  readonly durableReadBack = true;

  constructor(
    token: typeof QUARANTINE_RECEIPT_TOKEN,
    public readonly attemptId: string,
    public readonly backend: AgentExactWriteFenceReceipt["backend"],
    public readonly leaseToken: string,
    public readonly writeFenceConfigAckDigest: string,
    public readonly exactWriteFenceBindingDigest: string,
    public readonly sealedManifestDigest: string,
    public readonly abandonedManifestDigest: string,
    public readonly changeSetDigest: string,
    public readonly zeroResultDigest: string,
    public readonly quarantineRecordDigest: string,
    public readonly quarantinedAt: string
  ) {
    if (token !== QUARANTINE_RECEIPT_TOKEN) {
      throw new MaintenanceShadowError("invalid_state", "quarantine receipt 不能由外部构造");
    }
  }
}

export function isTrustedMaintenanceShadowQuarantineReceipt(
  value: unknown
): value is MaintenanceShadowQuarantineReceipt {
  return value instanceof MaintenanceShadowQuarantineReceipt
    && issuedQuarantineReceipts.has(value)
    && Object.isFrozen(value)
    && value.commitAuthorityRevoked === true
    && value.cleanupAuthorityRevoked === true
    && value.durableReadBack === true;
}

interface MaintenanceShadowEntry {
  relativePath: string;
  kind: "file" | "directory";
  mode: number;
  size?: number;
  sha256?: string;
  dev?: number;
  ino?: number;
}

interface MaintenanceShadowManifest {
  version: typeof MANIFEST_VERSION;
  attemptId: string;
  state: MaintenanceShadowState;
  liveVaultFingerprint: string;
  storageRootPath: string;
  rootPath: string;
  shadowVaultPath: string;
  rawPaths: string[];
  rulesPaths: string[];
  requiredSourcePaths: string[];
  writablePaths: string[];
  limits: MaintenanceShadowLimits;
  copiedRoots: string[];
  liveRootIdentity: {
    dev: number;
    ino: number;
  };
  liveBaseline: MaintenanceShadowEntry[];
  shadowBaseline: MaintenanceShadowEntry[];
  baselineDigest: string;
  shadowBaselineDigest: string;
  createdAt: string;
  sealedAt?: string;
  abandonedAt?: string;
  abandonReason?: string;
  terminalAt?: string;
  sealedChangeSetDigest?: string;
  quarantine?: MaintenanceShadowQuarantineRecord;
  writeFence?:
    | (MaintenanceShadowWriteFenceProof & {
        enforcement: "runtime-sentinel";
        verifiedAt: string;
      })
    | (MaintenanceShadowTransportConfigReceipt & {
        enforcement: "transport-config";
        verifiedAt: string;
      });
  digest: string;
}

interface InspectedFile {
  sha256: string;
  size: number;
  mode: number;
  dev: number;
  ino: number;
  nlink: number;
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

type MaintenanceApplyJournalState = "prepared" | "applying" | "committed" | "rolling-back" | "rolled-back" | "blocked";

interface MaintenanceApplyJournalEntry {
  change: MaintenanceShadowChange;
  baselineBlobRelativePath?: string;
  displacedLiveRelativePath?: string;
  installTempRelativePath?: string;
}

interface MaintenanceApplyJournalMetadataSuccessorInstallWindow {
  relativePath: string;
  createdAt: string;
  window: MaintenanceMarkdownUpdatedSuccessorWindow;
}

interface MaintenanceApplyJournal {
  version: 1;
  state: MaintenanceApplyJournalState;
  attemptId: string;
  liveVaultFingerprint: string;
  changeSetDigest: string;
  selectionDigest: string;
  selectedPaths: string[];
  entries: MaintenanceApplyJournalEntry[];
  createdDirectories: Array<{
    relativePath: string;
    dev: number;
    ino: number;
  }>;
  metadataSuccessorPolicy?: MaintenanceShadowMetadataSuccessorPolicy;
  metadataSuccessorInstallWindows?:
    MaintenanceApplyJournalMetadataSuccessorInstallWindow[];
  metadataSuccessors?: MaintenanceShadowMetadataSuccessorProof[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  digest: string;
}

interface MaintenanceApplyLock {
  version: 1;
  pid: number;
  attemptId: string;
  journalPath: string;
  createdAt: string;
}

/**
 * Creates a byte-for-byte per-attempt Vault mirror. No links or special files
 * are accepted, and explicitly required paths must exist. The returned Agent
 * path is a child directory; durable CAS metadata lives beside it.
 */
export async function createMaintenanceShadowVault(
  options: CreateMaintenanceShadowOptions
): Promise<MaintenanceShadowHandle> {
  const attemptId = assertAttemptId(options.attemptId);
  const liveVaultPath = await assertPlainDirectoryRoot(options.liveVaultPath, "真实 Vault");
  const liveRootStat = await fsp.lstat(liveVaultPath);
  const liveRootIdentity = {
    dev: Number(liveRootStat.dev),
    ino: Number(liveRootStat.ino)
  };
  const rawPaths = normalizePathList(options.rawPaths ?? DEFAULT_MAINTENANCE_SHADOW_RAW_PATHS);
  const rulesPaths = normalizePathList(options.rulesPaths ?? DEFAULT_MAINTENANCE_SHADOW_RULES_PATHS);
  const requiredSourcePaths = normalizePathList(options.requiredSourcePaths ?? []);
  const copiedPaths = normalizePathList(options.copiedPaths ?? DEFAULT_MAINTENANCE_SHADOW_COPIED_PATHS);
  const writablePaths = normalizePathList(options.writablePaths ?? DEFAULT_MAINTENANCE_SHADOW_WRITABLE_PATHS);
  const chunkedTextSources = normalizeChunkedTextSources(
    options.chunkedTextSources ?? []
  );
  const limits = normalizeShadowLimits(options.limits);

  const requiredPaths = uniqueSortedPaths([...rawPaths, ...rulesPaths, ...requiredSourcePaths]);
  for (const source of chunkedTextSources) {
    if (!requiredSourcePaths.includes(source.relativePath)) {
      throw new MaintenanceShadowError(
        "invalid_path",
        `分块来源必须同时是 required source：${source.relativePath}`,
        source.relativePath
      );
    }
  }
  for (const relativePath of requiredPaths) {
    await inspectRequiredEntry(liveVaultPath, relativePath);
  }

  const copiedRoots = minimalPathRoots(uniqueSortedPaths([
    ...requiredPaths,
    ...copiedPaths,
    ...writablePaths
  ]));
  const requestedStorageRoot = path.resolve(options.storageRootPath);
  assertSafeStorageLocation(liveVaultPath, requestedStorageRoot, copiedRoots);
  const storageRootPath = await ensurePlainStorageRoot(requestedStorageRoot);
  assertSafeStorageLocation(liveVaultPath, storageRootPath, copiedRoots);
  const rootPath = await fsp.mkdtemp(
    path.join(storageRootPath, `echoink-maintenance-${attemptFilesystemToken(attemptId)}-`)
  );
  const shadowVaultPath = path.join(rootPath, SHADOW_VAULT_DIRECTORY);
  const manifestPath = path.join(rootPath, MANIFEST_FILE);
  await fsp.mkdir(shadowVaultPath, { mode: 0o700 });

  try {
    const liveBaseline = new Map<string, MaintenanceShadowEntry>();
    for (const relativeRoot of copiedRoots) {
      const sourcePath = resolveVaultRelativePath(liveVaultPath, relativeRoot);
      const sourceStat = await lstatOrNull(sourcePath);
      if (!sourceStat) {
        if (isWithinAnyPath(relativeRoot, requiredPaths)) {
          throw new MaintenanceShadowError(
            "required_path_missing",
            `Shadow 必需来源不存在：${relativeRoot}`,
            relativeRoot
          );
        }
        await fsp.mkdir(resolveVaultRelativePath(shadowVaultPath, relativeRoot), { recursive: true, mode: 0o755 });
        continue;
      }
      await copySafeEntryTree(liveVaultPath, shadowVaultPath, relativeRoot, liveBaseline);
    }
    for (const writablePath of writablePaths) {
      await fsp.mkdir(resolveVaultRelativePath(shadowVaultPath, writablePath), {
        recursive: true,
        mode: 0o755
      });
    }

    const sourceChunks = await materializeShadowSourceChunks(
      shadowVaultPath,
      chunkedTextSources
    );
    await makePathsReadOnly(
      shadowVaultPath,
      uniqueSortedPaths([...rawPaths, ...rulesPaths, ...MAINTENANCE_PLUGIN_OWNED_PATHS])
    );
    const shadowBaseline = await scanEntireVault(shadowVaultPath);
    const verifiedLiveBaseline = await scanSafeRoots(liveVaultPath, copiedRoots);
    assertEntryMapsEqual(liveBaseline, verifiedLiveBaseline, "source_changed", "创建 Shadow 时真实 Vault 已变化");

    const liveBaselineEntries = sortedEntries(liveBaseline);
    const shadowBaselineEntries = sortedEntries(shadowBaseline);
    const baselineDigest = digestJson(liveBaselineEntries);
    const shadowBaselineDigest = digestJson(shadowBaselineEntries);
    const createdAt = new Date().toISOString();
    const manifestBase: Omit<MaintenanceShadowManifest, "digest"> = {
      version: MANIFEST_VERSION,
      attemptId,
      state: "active",
      liveVaultFingerprint: vaultFingerprint(liveVaultPath),
      storageRootPath,
      rootPath,
      shadowVaultPath,
      rawPaths,
      rulesPaths,
      requiredSourcePaths,
      writablePaths,
      limits,
      copiedRoots,
      liveRootIdentity,
      liveBaseline: liveBaselineEntries,
      shadowBaseline: shadowBaselineEntries,
      baselineDigest,
      shadowBaselineDigest,
      createdAt
    };
    await writeManifest(manifestPath, withManifestDigest(manifestBase));

    return {
      attemptId,
      rootPath,
      agentVaultPath: shadowVaultPath,
      manifestPath,
      ...(sourceChunks.length ? { sourceChunks } : {})
    };
  } catch (error) {
    await makeTreeOwnerWritable(rootPath);
    await fsp.rm(rootPath, { recursive: true, force: true });
    throw error;
  }
}

export async function maintenanceShadowExecutionBoundary(
  handle: MaintenanceShadowHandle
): Promise<MaintenanceShadowExecutionBoundary> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["active"]);
  const writableRootPaths = manifest.writablePaths.map((relativePath) =>
    resolveVaultRelativePath(manifest.shadowVaultPath, relativePath)
  );
  const deniedPaths = uniqueSortedPaths([
    ...manifest.rawPaths,
    ...manifest.rulesPaths,
    ...MAINTENANCE_PLUGIN_OWNED_PATHS
  ]).map((relativePath) => resolveVaultRelativePath(manifest.shadowVaultPath, relativePath));
  return {
    agentVaultPath: manifest.shadowVaultPath,
    writableRootPaths,
    deniedPaths,
    deniedParentPath: manifest.rootPath,
    deniedLiveVaultFingerprint: manifest.liveVaultFingerprint
  };
}

/**
 * Builds the typed receipt that a trusted Adapter/runtime returns only after
 * the transport has acknowledged its exact filesystem policy. This factory
 * canonicalizes and digests the receipt; it does not itself configure a
 * sandbox, so callers must never invoke it before the transport ACK exists.
 */
export function createMaintenanceShadowTransportConfigReceipt(
  input: CreateMaintenanceShadowTransportConfigReceiptInput
): MaintenanceShadowTransportConfigReceipt {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const base: Omit<MaintenanceShadowTransportConfigReceipt, "digest"> = {
    version: 1,
    backend: input.backend.trim(),
    attemptId: assertAttemptId(input.attemptId),
    leaseId: input.leaseId.trim(),
    enforcedWritableRootPaths: canonicalAbsolutePaths(input.enforcedWritableRootPaths),
    enforcedDeniedShadowPaths: canonicalAbsolutePaths(input.enforcedDeniedShadowPaths),
    deniedLiveVaultPath: path.resolve(input.deniedLiveVaultPath),
    deniedControlPath: path.resolve(input.deniedControlPath),
    transportAck: input.transportAck.trim(),
    transportConfigDigest: input.transportConfigDigest,
    issuedAt
  };
  const receipt: MaintenanceShadowTransportConfigReceipt = {
    ...base,
    digest: digestJson(base)
  };
  assertValidTransportConfigReceipt(receipt);
  issuedTransportConfigReceipts.add(receipt);
  return receipt;
}

/**
 * Production fence confirmation. Unlike the runtime-sentinel compatibility
 * path below, this consumes an Adapter/runtime receipt created before the
 * prompt and binds its transport lease and exact path policy to the attempt.
 */
export async function confirmMaintenanceShadowTransportConfigFence(
  handle: MaintenanceShadowHandle,
  liveVaultPathInput: string,
  receipt: MaintenanceShadowTransportConfigReceipt
): Promise<void> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["active"]);
  if (manifest.writeFence) {
    throw new MaintenanceShadowError("invalid_state", "当前 attempt 已绑定 write-fence，不允许替换 lease");
  }
  const liveVaultPath = await assertPlainDirectoryRoot(liveVaultPathInput, "真实 Vault");
  if (vaultFingerprint(liveVaultPath) !== manifest.liveVaultFingerprint) {
    throw new MaintenanceShadowError("cas_conflict", "transport fence 使用了错误的真实 Vault");
  }
  if (!issuedTransportConfigReceipts.has(receipt)) {
    throw new MaintenanceShadowError(
      "invalid_state",
      "transport-config receipt 不是由 trusted Adapter/runtime issuer 在本进程签发"
    );
  }
  assertValidTransportConfigReceipt(receipt);
  const boundary = await maintenanceShadowExecutionBoundary(handle);
  const receiptLiveVaultPath = await assertPlainDirectoryRoot(
    receipt.deniedLiveVaultPath,
    "receipt denied live Vault"
  );
  const receiptControlPath = await assertPlainDirectoryRoot(
    receipt.deniedControlPath,
    "receipt denied control path"
  );
  if (
    receipt.attemptId !== manifest.attemptId
    || !stringArraysEqual(receipt.enforcedWritableRootPaths, canonicalAbsolutePaths(boundary.writableRootPaths))
    || !stringArraysEqual(receipt.enforcedDeniedShadowPaths, canonicalAbsolutePaths(boundary.deniedPaths))
    || receiptLiveVaultPath !== liveVaultPath
    || receiptControlPath !== path.resolve(manifest.rootPath)
  ) {
    throw new MaintenanceShadowError(
      "invalid_state",
      "transport-config receipt 与当前 attempt 或 Shadow 路径边界不一致"
    );
  }
  await writeManifest(handle.manifestPath, withManifestDigest({
    ...withoutManifestDigest(manifest),
    writeFence: {
      ...receipt,
      enforcement: "transport-config",
      verifiedAt: new Date().toISOString()
    }
  }));
}

/**
 * Records the backend's verified OS-level write fence. A cwd or prompt claim
 * is deliberately insufficient: the backend must deny writes to the live Vault
 * and expose only the Shadow as writable before the Agent starts.
 */
export async function confirmMaintenanceShadowWriteFence(
  handle: MaintenanceShadowHandle,
  liveVaultPathInput: string,
  verifyWithBackend: (
    challenge: MaintenanceShadowWriteFenceChallenge
  ) => Promise<MaintenanceShadowWriteFenceProof>
): Promise<void> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["active"]);
  if (manifest.writeFence) {
    throw new MaintenanceShadowError("invalid_state", "当前 attempt 已绑定 write-fence，不允许替换 lease");
  }
  const liveVaultPath = await assertPlainDirectoryRoot(liveVaultPathInput, "真实 Vault");
  if (vaultFingerprint(liveVaultPath) !== manifest.liveVaultFingerprint) {
    throw new MaintenanceShadowError("cas_conflict", "write-fence 验证使用了错误的真实 Vault");
  }

  const boundary = await maintenanceShadowExecutionBoundary(handle);
  if (!boundary.writableRootPaths.length) {
    throw new MaintenanceShadowError("invalid_state", "write-fence 缺少可写根");
  }
  const challengeId = randomUUID();
  const token = `echoink-shadow-fence:${challengeId}`;
  const shadowBaseline = entryMap(manifest.shadowBaseline);
  const deniedWriteProbePaths = boundary.deniedPaths.map((deniedPath) => {
    const relativePath = normalizeVaultRelativePath(
      path.relative(manifest.shadowVaultPath, deniedPath).split(path.sep).join("/")
    );
    return shadowBaseline.get(relativePath)?.kind === "directory"
      ? path.join(deniedPath, `.echoink-denied-fence-${challengeId}.probe`)
      : deniedPath;
  });
  const challenge: MaintenanceShadowWriteFenceChallenge = {
    token,
    writableShadowProbePath: path.join(boundary.writableRootPaths[0]!, `.echoink-shadow-fence-${challengeId}.probe`),
    deniedLiveProbePath: path.join(liveVaultPath, `.echoink-live-fence-${challengeId}.probe`),
    deniedControlProbePath: path.join(manifest.rootPath, `.echoink-control-fence-${challengeId}.probe`),
    deniedWriteProbePaths
  };
  for (const probePath of [
    challenge.writableShadowProbePath,
    challenge.deniedLiveProbePath,
    challenge.deniedControlProbePath
  ]) {
    if (await lstatOrNull(probePath)) {
      throw new MaintenanceShadowError("unsafe_entry", `write-fence probe 已存在：${probePath}`);
    }
  }

  let proof!: MaintenanceShadowWriteFenceProof;
  try {
    proof = await verifyWithBackend(challenge);
    const shadowProbe = await readSafeProbe(challenge.writableShadowProbePath);
    const liveProbe = await lstatOrNull(challenge.deniedLiveProbePath);
    const controlProbe = await lstatOrNull(challenge.deniedControlProbePath);
    if (shadowProbe !== token || liveProbe || controlProbe) {
      throw new MaintenanceShadowError(
        "invalid_state",
        "runtime sentinel 未证明 only-shadow-write / deny-live / deny-parent"
      );
    }
    if (
      !proof.backend.trim()
      || !proof.evidence.trim()
      || !proof.opaqueReceipt.trim()
      || !stringArraysEqual(
        canonicalAbsolutePaths(proof.enforcedWritableRootPaths),
        canonicalAbsolutePaths(boundary.writableRootPaths)
      )
      || !stringArraysEqual(
        canonicalAbsolutePaths(proof.enforcedDeniedPaths),
        canonicalAbsolutePaths(boundary.deniedPaths)
      )
      || !deniedProbeAttemptsMatch(proof.deniedProbeAttempts, challenge.deniedWriteProbePaths)
    ) {
      throw new MaintenanceShadowError("invalid_state", "backend 未返回有效的 opaque write-fence receipt");
    }
    await cleanupFenceProbe(challenge.writableShadowProbePath, token);
    const afterDeniedProbeAttempts = await scanEntireVault(manifest.shadowVaultPath);
    assertEntryMapsEqual(
      shadowBaseline,
      afterDeniedProbeAttempts,
      "source_changed",
      "backend 声称拒写，但 denied probe 实际改变了 Shadow"
    );
  } finally {
    await cleanupFenceProbe(challenge.writableShadowProbePath, token);
    await cleanupFenceProbe(challenge.deniedLiveProbePath, token);
    await cleanupFenceProbe(challenge.deniedControlProbePath, token);
    for (const deniedProbePath of challenge.deniedWriteProbePaths) {
      await cleanupNewDeniedProbe(deniedProbePath, manifest.shadowVaultPath, shadowBaseline);
    }
  }
  const afterFence = await scanEntireVault(manifest.shadowVaultPath);
  assertEntryMapsEqual(shadowBaseline, afterFence, "source_changed", "write-fence probe 改变了 Shadow", false);
  await writeManifest(handle.manifestPath, withManifestDigest({
    ...withoutManifestDigest(manifest),
    writeFence: {
      backend: proof.backend.trim(),
      evidence: proof.evidence.trim(),
      opaqueReceipt: proof.opaqueReceipt.trim(),
      enforcedWritableRootPaths: canonicalAbsolutePaths(proof.enforcedWritableRootPaths),
      enforcedDeniedPaths: canonicalAbsolutePaths(proof.enforcedDeniedPaths),
      deniedProbeAttempts: proof.deniedProbeAttempts,
      enforcement: "runtime-sentinel",
      verifiedAt: new Date().toISOString()
    }
  }));
}

/**
 * Freezes an active Shadow, verifies that protected inputs did not change, and
 * produces a file-level changeset. Directory-only changes are intentionally
 * omitted; parent directories are created safely during apply.
 */
export async function sealMaintenanceShadowVault(
  handle: MaintenanceShadowHandle
): Promise<MaintenanceShadowChangeSet> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["active"]);
  if (!manifest.writeFence) {
    throw new MaintenanceShadowError(
      "invalid_state",
      "不能 seal 未验证 OS write-deny fence 的 Shadow"
    );
  }

  const shadowBaseline = entryMap(manifest.shadowBaseline);
  await assertProtectedShadowRootMetadataUnchanged(manifest, shadowBaseline);
  const beforeFreeze = await scanEntireVault(manifest.shadowVaultPath);
  const changedPathsWithMode = changedEntryPaths(shadowBaseline, beforeFreeze, true);

  for (const relativePath of changedPathsWithMode) {
    if (isWithinAnyPath(relativePath, manifest.rawPaths)) {
      throw new MaintenanceShadowError("raw_modified", `Agent 修改了 Raw：${relativePath}`, relativePath);
    }
    if (isWithinAnyPath(relativePath, manifest.rulesPaths)) {
      throw new MaintenanceShadowError("readonly_modified", `Agent 修改了知识库规则：${relativePath}`, relativePath);
    }
    if (isPluginOwnedMaintenancePath(relativePath)) {
      throw new MaintenanceShadowError("readonly_modified", `Agent 修改了 plugin-owned 路径：${relativePath}`, relativePath);
    }
    if (!isWithinAnyPath(relativePath, manifest.writablePaths)) {
      throw new MaintenanceShadowError(
        "write_outside_allowed_paths",
        `Agent 修改了 Shadow 非可写路径：${relativePath}`,
        relativePath
      );
    }
  }

  // Seal is a real write barrier, not just a logical state transition. A
  // timed-out Agent may still hold the old Shadow cwd; make the entire mirror
  // read-only before copying any candidate blobs, then prove that applying the
  // barrier did not race with a late write.
  await freezeTree(manifest.shadowVaultPath);
  const afterFreeze = await scanEntireVault(manifest.shadowVaultPath);
  assertEntryMapsEqual(beforeFreeze, afterFreeze, "source_changed", "freeze 期间 Shadow 内容发生变化", false);
  assertNoKnowledgeConflictDuplicates(afterFreeze);

  const changedPaths = changedEntryPaths(shadowBaseline, beforeFreeze, false);
  const excludedPluginOwnedPaths = changedPaths
    .filter(isPluginOwnedMaintenancePath)
    .sort(compareCanonicalText);
  const committableChangedPaths = changedPaths.filter((relativePath) => !isPluginOwnedMaintenancePath(relativePath));
  const liveBaseline = entryMap(manifest.liveBaseline);
  const changes = buildChanges(
    shadowBaseline,
    beforeFreeze,
    liveBaseline,
    manifest.liveRootIdentity,
    committableChangedPaths
  );
  assertChangesWithinLimits(changes, manifest.limits);

  const sealedBlobRootPath = path.join(manifest.rootPath, SEALED_BLOB_DIRECTORY);
  await fsp.mkdir(sealedBlobRootPath, { mode: 0o700 });
  for (const change of changes) {
    if (change.operation !== "upsert") continue;
    const sourcePath = resolveVaultRelativePath(manifest.shadowVaultPath, change.relativePath);
    const blobPath = resolveVaultRelativePath(sealedBlobRootPath, change.blobRelativePath);
    if (!await lstatOrNull(blobPath)) {
      await copyFileWithExpectedContent(sourcePath, blobPath, change.shadowSha256, change.size);
      await fsp.chmod(blobPath, 0o400);
    }
  }

  const afterSeal = await scanEntireVault(manifest.shadowVaultPath);
  assertEntryMapsEqual(beforeFreeze, afterSeal, "source_changed", "seal 期间 Shadow 内容发生变化", false);

  const changesetBase: Omit<MaintenanceShadowChangeSet, "digest"> = {
    version: CHANGESET_VERSION,
    attemptId: manifest.attemptId,
    liveVaultFingerprint: manifest.liveVaultFingerprint,
    baselineDigest: manifest.baselineDigest,
    shadowVaultPath: manifest.shadowVaultPath,
    controlRootPath: manifest.rootPath,
    sealedBlobRootPath,
    createdAt: new Date().toISOString(),
    changes,
    excludedPluginOwnedPaths,
    structuralResult: changes.length
      ? "committable"
      : excludedPluginOwnedPaths.length
        ? "plugin-owned-only"
        : "zero-result"
  };
  const changeset: MaintenanceShadowChangeSet = {
    ...changesetBase,
    digest: digestJson(changesetBase)
  };
  await writeJsonAtomic(path.join(manifest.rootPath, CHANGESET_FILE), changeset);
  await writeManifest(handle.manifestPath, withManifestDigest({
    ...withoutManifestDigest(manifest),
    state: "sealed",
    sealedAt: new Date().toISOString(),
    sealedChangeSetDigest: changeset.digest
  }));
  return changeset;
}

export async function loadMaintenanceShadowChangeSet(
  handle: MaintenanceShadowHandle
): Promise<MaintenanceShadowChangeSet> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["sealed", "committed", "discarded", "noop"]);
  return await readStoredChangeSet(manifest);
}

async function readStoredChangeSet(
  manifest: MaintenanceShadowManifest
): Promise<MaintenanceShadowChangeSet> {
  const changeSetPath = path.join(manifest.rootPath, CHANGESET_FILE);
  const parsed = JSON.parse(
    (await readIndependentRegularFile(changeSetPath, "Shadow changeset", MAX_CONTROL_JSON_BYTES)).toString("utf8")
  ) as MaintenanceShadowChangeSet;
  assertValidChangeSet(parsed);
  if (parsed.digest !== manifest.sealedChangeSetDigest) {
    throw new MaintenanceShadowError("changeset_corrupt", "Shadow changeset 与 manifest 不一致");
  }
  return parsed;
}

/**
 * Issues the Shadow half of the post-start failover gate. This attests only
 * filesystem/transaction facts; the orchestrator must still combine it with
 * same-attempt business evidence and a retryable infrastructure classification.
 * A fenced but still-uncertain native process keeps its abandoned Shadow; this
 * attestation never authorizes cleanup or turns cancellation/policy rejection
 * into a failover.
 */
export async function attestMaintenanceShadowZeroResult(
  handle: MaintenanceShadowHandle,
  liveVaultPathInput: string,
  options: MaintenanceShadowZeroResultAttestationOptions = {}
): Promise<MaintenanceShadowZeroResultAttestation> {
  const evidence = await verifyZeroResultFacts(handle, liveVaultPathInput, options);
  const issuedAt = new Date().toISOString();
  const digest = digestJson({ ...evidence, issuedAt });
  const attestation = Object.freeze(new MaintenanceShadowZeroResultAttestation(
    ZERO_RESULT_ATTESTATION_TOKEN,
    evidence.attemptId,
    evidence.manifestDigest,
    evidence.changeSetDigest,
    evidence.liveVaultFingerprint,
    issuedAt,
    digest
  ));
  issuedZeroResultAttestations.add(attestation);
  return attestation;
}

export async function assertMaintenanceShadowZeroResultAttestation(
  handle: MaintenanceShadowHandle,
  liveVaultPathInput: string,
  attestation: MaintenanceShadowZeroResultAttestation,
  options: MaintenanceShadowZeroResultAttestationOptions = {}
): Promise<void> {
  if (!isTrustedMaintenanceShadowZeroResultAttestation(attestation)) {
    throw new MaintenanceShadowError("invalid_state", "zero-result attestation 不是本进程签发");
  }
  const evidence = await verifyZeroResultFacts(handle, liveVaultPathInput, options);
  const expectedDigest = digestJson({ ...evidence, issuedAt: attestation.issuedAt });
  if (
    attestation.attemptId !== evidence.attemptId
    || attestation.manifestDigest !== evidence.manifestDigest
    || attestation.changeSetDigest !== evidence.changeSetDigest
    || attestation.liveVaultFingerprint !== evidence.liveVaultFingerprint
    || attestation.digest !== expectedDigest
  ) {
    throw new MaintenanceShadowError("invalid_state", "zero-result attestation 已过期或不匹配");
  }
}

async function verifyZeroResultFacts(
  handle: MaintenanceShadowHandle,
  liveVaultPathInput: string,
  options: MaintenanceShadowZeroResultAttestationOptions
): Promise<{
  attemptId: string;
  manifestDigest: string;
  changeSetDigest: string;
  liveVaultFingerprint: string;
}> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["sealed"]);
  const liveVaultPath = await assertPlainDirectoryRoot(liveVaultPathInput, "真实 Vault");
  if (vaultFingerprint(liveVaultPath) !== manifest.liveVaultFingerprint) {
    throw new MaintenanceShadowError("cas_conflict", "zero-result 使用了错误的真实 Vault");
  }
  if (!manifest.writeFence) {
    throw new MaintenanceShadowError("invalid_state", "zero-result 缺少 write-fence");
  }
  if (
    manifest.writeFence.enforcement !== "transport-config"
    && !options.allowRuntimeSentinelForTests
  ) {
    throw new MaintenanceShadowError(
      "invalid_state",
      "生产 zero-result attestation 必须绑定 prompt 前 transport-config receipt"
    );
  }
  if (manifest.writeFence.enforcement === "transport-config") {
    assertValidTransportConfigReceipt(manifest.writeFence);
    const expectedWritableRoots = canonicalAbsolutePaths(manifest.writablePaths.map((relativePath) =>
      resolveVaultRelativePath(manifest.shadowVaultPath, relativePath)
    ));
    const expectedDeniedShadowPaths = canonicalAbsolutePaths(uniqueSortedPaths([
      ...manifest.rawPaths,
      ...manifest.rulesPaths,
      ...MAINTENANCE_PLUGIN_OWNED_PATHS
    ]).map((relativePath) => resolveVaultRelativePath(manifest.shadowVaultPath, relativePath)));
    const receiptLiveVaultPath = await assertPlainDirectoryRoot(
      manifest.writeFence.deniedLiveVaultPath,
      "receipt denied live Vault"
    );
    const receiptControlPath = await assertPlainDirectoryRoot(
      manifest.writeFence.deniedControlPath,
      "receipt denied control path"
    );
    if (
      manifest.writeFence.attemptId !== manifest.attemptId
      || !stringArraysEqual(manifest.writeFence.enforcedWritableRootPaths, expectedWritableRoots)
      || !stringArraysEqual(manifest.writeFence.enforcedDeniedShadowPaths, expectedDeniedShadowPaths)
      || receiptLiveVaultPath !== liveVaultPath
      || receiptControlPath !== path.resolve(manifest.rootPath)
    ) {
      throw new MaintenanceShadowError("invalid_state", "transport-config receipt attempt/path 绑定失效");
    }
  }
  const changeSet = await readStoredChangeSet(manifest);
  if (
    changeSet.structuralResult !== "zero-result"
    || changeSet.changes.length
    || changeSet.excludedPluginOwnedPaths.length
  ) {
    throw new MaintenanceShadowError("invalid_state", "Shadow 仍有 committable/recoverable 结果，禁止 failover");
  }
  if (await readApplyJournalOrNull(path.join(manifest.rootPath, APPLY_JOURNAL_DIRECTORY, "journal.json"))) {
    throw new MaintenanceShadowError("invalid_state", "Shadow 已存在 commit intent，禁止 zero-result failover");
  }
  const sealedBlobEntries = await fsp.readdir(changeSet.sealedBlobRootPath);
  if (sealedBlobEntries.length) {
    throw new MaintenanceShadowError("invalid_state", "zero-result Shadow 仍含 sealed blobs");
  }
  const currentShadow = await scanEntireVault(manifest.shadowVaultPath);
  assertEntryMapsEqual(
    entryMap(manifest.shadowBaseline),
    currentShadow,
    "source_changed",
    "zero-result seal 后 Shadow 又出现可恢复变化",
    false
  );
  const currentLive = await scanSafeRoots(liveVaultPath, manifest.copiedRoots);
  assertEntryMapsEqual(
    entryMap(manifest.liveBaseline),
    currentLive,
    "cas_conflict",
    "zero-result 期间真实 Vault 已变化"
  );
  return {
    attemptId: manifest.attemptId,
    manifestDigest: manifest.digest,
    changeSetDigest: changeSet.digest,
    liveVaultFingerprint: manifest.liveVaultFingerprint
  };
}

/**
 * Permanently revokes this attempt's apply/cleanup authority before routing may
 * start a fallback Agent. The transition shares the per-Vault apply lock, so
 * apply and quarantine cannot both observe `sealed` as their commit authority.
 */
export async function quarantineMaintenanceShadowZeroResult(
  handle: MaintenanceShadowHandle,
  liveVaultPathInput: string,
  input: {
    writeFenceReceipt: AgentExactWriteFenceReceipt;
    zeroResultAttestation: MaintenanceShadowZeroResultAttestation;
    reason: string;
  }
): Promise<MaintenanceShadowQuarantineReceipt> {
  if (!isTrustedExactWriteFenceReceipt(input.writeFenceReceipt)) {
    throw new MaintenanceShadowError("invalid_state", "quarantine 需要 trusted exact write-fence receipt");
  }
  if (!isTrustedMaintenanceShadowZeroResultAttestation(input.zeroResultAttestation)) {
    throw new MaintenanceShadowError("invalid_state", "quarantine 需要 trusted zero-result attestation");
  }

  const liveVaultPath = await assertPlainDirectoryRoot(liveVaultPathInput, "真实 Vault");
  const initialManifest = await readManifest(handle);
  assertManifestState(initialManifest, ["sealed"]);
  if (vaultFingerprint(liveVaultPath) !== initialManifest.liveVaultFingerprint) {
    throw new MaintenanceShadowError("cas_conflict", "quarantine 使用了错误的真实 Vault");
  }
  const storageRootPath = path.resolve(initialManifest.storageRootPath);
  const journalPath = path.join(initialManifest.rootPath, APPLY_JOURNAL_DIRECTORY, "journal.json");
  const lockPath = path.join(
    storageRootPath,
    `.echoink-maintenance-${initialManifest.liveVaultFingerprint.slice("sha256:".length)}.lock`
  );
  const lock = await acquireMaintenanceApplyLock(lockPath, {
    version: 1,
    pid: process.pid,
    attemptId: initialManifest.attemptId,
    journalPath,
    createdAt: new Date().toISOString()
  });

  try {
    await recoverPendingApplyJournals(
      liveVaultPath,
      storageRootPath,
      initialManifest.liveVaultFingerprint
    );
    await assertMaintenanceShadowZeroResultAttestation(
      handle,
      liveVaultPath,
      input.zeroResultAttestation
    );

    const sealedManifest = await readManifest(handle);
    assertManifestState(sealedManifest, ["sealed"]);
    if (
      sealedManifest.digest !== input.zeroResultAttestation.manifestDigest
      || sealedManifest.sealedChangeSetDigest !== input.zeroResultAttestation.changeSetDigest
      || sealedManifest.attemptId !== input.writeFenceReceipt.attemptToken
      || input.zeroResultAttestation.attemptId !== sealedManifest.attemptId
    ) {
      throw new MaintenanceShadowError(
        "invalid_state",
        "quarantine receipts 与当前 sealed attempt/digest 不一致"
      );
    }
    if (await readApplyJournalOrNull(journalPath)) {
      throw new MaintenanceShadowError("invalid_state", "Shadow 已存在 apply journal，禁止 quarantine");
    }

    const changeSet = await readStoredChangeSet(sealedManifest);
    if (
      changeSet.structuralResult !== "zero-result"
      || changeSet.digest !== input.zeroResultAttestation.changeSetDigest
    ) {
      throw new MaintenanceShadowError("invalid_state", "quarantine 只接受 durable zero-result changeset");
    }
    await assertExactFenceBindsSealedShadow(
      sealedManifest,
      liveVaultPath,
      input.writeFenceReceipt
    );

    const quarantinedAt = new Date().toISOString();
    const quarantineBase: Omit<MaintenanceShadowQuarantineRecord, "digest"> = {
      version: 1,
      attemptId: sealedManifest.attemptId,
      backend: input.writeFenceReceipt.backend,
      leaseToken: input.writeFenceReceipt.leaseToken,
      writeFenceConfigAckDigest: input.writeFenceReceipt.configAckDigest,
      exactWriteFenceBindingDigest: exactWriteFenceBindingDigest(input.writeFenceReceipt),
      sealedManifestDigest: sealedManifest.digest,
      changeSetDigest: changeSet.digest,
      zeroResultDigest: input.zeroResultAttestation.digest,
      quarantinedAt,
      reason: boundedQuarantineReason(input.reason)
    };
    const quarantine: MaintenanceShadowQuarantineRecord = {
      ...quarantineBase,
      digest: digestJson(quarantineBase)
    };
    await writeManifest(handle.manifestPath, withManifestDigest({
      ...withoutManifestDigest(sealedManifest),
      state: "abandoned",
      abandonedAt: quarantinedAt,
      abandonReason: quarantine.reason,
      quarantine
    }));
    await syncDirectoryDurably(path.dirname(handle.manifestPath));

    // Issue the nominal receipt only after a fresh disk read proves the atomic
    // replacement persisted with the expected state and binding record.
    const abandonedManifest = await readManifest({ ...handle });
    if (
      abandonedManifest.state !== "abandoned"
      || abandonedManifest.quarantine?.digest !== quarantine.digest
      || abandonedManifest.quarantine.sealedManifestDigest !== sealedManifest.digest
      || abandonedManifest.sealedChangeSetDigest !== changeSet.digest
    ) {
      throw new MaintenanceShadowError("manifest_corrupt", "quarantine durable read-back 校验失败");
    }
    const receipt = Object.freeze(new MaintenanceShadowQuarantineReceipt(
      QUARANTINE_RECEIPT_TOKEN,
      sealedManifest.attemptId,
      input.writeFenceReceipt.backend,
      input.writeFenceReceipt.leaseToken,
      input.writeFenceReceipt.configAckDigest,
      quarantine.exactWriteFenceBindingDigest,
      sealedManifest.digest,
      abandonedManifest.digest,
      changeSet.digest,
      input.zeroResultAttestation.digest,
      quarantine.digest,
      quarantinedAt
    ));
    issuedQuarantineReceipts.add(receipt);
    return receipt;
  } finally {
    await lock.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Marks a still-running or uncertain Agent attempt as isolated. Its Shadow is
 * deliberately retained so late/zombie writes cannot reach the live Vault and
 * cannot be mistaken for a safe cleanup candidate.
 */
export async function abandonMaintenanceShadowVault(
  handle: MaintenanceShadowHandle,
  reason: string
): Promise<void> {
  const initialManifest = await readManifest(handle);
  assertManifestState(initialManifest, ["active", "sealed"]);
  const journalPath = path.join(initialManifest.rootPath, APPLY_JOURNAL_DIRECTORY, "journal.json");
  const lockPath = path.join(
    initialManifest.storageRootPath,
    `.echoink-maintenance-${initialManifest.liveVaultFingerprint.slice("sha256:".length)}.lock`
  );
  const lock = await acquireMaintenanceApplyLock(lockPath, {
    version: 1,
    pid: process.pid,
    attemptId: initialManifest.attemptId,
    journalPath,
    createdAt: new Date().toISOString()
  });
  try {
    const manifest = await readManifest(handle);
    assertManifestState(manifest, ["active", "sealed"]);
    if (await readApplyJournalOrNull(journalPath)) {
      throw new MaintenanceShadowError("invalid_state", "已有 apply journal，禁止并发 abandon");
    }
    await writeManifest(handle.manifestPath, withManifestDigest({
      ...withoutManifestDigest(manifest),
      state: "abandoned",
      abandonedAt: new Date().toISOString(),
      abandonReason: reason.trim() || "unspecified"
    }));
    await syncDirectoryDurably(path.dirname(handle.manifestPath));
    const readBack = await readManifest({ ...handle });
    if (readBack.state !== "abandoned") {
      throw new MaintenanceShadowError("manifest_corrupt", "abandon durable read-back 校验失败");
    }
  } finally {
    await lock.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Replay-safe committed transition. It derives authority from the durable
 * apply journal and current live target CAS, never from an in-memory receipt
 * returned by the process that performed apply.
 */
export async function markMaintenanceShadowCommittedFromJournal(
  handle: MaintenanceShadowHandle,
  liveVaultPathInput: string,
  options: {
    overriddenTargets?: readonly MaintenanceShadowCommittedTargetOverride[];
    ignoredTargetPaths?: readonly string[];
    acceptedIgnoredMetadataSuccessors?: readonly MaintenanceShadowMetadataSuccessorProof[];
  } = {}
): Promise<MaintenanceShadowCommittedVerification> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["sealed", "committed"]);
  const liveVaultPath = await assertPlainDirectoryRoot(
    liveVaultPathInput,
    "真实 Vault"
  );
  if (vaultFingerprint(liveVaultPath) !== manifest.liveVaultFingerprint) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      "committed terminal 使用了错误的真实 Vault"
    );
  }
  const journalPath = path.join(
    manifest.rootPath,
    APPLY_JOURNAL_DIRECTORY,
    "journal.json"
  );
  const changeSet = await readStoredChangeSet(manifest);
  let journal = await readApplyJournalOrNull(journalPath);
  if (journal) {
    assertApplyJournalMatches(journal, changeSet, journal.selectionDigest);
    if (journal.state !== "committed") {
      journal = await ensureApplyJournalMetadataSuccessorPolicy(
        journalPath,
        journal,
        changeSet
      );
    } else if (journal.metadataSuccessorPolicy) {
      journal = await refreshCommittedApplyJournalMetadataSuccessors(
        journalPath,
        journal,
        changeSet,
        liveVaultPath,
        new Set([
          ...(options.overriddenTargets ?? []).map((entry) =>
            normalizeVaultRelativePath(entry.relativePath)
          ),
          ...(options.ignoredTargetPaths ?? []).map(
            normalizeVaultRelativePath
          )
        ])
      );
    }
  }
  const verification = await assertCommittedApplyJournalMatchesLive(
    liveVaultPath,
    manifest,
    changeSet,
    journal,
    options.overriddenTargets ?? [],
    options.ignoredTargetPaths ?? [],
    options.acceptedIgnoredMetadataSuccessors ?? []
  );
  if (manifest.state === "committed") return verification;
  await writeManifest(handle.manifestPath, withManifestDigest({
    ...withoutManifestDigest(manifest),
    state: "committed",
    terminalAt: new Date().toISOString()
  }));
  await syncDirectoryDurably(path.dirname(handle.manifestPath));
  const readBack = await readManifest({ ...handle });
  if (readBack.state !== "committed") {
    throw new MaintenanceShadowError(
      "manifest_corrupt",
      "committed terminal durable read-back 校验失败"
    );
  }
  return verification;
}

async function refreshCommittedApplyJournalMetadataSuccessors(
  journalPath: string,
  journal: MaintenanceApplyJournal,
  changeSet: MaintenanceShadowChangeSet,
  liveVaultPath: string,
  excludedPaths: ReadonlySet<string>
): Promise<MaintenanceApplyJournal> {
  const context = applyJournalMetadataSuccessorContext(changeSet, journal);
  const existingByPath = new Map(
    (journal.metadataSuccessors ?? []).map((proof) => [
      normalizeVaultRelativePath(proof.relativePath),
      proof
    ])
  );
  const next: MaintenanceShadowMetadataSuccessorProof[] = [];
  for (const entry of journal.entries) {
    const relativePath = normalizeVaultRelativePath(
      entry.change.relativePath
    );
    const existing = existingByPath.get(relativePath);
    existingByPath.delete(relativePath);
    if (excludedPaths.has(relativePath)) {
      if (existing) next.push(existing);
      continue;
    }
    const live = await currentCas(liveVaultPath, relativePath);
    if (casBaselinesEqual(live, resultCas(entry.change))) {
      if (existing) {
        throw new MaintenanceShadowError(
          "cas_conflict",
          `committed metadata successor 不得回退到 sealed result：${relativePath}`,
          relativePath
        );
      }
      continue;
    }
    const successor = await shadowEntryMetadataSuccessorEvidence(
      liveVaultPath,
      entry,
      context
    );
    if (!successor) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `committed metadata successor 无法在固定窗口内重新证明：${relativePath}`,
        relativePath
      );
    }
    if (
      existing
      && (
        successor.updatedAt < existing.updatedAt
        || (
          successor.updatedAt === existing.updatedAt
          && stableStringify(successor) !== stableStringify(existing)
        )
      )
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `committed metadata successor proof 不得倒退或改写：${relativePath}`,
        relativePath
      );
    }
    next.push(successor);
  }
  next.push(...existingByPath.values());
  next.sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
  if (
    stableStringify(next)
    === stableStringify(journal.metadataSuccessors ?? [])
  ) return journal;
  return await persistCommittedApplyJournal(journalPath, journal, next);
}

async function assertCommittedApplyJournalMatchesLive(
  liveVaultPath: string,
  manifest: MaintenanceShadowManifest,
  changeSet: MaintenanceShadowChangeSet,
  journal: MaintenanceApplyJournal | null,
  overriddenTargets: readonly MaintenanceShadowCommittedTargetOverride[],
  ignoredTargetPaths: readonly string[],
  acceptedIgnoredMetadataSuccessors: readonly MaintenanceShadowMetadataSuccessorProof[]
): Promise<MaintenanceShadowCommittedVerification> {
  if (
    !journal
    || journal.state !== "committed"
    || journal.attemptId !== manifest.attemptId
    || journal.attemptId !== changeSet.attemptId
    || journal.liveVaultFingerprint !== manifest.liveVaultFingerprint
    || journal.liveVaultFingerprint !== changeSet.liveVaultFingerprint
    || journal.changeSetDigest !== manifest.sealedChangeSetDigest
    || journal.changeSetDigest !== changeSet.digest
    || !Array.isArray(journal.selectedPaths)
    || !Array.isArray(journal.entries)
    || journal.selectedPaths.length === 0
    || journal.entries.length !== journal.selectedPaths.length
  ) {
    throw new MaintenanceShadowError(
      "invalid_state",
      "committed terminal 缺少 matching durable apply journal"
    );
  }
  assertApplyJournalMatches(journal, changeSet, journal.selectionDigest);
  const selectedPaths = journal.selectedPaths.map(normalizeVaultRelativePath);
  if (
    new Set(selectedPaths).size !== selectedPaths.length
    || journal.selectionDigest !== digestJson(selectedPaths)
  ) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "committed apply journal selection 非法"
    );
  }
  const sealedByPath = new Map(
    changeSet.changes.map((change) => [change.relativePath, change])
  );
  const overridesByPath = new Map<string, MaintenanceShadowCommittedTargetOverride>();
  for (const override of overriddenTargets) {
    const relativePath = normalizeVaultRelativePath(override.relativePath);
    if (overridesByPath.has(relativePath)) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `committed terminal override 路径重复：${relativePath}`,
        relativePath
      );
    }
    overridesByPath.set(relativePath, {
      relativePath,
      expected: override.expected,
      desired: override.desired
    });
  }
  const ignoredPaths = new Set(
    ignoredTargetPaths.map(normalizeVaultRelativePath)
  );
  for (const relativePath of ignoredPaths) {
    if (overridesByPath.has(relativePath)) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `committed terminal target 不能同时 override 和 ignore：${relativePath}`,
        relativePath
      );
    }
  }
  const consumedOverrides = new Set<string>();
  const consumedIgnoredPaths = new Set<string>();
  const metadataProofsByPath = new Map(
    (journal.metadataSuccessors ?? []).map((proof) => [
      normalizeVaultRelativePath(proof.relativePath),
      proof
    ])
  );
  const consumedMetadataProofs = new Set<string>();
  const acceptedIgnoredProofsByPath = new Map<
    string,
    MaintenanceShadowMetadataSuccessorProof
  >();
  for (const proof of acceptedIgnoredMetadataSuccessors) {
    const relativePath = normalizeVaultRelativePath(proof.relativePath);
    if (acceptedIgnoredProofsByPath.has(relativePath)) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `committed ignored metadata successor proof 重复：${relativePath}`,
        relativePath
      );
    }
    acceptedIgnoredProofsByPath.set(relativePath, proof);
  }
  const consumedAcceptedIgnoredProofs = new Set<string>();
  const metadataSuccessor = journal.metadataSuccessorPolicy
    ? applyJournalMetadataSuccessorContext(changeSet, journal)
    : undefined;
  for (const [index, entry] of journal.entries.entries()) {
    const relativePath = normalizeVaultRelativePath(entry.change.relativePath);
    const sealed = sealedByPath.get(relativePath);
    if (
      relativePath !== selectedPaths[index]
      || !sealed
      || digestJson(entry.change) !== digestJson(sealed)
    ) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `committed apply journal entry 不属于 sealed changeset：${relativePath}`,
        relativePath
      );
    }
    const shadowResult = resultCas(sealed);
    const override = overridesByPath.get(relativePath);
    if (override && !casBaselinesEqual(override.expected, shadowResult)) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `committed terminal override 未绑定 Shadow result：${relativePath}`,
        relativePath
      );
    }
    if (override) consumedOverrides.add(relativePath);
    await assertJournalCreatedDirectoriesUnchanged(
      liveVaultPath,
      journal.createdDirectories,
      "Shadow committed verification"
    );
    await assertExpectedParentChainUnchanged(
      liveVaultPath,
      sealed,
      "Shadow committed verification"
    );
    if (ignoredPaths.has(relativePath)) {
      consumedIgnoredPaths.add(relativePath);
      const durableSuccessor = metadataProofsByPath.get(relativePath);
      if (durableSuccessor) {
        const accepted = acceptedIgnoredProofsByPath.get(relativePath);
        if (
          !accepted
          || stableStringify(accepted) !== stableStringify(durableSuccessor)
        ) {
          throw new MaintenanceShadowError(
            "cas_conflict",
            `committed ignored target 缺少下游 accepted successor proof：${relativePath}`,
            relativePath
          );
        }
        consumedAcceptedIgnoredProofs.add(relativePath);
        consumedMetadataProofs.add(relativePath);
      } else if (acceptedIgnoredProofsByPath.has(relativePath)) {
        throw new MaintenanceShadowError(
          "changeset_corrupt",
          `下游 accepted successor 不属于 Shadow proof：${relativePath}`,
          relativePath
        );
      }
      continue;
    }
    const live = await currentCas(liveVaultPath, relativePath);
    if (casBaselinesEqual(live, override?.desired ?? shadowResult)) {
      const durableSuccessor = metadataProofsByPath.get(relativePath);
      const acceptedSuccessor = acceptedIgnoredProofsByPath.get(relativePath);
      if (durableSuccessor) {
        if (
          !override
          || !acceptedSuccessor
          || stableStringify(acceptedSuccessor)
            !== stableStringify(durableSuccessor)
        ) {
          throw new MaintenanceShadowError(
            "cas_conflict",
            `managed override 缺少已接受的 Shadow metadata successor proof：${relativePath}`,
            relativePath
          );
        }
        consumedMetadataProofs.add(relativePath);
        consumedAcceptedIgnoredProofs.add(relativePath);
      } else if (acceptedSuccessor) {
        throw new MaintenanceShadowError(
          "changeset_corrupt",
          `下游 accepted successor 不属于 Shadow proof：${relativePath}`,
          relativePath
        );
      }
      continue;
    }
    const successor = override || !metadataSuccessor
      ? null
      : await shadowEntryMetadataSuccessorEvidence(
        liveVaultPath,
        entry,
        metadataSuccessor
      );
    const durableSuccessor = metadataProofsByPath.get(relativePath);
    if (
      !successor
      || !durableSuccessor
      || stableStringify(successor) !== stableStringify(durableSuccessor)
    ) {
      throw new MaintenanceShadowError(
        "cas_conflict",
        `committed terminal live target 已变化：${relativePath}`,
        relativePath
      );
    }
    consumedMetadataProofs.add(relativePath);
  }
  if (consumedOverrides.size !== overridesByPath.size) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "committed terminal override 不属于 selected Shadow journal"
    );
  }
  if (consumedIgnoredPaths.size !== ignoredPaths.size) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "committed terminal ignored target 不属于 selected Shadow journal"
    );
  }
  if (consumedMetadataProofs.size !== metadataProofsByPath.size) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "committed metadata successor proof 不属于已验证 live target"
    );
  }
  if (
    consumedAcceptedIgnoredProofs.size
    !== acceptedIgnoredProofsByPath.size
  ) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      "下游 accepted successor proof 不属于 ignored Shadow target"
    );
  }
  return {
    metadataSuccessors: [...(journal.metadataSuccessors ?? [])]
      .sort((left, right) => compareCanonicalText(
        left.relativePath,
        right.relativePath
      ))
  };
}

/**
 * Moves a sealed attempt to a cleanup-safe terminal state. An abandoned attempt
 * can only be released after the caller confirms the native Agent is fenced.
 */
export async function markMaintenanceShadowTerminal(
  handle: MaintenanceShadowHandle,
  outcome: MaintenanceShadowTerminalOutcome,
  options: { abandonedAgentFenced?: boolean; commitReceipt?: string } = {}
): Promise<void> {
  const manifest = await readManifest(handle);
  if (manifest.state === "abandoned" && manifest.quarantine) {
    throw new MaintenanceShadowError(
      "invalid_state",
      "quarantined Shadow 已永久撤销 cleanup authority，必须保留供隔离审计"
    );
  }
  if (manifest.state === "abandoned" && !options.abandonedAgentFenced) {
    throw new MaintenanceShadowError(
      "invalid_state",
      "abandoned Shadow 仍需保留；确认 Agent 已被隔离后才能进入安全终态"
    );
  }
  assertManifestState(manifest, manifest.state === "abandoned" ? ["abandoned"] : ["sealed"]);
  const journalPath = path.join(manifest.rootPath, APPLY_JOURNAL_DIRECTORY, "journal.json");
  const journal = await readApplyJournalOrNull(journalPath);
  if (outcome === "committed") {
    if (
      !journal
      || journal.state !== "committed"
      || journal.changeSetDigest !== manifest.sealedChangeSetDigest
      || options.commitReceipt !== applyCommitReceipt(journal)
    ) {
      throw new MaintenanceShadowError(
        "invalid_state",
        "committed terminal 必须绑定 matching committed journal 与 opaque receipt"
      );
    }
  } else if (journal && journal.state !== "rolled-back") {
    throw new MaintenanceShadowError(
      "invalid_state",
      `${outcome} terminal 不允许删除 ${journal.state} apply journal`
    );
  }
  if (outcome === "noop") {
    const changeSet = await readStoredChangeSet(manifest);
    if (changeSet.structuralResult !== "zero-result") {
      throw new MaintenanceShadowError("invalid_state", "只有 sealed zero-result 才能标记 noop");
    }
  }
  await writeManifest(handle.manifestPath, withManifestDigest({
    ...withoutManifestDigest(manifest),
    state: outcome,
    terminalAt: new Date().toISOString()
  }));
}

/**
 * Removes only explicit cleanup-safe terminal attempts. Active, sealed, and
 * abandoned workspaces fail closed.
 */
export async function cleanupMaintenanceShadowVault(handle: MaintenanceShadowHandle): Promise<void> {
  const manifest = await readManifest(handle);
  assertManifestState(manifest, ["committed", "discarded", "noop"]);
  const journal = await readApplyJournalOrNull(
    path.join(manifest.rootPath, APPLY_JOURNAL_DIRECTORY, "journal.json")
  );
  if (
    (manifest.state === "committed" && journal?.state !== "committed")
    || (manifest.state !== "committed" && journal && journal.state !== "rolled-back")
  ) {
    throw new MaintenanceShadowError("invalid_state", "cleanup 被非安全 apply journal 阻止");
  }
  await makeTreeOwnerWritable(manifest.rootPath);
  await fsp.rm(manifest.rootPath, { recursive: true, force: true });
}

/**
 * Reload entrypoint: takes the same persistent storage root configured for
 * attempts, quarantines a dead-owner lock, and settles every durable journal
 * for this live Vault before a new attempt may commit.
 */
export async function recoverMaintenanceShadowApplyTransactions(
  liveVaultPathInput: string,
  storageRootPathInput: string
): Promise<void> {
  const liveVaultPath = await assertPlainDirectoryRoot(liveVaultPathInput, "真实 Vault");
  const storageRootPath = await assertPlainDirectoryRoot(storageRootPathInput, "Shadow storage root");
  const fingerprint = vaultFingerprint(liveVaultPath);
  const lockPath = path.join(
    storageRootPath,
    `.echoink-maintenance-${fingerprint.slice("sha256:".length)}.lock`
  );
  const lock = await acquireMaintenanceApplyLock(lockPath, {
    version: 1,
    pid: process.pid,
    attemptId: "recovery",
    journalPath: path.join(storageRootPath, ".recovery"),
    createdAt: new Date().toISOString()
  });
  try {
    await recoverPendingApplyJournals(liveVaultPath, storageRootPath, fingerprint);
  } finally {
    await lock.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Applies a sealed changeset to the live Vault. All selected entries are CAS
 * checked before the first mutation, checked again immediately before their
 * atomic replace/delete, and serialized by a per-Vault lock.
 */
export async function applyShadowChangeSet(
  liveVaultPathInput: string,
  changeSet: MaintenanceShadowChangeSet,
  options: ApplyShadowChangeSetOptions = {}
): Promise<ApplyShadowChangeSetResult> {
  assertValidChangeSet(changeSet);
  const liveVaultPath = await assertPlainDirectoryRoot(liveVaultPathInput, "真实 Vault");
  const shadowVaultPath = await assertPlainDirectoryRoot(changeSet.shadowVaultPath, "Shadow Vault");
  const controlRootPath = await assertPlainDirectoryRoot(changeSet.controlRootPath, "Shadow control root");
  const sealedBlobRootPath = await assertPlainDirectoryRoot(changeSet.sealedBlobRootPath, "Shadow sealed blob root");
  if (
    path.dirname(shadowVaultPath) !== controlRootPath
    || path.dirname(sealedBlobRootPath) !== controlRootPath
  ) {
    throw new MaintenanceShadowError("changeset_corrupt", "Shadow control/blob 路径关系无效");
  }
  if (vaultFingerprint(liveVaultPath) !== changeSet.liveVaultFingerprint) {
    throw new MaintenanceShadowError("cas_conflict", "changeset 不属于当前真实 Vault");
  }
  const changePaths = new Set(changeSet.changes.map((change) => change.relativePath));
  const selectedAllowPaths = options.allowPaths ? normalizePathList(options.allowPaths) : null;
  for (const allowedPath of selectedAllowPaths ?? []) {
    if (!changePaths.has(allowedPath) || !isMaintenanceCommitPath(allowedPath) || isPluginOwnedMaintenancePath(allowedPath)) {
      throw new MaintenanceShadowError(
        "commit_path_denied",
        `partial allowPaths 必须是 changeset 中的精确证据路径：${allowedPath}`,
        allowedPath
      );
    }
  }

  const selected: MaintenanceShadowChange[] = [];
  const skippedPaths: string[] = [];
  for (const change of changeSet.changes) {
    const relativePath = normalizeVaultRelativePath(change.relativePath);
    if (!isMaintenanceCommitPath(relativePath) || isPluginOwnedMaintenancePath(relativePath)) {
      throw new MaintenanceShadowError(
        "commit_path_denied",
        `changeset 目标超出维护提交边界：${relativePath}`,
        relativePath
      );
    }
    if (!selectedAllowPaths || selectedAllowPaths.includes(relativePath)) selected.push(change);
    else skippedPaths.push(relativePath);
  }

  const storageRootPath = path.dirname(controlRootPath);
  const journalRootPath = path.join(controlRootPath, APPLY_JOURNAL_DIRECTORY);
  const journalPath = path.join(journalRootPath, "journal.json");
  const selectionDigest = digestJson(selected.map((change) => change.relativePath));
  const lockPath = path.join(
    storageRootPath,
    `.echoink-maintenance-${changeSet.liveVaultFingerprint.slice("sha256:".length)}.lock`
  );
  const lock = await acquireMaintenanceApplyLock(lockPath, {
    version: 1,
    pid: process.pid,
    attemptId: changeSet.attemptId,
    journalPath,
    createdAt: new Date().toISOString()
  });
  try {
    await recoverPendingApplyJournals(
      liveVaultPath,
      storageRootPath,
      changeSet.liveVaultFingerprint,
      { deferJournalPath: journalPath }
    );
    const manifestHandle: MaintenanceShadowHandle = {
      attemptId: changeSet.attemptId,
      rootPath: controlRootPath,
      agentVaultPath: shadowVaultPath,
      manifestPath: path.join(controlRootPath, MANIFEST_FILE)
    };
    const manifest = await readManifest(manifestHandle);
    assertManifestState(manifest, ["sealed"]);
    if (
      manifest.sealedChangeSetDigest !== changeSet.digest
      || manifest.baselineDigest !== changeSet.baselineDigest
      || manifest.liveVaultFingerprint !== changeSet.liveVaultFingerprint
      || path.resolve(manifest.rootPath) !== controlRootPath
      || path.resolve(manifest.shadowVaultPath) !== shadowVaultPath
    ) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        "apply 锁内 manifest 与 changeset digest/路径不一致"
      );
    }
    const storedChangeSet = await readStoredChangeSet(manifest);
    if (storedChangeSet.digest !== changeSet.digest) {
      throw new MaintenanceShadowError("changeset_corrupt", "apply 不是 manifest 当前 sealed changeset");
    }
    if (!selected.length) {
      return { appliedPaths: [], skippedPaths: skippedPaths.sort() };
    }

    let journal = await readApplyJournalOrNull(journalPath);
    if (journal) {
      assertApplyJournalMatches(journal, changeSet, selectionDigest);
      journal = await ensureApplyJournalMetadataSuccessorPolicy(
        journalPath,
        journal,
        changeSet
      );
      journal = await recoverApplyJournal(
        liveVaultPath,
        journalRootPath,
        journal,
        {
          metadataSuccessor: applyJournalMetadataSuccessorContext(
            changeSet,
            journal
          ),
          recoverBlockedMetadataSuccessors: true,
          faultInjector: options.faultInjector
        }
      );
      if (journal.state === "committed") {
        return {
          appliedPaths: [...journal.selectedPaths].sort(),
          skippedPaths: skippedPaths.sort(),
          commitReceipt: applyCommitReceipt(journal)
        };
      }
      if (journal.state === "blocked") {
        throw new MaintenanceShadowError("cas_conflict", journal.error ?? "维护提交恢复被并发修改阻断");
      }
      await makeTreeOwnerWritable(journalRootPath);
      await fsp.rm(journalRootPath, { recursive: true, force: true });
    }

    journal = await prepareApplyJournal(
      liveVaultPath,
      shadowVaultPath,
      sealedBlobRootPath,
      journalRootPath,
      changeSet,
      selected,
      selectionDigest
    );
    const metadataSuccessor = applyJournalMetadataSuccessorContext(
      changeSet,
      journal
    );
    journal = await updateApplyJournal(journalPath, journal, { state: "applying" });
    try {
      for (const [index, entry] of journal.entries.entries()) {
        await options.beforeApplyChange?.({
          attemptId: changeSet.attemptId,
          relativePath: entry.change.relativePath,
          index
        });
        await assertExpectedParentChainUnchanged(
          liveVaultPath,
          entry.change,
          "Shadow apply entry"
        );
        await assertExpectedMissingParentState(
          liveVaultPath,
          entry.change,
          journal.createdDirectories,
          "Shadow apply entry"
        );
        const createdDirectories = await ensureTrackedParentDirectories(
          liveVaultPath,
          path.posix.dirname(entry.change.relativePath)
        );
        if (createdDirectories.length) {
          journal = await updateApplyJournal(journalPath, journal, {
            createdDirectories: [...journal.createdDirectories, ...createdDirectories]
          });
        }
        await assertJournalCreatedDirectoriesUnchanged(
          liveVaultPath,
          journal.createdDirectories,
          "Shadow apply created parent"
        );
        await applyJournalEntry(
          liveVaultPath,
          sealedBlobRootPath,
          entry,
          () => options.faultInjector?.({
            point: "after-install-link",
            attemptId: changeSet.attemptId,
            relativePath: entry.change.relativePath,
            index
          })
        );
        await options.faultInjector?.({
          point: "after-entry",
          attemptId: changeSet.attemptId,
          relativePath: entry.change.relativePath,
          index
        });
      }
      const states = await classifyApplyJournalEntries(
        liveVaultPath,
        journal.entries,
        metadataSuccessor
      );
      if (!states.every(isCommittedApplyEntryState)) {
        throw new MaintenanceShadowError("cas_conflict", "维护提交结果复验失败");
      }
      journal = await persistCommittedApplyJournal(
        journalPath,
        journal,
        await collectApplyJournalMetadataSuccessors(
          liveVaultPath,
          journal.entries,
          states,
          metadataSuccessor
        )
      );
      const finalEntry = journal.entries[journal.entries.length - 1];
      await options.faultInjector?.({
        point: "after-journal-commit",
        attemptId: changeSet.attemptId,
        relativePath: finalEntry.change.relativePath,
        index: journal.entries.length - 1
      });
      await cleanupCommittedDisplacedFiles(liveVaultPath, journal.entries);
    } catch (error) {
      if (error instanceof MaintenanceShadowSimulatedCrash) {
        throw error;
      }
      let recovered = await recoverApplyJournal(
        liveVaultPath,
        journalRootPath,
        journal,
        {
          forceRollback: true,
          metadataSuccessor
        }
      );
      if (recovered.state === "blocked") {
        recovered = await recoverApplyJournal(
          liveVaultPath,
          journalRootPath,
          recovered,
          {
            metadataSuccessor,
            recoverBlockedMetadataSuccessors: true,
            faultInjector: options.faultInjector
          }
        );
        if (recovered.state === "committed") {
          journal = recovered;
        } else {
          throw new MaintenanceShadowError(
            "cas_conflict",
            recovered.error ?? `维护提交失败且无法安全回滚：${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        throw error;
      }
    }
    return {
      appliedPaths: selected.map((change) => change.relativePath).sort(),
      skippedPaths: skippedPaths.sort(),
      commitReceipt: applyCommitReceipt(journal)
    };
  } finally {
    await lock.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function buildChanges(
  baseline: Map<string, MaintenanceShadowEntry>,
  current: Map<string, MaintenanceShadowEntry>,
  liveBaseline: Map<string, MaintenanceShadowEntry>,
  liveRootIdentity: Pick<MaintenanceShadowDirectoryIdentity, "dev" | "ino">,
  changedPaths: string[]
): MaintenanceShadowChange[] {
  const changes: MaintenanceShadowChange[] = [];
  for (const relativePath of changedPaths) {
    const before = baseline.get(relativePath);
    const after = current.get(relativePath);
    if (before?.kind === "directory" || after?.kind === "directory") {
      if (!before || !after) continue;
      if (before.kind !== after.kind) {
        throw new MaintenanceShadowError(
          "unsafe_kind_change",
          `不允许文件与目录互换：${relativePath}`,
          relativePath
        );
      }
      continue;
    }

    const liveEntry = liveBaseline.get(relativePath);
    const expectedParentChain = expectedParentChainForChange(
      relativePath,
      liveBaseline,
      liveRootIdentity
    );
    const expectedMissingParentPath = expectedMissingParentForChange(
      relativePath,
      expectedParentChain
    );
    if (before?.kind === "file" && !after) {
      if (!liveEntry || liveEntry.kind !== "file" || !liveEntry.sha256 || liveEntry.size === undefined) {
        throw new MaintenanceShadowError("changeset_corrupt", `缺少删除基线：${relativePath}`, relativePath);
      }
      changes.push({
        operation: "delete",
        relativePath,
        expectedLive: casFileFromEntry(liveEntry),
        expectedLiveIdentity: fileIdentityFromEntry(liveEntry),
        expectedParentChain,
        ...(expectedMissingParentPath
          ? { expectedMissingParentPath }
          : {})
      });
      continue;
    }
    if (after?.kind === "file") {
      if (!after.sha256 || after.size === undefined) {
        throw new MaintenanceShadowError("changeset_corrupt", `缺少 Shadow 文件哈希：${relativePath}`, relativePath);
      }
      if (liveEntry?.kind === "directory") {
        throw new MaintenanceShadowError("unsafe_kind_change", `不允许覆盖真实目录：${relativePath}`, relativePath);
      }
      changes.push({
        operation: "upsert",
        relativePath,
        expectedLive: liveEntry?.kind === "file" ? casFileFromEntry(liveEntry) : { kind: "missing" },
        ...(liveEntry?.kind === "file"
          ? { expectedLiveIdentity: fileIdentityFromEntry(liveEntry) }
          : {}),
        expectedParentChain,
        ...(expectedMissingParentPath
          ? { expectedMissingParentPath }
          : {}),
        shadowSha256: after.sha256,
        size: after.size,
        blobRelativePath: `${after.sha256.slice("sha256:".length)}.blob`
      });
    }
  }
  return changes.sort((left, right) => compareCanonicalText(
    left.relativePath,
    right.relativePath
  ));
}

function expectedParentChainForChange(
  relativePathInput: string,
  liveBaseline: ReadonlyMap<string, MaintenanceShadowEntry>,
  liveRootIdentity: Pick<MaintenanceShadowDirectoryIdentity, "dev" | "ino">
): MaintenanceShadowDirectoryIdentity[] {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const chain: MaintenanceShadowDirectoryIdentity[] = [{
    relativePath: ".",
    dev: liveRootIdentity.dev,
    ino: liveRootIdentity.ino
  }];
  const relativeDirectory = path.posix.dirname(relativePath);
  if (relativeDirectory === ".") return chain;
  let current = "";
  for (const segment of relativeDirectory.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const entry = liveBaseline.get(current);
    if (!entry) break;
    if (
      entry.kind !== "directory"
      || !Number.isSafeInteger(entry.dev)
      || !Number.isSafeInteger(entry.ino)
    ) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `缺少父目录 inode 基线：${current}`,
        current
      );
    }
    chain.push({
      relativePath: current,
      dev: entry.dev!,
      ino: entry.ino!
    });
  }
  return chain;
}

function expectedMissingParentForChange(
  relativePathInput: string,
  expectedParentChain: readonly MaintenanceShadowDirectoryIdentity[]
): string | undefined {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const relativeDirectory = path.posix.dirname(relativePath);
  if (relativeDirectory === ".") return undefined;
  const parentSegments = relativeDirectory.split("/");
  const existingDepth = expectedParentChain.length - 1;
  if (existingDepth >= parentSegments.length) return undefined;
  return parentSegments.slice(0, existingDepth + 1).join("/");
}

function casFileFromEntry(entry: MaintenanceShadowEntry): MaintenanceShadowCasFile {
  if (entry.kind !== "file" || !entry.sha256 || entry.size === undefined) {
    throw new MaintenanceShadowError("changeset_corrupt", `无效 CAS 文件基线：${entry.relativePath}`);
  }
  return {
    kind: "file",
    sha256: entry.sha256,
    size: entry.size,
    mode: entry.mode & 0o777
  };
}

function fileIdentityFromEntry(
  entry: MaintenanceShadowEntry
): MaintenanceShadowFileIdentity {
  if (
    entry.kind !== "file"
    || !Number.isSafeInteger(entry.dev)
    || !Number.isSafeInteger(entry.ino)
  ) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      `无效 CAS 文件 inode 基线：${entry.relativePath}`
    );
  }
  return {
    dev: entry.dev!,
    ino: entry.ino!
  };
}

async function assertLiveCas(
  liveVaultPath: string,
  relativePathInput: string,
  expected: MaintenanceShadowCasBaseline,
  expectedIdentity?: MaintenanceShadowFileIdentity
): Promise<void> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const inspected = await inspectRootRelativeFile(liveVaultPath, relativePath);
  if (expected.kind === "missing") {
    if (inspected) {
      throw new MaintenanceShadowError("cas_conflict", `CAS 冲突，目标已出现：${relativePath}`, relativePath);
    }
    return;
  }
  if (!inspected) {
    throw new MaintenanceShadowError("cas_conflict", `CAS 冲突，目标已删除：${relativePath}`, relativePath);
  }
  if (
    !inspectedFileMatchesCas(inspected, expected)
    || !expectedIdentity
    || inspected.dev !== expectedIdentity.dev
    || inspected.ino !== expectedIdentity.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `CAS 冲突，目标内容或 inode 已被并发替换：${relativePath}`,
      relativePath
    );
  }
}

async function copySafeEntryTree(
  liveVaultPath: string,
  shadowVaultPath: string,
  relativePath: string,
  entries: Map<string, MaintenanceShadowEntry>
): Promise<void> {
  const sourcePath = resolveVaultRelativePath(liveVaultPath, relativePath);
  const destinationPath = resolveVaultRelativePath(shadowVaultPath, relativePath);
  const stat = await fsp.lstat(sourcePath);
  assertSafeStat(stat, relativePath);

  if (stat.isDirectory()) {
    await fsp.mkdir(destinationPath, { recursive: true, mode: 0o700 });
    entries.set(relativePath, directoryEntry(relativePath, stat));
    const children = (await fsp.readdir(sourcePath)).sort(compareCanonicalText);
    for (const child of children) {
      await copySafeEntryTree(
        liveVaultPath,
        shadowVaultPath,
        joinVaultRelativePath(relativePath, child),
        entries
      );
    }
    await fsp.chmod(destinationPath, stat.mode & 0o777);
    return;
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  let sourceIdentity: MaintenanceShadowFileIdentity | undefined;
  const inspected = await copyAndInspectRegularFile(
    sourcePath,
    destinationPath,
    stat.mode,
    {
      preserveSourceTimes: true,
      onSourceVerified: (identity) => {
        sourceIdentity = identity;
      }
    }
  );
  if (!sourceIdentity) {
    throw new MaintenanceShadowError(
      "source_changed",
      `复制后缺少来源 inode 证据：${relativePath}`,
      relativePath
    );
  }
  entries.set(relativePath, fileEntry(relativePath, inspected, sourceIdentity));
}

async function materializeShadowSourceChunks(
  shadowVaultPath: string,
  sources: readonly MaintenanceShadowChunkedTextSource[]
): Promise<MaintenanceShadowSourceChunk[]> {
  const result: MaintenanceShadowSourceChunk[] = [];
  for (const source of sources) {
    const sourcePath = resolveVaultRelativePath(
      shadowVaultPath,
      source.relativePath
    );
    const before = await fsp.lstat(sourcePath);
    assertSafeStat(before, source.relativePath);
    if (!before.isFile() || before.nlink !== 1) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `分块来源不是独立普通文件：${source.relativePath}`,
        source.relativePath
      );
    }
    const content = await fsp.readFile(sourcePath);
    const after = await fsp.lstat(sourcePath);
    if (
      !sameOpenFileVersion(before, after)
      || content.byteLength !== before.size
    ) {
      throw new MaintenanceShadowError(
        "source_changed",
        `生成只读分块时来源发生变化：${source.relativePath}`,
        source.relativePath
      );
    }
    const text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content)) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `文本来源不是有效 UTF-8，无法安全分块：${source.relativePath}`,
        source.relativePath
      );
    }
    const chunks = splitUtf8SourceChunks(content, source.maxChunkBytes);
    const token = createHash("sha256")
      .update(source.relativePath)
      .digest("hex")
      .slice(0, 24);
    const chunkRoot = `${SHADOW_SOURCE_CHUNK_ROOT}/${token}`;
    await fsp.mkdir(
      resolveVaultRelativePath(shadowVaultPath, chunkRoot),
      { recursive: true, mode: 0o700 }
    );
    const width = Math.max(4, String(chunks.length).length);
    for (const [index, chunk] of chunks.entries()) {
      const part = String(index + 1).padStart(width, "0");
      const total = String(chunks.length).padStart(width, "0");
      const relativePath = `${chunkRoot}/part-${part}-of-${total}.md`;
      const absolutePath = resolveVaultRelativePath(
        shadowVaultPath,
        relativePath
      );
      await fsp.writeFile(absolutePath, chunk.content, {
        flag: "wx",
        mode: 0o400
      });
      const stat = await fsp.lstat(absolutePath);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.nlink !== 1
        || stat.size !== chunk.content.byteLength
      ) {
        throw new MaintenanceShadowError(
          "unsafe_entry",
          `只读分块落盘证据无效：${relativePath}`,
          relativePath
        );
      }
      result.push({
        sourceRelativePath: source.relativePath,
        relativePath,
        index: index + 1,
        count: chunks.length,
        startByte: chunk.startByte,
        endByte: chunk.endByte,
        size: chunk.content.byteLength,
        sha256: hashBuffer(chunk.content)
      });
    }
  }
  return result;
}

function splitUtf8SourceChunks(
  content: Buffer,
  maxChunkBytes: number
): Array<{ startByte: number; endByte: number; content: Buffer }> {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 4) {
    throw new MaintenanceShadowError(
      "invalid_path",
      `非法文本分块上限：${maxChunkBytes}`
    );
  }
  const chunks: Array<{
    startByte: number;
    endByte: number;
    content: Buffer;
  }> = [];
  let startByte = 0;
  while (startByte < content.byteLength) {
    let endByte = Math.min(
      content.byteLength,
      startByte + maxChunkBytes
    );
    if (endByte < content.byteLength) {
      const newline = content.lastIndexOf(0x0a, endByte - 1);
      if (newline >= startByte + Math.floor(maxChunkBytes / 2)) {
        endByte = newline + 1;
      } else {
        while (
          endByte > startByte
          && (content[endByte] & 0xc0) === 0x80
        ) {
          endByte -= 1;
        }
      }
    }
    if (endByte <= startByte) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        "文本分块无法在 UTF-8 字符边界内推进"
      );
    }
    const chunk = Buffer.from(content.subarray(startByte, endByte));
    if (!Buffer.from(chunk.toString("utf8"), "utf8").equals(chunk)) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        "文本分块不是有效 UTF-8"
      );
    }
    chunks.push({ startByte, endByte, content: chunk });
    startByte = endByte;
  }
  return chunks;
}

async function scanSafeRoots(
  vaultPath: string,
  roots: readonly string[]
): Promise<Map<string, MaintenanceShadowEntry>> {
  const entries = new Map<string, MaintenanceShadowEntry>();
  for (const root of minimalPathRoots(roots)) {
    await scanSafeEntryTree(vaultPath, root, entries);
  }
  return entries;
}

async function scanEntireVault(vaultPath: string): Promise<Map<string, MaintenanceShadowEntry>> {
  const entries = new Map<string, MaintenanceShadowEntry>();
  const children = (await fsp.readdir(vaultPath)).sort(compareCanonicalText);
  for (const child of children) {
    if (child.includes("/") || child.includes("\\") || child === "." || child === "..") {
      throw new MaintenanceShadowError("invalid_path", `非法 Shadow 顶层目录项：${child}`);
    }
    await scanSafeEntryTree(vaultPath, child, entries);
  }
  return entries;
}

async function scanSafeEntryTree(
  vaultPath: string,
  relativePath: string,
  entries: Map<string, MaintenanceShadowEntry>
): Promise<void> {
  const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
  const stat = await lstatOrNull(absolutePath);
  if (!stat) return;
  assertSafeStat(stat, relativePath);
  if (stat.isDirectory()) {
    entries.set(relativePath, directoryEntry(relativePath, stat));
    const children = (await fsp.readdir(absolutePath)).sort(compareCanonicalText);
    for (const child of children) {
      await scanSafeEntryTree(vaultPath, joinVaultRelativePath(relativePath, child), entries);
    }
    return;
  }
  entries.set(relativePath, fileEntry(relativePath, await inspectRegularFile(absolutePath)));
}

async function inspectRequiredEntry(vaultPath: string, relativePath: string): Promise<void> {
  await assertSafeExistingParents(vaultPath, path.dirname(relativePath));
  const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
  const stat = await lstatOrNull(absolutePath);
  if (!stat) {
    throw new MaintenanceShadowError("required_path_missing", `Shadow 必需来源不存在：${relativePath}`, relativePath);
  }
  assertSafeStat(stat, relativePath);
}

function assertSafeStat(stat: Stats, relativePath: string): void {
  if (stat.isSymbolicLink()) {
    throw new MaintenanceShadowError("unsafe_entry", `Shadow 来源不能包含 symlink：${relativePath}`, relativePath);
  }
  if (stat.isFile() && stat.nlink > 1) {
    throw new MaintenanceShadowError("unsafe_entry", `Shadow 来源不能包含 hardlink：${relativePath}`, relativePath);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new MaintenanceShadowError("unsafe_entry", `Shadow 来源不能包含特殊文件：${relativePath}`, relativePath);
  }
}

function assertNoKnowledgeConflictDuplicates(
  entries: ReadonlyMap<string, MaintenanceShadowEntry>
): void {
  for (const [relativePath, entry] of entries) {
    if (entry.kind !== "file") continue;
    const match = /^(.*) \d+(\.md)$/i.exec(relativePath);
    if (!match || !entries.has(`${match[1]}${match[2]}`)) continue;
    throw new MaintenanceShadowError(
      "unsafe_entry",
      `Shadow 来源不能包含冲突副本：${relativePath}`,
      relativePath
    );
  }
}

async function copyAndInspectRegularFile(
  sourcePath: string,
  destinationPath: string,
  mode: number,
  options: {
    preserveSourceTimes?: boolean;
    onDestinationCreated?: (
      identity: Pick<InspectedFile, "dev" | "ino">
    ) => void;
    onSourceVerified?: (
      identity: MaintenanceShadowFileIdentity
    ) => void;
  } = {}
): Promise<InspectedFile> {
  const sourcePathBefore = await fsp.lstat(sourcePath);
  assertSafeStat(sourcePathBefore, sourcePath);
  const source = await openNoFollow(sourcePath, fsConstants.O_RDONLY);
  let destination: fsp.FileHandle | undefined;
  try {
    const before = await source.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || !sameFileIdentity(sourcePathBefore, before)
    ) {
      throw new MaintenanceShadowError("unsafe_entry", `Shadow 来源不是独立普通文件：${sourcePath}`);
    }
    destination = await openNoFollow(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode & 0o777
    );
    const [created, createdPath] = await Promise.all([
      destination.stat(),
      lstatOrNull(destinationPath)
    ]);
    if (
      !created.isFile()
      || created.nlink !== 1
      || !createdPath
      || !sameFileIdentity(created, createdPath)
    ) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `新建目标没有绑定独立普通文件：${destinationPath}`
      );
    }
    options.onDestinationCreated?.({
      dev: Number(created.dev),
      ino: Number(created.ino)
    });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(FILE_READ_CHUNK_SIZE);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (!bytesRead) throw new MaintenanceShadowError("source_changed", `复制时来源被截断：${sourcePath}`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeFileHandleFully(destination, chunk);
      position += bytesRead;
    }
    await destination.sync();
    await destination.chmod(mode & 0o777);
    if (options.preserveSourceTimes) {
      // Initial Shadow copies must retain evidence freshness. Keep this scoped
      // to createMaintenanceShadowVault; sealed blobs and install artifacts
      // intentionally continue to use their transaction-local timestamps.
      await destination.utimes(before.atime, before.mtime);
      await destination.sync();
    }
    const after = await source.stat();
    const [sourcePathAfter, destinationAfter, destinationPathAfter] = await Promise.all([
      lstatOrNull(sourcePath),
      destination.stat(),
      lstatOrNull(destinationPath)
    ]);
    if (
      !sameOpenFileVersion(before, after)
      || position !== before.size
      || !sourcePathAfter
      || !sameFileIdentity(after, sourcePathAfter)
      || !destinationPathAfter
      || !sameFileIdentity(destinationAfter, destinationPathAfter)
      || !destinationAfter.isFile()
      || destinationAfter.nlink !== 1
    ) {
      throw new MaintenanceShadowError("source_changed", `复制时来源发生变化：${sourcePath}`);
    }
    options.onSourceVerified?.({
      dev: Number(after.dev),
      ino: Number(after.ino)
    });
    return {
      sha256: `sha256:${hash.digest("hex")}`,
      size: position,
      mode,
      dev: Number(destinationAfter.dev),
      ino: Number(destinationAfter.ino),
      nlink: Number(destinationAfter.nlink)
    };
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function inspectRegularFile(
  absolutePath: string,
  allowedLinkCounts: readonly number[] = [1]
): Promise<InspectedFile> {
  const pathBefore = await fsp.lstat(absolutePath);
  if (
    !pathBefore.isFile()
    || pathBefore.isSymbolicLink()
    || !allowedLinkCounts.includes(pathBefore.nlink)
  ) {
    throw new MaintenanceShadowError("unsafe_entry", `不是独立普通文件：${absolutePath}`);
  }
  const handle = await openNoFollow(absolutePath, fsConstants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || !allowedLinkCounts.includes(before.nlink)
      || !sameFileIdentity(pathBefore, before)
    ) {
      throw new MaintenanceShadowError("unsafe_entry", `不是独立普通文件：${absolutePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(FILE_READ_CHUNK_SIZE);
    let position = 0;
    while (position < before.size) {
      const requested = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (!bytesRead) throw new MaintenanceShadowError("source_changed", `读取时文件被截断：${absolutePath}`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstatOrNull(absolutePath);
    if (
      !sameOpenFileVersion(before, after)
      || position !== before.size
      || !pathAfter
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !allowedLinkCounts.includes(pathAfter.nlink)
      || !sameFileIdentity(after, pathAfter)
    ) {
      throw new MaintenanceShadowError("source_changed", `读取时文件发生变化：${absolutePath}`);
    }
    return {
      sha256: `sha256:${hash.digest("hex")}`,
      size: position,
      mode: before.mode,
      dev: Number(before.dev),
      ino: Number(before.ino),
      nlink: Number(before.nlink)
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readIndependentRegularFile(
  absolutePath: string,
  label: string,
  maxBytes: number
): Promise<Buffer> {
  return await readBoundRegularFile(absolutePath, label, maxBytes, {
    allowedLinkCounts: [1]
  });
}

async function readBoundRegularFile(
  absolutePath: string,
  label: string,
  maxBytes: number,
  options: {
    allowedLinkCounts: readonly number[];
    expectedIdentity?: MaintenanceShadowFileIdentity;
  }
): Promise<Buffer> {
  const pathBefore = await fsp.lstat(absolutePath);
  if (
    !pathBefore.isFile()
    || pathBefore.isSymbolicLink()
    || !options.allowedLinkCounts.includes(pathBefore.nlink)
    || (
      options.expectedIdentity
      && (
        Number(pathBefore.dev) !== options.expectedIdentity.dev
        || Number(pathBefore.ino) !== options.expectedIdentity.ino
      )
    )
  ) {
    throw new MaintenanceShadowError("unsafe_entry", `${label} 不是受信普通文件`);
  }
  const handle = await openNoFollow(absolutePath, fsConstants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || !options.allowedLinkCounts.includes(before.nlink)
      || !sameFileIdentity(pathBefore, before)
      || (
        options.expectedIdentity
        && (
          Number(before.dev) !== options.expectedIdentity.dev
          || Number(before.ino) !== options.expectedIdentity.ino
        )
      )
    ) {
      throw new MaintenanceShadowError("unsafe_entry", `${label} 不是受信普通文件`);
    }
    if (before.size > maxBytes) {
      throw new MaintenanceShadowError("unsafe_entry", `${label} 超过安全读取上限`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstatOrNull(absolutePath);
    if (
      !sameOpenFileVersion(before, after)
      || content.byteLength !== before.size
      || !pathAfter
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !options.allowedLinkCounts.includes(pathAfter.nlink)
      || !sameFileIdentity(after, pathAfter)
      || (
        options.expectedIdentity
        && (
          Number(after.dev) !== options.expectedIdentity.dev
          || Number(after.ino) !== options.expectedIdentity.ino
        )
      )
    ) {
      throw new MaintenanceShadowError("source_changed", `${label} 在读取时发生变化`);
    }
    return content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function copyFileWithExpectedContent(
  sourcePath: string,
  destinationPath: string,
  expectedSha256: string,
  expectedSize: number,
  destinationMode = 0o600,
  destinationBoundary?: {
    vaultPath: string;
    relativePath: string;
    parentChain: SafeDirectoryChain;
  }
): Promise<InspectedFile> {
  const sourceStat = await fsp.lstat(sourcePath);
  assertSafeStat(sourceStat, sourcePath);
  if (destinationBoundary) {
    await assertSafeDirectoryChainUnchanged(destinationBoundary.parentChain);
  } else {
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  }
  let createdIdentity: Pick<InspectedFile, "dev" | "ino"> | undefined;
  try {
    const copied = await copyAndInspectRegularFile(
      sourcePath,
      destinationPath,
      destinationMode,
      {
        onDestinationCreated: (identity) => {
          createdIdentity = identity;
        }
      }
    );
    if (copied.sha256 !== expectedSha256 || copied.size !== expectedSize) {
      throw new MaintenanceShadowError("source_changed", `seal blob 来源已变化：${sourcePath}`);
    }
    return copied;
  } catch (error) {
    if (createdIdentity) {
      if (destinationBoundary) {
        await unlinkRootRelativeFileIfIdentityMatches(
          destinationBoundary.vaultPath,
          destinationBoundary.relativePath,
          createdIdentity,
          {
            label: "Shadow exclusive copy artifact",
            parentChain: destinationBoundary.parentChain,
            allowMissing: true
          }
        ).catch(() => undefined);
      } else {
        await unlinkAbsoluteFileIfIdentityMatches(
          destinationPath,
          createdIdentity
        ).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function readSafeRegularFile(vaultPath: string, relativePathInput: string): Promise<Buffer> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  await assertSafeExistingParents(vaultPath, path.dirname(relativePath));
  const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
  const handle = await openNoFollow(absolutePath, fsConstants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new MaintenanceShadowError("unsafe_entry", `Shadow 提交源不是独立普通文件：${relativePath}`, relativePath);
    }
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readSafeProbe(absolutePath: string): Promise<string | null> {
  const stat = await lstatOrNull(absolutePath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) {
    throw new MaintenanceShadowError("unsafe_entry", `write-fence probe 不是安全小文件：${absolutePath}`);
  }
  const handle = await openNoFollow(absolutePath, fsConstants.O_RDONLY);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function cleanupFenceProbe(absolutePath: string, token: string): Promise<void> {
  try {
    if (await readSafeProbe(absolutePath) === token) await fsp.rm(absolutePath, { force: true });
  } catch {
    // Fail closed: never delete an unexpected or unsafe entry.
  }
}

async function cleanupNewDeniedProbe(
  absolutePath: string,
  shadowVaultPath: string,
  baseline: Map<string, MaintenanceShadowEntry>
): Promise<void> {
  const relative = normalizeVaultRelativePath(
    path.relative(shadowVaultPath, absolutePath).split(path.sep).join("/")
  );
  if (baseline.has(relative)) return;
  const stat = await lstatOrNull(absolutePath);
  if (stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
    await fsp.rm(absolutePath, { force: true });
  }
}

function deniedProbeAttemptsMatch(
  attempts: MaintenanceShadowWriteFenceProof["deniedProbeAttempts"],
  expectedPaths: readonly string[]
): boolean {
  if (!Array.isArray(attempts) || attempts.length !== expectedPaths.length) return false;
  const normalized = attempts
    .map((attempt) => ({
      path: path.resolve(attempt.path),
      outcome: attempt.outcome,
      errorCode: attempt.errorCode
    }))
    .sort((left, right) => compareCanonicalText(left.path, right.path));
  const expected = canonicalAbsolutePaths(expectedPaths);
  return normalized.every((attempt, index) =>
    attempt.path === expected[index]
    && attempt.outcome === "denied"
    && typeof attempt.errorCode === "string"
    && attempt.errorCode.trim().length > 0
  );
}

async function openNoFollow(
  absolutePath: string,
  flags: number,
  mode?: number
): Promise<fsp.FileHandle> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  return await fsp.open(absolutePath, flags | noFollow, mode);
}

async function makePathsReadOnly(vaultPath: string, relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
    if (await lstatOrNull(absolutePath)) await makeTreeReadOnly(absolutePath);
  }
}

async function makeTreeReadOnly(absolutePath: string): Promise<void> {
  const stat = await fsp.lstat(absolutePath);
  assertSafeStat(stat, absolutePath);
  if (stat.isDirectory()) {
    const children = await fsp.readdir(absolutePath);
    for (const child of children) await makeTreeReadOnly(path.join(absolutePath, child));
    await fsp.chmod(absolutePath, 0o555);
  } else {
    await fsp.chmod(absolutePath, 0o444);
  }
}

async function freezeTree(absolutePath: string): Promise<void> {
  await makeTreeReadOnly(absolutePath);
}

async function makeTreeOwnerWritable(absolutePath: string): Promise<void> {
  const stat = await lstatOrNull(absolutePath);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fsp.chmod(absolutePath, 0o700).catch(() => undefined);
    const children = await fsp.readdir(absolutePath).catch(() => []);
    for (const child of children) await makeTreeOwnerWritable(path.join(absolutePath, child));
  } else if (stat.isFile()) {
    await fsp.chmod(absolutePath, 0o600).catch(() => undefined);
  }
}

async function ensureTrackedParentDirectories(
  vaultPath: string,
  relativeDirectoryInput: string
): Promise<Array<{ relativePath: string; dev: number; ino: number }>> {
  if (!relativeDirectoryInput || relativeDirectoryInput === ".") return [];
  const relativeDirectory = normalizeVaultRelativePath(relativeDirectoryInput);
  const segments = relativeDirectory.split("/");
  let current = vaultPath;
  let currentRelative = "";
  const created: Array<{ relativePath: string; dev: number; ino: number }> = [];
  for (const segment of segments) {
    current = path.join(current, segment);
    currentRelative = currentRelative ? `${currentRelative}/${segment}` : segment;
    const parentRelative = path.posix.dirname(currentRelative);
    const parentChain = await requireSafeDirectoryChain(
      vaultPath,
      parentRelative,
      "Shadow parent creation"
    );
    const stat = await lstatOrNull(current);
    if (!stat) {
      await assertSafeDirectoryChainUnchanged(parentChain);
      try {
        await fsp.mkdir(current, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new MaintenanceShadowError(
            "cas_conflict",
            `新建父目录时出现并发第三值：${currentRelative}`,
            currentRelative
          );
        }
        throw error;
      }
      await syncDirectoryDurably(path.dirname(current));
      await assertSafeDirectoryChainUnchanged(parentChain);
      const createdStat = await fsp.lstat(current);
      if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
        throw new MaintenanceShadowError("unsafe_entry", `新建父路径不是安全目录：${currentRelative}`);
      }
      created.push({
        relativePath: currentRelative,
        dev: Number(createdStat.dev),
        ino: Number(createdStat.ino)
      });
      const createdChain = await requireSafeDirectoryChain(
        vaultPath,
        currentRelative,
        "Shadow created parent"
      );
      const createdIdentity = createdChain.identities[createdChain.identities.length - 1];
      if (
        !createdIdentity
        || createdIdentity.dev !== Number(createdStat.dev)
        || createdIdentity.ino !== Number(createdStat.ino)
      ) {
        throw new MaintenanceShadowError(
          "unsafe_entry",
          `新建父目录 inode 在确认前被替换：${currentRelative}`,
          currentRelative
        );
      }
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `真实 Vault 父路径不是安全目录：${relativeDirectory}`,
        relativeDirectory
      );
    }
    await assertSafeDirectoryChainUnchanged(parentChain);
    const existingChain = await requireSafeDirectoryChain(
      vaultPath,
      currentRelative,
      "Shadow existing parent"
    );
    const existingIdentity = existingChain.identities[existingChain.identities.length - 1];
    if (
      !existingIdentity
      || existingIdentity.dev !== Number(stat.dev)
      || existingIdentity.ino !== Number(stat.ino)
    ) {
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `父目录 inode 在确认前被替换：${currentRelative}`,
        currentRelative
      );
    }
  }
  return created;
}

async function assertSafeExistingParents(vaultPath: string, relativeDirectoryInput: string): Promise<void> {
  await captureSafeDirectoryChain(vaultPath, relativeDirectoryInput);
}

async function captureSafeDirectoryChain(
  vaultPathInput: string,
  relativeDirectoryInput: string
): Promise<SafeDirectoryChain> {
  const rootPath = path.resolve(vaultPathInput);
  const rootStat = await lstatOrNull(rootPath);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new MaintenanceShadowError("unsafe_entry", `可信 Vault root 不是安全目录：${rootPath}`);
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
  const relativeDirectory = normalizeVaultRelativePath(relativeDirectoryInput);
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
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `Vault 父路径不是安全目录：${relativeDirectory}`,
        relativeDirectory
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

async function requireSafeDirectoryChain(
  vaultPath: string,
  relativeDirectoryInput: string,
  label: string
): Promise<SafeDirectoryChain> {
  const chain = await captureSafeDirectoryChain(vaultPath, relativeDirectoryInput);
  if (!chain.complete) {
    throw new MaintenanceShadowError(
      "unsafe_entry",
      `${label} 父目录缺失：${chain.relativeDirectory}`,
      chain.relativeDirectory
    );
  }
  await assertSafeDirectoryChainUnchanged(chain);
  return chain;
}

async function assertExpectedParentChainUnchanged(
  vaultPath: string,
  change: MaintenanceShadowChange,
  label: string
): Promise<SafeDirectoryChain> {
  const expected = change.expectedParentChain;
  if (!expected?.length) {
    throw new MaintenanceShadowError(
      "changeset_corrupt",
      `${label} 缺少父目录 inode 基线：${change.relativePath}`,
      change.relativePath
    );
  }
  const deepest = expected[expected.length - 1]!;
  const chain = await requireSafeDirectoryChain(
    vaultPath,
    deepest.relativePath,
    label
  );
  if (
    chain.identities.length !== expected.length
    || chain.identities.some((identity, index) => (
      identity.dev !== expected[index]?.dev
      || identity.ino !== expected[index]?.ino
    ))
  ) {
    throw new MaintenanceShadowError(
      "unsafe_entry",
      `${label} 检测到父目录 inode 被替换：${change.relativePath}`,
      change.relativePath
    );
  }
  return chain;
}

async function assertExpectedMissingParentState(
  vaultPath: string,
  change: MaintenanceShadowChange,
  createdDirectories: readonly { relativePath: string; dev: number; ino: number }[],
  label: string
): Promise<void> {
  const relativePath = change.expectedMissingParentPath;
  if (!relativePath) return;
  await assertExpectedParentChainUnchanged(vaultPath, change, label);
  const parentChain = await requireSafeDirectoryChain(
    vaultPath,
    path.posix.dirname(relativePath),
    label
  );
  const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
  const stat = await lstatOrNull(absolutePath);
  if (!stat) {
    await assertSafeDirectoryChainUnchanged(parentChain);
    return;
  }
  const created = createdDirectories.find(
    (candidate) => candidate.relativePath === relativePath
  );
  if (
    !created
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || Number(stat.dev) !== created.dev
    || Number(stat.ino) !== created.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `${label} 检测到 missing 父目录第三值：${relativePath}`,
      relativePath
    );
  }
  await assertSafeDirectoryChainUnchanged(parentChain);
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
      throw new MaintenanceShadowError(
        "unsafe_entry",
        `Vault 父目录链在操作期间被替换：${identity.absolutePath}`
      );
    }
  }
  if (!chain.complete) return;
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
    throw new MaintenanceShadowError(
      "unsafe_entry",
      "Vault 父目录链 inode 在操作期间发生变化"
    );
  }
}

async function inspectRootRelativeFile(
  vaultPath: string,
  relativePathInput: string,
  allowedLinkCounts: readonly number[] = [1]
): Promise<InspectedFile | null> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const chain = await captureSafeDirectoryChain(
    vaultPath,
    path.posix.dirname(relativePath)
  );
  if (!chain.complete) return null;
  await assertSafeDirectoryChainUnchanged(chain);
  const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
  const stat = await lstatOrNull(absolutePath);
  if (!stat) {
    await assertSafeDirectoryChainUnchanged(chain);
    return null;
  }
  const inspected = await inspectRegularFile(absolutePath, allowedLinkCounts);
  await assertSafeDirectoryChainUnchanged(chain);
  return inspected;
}

async function assertRootRelativeFileMatchesCas(
  vaultPath: string,
  relativePathInput: string,
  expected: MaintenanceShadowCasFile,
  allowedLinkCounts: readonly number[] = [1]
): Promise<InspectedFile> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const inspected = await inspectRootRelativeFile(
    vaultPath,
    relativePath,
    allowedLinkCounts
  );
  if (!inspected || !inspectedFileMatchesCas(inspected, expected)) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `CAS 冲突，文件与事务证据不一致：${relativePath}`,
      relativePath
    );
  }
  return inspected;
}

async function unlinkRootRelativeFileIfMatches(
  vaultPath: string,
  relativePathInput: string,
  expected: MaintenanceShadowCasFile,
  options: {
    label: string;
    allowedLinkCounts?: readonly number[];
    expectedIdentity?: Pick<InspectedFile, "dev" | "ino">;
    allowMissing?: boolean;
  }
): Promise<boolean> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const chain = await requireSafeDirectoryChain(
    vaultPath,
    path.posix.dirname(relativePath),
    options.label
  );
  const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
  const stat = await lstatOrNull(absolutePath);
  if (!stat) {
    if (options.allowMissing) return false;
    throw new MaintenanceShadowError(
      "cas_conflict",
      `${options.label} 已缺失：${relativePath}`,
      relativePath
    );
  }
  const inspected = await inspectRegularFile(
    absolutePath,
    options.allowedLinkCounts ?? [1]
  );
  if (
    !inspectedFileMatchesCas(inspected, expected)
    || (
      options.expectedIdentity
      && (
        inspected.dev !== options.expectedIdentity.dev
        || inspected.ino !== options.expectedIdentity.ino
      )
    )
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `${options.label} CAS 或 inode 已变化，保留第三值：${relativePath}`,
      relativePath
    );
  }
  await assertSafeDirectoryChainUnchanged(chain);
  const beforeUnlink = await lstatOrNull(absolutePath);
  if (
    !beforeUnlink
    || !beforeUnlink.isFile()
    || beforeUnlink.isSymbolicLink()
    || Number(beforeUnlink.dev) !== inspected.dev
    || Number(beforeUnlink.ino) !== inspected.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `${options.label} unlink 前 inode 已变化，保留第三值：${relativePath}`,
      relativePath
    );
  }
  await fsp.unlink(absolutePath);
  await syncDirectoryDurably(path.dirname(absolutePath));
  await assertSafeDirectoryChainUnchanged(chain);
  return true;
}

async function unlinkRootRelativeFileIfIdentityMatches(
  vaultPath: string,
  relativePathInput: string,
  expectedIdentity: Pick<InspectedFile, "dev" | "ino">,
  options: {
    label: string;
    parentChain?: SafeDirectoryChain;
    allowMissing?: boolean;
  }
): Promise<boolean> {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const chain = options.parentChain ?? await requireSafeDirectoryChain(
    vaultPath,
    path.posix.dirname(relativePath),
    options.label
  );
  await assertSafeDirectoryChainUnchanged(chain);
  const absolutePath = resolveVaultRelativePath(vaultPath, relativePath);
  const stat = await lstatOrNull(absolutePath);
  if (!stat) {
    if (options.allowMissing) return false;
    throw new MaintenanceShadowError(
      "cas_conflict",
      `${options.label} 已缺失：${relativePath}`,
      relativePath
    );
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || Number(stat.dev) !== expectedIdentity.dev
    || Number(stat.ino) !== expectedIdentity.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `${options.label} inode 已变化，保留第三值：${relativePath}`,
      relativePath
    );
  }
  await assertSafeDirectoryChainUnchanged(chain);
  const beforeUnlink = await lstatOrNull(absolutePath);
  if (
    !beforeUnlink
    || !beforeUnlink.isFile()
    || beforeUnlink.isSymbolicLink()
    || Number(beforeUnlink.dev) !== expectedIdentity.dev
    || Number(beforeUnlink.ino) !== expectedIdentity.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `${options.label} unlink 前 inode 已变化，保留第三值：${relativePath}`,
      relativePath
    );
  }
  await fsp.unlink(absolutePath);
  await syncDirectoryDurably(path.dirname(absolutePath));
  await assertSafeDirectoryChainUnchanged(chain);
  return true;
}

async function unlinkAbsoluteFileIfIdentityMatches(
  absolutePath: string,
  expectedIdentity: Pick<InspectedFile, "dev" | "ino">
): Promise<boolean> {
  const stat = await lstatOrNull(absolutePath);
  if (!stat) return false;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || Number(stat.dev) !== expectedIdentity.dev
    || Number(stat.ino) !== expectedIdentity.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `exclusive copy cleanup 保留了非本次创建的文件：${absolutePath}`
    );
  }
  const beforeUnlink = await lstatOrNull(absolutePath);
  if (
    !beforeUnlink
    || !beforeUnlink.isFile()
    || beforeUnlink.isSymbolicLink()
    || Number(beforeUnlink.dev) !== expectedIdentity.dev
    || Number(beforeUnlink.ino) !== expectedIdentity.ino
  ) {
    throw new MaintenanceShadowError(
      "cas_conflict",
      `exclusive copy cleanup 前 inode 已变化：${absolutePath}`
    );
  }
  await fsp.unlink(absolutePath);
  await syncDirectoryDurably(path.dirname(absolutePath));
  return true;
}

function casFromInspectedFile(
  inspected: InspectedFile
): MaintenanceShadowCasFile {
  return {
    kind: "file",
    sha256: inspected.sha256,
    size: inspected.size,
    mode: inspected.mode & 0o777
  };
}

function inspectedFileMatchesCas(
  inspected: InspectedFile,
  expected: MaintenanceShadowCasFile
): boolean {
  return inspected.sha256 === expected.sha256
    && inspected.size === expected.size
    && (inspected.mode & 0o777) === (expected.mode & 0o777);
}

async function assertPlainDirectoryRoot(inputPath: string, label: string): Promise<string> {
  const absolutePath = path.resolve(inputPath);
  const stat = await fsp.lstat(absolutePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MaintenanceShadowError("unsafe_entry", `${label} 必须是非 symlink 目录`);
  }
  const realPath = await fsp.realpath(absolutePath);
  return path.resolve(realPath);
}

async function ensurePlainStorageRoot(inputPath: string): Promise<string> {
  const absolutePath = path.resolve(inputPath);
  await fsp.mkdir(absolutePath, { recursive: true, mode: 0o700 });
  return await assertPlainDirectoryRoot(absolutePath, "Shadow storage root");
}

function assertSafeStorageLocation(
  liveVaultPath: string,
  storageRootPath: string,
  copiedRoots: readonly string[]
): void {
  const live = path.resolve(liveVaultPath);
  const storage = path.resolve(storageRootPath);
  const storageRelativeToLive = path.relative(live, storage);
  if (!storageRelativeToLive) {
    throw new MaintenanceShadowError("invalid_path", "Shadow storage 不能等于真实 Vault");
  }
  if (!storageRelativeToLive.startsWith(`..${path.sep}`) && storageRelativeToLive !== "..") {
    const relativeStorage = normalizeVaultRelativePath(storageRelativeToLive.split(path.sep).join("/"));
    if (copiedRoots.some((root) => pathsOverlap(relativeStorage, root))) {
      throw new MaintenanceShadowError(
        "invalid_path",
        `Shadow storage 不能落入会复制或写入的 Vault 路径：${relativeStorage}`,
        relativeStorage
      );
    }
    return;
  }

}

function assertAttemptId(input: string): string {
  const attemptId = input.trim();
  if (!attemptId || attemptId.length > 512 || /[\0-\x1f\x7f]/.test(attemptId)) {
    throw new MaintenanceShadowError("invalid_path", `非法 attemptId：${input}`);
  }
  return attemptId;
}

function attemptFilesystemToken(attemptId: string): string {
  const slug = attemptId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "attempt";
  const digest = createHash("sha256").update(attemptId).digest("hex").slice(0, 16);
  return `${slug}-${digest}`;
}

function normalizePathList(paths: readonly string[]): string[] {
  return uniqueSortedPaths(paths.map(normalizeVaultRelativePath));
}

function normalizeChunkedTextSources(
  sources: readonly MaintenanceShadowChunkedTextSource[]
): MaintenanceShadowChunkedTextSource[] {
  const seen = new Set<string>();
  const normalized = sources.map((source) => {
    const relativePath = normalizeVaultRelativePath(source.relativePath);
    if (seen.has(relativePath)) {
      throw new MaintenanceShadowError(
        "invalid_path",
        `重复的文本分块来源：${relativePath}`,
        relativePath
      );
    }
    if (
      !Number.isSafeInteger(source.maxChunkBytes)
      || source.maxChunkBytes < 4
    ) {
      throw new MaintenanceShadowError(
        "invalid_path",
        `非法文本分块上限：${source.maxChunkBytes}`,
        relativePath
      );
    }
    seen.add(relativePath);
    return { relativePath, maxChunkBytes: source.maxChunkBytes };
  });
  return normalized.sort((left, right) =>
    compareCanonicalText(left.relativePath, right.relativePath)
  );
}

function normalizeShadowLimits(input: Partial<MaintenanceShadowLimits> | undefined): MaintenanceShadowLimits {
  const limits: MaintenanceShadowLimits = {
    maxChangedFileBytes: input?.maxChangedFileBytes ?? DEFAULT_MAX_CHANGED_FILE_BYTES,
    maxChangedTotalBytes: input?.maxChangedTotalBytes ?? DEFAULT_MAX_CHANGED_TOTAL_BYTES,
    maxChangedFiles: input?.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new MaintenanceShadowError("invalid_path", `非法 Shadow limit ${name}=${value}`);
    }
  }
  return limits;
}

function normalizeVaultRelativePath(input: string): string {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) {
    throw new MaintenanceShadowError("invalid_path", `非法 Vault 相对路径：${String(input)}`);
  }
  const normalizedSeparators = input.trim().replaceAll("\\", "/");
  if (
    normalizedSeparators.startsWith("/")
    || /^[A-Za-z]:/.test(normalizedSeparators)
    || normalizedSeparators.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new MaintenanceShadowError("invalid_path", `Vault 路径必须是无越界片段的相对路径：${input}`);
  }
  return normalizedSeparators;
}

function resolveVaultRelativePath(vaultPath: string, relativePathInput: string): string {
  const relativePath = normalizeVaultRelativePath(relativePathInput);
  const absolutePath = path.resolve(vaultPath, ...relativePath.split("/"));
  const prefix = `${path.resolve(vaultPath)}${path.sep}`;
  if (!absolutePath.startsWith(prefix)) {
    throw new MaintenanceShadowError("invalid_path", `Vault 路径越界：${relativePath}`, relativePath);
  }
  return absolutePath;
}

function joinVaultRelativePath(parent: string, child: string): string {
  if (child.includes("/") || child.includes("\\") || child === "." || child === "..") {
    throw new MaintenanceShadowError("invalid_path", `非法目录项：${child}`);
  }
  return normalizeVaultRelativePath(`${parent}/${child}`);
}

function uniqueSortedPaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths)).sort(compareCanonicalText);
}

function canonicalAbsolutePaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths.map((entry) => path.resolve(entry))))
    .sort(compareCanonicalText);
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function minimalPathRoots(paths: readonly string[]): string[] {
  const sorted = uniqueSortedPaths(paths).sort((left, right) => {
    const depthDifference = left.split("/").length - right.split("/").length;
    return depthDifference || compareCanonicalText(left, right);
  });
  const roots: string[] = [];
  for (const candidate of sorted) {
    if (!isWithinAnyPath(candidate, roots)) roots.push(candidate);
  }
  return roots.sort(compareCanonicalText);
}

function isWithinAnyPath(relativePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isMaintenanceCommitPath(relativePath: string): boolean {
  return isWithinAnyPath(relativePath, MAINTENANCE_COMMIT_DIRECTORY_ROOTS);
}

function isPluginOwnedMaintenancePath(relativePath: string): boolean {
  return isWithinAnyPath(relativePath, MAINTENANCE_PLUGIN_OWNED_PATHS);
}

async function assertProtectedShadowRootMetadataUnchanged(
  manifest: MaintenanceShadowManifest,
  shadowBaseline: ReadonlyMap<string, MaintenanceShadowEntry>
): Promise<void> {
  const protectedRoots = uniqueSortedPaths([
    ...manifest.rawPaths,
    ...manifest.rulesPaths,
    ...MAINTENANCE_PLUGIN_OWNED_PATHS
  ]);
  for (const relativePath of protectedRoots) {
    const baseline = shadowBaseline.get(relativePath);
    const current = await lstatOrNull(resolveVaultRelativePath(manifest.shadowVaultPath, relativePath));
    const currentKind = current?.isFile()
      ? "file"
      : current?.isDirectory()
        ? "directory"
        : undefined;
    if (
      (!baseline && !current)
      || (
        baseline
        && current
        && baseline.kind === currentKind
        && baseline.mode === current.mode
      )
    ) {
      continue;
    }
    if (isWithinAnyPath(relativePath, manifest.rawPaths)) {
      throw new MaintenanceShadowError("raw_modified", `Agent 修改了 Raw：${relativePath}`, relativePath);
    }
    if (isWithinAnyPath(relativePath, manifest.rulesPaths)) {
      throw new MaintenanceShadowError(
        "readonly_modified",
        `Agent 修改了知识库规则：${relativePath}`,
        relativePath
      );
    }
    throw new MaintenanceShadowError(
      "readonly_modified",
      `Agent 修改了 plugin-owned 路径：${relativePath}`,
      relativePath
    );
  }
}

function assertChangesWithinLimits(
  changes: readonly MaintenanceShadowChange[],
  limits: MaintenanceShadowLimits
): void {
  if (changes.length > limits.maxChangedFiles) {
    throw new MaintenanceShadowError(
      "source_changed",
      `Shadow changeset 文件数超过上限：${changes.length}/${limits.maxChangedFiles}`
    );
  }
  let totalBytes = 0;
  for (const change of changes) {
    if (change.operation !== "upsert") continue;
    if (change.size > limits.maxChangedFileBytes) {
      throw new MaintenanceShadowError(
        "source_changed",
        `Shadow 文件超过单文件上限：${change.relativePath}`,
        change.relativePath
      );
    }
    totalBytes += change.size;
    if (totalBytes > limits.maxChangedTotalBytes) {
      throw new MaintenanceShadowError("source_changed", "Shadow changeset 总大小超过上限");
    }
  }
}

function directoryEntry(relativePath: string, stat: Stats): MaintenanceShadowEntry {
  return {
    relativePath,
    kind: "directory",
    mode: stat.mode,
    dev: Number(stat.dev),
    ino: Number(stat.ino)
  };
}

function fileEntry(
  relativePath: string,
  inspected: InspectedFile,
  identity: MaintenanceShadowFileIdentity = inspected
): MaintenanceShadowEntry {
  return {
    relativePath,
    kind: "file",
    mode: inspected.mode,
    size: inspected.size,
    sha256: inspected.sha256,
    dev: identity.dev,
    ino: identity.ino
  };
}

function entryMap(entries: readonly MaintenanceShadowEntry[]): Map<string, MaintenanceShadowEntry> {
  return new Map(entries.map((entry) => [entry.relativePath, entry]));
}

function sortedEntries(entries: Map<string, MaintenanceShadowEntry>): MaintenanceShadowEntry[] {
  return Array.from(entries.values()).sort((left, right) =>
    compareCanonicalText(left.relativePath, right.relativePath));
}

function compareCanonicalText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function changedEntryPaths(
  baseline: Map<string, MaintenanceShadowEntry>,
  current: Map<string, MaintenanceShadowEntry>,
  compareMode: boolean
): string[] {
  const paths = uniqueSortedPaths([...baseline.keys(), ...current.keys()]);
  return paths.filter((relativePath) => !sameEntry(baseline.get(relativePath), current.get(relativePath), compareMode));
}

function assertEntryMapsEqual(
  expected: Map<string, MaintenanceShadowEntry>,
  actual: Map<string, MaintenanceShadowEntry>,
  code: MaintenanceShadowErrorCode,
  message: string,
  compareMode = true
): void {
  const changed = changedEntryPaths(expected, actual, compareMode);
  if (changed.length) throw new MaintenanceShadowError(code, `${message}：${changed[0]}`, changed[0]);
}

function sameEntry(
  left: MaintenanceShadowEntry | undefined,
  right: MaintenanceShadowEntry | undefined,
  compareMode: boolean
): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  if (compareMode && (left.mode & 0o777) !== (right.mode & 0o777)) return false;
  if (
    left.dev !== undefined
    && left.ino !== undefined
    && right.dev !== undefined
    && right.ino !== undefined
    && (left.dev !== right.dev || left.ino !== right.ino)
  ) {
    return false;
  }
  if (left.kind === "directory") return true;
  return left.size === right.size && left.sha256 === right.sha256;
}

function sameOpenFileVersion(
  before: Stats,
  after: Stats
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino);
}

async function readManifest(handle: MaintenanceShadowHandle): Promise<MaintenanceShadowManifest> {
  const rootPath = path.resolve(handle.rootPath);
  const stat = await fsp.lstat(rootPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MaintenanceShadowError("manifest_corrupt", "Shadow root 不是安全目录");
  }
  const expectedManifestPath = path.join(rootPath, MANIFEST_FILE);
  const expectedVaultPath = path.join(rootPath, SHADOW_VAULT_DIRECTORY);
  if (
    path.resolve(handle.manifestPath) !== expectedManifestPath
    || path.resolve(handle.agentVaultPath) !== expectedVaultPath
  ) {
    throw new MaintenanceShadowError("manifest_corrupt", "Shadow handle 路径不一致");
  }
  const parsed = JSON.parse(
    (await readIndependentRegularFile(expectedManifestPath, "Shadow manifest", MAX_CONTROL_JSON_BYTES)).toString("utf8")
  ) as MaintenanceShadowManifest;
  if (
    parsed.version !== MANIFEST_VERSION
    || parsed.attemptId !== handle.attemptId
    || path.resolve(parsed.rootPath) !== rootPath
    || path.resolve(parsed.shadowVaultPath) !== expectedVaultPath
    || !Number.isSafeInteger(parsed.liveRootIdentity?.dev)
    || !Number.isSafeInteger(parsed.liveRootIdentity?.ino)
    || parsed.digest !== manifestDigest(parsed)
  ) {
    throw new MaintenanceShadowError("manifest_corrupt", "Shadow manifest 校验失败");
  }
  if (parsed.baselineDigest !== digestJson(parsed.liveBaseline)) {
    throw new MaintenanceShadowError("manifest_corrupt", "Shadow CAS baseline digest 校验失败");
  }
  if (parsed.shadowBaselineDigest !== digestJson(parsed.shadowBaseline)) {
    throw new MaintenanceShadowError("manifest_corrupt", "Shadow baseline digest 校验失败");
  }
  if (
    parsed.quarantine
    && (
      parsed.state !== "abandoned"
      || !isValidQuarantineRecord(parsed.quarantine)
      || parsed.quarantine.attemptId !== parsed.attemptId
      || parsed.quarantine.sealedManifestDigest === parsed.digest
      || parsed.quarantine.changeSetDigest !== parsed.sealedChangeSetDigest
    )
  ) {
    throw new MaintenanceShadowError("manifest_corrupt", "Shadow quarantine record 校验失败");
  }
  return parsed;
}

function assertManifestState(
  manifest: MaintenanceShadowManifest,
  allowedStates: readonly MaintenanceShadowState[]
): void {
  if (!allowedStates.includes(manifest.state)) {
    throw new MaintenanceShadowError(
      "invalid_state",
      `Shadow 当前状态 ${manifest.state} 不允许此操作，期望 ${allowedStates.join("/")}`
    );
  }
}

function withManifestDigest(
  manifest: Omit<MaintenanceShadowManifest, "digest">
): MaintenanceShadowManifest {
  return { ...manifest, digest: digestJson(manifest) };
}

function withoutManifestDigest(
  manifest: MaintenanceShadowManifest
): Omit<MaintenanceShadowManifest, "digest"> {
  const { digest: _digest, ...rest } = manifest;
  return rest;
}

function manifestDigest(manifest: MaintenanceShadowManifest): string {
  return digestJson(withoutManifestDigest(manifest));
}

async function writeManifest(manifestPath: string, manifest: MaintenanceShadowManifest): Promise<void> {
  await writeJsonAtomic(manifestPath, manifest);
}

async function writeJsonAtomic(absolutePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  const tempPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  const handle = await fsp.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tempPath, absolutePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectoryDurably(directoryPath: string): Promise<void> {
  let directory: fsp.FileHandle | undefined;
  try {
    directory = await fsp.open(directoryPath, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not expose fsync for directories. The subsequent independent
    // read-back remains mandatory there; supported platforms must fsync.
    if (process.platform !== "win32" || !["EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function assertValidChangeSet(changeSet: MaintenanceShadowChangeSet): void {
  if (
    !changeSet
    || changeSet.version !== CHANGESET_VERSION
    || !Array.isArray(changeSet.changes)
    || !isSha256(changeSet.liveVaultFingerprint)
    || !isSha256(changeSet.baselineDigest)
    || typeof changeSet.shadowVaultPath !== "string"
    || typeof changeSet.controlRootPath !== "string"
    || typeof changeSet.sealedBlobRootPath !== "string"
    || !Array.isArray(changeSet.excludedPluginOwnedPaths)
    || changeSet.digest !== changeSetDigest(changeSet)
  ) {
    throw new MaintenanceShadowError("changeset_corrupt", "Shadow changeset digest 校验失败");
  }
  const seen = new Set<string>();
  for (const change of changeSet.changes) {
    const relativePath = normalizeVaultRelativePath(change.relativePath);
    if (seen.has(relativePath)) {
      throw new MaintenanceShadowError("changeset_corrupt", `changeset 路径重复：${relativePath}`, relativePath);
    }
    seen.add(relativePath);
    if (isPluginOwnedMaintenancePath(relativePath)) {
      throw new MaintenanceShadowError("changeset_corrupt", `plugin-owned 路径不能进入 changeset：${relativePath}`);
    }
    if (change.operation !== "upsert" && change.operation !== "delete") {
      throw new MaintenanceShadowError("changeset_corrupt", `未知 changeset 操作：${relativePath}`, relativePath);
    }
    if (
      !change.expectedLive
      || (change.expectedLive.kind !== "file" && change.expectedLive.kind !== "missing")
      || (change.operation === "delete" && change.expectedLive.kind !== "file")
    ) {
      throw new MaintenanceShadowError("changeset_corrupt", `无效 CAS baseline：${relativePath}`, relativePath);
    }
    const relativeDirectory = path.posix.dirname(relativePath);
    const parentSegments = relativeDirectory === "." ? [] : relativeDirectory.split("/");
    if (
      !Array.isArray(change.expectedParentChain)
      || !change.expectedParentChain.length
      || change.expectedParentChain.length > parentSegments.length + 1
      || change.expectedParentChain.some((identity, index) => (
        identity.relativePath !== (
          index === 0
            ? "."
            : parentSegments.slice(0, index).join("/")
        )
        || !Number.isSafeInteger(identity.dev)
        || !Number.isSafeInteger(identity.ino)
      ))
    ) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `无效父目录 inode baseline：${relativePath}`,
        relativePath
      );
    }
    const requiredMissingParent = change.expectedParentChain.length < parentSegments.length + 1
      ? parentSegments
        .slice(0, change.expectedParentChain.length)
        .join("/")
      : undefined;
    if (change.expectedMissingParentPath !== requiredMissingParent) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `无效父目录 missing baseline：${relativePath}`,
        relativePath
      );
    }
    if (
      change.expectedLive.kind === "file"
      && (!isSha256(change.expectedLive.sha256)
        || !Number.isSafeInteger(change.expectedLive.size)
        || change.expectedLive.size < 0
        || !Number.isSafeInteger(change.expectedLive.mode)
        || !Number.isSafeInteger(change.expectedLiveIdentity?.dev)
        || !Number.isSafeInteger(change.expectedLiveIdentity?.ino))
    ) {
      throw new MaintenanceShadowError("changeset_corrupt", `无效 CAS hash：${relativePath}`, relativePath);
    }
    if (
      change.expectedLive.kind === "missing"
      && change.expectedLiveIdentity !== undefined
    ) {
      throw new MaintenanceShadowError(
        "changeset_corrupt",
        `missing CAS 不能携带文件 inode：${relativePath}`,
        relativePath
      );
    }
    if (
      change.operation === "upsert"
      && (
        !isSha256(change.shadowSha256)
        || !Number.isSafeInteger(change.size)
        || change.size < 0
        || change.blobRelativePath !== `${change.shadowSha256.slice("sha256:".length)}.blob`
      )
    ) {
      throw new MaintenanceShadowError("changeset_corrupt", `无效 Shadow hash：${relativePath}`, relativePath);
    }
  }
  for (const excludedPath of changeSet.excludedPluginOwnedPaths) {
    const normalized = normalizeVaultRelativePath(excludedPath);
    if (!isPluginOwnedMaintenancePath(normalized)) {
      throw new MaintenanceShadowError("changeset_corrupt", `无效 plugin-owned 排除路径：${normalized}`);
    }
  }
}

function assertValidTransportConfigReceipt(
  receipt: MaintenanceShadowTransportConfigReceipt
): void {
  if (
    !receipt
    || receipt.version !== 1
    || !Array.isArray(receipt.enforcedWritableRootPaths)
    || !Array.isArray(receipt.enforcedDeniedShadowPaths)
  ) {
    throw new MaintenanceShadowError("invalid_state", "transport-config receipt 无效或 digest 不匹配");
  }
  const canonicalWritable = canonicalAbsolutePaths(receipt.enforcedWritableRootPaths);
  const canonicalDenied = canonicalAbsolutePaths(receipt.enforcedDeniedShadowPaths);
  if (
    receipt.version !== 1
    || typeof receipt.backend !== "string"
    || !receipt.backend.trim()
    || receipt.backend.length > 512
    || typeof receipt.attemptId !== "string"
    || receipt.attemptId !== receipt.attemptId.trim()
    || !receipt.attemptId
    || receipt.attemptId.length > 512
    || /[\0-\x1f\x7f]/.test(receipt.attemptId)
    || typeof receipt.leaseId !== "string"
    || !receipt.leaseId.trim()
    || receipt.leaseId.length > 512
    || !receipt.enforcedWritableRootPaths.length
    || !stringArraysEqual(receipt.enforcedWritableRootPaths, canonicalWritable)
    || !receipt.enforcedDeniedShadowPaths.length
    || !stringArraysEqual(receipt.enforcedDeniedShadowPaths, canonicalDenied)
    || typeof receipt.deniedLiveVaultPath !== "string"
    || receipt.deniedLiveVaultPath !== path.resolve(receipt.deniedLiveVaultPath)
    || typeof receipt.deniedControlPath !== "string"
    || receipt.deniedControlPath !== path.resolve(receipt.deniedControlPath)
    || typeof receipt.transportAck !== "string"
    || !receipt.transportAck.trim()
    || receipt.transportAck.length > 4096
    || !isSha256(receipt.transportConfigDigest)
    || typeof receipt.issuedAt !== "string"
    || Number.isNaN(Date.parse(receipt.issuedAt))
    || !isSha256(receipt.digest)
    || receipt.digest !== transportConfigReceiptDigest(receipt)
  ) {
    throw new MaintenanceShadowError("invalid_state", "transport-config receipt 无效或 digest 不匹配");
  }
}

function transportConfigReceiptDigest(
  receipt: MaintenanceShadowTransportConfigReceipt
): string {
  return digestJson({
    version: receipt.version,
    backend: receipt.backend,
    attemptId: receipt.attemptId,
    leaseId: receipt.leaseId,
    enforcedWritableRootPaths: receipt.enforcedWritableRootPaths,
    enforcedDeniedShadowPaths: receipt.enforcedDeniedShadowPaths,
    deniedLiveVaultPath: receipt.deniedLiveVaultPath,
    deniedControlPath: receipt.deniedControlPath,
    transportAck: receipt.transportAck,
    transportConfigDigest: receipt.transportConfigDigest,
    issuedAt: receipt.issuedAt
  });
}

/**
 * Stable binding shared with the maintenance Runner when it persists an exact
 * Adapter fence into the Shadow control manifest.
 */
export function maintenanceExactWriteFenceBindingDigest(
  receipt: AgentExactWriteFenceReceipt
): string {
  return exactWriteFenceBindingDigest(receipt);
}

function exactWriteFenceBindingDigest(receipt: AgentExactWriteFenceReceipt): string {
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

async function assertExactFenceBindsSealedShadow(
  manifest: MaintenanceShadowManifest,
  liveVaultPath: string,
  receipt: AgentExactWriteFenceReceipt
): Promise<void> {
  if (!isTrustedExactWriteFenceReceipt(receipt)) {
    throw new MaintenanceShadowError("invalid_state", "exact write-fence receipt 不是 trusted issuer 签发");
  }
  const fence = manifest.writeFence;
  if (!fence || fence.enforcement !== "transport-config") {
    throw new MaintenanceShadowError(
      "invalid_state",
      "quarantine 必须绑定 prompt 前 transport-config write fence"
    );
  }
  assertValidTransportConfigReceipt(fence);
  const exactBindingDigest = exactWriteFenceBindingDigest(receipt);
  const expectedDeniedControlPaths = canonicalAbsolutePaths([fence.deniedControlPath]);
  const receiptDeniedControlPaths = canonicalAbsolutePaths(receipt.deniedControlPaths);
  let deniesSameLiveVault = false;
  for (const deniedLivePath of receipt.deniedLivePaths) {
    try {
      if (await assertPlainDirectoryRoot(deniedLivePath, "exact fence denied live Vault") === liveVaultPath) {
        deniesSameLiveVault = true;
        break;
      }
    } catch {
      // A missing/unsafe deny target cannot prove the current live Vault.
    }
  }
  const mismatches = [
    receipt.attemptToken !== manifest.attemptId ? "attempt" : "",
    receipt.backend !== fence.backend ? "backend" : "",
    receipt.leaseToken !== fence.leaseId ? "lease" : "",
    receipt.configuredAt !== fence.issuedAt ? "configuredAt" : "",
    !stringArraysEqual(
      canonicalAbsolutePaths(receipt.enforcedWritableRoots),
      fence.enforcedWritableRootPaths
    ) ? "writable-roots" : "",
    !deniesSameLiveVault ? "live-deny" : "",
    !expectedDeniedControlPaths.every((entry) => receiptDeniedControlPaths.includes(entry))
      ? "control-deny"
      : "",
    fence.transportConfigDigest !== exactBindingDigest ? "config-digest" : ""
  ].filter(Boolean);
  if (mismatches.length) {
    throw new MaintenanceShadowError(
      "invalid_state",
      `exact write-fence 与 durable Shadow attempt/lease/path/digest 不一致：${mismatches.join(", ")}`
    );
  }
}

function boundedQuarantineReason(reason: string): string {
  const normalized = reason.trim() || "unspecified";
  if (normalized.length > 4_096 || /[\0]/.test(normalized)) {
    throw new MaintenanceShadowError("invalid_state", "quarantine reason 超出安全边界");
  }
  return normalized;
}

function quarantineRecordDigest(record: MaintenanceShadowQuarantineRecord): string {
  const { digest: _digest, ...base } = record;
  return digestJson(base);
}

function isValidQuarantineRecord(record: MaintenanceShadowQuarantineRecord): boolean {
  return record.version === 1
    && typeof record.attemptId === "string"
    && Boolean(record.attemptId.trim())
    && (record.backend === "codex-cli" || record.backend === "opencode" || record.backend === "hermes")
    && typeof record.leaseToken === "string"
    && Boolean(record.leaseToken.trim())
    && /^[a-f0-9]{64}$/.test(record.writeFenceConfigAckDigest)
    && isSha256(record.exactWriteFenceBindingDigest)
    && isSha256(record.sealedManifestDigest)
    && isSha256(record.changeSetDigest)
    && isSha256(record.zeroResultDigest)
    && typeof record.quarantinedAt === "string"
    && !Number.isNaN(Date.parse(record.quarantinedAt))
    && typeof record.reason === "string"
    && Boolean(record.reason.trim())
    && record.reason.length <= 4_096
    && isSha256(record.digest)
    && record.digest === quarantineRecordDigest(record);
}

function changeSetDigest(changeSet: MaintenanceShadowChangeSet): string {
  const { digest: _digest, ...base } = changeSet;
  return digestJson(base);
}

function isSha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function digestJson(value: unknown): string {
  return hashBuffer(Buffer.from(stableStringify(value), "utf8"));
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

function hashBuffer(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function writeFileHandleFully(handle: fsp.FileHandle, content: Buffer): Promise<void> {
  let offset = 0;
  while (offset < content.byteLength) {
    const { bytesWritten } = await handle.write(content, offset, content.byteLength - offset, null);
    if (!bytesWritten) throw new Error("无法继续写入 Shadow 文件");
    offset += bytesWritten;
  }
}

function vaultFingerprint(liveVaultPath: string): string {
  return hashBuffer(Buffer.from(path.resolve(liveVaultPath), "utf8"));
}

async function lstatOrNull(absolutePath: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
