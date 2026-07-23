import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { ensureKnowledgeBaseSession, type AgentBackendMode, type ResourceManagementTab } from "../settings/settings";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "../home/home-view";
import { isReviewHtmlPath } from "../review/schedule";
import { ReviewPreviewView, VIEW_TYPE_REVIEW_PREVIEW } from "../review/preview-view";
import { CodexView, VIEW_TYPE_CODEX } from "../ui/codex-view";

export class EchoInkViewService {
  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async activateHomeAndSidebar(): Promise<void> {
    this.ensureHomeWorkspaceSpace({ keepRightSidebar: true });
    await this.activateView();
    await this.activateHomeView({ keepRightSidebar: true });
  }

  async activateHomeView(options: { keepRightSidebar?: boolean } = {}): Promise<void> {
    this.ensureHomeWorkspaceSpace(options);
    const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME);
    let leaf = leaves[0];
    if (!leaf) {
      leaf = this.plugin.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_ECHOINK_HOME, active: true });
    }
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
    await this.getHomeView()?.refresh();
  }

  async activateView(): Promise<void> {
    const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX);
    let leaf = leaves.find((candidate) => candidate.view instanceof CodexView) ?? leaves[0];
    if (!leaf) {
      const rightLeaf = this.plugin.app.workspace.getRightLeaf(false);
      if (!rightLeaf) throw new Error("无法创建 Codex 右侧栏");
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_CODEX, active: true });
    } else if (!(leaf.view instanceof CodexView)) {
      await leaf.setViewState({ type: "empty", active: false });
      await leaf.setViewState({ type: VIEW_TYPE_CODEX, active: true });
    }
    if (this.plugin.app.workspace.rightSplit.collapsed) this.plugin.app.workspace.rightSplit.expand();
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.getCodexView()?.focusInput();
  }

  async activateKnowledgeBaseChannel(): Promise<void> {
    const session = ensureKnowledgeBaseSession(this.plugin.settings, this.plugin.getVaultPath());
    this.plugin.settings.activeSessionId = session.id;
    await this.plugin.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    await this.activateView();
    this.getCodexView()?.refreshActiveSession();
  }

  applyComposerDefaultsToView(): void {
    this.getCodexView()?.applySavedComposerDefaults();
  }

  getCodexView(): CodexView | null {
    return this.getViewInstance(VIEW_TYPE_CODEX, CodexView);
  }

  refreshKnowledgeBaseSurfaces(): void {
    this.getCodexView()?.refreshKnowledgeBaseDashboard();
    const home = this.getHomeView();
    if (home) void home.refresh().catch((error) => console.warn("EchoInk 首页刷新失败", error));
  }

  async openWorkspaceResourceSettings(tab: ResourceManagementTab = "plugins"): Promise<void> {
    this.plugin.settings.settingsTab = "resources";
    this.plugin.settings.resourceManagementTab = tab;
    await this.plugin.saveSettings(true);
    const setting = (this.plugin.app as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    if (!setting?.open || !setting?.openTabById) {
      new Notice("无法打开插件设置页");
      return;
    }
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }

  async openCodexSetup(options: { autoRepair?: boolean } = {}): Promise<void> {
    return this.openAgentSetup({ backend: "codex-cli", ...options });
  }

  async openAgentSetup(options: { backend: AgentBackendMode; autoRepair?: boolean }): Promise<void> {
    this.plugin.settings.settingsTab = "general";
    this.plugin.agentSetupTarget = options.backend;
    this.plugin.agentSetupAutoRepair = options.autoRepair === true;
    if (options.autoRepair && options.backend === "codex-cli") {
      const status = await this.plugin.ensureCodexConnected(true, { silent: true, refreshLogin: true });
      if (status.connected && status.loggedIn) {
        this.plugin.agentSetupTarget = null;
        this.plugin.agentSetupAutoRepair = false;
        await this.plugin.saveSettings(true);
        new Notice(this.plugin.settings.settingsLanguage === "en" ? "Codex connected automatically. You can continue." : "Codex 已自动连接，可以继续使用。");
        return;
      }
    }
    await this.plugin.saveSettings(true);
    const setting = (this.plugin.app as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    if (!setting?.open || !setting?.openTabById) {
      this.plugin.agentSetupTarget = null;
      this.plugin.agentSetupAutoRepair = false;
      new Notice(this.plugin.settings.settingsLanguage === "en" ? "Unable to open plugin settings." : "无法打开插件设置页");
      return;
    }
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }

  async openReviewHtmlPreview(relativePath: string): Promise<void> {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!isReviewHtmlPath(normalized, this.plugin.settings.review.outputDir)) {
      new Notice("只能打开 EchoInk 生成的复盘 HTML");
      return;
    }
    let leaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW_PREVIEW)[0];
    if (!leaf) {
      const rightLeaf = this.plugin.app.workspace.getRightLeaf(false);
      if (!rightLeaf) throw new Error("无法创建复盘预览页");
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_REVIEW_PREVIEW, active: true });
    }
    if (this.plugin.app.workspace.rightSplit.collapsed) this.plugin.app.workspace.rightSplit.expand();
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
    await this.getReviewPreviewView()?.openHtml(normalized);
  }

  private ensureHomeWorkspaceSpace(options: { keepRightSidebar?: boolean } = {}): void {
    const { leftSplit, rightSplit } = this.plugin.app.workspace;
    if (options.keepRightSidebar) {
      if (!leftSplit.collapsed) leftSplit.collapse();
      return;
    }
    if (!rightSplit.collapsed) rightSplit.collapse();
  }

  private getHomeView(): EchoInkHomeView | null {
    return this.getViewInstance(VIEW_TYPE_ECHOINK_HOME, EchoInkHomeView);
  }

  private getReviewPreviewView(): ReviewPreviewView | null {
    return this.getViewInstance(VIEW_TYPE_REVIEW_PREVIEW, ReviewPreviewView);
  }

  private getViewInstance<T>(viewType: string, viewClass: { new (...args: any[]): T }): T | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(viewType)) {
      if (leaf.view instanceof viewClass) return leaf.view;
    }
    return null;
  }
}
