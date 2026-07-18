import * as assert from "node:assert/strict";
import type {
  KnowledgeBaseMaintenanceHistoryEntry,
  KnowledgeBaseSettings
} from "../../settings/settings";
import { shouldRunScheduledKnowledgeBaseMaintenance } from "../../knowledge-base/schedule";
import {
  KnowledgeBaseScheduler,
  type ScheduledMaintenanceInvocation
} from "../../knowledge-base/scheduler";
import type {
  KnowledgeBaseDurableMaintenanceResult,
  KnowledgeBaseRunResult
} from "../../knowledge-base/types";

export async function runHarnessV2MaintenanceSchedulerTests(): Promise<void> {
  assertOnlyCompletedScheduleStatusesSuppressSameDayRetry();
  await assertRecoveryGateBlocksStateAndAgentUntilReady();
  await assertCommittedProjectionUsesFreshSettingsObject();
  await assertRecoveredTerminalSuppressesPreviouslyDueRetry();
  await assertRecoveryGateRejectionFailsClosed();
  await assertConcurrentTriggersShareSingleFlight();
  await assertRunningBaselinePersistenceFailureDoesNotStart();
  await assertFailedScheduleRetriesOnNextCheck();
  await assertRapidRetryGetsDistinctWorkflowRunId();
  await assertStaleRunningScheduleRetriesWhenNoRunIsActive();
  await assertDurableRunningScheduleDoesNotDuplicateCatchUp();
  await assertCanceledScheduleDoesNotRetrySameDay();
  await assertActiveRunStillPreventsConcurrentRetry();
  await assertWalPersistedResultWaitsForRecovery();
  await assertExternalRecoveryClearsPendingLatch();
  await assertUntrustedPreWalResultsWaitForRecovery();
  await assertPreWalTerminalPersistenceFailureWaitsForRecovery();
  await assertCommittedProjectionMustMatchInvocation();
  await assertCommittedProjectionRequiresMatchingHistory();
  await assertRecoveryLatchRequiresCanonicalHistory();
  await assertPostRunEffectsCannotOverrideMaintenanceResult();
  await assertThrownMaintenanceAttemptWaitsForRecovery();
}

async function assertRecoveryGateBlocksStateAndAgentUntilReady(): Promise<void> {
  const settings = schedulerSettings();
  const gate = deferred();
  let recoveryReady = false;
  let persistCount = 0;
  let runCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => !recoveryReady,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => {
      await gate.promise;
      recoveryReady = true;
    },
    persistSettings: async () => {
      persistCount += 1;
    },
    runMaintenance: async (invocation) => {
      runCount += 1;
      return commitResult(settings, "success", invocation);
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  const pending = scheduler.runScheduledIfDue();
  await Promise.resolve();
  assert.equal(settings.lastScheduledRunAt, 0);
  assert.equal(settings.lastScheduledRunStatus, "idle");
  assert.equal(persistCount, 0);
  assert.equal(runCount, 0);

  gate.resolve();
  await pending;
  assert.equal(runCount, 1);
  assert.equal(settings.lastScheduledRunStatus, "success");
  assert.equal(persistCount, 1);
  assert.match(
    settings.lastScheduledRunId,
    /^knowledge-maintain-scheduled-\d+$/
  );
}

async function assertCommittedProjectionUsesFreshSettingsObject(): Promise<void> {
  let settings = schedulerSettings();
  const originalSettings = settings;
  let persistCount = 0;
  let appendCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => false,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => undefined,
    persistSettings: async () => {
      persistCount += 1;
    },
    runMaintenance: async (invocation) => {
      const result = committedResult("success", invocation);
      settings = {
        ...settings
      };
      projectCommittedResult(settings, invocation, result);
      return result;
    },
    appendScheduledMaintenanceMessage: async () => {
      appendCount += 1;
    },
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  await scheduler.runScheduledIfDue();
  assert.notEqual(settings, originalSettings);
  assert.equal(settings.lastScheduledRunStatus, "success");
  assert.equal(persistCount, 1);
  assert.equal(appendCount, 1);
}

async function assertRecoveryGateRejectionFailsClosed(): Promise<void> {
  const settings = schedulerSettings();
  let persistCount = 0;
  let runCount = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => {
        throw new Error("workflow WAL recovery blocked");
      },
      persistSettings: async () => {
        persistCount += 1;
      },
      runMaintenance: async () => {
        runCount += 1;
        return runResult("success");
      },
      appendScheduledMaintenanceMessage: async () => undefined,
      refreshKnowledgeBaseSurfaces: () => undefined
    });

    await assert.doesNotReject(() => scheduler.runScheduledIfDue());
    assert.equal(settings.lastScheduledRunAt, 0);
    assert.equal(settings.lastScheduledRunStatus, "idle");
    assert.equal(persistCount, 0);
    assert.equal(runCount, 0);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
}

async function assertRecoveredTerminalSuppressesPreviouslyDueRetry(): Promise<void> {
  const settings = schedulerSettings({
    lastScheduledRunAt: todayAtMidnight(),
    lastScheduledRunStatus: "failed"
  });
  const gate = deferred();
  let persistCount = 0;
  let runCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => false,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => await gate.promise,
    persistSettings: async () => {
      persistCount += 1;
    },
    runMaintenance: async (invocation) => {
      runCount += 1;
      return commitResult(settings, "success", invocation);
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  const pending = scheduler.runScheduledIfDue();
  await Promise.resolve();
  settings.lastScheduledRunAt = Date.now();
  settings.lastScheduledRunStatus = "success";
  gate.resolve();
  await pending;

  assert.equal(runCount, 0);
  assert.equal(persistCount, 0);
  assert.equal(settings.lastScheduledRunStatus, "success");
}

async function assertConcurrentTriggersShareSingleFlight(): Promise<void> {
  const settings = schedulerSettings();
  const gate = deferred();
  let waitCount = 0;
  let runCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => false,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => {
      waitCount += 1;
      await gate.promise;
    },
    persistSettings: async () => undefined,
    runMaintenance: async (invocation) => {
      runCount += 1;
      return commitResult(settings, "success", invocation);
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  const intervalTrigger = scheduler.runScheduledIfDue();
  const catchUpTrigger = scheduler.runScheduledIfDue(true);
  const duplicateTrigger = scheduler.runScheduledIfDue();
  assert.equal(intervalTrigger, catchUpTrigger);
  assert.equal(intervalTrigger, duplicateTrigger);
  assert.equal(waitCount, 1);

  gate.resolve();
  await Promise.all([intervalTrigger, catchUpTrigger, duplicateTrigger]);
  assert.equal(runCount, 1);
}

async function assertRunningBaselinePersistenceFailureDoesNotStart(): Promise<void> {
  const settings = schedulerSettings({
    lastScheduledRunAt: 123,
    lastScheduledRunStatus: "failed",
    lastScheduledRunId: "previous-failed-run"
  });
  let runCount = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => undefined,
      persistSettings: async () => {
        throw new Error("disk unavailable");
      },
      runMaintenance: async () => {
        runCount += 1;
        return runResult("failed");
      },
      appendScheduledMaintenanceMessage: async () => undefined,
      refreshKnowledgeBaseSurfaces: () => undefined
    });

    await scheduler.runScheduledIfDue();
    assert.equal(runCount, 0);
    assert.equal(settings.lastScheduledRunAt, 123);
    assert.equal(settings.lastScheduledRunStatus, "failed");
    assert.equal(settings.lastScheduledRunId, "previous-failed-run");
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
}

function assertOnlyCompletedScheduleStatusesSuppressSameDayRetry(): void {
  const now = new Date(2026, 6, 18, 9, 5);
  const attemptedAt = new Date(2026, 6, 18, 9, 0).getTime();
  const base = {
    enabled: true,
    scheduleTime: "09:00",
    catchUpOnStartup: true,
    lastRunAt: attemptedAt,
    lastScheduledRunAt: attemptedAt
  };

  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    { ...base, lastScheduledRunStatus: "success" },
    now
  ), false);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    { ...base, lastScheduledRunStatus: "canceled" },
    now
  ), false);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    { ...base, lastScheduledRunStatus: "failed" },
    now
  ), true);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    { ...base, lastScheduledRunStatus: "running" },
    now
  ), true);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    {
      ...base,
      lastScheduledRunStatus: "running",
      lastScheduledRunId: "durable-running"
    },
    now
  ), false);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    { ...base, lastScheduledRunStatus: "idle" },
    now
  ), true);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(base, now), true);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    { ...base, lastScheduledRunStatus: "failed" },
    now,
    new Date(2026, 6, 18, 9, 1).getTime(),
    true
  ), true);
  assert.equal(shouldRunScheduledKnowledgeBaseMaintenance(
    { ...base, catchUpOnStartup: false, lastScheduledRunStatus: "failed" },
    now,
    new Date(2026, 6, 18, 9, 1).getTime(),
    true
  ), false);
}

async function assertFailedScheduleRetriesOnNextCheck(): Promise<void> {
  const settings = schedulerSettings();
  let runCount = 0;
  let persistCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => false,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => undefined,
    persistSettings: async () => {
      persistCount += 1;
    },
    runMaintenance: async (invocation) => {
      runCount += 1;
      return runCount === 1
        ? preWalResult("failed", invocation)
        : commitResult(settings, "success", invocation);
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  await scheduler.runScheduledIfDue();
  assert.equal(settings.lastScheduledRunStatus, "failed");
  assert.equal(persistCount, 2);
  await scheduler.runScheduledIfDue();
  assert.equal(runCount, 2);
  assert.equal(settings.lastScheduledRunStatus, "success");
  assert.equal(persistCount, 3);
}

async function assertRapidRetryGetsDistinctWorkflowRunId(): Promise<void> {
  const settings = schedulerSettings();
  const workflowRunIds: string[] = [];
  const scheduledStartedAtValues: number[] = [];
  const originalNow = Date.now;
  Date.now = () => 1_750_000_000_000;
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => undefined,
      persistSettings: async () => undefined,
      runMaintenance: async (invocation) => {
        workflowRunIds.push(invocation.workflowRunId);
        scheduledStartedAtValues.push(invocation.scheduledStartedAt);
        return preWalResult("failed", invocation);
      },
      appendScheduledMaintenanceMessage: async () => undefined,
      refreshKnowledgeBaseSurfaces: () => undefined
    });

    await scheduler.runScheduledIfDue();
    await scheduler.runScheduledIfDue();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(workflowRunIds.length, 2);
  assert.notEqual(workflowRunIds[0], workflowRunIds[1]);
  assert.deepEqual(scheduledStartedAtValues, [
    1_750_000_000_000,
    1_750_000_000_001
  ]);
}

async function assertStaleRunningScheduleRetriesWhenNoRunIsActive(): Promise<void> {
  const settings = schedulerSettings({
    lastScheduledRunAt: todayAtMidnight(),
    lastScheduledRunStatus: "running"
  });
  let runCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => false,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => undefined,
    persistSettings: async () => undefined,
    runMaintenance: async (invocation) => {
      runCount += 1;
      return commitResult(settings, "success", invocation);
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  await scheduler.runScheduledIfDue();
  assert.equal(runCount, 1);
  assert.equal(settings.lastScheduledRunStatus, "success");
}

async function assertDurableRunningScheduleDoesNotDuplicateCatchUp(): Promise<void> {
  const settings = schedulerSettings({
    lastScheduledRunAt: todayAtMidnight(),
    lastScheduledRunStatus: "running",
    lastScheduledRunId: "knowledge-maintain-scheduled-crashed"
  });
  let runCount = 0;
  let persistCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => false,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => undefined,
    persistSettings: async () => {
      persistCount += 1;
    },
    runMaintenance: async () => {
      runCount += 1;
      return runResult("failed");
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  await scheduler.runScheduledIfDue(true);
  await scheduler.runScheduledIfDue();
  assert.equal(runCount, 0);
  assert.equal(persistCount, 0);
  assert.equal(settings.lastScheduledRunStatus, "running");
  assert.equal(
    settings.lastScheduledRunId,
    "knowledge-maintain-scheduled-crashed"
  );
}

async function assertCanceledScheduleDoesNotRetrySameDay(): Promise<void> {
  const settings = schedulerSettings();
  let runCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => false,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => undefined,
    persistSettings: async () => undefined,
    runMaintenance: async (invocation) => {
      runCount += 1;
      return preWalResult("canceled", invocation);
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  await scheduler.runScheduledIfDue();
  await scheduler.runScheduledIfDue();
  assert.equal(runCount, 1);
  assert.equal(settings.lastScheduledRunStatus, "canceled");
}

async function assertActiveRunStillPreventsConcurrentRetry(): Promise<void> {
  const settings = schedulerSettings({
    lastScheduledRunAt: todayAtMidnight(),
    lastScheduledRunStatus: "running"
  });
  let runCount = 0;
  const scheduler = new KnowledgeBaseScheduler({
    getSettings: () => settings,
    isRunning: () => true,
    registerInterval: () => undefined,
    waitUntilMaintenanceReady: async () => undefined,
    persistSettings: async () => undefined,
    runMaintenance: async () => {
      runCount += 1;
      return runResult("success");
    },
    appendScheduledMaintenanceMessage: async () => undefined,
    refreshKnowledgeBaseSurfaces: () => undefined
  });

  await scheduler.runScheduledIfDue();
  assert.equal(runCount, 0);
  assert.equal(settings.lastScheduledRunStatus, "running");
}

async function assertWalPersistedResultWaitsForRecovery(): Promise<void> {
  const settings = schedulerSettings();
  let persistCount = 0;
  let appendCount = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => undefined,
      persistSettings: async () => {
        persistCount += 1;
      },
      runMaintenance: async (invocation) =>
        walPersistedResult(invocation),
      appendScheduledMaintenanceMessage: async () => {
        appendCount += 1;
      },
      refreshKnowledgeBaseSurfaces: () => undefined
    });

    await scheduler.runScheduledIfDue();
    assert.equal(settings.lastScheduledRunStatus, "running");
    assert.match(
      settings.lastScheduledRunId,
      /^knowledge-maintain-scheduled-\d+$/
    );
    assert.equal(persistCount, 1);
    assert.equal(appendCount, 0);
    await scheduler.runScheduledIfDue(true);
    assert.equal(persistCount, 1);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
}

async function assertExternalRecoveryClearsPendingLatch(): Promise<void> {
  let settings = schedulerSettings();
  let runCount = 0;
  let persistCount = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const originalNow = Date.now;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => undefined,
      persistSettings: async () => {
        persistCount += 1;
      },
      runMaintenance: async (invocation) => {
        runCount += 1;
        if (runCount === 1) {
          return walPersistedResult(invocation);
        }
        return commitResult(settings, "success", invocation);
      },
      appendScheduledMaintenanceMessage: async () => undefined,
      refreshKnowledgeBaseSurfaces: () => undefined
    });

    const currentTime = originalNow();
    Date.now = () => currentTime - 24 * 60 * 60 * 1000;
    try {
      await scheduler.runScheduledIfDue();
    } finally {
      Date.now = originalNow;
    }
    const recoveredRunId = settings.lastScheduledRunId;
    const recoveredAt = settings.lastScheduledRunAt;
    settings = {
      ...settings,
      maintenanceHistory: []
    };
    const recoveredInvocation = {
      workflowRunId: recoveredRunId,
      scheduledStartedAt: recoveredAt
    };
    projectCommittedResult(
      settings,
      recoveredInvocation,
      committedResult("success", recoveredInvocation)
    );

    await scheduler.runScheduledIfDue(true);
    assert.equal(runCount, 2);
    assert.equal(persistCount, 2);
    assert.equal(settings.lastScheduledRunStatus, "success");
    assert.notEqual(settings.lastScheduledRunId, recoveredRunId);
    assert.equal(warnings.length, 1);
  } finally {
    Date.now = originalNow;
    console.warn = originalWarn;
  }
}

async function assertUntrustedPreWalResultsWaitForRecovery(): Promise<void> {
  const cases: Array<{
    label: string;
    result(invocation: ScheduledMaintenanceInvocation): KnowledgeBaseRunResult;
  }> = [
    {
      label: "pre-wal success",
      result: (invocation) => ({
        ...runResult("success"),
        workflowRunId: invocation.workflowRunId,
        terminalPhase: "preflight",
        commitState: "pre-wal"
      })
    },
    {
      label: "missing workflow id",
      result: () => ({
        ...runResult("failed"),
        terminalPhase: "preflight",
        commitState: "pre-wal"
      })
    },
    {
      label: "missing commit state",
      result: (invocation) => ({
        ...runResult("failed"),
        workflowRunId: invocation.workflowRunId,
        terminalPhase: "preflight"
      })
    }
  ];

  for (const testCase of cases) {
    const settings = schedulerSettings();
    let persistCount = 0;
    let runCount = 0;
    let appendCount = 0;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const scheduler = new KnowledgeBaseScheduler({
        getSettings: () => settings,
        isRunning: () => false,
        registerInterval: () => undefined,
        waitUntilMaintenanceReady: async () => undefined,
        persistSettings: async () => {
          persistCount += 1;
        },
        runMaintenance: async (invocation) => {
          runCount += 1;
          return testCase.result(invocation);
        },
        appendScheduledMaintenanceMessage: async () => {
          appendCount += 1;
        },
        refreshKnowledgeBaseSurfaces: () => undefined
      });

      await scheduler.runScheduledIfDue();
      await scheduler.runScheduledIfDue(true);
      assert.equal(settings.lastScheduledRunStatus, "running", testCase.label);
      assert.equal(runCount, 1, testCase.label);
      assert.equal(persistCount, 1, testCase.label);
      assert.equal(appendCount, 0, testCase.label);
      assert.equal(warnings.length, 1, testCase.label);
    } finally {
      console.warn = originalWarn;
    }
  }
}

async function assertPreWalTerminalPersistenceFailureWaitsForRecovery(): Promise<void> {
  const settings = schedulerSettings();
  let persistCount = 0;
  let runCount = 0;
  let appendCount = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => undefined,
      persistSettings: async () => {
        persistCount += 1;
        if (persistCount === 2) {
          throw new Error("terminal save failed");
        }
      },
      runMaintenance: async (invocation) => {
        runCount += 1;
        return preWalResult("failed", invocation);
      },
      appendScheduledMaintenanceMessage: async () => {
        appendCount += 1;
      },
      refreshKnowledgeBaseSurfaces: () => undefined
    });

    await scheduler.runScheduledIfDue();
    await scheduler.runScheduledIfDue(true);
    assert.equal(settings.lastScheduledRunStatus, "running");
    assert.equal(runCount, 1);
    assert.equal(persistCount, 2);
    assert.equal(appendCount, 0);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
}

async function assertCommittedProjectionMustMatchInvocation(): Promise<void> {
  const cases: Array<{
    label: string;
    result(
      settings: KnowledgeBaseSettings,
      invocation: ScheduledMaintenanceInvocation
    ): KnowledgeBaseRunResult;
  }> = [
    {
      label: "result run id",
      result: (_settings, invocation) => ({
        ...runResult("success"),
        workflowRunId: `${invocation.workflowRunId}-wrong`,
        terminalPhase: "finalized",
        commitState: "committed"
      })
    },
    {
      label: "settings run id",
      result: (settings, invocation) => {
        const result = committedResult("success", invocation);
        projectCommittedResult(settings, invocation, result);
        settings.lastScheduledRunId = `${invocation.workflowRunId}-wrong`;
        return result;
      }
    },
    {
      label: "settings started at",
      result: (settings, invocation) => {
        const result = committedResult("success", invocation);
        projectCommittedResult(settings, invocation, result);
        settings.lastScheduledRunAt = invocation.scheduledStartedAt + 1;
        return result;
      }
    },
    {
      label: "settings status",
      result: (settings, invocation) => {
        const result = committedResult("success", invocation);
        projectCommittedResult(settings, invocation, result);
        settings.lastScheduledRunStatus = "failed";
        return result;
      }
    },
    {
      label: "committed failure",
      result: (settings, invocation) => {
        settings.lastScheduledRunAt = invocation.scheduledStartedAt;
        settings.lastScheduledRunStatus = "failed";
        settings.lastScheduledRunId = invocation.workflowRunId;
        return committedResult("failed", invocation);
      }
    }
  ];

  for (const testCase of cases) {
    const settings = schedulerSettings();
    let appendCount = 0;
    let refreshCount = 0;
    let persistCount = 0;
    let runCount = 0;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const scheduler = new KnowledgeBaseScheduler({
        getSettings: () => settings,
        isRunning: () => false,
        registerInterval: () => undefined,
        waitUntilMaintenanceReady: async () => undefined,
        persistSettings: async () => {
          persistCount += 1;
        },
        runMaintenance: async (invocation) => {
          runCount += 1;
          return testCase.result(settings, invocation);
        },
        appendScheduledMaintenanceMessage: async () => {
          appendCount += 1;
        },
        refreshKnowledgeBaseSurfaces: () => {
          refreshCount += 1;
        }
      });

      await scheduler.runScheduledIfDue();
      await scheduler.runScheduledIfDue(true);
      assert.equal(runCount, 1, testCase.label);
      assert.equal(persistCount, 1, testCase.label);
      assert.equal(appendCount, 0, testCase.label);
      assert.equal(refreshCount, 0, testCase.label);
      assert.equal(warnings.length, 1, testCase.label);
    } finally {
      console.warn = originalWarn;
    }
  }
}

async function assertCommittedProjectionRequiresMatchingHistory(): Promise<void> {
  const cases: Array<{
    label: string;
    mutate(
      settings: KnowledgeBaseSettings,
      result: KnowledgeBaseDurableMaintenanceResult
    ): void;
  }> = [
    {
      label: "missing history",
      mutate: (settings) => {
        settings.maintenanceHistory = [];
      }
    },
    {
      label: "duplicate matching history",
      mutate: (settings, result) => {
        settings.maintenanceHistory.push(
          cloneHistory(projectedHistory(settings, result))
        );
      }
    },
    {
      label: "history status",
      mutate: (settings, result) => {
        projectedHistory(settings, result).status = "failed";
      }
    },
    {
      label: "history run id",
      mutate: (settings, result) => {
        projectedHistory(settings, result).runId =
          `${result.workflowRunId}-wrong`;
      }
    },
    {
      label: "history report path",
      mutate: (settings, result) => {
        projectedHistory(settings, result).reportPath = "outputs/wrong.md";
      }
    },
    {
      label: "history completion",
      mutate: (settings, result) => {
        projectedHistory(settings, result).completion = "partial";
      }
    },
    {
      label: "history selected backend",
      mutate: (settings, result) => {
        projectedHistory(settings, result).selectedBackend = "hermes";
      }
    },
    {
      label: "history winner backend",
      mutate: (settings, result) => {
        projectedHistory(settings, result).winnerBackend = "hermes";
      }
    },
    {
      label: "history attempts",
      mutate: (settings, result) => {
        const history = projectedHistory(settings, result);
        const attempt = history.attempts?.[0];
        assert.ok(attempt?.terminal);
        attempt.terminal.at += 1;
      }
    },
    {
      label: "history terminal phase",
      mutate: (settings, result) => {
        projectedHistory(settings, result).terminalPhase = "cleanup";
      }
    },
    {
      label: "history commit state",
      mutate: (settings, result) => {
        projectedHistory(settings, result).commitState = "pre-wal";
      }
    },
    {
      label: "history failure code",
      mutate: (settings, result) => {
        projectedHistory(settings, result).failureCode =
          "unexpected-success-error";
      }
    },
    {
      label: "history pending sources",
      mutate: (settings, result) => {
        projectedHistory(settings, result).pendingSources =
          ["raw/pending.md"];
      }
    },
    {
      label: "history warnings",
      mutate: (settings, result) => {
        projectedHistory(settings, result).warnings = [{
          id: "unexpected-warning",
          message: "unexpected"
        }];
      }
    }
  ];

  for (const testCase of cases) {
    const settings = schedulerSettings();
    let appendCount = 0;
    let refreshCount = 0;
    let persistCount = 0;
    let runCount = 0;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const scheduler = new KnowledgeBaseScheduler({
        getSettings: () => settings,
        isRunning: () => false,
        registerInterval: () => undefined,
        waitUntilMaintenanceReady: async () => undefined,
        persistSettings: async () => {
          persistCount += 1;
        },
        runMaintenance: async (invocation) => {
          runCount += 1;
          const result = committedResult("success", invocation);
          projectCommittedResult(settings, invocation, result);
          testCase.mutate(settings, result);
          return result;
        },
        appendScheduledMaintenanceMessage: async () => {
          appendCount += 1;
        },
        refreshKnowledgeBaseSurfaces: () => {
          refreshCount += 1;
        }
      });

      await scheduler.runScheduledIfDue();
      await scheduler.runScheduledIfDue(true);
      assert.equal(runCount, 1, testCase.label);
      assert.equal(persistCount, 1, testCase.label);
      assert.equal(appendCount, 0, testCase.label);
      assert.equal(refreshCount, 0, testCase.label);
      assert.equal(warnings.length, 1, testCase.label);
    } finally {
      console.warn = originalWarn;
    }
  }
}

async function assertRecoveryLatchRequiresCanonicalHistory(): Promise<void> {
  const cases: Array<{
    label: string;
    mutate(settings: KnowledgeBaseSettings, workflowRunId: string): void;
  }> = [
    {
      label: "missing history",
      mutate: (settings) => {
        settings.maintenanceHistory = [];
      }
    },
    {
      label: "missing selected backend",
      mutate: (settings, workflowRunId) => {
        delete projectedHistoryByRunId(settings, workflowRunId)
          .selectedBackend;
      }
    },
    {
      label: "missing winner backend",
      mutate: (settings, workflowRunId) => {
        delete projectedHistoryByRunId(settings, workflowRunId)
          .winnerBackend;
      }
    },
    {
      label: "missing attempts",
      mutate: (settings, workflowRunId) => {
        delete projectedHistoryByRunId(settings, workflowRunId).attempts;
      }
    },
    {
      label: "missing terminal phase",
      mutate: (settings, workflowRunId) => {
        delete projectedHistoryByRunId(settings, workflowRunId)
          .terminalPhase;
      }
    },
    {
      label: "missing failure code",
      mutate: (settings, workflowRunId) => {
        delete projectedHistoryByRunId(settings, workflowRunId).failureCode;
      }
    },
    {
      label: "missing commit state",
      mutate: (settings, workflowRunId) => {
        delete projectedHistoryByRunId(settings, workflowRunId).commitState;
      }
    },
    {
      label: "missing completion",
      mutate: (settings, workflowRunId) => {
        delete projectedHistoryByRunId(settings, workflowRunId).completion;
      }
    },
    {
      label: "invalid winner invariant",
      mutate: (settings, workflowRunId) => {
        projectedHistoryByRunId(settings, workflowRunId).winnerBackend = null;
      }
    }
  ];

  for (const testCase of cases) {
    const settings = schedulerSettings();
    let appendCount = 0;
    let persistCount = 0;
    let runCount = 0;
    const originalNow = Date.now;
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const scheduler = new KnowledgeBaseScheduler({
        getSettings: () => settings,
        isRunning: () => false,
        registerInterval: () => undefined,
        waitUntilMaintenanceReady: async () => undefined,
        persistSettings: async () => {
          persistCount += 1;
        },
        runMaintenance: async (invocation) => {
          runCount += 1;
          return runCount === 1
            ? walPersistedResult(invocation)
            : commitResult(settings, "success", invocation);
        },
        appendScheduledMaintenanceMessage: async () => {
          appendCount += 1;
        },
        refreshKnowledgeBaseSurfaces: () => undefined
      });

      const now = originalNow();
      Date.now = () => now - 24 * 60 * 60 * 1000;
      try {
        await scheduler.runScheduledIfDue();
      } finally {
        Date.now = originalNow;
      }
      const recoveredInvocation = {
        workflowRunId: settings.lastScheduledRunId,
        scheduledStartedAt: settings.lastScheduledRunAt
      };
      const recoveredResult = committedResult(
        "success",
        recoveredInvocation
      );
      projectCommittedResult(
        settings,
        recoveredInvocation,
        recoveredResult
      );
      testCase.mutate(settings, recoveredInvocation.workflowRunId);

      await scheduler.runScheduledIfDue(true);
      assert.equal(runCount, 1, testCase.label);
      assert.equal(persistCount, 1, testCase.label);
      assert.equal(appendCount, 0, testCase.label);
    } finally {
      Date.now = originalNow;
      console.warn = originalWarn;
    }
  }
}

async function assertPostRunEffectsCannotOverrideMaintenanceResult(): Promise<void> {
  const settings = schedulerSettings();
  let refreshCount = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => undefined,
      persistSettings: async () => undefined,
      runMaintenance: async (invocation) =>
        commitResult(settings, "success", invocation),
      appendScheduledMaintenanceMessage: async () => {
        throw new Error("notification unavailable");
      },
      refreshKnowledgeBaseSurfaces: () => {
        refreshCount += 1;
        throw new Error("surface unavailable");
      }
    });

    await assert.doesNotReject(() => scheduler.runScheduledIfDue());
    assert.equal(settings.lastScheduledRunStatus, "success");
    assert.equal(refreshCount, 1);
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
  }
}

async function assertThrownMaintenanceAttemptWaitsForRecovery(): Promise<void> {
  const settings = schedulerSettings();
  let runCount = 0;
  let persistCount = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const scheduler = new KnowledgeBaseScheduler({
      getSettings: () => settings,
      isRunning: () => false,
      registerInterval: () => undefined,
      waitUntilMaintenanceReady: async () => undefined,
      persistSettings: async () => {
        persistCount += 1;
      },
      runMaintenance: async (invocation) => {
        runCount += 1;
        if (runCount === 1) throw new Error("recoverable interruption");
        return commitResult(settings, "success", invocation);
      },
      appendScheduledMaintenanceMessage: async () => undefined,
      refreshKnowledgeBaseSurfaces: () => undefined
    });

    await assert.doesNotReject(() => scheduler.runScheduledIfDue());
    const crashedRunId = settings.lastScheduledRunId;
    assert.equal(settings.lastScheduledRunStatus, "running");
    assert.match(crashedRunId, /^knowledge-maintain-scheduled-\d+$/);
    await scheduler.runScheduledIfDue(true);
    assert.equal(runCount, 1);
    assert.equal(settings.lastScheduledRunStatus, "running");
    assert.equal(settings.lastScheduledRunId, crashedRunId);
    assert.equal(persistCount, 1);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
}

function schedulerSettings(overrides: Partial<KnowledgeBaseSettings> = {}): KnowledgeBaseSettings {
  return {
    enabled: true,
    scheduleTime: "00:00",
    catchUpOnStartup: true,
    lastRunAt: 0,
    lastRunStatus: "idle",
    lastScheduledRunAt: 0,
    lastScheduledRunStatus: "idle",
    lastScheduledRunId: "",
    maintenanceHistory: [],
    ...overrides
  } as KnowledgeBaseSettings;
}

function runResult(status: KnowledgeBaseRunResult["status"]): KnowledgeBaseRunResult {
  return {
    status,
    reportPath: "",
    summary: "",
    processedSources: []
  };
}

function preWalResult(
  status: "failed" | "canceled",
  invocation: {
    workflowRunId: string;
    scheduledStartedAt: number;
  }
): KnowledgeBaseRunResult {
  return {
    ...runResult(status),
    workflowRunId: invocation.workflowRunId,
    selectedBackend: "codex-cli",
    winnerBackend: null,
    terminalPhase: "preflight",
    commitState: "pre-wal",
    attempts: [],
    failureCode: status === "canceled"
      ? "cancelled"
      : "scheduled-maintenance-failed"
  };
}

function walPersistedResult(
  invocation: ScheduledMaintenanceInvocation
): KnowledgeBaseRunResult {
  return {
    ...runResult("failed"),
    workflowRunId: invocation.workflowRunId,
    selectedBackend: "codex-cli",
    winnerBackend: "codex-cli",
    terminalPhase: "commit",
    commitState: "wal-persisted",
    completion: "full",
    attempts: [{
      attemptId: `${invocation.workflowRunId}:attempt:1:codex-cli`,
      ordinal: 1,
      backend: "codex-cli",
      terminal: {
        status: "completed",
        at: invocation.scheduledStartedAt
      }
    }],
    failureCode: "maintenance-commit-pending"
  };
}

function commitResult(
  settings: KnowledgeBaseSettings,
  status: KnowledgeBaseRunResult["status"],
  invocation: ScheduledMaintenanceInvocation
): KnowledgeBaseRunResult {
  const result = committedResult(status, invocation);
  projectCommittedResult(settings, invocation, result);
  return result;
}

function projectCommittedResult(
  settings: KnowledgeBaseSettings,
  invocation: ScheduledMaintenanceInvocation,
  result: KnowledgeBaseDurableMaintenanceResult
): void {
  settings.lastScheduledRunAt = invocation.scheduledStartedAt;
  settings.lastScheduledRunStatus = result.status;
  settings.lastScheduledRunId = invocation.workflowRunId;
  settings.maintenanceHistory = [{
    date: new Date(invocation.scheduledStartedAt)
      .toISOString()
      .slice(0, 10),
    status: result.status,
    at: invocation.scheduledStartedAt,
    runId: result.workflowRunId,
    mode: "maintain",
    reportPath: result.reportPath,
    ...(result.completion ? { completion: result.completion } : {}),
    selectedBackend: result.selectedBackend,
    winnerBackend: result.winnerBackend,
    attempts: cloneJson(result.attempts),
    ...(result.pendingSources?.length
      ? { pendingSources: [...result.pendingSources] }
      : {}),
    failureCode: result.failureCode,
    terminalPhase: result.terminalPhase,
    commitState: result.commitState,
    ...(result.warnings?.length
      ? { warnings: cloneJson(result.warnings) }
      : {})
  }];
}

function committedResult(
  status: KnowledgeBaseRunResult["status"],
  invocation: ScheduledMaintenanceInvocation
): KnowledgeBaseDurableMaintenanceResult {
  const attempt = {
    attemptId: `${invocation.workflowRunId}:attempt:1:codex-cli`,
    ordinal: 1,
    backend: "codex-cli" as const,
    terminal: {
      status: "completed" as const,
      at: invocation.scheduledStartedAt
    }
  };
  return {
    ...runResult(status),
    workflowRunId: invocation.workflowRunId,
    selectedBackend: "codex-cli",
    winnerBackend: status === "success" ? "codex-cli" : null,
    terminalPhase: "finalized",
    commitState: "committed",
    attempts: status === "success" ? [attempt] : [],
    ...(status === "success" ? { completion: "full" as const } : {}),
    failureCode: status === "success"
      ? null
      : "invalid-committed-failure"
  };
}

function projectedHistory(
  settings: KnowledgeBaseSettings,
  result: KnowledgeBaseDurableMaintenanceResult
): KnowledgeBaseMaintenanceHistoryEntry {
  return projectedHistoryByRunId(settings, result.workflowRunId);
}

function projectedHistoryByRunId(
  settings: KnowledgeBaseSettings,
  workflowRunId: string
): KnowledgeBaseMaintenanceHistoryEntry {
  const history = settings.maintenanceHistory.find(
    (entry) => entry.runId === workflowRunId
  );
  assert.ok(history);
  return history;
}

function cloneHistory(
  history: KnowledgeBaseMaintenanceHistoryEntry
): KnowledgeBaseMaintenanceHistoryEntry {
  return cloneJson(history);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function todayAtMidnight(): number {
  const today = new Date();
  today.setHours(0, 0, 1, 0);
  return today.getTime();
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
