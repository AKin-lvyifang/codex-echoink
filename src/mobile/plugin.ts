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

export { MOBILE_VIEW } from "./workspace";
export default class EchoInkMobilePlugin extends Plugin {
  store!: MobileStore;
  settings!: MobileSettings;
  runtime!: MobileRuntime;
  navigation!: MobileWorkspace;
  services!: MobileServices;
  accountService!: AccountService;
  private settingsWrites: Promise<void> = Promise.resolve();
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
      this.runtime = new MobileRuntime(this.app, this.store, () => this.settings, requestUrl, id => this.services.context(id), () => this.saveSettings());
      this.navigation = new MobileWorkspace(this.app.workspace, Platform.isTablet);
      this.services = new MobileServices(this, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`);
      this.services.usePluginDataRoot(await mobilePluginDataRoot(this.app.vault.adapter, this.services.directory.replace(/\/mobile$/u, ""), this.manifest.id, this.manifest.dir));
      await this.services.initialize();
      if (migratedBindings) await this.saveSettings();
      this.accountService = await createMobileAccountService(this.app, () => this.settings);
      await this.services.initializeFinance();
      this.register(this.accountService.subscribe(() => { this.services.lifestyle.refresh(); this.services.notifyHomeSurfacesChanged(); }));
      this.registerView(LIFE_VIEW_TYPES.finance, leaf => new EchoInkMobileFinanceView(leaf, this.services.lifestyle, "finance"));
      this.addCommand({ id: "open-lifestyle-finance", name: "打开 财务", callback: () => void this.services.lifestyle.open("finance") });
      this.app.workspace.onLayoutReady(() => {
        if (this.settings.lifestyle.finance.enabled || this.services.lifestyle.store.snapshot().financeEntries.length)
          void this.services.lifestyle.finance.initialize().catch(error => new Notice(`财务账本初始化未完成，原数据已保留：${String(error)}`));
      });
      this.registerDomEvent(document, "visibilitychange", () => { if (document.visibilityState === "visible") void this.accountService.refresh(); });
      this.registerDomEvent(window, "focus", () => { void this.accountService.refresh(); });
      this.registerInterval(window.setInterval(() => { void this.accountService.refresh(); }, 300000));
      this.registerWorkspaceViews();
      this.addRibbonIcon("bot", "打开 EchoInk", () => { void this.open().catch(error => new Notice(String(error))); });
      this.addCommand({ id: "open-echoink-mobile", name: "打开移动对话", callback: () => { void this.open().catch(error => new Notice(String(error))); } });
      this.addCommand({ id: "open-echoink-mobile-home", name: "打开首页", callback: () => { void this.navigation.openHome().catch(error => new Notice(String(error))); } });
      this.addCommand({ id: "echoink-mobile-current-note", name: "在 EchoInk 中引用当前笔记", callback: () => {
        const file = this.app.workspace.getActiveFile();
        const id = this.store.session.id;
        const write = file?.extension === "md" ? this.store.patchSession(id, { notePath: file.path }) : this.store.flush();
        void write.then(() => this.navigation.open()).catch(error => new Notice(String(error)));
      } });
    } catch (error) { new Notice(`EchoInk 无法加载：${error instanceof Error ? error.message : String(error)}`, 10000); throw error; }
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
  }
  registerWorkspaceViews(): void {
    this.registerView(MOBILE_VIEW, leaf => new EchoInkMobileView(leaf, this));
    this.registerView(MOBILE_SETTINGS_VIEW, leaf => new EchoInkMobileView(leaf, this, true));
    this.registerView(VIEW_TYPE_ECHOINK_HOME, leaf => new EchoInkMobileHomeView(leaf, this.services));
  }
  async open(): Promise<void> {
    if (Platform.isTablet) await this.navigation.openHome();
    await this.navigation.open();
  }
  async showPage(page: MobileSettingsRoute): Promise<void> {
    if (Platform.isTablet) {
      const leaf = await this.navigation.openSettings();
      if (leaf.view instanceof EchoInkMobileView) leaf.view.showPage(page);
      return;
    }
    await this.navigation.open();
    const view = this.app.workspace.getLeavesOfType(MOBILE_VIEW)[0]?.view;
    if (view instanceof EchoInkMobileView) view.showPage(page);
  }
  onunload(): void { this.accountService?.dispose(); this.runtime?.dispose(); void this.services?.dispose(); }
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
