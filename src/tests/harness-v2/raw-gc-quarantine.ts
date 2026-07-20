import * as assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import {
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  prepareEchoInkRecordMutationRuntimeRoots
} from "../../harness/lifecycle/record-mutation-production";
import {
  RAW_GC_MINIMUM_QUARANTINE_MS,
  RawGcQuarantineError,
  authorizeAndPurgeRawGcQuarantine,
  beginRawGcQuarantine,
  recoverStartedRawGcQuarantines,
  type RawGcQuarantineRoots,
  type RawGcStableOwnerAuthority
} from "../../harness/records/raw-gc-quarantine";
import {
  inventoryRawGcPreview
} from "../../harness/records/conversation-record-inventory";
import {
  scanStorageInventory
} from "../../harness/records/storage-inventory";
import {
  pluginDataDir,
  rawStorageDir,
  writeRawText
} from "../../core/raw-message-store";
import type {
  ChatMessage,
  StoredSession
} from "../../settings/settings";

const BASE_TIME = 1_721_260_800_000;
const PLUGIN_DIR = "codex-echoink";
const OWNER_AUTHORITY: RawGcStableOwnerAuthority = {
  async withStableOwners<T>(action: () => Promise<T>): Promise<T> {
    return await action();
  }
};

export async function runHarnessV2RawGcQuarantineTests():
Promise<void> {
  await assertQuarantinePublishesPlanBeforeRecoverableMove();
  await assertInventoryDriftBlocksBeforeJournalCreation();
  await assertRecoveryRejectsReplacedPendingSourceIdentity();
  await assertSevenDayGateAndSecondOwnerScan();
  await assertPurgeIsRecoverableAndDoesNotAutoAuthorize();
  await assertPurgeUnlinkCrashRollsForward();
  await assertChangedTrashBytesBlockPurgeBeforeFirstUnlink();
}

async function assertQuarantinePublishesPlanBeforeRecoverableMove():
Promise<void> {
  await withVault("recoverable-move", async (vaultPath) => {
    const fixture = await quarantineFixture(vaultPath, "recoverable.txt");
    let injected = false;
    await assert.rejects(
      () => beginRawGcQuarantine({
        ...fixture.beginInput,
        faultInjector(point) {
          if (point === "after-source-quarantined" && !injected) {
            injected = true;
            throw new Error("crash after source quarantine");
          }
        }
      }),
      /crash after source quarantine/
    );
    assert.equal(
      await fileExists(path.join(
        rawStorageDir(vaultPath, PLUGIN_DIR),
        "recoverable.txt"
      )),
      false,
      "source move may happen only after the immutable plan and Trash prepare"
    );
    assert.equal(
      await recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + 100
      }),
      1
    );
    assert.equal(
      await recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + 200
      }),
      0,
      "completed quarantine recovery must be idempotent"
    );
    const trashTextFiles = await listFiles(
      fixture.roots.trashRootPath,
      ".txt"
    );
    assert.equal(trashTextFiles.length, 2);
    assert.equal(
      await readFile(trashTextFiles[0], "utf8"),
      "recoverable raw bytes"
    );
    assert.equal(
      await readFile(trashTextFiles[1], "utf8"),
      "recoverable raw bytes"
    );
    const inventory = await scanStorageInventory({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      nativeScope: "none",
      now: () => BASE_TIME + 300
    });
    const source = inventory.sources.find((candidate) =>
      candidate.sourceId === "raw-gc-quarantine"
    );
    assert.equal(source?.status, "scanned");
    assert.equal(source?.recordCount, 1);
    const serialized = JSON.stringify(inventory);
    assert.doesNotMatch(serialized, /raw-gc-recoverable/);
    assert.doesNotMatch(serialized, /recoverable\.txt/);
  });
}

async function assertInventoryDriftBlocksBeforeJournalCreation():
Promise<void> {
  await withVault("drift", async (vaultPath) => {
    const fixture = await quarantineFixture(vaultPath, "drift.txt");
    await writeFile(
      path.join(rawStorageDir(vaultPath, PLUGIN_DIR), "drift.txt"),
      "changed after preview",
      "utf8"
    );
    await assert.rejects(
      () => beginRawGcQuarantine(fixture.beginInput),
      (error: unknown) =>
        error instanceof RawGcQuarantineError
        && error.code === "inventory-drift"
    );
    assert.equal(
      await fileExists(path.join(
        rawStorageDir(vaultPath, PLUGIN_DIR),
        "drift.txt"
      )),
      true
    );
    assert.equal(
      await namespaceTransactionCount(
        fixture.roots.storageRootPath
      ),
      0,
      "a stale confirmation must not publish a destructive plan"
    );
  });
}

async function assertSevenDayGateAndSecondOwnerScan():
Promise<void> {
  await withVault("owner-rescan", async (vaultPath) => {
    const fixture = await quarantineFixture(vaultPath, "owner.txt");
    await beginRawGcQuarantine(fixture.beginInput);
    await assert.rejects(
      () => authorizeAndPurgeRawGcQuarantine({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        transactionId: fixture.transactionId,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS - 1
      }),
      (error: unknown) =>
        error instanceof RawGcQuarantineError
        && error.code === "quarantine-too-young"
    );

    await persistCanonicalConversation(
      vaultPath,
      canonicalSession(vaultPath, "late-owner", [{
        id: "late-owner-message",
        role: "assistant",
        text: "preview",
        rawRef: "raw/owner.txt",
        rawSize: 20,
        rawLines: 1,
        rawTruncatedForPreview: true,
        createdAt: BASE_TIME + 1
      }])
    );
    await assert.rejects(
      () => authorizeAndPurgeRawGcQuarantine({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        transactionId: fixture.transactionId,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS
      }),
      (error: unknown) =>
        error instanceof RawGcQuarantineError
        && error.code === "inventory-blocked"
    );
    assert.equal(
      (await listFiles(fixture.roots.trashRootPath, ".txt")).length,
      2,
      "a new owner must retain both recoverable Trash copies"
    );
  });
}

async function assertRecoveryRejectsReplacedPendingSourceIdentity():
Promise<void> {
  await withVault("pending-source-replaced", async (vaultPath) => {
    await persistCanonicalConversation(
      vaultPath,
      canonicalSession(vaultPath, "replacement-authority", [])
    );
    for (const fileName of ["first.txt", "second.txt"]) {
      await writeRawText(
        vaultPath,
        `raw/${fileName}`,
        `${fileName}-original`,
        PLUGIN_DIR
      );
    }
    const preview = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME
    });
    assert.equal(preview.status, "ready");
    assert.equal(preview.quarantineCandidateCount, 2);
    const roots = await rawGcRoots(vaultPath);
    const transactionId = "raw-gc-pending-source-replaced";
    let injected = false;
    await assert.rejects(
      () => beginRawGcQuarantine({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        transactionId,
        expectedPreviewDigest: preview.snapshotDigest,
        selectedSubjectRefs: preview.subjects
          .filter((subject) => subject.eligibleForQuarantine)
          .map((subject) => subject.subjectRef),
        confirmedAt: BASE_TIME,
        roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME,
        faultInjector(point, ordinal) {
          if (
            point === "after-source-quarantined-progress"
            && ordinal === 0
            && !injected
          ) {
            injected = true;
            throw new Error("crash before second candidate");
          }
        }
      }),
      /crash before second candidate/
    );
    const remaining = await listFiles(
      rawStorageDir(vaultPath, PLUGIN_DIR),
      ".txt"
    );
    assert.equal(remaining.length, 1);
    const before = await stat(remaining[0]);
    const original = await readFile(remaining[0], "utf8");
    const replacement = original.replace(/./g, "x");
    assert.equal(replacement.length, original.length);
    await unlink(remaining[0]);
    await writeFile(remaining[0], replacement, "utf8");
    await utimes(remaining[0], before.atime, before.mtime);
    await assert.rejects(
      () => recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + 1
      }),
      (error: unknown) =>
        error instanceof RawGcQuarantineError
        && error.code === "inventory-drift"
    );
    assert.equal(await readFile(remaining[0], "utf8"), replacement);
  });
}

async function assertPurgeIsRecoverableAndDoesNotAutoAuthorize():
Promise<void> {
  await withVault("purge-recovery", async (vaultPath) => {
    const fixture = await quarantineFixture(vaultPath, "purge.txt");
    await beginRawGcQuarantine(fixture.beginInput);
    assert.equal(
      await recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS + 1
      }),
      0,
      "startup must not turn elapsed time into purge authorization"
    );
    let injected = false;
    await assert.rejects(
      () => authorizeAndPurgeRawGcQuarantine({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        transactionId: fixture.transactionId,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS + 2,
        faultInjector(point) {
          if (point === "after-purge-authorization" && !injected) {
            injected = true;
            throw new Error("crash after purge authorization");
          }
        }
      }),
      /crash after purge authorization/
    );
    assert.equal(
      (await listFiles(fixture.roots.trashRootPath, ".txt")).length,
      2
    );
    assert.equal(
      await recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS + 3
      }),
      1
    );
    assert.equal(
      (await listFiles(fixture.roots.trashRootPath, ".txt")).length,
      0
    );
    assert.equal(
      await recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS + 4
      }),
      0
    );
  });
}

async function assertChangedTrashBytesBlockPurgeBeforeFirstUnlink():
Promise<void> {
  await withVault("trash-change", async (vaultPath) => {
    const fixture = await quarantineFixture(vaultPath, "changed.txt");
    await beginRawGcQuarantine(fixture.beginInput);
    const retired = (await listFiles(
      fixture.roots.trashRootPath,
      ".txt"
    )).find((value) => value.includes(`${path.sep}retired${path.sep}`));
    assert.ok(retired);
    await writeFile(retired, "tampered retirement bytes", "utf8");
    await assert.rejects(
      () => authorizeAndPurgeRawGcQuarantine({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        transactionId: fixture.transactionId,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS
      }),
      (error: unknown) =>
        error instanceof RawGcQuarantineError
        && error.code === "effect-conflict"
    );
    assert.equal(
      (await listFiles(fixture.roots.trashRootPath, ".txt")).length,
      2,
      "both copies must remain when preflight detects changed bytes"
    );
  });
}

async function assertPurgeUnlinkCrashRollsForward():
Promise<void> {
  await withVault("purge-unlink-crash", async (vaultPath) => {
    const fixture = await quarantineFixture(vaultPath, "unlink-crash.txt");
    await beginRawGcQuarantine(fixture.beginInput);
    let injected = false;
    await assert.rejects(
      () => authorizeAndPurgeRawGcQuarantine({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        transactionId: fixture.transactionId,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS,
        faultInjector(point) {
          if (point === "after-retired-source-unlink" && !injected) {
            injected = true;
            throw new Error("crash after retired source unlink");
          }
        }
      }),
      /crash after retired source unlink/
    );
    assert.equal(
      (await listFiles(fixture.roots.trashRootPath, ".txt")).length,
      0
    );
    assert.equal(
      await recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS + 1
      }),
      1
    );
    assert.equal(
      await recoverStartedRawGcQuarantines({
        vaultPath,
        pluginDir: PLUGIN_DIR,
        roots: fixture.roots,
        ownerAuthority: OWNER_AUTHORITY,
        now: () => BASE_TIME + RAW_GC_MINIMUM_QUARANTINE_MS + 2
      }),
      0
    );
  });
}

async function quarantineFixture(
  vaultPath: string,
  fileName: string
): Promise<{
  transactionId: string;
  roots: RawGcQuarantineRoots;
  beginInput: Parameters<typeof beginRawGcQuarantine>[0];
}> {
  await persistCanonicalConversation(
    vaultPath,
    canonicalSession(vaultPath, "conversation-owner-authority", [])
  );
  await writeRawText(
    vaultPath,
    `raw/${fileName}`,
    fileName === "recoverable.txt"
      ? "recoverable raw bytes"
      : `${fileName} raw bytes`,
    PLUGIN_DIR
  );
  const preview = await inventoryRawGcPreview({
    vaultPath,
    pluginDir: PLUGIN_DIR,
    now: () => BASE_TIME
  });
  assert.equal(preview.status, "ready");
  assert.equal(preview.quarantineCandidateCount, 1);
  const selectedSubjectRefs = preview.subjects
    .filter((subject) => subject.eligibleForQuarantine)
    .map((subject) => subject.subjectRef);
  const roots = await rawGcRoots(vaultPath);
  const transactionId = `raw-gc-${fileName.replace(".txt", "")}`;
  return {
    transactionId,
    roots,
    beginInput: {
      vaultPath,
      pluginDir: PLUGIN_DIR,
      transactionId,
      expectedPreviewDigest: preview.snapshotDigest,
      selectedSubjectRefs,
      confirmedAt: BASE_TIME,
      roots,
      ownerAuthority: OWNER_AUTHORITY,
      now: () => BASE_TIME
    }
  };
}

async function rawGcRoots(
  vaultPath: string
): Promise<RawGcQuarantineRoots> {
  const prepared = await prepareEchoInkRecordMutationRuntimeRoots({
    vaultPath,
    pluginDir: PLUGIN_DIR,
    rootIds: [
      ECHOINK_RECORD_MUTATION_ROOT_IDS.raw,
      ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
    ],
    createdAt: BASE_TIME
  });
  const raw = prepared.roots.find((root) =>
    root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.raw
  );
  const trash = prepared.roots.find((root) =>
    root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
  );
  assert.ok(raw);
  assert.ok(trash);
  return {
    storageRootPath: prepared.storageRootPath,
    sourceRootPath: raw.rootPath,
    sourceBoundaryRootPath: raw.boundaryRootPath,
    sourceRootBinding: raw.rootBinding,
    trashRootPath: trash.rootPath,
    trashBoundaryRootPath: trash.boundaryRootPath,
    trashRootBinding: trash.rootBinding
  };
}

async function persistCanonicalConversation(
  vaultPath: string,
  value: StoredSession
): Promise<void> {
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  await store.createPristineSession({
    ...value,
    messages: [],
    contextSnapshot: undefined,
    rollingSummary: undefined
  });
  await store.upsertSession(value);
}

function canonicalSession(
  vaultPath: string,
  id: string,
  messages: ChatMessage[]
): StoredSession {
  return {
    id,
    title: id,
    kind: "chat",
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: `context-${id}`,
    commitId: `commit-${id}`,
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME
  };
}

async function namespaceTransactionCount(
  storageRootPath: string
): Promise<number> {
  const namespace = path.join(
    storageRootPath,
    "raw-gc-quarantine-transactions-v1"
  );
  const entries = await readdir(namespace, {
    withFileTypes: true
  }).catch(() => []);
  return entries.filter((entry) =>
    entry.name !== ".staging"
  ).length;
}

async function listFiles(
  rootPath: string,
  suffix: string
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(absolutePath);
      }
    }
  };
  await visit(rootPath);
  return files.sort((left, right) => left.localeCompare(right));
}

async function fileExists(absolutePath: string): Promise<boolean> {
  return await readFile(absolutePath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  );
}

async function withVault(
  label: string,
  action: (vaultPath: string) => Promise<void>
): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), `echoink-raw-gc-${label}-`)
  );
  try {
    await action(vaultPath);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

if (process.env.ECHOINK_RUN_RAW_GC_QUARANTINE_TEST === "1") {
  runHarnessV2RawGcQuarantineTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
