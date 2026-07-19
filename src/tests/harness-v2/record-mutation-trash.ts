import * as assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  finalizeRecordMutationTrash,
  judgeRecordMutationTrashRestore,
  parseRecordMutationTrashFinalizationReceipt,
  parseRecordMutationTrashReceipt,
  restoreRecordMutationTrash,
  stageRecordMutationTrash,
  RecordMutationTrashError
} from "../../harness/lifecycle/record-mutation-trash";

export async function runHarnessV2RecordMutationTrashTests(): Promise<void> {
  await assertCopyAndMoveUseRootRelativeReceipts();
  await assertFinalizeResumesAfterSourceRetirement();
  await assertRestoreRequiresExactContentAndKeepsTrashEvidence();
  await assertNestedDirectoryRoundTripsWithEmptyDirectories();
  await assertPathEscapeSymlinkAndFutureReceiptFailClosed();
  await assertNestedSymlinkAndSpecialEntryFailClosed();
}

async function assertFinalizeResumesAfterSourceRetirement(): Promise<void> {
  await withFixture(
    "finalize-replay",
    async ({ sourceRootPath, trashRootPath }) => {
      const sourcePath = path.join(sourceRootPath, "payload.json");
      await writeFile(sourcePath, "durable payload\n");
      const roots = {
        sourceRootPath,
        sourceRootId: "conversation-store",
        trashRootPath,
        trashRootId: "record-trash"
      };
      const receipt = await stageRecordMutationTrash({
        mutationId: "mutation-finalize-replay",
        sourceRelativePath: "payload.json",
        transfer: "move",
        stagedAt: 1_721_260_800_000,
        ...roots
      });
      const retirementPath = path.join(
        trashRootPath,
        receipt.locator.retirementRelativePath
      );
      await mkdir(path.dirname(retirementPath), { recursive: true });
      await rename(sourcePath, retirementPath);

      const finalized = await finalizeRecordMutationTrash({
        receipt,
        finalizedAt: 1_721_260_800_010,
        ...roots
      });
      assert.equal(finalized.sourceDisposition, "retired");
      assert.deepEqual(
        await finalizeRecordMutationTrash({
          receipt,
          finalizedAt: 1_721_260_800_020,
          ...roots
        }),
        finalized,
        "finalize must replay after a crash between retirement and receipt publish"
      );
    }
  );
}

async function assertCopyAndMoveUseRootRelativeReceipts(): Promise<void> {
  await withFixture("copy-move", async ({ sourceRootPath, trashRootPath }) => {
    await mkdir(path.join(sourceRootPath, "nested"), { recursive: true });
    await writeFile(path.join(sourceRootPath, "nested", "copy.jsonl"), "copy payload\n");
    await writeFile(path.join(sourceRootPath, "nested", "move.jsonl"), "move payload\n");

    const copied = await stageRecordMutationTrash({
      mutationId: "mutation-copy",
      sourceRootPath,
      sourceRootId: "conversation-store",
      sourceRelativePath: "nested/copy.jsonl",
      trashRootPath,
      trashRootId: "record-trash",
      transfer: "copy",
      stagedAt: 1_721_260_800_000
    });
    assert.equal(copied.sourceDisposition, "retained");
    assert.equal(await readFile(path.join(sourceRootPath, "nested", "copy.jsonl"), "utf8"), "copy payload\n");
    assert.equal(
      await readFile(path.join(trashRootPath, copied.locator.trashRelativePath), "utf8"),
      "copy payload\n"
    );
    assert.equal(path.isAbsolute(copied.locator.sourceRelativePath), false);
    assert.equal(path.isAbsolute(copied.locator.trashRelativePath), false);
    assert.deepEqual(parseRecordMutationTrashReceipt(copied), copied);
    assert.deepEqual(
      parseRecordMutationTrashReceipt(JSON.parse(
        await readFile(
          path.join(trashRootPath, copied.locator.receiptRelativePath),
          "utf8"
        )
      )),
      copied,
      "prepare must durably publish its receipt"
    );

    const moveInput = {
      mutationId: "mutation-move",
      sourceRootPath,
      sourceRootId: "conversation-store",
      sourceRelativePath: "nested/move.jsonl",
      trashRootPath,
      trashRootId: "record-trash",
      transfer: "move" as const,
      stagedAt: 1_721_260_800_010
    };
    const [moved, concurrentPrepared] = await Promise.all([
      stageRecordMutationTrash(moveInput),
      stageRecordMutationTrash(moveInput)
    ]);
    assert.deepEqual(
      concurrentPrepared,
      moved,
      "same-path concurrent prepare must serialize and replay one receipt"
    );
    assert.equal(moved.sourceDisposition, "retained");
    assert.equal(
      await readFile(path.join(sourceRootPath, "nested", "move.jsonl"), "utf8"),
      "move payload\n",
      "prepare must retain source even when legacy transfer is move"
    );
    assert.equal(
      await readFile(path.join(trashRootPath, moved.locator.trashRelativePath), "utf8"),
      "move payload\n"
    );

    const [finalized, concurrentFinalized] = await Promise.all([
      finalizeRecordMutationTrash({
        receipt: moved,
        sourceRootPath,
        sourceRootId: "conversation-store",
        trashRootPath,
        trashRootId: "record-trash",
        finalizedAt: 1_721_260_800_020
      }),
      finalizeRecordMutationTrash({
        receipt: moved,
        sourceRootPath,
        sourceRootId: "conversation-store",
        trashRootPath,
        trashRootId: "record-trash",
        finalizedAt: 1_721_260_800_020
      })
    ]);
    assert.deepEqual(
      concurrentFinalized,
      finalized,
      "same-path concurrent finalize must serialize and replay one receipt"
    );
    assert.deepEqual(
      parseRecordMutationTrashFinalizationReceipt(finalized),
      finalized
    );
    await assert.rejects(
      () => readFile(path.join(sourceRootPath, "nested", "move.jsonl")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    assert.equal(
      await readFile(
        path.join(trashRootPath, moved.locator.retirementRelativePath),
        "utf8"
      ),
      "move payload\n",
      "finalize must retain controlled retirement evidence"
    );
    assert.deepEqual(
      await finalizeRecordMutationTrash({
        receipt: moved,
        sourceRootPath,
        sourceRootId: "conversation-store",
        trashRootPath,
        trashRootId: "record-trash",
        finalizedAt: 1_721_260_800_030
      }),
      finalized,
      "finalize must be idempotent"
    );
  });
}

async function assertRestoreRequiresExactContentAndKeepsTrashEvidence(): Promise<void> {
  await withFixture("restore", async ({ sourceRootPath, trashRootPath }) => {
    await writeFile(path.join(sourceRootPath, "payload.json"), "original\n");
    const receipt = await stageRecordMutationTrash({
      mutationId: "mutation-restore",
      sourceRootPath,
      sourceRootId: "conversation-store",
      sourceRelativePath: "payload.json",
      trashRootPath,
      trashRootId: "record-trash",
      transfer: "move",
      stagedAt: 1_721_260_800_000
    });
    const roots = {
      sourceRootPath,
      sourceRootId: "conversation-store",
      trashRootPath,
      trashRootId: "record-trash"
    };
    await finalizeRecordMutationTrash({
      receipt,
      ...roots,
      finalizedAt: 1_721_260_800_010
    });

    assert.deepEqual(
      await judgeRecordMutationTrashRestore({ receipt, ...roots }),
      { status: "restore-required", reason: "source-missing-trash-exact" }
    );
    assert.deepEqual(
      await restoreRecordMutationTrash({ receipt, ...roots }),
      { status: "already-restored", reason: "source-and-trash-exact" }
    );
    assert.deepEqual(
      await restoreRecordMutationTrash({ receipt, ...roots }),
      { status: "already-restored", reason: "source-and-trash-exact" },
      "restore must be idempotent"
    );
    assert.equal(await readFile(path.join(sourceRootPath, "payload.json"), "utf8"), "original\n");
    assert.equal(
      await readFile(path.join(trashRootPath, receipt.locator.trashRelativePath), "utf8"),
      "original\n",
      "compensation must retain trash evidence; permanent deletion is out of scope"
    );

    await writeFile(path.join(sourceRootPath, "payload.json"), "conflicting\n");
    assert.deepEqual(
      await judgeRecordMutationTrashRestore({ receipt, ...roots }),
      { status: "blocked", reason: "source-conflict" }
    );
    await assert.rejects(
      () => restoreRecordMutationTrash({ receipt, ...roots }),
      (error: unknown) => (
        error instanceof RecordMutationTrashError
        && error.code === "restore_conflict"
      )
    );
  });
}

async function assertNestedDirectoryRoundTripsWithEmptyDirectories(): Promise<void> {
  await withFixture("directory", async ({ sourceRootPath, trashRootPath }) => {
    const conversationPath = path.join(sourceRootPath, "conversation");
    await mkdir(path.join(conversationPath, "messages", "empty"), {
      recursive: true
    });
    await mkdir(path.join(conversationPath, "metadata", "nested-empty"), {
      recursive: true
    });
    await writeFile(
      path.join(conversationPath, "messages", "0001.json"),
      "{\"message\":\"one\"}\n"
    );
    await writeFile(
      path.join(conversationPath, "metadata", "head.json"),
      "{\"generation\":3}\n"
    );
    const roots = {
      sourceRootPath,
      sourceRootId: "conversation-store",
      trashRootPath,
      trashRootId: "record-trash"
    };
    const receipt = await stageRecordMutationTrash({
      mutationId: "mutation-directory",
      sourceRelativePath: "conversation",
      transfer: "move",
      stagedAt: 1_721_260_800_000,
      ...roots
    });
    assert.equal(receipt.content.entryKind, "directory");
    assert.equal(
      (await lstat(path.join(conversationPath, "messages", "empty"))).isDirectory(),
      true,
      "prepare must retain nested empty directories"
    );
    assert.equal(
      (await lstat(
        path.join(
          trashRootPath,
          receipt.locator.trashRelativePath,
          "metadata",
          "nested-empty"
        )
      )).isDirectory(),
      true,
      "prepared trash must preserve empty directories"
    );

    const finalized = await finalizeRecordMutationTrash({
      receipt,
      finalizedAt: 1_721_260_800_010,
      ...roots
    });
    assert.equal(finalized.sourceDisposition, "retired");
    await assert.rejects(
      () => lstat(conversationPath),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    assert.equal(
      (await lstat(path.join(
        trashRootPath,
        receipt.locator.retirementRelativePath,
        "messages",
        "empty"
      ))).isDirectory(),
      true
    );

    await mkdir(path.join(conversationPath, "messages"), { recursive: true });
    await writeFile(
      path.join(conversationPath, "messages", "0001.json"),
      "{\"message\":\"one\"}\n"
    );
    assert.deepEqual(
      await judgeRecordMutationTrashRestore({ receipt, ...roots }),
      { status: "restore-required", reason: "source-partial-trash-exact" },
      "a crash-partial exact tree must be resumable"
    );
    assert.deepEqual(
      await restoreRecordMutationTrash({ receipt, ...roots }),
      { status: "already-restored", reason: "source-and-trash-exact" }
    );
    assert.deepEqual(
      await restoreRecordMutationTrash({ receipt, ...roots }),
      { status: "already-restored", reason: "source-and-trash-exact" }
    );
    assert.equal(
      await readFile(
        path.join(conversationPath, "messages", "0001.json"),
        "utf8"
      ),
      "{\"message\":\"one\"}\n"
    );
    assert.equal(
      (await lstat(
        path.join(conversationPath, "metadata", "nested-empty")
      )).isDirectory(),
      true
    );
    assert.equal(
      (await lstat(path.join(
        trashRootPath,
        receipt.locator.trashRelativePath,
        "messages",
        "empty"
      ))).isDirectory(),
      true,
      "restore must preserve prepared trash evidence"
    );
  });
}

async function assertPathEscapeSymlinkAndFutureReceiptFailClosed(): Promise<void> {
  await withFixture("unsafe", async ({ rootPath, sourceRootPath, trashRootPath }) => {
    await writeFile(path.join(sourceRootPath, "safe.json"), "safe\n");
    await assert.rejects(
      () => stageRecordMutationTrash({
        mutationId: "mutation-escape",
        sourceRootPath,
        sourceRootId: "conversation-store",
        sourceRelativePath: "../outside.json",
        trashRootPath,
        trashRootId: "record-trash",
        transfer: "move",
        stagedAt: 1_721_260_800_000
      }),
      (error: unknown) => (
        error instanceof RecordMutationTrashError
        && error.code === "invalid_path"
      )
    );

    const outside = path.join(rootPath, "outside.json");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(sourceRootPath, "linked.json"));
    await assert.rejects(
      () => stageRecordMutationTrash({
        mutationId: "mutation-link",
        sourceRootPath,
        sourceRootId: "conversation-store",
        sourceRelativePath: "linked.json",
        trashRootPath,
        trashRootId: "record-trash",
        transfer: "copy",
        stagedAt: 1_721_260_800_000
      }),
      (error: unknown) => (
        error instanceof RecordMutationTrashError
        && error.code === "unsafe_entry"
      )
    );

    const receipt = await stageRecordMutationTrash({
      mutationId: "mutation-future",
      sourceRootPath,
      sourceRootId: "conversation-store",
      sourceRelativePath: "safe.json",
      trashRootPath,
      trashRootId: "record-trash",
      transfer: "copy",
      stagedAt: 1_721_260_800_000
    });
    await assert.rejects(
      async () => parseRecordMutationTrashReceipt({
        ...receipt,
        schemaVersion: 2
      }),
      (error: unknown) => (
        error instanceof RecordMutationTrashError
        && error.code === "receipt_corrupt"
      )
    );
    await assert.rejects(
      async () => parseRecordMutationTrashReceipt({
        ...receipt,
        unknown: true
      }),
      (error: unknown) => (
        error instanceof RecordMutationTrashError
        && error.code === "receipt_corrupt"
      )
    );
  });
}

async function assertNestedSymlinkAndSpecialEntryFailClosed(): Promise<void> {
  await withFixture(
    "nested-unsafe",
    async ({ rootPath, sourceRootPath, trashRootPath }) => {
      const outside = path.join(rootPath, "outside-tree.txt");
      await writeFile(outside, "outside\n");
      const linkedTree = path.join(sourceRootPath, "linked-tree");
      await mkdir(path.join(linkedTree, "nested"), { recursive: true });
      await symlink(outside, path.join(linkedTree, "nested", "linked.txt"));
      await assert.rejects(
        () => stageRecordMutationTrash({
          mutationId: "mutation-nested-link",
          sourceRootPath,
          sourceRootId: "conversation-store",
          sourceRelativePath: "linked-tree",
          trashRootPath,
          trashRootId: "record-trash",
          transfer: "move",
          stagedAt: 1_721_260_800_000
        }),
        (error: unknown) => (
          error instanceof RecordMutationTrashError
          && error.code === "unsafe_entry"
        )
      );

      if (process.platform !== "win32") {
        const hardLinkTree = path.join(sourceRootPath, "hard-link-tree");
        await mkdir(hardLinkTree, { recursive: true });
        const originalPath = path.join(hardLinkTree, "original.json");
        await writeFile(originalPath, "shared inode\n");
        await link(originalPath, path.join(hardLinkTree, "alias.json"));
        await assert.rejects(
          () => stageRecordMutationTrash({
            mutationId: "mutation-hard-link-entry",
            sourceRootPath,
            sourceRootId: "conversation-store",
            sourceRelativePath: "hard-link-tree",
            trashRootPath,
            trashRootId: "record-trash",
            transfer: "move",
            stagedAt: 1_721_260_800_005
          }),
          (error: unknown) => (
            error instanceof RecordMutationTrashError
            && error.code === "unsafe_entry"
          )
        );

        const specialTree = path.join(sourceRootPath, "special-tree");
        await mkdir(path.join(specialTree, "nested"), { recursive: true });
        const socketPath = path.join(specialTree, "nested", "entry.sock");
        const shortSocketPath = path.join(rootPath, "entry.sock");
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(shortSocketPath, resolve);
        });
        await rename(shortSocketPath, socketPath);
        try {
          await assert.rejects(
            () => stageRecordMutationTrash({
              mutationId: "mutation-special-entry",
              sourceRootPath,
              sourceRootId: "conversation-store",
              sourceRelativePath: "special-tree",
              trashRootPath,
              trashRootId: "record-trash",
              transfer: "move",
              stagedAt: 1_721_260_800_010
            }),
            (error: unknown) => (
              error instanceof RecordMutationTrashError
              && error.code === "unsafe_entry"
            )
          );
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
        }
      }
    }
  );
}

async function withFixture(
  label: string,
  action: (fixture: {
    rootPath: string;
    sourceRootPath: string;
    trashRootPath: string;
  }) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), `echoink-trash-${label}-`));
  const sourceRootPath = path.join(rootPath, "source");
  const trashRootPath = path.join(rootPath, "trash");
  await mkdir(sourceRootPath, { recursive: true, mode: 0o700 });
  await mkdir(trashRootPath, { recursive: true, mode: 0o700 });
  try {
    await action({ rootPath, sourceRootPath, trashRootPath });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
