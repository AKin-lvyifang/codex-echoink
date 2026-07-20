import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ConversationMutationLane,
  type ConversationMutationAuthority
} from "../../harness/conversation/conversation-mutation-lane";
import {
  coordinateRecordMutationTrashBundlePrepare,
  coordinateRecordMutationTrashBundleRetirement,
  coordinateRecordMutationTrashRetirement,
  type CoordinatedRecordMutationTrashBundlePrepare
} from "../../harness/lifecycle/record-mutation-coordinator";
import type {
  RecordMutationConversationTarget,
  RecordMutationIntent,
  RecordMutationOperation
} from "../../harness/lifecycle/record-mutation-contract";
import {
  createRecordMutationJournal,
  loadRecordMutationJournal,
  stageRecordMutationJournal,
  type LoadedRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  recordMutationExecutionBundleParticipantId
} from "../../harness/lifecycle/record-mutation-execution-plan";
import {
  runRecordMutationRecovery,
  type RecordMutationRecoveryTrashBundleParticipant
} from "../../harness/lifecycle/record-mutation-recovery-runner";
import {
  stageRecordMutationTrash,
  type RecordMutationTrashReceipt
} from "../../harness/lifecycle/record-mutation-trash";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef,
  type RecordRootBindingRef
} from "../../harness/storage/record-root-registry";

const RECOVERY_BUNDLE_SELECTION_DIGEST = `sha256:${"8".repeat(64)}`;
const RECOVERY_BUNDLE_ITEMS = [
  {
    itemId: "item-first",
    sourceRelativePath: "sessions/first.json"
  },
  {
    itemId: "item-second",
    sourceRelativePath: "sessions/second.json"
  }
] as const;

export async function runHarnessV2RecordMutationRecoveryRunnerTests(): Promise<void> {
  await assertNonDestructiveRecoveryRollsForwardExactTarget();
  await assertNonDestructiveRecoveryCompensatesBeforeTarget();
  await assertConversationAuthoritySerializesRecovery();
  await assertConversationDriftBeforeTerminalBlocksRecovery();
  await assertContradictoryConversationBlocksWithoutMutation();
  await assertDestructiveRecoveryRollsForwardThroughCoordinator();
  await assertDestructiveRecoveryRestoresThroughCoordinator();
  await assertBundleRecoveryRollsForwardThroughCoordinator();
  await assertPreparedBundleCompensatesWithoutRetirement();
  await assertBundleRecoveryRepairsPartialRetirementAndRestores();
  await assertRecreatedRootBlocksProductionRecovery();
}

async function assertNonDestructiveRecoveryRollsForwardExactTarget(): Promise<void> {
  await withFixture("non-destructive-forward", async (fixture) => {
    const planned = await plannedMutation(
      fixture,
      "non-destructive-forward",
      "start-new-context",
      false
    );
    const staged = await preparedJournal(planned, fixture.now);
    const result = await runRecordMutationRecovery({
      journal: staged,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => observationFor(
        staged.record.intent.targetConversation
      ),
      trashParticipants: [],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.decision, {
      action: "roll-forward",
      reason: "exact-local-commit"
    });
    assert.equal(result.journal.record.state, "committed");
  });
}

async function assertNonDestructiveRecoveryCompensatesBeforeTarget(): Promise<void> {
  await withFixture("non-destructive-compensate", async (fixture) => {
    const planned = await plannedMutation(
      fixture,
      "non-destructive-compensate",
      "reset-agent-cache",
      false
    );
    const staged = await preparedJournal(planned, fixture.now);
    const result = await runRecordMutationRecovery({
      journal: staged,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => beforeObservation(staged.record.intent),
      trashParticipants: [],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.decision, {
      action: "compensate",
      reason: "local-commit-absent"
    });
    assert.equal(result.journal.record.state, "aborted");
    assert.deepEqual(compensatingActions(result.journal), [
      "compensation-prepared"
    ]);
  });
}

async function assertConversationAuthoritySerializesRecovery(): Promise<void> {
  await withFixture("conversation-authority", async (fixture) => {
    const planned = await plannedMutation(
      fixture,
      "conversation-authority",
      "start-new-context",
      false
    );
    const staged = await preparedJournal(planned, fixture.now);
    let signalInspectorEntered: () => void = () => undefined;
    let releaseInspector: () => void = () => undefined;
    const inspectorEntered = new Promise<void>((resolve) => {
      signalInspectorEntered = resolve;
    });
    const inspectorRelease = new Promise<void>((resolve) => {
      releaseInspector = resolve;
    });
    const recovery = runRecordMutationRecovery({
      journal: staged,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => {
        signalInspectorEntered();
        await inspectorRelease;
        return observationFor(staged.record.intent.targetConversation);
      },
      trashParticipants: [],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    await inspectorEntered;

    let laterMutationRan = false;
    const laterMutation = fixture.withConversationMutation(
      staged.record.intent.conversationId,
      async () => {
        laterMutationRan = true;
      }
    );
    await Promise.resolve();
    assert.equal(
      laterMutationRan,
      false,
      "recovery must retain the Conversation authority through terminal publication"
    );

    releaseInspector();
    const result = await recovery;
    await laterMutation;
    assert.equal(result.status, "completed");
    assert.equal(laterMutationRan, true);
  });
}

async function assertConversationDriftBeforeTerminalBlocksRecovery(): Promise<void> {
  await withFixture("conversation-drift", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(
      fixture,
      "conversation-drift",
      "delete-conversation",
      true
    );
    const prepared = await prepareTrashAndJournal(
      fixture,
      planned,
      "conversation.json"
    );
    let inspections = 0;
    const blockedResult = await runRecordMutationRecovery({
      journal: prepared.journal,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => {
        inspections += 1;
        return inspections < 3
          ? observationFor(prepared.journal.record.intent.targetConversation)
          : beforeObservation(prepared.journal.record.intent);
      },
      trashParticipants: [trashParticipant(fixture, prepared.receipt)],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(blockedResult.status, "blocked");
    assert.equal(
      blockedResult.blocker,
      "conversation-evidence-changed"
    );
    assert.equal(blockedResult.journal.record.state, "staged");
    assert.deepEqual(forwardActions(blockedResult.journal), [
      "trash-staged",
      "source-retired"
    ]);
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "conversation.json")),
      false,
      "a stale Conversation observation must not publish a committed terminal"
    );

    const recovered = await runRecordMutationRecovery({
      journal: blockedResult.journal,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => beforeObservation(
        blockedResult.journal.record.intent
      ),
      trashParticipants: [trashParticipant(fixture, prepared.receipt)],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.journal.record.state, "aborted");
    assert.equal(
      await readFile(path.join(fixture.sourceRootPath, "conversation.json"), "utf8"),
      "before\n"
    );
  });
}

async function assertContradictoryConversationBlocksWithoutMutation(): Promise<void> {
  await withFixture("contradictory", async (fixture) => {
    const planned = await plannedMutation(
      fixture,
      "contradictory",
      "start-new-context",
      false
    );
    const staged = await preparedJournal(planned, fixture.now);
    const result = await runRecordMutationRecovery({
      journal: staged,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => ({
        ...beforeObservation(staged.record.intent),
        contentRevision: `sha256:${"9".repeat(64)}`
      }),
      trashParticipants: [],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.blocker, "contradictory-local-commit");
    assert.equal(result.journal.record.digest, staged.record.digest);
  });
}

async function assertDestructiveRecoveryRollsForwardThroughCoordinator(): Promise<void> {
  await withFixture("destructive-forward", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(
      fixture,
      "destructive-forward",
      "delete-conversation",
      true
    );
    const prepared = await prepareTrashAndJournal(
      fixture,
      planned,
      "conversation.json"
    );
    const result = await runRecordMutationRecovery({
      journal: prepared.journal,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => observationFor(
        prepared.journal.record.intent.targetConversation
      ),
      trashParticipants: [trashParticipant(fixture, prepared.receipt)],
      sourceDeletedParticipants: [],
      now: fixture.now
    });

    assert.equal(result.status, "completed");
    assert.equal(result.journal.record.state, "committed");
    assert.deepEqual(forwardActions(result.journal), [
      "trash-staged",
      "source-retired"
    ]);
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "conversation.json")),
      false
    );
  });
}

async function assertDestructiveRecoveryRestoresThroughCoordinator(): Promise<void> {
  await withFixture("destructive-restore", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(
      fixture,
      "destructive-restore",
      "delete-conversation",
      true
    );
    const retired = await coordinateRecordMutationTrashRetirement({
      journal: planned,
      participantId: "conversation",
      sourceRelativePath: "conversation.json",
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    const result = await runRecordMutationRecovery({
      journal: retired.journal,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => beforeObservation(
        retired.journal.record.intent
      ),
      trashParticipants: [
        trashParticipant(fixture, retired.preparedReceipt)
      ],
      sourceDeletedParticipants: [],
      now: fixture.now
    });

    assert.equal(result.status, "completed");
    assert.equal(result.journal.record.state, "aborted");
    assert.deepEqual(compensatingActions(result.journal), [
      "compensation-prepared",
      "trash-restored"
    ]);
    assert.equal(
      await readFile(path.join(fixture.sourceRootPath, "conversation.json"), "utf8"),
      "before\n"
    );
  });
}

async function assertBundleRecoveryRollsForwardThroughCoordinator(): Promise<void> {
  await withFixture("bundle-forward", async (fixture) => {
    await writeRecoveryBundleSources(fixture);
    const planned = await plannedBundleMutation(fixture, "bundle-forward");
    const prepared = await coordinateRecordMutationTrashBundlePrepare({
      journal: planned,
      participantId: recoveryBundleParticipantId(fixture),
      selectionDigest: RECOVERY_BUNDLE_SELECTION_DIGEST,
      items: RECOVERY_BUNDLE_ITEMS,
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    const participant = recoveryBundleParticipant(fixture, prepared);
    const result = await runRecordMutationRecovery({
      journal: prepared.journal,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => observationFor(
        prepared.journal.record.intent.targetConversation
      ),
      trashParticipants: [participant],
      sourceDeletedParticipants: [],
      now: fixture.now
    });

    assert.equal(result.status, "completed");
    assert.equal(result.journal.record.state, "committed");
    assert.deepEqual(forwardActions(result.journal), [
      "trash-staged",
      "source-retired"
    ]);
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/first.json")),
      false
    );
    assert.equal(
      await exists(path.join(fixture.sourceRootPath, "sessions/second.json")),
      false
    );
  });
}

async function assertPreparedBundleCompensatesWithoutRetirement(): Promise<void> {
  await withFixture("bundle-prepared-compensation", async (fixture) => {
    await writeRecoveryBundleSources(fixture);
    const planned = await plannedBundleMutation(
      fixture,
      "bundle-prepared-compensation"
    );
    const prepared = await coordinateRecordMutationTrashBundlePrepare({
      journal: planned,
      participantId: recoveryBundleParticipantId(fixture),
      selectionDigest: RECOVERY_BUNDLE_SELECTION_DIGEST,
      items: RECOVERY_BUNDLE_ITEMS,
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    const result = await runRecordMutationRecovery({
      journal: prepared.journal,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => beforeObservation(
        prepared.journal.record.intent
      ),
      trashParticipants: [recoveryBundleParticipant(fixture, prepared)],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(result.status, "completed");
    assert.equal(result.journal.record.state, "aborted");
    assert.deepEqual(forwardActions(result.journal), ["trash-staged"]);
    assert.deepEqual(compensatingActions(result.journal), [
      "compensation-prepared"
    ]);
    assert.equal(
      result.journal.chain.find(
        (revision) =>
          revision.step?.direction === "compensating"
          && revision.step.action === "compensation-prepared"
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
  });
}

async function assertBundleRecoveryRepairsPartialRetirementAndRestores():
Promise<void> {
  await withFixture("bundle-partial-compensation", async (fixture) => {
    await writeRecoveryBundleSources(fixture);
    const planned = await plannedBundleMutation(
      fixture,
      "bundle-partial-compensation"
    );
    const prepared = await coordinateRecordMutationTrashBundlePrepare({
      journal: planned,
      participantId: recoveryBundleParticipantId(fixture),
      selectionDigest: RECOVERY_BUNDLE_SELECTION_DIGEST,
      items: RECOVERY_BUNDLE_ITEMS,
      ...coordinatorRoots(fixture),
      now: fixture.now
    });
    let retiredLeaves = 0;
    await assert.rejects(
      () => coordinateRecordMutationTrashBundleRetirement({
        journal: prepared.journal,
        participantId: recoveryBundleParticipantId(fixture),
        selectionDigest: RECOVERY_BUNDLE_SELECTION_DIGEST,
        items: RECOVERY_BUNDLE_ITEMS,
        ...coordinatorRoots(fixture),
        now: fixture.now,
        faultInjector(point) {
          if (
            point === "after-source-retired"
            && ++retiredLeaves === 1
          ) {
            throw new Error("simulated bundle recovery crash");
          }
        }
      }),
      /simulated bundle recovery crash/
    );
    const interrupted = await loadRecordMutationJournal(planned.handle);
    assert.deepEqual(forwardActions(interrupted), ["trash-staged"]);
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

    const participant = recoveryBundleParticipant(fixture, prepared);
    const result = await runRecordMutationRecovery({
      journal: interrupted,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => beforeObservation(
        interrupted.record.intent
      ),
      trashParticipants: [participant],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(result.status, "completed");
    assert.equal(result.journal.record.state, "aborted");
    assert.deepEqual(forwardActions(result.journal), [
      "trash-staged",
      "source-retired"
    ]);
    assert.deepEqual(compensatingActions(result.journal), [
      "compensation-prepared",
      "trash-restored"
    ]);
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
  });
}

async function assertRecreatedRootBlocksProductionRecovery(): Promise<void> {
  await withFixture("recreated-root", async (fixture) => {
    await writeFile(path.join(fixture.sourceRootPath, "conversation.json"), "before\n");
    const planned = await plannedMutation(
      fixture,
      "recreated-root",
      "delete-conversation",
      true
    );
    const prepared = await prepareTrashAndJournal(
      fixture,
      planned,
      "conversation.json"
    );
    const originalRootPath = `${fixture.sourceRootPath}-original`;
    await rename(fixture.sourceRootPath, originalRootPath);
    await mkdir(fixture.sourceRootPath, { mode: 0o700 });
    await writeFile(
      path.join(fixture.sourceRootPath, "conversation.json"),
      "replacement\n"
    );

    const result = await runRecordMutationRecovery({
      journal: prepared.journal,
      withConversationMutation: fixture.withConversationMutation,
      inspectConversation: async () => observationFor(
        prepared.journal.record.intent.targetConversation
      ),
      trashParticipants: [trashParticipant(fixture, prepared.receipt)],
      sourceDeletedParticipants: [],
      now: fixture.now
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.blocker, "trash-evidence-unavailable");
    assert.deepEqual(forwardActions(result.journal), ["trash-staged"]);
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

interface RecoveryFixture {
  storageRootPath: string;
  sourceRootPath: string;
  trashRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootBinding: RecordRootBindingRef;
  withConversationMutation: <T>(
    conversationId: string,
    action: (authority: ConversationMutationAuthority) => Promise<T>
  ) => Promise<T>;
  now: () => number;
}

async function withFixture(
  label: string,
  action: (fixture: RecoveryFixture) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-mutation-recovery-runner-${label}-`)
  );
  const storageRootPath = path.join(rootPath, "store");
  const sourceRootPath = path.join(storageRootPath, "conversation-store");
  const trashRootPath = path.join(storageRootPath, "record-trash");
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
  const conversationLane = new ConversationMutationLane();
  try {
    await action({
      storageRootPath,
      sourceRootPath,
      trashRootPath,
      sourceRootBinding: recordRootBindingRef(source.binding),
      trashRootBinding: recordRootBindingRef(trash.binding),
      withConversationMutation: async <T>(
        conversationId: string,
        mutation: (authority: ConversationMutationAuthority) => Promise<T>
      ): Promise<T> => await conversationLane.withConversationMutation(
        conversationId,
        mutation
      ),
      now
    });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function plannedMutation(
  fixture: RecoveryFixture,
  suffix: string,
  operation: RecordMutationOperation,
  destructive: boolean
): Promise<LoadedRecordMutationJournal> {
  const conversationId = `conversation-${suffix}`;
  return await createRecordMutationJournal({
    storageRootPath: fixture.storageRootPath,
    mutationId: `mutation-${suffix}`,
    intent: {
      operation,
      conversationId,
      expectedConversationGeneration: 3,
      expectedConversationCommitId: "conversation-commit-3",
      expectedConversationContentRevision: `sha256:${"1".repeat(64)}`,
      targetConversation: operation === "delete-conversation"
        ? {
            status: "deleted",
            tombstoneId: `tombstone-${conversationId}`,
            digest: `sha256:${"2".repeat(64)}`
          }
        : {
            status: "present",
            generation: operation === "reset-agent-cache" ? 3 : 4,
            commitId: `target-commit-${conversationId}`,
            contentRevision: `sha256:${"2".repeat(64)}`
          },
      participants: [{
        id: "conversation",
        recordKind: "conversation",
        action: destructive ? "stage" : "retain"
      }],
      rootBindings: destructive
        ? [fixture.sourceRootBinding, fixture.trashRootBinding]
        : [],
      trashPolicy: destructive ? "required" : "not-required"
    },
    createdAt: fixture.now()
  });
}

async function plannedBundleMutation(
  fixture: RecoveryFixture,
  suffix: string
): Promise<LoadedRecordMutationJournal> {
  const conversationId = `conversation-${suffix}`;
  const participantId = recoveryBundleParticipantId(fixture);
  return await createRecordMutationJournal({
    storageRootPath: fixture.storageRootPath,
    mutationId: `mutation-${suffix}`,
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
      participants: [{
        id: participantId,
        recordKind: "conversation",
        action: "stage"
      }],
      rootBindings: [
        fixture.sourceRootBinding,
        fixture.trashRootBinding
      ],
      trashPolicy: "required"
    },
    createdAt: fixture.now()
  });
}

function recoveryBundleParticipantId(fixture: RecoveryFixture): string {
  return recordMutationExecutionBundleParticipantId({
    recordKind: "conversation",
    action: "stage",
    execution: {
      kind: "trash-bundle",
      sourceRootId: fixture.sourceRootBinding.rootId,
      trashRootId: fixture.trashRootBinding.rootId,
      selectionDigest: RECOVERY_BUNDLE_SELECTION_DIGEST,
      items: RECOVERY_BUNDLE_ITEMS.map((item) => ({ ...item }))
    }
  });
}

function recoveryBundleParticipant(
  fixture: RecoveryFixture,
  prepared: CoordinatedRecordMutationTrashBundlePrepare
): RecordMutationRecoveryTrashBundleParticipant {
  return {
    kind: "bundle",
    participantId: recoveryBundleParticipantId(fixture),
    selectionDigest: RECOVERY_BUNDLE_SELECTION_DIGEST,
    items: RECOVERY_BUNDLE_ITEMS,
    preparedReceipt: prepared.preparedReceipt,
    leafReceipts: prepared.leafReceipts,
    ...coordinatorRoots(fixture)
  };
}

async function writeRecoveryBundleSources(
  fixture: RecoveryFixture
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

async function preparedJournal(
  planned: LoadedRecordMutationJournal,
  now: () => number
): Promise<LoadedRecordMutationJournal> {
  return await stageRecordMutationJournal(planned.handle, {
    expectedRevision: planned.record.revision,
    expectedDigest: planned.record.digest,
    step: {
      direction: "forward",
      ordinal: 1,
      participantId: "conversation",
      action: "prepared",
      evidenceDigest: planned.record.intentDigest
    },
    updatedAt: now()
  });
}

async function prepareTrashAndJournal(
  fixture: RecoveryFixture,
  planned: LoadedRecordMutationJournal,
  sourceRelativePath: string
): Promise<{
  journal: LoadedRecordMutationJournal;
  receipt: RecordMutationTrashReceipt;
}> {
  const receipt = await stageRecordMutationTrash({
    mutationId: planned.record.mutationId,
    sourceRootPath: fixture.sourceRootPath,
    sourceRootBinding: fixture.sourceRootBinding,
    sourceRelativePath,
    trashRootPath: fixture.trashRootPath,
    trashRootBinding: fixture.trashRootBinding,
    transfer: "move",
    stagedAt: fixture.now()
  });
  const journal = await stageRecordMutationJournal(planned.handle, {
    expectedRevision: planned.record.revision,
    expectedDigest: planned.record.digest,
    step: {
      direction: "forward",
      ordinal: 1,
      participantId: "conversation",
      action: "trash-staged",
      evidenceDigest: receipt.digest
    },
    updatedAt: fixture.now()
  });
  return { journal, receipt };
}

function trashParticipant(
  fixture: RecoveryFixture,
  receipt: RecordMutationTrashReceipt
): {
  participantId: string;
  receipt: RecordMutationTrashReceipt;
  storageRootPath: string;
  sourceRootPath: string;
  sourceBoundaryRootPath: string;
  sourceRootBinding: RecordRootBindingRef;
  trashRootPath: string;
  trashBoundaryRootPath: string;
  trashRootBinding: RecordRootBindingRef;
} {
  return {
    participantId: "conversation",
    receipt,
    ...coordinatorRoots(fixture)
  };
}

function coordinatorRoots(fixture: RecoveryFixture): {
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

function observationFor(target: RecordMutationConversationTarget):
  | {
      status: "present";
      generation: number;
      commitId: string;
      contentRevision: string;
    }
  | {
      status: "deleted";
      tombstoneId: string;
      digest: string;
    } {
  return target.status === "present"
    ? { ...target }
    : { ...target };
}

function forwardActions(
  journal: LoadedRecordMutationJournal
): string[] {
  return journal.chain.flatMap((revision) => (
    revision.step?.direction === "forward"
      ? [revision.step.action]
      : []
  ));
}

function compensatingActions(
  journal: LoadedRecordMutationJournal
): string[] {
  return journal.chain.flatMap((revision) => (
    revision.step?.direction === "compensating"
      ? [revision.step.action]
      : []
  ));
}

async function exists(absolutePath: string): Promise<boolean> {
  return await stat(absolutePath).then(() => true, () => false);
}
