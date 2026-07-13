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
import { messageProvenanceMetaItems } from "../../ui/codex-view/message-list";
import { messageRenderOptionsForRunUpdate, startChatTurn } from "../../ui/codex-view/turn-runner";
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

  const timeline = buildActionTimeline(completedMessages);
  assert.equal(timeline.totalCount, 1);
  assert.deepEqual(timeline.groups.map((group) => group.kind), ["command"]);
  assert.equal(timeline.groups.some((group) => group.items.some((item) => item.id === "knowledge")), false);

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
  assert.equal(hermesState.thinkingBlocks.length, 0);
  assert.equal(buildInlineAgentProcessMessages(hermesState, {
    runId: "run-hermes",
    backendId: "hermes",
    createdAt: 1
  }).some((message) => message.itemType === "reasoning"), false);

  const codexState = reduceAgentEventForChat(createAgentEventRenderState("codex-cli"), {
    ...hermesThinking,
    backend: "codex-cli",
    runId: "run-codex"
  });
  assert.equal(codexState.thinkingBlocks.length, 1);

  await testUnifiedChatHarnessTurn();
  await testChatTabUpdatesPlaceholderBeforeSettingsSave();

  assert.deepEqual(messageRenderOptionsForRunUpdate({ messagesBottomFollowPaused: false }), { forceBottom: true, preserveScroll: false });
  assert.deepEqual(messageRenderOptionsForRunUpdate({ messagesBottomFollowPaused: true }), { forceBottom: false, preserveScroll: true });

  const turnRunnerSource = await readFile(path.join(process.cwd(), "src/ui/codex-view/turn-runner.ts"), "utf8");
  const messageListSource = await readFile(path.join(process.cwd(), "src/ui/codex-view/message-list.ts"), "utf8");
  const styles = await readFile(path.join(process.cwd(), "styles.css"), "utf8");
  assert.match(turnRunnerSource, /createHarnessAgentAdapter/);
  assert.match(turnRunnerSource, /runHarnessWithAdapter/);
  assert.doesNotMatch(turnRunnerSource, /runAgentTaskWithEvents/);
  assert.match(messageListSource, /buildAgentTurnProjection\(messages\)/);
  assert.match(messageListSource, /tryUpdateMessage\(message:\s*ChatMessage\)/);
  assert.match(messageListSource, /message\.status !== "running"/);
  for (const selector of [".codex-agent-header", ".codex-message-type-actionStream", ".codex-turn-process", ".codex-action-region"]) {
    assert.ok(styles.includes(`${selector} {`) || styles.includes(`${selector},`), `Missing UI selector ${selector}`);
  }
  assert.match(styles, /@container\s*\(max-width:\s*420px\)[\s\S]*\.codex-agent-name-row\s*\{[\s\S]*flex-wrap:\s*wrap/);
  assert.match(styles, /@container\s*\(max-width:\s*420px\)[\s\S]*\.codex-agent-name\s*\{[\s\S]*white-space:\s*nowrap/);
  assert.match(styles, /@container\s*\(max-width:\s*420px\)[\s\S]*\.codex-kb-maintain-report-path\s*\{[\s\S]*overflow-wrap:\s*anywhere[\s\S]*white-space:\s*normal/);
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
      await input.sink(harnessEvent(runId, 1, "agent.message.delta", { text: "统一答复" }));
      await input.sink(harnessEvent(runId, 2, "tool.requested", { toolName: "read_file", data: { toolCallId: "tool-1" } }));
      await input.sink(harnessEvent(runId, 3, "tool.completed", { toolName: "read_file", data: { toolCallId: "tool-1", output: "ok" } }));
      await input.sink(harnessEvent(runId, 4, "run.completed", { text: "统一答复", status: "completed" }));
      return {
        runId,
        status: "completed" as const,
        outputText: "统一答复",
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
    ensureThinkingMessage: () => undefined,
    armTurnWatchdog: () => undefined,
    attachTurnIdToRun: () => undefined,
    finishThinkingMessage: () => undefined,
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
  assert.equal(answer?.text, "统一答复");
  assert.equal(answer?.backendId, "hermes");
  assert.equal(answer?.nativeLeaseId, "lease-hermes-1");
  assert.equal(session.messages.some((message) => message.id.includes("inline-process") && message.itemType === "dynamicToolCall" && message.processKind === "view"), true);
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
