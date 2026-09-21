import { ItemView, MarkdownRenderer, Component, Notice, Plugin, requestUrl, type TFile, type WorkspaceLeaf } from "obsidian";
import { MobileStore } from "./store";
import { loadMobileSettings, type MobileSettings } from "./settings";
import { MobileRuntime } from "./runtime";
import { MobileUI } from "../ui/mobile/mobile-ui";

export const MOBILE_VIEW = "echoink-mobile";
export default class EchoInkMobilePlugin extends Plugin {
  store!: MobileStore;
  settings!: MobileSettings;
  runtime!: MobileRuntime;
  private settingsWrites: Promise<void> = Promise.resolve();
  async onload(): Promise<void> {
    try {
      this.settings = loadMobileSettings(await this.loadData());
      this.store = new MobileStore(this.app.vault.adapter, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/mobile`);
      await this.store.load();
      this.runtime = new MobileRuntime(this.app, this.store, () => this.settings, requestUrl);
      this.registerView(MOBILE_VIEW, leaf => new EchoInkMobileView(leaf, this));
      this.addRibbonIcon("bot", "打开 EchoInk", () => { void this.open().catch(error => new Notice(String(error))); });
      this.addCommand({ id: "open-echoink-mobile", name: "打开移动对话", callback: () => { void this.open().catch(error => new Notice(String(error))); } });
      this.addCommand({ id: "echoink-mobile-current-note", name: "在 EchoInk 中引用当前笔记", callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension === "md") this.store.session.notePath = file.path;
        void this.store.save().then(() => this.open()).catch(error => new Notice(String(error)));
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
    const leaf = this.app.workspace.getLeavesOfType(MOBILE_VIEW)[0] ?? this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: MOBILE_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  onunload(): void { this.runtime?.stop(); }
}

class EchoInkMobileView extends ItemView {
  private ui?: MobileUI;
  private markdown = new Component();
  constructor(leaf: WorkspaceLeaf, private plugin: EchoInkMobilePlugin) { super(leaf); }
  getViewType() { return MOBILE_VIEW; }
  getDisplayText() { return "EchoInk"; }
  getIcon() { return "bot"; }
  async onOpen(): Promise<void> {
    this.addChild(this.markdown);
    this.ui = new MobileUI(this.contentEl, {
      app: this.app, store: this.plugin.store, runtime: this.plugin.runtime,
      settings: () => this.plugin.settings,
      saveSettings: () => this.plugin.saveSettings(),
      openNote: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !("extension" in file)) throw new Error("笔记不存在。");
        await this.app.workspace.getLeaf("tab").openFile(file as TFile);
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
