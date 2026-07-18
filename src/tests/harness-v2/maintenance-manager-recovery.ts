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
  saveCalls(): number;
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
  await assertPendingRecoveryAllowsHelpButBlocksAgentCommands();
  await assertInvalidWalBlocksEveryNewAgentAttempt();
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
    assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-report");
    if (assistant?.knowledgeBaseUi?.kind === "maintain-report") {
      assert.equal(assistant.knowledgeBaseUi.selectedBackend, "hermes");
      assert.equal(assistant.knowledgeBaseUi.winnerBackend, null);
      assert.deepEqual(assistant.knowledgeBaseUi.attempts, []);
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
    assert.equal(fixture.saveCalls(), 1);

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
      message: "正在恢复上次知识库维护；尚未启动新的 Agent。/history 和 /help 仍可使用。"
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
    assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-report");
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
    if (assistant?.knowledgeBaseUi?.kind === "maintain-report") {
      assert.equal(assistant.knowledgeBaseUi.selectedBackend, "codex-cli");
      assert.equal(assistant.knowledgeBaseUi.winnerBackend, "opencode");
      assert.equal(assistant.knowledgeBaseUi.backend, "opencode");
    }
    assert.equal(
      session.messages.some((message) =>
        message.id === "recovered-thinking"),
      false
    );
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
    assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-report");
    if (assistant?.knowledgeBaseUi?.kind === "maintain-report") {
      assert.equal(assistant.knowledgeBaseUi.selectedBackend, "hermes");
      assert.equal(assistant.knowledgeBaseUi.winnerBackend, null);
      assert.deepEqual(assistant.knowledgeBaseUi.attempts, []);
    }

    fixture.releaseNativeRecovery();
    await (fixture.manager as unknown as {
      waitUntilMaintenanceReady(): Promise<void>;
    }).waitUntilMaintenanceReady();
  } finally {
    await fixture.dispose();
  }
}

async function assertPendingRecoveryAllowsHelpButBlocksAgentCommands(): Promise<void> {
  const fixture = await createFixture();
  let captureCalls = 0;
  (fixture.manager as unknown as {
    captureService: {
      captureChatInput(): Promise<string[]>;
    };
  }).captureService.captureChatInput = async () => {
    captureCalls += 1;
    return ["inbox/forbidden-history-capture.md"];
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
    assert.equal(history.status, "failed");
    assert.equal(history.maintenanceRecoveryState, "pending");
    assert.equal(history.workflowRunId, "kb-history-during-recovery");
    assert.match(history.message, /尚未启动新的 Agent/);
    assert.equal(
      captureCalls,
      0,
      "/history is handled by the local composer; Manager must fail closed instead of falling through to capture"
    );
    assert.doesNotMatch(history.message, /已收集到|没有可收集的内容/);

    const blocked = await fixture.manager.handleUserMessage("/ask 恢复到哪了", [], {
      workflowRunId: "kb-agent-command-during-recovery"
    });
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.maintenanceRecoveryState, "pending");
    assert.equal(blocked.workflowRunId, "kb-agent-command-during-recovery");
    assert.match(blocked.message, /尚未启动新的 Agent/);
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
      /尚未启动新的 Agent/
    );
    assert.equal(fixture.manager.isRunning, false);
    assert.equal(fixture.manager.maintenanceRecoveryStatus.state, "blocked");
    assert.match(fixture.manager.maintenanceRecoveryStatus.message, /恢复被阻断/);
    assert.equal(fixture.surfaceRefreshCalls(), 2);
    assert.ok(errors.length >= 1);
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
  let nativeCallCount = 0;
  let surfaceRefreshCallCount = 0;
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
    getKnowledgeBaseWorkflowSettingsHost: () =>
      unusedSettingsHost(settings.knowledgeBase),
    saveSettings: async () => {
      saveCallCount += 1;
    },
    failPendingNativeExecutionsForRecovery: async () => {
      nativeCallCount += 1;
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
    saveCalls: () => saveCallCount,
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
