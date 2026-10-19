import { ProPluginControls } from "../ui/pro-plugin-controls";
import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { LifestyleKind } from "./settings";
import { FinanceCatalogPanel } from "./finance-catalog-dialog";
import { attachSettingsTooltip, createSettingsNavigationRow } from "../settings/settings-v2";
import { createOriginCheck, createOriginInput, createOriginSwitch, disposeOriginControls } from "../settings/origin-controls";

export class LifestyleSettingsPanel {
  private controls: ProPluginControls | null = null;
  private page: HTMLElement | null = null;
  private embedded = false;
  dispose(): void { this.controls?.dispose(); this.controls = null; this.financeCatalog?.dispose(); if (this.page) disposeOriginControls(this.page); }
  private financeCatalog: FinanceCatalogPanel | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly kind: LifestyleKind,
    private readonly back: () => void, private readonly redraw: () => void) {}

  render(container: HTMLElement, options: { embedded?: boolean } = {}): void {
    this.dispose();
    this.embedded = options.embedded === true;
    const page = this.page = container.createDiv({ cls: "echoink-life-settings-page" });
    if (this.embedded && this.financeCatalog) page.addClass("echoink-module-detail");
    if (!this.embedded || this.financeCatalog) {
    const back = page.createEl("button", { cls: "echoink-life-settings-back", text: `‹ ${this.financeCatalog?.backLabel() ?? "返回插件列表"}` });
    back.onclick = this.financeCatalog ? () => this.financeCatalog?.back() : this.back;
    back.disabled = this.financeCatalog?.isPending() ?? false;
    page.createEl("h2", { text: this.financeCatalog?.title() ?? `${this.plugin.lifestyle.label(this.kind)}设置` });
    }
    this.controls = new ProPluginControls(this.plugin.lifestyle.finance.access, () => this.plugin.lifestyle.finance.accessState());
    if (this.financeCatalog) this.financeCatalog.render(page);
    else this.renderFinance(page);

  }

  navigationKey(): string { return this.financeCatalog?.navigationKey() ?? "finance:root"; }

  private renderFinance(page: HTMLElement): void {
    const settings = this.plugin.settings.lifestyle.finance;
    if (this.embedded) {
      const location = page.createDiv({ cls: "echoink-life-setting-row echoink-finance-root-location" });
      location.createEl("strong", { text: "保存位置" });
      location.createSpan({ cls: "echoink-module-path-value", text: this.plugin.lifestyle.finance.ledger.paths().root });
    }
    const analysis = this.toggle(page, "AI 分析", "默认关闭；仅在开启后显示分析模块，关闭模型不影响记账和预算。", settings.aiEnabled, async (value) => {
      await this.plugin.lifestyle.finance.saveOption("aiEnabled", value);
    });
    const location = page.createDiv({ cls:"echoink-life-setting-row echoink-finance-analysis-location" });
    const copy=location.createDiv();copy.createEl("strong",{text:"分析保存位置"});
    copy.createEl("small",{text:"留空使用当前财务目录下的分析记录；改位置仅影响后续生成，旧报告保留。填写当前 Vault 内的相对目录。"});
    const form=location.createEl("form",{cls:"echoink-finance-form"});
    const input=createOriginInput(form,{attr:{type:"text","aria-label":"分析保存位置",placeholder:`${this.plugin.lifestyle.finance.ledger.paths().root}/分析记录`}});
    input.value=settings.analysisDirectory??"";
    const message=form.createEl("small",{attr:{role:"status"}});
    const save=form.createEl("button",{text:"保存位置",attr:{type:"submit"}});let saving=false;
    this.controls?.bind(save,{businessDisabled:()=>saving});
    this.controls?.bind(input,{businessDisabled:()=>saving});
    form.onsubmit=event=>{
      event.preventDefault();if(saving || save.disabled)return;saving=true;this.controls?.refresh();
      void this.plugin.lifestyle.finance.saveAnalysisDirectory(input.value).then(()=>{message.setText("保存位置已更新");})
        .catch(error=>{message.setText(error instanceof Error?error.message:String(error));})
        .finally(()=>{saving=false;this.controls?.refresh();});
    };
    const importAi = this.toggle(page, "导入时智能整理", "使用当前模型提出商户、账户、分类与图标建议；失败时仍可基础导入。", settings.importAiEnabled, async (value) => {
      await this.plugin.lifestyle.finance.saveOption("importAiEnabled", value);
    });
    const catalogs = [
      ["merchants", "管理商户", "维护名称、别名、真实品牌图标与默认分类。"],
      ["accounts", "管理账户", "把支付方式映射为自己的账户名称。"],
      ["categories", "管理分类", "自定义图标和颜色；历史账目与预算保持原样。"]
    ] as const;
    const orderedCatalogs = this.embedded ? [catalogs[2], catalogs[0], catalogs[1]] : catalogs;
    for (const [kind, title, detail] of orderedCatalogs) {
      const row = createSettingsNavigationRow(page, { title, description: this.embedded ? undefined : detail, value: this.embedded ? `${settings[kind].length} 个` : undefined, focusKey: `finance-catalog:${kind}`,
        onActivate: () => {
          this.financeCatalog = new FinanceCatalogPanel(this.plugin, kind,
            () => { this.financeCatalog?.dispose(); this.financeCatalog = null; this.redraw(); }, this.redraw, { embedded: this.embedded });
          this.redraw();
        } });
      if (this.embedded) {
        const help = row.querySelector<HTMLElement>(".echoink-settings-navigation-title")?.createSpan({ cls: "echoink-module-navigation-help", attr: { "aria-hidden": "true" } });
        if (help) setIcon(help, "circle-help");
        const activate = row.onclick;
        attachSettingsTooltip(row, detail);
        row.onclick = activate;
      }
    }
    if (this.embedded) page.append(importAi, analysis);

  }

  private toggle(page: HTMLElement, title: string, detail: string, checked: boolean, save: (value: boolean) => Promise<void>): HTMLElement {
    const row = page.createDiv({ cls: "echoink-life-setting-row" });
    const copy = row.createDiv({ cls: this.embedded ? "echoink-module-boolean-copy" : "" }); copy.createEl("strong", { text: title });
    if (this.embedded) {
      const wrapper = copy.createSpan({ cls: "echoink-settings-help" });
      const help = wrapper.createEl("button", { cls: "echoink-settings-help-trigger", attr: { type: "button", "aria-label": `${title}说明` } });
      setIcon(help, "circle-alert"); attachSettingsTooltip(help, detail, wrapper);
    } else copy.createEl("small", { text: detail });
    const input = (this.embedded ? createOriginCheck : createOriginSwitch)(row, { attr: { "aria-label": title } }); input.checked = checked;
    let pending = false;
    this.controls?.bind(input, { businessDisabled: () => pending });
    input.onchange = () => {
      const previous = !input.checked;
      if (pending) return; pending = true; this.controls?.refresh();
      void save(input.checked).then(() => new Notice("设置已保存"))
        .catch((error) => { input.checked = previous; new Notice(String(error)); })
        .finally(() => { pending = false; this.controls?.refresh(); });
    };
    return row;
  }
}
