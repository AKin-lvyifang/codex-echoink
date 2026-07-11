import type CodexForObsidianPlugin from "../../main";
import type { CodexErrorDiagnostic } from "../../core/codex-diagnostics";
import { extractEditorActionNotificationIds, routeEditorActionNotification as routeEditorActionNotificationState } from "../../editor-actions/state";
import type { EditorActionRunWaiter, EditorSummaryRunWaiter } from "./runner-context";

export interface EditorActionRunCoordinatorContext {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeTurnId: string;
  turnStartedAt: number;
  readonly editorActionRun: EditorActionRunWaiter | null;
  readonly editorSummaryRun: EditorSummaryRunWaiter | null;
  readonly editorActionActiveTimeoutMs: number;
  readonly editorActionThreadId: string;
  readonly editorActionThreadIds: Set<string>;
  readonly editorActionTurnIds: Set<string>;
  readonly editorActionItemIds: Set<string>;
  readonly editorActionCurrentItemIds: Set<string>;
  isEditorActionRunActive(): boolean;
  isEditorSummaryRunActive(): boolean;
  armTurnWatchdog(timeoutMs?: number, timeoutText?: string): void;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
  diagnoseCodexFailure(error: unknown, model?: string): CodexErrorDiagnostic;
  rejectEditorActionRun(error: Error): void;
  resolveEditorActionRun(text: string): void;
  rejectEditorSummaryRun(error: Error): void;
  resolveEditorSummaryRun(text: string): void;
  releaseEditorSummaryRunLock(runId?: string): void;
}

export class EditorActionRunCoordinator {
  constructor(private readonly context: EditorActionRunCoordinatorContext) {}

  handleNotification(method: string, params: unknown): boolean {
    if (this.handleEditorSummaryNotification(method, params)) return true;
    const view = this.context;
    const isActiveEditorAction = view.isEditorActionRunActive();
    const route = this.routeEditorActionNotification(method, params, isActiveEditorAction, view.editorActionThreadId, method === "error");
    if (!route.swallow) return false;
    this.rememberEditorActionNotificationIds(params, route.current || route.rememberCurrentItem);
    if (!route.current) return true;
    if (method === "turn/started") {
      const turn = paramsObject(params).turn as { id?: string } | undefined;
      view.running = true;
      view.activeTurnId = turn?.id ?? view.activeTurnId;
      view.turnStartedAt = Date.now();
      view.armTurnWatchdog(view.editorActionActiveTimeoutMs || view.plugin.settings.editorActions.timeoutMs);
      view.applyStatus();
      return true;
    }
    if (method === "turn/completed") {
      const turn = paramsObject(params).turn as { status?: string } | undefined;
      const failed = turn?.status === "failed";
      if (failed) view.rejectEditorActionRun(new Error("Codex 写作任务失败"));
      else if (view.editorActionRun?.text.trim()) view.resolveEditorActionRun(view.editorActionRun.text);
      else view.rejectEditorActionRun(new Error("Codex 没有返回候选文本"));
      view.running = false;
      view.activeTurnId = "";
      view.clearTurnWatchdog();
      view.clearActiveRun();
      view.applyStatus();
      return true;
    }
    if (method === "item/agentMessage/delta") {
      const paramsRecord = paramsObject(params);
      if (route.collectAssistantDelta && view.editorActionRun) view.editorActionRun.text += String(paramsRecord.delta ?? "");
      return true;
    }
    if (method === "error") {
      const message = String(paramsObject(params).message ?? "Codex 出错了");
      view.rejectEditorActionRun(new Error(view.diagnoseCodexFailure(message).text));
      view.running = false;
      view.activeTurnId = "";
      view.clearTurnWatchdog();
      view.clearActiveRun();
      view.applyStatus();
      return true;
    }
    return isCodexRunLifecycleNoise(method);
  }

  private handleEditorSummaryNotification(method: string, params: unknown): boolean {
    const view = this.context;
    if (!view.isEditorSummaryRunActive()) return false;
    const summaryThreadId = view.editorSummaryRun?.threadId ?? "";
    const route = this.routeEditorActionNotification(method, params, true, summaryThreadId, method === "error");
    if (!route.swallow) return false;
    this.rememberEditorActionNotificationIds(params, route.current || route.rememberCurrentItem);
    if (!route.current) return true;
    if (method === "turn/started") {
      const turn = paramsObject(params).turn as { id?: string } | undefined;
      view.activeTurnId = turn?.id ?? view.activeTurnId;
      return true;
    }
    if (method === "turn/completed") {
      const turn = paramsObject(params).turn as { status?: string } | undefined;
      const failed = turn?.status === "failed";
      const runId = view.editorSummaryRun?.runId;
      if (failed) view.rejectEditorSummaryRun(new Error("摘要生成失败"));
      else if (view.editorSummaryRun?.text.trim()) view.resolveEditorSummaryRun(view.editorSummaryRun.text);
      else view.rejectEditorSummaryRun(new Error("摘要为空"));
      view.releaseEditorSummaryRunLock(runId);
      return true;
    }
    if (method === "item/agentMessage/delta") {
      if (view.editorSummaryRun) view.editorSummaryRun.text += String(paramsObject(params).delta ?? "");
      return true;
    }
    if (method === "error") {
      const runId = view.editorSummaryRun?.runId;
      const message = String(paramsObject(params).message ?? "摘要生成失败");
      view.rejectEditorSummaryRun(new Error(view.diagnoseCodexFailure(message).text));
      view.releaseEditorSummaryRunLock(runId);
      return true;
    }
    return isCodexRunLifecycleNoise(method);
  }

  private routeEditorActionNotification(method: string, params: unknown, active: boolean, currentThreadId: string, allowUnscoped = false): ReturnType<typeof routeEditorActionNotificationState> {
    const view = this.context;
    return routeEditorActionNotificationState({
      method,
      params,
      active,
      currentThreadId,
      currentTurnId: view.activeTurnId,
      threadIds: view.editorActionThreadIds,
      turnIds: view.editorActionTurnIds,
      itemIds: view.editorActionItemIds,
      currentItemIds: view.editorActionCurrentItemIds,
      allowUnscoped
    });
  }

  private rememberEditorActionNotificationIds(params: unknown, currentRun = false): void {
    const view = this.context;
    const ids = extractEditorActionNotificationIds(params);
    if (ids.threadId) view.editorActionThreadIds.add(ids.threadId);
    if (ids.turnId) view.editorActionTurnIds.add(ids.turnId);
    if (ids.itemId) view.editorActionItemIds.add(ids.itemId);
    if (currentRun && ids.itemId) view.editorActionCurrentItemIds.add(ids.itemId);
    pruneSet(view.editorActionThreadIds, 80);
    pruneSet(view.editorActionTurnIds, 120);
    pruneSet(view.editorActionItemIds, 400);
  }
}

function isCodexRunLifecycleNoise(method: string): boolean {
  return method.startsWith("item/") || method.startsWith("turn/") || method === "thread/tokenUsage/updated" || method === "thread/compacted";
}

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? params as Record<string, unknown> : {};
}

function pruneSet<T>(set: Set<T>, maxSize: number): void {
  while (set.size > maxSize) {
    const first = set.values().next().value;
    if (first === undefined) return;
    set.delete(first);
  }
}
