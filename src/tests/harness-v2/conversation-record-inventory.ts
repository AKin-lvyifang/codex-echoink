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
  finalizeWorkflowRunSummary
} from "../../harness/contracts/run-record";
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
  inventoryConversationRecords
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
