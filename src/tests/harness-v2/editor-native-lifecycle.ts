import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import { AcpAgentRuntime, type AcpSubprocessLike } from "../../agent/acp-runtime";
import { createAgentEventRuntimeWithFallback } from "../../agent/event-task";
import { OpenCodeRichRuntime, type OpenCodeRichRuntimeBackend } from "../../agent/opencode-rich-runtime";
import type { AgentRichStreamRuntime, AgentTaskRuntime } from "../../agent/runtime";
import { NativeRunRegistrationError } from "../../agent/types";
import type { AgentAdapter } from "../../harness/agents/adapter";
import type { CreateHarnessAgentAdapterInput } from "../../harness/agents/adapter-factory";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../../harness/agents/adapters/codex-rich-notification-hub";
import { TaskRuntimeAgentAdapter } from "../../harness/agents/adapters/task-runtime-adapter";
import type {
  LocalRunCommitResult,
  NativeExecutionRecord,
  NativeRunOutcome
} from "../../harness/contracts/native-execution";
import type { HarnessEvent } from "../../harness/contracts/event";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { DEFAULT_SETTINGS } from "../../settings/settings";
import { CodexView } from "../../ui/codex-view";
import {
  EditorNativeLifecycle,
  runEditorActionPromptTurn,
  sendEditorActionRequest
} from "../../ui/codex-view/editor-action-runner";

export async function runHarnessV2EditorNativeLifecycleTests(): Promise<void> {
  await assertCodexRegistersBeforePromptAndCleansAfterLocalCommit();
  await assertCodexRegistrationFailureDoesNotSubmitPromptAndDisposesOnce();
  await assertCodexStaleReplacementKeepsBothNativeRecords();
  await assertOpenCodeWaitsForRegistrationBeforePrompt();
  await assertHermesAcpWaitsForRegistrationBeforePrompt();
  await assertTaskRuntimeRegistrationFailureCleansOnce("opencode");
  await assertTaskRuntimeRegistrationFailureCleansOnce("hermes");
  await assertTaskBackendEditorLifecycleTerminals("opencode");
  await assertTaskBackendEditorLifecycleTerminals("hermes");
  await assertTaskBackendInvalidCandidateCommitsFailedTerminal("opencode");
  await assertTaskBackendInvalidCandidateCommitsFailedTerminal("hermes");
  await assertEditorTerminalCommitFailureRetainsNative();
  await assertEditorViewCloseBeforeHarnessStart("backend-connect");
  await assertEditorViewCloseBeforeHarnessStart("resource-catalog");
  await assertEditorCandidateReturnedThenViewCloseCommitsCancelledTerminal();
  await assertEditorViewCloseLeavesTerminalToRunner(false);
  await assertEditorViewCloseLeavesTerminalToRunner(true);
  await assertEditorCloseReopenKeepsNewRunStateWhenOldFinallySettles();
  await assertRegistrationFailureCannotLaunchFallback();
  await assertNativePrewarmIsRemovedAndCandidateKeysDoNotCleanNativeState();
}

async function assertCodexRegistersBeforePromptAndCleansAfterLocalCommit(): Promise<void> {
  const order: string[] = [];
  const harness = createCodexEditorHarness({
    order,
    threadIds: ["editor-thread-1"]
  });

  const result = await runEditorActionPromptTurn(harness.view, editorTurnInput());

  assert.equal(result, "新句子");
  assert.deepEqual(harness.records.map((record) => record.native.id), ["editor-thread-1"]);
  assert.equal(harness.settled.length, 1);
  assert.equal(harness.settled[0]?.localCommit.committed, true);
  assert.deepEqual(harness.cleanedRecordIds, [harness.records[0]?.id]);
  assertOrder(order, [
    "thread:editor-thread-1",
    "record:editor-thread-1",
    "prompt:editor-thread-1",
    "ledger:completed",
    "adapter:dispose",
    `native:settle:${harness.records[0]?.id}`,
    `native:cleanup:${harness.records[0]?.id}`
  ]);
}

async function assertCodexRegistrationFailureDoesNotSubmitPromptAndDisposesOnce(): Promise<void> {
  const order: string[] = [];
  const harness = createCodexEditorHarness({
    order,
    threadIds: ["editor-thread-registration-failed"],
    recordError: new Error("native store unavailable")
  });

  await assert.rejects(
    runEditorActionPromptTurn(harness.view, editorTurnInput()),
    /native store unavailable/
  );

  assert.equal(order.filter((item) => item.startsWith("prompt:")).length, 0);
  assert.deepEqual(order.filter((item) => item === "archive:editor-thread-registration-failed"), [
    "archive:editor-thread-registration-failed"
  ]);
  assert.equal(harness.settled.length, 0);
  assert.deepEqual(harness.cleanedRecordIds, []);
}

async function assertCodexStaleReplacementKeepsBothNativeRecords(): Promise<void> {
  const order: string[] = [];
  const harness = createCodexEditorHarness({
    order,
    threadIds: ["editor-thread-stale", "editor-thread-replacement"],
    staleThreadId: "editor-thread-stale"
  });

  const result = await runEditorActionPromptTurn(harness.view, editorTurnInput());

  assert.equal(result, "新句子");
  assert.deepEqual(harness.records.map((record) => record.native.id), [
    "editor-thread-stale",
    "editor-thread-replacement"
  ]);
  assert.equal(new Set(harness.records.map((record) => record.id)).size, 2);
  assert.equal(harness.settled.length, 2);
  assert.deepEqual(harness.cleanedRecordIds, harness.records.map((record) => record.id));
}

async function assertOpenCodeWaitsForRegistrationBeforePrompt(): Promise<void> {
  let promptCalls = 0;
  let subscribeCalls = 0;
  const backend: OpenCodeRichRuntimeBackend = {
    async connect() { return undefined; },
    async disconnect() { return undefined; },
    getConnectionInfo() {
      return { connected: true, serverUrl: "http://127.0.0.1:4096", command: "opencode", version: "test", errors: [] };
    },
    async listModels() { return []; },
    async listAgents() { return []; },
    async hasSession() { return false; },
    async updateSessionPermissions() { return undefined; },
    async deleteSession() { return true; },
    async startSession() { return { sessionId: "opencode-editor-session", title: "Editor" }; },
    async sendPromptAsync() { promptCalls += 1; },
    async subscribeEvents() {
      subscribeCalls += 1;
      return emptyAsyncIterable();
    },
    async replyPermission() { return undefined; },
    async getSessionStatus() { return "idle"; },
    async readSessionMessages() { return []; },
    async runCliTask() { throw new Error("CLI fallback must not run"); },
    async abort() { return undefined; }
  };
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20 });

  await assert.rejects(runtime.runTaskStream({
    prompt: "rewrite",
    permission: "read-only",
    onRunId: async () => {
      await Promise.resolve();
      throw new Error("registration rejected");
    }
  }, () => undefined), /registration rejected/);

  assert.equal(promptCalls, 0);
  assert.equal(subscribeCalls, 0);
}

async function assertHermesAcpWaitsForRegistrationBeforePrompt(): Promise<void> {
  let promptCalls = 0;
  const fake = createFakeAcpProcess((message, write) => {
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      return;
    }
    if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-editor-session" } });
      return;
    }
    if (message.method === "session/prompt") promptCalls += 1;
  });
  const runtime = new AcpAgentRuntime({
    backend: "hermes",
    command: { command: "hermes", args: ["acp"], cwd: "/vault" },
    processFactory: () => fake.process
  });

  await assert.rejects(runtime.runTaskStream({
    prompt: "rewrite",
    permission: "read-only",
    onRunId: async () => {
      await Promise.resolve();
      throw new Error("registration rejected");
    }
  }, () => undefined), /registration rejected/);

  assert.equal(promptCalls, 0);
  await runtime.disconnect();
}

async function assertTaskRuntimeRegistrationFailureCleansOnce(
  backend: "opencode" | "hermes"
): Promise<void> {
  const nativeId = `${backend}-editor-registration-failed`;
  let promptCalls = 0;
  let deleteCalls = 0;
  let abortCalls = 0;
  const runtime: AgentTaskRuntime = {
    kind: backend,
    async connect() {
      return { connected: true, label: backend, errors: [] };
    },
    async listModels() {
      return [];
    },
    async runTask(input) {
      await input.onRunId?.(nativeId);
      promptCalls += 1;
      return { text: "unsafe prompt result", runId: nativeId };
    },
    async deleteNativeSession() {
      deleteCalls += 1;
      return true;
    },
    async abort() {
      abortCalls += 1;
    }
  };
  const nativeRefContext = {
    providerEndpoint: "http://127.0.0.1:4096",
    deviceKey: "test-device",
    vaultId: "/vault"
  };
  const view: any = {
    plugin: {
      getNativeExecutionRefContext: () => nativeRefContext,
      recordNativeExecution: async () => {
        throw new Error("native store unavailable");
      }
    }
  };
  let adapter: AgentAdapter | null = null;
  const lifecycle = new EditorNativeLifecycle({
    view,
    runId: `editor-${backend}-run`,
    sessionId: `editor-action:${backend}`,
    workflow: "editor.rewrite",
    backend,
    adapter: () => adapter
  });
  adapter = new TaskRuntimeAgentAdapter({
    backendId: backend,
    displayName: backend,
    version: "test",
    runtime,
    nativeRefContext,
    capabilities: "legacy",
    legacyTaskDefaults: {
      requireNativeRegistrationBeforePrompt: true,
      onRunId: async (id) => await lifecycle.registerId(id, false)
    }
  });

  await assert.rejects(
    adapter.run(editorAdapterRequest(`editor-${backend}-run`, backend), () => undefined),
    /native store unavailable/
  );

  assert.equal(promptCalls, 0, `${backend} must not submit Prompt before registration`);
  assert.equal(deleteCalls, backend === "opencode" ? 1 : 0, `${backend} cleanup must delete exactly once`);
  assert.equal(abortCalls, backend === "hermes" ? 1 : 0, `${backend} cleanup must abort exactly once`);
}

async function assertTaskBackendEditorLifecycleTerminals(
  backend: "opencode" | "hermes"
): Promise<void> {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    await assertTaskBackendEditorLifecycleTerminal({
      backend,
      status,
      cleanupFails: status === "completed"
    });
  }
}

async function assertTaskBackendInvalidCandidateCommitsFailedTerminal(
  backend: "opencode" | "hermes"
): Promise<void> {
  await assertTaskBackendEditorLifecycleTerminal({
    backend,
    status: "completed",
    expectedTerminalStatus: "failed",
    candidateText: "<codex-candidate>   </codex-candidate>",
    expectedError: /没有返回可用候选文本/,
    cleanupFails: false
  });
}

async function assertEditorTerminalCommitFailureRetainsNative(): Promise<void> {
  await assertTaskBackendEditorLifecycleTerminal({
    backend: "opencode",
    status: "completed",
    expectedTerminalStatus: "completed",
    terminalCommitError: new Error("Run Ledger unavailable"),
    expectedError: /Run Ledger unavailable/,
    cleanupFails: false
  });
}

async function assertEditorCandidateReturnedThenViewCloseCommitsCancelledTerminal(): Promise<void> {
  await assertTaskBackendEditorLifecycleTerminal({
    backend: "opencode",
    status: "completed",
    expectedTerminalStatus: "cancelled",
    expectedError: /侧栏已关闭.*已取消/,
    cleanupFails: false,
    closeBeforeTerminal: true
  });
}

async function assertEditorViewCloseBeforeHarnessStart(
  closeAt: "backend-connect" | "resource-catalog"
): Promise<void> {
  const connectionStarted = deferred<void>();
  const releaseConnection = deferred<any>();
  const resourceCatalogStarted = deferred<void>();
  const releaseResourceCatalog = deferred<any>();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.capabilities.editorActionBackend = "opencode";
  settings.editorActions.qualityMode = "fast";
  let adapterBuildCalls = 0;
  let harnessRunCalls = 0;
  let nativeRecordCalls = 0;
  let terminalCalls = 0;
  let promptCalls = 0;
  let cancelCalls = 0;
  let rendererDisposeCalls = 0;
  let flushCalls = 0;
  const plugin: any = {
    settings,
    getVaultPath: () => "/vault",
    getNativeExecutionRefContext: () => ({
      providerEndpoint: "http://opencode.test",
      deviceKey: "test-device",
      vaultId: "/vault"
    }),
    ensureHarnessBackendConnected: async () => {
      connectionStarted.resolve();
      return await releaseConnection.promise;
    },
    buildRuntimeEchoInkResourceCatalog: async () => {
      resourceCatalogStarted.resolve();
      return await releaseResourceCatalog.promise;
    },
    runHarnessWithAdapter: async () => {
      harnessRunCalls += 1;
      promptCalls += 1;
      throw new Error("Harness must not start after the Editor view closes");
    },
    recordNativeExecution: async () => {
      nativeRecordCalls += 1;
    },
    settleHarnessRunTerminal: async () => {
      terminalCalls += 1;
      throw new Error("terminal must not be created for a pre-start close");
    },
    saveSettings: async () => undefined,
    cancelHarnessRun: async () => {
      cancelCalls += 1;
    }
  };
  const view: any = {
    plugin,
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    promptEnhancerRunning: false,
    promptEnhancerRunId: "",
    promptEnhancerTurnId: "",
    editorActionHarnessRunId: "",
    editorActionActiveTimeoutMs: 0,
    editorActionThreadId: "",
    editorActionCurrentItemIds: new Set<string>(),
    articleUnderstandingPanelState: { status: "idle" },
    createEditorActionHarnessAdapter: () => {
      adapterBuildCalls += 1;
      throw new Error("adapter must not be built after the Editor view closes");
    },
    editorActionStartBlockReason: () => null,
    clearTurnWatchdog: () => undefined,
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    clearActiveRun: () => undefined,
    applyStatus: () => undefined,
    renderToolbar: () => undefined,
    diagnoseCodexFailure: () => ({ title: "failed", text: "failed" }),
    setEditorActionStatus: () => undefined,
    withEditorActionTimeout: async <T>(promise: Promise<T>) => await promise,
    effectiveEditorActionModel: (
      _available: string[],
      configured: string
    ) => configured,
    takeEditorActionThread: async () => {
      promptCalls += 1;
      throw new Error("Codex thread must not start after the Editor view closes");
    },
    cleanupNativeExecutionRecord: async () => undefined,
    releaseEditorActionRunLock: () => undefined,
    renderEditorActionStatus: () => undefined,
    activeProviderModels: () => [],
    activeRunSession: () => {
      throw new Error("pre-start Editor close has no Conversation session");
    },
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    flushSessionSave: async () => {
      flushCalls += 1;
    },
    messageListRenderer: {
      dispose: () => {
        rendererDisposeCalls += 1;
      }
    }
  };
  attachViewLifecycle(view);

  const run = sendEditorActionRequest(view, editorActionRequestFixture());
  const rejected = assert.rejects(run, /侧栏已关闭.*已取消/);
  await connectionStarted.promise;
  if (closeAt === "resource-catalog") {
    releaseConnection.resolve({
      connected: true,
      label: "OpenCode",
      errors: [],
      models: []
    });
    await resourceCatalogStarted.promise;
  }

  await CodexView.prototype.onClose.call(view);
  if (closeAt === "backend-connect") {
    releaseConnection.resolve({
      connected: true,
      label: "OpenCode",
      errors: [],
      models: []
    });
  } else {
    releaseResourceCatalog.resolve({
      resources: [],
      warnings: [],
      capturedAt: Date.now()
    });
  }
  await rejected;
  await Promise.resolve();

  assert.equal(view.activeRunId, "");
  assert.equal(view.activeRunKind, "");
  assert.equal(view.editorActionHarnessRunId, "");
  assert.equal(adapterBuildCalls, 0);
  assert.equal(harnessRunCalls, 0);
  assert.equal(nativeRecordCalls, 0);
  assert.equal(terminalCalls, 0);
  assert.equal(promptCalls, 0);
  assert.equal(cancelCalls, 0, "a pre-start close must use the View AbortSignal, not cancel a nonexistent Harness run");
  assert.equal(flushCalls, 1);
  assert.equal(rendererDisposeCalls, 1);
}

async function assertEditorViewCloseLeavesTerminalToRunner(
  cancelFails: boolean
): Promise<void> {
  const scenario = cancelFails ? "cancel-failed" : "cancelled";
  const nativeId = `editor-close-${scenario}-native`;
  const order: string[] = [];
  const terminalInputs: Array<{
    runId: string;
    status: "completed" | "failed" | "cancelled";
    backendId?: string;
    text?: string;
    error?: string;
  }> = [];
  const records: NativeExecutionRecord[] = [];
  const settlements: Array<{
    recordId: string;
    runOutcome: NativeRunOutcome;
    localCommit: LocalRunCommitResult;
  }> = [];
  const cleanedRecordIds: string[] = [];
  const statuses: Array<Record<string, unknown>> = [];
  const promptStarted = deferred<void>();
  const releasePrompt = deferred<void>();
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider()
  });
  let abortCalls = 0;
  let rendererDisposeCalls = 0;
  let flushCalls = 0;
  const runtime: AgentTaskRuntime = {
    kind: "opencode",
    async connect() {
      return { connected: true, label: "OpenCode", errors: [] };
    },
    async disconnect() {
      order.push("adapter:dispose");
    },
    async listModels() {
      return [];
    },
    async runTask(task) {
      await task.onRunId?.(nativeId);
      order.push(`prompt:${nativeId}`);
      promptStarted.resolve();
      await releasePrompt.promise;
      return {
        text: "<codex-candidate>不应采用的迟到候选</codex-candidate>",
        runId: nativeId
      };
    },
    async abort(id) {
      abortCalls += 1;
      order.push(`adapter:cancel:${id}`);
      if (cancelFails) throw new Error("provider abort unavailable");
    }
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.capabilities.editorActionBackend = "opencode";
  const nativeRefContext = {
    providerEndpoint: "http://opencode.test",
    deviceKey: "test-device",
    vaultId: "/vault"
  };
  const plugin: any = {
    settings,
    getVaultPath: () => "/vault",
    getNativeExecutionRefContext: () => nativeRefContext,
    runHarnessWithAdapter: async (
      request: Parameters<EchoInkHarnessKernel["runWithAdapter"]>[0]
    ) => await kernel.runWithAdapter(request),
    cancelHarnessRun: async (runId: string) => {
      order.push(`view-close:cancel:${runId}`);
      await kernel.cancelRun(runId);
    },
    settleHarnessRunTerminal: async (terminal: {
      runId: string;
      status: "completed" | "failed" | "cancelled";
      backendId?: string;
      text?: string;
      error?: string;
    }) => {
      terminalInputs.push(structuredClone(terminal));
      order.push(`product-terminal:${terminal.status}`);
      return await kernel.settleRunTerminal(terminal);
    },
    recordNativeExecution: async (record: NativeExecutionRecord) => {
      records.push(structuredClone(record));
      order.push(`native:record:${record.native.id}`);
    },
    settleNativeExecution: async (settlement: {
      recordId: string;
      runOutcome: NativeRunOutcome;
      localCommit: LocalRunCommitResult;
    }) => {
      settlements.push(structuredClone(settlement));
      order.push(
        `native:settle:${settlement.runOutcome}:${String(settlement.localCommit.committed)}`
      );
      const record = records.find((item) => item.id === settlement.recordId);
      return record
        ? {
          ...record,
          runOutcome: settlement.runOutcome,
          localCommit: settlement.localCommit.committed
            ? "committed" as const
            : "failed" as const,
          cleanup: settlement.localCommit.committed
            ? "pending" as const
            : "not-needed" as const
        }
        : null;
    },
    saveSettings: async () => {
      order.push("view-close:save-settings");
    }
  };
  const view: any = {
    plugin,
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    activeRunNativeExecutionRecordIds: [],
    promptEnhancerRunning: false,
    promptEnhancerRunId: "",
    promptEnhancerTurnId: "",
    editorActionHarnessRunId: "",
    editorActionActiveTimeoutMs: 0,
    editorActionThreadId: "",
    editorActionCurrentItemIds: new Set<string>(),
    articleUnderstandingPanelState: { status: "idle" },
    createEditorActionHarnessAdapter: (
      builderInput: CreateHarnessAgentAdapterInput
    ) => new TaskRuntimeAgentAdapter({
      backendId: builderInput.backendId,
      displayName: "OpenCode",
      version: "test",
      runtime,
      nativeRefContext: builderInput.nativeRefContext,
      capabilities: "legacy",
      legacyTaskDefaults: builderInput.task
    }),
    cleanupNativeExecutionRecord: async (recordId: string) => {
      cleanedRecordIds.push(recordId);
      order.push(`native:cleanup:${recordId}`);
    },
    releaseEditorActionRunLock: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    clearActiveRun: () => {
      view.activeRunId = "";
      view.activeRunKind = "";
      view.activeRunSessionId = "";
      view.activeTurnId = "";
      view.activeRunNativeExecutionRecordIds = [];
    },
    applyStatus: () => undefined,
    setEditorActionStatus: (status: Record<string, unknown>) => {
      statuses.push(structuredClone(status));
    },
    armTurnWatchdog: () => undefined,
    effectiveEditorActionModel: (
      _available: string[],
      configured: string
    ) => configured,
    withEditorActionTimeout: async <T>(promise: Promise<T>) => await promise,
    renderEditorActionStatus: () => undefined,
    activeProviderModels: () => [],
    activeRunSession: () => {
      throw new Error("Editor close must not resolve a Conversation session");
    },
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    flushSessionSave: async () => {
      flushCalls += 1;
      order.push("view-close:flush");
    },
    messageListRenderer: {
      dispose: () => {
        rendererDisposeCalls += 1;
        order.push("view-close:dispose-renderer");
      }
    }
  };
  attachViewLifecycle(view);

  const run = runEditorActionPromptTurn(view, editorTurnInput());
  await promptStarted.promise;
  const runId = view.activeRunId;
  assert.ok(runId);
  assert.equal(view.activeRunKind, "editor");

  await CodexView.prototype.onClose.call(view);

  assert.equal(abortCalls, 1);
  assert.equal(view.activeRunId, "");
  assert.equal(view.activeRunKind, "");
  assert.equal(view.running, false);
  assert.equal(flushCalls, 1);
  assert.equal(rendererDisposeCalls, 1);
  assert.deepEqual(
    statuses.at(-1),
    cancelFails
      ? {
        status: "failed",
        message: "中断失败",
        error: "provider abort unavailable"
      }
      : { status: "canceled", message: "侧栏已关闭" }
  );
  assert.equal(
    terminalInputs.length,
    0,
    "onClose must not become a second Editor terminal authority"
  );
  assert.equal(
    (await ledger.readRun(runId)).some((event) =>
      event.type === "run.completed"
      || event.type === "run.failed"
      || event.type === "run.cancelled"
    ),
    false,
    "closing state must not write a Run Ledger terminal before the runner settles"
  );

  releasePrompt.resolve();
  await assert.rejects(run, /侧栏已关闭.*已取消/);

  assert.deepEqual(terminalInputs, [{
    runId,
    status: "cancelled",
    backendId: "opencode",
    error: "EchoInk 侧栏已关闭，Editor 操作已取消。"
  }]);
  const durableTerminals = (await ledger.readRun(runId)).filter((event) =>
    event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled"
  );
  assert.equal(durableTerminals.length, 1);
  assert.equal(durableTerminals[0]?.type, "run.cancelled");
  assert.equal(durableTerminals[0]?.backendId, "opencode");
  assert.equal(records.length, 1);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.runOutcome, "cancelled");
  assert.equal(settlements[0]?.localCommit.committed, true);
  assert.deepEqual(cleanedRecordIds, [records[0]?.id]);
  assertOrder(order, [
    `native:record:${nativeId}`,
    `prompt:${nativeId}`,
    `view-close:cancel:${runId}`,
    `adapter:cancel:${nativeId}`,
    "product-terminal:cancelled",
    "adapter:dispose",
    "native:settle:cancelled:true",
    `native:cleanup:${records[0]?.id}`
  ]);
}

async function assertEditorCloseReopenKeepsNewRunStateWhenOldFinallySettles(): Promise<void> {
  const oldDisposeStarted = deferred<void>();
  const releaseOldDispose = deferred<void>();
  const newHarnessStarted = deferred<void>();
  const releaseNewHarness = deferred<void>();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.capabilities.editorActionBackend = "opencode";
  let adapterBuildCalls = 0;
  let harnessRunCalls = 0;
  let clearActiveRunCalls = 0;
  let clearTurnWatchdogCalls = 0;
  let applyStatusCalls = 0;
  let rendererDisposeCalls = 0;
  let oldBuilderInput: CreateHarnessAgentAdapterInput | null = null;
  const releasedRunIds: string[] = [];
  const cancelledRunIds: string[] = [];
  const terminalStatuses: string[] = [];
  const plugin: any = {
    settings,
    lastStatus: null,
    getVaultPath: () => "/vault",
    getNativeExecutionRefContext: () => ({
      providerEndpoint: "http://opencode.test",
      deviceKey: "test-device",
      vaultId: "/vault"
    }),
    runHarnessWithAdapter: async (request: any) => {
      harnessRunCalls += 1;
      if (harnessRunCalls === 2) {
        newHarnessStarted.resolve();
        await releaseNewHarness.promise;
      }
      return {
        runId: request.request.runId,
        status: "completed",
        outputText: harnessRunCalls === 1
          ? "<codex-candidate>旧候选</codex-candidate>"
          : "<codex-candidate>新候选</codex-candidate>"
      };
    },
    settleHarnessRunTerminal: async (terminal: {
      runId: string;
      status: "completed" | "failed" | "cancelled";
      backendId: string;
      text?: string;
      error?: string;
    }) => {
      terminalStatuses.push(terminal.status);
      return {
        runId: terminal.runId,
        type: `run.${terminal.status}`,
        backendId: terminal.backendId,
        ...(terminal.text !== undefined ? { text: terminal.text } : {}),
        ...(terminal.error !== undefined ? { error: terminal.error } : {})
      };
    },
    cancelHarnessRun: async (runId: string) => {
      cancelledRunIds.push(runId);
    },
    ensureCodexConnected: async () => ({
      connected: true,
      label: "Codex",
      errors: []
    }),
    saveSettings: async () => undefined
  };
  const view: any = {
    plugin,
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    promptEnhancerRunning: false,
    promptEnhancerRunId: "",
    promptEnhancerTurnId: "",
    editorActionHarnessRunId: "",
    editorActionActiveTimeoutMs: 0,
    editorActionThreadId: "",
    editorActionCurrentItemIds: new Set<string>(),
    articleUnderstandingPanelState: { status: "idle" },
    createEditorActionHarnessAdapter: (
      builderInput: CreateHarnessAgentAdapterInput
    ) => {
      adapterBuildCalls += 1;
      const adapterOrdinal = adapterBuildCalls;
      if (adapterOrdinal === 1) oldBuilderInput = builderInput;
      return {
        dispose: async () => {
          if (adapterOrdinal !== 1) return;
          oldDisposeStarted.resolve();
          await releaseOldDispose.promise;
        }
      };
    },
    cleanupNativeExecutionRecord: async () => undefined,
    releaseEditorActionRunLock: (runId: string) => {
      releasedRunIds.push(runId);
    },
    clearTurnWatchdog: () => {
      clearTurnWatchdogCalls += 1;
    },
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    clearActiveRun: () => {
      clearActiveRunCalls += 1;
      view.activeRunId = "";
      view.activeRunKind = "";
      view.activeRunSessionId = "";
      view.activeTurnId = "";
    },
    applyStatus: () => {
      applyStatusCalls += 1;
    },
    setEditorActionStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    effectiveEditorActionModel: (
      _available: string[],
      configured: string
    ) => configured,
    withEditorActionTimeout: async <T>(promise: Promise<T>) => await promise,
    renderEditorActionStatus: () => undefined,
    activeProviderModels: () => [],
    activeRunSession: () => {
      throw new Error("Editor close must not resolve a Conversation session");
    },
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    flushSessionSave: async () => undefined,
    messageListRenderer: {
      dispose: () => {
        rendererDisposeCalls += 1;
      }
    },
    render: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderKnowledgeDashboard: () => undefined,
    refreshKnowledgeDashboard: async () => undefined
  };
  attachViewLifecycle(view);

  const oldRun = runEditorActionPromptTurn(view, editorTurnInput());
  await oldDisposeStarted.promise;
  const oldRunId = view.activeRunId;
  assert.ok(oldRunId);

  await CodexView.prototype.onClose.call(view);
  await CodexView.prototype.onOpen.call(view);

  const newRun = runEditorActionPromptTurn(view, {
    ...editorTurnInput(),
    prompt: "请生成新候选"
  });
  await newHarnessStarted.promise;
  const newRunId = view.activeRunId;
  assert.ok(newRunId);
  assert.notEqual(newRunId, oldRunId);
  view.activeTurnId = "new-turn-marker";
  view.editorActionThreadId = "new-thread-marker";
  view.editorActionActiveTimeoutMs = 777;
  view.editorActionCurrentItemIds.add("new-item-marker");
  const clearActiveBeforeOldFinally = clearActiveRunCalls;
  const clearWatchdogBeforeOldFinally = clearTurnWatchdogCalls;
  const applyStatusBeforeOldFinally = applyStatusCalls;
  const releasesBeforeOldFinally = releasedRunIds.length;

  assert.ok(oldBuilderInput?.codexRich);
  oldBuilderInput.codexRich.setNativeThreadId("stale-thread");
  oldBuilderInput.codexRich.onTurnStarted?.({
    threadId: "stale-thread",
    turnId: "stale-turn"
  });
  releaseOldDispose.resolve();
  assert.equal(await oldRun, "旧候选");

  assert.equal(view.activeRunId, newRunId);
  assert.equal(view.activeRunKind, "editor");
  assert.equal(view.running, true);
  assert.equal(view.activeTurnId, "new-turn-marker");
  assert.equal(view.editorActionThreadId, "new-thread-marker");
  assert.equal(view.editorActionActiveTimeoutMs, 777);
  assert.equal(view.editorActionCurrentItemIds.has("new-item-marker"), true);
  assert.equal(clearActiveRunCalls, clearActiveBeforeOldFinally);
  assert.equal(clearTurnWatchdogCalls, clearWatchdogBeforeOldFinally);
  assert.equal(applyStatusCalls, applyStatusBeforeOldFinally);
  assert.equal(releasedRunIds.length, releasesBeforeOldFinally);

  releaseNewHarness.resolve();
  assert.equal(await newRun, "新候选");
  assert.deepEqual(terminalStatuses, ["completed", "completed"]);
  assert.deepEqual(cancelledRunIds, [oldRunId]);
  assert.equal(rendererDisposeCalls, 1);
}

async function assertTaskBackendEditorLifecycleTerminal(input: {
  backend: "opencode" | "hermes";
  status: "completed" | "failed" | "cancelled";
  expectedTerminalStatus?: "completed" | "failed" | "cancelled";
  candidateText?: string;
  expectedError?: RegExp;
  terminalCommitError?: Error;
  cleanupFails: boolean;
  closeBeforeTerminal?: boolean;
}): Promise<void> {
  const expectedTerminalStatus = input.expectedTerminalStatus ?? input.status;
  const expectedRunOutcome: NativeRunOutcome = input.closeBeforeTerminal
    ? "cancelled"
    : input.status === "completed"
      ? expectedTerminalStatus === "completed" ? "success" : "failed"
    : input.status;
  const expectedLocalCommit = !input.terminalCommitError;
  const expectedCleanup = expectedLocalCommit;
  const nativeId = `editor-${input.backend}-${input.status}-native`;
  const order: string[] = [];
  const records: NativeExecutionRecord[] = [];
  const settlements: Array<{
    recordId: string;
    runOutcome: NativeRunOutcome;
    localCommit: LocalRunCommitResult;
  }> = [];
  const cleanedRecordIds: string[] = [];
  const durableLedger = new InMemoryRunLedger();
  const ledger = {
    async append(event: HarnessEvent): Promise<void> {
      await durableLedger.append(event);
      if (
        event.type === "run.completed"
        || event.type === "run.failed"
        || event.type === "run.cancelled"
      ) {
        order.push(`ledger:${event.type}`);
      }
    },
    async readRun(id: string): Promise<HarnessEvent[]> {
      return await durableLedger.readRun(id);
    }
  };
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider()
  });
  let harnessRunId = "";
  let kernelCalls = 0;
  let builderCalls = 0;
  const productTerminalCalls: Array<{
    runId: string;
    status: "completed" | "failed" | "cancelled";
  }> = [];
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  const runtime: AgentTaskRuntime = {
    kind: input.backend,
    async connect() {
      return { connected: true, label: input.backend, errors: [] };
    },
    async disconnect() {
      order.push("adapter:dispose");
    },
    async listModels() {
      return [];
    },
    async runTask(task) {
      order.push(`native:${nativeId}`);
      assert.equal(
        task.requireNativeRegistrationBeforePrompt,
        true,
        `${input.backend} product entry must require registration before Prompt`
      );
      assert.equal(
        typeof task.onRunId,
        "function",
        `${input.backend} product entry must pass the lifecycle registration callback`
      );
      await task.onRunId?.(
        nativeId,
        input.backend === "hermes"
          ? {
            kind: "session",
            persistence: "provider-persistent",
            transport: "acp-stdio"
          }
          : undefined
      );
      order.push(`prompt:${nativeId}`);
      markPromptStarted();
      if (input.status === "completed") {
        return {
          text: input.candidateText ?? "<codex-candidate>新句子</codex-candidate>",
          runId: nativeId
        };
      }
      if (input.status === "failed") {
        throw new Error(`${input.backend} editor failed`);
      }
      await new Promise<void>((_resolve, reject) => {
        const rejectCancelled = () => reject(new Error("Agent 任务已取消。"));
        if (task.abortSignal?.aborted) rejectCancelled();
        else task.abortSignal?.addEventListener("abort", rejectCancelled, { once: true });
      });
      throw new Error("cancelled runtime unexpectedly resumed");
    },
    async abort(id) {
      order.push(`adapter:cancel:${id}`);
    }
  };
  const nativeRefContext = {
    providerEndpoint: `http://${input.backend}.test`,
    deviceKey: "test-device",
    vaultId: "/vault"
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.capabilities.editorActionBackend = input.backend;
  let view: any;
  view = {
    plugin: {
      settings,
      getVaultPath: () => "/vault",
      getNativeExecutionRefContext: () => nativeRefContext,
      runHarnessWithAdapter: async (request: Parameters<EchoInkHarnessKernel["runWithAdapter"]>[0]) => {
        kernelCalls += 1;
        assert.equal(
          request.terminalAuthority,
          "surface",
          "Editor product entry must prevent the Kernel from committing before candidate validation"
        );
        harnessRunId = request.request.runId;
        order.push("kernel:run");
        const run = kernel.runWithAdapter(request);
        if (input.status === "cancelled") {
          await promptStarted;
          await kernel.cancelRun(harnessRunId);
        }
        const result = await run;
        if (input.closeBeforeTerminal) {
          order.push("candidate-returned");
          await CodexView.prototype.onClose.call(view);
        }
        return result;
      },
      cancelHarnessRun: async (runId: string) => {
        order.push(`view-close:cancel:${runId}`);
      },
      settleHarnessRunTerminal: async (terminal: {
        runId: string;
        status: "completed" | "failed" | "cancelled";
        backendId?: string;
        text?: string;
        error?: string;
      }) => {
        order.push(`product-terminal:${terminal.status}`);
        productTerminalCalls.push({
          runId: terminal.runId,
          status: terminal.status
        });
        if (input.terminalCommitError) throw input.terminalCommitError;
        return await kernel.settleRunTerminal(terminal);
      },
      recordNativeExecution: async (record: NativeExecutionRecord) => {
        order.push(`record:${record.native.id}`);
        records.push(structuredClone(record));
      },
      settleNativeExecution: async (settlement: {
        recordId: string;
        runOutcome: NativeRunOutcome;
        localCommit: LocalRunCommitResult;
      }) => {
        order.push(
          `native:settle:${settlement.runOutcome}:${String(settlement.localCommit.committed)}`
        );
        settlements.push(structuredClone(settlement));
        const record = records.find((item) => item.id === settlement.recordId);
        return record
          ? {
            ...record,
            runOutcome: settlement.runOutcome,
            localCommit: settlement.localCommit.committed ? "committed" as const : "failed" as const,
            cleanup: settlement.localCommit.committed ? "pending" as const : "not-needed" as const
          }
          : null;
      },
      saveSettings: async () => undefined
    },
    createEditorActionHarnessAdapter: (builderInput: CreateHarnessAgentAdapterInput) => {
      builderCalls += 1;
      assert.equal(builderInput.backendId, input.backend);
      assert.equal(
        builderInput.task?.requireNativeRegistrationBeforePrompt,
        true,
        "runEditorActionPromptTurn must configure the pre-Prompt barrier"
      );
      assert.equal(
        typeof builderInput.task?.onRunId,
        "function",
        "runEditorActionPromptTurn must own the EditorNativeLifecycle callback"
      );
      return new TaskRuntimeAgentAdapter({
        backendId: builderInput.backendId,
        displayName: input.backend,
        version: "test",
        runtime,
        nativeRefContext: builderInput.nativeRefContext,
        capabilities: "legacy",
        legacyTaskDefaults: builderInput.task
      });
    },
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    editorActionHarnessRunId: "",
    editorActionActiveTimeoutMs: 0,
    editorActionThreadId: "",
    editorActionCurrentItemIds: new Set<string>(),
    articleUnderstandingPanelState: { status: "idle" },
    promptEnhancerRunning: false,
    promptEnhancerRunId: "",
    promptEnhancerTurnId: "",
    cleanupNativeExecutionRecord: async (recordId: string) => {
      order.push(`native:cleanup:${recordId}`);
      cleanedRecordIds.push(recordId);
      if (input.cleanupFails) throw new Error("provider cleanup unavailable");
      return { recordId, cleanup: "disposed", attempted: true };
    },
    releaseEditorActionRunLock: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    clearActiveRun: () => {
      view.activeRunId = "";
      view.activeRunKind = "";
      view.activeRunSessionId = "";
      view.activeTurnId = "";
    },
    applyStatus: () => undefined,
    setEditorActionStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    effectiveEditorActionModel: (_available: string[], configured: string) => configured,
    withEditorActionTimeout: async <T>(promise: Promise<T>) => await promise,
    renderEditorActionStatus: () => undefined,
    activeProviderModels: () => [],
    activeRunSession: () => {
      throw new Error("Editor close must not resolve a Conversation session");
    },
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    flushSessionSave: async () => undefined,
    messageListRenderer: {
      dispose: () => undefined
    }
  };
  attachViewLifecycle(view);
  const expectedTerminal: "run.completed" | "run.failed" | "run.cancelled" =
    `run.${expectedTerminalStatus}`;
  const cleanupErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  if (input.cleanupFails) {
    console.error = (...args: unknown[]) => {
      cleanupErrors.push(args);
    };
  }
  let output: string | undefined;
  let runError: unknown;
  try {
    output = await runEditorActionPromptTurn(view, editorTurnInput());
  } catch (error) {
    runError = error;
  } finally {
    console.error = originalConsoleError;
  }

  const shouldResolve = input.status === "completed"
    && expectedTerminalStatus === "completed"
    && !input.terminalCommitError;
  if (shouldResolve) {
    assert.equal(output, "新句子");
    assert.equal(runError, undefined);
  } else {
    assert.ok(runError instanceof Error);
    assert.match(
      runError.message,
      input.expectedError
        ?? (
          input.status === "cancelled"
            ? /cancelled|canceled|已取消|已中断/i
            : new RegExp(`${input.backend} editor failed`)
        )
    );
  }
  assert.equal(builderCalls, 1);
  assert.equal(kernelCalls, 1);
  assert.equal(
    order.filter((item) => item === `prompt:${nativeId}`).length,
    1,
    `${input.backend} must submit exactly one Prompt`
  );
  assert.equal(
    order.filter((item) => item === "adapter:dispose").length,
    1,
    `${input.backend} adapter must be disposed exactly once by the product finally block`
  );
  assert.equal(
    order.filter((item) => item === `adapter:cancel:${nativeId}`).length,
    input.status === "cancelled" ? 1 : 0,
    `${input.backend} cancellation must target the exact Native execution`
  );
  assert.ok(harnessRunId);
  assert.deepEqual(productTerminalCalls, [{
    runId: harnessRunId,
    status: expectedTerminalStatus
  }]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.native.id, nativeId);
  assert.equal(records[0]?.policy.retainWhenLocalCommitFails, true);
  assert.equal(
    records[0]?.native.kind,
    "session"
  );
  assert.equal(records[0]?.native.persistence, "provider-persistent");
  assert.equal(
    records[0]?.native.transport,
    input.backend === "hermes" ? "acp-stdio" : undefined
  );
  assert.equal(
    records[0]?.native.providerEndpoint,
    nativeRefContext.providerEndpoint
  );
  assert.equal(records[0]?.native.deviceKey, nativeRefContext.deviceKey);
  assert.equal(records[0]?.native.vaultId, nativeRefContext.vaultId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0]?.runOutcome, expectedRunOutcome);
  assert.equal(settlements[0]?.localCommit.committed, expectedLocalCommit);
  if (!expectedLocalCommit) {
    assert.match(
      settlements[0]?.localCommit.error ?? "",
      input.expectedError ?? /Run Ledger/
    );
  }
  assert.deepEqual(
    cleanedRecordIds,
    expectedCleanup ? [records[0]?.id] : []
  );
  const durableTerminals = (await durableLedger.readRun(harnessRunId)).filter((event) =>
      event.type === "run.completed"
      || event.type === "run.failed"
      || event.type === "run.cancelled"
  );
  assert.deepEqual(
    durableTerminals.map((event) => event.type),
    expectedLocalCommit ? [expectedTerminal] : []
  );
  const expectedOrder = [
    `native:${nativeId}`,
    `record:${nativeId}`,
    `prompt:${nativeId}`,
    `product-terminal:${expectedTerminalStatus}`,
    ...(expectedLocalCommit ? [`ledger:${expectedTerminal}`] : []),
    "adapter:dispose",
    `native:settle:${expectedRunOutcome}:${String(expectedLocalCommit)}`,
    ...(expectedCleanup ? [`native:cleanup:${records[0]?.id}`] : [])
  ];
  assertOrder(order, expectedOrder);
  assert.equal(
    cleanupErrors.length,
    expectedCleanup && input.cleanupFails ? 1 : 0,
    "cleanup failure must be contained after the business terminal is durable"
  );
}

async function assertRegistrationFailureCannotLaunchFallback(): Promise<void> {
  let fallbackCalls = 0;
  const fallback: AgentTaskRuntime = {
    kind: "opencode",
    async connect() { return { connected: true, label: "OpenCode", errors: [] }; },
    async listModels() { return []; },
    async runTask() {
      fallbackCalls += 1;
      return { text: "unsafe fallback" };
    },
    async abort() { return undefined; }
  };
  const rich: AgentRichStreamRuntime = {
    ...fallback,
    async runTask(input) {
      await input.onRunId?.("opencode-registration-failed");
      return { text: "unreachable" };
    },
    async runTaskStream(input) {
      await input.onRunId?.("opencode-registration-failed");
      return { text: "unreachable" };
    }
  };
  const runtime = createAgentEventRuntimeWithFallback(fallback, rich);

  await assert.rejects(runtime.runTaskEvents({
    prompt: "rewrite",
    onRunId: async () => {
      throw new NativeRunRegistrationError("registration rejected");
    }
  }, () => undefined), /registration rejected/);

  assert.equal(fallbackCalls, 0);
}

async function assertNativePrewarmIsRemovedAndCandidateKeysDoNotCleanNativeState(): Promise<void> {
  const root = process.cwd();
  const [
    view,
    runState,
    editorRunner,
    lifecycle,
    controller,
    workspace,
    sessions,
    header,
    turnRunner,
    runnerContext,
    runtimeProfile
  ] = await Promise.all([
    readFile(path.join(root, "src/ui/codex-view.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/editor-action-run-state.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/editor-action-runner.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/turn-lifecycle.ts"), "utf8"),
    readFile(path.join(root, "src/editor-actions/controller.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/workspace-controller.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/session-controller.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/header-controller.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/turn-runner.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/runner-context.ts"), "utf8"),
    readFile(path.join(root, "src/harness/agents/backend-runtime-profile.ts"), "utf8")
  ]);
  const editorRuntimeSource = `${view}\n${runState}\n${editorRunner}\n${lifecycle}`;
  const ordinaryChatSource = [
    view,
    workspace,
    sessions,
    header,
    turnRunner,
    runnerContext,
    runtimeProfile
  ].join("\n");
  assert.doesNotMatch(editorRuntimeSource, /editorActionPrewarm|prewarmEditorActionThread/);
  assert.doesNotMatch(
    ordinaryChatSource,
    /prewarmActiveThread|threadPrewarmPromise|threadPrewarmSessionId|nativeThreadPrewarm|harnessBackendUsesNativeThreadPrewarm|startThreadForSession/
  );
  assert.doesNotMatch(
    `${view}\n${workspace}\n${sessions}\n${header}\n${turnRunner}`,
    /startCodexHarnessThread/,
    "ordinary Chat shell events must not create a Native thread outside a real Turn"
  );
  assert.doesNotMatch(controller, /recordNativeExecution|settleNativeExecution|cleanupNativeExecution/);
}

function createCodexEditorHarness(input: {
  order: string[];
  threadIds: string[];
  staleThreadId?: string;
  recordError?: Error;
}) {
  const records: NativeExecutionRecord[] = [];
  const settled: Array<{ recordId: string; runOutcome: string; localCommit: { committed: boolean } }> = [];
  const cleanedRecordIds: string[] = [];
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider()
  });
  let nextThread = 0;
  const notificationHub = new CodexRichNotificationHub();
  const plugin: any = {
    settings: structuredClone(DEFAULT_SETTINGS),
    getVaultPath: () => "/vault",
    getNativeExecutionRefContext: () => ({ deviceKey: "test-device", vaultId: "/vault" }),
    runHarnessWithAdapter: async (request: any) => await kernel.runWithAdapter(request),
    settleHarnessRunTerminal: async (terminal: any) => {
      input.order.push(`ledger:${terminal.status}`);
      return await kernel.settleRunTerminal(terminal);
    },
    recordNativeExecution: async (record: NativeExecutionRecord) => {
      input.order.push(`record:${record.native.id}`);
      if (input.recordError) throw input.recordError;
      records.push(structuredClone(record));
    },
    settleNativeExecution: async (settlement: any) => {
      input.order.push(`native:settle:${settlement.recordId}`);
      settled.push(settlement);
      const record = records.find((item) => item.id === settlement.recordId);
      return record ? { ...record, localCommit: "committed", cleanup: "pending" } : null;
    },
    createCodexRichAgentAdapter: (options: any) => {
      const adapter = new CodexRichAgentAdapter({
        ...options,
        notificationHub,
        resumeThread: async () => undefined,
        startTurn: async (threadId: string) => {
          input.order.push(`prompt:${threadId}`);
          if (threadId === input.staleThreadId) throw new Error("thread not found");
          queueMicrotask(() => {
            notificationHub.dispatch({
              method: "item/completed",
              params: {
                item: {
                  id: `item:${threadId}`,
                  threadId,
                  turnId: `turn:${threadId}`,
                  type: "agentMessage",
                  text: "<codex-candidate>新句子</codex-candidate>"
                }
              }
            } as any);
            notificationHub.dispatch({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: `turn:${threadId}`, threadId, status: "completed" }
              }
            } as any);
          });
          return `turn:${threadId}`;
        },
        interruptTurn: async () => undefined,
        archiveThread: async (threadId: string) => {
          input.order.push(`archive:${threadId}`);
        }
      });
      const dispose = adapter.dispose.bind(adapter);
      adapter.dispose = async () => {
        input.order.push("adapter:dispose");
        await dispose();
      };
      return adapter;
    }
  };
  plugin.settings.agentBackend = "codex-cli";

  const view: any = {
    plugin,
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    editorActionHarnessRunId: "",
    editorActionActiveTimeoutMs: 0,
    editorActionThreadId: "",
    editorActionCurrentItemIds: new Set<string>(),
    articleUnderstandingPanelState: { status: "idle" },
    takeEditorActionThread: async () => {
      const threadId = input.threadIds[nextThread++];
      assert.ok(threadId, "unexpected extra Codex thread creation");
      input.order.push(`thread:${threadId}`);
      return threadId;
    },
    cleanupNativeExecutionRecord: async (recordId: string) => {
      input.order.push(`native:cleanup:${recordId}`);
      cleanedRecordIds.push(recordId);
      return { recordId, cleanup: "disposed", attempted: true };
    },
    releaseEditorActionRunLock: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    applyStatus: () => undefined,
    setEditorActionStatus: () => undefined,
    armTurnWatchdog: () => undefined,
    effectiveEditorActionModel: (_available: string[], configured: string) => configured,
    withEditorActionTimeout: async (promise: Promise<string>) => await promise,
    renderEditorActionStatus: () => undefined,
    activeProviderModels: () => []
  };
  attachViewLifecycle(view);

  return { view, records, settled, cleanedRecordIds };
}

function editorTurnInput() {
  return {
    prompt: "请改写这一句",
    actionLabel: "改写",
    qualityMode: "fast" as const,
    modeLabel: "快速",
    model: "gpt-test",
    phase: "generating" as const,
    statusMessage: "正在生成",
    timeoutMs: 1_000,
    startedAt: 1
  };
}

function editorActionRequestFixture() {
  const action = structuredClone(DEFAULT_SETTINGS.editorActions.actions[0]!);
  const style = structuredClone(DEFAULT_SETTINGS.editorActions.styles[0]!);
  const modeConfig = structuredClone(
    DEFAULT_SETTINGS.editorActions.modeConfigs.fast
  );
  return {
    id: "editor-pre-start-close",
    action,
    style,
    source: {
      filePath: "notes/test.md",
      fileName: "test",
      text: "原句",
      mtime: 1,
      size: 2
    },
    snapshot: {
      filePath: "notes/test.md",
      fileName: "test",
      fromOffset: 0,
      toOffset: 2,
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 2 },
      selectedText: "原句",
      beforeContext: "",
      afterContext: ""
    },
    qualityMode: "fast" as const,
    modeConfig,
    prompt: "",
    createdAt: 1
  };
}

function editorAdapterRequest(runId: string, backendId: "opencode" | "hermes") {
  return {
    runId,
    sessionId: `editor-action:${backendId}`,
    workflow: "editor.rewrite" as const,
    input: { text: "rewrite", attachments: [] },
    permissions: { mode: "read-only" as const, writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: {
      corePolicy: [],
      workflowContract: [],
      vaultProfile: [],
      sessionContext: [],
      memoryContext: [],
      knowledgeEvidence: [],
      echoInkSkills: [],
      nativeResourceHints: [],
      turnInstruction: []
    },
    outputContract: { kind: "editor-candidate" as const }
  };
}

function assertOrder(actual: string[], expected: string[]): void {
  let cursor = -1;
  for (const item of expected) {
    const next = actual.indexOf(item, cursor + 1);
    assert.notEqual(next, -1, `missing ordered item ${item} in ${JSON.stringify(actual)}`);
    cursor = next;
  }
}

function emptyAsyncIterable(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      return;
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function attachViewLifecycle(view: Record<string, any>): void {
  view.viewLifecycleGeneration = 1;
  view.viewLifecycleAbortController = new AbortController();
  view.captureViewLifecycle = () => ({
    generation: view.viewLifecycleGeneration,
    signal: view.viewLifecycleAbortController.signal
  });
}

function createFakeAcpProcess(
  onRequest: (message: any, write: (message: unknown) => void) => void
): { process: AcpSubprocessLike } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let inputBuffer = "";
  const write = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on("data", (chunk) => {
    inputBuffer += chunk.toString();
    for (;;) {
      const index = inputBuffer.indexOf("\n");
      if (index < 0) break;
      const line = inputBuffer.slice(0, index).trim();
      inputBuffer = inputBuffer.slice(index + 1);
      if (!line) continue;
      onRequest(JSON.parse(line), write);
    }
  });
  return {
    process: {
      stdin,
      stdout,
      stderr,
      kill: () => {
        stdin.end();
        stdout.end();
        stderr.end();
        return true;
      },
      on: () => undefined
    }
  };
}
