import { Plugin } from "obsidian";
import type { CodexService } from "./core/codex-service";
import { closeMcpBrokerConnectionPool } from "./resources/mcp-broker";
import type { CallEchoInkMcpToolInput } from "./resources/mcp-broker-service";
import type { EchoInkResource } from "./resources/types";
import type { EditorActionController } from "./editor-actions/controller";
import type { KnowledgeBaseManager } from "./knowledge-base/manager";
import type {
  KnowledgeBaseHistoryIndex,
  KnowledgeBaseHistoryRemovalResult,
  KnowledgeBaseStorageStats
} from "./knowledge-base/history-store";
import type { ReviewManager } from "./review/manager";
import type { ChatMessage, CodexForObsidianSettings, ResourceManagementTab } from "./settings/settings";
import type { CodexNotification, CodexSkill, CodexStatusSnapshot } from "./types/app-server";
import type { CodexView } from "./ui/codex-view";
import { registerEchoInkPluginFeatures, registerEchoInkStartupTasks } from "./plugin/bootstrap";
import { EchoInkConnectionService } from "./plugin/connection-service";
import { EchoInkSettingsStore } from "./plugin/settings-store";
import { EchoInkViewService } from "./plugin/view-service";

export interface HermesConnectionTestResult {
  connected: boolean;
  providerConfigured: boolean;
  message: string;
  version: string;
}

export default class CodexForObsidianPlugin extends Plugin {
  settings!: CodexForObsidianSettings;
  codex: CodexService | null = null;
  lastStatus: CodexStatusSnapshot | null = null;
  private editorActions: EditorActionController | null = null;
  private knowledgeBase: KnowledgeBaseManager | null = null;
  private review: ReviewManager | null = null;
  private connectionService: EchoInkConnectionService | null = null;
  private settingsStore: EchoInkSettingsStore | null = null;
  private viewService: EchoInkViewService | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    const controllers = registerEchoInkPluginFeatures(this);
    this.editorActions = controllers.editorActions;
    this.knowledgeBase = controllers.knowledgeBase;
    this.review = controllers.review;
    registerEchoInkStartupTasks(this);
  }

  async onunload(): Promise<void> {
    this.editorActions?.cancelActiveCandidate("canceled", false);
    this.knowledgeBase?.unload();
    this.review?.unload();
    await this.saveSettings(true);
    await closeMcpBrokerConnectionPool();
    await this.codex?.disconnect();
  }

  async activateHomeAndSidebar(): Promise<void> { return this.getViewService().activateHomeAndSidebar(); }
  async activateHomeView(options: { keepRightSidebar?: boolean } = {}): Promise<void> { return this.getViewService().activateHomeView(options); }
  async activateView(): Promise<void> { return this.getViewService().activateView(); }
  async activateKnowledgeBaseChannel(): Promise<void> { return this.getViewService().activateKnowledgeBaseChannel(); }
  applyComposerDefaultsToView(): void { this.getViewService().applyComposerDefaultsToView(); }
  getCodexView(): CodexView | null { return this.getViewService().getCodexView(); }
  refreshKnowledgeBaseSurfaces(): void { this.getViewService().refreshKnowledgeBaseSurfaces(); }
  async openWorkspaceResourceSettings(tab: ResourceManagementTab = "plugins"): Promise<void> { return this.getViewService().openWorkspaceResourceSettings(tab); }
  async openReviewHtmlPreview(relativePath: string): Promise<void> { return this.getViewService().openReviewHtmlPreview(relativePath); }

  async ensureCodexConnected(force = false, options: { silent?: boolean; refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> {
    return this.getConnectionService().ensureCodexConnected(force, options);
  }
  async ensureSkillsLoaded(force = false): Promise<CodexSkill[]> { return this.getConnectionService().ensureSkillsLoaded(force); }
  async ensureEchoInkSkillResourcesLoaded(force = false): Promise<EchoInkResource[]> { return this.getConnectionService().ensureEchoInkSkillResourcesLoaded(force); }
  async reconnectCodex(options: { refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> { return this.getConnectionService().reconnectCodex(options); }
  async listEchoInkMcpTools(resourceId: string, timeoutMs = 30000): Promise<unknown[]> { return this.getConnectionService().listEchoInkMcpTools(resourceId, timeoutMs); }
  async callEchoInkMcpTool(input: CallEchoInkMcpToolInput): Promise<unknown> { return this.getConnectionService().callEchoInkMcpTool(input); }
  async testHermesConnection(options: { notify?: boolean } = {}): Promise<HermesConnectionTestResult> { return this.getConnectionService().testHermesConnection(options); }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter as { basePath?: string; path?: string };
    return adapter.basePath || adapter.path || "";
  }

  getPluginDataDirName(): string {
    const dir = (this.manifest as { dir?: unknown }).dir;
    return typeof dir === "string" && dir.trim() ? dir : this.manifest.id;
  }

  async loadSettings(): Promise<void> { return this.getSettingsStore().loadSettings(); }
  async saveSettings(force = false, options: { flushKnowledgeBaseHistory?: boolean } = {}): Promise<void> { return this.getSettingsStore().saveSettings(force, options); }
  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> { return this.getSettingsStore().externalizeMessageText(message, fullText); }
  async readRawMessageText(rawRef: string): Promise<string> { return this.getSettingsStore().readRawMessageText(rawRef); }
  async readKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> { return this.getSettingsStore().readKnowledgeBaseHistoryIndex(); }
  async readKnowledgeBaseHistoryDay(sessionId: string, date: string): Promise<ChatMessage[]> { return this.getSettingsStore().readKnowledgeBaseHistoryDay(sessionId, date); }
  async rebuildKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> { return this.getSettingsStore().rebuildKnowledgeBaseHistoryIndex(); }
  async getKnowledgeBaseStorageStats(): Promise<KnowledgeBaseStorageStats> { return this.getSettingsStore().getKnowledgeBaseStorageStats(); }
  async exportKnowledgeBaseHistory(): Promise<string> { return this.getSettingsStore().exportKnowledgeBaseHistory(); }
  async compactOldKnowledgeBaseProcessHistory(): Promise<number> { return this.getSettingsStore().compactOldKnowledgeBaseProcessHistory(); }
  async removeKnowledgeBaseHistory(): Promise<KnowledgeBaseHistoryRemovalResult> { return this.getSettingsStore().removeKnowledgeBaseHistory(); }
  async removeKnowledgeBaseHistoryDays(dates: string[]): Promise<KnowledgeBaseHistoryRemovalResult> { return this.getSettingsStore().removeKnowledgeBaseHistoryDays(dates); }
  async pruneKnowledgeBaseHistoryByRetention(): Promise<KnowledgeBaseHistoryRemovalResult> { return this.getSettingsStore().pruneKnowledgeBaseHistoryByRetention(); }
  async runDeferredStartupMaintenance(): Promise<void> { return this.getSettingsStore().runDeferredStartupMaintenance(); }

  async archivePendingKnowledgeBaseThreads(): Promise<number> {
    return this.knowledgeBase ? this.knowledgeBase.archivePendingCodexKnowledgeThreads() : 0;
  }
  getKnowledgeBaseManager(): KnowledgeBaseManager | null { return this.knowledgeBase; }
  getReviewManager(): ReviewManager | null { return this.review; }
  getEditorActions(): EditorActionController | null { return this.editorActions; }

  private handleCodexNotification(notification: CodexNotification): void {
    if (this.knowledgeBase?.handleCodexNotification(notification)) {
      this.getCodexView()?.handleKnowledgeBaseCodexNotification(notification);
      return;
    }
    this.getCodexView()?.handleCodexNotification(notification);
  }

  private getConnectionService(): EchoInkConnectionService {
    if (!this.connectionService) this.connectionService = new EchoInkConnectionService(this, (notification) => this.handleCodexNotification(notification));
    return this.connectionService;
  }

  private getSettingsStore(): EchoInkSettingsStore {
    if (!this.settingsStore) this.settingsStore = new EchoInkSettingsStore(this);
    return this.settingsStore;
  }

  private getViewService(): EchoInkViewService {
    if (!this.viewService) this.viewService = new EchoInkViewService(this);
    return this.viewService;
  }
}
