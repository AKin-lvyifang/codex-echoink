import { migrateKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { ItemView, MarkdownRenderer, Component, Notice, Platform, Plugin, requestUrl, type TFile, type WorkspaceLeaf } from "obsidian";
import { MobileStore } from "./store";
import type { AgentRegistry } from "../agents/types";
import { getMobileTaskInstanceId } from "./task-identity";
import { loadMobileSettings, type MobileSettings } from "./settings";
import { MobileRuntime } from "./runtime";
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
import { IPHONE_SHELL_VIEW, IPhoneShellWorkspace } from "./shell-workspace";
import { MobileWorkbenchService } from "./workbench";
import { IPhoneWorkbench } from "../ui/iphone/workbench";
import { normalizeEchoInkColorTheme } from "../ui/appearance-theme";
import type { IPhoneRoute } from "../ui/iphone/workbench-contract";

export { MOBILE_VIEW } from "./workspace";
export default class EchoInkMobilePlugin extends Plugin {
  store!: MobileStore;
  settings!: MobileSettings;
  runtime!: MobileRuntime;
  navigation!: MobileWorkspace;
  services!: MobileServices;
  accountService!: AccountService;
  iphoneNavigation?: IPhoneShellWorkspace;
  workbench?: MobileWorkbenchService;
  private settingsWrites: Promise<void> = Promise.resolve();
  private taskLifecycleRegistered = false;
  async onload(): Promise<void> {
    try {
      this.settings = loadMobileSettings(await this.loadData());
      const migratedBindings = !this.settings.knowledgeBase.folderBindings;
      if (migratedBindings) {
        this.settings.knowledgeBase.folderBindings = migrateKnowledgeFolderBindings(this.app.vault.getRoot().children.filter((file) => "children" in file).map((file) => file.path), this.settings.mobileUi.knowledgePaths);
      }
      const mobileDirectory = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`;
      const instanceId = await getMobileTaskInstanceId(this.app.secretStorage, `${this.manifest.id}:${mobileDirectory}`);
      this.store = new MobileStore(this.app.vault.adapter, mobileDirectory, instanceId);
      await this.store.load();
      this.runtime = new MobileRuntime(this.app, this.store, () => this.settings, requestUrl,
        (id, turn) => this.services.context(id, turn), () => this.saveSettings(), () => this.accountService);
      this.navigation = new MobileWorkspace(this.app.workspace, Platform.isTablet);
      this.services = new MobileServices(this, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`);
      this.services.usePluginDataRoot(await mobilePluginDataRoot(this.app.vault.adapter, this.services.directory.replace(/\/mobile$/u, ""), this.manifest.id, this.manifest.dir));
      await this.services.initialize();
      if (migratedBindings) await this.saveSettings();
      this.accountService = await createMobileAccountService(this.app, () => this.settings);
      await this.runtime.initialize();
      this.registerTaskLifecycle();
      await this.services.initializeFinance();
      this.register(this.accountService.subscribe(() => { this.services.lifestyle.refresh(); this.services.notifyHomeSurfacesChanged(); }));
      this.addCommand({ id: "open-lifestyle-finance", name: "打开 财务", callback: () => void this.services.lifestyle.open("finance") });
      this.app.workspace.onLayoutReady(() => {
        if (this.settings.lifestyle.finance.enabled || this.services.lifestyle.store.snapshot().financeEntries.length)
          void this.services.lifestyle.finance.initialize().catch(error => new Notice(`财务账本初始化未完成，原数据已保留：${String(error)}`));
      });
      this.registerDomEvent(window, "focus", () => { void this.accountService.refresh(); });
      this.registerInterval(window.setInterval(() => { void this.accountService.refresh(); }, 300000));
      this.registerWorkspaceViews();
      this.addRibbonIcon("bot", "打开 EchoInk", () => { void this.open().catch(error => new Notice(String(error))); });
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
        const id = this.store.session.id;
        const write = file?.extension === "md" ? this.store.patchSession(id, { notePath: file.path }) : this.store.flush();
        void write.then(() => this.navigation.open()).catch(error => new Notice(String(error)));
      } });
    } catch (error) { new Notice(`EchoInk 无法加载：${error instanceof Error ? error.message : String(error)}`, 10000); throw error; }
  }
  /** Visibility belongs to the app document, never to a particular workspace tab. */
  registerTaskLifecycle(): void {
    if (this.taskLifecycleRegistered) return;
    this.taskLifecycleRegistered = true;
    const suspend = (reason: "app_backgrounded" | "app_closed") => {
      void this.runtime.shutdown(reason).catch(error => new Notice(`中断记录未保存，原资料已保留：${String(error)}`));
    };
    const foreground = () => {
      this.workbench?.invalidate();
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
  async saveSettings(candidateRegistry?: AgentRegistry): Promise<void> {
    const registry = candidateRegistry ? structuredClone(candidateRegistry) : undefined;
    const write = this.settingsWrites.catch(() => {}).then(async () => {
      const snapshot: unknown = JSON.parse(JSON.stringify({ ...this.settings, ...(registry ? { agentRegistry: registry } : {}) }));
      await this.saveData(snapshot);
      // Publish in the same queue slot: the next ordinary settings save must see
      // either this verified Registry or the previous one after a failed write.
      if (registry) this.settings.agentRegistry = registry;
    });
    this.settingsWrites = write;
    await write;
    for (const leaf of this.app.workspace.getLeavesOfType(MOBILE_VIEW)) if (leaf.view instanceof EchoInkMobileView) leaf.view.refreshSettings();
    this.workbench?.invalidate();
    for (const leaf of this.app.workspace.getLeavesOfType(IPHONE_SHELL_VIEW)) if (leaf.view instanceof EchoInkIPhoneView) leaf.view.refreshSettings();
  }
  registerWorkspaceViews(): void {
    this.registerView(LIFE_VIEW_TYPES.finance, leaf => new EchoInkMobileFinanceView(leaf, this.services.lifestyle, "finance"));
    if (!Platform.isTablet) {
      this.iphoneNavigation = new IPhoneShellWorkspace(this.app.workspace);
      this.workbench = new MobileWorkbenchService(this.app, this.store, () => this.settings, () => this.services, this.runtime);
      this.registerView(IPHONE_SHELL_VIEW, leaf => new EchoInkIPhoneView(leaf, this));
    }
    this.registerView(MOBILE_VIEW, leaf => new EchoInkMobileView(leaf, this));
    this.registerView(MOBILE_SETTINGS_VIEW, leaf => new EchoInkMobileView(leaf, this, true));
    this.registerView(VIEW_TYPE_ECHOINK_HOME, leaf => new EchoInkMobileHomeView(leaf, this.services));
  }
  async open(): Promise<void> {
    if (!Platform.isTablet) { await this.iphoneNavigation!.open(); return; }
    if (Platform.isTablet) await this.navigation.openHome();
    await this.navigation.open();
  }
  async openIPhoneRoute(route: IPhoneRoute): Promise<void> {
    const leaf = await this.iphoneNavigation!.open();
    if (leaf.view instanceof EchoInkIPhoneView) await leaf.view.navigate(route);
  }
  async showPage(page: MobileSettingsRoute): Promise<void> {
    if (Platform.isTablet) {
      const leaf = await this.navigation.openSettings();
      if (leaf.view instanceof EchoInkMobileView) leaf.view.showPage(page);
      return;
    }
    const leaf = await this.iphoneNavigation!.open();
    if (leaf.view instanceof EchoInkIPhoneView) await leaf.view.showPage(page);
  }
  onunload(): void {
    this.workbench?.dispose();
    this.iphoneNavigation?.dispose();
    this.accountService?.dispose();
    const stopped = this.runtime?.shutdown("plugin_disabled");
    this.runtime?.dispose();
    void stopped?.catch(error => new Notice(`中断记录未保存，原资料已保留：${String(error)}`));
    void this.services?.dispose();
  }
}

export class EchoInkIPhoneView extends ItemView {
  private ui?: IPhoneWorkbench;
  private markdown = new Component();
  constructor(leaf: WorkspaceLeaf, private readonly plugin: EchoInkMobilePlugin) { super(leaf); }
  getViewType(): string { return IPHONE_SHELL_VIEW; }
  getDisplayText(): string { return "EchoInk"; }
  getIcon(): string { return "bot"; }
  refreshSettings(): void {
    this.contentEl.ownerDocument.body.setAttribute("data-echoink-theme", normalizeEchoInkColorTheme(this.plugin.settings.colorTheme));
    this.contentEl.dataset.appearance = this.plugin.settings.mobileUi.appearance;
    this.contentEl.classList.toggle("em-large-text", this.plugin.settings.mobileUi.largeText);
  }
  async onOpen(): Promise<void> {
    this.contentEl.replaceChildren(); this.addChild(this.markdown); this.refreshSettings();
    this.ui = new IPhoneWorkbench(this.contentEl, {
      app: this.app, store: this.plugin.store, runtime: this.plugin.runtime, services: this.plugin.services,
      agents: this.plugin.services.agents, workbench: this.plugin.workbench!,
      accountService: this.plugin.accountService, version: this.plugin.manifest.version,
      settings: () => this.plugin.settings, saveSettings: () => this.plugin.saveSettings(),
      openNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !("extension" in file)) throw new Error("笔记不存在。");
        await this.plugin.iphoneNavigation!.openNote(file as TFile);
      },
      openLegacy: page => this.showPage(page), openModule: module => this.ui!.openModule(module),
      renderMarkdown: (text, element, sourcePath) => { void MarkdownRenderer.render(this.app, text, element, sourcePath ?? "", this.markdown); }
    });
    await this.ui.mount();
  }
  async navigate(route: IPhoneRoute): Promise<void> { await this.ui?.navigate(route); }
  async showPage(page: MobileSettingsRoute): Promise<void> { await this.ui?.openLegacy(page); }
  async onClose(): Promise<void> { this.ui?.dispose(); this.ui = undefined; this.removeChild(this.markdown); await this.plugin.store.flush(); }
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
        if (!file || !("extension" in file)) throw new Error("笔记不存在。");
        await this.plugin.navigation.openNote(file as TFile, this.leaf);
      },
      beginRender: () => { this.removeChild(this.markdown); this.markdown = new Component(); this.addChild(this.markdown); },
      renderMarkdown: (text, element, sourcePath) => { void MarkdownRenderer.render(this.app, text, element, sourcePath ?? this.plugin.store.session.notePath, this.markdown); }
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
