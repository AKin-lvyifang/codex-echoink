import { ItemView, MarkdownView, Notice, WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ChatMessage, StoredAttachment, StoredSession } from "../settings/settings";
import { newId, providerConnectionLabel } from "../settings/settings";
import type { EchoInkResource } from "../resources/types";
import type {
  PermissionMode,
  TokenUsage,
  UiMode
} from "../types/app-server";
import {
  cloneEchoInkTurnInteraction,
  type EchoInkTurnInteraction
} from "../types/conversation-turn";
import { diagnoseProviderError, type ProviderErrorDiagnostic } from "../core/provider-diagnostics";
import { buildUserInput } from "../core/mapping";
import { composerPrimaryActionForState, type ComposerPrimaryActionState } from "./composer-state";
import { canStartQueuedTurn, RuntimeTurnQueue, type QueuedTurnItem } from "./turn-queue";
import { clearPromptEnhanceReview } from "./codex-view/composer";
import { CodexMessageListRenderer, isProcessItemType } from "./codex-view/message-list";
import { loadMcpPanelView } from "./codex-view/mcp-panel";
import { enabledSkillResources, mcpResourceEnablement } from "../resources/registry";
import { MessageScrollFollowController, type MessageRenderScheduleOptions } from "./codex-view/message-scroll-follow";
import { enhanceChatInput as enhanceChatInputRunner } from "./codex-view/prompt-enhancer-runner";
import {
  afterTurnSettled as afterTurnSettledRunner,
  createQueuedTurnFromComposer as createQueuedTurnFromComposerRunner,
  enqueueComposerDraft as enqueueComposerDraftRunner,
  handlePiTaskPlanAction as handlePiTaskPlanActionRunner,
  resumeQueuedTurns as resumeQueuedTurnsRunner,
  runKnowledgeBaseShortcut as runKnowledgeBaseShortcutRunner,
  sendMessage as sendMessageRunner,
  steerPiChatFromComposer as steerPiChatFromComposerRunner,
  startChatTurn as startChatTurnRunner,
  startNextQueuedTurn as startNextQueuedTurnRunner,
  startQueuedTurnItem as startQueuedTurnItemRunner,
  startQueuedTurnItemSafely as startQueuedTurnItemSafelyRunner,
  resourceMatchesSkillId
} from "./codex-view/turn-runner";
import type {
  CodexViewLifecycleSnapshot,
  CodexViewPromptEnhanceContext,
  CodexViewTurnContext
} from "./codex-view/runner-context";
import type { SessionMessageInput } from "./codex-view/session-message-store";
import {
  addComposerNoteMentionSelection,
  clearComposerNoteMentions,
  composerNoteMentionSelections,
  type NoteMentionSelection
} from "./codex-view/note-mentions";
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
  currentEchoInkResourceCatalog as currentEchoInkResourceCatalogAction,
  currentTurnOptions as currentTurnOptionsAction,
  effectiveModel as effectiveModelAction,
  ensureChatWorkspaceSelected as ensureChatWorkspaceSelectedAction,
  openWorkspaceMenu as openWorkspaceMenuAction,
  type CodexWorkspaceHost
} from "./codex-view/workspace-controller";
import {
  clearComposerDraft as clearComposerDraftAction,
  closeComposerMenus as closeComposerMenusAction,
  composerStateForSession as composerStateForSessionAction,
  disposeContextPopover,
  fillKnowledgeBaseCommand as fillKnowledgeBaseCommandAction,
  onInputChanged as onInputChangedAction,
  openKnowledgeCommandMenu as openKnowledgeCommandMenuAction,
  openModelMenu as openModelMenuAction,
  pauseQueueForSession as pauseQueueForSessionAction,
  requireQueueRecoveryForSession as requireQueueRecoveryForSessionAction,
  renderKnowledgeCommandMatches as renderKnowledgeCommandMatchesAction,
  renderQueue as renderQueueAction,
  renderToolbar as renderToolbarAction,
  submitKnowledgeBaseCommand as submitKnowledgeBaseCommandAction,
  updateContextForSession as updateContextForSessionAction,
  selectComposerMode as selectComposerModeAction,
  type CodexComposerHost
} from "./codex-view/composer-controller";
import {
  addContextCompactionMessage as addContextCompactionMessageAction,
  addMessageToSession as addMessageToSessionAction,
  attachTurnIdToRun as attachTurnIdToRunAction,
  clearKnowledgeBaseRunProgressTimer as clearKnowledgeBaseRunProgressTimerAction,
  clearSessionMessageActiveRun,
  dismissThinkingMessage as dismissThinkingMessageAction,
  ensureThinkingMessage as ensureThinkingMessageAction,
  finishPlanMessage as finishPlanMessageAction,
  finishRunningProcessMessages as finishRunningProcessMessagesAction,
  finishThinkingMessage as finishThinkingMessageAction,
  flushSessionSave as flushSessionSaveAction,
  handleMessagesScroll as handleMessagesScrollAction,
  isMessagesAtBottom as isMessagesAtBottomAction,
  isMessagesNearBottom as isMessagesNearBottomAction,
  jumpToLatest as jumpToLatestAction,
  moveMessageToEnd as moveMessageToEndAction,
  renderMessages as renderMessagesAction,
  renderMessagesIfActive as renderMessagesIfActiveAction,
  resetVirtualWindow as resetVirtualWindowAction,
  scheduleKnowledgeBaseRunProgress as scheduleKnowledgeBaseRunProgressAction,
  scheduleMeasureVirtualRows as scheduleMeasureVirtualRowsAction,
  scheduleRenderMessages as scheduleRenderMessagesAction,
  scheduleSessionSave as scheduleSessionSaveAction,
  settleStaleMessages as settleStaleMessagesAction,
  type CodexMessageHost
} from "./codex-view/message-controller";
import {
  applyStatus as applyStatusAction,
  openPluginSettings as openPluginSettingsAction,
  updateInputPlaceholder as updateInputPlaceholderAction,
  type CodexHeaderHost
} from "./codex-view/header-controller";
import {
  armTurnWatchdog as armTurnWatchdogAction,
  clearActiveRun as clearActiveRunAction,
  clearTurnWatchdog as clearTurnWatchdogAction,
  stopTurn as stopTurnAction,
  type CodexTurnLifecycleHost
} from "./codex-view/turn-lifecycle";
import { refreshViewShellCopy, renderViewShell, type CodexViewShellHost } from "./codex-view/view-shell";
import { TurnNavigator } from "./codex-view/turn-navigator";
import { conversationUiText } from "./codex-view/ui-i18n";
import { TaskPlanDockController } from "./codex-view/task-plan-dock";
import { InteractionDockController } from "./codex-view/interaction-dock";
import { piToolCallIdFromProjectedMessageId } from "../harness/pi-native/pi-chat-ui-projector";
import { updateCodexHeaderIdentity } from "./codex-view/header";
import { closeComposerParameterMenu } from "./codex-view/menus";
import {
  activateSession as activateSessionAction,
  activeRunSession as activeRunSessionAction,
  archiveSession as archiveSessionAction,
  createSession as createSessionAction,
  discardUnacceptedSession,
  deleteSession as deleteSessionAction,
  ensureInitialConversation as ensureInitialConversationAction,
  ensureSession as ensureSessionAction,
  derivePiConversationFromMessage as derivePiConversationFromMessageAction,
  refreshPiConversationShells as refreshPiConversationShellsAction,
  renderTabsView,
  renameSession as renameSessionAction,
  sessionById as sessionByIdAction,
  type CodexSessionHost,
  type CreateSessionOptions
} from "./codex-view/session-controller";

export const VIEW_TYPE_CODEX = "codex-for-obsidian-view";
export { isKnowledgeDashboardHealthTooltipHoverPoint } from "./codex-view/knowledge-dashboard";

export interface HomeConversationStartInput {
  readonly title: string;
  readonly message: string;
  readonly defaultSkillId?: string;
  readonly journalDirectory?: string;
}

export interface ConversationRunState {
  running: boolean;
  activeRunId: string;
  activeRunKind: "chat" | "";
  activeRunSessionId: string;
  activeTurnId: string;
  turnStartedAt: number;
  turnWatchdog: number | null;
  queueStartInProgress: boolean;
  readonly controller: AbortController;
  context?: CodexViewTurnContext;
}

/**
 * Serializable-enough handoff bundle used when the conversation view moves
 * between the sidebar and the quick-chat popout window. Run states, the queue
 * and interaction maps are transferred by reference (Obsidian popouts share
 * the renderer JS heap); the successor view rebinds UI-facing closures.
 */
export interface CodexViewMigrationState {
  readonly runs: Array<[string, ConversationRunState]>;
  readonly turnQueue: RuntimeTurnQueue;
  readonly pendingInteractions: Array<[string, Readonly<EchoInkTurnInteraction>]>;
  readonly draftText: string;
  readonly composer: {
    selectedSkill: EchoInkResource | null;
    attachments: StoredAttachment[];
    noteMentions: readonly Readonly<NoteMentionSelection>[];
    selectedProviderSettingsId: string;
    selectedModel: string;
    selectedPermission: PermissionMode;
    selectedMode: UiMode;
  };
  readonly promptEnhancer: {
    running: boolean;
    runId: string;
    turnId: string;
  };
}

export class CodexView extends ItemView {
  private rootEl!: HTMLElement;
  private tabBarEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private virtualListEl!: HTMLElement;
  private jumpToLatestEl!: HTMLButtonElement;
  private turnNavigatorEl!: HTMLElement;
  private taskPlanDockEl!: HTMLElement;
  private interactionDockEl!: HTMLElement;
  private workspaceEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private promptEnhanceReviewEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private contextRingEl!: HTMLElement;
  private contextPanelEl: HTMLElement | null = null;
  private contextPanelCleanup: (() => void) | null = null;
  private contextPanelReposition: (() => void) | null = null;
  private contextPanelOpen = false;
  private skillMenuEl!: HTMLElement;
  private knowledgeCommandMenuEl!: HTMLElement;
  private resourcePanelEl!: HTMLElement;
  private resourcePanelAnchorEl!: HTMLButtonElement;
  private resourcePanelOpen = false;
  private resourcePanelResources: EchoInkResource[] = [];
  private mcpPanelEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private queueEl!: HTMLElement;
  private readonly conversationRuns = new Map<string, ConversationRunState>();
  private get currentConversationRun(): ConversationRunState | undefined {
    return this.conversationRuns.get(this.plugin.settings.activeSessionId);
  }
  private get running(): boolean {
    return Boolean(this.currentConversationRun?.running || this.currentConversationRun?.queueStartInProgress);
  }
  private get activeRunId(): string { return this.currentConversationRun?.activeRunId ?? ""; }
  private get activeRunKind(): "chat" | "" { return this.currentConversationRun?.activeRunKind ?? ""; }
  private get activeRunSessionId(): string { return this.running ? this.plugin.settings.activeSessionId : ""; }
  private get activeTurnId(): string { return this.currentConversationRun?.activeTurnId ?? ""; }
  private get runningSessionIds(): ReadonlySet<string> {
    return new Set([...this.conversationRuns].filter(([, run]) => run.running || run.queueStartInProgress).map(([id]) => id));
  }
  private promptEnhancerRunning = false;
  private promptEnhancerRunId = "";
  private promptEnhancerTurnId = "";
  private sessionSaveTimer: number | null = null;
  private readonly messageScrollFollow = new MessageScrollFollowController();
  private knowledgeBaseRunProgressTimer: number | null = null;
  private messageListRenderer = new CodexMessageListRenderer();
  private turnNavigator: TurnNavigator | null = null;
  private readonly taskPlanDock = new TaskPlanDockController();
  private readonly interactionDock = new InteractionDockController();
  private readonly pendingInteractionsBySession = new Map<
    string,
    Readonly<EchoInkTurnInteraction>
  >();
  private selectedSkill: EchoInkResource | null = null;
  private attachments: StoredAttachment[] = [];
  private selectedProviderSettingsId = "";
  private selectedModel = "";
  private selectedPermission: PermissionMode;
  private selectedMode: UiMode;
  private skillsRequested = false;
  private viewLifecycleGeneration = 0;
  private viewLifecycleAbortController = new AbortController();
  private turnQueue: RuntimeTurnQueue = new RuntimeTurnQueue();
  private migrationMode = false;
  private migrationSuccessor: CodexView | null = null;
  private guidedSessionStartInProgress = false;
  private draggedQueueItemId = "";
  private homeAttentionFrameTimer: number | null = null;
  private homeAttentionFrameGeneration = 0;
  private get turnRunnerContext(): CodexViewTurnContext { return this.createTurnRunnerContext(this.ensureSession().id); }
  private readonly promptEnhancerRunnerContext: CodexViewPromptEnhanceContext;

  get messagesBottomFollowPaused(): boolean {
    return this.messageScrollFollow.paused;
  }

  set messagesBottomFollowPaused(paused: boolean) {
    this.messageScrollFollow.paused = paused;
  }

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.selectedProviderSettingsId = plugin.settings.activeApiProviderId;
    this.selectedModel = plugin.settings.defaultModel;
    this.selectedPermission = plugin.settings.defaultPermission;
    this.selectedMode = plugin.settings.defaultMode;
    this.promptEnhancerRunnerContext = this.createPromptEnhancerRunnerContext();
  }

  private attachmentHost(): CodexAttachmentHost { return this as unknown as CodexAttachmentHost; }
  private sessionHost(): CodexSessionHost { return this as unknown as CodexSessionHost; }
  private workspaceHost(): CodexWorkspaceHost { return this as unknown as CodexWorkspaceHost; }
  private composerHost(): CodexComposerHost { return this as unknown as CodexComposerHost; }
  private messageHost(): CodexMessageHost { return this as unknown as CodexMessageHost; }
  private headerHost(): CodexHeaderHost { return this as unknown as CodexHeaderHost; }
  private turnLifecycleHost(sessionId = this.plugin.settings.activeSessionId): CodexTurnLifecycleHost {
    const view = this;
    const state = this.conversationRun(sessionId);
    const host: CodexTurnLifecycleHost = {
      get plugin() { return view.plugin; },
      get running() { return state.running; }, set running(value) { state.running = value; },
      get activeRunId() { return state.activeRunId; }, set activeRunId(value) { state.activeRunId = value; },
      get activeRunKind() { return state.activeRunKind; }, set activeRunKind(value) { state.activeRunKind = value; },
      get activeRunSessionId() { return state.activeRunSessionId; }, set activeRunSessionId(value) { state.activeRunSessionId = value; },
      get activeTurnId() { return state.activeTurnId; }, set activeTurnId(value) { state.activeTurnId = value; },
      get turnWatchdog() { return state.turnWatchdog; }, set turnWatchdog(value) { state.turnWatchdog = value; },
      cancelPendingTurn: () => state.controller.abort(),
      clearTurnWatchdog: () => clearTurnWatchdogAction(host),
      clearActiveRun: () => view.clearConversationRun(sessionId, state),
      applyStatus: () => view.applyStatus(),
      activeRunSession: () => view.sessionById(sessionId) ?? view.ensureSession(),
      pauseQueueForSession: (id) => view.pauseQueueForSession(id),
      finishThinkingMessage: (session, status) => view.finishThinkingMessage(session, status),
      finishRunningProcessMessages: (session, status) => view.finishRunningProcessMessages(session, status),
      addMessageToSession: (session, message) => view.addMessageToSession(session, message),
      afterTurnSettled: (id, succeeded) => view.afterTurnSettled(id, succeeded)
    };
    return host;
  }

  private conversationRun(sessionId: string): ConversationRunState {
    let state = this.conversationRuns.get(sessionId);
    if (!state) {
      state = {
        running: false, activeRunId: "", activeRunKind: "", activeRunSessionId: "",
        activeTurnId: "", turnStartedAt: 0, turnWatchdog: null, queueStartInProgress: false,
        controller: new AbortController()
      };
      if (this.viewLifecycleAbortController.signal.aborted) state.controller.abort();
      this.conversationRuns.set(sessionId, state);
    }
    return state;
  }

  private clearConversationRun(sessionId: string, state: ConversationRunState): void {
    state.activeRunId = "";
    state.activeRunKind = "";
    state.activeRunSessionId = "";
    state.activeTurnId = "";
    if (!state.running && !state.queueStartInProgress && this.conversationRuns.get(sessionId) === state) {
      this.conversationRuns.delete(sessionId);
    }
  }
  private shellHost(): CodexViewShellHost { return this as unknown as CodexViewShellHost; }

  private createTurnRunnerContext(sessionId: string): CodexViewTurnContext {
    const view = this;
    const state = this.conversationRun(sessionId);
    if (state.context) return state.context;
    const lifecycle = this.turnLifecycleHost(sessionId);
    const context: CodexViewTurnContext = {
      get lifecycleSignal() { return state.controller.signal; }, get app() { return view.app; }, get plugin() { return view.plugin; }, get running() { return state.running; }, set running(value) { state.running = value; }, get activeRunId() { return state.activeRunId; }, set activeRunId(value) { state.activeRunId = value; }, get activeRunKind() { return state.activeRunKind; }, set activeRunKind(value) { state.activeRunKind = value; }, get activeRunSessionId() { return state.activeRunSessionId; }, set activeRunSessionId(value) { state.activeRunSessionId = value; }, get activeTurnId() { return state.activeTurnId; }, set activeTurnId(value) { state.activeTurnId = value; },
      get turnQueue() { return view.turnQueue; }, get queueStartInProgress() { return state.queueStartInProgress; }, set queueStartInProgress(value) { state.queueStartInProgress = value; if (!value && !state.running) view.clearConversationRun(sessionId, state); }, get turnStartedAt() { return state.turnStartedAt; }, set turnStartedAt(value) { state.turnStartedAt = value; }, get inputEl() { return view.inputEl; }, get attachments() { return view.attachments; }, get selectedSkill() { return view.selectedSkill; }, get selectedProviderSettingsId() { return view.selectedProviderSettingsId; }, set selectedProviderSettingsId(value) { view.selectedProviderSettingsId = value; }, get selectedModel() { return view.selectedModel; }, set selectedModel(value) { view.selectedModel = value; }, get messagesBottomFollowPaused() { return view.messagesBottomFollowPaused; }, set messagesBottomFollowPaused(value) { view.messagesBottomFollowPaused = value; },
      applyStatus: () => view.applyStatus(), armTurnWatchdog: (timeoutMs, timeoutText) => armTurnWatchdogAction(lifecycle, timeoutMs, timeoutText), clearTurnWatchdog: () => clearTurnWatchdogAction(lifecycle), clearActiveRun: () => view.clearConversationRun(sessionId, state), renderToolbar: () => view.renderToolbar(), diagnoseCodexFailure: (error, model) => view.diagnoseCodexFailure(error, model), ensureSession: () => view.sessionById(sessionId) ?? view.ensureSession(), composerStateForSession: (session) => view.composerStateForSession(session), enqueueComposerDraft: () => enqueueComposerDraftRunner(context), resumeQueuedTurns: (sessionId) => view.resumeQueuedTurns(sessionId), stopTurn: () => stopTurnAction(lifecycle), pauseQueueForSession: (sessionId) => view.pauseQueueForSession(sessionId),
      createQueuedTurnFromComposer: (options) => createQueuedTurnFromComposerRunner(context, options), startQueuedTurnItem: (item, source) => view.startQueuedTurnItem(item, source), startQueuedTurnItemSafely: (item, source) => view.startQueuedTurnItemSafely(item, source), afterTurnSettled: (sessionId, succeeded) => view.afterTurnSettled(sessionId, succeeded), startNextQueuedTurn: (sessionId) => view.startNextQueuedTurn(sessionId), startChatTurn: (session, item, source) => view.startChatTurn(session, item, source), clearComposerDraft: () => { if (view.plugin.settings.activeSessionId === sessionId) view.clearComposerDraft(); },
      ensureChatWorkspaceSelected: (session) => view.ensureChatWorkspaceSelected(session), currentTurnOptions: (session) => view.currentTurnOptions(session), sessionById: (sessionId) => view.sessionById(sessionId), renderQueue: () => view.renderQueue(), renderTabs: () => view.renderTabs(), renderMessages: (options) => view.renderMessages(options), renderMessagesIfActive: (session, updatedMessage) => view.renderMessagesIfActive(session, updatedMessage), setPendingInteraction: (sessionId, interaction, expectedTurnId) => view.setPendingInteraction(sessionId, interaction, expectedTurnId), ensureThinkingMessage: (session, title, text) => view.ensureThinkingMessage(session, title, text), dismissThinkingMessage: (session) => view.dismissThinkingMessage(session), attachTurnIdToRun: (session, turnId) => view.attachTurnIdToRun(session, turnId), finishThinkingMessage: (session, status) => view.finishThinkingMessage(session, status), finishRunningProcessMessages: (session, status) => view.finishRunningProcessMessages(session, status), finishPlanMessage: (session) => view.finishPlanMessage(session), addMessageToSession: (session, message) => view.addMessageToSession(session, message), moveMessageToEnd: (session, messageId) => view.moveMessageToEnd(session, messageId), fillKnowledgeBaseCommand: (command) => view.fillKnowledgeBaseCommand(command)
    } satisfies CodexViewTurnContext;
    state.context = context;
    return context;
  }

  private createPromptEnhancerRunnerContext(): CodexViewPromptEnhanceContext {
    const view = this;
    return {
      get plugin() { return view.plugin; }, get normalTaskRunning() { return view.runningSessionIds.size > 0; }, get inputEl() { return view.inputEl; }, get promptEnhanceReviewEl() { return view.promptEnhanceReviewEl; }, get promptEnhancerRunning() { return view.promptEnhancerRunning; }, set promptEnhancerRunning(value) { view.promptEnhancerRunning = value; }, get promptEnhancerRunId() { return view.promptEnhancerRunId; }, set promptEnhancerRunId(value) { view.promptEnhancerRunId = value; }, get promptEnhancerTurnId() { return view.promptEnhancerTurnId; }, set promptEnhancerTurnId(value) { view.promptEnhancerTurnId = value; },
      captureViewLifecycle: () => view.captureViewLifecycle(), applyStatus: () => view.applyStatus(), renderToolbar: () => view.renderToolbar(), onInputChanged: () => view.onInputChanged(), focusInput: () => view.focusInput()
    } satisfies CodexViewPromptEnhanceContext;
  }


  getViewType(): string {
    return VIEW_TYPE_CODEX;
  }

  getDisplayText(): string {
    return "Codex";
  }

  getIcon(): string {
    return "feather";
  }

  refreshPersonalizationUi(): void {
    if (this.rootEl) {
      updateCodexHeaderIdentity(
        this.rootEl,
        this.plugin.getEchoInkAgentIdentityView()
      );
    }
    this.renderMessages({ preserveScroll: true });
  }

  refreshLanguage(): void {
    if (!this.rootEl) return;
    refreshViewShellCopy(this.shellHost());
    this.turnNavigator?.refreshLanguage();
    this.renderTabs();
    this.renderMessages({ preserveScroll: true });
    this.renderToolbar();
    const session = this.sessionById(this.plugin.settings.activeSessionId) ?? this.ensureSession();
    this.renderTaskPlanDock(session);
    this.renderInteractionDock(session);
    if (this.mcpPanelEl?.hasClass("is-visible")) void this.loadMcpPanel();
  }

  async onOpen(): Promise<void> {
    this.viewLifecycleAbortController?.abort();
    this.viewLifecycleGeneration = (
      Number.isSafeInteger(this.viewLifecycleGeneration)
        ? this.viewLifecycleGeneration
        : 0
    ) + 1;
    this.viewLifecycleAbortController = new AbortController();
    try {
      await refreshPiConversationShellsAction(this.sessionHost());
    } catch (error) {
      console.error("Pi Conversation Catalog refresh failed", error);
      new Notice(
        `${conversationUiText(this.plugin.settings.settingsLanguage, "读取会话列表失败：", "Could not load the conversation list: ")}${error instanceof Error ? error.message : String(error)}`
      );
    }
    const initialConversation = await ensureInitialConversationAction(this.sessionHost());
    this.render();
    if (!initialConversation.created) {
      try {
        await activateSessionAction(this.sessionHost(), initialConversation.session);
      } catch (error) {
        console.error("Pi Conversation activation failed", error);
        new Notice(
          `${conversationUiText(this.plugin.settings.settingsLanguage, "恢复会话失败：", "Could not restore the conversation: ")}${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    this.applyStatus();
  }

  async onClose(): Promise<void> {
    // Window migration (quick-chat popout <-> sidebar) must NOT cancel live
    // runs: the harness run, queue and Pi conversation stay owned by the
    // plugin layer and are handed over to the successor view instance.
    const migrating = this.migrationMode;
    this.viewLifecycleGeneration = (
      Number.isSafeInteger(this.viewLifecycleGeneration)
        ? this.viewLifecycleGeneration
        : 0
    ) + 1;
    this.viewLifecycleAbortController?.abort();
    try {
      closeComposerParameterMenu();
      disposeContextPopover(this.composerHost());
      this.contextPanelOpen = false;
      this.clearKnowledgeBaseRunProgressTimer();
      const closingRuns = [...this.conversationRuns];
      if (migrating) {
        // Only disarm timers bound to this dying DOM context; run state itself
        // was exported before the move and survives on the successor.
        for (const [, state] of closingRuns) {
          if (state.turnWatchdog !== null) window.clearTimeout(state.turnWatchdog);
          state.turnWatchdog = null;
        }
        this.promptEnhancerRunning = false;
        this.promptEnhancerRunId = "";
        this.promptEnhancerTurnId = "";
      } else {
        for (const [sessionId, state] of closingRuns) {
          state.controller.abort();
          this.turnQueue.pauseSessionQueue(sessionId);
          if (state.turnWatchdog !== null) window.clearTimeout(state.turnWatchdog);
          state.turnWatchdog = null;
        }
        const promptEnhancerRunId = this.promptEnhancerRunId;
        this.promptEnhancerRunning = false;
        this.promptEnhancerRunId = "";
        this.promptEnhancerTurnId = "";
        if (promptEnhancerRunId) {
          await this.plugin.cancelHarnessRun(promptEnhancerRunId).catch((error) => {
            console.error("Prompt enhancer cancellation failed while closing EchoInk", error);
          });
        }
        await Promise.all(closingRuns.map(async ([sessionId, state]) => {
          if (state.activeRunId) {
            await this.plugin.cancelHarnessRun(state.activeRunId).catch((error) => {
              console.error("Chat cancellation failed while closing EchoInk", error);
            });
          }
          await this.plugin.releasePiConversation(sessionId).catch((error) => {
            console.error("Pi Conversation release failed while closing EchoInk", error);
          });
        }));
      }
      await this.flushSessionSave();
      if (!migrating) {
        const activeSession = this.plugin.settings.sessions.find(
          (session) => session.id === this.plugin.settings.activeSessionId
        );
        if (activeSession && !closingRuns.some(([id]) => id === activeSession.id)) {
          await this.plugin.releasePiConversation(activeSession.id).catch((error) => {
            console.error("Pi Conversation release failed while closing EchoInk", error);
          });
        }
      }
    } finally {
      this.conversationRuns.clear();
      this.clearHomeAttentionFrame();
      this.taskPlanDock.dispose();
      this.interactionDock.dispose();
      this.pendingInteractionsBySession.clear();
      this.messageListRenderer.dispose();
      this.turnNavigator?.dispose();
      this.turnNavigator = null;
    }
  }

  private captureViewLifecycle(): CodexViewLifecycleSnapshot {
    return {
      generation: this.viewLifecycleGeneration,
      signal: this.viewLifecycleAbortController.signal
    };
  }

  /**
   * Quick-chat window migration API. The controller calls enterMigrationMode
   * before Obsidian destroys this view instance (moveLeafToPopout / detach),
   * exports the live state, and imports it into the rebuilt instance. While
   * migrating, onClose keeps harness runs, queues and Pi conversations alive.
   */
  enterMigrationMode(): void {
    this.migrationMode = true;
  }

  exitMigrationMode(): void {
    this.migrationMode = false;
  }

  get isMigrating(): boolean {
    return this.migrationMode;
  }

  get migrationTarget(): CodexView | null {
    return this.migrationSuccessor;
  }

  exportMigrationState(): CodexViewMigrationState {
    return {
      runs: [...this.conversationRuns],
      turnQueue: this.turnQueue,
      pendingInteractions: [...this.pendingInteractionsBySession],
      draftText: this.inputEl?.value ?? "",
      composer: {
        selectedSkill: this.selectedSkill,
        attachments: this.attachments,
        noteMentions: this.inputEl ? composerNoteMentionSelections(this.inputEl) : [],
        selectedProviderSettingsId: this.selectedProviderSettingsId,
        selectedModel: this.selectedModel,
        selectedPermission: this.selectedPermission,
        selectedMode: this.selectedMode
      },
      promptEnhancer: {
        running: this.promptEnhancerRunning,
        runId: this.promptEnhancerRunId,
        turnId: this.promptEnhancerTurnId
      }
    };
  }

  importMigrationState(state: Readonly<CodexViewMigrationState>): void {
    for (const [sessionId, runState] of state.runs) {
      runState.turnWatchdog = null;
      // The cached turn context closes over the previous instance's DOM;
      // force this view to rebuild its own context lazily.
      runState.context = undefined;
      this.conversationRuns.set(sessionId, runState);
    }
    this.turnQueue = state.turnQueue;
    for (const [sessionId, interaction] of state.pendingInteractions) {
      this.pendingInteractionsBySession.set(sessionId, interaction);
    }
    this.selectedSkill = state.composer.selectedSkill;
    this.attachments = state.composer.attachments;
    this.selectedProviderSettingsId = state.composer.selectedProviderSettingsId;
    this.selectedModel = state.composer.selectedModel;
    this.selectedPermission = state.composer.selectedPermission;
    this.selectedMode = state.composer.selectedMode;
    this.promptEnhancerRunning = state.promptEnhancer.running;
    this.promptEnhancerRunId = state.promptEnhancer.runId;
    this.promptEnhancerTurnId = state.promptEnhancer.turnId;
    if (this.inputEl) {
      this.inputEl.value = state.draftText;
      this.inputEl.setSelectionRange(state.draftText.length, state.draftText.length);
      clearComposerNoteMentions(this.inputEl);
      for (const mention of state.composer.noteMentions) {
        addComposerNoteMentionSelection(this.inputEl, mention);
      }
    }
    for (const [sessionId, runState] of this.conversationRuns) {
      if (!runState.running && !runState.queueStartInProgress) continue;
      if (runState.turnWatchdog !== null) continue;
      armTurnWatchdogAction(this.turnLifecycleHost(sessionId));
    }
    this.renderAttachments();
    this.renderQueue();
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    this.applyStatus();
    const activeSession = this.sessionById(this.plugin.settings.activeSessionId);
    if (activeSession) {
      this.renderTaskPlanDock(activeSession);
      this.renderInteractionDock(activeSession);
    }
  }

  /**
   * After a migration rebuilt the view, old turn-runner subscriptions still
   * close over THIS instance. Forward the UI-facing methods to the successor
   * so streaming updates keep rendering while run data keeps flowing into the
   * shared session objects. Data-layer methods that write to shared settings
   * (scheduleSessionSave/flushSessionSave) intentionally stay local.
   */
  installMigrationForwarding(target: CodexView): void {
    if (target === this) return;
    this.migrationSuccessor = target;
    const self = this as unknown as Record<string, unknown>;
    const destination = target as unknown as Record<string, unknown>;
    for (const name of CodexView.MIGRATION_FORWARDED_METHODS) {
      if (typeof destination[name] !== "function") continue;
      Object.defineProperty(self, name, {
        value: (...args: unknown[]) => {
          const method = destination[name];
          if (typeof method !== "function") return undefined;
          const result: unknown = (method as (...methodArgs: unknown[]) => unknown).apply(target, args);
          return result;
        },
        configurable: true,
        writable: true
      });
    }
  }

  returnQuickChatToSidebar(): void {
    void this.plugin.returnQuickChatToSidebar();
  }

  private static readonly MIGRATION_FORWARDED_METHODS = [
    "renderMessagesIfActive",
    "renderMessages",
    "renderToolbar",
    "renderQueue",
    "renderTabs",
    "renderAttachments",
    "applyStatus",
    "updateInputPlaceholder",
    "ensureThinkingMessage",
    "dismissThinkingMessage",
    "finishThinkingMessage",
    "finishRunningProcessMessages",
    "finishPlanMessage",
    "addMessageToSession",
    "moveMessageToEnd",
    "attachTurnIdToRun",
    "addContextCompactionMessage",
    "scheduleRenderMessages",
    "scheduleMeasureVirtualRows",
    "scheduleKnowledgeBaseRunProgress",
    "clearKnowledgeBaseRunProgressTimer",
    "setPendingInteraction",
    "afterTurnSettled",
    "startNextQueuedTurn",
    "updateContextForSession",
    "isMessagesNearBottom",
    "isMessagesAtBottom",
    "jumpToLatest",
    "resetVirtualWindow",
    "composerStateForSession",
    "currentTurnOptions",
    "effectiveModel",
    "sessionById",
    "ensureSession",
    "clearComposerDraft",
    "fillKnowledgeBaseCommand",
    "focusInput",
    "renderTaskPlanDock",
    "renderInteractionDock",
    "diagnoseCodexFailure",
    "pauseQueueForSession",
    "requireQueueRecoveryForSession",
    "clearConversationRun",
    "settleStaleMessages",
    "refreshActiveSession"
  ] as const;

  applySavedComposerDefaults(): void {
    this.selectedProviderSettingsId = this.plugin.settings.activeApiProviderId;
    this.selectedModel = this.plugin.settings.defaultModel;
    this.selectedPermission = this.plugin.settings.defaultPermission;
    this.selectedMode = this.plugin.settings.defaultMode;
    this.renderToolbar();
  }

  refreshActiveSession(): void {
    this.resetVirtualWindow();
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    this.updateInputPlaceholder();
    this.focusInput();
  }

  isConversationInUse(id: string): boolean {
    return this.plugin.settings.activeSessionId === id
      || this.runningSessionIds.has(id) || this.turnQueue.hasQueuedItems(id);
  }
  refreshAfterAutomaticArchive(): void { this.renderTabs(); }

  async refreshPiConversationCatalog(): Promise<void> {
    await refreshPiConversationShellsAction(this.sessionHost());
    this.refreshActiveSession();
  }

  refreshKnowledgeBaseDashboard(): void {
    this.renderToolbar();
  }

  refreshAfterBackgroundKnowledgeMessage(): void {
    this.renderTabs();
    this.renderMessages({ forceBottom: this.isMessagesNearBottom() });
  }

  private diagnoseCodexFailure(error: unknown, model = this.effectiveModel()): ProviderErrorDiagnostic {
    return diagnoseProviderError(error, {
      model,
      providerLabel: providerConnectionLabel(
        this.plugin.settings,
        this.plugin.settings.settingsLanguage
      )
    });
  }

  focusInput(): void {
    window.setTimeout(() => this.inputEl?.focus(), 50);
  }

  async createDraftSession(title: string, draft: string): Promise<StoredSession> {
    const session = await this.createSession(title);
    clearComposerDraftAction(this.composerHost());
    this.inputEl.value = draft;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.inputEl.setSelectionRange(draft.length, draft.length);
    this.focusInput();
    return session;
  }

  async startHomeConversation(
    input: Readonly<HomeConversationStartInput>
  ): Promise<StoredSession> {
    const message = input.message.trim();
    if (!message) {
      throw new Error(conversationUiText(
        this.plugin.settings.settingsLanguage,
        "首页会话开场消息不能为空",
        "The Home conversation opening message cannot be empty"
      ));
    }
    this.playHomeAttentionFrame();
    const session = await this.createSession(input.title, {
      ...(input.defaultSkillId ? { defaultSkillId: input.defaultSkillId } : {}),
      ...(input.journalDirectory
        ? { journalDirectory: input.journalDirectory }
        : {})
    });
    clearComposerDraftAction(this.composerHost());
    this.inputEl.value = message;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.inputEl.setSelectionRange(message.length, message.length);
    await this.sendMessage();
    return session;
  }

  private playHomeAttentionFrame(): void {
    if (!this.rootEl) return;
    const root = this.rootEl;
    const generation = ++this.homeAttentionFrameGeneration;
    if (this.homeAttentionFrameTimer !== null) {
      window.clearTimeout(this.homeAttentionFrameTimer);
      this.homeAttentionFrameTimer = null;
    }
    root.removeClass("is-home-attention-frame");
    window.requestAnimationFrame(() => {
      if (generation !== this.homeAttentionFrameGeneration || root !== this.rootEl) return;
      root.addClass("is-home-attention-frame");
      this.homeAttentionFrameTimer = window.setTimeout(() => {
        if (generation !== this.homeAttentionFrameGeneration) return;
        root.removeClass("is-home-attention-frame");
        this.homeAttentionFrameTimer = null;
      }, 1_250);
    });
  }

  private clearHomeAttentionFrame(): void {
    this.homeAttentionFrameGeneration += 1;
    if (this.homeAttentionFrameTimer !== null) {
      window.clearTimeout(this.homeAttentionFrameTimer);
      this.homeAttentionFrameTimer = null;
    }
    this.rootEl?.removeClass("is-home-attention-frame");
  }

  async createAndStartGuidedSession(input: Readonly<{
    title: string;
    prompt: string;
    defaultSkillId: string;
  }>): Promise<StoredSession> {
    if (
      this.guidedSessionStartInProgress
      || Boolean(this.plugin.getKnowledgeSurfaceService()?.isRunning)
    ) {
      throw new Error(conversationUiText(
        this.plugin.settings.settingsLanguage,
        "当前 Agent 正在运行，请结束后再开始知识复盘",
        "The Agent is currently running. Wait for it to finish before starting a knowledge review."
      ));
    }
    this.guidedSessionStartInProgress = true;
    let session: StoredSession | null = null;
    try {
      const skill = enabledSkillResources(
        await this.plugin.buildRuntimeEchoInkResourceCatalog()
      ).find((candidate) => resourceMatchesSkillId(
        candidate,
        input.defaultSkillId
      ));
      if (!skill?.contentPath?.trim() || !skill.name.trim()) {
        throw new Error(conversationUiText(
          this.plugin.settings.settingsLanguage,
          `知识复盘 Skill ${input.defaultSkillId} 已禁用、不存在或无法加载`,
          `The knowledge review Skill ${input.defaultSkillId} is disabled, missing, or could not be loaded.`
        ));
      }
      session = await this.createSession(input.title, {
        defaultSkillId: input.defaultSkillId
      });
      clearComposerDraftAction(this.composerHost());
      const item: QueuedTurnItem = {
        id: newId("queued-turn"),
        sessionId: session.id,
        text: input.prompt,
        attachments: [],
        skill: null,
        turnOptions: this.currentTurnOptions(session),
        kind: "chat",
        createdAt: Date.now()
      };
      const outcome = await this.startQueuedTurnItemSafely(item, "composer");
      if (outcome !== "running") {
        await this.afterTurnSettled(item.sessionId, outcome === "completed");
      }
      if (outcome === "failed" && item.piUserEntryAccepted !== true) {
        await discardUnacceptedSession(this.sessionHost(), session.id);
        session = null;
        throw new Error(conversationUiText(
          this.plugin.settings.settingsLanguage,
          "知识复盘提示语未被 Agent 接受，请检查 Provider 后重试",
          "The Agent did not accept the knowledge review prompt. Check the Provider and try again."
        ));
      }
      return session;
    } catch (error) {
      if (session) {
        await discardUnacceptedSession(this.sessionHost(), session.id)
          .catch(() => undefined);
      }
      throw error;
    } finally {
      this.guidedSessionStartInProgress = false;
    }
  }

  private render(): void {
    renderViewShell(this.shellHost());
    this.turnNavigator?.dispose();
    this.turnNavigator = new TurnNavigator(this.messageHost(), this.turnNavigatorEl);
  }

  private updateInputPlaceholder(): void { updateInputPlaceholderAction(this.headerHost()); }
  private applyStatus(): void { applyStatusAction(this.headerHost()); }
  private openPluginSettings(): void { openPluginSettingsAction(this.headerHost()); }
  private renderTabs(): void { renderTabsView(this.sessionHost()); }
  private renderMessages(options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void {
    renderMessagesAction(this.messageHost(), options);
    this.turnNavigator?.handleRender();
  }
  private renderTaskPlanDock(session: StoredSession): void {
    this.taskPlanDock.render(this.taskPlanDockEl, {
      sessionId: session.id,
      language: this.plugin.settings.settingsLanguage,
      messages: session.bodyAuthority === "pi_session_only"
        ? session.messages
        : [],
      onAction: (planId, action) => this.handlePiTaskPlanAction(planId, action),
      onModify: (planId, title) => this.preparePiTaskPlanModification(planId, title)
    });
  }
  private renderInteractionDock(session: StoredSession): void {
    const pending = this.pendingInteractionsBySession.get(session.id);
    const questionBinding = pending?.kind === "question"
      && pending.status === "pending"
      && pending.conversationId === session.id
      && pending.piSessionId === session.piSessionId
      ? this.plugin.piTurnInteractionBinding({
          conversationId: session.id,
          piSessionId: pending.piSessionId,
          productRunId: pending.turnId,
          interactionId: pending.interactionId
        })
      : null;
    const confirmationBinding = session.bodyAuthority === "pi_session_only"
      ? this.pendingApprovalBinding(session)
      : null;
    this.interactionDock.render(this.interactionDockEl, {
      sessionId: session.id,
      language: this.plugin.settings.settingsLanguage,
      ...(questionBinding
        ? {
            question: {
              binding: questionBinding,
              onResolved: () => {
                this.setPendingInteraction(session.id, null, pending?.turnId);
              }
            }
          }
        : {}),
      ...(confirmationBinding
        ? {
            confirmation: {
              binding: confirmationBinding,
              onResolved: () => this.renderInteractionDock(session)
            }
          }
        : {}),
      onStale: () => {
        new Notice(conversationUiText(
          this.plugin.settings.settingsLanguage,
          "该交互已失效，请等待当前会话状态刷新。",
          "This interaction is no longer valid. Wait for the conversation state to refresh."
        ));
        this.renderInteractionDock(session);
      },
      onScheduleMeasure: () => this.scheduleMeasureVirtualRows()
    });
  }
  private pendingApprovalBinding(session: StoredSession) {
    const piSessionId = session.piSessionId?.trim();
    if (!piSessionId) return null;
    for (const message of session.messages.slice().reverse()) {
      const productRunId = message.runId?.trim();
      const toolCallId = piToolCallIdFromProjectedMessageId(message.id);
      if (!productRunId || !toolCallId) continue;
      const binding = this.plugin.piAgentApprovalBinding({
        conversationId: session.id,
        piSessionId,
        productRunId,
        toolCallId
      });
      if (binding) return binding;
    }
    return null;
  }
  private setPendingInteraction(
    sessionId: string,
    interaction: Readonly<EchoInkTurnInteraction> | null,
    expectedTurnId?: string
  ): void {
    const current = this.pendingInteractionsBySession.get(sessionId);
    if (interaction) {
      if (interaction.conversationId !== sessionId) return;
      this.pendingInteractionsBySession.set(
        sessionId,
        cloneEchoInkTurnInteraction(interaction)
      );
    } else if (!expectedTurnId || current?.turnId === expectedTurnId) {
      this.pendingInteractionsBySession.delete(sessionId);
    }
    if (this.plugin.settings.activeSessionId === sessionId) {
      const session = this.sessionById(sessionId);
      if (session) this.renderInteractionDock(session);
    }
  }
  private renderToolbar(): void { renderToolbarAction(this.composerHost()); }
  private enhancePrompt(): void { void enhanceChatInputRunner(this.promptEnhancerRunnerContext); }
  private renderQueue(): void { renderQueueAction(this.composerHost()); }
  private renderAttachments(): void { renderAttachmentsView(this.attachmentHost()); }
  private closeComposerMenus(): void { closeComposerMenusAction(this.composerHost()); }
  private openWorkspaceMenu(event: MouseEvent, session: StoredSession): void { openWorkspaceMenuAction(this.workspaceHost(), event, session); }

  private async ensureChatWorkspaceSelected(session: StoredSession): Promise<boolean> {
    const host = this.workspaceHost();
    return await ensureChatWorkspaceSelectedAction(host, session, true);
  }

  private openKnowledgeCommandMenu(event: MouseEvent): void { openKnowledgeCommandMenuAction(this.composerHost(), event); }
  fillKnowledgeBaseCommand(command: string): void { fillKnowledgeBaseCommandAction(this.composerHost(), command); }
  async submitKnowledgeBaseCommand(command: string): Promise<void> { await submitKnowledgeBaseCommandAction(this.composerHost(), command); }
  private openModelMenu(event: MouseEvent): void { openModelMenuAction(this.composerHost(), event); }

  private async renameSession(session: StoredSession): Promise<void> {
    await renameSessionAction(this.sessionHost(), session);
  }

  private async archiveSession(sessionId: string): Promise<void> {
    await archiveSessionAction(this.sessionHost(), sessionId);
  }

  private async derivePiConversationFromMessage(
    session: StoredSession,
    targetEntryId: string
  ): Promise<void> {
    await derivePiConversationFromMessageAction(
      this.sessionHost(),
      session,
      targetEntryId
    );
  }

  private async deleteSession(sessionId: string): Promise<void> {
    await deleteSessionAction(this.sessionHost(), sessionId);
  }

  private onInputChanged(): void {
    onInputChangedAction(this.composerHost());
  }
  private renderKnowledgeCommandMatches(query: string): void { renderKnowledgeCommandMatchesAction(this.composerHost(), query); }
  private clearComposerDraft(): void { clearComposerDraftAction(this.composerHost()); }
  private composerStateForSession(session: StoredSession): ComposerPrimaryActionState { return composerStateForSessionAction(this.composerHost(), session); }
  private pauseQueueForSession(sessionId: string): void { pauseQueueForSessionAction(this.composerHost(), sessionId); }
  private requireQueueRecoveryForSession(sessionId: string): void { requireQueueRecoveryForSessionAction(this.composerHost(), sessionId); }
  private sessionById(sessionId: string): StoredSession | null { return sessionByIdAction(this.sessionHost(), sessionId); }

  private async sendMessage(): Promise<void> {
    if (this.promptEnhancerRunning) {
      new Notice(conversationUiText(this.plugin.settings.settingsLanguage, "提示词正在增强，请稍候", "The prompt is being enhanced. Please wait."));
      return;
    }
    await sendMessageRunner(this.turnRunnerContext);
  }

  private async enqueueComposerDraft(): Promise<void> {
    if (this.promptEnhancerRunning) {
      new Notice(conversationUiText(this.plugin.settings.settingsLanguage, "提示词正在增强，请稍候", "The prompt is being enhanced. Please wait."));
      return;
    }
    await enqueueComposerDraftRunner(this.turnRunnerContext);
  }
  private async steerPiChatFromComposer(): Promise<void> {
    if (this.promptEnhancerRunning) {
      new Notice(conversationUiText(this.plugin.settings.settingsLanguage, "提示词正在增强，请稍候", "The prompt is being enhanced. Please wait."));
      return;
    }
    await steerPiChatFromComposerRunner(this.turnRunnerContext);
  }
  private async handlePiTaskPlanAction(
    planId: string,
    action: "execute" | "continue" | "pause" | "cancel"
  ): Promise<void> {
    await handlePiTaskPlanActionRunner(this.turnRunnerContext, planId, action);
  }
  private preparePiTaskPlanModification(planId: string, title: string): void {
    if (this.running) {
      new Notice(conversationUiText(
        this.plugin.settings.settingsLanguage,
        "请先暂停当前计划，再修改计划。",
        "Pause the current plan before editing it."
      ));
      return;
    }
    selectComposerModeAction(this.composerHost(), "plan");
    this.inputEl.value = `请修改任务计划“${title}”（planId: ${planId}）：`;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.focusInput();
  }
  private async resumeQueuedTurns(sessionId: string): Promise<void> { await resumeQueuedTurnsRunner(this.createTurnRunnerContext(sessionId), sessionId); }
  private async afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void> { if (this.viewLifecycleAbortController.signal.aborted) return; await afterTurnSettledRunner(this.createTurnRunnerContext(sessionId), sessionId, succeeded); }
  private async startNextQueuedTurn(sessionId: string): Promise<void> { if (this.viewLifecycleAbortController.signal.aborted) return; await startNextQueuedTurnRunner(this.createTurnRunnerContext(sessionId), sessionId); }
  private async createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> { return await createQueuedTurnFromComposerRunner(this.turnRunnerContext, options); }
  private async startQueuedTurnItem(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await startQueuedTurnItemRunner(this.createTurnRunnerContext(item.sessionId), item, source); }
  private async startQueuedTurnItemSafely(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await startQueuedTurnItemSafelyRunner(this.createTurnRunnerContext(item.sessionId), item, source); }
  private async startChatTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await startChatTurnRunner(this.createTurnRunnerContext(session.id), session, item, source); }
  private async runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void> { await runKnowledgeBaseShortcutRunner(this.turnRunnerContext, label, runner); }
  private async stopTurn(): Promise<void> { await stopTurnAction(this.turnLifecycleHost()); }
  private settleStaleMessages(session: StoredSession): void { settleStaleMessagesAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost, session); }
  private armTurnWatchdog(timeoutMs?: number, timeoutText?: string): void { armTurnWatchdogAction(this.turnLifecycleHost(), timeoutMs, timeoutText); }
  private clearTurnWatchdog(): void { clearTurnWatchdogAction(this.turnLifecycleHost()); }
  private currentTurnOptions(session?: StoredSession) { return currentTurnOptionsAction(this.workspaceHost(), session); }
  private currentEchoInkResourceCatalog(): EchoInkResource[] { return currentEchoInkResourceCatalogAction(this.workspaceHost()); }
  private effectiveModel(): string { return effectiveModelAction(this.workspaceHost()); }

  private ensureThinkingMessage(session: StoredSession, title: string, text: string): void { ensureThinkingMessageAction(this.messageHost(), session, title, text); }
  private dismissThinkingMessage(session: StoredSession): void { dismissThinkingMessageAction(this.messageHost(), session); }
  private finishThinkingMessage(session: StoredSession, _status: string): void { finishThinkingMessageAction(this.messageHost(), session, _status); }
  private finishPlanMessage(session: StoredSession): void { finishPlanMessageAction(this.messageHost(), session); }
  private finishRunningProcessMessages(session: StoredSession, status: string): void { finishRunningProcessMessagesAction(this.messageHost(), session, status); }
  private addMessageToSession(session: StoredSession, message: SessionMessageInput): void { addMessageToSessionAction(this.messageHost(), session, message); }
  private scheduleSessionSave(): void { scheduleSessionSaveAction(this.messageHost()); }
  private async flushSessionSave(): Promise<void> { await flushSessionSaveAction(this.messageHost()); }
  private moveMessageToEnd(session: StoredSession, messageId: string): void { moveMessageToEndAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost, session, messageId); }
  private updateContext(tokenUsage: TokenUsage | undefined, persist: boolean): void { this.updateContextForSession(this.ensureSession(), tokenUsage, persist); }
  private updateContextForSession(session: StoredSession, tokenUsage: TokenUsage | undefined, persist: boolean): void { updateContextForSessionAction(this.composerHost(), session, tokenUsage, persist); }

  private async toggleMcpPanel(): Promise<void> {
    const willOpen = !this.mcpPanelEl.hasClass("is-visible");
    this.mcpPanelEl.toggleClass("is-visible", willOpen);
    if (!willOpen) return;
    this.mcpPanelEl.empty();
    const language = this.plugin.settings.settingsLanguage;
    this.mcpPanelEl.createDiv({ cls: "codex-mcp-title", text: conversationUiText(language, "MCP 状态", "MCP status") });
    this.mcpPanelEl.createDiv({ cls: "codex-mcp-empty", text: conversationUiText(language, "正在读取 MCP 状态...", "Loading MCP status...") });
    await this.loadMcpPanel();
  }

  private async loadMcpPanel(): Promise<void> {
    await loadMcpPanelView({
      container: this.mcpPanelEl,
      language: this.plugin.settings.settingsLanguage,
      loadResources: () => mcpResourceEnablement(
        this.currentEchoInkResourceCatalog()
      )
    });
  }

  private activeRunSession(): StoredSession { return activeRunSessionAction(this.sessionHost()); }
  private addContextCompactionMessage(session: StoredSession): void { addContextCompactionMessageAction(this.messageHost(), session); }
  private clearActiveRun(): void {
    if (typeof (this as unknown as { turnLifecycleHost?: unknown }).turnLifecycleHost === "function") {
      clearActiveRunAction(this.turnLifecycleHost(), () => clearSessionMessageActiveRun(this.messageHost()));
      return;
    }
    const host = this as unknown as { activeRunId: string; activeRunKind: string; activeRunSessionId: string; activeTurnId: string; activeThinkingMessageId?: string; activePlanMessageId?: string };
    host.activeRunId = "";
    host.activeRunKind = "";
    host.activeRunSessionId = "";
    host.activeTurnId = "";
    host.activeThinkingMessageId = "";
    host.activePlanMessageId = "";
  }
  private attachTurnIdToRun(session: StoredSession, turnId: string): void { attachTurnIdToRunAction(this.messageHost(), session, turnId); }
  private renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void { renderMessagesIfActiveAction(this.messageHost(), session, updatedMessage); }
  private handleMessagesScroll(): void {
    handleMessagesScrollAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost);
    this.turnNavigator?.handleScroll();
  }
  private jumpToLatest(): void { jumpToLatestAction(this.messageHost()); }
  private scheduleRenderMessages(options: MessageRenderScheduleOptions = {}): void { scheduleRenderMessagesAction(this.messageHost(), options); }
  private scheduleMeasureVirtualRows(forceBottom = !this.messagesBottomFollowPaused): void { scheduleMeasureVirtualRowsAction(this.messageHost(), forceBottom); }
  private scheduleKnowledgeBaseRunProgress(): void { scheduleKnowledgeBaseRunProgressAction(this.messageHost()); }
  private clearKnowledgeBaseRunProgressTimer(): void { clearKnowledgeBaseRunProgressTimerAction(this.messageHost()); }
  private isMessagesNearBottom(): boolean { return isMessagesNearBottomAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private isMessagesAtBottom(): boolean { return isMessagesAtBottomAction(typeof (this as unknown as { messageHost?: unknown }).messageHost === "function" ? this.messageHost() : this as unknown as CodexMessageHost); }
  private resetVirtualWindow(): void { resetVirtualWindowAction(this.messageHost()); }
  private ensureSession(): StoredSession { return ensureSessionAction(this.sessionHost()); }
  private async createSession(
    title?: string,
    options: CreateSessionOptions = {}
  ): Promise<StoredSession> {
    return await createSessionAction(
      this.sessionHost(),
      title ?? conversationUiText(this.plugin.settings.settingsLanguage, "新会话", "New conversation"),
      options
    );
  }
  private attachActiveFile(): void { attachActiveFileAction(this.attachmentHost()); }
  private pickFiles(imagesOnly: boolean): void { pickFilesAction(this.attachmentHost(), imagesOnly); }
  private pickKnowledgeBaseFiles(): void { pickKnowledgeBaseFilesAction(this.attachmentHost()); }
  private handleDroppedFiles(event: DragEvent): void { handleDroppedFilesAction(this.attachmentHost(), event); }
  private async handlePastedFiles(event: ClipboardEvent): Promise<void> { await handlePastedFilesAction(this.attachmentHost(), event); }
}
