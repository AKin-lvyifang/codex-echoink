import { Notice } from "obsidian";
import { requireProPluginAction } from "../membership/access";
import { LifestyleFinanceService } from "../lifestyle/finance-service";
import { LIFE_VIEW_TYPES } from "../lifestyle/view";
import type { LifestyleHost, LifestylePluginHost, LifestyleViewPort } from "../lifestyle/host";
import { mobileLifestyleStore } from "./finance-store";
import type { LifestyleStoreCore } from "../lifestyle/store-core";

export class MobileLifestyleService implements LifestyleHost {
  readonly store: LifestyleStoreCore;
  readonly finance: LifestyleFinanceService;
  private views = new Set<LifestyleViewPort>();
  private disposed = false;
  constructor(readonly plugin: LifestylePluginHost, root: string) {
    this.store = mobileLifestyleStore(plugin.app.vault.adapter, `${root}/lifestyle.json`);
    this.finance = new LifestyleFinanceService(this);
  }
  async initialize() { await this.store.initialize(); }
  registerView(view: LifestyleViewPort) { this.views.add(view); }
  unregisterView(view: LifestyleViewPort) { this.views.delete(view); }
  viewportRoot() { return [...this.views].find(view => view.contentEl?.isConnected)?.contentEl; }
  refresh() { if (!this.disposed) for (const view of this.views) view.render(); }
  async open(_kind: "finance", mode: "main" | "settings" = "main") {
    if (this.disposed) return;
    try {
      requireProPluginAction(this.finance.access, this.plugin.settings.lifestyle.finance.enabled, "enter");
      if (mode === "settings") { await this.plugin.openLifestyleSettings("finance"); return; }
      if (!this.plugin.settings.lifestyle.finance.enabled) throw new Error("财务插件尚未开启");
      await this.finance.initialize();
      if (this.disposed) return;
      const workspace = this.plugin.app.workspace;
      const leaf = workspace.getLeavesOfType(LIFE_VIEW_TYPES.finance).find(item => item.getRoot() === workspace.rootSplit) ?? workspace.getLeaf("tab");
      await leaf.setViewState({ type: LIFE_VIEW_TYPES.finance, active: true });
      await workspace.revealLeaf(leaf);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
  async setEnabled(_kind: "finance", enabled: boolean) {
    requireProPluginAction(this.finance.access, this.plugin.settings.lifestyle.finance.enabled, "toggle");
    const settings = this.plugin.settings.lifestyle.finance, previous = settings.enabled;
    settings.enabled = enabled;
    try { await this.plugin.saveSettings(true); }
    catch (error) { settings.enabled = previous; throw error; }
    if (enabled) await this.finance.initialize(); else this.finance.cancelAll();
    this.refresh(); this.plugin.notifyHomeSurfacesChanged();
  }
  dispose() { this.disposed = true; for (const view of this.views) view.releaseResources(); this.views.clear(); this.finance.cancelAll(); }
}
