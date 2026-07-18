import { Notice, normalizePath, Platform, setIcon, TFile, type App, type Component } from "obsidian";
import type { AgentBackendMode, ChatMessage, DiffSummary, SettingsLanguage, StoredAttachment } from "../../settings/settings";
import type { KnowledgeBaseCitation, KnowledgeBaseCitationBucket, KnowledgeBaseCitationSummary, KnowledgeWorkflowEvent, KnowledgeWorkflowPhaseId } from "../../knowledge-base/types";
import type { ProcessFileRef, TokenUsage } from "../../types/app-server";
import { showItemInFinder } from "../../core/electron";
import { basename, normalizeProcessFileRef } from "../../core/mapping";
import { diffSummaryLabel, parseFileChangeDiff, type ParsedDiffFile } from "../../core/diff-summary";
import { displayTextForMessage, isLargeRawMessage } from "../../core/raw-message-store";
import { calculateVirtualWindow, isNearVirtualBottom, scrollTopForVirtualBottom } from "../../core/virtual-window";
import { extractKnowledgeBaseResultTitle } from "../knowledge-base-result-title";
import type { KnowledgeBaseMaintainReportPayload, KnowledgeBaseMessageUiPayload, KnowledgeBaseRunPayload } from "../../knowledge-base/maintain-report-card";
import { formatMessageHeaderTime } from "../message-time";
import { openImageOverlay, renderRichText } from "../render-message";
import { buildActionTimeline, isActionTimelineItem, type ActionGroupKind, type ActionItemViewModel } from "./action-timeline";
import { buildAgentTurnProjection, formatAgentTurnDuration, isAgentAnswerMessage, isAgentProcessItemType, type CompletedAgentTurn } from "./agent-turn-process";
import { copyAnswerMarkdown } from "./answer-copy";
import { agentRecoveryCopy, missingAgentCliBackend } from "../codex-recovery";

type MessageRenderRow =
  | { id: string; kind: "message"; message: ChatMessage; showAgentHeader: boolean; showAgentFooter: boolean; processExpanded: boolean }
  | { id: string; kind: "actionItem"; message: ChatMessage; showAgentHeader: boolean }
  | { id: string; kind: "turnProcess"; turn: CompletedAgentTurn; showAgentHeader: boolean };

export interface MessageListRenderOptions {
  forceBottom?: boolean;
  fromScroll?: boolean;
  preserveScroll?: boolean;
}

export interface MessageListRenderInput {
  app: App;
  component: Component;
  messagesEl: HTMLElement;
  virtualListEl: HTMLElement;
  sessionId: string;
  knowledgeSession: boolean;
  settingsLanguage: SettingsLanguage;
  messages: ChatMessage[];
  hiddenKnowledgeMessageCount: number;
  tokenUsage?: TokenUsage;
  vaultPath: string;
  readRawMessageText: (rawRef: string) => Promise<string>;
  onOpenKnowledgeHistory: () => void;
  onAutoRepairAgent: (backend: AgentBackendMode) => void;
  onOpenAgentSettings: (backend: AgentBackendMode) => void;
  onScheduleMeasure: (forceBottom?: boolean) => void;
  onScheduleRunProgress: () => void;
  shouldFollowBottom?: () => boolean;
  options?: MessageListRenderOptions;
}

interface MessageListEnvironment extends MessageListRenderInput {
  options: MessageListRenderOptions;
}

interface PendingProcessMessageUpdate {
  message: ChatMessage;
  sessionId: string;
  shouldPinBottom: boolean;
}

export class LatestByKeyFrameBatcher<T> {
  private readonly pending = new Map<string, T>();
  private scheduled = false;

  enqueue(
    key: string,
    value: T,
    scheduleFrame: (callback: () => void) => void,
    flush: (values: T[]) => void
  ): void {
    this.pending.set(key, value);
    if (this.scheduled) return;
    this.scheduled = true;
    scheduleFrame(() => {
      this.scheduled = false;
      const values = Array.from(this.pending.values());
      this.pending.clear();
      if (values.length) flush(values);
    });
  }
}

const KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT = 18;
const KNOWLEDGE_BASE_RUN_CELL_MS = 360;
const MESSAGE_LIST_BOTTOM_SPACER_PX = 0;
const MESSAGE_LIST_BOTTOM_PIN_EPSILON_PX = 2;
const VIRTUAL_RERENDER_BURST_LIMIT = 24;
const VIRTUAL_RERENDER_WINDOW_MS = 1000;
const AGENT_LIVE_COPY_INTERVAL_MS = 1800;
const PROCESS_CONTENT_UNAVAILABLE_TEXT = "后端未提供可展示内容";
const COLD_START_STATUS_TEXT = "正在整理上下文";
const COLD_START_COPY_TEXTS = ["先把问题看明白", "等模型接上话", "把上下文放到手边"];

export interface KnowledgeBaseRunProgressState {
  totalCells: number;
  filledCells: number;
  activeIndex: number;
}

export function knowledgeBaseRunProgressState(status: string | undefined, createdAt: number, now: number, phaseCount: number): KnowledgeBaseRunProgressState {
  const totalCells = KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT * Math.max(0, phaseCount - 1);
  if (status === "completed") {
    return { totalCells, filledCells: totalCells, activeIndex: -1 };
  }
  if (status !== "running") {
    return { totalCells, filledCells: 0, activeIndex: -1 };
  }
  const elapsedCells = Math.floor(Math.max(0, now - createdAt) / KNOWLEDGE_BASE_RUN_CELL_MS);
  const filledCells = Math.max(0, Math.min(Math.max(0, totalCells - 1), elapsedCells));
  const activeIndex = filledCells >= totalCells
    ? -1
    : Math.min(Math.floor(filledCells / KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT), phaseCount - 2);
  return { totalCells, filledCells, activeIndex };
}

export function knowledgeBaseRunProgressStateFromEvents(status: string | undefined, events: KnowledgeWorkflowEvent[], phaseCount: number): KnowledgeBaseRunProgressState | null {
  if (!events.length) return null;
  const totalCells = KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT * Math.max(0, phaseCount - 1);
  if (status === "completed" || events.some((event) => event.type === "workflow.completed" && event.status === "success")) {
    return { totalCells, filledCells: totalCells, activeIndex: -1 };
  }
  const phaseOrder: KnowledgeWorkflowPhaseId[] = ["prepare", "digest", "organize", "report", "complete"];
  const completed = new Set(events.filter((event) => event.type === "workflow.phase.completed" && event.phaseId).map((event) => event.phaseId as KnowledgeWorkflowPhaseId));
  const lastPhaseEvent = events.slice().reverse().find((event) => event.phaseId && (event.type === "workflow.phase.started" || event.type === "workflow.phase.progress" || event.type === "workflow.phase.failed"));
  const activePhase = lastPhaseEvent?.phaseId;
  const activeIndex = status === "running" && activePhase ? phaseOrder.indexOf(activePhase) : -1;
  const completedSegments = Math.min(
    Math.max(0, phaseCount - 1),
    phaseOrder.slice(0, Math.max(0, phaseCount - 1)).filter((phase) => completed.has(phase)).length
  );
  const progressEvent = activePhase
    ? events.slice().reverse().find((event) => event.phaseId === activePhase && event.type === "workflow.phase.progress" && typeof event.current === "number" && typeof event.total === "number" && event.total > 0)
    : undefined;
  const progressCells = progressEvent
    ? Math.floor(Math.max(0, Math.min(1, (progressEvent.current ?? 0) / (progressEvent.total ?? 1))) * KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT)
    : 0;
  return {
    totalCells,
    filledCells: Math.max(0, Math.min(totalCells, completedSegments * KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT + progressCells)),
    activeIndex
  };
}

export function messageListVirtualHeight(contentHeight: number, viewportHeight: number): number {
  return Math.max(Math.max(0, contentHeight) + MESSAGE_LIST_BOTTOM_SPACER_PX, Math.max(1, viewportHeight));
}

export function scrollTopForMessageListBottom(contentHeight: number, viewportHeight: number): number {
  return scrollTopForVirtualBottom(messageListVirtualHeight(contentHeight, viewportHeight), viewportHeight);
}

export function shouldPinMessageListBottom(options: MessageListRenderOptions, nearBottom: boolean): boolean {
  return Boolean(options.forceBottom) || (!options.fromScroll && !options.preserveScroll && nearBottom);
}

export class CodexMessageListRenderer {
  private virtualSessionId = "";
  private virtualRowHeights = new Map<string, number>();
  private viewportResizeObserver: ResizeObserver | null = null;
  private observedMessagesEl: HTMLElement | null = null;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private rawTextCache = new Map<string, string>();
  private openProcessItems = new Map<string, boolean>();
  private openActionItemDetails = new Map<string, boolean>();
  private openCompletedTurns = new Map<string, boolean>();
  private openKnowledgeBaseCitations = new Map<string, boolean>();
  private env: MessageListEnvironment | null = null;
  private virtualRerenderScheduled = false;
  private virtualRerenderBurst = 0;
  private virtualRerenderWindowStartedAt = 0;
  private virtualRerenderTrailingTimer: number | null = null;
  private virtualRerenderPendingForceBottom = false;
  private readonly processMessageBatcher = new LatestByKeyFrameBatcher<PendingProcessMessageUpdate>();
  private readonly answerMessageBatcher = new LatestByKeyFrameBatcher<PendingProcessMessageUpdate>();

  render(input: MessageListRenderInput): void {
    const env: MessageListEnvironment = { ...input, options: input.options ?? {} };
    this.env = env;
    const { messagesEl, virtualListEl, knowledgeSession, messages, hiddenKnowledgeMessageCount } = env;
    this.observeMessageViewport(messagesEl);
    if (this.virtualSessionId !== env.sessionId) {
      this.virtualSessionId = env.sessionId;
      this.virtualRowHeights.clear();
      this.cancelVirtualRerenderTrailing(true);
      this.resetVirtualRerenderThrottle();
    }
    const previousScrollTop = messagesEl.scrollTop;
    const shouldPinBottom = shouldPinMessageListBottom(env.options, this.isNearBottom(messagesEl, virtualListEl));
    virtualListEl.empty();
    if (messages.length === 0) {
      virtualListEl.setCssStyles({ height: "100%" });
      const welcome = virtualListEl.createDiv({ cls: "codex-welcome" });
      welcome.createDiv({ cls: "codex-welcome-title", text: knowledgeSession ? "知识库管理" : "What's new?" });
      if (knowledgeSession) {
        welcome.createDiv({
          cls: "codex-resource-note",
          text: hiddenKnowledgeMessageCount ? `当前页面已清空，隐藏 ${hiddenKnowledgeMessageCount} 条本地历史；输入 /history 查看。` : "输入 /help 查看命令；也可以直接说只体检一下、维护知识库、写周报、收集这个链接。"
        });
        if (hiddenKnowledgeMessageCount) {
          const historyButton = welcome.createEl("button", { cls: "codex-kb-history-inline-button", text: "查看历史", attr: { type: "button" } });
          historyButton.onclick = env.onOpenKnowledgeHistory;
        }
      } else {
        welcome.createDiv({ cls: "codex-resource-note", text: "普通会话需要先选择工作区；添加笔记只作为本轮上下文。" });
      }
      return;
    }

    const rows = this.buildVirtualRows(messages);
    const rowIds = rows.map((row) => row.id);
    this.pruneVirtualHeights(rowIds);
    const viewportHeight = Math.max(1, messagesEl.clientHeight);
    const virtual = calculateVirtualWindow({
      rowIds,
      rowHeights: this.virtualRowHeights,
      scrollTop: previousScrollTop,
      viewportHeight
    });
    virtualListEl.setCssStyles({ height: `${messageListVirtualHeight(virtual.totalHeight, viewportHeight)}px` });

    for (const virtualRow of virtual.rows) {
      const row = rows[virtualRow.index];
      if (!row) continue;
      const rowEl = virtualListEl.createDiv({ cls: `codex-virtual-row codex-virtual-row-${row.kind}` });
      rowEl.dataset.rowId = virtualRow.id;
      rowEl.dataset.index = String(virtualRow.index);
      rowEl.setCssStyles({ transform: `translateY(${virtualRow.top}px)` });
      this.renderVirtualRow(rowEl, row);
    }

    this.measureVisibleVirtualRows(messagesEl, virtualListEl, shouldPinBottom);
    if (shouldPinBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (env.options.fromScroll || env.options.preserveScroll) {
      messagesEl.scrollTop = previousScrollTop;
    }
  }

  measureVisibleVirtualRows(messagesEl: HTMLElement, virtualListEl: HTMLElement, forceBottom = false, options: { rerender?: boolean } = {}): boolean {
    if (messagesEl.clientHeight === 0) return false;
    if (forceBottom && (this.virtualRerenderScheduled || this.virtualRerenderTrailingTimer !== null)) {
      this.virtualRerenderPendingForceBottom = true;
    }
    let changed = false;
    for (const child of Array.from(virtualListEl.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const id = child.dataset.rowId;
      if (!id) continue;
      const measuredHeight = child.getBoundingClientRect().height;
      if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) continue;
      const height = Math.ceil(measuredHeight);
      if (this.virtualRowHeights.get(id) !== height) {
        this.virtualRowHeights.set(id, height);
        changed = true;
      }
    }
    if (changed && options.rerender !== false) this.scheduleMeasuredRowsRerender(forceBottom);
    if (!changed) {
      this.resetVirtualRerenderThrottle();
    }
    if (forceBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    return changed;
  }

  tryUpdateMessage(message: ChatMessage): boolean {
    const env = this.env;
    if (!env || message.rawRef || message.citations || message.itemType === "knowledgeBase") return false;
    const processMessage = isAgentProcessItemType(message.itemType);
    if (!processMessage && message.status !== "running") return false;
    const target = this.findRenderedMessageElement(message.id);
    const wrapper = target?.hasClass("codex-message") ? target : target?.closest<HTMLElement>(".codex-message");
    if (!wrapper) return false;
    const shouldPinBottom = env.shouldFollowBottom
      ? env.shouldFollowBottom()
      : this.isAtBottom(env.messagesEl, env.virtualListEl);
    if (processMessage) {
      const virtualRow = wrapper.closest<HTMLElement>(".codex-virtual-row");
      if (!isDirectProcessVirtualRow(virtualRow?.dataset.rowId, message)) return false;
      this.processMessageBatcher.enqueue(
        message.id,
        { message, sessionId: env.sessionId, shouldPinBottom },
        (callback) => window.requestAnimationFrame(callback),
        (updates) => this.flushProcessMessageUpdates(updates)
      );
      return true;
    }
    this.answerMessageBatcher.enqueue(
      message.id,
      { message, sessionId: env.sessionId, shouldPinBottom },
      (callback) => window.requestAnimationFrame(callback),
      (updates) => this.flushAnswerMessageUpdates(updates)
    );
    return true;
  }

  isNearBottom(messagesEl: HTMLElement, virtualListEl: HTMLElement): boolean {
    return isNearVirtualBottom(
      messagesEl.scrollTop,
      Math.max(1, messagesEl.clientHeight),
      Math.max(virtualListEl.scrollHeight, messagesEl.scrollHeight)
    );
  }

  isAtBottom(messagesEl: HTMLElement, virtualListEl: HTMLElement): boolean {
    return isNearVirtualBottom(
      messagesEl.scrollTop,
      Math.max(1, messagesEl.clientHeight),
      Math.max(virtualListEl.scrollHeight, messagesEl.scrollHeight),
      MESSAGE_LIST_BOTTOM_PIN_EPSILON_PX
    );
  }

  resetVirtualWindow(): void {
    this.virtualSessionId = "";
    this.virtualRowHeights.clear();
    this.cancelVirtualRerenderTrailing(true);
    this.resetVirtualRerenderThrottle();
  }

  dispose(): void {
    this.disconnectViewportObserver();
    this.env = null;
    this.resetVirtualWindow();
  }

  private requireEnv(): MessageListEnvironment {
    if (!this.env) throw new Error("Message list renderer has not been initialized");
    return this.env;
  }

  private observeMessageViewport(messagesEl: HTMLElement): void {
    if (this.observedMessagesEl === messagesEl && this.viewportResizeObserver) return;
    this.disconnectViewportObserver();
    this.observedMessagesEl = messagesEl;
    this.viewportWidth = Math.max(0, messagesEl.clientWidth);
    this.viewportHeight = Math.max(0, messagesEl.clientHeight);
    const ownerWindow = messagesEl.ownerDocument?.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
    const ResizeObserverCtor = ownerWindow?.ResizeObserver
      ?? (typeof globalThis.ResizeObserver === "function" ? globalThis.ResizeObserver : null);
    if (!ResizeObserverCtor) return;
    this.viewportResizeObserver = new ResizeObserverCtor(() => {
      if (this.observedMessagesEl !== messagesEl) return;
      const previousWidth = this.viewportWidth;
      const previousHeight = this.viewportHeight;
      const nextWidth = Math.max(0, messagesEl.clientWidth);
      const nextHeight = Math.max(0, messagesEl.clientHeight);
      this.viewportWidth = nextWidth;
      this.viewportHeight = nextHeight;
      if (nextHeight <= 0) return;
      const becameVisible = previousHeight <= 0;
      const widthChanged = nextWidth > 0 && nextWidth !== previousWidth;
      const heightChanged = nextHeight !== previousHeight;
      if (!becameVisible && !widthChanged && !heightChanged) return;
      if (becameVisible || widthChanged) {
        this.virtualRowHeights.clear();
        this.cancelVirtualRerenderTrailing(true);
        this.resetVirtualRerenderThrottle();
      }
      this.scheduleMeasuredRowsRerender(false);
    });
    this.viewportResizeObserver.observe(messagesEl);
  }

  private disconnectViewportObserver(): void {
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = null;
    this.observedMessagesEl = null;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
  }

  private resetVirtualRerenderThrottle(): void {
    this.virtualRerenderBurst = 0;
    this.virtualRerenderWindowStartedAt = 0;
  }

  private cancelVirtualRerenderTrailing(clearPendingForceBottom = false): void {
    if (this.virtualRerenderTrailingTimer !== null) {
      window.clearTimeout(this.virtualRerenderTrailingTimer);
      this.virtualRerenderTrailingTimer = null;
    }
    if (clearPendingForceBottom) this.virtualRerenderPendingForceBottom = false;
  }

  private findRenderedMessageElement(messageId: string): HTMLElement | null {
    const env = this.requireEnv();
    for (const element of Array.from(env.virtualListEl.querySelectorAll<HTMLElement>("[data-message-id]"))) {
      if (element.dataset.messageId === messageId) return element;
    }
    return null;
  }

  private flushProcessMessageUpdates(updates: PendingProcessMessageUpdate[]): void {
    const env = this.env;
    if (!env) return;
    let updated = false;
    let shouldPinBottom = false;
    for (const update of updates) {
      if (update.sessionId !== env.sessionId) continue;
      const target = this.findRenderedMessageElement(update.message.id);
      const wrapper = target?.hasClass("codex-message") ? target : target?.closest<HTMLElement>(".codex-message");
      const virtualRow = wrapper?.closest<HTMLElement>(".codex-virtual-row");
      if (!wrapper || !virtualRow) continue;
      if (!isDirectProcessVirtualRow(virtualRow.dataset.rowId, update.message)) continue;
      const showAgentHeader = Boolean(wrapper.querySelector(".codex-agent-header"));
      virtualRow.empty();
      if (isActionTimelineItem(update.message)) {
        this.renderActionStreamItem(virtualRow, update.message, showAgentHeader);
      } else {
        this.renderMessage(virtualRow, update.message, {
          showAgentHeader,
          showAgentFooter: false,
          processExpanded: true
        });
      }
      updated = true;
      shouldPinBottom = shouldPinBottom || update.shouldPinBottom;
    }
    if (updated) env.onScheduleMeasure(shouldPinBottom && (env.shouldFollowBottom?.() ?? true));
  }

  private flushAnswerMessageUpdates(updates: PendingProcessMessageUpdate[]): void {
    const env = this.env;
    if (!env) return;
    let updated = false;
    let shouldPinBottom = false;
    for (const update of updates) {
      if (update.sessionId !== env.sessionId) continue;
      const target = this.findRenderedMessageElement(update.message.id);
      const wrapper = target?.hasClass("codex-message") ? target : target?.closest<HTMLElement>(".codex-message");
      const virtualRow = wrapper?.closest<HTMLElement>(".codex-virtual-row");
      if (!wrapper || !virtualRow || virtualRow.dataset.rowId !== messageRowId(update.message)) continue;
      const content = wrapper.querySelector<HTMLElement>("[data-message-content]");
      if (!content) continue;
      wrapper.toggleClass("codex-message-streaming", update.message.status === "running");
      wrapper.toggleClass("codex-message-empty-running", update.message.status === "running" && !displayTextForMessage(update.message).trim());
      renderRichText(env.app, env.component, content, displayTextForMessage(update.message));
      updated = true;
      shouldPinBottom = shouldPinBottom || update.shouldPinBottom;
    }
    if (updated) env.onScheduleMeasure(shouldPinBottom && (env.shouldFollowBottom?.() ?? true));
  }

  private scheduleMeasuredRowsRerender(forceBottom: boolean): void {
    if (!this.env) return;
    this.virtualRerenderPendingForceBottom = this.virtualRerenderPendingForceBottom || forceBottom;
    if (this.virtualRerenderScheduled) return;
    const now = Date.now();
    if (!this.virtualRerenderWindowStartedAt || now - this.virtualRerenderWindowStartedAt > VIRTUAL_RERENDER_WINDOW_MS) {
      this.virtualRerenderWindowStartedAt = now;
      this.virtualRerenderBurst = 0;
    }
    if (this.virtualRerenderBurst >= VIRTUAL_RERENDER_BURST_LIMIT) {
      if (this.virtualRerenderTrailingTimer === null) {
        const remainingWindowMs = Math.max(
          0,
          this.virtualRerenderWindowStartedAt + VIRTUAL_RERENDER_WINDOW_MS - now
        );
        this.virtualRerenderTrailingTimer = window.setTimeout(() => {
          this.virtualRerenderTrailingTimer = null;
          this.resetVirtualRerenderThrottle();
          this.scheduleMeasuredRowsRerender(false);
        }, remainingWindowMs);
      }
      return;
    }
    this.cancelVirtualRerenderTrailing();
    this.virtualRerenderBurst += 1;
    this.virtualRerenderScheduled = true;
    window.requestAnimationFrame(() => {
      this.virtualRerenderScheduled = false;
      const effectiveForceBottom = this.virtualRerenderPendingForceBottom;
      this.virtualRerenderPendingForceBottom = false;
      const env = this.env;
      if (!env) return;
      const stillPinnedBottom = effectiveForceBottom && (env.shouldFollowBottom?.() ?? true) && isNearVirtualBottom(
        env.messagesEl.scrollTop,
        Math.max(1, env.messagesEl.clientHeight),
        Math.max(env.virtualListEl.scrollHeight, env.messagesEl.scrollHeight),
        MESSAGE_LIST_BOTTOM_PIN_EPSILON_PX
      );
      this.render({ ...env, options: { forceBottom: stillPinnedBottom, preserveScroll: !stillPinnedBottom } });
    });
  }

  private buildVirtualRows(messages: ChatMessage[]): MessageRenderRow[] {
    const rows: MessageRenderRow[] = [];
    const agentHeaderKeys = new Set<string>();
    const footerMessageIds = terminalAnswerFooterMessageIds(messages);
    for (const item of buildAgentTurnProjection(messages)) {
      if (item.kind === "completedProcess") {
        const completedTurn = item.turn;
        const headerKey = agentRunHeaderKey(completedTurn.processMessages[0] ?? completedTurn.finalAnswer);
        const showAgentHeader = !agentHeaderKeys.has(headerKey);
        if (showAgentHeader) agentHeaderKeys.add(headerKey);
        rows.push({ id: completedTurnRowId(completedTurn), kind: "turnProcess", turn: completedTurn, showAgentHeader });
        continue;
      }
      const message = item.message;
      if (isActionTimelineItem(message)) {
        const headerKey = agentRunHeaderKey(message);
        const showAgentHeader = !agentHeaderKeys.has(headerKey);
        if (showAgentHeader) agentHeaderKeys.add(headerKey);
        rows.push({ id: actionItemRowId(message), kind: "actionItem", message, showAgentHeader });
        continue;
      }
      const headerKey = agentRunHeaderKey(message);
      const showAgentHeader = isAgentHeaderCandidate(message) && !agentHeaderKeys.has(headerKey);
      if (showAgentHeader) agentHeaderKeys.add(headerKey);
      rows.push({
        id: messageRowId(message),
        kind: "message",
        message,
        showAgentHeader,
        showAgentFooter: footerMessageIds.has(message.id),
        processExpanded: isAgentProcessItemType(message.itemType)
      });
    }
    return rows;
  }

  private renderVirtualRow(container: HTMLElement, row: MessageRenderRow): void {
    if (row.kind === "turnProcess") {
      this.renderCompletedTurnProcess(container, row.turn, row.showAgentHeader);
      return;
    }
    if (row.kind === "actionItem") {
      this.renderActionStreamItem(container, row.message, row.showAgentHeader);
      return;
    }
    this.renderMessage(container, row.message, { showAgentHeader: row.showAgentHeader, showAgentFooter: row.showAgentFooter, processExpanded: row.processExpanded });
  }

  private renderMessage(container: HTMLElement, message: ChatMessage, options: { showAgentHeader: boolean; showAgentFooter: boolean; processExpanded?: boolean } = { showAgentHeader: false, showAgentFooter: false }): void {
    const env = this.requireEnv();
    const wrapper = container.createDiv({ cls: `codex-message codex-message-${message.role}` });
    wrapper.dataset.messageId = message.id;
    wrapper.toggleClass("codex-message-streaming", message.status === "running");
    wrapper.toggleClass(`codex-message-type-${message.itemType ?? "text"}`, true);
    const emptyRunningAnswer = isAgentAnswerMessage(message) && message.status === "running" && !displayTextForMessage(message).trim();
    wrapper.toggleClass("codex-message-empty-running", emptyRunningAnswer);
    wrapper.toggleClass("has-agent-header", options.showAgentHeader);
    const missingBackend = missingAgentCliBackend(message);
    if (missingBackend) {
      this.renderMissingAgentRecovery(wrapper, message, missingBackend);
      return;
    }
    if (options.showAgentHeader) this.renderAgentHeader(wrapper, {
      message,
      statusLabel: "",
      compact: false
    });
    if (!emptyRunningAnswer && shouldRenderMessageTitle(message, options.showAgentHeader)) {
      const title = wrapper.createDiv({ cls: "codex-message-title" });
      title.createSpan({ cls: "codex-message-title-label", text: message.title ?? "" });
      const time = messageTitleTime(message);
      if (time) {
        title.createSpan({
          cls: "codex-message-title-time",
          text: time,
          attr: { title: formatAbsoluteTime(message.createdAt) }
        });
      }
    }
    if (message.attachments?.length) {
      this.renderUserAttachmentChips(wrapper.createDiv({ cls: "codex-message-attachments" }), message.attachments);
    }
    if (message.images?.length) {
      const images = wrapper.createDiv({ cls: "codex-message-images" });
      for (const image of message.images) {
        const img = images.createEl("img", { attr: { alt: image.name } });
        img.src = toImageSrc(env.app, image.path);
        img.onload = () => env.onScheduleMeasure();
        img.onclick = () => openImageOverlay(img.src);
      }
    }
    const content = wrapper.createDiv({ cls: "codex-message-content" });
    content.dataset.messageContent = "true";
    if (message.itemType === "thinking") {
      this.renderThinkingMessage(content, message);
      return;
    }
    if (message.itemType === "reasoning") {
      content.addClass("codex-inline-reasoning");
      renderRichText(env.app, env.component, content, displayTextForMessage(message));
      return;
    }
    if (isProcessItemType(message.itemType)) {
      this.renderProcessMessage(content, message, false, options.processExpanded === true);
      return;
    }
    const displayText = displayTextForMessage(message);
    if (!this.renderKnowledgeBaseResultContent(content, message, displayText)) {
      renderRichText(env.app, env.component, content, displayText);
    }
    if (message.rawRef) this.renderRawMessageExpander(content, message);
    if (message.itemType === "knowledgeBase" && message.details) this.renderKnowledgeBaseContextNote(wrapper, message.details);
    if (message.citations) this.renderKnowledgeBaseCitations(wrapper, message.id, message.citations);
    if (options.showAgentFooter) this.renderAgentFooter(wrapper, message);
  }

  private renderMissingAgentRecovery(container: HTMLElement, message: ChatMessage, backend: AgentBackendMode): void {
    const env = this.requireEnv();
    const copy = agentRecoveryCopy(env.settingsLanguage, backend);
    container.addClass("codex-cli-recovery");
    const mark = container.createSpan({ cls: "codex-cli-recovery-icon", attr: { "aria-hidden": "true" } });
    setIcon(mark, "terminal");
    const body = container.createDiv({ cls: "codex-cli-recovery-body" });
    body.createDiv({ cls: "codex-cli-recovery-title", text: copy.title });
    body.createDiv({ cls: "codex-cli-recovery-detail", text: copy.detail });
    const actions = body.createDiv({ cls: "codex-cli-recovery-actions" });
    const repair = actions.createEl("button", { cls: "codex-cli-recovery-primary", text: copy.repair, attr: { type: "button" } });
    repair.onclick = () => env.onAutoRepairAgent(backend);
    const settings = actions.createEl("button", { cls: "codex-cli-recovery-secondary", text: copy.settings, attr: { type: "button" } });
    settings.onclick = () => env.onOpenAgentSettings(backend);
    const diagnostic = body.createEl("details", { cls: "codex-cli-recovery-diagnostic" });
    diagnostic.createEl("summary", { text: copy.diagnostic });
    diagnostic.createEl("pre", {
      text: [message.title, displayTextForMessage(message), message.details].filter(Boolean).join("\n\n")
    });
  }

  private renderAgentHeader(container: HTMLElement, input: { message?: ChatMessage; statusLabel: string; compact: boolean }): void {
    const header = container.createDiv({ cls: "codex-agent-header" });
    header.toggleClass("is-compact", input.compact);
    const avatar = header.createSpan({ cls: "codex-agent-avatar", attr: { "aria-hidden": "true" } });
    setIcon(avatar, "bot");
    const main = header.createDiv({ cls: "codex-agent-header-main" });
    const nameRow = main.createDiv({ cls: "codex-agent-name-row" });
    nameRow.createSpan({ cls: "codex-agent-name", text: "EchoInk" });
    const agent = input.message ? agentModelLine(input.message) : "";
    if (agent) nameRow.createSpan({ cls: "codex-agent-model-pill", text: `· ${agent}` });
    if (input.statusLabel) main.createDiv({ cls: "codex-agent-status-line", text: input.statusLabel });
  }

  private renderAgentFooter(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const items = agentFooterItems(message);
    const footer = container.createDiv({ cls: "codex-agent-footer" });
    const meta = footer.createDiv({ cls: "codex-agent-footer-meta" });
    for (const item of items) meta.createSpan({ cls: "codex-agent-footer-item", text: item });
    const copyButton = footer.createEl("button", {
      cls: "codex-answer-copy",
      attr: { type: "button", title: "复制回答", "aria-label": "复制回答" }
    });
    setIcon(copyButton, "copy");
    copyButton.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (copyButton.disabled) return;
      copyButton.disabled = true;
      const result = await copyAnswerMarkdown(message, env.readRawMessageText, (text) => navigator.clipboard.writeText(text));
      copyButton.empty();
      if (result.status === "success") {
        setIcon(copyButton, "check");
        copyButton.createSpan({ text: "已复制" });
        copyButton.setAttr("title", "已复制");
        copyButton.setAttr("aria-label", "回答已复制");
      } else {
        setIcon(copyButton, "triangle-alert");
        copyButton.createSpan({ text: "复制失败" });
        copyButton.setAttr("title", "复制失败");
        copyButton.setAttr("aria-label", "回答复制失败");
        new Notice(`复制失败：${result.error instanceof Error ? result.error.message : String(result.error)}`);
      }
      window.setTimeout(() => {
        copyButton.empty();
        setIcon(copyButton, "copy");
        copyButton.setAttr("title", "复制回答");
        copyButton.setAttr("aria-label", "复制回答");
        copyButton.disabled = false;
      }, 1400);
    };
  }

  private renderKnowledgeBaseResultContent(container: HTMLElement, message: ChatMessage, text: string): boolean {
    const env = this.requireEnv();
    if (message.itemType === "knowledgeBase" && message.knowledgeBaseUi) {
      this.renderKnowledgeBaseUiPayload(container, message.knowledgeBaseUi, message);
      return true;
    }
    const result = extractKnowledgeBaseResultTitle(message.itemType, text);
    if (!result) return false;
    const title = container.createDiv({ cls: `codex-kb-result-title codex-kb-result-title-${result.status}` });
    const icon = title.createSpan({ cls: "codex-kb-result-title-icon" });
    setIcon(icon, result.status === "success" ? "badge-check" : result.status === "canceled" ? "circle-slash" : "triangle-alert");
    title.createSpan({ cls: "codex-kb-result-title-text", text: result.title });
    if (result.body.trim()) renderRichText(env.app, env.component, container.createDiv({ cls: "codex-kb-result-body" }), result.body);
    return true;
  }

  private renderKnowledgeBaseUiPayload(container: HTMLElement, payload: KnowledgeBaseMessageUiPayload, message: ChatMessage): void {
    if (payload.kind === "maintain-run") {
      this.renderKnowledgeBaseRunCard(container, payload, message);
      return;
    }
    this.renderKnowledgeBaseMaintainReportCard(container, payload);
  }

  private renderKnowledgeBaseRunCard(container: HTMLElement, payload: KnowledgeBaseRunPayload, message: ChatMessage): void {
    const card = container.createDiv({ cls: `codex-kb-run-card codex-kb-run-card-${message.status ?? "running"}` });
    const head = card.createDiv({ cls: "codex-kb-run-head" });
    const mark = head.createSpan({ cls: "codex-kb-run-mark" });
    setIcon(mark, payload.icon);
    const text = head.createDiv({ cls: "codex-kb-run-copy" });
    text.createDiv({ cls: "codex-kb-run-title", text: knowledgeBaseRunDisplayTitle(payload, message.status) });
    const track = card.createDiv({ cls: "codex-kb-run-track" });
    const cellsPerSegment = KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT;
    const eventProgress = knowledgeBaseRunProgressStateFromEvents(message.status, payload.events ?? [], payload.phases.length);
    const { totalCells, filledCells, activeIndex } = eventProgress ?? {
      totalCells: KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT * Math.max(0, payload.phases.length - 1),
      filledCells: message.status === "completed" ? KNOWLEDGE_BASE_RUN_CELLS_PER_SEGMENT * Math.max(0, payload.phases.length - 1) : 0,
      activeIndex: -1
    };
    payload.phases.forEach((phase, index) => {
      const node = track.createDiv({ cls: `codex-kb-run-node codex-kb-run-node-${phase.id} codex-kb-run-motion-${phase.motion}` });
      node.toggleClass("is-done", filledCells >= totalCells || index < activeIndex);
      node.toggleClass("is-active", index === activeIndex);
      const icon = node.createSpan({ cls: "codex-kb-run-node-icon" });
      setIcon(icon, phase.icon);
      node.createSpan({ cls: "codex-kb-run-node-label", text: phase.label });
      if (index >= payload.phases.length - 1) return;
      const segment = track.createDiv({ cls: "codex-kb-run-segment" });
      segment.toggleClass("is-active", index === activeIndex);
      segment.toggleClass("is-done", filledCells >= (index + 1) * cellsPerSegment);
      for (let cellIndex = 0; cellIndex < cellsPerSegment; cellIndex += 1) {
        const absoluteIndex = index * cellsPerSegment + cellIndex;
        segment.createSpan({ cls: `codex-kb-run-cell ${absoluteIndex < filledCells ? "is-filled" : ""} ${absoluteIndex === filledCells ? "is-next" : ""}`.trim() });
      }
    });
  }

  private renderKnowledgeBaseMaintainReportCard(container: HTMLElement, payload: KnowledgeBaseMaintainReportPayload): void {
    const card = container.createDiv({ cls: `codex-kb-maintain-card codex-kb-maintain-card-${payload.status}` });
    const header = card.createDiv({ cls: "codex-kb-maintain-header" });
    const icon = header.createSpan({ cls: "codex-kb-maintain-icon" });
    setIcon(icon, payload.status === "success" ? "badge-check" : payload.status === "canceled" ? "circle-slash" : "triangle-alert");
    const title = header.createDiv({ cls: "codex-kb-maintain-title" });
    title.createDiv({ cls: "codex-kb-maintain-title-text", text: payload.title });
    if (payload.reportPath) title.createDiv({ cls: "codex-kb-maintain-report-path", text: payload.reportPath });
    if (payload.reportPath) {
      const open = header.createEl("button", { cls: "codex-kb-maintain-open", attr: { type: "button", title: payload.reportPath } });
      setIcon(open.createSpan({ cls: "codex-kb-maintain-open-icon" }), "external-link");
      open.createSpan({ text: "打开报告" });
      open.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openKnowledgeBaseReport(payload.reportPath);
      };
    }
    const care = card.createDiv({ cls: "codex-kb-maintain-care" });
    care.createDiv({ cls: "codex-kb-maintain-section-title", text: "我应该关心" });
    const careList = care.createDiv({ cls: "codex-kb-maintain-care-list" });
    for (const item of payload.careItems) {
      const row = careList.createDiv({ cls: `codex-kb-maintain-care-item codex-kb-maintain-care-${item.tone}` });
      const bullet = row.createSpan({ cls: "codex-kb-maintain-care-icon" });
      setIcon(bullet, item.tone === "warning" ? "triangle-alert" : item.tone === "info" ? "info" : "check");
      row.createSpan({ cls: "codex-kb-maintain-care-text", text: item.text });
    }
    const sections = card.createDiv({ cls: "codex-kb-maintain-sections" });
    const firstOpenSection = payload.sections.find((section) => section.count > 0)?.id;
    for (const section of payload.sections) {
      const details = sections.createEl("details", { cls: "codex-kb-maintain-section" });
      details.open = section.id === firstOpenSection;
      details.ontoggle = () => this.requireEnv().onScheduleMeasure();
      const summary = details.createEl("summary", { cls: "codex-kb-maintain-section-summary" });
      summary.createSpan({ cls: "codex-kb-maintain-section-name", text: section.title });
      summary.createSpan({ cls: "codex-kb-maintain-section-count", text: String(section.count) });
      const body = details.createDiv({ cls: "codex-kb-maintain-section-body" });
      if (!section.items.length) {
        body.createDiv({ cls: "codex-kb-maintain-empty", text: section.emptyText });
        continue;
      }
      for (const item of section.items) {
        const row = body.createDiv({ cls: `codex-kb-maintain-detail codex-kb-maintain-detail-${item.tone ?? "info"}` });
        row.createDiv({ cls: "codex-kb-maintain-detail-title", text: item.title });
        row.createDiv({ cls: "codex-kb-maintain-detail-desc", text: item.description });
      }
    }
  }

  private async openKnowledgeBaseReport(reportPath: string): Promise<void> {
    const env = this.requireEnv();
    const normalized = normalizePath(reportPath);
    const file = env.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await env.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    const absolute = `${env.vaultPath.replace(/\/$/, "")}/${normalized}`;
    if (showItemInFinder(absolute)) return;
    new Notice(`没有在当前 Obsidian 仓库找到：${reportPath}`);
  }

  private renderKnowledgeBaseContextNote(container: HTMLElement, details: string): void {
    const normalized = details.trim();
    if (!normalized) return;
    const note = container.createDiv({ cls: "codex-kb-context-note" });
    const icon = note.createSpan({ cls: "codex-kb-context-note-icon" });
    setIcon(icon, "message-square-share");
    note.createSpan({ cls: "codex-kb-context-note-text", text: normalized });
  }

  private renderKnowledgeBaseCitations(container: HTMLElement, messageId: string, citations: KnowledgeBaseCitationSummary): void {
    const stateKey = `kb-citations:${messageId}`;
    const details = container.createEl("details", { cls: `codex-kb-citations codex-kb-citations-${citations.status}` });
    details.open = this.openKnowledgeBaseCitations.get(stateKey) ?? false;
    details.ontoggle = () => {
      this.openKnowledgeBaseCitations.set(stateKey, details.open);
      this.requireEnv().onScheduleMeasure();
    };
    const summary = details.createEl("summary", { cls: "codex-kb-citations-summary" });
    summary.createSpan({ cls: "codex-kb-citations-title", text: "本次来源" });
    const buckets = summary.createSpan({ cls: "codex-kb-citation-buckets" });
    for (const bucket of ["wiki", "journal", "outputs"] as KnowledgeBaseCitationBucket[]) {
      buckets.createSpan({ cls: `codex-kb-source-count codex-kb-source-${bucket}`, text: `${kbBucketLabel(bucket)} ${citations.counts[bucket] ?? 0}` });
    }
    summary.createSpan({ cls: `codex-kb-evidence-status codex-kb-evidence-${citations.status}`, text: kbEvidenceStatusLabel(citations.status) });

    const body = details.createDiv({ cls: "codex-kb-citations-body" });
    if (!citations.citations.length) {
      body.createDiv({ cls: "codex-kb-no-evidence", text: "没有命中文件，也没有引用片段；不会显示伪来源。" });
      return;
    }
    for (const citation of citations.citations) this.renderKnowledgeBaseCitationItem(body, citation);
  }

  private renderKnowledgeBaseCitationItem(container: HTMLElement, citation: KnowledgeBaseCitation): void {
    const item = container.createDiv({ cls: `codex-kb-citation-item codex-kb-citation-${citation.bucket}` });
    const header = item.createDiv({ cls: "codex-kb-citation-header" });
    header.createSpan({ cls: `codex-kb-citation-badge codex-kb-source-${citation.bucket}`, text: kbBucketLabel(citation.bucket) });
    const title = header.createEl("button", {
      cls: "codex-kb-citation-title",
      text: citation.title || citation.path,
      attr: {
        type: "button",
        title: `打开 ${citation.path}`
      }
    });
    title.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openKnowledgeBaseCitation(citation);
    };
    header.createSpan({ cls: `codex-kb-citation-relevance codex-kb-evidence-${citation.relevance}`, text: citation.relevance === "strong" ? "强证据" : "弱相关" });
    const open = header.createEl("button", {
      cls: "codex-kb-citation-open",
      text: "打开",
      attr: {
        type: "button",
        title: citation.path
      }
    });
    open.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openKnowledgeBaseCitation(citation);
    };
    item.createDiv({ cls: "codex-kb-citation-path", text: citation.path });
    const quote = item.createDiv({ cls: "codex-kb-citation-quote" });
    for (const line of citation.excerptLines.length ? citation.excerptLines : ["无可用引用片段"]) {
      quote.createDiv({ cls: "codex-kb-citation-line", text: line });
    }
    item.createDiv({ cls: "codex-kb-citation-reason", text: `为什么相关：${citation.reason}` });
  }

  private async openKnowledgeBaseCitation(citation: KnowledgeBaseCitation): Promise<void> {
    const env = this.requireEnv();
    const normalized = normalizePath(citation.path);
    const file = env.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await env.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    const absolute = `${env.vaultPath.replace(/\/$/, "")}/${normalized}`;
    if (showItemInFinder(absolute)) return;
    new Notice(`没有在当前 Obsidian 仓库找到：${citation.path}`);
  }

  private renderActionStreamItem(container: HTMLElement, message: ChatMessage, showAgentHeader: boolean): void {
    const timeline = buildActionTimeline([message]);
    const item = timeline.groups[0]?.items[0];
    if (!item) return;
    const wrapper = container.createDiv({ cls: "codex-message codex-message-tool codex-message-type-actionStream" });
    wrapper.dataset.messageId = message.id;
    if (showAgentHeader) this.renderAgentHeader(wrapper, {
      message,
      statusLabel: "",
      compact: true
    });
    const region = wrapper.createDiv({ cls: "codex-action-region codex-action-stream" });
    this.renderActionItem(region, item, { standalone: false });
  }

  private renderCompletedTurnProcess(container: HTMLElement, turn: CompletedAgentTurn, showAgentHeader: boolean): void {
    const stateId = `${turn.key}:${turn.finalAnswer.id}`;
    const open = this.openCompletedTurns.get(stateId) ?? (turn.failed || turn.requiresAttention);
    const wrapper = container.createDiv({ cls: "codex-message codex-message-tool codex-message-type-turnProcess" });
    if (showAgentHeader) this.renderAgentHeader(wrapper, { message: turn.finalAnswer, statusLabel: "", compact: true });
    const region = wrapper.createDiv({ cls: "codex-turn-process" });
    const bodyId = stableDomId(`codex-turn-process-${stateId}`);
    const summary = region.createEl("button", {
      cls: "codex-turn-process-summary",
      attr: {
        type: "button",
        "aria-controls": bodyId,
        "aria-expanded": String(open)
      }
    });
    summary.createSpan({ cls: "codex-turn-process-title", text: formatAgentTurnDuration(turn.durationMs) });
    const caret = summary.createSpan({ cls: "codex-turn-process-caret" });
    setIcon(caret, open ? "chevron-down" : "chevron-right");
    summary.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openCompletedTurns.set(stateId, !open);
      this.requireEnv().onScheduleMeasure();
      this.rerenderPreservingScroll();
    };
    if (!open) return;
    const body = region.createDiv({ cls: "codex-turn-process-body", attr: { id: bodyId } });
    for (const message of turn.processMessages) this.renderTurnProcessMessage(body, message);
  }

  private renderTurnProcessMessage(container: HTMLElement, message: ChatMessage): void {
    if (isActionTimelineItem(message)) {
      const item = buildActionTimeline([message]).groups[0]?.items[0];
      if (item) this.renderActionItem(container.createDiv({ cls: "codex-action-region codex-action-stream" }), item, { standalone: false });
      return;
    }
    this.renderMessage(container, message, { showAgentHeader: false, showAgentFooter: false, processExpanded: true });
  }

  private renderActionItem(container: HTMLElement, item: ActionItemViewModel, options: { standalone: boolean }): void {
    if (hasActionItemDetails(item)) {
      this.renderExpandableActionItem(container, item, options);
      return;
    }
    const row = container.createDiv({ cls: `codex-action-item codex-action-item-${item.kind}` });
    row.toggleClass("is-standalone", options.standalone);
    row.toggleClass("is-failed", item.status === "failed");
    row.toggleClass("is-running", item.status === "running");
    const head = row.createDiv({ cls: "codex-action-item-head" });
    this.renderActionItemHead(head, item);
  }

  private renderExpandableActionItem(container: HTMLElement, item: ActionItemViewModel, options: { standalone: boolean }): void {
    const detailId = stableDomId(`codex-action-detail-${item.id}`);
    const details = container.createEl("details", { cls: `codex-action-item codex-action-item-${item.kind} codex-action-item-expandable` });
    details.toggleClass("is-standalone", options.standalone);
    details.toggleClass("is-failed", item.status === "failed");
    details.toggleClass("is-running", item.status === "running");
    details.open = this.openActionItemDetails.get(item.id) ?? (item.status === "failed" && item.kind !== "edit");
    let summary: HTMLElement | null = null;
    let caret: HTMLElement | null = null;
    let body: HTMLElement | null = null;
    const renderBody = () => {
      if (body) return;
      body = details.createDiv({ cls: "codex-action-item-details-body", attr: { id: detailId } });
      this.renderProcessBody(body, item.source);
    };
    details.ontoggle = () => {
      rememberOpenState(this.openActionItemDetails, item.id, details.open);
      if (details.open) renderBody();
      if (summary) summary.setAttr("aria-expanded", String(details.open));
      if (caret) {
        caret.empty();
        setIcon(caret, details.open ? "chevron-up" : "chevron-down");
      }
      this.requireEnv().onScheduleMeasure();
    };
    summary = details.createEl("summary", {
      cls: "codex-action-item-head",
      attr: {
        "aria-controls": detailId,
        "aria-expanded": String(details.open),
        title: actionItemDetailLabel(item)
      }
    });
    this.renderActionItemHead(summary, item);
    caret = summary.createSpan({ cls: "codex-action-item-caret" });
    setIcon(caret, details.open ? "chevron-up" : "chevron-down");
    if (details.open) renderBody();
  }

  private renderActionItemHead(head: HTMLElement, item: ActionItemViewModel): void {
    const icon = head.createSpan({ cls: "codex-action-item-icon" });
    setIcon(icon, iconForActionKind(item.kind, item.status));
    const main = head.createDiv({ cls: "codex-action-item-main" });
    this.renderActionItemTitle(main, item);
    const meta = actionItemMeta(item);
    if (meta) main.createSpan({ cls: "codex-action-item-detail", text: meta });
    this.renderActionItemStats(head, item);
    const time = formatMessageHeaderTime(item.createdAt);
    if (time) head.createSpan({ cls: "codex-action-item-time", text: time });
  }

  private renderActionItemTitle(container: HTMLElement, item: ActionItemViewModel): void {
    const prefix = actionVerb(item);
    if (item.kind === "edit" && item.source.diffSummary?.files.length) {
      const file = item.source.diffSummary.files[0];
      container.createSpan({ cls: "codex-action-item-prefix", text: `${prefix} ` });
      const ref = findProcessFileRef(item.source.files ?? [], file.path) ?? normalizeProcessFileRef(file.path, this.requireEnv().vaultPath);
      this.renderProcessFileTextLink(container, ref, basename(file.path), "codex-action-item-file");
      if (item.source.diffSummary.files.length > 1) container.createSpan({ cls: "codex-action-item-extra", text: ` 等 ${item.source.diffSummary.files.length} 个文件` });
      return;
    }
    if (item.file) {
      container.createSpan({ cls: "codex-action-item-prefix", text: `${prefix} ` });
      this.renderProcessFileTextLink(container, item.file, item.file.name || item.file.displayPath, "codex-action-item-file");
      return;
    }
    container.createSpan({ cls: "codex-action-item-prefix", text: `${prefix} ` });
    container.createSpan({ cls: "codex-action-item-title", text: actionItemTarget(item) || item.title });
  }

  private renderActionItemStats(container: HTMLElement, item: ActionItemViewModel): void {
    if (!item.diff || (item.diff.added === undefined && item.diff.removed === undefined)) return;
    const stats = container.createSpan({ cls: "codex-action-diff-stats" });
    if (typeof item.diff.added === "number") stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${item.diff.added}` });
    if (typeof item.diff.removed === "number") stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${item.diff.removed}` });
  }

  private rerenderPreservingScroll(): void {
    const env = this.env;
    if (!env) return;
    this.render({ ...env, options: { ...env.options, preserveScroll: true } });
  }

  private renderUserAttachmentChips(container: HTMLElement, attachments: StoredAttachment[]): void {
    for (const attachment of attachments) {
      const chip = container.createEl("button", {
        cls: `codex-message-attachment-chip codex-message-attachment-${attachment.type}`,
        attr: {
          type: "button",
          title: attachment.path,
          "aria-label": `打开附件 ${attachment.name}`
        }
      });
      const icon = chip.createSpan({ cls: "codex-message-attachment-icon" });
      setIcon(icon, attachment.type === "image" ? "image" : "file-text");
      chip.createSpan({ cls: "codex-message-attachment-name", text: attachment.name });
      chip.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openAttachment(attachment);
      };
    }
  }

  private async openAttachment(attachment: StoredAttachment): Promise<void> {
    const env = this.requireEnv();
    if (attachment.type === "image") {
      openImageOverlay(toImageSrc(env.app, attachment.path));
      return;
    }
    const ref = normalizeProcessFileRef(attachment.path, env.vaultPath);
    await this.openProcessFile(ref);
  }

  private renderThinkingMessage(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const shell = container.createDiv({ cls: "codex-thinking-shell" });
    if (message.status === "running") {
      const row = shell.createDiv({ cls: "codex-thinking-live" });
      row.createSpan({ cls: "codex-thinking-dot" });
      row.createSpan({ text: COLD_START_STATUS_TEXT });
      row.createSpan({ cls: "codex-agent-live-copy", text: ` · ${rotatingChoice(COLD_START_COPY_TEXTS, message.createdAt)}` });
      env.onScheduleRunProgress();
      return;
    }
    shell.createEl("em", { cls: "codex-response-footer", text: message.text || "思考完成" });
  }

  private renderProcessMessage(container: HTMLElement, message: ChatMessage, nested = false, forceOpen = false): void {
    const details = container.createEl("details", { cls: `codex-structured codex-process codex-process-${message.itemType ?? "item"}` });
    details.toggleClass("is-running", message.status === "running");
    details.toggleClass("is-completed", message.status === "completed");
    details.toggleClass("is-error", message.status === "error" || message.status === "failed");
    details.toggleClass("is-nested", nested);
    if (message.processKind) details.toggleClass(`codex-process-kind-${message.processKind}`, true);
    const defaultOpen = forceOpen || (!nested && (message.itemType === "plan" || message.status === "error" || message.status === "failed"));
    details.open = forceOpen ? true : this.openProcessItems.get(message.id) ?? defaultOpen;
    let body: HTMLElement | null = null;
    const renderBody = () => {
      if (body) return;
      body = details.createDiv({ cls: "codex-structured-body codex-process-body" });
      this.renderProcessBody(body, message);
    };
    details.ontoggle = () => {
      rememberOpenState(this.openProcessItems, message.id, details.open);
      if (details.open) renderBody();
      this.requireEnv().onScheduleMeasure();
    };
    const summary = details.createEl("summary", { cls: "codex-process-summary" });
    const icon = summary.createSpan({ cls: "codex-structured-icon codex-process-icon" });
    setIcon(icon, iconForProcessMessage(message));
    const main = summary.createDiv({ cls: "codex-process-main" });
    if (message.itemType === "fileChange" && message.diffSummary?.files.length) {
      this.renderProcessEditSummary(main, message);
    } else {
      main.createSpan({ cls: "codex-structured-title codex-process-title", text: titleForItemType(message) });
      if (message.itemType === "fileChange" && message.diffSummary) this.renderDiffStats(main, message.diffSummary);
      if (message.details) main.createDiv({ cls: "codex-process-detail", text: message.details });
      if (message.itemType === "fileChange" && message.files?.length) this.renderProcessFileChips(main.createDiv({ cls: "codex-process-files" }), message.files);
    }
    if (message.status) summary.createSpan({ cls: "codex-structured-status", text: labelForStatus(message.status) });
    if (details.open) renderBody();
  }

  private renderProcessBody(body: HTMLElement, message: ChatMessage): void {
    const hasExplicitChannels = hasExplicitProcessChannels(message);
    const env = this.requireEnv();
    if (!hasExplicitChannels && message.processContentAvailability === "unavailable") {
      body.createDiv({ cls: "codex-process-raw-loading", text: PROCESS_CONTENT_UNAVAILABLE_TEXT });
      return;
    }
    const fallback = message.status === "running" ? "正在接收过程内容..." : "暂无内容";
    if (message.itemType === "commandExecution") {
      if (hasExplicitChannels) this.renderProcessChannels(body, message);
      else this.renderCommandExecutionBody(body, message, fallback);
      return;
    }
    if (message.itemType === "fileChange" && message.diffSummary) {
      if (hasExplicitChannels) this.renderProcessChannels(body, message);
      const diffBody = hasExplicitChannels
        ? body.createDiv({ cls: "codex-process-channel codex-process-channel-diff" })
        : body;
      this.renderFileChangeBody(diffBody, message, fallback);
      return;
    }
    if (hasExplicitChannels) {
      this.renderProcessChannels(body, message);
      return;
    }
    const rawLike = message.itemType === "commandExecution" || message.itemType === "fileChange" || message.itemType === "mcpToolCall" || message.itemType === "dynamicToolCall" || message.itemType === "collabAgentToolCall";
    if (rawLike) body.createDiv({ cls: "codex-process-raw-title", text: this.rawMetaLabel(message) });
    if (message.rawRef) {
      this.renderDeferredRawText(body, message, fallback);
      return;
    }
    const text = displayTextForMessage(message) || fallback;
    if (rawLike || isLargeRawMessage(message)) {
      this.renderPlainTextBlock(body, text);
      return;
    }
    renderRichText(env.app, env.component, body, text);
  }

  private renderProcessChannels(body: HTMLElement, message: ChatMessage): void {
    this.renderProcessChannel(body, "输入", message.processInputAvailability, message.processInput);
    this.renderProcessChannel(body, "输出", message.processOutputAvailability, message.processOutput);
  }

  private renderProcessChannel(
    body: HTMLElement,
    label: string,
    availability: ChatMessage["processInputAvailability"],
    text: string | undefined
  ): void {
    if (!availability) return;
    const channel = body.createDiv({ cls: "codex-process-channel" });
    channel.createDiv({ cls: "codex-process-raw-title", text: label });
    if (availability === "unavailable") {
      channel.createDiv({ cls: "codex-process-raw-loading", text: PROCESS_CONTENT_UNAVAILABLE_TEXT });
      return;
    }
    if (availability === "empty") {
      channel.createDiv({ cls: "codex-process-raw-loading", text: "后端返回空内容" });
      return;
    }
    this.renderPlainTextBlock(channel, text?.trim() ? text : PROCESS_CONTENT_UNAVAILABLE_TEXT);
  }

  private renderFileChangeBody(body: HTMLElement, message: ChatMessage, fallback: string): void {
    const renderDiff = (text: string) => {
      body.empty();
      const files = parseFileChangeDiff(text || fallback, message.diffSummary);
      if (!files.length) {
        this.renderPlainTextBlock(body, text || fallback);
        return;
      }
      if (message.diffSummary) this.renderDiffOverview(body, message.diffSummary);
      this.renderDiffFiles(body, files, message.files ?? []);
    };
    if (message.rawRef) {
      body.createDiv({ cls: "codex-process-raw-loading", text: "正在加载文件改动..." });
      void this.loadRawText(message)
        .then((text) => {
          renderDiff(text);
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({ cls: "codex-process-raw-loading", text: `文件改动加载失败：${error instanceof Error ? error.message : String(error)}` });
          this.renderPlainTextBlock(body, displayTextForMessage(message) || fallback);
          this.requireEnv().onScheduleMeasure();
        });
      return;
    }
    renderDiff(displayTextForMessage(message) || fallback);
  }

  private renderCommandExecutionBody(body: HTMLElement, message: ChatMessage, fallback: string): void {
    const renderShell = (text: string) => {
      body.empty();
      const shell = body.createDiv({ cls: "codex-shell-block" });
      shell.createDiv({ cls: "codex-shell-label", text: "Shell" });
      shell.createEl("pre", { cls: "codex-shell-output", text: shellTranscript(text || fallback) });
    };
    if (message.rawRef) {
      body.createDiv({ cls: "codex-process-raw-loading", text: "正在加载命令输出..." });
      void this.loadRawText(message)
        .then((text) => {
          renderShell(text);
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({ cls: "codex-process-raw-loading", text: `命令输出加载失败：${error instanceof Error ? error.message : String(error)}` });
          renderShell(displayTextForMessage(message) || fallback);
          this.requireEnv().onScheduleMeasure();
        });
      return;
    }
    renderShell(displayTextForMessage(message) || fallback);
  }

  private renderDiffOverview(container: HTMLElement, summary: DiffSummary): void {
    const row = container.createDiv({ cls: "codex-diff-overview" });
    row.createSpan({ cls: "codex-diff-overview-title", text: diffSummaryLabel(summary) });
    this.renderDiffStats(row, summary);
  }

  private renderDiffStats(container: HTMLElement, summary: DiffSummary): void {
    const stats = container.createSpan({ cls: "codex-diff-stats" });
    stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${summary.added}` });
    stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${summary.removed}` });
  }

  private renderDiffFiles(container: HTMLElement, files: ParsedDiffFile[], refs: ProcessFileRef[]): void {
    const list = container.createDiv({ cls: "codex-diff-files" });
    if (files.length === 1) {
      this.renderDiffFileBody(list, files[0]);
      return;
    }
    files.forEach((file, index) => {
      const details = list.createEl("details", { cls: "codex-diff-file" });
      details.open = files.length === 1 || index === 0;
      let rendered = false;
      const renderRows = () => {
        if (rendered) return;
        rendered = true;
        this.renderDiffFileBody(details, file);
      };
      details.ontoggle = () => {
        if (details.open) renderRows();
        this.requireEnv().onScheduleMeasure();
      };
      const summary = details.createEl("summary", { cls: "codex-diff-file-summary" });
      const main = summary.createSpan({ cls: "codex-diff-file-main" });
      const ref = findProcessFileRef(refs, file.path);
      if (ref) {
        this.renderProcessFileTextLink(main, ref, file.path, "codex-diff-file-path");
      } else {
        main.createSpan({ cls: "codex-diff-file-path", text: file.path });
      }
      if (file.previousPath) main.createSpan({ cls: "codex-diff-file-previous", text: `原路径 ${file.previousPath}` });
      summary.createSpan({ cls: "codex-diff-file-kind", text: labelForDiffKind(file.kind) });
      const stats = summary.createSpan({ cls: "codex-diff-file-stats" });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${file.added}` });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${file.removed}` });
      if (details.open) renderRows();
    });
  }

  private renderDiffFileBody(container: HTMLElement, file: ParsedDiffFile): void {
    const body = container.createDiv({ cls: "codex-diff-file-body" });
    if (!file.lines.length) {
      body.createDiv({ cls: "codex-diff-empty", text: "没有可展示的 diff 内容" });
      return;
    }
    for (const line of file.lines) {
      const row = body.createDiv({ cls: `codex-diff-line codex-diff-line-${line.type}` });
      row.createSpan({ cls: "codex-diff-line-no codex-diff-line-old", text: line.oldLine === null ? "" : String(line.oldLine) });
      row.createSpan({ cls: "codex-diff-line-no codex-diff-line-new", text: line.newLine === null ? "" : String(line.newLine) });
      row.createSpan({ cls: "codex-diff-marker", text: line.marker });
      row.createSpan({ cls: "codex-diff-content", text: line.text || " " });
    }
  }

  private renderProcessEditSummary(container: HTMLElement, message: ChatMessage): void {
    const list = container.createDiv({ cls: "codex-process-edit-list" });
    for (const file of message.diffSummary?.files ?? []) {
      const row = list.createDiv({ cls: "codex-process-edit-row" });
      row.createSpan({ cls: "codex-process-edit-prefix", text: "已编辑 " });
      const ref = findProcessFileRef(message.files ?? [], file.path) ?? normalizeProcessFileRef(file.path, this.requireEnv().vaultPath);
      this.renderProcessFileTextLink(row, ref, basename(file.path), "codex-process-edit-file");
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: ` +${file.added}` });
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: ` -${file.removed}` });
    }
  }

  private renderProcessFileTextLink(container: HTMLElement, file: ProcessFileRef, label: string, extraClass = ""): HTMLElement {
    if (!file.openable) {
      return container.createSpan({
        cls: `codex-process-file-text is-disabled ${extraClass}`.trim(),
        text: label,
        attr: { title: `${file.displayPath}（无法打开）` }
      });
    }
    const link = container.createEl("span", {
      cls: `codex-process-file-link codex-process-file-link-${file.kind} ${extraClass}`.trim(),
      text: label,
      attr: {
        role: "button",
        tabindex: "0",
        title: file.displayPath,
        "aria-label": `打开 ${label}`
      }
    });
    link.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openProcessFile(file);
    };
    link.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      void this.openProcessFile(file);
    };
    return link;
  }

  private renderDeferredRawText(container: HTMLElement, message: ChatMessage, fallback: string): void {
    const status = container.createDiv({ cls: "codex-process-raw-loading", text: "正在加载全文..." });
    const pre = container.createEl("pre", { cls: "codex-process-fulltext" });
    pre.setText(displayTextForMessage(message) || fallback);
    void this.loadRawText(message)
      .then((text) => {
        status.setText(this.rawMetaLabel(message, text));
        pre.setText(text || fallback);
        this.requireEnv().onScheduleMeasure();
      })
      .catch((error) => {
        status.setText(`全文加载失败：${error instanceof Error ? error.message : String(error)}`);
        this.requireEnv().onScheduleMeasure();
      });
  }

  private renderRawMessageExpander(container: HTMLElement, message: ChatMessage): void {
    const details = container.createEl("details", { cls: "codex-raw-message-details" });
    details.createEl("summary", { text: this.rawMetaLabel(message) });
    let loaded = false;
    details.ontoggle = () => {
      if (!details.open || loaded) return;
      loaded = true;
      const body = details.createDiv({ cls: "codex-raw-message-body" });
      body.createDiv({ cls: "codex-process-raw-loading", text: "正在加载全文..." });
      const pre = body.createEl("pre", { cls: "codex-process-fulltext" });
      this.requireEnv().onScheduleMeasure();
      void this.loadRawText(message)
        .then((text) => {
          body.empty();
          this.renderPlainTextBlock(body, text || "暂无内容");
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          pre.setText(`全文加载失败：${error instanceof Error ? error.message : String(error)}`);
          this.requireEnv().onScheduleMeasure();
        });
    };
  }

  private renderPlainTextBlock(container: HTMLElement, text: string): void {
    const pre = container.createEl("pre", { cls: "codex-process-fulltext" });
    pre.setText(text);
  }

  private async loadRawText(message: ChatMessage): Promise<string> {
    if (!message.rawRef) return displayTextForMessage(message);
    const cached = this.rawTextCache.get(message.rawRef);
    if (cached !== undefined) return cached;
    const text = await this.requireEnv().readRawMessageText(message.rawRef);
    this.rawTextCache.set(message.rawRef, text);
    while (this.rawTextCache.size > 5) {
      const oldest = this.rawTextCache.keys().next().value;
      if (!oldest) break;
      this.rawTextCache.delete(oldest);
    }
    return text;
  }

  private rawMetaLabel(message: ChatMessage, loadedText?: string): string {
    const size = message.rawSize ?? loadedText?.length ?? displayTextForMessage(message).length;
    const lines = message.rawLines ?? (loadedText ? countLines(loadedText) : null);
    const parts = ["原始输出"];
    if (size) parts.push(formatBytes(size));
    if (lines) parts.push(`${lines} 行`);
    if (message.rawRef) parts.push("展开后已保留全文");
    return parts.join(" · ");
  }

  private renderProcessFileChips(container: HTMLElement, files: ProcessFileRef[]): void {
    for (const file of files) {
      const chip = container.createEl("button", {
        cls: `codex-process-file-chip codex-process-file-${file.kind}`,
        attr: {
          type: "button",
          title: file.openable ? file.displayPath : `${file.displayPath}（无法打开）`,
          "aria-label": `打开 ${file.name}`
        }
      });
      chip.toggleClass("is-disabled", !file.openable);
      const icon = chip.createSpan({ cls: "codex-process-file-icon" });
      setIcon(icon, file.kind === "external" ? "folder-open" : "file-text");
      chip.createSpan({ cls: "codex-process-file-name", text: file.name });
      chip.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openProcessFile(file);
      };
    }
  }

  private async openProcessFile(file: ProcessFileRef): Promise<void> {
    const env = this.requireEnv();
    if (!file.openable) {
      new Notice("这个文件路径无法打开");
      return;
    }
    if (file.kind === "vault") {
      const vaultFile = env.app.vault.getAbstractFileByPath(normalizePath(file.path));
      if (vaultFile instanceof TFile) {
        await env.app.workspace.getLeaf("tab").openFile(vaultFile, { active: true });
        return;
      }
      if (file.absolutePath && showItemInFinder(file.absolutePath)) return;
      new Notice(`没有在当前 Obsidian 仓库找到：${file.displayPath}`);
      return;
    }
    if (file.kind === "external" && showItemInFinder(file.absolutePath ?? file.path)) return;
    new Notice("无法打开这个文件位置");
  }

  private pruneVirtualHeights(rowIds: string[]): void {
    const valid = new Set(rowIds);
    for (const key of Array.from(this.virtualRowHeights.keys())) {
      if (!valid.has(key)) this.virtualRowHeights.delete(key);
    }
  }
}

export const isProcessItemType = isAgentProcessItemType;

export function messageProvenanceMetaItems(message: ChatMessage): string[] {
  const items: string[] = [];
  const backend = message.backendId ? backendDisplayName(message.backendId) : "";
  const agent = [backend, message.modelId, message.profileId].filter(Boolean).join(" · ");
  if (agent) items.push(agent);
  if (message.contextMode) items.push(`Context ${message.contextMode}`);
  if (message.nativeLeaseStatus || message.nativeLeaseId) {
    const leaseParts = [
      `Lease ${message.nativeLeaseStatus ?? "unknown"}`,
      message.nativeLeaseReused ? "reused" : message.nativeLeaseId ? "created" : "",
      message.nativeLeaseTurnCount ? `turn ${message.nativeLeaseTurnCount}` : ""
    ].filter(Boolean);
    items.push(leaseParts.join(" · "));
  }
  if (message.nativeLocalCommitStatus) items.push(`Local commit ${message.nativeLocalCommitStatus}`);
  if (message.nativeCleanupStatus) items.push(`Native cleanup ${message.nativeCleanupStatus}`);
  return items;
}

const ACTIVE_ANSWER_FOOTER_STATUSES = new Set(["running", "in_progress", "inProgress", "approval", "blocked"]);
const FAILED_ANSWER_STATUSES = new Set(["failed", "error", "canceled", "cancelled", "interrupted"]);

export function terminalAnswerFooterMessageIds(messages: ChatMessage[]): Set<string> {
  const activeKeys = new Set<string>();
  const finalAnswerByKey = new Map<string, ChatMessage>();
  for (const message of messages) {
    const key = agentRunHeaderKey(message);
    if (ACTIVE_ANSWER_FOOTER_STATUSES.has(message.status ?? "")) activeKeys.add(key);
    if (isAgentAnswerMessage(message)) finalAnswerByKey.set(key, message);
  }
  return new Set(Array.from(finalAnswerByKey.entries())
    .filter(([key, message]) => !activeKeys.has(key) && !ACTIVE_ANSWER_FOOTER_STATUSES.has(message.status ?? ""))
    .map(([, message]) => message.id));
}

function agentRunHeaderKey(message: ChatMessage): string {
  if (message.runId) return `run:${message.runId}`;
  if (message.turnId) return `turn:${message.turnId}`;
  return `message:${message.id}`;
}

function isAgentHeaderCandidate(message: ChatMessage): boolean {
  if (message.role === "user" || message.itemType === "knowledgeBase") return false;
  return message.itemType !== "thinking" && message.itemType !== "contextCompaction";
}

export function shouldRenderMessageTitle(message: ChatMessage, hasAgentHeader: boolean): boolean {
  if (!message.title || isProcessItemType(message.itemType)) return false;
  if (isAgentAnswerMessage(message)) return FAILED_ANSWER_STATUSES.has(message.status ?? "");
  return !hasAgentHeader;
}

export function messageTitleTime(message: ChatMessage): string {
  return isAgentAnswerMessage(message) ? "" : formatMessageHeaderTime(message.createdAt);
}

function agentModelLine(message: ChatMessage): string {
  return message.backendId ? backendDisplayName(message.backendId) : "";
}

export function agentFooterItems(message: ChatMessage): string[] {
  const items: string[] = [];
  const time = formatAnswerFooterTime(message.completedAt ?? message.createdAt);
  if (time) items.push(time);
  const totalTokens = message.runUsage?.totalTokens ?? 0;
  if (totalTokens > 0) items.push(`本轮 ${formatCompactNumber(totalTokens)} tokens`);
  return items;
}

function formatAnswerFooterTime(value: number): string {
  return formatMessageHeaderTime(value)
    .replace(/^星期/, "周")
    .replace(/([一二三四五六日天])(?=\d{2}:\d{2}$)/, "$1 ");
}

function formatCompactNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function rotatingChoice<T>(items: readonly T[], createdAt?: number): T {
  return items[rotatingIndex(createdAt) % items.length];
}

function rotatingIndex(createdAt?: number): number {
  const seed = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now();
  return Math.max(0, Math.floor((Date.now() - seed) / AGENT_LIVE_COPY_INTERVAL_MS));
}

function backendDisplayName(backendId: string): string {
  if (backendId === "codex-cli") return "Codex";
  if (backendId === "opencode") return "OpenCode";
  if (backendId === "hermes") return "Hermes";
  return backendId;
}

function messageRowId(message: Pick<ChatMessage, "id">): string {
  return `message:${message.id}`;
}

function actionItemRowId(message: Pick<ChatMessage, "id">): string {
  return `actionItem:${message.id}`;
}

export function isDirectProcessVirtualRow(rowId: string | undefined, message: Pick<ChatMessage, "id" | "itemType" | "role">): boolean {
  return rowId === (isActionTimelineItem(message) ? actionItemRowId(message) : messageRowId(message));
}

function completedTurnRowId(turn: CompletedAgentTurn): string {
  return `turnProcess:${turn.key}:${turn.finalAnswer.id}`;
}

function actionItemMeta(item: ActionItemViewModel): string {
  if (item.status === "failed" && item.detail) return item.detail;
  if (item.kind === "tool" && item.detail) return item.detail;
  if (item.kind === "agent" && item.detail) return item.detail;
  if (item.kind === "system" && item.detail) return item.detail;
  return "";
}

function actionItemTarget(item: ActionItemViewModel): string {
  if (item.kind === "command" && item.command?.summary) return item.command.summary;
  const prefix = actionVerb(item);
  const title = item.title.startsWith(prefix) ? item.title.slice(prefix.length).trim() : item.title;
  return title
    .replace(/^(?:已运行|已读取|已搜索|已编辑|已调用|已处理|已更新|已验证|已记录|正在编辑|创建失败)\s*/, "")
    .replace(/^命令\s*/, "")
    .trim();
}

function hasActionItemDetails(item: ActionItemViewModel): boolean {
  if (item.source.processContentAvailability === "unavailable" || hasExplicitProcessChannels(item.source)) return true;
  const hasToolPayload = Boolean(
    item.source.rawRef
    || item.source.text.trim()
    || item.source.files?.length
    || item.source.diffSummary?.files.length
  );
  return Boolean(
    item.source.rawRef ||
    item.kind === "command" ||
    item.kind === "edit" ||
    ((item.kind === "tool" || item.kind === "agent") && hasToolPayload)
  );
}

function hasExplicitProcessChannels(message: ChatMessage): boolean {
  return Boolean(message.processInputAvailability || message.processOutputAvailability);
}

function actionItemDetailLabel(item: ActionItemViewModel): string {
  if (item.kind === "command") return item.status === "failed" ? "查看错误输出" : "查看 Shell 输出";
  if (item.kind === "edit") return "查看文件改动";
  if (item.kind === "tool" || item.kind === "agent") return "查看工具详情";
  return "查看详情";
}

export function actionVerb(item: ActionItemViewModel): string {
  if (item.status === "unconfirmed") return statusActionVerb(item.kind, "状态未回传");
  if (item.status === "interrupted" || item.status === "canceled") return statusActionVerb(item.kind, "已中断");
  if (item.status === "recovery-pending") return statusActionVerb(item.kind, "等待恢复");
  if (item.status === "recovery-blocked") return statusActionVerb(item.kind, "恢复受阻");
  if (item.status === "running" || item.status === "blocked") return runningActionVerb(item.kind);
  if (item.status === "failed") return statusActionVerb(item.kind, "失败");
  if (item.kind === "read") return "已读取";
  if (item.kind === "search") return "已搜索";
  if (item.kind === "command") return "已运行";
  if (item.kind === "edit") return "已编辑";
  if (item.kind === "tool") return "已调用";
  if (item.kind === "agent") return "已处理";
  if (item.kind === "plan") return "已更新";
  if (item.kind === "verify") return "已验证";
  return "已记录";
}

function statusActionVerb(kind: ActionGroupKind, suffix: string): string {
  const labels: Record<ActionGroupKind, string> = {
    read: "读取",
    search: "搜索",
    command: "运行",
    edit: "编辑",
    tool: "工具调用",
    agent: "智能体动作",
    plan: "计划更新",
    verify: "验证",
    system: "系统动作"
  };
  return `${labels[kind]}${suffix}`;
}

function runningActionVerb(kind: ActionGroupKind): string {
  const labels: Record<ActionGroupKind, string> = {
    read: "正在读取",
    search: "正在搜索",
    command: "正在运行",
    edit: "正在编辑",
    tool: "正在调用",
    agent: "正在处理",
    plan: "正在更新",
    verify: "正在验证",
    system: "正在处理"
  };
  return labels[kind];
}

function iconForActionKind(kind: ActionGroupKind, status?: string): string {
  if (status === "failed" || status === "recovery-blocked") return "triangle-alert";
  const icons: Record<ActionGroupKind, string> = {
    read: "book-open",
    search: "search",
    command: "terminal",
    edit: "file-pen",
    tool: "blocks",
    agent: "bot",
    plan: "list-checks",
    verify: "badge-check",
    system: "minimize-2"
  };
  return icons[kind] ?? "circle";
}

function stableDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function findProcessFileRef(refs: ProcessFileRef[], filePath: string): ProcessFileRef | null {
  const normalizedPath = normalizePath(filePath);
  const fileName = basename(filePath);
  return (
    refs.find((ref) => ref.path === filePath || ref.displayPath === filePath || ref.absolutePath === filePath) ??
    refs.find((ref) => normalizePath(ref.path) === normalizedPath || normalizePath(ref.displayPath) === normalizedPath) ??
    refs.find((ref) => ref.name === fileName) ??
    null
  );
}

function shellTranscript(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "$";
  const lines = trimmed.split(/\r?\n/);
  const command = lines.shift()?.trim() ?? "";
  const output = lines.join("\n").trim();
  if (!output) return `$ ${command}`;
  return `$ ${command}\n\n${output}`;
}

function iconForProcessMessage(message: ChatMessage): string {
  const processIcons: Record<string, string> = {
    search: "search",
    view: "book-open",
    edit: "pencil",
    run: "terminal",
    command: "terminal",
    tool: "blocks"
  };
  const processIcon = processIcons[message.processKind ?? ""];
  if (processIcon) return processIcon;
  return iconForItemType(message.itemType);
}

function iconForItemType(itemType?: string): string {
  const icons: Record<string, string> = {
    plan: "list-checks",
    commandExecution: "terminal",
    fileChange: "file-diff",
    mcpToolCall: "blocks",
    dynamicToolCall: "blocks",
    collabAgentToolCall: "blocks"
  };
  return icons[itemType ?? ""] ?? "chevron-right";
}

function titleForItemType(message: ChatMessage): string {
  if (message.title) return message.title;
  const titles: Record<string, string> = {
    plan: "更新计划",
    commandExecution: "使用命令",
    fileChange: "编辑文件",
    mcpToolCall: "使用工具",
    dynamicToolCall: "使用工具",
    collabAgentToolCall: "使用工具"
  };
  return titles[message.itemType ?? ""] ?? "工具";
}

function labelForStatus(status: string): string {
  const labels: Record<string, string> = {
    running: "进行中",
    completed: "完成",
    error: "失败",
    failed: "失败",
    canceled: "已取消",
    blocked: "等待确认",
    interrupted: "中断",
    unconfirmed: "状态未回传",
    "recovery-pending": "等待恢复",
    "recovery-blocked": "恢复受阻"
  };
  return labels[status] ?? status;
}

function labelForDiffKind(kind: string): string {
  const labels: Record<string, string> = {
    add: "新增",
    delete: "删除",
    update: "修改",
    move: "移动",
    unknown: "改动"
  };
  return labels[kind] ?? "改动";
}

function kbBucketLabel(bucket: KnowledgeBaseCitationBucket): string {
  if (bucket === "wiki") return "Wiki";
  if (bucket === "journal") return "Journal";
  return "Outputs";
}

function kbEvidenceStatusLabel(status: KnowledgeBaseCitationSummary["status"]): string {
  if (status === "strong") return "强证据";
  if (status === "weak") return "弱相关";
  return "无本地依据";
}

function formatAbsoluteTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function knowledgeBaseRunDisplayTitle(payload: KnowledgeBaseRunPayload, status?: string): string {
  if (status === "recovery-pending") return "正在恢复上次知识库维护";
  if (status === "recovery-blocked") return "知识库维护恢复被阻断";
  if (status === "interrupted") return "知识库任务已中断";
  if (status === "canceled") return "知识库任务已取消";
  if (status === "failed") return "知识库任务失败";
  if (status === "completed") return "知识库任务已完成";
  return payload.title;
}

function formatBytes(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} B`;
  if (byteCount < 1024 * 1024) return `${Math.round(byteCount / 1024)} KB`;
  return `${(byteCount / 1024 / 1024).toFixed(1)} MB`;
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function rememberOpenState(store: Map<string, boolean>, id: string, open: boolean): void {
  if (open) store.set(id, true);
  else store.delete(id);
}

function toImageSrc(app: App, imagePath: string): string {
  if (imagePath.startsWith("/")) return `file://${imagePath}`;
  const file = app.vault.getAbstractFileByPath(imagePath);
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  if (Platform.isDesktopApp) return `file://${imagePath}`;
  return imagePath;
}
