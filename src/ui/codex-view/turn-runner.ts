import { Notice } from "obsidian";
import type { ChatMessage, StoredAttachment, StoredSession } from "../../settings/settings";
import { newId } from "../../settings/settings";
import { buildUserInput } from "../../core/mapping";
import { composerPrimaryActionForState } from "../composer-state";
import { canStartQueuedTurn, type QueuedTurnItem } from "../turn-queue";
import { parseKnowledgeBaseCommand } from "../../knowledge-base/commands";
import { appendKnowledgeContextBridge, buildKnowledgeContextBridgeForThread, knowledgeContextBridgeDetailText, markKnowledgeContextBridgeInjected } from "./knowledge-context-bridge";

export async function sendMessage(view: any): Promise<void> {
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

export async function enqueueComposerDraft(view: any): Promise<void> {
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

export async function resumeQueuedTurns(view: any, sessionId: string): Promise<void> {
  view.turnQueue.resumeSessionQueue(sessionId);
  view.renderQueue();
  view.renderToolbar();
  await view.startNextQueuedTurn(sessionId);
}

export async function afterTurnSettled(view: any, sessionId: string, succeeded: boolean): Promise<void> {
  const settlement = view.turnQueue.settleSessionQueue(sessionId, succeeded);
  if (settlement === "continue") {
    await view.startNextQueuedTurn(sessionId);
  }
  view.renderQueue();
  view.renderToolbar();
}

export async function startNextQueuedTurn(view: any, sessionId: string): Promise<void> {
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

export async function createQueuedTurnFromComposer(view: any, options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> {
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

export async function startQueuedTurnItem(view: any, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> {
  const session = view.sessionById(item.sessionId);
  if (!session) {
    new Notice("队列所属会话已不存在");
    return "failed";
  }
  if (item.kind === "knowledge-base") return await view.startKnowledgeBaseTurn(session, item, source);
  return await view.startChatTurn(session, item, source);
}

export async function startQueuedTurnItemSafely(view: any, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> {
  try {
    return await view.startQueuedTurnItem(item, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`任务收口失败：${message}`);
    return "failed";
  }
}

export async function startChatTurn(view: any, session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "failed"> {
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
    const input = buildUserInput(item.text, turnAttachments, item.skill);
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

export async function startKnowledgeBaseTurn(view: any, session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"completed" | "failed"> {
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
  const assistantMessage: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    title: "知识库管理",
    itemType: "knowledgeBase",
    status: "running",
    text: "正在识别命令并执行...",
    runId,
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
      await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text).catch(() => undefined);
      await view.plugin.saveSettings(true).catch(() => undefined);
    }
    view.renderMessages({ forceBottom: true });
    view.renderToolbar();
    view.applyStatus();
    void view.refreshKnowledgeDashboard(true);
  }
  if (turnError) throw turnError;
  return succeeded ? "completed" : "failed";
}

export async function runKnowledgeBaseShortcut(view: any, label: string, runner: () => Promise<string>): Promise<void> {
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
    view.renderMessages({ forceBottom: true });
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
    workspaceResources: turnOptions.workspaceResources
  };
}
