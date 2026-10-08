import { requireProPluginAction } from "../membership/access";
import * as path from "node:path";
import { Notice, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { pluginDataDir } from "../plugin/plugin-data-paths";
import { LifestyleStore } from "./store";
import type { LifestyleKind } from "./settings";
import { LifestyleView, LIFE_VIEW_TYPES } from "./view";
import { LifestyleFinanceService } from "./finance-service";

export class LifestyleService {
  readonly store: LifestyleStore;
  readonly finance: LifestyleFinanceService;
  private views = new Set<LifestyleView>();
  private disposed = false;

  constructor(readonly plugin: CodexForObsidianPlugin) {
    this.store = new LifestyleStore(path.join(pluginDataDir(plugin.getVaultPath(), plugin.getPluginDataDirName()), "lifestyle.json"));
    this.finance = new LifestyleFinanceService(this);
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;
    await this.store.initialize();
    if (this.disposed) return;
    this.plugin.registerView(LIFE_VIEW_TYPES.finance, (leaf: WorkspaceLeaf) => new LifestyleView(leaf, this, "finance"));
    this.plugin.addCommand({ id: "open-lifestyle-finance", name: "打开 财务", callback: () => void this.open("finance") });
    // Vault file indexes are populated with the layout. Do not hold plugin onload
    // open while waiting, or mistake an existing on-disk ledger for a new one.
    this.plugin.app.workspace.onLayoutReady(() => {
      if (this.disposed || (!this.plugin.settings.lifestyle.finance.enabled && !this.store.snapshot().financeEntries.length)) return;
      void this.finance.initialize().catch((error) => {
        if (!this.disposed) new Notice(`财务账本初始化未完成，原数据已保留：${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  registerView(view: LifestyleView): void { this.views.add(view); }
  unregisterView(view: LifestyleView): void { this.views.delete(view); }

  async open(kind: LifestyleKind, mode: "main" | "settings" = "main"): Promise<void> {
    if (this.disposed) return;
    try { requireProPluginAction(this.finance.access, this.plugin.settings.lifestyle.finance.enabled, "enter"); }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); return; }
    if (mode === "settings") { await this.plugin.openLifestyleSettings(kind); return; }
    if (!this.plugin.settings.lifestyle.finance.enabled) { new Notice("财务插件尚未开启"); return; }
    if (!this.plugin.app.workspace.layoutReady) { new Notice("工作区正在加载，请稍后打开财务"); return; }
    try { await this.finance.initialize(); }
    catch (error) { if (!this.disposed) new Notice(`财务账本尚未准备完成：${error instanceof Error ? error.message : String(error)}`); return; }
    if (this.disposed) return;
    const leaf = this.plugin.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: LIFE_VIEW_TYPES.finance, active: true });
    if (this.disposed) return;
    if (leaf.view instanceof LifestyleView) leaf.view.setMode(mode);
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async setEnabled(kind: LifestyleKind, enabled: boolean): Promise<void> {
    if (this.disposed) return;
    requireProPluginAction(this.finance.access, this.plugin.settings.lifestyle[kind].enabled, "toggle");
    const previous = this.plugin.settings.lifestyle[kind].enabled;
    this.plugin.settings.lifestyle[kind].enabled = enabled;
    try { await this.plugin.saveSettings(true); }
    catch (error) { this.plugin.settings.lifestyle[kind].enabled = previous; throw error; }
    if (this.disposed) return;
    if (enabled && this.plugin.app.workspace.layoutReady) {
      try { await this.finance.initialize(); }
      catch (error) { if (!this.disposed) new Notice(`财务账目尚未准备完成：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (this.disposed) return;
    if (!enabled) this.finance.cancelAll();
    this.refresh();
    this.plugin.notifyHomeSurfacesChanged();
  }

  refresh(): void { if (!this.disposed) for (const view of this.views) view.render(); }
  dispose(): void {
    this.disposed = true;
    for (const view of this.views) view.releaseResources();
    this.views.clear();
    this.finance.cancelAll();
  }
  label(_kind: LifestyleKind): string { return "财务"; }
}
