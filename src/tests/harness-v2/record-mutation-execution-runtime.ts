import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  materializeRecordMutationExecution,
  registerRecordMutationRuntimeRoots,
  RecordMutationExecutionRuntimeError,
  type RecordMutationRuntimeRoot
} from "../../harness/lifecycle/record-mutation-execution-runtime";
import {
  createRecordMutationExecutionPlan,
  loadRecordMutationExecutionPlan,
  recordMutationExecutionBundleParticipantId,
  workflowRunPayloadParticipantId,
  type LoadedRecordMutationExecutionPlan,
  type RecordMutationExecutionParticipant
} from "../../harness/lifecycle/record-mutation-execution-plan";
import type {
  RecordMutationIntent,
  RecordMutationStep
} from "../../harness/lifecycle/record-mutation-contract";
import {
  createRecordMutationJournal,
  loadRecordMutationJournal,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import type {
  RecordMutationSourceParticipantAdapter
} from "../../harness/lifecycle/record-mutation-source-participant";

export async function runHarnessV2RecordMutationExecutionRuntimeTests():
Promise<void> {
  await assertRuntimeMaterializesPreparedParticipantsAcrossRestart();
  await assertRuntimeRootMismatchFailsBeforePrepare();
  await assertRuntimeAdapterMismatchFailsBeforePrepare();
  await assertTrashBundleMaterializesAcrossRestart();
  await assertSourceDeletionBundleMaterializesBeforeTrashPrepare();
  await assertRetainBundleRequiresFrozenSelectionVerification();
  await assertRetainBundleRejectsInvalidJournalEvidence();
  await assertRetainBundleRechecksPhysicalRootsAfterVerification();
}

async function assertRuntimeMaterializesPreparedParticipantsAcrossRestart():
Promise<void> {
  await withFixture("restart", async (fixture) => {
    const { journal, plan } = await createPlannedExecution(
      fixture,
      "restart"
    );
    const first = await materializeRecordMutationExecution({
      journal,
      plan,
      roots: fixture.roots,
      createSourceAdapter: fakeSourceAdapterFactory,
      now: fixture.now
    });

    assert.deepEqual(
      participantActions(first.journal, "conversation-payload"),
      ["trash-staged"]
    );
    assert.deepEqual(
      participantActions(first.journal, "workflow-run-1"),
      ["trash-staged"]
    );
    assert.deepEqual(
      first.trashParticipants.map((participant) => participant.participantId),
      ["conversation-payload", "workflow-run-1"]
    );
    assert.deepEqual(
      first.sourceDeletedParticipants.map(
        (participant) => participant.participantId
      ),
      ["artifact-report", "memory-decision"]
    );
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );
    assert.equal(
      await readFile(fixture.runSourcePath, "utf8"),
      "run\n"
    );

    const reloadedJournal = await loadRecordMutationJournal(
      first.journal.handle
    );
    const reloadedPlan = await loadRecordMutationExecutionPlan({
      storageRootPath: fixture.storageRootPath,
      mutationId: reloadedJournal.record.mutationId,
      journal: reloadedJournal
    });
    assert.ok(reloadedPlan);
    const replayed = await materializeRecordMutationExecution({
      journal: reloadedJournal,
      plan: reloadedPlan,
      roots: fixture.roots,
      createSourceAdapter: fakeSourceAdapterFactory,
      now: fixture.now
    });
    assert.equal(
      replayed.journal.record.digest,
      first.journal.record.digest
    );
    assert.deepEqual(
      replayed.trashParticipants.map(
        (participant) => (
          participant.kind === "bundle"
            ? participant.preparedReceipt.digest
            : participant.receipt.digest
        )
      ),
      first.trashParticipants.map(
        (participant) => (
          participant.kind === "bundle"
            ? participant.preparedReceipt.digest
            : participant.receipt.digest
        )
      )
    );
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );
    assert.equal(await readFile(fixture.runSourcePath, "utf8"), "run\n");
  });
}

async function assertRuntimeRootMismatchFailsBeforePrepare(): Promise<void> {
  await withFixture("root-mismatch", async (fixture) => {
    const { journal, plan } = await createPlannedExecution(
      fixture,
      "root-mismatch"
    );
    const roots = fixture.roots.map((root) => (
      root.rootId === "conversation"
        ? {
            ...root,
            rootBinding: fixture.roots.find(
              (candidate) => candidate.rootId === "run"
            )!.rootBinding
          }
        : root
    ));
    await assert.rejects(
      materializeRecordMutationExecution({
        journal,
        plan,
        roots,
        createSourceAdapter: fakeSourceAdapterFactory,
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "root_mismatch"
      )
    );
    const readback = await loadRecordMutationJournal(journal.handle);
    assert.equal(readback.record.state, "planned");
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );
  });
}

async function assertRuntimeAdapterMismatchFailsBeforePrepare(): Promise<void> {
  await withFixture("adapter-mismatch", async (fixture) => {
    const { journal, plan } = await createPlannedExecution(
      fixture,
      "adapter-mismatch"
    );
    await assert.rejects(
      materializeRecordMutationExecution({
        journal,
        plan,
        roots: fixture.roots,
        createSourceAdapter: (input) => ({
          ...fakeSourceAdapterFactory(input),
          participantId: `wrong-${input.participant.participantId}`
        }),
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "adapter_mismatch"
      )
    );
    const readback = await loadRecordMutationJournal(journal.handle);
    assert.equal(readback.record.state, "planned");
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );
  });
}

async function assertTrashBundleMaterializesAcrossRestart(): Promise<void> {
  await withFixture("bundle-materialized", async (fixture) => {
    const execution = {
      kind: "trash-bundle" as const,
      sourceRootId: "conversation",
      trashRootId: "trash",
      selectionDigest: `sha256:${"5".repeat(64)}`,
      items: [{
        itemId: "conversation-source",
        sourceRelativePath: "session-a/payloads/payload-1"
      }]
    };
    const participant: RecordMutationExecutionParticipant = {
      participantId: recordMutationExecutionBundleParticipantId({
        recordKind: "conversation",
        action: "stage",
        execution
      }),
      recordKind: "conversation",
      action: "stage",
      execution
    };
    const journal = await createRecordMutationJournal({
      storageRootPath: fixture.storageRootPath,
      mutationId: "execution-runtime-bundle-blocked",
      intent: {
        operation: "delete-conversation",
        conversationId: "conversation-bundle-blocked",
        expectedConversationGeneration: 3,
        expectedConversationCommitId: "conversation-commit-3",
        expectedConversationContentRevision:
          `sha256:${"6".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "tombstone-bundle-blocked",
          digest: `sha256:${"7".repeat(64)}`
        },
        participants: [{
          id: participant.participantId,
          recordKind: participant.recordKind,
          action: participant.action
        }],
        rootBindings: fixture.roots
          .filter((root) => root.rootId === "conversation" || root.rootId === "trash")
          .map((root) => root.rootBinding),
        trashPolicy: "required"
      },
      createdAt: fixture.now()
    });
    const plan = await createRecordMutationExecutionPlan({
      journal,
      participants: [participant],
      createdAt: fixture.now()
    });
    const roots = fixture.roots.filter(
      (root) => root.rootId === "conversation" || root.rootId === "trash"
    );
    const materialized = await materializeRecordMutationExecution({
      journal,
      plan,
      roots,
      now: fixture.now
    });
    assert.deepEqual(
      participantActions(materialized.journal, participant.participantId),
      ["trash-staged"]
    );
    assert.equal(materialized.trashParticipants.length, 1);
    const bundle = materialized.trashParticipants[0];
    assert.equal(bundle.kind, "bundle");
    if (bundle.kind !== "bundle") {
      throw new Error("expected bundle trash participant");
    }
    assert.equal(bundle.preparedReceipt.leaves.length, 1);
    assert.equal(bundle.leafReceipts.length, 1);
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );

    const reloadedJournal = await loadRecordMutationJournal(
      materialized.journal.handle
    );
    const reloadedPlan = await loadRecordMutationExecutionPlan({
      storageRootPath: fixture.storageRootPath,
      mutationId: reloadedJournal.record.mutationId,
      journal: reloadedJournal
    });
    assert.ok(reloadedPlan);
    const replayed = await materializeRecordMutationExecution({
      journal: reloadedJournal,
      plan: reloadedPlan,
      roots,
      now: fixture.now
    });
    const replayedBundle = replayed.trashParticipants[0];
    assert.equal(replayedBundle.kind, "bundle");
    if (replayedBundle.kind !== "bundle") {
      throw new Error("expected replayed bundle trash participant");
    }
    assert.equal(
      replayedBundle.preparedReceipt.digest,
      bundle.preparedReceipt.digest
    );
    assert.equal(
      replayed.journal.record.digest,
      materialized.journal.record.digest
    );
  });
}

async function assertSourceDeletionBundleMaterializesBeforeTrashPrepare():
Promise<void> {
  await withFixture("source-bundle-blocked", async (fixture) => {
    const selectionDigest = `sha256:${"8".repeat(64)}`;
    const subject = {
      kind: "workflow-run" as const,
      workflowRunId: "workflow-run-1",
      attemptId: "attempt-1",
      harnessRunId: "harness-run-1",
      payloadDigest: `sha256:${"9".repeat(64)}`
    };
    const item = {
      itemId: workflowRunPayloadParticipantId(
        subject.workflowRunId,
        subject.attemptId
      ),
      sourceRelativePath: "attempt-payloads/workflow-run-1"
    };
    const sourceExecution = {
      kind: "source-deletion-bundle" as const,
      rootId: "run",
      selectionDigest,
      subjects: [subject]
    };
    const trashExecution = {
      kind: "trash-bundle" as const,
      sourceRootId: "run",
      trashRootId: "trash",
      selectionDigest,
      items: [item]
    };
    const conversationExecution = {
      kind: "trash-bundle" as const,
      sourceRootId: "conversation",
      trashRootId: "trash",
      selectionDigest,
      items: [{
        itemId: "conversation-source",
        sourceRelativePath: "session-a/payloads/payload-1"
      }]
    };
    const participants: RecordMutationExecutionParticipant[] = [
      {
        participantId: recordMutationExecutionBundleParticipantId({
          recordKind: "conversation",
          action: "stage",
          execution: conversationExecution
        }),
        recordKind: "conversation",
        action: "stage",
        execution: conversationExecution
      },
      {
        participantId: recordMutationExecutionBundleParticipantId({
          recordKind: "workflow-run",
          action: "mark-source-deleted",
          execution: sourceExecution
        }),
        recordKind: "workflow-run",
        action: "mark-source-deleted",
        execution: sourceExecution
      },
      {
        participantId: recordMutationExecutionBundleParticipantId({
          recordKind: "workflow-run",
          action: "discard",
          execution: trashExecution
        }),
        recordKind: "workflow-run",
        action: "discard",
        execution: trashExecution
      }
    ].sort((left, right) => (
      left.participantId.localeCompare(right.participantId)
    ));
    const roots = fixture.roots.filter(
      (root) =>
        root.rootId === "conversation"
        || root.rootId === "run"
        || root.rootId === "trash"
    );
    const journal = await createRecordMutationJournal({
      storageRootPath: fixture.storageRootPath,
      mutationId: "execution-runtime-source-bundle-blocked",
      intent: {
        operation: "delete-conversation",
        conversationId: "conversation-source-bundle-blocked",
        expectedConversationGeneration: 3,
        expectedConversationCommitId: "conversation-commit-3",
        expectedConversationContentRevision:
          `sha256:${"a".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "tombstone-source-bundle-blocked",
          digest: `sha256:${"b".repeat(64)}`
        },
        participants: participants.map((participant) => ({
          id: participant.participantId,
          recordKind: participant.recordKind,
          action: participant.action
        })),
        rootBindings: roots.map((root) => root.rootBinding),
        trashPolicy: "required"
      },
      createdAt: fixture.now()
    });
    const plan = await createRecordMutationExecutionPlan({
      journal,
      participants,
      createdAt: fixture.now()
    });
    const materialized = await materializeRecordMutationExecution({
      journal,
      plan,
      roots,
      createSourceAdapter: fakeSourceAdapterFactory,
      now: fixture.now
    });
    assert.equal(materialized.sourceDeletedParticipants.length, 1);
    assert.equal(
      materialized.sourceDeletedParticipants[0]?.participantId,
      participants.find(
        (participant) =>
          participant.execution.kind === "source-deletion-bundle"
      )?.participantId
    );
    assert.equal(materialized.trashParticipants.length, 2);
    assert.equal(materialized.journal.record.state, "staged");
    assert.equal(await readFile(fixture.runSourcePath, "utf8"), "run\n");
  });
}

async function assertRetainBundleRequiresFrozenSelectionVerification():
Promise<void> {
  await withFixture("retain-bundle-verification", async (fixture) => {
    const {
      journal,
      plan,
      roots,
      retainParticipants,
      trashParticipant
    } = await createRetainBundleExecution(
      fixture,
      "retain-verification"
    );
    await assert.rejects(
      materializeRecordMutationExecution({
        journal,
        plan,
        roots,
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "inventory_verification_required"
      )
    );
    assert.equal(
      (await loadRecordMutationJournal(journal.handle)).record.state,
      "planned"
    );
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );

    let rejectedVerificationCalls = 0;
    await assert.rejects(
      materializeRecordMutationExecution({
        journal,
        plan,
        roots,
        verifyFrozenSelection: async () => {
          rejectedVerificationCalls += 1;
          throw new Error("fixture inventory mismatch");
        },
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "inventory_mismatch"
      )
    );
    assert.equal(rejectedVerificationCalls, 1);
    assert.equal(
      (await loadRecordMutationJournal(journal.handle)).record.state,
      "planned"
    );

    let verificationCalls = 0;
    const materialized = await materializeRecordMutationExecution({
      journal,
      plan,
      roots,
      verifyFrozenSelection: async (input) => {
        verificationCalls += 1;
        assert.equal(input.plan.digest, plan.plan.digest);
        assert.equal(input.journal.record.digest, journal.record.digest);
      },
      now: fixture.now
    });
    assert.equal(verificationCalls, 1);
    assert.equal(retainParticipants.length, 2);
    for (const retainParticipant of retainParticipants) {
      assert.deepEqual(
        participantActions(
          materialized.journal,
          retainParticipant.participantId
        ),
        ["prepared"]
      );
    }
    assert.deepEqual(
      materialized.journal.chain.flatMap((revision) => (
        revision.step ? [revision.step.action] : []
      )),
      ["prepared", "prepared", "trash-staged"],
      "all retain proofs must publish before the first Trash preparation"
    );
    assert.deepEqual(
      participantActions(
        materialized.journal,
        trashParticipant.participantId
      ),
      ["trash-staged"]
    );
    assert.equal(materialized.trashParticipants.length, 1);

    const replayed = await materializeRecordMutationExecution({
      journal,
      plan,
      roots,
      now: fixture.now
    });
    assert.equal(
      replayed.journal.record.digest,
      materialized.journal.record.digest,
      "stale caller snapshots must reload durable retain evidence"
    );
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );
  });
}

async function assertRetainBundleRejectsInvalidJournalEvidence():
Promise<void> {
  await withFixture("retain-bundle-invalid-evidence", async (fixture) => {
    const first = await createRetainBundleExecution(
      fixture,
      "retain-invalid-evidence"
    );
    const invalidEvidence = await stageRecordMutationJournal(
      first.journal.handle,
      {
        expectedRevision: first.journal.record.revision,
        expectedDigest: first.journal.record.digest,
        step: {
          direction: "forward",
          ordinal: 1,
          participantId: first.retainParticipants[0]!.participantId,
          action: "prepared",
          evidenceDigest: `sha256:${"f".repeat(64)}`
        },
        updatedAt: fixture.now()
      }
    );
    await assert.rejects(
      materializeRecordMutationExecution({
        journal: invalidEvidence,
        plan: first.plan,
        roots: first.roots,
        verifyFrozenSelection: async () => undefined,
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "inventory_mismatch"
      )
    );
    assert.deepEqual(
      participantActions(
        await loadRecordMutationJournal(first.journal.handle),
        first.trashParticipant.participantId
      ),
      []
    );
    assert.equal(
      await readFile(fixture.conversationSourcePath, "utf8"),
      "conversation\n"
    );

    const second = await createRetainBundleExecution(
      fixture,
      "retain-missing-after-trash"
    );
    const prematureTrash = await stageRecordMutationJournal(
      second.journal.handle,
      {
        expectedRevision: second.journal.record.revision,
        expectedDigest: second.journal.record.digest,
        step: {
          direction: "forward",
          ordinal: 1,
          participantId: second.trashParticipant.participantId,
          action: "trash-staged",
          evidenceDigest: `sha256:${"e".repeat(64)}`
        },
        updatedAt: fixture.now()
      }
    );
    await assert.rejects(
      materializeRecordMutationExecution({
        journal: prematureTrash,
        plan: second.plan,
        roots: second.roots,
        verifyFrozenSelection: async () => undefined,
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "inventory_mismatch"
      )
    );
    for (const retainParticipant of second.retainParticipants) {
      assert.deepEqual(
        participantActions(
          await loadRecordMutationJournal(second.journal.handle),
          retainParticipant.participantId
        ),
        []
      );
    }
  });
}

async function assertRetainBundleRechecksPhysicalRootsAfterVerification():
Promise<void> {
  await withFixture("retain-bundle-root-drift", async (fixture) => {
    const prepared = await createRetainBundleExecution(
      fixture,
      "retain-root-drift"
    );
    const runRoot = prepared.roots.find((root) => root.rootId === "run");
    assert.ok(runRoot);
    await assert.rejects(
      materializeRecordMutationExecution({
        journal: prepared.journal,
        plan: prepared.plan,
        roots: prepared.roots,
        verifyFrozenSelection: async () => {
          await rename(runRoot.rootPath, `${runRoot.rootPath}-replaced`);
          await mkdir(runRoot.rootPath);
        },
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "root_mismatch"
      )
    );
    assert.equal(
      (await loadRecordMutationJournal(prepared.journal.handle)).record.state,
      "planned"
    );
    assert.deepEqual(
      participantActions(
        await loadRecordMutationJournal(prepared.journal.handle),
        prepared.trashParticipant.participantId
      ),
      []
    );
  });
}

async function createRetainBundleExecution(
  fixture: ExecutionRuntimeFixture,
  suffix: string
): Promise<{
  journal: LoadedRecordMutationJournal;
  plan: LoadedRecordMutationExecutionPlan;
  roots: RecordMutationRuntimeRoot[];
  retainParticipants: Array<Extract<
    RecordMutationExecutionParticipant,
    { execution: { kind: "retain-bundle" } }
  >>;
  trashParticipant: Extract<
    RecordMutationExecutionParticipant,
    { execution: { kind: "trash-bundle" } }
  >;
}> {
  const selectionDigest = `sha256:${"c".repeat(64)}`;
  const runRetainExecution = {
    kind: "retain-bundle" as const,
    rootId: "run",
    selectionDigest,
    subjects: [{
      kind: "attempt-payload-not-captured" as const,
      workflowRunId: "workflow-retained",
      attemptId: "attempt-retained",
      reasonCode: "capture-disabled" as const
    }]
  };
  const rawRetainExecution = {
    kind: "retain-bundle" as const,
    rootId: "raw",
    selectionDigest,
    subjects: [{
      kind: "raw" as const,
      rawRef: "raw/shared.txt",
      sourceRelativePath: "shared.txt",
      ownersDigest: `sha256:${"b".repeat(64)}`
    }]
  };
  const trashExecution = {
    kind: "trash-bundle" as const,
    sourceRootId: "conversation",
    trashRootId: "trash",
    selectionDigest,
    items: [{
      itemId: "conversation-source",
      sourceRelativePath: "session-a/payloads/payload-1"
    }]
  };
  const participants: RecordMutationExecutionParticipant[] = [
    {
      participantId: recordMutationExecutionBundleParticipantId({
        recordKind: "workflow-run",
        action: "retain",
        execution: runRetainExecution
      }),
      recordKind: "workflow-run",
      action: "retain",
      execution: runRetainExecution
    },
    {
      participantId: recordMutationExecutionBundleParticipantId({
        recordKind: "raw",
        action: "retain",
        execution: rawRetainExecution
      }),
      recordKind: "raw",
      action: "retain",
      execution: rawRetainExecution
    },
    {
      participantId: recordMutationExecutionBundleParticipantId({
        recordKind: "conversation",
        action: "stage",
        execution: trashExecution
      }),
      recordKind: "conversation",
      action: "stage",
      execution: trashExecution
    }
  ].sort((left, right) => (
    left.participantId.localeCompare(right.participantId)
  ));
  const retainParticipants = participants.filter(
    (participant): participant is Extract<
      RecordMutationExecutionParticipant,
      { execution: { kind: "retain-bundle" } }
    > => participant.execution.kind === "retain-bundle"
  );
  const trashParticipant = participants.find(
    (participant): participant is Extract<
      RecordMutationExecutionParticipant,
      { execution: { kind: "trash-bundle" } }
    > => participant.execution.kind === "trash-bundle"
  );
  assert.ok(trashParticipant);
  const rawRootPath = path.join(fixture.storageRootPath, "raw");
  await mkdir(rawRootPath, { recursive: true });
  const roots = await registerRecordMutationRuntimeRoots({
    storageRootPath: fixture.storageRootPath,
    definitions: [
      "conversation",
      "raw",
      "run",
      "trash"
    ].map((rootId) => ({
      rootId,
      rootPath: path.join(fixture.storageRootPath, rootId),
      boundaryRootPath: fixture.storageRootPath,
      authority: "plugin-owned" as const
    })),
    createdAt: fixture.now()
  });
  const journal = await createRecordMutationJournal({
    storageRootPath: fixture.storageRootPath,
    mutationId: `execution-runtime-${suffix}`,
    intent: {
      operation: "delete-conversation",
      conversationId: `conversation-${suffix}`,
      expectedConversationGeneration: 3,
      expectedConversationCommitId: "conversation-commit-3",
      expectedConversationContentRevision:
        `sha256:${"d".repeat(64)}`,
      targetConversation: {
        status: "deleted",
        tombstoneId: `tombstone-${suffix}`,
        digest: `sha256:${"e".repeat(64)}`
      },
      participants: participants.map((participant) => ({
        id: participant.participantId,
        recordKind: participant.recordKind,
        action: participant.action
      })),
      rootBindings: roots.map((root) => root.rootBinding),
      trashPolicy: "required"
    },
    createdAt: fixture.now()
  });
  const plan = await createRecordMutationExecutionPlan({
    journal,
    participants,
    createdAt: fixture.now()
  });
  return {
    journal,
    plan,
    roots,
    retainParticipants,
    trashParticipant
  };
}

function fakeSourceAdapterFactory(input: {
  journal: LoadedRecordMutationJournal;
  participant: Extract<
    RecordMutationExecutionParticipant,
    { action: "mark-source-deleted" }
  >;
  root: RecordMutationRuntimeRoot;
}): RecordMutationSourceParticipantAdapter {
  return {
    participantId: input.participant.participantId,
    recordKind: input.participant.recordKind,
    storageRootPath: input.journal.handle.storageRootPath,
    rootPath: input.root.rootPath,
    boundaryRootPath: input.root.boundaryRootPath,
    rootBinding: input.root.rootBinding,
    withMutation: async (action) => await action(),
    recover: async () => undefined,
    inspect: async () => ({ status: "before" }),
    stage: async () => {
      throw new Error("fixture adapter stage should not run during materialize");
    },
    restore: async () => {
      throw new Error("fixture adapter restore should not run during materialize");
    }
  };
}

interface ExecutionRuntimeFixture {
  rootPath: string;
  storageRootPath: string;
  roots: RecordMutationRuntimeRoot[];
  conversationSourcePath: string;
  runSourcePath: string;
  now: () => number;
}

async function withFixture(
  suffix: string,
  action: (fixture: ExecutionRuntimeFixture) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-execution-runtime-${suffix}-`)
  );
  try {
    const storageRootPath = path.join(rootPath, "storage");
    await mkdir(storageRootPath);
    const definitions = [
      "artifact",
      "conversation",
      "memory",
      "run",
      "trash"
    ].map((rootId) => ({
      rootId,
      rootPath: path.join(storageRootPath, rootId),
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned" as const
    }));
    for (const definition of definitions) {
      await mkdir(definition.rootPath);
    }
    const roots = await registerRecordMutationRuntimeRoots({
      storageRootPath,
      definitions,
      createdAt: 2_000
    });
    const conversationSourcePath = path.join(
      storageRootPath,
      "conversation",
      "session-a",
      "payloads",
      "payload-1"
    );
    const runSourcePath = path.join(
      storageRootPath,
      "run",
      "attempt-payloads",
      "workflow-run-1"
    );
    await mkdir(path.dirname(conversationSourcePath), { recursive: true });
    await mkdir(path.dirname(runSourcePath), { recursive: true });
    await writeFile(conversationSourcePath, "conversation\n");
    await writeFile(runSourcePath, "run\n");
    let now = 2_100;
    await action({
      rootPath,
      storageRootPath,
      roots,
      conversationSourcePath,
      runSourcePath,
      now: () => {
        now += 1;
        return now;
      }
    });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function createPlannedExecution(
  fixture: ExecutionRuntimeFixture,
  suffix: string
): Promise<{
  journal: LoadedRecordMutationJournal;
  plan: LoadedRecordMutationExecutionPlan;
}> {
  const journal = await createRecordMutationJournal({
    storageRootPath: fixture.storageRootPath,
    mutationId: `execution-runtime-${suffix}`,
    intent: destructiveIntent(
      `conversation-${suffix}`,
      fixture.roots
    ),
    createdAt: fixture.now()
  });
  const plan = await createRecordMutationExecutionPlan({
    journal,
    participants: executionParticipants(),
    createdAt: fixture.now()
  });
  return { journal, plan };
}

function destructiveIntent(
  conversationId: string,
  roots: readonly RecordMutationRuntimeRoot[]
): RecordMutationIntent {
  return {
    operation: "delete-conversation",
    conversationId,
    expectedConversationGeneration: 3,
    expectedConversationCommitId: "conversation-commit-3",
    expectedConversationContentRevision: `sha256:${"3".repeat(64)}`,
    targetConversation: {
      status: "deleted",
      tombstoneId: `tombstone-${conversationId}`,
      digest: `sha256:${"4".repeat(64)}`
    },
    participants: executionParticipants().map((participant) => ({
      id: participant.participantId,
      recordKind: participant.recordKind,
      action: participant.action
    })),
    rootBindings: roots.map((root) => root.rootBinding),
    trashPolicy: "required"
  };
}

function executionParticipants(): RecordMutationExecutionParticipant[] {
  return [
    {
      participantId: "artifact-report",
      recordKind: "artifact",
      action: "mark-source-deleted",
      execution: {
        kind: "source-deletion",
        rootId: "artifact",
        subject: {
          kind: "artifact",
          artifactId: "artifact-report",
          artifactKind: "markdown-report"
        }
      }
    },
    {
      participantId: "conversation-payload",
      recordKind: "conversation",
      action: "stage",
      execution: {
        kind: "trash",
        sourceRootId: "conversation",
        trashRootId: "trash",
        sourceRelativePath: "session-a/payloads/payload-1"
      }
    },
    {
      participantId: "memory-decision",
      recordKind: "memory",
      action: "mark-source-deleted",
      execution: {
        kind: "source-deletion",
        rootId: "memory",
        subject: {
          kind: "memory",
          memoryId: "memory-decision",
          state: "formal"
        }
      }
    },
    {
      participantId: "raw-retain",
      recordKind: "raw",
      action: "retain",
      execution: { kind: "retain" }
    },
    {
      participantId: "workflow-run-1",
      recordKind: "workflow-run",
      action: "discard",
      execution: {
        kind: "trash",
        sourceRootId: "run",
        trashRootId: "trash",
        sourceRelativePath: "attempt-payloads/workflow-run-1"
      }
    }
  ];
}

function participantActions(
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
