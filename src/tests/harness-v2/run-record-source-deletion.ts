import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildAttemptPayloadManifest,
  type AttemptHarnessEventV1
} from "../../harness/contracts/run-record";
import {
  createRunRecordSourceDeletionAdapter
} from "../../harness/ledger/run-record-source-deletion";
import {
  FileRunRecordStore,
  RunRecordStoreSimulatedCrash
} from "../../harness/ledger/run-record-store";
import {
  workflowRunPayloadParticipantId,
  type RecordMutationExecutionParticipant
} from "../../harness/lifecycle/record-mutation-execution-plan";
import {
  commitRecordMutationJournal,
  createRecordMutationJournal,
  stageRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  createEchoInkRecordMutationSourceAdapterFactory,
  prepareEchoInkRecordMutationRuntimeRoots
} from "../../harness/lifecycle/record-mutation-production";
import {
  coordinateRecordMutationSourceParticipantForward,
  verifyRecordMutationSourceParticipantForward
} from "../../harness/lifecycle/record-mutation-source-participant";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef
} from "../../harness/storage/record-root-registry";
import {
  pluginDataDir
} from "../../core/raw-message-store";

const BASE_TIME = 1_721_260_800_000;

export async function runHarnessV2RunRecordSourceDeletionTests():
Promise<void> {
  await assertRunPayloadAdapterRecoversForwardAndRestoreCrashWindows();
  await assertProductionAdapterSupportsTerminalProof();
}

async function assertRunPayloadAdapterRecoversForwardAndRestoreCrashWindows():
Promise<void> {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "echoink-run-source-deletion-")
  );
  try {
    const storageRootPath = path.join(fixtureRoot, "storage");
    await mkdir(storageRootPath);
    const store = new FileRunRecordStore({ storageRootPath });
    const events = payloadEvents();
    const manifest = buildAttemptPayloadManifest({
      workflowRunId: "workflow-source-delete",
      attemptId: "attempt-source-delete",
      harnessRunId: "harness-source-delete",
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.sealAttemptPayload(manifest, events, {
      expectedRevision: null,
      expectedDigest: null
    });
    const binding = await createOrLoadRecordRootBinding({
      storageRootPath,
      rootId: "run",
      rootPath: store.rootPath,
      boundaryRootPath: storageRootPath,
      authority: "plugin-owned",
      createdAt: BASE_TIME + 300
    });
    const participantId = workflowRunPayloadParticipantId(
      manifest.workflowRunId,
      manifest.attemptId
    );
    let failForward = true;
    let failRestore = true;
    const adapter = createRunRecordSourceDeletionAdapter({
      storageRootPath,
      rootPath: store.rootPath,
      boundaryRootPath: storageRootPath,
      rootBinding: recordRootBindingRef(binding.binding),
      mutationId: "mutation-run-source-delete",
      conversationId: "conversation-run-source-delete",
      participantId,
      workflowRunId: manifest.workflowRunId,
      attemptId: manifest.attemptId,
      harnessRunId: manifest.harnessRunId,
      payloadDigest: manifest.digest,
      faultInjector: (phase) => (point) => {
        if (
          point === "after-manifest-link"
          && phase === "source-deleted"
          && failForward
        ) {
          failForward = false;
          throw new RunRecordStoreSimulatedCrash(
            "forward source deletion crash"
          );
        }
        if (
          point === "after-manifest-link"
          && phase === "source-restored"
          && failRestore
        ) {
          failRestore = false;
          throw new RunRecordStoreSimulatedCrash(
            "restore source deletion crash"
          );
        }
      }
    });
    const identity = {
      mutationId: "mutation-run-source-delete",
      conversationId: "conversation-run-source-delete",
      participantId
    };
    await assert.rejects(
      adapter.withMutation(async () => {
        await adapter.recover();
        return await adapter.stage({
          ...identity,
          occurredAt: BASE_TIME + 1_000
        });
      }),
      RunRecordStoreSimulatedCrash
    );
    const forward = await adapter.withMutation(async () => {
      await adapter.recover();
      const observation = await adapter.inspect(identity);
      assert.equal(observation.status, "source-deleted");
      if (observation.status !== "source-deleted") {
        throw new Error("expected Run source deletion");
      }
      return observation.forwardReceipt;
    });
    assert.equal(forward.recordKind, "workflow-run");
    assert.equal(
      (await store.readAttemptPayload(manifest)).state,
      "expired"
    );

    await assert.rejects(
      adapter.withMutation(async () => {
        await adapter.recover();
        return await adapter.restore({
          ...identity,
          forwardReceipt: forward,
          occurredAt: BASE_TIME + 2_000
        });
      }),
      RunRecordStoreSimulatedCrash
    );
    const restored = await adapter.withMutation(async () => {
      await adapter.recover();
      const observation = await adapter.inspect(identity);
      assert.equal(observation.status, "source-restored");
      if (observation.status !== "source-restored") {
        throw new Error("expected Run source restoration");
      }
      return observation.restoreReceipt;
    });
    assert.equal(restored.recordKind, "workflow-run");
    const payload = await store.readAttemptPayload(manifest);
    assert.equal(payload.state, "present");
    if (payload.state !== "present") {
      throw new Error("expected restored payload");
    }
    assert.deepEqual(payload.events, events);

    const wrong = createRunRecordSourceDeletionAdapter({
      storageRootPath,
      rootPath: store.rootPath,
      boundaryRootPath: storageRootPath,
      rootBinding: recordRootBindingRef(binding.binding),
      mutationId: identity.mutationId,
      conversationId: identity.conversationId,
      participantId,
      workflowRunId: manifest.workflowRunId,
      attemptId: manifest.attemptId,
      harnessRunId: manifest.harnessRunId,
      payloadDigest: `sha256:${"0".repeat(64)}`
    });
    await assert.rejects(
      wrong.withMutation(async () => {
        await wrong.recover();
        return await wrong.inspect(identity);
      }),
      /frozen payload identity changed/
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function assertProductionAdapterSupportsTerminalProof():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-run-source-production-")
  );
  try {
    const pluginDir = "codex-echoink";
    const storageRootPath = pluginDataDir(vaultPath, pluginDir);
    const prepared = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath,
      pluginDir,
      rootIds: [
        ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
        ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
      ].sort((left, right) => left.localeCompare(right)),
      createdAt: BASE_TIME
    });
    const runRoot = prepared.roots.find(
      (root) => root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.run
    );
    if (!runRoot) throw new Error("expected production Run root");
    const store = new FileRunRecordStore({ storageRootPath });
    const events = payloadEvents();
    const manifest = buildAttemptPayloadManifest({
      workflowRunId: "workflow-source-delete",
      attemptId: "attempt-source-delete",
      harnessRunId: "harness-source-delete",
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.sealAttemptPayload(manifest, events, {
      expectedRevision: null,
      expectedDigest: null
    });
    const participantId = workflowRunPayloadParticipantId(
      manifest.workflowRunId,
      manifest.attemptId
    );
    const journal = await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-run-production",
      intent: {
        operation: "delete-conversation",
        conversationId: "conversation-run-source-delete",
        expectedConversationGeneration: 1,
        expectedConversationCommitId: "conversation-before",
        expectedConversationContentRevision:
          `sha256:${"1".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "conversation-deleted",
          digest: `sha256:${"2".repeat(64)}`
        },
        participants: [
          {
            id: "conversation-stage",
            recordKind: "conversation",
            action: "stage"
          },
          {
            id: participantId,
            recordKind: "workflow-run",
            action: "mark-source-deleted"
          }
        ],
        rootBindings: prepared.roots.map((root) => root.rootBinding),
        trashPolicy: "required"
      },
      createdAt: BASE_TIME + 1_000
    });
    const staged = await stageRecordMutationJournal(journal.handle, {
      expectedRevision: journal.record.revision,
      expectedDigest: journal.record.digest,
      step: {
        direction: "forward",
        ordinal: 1,
        participantId: "conversation-stage",
        action: "trash-staged",
        evidenceDigest: `sha256:${"3".repeat(64)}`
      },
      updatedAt: BASE_TIME + 1_001
    });
    const executionParticipant: RecordMutationExecutionParticipant = {
      participantId,
      recordKind: "workflow-run",
      action: "mark-source-deleted",
      execution: {
        kind: "source-deletion",
        rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
        subject: {
          kind: "workflow-run",
          workflowRunId: manifest.workflowRunId,
          attemptId: manifest.attemptId,
          harnessRunId: manifest.harnessRunId,
          payloadDigest: manifest.digest
        }
      }
    };
    const adapter = createEchoInkRecordMutationSourceAdapterFactory({
      vaultPath
    })({
      journal: staged,
      participant: executionParticipant,
      root: runRoot
    });
    const forwarded =
      await coordinateRecordMutationSourceParticipantForward({
        journal: staged,
        adapter,
        now: () => BASE_TIME + 1_002
      });
    const retired = await stageRecordMutationJournal(forwarded.handle, {
      expectedRevision: forwarded.record.revision,
      expectedDigest: forwarded.record.digest,
      step: {
        direction: "forward",
        ordinal: 3,
        participantId: "conversation-stage",
        action: "source-retired",
        evidenceDigest: `sha256:${"4".repeat(64)}`
      },
      updatedAt: BASE_TIME + 1_003
    });
    const committed = await commitRecordMutationJournal(retired.handle, {
      expectedRevision: retired.record.revision,
      expectedDigest: retired.record.digest,
      committedAt: BASE_TIME + 1_004,
      message: "Run source deletion production proof"
    });
    const verified = await verifyRecordMutationSourceParticipantForward({
      journal: committed,
      adapter
    });
    assert.equal(verified.record.state, "committed");
    assert.equal(
      (await store.readAttemptPayload(manifest)).state,
      "expired"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

function payloadEvents(): AttemptHarnessEventV1[] {
  const identity = {
    workflowRunId: "workflow-source-delete",
    attemptId: "attempt-source-delete",
    harnessRunId: "harness-source-delete"
  };
  return [
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      ...identity,
      eventId: "run-source-delete:1",
      runId: identity.harnessRunId,
      sequence: 1,
      createdAt: BASE_TIME,
      source: "kernel",
      type: "run.created"
    },
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      ...identity,
      eventId: "run-source-delete:2",
      runId: identity.harnessRunId,
      sequence: 2,
      createdAt: BASE_TIME + 100,
      source: "kernel",
      type: "run.completed"
    },
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      ...identity,
      eventId: "run-source-delete:3",
      runId: identity.harnessRunId,
      sequence: 3,
      createdAt: BASE_TIME + 200,
      source: "workflow",
      type: "run.local_commit.completed"
    }
  ];
}

if (process.env.ECHOINK_RUN_RUN_RECORD_SOURCE_DELETION_TEST === "1") {
  runHarnessV2RunRecordSourceDeletionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
