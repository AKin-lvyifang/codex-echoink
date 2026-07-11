import type { App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { CodexErrorDiagnostic } from "../../core/codex-diagnostics";
import type { TurnOptions } from "../../core/codex-service";
import type { EditorActionStatusView } from "../../editor-actions/types";
import type { EchoInkResource } from "../../resources/types";
import type { ChatMessage, StoredAttachment, StoredSession } from "../../settings/settings";
import type { ServiceTierChoice } from "../../types/app-server";
import type { ComposerPrimaryActionState } from "../composer-state";
import type { QueuedTurnItem, RuntimeTurnQueue } from "../turn-queue";
import type { ArticleUnderstandingPanelState } from "./header";

export type RunnerRunKind = "chat" | "knowledge-base" | "";
export type QueuedTurnSource = "composer" | "queue";
export type QueuedTurnOutcome = "running" | "completed" | "failed";
export type KnowledgeBaseTurnOutcome = "completed" | "failed";

export interface EditorActionRunWaiter {
  runId: string;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export interface EditorSummaryRunWaiter extends EditorActionRunWaiter {
  threadId: string;
}

export interface RunnerMessageRenderOptions {
  forceBottom?: boolean;
  fromScroll?: boolean;
  preserveScroll?: boolean;
}

export interface MessageRenderFollowContext {
  messagesBottomFollowPaused: boolean;
}

export interface CodexViewRunnerBaseContext {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: RunnerRunKind;
  activeRunSessionId: string;
  activeTurnId: string;
  applyStatus(): void;
  armTurnWatchdog(timeoutMs?: number, timeoutText?: string): void;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  renderToolbar(): void;
  diagnoseCodexFailure(error: unknown, model?: string): CodexErrorDiagnostic;
}

export interface CodexViewTurnContext extends CodexViewRunnerBaseContext, MessageRenderFollowContext {
  readonly editorSummaryRun: EditorSummaryRunWaiter | null;
  readonly turnQueue: RuntimeTurnQueue;
  queueStartInProgress: boolean;
  turnStartedAt: number;
  readonly inputEl: HTMLTextAreaElement;
  readonly attachments: StoredAttachment[];
  readonly selectedSkill: EchoInkResource | null;
  readonly threadPrewarmPromise: Promise<boolean> | null;
  readonly threadPrewarmSessionId: string;
  cancelEditorSummaryRun(reason: string): void;
  ensureSession(): StoredSession;
  composerStateForSession(session: StoredSession): ComposerPrimaryActionState;
  enqueueComposerDraft(): Promise<void>;
  resumeQueuedTurns(sessionId: string): Promise<void>;
  stopTurn(): Promise<void>;
  pauseQueueForSession(sessionId: string): void;
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
  renderMessagesIfActive(session: StoredSession): void;
  ensureThinkingMessage(session: StoredSession, title: string, text: string): void;
  attachTurnIdToRun(session: StoredSession, turnId: string): void;
  finishThinkingMessage(session: StoredSession, status: string): void;
  finishRunningProcessMessages(session: StoredSession, status: string): void;
  finishPlanMessage(session: StoredSession): void;
  addMessageToSession(session: StoredSession, message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>): void;
  moveMessageToEnd(session: StoredSession, messageId: string): void;
  fillKnowledgeBaseCommand(command: string): void;
  refreshKnowledgeDashboard(force?: boolean): Promise<void>;
}

export interface CodexViewEditorActionContext extends CodexViewRunnerBaseContext {
  readonly editorSummaryRun: EditorSummaryRunWaiter | null;
  editorActionHarnessRunId: string;
  editorActionActiveTimeoutMs: number;
  editorActionRun: EditorActionRunWaiter | null;
  editorActionThreadId: string;
  readonly editorActionThreadIds: Set<string>;
  readonly editorActionTurnIds: Set<string>;
  readonly editorActionCurrentItemIds: Set<string>;
  articleUnderstandingPanelState: ArticleUnderstandingPanelState;
  readonly selectedServiceTier: ServiceTierChoice;
  cancelEditorSummaryRun(reason: string): void;
  editorActionStartBlockReason(): string | null;
  setEditorActionStatus(status: EditorActionStatusView): void;
  withEditorActionTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
  prewarmEditorActionThread(): void;
  rejectEditorActionRun(error: Error): void;
  effectiveEditorActionModel(availableModels?: string[], configuredModel?: string): string;
  takeEditorActionThread(turnOptions: TurnOptions): Promise<string>;
  resolveEditorActionRun(text: string): void;
  releaseEditorActionRunLock(runId: string): void;
  renderEditorActionStatus(): void;
  activeProviderModels(): string[];
}
