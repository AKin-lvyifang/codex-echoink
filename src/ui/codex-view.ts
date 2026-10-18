import { GENERAL_ASSISTANT_ID, type AgentDefinition } from "../agents/types";
import { isUserTask, taskState, taskSummary, type TaskEntry } from "../agents/task-presentation";
import { type TaskDraft, type TaskPage } from "../agents/task-workspace";
import { applyConversationTaskMetadata } from "../agents/task-metadata";
import { consumeAcceptedTaskDraft, TaskNavigationState } from "./codex-view/task-navigation-state";
import { renderAgentRoster } from "./codex-view/agent-roster";
import { renderAgentTaskList } from "./codex-view/task-list";
import { animateTaskDetailEntry, renderTaskDetailHeader } from "./codex-view/task-detail";
import { AgentEditorController } from "./codex-view/agent-editor";
import { renderTaskInterruption } from "./codex-view/task-interruption";
import type { TaskInterruptionInfo } from "../agents/task-resume";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { copyPiImageAttachmentsForProjection, piComposerImageAttachmentsForEntry, piConversationSupport, rememberPiConversationProjection } from "./codex-view/pi-conversation-support";
import { validateTaskTurnBeforeCreation } from "./codex-view/turn-runner";
import type { ConversationRunState } from "../plugin/conversation-run-service";
export type { ConversationRunState } from "../plugin/conversation-run-service";
import { addSelectionAnnotation as appendSelectionAnnotation, composerSelectionAnnotations, selectionDraft, snapshotSelectionDraft, restoreSelectionDraft, emptySelectionDraft, type SelectionDraft } from "../selection-ask/draft";
import { cloneSelectionAnnotations, selectionAnnotationsMatch, type SelectionAnnotation, type SelectionCapture } from "../types/selection-annotations";
import { ItemView, Notice, Platform, WorkspaceLeaf } from "obsidian";
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
import type { ComposerPrimaryActionState } from "./composer-state";
import { RuntimeTurnQueue, type QueuedTurnItem } from "./turn-queue";
import { CodexMessageListRenderer } from "./codex-view/message-list";
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
import { knowledgeCommandQueryForInput } from "../knowledge-base/commands";
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
import { piEntryIdFromProjectedMessageId, piToolCallIdFromProjectedMessageId } from "../harness/pi-native/pi-chat-ui-projector";
import { updateCodexHeaderIdentity } from "./codex-view/header";
import { closeComposerParameterMenu } from "./codex-view/menus";
import {
  activateSession as activateSessionAction,
  activeRunSession as activeRunSessionAction,
  archiveSession as archiveSessionAction,
  createSession as createSessionAction,
  createPiConversationShell,
  applyPiConversationProjectionToShell,
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

/**
 * Composer migration snapshot for sidebar/popout moves. Runtime references
 * remain for compatibility with the window controller; their ownership stays
 * with the plugin service and importing a View never rebinds a run host.
 */
export interface CodexViewMigrationState {
  readonly runs: Array<[string, ConversationRunState]>;
  readonly turnQueue: RuntimeTurnQueue;
  readonly pendingInteractions: Array<[string, Readonly<EchoInkTurnInteraction>]>;
  readonly draftText: string;
  readonly annotationDraft?: SelectionDraft;
  readonly sessionDrafts?: Array<[string, ComposerSessionDraft]>;
  readonly draftOwner?: string;
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

interface ComposerSessionDraft { text: string; annotations: SelectionDraft; attachments: StoredAttachment[]; noteMentions: readonly NoteMentionSelection[]; selectedSkill: EchoInkResource | null }

export class CodexView extends ItemView {
  private taskUiMounted = false;
  private resolveTaskUiReady?: (ready: boolean) => void;
  private readonly taskUiReady = new Promise<boolean>(resolve => { this.resolveTaskUiReady = resolve; });
  async waitForTaskUiReady(): Promise<boolean> {
    if (Platform.isMobile || !this.plugin.settings.agentRegistry || this.viewLifecycleAbortController.signal.aborted) return false;
    return await this.taskUiReady && this.taskUiMounted && !this.viewLifecycleAbortController.signal.aborted;
  }
  private settleTaskUiReady(ready: boolean): void { this.resolveTaskUiReady?.(ready); this.resolveTaskUiReady = undefined; }
  private taskNav?: TaskNavigationState;
  private get taskNavigation(): TaskNavigationState { return this.taskNav ??= new TaskNavigationState(() => this.plugin.settings.taskWorkspace, this.plugin); }
  private taskEntries: TaskEntry[] = [];
  private taskListEl?: HTMLElement;
  private taskDetailEl?: HTMLElement;
  private taskDetailHeaderEl?: HTMLElement;
  private taskEditorEl?: HTMLElement;
  private taskErrorEl?: HTMLElement;
  private taskInterruptionEl?: HTMLElement;
  private readonly taskInterruptions = new Map<string, { key: string; info?: TaskInterruptionInfo | null; error?: string }>();
  private readonly taskResumeErrors = new Map<string, string>();
  private taskEditor?: AgentEditorController;
  private taskEditorReturnPage?: TaskPage;
  private taskDetailLoaded = false;
  private taskDerivationToken: number | null = null;
  private get taskDerivationInProgress(): boolean { return this.taskDerivationToken === this.taskNavigation.token && !this.taskEditor; }
  private taskLoadError = "";
  private taskCatalogFlight?: Promise<void>;
  private taskRefreshAgain = false;
  private taskRefreshTimer: number | null = null;
  private taskMidnightTimer: number | null = null;
  private readonly taskDraftOrigins = new Map<string, string>();
  private readonly taskSubmitting = new Set<string>();
  private readonly taskPreviews = new Map<string, { at: number; text: string }>();

  private currentTaskEntry(): TaskEntry | undefined {
    const page = this.taskNavigation.page;
    return page.kind === "detail" ? this.taskEntries.find(entry => entry.conversationId === page.taskId) : undefined;
  }
  private currentTaskAgent(): AgentDefinition {
    const page = this.taskNavigation.page;
    const id = page.kind === "list" ? page.agentId : this.currentTaskEntry()?.agentId ?? this.sessionById(page.taskId)?.agentId;
    return this.plugin.settings.agentRegistry.agents.find(agent => agent.id === id) ?? this.plugin.settings.agentRegistry.agents[0];
  }
  private mountTaskNavigation(): void {
    this.rootEl.addClass("echoink-agent-tasks");
    const shell = this.messagesEl.parentElement!;
    this.taskErrorEl = this.rootEl.createDiv({ cls: "echoink-task-error" });
    this.taskListEl = this.rootEl.createDiv({ cls: "echoink-task-list" });
    this.taskEditorEl = this.rootEl.createDiv({ cls: "echoink-agent-editor-mount" });
    this.taskDetailEl = this.rootEl.createDiv({ cls: "echoink-task-detail" });
    this.rootEl.insertBefore(this.taskErrorEl, shell);
    this.rootEl.insertBefore(this.taskListEl, shell);
    this.rootEl.insertBefore(this.taskEditorEl, shell);
    this.rootEl.insertBefore(this.taskDetailEl, shell);
    this.taskDetailHeaderEl = this.taskDetailEl.createDiv();
    this.taskDetailEl.append(shell, this.taskPlanDockEl, this.interactionDockEl);
    this.taskInterruptionEl = this.messagesEl.createDiv({ cls: "echoink-task-interruption" });
    this.taskInterruptionEl.dataset.messageTail = "interruption";
    this.restoreTaskComposerDraft();
    this.renderTaskPages();
  }
  private saveTaskComposerDraft(): void {
    if (!this.taskUiMounted || !this.inputEl || !this.composerDraftOwner) return;
    const draft: TaskDraft = { text: this.inputEl.value, attachments: this.attachments.map(attachment => ({ ...attachment })),
      annotations: composerSelectionAnnotations(this.inputEl), noteMentions: [...composerNoteMentionSelections(this.inputEl)], selectedSkill: this.selectedSkill,
      selectedProviderSettingsId: this.selectedProviderSettingsId, selectedModel: this.selectedModel,
      selectedPermission: this.selectedPermission, selectedMode: this.selectedMode };
    const owner = this.composerDraftOwner;
    const page: TaskPage = owner.startsWith("agent:") ? { kind: "list", agentId: owner.slice(6) } : { kind: "detail", taskId: owner };
    this.taskNavigation.save(draft, page);
    this.composerSessionDrafts.set(owner, { text: draft.text, annotations: snapshotSelectionDraft(this.inputEl), attachments: draft.attachments,
      noteMentions: draft.noteMentions ?? [], selectedSkill: this.selectedSkill });
    this.plugin.getConversationRunService().scheduleSave();
  }
  private restoreTaskComposerDraft(): void {
    const draft = this.taskNavigation.draft();
    this.composerDraftOwner = this.taskNavigation.draftKey;
    this.inputEl.value = draft.text;
    restoreSelectionDraft(this.inputEl, { ...emptySelectionDraft(draft.text), annotations: draft.annotations ?? [], nextNumber: Math.max(0, ...(draft.annotations ?? []).map(annotation => annotation.number)) + 1 });
    this.attachments = draft.attachments.map(attachment => ({ ...attachment })); this.selectedSkill = draft.selectedSkill ?? null;
    clearComposerNoteMentions(this.inputEl);
    for (const mention of draft.noteMentions ?? []) addComposerNoteMentionSelection(this.inputEl, mention);
    this.selectedProviderSettingsId = draft.selectedProviderSettingsId ?? this.plugin.settings.activeApiProviderId;
    this.selectedModel = draft.selectedModel ?? this.plugin.settings.defaultModel;
    this.selectedPermission = draft.selectedPermission ?? this.plugin.settings.defaultPermission;
    this.selectedMode = draft.selectedMode ?? this.plugin.settings.defaultMode;
    this.renderAttachments(); this.renderToolbar(); this.updateInputPlaceholder();
  }
  private rememberTaskListPosition(taskId?: string): void {
    const page = this.taskNavigation.page;
    if (page.kind !== "list") return;
    this.taskNavigation.listPositions.set(page.agentId, { scrollTop: this.taskListEl?.querySelector<HTMLElement>(".echoink-task-list-items")?.scrollTop ?? 0, taskId });
  }
  async openAgentTaskList(agentId: string, prefill?: string): Promise<boolean> {
    if (!this.taskUiMounted || this.viewLifecycleAbortController.signal.aborted) return false;
    if (!this.plugin.settings.agentRegistry.agents.some(agent => agent.id === agentId)) { this.showTaskError(this.taskText("这个 Agent 已不存在。", "This Agent no longer exists.")); return false; }
    this.saveTaskComposerDraft(); this.rememberTaskListPosition();
    this.taskEditor?.dispose(); this.taskEditor = undefined;
    this.taskNavigation.navigate({ kind: "list", agentId }); this.taskDetailLoaded = false; this.taskLoadError = "";
    const accepted = prefill === undefined || this.taskNavigation.prefill(agentId, prefill);
    this.restoreTaskComposerDraft(); this.renderTaskPages();
    const position = this.taskNavigation.listPositions.get(agentId);
    const list = this.taskListEl?.querySelector<HTMLElement>(".echoink-task-list-items");
    if (list && position) {
      list.scrollTop = position.scrollTop;
      if (position.taskId) Array.from(list.querySelectorAll<HTMLButtonElement>("[data-task-id]")).find(button => button.dataset.taskId === position.taskId)?.focus({ preventScroll: true });
    }
    if (!accepted) new Notice(this.taskText("已保留未发送内容，处理后可再交给它。", "Your unsent draft was kept. Finish it before adding another task."));
    this.plugin.getConversationRunService().scheduleSave();
    return accepted;
  }
  async openTaskDetail(taskId: string): Promise<void> {
    if (!this.taskUiMounted || this.viewLifecycleAbortController.signal.aborted) return;
    this.saveTaskComposerDraft(); this.rememberTaskListPosition(taskId);
    this.taskEditor?.dispose(); this.taskEditor = undefined;
    const token = this.taskNavigation.navigate({ kind: "detail", taskId });
    this.taskDetailLoaded = false; this.taskLoadError = "";
    this.restoreTaskComposerDraft(); this.renderTaskPages();
    try {
      const projection = await this.plugin.readPiConversationProjection(taskId);
      if (token !== this.taskNavigation.token || this.viewLifecycleAbortController.signal.aborted) return;
      if (!isUserTask(projection.catalog)) throw new Error(this.taskText("这件任务已不存在。", "This task no longer exists."));
      let session = this.sessionById(taskId);
      if (!session) { session = createPiConversationShell(this.sessionHost(), projection.catalog); this.plugin.settings.sessions.push(session); }
      rememberPiConversationProjection(this.plugin, projection);
      applyPiConversationProjectionToShell(this.sessionHost(), session, projection);
      this.taskEntries = [...this.taskEntries.filter(entry => entry.conversationId !== taskId), projection.catalog];
      this.plugin.settings.activeSessionId = taskId;
      this.resetVirtualWindow(); this.virtualListEl.empty();
      this.renderTaskPlanDock(session); this.renderInteractionDock(session);
      this.taskDetailLoaded = true;
      this.renderMessages({ forceBottom: true }); this.renderTaskPages(); this.renderToolbar();
      animateTaskDetailEntry(this.taskDetailEl!, token);
      const unread = projection.catalog.unreadAnswerAt;
      if (unread !== undefined) await this.plugin.setPiConversationTaskMetadata(taskId, { unreadAnswerAt: undefined, lastReadAt: Date.now() }, { markReadThrough: unread });
      await this.reloadTaskCatalog();
      this.plugin.getConversationRunService().scheduleSave();
    } catch (error) {
      if (token !== this.taskNavigation.token || this.viewLifecycleAbortController.signal.aborted) return;
      this.showTaskError(`${this.taskText("读取任务失败：", "Could not load the task: ")}${error instanceof Error ? error.message : String(error)}`);
    }
  }
  refreshAgentTasks(): void { if (this.taskUiMounted) void this.reloadTaskCatalog(); }
  private async reloadTaskCatalog(): Promise<void> {
    if (this.taskCatalogFlight) { this.taskRefreshAgain = true; return await this.taskCatalogFlight; }
    this.taskCatalogFlight = (async () => {
      do {
        this.taskRefreshAgain = false;
        try {
          const entries = await this.plugin.listAgentTaskEntries();
          if (this.viewLifecycleAbortController.signal.aborted) return;
          this.taskEntries = entries;
          for (const entry of entries) {
            const at = Math.max(entry.updatedAt, entry.taskCompletedAt ?? 0, entry.taskStartedAt ?? 0, entry.taskInterruptedAt ?? 0);
            const resident = this.sessionById(entry.conversationId);
            if (resident) applyConversationTaskMetadata(resident, entry);
            if (!resident?.messages.length && this.taskPreviews.get(entry.conversationId)?.at !== at && entry.taskStatus !== "running") {
              try {
                const projection = await this.plugin.readPiConversationProjection(entry.conversationId);
                this.taskPreviews.set(entry.conversationId, { at, text: taskSummary(entry, projection, this.plugin.settings.settingsLanguage) });
              } catch { /* A broken body cannot hide the remaining Catalog tasks. */ }
            }
          }
          this.renderTaskPages();
        } catch (error) { this.showTaskError(`${this.taskText("读取任务列表失败：", "Could not load tasks: ")}${error instanceof Error ? error.message : String(error)}`); }
      } while (this.taskRefreshAgain && !this.viewLifecycleAbortController.signal.aborted);
    })().finally(() => { this.taskCatalogFlight = undefined; });
    await this.taskCatalogFlight;
  }
  private scheduleTaskCatalogRefresh(): void {
    if (this.taskRefreshTimer !== null) return;
    this.taskRefreshTimer = window.setTimeout(() => { this.taskRefreshTimer = null; void this.reloadTaskCatalog(); }, 100);
  }
  private scheduleTaskMidnightRefresh(): void {
    const tomorrow = new Date(); tomorrow.setHours(24, 0, 0, 50);
    this.taskMidnightTimer = window.setTimeout(() => { if (this.viewLifecycleAbortController.signal.aborted) return; this.renderTaskPages(); this.scheduleTaskMidnightRefresh(); }, tomorrow.getTime() - Date.now());
  }
  private showTaskError(message: string): void { this.taskLoadError = message; this.renderTaskPages(); }
  private renderTaskInterruptionCard(): void {
    const element = this.taskInterruptionEl, entry = this.currentTaskEntry();
    if (!element) return;
    element.hidden = !entry || entry.taskStatus !== "interrupted" || !this.taskDetailLoaded || !!this.taskEditor || this.taskDerivationInProgress;
    if (entry && entry.taskStatus !== "interrupted") { this.taskResumeErrors.delete(entry.conversationId); this.taskInterruptions.delete(entry.conversationId); }
    if (element.hidden || !entry) return;
    const id = entry.conversationId;
    const key = `${entry.taskInterruptedAt ?? 0}:${entry.taskStage ?? ""}`;
    let record = this.taskInterruptions.get(id);
    if (!record || record.key !== key) {
      record = { key }; this.taskInterruptions.set(id, record);
      const current = record;
      // Opening a task only reads local records. It never starts recovery or a model.
      void this.plugin.readTaskInterruption(id).then(info => { current.info = info; }).catch(error => {
        current.error = this.taskText("读取中断记录失败：", "Could not read interruption details: ") + (error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (this.viewLifecycleAbortController.signal.aborted || this.currentTaskEntry()?.conversationId !== id || this.taskInterruptions.get(id) !== current) return;
        const follow = this.isMessagesNearBottom();
        this.renderTaskInterruptionCard();
        if (follow) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });
    }
    const pending = this.taskSubmitting.has(`resume:${id}`) || this.plugin.isTaskResuming(id);
    renderTaskInterruption(element, { info: record.info, error: pending ? undefined : this.taskResumeErrors.get(id) ?? this.plugin.getTaskResumeError(id) ?? record.error,
      pending, language: this.plugin.settings.settingsLanguage,
      onResume: () => { void this.resumeInterruptedTask(id, false); } });
  }
  private async resumeInterruptedTask(taskId: string, withComposer: boolean): Promise<void> {
    const key = `resume:${taskId}`;
    if (this.taskSubmitting.has(key) || this.plugin.isTaskResuming(taskId)) return;
    this.taskSubmitting.add(key); this.taskResumeErrors.delete(taskId);
    this.saveTaskComposerDraft(); this.renderTaskInterruptionCard();
    try {
      let item: QueuedTurnItem | null = null;
      if (withComposer) {
        item = await createQueuedTurnFromComposerRunner(this.createTurnRunnerContext(taskId), { allowLocalKnowledgeCommands: true,
          onError: message => this.taskResumeErrors.set(taskId, message) });
        if (!item || this.viewLifecycleAbortController.signal.aborted) return;
        item.clearComposerAfterPiAcceptance = true;
      }
      await this.plugin.resumeTask(taskId, item?.text, item ?? undefined);
    } catch (error) {
      this.taskResumeErrors.set(taskId, error instanceof Error ? error.message : String(error));
    } finally {
      this.taskSubmitting.delete(key);
      if (!this.viewLifecycleAbortController.signal.aborted) { await this.reloadTaskCatalog(); this.renderToolbar(); }
    }
  }
  private renderTaskPages(): void {
    if (!this.taskListEl || !this.taskDetailEl || !this.taskEditorEl || !this.taskErrorEl || !this.taskInterruptionEl) return;
    const page = this.taskNavigation.page, agent = this.currentTaskAgent(), entry = this.currentTaskEntry();
    renderAgentRoster(this.tabBarEl, this.plugin.settings.agentRegistry.agents, this.taskEntries, agent.id,
      { onSelect: id => void this.openAgentTaskList(id), onCreate: () => this.openAgentEditor() }, this.plugin.settings.settingsLanguage);
    this.taskEditorEl.hidden = !this.taskEditor; this.taskListEl.hidden = !!this.taskEditor || page.kind !== "list";
    this.taskDetailEl.hidden = !!this.taskEditor || page.kind !== "detail";
    const interrupted = page.kind === "detail" && !!entry && taskState(entry) === "interrupted";
    this.inputEl.parentElement!.hidden = this.taskDerivationInProgress || !!this.taskEditor || page.kind === "detail" && !this.taskDetailLoaded;
    this.renderTaskInterruptionCard();
    const ready = page.kind === "detail" && this.taskDetailLoaded && !this.taskEditor && !this.taskDerivationInProgress;
    this.messagesEl.parentElement!.hidden = !ready;
    this.taskPlanDockEl.hidden = !ready || interrupted; this.interactionDockEl.hidden = !ready || interrupted;
    this.queueEl.hidden = page.kind !== "detail";
    const loading = this.taskDerivationInProgress || page.kind === "detail" && !this.taskDetailLoaded && !this.taskLoadError;
    disposeOriginControls(this.taskErrorEl); this.taskErrorEl.empty(); this.taskErrorEl.hidden = !this.taskLoadError && !loading;
    this.taskErrorEl.style.color = loading ? "var(--text-muted)" : "";
    if (loading) this.taskErrorEl.createSpan({ text: this.taskDerivationInProgress ? this.taskText("正在打开派生任务…", "Opening derived task…") : this.taskText("正在读取任务…", "Loading task…") });
    if (this.taskLoadError) {
      this.taskErrorEl.createSpan({ text: this.taskLoadError });
      const retry = createOriginButton(this.taskErrorEl, { text: this.taskText("重试", "Retry"), attr: { type: "button" } });
      if (page.kind === "detail") {
        const back = createOriginButton(this.taskErrorEl, { text: this.taskText("返回任务列表", "Back to tasks"), attr: { type: "button" } });
        back.onclick = () => void this.openAgentTaskList(agent.id);
      }
      retry.onclick = () => { this.taskLoadError = ""; if (page.kind === "detail") void this.openTaskDetail(page.taskId); else void this.reloadTaskCatalog(); };
    }
    if (this.taskEditor) return;
    if (page.kind === "list") renderAgentTaskList(this.taskListEl, agent, this.taskEntries, this.plugin.settings.sessions, {
      onTask: id => void this.openTaskDetail(id), onEdit: () => this.openAgentEditor(agent.id),
      summary: entry => this.taskSummaryText(entry)
    }, Date.now(), this.plugin.settings.settingsLanguage);
    else if (entry) renderTaskDetailHeader(this.taskDetailHeaderEl!, agent, entry, () => void this.openAgentTaskList(entry.agentId ?? GENERAL_ASSISTANT_ID), this.plugin.settings.settingsLanguage);
    else {
      disposeOriginControls(this.taskDetailHeaderEl!); this.taskDetailHeaderEl!.empty();
      this.taskDetailHeaderEl!.createDiv({ cls: "echoink-task-detail-header", text: this.taskText("任务详情", "Task details") });
    }
    this.updateInputPlaceholder();
  }
  private taskSummaryText(entry: TaskEntry): string | undefined {
    const pending = this.plugin.getConversationRunService().pendingInteractions.get(entry.conversationId);
    const session = this.sessionById(entry.conversationId);
    if (pending || session?.messages.length) return taskSummary(entry, session ?? undefined, this.plugin.settings.settingsLanguage, pending);
    return this.taskPreviews.get(entry.conversationId)?.text ?? taskSummary(entry, undefined, this.plugin.settings.settingsLanguage);
  }
  private taskText(zh: string, en: string): string { return conversationUiText(this.plugin.settings.settingsLanguage, zh, en); }

  private openAgentEditor(agentId?: string): void {
    const view = this;
    this.saveTaskComposerDraft(); this.rememberTaskListPosition(); this.closeComposerMenus();
    this.taskEditorReturnPage = this.taskNavigation.page;
    this.taskEditor?.dispose();
    this.taskEditor = new AgentEditorController({
      get settings() { return view.plugin.settings; }, draftCacheKey: this.plugin,
      loadResources: () => this.plugin.buildRuntimeEchoInkResourceCatalog(),
      saveAgent: (agent, moduleIds) => this.plugin.saveAgentDefinition(agent, moduleIds),
      deleteAgent: async id => { await this.plugin.deleteAgent(id); this.taskEditorReturnPage = { kind: "list", agentId: GENERAL_ASSISTANT_ID }; await this.reloadTaskCatalog(); },
      getDeleteCounts: id => this.plugin.getAgentDeleteCounts(id),
      getCapabilityAvailability: id => this.taskCapabilityAvailability(id),
      onClose: id => {
        const target = this.taskEditorReturnPage; this.taskEditor?.dispose(); this.taskEditor = undefined;
        if (id && id !== agentId) void this.openAgentTaskList(id);
        else if (target?.kind === "detail") void this.openTaskDetail(target.taskId);
        else void this.openAgentTaskList(target?.agentId ?? GENERAL_ASSISTANT_ID);
      }
    });
    this.taskEditor.open(agentId); this.taskEditor.render(this.taskEditorEl!); this.renderTaskPages();
  }
  private taskCapabilityAvailability(id: string): { available: boolean; reason?: string } {
    const settings = this.plugin.settings;
    const enabled = id === "finance" ? settings.lifestyle.finance.enabled : id === "pdf-reading" ? settings.pdfReading.enabled
      : id === "english-diary" ? settings.englishDiary.enabled : id === "web-search" ? settings.tavily.enabled && !!settings.tavily.apiKey.trim()
        : id === "journal" ? settings.knowledgeBase.folderBindings?.roles.journal.enabled !== false
          : id === "knowledge" ? !settings.knowledgeBase.folderBindings || ["raw", "wiki", "projects", "inbox"].some(role => settings.knowledgeBase.folderBindings!.roles[role as "raw"].enabled) : true;
    if (!enabled) return { available: false, reason: this.taskText("对应功能尚未启用", "This feature is disabled") };
    if (["finance", "pdf-reading", "english-diary"].includes(id) && !hasProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess)) return { available: false, reason: this.taskText("需要有效 PRO，已有资料仍可查看", "Requires an active PRO membership; existing data remains readable") };
    if (id.startsWith("mcp:") || id.startsWith("vault-skill:")) {
      let resourceId: string; try { resourceId = decodeURIComponent(id.split(":")[1]); } catch { return { available: false, reason: this.taskText("资源不可用", "Resource unavailable") }; }
      const resource = this.currentEchoInkResourceCatalog().find(resource => resource.id === resourceId || resource.metadata?.resourceId === resourceId);
      if (!resource?.enabled) return { available: false, reason: this.taskText("资源已禁用或不可用", "Resource disabled or unavailable") };
    }
    return { available: true };
  }
  private async sendNewAgentTask(): Promise<void> {
    if (this.taskDerivationInProgress) return;
    const page = this.taskNavigation.page;
    if (page.kind !== "list" || this.taskEditor) return;
    const key = this.taskNavigation.draftKey, token = this.taskNavigation.token;
    if (this.taskSubmitting.has(key)) return;
    this.taskSubmitting.add(key); this.saveTaskComposerDraft();
    let created: StoredSession | undefined, item: QueuedTurnItem | null = null;
    try {
      // This data-only Composer adapter prepares files and references before a Conversation exists.
      const context = this as unknown as CodexViewTurnContext;
      item = await createQueuedTurnFromComposerRunner(context, { allowLocalKnowledgeCommands: true });
      if (!item || !await validateTaskTurnBeforeCreation(context, item) || this.viewLifecycleAbortController.signal.aborted) return;
      const entry = await this.plugin.createPiConversation({ conversationId: newId("conversation"), title: item.text.trim().slice(0, 64) || item.attachments[0]?.name || this.taskText("新任务", "New task"),
        agentId: page.agentId, cwd: this.plugin.getVaultPath(), defaultMemoryMode: "normal" });
      created = createPiConversationShell(this.sessionHost(), entry); this.plugin.settings.sessions.push(created);
      item.sessionId = created.id; item.clearComposerAfterPiAcceptance = true;
      this.taskDraftOrigins.set(item.id, key);
      const outcome = await this.plugin.getConversationRunService().start(item, "composer");
      if (outcome === "running") item.piUserEntryAccepted = true;
      if (item.piUserEntryAccepted) {
        consumeAcceptedTaskDraft(this.plugin.settings.taskWorkspace, key, item);
        this.plugin.getConversationRunService().scheduleSave();
        await this.reloadTaskCatalog();
        if (token === this.taskNavigation.token && !this.viewLifecycleAbortController.signal.aborted) await this.openTaskDetail(created.id);
      } else {
        await this.plugin.setPiConversationStatus(created.id, "deleted");
        this.plugin.settings.sessions = this.plugin.settings.sessions.filter(session => session.id !== created!.id);
        if (outcome === "failed") this.showTaskError(this.taskText("消息尚未发送，请检查输入区提示后重试。", "The message was not sent. Check the Composer notice and try again."));
      }
    } catch (error) {
      if (created && !item?.piUserEntryAccepted) {
        await this.plugin.setPiConversationStatus(created.id, "deleted").catch(cleanupError => console.error("Unaccepted task cleanup failed", cleanupError));
        this.plugin.settings.sessions = this.plugin.settings.sessions.filter(session => session.id !== created!.id);
      }
      this.showTaskError(`${item?.piUserEntryAccepted ? this.taskText("消息已发送，状态刷新失败", "Message sent, but its status could not refresh") : this.taskText("发送失败", "Could not send")}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (item) this.taskDraftOrigins.delete(item.id);
      this.taskSubmitting.delete(key); this.scheduleTaskCatalogRefresh();
    }
  }

  private composerDraftOwner = "";
  private readonly composerSessionDrafts = new Map<string, ComposerSessionDraft>();
  switchComposerDraft(sessionId: string): void {
    if (!this.inputEl || this.composerDraftOwner === sessionId) return;
    const previous = this.composerDraftOwner || this.plugin.settings.activeSessionId;
    if (previous && previous !== sessionId) this.composerSessionDrafts.set(previous, { text: this.inputEl.value, annotations: snapshotSelectionDraft(this.inputEl), attachments: this.attachments.map((item) => ({ ...item })), noteMentions: composerNoteMentionSelections(this.inputEl), selectedSkill: this.selectedSkill });
    this.composerDraftOwner = sessionId;
    const draft = this.composerSessionDrafts.get(sessionId);
    this.inputEl.value = draft?.text ?? "";
    restoreSelectionDraft(this.inputEl, draft?.annotations ?? emptySelectionDraft());
    this.attachments = draft?.attachments.map((item) => ({ ...item })) ?? [];
    this.selectedSkill = draft?.selectedSkill ?? null;
    clearComposerNoteMentions(this.inputEl);
    for (const mention of draft?.noteMentions ?? []) addComposerNoteMentionSelection(this.inputEl, mention);
    this.renderAttachments();
  }
  clearAcceptedComposerDraft(item: Readonly<QueuedTurnItem>): void {
    if (this.taskUiMounted && this.viewLifecycleAbortController.signal.aborted) {
      consumeAcceptedTaskDraft(this.plugin.settings.taskWorkspace, this.taskDraftOrigins.get(item.id) ?? item.sessionId, item);
      this.plugin.getConversationRunService().scheduleSave(); return;
    }
    const owner = this.composerDraftOwner || this.plugin.settings.activeSessionId;
    const draftOwner = this.taskDraftOrigins.get(item.id) ?? item.sessionId;
    const active = owner === draftOwner;
    const stored = active ? null : this.composerSessionDrafts.get(draftOwner);
    if (!active && !stored) return;
    const text = active ? this.inputEl.value : stored!.text;
    const annotations = active ? composerSelectionAnnotations(this.inputEl) : stored!.annotations.annotations;
    const attachments = active ? this.attachments : stored!.attachments;
    const mentions = active ? composerNoteMentionSelections(this.inputEl) : stored!.noteMentions;
    const skill = active ? this.selectedSkill : stored!.selectedSkill;
    if ((item.composerTextSnapshot === undefined ? text.trim() !== item.text : text !== item.composerTextSnapshot) || !selectionAnnotationsMatch(annotations, item.selectionAnnotations ?? [])
      || (skill?.id ?? null) !== (item.skill?.id ?? null)
      || mentions.length !== (item.noteMentions?.length ?? 0) || mentions.some((mention, index) => mention.vaultRelativePath !== item.noteMentions?.[index].vaultRelativePath)
      || attachments.length !== item.attachments.length || attachments.some((attachment, index) => {
        const other = item.attachments[index];
        return attachment.type !== other.type || attachment.name !== other.name || attachment.path !== other.path || attachment.mimeType !== other.mimeType || attachment.sizeBytes !== other.sizeBytes;
      })) return;
    if (active) this.clearComposerDraft();
    else this.composerSessionDrafts.set(draftOwner, { text: "", annotations: emptySelectionDraft(), attachments: [], noteMentions: [], selectedSkill: null });
    if (this.taskUiMounted) {
      const page: TaskPage = draftOwner.startsWith("agent:") ? { kind: "list", agentId: draftOwner.slice(6) } : { kind: "detail", taskId: draftOwner };
      if (active) this.saveTaskComposerDraft();
      else this.taskNavigation.save({ text: "", attachments: [] }, page);
      this.plugin.getConversationRunService().scheduleSave();
    }
  }
  selectionAnnotationRecords(includeHidden = false): SelectionAnnotation[] {
    const active = this.inputEl ? selectionDraft(this.inputEl).annotations : [];
    if (!includeHidden) return active;
    return [...active, ...[...this.composerSessionDrafts].filter(([id]) => id !== this.composerDraftOwner).flatMap(([, draft]) => draft.annotations.annotations)];
  }
  addSelectionAnnotation(capture: SelectionCapture, action: { id: string; template: string }): SelectionAnnotation {
    this.ensureSession();
    if (!this.composerDraftOwner) this.composerDraftOwner = this.plugin.settings.activeSessionId;
    const annotation = appendSelectionAnnotation(this.inputEl, capture, action, this.plugin.settings.settingsLanguage === "en");
    this.onInputChanged(); this.renderAttachments(); this.focusInput(); return annotation;
  }
  focusSelectionAnnotations(): void { this.attachmentsEl?.querySelector<HTMLButtonElement>(".echoink-annotation-trigger")?.focus(); }
  refreshSelectionAnnotationSummary(): void { this.renderAttachments(); }
  private rootEl!: HTMLElement;
  private tabBarEl!: HTMLElement;
  private knowledgeLinkingProgressDispose?: () => void;
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
  private get conversationRuns(): Map<string, ConversationRunState> { return this.plugin.getConversationRunService().runs; }
  private runSubscriptionDispose?: () => void;
  private get currentConversationRun(): ConversationRunState | undefined {
    if (this.taskUiMounted && (this.taskNavigation.page.kind === "list" || this.taskEditor)) return undefined;
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
  private get pendingInteractionsBySession(): Map<string, Readonly<EchoInkTurnInteraction>> { return this.plugin.getConversationRunService().pendingInteractions; }
  private selectedSkill: EchoInkResource | null = null;
  private attachments: StoredAttachment[] = [];
  private selectedProviderSettingsId = "";
  private selectedModel = "";
  private selectedPermission: PermissionMode;
  private selectedMode: UiMode;
  private skillsRequested = false;
  private viewLifecycleGeneration = 0;
  private viewLifecycleAbortController = new AbortController();
  private get turnQueue(): RuntimeTurnQueue { return this.plugin.getConversationRunService().turnQueue; }
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

  private conversationRun(sessionId: string): ConversationRunState { return this.plugin.getConversationRunService().stateFor(sessionId); }
  private clearConversationRun(sessionId: string, state: ConversationRunState): void { this.plugin.getConversationRunService().clearActiveRun(sessionId, state); }
  private shellHost(): CodexViewShellHost { return this as unknown as CodexViewShellHost; }

  private createTurnRunnerContext(sessionId: string): CodexViewTurnContext {
    const view = this;
    const state = this.conversationRun(sessionId);
    const lifecycle = this.turnLifecycleHost(sessionId);
    const context: CodexViewTurnContext = {
      get lifecycleSignal() { return view.viewLifecycleAbortController.signal; }, get app() { return view.app; }, get plugin() { return view.plugin; }, get running() { return state.running; }, set running(value) { state.running = value; }, get activeRunId() { return state.activeRunId; }, set activeRunId(value) { state.activeRunId = value; }, get activeRunKind() { return state.activeRunKind; }, set activeRunKind(value) { state.activeRunKind = value; }, get activeRunSessionId() { return state.activeRunSessionId; }, set activeRunSessionId(value) { state.activeRunSessionId = value; }, get activeTurnId() { return state.activeTurnId; }, set activeTurnId(value) { state.activeTurnId = value; },
      get turnQueue() { return view.turnQueue; }, get queueStartInProgress() { return state.queueStartInProgress; }, set queueStartInProgress(value) { state.queueStartInProgress = value; if (!value && !state.running) view.clearConversationRun(sessionId, state); }, get turnStartedAt() { return state.turnStartedAt; }, set turnStartedAt(value) { state.turnStartedAt = value; }, get inputEl() { return view.inputEl; }, get attachments() { return view.attachments; }, get selectedSkill() { return view.selectedSkill; }, get selectedProviderSettingsId() { return view.selectedProviderSettingsId; }, set selectedProviderSettingsId(value) { view.selectedProviderSettingsId = value; }, get selectedModel() { return view.selectedModel; }, set selectedModel(value) { view.selectedModel = value; }, get messagesBottomFollowPaused() { return view.messagesBottomFollowPaused; }, set messagesBottomFollowPaused(value) { view.messagesBottomFollowPaused = value; },
      applyStatus: () => view.applyStatus(), armTurnWatchdog: (timeoutMs, timeoutText) => armTurnWatchdogAction(lifecycle, timeoutMs, timeoutText), clearTurnWatchdog: () => clearTurnWatchdogAction(lifecycle), clearActiveRun: () => view.clearConversationRun(sessionId, state), renderToolbar: () => view.renderToolbar(), diagnoseCodexFailure: (error, model) => view.diagnoseCodexFailure(error, model), ensureSession: () => view.sessionById(sessionId) ?? view.ensureSession(), composerStateForSession: (session) => view.composerStateForSession(session), enqueueComposerDraft: () => enqueueComposerDraftRunner(context), resumeQueuedTurns: (sessionId) => view.resumeQueuedTurns(sessionId), stopTurn: () => view.plugin.getConversationRunService().stopTask(sessionId), pauseQueueForSession: (sessionId) => view.pauseQueueForSession(sessionId),
      clearAcceptedComposerDraft: (item) => view.clearAcceptedComposerDraft(item),
      createQueuedTurnFromComposer: (options) => createQueuedTurnFromComposerRunner(context, options), startQueuedTurnItem: (item, source) => view.startQueuedTurnItem(item, source), startQueuedTurnItemSafely: (item, source) => view.startQueuedTurnItemSafely(item, source), afterTurnSettled: (sessionId, succeeded) => view.afterTurnSettled(sessionId, succeeded), startNextQueuedTurn: (sessionId) => view.startNextQueuedTurn(sessionId), startChatTurn: (session, item, source) => view.startChatTurn(session, item, source), clearComposerDraft: () => { if (!view.viewLifecycleAbortController.signal.aborted && (view.composerDraftOwner || view.plugin.settings.activeSessionId) === sessionId) view.clearComposerDraft(); },
      ensureChatWorkspaceSelected: (session) => view.ensureChatWorkspaceSelected(session), currentTurnOptions: (session) => view.currentTurnOptions(session), sessionById: (sessionId) => view.sessionById(sessionId), renderQueue: () => view.renderQueue(), renderTabs: () => view.renderTabs(), renderMessages: (options) => view.renderMessages(options), renderMessagesIfActive: (session, updatedMessage) => view.renderMessagesIfActive(session, updatedMessage), setPendingInteraction: (sessionId, interaction, expectedTurnId) => view.setPendingInteraction(sessionId, interaction, expectedTurnId), ensureThinkingMessage: (session, title, text) => view.ensureThinkingMessage(session, title, text), dismissThinkingMessage: (session) => view.dismissThinkingMessage(session), attachTurnIdToRun: (session, turnId) => view.attachTurnIdToRun(session, turnId), finishThinkingMessage: (session, status) => view.finishThinkingMessage(session, status), finishRunningProcessMessages: (session, status) => view.finishRunningProcessMessages(session, status), finishPlanMessage: (session) => view.finishPlanMessage(session), addMessageToSession: (session, message) => view.addMessageToSession(session, message), moveMessageToEnd: (session, messageId) => view.moveMessageToEnd(session, messageId), fillKnowledgeBaseCommand: (command) => view.fillKnowledgeBaseCommand(command)
    } satisfies CodexViewTurnContext;
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
    if (!this.rootEl || !this.messagesEl || this.viewLifecycleAbortController.signal.aborted) return;
    updateCodexHeaderIdentity(
      this.rootEl,
      this.plugin.getEchoInkAgentIdentityView()
    );
    this.renderMessages({ preserveScroll: true });
  }

  refreshLanguage(): void {
    if (!this.rootEl) return;
    refreshViewShellCopy(this.shellHost());
    this.turnNavigator?.refreshLanguage();
    this.renderTabs();
    this.renderMessages({ preserveScroll: true });
    this.renderToolbar();
    const skillQuery = knowledgeCommandQueryForInput(this.inputEl.value);
    if (skillQuery !== null && this.knowledgeCommandMenuEl?.hasClass("is-visible")) {
      this.renderKnowledgeCommandMatches(skillQuery);
    }
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
    const signal = this.viewLifecycleAbortController.signal;
    try {
      try {
        await refreshPiConversationShellsAction(this.sessionHost(), { createIfEmpty: Platform.isMobile || !this.plugin.settings.agentRegistry });
      } catch (error) {
        console.error("Pi Conversation Catalog refresh failed", error);
        new Notice(
          `${conversationUiText(this.plugin.settings.settingsLanguage, "读取会话列表失败：", "Could not load the conversation list: ")}${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (signal.aborted) return;
      const desktopTasks = !Platform.isMobile && !!this.plugin.settings.agentRegistry;
      const initialConversation = desktopTasks ? null : await ensureInitialConversationAction(this.sessionHost());
      if (signal.aborted) return;
      this.render();
      const mountToken = desktopTasks ? this.taskNavigation.token : 0;
      this.runSubscriptionDispose?.();
      this.runSubscriptionDispose = this.plugin.getConversationRunService().subscribe({
        isTaskVisible: id => !this.viewLifecycleAbortController.signal.aborted && this.plugin.settings.activeSessionId === id
          && (!this.taskUiMounted || !this.taskEditor && this.taskDetailLoaded && this.taskNavigation.page.kind === "detail" && this.taskNavigation.page.taskId === id),
        clearAcceptedDraft: item => this.clearAcceptedComposerDraft(item),
        refresh: (id, message) => {
          if (this.viewLifecycleAbortController.signal.aborted) return;
          if (this.taskUiMounted) this.scheduleTaskCatalogRefresh();
          this.renderTabs(); this.renderQueue(); this.renderToolbar(); this.applyStatus();
          const session = this.sessionById(id);
          if (session) { this.renderMessagesIfActive(session, message); if (this.plugin.settings.activeSessionId === id) this.renderInteractionDock(session); }
        }
      });
      this.settleTaskUiReady(desktopTasks);
      if (desktopTasks) {
        await this.reloadTaskCatalog();
        if (signal.aborted) return;
        if (mountToken === this.taskNavigation.token) {
          const page = this.taskNavigation.page;
          if (page.kind === "detail") await this.openTaskDetail(page.taskId);
          else await this.openAgentTaskList(page.agentId);
        }
        if (signal.aborted) return;
        this.scheduleTaskMidnightRefresh();
        return;
      }
      if (initialConversation && !initialConversation.created) {
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
    } finally { this.settleTaskUiReady(false); }
  }

  async onClose(): Promise<void> {
    this.settleTaskUiReady(false);
    if (this.taskUiMounted) { this.saveTaskComposerDraft(); this.rememberTaskListPosition(); }
    this.taskEditor?.dispose(); this.taskEditor = undefined;
    if (this.taskRefreshTimer !== null) window.clearTimeout(this.taskRefreshTimer);
    if (this.taskMidnightTimer !== null) window.clearTimeout(this.taskMidnightTimer);
    if (this.rootEl) disposeOriginControls(this.rootEl);
    this.runSubscriptionDispose?.(); this.runSubscriptionDispose = undefined;
    this.knowledgeLinkingProgressDispose?.(); this.knowledgeLinkingProgressDispose = undefined;
    this.viewLifecycleGeneration++;
    this.viewLifecycleAbortController?.abort();
    try {
      closeComposerParameterMenu(); disposeContextPopover(this.composerHost());
      this.contextPanelOpen = false; this.clearKnowledgeBaseRunProgressTimer();
      if (!this.migrationMode && this.promptEnhancerRunId) await this.plugin.cancelHarnessRun(this.promptEnhancerRunId);
      this.promptEnhancerRunning = false; this.promptEnhancerRunId = ""; this.promptEnhancerTurnId = "";
      await this.plugin.getConversationRunService().flushSave();
    } finally {
      this.clearHomeAttentionFrame(); this.taskPlanDock.dispose(); this.interactionDock.dispose();
      this.messageListRenderer.dispose(); this.turnNavigator?.dispose(); this.turnNavigator = null;
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
      annotationDraft: this.inputEl ? snapshotSelectionDraft(this.inputEl) : emptySelectionDraft(),
      sessionDrafts: [...this.composerSessionDrafts], draftOwner: this.composerDraftOwner,
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
    this.composerDraftOwner = state.draftOwner ?? this.plugin.settings.activeSessionId;
    this.composerSessionDrafts.clear();
    for (const [id, draft] of state.sessionDrafts ?? []) this.composerSessionDrafts.set(id, draft);
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
      restoreSelectionDraft(this.inputEl, state.annotationDraft ?? emptySelectionDraft(state.draftText));
      this.inputEl.setSelectionRange(state.draftText.length, state.draftText.length);
      clearComposerNoteMentions(this.inputEl);
      for (const mention of state.composer.noteMentions) {
        addComposerNoteMentionSelection(this.inputEl, mention);
      }
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
   * Forward transient composer/prompt-enhancer UI callbacks during migration.
   * Accepted task subscriptions and message persistence belong to the plugin
   * service and never use this forwarding layer.
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
    "selectionAnnotationRecords",
    "focusSelectionAnnotations",
    "clearAcceptedComposerDraft",
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
    await refreshPiConversationShellsAction(this.sessionHost(), { createIfEmpty: !this.taskUiMounted });
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
  prepareComposerDraft(text: string): boolean {
    // Keep the current conversation, attachments and any existing draft intact.
    if (this.inputEl.value.trim() || this.promptEnhancerRunning) {
      this.focusInput();
      return false;
    }
    this.inputEl.value = text;
    this.onInputChanged();
    this.inputEl.setSelectionRange(text.length, text.length);
    this.focusInput();
    return true;
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
    if (!Platform.isMobile && this.plugin.settings.agentRegistry) this.taskUiMounted = true;
    renderViewShell(this.shellHost());
    this.turnNavigator?.dispose();
    this.turnNavigator = new TurnNavigator(this.messageHost(), this.turnNavigatorEl);
    if (!Platform.isMobile && this.plugin.settings.agentRegistry) this.mountTaskNavigation();
  }

  private updateInputPlaceholder(): void {
    if (this.taskUiMounted) {
      const agent = this.currentTaskAgent();
      this.inputEl.placeholder = this.taskNavigation.page.kind === "list" ? this.taskText(`交代给 ${agent.name} 一件新事…`, `Give ${agent.name} a new task…`)
        : this.currentTaskEntry() && taskState(this.currentTaskEntry()!) === "completed" ? this.taskText(`接着和 ${agent.name} 聊这件事…`, `Continue this task with ${agent.name}…`) : this.taskText(`回复 ${agent.name}…`, `Reply to ${agent.name}…`);
      return;
    }
    updateInputPlaceholderAction(this.headerHost());
  }
  private applyStatus(): void { applyStatusAction(this.headerHost()); }
  private openPluginSettings(): void { openPluginSettingsAction(this.headerHost()); }
  private renderTabs(): void {
    if (this.taskUiMounted) { this.renderTaskPages(); return; }
    renderTabsView(this.sessionHost());
  }
  private renderMessages(options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void {
    if (this.taskUiMounted && (this.taskDerivationInProgress || this.taskNavigation.page.kind !== "detail" || !this.taskDetailLoaded || this.taskEditor)) return;
    if (this.taskUiMounted) this.renderTaskInterruptionCard();
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
  private renderQueue(): void { if (this.taskUiMounted && this.taskNavigation.page.kind !== "detail") { if (this.queueEl) this.queueEl.empty(); return; } renderQueueAction(this.composerHost()); }
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

  private async derivePiConversationFromMessage(session: StoredSession, targetEntryId: string): Promise<void> {
    if (!this.taskUiMounted) { await derivePiConversationFromMessageAction(this.sessionHost(), session, targetEntryId); return; }
    const entryId = targetEntryId.trim();
    if (this.taskDerivationToken !== null || session.bodyAuthority !== "pi_session_only" || !entryId) return;
    if (this.runningSessionIds.has(session.id)) {
      new Notice(this.taskText("当前任务运行中，结束后再新建会话", "A task is running. Create a conversation after it finishes.")); return;
    }
    this.saveTaskComposerDraft();
    const token = this.taskNavigation.token;
    const index = session.messages.findIndex(message => piEntryIdFromProjectedMessageId(message.id) === entryId);
    const anchor = session.messages[index];
    if (anchor?.role === "user" && !session.messages.slice(0, index).some(message => message.role === "user" || message.role === "assistant")) {
      const agentId = session.agentId ?? GENERAL_ASSISTANT_ID;
      if (!this.taskNavigation.prefill(agentId, anchor.text)) {
        new Notice(this.taskText("已保留未发送内容，处理后可再交给它。", "Your unsent draft was kept. Finish it before adding another task.")); return;
      }
      const attachments = [...(anchor.attachments ?? []), ...piComposerImageAttachmentsForEntry(session, entryId)]
        .filter((attachment, index, all) => all.findIndex(other => other.type === attachment.type && other.path === attachment.path) === index);
      this.taskNavigation.save({ text: anchor.text, attachments, annotations: cloneSelectionAnnotations(anchor.selectionAnnotations), selectedSkill: null,
        selectedProviderSettingsId: this.selectedProviderSettingsId, selectedModel: this.selectedModel,
        selectedPermission: this.selectedPermission, selectedMode: this.selectedMode }, { kind: "list", agentId });
      await this.openAgentTaskList(agentId); return;
    }
    const sourceReplay: StoredSession = { ...session, messages: [], piImageAttachments: structuredClone(session.piImageAttachments), piDocumentReplay: structuredClone(session.piDocumentReplay) };
    const targetDraft: TaskDraft = { text: "", attachments: piComposerImageAttachmentsForEntry(session, entryId),
      annotations: cloneSelectionAnnotations(anchor?.selectionAnnotations), selectedSkill: null,
      selectedProviderSettingsId: this.selectedProviderSettingsId, selectedModel: this.selectedModel,
      selectedPermission: this.selectedPermission, selectedMode: this.selectedMode };
    const title = session.title.trim() || anchor?.text.trim() || this.taskText("新任务", "New task");
    const stillCurrent = () => this.taskNavigation.token === token && !this.taskEditor && !this.viewLifecycleAbortController.signal.aborted;
    this.taskDerivationToken = token; this.taskLoadError = "";
    this.renderTaskPages();
    try {
      const derivation = await this.plugin.derivePiConversation({ sourceConversationId: session.id,
        targetConversationId: newId("conversation"), anchorEntryId: entryId, title });
      const taskId = derivation.projection.catalog.conversationId;
      if (derivation.sourceConversationId !== session.id || taskId === session.id) {
        throw new Error(this.taskText("派生结果没有独立任务身份。", "The derived result has no independent task identity."));
      }
      if (derivation.activation.status === "failed") throw new Error(derivation.activation.message);
      const snapshot = derivation.projection.messages.slice().reverse().find(message => message.role === "assistant" && message.status === "completed"
        && Number.isSafeInteger(message.completedAt ?? message.createdAt) && (message.completedAt ?? message.createdAt) > 0);
      if (!snapshot) throw new Error(this.taskText("这个位置没有已完成的历史快照，请返回任务列表交代新事。", "There is no completed history snapshot here. Return to the task list to start a new task."));
      // Finalize only the new Catalog while awaiting; the current View is untouched until takeover.
      const entry = await this.plugin.setPiConversationTaskMetadata(taskId, { taskStatus: "completed",
        taskCompletedAt: snapshot.completedAt ?? snapshot.createdAt, taskInterruptedAt: undefined, pendingResponse: undefined });
      if (!stillCurrent()) return;
      const host = this.sessionHost(), existing = this.sessionById(taskId), derived = existing ?? createPiConversationShell(host, entry);
      copyPiImageAttachmentsForProjection(sourceReplay, derived, derivation.projection.messages);
      applyPiConversationProjectionToShell(host, derived, { ...derivation.projection, catalog: entry });
      if (!existing) this.plugin.settings.sessions.push(derived);
      this.taskNavigation.save({ ...targetDraft, text: derivation.editorText,
        attachments: derivation.anchorRole === "user" ? targetDraft.attachments : [],
        annotations: derivation.anchorRole === "user" ? targetDraft.annotations : [] }, { kind: "detail", taskId });
      this.taskEntries = [...this.taskEntries.filter(entry => entry.conversationId !== taskId), entry];
      const navigationToken = this.taskNavigation.navigate({ kind: "detail", taskId });
      this.plugin.settings.activeSessionId = taskId; this.closeComposerMenus();
      this.taskDetailLoaded = true; this.taskLoadError = ""; this.restoreTaskComposerDraft();
      this.resetVirtualWindow(); this.virtualListEl.empty(); this.renderTaskPlanDock(derived); this.renderInteractionDock(derived);
      this.renderMessages({ forceBottom: true }); this.renderTaskPages(); this.renderToolbar();
      animateTaskDetailEntry(this.taskDetailEl!, navigationToken); this.plugin.getConversationRunService().scheduleSave();
    } catch (error) {
      if (stillCurrent()) {
        this.restoreTaskComposerDraft();
        this.showTaskError(this.taskText("打开派生任务失败：", "Could not open the derived task: ") + (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      this.taskDerivationToken = null;
      if (stillCurrent()) {
        this.renderMessages({ forceBottom: true }); this.renderTaskPages(); this.renderToolbar();
      }
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    await deleteSessionAction(this.sessionHost(), sessionId);
  }

  private onInputChanged(): void {
    if (this.taskUiMounted) this.saveTaskComposerDraft();
    selectionDraft(this.inputEl);
    onInputChangedAction(this.composerHost());
  }
  private renderKnowledgeCommandMatches(query: string): void { renderKnowledgeCommandMatchesAction(this.composerHost(), query); }
  private clearComposerDraft(): void { clearComposerDraftAction(this.composerHost()); }
  private composerStateForSession(session: StoredSession): ComposerPrimaryActionState { return composerStateForSessionAction(this.composerHost(), session); }
  private pauseQueueForSession(sessionId: string): void { pauseQueueForSessionAction(this.composerHost(), sessionId); }
  private requireQueueRecoveryForSession(sessionId: string): void { requireQueueRecoveryForSessionAction(this.composerHost(), sessionId); }
  private sessionById(sessionId: string): StoredSession | null { return sessionByIdAction(this.sessionHost(), sessionId); }

  private async sendMessage(): Promise<void> {
    if (this.taskDerivationInProgress) return;
    if (this.promptEnhancerRunning) {
      new Notice(conversationUiText(this.plugin.settings.settingsLanguage, "提示词正在增强，请稍候", "The prompt is being enhanced. Please wait."));
      return;
    }
    if (this.taskUiMounted) {
      if (this.taskEditor) return;
      if (this.taskNavigation.page.kind === "list") { await this.sendNewAgentTask(); return; }
      const taskId = this.taskNavigation.page.taskId, token = this.taskNavigation.token;
      const entry = await this.plugin.readPiConversationCatalogEntry(taskId);
      if (token !== this.taskNavigation.token) return;
      if (!entry || !isUserTask(entry)) return;
      if (entry.taskStatus === "interrupted") { await this.resumeInterruptedTask(taskId, true); return; }
      await sendMessageRunner(this.createTurnRunnerContext(taskId));
      return;
    }
    await sendMessageRunner(this.turnRunnerContext);
  }

  private async enqueueComposerDraft(): Promise<void> {
    if (this.taskDerivationInProgress) return;
    if (this.taskUiMounted && this.taskNavigation.page.kind === "list") { await this.sendNewAgentTask(); return; }
    if (this.taskUiMounted && this.currentTaskEntry()?.taskStatus === "interrupted") { await this.resumeInterruptedTask(this.currentTaskEntry()!.conversationId, true); return; }
    if (this.promptEnhancerRunning) {
      new Notice(conversationUiText(this.plugin.settings.settingsLanguage, "提示词正在增强，请稍候", "The prompt is being enhanced. Please wait."));
      return;
    }
    await enqueueComposerDraftRunner(this.turnRunnerContext);
  }
  private async steerPiChatFromComposer(): Promise<void> {
    if (this.taskDerivationInProgress) return;
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
    if (this.taskUiMounted && this.currentTaskEntry()?.taskStatus === "interrupted") return;
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
  private async resumeQueuedTurns(sessionId: string): Promise<void> {
    try { await this.plugin.getConversationRunService().resumeQueuedTurns(sessionId); }
    catch (error) {
      if (this.viewLifecycleAbortController.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      if (this.taskUiMounted) { this.taskResumeErrors.set(sessionId, message); this.renderTaskInterruptionCard(); }
      else new Notice(message);
    }
  }
  private async afterTurnSettled(_sessionId: string, _succeeded: boolean): Promise<void> { /* The plugin service settles and advances the queue. */ }
  private async startNextQueuedTurn(sessionId: string): Promise<void> { await this.plugin.getConversationRunService().startNextQueuedTurn(sessionId); }
  private async createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> { return await createQueuedTurnFromComposerRunner(this.turnRunnerContext, options); }
  private async startQueuedTurnItem(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> {
    const outcome = await this.plugin.getConversationRunService().start(item, source);
    if (outcome === "running") item.piUserEntryAccepted = true;
    if (this.taskUiMounted && item.piUserEntryAccepted && (source === "composer" || item.clearComposerAfterPiAcceptance)) {
      consumeAcceptedTaskDraft(this.plugin.settings.taskWorkspace, this.taskDraftOrigins.get(item.id) ?? item.sessionId, item);
      this.plugin.getConversationRunService().scheduleSave();
    }
    return outcome;
  }
  private async startQueuedTurnItemSafely(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await this.startQueuedTurnItem(item, source); }
  private async startChatTurn(_session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed" | "cancelled"> { return await this.startQueuedTurnItem(item, source); }
  private async runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void> { await runKnowledgeBaseShortcutRunner(this.turnRunnerContext, label, runner); }
  private async stopTurn(): Promise<void> { await this.plugin.getConversationRunService().stopTask(this.plugin.settings.activeSessionId); }
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
  private renderMessagesIfActive(session: StoredSession, updatedMessage?: ChatMessage): void {
    if (this.taskUiMounted && (this.taskDerivationInProgress || this.taskNavigation.page.kind !== "detail" || !this.taskDetailLoaded || this.taskEditor)) return;
    renderMessagesIfActiveAction(this.messageHost(), session, updatedMessage);
  }
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
  private ensureSession(): StoredSession {
    if (this.taskUiMounted && (this.taskNavigation.page.kind === "list" || !this.taskDetailLoaded)) return {
      id: this.taskNavigation.draftKey, title: "", cwd: this.plugin.getVaultPath(), messages: [], createdAt: 0, updatedAt: 0
    };
    return ensureSessionAction(this.sessionHost());
  }
  private async createSession(title?: string, options: CreateSessionOptions = {}): Promise<StoredSession> {
    if (this.taskUiMounted) this.saveTaskComposerDraft();
    const session = await createSessionAction(this.sessionHost(), title ?? conversationUiText(this.plugin.settings.settingsLanguage, "新会话", "New conversation"), options);
    if (this.taskUiMounted) {
      this.taskNavigation.navigate({ kind: "detail", taskId: session.id }); this.taskDetailLoaded = true;
      this.composerDraftOwner = session.id; this.renderTaskPages();
    }
    return session;
  }

  private attachActiveFile(): void { attachActiveFileAction(this.attachmentHost()); }
  private pickFiles(imagesOnly: boolean): void { pickFilesAction(this.attachmentHost(), imagesOnly); }
  private pickKnowledgeBaseFiles(): void { pickKnowledgeBaseFilesAction(this.attachmentHost()); }
  private handleDroppedFiles(event: DragEvent): void { handleDroppedFilesAction(this.attachmentHost(), event); }
  private async handlePastedFiles(event: ClipboardEvent): Promise<void> { await handlePastedFilesAction(this.attachmentHost(), event); }
}
