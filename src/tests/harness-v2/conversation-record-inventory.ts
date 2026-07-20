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
  createWorkflowArtifactLifecycleRecord
} from "../../harness/artifacts/artifact-lifecycle-store";
import {
  buildAttemptPayloadManifest,
  finalizeAttemptRunSummary,
  finalizeWorkflowRunSummary
} from "../../harness/contracts/run-record";
import type {
  AttemptHarnessEventV1
} from "../../harness/contracts/run-record";
import {
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import { workspaceFingerprint } from "../../harness/kernel/session-service";
import {
  FileRunRecordStore
} from "../../harness/ledger/run-record-store";
import {
  createRecordMutationExecutionPlan
} from "../../harness/lifecycle/record-mutation-execution-plan";
import {
  materializeRecordMutationExecution,
  RecordMutationExecutionRuntimeError
} from "../../harness/lifecycle/record-mutation-execution-runtime";
import {
  createRecordMutationJournal,
  loadRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  echoInkRecordMutationRootPath,
  prepareEchoInkRecordMutationRuntimeRoots
} from "../../harness/lifecycle/record-mutation-production";
import {
  appendPendingMemoryEvent,
  initializeEchoInkMemoryV2
} from "../../harness/memory/v2-store";
import {
  inventoryConversationRecords,
  inventoryRawGcPreview
} from "../../harness/records/conversation-record-inventory";
import {
  buildConversationRecordMutationPlan
} from "../../harness/records/conversation-record-mutation-plan";
import {
  createEchoInkRecordMutationSelectionVerifier
} from "../../harness/records/conversation-record-mutation-selection-verifier";
import {
  pluginDataDir,
  rawStorageDir,
  writeRawText
} from "../../core/raw-message-store";
import type {
  ChatMessage,
  StoredSession
} from "../../settings/settings";

const BASE_TIME = 1_721_260_800_000;
const PLUGIN_DIR = "codex-echoink";

export async function runHarnessV2ConversationRecordInventoryTests():
Promise<void> {
  await assertRawOwnerGraphSeparatesExclusiveAndSharedSources();
  await assertMissingRawAndPendingMemoryBlockSelection();
  await assertArtifactRequiresAnExplicitRetentionDecision();
  await assertRunInventoryBlockersArePreserved();
  await assertFrozenSelectionIsReinventoriedBeforeTrashPrepare();
  await assertRawGcPreviewMarksGlobalOwnersAndCandidates();
  await assertRawGcPreviewBlocksMissingAndDriftingSources();
  await assertRawGcPreviewBlocksUnrelatedRunOwnershipGap();
  await assertRawGcPreviewBlocksWithoutConversationAuthority();
  await assertRawGcPreviewBlocksCorruptExplicitOwnerStore();
}

async function assertRawOwnerGraphSeparatesExclusiveAndSharedSources():
Promise<void> {
  await withVault("raw-owner-graph", async (vaultPath) => {
    await writeRawText(
      vaultPath,
      "raw/exclusive.txt",
      "exclusive bytes",
      PLUGIN_DIR
    );
    await writeRawText(
      vaultPath,
      "raw/shared.txt",
      "shared bytes",
      PLUGIN_DIR
    );
    const conversations = [
      session("conversation-target", [
        message("message-exclusive", "raw/exclusive.txt"),
        message("message-shared-target", "raw/shared.txt")
      ]),
      session("conversation-other", [
        message("message-shared-other", "raw/shared.txt")
      ])
    ];
    const first = await inventoryConversationRecords({
      operation: "clear-conversation-records",
      conversationId: "conversation-target",
      conversations,
      vaultPath,
      pluginDir: PLUGIN_DIR
    });
    const second = await inventoryConversationRecords({
      operation: "clear-conversation-records",
      conversationId: "conversation-target",
      conversations,
      vaultPath,
      pluginDir: PLUGIN_DIR
    });
    assert.deepEqual(second, first);
    assert.equal(first.status, "ready");
    assert.deepEqual(first.blockers, []);
    assert.deepEqual(
      first.raw?.subjects.map((subject) => ({
        rawRef: subject.rawRef,
        action: subject.action,
        sourceRelativePath: subject.sourceRelativePath
      })),
      [
        {
          rawRef: "raw/exclusive.txt",
          action: "discard",
          sourceRelativePath: "exclusive.txt"
        },
        {
          rawRef: "raw/shared.txt",
          action: "retain",
          sourceRelativePath: "shared.txt"
        }
      ]
    );
    assert.match(first.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
  });
}

async function assertMissingRawAndPendingMemoryBlockSelection():
Promise<void> {
  await withVault("raw-memory-blockers", async (vaultPath) => {
    await initializeEchoInkMemoryV2(vaultPath);
    await appendPendingMemoryEvent(vaultPath, {
      eventId: "event-pending-target",
      runId: "run-pending-target",
      sessionId: "conversation-target",
      workflow: "chat",
      backendId: "codex-cli",
      eventType: "user-input",
      createdAt: BASE_TIME,
      payload: { text: "pending source" }
    });
    const inventory = await inventoryConversationRecords({
      operation: "delete-conversation",
      conversationId: "conversation-target",
      conversations: [
        session("conversation-target", [
          message("message-missing", "raw/missing.txt")
        ])
      ],
      vaultPath,
      pluginDir: PLUGIN_DIR
    });
    assert.equal(inventory.status, "blocked");
    assert.deepEqual(
      inventory.blockers.map((blocker) => blocker.code),
      ["memory-pending-event", "raw-reference-missing"]
    );
  });
}

async function assertArtifactRequiresAnExplicitRetentionDecision():
Promise<void> {
  await withVault("artifact-choice", async (vaultPath) => {
    const artifactRootPath = echoInkRecordMutationRootPath({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact
    });
    await createWorkflowArtifactLifecycleRecord({
      rootPath: artifactRootPath,
      artifactId: "artifact-choice",
      artifactKind: "markdown-report",
      sourceConversationIds: ["conversation-target"],
      createdAt: BASE_TIME
    });
    const conversations = [session("conversation-target", [])];
    const preview = await inventoryConversationRecords({
      operation: "delete-conversation",
      conversationId: "conversation-target",
      conversations,
      vaultPath,
      pluginDir: PLUGIN_DIR
    });
    assert.deepEqual(preview.blockers, [{
      code: "artifact-disposition-required",
      subjectId: "artifact-choice"
    }]);
    assert.deepEqual(preview.artifacts?.subjects, [{
      artifactId: "artifact-choice",
      artifactKind: "markdown-report",
      action: "requires-explicit-choice"
    }]);

    const selected = await inventoryConversationRecords({
      operation: "delete-conversation",
      conversationId: "conversation-target",
      conversations,
      vaultPath,
      pluginDir: PLUGIN_DIR,
      decisions: {
        retainArtifactIds: ["artifact-choice"]
      }
    });
    assert.equal(selected.status, "ready");
    assert.deepEqual(selected.artifacts?.subjects, [{
      artifactId: "artifact-choice",
      artifactKind: "markdown-report",
      action: "mark-source-deleted"
    }]);

    const stale = await inventoryConversationRecords({
      operation: "delete-conversation",
      conversationId: "conversation-target",
      conversations,
      vaultPath,
      pluginDir: PLUGIN_DIR,
      decisions: {
        retainArtifactIds: ["artifact-choice", "artifact-stale"]
      }
    });
    assert.deepEqual(stale.blockers, [{
      code: "artifact-decision-stale",
      subjectId: "artifact-stale"
    }]);
  });
}

async function assertRunInventoryBlockersArePreserved(): Promise<void> {
  await withVault("run-blocker", async (vaultPath) => {
    const store = new FileRunRecordStore({
      storageRootPath: pluginDataDir(vaultPath, PLUGIN_DIR)
    });
    const workflow = finalizeWorkflowRunSummary({
      schemaVersion: 1,
      recordType: "workflow-run-summary",
      workflowRunId: "workflow-missing-attempt",
      surface: "chat",
      workflow: "chat.turn",
      conversationRef: {
        conversationId: "conversation-target",
        contextId: "context-target",
        turnId: "turn-target"
      },
      status: "completed",
      startedAt: BASE_TIME,
      terminalAt: BASE_TIME + 100,
      attemptRefs: [{
        attemptId: "attempt-missing",
        ordinal: 1
      }],
      artifactRefs: [],
      errorCode: "none",
      localMutation: {
        state: "committed",
        transactionId: "conversation-commit",
        committedAt: BASE_TIME + 100
      },
      retention: {
        holdReasons: []
      },
      revision: 0
    });
    await mkdir(pluginDataDir(vaultPath, PLUGIN_DIR), {
      recursive: true
    });
    await store.writeWorkflowRunSummary(workflow, {
      expectedRevision: null,
      expectedDigest: null
    });
    const inventory = await inventoryConversationRecords({
      operation: "clear-conversation-records",
      conversationId: "conversation-target",
      conversations: [session("conversation-target", [])],
      vaultPath,
      pluginDir: PLUGIN_DIR
    });
    assert.deepEqual(inventory.blockers, [{
      code: "run-missing-attempt-summary",
      subjectId: "workflow-missing-attempt:attempt-missing"
    }]);
  });
}

async function assertFrozenSelectionIsReinventoriedBeforeTrashPrepare():
Promise<void> {
  await withVault("selection-verifier", async (vaultPath) => {
    await writeRawText(
      vaultPath,
      "raw/exclusive.txt",
      "exclusive bytes",
      PLUGIN_DIR
    );
    await writeRawText(
      vaultPath,
      "raw/shared.txt",
      "shared bytes",
      PLUGIN_DIR
    );
    const conversations = [
      session("conversation-target", [
        message("message-exclusive", "raw/exclusive.txt"),
        message("message-shared-target", "raw/shared.txt")
      ]),
      session("conversation-other", [
        message("message-shared-other", "raw/shared.txt")
      ])
    ];
    const prepared = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      rootIds: [
        ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation,
        ECHOINK_RECORD_MUTATION_ROOT_IDS.raw,
        ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
      ].sort((left, right) => left.localeCompare(right)),
      createdAt: BASE_TIME
    });
    const conversationRoot = prepared.roots.find(
      (root) =>
        root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation
    );
    assert.ok(conversationRoot);
    const conversationSourcePath = path.join(
      conversationRoot.rootPath,
      "sessions",
      "conversation-target"
    );
    await mkdir(conversationSourcePath, { recursive: true });
    await writeFile(
      path.join(conversationSourcePath, "messages.jsonl"),
      "{}\n",
      "utf8"
    );
    const inventory = await inventoryConversationRecords({
      operation: "delete-conversation",
      conversationId: "conversation-target",
      conversations,
      vaultPath,
      pluginDir: PLUGIN_DIR
    });
    assert.equal(inventory.status, "ready");
    const built = buildConversationRecordMutationPlan({
      inventory,
      conversationSources: [{
        sourceRelativePath: "sessions/conversation-target"
      }],
      expectedConversationGeneration: 2,
      expectedConversationCommitId: "conversation-commit-2",
      expectedConversationContentRevision:
        `sha256:${"a".repeat(64)}`,
      targetConversation: {
        status: "deleted",
        tombstoneId: "conversation-selection-deleted",
        digest: `sha256:${"b".repeat(64)}`
      },
      rootBindings: prepared.roots.map((root) => root.rootBinding)
    });
    const verifier = createEchoInkRecordMutationSelectionVerifier({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      getConversations: () => conversations
    });
    const firstJournal = await createRecordMutationJournal({
      storageRootPath: prepared.storageRootPath,
      mutationId: "mutation-selection-verified",
      intent: built.intent,
      createdAt: BASE_TIME + 1
    });
    const firstPlan = await createRecordMutationExecutionPlan({
      journal: firstJournal,
      participants: built.executionParticipants,
      createdAt: BASE_TIME + 2
    });
    const materialized = await materializeRecordMutationExecution({
      journal: firstJournal,
      plan: firstPlan,
      roots: prepared.roots,
      verifyFrozenSelection: verifier,
      now: () => BASE_TIME + 3
    });
    const retainParticipant = built.executionParticipants.find(
      (participant) => participant.execution.kind === "retain-bundle"
    );
    assert.ok(retainParticipant);
    assert.equal(
      materialized.journal.chain.some((revision) => (
        revision.step?.participantId === retainParticipant.participantId
        && revision.step.action === "prepared"
      )),
      true
    );
    assert.equal(
      await readFile(
        path.join(rawStorageDir(vaultPath, PLUGIN_DIR), "shared.txt"),
        "utf8"
      ),
      "shared bytes"
    );
    assert.equal(
      await readFile(
        path.join(rawStorageDir(vaultPath, PLUGIN_DIR), "exclusive.txt"),
        "utf8"
      ),
      "exclusive bytes"
    );

    conversations[1].messages = [];
    const driftedJournal = await createRecordMutationJournal({
      storageRootPath: prepared.storageRootPath,
      mutationId: "mutation-selection-drifted",
      intent: built.intent,
      createdAt: BASE_TIME + 10
    });
    const driftedPlan = await createRecordMutationExecutionPlan({
      journal: driftedJournal,
      participants: built.executionParticipants,
      createdAt: BASE_TIME + 11
    });
    await assert.rejects(
      materializeRecordMutationExecution({
        journal: driftedJournal,
        plan: driftedPlan,
        roots: prepared.roots,
        verifyFrozenSelection: verifier,
        now: () => BASE_TIME + 12
      }),
      (error: unknown) => (
        error instanceof RecordMutationExecutionRuntimeError
        && error.code === "inventory_mismatch"
      )
    );
    assert.equal(
      (await loadRecordMutationJournal(driftedJournal.handle))
        .record.state,
      "planned"
    );
    assert.equal(
      await readFile(
        path.join(rawStorageDir(vaultPath, PLUGIN_DIR), "exclusive.txt"),
        "utf8"
      ),
      "exclusive bytes"
    );
  });
}

async function assertRawGcPreviewMarksGlobalOwnersAndCandidates():
Promise<void> {
  await withVault("raw-gc-preview", async (vaultPath) => {
    await writeRawText(
      vaultPath,
      "raw/conversation-owned.txt",
      "CONVERSATION_RAW_BODY_MUST_NOT_ENTER_PREVIEW",
      PLUGIN_DIR
    );
    await writeRawText(
      vaultPath,
      "raw/run-owned.txt",
      "RUN_RAW_BODY_MUST_NOT_ENTER_PREVIEW",
      PLUGIN_DIR
    );
    await writeRawText(
      vaultPath,
      "raw/unowned.txt",
      "UNOWNED_RAW_BODY_MUST_NOT_ENTER_PREVIEW",
      PLUGIN_DIR
    );
    await persistCanonicalConversation(
      vaultPath,
      canonicalSession(vaultPath, "conversation-raw-gc", [
        message(
          "message-conversation-raw",
          "raw/conversation-owned.txt"
        )
      ])
    );
    await writeRunPayloadRawOwner(
      vaultPath,
      "conversation-raw-gc",
      "raw/run-owned.txt"
    );

    const first = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME
    });
    const second = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME
    });
    assert.deepEqual(second, first);
    assert.equal(first.status, "ready");
    assert.deepEqual(first.blockers, []);
    assert.equal(first.retainCount, 2);
    assert.equal(first.quarantineCandidateCount, 1);
    assert.deepEqual(
      first.subjects.map((subject) => ({
        disposition: subject.disposition,
        ownerCount: subject.ownerCount,
        ownerKinds: subject.ownerKinds,
        eligibleForQuarantine: subject.eligibleForQuarantine
      })).sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
      [
        {
          disposition: "retain",
          ownerCount: 1,
          ownerKinds: ["workflow-run-payload"],
          eligibleForQuarantine: false
        },
        {
          disposition: "quarantine-candidate",
          ownerCount: 0,
          ownerKinds: [],
          eligibleForQuarantine: true
        },
        {
          disposition: "retain",
          ownerCount: 1,
          ownerKinds: ["conversation-message"],
          eligibleForQuarantine: false
        }
      ].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
    );
    assert.deepEqual(first.safetyReceipt, {
      metadataOnly: true,
      rawBodiesRead: false,
      actionsApplied: 0,
      destructiveActionCount: 0,
      automaticActionAllowed: false
    });
    const serialized = JSON.stringify(first);
    for (const forbidden of [
      "conversation-owned.txt",
      "run-owned.txt",
      "unowned.txt",
      "RAW_BODY_MUST_NOT_ENTER_PREVIEW",
      vaultPath
    ]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden));
    }
    assert.equal(
      await readFile(
        path.join(rawStorageDir(vaultPath, PLUGIN_DIR), "unowned.txt"),
        "utf8"
      ),
      "UNOWNED_RAW_BODY_MUST_NOT_ENTER_PREVIEW"
    );
  });
}

async function assertRawGcPreviewBlocksMissingAndDriftingSources():
Promise<void> {
  await withVault("raw-gc-missing", async (vaultPath) => {
    await writeRawText(
      vaultPath,
      "raw/unowned.txt",
      "unowned",
      PLUGIN_DIR
    );
    await persistCanonicalConversation(
      vaultPath,
      canonicalSession(vaultPath, "conversation-raw-missing", [
        message("message-raw-missing", "raw/missing.txt")
      ])
    );
    const preview = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME
    });
    assert.equal(preview.status, "blocked");
    assert.deepEqual(
      preview.blockers.map((blocker) => blocker.code),
      ["raw-reference-missing"]
    );
    assert.equal(preview.quarantineCandidateCount, 1);
    assert.equal(
      preview.subjects[0]?.eligibleForQuarantine,
      false,
      "a missing owner target must disable every quarantine candidate"
    );
  });

  await withVault("raw-gc-drift", async (vaultPath) => {
    await persistCanonicalConversation(
      vaultPath,
      canonicalSession(vaultPath, "conversation-raw-drift", [])
    );
    const preview = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME,
      hooks: {
        afterFirstSnapshot: async () => {
          await writeRawText(
            vaultPath,
            "raw/appeared-during-scan.txt",
            "drift",
            PLUGIN_DIR
          );
        }
      }
    });
    assert.equal(preview.status, "blocked");
    assert.deepEqual(
      preview.blockers.map((blocker) => blocker.code),
      ["inventory-drift"]
    );
    assert.deepEqual(
      preview.subjects,
      [],
      "a drifting Store must invalidate the entire classification"
    );
  });
}

async function assertRawGcPreviewBlocksUnrelatedRunOwnershipGap():
Promise<void> {
  await withVault("raw-gc-global-run-gap", async (vaultPath) => {
    await persistCanonicalConversation(
      vaultPath,
      canonicalSession(vaultPath, "conversation-present", [])
    );
    const store = new FileRunRecordStore({
      storageRootPath: pluginDataDir(vaultPath, PLUGIN_DIR)
    });
    const workflow = finalizeWorkflowRunSummary({
      schemaVersion: 1,
      recordType: "workflow-run-summary",
      workflowRunId: "workflow-unrelated-missing-attempt",
      surface: "chat",
      workflow: "chat.turn",
      conversationRef: {
        conversationId: "conversation-unrelated",
        contextId: "context-unrelated",
        turnId: "turn-unrelated"
      },
      status: "completed",
      startedAt: BASE_TIME,
      terminalAt: BASE_TIME + 100,
      attemptRefs: [{
        attemptId: "attempt-unrelated-missing",
        ordinal: 1
      }],
      artifactRefs: [],
      errorCode: "none",
      localMutation: {
        state: "committed",
        transactionId: "transaction-unrelated",
        committedAt: BASE_TIME + 100
      },
      retention: {
        holdReasons: []
      },
      revision: 0
    });
    await store.writeWorkflowRunSummary(workflow, {
      expectedRevision: null,
      expectedDigest: null
    });
    const preview = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME
    });
    assert.equal(preview.status, "blocked");
    assert.deepEqual(
      preview.blockers.map((blocker) => blocker.code),
      ["run-owner-inventory-incomplete"],
      "a gap in an unrelated Run must block the global owner graph"
    );
  });
}

async function assertRawGcPreviewBlocksWithoutConversationAuthority():
Promise<void> {
  await withVault("raw-gc-no-conversation-store", async (vaultPath) => {
    await writeRawText(
      vaultPath,
      "raw/legacy-unowned.txt",
      "legacy",
      PLUGIN_DIR
    );
    const preview = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME
    });
    assert.equal(preview.status, "blocked");
    assert.deepEqual(
      preview.blockers.map((blocker) => blocker.code),
      ["conversation-store-unavailable"]
    );
    assert.equal(preview.quarantineCandidateCount, 1);
    assert.equal(preview.subjects[0]?.eligibleForQuarantine, false);
  });
}

async function assertRawGcPreviewBlocksCorruptExplicitOwnerStore():
Promise<void> {
  await withVault("raw-gc-corrupt-artifact-store", async (vaultPath) => {
    await persistCanonicalConversation(
      vaultPath,
      canonicalSession(vaultPath, "conversation-artifact-scan", [])
    );
    const artifactRootPath = echoInkRecordMutationRootPath({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact
    });
    await mkdir(artifactRootPath, { recursive: true });
    await writeFile(
      path.join(artifactRootPath, "unknown-owner-entry.json"),
      "{}\n",
      "utf8"
    );
    const preview = await inventoryRawGcPreview({
      vaultPath,
      pluginDir: PLUGIN_DIR,
      now: () => BASE_TIME
    });
    assert.equal(preview.status, "blocked");
    assert.deepEqual(
      preview.blockers.map((blocker) => blocker.code),
      ["artifact-inventory-corrupt"],
      "unknown Artifact schema must block a global Raw owner decision"
    );
  });
}

function canonicalSession(
  vaultPath: string,
  id: string,
  messages: ChatMessage[]
): StoredSession {
  return {
    id,
    title: id,
    kind: "chat",
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: `context-${id}`,
    commitId: `commit-${id}`,
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME
  };
}

async function persistCanonicalConversation(
  vaultPath: string,
  value: StoredSession
): Promise<void> {
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  await store.createPristineSession({
    ...value,
    messages: [],
    contextSnapshot: undefined,
    rollingSummary: undefined
  });
  await store.upsertSession(value);
}

async function writeRunPayloadRawOwner(
  vaultPath: string,
  conversationId: string,
  rawRef: string
): Promise<void> {
  const workflowRunId = "workflow-raw-gc";
  const attemptId = "attempt-raw-gc";
  const harnessRunId = "harness-raw-gc";
  const store = new FileRunRecordStore({
    storageRootPath: pluginDataDir(vaultPath, PLUGIN_DIR)
  });
  const workflow = finalizeWorkflowRunSummary({
    schemaVersion: 1,
    recordType: "workflow-run-summary",
    workflowRunId,
    surface: "chat",
    workflow: "chat.turn",
    conversationRef: {
      conversationId,
      contextId: `context-${conversationId}`,
      turnId: "turn-raw-gc"
    },
    status: "completed",
    startedAt: BASE_TIME,
    terminalAt: BASE_TIME + 300,
    attemptRefs: [{ attemptId, ordinal: 1 }],
    artifactRefs: [],
    errorCode: "none",
    localMutation: {
      state: "committed",
      transactionId: "transaction-raw-gc",
      committedAt: BASE_TIME + 300
    },
    retention: {
      holdReasons: []
    },
    revision: 0
  });
  const attempt = finalizeAttemptRunSummary({
    schemaVersion: 1,
    recordType: "attempt-run-summary",
    workflowRunId,
    attemptId,
    ordinal: 1,
    harnessRunId,
    backendId: "codex-cli",
    nativeExecutionRecordIds: [],
    status: "completed",
    startedAt: BASE_TIME,
    terminalAt: BASE_TIME + 200,
    errorCode: "none",
    reasonCode: "none",
    localCommit: {
      state: "committed",
      authorityKind: "conversation",
      committedAt: BASE_TIME + 300
    },
    cleanup: {
      status: "disposed",
      attempts: 1,
      settledAt: BASE_TIME + 400,
      reasonCode: "cleanup-completed"
    },
    payload: {
      expected: true,
      expiresAt: BASE_TIME + 30 * 24 * 60 * 60 * 1_000
    },
    retention: {
      holdReasons: []
    },
    revision: 0
  });
  const events: AttemptHarnessEventV1[] = [
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      workflowRunId,
      attemptId,
      harnessRunId,
      eventId: `${harnessRunId}:1`,
      runId: harnessRunId,
      sequence: 1,
      createdAt: BASE_TIME,
      source: "kernel",
      type: "run.created"
    },
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      workflowRunId,
      attemptId,
      harnessRunId,
      eventId: `${harnessRunId}:2`,
      runId: harnessRunId,
      sequence: 2,
      createdAt: BASE_TIME + 100,
      source: "kernel",
      type: "run.completed",
      data: { rawRef }
    }
  ];
  const payload = buildAttemptPayloadManifest({
    workflowRunId,
    attemptId,
    harnessRunId,
    createdAt: BASE_TIME,
    revision: 0
  }, events);
  await store.writeWorkflowRunSummary(workflow, {
    expectedRevision: null,
    expectedDigest: null
  });
  await store.writeAttemptRunSummary(attempt, {
    expectedRevision: null,
    expectedDigest: null
  });
  await store.sealAttemptPayload(payload, events, {
    expectedRevision: null,
    expectedDigest: null
  });
}

function session(
  id: string,
  messages: ChatMessage[]
): StoredSession {
  return {
    id,
    title: id,
    cwd: "/vault",
    messages,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME
  };
}

function message(id: string, rawRef: string): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "preview",
    rawRef,
    rawSize: 16,
    rawLines: 1,
    rawTruncatedForPreview: true,
    createdAt: BASE_TIME
  };
}

async function withVault(
  label: string,
  action: (vaultPath: string) => Promise<void>
): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), `echoink-conversation-inventory-${label}-`)
  );
  try {
    await action(vaultPath);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

if (process.env.ECHOINK_RUN_CONVERSATION_RECORD_INVENTORY_TEST === "1") {
  runHarnessV2ConversationRecordInventoryTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
