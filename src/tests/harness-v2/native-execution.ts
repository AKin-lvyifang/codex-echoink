import * as assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import { TaskRuntimeAgentAdapter } from "../../harness/agents/adapters/task-runtime-adapter";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { LocalRunCommitResult, NativeExecutionDispositionRequest, NativeExecutionRecord } from "../../harness/contracts/native-execution";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { NativeExecutionManager } from "../../harness/native/native-execution-manager";
import { NativeExecutionStore } from "../../harness/native/native-execution-store";
import { KnowledgeBaseManager } from "../../knowledge-base/manager";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../../settings/settings";

export async function runHarnessV2NativeExecutionTests(): Promise<void> {
  await assertKnowledgeLocalCommitAndCleanupEventsUseCentralLedgerSequence();
  await assertKnowledgeLocalCommitEventFailureKeepsDurableCommitGateClosed();
  await assertKnowledgeLocalCommitFailureEmitsFailedEventWithoutCleanup();
  await assertNativeExecutionStoreRebuildsIndexFromJsonl();
  await assertLocalCommitFailureRetainsNativeExecution();
  await assertCleanupUsesAdapterCapabilityAndRetriesFailures();
  await assertCleanupUnsupportedAndRetainedEvents();
  await assertEphemeralHermesCleanupIsUnsupportedInsteadOfRetained();
  await assertScheduledEventFailureKeepsCleanupRecoverable();
  await assertCleanupTerminalEventFailureDoesNotThrowAfterStoreUpdate();
  await assertCommittedSessionDeletionCleanupPersistsWithoutRunEvents();
  await assertPendingLocalCommitsAreMarkedFailedOnRecovery();
}

async function assertEphemeralHermesCleanupIsUnsupportedInsteadOfRetained(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-hermes-unsupported-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(65_000) });
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime: {
      kind: "hermes",
      async connect() { return { connected: true, label: "Hermes", errors: [] }; },
      async listModels() { return []; },
      async runTask() { return { text: "done", runId: "hermes-run-1" }; },
      async abort() { return undefined; }
    },
    capabilities: "legacy"
  });
  const manager = new NativeExecutionManager({ store, adapters: [adapter], now: fixedClock(65_000) });
  await manager.recordCreated(baseRecord({
    id: "native-hermes-unsupported",
    native: {
      backendId: "hermes",
      id: "hermes-run-1",
      kind: "run",
      persistence: "unknown",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1
    }
  }));
  const settled = await manager.settleRun({
    recordId: "native-hermes-unsupported",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const cleanup = await manager.cleanupDue();

  assert.equal(settled?.requestedDisposition, "delete");
  assert.equal(cleanup[0]?.cleanup, "unsupported");
  assert.equal((await store.get("native-hermes-unsupported"))?.cleanup, "unsupported");
}

async function assertCommittedSessionDeletionCleanupPersistsWithoutRunEvents(): Promise<void> {
  const rootPath = await tempRoot("echoink-session-delete-cleanup-");
  const store = new NativeExecutionStore({ rootPath, now: () => 9_000 });
  const requests: NativeExecutionDispositionRequest[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        requests.push(request);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 9_000,
    emitRunEvent: async () => { throw new Error("synthetic cleanup must not emit run events"); }
  });

  const result = await manager.cleanupCommitted(baseRecord({
    id: "session-delete-native",
    runId: "session-delete:chat-1",
    workflow: "session.delete",
    emitEvents: false,
    dispositionReason: "manual"
  }));
  const stored = await store.get("session-delete-native");

  assert.equal(result.cleanup, "disposed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.reason, "manual");
  assert.equal(stored?.localCommit, "committed");
  assert.equal(stored?.cleanup, "disposed");
  assert.equal(stored?.emitEvents, false);
}

async function assertKnowledgeLocalCommitAndCleanupEventsUseCentralLedgerSequence(): Promise<void> {
  let now = 20_000;
  const rootPath = await tempRoot("echoink-native-ledger-events-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const disposeCalls: NativeExecutionDispositionRequest[] = [];
  const nativeManager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls.push(request);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await nativeManager.recordCreated(baseRecord({
    id: "native-ledger-events",
    runId: "run-ledger-events"
  }));
  await kernel.appendRunEvent({
    runId: "run-ledger-events",
    source: "kernel",
    type: "run.completed",
    backendId: "fake",
    text: "业务成功"
  });

  const seenBeforeCommit: string[] = [];
  const manager = new KnowledgeBaseManager({
    settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings,
    getVaultPath: () => rootPath,
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async (event: HarnessEvent) => {
      seenBeforeCommit.push(event.type);
      await kernel.appendRunEvent(event);
    },
    commitKnowledgeRunDurably: async () => {
      assert.deepEqual(seenBeforeCommit, ["run.local_commit.started"]);
      return localCommit(true);
    },
    recordNativeExecution: async (record: NativeExecutionRecord) => await nativeManager.recordCreated(record),
    settleNativeExecution: async (input: any) => await nativeManager.settleRun(input),
    cleanupDueNativeExecutions: async (limit?: number) => await nativeManager.cleanupDue(limit),
    codex: null
  } as any);

  (manager as any).agentTaskService.pendingNativeExecutionCommits.set("native-ledger-events", {
    runId: "run-ledger-events",
    runOutcome: "success"
  });

  const disposedCount = await manager.settlePendingKnowledgeBaseNativeExecutions();
  const events = await ledger.readRun("run-ledger-events");

  assert.equal(disposedCount, 1);
  assert.deepEqual(events.map((event) => event.type), [
    "run.completed",
    "run.local_commit.started",
    "run.local_commit.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.completed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events[3]?.data, {
    recordId: "native-ledger-events",
    disposition: "process-exit"
  });
  assert.deepEqual(events[4]?.data, {
    recordId: "native-ledger-events",
    disposition: "process-exit"
  });
  assert.deepEqual(events[5]?.data, {
    recordId: "native-ledger-events",
    disposition: "process-exit"
  });
  assert.equal(JSON.stringify(events).includes("fake-native"), false);
  assert.equal(disposeCalls[0]?.ref.id, "fake-native");
}

async function assertKnowledgeLocalCommitEventFailureKeepsDurableCommitGateClosed(): Promise<void> {
  let now = 40_000;
  const rootPath = await tempRoot("echoink-native-ledger-failure-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const nativeManager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await nativeManager.recordCreated(baseRecord({
    id: "native-ledger-failure",
    runId: "run-ledger-failure"
  }));

  let durableCommitCalls = 0;
  const settledInputs: Array<{ localCommit: LocalRunCommitResult }> = [];
  let cleanupCalls = 0;
  const manager = new KnowledgeBaseManager({
    settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings,
    getVaultPath: () => rootPath,
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async (event: HarnessEvent) => {
      if (event.type === "run.local_commit.started") throw new Error("ledger append failed");
      await kernel.appendRunEvent(event);
    },
    commitKnowledgeRunDurably: async () => {
      durableCommitCalls += 1;
      return localCommit(true);
    },
    recordNativeExecution: async (record: NativeExecutionRecord) => await nativeManager.recordCreated(record),
    settleNativeExecution: async (input: any) => {
      settledInputs.push(input);
      return await nativeManager.settleRun(input);
    },
    cleanupDueNativeExecutions: async (limit?: number) => {
      cleanupCalls += limit ?? 0;
      return await nativeManager.cleanupDue(limit);
    },
    codex: null
  } as any);

  (manager as any).agentTaskService.pendingNativeExecutionCommits.set("native-ledger-failure", {
    runId: "run-ledger-failure",
    runOutcome: "success"
  });

  const disposedCount = await manager.settlePendingKnowledgeBaseNativeExecutions();
  const record = await store.get("native-ledger-failure");

  assert.equal(disposedCount, 0);
  assert.equal(durableCommitCalls, 0);
  assert.equal(cleanupCalls, 0);
  assert.equal(settledInputs[0]?.localCommit.committed, false);
  assert.match(settledInputs[0]?.localCommit.error ?? "", /ledger append failed/);
  assert.equal(record?.localCommit, "failed");
  assert.equal(record?.cleanup, "retained-for-recovery");
  assert.deepEqual(await ledger.readRun("run-ledger-failure"), []);
}

async function assertKnowledgeLocalCommitFailureEmitsFailedEventWithoutCleanup(): Promise<void> {
  let now = 50_000;
  const rootPath = await tempRoot("echoink-local-commit-failed-events-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const nativeManager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await nativeManager.recordCreated(baseRecord({
    id: "native-local-commit-failed",
    runId: "run-local-commit-failed"
  }));
  await kernel.appendRunEvent({
    runId: "run-local-commit-failed",
    source: "kernel",
    type: "run.completed",
    backendId: "fake"
  });

  let cleanupCalls = 0;
  const manager = new KnowledgeBaseManager({
    settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings,
    getVaultPath: () => rootPath,
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async (event: HarnessEvent) => {
      await kernel.appendRunEvent(event);
    },
    commitKnowledgeRunDurably: async () => localCommit(false, "history index failed"),
    recordNativeExecution: async (record: NativeExecutionRecord) => await nativeManager.recordCreated(record),
    settleNativeExecution: async (input: any) => await nativeManager.settleRun(input),
    cleanupDueNativeExecutions: async (limit?: number) => {
      cleanupCalls += limit ?? 0;
      return await nativeManager.cleanupDue(limit);
    },
    codex: null
  } as any);

  (manager as any).agentTaskService.pendingNativeExecutionCommits.set("native-local-commit-failed", {
    runId: "run-local-commit-failed",
    runOutcome: "success"
  });

  await manager.settlePendingKnowledgeBaseNativeExecutions();
  const events = await ledger.readRun("run-local-commit-failed");
  const record = await store.get("native-local-commit-failed");

  assert.deepEqual(events.map((event) => event.type), [
    "run.completed",
    "run.local_commit.started",
    "run.local_commit.failed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events[2]?.error, "history index failed");
  assert.equal(cleanupCalls, 0);
  assert.equal(record?.localCommit, "failed");
  assert.equal(record?.cleanup, "retained-for-recovery");
}

async function assertNativeExecutionStoreRebuildsIndexFromJsonl(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-store-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(1000) });
  await store.upsert(baseRecord({ id: "native-1", runId: "run-1" }));
  await store.upsert(baseRecord({ id: "native-2", runId: "run-2" }));

  const reloaded = new NativeExecutionStore({ rootPath, now: fixedClock(2000) });
  const rebuilt = await reloaded.rebuildIndexFromEvents();

  assert.deepEqual(rebuilt.map((record) => record.id).sort(), ["native-1", "native-2"]);
  assert.equal((await reloaded.get("native-1"))?.runId, "run-1");
}

async function assertLocalCommitFailureRetainsNativeExecution(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-commit-gate-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(3000) });
  const disposeCalls: NativeExecutionDispositionRequest[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls.push(request);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: fixedClock(3000)
  });

  await manager.recordCreated(baseRecord({ id: "native-commit-failed" }));
  await manager.settleRun({
    recordId: "native-commit-failed",
    runOutcome: "success",
    localCommit: localCommit(false, "history index failed")
  });
  const cleanup = await manager.cleanupDue();
  const record = await store.get("native-commit-failed");

  assert.deepEqual(cleanup, []);
  assert.equal(disposeCalls.length, 0);
  assert.equal(record?.localCommit, "failed");
  assert.equal(record?.cleanup, "retained-for-recovery");
  assert.match(record?.lastError ?? "", /history index failed/);
}

async function assertCleanupUsesAdapterCapabilityAndRetriesFailures(): Promise<void> {
  let storeNow = 10_000;
  let eventNow = 30_000;
  const rootPath = await tempRoot("echoink-native-cleanup-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => eventNow++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => storeNow });
  const disposeCalls: NativeExecutionDispositionRequest[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls.push(request);
        if (disposeCalls.length === 1) return { outcome: "failed", message: "temporary failure" };
        return { outcome: "already-disposed", applied: request.requested };
      }
    })],
    now: () => storeNow,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });

  await manager.recordCreated(baseRecord({ id: "native-cleanup" }));
  await kernel.appendRunEvent({
    runId: "run-native",
    source: "kernel",
    type: "run.completed",
    backendId: "fake"
  });
  await manager.settleRun({
    recordId: "native-cleanup",
    runOutcome: "success",
    localCommit: localCommit(true)
  });

  const first = await manager.cleanupDue();
  const failed = await store.get("native-cleanup");
  assert.equal(first[0]?.cleanup, "failed");
  assert.equal(disposeCalls[0]?.requested, "process-exit");
  assert.equal(failed?.cleanup, "failed");
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.nextAttemptAt, 70_000);

  assert.deepEqual(await manager.cleanupDue(), []);
  storeNow = 70_000;
  const second = await manager.cleanupDue();
  const disposed = await store.get("native-cleanup");

  assert.equal(second[0]?.cleanup, "disposed");
  assert.equal(disposeCalls.length, 2);
  assert.equal(disposed?.cleanup, "disposed");
  assert.equal(disposed?.appliedDisposition, "process-exit");
  const events = await ledger.readRun("run-native");
  assert.deepEqual(events.map((event) => event.type), [
    "run.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.failed",
    "agent.native_cleanup.started",
    "agent.native_cleanup.completed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events[1]?.data, { recordId: "native-cleanup", disposition: "process-exit" });
  assert.deepEqual(events[3]?.data, { recordId: "native-cleanup", disposition: "process-exit" });
  assert.equal(events[3]?.error, "temporary failure");
  assert.deepEqual(events[5]?.data, { recordId: "native-cleanup", disposition: "process-exit" });
}

async function assertCleanupUnsupportedAndRetainedEvents(): Promise<void> {
  await assertCleanupTerminalEventSequence("unsupported", async (request) => ({
    outcome: "unsupported",
    message: `unsupported:${request.requested}`
  }), [
    "run.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.unsupported"
  ], "unsupported:process-exit");
  await assertCleanupTerminalEventSequence("retained", async (request) => ({
    outcome: "retained",
    message: `retained:${request.requested}`
  }), [
    "run.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.retained"
  ], "retained:process-exit");
}

async function assertCleanupTerminalEventSequence(
  suffix: string,
  onDisposeNativeExecution: (request: NativeExecutionDispositionRequest) => Promise<{ outcome: "unsupported" | "retained"; message: string }>,
  expectedTypes: string[],
  expectedError: string
): Promise<void> {
  let now = 60_000;
  const rootPath = await tempRoot(`echoink-native-cleanup-${suffix}-`);
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await manager.recordCreated(baseRecord({
    id: `native-cleanup-${suffix}`,
    runId: `run-cleanup-${suffix}`
  }));
  await kernel.appendRunEvent({
    runId: `run-cleanup-${suffix}`,
    source: "kernel",
    type: "run.completed",
    backendId: "fake"
  });
  await manager.settleRun({
    recordId: `native-cleanup-${suffix}`,
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const result = await manager.cleanupDue();
  const events = await ledger.readRun(`run-cleanup-${suffix}`);

  assert.deepEqual(events.map((event) => event.type), expectedTypes);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(events[1]?.data, {
    recordId: `native-cleanup-${suffix}`,
    disposition: "process-exit"
  });
  assert.equal(events[3]?.error, expectedError);
  assert.equal(result[0]?.recordId, `native-cleanup-${suffix}`);
}

async function assertScheduledEventFailureKeepsCleanupRecoverable(): Promise<void> {
  let now = 70_000;
  const rootPath = await tempRoot("echoink-native-scheduled-event-failure-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  let failScheduled = true;
  const manager = new NativeExecutionManager({
    store: new NativeExecutionStore({ rootPath, now: () => now++ }),
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => {
      if (failScheduled && event.type === "agent.native_cleanup.scheduled") throw new Error("scheduled event failed");
      await kernel.appendRunEvent(event);
    }
  });

  await manager.recordCreated(baseRecord({
    id: "native-scheduled-event-failure",
    runId: "run-scheduled-event-failure"
  }));
  const settled = await manager.settleRun({
    recordId: "native-scheduled-event-failure",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const afterFailedSchedule = settled ? await (manager as any).options.store.get("native-scheduled-event-failure") : null;

  failScheduled = false;
  const cleanup = await manager.cleanupDue();

  assert.equal(settled?.cleanup, "pending");
  assert.match(afterFailedSchedule?.lastError ?? "", /scheduled event failed/);
  assert.equal(cleanup[0]?.cleanup, "disposed");
}

async function assertCleanupTerminalEventFailureDoesNotThrowAfterStoreUpdate(): Promise<void> {
  let now = 80_000;
  const rootPath = await tempRoot("echoink-native-terminal-event-failure-");
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => {
      if (event.type === "agent.native_cleanup.completed") throw new Error("completed event failed");
    }
  });

  await manager.recordCreated(baseRecord({
    id: "native-terminal-event-failure",
    runId: "run-terminal-event-failure"
  }));
  await manager.settleRun({
    recordId: "native-terminal-event-failure",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const cleanup = await manager.cleanupDue();
  const record = await store.get("native-terminal-event-failure");

  assert.equal(cleanup[0]?.cleanup, "disposed");
  assert.match(cleanup[0]?.message ?? "", /completed event failed/);
  assert.equal(record?.cleanup, "disposed");
  assert.match(record?.lastError ?? "", /completed event failed/);
}

async function assertPendingLocalCommitsAreMarkedFailedOnRecovery(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-recovery-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(7000) });
  const manager = new NativeExecutionManager({ store, adapters: [], now: fixedClock(8000) });
  await manager.recordCreated(baseRecord({ id: "knowledge-pending", surface: "knowledge" }));
  await manager.recordCreated(baseRecord({ id: "chat-pending", surface: "chat" }));

  assert.deepEqual(
    (await manager.listPendingLocalCommits({ surface: "knowledge" })).map((record) => record.id),
    ["knowledge-pending"]
  );

  const updated = await manager.markPendingLocalCommitsFailed("plugin reloaded", { surface: "knowledge" });
  assert.equal(updated, 1);

  const knowledge = await store.get("knowledge-pending");
  assert.equal(knowledge?.localCommit, "failed");
  assert.equal(knowledge?.cleanup, "retained-for-recovery");
  assert.equal(knowledge?.runOutcome, "failed");
  assert.equal(knowledge?.settledAt, 8000);
  assert.equal(knowledge?.lastError, "plugin reloaded");

  const chat = await store.get("chat-pending");
  assert.equal(chat?.localCommit, "pending");
}

function baseRecord(overrides: Partial<NativeExecutionRecord> = {}): NativeExecutionRecord {
  return {
    id: "native-1",
    runId: "run-native",
    sessionId: "session-native",
    surface: "knowledge",
    workflow: "knowledge.maintain",
    native: {
      backendId: "fake",
      id: "fake-native",
      kind: "process",
      persistence: "process-local",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["delete", "archive", "process-exit", "retain"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    localCommit: "pending",
    cleanup: "not-needed",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt: 1,
    settledAt: 0,
    committedAt: 0,
    disposedAt: 0,
    ...overrides
  };
}

function localCommit(committed: boolean, error = ""): LocalRunCommitResult {
  return {
    committed,
    conversationCommitted: committed,
    runLedgerCommitted: committed,
    artifactsCommitted: committed,
    historyIndexCommitted: committed,
    ...(error ? { error } : {})
  };
}

function fixedClock(start: number): () => number {
  let current = start;
  return () => current++;
}

async function tempRoot(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}
