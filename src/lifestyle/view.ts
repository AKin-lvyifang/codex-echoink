import { ItemView, WorkspaceLeaf } from "obsidian";
import type { LifestyleService } from "./service";
import type { LifestyleKind } from "./settings";
import { FinanceWorkspace } from "./finance-view";

export const LIFE_VIEW_TYPES: Record<LifestyleKind, string> = { finance: "echoink-lifestyle-finance" };

export class LifestyleView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private financeUnsubscribe: (() => void) | null = null;
  private readonly financeWorkspace: FinanceWorkspace;
  constructor(leaf: WorkspaceLeaf, private readonly service: LifestyleService, readonly kind: LifestyleKind) {
    super(leaf);
    this.financeWorkspace = new FinanceWorkspace(service);
  }
  getViewType(): string { return LIFE_VIEW_TYPES.finance; }
  getDisplayText(): string { return "财务"; }
  getIcon(): string { return "wallet"; }
  async onOpen(): Promise<void> {
    this.service.registerView(this);
    this.unsubscribe = this.service.store.subscribe(() => this.render());
    this.financeUnsubscribe = this.service.finance.subscribeEntries(() => this.render());
    this.render();
  }
  async onClose(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = null;
    this.financeUnsubscribe?.(); this.financeUnsubscribe = null;
    this.financeWorkspace.close(this.contentEl.scrollTop);
    this.service.unregisterView(this);
  }
  releaseResources(): void { this.financeWorkspace.detach(); }
  setMode(_mode: "main" | "settings"): void { this.render(); }
  render(): void {
    const scroll = this.contentEl.scrollTop;
    this.financeWorkspace.detach();
    this.contentEl.empty();
    this.contentEl.addClass("echoink-lifestyle-view");
    if (!this.service.plugin.settings.lifestyle.finance.enabled) {
      const empty = this.contentEl.createDiv({ cls: "echoink-life-disabled" });
      empty.createEl("h2", { text: "财务插件已关闭" });
      empty.createEl("p", { text: "数据已保留。可在设置 → 资源 → 插件中重新开启。" });
      return;
    }
    const shell = this.contentEl.createDiv({ cls: "echoink-life-shell echoink-life-finance" });
    const header = shell.createEl("header", { cls: "echoink-life-header" });
    const identity = header.createDiv();
    identity.createEl("small", { text: "ECHOINK / LIFE" });
    identity.createEl("h1", { text: "财务" });
    const actions = header.createDiv({ cls: "echoink-life-header-actions" });
    const back = actions.createEl("button", { text: "设置" });
    back.onclick = () => void this.service.plugin.openLifestyleSettings("finance");
    const body = shell.createDiv({ cls: "echoink-life-body" });
    this.financeWorkspace.render(body);
    this.contentEl.scrollTop = scroll;
  }
}
