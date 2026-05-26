import * as fs from "fs";
import * as path from "path";
import { ItemView, MarkdownView, Menu, Modal, normalizePath, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ChatMessage, DiffSummary, StoredAttachment, StoredSession } from "../settings/settings";
import { DEFAULT_SETTINGS, ensureKnowledgeBaseSession, ensureModelChoices, filterEnabledSkills, getActiveApiProvider, getApiProviderModels, isKnowledgeBaseSession, newId, providerConnectionLabel, resolveEditorActionModeConfig } from "../settings/settings";
import type {
  CodexNotification,
  CodexSkill,
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
import { buildDiffSummary, diffSummaryLabel, parseFileChangeDiff, serializeFileChanges, type ParsedDiffFile } from "../core/diff-summary";
import { diagnoseCodexError, type CodexErrorDiagnostic } from "../core/codex-diagnostics";
import { basename, buildUserInput, contextUsageView, filterSkills, normalizeProcessFileRef, processGroupStateId, reasoningTextFromPayload, summarizeProcessEvent } from "../core/mapping";
import { settleStaleRunningMessages } from "../core/message-state";
import { formatRateLimitUsage, normalizeRateLimitResponse, type RateLimitWindowView } from "../core/rate-limits";
import { displayTextForMessage, isLargeRawMessage } from "../core/raw-message-store";
import { calculateVirtualWindow, isNearVirtualBottom, scrollTopForVirtualBottom } from "../core/virtual-window";
import { renderSettingsGearIcon } from "./codex-icon";
import { composerIsBusy, composerPrimaryActionForState, type ComposerPrimaryActionState } from "./composer-state";
import { extractKnowledgeBaseResultTitle } from "./knowledge-base-result-title";
import { formatMessageHeaderTime } from "./message-time";
import { openImageOverlay, renderRichText } from "./render-message";
import { RuntimeTurnQueue, type QueuedTurnItem } from "./turn-queue";
import { CHAT_TURN_WATCHDOG_MS, turnWatchdogTimeoutForSession, turnWatchdogTimeoutText } from "./turn-watchdog";
import { textInputModal } from "./modals";
import { buildEditorActionPrompt, buildEditorActionReviewPrompt, buildEditorActionUserInput } from "../editor-actions/prompt";
import { editorActionStartBlockReason, extractEditorActionNotificationIds, routeEditorActionNotification as routeEditorActionNotificationState } from "../editor-actions/state";
import { buildEditorActionTurnOptions, resolveEditorActionModel } from "../editor-actions/turn-options";
import type { ArticleUnderstandingEntry, ArticleUnderstandingStatus, EditorActionQualityMode, EditorActionRequest, EditorActionStatusView } from "../editor-actions/types";
import { buildArticleUnderstandingPrompt, makeArticleUnderstandingCacheEntry, resolveArticleUnderstandingCache, upsertArticleUnderstandingCache, type EditorActionSummarySource } from "../editor-actions/summary-cache";
import { cleanEditorActionOutput, validateEditorActionCandidateText } from "../editor-actions/output";
import { knowledgeCommandOptions, knowledgeCommandQueryForInput, parseKnowledgeBaseCommand, type KnowledgeBaseCommandOption } from "../knowledge-base/commands";
import type { KnowledgeBaseDashboardFile, KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import type { KnowledgeBaseHistoryDaySummary } from "../knowledge-base/history-store";
import { clearKnowledgeBaseVisibleHistory, getHiddenKnowledgeBaseMessages, getVisibleKnowledgeBaseMessages } from "../knowledge-base/session-history";
import type { KnowledgeBaseCitation, KnowledgeBaseCitationBucket, KnowledgeBaseCitationSummary } from "../knowledge-base/types";

export const VIEW_TYPE_CODEX = "codex-for-obsidian-view";

type MessageRenderRow =
  | { id: string; kind: "message"; message: ChatMessage }
  | { id: string; kind: "processGroup"; messages: ChatMessage[] };

interface EditorActionRunWaiter {
  runId: string;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

interface EditorSummaryRunWaiter extends EditorActionRunWaiter {
  threadId: string;
}

interface ArticleUnderstandingPanelState {
  status: ArticleUnderstandingStatus;
  source?: EditorActionSummarySource;
  entry?: ArticleUnderstandingEntry | null;
  mode?: EditorActionQualityMode;
  modeLabel?: string;
  model?: string;
  usedInLastRun?: boolean;
  error?: string;
}

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
  private openProcessGroups = new Map<string, boolean>();
  private openProcessItems = new Map<string, boolean>();
  private openKnowledgeBaseCitations = new Map<string, boolean>();
  private renderScheduled = false;
  private pendingRenderForceBottom = false;
  private pendingRenderFromScroll = false;
  private measureScheduled = false;
  private pendingMeasureForceBottom = false;
  private virtualSessionId = "";
  private virtualRowHeights = new Map<string, number>();
  private rawTextCache = new Map<string, string>();
  private selectedSkill: CodexSkill | null = null;
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
  private readonly turnQueue = new RuntimeTurnQueue();
  private queueStartInProgress = false;
  private draggedQueueItemId = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.selectedModel = plugin.settings.defaultModel;
    this.selectedReasoning = plugin.settings.defaultReasoning;
    this.selectedServiceTier = plugin.settings.defaultServiceTier;
    this.selectedPermission = plugin.settings.defaultPermission;
    this.selectedMode = plugin.settings.defaultMode;
    this.activeRunKind = "";
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
    this.rejectEditorActionRun(new Error("Codex 侧栏已关闭"));
    this.rejectEditorSummaryRun(new Error("Codex 侧栏已关闭"));
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
    const { method, params } = notification;
    if (this.handleEditorActionNotification(method, params)) return;
    if (method === "turn/started") {
      const session = this.activeRunSession();
      const knowledgeSession = this.isKnowledgeBaseSession(session);
      this.running = true;
      this.activeTurnId = params?.turn?.id ?? "";
      this.turnStartedAt = Date.now();
      this.attachTurnIdToRun(session, this.activeTurnId);
      this.ensureThinkingMessage(session, "生成中", "正在生成回复...");
      const timeoutMs = turnWatchdogTimeoutForSession(knowledgeSession);
      if (timeoutMs === null) this.clearTurnWatchdog();
      else this.armTurnWatchdog(timeoutMs, turnWatchdogTimeoutText(timeoutMs));
      this.applyStatus();
      return;
    }
    if (method === "turn/completed") {
      const session = this.activeRunSession();
      const failed = params?.turn?.status === "failed";
      const shouldAdvanceQueue = this.activeRunKind === "chat";
      if (this.editorActionRun?.runId === this.activeRunId) {
        if (failed) {
          this.rejectEditorActionRun(new Error("Codex 写作任务失败"));
        } else if (this.editorActionRun.text.trim()) {
          this.resolveEditorActionRun(this.editorActionRun.text);
        } else {
          this.rejectEditorActionRun(new Error("Codex 没有返回候选文本"));
        }
      }
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.finishThinkingMessage(session, failed ? "中断" : "完成");
      this.finishRunningProcessMessages(session, failed ? "failed" : "completed");
      this.finishPlanMessage(session);
      this.clearActiveRun();
      this.applyStatus();
      void this.plugin.saveSettings(true);
      if (shouldAdvanceQueue) void this.afterTurnSettled(session.id, !failed);
      return;
    }
    if (method === "account/rateLimits/updated") {
      const normalizedRateLimits = normalizeRateLimitResponse(params);
      this.usageLoading = false;
      this.usageError = null;
      if (this.plugin.lastStatus) {
        this.plugin.lastStatus = {
          ...this.plugin.lastStatus,
          rateLimits: normalizedRateLimits.rateLimits,
          rateLimitsByLimitId: normalizedRateLimits.rateLimitsByLimitId
        };
      }
      this.updateUsageHeader(normalizedRateLimits.rateLimits, false, null);
      this.renderUsagePanel(normalizedRateLimits.rateLimits, null, false);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.updateContextForSession(this.activeRunSession(), params?.tokenUsage, true);
      return;
    }
    if (method === "thread/compacted") {
      const session = this.sessionForThread(params?.threadId ?? params?.thread?.id) ?? this.activeRunSession();
      this.addContextCompactionMessage(session);
      if (params?.tokenUsage) this.updateContextForSession(session, params.tokenUsage, true);
      return;
    }
    if (method === "item/started" && params?.item) {
      this.renderStartedItem(this.activeRunSession(), params.item);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const session = this.activeRunSession();
      this.markThinkingAsStreaming(session);
      this.appendItemDelta(session, params.itemId, "assistant", params.delta ?? "", "assistant", "回复");
      return;
    }
    if (method === "turn/plan/updated") {
      this.renderPlanUpdate(this.activeRunSession(), params);
      return;
    }
    if (method === "item/plan/delta") {
      this.appendProcessDelta(this.activeRunSession(), params.itemId, "plan", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/reasoning/summaryPartAdded") {
      void this.upsertProcessItem(this.activeRunSession(), params.itemId, "reasoning", "", "running", { ...params, status: "running" });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.appendProcessDelta(this.activeRunSession(), params.itemId, "reasoning", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      this.appendProcessDelta(this.activeRunSession(), params.itemId, "commandExecution", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/fileChange/outputDelta") {
      this.appendProcessDelta(this.activeRunSession(), params.itemId, "fileChange", params.delta ?? "", { text: params.delta ?? "", status: "running" });
      return;
    }
    if (method === "item/mcpToolCall/progress") {
      this.appendProcessDelta(this.activeRunSession(), params.itemId, "mcpToolCall", params.message ?? "", params);
      return;
    }
    if (method === "item/completed" && params?.item) {
      void this.renderCompletedItem(this.activeRunSession(), params.item).catch((error) => console.error("Codex item render failed", error));
      return;
    }
    if (method === "error") {
      const session = this.activeRunSession();
      const shouldPauseQueue = this.activeRunKind === "chat";
      const diagnostic = this.diagnoseCodexFailure(params?.message ?? "Codex 出错了");
      if (this.editorActionRun?.runId === this.activeRunId) this.rejectEditorActionRun(new Error(diagnostic.text));
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.finishThinkingMessage(session, "失败");
      this.finishRunningProcessMessages(session, "error");
      this.addMessageToSession(session, {
        role: "system",
        text: diagnostic.text,
        itemType: "error",
        title: diagnostic.title
      });
      this.clearActiveRun();
      this.applyStatus();
      if (shouldPauseQueue) void this.afterTurnSettled(session.id, false);
    }
  }

  private handleEditorActionNotification(method: string, params: any): boolean {
    if (this.handleEditorSummaryNotification(method, params)) return true;
    const isActiveEditorAction = this.isEditorActionRunActive();
    const route = this.routeEditorActionNotification(method, params, isActiveEditorAction, this.editorActionThreadId, method === "error");
    if (!route.swallow) return false;
    this.rememberEditorActionNotificationIds(params, route.current || route.rememberCurrentItem);
    if (!route.current) return true;
    if (method === "turn/started") {
      this.running = true;
      this.activeTurnId = params?.turn?.id ?? this.activeTurnId;
      this.turnStartedAt = Date.now();
      this.armTurnWatchdog(this.editorActionActiveTimeoutMs || this.plugin.settings.editorActions.timeoutMs);
      this.applyStatus();
      return true;
    }
    if (method === "turn/completed") {
      const failed = params?.turn?.status === "failed";
      if (failed) {
        this.rejectEditorActionRun(new Error("Codex 写作任务失败"));
      } else if (this.editorActionRun?.text.trim()) {
        this.resolveEditorActionRun(this.editorActionRun.text);
      } else {
        this.rejectEditorActionRun(new Error("Codex 没有返回候选文本"));
      }
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.clearActiveRun();
      this.applyStatus();
      return true;
    }
    if (method === "item/agentMessage/delta") {
      if (route.collectAssistantDelta && this.editorActionRun) this.editorActionRun.text += params?.delta ?? "";
      return true;
    }
    if (method === "error") {
      this.rejectEditorActionRun(new Error(this.diagnoseCodexFailure(params?.message ?? "Codex 出错了").text));
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.clearActiveRun();
      this.applyStatus();
      return true;
    }
    if (method.startsWith("item/") || method.startsWith("turn/") || method === "thread/tokenUsage/updated" || method === "thread/compacted") {
      return true;
    }
    return false;
  }

  private handleEditorSummaryNotification(method: string, params: any): boolean {
    if (!this.isEditorSummaryRunActive()) return false;
    const summaryThreadId = this.editorSummaryRun?.threadId ?? "";
    const route = this.routeEditorActionNotification(method, params, true, summaryThreadId, method === "error");
    if (!route.swallow) return false;
    this.rememberEditorActionNotificationIds(params, route.current || route.rememberCurrentItem);
    if (!route.current) return true;
    if (method === "turn/started") {
      this.activeTurnId = params?.turn?.id ?? this.activeTurnId;
      return true;
    }
    if (method === "turn/completed") {
      const failed = params?.turn?.status === "failed";
      const runId = this.editorSummaryRun?.runId;
      if (failed) {
        this.rejectEditorSummaryRun(new Error("摘要生成失败"));
      } else if (this.editorSummaryRun?.text.trim()) {
        this.resolveEditorSummaryRun(this.editorSummaryRun.text);
      } else {
        this.rejectEditorSummaryRun(new Error("摘要为空"));
      }
      this.releaseEditorSummaryRunLock(runId);
      return true;
    }
    if (method === "item/agentMessage/delta") {
      if (this.editorSummaryRun) this.editorSummaryRun.text += params?.delta ?? "";
      return true;
    }
    if (method === "error") {
      const runId = this.editorSummaryRun?.runId;
      this.rejectEditorSummaryRun(new Error(this.diagnoseCodexFailure(params?.message ?? "摘要生成失败").text));
      this.releaseEditorSummaryRunLock(runId);
      return true;
    }
    if (method.startsWith("item/") || method.startsWith("turn/") || method === "thread/tokenUsage/updated" || method === "thread/compacted") {
      return true;
    }
    return false;
  }

  focusInput(): void {
    window.setTimeout(() => this.inputEl?.focus(), 50);
  }

  private render(): void {
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({ cls: "codex-container" });

    const header = this.rootEl.createDiv({ cls: "codex-header" });
    const title = header.createDiv({ cls: "codex-title" });
    const icon = title.createSpan({ cls: "codex-title-icon codex-title-icon-codex", attr: { "aria-hidden": "true" } });
    setIcon(icon, "bot");
    title.createSpan({ cls: "codex-title-text", text: "EchoInk" });
    const headerActions = header.createDiv({ cls: "codex-header-actions" });
    this.editorActionStatusEl = headerActions.createDiv({
      cls: "codex-status-chip codex-editor-action-status is-idle",
      attr: { role: "button", tabindex: "0", "aria-label": "写作上下文" }
    });
    const editorActionIcon = this.editorActionStatusEl.createSpan({ cls: "codex-header-status-icon" });
    setIcon(editorActionIcon, "wand-sparkles");
    this.editorActionStatusTextEl = this.editorActionStatusEl.createSpan({ cls: "codex-header-status-text", text: "写作" });
    this.editorActionStatusEl.onclick = (event) => {
      event.stopPropagation();
      this.articleUnderstandingPanelVisible = !this.articleUnderstandingPanelVisible;
      if (this.articleUnderstandingPanelVisible) void this.refreshArticleUnderstandingPanelSourceState();
      this.renderArticleUnderstandingPanel();
    };
    this.editorActionStatusEl.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.articleUnderstandingPanelVisible = !this.articleUnderstandingPanelVisible;
      if (this.articleUnderstandingPanelVisible) void this.refreshArticleUnderstandingPanelSourceState();
      this.renderArticleUnderstandingPanel();
    };
    this.headerHistoryEl = headerActions.createEl("button", {
      cls: "codex-status-chip codex-header-history is-hidden",
      attr: { type: "button", title: "查看知识库历史", "aria-label": "查看知识库历史" }
    });
    const historyIcon = this.headerHistoryEl.createSpan({ cls: "codex-header-status-icon" });
    setIcon(historyIcon, "history");
    this.headerHistoryEl.createSpan({ cls: "codex-header-status-text", text: "历史" });
    this.headerHistoryEl.onclick = (event) => {
      event.stopPropagation();
      const session = this.ensureSession();
      if (!this.isKnowledgeBaseSession(session)) return;
      void this.openKnowledgeBaseHistory(session);
    };
    this.headerStatusEl = headerActions.createDiv({ cls: "codex-header-status codex-status-chip" });
    const statusIcon = this.headerStatusEl.createSpan({ cls: "codex-header-status-icon" });
    setIcon(statusIcon, "activity");
    this.headerStatusTextEl = this.headerStatusEl.createSpan({ cls: "codex-header-status-text", text: "连接中" });

    this.headerUsageEl = headerActions.createEl("button", {
      cls: "codex-status-chip codex-usage-chip",
      attr: { type: "button", "aria-label": "Codex 用量", title: "Codex 用量" }
    });
    const usageIcon = this.headerUsageEl.createSpan({ cls: "codex-header-status-icon" });
    setIcon(usageIcon, "gauge");
    this.headerUsageTextEl = this.headerUsageEl.createSpan({ cls: "codex-header-status-text", text: "用量 --" });
    this.headerUsageEl.onclick = async (event) => {
      event.stopPropagation();
      const willShow = !this.usagePanelEl.hasClass("is-visible");
      this.usagePanelEl.toggleClass("is-visible", willShow);
      if (willShow) await this.refreshHeaderRateLimits();
    };

    const resourceButton = headerActions.createEl("button", {
      cls: "codex-icon-button codex-resource-button",
      attr: { type: "button", "aria-label": "插件 MCP Skills 管理", title: "插件 / MCP / Skills 管理" }
    });
    setIcon(resourceButton, "blocks");
    resourceButton.onclick = () => void this.plugin.openWorkspaceResourceSettings("plugins");

    const settingsButton = headerActions.createEl("button", {
      cls: "codex-icon-button codex-settings-button",
      attr: { type: "button", "aria-label": "打开插件设置", title: "打开插件设置" }
    });
    renderSettingsGearIcon(settingsButton);
    settingsButton.onclick = () => this.openPluginSettings();

    this.usagePanelEl = header.createDiv({ cls: "codex-usage-panel" });
    this.articleUnderstandingPanelEl = header.createDiv({ cls: "codex-article-panel" });
    this.registerDomEvent(document, "click", (event) => {
      if (!this.rootEl.contains(event.target as Node)) {
        this.usagePanelEl.removeClass("is-visible");
        this.closeComposerMenus();
      }
    });

    this.tabBarEl = this.rootEl.createDiv({ cls: "codex-tabs" });
    this.knowledgeDashboardEl = this.rootEl.createDiv({ cls: "codex-kb-dashboard" });
    this.messagesEl = this.rootEl.createDiv({ cls: "codex-messages" });
    this.virtualListEl = this.messagesEl.createDiv({ cls: "codex-virtual-list" });
    this.registerDomEvent(this.messagesEl, "scroll", () => this.scheduleRenderMessages({ fromScroll: true }));

    const inputWrap = this.rootEl.createDiv({ cls: "codex-input-wrap" });
    this.queueEl = inputWrap.createDiv({ cls: "codex-turn-queue" });
    this.attachmentsEl = inputWrap.createDiv({ cls: "codex-attachments" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "codex-input",
      attr: { placeholder: "问 Codex，让它管理当前 Obsidian 仓库" }
    });
    this.inputEl.addEventListener("input", () => this.onInputChanged());
    this.inputEl.addEventListener("paste", (event) => {
      void this.handlePastedFiles(event);
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    inputWrap.addEventListener("dragover", (event) => {
      event.preventDefault();
      inputWrap.addClass("is-dragging");
    });
    inputWrap.addEventListener("dragleave", () => inputWrap.removeClass("is-dragging"));
    inputWrap.addEventListener("drop", (event) => {
      event.preventDefault();
      inputWrap.removeClass("is-dragging");
      this.handleDroppedFiles(event);
    });

    this.skillMenuEl = inputWrap.createDiv({ cls: "codex-skill-menu" });
    this.knowledgeCommandMenuEl = inputWrap.createDiv({ cls: "codex-knowledge-command-menu" });
    this.toolbarEl = inputWrap.createDiv({ cls: "codex-toolbar" });
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
    this.headerHistoryEl.toggleClass("is-hidden", !visible);
    this.headerHistoryEl.setAttr("aria-hidden", visible ? "false" : "true");
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
    const enabled = this.plugin.settings.editorActions.statusSlotEnabled;
    const status = this.editorActionStatus;
    this.editorActionStatusEl.toggleClass("is-hidden", !enabled);
    this.editorActionStatusEl.toggleClass("is-idle", status.status === "idle");
    this.editorActionStatusEl.toggleClass("is-active", status.status === "preparing" || status.status === "connecting" || status.status === "generating");
    this.editorActionStatusEl.toggleClass("is-loading", status.status === "preparing" || status.status === "connecting" || status.status === "generating");
    this.editorActionStatusEl.toggleClass("is-ok", status.status === "awaiting-confirm" || status.status === "confirmed");
    this.editorActionStatusEl.toggleClass("has-warning", status.status === "failed" || status.status === "canceled");
    this.editorActionStatusTextEl.setText(editorActionStatusLabel(status));
    this.editorActionStatusEl.setAttr("title", status.error || status.message || "编辑区 AI 写作状态");
    this.renderArticleUnderstandingPanel();
  }

  private renderArticleUnderstandingPanel(): void {
    if (!this.articleUnderstandingPanelEl) return;
    const settings = this.plugin.settings.editorActions;
    this.articleUnderstandingPanelEl.empty();
    this.articleUnderstandingPanelEl.toggleClass("is-visible", this.articleUnderstandingPanelVisible && settings.showContextPanel);
    if (!this.articleUnderstandingPanelVisible || !settings.showContextPanel) return;

    const state = this.articleUnderstandingPanelState;
    const modeConfig = resolveEditorActionModeConfig(settings, state.mode ?? settings.qualityMode);
    const title = this.articleUnderstandingPanelEl.createDiv({ cls: "codex-article-panel-title" });
    const titleIcon = title.createSpan({ cls: "codex-usage-panel-icon" });
    setIcon(titleIcon, "file-search");
    title.createSpan({ text: "写作上下文" });

    const meta = this.articleUnderstandingPanelEl.createDiv({ cls: "codex-article-panel-meta" });
    this.addArticlePanelRow(meta, "文件", state.source?.fileName ?? "当前未选择笔记");
    this.addArticlePanelRow(meta, "模式", state.modeLabel ?? modeConfig.label);
    this.addArticlePanelRow(meta, "模型", state.model ?? modeConfig.model);
    this.addArticlePanelRow(meta, "状态", articleUnderstandingStatusLabel(state.status, state.error));
    this.addArticlePanelRow(meta, "更新时间", state.entry?.updatedAt ? formatRelativeTime(state.entry.updatedAt) : "无");
    this.addArticlePanelRow(meta, "本次使用", state.usedInLastRun ? "已使用文章理解" : "未使用文章理解");

    const body = this.articleUnderstandingPanelEl.createDiv({ cls: "codex-article-panel-body" });
    if (state.entry?.understanding) {
      renderRichText(this.plugin.app, this, body, state.entry.understanding);
    } else if (state.mode === "fast" || settings.qualityMode === "fast") {
      body.createDiv({ cls: "codex-article-panel-empty", text: "快速模式写作时不使用文章理解；也可以手动刷新，先建立可见上下文。" });
    } else {
      body.createDiv({ cls: "codex-article-panel-empty", text: "还没有文章理解。点击刷新理解，或直接使用质量/严格写作触发。" });
    }

    const actions = this.articleUnderstandingPanelEl.createDiv({ cls: "codex-article-panel-actions" });
    const refresh = actions.createEl("button", { cls: "codex-resource-refresh", text: "刷新理解", attr: { type: "button" } });
    refresh.disabled = state.status === "running";
    refresh.onclick = () => void this.refreshArticleUnderstandingFromPanel();
    const clear = actions.createEl("button", { cls: "codex-resource-tab", text: "清除理解", attr: { type: "button" } });
    clear.disabled = !state.source?.filePath && !state.entry?.filePath;
    clear.onclick = async () => {
      const filePath = state.source?.filePath ?? state.entry?.filePath;
      if (!filePath) return;
      delete this.plugin.settings.editorActions.articleUnderstandingCache[filePath];
      this.articleUnderstandingPanelState = { ...state, status: settings.qualityMode === "fast" ? "idle" : "missing", entry: null, usedInLastRun: false };
      await this.plugin.saveSettings();
      this.renderEditorActionStatus();
    };
    const settingsButton = actions.createEl("button", { cls: "codex-resource-tab", text: "打开设置", attr: { type: "button" } });
    settingsButton.onclick = async () => {
      this.plugin.settings.settingsTab = "editorActions";
      await this.plugin.saveSettings();
      this.openPluginSettings();
    };
  }

  private addArticlePanelRow(container: HTMLElement, label: string, value: string): void {
    const row = container.createDiv({ cls: "codex-article-panel-row" });
    row.createSpan({ cls: "codex-article-panel-label", text: label });
    row.createSpan({ cls: "codex-article-panel-value", text: value });
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
    const usage = formatRateLimitUsage(rateLimits);
    this.headerUsageTextEl.setText(loading && !rateLimits ? "读取中" : usage.summary);
    this.headerUsageEl.setAttr("title", loading ? "正在读取 Codex 用量" : error && !rateLimits ? `读取失败：${error}` : usage.title);
    this.headerUsageEl.toggleClass("is-loading", loading);
    this.headerUsageEl.toggleClass("has-warning", Boolean(error && !rateLimits) || (!rateLimits && !loading));
    this.headerUsageEl.toggleClass("is-ok", Boolean(rateLimits && !error && !loading));
  }

  private renderUsagePanel(rateLimits: RateLimitSnapshot | null, error?: string | null, loading = false): void {
    if (!this.usagePanelEl) return;
    const usage = formatRateLimitUsage(rateLimits);
    this.usagePanelEl.empty();
    const title = this.usagePanelEl.createDiv({ cls: "codex-usage-panel-title" });
    const icon = title.createSpan({ cls: "codex-usage-panel-icon" });
    setIcon(icon, "gauge");
    title.createSpan({ text: "剩余额度" });
    if (!usage.primary && !usage.secondary) {
      if (loading) {
        this.usagePanelEl.createDiv({ cls: "codex-usage-loading", text: "正在读取 Codex 用量..." });
        return;
      }
      if (error) {
        this.usagePanelEl.createDiv({ cls: "codex-usage-error", text: `读取失败：${error}` });
        return;
      }
      this.usagePanelEl.createDiv({ cls: "codex-usage-empty", text: "暂未读取到 Codex 用量。" });
      return;
    }
    if (usage.primary) this.renderUsageRow(usage.primary);
    if (usage.secondary) this.renderUsageRow(usage.secondary);
    if (loading) this.usagePanelEl.createDiv({ cls: "codex-usage-loading", text: "正在更新..." });
    if (error) this.usagePanelEl.createDiv({ cls: "codex-usage-error", text: `更新失败：${error}` });
  }

  private renderUsageRow(item: RateLimitWindowView): void {
    const row = this.usagePanelEl.createDiv({ cls: "codex-usage-row" });
    row.createDiv({ cls: "codex-usage-label", text: item.label });
    row.createDiv({ cls: "codex-usage-percent", text: `${item.remainingPercent}%` });
    row.createDiv({ cls: "codex-usage-reset", text: item.resetLabel });
  }

  private openPluginSettings(): void {
    const setting = (this.app as any).setting;
    if (!setting?.open || !setting?.openTabById) {
      new Notice("无法打开插件设置页");
      return;
    }
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }

  private renderTabs(): void {
    this.ensureSession();
    this.tabBarEl.empty();
    let chatIndex = 0;
    this.plugin.settings.sessions.forEach((session) => {
      const knowledgeSession = isKnowledgeBaseSession(session, this.plugin.settings.knowledgeBase.sessionId);
      if (!knowledgeSession) chatIndex += 1;
      const tab = this.tabBarEl.createEl("button", {
        cls: `codex-tab ${session.id === this.plugin.settings.activeSessionId ? "is-active" : ""} ${knowledgeSession ? "is-knowledge-base" : ""}`.trim(),
        text: knowledgeSession ? "知识库" : String(chatIndex),
        attr: { type: "button", title: knowledgeSession ? "知识库管理（常驻）" : (session.title || "新会话") }
      });
      tab.onclick = async () => {
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
      };
      tab.oncontextmenu = (event) => this.openSessionMenu(event, session);
      tab.ondblclick = () => {
        if (knowledgeSession) {
          new Notice("知识库管理频道是常驻频道，不能重命名");
          return;
        }
        void this.renameSession(session);
      };
    });
    const newButton = this.tabBarEl.createEl("button", { cls: "codex-tab-new", attr: { type: "button", "aria-label": "新建会话" } });
    setIcon(newButton, "plus");
    newButton.onclick = async () => {
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
    };
  }

  private renderMessages(options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void {
    const session = this.ensureSession();
    this.settleStaleMessages(session);
    const knowledgeSession = this.isKnowledgeBaseSession(session);
    const messages = knowledgeSession ? getVisibleKnowledgeBaseMessages(session) : session.messages;
    const hiddenCount = knowledgeSession ? getHiddenKnowledgeBaseMessages(session).length : 0;
    if (this.virtualSessionId !== session.id) {
      this.virtualSessionId = session.id;
      this.virtualRowHeights.clear();
    }
    const previousScrollTop = this.messagesEl.scrollTop;
    const shouldPinBottom = Boolean(options.forceBottom) || (!options.fromScroll && this.isMessagesNearBottom());
    this.virtualListEl.empty();
    if (messages.length === 0) {
      this.virtualListEl.style.height = "100%";
      const welcome = this.virtualListEl.createDiv({ cls: "codex-welcome" });
      welcome.createDiv({ cls: "codex-welcome-title", text: knowledgeSession ? "知识库管理" : "What's new?" });
      if (knowledgeSession) {
        welcome.createDiv({ cls: "codex-resource-note", text: hiddenCount ? `当前页面已清空，隐藏 ${hiddenCount} 条本地历史；输入 /history 查看。` : "输入 /help 查看命令；也可以直接说只体检一下、维护知识库、写周报、收集这个链接。" });
        if (hiddenCount) {
          const historyButton = welcome.createEl("button", { cls: "codex-kb-history-inline-button", text: "查看历史", attr: { type: "button" } });
          historyButton.onclick = () => this.openKnowledgeBaseHistory(session);
        }
      } else if (!session.cwd) {
        welcome.createDiv({ cls: "codex-resource-note", text: "普通会话需要先选择工作区；添加笔记只作为本轮上下文。" });
      }
      return;
    }
    const rows = this.buildVirtualRows(messages);
    const rowIds = rows.map((row) => row.id);
    this.pruneVirtualHeights(rowIds);
    const viewportHeight = Math.max(1, this.messagesEl.clientHeight);
    const virtual = calculateVirtualWindow({
      rowIds,
      rowHeights: this.virtualRowHeights,
      scrollTop: previousScrollTop,
      viewportHeight
    });
    this.virtualListEl.style.height = `${Math.max(virtual.totalHeight, viewportHeight)}px`;

    for (const virtualRow of virtual.rows) {
      const row = rows[virtualRow.index];
      if (!row) continue;
      const rowEl = this.virtualListEl.createDiv({ cls: `codex-virtual-row codex-virtual-row-${row.kind}` });
      rowEl.dataset.rowId = virtualRow.id;
      rowEl.dataset.index = String(virtualRow.index);
      rowEl.style.transform = `translateY(${virtualRow.top}px)`;
      this.renderVirtualRow(rowEl, row);
    }

    this.measureVisibleVirtualRows(shouldPinBottom);
    if (shouldPinBottom) {
      this.messagesEl.scrollTop = scrollTopForVirtualBottom(virtual.totalHeight, viewportHeight);
    } else if (options.fromScroll || options.preserveScroll) {
      this.messagesEl.scrollTop = previousScrollTop;
    }
  }

  private renderKnowledgeDashboard(): void {
    if (!this.knowledgeDashboardEl) return;
    const session = this.ensureSession();
    const visible = this.isKnowledgeBaseSession(session);
    this.knowledgeDashboardEl.empty();
    this.knowledgeDashboardEl.toggleClass("is-visible", visible);
    if (!visible) return;

    const snapshot = this.knowledgeDashboardSnapshot;
    const healthStatus = snapshot?.health.status ?? "unknown";
    const hasWarning = Boolean(this.knowledgeDashboardError || healthStatus === "risk" || healthStatus === "bad" || snapshot?.warnings.length);
    this.knowledgeDashboardEl.toggleClass("has-warning", hasWarning);
    this.knowledgeDashboardEl.toggleClass("health-healthy", healthStatus === "healthy");
    this.knowledgeDashboardEl.toggleClass("health-risk", healthStatus === "risk");
    this.knowledgeDashboardEl.toggleClass("health-bad", healthStatus === "bad");
    this.knowledgeDashboardEl.toggleClass("is-loading", this.knowledgeDashboardLoading);

    const header = this.knowledgeDashboardEl.createDiv({ cls: "codex-kb-dashboard-header" });
    const title = header.createDiv({ cls: "codex-kb-dashboard-title" });
    const titleIcon = title.createSpan({ cls: "codex-kb-dashboard-icon" });
    setIcon(titleIcon, "database");
    title.createSpan({ text: "知识库状态" });

    const summary = header.createDiv({ cls: "codex-kb-dashboard-summary" });
    if (snapshot) {
      this.addKnowledgeDashboardRulesMetric(summary, snapshot);
      this.addKnowledgeDashboardMetric(summary, "Raw", `${snapshot.raw.fileCount}`);
      this.addKnowledgeDashboardMetric(summary, "Wiki", `${snapshot.wiki.fileCount}`);
      this.addKnowledgeDashboardMetric(summary, "Inbox", `${snapshot.inbox.fileCount}`);
      this.addKnowledgeDashboardHealthMetric(summary, snapshot.health.status, snapshot.health.label);
    } else {
      summary.createSpan({ cls: "codex-kb-dashboard-muted", text: this.knowledgeDashboardError || "等待扫描" });
    }

    const actions = header.createDiv({ cls: "codex-kb-dashboard-actions" });
    const refresh = actions.createEl("button", { cls: "codex-icon-button codex-kb-dashboard-button", attr: { type: "button", title: "刷新状态", "aria-label": "刷新状态" } });
    setIcon(refresh, this.knowledgeDashboardLoading ? "loader-circle" : "refresh-cw");
    refresh.disabled = this.knowledgeDashboardLoading;
    refresh.onclick = () => void this.refreshKnowledgeDashboard(true);
    const toggleTitle = this.knowledgeDashboardExpanded ? "收起详情" : "展开详情";
    const toggle = actions.createEl("button", { cls: "codex-icon-button codex-kb-dashboard-button", attr: { type: "button", title: toggleTitle, "aria-label": toggleTitle } });
    setIcon(toggle, this.knowledgeDashboardExpanded ? "chevron-up" : "chevron-down");
    toggle.onclick = () => {
      this.knowledgeDashboardExpanded = !this.knowledgeDashboardExpanded;
      this.renderKnowledgeDashboard();
    };

    if (this.knowledgeDashboardError) {
      this.knowledgeDashboardEl.createDiv({ cls: "codex-kb-dashboard-error", text: this.knowledgeDashboardError });
    }
    if (!snapshot || !this.knowledgeDashboardExpanded) return;

    const details = this.knowledgeDashboardEl.createDiv({ cls: "codex-kb-dashboard-details" });
    this.renderKnowledgeDashboardHealth(details, snapshot);
    this.renderKnowledgeDashboardWiki(details, snapshot);
    this.renderKnowledgeDashboardQueues(details, snapshot);
    this.renderKnowledgeDashboardHeatmap(details, snapshot);
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

  private addKnowledgeDashboardMetric(container: HTMLElement, label: string, value: string): void {
    const metric = container.createSpan({ cls: "codex-kb-dashboard-metric" });
    metric.createSpan({ cls: "codex-kb-dashboard-metric-label", text: label });
    metric.createSpan({ cls: "codex-kb-dashboard-metric-value", text: value });
  }

  private addKnowledgeDashboardRulesMetric(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
    const button = container.createEl("button", {
      cls: "codex-kb-dashboard-metric codex-kb-dashboard-rule",
      attr: {
        type: "button",
        title: snapshot.rulesFileExists ? `打开规则文件：${snapshot.rulesFilePath}` : "规则文件缺失，点击查看提示",
        "aria-label": snapshot.rulesFileExists ? `打开规则文件 ${snapshot.rulesFilePath}` : "规则文件缺失"
      }
    });
    button.toggleClass("is-missing", !snapshot.rulesFileExists);
    button.createSpan({ cls: "codex-kb-dashboard-metric-label", text: "规则" });
    button.createSpan({ cls: "codex-kb-dashboard-metric-value", text: snapshot.rulesFileExists ? snapshot.rulesFilePath : "缺失" });
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.openKnowledgeDashboardRulesFile(snapshot);
    };
  }

  private addKnowledgeDashboardHealthMetric(container: HTMLElement, status: string, label: string): void {
    const metric = container.createSpan({ cls: `codex-kb-dashboard-metric codex-kb-dashboard-health codex-kb-health-${status}` });
    metric.createSpan({ cls: "codex-kb-status-dot" });
    metric.createSpan({ cls: "codex-kb-dashboard-metric-value", text: label });
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

  private renderKnowledgeDashboardHealth(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
    const section = this.addKnowledgeDashboardSection(container, "健康概览");
    const overview = section.createDiv({ cls: "codex-kb-dashboard-health-overview" });
    this.addKnowledgeDashboardMeter(
      overview,
      "知识库健康",
      snapshot.health.score,
      `codex-kb-health-${snapshot.health.status}`,
      snapshot.health.label
    );
    this.addKnowledgeDashboardMeter(
      overview,
      "体检新鲜度",
      snapshot.checkFreshness.score,
      `codex-kb-freshness-${snapshot.checkFreshness.status}`,
      snapshot.checkFreshness.label
    );

    const facts = section.createDiv({ cls: "codex-kb-dashboard-facts" });
    this.addKnowledgeDashboardFact(facts, "最近体检", snapshot.checkFreshness.lastCheckAt ? formatAbsoluteTime(snapshot.checkFreshness.lastCheckAt) : "无记录");
    this.addKnowledgeDashboardFact(facts, "新鲜度", snapshot.checkFreshness.daysSinceCheck >= 0 ? `${snapshot.checkFreshness.daysSinceCheck} 天前确认` : "无记录");
    this.addKnowledgeDashboardFact(facts, "连续体检", snapshot.health.streakDays ? `${snapshot.health.streakDays} 天` : "0 天");
    this.addKnowledgeDashboardFact(facts, "最近任务", knowledgeRunStatusLabel(snapshot.lastRun.status, snapshot.lastRun.at));
    this.addKnowledgeDashboardFact(facts, "Tracker", snapshot.tracker.exists ? `${snapshot.tracker.trackedCount} 条` : "缺失");

    const healthReasons = snapshot.health.status === "healthy" ? [] : snapshot.health.reasons;
    const freshnessReasons = snapshot.checkFreshness.status === "fresh" ? [] : snapshot.checkFreshness.reasons;
    if (!healthReasons.length && !freshnessReasons.length) return;
    const reasons = section.createDiv({ cls: "codex-kb-dashboard-reasons" });
    for (const reason of healthReasons) {
      reasons.createDiv({ cls: "codex-kb-dashboard-reason", text: reason });
    }
    for (const reason of freshnessReasons) {
      reasons.createDiv({ cls: "codex-kb-dashboard-reason codex-kb-dashboard-reason-muted", text: reason });
    }
  }

  private addKnowledgeDashboardMeter(container: HTMLElement, label: string, scoreValue: number, statusClass: string, statusLabel: string): void {
    const row = container.createDiv({ cls: "codex-kb-dashboard-meter-row" });
    row.createDiv({ cls: "codex-kb-dashboard-meter-label", text: label });
    const score = row.createDiv({ cls: "codex-kb-dashboard-score" });
    score.createSpan({ cls: "codex-kb-dashboard-score-label", text: `${scoreValue}` });
    const track = score.createDiv({ cls: "codex-kb-dashboard-score-track" });
    const fill = track.createDiv({ cls: `codex-kb-dashboard-score-fill ${statusClass}` });
    fill.style.width = `${Math.max(0, Math.min(100, scoreValue))}%`;
    const status = row.createDiv({ cls: `codex-kb-dashboard-health-badge ${statusClass}` });
    status.createSpan({ cls: "codex-kb-status-dot" });
    status.createSpan({ text: statusLabel });
  }

  private renderKnowledgeDashboardWiki(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
    const rows = snapshot.wiki.groups.length
      ? snapshot.wiki.groups.map((group) => [group.label, `${group.totalCount}`, `${group.sharePercent}%`, group.todayCount ? `+${group.todayCount}` : "-"])
      : [["无一级目录", "0", "-", "-"]];
    this.addKnowledgeDashboardTable(container, "Wiki 状态", ["一级目录", "总数量", "占比", "今日更新"], rows);
  }

  private renderKnowledgeDashboardQueues(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
    this.addKnowledgeDashboardTable(container, "Raw / Inbox 状态", ["区域", "总数量", "今日新增", "待处理"], [
      ["Raw", `${snapshot.raw.fileCount}`, snapshot.raw.todayCount ? `+${snapshot.raw.todayCount}` : "-", `${snapshot.raw.changedCount}`],
      ["Inbox", `${snapshot.inbox.fileCount}`, snapshot.inbox.todayCount ? `+${snapshot.inbox.todayCount}` : "-", `${snapshot.inbox.fileCount}`]
    ]);
  }

  private renderKnowledgeDashboardHeatmap(container: HTMLElement, snapshot: KnowledgeBaseDashboardSnapshot): void {
    const section = this.addKnowledgeDashboardSection(container, "体检热力图");
    const year = heatmapYear(snapshot);
    const completedChecks = snapshot.checkHeatmap.filter((day) => day.status === "success" || day.status === "failed").length;
    section.createDiv({ cls: "codex-kb-heatmap-summary", text: `${year} 年 ${completedChecks} 次体检` });
    const heatmap = section.createDiv({ cls: "codex-kb-dashboard-heatmap" });
    const grid = heatmap.createDiv({ cls: "codex-kb-heatmap-grid" });
    const yearStart = new Date(year, 0, 1, 12, 0, 0, 0);
    const weekCount = Math.max(1, ...snapshot.checkHeatmap.map((day) => heatmapWeekIndex(day.date, yearStart) + 1));
    grid.style.setProperty("--codex-kb-heatmap-weeks", String(weekCount));

    const monthStarts = new Set<string>();
    for (const day of snapshot.checkHeatmap) {
      if (day.date.endsWith("-01")) monthStarts.add(day.date);
    }
    for (const dateKey of monthStarts) {
      const date = parseHeatmapDateKey(dateKey);
      if (!date) continue;
      const label = grid.createDiv({ cls: "codex-kb-heatmap-month", text: HEATMAP_MONTH_LABELS[date.getMonth()] });
      label.style.gridColumn = `${heatmapWeekIndex(dateKey, yearStart) + 2}`;
      label.style.gridRow = "1";
    }
    for (const [weekday, label] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]] as Array<[number, string]>) {
      const dayLabel = grid.createDiv({ cls: "codex-kb-heatmap-weekday", text: label });
      dayLabel.style.gridColumn = "1";
      dayLabel.style.gridRow = `${weekday + 2}`;
    }

    for (const day of snapshot.checkHeatmap) {
      const date = parseHeatmapDateKey(day.date);
      if (!date) continue;
      const cell = grid.createSpan({
        cls: `codex-kb-heatmap-cell is-${day.status}`,
        attr: { title: `${day.date} · ${knowledgeHeatmapStatusLabel(day.status)}`, "aria-label": `${day.date} ${knowledgeHeatmapStatusLabel(day.status)}` }
      });
      cell.style.gridColumn = `${heatmapWeekIndex(day.date, yearStart) + 2}`;
      cell.style.gridRow = `${date.getDay() + 2}`;
    }
    const legend = section.createDiv({ cls: "codex-kb-dashboard-legend" });
    legend.createSpan({ cls: "codex-kb-dashboard-legend-label", text: "Less" });
    legend.createSpan({ cls: "codex-kb-legend-dot is-none" });
    legend.createSpan({ cls: "codex-kb-legend-dot is-success is-low" });
    legend.createSpan({ cls: "codex-kb-legend-dot is-success" });
    legend.createSpan({ cls: "codex-kb-dashboard-legend-label", text: "More" });
    const failed = legend.createSpan({ cls: "codex-kb-dashboard-legend-item" });
    failed.createSpan({ cls: "codex-kb-legend-dot is-failed" });
    failed.createSpan({ text: "失败" });
  }

  private addKnowledgeDashboardSection(container: HTMLElement, title: string): HTMLElement {
    const section = container.createDiv({ cls: "codex-kb-dashboard-section" });
    section.createDiv({ cls: "codex-kb-dashboard-section-title", text: title });
    return section;
  }

  private addKnowledgeDashboardFact(container: HTMLElement, label: string, value: string): void {
    const fact = container.createDiv({ cls: "codex-kb-dashboard-fact" });
    fact.createSpan({ cls: "codex-kb-dashboard-fact-label", text: label });
    fact.createSpan({ cls: "codex-kb-dashboard-fact-value", text: value });
  }

  private addKnowledgeDashboardTable(container: HTMLElement, title: string, columns: string[], rows: string[][]): void {
    const section = this.addKnowledgeDashboardSection(container, title);
    const table = section.createEl("table", { cls: "codex-kb-dashboard-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    for (const column of columns) headRow.createEl("th", { text: column });
    const tbody = table.createEl("tbody");
    for (const row of rows) {
      const tr = tbody.createEl("tr");
      for (const cell of row) tr.createEl("td", { text: cell });
    }
  }

  private buildVirtualRows(messages: ChatMessage[]): MessageRenderRow[] {
    const rows: MessageRenderRow[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (isGroupedProcessItemType(message.itemType)) {
        const group = [message];
        while (index + 1 < messages.length && isGroupedProcessItemType(messages[index + 1].itemType) && sameProcessRun(message, messages[index + 1])) {
          group.push(messages[index + 1]);
          index += 1;
        }
        rows.push({ id: processGroupRowId(group), kind: "processGroup", messages: group });
        continue;
      }
      rows.push({ id: messageRowId(message), kind: "message", message });
    }
    return rows;
  }

  private renderVirtualRow(container: HTMLElement, row: MessageRenderRow): void {
    if (row.kind === "processGroup") {
      this.renderProcessGroup(container, row.messages);
      return;
    }
    this.renderMessage(container, row.message);
  }

  private renderMessage(container: HTMLElement, message: ChatMessage): void {
    const wrapper = container.createDiv({ cls: `codex-message codex-message-${message.role}` });
    wrapper.toggleClass("codex-message-streaming", message.status === "running");
    wrapper.toggleClass(`codex-message-type-${message.itemType ?? "text"}`, true);
    if (message.title) {
      const title = wrapper.createDiv({ cls: "codex-message-title" });
      title.createSpan({ cls: "codex-message-title-label", text: message.title });
      const time = formatMessageHeaderTime(message.createdAt);
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
        img.src = toImageSrc(this.app, image.path);
        img.onload = () => this.scheduleMeasureVirtualRows();
        img.onclick = () => openImageOverlay(img.src);
      }
    }
    const content = wrapper.createDiv({ cls: "codex-message-content" });
    if (message.itemType === "thinking") {
      this.renderThinkingMessage(content, message);
      return;
    }
    if (isProcessItemType(message.itemType)) {
      this.renderProcessMessage(content, message);
      return;
    }
    const displayText = displayTextForMessage(message);
    if (!this.renderKnowledgeBaseResultContent(content, message, displayText)) {
      renderRichText(this.app, this, content, displayText);
    }
    if (message.rawRef) this.renderRawMessageExpander(content, message);
    if (message.citations) this.renderKnowledgeBaseCitations(wrapper, message.id, message.citations);
  }

  private renderKnowledgeBaseResultContent(container: HTMLElement, message: ChatMessage, text: string): boolean {
    const result = extractKnowledgeBaseResultTitle(message.itemType, text);
    if (!result) return false;
    const title = container.createDiv({ cls: `codex-kb-result-title codex-kb-result-title-${result.status}` });
    const icon = title.createSpan({ cls: "codex-kb-result-title-icon" });
    setIcon(icon, result.status === "success" ? "badge-check" : "triangle-alert");
    title.createSpan({ cls: "codex-kb-result-title-text", text: result.title });
    if (result.body.trim()) renderRichText(this.app, this, container.createDiv({ cls: "codex-kb-result-body" }), result.body);
    return true;
  }

  private renderKnowledgeBaseCitations(container: HTMLElement, messageId: string, citations: KnowledgeBaseCitationSummary): void {
    const stateKey = `kb-citations:${messageId}`;
    const details = container.createEl("details", { cls: `codex-kb-citations codex-kb-citations-${citations.status}` });
    details.open = this.openKnowledgeBaseCitations.get(stateKey) ?? false;
    details.ontoggle = () => {
      this.openKnowledgeBaseCitations.set(stateKey, details.open);
      this.scheduleMeasureVirtualRows();
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
    const normalized = normalizePath(citation.path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    const absolute = path.join(this.plugin.getVaultPath(), normalized);
    if (showItemInFinder(absolute)) return;
    new Notice(`没有在当前 Obsidian 仓库找到：${citation.path}`);
  }

  private renderProcessGroup(container: HTMLElement, messages: ChatMessage[]): void {
    const groupId = processGroupId(messages);
    const wrapper = container.createDiv({ cls: "codex-message codex-message-tool codex-message-type-processGroup" });
    const details = wrapper.createEl("details", { cls: "codex-process-group" });
    details.open = this.openProcessGroups.get(groupId) ?? false;
    let body: HTMLElement | null = null;
    const renderBody = () => {
      if (body) return;
      body = details.createDiv({ cls: "codex-process-group-body" });
      for (const message of messages) this.renderProcessMessage(body, message, true);
    };
    details.ontoggle = () => {
      this.rememberOpenState(this.openProcessGroups, groupId, details.open);
      if (details.open) renderBody();
      this.scheduleMeasureVirtualRows();
    };
    const summary = details.createEl("summary", { cls: "codex-process-group-summary" });
    const icon = summary.createSpan({ cls: "codex-process-group-icon" });
    setIcon(icon, "list-tree");
    const main = summary.createDiv({ cls: "codex-process-group-main" });
    main.createSpan({ cls: "codex-process-group-title", text: processGroupTitle(messages) });
    main.createSpan({ cls: "codex-process-group-detail", text: processGroupDetail(messages) });
    const status = processGroupStatus(messages);
    summary.createSpan({ cls: "codex-structured-status", text: status });
    if (details.open) renderBody();
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
    if (attachment.type === "image") {
      openImageOverlay(toImageSrc(this.app, attachment.path));
      return;
    }
    const ref = summarizeAttachmentFile(attachment, this.plugin.getVaultPath());
    await this.openProcessFile(ref);
  }

  private renderThinkingMessage(container: HTMLElement, message: ChatMessage): void {
    const shell = container.createDiv({ cls: "codex-thinking-shell" });
    if (message.status === "running") {
      const row = shell.createDiv({ cls: "codex-thinking-live" });
      row.createSpan({ cls: "codex-thinking-dot" });
      row.createSpan({ text: message.text || "正在生成回复..." });
      return;
    }
    shell.createEl("em", { cls: "codex-response-footer", text: message.text || "思考完成" });
  }

  private renderProcessMessage(container: HTMLElement, message: ChatMessage, nested = false): void {
    const details = container.createEl("details", { cls: `codex-structured codex-process codex-process-${message.itemType ?? "item"}` });
    details.toggleClass("is-running", message.status === "running");
    details.toggleClass("is-completed", message.status === "completed");
    details.toggleClass("is-error", message.status === "error" || message.status === "failed");
    details.toggleClass("is-nested", nested);
    if (message.processKind) details.toggleClass(`codex-process-kind-${message.processKind}`, true);
    const defaultOpen = !nested && (message.itemType === "reasoning" || message.itemType === "plan" || message.status === "error" || message.status === "failed");
    details.open = this.openProcessItems.get(message.id) ?? defaultOpen;
    let body: HTMLElement | null = null;
    const renderBody = () => {
      if (body) return;
      body = details.createDiv({ cls: "codex-structured-body codex-process-body" });
      this.renderProcessBody(body, message);
    };
    details.ontoggle = () => {
      this.rememberOpenState(this.openProcessItems, message.id, details.open);
      if (details.open) renderBody();
      this.scheduleMeasureVirtualRows();
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
    const fallback = message.status === "running" ? "正在接收过程内容..." : "暂无内容";
    if (message.itemType === "commandExecution") {
      this.renderCommandExecutionBody(body, message, fallback);
      return;
    }
    if (message.itemType === "fileChange" && message.diffSummary) {
      this.renderFileChangeBody(body, message, fallback);
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
    renderRichText(this.app, this, body, text);
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
        .then((text) => renderDiff(text))
        .catch((error) => {
          body.empty();
          body.createDiv({ cls: "codex-process-raw-loading", text: `文件改动加载失败：${error instanceof Error ? error.message : String(error)}` });
          this.renderPlainTextBlock(body, displayTextForMessage(message) || fallback);
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
          this.scheduleMeasureVirtualRows();
        })
        .catch((error) => {
          body.empty();
          body.createDiv({ cls: "codex-process-raw-loading", text: `命令输出加载失败：${error instanceof Error ? error.message : String(error)}` });
          renderShell(displayTextForMessage(message) || fallback);
          this.scheduleMeasureVirtualRows();
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
      const ref = findProcessFileRef(message.files ?? [], file.path) ?? normalizeProcessFileRef(file.path, this.plugin.getVaultPath());
      this.renderProcessFileTextLink(row, ref, basename(file.path), "codex-process-edit-file");
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: ` +${file.added}` });
      row.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: ` -${file.removed}` });
    }
  }

  private renderProcessFileTextLink(container: HTMLElement, file: ProcessFileRef, label: string, extraClass = ""): HTMLElement {
    const link = container.createEl("span", {
      cls: `codex-process-file-link codex-process-file-link-${file.kind} ${extraClass}`.trim(),
      text: label,
      attr: {
        role: "button",
        tabindex: file.openable ? "0" : "-1",
        title: file.openable ? file.displayPath : `${file.displayPath}（无法打开）`,
        "aria-label": `打开 ${label}`
      }
    });
    link.toggleClass("is-disabled", !file.openable);
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
        this.scheduleMeasureVirtualRows();
      })
      .catch((error) => {
        status.setText(`全文加载失败：${error instanceof Error ? error.message : String(error)}`);
        this.scheduleMeasureVirtualRows();
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
      this.scheduleMeasureVirtualRows();
      void this.loadRawText(message)
        .then((text) => {
          body.empty();
          this.renderPlainTextBlock(body, text || "暂无内容");
          this.scheduleMeasureVirtualRows();
        })
        .catch((error) => {
          pre.setText(`全文加载失败：${error instanceof Error ? error.message : String(error)}`);
          this.scheduleMeasureVirtualRows();
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
    const text = await this.plugin.readRawMessageText(message.rawRef);
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
    if (!file.openable) {
      new Notice("这个文件路径无法打开");
      return;
    }
    if (file.kind === "vault") {
      const vaultFile = this.app.vault.getAbstractFileByPath(normalizePath(file.path));
      if (vaultFile instanceof TFile) {
        await this.app.workspace.getLeaf("tab").openFile(vaultFile, { active: true });
        return;
      }
      if (file.absolutePath && showItemInFinder(file.absolutePath)) return;
      new Notice(`没有在当前 Obsidian 仓库找到：${file.displayPath}`);
      return;
    }
    if (file.kind === "external" && showItemInFinder(file.absolutePath ?? file.path)) return;
    new Notice("无法打开这个文件位置");
  }

  private renderToolbar(): void {
    if (!this.toolbarEl) return;
    this.renderQueue();
    this.toolbarEl.empty();
    this.renderAttachments();

    const session = this.ensureSession();
    const knowledgeSession = this.isKnowledgeBaseSession(session);
    const knowledgeManager = this.plugin.getKnowledgeBaseManager();
    const knowledgeTaskRunning = knowledgeSession && Boolean(knowledgeManager?.isRunning);

    const row = this.toolbarEl.createDiv({ cls: "codex-composer-row" });
    const left = row.createDiv({ cls: "codex-composer-left" });
    const right = row.createDiv({ cls: "codex-composer-right" });

    const addButton = this.createComposerIconButton(left, "plus", "添加内容");
    addButton.onclick = (event) => this.openAddMenu(event);

    const skillButton = this.createComposerIconButton(left, "hammer", this.selectedSkill ? `Skill：${this.selectedSkill.name}` : "选择 Skill");
    skillButton.toggleClass("is-active", Boolean(this.selectedSkill));
    skillButton.onclick = (event) => this.openSkillMenu(event);

    if (knowledgeSession) {
      const wechatButton = this.createComposerIconButton(left, "newspaper", "公众号收集");
      wechatButton.onclick = () => this.runKnowledgeBaseShortcut("公众号收集", async () => {
        const paths = await this.plugin.getKnowledgeBaseManager()?.captureWeChatArticle();
        return paths?.length ? `已收集公众号：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未收集内容。";
      });
      const webButton = this.createComposerIconButton(left, "bookmark-plus", "网页收藏");
      webButton.onclick = () => this.runKnowledgeBaseShortcut("网页收藏", async () => {
        const paths = await this.plugin.getKnowledgeBaseManager()?.captureWebPage();
        return paths?.length ? `已收藏网页：\n${paths.map((item) => `- ${item}`).join("\n")}` : "未收藏内容。";
      });
      const fileButton = this.createComposerIconButton(left, "file-plus", "文件收藏");
      fileButton.onclick = () => this.pickKnowledgeBaseFiles();

      if (this.resolvedKnowledgeBackend() === "codex-cli") {
        const modelButton = right.createEl("button", {
          cls: "codex-composer-model-button",
          attr: { type: "button", "aria-label": "知识库模型和思考强度", title: this.currentKnowledgeComposerSummaryTitle() }
        });
        const modelIcon = modelButton.createSpan({ cls: "codex-composer-model-icon" });
        setIcon(modelIcon, "zap");
        modelButton.createSpan({ cls: "codex-composer-model-text", text: this.currentComposerSummary() });
        const modelChevron = modelButton.createSpan({ cls: "codex-composer-chevron" });
        setIcon(modelChevron, "chevron-down");
        modelButton.onclick = (event) => this.openKnowledgeModelMenu(event);
      }

      const kbChip = right.createEl("button", { cls: "codex-composer-model-button codex-kb-channel-chip", attr: { type: "button", title: "知识库常用命令" } });
      const kbIcon = kbChip.createSpan({ cls: "codex-composer-model-icon" });
      setIcon(kbIcon, "library");
      kbChip.createSpan({ cls: "codex-composer-model-text", text: knowledgeTaskRunning ? "知识库运行中" : "知识库命令" });
      const chevron = kbChip.createSpan({ cls: "codex-composer-chevron" });
      setIcon(chevron, "chevron-down");
      kbChip.onclick = (event) => this.openKnowledgeCommandMenu(event);
    } else {
      this.addComposerSelect<PermissionMode>(left, "shield-check", ["read-only", "workspace-write", "danger-full-access"], this.selectedPermission, (value) => {
        this.selectedPermission = value;
        this.persistComposerDefaults();
        this.renderToolbar();
      }, "权限", "codex-permission-control");
      this.addWorkspaceButton(left, session);

      this.contextEl = right.createDiv({ cls: "codex-context-meter", attr: { title: "上下文容量" } });
      this.contextRingEl = this.contextEl.createSpan({ cls: "codex-context-ring", attr: { "aria-hidden": "true" } });
      this.contextRingEl.createSpan({ cls: "codex-context-ring-hole" });
      this.contextValueEl = this.contextEl.createSpan({ cls: "codex-context-value", text: "--" });

      const modelButton = right.createEl("button", {
        cls: "codex-composer-model-button",
        attr: { type: "button", "aria-label": "模型和运行参数", title: this.currentComposerSummaryTitle() }
      });
      const modelIcon = modelButton.createSpan({ cls: "codex-composer-model-icon" });
      setIcon(modelIcon, "zap");
      modelButton.createSpan({ cls: "codex-composer-model-text", text: this.currentComposerSummary() });
      const chevron = modelButton.createSpan({ cls: "codex-composer-chevron" });
      setIcon(chevron, "chevron-down");
      modelButton.onclick = (event) => this.openModelMenu(event);

      const micButton = this.createComposerIconButton(right, "mic", "语音输入");
      micButton.onclick = () => new Notice("语音输入暂未接入");
    }

    const composerState = {
      viewRunning: this.running,
      knowledgeTaskRunning,
      hasDraft: this.hasComposerDraft(),
      hasQueuedItems: this.turnQueue.hasQueuedItems(session.id)
    };
    const busy = composerIsBusy(composerState);
    const action = composerPrimaryActionForState(composerState);
    const sendButtonView = composerActionButtonView(action);
    const sendButton = row.createEl("button", {
      cls: "codex-send-button codex-composer-send-button",
      attr: { type: "button", "aria-label": sendButtonView.label, title: sendButtonView.title }
    });
    sendButton.toggleClass("is-queue-action", action === "enqueue" || action === "resume-queue");
    setIcon(sendButton, sendButtonView.icon);
    sendButton.onclick = () => {
      if (action === "cancel-knowledge-task") {
        this.pauseQueueForSession(session.id);
        void knowledgeManager?.cancelMaintenance();
      }
      else if (action === "stop-turn") void this.stopTurn();
      else if (action === "enqueue") void this.enqueueComposerDraft();
      else if (action === "resume-queue") void this.resumeQueuedTurns(session.id);
      else void this.sendMessage();
    };
    if (!knowledgeSession) this.updateContext(session.tokenUsage, false);
  }

  private renderQueue(): void {
    if (!this.queueEl) return;
    const session = this.ensureSession();
    const items = this.turnQueue.itemsForSession(session.id);
    const paused = this.turnQueue.isSessionQueuePaused(session.id);
    this.queueEl.empty();
    this.queueEl.toggleClass("is-visible", Boolean(items.length));
    this.queueEl.toggleClass("is-paused", paused);
    if (!items.length) return;

    const header = this.queueEl.createDiv({ cls: "codex-turn-queue-header" });
    const title = header.createDiv({ cls: "codex-turn-queue-title" });
    const titleIcon = title.createSpan({ cls: "codex-turn-queue-title-icon" });
    setIcon(titleIcon, paused ? "pause-circle" : "list-ordered");
    title.createSpan({ text: paused ? `队列已暂停 · ${items.length}` : `队列 · ${items.length}` });

    const canResume = !this.running && !this.plugin.getKnowledgeBaseManager()?.isRunning;
    if (canResume) {
      const resume = header.createEl("button", {
        cls: "codex-turn-queue-resume",
        attr: { type: "button", title: "继续队列", "aria-label": "继续队列" }
      });
      setIcon(resume, "play");
      resume.onclick = () => void this.resumeQueuedTurns(session.id);
    }

    const list = this.queueEl.createDiv({ cls: "codex-turn-queue-list" });
    items.forEach((item, index) => this.renderQueuedTurnItem(list, item, index));
  }

  private renderQueuedTurnItem(container: HTMLElement, item: QueuedTurnItem, index: number): void {
    const row = container.createDiv({ cls: "codex-turn-queue-item", attr: { draggable: "true" } });
    row.dataset.queueItemId = item.id;
    const handle = row.createSpan({ cls: "codex-turn-queue-handle", attr: { "aria-hidden": "true" } });
    setIcon(handle, "grip-vertical");
    row.ondragstart = (event) => {
      this.draggedQueueItemId = item.id;
      event.dataTransfer?.setData("text/plain", item.id);
      event.dataTransfer?.setDragImage(row, 12, 12);
    };
    row.ondragend = () => {
      this.draggedQueueItemId = "";
    };
    row.ondragover = (event) => {
      event.preventDefault();
      row.addClass("is-drag-over");
    };
    row.ondragleave = () => row.removeClass("is-drag-over");
    row.ondrop = (event) => {
      event.preventDefault();
      row.removeClass("is-drag-over");
      const sourceId = event.dataTransfer?.getData("text/plain") || this.draggedQueueItemId;
      if (!sourceId || sourceId === item.id) return;
      this.turnQueue.reorderQueuedItem(item.sessionId, sourceId, index);
      this.renderQueue();
    };

    const body = row.createDiv({ cls: "codex-turn-queue-body" });
    body.createDiv({ cls: "codex-turn-queue-preview", text: queuedTurnPreview(item) });
    body.createDiv({ cls: "codex-turn-queue-meta", text: queuedTurnMeta(item) });

    const remove = row.createEl("button", {
      cls: "codex-turn-queue-remove",
      attr: { type: "button", title: "删除队列项", "aria-label": "删除队列项" }
    });
    setIcon(remove, "x");
    remove.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.turnQueue.removeQueuedItem(item.sessionId, item.id);
      this.renderQueue();
      this.renderToolbar();
    };
  }

  private createComposerIconButton(container: HTMLElement, iconName: string, title: string): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "codex-composer-icon-button",
      attr: { type: "button", "aria-label": title, title }
    });
    setIcon(button, iconName);
    return button;
  }

  private closeComposerMenus(): void {
    this.skillMenuEl?.removeClass("is-visible");
    this.knowledgeCommandMenuEl?.removeClass("is-visible");
  }

  private openSkillMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.knowledgeCommandMenuEl.removeClass("is-visible");
    if (this.skillMenuEl.hasClass("is-visible")) {
      this.skillMenuEl.removeClass("is-visible");
      return;
    }
    if (!this.skillsRequested) {
      this.skillsRequested = true;
      this.skillMenuEl.empty();
      this.skillMenuEl.createDiv({ cls: "codex-skill-empty", text: "正在加载 skills..." });
      this.skillMenuEl.addClass("is-visible");
      void this.plugin.ensureSkillsLoaded(true).then(() => this.renderSkillMatches());
      return;
    }
    this.renderSkillMatches();
  }

  private addComposerSelect<T extends string>(container: HTMLElement, iconName: string, values: T[], selected: T, onChange: (value: T) => void, label: string, extraClass = ""): void {
    const control = container.createDiv({ cls: `codex-composer-select ${extraClass}`.trim(), attr: { title: label } });
    control.toggleClass("is-danger", selected === "danger-full-access");
    const icon = control.createSpan({ cls: "codex-composer-select-icon" });
    setIcon(icon, iconName);
    const select = control.createEl("select", { cls: "codex-select codex-composer-native-select", attr: { "aria-label": label, title: label } });
    for (const value of values) select.createEl("option", { text: labelFor(value), value });
    select.value = selected;
    select.onchange = () => onChange(select.value as T);
  }

  private addWorkspaceButton(container: HTMLElement, session: StoredSession): void {
    const workspacePath = normalizeWorkspacePath(session.cwd);
    const valid = workspacePath ? workspaceDirectoryExists(workspacePath) : false;
    const title = workspacePath
      ? `工作区：${workspacePath}${valid ? "" : "\n文件夹不存在，请重新选择"}`
      : "选择文件夹作为本会话工作区";
    const button = container.createEl("button", {
      cls: "codex-composer-model-button codex-workspace-button",
      attr: { type: "button", title, "aria-label": "选择工作区" }
    });
    button.toggleClass("is-missing", !workspacePath);
    button.toggleClass("is-invalid", Boolean(workspacePath && !valid));
    const icon = button.createSpan({ cls: "codex-composer-model-icon" });
    setIcon(icon, workspacePath ? "folder-open" : "folder-plus");
    button.createSpan({ cls: "codex-composer-model-text", text: workspacePath ? workspaceDisplayName(workspacePath) : "选工作区" });
    const chevron = button.createSpan({ cls: "codex-composer-chevron" });
    setIcon(chevron, "chevron-down");
    button.onclick = (event) => this.openWorkspaceMenu(event, session);
  }

  private openAddMenu(event: MouseEvent): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("添加当前笔记（只作上下文）")
        .setIcon("file-text")
        .onClick(() => this.attachActiveFile())
    );
    menu.addItem((item) =>
      item
        .setTitle("添加文件（只作上下文）")
        .setIcon("folder")
        .onClick(() => this.pickFiles(false))
    );
    menu.addItem((item) =>
      item
        .setTitle("添加图片")
        .setIcon("image")
        .onClick(() => this.pickFiles(true))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("MCP 状态")
        .setIcon("blocks")
        .onClick(() => this.toggleMcpPanel())
    );
    menu.showAtMouseEvent(event);
  }

  private openWorkspaceMenu(event: MouseEvent, session: StoredSession): void {
    event.preventDefault();
    const workspacePath = normalizeWorkspacePath(session.cwd);
    const menu = new Menu();
    if (workspacePath) {
      menu.addItem((item) => item.setTitle(workspacePath).setIcon("folder-open").setIsLabel(true));
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle(workspacePath ? "更换工作区" : "选择工作区")
        .setIcon("folder-plus")
        .onClick(() => void this.chooseChatWorkspace(session))
    );
    if (workspacePath) {
      menu.addItem((item) =>
        item
          .setTitle("在 Finder 显示")
          .setIcon("external-link")
          .onClick(() => {
            if (!showItemInFinder(workspacePath)) new Notice("无法打开这个文件夹");
          })
      );
      menu.addItem((item) =>
        item
          .setTitle("清除工作区")
          .setIcon("x")
          .onClick(() => void this.clearChatWorkspace(session))
      );
    }
    menu.showAtMouseEvent(event);
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
    event.preventDefault();
    const menu = new Menu();
    for (const command of knowledgeCommandOptions()) {
      menu.addItem((item) =>
        item
          .setTitle(command.title)
          .setIcon(command.icon)
          .onClick(() => this.fillKnowledgeBaseCommand(command.text))
      );
    }
    menu.showAtMouseEvent(event);
  }

  private openKnowledgeModelMenu(event: MouseEvent): void {
    event.preventDefault();
    const menu = new Menu();
    const providerModels = this.activeProviderModels();
    const effectiveModel = this.effectiveModel();
    const models = providerModels.length
      ? ensureModelChoices([], ...providerModels)
      : ensureModelChoices(this.plugin.lastStatus?.models ?? [], this.selectedModel, this.plugin.settings.defaultModel, DEFAULT_SETTINGS.defaultModel);
    menu.addItem((item) => item.setTitle("知识库模型").setIsLabel(true));
    if (!providerModels.length) {
      menu.addItem((item) =>
        item
          .setTitle("自动")
          .setIcon("wand-sparkles")
          .setChecked(!this.selectedModel)
          .onClick(() => {
            this.selectedModel = "";
            this.persistComposerDefaults();
            this.renderToolbar();
          })
      );
    }
    for (const model of models) {
      menu.addItem((item) =>
        item
          .setTitle(model.displayName || model.model)
          .setIcon("box")
          .setChecked(effectiveModel === model.model)
          .onClick(() => {
            this.selectedModel = model.model;
            this.persistComposerDefaults();
            this.renderToolbar();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("思考强度").setIsLabel(true));
    for (const effort of ["low", "medium", "high", "xhigh"] as ReasoningEffort[]) {
      menu.addItem((item) =>
        item
          .setTitle(labelFor(effort))
          .setIcon("brain")
          .setChecked(this.selectedReasoning === effort)
          .onClick(() => {
            this.selectedReasoning = effort;
            this.persistComposerDefaults();
            this.renderToolbar();
          })
      );
    }
    menu.showAtMouseEvent(event);
  }

  fillKnowledgeBaseCommand(command: string): void {
    this.inputEl.value = command;
    this.inputEl.setSelectionRange(command.length, command.length);
    this.closeComposerMenus();
    this.focusInput();
  }

  private openModelMenu(event: MouseEvent): void {
    event.preventDefault();
    const menu = new Menu();
    const providerModels = this.activeProviderModels();
    const effectiveModel = this.effectiveModel();
    const models = providerModels.length
      ? ensureModelChoices([], ...providerModels)
      : ensureModelChoices(this.plugin.lastStatus?.models ?? [], this.selectedModel, this.plugin.settings.defaultModel, DEFAULT_SETTINGS.defaultModel);
    menu.addItem((item) => item.setTitle("模型").setIsLabel(true));
    if (!providerModels.length) {
      menu.addItem((item) =>
        item
          .setTitle("自动")
          .setIcon("wand-sparkles")
          .setChecked(!this.selectedModel)
          .onClick(() => {
            this.selectedModel = "";
            this.persistComposerDefaults();
            this.renderToolbar();
          })
      );
    }
    if (models.length) {
      for (const model of models) {
        menu.addItem((item) =>
          item
            .setTitle(model.displayName || model.model)
            .setIcon("box")
            .setChecked(effectiveModel === model.model)
            .onClick(() => {
              this.selectedModel = model.model;
              this.persistComposerDefaults();
              this.renderToolbar();
            })
        );
      }
    } else {
      menu.addItem((item) => item.setTitle(this.selectedModel || "自动").setIcon("box").setChecked(true));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("思考强度").setIsLabel(true));
    for (const effort of ["low", "medium", "high", "xhigh"] as ReasoningEffort[]) {
      menu.addItem((item) =>
        item
          .setTitle(labelFor(effort))
          .setIcon("brain")
          .setChecked(this.selectedReasoning === effort)
          .onClick(() => {
            this.selectedReasoning = effort;
            this.persistComposerDefaults();
            this.renderToolbar();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("速度").setIsLabel(true));
    for (const tier of ["standard", "fast", "flex"] as ServiceTierChoice[]) {
      menu.addItem((item) =>
        item
          .setTitle(labelFor(tier))
          .setIcon("gauge")
          .setChecked(this.selectedServiceTier === tier)
          .onClick(() => {
            this.selectedServiceTier = tier;
            this.persistComposerDefaults();
            this.renderToolbar();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("模式").setIsLabel(true));
    for (const mode of ["agent", "plan"] as UiMode[]) {
      menu.addItem((item) =>
        item
          .setTitle(labelFor(mode))
          .setIcon("route")
          .setChecked(this.selectedMode === mode)
          .onClick(() => {
            this.selectedMode = mode;
            this.persistComposerDefaults();
            this.renderToolbar();
          })
      );
    }
    menu.showAtMouseEvent(event);
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
    event.preventDefault();
    if (this.isKnowledgeBaseSession(session)) {
      new Notice("知识库管理频道是常驻频道，不能删除");
      return;
    }
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("重命名会话")
        .setIcon("pencil")
        .onClick(() => void this.renameSession(session))
    );
    menu.addItem((item) =>
      item
        .setTitle("删除会话")
        .setIcon("trash")
        .setWarning(true)
        .onClick(() => void this.deleteSession(session.id))
    );
    menu.showAtMouseEvent(event);
  }

  private async renameSession(session: StoredSession): Promise<void> {
    const name = await textInputModal(this.app, "重命名会话", "名称", session.title);
    if (!name) return;
    session.title = name;
    if (session.threadId) await this.plugin.codex?.setThreadName(session.threadId, name).catch(() => undefined);
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

  private createToolbarControl(container: HTMLElement, iconName: string, label: string): HTMLElement {
    const control = container.createDiv({ cls: "codex-control", attr: { title: label } });
    const icon = control.createSpan({ cls: "codex-control-icon" });
    setIcon(icon, iconName);
    return control;
  }

  private createActionButton(container: HTMLElement, iconName: string, label: string, title: string): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "codex-toolbar-button codex-action-button",
      attr: { type: "button", "aria-label": title, title }
    });
    const icon = button.createSpan({ cls: "codex-action-icon" });
    setIcon(icon, iconName);
    button.createSpan({ cls: "codex-action-label", text: label });
    return button;
  }

  private addSelect<T extends string>(container: HTMLElement, iconName: string, values: T[], selected: T, onChange: (value: T) => void, label: string): void {
    const control = this.createToolbarControl(container, iconName, label);
    const select = control.createEl("select", { cls: "codex-select", attr: { "aria-label": label, title: label } });
    for (const value of values) select.createEl("option", { text: labelFor(value), value });
    select.value = selected;
    select.onchange = () => onChange(select.value as T);
  }

  private renderAttachments(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.empty();
    this.attachmentsEl.toggleClass("is-empty", !this.selectedSkill && this.attachments.length === 0);
    if (this.selectedSkill) {
      const chip = this.attachmentsEl.createDiv({ cls: "codex-skill-token" });
      const icon = chip.createSpan({ cls: "codex-skill-token-icon" });
      setIcon(icon, "box");
      chip.createSpan({ cls: "codex-skill-token-name", text: this.selectedSkill.name });
      const remove = chip.createEl("button", { attr: { type: "button", "aria-label": `移除 Skill：${this.selectedSkill.name}`, title: "移除 Skill" } });
      setIcon(remove, "x");
      remove.onclick = () => {
        this.selectedSkill = null;
        this.renderAttachments();
        this.renderToolbar();
      };
    }
    for (const item of this.attachments) {
      const chip = this.attachmentsEl.createDiv({ cls: "codex-attachment-chip" });
      chip.createSpan({ text: item.name });
      const remove = chip.createEl("button", { text: "×", attr: { type: "button" } });
      remove.onclick = () => {
        this.attachments = this.attachments.filter((attachment) => attachment.path !== item.path);
        this.renderAttachments();
      };
    }
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
    this.skillMenuEl.empty();
    const enabledSkills = filterEnabledSkills(this.plugin.lastStatus?.skills ?? [], this.plugin.settings.workspaceResources.skills);
    const matches = filterSkills(enabledSkills, query);
    for (const skill of matches) {
      const item = this.skillMenuEl.createDiv({ cls: "codex-skill-item" });
      item.toggleClass("is-selected", this.selectedSkill?.path === skill.path);
      const heading = item.createDiv({ cls: "codex-skill-heading" });
      const icon = heading.createSpan({ cls: "codex-skill-icon" });
      setIcon(icon, "box");
      heading.createDiv({ cls: "codex-skill-name", text: skill.name });
      item.createDiv({ cls: "codex-skill-desc", text: skill.description || skill.path });
      item.onclick = () => {
        this.selectedSkill = skill;
        this.skillMenuEl.removeClass("is-visible");
        this.renderAttachments();
        this.renderToolbar();
        this.inputEl.focus();
      };
    }
    if (matches.length === 0) this.skillMenuEl.createDiv({ cls: "codex-skill-empty", text: "没有匹配的 skill" });
    this.skillMenuEl.addClass("is-visible");
  }

  private renderKnowledgeCommandMatches(query: string): void {
    this.knowledgeCommandMenuEl.empty();
    const matches = knowledgeCommandOptions(query);
    for (const command of matches) {
      this.knowledgeCommandMenuEl.appendChild(this.createKnowledgeCommandItem(command));
    }
    if (matches.length === 0) this.knowledgeCommandMenuEl.createDiv({ cls: "codex-skill-empty", text: "没有匹配的知识库命令" });
    this.knowledgeCommandMenuEl.addClass("is-visible");
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
    return {
      viewRunning: this.running,
      knowledgeTaskRunning: this.isKnowledgeBaseSession(session) && Boolean(knowledgeManager?.isRunning),
      hasDraft: this.hasComposerDraft(),
      hasQueuedItems: this.turnQueue.hasQueuedItems(session.id)
    };
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

  private createKnowledgeCommandItem(command: KnowledgeBaseCommandOption): HTMLElement {
    const item = document.createElement("div");
    item.addClass("codex-command-item");
    const icon = item.createSpan({ cls: "codex-command-icon" });
    setIcon(icon, command.icon);
    const body = item.createDiv({ cls: "codex-command-body" });
    const heading = body.createDiv({ cls: "codex-command-heading" });
    heading.createSpan({ cls: "codex-command-text", text: command.text.trim() });
    heading.createSpan({ cls: "codex-command-title", text: command.title });
    body.createDiv({ cls: "codex-command-desc", text: command.description });
    item.onclick = () => this.fillKnowledgeBaseCommand(command.text);
    return item;
  }

  private async sendMessage(): Promise<void> {
    if (this.editorSummaryRun) this.cancelEditorSummaryRun("用户输入抢占摘要");
    const session = this.ensureSession();
    const action = composerPrimaryActionForState(this.composerStateForSession(session));
    if (action === "enqueue") {
      await this.enqueueComposerDraft();
      return;
    }
    if (action === "resume-queue") {
      await this.resumeQueuedTurns(session.id);
      return;
    }
    if (action === "stop-turn") {
      await this.stopTurn();
      return;
    }
    if (action === "cancel-knowledge-task") {
      this.pauseQueueForSession(session.id);
      await this.plugin.getKnowledgeBaseManager()?.cancelMaintenance();
      return;
    }
    const item = await this.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: true });
    if (!item) return;
    const outcome = await this.startQueuedTurnItem(item, "composer");
    if (outcome !== "running") await this.afterTurnSettled(item.sessionId, outcome === "completed");
  }

  private async enqueueComposerDraft(): Promise<void> {
    const item = await this.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: false });
    if (!item) return;
    this.turnQueue.enqueue(item);
    this.clearComposerDraft();
    this.renderQueue();
    this.renderToolbar();
    new Notice("已加入队列");
    if (!this.running && !this.plugin.getKnowledgeBaseManager()?.isRunning && !this.turnQueue.isSessionQueuePaused(item.sessionId)) {
      void this.startNextQueuedTurn(item.sessionId);
    }
  }

  private async resumeQueuedTurns(sessionId: string): Promise<void> {
    this.turnQueue.resumeSessionQueue(sessionId);
    this.renderQueue();
    this.renderToolbar();
    await this.startNextQueuedTurn(sessionId);
  }

  private async afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void> {
    if (succeeded) {
      await this.startNextQueuedTurn(sessionId);
    } else {
      this.pauseQueueForSession(sessionId);
    }
    this.renderQueue();
    this.renderToolbar();
  }

  private async startNextQueuedTurn(sessionId: string): Promise<void> {
    if (this.queueStartInProgress || this.running || this.plugin.getKnowledgeBaseManager()?.isRunning) return;
    const item = this.turnQueue.dequeueNext(sessionId);
    if (!item) {
      this.renderQueue();
      this.renderToolbar();
      return;
    }
    this.queueStartInProgress = true;
    this.renderQueue();
    this.renderToolbar();
    let outcome: "running" | "completed" | "failed" = "failed";
    try {
      outcome = await this.startQueuedTurnItem(item, "queue");
    } finally {
      this.queueStartInProgress = false;
    }
    if (outcome !== "running") await this.afterTurnSettled(item.sessionId, outcome === "completed");
  }

  private async createQueuedTurnFromComposer(options: { allowLocalKnowledgeCommands: boolean }): Promise<QueuedTurnItem | null> {
    let session = this.ensureSession();
    const text = this.inputEl.value.trim();
    const attachments = this.attachments.map((attachment) => ({ ...attachment }));
    const skill = this.selectedSkill ? { ...this.selectedSkill } : null;
    if (!text && !attachments.length && !skill) return null;
    const knowledgeSession = this.isKnowledgeBaseSession(session);
    const knowledgeCommand = knowledgeSession ? parseKnowledgeBaseCommand(text, attachments.length) : null;
    if (knowledgeSession && knowledgeCommand && isLocalKnowledgeBaseCommand(knowledgeCommand.intent)) {
      if (!options.allowLocalKnowledgeCommands) {
        new Notice("本地命令不能排队；当前任务结束后再操作");
        return null;
      }
      if (knowledgeCommand.intent === "clear") {
        await this.clearKnowledgeBasePage(session);
        return null;
      }
      if (knowledgeCommand.intent === "history") {
        this.clearComposerDraft();
        await this.openKnowledgeBaseHistory(session);
        return null;
      }
    }
    const kind = knowledgeSession && knowledgeCommand && knowledgeCommand.intent !== "chat" ? "knowledge-base" : "chat";
    if (kind === "chat" && !knowledgeSession) {
      const workspaceReady = await this.ensureChatWorkspaceSelected(session);
      if (!workspaceReady) return null;
      session = this.ensureSession();
    }
    return {
      id: newId("queued-turn"),
      sessionId: session.id,
      text,
      attachments,
      skill,
      turnOptions: this.currentTurnOptions(session),
      kind,
      createdAt: Date.now()
    };
  }

  private async startQueuedTurnItem(item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "completed" | "failed"> {
    const session = this.sessionById(item.sessionId);
    if (!session) {
      new Notice("队列所属会话已不存在");
      return "failed";
    }
    if (item.kind === "knowledge-base") return await this.startKnowledgeBaseTurn(session, item, source);
    return await this.startChatTurn(session, item, source);
  }

  private async startChatTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"running" | "failed"> {
    try {
      const status = await this.plugin.ensureCodexConnected();
      this.applyStatus();
      if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");
      const runId = newId("run");
      this.activeRunId = runId;
      this.activeRunKind = "chat";
      this.activeRunSessionId = session.id;
      const turnAttachments = item.attachments.map((attachment) => ({ ...attachment }));
      const userMessage: ChatMessage = {
        id: newId("msg"),
        role: "user",
        text: item.text || "(附件)",
        runId,
        attachments: turnAttachments,
        images: turnAttachments.filter((attachment) => attachment.type === "image"),
        createdAt: Date.now()
      };
      await this.plugin.externalizeMessageText(userMessage, userMessage.text);
      session.messages.push(userMessage);
      session.updatedAt = Date.now();
      if (session.title === "新会话" && item.text) session.title = item.text.slice(0, 20);
      if (source === "composer") this.clearComposerDraft();
      this.renderTabs();
      this.renderMessagesIfActive(session);
      this.renderToolbar();

      const turnOptions = item.turnOptions;
      this.running = true;
      this.turnStartedAt = Date.now();
      this.ensureThinkingMessage(session, "连接中", "正在连接 Codex...");
      this.armTurnWatchdog();
      this.applyStatus();
      if (!session.threadId && this.threadPrewarmPromise && this.threadPrewarmSessionId === session.id) {
        const warmed = await this.threadPrewarmPromise.catch(() => false);
        if (!warmed && !session.threadId) throw new Error("新会话连接超时，请重试");
      }
      if (!session.threadId) {
        const started = await this.plugin.codex!.startThread(turnOptions);
        session.threadId = started.threadId;
      } else {
        await this.plugin.codex!.resumeThread(session.threadId, turnOptions).catch(async () => {
          const started = await this.plugin.codex!.startThread(turnOptions);
          session.threadId = started.threadId;
        });
      }
      const input = buildUserInput(item.text, turnAttachments, item.skill);
      this.activeTurnId = await this.plugin.codex!.startTurn(session.threadId, input, turnOptions);
      this.attachTurnIdToRun(session, this.activeTurnId);
      await this.plugin.saveSettings();
      return "running";
    } catch (error) {
      const diagnostic = this.diagnoseCodexFailure(error);
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.finishThinkingMessage(session, "失败");
      this.addMessageToSession(session, {
        role: "system",
        title: diagnostic.title,
        itemType: "error",
        text: diagnostic.text
      });
      this.clearActiveRun();
      new Notice(`Codex 发送失败：${diagnostic.title}`);
      return "failed";
    } finally {
      this.applyStatus();
    }
  }

  private async startKnowledgeBaseTurn(session: StoredSession, item: QueuedTurnItem, source: "composer" | "queue"): Promise<"completed" | "failed"> {
    const manager = this.plugin.getKnowledgeBaseManager();
    if (!manager) {
      new Notice("知识库管理未初始化");
      return "failed";
    }
    if (!item.text && !item.attachments.length) return "failed";
    const runId = newId("kb-run");
    this.activeRunId = runId;
    this.activeRunKind = "knowledge-base";
    this.activeRunSessionId = session.id;
    const turnAttachments = item.attachments.map((attachment) => ({ ...attachment }));
    const userMessage: ChatMessage = {
      id: newId("msg"),
      role: "user",
      text: item.text || "(附件)",
      runId,
      attachments: turnAttachments,
      images: turnAttachments.filter((attachment) => attachment.type === "image"),
      createdAt: Date.now()
    };
    await this.plugin.externalizeMessageText(userMessage, userMessage.text);
    const assistantMessage: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      title: "知识库管理",
      itemType: "knowledgeBase",
      status: "running",
      text: "正在识别命令并执行...",
      runId,
      createdAt: Date.now()
    };
    session.messages.push(userMessage, assistantMessage);
    session.title = "知识库管理";
    session.updatedAt = Date.now();
    if (source === "composer") this.clearComposerDraft();
    this.running = true;
    this.renderTabs();
    this.renderMessagesIfActive(session);
    this.renderToolbar();
    await this.plugin.saveSettings(true);

    let succeeded = false;
    try {
      const result = await manager.handleUserMessage(item.text, turnAttachments, knowledgeBaseTurnOverrides(item.turnOptions));
      succeeded = result.status === "success";
      assistantMessage.status = result.status === "success" ? "completed" : "failed";
      assistantMessage.text = result.message;
      assistantMessage.citations = result.citations;
      if (result.status === "failed") {
        this.finishThinkingMessage(session, "失败");
        this.finishRunningProcessMessages(session, "error");
        this.finishPlanMessage(session);
      }
      this.moveMessageToEnd(session, assistantMessage.id);
      if (result.followUpCommand) {
        if (session.id === this.plugin.settings.activeSessionId) this.fillKnowledgeBaseCommand(result.followUpCommand);
      }
      if (result.status === "failed") new Notice(`知识库管理失败：${result.message}`);
    } finally {
      this.running = false;
      session.updatedAt = Date.now();
      this.clearTurnWatchdog();
      await this.plugin.externalizeMessageText(assistantMessage, assistantMessage.text);
      this.clearActiveRun();
      await this.plugin.saveSettings(true);
      this.renderMessages({ forceBottom: true });
      this.renderToolbar();
      this.applyStatus();
      void this.refreshKnowledgeDashboard(true);
    }
    return succeeded ? "completed" : "failed";
  }

  private async runKnowledgeBaseShortcut(label: string, runner: () => Promise<string>): Promise<void> {
    const session = this.ensureSession();
    if (!this.isKnowledgeBaseSession(session)) {
      await this.plugin.activateKnowledgeBaseChannel();
    }
    const active = this.ensureSession();
    const userMessage: ChatMessage = {
      id: newId("msg"),
      role: "user",
      text: label,
      createdAt: Date.now()
    };
    const assistantMessage: ChatMessage = {
      id: newId("msg"),
      role: "assistant",
      title: "知识库管理",
      itemType: "knowledgeBase",
      status: "running",
      text: "正在执行...",
      createdAt: Date.now()
    };
    active.messages.push(userMessage, assistantMessage);
    active.updatedAt = Date.now();
    this.running = true;
    this.renderTabs();
    this.renderMessages({ forceBottom: true });
    this.renderToolbar();
    await this.plugin.saveSettings(true);
    try {
      const message = await runner();
      assistantMessage.status = "completed";
      assistantMessage.text = message;
      new Notice(label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assistantMessage.status = "failed";
      assistantMessage.text = message;
      new Notice(`知识库管理失败：${message}`);
    } finally {
      this.running = false;
      active.updatedAt = Date.now();
      await this.plugin.externalizeMessageText(assistantMessage, assistantMessage.text);
      await this.plugin.saveSettings(true);
      this.renderMessages({ forceBottom: true });
      this.renderToolbar();
      this.applyStatus();
      void this.refreshKnowledgeDashboard(true);
    }
  }

  async sendEditorActionRequest(request: EditorActionRequest): Promise<string> {
    if (this.editorSummaryRun) this.cancelEditorSummaryRun("写作操作抢占文章理解");
    const blockReason = this.editorActionStartBlockReason();
    if (blockReason) throw new Error(blockReason);
    const harnessRunId = newId("editor-action-harness");
    this.editorActionHarnessRunId = harnessRunId;
    const timeoutMs = editorActionTimeoutForMode(this.plugin.settings.editorActions.timeoutMs, request.qualityMode);
    const requestStartedAt = Date.now();
    try {
      this.setArticleUnderstandingPanelState({
        status: request.qualityMode === "fast" ? "idle" : "missing",
        source: request.source,
        mode: request.qualityMode,
        modeLabel: request.modeConfig.label,
        model: request.modeConfig.model,
        usedInLastRun: false
      });
      this.setEditorActionStatus({ status: "connecting", actionLabel: request.action.label, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label, filePath: request.source.filePath, model: request.modeConfig.model, startedAt: requestStartedAt });
      const status = await this.withEditorActionTimeout(this.plugin.ensureCodexConnected(false, { silent: true }), timeoutMs, "写作操作连接超时");
      this.applyStatus();
      if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");

      const availableModels = status.models.map((model) => model.model);
      const model = this.effectiveEditorActionModel(availableModels, request.modeConfig.model);
      const understanding = await this.ensureArticleUnderstanding(request, availableModels, model, timeoutMs);
      const snapshot = understanding
        ? {
          ...request.snapshot,
          articleUnderstanding: understanding.understanding,
          articleUnderstandingState: this.articleUnderstandingPanelState.status === "reused" ? "reusable" as const : "fresh" as const
        }
        : request.snapshot;
      const contextChars = request.snapshot.beforeContext.length + request.snapshot.afterContext.length;
      const debugMessage = `${request.modeConfig.label} · 模型 ${model} · 上下文 ${contextChars} 字 · 超时 ${Math.round(timeoutMs / 1000)}s`;
      let result = await this.runEditorActionPromptTurn({
        prompt: buildEditorActionPrompt({ action: request.action, style: request.style, snapshot, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label }),
        actionLabel: request.action.label,
        qualityMode: request.qualityMode,
        modeLabel: request.modeConfig.label,
        model,
        phase: "generating",
        statusMessage: debugMessage,
        timeoutMs,
        startedAt: requestStartedAt
      });
      if (request.qualityMode === "strict") {
        const candidateText = cleanEditorActionOutput(result);
        const candidateValidation = validateEditorActionCandidateText(candidateText);
        if (!candidateValidation.ok) throw new Error(candidateValidation.reason);
        result = await this.runEditorActionPromptTurn({
          prompt: buildEditorActionReviewPrompt({ action: request.action, style: request.style, snapshot, qualityMode: request.qualityMode, modeLabel: request.modeConfig.label, candidateText }),
          actionLabel: request.action.label,
          qualityMode: request.qualityMode,
          modeLabel: request.modeConfig.label,
          model,
          phase: "reviewing",
          statusMessage: `${request.modeConfig.label}审校中`,
          timeoutMs: Math.max(45000, Math.min(timeoutMs, 90000)),
          startedAt: requestStartedAt
        });
      }
      this.prewarmEditorActionThread();
      return result;
    } catch (error) {
      const diagnostic = this.diagnoseCodexFailure(error);
      this.rejectEditorActionRun(new Error(diagnostic.text));
      this.running = false;
      this.activeTurnId = "";
      this.editorActionActiveTimeoutMs = 0;
      this.clearTurnWatchdog();
      this.clearActiveRun();
      this.editorActionCurrentItemIds.clear();
      this.applyStatus();
      this.setArticleUnderstandingPanelState({ ...this.articleUnderstandingPanelState, status: "failed", error: diagnostic.text });
      this.prewarmEditorActionThread();
      throw error;
    } finally {
      if (this.editorActionHarnessRunId === harnessRunId) this.editorActionHarnessRunId = "";
    }
  }

  private async ensureArticleUnderstanding(request: EditorActionRequest, availableModels: string[], model: string, timeoutMs: number, forceRefresh = false): Promise<ArticleUnderstandingEntry | null> {
    if (request.qualityMode === "fast") {
      this.setArticleUnderstandingPanelState({
        status: "idle",
        source: request.source,
        mode: request.qualityMode,
        modeLabel: request.modeConfig.label,
        model,
        entry: null,
        usedInLastRun: false
      });
      return null;
    }
    const settings = this.plugin.settings.editorActions;
    const cached = forceRefresh ? { state: "stale" as const, entry: null } : resolveArticleUnderstandingCache(settings.articleUnderstandingCache, request.source, request.qualityMode, model);
    if (!forceRefresh && cached.entry && (cached.state === "fresh" || cached.state === "reusable")) {
      this.setArticleUnderstandingPanelState({
        status: cached.state === "fresh" ? "fresh" : "reused",
        source: request.source,
        mode: request.qualityMode,
        modeLabel: request.modeConfig.label,
        model,
        entry: cached.entry,
        usedInLastRun: true
      });
      return cached.entry;
    }

    this.setArticleUnderstandingPanelState({
      status: "running",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      entry: null,
      usedInLastRun: false
    });
    const understandingRaw = await this.runEditorActionPromptTurn({
      prompt: buildArticleUnderstandingPrompt(request.source),
      actionLabel: "理解文章",
      qualityMode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model: this.effectiveEditorActionModel(availableModels, model),
      phase: "understanding",
      statusMessage: `${request.modeConfig.label} · 正在理解文章`,
      timeoutMs: Math.max(45000, Math.min(timeoutMs, 90000)),
      startedAt: Date.now()
    });
    const understanding = cleanEditorActionOutput(understandingRaw);
    if (!understanding.trim()) throw new Error("文章理解为空");
    const entry = makeArticleUnderstandingCacheEntry(request.source, understanding, request.qualityMode, model);
    settings.articleUnderstandingCache = upsertArticleUnderstandingCache(settings.articleUnderstandingCache, entry);
    await this.plugin.saveSettings();
    this.setArticleUnderstandingPanelState({
      status: "fresh",
      source: request.source,
      mode: request.qualityMode,
      modeLabel: request.modeConfig.label,
      model,
      entry,
      usedInLastRun: true
    });
    return entry;
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
    const runId = newId(`editor-${input.phase}-run`);
    this.editorActionCurrentItemIds.clear();
    const waitForResult = new Promise<string>((resolve, reject) => {
      this.editorActionRun = { runId, text: "", resolve, reject };
    });
    const turnOptions = buildEditorActionTurnOptions({
      model: input.model,
      serviceTier: this.selectedServiceTier,
      timeoutMs: input.timeoutMs,
      workspaceResources: { plugins: {}, mcpServers: {}, skills: {} }
    });
    try {
      this.activeRunId = runId;
      this.activeRunSessionId = "";
      this.running = true;
      this.editorActionActiveTimeoutMs = input.timeoutMs;
      this.turnStartedAt = Date.now();
      this.armTurnWatchdog(input.timeoutMs);
      this.setEditorActionStatus({
        status: "generating",
        actionLabel: input.actionLabel,
        phase: input.phase,
        qualityMode: input.qualityMode,
        modeLabel: input.modeLabel,
        model: input.model,
        startedAt: input.startedAt,
        message: input.statusMessage,
        understandingStatus: this.articleUnderstandingPanelState.status
      });
      this.editorActionThreadId = await this.withEditorActionTimeout(this.takeEditorActionThread(turnOptions), input.timeoutMs, "写作操作启动超时");
      this.editorActionThreadIds.add(this.editorActionThreadId);
      this.activeTurnId = await this.withEditorActionTimeout(this.plugin.codex!.startTurn(this.editorActionThreadId, buildEditorActionUserInput(input.prompt), turnOptions), input.timeoutMs, "写作操作启动超时");
      if (this.activeTurnId) this.editorActionTurnIds.add(this.activeTurnId);
      const result = await waitForResult;
      this.releaseEditorActionRunLock(runId);
      return result;
    } catch (error) {
      void waitForResult.catch(() => undefined);
      if (this.editorActionThreadId && this.activeTurnId) {
        void this.plugin.codex?.interruptTurn(this.editorActionThreadId, this.activeTurnId).catch(() => undefined);
      }
      this.rejectEditorActionRun(new Error(this.diagnoseCodexFailure(error, input.model).text));
      this.releaseEditorActionRunLock(runId);
      throw error;
    }
  }

  private setArticleUnderstandingPanelState(state: ArticleUnderstandingPanelState): void {
    this.articleUnderstandingPanelState = state;
    this.renderEditorActionStatus();
  }

  private async refreshArticleUnderstandingPanelSourceState(): Promise<void> {
    if (this.articleUnderstandingPanelState.status === "running") return;
    const source = await this.currentArticleUnderstandingSource();
    if (!source) {
      this.setArticleUnderstandingPanelState({ status: "idle", usedInLastRun: false });
      return;
    }
    const settings = this.plugin.settings.editorActions;
    const mode = settings.qualityMode;
    const modeConfig = resolveEditorActionModeConfig(settings, mode);
    const availableModels = this.plugin.lastStatus?.models.map((item) => item.model) ?? [];
    const model = this.effectiveEditorActionModel(availableModels, modeConfig.model);
    const cachedEntry = settings.articleUnderstandingCache[source.filePath] ?? null;
    const cacheResolution = mode === "fast"
      ? { state: "missing" as const, entry: null }
      : resolveArticleUnderstandingCache(settings.articleUnderstandingCache, source, mode, model);
    const status: ArticleUnderstandingStatus = mode === "fast"
      ? "idle"
      : cacheResolution.state === "fresh"
        ? "fresh"
        : cacheResolution.state === "reusable"
          ? "reused"
          : cacheResolution.state === "stale"
            ? "stale"
            : "missing";
    this.setArticleUnderstandingPanelState({
      status,
      source,
      mode,
      modeLabel: modeConfig.label,
      model,
      entry: cacheResolution.entry ?? cachedEntry,
      usedInLastRun: false
    });
  }

  private async refreshArticleUnderstandingFromPanel(): Promise<void> {
    const source = await this.currentArticleUnderstandingSource();
    if (!source) {
      new Notice("请先打开一篇 Markdown 笔记");
      return;
    }
    const settings = this.plugin.settings.editorActions;
    const mode = settings.qualityMode === "fast" ? "quality" : settings.qualityMode;
    const modeConfig = resolveEditorActionModeConfig(settings, mode);
    if (this.editorSummaryRun) this.cancelEditorSummaryRun("刷新文章理解");
    const blockReason = this.editorActionStartBlockReason();
    if (blockReason) {
      new Notice(blockReason);
      return;
    }
    const harnessRunId = newId("article-understanding-refresh");
    this.editorActionHarnessRunId = harnessRunId;
    try {
      const status = await this.plugin.ensureCodexConnected(false, { silent: true });
      if (!status.connected) throw new Error("Codex 未连接");
      const model = this.effectiveEditorActionModel(status.models.map((item) => item.model), modeConfig.model);
      const request: EditorActionRequest = {
        id: newId("editor-action-refresh"),
        action: { id: "rewrite", label: "理解文章", enabled: true, promptTemplate: "" },
        style: { id: "clear", label: "清楚", instruction: "表达清楚、准确、自然。" },
        snapshot: {
          filePath: source.filePath,
          fileName: source.fileName,
          fromOffset: 0,
          toOffset: 0,
          from: { line: 0, ch: 0 },
          to: { line: 0, ch: 0 },
          selectedText: "",
          beforeContext: "",
          afterContext: ""
        },
        source,
        qualityMode: mode,
        modeConfig,
        prompt: "",
        createdAt: Date.now()
      };
      await this.ensureArticleUnderstanding(request, status.models.map((item) => item.model), model, editorActionTimeoutForMode(settings.timeoutMs, mode), true);
      this.setEditorActionStatus({
        status: "idle",
        qualityMode: mode,
        modeLabel: modeConfig.label,
        filePath: source.filePath,
        model,
        understandingStatus: "fresh",
        usedArticleUnderstanding: true
      });
      new Notice("文章理解已刷新");
    } catch (error) {
      this.setEditorActionStatus({
        status: "failed",
        actionLabel: "理解文章",
        phase: "understanding",
        qualityMode: mode,
        modeLabel: modeConfig.label,
        filePath: source.filePath,
        model: modeConfig.model,
        understandingStatus: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      this.setArticleUnderstandingPanelState({
        status: "failed",
        source,
        mode,
        modeLabel: modeConfig.label,
        model: modeConfig.model,
        error: error instanceof Error ? error.message : String(error),
        usedInLastRun: false
      });
      new Notice(`文章理解失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.editorActionHarnessRunId === harnessRunId) this.editorActionHarnessRunId = "";
    }
  }

  private async currentArticleUnderstandingSource(): Promise<EditorActionSummarySource | null> {
    const markdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (markdownView?.file) {
      const text = markdownView.editor.getValue();
      return {
        filePath: markdownView.file.path,
        fileName: markdownView.file.name,
        text,
        mtime: markdownView.file.stat.mtime,
        size: markdownView.file.stat.size ?? text.length
      };
    }
    const existing = this.articleUnderstandingPanelState.source;
    if (existing) return existing;
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return null;
    const text = await this.plugin.app.vault.cachedRead(file);
    return {
      filePath: file.path,
      fileName: file.name,
      text,
      mtime: file.stat.mtime,
      size: file.stat.size ?? text.length
    };
  }

  private async stopTurn(): Promise<void> {
    if (this.isEditorActionRunActive()) {
      if (this.editorActionThreadId && this.activeTurnId) {
        await this.plugin.codex?.interruptTurn(this.editorActionThreadId, this.activeTurnId).catch(() => undefined);
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
    await this.plugin.codex?.interruptTurn(session.threadId, this.activeTurnId).catch(() => undefined);
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
          void this.plugin.codex?.interruptTurn(timedOutThreadId, timedOutTurnId).catch(() => undefined);
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
        void this.plugin.codex?.interruptTurn(session.threadId, timedOutTurnId).catch(() => undefined);
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
    if (this.editorActionHarnessRunId) return "Codex 正在处理上一轮，请稍后再试";
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
      void this.plugin.codex?.interruptTurn(run.threadId, this.activeTurnId).catch(() => undefined);
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
        void this.plugin.codex?.interruptTurn(run.threadId, this.activeTurnId).catch(() => undefined);
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

  private routeEditorActionNotification(method: string, params: any, active: boolean, currentThreadId: string, allowUnscoped = false): ReturnType<typeof routeEditorActionNotificationState> {
    return routeEditorActionNotificationState({
      method,
      params,
      active,
      currentThreadId,
      currentTurnId: this.activeTurnId,
      threadIds: this.editorActionThreadIds,
      turnIds: this.editorActionTurnIds,
      itemIds: this.editorActionItemIds,
      currentItemIds: this.editorActionCurrentItemIds,
      allowUnscoped
    });
  }

  private rememberEditorActionNotificationIds(params: any, currentRun = false): void {
    const ids = extractEditorActionNotificationIds(params);
    if (ids.threadId) this.editorActionThreadIds.add(ids.threadId);
    if (ids.turnId) this.editorActionTurnIds.add(ids.turnId);
    if (ids.itemId) this.editorActionItemIds.add(ids.itemId);
    if (currentRun && ids.itemId) this.editorActionCurrentItemIds.add(ids.itemId);
    this.pruneEditorActionHiddenIds();
  }

  private pruneEditorActionHiddenIds(): void {
    pruneSet(this.editorActionThreadIds, 80);
    pruneSet(this.editorActionTurnIds, 120);
    pruneSet(this.editorActionItemIds, 400);
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
    const cwd = session && !this.isKnowledgeBaseSession(session) ? normalizeWorkspacePath(session.cwd) : "";
    return {
      ...(cwd ? { cwd } : {}),
      model: this.effectiveModel(),
      reasoning: this.selectedReasoning,
      serviceTier: this.selectedServiceTier,
      permission: this.selectedPermission,
      mode: this.selectedMode,
      mcpEnabled: this.plugin.settings.mcpEnabled,
      workspaceResources: this.plugin.settings.workspaceResources
    };
  }

  private activeProviderModels(): string[] {
    if (this.plugin.settings.providerMode !== "custom-api") return [];
    const provider = getActiveApiProvider(this.plugin.settings);
    return provider ? getApiProviderModels(provider) : [];
  }

  private resolvedKnowledgeBackend(): "codex-cli" | "opencode" {
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
    this.renderMessagesIfActive(session);
  }

  private appendProcessDelta(session: StoredSession, itemId: string, itemType: string, delta: string, payload: any): void {
    if (!delta) return;
    let messageId = this.activeItemMessages.get(itemId);
    let message = messageId ? session.messages.find((item) => item.id === messageId) : null;
    const summaryPayload = { ...payload, status: payload?.status ?? "running" };
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
    this.renderMessagesIfActive(session);
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

  private renderPlanUpdate(session: StoredSession, params: any): void {
    const lines: string[] = [];
    if (params?.explanation) lines.push(params.explanation, "");
    for (const item of params?.plan ?? []) {
      const mark = item.status === "completed" ? "x" : " ";
      const suffix = item.status === "inProgress" ? " (进行中)" : "";
      lines.push(`- [${mark}] ${item.step}${suffix}`);
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

  private renderStartedItem(session: StoredSession, item: any): void {
    if (!isProcessItemType(item?.type)) return;
    if (item.type === "reasoning" && !rawTextForProcessItem(item)) return;
    const status = item.status || "running";
    void this.upsertProcessItem(session, item.id || newId("process"), item.type, rawTextForProcessItem(item), status, { ...item, status });
  }

  private async renderCompletedItem(session: StoredSession, item: any): Promise<void> {
    if (!item?.type) return;
    if (item.type === "agentMessage") return;
    if (item.type === "reasoning" || item.type === "plan") {
      const text = rawTextForProcessItem(item);
      if (text) {
        await this.upsertProcessItem(session, item.id, item.type, text, item.status || "completed", { ...item, status: item.status || "completed" });
      } else {
        this.finishProcessItem(session, item.id, item.status || "completed");
      }
      return;
    }
    if (item.type === "commandExecution") {
      await this.upsertProcessItem(session, item.id, "commandExecution", `${item.command}\n\n${item.aggregatedOutput ?? ""}`.trim(), item.status || "completed", item);
    } else if (item.type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const diffSummary = buildDiffSummary(changes);
      const text = serializeFileChanges(changes);
      await this.upsertProcessItem(session, item.id, "fileChange", text || item.status, item.status || "completed", item, diffSummary);
    } else if (item.type === "mcpToolCall") {
      await this.upsertProcessItem(session, item.id, "mcpToolCall", JSON.stringify(item.result ?? item.error ?? item.arguments, null, 2), item.status || "completed", item);
    } else if (item.type === "dynamicToolCall") {
      await this.upsertProcessItem(session, item.id, "dynamicToolCall", JSON.stringify(item.contentItems ?? item.result ?? item.arguments, null, 2), item.status || "completed", item);
    } else if (item.type === "collabAgentToolCall") {
      await this.upsertProcessItem(session, item.id, "collabAgentToolCall", JSON.stringify(item.result ?? item.arguments ?? item, null, 2), item.status || "completed", item);
    } else if (item.type === "imageView") {
      this.addMessageToSession(session, {
        role: "assistant",
        title: "图片",
        itemType: "image",
        text: item.path,
        images: [{ type: "image", name: basename(item.path), path: item.path }],
        createdAt: Date.now()
      });
    } else if (item.type === "contextCompaction") {
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

  private async upsertProcessItem(session: StoredSession, id: string, itemType: string, text: string, status: string | undefined, payload: any, diffSummary?: DiffSummary): Promise<void> {
    const summary = summarizeProcessEvent(itemType, { ...payload, status }, this.plugin.getVaultPath(), session.cwd || this.plugin.getVaultPath());
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
    this.contextEl.style.setProperty("--codex-context-angle", `${view.angle}deg`);
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
    this.mcpPanelEl.empty();
    this.mcpPanelEl.createDiv({ cls: "codex-mcp-title", text: "MCP 状态" });
    if (error) {
      this.mcpPanelEl.createDiv({ cls: "codex-mcp-error", text: `读取失败：${error}` });
      const retry = this.mcpPanelEl.createEl("button", { cls: "codex-mcp-retry", text: "重新读取 MCP", attr: { type: "button" } });
      retry.onclick = () => {
        this.mcpPanelEl.removeClass("is-visible");
        void this.toggleMcpPanel();
      };
    }
    if (!this.plugin.settings.mcpEnabled && servers.length) {
      this.mcpPanelEl.createDiv({ cls: "codex-mcp-empty", text: "已读取到 MCP 服务。聊天 MCP 总开关关闭，下一轮对话暂不调用 MCP。" });
    }
    if (!servers.length) {
      if (!error) this.mcpPanelEl.createDiv({ cls: "codex-mcp-empty", text: "没有读取到 MCP 服务器。" });
      return;
    }
    for (const server of servers) this.renderMcpServer(server);
  }

  private renderMcpServer(server: McpServerStatus): void {
    const row = this.mcpPanelEl.createDiv({ cls: "codex-mcp-row" });
    row.createDiv({ cls: "codex-mcp-name", text: server.name });
    row.createDiv({ cls: "codex-mcp-meta", text: `${Object.keys(server.tools ?? {}).length} 个工具 · ${server.authStatus ?? "unknown"}` });
    if (server.authStatus === "notLoggedIn") {
      const login = row.createEl("button", { cls: "codex-toolbar-button", text: "登录", attr: { type: "button" } });
      login.onclick = async () => {
        try {
          const url = await this.plugin.codex?.startMcpOAuth(server.name);
          if (url) window.open(url);
          else new Notice("没有拿到 MCP 登录链接");
        } catch (error) {
          new Notice(`MCP 登录失败：${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
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
    this.activeItemMessages.clear();
  }

  private attachTurnIdToRun(session: StoredSession, turnId: string): void {
    if (!turnId || !this.activeRunId) return;
    for (const message of session.messages) {
      if (message.runId === this.activeRunId) message.turnId = turnId;
    }
  }

  private renderMessagesIfActive(session: StoredSession): void {
    if (session.id === this.plugin.settings.activeSessionId) this.scheduleRenderMessages();
  }

  private scheduleRenderMessages(options: { forceBottom?: boolean; fromScroll?: boolean } = {}): void {
    this.pendingRenderForceBottom = this.pendingRenderForceBottom || Boolean(options.forceBottom);
    if (options.fromScroll && !this.pendingRenderForceBottom) {
      this.pendingRenderFromScroll = true;
    } else if (!options.fromScroll) {
      this.pendingRenderFromScroll = false;
    }
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      const forceBottom = this.pendingRenderForceBottom;
      const fromScroll = this.pendingRenderFromScroll && !forceBottom;
      this.pendingRenderForceBottom = false;
      this.pendingRenderFromScroll = false;
      this.renderScheduled = false;
      this.renderMessages({ forceBottom, fromScroll });
    });
  }

  private scheduleMeasureVirtualRows(forceBottom = this.isMessagesNearBottom()): void {
    this.pendingMeasureForceBottom = this.pendingMeasureForceBottom || forceBottom;
    if (this.measureScheduled) return;
    this.measureScheduled = true;
    window.requestAnimationFrame(() => {
      const shouldForceBottom = this.pendingMeasureForceBottom;
      this.pendingMeasureForceBottom = false;
      this.measureScheduled = false;
      this.measureVisibleVirtualRows(shouldForceBottom);
    });
  }

  private measureVisibleVirtualRows(forceBottom = false): boolean {
    if (!this.virtualListEl) return false;
    let changed = false;
    for (const rowEl of Array.from(this.virtualListEl.querySelectorAll<HTMLElement>(".codex-virtual-row"))) {
      const id = rowEl.dataset.rowId;
      if (!id) continue;
      const height = Math.ceil(rowEl.getBoundingClientRect().height);
      if (height <= 0) continue;
      const previous = this.virtualRowHeights.get(id);
      if (previous === undefined || Math.abs(previous - height) > 1) {
        this.virtualRowHeights.set(id, height);
        changed = true;
      }
    }
    if (changed) this.scheduleRenderMessages({ forceBottom, fromScroll: !forceBottom });
    return changed;
  }

  private isMessagesNearBottom(): boolean {
    if (!this.messagesEl) return true;
    return isNearVirtualBottom(this.messagesEl.scrollTop, this.messagesEl.clientHeight, this.messagesEl.scrollHeight);
  }

  private resetVirtualWindow(): void {
    this.virtualSessionId = "";
    this.virtualRowHeights.clear();
    if (this.messagesEl) this.messagesEl.scrollTop = 0;
  }

  private pruneVirtualHeights(rowIds: string[]): void {
    const active = new Set(rowIds);
    for (const id of Array.from(this.virtualRowHeights.keys())) {
      if (!active.has(id)) this.virtualRowHeights.delete(id);
    }
  }

  private rememberOpenState(store: Map<string, boolean>, id: string, open: boolean): void {
    store.set(id, open);
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

type KnowledgeBaseHistoryFilter = "all" | "user" | "assistant" | "process" | "failed";

class KnowledgeBaseHistoryModal extends Modal {
  private activeDate = "";
  private activeFilter: KnowledgeBaseHistoryFilter = "all";
  private messages: ChatMessage[] = [];
  private dateListEl: HTMLElement | null = null;
  private activeDateEl: HTMLElement | null = null;
  private filterEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(
    app: any,
    private readonly days: KnowledgeBaseHistoryDaySummary[],
    private readonly loadDay: (date: string) => Promise<ChatMessage[]>,
    private readonly restoreDay: (date: string) => Promise<void>
  ) {
    super(app);
    this.activeDate = days[0]?.date ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-kb-history-modal");
    const header = contentEl.createDiv({ cls: "codex-kb-history-header" });
    header.createEl("h2", { text: "历史" });
    header.createDiv({ cls: "codex-kb-history-summary", text: `${this.days.length} 天记录 · 按天聚合` });

    const layout = contentEl.createDiv({ cls: "codex-kb-history-layout" });
    this.dateListEl = layout.createDiv({ cls: "codex-kb-history-days" });
    const main = layout.createDiv({ cls: "codex-kb-history-main" });
    this.filterEl = main.createDiv({ cls: "codex-kb-history-actions" });
    this.activeDateEl = main.createDiv({ cls: "codex-kb-history-current-day" });
    this.listEl = main.createDiv({ cls: "codex-kb-history-list" });
    this.renderDates();
    this.renderFilters();
    void this.selectDate(this.activeDate);
  }

  onClose(): void {
    this.contentEl.empty();
    this.contentEl.removeClass("codex-kb-history-modal");
  }

  private renderDates(): void {
    if (!this.dateListEl) return;
    this.dateListEl.empty();
    for (const day of this.days) {
      const button = this.dateListEl.createEl("button", {
        cls: `codex-kb-history-day ${day.date === this.activeDate ? "is-active" : ""}`.trim(),
        attr: { type: "button" }
      });
      button.createSpan({ text: day.date });
      button.createEl("small", { text: `${day.messageCount} 条` });
      button.onclick = () => void this.selectDate(day.date);
    }
  }

  private renderFilters(): void {
    if (!this.filterEl) return;
    this.filterEl.empty();
    const labels: Record<KnowledgeBaseHistoryFilter, string> = {
      all: "全部",
      user: "我",
      assistant: "回复",
      process: "过程",
      failed: "失败"
    };
    for (const filter of Object.keys(labels) as KnowledgeBaseHistoryFilter[]) {
      const button = this.filterEl.createEl("button", {
        cls: `codex-resource-tab ${filter === this.activeFilter ? "is-active" : ""}`.trim(),
        text: labels[filter],
        attr: { type: "button" }
      });
      button.onclick = () => {
        this.activeFilter = filter;
        this.renderFilters();
        this.renderMessages();
      };
    }
    const restoreButton = this.filterEl.createEl("button", { cls: "mod-cta", text: "恢复显示", attr: { type: "button", title: "只恢复可见内容，不恢复旧模型上下文" } });
    restoreButton.onclick = async () => {
      await this.restoreDay(this.activeDate);
      this.close();
    };
  }

  private async selectDate(date: string): Promise<void> {
    if (!date) return;
    this.activeDate = date;
    this.renderDates();
    if (this.listEl) {
      this.listEl.empty();
      this.listEl.createDiv({ cls: "codex-kb-history-more", text: "读取中..." });
    }
    try {
      this.messages = await this.loadDay(date);
    } catch (error) {
      console.error("Codex knowledge history day read failed", error);
      this.messages = [];
      if (this.listEl) {
        this.listEl.empty();
        this.listEl.createDiv({ cls: "codex-kb-history-more", text: "读取失败" });
      }
      return;
    }
    this.renderMessages();
  }

  private renderMessages(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const filtered = this.messages.filter((message) => historyMessageMatchesFilter(message, this.activeFilter));
    if (this.activeDateEl) {
      this.activeDateEl.setText(`${this.activeDate} · ${filtered.length}/${this.messages.length} 条`);
    }
    if (!filtered.length) {
      this.listEl.createDiv({ cls: "codex-kb-history-more", text: "这一天没有符合筛选的记录。" });
      return;
    }
    for (const message of filtered) {
      const row = this.listEl.createDiv({ cls: "codex-kb-history-row" });
      const meta = row.createDiv({ cls: "codex-kb-history-meta" });
      meta.createSpan({ text: formatAbsoluteTime(message.createdAt) });
      meta.createSpan({ text: roleLabel(message.role) });
      if (message.title) meta.createSpan({ text: message.title });
      if (message.status) meta.createSpan({ text: message.status });
      row.createDiv({ cls: "codex-kb-history-text", text: compactHistoryText(message) });
    }
  }
}

function historyMessageMatchesFilter(message: ChatMessage, filter: KnowledgeBaseHistoryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "user") return message.role === "user";
  if (filter === "assistant") return message.role === "assistant";
  if (filter === "process") return Boolean(message.itemType) && message.role !== "user" && message.role !== "assistant";
  if (filter === "failed") return message.status === "failed" || message.status === "error";
  return true;
}

function roleLabel(role: ChatMessage["role"]): string {
  if (role === "user") return "我";
  if (role === "assistant") return "EchoInk";
  if (role === "tool") return "工具";
  return "系统";
}

function compactHistoryText(message: ChatMessage): string {
  const text = (displayTextForMessage(message) || message.previewText || "").replace(/\s+/g, " ").trim();
  if (!text) return "(空消息)";
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function labelFor(value: string): string {
  const labels: Record<string, string> = {
    low: "低思考",
    medium: "中思考",
    high: "高思考",
    xhigh: "超高思考",
    standard: "标准",
    fast: "快速",
    flex: "弹性",
    "read-only": "只读",
    "workspace-write": "工作区可写",
    "danger-full-access": "完全访问权限",
    agent: "Agent",
    plan: "Plan"
  };
  return labels[value] ?? value;
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

function isProcessItemType(itemType?: string): boolean {
  return itemType === "reasoning" || itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall" || itemType === "plan";
}

function isGroupedProcessItemType(itemType?: string): boolean {
  return itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall";
}

function sameProcessRun(a: ChatMessage, b: ChatMessage): boolean {
  if (a.runId || b.runId) return a.runId === b.runId;
  return true;
}

function messageRowId(message: ChatMessage): string {
  return `message:${message.id}`;
}

function processGroupRowId(messages: ChatMessage[]): string {
  const first = messages[0];
  return `processGroup:${first?.runId ?? "none"}:${first?.id ?? "process"}`;
}

function processGroupId(messages: ChatMessage[]): string {
  return processGroupStateId(messages);
}

function processGroupTitle(messages: ChatMessage[]): string {
  const count = messages.length;
  return count === 1 ? "已处理 1 个动作" : `已处理 ${count} 个动作`;
}

function processGroupDetail(messages: ChatMessage[]): string {
  const labels: Record<string, string> = {
    search: "搜索",
    view: "查看",
    edit: "编辑",
    run: "运行",
    tool: "工具",
    command: "命令",
    other: "其他"
  };
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = message.processKind ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => `${labels[key] ?? key} ${count}`)
    .join("，");
}

function processGroupStatus(messages: ChatMessage[]): string {
  if (messages.some((message) => message.status === "running")) return "进行中";
  if (messages.some((message) => message.status === "error" || message.status === "failed")) return "有失败";
  if (messages.some((message) => message.status === "interrupted")) return "未完成";
  return "完成";
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

function roleForProcessItem(itemType: string): ChatMessage["role"] {
  return itemType === "reasoning" || itemType === "plan" ? "assistant" : "tool";
}

function rawTextForProcessItem(item: any): string {
  if (item?.type === "commandExecution") return item.command ?? "";
  if (item?.type === "fileChange") return (item.changes ?? []).map((change: any) => change.path).join("\n");
  if (item?.type === "mcpToolCall") return [item.server, item.tool].filter(Boolean).join(".");
  if (item?.type === "dynamicToolCall") return [item.namespace, item.tool].filter(Boolean).join(".");
  if (item?.type === "collabAgentToolCall") return item.tool ?? "";
  if (item?.type === "reasoning") return reasoningTextFromPayload(item);
  if (item?.type === "plan") return item.text ?? "";
  return "";
}

function editorActionStatusLabel(status: EditorActionStatusView): string {
  const action = status.actionLabel ?? "写作";
  const mode = status.modeLabel ?? "";
  if (status.status === "idle") {
    if (status.understandingStatus === "fresh") return "已理解";
    if (status.understandingStatus === "reused") return "正文有变化，已复用";
    if (status.understandingStatus === "stale") return "理解过期";
    return "写作";
  }
  if (status.status === "preparing") return `准备${action}`;
  if (status.status === "connecting") return "连接 Codex";
  if (status.status === "generating") {
    const seconds = status.startedAt ? Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000)) : 0;
    if (status.phase === "understanding") return `理解中 ${seconds}s`;
    if (status.phase === "reviewing") return `${mode || "严格"}审校中 ${seconds}s`;
    return `${mode ? `${mode}` : ""}${action}中 ${seconds}s`;
  }
  if (status.status === "awaiting-confirm") return "待确认 Enter / Esc";
  if (status.status === "confirmed") return status.message || "已替换";
  if (status.status === "canceled") return status.message || "已取消";
  return "写作失败";
}

function articleUnderstandingStatusLabel(status: ArticleUnderstandingStatus, error?: string): string {
  if (status === "fresh") return "已理解";
  if (status === "reused") return "正文有变化，已复用";
  if (status === "running") return "理解中";
  if (status === "stale") return "理解过期";
  if (status === "failed") return error ? `失败：${error}` : "理解失败";
  if (status === "missing") return "未理解";
  return "空闲";
}

function formatRelativeTime(value: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function editorActionTimeoutForMode(baseTimeoutMs: number, mode: EditorActionQualityMode): number {
  if (mode === "strict") return Math.max(baseTimeoutMs, 120000);
  if (mode === "quality") return Math.max(baseTimeoutMs, 90000);
  return baseTimeoutMs;
}

function mergeProcessFiles(current: ProcessFileRef[] | undefined, incoming: ProcessFileRef[]): ProcessFileRef[] {
  const byKey = new Map<string, ProcessFileRef>();
  for (const file of [...(current ?? []), ...incoming]) {
    byKey.set(`${file.kind}:${file.path}`, file);
  }
  return Array.from(byKey.values()).slice(0, 8);
}

function summarizeAttachmentFile(attachment: StoredAttachment, vaultPath: string): ProcessFileRef {
  return normalizeProcessFileRef(attachment.path, vaultPath);
}

async function pickWorkspaceDirectory(defaultPath: string): Promise<string | null | undefined> {
  if (!Platform.isDesktopApp) return undefined;
  const electron = electronModule();
  const dialog = electron?.remote?.dialog ?? electron?.dialog;
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

function electronModule(): any {
  const electronRequire = (window as any).require ?? (globalThis as any).require;
  try {
    return electronRequire?.("electron");
  } catch {
    return null;
  }
}

function showItemInFinder(filePath: string): boolean {
  if (!Platform.isDesktopApp || !filePath) return false;
  const shell = electronModule()?.shell;
  if (!shell?.showItemInFolder) return false;
  shell.showItemInFolder(filePath);
  return true;
}

function compactReasoningLabel(value: ReasoningEffort): string {
  const labels: Record<string, string> = {
    none: "无",
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高"
  };
  return labels[value] ?? value;
}

function composerActionButtonView(action: ReturnType<typeof composerPrimaryActionForState>): { icon: string; label: string; title: string } {
  if (action === "enqueue") return { icon: "list-plus", label: "入队发送", title: "加入队列，当前任务结束后发送" };
  if (action === "resume-queue") return { icon: "play", label: "继续队列", title: "继续队列" };
  if (action === "stop-turn" || action === "cancel-knowledge-task") return { icon: "square", label: "停止", title: "停止当前任务" };
  return { icon: "send-horizontal", label: "发送", title: "发送" };
}

function isLocalKnowledgeBaseCommand(intent: string): boolean {
  return intent === "clear" || intent === "history";
}

function queuedTurnPreview(item: QueuedTurnItem): string {
  const text = item.text.trim() || (item.attachments.length ? "(附件)" : "");
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function queuedTurnMeta(item: QueuedTurnItem): string {
  const parts = [
    item.kind === "knowledge-base" ? "知识库" : "对话",
    item.turnOptions.model ? shortModelLabel(item.turnOptions.model) : "自动",
    compactReasoningLabel(item.turnOptions.reasoning)
  ];
  if (item.skill) parts.push(`Skill ${item.skill.name}`);
  if (item.attachments.length) parts.push(`${item.attachments.length} 个附件`);
  return parts.join(" · ");
}

function knowledgeBaseTurnOverrides(turnOptions: QueuedTurnItem["turnOptions"]) {
  return {
    model: turnOptions.model,
    reasoning: turnOptions.reasoning,
    serviceTier: turnOptions.serviceTier,
    mcpEnabled: turnOptions.mcpEnabled,
    workspaceResources: turnOptions.workspaceResources
  };
}

function shortModelLabel(value: string): string {
  if (!value.trim()) return "自动";
  return value
    .replace(/^gpt-/i, "")
    .replace(/-/g, " ")
    .replace(/\bmini\b/i, "Mini")
    .replace(/\bhigh\b/i, "High")
    .trim();
}

function compactAccountLabel(value: string): string {
  if (!value) return "未连接";
  if (value.startsWith("ChatGPT：")) return "ChatGPT";
  return value.length > 14 ? `${value.slice(0, 13)}…` : value;
}

function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
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
    reasoning: "brain",
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
    reasoning: "已思考",
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
    blocked: "等待确认",
    interrupted: "中断"
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

function knowledgeInitStatusLabel(status: string): string {
  if (status === "preview-ready") return "已预览";
  if (status === "initialized") return "已初始化";
  if (status === "failed") return "初始化失败";
  return "未初始化";
}

function knowledgeRunStatusLabel(status: string, at: number): string {
  const labels: Record<string, string> = {
    idle: "未运行",
    running: "运行中",
    success: "成功",
    failed: "失败",
    canceled: "已取消"
  };
  const label = labels[status] ?? status;
  return at ? `${label} · ${formatRelativeTime(at)}` : label;
}

const HEATMAP_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function heatmapYear(snapshot: KnowledgeBaseDashboardSnapshot): number {
  const firstDate = snapshot.checkHeatmap[0] ? parseHeatmapDateKey(snapshot.checkHeatmap[0].date) : null;
  return firstDate?.getFullYear() ?? new Date(snapshot.generatedAt).getFullYear();
}

function heatmapWeekIndex(dateKey: string, yearStart: Date): number {
  const date = parseHeatmapDateKey(dateKey);
  if (!date) return 0;
  const daysFromYearStart = Math.round((date.getTime() - yearStart.getTime()) / 86400000);
  return Math.floor((daysFromYearStart + yearStart.getDay()) / 7);
}

function parseHeatmapDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
}

function knowledgeHeatmapStatusLabel(status: string): string {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return "无记录";
}

function formatAbsoluteTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRecentFiles(files: KnowledgeBaseDashboardFile[]): string {
  if (!files.length) return "无";
  return files.slice(0, 3).map((file) => file.path.split("/").pop() || file.path).join("，");
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

function pruneSet<T>(set: Set<T>, maxSize: number): void {
  while (set.size > maxSize) {
    const first = set.values().next();
    if (first.done) return;
    set.delete(first.value);
  }
}

function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(filePath);
}

function absoluteVaultPath(vaultPath: string, relativePath: string): string {
  return `${vaultPath.replace(/\/$/, "")}/${relativePath.replace(/^\//, "")}`;
}

function toImageSrc(app: any, imagePath: string): string {
  if (imagePath.startsWith("/")) return `file://${imagePath}`;
  const file = app.vault.getAbstractFileByPath(imagePath);
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  if (Platform.isDesktopApp) return `file://${imagePath}`;
  return imagePath;
}
