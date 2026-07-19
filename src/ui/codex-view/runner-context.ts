import type { App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { CodexErrorDiagnostic } from "../../core/codex-diagnostics";
import type { TurnOptions } from "../../core/codex-service";
import type { EditorActionStatusView } from "../../editor-actions/types";
import type { HarnessAgentAdapterBuilder } from "../../harness/agents/adapter-factory";
import type { EchoInkResource } from "../../resources/types";
import type { ChatMessage, StoredAttachment, StoredSession } from "../../settings/settings";
import type { ComposerPrimaryActionState } from "../composer-state";
import type { QueuedTurnItem, RuntimeTurnQueue } from "../turn-queue";
import type { ArticleUnderstandingPanelState } from "./header";

export type RunnerRunKind = "chat" | "knowledge-base" | "editor" | "";
export type QueuedTurnSource = "composer" | "queue";
export type QueuedTurnOutcome = "running" | "completed" | "failed" | "cancelled";
export type KnowledgeBaseTurnOutcome = "completed" | "failed";

export interface RunnerMessageRenderOptions {
  forceBottom?: boolean;
  fromScroll?: boolean;
  preserveScroll?: boolean;
}

export interface MessageRenderFollowContext {
  messagesBottomFollowPaused: boolean;
}

export interface CodexViewLifecycleSnapshot {
  generation: number;
  signal: AbortSignal;
}

export interface CodexViewLifecycleContext {
  captureViewLifecycle(): CodexViewLifecycleSnapshot;
}

export interface CodexViewRunnerBaseContext {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: RunnerRunKind;
  activeRunSessionId: string;
  activeTurnId: string;
  activeRunNativeExecutionRecordIds?: string[];
  applyStatus(): void;
  armTurnWatchdog(timeoutMs?: number, timeoutText?: string): void;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  renderToolbar(): void;
  diagnoseCodexFailure(error: unknown, model?: string): CodexErrorDiagnostic;
}

export interface CodexViewTurnContext extends CodexViewRunnerBaseContext, MessageRenderFollowContext {
  readonly turnQueue: RuntimeTurnQueue;
  queueStartInProgress: boolean;
  turnStartedAt: number;
  readonly inputEl: HTMLTextAreaElement;
  readonly attachments: StoredAttachment[];
  readonly selectedSkill: EchoInkResource | null;
  ensureSession(): StoredSession;
  composerStateForSession(session: StoredSession): ComposerPrimaryActionState;
  enqueueComposerDraft(): Promise<void>;
  resumeQueuedTurns(sessionId: string): Promise<void>;
  recoverSessionLifecycle(sessionId: string): Promise<void>;
  stopTurn(): Promise<void>;
  pauseQueueForSession(sessionId: string): void;
  requireQueueRecoveryForSession(sessionId: string): void;
  createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null>;
  startQueuedTurnItem(item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome>;
  startQueuedTurnItemSafely(item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome>;
  afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void>;
  startNextQueuedTurn(sessionId: string): Promise<void>;
  startChatTurn(session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome>;
  startKnowledgeBaseTurn(session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<KnowledgeBaseTurnOutcome>;
  clearComposerDraft(): void;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  clearKnowledgeBasePage(session: StoredSession): Promise<void>;
  openKnowledgeBaseHistory(session: StoredSession): Promise<void>;
  ensureChatWorkspaceSelected(session: StoredSession): Promise<boolean>;
  currentTurnOptions(session?: StoredSession): TurnOptions;
  sessionById(sessionId: string): StoredSession | null;
  renderQueue(): void;
  renderTabs(): void;
  renderMessages(options?: RunnerMessageRenderOptions): void;
  renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void;
  ensureThinkingMessage(session: StoredSession, title: string, text: string): void;
  dismissThinkingMessage?(session: StoredSession): void;
  attachTurnIdToRun(session: StoredSession, turnId: string): void;
  finishThinkingMessage(session: StoredSession, status: string): void;
  finishRunningProcessMessages(session: StoredSession, status: string): void;
  finishPlanMessage(session: StoredSession): void;
  addMessageToSession(session: StoredSession, message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>): void;
  moveMessageToEnd(session: StoredSession, messageId: string): void;
  fillKnowledgeBaseCommand(command: string): void;
  refreshKnowledgeDashboard(force?: boolean): Promise<void>;
}

export interface CodexViewEditorActionContext
  extends CodexViewRunnerBaseContext, CodexViewLifecycleContext {
  /**
   * Narrow test seam for the Editor product entry. Production callers omit it
   * and continue to use createHarnessAgentAdapter.
   */
  createEditorActionHarnessAdapter?: HarnessAgentAdapterBuilder;
  editorActionHarnessRunId: string;
  editorActionActiveTimeoutMs: number;
  editorActionThreadId: string;
  readonly editorActionCurrentItemIds: Set<string>;
  articleUnderstandingPanelState: ArticleUnderstandingPanelState;
  editorActionStartBlockReason(): string | null;
  setEditorActionStatus(status: EditorActionStatusView): void;
  withEditorActionTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
  effectiveEditorActionModel(availableModels?: string[], configuredModel?: string): string;
  takeEditorActionThread(turnOptions: TurnOptions): Promise<string>;
  cleanupNativeExecutionRecord(recordId: string): Promise<void>;
  releaseEditorActionRunLock(runId: string): void;
  renderEditorActionStatus(): void;
  activeProviderModels(): string[];
}

export interface CodexViewPromptEnhanceContext extends CodexViewLifecycleContext {
  readonly plugin: CodexForObsidianPlugin;
  readonly normalTaskRunning: boolean;
  readonly inputEl: HTMLTextAreaElement;
  readonly promptEnhanceReviewEl: HTMLElement;
  promptEnhancerRunning: boolean;
  promptEnhancerRunId: string;
  promptEnhancerTurnId: string;
  applyStatus(): void;
  renderToolbar(): void;
  onInputChanged(): void;
  focusInput(): void;
}
