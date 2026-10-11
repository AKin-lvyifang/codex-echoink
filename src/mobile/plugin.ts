import { ItemView, MarkdownRenderer, Component, Notice, Platform, Plugin, requestUrl, type TFile, type WorkspaceLeaf } from "obsidian";
import { MobileStore } from "./store";
import { loadMobileSettings, type MobileSettings } from "./settings";
import { MobileRuntime } from "./runtime";
import { MobileUI } from "../ui/mobile/mobile-ui";
import { MobileWorkspace, MOBILE_VIEW } from "./workspace";
import { mobilePluginDataRoot } from "./data-root";
import { MobileServices } from "./services";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "../home/home-view";
import { MobileViewport } from "../ui/mobile/viewport";
import { createMobileAccountService } from "./account";
import type { AccountService } from "../membership/account-service";
import { LifestyleView, LIFE_VIEW_TYPES } from "../lifestyle/view";

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
      this.store = new MobileStore(this.app.vault.adapter, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`);
      await this.store.load();
      this.runtime = new MobileRuntime(this.app, this.store, () => this.settings, requestUrl, () => this.services.context());
      this.navigation = new MobileWorkspace(this.app.workspace, Platform.isTablet);
      this.services = new MobileServices(this, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`);
      this.services.usePluginDataRoot(await mobilePluginDataRoot(this.app.vault.adapter, this.services.directory.replace(/\/mobile$/u, ""), this.manifest.id, this.manifest.dir));
      await this.services.initialize();
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
      this.registerView(MOBILE_VIEW, leaf => new EchoInkMobileView(leaf, this));
      this.registerView(VIEW_TYPE_ECHOINK_HOME, leaf => new EchoInkMobileHomeView(leaf, this.services));
      this.addRibbonIcon("bot", "打开 EchoInk", () => { void this.open().catch(error => new Notice(String(error))); });
      this.addCommand({ id: "open-echoink-mobile", name: "打开移动对话", callback: () => { void this.open().catch(error => new Notice(String(error))); } });
      this.addCommand({ id: "open-echoink-mobile-home", name: "打开首页", callback: () => { void this.navigation.openHome().catch(error => new Notice(String(error))); } });
      this.addCommand({ id: "echoink-mobile-current-note", name: "在 EchoInk 中引用当前笔记", callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension === "md") this.store.session.notePath = file.path;
        void this.store.save().then(() => this.navigation.open()).catch(error => new Notice(String(error)));
      } });
    } catch (error) { new Notice(`EchoInk 无法加载：${error instanceof Error ? error.message : String(error)}`, 10000); throw error; }
  }
  async saveSettings(): Promise<void> {
    const snapshot: unknown = JSON.parse(JSON.stringify(this.settings));
    const write = this.settingsWrites.catch(() => {}).then(() => this.saveData(snapshot));
    this.settingsWrites = write;
    return write;
  }
  async open(): Promise<void> {
    if (Platform.isTablet) await this.navigation.openHome();
    await this.navigation.open();
  }
  async showPage(page: "basic" | "knowledge" | "resources" | "finance-settings"): Promise<void> {
    await this.navigation.open();
    const view = this.app.workspace.getLeavesOfType(MOBILE_VIEW)[0]?.view;
    if (view instanceof EchoInkMobileView) view.showPage(page);
  }
  onunload(): void { this.accountService?.dispose(); this.runtime?.stop(); void this.services?.dispose(); }
}

class EchoInkMobileFinanceView extends LifestyleView {
  private viewport?: MobileViewport;
  async onOpen(): Promise<void> { this.contentEl.addClass("echoink-mobile-finance"); this.viewport = new MobileViewport(this.contentEl); await super.onOpen(); }
  async onClose(): Promise<void> { await super.onClose(); this.viewport?.dispose(); this.contentEl.removeClass("echoink-mobile-finance"); }
}

class EchoInkMobileView extends ItemView {
  private ui?: MobileUI;
  private markdown = new Component();
  constructor(leaf: WorkspaceLeaf, private plugin: EchoInkMobilePlugin) { super(leaf); }
  getViewType() { return MOBILE_VIEW; }
  getDisplayText() { return "EchoInk"; }
  getIcon() { return "bot"; }
  showPage(page: "basic" | "knowledge" | "resources" | "finance-settings") { this.ui?.showPage(page); }
  async onOpen(): Promise<void> {
    this.addChild(this.markdown);
    this.ui = new MobileUI(this.contentEl, {
      app: this.app, store: this.plugin.store, runtime: this.plugin.runtime,
      isTablet: Platform.isTablet,
      services: this.plugin.services, version: this.plugin.manifest.version, accountService: this.plugin.accountService,
      settings: () => this.plugin.settings,
      saveSettings: () => this.plugin.saveSettings(),
      openNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !("extension" in file)) throw new Error("笔记不存在。");
        await this.plugin.navigation.openNote(file as TFile, this.leaf);
      },
      beginRender: () => { this.removeChild(this.markdown); this.markdown = new Component(); this.addChild(this.markdown); },
      renderMarkdown: (text, element) => { void MarkdownRenderer.render(this.app, text, element, this.plugin.store.session.notePath, this.markdown); }
    });
    this.ui.mount();
  }
  async onClose(): Promise<void> {
    this.ui?.destroy();
    await this.plugin.store.save();
  }
}

class EchoInkMobileHomeView extends EchoInkHomeView {
  private mobileViewport?: MobileViewport;
  async onOpen(): Promise<void> { await super.onOpen(); this.contentEl.addClass("echoink-mobile-home"); this.mobileViewport = new MobileViewport(this.contentEl); }
  async onClose(): Promise<void> { this.mobileViewport?.dispose(); this.contentEl.removeClass("echoink-mobile-home"); await super.onClose(); }
}
