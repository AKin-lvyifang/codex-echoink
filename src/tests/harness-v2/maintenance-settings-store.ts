import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MaintenanceWorkflowWalError } from "../../harness/maintenance/workflow-wal";
import {
  EchoInkSettingsStore,
  settingsForDataSave,
  type SettingsSaveOptions
} from "../../plugin/settings-store";
import {
  DEFAULT_SETTINGS,
  canonicalizeKnowledgeBaseMaintenanceHistoryEntry,
  normalizeSettingsData,
  type CodexForObsidianSettings,
  type KnowledgeBaseMaintenanceHistoryEntry,
  type KnowledgeBaseSettings
} from "../../settings/settings";

interface SettingsStoreFixture {
  store: EchoInkSettingsStore;
  plugin: {
    settings: CodexForObsidianSettings;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    getVaultPath(): string;
    getPluginDataDirName(): string;
    settleHarnessRunTerminal(input: { runId: string }): Promise<void>;
  };
  persistedKnowledgeBase(): KnowledgeBaseSettings;
  replacePersistedKnowledgeBase(settings: KnowledgeBaseSettings): void;
  blockNextSave(): {
    started: Promise<void>;
    release(): void;
  };
  saveCalls(): number;
  settledRunIds(): string[];
  dispose(): Promise<void>;
}

export async function runMaintenanceSettingsStoreTests(): Promise<void> {
  assertAttemptFailurePhaseNormalization();
  assertOpaqueNativeAndOptionalTerminationNormalization();
  assertScheduledRunIdNormalization();
  await assertGenerationCasPersistsAndReplacesMemory();
  await assertCanonicalDurableHistoryRoundTripsAndReplays();
  await assertOversizeDurableMetadataCanonicalizesAndReplays();
  await assertGenerationCasRejectsConcurrentPersistentChange();
  await assertGenerationCasRejectsUnqueuedMemoryChange();
  await assertReadbackMismatchDoesNotReplaceMemory();
  await assertWorkflowTransactionSharesTheOrdinarySaveQueue();
  await assertStartupRecoveryDefersKnowledgeMaintenanceUi();
}

async function assertOversizeDurableMetadataCanonicalizesAndReplays(): Promise<void> {
  const fixture = await createFixture();
  try {
    const completedAt = Date.parse("2026-07-18T09:00:00.000Z");
    const longMessage = "终".repeat(700);
    const overlongPendingPath = `raw/${"p".repeat(1_100)}.md`;
    const canonical =
      canonicalizeKnowledgeBaseMaintenanceHistoryEntry({
        date: "2026-07-18",
        status: "success",
        at: completedAt,
        runId: "settings-roundtrip-oversize",
        mode: "maintain",
        reportPath:
          "outputs/maintenance/settings-roundtrip-oversize.md",
        completion: "partial",
        selectedBackend: "opencode",
        winnerBackend: "codex-cli",
        attempts: [{
          attemptId: "settings-roundtrip-oversize:attempt:1:opencode",
          ordinal: 1,
          backend: "opencode",
          terminal: {
            status: "failed",
            at: completedAt - 20,
            message: longMessage
          },
          failure: {
            code: "backend-timeout",
            at: completedAt - 20,
            message: longMessage,
            phase: "execution",
            retryable: true,
            failoverEligible: true
          },
          termination: {
            requestedAt: completedAt - 19,
            confirmedAt: completedAt - 18,
            message: longMessage
          },
          staging: {
            path: "staging/attempt-1",
            preparedAt: completedAt - 30,
            discardedAt: completedAt - 17,
            message: longMessage
          }
        }, {
          attemptId: "settings-roundtrip-oversize:attempt:2:codex-cli",
          ordinal: 2,
          backend: "codex-cli",
          terminal: {
            status: "completed",
            at: completedAt,
            message: longMessage
          }
        }],
        pendingSources: [
          "raw/pending.md",
          "raw\\pending.md",
          overlongPendingPath
        ],
        failureCode: null,
        terminalPhase: "finalized",
        commitState: "committed",
        warnings: Array.from({ length: 11 }, (_, index) => ({
          id: `warning-${index + 1}`,
          message: `${index + 1}:${longMessage}`
        }))
      });
    assert.ok(canonical);
    assert.equal(canonical.attempts?.[0]?.terminal?.message?.length, 500);
    assert.equal(canonical.attempts?.[0]?.failure?.message.length, 500);
    assert.equal(canonical.attempts?.[0]?.termination?.message?.length, 500);
    assert.equal(canonical.attempts?.[0]?.staging?.message?.length, 500);
    assert.equal(canonical.attempts?.[1]?.terminal?.message?.length, 500);
    assert.equal(canonical.warnings?.length, 10);
    assert.ok(canonical.warnings?.every(
      (warning) => warning.message.length === 500
    ));
    assert.deepEqual(canonical.pendingSources?.slice(0, 1), [
      "raw/pending.md"
    ]);
    assert.equal(canonical.pendingSources?.length, 2);
    assert.equal(canonical.pendingSources?.[1]?.length, 1000);

    const first = await fixture.store.withExclusiveTransaction(
      async (transaction) => {
        const before = await transaction.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastRunAt = completedAt;
        target.lastRunStatus = "success";
        target.lastReportPath = canonical.reportPath;
        target.lastSummary = "canonical metadata persisted";
        target.lastCompletion = canonical.completion ?? "";
        target.lastAttempts = canonical.attempts ?? [];
        target.lastPendingSources = canonical.pendingSources ?? [];
        target.lastFailureCode = "";
        target.lastWarnings = canonical.warnings ?? [];
        target.maintenanceHistory = [canonical];
        return await transaction.persistCas(before.generation, target);
      }
    );
    assert.deepEqual(first.settings.maintenanceHistory, [canonical]);
    assert.deepEqual(first.settings.lastAttempts, canonical.attempts);
    assert.deepEqual(
      first.settings.lastPendingSources,
      canonical.pendingSources
    );
    assert.deepEqual(first.settings.lastWarnings, canonical.warnings);

    const replay = await fixture.store.withExclusiveTransaction(
      async (transaction) => {
        const before = await transaction.readWithGeneration();
        return await transaction.persistCas(
          before.generation,
          cloneKnowledgeBaseSettings(before.settings)
        );
      }
    );
    assert.deepEqual(replay.settings.maintenanceHistory, [canonical]);
    assert.deepEqual(replay.settings.lastAttempts, canonical.attempts);
    assert.deepEqual(
      replay.settings.lastPendingSources,
      canonical.pendingSources
    );
    assert.deepEqual(replay.settings.lastWarnings, canonical.warnings);
    assert.equal(fixture.saveCalls(), 2);
  } finally {
    await fixture.dispose();
  }
}

async function assertCanonicalDurableHistoryRoundTripsAndReplays(): Promise<void> {
  const fixture = await createFixture();
  try {
    const startedAt = Date.parse("2026-07-18T08:00:00.000Z");
    const attempt = {
      attemptId: "settings-roundtrip:attempt:1:codex-cli",
      ordinal: 1,
      backend: "codex-cli" as const,
      terminal: {
        status: "completed" as const,
        at: startedAt
      }
    };
    const cases: Array<{
      runId: string;
      completion: "full" | "recovered" | "partial" | "noop";
      winnerBackend: "codex-cli" | null;
      attempts: typeof attempt[];
      pendingSources: string[];
    }> = [
      {
        runId: "settings-roundtrip-full",
        completion: "full",
        winnerBackend: "codex-cli",
        attempts: [attempt],
        pendingSources: []
      },
      {
        runId: "settings-roundtrip-recovered",
        completion: "recovered",
        winnerBackend: "codex-cli",
        attempts: [attempt],
        pendingSources: []
      },
      {
        runId: "settings-roundtrip-partial",
        completion: "partial",
        winnerBackend: "codex-cli",
        attempts: [attempt],
        pendingSources: ["raw/pending.md"]
      },
      {
        runId: "settings-roundtrip-noop",
        completion: "noop",
        winnerBackend: null,
        attempts: [],
        pendingSources: []
      }
    ];
    const history = cases.map((testCase, index) => ({
      date: "2026-07-18",
      status: "success" as const,
      at: startedAt + index,
      runId: testCase.runId,
      mode: "maintain" as const,
      reportPath: `outputs/maintenance/${testCase.runId}.md`,
      completion: testCase.completion,
      selectedBackend: "codex-cli" as const,
      winnerBackend: testCase.winnerBackend,
      attempts: testCase.attempts,
      pendingSources: testCase.pendingSources,
      failureCode: null,
      terminalPhase: "finalized" as const,
      commitState: "committed" as const,
      warnings: []
    })) satisfies KnowledgeBaseMaintenanceHistoryEntry[];

    const first = await fixture.store.withExclusiveTransaction(
      async (transaction) => {
        const before = await transaction.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.maintenanceHistory = history;
        return await transaction.persistCas(before.generation, target);
      }
    );
    assert.deepEqual(first.settings.maintenanceHistory, history);

    const replay = await fixture.store.withExclusiveTransaction(
      async (transaction) => {
        const before = await transaction.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        return await transaction.persistCas(before.generation, target);
      }
    );
    assert.deepEqual(replay.settings.maintenanceHistory, history);
    assert.equal(fixture.saveCalls(), 2);
  } finally {
    await fixture.dispose();
  }
}

function assertAttemptFailurePhaseNormalization(): void {
  const normalized = normalizeSettingsData({
    ...cloneSettings(DEFAULT_SETTINGS),
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    knowledgeBase: {
      ...cloneKnowledgeBaseSettings(DEFAULT_SETTINGS.knowledgeBase),
      lastAttempts: [
        attemptWithFailurePhase("verification"),
        attemptWithFailurePhase("not-a-maintenance-phase", 2)
      ]
    }
  }).settings.knowledgeBase.lastAttempts;

  assert.equal(normalized[0]?.failure?.phase, "verification");
  assert.equal(normalized[1]?.failure?.phase, "preflight");
}

function assertOpaqueNativeAndOptionalTerminationNormalization(): void {
  const normalized = normalizeSettingsData({
    ...cloneSettings(DEFAULT_SETTINGS),
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    knowledgeBase: {
      ...cloneKnowledgeBaseSettings(DEFAULT_SETTINGS.knowledgeBase),
      lastAttempts: [{
        attemptId: "attempt-opaque-native",
        ordinal: 1,
        backend: "hermes",
        native: {
          id: "opaque-provider-id",
          kind: "invented-kind",
          persistence: "provider-persistent"
        },
        termination: {
          confirmedAt: 42
        }
      }]
    }
  }).settings.knowledgeBase.lastAttempts[0];

  assert.deepEqual(normalized?.native, {
    id: "opaque-provider-id",
    persistence: "provider-persistent"
  });
  assert.deepEqual(normalized?.termination, {
    confirmedAt: 42
  });
}

function assertScheduledRunIdNormalization(): void {
  const normalized = normalizeSettingsData({
    ...cloneSettings(DEFAULT_SETTINGS),
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    knowledgeBase: {
      ...cloneKnowledgeBaseSettings(DEFAULT_SETTINGS.knowledgeBase),
      lastScheduledRunId: "  knowledge-maintain-scheduled-42  "
    }
  }).settings.knowledgeBase;

  assert.equal(
    normalized.lastScheduledRunId,
    "knowledge-maintain-scheduled-42"
  );
  assert.equal(DEFAULT_SETTINGS.knowledgeBase.lastScheduledRunId, "");
}

function attemptWithFailurePhase(
  phase: string,
  ordinal = 1
): Record<string, unknown> {
  return {
    attemptId: `attempt-${ordinal}`,
    ordinal,
    backend: "codex-cli",
    failure: {
      code: "backend-unavailable",
      at: ordinal,
      message: "backend unavailable",
      phase,
      retryable: true,
      failoverEligible: true
    }
  };
}

async function assertGenerationCasPersistsAndReplacesMemory(): Promise<void> {
  const fixture = await createFixture();
  try {
    const memoryBefore = fixture.plugin.settings.knowledgeBase;
    const result = await fixture.store.withExclusiveTransaction(async (transaction) => {
      const before = await transaction.readWithGeneration();
      const repeated = await transaction.readWithGeneration();
      assert.equal(repeated.generation, before.generation);

      const target = cloneKnowledgeBaseSettings(before.settings);
      target.lastRunAt = 1_720_000_000_000;
      target.lastRunStatus = "success";
      target.lastError = "";
      target.lastSummary = "recovered from workflow WAL";
      const persisted = await transaction.persistCas(before.generation, target);
      const readback = await transaction.readWithGeneration();
      assert.equal(readback.generation, persisted.generation);
      assert.notEqual(readback.generation, before.generation);
      assert.deepEqual(readback.settings, target);
      return persisted;
    });

    assert.equal(result.settings.lastRunStatus, "success");
    assert.equal(fixture.persistedKnowledgeBase().lastSummary, "recovered from workflow WAL");
    assert.notEqual(fixture.plugin.settings.knowledgeBase, memoryBefore);
    assert.deepEqual(fixture.plugin.settings.knowledgeBase, result.settings);
    assert.equal(fixture.saveCalls(), 1);
  } finally {
    await fixture.dispose();
  }
}

async function assertGenerationCasRejectsConcurrentPersistentChange(): Promise<void> {
  const fixture = await createFixture();
  try {
    const memoryBefore = fixture.plugin.settings.knowledgeBase;
    await fixture.store.withExclusiveTransaction(async (transaction) => {
      const before = await transaction.readWithGeneration();
      const external = cloneKnowledgeBaseSettings(before.settings);
      external.lastError = "external writer won";
      fixture.replacePersistedKnowledgeBase(external);

      const target = cloneKnowledgeBaseSettings(before.settings);
      target.lastRunStatus = "success";
      await assert.rejects(
        () => transaction.persistCas(before.generation, target),
        (error: unknown) =>
          error instanceof MaintenanceWorkflowWalError
          && error.code === "settings_cas_conflict"
      );
    });

    assert.equal(fixture.persistedKnowledgeBase().lastError, "external writer won");
    assert.equal(fixture.plugin.settings.knowledgeBase, memoryBefore);
    assert.equal(fixture.saveCalls(), 0);
  } finally {
    await fixture.dispose();
  }
}

async function assertReadbackMismatchDoesNotReplaceMemory(): Promise<void> {
  const fixture = await createFixture({ discardNextSave: true });
  try {
    const memoryBefore = fixture.plugin.settings.knowledgeBase;
    await assert.rejects(
      () => fixture.store.withExclusiveTransaction(async (transaction) => {
        const before = await transaction.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "must survive durable readback";
        return await transaction.persistCas(before.generation, target);
      }),
      (error: unknown) =>
        error instanceof MaintenanceWorkflowWalError
        && error.code === "settings_persist_failed"
    );

    assert.equal(fixture.persistedKnowledgeBase().lastSummary, "");
    assert.equal(fixture.plugin.settings.knowledgeBase, memoryBefore);
    assert.equal(fixture.saveCalls(), 1);
  } finally {
    await fixture.dispose();
  }
}

async function assertGenerationCasRejectsUnqueuedMemoryChange(): Promise<void> {
  const fixture = await createFixture();
  try {
    await fixture.store.withExclusiveTransaction(async (transaction) => {
      const before = await transaction.readWithGeneration();
      fixture.plugin.settings.knowledgeBase.catchUpOnStartup =
        !fixture.plugin.settings.knowledgeBase.catchUpOnStartup;
      const target = cloneKnowledgeBaseSettings(before.settings);
      target.lastRunStatus = "success";

      await assert.rejects(
        () => transaction.persistCas(before.generation, target),
        (error: unknown) =>
          error instanceof MaintenanceWorkflowWalError
          && error.code === "settings_cas_conflict"
      );
    });

    assert.equal(fixture.persistedKnowledgeBase().lastRunStatus, "idle");
    assert.equal(fixture.saveCalls(), 0);
  } finally {
    await fixture.dispose();
  }
}

async function assertWorkflowTransactionSharesTheOrdinarySaveQueue(): Promise<void> {
  const fixture = await createFixture();
  try {
    const blockedSave = fixture.blockNextSave();
    const ordinarySave = fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    } satisfies SettingsSaveOptions);
    await blockedSave.started;

    let transactionEntered = false;
    const transaction = fixture.store.withExclusiveTransaction(async (host) => {
      transactionEntered = true;
      return await host.readWithGeneration();
    });
    await Promise.resolve();
    assert.equal(transactionEntered, false);

    blockedSave.release();
    await ordinarySave;
    const readback = await transaction;
    assert.equal(transactionEntered, true);
    assert.equal(readback.settings.lastRunStatus, "idle");
  } finally {
    await fixture.dispose();
  }
}

async function assertStartupRecoveryDefersKnowledgeMaintenanceUi(): Promise<void> {
  const fixture = await createFixture();
  try {
    const session = {
      id: "knowledge-recovery-session",
      title: "知识库管理",
      kind: "knowledge-base" as const,
      cwd: fixture.plugin.getVaultPath(),
      messages: [
        {
          id: "maintain-running",
          role: "assistant" as const,
          text: "正在维护",
          itemType: "knowledgeBase",
          status: "running",
          runId: "kb-run-deferred-maintain",
          knowledgeBaseUi: {
            kind: "maintain-run" as const,
            mode: "maintain" as const,
            title: "知识库维护",
            subtitle: "阶段进度见下方",
            icon: "archive" as const,
            phases: []
          },
          createdAt: 1
        },
        {
          id: "maintain-process",
          role: "assistant" as const,
          text: "正在分析",
          itemType: "reasoning",
          status: "running",
          runId: "kb-run-deferred-maintain",
          createdAt: 2
        },
        {
          id: "ordinary-running",
          role: "assistant" as const,
          text: "普通知识库问答被中断",
          status: "running",
          runId: "kb-run-ordinary-chat",
          createdAt: 3
        }
      ],
      createdAt: 1,
      updatedAt: 3
    };
    fixture.plugin.settings.sessions.push(session);
    fixture.plugin.settings.knowledgeBase.sessionId = session.id;

    const recovered = await fixture.store.recoverInterruptedHarnessRuns(
      undefined,
      { deferKnowledgeMaintenanceRuns: true }
    );

    assert.equal(recovered, 1);
    assert.equal(session.messages[0]?.status, "running");
    assert.equal(session.messages[0]?.knowledgeBaseUi?.kind, "maintain-run");
    assert.equal(session.messages[1]?.status, "running");
    assert.equal(session.messages[2]?.status, "interrupted");
    assert.deepEqual(fixture.settledRunIds(), ["kb-run-ordinary-chat"]);
  } finally {
    await fixture.dispose();
  }
}

async function createFixture(
  options: { discardNextSave?: boolean } = {}
): Promise<SettingsStoreFixture> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-settings-host-"));
  const settings = normalizeSettingsData({
    ...cloneSettings(DEFAULT_SETTINGS),
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    sessions: []
  }).settings;
  let persisted = settingsForDataSave(cloneSettings(settings));
  let saveCallCount = 0;
  const settledRunIds: string[] = [];
  let discardNextSave = options.discardNextSave === true;
  let blockedSave: {
    started: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | null = null;
  const plugin = {
    settings,
    loadData: async () => cloneSettings(persisted),
    saveData: async (data: unknown) => {
      saveCallCount += 1;
      if (blockedSave) {
        blockedSave.started.resolve();
        await blockedSave.release.promise;
        blockedSave = null;
      }
      if (discardNextSave) {
        discardNextSave = false;
        return;
      }
      persisted = cloneSettings(data as CodexForObsidianSettings);
    },
    getVaultPath: () => vaultPath,
    getPluginDataDirName: () => "codex-echoink",
    settleHarnessRunTerminal: async (input: { runId: string }) => {
      settledRunIds.push(input.runId);
    }
  };
  const store = new EchoInkSettingsStore(plugin as never);
  return {
    store,
    plugin,
    persistedKnowledgeBase: () =>
      cloneKnowledgeBaseSettings(
        normalizeSettingsData(persisted).settings.knowledgeBase
      ),
    replacePersistedKnowledgeBase: (knowledgeBase) => {
      persisted = {
        ...cloneSettings(persisted),
        knowledgeBase: cloneKnowledgeBaseSettings(knowledgeBase)
      };
    },
    blockNextSave: () => {
      const started = deferred();
      const release = deferred();
      blockedSave = { started, release };
      return {
        started: started.promise,
        release: release.resolve
      };
    },
    saveCalls: () => saveCallCount,
    settledRunIds: () => [...settledRunIds],
    dispose: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    }
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
  return JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
}

function cloneKnowledgeBaseSettings(
  settings: KnowledgeBaseSettings
): KnowledgeBaseSettings {
  return JSON.parse(JSON.stringify(settings)) as KnowledgeBaseSettings;
}
