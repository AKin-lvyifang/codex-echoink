import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createRecordMutationExecutionPlan,
  loadRecordMutationExecutionPlan,
  recordMutationExecutionBundleParticipantId,
  RecordMutationExecutionPlanError,
  validateRecordMutationExecutionPlanAgainstJournal,
  workflowRunPayloadParticipantId,
  type RecordMutationExecutionParticipant
} from "../../harness/lifecycle/record-mutation-execution-plan";
import type { RecordMutationIntent } from "../../harness/lifecycle/record-mutation-contract";
import {
  createRecordMutationJournal,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef,
  type RecordRootBindingRef
} from "../../harness/storage/record-root-registry";

export async function runHarnessV2RecordMutationExecutionPlanTests():
Promise<void> {
  await assertExecutionPlanSurvivesRestartWithoutPhysicalPaths();
  await assertExistingPlanCanBeRecoveredAfterJournalStage();
  await assertMissingPlanCannotBeInventedAfterJournalStage();
  await assertPlanRejectsSubjectAndRootDrift();
  await assertPlanCorruptionFailsClosed();
  await assertBundlesCoverMoreThanJournalParticipantLimit();
}

async function assertExecutionPlanSurvivesRestartWithoutPhysicalPaths():
Promise<void> {
  await withFixture("restart", async (fixture) => {
    const journal = await createJournal(fixture, "restart");
    const plan = await createRecordMutationExecutionPlan({
      journal,
      participants: executionParticipants(),
      createdAt: 1_100
    });
    const serialized = await readFile(plan.handle.planPath, "utf8");
    assert.equal(serialized.includes(fixture.rootPath), false);
    assert.equal(serialized.includes(fixture.storageRootPath), false);

    const reloaded = await loadRecordMutationExecutionPlan({
      storageRootPath: fixture.storageRootPath,
      mutationId: journal.record.mutationId,
      journal
    });
    assert.ok(reloaded);
    assert.deepEqual(reloaded.plan, plan.plan);
    assert.equal(
      reloaded.plan.participants.find(
        (participant) => participant.participantId === "memory-decision"
      )?.execution.kind,
      "source-deletion"
    );
  });
}

async function assertExistingPlanCanBeRecoveredAfterJournalStage():
Promise<void> {
  await withFixture("idempotent", async (fixture) => {
    const journal = await createJournal(fixture, "idempotent");
    const created = await createRecordMutationExecutionPlan({
      journal,
      participants: executionParticipants(),
      createdAt: 1_200
    });
    const staged = await stageRecordMutationJournal(journal.handle, {
      expectedRevision: journal.record.revision,
      expectedDigest: journal.record.digest,
      step: {
        direction: "forward",
        ordinal: 1,
        participantId: "conversation-payload",
        action: "prepared",
        evidenceDigest: created.plan.digest
      },
      updatedAt: 1_201
    });

    const recovered = await createRecordMutationExecutionPlan({
      journal: staged,
      participants: executionParticipants(),
      createdAt: 9_999
    });
    assert.equal(recovered.plan.digest, created.plan.digest);
    assert.equal(recovered.plan.createdAt, 1_200);
  });
}

async function assertMissingPlanCannotBeInventedAfterJournalStage():
Promise<void> {
  await withFixture("late", async (fixture) => {
    const journal = await createJournal(fixture, "late");
    const staged = await stageRecordMutationJournal(journal.handle, {
      expectedRevision: journal.record.revision,
      expectedDigest: journal.record.digest,
      step: {
        direction: "forward",
        ordinal: 1,
        participantId: "conversation-payload",
        action: "prepared",
        evidenceDigest: journal.record.intentDigest
      },
      updatedAt: 1_301
    });
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal: staged,
        participants: executionParticipants(),
        createdAt: 1_302
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "journal_mismatch"
      )
    );
  });
}

async function assertPlanRejectsSubjectAndRootDrift(): Promise<void> {
  await withFixture("drift", async (fixture) => {
    const journal = await createJournal(fixture, "drift");
    const wrongSubject = executionParticipants().map((participant) => (
      participant.participantId === "memory-decision"
        ? {
            ...participant,
            execution: {
              kind: "source-deletion" as const,
              rootId: "memory",
              subject: {
                kind: "memory" as const,
                memoryId: "different-memory",
                state: "formal" as const
              }
            }
          }
        : participant
    ));
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal,
        participants: wrongSubject,
        createdAt: 1_400
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "journal_mismatch"
      )
    );

    const missingRoot = executionParticipants().map((participant) => (
      participant.participantId === "artifact-report"
        ? {
            ...participant,
            execution: {
              ...participant.execution,
              rootId: "memory"
            }
          } as RecordMutationExecutionParticipant
        : participant
    ));
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal,
        participants: missingRoot,
        createdAt: 1_401
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "journal_mismatch"
      )
    );

    const unsafePath = executionParticipants().map((participant) => (
      participant.participantId === "conversation-payload"
        ? {
            ...participant,
            execution: {
              ...participant.execution,
              sourceRelativePath: "../conversation"
            }
          } as RecordMutationExecutionParticipant
        : participant
    ));
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal,
        participants: unsafePath,
        createdAt: 1_402
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "invalid_plan"
      )
    );

  });
}

async function assertPlanCorruptionFailsClosed(): Promise<void> {
  await withFixture("corrupt", async (fixture) => {
    const journal = await createJournal(fixture, "corrupt");
    const created = await createRecordMutationExecutionPlan({
      journal,
      participants: executionParticipants(),
      createdAt: 1_500
    });
    const parsed = JSON.parse(
      await readFile(created.handle.planPath, "utf8")
    ) as { intentDigest: string };
    parsed.intentDigest = `sha256:${"f".repeat(64)}`;
    await writeFile(created.handle.planPath, `${JSON.stringify(parsed)}\n`);

    await assert.rejects(
      loadRecordMutationExecutionPlan({
        storageRootPath: fixture.storageRootPath,
        mutationId: journal.record.mutationId,
        journal
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "invalid_plan"
      )
    );

    await assert.rejects(
      Promise.resolve().then(() =>
        validateRecordMutationExecutionPlanAgainstJournal(
          created.plan,
          {
            ...journal,
            record: {
              ...journal.record,
              mutationId: "different-mutation"
            }
          }
        )
      ),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "journal_mismatch"
      )
    );
  });
}

async function assertBundlesCoverMoreThanJournalParticipantLimit():
Promise<void> {
  await withFixture("bundle-capacity", async (fixture) => {
    const participants = bundleExecutionParticipants();
    const journal = await createRecordMutationJournal({
      storageRootPath: fixture.storageRootPath,
      mutationId: "execution-plan-bundle-capacity",
      intent: {
        operation: "delete-conversation",
        conversationId: "conversation-bundle-capacity",
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"8".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "tombstone-bundle-capacity",
          digest: `sha256:${"9".repeat(64)}`
        },
        participants: participants.map((participant) => ({
          id: participant.participantId,
          recordKind: participant.recordKind,
          action: participant.action
        })),
        rootBindings: [
          fixture.bindings.conversation,
          fixture.bindings.run,
          fixture.bindings.trash
        ].sort((left, right) => left.rootId.localeCompare(right.rootId)),
        trashPolicy: "required"
      },
      createdAt: 1_600
    });
    const created = await createRecordMutationExecutionPlan({
      journal,
      participants,
      createdAt: 1_601
    });
    assert.equal(created.plan.participants.length, 3);
    assert.equal(
      created.plan.participants.reduce((count, participant) => {
        if (participant.execution.kind === "trash-bundle") {
          return count + participant.execution.items.length;
        }
        if (participant.execution.kind === "source-deletion-bundle") {
          return count + participant.execution.subjects.length;
        }
        return count;
      }, 0),
      129,
      "three logical participants must bind 129 leaf records"
    );

    const tampered = structuredClone(participants);
    const sourceBundle = tampered.find(
      (participant) =>
        participant.execution.kind === "source-deletion-bundle"
    );
    if (
      !sourceBundle
      || sourceBundle.execution.kind !== "source-deletion-bundle"
      || sourceBundle.execution.subjects[0]?.kind !== "workflow-run"
    ) {
      throw new Error("expected workflow-run source bundle");
    }
    sourceBundle.execution.subjects[0].payloadDigest =
      `sha256:${"f".repeat(64)}`;
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal,
        participants: tampered,
        createdAt: 1_602
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "invalid_plan"
      )
    );

    const inconsistent = structuredClone(participants);
    const conversationBundle = inconsistent.find(
      (participant) =>
        participant.recordKind === "conversation"
        && participant.execution.kind === "trash-bundle"
    );
    if (
      !conversationBundle
      || conversationBundle.execution.kind !== "trash-bundle"
    ) {
      throw new Error("expected conversation trash bundle");
    }
    conversationBundle.execution.selectionDigest =
      `sha256:${"b".repeat(64)}`;
    conversationBundle.participantId =
      recordMutationExecutionBundleParticipantId({
        recordKind: conversationBundle.recordKind,
        action: conversationBundle.action,
        execution: conversationBundle.execution
      });
    inconsistent.sort((left, right) => (
      left.participantId.localeCompare(right.participantId)
    ));
    const inconsistentJournal = await createRecordMutationJournal({
      storageRootPath: fixture.storageRootPath,
      mutationId: "execution-plan-bundle-selection-mismatch",
      intent: {
        operation: "delete-conversation",
        conversationId: "conversation-bundle-selection-mismatch",
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"c".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "tombstone-bundle-selection-mismatch",
          digest: `sha256:${"d".repeat(64)}`
        },
        participants: inconsistent.map((participant) => ({
          id: participant.participantId,
          recordKind: participant.recordKind,
          action: participant.action
        })),
        rootBindings: [
          fixture.bindings.conversation,
          fixture.bindings.run,
          fixture.bindings.trash
        ].sort((left, right) => left.rootId.localeCompare(right.rootId)),
        trashPolicy: "required"
      },
      createdAt: 1_603
    });
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal: inconsistentJournal,
        participants: inconsistent,
        createdAt: 1_604
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "journal_mismatch"
      )
    );

    const split = structuredClone(participants);
    const originalConversationBundle = split.find(
      (participant) =>
        participant.recordKind === "conversation"
        && participant.execution.kind === "trash-bundle"
    );
    if (
      !originalConversationBundle
      || originalConversationBundle.execution.kind !== "trash-bundle"
    ) {
      throw new Error("expected conversation trash bundle");
    }
    const splitExecution = {
      ...structuredClone(originalConversationBundle.execution),
      items: [{
        itemId: "conversation-source-extra",
        sourceRelativePath:
          "sessions/conversation-bundle-capacity/context-payloads/payload-2"
      }]
    };
    split.push({
      participantId: recordMutationExecutionBundleParticipantId({
        recordKind: "conversation",
        action: "stage",
        execution: splitExecution
      }),
      recordKind: "conversation",
      action: "stage",
      execution: splitExecution
    });
    split.sort((left, right) => (
      left.participantId.localeCompare(right.participantId)
    ));
    const splitJournal = await createRecordMutationJournal({
      storageRootPath: fixture.storageRootPath,
      mutationId: "execution-plan-bundle-split-group",
      intent: {
        operation: "delete-conversation",
        conversationId: "conversation-bundle-split-group",
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"e".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "tombstone-bundle-split-group",
          digest: `sha256:${"f".repeat(64)}`
        },
        participants: split.map((participant) => ({
          id: participant.participantId,
          recordKind: participant.recordKind,
          action: participant.action
        })),
        rootBindings: [
          fixture.bindings.conversation,
          fixture.bindings.run,
          fixture.bindings.trash
        ].sort((left, right) => left.rootId.localeCompare(right.rootId)),
        trashPolicy: "required"
      },
      createdAt: 1_605
    });
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal: splitJournal,
        participants: split,
        createdAt: 1_606
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "journal_mismatch"
      ),
      "one logical bundle group must not be split to bypass capacity"
    );

    const nested = structuredClone(participants);
    const nestedConversationBundle = nested.find(
      (participant) =>
        participant.recordKind === "conversation"
        && participant.execution.kind === "trash-bundle"
    );
    if (
      !nestedConversationBundle
      || nestedConversationBundle.execution.kind !== "trash-bundle"
    ) {
      throw new Error("expected nested conversation trash bundle");
    }
    nestedConversationBundle.execution.items = [
      {
        itemId: "conversation-child",
        sourceRelativePath:
          "sessions/conversation-bundle-capacity/messages.jsonl"
      },
      {
        itemId: "conversation-parent",
        sourceRelativePath: "sessions/conversation-bundle-capacity"
      }
    ];
    nestedConversationBundle.participantId =
      recordMutationExecutionBundleParticipantId({
        recordKind: nestedConversationBundle.recordKind,
        action: nestedConversationBundle.action,
        execution: nestedConversationBundle.execution
      });
    nested.sort((left, right) => (
      left.participantId.localeCompare(right.participantId)
    ));
    const nestedJournal = await createBundleCoverageJournal({
      fixture,
      mutationId: "execution-plan-bundle-nested-path",
      conversationId: "conversation-bundle-nested-path",
      participants: nested,
      createdAt: 1_607
    });
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal: nestedJournal,
        participants: nested,
        createdAt: 1_608
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "invalid_plan"
      ),
      "nested Trash sources must fail before any runtime effect"
    );

    const incompleteRunCoverage = structuredClone(participants);
    const runTrashBundle = incompleteRunCoverage.find(
      (participant) =>
        participant.recordKind === "workflow-run"
        && participant.action === "discard"
        && participant.execution.kind === "trash-bundle"
    );
    if (
      !runTrashBundle
      || runTrashBundle.execution.kind !== "trash-bundle"
    ) {
      throw new Error("expected workflow-run trash bundle");
    }
    runTrashBundle.execution.items[0]!.itemId =
      "run-payload-coverage-mismatch";
    runTrashBundle.execution.items.sort((left, right) => (
      `${left.itemId}\0${left.sourceRelativePath}`.localeCompare(
        `${right.itemId}\0${right.sourceRelativePath}`
      )
    ));
    runTrashBundle.participantId =
      recordMutationExecutionBundleParticipantId({
        recordKind: runTrashBundle.recordKind,
        action: runTrashBundle.action,
        execution: runTrashBundle.execution
      });
    incompleteRunCoverage.sort((left, right) => (
      left.participantId.localeCompare(right.participantId)
    ));
    const incompleteRunJournal = await createBundleCoverageJournal({
      fixture,
      mutationId: "execution-plan-run-bundle-coverage-mismatch",
      conversationId: "conversation-run-bundle-coverage-mismatch",
      participants: incompleteRunCoverage,
      createdAt: 1_609
    });
    await assert.rejects(
      createRecordMutationExecutionPlan({
        journal: incompleteRunJournal,
        participants: incompleteRunCoverage,
        createdAt: 1_610
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionPlanError
        && error.code === "journal_mismatch"
      ),
      "Run source-deletion and Trash bundles must cover the same leaves"
    );
  });
}

async function createBundleCoverageJournal(input: {
  fixture: PlanFixture;
  mutationId: string;
  conversationId: string;
  participants: readonly RecordMutationExecutionParticipant[];
  createdAt: number;
}) {
  return await createRecordMutationJournal({
    storageRootPath: input.fixture.storageRootPath,
    mutationId: input.mutationId,
    intent: {
      operation: "delete-conversation",
      conversationId: input.conversationId,
      expectedConversationGeneration: 2,
      expectedConversationCommitId: "conversation-commit-2",
      expectedConversationContentRevision:
        `sha256:${"1".repeat(64)}`,
      targetConversation: {
        status: "deleted",
        tombstoneId: `${input.conversationId}-tombstone`,
        digest: `sha256:${"2".repeat(64)}`
      },
      participants: input.participants.map((participant) => ({
        id: participant.participantId,
        recordKind: participant.recordKind,
        action: participant.action
      })),
      rootBindings: [
        input.fixture.bindings.conversation,
        input.fixture.bindings.run,
        input.fixture.bindings.trash
      ].sort((left, right) => left.rootId.localeCompare(right.rootId)),
      trashPolicy: "required"
    },
    createdAt: input.createdAt
  });
}

function bundleExecutionParticipants():
RecordMutationExecutionParticipant[] {
  const selectionDigest = `sha256:${"a".repeat(64)}`;
  const runSubjects = Array.from({ length: 64 }, (_, index) => ({
    kind: "workflow-run" as const,
    workflowRunId: `workflow-bundle-${index.toString().padStart(3, "0")}`,
    attemptId: "attempt-1",
    harnessRunId: `harness-bundle-${index.toString().padStart(3, "0")}`,
    payloadDigest: `sha256:${index.toString(16).padStart(64, "0")}`
  })).sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
  const sourceExecution = {
    kind: "source-deletion-bundle" as const,
    rootId: "run",
    selectionDigest,
    subjects: runSubjects
  };
  const runTrashExecution = {
    kind: "trash-bundle" as const,
    sourceRootId: "run",
    trashRootId: "trash",
    selectionDigest,
    items: runSubjects.map((subject) => ({
      itemId: workflowRunPayloadParticipantId(
        subject.workflowRunId,
        subject.attemptId
      ),
      sourceRelativePath:
        `attempt-payloads/${subject.workflowRunId}/generations/000000000001`
    })).sort((left, right) => (
      `${left.itemId}\0${left.sourceRelativePath}`.localeCompare(
        `${right.itemId}\0${right.sourceRelativePath}`
      )
    ))
  };
  const conversationExecution = {
    kind: "trash-bundle" as const,
    sourceRootId: "conversation",
    trashRootId: "trash",
    selectionDigest,
    items: [{
      itemId: "conversation-source",
      sourceRelativePath: "sessions/conversation-bundle-capacity"
    }]
  };
  const participants: RecordMutationExecutionParticipant[] = [
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
        execution: runTrashExecution
      }),
      recordKind: "workflow-run",
      action: "discard",
      execution: runTrashExecution
    },
    {
      participantId: recordMutationExecutionBundleParticipantId({
        recordKind: "conversation",
        action: "stage",
        execution: conversationExecution
      }),
      recordKind: "conversation",
      action: "stage",
      execution: conversationExecution
    }
  ];
  return participants.sort((left, right) => (
    left.participantId.localeCompare(right.participantId)
  ));
}

function executionParticipants(): RecordMutationExecutionParticipant[] {
  const runPayloadParticipantId = workflowRunPayloadParticipantId(
    "workflow-run-1",
    "attempt-1"
  );
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
      participantId: runPayloadParticipantId,
      recordKind: "workflow-run",
      action: "mark-source-deleted",
      execution: {
        kind: "source-deletion",
        rootId: "run",
        subject: {
          kind: "workflow-run",
          workflowRunId: "workflow-run-1",
          attemptId: "attempt-1",
          harnessRunId: "harness-run-1",
          payloadDigest: `sha256:${"7".repeat(64)}`
        }
      }
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

interface ExecutionPlanFixture {
  rootPath: string;
  storageRootPath: string;
  bindings: Record<string, RecordRootBindingRef>;
}

async function withFixture(
  suffix: string,
  action: (fixture: ExecutionPlanFixture) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-execution-plan-${suffix}-`)
  );
  try {
    const storageRootPath = path.join(rootPath, "storage");
    await mkdir(storageRootPath);
    const bindings: Record<string, RecordRootBindingRef> = {};
    for (const rootId of [
      "artifact",
      "conversation",
      "memory",
      "run",
      "trash"
    ]) {
      const root = path.join(storageRootPath, rootId);
      await mkdir(root);
      const binding = await createOrLoadRecordRootBinding({
        storageRootPath,
        rootId,
        rootPath: root,
        boundaryRootPath: storageRootPath,
        authority: "plugin-owned",
        createdAt: 1_000
      });
      bindings[rootId] = recordRootBindingRef(binding.binding);
    }
    await action({ rootPath, storageRootPath, bindings });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function createJournal(
  fixture: ExecutionPlanFixture,
  suffix: string
): Promise<LoadedRecordMutationJournal> {
  return await createRecordMutationJournal({
    storageRootPath: fixture.storageRootPath,
    mutationId: `execution-plan-${suffix}`,
    intent: destructiveIntent(
      `conversation-${suffix}`,
      fixture.bindings
    ),
    createdAt: 1_050
  });
}

function destructiveIntent(
  conversationId: string,
  bindings: Record<string, RecordRootBindingRef>
): RecordMutationIntent {
  return {
    operation: "delete-conversation",
    conversationId,
    expectedConversationGeneration: 2,
    expectedConversationCommitId: "conversation-commit-2",
    expectedConversationContentRevision: `sha256:${"1".repeat(64)}`,
    targetConversation: {
      status: "deleted",
      tombstoneId: `tombstone-${conversationId}`,
      digest: `sha256:${"2".repeat(64)}`
    },
    participants: executionParticipants().map((participant) => ({
      id: participant.participantId,
      recordKind: participant.recordKind,
      action: participant.action
    })),
    rootBindings: Object.values(bindings).sort(
      (left, right) => left.rootId.localeCompare(right.rootId)
    ),
    trashPolicy: "required"
  };
}
