import type CodexForObsidianPlugin from "../main";
import { Notice } from "obsidian";
import { diagnoseProviderError } from "../core/provider-diagnostics";
import { RuntimeTurnQueue, cloneQueuedTurnItem, type QueuedTurnItem } from "../ui/turn-queue";
import type { CodexViewTurnContext, QueuedTurnOutcome, QueuedTurnSource } from "../ui/codex-view/runner-context";
import { startQueuedTurnItemSafely, startQueuedTurnItem, startChatTurn } from "../ui/codex-view/turn-runner";
import { SessionMessageStore } from "../ui/codex-view/session-message-store";
import type { ChatMessage, StoredSession } from "../settings/settings";
import { cloneEchoInkTurnInteraction, type EchoInkTurnInteraction } from "../types/conversation-turn";
import { CHAT_TURN_WATCHDOG_MS } from "../ui/turn-watchdog";

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
  private readonly blockedAgents = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  subscribe(subscriber: ConversationRunSubscriber): () => void {
    if (this.disposed) throw new Error("conversation_run_service_disposed");
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }
  isTaskVisible(id: string): boolean { return [...this.subscribers].some(subscriber => subscriber.isTaskVisible(id)); }
  private notify(id: string, message?: ChatMessage): void {
    for (const subscriber of this.subscribers) {
      try { subscriber.refresh(id, message); } catch (error) { console.error("Conversation subscriber refresh failed", error); }
    }
    this.scheduleSave();
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
    const state = this.stateFor(session.id);
    if (state.flight || state.running) throw new Error("conversation_already_running");
    const frozen = cloneQueuedTurnItem(item);
    const context = this.createHost(state, frozen, onAccepted);
    state.context = context;
    const flight = (async (): Promise<QueuedTurnOutcome> => {
      let outcome: QueuedTurnOutcome = "failed";
      try {
        outcome = await startQueuedTurnItemSafely(context, frozen, source);
        if (frozen.piUserEntryAccepted) {
          const pending = this.pendingInteractions.get(session.id);
          const waiting = pending && (pending.status === "pending" || pending.status === "submitting");
          await this.plugin.setPiConversationTaskMetadata(session.id, outcome === "completed" && !waiting
            ? { taskStatus: "completed", taskCompletedAt: Date.now(), taskInterruptedAt: undefined, pendingResponse: undefined, taskStage: undefined }
            : waiting ? { taskStatus: "waiting" }
              : { taskStatus: "interrupted", taskInterruptedAt: Date.now(), taskCompletedAt: undefined });
        }
        return outcome;
      } finally {
        item.piUserEntryAccepted = frozen.piUserEntryAccepted;
        state.running = false; state.queueStartInProgress = false;
        state.flight = undefined;
        state.context = undefined;
        this.clearWatchdog(state);
        this.clearActiveRun(session.id, state);
        const next = this.turnQueue.settleSessionQueue(session.id, outcome === "completed");
        await this.flushSave();
        this.notify(session.id);
        if (next === "continue" && !this.disposed && !this.blockedAgents.has(session.agentId ?? "sol")) {
          void this.startNextQueuedTurn(session.id).catch(error => console.error("Conversation queue failed", error));
        }
      }
    })();
    state.flight = flight;
    return await flight;
  }
  async startNextQueuedTurn(id: string): Promise<void> {
    const state = this.runs.get(id);
    if (this.disposed || state?.flight || state?.running || state?.queueStartInProgress) return;
    const item = this.turnQueue.peekNext(id);
    if (item) await this.run(item, "queue");
  }
  async resumeQueuedTurns(id: string): Promise<void> {
    this.turnQueue.resumeSessionQueue(id);
    await this.startNextQueuedTurn(id);
  }
  async stopTask(id: string): Promise<void> {
    const state = this.runs.get(id);
    const flight = state?.flight;
    this.turnQueue.pauseSessionQueue(id);
    if (state) { state.controller.abort(); this.clearWatchdog(state); }
    await this.plugin.abortPiConversation(id);
    if (flight) await flight;
    await this.flushSave();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    await Promise.all([...this.runs.keys()].map(id => this.stopTask(id)));
    await this.flushSave();
    this.runs.clear();
    this.pendingInteractions.clear();
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
    await this.plugin.saveSettings(true);
  }
  private clearWatchdog(state: ConversationRunState): void {
    if (state.turnWatchdog !== null) window.clearTimeout(state.turnWatchdog);
    state.turnWatchdog = null;
  }
  private createHost(state: ConversationRunState, item: QueuedTurnItem, onAccepted?: () => void): CodexViewTurnContext {
    const service = this;
    const plugin = this.plugin;
    const id = item.sessionId;
    const refresh = (message?: ChatMessage) => service.notify(id, message);
    const store = new SessionMessageStore({
      getActiveRunId: () => state.activeRunId, getActiveTurnId: () => state.activeTurnId,
      getVaultPath: () => plugin.getVaultPath(), getSettingsLanguage: () => plugin.settings.settingsLanguage,
      externalizeMessageText: (message, text) => plugin.externalizeMessageText(message, text),
      renderMessagesIfActive: (_session, message) => refresh(message), scheduleSessionSave: () => service.scheduleSave()
    });
    const context: CodexViewTurnContext = {
      onPiRunAccepted: () => onAccepted?.(),
      get lifecycleSignal() { return state.controller.signal; }, get app() { return plugin.app; }, plugin,
      get running() { return state.running; }, set running(value) { state.running = value; },
      get activeRunId() { return state.activeRunId; }, set activeRunId(value) { state.activeRunId = value; },
      get activeRunKind() { return state.activeRunKind; }, set activeRunKind(value) { state.activeRunKind = value; },
      get activeRunSessionId() { return state.activeRunSessionId; }, set activeRunSessionId(value) { state.activeRunSessionId = value; },
      get activeTurnId() { return state.activeTurnId; }, set activeTurnId(value) { state.activeTurnId = value; },
      get queueStartInProgress() { return state.queueStartInProgress; }, set queueStartInProgress(value) { state.queueStartInProgress = value; },
      get turnStartedAt() { return state.turnStartedAt; }, set turnStartedAt(value) { state.turnStartedAt = value; },
      turnQueue: service.turnQueue,
      get inputEl(): HTMLTextAreaElement { throw new Error("Run host has no Composer DOM"); },
      attachments: item.attachments, selectedSkill: item.skill, selectedProviderSettingsId: item.turnOptions.providerSettingsId ?? "", selectedModel: item.turnOptions.model,
      messagesBottomFollowPaused: false,
      applyStatus: () => refresh(), renderToolbar: () => refresh(), renderQueue: () => refresh(), renderTabs: () => refresh(), renderMessages: () => refresh(),
      renderMessagesIfActive: (_session, message) => refresh(message),
      clearActiveRun: () => { store.clearActiveRun(); service.clearActiveRun(id, state); },
      armTurnWatchdog: (timeout = CHAT_TURN_WATCHDOG_MS) => {
        service.clearWatchdog(state);
        state.turnWatchdog = window.setTimeout(() => {
          state.turnWatchdog = null;
          if (state.running) void service.stopTask(id).catch(error => console.error("Conversation timeout cancellation failed", error));
        }, timeout);
      }, clearTurnWatchdog: () => service.clearWatchdog(state),
      diagnoseCodexFailure: (error, model) => diagnoseProviderError(error, { model: model ?? item.turnOptions.model }),
      ensureSession: () => service.session(id), sessionById: taskId => plugin.settings.sessions.find(session => session.id === taskId) ?? null,
      composerStateForSession: () => ({}) as never,
      enqueueComposerDraft: async () => { throw new Error("Run host cannot read a Composer draft"); },
      createQueuedTurnFromComposer: async () => { throw new Error("Run host requires a frozen queued item"); },
      clearComposerDraft: () => undefined,
      clearAcceptedComposerDraft: frozen => {
        for (const subscriber of service.subscribers) {
          try { subscriber.clearAcceptedDraft(frozen); }
          catch (error) { console.error("Accepted Composer draft could not refresh", error); }
        }
      },
      ensureChatWorkspaceSelected: async () => true, currentTurnOptions: () => item.turnOptions,
      startQueuedTurnItem: (frozen, source) => startQueuedTurnItem(context, frozen, source),
      startQueuedTurnItemSafely: (frozen, source) => startQueuedTurnItemSafely(context, frozen, source),
      startChatTurn: (session, frozen, source) => startChatTurn(context, session, frozen, source),
      resumeQueuedTurns: taskId => service.resumeQueuedTurns(taskId), startNextQueuedTurn: taskId => service.startNextQueuedTurn(taskId),
      afterTurnSettled: async () => undefined, stopTurn: () => service.stopTask(id), pauseQueueForSession: taskId => service.turnQueue.pauseSessionQueue(taskId),
      setPendingInteraction: (taskId, interaction, expectedTurnId) => {
        const current = service.pendingInteractions.get(taskId);
        if (interaction && interaction.conversationId === taskId) service.pendingInteractions.set(taskId, cloneEchoInkTurnInteraction(interaction));
        else if (!interaction && (!expectedTurnId || current?.turnId === expectedTurnId)) service.pendingInteractions.delete(taskId);
        const pending = service.pendingInteractions.get(taskId);
        const waiting = pending && (pending.status === "pending" || pending.status === "submitting");
        void plugin.setPiConversationTaskMetadata(taskId, waiting
          ? { taskStatus: "waiting", pendingResponse: { runId: pending.turnId,
              questionId: pending.kind === "question" ? pending.questions[pending.activeQuestionIndex ?? 0]?.questionId ?? pending.interactionId : pending.interactionId,
              kind: pending.kind } }
          : { ...(state.running ? { taskStatus: "running" as const } : {}), pendingResponse: undefined }).catch(error => console.error("Conversation interaction state save failed", error));
        refresh();
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
