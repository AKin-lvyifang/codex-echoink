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
