import type { TaskInterruptionReason, TaskResumeContext } from "../agents/task-resume";
import type { ConversationTaskMetadataPatch } from "../agents/task-metadata";
import type CodexForObsidianPlugin from "../main";
import { Notice, Platform } from "obsidian";
import { getWorkbenchDataService } from "../home/workbench-data";
import { parseWorkbenchTaskSource } from "../home/task-launcher";
import { diagnoseProviderError } from "../core/provider-diagnostics";
import { RuntimeTurnQueue, cloneQueuedTurnItem, type QueuedTurnItem } from "../ui/turn-queue";
import type { CodexViewTurnContext, QueuedTurnOutcome, QueuedTurnSource } from "../ui/codex-view/runner-context";
import { startQueuedTurnItemSafely, startQueuedTurnItem, startChatTurn } from "../ui/codex-view/turn-runner";
import { SessionMessageStore } from "../ui/codex-view/session-message-store";
import type { ChatMessage, StoredSession } from "../settings/settings";
import { cloneEchoInkTurnInteraction, type EchoInkTurnInteraction } from "../types/conversation-turn";
import { armPausableTurnWatchdog, clearPausableTurnWatchdog, setTurnWatchdogWaiting, CHAT_TURN_WATCHDOG_MS } from "../ui/turn-watchdog";

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
  flight?: Promise<QueuedTurnOutcome>;
}

export interface ConversationRunSubscriber {
  refresh(taskId: string, message?: ChatMessage): void;
  clearAcceptedDraft(item: Readonly<QueuedTurnItem>): void;
  isTaskVisible(taskId: string): boolean;
}

/** Plugin-owned runtime. No run host or queued item retains a View or its DOM. */
export class ConversationRunService {
  readonly runs = new Map<string, ConversationRunState>();
  readonly turnQueue = new RuntimeTurnQueue();
  readonly pendingInteractions = new Map<string, Readonly<EchoInkTurnInteraction>>();
  private readonly subscribers = new Set<ConversationRunSubscriber>();
  private readonly resumeFlights = new Map<string, Promise<QueuedTurnOutcome>>();
  private readonly resumeControllers = new Map<string, AbortController>();
  private readonly resumeErrors = new Map<string, string>();
  private readonly resumeContexts = new Map<string, Readonly<TaskResumeContext>>();
  private readonly blockedAgents = new Set<string>();
  private readonly pendingRefreshes = new Map<string, ChatMessage | undefined>();
  private readonly pendingInteractionWrites = new Map<string, { key: string }>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private disposalFlight?: Promise<void>;

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  subscribe(subscriber: ConversationRunSubscriber): () => void {
    if (this.disposed) throw new Error("conversation_run_service_disposed");
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      if (!this.subscribers.size) this.clearRefreshes();
    };
  }
  isTaskVisible(id: string): boolean { return [...this.subscribers].some(subscriber => subscriber.isTaskVisible(id)); }
  refreshTask(id: string): void { this.notify(id); }
  private notify(id: string, message?: ChatMessage): void {
    if (this.disposed) return;
    this.scheduleSave();
    if (!this.subscribers.size) return;
    // A full refresh, or updates to different messages, must retain a full render.
    const previous = this.pendingRefreshes.get(id);
    this.pendingRefreshes.set(id, !this.pendingRefreshes.has(id) || previous && message && previous.id === message.id ? message : undefined);
    if (this.refreshTimer !== null) return;
    // Pi replays its buffered events in microtasks. Yield to the host event loop
    // before rendering; a microtask flush would still starve input and timers.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const updates = [...this.pendingRefreshes];
      this.pendingRefreshes.clear();
      for (const [taskId, changedMessage] of updates) {
        for (const subscriber of this.subscribers) {
          try { subscriber.refresh(taskId, changedMessage); } catch (error) { console.error("Conversation subscriber refresh failed", error); }
        }
      }
    }, 16);
  }
  private clearRefreshes(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.pendingRefreshes.clear();
  }
  stateFor(id: string): ConversationRunState {
    let state = this.runs.get(id);
    if (!state) {
      state = { running: false, activeRunId: "", activeRunKind: "", activeRunSessionId: "", activeTurnId: "", turnStartedAt: 0, turnWatchdog: null, queueStartInProgress: false, controller: new AbortController() };
      this.runs.set(id, state);
    }
    return state;
  }
  clearActiveRun(id: string, state = this.stateFor(id)): void {
    state.activeRunId = ""; state.activeRunKind = ""; state.activeRunSessionId = ""; state.activeTurnId = "";
    if (!state.running && !state.queueStartInProgress && !state.flight && this.runs.get(id) === state) this.runs.delete(id);
  }
  blockAgent(id: string): void { this.blockedAgents.add(id); }
  unblockAgent(id: string): void { this.blockedAgents.delete(id); }
  isAgentBlocked(id: string): boolean { return this.blockedAgents.has(id); }

  isResuming(id: string): boolean { return this.resumeFlights.has(id); }
  getResumeError(id: string): string | undefined { return this.resumeErrors.get(id); }
  get activeResumeContexts(): ReadonlyMap<string, Readonly<TaskResumeContext>> { return this.resumeContexts; }

  /** Claim this task before any IO; every entry point shares the same acceptance. */
  resumeTask(id: string, message?: string, item?: QueuedTurnItem, source: QueuedTurnSource = "composer"): Promise<QueuedTurnOutcome> {
    const existing = this.resumeFlights.get(id);
    if (existing) return existing;
    if (this.disposed) return Promise.reject(new Error("插件已停用，请重新启用后继续。"));
    if (this.runs.get(id)?.flight || this.runs.get(id)?.running) return Promise.reject(new Error("这个任务正在运行，请等待本轮完成。"));
    const submitted = item ? cloneQueuedTurnItem(item) : undefined;
    const controller = new AbortController();
    this.resumeControllers.set(id, controller);
    this.resumeErrors.delete(id);
    const flight = Promise.resolve().then(async () => {
      const prepared = await this.plugin.prepareTaskResume(id, message, submitted, controller.signal);
      if (controller.signal.aborted) return "cancelled";
      if (this.disposed) throw new Error("插件已停用，本次没有继续。文字和附件已保留。");
      this.resumeContexts.set(id, prepared.resumeContext!);
      let accepted!: (outcome: QueuedTurnOutcome) => void;
      let wasAccepted = false;
      const acceptance = new Promise<QueuedTurnOutcome>(resolve => { accepted = resolve; });
      const completion = this.run(prepared, source, () => {
        if (source === "queue") this.turnQueue.resumeSessionQueue(id);
        wasAccepted = true; accepted("running");
      });
      void completion.catch(error => { if (wasAccepted) console.error("Resumed task could not finalize", error); });
      const outcome = await Promise.race([acceptance, completion]);
      if (outcome === "failed" && !wasAccepted) throw new Error(this.resumeErrors.get(id) ?? "任务暂时无法继续，请检查模型和附件后重试。文字和附件已保留。");
      return outcome;
    }).catch(error => {
      if (controller.signal.aborted) return "cancelled" as const;
      this.resumeErrors.set(id, error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => {
      if (this.resumeFlights.get(id) === flight) this.resumeFlights.delete(id);
      if (this.resumeControllers.get(id) === controller) this.resumeControllers.delete(id);
      // On acceptance run() owns the context until its durable settlement.
      if (!this.runs.get(id)?.flight) this.resumeContexts.delete(id);
      this.notify(id);
      if (!this.runs.get(id)?.flight && this.turnQueue.peekNext(id)) void this.startNextQueuedTurn(id).catch(error => console.error("Resumed queue could not continue", error));
    });
    this.resumeFlights.set(id, flight);
    this.notify(id);
    return flight;
  }

  /** UI handlers release their View as soon as the durable Pi run is accepted. */
  async start(item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
    let accepted!: (outcome: QueuedTurnOutcome) => void;
    let wasAccepted = false;
    const acceptance = new Promise<QueuedTurnOutcome>(resolve => { accepted = resolve; });
    const completion = this.run(item, source, () => { wasAccepted = true; accepted("running"); });
    void completion.catch(error => {
      if (!wasAccepted) return;
      console.error("Accepted conversation could not finalize", error);
      new Notice(error instanceof Error ? error.message : String(error));
    });
    return await Promise.race([acceptance, completion]).catch(error => {
      console.error("Conversation could not start or finalize", error);
      new Notice(error instanceof Error ? error.message : String(error));
      return "failed" as const;
    });
  }

  async run(item: QueuedTurnItem, source: QueuedTurnSource = "composer", onAccepted?: () => void): Promise<QueuedTurnOutcome> {
    const session = this.session(item.sessionId);
    if (this.disposed || this.blockedAgents.has(session.agentId ?? "sol")) return "cancelled";
    if (this.resumeFlights.has(session.id) && !item.resumeContext) throw new Error("这个任务正在核对恢复信息，请稍候。");
    if (source === "queue" && session.taskStatus === "interrupted" && !item.resumeContext) throw new Error("任务已中断，请先核对恢复信息后继续队列。");
    const state = this.stateFor(session.id);
    if (state.flight || state.running) throw new Error("conversation_already_running");
    const frozen = cloneQueuedTurnItem(item);
    const context = this.createHost(state, frozen, onAccepted);
    state.context = context;
    const flight = Promise.resolve().then(async (): Promise<QueuedTurnOutcome> => {
      let outcome: QueuedTurnOutcome = "failed";
      try {
        outcome = await startQueuedTurnItemSafely(context, frozen, source);
        if (frozen.piUserEntryAccepted) {
          const pending = this.pendingInteractions.get(session.id);
          const waiting = pending && (pending.status === "pending" || pending.status === "submitting");
          const maintenance = this.plugin.getKnowledgeActivitySource()?.snapshot().maintenance.filter(activity => activity.originConversationId === session.id && (activity.status !== "completed" || (activity.completedAt ?? 0) >= state.turnStartedAt)).sort((a,b) => b.updatedAt - a.updatedAt)[0];
          const businessComplete = !maintenance || maintenance.status === "completed";
          await this.plugin.setPiConversationTaskMetadata(session.id, outcome === "completed" && !waiting && businessComplete
            ? { taskStatus: "completed", taskCompletedAt: maintenance?.completedAt ?? Date.now(), taskInterruptedAt: undefined, pendingResponse: undefined, taskStage: undefined }
            : waiting ? { taskStatus: "waiting" }
              : { taskStatus: "interrupted", taskInterruptedAt: Date.now(), taskCompletedAt: undefined });
          if (Platform.isDesktopApp && outcome === "completed" && !waiting && businessComplete && session.businessKey) {
            await getWorkbenchDataService(this.plugin).recordTaskCompleted(session.id).catch(error => {
              console.warn("EchoInk workbench could not record the task result.", error);
              new Notice("任务已完成，但工作台事项尚未更新，请稍后重试。");
            });
          }
        }
        return outcome;
      } finally {
        item.piUserEntryAccepted = frozen.piUserEntryAccepted;
        state.running = false; state.queueStartInProgress = false;
        state.flight = undefined;
        state.context = undefined;
        this.resumeContexts.delete(session.id);
        this.clearWatchdog(state);
        this.clearActiveRun(session.id, state);
        const next = this.turnQueue.settleSessionQueue(session.id, outcome === "completed");
        await this.flushSave();
        this.notify(session.id);
        if (next === "continue" && !this.disposed && !this.blockedAgents.has(session.agentId ?? "sol")) {
          void this.startNextQueuedTurn(session.id).catch(error => console.error("Conversation queue failed", error));
        }
      }
    });
    state.flight = flight;
    return await flight;
  }
  async startNextQueuedTurn(id: string): Promise<void> {
    const state = this.runs.get(id);
    if (this.disposed || this.resumeFlights.has(id) || state?.flight || state?.running || state?.queueStartInProgress) return;
    const item = this.turnQueue.peekNext(id);
    if (item) await this.run(item, "queue");
  }
  async resumeQueuedTurns(id: string): Promise<void> {
    if (this.turnQueue.isSessionRecoveryRequired(id)) throw new Error("当前任务记录需要先恢复，请检查中断信息。队列已保留。");
    if (this.session(id).taskStatus === "interrupted") {
      this.turnQueue.pauseSessionQueue(id);
      const head = this.turnQueue.itemsForSession(id)[0];
      if (head) await this.resumeTask(id, head.text, head, "queue");
      return;
    }
    this.turnQueue.resumeSessionQueue(id);
    await this.startNextQueuedTurn(id);
  }
  async stopTask(id: string, reason: TaskInterruptionReason = "user_stopped"): Promise<void> {
    const resumeFlight = this.resumeFlights.get(id);
    this.resumeControllers.get(id)?.abort();
    const state = this.runs.get(id);
    const flight = state?.flight;
    this.turnQueue.pauseSessionQueue(id);
    await this.plugin.recordTaskInterruption?.(id, reason).catch(error => console.error("Task interruption cause could not be saved", error));
    if (state) { state.controller.abort(); this.clearWatchdog(state); }
    await this.plugin.abortPiConversation(id);
    if (flight) await flight;
    if (resumeFlight) await resumeFlight.catch(() => undefined);
    await this.flushSave();
  }
  dispose(reason: TaskInterruptionReason = "plugin_disabled"): Promise<void> {
    if (this.disposalFlight) return this.disposalFlight;
    this.disposed = true;
    this.subscribers.clear();
    this.clearRefreshes();
    const flight = Promise.resolve().then(async () => {
      await Promise.all([...new Set([...this.runs.keys(), ...this.resumeFlights.keys()])].map(id => this.stopTask(id, reason)));
      await this.flushSave();
      this.runs.clear();
      this.pendingInteractions.clear();
      this.pendingInteractionWrites.clear();
    });
    this.disposalFlight = flight;
    return flight;
  }
  private session(id: string): StoredSession {
    const session = this.plugin.settings.sessions.find(session => session.id === id);
    if (!session) throw new Error(`Conversation ${id} not found`);
    return session;
  }
  scheduleSave(): void {
    if (this.disposed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings(true).catch(error => console.error("Conversation projection save failed", error));
    }, 500);
  }
  async flushSave(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      await this.plugin.saveSettings(true);
    } catch (error) {
      // Only the settings projection is best-effort. Catalog and task metadata
      // writes retain their existing failure handling at their call sites.
      console.error("Conversation projection save failed", error);
    }
  }
  private clearWatchdog(state: ConversationRunState): void {
    clearPausableTurnWatchdog(state);
  }
  private createHost(state: ConversationRunState, item: QueuedTurnItem, onAccepted?: () => void): CodexViewTurnContext {
    const plugin = this.plugin;
    const id = item.sessionId;
    const refresh = (message?: ChatMessage) => this.notify(id, message);
    const store = new SessionMessageStore({
      getActiveRunId: () => state.activeRunId, getActiveTurnId: () => state.activeTurnId,
      getVaultPath: () => plugin.getVaultPath(), getSettingsLanguage: () => plugin.settings.settingsLanguage,
      externalizeMessageText: (message, text) => plugin.externalizeMessageText(message, text),
      renderMessagesIfActive: (_session, message) => refresh(message), scheduleSessionSave: () => this.scheduleSave()
    });
    const context: CodexViewTurnContext = {
      onPiRunAccepted: async () => {
        void plugin.onWorkbenchMessageAccepted?.(item).catch(() => undefined);
        const origin = Platform.isDesktopApp ? parseWorkbenchTaskSource(item.prefillSource) : null;
        if (origin) {
          try {
            const results = await Promise.allSettled([
              getWorkbenchDataService(plugin).recordTaskAccepted(id, origin),
              plugin.setPiConversationTaskMetadata(id, { businessKey: origin.businessKey })
            ]);
            const failures = results.filter(result => result.status === "rejected");
            if (failures.length) throw new AggregateError(failures.map((result): unknown => result.reason), "workbench_task_source_save_failed");
          } catch (error) {
            console.warn("EchoInk accepted task could not save its workbench source.", error);
            new Notice("任务已开始，但提醒来源记录未保存；请勿重复发送。");
          }
        }
        onAccepted?.();
      },
      onPiRunFailure: message => { if (item.resumeContext) this.resumeErrors.set(id, message); },
      get lifecycleSignal() { return state.controller.signal; }, get app() { return plugin.app; }, plugin,
      get running() { return state.running; }, set running(value) { state.running = value; },
      get activeRunId() { return state.activeRunId; }, set activeRunId(value) { state.activeRunId = value; },
      get activeRunKind() { return state.activeRunKind; }, set activeRunKind(value) { state.activeRunKind = value; },
      get activeRunSessionId() { return state.activeRunSessionId; }, set activeRunSessionId(value) { state.activeRunSessionId = value; },
      get activeTurnId() { return state.activeTurnId; }, set activeTurnId(value) { state.activeTurnId = value; },
      get queueStartInProgress() { return state.queueStartInProgress; }, set queueStartInProgress(value) { state.queueStartInProgress = value; },
      get turnStartedAt() { return state.turnStartedAt; }, set turnStartedAt(value) { state.turnStartedAt = value; },
      turnQueue: this.turnQueue,
      get inputEl(): HTMLTextAreaElement { throw new Error("Run host has no Composer DOM"); },
      attachments: item.attachments, selectedSkill: item.skill, selectedProviderSettingsId: item.turnOptions.providerSettingsId ?? "", selectedModel: item.turnOptions.model,
      messagesBottomFollowPaused: false,
      applyStatus: () => refresh(), renderToolbar: () => refresh(), renderQueue: () => refresh(), renderTabs: () => refresh(), renderMessages: () => refresh(),
      renderMessagesIfActive: (_session, message) => refresh(message),
      clearActiveRun: () => { store.clearActiveRun(); this.clearActiveRun(id, state); },
      armTurnWatchdog: (timeout = CHAT_TURN_WATCHDOG_MS) => {
        armPausableTurnWatchdog(state, () => {
          if (!state.running) return;
          void this.stopTask(id, "watchdog").catch(error => console.error("Conversation timeout cancellation failed", error));
        }, timeout);
      }, clearTurnWatchdog: () => this.clearWatchdog(state),
      diagnoseCodexFailure: (error, model) => diagnoseProviderError(error, { model: model ?? item.turnOptions.model }),
      ensureSession: () => this.session(id), sessionById: taskId => plugin.settings.sessions.find(session => session.id === taskId) ?? null,
      composerStateForSession: () => ({}) as never,
      enqueueComposerDraft: async () => { throw new Error("Run host cannot read a Composer draft"); },
      createQueuedTurnFromComposer: async () => { throw new Error("Run host requires a frozen queued item"); },
      clearComposerDraft: () => undefined,
      clearAcceptedComposerDraft: frozen => {
        for (const subscriber of this.subscribers) {
          try { subscriber.clearAcceptedDraft(frozen); }
          catch (error) { console.error("Accepted Composer draft could not refresh", error); }
        }
      },
      ensureChatWorkspaceSelected: async () => true, currentTurnOptions: () => item.turnOptions,
      startQueuedTurnItem: (frozen, source) => startQueuedTurnItem(context, frozen, source),
      startQueuedTurnItemSafely: (frozen, source) => startQueuedTurnItemSafely(context, frozen, source),
      startChatTurn: (session, frozen, source) => startChatTurn(context, session, frozen, source),
      resumeQueuedTurns: taskId => this.resumeQueuedTurns(taskId), startNextQueuedTurn: taskId => this.startNextQueuedTurn(taskId),
      afterTurnSettled: async () => undefined, stopTurn: () => this.stopTask(id), pauseQueueForSession: taskId => this.turnQueue.pauseSessionQueue(taskId),
      setPendingInteraction: (taskId, interaction, expectedTurnId) => {
        const current = this.pendingInteractions.get(taskId);
        const task = this.session(taskId);
        const taskState = this.runs.get(taskId);
        const terminal = task.taskStatus === "completed" || task.taskStatus === "interrupted";
        if ((interaction && interaction.conversationId !== taskId)
          || (!interaction && expectedTurnId && current && current.turnId !== expectedTurnId)
          || (interaction && terminal && !taskState?.activeTurnId)) return;
        const changed = JSON.stringify(current ?? null) !== JSON.stringify(interaction);
        if (changed) {
          if (interaction) this.pendingInteractions.set(taskId, cloneEchoInkTurnInteraction(interaction));
          else this.pendingInteractions.delete(taskId);
        }
        const pending = this.pendingInteractions.get(taskId);
        const waiting = pending && (pending.status === "pending" || pending.status === "submitting");
        if (taskState) setTurnWatchdogWaiting(taskState, !!waiting && pending.turnId === taskState.activeTurnId);
        const patch: ConversationTaskMetadataPatch = waiting
          ? { taskStatus: "waiting", pendingResponse: { runId: pending.turnId,
              questionId: pending.kind === "question" ? pending.questions[pending.activeQuestionIndex ?? 0]?.questionId ?? pending.interactionId : pending.interactionId,
              kind: pending.kind } }
          : { ...(taskState?.running && !terminal ? { taskStatus: "running" as const } : {}), pendingResponse: undefined };
        const key = JSON.stringify([pending ?? null, patch]);
        const metadataMatches = (!patch.taskStatus || task.taskStatus === patch.taskStatus)
          && JSON.stringify(task.pendingResponse) === JSON.stringify(patch.pendingResponse);
        if (changed || (!metadataMatches && this.pendingInteractionWrites.get(taskId)?.key !== key)) {
          const write = { key };
          this.pendingInteractionWrites.set(taskId, write);
          void plugin.setPiConversationTaskMetadata(taskId, patch).catch(error => console.error("Conversation interaction state save failed", error)).finally(() => {
            if (this.pendingInteractionWrites.get(taskId) === write) this.pendingInteractionWrites.delete(taskId);
          });
        }
        if (changed || !metadataMatches) this.notify(taskId);
      },
      ensureThinkingMessage: (session, title, text) => store.ensureThinkingMessage(session, title, text),
      dismissThinkingMessage: session => store.dismissThinkingMessage(session),
      attachTurnIdToRun: (session, turnId) => { for (const message of session.messages) if (message.runId === state.activeRunId) message.turnId = turnId; },
      finishThinkingMessage: (session, status) => store.finishThinkingMessage(session, status),
      finishRunningProcessMessages: (session, status) => store.finishRunningProcessMessages(session, status),
      finishPlanMessage: session => store.finishPlanMessage(session), addMessageToSession: (session, message) => store.addMessageToSession(session, message),
      moveMessageToEnd: (session, messageId) => store.moveMessageToEnd(session, messageId), fillKnowledgeBaseCommand: () => undefined
    };
    return context;
  }
}
