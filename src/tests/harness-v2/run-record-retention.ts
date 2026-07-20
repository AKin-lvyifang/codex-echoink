import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createWorkflowArtifactLifecycleRecord
} from "../../harness/artifacts/artifact-lifecycle-store";
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
  recoverStartedRunRecordRetentionSweeps,
  RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY,
  runRecordRetentionSubjectKey,
  RunRecordRetentionError,
  type RunRecordRetentionHoldSnapshot,
  type RunRecordRetentionRetirementRoots,
  type RunRecordRetentionRecoveryEvidenceAuthority
} from "../../harness/ledger/run-record-retention";
import {
  createRunRecordRetentionRecoveryEvidenceAuthority
} from "../../harness/ledger/run-record-retention-recovery-evidence";
import {
  FileRunRecordStore
} from "../../harness/ledger/run-record-store";
import {
  createRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  createOrLoadRecordRootBinding,
  recordRootBindingRef
} from "../../harness/storage/record-root-registry";
import { pluginDataDir } from "../../core/raw-message-store";
import { EchoInkHarnessService } from "../../plugin/harness-service";

const BASE_TIME = 1_721_260_800_000;
const RETENTION_NOW = BASE_TIME + 100 * RUN_RECORD_DAY_MS;

export async function runHarnessV2RunRecordRetentionTests():
Promise<void> {
  await assertStoreMutationLaneSerializesConcurrentPublish();
  await assertOrderedSweepRecoversAfterTombstoneCrash();
  await assertPayloadRetirementCrashWindowsReplay();
  await assertNewHoldBlocksAfterPrepareAndAfterTombstone();
  await assertStartupRecoveryOnlyResumesExistingPlans();
  await assertHarnessServiceRecoversStartedRetentionWithProductionRoots();
  await assertProductionRecoveryEvidenceUsesDurableSources();
  await assertProductionRecoveryEvidenceFreezesArtifactWriters();
  await assertRecoveryEvidenceHoldsTheWholeRun();
  await assertExecutionRejectsHoldAddedAfterPreview();
  await assertExecutionRejectsWorkflowAddedAfterPreview();
  await assertNotCapturedPayloadAllowsSummaryRetention();
}

async function assertStartupRecoveryOnlyResumesExistingPlans():
Promise<void> {
  await withFixture("startup-missing", async (storageRootPath) => {
    const authority = mutableRecoveryEvidenceAuthority();
    let rootResolutionCount = 0;
    assert.equal(
      await recoverStartedRunRecordRetentionSweeps({
        storageRootPath,
        recoveryEvidenceAuthority: authority,
        resolveRetirementRoots: async () => {
          rootResolutionCount += 1;
          return await createRetentionRoots(storageRootPath);
        }
      }),
      0
    );
    assert.equal(rootResolutionCount, 0);
    assert.deepEqual(await readdir(storageRootPath), []);
  });

  await withFixture("startup-resume", async (storageRootPath) => {
    const seeded = await seedRetainableRun(
      storageRootPath,
      "startup-resume"
    );
    let crashed = false;
    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan: seeded.plan,
        retirementRoots: seeded.retirementRoots,
        recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority,
        faultInjector: (point, ordinal) => {
          if (
            !crashed
            && point === "after-trash-prepared-progress"
            && ordinal === 0
          ) {
            crashed = true;
            throw new Error("simulated startup recovery crash");
          }
        }
      }),
      /simulated startup recovery crash/
    );
    let rootResolutionCount = 0;
    assert.equal(
      await recoverStartedRunRecordRetentionSweeps({
        storageRootPath,
        recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority,
        resolveRetirementRoots: async () => {
          rootResolutionCount += 1;
          return seeded.retirementRoots;
        }
      }),
      1
    );
    assert.equal(rootResolutionCount, 1);
    const transactionRoot = path.join(
      storageRootPath,
      RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY
    );
    const chain = (await readdir(transactionRoot))
      .find((entry) => entry !== ".staging");
    assert.ok(chain);
    const beforeReplay = await readdir(
      path.join(transactionRoot, chain)
    );
    assert.equal(
      await recoverStartedRunRecordRetentionSweeps({
        storageRootPath,
        recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority,
        resolveRetirementRoots: async () => {
          rootResolutionCount += 1;
          return seeded.retirementRoots;
        }
      }),
      0,
      "completed startup recovery must be a strict no-op"
    );
    assert.equal(rootResolutionCount, 1);
    assert.deepEqual(
      await readdir(path.join(transactionRoot, chain)),
      beforeReplay
    );
  });

  await withFixture("startup-corrupt", async (storageRootPath) => {
    const seeded = await seedRetainableRun(
      storageRootPath,
      "startup-corrupt"
    );
    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan: seeded.plan,
        retirementRoots: seeded.retirementRoots,
        recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority,
        faultInjector: (point) => {
          if (point === "after-journal-create") {
            throw new Error("stop after plan");
          }
        }
      }),
      /stop after plan/
    );
    const transactionRoot = path.join(
      storageRootPath,
      RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY
    );
    const chain = (await readdir(transactionRoot))
      .find((entry) => entry !== ".staging");
    assert.ok(chain);
    const planPath = path.join(transactionRoot, chain, "plan.json");
    const originalPlan = await readFile(planPath, "utf8");
    await writeFile(planPath, `${originalPlan.trim()}broken\n`, "utf8");
    await assert.rejects(
      recoverStartedRunRecordRetentionSweeps({
        storageRootPath,
        retirementRoots: seeded.retirementRoots,
        recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority
      }),
      (error) =>
        error instanceof RunRecordRetentionError
        && error.code === "journal-corrupt"
    );
    assert.equal(
      (await seeded.store.readAttemptPayload(seeded.attempt)).state,
      "present",
      "a corrupt startup plan must cause zero retention effects"
    );
  });

  await withFixture("startup-staging", async (storageRootPath) => {
    const transactionRoot = path.join(
      storageRootPath,
      RUN_RECORD_RETENTION_TRANSACTION_DIRECTORY
    );
    const stagingRoot = path.join(transactionRoot, ".staging");
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(path.join(stagingRoot, "pending.tmp"), "pending\n");
    await assert.rejects(
      recoverStartedRunRecordRetentionSweeps({
        storageRootPath,
        recoveryEvidenceAuthority: mutableRecoveryEvidenceAuthority()
      }),
      (error) =>
        error instanceof RunRecordRetentionError
        && error.code === "journal-corrupt"
    );
  });
}

async function assertProductionRecoveryEvidenceUsesDurableSources():
Promise<void> {
  await withFixture("production-evidence", async (storageRootPath) => {
    const store = new FileRunRecordStore({ storageRootPath });
    const workflow = workflowSummary(
      "workflow-production-evidence",
      "attempt-production-evidence",
      [{
        artifactId: "artifact-production-evidence",
        kind: "markdown-report"
      }]
    );
    const attempt = attemptSummary(
      workflow.workflowRunId,
      workflow.attemptRefs[0].attemptId,
      "harness-production-evidence"
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

    const artifactRootPath = path.join(
      storageRootPath,
      "workflow-artifact-lifecycle-v1"
    );
    const authority =
      createRunRecordRetentionRecoveryEvidenceAuthority({
        storageRootPath,
        artifactRootPath
      });
    const missingArtifact = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-production-missing-artifact",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority: authority
    });
    assert.deepEqual(
      missingArtifact.subjects.find(
        (subject) => subject.scope === "workflow-summary"
      )?.holdReasons,
      ["artifact-lineage-pending"]
    );
    assert.equal(missingArtifact.actions.length, 0);

    await createWorkflowArtifactLifecycleRecord({
      storageRootPath,
      rootPath: artifactRootPath,
      artifactId: "artifact-production-evidence",
      artifactKind: "markdown-report",
      sourceConversationIds: [
        workflow.conversationRef!.conversationId
      ],
      createdAt: BASE_TIME
    });
    const ready = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-production-artifact-ready",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority: authority
    });
    assert.deepEqual(ready.blockers, []);
    assert.deepEqual(
      ready.actions.map((action) => action.tombstone.scope),
      ["attempt-payload", "attempt-summary", "workflow-summary"]
    );

    await createRecordMutationJournal({
      storageRootPath,
      mutationId: "mutation-production-evidence",
      intent: {
        operation: "start-new-context",
        conversationId: workflow.conversationRef!.conversationId,
        expectedConversationGeneration: 0,
        expectedConversationCommitId: null,
        expectedConversationContentRevision: `sha256:${"1".repeat(64)}`,
        targetConversation: {
          status: "present",
          generation: 1,
          commitId: "commit-production-evidence",
          contentRevision: `sha256:${"2".repeat(64)}`
        },
        participants: [
          {
            id: "conversation",
            recordKind: "conversation",
            action: "retain"
          }
        ],
        rootBindings: [],
        trashPolicy: "not-required"
      },
      createdAt: BASE_TIME
    });
    const pendingMutation = await previewRunRecordRetentionSweep({
      storageRootPath,
      transactionId: "retention-production-pending-mutation",
      now: RETENTION_NOW,
      recoveryEvidenceAuthority: authority
    });
    assert.deepEqual(
      pendingMutation.subjects.find(
        (subject) => subject.scope === "workflow-summary"
      )?.holdReasons,
      ["local-commit-recovery-required"]
    );
    assert.equal(pendingMutation.actions.length, 0);
  });
}

async function assertHarnessServiceRecoversStartedRetentionWithProductionRoots():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-run-retention-service-")
  );
  const pluginDir = ".obsidian/plugins/codex-echoink";
  const storageRootPath = pluginDataDir(vaultPath, pluginDir);
  await mkdir(storageRootPath, { recursive: true, mode: 0o700 });
  try {
    const seeded = await seedRetainableRun(
      storageRootPath,
      "service-production"
    );
    let crashed = false;
    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan: seeded.plan,
        retirementRoots: seeded.retirementRoots,
        recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority,
        faultInjector: (point, ordinal) => {
          if (
            !crashed
            && point === "after-trash-prepared-progress"
            && ordinal === 0
          ) {
            crashed = true;
            throw new Error("simulated service retention crash");
          }
        }
      }),
      /simulated service retention crash/
    );
    const service = new EchoInkHarnessService({
      getVaultPath: () => vaultPath,
      getPluginDataDirName: () => pluginDir
    } as never);
    assert.equal(await service.recoverStartedRunRecordRetentions(), 1);
    assert.equal(await service.recoverStartedRunRecordRetentions(), 0);
    assert.equal(
      (await seeded.store.readAttemptPayload(seeded.attempt)).state,
      "expired"
    );
    assert.equal(
      (
        await seeded.store.readWorkflowRunSummary(
          seeded.workflow.workflowRunId
        )
      ).state,
      "expired"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertProductionRecoveryEvidenceFreezesArtifactWriters():
Promise<void> {
  await withFixture("production-evidence-lock", async (storageRootPath) => {
    const artifactRootPath = path.join(
      storageRootPath,
      "workflow-artifact-lifecycle-v1"
    );
    const authority =
      createRunRecordRetentionRecoveryEvidenceAuthority({
        storageRootPath,
        artifactRootPath
      });
    let releaseAuthority!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    let enteredAuthority!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredAuthority = resolve;
    });
    const authorityFlight = authority.withStableHolds(async () => {
      enteredAuthority();
      await release;
    });
    await entered;

    let artifactSettled = false;
    const artifactFlight = createWorkflowArtifactLifecycleRecord({
      storageRootPath,
      rootPath: artifactRootPath,
      artifactId: "artifact-evidence-lock",
      artifactKind: "markdown-report",
      sourceConversationIds: ["conversation-evidence-lock"],
      createdAt: BASE_TIME
    }).then(() => {
      artifactSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      artifactSettled,
      false,
      "Artifact lineage writers must wait for the retention evidence authority"
    );
    releaseAuthority();
    await authorityFlight;
    await artifactFlight;
    assert.equal(artifactSettled, true);
  });
}

async function assertPayloadRetirementCrashWindowsReplay():
Promise<void> {
  const scenarios = [
    "after-execution-header",
    "after-trash-prepare",
    "after-source-retired",
    "after-retirement-receipt-publish"
  ] as const;
  for (const point of scenarios) {
    await withFixture(`crash-${point}`, async (storageRootPath) => {
      const seeded = await seedRetainableRun(
        storageRootPath,
        `crash-${point}`
      );
      let crashed = false;
      await assert.rejects(
        executeRunRecordRetentionSweep({
          storageRootPath,
          plan: seeded.plan,
          retirementRoots: seeded.retirementRoots,
          recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority,
          faultInjector: (observed, ordinal) => {
            if (!crashed && observed === point && ordinal === 0) {
              crashed = true;
              throw new Error(`simulated ${point}`);
            }
          }
        }),
        new RegExp(`simulated ${point}`)
      );
      assert.equal(crashed, true);

      await executeRunRecordRetentionSweep({
        storageRootPath,
        plan: seeded.plan,
        retirementRoots: seeded.retirementRoots,
        recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority
      });
      const payload = await seeded.store.readAttemptPayload(seeded.attempt);
      assert.equal(payload.state, "expired");
      assert.equal(
        payload.state === "expired"
          && Boolean(payload.retirementReceipt),
        true
      );
      assert.equal(
        (await seeded.store.readAttemptRunSummary(seeded.attempt)).state,
        "expired"
      );
      assert.equal(
        (await seeded.store.readWorkflowRunSummary(
          seeded.workflow.workflowRunId
        )).state,
        "expired"
      );
    });
  }
}

async function assertNewHoldBlocksAfterPrepareAndAfterTombstone():
Promise<void> {
  for (const crashPoint of [
    "after-trash-prepared-progress",
    "after-progress-publish"
  ] as const) {
    await withFixture(`hold-${crashPoint}`, async (storageRootPath) => {
      const seeded = await seedRetainableRun(
        storageRootPath,
        `hold-${crashPoint}`
      );
      let crashed = false;
      await assert.rejects(
        executeRunRecordRetentionSweep({
          storageRootPath,
          plan: seeded.plan,
          retirementRoots: seeded.retirementRoots,
          recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority,
          faultInjector: (point, ordinal) => {
            if (!crashed && point === crashPoint && ordinal === 0) {
              crashed = true;
              throw new Error(`simulated ${crashPoint}`);
            }
          }
        }),
        new RegExp(`simulated ${crashPoint}`)
      );
      const payloadKey = runRecordRetentionSubjectKey({
        scope: "attempt-payload",
        workflowRunId: seeded.attempt.workflowRunId,
        attemptId: seeded.attempt.attemptId,
        harnessRunId: seeded.attempt.harnessRunId
      });
      seeded.recoveryEvidenceAuthority.setHolds({
        [payloadKey]: ["wal-present"]
      });
      await assert.rejects(
        executeRunRecordRetentionSweep({
          storageRootPath,
          plan: seeded.plan,
          retirementRoots: seeded.retirementRoots,
          recoveryEvidenceAuthority: seeded.recoveryEvidenceAuthority
        }),
        (error) =>
          error instanceof RunRecordRetentionError
          && error.code === "plan-conflict"
          && /hold or eligibility changed/.test(error.message)
      );
      const payload = await seeded.store.readAttemptPayload(seeded.attempt);
      if (crashPoint === "after-trash-prepared-progress") {
        assert.equal(payload.state, "present");
      } else {
        assert.equal(payload.state, "expired");
        assert.equal(
          payload.state === "expired"
            && payload.retirementReceipt === undefined,
          true,
          "a new hold after tombstone must block physical retirement"
        );
      }
      assert.equal(
        (await seeded.store.readAttemptRunSummary(seeded.attempt)).state,
        "present"
      );
    });
  }
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
    const retirementRoots = await createRetentionRoots(storageRootPath);

    let crashed = false;
    await assert.rejects(
      executeRunRecordRetentionSweep({
        storageRootPath,
        plan,
        retirementRoots,
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
        retirementRoots,
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
    const retiredPayload = await store.readAttemptPayload(attempt);
    assert.equal(
      retiredPayload.state === "expired"
        && Boolean(retiredPayload.retirementReceipt),
      true,
      "payload must carry a durable physical-retirement receipt"
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
      retirementRoots,
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
        "execution-000000.json",
        "finalization-000000.json",
        "plan.json",
        "prepared-000000.json",
        "step-000000.json",
        "step-000001.json",
        "step-000002.json",
        "step-000003.json",
        "step-000004.json"
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
    const retirementRoots = await createRetentionRoots(storageRootPath);

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
        retirementRoots,
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
    const retirementRoots = await createRetentionRoots(storageRootPath);

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
        retirementRoots,
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
  attemptId: string,
  artifactRefs: WorkflowRunSummaryV1["artifactRefs"] = []
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
    artifactRefs,
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

async function seedRetainableRun(
  storageRootPath: string,
  suffix: string
): Promise<{
  store: FileRunRecordStore;
  workflow: WorkflowRunSummaryV1;
  attempt: AttemptRunSummaryV1;
  plan: Awaited<ReturnType<typeof previewRunRecordRetentionSweep>>;
  retirementRoots: RunRecordRetentionRetirementRoots;
  recoveryEvidenceAuthority:
    ReturnType<typeof mutableRecoveryEvidenceAuthority>;
}> {
  const store = new FileRunRecordStore({ storageRootPath });
  const workflow = workflowSummary(
    `workflow-retention-${suffix}`,
    `attempt-retention-${suffix}`
  );
  const attempt = attemptSummary(
    workflow.workflowRunId,
    workflow.attemptRefs[0].attemptId,
    `harness-retention-${suffix}`
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
    transactionId: `retention-${suffix}`,
    now: RETENTION_NOW,
    recoveryEvidenceAuthority
  });
  const retirementRoots = await createRetentionRoots(storageRootPath);
  return {
    store,
    workflow,
    attempt,
    plan,
    retirementRoots,
    recoveryEvidenceAuthority
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

async function createRetentionRoots(
  storageRootPath: string
): Promise<RunRecordRetentionRetirementRoots> {
  const store = new FileRunRecordStore({ storageRootPath });
  const trashRootPath = path.join(
    storageRootPath,
    "record-mutation-trash-v1"
  );
  await mkdir(trashRootPath, { recursive: true, mode: 0o700 });
  const source = await createOrLoadRecordRootBinding({
    storageRootPath,
    rootId: "echoink-run-record-store",
    rootPath: store.rootPath,
    boundaryRootPath: storageRootPath,
    authority: "plugin-owned",
    createdAt: RETENTION_NOW
  });
  const trash = await createOrLoadRecordRootBinding({
    storageRootPath,
    rootId: "echoink-record-mutation-trash",
    rootPath: trashRootPath,
    boundaryRootPath: storageRootPath,
    authority: "plugin-owned",
    createdAt: RETENTION_NOW
  });
  return {
    sourceRootPath: store.rootPath,
    sourceBoundaryRootPath: storageRootPath,
    sourceRootBinding: recordRootBindingRef(source.binding),
    trashRootPath,
    trashBoundaryRootPath: storageRootPath,
    trashRootBinding: recordRootBindingRef(trash.binding)
  };
}

if (process.env.ECHOINK_RUN_RUN_RECORD_RETENTION_TEST === "1") {
  runHarnessV2RunRecordRetentionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
