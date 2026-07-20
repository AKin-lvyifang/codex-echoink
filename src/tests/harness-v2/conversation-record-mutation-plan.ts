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
  finalizeAttemptRunSummary,
  finalizeWorkflowRunSummary,
  type AttemptHarnessEventV1
} from "../../harness/contracts/run-record";
import {
  createRecordMutationExecutionPlan
} from "../../harness/lifecycle/record-mutation-execution-plan";
import {
  createRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS
} from "../../harness/lifecycle/record-mutation-production";
import {
  buildConversationRecordMutationPlan,
  ConversationRecordMutationPlanError
} from "../../harness/records/conversation-record-mutation-plan";
import type {
  ConversationRecordInventory
} from "../../harness/records/conversation-record-inventory";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef,
  type RecordRootBindingRef
} from "../../harness/storage/record-root-registry";

const BASE_TIME = 1_721_260_800_000;

export async function runHarnessV2ConversationRecordMutationPlanTests():
Promise<void> {
  await assertInventoryCompilesIntoBoundedDeterministicBundles();
  await assertBlockedInventoryAndWrongRootsFailBeforeJournal();
  await assertOversizedBundleFailsBeforeJournal();
}

async function assertInventoryCompilesIntoBoundedDeterministicBundles():
Promise<void> {
  await withFixture("deterministic", async (fixture) => {
    const inventory = readyInventory(40);
    const first = buildConversationRecordMutationPlan({
      inventory,
      conversationSources: [{
        sourceRelativePath: "sessions/conversation-target"
      }],
      expectedConversationGeneration: 2,
      expectedConversationCommitId: "conversation-commit-2",
      expectedConversationContentRevision:
        `sha256:${"1".repeat(64)}`,
      targetConversation: {
        status: "deleted",
        tombstoneId: "conversation-target-deleted",
        digest: `sha256:${"2".repeat(64)}`
      },
      rootBindings: fixture.bindings
    });
    const reversed = structuredClone(inventory);
    reversed.run!.workflowRuns.reverse();
    for (const workflow of reversed.run!.workflowRuns) {
      workflow.attempts.reverse();
    }
    reversed.memory!.subjects.reverse();
    reversed.artifacts!.subjects.reverse();
    reversed.raw!.subjects.reverse();
    const second = buildConversationRecordMutationPlan({
      inventory: reversed,
      conversationSources: [{
        sourceRelativePath: "sessions/conversation-target"
      }],
      expectedConversationGeneration: 2,
      expectedConversationCommitId: "conversation-commit-2",
      expectedConversationContentRevision:
        `sha256:${"1".repeat(64)}`,
      targetConversation: {
        status: "deleted",
        tombstoneId: "conversation-target-deleted",
        digest: `sha256:${"2".repeat(64)}`
      },
      rootBindings: fixture.bindings
    });
    assert.deepEqual(second, first);
    assert.equal(first.executionParticipants.length, 8);
    assert.equal(first.leafRecordCount, 127);
    assert.deepEqual(
      first.requiredRootIds,
      Object.values(ECHOINK_RECORD_MUTATION_ROOT_IDS).sort(
        (left, right) => left.localeCompare(right)
      )
    );
    assert.equal(
      first.executionParticipants.every(
        (participant) => participant.execution.kind.endsWith("-bundle")
      ),
      true
    );
    const runRetain = first.executionParticipants.find(
      (participant) =>
        participant.recordKind === "workflow-run"
        && participant.execution.kind === "retain-bundle"
    );
    assert.ok(
      runRetain?.execution.kind === "retain-bundle",
      "Run retain bundle must be explicit"
    );
    assert.equal(
      runRetain.execution.rootId,
      ECHOINK_RECORD_MUTATION_ROOT_IDS.run
    );
    assert.equal(runRetain.execution.subjects.length, 80);
    assert.equal(
      runRetain.execution.subjects.every(
        (subject) =>
          subject.kind === "workflow-run-summary"
          || subject.kind === "attempt-run-summary"
      ),
      true
    );
    const rawRetain = first.executionParticipants.find(
      (participant) =>
        participant.recordKind === "raw"
        && participant.execution.kind === "retain-bundle"
    );
    assert.ok(
      rawRetain?.execution.kind === "retain-bundle",
      "Raw retain bundle must be explicit"
    );
    assert.equal(
      rawRetain.execution.rootId,
      ECHOINK_RECORD_MUTATION_ROOT_IDS.raw
    );
    const rawRetainSubject = rawRetain.execution.subjects[0];
    assert.ok(
      rawRetainSubject?.kind === "raw",
      "Raw retain subject must preserve its formal identity"
    );
    assert.equal(rawRetainSubject.rawRef, "raw/shared.txt");
    assert.equal(rawRetainSubject.sourceRelativePath, "shared.txt");
    assert.match(rawRetainSubject.ownersDigest, /^sha256:[a-f0-9]{64}$/);

    const journal = await createRecordMutationJournal({
      storageRootPath: fixture.storageRootPath,
      mutationId: "conversation-plan-deterministic",
      intent: first.intent,
      createdAt: BASE_TIME + 10_000
    });
    const plan = await createRecordMutationExecutionPlan({
      journal,
      participants: first.executionParticipants,
      createdAt: BASE_TIME + 10_001
    });
    assert.equal(plan.plan.participants.length, 8);
    assert.equal(journal.record.state, "planned");
  });
}

async function assertBlockedInventoryAndWrongRootsFailBeforeJournal():
Promise<void> {
  await withFixture("blocked", async (fixture) => {
    const blocked = readyInventory(1);
    blocked.status = "blocked";
    blocked.blockers.push({
      code: "raw-reference-missing",
      subjectId: "raw/missing.txt"
    });
    assert.throws(
      () => buildConversationRecordMutationPlan({
        inventory: blocked,
        conversationSources: [{
          sourceRelativePath: "sessions/conversation-target"
        }],
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"3".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "conversation-target-deleted",
          digest: `sha256:${"4".repeat(64)}`
        },
        rootBindings: fixture.bindings
      }),
      (error: unknown) => (
        error instanceof ConversationRecordMutationPlanError
        && error.code === "inventory_blocked"
      )
    );

    assert.throws(
      () => buildConversationRecordMutationPlan({
        inventory: readyInventory(1),
        conversationSources: [{
          sourceRelativePath: "sessions/conversation-target"
        }],
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"3".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "conversation-target-deleted",
          digest: `sha256:${"4".repeat(64)}`
        },
        rootBindings: fixture.bindings.filter(
          (binding) =>
            binding.rootId !== ECHOINK_RECORD_MUTATION_ROOT_IDS.run
        )
      }),
      (error: unknown) => (
        error instanceof ConversationRecordMutationPlanError
        && error.code === "root_mismatch"
      )
    );

    const missingSummary = readyInventory(1);
    missingSummary.run!.workflowRuns[0]!.attempts[0]!.summary = null;
    assert.throws(
      () => buildConversationRecordMutationPlan({
        inventory: missingSummary,
        conversationSources: [{
          sourceRelativePath: "sessions/conversation-target"
        }],
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"3".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "conversation-target-deleted",
          digest: `sha256:${"4".repeat(64)}`
        },
        rootBindings: fixture.bindings
      }),
      (error: unknown) => (
        error instanceof ConversationRecordMutationPlanError
        && error.code === "inventory_blocked"
      )
    );

    assert.throws(
      () => buildConversationRecordMutationPlan({
        inventory: readyInventory(1),
        conversationSources: [{
          sourceRelativePath: "sessions/conversation-other"
        }],
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"3".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "conversation-target-deleted",
          digest: `sha256:${"4".repeat(64)}`
        },
        rootBindings: fixture.bindings
      }),
      (error: unknown) => (
        error instanceof ConversationRecordMutationPlanError
        && error.code === "source_invalid"
      ),
      "delete source must belong to the target Conversation"
    );

    assert.throws(
      () => buildConversationRecordMutationPlan({
        inventory: readyInventory(1),
        conversationSources: [
          { sourceRelativePath: "sessions/conversation-target" },
          { sourceRelativePath: "sessions/conversation-target" }
        ],
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"3".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "conversation-target-deleted",
          digest: `sha256:${"4".repeat(64)}`
        },
        rootBindings: fixture.bindings
      }),
      (error: unknown) => (
        error instanceof ConversationRecordMutationPlanError
        && error.code === "source_invalid"
      )
    );

    const clearInventory = readyInventory(1);
    clearInventory.operation = "clear-conversation-records";
    const clearTarget = {
      status: "present" as const,
      generation: 3,
      commitId: "conversation-clear-commit-3",
      contentRevision: `sha256:${"5".repeat(64)}`
    };
    const clearPlan = buildConversationRecordMutationPlan({
      inventory: clearInventory,
      conversationSources: [{
        sourceRelativePath:
          `sessions/conversation-target/context-payloads/payload-${"a".repeat(64)}`
      }],
      expectedConversationGeneration: 2,
      expectedConversationCommitId: "conversation-commit-2",
      expectedConversationContentRevision:
        `sha256:${"3".repeat(64)}`,
      targetConversation: clearTarget,
      rootBindings: fixture.bindings
    });
    assert.equal(
      clearPlan.intent.operation,
      "clear-conversation-records"
    );
    assert.throws(
      () => buildConversationRecordMutationPlan({
        inventory: clearInventory,
        conversationSources: [{
          sourceRelativePath:
            `sessions/conversation-other/context-payloads/payload-${"a".repeat(64)}`
        }],
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"3".repeat(64)}`,
        targetConversation: clearTarget,
        rootBindings: fixture.bindings
      }),
      (error: unknown) => (
        error instanceof ConversationRecordMutationPlanError
        && error.code === "source_invalid"
      ),
      "clear source must belong to the target Conversation"
    );
  });
}

async function assertOversizedBundleFailsBeforeJournal(): Promise<void> {
  await withFixture("capacity", async (fixture) => {
    const inventory = readyInventory(0);
    inventory.raw!.subjects = Array.from({ length: 16_385 }, (_, index) => ({
      rawRef: `raw/retained-${index.toString().padStart(5, "0")}.txt`,
      sourceRelativePath:
        `retained-${index.toString().padStart(5, "0")}.txt`,
      action: "retain" as const,
      owners: [{
        kind: "conversation-message" as const,
        ownerId: `message-${index.toString().padStart(5, "0")}`,
        conversationId: "conversation-other"
      }]
    }));
    assert.throws(
      () => buildConversationRecordMutationPlan({
        inventory,
        conversationSources: [{
          sourceRelativePath: "sessions/conversation-target"
        }],
        expectedConversationGeneration: 2,
        expectedConversationCommitId: "conversation-commit-2",
        expectedConversationContentRevision:
          `sha256:${"5".repeat(64)}`,
        targetConversation: {
          status: "deleted",
          tombstoneId: "conversation-target-deleted",
          digest: `sha256:${"6".repeat(64)}`
        },
        rootBindings: fixture.bindings.filter(
          (binding) =>
            binding.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation
            || binding.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
        )
      }),
      (error: unknown) => (
        error instanceof ConversationRecordMutationPlanError
        && error.code === "capacity_exceeded"
      )
    );
  });
}

function readyInventory(runCount: number): ConversationRecordInventory {
  const workflowRuns = Array.from({ length: runCount }, (_, index) => {
    const suffix = index.toString().padStart(3, "0");
    const workflowRunId = `workflow-${suffix}`;
    const attemptId = `attempt-${suffix}`;
    const harnessRunId = `harness-${suffix}`;
    const events = payloadEvents(
      workflowRunId,
      attemptId,
      harnessRunId,
      BASE_TIME + index * 10
    );
    const payload = buildAttemptPayloadManifest({
      workflowRunId,
      attemptId,
      harnessRunId,
      createdAt: BASE_TIME + index * 10,
      revision: 0
    }, events);
    const attempt = finalizeAttemptRunSummary({
      schemaVersion: 1,
      recordType: "attempt-run-summary",
      workflowRunId,
      attemptId,
      ordinal: 1,
      harnessRunId,
      backendId: "codex-cli",
      nativeExecutionRecordIds: [`native-${suffix}`],
      status: "completed",
      startedAt: BASE_TIME + index * 10,
      terminalAt: BASE_TIME + index * 10 + 2,
      errorCode: "none",
      reasonCode: "none",
      localCommit: {
        state: "committed",
        authorityKind: "conversation",
        committedAt: BASE_TIME + index * 10 + 3
      },
      cleanup: {
        status: "disposed",
        attempts: 1,
        settledAt: BASE_TIME + index * 10 + 4,
        reasonCode: "cleanup-completed"
      },
      payload: {
        expected: true,
        expiresAt: payload.expiresAt
      },
      retention: {
        holdReasons: []
      },
      revision: 0
    });
    const workflow = finalizeWorkflowRunSummary({
      schemaVersion: 1,
      recordType: "workflow-run-summary",
      workflowRunId,
      surface: "chat",
      workflow: "chat.turn",
      conversationRef: {
        conversationId: "conversation-target",
        contextId: "context-target",
        turnId: `turn-${suffix}`
      },
      status: "completed",
      startedAt: BASE_TIME + index * 10,
      terminalAt: BASE_TIME + index * 10 + 4,
      attemptRefs: [{ attemptId, ordinal: 1 }],
      artifactRefs: [],
      errorCode: "none",
      localMutation: {
        state: "committed",
        transactionId: `transaction-${suffix}`,
        committedAt: BASE_TIME + index * 10 + 3
      },
      retention: {
        holdReasons: []
      },
      revision: 0
    });
    return {
      summary: workflow,
      attempts: [{
        attemptId,
        ordinal: 1,
        summary: attempt,
        payload: {
          state: "present" as const,
          manifest: payload,
          rawRefs: [],
          sourceRelativePath:
            `attempt-payloads/${workflowRunId}/generations/000000000001`
        }
      }]
    };
  });
  return {
    operation: "delete-conversation",
    conversationId: "conversation-target",
    status: "ready",
    run: {
      conversationId: "conversation-target",
      workflowRuns,
      storeRawOwners: [],
      blockers: [],
      snapshotDigest: `sha256:${"7".repeat(64)}`
    },
    memory: {
      storeState: "present",
      snapshotDigest: `sha256:${"8".repeat(64)}`,
      subjects: [{
        memoryId: "memory-formal",
        state: "formal",
        action: "mark-source-deleted"
      }, {
        memoryId: "memory-confirmation",
        state: "confirmation",
        action: "mark-source-deleted"
      }]
    },
    artifacts: {
      snapshotDigest: `sha256:${"9".repeat(64)}`,
      subjects: [{
        artifactId: "artifact-report",
        artifactKind: "markdown-report",
        action: "mark-source-deleted"
      }, {
        artifactId: "artifact-card",
        artifactKind: "ui-card",
        action: "mark-source-deleted"
      }]
    },
    raw: {
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      subjects: [
        {
          rawRef: "raw/exclusive.txt",
          sourceRelativePath: "exclusive.txt",
          action: "discard",
          owners: [{
            kind: "conversation-message",
            ownerId: "message-exclusive",
            conversationId: "conversation-target"
          }]
        },
        {
          rawRef: "raw/shared.txt",
          sourceRelativePath: "shared.txt",
          action: "retain",
          owners: [{
            kind: "conversation-message",
            ownerId: "message-shared",
            conversationId: "conversation-other"
          }]
        }
      ]
    },
    blockers: [],
    snapshotDigest: `sha256:${"b".repeat(64)}`
  };
}

function payloadEvents(
  workflowRunId: string,
  attemptId: string,
  harnessRunId: string,
  createdAt: number
): AttemptHarnessEventV1[] {
  return [
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      workflowRunId,
      attemptId,
      harnessRunId,
      eventId: `${harnessRunId}:1`,
      runId: harnessRunId,
      sequence: 1,
      createdAt,
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
      createdAt: createdAt + 2,
      source: "kernel",
      type: "run.completed"
    }
  ];
}

interface PlanFixture {
  storageRootPath: string;
  bindings: RecordRootBindingRef[];
}

async function withFixture(
  suffix: string,
  action: (fixture: PlanFixture) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-conversation-plan-${suffix}-`)
  );
  try {
    const storageRootPath = path.join(rootPath, "storage");
    await mkdir(storageRootPath);
    const bindings: RecordRootBindingRef[] = [];
    for (const rootId of Object.values(
      ECHOINK_RECORD_MUTATION_ROOT_IDS
    ).sort((left, right) => left.localeCompare(right))) {
      const physicalRoot = path.join(storageRootPath, rootId);
      await mkdir(physicalRoot);
      const binding = await createOrLoadRecordRootBinding({
        storageRootPath,
        rootId,
        rootPath: physicalRoot,
        boundaryRootPath: storageRootPath,
        authority: "plugin-owned",
        createdAt: BASE_TIME
      });
      bindings.push(recordRootBindingRef(binding.binding));
    }
    await action({ storageRootPath, bindings });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
