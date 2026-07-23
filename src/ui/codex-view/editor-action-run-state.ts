import type CodexForObsidianPlugin from "../../main";
import type { TurnOptions } from "../../core/codex-service";
import { editorActionStartBlockReason as editorActionStartBlockReasonState } from "../../editor-actions/state";
import { resolveEditorActionModel } from "../../editor-actions/turn-options";
import { harnessEditorActionModel } from "../../harness/agents/backend-runtime-profile";
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
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
  activeProviderModels(): string[];
  effectiveEditorActionModel(availableModels?: string[], configuredModel?: string): string;
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
  const started = await host.plugin.startCodexHarnessThread(turnOptions);
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
    utilityModel: harnessEditorActionModel(host.plugin.settings, "codex-cli", "")
  });
}
