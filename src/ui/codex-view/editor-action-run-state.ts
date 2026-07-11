import type CodexForObsidianPlugin from "../../main";
import { swallowError } from "../../core/error-handling";
import type { TurnOptions } from "../../core/codex-service";
import { editorActionStartBlockReason as editorActionStartBlockReasonState } from "../../editor-actions/state";
import { buildEditorActionTurnOptions, resolveEditorActionModel } from "../../editor-actions/turn-options";
import { resolveEditorActionModeConfig } from "../../settings/settings";
import type { ServiceTierChoice } from "../../types/app-server";
import type { EditorActionStatusView } from "../../editor-actions/types";
import type { EditorActionRunWaiter, EditorSummaryRunWaiter } from "./runner-context";

export interface CodexEditorActionRunHost {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeTurnId: string;
  editorActionHarnessRunId: string;
  editorActionRun: EditorActionRunWaiter | null;
  editorActionActiveTimeoutMs: number;
  editorActionThreadId: string;
  editorActionThreadIds: Set<string>;
  editorActionCurrentItemIds: Set<string>;
  editorActionPrewarmThreadId: string;
  editorActionPrewarmPromise: Promise<string | null> | null;
  editorSummaryRun: EditorSummaryRunWaiter | null;
  editorSummaryTimeout: number | null;
  selectedServiceTier: ServiceTierChoice;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
  activeProviderModels(): string[];
  effectiveModel(): string;
  effectiveEditorActionModel(availableModels?: string[], configuredModel?: string): string;
  prewarmEditorActionThread(): void;
  rejectEditorActionRun(error: Error): void;
  rejectEditorSummaryRun(error: Error): void;
  releaseEditorSummaryRunLock(runId?: string): void;
  isEditorSummaryRunActive(): boolean;
  setEditorActionStatus(status: EditorActionStatusView): void;
}

export function resolveEditorActionRun(host: CodexEditorActionRunHost, text: string): void {
  const run = host.editorActionRun;
  if (!run) return;
  host.editorActionRun = null;
  run.resolve(text);
}

export function rejectEditorActionRun(host: CodexEditorActionRunHost, error: Error): void {
  const run = host.editorActionRun;
  if (!run) return;
  host.editorActionRun = null;
  run.reject(error);
}

export function editorActionStartBlockReason(host: CodexEditorActionRunHost): string | null {
  if (host.editorActionHarnessRunId) return "Agent 正在处理上一轮，请稍后再试";
  const reason = editorActionStartBlockReasonState({
    running: host.running,
    activeRunId: host.activeRunId,
    activeTurnId: host.activeTurnId,
    hasEditorActionRun: Boolean(host.editorActionRun)
  });
  if (!reason && host.running) {
    host.running = false;
    host.clearTurnWatchdog();
    host.applyStatus();
  }
  return reason;
}

export function releaseEditorActionRunLock(host: CodexEditorActionRunHost, runId: string): void {
  if (host.activeRunId && host.activeRunId !== runId) return;
  host.running = false;
  host.activeTurnId = "";
  host.clearTurnWatchdog();
  host.clearActiveRun();
  host.editorActionCurrentItemIds.clear();
  host.applyStatus();
}

export async function takeEditorActionThread(host: CodexEditorActionRunHost, turnOptions: TurnOptions): Promise<string> {
  if (host.editorActionPrewarmThreadId) {
    const threadId = host.editorActionPrewarmThreadId;
    host.editorActionPrewarmThreadId = "";
    return threadId;
  }
  if (host.editorActionPrewarmPromise) {
    const threadId = await host.editorActionPrewarmPromise.catch(() => null);
    if (threadId) {
      if (host.editorActionPrewarmThreadId === threadId) host.editorActionPrewarmThreadId = "";
      return threadId;
    }
  }
  const started = await host.plugin.codex!.startThread(turnOptions);
  host.editorActionThreadIds.add(started.threadId);
  return started.threadId;
}

export function prewarmEditorActionThread(host: CodexEditorActionRunHost): void {
  if (host.editorActionPrewarmThreadId || host.editorActionPrewarmPromise || host.running) return;
  host.editorActionPrewarmPromise = createEditorActionPrewarmThread(host)
    .catch(() => null)
    .finally(() => {
      host.editorActionPrewarmPromise = null;
    });
}

async function createEditorActionPrewarmThread(host: CodexEditorActionRunHost): Promise<string | null> {
  const status = await host.plugin.ensureCodexConnected(false, { silent: true });
  if (!status.connected || !host.plugin.codex || host.running) return null;
  const modeConfig = resolveEditorActionModeConfig(host.plugin.settings.editorActions);
  const turnOptions = {
    ...buildEditorActionTurnOptions({
      model: host.effectiveEditorActionModel(status.models.map((model) => model.model), modeConfig.model),
      serviceTier: host.selectedServiceTier,
      timeoutMs: host.plugin.settings.editorActions.timeoutMs,
      workspaceResources: { plugins: {}, mcpServers: {}, skills: {} }
    }),
    requestTimeoutMs: 15000
  };
  const started = await host.plugin.codex.startThread(turnOptions);
  if (host.running || host.editorActionPrewarmThreadId) return null;
  host.editorActionThreadIds.add(started.threadId);
  host.editorActionPrewarmThreadId = started.threadId;
  return started.threadId;
}

export function isEditorSummaryRunActive(host: CodexEditorActionRunHost): boolean {
  return Boolean(host.editorSummaryRun && host.editorSummaryRun.runId === host.activeRunId);
}

export function resolveEditorSummaryRun(host: CodexEditorActionRunHost, text: string): void {
  const run = host.editorSummaryRun;
  if (!run) return;
  host.editorSummaryRun = null;
  run.resolve(text);
}

export function rejectEditorSummaryRun(host: CodexEditorActionRunHost, error: Error): void {
  const run = host.editorSummaryRun;
  if (!run) return;
  host.editorSummaryRun = null;
  run.reject(error);
}

export function cancelEditorSummaryRun(host: CodexEditorActionRunHost, reason: string): void {
  const run = host.editorSummaryRun;
  if (!run) return;
  if (run.threadId && host.activeRunId === run.runId && host.activeTurnId) {
    void host.plugin.codex?.interruptTurn(run.threadId, host.activeTurnId).catch(swallowError("cancel editor summary Codex turn"));
  }
  host.rejectEditorSummaryRun(new Error(reason));
  host.releaseEditorSummaryRunLock(run.runId);
}

export function armEditorSummaryTimeout(host: CodexEditorActionRunHost, timeoutMs: number): void {
  clearEditorSummaryTimeout(host);
  host.editorSummaryTimeout = window.setTimeout(() => {
    const run = host.editorSummaryRun;
    if (!run) return;
    if (run.threadId && host.activeTurnId) {
      void host.plugin.codex?.interruptTurn(run.threadId, host.activeTurnId).catch(swallowError("interrupt timed out editor summary Codex turn"));
    }
    host.rejectEditorSummaryRun(new Error("摘要生成超时"));
    host.releaseEditorSummaryRunLock(run.runId);
  }, timeoutMs);
}

export function clearEditorSummaryTimers(host: CodexEditorActionRunHost): void {
  clearEditorSummaryTimeout(host);
}

export function clearEditorSummaryTimeout(host: CodexEditorActionRunHost): void {
  if (!host.editorSummaryTimeout) return;
  window.clearTimeout(host.editorSummaryTimeout);
  host.editorSummaryTimeout = null;
}

export function releaseEditorSummaryRunLock(host: CodexEditorActionRunHost, runId?: string): void {
  clearEditorSummaryTimeout(host);
  if ((runId && host.activeRunId === runId) || host.isEditorSummaryRunActive()) {
    host.running = false;
    host.clearActiveRun();
    host.editorActionCurrentItemIds.clear();
    host.applyStatus();
  }
}

export function isEditorActionRunActive(host: CodexEditorActionRunHost): boolean {
  return Boolean(host.editorActionRun && host.editorActionRun.runId === host.activeRunId);
}

export function withEditorActionTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), Math.max(1000, timeoutMs));
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function effectiveEditorActionModel(host: CodexEditorActionRunHost, availableModels: string[] = [], configuredModel = host.plugin.settings.editorActions.model): string {
  const providerModels = host.activeProviderModels();
  return resolveEditorActionModel({
    configuredModel,
    availableModels: providerModels.length ? providerModels : availableModels,
    fallbackModel: host.effectiveModel()
  });
}
