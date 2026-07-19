import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pluginDataDir } from "../../core/raw-message-store";
import { rotateSessionContext } from "../../harness/conversation/context-rotation";
import {
  createConversationContentRevision,
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import { workspaceFingerprint } from "../../harness/kernel/session-service";
import { MaintenanceWorkflowWalError } from "../../harness/maintenance/workflow-wal";
import {
  localDateKeyForTimestamp,
  readKnowledgeBaseHistoryDay,
  readKnowledgeBaseHistoryIndex
} from "../../knowledge-base/history-store";
import {
  EchoInkSettingsStore,
  settingsForDataSave,
  type SettingsSaveOptions
} from "../../plugin/settings-store";
import {
  DEFAULT_SETTINGS,
  KNOWLEDGE_BASE_SESSION_TITLE,
  canonicalizeKnowledgeBaseMaintenanceHistoryEntry,
  normalizeSettingsData,
  type CodexForObsidianSettings,
  type ChatMessage,
  type KnowledgeBaseMaintenanceHistoryEntry,
  type KnowledgeBaseSettings,
  type StoredSession
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
  persistedSettings(): CodexForObsidianSettings;
  replacePersistedKnowledgeBase(settings: KnowledgeBaseSettings): void;
  blockNextSave(): {
    started: Promise<void>;
    release(): void;
  };
  failNextSave(mode: SettingsSaveFailureMode): void;
  saveCalls(): number;
  settledRunIds(): string[];
  dispose(): Promise<void>;
}

type SettingsSaveFailureMode =
  | "before-write"
  | "after-write"
  | "conflict-after-write"
  | "unknown-after-write";

export async function runMaintenanceSettingsStoreTests(): Promise<void> {
  assertAttemptFailurePhaseNormalization();
  assertOpaqueNativeAndOptionalTerminationNormalization();
  assertScheduledRunIdNormalization();
  await assertGenerationCasPersistsAndUpdatesMemoryInPlace();
  await assertCanonicalDurableHistoryRoundTripsAndReplays();
  await assertOversizeDurableMetadataCanonicalizesAndReplays();
  await assertGenerationCasRejectsConcurrentPersistentChange();
  await assertGenerationCasRejectsUnqueuedMemoryChange();
  await assertReadbackMismatchDoesNotReplaceMemory();
  await assertWorkflowTransactionSharesTheOrdinarySaveQueue();
  await assertWorkflowCasRollsForwardConcurrentNonKnowledgeSettings();
  await assertWorkflowCasThreeWayMergesLaterKnowledgeSettings();
  await assertWorkflowCasPoisonsSameFieldKnowledgeConflict();
  await assertWorkflowCasPersistsConversationBeforeNewSessionShell();
  await assertWorkflowCasBoundsPreConversationDriftAndDrainsQueue();
  await assertWorkflowCasAcceptsPostWriteRejectAndContinues();
  await assertWorkflowCasPropagatesUnwrittenFailureAndCanRetry();
  await assertWorkflowCasFailsClosedOnAmbiguousWriteFailure();
  await assertWorkflowCasSynchronizesCanonicalConversationBeforeRotation();
  await assertWorkflowCasCommitsFullSourceBeforeHistoryProjection();
  await assertActiveKnowledgeConversationFailureDoesNotPublishHistory();
  await assertSecondConversationPassFailureRestartsFromFullSource();
  await assertOrdinarySaveUsesConversationAuthorityForHistoryAndRotation();
  await assertPartialConversationBatchSynchronizesCommittedPrefix();
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

async function assertGenerationCasPersistsAndUpdatesMemoryInPlace(): Promise<void> {
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
    assert.equal(
      fixture.plugin.settings.knowledgeBase,
      memoryBefore,
      "CAS must preserve the object captured by the live Settings tab"
    );
    assert.deepEqual(fixture.plugin.settings.knowledgeBase, result.settings);
    memoryBefore.catchUpOnStartup = !memoryBefore.catchUpOnStartup;
    const capturedReferenceValue = memoryBefore.catchUpOnStartup;
    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    assert.equal(
      fixture.persistedKnowledgeBase().catchUpOnStartup,
      capturedReferenceValue,
      "a Settings tab callback using the pre-CAS reference must remain durable"
    );
    assert.equal(fixture.saveCalls(), 2);
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

async function assertWorkflowCasRollsForwardConcurrentNonKnowledgeSettings(): Promise<void> {
  const fixture = await createFixture();
  try {
    const blockedSave = fixture.blockNextSave();
    const transaction = fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "knowledge CAS with concurrent UI settings";
        return await host.persistCas(before.generation, target);
      }
    );
    await blockedSave.started;

    fixture.plugin.settings.settingsLanguage =
      fixture.plugin.settings.settingsLanguage === "en" ? "zh-CN" : "en";
    const concurrentLanguage = fixture.plugin.settings.settingsLanguage;
    const ordinarySave = fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    blockedSave.release();
    await transaction;
    await ordinarySave;

    assert.equal(
      fixture.persistedSettings().settingsLanguage,
      concurrentLanguage
    );
    assert.equal(
      fixture.persistedKnowledgeBase().lastSummary,
      "knowledge CAS with concurrent UI settings"
    );
    assert.equal(fixture.saveCalls(), 2);
  } finally {
    await fixture.dispose();
  }
}

async function assertWorkflowCasThreeWayMergesLaterKnowledgeSettings(): Promise<void> {
  const fixture = await createFixture();
  try {
    const blockedSave = fixture.blockNextSave();
    const transaction = fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "workflow target survives";
        return await host.persistCas(before.generation, target);
      }
    );
    await blockedSave.started;

    fixture.plugin.settings.knowledgeBase.catchUpOnStartup =
      !fixture.plugin.settings.knowledgeBase.catchUpOnStartup;
    const laterCatchUp =
      fixture.plugin.settings.knowledgeBase.catchUpOnStartup;
    const ordinarySave = fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    blockedSave.release();
    await transaction;
    await ordinarySave;

    assert.equal(
      fixture.plugin.settings.knowledgeBase.lastSummary,
      "workflow target survives"
    );
    assert.equal(
      fixture.plugin.settings.knowledgeBase.catchUpOnStartup,
      laterCatchUp
    );
    assert.equal(
      fixture.persistedKnowledgeBase().lastSummary,
      "workflow target survives"
    );
    assert.equal(
      fixture.persistedKnowledgeBase().catchUpOnStartup,
      laterCatchUp
    );
    assert.equal(fixture.saveCalls(), 2);
  } finally {
    await fixture.dispose();
  }
}

async function assertWorkflowCasPoisonsSameFieldKnowledgeConflict(): Promise<void> {
  const fixture = await createFixture();
  const originalConsoleError = console.error;
  try {
    console.error = () => undefined;
    const blockedSave = fixture.blockNextSave();
    const transaction = fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "durable workflow target";
        return await host.persistCas(before.generation, target);
      }
    );
    await blockedSave.started;

    fixture.plugin.settings.knowledgeBase.lastSummary = "later live edit";
    const ordinarySave = fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    blockedSave.release();

    await assert.rejects(
      transaction,
      (error: unknown) =>
        error instanceof MaintenanceWorkflowWalError
        && error.code === "settings_cas_conflict"
        && /target 已耐久.*lastSummary.*重启恢复/.test(error.message)
    );
    await assert.rejects(
      ordinarySave,
      (error: unknown) =>
        error instanceof MaintenanceWorkflowWalError
        && error.code === "settings_cas_conflict"
    );
    assert.equal(
      fixture.plugin.settings.knowledgeBase.lastSummary,
      "later live edit",
      "same-field conflict must not overwrite the later live edit"
    );
    assert.equal(
      fixture.persistedKnowledgeBase().lastSummary,
      "durable workflow target",
      "the queued ordinary save must not overwrite the committed workflow target"
    );
    assert.equal(fixture.saveCalls(), 1);
  } finally {
    console.error = originalConsoleError;
    await fixture.dispose();
  }
}

async function assertWorkflowCasBoundsPreConversationDriftAndDrainsQueue(): Promise<void> {
  const fixture = await createFixture();
  try {
    const internals = fixture.store as unknown as {
      readPersistedSettingsDataStrict(): Promise<unknown>;
      projectKnowledgeBaseHistory(
        candidate: CodexForObsidianSettings,
        strict: boolean
      ): Promise<boolean>;
    };
    const originalReadback =
      internals.readPersistedSettingsDataStrict.bind(fixture.store);
    const originalProjection = internals.projectKnowledgeBaseHistory.bind(
      fixture.store
    );
    let readbackCalls = 0;
    let projectionCalls = 0;
    internals.readPersistedSettingsDataStrict = async () => {
      const persisted = await originalReadback();
      readbackCalls += 1;
      if (readbackCalls <= 3) {
        fixture.plugin.settings.settingsLanguage =
          fixture.plugin.settings.settingsLanguage === "en" ? "zh-CN" : "en";
      }
      return persisted;
    };
    internals.projectKnowledgeBaseHistory = async (candidate, strict) => {
      const projected = await originalProjection(candidate, strict);
      projectionCalls += 1;
      return projected;
    };

    const transaction = fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "must not starve the settings queue";
        return await host.persistCas(before.generation, target);
      }
    );
    const ordinarySave = fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });

    await assert.rejects(
      transaction,
      (error: unknown) =>
        error instanceof MaintenanceWorkflowWalError
        && error.code === "settings_cas_conflict"
    );
    await ordinarySave;

    assert.equal(
      readbackCalls,
      4,
      "the transaction must stop after three stability reads, then release one read to the queued save"
    );
    assert.equal(
      projectionCalls,
      0,
      "History must not publish until the pre-Conversation candidate is stable"
    );
    assert.equal(
      fixture.persistedKnowledgeBase().lastSummary,
      "",
      "an exhausted CAS must not claim the workflow target"
    );
    assert.equal(
      fixture.saveCalls(),
      1,
      "the queued ordinary save must run after the failed transaction drains"
    );
  } finally {
    await fixture.dispose();
  }
}

async function assertWorkflowCasAcceptsPostWriteRejectAndContinues(): Promise<void> {
  const fixture = await createFixture();
  try {
    fixture.failNextSave("after-write");
    const first = await fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "post-write rejection was committed";
        return await host.persistCas(before.generation, target);
      }
    );

    assert.equal(first.settings.lastSummary, "post-write rejection was committed");
    assert.equal(
      fixture.plugin.settings.knowledgeBase.lastSummary,
      "post-write rejection was committed"
    );
    assert.equal(
      fixture.persistedKnowledgeBase().lastSummary,
      "post-write rejection was committed"
    );

    const second = await fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastError = "same-process WAL lane remains usable";
        return await host.persistCas(before.generation, target);
      }
    );
    assert.equal(second.settings.lastError, "same-process WAL lane remains usable");
    assert.equal(fixture.saveCalls(), 2);

    const restarted = new EchoInkSettingsStore(fixture.plugin as never);
    await restarted.loadSettings();
    assert.equal(
      fixture.plugin.settings.knowledgeBase.lastSummary,
      "post-write rejection was committed"
    );
    assert.equal(
      fixture.plugin.settings.knowledgeBase.lastError,
      "same-process WAL lane remains usable"
    );
  } finally {
    await fixture.dispose();
  }
}

async function assertWorkflowCasPropagatesUnwrittenFailureAndCanRetry(): Promise<void> {
  const fixture = await createFixture();
  try {
    const session = await createKnowledgeConversation(
      fixture,
      "settings-before-write-recovery",
      [
        messageAt("before-write-user", "user", Date.now() - 1_000),
        messageAt("before-write-assistant", "assistant", Date.now())
      ]
    );
    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    fixture.failNextSave("before-write");
    await assert.rejects(
      fixture.store.withExclusiveTransaction(async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "first attempt must remain unwritten";
        return await host.persistCas(before.generation, target);
      }),
      /fixture save failed before write/
    );
    assert.equal(fixture.persistedKnowledgeBase().lastSummary, "");
    assert.equal(fixture.plugin.settings.knowledgeBase.lastSummary, "");
    const durableAfterFailure =
      await fixture.store.readConversationSession(session.id);
    assert.ok(session.contextSnapshot);
    assert.equal(
      createConversationContentRevision(session),
      createConversationContentRevision(durableAfterFailure!)
    );
    await rotateKnowledgeConversation(
      fixture,
      session,
      "before-write-recovery-rotation"
    );

    const retry = await fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        const target = cloneKnowledgeBaseSettings(before.settings);
        target.lastSummary = "retry committed";
        return await host.persistCas(before.generation, target);
      }
    );
    assert.equal(retry.settings.lastSummary, "retry committed");
    assert.equal(fixture.saveCalls(), 3);
  } finally {
    await fixture.dispose();
  }
}

async function assertWorkflowCasFailsClosedOnAmbiguousWriteFailure(): Promise<void> {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    for (const mode of [
      "conflict-after-write",
      "unknown-after-write"
    ] as const) {
      const fixture = await createFixture();
      try {
        const session = await createKnowledgeConversation(
          fixture,
          `settings-ambiguous-${mode}`,
          [
            messageAt(`${mode}-user`, "user", Date.now() - 1_000),
            messageAt(`${mode}-assistant`, "assistant", Date.now())
          ]
        );
        await fixture.store.saveSettings(true, {
          flushConversationStore: false,
          flushKnowledgeBaseHistory: false
        });
        fixture.failNextSave(mode);
        await assert.rejects(
          fixture.store.withExclusiveTransaction(async (host) => {
            const before = await host.readWithGeneration();
            const target = cloneKnowledgeBaseSettings(before.settings);
            target.lastSummary = `ambiguous ${mode}`;
            return await host.persistCas(before.generation, target);
          }),
          (error: unknown) =>
            error instanceof MaintenanceWorkflowWalError
            && error.code === "settings_persist_failed"
        );
        assert.equal(
          fixture.plugin.settings.knowledgeBase.lastSummary,
          "",
          "an ambiguous write must not replace the live Knowledge settings"
        );
        const durable = await fixture.store.readConversationSession(session.id);
        assert.ok(session.contextSnapshot);
        assert.equal(
          createConversationContentRevision(session),
          createConversationContentRevision(durable!),
          "ambiguous data outcomes must not leave live behind durable Conversation"
        );
        const saveCallsAfterAmbiguousWrite = fixture.saveCalls();
        assert.equal(
          fixture.persistedKnowledgeBase().lastSummary,
          `ambiguous ${mode}`,
          "the fixture must prove the workflow target may already be durable"
        );
        await assert.rejects(
          fixture.store.saveSettings(true, {
            flushConversationStore: false,
            flushKnowledgeBaseHistory: false
          }),
          (error: unknown) =>
            error instanceof MaintenanceWorkflowWalError
            && error.code === "settings_persist_failed"
        );
        await assert.rejects(
          fixture.store.withExclusiveTransaction(async (host) =>
            await host.readWithGeneration()
          ),
          (error: unknown) =>
            error instanceof MaintenanceWorkflowWalError
            && error.code === "settings_persist_failed"
        );
        assert.equal(
          fixture.saveCalls(),
          saveCallsAfterAmbiguousWrite,
          "the recovery gate must block every later writer before saveData"
        );
        assert.equal(
          fixture.persistedKnowledgeBase().lastSummary,
          `ambiguous ${mode}`,
          "blocked writers must not overwrite the possibly committed target"
        );

        await fixture.store.loadSettings();
        assert.equal(
          fixture.plugin.settings.knowledgeBase.lastSummary,
          `ambiguous ${mode}`,
          "loadSettings must recover the durable target and clear the gate"
        );
        await fixture.store.saveSettings(true, {
          flushConversationStore: false,
          flushKnowledgeBaseHistory: false
        });
        assert.equal(
          fixture.saveCalls(),
          saveCallsAfterAmbiguousWrite + 1,
          "an explicit durable reload must make the save lane usable again"
        );
      } finally {
        await fixture.dispose();
      }
    }
  } finally {
    console.error = originalConsoleError;
  }
}

async function assertWorkflowCasSynchronizesCanonicalConversationBeforeRotation(): Promise<void> {
  const fixture = await createFixture();
  try {
    const session = await createKnowledgeConversation(
      fixture,
      "settings-cas-canonical",
      [
        messageAt("cas-user", "user", Date.now() - 1_000),
        messageAt("cas-assistant", "assistant", Date.now())
      ]
    );
    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    assert.equal(session.contextSnapshot, undefined);

    await fixture.store.withExclusiveTransaction(async (host) => {
      const before = await host.readWithGeneration();
      const target = cloneKnowledgeBaseSettings(before.settings);
      target.lastSummary = "canonical Conversation projection";
      return await host.persistCas(before.generation, target);
    });

    const durable = await fixture.store.readConversationSession(session.id);
    assert.ok(session.contextSnapshot);
    assert.ok(durable?.contextSnapshot);
    assert.equal(
      createConversationContentRevision(session),
      createConversationContentRevision(durable!)
    );
    assert.deepEqual(
      fixture.persistedSettings().sessions.find(
        (candidate) => candidate.id === session.id
      )?.contextSnapshot,
      durable?.contextSnapshot
    );

    await rotateKnowledgeConversation(
      fixture,
      session,
      "cas-canonical-rotation"
    );
    assert.equal(session.generation, 2);
  } finally {
    await fixture.dispose();
  }
}

async function assertWorkflowCasCommitsFullSourceBeforeHistoryProjection(): Promise<void> {
  const fixture = await createFixture();
  let restoreUpsert: (() => void) | null = null;
  let restoreProjection: (() => void) | null = null;
  try {
    const now = Date.now();
    const oldTimestamp = now - (3 * 24 * 60 * 60 * 1_000);
    const recentTimestamp = now - (24 * 60 * 60 * 1_000);
    const session = await createKnowledgeConversation(
      fixture,
      "settings-cas-source-before-history",
      [
        messageAt("cas-history-old", "user", oldTimestamp),
        messageAt("cas-history-recent", "assistant", recentTimestamp),
        messageAt("cas-history-today", "user", now)
      ]
    );
    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });

    const events: string[] = [];
    const internals = fixture.store as unknown as {
      getConversationStore(): FileConversationStore;
      projectKnowledgeBaseHistory(
        candidate: CodexForObsidianSettings,
        strict: boolean
      ): Promise<boolean>;
    };
    const conversationStore = internals.getConversationStore();
    const originalUpsert = conversationStore.upsertSession.bind(conversationStore);
    const originalProjection =
      internals.projectKnowledgeBaseHistory.bind(fixture.store);
    conversationStore.upsertSession = async (candidate) => {
      if (candidate.id === session.id) {
        events.push(
          `conversation:${candidate.messages.map((message) => message.id).join(",")}`
        );
      }
      await originalUpsert(candidate);
    };
    internals.projectKnowledgeBaseHistory = async (candidate, strict) => {
      events.push("history");
      return await originalProjection(candidate, strict);
    };
    restoreUpsert = () => {
      conversationStore.upsertSession = originalUpsert;
    };
    restoreProjection = () => {
      internals.projectKnowledgeBaseHistory = originalProjection;
    };

    await fixture.store.withExclusiveTransaction(async (host) => {
      const before = await host.readWithGeneration();
      const target = cloneKnowledgeBaseSettings(before.settings);
      target.lastSummary = "Conversation source precedes History";
      return await host.persistCas(before.generation, target);
    });

    assert.deepEqual(events, [
      "conversation:cas-history-old,cas-history-recent,cas-history-today",
      "history",
      "conversation:cas-history-recent,cas-history-today"
    ]);
    assert.equal(
      fixture.persistedKnowledgeBase().lastSummary,
      "Conversation source precedes History"
    );
    assert.deepEqual(
      (await fixture.store.readConversationSession(session.id))
        ?.messages.map((message) => message.id),
      ["cas-history-recent", "cas-history-today"]
    );
  } finally {
    restoreProjection?.();
    restoreUpsert?.();
    await fixture.dispose();
  }
}

async function assertActiveKnowledgeConversationFailureDoesNotPublishHistory(): Promise<void> {
  const fixture = await createFixture();
  const originalConsoleError = console.error;
  let restoreUpsert: (() => void) | null = null;
  let restoreProjection: (() => void) | null = null;
  try {
    console.error = () => undefined;
    const now = Date.now();
    const oldTimestamp = now - (2 * 24 * 60 * 60 * 1_000);
    const oldDate = localDateKeyForTimestamp(oldTimestamp);
    const session = await createKnowledgeConversation(
      fixture,
      "settings-active-kb-pre-marker-failure",
      [
        messageAt("active-failure-old", "user", oldTimestamp),
        messageAt("active-failure-today", "assistant", now)
      ]
    );
    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    const saveCallsBeforeFailure = fixture.saveCalls();

    const internals = fixture.store as unknown as {
      getConversationStore(): FileConversationStore;
      projectKnowledgeBaseHistory(
        candidate: CodexForObsidianSettings,
        strict: boolean
      ): Promise<boolean>;
    };
    const conversationStore = internals.getConversationStore();
    const originalUpsert = conversationStore.upsertSession.bind(conversationStore);
    const originalProjection =
      internals.projectKnowledgeBaseHistory.bind(fixture.store);
    let projectionCalls = 0;
    conversationStore.upsertSession = async (candidate) => {
      if (candidate.id === session.id) {
        throw new Error("fixture active Knowledge Conversation pre-marker failure");
      }
      await originalUpsert(candidate);
    };
    internals.projectKnowledgeBaseHistory = async (candidate, strict) => {
      projectionCalls += 1;
      return await originalProjection(candidate, strict);
    };
    restoreUpsert = () => {
      conversationStore.upsertSession = originalUpsert;
    };
    restoreProjection = () => {
      internals.projectKnowledgeBaseHistory = originalProjection;
    };

    await assert.rejects(
      fixture.store.saveSettings(true, {
        flushConversationStore: false,
        strictConversationStore: false,
        strictKnowledgeBaseHistory: true
      }),
      /active Knowledge Conversation pre-marker failure/
    );

    assert.equal(
      projectionCalls,
      0,
      "History publication must never start before the active Knowledge Conversation is durable"
    );
    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(
        fixture.plugin.getVaultPath(),
        fixture.plugin.getPluginDataDirName()
      )).sessions,
      []
    );
    await assert.rejects(
      readKnowledgeBaseHistoryDay(
        fixture.plugin.getVaultPath(),
        fixture.plugin.getPluginDataDirName(),
        session.id,
        oldDate
      ),
      (error: unknown) => isNotFoundError(error)
    );
    assert.deepEqual(
      (await fixture.store.readConversationSession(session.id))?.messages,
      [],
      "the injected pre-marker failure must leave the pristine durable source unchanged"
    );
    assert.equal(
      fixture.saveCalls(),
      saveCallsBeforeFailure,
      "data.json must not advance after the required Conversation pass fails"
    );
  } finally {
    restoreProjection?.();
    restoreUpsert?.();
    console.error = originalConsoleError;
    await fixture.dispose();
  }
}

async function assertSecondConversationPassFailureRestartsFromFullSource(): Promise<void> {
  const fixture = await createFixture();
  const originalConsoleError = console.error;
  let restoreUpsert: (() => void) | null = null;
  try {
    console.error = () => undefined;
    const now = Date.now();
    const oldTimestamp = now - (3 * 24 * 60 * 60 * 1_000);
    const recentTimestamp = now - (24 * 60 * 60 * 1_000);
    const oldDate = localDateKeyForTimestamp(oldTimestamp);
    const session = await createKnowledgeConversation(
      fixture,
      "settings-second-pass-recovery",
      [
        messageAt("second-pass-old", "user", oldTimestamp),
        messageAt("second-pass-recent", "assistant", recentTimestamp),
        messageAt("second-pass-today", "user", now)
      ]
    );
    const messageReferences = [...session.messages];
    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    const persistedBeforeFailure = fixture.persistedSettings();
    const saveCallsBeforeFailure = fixture.saveCalls();

    const internals = fixture.store as unknown as {
      getConversationStore(): FileConversationStore;
    };
    const conversationStore = internals.getConversationStore();
    const originalUpsert = conversationStore.upsertSession.bind(conversationStore);
    let targetPass = 0;
    conversationStore.upsertSession = async (candidate) => {
      if (candidate.id === session.id) {
        targetPass += 1;
        if (targetPass === 2) {
          throw new Error("fixture compacted Conversation second-pass failure");
        }
      }
      await originalUpsert(candidate);
    };
    restoreUpsert = () => {
      conversationStore.upsertSession = originalUpsert;
    };

    await assert.rejects(
      fixture.store.saveSettings(true, {
        flushConversationStore: false,
        strictConversationStore: false,
        strictKnowledgeBaseHistory: true
      }),
      /compacted Conversation second-pass failure/
    );

    const durableFull =
      await fixture.store.readConversationSession(session.id);
    assert.deepEqual(
      durableFull?.messages.map((message) => message.id),
      ["second-pass-old", "second-pass-recent", "second-pass-today"],
      "pass 1 must remain the complete durable source when pass 2 fails before its marker"
    );
    assert.ok(session.contextSnapshot);
    assert.equal(
      createConversationContentRevision(session),
      createConversationContentRevision(durableFull!)
    );
    assert.strictEqual(session.messages[0], messageReferences[0]);
    assert.strictEqual(session.messages[1], messageReferences[1]);
    assert.strictEqual(session.messages[2], messageReferences[2]);
    assert.deepEqual(
      (await readKnowledgeBaseHistoryDay(
        fixture.plugin.getVaultPath(),
        fixture.plugin.getPluginDataDirName(),
        session.id,
        oldDate
      )).map((message) => message.id),
      ["second-pass-old"],
      "the published History row must remain readable because pass 1 owns its complete source"
    );
    assert.equal(fixture.saveCalls(), saveCallsBeforeFailure);
    assert.deepEqual(
      fixture.persistedSettings(),
      persistedBeforeFailure,
      "data.json must stay behind a failed compacted Conversation pass"
    );

    restoreUpsert();
    restoreUpsert = null;
    const restartedStore = new EchoInkSettingsStore(fixture.plugin as never);
    await restartedStore.loadSettings();
    fixture.store = restartedStore;
    const restartedSession = fixture.plugin.settings.sessions.find(
      (candidate) => candidate.id === session.id
    );
    assert.ok(restartedSession);
    assert.deepEqual(
      restartedSession.messages.map((message) => message.id),
      ["second-pass-old", "second-pass-recent", "second-pass-today"],
      "restart must hydrate the complete pass-1 Conversation instead of trusting the stale data shell"
    );
    assert.deepEqual(
      (await readKnowledgeBaseHistoryDay(
        fixture.plugin.getVaultPath(),
        fixture.plugin.getPluginDataDirName(),
        session.id,
        oldDate
      )).map((message) => message.id),
      ["second-pass-old"],
      "History restore evidence must survive a fresh SettingsStore instance"
    );

    await restartedStore.saveSettings(true, {
      flushConversationStore: false,
      strictConversationStore: false,
      strictKnowledgeBaseHistory: true
    });
    assert.deepEqual(
      restartedSession.messages.map((message) => message.id),
      ["second-pass-recent", "second-pass-today"]
    );
    assert.deepEqual(
      (await restartedStore.readConversationSession(session.id))
        ?.messages.map((message) => message.id),
      ["second-pass-recent", "second-pass-today"],
      "a retry must finish the compacted Conversation pass before data.json"
    );
    assert.deepEqual(
      (await readKnowledgeBaseHistoryDay(
        fixture.plugin.getVaultPath(),
        fixture.plugin.getPluginDataDirName(),
        session.id,
        oldDate
      )).map((message) => message.id),
      ["second-pass-old"],
      "compaction must leave the full old-day record restorable from History"
    );
    assert.equal(fixture.saveCalls(), saveCallsBeforeFailure + 1);
  } finally {
    restoreUpsert?.();
    console.error = originalConsoleError;
    await fixture.dispose();
  }
}

async function assertOrdinarySaveUsesConversationAuthorityForHistoryAndRotation(): Promise<void> {
  const fixture = await createFixture();
  try {
    const now = Date.now();
    const oldTimestamp = now - (3 * 24 * 60 * 60 * 1_000);
    const recentTimestamp = now - (24 * 60 * 60 * 1_000);
    const oldDate = localDateKeyForTimestamp(oldTimestamp);
    const session = await createKnowledgeConversation(
      fixture,
      "settings-ordinary-history-canonical",
      [
        messageAt("history-old", "user", oldTimestamp),
        messageAt("history-recent", "assistant", recentTimestamp),
        messageAt("history-today", "user", now)
      ]
    );

    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      strictConversationStore: false,
      strictKnowledgeBaseHistory: true
    });

    const durable = await fixture.store.readConversationSession(session.id);
    assert.deepEqual(
      session.messages.map((message) => message.id),
      ["history-recent", "history-today"]
    );
    assert.deepEqual(
      durable?.messages.map((message) => message.id),
      ["history-recent", "history-today"]
    );
    assert.equal(
      createConversationContentRevision(session),
      createConversationContentRevision(durable!)
    );
    assert.deepEqual(
      (await readKnowledgeBaseHistoryDay(
        fixture.plugin.getVaultPath(),
        fixture.plugin.getPluginDataDirName(),
        session.id,
        oldDate
      )).map((message) => message.id),
      ["history-old"],
      "History projection must keep the complete dated message set"
    );
    const persistedShell = fixture.persistedSettings().sessions.find(
      (candidate) => candidate.id === session.id
    );
    assert.deepEqual(persistedShell?.messages, []);
    assert.deepEqual(persistedShell?.contextSnapshot, durable?.contextSnapshot);
    assert.deepEqual(persistedShell?.rollingSummary, durable?.rollingSummary);
    assert.equal(persistedShell?.historyActiveDate, durable?.historyActiveDate);

    await rotateKnowledgeConversation(
      fixture,
      session,
      "ordinary-history-rotation"
    );
    assert.equal(session.generation, 2);
  } finally {
    await fixture.dispose();
  }
}

async function assertPartialConversationBatchSynchronizesCommittedPrefix(): Promise<void> {
  const fixture = await createFixture();
  const originalConsoleError = console.error;
  let restoreUpsert: (() => void) | null = null;
  let restoreProjection: (() => void) | null = null;
  try {
    console.error = () => undefined;
    const first = await createKnowledgeConversation(
      fixture,
      "settings-partial-prefix",
      [
        messageAt("partial-prefix-user", "user", Date.now() - 3_000),
        messageAt("partial-prefix-assistant", "assistant", Date.now() - 2_000)
      ]
    );
    const failing = await createKnowledgeConversation(
      fixture,
      "settings-partial-failing",
      [
        messageAt("partial-failing-user", "user", Date.now() - 1_000),
        messageAt("partial-failing-assistant", "assistant", Date.now())
      ]
    );
    const firstMessageReferences = [...first.messages];
    fixture.plugin.settings.knowledgeBase.sessionId = first.id;
    await fixture.store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    const durableFailingBeforeBatch =
      await fixture.store.readConversationSession(failing.id);
    assert.ok(durableFailingBeforeBatch);
    const persistedBeforeBatch = fixture.persistedSettings();
    const saveCallsBeforeBatch = fixture.saveCalls();

    const internals = fixture.store as unknown as {
      getConversationStore(): FileConversationStore;
      projectKnowledgeBaseHistory(
        candidate: CodexForObsidianSettings,
        strict: boolean
      ): Promise<boolean>;
    };
    const conversationStore = internals.getConversationStore();
    const originalUpsert = conversationStore.upsertSession.bind(conversationStore);
    const originalProjection =
      internals.projectKnowledgeBaseHistory.bind(fixture.store);
    let projectionCalls = 0;
    conversationStore.upsertSession = async (session) => {
      if (session.id === failing.id) {
        throw new Error("fixture second conversation pre-marker failure");
      }
      await originalUpsert(session);
    };
    internals.projectKnowledgeBaseHistory = async (candidate, strict) => {
      projectionCalls += 1;
      return await originalProjection(candidate, strict);
    };
    restoreUpsert = () => {
      conversationStore.upsertSession = originalUpsert;
    };
    restoreProjection = () => {
      internals.projectKnowledgeBaseHistory = originalProjection;
    };

    await assert.rejects(
      fixture.store.saveSettings(true, {
        strictConversationStore: true,
        strictKnowledgeBaseHistory: true
      }),
      /fixture second conversation pre-marker failure/
    );

    const durableFirst =
      await fixture.store.readConversationSession(first.id);
    const durableFailing =
      await fixture.store.readConversationSession(failing.id);
    assert.ok(first.contextSnapshot);
    assert.equal(
      createConversationContentRevision(first),
      createConversationContentRevision(durableFirst!),
      "a committed prefix session must synchronize immediately even when a later session fails"
    );
    assert.strictEqual(
      first.messages[0],
      firstMessageReferences[0],
      "canonical synchronization must preserve retained live message identity"
    );
    assert.strictEqual(
      first.messages[1],
      firstMessageReferences[1],
      "canonical synchronization must preserve every retained live message identity"
    );
    assert.equal(
      failing.contextSnapshot,
      undefined,
      "the failed session must not receive candidate-derived state"
    );
    assert.deepEqual(
      durableFailing,
      durableFailingBeforeBatch,
      "a pre-marker failure must leave the failed durable authority unchanged"
    );
    assert.equal(
      fixture.saveCalls(),
      saveCallsBeforeBatch,
      "a partial Conversation batch must not reach the data shell commit"
    );
    assert.deepEqual(
      fixture.persistedSettings(),
      persistedBeforeBatch,
      "data shells must not disguise a partial Conversation prefix as a successful batch"
    );
    assert.equal(
      projectionCalls,
      0,
      "a failed full Conversation batch must not publish any History projection"
    );
    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(
        fixture.plugin.getVaultPath(),
        fixture.plugin.getPluginDataDirName()
      )).sessions,
      []
    );

    restoreUpsert();
    restoreUpsert = null;
    restoreProjection();
    restoreProjection = null;
    const restartedStore = new EchoInkSettingsStore(fixture.plugin as never);
    const restartedConversationStore = (
      restartedStore as unknown as {
        getConversationStore(): FileConversationStore;
      }
    ).getConversationStore();
    assert.notStrictEqual(
      restartedConversationStore,
      conversationStore,
      "restart coverage must use a fresh ConversationStore instance"
    );
    await restartedStore.loadSettings();
    fixture.store = restartedStore;

    const restartedFirst = fixture.plugin.settings.sessions.find(
      (session) => session.id === first.id
    );
    const restartedFailing = fixture.plugin.settings.sessions.find(
      (session) => session.id === failing.id
    );
    assert.ok(restartedFirst);
    assert.ok(restartedFailing);
    assert.equal(
      createConversationContentRevision(restartedFirst),
      createConversationContentRevision(durableFirst!),
      "restart must hydrate the committed prefix from durable canonical authority"
    );
    assert.deepEqual(
      restartedFirst.contextSnapshot,
      durableFirst?.contextSnapshot,
      "restart must recover the committed prefix canonical snapshot"
    );
    assert.equal(
      createConversationContentRevision(restartedFailing),
      createConversationContentRevision(durableFailingBeforeBatch),
      "restart must hydrate the failed session from its pre-batch durable authority"
    );
    assert.deepEqual(
      fixture.persistedSettings(),
      persistedBeforeBatch,
      "restart must not manufacture a whole-batch data shell commit"
    );

    await rotateKnowledgeConversation(
      fixture,
      restartedFirst,
      "partial-prefix-restart-rotation"
    );
    assert.equal(restartedFirst.generation, 2);
  } finally {
    restoreProjection?.();
    restoreUpsert?.();
    console.error = originalConsoleError;
    await fixture.dispose();
  }
}

async function assertWorkflowCasPersistsConversationBeforeNewSessionShell(): Promise<void> {
  const fixture = await createFixture();
  try {
    const session: StoredSession = {
      id: "settings-cas-pristine-session",
      title: "CAS pristine session",
      kind: "chat",
      cwd: "",
      messages: [],
      revision: 1,
      generation: 1,
      createdAt: 1,
      updatedAt: 1
    };
    fixture.plugin.settings.sessions.push(session);
    fixture.store.registerPristineConversationSession(session);

    const blockedSave = fixture.blockNextSave();
    const transaction = fixture.store.withExclusiveTransaction(
      async (host) => {
        const before = await host.readWithGeneration();
        return await host.persistCas(
          before.generation,
          cloneKnowledgeBaseSettings(before.settings)
        );
      }
    );
    await blockedSave.started;

    assert.equal(
      fixture.persistedSettings().sessions.some(
        (candidate) => candidate.id === session.id
      ),
      false
    );
    const conversationStore = new FileConversationStore({
      rootPath: path.join(
        pluginDataDir(
          fixture.plugin.getVaultPath(),
          fixture.plugin.getPluginDataDirName()
        ),
        "conversations"
      )
    });
    assert.equal(
      (await conversationStore.readSession(session.id))?.id,
      session.id
    );

    blockedSave.release();
    await transaction;
    assert.equal(
      fixture.persistedSettings().sessions.some(
        (candidate) => candidate.id === session.id
      ),
      true
    );
  } finally {
    await fixture.dispose();
  }
}

async function assertStartupRecoveryDefersKnowledgeMaintenanceUi(): Promise<void> {
  const fixture = await createFixture();
  try {
    const vaultPath = fixture.plugin.getVaultPath();
    const session: StoredSession = {
      id: "knowledge-recovery-session",
      title: "知识库管理",
      kind: "knowledge-base" as const,
      revision: 1,
      generation: 1,
      contextId: "context-knowledge-recovery",
      commitId: "commit-knowledge-recovery",
      workspaceFingerprint: workspaceFingerprint({ vaultPath, cwd: vaultPath }),
      cwd: vaultPath,
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
    const conversationStore = new FileConversationStore({
      rootPath: path.join(pluginDataDir(vaultPath, "codex-echoink"), "conversations")
    });
    await conversationStore.createPristineSession({
      ...session,
      messages: [],
      updatedAt: session.createdAt
    });
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

async function createKnowledgeConversation(
  fixture: SettingsStoreFixture,
  sessionId: string,
  messages: ChatMessage[]
): Promise<StoredSession> {
  const vaultPath = fixture.plugin.getVaultPath();
  const createdAt = Math.min(...messages.map((message) => message.createdAt));
  const session: StoredSession = {
    id: sessionId,
    title: KNOWLEDGE_BASE_SESSION_TITLE,
    kind: "knowledge-base",
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: `context-${sessionId}`,
    commitId: `commit-${sessionId}`,
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages: [],
    createdAt,
    updatedAt: createdAt
  };
  fixture.plugin.settings.sessions.push(session);
  fixture.plugin.settings.activeSessionId = session.id;
  fixture.plugin.settings.knowledgeBase.sessionId = session.id;
  fixture.store.registerPristineConversationSession(session);
  await fixture.store.ensureConversationSessionCreated(session);
  session.messages = cloneMessages(messages);
  session.updatedAt = Math.max(...messages.map((message) => message.createdAt));
  return session;
}

async function rotateKnowledgeConversation(
  fixture: SettingsStoreFixture,
  session: StoredSession,
  label: string
): Promise<void> {
  const vaultPath = fixture.plugin.getVaultPath();
  await rotateSessionContext(session, {
    reason: "start-new-context",
    identityFactory: {
      commitId: () => `commit-${label}`,
      contextId: () => `context-${label}`
    },
    workspace: {
      vaultPath,
      cwd: vaultPath
    },
    hooks: {
      async register(retirements) {
        assert.deepEqual(retirements, []);
      },
      async commit(input) {
        await fixture.store.commitConversationSessionContext(input.session, {
          expectedGeneration: input.expectedGeneration,
          expectedCommitId: input.expectedCommitId,
          expectedContentRevision: input.expectedContentRevision
        });
      },
      async promote(retirements) {
        assert.deepEqual(retirements, []);
      },
      async abort() {
        assert.fail("a canonical Settings projection must rotate without aborting");
      }
    }
  });
}

function messageAt(
  id: string,
  role: ChatMessage["role"],
  createdAt: number
): ChatMessage {
  return {
    id,
    role,
    text: `${id} text`,
    createdAt
  };
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
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
  let nextSaveFailure: SettingsSaveFailureMode | null = null;
  let failNextLoad = false;
  let blockedSave: {
    started: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | null = null;
  const plugin = {
    settings,
    loadData: async () => {
      if (failNextLoad) {
        failNextLoad = false;
        throw new Error("fixture strict readback unavailable");
      }
      return cloneSettings(persisted);
    },
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
      const failure = nextSaveFailure;
      nextSaveFailure = null;
      if (failure === "before-write") {
        throw new Error("fixture save failed before write");
      }
      const target = cloneSettings(data as CodexForObsidianSettings);
      if (failure === "conflict-after-write") {
        target.settingsLanguage = target.settingsLanguage === "en" ? "zh-CN" : "en";
        persisted = target;
        throw new Error("fixture save wrote conflicting data and rejected");
      }
      persisted = target;
      if (failure === "unknown-after-write") {
        failNextLoad = true;
        throw new Error("fixture save wrote data but readback will fail");
      }
      if (failure === "after-write") {
        throw new Error("fixture save wrote target and rejected");
      }
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
    persistedSettings: () => cloneSettings(persisted),
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
    failNextSave: (mode) => {
      nextSaveFailure = mode;
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

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
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
