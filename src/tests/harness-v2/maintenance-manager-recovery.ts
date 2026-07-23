import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
  MaintenanceWorkflowSettingsHost,
  MaintenanceWorkflowSettingsSnapshot
} from "../../harness/maintenance/workflow-wal";
import {
  createActiveMaintenanceRunJournal,
  listActiveMaintenanceRunJournals
} from "../../harness/maintenance/active-run-journal";
import { KnowledgeBaseManager } from "../../knowledge-base/manager";
import { runSelectedMaintenanceAgentTask } from "../../knowledge-base/maintenance-runner";
import type { KnowledgeBaseTurnOptionOverrides } from "../../knowledge-base/command-router";
import type { SettingsSaveOptions } from "../../plugin/settings-store";
import {
  DEFAULT_SETTINGS,
  normalizeSettingsData,
  recordKnowledgeBaseMaintenanceRun,
  type CodexForObsidianSettings
} from "../../settings/settings";
import type { KnowledgeBaseRunResult } from "../../knowledge-base/types";

interface RegisteredManagerCommand {
  id: string;
  callback: () => unknown;
}

interface ManagerRoutingCall {
  mode: string;
  userRequest: string;
  selectedBackend: string;
  workflowRunId: string;
  readinessChecks: string[];
  executedBackends: string[];
  turnOptions: KnowledgeBaseTurnOptionOverrides;
}

interface ManagerFixture {
  manager: KnowledgeBaseManager;
  vaultPath: string;
  workflowStorageRoot: string;
  settings: CodexForObsidianSettings;
  releaseNativeRecovery(): void;
  nativeRecoveryStarted: Promise<void>;
  nativeRecoveryCalls(): number;
  nativeSnapshotCalls(): number;
  nativeRecoveryInputs: Array<{ recordIds?: readonly string[] }>;
  workflowRecoveryCalls(): number;
  saveCalls(): number;
  saveOptions: Array<SettingsSaveOptions | undefined>;
  surfaceRefreshCalls(): number;
  runnerCalls: Array<{ selectedBackend: string }>;
  routingCalls: ManagerRoutingCall[];
  commands: RegisteredManagerCommand[];
  layoutReadyCallbacks: Array<() => void>;
  dispose(): Promise<void>;
}

export async function runMaintenanceManagerRecoveryTests(): Promise<void> {
  await assertActiveRunJournalWithoutAttemptsKeepsZeroEvidence();
  await assertIncompleteHistoryCannotSuppressActiveJournalRecovery();
  await assertRecoveredTerminalProjectsToMaintenanceUi();
  await assertOrphanedUiRunUsesPersistedBackendWithoutAttempt();
  await assertOrphanedRunningStateReconcilesOnlyAfterRecovery();
  await assertAllMaintenanceEntrypointsShareSelectedFirstHarness();
  await assertSelectedAgentFreezesBeforeRecoveryGate();
  await assertExistingTerminalHistorySettlesScheduledCrashWithoutOverwrite();
  await assertActiveRunJournalRestoresExactPreWalProvenance();
  await assertPendingRecoveryScopesOnlyWriteAuthority();
  await assertWalPersistedStartsInProcessRecoveryWithoutAgentReplay();
  await assertInProcessRecoveryBlocksOnIncompleteNativeSettlement();
  await assertInProcessRecoveryWaitsForActiveWriteAuthority();
  await assertUnloadClosesNewWritesAndDrainsIssuedAuthority();
  await assertInvalidWalBlocksEveryNewAgentAttempt();
  await assertExplicitCommandRetriesRejectedRecoveryGate();
}

async function assertWalPersistedStartsInProcessRecoveryWithoutAgentReplay(): Promise<void> {
  const fixture = await createFixture();
  let maintenanceCalls = 0;
  const settledNativeRunIds: string[][] = [];
  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
    assert.equal(fixture.nativeRecoveryCalls(), 1);

    (fixture.manager as unknown as {
      agentTaskService: {
        settlePendingNativeExecutionsForRunIds(runIds: readonly string[]): Promise<{
          requestedRunIds: string[];
          matchedRunIds: string[];
          matchedRecordCount: number;
          localCommitStatus: "committed";
          cleanupRecoveryRequired: boolean;
          disposedCount: number;
        }>;
      };
    }).agentTaskService.settlePendingNativeExecutionsForRunIds = async (runIds) => {
      settledNativeRunIds.push([...runIds]);
      return {
        requestedRunIds: [...runIds],
        matchedRunIds: [...runIds],
        matchedRecordCount: runIds.length,
        localCommitStatus: "committed",
        cleanupRecoveryRequired: true,
        disposedCount: 0
      };
    };

    (fixture.manager as unknown as {
      maintenanceRunner: {
        runMaintenance(): Promise<KnowledgeBaseRunResult>;
      };
    }).maintenanceRunner.runMaintenance = async () => {
      maintenanceCalls += 1;
      return {
        status: "failed",
        reportPath: "outputs/maintenance/pending.md",
        summary: "",
        processedSources: [],
        workflowRunId: "knowledge-maintain-in-process-recovery",
        selectedBackend: "opencode",
        winnerBackend: "codex-cli",
        attempts: [
          {
            attemptId: "knowledge-maintain-in-process-recovery-attempt-1-opencode",
            ordinal: 1,
            backend: "opencode",
            submitted: {
              at: 1,
              harnessRunId: "knowledge-maintain-in-process-harness-failed"
            },
            terminal: {
              status: "failed",
              at: 2,
              message: "provider disconnected after submission"
            },
            failure: {
              code: "provider-disconnected",
              at: 2,
              message: "provider disconnected after submission",
              phase: "execution",
              retryable: true,
              failoverEligible: true
            }
          },
          {
            attemptId: "knowledge-maintain-in-process-recovery-attempt-2-codex-cli",
            ordinal: 2,
            backend: "codex-cli",
            submitted: {
              at: 3,
              harnessRunId: "knowledge-maintain-in-process-harness-winner"
            },
            terminal: {
              status: "completed",
              at: 4
            }
          }
        ],
        completion: "full",
        terminalPhase: "commit",
        commitState: "wal-persisted",
        failureCode: "maintenance-commit-pending",
        error: "WAL prepared"
      };
    };

    const result = await fixture.manager.runMaintenance(
      "maintain",
      "/maintain",
      { workflowRunId: "knowledge-maintain-in-process-recovery" }
    );
    assert.equal(result.commitState, "wal-persisted");
    assert.equal(maintenanceCalls, 1, "WAL recovery must not rerun the Agent");
    await waitForCondition(
      () => fixture.workflowRecoveryCalls() === 2
        && fixture.manager.maintenanceRecoveryStatus.state === "ready",
      "the current process must run one shared WAL recovery pass"
    );
    assert.equal(maintenanceCalls, 1, "recovery replay must remain Agent-free");
    assert.deepEqual(settledNativeRunIds, [[
      "knowledge-maintain-in-process-harness-failed",
      "knowledge-maintain-in-process-harness-winner"
    ]]);
    assert.equal(
      fixture.nativeRecoveryCalls(),
      1,
      "in-process WAL replay must not run startup-only native reconciliation"
    );
  } finally {
    await fixture.dispose();
  }
}

async function assertInProcessRecoveryBlocksOnIncompleteNativeSettlement(): Promise<void> {
  const cases = [
    {
      label: "missing scoped Native record",
      matchedRunIds: [] as string[],
      localCommitStatus: "committed" as const,
      expected: /缺少匹配记录/
    },
    {
      label: "failed durable local commit",
      matchedRunIds: ["knowledge-maintain-incomplete-native"],
      localCommitStatus: "failed" as const,
      expected: /本地终态尚未耐久/
    }
  ];
  for (const testCase of cases) {
    const fixture = await createFixture();
    try {
      fixture.manager.register();
      await fixture.nativeRecoveryStarted;
      fixture.releaseNativeRecovery();
      await (fixture.manager as unknown as {
        waitUntilMaintenanceReady(): Promise<void>;
      }).waitUntilMaintenanceReady();

      (fixture.manager as unknown as {
        agentTaskService: {
          settlePendingNativeExecutionsForRunIds(runIds: readonly string[]): Promise<{
            requestedRunIds: string[];
            matchedRunIds: string[];
            matchedRecordCount: number;
            localCommitStatus: "committed" | "failed";
            cleanupRecoveryRequired: boolean;
            disposedCount: number;
          }>;
        };
      }).agentTaskService.settlePendingNativeExecutionsForRunIds = async (runIds) => ({
        requestedRunIds: [...runIds],
        matchedRunIds: [...testCase.matchedRunIds],
        matchedRecordCount: testCase.matchedRunIds.length,
        localCommitStatus: testCase.localCommitStatus,
        cleanupRecoveryRequired: false,
        disposedCount: 0
      });

      (fixture.manager as unknown as {
        startInProcessMaintenanceRecovery(result: KnowledgeBaseRunResult): void;
      }).startInProcessMaintenanceRecovery({
        status: "failed",
        reportPath: "outputs/maintenance/pending.md",
        summary: "",
        processedSources: [],
        workflowRunId: `knowledge-maintain-${testCase.label}`,
        selectedBackend: "codex-cli",
        winnerBackend: "codex-cli",
        attempts: [{
          attemptId: "knowledge-maintain-incomplete-native-attempt-1-codex-cli",
          ordinal: 1,
          backend: "codex-cli",
          submitted: {
            at: 1,
            harnessRunId: "knowledge-maintain-incomplete-native"
          },
          terminal: {
            status: "completed",
            at: 2
          }
        }],
        terminalPhase: "commit",
        commitState: "wal-persisted"
      });

      await waitForCondition(
        () => fixture.manager.maintenanceRecoveryStatus.state === "blocked",
        `${testCase.label} must keep maintenance recovery blocked`
      );
      assert.match(
        fixture.manager.maintenanceRecoveryStatus.message,
        testCase.expected
      );
      assert.equal(
        fixture.nativeRecoveryCalls(),
        1,
        "in-process settlement failure must not invoke startup reconciliation"
      );
    } finally {
      await fixture.dispose();
    }
  }
}

async function assertInProcessRecoveryWaitsForActiveWriteAuthority(): Promise<void> {
  const fixture = await createFixture();
  const captureStarted = deferred();
  const releaseCapture = deferred();
  let captureCalls = 0;
  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
    assert.equal(fixture.workflowRecoveryCalls(), 1);
    assert.equal(fixture.nativeRecoveryCalls(), 1);
    assert.equal(fixture.nativeSnapshotCalls(), 1);
    assert.deepEqual(
      fixture.nativeRecoveryInputs[0]?.recordIds,
      ["knowledge-native-before-startup"],
      "startup native reconciliation must use the exact pre-start record snapshot"
    );

    (fixture.manager as unknown as {
      captureService: {
        captureLink(): Promise<string[]>;
      };
    }).captureService.captureLink = async () => {
      captureCalls += 1;
      if (captureCalls === 1) {
        captureStarted.resolve();
        await releaseCapture.promise;
      }
      return [`raw/articles/capture-${captureCalls}.md`];
    };

    const activeCapture = fixture.manager.captureLink();
    await captureStarted.promise;
    (fixture.manager as unknown as {
      startInProcessMaintenanceRecovery(result: KnowledgeBaseRunResult): void;
    }).startInProcessMaintenanceRecovery({
      status: "failed",
      reportPath: "outputs/maintenance/pending.md",
      summary: "",
      processedSources: [],
      workflowRunId: "knowledge-maintain-authority-drain",
      selectedBackend: "codex-cli",
      winnerBackend: "codex-cli",
      attempts: [],
      terminalPhase: "commit",
      commitState: "wal-persisted"
    });
    const blockedCapture = fixture.manager.captureLink();

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(
      fixture.manager.maintenanceRecoveryStatus.state,
      "pending"
    );
    assert.equal(
      fixture.workflowRecoveryCalls(),
      1,
      "WAL replay must wait for the already-issued write authority"
    );
    assert.equal(
      captureCalls,
      1,
      "new writes must not enter while WAL replay owns authority"
    );

    releaseCapture.resolve();
    await activeCapture;
    await waitForCondition(
      () => fixture.workflowRecoveryCalls() === 2
        && fixture.manager.maintenanceRecoveryStatus.state === "ready",
      "WAL replay must start after the prior write authority drains"
    );
    await blockedCapture;
    assert.equal(captureCalls, 2);
    assert.equal(
      fixture.nativeRecoveryCalls(),
      1,
      "in-process replay must preserve live knowledge native executions"
    );
  } finally {
    releaseCapture.resolve();
    await fixture.dispose();
  }
}

async function assertUnloadClosesNewWritesAndDrainsIssuedAuthority(): Promise<void> {
  const fixture = await createFixture();
  const captureStarted = deferred();
  const releaseCapture = deferred();
  let captureCalls = 0;
  let unloadSettled = false;
  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();

    (fixture.manager as unknown as {
      captureService: {
        captureLink(): Promise<string[]>;
      };
    }).captureService.captureLink = async () => {
      captureCalls += 1;
      captureStarted.resolve();
      await releaseCapture.promise;
      return ["raw/articles/capture-before-unload.md"];
    };

    const activeCapture = fixture.manager.captureLink();
    await captureStarted.promise;
    const unload = fixture.manager.unload().then(() => {
      unloadSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(
      unloadSettled,
      false,
      "unload must wait for write authority already issued before disposal"
    );
    await assert.rejects(
      () => fixture.manager.captureLink(),
      /知识库管理器已卸载/
    );
    const runnerCallsBefore = fixture.runnerCalls.length;
    const maintenance = await fixture.manager.runMaintenance("maintain");
    assert.equal(maintenance.status, "failed");
    assert.match(maintenance.error ?? "", /知识库管理器已卸载/);
    assert.equal(
      fixture.runnerCalls.length,
      runnerCallsBefore,
      "a stale command callback must not start an Agent after unload"
    );
    assert.equal(captureCalls, 1);

    releaseCapture.resolve();
    await activeCapture;
    await unload;
    assert.equal(unloadSettled, true);
  } finally {
    releaseCapture.resolve();
    await fixture.dispose();
  }
}

async function assertIncompleteHistoryCannotSuppressActiveJournalRecovery(): Promise<void> {
  const startedAt = Date.now() - 2_000;
  const workflowRunId = "knowledge-maintain-active-with-incomplete-history";
  const fixture = await createFixture({
    lastRunAt: startedAt,
    lastRunStatus: "running",
    maintenanceHistory: [{
      date: new Date(startedAt).toISOString().slice(0, 10),
      status: "success",
      at: startedAt + 1,
      runId: workflowRunId,
      mode: "maintain",
      reportPath: "outputs/maintenance/incomplete.md",
      completion: "full"
    }]
  });
  await createActiveMaintenanceRunJournal({
    storageRootPath: fixture.workflowStorageRoot,
    workflowRunId,
    mode: "maintain",
    startedAt,
    selectedBackend: "hermes",
    attempts: [],
    terminalPhase: "preflight"
  });

  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    const matching = fixture.settings.knowledgeBase.maintenanceHistory.filter(
      (entry) => entry.runId === workflowRunId
    );
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.status, "failed");
    assert.equal(matching[0]?.selectedBackend, "hermes");
    assert.equal(matching[0]?.winnerBackend, null);
    assert.deepEqual(matching[0]?.attempts, []);
    assert.equal(
      matching[0]?.failureCode,
      "orphaned-active-run-before-wal"
    );
    assert.equal(matching[0]?.terminalPhase, "recovery-blocked");
    assert.equal(matching[0]?.commitState, "pre-wal");
    assert.deepEqual(
      await listActiveMaintenanceRunJournals(
        fixture.workflowStorageRoot
      ),
      []
    );

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
  } finally {
    await fixture.dispose();
  }
}

async function assertAllMaintenanceEntrypointsShareSelectedFirstHarness(): Promise<void> {
  const fixture = await createFixture({
    enabled: true,
    scheduleTime: "00:00",
    catchUpOnStartup: true,
    lastScheduledRunAt: 0,
    lastScheduledRunStatus: "idle",
    lastScheduledRunId: ""
  });
  const previousWindow = (globalThis as { window?: unknown }).window;
  let intervalId = 900;
  (globalThis as { window?: unknown }).window = {
    setInterval: () => ++intervalId,
    clearInterval: () => undefined
  };
  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();

    // Chat /maintain freezes synchronously when Manager starts. A selector
    // change while the ready Promise yields applies only to the next run.
    fixture.settings.agentBackend = "opencode";
    const chatRun = fixture.manager.handleUserMessage("/maintain");
    fixture.settings.agentBackend = "hermes";
    const chatResult = await chatRun;
    assert.equal(chatResult.status, "success");
    assert.equal(fixture.routingCalls.length, 1);
    assert.equal(fixture.routingCalls[0]?.selectedBackend, "opencode");

    // Command-palette callback uses the same Manager/Runner path and freezes
    // the selector before its first await.
    const maintainCommand = fixture.commands.find((command) =>
      command.id === "knowledge-base-maintain-now"
    );
    assert.ok(maintainCommand, "maintenance command-palette entry must be registered");
    maintainCommand.callback();
    fixture.settings.agentBackend = "codex-cli";
    await waitForRoutingCalls(fixture, 2);
    assert.equal(fixture.routingCalls[1]?.selectedBackend, "hermes");

    // A scheduled trigger performs its durable prelude first. The selection
    // is frozen only when it actually enters Manager.runMaintenance.
    resetScheduledState(fixture.settings);
    const scheduledRun = (fixture.manager as unknown as {
      runScheduledIfDue(forceCatchUp?: boolean): Promise<void>;
    }).runScheduledIfDue(true);
    fixture.settings.agentBackend = "opencode";
    await scheduledRun;
    assert.equal(fixture.routingCalls.length, 3);
    assert.equal(fixture.routingCalls[2]?.selectedBackend, "opencode");

    // Layout-ready startup catch-up also routes through the same scheduler and
    // freezes the Agent only when the real maintenance run starts.
    // Keep the prior durable timestamp while reopening the synthetic fixture.
    // The scheduler's monotonic run-id guarantee is based on that baseline;
    // clearing it would make two same-millisecond test triggers indistinguishable.
    fixture.settings.knowledgeBase.lastScheduledRunStatus = "failed";
    fixture.settings.knowledgeBase.scheduledAttemptCount = 1;
    fixture.settings.knowledgeBase.scheduledNextRetryAt = Date.now() - 1;
    const layoutReady = fixture.layoutReadyCallbacks[0];
    assert.ok(layoutReady, "layout-ready startup callback must be registered");
    layoutReady();
    fixture.settings.agentBackend = "hermes";
    await waitForRoutingCalls(fixture, 4);
    assert.equal(fixture.routingCalls[3]?.selectedBackend, "hermes");

    assert.deepEqual(
      fixture.routingCalls.map((call) => ({
        mode: call.mode,
        selectedBackend: call.selectedBackend,
        executedBackends: call.executedBackends,
        readinessChecks: call.readinessChecks
      })),
      [
        {
          mode: "maintain",
          selectedBackend: "opencode",
          executedBackends: ["opencode"],
          readinessChecks: []
        },
        {
          mode: "maintain",
          selectedBackend: "hermes",
          executedBackends: ["hermes"],
          readinessChecks: []
        },
        {
          mode: "maintain",
          selectedBackend: "opencode",
          executedBackends: ["opencode"],
          readinessChecks: []
        },
        {
          mode: "maintain",
          selectedBackend: "hermes",
          executedBackends: ["hermes"],
          readinessChecks: []
        }
      ],
      "all four entrypoints must share selected-first routing; selected success cannot inspect standby readiness"
    );
    assert.match(
      fixture.routingCalls[2]?.workflowRunId ?? "",
      /^knowledge-maintain-scheduled-/
    );
    assert.match(
      fixture.routingCalls[3]?.workflowRunId ?? "",
      /^knowledge-maintain-scheduled-/
    );
    assert.notEqual(
      fixture.routingCalls[2]?.workflowRunId,
      fixture.routingCalls[3]?.workflowRunId
    );
  } finally {
    await fixture.manager.unload().catch(() => undefined);
    (globalThis as { window?: unknown }).window = previousWindow;
    await fixture.dispose();
  }
}

async function assertActiveRunJournalRestoresExactPreWalProvenance(): Promise<void> {
  const startedAt = Date.now() - 2_000;
  const workflowRunId = "knowledge-maintain-active-pre-wal";
  const fixture = await createFixture({
    lastRunAt: startedAt,
    lastRunStatus: "running"
  });
  await createActiveMaintenanceRunJournal({
    storageRootPath: fixture.workflowStorageRoot,
    workflowRunId,
    mode: "maintain",
    startedAt,
    selectedBackend: "hermes",
    attempts: [{
      attemptId: `${workflowRunId}:attempt:1:hermes`,
      ordinal: 1,
      backend: "hermes",
      submitted: {
        at: startedAt + 100,
        harnessRunId: "native-hermes-active"
      }
    }],
    terminalPhase: "execution"
  });
  fixture.settings.agentBackend = "codex-cli";

  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    const history = fixture.settings.knowledgeBase.maintenanceHistory.find(
      (entry) => entry.runId === workflowRunId
    );
    assert.equal(history?.selectedBackend, "hermes");
    assert.equal(history?.winnerBackend, null);
    assert.equal(history?.terminalPhase, "recovery-blocked");
    assert.equal(history?.failureCode, "orphaned-active-run-before-wal");
    assert.equal(history?.attempts?.length, 1);
    assert.equal(history?.attempts?.[0]?.backend, "hermes");
    assert.equal(history?.attempts?.[0]?.terminal?.status, "failed");
    assert.equal(
      history?.attempts?.some((attempt) =>
        attempt.attemptId.includes("startup-recovery")),
      false,
      "active journal recovery must not fabricate an Agent attempt"
    );
    assert.deepEqual(
      await listActiveMaintenanceRunJournals(
        fixture.workflowStorageRoot
      ),
      []
    );

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
  } finally {
    await fixture.dispose();
  }
}

async function assertActiveRunJournalWithoutAttemptsKeepsZeroEvidence(): Promise<void> {
  const startedAt = Date.now() - 2_000;
  const workflowRunId = "knowledge-maintain-active-before-attempt";
  const fixture = await createFixture({
    lastRunAt: startedAt,
    lastRunStatus: "running"
  });
  const session = fixture.settings.sessions[0]!;
  session.messages.push(
    {
      id: "active-zero-user",
      role: "user",
      text: "/maintain",
      backendId: "hermes",
      modelId: "hermes/selected-model",
      profileId: "hermes-profile",
      runId: workflowRunId,
      createdAt: startedAt
    },
    {
      id: "active-zero-assistant",
      role: "assistant",
      text: "正在维护",
      itemType: "knowledgeBase",
      status: "running",
      backendId: "hermes",
      modelId: "hermes/selected-model",
      profileId: "hermes-profile",
      runId: workflowRunId,
      knowledgeBaseUi: {
        kind: "maintain-run",
        mode: "maintain",
        title: "知识库维护",
        subtitle: "阶段进度见下方",
        icon: "archive",
        phases: []
      },
      createdAt: startedAt + 1
    }
  );
  await createActiveMaintenanceRunJournal({
    storageRootPath: fixture.workflowStorageRoot,
    workflowRunId,
    mode: "maintain",
    startedAt,
    selectedBackend: "hermes",
    attempts: [],
    terminalPhase: "preflight"
  });
  fixture.settings.agentBackend = "codex-cli";

  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    const history = fixture.settings.knowledgeBase.maintenanceHistory.find(
      (entry) => entry.runId === workflowRunId
    );
    assert.equal(history?.selectedBackend, "hermes");
    assert.equal(history?.winnerBackend, null);
    assert.equal(history?.commitState, "pre-wal");
    assert.deepEqual(
      history?.attempts,
      [],
      "an active journal created before attempt 1 must remain zero-attempt evidence"
    );
    for (const message of session.messages.filter(
      (candidate) => candidate.runId === workflowRunId
    )) {
      assert.equal(message.backendId, undefined);
      assert.equal(message.modelId, undefined);
      assert.equal(message.profileId, undefined);
    }
    const assistant = session.messages.find(
      (message) => message.id === "active-zero-assistant"
    );
    assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-run");
    assert.equal(assistant?.status, "failed");
    assert.equal(assistant?.runTerminalRecovered, true);
    const terminal = session.messages.find((message) =>
      message.id !== assistant?.id
      && message.runId === workflowRunId
      && message.runTerminalRecovered === true
      && message.knowledgeBaseUi?.kind === "maintain-report"
    );
    assert.ok(terminal, "startup recovery must append a durable terminal card");
    if (terminal.knowledgeBaseUi?.kind === "maintain-report") {
      assert.equal(terminal.knowledgeBaseUi.selectedBackend, "hermes");
      assert.equal(terminal.knowledgeBaseUi.winnerBackend, null);
      assert.deepEqual(terminal.knowledgeBaseUi.attempts, []);
    }

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
  } finally {
    await fixture.dispose();
  }
}

async function assertExistingTerminalHistorySettlesScheduledCrashWithoutOverwrite(): Promise<void> {
  const runId = "knowledge-maintain-scheduled-pre-wal-terminal";
  const scheduledStartedAt = Date.now() - 2_000;
  const terminalAt = scheduledStartedAt + 1_000;
  const fixture = await createFixture({
    lastRunAt: scheduledStartedAt,
    lastRunStatus: "failed",
    lastScheduledRunAt: scheduledStartedAt,
    lastScheduledRunStatus: "running",
    lastScheduledRunId: runId,
    lastFailureCode: "backend-unavailable",
    maintenanceHistory: [{
      date: new Date(terminalAt).toISOString().slice(0, 10),
      status: "failed",
      at: terminalAt,
      runId,
      mode: "maintain",
      reportPath: "",
      selectedBackend: "opencode",
      winnerBackend: null,
      failureCode: "backend-unavailable",
      terminalPhase: "recovery-blocked",
      commitState: "pre-wal",
      phase: "preflight",
      errorCode: "BACKEND_UNAVAILABLE",
      attempts: [{
        attemptId: `${runId}:attempt:1:opencode`,
        ordinal: 1,
        backend: "opencode",
        terminal: {
          status: "failed",
          at: terminalAt,
          message: "backend unavailable"
        },
        failure: {
          code: "backend-unavailable",
          at: terminalAt,
          message: "backend unavailable",
          phase: "preflight",
          retryable: true,
          failoverEligible: true
        }
      }]
    }]
  });
  fixture.settings.sessions[0]!.messages.push({
    id: "scheduled-terminal-user",
    role: "user",
    text: "/maintain",
    runId,
    createdAt: scheduledStartedAt
  });

  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    assert.equal(
      fixture.settings.knowledgeBase.lastScheduledRunStatus,
      "failed"
    );
    assert.equal(fixture.settings.knowledgeBase.lastScheduledRunId, runId);
    assert.equal(fixture.settings.knowledgeBase.maintenanceHistory.length, 1);
    const history = fixture.settings.knowledgeBase.maintenanceHistory[0];
    assert.equal(history?.runId, runId);
    assert.equal(history?.selectedBackend, "opencode");
    assert.equal(history?.winnerBackend, null);
    assert.equal(history?.terminalPhase, "recovery-blocked");
    assert.equal(history?.commitState, "pre-wal");
    assert.equal(history?.failureCode, "backend-unavailable");
    assert.equal(history?.phase, "preflight");
    assert.equal(history?.errorCode, "BACKEND_UNAVAILABLE");
    assert.equal(history?.attempts?.[0]?.failure?.phase, "preflight");
    assert.equal(
      fixture.settings.sessions[0]!.messages.length,
      2,
      "a crash-rehydrated Conversation containing only the user command must append its recovered terminal"
    );
    assert.equal(
      fixture.settings.sessions[0]!.messages[0]?.id,
      "scheduled-terminal-user"
    );
    const terminal = fixture.settings.sessions[0]!.messages[1];
    assert.match(
      terminal?.id ?? "",
      /^knowledge-maintenance-recovery-[a-f0-9]{64}$/
    );
    assert.equal(terminal?.runId, runId);
    assert.equal(terminal?.runTerminalRecovered, true);
    assert.equal(terminal?.knowledgeBaseUi?.kind, "maintain-report");
    assert.match(terminal?.text ?? "", /恢复后确认失败/);
    assert.equal(fixture.saveCalls(), 1);
    assert.deepEqual(fixture.saveOptions, [{
      flushConversationStore: true,
      flushKnowledgeBaseHistory: false
    }]);

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
  } finally {
    await fixture.dispose();
  }
}

async function assertSelectedAgentFreezesBeforeRecoveryGate(): Promise<void> {
  const fixture = await createFixture();
  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    assert.equal(fixture.manager.isRunning, false);
    assert.deepEqual(fixture.manager.maintenanceRecoveryStatus, {
      state: "pending",
      message: "正在恢复上次知识库维护；尚未启动新的写入 Agent。普通对话、/ask、/history、/clear 和 /help 仍可使用。"
    });

    const overrides = {
      workflowRunId: "knowledge-maintain-frozen-before-await",
      workspaceResources: {
        plugins: { "maintenance-plugin": true },
        mcpServers: { "maintenance-mcp": true },
        skills: { "maintenance-skill": true }
      },
      harnessSession: {
        id: "maintenance-session",
        title: "Frozen session",
        cwd: fixture.vaultPath,
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }
    };
    const pending = fixture.manager.runMaintenance(
      "maintain",
      "",
      overrides
    );
    fixture.settings.agentBackend = "hermes";
    overrides.workflowRunId = "knowledge-maintain-mutated-after-call";
    overrides.workspaceResources.plugins["maintenance-plugin"] = false;
    overrides.workspaceResources.mcpServers["late-mcp"] = true;
    overrides.harnessSession.title = "Mutated session";
    await Promise.resolve();
    assert.deepEqual(fixture.runnerCalls, []);

    fixture.releaseNativeRecovery();
    const result = await pending;
    assert.equal(result.status, "success");
    assert.deepEqual(fixture.runnerCalls, [{ selectedBackend: "opencode" }]);
    assert.equal(
      fixture.routingCalls[0]?.workflowRunId,
      "knowledge-maintain-frozen-before-await"
    );
    assert.deepEqual(
      fixture.routingCalls[0]?.turnOptions.workspaceResources,
      {
        plugins: { "maintenance-plugin": true },
        mcpServers: { "maintenance-mcp": true },
        skills: { "maintenance-skill": true }
      }
    );
    assert.equal(
      fixture.routingCalls[0]?.turnOptions.harnessSession?.title,
      "Frozen session"
    );
    assert.equal(fixture.manager.isRunning, false);
    assert.equal(fixture.manager.maintenanceRecoveryStatus.state, "ready");
    assert.equal(fixture.surfaceRefreshCalls(), 2);
  } finally {
    await fixture.dispose();
  }
}

async function assertOrphanedRunningStateReconcilesOnlyAfterRecovery(): Promise<void> {
  const fixture = await createFixture({
    lastRunStatus: "running",
    lastScheduledRunStatus: "running",
    lastScheduledRunId: "knowledge-maintain-scheduled-orphaned"
  });
  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    assert.equal(fixture.settings.knowledgeBase.lastRunStatus, "failed");
    assert.equal(fixture.settings.knowledgeBase.lastScheduledRunStatus, "failed");
    assert.equal(fixture.saveCalls(), 1);
    assert.equal(fixture.nativeRecoveryCalls(), 1);
    const history = fixture.settings.knowledgeBase.maintenanceHistory.at(-1);
    assert.equal(history?.status, "failed");
    assert.equal(history?.mode, "maintain");
    assert.equal(
      history?.runId,
      "knowledge-maintain-scheduled-orphaned"
    );
    assert.equal(history?.phase, "scheduled-running");
    assert.equal(history?.errorCode, "orphaned-running-without-wal");
    assert.equal(history?.failureCode, "orphaned-running-without-wal");
    assert.equal(history?.selectedBackend, undefined);
    assert.equal(history?.winnerBackend, null);
    assert.equal(history?.commitState, "pre-wal");
    assert.deepEqual(
      history?.attempts ?? [],
      [],
      "a running flag without WAL, journal, or attempt evidence must not fabricate attempt 0"
    );

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
    assert.equal(fixture.manager.isRunning, false);
  } finally {
    await fixture.dispose();
  }
}

async function assertRecoveredTerminalProjectsToMaintenanceUi(): Promise<void> {
  const fixture = await createFixture();
  const runId = "kb-run-recovered-terminal";
  const recoveredAt = Date.now() - 1_000;
  const session = fixture.settings.sessions[0]!;
  session.messages.push(
    {
      id: "recovered-user",
      role: "user",
      text: "/maintain",
      backendId: "codex-cli",
      modelId: "codex/selected-model",
      profileId: "codex-profile",
      runId,
      createdAt: recoveredAt - 100
    },
    {
      id: "recovered-assistant",
      role: "assistant",
      text: "正在维护",
      itemType: "knowledgeBase",
      status: "running",
      backendId: "codex-cli",
      modelId: "codex/selected-model",
      profileId: "codex-profile",
      runId,
      knowledgeBaseUi: {
        kind: "maintain-run",
        mode: "maintain",
        title: "知识库维护",
        subtitle: "阶段进度见下方",
        icon: "archive",
        phases: []
      },
      createdAt: recoveredAt
    },
    {
      id: "recovered-thinking",
      role: "assistant",
      text: "",
      itemType: "thinking",
      status: "running",
      backendId: "codex-cli",
      modelId: "codex/selected-model",
      profileId: "codex-profile",
      runId,
      createdAt: recoveredAt + 1
    }
  );
  fixture.settings.knowledgeBase.lastRunAt = recoveredAt;
  fixture.settings.knowledgeBase.lastRunStatus = "success";
  fixture.settings.knowledgeBase.lastSummary = "WAL replay completed";
  fixture.settings.knowledgeBase.maintenanceHistory.push({
    date: new Date(recoveredAt).toISOString().slice(0, 10),
    status: "success",
    at: recoveredAt,
    runId,
    mode: "maintain",
    reportPath: "outputs/maintenance/recovered.md",
    completion: "recovered",
    selectedBackend: "codex-cli",
    winnerBackend: "opencode",
    attempts: [
      {
        attemptId: `${runId}:attempt:1:codex-cli`,
        ordinal: 1,
        backend: "codex-cli",
        terminal: {
          status: "failed",
          at: recoveredAt - 10
        }
      },
      {
        attemptId: `${runId}:attempt:2:opencode`,
        ordinal: 2,
        backend: "opencode",
        terminal: {
          status: "completed",
          at: recoveredAt
        }
      }
    ],
    failureCode: null,
    terminalPhase: "finalized",
    commitState: "committed"
  });

  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    const assistant = session.messages.find((message) =>
      message.id === "recovered-assistant"
    );
    assert.equal(assistant?.status, "completed");
    assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-run");
    assert.match(assistant?.text ?? "", /已从上次中断中恢复/);
    assert.equal(assistant?.backendId, "opencode");
    assert.equal(assistant?.modelId, undefined);
    assert.equal(assistant?.profileId, undefined);
    const user = session.messages.find((message) =>
      message.id === "recovered-user"
    );
    assert.equal(user?.backendId, "opencode");
    assert.equal(user?.modelId, undefined);
    assert.equal(user?.profileId, undefined);
    const terminal = session.messages.find((message) =>
      message.id !== assistant?.id
      && message.runId === runId
      && message.runTerminalRecovered === true
      && message.knowledgeBaseUi?.kind === "maintain-report"
    );
    assert.ok(terminal, "recovery must append a terminal report card");
    assert.match(terminal.text, /已从上次中断中恢复/);
    assert.equal(terminal.backendId, "opencode");
    assert.equal(terminal.modelId, undefined);
    assert.equal(terminal.profileId, undefined);
    if (terminal.knowledgeBaseUi?.kind === "maintain-report") {
      assert.equal(terminal.knowledgeBaseUi.selectedBackend, "codex-cli");
      assert.equal(terminal.knowledgeBaseUi.winnerBackend, "opencode");
      assert.equal(terminal.knowledgeBaseUi.backend, "opencode");
    }
    const thinking = session.messages.find((message) =>
      message.id === "recovered-thinking"
    );
    assert.ok(thinking, "recovery must not delete an already-durable prefix");
    assert.equal(thinking.status, "recovery-pending");
    assert.equal(thinking.backendId, "opencode");
    assert.equal(thinking.modelId, undefined);
    assert.equal(thinking.profileId, undefined);
    assert.equal(fixture.saveCalls(), 1);

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
    assert.equal(fixture.manager.isRunning, false);
  } finally {
    await fixture.dispose();
  }
}

async function assertOrphanedUiRunUsesPersistedBackendWithoutAttempt(): Promise<void> {
  const fixture = await createFixture();
  const runId = "kb-run-orphaned-ui-with-provenance";
  const session = fixture.settings.sessions[0]!;
  session.messages.push({
    id: "orphaned-ui-assistant",
    role: "assistant",
    text: "正在维护",
    itemType: "knowledgeBase",
    status: "running",
    backendId: "hermes",
    modelId: "hermes/persisted-model",
    profileId: "hermes-profile",
    runId,
    knowledgeBaseUi: {
      kind: "maintain-run",
      mode: "maintain",
      title: "知识库维护",
      subtitle: "阶段进度见下方",
      icon: "archive",
      phases: []
    },
    createdAt: Date.now() - 1_000
  });
  fixture.settings.agentBackend = "opencode";

  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;
    const history = fixture.settings.knowledgeBase.maintenanceHistory.find(
      (entry) => entry.runId === runId
    );
    assert.equal(
      history?.selectedBackend,
      "hermes",
      "the persisted run message may prove selected provenance; the current selector may not"
    );
    assert.equal(history?.winnerBackend, null);
    assert.equal(history?.commitState, "pre-wal");
    assert.deepEqual(history?.attempts, []);
    const assistant = session.messages.find(
      (message) => message.id === "orphaned-ui-assistant"
    );
    assert.equal(assistant?.backendId, undefined);
    assert.equal(assistant?.modelId, undefined);
    assert.equal(assistant?.profileId, undefined);
    assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-run");
    assert.equal(assistant?.status, "failed");
    assert.equal(assistant?.runTerminalRecovered, true);
    const terminal = session.messages.find((message) =>
      message.id !== assistant?.id
      && message.runId === runId
      && message.runTerminalRecovered === true
      && message.knowledgeBaseUi?.kind === "maintain-report"
    );
    assert.ok(terminal, "orphan recovery must append a terminal report card");
    if (terminal.knowledgeBaseUi?.kind === "maintain-report") {
      assert.equal(terminal.knowledgeBaseUi.selectedBackend, "hermes");
      assert.equal(terminal.knowledgeBaseUi.winnerBackend, null);
      assert.deepEqual(terminal.knowledgeBaseUi.attempts, []);
    }

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
  } finally {
    await fixture.dispose();
  }
}

async function assertPendingRecoveryScopesOnlyWriteAuthority(): Promise<void> {
  const fixture = await createFixture();
  let captureCalls = 0;
  let askCalls = 0;
  (fixture.manager as unknown as {
    captureService: {
      captureChatInput(): Promise<string[]>;
    };
  }).captureService.captureChatInput = async () => {
    captureCalls += 1;
    return ["inbox/forbidden-history-capture.md"];
  };
  (fixture.manager as unknown as {
    queryJournalService: {
      answerQuestion(): Promise<{ status: "success"; message: string }>;
    };
  }).queryJournalService.answerQuestion = async () => {
    askCalls += 1;
    return { status: "success", message: "只读回答" };
  };
  try {
    fixture.manager.register();
    await fixture.nativeRecoveryStarted;

    const help = await fixture.manager.handleUserMessage("/help", [], {
      workflowRunId: "kb-help-during-recovery"
    });
    assert.equal(help.status, "success");
    assert.match(help.message, /知识库管理频道快捷命令/);

    const history = await fixture.manager.handleUserMessage("/history", [], {
      workflowRunId: "kb-history-during-recovery"
    });
    assert.equal(history.status, "success");
    assert.match(history.message, /本地历史视图/);
    assert.equal(
      captureCalls,
      0,
      "/history must never fall through to capture"
    );
    assert.doesNotMatch(history.message, /已收集到|没有可收集的内容/);

    const cleared = await fixture.manager.handleUserMessage("/clear", [], {
      workflowRunId: "kb-clear-during-recovery"
    });
    assert.equal(cleared.status, "success");
    assert.match(cleared.message, /本地清空/);
    assert.equal(captureCalls, 0);

    const chat = await fixture.manager.handleUserMessage("解释当前状态", [], {
      workflowRunId: "kb-chat-during-recovery"
    });
    assert.equal(chat.status, "success");
    assert.match(chat.message, /普通 Agent 对话/);

    const asked = await fixture.manager.handleUserMessage("/ask 恢复到哪了", [], {
      workflowRunId: "kb-agent-command-during-recovery"
    });
    assert.equal(asked.status, "success");
    assert.equal(asked.message, "只读回答");
    assert.equal(askCalls, 1);
    assert.deepEqual(fixture.runnerCalls, []);
    assert.equal(captureCalls, 0);
    assert.equal(
      fixture.nativeRecoveryCalls(),
      1,
      "safe commands must not start or retry maintenance recovery"
    );

    const writeCommands = [
      "/init",
      "/maintain",
      "/check",
      "/reingest",
      "/calibrate",
      "/outputs",
      "/inbox",
      "/journal",
      "/week",
      "记一下：恢复后再处理"
    ];
    for (const command of writeCommands) {
      const blocked = await fixture.manager.handleUserMessage(command, [], {
        workflowRunId: `kb-write-during-recovery-${writeCommands.indexOf(command)}`
      });
      assert.equal(blocked.status, "failed", command);
      assert.equal(blocked.maintenanceRecoveryState, "pending", command);
    }
    assert.deepEqual(fixture.runnerCalls, []);
    assert.equal(captureCalls, 0);

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
  } finally {
    await fixture.dispose();
  }
}

async function assertInvalidWalBlocksEveryNewAgentAttempt(): Promise<void> {
  const fixture = await createFixture({
    lastRunStatus: "running",
    lastScheduledRunStatus: "running"
  });
  const walRoot = path.join(fixture.workflowStorageRoot, "workflow-wal");
  await mkdir(walRoot, { recursive: true });
  await writeFile(path.join(walRoot, "unsafe-entry.txt"), "invalid", "utf8");
  fixture.settings.sessions[0]!.messages.push({
    id: "blocked-maintenance-ui",
    role: "assistant",
    text: "仍在等待恢复",
    itemType: "knowledgeBase",
    status: "running",
    runId: "kb-run-blocked-wal",
    knowledgeBaseUi: {
      kind: "maintain-run",
      mode: "maintain",
      title: "知识库维护",
      subtitle: "阶段进度见下方",
      icon: "archive",
      phases: []
    },
    createdAt: Date.now()
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  let askCalls = 0;
  let calibrationCalls = 0;
  let captureCalls = 0;
  (fixture.manager as unknown as {
    queryJournalService: {
      answerQuestion(): Promise<{ status: "success"; message: string }>;
    };
  }).queryJournalService.answerQuestion = async () => {
    askCalls += 1;
    return { status: "success", message: "blocked recovery read" };
  };
  (fixture.manager as unknown as {
    rawDigestCalibrationRunner: {
      calibrateRawDigestStatus(): Promise<KnowledgeBaseRunResult>;
    };
  }).rawDigestCalibrationRunner.calibrateRawDigestStatus = async () => {
    calibrationCalls += 1;
    return {
      status: "success",
      reportPath: "",
      summary: "unexpected",
      processedSources: []
    };
  };
  (fixture.manager as unknown as {
    captureService: {
      captureLink(): Promise<string[]>;
    };
  }).captureService.captureLink = async () => {
    captureCalls += 1;
    return ["raw/articles/unexpected.md"];
  };
  try {
    fixture.manager.register();
    const result = await fixture.manager.runMaintenance("maintain");
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "maintenance-recovery-blocked");
    assert.match(result.workflowRunId ?? "", /^knowledge-maintain-\d+$/);
    assert.equal(result.selectedBackend, "opencode");
    assert.equal(result.winnerBackend, null);
    assert.deepEqual(result.attempts, []);
    assert.equal(result.terminalPhase, "recovery-blocked");
    assert.equal(result.commitState, "pre-wal");
    assert.match(result.error ?? "", /恢复被阻断/);
    assert.deepEqual(fixture.runnerCalls, []);
    assert.equal(fixture.nativeRecoveryCalls(), 0);
    assert.equal(fixture.saveCalls(), 0);
    assert.equal(fixture.settings.knowledgeBase.lastRunStatus, "running");
    assert.equal(fixture.settings.knowledgeBase.lastScheduledRunStatus, "running");
    assert.equal(
      fixture.settings.sessions[0]!.messages.at(-1)?.status,
      "recovery-blocked"
    );
    assert.equal(
      fixture.settings.sessions[0]!.messages.at(-1)?.runId,
      "kb-run-blocked-wal"
    );
    assert.match(
      fixture.settings.sessions[0]!.messages.at(-1)?.text ?? "",
      /尚未启动新的写入 Agent/
    );
    assert.equal(fixture.manager.isRunning, false);
    assert.equal(fixture.manager.maintenanceRecoveryStatus.state, "blocked");
    assert.match(fixture.manager.maintenanceRecoveryStatus.message, /恢复被阻断/);
    assert.equal(fixture.surfaceRefreshCalls(), 2);
    assert.ok(errors.length >= 1);

    const safeAsk = await fixture.manager.handleUserMessage("/ask 恢复为何失败");
    assert.equal(safeAsk.status, "success");
    assert.equal(safeAsk.message, "blocked recovery read");
    assert.equal(askCalls, 1);
    assert.equal(
      fixture.nativeRecoveryCalls(),
      0,
      "read-only ask must not retry a rejected recovery gate"
    );
    assert.deepEqual(fixture.runnerCalls, []);

    const calibration = await fixture.manager.calibrateRawDigestStatus();
    assert.equal(calibration.status, "failed");
    assert.equal(calibration.failureCode, "maintenance-recovery-blocked");
    assert.equal(calibrationCalls, 0);
    assert.equal(fixture.nativeRecoveryCalls(), 0);

    await assert.rejects(
      fixture.manager.captureLink(),
      /恢复被阻断/
    );
    assert.equal(captureCalls, 0);
    assert.equal(fixture.nativeRecoveryCalls(), 0);
  } finally {
    console.error = originalError;
    await fixture.dispose();
  }
}

async function assertExplicitCommandRetriesRejectedRecoveryGate(): Promise<void> {
  const fixture = await createFixture();
  const walRoot = path.join(fixture.workflowStorageRoot, "workflow-wal");
  const invalidPath = path.join(walRoot, "unsafe-entry.txt");
  await mkdir(walRoot, { recursive: true });
  await writeFile(invalidPath, "invalid", "utf8");
  const originalError = console.error;
  console.error = () => undefined;
  try {
    fixture.manager.register();
    const first = await fixture.manager.runMaintenance("maintain");
    assert.equal(first.status, "failed");
    assert.equal(
      fixture.manager.maintenanceRecoveryStatus.state,
      "blocked"
    );
    await rm(invalidPath, { force: true });
    fixture.releaseNativeRecovery();

    const retried = await fixture.manager.handleUserMessage("/maintain", [], {
      workflowRunId: "kb-maintenance-after-recovery-retry"
    });
    assert.equal(retried.status, "success");
    assert.equal(
      fixture.manager.maintenanceRecoveryStatus.state,
      "ready"
    );
    assert.equal(fixture.nativeRecoveryCalls(), 1);
    assert.equal(
      fixture.nativeSnapshotCalls(),
      1,
      "startup retry must reuse the exact original Native record snapshot"
    );
    assert.equal(fixture.runnerCalls.length, 1);
  } finally {
    console.error = originalError;
    await fixture.dispose();
  }
}

async function createFixture(
  knowledgeOverrides: Partial<CodexForObsidianSettings["knowledgeBase"]> = {}
): Promise<ManagerFixture> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-manager-gate-"));
  const vaultPath = path.join(rootPath, "vault");
  const workflowStorageRoot = path.join(rootPath, "maintenance-storage");
  await Promise.all([
    mkdir(vaultPath, { recursive: true }),
    mkdir(workflowStorageRoot, { recursive: true, mode: 0o700 })
  ]);
  const settings = normalizeSettingsData({
    ...cloneSettings(DEFAULT_SETTINGS),
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    agentBackend: "opencode",
    knowledgeBase: {
      ...cloneSettings(DEFAULT_SETTINGS).knowledgeBase,
      ...knowledgeOverrides
    },
    sessions: [{
      id: "knowledge-session",
      title: "知识库管理",
      kind: "knowledge-base",
      cwd: vaultPath,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }]
  }).settings;
  let saveCallCount = 0;
  const saveOptions: Array<SettingsSaveOptions | undefined> = [];
  let nativeCallCount = 0;
  let nativeSnapshotCallCount = 0;
  let workflowRecoveryCallCount = 0;
  let surfaceRefreshCallCount = 0;
  const startupNativeRecordIds = ["knowledge-native-before-startup"];
  const nativeRecoveryInputs: Array<{ recordIds?: readonly string[] }> = [];
  const nativeStarted = deferred();
  const nativeRelease = deferred();
  const layoutReadyCallbacks: Array<() => void> = [];
  const runnerCalls: Array<{ selectedBackend: string }> = [];
  const routingCalls: ManagerRoutingCall[] = [];
  const commands: RegisteredManagerCommand[] = [];
  const plugin = {
    settings,
    getVaultPath: () => vaultPath,
    getKnowledgeBaseWorkflowStorageRoot: () => workflowStorageRoot,
    getKnowledgeBaseWorkflowSettingsHost: () => {
      workflowRecoveryCallCount += 1;
      return unusedSettingsHost(settings.knowledgeBase);
    },
    isEchoInkConversationStoreV2MigrationRequired: () => false,
    saveSettings: async (
      _notify = true,
      options?: SettingsSaveOptions
    ) => {
      saveCallCount += 1;
      saveOptions.push(options ? { ...options } : undefined);
    },
    snapshotPendingNativeExecutionRecordIdsForRecovery: async () => {
      nativeSnapshotCallCount += 1;
      return [...startupNativeRecordIds];
    },
    failPendingNativeExecutionsForRecovery: async (input: { recordIds?: readonly string[] }) => {
      nativeCallCount += 1;
      nativeRecoveryInputs.push({
        ...(input.recordIds ? { recordIds: [...input.recordIds] } : {})
      });
      nativeStarted.resolve();
      await nativeRelease.promise;
      return 0;
    },
    getCodexView: () => null,
    refreshKnowledgeBaseSurfaces: () => {
      surfaceRefreshCallCount += 1;
    },
    getReviewManager: () => null,
    externalizeMessageText: async () => undefined,
    pruneKnowledgeBaseHistoryByRetention: async () => ({
      removedDayCount: 0,
      removedMessageCount: 0
    }),
    activateKnowledgeBaseChannel: async () => undefined,
    addCommand: (command: RegisteredManagerCommand) => {
      commands.push(command);
    },
    addRibbonIcon: () => undefined,
    registerInterval: () => undefined,
    app: {
      workspace: {
        onLayoutReady: (callback: () => void) => {
          layoutReadyCallbacks.push(callback);
        },
        getActiveFile: () => null
      }
    }
  };
  const manager = new KnowledgeBaseManager(plugin as never);
  (manager as unknown as {
    maintenanceRunner: {
      runMaintenance(
        mode: string,
        userRequest: string,
        overrides: unknown,
        selectedBackend: string
      ): Promise<KnowledgeBaseRunResult>;
    };
  }).maintenanceRunner.runMaintenance = async (
    mode,
    userRequest,
    overrides,
    selectedBackend
  ) => {
    const invocation = (overrides ?? {}) as {
      workflowRunId?: string;
      scheduledStartedAt?: number;
    } & KnowledgeBaseTurnOptionOverrides;
    const workflowRunId = invocation.workflowRunId?.trim()
      || `manager-fixture-${routingCalls.length + 1}`;
    const readinessChecks: string[] = [];
    const executedBackends: string[] = [];
    const attempts: any[] = [];
    const routed = await runSelectedMaintenanceAgentTask({
      workflowRunId,
      selectedBackend: selectedBackend as "codex-cli" | "opencode" | "hermes",
      attempts,
      isBackendReady: async (backend) => {
        readinessChecks.push(backend);
        return true;
      },
      execute: async (attempt) => {
        executedBackends.push(attempt.backend);
        return {
          output: {
            text: "ok",
            harnessRunId: `harness-${attempt.backend}`,
            submittedAt: Date.now()
          },
          completion: "full",
          verifiedSources: [],
          pendingSources: [],
          evidencePaths: {},
          handle: {} as never,
          changeSet: {} as never,
          allowPaths: [],
          reportPath: "",
          conflictDuplicateCleanup: { moved: [], backupRoot: "" },
          skippedAgentIndexPaths: [],
          reconciliationIndexPaths: [],
          warnings: []
        };
      }
    });
    runnerCalls.push({ selectedBackend });
    routingCalls.push({
      mode,
      userRequest,
      selectedBackend,
      workflowRunId,
      readinessChecks,
      executedBackends,
      turnOptions: structuredClone(invocation)
    });
    if (invocation.scheduledStartedAt !== undefined) {
      recordKnowledgeBaseMaintenanceRun(settings.knowledgeBase, {
        status: "success",
        mode: "maintain",
        at: invocation.scheduledStartedAt,
        runId: workflowRunId,
        reportPath: "",
        completion: routed.completion,
        selectedBackend: selectedBackend as
          | "codex-cli"
          | "opencode"
          | "hermes",
        winnerBackend: routed.attempt.backend,
        attempts,
        pendingSources: [],
        failureCode: null,
        terminalPhase: "finalized",
        commitState: "committed",
        warnings: []
      });
      settings.knowledgeBase.lastScheduledRunAt = invocation.scheduledStartedAt;
      settings.knowledgeBase.lastScheduledRunId = workflowRunId;
      settings.knowledgeBase.lastScheduledRunStatus = "success";
    }
    return {
      status: "success",
      reportPath: "",
      summary: "ok",
      processedSources: [],
      workflowRunId,
      selectedBackend: selectedBackend as "codex-cli" | "opencode" | "hermes",
      winnerBackend: routed.attempt.backend,
      terminalPhase: "finalized",
      commitState: "committed",
      attempts,
      completion: routed.completion,
      failureCode: null
    };
  };
  return {
    manager,
    vaultPath,
    workflowStorageRoot,
    settings,
    releaseNativeRecovery: nativeRelease.resolve,
    nativeRecoveryStarted: nativeStarted.promise,
    nativeRecoveryCalls: () => nativeCallCount,
    nativeSnapshotCalls: () => nativeSnapshotCallCount,
    nativeRecoveryInputs,
    workflowRecoveryCalls: () => workflowRecoveryCallCount,
    saveCalls: () => saveCallCount,
    saveOptions,
    surfaceRefreshCalls: () => surfaceRefreshCallCount,
    runnerCalls,
    routingCalls,
    commands,
    layoutReadyCallbacks,
    dispose: async () => {
      nativeRelease.resolve();
      await rm(rootPath, { recursive: true, force: true });
    }
  };
}

function resetScheduledState(settings: CodexForObsidianSettings): void {
  settings.knowledgeBase.lastScheduledRunAt = 0;
  settings.knowledgeBase.lastScheduledRunStatus = "idle";
  settings.knowledgeBase.lastScheduledRunId = "";
  settings.knowledgeBase.scheduledAttemptCount = 0;
  settings.knowledgeBase.scheduledNextRetryAt = 0;
}

async function waitForRoutingCalls(
  fixture: ManagerFixture,
  count: number
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (fixture.routingCalls.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(
    fixture.routingCalls.length,
    count,
    `expected ${count} maintenance Runner calls`
  );
}

async function waitForCondition(
  predicate: () => boolean,
  message: string
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, message);
}

function unusedSettingsHost<T extends MaintenanceWorkflowSettingsSnapshot>(
  settings: T
): MaintenanceWorkflowSettingsHost<T> {
  return {
    withExclusiveTransaction: async (action) => await action({
      readWithGeneration: async () => ({
        settings: cloneValue(settings),
        generation: "sha256:unused"
      }),
      persistCas: async (_generation, target) => ({
        settings: cloneValue(target),
        generation: "sha256:unused-persisted"
      })
    })
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cloneSettings(
  settings: CodexForObsidianSettings
): CodexForObsidianSettings {
  return cloneValue(settings);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
