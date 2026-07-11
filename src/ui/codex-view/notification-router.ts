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
  appendProcessDelta(session: StoredSession, itemId: string, itemType: string, delta: string, payload: unknown): void;
  upsertProcessItem(session: StoredSession, id: string, itemType: string, text: string, status: string | undefined, payload: unknown): Promise<void>;
  renderPlanUpdate(session: StoredSession, params: unknown): void;
  renderStartedItem(session: StoredSession, item: unknown): void;
  renderCompletedItem(session: StoredSession, item: unknown): Promise<void>;
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
    const payload = paramsObject(params);
    const view = this.context;
    if (this.editorActionCoordinator.handleNotification(method, params)) return;
    if (view.activeRunKind === "knowledge-base" && isKnowledgeBaseUnroutedCodexNotification(method)) return;
    if (method === "turn/started") {
      const session = view.activeRunSession();
      const knowledgeSession = view.isKnowledgeBaseSession(session);
      const turn = paramsObject(payload.turn);
      view.running = true;
      view.activeTurnId = stringParam(turn.id);
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
      const failed = stringParam(paramsObject(payload.turn).status) === "failed";
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
      view.updateContextForSession(view.activeRunSession(), tokenUsageParam(payload.tokenUsage), true);
      return;
    }
    if (method === "thread/compacted") {
      const session = view.sessionForThread(stringParam(payload.threadId) || stringParam(paramsObject(payload.thread).id)) ?? view.activeRunSession();
      view.addContextCompactionMessage(session);
      if (payload.tokenUsage) view.updateContextForSession(session, tokenUsageParam(payload.tokenUsage), true);
      return;
    }
    if (method === "item/started" && payload.item) {
      view.renderStartedItem(view.activeRunSession(), payload.item);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const session = view.activeRunSession();
      view.markThinkingAsStreaming(session);
      view.appendItemDelta(session, stringParam(payload.itemId), "assistant", stringParam(payload.delta), "assistant", "回复");
      return;
    }
    if (method === "turn/plan/updated") {
      view.renderPlanUpdate(view.activeRunSession(), params);
      return;
    }
    if (method === "item/plan/delta") {
      view.appendProcessDelta(view.activeRunSession(), stringParam(payload.itemId), "plan", stringParam(payload.delta), { text: stringParam(payload.delta), status: "running" });
      return;
    }
    if (method === "item/reasoning/summaryPartAdded") {
      void view.upsertProcessItem(view.activeRunSession(), stringParam(payload.itemId), "reasoning", "", "running", { ...payload, status: "running" });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      view.appendProcessDelta(view.activeRunSession(), stringParam(payload.itemId), "reasoning", stringParam(payload.delta), { text: stringParam(payload.delta), status: "running" });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      view.appendProcessDelta(view.activeRunSession(), stringParam(payload.itemId), "commandExecution", stringParam(payload.delta), { text: stringParam(payload.delta), status: "running" });
      return;
    }
    if (method === "item/fileChange/outputDelta") {
      view.appendProcessDelta(view.activeRunSession(), stringParam(payload.itemId), "fileChange", stringParam(payload.delta), { text: stringParam(payload.delta), status: "running" });
      return;
    }
    if (method === "item/mcpToolCall/progress") {
      view.appendProcessDelta(view.activeRunSession(), stringParam(payload.itemId), "mcpToolCall", stringParam(payload.message), payload);
      return;
    }
    if (method === "item/completed" && payload.item) {
      void view.renderCompletedItem(view.activeRunSession(), payload.item).catch((error) => console.error("Codex item render failed", error));
      return;
    }
    if (method === "error") {
      const session = view.activeRunSession();
      const shouldPauseQueue = view.activeRunKind === "chat";
      const diagnostic = view.diagnoseCodexFailure(stringParam(payload.message) || "Codex 出错了");
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

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tokenUsageParam(value: unknown): TokenUsage | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as TokenUsage : undefined;
}
