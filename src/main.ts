import * as fsp from "fs/promises";
import * as path from "path";
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CodexService } from "./core/codex-service";
import { diagnoseCodexError } from "./core/codex-diagnostics";
import { swallowError } from "./core/error-handling";
import { HermesBackend } from "./core/hermes-backend";
import { isSyntheticHermesDefaultModel } from "./core/hermes-models";
import { externalizeLargeMessages, prepareRawMessage, readRawText, writeRawText } from "./core/raw-message-store";
import { CodexServerRequestRouter } from "./core/server-request-router";
import { clearLegacyChatWorkspaceDefaults, ensureKnowledgeBaseSession, getActiveApiProvider, normalizeSettingsData, providerConnectionLabel, type ChatMessage, type CodexForObsidianSettings, type ResourceManagementTab } from "./settings/settings";
import { buildEchoInkResourceCatalog, skillResourcesForScope } from "./resources/registry";
import { closeMcpBrokerConnectionPool, EchoInkMcpBroker } from "./resources/mcp-broker";
import { resolveMcpConnectionConfig } from "./resources/mcp-connections";
import type { EchoInkMcpConnectionRecord, EchoInkResource, EchoInkResourceScope } from "./resources/types";
import { CodexSettingTab } from "./settings/settings-tab";
import { confirmModal, requestUserInputModal } from "./ui/modals";
import { CodexView, VIEW_TYPE_CODEX } from "./ui/codex-view";
import type { CodexNotification, CodexSkill, CodexStatusSnapshot } from "./types/app-server";
import { EditorActionController } from "./editor-actions/controller";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "./home/home-view";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "./knowledge-base/constants";
import {
  collectKnowledgeBaseStorageStats,
  compactOldKnowledgeBaseProcessHistory,
  exportKnowledgeBaseHistory,
  migrateKnowledgeBaseHistory,
  persistAndCompactKnowledgeBaseHistory,
  pruneKnowledgeBaseHistoryByRetention,
  readKnowledgeBaseHistoryDay,
  readKnowledgeBaseHistoryIndex,
  rebuildKnowledgeBaseHistoryIndex,
  removeKnowledgeBaseHistory,
  removeKnowledgeBaseHistoryDays,
  type KnowledgeBaseHistoryIndex,
  type KnowledgeBaseHistoryRemovalResult,
  type KnowledgeBaseStorageStats
} from "./knowledge-base/history-store";
import { KnowledgeBaseManager } from "./knowledge-base/manager";
import { readKnowledgeBaseReportExcerpt, shouldRecoverKnowledgeBaseLintFailure } from "./knowledge-base/report";
import { ReviewManager } from "./review/manager";
import { ReviewPreviewView, VIEW_TYPE_REVIEW_PREVIEW } from "./review/preview-view";
import { isReviewHtmlPath } from "./review/schedule";

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
  private skillsLoadPromise: Promise<CodexSkill[]> | null = null;
  private echoInkSkillLoadPromise: Promise<EchoInkResource[]> | null = null;
  private connectPromise: Promise<CodexStatusSnapshot> | null = null;
  private serverRequestRouter: CodexServerRequestRouter | null = null;
  private startupMaintenancePromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private rawWrites = new Set<Promise<void>>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CODEX, (leaf: WorkspaceLeaf) => new CodexView(leaf, this));
    this.registerView(VIEW_TYPE_ECHOINK_HOME, (leaf: WorkspaceLeaf) => new EchoInkHomeView(leaf, this));
    this.registerView(VIEW_TYPE_REVIEW_PREVIEW, (leaf: WorkspaceLeaf) => new ReviewPreviewView(leaf, this));

    this.addRibbonIcon("bot", "打开 EchoInk 首页和 Agent 侧栏", () => {
      void this.activateHomeAndSidebar();
    });

    this.addCommand({
      id: "open-echoink-home",
      name: "打开 EchoInk 首页",
      callback: () => void this.activateHomeView()
    });

    this.addCommand({
      id: "open-codex-sidebar",
      name: "打开 EchoInk Agent 侧栏",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "new-codex-chat",
      name: "新建 Agent 会话",
      callback: async () => {
        await this.activateView();
        new Notice("已打开 EchoInk Agent，可点击 + 新建会话");
      }
    });

    this.addCommand({
      id: "test-hermes-connection",
      name: "Agent：检测 Hermes 后端",
      callback: () => void this.testHermesConnection()
    });

    this.addCommand({
      id: "editor-action-rewrite",
      name: "改写选中文字",
      editorCallback: (editor, view) => void this.editorActions?.runEditorActionById(editor, view, "rewrite")
    });

    this.addCommand({
      id: "editor-action-expand",
      name: "扩写选中文字",
      editorCallback: (editor, view) => void this.editorActions?.runEditorActionById(editor, view, "expand")
    });

    this.addCommand({
      id: "editor-action-continue",
      name: "续写选中文字",
      editorCallback: (editor, view) => void this.editorActions?.runEditorActionById(editor, view, "continue")
    });

    this.addCommand({
      id: "editor-action-translate",
      name: "翻译选中文字为英文",
      editorCallback: (editor, view) => void this.editorActions?.runEditorActionById(editor, view, "translate")
    });

    this.addSettingTab(new CodexSettingTab(this));
    this.editorActions = new EditorActionController(this);
    this.editorActions.register();
    this.knowledgeBase = new KnowledgeBaseManager(this);
    this.knowledgeBase.register();
    this.review = new ReviewManager(this);
    this.review.register();

    if (this.settings.autoOpen) {
      this.app.workspace.onLayoutReady(() => void this.activateView());
    }
    if (this.settings.autoOpenHome) {
      this.app.workspace.onLayoutReady(() => void this.activateHomeView());
    }
    if (this.settings.editorActions.enabled) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => void this.ensureCodexConnected(false, { silent: true }), 800);
      });
    }
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => void this.runDeferredStartupMaintenance(), 1200);
    });
  }

  async onunload(): Promise<void> {
    this.editorActions?.cancelActiveCandidate("canceled", false);
    this.knowledgeBase?.unload();
    this.review?.unload();
    await this.saveSettings(true);
    await closeMcpBrokerConnectionPool();
    await this.codex?.disconnect();
  }

  async activateHomeAndSidebar(): Promise<void> {
    this.ensureHomeWorkspaceSpace({ keepRightSidebar: true });
    await this.activateView();
    await this.activateHomeView({ keepRightSidebar: true });
  }

  async activateHomeView(options: { keepRightSidebar?: boolean } = {}): Promise<void> {
    this.ensureHomeWorkspaceSpace(options);
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME);
    let leaf = leaves[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_ECHOINK_HOME, active: true });
    }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    await this.getHomeView()?.refresh();
  }

  private ensureHomeWorkspaceSpace(options: { keepRightSidebar?: boolean } = {}): void {
    const { leftSplit, rightSplit } = this.app.workspace;
    if (options.keepRightSidebar) {
      if (!leftSplit.collapsed) leftSplit.collapse();
      return;
    }
    if (!rightSplit.collapsed) rightSplit.collapse();
  }

  async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX);
    let leaf = leaves[0];
    if (!leaf) {
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) throw new Error("无法创建 Codex 右侧栏");
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_CODEX, active: true });
    }
    if (this.app.workspace.rightSplit.collapsed) this.app.workspace.rightSplit.expand();
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.getCodexView()?.focusInput();
  }

  async activateKnowledgeBaseChannel(): Promise<void> {
    const session = ensureKnowledgeBaseSession(this.settings, this.getVaultPath());
    this.settings.activeSessionId = session.id;
    await this.saveSettings(true);
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
    this.settings.settingsTab = "resources";
    this.settings.resourceManagementTab = tab;
    await this.saveSettings(true);
    const setting = (this.app as any).setting;
    if (!setting?.open || !setting?.openTabById) {
      new Notice("无法打开插件设置页");
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  async ensureCodexConnected(force = false, options: { silent?: boolean; refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> {
    if (this.codex?.isConnected() && !force && this.lastStatus?.connected) return this.lastStatus;
    if (this.connectPromise && !force) return this.connectPromise;
    if (force) {
      this.connectPromise = null;
      await this.codex?.disconnect();
      this.codex = null;
    }
    if (!this.codex || force) {
      this.codex = new CodexService({
        cliPath: this.settings.cliPath,
        proxyEnabled: this.settings.proxyEnabled,
        proxyUrl: this.settings.proxyUrl,
        providerMode: this.settings.providerMode,
        activeApiProvider: getActiveApiProvider(this.settings),
        vaultPath: this.getVaultPath(),
        onNotification: (notification) => this.handleCodexNotification(notification),
        onServerRequest: (request) => this.getServerRequestRouter().handle(request)
      });
    }
    this.connectPromise = (async () => {
      try {
        const previousStatus = this.lastStatus;
        const nextStatus = await this.codex!.connect(force, { refreshLogin: options.refreshLogin === true });
        this.lastStatus = {
          ...nextStatus,
          rateLimits: nextStatus.rateLimits ?? previousStatus?.rateLimits ?? null,
          rateLimitsByLimitId: nextStatus.rateLimitsByLimitId ?? previousStatus?.rateLimitsByLimitId ?? null
        };
        if (this.lastStatus.connected) void this.archivePendingKnowledgeBaseThreads();
      } catch (error) {
        const diagnostic = diagnoseCodexError(error, {
          model: this.settings.defaultModel,
          providerLabel: providerConnectionLabel(this.settings, this.settings.settingsLanguage),
          proxyEnabled: this.settings.proxyEnabled,
          proxyUrl: this.settings.proxyUrl,
          language: this.settings.settingsLanguage
        });
        this.lastStatus = {
          connected: false,
          accountLabel: this.settings.settingsLanguage === "en" ? "Disconnected" : "未连接",
          loggedIn: false,
          models: [],
          skills: [],
          mcpServers: [],
          rateLimits: null,
          rateLimitsByLimitId: null,
          errors: [diagnostic.text]
        };
        if (!options.silent) {
          new Notice(this.settings.settingsLanguage === "en" ? `Codex failed: ${diagnostic.title}` : `Codex 连接失败：${diagnostic.title}`);
        }
      }
      return this.lastStatus!;
    })().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async ensureSkillsLoaded(force = false): Promise<CodexSkill[]> {
    if (!force && this.lastStatus?.skills.length) return this.lastStatus.skills;
    if (!this.skillsLoadPromise) {
      this.skillsLoadPromise = this.loadSkills(force).finally(() => {
        this.skillsLoadPromise = null;
      });
    }
    return this.skillsLoadPromise;
  }

  async ensureEchoInkSkillResourcesLoaded(force = false): Promise<EchoInkResource[]> {
    const currentCatalog = buildEchoInkResourceCatalog({ settings: this.settings.resources });
    const currentSkills = skillResourcesForScope(currentCatalog, "chat", this.settings.resources.enabledByScope);
    if (!force && currentSkills.length) return currentSkills;
    if (!this.echoInkSkillLoadPromise) {
      this.echoInkSkillLoadPromise = this.loadEchoInkSkillResources(force).finally(() => {
        this.echoInkSkillLoadPromise = null;
      });
    }
    return this.echoInkSkillLoadPromise;
  }

  async reconnectCodex(options: { refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> {
    this.connectPromise = null;
    await this.codex?.disconnect();
    this.codex = null;
    return this.ensureCodexConnected(true, { refreshLogin: options.refreshLogin === true });
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter as any;
    return adapter.basePath || adapter.path || "";
  }

  getPluginDataDirName(): string {
    const dir = (this.manifest as any).dir;
    return typeof dir === "string" && dir.trim() ? dir : this.manifest.id;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    const previousVersion = typeof data?.settingsVersion === "number" ? data.settingsVersion : 0;
    const normalized = normalizeSettingsData(data);
    this.settings = normalized.settings;
    const sessionCountBefore = this.settings.sessions.length;
    const knowledgeSessionBefore = this.settings.knowledgeBase.sessionId;
    const knowledgeRulesMigrated = await this.applyKnowledgeBaseRulesFileDefault(data);
    ensureKnowledgeBaseSession(this.settings, this.getVaultPath());
    const legacyChatWorkspacesCleared = clearLegacyChatWorkspaceDefaults(this.settings, this.getVaultPath(), previousVersion);
    const knowledgeStatusRecovered = await this.recoverKnowledgeBaseLintStatus();
    const knowledgeSessionChanged = sessionCountBefore !== this.settings.sessions.length || knowledgeSessionBefore !== this.settings.knowledgeBase.sessionId;
    if (normalized.changed || legacyChatWorkspacesCleared > 0 || knowledgeSessionChanged || knowledgeStatusRecovered || knowledgeRulesMigrated) {
      await this.saveSettings(true, { flushKnowledgeBaseHistory: false });
    }
  }

  private async applyKnowledgeBaseRulesFileDefault(data: any): Promise<boolean> {
    const rawSettings = data?.knowledgeBase;
    const hasExplicitRules = rawSettings
      && (typeof rawSettings.useCustomRulesFile === "boolean" || typeof rawSettings.rulesFilePath === "string");
    if (hasExplicitRules) return false;

    const vaultPath = this.getVaultPath();
    const agentsPath = path.join(vaultPath, AGENTS_RULES_FILE);
    const llmWikiPath = path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE);
    const [agents, llmWiki] = await Promise.all([
      fsp.readFile(agentsPath, "utf8").catch(() => ""),
      fsp.readFile(llmWikiPath, "utf8").catch(() => "")
    ]);
    if (!agents || !llmWiki) return false;
    const agentsLooksLikeCodexMemory = /codex-memory|CODEX-MEMORY|项目级上下文管理/.test(agents);
    const llmWikiLooksLikeKnowledgeRules = /知识库|Raw Sources|Ingest|Lint|Wiki/.test(llmWiki);
    if (!agentsLooksLikeCodexMemory || !llmWikiLooksLikeKnowledgeRules) return false;

    this.settings.knowledgeBase.useCustomRulesFile = true;
    this.settings.knowledgeBase.rulesFilePath = DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
    return true;
  }

  async saveSettings(force = false, options: { flushKnowledgeBaseHistory?: boolean } = {}): Promise<void> {
    if (force) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.flushSettingsSave(options);
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSettingsSave().catch(swallowError("scheduled settings save failed"));
    }, 750);
  }

  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> {
    const write = prepareRawMessage(message, fullText);
    if (!write) return;
    let tracked: Promise<void>;
    tracked = writeRawText(this.getVaultPath(), write.rawRef, write.text, this.getPluginDataDirName())
      .catch((error) => {
        console.error("Codex raw message write failed", error);
        if (message.rawRef === write.rawRef) {
          message.text = fullText;
          delete message.previewText;
          delete message.rawRef;
          delete message.rawSize;
          delete message.rawLines;
          delete message.rawTruncatedForPreview;
        }
      })
      .finally(() => this.rawWrites.delete(tracked));
    this.rawWrites.add(tracked);
    await tracked;
  }

  async readRawMessageText(rawRef: string): Promise<string> {
    return readRawText(this.getVaultPath(), rawRef, this.getPluginDataDirName());
  }

  async readKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> {
    return readKnowledgeBaseHistoryIndex(this.getVaultPath(), this.getPluginDataDirName());
  }

  async readKnowledgeBaseHistoryDay(sessionId: string, date: string): Promise<ChatMessage[]> {
    return readKnowledgeBaseHistoryDay(this.getVaultPath(), this.getPluginDataDirName(), sessionId, date);
  }

  async rebuildKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> {
    return rebuildKnowledgeBaseHistoryIndex(this.getVaultPath(), this.getPluginDataDirName());
  }

  async getKnowledgeBaseStorageStats(): Promise<KnowledgeBaseStorageStats> {
    return collectKnowledgeBaseStorageStats(this.getVaultPath(), this.getPluginDataDirName());
  }

  async exportKnowledgeBaseHistory(): Promise<string> {
    return exportKnowledgeBaseHistory(this.getVaultPath(), this.getPluginDataDirName());
  }

  async compactOldKnowledgeBaseProcessHistory(): Promise<number> {
    return compactOldKnowledgeBaseProcessHistory(this.getVaultPath(), this.getPluginDataDirName());
  }

  async removeKnowledgeBaseHistory(): Promise<KnowledgeBaseHistoryRemovalResult> {
    return removeKnowledgeBaseHistory(this.getVaultPath(), this.getPluginDataDirName());
  }

  async removeKnowledgeBaseHistoryDays(dates: string[]): Promise<KnowledgeBaseHistoryRemovalResult> {
    return removeKnowledgeBaseHistoryDays(this.getVaultPath(), this.getPluginDataDirName(), dates);
  }

  async pruneKnowledgeBaseHistoryByRetention(): Promise<KnowledgeBaseHistoryRemovalResult> {
    const retentionDays = this.settings.knowledgeBase.historyRetentionDays;
    return pruneKnowledgeBaseHistoryByRetention(this.getVaultPath(), this.getPluginDataDirName(), retentionDays);
  }

  private async runDeferredStartupMaintenance(): Promise<void> {
    if (this.startupMaintenancePromise) return this.startupMaintenancePromise;
    this.startupMaintenancePromise = (async () => {
      let changed = false;
      try {
        changed = await externalizeLargeMessages(this.getVaultPath(), this.settings, this.getPluginDataDirName()) > 0 || changed;
      } catch (error) {
        console.error("Codex raw message migration failed", error);
      }
      try {
        changed = (await migrateKnowledgeBaseHistory(this.getVaultPath(), this.getPluginDataDirName(), this.settings)).changed || changed;
      } catch (error) {
        console.error("Codex knowledge history migration failed", error);
      }
      try {
        await this.pruneKnowledgeBaseHistoryByRetention();
      } catch (error) {
        console.warn("Codex knowledge history retention cleanup failed", error);
      }
      if (changed) await this.saveSettings(true, { flushKnowledgeBaseHistory: false });
    })().finally(() => {
      this.startupMaintenancePromise = null;
    });
    return this.startupMaintenancePromise;
  }

  async archivePendingKnowledgeBaseThreads(): Promise<number> {
    if (!this.knowledgeBase) return 0;
    return this.knowledgeBase.archivePendingCodexKnowledgeThreads();
  }

  getKnowledgeBaseManager(): KnowledgeBaseManager | null {
    return this.knowledgeBase;
  }

  getReviewManager(): ReviewManager | null {
    return this.review;
  }

  async openReviewHtmlPreview(relativePath: string): Promise<void> {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!isReviewHtmlPath(normalized, this.settings.review.outputDir)) {
      new Notice("只能打开 EchoInk 生成的复盘 HTML");
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW_PREVIEW)[0];
    if (!leaf) {
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) throw new Error("无法创建复盘预览页");
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_REVIEW_PREVIEW, active: true });
    }
    if (this.app.workspace.rightSplit.collapsed) this.app.workspace.rightSplit.expand();
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    await this.getReviewPreviewView()?.openHtml(normalized);
  }

  private getHomeView(): EchoInkHomeView | null {
    return this.getViewInstance(VIEW_TYPE_ECHOINK_HOME, EchoInkHomeView);
  }

  private getReviewPreviewView(): ReviewPreviewView | null {
    return this.getViewInstance(VIEW_TYPE_REVIEW_PREVIEW, ReviewPreviewView);
  }

  private getViewInstance<T>(viewType: string, viewClass: { new (...args: any[]): T }): T | null {
    for (const leaf of this.app.workspace.getLeavesOfType(viewType)) {
      if (leaf.view instanceof viewClass) return leaf.view;
    }
    return null;
  }

  private async recoverKnowledgeBaseLintStatus(): Promise<boolean> {
    const settings = this.settings.knowledgeBase;
    if (settings.lastRunStatus !== "failed" || !settings.lastReportPath) return false;
    const report = await readKnowledgeBaseReportExcerpt(this.getVaultPath(), settings.lastReportPath, 2000);
    if (!shouldRecoverKnowledgeBaseLintFailure(settings.lastError, report)) return false;
    settings.lastRunStatus = "success";
    settings.lastError = "";
    settings.lastSummary = `体检报告已生成。上次 Codex 返回失败状态，但 lint-only 报告文件存在，已恢复为成功。\n\n${report}`.slice(0, 1000);
    return true;
  }

  private handleCodexNotification(notification: CodexNotification): void {
    if (this.knowledgeBase?.handleCodexNotification(notification)) {
      this.getCodexView()?.handleKnowledgeBaseCodexNotification(notification);
      return;
    }
    this.getCodexView()?.handleCodexNotification(notification);
  }

  private getServerRequestRouter(): CodexServerRequestRouter {
    if (!this.serverRequestRouter) {
      this.serverRequestRouter = new CodexServerRequestRouter({
        confirm: (title, body, acceptText, declineText) => confirmModal(this.app, title, body, acceptText, declineText),
        requestUserInput: (questions) => requestUserInputModal(this.app, questions),
        openUrl: (url) => window.open(url)
      });
    }
    return this.serverRequestRouter;
  }

  private async flushSettingsSave(options: { flushKnowledgeBaseHistory?: boolean } = {}): Promise<void> {
    const run = this.saveQueue.then(async () => {
      await this.flushRawWrites();
      if (options.flushKnowledgeBaseHistory !== false) await this.flushKnowledgeBaseHistory();
      await this.saveData(this.settings);
    });
    this.saveQueue = run.catch((error) => {
      this.reportSettingsSaveError(error);
    });
    await run;
  }

  private reportSettingsSaveError(error: unknown): void {
    console.error("[EchoInk] settings save failed:", error);
    new Notice(this.settings.settingsLanguage === "en" ? "EchoInk settings save failed" : "EchoInk 设置保存失败，请稍后重试");
  }

  private async flushRawWrites(): Promise<void> {
    const pending = Array.from(this.rawWrites);
    if (pending.length) await Promise.allSettled(pending);
  }

  private async flushKnowledgeBaseHistory(): Promise<void> {
    try {
      await persistAndCompactKnowledgeBaseHistory(this.getVaultPath(), this.getPluginDataDirName(), this.settings);
    } catch (error) {
      console.error("Codex knowledge history save failed", error);
    }
  }

  private async loadSkills(force: boolean): Promise<CodexSkill[]> {
    const status = await this.ensureCodexConnected(force);
    if (!status.connected || !this.codex) return status.skills;
    try {
      const skills = await this.codex.refreshSkills();
      this.lastStatus = { ...status, skills };
      return skills;
    } catch (error) {
      this.lastStatus = {
        ...status,
        errors: [...status.errors, error instanceof Error ? error.message : String(error)]
      };
      return status.skills;
    }
  }

  async listEchoInkMcpTools(resourceId: string, timeoutMs = 30000): Promise<unknown[]> {
    const resource = this.currentEchoInkResource(resourceId);
    if (!resource || resource.kind !== "mcp-server") throw new Error("找不到 EchoInk MCP 资源。");
    const broker = new EchoInkMcpBroker({
      settings: this.settings.resources.mcpBroker,
      connections: this.settings.resources.mcpConnections
    });
    try {
      const result = await broker.listTools(resource, timeoutMs);
      this.recordEchoInkMcpConnectionSuccess(resource);
      await this.saveSettings(true);
      return result.tools;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordEchoInkMcpConnectionFailure(resource, message);
      await this.saveSettings(true);
      throw error;
    }
  }

  async callEchoInkMcpTool(input: {
    resourceId: string;
    scope: EchoInkResourceScope;
    backend: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<unknown> {
    const resource = this.currentEchoInkResource(input.resourceId);
    if (!resource || resource.kind !== "mcp-server") throw new Error("找不到 EchoInk MCP 资源。");
    const broker = new EchoInkMcpBroker({
      settings: this.settings.resources.mcpBroker,
      connections: this.settings.resources.mcpConnections,
      approval: async (request) => {
        const args = request.arguments ? `\n\n参数：${JSON.stringify(request.arguments, null, 2).slice(0, 2000)}` : "";
        return await confirmModal(
          this.app,
          `MCP 工具调用：${request.toolName}`,
          `资源：${request.resource.name}\n后端：${request.backend}\n范围：${request.scope}${args}`,
          "允许",
          "拒绝"
        );
      }
    });
    try {
      const result = await broker.callTool({
        resource,
        scope: input.scope,
        backend: input.backend,
        toolName: input.toolName,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs
      });
      this.recordEchoInkMcpConnectionSuccess(resource);
      return result.content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordEchoInkMcpConnectionFailure(resource, message);
      throw error;
    } finally {
      await this.saveSettings(true);
    }
  }

  private recordEchoInkMcpConnectionSuccess(resource: EchoInkResource): void {
    const record = this.ensureEchoInkMcpConnectionRecord(resource);
    if (!record) return;
    record.verifiedAt = Date.now();
    record.lastError = "";
  }

  private recordEchoInkMcpConnectionFailure(resource: EchoInkResource, message: string): void {
    const record = this.ensureEchoInkMcpConnectionRecord(resource);
    if (!record) return;
    record.lastError = message;
  }

  private ensureEchoInkMcpConnectionRecord(resource: EchoInkResource): EchoInkMcpConnectionRecord | null {
    const existing = this.settings.resources.mcpConnections[resource.id];
    if (existing) return existing;
    const config = resolveMcpConnectionConfig(resource, this.settings.resources);
    if (!config) return null;
    const record = { ...config };
    this.settings.resources.mcpConnections[resource.id] = record;
    return record;
  }

  async testHermesConnection(options: { notify?: boolean } = {}): Promise<HermesConnectionTestResult> {
    const notify = options.notify !== false;
    const hermes = this.settings.agents.hermes;
    if (isSyntheticHermesDefaultModel(hermes.providerId, hermes.modelId)) {
      hermes.providerId = "";
      hermes.modelId = "";
      hermes.providerConfigured = false;
      hermes.lastProviderCheckAt = 0;
      hermes.lastProviderError = "";
    }
    const backend = new HermesBackend({
      ...hermes,
      vaultPath: this.getVaultPath()
    });
    try {
      await backend.connect();
      const models = await backend.listModels();
      const info = backend.getConnectionInfo();
      hermes.version = info.version;
      hermes.lastConnectedAt = Date.now();
      hermes.lastError = "";
      const configuredModel = models.find((model) => model.providerId === hermes.providerId && model.modelId === hermes.modelId);
      const selectedModel = configuredModel ?? (hermes.providerId || hermes.modelId ? models[0] : null);
      if (selectedModel) {
        hermes.providerId = selectedModel.providerId;
        hermes.modelId = selectedModel.modelId;
      }
      try {
        await backend.runTask({
          prompt: "只回复 PONG",
          permission: "read-only",
          timeoutMs: 60000,
          ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
          profile: hermes.profile
        });
        hermes.providerConfigured = true;
        hermes.lastProviderCheckAt = Date.now();
        hermes.lastProviderError = "";
      } catch (providerError) {
        hermes.providerConfigured = false;
        hermes.lastProviderCheckAt = Date.now();
        hermes.lastProviderError = providerError instanceof Error ? providerError.message : String(providerError);
      }
      await this.saveSettings(true);
      const message = hermes.providerConfigured
        ? `Hermes 已检测：${info.version || "version unknown"}，provider 可用`
        : `Hermes CLI 可用，但 provider 未通过：${hermes.lastProviderError}`;
      if (notify) new Notice(message);
      return {
        connected: true,
        providerConfigured: hermes.providerConfigured,
        message,
        version: info.version
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hermes.lastError = message;
      await this.saveSettings(true);
      if (notify) new Notice(`Hermes 检测失败：${message}`);
      return {
        connected: false,
        providerConfigured: false,
        message,
        version: ""
      };
    } finally {
      await backend.disconnect().catch(swallowError("disconnect Hermes backend after loading skills"));
    }
  }

  private currentEchoInkResource(resourceId: string): EchoInkResource | null {
    return buildEchoInkResourceCatalog({ settings: this.settings.resources }).find((resource) => resource.id === resourceId) ?? null;
  }

  private async loadEchoInkSkillResources(force: boolean): Promise<EchoInkResource[]> {
    const codexSkills = await this.loadSkills(force).catch(() => this.lastStatus?.skills ?? []);
    const hermesSkills = await this.loadHermesSkillResources().catch((error) => {
      this.settings.resources.lastError = error instanceof Error ? error.message : String(error);
      return [];
    });
    this.settings.resources.catalog = buildEchoInkResourceCatalog({
      codex: { skills: codexSkills },
      hermes: { skills: hermesSkills },
      settings: this.settings.resources
    });
    if (codexSkills.length) this.settings.resources.importedFrom["codex-import"] = Date.now();
    if (hermesSkills.length) this.settings.resources.importedFrom["hermes-import"] = Date.now();
    this.settings.resources.lastScannedAt = Date.now();
    if (codexSkills.length || hermesSkills.length) this.settings.resources.lastError = "";
    await this.saveSettings(true);
    return skillResourcesForScope(
      buildEchoInkResourceCatalog({ settings: this.settings.resources }),
      "chat",
      this.settings.resources.enabledByScope
    );
  }

  private async loadHermesSkillResources() {
    const backend = new HermesBackend({
      ...this.settings.agents.hermes,
      vaultPath: this.getVaultPath()
    });
    try {
      await backend.connect();
      return await backend.listSkills();
    } finally {
      await backend.disconnect().catch(swallowError("disconnect Hermes skill resource backend"));
    }
  }

}
