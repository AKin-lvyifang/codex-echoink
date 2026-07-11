import { ItemView, MarkdownView, Notice, WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentBackendMode, ChatMessage, StoredAttachment, StoredSession } from "../settings/settings";
import { providerConnectionLabel } from "../settings/settings";
import type { EchoInkResource } from "../resources/types";
import type {
  CodexNotification,
  McpServerStatus,
  PermissionMode,
  RateLimitSnapshot,
  ReasoningEffort,
  ServiceTierChoice,
  TokenUsage,
  UiMode
} from "../types/app-server";
import { diagnoseCodexError, type CodexErrorDiagnostic } from "../core/codex-diagnostics";
import { buildUserInput } from "../core/mapping";
import { composerPrimaryActionForState, type ComposerPrimaryActionState } from "./composer-state";
import { canStartQueuedTurn, RuntimeTurnQueue, type QueuedTurnItem } from "./turn-queue";
import { clearPromptEnhanceReview } from "./codex-view/composer";
import { CodexMessageListRenderer, isProcessItemType } from "./codex-view/message-list";
import { appendKnowledgeContextBridge, buildKnowledgeContextBridgeForThread, knowledgeContextBridgeDetailText, markKnowledgeContextBridgeInjected } from "./codex-view/knowledge-context-bridge";
import { renderMcpPanelView } from "./codex-view/mcp-panel";
import { MessageScrollFollowController, type MessageRenderScheduleOptions } from "./codex-view/message-scroll-follow";
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
import type { CodexViewPromptEnhanceContext, CodexViewTurnContext, EditorActionRunWaiter, EditorSummaryRunWaiter } from "./codex-view/runner-context";
import { type ArticleUnderstandingPanelState } from "./codex-view/header";
import { createKnowledgeDashboardTooltipState, disposeKnowledgeDashboardTooltipState } from "./codex-view/knowledge-dashboard";
import { CodexNotificationRouter, type CodexNotificationRouterContext } from "./codex-view/notification-router";
import type { SessionMessageInput } from "./codex-view/session-message-store";
import {
  attachActiveFile as attachActiveFileAction,
  handleDroppedFiles as handleDroppedFilesAction,
  handlePastedFiles as handlePastedFilesAction,
  pickFiles as pickFilesAction,
  pickKnowledgeBaseFiles as pickKnowledgeBaseFilesAction,
  renderAttachmentsView,
  type CodexAttachmentHost
} from "./codex-view/attachments";
import { normalizeWorkspacePath } from "./codex-view/workspace-utils";
import {
  activeProviderModels as activeProviderModelsAction,
  currentEchoInkResourceCatalog as currentEchoInkResourceCatalogAction,
  currentTurnOptions as currentTurnOptionsAction,
  effectiveModel as effectiveModelAction,
  ensureChatWorkspaceSelected as ensureChatWorkspaceSelectedAction,
  openWorkspaceMenu as openWorkspaceMenuAction,
  prewarmActiveThread as prewarmActiveThreadAction,
  resolvedKnowledgeBackend as resolvedKnowledgeBackendAction,
  type CodexWorkspaceHost
} from "./codex-view/workspace-controller";
import {
  clearKnowledgeDashboardTooltips,
  refreshKnowledgeDashboard as refreshKnowledgeDashboardAction,
  renderKnowledgeDashboard as renderKnowledgeDashboardAction,
  type CodexKnowledgeDashboardHost
} from "./codex-view/knowledge-dashboard-controller";
import {
  clearComposerDraft as clearComposerDraftAction,
  closeComposerMenus as closeComposerMenusAction,
  composerStateForSession as composerStateForSessionAction,
  fillKnowledgeBaseCommand as fillKnowledgeBaseCommandAction,
  onInputChanged as onInputChangedAction,
  openKnowledgeCommandMenu as openKnowledgeCommandMenuAction,
  openKnowledgeModelMenu as openKnowledgeModelMenuAction,
  openModelMenu as openModelMenuAction,
  pauseQueueForSession as pauseQueueForSessionAction,
  renderKnowledgeCommandMatches as renderKnowledgeCommandMatchesAction,
  renderQueue as renderQueueAction,
  renderToolbar as renderToolbarAction,
  submitKnowledgeBaseCommand as submitKnowledgeBaseCommandAction,
  updateContextForSession as updateContextForSessionAction,
  type CodexComposerHost
} from "./codex-view/composer-controller";
import {
  addContextCompactionMessage as addContextCompactionMessageAction,
  addMessageToSession as addMessageToSessionAction,
  appendItemDelta as appendItemDeltaAction,
  appendProcessDelta as appendProcessDeltaAction,
  attachTurnIdToRun as attachTurnIdToRunAction,
  clearKnowledgeBaseRunProgressTimer as clearKnowledgeBaseRunProgressTimerAction,
  clearSessionMessageActiveRun,
  ensureThinkingMessage as ensureThinkingMessageAction,
  finishPlanMessage as finishPlanMessageAction,
  finishRunningProcessMessages as finishRunningProcessMessagesAction,
  finishThinkingMessage as finishThinkingMessageAction,
  flushSessionSave as flushSessionSaveAction,
  handleMessagesScroll as handleMessagesScrollAction,
  isMessagesAtBottom as isMessagesAtBottomAction,
  isMessagesNearBottom as isMessagesNearBottomAction,
  markThinkingAsStreaming as markThinkingAsStreamingAction,
  moveMessageToEnd as moveMessageToEndAction,
  renderCompletedItem as renderCompletedItemAction,
  renderMessages as renderMessagesAction,
  renderMessagesIfActive as renderMessagesIfActiveAction,
  renderPlanUpdate as renderPlanUpdateAction,
  renderStartedItem as renderStartedItemAction,
  resetVirtualWindow as resetVirtualWindowAction,
  scheduleKnowledgeBaseRunProgress as scheduleKnowledgeBaseRunProgressAction,
  scheduleMeasureVirtualRows as scheduleMeasureVirtualRowsAction,
  scheduleRenderMessages as scheduleRenderMessagesAction,
  scheduleSessionSave as scheduleSessionSaveAction,
  settleStaleMessages as settleStaleMessagesAction,
  upsertProcessItem as upsertProcessItemAction,
  type CodexMessageHost
} from "./codex-view/message-controller";
import {
  applyStatus as applyStatusAction,
  clearEditorActionStatusTimers as clearEditorActionStatusTimersAction,
  openPluginSettings as openPluginSettingsAction,
  refreshHeaderRateLimits as refreshHeaderRateLimitsAction,
  renderArticleUnderstandingPanel as renderArticleUnderstandingPanelAction,
  renderEditorActionStatus as renderEditorActionStatusAction,
  renderHeaderHistory as renderHeaderHistoryAction,
  renderUsagePanel as renderUsagePanelAction,
  setEditorActionStatus as setEditorActionStatusAction,
  updateInputPlaceholder as updateInputPlaceholderAction,
  updateUsageHeader as updateUsageHeaderAction,
  type CodexHeaderHost
} from "./codex-view/header-controller";
import {
  armTurnWatchdog as armTurnWatchdogAction,
  clearActiveRun as clearActiveRunAction,
  clearTurnWatchdog as clearTurnWatchdogAction,
  stopTurn as stopTurnAction,
  type CodexTurnLifecycleHost
} from "./codex-view/turn-lifecycle";
import { renderViewShell, type CodexViewShellHost } from "./codex-view/view-shell";
import {
  activeRunSession as activeRunSessionAction,
  clearKnowledgeBasePage as clearKnowledgeBasePageAction,
  createSession as createSessionAction,
  deleteSession as deleteSessionAction,
  ensureSession as ensureSessionAction,
  isKnowledgeBaseSession as isKnowledgeBaseSessionAction,
  openKnowledgeBaseHistory as openKnowledgeBaseHistoryAction,
  renderTabsView,
  renameSession as renameSessionAction,
  sessionById as sessionByIdAction,
  sessionForThread as sessionForThreadAction,
  type CodexSessionHost
} from "./codex-view/session-controller";
import {
  armEditorSummaryTimeout as armEditorSummaryTimeoutAction,
  cancelEditorSummaryRun as cancelEditorSummaryRunAction,
  clearEditorSummaryTimers as clearEditorSummaryTimersAction,
  effectiveEditorActionModel as effectiveEditorActionModelAction,
  editorActionStartBlockReason as editorActionStartBlockReasonAction,
  isEditorActionRunActive as isEditorActionRunActiveAction,
  isEditorSummaryRunActive as isEditorSummaryRunActiveAction,
  prewarmEditorActionThread as prewarmEditorActionThreadAction,
  rejectEditorActionRun as rejectEditorActionRunAction,
  rejectEditorSummaryRun as rejectEditorSummaryRunAction,
  releaseEditorActionRunLock as releaseEditorActionRunLockAction,
  releaseEditorSummaryRunLock as releaseEditorSummaryRunLockAction,
  resolveEditorActionRun as resolveEditorActionRunAction,
  resolveEditorSummaryRun as resolveEditorSummaryRunAction,
  takeEditorActionThread as takeEditorActionThreadAction,
  withEditorActionTimeout as withEditorActionTimeoutAction,
  type CodexEditorActionRunHost
} from "./codex-view/editor-action-run-state";
import { buildEditorActionUserInput } from "../editor-actions/prompt";
import type { ArticleUnderstandingEntry, ArticleUnderstandingStatus, EditorActionQualityMode, EditorActionRequest, EditorActionStatusView } from "../editor-actions/types";
import type { EditorActionSummarySource } from "../editor-actions/summary-cache";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";

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
  private promptEnhanceReviewEl!: HTMLElement;
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
  private sessionSaveTimer: number | null = null;
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
  private readonly editorActionRunnerContext: CodexViewPromptEnhanceContext;
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

  private attachmentHost(): CodexAttachmentHost { return this as unknown as CodexAttachmentHost; }
  private sessionHost(): CodexSessionHost { return this as unknown as CodexSessionHost; }
  private knowledgeDashboardHost(): CodexKnowledgeDashboardHost { return this as unknown as CodexKnowledgeDashboardHost; }
  private workspaceHost(): CodexWorkspaceHost { return this as unknown as CodexWorkspaceHost; }
  private editorActionRunHost(): CodexEditorActionRunHost { return this as unknown as CodexEditorActionRunHost; }
  private composerHost(): CodexComposerHost { return this as unknown as CodexComposerHost; }
  private messageHost(): CodexMessageHost { return this as unknown as CodexMessageHost; }
  private headerHost(): CodexHeaderHost { return this as unknown as CodexHeaderHost; }
  private turnLifecycleHost(): CodexTurnLifecycleHost { return this as unknown as CodexTurnLifecycleHost; }
  private shellHost(): CodexViewShellHost { return this as unknown as CodexViewShellHost; }

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

  private createEditorActionRunnerContext(): CodexViewPromptEnhanceContext {
    const view = this;
    return {
      get app() { return view.app; }, get plugin() { return view.plugin; }, get running() { return view.running; }, set running(value) { view.running = value; }, get activeRunId() { return view.activeRunId; }, set activeRunId(value) { view.activeRunId = value; }, get activeRunKind() { return view.activeRunKind; }, set activeRunKind(value) { view.activeRunKind = value; }, get activeRunSessionId() { return view.activeRunSessionId; }, set activeRunSessionId(value) { view.activeRunSessionId = value; }, get activeTurnId() { return view.activeTurnId; }, set activeTurnId(value) { view.activeTurnId = value; },
      get editorSummaryRun() { return view.editorSummaryRun; }, get editorActionHarnessRunId() { return view.editorActionHarnessRunId; }, set editorActionHarnessRunId(value) { view.editorActionHarnessRunId = value; }, get editorActionActiveTimeoutMs() { return view.editorActionActiveTimeoutMs; }, set editorActionActiveTimeoutMs(value) { view.editorActionActiveTimeoutMs = value; }, get editorActionRun() { return view.editorActionRun; }, set editorActionRun(value) { view.editorActionRun = value; }, get editorActionThreadId() { return view.editorActionThreadId; }, set editorActionThreadId(value) { view.editorActionThreadId = value; }, get editorActionThreadIds() { return view.editorActionThreadIds; }, get editorActionTurnIds() { return view.editorActionTurnIds; }, get editorActionCurrentItemIds() { return view.editorActionCurrentItemIds; }, get articleUnderstandingPanelState() { return view.articleUnderstandingPanelState; }, set articleUnderstandingPanelState(value) { view.articleUnderstandingPanelState = value; }, get selectedServiceTier() { return view.selectedServiceTier; }, get inputEl() { return view.inputEl; }, get promptEnhanceReviewEl() { return view.promptEnhanceReviewEl; },
      applyStatus: () => view.applyStatus(), armTurnWatchdog: (timeoutMs, timeoutText) => view.armTurnWatchdog(timeoutMs, timeoutText), clearTurnWatchdog: () => view.clearTurnWatchdog(), clearActiveRun: () => view.clearActiveRun(), renderToolbar: () => view.renderToolbar(), diagnoseCodexFailure: (error, model) => view.diagnoseCodexFailure(error, model), cancelEditorSummaryRun: (reason) => view.cancelEditorSummaryRun(reason), editorActionStartBlockReason: () => view.editorActionStartBlockReason(), setEditorActionStatus: (status) => view.setEditorActionStatus(status), withEditorActionTimeout: (promise, timeoutMs, message) => view.withEditorActionTimeout(promise, timeoutMs, message), prewarmEditorActionThread: () => view.prewarmEditorActionThread(), rejectEditorActionRun: (error) => view.rejectEditorActionRun(error), effectiveEditorActionModel: (availableModels, configuredModel) => view.effectiveEditorActionModel(availableModels, configuredModel), takeEditorActionThread: (turnOptions) => view.takeEditorActionThread(turnOptions), resolveEditorActionRun: (text) => view.resolveEditorActionRun(text), releaseEditorActionRunLock: (runId) => view.releaseEditorActionRunLock(runId), renderEditorActionStatus: () => view.renderEditorActionStatus(), activeProviderModels: () => view.activeProviderModels(), onInputChanged: () => view.onInputChanged(), focusInput: () => view.focusInput()
    } satisfies CodexViewPromptEnhanceContext;
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
    disposeKnowledgeDashboardTooltipState(this.knowledgeDashboardTooltipState);
    this.rejectEditorActionRun(new Error("EchoInk Agent 侧栏已关闭"));
    this.rejectEditorSummaryRun(new Error("EchoInk Agent 侧栏已关闭"));
    await this.flushSessionSave();
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

  private render(): void { renderViewShell(this.shellHost(), this.editorActionRunnerContext); }
  private updateInputPlaceholder(): void { updateInputPlaceholderAction(this.headerHost()); }
  private renderHeaderHistory(): void { renderHeaderHistoryAction(this.headerHost()); }
  private applyStatus(): void { applyStatusAction(this.headerHost()); }
  setEditorActionStatus(status: EditorActionStatusView): void { setEditorActionStatusAction(this.headerHost(), status); }
  private renderEditorActionStatus(): void { renderEditorActionStatusAction(this.headerHost()); }
  private renderArticleUnderstandingPanel(): void { renderArticleUnderstandingPanelAction(this.headerHost()); }

  private clearEditorActionStatusTimers(): void {
    clearEditorActionStatusTimersAction(this.headerHost());
  }

  private async refreshHeaderRateLimits(): Promise<void> {
    await refreshHeaderRateLimitsAction(this.headerHost());
  }

  private updateUsageHeader(rateLimits: RateLimitSnapshot | null, loading = false, error: string | null = null): void { updateUsageHeaderAction(this.headerHost(), rateLimits, loading, error); }
  private renderUsagePanel(rateLimits: RateLimitSnapshot | null, error?: string | null, loading = false): void { renderUsagePanelAction(this.headerHost(), rateLimits, error, loading); }
  private openPluginSettings(): void { openPluginSettingsAction(this.headerHost()); }
  private renderTabs(): void { renderTabsView(this.sessionHost()); }
  private renderMessages(options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void { renderMessagesAction(this.messageHost(), options); }
  private renderKnowledgeDashboard(): void { renderKnowledgeDashboardAction(this.knowledgeDashboardHost()); }

  private async refreshKnowledgeDashboard(force = false): Promise<void> {
    await refreshKnowledgeDashboardAction(this.knowledgeDashboardHost(), force);
  }

  private clearKnowledgeDashboardHealthTooltips(): void { clearKnowledgeDashboardTooltips(this.knowledgeDashboardHost()); }
  private renderToolbar(): void { renderToolbarAction(this.composerHost()); }
  private renderQueue(): void { renderQueueAction(this.composerHost()); }
  private renderAttachments(): void { renderAttachmentsView(this.attachmentHost()); }
  private closeComposerMenus(): void { closeComposerMenusAction(this.composerHost()); }
  private openWorkspaceMenu(event: MouseEvent, session: StoredSession): void { openWorkspaceMenuAction(this.workspaceHost(), event, session); }

  private async clearKnowledgeBasePage(session: StoredSession): Promise<void> {
    await clearKnowledgeBasePageAction(this.sessionHost(), session);
  }

  private async openKnowledgeBaseHistory(session: StoredSession): Promise<void> {
    await openKnowledgeBaseHistoryAction(this.sessionHost(), session);
  }

  private async ensureChatWorkspaceSelected(session: StoredSession): Promise<boolean> {
    return await ensureChatWorkspaceSelectedAction(this.workspaceHost(), session);
  }

  private openKnowledgeCommandMenu(event: MouseEvent): void { openKnowledgeCommandMenuAction(this.composerHost(), event); }
  private openKnowledgeModelMenu(event: MouseEvent): void { openKnowledgeModelMenuAction(this.composerHost(), event); }
  fillKnowledgeBaseCommand(command: string): void { fillKnowledgeBaseCommandAction(this.composerHost(), command); }
  async submitKnowledgeBaseCommand(command: string): Promise<void> { await submitKnowledgeBaseCommandAction(this.composerHost(), command); }
  private openModelMenu(event: MouseEvent): void { openModelMenuAction(this.composerHost(), event); }

  private async renameSession(session: StoredSession): Promise<void> {
    await renameSessionAction(this.sessionHost(), session);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    await deleteSessionAction(this.sessionHost(), sessionId);
  }

  private onInputChanged(): void { onInputChangedAction(this.composerHost()); }
  private renderKnowledgeCommandMatches(query: string): void { renderKnowledgeCommandMatchesAction(this.composerHost(), query); }
  private clearComposerDraft(): void { clearComposerDraftAction(this.composerHost()); }
  private composerStateForSession(session: StoredSession): ComposerPrimaryActionState { return composerStateForSessionAction(this.composerHost(), session); }
  private pauseQueueForSession(sessionId: string): void { pauseQueueForSessionAction(this.composerHost(), sessionId); }
  private sessionById(sessionId: string): StoredSession | null { return sessionByIdAction(this.sessionHost(), sessionId); }

  private async sendMessage(): Promise<void> { await sendMessageRunner(this.turnRunnerContext); }
  private async enqueueComposerDraft(): Promise<void> { await enqueueComposerDraftRunner(this.turnRunnerContext); }
  private async resumeQueuedTurns(sessionId: string): Promise<void> { await resumeQueuedTurnsRunner(this.turnRunnerContext, sessionId); }
  private async afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void> { await afterTurnSettledRunner(this.turnRunnerContext, sessionId, succeeded); }
  private async startNextQueuedTurn(sessionId: string): Promise<void> { await startNextQueuedTurnRunner(this.turnRunnerContext, sessionId); }
  private async createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> { return await createQueuedTurnFromComposerRunner(this.turnRunnerContext, options); }
  private async startQueuedTurnItem(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> { return await startQueuedTurnItemRunner(this.turnRunnerContext, item, source); }
  private async startQueuedTurnItemSafely(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> { return await startQueuedTurnItemSafelyRunner(this.turnRunnerContext, item, source); }
  private async startChatTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> { return await startChatTurnRunner(this.turnRunnerContext, session, item, source); }
  private async startKnowledgeBaseTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"completed" | "failed"> { return await startKnowledgeBaseTurnRunner(this.turnRunnerContext, session, item, source); }
  private async runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void> { await runKnowledgeBaseShortcutRunner(this.turnRunnerContext, label, runner); }
  async sendEditorActionRequest(request: EditorActionRequest): Promise<string> { return await sendEditorActionRequestRunner(this.editorActionRunnerContext, request); }

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

  private setArticleUnderstandingPanelState(state: ArticleUnderstandingPanelState): void { setArticleUnderstandingPanelStateRunner(this.editorActionRunnerContext, state); }
  private async refreshArticleUnderstandingPanelSourceState(): Promise<void> { await refreshArticleUnderstandingPanelSourceStateRunner(this.editorActionRunnerContext); }
  private async refreshArticleUnderstandingFromPanel(): Promise<void> { await refreshArticleUnderstandingFromPanelRunner(this.editorActionRunnerContext); }
  private async currentArticleUnderstandingSource(): Promise<EditorActionSummarySource | null> { return await currentArticleUnderstandingSourceRunner(this.editorActionRunnerContext); }
  private async stopTurn(): Promise<void> { await stopTurnAction(this.turnLifecycleHost()); }
  private settleStaleMessages(session: StoredSession): void { settleStaleMessagesAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost, session); }
  private armTurnWatchdog(timeoutMs?: number, timeoutText?: string): void { armTurnWatchdogAction(this.turnLifecycleHost(), timeoutMs, timeoutText); }
  private clearTurnWatchdog(): void { clearTurnWatchdogAction(this.turnLifecycleHost()); }
  private resolveEditorActionRun(text: string): void { resolveEditorActionRunAction(this.editorActionRunHost(), text); }
  private rejectEditorActionRun(error: Error): void { rejectEditorActionRunAction(this.editorActionRunHost(), error); }
  private editorActionStartBlockReason(): string | null { return editorActionStartBlockReasonAction(this.editorActionRunHost()); }
  private releaseEditorActionRunLock(runId: string): void { releaseEditorActionRunLockAction(this.editorActionRunHost(), runId); }

  private async takeEditorActionThread(turnOptions: Parameters<typeof takeEditorActionThreadAction>[1]): Promise<string> {
    return await takeEditorActionThreadAction(this.editorActionRunHost(), turnOptions);
  }

  private prewarmEditorActionThread(): void { prewarmEditorActionThreadAction(this.editorActionRunHost()); }
  private isEditorSummaryRunActive(): boolean { return isEditorSummaryRunActiveAction(this.editorActionRunHost()); }
  private resolveEditorSummaryRun(text: string): void { resolveEditorSummaryRunAction(this.editorActionRunHost(), text); }
  private rejectEditorSummaryRun(error: Error): void { rejectEditorSummaryRunAction(this.editorActionRunHost(), error); }
  private cancelEditorSummaryRun(reason: string): void { cancelEditorSummaryRunAction(this.editorActionRunHost(), reason); }
  private armEditorSummaryTimeout(timeoutMs: number): void { armEditorSummaryTimeoutAction(this.editorActionRunHost(), timeoutMs); }
  private clearEditorSummaryTimers(): void { clearEditorSummaryTimersAction(this.editorActionRunHost()); }
  private releaseEditorSummaryRunLock(runId?: string): void { releaseEditorSummaryRunLockAction(this.editorActionRunHost(), runId); }
  private isEditorActionRunActive(): boolean { return isEditorActionRunActiveAction(this.editorActionRunHost()); }
  private withEditorActionTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> { return withEditorActionTimeoutAction(promise, timeoutMs, message); }
  private currentTurnOptions(session?: StoredSession) { return currentTurnOptionsAction(this.workspaceHost(), session); }
  private currentEchoInkResourceCatalog(): EchoInkResource[] { return currentEchoInkResourceCatalogAction(this.workspaceHost()); }
  private activeProviderModels(): string[] { return activeProviderModelsAction(this.workspaceHost()); }
  private resolvedKnowledgeBackend(): AgentBackendMode { return resolvedKnowledgeBackendAction(this.workspaceHost()); }
  private effectiveModel(): string { return effectiveModelAction(this.workspaceHost()); }
  private effectiveEditorActionModel(availableModels: string[] = [], configuredModel = this.plugin.settings.editorActions.model): string { return effectiveEditorActionModelAction(this.editorActionRunHost(), availableModels, configuredModel); }
  private prewarmActiveThread(): void { prewarmActiveThreadAction(this.workspaceHost()); }

  private appendItemDelta(session: StoredSession, itemId: string, role: ChatMessage["role"], delta: string, itemType: string, title: string): void {
    if (this.editorActionRun?.runId === this.activeRunId && role === "assistant" && itemType === "assistant") {
      this.editorActionRun.text += delta;
    }
    appendItemDeltaAction(this.messageHost(), session, itemId, role, delta, itemType, title);
  }

  private appendProcessDelta(session: StoredSession, itemId: string, itemType: string, delta: string, payload: unknown): void { appendProcessDeltaAction(this.messageHost(), session, itemId, itemType, delta, payload); }
  private ensureThinkingMessage(session: StoredSession, title: string, text: string): void { ensureThinkingMessageAction(this.messageHost(), session, title, text); }
  private markThinkingAsStreaming(session: StoredSession): void { markThinkingAsStreamingAction(this.messageHost(), session); }
  private finishThinkingMessage(session: StoredSession, _status: string): void { finishThinkingMessageAction(this.messageHost(), session, _status); }
  private finishPlanMessage(session: StoredSession): void { finishPlanMessageAction(this.messageHost(), session); }
  private finishRunningProcessMessages(session: StoredSession, status: string): void { finishRunningProcessMessagesAction(this.messageHost(), session, status); }
  private renderPlanUpdate(session: StoredSession, params: unknown): void { renderPlanUpdateAction(this.messageHost(), session, params); }
  private renderStartedItem(session: StoredSession, item: unknown): void { renderStartedItemAction(this.messageHost(), session, item); }
  private async renderCompletedItem(session: StoredSession, item: unknown): Promise<void> { await renderCompletedItemAction(this.messageHost(), session, item); }
  private async upsertProcessItem(session: StoredSession, id: string, itemType: string, text: string, status: string | undefined, payload: unknown): Promise<void> { await upsertProcessItemAction(this.messageHost(), session, id, itemType, text, status, payload); }
  private addMessageToSession(session: StoredSession, message: SessionMessageInput): void { addMessageToSessionAction(this.messageHost(), session, message); }
  private scheduleSessionSave(): void { scheduleSessionSaveAction(this.messageHost()); }
  private async flushSessionSave(): Promise<void> { await flushSessionSaveAction(this.messageHost()); }
  private moveMessageToEnd(session: StoredSession, messageId: string): void { moveMessageToEndAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost, session, messageId); }
  private updateContextForSession(session: StoredSession, tokenUsage: TokenUsage | undefined, persist: boolean): void { updateContextForSessionAction(this.composerHost(), session, tokenUsage, persist); }

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
      onRetry: () => { this.mcpPanelEl.removeClass("is-visible"); void this.toggleMcpPanel(); },
      onLogin: (serverName) => this.plugin.codex?.startMcpOAuth(serverName) ?? Promise.resolve(null)
    });
  }

  private activeRunSession(): StoredSession { return activeRunSessionAction(this.sessionHost()); }
  private sessionForThread(threadId?: string): StoredSession | null { return sessionForThreadAction(this.sessionHost(), threadId); }
  private addContextCompactionMessage(session: StoredSession): void { addContextCompactionMessageAction(this.messageHost(), session); }
  private clearActiveRun(): void {
    if (typeof (this as unknown as { turnLifecycleHost?: unknown }).turnLifecycleHost === "function") {
      clearActiveRunAction(this.turnLifecycleHost(), () => clearSessionMessageActiveRun(this.messageHost()));
      return;
    }
    const host = this as unknown as { activeRunId: string; activeRunKind: string; activeRunSessionId: string; activeTurnId: string; editorActionActiveTimeoutMs?: number; activeThinkingMessageId?: string; activePlanMessageId?: string; activeItemMessages?: Map<string, string> };
    host.activeRunId = "";
    host.activeRunKind = "";
    host.activeRunSessionId = "";
    host.activeTurnId = "";
    host.editorActionActiveTimeoutMs = 0;
    host.activeThinkingMessageId = "";
    host.activePlanMessageId = "";
    host.activeItemMessages?.clear();
  }
  private attachTurnIdToRun(session: StoredSession, turnId: string): void { attachTurnIdToRunAction(this.messageHost(), session, turnId); }
  private renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void { renderMessagesIfActiveAction(this.messageHost(), session, updatedMessage); }
  private handleMessagesScroll(): void { handleMessagesScrollAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private scheduleRenderMessages(options: MessageRenderScheduleOptions = {}): void { scheduleRenderMessagesAction(this.messageHost(), options); }
  private scheduleMeasureVirtualRows(forceBottom = !this.messagesBottomFollowPaused): void { scheduleMeasureVirtualRowsAction(this.messageHost(), forceBottom); }
  private scheduleKnowledgeBaseRunProgress(): void { scheduleKnowledgeBaseRunProgressAction(this.messageHost()); }
  private clearKnowledgeBaseRunProgressTimer(): void { clearKnowledgeBaseRunProgressTimerAction(this.messageHost()); }
  private isMessagesNearBottom(): boolean { return isMessagesNearBottomAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private isMessagesAtBottom(): boolean { return isMessagesAtBottomAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private resetVirtualWindow(): void { resetVirtualWindowAction(this.messageHost()); }
  private ensureSession(): StoredSession { return ensureSessionAction(this.sessionHost()); }
  private isKnowledgeBaseSession(session: StoredSession): boolean { return isKnowledgeBaseSessionAction(this.sessionHost(), session); }
  private createSession(title = "新会话"): StoredSession { return createSessionAction(this.sessionHost(), title); }
  private attachActiveFile(): void { attachActiveFileAction(this.attachmentHost()); }
  private pickFiles(imagesOnly: boolean): void { pickFilesAction(this.attachmentHost(), imagesOnly); }
  private pickKnowledgeBaseFiles(): void { pickKnowledgeBaseFilesAction(this.attachmentHost()); }
  private handleDroppedFiles(event: DragEvent): void { handleDroppedFilesAction(this.attachmentHost(), event); }
  private async handlePastedFiles(event: ClipboardEvent): Promise<void> { await handlePastedFilesAction(this.attachmentHost(), event); }
}
