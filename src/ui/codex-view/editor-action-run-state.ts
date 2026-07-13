import type CodexForObsidianPlugin from "../../main";
import type { TurnOptions } from "../../core/codex-service";
import { editorActionStartBlockReason as editorActionStartBlockReasonState } from "../../editor-actions/state";
import { buildEditorActionTurnOptions, resolveEditorActionModel } from "../../editor-actions/turn-options";
import { resolveEditorActionModeConfig } from "../../settings/settings";
import type { ServiceTierChoice } from "../../types/app-server";
import type { EditorActionStatusView } from "../../editor-actions/types";

export interface CodexEditorActionRunHost {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: "chat" | "knowledge-base" | "editor" | "";
  activeTurnId: string;
  editorActionHarnessRunId: string;
  editorActionActiveTimeoutMs: number;
  editorActionThreadId: string;
  editorActionCurrentItemIds: Set<string>;
  editorActionPrewarmThreadId: string;
  editorActionPrewarmPromise: Promise<string | null> | null;
  selectedServiceTier: ServiceTierChoice;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
  activeProviderModels(): string[];
  effectiveModel(): string;
  effectiveEditorActionModel(availableModels?: string[], configuredModel?: string): string;
  prewarmEditorActionThread(): void;
  setEditorActionStatus(status: EditorActionStatusView): void;
}

export function editorActionStartBlockReason(host: CodexEditorActionRunHost): string | null {
  if (host.editorActionHarnessRunId) return "Agent 正在处理上一轮，请稍后再试";
  const reason = editorActionStartBlockReasonState({
    running: host.running,
    activeRunId: host.activeRunId,
    activeTurnId: host.activeTurnId,
    hasEditorActionRun: host.activeRunKind === "editor"
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
  const started = await host.plugin.startCodexHarnessThread(turnOptions);
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
  if (!status.connected || !host.plugin.hasCodexHarnessTransport() || host.running) return null;
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
  const started = await host.plugin.startCodexHarnessThread(turnOptions);
  if (host.running || host.editorActionPrewarmThreadId) return null;
  host.editorActionPrewarmThreadId = started.threadId;
  return started.threadId;
}

export function isEditorActionRunActive(host: CodexEditorActionRunHost): boolean {
  return host.activeRunKind === "editor" && Boolean(host.activeRunId);
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
