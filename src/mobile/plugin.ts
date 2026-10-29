import { settingsReportNoticeContent } from "../run-reports/notice";
import { openMobileRunReport } from "../run-reports/mobile-ui";
import { runErrors } from "../run-reports/recent-errors";
import { configuredReportSecrets } from "../run-reports/report";
import { registerGalleryFeature } from "../gallery/controller";
import { normalizeMarkdownMath } from "../core/markdown-math";
import { migrateKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { View, ItemView, MarkdownRenderer, Component, Notice, Platform, Plugin, requestUrl, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { isMobileDataConflict, MobileDataConflictError, MobileStore } from "./store";
import type { AgentRegistry } from "../agents/types";
import { getMobileTaskInstanceId } from "./task-identity";
import { loadMobileSettings, mobileAgentRegistrySource, type MobileSettings } from "./settings";
import { MobileRuntime } from "./runtime";
import { MobileUsageStore } from "./usage-store";
import { MobileUI } from "../ui/mobile/mobile-ui";
import { MobileWorkspace, MOBILE_VIEW, MOBILE_SETTINGS_VIEW } from "./workspace";
import { mobilePluginDataRoot } from "./data-root";
import { MobileServices } from "./services";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "../home/home-view";
import { MobileViewport } from "../ui/mobile/viewport";
import { createMobileAccountService } from "./account";
import type { AccountService } from "../membership/account-service";
import { LifestyleView, LIFE_VIEW_TYPES } from "../lifestyle/view";
import type { MobileSettingsRoute } from "../ui/mobile/settings-pages";
import { IPHONE_SHELL_VIEW, IPhoneShellWorkspace, IPAD_SHELL_HOME_VIEW, IPAD_SHELL_AGENT_VIEW, IPAD_SHELL_SETTINGS_VIEW, IPadShellWorkspace } from "./shell-workspace";
import { MobileWorkbenchService } from "./workbench";
import { IPhoneWorkbench } from "../ui/iphone/workbench";
import { EchoInkAppearance, ECHOINK_THEME_ATTRIBUTE } from "../ui/appearance-theme";
import type { IPhoneRoute } from "../ui/iphone/workbench-contract";
import { IPadWorkbench } from "../ui/ipad/workbench";
import { IPadAgentPane } from "../ui/ipad/agent-pane";
import type { IPadAgentRoute, IPadWorkbenchHost } from "../ui/ipad/workbench-contract";
import type { AgentModuleId } from "../agents/types";
import type { MobileRequest } from "./transport";
import { IPadSettings } from "../ui/ipad/settings-pages";

export { MOBILE_VIEW } from "./workspace";
export default class EchoInkMobilePlugin extends Plugin {
  store!: MobileStore;
  settings!: MobileSettings;
  runtime!: MobileRuntime;
  usage!: MobileUsageStore;
  navigation!: MobileWorkspace;
  services!: MobileServices;
  accountService!: AccountService;
  private appearance?: EchoInkAppearance;
  applyAppearanceTheme(doc?: Document): void { if (doc) this.appearance?.applyToDocument(doc); this.appearance?.refresh(); }
  iphoneNavigation?: IPhoneShellWorkspace;
  ipadNavigation?: IPadShellWorkspace;
  workbench?: MobileWorkbenchService;
  modelRequest?: MobileRequest;
  private settingsWrites: Promise<void> = Promise.resolve();
  private reportedSettingsSaveFailure = false;
  private retainedRegistry?: { present: boolean; value: unknown };
  private taskLifecycleRegistered = false;
  private unloaded = false;
  async onload(): Promise<void> {
    runErrors.reset(() => ({ secrets: configuredReportSecrets(this.settings ?? {}), vaultPath: (this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath?: () => string }).getBasePath?.() }));
    try {
      const saved: unknown = await this.loadData();
      this.settings = loadMobileSettings(saved);
      const savedRecord = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
      const migratedTheme = savedRecord.colorTheme !== this.settings.colorTheme;
      const migratedToolCalling = JSON.stringify(savedRecord.apiProviders ?? []) !== JSON.stringify(this.settings.apiProviders);
      const appearanceDocument = this.app.workspace.containerEl?.ownerDocument ?? document;
      this.appearance = new EchoInkAppearance(this.app, () => this.settings.colorTheme, () => this.accountService);
      this.applyAppearanceTheme(appearanceDocument);
      this.register(() => this.appearance?.dispose());
      if (mobileAgentRegistrySource(this.settings) !== "existing") {
        const raw = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
        this.retainedRegistry = { present: Object.hasOwn(raw, "agentRegistry"), value: raw.agentRegistry };
      }
      const migratedBindings = !this.settings.knowledgeBase.folderBindings;
      if (migratedBindings) {
        this.settings.knowledgeBase.folderBindings = migrateKnowledgeFolderBindings(this.app.vault.getRoot().children.filter((file) => "children" in file).map((file) => file.path), this.settings.mobileUi.knowledgePaths);
      }
      const mobileDirectory = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`;
      let instanceId: string, taskStorageIssue: string | undefined;
      let secretStorage: App["secretStorage"] | undefined;
      try { secretStorage = this.app.secretStorage; } catch { /* The device-local fallback remains available. */ }
      try {
        instanceId = await getMobileTaskInstanceId(secretStorage, `${this.manifest.id}:${mobileDirectory}`, {
          loadLocalStorage: key => this.app.loadLocalStorage(key) as unknown,
          saveLocalStorage: (key, value) => this.app.saveLocalStorage(key, value)
        });
      } catch {
        taskStorageIssue = "本机任务标识无法保存，任务暂不可用；请恢复设备本地存储后重新打开插件。";
        // Only for the non-persistent disabled shell; never reads or creates this partition.
        instanceId = crypto.randomUUID();
      }
      this.store = new MobileStore(this.app.vault.adapter, mobileDirectory, instanceId, taskStorageIssue);
      await this.initializeTaskData(() => this.store.load());
      this.usage = new MobileUsageStore(this.app.vault.adapter, mobileDirectory, instanceId);
      let usageWarningShown = false;
      const usageWarning = () => { if (!usageWarningShown) { usageWarningShown = true; new Notice("使用统计未能完整保存，本次统计可能有缺口；任务记录不受影响。"); } };
      if (!this.store.unavailableReason) await this.usage.initialize().catch(usageWarning);
      this.runtime = new MobileRuntime(this.app, this.store, () => this.settings, requestUrl,
        (id, turn) => this.services.context(id, turn), () => this.saveSettings(), () => this.accountService);
      if (!this.store.unavailableReason) this.runtime.setUsage(this.usage);
      this.navigation = new MobileWorkspace(this.app.workspace, Platform.isTablet);
      this.services = new MobileServices(this, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`);
      this.services.usePluginDataRoot(await mobilePluginDataRoot(this.app.vault.adapter, this.services.directory.replace(/\/mobile$/u, ""), this.manifest.id, this.app.vault.configDir, this.manifest.dir));
      await this.services.initialize();
      if (!this.store.unavailableReason) this.services.setUsage({ recordUsage: event => this.usage.recordUsage(event), onRecordError: usageWarning });
      if (migratedBindings || migratedTheme || migratedToolCalling) await this.saveSettings();
      this.accountService = await createMobileAccountService(this.app, () => this.settings);
      this.accountService.setStatisticsSource({ read: () => this.usage.readStatistics(), subscribe: listener => this.usage.subscribe(listener) });
      if (!this.store.unavailableReason) await this.initializeTaskData(() => this.runtime.initialize());
      this.registerTaskLifecycle();
      await this.services.initializeFinance();
      this.applyAppearanceTheme();
      this.register(this.accountService.subscribe(() => { this.applyAppearanceTheme(); this.services.lifestyle.refresh(); this.services.notifyHomeSurfacesChanged(); }));
      this.addCommand({ id: "open-lifestyle-finance", name: "打开 财务", callback: () => void this.services.lifestyle.open("finance") });
      this.app.workspace.onLayoutReady(() => {
        if (this.settings.lifestyle.finance.enabled || this.services.lifestyle.store.snapshot().financeEntries.length)
          void this.services.lifestyle.finance.initialize().catch(error => new Notice(`财务账本初始化未完成，原数据已保留：${String(error)}`));
      });
      this.registerDomEvent(window, "focus", () => { void this.accountService.refresh(); });
      this.registerInterval(window.setInterval(() => { void this.accountService.refresh(); this.archiveMobileTasks(); }, 300000));
      registerGalleryFeature(this);
      this.registerWorkspaceViews();
      this.registerStartupWorkbench();
      this.addRibbonIcon("bot", "打开 EchoInk", () => { void this.open().catch(error => new Notice(String(error))); }).classList.add("echoink-ribbon-icon");
      this.registerEvent(this.app.workspace.on("css-change", () => this.applyAppearanceTheme()));
      this.addCommand({ id: "open-echoink-mobile", name: "打开移动对话", callback: () => { void this.open().catch(error => new Notice(String(error))); } });
      this.addCommand({ id: "open-echoink-mobile-home", name: "打开首页", callback: () => { void (Platform.isTablet ? this.navigation.openHome() : this.open()).catch(error => new Notice(String(error))); } });
      this.addCommand({ id: "echoink-mobile-current-note", name: "在 EchoInk 中引用当前笔记", callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!Platform.isTablet) {
          void this.store.update(state => {
            const draft = state.newTaskDrafts.sol ?? { text: "", attachments: [] };
            if (file?.extension === "md") draft.noteMentions = [{ vaultRelativePath: file.path, fileName: file.basename }];
            state.newTaskDrafts.sol = draft;
          }).then(() => this.openIPhoneRoute({ kind: "agent", agentId: "sol" })).catch(error => new Notice(String(error)));
          return;
        }
        const page = this.store.state.page;
        const agentId = page.kind === "list" ? page.agentId : this.store.session.agentId;
        void this.store.update(state => {
          const draft = state.newTaskDrafts[agentId] ?? { text: "", attachments: [] };
          if (file?.extension === "md") draft.noteMentions = [{ vaultRelativePath: file.path, fileName: file.basename }];
          state.newTaskDrafts[agentId] = draft;
        }).then(() => this.openIPadAgent({ kind: "agent", agentId })).catch(error => new Notice(String(error)));
      } });
    } catch (error) { new Notice(`EchoInk 无法加载：${error instanceof Error ? error.message : String(error)}`, 10000); throw error; }
  }
  private async initializeTaskData(initialize: () => Promise<void>): Promise<void> {
    try { await initialize(); }
    catch (error) {
      if (!isMobileDataConflict(error)) throw error;
      this.store.disableWrites(error.message);
      new Notice(this.store.unavailableReason!, 10000);
    }
  }
  registerStartupWorkbench(): void {
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded || !this.settings.autoOpenHome) return;
      void (Platform.isTablet ? this.ipadNavigation!.openHome() : this.iphoneNavigation!.open())
        .catch(error => new Notice(`无法打开工作台：${String(error)}`));
    });
  }
  /** Visibility belongs to the app document, never to a particular workspace tab. */
  registerTaskLifecycle(): void {
    if (this.taskLifecycleRegistered) return;
    this.taskLifecycleRegistered = true;
    const suspend = (reason: "app_backgrounded" | "app_closed") => {
      this.services?.suspendEnglishDiary();
      void this.runtime.shutdown(reason).catch(error => new Notice(`中断记录未保存，原资料已保留：${String(error)}`));
    };
    const foreground = () => {
      this.workbench?.invalidate();
      this.archiveMobileTasks();
      void this.runtime.foreground().catch(error => new Notice(`中断记录尚未保存，请重新打开后再继续：${String(error)}`));
    };
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") suspend("app_backgrounded");
      else { foreground(); void this.accountService.refresh(); }
    });
    this.registerDomEvent(window, "pagehide", () => suspend("app_closed"));
    this.registerDomEvent(window, "pageshow", () => { if (document.visibilityState === "visible") foreground(); });
    if (document.visibilityState === "hidden") suspend("app_backgrounded");
  }
  private archiveMobileTasks(): void {
    if (this.unloaded || !this.services || document.visibilityState !== "visible") return;
    void this.services.memory.archiveCompleted().catch(error => new Notice(`自动归档未完成，原会话已保留：${String(error)}`));
  }
  openRunReport(): void {
    const types = Platform.isTablet ? [IPAD_SHELL_AGENT_VIEW, IPAD_SHELL_HOME_VIEW] : [IPHONE_SHELL_VIEW];
    const leaves = types.flatMap(type => this.app.workspace.getLeavesOfType(type));
    const active = this.app.workspace.getActiveViewOfType(View)?.leaf;
    leaves.sort((left, right) => Number(right === active) - Number(left === active));
    let taskId: string | undefined;
    for (const leaf of leaves) {
      const page = leaf.view.containerEl.querySelector<HTMLElement>('[data-page-id^="task:"]:not([hidden])');
      if (page && !page.closest("[hidden]")) { taskId = page.dataset.pageId?.slice(5); break; }
    }
    openMobileRunReport({ app: this.app, store: this.store, runtime: this.runtime, settings: () => this.settings,
      version: this.manifest.version, accountService: this.accountService }, taskId, Platform.isTablet ? "ipad" : "iphone");
  }
  async saveSettings(candidateRegistry?: AgentRegistry): Promise<void> {
    const registry = candidateRegistry ? structuredClone(candidateRegistry) : undefined;
    const write = this.settingsWrites.catch(() => {}).then(async () => {
      if (registry && mobileAgentRegistrySource(this.settings) === "invalid") throw new MobileDataConflictError("Agent 配置版本无法读取，原资料已保留。");
      const candidate: Record<string, unknown> = { ...this.settings, ...(registry ? { agentRegistry: registry } : {}) };
      // Independent settings saves must not publish normalized fallback Agents
      // over an unreadable Registry or an unfinished legacy identity migration.
      if (!registry && this.retainedRegistry) {
        if (this.retainedRegistry.present) candidate.agentRegistry = this.retainedRegistry.value;
        else delete candidate.agentRegistry;
      }
      const snapshot: unknown = JSON.parse(JSON.stringify(candidate));
      await this.saveData(snapshot);
      // Publish in the same queue slot: the next ordinary settings save must see
      // either this verified Registry or the previous one after a failed write.
      if (registry) { this.settings.agentRegistry = registry; this.retainedRegistry = undefined; }
    });
    this.settingsWrites = write;
    try { await write; this.reportedSettingsSaveFailure = false; } catch (error) {
      runErrors.record("settings.save", error, { code: "settings_save_failed" });
      if (!this.reportedSettingsSaveFailure) {
        this.reportedSettingsSaveFailure = true;
        const english = this.settings.settingsLanguage === "en";
        new Notice(settingsReportNoticeContent(this.app.workspace.containerEl?.ownerDocument ?? document,
          english ? "EchoInk couldn't save settings. Check whether a sync or antivirus app is locking the plugin folder."
            : "EchoInk 设置多次保存失败，请检查同步或杀毒软件是否占用了插件文件夹",
          () => this.openRunReport(), english, true), 15000);
      }
      throw error;
    }
    this.services?.settingsChanged();
    for (const leaf of this.app.workspace.getLeavesOfType(MOBILE_VIEW)) if (leaf.view instanceof EchoInkMobileView) leaf.view.refreshSettings();
    this.workbench?.invalidate();
    for (const type of [IPAD_SHELL_HOME_VIEW, IPAD_SHELL_AGENT_VIEW]) for (const leaf of this.app.workspace.getLeavesOfType(type)) if (leaf.view instanceof EchoInkIPadView) leaf.view.refreshSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(IPAD_SHELL_SETTINGS_VIEW)) if (leaf.view instanceof EchoInkIPadSettingsView) leaf.view.refreshSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(IPHONE_SHELL_VIEW)) if (leaf.view instanceof EchoInkIPhoneView) leaf.view.refreshSettings();
  }
  registerWorkspaceViews(): void {
    this.registerView(LIFE_VIEW_TYPES.finance, leaf => new EchoInkMobileFinanceView(leaf, this.services.lifestyle, "finance"));
    this.workbench = new MobileWorkbenchService(this.app, this.store, () => this.settings, () => this.services, this.runtime);
    if (!Platform.isTablet) {
      this.iphoneNavigation = new IPhoneShellWorkspace(this.app.workspace);
      this.registerView(IPHONE_SHELL_VIEW, leaf => new EchoInkIPhoneView(leaf, this));
    } else {
      this.ipadNavigation = new IPadShellWorkspace(this.app.workspace);
      this.registerView(IPAD_SHELL_HOME_VIEW, leaf => new EchoInkIPadView(leaf, this, "home"));
      this.registerView(IPAD_SHELL_AGENT_VIEW, leaf => new EchoInkIPadView(leaf, this, "agent"));
      this.registerView(IPAD_SHELL_SETTINGS_VIEW, leaf => new EchoInkIPadSettingsView(leaf, this));
      this.navigation.useWorkbenchRoutes({
        home: async () => { await this.ipadNavigation!.openHome(); },
        open: async () => {
          const page = this.store.state.page;
          const task = page.kind === "detail" ? this.store.getSession(page.taskId) : undefined;
          await this.openIPadAgent(task && (task.taskStatus || task.messages.length || task.draft)
            ? { kind: "task", taskId: task.id }
            : { kind: "agent", agentId: page.kind === "list" ? page.agentId : task?.agentId ?? "sol" });
        }
      });
    }
    this.registerView(MOBILE_VIEW, leaf => new EchoInkMobileView(leaf, this));
    this.registerView(MOBILE_SETTINGS_VIEW, leaf => new EchoInkMobileView(leaf, this, true));
    this.registerView(VIEW_TYPE_ECHOINK_HOME, leaf => new EchoInkMobileHomeView(leaf, this.services));
  }
  async open(): Promise<void> {
    if (!Platform.isTablet) {
      const leaf = await this.iphoneNavigation!.open();
      if (leaf.view instanceof EchoInkIPhoneView) await leaf.view.whenReady();
      return;
    }
    if (Platform.isTablet) await this.navigation.openHome();
    await this.navigation.open();
  }
  async openIPhoneRoute(route: IPhoneRoute): Promise<void> {
    const leaf = await this.iphoneNavigation!.open();
    if (leaf.view instanceof EchoInkIPhoneView) await leaf.view.navigate(route);
  }
  async openIPadAgent(route: IPadAgentRoute): Promise<void> {
    const leaf = await this.ipadNavigation!.openAgent();
    if (leaf.view instanceof EchoInkIPadView) await leaf.view.navigate(route);
  }
  async resumeIPadTask(taskId: string): Promise<void> {
    const leaf = await this.ipadNavigation!.openAgent();
    if (leaf.view instanceof EchoInkIPadView) await leaf.view.resumeTask(taskId);
  }
  async openModule(module: AgentModuleId): Promise<void> {
    if (Platform.isTablet) { await this.openIPadModule(module); return; }
    const leaf = await this.iphoneNavigation!.open();
    if (leaf.view instanceof EchoInkIPhoneView) await leaf.view.openModule(module);
  }
  async openIPadModule(module: AgentModuleId): Promise<void> {
    const leaf = await this.ipadNavigation!.openHome();
    if (leaf.view instanceof EchoInkIPadView) await leaf.view.openModule(module);
  }
  async openIPadSearch(): Promise<void> {
    const leaf = await this.ipadNavigation!.openHome();
    if (leaf.view instanceof EchoInkIPadView) await leaf.view.openSearch();
  }
  async openIPadSettings(category?: string): Promise<void> {
    const leaf = await this.ipadNavigation!.openSettings();
    if (leaf.view instanceof EchoInkIPadSettingsView) await leaf.view.openCategory(category);
  }
  async showPage(page: MobileSettingsRoute): Promise<void> {
    if (Platform.isTablet) {
      if (page === "knowledge" || page === "english-diary-settings") { await this.openIPadSettings(page); return; }
      if (page === "settings" || page === "providers" || page === "account") {
        await this.openIPadSettings(page === "providers" ? "model" : page === "account" ? "account" : undefined);
        return;
      }
      const leaf = await this.navigation.openSettings();
      if (leaf.view instanceof EchoInkMobileView) leaf.view.showPage(page);
      return;
    }
    const leaf = await this.iphoneNavigation!.open();
    if (leaf.view instanceof EchoInkIPhoneView) await leaf.view.showPage(page);
  }
  onunload(): void {
    this.unloaded = true;
    (this.app.workspace.containerEl?.ownerDocument ?? document).body.removeAttribute(ECHOINK_THEME_ATTRIBUTE);
    this.workbench?.dispose();
    this.iphoneNavigation?.dispose();
    this.ipadNavigation?.dispose();
    this.accountService?.dispose();
    const stopped = this.runtime?.shutdown("plugin_disabled");
    this.runtime?.dispose();
    void stopped?.catch(error => new Notice(`中断记录未保存，原资料已保留：${String(error)}`));
    void this.services?.dispose();
  }
}

export class EchoInkIPhoneView extends ItemView {
  private ui?: IPhoneWorkbench;
  private mounting?: Promise<void>;
  private markdown = new Component();
  constructor(leaf: WorkspaceLeaf, private readonly plugin: EchoInkMobilePlugin) { super(leaf); }
  getViewType(): string { return IPHONE_SHELL_VIEW; }
  getDisplayText(): string { return "EchoInk"; }
  getIcon(): string { return "bot"; }
  refreshSettings(): void {
    this.plugin.applyAppearanceTheme(this.contentEl.ownerDocument);
    this.contentEl.dataset.appearance = this.plugin.settings.mobileUi.appearance;
    this.contentEl.classList.toggle("em-large-text", this.plugin.settings.mobileUi.largeText);
  }
  onOpen(): Promise<void> {
    if (this.mounting) return this.mounting;
    this.contentEl.replaceChildren(); this.addChild(this.markdown); this.refreshSettings();
    this.ui = new IPhoneWorkbench(this.contentEl, {
      app: this.app, store: this.plugin.store, runtime: this.plugin.runtime, services: this.plugin.services,
      agents: this.plugin.services.agents, workbench: this.plugin.workbench!,
      accountService: this.plugin.accountService, version: this.plugin.manifest.version,
      modelRequest: this.plugin.modelRequest,
      settings: () => this.plugin.settings, saveSettings: () => this.plugin.saveSettings(),
      openNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("笔记不存在。");
        await this.plugin.iphoneNavigation!.openNote(file);
      },
      openLegacy: page => this.showPage(page), openModule: module => this.openModule(module),
      renderMarkdown: (text, element, sourcePath) => { void MarkdownRenderer.render(this.app, normalizeMarkdownMath(text), element, sourcePath ?? "", this.markdown); }
    });
    return this.mounting = this.ui.mount();
  }
  async whenReady(): Promise<void> { await this.mounting; }
  private async ready(): Promise<IPhoneWorkbench | undefined> {
    const ui = this.ui; await this.whenReady(); return this.ui === ui ? ui : undefined;
  }
  async openModule(module: AgentModuleId): Promise<void> { await (await this.ready())?.openModule(module); }
  async navigate(route: IPhoneRoute): Promise<void> { await (await this.ready())?.navigate(route); }
  async showPage(page: MobileSettingsRoute): Promise<void> { await (await this.ready())?.openLegacy(page); }
  async onClose(): Promise<void> {
    const ui = this.ui; this.ui = undefined; this.mounting = undefined; ui?.dispose();
    this.removeChild(this.markdown); await this.plugin.store.flush();
  }
}

/** A native central tab or native right leaf; only data and services are shared. */
export class EchoInkIPadView extends ItemView {
  private ui?: IPadWorkbench | IPadAgentPane;
  private mounting?: Promise<void>;
  private markdown = new Component();
  constructor(leaf: WorkspaceLeaf, private readonly plugin: EchoInkMobilePlugin, private readonly area: "home" | "agent") { super(leaf); }
  getViewType(): string { return this.area === "home" ? IPAD_SHELL_HOME_VIEW : IPAD_SHELL_AGENT_VIEW; }
  getDisplayText(): string { return this.area === "home" ? "工作台" : "EchoInk"; }
  getIcon(): string { return this.area === "home" ? "layout-dashboard" : "bot"; }
  refreshSettings(): void {
    this.plugin.applyAppearanceTheme(this.contentEl.ownerDocument);
    for (const root of [this.contentEl, ...Array.from(this.contentEl.querySelectorAll<HTMLElement>(".echoink-ipad"))]) {
      root.dataset.appearance = this.plugin.settings.mobileUi.appearance;
      root.classList.toggle("em-large-text", this.plugin.settings.mobileUi.largeText);
    }
  }
  onOpen(): Promise<void> {
    if (this.mounting) return this.mounting;
    this.contentEl.replaceChildren(); this.addChild(this.markdown); this.refreshSettings();
    const host: IPadWorkbenchHost = {
      app: this.app, store: this.plugin.store, runtime: this.plugin.runtime, services: this.plugin.services,
      agents: this.plugin.services.agents, workbench: this.plugin.workbench!,
      accountService: this.plugin.accountService, version: this.plugin.manifest.version,
      modelRequest: this.plugin.modelRequest,
      settings: () => this.plugin.settings, saveSettings: () => this.plugin.saveSettings(),
      openHome: async () => { await this.plugin.ipadNavigation!.openHome(); },
      openAgent: route => this.plugin.openIPadAgent(route),
      openLegacy: page => this.plugin.showPage(page), openModule: module => this.plugin.openIPadModule(module),
      openSearch: () => this.plugin.openIPadSearch(),
      openSettings: category => this.plugin.openIPadSettings(category),
      resumeTask: taskId => this.plugin.resumeIPadTask(taskId),
      openNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("笔记不存在。");
        await this.plugin.ipadNavigation!.openNote(file);
      },
      renderMarkdown: (text, element, sourcePath) => { void MarkdownRenderer.render(this.app, normalizeMarkdownMath(text), element, sourcePath ?? "", this.markdown); }
    };
    this.ui = this.area === "home" ? new IPadWorkbench(this.contentEl, host) : new IPadAgentPane(this.contentEl, host);
    const ui = this.ui;
    return this.mounting = ui.mount().then(() => { if (this.ui === ui) this.refreshSettings(); });
  }
  private async ready(): Promise<IPadWorkbench | IPadAgentPane | undefined> {
    const ui = this.ui; await this.mounting; return this.ui === ui ? ui : undefined;
  }
  async navigate(route: IPadAgentRoute): Promise<void> { const ui = await this.ready(); if (ui instanceof IPadAgentPane) await ui.navigate(route); }
  async resumeTask(taskId: string): Promise<void> { const ui = await this.ready(); if (ui instanceof IPadAgentPane) await ui.resumeTask(taskId); }
  async openModule(module: AgentModuleId): Promise<void> { const ui = await this.ready(); if (ui instanceof IPadWorkbench) await ui.openModule(module); }
  async openSearch(): Promise<void> { const ui = await this.ready(); if (ui instanceof IPadWorkbench) await ui.openSearch(); }
  async onClose(): Promise<void> {
    const ui = this.ui; this.ui = undefined; this.mounting = undefined; ui?.dispose();
    this.removeChild(this.markdown); await this.plugin.store.flush();
  }
}

export class EchoInkIPadSettingsView extends ItemView {
  private ui?: IPadSettings;
  private mounting?: Promise<void>;
  private markdown = new Component();
  constructor(leaf: WorkspaceLeaf, private readonly plugin: EchoInkMobilePlugin) { super(leaf); }
  getViewType(): string { return IPAD_SHELL_SETTINGS_VIEW; }
  getDisplayText(): string { return "EchoInk 设置"; }
  getIcon(): string { return "settings"; }
  refreshSettings(): void {
    this.plugin.applyAppearanceTheme(this.contentEl.ownerDocument);
    for (const root of [this.contentEl, ...Array.from(this.contentEl.querySelectorAll<HTMLElement>(".echoink-ipad"))]) {
      root.dataset.appearance = this.plugin.settings.mobileUi.appearance;
      root.classList.toggle("em-large-text", this.plugin.settings.mobileUi.largeText);
    }
  }
  onOpen(): Promise<void> {
    if (this.mounting) return this.mounting;
    this.contentEl.replaceChildren(); this.addChild(this.markdown); this.refreshSettings();
    this.ui = new IPadSettings(this.contentEl, {
      app: this.app, store: this.plugin.store, runtime: this.plugin.runtime, services: this.plugin.services,
      agents: this.plugin.services.agents, workbench: this.plugin.workbench!,
      accountService: this.plugin.accountService, version: this.plugin.manifest.version, modelRequest: this.plugin.modelRequest,
      settings: () => this.plugin.settings, saveSettings: () => this.plugin.saveSettings(),
      openHome: async () => { await this.plugin.ipadNavigation!.openHome(); },
      openAgent: route => this.plugin.openIPadAgent(route),
      openLegacy: page => this.plugin.showPage(page), openModule: module => this.plugin.openIPadModule(module),
      openSearch: () => this.plugin.openIPadSearch(), resumeTask: id => this.plugin.resumeIPadTask(id),
      openSettings: category => this.plugin.openIPadSettings(category),
      openNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("笔记不存在。");
        await this.plugin.ipadNavigation!.openNote(file);
      },
      renderMarkdown: (text, element, sourcePath) => { void MarkdownRenderer.render(this.app, normalizeMarkdownMath(text), element, sourcePath ?? "", this.markdown); }
    });
    const ui = this.ui;
    return this.mounting = ui.mount().then(() => { if (this.ui === ui) this.refreshSettings(); });
  }
  async openCategory(category?: string): Promise<void> {
    const ui = this.ui; await this.mounting; if (this.ui === ui) await ui?.open(category);
  }
  async onClose(): Promise<void> {
    const ui = this.ui; this.ui = undefined; this.mounting = undefined; ui?.dispose();
    this.removeChild(this.markdown); await this.plugin.store.flush();
  }
}

class EchoInkMobileFinanceView extends LifestyleView {
  private viewport?: MobileViewport;
  async onOpen(): Promise<void> { this.contentEl.addClass("echoink-mobile-finance"); this.viewport = new MobileViewport(this.contentEl); await super.onOpen(); }
  async onClose(): Promise<void> { await super.onClose(); this.viewport?.dispose(); this.contentEl.removeClass("echoink-mobile-finance"); }
}

export class EchoInkMobileView extends ItemView {
  private ui?: MobileUI;
  private requestedPage?: MobileSettingsRoute;
  private markdown = new Component();
  constructor(leaf: WorkspaceLeaf, private plugin: EchoInkMobilePlugin, private settingsOnly = false) { super(leaf); }
  getViewType() { return this.settingsOnly ? MOBILE_SETTINGS_VIEW : MOBILE_VIEW; }
  getDisplayText() { return this.settingsOnly ? "EchoInk 设置" : "EchoInk"; }
  getIcon() { return this.settingsOnly ? "settings-2" : "bot"; }
  showPage(page: MobileSettingsRoute) {
    if (this.settingsOnly && page === "settings") return;
    if (page !== "settings") this.requestedPage = page;
    this.ui?.showPage(page);
  }
  refreshSettings() { this.ui?.refreshSettings(); }
  showChat() { this.ui?.showChat(); }
  async onOpen(): Promise<void> {
    this.addChild(this.markdown);
    this.ui = new MobileUI(this.contentEl, {
      app: this.app, store: this.plugin.store, runtime: this.plugin.runtime,
      isTablet: Platform.isTablet,
      settingsOnly: this.settingsOnly,
      openSettings: page => this.plugin.showPage(page),
      openChat: async () => { await this.plugin.navigation.open(); for (const leaf of this.app.workspace.getLeavesOfType(MOBILE_VIEW)) if (leaf.view instanceof EchoInkMobileView) leaf.view.showChat(); },
      services: this.plugin.services, version: this.plugin.manifest.version, accountService: this.plugin.accountService,
      settings: () => this.plugin.settings,
      saveSettings: () => this.plugin.saveSettings(),
      openNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("笔记不存在。");
        await this.plugin.navigation.openNote(file, this.leaf);
      },
      beginRender: () => { this.removeChild(this.markdown); this.markdown = new Component(); this.addChild(this.markdown); },
      renderMarkdown: (text, element, sourcePath) => { void MarkdownRenderer.render(this.app, normalizeMarkdownMath(text), element, sourcePath ?? this.plugin.store.session.notePath, this.markdown); }
    });
    this.ui.mount();
    if (this.requestedPage) this.ui.showPage(this.requestedPage);
  }
  async onClose(): Promise<void> {
    this.ui?.destroy();
    this.ui = undefined;
    await this.plugin.store.flush();
  }
}

class EchoInkMobileHomeView extends EchoInkHomeView {
  private mobileViewport?: MobileViewport;
  async onOpen(): Promise<void> { await super.onOpen(); this.contentEl.addClass("echoink-mobile-home"); this.mobileViewport = new MobileViewport(this.contentEl); }
  async onClose(): Promise<void> { this.mobileViewport?.dispose(); this.contentEl.removeClass("echoink-mobile-home"); await super.onClose(); }
}
