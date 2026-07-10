import type { App, Component } from "obsidian";
import { setIcon } from "obsidian";
import { formatRateLimitUsage, type RateLimitWindowView } from "../../core/rate-limits";
import { resolveEditorActionModeConfig } from "../../settings/settings";
import type { RateLimitSnapshot } from "../../types/app-server";
import type { ArticleUnderstandingEntry, ArticleUnderstandingStatus, EditorActionQualityMode, EditorActionStatusView, EditorAiActionSettings } from "../../editor-actions/types";
import type { EditorActionSummarySource } from "../../editor-actions/summary-cache";
import { renderSettingsGearIcon } from "../codex-icon";
import { renderRichText } from "../render-message";

export interface ArticleUnderstandingPanelState {
  status: ArticleUnderstandingStatus;
  source?: EditorActionSummarySource;
  entry?: ArticleUnderstandingEntry | null;
  mode?: EditorActionQualityMode;
  modeLabel?: string;
  model?: string;
  usedInLastRun?: boolean;
  error?: string;
}

export interface CodexHeaderRefs {
  headerStatusEl: HTMLElement;
  headerStatusTextEl: HTMLElement;
  editorActionStatusEl: HTMLElement;
  editorActionStatusTextEl: HTMLElement;
  headerHistoryEl: HTMLButtonElement;
  headerUsageEl: HTMLButtonElement;
  headerUsageTextEl: HTMLElement;
  usagePanelEl: HTMLElement;
  articleUnderstandingPanelEl: HTMLElement;
}

export interface CodexHeaderCallbacks {
  onToggleArticlePanel: () => void;
  onOpenHistory: () => void;
  onRefreshRateLimits: () => Promise<void>;
  onOpenWorkspaceResources: () => void;
  onOpenSettings: () => void;
}

export interface ArticleUnderstandingPanelCallbacks {
  onRefresh: () => void;
  onClear: (filePath: string) => void;
  onOpenSettings: () => void;
}

export function renderCodexHeader(rootEl: HTMLElement, callbacks: CodexHeaderCallbacks): CodexHeaderRefs {
  const header = rootEl.createDiv({ cls: "codex-header" });
  const title = header.createDiv({ cls: "codex-title" });
  const icon = title.createSpan({ cls: "codex-title-icon codex-title-icon-codex", attr: { "aria-hidden": "true" } });
  setIcon(icon, "bot");
  title.createSpan({ cls: "codex-title-text", text: "EchoInk" });

  const headerActions = header.createDiv({ cls: "codex-header-actions" });
  const editorActionStatusEl = headerActions.createDiv({
    cls: "codex-status-chip codex-editor-action-status is-idle",
    attr: { role: "button", tabindex: "0", "aria-label": "写作上下文" }
  });
  const editorActionIcon = editorActionStatusEl.createSpan({ cls: "codex-header-status-icon" });
  setIcon(editorActionIcon, "wand-sparkles");
  const editorActionStatusTextEl = editorActionStatusEl.createSpan({ cls: "codex-header-status-text", text: "写作" });
  editorActionStatusEl.onclick = (event) => {
    event.stopPropagation();
    callbacks.onToggleArticlePanel();
  };
  editorActionStatusEl.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    callbacks.onToggleArticlePanel();
  };

  const headerHistoryEl = headerActions.createEl("button", {
    cls: "codex-status-chip codex-header-history is-hidden",
    attr: { type: "button", title: "查看知识库历史", "aria-label": "查看知识库历史" }
  });
  const historyIcon = headerHistoryEl.createSpan({ cls: "codex-header-status-icon" });
  setIcon(historyIcon, "history");
  headerHistoryEl.createSpan({ cls: "codex-header-status-text", text: "历史" });
  headerHistoryEl.onclick = (event) => {
    event.stopPropagation();
    callbacks.onOpenHistory();
  };

  const headerStatusEl = headerActions.createDiv({ cls: "codex-header-status codex-status-chip" });
  const statusIcon = headerStatusEl.createSpan({ cls: "codex-header-status-icon" });
  setIcon(statusIcon, "activity");
  const headerStatusTextEl = headerStatusEl.createSpan({ cls: "codex-header-status-text", text: "连接中" });

  const headerUsageEl = headerActions.createEl("button", {
    cls: "codex-status-chip codex-usage-chip",
    attr: { type: "button", "aria-label": "Codex 用量", title: "Codex 用量" }
  });
  const usageIcon = headerUsageEl.createSpan({ cls: "codex-header-status-icon" });
  setIcon(usageIcon, "gauge");
  const headerUsageTextEl = headerUsageEl.createSpan({ cls: "codex-header-status-text", text: "用量 --" });

  const resourceButton = headerActions.createEl("button", {
    cls: "codex-icon-button codex-resource-button",
    attr: { type: "button", "aria-label": "插件 MCP Skills 管理", title: "插件 / MCP / Skills 管理" }
  });
  setIcon(resourceButton, "blocks");
  resourceButton.onclick = callbacks.onOpenWorkspaceResources;

  const settingsButton = headerActions.createEl("button", {
    cls: "codex-icon-button codex-settings-button",
    attr: { type: "button", "aria-label": "打开插件设置", title: "打开插件设置" }
  });
  renderSettingsGearIcon(settingsButton);
  settingsButton.onclick = callbacks.onOpenSettings;

  const usagePanelEl = header.createDiv({ cls: "codex-usage-panel" });
  headerUsageEl.onclick = async (event) => {
    event.stopPropagation();
    const willShow = !usagePanelEl.hasClass("is-visible");
    usagePanelEl.toggleClass("is-visible", willShow);
    if (willShow) await callbacks.onRefreshRateLimits();
  };
  const articleUnderstandingPanelEl = header.createDiv({ cls: "codex-article-panel" });

  return {
    headerStatusEl,
    headerStatusTextEl,
    editorActionStatusEl,
    editorActionStatusTextEl,
    headerHistoryEl,
    headerUsageEl,
    headerUsageTextEl,
    usagePanelEl,
    articleUnderstandingPanelEl
  };
}

export function renderHeaderHistoryButton(button: HTMLButtonElement, visible: boolean): void {
  button.toggleClass("is-hidden", !visible);
  button.setAttr("aria-hidden", visible ? "false" : "true");
}

export function renderEditorActionStatusView(
  statusEl: HTMLElement,
  textEl: HTMLElement,
  status: EditorActionStatusView,
  enabled: boolean
): void {
  statusEl.toggleClass("is-hidden", !enabled);
  statusEl.toggleClass("is-idle", status.status === "idle");
  statusEl.toggleClass("is-active", status.status === "preparing" || status.status === "connecting" || status.status === "generating");
  statusEl.toggleClass("is-loading", status.status === "preparing" || status.status === "connecting" || status.status === "generating");
  statusEl.toggleClass("is-ok", status.status === "awaiting-confirm" || status.status === "confirmed");
  statusEl.toggleClass("has-warning", status.status === "failed" || status.status === "canceled");
  textEl.setText(editorActionStatusLabel(status));
  statusEl.setAttr("title", status.error || status.message || "编辑区 AI 写作状态");
}

export function renderArticleUnderstandingPanelView(
  panelEl: HTMLElement,
  input: {
    app: App;
    component: Component;
    visible: boolean;
    settings: EditorAiActionSettings;
    state: ArticleUnderstandingPanelState;
  },
  callbacks: ArticleUnderstandingPanelCallbacks
): void {
  const { settings, state } = input;
  panelEl.empty();
  panelEl.toggleClass("is-visible", input.visible && settings.showContextPanel);
  if (!input.visible || !settings.showContextPanel) return;

  const modeConfig = resolveEditorActionModeConfig(settings, state.mode ?? settings.qualityMode);
  const title = panelEl.createDiv({ cls: "codex-article-panel-title" });
  const titleIcon = title.createSpan({ cls: "codex-usage-panel-icon" });
  setIcon(titleIcon, "file-search");
  title.createSpan({ text: "写作上下文" });

  const meta = panelEl.createDiv({ cls: "codex-article-panel-meta" });
  addArticlePanelRow(meta, "文件", state.source?.fileName ?? "当前未选择笔记");
  addArticlePanelRow(meta, "模式", state.modeLabel ?? modeConfig.label);
  addArticlePanelRow(meta, "模型", state.model ?? modeConfig.model);
  addArticlePanelRow(meta, "状态", articleUnderstandingStatusLabel(state.status, state.error));
  addArticlePanelRow(meta, "更新时间", state.entry?.updatedAt ? formatRelativeTime(state.entry.updatedAt) : "无");
  addArticlePanelRow(meta, "本次使用", state.usedInLastRun ? "已使用文章理解" : "未使用文章理解");

  const body = panelEl.createDiv({ cls: "codex-article-panel-body" });
  if (state.entry?.understanding) {
    renderRichText(input.app, input.component, body, state.entry.understanding);
  } else if (state.mode === "fast" || settings.qualityMode === "fast") {
    body.createDiv({ cls: "codex-article-panel-empty", text: "快速模式写作时不使用文章理解；也可以手动刷新，先建立可见上下文。" });
  } else {
    body.createDiv({ cls: "codex-article-panel-empty", text: "还没有文章理解。点击刷新理解，或直接使用质量/严格写作触发。" });
  }

  const actions = panelEl.createDiv({ cls: "codex-article-panel-actions" });
  const refresh = actions.createEl("button", { cls: "codex-resource-refresh", text: "刷新理解", attr: { type: "button" } });
  refresh.disabled = state.status === "running";
  refresh.onclick = callbacks.onRefresh;
  const clear = actions.createEl("button", { cls: "codex-resource-tab", text: "清除理解", attr: { type: "button" } });
  clear.disabled = !state.source?.filePath && !state.entry?.filePath;
  clear.onclick = () => {
    const filePath = state.source?.filePath ?? state.entry?.filePath;
    if (!filePath) return;
    callbacks.onClear(filePath);
  };
  const settingsButton = actions.createEl("button", { cls: "codex-resource-tab", text: "打开设置", attr: { type: "button" } });
  settingsButton.onclick = callbacks.onOpenSettings;
}

export function updateUsageHeaderView(
  usageButton: HTMLButtonElement,
  usageTextEl: HTMLElement,
  rateLimits: RateLimitSnapshot | null,
  loading = false,
  error: string | null = null
): void {
  const usage = formatRateLimitUsage(rateLimits);
  usageTextEl.setText(loading && !rateLimits ? "读取中" : usage.summary);
  usageButton.setAttr("title", loading ? "正在读取 Codex 用量" : error && !rateLimits ? `读取失败：${error}` : usage.title);
  usageButton.toggleClass("is-loading", loading);
  usageButton.toggleClass("has-warning", Boolean(error && !rateLimits) || (!rateLimits && !loading));
  usageButton.toggleClass("is-ok", Boolean(rateLimits && !error && !loading));
}

export function renderUsagePanelView(container: HTMLElement, rateLimits: RateLimitSnapshot | null, error?: string | null, loading = false): void {
  const usage = formatRateLimitUsage(rateLimits);
  container.empty();
  const title = container.createDiv({ cls: "codex-usage-panel-title" });
  const icon = title.createSpan({ cls: "codex-usage-panel-icon" });
  setIcon(icon, "gauge");
  title.createSpan({ text: "剩余额度" });
  if (!usage.primary && !usage.secondary) {
    if (loading) {
      container.createDiv({ cls: "codex-usage-loading", text: "正在读取 Codex 用量..." });
      return;
    }
    if (error) {
      container.createDiv({ cls: "codex-usage-error", text: `读取失败：${error}` });
      return;
    }
    container.createDiv({ cls: "codex-usage-empty", text: "暂未读取到 Codex 用量。" });
    return;
  }
  if (usage.primary) renderUsageRow(container, usage.primary);
  if (usage.secondary) renderUsageRow(container, usage.secondary);
  if (loading) container.createDiv({ cls: "codex-usage-loading", text: "正在更新..." });
  if (error) container.createDiv({ cls: "codex-usage-error", text: `更新失败：${error}` });
}

function renderUsageRow(container: HTMLElement, item: RateLimitWindowView): void {
  const row = container.createDiv({ cls: "codex-usage-row" });
  row.createDiv({ cls: "codex-usage-label", text: item.label });
  row.createDiv({ cls: "codex-usage-percent", text: `${item.remainingPercent}%` });
  row.createDiv({ cls: "codex-usage-reset", text: item.resetLabel });
}

function addArticlePanelRow(container: HTMLElement, label: string, value: string): void {
  const row = container.createDiv({ cls: "codex-article-panel-row" });
  row.createSpan({ cls: "codex-article-panel-label", text: label });
  row.createSpan({ cls: "codex-article-panel-value", text: value });
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
