import { Notice, normalizePath, setIcon, TFile, type App, type Component, type Editor } from "obsidian";
import type {
  ChatMessage,
  DiffSummary,
  EchoInkWelcomeCopy,
  PersonalMemorySourceReference,
  SettingsLanguage,
  StoredAttachment
} from "../../settings/settings";
import type { KnowledgeBaseCitation, KnowledgeBaseCitationSummary, KnowledgeWorkflowEvent, KnowledgeWorkflowPhaseId } from "../../knowledge-base/types";
import type { ProcessFileRef, TokenUsage } from "../../types/app-server";
import { openPathInElectron, showItemInFinder } from "../../core/electron";
import { basename, normalizeProcessFileRef } from "../../core/mapping";
import { parseFileChangeDiff, type ParsedDiffFile } from "../../core/diff-summary";
import {
  conversationCopy,
  type ConversationCopy
} from "../../settings/i18n";
import { displayTextForMessage, isLargeRawMessage } from "../../core/raw-message-store";
import { calculateVirtualWindow, isNearVirtualBottom, scrollTopForVirtualBottom, VIRTUAL_ROW_ESTIMATE_PX } from "../../core/virtual-window";
import { extractKnowledgeBaseResultTitle } from "../knowledge-base-result-title";
import type { KnowledgeBaseMaintainReportPayload, KnowledgeBaseMaintainReportSectionItem, KnowledgeBaseMessageUiPayload, KnowledgeBaseRunPayload } from "../../knowledge-base/maintain-report-card";
import { formatMessageHeaderTime } from "../message-time";
import { openImageOverlay, renderPreformattedVaultNoteText, renderRichText } from "../render-message";
import {
  conversationUiLocale,
  conversationUiText,
  localizeKnownConversationSystemCopy
} from "./ui-i18n";
import { buildActionTimeline, isActionTimelineItem, type ActionGroupKind, type ActionItemViewModel } from "./action-timeline";
import {
  buildAgentTurnProjection,
  formatAgentTurnSummary,
  isAgentAnswerMessage,
  isAgentProcessItemType,
  isTerminalTurnStatus,
  type AgentTurnView,
  type CompletedAgentTurn
} from "./agent-turn-process";
import { copyAnswerMarkdown } from "./answer-copy";
import {
  piApprovalPreviewChangeProjection,
  piEntryIdFromProjectedMessageId,
  type PiApprovalPreviewChangeProjection
} from "../../harness/pi-native/pi-chat-ui-projector";
import {
  attachmentPathIdentity,
  createAttachmentResourceResolver,
  type EchoInkAttachmentResourceResolver
} from "./attachment-resource";
import { renderFileCard } from "./file-card";
import { absoluteVaultPath } from "./workspace-utils";
import type { KnowledgeReference } from "../../knowledge-base/types";
import {
  knowledgeUsageMessageData,
  mergeKnowledgeUsageMessageData,
  type KnowledgeUsageMessageData
} from "../../knowledge-base/usage";
import {
  taskPlanProgress,
  type EchoInkTaskPlanStepStatus,
  type EchoInkTaskPlanStatus
} from "../../types/task-plan";
import type { EchoInkTurnProcessNode } from "../../types/conversation-turn";
import { renderProviderBrandIcon, type ProviderBrandId } from "../../settings/provider-brand-icons";
import { API_PROVIDER_PRESETS } from "../../settings/provider-presets";
import {
  applyAIElementsStatus,
  aiElementsStatus,
  createAIElementsArtifactSources,
  createAIElementsChainOfThought,
  createAIElementsMessageContent,
  createAIElementsReasoning,
  markAIElementsMessage,
  markAIElementsResponse,
  markAIElementsTool,
  renderAIElementsToolStatus
} from "./ai-elements-dom";
import {
  createAIElementsDocumentSources,
  createAIElementsTask,
  createSmoothAIApprovalCard,
  createSmoothAIArtifact,
  markSmoothAIApproval,
  markSmoothAIArtifact,
  markSmoothAIDiff,
  markAIElementsAttachmentItem,
  markAIElementsAttachments,
  renderSmoothAILoader,
  renderSmoothAISuggestions,
  renderSmoothBlurOutUp,
  type SmoothAIApprovalState
} from "./smooth-chat-ui";

type MessageRenderRow =
  | { id: string; kind: "message"; message: ChatMessage; showAgentHeader: boolean; showAgentFooter: boolean; processExpanded: boolean }
  | { id: string; kind: "actionItem"; message: ChatMessage; showAgentHeader: boolean }
  | { id: string; kind: "assistantTurn"; turn: AgentTurnView; showAgentHeader: boolean }
  | { id: string; kind: "turnProcess"; turn: CompletedAgentTurn; showAgentHeader: boolean };

interface LocalVaultDocumentSource {
  citations: KnowledgeBaseCitation[];
  key: string;
  kind: "vault";
  path: string;
  references: KnowledgeReference[];
}

interface LocalMemoryDocumentSource {
  key: string;
  kind: "memory";
  source: PersonalMemorySourceReference;
}

type LocalDocumentSource = LocalVaultDocumentSource | LocalMemoryDocumentSource;

export interface MessageListRenderOptions {
  forceBottom?: boolean;
  fromScroll?: boolean;
  preserveScroll?: boolean;
}

/** 只读展示快照：当前 Agent 名称、头像与等待态人格。 */
export interface AgentIdentityView {
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly personalityTemplateId?: string | null;
}

export interface MessageApprovalDecisionBinding {
  readonly target: string;
  readonly preview: string;
  decide(decision: "approve" | "reject"): boolean;
}

export interface MessageListRenderInput {
  app: App;
  component: Component;
  messagesEl: HTMLElement;
  virtualListEl: HTMLElement;
  sessionId: string;
  welcomeCopy: Readonly<EchoInkWelcomeCopy>;
  settingsLanguage: SettingsLanguage;
  messages: ChatMessage[];
  /** 当前 Agent 身份展示快照；缺省时回退 EchoInk + bot 图标。 */
  agentIdentity?: AgentIdentityView;
  tokenUsage?: TokenUsage;
  vaultPath: string;
  readRawMessageText: (rawRef: string) => Promise<string>;
  onDerivePiConversation?: (entryId: string) => Promise<void>;
  piConversationDeriveDisabled?: boolean;
  onTaskPlanAction?: (
    planId: string,
    action: "execute" | "continue" | "pause" | "cancel"
  ) => Promise<void>;
  onModifyTaskPlan?: (planId: string, title: string) => void;
  resolveApprovalDecision?: (
    message: Readonly<ChatMessage>
  ) => MessageApprovalDecisionBinding | null;
  onSuggestionSelect?: (text: string) => void;
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
export const REASONING_AUTO_FOLD_DELAY_MS = 1000;
export const REASONING_SCROLL_BOTTOM_EPSILON_PX = 24;

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
  const activeIndex = activePhase ? phaseOrder.indexOf(activePhase) : -1;
  const furthestCompletedSegment = events
    .filter((event) => event.type === "workflow.phase.completed" && event.phaseId)
    .reduce((furthest, event) => {
      const index = phaseOrder.indexOf(event.phaseId as KnowledgeWorkflowPhaseId);
      return index < 0 ? furthest : Math.max(furthest, index + 1);
    }, 0);
  const completedSegments = Math.min(
    Math.max(0, phaseCount - 1),
    Math.max(
      furthestCompletedSegment,
      activeIndex >= 0 ? activeIndex : 0,
      phaseOrder.slice(0, Math.max(0, phaseCount - 1)).filter((phase) => completed.has(phase)).length
    )
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

export function isReasoningScrollNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
): boolean {
  return scrollHeight - Math.max(0, clientHeight) - Math.max(0, scrollTop)
    <= REASONING_SCROLL_BOTTOM_EPSILON_PX;
}

export function piConversationDeriveActionLabel(
  message: Pick<ChatMessage, "role">,
  language: SettingsLanguage = "zh-CN"
): string | null {
  if (message.role === "assistant") return conversationCopy(language).message.deriveConversation;
  return null;
}

export function knowledgeBaseMaintainSectionOpenState(storedOpen: boolean | undefined, initiallyOpen: boolean): boolean {
  return storedOpen ?? initiallyOpen;
}

export function knowledgeBaseMaintainReportItemPath(item: KnowledgeBaseMaintainReportSectionItem): string | undefined {
  const explicitPath = item.path?.trim();
  if (explicitPath) return explicitPath;
  const legacyTitle = item.title.trim();
  return /\.(?:md|markdown|txt)$/i.test(legacyTitle) ? legacyTitle : undefined;
}

/** Empty source metadata can mean an older event did not persist it. */
export function personalMemorySourceCountLabel(
  count: number,
  language: SettingsLanguage = "zh-CN"
): string {
  return conversationCopy(language).sources.personalMemoryCount(count);
}

export function personalMemorySourceEmptyStateLabel(
  language: SettingsLanguage = "zh-CN"
): string {
  return conversationCopy(language).sources.noPersonalMemory;
}

export interface ReasoningDisclosureState {
  readonly open: boolean;
  readonly manual: boolean;
  readonly autoFoldHandled: boolean;
  readonly lastStatus: string;
}

export function nextReasoningDisclosureState(
  previous: Readonly<ReasoningDisclosureState> | undefined,
  status: string
): Readonly<ReasoningDisclosureState> {
  if (!previous) {
    const running = status === "running";
    return Object.freeze({
      open: running,
      manual: false,
      autoFoldHandled: !running,
      lastStatus: status
    });
  }
  if (
    !previous.manual
    && !previous.autoFoldHandled
    && previous.lastStatus === "running"
    && status !== "running"
  ) {
    return Object.freeze({
      open: previous.open,
      manual: false,
      autoFoldHandled: false,
      lastStatus: status
    });
  }
  if (!previous.manual && status === "running" && previous.lastStatus !== "running") {
    return Object.freeze({
      open: true,
      manual: false,
      autoFoldHandled: false,
      lastStatus: status
    });
  }
  return Object.freeze({ ...previous, lastStatus: status });
}

interface DisclosureAutoFoldRegistration {
  timerId: number;
  root: HTMLDetailsElement;
  summary: HTMLElement;
}

interface TextSelectionBookmark {
  readonly anchorOffset: number;
  readonly focusOffset: number;
}

export class CodexMessageListRenderer {
  private virtualSessionId = "";
  private virtualRowHeights = new Map<string, number>();
  private currentRows: MessageRenderRow[] = [];
  private failedAttachmentResourceUris = new Set<string>();
  private viewportResizeObserver: ResizeObserver | null = null;
  private visibleRowsResizeObserver: ResizeObserver | null = null;
  private observedMessagesEl: HTMLElement | null = null;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private rawTextCache = new Map<string, string>();
  private openProcessItems = new Map<string, boolean>();
  private openActionItemDetails = new Map<string, boolean>();
  private openKnowledgeBaseCitations = new Map<string, boolean>();
  private openKnowledgeBaseReportSections = new Map<string, boolean>();
  private openTaskPlans = new Map<string, boolean>();
  private reasoningDisclosureStates = new Map<string, ReasoningDisclosureState>();
  private disclosureAutoFoldTimers = new Map<string, DisclosureAutoFoldRegistration>();
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
    const { messagesEl, virtualListEl, messages } = env;
    this.observeMessageViewport(messagesEl);
    if (this.virtualSessionId !== env.sessionId) {
      this.cancelAllDisclosureAutoFolds();
      this.virtualSessionId = env.sessionId;
      this.virtualRowHeights.clear();
      this.failedAttachmentResourceUris.clear();
      this.cancelVirtualRerenderTrailing(true);
      this.resetVirtualRerenderThrottle();
    }
    const previousScrollTop = messagesEl.scrollTop;
    const shouldPinBottom = shouldPinMessageListBottom(env.options, this.isNearBottom(messagesEl, virtualListEl));
    this.disconnectVisibleRowsObserver();
    virtualListEl.empty();
    if (messages.length === 0) {
      const copy = conversationCopy(env.settingsLanguage);
      virtualListEl.setCssStyles({ height: "100%" });
      const welcome = virtualListEl.createDiv({ cls: "codex-welcome" });
      welcome.createDiv({ cls: "codex-welcome-title", text: env.welcomeCopy.title });
      renderSmoothBlurOutUp(
        welcome.createDiv({ cls: "codex-resource-note codex-welcome-subtitle" }),
        env.welcomeCopy.subtitle
      );
      const suggestions = renderSmoothAISuggestions(
        welcome,
        copy.message.suggestions,
        (suggestion) => env.onSuggestionSelect?.(suggestion.label),
        copy.message.suggestionsAria,
        env.settingsLanguage
      );
      suggestions.addClass("codex-welcome-suggestions");
      this.currentRows = [];
      return;
    }

    const rows = this.buildVirtualRows(messages);
    this.currentRows = rows;
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

    this.observeVisibleVirtualRows(messagesEl, virtualListEl);
    this.measureVisibleVirtualRows(messagesEl, virtualListEl, shouldPinBottom);
    if (shouldPinBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (env.options.fromScroll || env.options.preserveScroll) {
      messagesEl.scrollTop = previousScrollTop;
    }
  }

  measureVisibleVirtualRows(messagesEl: HTMLElement, virtualListEl: HTMLElement, forceBottom = false, options: { rerender?: boolean } = {}): boolean {
    if (messagesEl.clientHeight === 0) return false;
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
    if (changed && forceBottom && (this.virtualRerenderScheduled || this.virtualRerenderTrailingTimer !== null)) {
      this.virtualRerenderPendingForceBottom = true;
    }
    if (changed && options.rerender !== false) this.scheduleMeasuredRowsRerender(forceBottom);
    if (!changed) {
      this.resetVirtualRerenderThrottle();
    }
    if (changed && forceBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    return changed;
  }

  tryUpdateMessage(message: ChatMessage, messages?: ChatMessage[]): boolean {
    const env = this.env;
    if (!env || message.rawRef || message.citations || message.itemType === "knowledgeBase") return false;
    if (messages) env.messages = messages;
    const processMessage = isAgentProcessItemType(message.itemType);
    if (!processMessage && message.status !== "running") return false;
    const target = this.findRenderedMessageElement(message.id);
    const wrapper = target?.hasClass("codex-message") ? target : target?.closest<HTMLElement>(".codex-message");
    if (!wrapper) return false;
    const renderedRow = wrapper.closest<HTMLElement>(".codex-virtual-row");
    if (renderedRow?.dataset.rowId?.startsWith("assistantTurn:")) {
      return this.tryUpdateAssistantTurnMessage(renderedRow, message);
    }
    const shouldPinBottom = env.shouldFollowBottom
      ? env.shouldFollowBottom()
      : this.isAtBottom(env.messagesEl, env.virtualListEl);
    if (processMessage) {
      if (!isDirectProcessVirtualRow(renderedRow?.dataset.rowId, message)) return false;
      if (
        !isActionTimelineItem(message)
        && !wrapper.querySelector(".codex-process")
      ) return false;
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

  /** Content-space top of each requested row id, using the same measured/estimated heights as the virtual window. */
  rowTopsForRowIds(rowIds: readonly string[]): Map<string, number> {
    const wanted = new Set(rowIds);
    const tops = new Map<string, number>();
    let top = 0;
    for (const row of this.currentRows) {
      if (wanted.has(row.id) && !tops.has(row.id)) tops.set(row.id, top);
      top += this.virtualRowHeightFor(row.id);
    }
    return tops;
  }

  rowTopForRowId(rowId: string): number | null {
    let top = 0;
    for (const row of this.currentRows) {
      if (row.id === rowId) return top;
      top += this.virtualRowHeightFor(row.id);
    }
    return null;
  }

  private virtualRowHeightFor(rowId: string): number {
    const measured = this.virtualRowHeights.get(rowId);
    return measured && measured > 0 ? measured : VIRTUAL_ROW_ESTIMATE_PX;
  }

  resetVirtualWindow(): void {
    this.cancelAllDisclosureAutoFolds();
    this.virtualSessionId = "";
    this.virtualRowHeights.clear();
    this.failedAttachmentResourceUris.clear();
    this.cancelVirtualRerenderTrailing(true);
    this.resetVirtualRerenderThrottle();
  }

  dispose(): void {
    this.cancelAllDisclosureAutoFolds();
    this.disconnectVisibleRowsObserver();
    this.disconnectViewportObserver();
    this.env = null;
    this.resetVirtualWindow();
  }

  private requireEnv(): MessageListEnvironment {
    if (!this.env) throw new Error("Message list renderer has not been initialized");
    return this.env;
  }

  private copy(): ConversationCopy {
    return conversationCopy(this.requireEnv().settingsLanguage);
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

  private observeVisibleVirtualRows(
    messagesEl: HTMLElement,
    virtualListEl: HTMLElement
  ): void {
    const ownerWindow = messagesEl.ownerDocument?.defaultView as (Window & {
      ResizeObserver?: typeof ResizeObserver;
    }) | null;
    const ResizeObserverCtor = ownerWindow?.ResizeObserver
      ?? (typeof globalThis.ResizeObserver === "function" ? globalThis.ResizeObserver : null);
    if (!ResizeObserverCtor) return;
    this.visibleRowsResizeObserver = new ResizeObserverCtor(() => {
      if (!this.env || this.env.messagesEl !== messagesEl || this.env.virtualListEl !== virtualListEl) return;
      const forceBottom = this.env.shouldFollowBottom?.() ?? false;
      this.measureVisibleVirtualRows(messagesEl, virtualListEl, forceBottom);
    });
    for (const child of Array.from(virtualListEl.children)) {
      if (child instanceof HTMLElement) this.visibleRowsResizeObserver.observe(child);
    }
  }

  private disconnectVisibleRowsObserver(): void {
    this.visibleRowsResizeObserver?.disconnect();
    this.visibleRowsResizeObserver = null;
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

  private scheduleDisclosureAutoFold(
    timerKey: string,
    stateKey: string,
    states: Map<string, ReasoningDisclosureState>,
    root: HTMLDetailsElement,
    summary: HTMLElement
  ): void {
    const state = states.get(stateKey);
    if (
      !state
      || state.manual
      || state.autoFoldHandled
      || state.lastStatus === "running"
      || !state.open
    ) {
      this.cancelDisclosureAutoFold(timerKey);
      return;
    }
    const existing = this.disclosureAutoFoldTimers.get(timerKey);
    if (existing) {
      existing.root = root;
      existing.summary = summary;
      return;
    }
    const registration: DisclosureAutoFoldRegistration = {
      timerId: 0,
      root,
      summary
    };
    this.disclosureAutoFoldTimers.set(timerKey, registration);
    registration.timerId = window.setTimeout(() => {
      if (this.disclosureAutoFoldTimers.get(timerKey) !== registration) return;
      this.disclosureAutoFoldTimers.delete(timerKey);
      const current = states.get(stateKey);
      if (
        !current
        || current.manual
        || current.autoFoldHandled
        || current.lastStatus === "running"
      ) return;
      states.set(stateKey, Object.freeze({
        ...current,
        open: false,
        autoFoldHandled: true
      }));
      registration.root.open = false;
      registration.summary.setAttribute("aria-expanded", "false");
      this.env?.onScheduleMeasure();
    }, REASONING_AUTO_FOLD_DELAY_MS);
  }

  private cancelDisclosureAutoFold(timerKey: string): void {
    const registration = this.disclosureAutoFoldTimers.get(timerKey);
    if (!registration) return;
    this.disclosureAutoFoldTimers.delete(timerKey);
    if (registration.timerId) window.clearTimeout(registration.timerId);
  }

  private cancelAllDisclosureAutoFolds(): void {
    for (const registration of this.disclosureAutoFoldTimers.values()) {
      if (registration.timerId) window.clearTimeout(registration.timerId);
    }
    this.disclosureAutoFoldTimers.clear();
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
      let patched = false;
      if (isActionTimelineItem(update.message)) {
        const item = buildActionTimeline(
          [update.message],
          env.settingsLanguage
        ).groups[0]?.items[0];
        const action = wrapper.querySelector<HTMLElement>(".codex-action-item");
        patched = Boolean(item && action && this.patchActionItem(action, item));
      } else {
        const process = wrapper.querySelector<HTMLDetailsElement>(".codex-process");
        if (process) patched = this.patchProcessMessage(process, update.message);
      }
      if (!patched) continue;
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
      preserveTextSelectionDuringMutation(content, () => {
        if (isAgentAnswerMessage(update.message)) this.renderAgentAnswerContent(content, update.message);
        else renderRichText(env.app, env.component, content, displayTextForMessage(update.message));
      });
      updated = true;
      shouldPinBottom = shouldPinBottom || update.shouldPinBottom;
    }
    if (updated) env.onScheduleMeasure(shouldPinBottom && (env.shouldFollowBottom?.() ?? true));
  }

  private tryUpdateAssistantTurnMessage(
    renderedRow: HTMLElement,
    message: ChatMessage
  ): boolean {
    const env = this.requireEnv();
    const projection = buildAgentTurnProjection(
      env.messages,
      env.settingsLanguage
    ).find((item) =>
      item.kind === "assistantTurn"
      && item.turn.messages.some((candidate) => candidate.id === message.id)
    );
    if (!projection || projection.kind !== "assistantTurn") return false;
    const turn = projection.turn;
    const turnRoot = renderedRow.querySelector<HTMLElement>(".codex-assistant-turn");
    if (!turnRoot) return false;

    const knownNodes: HTMLElement[] = [
      ...Array.from(turnRoot.querySelectorAll<HTMLElement>(".codex-assistant-turn-node")),
      ...Array.from(turnRoot.querySelectorAll<HTMLElement>(".codex-assistant-turn-reasoning-node")),
      ...Array.from(turnRoot.querySelectorAll<HTMLElement>(".codex-assistant-turn-action-node"))
    ];
    for (const node of turn.processNodes) {
      const renderedNode = knownNodes.find((candidate) => candidate.dataset.nodeId === node.nodeId);
      if (!renderedNode) return false;
      for (const status of ["waiting", "running", "completed", "failed", "cancelled", "skipped"] as const) {
        renderedNode.toggleClass(`is-${status}`, status === node.status);
      }
      renderedNode.toggleClass("is-current", node.nodeId === turn.currentNodeId);
      renderedNode.dataset.nodeStatus = node.status;
      const title = renderedNode.querySelector<HTMLElement>(".codex-assistant-turn-node-title");
      if (title && title.textContent !== node.title) title.setText(node.title);
      const summary = renderedNode.querySelector<HTMLElement>(".codex-assistant-turn-node-summary");
      if (summary && node.summary !== undefined && summary.textContent !== node.summary) {
        summary.setText(node.summary);
      }
    }

    const chain = turnRoot.querySelector<HTMLElement>(".codex-ai-elements-chain-of-thought");
    if (chain) {
      applyAIElementsStatus(
        chain,
        aiElementsStatus(isTerminalTurnStatus(turn.status) ? turn.status : "running")
      );
      chain.setAttribute("data-turn-status", turn.status);
    }

    for (const reasoning of turn.providerReasoningSegments) {
      const root = turnRoot
        .querySelectorAll<HTMLDetailsElement>(".codex-ai-elements-reasoning");
      const matchingRoot = Array.from(root)
        .find((candidate) => candidate.dataset.reasoningId === reasoning.reasoningId);
      if (!matchingRoot) return false;
      this.patchProviderReasoning(matchingRoot, turn, reasoning);
    }

    if (turn.finalAnswer?.id === message.id) {
      const answerSection = turnRoot.querySelector<HTMLElement>(".codex-assistant-turn-final");
      const answerContent = answerSection?.querySelector<HTMLElement>(".codex-message-content");
      if (!answerSection || !answerContent) return false;
      const answerText = displayTextForMessage(turn.finalAnswer);
      if (
        answerContent.dataset.renderedText !== answerText
        || answerContent.getAttribute("data-streaming") !== String(turn.finalAnswer.status === "running")
      ) {
        preserveTextSelectionDuringMutation(answerContent, () => {
          this.renderAgentAnswerContent(answerContent, turn.finalAnswer!);
        });
      }
      this.renderAssistantFailureReason(answerSection, turn.finalAnswer);
      const wrapper = turnRoot.closest<HTMLElement>(".codex-message-type-assistantTurn");
      wrapper?.toggleClass("codex-message-streaming", turn.finalAnswer.status === "running");
      if (
        isTerminalTurnStatus(turn.status)
        && !answerSection.querySelector(".codex-agent-footer")
      ) {
        const footerActions = this.renderAgentFooter(answerSection, turn.finalAnswer);
        this.renderPiConversationDeriveAction(footerActions, turn.finalAnswer, true);
      }
    }

    if (isActionTimelineItem(message)) {
      const item = buildActionTimeline([message], env.settingsLanguage).groups[0]?.items[0];
      const action = turnRoot
        .querySelectorAll<HTMLElement>(".codex-action-item");
      const matchingAction = Array.from(action)
        .find((candidate) => candidate.dataset.messageId === message.id);
      if (!item || !matchingAction || !this.patchActionItem(matchingAction, item)) return false;
    }

    env.onScheduleMeasure(env.shouldFollowBottom?.() ?? true);
    return true;
  }

  private patchProviderReasoning(
    root: HTMLDetailsElement,
    turn: AgentTurnView,
    reasoning: AgentTurnView["providerReasoningSegments"][number]
  ): void {
    const env = this.requireEnv();
    const copy = this.copy();
    const disclosureKey = `${env.sessionId}\0${turn.key}\0provider-reasoning\0${reasoning.reasoningId}`;
    const disclosure = nextReasoningDisclosureState(
      this.reasoningDisclosureStates.get(disclosureKey),
      reasoning.status
    );
    this.reasoningDisclosureStates.set(disclosureKey, disclosure);
    const status = reasoning.status === "failed"
      || reasoning.status === "cancelled"
      || reasoning.status === "interrupted"
      ? "error"
      : aiElementsStatus(reasoning.status);
    applyAIElementsStatus(root, status);
    const summary = root.querySelector<HTMLElement>(".codex-ai-elements-reasoning-trigger");
    const label = root.querySelector<HTMLElement>(".codex-ai-elements-reasoning-label");
    const body = root.querySelector<HTMLElement>(".codex-ai-elements-reasoning-content");
    if (!summary || !body) return;
    label?.toggleClass("is-shimmering", reasoning.status === "running");
    label?.setText(reasoning.status === "running"
      ? copy.process.publicReasoningRunning
      : reasoning.durationMs === undefined
        ? copy.process.publicReasoningCompleted
        : copy.process.publicReasoningDuration(formatCompactDuration(reasoning.durationMs)));
    const displayText = userVisibleProviderReasoningText(
      reasoning.text,
      assistantTurnHasPersonalMemoryContext(turn)
    );
    if (body.dataset.renderedText !== displayText) {
      const previousScrollTop = body.scrollTop;
      const shouldFollowLatest = isReasoningScrollNearBottom(
        previousScrollTop,
        body.clientHeight,
        body.scrollHeight
      );
      preserveTextSelectionDuringMutation(body, () => {
        if (displayText.trim()) {
          renderRichText(env.app, env.component, body, displayText);
        } else {
          body.empty();
        }
        body.dataset.renderedText = displayText;
      });
      body.scrollTop = shouldFollowLatest ? body.scrollHeight : previousScrollTop;
    }
    this.scheduleDisclosureAutoFold(
      `reasoning:${disclosureKey}`,
      disclosureKey,
      this.reasoningDisclosureStates,
      root,
      summary
    );
  }

  private patchActionItem(
    row: HTMLElement,
    item: ActionItemViewModel
  ): boolean {
    const expandable = hasActionItemDetails(item);
    if (isDetailsElement(row) !== expandable) return false;
    preserveTextSelectionDuringMutation(row, () => {
      markAIElementsTool(row, item.status);
      row.toggleClass("is-failed", isAttentionActionStatus(item.status));
      row.toggleClass("is-running", isActiveActionStatus(item.status));
      const head = row.querySelector<HTMLElement>(".codex-action-item-head");
      if (head) {
        head.empty();
        this.renderActionItemHead(head, item);
        if (expandable) {
          const caret = head.createSpan({ cls: "codex-action-item-caret" });
          setIcon(caret, (row as HTMLDetailsElement).open ? "chevron-up" : "chevron-down");
        }
      }
      this.applyAssistantTurnActionSemantics(row, item);
      if (expandable && (row as HTMLDetailsElement).open) {
        const body = row.querySelector<HTMLElement>(".codex-action-item-details-body");
        if (body) {
          body.empty();
          this.renderActionItemDetails(body, item);
        }
      }
    });
    return true;
  }

  private patchProcessMessage(
    details: HTMLDetailsElement,
    message: ChatMessage
  ): boolean {
    const summary = details.querySelector<HTMLElement>(".codex-process-summary");
    if (!summary) return false;
    preserveTextSelectionDuringMutation(details, () => {
      markAIElementsTool(details, message.status);
      details.toggleClass("is-running", isActiveProcessStatus(message.status));
      details.toggleClass("is-completed", message.status === "completed");
      details.toggleClass("is-error", isAttentionProcessStatus(message.status));
      summary.empty();
      const icon = renderAIElementsToolStatus(summary, message.status);
      icon.addClass("codex-structured-icon");
      icon.addClass("codex-process-icon");
      setSemanticIcon(icon, iconForProcessMessage(message));
      const main = summary.createDiv({ cls: "codex-process-main" });
      if (message.itemType === "fileChange" && message.diffSummary?.files.length) {
        this.renderProcessEditSummary(main, message);
      } else {
        main.createSpan({
          cls: "codex-structured-title codex-process-title",
          text: titleForItemType(message, this.requireEnv().settingsLanguage)
        });
        if (message.itemType === "fileChange" && message.diffSummary) {
          this.renderDiffStats(main, message.diffSummary);
        }
        if (message.details) {
          main.createDiv({ cls: "codex-process-detail", text: message.details });
        }
        if (message.itemType === "fileChange" && message.files?.length) {
          this.renderProcessFileChips(
            main.createDiv({ cls: "codex-process-files" }),
            message.files
          );
        }
      }
      if (message.status) {
        summary.createSpan({
          cls: "codex-structured-status",
          text: labelForStatus(message.status, this.requireEnv().settingsLanguage)
        });
      }
      if (details.open) {
        const body = details.querySelector<HTMLElement>(".codex-process-body");
        if (body) {
          body.empty();
          this.renderProcessBody(body, message);
        }
      }
    });
    return true;
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
    for (const item of buildAgentTurnProjection(messages, this.requireEnv().settingsLanguage)) {
      if (item.kind === "assistantTurn") {
        const turn = item.turn;
        const identityMessage = turn.messages[0] ?? turn.finalAnswer;
        const headerKey = identityMessage ? agentRunHeaderKey(identityMessage) : turn.key;
        const showAgentHeader = !agentHeaderKeys.has(headerKey);
        if (showAgentHeader) agentHeaderKeys.add(headerKey);
        rows.push({
          id: assistantTurnRowId(turn),
          kind: "assistantTurn",
          turn,
          showAgentHeader
        });
        continue;
      }
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
    if (row.kind === "assistantTurn") {
      this.renderAssistantTurn(container, row.turn, row.showAgentHeader);
      return;
    }
    if (row.kind === "turnProcess") {
      this.renderCompletedTurnProcess(container, row.turn, row.showAgentHeader);
      return;
    }
    if (row.kind === "actionItem") {
      this.renderActionStreamItem(container, row.message, row.showAgentHeader);
      return;
    }
    if (row.message.role === "user") container.addClass("codex-virtual-row-user-message");
    this.renderMessage(container, row.message, { showAgentHeader: row.showAgentHeader, showAgentFooter: row.showAgentFooter, processExpanded: row.processExpanded });
  }

  private renderMessage(container: HTMLElement, message: ChatMessage, options: { showAgentHeader: boolean; showAgentFooter: boolean; processExpanded?: boolean; allowConversationDerive?: boolean } = { showAgentHeader: false, showAgentFooter: false }): void {
    const env = this.requireEnv();
    const wrapper = container.createDiv({ cls: `codex-message codex-message-${message.role}` });
    markAIElementsMessage(wrapper, message.role);
    wrapper.dataset.messageId = message.id;
    wrapper.toggleClass("codex-message-streaming", message.status === "running");
    wrapper.toggleClass(`codex-message-type-${message.itemType ?? "text"}`, true);
    const emptyRunningAnswer = isAgentAnswerMessage(message) && message.status === "running" && !displayTextForMessage(message).trim();
    wrapper.toggleClass("codex-message-empty-running", emptyRunningAnswer);
    wrapper.toggleClass("has-agent-header", options.showAgentHeader);
    if (message.taskPlan) {
      this.renderTaskPlanCard(wrapper, message);
      return;
    }
    if (options.showAgentHeader) this.renderAgentHeader(wrapper, {
      message,
      statusLabel: "",
      compact: false
    });
    const bodyHost = message.role === "assistant"
      ? createAIElementsMessageContent(wrapper)
      : wrapper;
    if (!emptyRunningAnswer && shouldRenderMessageTitle(message, options.showAgentHeader)) {
      const title = bodyHost.createDiv({ cls: "codex-message-title" });
      title.createSpan({
        cls: "codex-message-title-label",
        text: firstPartyMessageTitle(message, env.settingsLanguage)
      });
      const time = messageTitleTime(message, env.settingsLanguage);
      if (time) {
        title.createSpan({
          cls: "codex-message-title-time",
          text: time,
          attr: { title: formatAbsoluteTime(message.createdAt, env.settingsLanguage) }
        });
      }
    }
    if (message.noteMentions?.length) {
      this.renderUserNoteMentionChips(
        bodyHost.createDiv({ cls: "codex-message-note-mentions" }),
        message.noteMentions
      );
    }
    const messageAttachments = mergeMessageAttachments(
      message.attachments,
      message.images
    );
    if (messageAttachments.length) {
      this.renderMessageAttachments(
        bodyHost.createDiv({ cls: "codex-message-attachments" }),
        messageAttachments,
        createAttachmentResourceResolver(
          env.app,
          env.vaultPath,
          env.settingsLanguage
        )
      );
    }
    const content = bodyHost.createDiv({ cls: "codex-message-content" });
    content.dataset.messageContent = "true";
    if (emptyRunningAnswer) {
      this.renderAgentAnswerContent(content, message);
      return;
    }
    if (message.itemType === "thinking") {
      this.renderThinkingMessage(content, message);
      return;
    }
    if (message.itemType === "reasoning") {
      content.addClass("codex-inline-reasoning");
      const bodyId = `codex-elements-reasoning-${safeDomIdentity(message.id)}`;
      const disclosureKey = message.reasoningSummary
        ? `${env.sessionId}\0${message.reasoningSummary.productRunId}`
        : "";
      const disclosure = message.reasoningSummary
        ? nextReasoningDisclosureState(
            this.reasoningDisclosureStates.get(disclosureKey),
            message.reasoningSummary.status
          )
        : undefined;
      if (disclosure) {
        this.reasoningDisclosureStates.set(disclosureKey, disclosure);
      }
      const open = disclosure?.open
        ?? this.openProcessItems.get(message.id)
        ?? message.status === "running";
      const status = message.reasoningSummary?.status ?? message.status;
      const copy = this.copy();
      const reasoning = createAIElementsReasoning(content, {
        bodyId,
        open,
        status: status === "interrupted" || status === "cancelled"
          ? "error"
          : aiElementsStatus(status),
        summary: message.reasoningSummary
          ? message.title ?? copy.message.thinking
          : message.status === "running" ? copy.message.thinking : copy.message.thinkingProcess
      });
      if (message.reasoningSummary) {
        this.scheduleDisclosureAutoFold(
          `reasoning:${disclosureKey}`,
          disclosureKey,
          this.reasoningDisclosureStates,
          reasoning.root,
          reasoning.summary
        );
      }
      let pendingUserDisclosureIntent = false;
      if (message.reasoningSummary) {
        reasoning.summary.onclick = (event) => {
          if (event.isTrusted) pendingUserDisclosureIntent = true;
        };
        reasoning.summary.onkeydown = (event) => {
          if (
            event.isTrusted
            && (
              event.key === "Enter"
              || event.key === " "
              || event.code === "Space"
            )
          ) {
            pendingUserDisclosureIntent = true;
          }
        };
      }
      reasoning.root.ontoggle = () => {
        if (message.reasoningSummary) {
          const current = this.reasoningDisclosureStates.get(disclosureKey)
            ?? nextReasoningDisclosureState(undefined, message.reasoningSummary.status);
          if (pendingUserDisclosureIntent) {
            this.cancelDisclosureAutoFold(`reasoning:${disclosureKey}`);
            this.reasoningDisclosureStates.set(disclosureKey, Object.freeze({
              ...current,
              open: reasoning.root.open,
              manual: true
            }));
          }
          pendingUserDisclosureIntent = false;
        } else {
          rememberOpenState(this.openProcessItems, message.id, reasoning.root.open);
        }
        reasoning.summary.setAttribute("aria-expanded", String(reasoning.root.open));
        env.onScheduleMeasure();
      };
      renderRichText(env.app, env.component, reasoning.body, displayTextForMessage(message));
      return;
    }
    if (isProcessItemType(message.itemType)) {
      this.renderProcessMessage(content, message, false, options.processExpanded === true);
      this.renderKnowledgeUsageCards(wrapper, message.id, knowledgeUsageMessageData(message), message.citations);
      return;
    }
    const displayText = firstPartyMessageText(message, env.settingsLanguage);
    if (!this.renderKnowledgeBaseResultContent(content, message, displayText)) {
      if (isAgentAnswerMessage(message)) this.renderAgentAnswerContent(content, message);
      else renderRichText(env.app, env.component, content, displayText);
    }
    if (message.rawRef) this.renderRawMessageExpander(content, message);
    if (message.itemType === "knowledgeBase" && message.details) this.renderKnowledgeBaseContextNote(wrapper, message.details);
    this.renderKnowledgeUsageCards(wrapper, message.id, knowledgeUsageMessageData(message), message.citations);
    if (message.role === "user") this.renderMessageCopyAction(wrapper, message, true);
    const footerActions = options.showAgentFooter
      ? this.renderAgentFooter(wrapper, message)
      : null;
    if (options.allowConversationDerive !== false) {
      this.renderPiConversationDeriveAction(
        footerActions ?? wrapper,
        message,
        Boolean(footerActions)
      );
    }
  }

  private renderAgentAnswerContent(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const text = displayTextForMessage(message);
    if (message.status === "running" && !text.trim()) {
      const copy = this.copy();
      const visualLabel = rotatingChoice(
        copy.message.generatingReplyCopies(env.agentIdentity?.personalityTemplateId),
        message.createdAt
      );
      const existingLoader = container.querySelector<HTMLElement>(
        ".codex-smooth-ai-loader"
      );
      if (existingLoader) {
        existingLoader
          .querySelector<HTMLElement>(".codex-smooth-ai-loader-label")
          ?.setText(visualLabel);
      } else {
        container.empty();
        const loader = renderSmoothAILoader(container, visualLabel, {
          accessibleLabel: copy.message.generatingReply,
          language: env.settingsLanguage,
          labelClass: "codex-ai-elements-shimmer",
          visualLabelAriaHidden: true
        });
        loader
          .querySelector<HTMLElement>(".codex-smooth-ai-loader-label")
          ?.setAttribute("data-ai-elements-pattern", "shimmer");
      }
      container.dataset.renderedText = text;
      env.onScheduleRunProgress();
      return;
    }
    renderRichText(env.app, env.component, container, text);
    container.dataset.renderedText = text;
    markAIElementsResponse(container, message.status === "running");
  }

  private renderAssistantFailureReason(
    container: HTMLElement,
    message: ChatMessage
  ): void {
    const existing = container.querySelector<HTMLElement>(
      ":scope > .codex-assistant-turn-failure-reason"
    );
    const text = message.status === "failed"
      ? firstPartyMessageDetail(
        message,
        message.details?.trim() ?? "",
        this.requireEnv().settingsLanguage
      )
      : "";
    if (!text) {
      existing?.remove();
      return;
    }
    const reason = existing ?? container.createDiv({
      cls: "codex-process-detail codex-assistant-turn-failure-reason"
    });
    if (reason.textContent !== text) reason.setText(text);
  }

  private renderTaskPlanCard(
    container: HTMLElement,
    message: ChatMessage
  ): void {
    const env = this.requireEnv();
    const plan = message.taskPlan;
    if (!plan) return;
    container.addClass("codex-message-task-plan");
    const progress = taskPlanProgress(plan);
    const expanded = this.openTaskPlans.get(message.id) ?? true;
    const stepsId = `codex-task-plan-steps-${safeDomIdentity(message.id)}`;
    const task = createAIElementsTask(container, {
      bodyId: stepsId,
      label: this.copy().task.planLabel(plan.title),
      open: expanded
    });
    task.root.addClass(`is-${plan.status}`);
    const header = task.summary;
    this.renderTaskPlanStatusIcon(
      header.createSpan({ cls: "codex-task-plan-status" }),
      plan.status
    );
    const heading = header.createSpan({ cls: "codex-task-plan-heading" });
    heading.createSpan({ cls: "codex-task-plan-title", text: plan.title });
    heading.createSpan({
      cls: "codex-task-plan-progress",
      text: taskPlanHistoryStatus(
        plan.status,
        progress.completed,
        progress.total,
        env.settingsLanguage
      )
    });
    const disclosure = header.createSpan({
      cls: "codex-task-plan-disclosure",
      attr: { "aria-hidden": "true" }
    });
    setIcon(disclosure, expanded ? "chevron-up" : "chevron-down");
    task.root.ontoggle = () => {
      this.openTaskPlans.set(message.id, task.root.open);
      header.setAttribute("aria-expanded", String(task.root.open));
      env.onScheduleMeasure();
    };

    const steps = task.body;
    for (const step of plan.steps) {
      const row = steps.createDiv({
        cls: `codex-task-plan-step is-${step.status}`
      });
      this.renderTaskPlanStatusIcon(
        row.createSpan({ cls: "codex-task-plan-step-status" }),
        step.status
      );
      const copy = row.createDiv({ cls: "codex-task-plan-step-copy" });
      copy.createDiv({ cls: "codex-task-plan-step-text", text: step.text });
      if (step.reason) {
        copy.createDiv({
          cls: "codex-task-plan-step-reason",
          text: step.reason
        });
      }
    }
    if (plan.reason) {
      steps.createDiv({ cls: "codex-task-plan-reason", text: plan.reason });
    }
  }

  private renderTaskPlanStatusIcon(
    container: HTMLElement,
    status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus
  ): void {
    container.addClass(`is-${status}`);
    container.setAttribute("role", "img");
    container.setAttribute("aria-label", taskPlanStatusLabel(
      status,
      this.requireEnv().settingsLanguage
    ));
    setIcon(container, taskPlanStatusIcon(status));
  }

  private renderPiConversationDeriveAction(
    container: HTMLElement,
    message: ChatMessage,
    inline: boolean
  ): void {
    const env = this.requireEnv();
    const entryId = piEntryIdFromProjectedMessageId(message.id);
    const label = piConversationDeriveActionLabel(message, env.settingsLanguage);
    if (!entryId || !label || !env.onDerivePiConversation) return;
    const actions = inline
      ? container
      : container.createDiv({ cls: "codex-message-derive-actions" });
    const button = actions.createEl("button", {
      cls: "codex-message-action codex-message-derive-action",
      attr: {
        type: "button",
        title: label,
        "aria-label": label,
        "aria-busy": "false"
      }
    });
    button.disabled = Boolean(env.piConversationDeriveDisabled);
    const icon = button.createSpan({
      cls: "codex-message-action-icon codex-message-derive-action-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(icon, "git-fork");
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await env.onDerivePiConversation?.(entryId);
      } finally {
        button.setAttribute("aria-busy", "false");
        button.disabled = Boolean(env.piConversationDeriveDisabled);
      }
    };
  }

  private renderMessageCopyAction(
    container: HTMLElement,
    message: ChatMessage,
    userMessage: boolean
  ): HTMLButtonElement {
    const env = this.requireEnv();
    const copy = this.copy();
    const idleLabel = userMessage ? copy.message.copyMessage : copy.message.copyAnswer;
    const successLabel = userMessage ? copy.message.messageCopied : copy.message.answerCopied;
    const failureLabel = userMessage ? copy.message.copyMessageFailed : copy.message.copyAnswerFailed;
    const copyButton = container.createEl("button", {
      cls: `codex-message-action ${userMessage ? "codex-user-message-copy" : "codex-answer-copy"}`,
      attr: {
        type: "button",
        title: idleLabel,
        "aria-label": idleLabel,
        "aria-live": "polite"
      }
    });
    const icon = copyButton.createSpan({
      cls: "codex-message-action-icon",
      attr: { "aria-hidden": "true" }
    });
    const renderIcon = (name: string) => {
      icon.empty();
      setIcon(icon, name);
    };
    renderIcon("copy");
    copyButton.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (copyButton.disabled) return;
      copyButton.disabled = true;
      const result = await copyAnswerMarkdown(
        message,
        env.readRawMessageText,
        (text) => navigator.clipboard.writeText(text)
      );
      if (result.status === "success") {
        renderIcon("check");
        copyButton.setAttr("title", copy.message.copied);
        copyButton.setAttr("aria-label", successLabel);
      } else {
        renderIcon("triangle-alert");
        copyButton.setAttr("title", copy.message.copyFailed);
        copyButton.setAttr("aria-label", failureLabel);
        new Notice(`${copy.message.copyFailed}: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
      }
      window.setTimeout(() => {
        renderIcon("copy");
        copyButton.setAttr("title", idleLabel);
        copyButton.setAttr("aria-label", idleLabel);
        copyButton.disabled = false;
      }, 1400);
    };
    return copyButton;
  }

  private renderAgentHeader(container: HTMLElement, input: { message?: ChatMessage; statusLabel: string; compact: boolean; agentIdentity?: AgentIdentityView }): void {
    const header = container.createDiv({ cls: "codex-agent-header" });
    header.toggleClass("is-compact", input.compact);
    // 未显式传入时读取当前渲染环境的身份快照（消息头全部使用同一份
    // 当前身份，不做逐消息持久化）。
    const identity = input.agentIdentity ?? this.env?.agentIdentity;
    const displayName = identity?.displayName?.trim() || "EchoInk";
    const avatarUrl = identity?.avatarUrl ?? null;
    const avatar = header.createSpan({ cls: "codex-agent-avatar", attr: { "aria-hidden": "true" } });
    if (avatarUrl) {
      // 自定义 / preset 头像：装饰性图片，容器保持 aria-hidden。
      avatar.addClass("has-image");
      avatar.createEl("img", { attr: { src: avatarUrl, alt: "" } });
    } else {
      setIcon(avatar, "bot");
    }
    const main = header.createDiv({ cls: "codex-agent-header-main" });
    const nameRow = main.createDiv({ cls: "codex-agent-name-row" });
    nameRow.createSpan({ cls: "codex-agent-name", text: displayName });
    const agent = input.message ? agentModelLine(input.message) : "";
    if (agent) nameRow.createSpan({ cls: "codex-agent-model-pill", text: `· ${agent}` });
    if (input.statusLabel) main.createDiv({ cls: "codex-agent-status-line", text: input.statusLabel });
  }

  private renderAgentFooter(
    container: HTMLElement,
    message: ChatMessage
  ): HTMLElement {
    const language = this.requireEnv().settingsLanguage;
    const footer = container.createDiv({ cls: "codex-agent-footer" });
    const actions = footer.createDiv({ cls: "codex-agent-footer-actions" });
    this.renderMessageCopyAction(actions, message, false);
    const runtime = footer.createSpan({
      cls: "codex-agent-footer-runtime",
      attr: {
        title: message.providerId || conversationUiText(
          language,
          "历史消息未记录 Provider 身份",
          "Provider information was not recorded for this historical message"
        )
      }
    });
    const providerIcon = runtime.createSpan({
      cls: "codex-agent-footer-provider-icon",
      attr: { "aria-hidden": "true" }
    });
    renderProviderBrandIcon(providerIcon, providerBrandForMessage(message));
    runtime.createSpan({
      cls: "codex-agent-footer-model",
      text: message.modelId?.trim() || conversationUiText(language, "未知模型", "Unknown model")
    });
    const time = formatAnswerFooterTime(message.completedAt ?? message.createdAt, language);
    if (time) footer.createSpan({ cls: "codex-agent-footer-time", text: time });
    return actions;
  }

  private renderKnowledgeBaseResultContent(container: HTMLElement, message: ChatMessage, text: string): boolean {
    const env = this.requireEnv();
    if (message.itemType === "knowledgeBase" && message.knowledgeBaseUi) {
      markSmoothAIArtifact(container);
      this.renderKnowledgeBaseUiPayload(container, message.knowledgeBaseUi, message);
      return true;
    }
    const result = extractKnowledgeBaseResultTitle(message.itemType, text);
    if (!result) return false;
    markSmoothAIArtifact(container);
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
    this.renderKnowledgeBaseMaintainReportCard(container, payload, message);
  }

  private renderKnowledgeBaseRunCard(container: HTMLElement, payload: KnowledgeBaseRunPayload, message: ChatMessage): void {
    const language = this.requireEnv().settingsLanguage;
    const status = message.status ?? "running";
    const card = container.createDiv({ cls: `codex-kb-run-card codex-kb-run-card-${status}` });
    const head = card.createDiv({ cls: "codex-kb-run-head" });
    const mark = head.createSpan({ cls: "codex-kb-run-mark" });
    setIcon(mark, knowledgeBaseRunStatusIcon(payload, status));
    const text = head.createDiv({ cls: "codex-kb-run-copy" });
    text.createDiv({ cls: "codex-kb-run-title", text: knowledgeBaseRunDisplayTitle(payload, status, language) });
    const liveCopy = knowledgeBaseRunEventCopy(payload, language);
    if (liveCopy) text.createDiv({ cls: "codex-kb-run-subtitle", text: liveCopy });
    const track = card.createDiv({ cls: "codex-kb-run-track" });
    const eventProgress = knowledgeBaseRunProgressStateFromEvents(status, payload.events ?? [], payload.phases.length);
    const timedProgress = knowledgeBaseRunProgressState(status, message.createdAt, Date.now(), payload.phases.length);
    const { totalCells, filledCells, activeIndex } = eventProgress ?? {
      totalCells: timedProgress.totalCells,
      filledCells: timedProgress.filledCells,
      activeIndex: timedProgress.activeIndex
    };
    payload.phases.forEach((phase, index) => {
      const node = track.createDiv({ cls: `codex-kb-run-node codex-kb-run-node-${phase.id} codex-kb-run-motion-${phase.motion}` });
      node.toggleClass("is-done", filledCells >= totalCells || index < activeIndex);
      node.toggleClass("is-active", index === activeIndex);
      const rail = node.createDiv({ cls: "codex-kb-run-phase-rail" });
      const icon = rail.createSpan({ cls: "codex-kb-run-node-icon" });
      setIcon(icon, phase.icon);
      if (index < payload.phases.length - 1) {
        rail.createSpan({ cls: "codex-kb-run-phase-connector" });
      }
      const body = node.createDiv({ cls: "codex-kb-run-phase-body" });
      const labelRow = body.createDiv({ cls: "codex-kb-run-phase-label-row" });
      labelRow.createSpan({ cls: "codex-kb-run-node-label", text: phase.label });
      if (index === activeIndex) {
        const statusCopy = labelRow.createSpan({ cls: "codex-kb-run-phase-status-copy" });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-rule" });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-dot" });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-text", text: liveCopy || payload.subtitle });
        statusCopy.createSpan({ cls: "codex-kb-run-phase-status-rule" });
      }
    });
  }

  private renderKnowledgeBaseMaintainReportCard(container: HTMLElement, payload: KnowledgeBaseMaintainReportPayload, message: ChatMessage): void {
    const language = this.requireEnv().settingsLanguage;
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
      open.createSpan({ text: conversationUiText(language, "打开报告", "Open report") });
      open.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openKnowledgeBasePath(payload.reportPath);
      };
    }
    const executionItems = knowledgeBaseMaintainExecutionItems(payload, language);
    if (executionItems.length) {
      const execution = card.createDiv({ cls: "codex-kb-maintain-execution" });
      for (const item of executionItems) {
        execution.createSpan({ cls: "codex-kb-maintain-execution-item", text: item });
      }
    }
    const care = card.createDiv({ cls: "codex-kb-maintain-care" });
    care.createDiv({
      cls: "codex-kb-maintain-section-title",
      text: conversationUiText(language, "我应该关心", "What matters")
    });
    const careList = care.createDiv({ cls: "codex-kb-maintain-care-list" });
    for (const item of payload.careItems) {
      const row = careList.createDiv({ cls: `codex-kb-maintain-care-item codex-kb-maintain-care-${item.tone}` });
      const bullet = row.createSpan({ cls: "codex-kb-maintain-care-icon" });
      setIcon(bullet, item.tone === "warning" ? "triangle-alert" : item.tone === "info" ? "info" : "check");
      row.createSpan({ cls: "codex-kb-maintain-care-text", text: item.text });
    }
    if (payload.sections.length) {
      const sections = card.createDiv({ cls: "codex-kb-maintain-sections" });
      const firstOpenSection = payload.sections.find((section) => section.count > 0)?.id;
      for (const section of payload.sections) {
        const sectionStateKey = `kb-maintain-report:${message.id}:${section.id}`;
        const details = sections.createEl("details", { cls: "codex-kb-maintain-section" });
        details.open = knowledgeBaseMaintainSectionOpenState(
          this.openKnowledgeBaseReportSections.get(sectionStateKey),
          section.id === firstOpenSection
        );
        details.ontoggle = () => {
          this.openKnowledgeBaseReportSections.set(sectionStateKey, details.open);
          this.requireEnv().onScheduleMeasure();
        };
        const summary = details.createEl("summary", { cls: "codex-kb-maintain-section-summary" });
        summary.createSpan({ cls: "codex-kb-maintain-section-name", text: section.title });
        summary.createSpan({ cls: "codex-kb-maintain-section-count", text: String(section.count) });
        const chevron = summary.createSpan({ cls: "codex-kb-maintain-section-chevron" });
        setIcon(chevron, "chevron-right");
        const body = details.createDiv({ cls: "codex-kb-maintain-section-body" });
        if (!section.items.length) {
          body.createDiv({ cls: "codex-kb-maintain-empty", text: section.emptyText });
          continue;
        }
        for (const item of section.items) {
          const row = body.createDiv({ cls: `codex-kb-maintain-detail codex-kb-maintain-detail-${item.tone ?? "info"}` });
          const itemPath = knowledgeBaseMaintainReportItemPath(item);
          if (itemPath) {
            const title = row.createEl("button", {
              cls: "codex-kb-maintain-detail-title codex-kb-maintain-detail-link",
              text: item.title,
              attr: {
                type: "button",
                title: conversationUiText(language, `打开 ${itemPath}`, `Open ${itemPath}`)
              }
            });
            title.onclick = (event) => {
              event.preventDefault();
              event.stopPropagation();
              void this.openKnowledgeBasePath(itemPath);
            };
          } else {
            row.createDiv({ cls: "codex-kb-maintain-detail-title", text: item.title });
          }
          row.createDiv({ cls: "codex-kb-maintain-detail-desc", text: item.description });
        }
      }
    }
  }

  private async openKnowledgeBasePath(path: string): Promise<void> {
    const env = this.requireEnv();
    const normalized = normalizePath(path);
    const file = env.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await env.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    const absolute = `${env.vaultPath.replace(/\/$/, "")}/${normalized}`;
    if (showItemInFinder(absolute)) return;
    new Notice(conversationUiText(
      env.settingsLanguage,
      `没有在当前 Obsidian 仓库找到：${path}`,
      `Not found in the current Obsidian vault: ${path}`
    ));
  }

  private renderKnowledgeUsageCards(
    container: HTMLElement,
    messageId: string,
    usage: KnowledgeUsageMessageData,
    citations?: KnowledgeBaseCitationSummary
  ): void {
    const env = this.requireEnv();
    const copy = this.copy();
    const documents = localDocumentSources(citations, usage);
    if (usage.askSourceAttribution && !documents.some((document) => document.kind === "vault")) {
      container.createDiv({ cls: "codex-kb-no-evidence codex-ai-elements-sources-empty", text: copy.sources.noEvidence });
    }
    if (documents.length) {
      const stateKey = `knowledge-documents:${messageId}`;
      const sources = createAIElementsDocumentSources(
        container,
        documents.length,
        this.openKnowledgeBaseCitations.get(stateKey) ?? false,
        env.settingsLanguage
      );
      sources.root.ontoggle = () => {
        this.openKnowledgeBaseCitations.set(stateKey, sources.root.open);
        sources.summary.setAttribute("aria-expanded", String(sources.root.open));
        this.requireEnv().onScheduleMeasure();
      };
      for (const document of documents) {
        this.renderLocalDocumentSource(sources.body, document, citations?.status);
      }
    } else if (citations && !usage.askSourceAttribution) {
      container.createDiv({
        cls: "codex-kb-no-evidence codex-ai-elements-sources-empty",
        text: copy.sources.noEvidence
      });
    }
    if (usage.producedPaths.length) {
      this.renderProducedArtifactSources(
        container,
        usage.producedPaths,
        copy.process.artifactsTitle,
        true
      );
    }
  }

  private renderLocalDocumentSource(
    container: HTMLElement,
    document: LocalDocumentSource,
    evidenceStatus?: KnowledgeBaseCitationSummary["status"]
  ): void {
    const copy = this.copy();
    const item = container.createDiv({
      cls: `codex-ai-elements-source is-${document.kind}`,
      attr: { "data-source-key": document.key }
    });
    const header = item.createDiv({ cls: "codex-ai-elements-source-header" });
    const icon = header.createSpan({
      cls: "codex-ai-elements-source-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(icon, "book-open");
    if (document.kind === "memory") {
      header.createSpan({
        cls: "codex-ai-elements-source-title codex-message-note-link is-disabled",
        text: document.source.title,
        attr: { title: copy.sources.noVaultPath }
      });
      return;
    }

    const env = this.requireEnv();
    const file = env.app.vault.getAbstractFileByPath(document.path);
    const noteName = noteNameForPath(document.path);
    if (file instanceof TFile) {
      const title = header.createEl("button", {
        cls: "codex-ai-elements-source-title codex-message-note-link",
        text: noteName,
        attr: {
          type: "button",
          "aria-label": copy.sources.openNote(noteName),
          "data-path": document.path,
          title: copy.sources.openInObsidian(document.path)
        }
      });
      title.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openLocalDocumentSource(document);
      };
    } else {
      header.createSpan({
        cls: "codex-ai-elements-source-title codex-message-note-link is-disabled",
        text: noteName,
        attr: { title: copy.sources.missingInVault(document.path) }
      });
    }

    const metadata = localDocumentMetadata(
      document,
      evidenceStatus,
      this.requireEnv().settingsLanguage
    );
    if (metadata.length) {
      const meta = item.createDiv({ cls: "codex-ai-elements-source-meta" });
      for (const label of metadata) meta.createSpan({ text: label });
    }
    for (const excerpt of localDocumentExcerpts(document)) {
      const quote = item.createDiv({ cls: "codex-kb-citation-quote" });
      for (const line of excerpt.split(/\r\n|\n|\r/u)) {
        quote.createDiv({ cls: "codex-kb-citation-line", text: line });
      }
    }
  }

  private renderProducedArtifactSources(
    container: HTMLElement,
    producedPaths: readonly string[],
    label: string,
    showLabel: boolean
  ): void {
    const sources = createAIElementsArtifactSources(
      container,
      label,
      showLabel
    );
    sources.root.toggleClass("is-embedded", !showLabel);
    for (const producedPath of producedPaths) {
      this.renderKnowledgeProducedPath(sources.list, producedPath);
    }
  }

  private renderKnowledgeProducedPath(container: HTMLElement, producedPath: string): void {
    const copy = this.copy();
    const title = container.createEl("button", {
      cls: "codex-ai-elements-artifact-source",
      text: noteNameForPath(producedPath),
      attr: {
        type: "button",
        "aria-label": copy.sources.openNote(noteNameForPath(producedPath)),
        "data-path": producedPath,
        title: copy.details.open(producedPath)
      }
    });
    title.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openKnowledgeBasePath(producedPath);
    };
  }

  private async openLocalDocumentSource(document: LocalVaultDocumentSource): Promise<void> {
    const reference = document.references[0];
    if (reference) {
      await this.openKnowledgeReference(reference);
      return;
    }
    const env = this.requireEnv();
    const file = env.app.vault.getAbstractFileByPath(document.path);
    if (!(file instanceof TFile)) {
      new Notice(conversationUiText(
        env.settingsLanguage,
        `没有在当前 Obsidian 仓库找到：${document.path}`,
        `Not found in the current Obsidian vault: ${document.path}`
      ));
      return;
    }
    await env.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }

  private async openKnowledgeReference(reference: KnowledgeReference): Promise<void> {
    const env = this.requireEnv();
    const normalized = normalizePath(reference.vaultRelativePath);
    const file = env.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      new Notice(conversationUiText(
        env.settingsLanguage,
        `没有在当前 Obsidian 仓库找到：${reference.vaultRelativePath}`,
        `Not found in the current Obsidian vault: ${reference.vaultRelativePath}`
      ));
      return;
    }
    const leaf = env.app.workspace.getLeaf("tab");
    const firstLine = Math.max(0, reference.lineStart - 1);
    await leaf.openFile(file, {
      active: true,
      eState: { line: firstLine }
    });
    const editor = (leaf.view as { editor?: Editor }).editor;
    if (!editor) return;
    const availableLastLine = Math.max(0, editor.lineCount() - 1);
    const clampedFirstLine = Math.min(firstLine, availableLastLine);
    const lastLine = Math.min(
      Math.max(clampedFirstLine, reference.lineEnd - 1),
      availableLastLine
    );
    const from = { line: clampedFirstLine, ch: 0 };
    const to = { line: lastLine, ch: editor.getLine(lastLine).length };
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    editor.focus();
  }

  private renderKnowledgeBaseContextNote(container: HTMLElement, details: string): void {
    const normalized = details.trim();
    if (!normalized) return;
    const note = container.createDiv({ cls: "codex-kb-context-note" });
    const icon = note.createSpan({ cls: "codex-kb-context-note-icon" });
    setIcon(icon, "message-square-share");
    note.createSpan({ cls: "codex-kb-context-note-text", text: normalized });
  }

  private renderAssistantTurn(
    container: HTMLElement,
    turn: AgentTurnView,
    showAgentHeader: boolean
  ): void {
    const env = this.requireEnv();
    const copy = this.copy();
    const identityMessage = turn.finalAnswer ?? turn.messages[0];
    const wrapper = container.createDiv({
      cls: `codex-message codex-message-assistant codex-message-type-assistantTurn is-${turn.status}`
    });
    markAIElementsMessage(wrapper, "assistant");
    wrapper.dataset.turnKey = turn.key;
    wrapper.setAttribute("data-bubble", "false");
    if (showAgentHeader && identityMessage) {
      this.renderAgentHeader(wrapper, {
        message: identityMessage,
        statusLabel: "",
        compact: false
      });
    }
    const bodyHost = createAIElementsMessageContent(wrapper);
    bodyHost.addClass("codex-assistant-turn");

    if (turn.processNodes.length) {
      this.renderAssistantTurnProcess(bodyHost, turn);
    }

    const answer = turn.finalAnswer;
    const hasDisplayableAnswer = Boolean(
      answer
      && (
        displayTextForMessage(answer).trim()
        || (answer.status === "running" && !isTerminalTurnStatus(turn.status))
      )
    );
    if (answer && hasDisplayableAnswer) {
      const answerSection = bodyHost.createDiv({ cls: "codex-assistant-turn-final" });
      answerSection.dataset.messageId = answer.id;
      this.renderAssistantTurnSectionLabel(
        answerSection,
        copy.sections.answer
      );
      const answerContent = answerSection.createDiv({
        cls: "codex-message-content codex-assistant-turn-answer",
        attr: { "data-message-content": "true" }
      });
      this.renderAgentAnswerContent(answerContent, answer);
      this.renderAssistantFailureReason(answerSection, answer);
      if (isTerminalTurnStatus(turn.status)) {
        const footerActions = this.renderAgentFooter(answerSection, answer);
        this.renderPiConversationDeriveAction(footerActions, answer, true);
      }
    }

    const terminalMessage = !hasDisplayableAnswer && isTerminalTurnStatus(turn.status)
      ? turn.messages.slice().reverse().find((message) =>
          message.role === "system"
          && message.itemType === "error"
          && displayTextForMessage(message).trim()
        )
      : undefined;
    if (terminalMessage) {
      this.renderMessage(bodyHost, terminalMessage, {
        showAgentHeader: false,
        showAgentFooter: false,
        allowConversationDerive: false
      });
      return;
    }

    if (!turn.processNodes.length && !hasDisplayableAnswer) {
      const empty = bodyHost.createDiv({ cls: "codex-assistant-turn-empty" });
      if (
        turn.status === "preparing"
        || turn.status === "running"
        || turn.status === "completing"
      ) {
        renderSmoothAILoader(empty, copy.message.preparingReply, {
          language: env.settingsLanguage
        });
        env.onScheduleRunProgress();
      } else {
        empty.setText(formatAgentTurnSummary(turn, env.settingsLanguage));
      }
    }
  }

  private renderAssistantTurnProcess(
    container: HTMLElement,
    turn: AgentTurnView
  ): void {
    const disclosureStatus = isTerminalTurnStatus(turn.status) ? turn.status : "running";
    const elements = createAIElementsChainOfThought(container, {
      status: aiElementsStatus(disclosureStatus)
    });
    const root = elements.root;
    root.addClass("codex-assistant-turn-process");
    root.addClass(`is-${turn.status}`);
    root.setAttribute("data-turn-status", turn.status);
    const body = elements.body;
    body.addClass("codex-assistant-turn-process-body");
    body.addClass("codex-assistant-turn-spine");
    for (const node of turn.processNodes) {
      if (actionMessageForProcessNode(turn, node)) {
        this.renderAssistantTurnActionNode(body, turn, node);
      } else {
        this.renderAssistantTurnProcessNode(body, turn, node);
      }
    }
  }

  private renderAssistantTurnActionNode(
    container: HTMLElement,
    turn: AgentTurnView,
    node: Readonly<EchoInkTurnProcessNode>
  ): void {
    const message = actionMessageForProcessNode(turn, node);
    if (!message) {
      this.renderAssistantTurnProcessNode(container, turn, node);
      return;
    }
    const item = buildActionTimeline([message], this.requireEnv().settingsLanguage)
      .groups[0]?.items[0];
    if (!item) {
      this.renderAssistantTurnProcessNode(container, turn, node);
      return;
    }
    const row = this.renderActionItem(container, item, {
      standalone: false,
      showApprovalCard: false
    });
    row.addClass("codex-assistant-turn-action-node");
    this.applyAssistantTurnActionSemantics(row, item);
    row.addClass(`is-${node.status}`);
    row.dataset.nodeId = node.nodeId;
    row.dataset.messageId = item.source.id;
    row.dataset.nodeStatus = node.status;
    row.toggleClass("is-current", node.nodeId === turn.currentNodeId);
  }

  private applyAssistantTurnActionSemantics(
    row: HTMLElement,
    item: ActionItemViewModel
  ): void {
    if (!row.hasClass("codex-assistant-turn-action-node")) return;
    row.querySelector<HTMLElement>(".codex-action-item-prefix")?.remove();
    row.querySelector<HTMLElement>(".codex-action-item-state")?.remove();
    if (item.status !== "failed") return;
    row.querySelector<HTMLElement>(".codex-action-item-main")?.createSpan({
      cls: "codex-action-item-state",
      text: labelForStatus(item.status, this.requireEnv().settingsLanguage)
    });
  }

  private renderAssistantTurnProcessNode(
    container: HTMLElement,
    turn: AgentTurnView,
    node: Readonly<EchoInkTurnProcessNode>
  ): void {
    if (node.kind === "reasoning" && node.nodeId.startsWith("provider-reasoning:")) {
      this.renderProviderReasoningNode(container, turn, node);
      return;
    }
    const row = container.createDiv({
      cls: `codex-assistant-turn-node is-${node.status} is-${node.kind}`
    });
    row.dataset.nodeId = node.nodeId;
    row.toggleClass("is-current", node.nodeId === turn.currentNodeId);
    if (node.sourceMessageId) row.dataset.messageId = node.sourceMessageId;

    const icon = row.createSpan({
      cls: "codex-assistant-turn-node-icon",
      attr: { "aria-hidden": "true" }
    });
    setSemanticIcon(icon, assistantTurnNodeIcon(node));

    const content = row.createDiv({ cls: "codex-assistant-turn-node-content" });
    const heading = content.createDiv({ cls: "codex-assistant-turn-node-heading" });
    const title = heading.createSpan({
      cls: "codex-assistant-turn-node-title",
      text: node.title,
      attr: { title: node.title }
    });
    if (node.status === "running") {
      title.setAttribute("aria-label", `${node.title}, ${this.copy().process.nodeStatus(node.status)}`);
    }
    if (node.summary) {
      heading.createSpan({
        cls: "codex-assistant-turn-node-summary",
        text: node.summary,
        attr: { title: node.summary }
      });
    }

    this.renderAssistantTurnNodeDetail(content, turn, node);
  }

  private renderAssistantTurnNodeDetail(
    container: HTMLElement,
    turn: AgentTurnView,
    node: Readonly<EchoInkTurnProcessNode>
  ): void {
    const source = node.sourceMessageId
      ? turn.messages.find((message) => message.id === node.sourceMessageId)
      : undefined;
    if (!source) return;
    if (node.nodeId.startsWith("process-activity:")) return;
    if (node.kind === "interaction") return;
    if (node.kind === "task" && source.taskPlan) {
      this.renderCompactTaskPlanNode(container, source);
      return;
    }
    if (node.kind === "retrieval" && node.nodeId.startsWith("sources:")) {
      const usage = knowledgeUsageMessageData(source);
      this.renderKnowledgeUsageCards(
        container,
        `${turn.key}:${node.nodeId}`,
        { ...usage, producedPaths: [] },
        source.citations
      );
      return;
    }
    if (node.kind === "artifact" && node.nodeId.startsWith("artifacts:")) {
      this.renderProducedArtifactsNode(container, source);
      return;
    }
    if (source.itemType === "thinking") {
      if (source.status === "running") {
        renderSmoothAILoader(container, source.text || this.copy().message.organizingContext, {
          language: this.requireEnv().settingsLanguage
        });
      }
      return;
    }
    if (source.reasoningSummary) return;
    if (isActionTimelineItem(source)) {
      const item = buildActionTimeline(
        [source],
        this.requireEnv().settingsLanguage
      ).groups[0]?.items[0];
      if (item) this.renderActionItem(
        container.createDiv({ cls: "codex-action-region codex-action-stream" }),
        item,
        { standalone: false, showApprovalCard: false }
      );
      return;
    }
    if (isAgentProcessItemType(source.itemType)) {
      this.renderProcessMessage(container, source, true, false, false);
      return;
    }
    if (source.itemType === "knowledgeBase") {
      const details = this.createAssistantTurnResourceDisclosure(
        container,
        `${turn.key}:${node.nodeId}`,
        node.title
      );
      this.renderKnowledgeBaseResultContent(
        details.body,
        source,
        firstPartyMessageText(source, this.requireEnv().settingsLanguage)
      );
    }
  }

  private renderProviderReasoningNode(
    container: HTMLElement,
    turn: AgentTurnView,
    node: Readonly<EchoInkTurnProcessNode>
  ): void {
    const env = this.requireEnv();
    const copy = this.copy();
    const reasoningId = node.nodeId.slice("provider-reasoning:".length);
    const reasoning = turn.providerReasoningSegments.find((segment) =>
      segment.reasoningId === reasoningId
    );
    if (!reasoning) return;
    const disclosureKey = `${env.sessionId}\0${turn.key}\0provider-reasoning\0${reasoning.reasoningId}`;
    const disclosure = nextReasoningDisclosureState(
      this.reasoningDisclosureStates.get(disclosureKey),
      reasoning.status
    );
    this.reasoningDisclosureStates.set(disclosureKey, disclosure);
    const bodyId = stableDomId(`codex-provider-reasoning-${disclosureKey}`);
    const elements = createAIElementsReasoning(container, {
      bodyId,
      open: disclosure.open,
      status: reasoning.status === "failed" || reasoning.status === "cancelled" || reasoning.status === "interrupted"
        ? "error"
        : aiElementsStatus(reasoning.status),
      summary: reasoning.status === "running"
        ? copy.process.publicReasoningRunning
        : reasoning.durationMs === undefined
          ? copy.process.publicReasoningCompleted
          : copy.process.publicReasoningDuration(formatCompactDuration(reasoning.durationMs))
    });
    elements.root.addClass("codex-assistant-turn-reasoning-node");
    elements.root.addClass(`is-${node.status}`);
    elements.root.toggleClass("is-current", node.nodeId === turn.currentNodeId);
    elements.root.dataset.nodeId = node.nodeId;
    elements.root.dataset.nodeStatus = node.status;
    elements.root.dataset.reasoningId = reasoning.reasoningId;
    const carrier = turn.messages.find((message) =>
      message.assistantTurn?.providerReasoningSegments?.some((segment) =>
        segment.reasoningId === reasoning.reasoningId
      )
    );
    if (carrier) elements.root.dataset.messageId = carrier.id;
    const displayText = userVisibleProviderReasoningText(
      reasoning.text,
      assistantTurnHasPersonalMemoryContext(turn)
    );
    elements.body.dataset.renderedText = displayText;
    this.scheduleDisclosureAutoFold(
      `reasoning:${disclosureKey}`,
      disclosureKey,
      this.reasoningDisclosureStates,
      elements.root,
      elements.summary
    );
    let pendingUserDisclosureIntent = false;
    elements.summary.onclick = (event) => {
      if (event.isTrusted) pendingUserDisclosureIntent = true;
    };
    elements.summary.onkeydown = (event) => {
      if (
        event.isTrusted
        && (event.key === "Enter" || event.key === " " || event.code === "Space")
      ) pendingUserDisclosureIntent = true;
    };
    elements.root.ontoggle = () => {
      const current = this.reasoningDisclosureStates.get(disclosureKey) ?? disclosure;
      if (pendingUserDisclosureIntent) {
        this.cancelDisclosureAutoFold(`reasoning:${disclosureKey}`);
        this.reasoningDisclosureStates.set(disclosureKey, Object.freeze({
          ...current,
          open: elements.root.open,
          manual: true
        }));
      }
      pendingUserDisclosureIntent = false;
      elements.summary.setAttribute("aria-expanded", String(elements.root.open));
      env.onScheduleMeasure();
    };
    if (displayText.trim()) {
      renderRichText(env.app, env.component, elements.body, displayText);
      if (reasoning.status === "running") {
        elements.body.scrollTop = elements.body.scrollHeight;
      }
    }
  }

  private renderCompactTaskPlanNode(container: HTMLElement, message: ChatMessage): void {
    const plan = message.taskPlan;
    if (!plan) return;
    const chrome = this.copy();
    const progress = taskPlanProgress(plan);
    const current = plan.steps.find((step) => step.stepId === plan.currentStepId);
    const compact = container.createDiv({
      cls: `codex-assistant-turn-task-summary is-${plan.status}`,
      attr: {
        "aria-label": chrome.process.taskAria(plan.title, progress.completed, progress.total)
      }
    });
    this.renderTaskPlanStatusIcon(
      compact.createSpan({ cls: "codex-assistant-turn-task-status" }),
      plan.status
    );
    const copy = compact.createDiv({ cls: "codex-assistant-turn-task-copy" });
    copy.createSpan({
      cls: "codex-assistant-turn-task-progress",
      text: chrome.process.taskProgress(progress.completed, progress.total)
    });
    if (current?.text) {
      copy.createSpan({
        cls: "codex-assistant-turn-task-current",
        text: current.text,
        attr: { title: current.text }
      });
    } else if (plan.lastUpdateSummary?.trim()) {
      copy.createSpan({
        cls: "codex-assistant-turn-task-current",
        text: plan.lastUpdateSummary.trim(),
        attr: { title: plan.lastUpdateSummary.trim() }
      });
    }
  }

  private renderProducedArtifactsNode(
    container: HTMLElement,
    message: ChatMessage
  ): void {
    const usage = knowledgeUsageMessageData(message);
    if (!usage.producedPaths.length) return;
    this.renderProducedArtifactSources(
      container,
      usage.producedPaths,
      this.copy().process.artifactCount(usage.producedPaths.length),
      false
    );
  }

  private createAssistantTurnResourceDisclosure(
    container: HTMLElement,
    stateKey: string,
    label: string
  ): { root: HTMLDetailsElement; body: HTMLElement } {
    const env = this.requireEnv();
    const bodyId = stableDomId(`codex-assistant-turn-resource-${stateKey}`);
    const root = container.createEl("details", { cls: "codex-assistant-turn-resource" });
    root.open = this.openProcessItems.get(stateKey) ?? false;
    const summary = root.createEl("summary", {
      cls: "codex-assistant-turn-resource-summary",
      text: label,
      attr: {
        "aria-controls": bodyId,
        "aria-expanded": String(root.open),
        title: label
      }
    });
    const body = root.createDiv({
      cls: "codex-assistant-turn-resource-body",
      attr: { id: bodyId }
    });
    root.ontoggle = () => {
      rememberOpenState(this.openProcessItems, stateKey, root.open);
      summary.setAttribute("aria-expanded", String(root.open));
      env.onScheduleMeasure();
    };
    return { root, body };
  }

  private renderAssistantTurnSectionLabel(
    container: HTMLElement,
    label: string
  ): HTMLElement {
    const heading = container.createSpan({
      cls: "codex-assistant-turn-section-label",
      attr: { role: "heading", "aria-level": "3" }
    });
    heading.createSpan({
      cls: "codex-assistant-turn-section-primary",
      text: label
    });
    return heading;
  }

  private renderActionStreamItem(container: HTMLElement, message: ChatMessage, showAgentHeader: boolean): void {
    const timeline = buildActionTimeline([message], this.requireEnv().settingsLanguage);
    const item = timeline.groups[0]?.items[0];
    if (!item) return;
    const wrapper = container.createDiv({ cls: "codex-message codex-message-tool codex-message-type-actionStream" });
    markAIElementsMessage(wrapper, "tool");
    wrapper.dataset.messageId = message.id;
    if (showAgentHeader) this.renderAgentHeader(wrapper, {
      message,
      statusLabel: "",
      compact: true
    });
    const region = wrapper.createDiv({ cls: "codex-action-region codex-action-stream" });
    this.renderActionItem(region, item, { standalone: false });
    this.renderKnowledgeUsageCards(wrapper, message.id, knowledgeUsageMessageData(message));
  }

  private renderCompletedTurnProcess(container: HTMLElement, turn: CompletedAgentTurn, showAgentHeader: boolean): void {
    const stateId = `${turn.key}:${turn.finalAnswer.id}`;
    const wrapper = container.createDiv({ cls: "codex-message codex-message-tool codex-message-type-turnProcess" });
    markAIElementsMessage(wrapper, "tool");
    if (showAgentHeader) this.renderAgentHeader(wrapper, { message: turn.finalAnswer, statusLabel: "", compact: true });
    const chain = createAIElementsChainOfThought(wrapper, {
      status: aiElementsStatus(turn.failed ? "failed" : turn.requiresAttention ? "blocked" : "completed")
    });
    const region = chain.root;
    region.addClass("codex-turn-process");
    const body = chain.body;
    body.addClass("codex-turn-process-body");
    for (const message of turn.processMessages) this.renderTurnProcessMessage(body, message);
    this.renderKnowledgeUsageCards(
      wrapper,
      `turn:${stateId}`,
      mergeKnowledgeUsageMessageData(turn.processMessages)
    );
  }

  private renderTurnProcessMessage(container: HTMLElement, message: ChatMessage): void {
    if (isActionTimelineItem(message)) {
      const item = buildActionTimeline(
        [message],
        this.requireEnv().settingsLanguage
      ).groups[0]?.items[0];
      if (item) this.renderActionItem(container.createDiv({ cls: "codex-action-region codex-action-stream" }), item, { standalone: false });
      return;
    }
    this.renderMessage(container, message, {
      showAgentHeader: false,
      showAgentFooter: false,
      processExpanded: true,
      allowConversationDerive: false
    });
  }

  private renderActionItem(
    container: HTMLElement,
    item: ActionItemViewModel,
    options: { standalone: boolean; showApprovalCard?: boolean }
  ): HTMLElement {
    if (hasActionItemDetails(item)) {
      return this.renderExpandableActionItem(container, item, options);
    }
    const row = container.createDiv({ cls: `codex-action-item codex-action-item-${item.kind}` });
    row.dataset.messageId = item.source.id;
    markAIElementsTool(row, item.status);
    const approvalState = approvalStateForMessage(item.source);
    if (approvalState) markSmoothAIApproval(row, approvalState);
    row.toggleClass("is-standalone", options.standalone);
    row.toggleClass("is-failed", isAttentionActionStatus(item.status));
    row.toggleClass("is-running", isActiveActionStatus(item.status));
    const head = row.createDiv({ cls: "codex-action-item-head" });
    this.renderActionItemHead(head, item);
    if (options.showApprovalCard !== false) this.renderApprovalCard(row, item.source);
    return row;
  }

  private renderExpandableActionItem(
    container: HTMLElement,
    item: ActionItemViewModel,
    options: { standalone: boolean; showApprovalCard?: boolean }
  ): HTMLElement {
    const detailId = stableDomId(`codex-action-detail-${item.id}`);
    const details = container.createEl("details", { cls: `codex-action-item codex-action-item-${item.kind} codex-action-item-expandable` });
    details.dataset.messageId = item.source.id;
    markAIElementsTool(details, item.status);
    const approvalState = approvalStateForMessage(item.source);
    if (approvalState) markSmoothAIApproval(details, approvalState);
    details.toggleClass("is-standalone", options.standalone);
    details.toggleClass("is-failed", isAttentionActionStatus(item.status));
    details.toggleClass("is-running", isActiveActionStatus(item.status));
    details.open = this.openActionItemDetails.get(item.id) ?? false;
    let summary: HTMLElement | null = null;
    let caret: HTMLElement | null = null;
    let body: HTMLElement | null = null;
    const renderBody = () => {
      if (body) return;
      body = details.createDiv({ cls: "codex-action-item-details-body", attr: { id: detailId } });
      this.renderActionItemDetails(body, item);
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
        title: actionItemDetailLabel(item, this.requireEnv().settingsLanguage)
      }
    });
    this.renderActionItemHead(summary, item);
    caret = summary.createSpan({ cls: "codex-action-item-caret" });
    setIcon(caret, details.open ? "chevron-up" : "chevron-down");
    if (options.showApprovalCard !== false) {
      this.renderApprovalCard(container, item.source);
    }
    if (details.open) renderBody();
    return details;
  }

  private renderActionItemHead(head: HTMLElement, item: ActionItemViewModel): void {
    const icon = renderAIElementsToolStatus(head, item.status);
    icon.addClass("codex-action-item-icon");
    setSemanticIcon(icon, iconForActionKind(item.kind));
    const main = head.createDiv({ cls: "codex-action-item-main" });
    this.renderActionItemTitle(main, item);
    this.renderActionItemStats(head, item);
  }

  private renderActionItemTitle(container: HTMLElement, item: ActionItemViewModel): void {
    const prefix = actionVerb(item, this.requireEnv().settingsLanguage);
    container.createSpan({ cls: "codex-action-item-prefix", text: `${prefix} ` });
    if (item.kind === "edit" && item.source.diffSummary?.files.length) {
      const file = item.source.diffSummary.files[0];
      const ref = findProcessFileRef(item.source.files ?? [], file.path) ?? normalizeProcessFileRef(file.path, this.requireEnv().vaultPath);
      this.renderProcessFileTextLink(container, ref, basename(file.path), "codex-action-item-file");
      if (item.source.diffSummary.files.length > 1) {
        container.createSpan({
          cls: "codex-action-item-extra",
          text: this.copy().action.moreFiles(item.source.diffSummary.files.length)
        });
      }
    } else if (item.file) {
      this.renderProcessFileTextLink(container, item.file, item.file.name || item.file.displayPath, "codex-action-item-file");
    } else {
      container.createSpan({
        cls: "codex-action-item-title",
        text: actionItemTarget(item, this.requireEnv().settingsLanguage) || item.title
      });
    }
    if (typeof item.durationMs === "number") {
      container.createSpan({
        cls: "codex-action-item-duration",
        text: formatActionDuration(item.durationMs)
      });
    }
  }

  private renderActionItemStats(container: HTMLElement, item: ActionItemViewModel): void {
    if (!item.diff || (item.diff.added === undefined && item.diff.removed === undefined)) return;
    const stats = container.createSpan({ cls: "codex-action-diff-stats" });
    if (typeof item.diff.added === "number") stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${item.diff.added}` });
    if (typeof item.diff.removed === "number") stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${item.diff.removed}` });
  }

  private renderActionItemDetails(container: HTMLElement, item: ActionItemViewModel): void {
    const details = item.userDetails;
    if (!details) return;
    if (details.action === "create" || details.action === "edit") {
      if (details.targetPath) {
        this.renderActionDetailValue(container, this.copy().details.target, details.targetPath, true);
      }
      if (details.preview) this.renderActionPreview(container, details.preview);
      if (details.targetPath) this.renderActionFullNoteLink(container, item, details.targetPath);
      this.renderActionDiff(container, item.source);
      this.renderActionError(container, details.error);
      return;
    }
    if (details.action === "search") {
      if (details.query) this.renderActionDetailValue(container, this.copy().details.query, details.query);
      if (details.scopePath) this.renderActionDetailValue(container, this.copy().details.scope, details.scopePath, true);
      if (typeof details.resultCount === "number") {
        container.createDiv({
          cls: "codex-action-detail-result-count",
          text: this.copy().details.searchMatches(details.resultCount)
        });
      }
      if (details.results?.length) {
        const list = container.createDiv({ cls: "codex-action-search-results" });
        for (const result of details.results) {
          const row = list.createDiv({ cls: "codex-action-search-result" });
          const heading = row.createDiv({ cls: "codex-action-search-result-heading" });
          const label = result.path || result.title || "";
          if (result.path) {
            const ref = findProcessFileRef(item.source.files ?? [], result.path)
              ?? normalizeProcessFileRef(result.path, this.requireEnv().vaultPath);
            if (this.actionFileExists(ref)) {
              this.renderProcessFileTextLink(
                heading,
                ref,
                label,
                "codex-action-search-result-path",
                true
              );
            } else {
              heading.createSpan({ cls: "codex-action-search-result-path", text: label });
            }
          } else {
            heading.createSpan({ cls: "codex-action-search-result-path", text: label });
          }
          if (result.title && result.title !== label) {
            heading.createSpan({ cls: "codex-action-search-result-title", text: result.title });
          }
          if (result.excerpt) {
            row.createDiv({ cls: "codex-action-search-result-excerpt", text: result.excerpt });
          }
        }
      }
      this.renderActionError(container, details.error);
      return;
    }
    if (details.action === "move") {
      if (details.sourcePath) {
        this.renderActionDetailValue(container, this.copy().details.sourcePath, details.sourcePath, true);
      }
      if (details.destinationPath) {
        this.renderActionDetailValue(container, this.copy().details.destinationPath, details.destinationPath, true);
      }
      this.renderActionError(container, details.error);
      return;
    }
    if (details.action === "delete") {
      if (details.sourcePath) {
        this.renderActionDetailValue(container, this.copy().details.sourcePath, details.sourcePath, true);
      }
      if (details.deleteOutcome) {
        container.createDiv({
          cls: "codex-action-detail-outcome",
          text: details.deleteOutcome === "recoverable"
            ? this.copy().details.deletedRecoverably
            : this.copy().details.deleted
        });
      }
      this.renderActionError(container, details.error);
      return;
    }
    if (details.action === "command") {
      this.renderActionCommand(container, item);
      return;
    }
    if (details.parameters?.length) {
      const section = container.createDiv({ cls: "codex-action-parameters" });
      section.createDiv({ cls: "codex-action-detail-label", text: this.copy().details.parameters });
      for (const parameter of details.parameters) {
        const row = section.createDiv({ cls: "codex-action-parameter" });
        row.createSpan({ cls: "codex-action-parameter-name", text: parameter.label });
        row.createSpan({ cls: "codex-action-parameter-value", text: parameter.value });
      }
    }
    if (details.result) {
      const section = container.createDiv({ cls: "codex-action-detail-section" });
      section.createDiv({ cls: "codex-action-detail-label", text: this.copy().details.result });
      section.createEl("pre", { cls: "codex-action-detail-result", text: details.result });
    }
    this.renderActionError(container, details.error);
  }

  private renderActionDetailValue(
    container: HTMLElement,
    label: string,
    value: string,
    path = false
  ): void {
    const row = container.createDiv({ cls: "codex-action-detail-row" });
    row.createSpan({ cls: "codex-action-detail-label", text: label });
    row.createSpan({
      cls: path ? "codex-action-detail-value is-path" : "codex-action-detail-value",
      text: value,
      attr: { title: value }
    });
  }

  private renderActionPreview(container: HTMLElement, text: string): void {
    const section = container.createDiv({ cls: "codex-action-detail-section codex-action-preview" });
    section.createDiv({ cls: "codex-action-detail-label", text: this.copy().details.preview });
    const preview = actionContentPreview(text);
    section.createEl("pre", {
      cls: "codex-action-preview-content",
      text: preview.text,
      attr: { "data-preview-truncated": String(preview.truncated) }
    });
  }

  private renderActionFullNoteLink(
    container: HTMLElement,
    item: ActionItemViewModel,
    path: string
  ): void {
    const ref = findProcessFileRef(item.source.files ?? [], path)
      ?? normalizeProcessFileRef(path, this.requireEnv().vaultPath);
    if (!this.actionFileExists(ref)) return;
    const link = container.createEl("span", {
      cls: "codex-action-open-note",
      text: this.copy().details.openFullNote,
      attr: {
        role: "button",
        tabindex: "0",
        title: ref.displayPath,
        "aria-label": `${this.copy().details.openFullNote} ${ref.displayPath}`
      }
    });
    link.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openProcessFile(ref);
    };
    link.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      void this.openProcessFile(ref);
    };
  }

  private actionFileExists(file: ProcessFileRef): boolean {
    if (!file.openable || file.kind !== "vault") return false;
    return this.requireEnv().app.vault.getAbstractFileByPath(normalizePath(file.path)) instanceof TFile;
  }

  private renderActionDiff(container: HTMLElement, message: ChatMessage): void {
    const approvalChange = piApprovalPreviewChangeProjection(message.approval?.preview);
    if (this.renderApprovalPreviewDiff(container, message, approvalChange)) return;
    if (!message.diffSummary) return;
    const host = container.createDiv({ cls: "codex-action-detail-diff" });
    const projected: ChatMessage = {
      ...message,
      itemType: "fileChange",
      processInput: undefined,
      processOutput: undefined,
      processInputAvailability: undefined,
      processOutputAvailability: undefined
    };
    this.renderFileChangeBody(host, projected, this.copy().details.noDiff);
  }

  private renderActionCommand(container: HTMLElement, item: ActionItemViewModel): void {
    const details = item.userDetails;
    if (!details) return;
    if (
      item.source.rawRef
      && !details.command
      && !details.stdout
      && !details.stderr
      && !details.error
    ) {
      this.renderCommandExecutionBody(container, item.source, this.copy().details.noContent);
      return;
    }
    const transcript: string[] = [];
    if (details.command) transcript.push(`$ ${details.command}`);
    if (details.stdout) transcript.push(details.stdout);
    if (details.stderr) transcript.push(details.stderr);
    if (details.error && details.error !== details.stderr) transcript.push(details.error);
    if (!transcript.length) return;
    const shell = container.createDiv({ cls: "codex-shell-block codex-action-command" });
    shell.createDiv({ cls: "codex-shell-label", text: this.copy().details.terminal });
    shell.createEl("pre", { cls: "codex-shell-output", text: transcript.join("\n") });
  }

  private renderActionError(container: HTMLElement, error: string | undefined): void {
    if (!error) return;
    const section = container.createDiv({ cls: "codex-action-error" });
    section.createDiv({ cls: "codex-action-detail-label", text: this.copy().details.errorReason });
    section.createDiv({ cls: "codex-action-error-message", text: error });
  }

  private renderApprovalCard(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const binding = env.resolveApprovalDecision?.(message) ?? null;
    const state = approvalStateForMessage(message)
      ?? (binding ? "waiting_approval" : null);
    if (!state) return;
    const elements = createSmoothAIApprovalCard(container, {
      state,
      target: message.approval?.target || binding?.target,
      preview: message.approval?.preview || binding?.preview,
      controlled: state === "waiting_approval" && Boolean(binding),
      language: env.settingsLanguage
    });
    if (!binding || !elements.approveButton || !elements.rejectButton) return;
    const buttons = [elements.approveButton, elements.rejectButton];
    let deciding = false;
    const decide = (decision: "approve" | "reject") => (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (deciding) return;
      deciding = true;
      elements.root.setAttribute("aria-busy", "true");
      for (const button of buttons) button.disabled = true;
      let accepted = false;
      try {
        accepted = binding.decide(decision);
      } catch {
        accepted = false;
      }
      if (accepted) {
        env.onScheduleMeasure();
        return;
      }
      deciding = false;
      elements.root.setAttribute("aria-busy", "false");
      for (const button of buttons) button.disabled = false;
      new Notice(conversationUiText(
        env.settingsLanguage,
        "该审批已失效，请等待状态刷新。",
        "This approval is no longer valid. Wait for the status to refresh."
      ));
      this.rerenderPreservingScroll();
    };
    elements.approveButton.onclick = decide("approve");
    elements.rejectButton.onclick = decide("reject");
  }

  private rerenderPreservingScroll(): void {
    const env = this.env;
    if (!env) return;
    this.render({ ...env, options: { ...env.options, preserveScroll: true } });
  }

  private renderMessageAttachments(
    container: HTMLElement,
    attachments: readonly Readonly<StoredAttachment>[],
    attachmentResolver: EchoInkAttachmentResourceResolver
  ): void {
    const language = this.requireEnv().settingsLanguage;
    markAIElementsAttachments(container, "grid", conversationUiText(language, "消息附件", "Message attachments"));
    let imageIndex = 0;
    for (const attachment of attachments) {
      const resource = attachmentResolver.resolve(
        attachment,
        attachment.type === "image" ? imageIndex++ : 0
      );
      const item = container.createDiv({ cls: "codex-message-attachment-item" });
      markAIElementsAttachmentItem(
        item,
        attachment.type === "image" ? "image" : "document"
      );
      if (attachment.type === "image") {
        if (
          resource.availability === "unavailable"
          || !resource.resourceUri
          || this.failedAttachmentResourceUris.has(resource.resourceUri)
        ) {
          renderUnavailablePiImage(item, resource.displayName, language);
          continue;
        }
        const resourceUri = resource.resourceUri;
        const sessionId = this.requireEnv().sessionId;
        const preview = item.createEl("button", {
          cls: "codex-message-attachment-preview",
          attr: {
            type: "button",
            title: conversationUiText(language, `打开 ${resource.displayName}`, `Open ${resource.displayName}`),
            "aria-label": conversationUiText(language, `打开图片：${resource.displayName}`, `Open image: ${resource.displayName}`)
          }
        });
        const img = preview.createEl("img", { attr: { alt: "", draggable: "false" } });
        img.onload = () => this.scheduleMeasureIfVirtualRowHeightChanged(item, sessionId);
        img.onerror = () => {
          if (this.env?.sessionId !== sessionId) return;
          this.failedAttachmentResourceUris.add(resourceUri);
          preview.remove();
          renderUnavailablePiImage(item, resource.displayName, language);
          this.scheduleMeasureIfVirtualRowHeightChanged(item, sessionId);
        };
        img.src = resourceUri;
        preview.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.openAttachment(attachment, resourceUri);
        };
        continue;
      }
      renderFileCard(item, {
        attachment,
        displayName: resource.displayName,
        variant: "message",
        availability: resource.availability,
        language,
        onOpen: () => {
          void this.openAttachment(attachment, resource.resourceUri);
        }
      });
    }
  }

  private scheduleMeasureIfVirtualRowHeightChanged(
    element: HTMLElement,
    sessionId: string
  ): void {
    if (this.env?.sessionId !== sessionId) return;
    const row = element.closest<HTMLElement>(".codex-virtual-row");
    const rowId = row?.dataset.rowId;
    if (!row || !rowId) return;
    const previousHeight = this.virtualRowHeights.get(rowId);
    if (previousHeight === undefined) return;
    const measuredHeight = row.getBoundingClientRect().height;
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;
    if (Math.ceil(measuredHeight) !== previousHeight) {
      this.requireEnv().onScheduleMeasure();
    }
  }

  private renderUserNoteMentionChips(
    container: HTMLElement,
    noteMentions: NonNullable<ChatMessage["noteMentions"]>
  ): void {
    container.addClass("codex-note-mention-chips");
    container.setAttribute("role", "list");
    const language = this.requireEnv().settingsLanguage;
    container.setAttribute("aria-label", conversationUiText(language, "消息中的笔记提及", "Note mentions in this message"));
    for (const mention of noteMentions) {
      const chip = container.createEl("button", {
        cls: "codex-note-mention-chip codex-message-note-mention-chip",
        attr: {
          type: "button",
          role: "listitem",
          title: conversationUiText(language, `打开 ${mention.fileName}`, `Open ${mention.fileName}`),
          "aria-label": conversationUiText(language, `打开笔记：${mention.fileName}`, `Open note: ${mention.fileName}`)
        }
      });
      const icon = chip.createSpan({
        cls: "codex-note-mention-chip-icon",
        attr: { "aria-hidden": "true" }
      });
      setIcon(icon, "file-text");
      chip.createSpan({
        cls: "codex-note-mention-chip-name",
        text: mention.fileName
      });
      chip.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.openMentionedNote(mention.vaultRelativePath, mention.fileName);
      };
    }
  }

  private async openMentionedNote(
    vaultRelativePath: string,
    fileName: string
  ): Promise<void> {
    const env = this.requireEnv();
    const file = env.app.vault.getAbstractFileByPath(normalizePath(vaultRelativePath));
    if (!(file instanceof TFile)) {
      new Notice(conversationUiText(
        env.settingsLanguage,
        `找不到笔记：${fileName}`,
        `Note not found: ${fileName}`
      ));
      return;
    }
    await env.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }

  private async openAttachment(
    attachment: Readonly<StoredAttachment>,
    resourceUri?: string
  ): Promise<void> {
    const env = this.requireEnv();
    if (attachment.type === "image") {
      const resolved = resourceUri
        ? { resourceUri }
        : createAttachmentResourceResolver(
          env.app,
          env.vaultPath,
          env.settingsLanguage
        ).resolve(attachment);
      if (!resolved.resourceUri) {
        new Notice(conversationUiText(env.settingsLanguage, "图片附件不可在本地打开", "This image attachment cannot be opened locally"));
        return;
      }
      openImageOverlay(resolved.resourceUri);
      return;
    }
    const ref = normalizeProcessFileRef(attachment.path, env.vaultPath);
    if (!ref.openable) {
      new Notice(conversationUiText(env.settingsLanguage, "这个文件路径无法打开", "This file path cannot be opened"));
      return;
    }
    const absolutePath = ref.absolutePath
      ?? (ref.kind === "vault"
        ? absoluteVaultPath(env.vaultPath, ref.path)
        : ref.kind === "external" ? ref.path : "");
    if (await openPathInElectron(absolutePath)) return;
    new Notice(conversationUiText(
      env.settingsLanguage,
      `无法使用系统默认应用打开：${ref.displayPath}`,
      `Could not open with the system default application: ${ref.displayPath}`
    ));
  }

  private renderThinkingMessage(container: HTMLElement, message: ChatMessage): void {
    const env = this.requireEnv();
    const copy = this.copy();
    const bodyId = stableDomId(`codex-thinking-${message.id}`);
    const reasoning = createAIElementsReasoning(container, {
      bodyId,
      open: message.status === "running",
      status: aiElementsStatus(message.status),
      summary: message.status === "running" ? copy.message.thinking : copy.message.thinkingComplete
    });
    const shell = reasoning.root;
    shell.addClass("codex-thinking-shell");
    reasoning.summary.addClass("codex-thinking-summary");
    shell.ontoggle = () => {
      reasoning.summary.setAttribute("aria-expanded", String(shell.open));
      env.onScheduleMeasure();
    };
    if (message.status === "running") {
      const row = reasoning.body.createDiv({ cls: "codex-thinking-live" });
      renderSmoothAILoader(
        row,
        firstPartyMessageText(message, env.settingsLanguage) || copy.message.organizingContext,
        { language: env.settingsLanguage }
      );
      row.createSpan({
        cls: "codex-agent-live-copy",
        text: ` · ${rotatingChoice(copy.message.thinkingLiveCopies, message.createdAt)}`
      });
      env.onScheduleRunProgress();
      return;
    }
    reasoning.body.createEl("em", {
      cls: "codex-response-footer",
      text: firstPartyMessageText(message, env.settingsLanguage) || copy.message.thinkingComplete
    });
  }

  private renderProcessMessage(
    container: HTMLElement,
    message: ChatMessage,
    nested = false,
    forceOpen = false,
    showApprovalCard = true
  ): void {
    const details = container.createEl("details", { cls: `codex-structured codex-process codex-process-${message.itemType ?? "item"}` });
    details.dataset.messageId = message.id;
    markAIElementsTool(details, message.status);
    const approvalState = approvalStateForMessage(message);
    if (approvalState) markSmoothAIApproval(details, approvalState);
    details.toggleClass("is-running", isActiveProcessStatus(message.status));
    details.toggleClass("is-completed", message.status === "completed");
    details.toggleClass("is-error", isAttentionProcessStatus(message.status));
    details.toggleClass("is-nested", nested);
    if (message.processKind) details.toggleClass(`codex-process-kind-${message.processKind}`, true);
    const defaultOpen = forceOpen || (!nested && (
      message.itemType === "plan"
      || isAttentionProcessStatus(message.status)
    ));
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
    const icon = renderAIElementsToolStatus(summary, message.status);
    icon.addClass("codex-structured-icon");
    icon.addClass("codex-process-icon");
    setSemanticIcon(icon, iconForProcessMessage(message));
    const main = summary.createDiv({ cls: "codex-process-main" });
    if (message.itemType === "fileChange" && message.diffSummary?.files.length) {
      this.renderProcessEditSummary(main, message);
    } else {
      main.createSpan({
        cls: "codex-structured-title codex-process-title",
        text: titleForItemType(message, this.requireEnv().settingsLanguage)
      });
      if (message.itemType === "fileChange" && message.diffSummary) this.renderDiffStats(main, message.diffSummary);
      if (message.details) {
        main.createDiv({
          cls: "codex-process-detail",
          text: firstPartyMessageDetail(
            message,
            message.details,
            this.requireEnv().settingsLanguage
          )
        });
      }
      if (message.itemType === "fileChange" && message.files?.length) this.renderProcessFileChips(main.createDiv({ cls: "codex-process-files" }), message.files);
    }
    if (message.status) {
      summary.createSpan({
        cls: "codex-structured-status",
        text: labelForStatus(message.status, this.requireEnv().settingsLanguage)
      });
    }
    if (showApprovalCard) this.renderApprovalCard(container, message);
    if (details.open) renderBody();
  }

  private renderProcessBody(body: HTMLElement, message: ChatMessage): void {
    const hasExplicitChannels = hasExplicitProcessChannels(message);
    const approvalChange = piApprovalPreviewChangeProjection(message.approval?.preview);
    const env = this.requireEnv();
    const copy = this.copy();
    if (!hasExplicitChannels && message.processContentAvailability === "unavailable") {
      if (isActiveProcessStatus(message.status)) {
        this.renderProcessLoader(body, copy.details.waitingForToolOutput);
      } else {
        body.createDiv({ cls: "codex-process-raw-loading", text: copy.details.contentUnavailable });
      }
      return;
    }
    const fallback = message.status === "running"
      ? copy.details.receivingContent
      : copy.details.noContent;
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
      this.renderApprovalPreviewDiff(body, message, approvalChange);
      return;
    }
    if (this.renderApprovalPreviewDiff(body, message, approvalChange)) {
      const text = firstPartyMessageText(
        message,
        this.requireEnv().settingsLanguage
      ).trim();
      if (text) this.renderPlainTextBlock(body, text);
      return;
    }
    const rawLike = message.itemType === "commandExecution" || message.itemType === "fileChange" || message.itemType === "mcpToolCall" || message.itemType === "dynamicToolCall" || message.itemType === "collabAgentToolCall";
    if (rawLike) body.createDiv({ cls: "codex-process-raw-title", text: this.rawMetaLabel(message) });
    if (message.rawRef) {
      this.renderDeferredRawText(body, message, fallback);
      return;
    }
    const text = firstPartyMessageText(
      message,
      this.requireEnv().settingsLanguage
    ) || fallback;
    if (rawLike || isLargeRawMessage(message)) {
      this.renderPlainTextBlock(body, text);
      return;
    }
    renderRichText(env.app, env.component, body, text);
  }

  private renderApprovalPreviewDiff(
    body: HTMLElement,
    message: ChatMessage,
    change: PiApprovalPreviewChangeProjection | undefined
  ): boolean {
    if (!change?.diff || !message.diffSummary) return false;
    const channel = body.createDiv({
      cls: "codex-process-channel codex-process-channel-diff"
    });
    const projected: ChatMessage = {
      ...message,
      itemType: "fileChange",
      text: change.diff,
      previewText: undefined,
      rawRef: undefined,
      processInput: undefined,
      processOutput: undefined,
      processInputAvailability: undefined,
      processOutputAvailability: undefined
    };
    this.renderFileChangeBody(channel, projected, this.copy().details.noContent);
    return true;
  }

  private renderProcessChannels(body: HTMLElement, message: ChatMessage): void {
    const active = isActiveProcessStatus(message.status);
    const copy = this.copy();
    this.renderProcessChannel(body, copy.details.input, message.processInputAvailability, message.processInput, false, false);
    this.renderProcessChannel(body, copy.details.output, message.processOutputAvailability, message.processOutput, true, active);
  }

  private renderProcessChannel(
    body: HTMLElement,
    label: string,
    availability: ChatMessage["processInputAvailability"],
    text: string | undefined,
    artifact: boolean,
    activeWait: boolean
  ): void {
    if (!availability) return;
    const artifactElements = artifact ? createSmoothAIArtifact(body, label) : null;
    const channel = artifactElements?.body ?? body.createDiv({ cls: "codex-process-channel" });
    artifactElements?.root.addClass("codex-process-channel");
    if (!artifact) channel.createDiv({ cls: "codex-process-raw-title", text: label });
    if (availability === "unavailable") {
      if (activeWait) this.renderProcessLoader(channel, this.copy().details.waitingForToolOutput);
      else channel.createDiv({ cls: "codex-process-raw-loading", text: this.copy().details.contentUnavailable });
      return;
    }
    if (availability === "empty") {
      channel.createDiv({ cls: "codex-process-raw-loading", text: this.copy().details.emptyContent });
      return;
    }
    const content = text?.trim() ? text : this.copy().details.contentUnavailable;
    if (artifact) {
      const env = this.requireEnv();
      renderPreformattedVaultNoteText(env.app, env.component, channel, content);
    } else {
      this.renderPlainTextBlock(channel, content);
    }
  }

  private renderFileChangeBody(body: HTMLElement, message: ChatMessage, fallback: string): void {
    const copy = this.copy();
    const renderDiff = (text: string) => {
      body.empty();
      const artifact = createSmoothAIArtifact(body, copy.details.fileChanges);
      const artifactBody = artifact.body;
      const files = parseFileChangeDiff(text || fallback, message.diffSummary);
      if (!hasRenderableDiff(files)) {
        this.renderPlainTextBlock(artifactBody, text || fallback);
        return;
      }
      markSmoothAIDiff(artifact.root);
      if (message.diffSummary) this.renderDiffOverview(artifactBody, message.diffSummary);
      this.renderDiffFiles(artifactBody, files, message.files ?? []);
    };
    if (message.rawRef) {
      this.renderProcessLoader(body, copy.details.loadingFileChanges);
      void this.loadRawText(message)
        .then((text) => {
          renderDiff(text);
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({
            cls: "codex-process-raw-loading",
            text: copy.details.fileChangesLoadFailed(
              error instanceof Error ? error.message : String(error)
            )
          });
          this.renderPlainTextBlock(body, displayTextForMessage(message) || fallback);
          this.requireEnv().onScheduleMeasure();
        });
      return;
    }
    renderDiff(displayTextForMessage(message) || fallback);
  }

  private renderCommandExecutionBody(body: HTMLElement, message: ChatMessage, fallback: string): void {
    const copy = this.copy();
    const renderShell = (text: string) => {
      body.empty();
      const shell = body.createDiv({ cls: "codex-shell-block" });
      shell.createDiv({ cls: "codex-shell-label", text: "Shell" });
      shell.createEl("pre", { cls: "codex-shell-output", text: shellTranscript(text || fallback) });
    };
    if (message.rawRef) {
      this.renderProcessLoader(body, copy.details.loadingCommandOutput);
      void this.loadRawText(message)
        .then((text) => {
          renderShell(text);
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({
            cls: "codex-process-raw-loading",
            text: copy.details.commandOutputLoadFailed(
              error instanceof Error ? error.message : String(error)
            )
          });
          renderShell(displayTextForMessage(message) || fallback);
          this.requireEnv().onScheduleMeasure();
        });
      return;
    }
    renderShell(displayTextForMessage(message) || fallback);
  }

  private renderDiffOverview(container: HTMLElement, summary: DiffSummary): void {
    const row = container.createDiv({ cls: "codex-diff-overview" });
    row.createSpan({
      cls: "codex-diff-overview-title",
      text: this.copy().details.changedFiles(summary.totalFiles)
    });
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
      if (file.previousPath) {
        main.createSpan({
          cls: "codex-diff-file-previous",
          text: this.copy().details.previousPath(file.previousPath)
        });
      }
      summary.createSpan({
        cls: "codex-diff-file-kind",
        text: this.copy().details.diffKind(file.kind)
      });
      const stats = summary.createSpan({ cls: "codex-diff-file-stats" });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${file.added}` });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${file.removed}` });
      if (details.open) renderRows();
    });
  }

  private renderDiffFileBody(container: HTMLElement, file: ParsedDiffFile): void {
    const body = container.createDiv({ cls: "codex-diff-file-body" });
    if (!file.lines.length) {
      body.createDiv({ cls: "codex-diff-empty", text: this.copy().details.noDiff });
      return;
    }
    for (const line of file.lines) {
      const row = body.createDiv({ cls: `codex-diff-line codex-diff-line-${line.type}` });
      row.createSpan({ cls: "codex-diff-line-no codex-diff-line-old", text: line.oldLine === null ? "" : String(line.oldLine) });
      row.createSpan({ cls: "codex-diff-line-no codex-diff-line-new", text: line.newLine === null ? "" : String(line.newLine) });
      row.createSpan({ cls: "codex-diff-marker", text: line.marker });
      row.createSpan({ cls: "codex-diff-content", text: line.text });
    }
  }

  private renderProcessEditSummary(container: HTMLElement, message: ChatMessage): void {
    const list = container.createDiv({ cls: "codex-process-edit-list" });
    for (const file of message.diffSummary?.files ?? []) {
      const row = list.createDiv({ cls: "codex-process-edit-row" });
      row.createSpan({ cls: "codex-process-edit-prefix", text: this.copy().details.editedPrefix });
      const ref = findProcessFileRef(message.files ?? [], file.path) ?? normalizeProcessFileRef(file.path, this.requireEnv().vaultPath);
      this.renderProcessFileTextLink(row, ref, basename(file.path), "codex-process-edit-file");
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: ` +${file.added}` });
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: ` -${file.removed}` });
    }
  }

  private renderProcessFileTextLink(
    container: HTMLElement,
    file: ProcessFileRef,
    label: string,
    extraClass = "",
    preserveLabel = false
  ): HTMLElement {
    const displayLabel = !preserveLabel && file.kind === "vault"
      ? noteNameForPath(file.path || label)
      : label;
    if (!file.openable) {
      return container.createSpan({
        cls: `codex-process-file-text is-disabled ${extraClass}`.trim(),
        text: displayLabel,
        attr: { title: this.copy().details.cannotOpenPath(file.displayPath) }
      });
    }
    const link = container.createEl("span", {
      cls: `codex-process-file-link codex-process-file-link-${file.kind} ${extraClass}`.trim(),
      text: displayLabel,
      attr: {
        role: "button",
        tabindex: "0",
        title: file.displayPath,
        "aria-label": this.copy().details.open(displayLabel)
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
    const status = this.renderProcessLoader(container, this.copy().details.loadingFullText);
    const pre = container.createEl("pre", { cls: "codex-process-fulltext" });
    pre.setText(displayTextForMessage(message) || fallback);
    void this.loadRawText(message)
      .then((text) => {
        status.empty();
        status.setText(this.rawMetaLabel(message, text));
        pre.setText(text || fallback);
        this.requireEnv().onScheduleMeasure();
      })
      .catch((error) => {
        status.empty();
        status.setText(this.copy().details.fullTextLoadFailed(
          error instanceof Error ? error.message : String(error)
        ));
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
      this.renderProcessLoader(body, this.copy().details.loadingFullText);
      this.requireEnv().onScheduleMeasure();
      void this.loadRawText(message)
        .then((text) => {
          body.empty();
          this.renderPlainTextBlock(body, text || this.copy().details.noContent);
          this.requireEnv().onScheduleMeasure();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({
            cls: "codex-process-raw-loading",
            text: this.copy().details.fullTextLoadFailed(
              error instanceof Error ? error.message : String(error)
            )
          });
          this.requireEnv().onScheduleMeasure();
        });
    };
  }

  private renderProcessLoader(container: HTMLElement, label: string): HTMLElement {
    const host = container.createDiv({ cls: "codex-process-raw-loading" });
    renderSmoothAILoader(host, label, {
      language: this.requireEnv().settingsLanguage
    });
    return host;
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
    const copy = this.copy();
    const parts = [copy.details.rawOutput];
    if (size) parts.push(formatBytes(size));
    if (lines) parts.push(copy.details.lineCount(lines));
    if (message.rawRef) parts.push(copy.details.fullTextPreserved);
    return parts.join(" · ");
  }

  private renderProcessFileChips(container: HTMLElement, files: ProcessFileRef[]): void {
    for (const file of files) {
      const displayName = file.kind === "vault" ? noteNameForPath(file.path || file.name) : file.name;
      const chip = container.createEl("button", {
        cls: `codex-process-file-chip codex-process-file-${file.kind}`,
        attr: {
          type: "button",
          title: file.openable ? file.displayPath : this.copy().details.cannotOpenPath(file.displayPath),
          "aria-label": this.copy().details.open(displayName)
        }
      });
      chip.toggleClass("is-disabled", !file.openable);
      const icon = chip.createSpan({ cls: "codex-process-file-icon" });
      setIcon(icon, file.kind === "external" ? "folder-open" : "file-text");
      chip.createSpan({ cls: "codex-process-file-name", text: displayName });
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
      new Notice(conversationUiText(env.settingsLanguage, "这个文件路径无法打开", "This file path cannot be opened"));
      return;
    }
    if (file.kind === "vault") {
      const vaultFile = env.app.vault.getAbstractFileByPath(normalizePath(file.path));
      if (vaultFile instanceof TFile) {
        await env.app.workspace.getLeaf("tab").openFile(vaultFile, { active: true });
        return;
      }
      if (file.absolutePath && showItemInFinder(file.absolutePath)) return;
      new Notice(conversationUiText(
        env.settingsLanguage,
        `没有在当前 Obsidian 仓库找到：${file.displayPath}`,
        `Not found in the current Obsidian vault: ${file.displayPath}`
      ));
      return;
    }
    if (file.kind === "external" && showItemInFinder(file.absolutePath ?? file.path)) return;
    new Notice(conversationUiText(env.settingsLanguage, "无法打开这个文件位置", "Could not open this file location"));
  }

  private pruneVirtualHeights(rowIds: string[]): void {
    const valid = new Set(rowIds);
    for (const key of Array.from(this.virtualRowHeights.keys())) {
      if (!valid.has(key)) this.virtualRowHeights.delete(key);
    }
  }
}

/**
 * Provider reasoning remains verbatim in the durable Pi transcript and the
 * internal view model. Only the user-facing Reasoning DOM receives this copy:
 * models need opaque Memory handles to call Tools, but users should see the
 * decision in plain language rather than implementation identifiers.
 */
const PERSONAL_MEMORY_TOOL_CARD_TITLES = new Set([
  "正在检查已有记忆",
  "已完成已有记忆检查",
  "检查已有记忆",
  "正在读取相关记忆",
  "已读取相关记忆",
  "读取相关记忆",
  "正在整理个人记忆",
  "已完成个人记忆处理",
  "写入个人记忆"
]);

function containsPersonalMemoryInternalSignal(text: string): boolean {
  return /\bmem_[0-9a-f]{4,64}\b|\bmemory_(?:search|read|write)\b|\bprofile_update(?:d)?\b|\bshared-user\/memory\/|\bpersonal_memory_[a-z0-9_]+\b|\bechoink_memory_result\b|\bschema\s*[:=]\s*["']?echoink\.memory(?:\.v\d+)?|\bpi:\/\//iu.test(text);
}

function assistantTurnHasPersonalMemoryContext(turn: AgentTurnView): boolean {
  return turn.providerReasoningSegments.some((segment) =>
    containsPersonalMemoryInternalSignal(segment.text)
  ) || turn.messages.some((message) =>
    PERSONAL_MEMORY_TOOL_CARD_TITLES.has(message.title ?? "")
  );
}

export function userVisibleProviderReasoningText(
  text: string,
  personalMemoryContext = containsPersonalMemoryInternalSignal(text)
): string {
  if (!personalMemoryContext) return text;
  const memoryKindLabel: Readonly<Record<string, string>> = {
    fact: "事实",
    view: "观点",
    decision: "决定",
    goal: "目标",
    task: "待办",
    open_loop: "未决事项",
    episode: "经历"
  };
  const memoryOutcomeLabel: Readonly<Record<string, string>> = {
    created: "已记住",
    updated: "已更新",
    profile_updated: "已更新用户信息",
    forgotten: "已忘记",
    already_present: "原来已经记过",
    possible_duplicate: "可能与已有记忆重复",
    current: "当前有效"
  };

  return text
    .replace(/(?:原记录|旧记录|已有记录)\s*mem_[0-9a-f]{4,64}\b/giu, "原有记忆")
    .replace(/(?:新记录|更新后的记录)\s*mem_[0-9a-f]{4,64}\b/giu, "更新后的记忆")
    .replace(/\bshared-user\/memory\/[\w./-]+/giu, "内部记忆位置")
    .replace(/\bmem_[0-9a-f]{4,64}\b/giu, "相关记忆")
    .replace(/\bcall_[a-z0-9_-]{4,128}\b/giu, "本次操作")
    .replace(/\bmemory_search\b/giu, "检查已有长期记忆")
    .replace(/\bmemory_read\b/giu, "读取长期记忆")
    .replace(/\bmemory_write\b/giu, "更新长期记忆")
    .replace(
      /\b(?:outcome|operation|status)\s*[:=]\s*["']?(created|updated|profile_updated|forgotten|already_present|possible_duplicate|current)["']?/giu,
      (_match, outcome: string) => `记忆结果：${memoryOutcomeLabel[outcome.toLowerCase()] ?? outcome}`
    )
    .replace(/\bprofile_updated\b/giu, "已更新用户信息")
    .replace(/\bprofile_update\b/giu, "更新用户信息")
    .replace(/\balready_present\b/giu, "原来已经记过")
    .replace(/\bpossible_duplicate\b/giu, "可能与已有记忆重复")
    .replace(
      /\b(?:authorization_failed|current_turn_search_required|personal_memory_[a-z0-9_]+)\b/giu,
      "记忆操作未完成"
    )
    .replace(/\bexpectedRevision\b/giu, "当前记忆版本")
    .replace(/\brevision\s*(?:[:=]\s*)?\d+(?:\s*[–—-]\s*\d+)?\b/giu, "当前记忆版本")
    .replace(/\brevision\b/giu, "记忆版本")
    .replace(/\b(?:targetId|recordId)\b/gu, "对应记忆")
    .replace(/\bprofileKey\b/gu, "用户信息类别")
    .replace(/\bschema\s*[:=]\s*["']?echoink\.memory(?:\.v\d+)?["']?/giu, "记忆格式")
    .replace(/\bechoink_memory_result\b/giu, "记忆结果")
    .replace(/\bpi:\/\/[\w%./?=&:+-]+/giu, "对话来源")
    .replace(
      /\bkind\s*[:=]\s*(fact|view|decision|goal|task|open_loop|episode)\b/giu,
      (_match, kind: string) => `记忆类型：${memoryKindLabel[kind.toLowerCase()] ?? kind}`
    );
}

export const isProcessItemType = isAgentProcessItemType;

export function messageProvenanceMetaItems(message: ChatMessage): string[] {
  const items: string[] = [];
  const backend = message.backendId ? backendDisplayName(message.backendId) : "";
  const agent = [backend, message.modelId, message.profileId].filter(Boolean).join(" · ");
  if (agent) items.push(agent);
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
  if (
    message.role === "user"
    || message.itemType === "knowledgeBase"
    || message.itemType === "taskPlan"
  ) return false;
  return message.itemType !== "thinking" && message.itemType !== "contextCompaction";
}

function taskPlanStatusLabel(
  status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus,
  language: SettingsLanguage = "zh-CN"
): string {
  return conversationCopy(language).task.statusLabel(status);
}

function taskPlanStatusIcon(
  status: EchoInkTaskPlanStatus | EchoInkTaskPlanStepStatus
): string {
  if (status === "pending") return "circle";
  if (status === "in_progress") return "loader-circle";
  if (status === "completed") return "circle-check";
  if (status === "failed") return "circle-alert";
  if (status === "paused") return "circle-pause";
  if (status === "interrupted") return "circle-pause";
  return "circle-x";
}

function taskPlanHistoryStatus(
  status: EchoInkTaskPlanStatus,
  completed: number,
  total: number,
  language: SettingsLanguage = "zh-CN"
): string {
  return conversationCopy(language).task.historyStatus(status, completed, total);
}

function safeDomIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(-160);
}

export function shouldRenderMessageTitle(message: ChatMessage, hasAgentHeader: boolean): boolean {
  if (!message.title || isProcessItemType(message.itemType)) return false;
  if (isAgentAnswerMessage(message)) return FAILED_ANSWER_STATUSES.has(message.status ?? "");
  return !hasAgentHeader;
}

export function messageTitleTime(
  message: ChatMessage,
  language: SettingsLanguage = "zh-CN"
): string {
  return isAgentAnswerMessage(message) ? "" : formatMessageHeaderTime(message.createdAt, language);
}

function agentModelLine(message: ChatMessage): string {
  return message.backendId ? backendDisplayName(message.backendId) : "";
}

export function agentFooterItems(message: ChatMessage): string[] {
  const items: string[] = [];
  const time = formatAnswerFooterTime(message.completedAt ?? message.createdAt);
  if (time) items.push(time);
  return items;
}

function providerBrandForMessage(message: ChatMessage): ProviderBrandId {
  const identity = message.providerId?.trim();
  if (!identity) return "custom";
  return API_PROVIDER_PRESETS.find((preset) =>
    preset.id === identity || preset.runtimeProviderId === identity
  )?.id ?? "custom";
}

function noteNameForPath(path: string): string {
  return basename(path).replace(/\.md$/iu, "") || path;
}

function formatAnswerFooterTime(
  value: number,
  language: SettingsLanguage = "zh-CN"
): string {
  const formatted = formatMessageHeaderTime(value, language);
  if (language === "en") return formatted;
  return formatted
    .replace(/^星期/, "周")
    .replace(/([一二三四五六日天])(?=\d{2}:\d{2}$)/, "$1 ");
}

function rotatingChoice<T>(items: readonly T[], createdAt?: number): T {
  return items[rotatingIndex(createdAt) % items.length];
}

function rotatingIndex(createdAt?: number): number {
  const seed = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now();
  return Math.max(0, Math.floor((Date.now() - seed) / AGENT_LIVE_COPY_INTERVAL_MS));
}

function backendDisplayName(backendId: string): string {
  return backendId;
}

function messageRowId(message: Pick<ChatMessage, "id">): string {
  return `message:${message.id}`;
}

function actionItemRowId(message: Pick<ChatMessage, "id">): string {
  return `actionItem:${message.id}`;
}

function assistantTurnRowId(turn: Pick<AgentTurnView, "key">): string {
  return `assistantTurn:${turn.key}`;
}

export function isDirectProcessVirtualRow(rowId: string | undefined, message: Pick<ChatMessage, "id" | "itemType" | "role">): boolean {
  return rowId === (isActionTimelineItem(message) ? actionItemRowId(message) : messageRowId(message));
}

function completedTurnRowId(turn: CompletedAgentTurn): string {
  return `turnProcess:${turn.key}:${turn.finalAnswer.id}`;
}

function actionMessageForProcessNode(
  turn: AgentTurnView,
  node: Readonly<EchoInkTurnProcessNode>
): ChatMessage | undefined {
  if (node.nodeId.startsWith("sources:") || node.nodeId.startsWith("artifacts:")) {
    return undefined;
  }
  if (
    node.kind !== "tool"
    && node.kind !== "diff"
    && node.kind !== "retrieval"
  ) return undefined;
  if (!node.sourceMessageId) return undefined;
  const source = turn.messages.find((message) => message.id === node.sourceMessageId);
  return source && isActionTimelineItem(source) ? source : undefined;
}

function assistantTurnNodeIcon(
  node: Readonly<EchoInkTurnProcessNode>
): string {
  if (node.kind === "reasoning") return "brain";
  if (node.kind === "retrieval") return "search";
  if (node.kind === "tool") return "wrench";
  if (node.kind === "artifact") return "image";
  if (node.kind === "diff") return "file-diff";
  return "dot";
}

function formatCompactDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatActionDuration(durationMs: number): string {
  const bounded = Math.max(0, durationMs);
  if (bounded < 1_000) return `${Math.round(bounded)}ms`;
  if (bounded < 60_000) {
    const seconds = bounded / 1_000;
    const precision = seconds < 10 && !Number.isInteger(seconds) ? 1 : 0;
    return `${seconds.toFixed(precision).replace(/\.0$/u, "")}s`;
  }
  const totalSeconds = Math.round(bounded / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function actionContentPreview(text: string): Readonly<{ text: string; truncated: boolean }> {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const visible = lines.slice(0, 6);
  const truncated = lines.length > visible.length;
  return Object.freeze({
    text: truncated ? `${visible.join("\n")}\n…` : visible.join("\n"),
    truncated
  });
}

function actionItemTarget(
  item: ActionItemViewModel,
  language: SettingsLanguage = "zh-CN"
): string {
  if (item.target) return item.target;
  if (item.kind === "command" && item.command?.summary) return item.command.summary;
  const prefix = actionVerb(item, language);
  const title = item.title.startsWith(prefix) ? item.title.slice(prefix.length).trim() : item.title;
  const withoutActionVerb = title
    .replace(/^(?:已运行|已读取|已搜索|已编辑|已调用|已处理|已更新|已验证|已记录|正在编辑|创建失败|Ran|Read|Searched|Edited|Called|Processed|Updated|Verified|Recorded|Editing|Failed to create)\s*/iu, "")
    .replace(/^(?:命令|Command)\s*/iu, "")
    .trim();
  if (item.kind !== "tool" && item.kind !== "agent") return withoutActionVerb;
  return withoutActionVerb
    .replace(/^(?:使用工具|调用工具|Use tool|Called tool)\s*[:：]?\s*/iu, "")
    .trim();
}

function hasActionItemDetails(item: ActionItemViewModel): boolean {
  const details = item.userDetails;
  if (!details) return false;
  if (details.error) return true;
  if (details.action === "read") return false;
  if (details.action === "search") {
    return Boolean(
      details.query
      || details.scopePath
      || typeof details.resultCount === "number"
      || details.results?.length
    );
  }
  if (details.action === "create" || details.action === "edit") {
    return Boolean(
      details.targetPath
      || details.preview
      || item.source.diffSummary
      || piApprovalPreviewChangeProjection(item.source.approval?.preview)?.diff
    );
  }
  if (details.action === "move") {
    return Boolean(details.sourcePath || details.destinationPath);
  }
  if (details.action === "delete") {
    return Boolean(details.sourcePath || details.deleteOutcome);
  }
  if (details.action === "command") {
    return Boolean(
      details.command
      || details.stdout
      || details.stderr
      || item.source.rawRef
    );
  }
  return Boolean(details.parameters?.length || details.result);
}

function hasExplicitProcessChannels(message: ChatMessage): boolean {
  return Boolean(message.processInputAvailability || message.processOutputAvailability);
}

function actionItemDetailLabel(
  item: ActionItemViewModel,
  language: SettingsLanguage = "zh-CN"
): string {
  return conversationCopy(language).action.detailLabel(
    item.kind,
    item.status === "failed"
  );
}

export function actionVerb(
  item: ActionItemViewModel,
  language: SettingsLanguage = "zh-CN"
): string {
  if (item.toolAction) {
    return conversationCopy(language).action.toolVerb(
      item.toolAction,
      item.status,
      item.source.status === "expired"
    );
  }
  return conversationCopy(language).action.verb(
    item.kind,
    item.status,
    item.source.status === "expired"
  );
}

function iconForActionKind(kind: ActionGroupKind): string {
  const icons: Record<ActionGroupKind, string> = {
    read: "dot",
    search: "search",
    command: "wrench",
    edit: "file-diff",
    tool: "wrench",
    agent: "wrench",
    plan: "dot",
    verify: "wrench",
    system: "dot"
  };
  return icons[kind] ?? "dot";
}

function setSemanticIcon(container: HTMLElement, icon: string): void {
  container.dataset.icon = icon;
  setIcon(container, icon);
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
    view: "dot",
    edit: "file-diff",
    run: "wrench",
    command: "wrench",
    tool: "wrench"
  };
  const processIcon = processIcons[message.processKind ?? ""];
  if (processIcon) return processIcon;
  return iconForItemType(message.itemType);
}

function iconForItemType(itemType?: string): string {
  const icons: Record<string, string> = {
    plan: "dot",
    commandExecution: "wrench",
    fileChange: "file-diff",
    mcpToolCall: "wrench",
    dynamicToolCall: "wrench",
    collabAgentToolCall: "wrench"
  };
  return icons[itemType ?? ""] ?? "dot";
}

function titleForItemType(
  message: ChatMessage,
  language: SettingsLanguage = "zh-CN"
): string {
  if (message.title) return firstPartyMessageTitle(message, language);
  return conversationCopy(language).action.itemTypeTitle(message.itemType);
}

function labelForStatus(
  status: string,
  language: SettingsLanguage = "zh-CN"
): string {
  return conversationCopy(language).action.statusLabel(status);
}

function isActiveActionStatus(status: ActionItemViewModel["status"]): boolean {
  return status === "running"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying";
}

function isAttentionActionStatus(status: ActionItemViewModel["status"]): boolean {
  return status === "failed" || status === "denied" || status === "uncertain";
}

function isActiveProcessStatus(status: string | undefined): boolean {
  return status === "running"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying"
    || status === "blocked"
    || status === "recovery-pending";
}

function approvalStateForMessage(
  message: Readonly<ChatMessage>
): SmoothAIApprovalState | null {
  const status = message.approval?.status;
  if (status === "pending") return "waiting_approval";
  if (status === "approved") return "approved";
  if (status === "denied") return "denied";
  if (status === "cancelled") return "cancelled";
  if (status === "expired") return "expired";
  return null;
}

function isAttentionProcessStatus(status: string | undefined): boolean {
  return status === "error"
    || status === "failed"
    || status === "denied"
    || status === "uncertain";
}

function mergeMessageAttachments(
  attachments: readonly Readonly<StoredAttachment>[] | undefined,
  images: readonly Readonly<StoredAttachment>[] | undefined
): readonly Readonly<StoredAttachment>[] {
  const merged: Readonly<StoredAttachment>[] = [];
  const seenPaths = new Set<string>();
  for (const attachment of [...(attachments ?? []), ...(images ?? [])]) {
    const pathIdentity = attachmentPathIdentity(attachment);
    if (pathIdentity) {
      if (seenPaths.has(pathIdentity)) continue;
      seenPaths.add(pathIdentity);
    }
    merged.push(attachment);
  }
  return merged;
}

export function preserveTextSelectionDuringMutation(
  container: HTMLElement,
  mutate: () => void
): void {
  const bookmark = captureTextSelection(container);
  mutate();
  if (bookmark) restoreTextSelection(container, bookmark);
}

function captureTextSelection(container: HTMLElement): TextSelectionBookmark | null {
  const document = container.ownerDocument;
  const selection = document?.getSelection?.();
  if (
    !document
    || !selection
    || selection.rangeCount === 0
    || !selection.anchorNode
    || !selection.focusNode
    || !container.contains(selection.anchorNode)
    || !container.contains(selection.focusNode)
  ) return null;
  const anchorOffset = textOffsetForPoint(
    container,
    selection.anchorNode,
    selection.anchorOffset
  );
  const focusOffset = textOffsetForPoint(
    container,
    selection.focusNode,
    selection.focusOffset
  );
  if (anchorOffset === null || focusOffset === null) return null;
  return Object.freeze({ anchorOffset, focusOffset });
}

function textOffsetForPoint(
  container: HTMLElement,
  node: Node,
  offset: number
): number | null {
  try {
    const range = container.ownerDocument.createRange();
    range.selectNodeContents(container);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function restoreTextSelection(
  container: HTMLElement,
  bookmark: Readonly<TextSelectionBookmark>
): void {
  const document = container.ownerDocument;
  const selection = document?.getSelection?.();
  if (!document || !selection) return;
  const anchor = textPointAtOffset(container, bookmark.anchorOffset);
  const focus = textPointAtOffset(container, bookmark.focusOffset);
  if (!anchor || !focus) return;
  try {
    selection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      focus.node,
      focus.offset
    );
  } catch {
    const start = bookmark.anchorOffset <= bookmark.focusOffset ? anchor : focus;
    const end = bookmark.anchorOffset <= bookmark.focusOffset ? focus : anchor;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function textPointAtOffset(
  container: HTMLElement,
  requestedOffset: number
): { node: Node; offset: number } | null {
  const document = container.ownerDocument;
  if (!document) return null;
  const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(container, showText);
  let remaining = Math.max(0, requestedOffset);
  let last: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    last = node;
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  if (!last) return null;
  return { node: last, offset: last.textContent?.length ?? 0 };
}

function isDetailsElement(element: HTMLElement): element is HTMLDetailsElement {
  const testTag = (element as unknown as { readonly tag?: string }).tag;
  return element.tagName?.toLowerCase() === "details" || testTag === "details";
}

function renderUnavailablePiImage(
  container: HTMLElement,
  displayName: string,
  language: SettingsLanguage = "zh-CN"
): HTMLElement {
  const unavailable = container.createDiv({
    cls: "codex-message-attachment-tile codex-message-attachment-unavailable is-disabled",
    attr: {
      role: "status",
      title: conversationUiText(language, `${displayName} · 图片附件不可在本地打开`, `${displayName} · Image attachment cannot be opened locally`),
      "aria-label": conversationUiText(language, `${displayName}：图片附件不可在本地打开`, `${displayName}: Image attachment cannot be opened locally`)
    }
  });
  const icon = unavailable.createSpan({ cls: "codex-message-attachment-icon" });
  setIcon(icon, "image-off");
  return unavailable;
}

function localDocumentSources(
  citations: KnowledgeBaseCitationSummary | undefined,
  usage: KnowledgeUsageMessageData
): LocalDocumentSource[] {
  const documents: LocalDocumentSource[] = [];
  const vaultDocuments = new Map<string, LocalVaultDocumentSource>();
  const memoryKeys = new Set<string>();
  const getVaultDocument = (rawPath: string): LocalVaultDocumentSource | null => {
    const path = rawPath.trim();
    if (!path) return null;
    const normalizedPath = normalizePath(path);
    const key = `vault:${normalizedPath}`;
    const existing = vaultDocuments.get(key);
    if (existing) return existing;
    const document: LocalVaultDocumentSource = {
      citations: [],
      key,
      kind: "vault",
      path: normalizedPath,
      references: []
    };
    vaultDocuments.set(key, document);
    documents.push(document);
    return document;
  };

  for (const citation of citations?.citations ?? []) {
    getVaultDocument(citation.path)?.citations.push(citation);
  }
  for (const reference of usage.references) {
    getVaultDocument(reference.vaultRelativePath)?.references.push(reference);
  }
  for (const source of usage.personalMemorySources) {
    const id = source.id.trim();
    if (!id) continue;
    const key = `memory:${id}`;
    if (memoryKeys.has(key)) continue;
    memoryKeys.add(key);
    documents.push({ key, kind: "memory", source });
  }
  return documents;
}

function localDocumentMetadata(
  document: LocalVaultDocumentSource,
  evidenceStatus?: KnowledgeBaseCitationSummary["status"],
  language: SettingsLanguage = "zh-CN"
): string[] {
  const copy = conversationCopy(language);
  const labels = new Set<string>();
  for (const citation of document.citations) labels.add(copy.sources.bucketLabel(citation.bucket));
  if (document.citations.length && evidenceStatus) {
    labels.add(copy.sources.evidenceStatus(evidenceStatus));
  }
  for (const reference of document.references) {
    labels.add(copy.sources.lineRange(reference.lineStart, reference.lineEnd));
  }
  return Array.from(labels);
}

function localDocumentExcerpts(document: LocalVaultDocumentSource): string[] {
  const excerpts = new Set<string>();
  for (const citation of document.citations) {
    const excerpt = citation.excerptLines.join("\n");
    if (excerpt) excerpts.add(excerpt);
  }
  for (const reference of document.references) {
    if (reference.excerpt) excerpts.add(reference.excerpt);
  }
  return Array.from(excerpts);
}

function hasRenderableDiff(files: ParsedDiffFile[]): boolean {
  return files.some((file) => file.lines.some((line) =>
    line.type === "hunk"
    || line.type === "add"
    || line.type === "remove"
    || line.type === "context"
  ));
}

function formatAbsoluteTime(
  value: number,
  language: SettingsLanguage = "zh-CN"
): string {
  return new Date(value).toLocaleString(conversationUiLocale(language), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function knowledgeBaseRunDisplayTitle(
  payload: KnowledgeBaseRunPayload,
  status?: string,
  language: SettingsLanguage = "zh-CN"
): string {
  if (status === "recovery-pending") return conversationUiText(language, "正在恢复上次知识库维护", "Recovering the previous Knowledge maintenance run");
  if (status === "recovery-blocked") return conversationUiText(language, "知识库维护恢复被阻断", "Knowledge maintenance recovery is blocked");
  if (status === "interrupted") return conversationUiText(language, "知识库任务已中断", "Knowledge task interrupted");
  if (status === "canceled") return conversationUiText(language, "知识库任务已取消", "Knowledge task cancelled");
  if (status === "failed") return conversationUiText(language, "知识库任务失败", "Knowledge task failed");
  if (status === "completed") return conversationUiText(language, "知识库任务已完成", "Knowledge task completed");
  return payload.title;
}

function knowledgeBaseRunStatusIcon(payload: KnowledgeBaseRunPayload, status: string): string {
  if (status === "completed") return "check";
  if (status === "recovery-blocked" || status === "interrupted" || status === "canceled" || status === "failed") return "x";
  return payload.icon;
}

export function knowledgeBaseRunEventCopy(
  payload: KnowledgeBaseRunPayload,
  language: SettingsLanguage = "zh-CN"
): string {
  const event = [...(payload.events ?? [])].reverse().find((candidate) =>
    candidate.type === "workflow.phase.started"
    || candidate.type === "workflow.phase.progress"
    || candidate.type === "workflow.phase.failed"
  );
  if (!event) return payload.subtitle;
  if (event.message?.trim()) return event.message.trim();
  if (event.phaseId) {
    const phase = payload.phases.find((candidate) => candidate.id === event.phaseId);
    if (phase) return conversationUiText(language, `${phase.label}阶段`, `${phase.label} phase`);
  }
  return payload.subtitle;
}

export function knowledgeBaseMaintainExecutionItems(
  payload: KnowledgeBaseMaintainReportPayload,
  language: SettingsLanguage = "zh-CN"
): string[] {
  const items: string[] = [];
  if (payload.completion === "noop") items.push(conversationUiText(language, "无新来源", "No new sources"));
  else if (payload.completion === "partial") items.push(conversationUiText(language, "部分完成", "Partially complete"));
  else if (payload.completion === "recovered") items.push(conversationUiText(language, "自动恢复完成", "Recovered automatically"));
  else if (payload.completion === "full") items.push(conversationUiText(language, "完整完成", "Complete"));

  if (payload.performance) {
    items.push(formatKnowledgeBaseRunDuration(payload.performance.totalMs, language));
    if (!payload.performance.agentCalled) items.push(conversationUiText(language, "未调用 Agent", "Agent was not called"));
    if (payload.performance.index) {
      items.push(conversationUiText(language, `索引复用 ${payload.performance.index.reused}，刷新 ${payload.performance.index.refreshed}`, `Index reused ${payload.performance.index.reused}, refreshed ${payload.performance.index.refreshed}`));
    }
    const completedPhases = payload.performance.phases.filter((phase) => phase.status === "success").length;
    if (payload.performance.phases.length) {
      items.push(conversationUiText(language, `${completedPhases}/${payload.performance.phases.length} 阶段`, `${completedPhases}/${payload.performance.phases.length} phases`));
    }
  }
  return items;
}

function formatKnowledgeBaseRunDuration(
  durationMs: number,
  language: SettingsLanguage = "zh-CN"
): string {
  const safeMs = Math.max(0, durationMs);
  if (safeMs < 1000) return conversationUiText(language, `用时 ${Math.round(safeMs)}ms`, `${Math.round(safeMs)}ms`);
  const totalSeconds = Math.round(safeMs / 100) / 10;
  if (totalSeconds < 60) return conversationUiText(language, `用时 ${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)} 秒`, `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)} sec`);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return conversationUiText(language, seconds ? `用时 ${minutes} 分 ${seconds} 秒` : `用时 ${minutes} 分`, seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`);
}

function firstPartyMessageTitle(
  message: Readonly<ChatMessage>,
  language: SettingsLanguage
): string {
  const title = message.title ?? "";
  return isFirstPartySystemPresentation(message)
    || (message.itemType === "knowledgeBase" && title === "知识库管理")
    ? localizeKnownConversationSystemCopy(language, title)
    : title;
}

function firstPartyMessageText(
  message: Readonly<ChatMessage>,
  language: SettingsLanguage
): string {
  const text = displayTextForMessage(message);
  if (isFirstPartySystemPresentation(message)) {
    return localizeKnownConversationSystemCopy(language, text);
  }
  if (message.itemType === "knowledgeBase" && text === "正在执行...") {
    return localizeKnownConversationSystemCopy(language, text);
  }
  if (
    message.role === "assistant"
    && message.itemType === "assistant"
    && text === "Agent 未返回可显示内容"
  ) {
    return localizeKnownConversationSystemCopy(language, text);
  }
  return text;
}

function firstPartyMessageDetail(
  message: Readonly<ChatMessage>,
  detail: string,
  language: SettingsLanguage
): string {
  if (!isFirstPartySystemPresentation(message)) return detail;
  const sourceNode = /^来源节点\s+(.+)$/u.exec(detail);
  if (sourceNode) {
    return conversationUiText(language, detail, `Source node ${sourceNode[1]}`);
  }
  const previousNode = /^原节点\s+(.+)$/u.exec(detail);
  if (previousNode) {
    return conversationUiText(language, detail, `Previous node ${previousNode[1]}`);
  }
  return localizeKnownConversationSystemCopy(language, detail);
}

function isFirstPartySystemPresentation(
  message: Readonly<ChatMessage>
): boolean {
  if (message.role === "system") return true;
  if (message.role !== "assistant") return false;
  return message.itemType === "contextCompaction"
    || message.itemType === "thinking"
    || message.itemType === "plan"
    || message.itemType === "image"
    || message.itemType === "error";
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
