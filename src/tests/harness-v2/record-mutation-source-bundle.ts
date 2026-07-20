import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  recordMutationDigest,
  type RecordMutationParticipant
} from "../../harness/lifecycle/record-mutation-contract";
import {
  recordMutationExecutionBundleParticipantId,
  type RecordMutationExecutionSubject
} from "../../harness/lifecycle/record-mutation-execution-plan";
import {
  beginRecordMutationCompensation,
  createRecordMutationJournal,
  loadRecordMutationJournal,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  createRecordMutationSourceBundleAdapter
} from "../../harness/lifecycle/record-mutation-source-bundle";
import {
  coordinateRecordMutationSourceParticipantForward,
  coordinateRecordMutationSourceParticipantRestore,
  createRecordMutationSourceParticipantReceipt,
  reconcileRecordMutationSourceParticipantForward,
  verifyRecordMutationSourceParticipantAborted,
  verifyRecordMutationSourceParticipantForward,
  type RecordMutationSourceParticipantAdapter,
  type RecordMutationSourceParticipantObservation,
  type RecordMutationSourceParticipantReceipt
} from "../../harness/lifecycle/record-mutation-source-participant";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef,
  type RecordRootBindingRef
} from "../../harness/storage/record-root-registry";

export async function runHarnessV2RecordMutationSourceBundleTests():
Promise<void> {
  await assertPartialForwardReplaysBeforeAggregateJournalStep();
  await assertPartialForwardAndRestoreReplayDuringCompensation();
  await assertBundleIdentityDriftBlocksBeforeLeafEffects();
}

async function assertPartialForwardReplaysBeforeAggregateJournalStep():
Promise<void> {
  await withBundleFixture("forward-replay", async (fixture) => {
    fixture.leaves[1].failNextStage();
    await assert.rejects(
      coordinateRecordMutationSourceParticipantForward({
        journal: fixture.stagedJournal,
        adapter: fixture.adapter,
        now: fixture.now
      }),
      /injected bundle leaf stage failure/
    );
    const interrupted = await loadRecordMutationJournal(
      fixture.stagedJournal.handle
    );
    assert.equal(
      participantSteps(interrupted, fixture.bundleParticipantId).length,
      0,
      "partial leaf forward must not publish aggregate Journal success"
    );
    assert.deepEqual(
      fixture.leaves.map((leaf) => leaf.status()),
      ["source-deleted", "before"]
    );

    const replayed =
      await coordinateRecordMutationSourceParticipantForward({
        journal: interrupted,
        adapter: fixture.adapter,
        now: fixture.now
      });
    const steps = participantSteps(
      replayed,
      fixture.bundleParticipantId
    );
    assert.deepEqual(
      steps.map((step) => step.action),
      ["participant-staged"]
    );
    assert.deepEqual(
      fixture.leaves.map((leaf) => leaf.status()),
      ["source-deleted", "source-deleted"]
    );
    assert.equal(fixture.leaves[0].stageCalls(), 1);
    assert.equal(fixture.leaves[1].stageCalls(), 2);

    const idempotent =
      await coordinateRecordMutationSourceParticipantForward({
        journal: replayed,
        adapter: fixture.adapter,
        now: fixture.now
      });
    assert.equal(idempotent.record.digest, replayed.record.digest);
  });
}

async function assertPartialForwardAndRestoreReplayDuringCompensation():
Promise<void> {
  await withBundleFixture("compensation-replay", async (fixture) => {
    fixture.leaves[1].failNextStage();
    await assert.rejects(
      coordinateRecordMutationSourceParticipantForward({
        journal: fixture.stagedJournal,
        adapter: fixture.adapter,
        now: fixture.now
      }),
      /injected bundle leaf stage failure/
    );
    const interrupted = await loadRecordMutationJournal(
      fixture.stagedJournal.handle
    );
    const reconciled =
      await reconcileRecordMutationSourceParticipantForward({
        journal: interrupted,
        adapter: fixture.adapter,
        now: fixture.now
      });
    const forwardStep = participantSteps(
      reconciled,
      fixture.bundleParticipantId
    ).find((step) => step.action === "participant-staged");
    assert.ok(forwardStep);

    const compensating = await beginRecordMutationCompensation(
      reconciled.handle,
      {
        expectedRevision: reconciled.record.revision,
        expectedDigest: reconciled.record.digest,
        step: {
          direction: "compensating",
          ordinal: 1,
          participantId: fixture.bundleParticipantId,
          action: "compensation-prepared",
          evidenceDigest: forwardStep.evidenceDigest
        },
        updatedAt: fixture.now()
      }
    );
    fixture.leaves[1].failNextRestore();
    await assert.rejects(
      coordinateRecordMutationSourceParticipantRestore({
        journal: compensating,
        adapter: fixture.adapter,
        now: fixture.now
      }),
      /injected bundle leaf restore failure/
    );
    const restoreInterrupted = await loadRecordMutationJournal(
      compensating.handle
    );
    assert.deepEqual(
      participantSteps(
        restoreInterrupted,
        fixture.bundleParticipantId
      ).map((step) => step.action),
      ["participant-staged", "compensation-prepared"],
      "partial leaf restore must not publish aggregate Journal success"
    );
    assert.deepEqual(
      fixture.leaves.map((leaf) => leaf.status()),
      ["source-restored", "source-deleted"]
    );
    await assert.rejects(
      verifyRecordMutationSourceParticipantForward({
        journal: restoreInterrupted,
        adapter: fixture.adapter
      }),
      /forward state is incomplete/
    );

    fixture.leaves[1].failNextRestoreAfterEffect();
    await assert.rejects(
      coordinateRecordMutationSourceParticipantRestore({
        journal: restoreInterrupted,
        adapter: fixture.adapter,
        now: fixture.now
      }),
      /injected bundle leaf restore post-effect failure/
    );
    const aggregateInterrupted = await loadRecordMutationJournal(
      restoreInterrupted.handle
    );
    assert.deepEqual(
      fixture.leaves.map((leaf) => leaf.status()),
      ["source-restored", "source-restored"]
    );
    assert.deepEqual(
      participantSteps(
        aggregateInterrupted,
        fixture.bundleParticipantId
      ).map((step) => step.action),
      ["participant-staged", "compensation-prepared"]
    );
    const restoreReconciled =
      await reconcileRecordMutationSourceParticipantForward({
        journal: aggregateInterrupted,
        adapter: fixture.adapter,
        now: fixture.now
      });
    const restored =
      await coordinateRecordMutationSourceParticipantRestore({
        journal: restoreReconciled,
        adapter: fixture.adapter,
        now: fixture.now
      });
    assert.deepEqual(
      participantSteps(restored, fixture.bundleParticipantId)
        .map((step) => step.action),
      [
        "participant-staged",
        "compensation-prepared",
        "participant-restored"
      ]
    );
    assert.deepEqual(
      fixture.leaves.map((leaf) => leaf.status()),
      ["source-restored", "source-restored"]
    );
    assert.equal(fixture.leaves[0].restoreCalls(), 1);
    assert.equal(fixture.leaves[1].restoreCalls(), 2);
    await verifyRecordMutationSourceParticipantAborted({
      journal: restored,
      adapter: fixture.adapter
    });
  });
}

async function assertBundleIdentityDriftBlocksBeforeLeafEffects():
Promise<void> {
  await withBundleFixture("identity-drift", async (fixture) => {
    assert.throws(
      () => createRecordMutationSourceBundleAdapter({
        ...fixture.adapterInput,
        selectionDigest: `sha256:${"f".repeat(64)}`
      }),
      /participant identity/
    );
    assert.throws(
      () => createRecordMutationSourceBundleAdapter({
        ...fixture.adapterInput,
        leafAdapters: [...fixture.adapterInput.leafAdapters].reverse()
      }),
      /完整同序/
    );
    assert.deepEqual(
      fixture.leaves.map((leaf) => leaf.status()),
      ["before", "before"]
    );
    assert.deepEqual(
      fixture.leaves.map((leaf) => leaf.stageCalls()),
      [0, 0]
    );
  });
}

interface FakeLeafController {
  adapter: RecordMutationSourceParticipantAdapter;
  failNextStage(): void;
  failNextRestore(): void;
  failNextRestoreAfterEffect(): void;
  stageCalls(): number;
  restoreCalls(): number;
  status(): RecordMutationSourceParticipantObservation["status"];
}

interface SourceBundleFixture {
  stagedJournal: LoadedRecordMutationJournal;
  bundleParticipantId: string;
  leaves: FakeLeafController[];
  adapter: RecordMutationSourceParticipantAdapter;
  adapterInput: Parameters<
    typeof createRecordMutationSourceBundleAdapter
  >[0];
  now: () => number;
}

async function withBundleFixture(
  label: string,
  action: (fixture: SourceBundleFixture) => Promise<void>
): Promise<void> {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), `echoink-source-bundle-${label}-`)
  );
  try {
    const storageRootPath = path.join(fixtureRoot, "storage");
    const sourceRootPath = path.join(storageRootPath, "artifacts");
    const trashRootPath = path.join(storageRootPath, "trash");
    await mkdir(sourceRootPath, { recursive: true });
    await mkdir(trashRootPath, { recursive: true });
    let timestamp = 20_000;
    const now = (): number => {
      timestamp += 1;
      return timestamp;
    };
    const sourceRootBinding = await bindRoot(
      storageRootPath,
      "artifact",
      sourceRootPath,
      now()
    );
    const trashRootBinding = await bindRoot(
      storageRootPath,
      "trash",
      trashRootPath,
      now()
    );
    const selectionDigest = `sha256:${"a".repeat(64)}`;
    const subjects: RecordMutationExecutionSubject[] = [
      {
        kind: "artifact",
        artifactId: "artifact-bundle-a",
        artifactKind: "markdown-report"
      },
      {
        kind: "artifact",
        artifactId: "artifact-bundle-b",
        artifactKind: "ui-card"
      }
    ];
    const execution = {
      kind: "source-deletion-bundle" as const,
      rootId: "artifact",
      selectionDigest,
      subjects
    };
    const bundleParticipantId = recordMutationExecutionBundleParticipantId({
      recordKind: "artifact",
      action: "mark-source-deleted",
      execution
    });
    const stageParticipantId = "conversation-stage";
    const participants: RecordMutationParticipant[] = [
      {
        id: bundleParticipantId,
        recordKind: "artifact",
        action: "mark-source-deleted"
      },
      {
        id: stageParticipantId,
        recordKind: "conversation",
        action: "stage"
      }
    ].sort((left, right) => left.id.localeCompare(right.id));
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId: `mutation-${label}`,
      intent: {
        operation: "delete-conversation",
        conversationId: `conversation-${label}`,
        expectedConversationGeneration: 1,
        expectedConversationCommitId: `commit-${label}`,
        expectedConversationContentRevision:
          `sha256:${"1".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: `tombstone-${label}`,
          digest: `sha256:${"2".repeat(64)}`
        },
        participants,
        rootBindings: [
          sourceRootBinding,
          trashRootBinding
        ].sort((left, right) => left.rootId.localeCompare(right.rootId)),
        trashPolicy: "required"
      },
      createdAt: now()
    });
    const stagedJournal = await stageRecordMutationJournal(
      planned.handle,
      {
        expectedRevision: planned.record.revision,
        expectedDigest: planned.record.digest,
        step: {
          direction: "forward",
          ordinal: 1,
          participantId: stageParticipantId,
          action: "trash-staged",
          evidenceDigest: `sha256:${"3".repeat(64)}`
        },
        updatedAt: now()
      }
    );
    const leaves = subjects.map((subject) => {
      if (subject.kind !== "artifact") {
        throw new Error("expected Artifact bundle subject");
      }
      return fakeLeafAdapter({
        participantId: subject.artifactId,
        mutationId: planned.record.mutationId,
        conversationId: planned.record.intent.conversationId,
        storageRootPath,
        rootPath: sourceRootPath,
        boundaryRootPath: storageRootPath,
        rootBinding: sourceRootBinding
      });
    });
    const adapterInput = {
      storageRootPath,
      rootPath: sourceRootPath,
      boundaryRootPath: storageRootPath,
      rootBinding: sourceRootBinding,
      participantId: bundleParticipantId,
      recordKind: "artifact" as const,
      selectionDigest,
      subjects,
      leafAdapters: leaves.map((leaf) => leaf.adapter)
    };
    const adapter = createRecordMutationSourceBundleAdapter(adapterInput);
    await action({
      stagedJournal,
      bundleParticipantId,
      leaves,
      adapter,
      adapterInput,
      now
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function fakeLeafAdapter(input: {
  participantId: string;
  mutationId: string;
  conversationId: string;
  storageRootPath: string;
  rootPath: string;
  boundaryRootPath: string;
  rootBinding: RecordRootBindingRef;
}): FakeLeafController {
  let authorityHeld = false;
  let observation: RecordMutationSourceParticipantObservation = {
    status: "before"
  };
  let failStage = false;
  let failRestore = false;
  let failRestoreAfterEffect = false;
  let stageCallCount = 0;
  let restoreCallCount = 0;
  const assertIdentity = (candidate: {
    mutationId: string;
    conversationId: string;
    participantId: string;
  }): void => {
    assert.equal(candidate.mutationId, input.mutationId);
    assert.equal(candidate.conversationId, input.conversationId);
    assert.equal(candidate.participantId, input.participantId);
  };
  const requireAuthority = (): void => {
    if (!authorityHeld) throw new Error("fake leaf authority missing");
  };
  const adapter: RecordMutationSourceParticipantAdapter = {
    participantId: input.participantId,
    recordKind: "artifact",
    storageRootPath: input.storageRootPath,
    rootPath: input.rootPath,
    boundaryRootPath: input.boundaryRootPath,
    rootBinding: input.rootBinding,
    withMutation: async <T>(leafAction: () => Promise<T>): Promise<T> => {
      if (authorityHeld) throw new Error("fake leaf authority nested");
      authorityHeld = true;
      try {
        return await leafAction();
      } finally {
        authorityHeld = false;
      }
    },
    recover: async () => {
      requireAuthority();
    },
    inspect: async (identity) => {
      requireAuthority();
      assertIdentity(identity);
      return observation;
    },
    stage: async (effect) => {
      requireAuthority();
      assertIdentity(effect);
      stageCallCount += 1;
      if (failStage) {
        failStage = false;
        throw new Error("injected bundle leaf stage failure");
      }
      if (observation.status === "source-restored") {
        throw new Error("fake leaf is already restored");
      }
      if (observation.status === "source-deleted") {
        return observation.forwardReceipt;
      }
      const forwardReceipt = leafReceipt({
        ...input,
        phase: "source-deleted",
        occurredAt: effect.occurredAt
      });
      observation = { status: "source-deleted", forwardReceipt };
      return forwardReceipt;
    },
    restore: async (effect) => {
      requireAuthority();
      assertIdentity(effect);
      restoreCallCount += 1;
      if (failRestore) {
        failRestore = false;
        throw new Error("injected bundle leaf restore failure");
      }
      if (observation.status === "before") {
        throw new Error("fake leaf forward receipt missing");
      }
      assert.equal(
        observation.forwardReceipt.digest,
        effect.forwardReceipt.digest
      );
      if (observation.status === "source-restored") {
        return observation.restoreReceipt;
      }
      const restoreReceipt = leafReceipt({
        ...input,
        phase: "source-restored",
        occurredAt: effect.occurredAt
      });
      observation = {
        status: "source-restored",
        forwardReceipt: observation.forwardReceipt,
        restoreReceipt
      };
      if (failRestoreAfterEffect) {
        failRestoreAfterEffect = false;
        throw new Error(
          "injected bundle leaf restore post-effect failure"
        );
      }
      return restoreReceipt;
    }
  };
  return {
    adapter,
    failNextStage: () => {
      failStage = true;
    },
    failNextRestore: () => {
      failRestore = true;
    },
    failNextRestoreAfterEffect: () => {
      failRestoreAfterEffect = true;
    },
    stageCalls: () => stageCallCount,
    restoreCalls: () => restoreCallCount,
    status: () => observation.status
  };
}

function leafReceipt(input: {
  mutationId: string;
  conversationId: string;
  participantId: string;
  phase: "source-deleted" | "source-restored";
  occurredAt: number;
}): RecordMutationSourceParticipantReceipt {
  return createRecordMutationSourceParticipantReceipt({
    mutationId: input.mutationId,
    conversationId: input.conversationId,
    participantId: input.participantId,
    recordKind: "artifact",
    phase: input.phase,
    effectId: `${input.participantId}-${input.phase}`,
    effectDigest: recordMutationDigest({
      kind: "fake-source-bundle-leaf-effect",
      participantId: input.participantId,
      phase: input.phase,
      occurredAt: input.occurredAt
    }),
    occurredAt: input.occurredAt
  });
}

async function bindRoot(
  storageRootPath: string,
  rootId: string,
  rootPath: string,
  createdAt: number
): Promise<RecordRootBindingRef> {
  const loaded = await createOrLoadRecordRootBinding({
    storageRootPath,
    rootId,
    rootPath,
    boundaryRootPath: storageRootPath,
    authority: "plugin-owned",
    createdAt
  });
  return recordRootBindingRef(loaded.binding);
}

function participantSteps(
  journal: LoadedRecordMutationJournal,
  participantId: string
): NonNullable<LoadedRecordMutationJournal["record"]["step"]>[] {
  return journal.chain.flatMap((revision) => (
    revision.step?.participantId === participantId
      ? [revision.step]
      : []
  ));
}

if (process.env.ECHOINK_RUN_SOURCE_BUNDLE_TEST === "1") {
  runHarnessV2RecordMutationSourceBundleTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
