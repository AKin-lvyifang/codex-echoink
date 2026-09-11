import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { ResourceManagementTab } from "../settings/settings";
import type { SettingsTab } from "../settings/settings";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "../home/home-view";
import { openObsidianGraphLeaf } from "../home/open-native-graph";
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
    // When the shared conversation view is parked in the quick-chat popout,
    // bring it back to the sidebar first so the sidebar stays the single
    // visible conversation surface.
    const quickChat = this.plugin.getQuickChatWindowController();
    if (quickChat?.isQuickWindowHoldingView()) {
      await quickChat.returnToSidebar();
    }
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

  async openObsidianGraph(): Promise<boolean> {
    return openObsidianGraphLeaf(this.plugin.app);
  }

  applyComposerDefaultsToView(): void {
    this.getCodexView()?.applySavedComposerDefaults();
  }

  getCodexView(): CodexView | null {
    return this.getViewInstance(VIEW_TYPE_CODEX, CodexView);
  }

  refreshKnowledgeBaseSurfaces(): void {
    this.getCodexView()?.refreshKnowledgeBaseDashboard();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME)) {
      if (leaf.view instanceof EchoInkHomeView) {
        void leaf.view.refresh().catch((error) => console.warn("EchoInk 首页刷新失败", error));
      }
    }
  }

  async refreshLanguageSurfaces(): Promise<void> {
    const refreshes: Promise<void>[] = [];
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX)) {
      if (leaf.view instanceof CodexView) leaf.view.refreshLanguage();
    }
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME)) {
      if (!(leaf.view instanceof EchoInkHomeView)) continue;
      refreshes.push(leaf.view.refreshLanguage().catch((error) => {
        console.warn("EchoInk 首页语言刷新失败", error);
      }));
    }
    await Promise.all(refreshes);
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

  async openEchoInkSettings(tab: SettingsTab): Promise<void> {
    this.plugin.settings.settingsTab = tab;
    await this.plugin.saveSettings(true);
    const setting = (this.plugin.app as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (!setting?.open || !setting?.openTabById) {
      new Notice("无法打开 EchoInk 设置页");
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
