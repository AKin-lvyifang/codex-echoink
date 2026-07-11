import { normalizeRateLimitResponse } from "../../core/rate-limits";
import type { ChatMessage, StoredSession } from "../../settings/settings";
import type { CodexNotification, RateLimitSnapshot, TokenUsage } from "../../types/app-server";
import { turnWatchdogTimeoutForSession, turnWatchdogTimeoutText } from "../turn-watchdog";
import type { RunnerRunKind } from "./runner-context";
import { EditorActionRunCoordinator, type EditorActionRunCoordinatorContext } from "./editor-action-run-coordinator";

export interface CodexNotificationRouterContext extends EditorActionRunCoordinatorContext {
  activeRunKind: RunnerRunKind;
  usageLoading: boolean;
  usageError: string | null;
  activeRunSession(): StoredSession;
  sessionForThread(threadId?: string): StoredSession | null;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  attachTurnIdToRun(session: StoredSession, turnId: string): void;
  ensureThinkingMessage(session: StoredSession, title: string, text: string): void;
  markThinkingAsStreaming(session: StoredSession): void;
  appendItemDelta(session: StoredSession, itemId: string, role: ChatMessage["role"], delta: string, itemType: string, title: string): void;
  appendProcessDelta(session: StoredSession, itemId: string, itemType: string, delta: string, payload: any): void;
  upsertProcessItem(session: StoredSession, id: string, itemType: string, text: string, status: string | undefined, payload: any): Promise<void>;
  renderPlanUpdate(session: StoredSession, params: any): void;
  renderStartedItem(session: StoredSession, item: any): void;
  renderCompletedItem(session: StoredSession, item: any): Promise<void>;
  updateUsageHeader(rateLimits: RateLimitSnapshot | null, loading?: boolean, error?: string | null): void;
  renderUsagePanel(rateLimits: RateLimitSnapshot | null, error?: string | null, loading?: boolean): void;
  updateContextForSession(session: StoredSession, tokenUsage: TokenUsage | undefined, persist: boolean): void;
  addContextCompactionMessage(session: StoredSession): void;
  finishThinkingMessage(session: StoredSession, status: string): void;
  finishRunningProcessMessages(session: StoredSession, status: string): void;
  finishPlanMessage(session: StoredSession): void;
  afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void>;
  addMessageToSession(session: StoredSession, message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>): void;
}

export class CodexNotificationRouter {
  private readonly editorActionCoordinator: EditorActionRunCoordinator;

  constructor(private readonly context: CodexNotificationRouterContext, editorActionCoordinator?: EditorActionRunCoordinator) {
    this.editorActionCoordinator = editorActionCoordinator ?? new EditorActionRunCoordinator(context);
  }

  handle(notification: CodexNotification): void {
    const { method, params } = notification;
    const view = this.context;
    if (this.editorActionCoordinator.handleNotification(method, params)) return;
    if (view.activeRunKind === "knowledge-base" && isKnowledgeBaseUnroutedCodexNotification(method)) return;
    if (method === "turn/started") {
      const session = view.activeRunSession();
      const knowledgeSession = view.isKnowledgeBaseSession(session);
      view.running = true;
      view.activeTurnId = params?.turn?.id ?? "";
      view.turnStartedAt = Date.now();
      view.attachTurnIdToRun(session, view.activeTurnId);
      view.ensureThinkingMessage(session, "生成中", "正在生成回复...");
      const timeoutMs = turnWatchdogTimeoutForSession(knowledgeSession);
      if (timeoutMs === null) view.clearTurnWatchdog();
      else view.armTurnWatchdog(timeoutMs, turnWatchdogTimeoutText(timeoutMs));
      view.applyStatus();
      return;
    }
    if (method === "turn/completed") {
      const session = view.activeRunSession();
      const failed = params?.turn?.status === "failed";
      const shouldAdvanceQueue = view.activeRunKind === "chat";
      view.running = false;
      view.activeTurnId = "";
      view.clearTurnWatchdog();
      view.finishThinkingMessage(session, failed ? "中断" : "完成");
      view.finishRunningProcessMessages(session, failed ? "failed" : "completed");
      view.finishPlanMessage(session);
      view.clearActiveRun();
      view.applyStatus();
      void view.plugin.saveSettings(true);
      if (shouldAdvanceQueue) void view.afterTurnSettled(session.id, !failed);
      return;
    }
    if (method === "account/rateLimits/updated") {
      const normalizedRateLimits = normalizeRateLimitResponse(params);
      view.usageLoading = false;
      view.usageError = null;
      if (view.plugin.lastStatus) {
        view.plugin.lastStatus = {
          ...view.plugin.lastStatus,
          rateLimits: normalizedRateLimits.rateLimits,
          rateLimitsByLimitId: normalizedRateLimits.rateLimitsByLimitId
        };
      }
      view.updateUsageHeader(normalizedRateLimits.rateLimits, false, null);
      view.renderUsagePanel(normalizedRateLimits.rateLimits, null, false);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      view.updateContextForSession(view.activeRunSession(), params?.tokenUsage, true);
      return;
    }
    if (method === "thread/compacted") {
      const session = view.sessionForThread(params?.threadId ?? params?.thread?.id) ?? view.activeRunSession();
      view.addContextCompactionMessage(session);
      if (params?.tokenUsage) view.updateContextForSession(session, params.tokenUsage, true);
      return;
    }
    if (method === "item/started" && params?.item) {
      view.renderStartedItem(view.activeRunSession(), params.item);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const session = view.activeRunSession();
      view.markThinkingAsStreaming(session);
      view.appendItemDelta(session, params.itemId, "assistant", params.delta ?? "", "assistant", "回复");
      return;
    }
    if (method === "turn/plan/updated") {
      view.renderPlanUpdate(view.activeRunSession(), params);
      return;
    }
    if (method === "item/plan/delta") {
      view.appendProcessDelta(view.activeRunSession(), params.itemId, "plan", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/reasoning/summaryPartAdded") {
      void view.upsertProcessItem(view.activeRunSession(), params.itemId, "reasoning", "", "running", { ...params, status: "running" });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      view.appendProcessDelta(view.activeRunSession(), params.itemId, "reasoning", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      view.appendProcessDelta(view.activeRunSession(), params.itemId, "commandExecution", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/fileChange/outputDelta") {
      view.appendProcessDelta(view.activeRunSession(), params.itemId, "fileChange", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/mcpToolCall/progress") {
      view.appendProcessDelta(view.activeRunSession(), params.itemId, "mcpToolCall", params.message ?? "", params);
      return;
    }
    if (method === "item/completed" && params?.item) {
      void view.renderCompletedItem(view.activeRunSession(), params.item).catch((error) => console.error("Codex item render failed", error));
      return;
    }
    if (method === "error") {
      const session = view.activeRunSession();
      const shouldPauseQueue = view.activeRunKind === "chat";
      const diagnostic = view.diagnoseCodexFailure(params?.message ?? "Codex 出错了");
      view.running = false;
      view.activeTurnId = "";
      view.clearTurnWatchdog();
      view.finishThinkingMessage(session, "失败");
      view.finishRunningProcessMessages(session, "error");
      view.addMessageToSession(session, { role: "system", text: diagnostic.text, itemType: "error", title: diagnostic.title });
      view.clearActiveRun();
      view.applyStatus();
      if (shouldPauseQueue) void view.afterTurnSettled(session.id, false);
    }
  }

  handleKnowledgeBaseNotification(): boolean {
    return this.context.activeRunKind === "knowledge-base";
  }
}

function isKnowledgeBaseUnroutedCodexNotification(method: string): boolean {
  return method.startsWith("item/") || method.startsWith("turn/") || method.startsWith("thread/") || method === "error";
}
