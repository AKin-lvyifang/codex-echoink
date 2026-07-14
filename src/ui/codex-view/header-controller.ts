import { Menu, Notice, type App, type Component } from "obsidian";
import { AGENT_BACKEND_DEFINITIONS, agentBackendDisplayName } from "../../agent/registry";
import type CodexForObsidianPlugin from "../../main";
import type { AgentBackendMode, StoredSession } from "../../settings/settings";
import type { EditorActionStatusView } from "../../editor-actions/types";
import {
  renderArticleUnderstandingPanelView,
  renderEditorActionStatusView,
  renderHeaderHistoryButton,
  type ArticleUnderstandingPanelState
} from "./header";

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
  promptEnhancerRunning: boolean;
  headerStatusEl: HTMLButtonElement;
  headerStatusTextEl: HTMLElement;
  editorActionStatusEl: HTMLElement;
  editorActionStatusTextEl: HTMLElement;
  headerHistoryEl: HTMLButtonElement;
  articleUnderstandingPanelEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
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
  applyStatus(): void;
  prewarmActiveThread(): void;
  clearEditorActionStatusTimers(): void;
}

export function updateInputPlaceholder(host: CodexHeaderHost): void {
  if (!host.inputEl) return;
  const session = host.ensureSession();
  host.inputEl.setAttr("placeholder", host.isKnowledgeBaseSession(session)
    ? "普通对话直接输入；查知识库用 /ask；管理用 /check /maintain"
    : session.cwd ? "问 Codex" : "选择工作区后开始对话");
  host.renderHeaderHistory();
}

export function renderHeaderHistory(host: CodexHeaderHost): void {
  if (!host.headerHistoryEl) return;
  const visible = host.isKnowledgeBaseSession(host.ensureSession());
  renderHeaderHistoryButton(host.headerHistoryEl, visible);
}

export function applyStatus(host: CodexHeaderHost): void {
  const backend = host.plugin.settings.agentBackend;
  const label = agentBackendDisplayName(backend);
  const blocked = host.running || host.promptEnhancerRunning;
  host.headerStatusTextEl.setText(label);
  host.headerStatusEl.disabled = blocked;
  host.headerStatusEl.toggleClass("is-active", blocked);
  host.headerStatusEl.setAttr("aria-label", blocked ? `当前 Agent：${label}，任务运行中` : `当前 Agent：${label}，点击切换`);
  host.headerStatusEl.setAttr("title", blocked ? `当前 Agent：${label}\n任务运行中，暂时不能切换` : `当前 Agent：${label}\n点击切换 Agent`);
  host.renderToolbar();
}

export function openAgentBackendMenu(host: CodexHeaderHost, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (host.running || host.promptEnhancerRunning) {
    new Notice("任务运行中，暂时不能切换 Agent");
    return;
  }
  const current = host.plugin.settings.agentBackend;
  const menu = new Menu();
  for (const definition of AGENT_BACKEND_DEFINITIONS) {
    menu.addItem((item) => item
      .setTitle(definition.label)
      .setIcon(agentBackendIcon(definition.kind))
      .setChecked(definition.kind === current)
      .onClick(() => void selectAgentBackend(host, definition.kind)));
  }
  menu.showAtMouseEvent(event);
}

export async function selectAgentBackend(host: CodexHeaderHost, backend: AgentBackendMode): Promise<boolean> {
  if (host.running || host.promptEnhancerRunning) return false;
  const settings = host.plugin.settings;
  if (settings.agentBackend === backend && settings.agents.defaultBackend === backend) return false;
  const previousBackend = settings.agentBackend;
  const previousDefaultBackend = settings.agents.defaultBackend;
  settings.agentBackend = backend;
  settings.agents.defaultBackend = backend;
  host.applyStatus();
  try {
    await host.plugin.saveSettings(true);
  } catch (error) {
    settings.agentBackend = previousBackend;
    settings.agents.defaultBackend = previousDefaultBackend;
    host.applyStatus();
    new Notice(`Agent 切换失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (backend === "codex-cli") host.prewarmActiveThread();
  return true;
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

export function openPluginSettings(host: CodexHeaderHost): void {
  const setting = (host.app as unknown as ObsidianSettingsApi).setting;
  if (!setting?.open || !setting?.openTabById) {
    new Notice("无法打开插件设置页");
    return;
  }
  setting.open();
  setting.openTabById(host.plugin.manifest.id);
}

function agentBackendIcon(backend: AgentBackendMode): string {
  if (backend === "opencode") return "code-2";
  if (backend === "hermes") return "sparkles";
  return "bot";
}
