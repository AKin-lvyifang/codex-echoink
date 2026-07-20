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
  materializeRecordMutationExecution,
  registerRecordMutationRuntimeRoots,
  RecordMutationExecutionRuntimeError,
  type RecordMutationRuntimeRoot
} from "../../harness/lifecycle/record-mutation-execution-runtime";
import {
  createRecordMutationExecutionPlan,
  loadRecordMutationExecutionPlan,
  recordMutationExecutionBundleParticipantId,
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
  await assertBundleRuntimeFailsBeforePrepareUntilMaterializerIsWired();
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
        (participant) => participant.receipt.digest
      ),
      first.trashParticipants.map(
        (participant) => participant.receipt.digest
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

async function assertBundleRuntimeFailsBeforePrepareUntilMaterializerIsWired():
Promise<void> {
  await withFixture("bundle-blocked", async (fixture) => {
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
    await assert.rejects(
      materializeRecordMutationExecution({
        journal,
        plan,
        roots: fixture.roots.filter(
          (root) => root.rootId === "conversation" || root.rootId === "trash"
        ),
        now: fixture.now
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "bundle_runtime_required"
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
