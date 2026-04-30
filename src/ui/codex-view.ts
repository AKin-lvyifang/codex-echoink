import { ItemView, Menu, normalizePath, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ChatMessage, DiffSummary, StoredAttachment, StoredSession } from "../settings/settings";
import { DEFAULT_SETTINGS, ensureModelChoices, filterEnabledSkills, getActiveApiProvider, getApiProviderModels, newId, providerConnectionLabel } from "../settings/settings";
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
import { basename, buildUserInput, contextUsageView, filterSkills, getSlashQuery, normalizeProcessFileRef, reasoningTextFromPayload, summarizeProcessEvent } from "../core/mapping";
import { settleStaleRunningMessages } from "../core/message-state";
import { formatRateLimitUsage, normalizeRateLimitResponse, type RateLimitWindowView } from "../core/rate-limits";
import { displayTextForMessage, isLargeRawMessage } from "../core/raw-message-store";
import { calculateVirtualWindow, isNearVirtualBottom, scrollTopForVirtualBottom } from "../core/virtual-window";
import { renderSettingsGearIcon } from "./codex-icon";
import { openImageOverlay, renderRichText } from "./render-message";
import { textInputModal } from "./modals";

export const VIEW_TYPE_CODEX = "codex-for-obsidian-view";

type MessageRenderRow =
  | { id: string; kind: "message"; message: ChatMessage }
  | { id: string; kind: "processGroup"; messages: ChatMessage[] };

export class CodexView extends ItemView {
  private rootEl!: HTMLElement;
  private headerStatusEl!: HTMLElement;
  private headerStatusTextEl!: HTMLElement;
  private headerUsageEl!: HTMLButtonElement;
  private headerUsageTextEl!: HTMLElement;
  private usagePanelEl!: HTMLElement;
  private tabBarEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private virtualListEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private toolbarEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private contextRingEl!: HTMLElement;
  private contextValueEl!: HTMLElement;
  private skillMenuEl!: HTMLElement;
  private mcpPanelEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private running = false;
  private activeRunId = "";
  private activeRunSessionId = "";
  private activeTurnId = "";
  private turnStartedAt = 0;
  private turnWatchdog: number | null = null;
  private activeThinkingMessageId = "";
  private activePlanMessageId = "";
  private activeItemMessages = new Map<string, string>();
  private openProcessGroups = new Map<string, boolean>();
  private openProcessItems = new Map<string, boolean>();
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

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.selectedModel = plugin.settings.defaultModel;
    this.selectedReasoning = plugin.settings.defaultReasoning;
    this.selectedServiceTier = plugin.settings.defaultServiceTier;
    this.selectedPermission = plugin.settings.defaultPermission;
    this.selectedMode = plugin.settings.defaultMode;
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
    this.prewarmActiveThread();
    void this.refreshHeaderRateLimits();
  }

  async onClose(): Promise<void> {
    this.clearTurnWatchdog();
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

  handleCodexNotification(notification: CodexNotification): void {
    const { method, params } = notification;
    if (method === "turn/started") {
      const session = this.activeRunSession();
      this.running = true;
      this.activeTurnId = params?.turn?.id ?? "";
      this.turnStartedAt = Date.now();
      this.attachTurnIdToRun(session, this.activeTurnId);
      this.ensureThinkingMessage(session, "生成中", "正在生成回复...");
      this.armTurnWatchdog();
      this.applyStatus();
      return;
    }
    if (method === "turn/completed") {
      const session = this.activeRunSession();
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.finishThinkingMessage(session, params?.turn?.status === "failed" ? "中断" : "完成");
      this.finishRunningProcessMessages(session, params?.turn?.status === "failed" ? "failed" : "completed");
      this.finishPlanMessage(session);
      this.clearActiveRun();
      this.applyStatus();
      void this.plugin.saveSettings(true);
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
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.finishThinkingMessage(session, "失败");
      this.finishRunningProcessMessages(session, "error");
      this.addMessageToSession(session, {
        role: "system",
        text: params?.message ?? "Codex 出错了",
        itemType: "error",
        title: "错误"
      });
      this.clearActiveRun();
      this.applyStatus();
    }
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
    title.createSpan({ cls: "codex-title-text", text: "Codex" });
    const headerActions = header.createDiv({ cls: "codex-header-actions" });
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
    this.registerDomEvent(document, "click", (event) => {
      if (!this.rootEl.contains(event.target as Node)) this.usagePanelEl.removeClass("is-visible");
    });

    this.tabBarEl = this.rootEl.createDiv({ cls: "codex-tabs" });
    this.messagesEl = this.rootEl.createDiv({ cls: "codex-messages" });
    this.virtualListEl = this.messagesEl.createDiv({ cls: "codex-virtual-list" });
    this.registerDomEvent(this.messagesEl, "scroll", () => this.scheduleRenderMessages({ fromScroll: true }));

    const inputWrap = this.rootEl.createDiv({ cls: "codex-input-wrap" });
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
    this.toolbarEl = inputWrap.createDiv({ cls: "codex-toolbar" });
    this.mcpPanelEl = this.rootEl.createDiv({ cls: "codex-mcp-panel" });
    this.renderToolbar();
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
    this.plugin.settings.sessions.forEach((session, index) => {
      const tab = this.tabBarEl.createEl("button", {
        cls: `codex-tab ${session.id === this.plugin.settings.activeSessionId ? "is-active" : ""}`,
        text: String(index + 1),
        attr: { type: "button", title: session.title || "新会话" }
      });
      tab.onclick = async () => {
        this.plugin.settings.activeSessionId = session.id;
        await this.plugin.saveSettings(true);
        this.resetVirtualWindow();
        this.renderTabs();
        this.renderMessages({ forceBottom: true });
        this.renderToolbar();
        this.prewarmActiveThread();
      };
      tab.oncontextmenu = (event) => this.openSessionMenu(event, session);
      tab.ondblclick = () => void this.renameSession(session);
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
      this.prewarmActiveThread();
    };
  }

  private renderMessages(options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void {
    const session = this.ensureSession();
    this.settleStaleMessages(session);
    if (this.virtualSessionId !== session.id) {
      this.virtualSessionId = session.id;
      this.virtualRowHeights.clear();
    }
    const previousScrollTop = this.messagesEl.scrollTop;
    const shouldPinBottom = Boolean(options.forceBottom) || (!options.fromScroll && this.isMessagesNearBottom());
    this.virtualListEl.empty();
    if (session.messages.length === 0) {
      this.virtualListEl.style.height = "100%";
      const welcome = this.virtualListEl.createDiv({ cls: "codex-welcome" });
      welcome.createDiv({ cls: "codex-welcome-title", text: "What's new?" });
      return;
    }
    const rows = this.buildVirtualRows(session.messages);
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
    if (message.title) wrapper.createDiv({ cls: "codex-message-title", text: message.title });
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
    renderRichText(this.app, this, content, displayTextForMessage(message));
    if (message.rawRef) this.renderRawMessageExpander(content, message);
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
    setIcon(icon, iconForItemType(message.itemType));
    const main = summary.createDiv({ cls: "codex-process-main" });
    main.createSpan({ cls: "codex-structured-title codex-process-title", text: titleForItemType(message) });
    if (message.itemType === "fileChange" && message.diffSummary) this.renderDiffStats(main, message.diffSummary);
    if (message.details) main.createDiv({ cls: "codex-process-detail", text: message.details });
    if (message.files?.length) this.renderProcessFileChips(main.createDiv({ cls: "codex-process-files" }), message.files);
    if (message.status) summary.createSpan({ cls: "codex-structured-status", text: labelForStatus(message.status) });
    if (details.open) renderBody();
  }

  private renderProcessBody(body: HTMLElement, message: ChatMessage): void {
    const fallback = message.status === "running" ? "正在接收过程内容..." : "暂无内容";
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
      this.renderDiffFiles(body, files);
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

  private renderDiffFiles(container: HTMLElement, files: ParsedDiffFile[]): void {
    const list = container.createDiv({ cls: "codex-diff-files" });
    files.forEach((file, index) => {
      const details = list.createEl("details", { cls: "codex-diff-file" });
      details.open = files.length === 1 || index === 0;
      let rendered = false;
      const renderRows = () => {
        if (rendered) return;
        rendered = true;
        const body = details.createDiv({ cls: "codex-diff-file-body" });
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
      };
      details.ontoggle = () => {
        if (details.open) renderRows();
      };
      const summary = details.createEl("summary", { cls: "codex-diff-file-summary" });
      const main = summary.createSpan({ cls: "codex-diff-file-main" });
      main.createSpan({ cls: "codex-diff-file-path", text: file.path });
      if (file.previousPath) main.createSpan({ cls: "codex-diff-file-previous", text: `原路径 ${file.previousPath}` });
      summary.createSpan({ cls: "codex-diff-file-kind", text: labelForDiffKind(file.kind) });
      const stats = summary.createSpan({ cls: "codex-diff-file-stats" });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-add", text: `+${file.added}` });
      stats.createSpan({ cls: "codex-diff-stat codex-diff-stat-remove", text: `-${file.removed}` });
      if (details.open) renderRows();
    });
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
    this.toolbarEl.empty();
    this.renderAttachments();

    const model = this.plugin.lastStatus?.models.find((item) => item.isDefault)?.model || this.plugin.lastStatus?.models[0]?.model || DEFAULT_SETTINGS.defaultModel;
    if (!this.selectedModel) this.selectedModel = this.plugin.settings.defaultModel || model;

    const row = this.toolbarEl.createDiv({ cls: "codex-composer-row" });
    const left = row.createDiv({ cls: "codex-composer-left" });
    const right = row.createDiv({ cls: "codex-composer-right" });

    const addButton = this.createComposerIconButton(left, "plus", "添加内容");
    addButton.onclick = (event) => this.openAddMenu(event);

    this.addComposerSelect<PermissionMode>(left, "shield-check", ["read-only", "workspace-write", "danger-full-access"], this.selectedPermission, (value) => {
      this.selectedPermission = value;
      this.persistComposerDefaults();
      this.renderToolbar();
    }, "权限", "codex-permission-control");

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

    const sendButton = row.createEl("button", {
      cls: "codex-send-button codex-composer-send-button",
      attr: { type: "button", "aria-label": this.running ? "停止" : "发送", title: this.running ? "停止" : "发送" }
    });
    setIcon(sendButton, this.running ? "square" : "send-horizontal");
    sendButton.onclick = () => (this.running ? this.stopTurn() : this.sendMessage());
    this.updateContext(this.ensureSession().tokenUsage, false);
  }

  private createComposerIconButton(container: HTMLElement, iconName: string, title: string): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "codex-composer-icon-button",
      attr: { type: "button", "aria-label": title, title }
    });
    setIcon(button, iconName);
    return button;
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

  private openAddMenu(event: MouseEvent): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("添加当前笔记")
        .setIcon("file-text")
        .onClick(() => this.attachActiveFile())
    );
    menu.addItem((item) =>
      item
        .setTitle("添加文件")
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

  private openModelMenu(event: MouseEvent): void {
    event.preventDefault();
    const menu = new Menu();
    const providerModels = this.activeProviderModels();
    const effectiveModel = this.effectiveModel();
    const models = providerModels.length
      ? ensureModelChoices([], ...providerModels)
      : ensureModelChoices(this.plugin.lastStatus?.models ?? [], this.selectedModel, this.plugin.settings.defaultModel, DEFAULT_SETTINGS.defaultModel);
    menu.addItem((item) => item.setTitle("模型").setIsLabel(true));
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
      menu.addItem((item) => item.setTitle(this.selectedModel || DEFAULT_SETTINGS.defaultModel).setIcon("box").setChecked(true));
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
    return `模型：${this.effectiveModel()}\n思考：${labelFor(this.selectedReasoning)}\n速度：${labelFor(this.selectedServiceTier)}\n模式：${labelFor(this.selectedMode)}`;
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
    const all = [...(this.selectedSkill ? [{ type: "file" as const, name: `/${this.selectedSkill.name}`, path: this.selectedSkill.path }] : []), ...this.attachments];
    this.attachmentsEl.toggleClass("is-empty", all.length === 0);
    for (const item of all) {
      const chip = this.attachmentsEl.createDiv({ cls: "codex-attachment-chip" });
      chip.createSpan({ text: item.name });
      const remove = chip.createEl("button", { text: "×", attr: { type: "button" } });
      remove.onclick = () => {
        if (this.selectedSkill?.path === item.path) this.selectedSkill = null;
        this.attachments = this.attachments.filter((attachment) => attachment.path !== item.path);
        this.renderAttachments();
      };
    }
  }

  private onInputChanged(): void {
    const query = getSlashQuery(this.inputEl.value);
    if (query === null) {
      this.skillMenuEl.removeClass("is-visible");
      return;
    }
    const skills = this.plugin.lastStatus?.skills ?? [];
    if (!skills.length && !this.skillsRequested) {
      this.skillsRequested = true;
      this.skillMenuEl.empty();
      this.skillMenuEl.createDiv({ cls: "codex-skill-empty", text: "正在加载 skills..." });
      this.skillMenuEl.addClass("is-visible");
      void this.plugin.ensureSkillsLoaded().then(() => {
        const activeQuery = getSlashQuery(this.inputEl.value);
        if (activeQuery !== null) this.renderSkillMatches(activeQuery);
      });
      return;
    }
    this.renderSkillMatches(query);
  }

  private renderSkillMatches(query: string): void {
    this.skillMenuEl.empty();
    const enabledSkills = filterEnabledSkills(this.plugin.lastStatus?.skills ?? [], this.plugin.settings.workspaceResources.skills);
    const matches = filterSkills(enabledSkills, query);
    for (const skill of matches) {
      const item = this.skillMenuEl.createDiv({ cls: "codex-skill-item" });
      item.createDiv({ cls: "codex-skill-name", text: `/${skill.name}` });
      item.createDiv({ cls: "codex-skill-desc", text: skill.description || skill.path });
      item.onclick = () => {
        this.selectedSkill = skill;
        this.inputEl.value = this.inputEl.value.replace(/(?:^|\s)\/([^\s/]*)$/, "").trimStart();
        this.skillMenuEl.removeClass("is-visible");
        this.renderAttachments();
        this.inputEl.focus();
      };
    }
    if (matches.length === 0) this.skillMenuEl.createDiv({ cls: "codex-skill-empty", text: "没有匹配的 skill" });
    this.skillMenuEl.addClass("is-visible");
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (this.running || (!text && !this.attachments.length && !this.selectedSkill)) return;
    let session = this.ensureSession();
    try {
      const status = await this.plugin.ensureCodexConnected();
      this.applyStatus();
      if (!status.connected) throw new Error("Codex 未连接");
      session = this.ensureSession();
      const runId = newId("run");
      this.activeRunId = runId;
      this.activeRunSessionId = session.id;
      const turnAttachments = [...this.attachments];
      const userMessage: ChatMessage = {
        id: newId("msg"),
        role: "user",
        text: text || "(附件)",
        runId,
        attachments: turnAttachments,
        images: turnAttachments.filter((item) => item.type === "image"),
        createdAt: Date.now()
      };
      await this.plugin.externalizeMessageText(userMessage, userMessage.text);
      session.messages.push(userMessage);
      session.updatedAt = Date.now();
      if (session.title === "新会话" && text) session.title = text.slice(0, 20);
      this.inputEl.value = "";
      const turnSkill = this.selectedSkill;
      this.attachments = [];
      this.selectedSkill = null;
      this.renderTabs();
      this.renderMessages({ forceBottom: true });
      this.renderToolbar();

      const turnOptions = this.currentTurnOptions();
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
      const input = buildUserInput(text, turnAttachments, turnSkill);
      this.activeTurnId = await this.plugin.codex!.startTurn(session.threadId, input, turnOptions);
      this.attachTurnIdToRun(session, this.activeTurnId);
      await this.plugin.saveSettings();
    } catch (error) {
      this.running = false;
      this.activeTurnId = "";
      this.clearTurnWatchdog();
      this.finishThinkingMessage(session, "失败");
      this.addMessageToSession(session, {
        role: "system",
        title: "发送失败",
        itemType: "error",
        text: error instanceof Error ? error.message : String(error)
      });
      this.clearActiveRun();
      new Notice(`Codex 发送失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.applyStatus();
    }
  }

  private async stopTurn(): Promise<void> {
    const session = this.activeRunSession();
    if (!session.threadId || !this.activeTurnId) return;
    await this.plugin.codex?.interruptTurn(session.threadId, this.activeTurnId).catch(() => undefined);
    this.running = false;
    this.activeTurnId = "";
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

  private armTurnWatchdog(): void {
    this.clearTurnWatchdog();
    this.turnWatchdog = window.setTimeout(() => {
      if (!this.running) return;
      const session = this.activeRunSession();
      this.turnWatchdog = null;
      this.running = false;
      this.activeTurnId = "";
      this.finishThinkingMessage(session, "失败");
      this.finishRunningProcessMessages(session, "error");
      this.addMessageToSession(session, {
        role: "system",
        title: "响应超时",
        itemType: "error",
        text: "这轮回复超过 5 分钟没有完成，已停止等待。可以重试或重新连接 Codex。"
      });
      this.clearActiveRun();
      this.applyStatus();
      void this.plugin.saveSettings(true);
    }, 5 * 60 * 1000);
  }

  private clearTurnWatchdog(): void {
    if (!this.turnWatchdog) return;
    window.clearTimeout(this.turnWatchdog);
    this.turnWatchdog = null;
  }

  private currentTurnOptions() {
    return {
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

  private effectiveModel(): string {
    const providerModels = this.activeProviderModels();
    if (providerModels.length) {
      return providerModels.includes(this.selectedModel) ? this.selectedModel : providerModels[0];
    }
    return this.selectedModel || this.plugin.settings.defaultModel || this.plugin.lastStatus?.models[0]?.model || DEFAULT_SETTINGS.defaultModel;
  }

  private prewarmActiveThread(): void {
    const session = this.ensureSession();
    if (session.threadId || this.running) return;
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
    const status = await this.plugin.ensureCodexConnected();
    if (!status.connected || !this.plugin.codex || session.threadId) return Boolean(session.threadId);
    const started = await this.plugin.codex.startThread(this.currentTurnOptions());
    session.threadId = started.threadId;
    await this.plugin.saveSettings();
    return true;
  }

  private appendItemDelta(session: StoredSession, itemId: string, role: ChatMessage["role"], delta: string, itemType: string, title: string): void {
    if (!delta) return;
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
    const summary = summarizeProcessEvent(itemType, summaryPayload, this.plugin.getVaultPath());
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
        if (message.itemType === "reasoning") this.refreshProcessSummary(message, status);
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
    const summary = summarizeProcessEvent(itemType, { ...payload, status }, this.plugin.getVaultPath());
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
    if (existing.itemType === "reasoning") this.refreshProcessSummary(existing, status);
    session.updatedAt = Date.now();
    this.renderMessagesIfActive(session);
  }

  private refreshProcessSummary(message: ChatMessage, status: string): void {
    if (!message.itemType) return;
    const summary = summarizeProcessEvent(message.itemType, { text: message.text, status }, this.plugin.getVaultPath());
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
    this.activeRunSessionId = "";
    this.activeTurnId = "";
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
    const activeId = this.plugin.settings.activeSessionId;
    const active = this.plugin.settings.sessions.find((session) => session.id === activeId);
    if (active) return active;
    return this.createSession();
  }

  private createSession(): StoredSession {
    const session: StoredSession = {
      id: newId("session"),
      title: "新会话",
      cwd: this.plugin.getVaultPath(),
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
      const pasted = await saveClipboardImageAttachments(files, { vaultPath: this.plugin.getVaultPath() });
      this.attachments.push(...pasted);
      this.renderAttachments();
    } catch (error) {
      console.error("Codex paste image failed", error);
      new Notice("粘贴图片失败");
    }
  }
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
  const first = messages[0];
  return `group-${first?.runId ?? first?.id ?? "process"}`;
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

function showItemInFinder(filePath: string): boolean {
  if (!Platform.isDesktopApp || !filePath) return false;
  const electronRequire = (window as any).require ?? (globalThis as any).require;
  const shell = electronRequire?.("electron")?.shell;
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

function shortModelLabel(value: string): string {
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

function formatBytes(charCount: number): string {
  if (charCount < 1024) return `${charCount} 字`;
  if (charCount < 1024 * 1024) return `${Math.round(charCount / 1024)} KB`;
  return `${(charCount / 1024 / 1024).toFixed(1)} MB`;
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
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
