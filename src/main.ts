import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CodexService } from "./core/codex-service";
import { externalizeLargeMessages, prepareRawMessage, readRawText, writeRawText } from "./core/raw-message-store";
import { getActiveApiProvider, normalizeSettingsData, type ChatMessage, type CodexForObsidianSettings, type ResourceManagementTab } from "./settings/settings";
import { CodexSettingTab } from "./settings/settings-tab";
import { confirmModal, requestUserInputModal } from "./ui/modals";
import { CodexView, VIEW_TYPE_CODEX } from "./ui/codex-view";
import type { CodexServerRequest, CodexSkill, CodexStatusSnapshot } from "./types/app-server";
import { EditorActionController } from "./editor-actions/controller";

export default class CodexForObsidianPlugin extends Plugin {
  settings!: CodexForObsidianSettings;
  codex: CodexService | null = null;
  lastStatus: CodexStatusSnapshot | null = null;
  private view: CodexView | null = null;
  private editorActions: EditorActionController | null = null;
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

    this.addSettingTab(new CodexSettingTab(this));
    this.editorActions = new EditorActionController(this);
    this.editorActions.register();

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
        onNotification: (notification) => this.view?.handleCodexNotification(notification),
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
        this.lastStatus = {
          connected: false,
          accountLabel: "未连接",
          loggedIn: false,
          models: [],
          skills: [],
          mcpServers: [],
          rateLimits: null,
          rateLimitsByLimitId: null,
          errors: [error instanceof Error ? error.message : String(error)]
        };
        if (!options.silent) new Notice(`Codex 连接失败：${this.lastStatus.errors[0]}`);
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

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    const normalized = normalizeSettingsData(data);
    this.settings = normalized.settings;
    let rawMigrated = 0;
    try {
      rawMigrated = await externalizeLargeMessages(this.getVaultPath(), this.settings);
    } catch (error) {
      console.error("Codex raw message migration failed", error);
    }
    if (normalized.changed || rawMigrated > 0) await this.saveSettings(true);
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
    tracked = writeRawText(this.getVaultPath(), write.rawRef, write.text)
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
    return readRawText(this.getVaultPath(), rawRef);
  }

  private async flushSettingsSave(): Promise<void> {
    const run = this.saveQueue.then(async () => {
      await this.flushRawWrites();
      await this.saveData(this.settings);
    });
    this.saveQueue = run.catch(() => undefined);
    await run;
  }

  private async flushRawWrites(): Promise<void> {
    const pending = Array.from(this.rawWrites);
    if (pending.length) await Promise.allSettled(pending);
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
