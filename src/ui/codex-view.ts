import * as fs from "fs";
import * as path from "path";
import { ItemView, MarkdownView, normalizePath, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentBackendMode, ChatMessage, DiffSummary, StoredAttachment, StoredSession } from "../settings/settings";
import { ensureKnowledgeBaseSession, getActiveApiProvider, getApiProviderModels, isKnowledgeBaseSession, newId, providerConnectionLabel, resolveEditorActionModeConfig } from "../settings/settings";
import type { EchoInkResource } from "../resources/types";
import { buildEchoInkResourceCatalog, hasEnabledMcpResources, skillResourcesForScope, workspaceResourcesFromEchoInkResources } from "../resources/registry";
import type {
  CodexNotification,
  McpServerStatus,
  PermissionMode,
  ProcessFileRef,
  RateLimitSnapshot,
  ReasoningEffort,
  ServiceTierChoice,
  TokenUsage,
  UiMode
} from "../types/app-server";
import { extractClipboardImageFiles, saveClipboardImageAttachments } from "../core/clipboard-images";
import { buildDiffSummary, diffSummaryLabel, serializeFileChanges } from "../core/diff-summary";
import { diagnoseCodexError, type CodexErrorDiagnostic } from "../core/codex-diagnostics";
import { getElectronDialog, showItemInFinder } from "../core/electron";
import { swallowError } from "../core/error-handling";
import { basename, buildUserInput, contextUsageView, reasoningTextFromPayload, summarizeProcessEvent } from "../core/mapping";
import { settleStaleRunningMessages } from "../core/message-state";
import { shouldCloseComposerMenusForClick } from "./composer-menu";
import { composerPrimaryActionForState, composerStateForRuntimeState, type ComposerPrimaryActionState } from "./composer-state";
import { canStartQueuedTurn, RuntimeTurnQueue, type QueuedTurnItem } from "./turn-queue";
import { CHAT_TURN_WATCHDOG_MS, turnWatchdogTimeoutText } from "./turn-watchdog";
import { textInputModal } from "./modals";
import { KnowledgeBaseHistoryModal } from "./codex-view/history-modal";
import {
  compactReasoningLabel,
  labelFor,
  renderComposerAttachments,
  renderComposerShell,
  renderComposerToolbar,
  renderTurnQueue,
  shortModelLabel
} from "./codex-view/composer";
import { CodexMessageListRenderer, isProcessItemType } from "./codex-view/message-list";
import { appendKnowledgeContextBridge, buildKnowledgeContextBridgeForThread, knowledgeContextBridgeDetailText, markKnowledgeContextBridgeInjected } from "./codex-view/knowledge-context-bridge";
import { renderCodexTabs } from "./codex-view/tabs";
import { renderMcpPanelView } from "./codex-view/mcp-panel";
import { MessageScrollFollowController, type MessageRenderScheduleOptions } from "./codex-view/message-scroll-follow";
import {
  openAddMenu as showAddMenu,
  openKnowledgeCommandMenu as showKnowledgeCommandMenu,
  openKnowledgeModelMenu as showKnowledgeModelMenu,
  openModelMenu as showModelMenu,
  openSessionMenu as showSessionMenu,
  openSkillMenu as showSkillMenu,
  openWorkspaceMenu as showWorkspaceMenu,
  renderKnowledgeCommandMatches as renderKnowledgeCommandMatchesView,
  renderSkillMatches as renderSkillMatchesView
} from "./codex-view/menus";
import {
  currentArticleUnderstandingSource as currentArticleUnderstandingSourceRunner,
  ensureArticleUnderstanding as ensureArticleUnderstandingRunner,
  refreshArticleUnderstandingFromPanel as refreshArticleUnderstandingFromPanelRunner,
  refreshArticleUnderstandingPanelSourceState as refreshArticleUnderstandingPanelSourceStateRunner,
  runEditorActionPromptTurn as runEditorActionPromptTurnRunner,
  sendEditorActionRequest as sendEditorActionRequestRunner,
  setArticleUnderstandingPanelState as setArticleUnderstandingPanelStateRunner
} from "./codex-view/editor-action-runner";
import {
  afterTurnSettled as afterTurnSettledRunner,
  createQueuedTurnFromComposer as createQueuedTurnFromComposerRunner,
  enqueueComposerDraft as enqueueComposerDraftRunner,
  resumeQueuedTurns as resumeQueuedTurnsRunner,
  runKnowledgeBaseShortcut as runKnowledgeBaseShortcutRunner,
  sendMessage as sendMessageRunner,
  startChatTurn as startChatTurnRunner,
  startKnowledgeBaseTurn as startKnowledgeBaseTurnRunner,
  startNextQueuedTurn as startNextQueuedTurnRunner,
  startQueuedTurnItem as startQueuedTurnItemRunner,
  startQueuedTurnItemSafely as startQueuedTurnItemSafelyRunner
} from "./codex-view/turn-runner";
import type { CodexViewEditorActionContext, CodexViewTurnContext, EditorActionRunWaiter, EditorSummaryRunWaiter } from "./codex-view/runner-context";
import {
  renderArticleUnderstandingPanelView,
  renderCodexHeader,
  renderEditorActionStatusView,
  renderHeaderHistoryButton,
  renderUsagePanelView,
  updateUsageHeaderView,
  type ArticleUnderstandingPanelState
} from "./codex-view/header";
import { clearKnowledgeDashboardHealthTooltips as clearKnowledgeDashboardTooltipState, createKnowledgeDashboardTooltipState, renderKnowledgeDashboardView } from "./codex-view/knowledge-dashboard";
import { CodexNotificationRouter, type CodexNotificationRouterContext } from "./codex-view/notification-router";
import { buildEditorActionUserInput } from "../editor-actions/prompt";
import { editorActionStartBlockReason } from "../editor-actions/state";
import { buildEditorActionTurnOptions, resolveEditorActionModel } from "../editor-actions/turn-options";
import type { ArticleUnderstandingEntry, ArticleUnderstandingStatus, EditorActionQualityMode, EditorActionRequest, EditorActionStatusView } from "../editor-actions/types";
import type { EditorActionSummarySource } from "../editor-actions/summary-cache";
import { knowledgeCommandQueryForInput } from "../knowledge-base/commands";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { clearKnowledgeBaseVisibleHistory, getDisplayKnowledgeBaseMessages, getHiddenKnowledgeBaseMessages } from "../knowledge-base/session-history";

type ObsidianSettingsApi = {
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
};

export const VIEW_TYPE_CODEX = "codex-for-obsidian-view";
export { isKnowledgeDashboardHealthTooltipHoverPoint } from "./codex-view/knowledge-dashboard";

export class CodexView extends ItemView {
  private rootEl!: HTMLElement;
  private headerStatusEl!: HTMLElement;
  private headerStatusTextEl!: HTMLElement;
  private editorActionStatusEl!: HTMLElement;
  private editorActionStatusTextEl!: HTMLElement;
  private headerHistoryEl!: HTMLButtonElement;
  private articleUnderstandingPanelEl!: HTMLElement;
  private headerUsageEl!: HTMLButtonElement;
  private headerUsageTextEl!: HTMLElement;
  private usagePanelEl!: HTMLElement;
  private tabBarEl!: HTMLElement;
  private knowledgeDashboardEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private virtualListEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private toolbarEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private contextRingEl!: HTMLElement;
  private contextValueEl!: HTMLElement;
  private skillMenuEl!: HTMLElement;
  private knowledgeCommandMenuEl!: HTMLElement;
  private mcpPanelEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private queueEl!: HTMLElement;
  private running = false;
  private activeRunId = "";
  private activeRunKind: "chat" | "knowledge-base" | "";
  private activeRunSessionId = "";
  private activeTurnId = "";
  private turnStartedAt = 0;
  private turnWatchdog: number | null = null;
  private activeThinkingMessageId = "";
  private activePlanMessageId = "";
  private activeItemMessages = new Map<string, string>();
  private readonly messageScrollFollow = new MessageScrollFollowController();
  private knowledgeBaseRunProgressTimer: number | null = null;
  private messageListRenderer = new CodexMessageListRenderer();
  private selectedSkill: EchoInkResource | null = null;
  private attachments: StoredAttachment[] = [];
  private selectedModel = "";
  private selectedReasoning: ReasoningEffort;
  private selectedServiceTier: ServiceTierChoice;
  private selectedPermission: PermissionMode;
  private selectedMode: UiMode;
  private skillsRequested = false;
  private threadPrewarmPromise: Promise<boolean> | null = null;
  private threadPrewarmSessionId = "";
  private usageLoading = false;
  private usageError: string | null = null;
  private usageRequestId = 0;
  private editorActionStatus: EditorActionStatusView = { status: "idle" };
  private articleUnderstandingPanelVisible = false;
  private articleUnderstandingPanelState: ArticleUnderstandingPanelState = { status: "idle" };
  private editorActionHarnessRunId = "";
  private editorActionStatusTicker: number | null = null;
  private editorActionStatusResetTimer: number | null = null;
  private editorActionRun: EditorActionRunWaiter | null = null;
  private editorActionActiveTimeoutMs = 0;
  private editorActionThreadId = "";
  private editorActionThreadIds = new Set<string>();
  private editorActionTurnIds = new Set<string>();
  private editorActionItemIds = new Set<string>();
  private editorActionCurrentItemIds = new Set<string>();
  private editorActionPrewarmThreadId = "";
  private editorActionPrewarmPromise: Promise<string | null> | null = null;
  private editorSummaryRun: EditorSummaryRunWaiter | null = null;
  private editorSummaryTimeout: number | null = null;
  private knowledgeDashboardSnapshot: KnowledgeBaseDashboardSnapshot | null = null;
  private knowledgeDashboardExpanded = false;
  private knowledgeDashboardLoading = false;
  private knowledgeDashboardError = "";
  private knowledgeDashboardRequestId = 0;
  private knowledgeDashboardTooltipState = createKnowledgeDashboardTooltipState();
  private readonly turnQueue = new RuntimeTurnQueue();
  private queueStartInProgress = false;
  private draggedQueueItemId = "";
  private readonly turnRunnerContext: CodexViewTurnContext;
  private readonly editorActionRunnerContext: CodexViewEditorActionContext;
  private readonly notificationRouter: CodexNotificationRouter;

  get messagesBottomFollowPaused(): boolean {
    return this.messageScrollFollow.paused;
  }

  set messagesBottomFollowPaused(paused: boolean) {
    this.messageScrollFollow.paused = paused;
  }

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.selectedModel = plugin.settings.defaultModel;
    this.selectedReasoning = plugin.settings.defaultReasoning;
    this.selectedServiceTier = plugin.settings.defaultServiceTier;
    this.selectedPermission = plugin.settings.defaultPermission;
    this.selectedMode = plugin.settings.defaultMode;
    this.activeRunKind = "";
    this.turnRunnerContext = this.createTurnRunnerContext();
    this.editorActionRunnerContext = this.createEditorActionRunnerContext();
    this.notificationRouter = new CodexNotificationRouter(this.createNotificationRouterContext());
  }

  private createTurnRunnerContext(): CodexViewTurnContext {
    const view = this;
    return {
      get app() { return view.app; }, get plugin() { return view.plugin; }, get running() { return view.running; }, set running(value) { view.running = value; }, get activeRunId() { return view.activeRunId; }, set activeRunId(value) { view.activeRunId = value; }, get activeRunKind() { return view.activeRunKind; }, set activeRunKind(value) { view.activeRunKind = value; }, get activeRunSessionId() { return view.activeRunSessionId; }, set activeRunSessionId(value) { view.activeRunSessionId = value; }, get activeTurnId() { return view.activeTurnId; }, set activeTurnId(value) { view.activeTurnId = value; },
      get editorSummaryRun() { return view.editorSummaryRun; }, get turnQueue() { return view.turnQueue; }, get queueStartInProgress() { return view.queueStartInProgress; }, set queueStartInProgress(value) { view.queueStartInProgress = value; }, get turnStartedAt() { return view.turnStartedAt; }, set turnStartedAt(value) { view.turnStartedAt = value; }, get inputEl() { return view.inputEl; }, get attachments() { return view.attachments; }, get selectedSkill() { return view.selectedSkill; }, get threadPrewarmPromise() { return view.threadPrewarmPromise; }, get threadPrewarmSessionId() { return view.threadPrewarmSessionId; }, get messagesBottomFollowPaused() { return view.messagesBottomFollowPaused; }, set messagesBottomFollowPaused(value) { view.messagesBottomFollowPaused = value; },
      applyStatus: () => view.applyStatus(), armTurnWatchdog: (timeoutMs, timeoutText) => view.armTurnWatchdog(timeoutMs, timeoutText), clearTurnWatchdog: () => view.clearTurnWatchdog(), clearActiveRun: () => view.clearActiveRun(), renderToolbar: () => view.renderToolbar(), diagnoseCodexFailure: (error, model) => view.diagnoseCodexFailure(error, model), cancelEditorSummaryRun: (reason) => view.cancelEditorSummaryRun(reason), ensureSession: () => view.ensureSession(), composerStateForSession: (session) => view.composerStateForSession(session), enqueueComposerDraft: () => view.enqueueComposerDraft(), resumeQueuedTurns: (sessionId) => view.resumeQueuedTurns(sessionId), stopTurn: () => view.stopTurn(), pauseQueueForSession: (sessionId) => view.pauseQueueForSession(sessionId),
      createQueuedTurnFromComposer: (options) => view.createQueuedTurnFromComposer(options), startQueuedTurnItem: (item, source) => view.startQueuedTurnItem(item, source), startQueuedTurnItemSafely: (item, source) => view.startQueuedTurnItemSafely(item, source), afterTurnSettled: (sessionId, succeeded) => view.afterTurnSettled(sessionId, succeeded), startNextQueuedTurn: (sessionId) => view.startNextQueuedTurn(sessionId), startChatTurn: (session, item, source) => view.startChatTurn(session, item, source), startKnowledgeBaseTurn: (session, item, source) => view.startKnowledgeBaseTurn(session, item, source), clearComposerDraft: () => view.clearComposerDraft(), isKnowledgeBaseSession: (session) => view.isKnowledgeBaseSession(session), clearKnowledgeBasePage: (session) => view.clearKnowledgeBasePage(session), openKnowledgeBaseHistory: (session) => view.openKnowledgeBaseHistory(session),
      ensureChatWorkspaceSelected: (session) => view.ensureChatWorkspaceSelected(session), currentTurnOptions: (session) => view.currentTurnOptions(session), sessionById: (sessionId) => view.sessionById(sessionId), renderQueue: () => view.renderQueue(), renderTabs: () => view.renderTabs(), renderMessages: (options) => view.renderMessages(options), renderMessagesIfActive: (session) => view.renderMessagesIfActive(session), ensureThinkingMessage: (session, title, text) => view.ensureThinkingMessage(session, title, text), attachTurnIdToRun: (session, turnId) => view.attachTurnIdToRun(session, turnId), finishThinkingMessage: (session, status) => view.finishThinkingMessage(session, status), finishRunningProcessMessages: (session, status) => view.finishRunningProcessMessages(session, status), finishPlanMessage: (session) => view.finishPlanMessage(session), addMessageToSession: (session, message) => view.addMessageToSession(session, message), moveMessageToEnd: (session, messageId) => view.moveMessageToEnd(session, messageId), fillKnowledgeBaseCommand: (command) => view.fillKnowledgeBaseCommand(command), refreshKnowledgeDashboard: (force) => view.refreshKnowledgeDashboard(force)
    } satisfies CodexViewTurnContext;
  }

  private createEditorActionRunnerContext(): CodexViewEditorActionContext {
    const view = this;
    return {
      get app() { return view.app; }, get plugin() { return view.plugin; }, get running() { return view.running; }, set running(value) { view.running = value; }, get activeRunId() { return view.activeRunId; }, set activeRunId(value) { view.activeRunId = value; }, get activeRunKind() { return view.activeRunKind; }, set activeRunKind(value) { view.activeRunKind = value; }, get activeRunSessionId() { return view.activeRunSessionId; }, set activeRunSessionId(value) { view.activeRunSessionId = value; }, get activeTurnId() { return view.activeTurnId; }, set activeTurnId(value) { view.activeTurnId = value; },
      get editorSummaryRun() { return view.editorSummaryRun; }, get editorActionHarnessRunId() { return view.editorActionHarnessRunId; }, set editorActionHarnessRunId(value) { view.editorActionHarnessRunId = value; }, get editorActionActiveTimeoutMs() { return view.editorActionActiveTimeoutMs; }, set editorActionActiveTimeoutMs(value) { view.editorActionActiveTimeoutMs = value; }, get editorActionRun() { return view.editorActionRun; }, set editorActionRun(value) { view.editorActionRun = value; }, get editorActionThreadId() { return view.editorActionThreadId; }, set editorActionThreadId(value) { view.editorActionThreadId = value; }, get editorActionThreadIds() { return view.editorActionThreadIds; }, get editorActionTurnIds() { return view.editorActionTurnIds; }, get editorActionCurrentItemIds() { return view.editorActionCurrentItemIds; }, get articleUnderstandingPanelState() { return view.articleUnderstandingPanelState; }, set articleUnderstandingPanelState(value) { view.articleUnderstandingPanelState = value; }, get selectedServiceTier() { return view.selectedServiceTier; },
      applyStatus: () => view.applyStatus(), armTurnWatchdog: (timeoutMs, timeoutText) => view.armTurnWatchdog(timeoutMs, timeoutText), clearTurnWatchdog: () => view.clearTurnWatchdog(), clearActiveRun: () => view.clearActiveRun(), renderToolbar: () => view.renderToolbar(), diagnoseCodexFailure: (error, model) => view.diagnoseCodexFailure(error, model), cancelEditorSummaryRun: (reason) => view.cancelEditorSummaryRun(reason), editorActionStartBlockReason: () => view.editorActionStartBlockReason(), setEditorActionStatus: (status) => view.setEditorActionStatus(status), withEditorActionTimeout: (promise, timeoutMs, message) => view.withEditorActionTimeout(promise, timeoutMs, message), prewarmEditorActionThread: () => view.prewarmEditorActionThread(), rejectEditorActionRun: (error) => view.rejectEditorActionRun(error), effectiveEditorActionModel: (availableModels, configuredModel) => view.effectiveEditorActionModel(availableModels, configuredModel), takeEditorActionThread: (turnOptions) => view.takeEditorActionThread(turnOptions), resolveEditorActionRun: (text) => view.resolveEditorActionRun(text), releaseEditorActionRunLock: (runId) => view.releaseEditorActionRunLock(runId), renderEditorActionStatus: () => view.renderEditorActionStatus(), activeProviderModels: () => view.activeProviderModels()
    } satisfies CodexViewEditorActionContext;
  }

  private createNotificationRouterContext(): CodexNotificationRouterContext {
    const view = this;
    return {
      get plugin() { return view.plugin; }, get running() { return view.running; }, set running(value) { view.running = value; }, get activeRunId() { return view.activeRunId; }, get activeRunKind() { return view.activeRunKind; }, get activeTurnId() { return view.activeTurnId; }, set activeTurnId(value) { view.activeTurnId = value; }, get turnStartedAt() { return view.turnStartedAt; }, set turnStartedAt(value) { view.turnStartedAt = value; }, get usageLoading() { return view.usageLoading; }, set usageLoading(value) { view.usageLoading = value; }, get usageError() { return view.usageError; }, set usageError(value) { view.usageError = value; },
      get editorActionRun() { return view.editorActionRun; }, get editorSummaryRun() { return view.editorSummaryRun; }, get editorActionActiveTimeoutMs() { return view.editorActionActiveTimeoutMs; }, get editorActionThreadId() { return view.editorActionThreadId; }, get editorActionThreadIds() { return view.editorActionThreadIds; }, get editorActionTurnIds() { return view.editorActionTurnIds; }, get editorActionItemIds() { return view.editorActionItemIds; }, get editorActionCurrentItemIds() { return view.editorActionCurrentItemIds; },
      isEditorActionRunActive: () => view.isEditorActionRunActive(), isEditorSummaryRunActive: () => view.isEditorSummaryRunActive(), activeRunSession: () => view.activeRunSession(), sessionForThread: (threadId) => view.sessionForThread(threadId), isKnowledgeBaseSession: (session) => view.isKnowledgeBaseSession(session), attachTurnIdToRun: (session, turnId) => view.attachTurnIdToRun(session, turnId), ensureThinkingMessage: (session, title, text) => view.ensureThinkingMessage(session, title, text), markThinkingAsStreaming: (session) => view.markThinkingAsStreaming(session), appendItemDelta: (session, itemId, role, delta, itemType, title) => view.appendItemDelta(session, itemId, role, delta, itemType, title), appendProcessDelta: (session, itemId, itemType, delta, payload) => view.appendProcessDelta(session, itemId, itemType, delta, payload), upsertProcessItem: (session, id, itemType, text, status, payload) => view.upsertProcessItem(session, id, itemType, text, status, payload),
      renderPlanUpdate: (session, params) => view.renderPlanUpdate(session, params), renderStartedItem: (session, item) => view.renderStartedItem(session, item), renderCompletedItem: (session, item) => view.renderCompletedItem(session, item), updateUsageHeader: (rateLimits, loading, error) => view.updateUsageHeader(rateLimits, loading, error), renderUsagePanel: (rateLimits, error, loading) => view.renderUsagePanel(rateLimits, error, loading), updateContextForSession: (session, tokenUsage, persist) => view.updateContextForSession(session, tokenUsage, persist), addContextCompactionMessage: (session) => view.addContextCompactionMessage(session), clearTurnWatchdog: () => view.clearTurnWatchdog(), armTurnWatchdog: (timeoutMs, timeoutText) => view.armTurnWatchdog(timeoutMs, timeoutText), finishThinkingMessage: (session, status) => view.finishThinkingMessage(session, status),
      finishRunningProcessMessages: (session, status) => view.finishRunningProcessMessages(session, status), finishPlanMessage: (session) => view.finishPlanMessage(session), clearActiveRun: () => view.clearActiveRun(), applyStatus: () => view.applyStatus(), afterTurnSettled: (sessionId, succeeded) => view.afterTurnSettled(sessionId, succeeded), diagnoseCodexFailure: (error, model) => view.diagnoseCodexFailure(error, model), rejectEditorActionRun: (error) => view.rejectEditorActionRun(error), resolveEditorActionRun: (text) => view.resolveEditorActionRun(text), rejectEditorSummaryRun: (error) => view.rejectEditorSummaryRun(error), resolveEditorSummaryRun: (text) => view.resolveEditorSummaryRun(text), releaseEditorSummaryRunLock: (runId) => view.releaseEditorSummaryRunLock(runId), addMessageToSession: (session, message) => view.addMessageToSession(session, message)
    } satisfies CodexNotificationRouterContext;
  }

  getViewType(): string {
    return VIEW_TYPE_CODEX;
  }

  getDisplayText(): string {
    return "Codex";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.render();
    await this.plugin.ensureCodexConnected();
    this.applyStatus();
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderKnowledgeDashboard();
    void this.refreshKnowledgeDashboard();
    this.prewarmActiveThread();
    this.prewarmEditorActionThread();
    void this.refreshHeaderRateLimits();
  }

  async onClose(): Promise<void> {
    this.clearTurnWatchdog();
    this.clearEditorActionStatusTimers();
    this.clearEditorSummaryTimers();
    this.clearKnowledgeBaseRunProgressTimer();
    this.clearKnowledgeDashboardHealthTooltips();
    this.rejectEditorActionRun(new Error("EchoInk Agent 侧栏已关闭"));
    this.rejectEditorSummaryRun(new Error("EchoInk Agent 侧栏已关闭"));
    await this.plugin.saveSettings(true);
  }

  applySavedComposerDefaults(): void {
    this.selectedModel = this.plugin.settings.defaultModel;
    this.selectedReasoning = this.plugin.settings.defaultReasoning;
    this.selectedServiceTier = this.plugin.settings.defaultServiceTier;
    this.selectedPermission = this.plugin.settings.defaultPermission;
    this.selectedMode = this.plugin.settings.defaultMode;
    this.renderToolbar();
  }

  refreshActiveSession(): void {
    this.resetVirtualWindow();
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    this.renderKnowledgeDashboard();
    void this.refreshKnowledgeDashboard();
    this.updateInputPlaceholder();
    this.focusInput();
  }

  refreshKnowledgeBaseDashboard(): void {
    void this.refreshKnowledgeDashboard(true);
  }

  refreshAfterBackgroundKnowledgeMessage(): void {
    this.renderTabs();
    this.renderMessages({ forceBottom: this.isMessagesNearBottom() });
    this.renderKnowledgeDashboard();
    void this.refreshKnowledgeDashboard(true);
  }

  private diagnoseCodexFailure(error: unknown, model = this.effectiveModel()): CodexErrorDiagnostic {
    return diagnoseCodexError(error, {
      model,
      providerLabel: providerConnectionLabel(this.plugin.settings),
      proxyEnabled: this.plugin.settings.proxyEnabled,
      proxyUrl: this.plugin.settings.proxyUrl
    });
  }

  handleCodexNotification(notification: CodexNotification): void {
    if (!this.notificationRouter) {
      const method = notification.method;
      if (this.activeRunKind === "knowledge-base" && (method.startsWith("item/") || method.startsWith("turn/") || method.startsWith("thread/") || method === "error")) return;
      return;
    }
    this.notificationRouter.handle(notification);
  }

  handleKnowledgeBaseCodexNotification(_notification: CodexNotification): boolean {
    if (!this.notificationRouter) return this.activeRunKind === "knowledge-base";
    return this.notificationRouter.handleKnowledgeBaseNotification();
  }

  focusInput(): void {
    window.setTimeout(() => this.inputEl?.focus(), 50);
  }

  private render(): void {
    this.clearKnowledgeDashboardHealthTooltips();
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({ cls: "codex-container" });

    const headerRefs = renderCodexHeader(this.rootEl, {
      onToggleArticlePanel: () => {
        this.articleUnderstandingPanelVisible = !this.articleUnderstandingPanelVisible;
        if (this.articleUnderstandingPanelVisible) void this.refreshArticleUnderstandingPanelSourceState();
        this.renderArticleUnderstandingPanel();
      },
      onOpenHistory: () => {
        const session = this.ensureSession();
        if (!this.isKnowledgeBaseSession(session)) return;
        void this.openKnowledgeBaseHistory(session);
      },
      onRefreshRateLimits: () => this.refreshHeaderRateLimits(),
      onOpenWorkspaceResources: () => void this.plugin.openWorkspaceResourceSettings("plugins"),
      onOpenSettings: () => this.openPluginSettings()
    });
    this.headerStatusEl = headerRefs.headerStatusEl;
    this.headerStatusTextEl = headerRefs.headerStatusTextEl;
    this.editorActionStatusEl = headerRefs.editorActionStatusEl;
    this.editorActionStatusTextEl = headerRefs.editorActionStatusTextEl;
    this.headerHistoryEl = headerRefs.headerHistoryEl;
    this.headerUsageEl = headerRefs.headerUsageEl;
    this.headerUsageTextEl = headerRefs.headerUsageTextEl;
    this.usagePanelEl = headerRefs.usagePanelEl;
    this.articleUnderstandingPanelEl = headerRefs.articleUnderstandingPanelEl;
    this.registerDomEvent(document, "click", (event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      if (!this.rootEl.contains(target)) {
        this.usagePanelEl.removeClass("is-visible");
      }
      if (shouldCloseComposerMenusForClick(target, this.rootEl, [this.skillMenuEl, this.knowledgeCommandMenuEl])) this.closeComposerMenus();
    });

    this.tabBarEl = this.rootEl.createDiv({ cls: "codex-tabs" });
    this.knowledgeDashboardEl = this.rootEl.createDiv({ cls: "codex-kb-dashboard" });
    this.messagesEl = this.rootEl.createDiv({ cls: "codex-messages" });
    this.virtualListEl = this.messagesEl.createDiv({ cls: "codex-virtual-list" });
    this.registerDomEvent(this.messagesEl, "wheel", (event) => this.messageScrollFollow.handleWheel(event as WheelEvent));
    this.registerDomEvent(this.messagesEl, "touchstart", (event) => this.messageScrollFollow.handleTouchStart(event as TouchEvent));
    this.registerDomEvent(this.messagesEl, "touchmove", (event) => this.messageScrollFollow.handleTouchMove(event as TouchEvent));
    this.registerDomEvent(this.messagesEl, "scroll", () => this.handleMessagesScroll());

    const composerRefs = renderComposerShell(this.rootEl, {
      onInputChanged: () => this.onInputChanged(),
      onPasteFiles: (event) => void this.handlePastedFiles(event),
      onSendMessage: () => void this.sendMessage(),
      onDropFiles: (event) => this.handleDroppedFiles(event)
    });
    this.queueEl = composerRefs.queueEl;
    this.attachmentsEl = composerRefs.attachmentsEl;
    this.inputEl = composerRefs.inputEl;
    this.skillMenuEl = composerRefs.skillMenuEl;
    this.knowledgeCommandMenuEl = composerRefs.knowledgeCommandMenuEl;
    this.toolbarEl = composerRefs.toolbarEl;
    this.mcpPanelEl = this.rootEl.createDiv({ cls: "codex-mcp-panel" });
    this.renderToolbar();
    this.updateInputPlaceholder();
    this.renderEditorActionStatus();
    this.renderArticleUnderstandingPanel();
  }

  private updateInputPlaceholder(): void {
    if (!this.inputEl) return;
    const session = this.ensureSession();
    this.inputEl.setAttr("placeholder", this.isKnowledgeBaseSession(session)
      ? "普通对话直接输入；查知识库用 /ask；管理用 /check /maintain"
      : session.cwd ? `问 Codex，当前工作区：${workspaceDisplayName(session.cwd)}` : "先选择工作区，再问 Codex");
    this.renderHeaderHistory();
  }

  private renderHeaderHistory(): void {
    if (!this.headerHistoryEl) return;
    const visible = this.isKnowledgeBaseSession(this.ensureSession());
    renderHeaderHistoryButton(this.headerHistoryEl, visible);
  }

  private applyStatus(): void {
    const status = this.plugin.lastStatus;
    this.headerStatusTextEl.setText(this.running ? "思考中" : status?.connected ? "活跃" : "未连接");
    this.headerStatusEl.toggleClass("has-warning", Boolean(status?.errors?.length) || !status?.connected);
    this.headerStatusEl.toggleClass("is-ok", Boolean(status?.connected && !status?.errors?.length));
    this.headerStatusEl.toggleClass("is-active", this.running);
    const providerLabel = providerConnectionLabel(this.plugin.settings);
    this.headerStatusEl.setAttr("title", status?.errors?.length ? status.errors.join("\n") : `${status?.accountLabel ?? "未连接"}\n${providerLabel}`);
    this.updateUsageHeader(status?.rateLimits ?? null, this.usageLoading, this.usageError);
    this.renderUsagePanel(status?.rateLimits ?? null, this.usageError, this.usageLoading);
    this.renderToolbar();
  }

  setEditorActionStatus(status: EditorActionStatusView): void {
    this.editorActionStatus = {
      ...status,
      startedAt: status.startedAt ?? this.editorActionStatus.startedAt ?? Date.now()
    };
    this.clearEditorActionStatusTimers();
    if (status.status === "generating") {
      this.editorActionStatusTicker = window.setInterval(() => this.renderEditorActionStatus(), 1000);
    }
    if (status.status === "confirmed" || status.status === "canceled" || status.status === "failed") {
      this.editorActionStatusResetTimer = window.setTimeout(() => {
        this.editorActionStatus = {
          status: "idle",
          understandingStatus: this.articleUnderstandingPanelState.status === "fresh" || this.articleUnderstandingPanelState.status === "reused" || this.articleUnderstandingPanelState.status === "stale"
            ? this.articleUnderstandingPanelState.status
            : undefined
        };
        this.renderEditorActionStatus();
      }, 2200);
    }
    this.renderEditorActionStatus();
  }

  private renderEditorActionStatus(): void {
    if (!this.editorActionStatusEl || !this.editorActionStatusTextEl) return;
    renderEditorActionStatusView(this.editorActionStatusEl, this.editorActionStatusTextEl, this.editorActionStatus, this.plugin.settings.editorActions.statusSlotEnabled);
    this.renderArticleUnderstandingPanel();
  }

  private renderArticleUnderstandingPanel(): void {
    if (!this.articleUnderstandingPanelEl) return;
    const settings = this.plugin.settings.editorActions;
    renderArticleUnderstandingPanelView(
      this.articleUnderstandingPanelEl,
      {
        app: this.plugin.app,
        component: this,
        visible: this.articleUnderstandingPanelVisible,
        settings,
        state: this.articleUnderstandingPanelState
      },
      {
        onRefresh: () => void this.refreshArticleUnderstandingFromPanel(),
        onClear: (filePath) => {
          delete this.plugin.settings.editorActions.articleUnderstandingCache[filePath];
          this.articleUnderstandingPanelState = {
            ...this.articleUnderstandingPanelState,
            status: settings.qualityMode === "fast" ? "idle" : "missing",
            entry: null,
            usedInLastRun: false
          };
          void this.plugin.saveSettings().then(() => this.renderEditorActionStatus());
        },
        onOpenSettings: () => {
          this.plugin.settings.settingsTab = "editorActions";
          void this.plugin.saveSettings().then(() => this.openPluginSettings());
        }
      }
    );
  }

  private clearEditorActionStatusTimers(): void {
    if (this.editorActionStatusTicker) {
      window.clearInterval(this.editorActionStatusTicker);
      this.editorActionStatusTicker = null;
    }
    if (this.editorActionStatusResetTimer) {
      window.clearTimeout(this.editorActionStatusResetTimer);
      this.editorActionStatusResetTimer = null;
    }
  }

  private async refreshHeaderRateLimits(): Promise<void> {
    const requestId = ++this.usageRequestId;
    const cachedRateLimits = this.plugin.lastStatus?.rateLimits ?? null;
    this.usageLoading = true;
    this.usageError = null;
    this.updateUsageHeader(cachedRateLimits, true, null);
    this.renderUsagePanel(cachedRateLimits, null, true);

    const status = await this.plugin.ensureCodexConnected();
    if (requestId !== this.usageRequestId) return;
    if (!status.connected || !this.plugin.codex) {
      this.usageLoading = false;
      this.usageError = "Codex 未连接";
      this.updateUsageHeader(null, false, this.usageError);
      this.renderUsagePanel(null, this.usageError, false);
      return;
    }
    const result = await this.plugin.codex.refreshRateLimits();
    if (requestId !== this.usageRequestId) return;
    const nextRateLimits = result.rateLimits ?? this.plugin.lastStatus?.rateLimits ?? null;
    const nextRateLimitsByLimitId = result.rateLimitsByLimitId ?? this.plugin.lastStatus?.rateLimitsByLimitId ?? null;
    if (this.plugin.lastStatus) {
      this.plugin.lastStatus = {
        ...this.plugin.lastStatus,
        rateLimits: nextRateLimits,
        rateLimitsByLimitId: nextRateLimitsByLimitId
      };
    }
    this.usageLoading = false;
    this.usageError = result.error;
    this.updateUsageHeader(nextRateLimits, false, result.error);
    this.renderUsagePanel(nextRateLimits, result.error, false);
  }

  private updateUsageHeader(rateLimits: RateLimitSnapshot | null, loading = false, error: string | null = null): void {
    if (!this.headerUsageTextEl) return;
    updateUsageHeaderView(this.headerUsageEl, this.headerUsageTextEl, rateLimits, loading, error);
  }

  private renderUsagePanel(rateLimits: RateLimitSnapshot | null, error?: string | null, loading = false): void {
    if (!this.usagePanelEl) return;
    renderUsagePanelView(this.usagePanelEl, rateLimits, error, loading);
  }

  private openPluginSettings(): void {
    const setting = (this.app as unknown as ObsidianSettingsApi).setting;
    if (!setting?.open || !setting?.openTabById) {
      new Notice("无法打开插件设置页");
      return;
    }
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }

  private renderTabs(): void {
    this.ensureSession();
    renderCodexTabs(
      this.tabBarEl,
      this.plugin.settings.sessions,
      this.plugin.settings.activeSessionId,
      this.plugin.settings.knowledgeBase.sessionId,
      {
        onActivate: (session) => void (async () => {
          this.plugin.settings.activeSessionId = session.id;
          await this.plugin.saveSettings(true);
          this.resetVirtualWindow();
          this.renderTabs();
          this.renderMessages({ forceBottom: true });
          this.renderToolbar();
          this.renderKnowledgeDashboard();
          void this.refreshKnowledgeDashboard();
          this.updateInputPlaceholder();
          this.prewarmActiveThread();
        })(),
        onContextMenu: (event, session) => this.openSessionMenu(event, session),
        onRename: (session, knowledgeSession) => {
          if (knowledgeSession) {
            new Notice("知识库管理频道是常驻频道，不能重命名");
            return;
          }
          void this.renameSession(session);
        },
        onCreateSession: () => void (async () => {
          this.createSession();
          this.resetVirtualWindow();
          await this.plugin.saveSettings(true);
          this.renderTabs();
          this.renderMessages({ forceBottom: true });
          this.renderToolbar();
          this.renderKnowledgeDashboard();
          void this.refreshKnowledgeDashboard();
          this.updateInputPlaceholder();
          this.prewarmActiveThread();
        })()
      }
    );
  }

  private renderMessages(options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void {
    const session = this.ensureSession();
    this.settleStaleMessages(session);
    const knowledgeSession = this.isKnowledgeBaseSession(session);
    const messages = knowledgeSession ? getDisplayKnowledgeBaseMessages(session) : session.messages;
    const hiddenCount = knowledgeSession ? getHiddenKnowledgeBaseMessages(session).length : 0;
    const renderOptions = this.messagesBottomFollowPaused ? { ...options, forceBottom: false, preserveScroll: true } : options;
    this.messageListRenderer.render({
      app: this.app,
      component: this,
      messagesEl: this.messagesEl,
      virtualListEl: this.virtualListEl,
      sessionId: session.id,
      knowledgeSession,
      messages,
      hiddenKnowledgeMessageCount: hiddenCount,
      vaultPath: this.plugin.getVaultPath(),
      readRawMessageText: (rawRef) => this.plugin.readRawMessageText(rawRef),
      onOpenKnowledgeHistory: () => void this.openKnowledgeBaseHistory(session),
      onScheduleMeasure: () => this.scheduleMeasureVirtualRows(),
      onScheduleRunProgress: () => this.scheduleKnowledgeBaseRunProgress(),
      shouldFollowBottom: () => !this.messagesBottomFollowPaused,
      options: renderOptions
    });
  }

  private renderKnowledgeDashboard(): void {
    if (!this.knowledgeDashboardEl) return;
    const session = this.ensureSession();
    renderKnowledgeDashboardView(
      this.knowledgeDashboardEl,
      {
        visible: this.isKnowledgeBaseSession(session),
        snapshot: this.knowledgeDashboardSnapshot,
        expanded: this.knowledgeDashboardExpanded,
        loading: this.knowledgeDashboardLoading,
        error: this.knowledgeDashboardError
      },
      {
        onRefresh: () => void this.refreshKnowledgeDashboard(true),
        onToggleExpanded: () => {
          this.knowledgeDashboardExpanded = !this.knowledgeDashboardExpanded;
          this.renderKnowledgeDashboard();
        },
        onOpenRulesFile: (snapshot) => void this.openKnowledgeDashboardRulesFile(snapshot)
      },
      this.knowledgeDashboardTooltipState
    );
  }

  private async refreshKnowledgeDashboard(force = false): Promise<void> {
    if (!this.knowledgeDashboardEl) return;
    const session = this.ensureSession();
    if (!this.isKnowledgeBaseSession(session)) {
      this.renderKnowledgeDashboard();
      return;
    }
    if (this.knowledgeDashboardLoading && !force) return;
    const manager = this.plugin.getKnowledgeBaseManager();
    if (!manager) return;
    const requestId = ++this.knowledgeDashboardRequestId;
    this.knowledgeDashboardLoading = true;
    this.knowledgeDashboardError = "";
    this.renderKnowledgeDashboard();
    try {
      const snapshot = await manager.getDashboardSnapshot();
      if (requestId !== this.knowledgeDashboardRequestId) return;
      this.knowledgeDashboardSnapshot = snapshot;
    } catch (error) {
      if (requestId !== this.knowledgeDashboardRequestId) return;
      this.knowledgeDashboardError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === this.knowledgeDashboardRequestId) {
        this.knowledgeDashboardLoading = false;
        this.renderKnowledgeDashboard();
      }
    }
  }

  private async openKnowledgeDashboardRulesFile(snapshot: KnowledgeBaseDashboardSnapshot): Promise<void> {
    if (!snapshot.rulesFileExists) {
      new Notice(`知识库规则文件缺失：${snapshot.rulesFilePath}。请到设置里修正规则文件。`);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizePath(snapshot.rulesFilePath));
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    new Notice(`没有在当前 Obsidian 仓库找到：${snapshot.rulesFilePath}`);
  }

  private clearKnowledgeDashboardHealthTooltips(): void {
    clearKnowledgeDashboardTooltipState(this.knowledgeDashboardTooltipState);
  }

  private renderToolbar(): void {
    if (!this.toolbarEl) return;
    this.renderQueue();
    this.renderAttachments();

    const session = this.ensureSession();
    const knowledgeSession = this.isKnowledgeBaseSession(session);
    const knowledgeManager = this.plugin.getKnowledgeBaseManager();
    const knowledgeTaskRunning = Boolean(knowledgeManager?.isRunning);
    const workspacePath = normalizeWorkspacePath(session.cwd);
    const refs = renderComposerToolbar(
      this.toolbarEl,
      {
        session,
        knowledgeSession,
        knowledgeTaskRunning,
        knowledgeBackend: this.resolvedKnowledgeBackend(),
        selectedSkill: this.selectedSkill,
        selectedPermission: this.selectedPermission,
        running: this.running,
        viewRunKind: this.activeRunKind,
        hasDraft: this.hasComposerDraft(),
        hasQueuedItems: this.turnQueue.hasQueuedItems(session.id),
        currentComposerSummary: this.currentComposerSummary(),
        currentComposerSummaryTitle: this.currentComposerSummaryTitle(),
        currentKnowledgeComposerSummaryTitle: this.currentKnowledgeComposerSummaryTitle(),
        workspacePath,
        workspaceDisplayName: workspacePath ? workspaceDisplayName(workspacePath) : "",
        workspaceValid: workspacePath ? workspaceDirectoryExists(workspacePath) : false
      },
      {
        onOpenAddMenu: (event) => this.openAddMenu(event),
        onOpenSkillMenu: (event) => this.openSkillMenu(event),
        onCaptureWeChatArticle: () => this.runKnowledgeBaseShortcut("公众号收集", async () => {
          const paths = await this.plugin.getKnowledgeBaseManager()?.captureWeChatArticle();
          return paths?.length ? `已收集公众号：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未收集内容。";
        }),
        onCaptureWebPage: () => this.runKnowledgeBaseShortcut("网页收藏", async () => {
          const paths = await this.plugin.getKnowledgeBaseManager()?.captureWebPage();
          return paths?.length ? `已收藏网页：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未收藏内容。";
        }),
        onPickKnowledgeBaseFiles: () => this.pickKnowledgeBaseFiles(),
        onOpenKnowledgeModelMenu: (event) => this.openKnowledgeModelMenu(event),
        onOpenKnowledgeCommandMenu: (event) => this.openKnowledgeCommandMenu(event),
        onPermissionChange: (value) => {
          this.selectedPermission = value;
          this.persistComposerDefaults();
          this.renderToolbar();
        },
        onOpenWorkspaceMenu: (event, nextSession) => this.openWorkspaceMenu(event, nextSession),
        onOpenModelMenu: (event) => this.openModelMenu(event),
        onMicInput: () => new Notice("语音输入暂未接入"),
        onCancelKnowledgeTask: () => {
          this.pauseQueueForSession(session.id);
          void knowledgeManager?.cancelMaintenance();
        },
        onStopTurn: () => void this.stopTurn(),
        onEnqueueDraft: () => void this.enqueueComposerDraft(),
        onResumeQueue: (sessionId) => void this.resumeQueuedTurns(sessionId),
        onSendMessage: () => void this.sendMessage()
      }
    );
    if (!knowledgeSession) {
      this.contextEl = refs.contextEl!;
      this.contextRingEl = refs.contextRingEl!;
      this.contextValueEl = refs.contextValueEl!;
      this.updateContext(session.tokenUsage, false);
    }
  }

  private renderQueue(): void {
    if (!this.queueEl) return;
    const session = this.ensureSession();
    renderTurnQueue(
      this.queueEl,
      {
        items: this.turnQueue.itemsForSession(session.id),
        paused: this.turnQueue.isSessionQueuePaused(session.id),
        canResume: !this.running && !this.plugin.getKnowledgeBaseManager()?.isRunning,
        draggedItemId: this.draggedQueueItemId
      },
      {
        onResume: () => void this.resumeQueuedTurns(session.id),
        onDragStart: (itemId) => {
          this.draggedQueueItemId = itemId;
        },
        onDragEnd: () => {
          this.draggedQueueItemId = "";
        },
        onReorder: (sessionId, sourceId, index) => {
          this.turnQueue.reorderQueuedItem(sessionId, sourceId, index);
          this.renderQueue();
        },
        onRemove: (sessionId, itemId) => {
          this.turnQueue.removeQueuedItem(sessionId, itemId);
          this.renderQueue();
          this.renderToolbar();
        }
      }
    );
  }

  private renderAttachments(): void {
    if (!this.attachmentsEl) return;
    renderComposerAttachments(this.attachmentsEl, { selectedSkill: this.selectedSkill, attachments: this.attachments }, {
      onRemoveSkill: () => {
        this.selectedSkill = null;
        this.renderAttachments();
        this.renderToolbar();
      },
      onRemoveAttachment: (attachmentPath) => {
        this.attachments = this.attachments.filter((attachment) => attachment.path !== attachmentPath);
        this.renderAttachments();
      }
    });
  }

  private closeComposerMenus(): void {
    this.skillMenuEl?.removeClass("is-visible");
    this.knowledgeCommandMenuEl?.removeClass("is-visible");
  }

  private openSkillMenu(event: MouseEvent): void {
    showSkillMenu(
      event,
      { skillMenuEl: this.skillMenuEl, knowledgeCommandMenuEl: this.knowledgeCommandMenuEl },
      { skillsRequested: this.skillsRequested },
      {
        onSkillsRequested: () => {
          this.skillsRequested = true;
        },
        onLoadSkills: () => this.plugin.ensureEchoInkSkillResourcesLoaded(true),
        onRenderMatches: () => this.renderSkillMatches()
      }
    );
  }

  private openAddMenu(event: MouseEvent): void {
    showAddMenu(event, {
      onAttachActiveFile: () => this.attachActiveFile(),
      onPickFiles: (imagesOnly) => this.pickFiles(imagesOnly),
      onToggleMcpPanel: () => void this.toggleMcpPanel()
    });
  }

  private openWorkspaceMenu(event: MouseEvent, session: StoredSession): void {
    const workspacePath = normalizeWorkspacePath(session.cwd);
    showWorkspaceMenu(event, workspacePath, {
      onChooseWorkspace: () => void this.chooseChatWorkspace(session),
      onRevealWorkspace: () => showItemInFinder(workspacePath),
      onClearWorkspace: () => void this.clearChatWorkspace(session)
    });
  }

  private async chooseChatWorkspace(session: StoredSession): Promise<boolean> {
    if (this.running) {
      new Notice("当前会话运行中，结束后再切换工作区");
      return false;
    }
    const pickedPath = await pickWorkspaceDirectory(session.cwd);
    const selectedPath = pickedPath === undefined
      ? await textInputModal(this.app, "选择工作区", "文件夹路径", session.cwd)
      : pickedPath;
    if (!selectedPath) return false;
    const workspacePath = normalizeWorkspacePath(selectedPath);
    if (!workspaceDirectoryExists(workspacePath)) {
      new Notice("请选择一个存在的文件夹作为工作区");
      return false;
    }
    const changed = normalizeWorkspacePath(session.cwd) !== workspacePath;
    session.cwd = workspacePath;
    if (changed) {
      delete session.threadId;
      delete session.tokenUsage;
    }
    session.updatedAt = Date.now();
    await this.plugin.saveSettings(true);
    this.renderToolbar();
    this.updateInputPlaceholder();
    this.renderMessages();
    this.prewarmActiveThread();
    new Notice(changed ? `工作区已设为：${workspaceDisplayName(workspacePath)}，下一轮将开启新线程` : `工作区已设为：${workspaceDisplayName(workspacePath)}`);
    return true;
  }

  private async clearChatWorkspace(session: StoredSession): Promise<void> {
    if (this.running) {
      new Notice("当前会话运行中，结束后再清除工作区");
      return;
    }
    session.cwd = "";
    delete session.threadId;
    delete session.tokenUsage;
    session.updatedAt = Date.now();
    await this.plugin.saveSettings(true);
    this.renderToolbar();
    this.updateInputPlaceholder();
    this.renderMessages();
    new Notice("已清除工作区");
  }

  private async clearKnowledgeBasePage(session: StoredSession): Promise<void> {
    if (!this.isKnowledgeBaseSession(session)) return;
    if (this.running || this.plugin.getKnowledgeBaseManager()?.isRunning) {
      new Notice("知识库任务运行中，结束后再清空页面");
      return;
    }
    const result = clearKnowledgeBaseVisibleHistory(session);
    this.inputEl.value = "";
    this.closeComposerMenus();
    this.attachments = [];
    this.selectedSkill = null;
    this.resetVirtualWindow();
    await this.plugin.saveSettings(true);
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    this.updateInputPlaceholder();
    new Notice(result.hiddenCount ? `已清空当前页面，${result.hiddenCount} 条历史仍可在 /history 查看` : "已开启新的知识库上下文");
  }

  private async openKnowledgeBaseHistory(session: StoredSession): Promise<void> {
    if (!this.isKnowledgeBaseSession(session)) return;
    await this.plugin.saveSettings(true);
    const index = await this.plugin.readKnowledgeBaseHistoryIndex().catch((error) => {
      console.error("Codex knowledge history read failed", error);
      return null;
    });
    const historySession = index?.sessions.find((item) => item.sessionId === session.id);
    const days = historySession?.days ?? [];
    if (!days.length) {
      new Notice("没有知识库历史");
      return;
    }
    new KnowledgeBaseHistoryModal(
      this.app,
      days,
      (date) => this.plugin.readKnowledgeBaseHistoryDay(session.id, date),
      (date) => this.restoreKnowledgeBaseHistoryDate(session, date)
    ).open();
  }

  private async restoreKnowledgeBaseHistoryDate(session: StoredSession, date: string): Promise<void> {
    const messages = await this.plugin.readKnowledgeBaseHistoryDay(session.id, date);
    if (!messages.length) {
      new Notice("这一天没有可恢复的历史");
      return;
    }
    session.messages = messages;
    session.historyActiveDate = date;
    delete session.messagesHiddenBefore;
    delete session.threadId;
    delete session.tokenUsage;
    delete session.knowledgeContext;
    session.updatedAt = Date.now();
    this.resetVirtualWindow();
    await this.plugin.saveSettings(true);
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    new Notice("已把这一天恢复到页面显示；模型上下文会从新线程开始");
  }

  private async ensureChatWorkspaceSelected(session: StoredSession): Promise<boolean> {
    const workspacePath = normalizeWorkspacePath(session.cwd);
    if (workspacePath && workspaceDirectoryExists(workspacePath)) return true;
    const picked = await this.chooseChatWorkspace(session);
    if (!picked) new Notice("普通会话需要先选择一个文件夹作为工作区");
    return picked;
  }

  private openKnowledgeCommandMenu(event: MouseEvent): void {
    showKnowledgeCommandMenu(event, (command) => this.fillKnowledgeBaseCommand(command));
  }

  private openKnowledgeModelMenu(event: MouseEvent): void {
    showKnowledgeModelMenu(event, this.composerModelMenuState(), {
      onSelectModel: (model) => this.selectComposerModel(model),
      onSelectReasoning: (reasoning) => this.selectComposerReasoning(reasoning)
    });
  }

  fillKnowledgeBaseCommand(command: string): void {
    this.inputEl.value = command;
    this.inputEl.setSelectionRange(command.length, command.length);
    this.closeComposerMenus();
    this.focusInput();
  }

  async submitKnowledgeBaseCommand(command: string): Promise<void> {
    await this.plugin.activateKnowledgeBaseChannel();
    this.fillKnowledgeBaseCommand(command);
    await this.sendMessage();
  }

  private openModelMenu(event: MouseEvent): void {
    showModelMenu(event, this.composerModelMenuState(), {
      onSelectModel: (model) => this.selectComposerModel(model),
      onSelectReasoning: (reasoning) => this.selectComposerReasoning(reasoning),
      onSelectServiceTier: (tier) => this.selectComposerServiceTier(tier),
      onSelectMode: (mode) => this.selectComposerMode(mode)
    });
  }

  private composerModelMenuState() {
    return {
      providerModels: this.activeProviderModels(),
      availableModels: this.plugin.lastStatus?.models ?? [],
      selectedModel: this.selectedModel,
      defaultModel: this.plugin.settings.defaultModel,
      effectiveModel: this.effectiveModel(),
      selectedReasoning: this.selectedReasoning,
      selectedServiceTier: this.selectedServiceTier,
      selectedMode: this.selectedMode
    };
  }

  private selectComposerModel(model: string): void {
    this.selectedModel = model;
    this.persistComposerDefaults();
    this.renderToolbar();
  }

  private selectComposerReasoning(reasoning: ReasoningEffort): void {
    this.selectedReasoning = reasoning;
    this.persistComposerDefaults();
    this.renderToolbar();
  }

  private selectComposerServiceTier(tier: ServiceTierChoice): void {
    this.selectedServiceTier = tier;
    this.persistComposerDefaults();
    this.renderToolbar();
  }

  private selectComposerMode(mode: UiMode): void {
    this.selectedMode = mode;
    this.persistComposerDefaults();
    this.renderToolbar();
  }

  private currentComposerSummary(): string {
    return `${shortModelLabel(this.effectiveModel())} ${compactReasoningLabel(this.selectedReasoning)}`;
  }

  private currentComposerSummaryTitle(): string {
    return `模型：${this.effectiveModel() || "自动"}\n思考：${labelFor(this.selectedReasoning)}\n速度：${labelFor(this.selectedServiceTier)}\n模式：${labelFor(this.selectedMode)}`;
  }

  private currentKnowledgeComposerSummaryTitle(): string {
    return `知识库模型：${this.effectiveModel() || "自动"}\n思考强度：${labelFor(this.selectedReasoning)}`;
  }

  private persistComposerDefaults(): void {
    this.plugin.settings.defaultModel = this.selectedModel;
    this.plugin.settings.defaultReasoning = this.selectedReasoning;
    this.plugin.settings.defaultServiceTier = this.selectedServiceTier;
    this.plugin.settings.defaultPermission = this.selectedPermission;
    this.plugin.settings.defaultMode = this.selectedMode;
    void this.plugin.saveSettings(true).catch((error) => {
      console.error("Codex composer defaults save failed", error);
      new Notice(`运行参数保存失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private openSessionMenu(event: MouseEvent, session: StoredSession): void {
    showSessionMenu(event, this.isKnowledgeBaseSession(session), {
      onRename: () => void this.renameSession(session),
      onDelete: () => void this.deleteSession(session.id)
    });
  }

  private async renameSession(session: StoredSession): Promise<void> {
    const name = await textInputModal(this.app, "重命名会话", "名称", session.title);
    if (!name) return;
    session.title = name;
    if (session.threadId) await this.plugin.codex?.setThreadName(session.threadId, name).catch(swallowError("rename Codex chat thread"));
    await this.plugin.saveSettings();
    this.renderTabs();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const sessions = this.plugin.settings.sessions;
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return;
    if (this.isKnowledgeBaseSession(sessions[index])) {
      new Notice("知识库管理频道不能删除");
      return;
    }
    this.turnQueue.clearSessionQueue(sessionId);
    const wasActive = this.plugin.settings.activeSessionId === sessionId;
    sessions.splice(index, 1);
    if (!sessions.length) {
      this.createSession();
    } else if (wasActive) {
      this.plugin.settings.activeSessionId = sessions[Math.max(0, index - 1)]?.id ?? sessions[0].id;
      this.resetVirtualWindow();
    }
    await this.plugin.saveSettings();
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    new Notice("已删除会话");
  }

  private onInputChanged(): void {
    this.skillMenuEl.removeClass("is-visible");
    this.renderToolbar();
    const query = knowledgeCommandQueryForInput(this.inputEl.value, this.isKnowledgeBaseSession(this.ensureSession()));
    if (query === null) {
      this.knowledgeCommandMenuEl.removeClass("is-visible");
      return;
    }
    this.renderKnowledgeCommandMatches(query);
  }

  private renderSkillMatches(query = ""): void {
    renderSkillMatchesView(
      this.skillMenuEl,
      query,
      {
        skills: skillResourcesForScope(this.currentEchoInkResourceCatalog(), "chat", this.plugin.settings.resources.enabledByScope),
        selectedSkill: this.selectedSkill
      },
      {
        onSelectSkill: (skill) => {
        this.selectedSkill = skill;
        this.skillMenuEl.removeClass("is-visible");
        this.renderAttachments();
        this.renderToolbar();
        this.inputEl.focus();
        }
      }
    );
  }

  private renderKnowledgeCommandMatches(query: string): void {
    renderKnowledgeCommandMatchesView(this.knowledgeCommandMenuEl, query, (command) => this.fillKnowledgeBaseCommand(command));
  }

  private hasComposerDraft(): boolean {
    return Boolean(this.inputEl?.value.trim() || this.attachments.length || this.selectedSkill);
  }

  private clearComposerDraft(): void {
    this.inputEl.value = "";
    this.closeComposerMenus();
    this.attachments = [];
    this.selectedSkill = null;
  }

  private composerStateForSession(session: StoredSession): ComposerPrimaryActionState {
    const knowledgeManager = this.plugin.getKnowledgeBaseManager();
    return composerStateForRuntimeState({
      viewRunning: this.running,
      viewRunKind: this.activeRunKind,
      globalKnowledgeTaskRunning: Boolean(knowledgeManager?.isRunning),
      hasDraft: this.hasComposerDraft(),
      hasQueuedItems: this.turnQueue.hasQueuedItems(session.id)
    });
  }

  private pauseQueueForSession(sessionId: string): void {
    if (!this.turnQueue.hasQueuedItems(sessionId)) return;
    this.turnQueue.pauseSessionQueue(sessionId);
    this.renderQueue();
    this.renderToolbar();
  }

  private sessionById(sessionId: string): StoredSession | null {
    return this.plugin.settings.sessions.find((session) => session.id === sessionId) ?? null;
  }

  private async sendMessage(): Promise<void> {
    await sendMessageRunner(this.turnRunnerContext);
  }

  private async enqueueComposerDraft(): Promise<void> {
    await enqueueComposerDraftRunner(this.turnRunnerContext);
  }

  private async resumeQueuedTurns(sessionId: string): Promise<void> {
    await resumeQueuedTurnsRunner(this.turnRunnerContext, sessionId);
  }

  private async afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void> {
    await afterTurnSettledRunner(this.turnRunnerContext, sessionId, succeeded);
  }

  private async startNextQueuedTurn(sessionId: string): Promise<void> {
    await startNextQueuedTurnRunner(this.turnRunnerContext, sessionId);
  }

  private async createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> {
    return await createQueuedTurnFromComposerRunner(this.turnRunnerContext, options);
  }

  private async startQueuedTurnItem(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> {
    return await startQueuedTurnItemRunner(this.turnRunnerContext, item, source);
  }

  private async startQueuedTurnItemSafely(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> {
    return await startQueuedTurnItemSafelyRunner(this.turnRunnerContext, item, source);
  }

  private async startChatTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> {
    return await startChatTurnRunner(this.turnRunnerContext, session, item, source);
  }

  private async startKnowledgeBaseTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"completed" | "failed"> {
    return await startKnowledgeBaseTurnRunner(this.turnRunnerContext, session, item, source);
  }

  private async runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void> {
    await runKnowledgeBaseShortcutRunner(this.turnRunnerContext, label, runner);
  }

  async sendEditorActionRequest(request: EditorActionRequest): Promise<string> {
    return await sendEditorActionRequestRunner(this.editorActionRunnerContext, request);
  }

  private async ensureArticleUnderstanding(request: EditorActionRequest, availableModels: string[], model: string, timeoutMs: number, forceRefresh = false): Promise<ArticleUnderstandingEntry | null> {
    return await ensureArticleUnderstandingRunner(this.editorActionRunnerContext, request, availableModels, model, timeoutMs, forceRefresh);
  }

  private async runEditorActionPromptTurn(input: {
    prompt: string;
    actionLabel: string;
    qualityMode: EditorActionQualityMode;
    modeLabel: string;
    model: string;
    phase: "understanding" | "generating" | "reviewing";
    statusMessage: string;
    timeoutMs: number;
    startedAt: number;
  }): Promise<string> {
    return await runEditorActionPromptTurnRunner(this.editorActionRunnerContext, input);
  }

  private setArticleUnderstandingPanelState(state: ArticleUnderstandingPanelState): void {
    setArticleUnderstandingPanelStateRunner(this.editorActionRunnerContext, state);
  }

  private async refreshArticleUnderstandingPanelSourceState(): Promise<void> {
    await refreshArticleUnderstandingPanelSourceStateRunner(this.editorActionRunnerContext);
  }

  private async refreshArticleUnderstandingFromPanel(): Promise<void> {
    await refreshArticleUnderstandingFromPanelRunner(this.editorActionRunnerContext);
  }

  private async currentArticleUnderstandingSource(): Promise<EditorActionSummarySource | null> {
    return await currentArticleUnderstandingSourceRunner(this.editorActionRunnerContext);
  }

  private async stopTurn(): Promise<void> {
    if (this.isEditorActionRunActive()) {
      if (this.editorActionThreadId && this.activeTurnId) {
        await this.plugin.codex?.interruptTurn(this.editorActionThreadId, this.activeTurnId).catch(swallowError("cancel editor action Codex turn"));
      }
      this.rejectEditorActionRun(new Error("写作操作已中断"));
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.clearActiveRun();
      this.editorActionCurrentItemIds.clear();
      this.setEditorActionStatus({ status: "canceled", message: "已中断" });
      this.applyStatus();
      return;
    }
    const session = this.activeRunSession();
    this.pauseQueueForSession(session.id);
    if (!session.threadId || !this.activeTurnId) return;
    await this.plugin.codex?.interruptTurn(session.threadId, this.activeTurnId).catch(swallowError("cancel active Codex turn"));
    if (this.editorActionRun?.runId === this.activeRunId) this.rejectEditorActionRun(new Error("写作操作已中断"));
    this.running = false;
    this.activeTurnId = "";
    this.editorActionActiveTimeoutMs = 0;
    this.clearTurnWatchdog();
    this.finishThinkingMessage(session, "中断");
    this.finishRunningProcessMessages(session, "interrupted");
    this.clearActiveRun();
    this.applyStatus();
    void this.plugin.saveSettings(true);
  }

  private settleStaleMessages(session: StoredSession): void {
    if (this.running) return;
    if (this.isKnowledgeBaseSession(session) && this.plugin.getKnowledgeBaseManager()?.isRunning) return;
    const count = settleStaleRunningMessages(session.messages);
    if (!count) return;
    this.activeThinkingMessageId = "";
    this.activePlanMessageId = "";
    this.activeItemMessages.clear();
    void this.plugin.saveSettings();
  }

  private armTurnWatchdog(timeoutMs = CHAT_TURN_WATCHDOG_MS, timeoutText?: string): void {
    this.clearTurnWatchdog();
    this.turnWatchdog = window.setTimeout(() => {
      this.turnWatchdog = null;
      if (!this.running) return;
      const timedOutThreadId = this.editorActionThreadId;
      const timedOutTurnId = this.activeTurnId;
      this.running = false;
      if (this.isEditorActionRunActive()) {
        if (timedOutThreadId && timedOutTurnId) {
          void this.plugin.codex?.interruptTurn(timedOutThreadId, timedOutTurnId).catch(swallowError("interrupt timed out editor action Codex turn"));
        }
        this.rejectEditorActionRun(new Error("写作操作响应超时"));
        this.setEditorActionStatus({ status: "failed", message: "响应超时", error: "写作操作响应超时" });
        this.activeTurnId = "";
        this.clearActiveRun();
        this.editorActionCurrentItemIds.clear();
        this.applyStatus();
        this.prewarmEditorActionThread();
        return;
      }
      this.activeTurnId = "";
      const session = this.activeRunSession();
      const knowledgeSession = this.isKnowledgeBaseSession(session);
      const shouldPauseQueue = this.activeRunKind === "chat";
      if (knowledgeSession && session.threadId && timedOutTurnId) {
        void this.plugin.codex?.interruptTurn(session.threadId, timedOutTurnId).catch(swallowError("interrupt timed out knowledge base Codex turn"));
      }
      this.finishThinkingMessage(session, "失败");
      this.finishRunningProcessMessages(session, "error");
      this.addMessageToSession(session, {
        role: "system",
        title: "响应超时",
        itemType: "error",
        text: timeoutText ?? turnWatchdogTimeoutText(timeoutMs)
      });
      this.clearActiveRun();
      this.applyStatus();
      void this.plugin.saveSettings(true);
      if (shouldPauseQueue) void this.afterTurnSettled(session.id, false);
    }, timeoutMs);
  }

  private clearTurnWatchdog(): void {
    if (!this.turnWatchdog) return;
    window.clearTimeout(this.turnWatchdog);
    this.turnWatchdog = null;
  }

  private resolveEditorActionRun(text: string): void {
    const run = this.editorActionRun;
    if (!run) return;
    this.editorActionRun = null;
    run.resolve(text);
  }

  private rejectEditorActionRun(error: Error): void {
    const run = this.editorActionRun;
    if (!run) return;
    this.editorActionRun = null;
    run.reject(error);
  }

  private editorActionStartBlockReason(): string | null {
    if (this.editorActionHarnessRunId) return "Agent 正在处理上一轮，请稍后再试";
    const reason = editorActionStartBlockReason({
      running: this.running,
      activeRunId: this.activeRunId,
      activeTurnId: this.activeTurnId,
      hasEditorActionRun: Boolean(this.editorActionRun)
    });
    if (!reason && this.running) {
      this.running = false;
      this.clearTurnWatchdog();
      this.applyStatus();
    }
    return reason;
  }

  private releaseEditorActionRunLock(runId: string): void {
    if (this.activeRunId && this.activeRunId !== runId) return;
    this.running = false;
    this.activeTurnId = "";
    this.clearTurnWatchdog();
    this.clearActiveRun();
    this.editorActionCurrentItemIds.clear();
    this.applyStatus();
  }

  private async takeEditorActionThread(turnOptions: ReturnType<typeof buildEditorActionTurnOptions>): Promise<string> {
    if (this.editorActionPrewarmThreadId) {
      const threadId = this.editorActionPrewarmThreadId;
      this.editorActionPrewarmThreadId = "";
      return threadId;
    }
    if (this.editorActionPrewarmPromise) {
      const threadId = await this.editorActionPrewarmPromise.catch(() => null);
      if (threadId) {
        if (this.editorActionPrewarmThreadId === threadId) this.editorActionPrewarmThreadId = "";
        return threadId;
      }
    }
    const started = await this.plugin.codex!.startThread(turnOptions);
    this.editorActionThreadIds.add(started.threadId);
    return started.threadId;
  }

  private prewarmEditorActionThread(): void {
    if (this.editorActionPrewarmThreadId || this.editorActionPrewarmPromise || this.running) return;
    this.editorActionPrewarmPromise = this.createEditorActionPrewarmThread()
      .catch(() => null)
      .finally(() => {
        this.editorActionPrewarmPromise = null;
      });
  }

  private async createEditorActionPrewarmThread(): Promise<string | null> {
    const status = await this.plugin.ensureCodexConnected(false, { silent: true });
    if (!status.connected || !this.plugin.codex || this.running) return null;
    const modeConfig = resolveEditorActionModeConfig(this.plugin.settings.editorActions);
    const turnOptions = {
      ...buildEditorActionTurnOptions({
        model: this.effectiveEditorActionModel(status.models.map((model) => model.model), modeConfig.model),
        serviceTier: this.selectedServiceTier,
        timeoutMs: this.plugin.settings.editorActions.timeoutMs,
        workspaceResources: { plugins: {}, mcpServers: {}, skills: {} }
      }),
      requestTimeoutMs: 15000
    };
    const started = await this.plugin.codex.startThread(turnOptions);
    if (this.running || this.editorActionPrewarmThreadId) return null;
    this.editorActionThreadIds.add(started.threadId);
    this.editorActionPrewarmThreadId = started.threadId;
    return started.threadId;
  }

  private isEditorSummaryRunActive(): boolean {
    return Boolean(this.editorSummaryRun && this.editorSummaryRun.runId === this.activeRunId);
  }

  private resolveEditorSummaryRun(text: string): void {
    const run = this.editorSummaryRun;
    if (!run) return;
    this.editorSummaryRun = null;
    run.resolve(text);
  }

  private rejectEditorSummaryRun(error: Error): void {
    const run = this.editorSummaryRun;
    if (!run) return;
    this.editorSummaryRun = null;
    run.reject(error);
  }

  private cancelEditorSummaryRun(reason: string): void {
    const run = this.editorSummaryRun;
    if (!run) return;
    if (run.threadId && this.activeRunId === run.runId && this.activeTurnId) {
      void this.plugin.codex?.interruptTurn(run.threadId, this.activeTurnId).catch(swallowError("cancel editor summary Codex turn"));
    }
    this.rejectEditorSummaryRun(new Error(reason));
    this.releaseEditorSummaryRunLock(run.runId);
  }

  private armEditorSummaryTimeout(timeoutMs: number): void {
    this.clearEditorSummaryTimeout();
    this.editorSummaryTimeout = window.setTimeout(() => {
      const run = this.editorSummaryRun;
      if (!run) return;
      if (run.threadId && this.activeTurnId) {
        void this.plugin.codex?.interruptTurn(run.threadId, this.activeTurnId).catch(swallowError("interrupt timed out editor summary Codex turn"));
      }
      this.rejectEditorSummaryRun(new Error("摘要生成超时"));
      this.releaseEditorSummaryRunLock(run.runId);
    }, timeoutMs);
  }

  private clearEditorSummaryTimers(): void {
    this.clearEditorSummaryTimeout();
  }

  private clearEditorSummaryTimeout(): void {
    if (!this.editorSummaryTimeout) return;
    window.clearTimeout(this.editorSummaryTimeout);
    this.editorSummaryTimeout = null;
  }

  private releaseEditorSummaryRunLock(runId?: string): void {
    this.clearEditorSummaryTimeout();
    if ((runId && this.activeRunId === runId) || this.isEditorSummaryRunActive()) {
      this.running = false;
      this.clearActiveRun();
      this.editorActionCurrentItemIds.clear();
      this.applyStatus();
    }
  }

  private isEditorActionRunActive(): boolean {
    return Boolean(this.editorActionRun && this.editorActionRun.runId === this.activeRunId);
  }

  private withEditorActionTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

  private currentTurnOptions(session?: StoredSession) {
    const knowledgeSession = session ? this.isKnowledgeBaseSession(session) : false;
    const cwd = session && !knowledgeSession ? normalizeWorkspacePath(session.cwd) : "";
    const catalog = this.currentEchoInkResourceCatalog();
    const resourceScope = knowledgeSession ? "knowledge" : "chat";
    const workspaceResources = workspaceResourcesFromEchoInkResources(catalog, resourceScope, this.plugin.settings.resources.enabledByScope);
    return {
      ...(cwd ? { cwd } : {}),
      model: this.effectiveModel(),
      reasoning: this.selectedReasoning,
      serviceTier: this.selectedServiceTier,
      permission: this.selectedPermission,
      mode: this.selectedMode,
      mcpEnabled: hasEnabledMcpResources(catalog, resourceScope, this.plugin.settings.resources.enabledByScope),
      workspaceResources
    };
  }

  private currentEchoInkResourceCatalog(): EchoInkResource[] {
    return buildEchoInkResourceCatalog({ settings: this.plugin.settings.resources });
  }

  private activeProviderModels(): string[] {
    if (this.plugin.settings.providerMode !== "custom-api") return [];
    const provider = getActiveApiProvider(this.plugin.settings);
    return provider ? getApiProviderModels(provider) : [];
  }

  private resolvedKnowledgeBackend(): AgentBackendMode {
    const configured = this.plugin.settings.knowledgeBase.backend;
    return configured === "default" ? this.plugin.settings.agentBackend : configured;
  }

  private effectiveModel(): string {
    const providerModels = this.activeProviderModels();
    if (providerModels.length) {
      return providerModels.includes(this.selectedModel) ? this.selectedModel : providerModels[0];
    }
    return this.selectedModel || this.plugin.settings.defaultModel || "";
  }

  private effectiveEditorActionModel(availableModels: string[] = [], configuredModel = this.plugin.settings.editorActions.model): string {
    const providerModels = this.activeProviderModels();
    return resolveEditorActionModel({
      configuredModel,
      availableModels: providerModels.length ? providerModels : availableModels,
      fallbackModel: this.effectiveModel()
    });
  }

  private prewarmActiveThread(): void {
    const session = this.ensureSession();
    if (this.isKnowledgeBaseSession(session)) return;
    if (session.threadId || this.running) return;
    if (!normalizeWorkspacePath(session.cwd) || !workspaceDirectoryExists(session.cwd)) return;
    if (this.threadPrewarmPromise && this.threadPrewarmSessionId === session.id) return;
    this.threadPrewarmSessionId = session.id;
    this.threadPrewarmPromise = this.startThreadForSession(session)
      .catch(() => false)
      .finally(() => {
        if (this.threadPrewarmSessionId === session.id) {
          this.threadPrewarmPromise = null;
          this.threadPrewarmSessionId = "";
        }
      });
  }

  private async startThreadForSession(session: StoredSession): Promise<boolean> {
    if (session.threadId) return true;
    if (!normalizeWorkspacePath(session.cwd) || !workspaceDirectoryExists(session.cwd)) return false;
    const status = await this.plugin.ensureCodexConnected();
    if (!status.connected || !this.plugin.codex || session.threadId) return Boolean(session.threadId);
    const started = await this.plugin.codex.startThread(this.currentTurnOptions(session));
    session.threadId = started.threadId;
    await this.plugin.saveSettings();
    return true;
  }

  private appendItemDelta(session: StoredSession, itemId: string, role: ChatMessage["role"], delta: string, itemType: string, title: string): void {
    if (!delta) return;
    if (this.editorActionRun?.runId === this.activeRunId && role === "assistant" && itemType === "assistant") {
      this.editorActionRun.text += delta;
    }
    let messageId = this.activeItemMessages.get(itemId);
    let message = messageId ? session.messages.find((item) => item.id === messageId) : null;
    if (!message) {
      message = {
        id: itemId || newId("msg"),
        role,
        text: "",
        itemType,
        title,
        runId: this.activeRunId || undefined,
        turnId: this.activeTurnId || undefined,
        createdAt: Date.now()
      };
      session.messages.push(message);
      this.activeItemMessages.set(itemId, message.id);
    }
    message.text += delta;
    session.updatedAt = Date.now();
    this.renderMessagesIfActive(session, message);
  }

  private appendProcessDelta(session: StoredSession, itemId: string, itemType: string, delta: string, payload: unknown): void {
    if (!delta) return;
    let messageId = this.activeItemMessages.get(itemId);
    let message = messageId ? session.messages.find((item) => item.id === messageId) : null;
    const payloadRecord = processPayloadRecord(payload);
    const summaryPayload = { ...payloadRecord, status: payloadRecord.status ?? "running" };
    const summary = summarizeProcessEvent(itemType, summaryPayload, this.plugin.getVaultPath(), session.cwd || this.plugin.getVaultPath());
    if (!message) {
      message = {
        id: itemId || newId("process"),
        role: roleForProcessItem(itemType),
        text: "",
        itemType,
        title: summary.title,
        details: summary.detail,
        files: summary.files,
        processKind: summary.kind,
        runId: this.activeRunId || undefined,
        turnId: this.activeTurnId || undefined,
        status: "running",
        createdAt: Date.now()
      };
      session.messages.push(message);
      this.activeItemMessages.set(itemId, message.id);
    }
    if (itemType === "reasoning" || !message.title || message.title === "命令输出") message.title = summary.title;
    if (itemType === "reasoning") {
      if (summary.detail) message.details = summary.detail;
    } else if (!message.details && summary.detail) {
      message.details = summary.detail;
    }
    message.processKind = summary.kind;
    message.files = mergeProcessFiles(message.files, summary.files);
    message.status = "running";
    message.text += delta;
    session.updatedAt = Date.now();
    this.renderMessagesIfActive(session, message);
  }

  private ensureThinkingMessage(session: StoredSession, title: string, text: string): void {
    if (this.activeThinkingMessageId) {
      const existing = session.messages.find((message) => message.id === this.activeThinkingMessageId);
      if (existing) {
        existing.title = title;
        existing.text = text;
        existing.status = "running";
        this.renderMessagesIfActive(session);
        return;
      }
    }
    const id = newId("thinking");
    this.activeThinkingMessageId = id;
    session.messages.push({
      id,
      role: "assistant",
      title,
      text,
      itemType: "thinking",
      runId: this.activeRunId || undefined,
      turnId: this.activeTurnId || undefined,
      status: "running",
      createdAt: Date.now()
    });
    this.renderMessagesIfActive(session);
  }

  private markThinkingAsStreaming(session: StoredSession): void {
    const message = session.messages.find((item) => item.id === this.activeThinkingMessageId);
    if (!message || message.status !== "running") return;
    message.text = "正在生成回复...";
    this.renderMessagesIfActive(session);
  }

  private finishThinkingMessage(session: StoredSession, _status: string): void {
    const messageIndex = session.messages.findIndex((item) => item.id === this.activeThinkingMessageId);
    const message = messageIndex >= 0 ? session.messages[messageIndex] : null;
    if (!message) return;
    session.messages.splice(messageIndex, 1);
    session.updatedAt = Date.now();
    this.activeThinkingMessageId = "";
    this.renderMessagesIfActive(session);
  }

  private finishPlanMessage(session: StoredSession): void {
    const message = session.messages.find((item) => item.id === this.activePlanMessageId);
    if (message) message.status = "completed";
    this.activePlanMessageId = "";
  }

  private finishRunningProcessMessages(session: StoredSession, status: string): void {
    for (const message of session.messages) {
      if (isProcessItemType(message.itemType) && message.status === "running") {
        message.status = status;
        if (message.text) void this.plugin.externalizeMessageText(message, message.text);
        if (message.itemType === "reasoning") this.refreshProcessSummary(message, status, session);
      }
    }
    this.renderMessagesIfActive(session);
  }

  private renderPlanUpdate(session: StoredSession, params: unknown): void {
    const payload = processPayloadRecord(params);
    const lines: string[] = [];
    if (typeof payload.explanation === "string" && payload.explanation) lines.push(payload.explanation, "");
    const plan = Array.isArray(payload.plan) ? payload.plan : [];
    for (const rawItem of plan) {
      const item = processPayloadRecord(rawItem);
      const status = typeof item.status === "string" ? item.status : "";
      const step = typeof item.step === "string" ? item.step : "";
      if (!step) continue;
      const mark = status === "completed" ? "x" : " ";
      const suffix = status === "inProgress" ? " (进行中)" : "";
      lines.push(`- [${mark}] ${step}${suffix}`);
    }
    if (!lines.length) return;
    let message = this.activePlanMessageId ? session.messages.find((item) => item.id === this.activePlanMessageId) : null;
    if (!message) {
      message = {
        id: newId("plan"),
        role: "assistant",
        itemType: "plan",
        title: "更新计划",
        text: "",
        processKind: "plan",
        runId: this.activeRunId || undefined,
        turnId: this.activeTurnId || undefined,
        status: "running",
        createdAt: Date.now()
      };
      this.activePlanMessageId = message.id;
      session.messages.push(message);
    }
    message.text = lines.join("\n");
    session.updatedAt = Date.now();
    this.renderMessagesIfActive(session);
  }

  private renderStartedItem(session: StoredSession, item: unknown): void {
    const payload = processPayloadRecord(item);
    const type = stringPayload(payload.type);
    if (!isProcessItemType(type)) return;
    if (type === "reasoning" && !rawTextForProcessItem(payload)) return;
    const status = stringPayload(payload.status) || "running";
    void this.upsertProcessItem(session, stringPayload(payload.id) || newId("process"), type, rawTextForProcessItem(payload), status, { ...payload, status });
  }

  private async renderCompletedItem(session: StoredSession, item: unknown): Promise<void> {
    const payload = processPayloadRecord(item);
    const type = stringPayload(payload.type);
    if (!type) return;
    if (type === "agentMessage") return;
    const id = stringPayload(payload.id) || newId("process");
    const status = stringPayload(payload.status) || "completed";
    if (type === "reasoning" || type === "plan") {
      const text = rawTextForProcessItem(payload);
      if (text) {
        await this.upsertProcessItem(session, id, type, text, status, { ...payload, status });
      } else {
        this.finishProcessItem(session, id, status);
      }
      return;
    }
    if (type === "commandExecution") {
      await this.upsertProcessItem(session, id, "commandExecution", `${stringPayload(payload.command)}\n\n${stringPayload(payload.aggregatedOutput)}`.trim(), status, payload);
    } else if (type === "fileChange") {
      const changes = Array.isArray(payload.changes) ? payload.changes : [];
      const diffSummary = buildDiffSummary(changes);
      const text = serializeFileChanges(changes);
      await this.upsertProcessItem(session, id, "fileChange", text || status, status, payload, diffSummary);
    } else if (type === "mcpToolCall") {
      await this.upsertProcessItem(session, id, "mcpToolCall", JSON.stringify(payload.result ?? payload.error ?? payload.arguments, null, 2), status, payload);
    } else if (type === "dynamicToolCall") {
      await this.upsertProcessItem(session, id, "dynamicToolCall", JSON.stringify(payload.contentItems ?? payload.result ?? payload.arguments, null, 2), status, payload);
    } else if (type === "collabAgentToolCall") {
      await this.upsertProcessItem(session, id, "collabAgentToolCall", JSON.stringify(payload.result ?? payload.arguments ?? payload, null, 2), status, payload);
    } else if (type === "imageView") {
      const itemPath = stringPayload(payload.path);
      if (!itemPath) return;
      this.addMessageToSession(session, {
        role: "assistant",
        title: "图片",
        itemType: "image",
        text: itemPath,
        images: [{ type: "image", name: basename(itemPath), path: itemPath }],
        createdAt: Date.now()
      });
    } else if (type === "contextCompaction") {
      this.addContextCompactionMessage(session);
    }
  }

  private upsertCompletedItem(id: string, role: ChatMessage["role"], itemType: string, title: string, text: string, status?: string): void {
    const session = this.ensureSession();
    const existingId = this.activeItemMessages.get(id);
    const existing = existingId ? session.messages.find((item) => item.id === existingId) : null;
    if (existing) {
      existing.text = text || existing.text;
      existing.status = status;
    } else {
      session.messages.push({ id, role, itemType, title, text, status, createdAt: Date.now() });
    }
    this.renderMessages();
  }

  private async upsertProcessItem(session: StoredSession, id: string, itemType: string, text: string, status: string | undefined, payload: unknown, diffSummary?: DiffSummary): Promise<void> {
    const summary = summarizeProcessEvent(itemType, { ...processPayloadRecord(payload), status }, this.plugin.getVaultPath(), session.cwd || this.plugin.getVaultPath());
    const existingId = this.activeItemMessages.get(id);
    const existing = existingId ? session.messages.find((item) => item.id === existingId) : null;
    if (existing) {
      existing.role = roleForProcessItem(itemType);
      existing.itemType = itemType;
      existing.title = summary.title;
      existing.details = diffSummary ? diffSummaryLabel(diffSummary) : summary.detail || existing.details;
      existing.diffSummary = diffSummary;
      existing.files = mergeProcessFiles(existing.files, summary.files);
      existing.processKind = summary.kind;
      if (text) await this.plugin.externalizeMessageText(existing, text);
      existing.status = status;
      existing.turnId = this.activeTurnId || existing.turnId;
      existing.runId = this.activeRunId || existing.runId;
    } else {
      const message: ChatMessage = {
        id,
        role: roleForProcessItem(itemType),
        itemType,
        title: summary.title,
        details: diffSummary ? diffSummaryLabel(diffSummary) : summary.detail,
        diffSummary,
        files: summary.files,
        processKind: summary.kind,
        text,
        runId: this.activeRunId || undefined,
        turnId: this.activeTurnId || undefined,
        status,
        createdAt: Date.now()
      };
      if (text) await this.plugin.externalizeMessageText(message, text);
      session.messages.push(message);
      this.activeItemMessages.set(id, id);
    }
    session.updatedAt = Date.now();
    this.renderMessagesIfActive(session);
  }

  private finishProcessItem(session: StoredSession, id: string, status: string): void {
    const existingId = this.activeItemMessages.get(id);
    const existing = existingId ? session.messages.find((item) => item.id === existingId) : session.messages.find((item) => item.id === id);
    if (!existing) return;
    existing.status = status;
    if (existing.itemType === "reasoning") this.refreshProcessSummary(existing, status, session);
    session.updatedAt = Date.now();
    this.renderMessagesIfActive(session);
  }

  private refreshProcessSummary(message: ChatMessage, status: string, session: StoredSession): void {
    if (!message.itemType) return;
    const summary = summarizeProcessEvent(message.itemType, { text: message.text, status }, this.plugin.getVaultPath(), session.cwd || this.plugin.getVaultPath());
    message.title = summary.title;
    if (summary.detail) message.details = summary.detail;
    message.processKind = summary.kind;
  }

  private addMessage(message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>): void {
    this.addMessageToSession(this.ensureSession(), message);
  }

  private addMessageToSession(session: StoredSession, message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>): void {
    session.messages.push({
      id: message.id ?? newId("msg"),
      createdAt: message.createdAt ?? Date.now(),
      role: message.role,
      text: message.text,
      previewText: message.previewText,
      rawRef: message.rawRef,
      rawSize: message.rawSize,
      rawLines: message.rawLines,
      rawTruncatedForPreview: message.rawTruncatedForPreview,
      phase: message.phase,
      itemType: message.itemType,
      runId: message.runId ?? (this.activeRunId || undefined),
      turnId: message.turnId ?? (this.activeTurnId || undefined),
      processKind: message.processKind,
      title: message.title,
      status: message.status,
      details: message.details,
      diffSummary: message.diffSummary,
      citations: message.citations,
      knowledgeBaseUi: message.knowledgeBaseUi,
      attachments: message.attachments,
      files: message.files,
      images: message.images
    });
    session.updatedAt = Date.now();
    this.renderMessagesIfActive(session);
    void this.plugin.saveSettings();
  }

  private moveMessageToEnd(session: StoredSession, messageId: string): void {
    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index < 0 || index === session.messages.length - 1) return;
    const [message] = session.messages.splice(index, 1);
    session.messages.push(message);
  }

  private updateContext(tokenUsage: TokenUsage | undefined, persist: boolean): void {
    this.updateContextForSession(this.ensureSession(), tokenUsage, persist);
  }

  private updateContextForSession(session: StoredSession, tokenUsage: TokenUsage | undefined, persist: boolean): void {
    if (persist) {
      session.tokenUsage = tokenUsage;
      session.updatedAt = Date.now();
      void this.plugin.saveSettings();
    }
    if (session.id !== this.plugin.settings.activeSessionId) return;
    if (!this.contextEl) return;
    this.contextEl.toggleClass("is-hidden", !this.plugin.settings.showContext);
    if (!this.plugin.settings.showContext) return;
    const view = contextUsageView(tokenUsage);
    this.contextValueEl.setText(view.label);
    this.contextEl.setCssProps({ "--codex-context-angle": `${view.angle}deg` });
    this.contextEl.setAttr("aria-label", view.title);
    this.contextEl.setAttr("title", view.title);
    this.contextEl.toggleClass("is-empty", view.percent === null);
    this.contextEl.toggleClass("is-warning", (view.percent ?? 0) >= 80);
  }

  private async toggleMcpPanel(): Promise<void> {
    const willOpen = !this.mcpPanelEl.hasClass("is-visible");
    this.mcpPanelEl.toggleClass("is-visible", willOpen);
    if (!willOpen) return;
    this.mcpPanelEl.empty();
    this.mcpPanelEl.createDiv({ cls: "codex-mcp-title", text: "MCP 状态" });
    this.mcpPanelEl.createDiv({ cls: "codex-mcp-empty", text: "正在读取 MCP 状态..." });
    const status = await this.plugin.ensureCodexConnected();
    if (!status.connected || !this.plugin.codex) {
      this.renderMcpPanel([], "Codex 未连接");
      return;
    }
    const result = await this.plugin.codex.refreshMcpStatus();
    if (this.plugin.lastStatus) this.plugin.lastStatus.mcpServers = result.servers;
    this.renderMcpPanel(result.servers, result.error);
  }

  private renderMcpPanel(servers: McpServerStatus[], error: string | null): void {
    renderMcpPanelView(this.mcpPanelEl, servers, error, this.plugin.settings.mcpEnabled, {
      onRetry: () => {
        this.mcpPanelEl.removeClass("is-visible");
        void this.toggleMcpPanel();
      },
      onLogin: (serverName) => this.plugin.codex?.startMcpOAuth(serverName) ?? Promise.resolve(null)
    });
  }

  private activeRunSession(): StoredSession {
    const active = this.activeRunSessionId ? this.plugin.settings.sessions.find((session) => session.id === this.activeRunSessionId) : null;
    return active ?? this.ensureSession();
  }

  private sessionForThread(threadId?: string): StoredSession | null {
    if (!threadId) return null;
    return this.plugin.settings.sessions.find((session) => session.threadId === threadId) ?? null;
  }

  private addContextCompactionMessage(session: StoredSession): void {
    const last = session.messages[session.messages.length - 1];
    if (last?.itemType === "contextCompaction" && Date.now() - last.createdAt < 10_000) return;
    this.addMessageToSession(session, { role: "system", title: "上下文压缩", itemType: "contextCompaction", text: "Codex 已自动压缩上下文。", createdAt: Date.now() });
  }

  private clearActiveRun(): void {
    this.activeRunId = "";
    this.activeRunKind = "";
    this.activeRunSessionId = "";
    this.activeTurnId = "";
    this.editorActionActiveTimeoutMs = 0;
    this.activeThinkingMessageId = "";
    this.activePlanMessageId = "";
    this.activeItemMessages?.clear?.();
  }

  private attachTurnIdToRun(session: StoredSession, turnId: string): void {
    if (!turnId || !this.activeRunId) return;
    for (const message of session.messages) {
      if (message.runId === this.activeRunId) message.turnId = turnId;
    }
  }

  private renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void {
    if (session.id !== this.plugin.settings.activeSessionId) return;
    if (updatedMessage && this.messageListRenderer.tryUpdateMessage(updatedMessage)) return;
    this.scheduleRenderMessages();
  }

  private handleMessagesScroll(): void {
    this.scheduleRenderMessages(this.messageScrollFollow.handleScroll(this.isMessagesAtBottom()));
  }

  private scheduleRenderMessages(options: MessageRenderScheduleOptions = {}): void {
    this.messageScrollFollow.scheduleRender(options, (callback) => window.requestAnimationFrame(callback), (renderOptions) => this.renderMessages(renderOptions));
  }

  private scheduleMeasureVirtualRows(forceBottom = !this.messagesBottomFollowPaused): void {
    this.messageScrollFollow.scheduleMeasure(forceBottom, (callback) => window.requestAnimationFrame(callback), (shouldForceBottom) => this.measureVisibleVirtualRows(shouldForceBottom));
  }

  private scheduleKnowledgeBaseRunProgress(): void {
    if (this.knowledgeBaseRunProgressTimer !== null) return;
    this.knowledgeBaseRunProgressTimer = window.setTimeout(() => {
      this.knowledgeBaseRunProgressTimer = null;
      const forceBottom = !this.messagesBottomFollowPaused;
      this.scheduleRenderMessages({ forceBottom, fromScroll: !forceBottom });
    }, 700);
  }

  private clearKnowledgeBaseRunProgressTimer(): void {
    if (this.knowledgeBaseRunProgressTimer === null) return;
    window.clearTimeout(this.knowledgeBaseRunProgressTimer);
    this.knowledgeBaseRunProgressTimer = null;
  }

  private measureVisibleVirtualRows(forceBottom = false): boolean {
    if (!this.virtualListEl || !this.messagesEl) return false;
    const changed = this.messageListRenderer.measureVisibleVirtualRows(this.messagesEl, this.virtualListEl, forceBottom, { rerender: false });
    if (changed) this.scheduleRenderMessages({ forceBottom, fromScroll: !forceBottom });
    return changed;
  }

  private isMessagesNearBottom(): boolean {
    if (!this.messagesEl) return true;
    return this.messageListRenderer.isNearBottom(this.messagesEl, this.virtualListEl);
  }

  private isMessagesAtBottom(): boolean {
    if (!this.messagesEl) return true;
    return this.messageListRenderer.isAtBottom(this.messagesEl, this.virtualListEl);
  }

  private resetVirtualWindow(): void {
    this.messageListRenderer.resetVirtualWindow();
    this.messageScrollFollow.reset();
    if (this.messagesEl) this.messagesEl.scrollTop = 0;
  }

  private ensureSession(): StoredSession {
    ensureKnowledgeBaseSession(this.plugin.settings, this.plugin.getVaultPath());
    const activeId = this.plugin.settings.activeSessionId;
    const active = this.plugin.settings.sessions.find((session) => session.id === activeId);
    if (active) return active;
    return this.createSession();
  }

  private isKnowledgeBaseSession(session: StoredSession): boolean {
    return isKnowledgeBaseSession(session, this.plugin.settings.knowledgeBase.sessionId);
  }

  private createSession(title = "新会话"): StoredSession {
    const session: StoredSession = {
      id: newId("session"),
      title,
      cwd: "",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.plugin.settings.sessions.push(session);
    this.plugin.settings.activeSessionId = session.id;
    return session;
  }

  private attachActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("没有当前笔记");
      return;
    }
    this.attachments.push({
      type: isImagePath(file.path) ? "image" : "file",
      name: file.name,
      path: absoluteVaultPath(this.plugin.getVaultPath(), file.path)
    });
    this.renderAttachments();
  }

  private pickFiles(imagesOnly: boolean): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (imagesOnly) input.accept = "image/*";
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      for (const file of files) {
        const filePath = (file as File & { path?: string }).path;
        if (!filePath) continue;
        this.attachments.push({
          type: isImagePath(filePath) ? "image" : "file",
          name: file.name,
          path: filePath
        });
      }
      this.renderAttachments();
    };
    input.click();
  }

  private pickKnowledgeBaseFiles(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain";
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      const attachments: StoredAttachment[] = [];
      for (const file of files) {
        const filePath = (file as File & { path?: string }).path;
        if (!filePath) continue;
        attachments.push({
          type: "file",
          name: file.name,
          path: filePath
        });
      }
      void this.runKnowledgeBaseShortcut("文件收藏", async () => {
        const paths = await this.plugin.getKnowledgeBaseManager()?.captureExternalFiles(attachments);
        return paths?.length ? `已收藏文件：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未选择文件。";
      });
    };
    input.click();
  }

  private handleDroppedFiles(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files ?? []);
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) continue;
      this.attachments.push({
        type: isImagePath(filePath) ? "image" : "file",
        name: file.name,
        path: filePath
      });
    }
    this.renderAttachments();
  }

  private async handlePastedFiles(event: ClipboardEvent): Promise<void> {
    const files = extractClipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    try {
      const pasted = await saveClipboardImageAttachments(files, { vaultPath: this.plugin.getVaultPath(), pluginDir: this.plugin.getPluginDataDirName() });
      this.attachments.push(...pasted);
      this.renderAttachments();
    } catch (error) {
      console.error("Codex paste image failed", error);
      new Notice("粘贴图片失败");
    }
  }
}

function roleForProcessItem(itemType: string): ChatMessage["role"] {
  return itemType === "reasoning" || itemType === "plan" ? "assistant" : "tool";
}


function rawTextForProcessItem(item: unknown): string {
  const payload = processPayloadRecord(item);
  const type = stringPayload(payload.type);
  if (type === "commandExecution") return stringPayload(payload.command);
  if (type === "fileChange") return (Array.isArray(payload.changes) ? payload.changes : [])
    .map((change) => stringPayload(processPayloadRecord(change).path))
    .filter(Boolean)
    .join("\n");
  if (type === "mcpToolCall") return [payload.server, payload.tool].map(stringPayload).filter(Boolean).join(".");
  if (type === "dynamicToolCall") return [payload.namespace, payload.tool].map(stringPayload).filter(Boolean).join(".");
  if (type === "collabAgentToolCall") return stringPayload(payload.tool);
  if (type === "reasoning") return reasoningTextFromPayload(payload);
  if (type === "plan") return stringPayload(payload.text);
  return "";
}

function processPayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringPayload(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mergeProcessFiles(current: ProcessFileRef[] | undefined, incoming: ProcessFileRef[]): ProcessFileRef[] {
  const byKey = new Map<string, ProcessFileRef>();
  for (const file of [...(current ?? []), ...incoming]) {
    byKey.set(`${file.kind}:${file.path}`, file);
  }
  return Array.from(byKey.values()).slice(0, 8);
}

async function pickWorkspaceDirectory(defaultPath: string): Promise<string | null | undefined> {
  const dialog = getElectronDialog();
  if (!dialog?.showOpenDialog) return undefined;
  const result = await dialog.showOpenDialog({
    title: "选择 Codex 工作区",
    defaultPath: normalizeWorkspacePath(defaultPath) || undefined,
    properties: ["openDirectory", "createDirectory"]
  });
  if (result?.canceled) return null;
  return result?.filePaths?.[0] ?? null;
}

function workspaceDirectoryExists(value: string): boolean {
  const workspacePath = normalizeWorkspacePath(value);
  if (!workspacePath) return false;
  try {
    return fs.statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeWorkspacePath(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const withoutFileProtocol = raw.replace(/^file:\/\//, "");
  try {
    return path.resolve(decodeURI(withoutFileProtocol));
  } catch {
    return path.resolve(withoutFileProtocol);
  }
}

function workspaceDisplayName(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  return path.basename(normalized) || normalized;
}

function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(filePath);
}

function absoluteVaultPath(vaultPath: string, relativePath: string): string {
  return `${vaultPath.replace(/\/$/, "")}/${relativePath.replace(/^\//, "")}`;
}
