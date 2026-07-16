import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { AgentEvent } from "../../agent/events";
import { DEFAULT_SETTINGS, type ChatMessage, type StoredSession } from "../../settings/settings";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { QueuedTurnItem } from "../../ui/turn-queue";
import { buildActionTimeline } from "../../ui/codex-view/action-timeline";
import { buildAgentTurnProjection } from "../../ui/codex-view/agent-turn-process";
import { buildInlineAgentProcessMessages, createAgentEventRenderState, reduceAgentEventForChat } from "../../ui/codex-view/agent-event-renderer";
import { actionVerb, agentFooterItems, messageProvenanceMetaItems, messageTitleTime, shouldRenderMessageTitle, terminalAnswerFooterMessageIds } from "../../ui/codex-view/message-list";
import { SessionMessageStore } from "../../ui/codex-view/session-message-store";
import { messageRenderOptionsForRunUpdate, selectFirstNonBlankText, shouldDismissThinkingForHarnessEvent, startChatTurn } from "../../ui/codex-view/turn-runner";
import { renderTabsView } from "../../ui/codex-view/session-controller";

export async function runHarnessV3ChatUiTests(): Promise<void> {
  const runningMessages = createAgentTurn("running");
  assert.deepEqual(
    buildAgentTurnProjection(runningMessages).map(projectionLabel),
    ["message:user", "message:reasoning", "message:command", "message:knowledge", "message:answer"]
  );

  const completedMessages = createAgentTurn("completed");
  assert.deepEqual(
    buildAgentTurnProjection(completedMessages).map(projectionLabel),
    ["message:user", "process:answer", "message:knowledge", "message:answer"]
  );
  const completedProcess = buildAgentTurnProjection(completedMessages).find((item) => item.kind === "completedProcess");
  assert.ok(completedProcess && completedProcess.kind === "completedProcess");
  assert.deepEqual(completedProcess.turn.processMessages.map((message) => message.id), ["reasoning", "command"]);
  assert.equal(completedProcess.turn.finalAnswer.id, "answer");
  testActiveProcessAfterAnswerPreventsFolding();
  testExceptionalProcessRequiresAttention();

  const timeline = buildActionTimeline(completedMessages);
  assert.equal(timeline.totalCount, 1);
  assert.deepEqual(timeline.groups.map((group) => group.kind), ["command"]);
  assert.equal(timeline.groups.some((group) => group.items.some((item) => item.id === "knowledge")), false);

  testUnconfirmedAndInterruptedActionsStayHonest();

  assert.deepEqual(messageProvenanceMetaItems(completedMessages[4]), [
    "OpenCode · openai/gpt-5.5 · build",
    "Context incremental",
    "Lease active · reused · turn 2"
  ]);

  const hermesThinking: AgentEvent = {
    type: "thinking_delta",
    backend: "hermes",
    runId: "run-hermes",
    text: "raw internal thought",
    createdAt: 1
  };
  const hermesState = reduceAgentEventForChat(createAgentEventRenderState("hermes"), hermesThinking);
  assert.equal(hermesState.thinkingBlocks.length, 1);
  assert.equal(buildInlineAgentProcessMessages(hermesState, {
    runId: "run-hermes",
    backendId: "hermes",
    createdAt: 1
  }).some((message) => message.itemType === "reasoning"), true);

  const codexState = reduceAgentEventForChat(createAgentEventRenderState("codex-cli"), {
    ...hermesThinking,
    backend: "codex-cli",
    runId: "run-codex"
  });
  assert.equal(codexState.thinkingBlocks.length, 1);

  testCompletedTurnRemovesColdStartFallback();
  testColdStartWaitsForVisibleProviderContent();
  testAnswerFooterIsFrozenPerRun();
  testProductionSettlementPreservesNonBlankMarkdown();
  await testUnifiedChatHarnessTurn();
  await testSynchronousChatCancellationUsesInterruptedUi();
  await testChatTabUpdatesPlaceholderBeforeSettingsSave();

  assert.deepEqual(messageRenderOptionsForRunUpdate({ messagesBottomFollowPaused: false }), { forceBottom: true, preserveScroll: false });
  assert.deepEqual(messageRenderOptionsForRunUpdate({ messagesBottomFollowPaused: true }), { forceBottom: false, preserveScroll: true });

  const turnRunnerSource = await readFile(path.join(process.cwd(), "src/ui/codex-view/turn-runner.ts"), "utf8");
  const messageListSource = await readFile(path.join(process.cwd(), "src/ui/codex-view/message-list.ts"), "utf8");
  const styles = await readFile(path.join(process.cwd(), "styles.css"), "utf8");
  assert.match(turnRunnerSource, /createHarnessAgentAdapter/);
  assert.match(turnRunnerSource, /runHarnessWithAdapter/);
  assert.doesNotMatch(turnRunnerSource, /runAgentTaskWithEvents/);
  assert.doesNotMatch(turnRunnerSource, /harnessBackendUsesThinkingMessage/);
  assert.match(messageListSource, /buildAgentTurnProjection\(messages\)/);
  assert.match(messageListSource, /tryUpdateMessage\(message:\s*ChatMessage\)/);
  assert.match(messageListSource, /COLD_START_STATUS_TEXT = "正在整理上下文"/);
  assert.match(messageListSource, /` · \$\{rotatingChoice\(COLD_START_COPY_TEXTS/);
  assert.match(messageListSource, /content\.addClass\("codex-inline-reasoning"\)/);
  assert.doesNotMatch(messageListSource, /setIcon\([^\n]*"brain"/);
  assert.match(messageListSource, /message\.runUsage\?\.totalTokens/);
  assert.match(messageListSource, /copyAnswerMarkdown\(message/);
  assert.doesNotMatch(messageListSource, /renderMessageProvenanceMeta/);
  assert.doesNotMatch(messageListSource, /上下文 \$\{usage\.label\}/);
  assert.match(messageListSource, /formatAgentTurnDuration/);
  assert.match(messageListSource, /turn\.failed\s*\|\|\s*turn\.requiresAttention/);
  for (const selector of [".codex-agent-header", ".codex-message-type-actionStream", ".codex-turn-process", ".codex-action-region", ".codex-inline-reasoning", ".codex-agent-footer-meta", ".codex-answer-copy"]) {
    assert.ok(styles.includes(`${selector} {`) || styles.includes(`${selector},`), `Missing UI selector ${selector}`);
  }
  assert.match(styles, /\.codex-message-empty-running:not\(\.has-agent-header\)\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /\.codex-message-empty-running\.has-agent-header\s*>\s*\.codex-message-content\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /\.codex-thinking-live\s+\.codex-agent-live-copy::before\s*\{[^{}]*content:\s*none[^{}]*margin:\s*0/);
  assert.match(styles, /\.codex-agent-avatar\s*\{[\s\S]*background:\s*#8b5cf6/);
  for (const selector of [".codex-process-raw-title", ".codex-diff-stats", ".codex-diff-file-path", ".codex-process-file-link.codex-diff-file-path"]) {
    const escaped = selector.replaceAll(".", "\\.");
    assert.match(styles, new RegExp(`${escaped}\\s*(?:,[^{}]+)?\\{[^{}]*font-weight:\\s*400`));
  }
  const narrow420Start = styles.indexOf("@container (max-width: 420px)");
  const narrow360Start = styles.indexOf("@container (max-width: 360px)", narrow420Start);
  assert.ok(narrow420Start >= 0 && narrow360Start > narrow420Start, "narrow chat breakpoints must exist in descending order");
  const narrow420Styles = styles.slice(narrow420Start, narrow360Start);
  const narrow360Styles = styles.slice(narrow360Start);
  assert.match(narrow420Styles, /\.codex-agent-name-row\s*\{[^{}]*flex-wrap:\s*nowrap/);
  assert.match(styles, /@container\s*\(max-width:\s*420px\)[\s\S]*\.codex-agent-name\s*\{[\s\S]*white-space:\s*nowrap/);
  assert.match(narrow420Styles, /\.codex-agent-model-pill\s*\{[^{}]*min-width:\s*0/);
  assert.match(narrow420Styles, /\.codex-agent-model-pill\s*\{[^{}]*flex:\s*0\s+1\s+auto/);
  assert.doesNotMatch(narrow420Styles, /\.codex-agent-model-pill\s*\{[^{}]*flex:\s*1\s+1\s+100%/);
  assert.doesNotMatch(narrow360Styles, /\.codex-agent-model-pill\s*\{[^{}]*flex:\s*1\s+1\s+100%/);
  assert.match(styles, /@container\s*\(max-width:\s*420px\)[\s\S]*\.codex-kb-maintain-report-path\s*\{[\s\S]*overflow-wrap:\s*anywhere[\s\S]*white-space:\s*normal/);
}

function testActiveProcessAfterAnswerPreventsFolding(): void {
  const messages: ChatMessage[] = [
    { id: "user-active-after", role: "user", text: "继续", runId: "run-active-after", createdAt: 1 },
    { id: "reasoning-active-after", role: "assistant", itemType: "reasoning", processKind: "reasoning", text: "先分析", status: "completed", runId: "run-active-after", createdAt: 2, completedAt: 3 },
    { id: "answer-active-after", role: "assistant", itemType: "assistant", text: "先说明", status: "completed", runId: "run-active-after", createdAt: 4, completedAt: 5 },
    { id: "tool-active-after", role: "tool", itemType: "dynamicToolCall", processKind: "view", text: "读取中", status: "running", runId: "run-active-after", createdAt: 6 }
  ];

  const projection = buildAgentTurnProjection(messages);
  assert.equal(projection.some((item) => item.kind === "completedProcess"), false, "a process row after the answer must keep the whole run expanded while it is active");
  assert.equal(projection.some((item) => item.kind === "message" && item.message.id === "tool-active-after"), true);
}

function testExceptionalProcessRequiresAttention(): void {
  for (const status of ["unconfirmed", "interrupted", "failed", "error", "cancelled"] as const) {
    const messages = createAgentTurn("completed");
    const command = messages.find((message) => message.id === "command");
    assert.ok(command);
    command.status = status;
    const turn = buildAgentTurnProjection(messages).find((item) => item.kind === "completedProcess");
    assert.ok(turn && turn.kind === "completedProcess");
    assert.equal(turn.turn.failed, false, `${status} process state must not impersonate a failed final answer`);
    assert.equal(turn.turn.requiresAttention, true, `${status} process state must default the completed process disclosure open`);
  }
}

function testUnconfirmedAndInterruptedActionsStayHonest(): void {
  const unconfirmed = buildActionTimeline([{
    id: "unconfirmed-command",
    role: "tool",
    itemType: "commandExecution",
    processKind: "command",
    title: "shell",
    details: "npm test",
    text: "partial stdout",
    status: "unconfirmed",
    runId: "run-unconfirmed-action",
    createdAt: 1
  }]);
  assert.equal(unconfirmed.runStatus, "unconfirmed");
  assert.equal(unconfirmed.summaryTitle, "1 个动作状态未回传");
  assert.equal(unconfirmed.groups[0]?.title, "命令状态未回传");
  assert.equal(actionVerb(unconfirmed.groups[0].items[0]), "运行状态未回传");

  const interrupted = buildActionTimeline([{
    id: "interrupted-read",
    role: "tool",
    itemType: "dynamicToolCall",
    processKind: "view",
    title: "read_file",
    text: "",
    status: "interrupted",
    runId: "run-interrupted-action",
    createdAt: 2
  }]);
  assert.equal(interrupted.runStatus, "interrupted");
  assert.equal(interrupted.summaryTitle, "1 个动作已中断");
  assert.equal(interrupted.groups[0]?.title, "读取已中断");
  assert.equal(actionVerb(interrupted.groups[0].items[0]), "读取已中断");
}

function testCompletedTurnRemovesColdStartFallback(): void {
  const session: StoredSession = {
    id: "chat-process-fallback",
    title: "Process fallback",
    cwd: "/tmp/echoink-chat-ui",
    messages: [
      { id: "user-fallback", role: "user", text: "ping", runId: "run-fallback", createdAt: 1_000 },
      { id: "answer-fallback", role: "assistant", itemType: "assistant", text: "pong", status: "completed", runId: "run-fallback", createdAt: 2_000, completedAt: 3_000 }
    ],
    createdAt: 1,
    updatedAt: 1
  };
  const store = new SessionMessageStore({
    getActiveRunId: () => "run-fallback",
    getActiveTurnId: () => "",
    getVaultPath: () => "/tmp/echoink-chat-ui",
    externalizeMessageText: async () => undefined,
    renderMessagesIfActive: () => undefined,
    scheduleSessionSave: () => undefined
  });

  store.ensureThinkingMessage(session, "初始化", "正在初始化 EchoInk 运行...");
  store.finishThinkingMessage(session, "完成");

  const fallback = session.messages.find((message) => message.itemType === "thinking");
  assert.equal(fallback, undefined, "successful turns must remove the cold-start row instead of inserting a completed fallback");
  const projection = buildAgentTurnProjection(session.messages);
  assert.equal(projection.some((item) => item.kind === "completedProcess"), false);

  const failedSession: StoredSession = {
    ...session,
    id: "chat-process-failure",
    messages: [
      { id: "user-failure", role: "user", text: "ping", runId: "run-fallback", createdAt: 4_000 },
      { id: "answer-failure", role: "assistant", itemType: "error", title: "回复失败", text: "boom", status: "failed", runId: "run-fallback", createdAt: 5_000, completedAt: 6_000 }
    ]
  };
  store.ensureThinkingMessage(failedSession, "初始化", "正在初始化 EchoInk 运行...");
  store.finishThinkingMessage(failedSession, "失败");
  const failureFallback = failedSession.messages.find((message) => message.itemType === "thinking");
  assert.equal(failureFallback, undefined, "a terminal error answer must be the only failure state for its run");
  assert.equal(failedSession.messages.filter((message) => message.runId === "run-fallback" && message.status === "failed").length, 1);

  const cancelledSession: StoredSession = {
    ...session,
    id: "chat-process-cancelled",
    messages: [
      { id: "user-cancelled", role: "user", text: "ping", runId: "run-fallback", createdAt: 7_000 },
      { id: "answer-cancelled", role: "assistant", itemType: "error", title: "已中断", text: "cancelled", status: "interrupted", runId: "run-fallback", createdAt: 8_000, completedAt: 9_000 }
    ]
  };
  store.ensureThinkingMessage(cancelledSession, "初始化", "正在初始化 EchoInk 运行...");
  store.finishThinkingMessage(cancelledSession, "中断");
  assert.equal(cancelledSession.messages.some((message) => message.itemType === "thinking"), false);
  assert.equal(cancelledSession.messages.filter((message) => message.runId === "run-fallback" && message.status === "interrupted").length, 1);

  const legacyFailureSession: StoredSession = {
    ...session,
    id: "chat-process-legacy-failure",
    messages: [{ id: "user-legacy-failure", role: "user", text: "ping", runId: "run-fallback", createdAt: 10_000 }]
  };
  store.ensureThinkingMessage(legacyFailureSession, "初始化", "正在初始化 EchoInk 运行...");
  store.finishThinkingMessage(legacyFailureSession, "失败");
  const legacyFallback = legacyFailureSession.messages.find((message) => message.itemType === "thinking");
  assert.equal(legacyFallback?.status, "failed", "legacy callers without a terminal carrier must retain one honest fallback state");
  assert.equal(legacyFallback?.text, "处理失败");
}

function testColdStartWaitsForVisibleProviderContent(): void {
  const delayedReasoning = [
    harnessEvent("run-delayed-reasoning", 1, "agent.reasoning.started", { data: { visibility: "public" } }),
    harnessEvent("run-delayed-reasoning", 2, "agent.reasoning.summary.delta", { text: " \n ", data: { visibility: "public" } }),
    harnessEvent("run-delayed-reasoning", 3, "agent.reasoning.summary.delta", { text: "真正可见的推理", data: { visibility: "public" } })
  ];
  assert.deepEqual(delayedReasoning.map(shouldDismissThinkingForHarnessEvent), [false, false, true]);
  assert.equal(shouldDismissThinkingForHarnessEvent(harnessEvent("run-visible-message", 1, "agent.message.completed", { text: "" })), false);
  assert.equal(shouldDismissThinkingForHarnessEvent(harnessEvent("run-visible-message", 2, "agent.message.delta", { text: "回答" })), true);
  assert.equal(shouldDismissThinkingForHarnessEvent(harnessEvent("run-visible-plan", 1, "agent.plan.updated", { text: "" })), false);
  assert.equal(shouldDismissThinkingForHarnessEvent(harnessEvent("run-visible-plan", 2, "agent.plan.updated", { text: "执行计划" })), true);
  assert.equal(shouldDismissThinkingForHarnessEvent(harnessEvent("run-visible-tool", 1, "tool.started", {})), true);
  assert.equal(shouldDismissThinkingForHarnessEvent(harnessEvent("run-visible-file", 1, "file.change.proposed", {})), true);
}

function testProductionSettlementPreservesNonBlankMarkdown(): void {
  const markdown = "\n\n- **保留列表**\n- [保留链接](https://example.com)\n\n";
  assert.equal(selectFirstNonBlankText("", " \n ", markdown, "fallback"), markdown);
  assert.equal(selectFirstNonBlankText("", " \n "), "");

  const failedAnswer: ChatMessage = {
    id: "failed-answer-title-time",
    role: "assistant",
    itemType: "error",
    title: "回复失败",
    text: "boom",
    status: "failed",
    createdAt: new Date(2026, 6, 17, 1, 1).getTime(),
    completedAt: new Date(2026, 6, 17, 1, 51).getTime()
  };
  assert.equal(shouldRenderMessageTitle(failedAnswer, true), true);
  assert.equal(messageTitleTime(failedAnswer), "", "failed answer title must not repeat its createdAt timestamp");
  assert.deepEqual(agentFooterItems(failedAnswer), ["周五 01:51"], "the answer footer must retain its terminal completedAt timestamp");
}

function testAnswerFooterIsFrozenPerRun(): void {
  const firstCompletedAt = new Date(2026, 6, 17, 1, 51).getTime();
  const secondCompletedAt = new Date(2026, 6, 17, 2, 3).getTime();
  const first: ChatMessage = {
    id: "answer-footer-first",
    role: "assistant",
    itemType: "assistant",
    text: "first",
    status: "completed",
    runId: "run-footer-first",
    backendId: "codex-cli",
    contextMode: "incremental",
    runUsage: { totalTokens: 31_287 },
    createdAt: firstCompletedAt - 1_000,
    completedAt: firstCompletedAt
  };
  const second: ChatMessage = {
    id: "answer-footer-second",
    role: "assistant",
    itemType: "assistant",
    text: "second",
    status: "completed",
    runId: "run-footer-second",
    backendId: "hermes",
    runUsage: { totalTokens: 99 },
    createdAt: secondCompletedAt - 1_000,
    completedAt: secondCompletedAt
  };
  const missingUsage: ChatMessage = {
    id: "answer-footer-no-usage",
    role: "assistant",
    itemType: "assistant",
    text: "no usage",
    status: "completed",
    runId: "run-footer-no-usage",
    createdAt: secondCompletedAt,
    completedAt: secondCompletedAt
  };
  const knowledge: ChatMessage = {
    id: "knowledge-no-footer",
    role: "assistant",
    itemType: "knowledgeBase",
    text: "report",
    status: "completed",
    runId: "run-knowledge-no-footer",
    createdAt: secondCompletedAt
  };
  const footerIds = terminalAnswerFooterMessageIds([first, second, missingUsage, knowledge]);
  assert.deepEqual(Array.from(footerIds), [first.id, second.id, missingUsage.id]);
  assert.deepEqual(agentFooterItems(first), ["周五 01:51", "本轮 31,287 tokens"]);
  assert.deepEqual(agentFooterItems(missingUsage), ["周五 02:03"], "missing usage must not render a fake zero");
  assert.equal(agentFooterItems(first).some((item) => /Codex|上下文|Context|已完成/.test(item)), false);
  assert.equal(shouldRenderMessageTitle({ ...first, title: "Codex", status: "completed" }, true), false, "successful answers must not repeat a title beside the run header");
  assert.equal(shouldRenderMessageTitle({ ...first, itemType: "error", title: "回复失败", status: "failed" }, true), true, "failed state must remain visible even when the same row owns the run header");
  assert.equal(shouldRenderMessageTitle({ ...first, itemType: "error", title: "已中断", status: "interrupted" }, true), true, "interrupted state must remain visible even when the same row owns the run header");
  second.runUsage = { totalTokens: 100 };
  assert.deepEqual(agentFooterItems(first), ["周五 01:51", "本轮 31,287 tokens"], "later run usage must not mutate an earlier footer");
}

async function testChatTabUpdatesPlaceholderBeforeSettingsSave(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const knowledge: StoredSession = {
    id: "knowledge-placeholder",
    title: "知识库管理",
    kind: "knowledge-base",
    cwd: "/tmp/echoink-chat-ui",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const chat: StoredSession = {
    id: "chat-placeholder",
    title: "Chat placeholder",
    cwd: "/tmp/echoink-chat-ui",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  settings.knowledgeBase.sessionId = knowledge.id;
  settings.sessions = [knowledge, chat];
  settings.activeSessionId = knowledge.id;
  let releaseSave!: () => void;
  const saveBlocked = new Promise<void>((resolve) => { releaseSave = resolve; });
  let placeholderUpdates = 0;
  let buttons: any[] = [];
  const tabBarEl = {
    empty() { buttons = []; },
    createEl(_tag: string, options: any) {
      const button = {
        className: options?.cls ?? "",
        textContent: options?.text ?? "",
        attrs: options?.attr ?? {},
        onclick: null as null | (() => void),
        oncontextmenu: null,
        ondblclick: null,
        getAttribute(name: string) { return this.attrs[name] ?? null; }
      };
      buttons.push(button);
      return button;
    }
  };
  const host: any = {
    plugin: {
      settings,
      getVaultPath: () => "/tmp/echoink-chat-ui",
      saveSettings: async () => await saveBlocked
    },
    turnQueue: { clearSessionQueue: () => undefined },
    tabBarEl,
    running: false,
    activeRunSessionId: "",
    inputEl: { value: "" },
    attachments: [],
    selectedSkill: null,
    resetVirtualWindow: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    renderKnowledgeDashboard: () => undefined,
    refreshKnowledgeDashboard: async () => undefined,
    updateInputPlaceholder: () => { placeholderUpdates += 1; },
    prewarmActiveThread: () => undefined,
    closeComposerMenus: () => undefined,
    isKnowledgeBaseSession: (session: StoredSession) => session.id === knowledge.id
  };

  renderTabsView(host);
  const chatButton = buttons.find((button) => button.getAttribute("title") === chat.title);
  assert.ok(chatButton?.onclick);
  chatButton.onclick();

  assert.equal(settings.activeSessionId, chat.id);
  assert.equal(placeholderUpdates, 1, "chat placeholder must update before asynchronous settings persistence finishes");
  releaseSave();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function testUnifiedChatHarnessTurn(): Promise<void> {
  const expectedMarkdown = "\n\n- **统一答复**\n- [原始链接](https://example.com)\n\n";
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "hermes";
  settings.capabilities.chatBackend = "hermes";
  settings.agents.hermes.modelId = "test/hermes-model";
  const session: StoredSession = {
    id: "chat-ui-session",
    title: "新会话",
    cwd: "/tmp/echoink-chat-ui",
    messages: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  };
  const item: QueuedTurnItem = {
    id: "queued-chat-ui",
    sessionId: session.id,
    text: "统一 Harness 测试",
    attachments: [],
    skill: null,
    turnOptions: {
      model: "",
      reasoning: "high",
      serviceTier: "fast",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  let harnessRuns = 0;
  let connectedBackend = "";
  let capturedRequest: Record<string, unknown> | null = null;
  const plugin = {
    settings,
    ensureHarnessBackendConnected: async (backend: string) => {
      connectedBackend = backend;
    },
    getVaultPath: () => "/tmp/echoink-chat-ui",
    getNativeExecutionRefContext: () => ({ deviceKey: "test-device", vaultId: "test-vault" }),
    listEchoInkMcpTools: async () => [],
    callEchoInkMcpTool: async () => ({ content: [] }),
    externalizeMessageText: async () => undefined,
    saveSettings: async () => undefined,
    settleHarnessRunTerminal: async () => undefined,
    runHarnessWithAdapter: async (input: { request: Record<string, unknown>; sink: (event: HarnessEvent) => void | Promise<void> }) => {
      harnessRuns += 1;
      capturedRequest = input.request;
      const runId = String(input.request.runId);
      await input.sink(harnessEvent(runId, 1, "agent.thinking.delta", { text: "正在分析" }));
      await input.sink(harnessEvent(runId, 2, "agent.message.delta", { text: expectedMarkdown }));
      await input.sink(harnessEvent(runId, 3, "tool.requested", { toolName: "read_file", data: { toolCallId: "tool-1" } }));
      await input.sink(harnessEvent(runId, 4, "tool.completed", { toolName: "read_file", data: { toolCallId: "tool-1", output: "ok" } }));
      await input.sink(harnessEvent(runId, 5, "usage.updated", { data: { usage: { totalTokens: 21, inputTokens: 16, outputTokens: 5 } } }));
      await input.sink(harnessEvent(runId, 6, "run.completed", { text: expectedMarkdown, status: "completed" }));
      return {
        runId,
        status: "completed" as const,
        outputText: expectedMarkdown,
        backendBinding: {
          backendId: "hermes",
          nativeSessionId: "hermes-native-1",
          leaseId: "lease-hermes-1",
          leaseStatus: "active" as const,
          leaseTurnCount: 1,
          syncedSessionRevision: 1,
          lastUsedAt: 10
        }
      };
    }
  };
  let activeRunId = "";
  let activeRunKind = "";
  let activeRunSessionId = "";
  let running = false;
  let thinkingStarts = 0;
  let thinkingFinishes = 0;
  let thinkingDismisses = 0;
  const view: any = {
    plugin,
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    get activeRunKind() { return activeRunKind; },
    set activeRunKind(value: string) { activeRunKind = value; },
    get activeRunSessionId() { return activeRunSessionId; },
    set activeRunSessionId(value: string) { activeRunSessionId = value; },
    activeTurnId: "",
    turnStartedAt: 0,
    threadPrewarmPromise: null,
    threadPrewarmSessionId: "",
    messagesBottomFollowPaused: false,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => {
      activeRunId = "";
      activeRunKind = "";
      activeRunSessionId = "";
    },
    ensureThinkingMessage: () => { thinkingStarts += 1; },
    dismissThinkingMessage: () => { thinkingDismisses += 1; },
    armTurnWatchdog: () => undefined,
    attachTurnIdToRun: () => undefined,
    finishThinkingMessage: () => { thinkingFinishes += 1; },
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    afterTurnSettled: async () => undefined
  };

  const outcome = await startChatTurn(view, session, item, "composer");
  assert.equal(outcome, "completed");
  assert.equal(harnessRuns, 1);
  assert.equal(connectedBackend, "hermes");
  assert.equal(capturedRequest?.surface, "chat");
  assert.equal(capturedRequest?.workflow, "chat.generic");
  assert.equal(session.messages.filter((message) => message.role === "user").length, 1);
  const answer = session.messages.find((message) => message.role === "assistant" && message.itemType === "assistant");
  assert.equal(answer?.text, expectedMarkdown, "synchronous settlement must preserve nonblank Markdown byte-for-byte");
  assert.equal(answer?.backendId, "hermes");
  assert.equal(answer?.title, undefined);
  assert.deepEqual(answer?.runUsage, { totalTokens: 21, inputTokens: 16, outputTokens: 5 });
  assert.equal(answer?.nativeLeaseId, "lease-hermes-1");
  assert.equal(thinkingStarts > 0, true, "Hermes must use the same EchoInk thinking lifecycle as other backends");
  assert.equal(thinkingDismisses > 0, true, "the first public process event must dismiss the single cold-start row");
  assert.equal(thinkingFinishes, 1);
  assert.equal(session.messages.some((message) => message.id.includes("inline-process") && message.itemType === "reasoning" && /正在分析/.test(message.text)), true);
  assert.equal(session.messages.some((message) => message.id.includes("inline-process") && message.itemType === "dynamicToolCall" && message.processKind === "view"), true);
}

async function testSynchronousChatCancellationUsesInterruptedUi(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "hermes";
  settings.capabilities.chatBackend = "hermes";
  const session: StoredSession = {
    id: "chat-ui-cancelled-session",
    title: "Cancel",
    cwd: "/tmp/echoink-chat-ui",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const item: QueuedTurnItem = {
    id: "queued-chat-ui-cancelled",
    sessionId: session.id,
    text: "取消这轮",
    attachments: [],
    skill: null,
    turnOptions: {
      model: "",
      reasoning: "high",
      serviceTier: "fast",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false
    },
    kind: "chat",
    createdAt: 2
  };
  const thinkingLabels: string[] = [];
  let activeRunId = "";
  const view: any = {
    plugin: {
      settings,
      ensureHarnessBackendConnected: async () => undefined,
      getVaultPath: () => "/tmp/echoink-chat-ui",
      getNativeExecutionRefContext: () => ({ deviceKey: "test-device", vaultId: "test-vault" }),
      listEchoInkMcpTools: async () => [],
      callEchoInkMcpTool: async () => ({ content: [] }),
      externalizeMessageText: async () => undefined,
      saveSettings: async () => undefined,
      settleHarnessRunTerminal: async () => undefined,
      runHarnessWithAdapter: async (input: { request: Record<string, unknown>; sink: (event: HarnessEvent) => void | Promise<void> }) => {
        const runId = String(input.request.runId);
        await input.sink(harnessEvent(runId, 1, "run.cancelled", { error: "Run cancelled" }));
        return { runId, status: "cancelled" as const, error: "Run cancelled" };
      }
    },
    running: false,
    get activeRunId() { return activeRunId; },
    set activeRunId(value: string) { activeRunId = value; },
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    turnStartedAt: 0,
    threadPrewarmPromise: null,
    threadPrewarmSessionId: "",
    messagesBottomFollowPaused: false,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => { activeRunId = ""; },
    ensureThinkingMessage: () => undefined,
    armTurnWatchdog: () => undefined,
    attachTurnIdToRun: () => undefined,
    finishThinkingMessage: (_session: StoredSession, label: string) => { thinkingLabels.push(label); },
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    afterTurnSettled: async () => undefined
  };

  const outcome = await startChatTurn(view, session, item, "composer");
  const answer = session.messages.find((message) => message.runId && message.role === "assistant");
  assert.equal(outcome, "cancelled");
  assert.equal(answer?.title, "已中断");
  assert.doesNotMatch(answer?.title ?? "", /发送失败/);
  assert.deepEqual(thinkingLabels, ["中断"]);
}

function harnessEvent(runId: string, sequence: number, type: HarnessEvent["type"], patch: Partial<HarnessEvent>): HarnessEvent {
  return {
    eventId: `${runId}:${sequence}`,
    runId,
    sequence,
    createdAt: sequence,
    source: type.startsWith("tool.") ? "tool" : "agent",
    type,
    ...patch
  };
}

function createAgentTurn(status: "running" | "completed"): ChatMessage[] {
  const completedAt = status === "completed" ? 6_000 : undefined;
  return [
    { id: "user", role: "user", text: "请检查", runId: "run-ui", createdAt: 1_000 },
    { id: "reasoning", role: "assistant", itemType: "reasoning", processKind: "reasoning", text: "分析中", status, runId: "run-ui", createdAt: 2_000 },
    { id: "command", role: "tool", itemType: "commandExecution", processKind: "command", text: "npm test", details: "已运行 npm test", status, runId: "run-ui", createdAt: 3_000 },
    { id: "knowledge", role: "assistant", itemType: "knowledgeBase", text: "知识卡", status: "completed", runId: "run-ui", createdAt: 4_000 },
    {
      id: "answer",
      role: "assistant",
      itemType: "assistant",
      text: "完成",
      status,
      runId: "run-ui",
      backendId: "opencode",
      modelId: "openai/gpt-5.5",
      profileId: "build",
      contextMode: "incremental",
      nativeLeaseId: "lease-ui",
      nativeLeaseStatus: "active",
      nativeLeaseReused: true,
      nativeLeaseTurnCount: 2,
      createdAt: 5_000,
      ...(completedAt ? { completedAt } : {})
    }
  ];
}

function projectionLabel(item: ReturnType<typeof buildAgentTurnProjection>[number]): string {
  return item.kind === "completedProcess" ? `process:${item.turn.finalAnswer.id}` : `message:${item.message.id}`;
}
