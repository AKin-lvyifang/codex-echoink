import * as fsp from "fs/promises";
import * as path from "path";
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CodexService } from "./core/codex-service";
import { diagnoseCodexError } from "./core/codex-diagnostics";
import { externalizeLargeMessages, prepareRawMessage, readRawText, writeRawText } from "./core/raw-message-store";
import { clearLegacyChatWorkspaceDefaults, ensureKnowledgeBaseSession, getActiveApiProvider, normalizeSettingsData, providerConnectionLabel, type ChatMessage, type CodexForObsidianSettings, type ResourceManagementTab } from "./settings/settings";
import { CodexSettingTab } from "./settings/settings-tab";
import { confirmModal, requestUserInputModal } from "./ui/modals";
import { CodexView, VIEW_TYPE_CODEX } from "./ui/codex-view";
import type { CodexServerRequest, CodexSkill, CodexStatusSnapshot } from "./types/app-server";
import { EditorActionController } from "./editor-actions/controller";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "./knowledge-base/constants";
import {
  collectKnowledgeBaseStorageStats,
  compactOldKnowledgeBaseProcessHistory,
  exportKnowledgeBaseHistory,
  migrateKnowledgeBaseHistory,
  persistAndCompactKnowledgeBaseHistory,
  readKnowledgeBaseHistoryDay,
  readKnowledgeBaseHistoryIndex,
  rebuildKnowledgeBaseHistoryIndex,
  type KnowledgeBaseHistoryIndex,
  type KnowledgeBaseStorageStats
} from "./knowledge-base/history-store";
import { KnowledgeBaseManager } from "./knowledge-base/manager";
import { isLintOnlyKnowledgeBaseReport, readKnowledgeBaseReportExcerpt } from "./knowledge-base/report";
import { ReviewManager } from "./review/manager";
import { ReviewPreviewView, VIEW_TYPE_REVIEW_PREVIEW } from "./review/preview-view";
import { isReviewHtmlPath } from "./review/schedule";

export default class CodexForObsidianPlugin extends Plugin {
  settings!: CodexForObsidianSettings;
  codex: CodexService | null = null;
  lastStatus: CodexStatusSnapshot | null = null;
  private view: CodexView | null = null;
  private reviewPreviewView: ReviewPreviewView | null = null;
  private editorActions: EditorActionController | null = null;
  private knowledgeBase: KnowledgeBaseManager | null = null;
  private review: ReviewManager | null = null;
  private skillsLoadPromise: Promise<CodexSkill[]> | null = null;
  private connectPromise: Promise<CodexStatusSnapshot> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private rawWrites = new Set<Promise<void>>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CODEX, (leaf: WorkspaceLeaf) => {
      this.view = new CodexView(leaf, this);
      return this.view;
    });
    this.registerView(VIEW_TYPE_REVIEW_PREVIEW, (leaf: WorkspaceLeaf) => {
      this.reviewPreviewView = new ReviewPreviewView(leaf, this);
      return this.reviewPreviewView;
    });

    this.addRibbonIcon("bot", "打开 Codex 侧栏", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-codex-sidebar",
      name: "打开 Codex 侧栏",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "new-codex-chat",
      name: "新建 Codex 会话",
      callback: async () => {
        await this.activateView();
        new Notice("已打开 Codex，可点击 + 新建会话");
      }
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
    if (this.settings.editorActions.enabled) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => void this.ensureCodexConnected(false, { silent: true }), 800);
      });
    }
  }

  async onunload(): Promise<void> {
    this.editorActions?.cancelActiveCandidate("canceled", false);
    this.knowledgeBase?.unload();
    this.review?.unload();
    await this.saveSettings(true);
    await this.codex?.disconnect();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODEX);
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
    await this.app.workspace.revealLeaf(leaf);
    this.view?.focusInput();
  }

  async activateKnowledgeBaseChannel(): Promise<void> {
    const session = ensureKnowledgeBaseSession(this.settings, this.getVaultPath());
    this.settings.activeSessionId = session.id;
    await this.saveSettings(true);
    await this.activateView();
    this.view?.refreshActiveSession();
  }

  applyComposerDefaultsToView(): void {
    this.view?.applySavedComposerDefaults();
  }

  getCodexView(): CodexView | null {
    return this.view;
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
        onServerRequest: (request) => this.handleServerRequest(request)
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
    let rawMigrated = 0;
    let historyMigrated = false;
    try {
      rawMigrated = await externalizeLargeMessages(this.getVaultPath(), this.settings, this.getPluginDataDirName());
    } catch (error) {
      console.error("Codex raw message migration failed", error);
    }
    try {
      historyMigrated = (await migrateKnowledgeBaseHistory(this.getVaultPath(), this.getPluginDataDirName(), this.settings)).changed;
    } catch (error) {
      console.error("Codex knowledge history migration failed", error);
    }
    const knowledgeSessionChanged = sessionCountBefore !== this.settings.sessions.length || knowledgeSessionBefore !== this.settings.knowledgeBase.sessionId;
    if (normalized.changed || rawMigrated > 0 || historyMigrated || legacyChatWorkspacesCleared > 0 || knowledgeSessionChanged || knowledgeStatusRecovered || knowledgeRulesMigrated) await this.saveSettings(true);
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

  async saveSettings(force = false): Promise<void> {
    if (force) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      await this.flushSettingsSave();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSettingsSave();
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
    await this.app.workspace.revealLeaf(leaf);
    await this.reviewPreviewView?.openHtml(normalized);
  }

  private async recoverKnowledgeBaseLintStatus(): Promise<boolean> {
    const settings = this.settings.knowledgeBase;
    if (settings.lastRunStatus !== "failed" || !settings.lastReportPath) return false;
    const report = await readKnowledgeBaseReportExcerpt(this.getVaultPath(), settings.lastReportPath, 2000);
    if (!report || !isLintOnlyKnowledgeBaseReport(report)) return false;
    settings.lastRunStatus = "success";
    settings.lastError = "";
    settings.lastSummary = `体检报告已生成。上次 Codex 返回失败状态，但 lint-only 报告文件存在，已恢复为成功。\n\n${report}`.slice(0, 1000);
    return true;
  }

  private handleCodexNotification(notification: any): void {
    if (this.knowledgeBase?.handleCodexNotification(notification)) {
      this.view?.handleCodexNotification(notification);
      return;
    }
    this.view?.handleCodexNotification(notification);
  }

  private async flushSettingsSave(): Promise<void> {
    const run = this.saveQueue.then(async () => {
      await this.flushRawWrites();
      await this.flushKnowledgeBaseHistory();
      await this.saveData(this.settings);
    });
    this.saveQueue = run.catch(() => undefined);
    await run;
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

  private async handleServerRequest(request: CodexServerRequest): Promise<any> {
    if (request.method === "item/commandExecution/requestApproval") {
      const command = request.params?.command ?? "未知命令";
      const accepted = await confirmModal(this.app, "Codex 请求执行命令", `${command}\n\n${request.params?.reason ?? ""}`);
      return { decision: accepted ? "accept" : "decline" };
    }
    if (request.method === "item/fileChange/requestApproval") {
      const accepted = await confirmModal(this.app, "Codex 请求修改文件", request.params?.reason ?? "是否允许本次文件修改？");
      return { decision: accepted ? "accept" : "decline" };
    }
    if (request.method === "item/permissions/requestApproval") {
      const accepted = await confirmModal(this.app, "Codex 请求额外权限", request.params?.reason ?? "是否允许本次额外权限？");
      return accepted
        ? {
            permissions: request.params?.permissions ?? {},
            scope: "turn"
          }
        : { permissions: {}, scope: "turn" };
    }
    if (request.method === "item/tool/requestUserInput") {
      const answers = await requestUserInputModal(this.app, request.params?.questions ?? []);
      return { answers };
    }
    if (request.method === "mcpServer/elicitation/request") {
      const params = request.params ?? {};
      if (params.mode === "url") {
        const accepted = await confirmModal(this.app, "MCP 需要网页登录", `${params.message}\n\n${params.url}`, "打开", "取消");
        if (accepted) window.open(params.url);
        return { action: accepted ? "accept" : "cancel", content: null, _meta: null };
      }
      const accepted = await confirmModal(this.app, `MCP：${params.serverName}`, params.message ?? "是否继续？");
      return { action: accepted ? "accept" : "decline", content: {}, _meta: null };
    }
    return {};
  }
}
