import { Notice, type App, type Component } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { providerConnectionLabel, type StoredSession } from "../../settings/settings";
import type { RateLimitSnapshot } from "../../types/app-server";
import type { EditorActionStatusView } from "../../editor-actions/types";
import {
  renderArticleUnderstandingPanelView,
  renderEditorActionStatusView,
  renderHeaderHistoryButton,
  renderUsagePanelView,
  updateUsageHeaderView,
  type ArticleUnderstandingPanelState
} from "./header";
import { workspaceDisplayName } from "./workspace-utils";

type ObsidianSettingsApi = {
  setting?: {
    open?: () => void;
    openTabById?: (id: string) => void;
  };
};

export interface CodexHeaderHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  headerStatusEl: HTMLElement;
  headerStatusTextEl: HTMLElement;
  editorActionStatusEl: HTMLElement;
  editorActionStatusTextEl: HTMLElement;
  headerHistoryEl: HTMLButtonElement;
  articleUnderstandingPanelEl: HTMLElement;
  headerUsageEl: HTMLButtonElement;
  headerUsageTextEl: HTMLElement;
  usagePanelEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  usageLoading: boolean;
  usageError: string | null;
  usageRequestId: number;
  editorActionStatus: EditorActionStatusView;
  editorActionStatusTicker: number | null;
  editorActionStatusResetTimer: number | null;
  articleUnderstandingPanelVisible: boolean;
  articleUnderstandingPanelState: ArticleUnderstandingPanelState;
  ensureSession(): StoredSession;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  renderHeaderHistory(): void;
  renderToolbar(): void;
  renderArticleUnderstandingPanel(): void;
  renderEditorActionStatus(): void;
  refreshArticleUnderstandingFromPanel(): Promise<void>;
  openPluginSettings(): void;
  clearEditorActionStatusTimers(): void;
}

export function updateInputPlaceholder(host: CodexHeaderHost): void {
  if (!host.inputEl) return;
  const session = host.ensureSession();
  host.inputEl.setAttr("placeholder", host.isKnowledgeBaseSession(session)
    ? "普通对话直接输入；查知识库用 /ask；管理用 /check /maintain"
    : session.cwd ? `问 Codex，当前工作区：${workspaceDisplayName(session.cwd)}` : "先选择工作区，再问 Codex");
  host.renderHeaderHistory();
}

export function renderHeaderHistory(host: CodexHeaderHost): void {
  if (!host.headerHistoryEl) return;
  const visible = host.isKnowledgeBaseSession(host.ensureSession());
  renderHeaderHistoryButton(host.headerHistoryEl, visible);
}

export function applyStatus(host: CodexHeaderHost): void {
  const status = host.plugin.lastStatus;
  host.headerStatusTextEl.setText(host.running ? "思考中" : status?.connected ? "活跃" : "未连接");
  host.headerStatusEl.toggleClass("has-warning", Boolean(status?.errors?.length) || !status?.connected);
  host.headerStatusEl.toggleClass("is-ok", Boolean(status?.connected && !status?.errors?.length));
  host.headerStatusEl.toggleClass("is-active", host.running);
  const providerLabel = providerConnectionLabel(host.plugin.settings);
  host.headerStatusEl.setAttr("title", status?.errors?.length ? status.errors.join("\n") : `${status?.accountLabel ?? "未连接"}\n${providerLabel}`);
  updateUsageHeader(host, status?.rateLimits ?? null, host.usageLoading, host.usageError);
  renderUsagePanel(host, status?.rateLimits ?? null, host.usageError, host.usageLoading);
  host.renderToolbar();
}

export function setEditorActionStatus(host: CodexHeaderHost, status: EditorActionStatusView): void {
  host.editorActionStatus = {
    ...status,
    startedAt: status.startedAt ?? host.editorActionStatus.startedAt ?? Date.now()
  };
  host.clearEditorActionStatusTimers();
  if (status.status === "generating") {
    host.editorActionStatusTicker = window.setInterval(() => host.renderEditorActionStatus(), 1000);
  }
  if (status.status === "confirmed" || status.status === "canceled" || status.status === "failed") {
    host.editorActionStatusResetTimer = window.setTimeout(() => {
      host.editorActionStatus = {
        status: "idle",
        understandingStatus: host.articleUnderstandingPanelState.status === "fresh" || host.articleUnderstandingPanelState.status === "reused" || host.articleUnderstandingPanelState.status === "stale"
          ? host.articleUnderstandingPanelState.status
          : undefined
      };
      host.renderEditorActionStatus();
    }, 2200);
  }
  host.renderEditorActionStatus();
}

export function renderEditorActionStatus(host: CodexHeaderHost): void {
  if (!host.editorActionStatusEl || !host.editorActionStatusTextEl) return;
  renderEditorActionStatusView(host.editorActionStatusEl, host.editorActionStatusTextEl, host.editorActionStatus, host.plugin.settings.editorActions.statusSlotEnabled);
  host.renderArticleUnderstandingPanel();
}

export function renderArticleUnderstandingPanel(host: CodexHeaderHost): void {
  if (!host.articleUnderstandingPanelEl) return;
  const settings = host.plugin.settings.editorActions;
  renderArticleUnderstandingPanelView(
    host.articleUnderstandingPanelEl,
    {
      app: host.plugin.app,
      component: host as unknown as Component,
      visible: host.articleUnderstandingPanelVisible,
      settings,
      state: host.articleUnderstandingPanelState
    },
    {
      onRefresh: () => void host.refreshArticleUnderstandingFromPanel(),
      onClear: (filePath) => {
        delete host.plugin.settings.editorActions.articleUnderstandingCache[filePath];
        host.articleUnderstandingPanelState = {
          ...host.articleUnderstandingPanelState,
          status: settings.qualityMode === "fast" ? "idle" : "missing",
          entry: null,
          usedInLastRun: false
        };
        void host.plugin.saveSettings().then(() => host.renderEditorActionStatus());
      },
      onOpenSettings: () => {
        host.plugin.settings.settingsTab = "editorActions";
        void host.plugin.saveSettings().then(() => host.openPluginSettings());
      }
    }
  );
}

export function clearEditorActionStatusTimers(host: CodexHeaderHost): void {
  if (host.editorActionStatusTicker) {
    window.clearInterval(host.editorActionStatusTicker);
    host.editorActionStatusTicker = null;
  }
  if (host.editorActionStatusResetTimer) {
    window.clearTimeout(host.editorActionStatusResetTimer);
    host.editorActionStatusResetTimer = null;
  }
}

export async function refreshHeaderRateLimits(host: CodexHeaderHost): Promise<void> {
  const requestId = ++host.usageRequestId;
  const cachedRateLimits = host.plugin.lastStatus?.rateLimits ?? null;
  host.usageLoading = true;
  host.usageError = null;
  updateUsageHeader(host, cachedRateLimits, true, null);
  renderUsagePanel(host, cachedRateLimits, null, true);

  const status = await host.plugin.ensureCodexConnected();
  if (requestId !== host.usageRequestId) return;
  if (!status.connected || !host.plugin.codex) {
    host.usageLoading = false;
    host.usageError = "Codex 未连接";
    updateUsageHeader(host, null, false, host.usageError);
    renderUsagePanel(host, null, host.usageError, false);
    return;
  }
  const result = await host.plugin.codex.refreshRateLimits();
  if (requestId !== host.usageRequestId) return;
  const nextRateLimits = result.rateLimits ?? host.plugin.lastStatus?.rateLimits ?? null;
  const nextRateLimitsByLimitId = result.rateLimitsByLimitId ?? host.plugin.lastStatus?.rateLimitsByLimitId ?? null;
  if (host.plugin.lastStatus) {
    host.plugin.lastStatus = {
      ...host.plugin.lastStatus,
      rateLimits: nextRateLimits,
      rateLimitsByLimitId: nextRateLimitsByLimitId
    };
  }
  host.usageLoading = false;
  host.usageError = result.error;
  updateUsageHeader(host, nextRateLimits, false, result.error);
  renderUsagePanel(host, nextRateLimits, result.error, false);
}

export function updateUsageHeader(host: CodexHeaderHost, rateLimits: RateLimitSnapshot | null, loading = false, error: string | null = null): void {
  if (!host.headerUsageTextEl) return;
  updateUsageHeaderView(host.headerUsageEl, host.headerUsageTextEl, rateLimits, loading, error);
}

export function renderUsagePanel(host: CodexHeaderHost, rateLimits: RateLimitSnapshot | null, error?: string | null, loading = false): void {
  if (!host.usagePanelEl) return;
  renderUsagePanelView(host.usagePanelEl, rateLimits, error, loading);
}

export function openPluginSettings(host: CodexHeaderHost): void {
  const setting = (host.app as unknown as ObsidianSettingsApi).setting;
  if (!setting?.open || !setting?.openTabById) {
    new Notice("无法打开插件设置页");
    return;
  }
  setting.open();
  setting.openTabById(host.plugin.manifest.id);
}
