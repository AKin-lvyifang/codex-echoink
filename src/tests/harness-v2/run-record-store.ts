import * as assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  RUN_RECORD_DAY_MS,
  RunRecordContractError,
  buildAttemptPayloadManifest,
  finalizeAttemptRunSummary,
  finalizeRetentionTombstone,
  finalizeWorkflowRunSummary,
  previewRunRecordRetention,
  safeRunRecordToken,
  validateAttemptPayloadManifest,
  validateAttemptRunSummary,
  validateRetentionTombstone,
  validateWorkflowRunSummary,
  type AttemptPayloadManifestV1,
  type AttemptHarnessEventV1,
  type AttemptRunSummaryV1,
  type WorkflowRunSummaryV1
} from "../../harness/contracts/run-record";
import {
  FileRunRecordStore,
  RunRecordStoreConflictError,
  RunRecordStoreSimulatedCrash,
  attemptRunRecordSubjectToken
} from "../../harness/ledger/run-record-store";

const BASE_TIME = 1_721_260_800_000;

export async function runHarnessV2RunRecordStoreTests(): Promise<void> {
  assertStrictV1ContractsAndCanonicalDigests();
  assertSafeTokensDoNotCollapseSanitizedIds();
  assertRetentionBoundariesAndHoldsArePure();
  await assertSummaryCasAndRoundTrip();
  await assertSummaryTransitionsAreMonotonic();
  await assertAttemptIdsAreScopedToWorkflowRuns();
  await assertAttemptPayloadAvailabilityStates();
  await assertMissingPayloadCannotBecomeExpired();
  await assertPayloadCorruptionIsDistinctFromMissing();
  await assertPayloadSafeReadRejectsSymlink();
  await assertAtomicGenerationCrashWindows();
}

function assertStrictV1ContractsAndCanonicalDigests(): void {
  const workflow = workflowSummary(0);
  assert.deepEqual(validateWorkflowRunSummary(workflow), workflow);
  assert.match(workflow.digest, /^sha256:[a-f0-9]{64}$/);

  const reordered = finalizeWorkflowRunSummary({
    recordType: "workflow-run-summary",
    schemaVersion: 1,
    workflowRunId: workflow.workflowRunId,
    surface: workflow.surface,
    workflow: workflow.workflow,
    conversationRef: {
      conversationId: "conversation-a",
      contextId: "context-a",
      turnId: "turn-a"
    },
    status: workflow.status,
    startedAt: workflow.startedAt,
    terminalAt: workflow.terminalAt,
    usage: {
      outputTokens: 13,
      inputTokens: 21,
      totalTokens: 34
    },
    attemptRefs: [{ attemptId: "attempt-a", ordinal: 1 }],
    artifactRefs: [{ artifactId: "artifact-a", kind: "markdown-report" }],
    errorCode: "none",
    localMutation: {
      state: "committed",
      transactionId: "transaction-a",
      committedAt: BASE_TIME + 500
    },
    retention: {
      summaryExpiresAt: BASE_TIME + 500 + 90 * RUN_RECORD_DAY_MS,
      holdReasons: []
    },
    revision: 0
  });
  assert.equal(reordered.digest, workflow.digest, "object key order must not affect canonical digest");

  const attempt = attemptSummary(0);
  assert.deepEqual(validateAttemptRunSummary(attempt), attempt);
  assert.match(attempt.digest, /^sha256:[a-f0-9]{64}$/);

  const events = payloadEvents("workflow-a", "attempt-a", "harness-a");
  const payload = buildAttemptPayloadManifest({
    workflowRunId: "workflow-a",
    attemptId: "attempt-a",
    harnessRunId: "harness-a",
    createdAt: BASE_TIME + 100,
    revision: 0
  }, events);
  assert.deepEqual(validateAttemptPayloadManifest(payload), payload);
  assert.equal(payload.eventCount, 3);
  assert.equal(payload.firstSequence, 1);
  assert.equal(payload.lastSequence, 3);
  assert.equal(payload.terminalAt, BASE_TIME + 100);
  assert.equal(payload.expiresAt, payload.terminalAt + 30 * RUN_RECORD_DAY_MS);

  const tombstone = finalizeRetentionTombstone({
    schemaVersion: 1,
    recordType: "run-retention-tombstone",
    scope: "attempt-payload",
    workflowRunId: "workflow-a",
    attemptId: "attempt-a",
    harnessRunId: "harness-a",
    subjectDigest: payload.subjectDigest,
    reasonCode: "policy-expired",
    eligibleAt: payload.expiresAt,
    expiredAt: payload.expiresAt,
    prior: {
      schemaVersion: 1,
      digest: payload.digest,
      eventCount: payload.eventCount,
      byteCount: payload.byteCount,
      terminalAt: payload.terminalAt
    },
    policy: {
      version: 1,
      retentionDays: 30
    },
    retentionTransactionId: "retention-a",
    committedAt: payload.expiresAt + 1,
    revision: 1
  });
  assert.deepEqual(validateRetentionTombstone(tombstone), tombstone);
  assert.match(tombstone.digest, /^sha256:[a-f0-9]{64}$/);

  assertContractCode(
    () => validateWorkflowRunSummary({ ...workflow, schemaVersion: 2 }),
    "future-schema"
  );
  assertContractCode(
    () => validateWorkflowRunSummary({ ...workflow, unknownField: true }),
    "unexpected-field"
  );
  assertContractCode(
    () => validateWorkflowRunSummary({
      ...workflow,
      conversationRef: {
        conversationId: "conversation-a",
        backendThreadId: "must-not-enter-summary"
      }
    }),
    "unexpected-field"
  );
  assertContractCode(
    () => validateWorkflowRunSummary({ ...workflow, errorCode: "free-form-error" }),
    "invalid-value"
  );
  assertContractCode(
    () => buildAttemptPayloadManifest({
      workflowRunId: "workflow-a",
      attemptId: "attempt-a",
      harnessRunId: "harness-a",
      createdAt: BASE_TIME,
      revision: 0
    }, [
      events[0],
      {
        ...events[2],
        eventId: "harness-a:pre-terminal",
        sequence: 2,
        createdAt: BASE_TIME + 50
      },
      {
        ...events[1],
        eventId: "harness-a:terminal-last",
        sequence: 3
      }
    ]),
    "invalid-value"
  );
  assertContractCode(
    () => validateAttemptRunSummary({ ...attempt, reasonCode: "arbitrary-reason" }),
    "invalid-value"
  );
  assertContractCode(
    () => validateAttemptPayloadManifest({ ...payload, digest: `sha256:${"0".repeat(64)}` }),
    "digest-mismatch"
  );
  assertContractCode(
    () => buildAttemptPayloadManifest({
      workflowRunId: "workflow-a",
      attemptId: "attempt-a",
      harnessRunId: "harness-a",
      createdAt: BASE_TIME,
      revision: 0
    }, events.slice(0, 1)),
    "invalid-value"
  );
  assertContractCode(
    () => buildAttemptPayloadManifest({
      workflowRunId: "workflow-a",
      attemptId: "attempt-a",
      harnessRunId: "harness-a",
      createdAt: BASE_TIME,
      revision: 0
    }, [
      events[0],
      events[1],
      { ...events[2], type: "workflow.started" }
    ]),
    "invalid-value"
  );
  assertContractCode(
    () => buildAttemptPayloadManifest({
      workflowRunId: "workflow-a",
      attemptId: "attempt-a",
      harnessRunId: "harness-a",
      createdAt: BASE_TIME,
      revision: 0
    }, [events[1], events[0]]),
    "invalid-value"
  );
  assertContractCode(
    () => validateRetentionTombstone({ ...tombstone, schemaVersion: 2 }),
    "future-schema"
  );
  assertContractCode(
    () => validateRetentionTombstone({ ...tombstone, note: "not-allowed" }),
    "unexpected-field"
  );

  const { digest: _workflowDigest, ...workflowInput } = workflow;
  assertContractCode(
    () => finalizeWorkflowRunSummary({
      ...workflowInput,
      status: "running"
    }),
    "invalid-value"
  );
  const { digest: _attemptDigest, ...attemptInput } = attempt;
  assertContractCode(
    () => finalizeAttemptRunSummary({
      ...attemptInput,
      status: "completed",
      terminalAt: undefined
    }),
    "invalid-value"
  );
}

function assertSafeTokensDoNotCollapseSanitizedIds(): void {
  const left = safeRunRecordToken("run/a");
  const right = safeRunRecordToken("run?a");
  assert.notEqual(left, right);
  assert.match(left, /^[a-z0-9._-]+-[a-f0-9]{64}$/);
  assert.match(right, /^[a-z0-9._-]+-[a-f0-9]{64}$/);
  assert.equal(left.includes("/"), false);
  assert.equal(right.includes("?"), false);
}

function assertRetentionBoundariesAndHoldsArePure(): void {
  const payloadExpiry = BASE_TIME + 30 * RUN_RECORD_DAY_MS;
  assert.deepEqual(
    previewRunRecordRetention({
      scope: "attempt-payload",
      terminalAt: BASE_TIME,
      now: payloadExpiry - 1,
      holdReasons: []
    }),
    {
      decision: "retained",
      eligible: false,
      expiresAt: payloadExpiry,
      holdReasons: []
    }
  );
  assert.equal(previewRunRecordRetention({
    scope: "attempt-payload",
    terminalAt: BASE_TIME,
    now: payloadExpiry,
    holdReasons: []
  }).eligible, true);
  assert.equal(previewRunRecordRetention({
    scope: "attempt-payload",
    terminalAt: BASE_TIME,
    now: payloadExpiry + 1,
    holdReasons: []
  }).eligible, true);

  const summaryExpiry = BASE_TIME + 90 * RUN_RECORD_DAY_MS;
  assert.equal(previewRunRecordRetention({
    scope: "workflow-summary",
    terminalAt: BASE_TIME,
    now: summaryExpiry - 1,
    holdReasons: []
  }).eligible, false);
  assert.equal(previewRunRecordRetention({
    scope: "workflow-summary",
    terminalAt: BASE_TIME,
    now: summaryExpiry,
    holdReasons: []
  }).eligible, true);

  assert.deepEqual(
    previewRunRecordRetention({
      scope: "attempt-payload",
      terminalAt: BASE_TIME,
      now: payloadExpiry + 1,
      holdReasons: ["cleanup-quarantined", "wal-present", "wal-present"]
    }),
    {
      decision: "held",
      eligible: false,
      expiresAt: payloadExpiry,
      holdReasons: ["cleanup-quarantined", "wal-present"]
    }
  );
  assert.equal(previewRunRecordRetention({
    scope: "attempt-payload",
    now: payloadExpiry,
    holdReasons: []
  }).decision, "not-terminal");
  assert.equal(previewRunRecordRetention({
    scope: "attempt-payload",
    terminalAt: BASE_TIME,
    retentionDays: 0,
    now: payloadExpiry,
    holdReasons: []
  }).decision, "forever");
}

async function assertSummaryCasAndRoundTrip(): Promise<void> {
  await withFixture("summary-cas", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const firstWorkflow = workflowSummary(0);
    await store.writeWorkflowRunSummary(firstWorkflow, {
      expectedRevision: null,
      expectedDigest: null
    });
    assert.deepEqual(await store.readWorkflowRunSummary(firstWorkflow.workflowRunId), {
      state: "present",
      record: firstWorkflow
    });

    await assert.rejects(
      () => store.writeWorkflowRunSummary(workflowSummary(1), {
        expectedRevision: null,
        expectedDigest: null
      }),
      RunRecordStoreConflictError
    );

    const secondWorkflow = workflowSummary(1);
    await store.writeWorkflowRunSummary(secondWorkflow, {
      expectedRevision: 0,
      expectedDigest: firstWorkflow.digest
    });
    assert.deepEqual(await store.readWorkflowRunSummary(firstWorkflow.workflowRunId), {
      state: "present",
      record: secondWorkflow
    });
    const { digest: _secondDigest, ...secondInput } = secondWorkflow;
    const regressedWorkflow = finalizeWorkflowRunSummary({
      ...secondInput,
      status: "running",
      terminalAt: undefined,
      revision: 2
    });
    await assert.rejects(
      () => store.writeWorkflowRunSummary(regressedWorkflow, {
        expectedRevision: secondWorkflow.revision,
        expectedDigest: secondWorkflow.digest
      }),
      RunRecordStoreConflictError
    );

    const attempt = attemptSummary(0);
    await store.writeAttemptRunSummary(attempt, {
      expectedRevision: null,
      expectedDigest: null
    });
    assert.deepEqual(await store.readAttemptRunSummary({
      workflowRunId: attempt.workflowRunId,
      attemptId: attempt.attemptId
    }), {
      state: "present",
      record: attempt
    });
    const { digest: _attemptDigest, ...attemptInput } = attempt;
    const changedHarnessIdentity = finalizeAttemptRunSummary({
      ...attemptInput,
      harnessRunId: "harness-replaced",
      revision: 1
    });
    await assert.rejects(
      () => store.writeAttemptRunSummary(changedHarnessIdentity, {
        expectedRevision: attempt.revision,
        expectedDigest: attempt.digest
      }),
      RunRecordStoreConflictError
    );

    const concurrentBase = workflowSummary(0, "workflow-concurrent");
    const { digest: _baseDigest, ...concurrentInput } = concurrentBase;
    const left = finalizeWorkflowRunSummary({
      ...concurrentInput,
      workflow: "knowledge.left"
    });
    const right = finalizeWorkflowRunSummary({
      ...concurrentInput,
      workflow: "knowledge.right"
    });
    const results = await Promise.allSettled([
      store.writeWorkflowRunSummary(left, {
        expectedRevision: null,
        expectedDigest: null
      }),
      store.writeWorkflowRunSummary(right, {
        expectedRevision: null,
        expectedDigest: null
      })
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
      "concurrent CAS create must have exactly one manifest winner"
    );
    assert.equal(
      results.filter((result) =>
        result.status === "rejected"
        && result.reason instanceof RunRecordStoreConflictError
      ).length,
      1
    );
    const concurrentRead = await store.readWorkflowRunSummary(
      "workflow-concurrent"
    );
    assert.equal(concurrentRead.state, "present");
    if (concurrentRead.state !== "present") {
      throw new Error("expected concurrent manifest winner");
    }
    assert.ok(
      concurrentRead.record.digest === left.digest
      || concurrentRead.record.digest === right.digest
    );
  });
}

async function assertSummaryTransitionsAreMonotonic(): Promise<void> {
  await withFixture("summary-transition-matrix", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });

    const recoveryWorkflow = reviseWorkflow(
      workflowSummary(0, "workflow-recovery"),
      0,
      { status: "recovery-required" }
    );
    await store.writeWorkflowRunSummary(recoveryWorkflow, {
      expectedRevision: null,
      expectedDigest: null
    });
    const recoveredWorkflow = reviseWorkflow(recoveryWorkflow, 1, {
      status: "completed"
    });
    await store.writeWorkflowRunSummary(recoveredWorkflow, {
      expectedRevision: recoveryWorkflow.revision,
      expectedDigest: recoveryWorkflow.digest
    });

    const blockedWorkflow = reviseWorkflow(
      workflowSummary(0, "workflow-recovery-blocked"),
      0,
      { status: "recovery-required" }
    );
    await store.writeWorkflowRunSummary(blockedWorkflow, {
      expectedRevision: null,
      expectedDigest: null
    });
    await assert.rejects(
      () => store.writeWorkflowRunSummary(
        reviseWorkflow(blockedWorkflow, 1, {
          status: "running",
          terminalAt: undefined
        }),
        {
          expectedRevision: blockedWorkflow.revision,
          expectedDigest: blockedWorkflow.digest
        }
      ),
      RunRecordStoreConflictError,
      "recovery-required workflow cannot return to running"
    );

    const terminalWorkflow = workflowSummary(0, "workflow-monotonic");
    await store.writeWorkflowRunSummary(terminalWorkflow, {
      expectedRevision: null,
      expectedDigest: null
    });
    const rejectWorkflow = async (
      candidate: WorkflowRunSummaryV1,
      message: string
    ): Promise<void> => {
      await assert.rejects(
        () => store.writeWorkflowRunSummary(candidate, {
          expectedRevision: terminalWorkflow.revision,
          expectedDigest: terminalWorkflow.digest
        }),
        RunRecordStoreConflictError,
        message
      );
    };
    await rejectWorkflow(
      reviseWorkflow(terminalWorkflow, 1, {
        localMutation: {
          ...terminalWorkflow.localMutation,
          state: "pending"
        }
      }),
      "committed local mutation cannot regress to pending"
    );
    await rejectWorkflow(
      reviseWorkflow(terminalWorkflow, 1, {
        localMutation: {
          ...terminalWorkflow.localMutation,
          transactionId: "transaction-replaced"
        }
      }),
      "local mutation identity cannot be replaced"
    );
    await rejectWorkflow(
      reviseWorkflow(terminalWorkflow, 1, { attemptRefs: [] }),
      "attemptRefs cannot be removed"
    );
    await rejectWorkflow(
      reviseWorkflow(terminalWorkflow, 1, { artifactRefs: [] }),
      "artifactRefs cannot be removed"
    );
    await rejectWorkflow(
      reviseWorkflow(terminalWorkflow, 1, { errorCode: "unknown" }),
      "terminal Workflow business fields cannot be replaced"
    );

    const recoveryAttempt = reviseAttempt(
      attemptSummary(
        0,
        "workflow-attempt-recovery",
        "attempt-recovery",
        "harness-recovery"
      ),
      0,
      { status: "recovery-required" }
    );
    await store.writeAttemptRunSummary(recoveryAttempt, {
      expectedRevision: null,
      expectedDigest: null
    });
    const recoveredAttempt = reviseAttempt(recoveryAttempt, 1, {
      status: "completed"
    });
    await store.writeAttemptRunSummary(recoveredAttempt, {
      expectedRevision: recoveryAttempt.revision,
      expectedDigest: recoveryAttempt.digest
    });

    const blockedAttempt = reviseAttempt(
      attemptSummary(
        0,
        "workflow-attempt-blocked",
        "attempt-blocked",
        "harness-blocked"
      ),
      0,
      { status: "recovery-required" }
    );
    await store.writeAttemptRunSummary(blockedAttempt, {
      expectedRevision: null,
      expectedDigest: null
    });
    await assert.rejects(
      () => store.writeAttemptRunSummary(
        reviseAttempt(blockedAttempt, 1, {
          status: "running",
          terminalAt: undefined
        }),
        {
          expectedRevision: blockedAttempt.revision,
          expectedDigest: blockedAttempt.digest
        }
      ),
      RunRecordStoreConflictError,
      "recovery-required attempt cannot return to running"
    );

    const terminalAttempt = reviseAttempt(
      attemptSummary(
        0,
        "workflow-attempt-monotonic",
        "attempt-monotonic",
        "harness-monotonic"
      ),
      0,
      {
        payload: {
          ...attemptSummary(0).payload,
          manifestRef: "manifest-a"
        }
      }
    );
    await store.writeAttemptRunSummary(terminalAttempt, {
      expectedRevision: null,
      expectedDigest: null
    });
    const rejectAttempt = async (
      candidate: AttemptRunSummaryV1,
      message: string
    ): Promise<void> => {
      await assert.rejects(
        () => store.writeAttemptRunSummary(candidate, {
          expectedRevision: terminalAttempt.revision,
          expectedDigest: terminalAttempt.digest
        }),
        RunRecordStoreConflictError,
        message
      );
    };
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, {
        localCommit: {
          ...terminalAttempt.localCommit,
          state: "pending"
        }
      }),
      "committed local commit cannot regress to pending"
    );
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, {
        cleanup: {
          ...terminalAttempt.cleanup,
          status: "pending"
        }
      }),
      "disposed cleanup cannot regress to pending"
    );
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, {
        cleanup: {
          ...terminalAttempt.cleanup,
          attempts: terminalAttempt.cleanup.attempts - 1
        }
      }),
      "cleanup attempts cannot decrease"
    );
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, {
        cleanup: {
          ...terminalAttempt.cleanup,
          settledAt: (terminalAttempt.cleanup.settledAt as number) + 1
        }
      }),
      "cleanup settledAt cannot be replaced"
    );
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, {
        payload: {
          ...terminalAttempt.payload,
          expected: false
        }
      }),
      "payload expected flag cannot change"
    );
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, {
        payload: {
          ...terminalAttempt.payload,
          manifestRef: "manifest-b"
        }
      }),
      "payload identity cannot be replaced"
    );
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, {
        nativeExecutionRecordIds: []
      }),
      "native execution ids cannot be removed"
    );
    await rejectAttempt(
      reviseAttempt(terminalAttempt, 1, { reasonCode: "manual-review" }),
      "terminal Attempt business fields cannot be replaced"
    );

    const retryAttempt = reviseAttempt(
      attemptSummary(
        0,
        "workflow-cleanup-retry",
        "attempt-cleanup-retry",
        "harness-cleanup-retry"
      ),
      0,
      {
        cleanup: {
          status: "pending",
          attempts: 2,
          nextAttemptAt: BASE_TIME + 700,
          reasonCode: "cleanup-failed"
        }
      }
    );
    await store.writeAttemptRunSummary(retryAttempt, {
      expectedRevision: null,
      expectedDigest: null
    });
    await assert.rejects(
      () => store.writeAttemptRunSummary(
        reviseAttempt(retryAttempt, 1, {
          cleanup: {
            ...retryAttempt.cleanup,
            nextAttemptAt: (retryAttempt.cleanup.nextAttemptAt as number) - 1
          }
        }),
        {
          expectedRevision: retryAttempt.revision,
          expectedDigest: retryAttempt.digest
        }
      ),
      RunRecordStoreConflictError,
      "cleanup nextAttemptAt cannot move backwards"
    );

    const appendedAttempt = reviseAttempt(terminalAttempt, 1, {
      nativeExecutionRecordIds: [
        ...terminalAttempt.nativeExecutionRecordIds,
        "native-b"
      ]
    });
    await store.writeAttemptRunSummary(appendedAttempt, {
      expectedRevision: terminalAttempt.revision,
      expectedDigest: terminalAttempt.digest
    });
    assert.deepEqual(await store.readAttemptRunSummary(appendedAttempt), {
      state: "present",
      record: appendedAttempt
    });
  });
}

async function assertAttemptIdsAreScopedToWorkflowRuns(): Promise<void> {
  await withFixture("attempt-workflow-scope", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const sharedAttemptId = "attempt-shared";
    const leftLocator = {
      workflowRunId: "workflow-left",
      attemptId: sharedAttemptId
    };
    const rightLocator = {
      workflowRunId: "workflow-right",
      attemptId: sharedAttemptId
    };
    assert.notEqual(
      attemptRunRecordSubjectToken(leftLocator),
      attemptRunRecordSubjectToken(rightLocator),
      "subject tokens must retain the workflow-scoped attempt identity"
    );

    const leftSummary = attemptSummary(
      0,
      leftLocator.workflowRunId,
      leftLocator.attemptId,
      "harness-left"
    );
    const rightSummary = attemptSummary(
      0,
      rightLocator.workflowRunId,
      rightLocator.attemptId,
      "harness-right"
    );
    await store.writeAttemptRunSummary(leftSummary, {
      expectedRevision: null,
      expectedDigest: null
    });
    await store.writeAttemptRunSummary(rightSummary, {
      expectedRevision: null,
      expectedDigest: null
    });
    assert.deepEqual(await store.readAttemptRunSummary(leftLocator), {
      state: "present",
      record: leftSummary
    });
    assert.deepEqual(await store.readAttemptRunSummary(rightLocator), {
      state: "present",
      record: rightSummary
    });

    await store.markAttemptPayloadNotCaptured({
      ...leftLocator,
      harnessRunId: "harness-left",
      reasonCode: "failed-before-payload",
      recordedAt: BASE_TIME,
      revision: 0
    }, {
      expectedRevision: null,
      expectedDigest: null
    });
    await store.markAttemptPayloadNotCaptured({
      ...rightLocator,
      harnessRunId: "harness-right",
      reasonCode: "capture-disabled",
      recordedAt: BASE_TIME,
      revision: 0
    }, {
      expectedRevision: null,
      expectedDigest: null
    });
    assert.deepEqual(await store.readAttemptPayload(leftLocator), {
      state: "not-captured",
      reasonCode: "failed-before-payload"
    });
    assert.deepEqual(await store.readAttemptPayload(rightLocator), {
      state: "not-captured",
      reasonCode: "capture-disabled"
    });
  });
}

async function assertAttemptPayloadAvailabilityStates(): Promise<void> {
  await withFixture("payload-availability", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    assert.deepEqual(await store.readAttemptPayload({
      workflowRunId: "workflow-missing",
      attemptId: "attempt-missing"
    }), {
      state: "missing"
    });

    await store.markAttemptPayloadNotCaptured({
      workflowRunId: "workflow-not-captured",
      attemptId: "attempt-not-captured",
      harnessRunId: "harness-not-captured",
      reasonCode: "failed-before-payload",
      recordedAt: BASE_TIME,
      revision: 0
    }, {
      expectedRevision: null,
      expectedDigest: null
    });
    assert.deepEqual(await store.readAttemptPayload({
      workflowRunId: "workflow-not-captured",
      attemptId: "attempt-not-captured"
    }), {
      state: "not-captured",
      reasonCode: "failed-before-payload"
    });
    const notCapturedSubjectRoot = path.join(
      store.rootPath,
      "attempt-payloads",
      attemptRunRecordSubjectToken({
        workflowRunId: "workflow-not-captured",
        attemptId: "attempt-not-captured"
      })
    );
    const notCapturedPointer = JSON.parse(await readFile(
      path.join(notCapturedSubjectRoot, "manifests", "000000000000.json"),
      "utf8"
    )) as { contentDigest: string };
    const lateEvents = payloadEvents(
      "workflow-not-captured",
      "attempt-not-captured",
      "harness-not-captured"
    );
    const latePayload = buildAttemptPayloadManifest({
      workflowRunId: "workflow-not-captured",
      attemptId: "attempt-not-captured",
      harnessRunId: "harness-not-captured",
      createdAt: BASE_TIME,
      revision: 1
    }, lateEvents);
    await assert.rejects(
      () => store.sealAttemptPayload(latePayload, lateEvents, {
        expectedRevision: 0,
        expectedDigest: notCapturedPointer.contentDigest
      }),
      RunRecordStoreConflictError
    );

    const events = payloadEvents(
      "workflow-present",
      "attempt-present",
      "harness-present"
    );
    const manifest = buildAttemptPayloadManifest({
      workflowRunId: "workflow-present",
      attemptId: "attempt-present",
      harnessRunId: "harness-present",
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.sealAttemptPayload(manifest, events, {
      expectedRevision: null,
      expectedDigest: null
    });
    const present = await store.readAttemptPayload({
      workflowRunId: "workflow-present",
      attemptId: "attempt-present"
    });
    assert.equal(present.state, "present");
    if (present.state !== "present") throw new Error("expected present payload");
    assert.deepEqual(present.manifest, manifest);
    assert.deepEqual(present.events, events);
    await assert.rejects(
      () => store.markAttemptPayloadNotCaptured({
        workflowRunId: manifest.workflowRunId,
        attemptId: manifest.attemptId,
        harnessRunId: manifest.harnessRunId,
        reasonCode: "capture-disabled",
        recordedAt: BASE_TIME + 300,
        revision: 1
      }, {
        expectedRevision: manifest.revision,
        expectedDigest: manifest.digest
      }),
      RunRecordStoreConflictError
    );

    const tombstone = payloadTombstone(manifest);
    await store.publishAttemptPayloadTombstone(tombstone, {
      expectedRevision: 0,
      expectedDigest: manifest.digest
    });
    assert.deepEqual(await store.readAttemptPayload({
      workflowRunId: "workflow-present",
      attemptId: "attempt-present"
    }), {
      state: "expired",
      tombstone
    });
    const resurrected = buildAttemptPayloadManifest({
      workflowRunId: manifest.workflowRunId,
      attemptId: manifest.attemptId,
      harnessRunId: manifest.harnessRunId,
      createdAt: manifest.createdAt,
      revision: 2
    }, events);
    await assert.rejects(
      () => store.sealAttemptPayload(resurrected, events, {
        expectedRevision: tombstone.revision,
        expectedDigest: tombstone.digest
      }),
      RunRecordStoreConflictError
    );

    const payloadRoot = path.join(
      store.rootPath,
      "attempt-payloads",
      attemptRunRecordSubjectToken({
        workflowRunId: "workflow-present",
        attemptId: "attempt-present"
      }),
      "generations"
    );
    const eventFiles = await findNamedFiles(payloadRoot, "events.jsonl");
    assert.equal(
      eventFiles.length,
      1,
      "publishing a tombstone must not delete the old immutable payload generation"
    );
    await rm(path.dirname(eventFiles[0]), { recursive: true, force: true });
    const unprovableExpiry = await store.readAttemptPayload({
      workflowRunId: "workflow-present",
      attemptId: "attempt-present"
    });
    assert.equal(unprovableExpiry.state, "corrupt");
  });
}

async function assertPayloadSafeReadRejectsSymlink(): Promise<void> {
  await withFixture("payload-symlink", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const events = payloadEvents("workflow-link", "attempt-link", "harness-link");
    const manifest = buildAttemptPayloadManifest({
      workflowRunId: "workflow-link",
      attemptId: "attempt-link",
      harnessRunId: "harness-link",
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.sealAttemptPayload(manifest, events, {
      expectedRevision: null,
      expectedDigest: null
    });
    const subjectRoot = path.join(
      store.rootPath,
      "attempt-payloads",
      attemptRunRecordSubjectToken({
        workflowRunId: "workflow-link",
        attemptId: "attempt-link"
      })
    );
    const pointer = JSON.parse(await readFile(
      path.join(subjectRoot, "manifests", "000000000000.json"),
      "utf8"
    )) as { generation: string };
    const eventsPath = path.join(
      subjectRoot,
      "generations",
      pointer.generation,
      "events.jsonl"
    );
    const outsidePath = path.join(storageRootPath, "outside-events.jsonl");
    await writeFile(outsidePath, "{}\n", "utf8");
    await unlink(eventsPath);
    await symlink(outsidePath, eventsPath, "file");
    const read = await store.readAttemptPayload({
      workflowRunId: "workflow-link",
      attemptId: "attempt-link"
    });
    assert.equal(read.state, "corrupt");
  });
}

async function assertMissingPayloadCannotBecomeExpired(): Promise<void> {
  await withFixture("missing-not-expired", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const manifest = buildAttemptPayloadManifest({
      workflowRunId: "workflow-never-written",
      attemptId: "attempt-never-written",
      harnessRunId: "harness-never-written",
      createdAt: BASE_TIME,
      revision: 0
    }, payloadEvents(
      "workflow-never-written",
      "attempt-never-written",
      "harness-never-written"
    ));
    const tombstone = payloadTombstone(manifest);

    await assert.rejects(
      () => store.publishAttemptPayloadTombstone(tombstone, {
        expectedRevision: 0,
        expectedDigest: manifest.digest
      }),
      RunRecordStoreConflictError
    );
    assert.deepEqual(await store.readAttemptPayload({
      workflowRunId: "workflow-never-written",
      attemptId: "attempt-never-written"
    }), {
      state: "missing"
    });
  });
}

async function assertPayloadCorruptionIsDistinctFromMissing(): Promise<void> {
  await withFixture("payload-corrupt", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const events = payloadEvents(
      "workflow-corrupt",
      "attempt-corrupt",
      "harness-corrupt"
    );
    const manifest = buildAttemptPayloadManifest({
      workflowRunId: "workflow-corrupt",
      attemptId: "attempt-corrupt",
      harnessRunId: "harness-corrupt",
      createdAt: BASE_TIME,
      revision: 0
    }, events);
    await store.sealAttemptPayload(manifest, events, {
      expectedRevision: null,
      expectedDigest: null
    });

    const subjectRoot = path.join(
      store.rootPath,
      "attempt-payloads",
      attemptRunRecordSubjectToken({
        workflowRunId: "workflow-corrupt",
        attemptId: "attempt-corrupt"
      })
    );
    const pointer = JSON.parse(
      await readFile(path.join(subjectRoot, "manifests", "000000000000.json"), "utf8")
    ) as { generation: string };
    await writeFile(
      path.join(subjectRoot, "generations", pointer.generation, "events.jsonl"),
      "{broken-json\n",
      "utf8"
    );

    const read = await store.readAttemptPayload({
      workflowRunId: "workflow-corrupt",
      attemptId: "attempt-corrupt"
    });
    assert.equal(read.state, "corrupt");
    if (read.state !== "corrupt") throw new Error("expected corrupt payload");
    assert.equal(read.code, "payload-jsonl-corrupt");
  });
}

async function assertAtomicGenerationCrashWindows(): Promise<void> {
  await withFixture("crash-before-publish", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const record = workflowSummary(0, "workflow-crash-before");
    await assert.rejects(
      () => store.writeWorkflowRunSummary(record, {
        expectedRevision: null,
        expectedDigest: null
      }, (point) => {
        if (point === "after-generation-sync") throw new RunRecordStoreSimulatedCrash(point);
      }),
      RunRecordStoreSimulatedCrash
    );
    assert.deepEqual(await store.readWorkflowRunSummary(record.workflowRunId), {
      state: "missing"
    });
  });

  await withFixture("crash-after-publish", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const record = workflowSummary(0, "workflow-crash-after");
    await assert.rejects(
      () => store.writeWorkflowRunSummary(record, {
        expectedRevision: null,
        expectedDigest: null
      }, (point) => {
        if (point === "after-manifest-publish") throw new RunRecordStoreSimulatedCrash(point);
      }),
      RunRecordStoreSimulatedCrash
    );
    assert.deepEqual(await store.readWorkflowRunSummary(record.workflowRunId), {
      state: "present",
      record
    });
  });

  await withFixture("crash-between-manifest-and-head", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const record = workflowSummary(0, "workflow-crash-orphan");
    await assert.rejects(
      () => store.writeWorkflowRunSummary(record, {
        expectedRevision: null,
        expectedDigest: null
      }, (point) => {
        if (point === "after-manifest-link") {
          throw new RunRecordStoreSimulatedCrash(point);
        }
      }),
      RunRecordStoreSimulatedCrash
    );
    assert.deepEqual(await store.readWorkflowRunSummary(record.workflowRunId), {
      state: "missing"
    });

    const { digest: _digest, ...differentInput } = record;
    const different = finalizeWorkflowRunSummary({
      ...differentInput,
      workflow: "knowledge.different"
    });
    await assert.rejects(
      () => store.writeWorkflowRunSummary(different, {
        expectedRevision: null,
        expectedDigest: null
      }),
      RunRecordStoreConflictError,
      "a different candidate cannot replace an unpublished manifest orphan"
    );
    await store.writeWorkflowRunSummary(record, {
      expectedRevision: null,
      expectedDigest: null
    });
    assert.deepEqual(await store.readWorkflowRunSummary(record.workflowRunId), {
      state: "present",
      record
    });
  });

  await withFixture("manifest-tail-truncation", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const first = workflowSummary(0, "workflow-tail");
    const second = workflowSummary(1, "workflow-tail");
    await store.writeWorkflowRunSummary(first, {
      expectedRevision: null,
      expectedDigest: null
    });
    await store.writeWorkflowRunSummary(second, {
      expectedRevision: first.revision,
      expectedDigest: first.digest
    });
    await unlink(path.join(
      store.rootPath,
      "workflow-summaries",
      safeRunRecordToken(first.workflowRunId),
      "manifests",
      "000000000001.json"
    ));
    const read = await store.readWorkflowRunSummary(first.workflowRunId);
    assert.equal(read.state, "corrupt");
  });
}

function workflowSummary(
  revision: number,
  workflowRunId = "workflow-a"
): WorkflowRunSummaryV1 {
  return finalizeWorkflowRunSummary({
    schemaVersion: 1,
    recordType: "workflow-run-summary",
    workflowRunId,
    surface: "knowledge",
    workflow: "knowledge.maintain",
    conversationRef: {
      conversationId: "conversation-a",
      contextId: "context-a",
      turnId: "turn-a"
    },
    status: "completed",
    startedAt: BASE_TIME,
    terminalAt: BASE_TIME + 500,
    usage: {
      totalTokens: 34,
      inputTokens: 21,
      outputTokens: 13
    },
    attemptRefs: [{ attemptId: "attempt-a", ordinal: 1 }],
    artifactRefs: [{ artifactId: "artifact-a", kind: "markdown-report" }],
    errorCode: "none",
    localMutation: {
      state: "committed",
      transactionId: "transaction-a",
      committedAt: BASE_TIME + 500
    },
    retention: {
      summaryExpiresAt: BASE_TIME + 500 + 90 * RUN_RECORD_DAY_MS,
      holdReasons: []
    },
    revision
  });
}

function attemptSummary(
  revision: number,
  workflowRunId = "workflow-a",
  attemptId = "attempt-a",
  harnessRunId = "harness-a"
): AttemptRunSummaryV1 {
  return finalizeAttemptRunSummary({
    schemaVersion: 1,
    recordType: "attempt-run-summary",
    workflowRunId,
    attemptId,
    ordinal: 1,
    harnessRunId,
    backendId: "codex-cli",
    nativeExecutionRecordIds: ["native-a"],
    status: "completed",
    startedAt: BASE_TIME + 100,
    terminalAt: BASE_TIME + 400,
    usage: {
      totalTokens: 34,
      inputTokens: 21,
      outputTokens: 13
    },
    errorCode: "none",
    reasonCode: "none",
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
      expected: true,
      expiresAt: BASE_TIME + 400 + 30 * RUN_RECORD_DAY_MS
    },
    retention: {
      summaryExpiresAt: BASE_TIME + 400 + 90 * RUN_RECORD_DAY_MS,
      holdReasons: []
    },
    revision
  });
}

function reviseWorkflow(
  current: WorkflowRunSummaryV1,
  revision: number,
  overrides: Partial<Omit<
    WorkflowRunSummaryV1,
    "schemaVersion" | "recordType" | "workflowRunId" | "revision" | "digest"
  >>
): WorkflowRunSummaryV1 {
  const { digest: _digest, ...input } = current;
  return finalizeWorkflowRunSummary({
    ...input,
    ...overrides,
    revision
  });
}

function reviseAttempt(
  current: AttemptRunSummaryV1,
  revision: number,
  overrides: Partial<Omit<
    AttemptRunSummaryV1,
    | "schemaVersion"
    | "recordType"
    | "workflowRunId"
    | "attemptId"
    | "revision"
    | "digest"
  >>
): AttemptRunSummaryV1 {
  const { digest: _digest, ...input } = current;
  return finalizeAttemptRunSummary({
    ...input,
    ...overrides,
    revision
  });
}

function payloadEvents(
  workflowRunId: string,
  attemptId: string,
  harnessRunId: string
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
      text: "complete"
    },
    {
      schemaVersion: 1,
      recordType: "attempt-harness-event",
      workflowRunId,
      attemptId,
      harnessRunId,
      eventId: `${harnessRunId}:3`,
      runId: harnessRunId,
      sequence: 3,
      createdAt: BASE_TIME + 200,
      source: "workflow",
      type: "run.local_commit.completed"
    }
  ];
}

function payloadTombstone(
  manifest: AttemptPayloadManifestV1
): ReturnType<typeof finalizeRetentionTombstone> {
  return finalizeRetentionTombstone({
    schemaVersion: 1,
    recordType: "run-retention-tombstone",
    scope: "attempt-payload",
    workflowRunId: manifest.workflowRunId,
    attemptId: manifest.attemptId,
    harnessRunId: manifest.harnessRunId,
    subjectDigest: manifest.subjectDigest,
    reasonCode: "policy-expired",
    eligibleAt: manifest.expiresAt,
    expiredAt: manifest.expiresAt,
    prior: {
      schemaVersion: manifest.schemaVersion,
      digest: manifest.digest,
      eventCount: manifest.eventCount,
      byteCount: manifest.byteCount,
      terminalAt: manifest.terminalAt
    },
    policy: {
      version: 1,
      retentionDays: 30
    },
    retentionTransactionId: `retention-${manifest.attemptId}`,
    committedAt: manifest.expiresAt + 1,
    revision: manifest.revision + 1
  });
}

function assertContractCode(
  action: () => unknown,
  code: RunRecordContractError["code"]
): void {
  assert.throws(action, (error) =>
    error instanceof RunRecordContractError && error.code === code
  );
}

async function withFixture(
  label: string,
  action: (storageRootPath: string) => Promise<void>
): Promise<void> {
  const storageRootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-run-record-${label}-`)
  );
  try {
    await action(storageRootPath);
  } finally {
    await rm(storageRootPath, { recursive: true, force: true });
  }
}

async function findNamedFiles(
  rootPath: string,
  targetName: string
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(rootPath, { withFileTypes: true })) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...await findNamedFiles(absolutePath, targetName));
    } else if (entry.isFile() && entry.name === targetName) {
      result.push(absolutePath);
    }
  }
  return result;
}

if (process.env.ECHOINK_RUN_RUN_RECORD_STORE_TEST === "1") {
  runHarnessV2RunRecordStoreTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
