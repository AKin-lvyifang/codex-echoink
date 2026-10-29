import { ProPluginControls } from "../ui/pro-plugin-controls";
import { Notice } from "obsidian";
import type { LifestylePluginHost, LifestyleHost } from "./host";
import { openFinanceIconPicker, financeIconOptions, renderFinanceIcon, type FinanceIconScope } from "./finance-icon-picker";
import type { FinanceSettings, FinanceAccountSetting, FinanceCategorySetting, FinanceMerchantSetting } from "./settings";
import { createOriginCheck, createOriginSwitch } from "../settings/origin-controls";
import { createSettingsState, showSettingsInlineConfirmation } from "../settings/settings-v2";
import { confirmModal } from "../ui/modals";
import { applyDeleteButton } from "../settings/amicro-buttons";
import { attachNativeTooltip } from "../ui/native-tooltip";

export type CatalogKind = "merchants" | "accounts" | "categories";
type CatalogItem = FinanceMerchantSetting | FinanceAccountSetting | FinanceCategorySetting;
const labels: Record<CatalogKind, string> = { merchants: "商户", accounts: "账户", categories: "分类" };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const aliases = (value: string): string[] => [...new Set(value.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean))];
const categoryColors = [
  ["松绿", "#5c8977"], ["橄榄绿", "#839d83"], ["青绿", "#4c9995"], ["湖蓝", "#5b95b0"], ["深蓝", "#597ca8"],
  ["靛蓝", "#777aaf"], ["紫罗兰", "#9b78a8"], ["玫红", "#b77d9e"], ["珊瑚红", "#c77970"], ["砖红", "#b76b5e"],
  ["赭橙", "#c28a60"], ["琥珀", "#c6a05e"], ["沙金", "#baa378"], ["芥末黄", "#b6a65d"], ["石灰绿", "#a4af6f"],
  ["灰绿", "#8da69a"], ["雾蓝", "#8aa5b4"], ["岩灰", "#92969c"], ["暖灰", "#a79a90"], ["深棕", "#8b7569"]
] as const;

function field(parent: HTMLElement, label: string, value = "", type = "text"): HTMLInputElement {
  const row = parent.createEl("label", { cls: "echoink-finance-field" });
  row.createSpan({ text: label });
  const input = row.createEl("input", { attr: { type } }); input.value = value;
  return input;
}

function choice(parent: HTMLElement, label: string, options: readonly [string, string][], value: string): HTMLSelectElement {
  const row = parent.createEl("label", { cls: "echoink-finance-select" });
  row.createSpan({ text: label });
  const input = row.createEl("select");
  for (const [key, text] of options) input.createEl("option", { value: key, text });
  input.value = value;
  return input;
}

/** Kept by LifestyleSettingsPanel across redraws; the list and editor are separate pages. */
export class FinanceCatalogPanel {
  private tooltipCleanups: Array<() => void> = [];
  private controls: ProPluginControls | null = null;
  private deletionAbort: AbortController | null = null;
  dispose(): void {
    for (const cleanup of this.tooltipCleanups) cleanup(); this.tooltipCleanups = [];
    this.deletionAbort?.abort(); this.deletionAbort = null;
    this.controls?.dispose(); this.controls = null;
  }
  private editing: number | null = null;
  private pending = false;
  private focusName = false;
  private focusRow: number | null = null;
  constructor(private readonly plugin: LifestylePluginHost & { lifestyle: LifestyleHost }, readonly kind: CatalogKind,
    private readonly exit: () => void, private readonly redraw: () => void,
    private readonly options: { embedded?: boolean } = {}) {}

  title(): string { return this.editing === null ? `管理${labels[this.kind]}` : `${this.editing < 0 ? "新增" : "编辑"}${labels[this.kind]}`; }
  backLabel(): string { return this.editing === null ? "返回财务设置" : `返回${labels[this.kind]}列表`; }
  navigationKey(): string { return `finance:${this.kind}:${this.editing === null ? "list" : `editor:${this.editing}`}`; }
  isPending(): boolean { return this.pending; }
  back(): void {
    if (this.pending) return;
    if (this.editing === null) this.exit();
    else { this.focusRow = this.editing; this.editing = null; this.redraw(); }
  }
  private items(): CatalogItem[] { return this.plugin.settings.lifestyle.finance[this.kind]; }
  private async update(items: CatalogItem[]): Promise<void> {
    await this.plugin.lifestyle.finance.saveCatalog(this.kind, items as FinanceSettings[CatalogKind]);
  }
  private async removeItem(item: CatalogItem): Promise<void> {
    if (this.pending || !this.plugin.lifestyle.finance.accessState().canWrite) return;
    const controller = new AbortController();
    this.deletionAbort = controller;
    this.pending = true; this.controls?.refresh();
    let saved = false;
    try {
      const accepted = await confirmModal(this.plugin.app, `删除${labels[this.kind]}`,
        `删除「${item.name}」？已有账目和预算不会删除。`, "删除", "取消", { signal: controller.signal, deleteAction: true });
      if (!accepted || controller.signal.aborted) return;
      const items = this.items();
      if (!items.includes(item)) return;
      await this.update(items.filter((current) => current !== item));
      saved = true;
    } catch (error) {
      new Notice(errorText(error));
    } finally {
      if (this.deletionAbort === controller) this.deletionAbort = null;
      this.pending = false; this.controls?.refresh();
      if (saved && !controller.signal.aborted) this.redraw();
    }
  }
  private confirmEmbeddedRemoval(item: CatalogItem, row: HTMLElement, trigger: HTMLButtonElement): void {
    if (this.pending || !this.plugin.lifestyle.finance.accessState().canWrite) return;
    showSettingsInlineConfirmation(row, trigger, {
      deleteAction: true,
      message: `删除「${item.name}」？已有账目和预算不会删除。`, confirmLabel: "删除", cancelLabel: "取消",
      onConfirm: async () => {
        if (this.pending) return;
        if (!this.plugin.lifestyle.finance.accessState().canWrite) {
          createSettingsState(row, this.plugin.lifestyle.finance.accessState().reason ?? "需要有效 PRO，已有资料仍可查看。", "error");
          return;
        }
        this.pending = true; this.controls?.refresh();
        let saved = false;
        try {
          const items = this.items();
          if (!items.includes(item)) return;
          await this.update(items.filter(current => current !== item));
          saved = true;
        } catch (error) {
          row.querySelector(".echoink-settings-state")?.remove();
          createSettingsState(row, errorText(error), "error");
        } finally {
          this.pending = false; this.controls?.refresh();
          if (saved) this.redraw();
        }
      }
    });
  }
  private openEditor(index: number): void {
    if (this.pending) return;
    this.editing = index; this.focusName = true; this.redraw();
  }
  render(content: HTMLElement): void {
    this.dispose();
    this.controls = new ProPluginControls(this.plugin.lifestyle.finance.access, () => this.plugin.lifestyle.finance.accessState());
    const back = content.querySelector<HTMLButtonElement>(":scope > .echoink-life-settings-back");
    if (back) this.controls.bind(back, { businessDisabled: () => this.pending, needsWrite: () => false });
    content.addClass("echoink-finance-catalog-page");
    content.toggleClass("echoink-finance-catalog-embedded", this.options.embedded === true);
    if (this.editing === null) this.renderList(content);
    else this.renderEditor(content);
  }
  private renderList(content: HTMLElement): void {
    content.createEl("p", { cls: "echoink-life-hint", text: this.kind === "categories"
      ? "停用或改名只影响以后选择；已有账目和月度预算金额保持原样。"
      : "名称与别名用于以后匹配；已有账目不会被批量改写。" });
    const list = content.createDiv({ cls: "echoink-finance-catalog-list" });
    for (const [index, item] of this.items().entries()) {
      const row = list.createDiv({ cls: "echoink-finance-catalog-item" });
      const edit = row.createEl("button", { cls: "echoink-finance-catalog-edit", attr: { type: "button", "data-catalog-index": String(index) } });
      const copy = edit.createDiv(); copy.createEl("strong", { text: item.name });
      const detail = this.kind === "categories" ? (item as FinanceCategorySetting).icon
        : this.kind === "merchants" ? `${(item as FinanceMerchantSetting).aliases.join("、") || "无别名"} · ${(item as FinanceMerchantSetting).defaultCategory || "无默认分类"}`
          : (item as FinanceAccountSetting).aliases.join("、") || "无别名";
      copy.createEl("small", { text: `${item.active ? "使用中" : "已停用"} · ${detail}` });
      edit.createSpan({ text: "›", cls: "echoink-finance-catalog-chevron", attr: { "aria-hidden": "true" } });
      edit.setAttr("aria-label", `编辑${item.name}`);
      edit.onclick = () => this.openEditor(index);
      const toggle = (this.options.embedded ? createOriginCheck : createOriginSwitch)(row, { attr: { "aria-label": `${item.active ? "停用" : "启用"}${item.name}` } });
      this.controls?.bind(toggle, { businessDisabled: () => this.pending });
      toggle.checked = item.active;
      toggle.onchange = () => {
        if (this.pending) return; this.pending = true; this.controls?.refresh();
        void this.update(this.items().map((current, position) => position === index ? { ...current, active: toggle.checked } : current))
          .then(() => { this.pending = false; this.redraw(); })
          .catch((error) => { this.pending = false; toggle.checked = item.active; this.controls?.refresh(); new Notice(errorText(error)); });
      };
      const remove = row.createEl("button", { text: "删除", attr: { type: "button" } });
      applyDeleteButton(remove);
      this.controls?.bind(remove, { businessDisabled: () => this.pending });
      remove.onclick = () => { if (this.options.embedded) this.confirmEmbeddedRemoval(item, row, remove); else void this.removeItem(item); };
    }
    const add = content.createEl("button", { text: `新增${labels[this.kind]}`, cls: "echoink-finance-catalog-add", attr: { type: "button" } });
    this.controls?.bind(add, { businessDisabled: () => this.pending });
    add.onclick = () => this.openEditor(-1);
    if (this.focusRow !== null) {
      const target = list.querySelector<HTMLButtonElement>(`[data-catalog-index="${this.focusRow}"]`) ?? add;
      this.focusRow = null;
      (content.ownerDocument.defaultView ?? window).requestAnimationFrame(() => target.isConnected && target.focus());
    }
  }
  private renderEditor(content: HTMLElement): void {
    const index = this.editing!;
    const existing = index >= 0 ? this.items()[index] : null;
    const form = content.createEl("form", { cls: "echoink-finance-form echoink-finance-catalog-form" });
    const name = field(form, "名称", existing?.name ?? ""); name.maxLength = 60; name.required = true;
    if (this.focusName) {
      this.focusName = false;
      (content.ownerDocument.defaultView ?? window).requestAnimationFrame(() => name.isConnected && name.focus({ preventScroll: true }));
    }
    const active = form.createDiv({ cls: "echoink-life-setting-row" });
    active.createSpan({ text: "启用" });
    const activeInput = (this.options.embedded ? createOriginCheck : createOriginSwitch)(active, { attr: { "aria-label": `启用${labels[this.kind]}` } }); activeInput.checked = existing?.active !== false;
    let aliasesInput: HTMLInputElement | null = null;
    let iconValue = this.kind === "categories" ? (existing as FinanceCategorySetting | null)?.icon ?? "package"
      : (existing as FinanceMerchantSetting | null)?.iconId ?? "auto";
    let categoryInput: HTMLSelectElement | null = null;
    let colorValue = this.kind === "categories" ? (existing as FinanceCategorySetting | null)?.color ?? categoryColors[0][1] : "";
    const iconPickerButton = (label: string, scope: FinanceIconScope): void => {
      const row = form.createDiv({ cls: "echoink-finance-icon-field" });
      row.createSpan({ text: label });
      const trigger = row.createEl("button", { cls: "echoink-finance-icon-trigger", attr: { type: "button" } });
      const art = trigger.createSpan({ cls: "echoink-finance-icon-art", attr: { "aria-hidden": "true" } });
      const text = trigger.createSpan(); trigger.createSpan({ text: "›", attr: { "aria-hidden": "true" } });
      const draw = (): void => {
        renderFinanceIcon(art, iconValue);
        text.setText(financeIconOptions(scope).find((option) => option.id === iconValue)?.name || iconValue);
        trigger.setAttr("aria-label", `${label}：${text.textContent}，进入选择`);
      };
      trigger.onclick = () => openFinanceIconPicker(content, form, scope, iconValue, (id) => { iconValue = id; draw(); }, trigger, this.plugin.app);
      draw();
    };
    if (this.kind !== "categories") aliasesInput = field(form, "别名（用逗号分隔）", existing && "aliases" in existing ? existing.aliases.join("，") : "");
    if (this.kind === "merchants") {
      const merchant = existing as FinanceMerchantSetting | null;
      iconValue = merchant?.iconId ?? "auto";
      iconPickerButton("品牌图标", "merchant");
      const categories = this.plugin.settings.lifestyle.finance.categories.filter((item) => item.active).map((item): [string, string] => [item.name, item.name]);
      categoryInput = choice(form, "默认分类", [["", "不预设"], ...categories], merchant?.defaultCategory ?? "");
    } else if (this.kind === "categories") {
      const category = existing as FinanceCategorySetting | null;
      iconValue = category?.icon ?? "package";
      iconPickerButton("分类图标", "category");
      const colorField = form.createDiv({ cls: "echoink-finance-color-field" });
      colorField.createSpan({ text: "分类颜色" });
      const palette = colorField.createDiv({ cls: "echoink-finance-color-palette", attr: { role: "group", "aria-label": "分类颜色预设" } });
      const options = categoryColors.some(([, color]) => color.toLowerCase() === colorValue.toLowerCase())
        ? categoryColors : [["当前颜色", colorValue] as const, ...categoryColors];
      for (const [name, color] of options) {
        const swatch = palette.createEl("button", { cls: "echoink-finance-color-swatch", attr: { type: "button", "aria-label": `${name} ${color}`, "aria-pressed": String(colorValue.toLowerCase() === color.toLowerCase()), title: `${name} ${color}` } });
        this.tooltipCleanups.push(attachNativeTooltip(swatch, `${name} ${color}`).dispose);
        swatch.style.setProperty("--finance-swatch", color);
        swatch.createSpan({ text: "✓", attr: { "aria-hidden": "true" } });
        swatch.onclick = () => { colorValue = color; for (const button of Array.from(palette.querySelectorAll<HTMLButtonElement>("button"))) button.setAttr("aria-pressed", String(button === swatch)); };
      }
    }
    const error = form.createEl("p", { cls: "echoink-life-error", attr: { role: "alert" } });
    const actions = form.createDiv({ cls: "echoink-finance-dialog-actions" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.onclick = () => this.back();
    const save = actions.createEl("button", { text: "保存", cls: "echoink-finance-primary", attr: { type: "submit" } });
    this.controls?.bind(save, { businessDisabled: () => this.pending });
    form.onsubmit = (event) => {
      event.preventDefault();
      if (this.pending) return;
      const nextName = name.value.trim();
      if (!nextName || (this.kind === "categories" && nextName === "未分配")) { error.setText("请填写有效名称"); return; }
      if (this.items().some((item, position) => position !== index && item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) { error.setText("名称已经存在"); return; }
      const common = { name: nextName, active: activeInput.checked };
      const item: CatalogItem = this.kind === "merchants"
        ? { ...common, aliases: aliases(aliasesInput!.value), iconId: iconValue, defaultCategory: categoryInput!.value }
        : this.kind === "accounts" ? { ...common, aliases: aliases(aliasesInput!.value) }
          : { ...common, icon: iconValue, color: colorValue };
      const items = [...this.items()];
      if (index === -1) items.push(item); else items[index] = item;
      this.pending = true; this.controls?.refresh(); cancel.disabled = true;
      void this.update(items).then(() => { this.pending = false; this.editing = null; this.focusRow = index; this.redraw(); new Notice(`${labels[this.kind]}设置已保存`); })
        .catch((cause) => { this.pending = false; error.setText(errorText(cause)); this.controls?.refresh(); cancel.disabled = false; });
    };
  }
}
