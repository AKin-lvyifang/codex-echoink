import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createArtifactSourceDeletionAdapter,
  createWorkflowArtifactLifecycleRecord,
  inventoryWorkflowArtifactsByConversation,
  initializeWorkflowArtifactLifecycleStore,
  loadWorkflowArtifactLifecycleRecord
} from "../../harness/artifacts/artifact-lifecycle-store";
import {
  ConversationMutationLane
} from "../../harness/conversation/conversation-mutation-lane";
import {
  coordinateRecordMutationTrashRetirement
} from "../../harness/lifecycle/record-mutation-coordinator";
import type {
  RecordMutationConversationTarget,
  RecordMutationIntent,
  RecordMutationParticipant
} from "../../harness/lifecycle/record-mutation-contract";
import {
  createRecordMutationJournal,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  runRecordMutationRecovery
} from "../../harness/lifecycle/record-mutation-recovery-runner";
import {
  coordinateRecordMutationSourceParticipantForward,
  type RecordMutationSourceParticipantAdapter
} from "../../harness/lifecycle/record-mutation-source-participant";
import {
  stageRecordMutationTrash,
  type RecordMutationTrashReceipt
} from "../../harness/lifecycle/record-mutation-trash";
import {
  commitFormalMemoryIndexSnapshot,
  type MemoryRecordV2
} from "../../harness/memory/v2-engine";
import {
  createMemorySourceDeletionAdapter
} from "../../harness/memory/source-deletion";
import {
  echoInkMemoryV2Layout,
  initializeEchoInkMemoryV2,
  readMemoryIndexV2,
  withMemoryFormalMutation
} from "../../harness/memory/v2-store";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef,
  type RecordRootBindingRef
} from "../../harness/storage/record-root-registry";

export async function runHarnessV2RecordMutationSourceParticipantTests():
Promise<void> {
  await assertExactTargetRollsForwardMemoryAndArtifact();
  await assertBeforeTargetCompensatesTrashMemoryAndArtifact();
  await assertMemoryStoreCrashReplaysBeforeJournalStep();
  await assertMissingAdapterBlocksBeforeEffects();
  await assertRecreatedParticipantRootBlocksWithoutEffects();
  await assertMissingFormalMemoryStoreBlocksWithoutReinitialization();
  await assertMissingMemoryLineageBlocks();
  await assertMemoryAndArtifactSubjectIdentityDriftBlocks();
  await assertArtifactRegistrationRestoreAndCorruptionGuards();
  await assertArtifactConversationInventoryIsStrictAndReadOnly();
}

async function assertArtifactConversationInventoryIsStrictAndReadOnly():
Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-artifact-inventory-")
  );
  const missingRootPath = path.join(rootPath, "missing");
  const storeRootPath = path.join(rootPath, "store");
  try {
    const empty = await inventoryWorkflowArtifactsByConversation(
      missingRootPath,
      "conversation-left"
    );
    assert.deepEqual(empty.artifacts, []);
    assert.equal(
      await exists(missingRootPath),
      false,
      "read-only Artifact inventory must not initialize a missing Store"
    );

    const left = await createWorkflowArtifactLifecycleRecord({
      storageRootPath: rootPath,
      rootPath: storeRootPath,
      artifactId: "artifact-inventory-left",
      artifactKind: "markdown-report",
      sourceConversationIds: ["conversation-left"],
      createdAt: 10_000
    });
    await createWorkflowArtifactLifecycleRecord({
      storageRootPath: rootPath,
      rootPath: storeRootPath,
      artifactId: "artifact-inventory-right",
      artifactKind: "ui-card",
      sourceConversationIds: ["conversation-right"],
      createdAt: 10_001
    });
    const first = await inventoryWorkflowArtifactsByConversation(
      storeRootPath,
      "conversation-left"
    );
    const second = await inventoryWorkflowArtifactsByConversation(
      storeRootPath,
      "conversation-left"
    );
    assert.deepEqual(second, first);
    assert.match(first.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.artifacts, [left.record]);

    await writeFile(
      path.join(
        storeRootPath,
        "workflow-artifact-lifecycle",
        "unknown-entry"
      ),
      "{}\n",
      "utf8"
    );
    await assert.rejects(
      inventoryWorkflowArtifactsByConversation(
        storeRootPath,
        "conversation-left"
      ),
      /未知项/
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertExactTargetRollsForwardMemoryAndArtifact(): Promise<void> {
  await withFixture(
    "source-participant-forward",
    {},
    async (fixture) => {
      const result = await recover(
        fixture,
        fixture.preparedJournal,
        targetObservation(
          fixture.preparedJournal.record.intent.targetConversation
        ),
        fixture.sourceAdapters
      );
      assert.equal(
        result.status,
        "completed",
        result.status === "blocked"
          ? `unexpected blocker: ${result.blocker}`
          : undefined
      );
      assert.equal(result.journal.record.state, "committed");
      assert.deepEqual(forwardActions(result.journal), [
        "trash-staged",
        "participant-staged",
        "participant-staged",
        "source-retired"
      ]);
      assert.equal(await exists(fixture.conversationFilePath), false);
      assert.deepEqual(
        (await memoryRecord(fixture)).sourceDeletions?.map(
          (marker) => ({
            mutationId: marker.mutationId,
            conversationId: marker.conversationId,
            restored: marker.restoredAt !== undefined
          })
        ),
        [{
          mutationId: fixture.mutationId,
          conversationId: fixture.conversationId,
          restored: false
        }]
      );
      assert.deepEqual(
        (await artifactRecord(fixture)).sourceDeletions.map(
          (marker) => ({
            mutationId: marker.mutationId,
            conversationId: marker.conversationId,
            restored: marker.restoredAt !== undefined
          })
        ),
        [{
          mutationId: fixture.mutationId,
          conversationId: fixture.conversationId,
          restored: false
        }]
      );

      const noop = await recover(
        fixture,
        result.journal,
        targetObservation(result.journal.record.intent.targetConversation),
        fixture.sourceAdapters
      );
      assert.equal(noop.status, "noop");
      assert.equal(noop.journal.record.digest, result.journal.record.digest);
    }
  );
}

async function assertBeforeTargetCompensatesTrashMemoryAndArtifact():
Promise<void> {
  await withFixture(
    "source-participant-compensate",
    {},
    async (fixture) => {
      let current = fixture.preparedJournal;
      for (const adapter of fixture.sourceAdapters) {
        current = await coordinateRecordMutationSourceParticipantForward({
          journal: current,
          adapter,
          now: fixture.now
        });
      }
      current = (
        await coordinateRecordMutationTrashRetirement({
          journal: current,
          participantId: fixture.conversationParticipantId,
          sourceRelativePath: fixture.conversationRelativePath,
          ...coordinatorRoots(fixture),
          now: fixture.now
        })
      ).journal;
      assert.equal(await exists(fixture.conversationFilePath), false);

      const result = await recover(
        fixture,
        current,
        beforeObservation(current.record.intent),
        fixture.sourceAdapters
      );
      assert.equal(result.status, "completed");
      assert.equal(result.journal.record.state, "aborted");
      assert.deepEqual(compensatingActions(result.journal), [
        "compensation-prepared",
        "trash-restored",
        "compensation-prepared",
        "participant-restored",
        "compensation-prepared",
        "participant-restored"
      ]);
      assert.equal(
        await readFile(fixture.conversationFilePath, "utf8"),
        "conversation-before\n"
      );
      assert.equal(
        (await memoryRecord(fixture)).sourceDeletions?.[0]?.restoredAt
          !== undefined,
        true
      );
      assert.equal(
        (await artifactRecord(fixture)).sourceDeletions[0]?.restoredAt
          !== undefined,
        true
      );

      const noop = await recover(
        fixture,
        result.journal,
        beforeObservation(result.journal.record.intent),
        fixture.sourceAdapters
      );
      assert.equal(noop.status, "noop");
      assert.equal(noop.journal.record.digest, result.journal.record.digest);
    }
  );
}

async function assertMemoryStoreCrashReplaysBeforeJournalStep(): Promise<void> {
  await withFixture(
    "memory-source-crash-replay",
    {
      includeArtifact: false,
      memoryFailAfterIndexWrite: true
    },
    async (fixture) => {
      const first = await recover(
        fixture,
        fixture.preparedJournal,
        targetObservation(
          fixture.preparedJournal.record.intent.targetConversation
        ),
        fixture.sourceAdapters
      );
      assert.equal(first.status, "blocked");
      assert.equal(first.blocker, "effect-verification-failed");
      assert.deepEqual(forwardActions(first.journal), ["trash-staged"]);
      assert.equal(
        (await memoryRecord(fixture)).sourceDeletions?.length,
        1,
        "the formal Store effect must remain recoverable after index publish"
      );
      assert.equal(await exists(fixture.conversationFilePath), true);

      const replay = await recover(
        fixture,
        first.journal,
        targetObservation(first.journal.record.intent.targetConversation),
        fixture.sourceAdapters
      );
      assert.equal(replay.status, "completed");
      assert.equal(replay.journal.record.state, "committed");
      assert.deepEqual(forwardActions(replay.journal), [
        "trash-staged",
        "participant-staged",
        "source-retired"
      ]);
      assert.equal(
        (await memoryRecord(fixture)).sourceDeletions?.length,
        1,
        "replay must not duplicate the durable source deletion marker"
      );
    }
  );
}

async function assertMissingAdapterBlocksBeforeEffects(): Promise<void> {
  await withFixture(
    "source-participant-adapter-required",
    {},
    async (fixture) => {
      const result = await recover(
        fixture,
        fixture.preparedJournal,
        targetObservation(
          fixture.preparedJournal.record.intent.targetConversation
        ),
        []
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.blocker, "participant-adapter-required");
      assert.deepEqual(forwardActions(result.journal), ["trash-staged"]);
      assert.equal(await exists(fixture.conversationFilePath), true);
      assert.equal(
        (await memoryRecord(fixture)).sourceDeletions?.length ?? 0,
        0
      );
      assert.equal(
        (await artifactRecord(fixture)).sourceDeletions.length,
        0
      );
    }
  );
}

async function assertRecreatedParticipantRootBlocksWithoutEffects():
Promise<void> {
  await withFixture(
    "source-participant-recreated-root",
    { includeArtifact: false },
    async (fixture) => {
      const memoryRootPath = echoInkMemoryV2Layout(fixture.vaultPath).root;
      const originalMemoryRootPath = `${memoryRootPath}-original`;
      await rename(memoryRootPath, originalMemoryRootPath);
      await mkdir(memoryRootPath, { mode: 0o700 });

      const result = await recover(
        fixture,
        fixture.preparedJournal,
        targetObservation(
          fixture.preparedJournal.record.intent.targetConversation
        ),
        fixture.sourceAdapters
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.blocker, "effect-verification-failed");
      assert.deepEqual(await readdir(memoryRootPath), []);
      assert.equal(await exists(fixture.conversationFilePath), true);
      const originalIndex = JSON.parse(
        await readFile(path.join(originalMemoryRootPath, "index.json"), "utf8")
      ) as { memories: Array<{ sourceDeletions?: unknown[] }> };
      assert.equal(
        originalIndex.memories[0]?.sourceDeletions?.length ?? 0,
        0
      );
    }
  );
}

async function assertMissingMemoryLineageBlocks(): Promise<void> {
  await withFixture(
    "source-participant-missing-lineage",
    {
      includeArtifact: false,
      includeMemoryLineage: false
    },
    async (fixture) => {
      const result = await recover(
        fixture,
        fixture.preparedJournal,
        targetObservation(
          fixture.preparedJournal.record.intent.targetConversation
        ),
        fixture.sourceAdapters
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.blocker, "effect-verification-failed");
      assert.deepEqual(forwardActions(result.journal), ["trash-staged"]);
      assert.equal(await exists(fixture.conversationFilePath), true);
      assert.equal(
        (await memoryRecord(fixture)).sourceDeletions?.length ?? 0,
        0
      );
    }
  );
}

async function assertMissingFormalMemoryStoreBlocksWithoutReinitialization():
Promise<void> {
  await withFixture(
    "source-participant-missing-formal-store",
    { includeArtifact: false },
    async (fixture) => {
      const layout = echoInkMemoryV2Layout(fixture.vaultPath);
      const retainedIndexPath = `${layout.index}.retained`;
      await rename(layout.index, retainedIndexPath);
      const result = await recover(
        fixture,
        fixture.preparedJournal,
        targetObservation(
          fixture.preparedJournal.record.intent.targetConversation
        ),
        fixture.sourceAdapters
      );
      assert.equal(result.status, "blocked");
      assert.equal(result.blocker, "effect-verification-failed");
      assert.equal(
        await exists(layout.index),
        false,
        "participant recovery must not initialize a missing formal Store"
      );
      const retained = JSON.parse(
        await readFile(retainedIndexPath, "utf8")
      ) as { memories: Array<{ sourceDeletions?: unknown[] }> };
      assert.equal(
        retained.memories[0]?.sourceDeletions?.length ?? 0,
        0
      );
      assert.equal(await exists(fixture.conversationFilePath), true);
    }
  );
}

async function assertArtifactRegistrationRestoreAndCorruptionGuards():
Promise<void> {
  await withFixture(
    "artifact-source-store-guards",
    { includeMemory: false },
    async (fixture) => {
      await assert.rejects(
        createWorkflowArtifactLifecycleRecord({
          storageRootPath: fixture.storageRootPath,
          rootPath: fixture.artifactRootPath,
          artifactId: fixture.artifactId,
          artifactKind: "ui-card",
          sourceConversationIds: [fixture.conversationId],
          createdAt: fixture.now()
        }),
        /registration conflicts/
      );
      const adapter = fixture.sourceAdapters[0];
      const identity = {
        mutationId: fixture.mutationId,
        conversationId: fixture.conversationId,
        participantId: fixture.artifactId
      };
      await assert.rejects(
        adapter.inspect(identity),
        /requires mutation authority/
      );
      const forward = await adapter.withMutation(async () => {
        await adapter.recover();
        return await adapter.stage({
          ...identity,
          occurredAt: fixture.now()
        });
      });
      const restored = await adapter.withMutation(async () => {
        await adapter.recover();
        return await adapter.restore({
          ...identity,
          forwardReceipt: forward,
          occurredAt: fixture.now()
        });
      });
      const restoredAgain = await adapter.withMutation(async () => {
        await adapter.recover();
        return await adapter.restore({
          ...identity,
          forwardReceipt: forward,
          occurredAt: fixture.now()
        });
      });
      assert.equal(restoredAgain.digest, restored.digest);
      assert.equal((await artifactRecord(fixture)).revision, 2);

      const namespacePath = path.join(
        fixture.artifactRootPath,
        "workflow-artifact-lifecycle"
      );
      const chainEntries = await readdir(namespacePath, {
        withFileTypes: true
      });
      const chain = chainEntries.find(
        (entry) => entry.isDirectory() && entry.name.startsWith("artifact-")
      );
      assert.ok(chain);
      await writeFile(
        path.join(namespacePath, chain.name, "revision-000000000001.json"),
        "{}\n",
        "utf8"
      );
      await assert.rejects(
        loadWorkflowArtifactLifecycleRecord(
          fixture.artifactRootPath,
          fixture.artifactId
        ),
        /字段集合非法/
      );
    }
  );
}

async function assertMemoryAndArtifactSubjectIdentityDriftBlocks():
Promise<void> {
  await withFixture(
    "source-participant-subject-drift",
    {},
    async (fixture) => {
      assert.ok(fixture.memoryRootBinding);
      const wrongMemoryState = createMemorySourceDeletionAdapter({
        vaultPath: fixture.vaultPath,
        storageRootPath: fixture.storageRootPath,
        boundaryRootPath: fixture.storageRootPath,
        rootBinding: fixture.memoryRootBinding,
        participantId: fixture.memoryId,
        subjectState: "confirmation"
      });
      await assert.rejects(
        coordinateRecordMutationSourceParticipantForward({
          journal: fixture.preparedJournal,
          adapter: wrongMemoryState,
          now: fixture.now
        }),
        /expected confirmation state/
      );

      assert.ok(fixture.artifactRootBinding);
      const wrongArtifactKind = createArtifactSourceDeletionAdapter({
        storageRootPath: fixture.storageRootPath,
        rootPath: fixture.artifactRootPath,
        boundaryRootPath: fixture.storageRootPath,
        rootBinding: fixture.artifactRootBinding,
        participantId: fixture.artifactId,
        artifactKind: "ui-card"
      });
      await assert.rejects(
        coordinateRecordMutationSourceParticipantForward({
          journal: fixture.preparedJournal,
          adapter: wrongArtifactKind,
          now: fixture.now
        }),
        /kind conflicts/
      );
      assert.deepEqual(forwardActions(fixture.preparedJournal), [
        "trash-staged"
      ]);
    }
  );
}

interface FixtureOptions {
  includeMemory?: boolean;
  includeArtifact?: boolean;
  includeMemoryLineage?: boolean;
  memoryFailAfterIndexWrite?: boolean;
}

interface SourceParticipantFixture {
  rootPath: string;
  storageRootPath: string;
  vaultPath: string;
  conversationRootPath: string;
  trashRootPath: string;
  artifactRootPath: string;
  conversationRelativePath: string;
  conversationFilePath: string;
  conversationParticipantId: string;
  conversationId: string;
  mutationId: string;
  memoryId: string;
  artifactId: string;
  conversationRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  memoryRootBinding?: RecordRootBindingRef;
  artifactRootBinding?: RecordRootBindingRef;
  preparedJournal: LoadedRecordMutationJournal;
  trashReceipt: RecordMutationTrashReceipt;
  sourceAdapters: RecordMutationSourceParticipantAdapter[];
  withConversationMutation: <T>(
    conversationId: string,
    action: () => Promise<T>
  ) => Promise<T>;
  now: () => number;
}

async function withFixture(
  label: string,
  options: FixtureOptions,
  action: (fixture: SourceParticipantFixture) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-source-participant-${label}-`)
  );
  const storageRootPath = path.join(rootPath, "store");
  const vaultPath = path.join(storageRootPath, "vault");
  const conversationRootPath = path.join(
    storageRootPath,
    "conversation-store"
  );
  const trashRootPath = path.join(storageRootPath, "record-trash");
  const artifactRootPath = path.join(storageRootPath, "artifact-store");
  const conversationRelativePath = "conversation.json";
  const conversationFilePath = path.join(
    conversationRootPath,
    conversationRelativePath
  );
  const conversationParticipantId = "conversation";
  const conversationId = `conversation-${label}`;
  const mutationId = `mutation-${label}`;
  const memoryId = `memory-${label}`;
  const artifactId = `artifact-${label}`;
  const includeMemory = options.includeMemory !== false;
  const includeArtifact = options.includeArtifact !== false;
  await mkdir(vaultPath, { recursive: true, mode: 0o700 });
  await mkdir(conversationRootPath, { recursive: true, mode: 0o700 });
  await mkdir(trashRootPath, { recursive: true, mode: 0o700 });
  await mkdir(artifactRootPath, { recursive: true, mode: 0o700 });
  await writeFile(conversationFilePath, "conversation-before\n", "utf8");
  let timestamp = 1_721_260_800_000;
  const now = (): number => {
    timestamp += 1;
    return timestamp;
  };

  try {
    if (includeMemory) {
      await seedMemory(
        vaultPath,
        memoryId,
        conversationId,
        options.includeMemoryLineage !== false,
        now
      );
    }
    if (includeArtifact) {
      await initializeWorkflowArtifactLifecycleStore(artifactRootPath);
      await createWorkflowArtifactLifecycleRecord({
        storageRootPath,
        rootPath: artifactRootPath,
        artifactId,
        artifactKind: "markdown-report",
        sourceConversationIds: [conversationId],
        createdAt: now()
      });
    }

    const conversationRootBinding = await bindRoot(
      storageRootPath,
      "conversation-store",
      conversationRootPath,
      now()
    );
    const trashRootBinding = await bindRoot(
      storageRootPath,
      "record-trash",
      trashRootPath,
      now()
    );
    const memoryRootBinding = includeMemory
      ? await bindRoot(
        storageRootPath,
        "memory-store",
        echoInkMemoryV2Layout(vaultPath).root,
        now()
      )
      : undefined;
    const artifactRootBinding = includeArtifact
      ? await bindRoot(
        storageRootPath,
        "artifact-store",
        artifactRootPath,
        now()
      )
      : undefined;
    const rootBindings = [
      conversationRootBinding,
      trashRootBinding,
      ...(memoryRootBinding ? [memoryRootBinding] : []),
      ...(artifactRootBinding ? [artifactRootBinding] : [])
    ].sort((left, right) => compareText(left.rootId, right.rootId));
    const participants: RecordMutationParticipant[] = [
      {
        id: conversationParticipantId,
        recordKind: "conversation",
        action: "stage"
      },
      ...(includeMemory
        ? [{
            id: memoryId,
            recordKind: "memory" as const,
            action: "mark-source-deleted" as const
          }]
        : []),
      ...(includeArtifact
        ? [{
            id: artifactId,
            recordKind: "artifact" as const,
            action: "mark-source-deleted" as const
          }]
        : [])
    ].sort((left, right) => compareText(left.id, right.id));
    const planned = await createRecordMutationJournal({
      storageRootPath,
      mutationId,
      intent: {
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
        participants,
        rootBindings,
        trashPolicy: "required"
      },
      createdAt: now()
    });
    const trashReceipt = await stageRecordMutationTrash({
      mutationId,
      sourceRootPath: conversationRootPath,
      sourceRootBinding: conversationRootBinding,
      sourceRelativePath: conversationRelativePath,
      trashRootPath,
      trashRootBinding,
      transfer: "move",
      stagedAt: now()
    });
    const preparedJournal = await stageRecordMutationJournal(planned.handle, {
      expectedRevision: planned.record.revision,
      expectedDigest: planned.record.digest,
      step: {
        direction: "forward",
        ordinal: 1,
        participantId: conversationParticipantId,
        action: "trash-staged",
        evidenceDigest: trashReceipt.digest
      },
      updatedAt: now()
    });
    const sourceAdapters = [
      ...(includeMemory && memoryRootBinding
        ? [createMemorySourceDeletionAdapter({
            vaultPath,
            storageRootPath,
            boundaryRootPath: storageRootPath,
            rootBinding: memoryRootBinding,
            participantId: memoryId,
            failAfterIndexWrite: () => (
              options.memoryFailAfterIndexWrite === true
            )
          })]
        : []),
      ...(includeArtifact && artifactRootBinding
        ? [createArtifactSourceDeletionAdapter({
            storageRootPath,
            rootPath: artifactRootPath,
            boundaryRootPath: storageRootPath,
            rootBinding: artifactRootBinding,
            participantId: artifactId
          })]
        : [])
    ].sort((left, right) => compareText(
      left.participantId,
      right.participantId
    ));
    const conversationLane = new ConversationMutationLane();
    await action({
      rootPath,
      storageRootPath,
      vaultPath,
      conversationRootPath,
      trashRootPath,
      artifactRootPath,
      conversationRelativePath,
      conversationFilePath,
      conversationParticipantId,
      conversationId,
      mutationId,
      memoryId,
      artifactId,
      conversationRootBinding,
      trashRootBinding,
      ...(memoryRootBinding ? { memoryRootBinding } : {}),
      ...(artifactRootBinding ? { artifactRootBinding } : {}),
      preparedJournal,
      trashReceipt,
      sourceAdapters,
      withConversationMutation: async <T>(
        targetConversationId: string,
        mutation: () => Promise<T>
      ): Promise<T> => await conversationLane.withConversationMutation(
        targetConversationId,
        mutation
      ),
      now
    });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function seedMemory(
  vaultPath: string,
  memoryId: string,
  conversationId: string,
  includeLineage: boolean,
  now: () => number
): Promise<void> {
  await initializeEchoInkMemoryV2(vaultPath);
  await withMemoryFormalMutation(vaultPath, async () => {
    const index = await readMemoryIndexV2<MemoryRecordV2>(vaultPath);
    const createdAt = now();
    index.memories.push({
      id: memoryId,
      kind: "decision",
      scope: "vault",
      statement: `Memory for ${conversationId}`,
      evidenceRefs: [`run:${conversationId}`],
      sourceRunId: `run-${conversationId}`,
      ...(includeLineage
        ? { sourceConversationIds: [conversationId] }
        : {}),
      confidence: 0.9,
      createdAt,
      updatedAt: createdAt
    });
    await commitFormalMemoryIndexSnapshot(
      vaultPath,
      index,
      now(),
      {
        operation: "test-seed-memory",
        lockHeld: true
      }
    );
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

async function recover(
  fixture: SourceParticipantFixture,
  journal: LoadedRecordMutationJournal,
  observation:
    | ReturnType<typeof beforeObservation>
    | ReturnType<typeof targetObservation>,
  sourceDeletedParticipants: readonly RecordMutationSourceParticipantAdapter[]
): ReturnType<typeof runRecordMutationRecovery> {
  return await runRecordMutationRecovery({
    journal,
    withConversationMutation: fixture.withConversationMutation,
    inspectConversation: async () => observation,
    trashParticipants: [{
      participantId: fixture.conversationParticipantId,
      receipt: fixture.trashReceipt,
      ...coordinatorRoots(fixture)
    }],
    sourceDeletedParticipants,
    now: fixture.now
  });
}

function coordinatorRoots(fixture: SourceParticipantFixture): {
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
    sourceRootPath: fixture.conversationRootPath,
    sourceBoundaryRootPath: fixture.storageRootPath,
    sourceRootBinding: fixture.conversationRootBinding,
    trashRootPath: fixture.trashRootPath,
    trashBoundaryRootPath: fixture.storageRootPath,
    trashRootBinding: fixture.trashRootBinding
  };
}

function beforeObservation(intent: RecordMutationIntent): {
  status: "present";
  generation: number;
  commitId: string | null;
  contentRevision: string;
} {
  return {
    status: "present",
    generation: intent.expectedConversationGeneration,
    commitId: intent.expectedConversationCommitId,
    contentRevision: intent.expectedConversationContentRevision
  };
}

function targetObservation(target: RecordMutationConversationTarget):
  RecordMutationConversationTarget {
  return { ...target };
}

function forwardActions(journal: LoadedRecordMutationJournal): string[] {
  return journal.chain.flatMap((revision) => (
    revision.step?.direction === "forward"
      ? [revision.step.action]
      : []
  ));
}

function compensatingActions(journal: LoadedRecordMutationJournal): string[] {
  return journal.chain.flatMap((revision) => (
    revision.step?.direction === "compensating"
      ? [revision.step.action]
      : []
  ));
}

async function memoryRecord(
  fixture: SourceParticipantFixture
): Promise<MemoryRecordV2> {
  const index = await readMemoryIndexV2<MemoryRecordV2>(fixture.vaultPath);
  const record = index.memories.find((item) => item.id === fixture.memoryId);
  assert.ok(record);
  return record;
}

async function artifactRecord(
  fixture: SourceParticipantFixture
): Promise<
  NonNullable<
    Awaited<ReturnType<typeof loadWorkflowArtifactLifecycleRecord>>
  >["record"]
> {
  const loaded = await loadWorkflowArtifactLifecycleRecord(
    fixture.artifactRootPath,
    fixture.artifactId
  );
  assert.ok(loaded);
  return loaded.record;
}

async function exists(absolutePath: string): Promise<boolean> {
  return await stat(absolutePath).then(() => true, () => false);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
