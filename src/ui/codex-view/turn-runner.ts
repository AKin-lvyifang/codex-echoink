import { Notice } from "obsidian";
import * as path from "path";
import { getAgentBackendDefinition } from "../../agent/registry";
import { createEchoInkMcpToolBridgeRuntime } from "../../agent/tool-bridge";
import type { AgentBackendKind, AgentFilePart } from "../../agent/types";
import type { AgentAdapter, AgentRunResult } from "../../harness/agents/adapter";
import { createHarnessAgentAdapter } from "../../harness/agents/adapter-factory";
import {
  harnessBackendAdapterVersion,
  harnessBackendDisplayName,
  harnessBackendUsesNativeThreadPrewarm,
  harnessInitialMessageModelId,
  harnessMessageProfileId,
  harnessProviderModelId,
  harnessTaskAgent,
  harnessTaskModel,
  harnessTaskProfile
} from "../../harness/agents/backend-runtime-profile";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { HarnessRunResult } from "../../harness/contracts/run";
import { sessionBackendBinding, updateSessionBackendBinding } from "../../harness/kernel/session-service";
import { buildCallableMcpToolCatalog } from "../../resources/mcp-tool-catalog";
import { buildEchoInkResourceCatalog, prepareAgentResources, resourceSelectionFromPreparedResources } from "../../resources/registry";
import type { ChatMessage, StoredAttachment, StoredSession } from "../../settings/settings";
import { newId } from "../../settings/settings";
import { buildUserInput, DEFAULT_REPLY_STYLE_INSTRUCTION } from "../../core/mapping";
import { composerPrimaryActionForState } from "../composer-state";
import { canStartQueuedTurn, type QueuedTurnItem } from "../turn-queue";
import { knowledgeBaseHelpText, parseKnowledgeBaseCommand, type KnowledgeBaseCommandIntent } from "../../knowledge-base/commands";
import { buildKnowledgeBaseRunPayload, knowledgeBaseRunModeForCommandIntent } from "../../knowledge-base/maintain-report-card";
import { persistAndSettleChatRun } from "./turn-lifecycle";
import {
  HarnessEventProjector,
  applyHarnessProjectionBatch,
  type HarnessProjectionBatch,
  type HarnessProjectionSettlement
} from "./harness-event-projector";
import type { CodexViewTurnContext, MessageRenderFollowContext, QueuedTurnOutcome, QueuedTurnSource } from "./runner-context";

const INLINE_AGENT_PROCESS_SAVE_DELAY_MS = 750;
const inlineAgentProcessSaveTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

export async function sendMessage(view: CodexViewTurnContext): Promise<void> {
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
    const cancellation =
      await view.plugin.getKnowledgeBaseManager()?.cancelMaintenance();
    if (cancellation?.accepted) {
      view.pauseQueueForSession(session.id);
    }
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
  const knowledgeManager = view.plugin.getKnowledgeBaseManager();
  if (
    !view.running
    && !knowledgeManager?.isRunning
    && knowledgeManager?.maintenanceRecoveryStatus.state !== "pending"
    && knowledgeManager?.maintenanceRecoveryStatus.state !== "blocked"
    && !view.turnQueue.isSessionQueuePaused(item.sessionId)
  ) {
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
  await view.plugin.enforceNativeSessionLeaseLimits?.().catch((error: unknown) => {
    console.warn("EchoInk native lease cleanup failed", error);
  });
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

export function selectFirstNonBlankText(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

export function shouldDismissThinkingForHarnessEvent(event: HarnessEvent): boolean {
  if (event.type.startsWith("tool.") || event.type.startsWith("file.change.")) return true;
  const hasVisibleText = typeof event.text === "string" && Boolean(event.text.trim());
  if (event.type === "agent.message.delta" || event.type === "agent.message.completed" || event.type === "agent.plan.updated") {
    return hasVisibleText;
  }
  if (event.type === "agent.thinking.delta"
    || event.type === "agent.thinking.completed"
    || event.type === "agent.reasoning.started"
    || event.type === "agent.reasoning.summary.delta"
    || event.type === "agent.reasoning.summary.completed") {
    return hasVisibleText && (!event.data?.visibility || event.data.visibility === "public");
  }
  return false;
}

export async function startNextQueuedTurn(view: CodexViewTurnContext, sessionId: string): Promise<void> {
  const knowledgeManager = view.plugin.getKnowledgeBaseManager();
  const maintenanceRecoveryBlocked = knowledgeManager?.maintenanceRecoveryStatus.state === "pending"
    || knowledgeManager?.maintenanceRecoveryStatus.state === "blocked";
  if (!canStartQueuedTurn({
    queueStartInProgress: view.queueStartInProgress,
    viewRunning: view.running,
    knowledgeTaskRunning: Boolean(knowledgeManager?.isRunning || maintenanceRecoveryBlocked)
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
  let outcome: QueuedTurnOutcome = "failed";
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
    if (knowledgeCommand.intent === "history") {
      view.clearComposerDraft();
      await view.openKnowledgeBaseHistory(session);
      return null;
    }
    if (knowledgeCommand.intent === "help") {
      await appendLocalKnowledgeBaseHelp(view, session, text || "/help");
      return null;
    }
  }
  const recovery = knowledgeSession
    ? view.plugin.getKnowledgeBaseManager()?.maintenanceRecoveryStatus
    : undefined;
  if (knowledgeSession && knowledgeCommand && recovery && recovery.state !== "ready") {
    new Notice(recovery.message);
    return null;
  }
  if (knowledgeSession && knowledgeCommand?.intent === "clear") {
    if (!options.allowLocalKnowledgeCommands) {
      new Notice("本地命令不能排队；当前任务结束后再操作");
      return null;
    }
    await view.clearKnowledgeBasePage(session);
    return null;
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
  const runId = newId("run");
  const provenance = messageProvenanceForTurn(view, backend, item.turnOptions.model);
  view.activeRunId = runId;
  view.activeRunKind = "chat";
  view.activeRunSessionId = session.id;
  const turnAttachments = item.attachments.map((attachment) => ({ ...attachment }));
  const userMessage: ChatMessage = {
    id: newId("msg"),
    role: "user",
    text: item.text || "(附件)",
    ...provenance,
    runId,
    attachments: turnAttachments,
    images: turnAttachments.filter((attachment) => attachment.type === "image"),
    createdAt: Date.now()
  };
  const assistantMessage: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "",
    ...provenance,
    runId,
    createdAt: Date.now()
  };
  const projector = new HarnessEventProjector({
    runId,
    backendId: backend,
    vaultPath: view.plugin.getVaultPath(),
    answerMessage: assistantMessage
  });
  let keepRunOpen = false;
  session.messages.push(userMessage, assistantMessage);
  try {
    await prepareChatBackendConnection(view, backend);
    await view.plugin.externalizeMessageText(userMessage, userMessage.text);
    session.updatedAt = Date.now();
    if (session.title === "新会话" && item.text) session.title = item.text.slice(0, 20);
    if (source === "composer") view.clearComposerDraft();
    view.running = true;
    view.turnStartedAt = Date.now();
    view.renderTabs();
    view.renderMessagesIfActive(session);
    view.renderToolbar();
    view.applyStatus();
    view.ensureThinkingMessage(session, "初始化", "正在初始化 EchoInk 运行...");
    view.armTurnWatchdog();
    if (harnessBackendUsesNativeThreadPrewarm(backend)
      && !codexNativeThreadIdForSession(session)
      && view.threadPrewarmPromise
      && view.threadPrewarmSessionId === session.id) {
      const warmed = await view.threadPrewarmPromise.catch(() => false);
      if (!warmed && !codexNativeThreadIdForSession(session)) throw new Error("新会话连接超时，请重试");
    }
    await view.plugin.saveSettings(true);
    const { adapter, resources } = await createChatAgentAdapter(view, session, item, turnAttachments, backend);
    const output = await view.plugin.runHarnessWithAdapter({
      adapter,
      sessionProvider: () => session,
      request: buildChatHarnessRequest(view, session, item, runId, turnAttachments, backend, resources),
      sink: (event: HarnessEvent) => {
        updateEchoInkThinkingLifecycle(view, session, event);
        const batch = projector.project(event);
        if (batch.updates.length) {
          applyProjectedChatBatch(view, session, assistantMessage.id, batch);
          scheduleInlineAgentProcessPersistence(view);
        }
        view.renderToolbar();
      }
    });
    if (output.backendBinding) updateSessionBackendBinding(session, output.backendBinding);
    applyHarnessRunProvenance(userMessage, output);
    applyHarnessRunProvenance(assistantMessage, output);
    if (output.status === "running" && typeof adapter.awaitResult === "function") {
      keepRunOpen = true;
      await view.plugin.saveSettings(true);
      void settleRunningChatTurn({
        view,
        adapter,
        session,
        runId,
        backend,
        assistantMessage,
        projector
      }).catch((error) => {
        void recoverRunningChatSettlementFailure({
          view,
          session,
          runId,
          backend,
          assistantMessage,
          projector,
          error
        });
      });
      return "running";
    }
    if (output.status === "running") {
      keepRunOpen = true;
      await view.plugin.saveSettings(true);
      return "running";
    }
    applyHarnessRunProvenance(assistantMessage, output);
    applyProjectedChatSettlement(view, session, assistantMessage, projector, {
      status: output.status === "completed" ? "completed" : output.status === "cancelled" ? "cancelled" : "failed",
      text: output.outputText,
      error: output.error,
      createdAt: Date.now()
    });
    const completed = output.status === "completed";
    const cancelled = output.status === "cancelled";
    if (completed) delete assistantMessage.title;
    else assistantMessage.title = cancelled ? "已中断" : "回复失败";
    assistantMessage.text = selectFirstNonBlankText(assistantMessage.text, output.outputText, output.error) || "Agent 未返回内容。";
    assistantMessage.completedAt = Date.now();
    view.finishThinkingMessage(session, cancelled ? "中断" : completed ? "完成" : "失败");
    view.finishRunningProcessMessages(session, completed ? "completed" : "interrupted");
    view.finishPlanMessage(session);
    await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text);
    cancelInlineAgentProcessPersistence(view);
    await view.plugin.saveSettings(true);
    return completed ? "completed" : cancelled ? "cancelled" : "failed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    applyProjectedChatSettlement(view, session, assistantMessage, projector, {
      status: "failed",
      error: message,
      createdAt: Date.now()
    });
    assistantMessage.title = "回复失败";
    assistantMessage.completedAt = Date.now();
    applyMessageProvenance(assistantMessage, provenance);
    view.finishThinkingMessage(session, "失败");
    view.finishRunningProcessMessages(session, "interrupted");
    view.finishPlanMessage(session);
    await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text).catch(() => undefined);
    cancelInlineAgentProcessPersistence(view);
    new Notice(`${agentChatTitle(backend)} 发送失败：${message}`);
    await view.plugin.saveSettings(true).catch(() => undefined);
    await view.plugin.settleHarnessRunTerminal({
      runId,
      status: "failed",
      backendId: backend,
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    return "failed";
  } finally {
    if (!keepRunOpen) {
      view.running = false;
      view.activeTurnId = "";
      view.clearTurnWatchdog();
      view.clearActiveRun();
      session.updatedAt = Date.now();
      view.renderMessages(messageRenderOptionsForRunUpdate(view));
      view.renderToolbar();
    }
    view.applyStatus();
  }
}

async function recoverRunningChatSettlementFailure(input: {
  view: CodexViewTurnContext;
  session: StoredSession;
  runId: string;
  backend: AgentBackendKind;
  assistantMessage: ChatMessage;
  projector: HarnessEventProjector;
  error: unknown;
}): Promise<void> {
  const { view, session, runId, backend, assistantMessage, projector } = input;
  const completed = assistantMessage.status === "completed";
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (!completed) {
    applyProjectedChatSettlement(view, session, assistantMessage, projector, {
      status: "failed",
      error: message || "Agent 收口失败",
      createdAt: Date.now()
    });
    assistantMessage.title = "回复失败";
    assistantMessage.completedAt = Date.now();
    view.finishThinkingMessage?.(session, "失败");
    await view.plugin.externalizeMessageText?.(assistantMessage, assistantMessage.text).catch(() => undefined);
    await persistAndSettleChatRun(view.plugin, {
      runId,
      status: "failed",
      backendId: backend,
      error: assistantMessage.text
    }).catch(() => undefined);
  }
  cancelInlineAgentProcessPersistence(view);
  session.updatedAt = Date.now();
  view.running = false;
  view.activeTurnId = "";
  view.clearTurnWatchdog?.();
  if (view.activeRunId === runId) view.clearActiveRun?.();
  view.renderMessagesIfActive?.(session);
  view.renderToolbar?.();
  view.applyStatus?.();
  await view.plugin.saveSettings?.(true).catch(() => undefined);
  await view.afterTurnSettled?.(session.id, completed).catch(() => undefined);
}

async function settleRunningChatTurn(input: {
  view: CodexViewTurnContext;
  adapter: AgentAdapter;
  session: StoredSession;
  runId: string;
  backend: AgentBackendKind;
  assistantMessage: ChatMessage;
  projector: HarnessEventProjector;
}): Promise<void> {
  const { view, adapter, session, runId, backend, projector } = input;
  let result: AgentRunResult;
  try {
    result = await adapter.awaitResult?.(runId) ?? { status: "failed", error: "Agent 不支持异步结果收口" };
  } catch (error) {
    result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const assistantMessage = input.assistantMessage;

  const externallyCleared = view.activeRunId !== runId;
  const completed = result.status === "completed";
  const cancelled = result.status === "cancelled";
  applyProjectedChatSettlement(view, session, assistantMessage, projector, {
    status: completed ? "completed" : cancelled ? "cancelled" : "failed",
    text: result.outputText,
    error: result.error,
    createdAt: Date.now()
  });
  if (completed) delete assistantMessage.title;
  else assistantMessage.title = cancelled ? "已中断" : "回复失败";
  assistantMessage.text = selectFirstNonBlankText(
    assistantMessage.text,
    result.outputText,
    result.error,
    cancelled ? "本轮对话已中断。" : ""
  ) || "Agent 未返回内容。";
  assistantMessage.completedAt = Date.now();
  view.finishThinkingMessage?.(session, cancelled ? "中断" : completed ? "完成" : "失败");
  view.finishRunningProcessMessages?.(session, completed ? "completed" : "interrupted");
  view.finishPlanMessage?.(session);
  await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text).catch(() => undefined);
  cancelInlineAgentProcessPersistence(view);
  session.updatedAt = Date.now();
  view.running = false;
  view.activeTurnId = "";
  view.clearTurnWatchdog?.();
  if (!externallyCleared) view.clearActiveRun?.();
  view.renderMessages?.(messageRenderOptionsForRunUpdate(view));
  view.renderMessagesIfActive?.(session);
  view.renderToolbar?.();
  view.applyStatus?.();

  if (!externallyCleared || !cancelled) {
    const terminalStatus: "cancelled" | "failed" = cancelled ? "cancelled" : "failed";
    const terminalInput = completed
      ? { runId, status: "completed" as const, backendId: backend, text: assistantMessage.text }
      : { runId, status: terminalStatus, backendId: backend, error: assistantMessage.text };
    await persistAndSettleChatRun(view.plugin, terminalInput).catch(() => undefined);
  }
  if (typeof view.afterTurnSettled === "function") {
    setTimeout(() => {
      void view.afterTurnSettled(session.id, completed);
    }, 0);
  }
}

async function createChatAgentAdapter(
  view: CodexViewTurnContext,
  session: StoredSession,
  item: QueuedTurnItem,
  turnAttachments: StoredAttachment[],
  backend: AgentBackendKind
): Promise<{ adapter: AgentAdapter; resources: ReturnType<typeof prepareAgentResources> }> {
  const resourceSettings = view.plugin.settings?.resources;
  const catalog = typeof view.plugin.buildRuntimeEchoInkResourceCatalog === "function"
    ? await view.plugin.buildRuntimeEchoInkResourceCatalog()
    : buildEchoInkResourceCatalog({ settings: resourceSettings });
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
    listTools: async (resource) => typeof view.plugin.listEchoInkMcpTools === "function"
      ? await view.plugin.listEchoInkMcpTools(resource.id, 10000)
      : []
  });
  const toolBridge = createEchoInkMcpToolBridgeRuntime({
    catalog: callableMcpTools,
    scope: "chat",
    callTool: async (request) => {
      if (typeof view.plugin.callEchoInkMcpTool !== "function") throw new Error("EchoInk MCP Tool Gateway unavailable.");
      return await view.plugin.callEchoInkMcpTool(request);
    }
  });
  return {
    resources,
    adapter: createHarnessAgentAdapter({
      backendId: backend,
      settings: view.plugin.settings,
      vaultPath: view.plugin.getVaultPath(),
      nativeRefContext: view.plugin.getNativeExecutionRefContext?.(backend),
      displayName: agentChatTitle(backend),
      version: harnessBackendAdapterVersion(backend),
      createCodexRichAdapter: (options) => view.plugin.createCodexRichAgentAdapter(options),
      codexRich: {
        turnOptions: item.turnOptions,
        getNativeThreadId: () => codexNativeThreadIdForSession(session),
        setNativeThreadId: (threadId: string) => {
          setCodexNativeThreadIdForSession(session, threadId);
        },
        buildInput: () => buildUserInput(item.text, turnAttachments, item.skill, buildCodexChatStyleInstruction(resources)),
        onTurnStarted: ({ turnId }: { turnId: string }) => {
          view.activeTurnId = turnId;
          view.attachTurnIdToRun(session, turnId);
        },
        nativeRefContext: view.plugin.getNativeExecutionRefContext?.("codex-cli")
      },
      task: {
        resources,
        toolBridge,
        timeoutMs: 120000,
        tools: {
          read: true,
          write: item.turnOptions.permission !== "read-only",
          edit: item.turnOptions.permission !== "read-only",
          bash: false
        },
        model: harnessTaskModel(view.plugin.settings, backend),
        agent: harnessTaskAgent(view.plugin.settings, backend),
        profile: harnessTaskProfile(view.plugin.settings, backend)
      }
    })
  };
}

function buildChatHarnessRequest(
  view: CodexViewTurnContext,
  session: StoredSession,
  item: QueuedTurnItem,
  runId: string,
  turnAttachments: StoredAttachment[],
  backend: AgentBackendKind,
  resources: ReturnType<typeof prepareAgentResources>
) {
  return {
    runId,
    sessionId: session.id,
    surface: "chat" as const,
    workflow: "chat.generic" as const,
    backendId: backend,
    workspace: {
      vaultPath: view.plugin.getVaultPath(),
      cwd: session.cwd || view.plugin.getVaultPath()
    },
    input: {
      text: chatTurnInstruction(item),
      attachments: buildHarnessAttachments(view.plugin.getVaultPath(), turnAttachments)
    },
    permissions: {
      mode: item.turnOptions.permission ?? "workspace-write",
      writableRoots: [],
      requireApproval: true
    },
    resourceSelection: {
      ...resourceSelectionFromPreparedResources(resources, backend)
    },
    memoryPolicy: {
      enabled: true,
      maxItems: 8
    },
    outputContract: {
      kind: "plain-text" as const
    }
  };
}

function chatTurnInstruction(item: QueuedTurnItem): string {
  return [
    item.skill ? `本轮启用 Skill：/${item.skill.name}\n${item.skill.description || item.skill.contentPath || ""}` : "",
    item.text || "请根据附件继续。"
  ].filter(Boolean).join("\n\n");
}

async function prepareChatBackendConnection(view: CodexViewTurnContext, backend: AgentBackendKind): Promise<void> {
  if (typeof view.plugin.ensureHarnessBackendConnected === "function") {
    await view.plugin.ensureHarnessBackendConnected(backend);
    view.applyStatus();
  }
}

function agentChatTitle(backend: AgentBackendKind): string {
  return harnessBackendDisplayName(backend);
}

function updateEchoInkThinkingLifecycle(view: CodexViewTurnContext, session: StoredSession, event: HarnessEvent): void {
  if (event.type === "agent.connecting") {
    view.ensureThinkingMessage(session, "初始化", "正在连接 Agent 后端...");
    return;
  }
  if (event.type === "agent.connected" || event.type === "session.context.bootstrap.compiled") {
    view.ensureThinkingMessage(session, "初始化", "正在准备运行上下文...");
    return;
  }
  if (event.type === "run.started") {
    view.ensureThinkingMessage(session, "思考中", "正在等待模型响应...");
    return;
  }
  if (shouldDismissThinkingForHarnessEvent(event)) view.dismissThinkingMessage?.(session);
}

function codexNativeThreadIdForSession(session: StoredSession): string | undefined {
  return sessionBackendBinding(session, "codex-cli")?.nativeThreadId || session.threadId;
}

function setCodexNativeThreadIdForSession(session: StoredSession, threadId: string): void {
  const now = Date.now();
  updateSessionBackendBinding(session, {
    backendId: "codex-cli",
    nativeThreadId: threadId,
    nativeExecutionKind: "thread",
    syncedSessionRevision: session.revision ?? 1,
    lastUsedAt: now
  });
}

function scheduleInlineAgentProcessPersistence(view: object & { plugin?: { saveSettings?: (immediate?: boolean) => Promise<unknown> } }): void {
  if (inlineAgentProcessSaveTimers.has(view) || typeof view.plugin?.saveSettings !== "function") return;
  const timer = setTimeout(() => {
    inlineAgentProcessSaveTimers.delete(view);
    void view.plugin?.saveSettings?.(true).catch(() => undefined);
  }, INLINE_AGENT_PROCESS_SAVE_DELAY_MS);
  inlineAgentProcessSaveTimers.set(view, timer);
}

function cancelInlineAgentProcessPersistence(view: object): void {
  const timer = inlineAgentProcessSaveTimers.get(view);
  if (!timer) return;
  clearTimeout(timer);
  inlineAgentProcessSaveTimers.delete(view);
}

function applyProjectedChatBatch(
  view: CodexViewTurnContext,
  session: StoredSession,
  answerMessageId: string,
  batch: HarnessProjectionBatch
): ChatMessage[] {
  const applied = applyHarnessProjectionBatch(session.messages, batch, answerMessageId);
  if (!applied.length) return applied;
  session.updatedAt = Date.now();
  for (const message of applied) renderProjectedChatMessage(view, session, message);
  return applied;
}

function applyProjectedChatSettlement(
  view: CodexViewTurnContext,
  session: StoredSession,
  assistantMessage: ChatMessage,
  projector: HarnessEventProjector,
  settlement: HarnessProjectionSettlement
): void {
  applyProjectedChatBatch(view, session, assistantMessage.id, projector.settle(settlement));
}

function renderProjectedChatMessage(view: CodexViewTurnContext, session: StoredSession, message: ChatMessage): void {
  view.renderMessagesIfActive(session, message);
}

export async function startKnowledgeBaseTurn(view: CodexViewTurnContext, session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<"completed" | "failed"> {
  const manager = view.plugin.getKnowledgeBaseManager();
  if (!manager) {
    new Notice("知识库管理未初始化");
    return "failed";
  }
  if (!item.text && !item.attachments.length) return "failed";
  const runId = newId("kb-run");
  const turnAttachments = item.attachments.map((attachment) => ({ ...attachment }));
  const command = parseKnowledgeBaseCommand(item.text, turnAttachments.length);
  const runMode = knowledgeBaseRunModeForCommandIntent(command.intent);
  // Maintenance snapshots the selected Agent when it actually starts. A
  // queued item may have been created under another backend, so its model and
  // provider-specific options must not be paired with the new selected Agent.
  const executionTurnOptions = runMode
    ? (typeof view.currentTurnOptions === "function" ? view.currentTurnOptions(session) : item.turnOptions)
    : item.turnOptions;
  const backend = resolveKnowledgeBackendForCommand(view, command.intent);
  const provenance = messageProvenanceForTurn(view, backend, executionTurnOptions.model);
  view.activeRunId = runId;
  view.activeRunKind = "knowledge-base";
  view.activeRunSessionId = session.id;
  const userMessage: ChatMessage = {
    id: newId("msg"),
    role: "user",
    text: item.text || "(附件)",
    ...provenance,
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
    ...provenance,
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
    const result = await manager.handleUserMessage(
      item.text,
      turnAttachments,
      knowledgeBaseTurnOverrides(executionTurnOptions, session, runId)
    );
    succeeded = result.status === "success";
    const workflowRunId = result.workflowRunId?.trim() ?? "";
    const hasExplicitMaintenanceWinner = Object.prototype.hasOwnProperty.call(
      result,
      "maintenanceWinnerBackend"
    );
    if (!hasExplicitMaintenanceWinner && result.maintenanceBackend) {
      const actualProvenance = messageProvenanceForTurn(
        view,
        result.maintenanceBackend,
        result.maintenanceBackend === backend ? executionTurnOptions.model : undefined
      );
      replaceMessageProvenance(userMessage, actualProvenance);
      replaceMessageProvenance(assistantMessage, actualProvenance);
    }
    if (result.harnessResult) {
      if (result.harnessResult.backendBinding) updateSessionBackendBinding(session, result.harnessResult.backendBinding);
      applyHarnessRunProvenance(userMessage, result.harnessResult);
      applyHarnessRunProvenance(assistantMessage, result.harnessResult);
      if (result.harnessResult.nativeExecution) {
        assistantMessage.nativeLocalCommitStatus = "pending";
        assistantMessage.nativeCleanupStatus = "pending";
      }
    }
    if (hasExplicitMaintenanceWinner) {
      const winner = result.maintenanceWinnerBackend;
      const actualProvenance = winner
        ? {
          ...messageProvenanceForTurn(
            view,
            winner,
            winner === backend ? executionTurnOptions.model : undefined
          ),
          ...(result.harnessResult?.effectiveModel
            ? {
              modelId: harnessProviderModelId(
                result.harnessResult.effectiveModel.providerId,
                result.harnessResult.effectiveModel.modelId
              )
            }
            : {})
        }
        : null;
      replaceMaintenanceRunProvenance(
        session,
        [runId, workflowRunId],
        [userMessage, assistantMessage],
        actualProvenance
      );
    }
    if (workflowRunId) {
      userMessage.runId = workflowRunId;
      assistantMessage.runId = workflowRunId;
    }
    assistantMessage.status = result.maintenanceRecoveryState
      ? `recovery-${result.maintenanceRecoveryState}`
      : knowledgeBaseMessageStatusFromResult(result.status);
    assistantMessage.text = result.message;
    assistantMessage.citations = result.citations;
    if (result.ui) assistantMessage.knowledgeBaseUi = result.ui;
    else delete assistantMessage.knowledgeBaseUi;
    if (result.status === "failed") {
      const recoveryProjectionStatus = result.maintenanceRecoveryState
        ? `recovery-${result.maintenanceRecoveryState}`
        : "";
      view.finishThinkingMessage(session, recoveryProjectionStatus || "失败");
      view.finishRunningProcessMessages(
        session,
        recoveryProjectionStatus || "error"
      );
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
    if (result.status === "failed") {
      new Notice(result.maintenanceRecoveryState
        ? result.message
        : `知识库管理失败：${result.message}`);
    }
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
      await persistAndSettleKnowledgeRun(view, assistantMessage, manager);
    } catch (error) {
      turnError = turnError ?? error;
      if (
        assistantMessage.status !== "recovery-pending"
        && assistantMessage.status !== "recovery-blocked"
      ) {
        assistantMessage.status = "failed";
      }
      assistantMessage.text = appendSettlementFailure(assistantMessage.text, error);
      await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text).catch(() => undefined);
      await view.plugin.saveSettings(true).catch(() => undefined);
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
    await persistAndSettleKnowledgeRun(view, assistantMessage, view.plugin.getKnowledgeBaseManager());
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

async function persistAndSettleKnowledgeRun(
  view: CodexViewTurnContext,
  assistantMessage: ChatMessage,
  manager: { getLastNativeLifecycleSummary?(): Parameters<typeof applyKnowledgeNativeLifecycleSummary>[1] } | null | undefined
): Promise<void> {
  let firstError: unknown = null;
  await view.plugin.externalizeMessageText(assistantMessage, assistantMessage.text).catch((error) => {
    firstError = firstError ?? error;
  });
  await view.plugin.settlePendingKnowledgeBaseNativeExecutions?.().catch((error) => {
    console.warn("EchoInk native execution settle failed", error);
  });
  applyKnowledgeNativeLifecycleSummary(assistantMessage, manager?.getLastNativeLifecycleSummary?.());
  await view.plugin.saveSettings(true).catch((error) => {
    firstError = firstError ?? error;
  });
  if (firstError) throw firstError;
}

function knowledgeBaseMessageStatusFromResult(status: "success" | "failed" | "canceled"): string {
  if (status === "success") return "completed";
  if (status === "canceled") return "canceled";
  return "failed";
}

function isLocalKnowledgeBaseCommand(intent: string): boolean {
  return intent === "clear" || intent === "history" || intent === "help";
}

async function appendLocalKnowledgeBaseHelp(
  view: CodexViewTurnContext,
  session: StoredSession,
  inputText: string
): Promise<void> {
  const runId = newId("kb-local");
  const createdAt = Date.now();
  view.clearComposerDraft();
  view.addMessageToSession(session, {
    role: "user",
    text: inputText,
    runId,
    createdAt
  });
  view.addMessageToSession(session, {
    role: "assistant",
    title: "知识库帮助",
    itemType: "knowledgeBase",
    status: "completed",
    text: knowledgeBaseHelpText(),
    runId,
    createdAt: createdAt + 1
  });
  session.title = "知识库管理";
  session.updatedAt = createdAt + 1;
  view.renderTabs();
  view.renderMessages({ forceBottom: true });
  view.renderToolbar();
  await view.plugin.saveSettings(true);
}

function knowledgeBaseTurnOverrides(
  turnOptions: QueuedTurnItem["turnOptions"],
  session: StoredSession | undefined,
  workflowRunId: string
) {
  return {
    model: turnOptions.model,
    reasoning: turnOptions.reasoning,
    serviceTier: turnOptions.serviceTier,
    mcpEnabled: turnOptions.mcpEnabled,
    workspaceResources: turnOptions.workspaceResources,
    harnessSession: session,
    workflowRunId
  };
}

function resolveChatBackend(view: CodexViewTurnContext): AgentBackendKind {
  const settings = view.plugin?.settings;
  if (!settings) return "codex-cli";
  const choice = settings.capabilities?.chatBackend ?? "default";
  return choice === "default" ? settings.agentBackend ?? "codex-cli" : choice;
}

function resolveKnowledgeBackend(view: CodexViewTurnContext): AgentBackendKind {
  const settings = view.plugin?.settings;
  if (!settings) return "codex-cli";
  const configured = settings.knowledgeBase?.backend ?? "default";
  return configured === "default" ? settings.agentBackend ?? "codex-cli" : configured;
}

function resolveKnowledgeBackendForCommand(view: CodexViewTurnContext, intent: KnowledgeBaseCommandIntent): AgentBackendKind {
  if (intent === "maintain"
    || intent === "lint"
    || intent === "reingest"
    || intent === "process-outputs"
    || intent === "process-inbox") {
    return view.plugin?.settings?.agentBackend ?? "codex-cli";
  }
  return resolveKnowledgeBackend(view);
}

function messageProvenanceForTurn(view: CodexViewTurnContext, backend: AgentBackendKind, turnModel?: string): Pick<ChatMessage, "backendId" | "modelId" | "profileId"> {
  const modelId = messageModelIdForBackend(view, backend, turnModel);
  const profileId = messageProfileIdForBackend(view, backend);
  return {
    backendId: backend,
    ...(modelId ? { modelId } : {}),
    ...(profileId ? { profileId } : {})
  };
}

function applyMessageProvenance(message: ChatMessage, provenance: Pick<ChatMessage, "backendId" | "modelId" | "profileId">): void {
  message.backendId = provenance.backendId;
  if (provenance.modelId) message.modelId = provenance.modelId;
  if (provenance.profileId) message.profileId = provenance.profileId;
}

function replaceMessageProvenance(message: ChatMessage, provenance: Pick<ChatMessage, "backendId" | "modelId" | "profileId">): void {
  if (provenance.backendId) message.backendId = provenance.backendId;
  else delete message.backendId;
  if (provenance.modelId) message.modelId = provenance.modelId;
  else delete message.modelId;
  if (provenance.profileId) message.profileId = provenance.profileId;
  else delete message.profileId;
}

function replaceMaintenanceRunProvenance(
  session: StoredSession,
  runIds: string[],
  carrierMessages: ChatMessage[],
  provenance: Pick<ChatMessage, "backendId" | "modelId" | "profileId"> | null
): void {
  const matchingRunIds = new Set(runIds.map((runId) => runId.trim()).filter(Boolean));
  const carriers = new Set(carrierMessages);
  for (const message of session.messages) {
    if (
      !carriers.has(message)
      && (!message.runId || !matchingRunIds.has(message.runId))
    ) {
      continue;
    }
    if (provenance) replaceMessageProvenance(message, provenance);
    else clearMessageProvenance(message);
  }
}

function clearMessageProvenance(message: ChatMessage): void {
  delete message.backendId;
  delete message.modelId;
  delete message.profileId;
}

function applyHarnessRunProvenance(message: ChatMessage, output: HarnessRunResult): void {
  if (output.effectiveModel) {
    message.modelId = harnessProviderModelId(output.effectiveModel.providerId, output.effectiveModel.modelId);
  }
  if (output.contextManifest?.mode) message.contextMode = output.contextManifest.mode;
  if (output.contextManifest?.compiledThroughMessageId) {
    message.contextCompiledThroughMessageId = output.contextManifest.compiledThroughMessageId;
  }
  if (output.contextManifest?.snapshotVersion) message.contextSnapshotVersion = output.contextManifest.snapshotVersion;
  if (output.backendBinding?.leaseId) message.nativeLeaseId = output.backendBinding.leaseId;
  if (output.backendBinding?.leaseStatus) message.nativeLeaseStatus = output.backendBinding.leaseStatus;
  if (output.backendBinding?.leaseTurnCount) {
    message.nativeLeaseTurnCount = output.backendBinding.leaseTurnCount;
    message.nativeLeaseReused = output.backendBinding.leaseTurnCount > 1;
  }
}

function applyKnowledgeNativeLifecycleSummary(
  message: ChatMessage,
  summary: {
    localCommitStatus?: ChatMessage["nativeLocalCommitStatus"];
    cleanupStatuses?: ChatMessage["nativeCleanupStatus"][];
  } | null | undefined
): void {
  if (!summary) return;
  if (summary.localCommitStatus) message.nativeLocalCommitStatus = summary.localCommitStatus;
  const cleanupStatus = dominantNativeCleanupStatus((summary.cleanupStatuses ?? []).filter((status): status is NonNullable<ChatMessage["nativeCleanupStatus"]> => Boolean(status)));
  if (cleanupStatus) message.nativeCleanupStatus = cleanupStatus;
}

function dominantNativeCleanupStatus(statuses: NonNullable<ChatMessage["nativeCleanupStatus"]>[]): ChatMessage["nativeCleanupStatus"] | undefined {
  const priority: NonNullable<ChatMessage["nativeCleanupStatus"]>[] = [
    "failed",
    "retained-for-recovery",
    "pending",
    "unsupported",
    "retained",
    "disposed",
    "not-needed"
  ];
  return priority.find((status) => statuses.includes(status));
}

function messageModelIdForBackend(view: CodexViewTurnContext, backend: AgentBackendKind, turnModel?: string): string {
  return harnessInitialMessageModelId(view.plugin?.settings, backend, turnModel);
}

function messageProfileIdForBackend(view: CodexViewTurnContext, backend: AgentBackendKind): string {
  return harnessMessageProfileId(view.plugin?.settings, backend);
}

function buildCodexChatStyleInstruction(resources: ReturnType<typeof prepareAgentResources>): string {
  return [
    resources.promptPrefix,
    resources.warnings.length ? `资源提示：\n${resources.warnings.map((item) => `- ${item}`).join("\n")}` : "",
    DEFAULT_REPLY_STYLE_INSTRUCTION
  ].filter(Boolean).join("\n\n");
}

function buildAttachmentParts(vaultPath: string, attachments: StoredAttachment[]): AgentFilePart[] {
  return attachments.map((attachment): AgentFilePart => {
    const absolutePath = path.isAbsolute(attachment.path) ? attachment.path : path.join(vaultPath, attachment.path);
    return {
      type: "file",
      path: absolutePath,
      filename: attachment.name || path.basename(attachment.path),
      mime: mimeForAttachment(attachment)
    };
  });
}

function buildHarnessAttachments(vaultPath: string, attachments: StoredAttachment[]): Array<{ type: "file" | "image" | "pdf"; path: string; name?: string; mime?: string }> {
  const parts = buildAttachmentParts(vaultPath, attachments);
  return parts.map((part, index) => {
    const original = attachments[index];
    return {
      type: harnessAttachmentType(original, part.mime),
      path: part.path,
      name: part.filename,
      mime: part.mime
    };
  });
}

function harnessAttachmentType(attachment: StoredAttachment, mime: string): "file" | "image" | "pdf" {
  if (attachment.type === "image") return "image";
  if (mime === "application/pdf" || path.extname(attachment.path || attachment.name).toLowerCase() === ".pdf") return "pdf";
  return "file";
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
