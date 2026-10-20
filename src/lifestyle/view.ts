import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type { LifestyleHost } from "./host";
import type { LifestyleKind } from "./settings";
import { FinanceWorkspace } from "./finance-view";

export const LIFE_VIEW_TYPES: Record<LifestyleKind, string> = { finance: "echoink-lifestyle-finance" };

export class LifestyleView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private financeUnsubscribe: (() => void) | null = null;
  private readonly financeWorkspace: FinanceWorkspace;
  constructor(leaf: WorkspaceLeaf, private readonly service: LifestyleHost, readonly kind: LifestyleKind) {
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
    disposeOriginControls(this.contentEl);
    this.service.unregisterView(this);
  }
  releaseResources(): void { this.financeWorkspace.detach(); disposeOriginControls(this.contentEl); }
  setMode(_mode: "main" | "settings"): void { this.render(); }
  render(): void {
    const scroll = this.contentEl.scrollTop;
    this.financeWorkspace.detach();
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    this.contentEl.addClass("echoink-lifestyle-view");
    this.contentEl.toggleClass("echoink-finance-navigation", Platform.isDesktopApp);
    if (!this.service.plugin.settings.lifestyle.finance.enabled) {
      const empty = this.contentEl.createDiv({ cls: "echoink-life-disabled" });
      if (Platform.isDesktopApp) this.addWorkbenchBack(empty);
      empty.createEl("h2", { text: "财务插件已关闭" });
      empty.createEl("p", { text: "数据已保留。可在设置 → 资源 → 插件中重新开启。" });
      return;
    }
    const shell = this.contentEl.createDiv({ cls: "echoink-life-shell echoink-life-finance" });
    const header = shell.createEl("header", { cls: "echoink-life-header" });
    const identity = header.createDiv({ cls: Platform.isDesktopApp ? "echoink-module-identity" : "" });
    if (Platform.isDesktopApp) this.addWorkbenchBack(identity);
    const title = Platform.isDesktopApp ? identity.createDiv() : identity;
    title.createEl("small", { text: "ECHOINK / LIFE" });
    title.createEl("h1", { text: "财务" });
    const actions = header.createDiv({ cls: "echoink-life-header-actions" });
    const back = actions.createEl("button", { text: "设置" });
    back.onclick = () => void this.service.plugin.openLifestyleSettings("finance");
    if (Platform.isDesktopApp && this.service.plugin.prefillWorkbenchModule && this.service.plugin.getWorkbenchModuleOwner) {
      const handoff = createOriginButton(actions, { cls: "echoink-module-handoff", attr: { type: "button" } });
      applyAmicroButton(handoff, { variant: "primary" });
      const label = () => { handoff.textContent = `交给 ${this.service.plugin.getWorkbenchModuleOwner!("finance").name}`; };
      label(); handoff.onfocus = label; handoff.onpointerenter = label;
      handoff.onclick = () => {
        if (handoff.disabled) return;
        label(); handoff.disabled = true; setAmicroButtonPending(handoff, true);
        void this.service.plugin.prefillWorkbenchModule!("finance", `帮我看看 ${this.financeWorkspace.getSelectedMonth()} 的收支和预算`)
          .catch(error => new Notice(`暂时无法打开任务列表：${error instanceof Error ? error.message : String(error)}`))
          .finally(() => { handoff.disabled = false; setAmicroButtonPending(handoff, false); });
      };
    }
    const body = shell.createDiv({ cls: "echoink-life-body" });
    this.financeWorkspace.render(body);
    this.contentEl.scrollTop = scroll;
  }
  private addWorkbenchBack(parent: HTMLElement): void {
    if (!this.service.plugin.activateHomeView) return;
    const back = createOriginButton(parent, { cls: "echoink-module-back", attr: { type: "button", "aria-label": "返回工作台", title: "返回工作台" } });
    applyAmicroButton(back, { variant: "icon" }); setIcon(back, "arrow-left");
    back.onclick = () => { void this.service.plugin.activateHomeView!({ keepRightSidebar: true }).catch(error => new Notice(`暂时无法返回工作台：${error instanceof Error ? error.message : String(error)}`)); };
  }
}
