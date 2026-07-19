import * as assert from "node:assert/strict";
import {
  createQueuedTurnFromComposer,
  runKnowledgeBaseShortcut,
  startKnowledgeBaseTurn
} from "../../ui/codex-view/turn-runner";
import type { HarnessRunResult } from "../../harness/contracts/run";
import { ConversationMutationLane } from "../../harness/conversation/conversation-mutation-lane";
import type { TurnOptions } from "../../core/codex-service";
import { handleKnowledgeBaseUserMessage, type KnowledgeBaseChatResult } from "../../knowledge-base/command-router";
import { buildKnowledgeBaseMaintainReportPayload } from "../../knowledge-base/maintain-report-card";
import type { ChatMessage, StoredSession } from "../../settings/settings";
import type { QueuedTurnItem } from "../../ui/turn-queue";

export async function runHarnessV2KnowledgeTurnTests(): Promise<void> {
  await assertKnowledgeAskStoresHarnessBackendBinding();
  await assertKnowledgeAskKeepsConfiguredBackendProvenance();
  await assertMaintenanceRouterExposesLastActualAttemptBackend();
  await assertMaintenanceUsesSelectedThenActualAttemptBackend();
  await assertMaintenanceRecoveryUsesRecoveryProjectionStates();
  await assertMaintenanceWorkflowEventsReachCompactCards();
  await assertMaintenanceUnexpectedFailureKeepsReportCard();
  await assertMaintenanceWithoutWinnerClearsRunProvenance();
  await assertQueuedMaintenanceRefreshesBackendSpecificTurnOptionsAtStart();
  await assertRecoveryAllowsOnlyReadOnlyLocalCommands();
  await assertKnowledgeShortcutKeepsMutationLaneUntilSettlement();
}

async function assertKnowledgeAskStoresHarnessBackendBinding(): Promise<void> {
  const session = baseSession();
  const result: HarnessRunResult = {
    runId: "run-knowledge-ask",
    status: "completed",
    outputText: "回答",
    nativeExecution: {
      backendId: "codex-cli",
      id: "codex-native-thread-1",
      kind: "thread",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1000
    },
    backendBinding: {
      backendId: "codex-cli",
      nativeThreadId: "codex-native-thread-1",
      nativeExecutionKind: "thread",
      leaseId: "lease-kb-codex",
      leaseStatus: "active",
      leaseTurnCount: 1,
      contextMode: "bootstrap",
      syncedThroughMessageId: "msg-user-1",
      syncedSessionRevision: 1,
      contextCursor: {
        syncedThroughMessageId: "msg-user-1",
        syncedSessionRevision: 1
      },
      lastUsedAt: 2000,
      expiresAt: 62000
    },
    contextManifest: {
      mode: "bootstrap",
      cursor: {
        syncedThroughMessageId: "msg-user-1",
        syncedSessionRevision: 1
      },
      sections: [],
      messageCount: 1,
      tokenEstimate: 10,
      compiledAt: 1000
    }
  };
  const savedSnapshots: StoredSession[] = [];
  const view = fakeKnowledgeView(session, result, savedSnapshots);

  const status = await startKnowledgeBaseTurn(view, session, queuedKnowledgeAsk(), "composer");

  assert.equal(status, "completed");
  assert.equal(session.backendBindings?.["codex-cli"]?.nativeThreadId, "codex-native-thread-1");
  assert.equal(session.backendBindings?.["codex-cli"]?.leaseId, "lease-kb-codex");
  assert.ok(
    savedSnapshots.some((snapshot) => snapshot.backendBindings?.["codex-cli"]?.leaseId === "lease-kb-codex"),
    "knowledge turn should persist backend binding before later /ask turns"
  );
}

async function assertKnowledgeShortcutKeepsMutationLaneUntilSettlement(): Promise<void> {
  const lane = new ConversationMutationLane();
  const commitEntered = deferred<void>();
  const releaseCommit = deferred<void>();
  const session: StoredSession = {
    id: "kb-shortcut-settlement-lane",
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    plugin: {
      withEchoInkConversationMutation: async <T>(
        conversationId: string,
        action: () => Promise<T>
      ): Promise<T> => await lane.withConversationMutation(conversationId, action),
      activateKnowledgeBaseChannel: async () => undefined,
      getKnowledgeBaseManager: () => null,
      externalizeMessageText: async () => {
        commitEntered.resolve();
        await releaseCommit.promise;
      },
      settlePendingKnowledgeBaseNativeExecutions: async () => undefined,
      saveSettings: async () => undefined
    },
    running: false,
    ensureSession: () => session,
    isKnowledgeBaseSession: () => true,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    refreshKnowledgeDashboard: async () => undefined
  };

  const shortcut = runKnowledgeBaseShortcut(
    view,
    "刷新索引",
    async () => "刷新完成"
  );
  await commitEntered.promise;
  assert.equal(
    view.running,
    true,
    "Knowledge shortcut must stay running until terminal persistence settles"
  );

  let laterMutationEntered = false;
  const laterMutation = lane.withConversationMutation(session.id, async () => {
    laterMutationEntered = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(
    laterMutationEntered,
    false,
    "later Conversation mutations must wait behind Knowledge shortcut settlement"
  );

  releaseCommit.resolve();
  await shortcut;
  await laterMutation;
  assert.equal(laterMutationEntered, true);
  assert.equal(view.running, false);
  assert.equal(session.messages.at(-1)?.status, "completed");
  assert.equal(session.messages.at(-1)?.text, "刷新完成");
}

async function assertKnowledgeAskKeepsConfiguredBackendProvenance(): Promise<void> {
  const session = baseSession();
  const result: KnowledgeBaseChatResult = {
    status: "success",
    message: "回答"
  };
  const view = fakeKnowledgeView(session, result, [], {
    agentBackend: "hermes",
    knowledgeBackend: "opencode"
  });

  const status = await startKnowledgeBaseTurn(view, session, queuedKnowledgeAsk(), "composer");

  assert.equal(status, "completed");
  assert.deepEqual(
    session.messages.map((message) => message.backendId),
    ["opencode", "opencode"],
    "/ask must keep using the independently configured knowledge backend"
  );
}

async function assertMaintenanceUsesSelectedThenActualAttemptBackend(): Promise<void> {
  const session = baseSession();
  const renderedBackends: Array<Array<string | undefined>> = [];
  const result: KnowledgeBaseChatResult = {
    status: "success",
    message: "维护完成",
    maintenanceBackend: "hermes",
    maintenanceSelectedBackend: "opencode",
    maintenanceWinnerBackend: "hermes",
    workflowRunId: "workflow-selected-then-winner"
  };
  let view: ReturnType<typeof fakeKnowledgeView>;
  view = fakeKnowledgeView(session, result, [], {
    agentBackend: "opencode",
    knowledgeBackend: "codex-cli",
    onRender: () => {
      renderedBackends.push(session.messages.map((message) => message.backendId));
    },
    onHandleUserMessage: () => {
      session.messages.push({
        id: "process-selected-then-winner",
        role: "tool",
        itemType: "commandExecution",
        processKind: "command",
        title: "maintenance",
        text: "",
        status: "running",
        backendId: "opencode",
        modelId: "opencode/stale-model",
        profileId: "opencode:stale-profile",
        runId: view.activeRunId,
        createdAt: 2
      });
    }
  });
  const item: QueuedTurnItem = {
    ...queuedKnowledgeAsk(),
    id: "turn-kb-maintain",
    text: "/maintain 更新知识库"
  };

  const status = await startKnowledgeBaseTurn(view, session, item, "composer");

  assert.equal(status, "completed");
  assert.deepEqual(
    renderedBackends[0],
    ["opencode", "opencode"],
    "/maintain must initially show the Agent selected when the run starts"
  );
  assert.deepEqual(
    session.messages.map((message) => message.backendId),
    ["hermes", "hermes", "hermes"],
    "explicit winner provenance must cover the outer messages and same-run process rows"
  );
}

async function assertMaintenanceRouterExposesLastActualAttemptBackend(): Promise<void> {
  const result = await handleKnowledgeBaseUserMessage({
    runMaintenance: async () => ({
      status: "success",
      reportPath: "outputs/kb-maintenance/report.md",
      summary: "维护完成",
      processedSources: [],
      attempts: [
        {
          attemptId: "attempt-1",
          ordinal: 1,
          backend: "opencode",
          terminal: { status: "failed", at: 10 }
        },
        {
          attemptId: "attempt-2",
          ordinal: 2,
          backend: "hermes",
          terminal: { status: "completed", at: 20 }
        }
      ]
    })
  } as any, "/maintain 更新知识库");

  assert.equal(result.maintenanceBackend, "hermes");
}

async function assertMaintenanceRecoveryUsesRecoveryProjectionStates(): Promise<void> {
  for (const recoveryState of ["pending", "blocked"] as const) {
    const session = baseSession();
    const thinkingSettlements: string[] = [];
    const processSettlements: string[] = [];
    const result: KnowledgeBaseChatResult = {
      status: "failed",
      message: recoveryState === "pending" ? "正在安全恢复" : "安全恢复受阻",
      maintenanceRecoveryState: recoveryState,
      workflowRunId: `workflow-recovery-${recoveryState}`,
      maintenanceSelectedBackend: "codex-cli",
      maintenanceWinnerBackend: "codex-cli",
      maintenanceBackend: "codex-cli"
    };
    const view = fakeKnowledgeView(session, result, [], {
      onFinishThinking: (status) => thinkingSettlements.push(status),
      onFinishProcesses: (status) => processSettlements.push(status)
    });
    const item: QueuedTurnItem = {
      ...queuedKnowledgeAsk(),
      id: `turn-kb-recovery-${recoveryState}`,
      text: "/maintain"
    };

    await startKnowledgeBaseTurn(view, session, item, "composer");

    const assistant = session.messages.find((message) => message.itemType === "knowledgeBase");
    assert.equal(assistant?.status, `recovery-${recoveryState}`);
    assert.equal(
      assistant?.knowledgeBaseUi?.kind,
      "maintain-run",
      "maintenance recovery must keep the compact run card instead of falling back to raw text"
    );
    assert.deepEqual(thinkingSettlements, [`recovery-${recoveryState}`]);
    assert.deepEqual(processSettlements, [`recovery-${recoveryState}`]);
    if (recoveryState === "pending") {
      assert.equal(
        session.messages.some((message) => message.status === "failed" || message.status === "error"),
        false,
        "a WAL-persisted workflow awaiting recovery must not project a red business failure"
      );
    }
  }
}

async function assertMaintenanceWorkflowEventsReachCompactCards(): Promise<void> {
  const session = baseSession();
  const liveEventCounts: number[] = [];
  const result: KnowledgeBaseChatResult = {
    status: "success",
    message: "不应作为主视图展示的原始维护摘要",
    ui: buildKnowledgeBaseMaintainReportPayload("maintain", {
      status: "success",
      completion: "noop",
      reportPath: "outputs/maintenance/kb-maintenance-card.md",
      summary: "无需维护",
      processedSources: []
    })
  };
  const view = fakeKnowledgeView(session, result, [], {
    onHandleUserMessage: (_text, _attachments, options) => {
      const onWorkflowEvent = (options as {
        onWorkflowEvent?: (event: {
          type: "workflow.phase.started";
          phaseId: "prepare";
          status: "running";
          message: string;
          createdAt: number;
        }) => void;
      }).onWorkflowEvent;
      onWorkflowEvent?.({
        type: "workflow.phase.started",
        phaseId: "prepare",
        status: "running",
        message: "读取增量清单",
        createdAt: 2
      });
    },
    onRender: () => {
      const assistant = session.messages.find((message) => message.itemType === "knowledgeBase");
      if (assistant?.knowledgeBaseUi?.kind === "maintain-run") {
        liveEventCounts.push(assistant.knowledgeBaseUi.events?.length ?? 0);
      }
    }
  });
  const item: QueuedTurnItem = {
    ...queuedKnowledgeAsk(),
    id: "turn-kb-maintain-events",
    text: "/maintain"
  };

  await startKnowledgeBaseTurn(view, session, item, "composer");

  assert.ok(liveEventCounts.some((count) => count >= 2), "workflow events must update the live compact card");
  const assistant = session.messages.find((message) => message.itemType === "knowledgeBase");
  assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-report");
  assert.equal(assistant?.text, "不应作为主视图展示的原始维护摘要");
}

async function assertMaintenanceUnexpectedFailureKeepsReportCard(): Promise<void> {
  const session = baseSession();
  const view = fakeKnowledgeView(session, {
    status: "success",
    message: "unused"
  }, [], {
    handleError: new Error("unexpected maintenance failure")
  });
  const item: QueuedTurnItem = {
    ...queuedKnowledgeAsk(),
    id: "turn-kb-maintain-unexpected-failure",
    text: "/maintain"
  };

  await assert.rejects(
    startKnowledgeBaseTurn(view, session, item, "composer"),
    /unexpected maintenance failure/
  );

  const assistant = session.messages.find((message) => message.itemType === "knowledgeBase");
  assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-report");
  if (assistant?.knowledgeBaseUi?.kind === "maintain-report") {
    assert.equal(assistant.knowledgeBaseUi.status, "failed");
    assert.match(assistant.knowledgeBaseUi.careItems[0]?.text ?? "", /unexpected maintenance failure/);
  }
}

async function assertMaintenanceWithoutWinnerClearsRunProvenance(): Promise<void> {
  const cases = [
    {
      name: "noop",
      runResult: {
        status: "success" as const,
        completion: "noop" as const,
        reportPath: "",
        summary: "无需维护",
        processedSources: [],
        workflowRunId: "workflow-noop-no-winner",
        selectedBackend: "hermes" as const,
        winnerBackend: null,
        attempts: [],
        terminalPhase: "finalized" as const,
        commitState: "committed" as const,
        failureCode: null
      }
    },
    {
      name: "pre-wal",
      runResult: {
        status: "failed" as const,
        reportPath: "",
        summary: "预检失败",
        error: "没有启动任何 Agent",
        processedSources: [],
        workflowRunId: "workflow-pre-wal-no-winner",
        selectedBackend: "opencode" as const,
        winnerBackend: null,
        attempts: [],
        terminalPhase: "preflight" as const,
        commitState: "pre-wal" as const,
        failureCode: "maintenance_no_ready_backend"
      }
    }
  ];

  for (const testCase of cases) {
    const result = await handleKnowledgeBaseUserMessage({
      runMaintenance: async () => testCase.runResult,
      formatFailureContext: () => "",
      lastReportPath: () => ""
    } as any, "/maintain");
    assert.equal(result.maintenanceWinnerBackend, null);
    assert.equal(result.maintenanceSelectedBackend, testCase.runResult.selectedBackend);
    assert.equal(result.ui?.kind, "maintain-report");
    if (result.ui?.kind === "maintain-report") {
      assert.equal(result.ui.selectedBackend, testCase.runResult.selectedBackend);
      assert.equal(result.ui.winnerBackend, null);
    }

    const session = baseSession();
    let view: ReturnType<typeof fakeKnowledgeView>;
    view = fakeKnowledgeView(session, result, [], {
      agentBackend: testCase.runResult.selectedBackend,
      onHandleUserMessage: () => {
        session.messages.push({
          id: `process-${testCase.name}`,
          role: "tool",
          itemType: "commandExecution",
          processKind: "command",
          title: "maintenance preflight",
          text: "",
          status: "running",
          backendId: testCase.runResult.selectedBackend,
          modelId: `${testCase.runResult.selectedBackend}/stale-model`,
          profileId: `${testCase.runResult.selectedBackend}:stale-profile`,
          runId: view.activeRunId,
          createdAt: 2
        });
      }
    });
    const item: QueuedTurnItem = {
      ...queuedKnowledgeAsk(),
      id: `turn-kb-${testCase.name}-no-winner`,
      text: "/maintain"
    };

    await startKnowledgeBaseTurn(view, session, item, "composer");

    const sameRunMessages = session.messages.filter((message) =>
      message.runId === testCase.runResult.workflowRunId
      || message.id === `process-${testCase.name}`
    );
    assert.ok(sameRunMessages.length >= 3);
    for (const message of sameRunMessages) {
      assert.equal(message.backendId, undefined, `${testCase.name} must not retain a stale Agent`);
      assert.equal(message.modelId, undefined, `${testCase.name} must not retain a stale model`);
      assert.equal(message.profileId, undefined, `${testCase.name} must not retain a stale profile`);
    }
    const assistant = session.messages.find((message) => message.itemType === "knowledgeBase");
    assert.equal(assistant?.knowledgeBaseUi?.kind, "maintain-report");
    if (assistant?.knowledgeBaseUi?.kind === "maintain-report") {
      assert.equal(assistant.knowledgeBaseUi.selectedBackend, testCase.runResult.selectedBackend);
      assert.equal(assistant.knowledgeBaseUi.winnerBackend, null);
    }
  }
}

async function assertQueuedMaintenanceRefreshesBackendSpecificTurnOptionsAtStart(): Promise<void> {
  const session = baseSession();
  let receivedOptions: Record<string, unknown> | undefined;
  const result: KnowledgeBaseChatResult = {
    status: "success",
    message: "维护完成",
    maintenanceBackend: "codex-cli"
  };
  const view = fakeKnowledgeView(session, result, [], {
    agentBackend: "codex-cli",
    currentTurnOptions: {
      model: "codex/current-model",
      reasoning: "high"
    },
    onHandleUserMessage: (_text, _attachments, options) => {
      receivedOptions = options as Record<string, unknown>;
    }
  });
  const item: QueuedTurnItem = {
    ...queuedKnowledgeAsk(),
    id: "turn-kb-maintain-queued-switch",
    text: "/maintain queued after backend switch",
    turnOptions: {
      model: "opencode/stale-model",
      reasoning: "low"
    }
  };

  const status = await startKnowledgeBaseTurn(view, session, item, "queue");

  assert.equal(status, "completed");
  assert.equal(receivedOptions?.model, "codex/current-model");
  assert.equal(receivedOptions?.reasoning, "high");
  assert.equal(
    receivedOptions?.workflowRunId,
    session.messages[0]?.runId,
    "maintenance must reuse the existing kb-run id as its workflow id"
  );
  assert.notEqual(receivedOptions?.model, item.turnOptions.model);
}

async function assertRecoveryAllowsOnlyReadOnlyLocalCommands(): Promise<void> {
  const pendingHelp = recoveryComposerFixture("/help", "pending");
  const helpItem = await createQueuedTurnFromComposer(pendingHelp.view as never, {
    allowLocalKnowledgeCommands: true
  });
  assert.equal(helpItem, null);
  assert.equal(pendingHelp.clearCalls(), 1);
  assert.equal(pendingHelp.historyCalls(), 0);
  assert.equal(pendingHelp.saveCalls(), 1);
  assert.equal(pendingHelp.session.messages.length, 2);
  assert.equal(pendingHelp.session.messages[1]?.status, "completed");
  assert.equal(
    pendingHelp.session.messages[0]?.runId,
    pendingHelp.session.messages[1]?.runId,
    "local help should retain one stable local run id"
  );
  assert.match(pendingHelp.session.messages[1]?.text ?? "", /知识库管理频道快捷命令/);

  const blockedHistory = recoveryComposerFixture("/history", "blocked");
  const historyItem = await createQueuedTurnFromComposer(blockedHistory.view as never, {
    allowLocalKnowledgeCommands: true
  });
  assert.equal(historyItem, null);
  assert.equal(blockedHistory.historyCalls(), 1);
  assert.equal(blockedHistory.clearCalls(), 1);
  assert.equal(blockedHistory.session.messages.length, 0);

  const blockedMaintenance = recoveryComposerFixture("/maintain", "blocked");
  const maintenanceItem = await createQueuedTurnFromComposer(blockedMaintenance.view as never, {
    allowLocalKnowledgeCommands: true
  });
  assert.equal(maintenanceItem, null);
  assert.equal(blockedMaintenance.clearCalls(), 0);
  assert.equal(blockedMaintenance.historyCalls(), 0);
  assert.equal(blockedMaintenance.saveCalls(), 0);
  assert.equal(blockedMaintenance.session.messages.length, 0);

  const readyMaintenance = recoveryComposerFixture("/maintain", "ready");
  const readyItem = await createQueuedTurnFromComposer(readyMaintenance.view as never, {
    allowLocalKnowledgeCommands: true
  });
  assert.equal(readyItem?.kind, "knowledge-base");
  assert.equal(readyItem?.text, "/maintain");
}

function recoveryComposerFixture(
  text: string,
  state: "pending" | "ready" | "blocked"
) {
  const session = baseSession();
  session.kind = "knowledge-base";
  let cleared = 0;
  let historyOpened = 0;
  let saved = 0;
  const recoveryMessage = state === "pending"
    ? "正在恢复上次知识库维护；尚未启动新的 Agent。/history 和 /help 仍可使用。"
    : state === "blocked"
      ? "上次知识库维护恢复被阻断；尚未启动新的 Agent。"
      : "";
  const view = {
    inputEl: { value: text },
    attachments: [],
    selectedSkill: null,
    ensureSession: () => session,
    isKnowledgeBaseSession: () => true,
    clearComposerDraft: () => {
      cleared += 1;
    },
    openKnowledgeBaseHistory: async () => {
      historyOpened += 1;
    },
    clearKnowledgeBasePage: async () => undefined,
    currentTurnOptions: () => ({}),
    ensureChatWorkspaceSelected: async () => true,
    addMessageToSession: (
      target: StoredSession,
      message: Omit<ChatMessage, "id"> & Partial<Pick<ChatMessage, "id">>
    ) => {
      target.messages.push({
        ...message,
        id: message.id ?? `local-message-${target.messages.length + 1}`
      } as ChatMessage);
    },
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    plugin: {
      getKnowledgeBaseManager: () => ({
        maintenanceRecoveryStatus: { state, message: recoveryMessage }
      }),
      saveSettings: async () => {
        saved += 1;
      }
    }
  };
  return {
    view,
    session,
    clearCalls: () => cleared,
    historyCalls: () => historyOpened,
    saveCalls: () => saved
  };
}

function fakeKnowledgeView(
  session: StoredSession,
  result: HarnessRunResult | KnowledgeBaseChatResult,
  savedSnapshots: StoredSession[],
  options: {
    agentBackend?: "codex-cli" | "opencode" | "hermes";
    knowledgeBackend?: "codex-cli" | "opencode" | "hermes";
    onRender?: () => void;
    currentTurnOptions?: TurnOptions;
    onHandleUserMessage?: (text: string, attachments: unknown[], options: unknown) => void;
    onFinishThinking?: (status: string) => void;
    onFinishProcesses?: (status: string) => void;
    handleError?: Error;
  } = {}
) {
  const chatResult: KnowledgeBaseChatResult = "runId" in result
    ? {
      status: "success",
      message: "回答",
      harnessResult: result
    }
    : result;
  const manager = {
    handleUserMessage: async (text: string, attachments: unknown[], turnOptions: unknown) => {
      options.onHandleUserMessage?.(text, attachments, turnOptions);
      if (options.handleError) throw options.handleError;
      return chatResult;
    },
    getLastNativeLifecycleSummary: () => undefined
  };
  return {
    plugin: {
      settings: {
        activeSessionId: session.id,
        agentBackend: options.agentBackend ?? "codex-cli",
        knowledgeBase: { backend: options.knowledgeBackend ?? "codex-cli" }
      },
      getKnowledgeBaseManager: () => manager,
      withEchoInkConversationMutation: async <T>(
        _conversationId: string,
        action: () => Promise<T>
      ): Promise<T> => await action(),
      externalizeMessageText: async (message: ChatMessage, text: string) => {
        message.text = text;
      },
      saveSettings: async () => {
        savedSnapshots.push(JSON.parse(JSON.stringify(session)) as StoredSession);
      },
      settlePendingKnowledgeBaseNativeExecutions: async () => undefined
    },
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    running: false,
    currentTurnOptions: () => options.currentTurnOptions ?? {},
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => options.onRender?.(),
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    applyStatus: () => undefined,
    refreshKnowledgeDashboard: async () => undefined,
    finishThinkingMessage: (_session: StoredSession, status: string) => options.onFinishThinking?.(status),
    finishRunningProcessMessages: (_session: StoredSession, status: string) => options.onFinishProcesses?.(status),
    finishPlanMessage: () => undefined,
    moveMessageToEnd: () => undefined,
    fillKnowledgeBaseCommand: () => undefined
  };
}

function baseSession(): StoredSession {
  return {
    id: "kb-session",
    title: "Knowledge",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function queuedKnowledgeAsk(): QueuedTurnItem {
  return {
    id: "turn-kb-ask",
    sessionId: "kb-session",
    text: "/ask 第一轮",
    attachments: [],
    createdAt: 1,
    turnOptions: {}
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
