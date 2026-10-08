import { ProPluginControls } from "../ui/pro-plugin-controls";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { LifestyleKind } from "./settings";
import { FinanceCatalogPanel } from "./finance-catalog-dialog";
import { createSettingsNavigationRow } from "../settings/settings-v2";
import { createOriginSwitch } from "../settings/origin-controls";

export class LifestyleSettingsPanel {
  private controls: ProPluginControls | null = null;
  dispose(): void { this.controls?.dispose(); this.controls = null; this.financeCatalog?.dispose(); }
  private financeCatalog: FinanceCatalogPanel | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly kind: LifestyleKind,
    private readonly back: () => void, private readonly redraw: () => void) {}

  render(container: HTMLElement): void {
    this.dispose();
    const page = container.createDiv({ cls: "echoink-life-settings-page" });
    const back = page.createEl("button", { cls: "echoink-life-settings-back", text: `‹ ${this.financeCatalog?.backLabel() ?? "返回插件列表"}` });
    back.onclick = this.financeCatalog ? () => this.financeCatalog?.back() : this.back;
    back.disabled = this.financeCatalog?.isPending() ?? false;
    page.createEl("h2", { text: this.financeCatalog?.title() ?? `${this.plugin.lifestyle.label(this.kind)}设置` });
    this.controls = new ProPluginControls(this.plugin.lifestyle.finance.access, () => this.plugin.lifestyle.finance.accessState());
    if (this.financeCatalog) this.financeCatalog.render(page);
    else this.renderFinance(page);

  }

  navigationKey(): string { return this.financeCatalog?.navigationKey() ?? "finance:root"; }

  private renderFinance(page: HTMLElement): void {
    const settings = this.plugin.settings.lifestyle.finance;
    this.toggle(page, "AI 分析", "默认关闭；仅在开启后显示分析模块，关闭模型不影响记账和预算。", settings.aiEnabled, async (value) => {
      await this.plugin.lifestyle.finance.saveOption("aiEnabled", value);
    });
    this.toggle(page, "导入时智能整理", "使用当前模型提出商户、账户、分类与图标建议；失败时仍可基础导入。", settings.importAiEnabled, async (value) => {
      await this.plugin.lifestyle.finance.saveOption("importAiEnabled", value);
    });
    for (const [kind, title, detail] of [
      ["merchants", "管理商户", "维护名称、别名、真实品牌图标与默认分类。"],
      ["accounts", "管理账户", "把支付方式映射为自己的账户名称。"],
      ["categories", "管理分类", "自定义图标和颜色；历史账目与预算保持原样。"]
    ] as const) {
      createSettingsNavigationRow(page, { title, description: detail, focusKey: `finance-catalog:${kind}`,
        onActivate: () => {
          this.financeCatalog = new FinanceCatalogPanel(this.plugin, kind,
            () => { this.financeCatalog?.dispose(); this.financeCatalog = null; this.redraw(); }, this.redraw);
          this.redraw();
        } });
    }
    this.toggle(page, "在首页显示", "关闭后首页不留空位；数据和工作区保留。", this.plugin.settings.homeModules.finance !== false, async (value) => {
      await this.plugin.lifestyle.finance.saveOption("showOnHome", value);
    });
  }

  private toggle(page: HTMLElement, title: string, detail: string, checked: boolean, save: (value: boolean) => Promise<void>): void {
    const row = page.createDiv({ cls: "echoink-life-setting-row" });
    const copy = row.createDiv(); copy.createEl("strong", { text: title }); copy.createEl("small", { text: detail });
    const input = createOriginSwitch(row, { attr: { "aria-label": title } }); input.checked = checked;
    let pending = false;
    this.controls?.bind(input, { businessDisabled: () => pending });
    input.onchange = () => {
      const previous = !input.checked;
      if (pending) return; pending = true; this.controls?.refresh();
      void save(input.checked).then(() => new Notice("设置已保存"))
        .catch((error) => { input.checked = previous; new Notice(String(error)); })
        .finally(() => { pending = false; this.controls?.refresh(); });
    };
  }
}
