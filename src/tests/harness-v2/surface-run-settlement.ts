import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_SETTINGS, type StoredSession } from "../../settings/settings";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../../harness/agents/adapters/codex-rich-notification-hub";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { emptyContextBundle } from "../../harness/contracts/context";
import { RuntimeTurnQueue } from "../../ui/turn-queue";
import { CodexView } from "../../ui/codex-view";
import { CodexNotificationRouter } from "../../ui/codex-view/notification-router";
import {
  afterTurnSettled,
  startChatTurn,
  startKnowledgeBaseTurn,
  startNextQueuedTurn,
  startQueuedTurnItem,
  startQueuedTurnItemSafely
} from "../../ui/codex-view/turn-runner";
import { armTurnWatchdog, persistAndSettleChatRun, stopTurn } from "../../ui/codex-view/turn-lifecycle";
import { recoverStaleHarnessRuns } from "../../core/message-state";
import { KnowledgeBaseAgentTaskService } from "../../knowledge-base/agent-task-service";

export async function runHarnessV2SurfaceRunSettlementTests(): Promise<void> {
  await assertChatTerminalPersistsHistoryBeforeLedger();
  await assertChatStopCommitsCancellationTerminal();
  await assertChatStopUsesActualBackend();
  await assertChatStopPropagatesCancelFailureAndAllowsRetry();
  await assertKnowledgeStopDelegatesToManager();
  await assertKnowledgeStopDoesNotPauseAfterCommitLock();
  await assertKnowledgeTurnSettlesNativeBeforePostRunSaveFailure();
  await assertKnowledgeCleanupFailureDoesNotFailCompletedTurn();
  await assertKnowledgeUnloadWaitsForActiveRunSettlement();
  await assertEditorStopUsesHarnessCancel();
  await assertEditorStopPropagatesCancelFailureAndAllowsRetry();
  await assertKnowledgeWatchdogUsesHarnessCancel();
  await assertCodexChatProcessEventsRenderThroughHarnessSink();
  await assertQueuedCodexChatSettlesViaAwaitResultAndAdvancesQueue();
  await assertLateRunScopedNotificationsDoNotPolluteNextRunView();
  await assertUsageNotificationsReachDriverWithoutConsumingViewRoute();
  await assertUsageAndCompactionOnlyUpdateMatchingSessionThread();
  await assertViewCloseCancelsActiveRunDuringReload();
  await assertViewCloseDisposesRendererWhenRecoveryFails();
  await assertReloadRecoveryCommitsLocalHistoryBeforeLedgerTerminal();
  await assertReloadRecoveryKeepsTerminalPendingWhenLocalCommitFails();
  await assertReloadRecoveryRetriesFailedLedgerTerminal();
  await assertReloadRecoveryBackfillsLegacyInterruptedRunOnce();
  await assertEachSurfaceHasOneTerminalOwner();
}

async function assertCodexChatProcessEventsRenderThroughHarnessSink(): Promise<void> {
  const session: StoredSession = {
    id: "session-chat-process",
    title: "Chat process",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-chat-process",
    turnId: "turn-chat-process",
    text: "最终答案",
    autoComplete: false
  }]);

  const outcome = await startChatTurn(harness.view, session, queuedTurn("chat-process", session.id, "请检查"), "composer");
  assert.equal(outcome, "running");

  harness.notificationHub.dispatch({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread-chat-process", turnId: "turn-chat-process", itemId: "reasoning-1", delta: "正在分析" }
  } as any);
  harness.notificationHub.dispatch({
    method: "item/started",
    params: {
      threadId: "thread-chat-process",
      turnId: "turn-chat-process",
      item: { id: "command-1", threadId: "thread-chat-process", turnId: "turn-chat-process", type: "commandExecution", command: "rg target" }
    }
  } as any);
  harness.notificationHub.dispatch({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-chat-process", turnId: "turn-chat-process", itemId: "command-1", delta: "match.ts:1" }
  } as any);

  await waitFor(() => session.messages.some((message) => message.itemType === "reasoning")
    && session.messages.some((message) => message.itemType === "commandExecution"));
  assert.equal(session.messages.find((message) => message.role === "assistant" && message.itemType === "assistant")?.status, "running");
  assert.match(session.messages.find((message) => message.itemType === "reasoning")?.text ?? "", /正在分析/);
  assert.match(session.messages.find((message) => message.itemType === "commandExecution")?.text ?? "", /match\.ts:1/);
  assert.ok(harness.renderedSnapshots.some((messages) => messages.some((message) => message.itemType === "reasoning")));

  harness.notificationHub.dispatch({
    method: "item/completed",
    params: { item: { id: "assistant-turn-chat-process", threadId: "thread-chat-process", turnId: "turn-chat-process", type: "agentMessage", text: "最终答案" } }
  } as any);
  harness.notificationHub.dispatch({
    method: "turn/completed",
    params: { threadId: "thread-chat-process", turn: { id: "turn-chat-process", threadId: "thread-chat-process", status: "completed" } }
  } as any);
  await waitFor(() => harness.view.running === false);
}

async function assertChatTerminalPersistsHistoryBeforeLedger(): Promise<void> {
  const calls: string[] = [];
  await persistAndSettleChatRun({
    saveSettings: async () => { calls.push("history"); },
    settleHarnessRunTerminal: async () => { calls.push("ledger"); }
  }, { runId: "run-chat-order", status: "completed", backendId: "codex-cli" });
  assert.deepEqual(calls, ["history", "ledger"]);
}

async function assertChatStopCommitsCancellationTerminal(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-chat-stop",
    title: "Chat",
    cwd: "/vault",
    threadId: "thread-chat-stop",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "run-chat-stop",
    activeTurnId: "turn-chat-stop",
    activeRunKind: "chat",
    editorActionActiveTimeoutMs: 1,
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        calls.push(`cancel:${runId}`);
      },
      saveSettings: async () => { calls.push("history"); },
      settleHarnessRunTerminal: async (input: any) => {
        calls.push("ledger");
        assert.deepEqual(input, {
          runId: "run-chat-stop",
          status: "cancelled",
          backendId: "codex-cli",
          error: "用户中断"
        });
      }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: () => undefined,
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: (_session: StoredSession, message: any) => session.messages.push({ id: "cancel-message", createdAt: 2, ...message }),
    clearActiveRun: () => { calls.push("clear"); view.activeRunId = ""; },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, ["cancel:run-chat-stop", "clear", "history", "ledger"]);
  assert.equal(session.messages.at(-1)?.runId, "run-chat-stop");
  assert.equal(session.messages.at(-1)?.status, "canceled");
  assert.equal(view.activeRunId, "");
}

async function assertChatStopUsesActualBackend(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-hermes-stop",
    title: "Hermes chat",
    cwd: "/vault",
    messages: [{ id: "hermes-user", role: "user", text: "继续", runId: "run-hermes-stop", backendId: "hermes", createdAt: 1 }],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "run-hermes-stop",
    activeTurnId: "",
    activeRunKind: "chat",
    editorActionActiveTimeoutMs: 1,
    running: true,
    plugin: {
      interruptCodexHarnessTurn: async () => { calls.push("wrong-interrupt"); },
      cancelHarnessRun: async (runId: string) => { calls.push(`cancel:${runId}`); },
      saveSettings: async () => { calls.push("history"); },
      settleHarnessRunTerminal: async (input: any) => {
        calls.push("ledger");
        assert.equal(input.backendId, "hermes");
      }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: () => undefined,
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: (_session: StoredSession, message: any) => session.messages.push({ id: "hermes-cancel", createdAt: 2, ...message }),
    clearActiveRun: () => { calls.push("clear"); view.activeRunId = ""; },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, ["cancel:run-hermes-stop", "clear", "history", "ledger"]);
}

async function assertEditorStopUsesHarnessCancel(): Promise<void> {
  const calls: string[] = [];
  const view: any = {
    activeRunId: "run-editor-stop",
    activeTurnId: "turn-editor-stop",
    activeRunKind: "chat",
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        calls.push(`cancel:${runId}`);
      }
    },
    editorActionCurrentItemIds: new Set(["item-1"]),
    isEditorActionRunActive: () => true,
    rejectEditorActionRun: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => {
      calls.push("clear");
      view.activeRunId = "";
    },
    setEditorActionStatus: (status: { status: string; message: string }) => {
      calls.push(`${status.status}:${status.message}`);
    },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, [
    "cancel:run-editor-stop",
    "clear",
    "canceled:已中断"
  ]);
  assert.equal(view.activeRunId, "");
  assert.equal(view.activeTurnId, "");
  assert.equal(view.running, false);
  assert.equal(view.editorActionCurrentItemIds.size, 0);
}

async function assertKnowledgeStopDelegatesToManager(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-knowledge-stop",
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "kb-run-knowledge-stop",
    activeTurnId: "turn-knowledge-stop",
    activeRunKind: "knowledge-base",
    running: true,
    plugin: {
      getKnowledgeBaseManager: () => ({
        cancelMaintenance: async () => {
          calls.push("cancel-knowledge");
          return { accepted: true, message: "已取消知识库任务" };
        }
      }),
      cancelHarnessRun: async () => { calls.push("cancel-outer-run"); },
      settleHarnessRunTerminal: async () => { calls.push("settle-outer-run"); },
      saveSettings: async () => { calls.push("history"); }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: (sessionId: string) => { calls.push(`pause:${sessionId}`); },
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: () => undefined,
    clearActiveRun: () => { calls.push("clear"); },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, ["cancel-knowledge", "pause:session-knowledge-stop"]);
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "kb-run-knowledge-stop");
}

async function assertKnowledgeStopDoesNotPauseAfterCommitLock(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-knowledge-commit-locked",
    title: "Knowledge commit locked",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "kb-run-commit-locked",
    activeTurnId: "turn-commit-locked",
    activeRunKind: "knowledge-base",
    running: true,
    plugin: {
      getKnowledgeBaseManager: () => ({
        cancelMaintenance: async () => {
          calls.push("cancel-rejected");
          return {
            accepted: false,
            message: "知识库维护已进入安全提交，不能取消。"
          };
        }
      })
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: (sessionId: string) => {
      calls.push(`pause:${sessionId}`);
    }
  };

  await stopTurn(view);

  assert.deepEqual(
    calls,
    ["cancel-rejected"],
    "commit-locked cancellation must not pause the knowledge queue"
  );
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "kb-run-commit-locked");
}

async function assertKnowledgeTurnSettlesNativeBeforePostRunSaveFailure(): Promise<void> {
  const calls: string[] = [];
  let saveCalls = 0;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "opencode";
  settings.knowledgeBase.backend = "opencode";
  settings.activeSessionId = "session-knowledge-local-fail";
  const session: StoredSession = {
    id: settings.activeSessionId,
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const manager = {
    handleUserMessage: async () => ({
      status: "success" as const,
      message: "知识任务完成",
      harnessResult: {
        runId: "knowledge-opencode-local-fail",
        status: "completed" as const,
        nativeExecution: {
          backendId: "opencode",
          id: "native-local-fail",
          kind: "session" as const,
          persistence: "provider-persistent" as const,
          deviceKey: "device",
          vaultId: "vault",
          createdAt: 1
        }
      }
    }),
    getLastNativeLifecycleSummary: () => ({
      localCommitStatus: "failed" as const,
      cleanupStatuses: ["retained-for-recovery" as const]
    })
  };
  const view: any = {
    plugin: {
      settings,
      getKnowledgeBaseManager: () => manager,
      externalizeMessageText: async (_message: unknown, _text: string) => { calls.push("externalize"); },
      saveSettings: async () => {
        saveCalls += 1;
        calls.push(`save:${saveCalls}`);
        if (saveCalls >= 2) throw new Error("conversation store failed");
      },
      settlePendingKnowledgeBaseNativeExecutions: async () => { calls.push("settle-native"); }
    },
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    messagesBottomFollowPaused: false,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    moveMessageToEnd: () => undefined,
    fillKnowledgeBaseCommand: () => undefined,
    refreshKnowledgeDashboard: async () => undefined
  };
  const item = { ...queuedTurn("knowledge-local-fail", session.id, "/check test"), kind: "knowledge-base" };

  await assert.rejects(startKnowledgeBaseTurn(view, session, item, "composer"), /conversation store failed/);

  assert.ok(calls.indexOf("settle-native") > calls.indexOf("externalize"));
  assert.ok(calls.indexOf("settle-native") < calls.indexOf("save:2"));
  assert.equal(session.messages.find((message) => message.role === "assistant")?.nativeLocalCommitStatus, "failed");
  assert.equal(session.messages.find((message) => message.role === "assistant")?.nativeCleanupStatus, "retained-for-recovery");
}

async function assertKnowledgeCleanupFailureDoesNotFailCompletedTurn(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "opencode";
  settings.knowledgeBase.backend = "opencode";
  settings.activeSessionId = "session-knowledge-cleanup-fail";
  const session: StoredSession = {
    id: settings.activeSessionId,
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const manager = {
    handleUserMessage: async () => ({
      status: "success" as const,
      message: "知识任务完成",
      harnessResult: {
        runId: "knowledge-opencode-cleanup-fail",
        status: "completed" as const,
        nativeExecution: {
          backendId: "opencode",
          id: "native-cleanup-fail",
          kind: "session" as const,
          persistence: "provider-persistent" as const,
          deviceKey: "device",
          vaultId: "vault",
          createdAt: 1
        }
      }
    }),
    getLastNativeLifecycleSummary: () => ({
      localCommitStatus: "committed" as const,
      cleanupStatuses: ["failed" as const]
    })
  };
  const view: any = {
    plugin: {
      settings,
      getKnowledgeBaseManager: () => manager,
      externalizeMessageText: async () => undefined,
      saveSettings: async () => undefined,
      settlePendingKnowledgeBaseNativeExecutions: async () => {
        throw new Error("native cleanup failed");
      }
    },
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    messagesBottomFollowPaused: false,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    moveMessageToEnd: () => undefined,
    fillKnowledgeBaseCommand: () => undefined,
    refreshKnowledgeDashboard: async () => undefined
  };
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const outcome = await startKnowledgeBaseTurn(
      view,
      session,
      { ...queuedTurn("knowledge-cleanup-fail", session.id, "/check test"), kind: "knowledge-base" },
      "composer"
    );
    const assistant = session.messages.find((message) => message.role === "assistant");
    assert.equal(outcome, "completed");
    assert.equal(assistant?.status, "completed");
    assert.equal(assistant?.text, "知识任务完成");
    assert.equal(assistant?.nativeLocalCommitStatus, "committed");
    assert.equal(assistant?.nativeCleanupStatus, "failed");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /native execution settle failed/);
  } finally {
    console.warn = originalWarn;
  }
}

async function assertKnowledgeUnloadWaitsForActiveRunSettlement(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  let resolveRun: ((value: { text: string }) => void) | null = null;
  let runtimeCleared = false;
  const service = new KnowledgeBaseAgentTaskService({
    settings,
    getVaultPath: () => "/vault",
    saveSettings: async () => undefined,
    settleHarnessRunTerminal: async () => undefined,
    cancelHarnessRun: async () => undefined
  } as any, { isCancelRequested: () => false });
  (service as any).runtimeController = {
    hasActiveRun: true,
    preflight: async () => undefined,
    run: async () => await new Promise<{ text: string }>((resolve) => { resolveRun = resolve; }),
    cancel: async () => {
      setTimeout(() => resolveRun?.({ text: "cancelled and settled" }), 15);
      return true;
    },
    clear: () => { runtimeCleared = true; }
  };

  const runPromise = service.runTask({
    backend: "opencode",
    prompt: "wait for unload",
    sources: [],
    permission: "read-only",
    codexWriteScope: "knowledge-lint",
    managedKind: "lint",
    workflowRunId: "workflow-unload-settlement",
    attemptId: "workflow-unload-settlement:attempt:1:opencode",
    attemptOrdinal: 1,
    vaultPathOverride: "/shadow-vault",
    writableRootsOverride: [],
    exactWriteFence: {
      attemptToken: "workflow-unload-settlement:attempt:1:opencode",
      leaseToken: "workflow-unload-settlement-lease",
      deniedLivePaths: ["/vault"],
      deniedControlPaths: ["/control"]
    }
  });
  await Promise.resolve();
  let unloadCompleted = false;
  const unloadPromise = service.unload().then(() => { unloadCompleted = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unloadCompleted, false, "plugin unload must wait for the active Knowledge run promise");
  await unloadPromise;
  await runPromise;
  assert.equal(runtimeCleared, true);
}

async function assertChatStopPropagatesCancelFailureAndAllowsRetry(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-chat-stop-retry",
    title: "Chat retry",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  let attempts = 0;
  const failure = new Error("cancel failed");
  const view: any = {
    activeRunId: "run-chat-stop-retry",
    activeTurnId: "turn-chat-stop-retry",
    activeRunKind: "chat",
    editorActionActiveTimeoutMs: 1,
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        attempts += 1;
        calls.push(`cancel:${attempts}:${runId}`);
        if (attempts === 1) throw failure;
      },
      saveSettings: async () => { calls.push("history"); },
      settleHarnessRunTerminal: async () => { calls.push("ledger"); }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: () => { calls.push("pause"); },
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => { calls.push("thinking"); },
    finishRunningProcessMessages: () => { calls.push("process"); },
    addMessageToSession: (_session: StoredSession, message: any) => session.messages.push({ id: `msg-${session.messages.length}`, createdAt: 2, ...message }),
    clearActiveRun: () => {
      calls.push("clear");
      view.activeRunId = "";
    },
    applyStatus: () => { calls.push("apply"); }
  };

  await assert.rejects(() => stopTurn(view), failure);
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "run-chat-stop-retry");
  assert.equal(view.activeTurnId, "turn-chat-stop-retry");
  assert.equal(session.messages.length, 0);
  assert.deepEqual(calls, ["cancel:1:run-chat-stop-retry"]);

  await stopTurn(view);

  assert.deepEqual(calls, [
    "cancel:1:run-chat-stop-retry",
    "cancel:2:run-chat-stop-retry",
    "pause",
    "thinking",
    "process",
    "clear",
    "history",
    "ledger",
    "apply"
  ]);
  assert.equal(view.running, false);
  assert.equal(view.activeRunId, "");
  assert.equal(session.messages.at(-1)?.status, "canceled");
}

async function assertEditorStopPropagatesCancelFailureAndAllowsRetry(): Promise<void> {
  const calls: string[] = [];
  let attempts = 0;
  const failure = new Error("editor cancel failed");
  const view: any = {
    activeRunId: "run-editor-stop-retry",
    activeTurnId: "turn-editor-stop-retry",
    activeRunKind: "chat",
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        attempts += 1;
        calls.push(`cancel:${attempts}:${runId}`);
        if (attempts === 1) throw failure;
      }
    },
    editorActionCurrentItemIds: new Set(["item-1"]),
    isEditorActionRunActive: () => true,
    rejectEditorActionRun: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => {
      calls.push("clear");
      view.activeRunId = "";
    },
    setEditorActionStatus: (status: { status: string; message: string }) => {
      calls.push(`${status.status}:${status.message}`);
    },
    applyStatus: () => { calls.push("apply"); }
  };

  await assert.rejects(() => stopTurn(view), failure);
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "run-editor-stop-retry");
  assert.equal(view.activeTurnId, "turn-editor-stop-retry");
  assert.equal(view.editorActionCurrentItemIds.size, 1);
  assert.deepEqual(calls, ["cancel:1:run-editor-stop-retry"]);

  await stopTurn(view);

  assert.deepEqual(calls, [
    "cancel:1:run-editor-stop-retry",
    "cancel:2:run-editor-stop-retry",
    "clear",
    "canceled:已中断",
    "apply"
  ]);
  assert.equal(view.running, false);
  assert.equal(view.activeRunId, "");
  assert.equal(view.activeTurnId, "");
  assert.equal(view.editorActionCurrentItemIds.size, 0);
}

async function assertKnowledgeWatchdogUsesHarnessCancel(): Promise<void> {
  const calls: string[] = [];
  let watchdog: (() => void) | undefined;
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    setTimeout: (callback: () => void) => {
      watchdog = callback;
      return 1;
    }
  };
  const session: StoredSession = {
    id: "session-knowledge-watchdog",
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    threadId: "thread-knowledge-watchdog",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "run-knowledge-watchdog",
    activeTurnId: "turn-knowledge-watchdog",
    activeRunKind: "knowledge-base",
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => { calls.push(`cancel:${runId}`); },
      interruptCodexHarnessTurn: async () => { calls.push("direct-interrupt"); },
      saveSettings: async () => { calls.push("history"); }
    },
    clearTurnWatchdog: () => undefined,
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    isKnowledgeBaseSession: () => true,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: () => undefined,
    clearActiveRun: () => { view.activeRunId = ""; },
    applyStatus: () => undefined
  };

  try {
    armTurnWatchdog(view, 1);
    assert.ok(watchdog);
    watchdog();
    assert.deepEqual(calls, ["cancel:run-knowledge-watchdog", "history"]);
  } finally {
    (globalThis as any).window = previousWindow;
  }
}

async function assertQueuedCodexChatSettlesViaAwaitResultAndAdvancesQueue(): Promise<void> {
  const firstMarkdown = "\n\n- **第一轮答案**\n- [保留链接](https://example.com)\n\n";
  const session: StoredSession = {
    id: "session-chat-await",
    title: "Chat await",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [
    { threadId: "thread-chat-await", turnId: "turn-chat-await-1", text: firstMarkdown },
    { threadId: "thread-chat-await", turnId: "turn-chat-await-2", text: "第二轮答案" }
  ]);

  harness.view.turnQueue.enqueue(queuedTurn("queued-chat-1", session.id, "第一问"));
  harness.view.turnQueue.enqueue(queuedTurn("queued-chat-2", session.id, "第二问"));

  await startNextQueuedTurn(harness.view, session.id);
  await waitFor(() => harness.startedTurns.length === 2 && harness.view.running === false, 500);

  assert.deepEqual(harness.startedTurns.map((item) => item.turnId), ["turn-chat-await-1", "turn-chat-await-2"]);
  assert.equal(harness.terminalCalls.length, 2);
  assert.equal(new Set(harness.terminalCalls.map((item) => item.runId)).size, 2);
  assert.equal(harness.harnessOutputs[0]?.backendBinding?.nativeThreadId, "thread-chat-await");
  assert.ok(harness.harnessOutputs[0]?.backendBinding?.leaseId);
  assert.equal(
    session.messages.filter((message) => message.role === "assistant" && message.itemType === "assistant" && message.status === "completed").length,
    2
  );
  assert.equal(
    session.messages.find((message) => message.role === "assistant" && message.runId === harness.terminalCalls[0]?.runId)?.text,
    firstMarkdown,
    "asynchronous settlement must preserve nonblank Markdown byte-for-byte"
  );
}

async function assertLateRunScopedNotificationsDoNotPolluteNextRunView(): Promise<void> {
  const session: StoredSession = {
    id: "session-active-b",
    title: "Chat B",
    cwd: "/vault",
    threadId: "thread-b",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const touched: string[] = [];
  const view: any = {
    activeRunId: "run-b",
    activeRunKind: "chat",
    activeRunSession: () => session,
    sessionForThread: () => null,
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => { touched.push("finish-thinking"); },
    finishRunningProcessMessages: () => { touched.push("finish-process"); },
    finishPlanMessage: () => { touched.push("finish-plan"); },
    addMessageToSession: () => { touched.push("error-message"); },
    clearActiveRun: () => { touched.push("clear-run"); },
    applyStatus: () => { touched.push("status"); },
    diagnoseCodexFailure: () => ({ title: "失败", text: "失败" }),
    afterTurnSettled: async () => { touched.push("queue"); }
  };
  const router = new CodexNotificationRouter(view);

  router.handle({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "item-a",
      delta: "stale"
    }
  });
  router.handle({
    method: "turn/completed",
    params: {
      threadId: "thread-a",
      turn: { id: "turn-a", threadId: "thread-a", status: "completed" }
    }
  });
  router.handle({
    method: "error",
    params: {
      threadId: "thread-a",
      message: "old run error"
    }
  });

  assert.deepEqual(touched, []);
  assert.equal(session.messages.length, 0);
}

async function assertUsageNotificationsReachDriverWithoutConsumingViewRoute(): Promise<void> {
  const hub = new CodexRichNotificationHub();
  const events: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub: hub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "hello", text_elements: [] }],
    startThread: async () => ({ threadId: "thread-usage-active", title: "Thread" }),
    resumeThread: async () => undefined,
    startTurn: async () => "turn-usage-active"
  });

  await adapter.run({
    runId: "run-usage-active",
    sessionId: "session-usage-active",
    input: { text: "hello", attachments: [] },
    permissions: { mode: "workspace-write", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: emptyContextBundle(),
    outputContract: { kind: "plain-text" }
  }, (event) => { events.push(event.type); });

  assert.equal(hub.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-usage-active",
      tokenUsage: { last: { inputTokens: 8, outputTokens: 3 }, total: { totalTokens: 11 } }
    }
  } as any), false);
  assert.equal(hub.dispatch({
    method: "thread/compacted",
    params: {
      threadId: "thread-usage-active",
      tokenUsage: { total: { totalTokens: 7 } }
    }
  } as any), false);
  assert.equal(hub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "thread-usage-active",
      turn: { id: "turn-usage-active", status: "completed" }
    }
  } as any), true);
  await adapter.awaitResult("run-usage-active");
  assert.deepEqual(
    events.filter((type) => type === "usage.updated" || type === "run.completed"),
    ["usage.updated", "run.completed"],
    "usage must reach the active driver while remaining available to the View router"
  );
}

async function assertUsageAndCompactionOnlyUpdateMatchingSessionThread(): Promise<void> {
  const sessionA: StoredSession = {
    id: "session-thread-a",
    title: "A",
    cwd: "/vault",
    threadId: "thread-a",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const sessionB: StoredSession = {
    id: "session-thread-b",
    title: "B",
    cwd: "/vault",
    threadId: "thread-b",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const usageUpdates: string[] = [];
  const compactions: string[] = [];
  const view: any = {
    activeRunSession: () => sessionB,
    activeRunKind: "chat",
    sessionForThread: (threadId: string) => {
      if (threadId === sessionA.threadId) return sessionA;
      if (threadId === sessionB.threadId) return sessionB;
      return null;
    },
    updateContextForSession: (session: StoredSession, usage: any) => {
      usageUpdates.push(`${session.id}:${usage?.total?.totalTokens ?? "<missing>"}`);
    },
    addContextCompactionMessage: (session: StoredSession) => {
      compactions.push(session.id);
    },
    plugin: { lastStatus: null }
  };
  const router = new CodexNotificationRouter(view);

  router.handle({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-a",
      tokenUsage: { total: { totalTokens: 23 } }
    }
  });
  router.handle({
    method: "thread/compacted",
    params: {
      threadId: "thread-b",
      tokenUsage: { total: { totalTokens: 17 } }
    }
  });
  router.handle({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "editor-thread",
      tokenUsage: { total: { totalTokens: 99 } }
    }
  });
  router.handle({
    method: "thread/compacted",
    params: {
      threadId: "prewarm-thread",
      tokenUsage: { total: { totalTokens: 101 } }
    }
  });

  assert.deepEqual(usageUpdates, ["session-thread-a:23", "session-thread-b:17"]);
  assert.deepEqual(compactions, ["session-thread-b"]);
}

async function assertViewCloseCancelsActiveRunDuringReload(): Promise<void> {
  const calls: string[] = [];
  const session = {
    id: "session-view-close",
    messages: [{ id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-view-close", createdAt: 1 }]
  };
  const view: any = {
    activeRunId: "run-view-close",
    activeRunKind: "chat",
    running: true,
    activeRunSession: () => session,
    clearTurnWatchdog: () => { calls.push("watchdog"); },
    clearEditorActionStatusTimers: () => { calls.push("editor-status-timers"); },
    clearEditorSummaryTimers: () => { calls.push("editor-summary-timers"); },
    clearKnowledgeBaseRunProgressTimer: () => { calls.push("kb-timer"); },
    knowledgeDashboardTooltipState: { panels: [], tooltips: [], closeTimers: new Set(), cleanups: [] },
    clearActiveRun: () => { calls.push("clear"); view.activeRunId = ""; },
    rejectEditorActionRun: () => undefined,
    rejectEditorSummaryRun: () => undefined,
    messageListRenderer: { dispose: () => { calls.push("message-list-dispose"); } },
    flushSessionSave: async () => { calls.push("save"); },
    plugin: {
      cancelHarnessRun: async (runId: string) => { calls.push(`cancel:${runId}`); },
      recoverInterruptedHarnessRuns: async (sessionId: string) => { calls.push(`recover:${sessionId}`); },
      saveSettings: async () => { calls.push("save"); }
    }
  };

  await CodexView.prototype.onClose.call(view);

  assert.ok(calls.includes("cancel:run-view-close"));
  assert.ok(calls.includes("recover:session-view-close"));
  assert.ok(calls.includes("save"));
  assert.ok(calls.includes("message-list-dispose"));
}

async function assertViewCloseDisposesRendererWhenRecoveryFails(): Promise<void> {
  let disposeCalls = 0;
  const session = {
    id: "session-view-close-failure",
    messages: [{ id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-view-close-failure", createdAt: 1 }]
  };
  const view: any = {
    activeRunId: "run-view-close-failure",
    activeRunKind: "chat",
    running: true,
    activeRunSession: () => session,
    clearTurnWatchdog: () => undefined,
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    knowledgeDashboardTooltipState: { panels: [], tooltips: [], closeTimers: new Set(), cleanups: [] },
    clearActiveRun: () => { view.activeRunId = ""; },
    messageListRenderer: { dispose: () => { disposeCalls += 1; } },
    flushSessionSave: async () => undefined,
    plugin: {
      cancelHarnessRun: async () => undefined,
      recoverInterruptedHarnessRuns: async () => { throw new Error("recovery failed"); }
    }
  };

  await assert.rejects(
    () => CodexView.prototype.onClose.call(view),
    /recovery failed/
  );
  assert.equal(disposeCalls, 1);
}

async function assertReloadRecoveryCommitsLocalHistoryBeforeLedgerTerminal(): Promise<void> {
  const calls: string[] = [];
  const messages: any[] = [
    { id: "user", role: "user", text: "start", runId: "run-reload", backendId: "hermes", createdAt: 1 },
    { id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-reload", backendId: "hermes", createdAt: 2 },
    { id: "thinking", role: "assistant", text: "", itemType: "thinking", status: "running", runId: "run-reload", createdAt: 3 }
  ];

  const result = await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => { calls.push("local"); },
    settleRunTerminal: async (terminal) => { calls.push(`terminal:${terminal.status}:${terminal.backendId}`); }
  });

  assert.deepEqual(calls, ["local", "terminal:cancelled:hermes", "local"]);
  assert.equal(result.settledMessageCount, 2);
  assert.deepEqual(result.settledRunIds, ["run-reload"]);
  assert.equal(messages.find((message) => message.id === "answer")?.status, "interrupted");
  assert.equal(messages.some((message) => message.runTerminalRecoveryPending), false);
}

async function assertReloadRecoveryKeepsTerminalPendingWhenLocalCommitFails(): Promise<void> {
  const messages: any[] = [
    { id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-local-fail", createdAt: 1 }
  ];
  let terminalCalls = 0;

  await assert.rejects(recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => { throw new Error("disk full"); },
    settleRunTerminal: async () => { terminalCalls += 1; }
  }), /disk full/);

  assert.equal(terminalCalls, 0, "ledger terminal must wait for durable local history");
  assert.equal(messages[0].status, "interrupted");
  assert.equal(messages[0].runTerminalRecoveryPending, "cancelled");
}

async function assertReloadRecoveryRetriesFailedLedgerTerminal(): Promise<void> {
  const messages: any[] = [
    { id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-ledger-retry", createdAt: 1 }
  ];
  let attempts = 0;
  const first = await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => undefined,
    settleRunTerminal: async () => { attempts += 1; throw new Error("ledger unavailable"); }
  });
  assert.deepEqual(first.failedRunIds, ["run-ledger-retry"]);
  assert.equal(messages[0].runTerminalRecoveryPending, "cancelled");

  const second = await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => undefined,
    settleRunTerminal: async () => { attempts += 1; }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(second.settledRunIds, ["run-ledger-retry"]);
  assert.equal(messages[0].runTerminalRecoveryPending, undefined);
}

async function assertReloadRecoveryBackfillsLegacyInterruptedRunOnce(): Promise<void> {
  const messages: any[] = [
    { id: "legacy", role: "assistant", text: "partial", status: "interrupted", runId: "run-legacy-interrupted", backendId: "codex-cli", createdAt: 1 }
  ];
  let terminals = 0;
  const recover = async () => await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => undefined,
    settleRunTerminal: async () => { terminals += 1; }
  });

  assert.deepEqual((await recover()).settledRunIds, ["run-legacy-interrupted"]);
  assert.equal(messages[0].runTerminalRecovered, true);
  assert.deepEqual((await recover()).settledRunIds, []);
  assert.equal(terminals, 1);
}

async function assertEachSurfaceHasOneTerminalOwner(): Promise<void> {
  const root = process.cwd();
  const [main, chatRunner, lifecycle, knowledge, knowledgeManager, editor] = await Promise.all([
    readFile(path.join(root, "src/main.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/turn-runner.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/turn-lifecycle.ts"), "utf8"),
    readFile(path.join(root, "src/knowledge-base/agent-task-service.ts"), "utf8"),
    readFile(path.join(root, "src/knowledge-base/manager.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/editor-action-runner.ts"), "utf8")
  ]);

  assert.match(main, /settleHarnessRunTerminal\(input: SettleRunTerminalInput/);
  assert.match(chatRunner, /persistAndSettleChatRun\(view\.plugin/);
  assert.match(chatRunner, /settleHarnessRunTerminal\(\{[\s\S]*status: "failed"/);
  assert.match(lifecycle, /status: "cancelled"/);
  assert.match(lifecycle, /status: "failed"/);
  assert.doesNotMatch(methodBody(lifecycle, "export async function stopTurn(", "export function armTurnWatchdog("), /interruptCodexHarnessTurn|backendId === "codex-cli"/);
  assert.match(methodBody(lifecycle, "export async function stopTurn(", "export function armTurnWatchdog("), /cancelHarnessRun\(runId\)/);
  assert.match(knowledge, /settleKnowledgeHarnessRun\(\{[\s\S]*status: "completed"/);
  assert.doesNotMatch(`${knowledge}\n${knowledgeManager}`, /CodexKbWaiter|codexWaiter|finishCodexWaiter|markCodexWaiterActivity/);
  assert.match(editor, /awaitResult\(/);
  assert.doesNotMatch(editor, /waitForResult|resolveEditorActionHarnessOutput|editorSummaryRun/);
}

function methodBody(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Expected method range ${start} -> ${end}`);
  return source.slice(startIndex, endIndex);
}

function queuedTurn(id: string, sessionId: string, text: string): any {
  return {
    id,
    sessionId,
    text,
    attachments: [],
    skill: null,
    turnOptions: {
      model: "gpt-test",
      permission: "workspace-write",
      serviceTier: "auto",
      reasoningEffort: "medium",
      mcpEnabled: true,
      codexResourceOverrides: { plugins: {}, mcpServers: {}, skills: {} }
    },
    kind: "chat",
    createdAt: Date.now()
  };
}

function createChatSurfaceHarness(
  session: StoredSession,
  plannedTurns: Array<{ threadId: string; turnId: string; text: string; autoComplete?: boolean }>
): {
  view: any;
  terminalCalls: Array<{ runId: string; status: string }>;
  startedTurns: Array<{ threadId: string; turnId: string }>;
  notificationHub: CodexRichNotificationHub;
  renderedSnapshots: StoredSession["messages"][];
  harnessOutputs: any[];
} {
  const notificationHub = new CodexRichNotificationHub();
  const kernel = new EchoInkHarnessKernel({
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: () => session
  });
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "codex-cli";
  settings.capabilities.chatBackend = "default";
  const terminalCalls: Array<{ runId: string; status: string }> = [];
  const startedTurns: Array<{ threadId: string; turnId: string }> = [];
  const renderedSnapshots: StoredSession["messages"][] = [];
  const harnessOutputs: any[] = [];
  const view: any = {
    plugin: {
      settings,
      getVaultPath: () => "/vault",
      ensureHarnessBackendConnected: async () => null,
      runHarnessWithAdapter: async (input: any) => {
        const output = await kernel.runWithAdapter(input);
        harnessOutputs.push(output);
        return output;
      },
      settleHarnessRunTerminal: async (input: any) => {
        terminalCalls.push({ runId: input.runId, status: input.status });
        await kernel.settleRunTerminal(input);
      },
      createCodexRichAgentAdapter: (options: any) => new CodexRichAgentAdapter({
        ...options,
        notificationHub,
        startThread: async () => ({ threadId: plannedTurns[0]?.threadId ?? "thread-chat-await", title: "Thread" }),
        resumeThread: async () => undefined,
        startTurn: async (threadId: string) => {
          const plan = plannedTurns[startedTurns.length];
          assert.ok(plan, "missing planned Codex turn");
          startedTurns.push({ threadId, turnId: plan.turnId });
          if (plan.autoComplete === false) return plan.turnId;
          setTimeout(() => {
            notificationHub.dispatch({
              method: "item/completed",
              params: {
                item: {
                  id: `assistant-${plan.turnId}`,
                  threadId,
                  turnId: plan.turnId,
                  type: "agentMessage",
                  text: plan.text
                }
              }
            } as any);
            notificationHub.dispatch({
              method: "turn/completed",
              params: {
                threadId,
                turn: {
                  id: plan.turnId,
                  threadId,
                  status: "completed"
                }
              }
            } as any);
          }, 0);
          return plan.turnId;
        },
        interruptTurn: async () => undefined
      }),
      externalizeMessageText: async () => undefined,
      saveSettings: async () => undefined,
      getKnowledgeBaseManager: () => null,
      listEchoInkMcpTools: async () => []
    },
    turnQueue: new RuntimeTurnQueue(),
    queueStartInProgress: false,
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    threadPrewarmPromise: null,
    threadPrewarmSessionId: "",
    messagesBottomFollowPaused: false,
    sessionById: (sessionId: string) => sessionId === session.id ? session : null,
    clearComposerDraft: () => undefined,
    renderQueue: () => undefined,
    renderToolbar: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => { renderedSnapshots.push(structuredClone(session.messages)); },
    renderMessages: () => undefined,
    applyStatus: () => undefined,
    ensureThinkingMessage: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: (_session: StoredSession, message: any) => {
      session.messages.push({ id: `message-${session.messages.length}`, createdAt: Date.now(), ...message });
    },
    clearActiveRun: () => {
      view.activeRunId = "";
      view.activeRunKind = "";
      view.activeRunSessionId = "";
    },
    attachTurnIdToRun: () => undefined,
    isKnowledgeBaseSession: () => false,
    diagnoseCodexFailure: () => ({ title: "失败", text: "失败" }),
    activeRunSession: () => session
  };
  view.startQueuedTurnItem = (item: any, source: "composer" | "queue") => startQueuedTurnItem(view, item, source);
  view.startQueuedTurnItemSafely = (item: any, source: "composer" | "queue") => startQueuedTurnItemSafely(view, item, source);
  view.startChatTurn = (target: StoredSession, item: any, source: "composer" | "queue") => startChatTurn(view, target, item, source);
  view.startNextQueuedTurn = (sessionId: string) => startNextQueuedTurn(view, sessionId);
  view.afterTurnSettled = (sessionId: string, succeeded: boolean) => afterTurnSettled(view, sessionId, succeeded);
  return { view, terminalCalls, startedTurns, notificationHub, renderedSnapshots, harnessOutputs };
}

async function waitFor(predicate: () => boolean, timeoutMs = 120): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out after ${timeoutMs}ms`);
}
