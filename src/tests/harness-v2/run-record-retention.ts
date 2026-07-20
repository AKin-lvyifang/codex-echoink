import * as assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  RUN_RECORD_DAY_MS,
  buildAttemptPayloadManifest,
  finalizeAttemptRunSummary,
  finalizeWorkflowRunSummary,
  type AttemptHarnessEventV1,
  type AttemptRunSummaryV1,
  type WorkflowRunSummaryV1
} from "../../harness/contracts/run-record";
import {
  executeRunRecordRetentionSweep,
  previewRunRecordRetentionSweep,
  RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY,
  runRecordRetentionSubjectKey,
  RunRecordRetentionError,
  type RunRecordRetentionHoldSnapshot,
  type RunRecordRetentionRecoveryEvidenceAuthority
} from "../../harness/ledger/run-record-retention";
import {
  FileRunRecordStore
} from "../../harness/ledger/run-record-store";

const BASE_TIME = 1_721_260_800_000;
const RETENTION_NOW = BASE_TIME + 100 * RUN_RECORD_DAY_MS;

export async function runHarnessV2RunRecordRetentionTests():
Promise<void> {
  await assertStoreMutationLaneSerializesConcurrentPublish();
  await assertOrderedSweepRecoversAfterTombstoneCrash();
  await assertRecoveryEvidenceHoldsTheWholeRun();
  await assertExecutionRejectsHoldAddedAfterPreview();
  await assertExecutionRejectsWorkflowAddedAfterPreview();
  await assertNotCapturedPayloadAllowsSummaryRetention();
}

async function assertStoreMutationLaneSerializesConcurrentPublish():
Promise<void> {
  await withFixture("mutation-lane", async (storageRootPath) => {
    const holder = new FileRunRecordStore({ storageRootPath });
    const writer = new FileRunRecordStore({ storageRootPath });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorityEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = holder.withMutation(async () => {
      entered();
      await gate;
    });
    await authorityEntered;

    let published = false;
    const summary = workflowSummary(
      "workflow-retention-lane",
      "attempt-retention-lane"
    );
    const writing = writer.writeWorkflowRunSummary(
      summary,
      emptyCas()
    ).then(() => {
      published = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(
      published,
      false,
      "a normal Run writer must queue behind Store-wide retention authority"
    );
    release();
    await Promise.all([holding, writing]);
    assert.equal(
      (await writer.readWorkflowRunSummary(summary.workflowRunId)).state,
      "present"
    );
  });
}

async function assertOrderedSweepRecoversAfterTombstoneCrash():
Promise<void> {
  await withFixture("ordered-recovery", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const recoveryEvidenceAuthority = mutableRecoveryEvidenceAuthority();
    const workflow = workflowSummary(
      "workflow-retention-ordered",
      "attempt-retention-ordered"
    );
    const attempt = attemptSummary(
      workflow.workflowRunId,
      workflow.attemptRefs[0].attemptId,
      "harness-retention-ordered"
    );
    const events = payloadEvents(attempt);
    const payload = buildAttemptPayloadManifest({
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId,
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.writeWorkflowRunSummary(workflow, emptyCas());
    await store.writeAttemptRunSummary(attempt, emptyCas());
    await store.sealAttemptPayload(payload, events, emptyCas());

    const plan = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-ordered-recovery",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority
    });
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.automaticActionAllowed, true);
    assert.deepEqual(
      plan.actions.map((action) => action.tombstone.scope),
      ["attempt-payload", "attempt-summary", "workflow-summary"]
    );
    assert.deepEqual(
      plan.actions.map((action) => action.ordinal),
      [0, 1, 2]
    );

    let crashed = false;
    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan,
        recoveryEvidenceAuthority,
        faultInjector: (point, ordinal) => {
          if (
            !crashed
            && point === "after-tombstone-publish"
            && ordinal === 0
          ) {
            crashed = true;
            throw new Error("simulated retention crash");
          }
        }
      }),
      /simulated retention crash/
    );
    assert.equal(
      (await store.readAttemptPayload(attempt)).state,
      "expired",
      "payload tombstone must remain durable across the crash"
    );
    assert.equal(
      (await store.readAttemptRunSummary(attempt)).state,
      "present"
    );

    assert.deepEqual(
      await executeRunRecordRetentionSweep({
        storageRootPath,
        plan,
        recoveryEvidenceAuthority
      }),
      {
        transactionId: plan.transactionId,
        planDigest: plan.digest,
        applied: 3,
        total: 3,
        state: "completed"
      }
    );
    assert.equal(
      (await store.readAttemptPayload(attempt)).state,
      "expired"
    );
    assert.equal(
      (await store.readAttemptRunSummary(attempt)).state,
      "expired"
    );
    assert.equal(
      (await store.readWorkflowRunSummary(workflow.workflowRunId)).state,
      "expired"
    );
    assert.deepEqual(
      (await store.inventoryRunRecords()).blockers,
      []
    );

    const replay = await executeRunRecordRetentionSweep({
      storageRootPath,
      plan,
      recoveryEvidenceAuthority
    });
    assert.equal(replay.state, "completed");
    assert.equal(replay.applied, 3);
    const transactionRoot = path.join(
      storageRootPath,
      RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY
    );
    const chains = (await readdir(transactionRoot))
      .filter((entry) => entry !== ".staging");
    assert.equal(chains.length, 1);
    const entries = await readdir(path.join(transactionRoot, chains[0]));
    assert.deepEqual(
      entries.sort(),
      [
        "plan.json",
        "step-000000.json",
        "step-000001.json",
        "step-000002.json"
      ]
    );
  });
}

async function assertRecoveryEvidenceHoldsTheWholeRun():
Promise<void> {
  await withFixture("holds", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const workflow = workflowSummary(
      "workflow-retention-held",
      "attempt-retention-held"
    );
    const attempt = attemptSummary(
      workflow.workflowRunId,
      workflow.attemptRefs[0].attemptId,
      "harness-retention-held"
    );
    const events = payloadEvents(attempt);
    const payload = buildAttemptPayloadManifest({
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId,
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.writeWorkflowRunSummary(workflow, emptyCas());
    await store.writeAttemptRunSummary(attempt, emptyCas());
    await store.sealAttemptPayload(payload, events, emptyCas());

    const payloadKey = runRecordRetentionSubjectKey({
      scope: "attempt-payload",
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId
    });
    const recoveryEvidenceAuthority = mutableRecoveryEvidenceAuthority({
      [payloadKey]: ["wal-present"]
    });
    const plan = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-held-by-wal",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority
    });
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.automaticActionAllowed, false);
    assert.deepEqual(
      plan.subjects.map((subject) => subject.decision),
      ["held", "held", "held"]
    );
    assert.ok(
      plan.subjects.every((subject) =>
        subject.holdReasons.includes("wal-present")
      )
    );
    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan,
        recoveryEvidenceAuthority
      }),
      (error) =>
        error instanceof RunRecordRetentionError
        && error.code === "inventory-blocked"
    );
    assert.equal(
      (await store.readAttemptPayload(attempt)).state,
      "present"
    );
  });
}

async function assertExecutionRejectsHoldAddedAfterPreview():
Promise<void> {
  await withFixture("hold-drift", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const workflow = workflowSummary(
      "workflow-retention-hold-drift",
      "attempt-retention-hold-drift"
    );
    const attempt = attemptSummary(
      workflow.workflowRunId,
      workflow.attemptRefs[0].attemptId,
      "harness-retention-hold-drift"
    );
    const events = payloadEvents(attempt);
    const payload = buildAttemptPayloadManifest({
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId,
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.writeWorkflowRunSummary(workflow, emptyCas());
    await store.writeAttemptRunSummary(attempt, emptyCas());
    await store.sealAttemptPayload(payload, events, emptyCas());

    const recoveryEvidenceAuthority = mutableRecoveryEvidenceAuthority();
    const plan = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-hold-drift",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority
    });
    assert.equal(plan.automaticActionAllowed, true);

    const payloadKey = runRecordRetentionSubjectKey({
      scope: "attempt-payload",
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId
    });
    recoveryEvidenceAuthority.setHolds({
      [payloadKey]: ["wal-present"]
    });

    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan,
        recoveryEvidenceAuthority
      }),
      (error) =>
        error instanceof RunRecordRetentionError
        && error.code === "plan-conflict"
        && /hold or eligibility changed/.test(error.message)
    );
    assert.equal(
      (await store.readAttemptPayload(attempt)).state,
      "present"
    );
    assert.equal(
      (await store.readAttemptRunSummary(attempt)).state,
      "present"
    );
    assert.equal(
      (await store.readWorkflowRunSummary(workflow.workflowRunId)).state,
      "present"
    );
  });
}

async function assertExecutionRejectsWorkflowAddedAfterPreview():
Promise<void> {
  await withFixture("subject-drift", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const recoveryEvidenceAuthority = mutableRecoveryEvidenceAuthority();
    const originalWorkflow = workflowSummary(
      "workflow-retention-original",
      "attempt-retention-original"
    );
    const originalAttempt = attemptSummary(
      originalWorkflow.workflowRunId,
      originalWorkflow.attemptRefs[0].attemptId,
      "harness-retention-original"
    );
    const originalEvents = payloadEvents(originalAttempt);
    const originalPayload = buildAttemptPayloadManifest({
      workflowRunId: originalAttempt.workflowRunId,
      attemptId: originalAttempt.attemptId,
      harnessRunId: originalAttempt.harnessRunId,
      createdAt: BASE_TIME,
      revision: 0
    }, originalEvents);
    await store.writeWorkflowRunSummary(originalWorkflow, emptyCas());
    await store.writeAttemptRunSummary(originalAttempt, emptyCas());
    await store.sealAttemptPayload(
      originalPayload,
      originalEvents,
      emptyCas()
    );

    const plan = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-subject-drift",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority
    });
    assert.equal(plan.automaticActionAllowed, true);

    const addedWorkflow = workflowSummary(
      "workflow-retention-added",
      "attempt-retention-added"
    );
    const addedAttempt = attemptSummary(
      addedWorkflow.workflowRunId,
      addedWorkflow.attemptRefs[0].attemptId,
      "harness-retention-added"
    );
    const addedEvents = payloadEvents(addedAttempt);
    const addedPayload = buildAttemptPayloadManifest({
      workflowRunId: addedAttempt.workflowRunId,
      attemptId: addedAttempt.attemptId,
      harnessRunId: addedAttempt.harnessRunId,
      createdAt: BASE_TIME,
      revision: 0
    }, addedEvents);
    await store.writeWorkflowRunSummary(addedWorkflow, emptyCas());
    await store.writeAttemptRunSummary(addedAttempt, emptyCas());
    await store.sealAttemptPayload(addedPayload, addedEvents, emptyCas());

    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan,
        recoveryEvidenceAuthority
      }),
      (error) =>
        error instanceof RunRecordRetentionError
        && error.code === "plan-conflict"
        && /subject set changed/.test(error.message)
    );
    assert.equal(
      (await store.readAttemptPayload(originalAttempt)).state,
      "present"
    );
    assert.equal(
      (await store.readAttemptPayload(addedAttempt)).state,
      "present"
    );
  });
}

async function assertNotCapturedPayloadAllowsSummaryRetention():
Promise<void> {
  await withFixture("not-captured", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const recoveryEvidenceAuthority = mutableRecoveryEvidenceAuthority();
    const workflow = workflowSummary(
      "workflow-retention-not-captured",
      "attempt-retention-not-captured"
    );
    const attempt = attemptSummary(
      workflow.workflowRunId,
      workflow.attemptRefs[0].attemptId,
      "harness-retention-not-captured",
      false
    );
    await store.writeWorkflowRunSummary(workflow, emptyCas());
    await store.writeAttemptRunSummary(attempt, emptyCas());
    await store.markAttemptPayloadNotCaptured({
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId,
      reasonCode: "capture-disabled",
      recordedAt: BASE_TIME + 500,
      revision: 0
    }, emptyCas());

    const plan = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-not-captured",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority
    });
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(
      plan.actions.map((action) => action.tombstone.scope),
      ["attempt-summary", "workflow-summary"]
    );
    await executeRunRecordRetentionSweep({
      storageRootPath,
      plan,
      recoveryEvidenceAuthority
    });
    assert.equal(
      (await store.readAttemptPayload(attempt)).state,
      "not-captured"
    );
    assert.equal(
      (await store.readAttemptRunSummary(attempt)).state,
      "expired"
    );
    assert.equal(
      (await store.readWorkflowRunSummary(workflow.workflowRunId)).state,
      "expired"
    );
  });
}

function workflowSummary(
  workflowRunId: string,
  attemptId: string
): WorkflowRunSummaryV1 {
  return finalizeWorkflowRunSummary({
    schemaVersion: 1,
    recordType: "workflow-run-summary",
    workflowRunId,
    surface: "knowledge",
    workflow: "knowledge.ask",
    conversationRef: {
      conversationId: `conversation-${workflowRunId}`
    },
    status: "completed",
    startedAt: BASE_TIME,
    terminalAt: BASE_TIME + 400,
    attemptRefs: [{ attemptId, ordinal: 1 }],
    artifactRefs: [],
    localMutation: {
      state: "committed",
      transactionId: `commit-${workflowRunId}`,
      committedAt: BASE_TIME + 500
    },
    retention: {
      summaryExpiresAt:
        BASE_TIME + 400 + 90 * RUN_RECORD_DAY_MS,
      holdReasons: []
    },
    revision: 0
  });
}

function attemptSummary(
  workflowRunId: string,
  attemptId: string,
  harnessRunId: string,
  payloadExpected = true
): AttemptRunSummaryV1 {
  return finalizeAttemptRunSummary({
    schemaVersion: 1,
    recordType: "attempt-run-summary",
    workflowRunId,
    attemptId,
    ordinal: 1,
    harnessRunId,
    backendId: "codex-cli",
    nativeExecutionRecordIds: ["native-retention"],
    status: "completed",
    startedAt: BASE_TIME + 100,
    terminalAt: BASE_TIME + 400,
    localCommit: {
      state: "committed",
      authorityKind: "conversation",
      committedAt: BASE_TIME + 500
    },
    cleanup: {
      status: "disposed",
      attempts: 1,
      settledAt: BASE_TIME + 600,
      reasonCode: "cleanup-completed"
    },
    payload: {
      expected: payloadExpected,
      ...(payloadExpected
        ? { expiresAt: BASE_TIME + 400 + 30 * RUN_RECORD_DAY_MS }
        : {})
    },
    retention: {
      summaryExpiresAt:
        BASE_TIME + 400 + 90 * RUN_RECORD_DAY_MS,
      holdReasons: []
    },
    revision: 0
  });
}

function payloadEvents(
  attempt: AttemptRunSummaryV1
): AttemptHarnessEventV1[] {
  return [
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId,
      eventId: `${attempt.harnessRunId}:1`,
      runId: attempt.harnessRunId,
      sequence: 1,
      createdAt: BASE_TIME,
      source: "kernel",
      type: "run.created"
    },
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId,
      eventId: `${attempt.harnessRunId}:2`,
      runId: attempt.harnessRunId,
      sequence: 2,
      createdAt: BASE_TIME + 100,
      source: "kernel",
      type: "run.completed",
      text: "complete"
    },
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId,
      harnessRunId: attempt.harnessRunId,
      eventId: `${attempt.harnessRunId}:3`,
      runId: attempt.harnessRunId,
      sequence: 3,
      createdAt: BASE_TIME + 200,
      source: "workflow",
      type: "run.local_commit.completed"
    }
  ];
}

function emptyCas(): {
  expectedRevision: null;
  expectedDigest: null;
} {
  return {
    expectedRevision: null,
    expectedDigest: null
  };
}

function mutableRecoveryEvidenceAuthority(
  initial: RunRecordRetentionHoldSnapshot = {}
): RunRecordRetentionRecoveryEvidenceAuthority & {
  setHolds(holds: RunRecordRetentionHoldSnapshot): void;
} {
  let current = initial;
  return {
    setHolds(holds) {
      current = holds;
    },
    async withStableHolds(action) {
      return await action(current);
    }
  };
}

async function withFixture(
  label: string,
  action: (storageRootPath: string) => Promise<void>
): Promise<void> {
  const storageRootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-run-retention-${label}-`)
  );
  try {
    await action(storageRootPath);
  } finally {
    await rm(storageRootPath, { recursive: true, force: true });
  }
}

if (process.env.ECHOINK_RUN_RUN_RECORD_RETENTION_TEST === "1") {
  runHarnessV2RunRecordRetentionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
