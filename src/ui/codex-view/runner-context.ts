import type { App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { ProviderErrorDiagnostic } from "../../core/provider-diagnostics";
import type { TurnOptions } from "../turn-options";
import type { EchoInkResource } from "../../resources/types";
import type { ChatMessage, StoredAttachment, StoredSession } from "../../settings/settings";
import type { EchoInkTurnInteraction } from "../../types/conversation-turn";
import type { ComposerPrimaryActionState } from "../composer-state";
import type { QueuedTurnItem, RuntimeTurnQueue } from "../turn-queue";

export type RunnerRunKind = "chat" | "";
export type QueuedTurnSource = "composer" | "queue";
export type QueuedTurnOutcome = "running" | "completed" | "failed" | "cancelled";

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
  readonly lifecycleSignal?: AbortSignal;
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
  diagnoseCodexFailure(error: unknown, model?: string): ProviderErrorDiagnostic;
}

export interface CodexViewTurnContext extends CodexViewRunnerBaseContext, MessageRenderFollowContext {
  isComposerTransferCancelled?(itemId: string): boolean;
  onComposerTransferStarted?(item: Readonly<QueuedTurnItem>): void;
  onComposerTransferFinished?(item: Readonly<QueuedTurnItem>, outcome: QueuedTurnOutcome | "queued"): void;
  onPiRunFailure?(message: string): void;
  onPiRunAccepted?(item: Readonly<QueuedTurnItem>): void | Promise<void>;
  readonly turnQueue: RuntimeTurnQueue;
  queueStartInProgress: boolean;
  turnStartedAt: number;
  readonly inputEl: HTMLTextAreaElement;
  readonly attachments: StoredAttachment[];
  readonly selectedSkill: EchoInkResource | null;
  selectedProviderSettingsId: string;
  selectedModel: string;
  ensureSession(): StoredSession;
  composerStateForSession(session: StoredSession): ComposerPrimaryActionState;
  enqueueComposerDraft(): Promise<void>;
  resumeQueuedTurns(sessionId: string): Promise<void>;
  stopTurn(): Promise<void>;
  pauseQueueForSession(sessionId: string): void;
  createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean; onError?: (message: string) => void }): Promise<QueuedTurnItem | null>;
  startQueuedTurnItem(item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome>;
  startQueuedTurnItemSafely(item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome>;
  afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void>;
  startNextQueuedTurn(sessionId: string): Promise<void>;
  startChatTurn(session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome>;
  clearComposerDraft(): void;
  clearAcceptedComposerDraft?(item: Readonly<QueuedTurnItem>): void;
  ensureChatWorkspaceSelected(session: StoredSession): Promise<boolean>;
  currentTurnOptions(session?: StoredSession): TurnOptions;
  sessionById(sessionId: string): StoredSession | null;
  renderQueue(): void;
  renderTabs(): void;
  renderMessages(options?: RunnerMessageRenderOptions): void;
  renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void;
  setPendingInteraction(
    sessionId: string,
    interaction: Readonly<EchoInkTurnInteraction> | null,
    expectedTurnId?: string
  ): void;
  ensureThinkingMessage(session: StoredSession, title: string, text: string): void;
  dismissThinkingMessage?(session: StoredSession): void;
  attachTurnIdToRun(session: StoredSession, turnId: string): void;
  finishThinkingMessage(session: StoredSession, status: string): void;
  finishRunningProcessMessages(session: StoredSession, status: string): void;
  finishPlanMessage(session: StoredSession): void;
  addMessageToSession(session: StoredSession, message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>): void;
  moveMessageToEnd(session: StoredSession, messageId: string): void;
  fillKnowledgeBaseCommand(command: string): void;
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
