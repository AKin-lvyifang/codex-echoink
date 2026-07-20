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
  coordinateRecordMutationTrashBundlePrepare,
  coordinateRecordMutationTrashBundleRestore,
  coordinateRecordMutationTrashBundleRetirement,
  coordinateRecordMutationTrashPrepare,
  coordinateRecordMutationTrashRestore,
  coordinateRecordMutationTrashRetirement,
  inspectRecordMutationTrashBundleRecovery,
  RECORD_MUTATION_GLOBAL_LOCK_FILE,
  RecordMutationCoordinatorError
} from "../../harness/lifecycle/record-mutation-coordinator";
import type {
  RecordMutationIntent,
  RecordMutationStep
} from "../../harness/lifecycle/record-mutation-contract";
import {
  recordMutationExecutionBundleParticipantId
} from "../../harness/lifecycle/record-mutation-execution-plan";
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

const BUNDLE_SELECTION_DIGEST = `sha256:${"7".repeat(64)}`;
const BUNDLE_ITEMS = [
  {
    itemId: "item-first",
    sourceRelativePath: "sessions/first.json"
  },
  {
    itemId: "item-second",
    sourceRelativePath: "sessions/second.json"
  }
] as const;
const BUNDLE_PARTICIPANT_ID =
  recordMutationExecutionBundleParticipantId({
    recordKind: "conversation",
    action: "stage",
    execution: {
      kind: "trash-bundle",
      sourceRootId: "conversation-store",
      trashRootId: "record-trash",
      selectionDigest: BUNDLE_SELECTION_DIGEST,
      items: BUNDLE_ITEMS.map((item) => ({ ...item }))
    }
  });

export async function runHarnessV2RecordMutationCoordinatorTests(): Promise<void> {
  await assertPrepareIsDurableAndNonDestructive();
  await assertBundlePrepareAndRetirementAreDeterministic();
  await assertBundlePartialPrepareRecoversAsOneParticipant();
  await assertBundleNestedSourcesFailBeforeEffect();
  await assertBundlePartialRetirementRecoversAsOneParticipant();
  await assertBundleRestoreRecoversAsOneParticipant();
  await assertBundleRestorePreflightBlocksPartialCompensation();
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

async function assertBundlePrepareAndRetirementAreDeterministic(): Promise<void> {
  await withFixture("bundle-deterministic", async (fixture) => {
    await writeBundleSources(fixture);
    const planned = await plannedBundleMutation(
      fixture,
      "bundle-deterministic"
    );
    const input = bundleCoordinatorInput(fixture, planned);
    const prepared = await coordinateRecordMutationTrashBundlePrepare(input);

    assert.deepEqual(
      forwardActions(prepared.journal, BUNDLE_PARTICIPANT_ID),
      ["trash-staged"]
    );
    assert.equal(prepared.preparedReceipt.leaves.length, 2);
    assert.equal(prepared.leafReceipts.length, 2);
    assert.equal(
      prepared.journal.chain.find(
        (revision) => revision.step?.action === "trash-staged"
      )?.step?.evidenceDigest,
      prepared.preparedReceipt.digest
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/first.json"),
        "utf8"
      ),
      "first\n"
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/second.json"),
        "utf8"
      ),
      "second\n"
    );

    const replayedPrepare = await coordinateRecordMutationTrashBundlePrepare({
      ...input,
      journal: prepared.journal
    });
    assert.equal(
      replayedPrepare.preparedReceipt.digest,
      prepared.preparedReceipt.digest
    );
    assert.deepEqual(
      replayedPrepare.leafReceipts.map((leaf) => leaf.receipt.digest),
      prepared.leafReceipts.map((leaf) => leaf.receipt.digest)
    );
    assert.equal(
      replayedPrepare.journal.record.digest,
      prepared.journal.record.digest
    );

    await assert.rejects(
      () => inspectRecordMutationTrashBundleRecovery({
        ...input,
        journal: replayedPrepare.journal,
        preparedReceipt: replayedPrepare.preparedReceipt,
        leafReceipts: [...replayedPrepare.leafReceipts].reverse()
      }),
      (error: unknown) => (
        error instanceof RecordMutationCoordinatorError
        && error.code === "journal_mismatch"
      ),
      "reordered leaf evidence must not be accepted as the frozen bundle"
    );

    const retired = await coordinateRecordMutationTrashBundleRetirement({
      ...input,
      journal: replayedPrepare.journal
    });
    assert.deepEqual(
      forwardActions(retired.journal, BUNDLE_PARTICIPANT_ID),
      ["trash-staged", "source-retired"]
    );
    assert.equal(retired.finalizationReceipt.leaves.length, 2);
    assert.equal(
      retired.journal.chain.find(
        (revision) => revision.step?.action === "source-retired"
      )?.step?.evidenceDigest,
      retired.finalizationReceipt.digest
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/first.json")),
      false
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/second.json")),
      false
    );

    const replayedRetirement =
      await coordinateRecordMutationTrashBundleRetirement({
        ...input,
        journal: retired.journal
      });
    assert.equal(
      replayedRetirement.preparedReceipt.digest,
      retired.preparedReceipt.digest
    );
    assert.equal(
      replayedRetirement.finalizationReceipt.digest,
      retired.finalizationReceipt.digest
    );
    assert.equal(
      replayedRetirement.journal.record.digest,
      retired.journal.record.digest
    );
  });
}

async function assertBundlePartialPrepareRecoversAsOneParticipant(): Promise<void> {
  await withFixture("bundle-partial-prepare", async (fixture) => {
    await writeBundleSources(fixture);
    const planned = await plannedBundleMutation(
      fixture,
      "bundle-partial-prepare"
    );
    const input = bundleCoordinatorInput(fixture, planned);
    let preparedLeaves = 0;
    await assert.rejects(
      () => coordinateRecordMutationTrashBundlePrepare({
        ...input,
        faultInjector(point) {
          if (
            point === "after-trash-prepared"
            && ++preparedLeaves === 1
          ) {
            throw new Error("simulated partial bundle prepare");
          }
        }
      }),
      /simulated partial bundle prepare/
    );

    const interrupted = await loadRecordMutationJournal(planned.handle);
    assert.deepEqual(
      forwardActions(interrupted, BUNDLE_PARTICIPANT_ID),
      [],
      "partial leaf prepare must not publish aggregate trash-staged"
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/first.json"),
        "utf8"
      ),
      "first\n"
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/second.json"),
        "utf8"
      ),
      "second\n"
    );

    const recovered = await coordinateRecordMutationTrashBundlePrepare({
      ...input,
      journal: interrupted
    });
    assert.deepEqual(
      forwardActions(recovered.journal, BUNDLE_PARTICIPANT_ID),
      ["trash-staged"]
    );
    assert.equal(recovered.leafReceipts.length, 2);
  });
}

async function assertBundleNestedSourcesFailBeforeEffect(): Promise<void> {
  await withFixture("bundle-nested-source", async (fixture) => {
    await writeBundleSources(fixture);
    const items = [
      {
        itemId: "item-child",
        sourceRelativePath: "sessions/first.json"
      },
      {
        itemId: "item-parent",
        sourceRelativePath: "sessions"
      }
    ];
    const participantId = recordMutationExecutionBundleParticipantId({
      recordKind: "conversation",
      action: "stage",
      execution: {
        kind: "trash-bundle",
        sourceRootId: fixture.sourceRootBinding.rootId,
        trashRootId: fixture.trashRootBinding.rootId,
        selectionDigest: BUNDLE_SELECTION_DIGEST,
        items
      }
    });
    const journal = await createRecordMutationJournal({
      storageRootPath: fixture.storageRootPath,
      mutationId: "mutation-bundle-nested-source",
      intent: destructiveIntent(
        "conversation-bundle-nested-source",
        fixture.sourceRootBinding,
        fixture.trashRootBinding,
        participantId
      ),
      createdAt: fixture.now()
    });

    await assert.rejects(
      () => coordinateRecordMutationTrashBundlePrepare({
        journal,
        participantId,
        selectionDigest: BUNDLE_SELECTION_DIGEST,
        items,
        ...coordinatorRoots(fixture),
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationCoordinatorError
        && error.code === "journal_mismatch"
        && error.message.includes("路径不嵌套")
      )
    );
    const current = await loadRecordMutationJournal(journal.handle);
    assert.deepEqual(forwardActions(current, participantId), []);
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/first.json"),
        "utf8"
      ),
      "first\n"
    );
  });
}

async function assertBundlePartialRetirementRecoversAsOneParticipant(): Promise<void> {
  await withFixture("bundle-partial-retirement", async (fixture) => {
    await writeBundleSources(fixture);
    const planned = await plannedBundleMutation(
      fixture,
      "bundle-partial-retirement"
    );
    const input = bundleCoordinatorInput(fixture, planned);
    const prepared = await coordinateRecordMutationTrashBundlePrepare(input);
    let retiredLeaves = 0;
    await assert.rejects(
      () => coordinateRecordMutationTrashBundleRetirement({
        ...input,
        journal: prepared.journal,
        faultInjector(point) {
          if (
            point === "after-source-retired"
            && ++retiredLeaves === 1
          ) {
            throw new Error("simulated partial bundle retirement");
          }
        }
      }),
      /simulated partial bundle retirement/
    );

    const interrupted = await loadRecordMutationJournal(planned.handle);
    assert.deepEqual(
      forwardActions(interrupted, BUNDLE_PARTICIPANT_ID),
      ["trash-staged"],
      "partial leaf retirement must not publish aggregate source-retired"
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/first.json")),
      false
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/second.json"),
        "utf8"
      ),
      "second\n"
    );

    const recovered =
      await coordinateRecordMutationTrashBundleRetirement({
        ...input,
        journal: interrupted
      });
    assert.deepEqual(
      forwardActions(recovered.journal, BUNDLE_PARTICIPANT_ID),
      ["trash-staged", "source-retired"]
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/second.json")),
      false
    );
  });
}

async function assertBundleRestoreRecoversAsOneParticipant(): Promise<void> {
  await withFixture("bundle-restore", async (fixture) => {
    await writeBundleSources(fixture);
    const planned = await plannedBundleMutation(fixture, "bundle-restore");
    const input = bundleCoordinatorInput(fixture, planned);
    const retired = await coordinateRecordMutationTrashBundleRetirement(input);
    const inspected = await inspectRecordMutationTrashBundleRecovery({
      ...input,
      journal: retired.journal,
      preparedReceipt: retired.preparedReceipt,
      leafReceipts: retired.leafReceipts
    });
    assert.deepEqual(
      inspected.judgments.map((entry) => entry.judgment.status),
      ["restore-required", "restore-required"]
    );

    const compensating = await beginRecordMutationCompensation(
      retired.journal.handle,
      {
        expectedRevision: retired.journal.record.revision,
        expectedDigest: retired.journal.record.digest,
        step: {
          direction: "compensating",
          ordinal: 1,
          participantId: BUNDLE_PARTICIPANT_ID,
          action: "compensation-prepared",
          evidenceDigest: retired.preparedReceipt.digest
        },
        updatedAt: fixture.now()
      }
    );
    let restoredLeaves = 0;
    await assert.rejects(
      () => coordinateRecordMutationTrashBundleRestore({
        ...input,
        journal: compensating,
        preparedReceipt: retired.preparedReceipt,
        leafReceipts: retired.leafReceipts,
        faultInjector(point) {
          if (
            point === "after-trash-restored"
            && ++restoredLeaves === 1
          ) {
            throw new Error("simulated partial bundle restore");
          }
        }
      }),
      /simulated partial bundle restore/
    );
    const interrupted = await loadRecordMutationJournal(compensating.handle);
    assert.deepEqual(
      compensatingActions(interrupted, BUNDLE_PARTICIPANT_ID),
      ["compensation-prepared"],
      "partial restore must not publish aggregate trash-restored"
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/first.json"),
        "utf8"
      ),
      "first\n"
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/second.json")),
      false
    );

    const recovered = await coordinateRecordMutationTrashBundleRestore({
      ...input,
      journal: interrupted,
      preparedReceipt: retired.preparedReceipt,
      leafReceipts: retired.leafReceipts
    });
    assert.deepEqual(
      compensatingActions(recovered.journal, BUNDLE_PARTICIPANT_ID),
      ["compensation-prepared", "trash-restored"]
    );
    assert.deepEqual(
      recovered.judgments.map((entry) => entry.judgment.status),
      ["already-restored", "already-restored"]
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/second.json"),
        "utf8"
      ),
      "second\n"
    );

    const replayed = await coordinateRecordMutationTrashBundleRestore({
      ...input,
      journal: recovered.journal,
      preparedReceipt: retired.preparedReceipt,
      leafReceipts: retired.leafReceipts
    });
    assert.equal(replayed.journal.record.digest, recovered.journal.record.digest);
    assert.deepEqual(
      compensatingActions(replayed.journal, BUNDLE_PARTICIPANT_ID),
      ["compensation-prepared", "trash-restored"]
    );
  });
}

async function assertBundleRestorePreflightBlocksPartialCompensation(): Promise<void> {
  await withFixture("bundle-restore-blocked", async (fixture) => {
    await writeBundleSources(fixture);
    const planned = await plannedBundleMutation(
      fixture,
      "bundle-restore-blocked"
    );
    const input = bundleCoordinatorInput(fixture, planned);
    const retired = await coordinateRecordMutationTrashBundleRetirement(input);
    const compensating = await beginRecordMutationCompensation(
      retired.journal.handle,
      {
        expectedRevision: retired.journal.record.revision,
        expectedDigest: retired.journal.record.digest,
        step: {
          direction: "compensating",
          ordinal: 1,
          participantId: BUNDLE_PARTICIPANT_ID,
          action: "compensation-prepared",
          evidenceDigest: retired.preparedReceipt.digest
        },
        updatedAt: fixture.now()
      }
    );
    await mkdir(path.join(fixture.sourceRootPath, "sessions"), {
      recursive: true,
      mode: 0o700
    });
    await writeFile(
      path.join(fixture.sourceRootPath, "sessions/second.json"),
      "replacement\n"
    );

    await assert.rejects(
      () => coordinateRecordMutationTrashBundleRestore({
        ...input,
        journal: compensating,
        preparedReceipt: retired.preparedReceipt,
        leafReceipts: retired.leafReceipts
      }),
      (error: unknown) => (
        error instanceof RecordMutationCoordinatorError
        && error.code === "journal_mismatch"
        && error.message.includes("item-second")
      )
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/first.json")),
      false,
      "known later conflict must block before restoring the first leaf"
    );
    assert.equal(
      await readFile(
        path.join(fixture.sourceRootPath, "sessions/second.json"),
        "utf8"
      ),
      "replacement\n"
    );
    const current = await loadRecordMutationJournal(compensating.handle);
    assert.deepEqual(
      compensatingActions(current, BUNDLE_PARTICIPANT_ID),
      ["compensation-prepared"]
    );
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

async function plannedBundleMutation(
  fixture: CoordinatorFixture,
  suffix: string
): Promise<LoadedRecordMutationJournal> {
  return await createRecordMutationJournal({
    storageRootPath: fixture.storageRootPath,
    mutationId: `mutation-${suffix}`,
    intent: destructiveIntent(
      `conversation-${suffix}`,
      fixture.sourceRootBinding,
      fixture.trashRootBinding,
      BUNDLE_PARTICIPANT_ID
    ),
    createdAt: fixture.now()
  });
}

function destructiveIntent(
  conversationId: string,
  sourceRootBinding: RecordRootBindingRef,
  trashRootBinding: RecordRootBindingRef,
  participantId = "conversation"
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
      id: participantId,
      recordKind: "conversation",
      action: "stage"
    }],
    rootBindings: [sourceRootBinding, trashRootBinding],
    trashPolicy: "required"
  };
}

function bundleCoordinatorInput(
  fixture: CoordinatorFixture,
  journal: LoadedRecordMutationJournal
): {
  journal: LoadedRecordMutationJournal;
  participantId: string;
  selectionDigest: string;
  items: Array<{ itemId: string; sourceRelativePath: string }>;
  storageRootPath: string;
  sourceRootPath: string;
  sourceBoundaryRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootPath: string;
  trashBoundaryRootPath: string;
  trashRootBinding: RecordRootBindingRef;
  now: () => number;
} {
  return {
    journal,
    participantId: BUNDLE_PARTICIPANT_ID,
    selectionDigest: BUNDLE_SELECTION_DIGEST,
    items: BUNDLE_ITEMS.map((item) => ({ ...item })),
    ...coordinatorRoots(fixture),
    now: fixture.now
  };
}

async function writeBundleSources(
  fixture: CoordinatorFixture
): Promise<void> {
  await mkdir(path.join(fixture.sourceRootPath, "sessions"), {
    recursive: true,
    mode: 0o700
  });
  await writeFile(
    path.join(fixture.sourceRootPath, "sessions/first.json"),
    "first\n"
  );
  await writeFile(
    path.join(fixture.sourceRootPath, "sessions/second.json"),
    "second\n"
  );
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
