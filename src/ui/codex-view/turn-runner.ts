import { Notice } from "obsidian";
import * as path from "path";
import { getAgentBackendDefinition } from "../../agent/registry";
import { runAgentTaskWithEvents } from "../../agent/simple-task";
import { createEchoInkMcpToolBridgeRuntime } from "../../agent/tool-bridge";
import type { AgentBackendKind, AgentPromptPart } from "../../agent/types";
import { buildCallableMcpToolCatalog } from "../../resources/mcp-tool-catalog";
import { buildEchoInkResourceCatalog, prepareAgentResources } from "../../resources/registry";
import type { ChatMessage, StoredAttachment, StoredSession } from "../../settings/settings";
import { newId } from "../../settings/settings";
import { buildUserInput, DEFAULT_REPLY_STYLE_INSTRUCTION } from "../../core/mapping";
import { swallowError } from "../../core/error-handling";
import { composerPrimaryActionForState } from "../composer-state";
import { canStartQueuedTurn, type QueuedTurnItem } from "../turn-queue";
import { parseKnowledgeBaseCommand } from "../../knowledge-base/commands";
import { buildKnowledgeBaseRunPayload, knowledgeBaseRunModeForCommandIntent } from "../../knowledge-base/maintain-report-card";
import { appendKnowledgeContextBridge, buildKnowledgeContextBridgeForThread, knowledgeContextBridgeDetailText, markKnowledgeContextBridgeInjected } from "./knowledge-context-bridge";
import { createAgentEventRenderState, reduceAgentEventForChat, type AgentChatRenderState } from "./agent-event-renderer";
import type { CodexViewTurnContext, MessageRenderFollowContext, QueuedTurnOutcome, QueuedTurnSource } from "./runner-context";

export async function sendMessage(view: CodexViewTurnContext): Promise<void> {
  if (view.editorSummaryRun) view.cancelEditorSummaryRun("用户输入抢占摘要");
  const session = view.ensureSession();
  const action = composerPrimaryActionForState(view.composerStateForSession(session));
  if (action === "enqueue") {
    await view.enqueueComposerDraft();
    return;
  }
  if (action === "resume-queue") {
    await view.resumeQueuedTurns(session.id);
    return;
  }
  if (action === "stop-turn") {
    await view.stopTurn();
    return;
  }
  if (action === "cancel-knowledge-task") {
    view.pauseQueueForSession(session.id);
    await view.plugin.getKnowledgeBaseManager()?.cancelMaintenance();
    return;
  }
  const item = await view.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: true });
  if (!item) return;
  const outcome = await view.startQueuedTurnItemSafely(item, "composer");
  if (outcome !== "running") await view.afterTurnSettled(item.sessionId, outcome === "completed");
}

export async function enqueueComposerDraft(view: CodexViewTurnContext): Promise<void> {
  const item = await view.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: false });
  if (!item) return;
  view.turnQueue.enqueue(item);
  view.clearComposerDraft();
  view.renderQueue();
  view.renderToolbar();
  new Notice("已加入队列");
  if (!view.running && !view.plugin.getKnowledgeBaseManager()?.isRunning && !view.turnQueue.isSessionQueuePaused(item.sessionId)) {
    void view.startNextQueuedTurn(item.sessionId);
  }
}

export async function resumeQueuedTurns(view: CodexViewTurnContext, sessionId: string): Promise<void> {
  view.turnQueue.resumeSessionQueue(sessionId);
  view.renderQueue();
  view.renderToolbar();
  await view.startNextQueuedTurn(sessionId);
}

export async function afterTurnSettled(view: CodexViewTurnContext, sessionId: string, succeeded: boolean): Promise<void> {
  const settlement = view.turnQueue.settleSessionQueue(sessionId, succeeded);
  if (settlement === "continue") {
    await view.startNextQueuedTurn(sessionId);
  }
  view.renderQueue();
  view.renderToolbar();
}

export function messageRenderOptionsForRunUpdate(view: MessageRenderFollowContext): { forceBottom: boolean; preserveScroll: boolean } {
  const forceBottom = !view.messagesBottomFollowPaused;
  return { forceBottom, preserveScroll: !forceBottom };
}

export async function startNextQueuedTurn(view: CodexViewTurnContext, sessionId: string): Promise<void> {
  if (!canStartQueuedTurn({
    queueStartInProgress: view.queueStartInProgress,
    viewRunning: view.running,
    knowledgeTaskRunning: Boolean(view.plugin.getKnowledgeBaseManager()?.isRunning)
  })) return;
  const item = view.turnQueue.dequeueNext(sessionId);
  if (!item) {
    view.renderQueue();
    view.renderToolbar();
    return;
  }
  view.queueStartInProgress = true;
  view.renderQueue();
  view.renderToolbar();
  let outcome: "running" | "completed" | "failed" = "failed";
  try {
    outcome = await view.startQueuedTurnItemSafely(item, "queue");
  } finally {
    view.queueStartInProgress = false;
  }
  if (outcome !== "running") await view.afterTurnSettled(item.sessionId, outcome === "completed");
}

export async function createQueuedTurnFromComposer(view: CodexViewTurnContext, options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> {
  let session = view.ensureSession();
  const text = view.inputEl.value.trim();
  const attachments = view.attachments.map((attachment) => ({ ...attachment }));
  const skill = view.selectedSkill ? { ...view.selectedSkill } : null;
  if (!text && !attachments.length && !skill) return null;
  const knowledgeSession = view.isKnowledgeBaseSession(session);
  const knowledgeCommand = knowledgeSession ? parseKnowledgeBaseCommand(text, attachments.length) : null;
  if (knowledgeSession && knowledgeCommand && isLocalKnowledgeBaseCommand(knowledgeCommand.intent)) {
    if (!options.allowLocalKnowledgeCommands) {
      new Notice("本地命令不能排队；当前任务结束后再操作");
      return null;
    }
    if (knowledgeCommand.intent === "clear") {
      await view.clearKnowledgeBasePage(session);
      return null;
    }
    if (knowledgeCommand.intent === "history") {
      view.clearComposerDraft();
      await view.openKnowledgeBaseHistory(session);
      return null;
    }
  }
  const kind = knowledgeSession && knowledgeCommand && knowledgeCommand.intent !== "chat" ? "knowledge-base" : "chat";
  if (kind === "chat" && !knowledgeSession) {
    const workspaceReady = await view.ensureChatWorkspaceSelected(session);
    if (!workspaceReady) return null;
    session = view.ensureSession();
  }
  return {
    id: newId("queued-turn"),
    sessionId: session.id,
    text,
    attachments,
    skill,
    turnOptions: view.currentTurnOptions(session),
    kind,
    createdAt: Date.now()
  };
}

export async function startQueuedTurnItem(view: CodexViewTurnContext, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  const session = view.sessionById(item.sessionId);
  if (!session) {
    new Notice("队列所属会话已不存在");
    return "failed";
  }
  if (item.kind === "knowledge-base") return await view.startKnowledgeBaseTurn(session, item, source);
  return await view.startChatTurn(session, item, source);
}

export async function startQueuedTurnItemSafely(view: CodexViewTurnContext, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  try {
    return await view.startQueuedTurnItem(item, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`任务收口失败：${message}`);
    return "failed";
  }
}

export async function startChatTurn(view: CodexViewTurnContext, session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  const backend = resolveChatBackend(view);
  if (backend !== "codex-cli") return await startSimpleAgentChatTurn(view, session, item, source, backend);
  try {
    const status = await view.plugin.ensureCodexConnected();
    view.applyStatus();
    if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");
    const runId = newId("run");
    view.activeRunId = runId;
    view.activeRunKind = "chat";
    view.activeRunSessionId = session.id;
    const turnAttachments = item.attachments.map((attachment) => ({ ...attachment }));
    const userMessage: ChatMessage = {
      id: newId("msg"),
      role: "user",
      text: item.text || "(附件)",
      runId,
      attachments: turnAttachments,
      images: turnAttachments.filter((attachment) => attachment.type === "image"),
      createdAt: Date.now()
    };
    await view.plugin.externalizeMessageText(userMessage, userMessage.text);
    session.messages.push(userMessage);
    session.updatedAt = Date.now();
    if (session.title === "新会话" && item.text) session.title = item.text.slice(0, 20);
    if (source === "composer") view.clearComposerDraft();
    view.renderTabs();
    view.renderMessagesIfActive(session);
    view.renderToolbar();

    const turnOptions = item.turnOptions;
    view.running = true;
    view.turnStartedAt = Date.now();
    view.ensureThinkingMessage(session, "连接中", "正在连接 Codex...");
    view.armTurnWatchdog();
    view.applyStatus();
    if (!session.threadId && view.threadPrewarmPromise && view.threadPrewarmSessionId === session.id) {
      const warmed = await view.threadPrewarmPromise.catch(() => false);
      if (!warmed && !session.threadId) throw new Error("新会话连接超时，请重试");
    }
    if (!session.threadId) {
      const started = await view.plugin.codex!.startThread(turnOptions);
      session.threadId = started.threadId;
    } else {
      await view.plugin.codex!.resumeThread(session.threadId, turnOptions).catch(async () => {
        const started = await view.plugin.codex!.startThread(turnOptions);
        session.threadId = started.threadId;
      });
    }
    const knowledgeContextBridge = view.isKnowledgeBaseSession(session) ? buildKnowledgeContextBridgeForThread(session, session.threadId) : null;
    const resourceSettings = view.plugin.settings?.resources;
    const resources = prepareAgentResources(buildEchoInkResourceCatalog({ settings: resourceSettings }), {
      scope: "chat",
      backendCapabilities: getAgentBackendDefinition("codex-cli").capabilities,
      enabledByScope: resourceSettings?.enabledByScope,
      mcpConnections: resourceSettings?.mcpConnections
    });
    const input = buildUserInput(item.text, turnAttachments, item.skill, buildCodexChatStyleInstruction(resources));
    if (knowledgeContextBridge) {
      input.splice(Math.min(1, input.length), 0, { type: "text", text: knowledgeContextBridge.text, text_elements: [] });
    }
    view.activeTurnId = await view.plugin.codex!.startTurn(session.threadId, input, turnOptions);
    if (knowledgeContextBridge) markKnowledgeContextBridgeInjected(knowledgeContextBridge.entries, session.threadId);
    view.attachTurnIdToRun(session, view.activeTurnId);
    await view.plugin.saveSettings();
    return "running";
  } catch (error) {
    const diagnostic = view.diagnoseCodexFailure(error);
    view.running = false;
    view.activeTurnId = "";
    view.clearTurnWatchdog();
    view.finishThinkingMessage(session, "失败");
    view.addMessageToSession(session, {
      role: "system",
      title: diagnostic.title,
      itemType: "error",
      text: diagnostic.text
    });
    view.clearActiveRun();
    new Notice(`Codex 发送失败：${diagnostic.title}`);
    return "failed";
  } finally {
    view.applyStatus();
  }
}

async function startSimpleAgentChatTurn(view: CodexViewTurnContext, session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource, backend: Exclude<AgentBackendKind, "codex-cli">): Promise<"completed" | "failed"> {
  const runId = newId("run");
  view.activeRunId = runId;
  view.activeRunKind = "chat";
  view.activeRunSessionId = session.id;
  const turnAttachments = item.attachments.map((attachment) => ({ ...attachment }));
  const userMessage: ChatMessage = {
    id: newId("msg"),
    role: "user",
    text: item.text || "(附件)",
    runId,
    attachments: turnAttachments,
    images: turnAttachments.filter((attachment) => attachment.type === "image"),
    createdAt: Date.now()
  };
  const assistantMessage: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    title: backend === "hermes" ? "Hermes" : "OpenCode",
    itemType: "assistant",
    status: "running",
    text: backend === "hermes" ? "Hermes 正在处理..." : "OpenCode 正在处理...",
    runId,
    createdAt: Date.now()
  };
  let renderState = createAgentEventRenderState(backend);
  await view.plugin.externalizeMessageText(userMessage, userMessage.text);
  session.messages.push(userMessage, assistantMessage);
  session.updatedAt = Date.now();
  if (session.title === "新会话" && item.text) session.title = item.text.slice(0, 20);
  if (source === "composer") view.clearComposerDraft();
  view.running = true;
  view.turnStartedAt = Date.now();
  view.renderTabs();
  view.renderMessagesIfActive(session);
  view.renderToolbar();
  view.applyStatus();
  try {
    await view.plugin.saveSettings(true);
    const resourceSettings = view.plugin.settings?.resources;
    const catalog = buildEchoInkResourceCatalog({ settings: resourceSettings });
    const resources = prepareAgentResources(catalog, {
      scope: "chat",
      backendCapabilities: getAgentBackendDefinition(backend).capabilities,
      enabledByScope: resourceSettings?.enabledByScope,
      mcpConnections: resourceSettings?.mcpConnections
    });
    const callableMcpTools = await buildCallableMcpToolCatalog({
      resources: catalog,
      scope: "chat",
      enabledByScope: resourceSettings?.enabledByScope,
      connections: resourceSettings?.mcpConnections,
      listTools: async (resource) => await view.plugin.listEchoInkMcpTools(resource.id, 10000)
    });
    const toolBridge = createEchoInkMcpToolBridgeRuntime({
      catalog: callableMcpTools,
      scope: "chat",
      callTool: async (request) => await view.plugin.callEchoInkMcpTool(request)
    });
    const output = await runAgentTaskWithEvents({
      backend,
      settings: view.plugin.settings,
      vaultPath: view.plugin.getVaultPath(),
      title: session.title || "EchoInk Agent Chat",
      prompt: buildSimpleChatPrompt(item.text, item.skill),
      parts: buildAttachmentParts(view.plugin.getVaultPath(), turnAttachments),
      resources,
      toolBridge,
      permission: item.turnOptions.permission,
      timeoutMs: 120000
    }, (event) => {
      renderState = reduceAgentEventForChat(renderState, event);
      applyAgentChatRenderState(assistantMessage, renderState);
      session.updatedAt = Date.now();
      view.renderMessagesIfActive(session);
      view.renderToolbar();
    });
    assistantMessage.status = "completed";
    assistantMessage.itemType = "assistant";
    assistantMessage.text = (renderState.text || output.text).trim() || "Agent 未返回内容。";
    assistantMessage.details = formatAgentEventDetails(renderState);
    await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text);
    await view.plugin.saveSettings(true);
    return "completed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assistantMessage.status = "failed";
    assistantMessage.title = `${backend === "hermes" ? "Hermes" : "OpenCode"} 发送失败`;
    assistantMessage.itemType = "error";
    assistantMessage.text = message;
    await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text).catch(swallowError("externalize failed agent message"));
    await view.plugin.saveSettings(true).catch(swallowError("save failed agent message"));
    new Notice(`${backend === "hermes" ? "Hermes" : "OpenCode"} 发送失败：${message}`);
    return "failed";
  } finally {
    view.running = false;
    view.activeTurnId = "";
    view.clearTurnWatchdog();
    view.clearActiveRun();
    session.updatedAt = Date.now();
    view.renderMessages(messageRenderOptionsForRunUpdate(view));
    view.renderToolbar();
    view.applyStatus();
  }
}

function applyAgentChatRenderState(message: ChatMessage, state: AgentChatRenderState): void {
  message.status = state.status;
  message.itemType = state.itemType;
  message.title = state.title;
  message.text = state.text || message.text;
  if (state.runId) message.runId = state.runId;
  message.details = formatAgentEventDetails(state);
}

function formatAgentEventDetails(state: AgentChatRenderState): string {
  const thinking = state.thinkingBlocks
    .filter((block) => block.text.trim())
    .map((block) => `Thinking: ${block.text.trim()}`);
  const tools = state.toolCalls.map((tool) => {
    const suffix = tool.output ? ` — ${tool.output}` : "";
    return `Tool ${tool.status}: ${tool.name}${suffix}`;
  });
  return [...thinking, ...tools].join("\n");
}

export async function startKnowledgeBaseTurn(view: CodexViewTurnContext, session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<"completed" | "failed"> {
  const manager = view.plugin.getKnowledgeBaseManager();
  if (!manager) {
    new Notice("知识库管理未初始化");
    return "failed";
  }
  if (!item.text && !item.attachments.length) return "failed";
  const runId = newId("kb-run");
  view.activeRunId = runId;
  view.activeRunKind = "knowledge-base";
  view.activeRunSessionId = session.id;
  const turnAttachments = item.attachments.map((attachment) => ({ ...attachment }));
  const userMessage: ChatMessage = {
    id: newId("msg"),
    role: "user",
    text: item.text || "(附件)",
    runId,
    attachments: turnAttachments,
    images: turnAttachments.filter((attachment) => attachment.type === "image"),
    createdAt: Date.now()
  };
  await view.plugin.externalizeMessageText(userMessage, userMessage.text);
  const command = parseKnowledgeBaseCommand(item.text, turnAttachments.length);
  const runMode = knowledgeBaseRunModeForCommandIntent(command.intent);
  const assistantMessage: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    title: "知识库管理",
    itemType: "knowledgeBase",
    status: "running",
    text: "正在识别命令并执行...",
    runId,
    ...(runMode ? { knowledgeBaseUi: buildKnowledgeBaseRunPayload(runMode) } : {}),
    createdAt: Date.now()
  };
  session.messages.push(userMessage, assistantMessage);
  session.title = "知识库管理";
  session.updatedAt = Date.now();
  if (source === "composer") view.clearComposerDraft();
  view.running = true;
  view.renderTabs();
  view.renderMessagesIfActive(session);
  view.renderToolbar();
  let succeeded = false;
  let turnError: unknown = null;
  try {
    await view.plugin.saveSettings(true);
    const result = await manager.handleUserMessage(item.text, turnAttachments, knowledgeBaseTurnOverrides(item.turnOptions));
    succeeded = result.status === "success";
    assistantMessage.status = knowledgeBaseMessageStatusFromResult(result.status);
    assistantMessage.text = result.message;
    assistantMessage.citations = result.citations;
    if (result.ui) assistantMessage.knowledgeBaseUi = result.ui;
    else delete assistantMessage.knowledgeBaseUi;
    if (result.status === "success" && appendKnowledgeContextBridge(session, item.text, turnAttachments.length, assistantMessage, result.citations)) {
      assistantMessage.details = knowledgeContextBridgeDetailText(result.citations);
    }
    if (result.status === "failed") {
      view.finishThinkingMessage(session, "失败");
      view.finishRunningProcessMessages(session, "error");
      view.finishPlanMessage(session);
    } else if (result.status === "canceled") {
      view.finishThinkingMessage(session, "已取消");
      view.finishRunningProcessMessages(session, "interrupted");
      view.finishPlanMessage(session);
    }
    view.moveMessageToEnd(session, assistantMessage.id);
    if (result.followUpCommand) {
      if (session.id === view.plugin.settings.activeSessionId) view.fillKnowledgeBaseCommand(result.followUpCommand);
    }
    if (result.status === "failed") new Notice(`知识库管理失败：${result.message}`);
    if (result.status === "canceled") new Notice("知识库管理已取消");
  } catch (error) {
    turnError = error;
    assistantMessage.status = "failed";
    delete assistantMessage.knowledgeBaseUi;
    assistantMessage.text = appendSettlementFailure(assistantMessage.text, error);
  } finally {
    view.running = false;
    session.updatedAt = Date.now();
    view.clearTurnWatchdog();
    view.clearActiveRun();
    try {
      await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text);
      await view.plugin.saveSettings(true);
      await view.plugin.archivePendingKnowledgeBaseThreads().catch((error) => console.warn("Codex knowledge thread archive failed", error));
    } catch (error) {
      turnError = turnError ?? error;
      assistantMessage.status = "failed";
      assistantMessage.text = appendSettlementFailure(assistantMessage.text, error);
      await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text).catch(swallowError("externalize failed settlement message"));
      await view.plugin.saveSettings(true).catch(swallowError("save failed settlement message"));
    }
    view.renderMessages(messageRenderOptionsForRunUpdate(view));
    view.renderToolbar();
    view.applyStatus();
    void view.refreshKnowledgeDashboard(true);
  }
  if (turnError) throw turnError;
  return succeeded ? "completed" : "failed";
}

export async function runKnowledgeBaseShortcut(view: CodexViewTurnContext, label: string, runner: () => Promise<string>): Promise<void> {
  const session = view.ensureSession();
  if (!view.isKnowledgeBaseSession(session)) {
    await view.plugin.activateKnowledgeBaseChannel();
  }
  const active = view.ensureSession();
  const userMessage: ChatMessage = {
    id: newId("msg"),
    role: "user",
    text: label,
    createdAt: Date.now()
  };
  const assistantMessage: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    title: "知识库管理",
    itemType: "knowledgeBase",
    status: "running",
    text: "正在执行...",
    createdAt: Date.now()
  };
  active.messages.push(userMessage, assistantMessage);
  active.updatedAt = Date.now();
  view.running = true;
  view.renderTabs();
  view.renderMessages({ forceBottom: true });
  view.renderToolbar();
  await view.plugin.saveSettings(true);
  try {
    const message = await runner();
    assistantMessage.status = "completed";
    assistantMessage.text = message;
    new Notice(label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assistantMessage.status = "failed";
    assistantMessage.text = message;
    new Notice(`知识库管理失败：${message}`);
  } finally {
    view.running = false;
    active.updatedAt = Date.now();
    await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text);
    await view.plugin.saveSettings(true);
    await view.plugin.archivePendingKnowledgeBaseThreads().catch((error) => console.warn("Codex knowledge thread archive failed", error));
    view.renderMessages(messageRenderOptionsForRunUpdate(view));
    view.renderToolbar();
    view.applyStatus();
    void view.refreshKnowledgeDashboard(true);
  }
}

function appendSettlementFailure(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const note = `任务收口失败：${message}`;
  return text.trim() ? `${text}\n\n${note}` : note;
}

function knowledgeBaseMessageStatusFromResult(status: "success" | "failed" | "canceled"): string {
  if (status === "success") return "completed";
  if (status === "canceled") return "canceled";
  return "failed";
}

function isLocalKnowledgeBaseCommand(intent: string): boolean {
  return intent === "clear" || intent === "history";
}

function knowledgeBaseTurnOverrides(turnOptions: QueuedTurnItem["turnOptions"]) {
  return {
    model: turnOptions.model,
    reasoning: turnOptions.reasoning,
    serviceTier: turnOptions.serviceTier,
    mcpEnabled: turnOptions.mcpEnabled,
    workspaceResources: turnOptions.workspaceResources,
    hermesTaskTimeoutMs: 120000
  };
}

function resolveChatBackend(view: CodexViewTurnContext): AgentBackendKind {
  const settings = view.plugin?.settings;
  if (!settings) return "codex-cli";
  const choice = settings.capabilities?.chatBackend ?? "default";
  return choice === "default" ? settings.agentBackend ?? "codex-cli" : choice;
}

function buildSimpleChatPrompt(text: string, skill: QueuedTurnItem["skill"]): string {
  return [
    skill ? `本轮启用 Skill：/${skill.name}\n${skill.description || skill.contentPath || ""}` : "",
    text || "请根据附件继续。"
  ].filter(Boolean).join("\n\n");
}

function buildCodexChatStyleInstruction(resources: ReturnType<typeof prepareAgentResources>): string {
  return [
    resources.promptPrefix,
    resources.warnings.length ? `资源提示：\n${resources.warnings.map((item) => `- ${item}`).join("\n")}` : "",
    DEFAULT_REPLY_STYLE_INSTRUCTION
  ].filter(Boolean).join("\n\n");
}

function buildAttachmentParts(vaultPath: string, attachments: StoredAttachment[]): AgentPromptPart[] {
  return attachments.map((attachment): AgentPromptPart => {
    const absolutePath = path.isAbsolute(attachment.path) ? attachment.path : path.join(vaultPath, attachment.path);
    return {
      type: "file",
      path: absolutePath,
      filename: attachment.name || path.basename(attachment.path),
      mime: mimeForAttachment(attachment)
    };
  });
}

function mimeForAttachment(attachment: StoredAttachment): string {
  const ext = path.extname(attachment.path || attachment.name).toLowerCase();
  if (attachment.type === "image") {
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    return "image/png";
  }
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  return "text/plain";
}
