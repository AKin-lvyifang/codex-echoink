import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  coordinateRecordMutationTrashPrepare,
  coordinateRecordMutationTrashRestore,
  coordinateRecordMutationTrashRetirement,
  RECORD_MUTATION_GLOBAL_LOCK_FILE,
  RecordMutationCoordinatorError
} from "../../harness/lifecycle/record-mutation-coordinator";
import type {
  RecordMutationIntent,
  RecordMutationStep
} from "../../harness/lifecycle/record-mutation-contract";
import {
  beginRecordMutationCompensation,
  createRecordMutationJournal,
  loadRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef,
  RecordRootRegistryError,
  type RecordRootBindingRef
} from "../../harness/storage/record-root-registry";

export async function runHarnessV2RecordMutationCoordinatorTests(): Promise<void> {
  await assertPrepareIsDurableAndNonDestructive();
  await assertCoordinatorAuthorizesBeforeRetirement();
  await assertGlobalAuthoritySerializesMutations();
  await assertCorruptAuthorityFailsClosed();
  await assertStaleAuthorityIsRecovered();
  await assertOverlappingRootsFailClosed();
  await assertRecreatedRootBlocksRetirement();
  await assertCrashAfterRetirementReplaysJournal();
  await assertCrashAfterRestoreReplaysJournal();
  await assertRecreatedRootBlocksRestore();
}

async function assertPrepareIsDurableAndNonDestructive(): Promise<void> {
  await withFixture("prepare-only", async (fixture) => {
    const sourcePath = path.join(fixture.sourceRootPath, "conversation.json");
    await writeFile(sourcePath, "before\n");
    const planned = await plannedMutation(fixture, "prepare-only");
    const prepared = await coordinateRecordMutationTrashPrepare({
      journal: planned,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });

    assert.deepEqual(
      forwardActions(prepared.journal, "conversation"),
      ["trash-staged"]
    );
    assert.equal(await readFile(sourcePath, "utf8"), "before\n");
    assert.equal(
      await readFile(
        path.join(
          fixture.trashRootPath,
          prepared.preparedReceipt.locator.trashRelativePath
        ),
        "utf8"
      ),
      "before\n"
    );

    const replayed = await coordinateRecordMutationTrashPrepare({
      journal: prepared.journal,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    assert.equal(
      replayed.preparedReceipt.digest,
      prepared.preparedReceipt.digest
    );
    assert.equal(replayed.journal.record.digest, prepared.journal.record.digest);
    assert.equal(await readFile(sourcePath, "utf8"), "before\n");

    const retired = await coordinateRecordMutationTrashRetirement({
      journal: replayed.journal,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    assert.deepEqual(
      forwardActions(retired.journal, "conversation"),
      ["trash-staged", "source-retired"]
    );
    assert.equal(await exists(sourcePath), false);
  });
}

async function assertCoordinatorAuthorizesBeforeRetirement(): Promise<void> {
  await withFixture("forward", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(fixture, "forward");
    const result = await coordinateRecordMutationTrashRetirement({
      journal: planned,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });

    assert.deepEqual(
      forwardActions(result.journal, "conversation"),
      ["trash-staged", "source-retired"]
    );
    assert.equal(
      result.journal.chain.find(
        (revision) => revision.step?.action === "trash-staged"
      )?.step?.evidenceDigest,
      result.preparedReceipt.digest
    );
    assert.equal(
      result.journal.chain.find(
        (revision) => revision.step?.action === "source-retired"
      )?.step?.evidenceDigest,
      result.finalizationReceipt.digest
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "conversation.json")),
      false
    );
    assert.equal(
      await readFile(
        path.join(
          fixture.trashRootPath,
          result.preparedReceipt.locator.retirementRelativePath
        ),
        "utf8"
      ),
      "before\n"
    );
    assert.equal(
      await exists(
        path.join(fixture.storageRootPath, RECORD_MUTATION_GLOBAL_LOCK_FILE)
      ),
      false,
      "global authority lock must be released after success"
    );
  });
}

async function assertGlobalAuthoritySerializesMutations(): Promise<void> {
  await withFixture("global-lock", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "first.json"), "first\n");
    await writeFile(path.join(fixture.sourceRootPath, "second.json"), "second\n");
    const firstJournal = await plannedMutation(fixture, "first");
    const secondJournal = await plannedMutation(fixture, "second");
    let releaseFirst!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstHasAuthority!: () => void;
    const firstAuthorityAcquired = new Promise<void>((resolve) => {
      firstHasAuthority = resolve;
    });
    let secondAcquired = false;

    const first = coordinateRecordMutationTrashRetirement({
      journal: firstJournal,
      participantId: "conversation",
      sourceRelativePath: "first.json",
      ...coordinatorRoots(fixture),
      now: fixture.now,
      async faultInjector(point) {
        if (point === "after-authority-acquired") {
          firstHasAuthority();
          await firstMayContinue;
        }
      }
    });
    await firstAuthorityAcquired;
    const second = coordinateRecordMutationTrashRetirement({
      journal: secondJournal,
      participantId: "conversation",
      sourceRelativePath: "second.json",
      ...coordinatorRoots(fixture),
      now: fixture.now,
      faultInjector(point) {
        if (point === "after-authority-acquired") secondAcquired = true;
      }
    });
    await delay(25);
    assert.equal(secondAcquired, false, "second mutation must wait for global authority");
    assert.equal(
      await readFile(path.join(fixture.sourceRootPath, "second.json"), "utf8"),
      "second\n"
    );

    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondAcquired, true);
  });
}

async function assertCorruptAuthorityFailsClosed(): Promise<void> {
  await withFixture("corrupt-lock", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(fixture, "corrupt-lock");
    const lockPath = path.join(
      fixture.storageRootPath,
      RECORD_MUTATION_GLOBAL_LOCK_FILE
    );
    await writeFile(lockPath, "{not-json}\n", { mode: 0o600 });
    await utimes(lockPath, new Date(0), new Date(0));

    await assert.rejects(
      () => coordinateRecordMutationTrashRetirement({
        journal: planned,
        participantId: "conversation",
        sourceRelativePath: "conversation.json",
        ...coordinatorRoots(fixture),
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationCoordinatorError
        && error.code === "authority_corrupt"
      )
    );
    assert.equal(
      await readFile(path.join(fixture.sourceRootPath, "conversation.json"), "utf8"),
      "before\n"
    );
    assert.equal(
      await readFile(lockPath, "utf8"),
      "{not-json}\n",
      "corrupt authority evidence must remain for manual recovery"
    );
  });
}

async function assertStaleAuthorityIsRecovered(): Promise<void> {
  await withFixture("stale-lock", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(fixture, "stale-lock");
    const lockPath = path.join(
      fixture.storageRootPath,
      RECORD_MUTATION_GLOBAL_LOCK_FILE
    );
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 999_999,
      token: "00000000-0000-4000-8000-000000000001",
      mutationId: "mutation-dead-owner",
      createdAt: 1_721_260_700_000
    })}\n`, { mode: 0o600 });

    const result = await coordinateRecordMutationTrashRetirement({
      journal: planned,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    assert.deepEqual(
      forwardActions(result.journal, "conversation"),
      ["trash-staged", "source-retired"]
    );
    assert.equal(await exists(lockPath), false);
  });
}

async function assertOverlappingRootsFailClosed(): Promise<void> {
  await withFixture(
    "overlapping-roots",
    async (fixture) => {
      await writeFile(
        path.join(fixture.sourceRootPath, "conversation.json"),
        "before\n"
      );
      const planned = await plannedMutation(fixture, "overlapping-roots");
      await assert.rejects(
        () => coordinateRecordMutationTrashRetirement({
          journal: planned,
          participantId: "conversation",
          sourceRelativePath: "conversation.json",
          ...coordinatorRoots(fixture),
          now: fixture.now
        }),
        (error: unknown) => (
          error instanceof RecordMutationCoordinatorError
          && error.code === "journal_mismatch"
          && error.message.includes("互不重叠")
        )
      );
      assert.equal(
        await readFile(
          path.join(fixture.sourceRootPath, "conversation.json"),
          "utf8"
        ),
        "before\n"
      );
    },
    { trashInsideSource: true }
  );
}

async function assertRecreatedRootBlocksRetirement(): Promise<void> {
  await withFixture("recreated-forward-root", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(fixture, "recreated-forward");
    const originalRootPath = `${fixture.sourceRootPath}-original`;

    await assert.rejects(
      () => coordinateRecordMutationTrashRetirement({
        journal: planned,
        participantId: "conversation",
        sourceRelativePath: "conversation.json",
        ...coordinatorRoots(fixture),
        now: fixture.now,
        async faultInjector(point) {
          if (point !== "after-trash-authorized") return;
          await rename(fixture.sourceRootPath, originalRootPath);
          await mkdir(fixture.sourceRootPath, { mode: 0o700 });
          await writeFile(
            path.join(fixture.sourceRootPath, "conversation.json"),
            "replacement\n"
          );
        }
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "binding_mismatch"
      )
    );

    const current = await loadRecordMutationJournal(planned.handle);
    assert.deepEqual(
      forwardActions(current, "conversation"),
      ["trash-staged"],
      "source-retired must not be journaled when the physical root changed"
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "conversation.json"),
        "utf8"
      ),
      "replacement\n"
    );
    assert.equal(
      await readFile(path.join(originalRootPath, "conversation.json"), "utf8"),
      "before\n"
    );
  });
}

async function assertCrashAfterRetirementReplaysJournal(): Promise<void> {
  await withFixture("crash-replay", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(fixture, "crash-replay");

    await assert.rejects(
      () => coordinateRecordMutationTrashRetirement({
        journal: planned,
        participantId: "conversation",
        sourceRelativePath: "conversation.json",
        ...coordinatorRoots(fixture),
        now: fixture.now,
        faultInjector(point) {
          if (point === "after-source-retired") {
            throw new Error("simulated coordinator crash");
          }
        }
      }),
      /simulated coordinator crash/
    );
    const interrupted = await loadRecordMutationJournal(planned.handle);
    assert.deepEqual(forwardActions(interrupted, "conversation"), ["trash-staged"]);
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "conversation.json")),
      false,
      "retirement effect must be durable before the simulated crash"
    );

    const replayed = await coordinateRecordMutationTrashRetirement({
      journal: interrupted,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    assert.deepEqual(
      forwardActions(replayed.journal, "conversation"),
      ["trash-staged", "source-retired"]
    );
  });
}

async function assertCrashAfterRestoreReplaysJournal(): Promise<void> {
  await withFixture("restore-crash-replay", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(fixture, "restore-crash-replay");
    const retired = await coordinateRecordMutationTrashRetirement({
      journal: planned,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    const compensating = await beginRecordMutationCompensation(
      retired.journal.handle,
      {
        expectedRevision: retired.journal.record.revision,
        expectedDigest: retired.journal.record.digest,
        step: {
          direction: "compensating",
          ordinal: 1,
          participantId: "conversation",
          action: "compensation-prepared",
          evidenceDigest: retired.preparedReceipt.digest
        },
        updatedAt: fixture.now()
      }
    );

    await assert.rejects(
      () => coordinateRecordMutationTrashRestore({
        journal: compensating,
        participantId: "conversation",
        receipt: retired.preparedReceipt,
        ...coordinatorRoots(fixture),
        now: fixture.now,
        faultInjector(point) {
          if (point === "after-trash-restored") {
            throw new Error("simulated restore coordinator crash");
          }
        }
      }),
      /simulated restore coordinator crash/
    );
    assert.equal(
      await readFile(path.join(fixture.sourceRootPath, "conversation.json"), "utf8"),
      "before\n"
    );
    const interrupted = await loadRecordMutationJournal(compensating.handle);
    assert.deepEqual(
      compensatingActions(interrupted, "conversation"),
      ["compensation-prepared"]
    );

    const replayed = await coordinateRecordMutationTrashRestore({
      journal: interrupted,
      participantId: "conversation",
      receipt: retired.preparedReceipt,
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    assert.deepEqual(
      compensatingActions(replayed.journal, "conversation"),
      ["compensation-prepared", "trash-restored"]
    );
    assert.deepEqual(replayed.judgment, {
      status: "already-restored",
      reason: "source-and-trash-exact"
    });
  });
}

async function assertRecreatedRootBlocksRestore(): Promise<void> {
  await withFixture("recreated-restore-root", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(fixture, "recreated-restore");
    const retired = await coordinateRecordMutationTrashRetirement({
      journal: planned,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    const compensating = await beginRecordMutationCompensation(
      retired.journal.handle,
      {
        expectedRevision: retired.journal.record.revision,
        expectedDigest: retired.journal.record.digest,
        step: {
          direction: "compensating",
          ordinal: 1,
          participantId: "conversation",
          action: "compensation-prepared",
          evidenceDigest: retired.preparedReceipt.digest
        },
        updatedAt: fixture.now()
      }
    );
    const originalRootPath = `${fixture.sourceRootPath}-retired`;
    await rename(fixture.sourceRootPath, originalRootPath);
    await mkdir(fixture.sourceRootPath, { mode: 0o700 });

    await assert.rejects(
      () => coordinateRecordMutationTrashRestore({
        journal: compensating,
        participantId: "conversation",
        receipt: retired.preparedReceipt,
        ...coordinatorRoots(fixture),
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordRootRegistryError
        && error.code === "binding_mismatch"
      )
    );
    const current = await loadRecordMutationJournal(compensating.handle);
    assert.deepEqual(
      compensatingActions(current, "conversation"),
      ["compensation-prepared"]
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "conversation.json")),
      false,
      "restore must not write into a recreated physical root"
    );
  });
}

interface CoordinatorFixture {
  storageRootPath: string;
  sourceRootPath: string;
  trashRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  now: () => number;
}

async function withFixture(
  label: string,
  action: (fixture: CoordinatorFixture) => Promise<void>,
  options: { trashInsideSource?: boolean } = {}
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-mutation-coordinator-${label}-`)
  );
  const storageRootPath = path.join(rootPath, "store");
  const sourceRootPath = path.join(storageRootPath, "conversation-store");
  const trashRootPath = options.trashInsideSource
    ? path.join(sourceRootPath, "record-trash")
    : path.join(storageRootPath, "record-trash");
  await mkdir(sourceRootPath, { recursive: true, mode: 0o700 });
  await mkdir(trashRootPath, { recursive: true, mode: 0o700 });
  let timestamp = 1_721_260_800_000;
  const now = (): number => {
    timestamp += 1;
    return timestamp;
  };
  const source = await createOrLoadRecordRootBinding({
    storageRootPath,
    rootId: "conversation-store",
    rootPath: sourceRootPath,
    boundaryRootPath: storageRootPath,
    authority: "plugin-owned",
    createdAt: now()
  });
  const trash = await createOrLoadRecordRootBinding({
    storageRootPath,
    rootId: "record-trash",
    rootPath: trashRootPath,
    boundaryRootPath: storageRootPath,
    authority: "plugin-owned",
    createdAt: now()
  });
  try {
    await action({
      storageRootPath,
      sourceRootPath,
      trashRootPath,
      sourceRootBinding: recordRootBindingRef(source.binding),
      trashRootBinding: recordRootBindingRef(trash.binding),
      now
    });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function plannedMutation(
  fixture: CoordinatorFixture,
  suffix: string
): Promise<LoadedRecordMutationJournal> {
  return await createRecordMutationJournal({
    storageRootPath: fixture.storageRootPath,
    mutationId: `mutation-${suffix}`,
    intent: destructiveIntent(
      `conversation-${suffix}`,
      fixture.sourceRootBinding,
      fixture.trashRootBinding
    ),
    createdAt: fixture.now()
  });
}

function destructiveIntent(
  conversationId: string,
  sourceRootBinding: RecordRootBindingRef,
  trashRootBinding: RecordRootBindingRef
): RecordMutationIntent {
  return {
    operation: "delete-conversation",
    conversationId,
    expectedConversationGeneration: 3,
    expectedConversationCommitId: "conversation-commit-3",
    expectedConversationContentRevision: `sha256:${"1".repeat(64)}`,
    targetConversation: {
      status: "deleted",
      tombstoneId: `tombstone-${conversationId}`,
      digest: `sha256:${"2".repeat(64)}`
    },
    participants: [{
      id: "conversation",
      recordKind: "conversation",
      action: "stage"
    }],
    rootBindings: [sourceRootBinding, trashRootBinding],
    trashPolicy: "required"
  };
}

function coordinatorRoots(fixture: CoordinatorFixture): {
  storageRootPath: string;
  sourceRootPath: string;
  sourceBoundaryRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootPath: string;
  trashBoundaryRootPath: string;
  trashRootBinding: RecordRootBindingRef;
} {
  return {
    storageRootPath: fixture.storageRootPath,
    sourceRootPath: fixture.sourceRootPath,
    sourceBoundaryRootPath: fixture.storageRootPath,
    sourceRootBinding: fixture.sourceRootBinding,
    trashRootPath: fixture.trashRootPath,
    trashBoundaryRootPath: fixture.storageRootPath,
    trashRootBinding: fixture.trashRootBinding
  };
}

function forwardActions(
  journal: LoadedRecordMutationJournal,
  participantId: string
): RecordMutationStep["action"][] {
  return journal.chain.flatMap((revision) => (
    revision.step?.direction === "forward"
      && revision.step.participantId === participantId
      ? [revision.step.action]
      : []
  ));
}

function compensatingActions(
  journal: LoadedRecordMutationJournal,
  participantId: string
): RecordMutationStep["action"][] {
  return journal.chain.flatMap((revision) => (
    revision.step?.direction === "compensating"
      && revision.step.participantId === participantId
      ? [revision.step.action]
      : []
  ));
}

async function exists(absolutePath: string): Promise<boolean> {
  return await stat(absolutePath).then(() => true, () => false);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
