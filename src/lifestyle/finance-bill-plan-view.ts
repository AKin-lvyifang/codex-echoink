import { capabilityMessage } from "../membership/access";
import { setIcon } from "obsidian";
import type { LifestyleService } from "./service";
import type { FinanceBillPlan, FinanceEntry } from "./store";
import { financePage, financePagination, fitFinanceList } from "./finance-pagination";
import { FinanceNumbers } from "./finance-number";
import { financeCategoryDonut } from "./finance-category-donut";
import { financeActionButton } from "./finance-action-button";
import { money } from "./finance-domain";
import { financeCategoryVisual } from "./finance-catalog";
import { emptyFinanceBillPlanFilters, filterFinanceBillPlanEntries, reconcileFinanceBillPlanSelection, sortFinanceBillPlanEntries,
  type FinanceBillPlanFilters, type FinanceBillPlanSort } from "./finance-bill-plan";
import { createOriginCheck, disposeOriginControls } from "../settings/origin-controls";

export interface FinanceBillPlanViewState {
  section: "list" | "dashboard" | "associate"; planId: string | null;
  category: string | null; sort: FinanceBillPlanSort; listScroll: number; detailScroll: number;
}
export const initialFinanceBillPlanViewState = (): FinanceBillPlanViewState => ({ section: "list", planId: null, category: null, sort: "date-desc", listScroll: 0, detailScroll: 0 });
interface BillPlanActions {
  redraw: () => void; edit: (plan?: FinanceBillPlan) => void; add: (id: string) => void;
  transaction: (parent: HTMLElement, entry: FinanceEntry) => void;
}
const labels = { expense: "支出", income: "收入", refund: "退款", transfer: "转账" };
function button(parent: HTMLElement, text: string, run: () => void, cls = ""): HTMLButtonElement {
  const control = parent.createEl("button", { text, cls, attr: { type: "button" } }); control.onclick = run; return control;
}
function choice(parent: HTMLElement, label: string, values: [string, string][], current: string, onChange: (value: string) => void): HTMLSelectElement {
  const wrap = parent.createEl("label", { cls: "echoink-finance-select" }); wrap.createSpan({ text: label });
  const control = wrap.createEl("select"); for (const [value, text] of values) control.createEl("option", { value, text });
  control.value = current; control.onchange = () => onChange(control.value); return control;
}

/** The plan pages share the financial workspace; associations stay local until confirmed. */
export class FinanceBillPlanView {
  private detailPage = 1;
  private stopDetailSize: (() => void) | null = null;
  private categoryDonut: ReturnType<typeof financeCategoryDonut> | null = null;
  private readonly numbers = new FinanceNumbers();
  private host: HTMLElement | null = null;
  private selected = new Set<string>();
  private filters: FinanceBillPlanFilters = emptyFinanceBillPlanFilters();
  private saving = false;
  private message = "";
  private pageChanged = false;
  private associationScroll = 0;
  private sizeObserver: ResizeObserver | null = null;
  private sizeFrame = 0;
  private stopResize: (() => void) | null = null;
  constructor(private readonly service: LifestyleService, readonly state: FinanceBillPlanViewState, private readonly actions: BillPlanActions) {}
  get busy(): boolean { return this.saving; }
  dispose(clearHistory = false): void {
    if (clearHistory) this.numbers.release(); else this.numbers.begin(); this.stopDetailSize?.(); this.stopDetailSize = null; this.categoryDonut = null;
    const rows = this.host?.querySelector<HTMLElement>(".echoink-finance-bill-association-content");
    if (rows) this.associationScroll = rows.scrollTop;
    this.sizeObserver?.disconnect(); this.sizeObserver = null;
    if (this.sizeFrame) this.host?.ownerDocument.defaultView?.cancelAnimationFrame(this.sizeFrame);
    this.sizeFrame = 0; this.stopResize?.(); this.stopResize = null;
    if (this.host) disposeOriginControls(this.host); this.host = null;
  }
  finishNumbers(): void { this.numbers.end(); }
  enterNumbers(): void { this.numbers.begin(true); }
  private fitAssociation(parent: HTMLElement): void {
    const scroller = this.scroll(); const win = parent.ownerDocument.defaultView;
    if (!scroller || !win) return;
    const fit = () => {
      const top = parent.getBoundingClientRect().top + scroller.scrollTop;
      const bottom = Math.min(scroller.getBoundingClientRect().bottom, win.innerHeight);
      const inset = Math.max(12, Number.parseFloat(win.getComputedStyle(parent.parentElement!).paddingBottom) || 0);
      const height = `${Math.max(0, Math.floor(bottom - top - inset))}px`;
      if (parent.style.height !== height) parent.style.height = height;
    };
    fit(); this.sizeFrame = win.requestAnimationFrame(() => { this.sizeFrame = 0; fit(); });
    if (typeof ResizeObserver !== "undefined") { this.sizeObserver = new ResizeObserver(fit); this.sizeObserver.observe(scroller); }
    win.addEventListener("resize", fit); this.stopResize = () => win.removeEventListener("resize", fit);
  }
  private scroll(): Element | null { return this.host?.closest(".echoink-lifestyle-view") ?? null; }
  private navigate(section: FinanceBillPlanViewState["section"], scroll = 0, focus = ""): void {
    if (this.saving) return;
    this.state.section = section; this.pageChanged = true; this.actions.redraw();
    const container = this.scroll(); if (container) container.scrollTop = scroll;
    const controls = this.host?.querySelectorAll<HTMLElement>("[data-plan-focus]");
    const target = focus ? Array.from(controls ?? []).find(control => control.dataset.planFocus === focus) : this.host?.querySelector<HTMLElement>(".echoink-finance-bill-heading");
    target?.focus({ preventScroll: true });
  }
  showPlan(id: string): void {
    this.detailPage = 1;
    this.state.listScroll = this.scroll()?.scrollTop ?? 0; this.state.planId = id; this.state.category = null;
    this.navigate("dashboard");
  }
  private startAssociation(): void {
    this.state.detailScroll = this.scroll()?.scrollTop ?? 0; this.selected.clear(); this.filters = emptyFinanceBillPlanFilters(); this.message = ""; this.associationScroll = 0;
    this.navigate("associate");
  }
  render(parent: HTMLElement): void {
    this.host = parent.createDiv({ cls: `echoink-finance-bill-page${this.pageChanged ? " is-entering" : ""}` }); this.pageChanged = false;
    const plan = this.service.finance.billPlans().find(item => item.id === this.state.planId);
    if (this.state.section !== "list" && !plan) { this.state.section = "list"; this.state.planId = null; }
    if (this.state.section === "list") this.list(this.host);
    else if (this.state.section === "dashboard") this.dashboard(this.host, plan!);
    else this.association(this.host, plan!);
  }
  private heading(parent: HTMLElement, title: string, back?: () => void): HTMLElement {
    if (back) button(parent, "‹ 返回", back, "echoink-finance-bill-back").disabled = this.saving;
    const heading = parent.createDiv({ cls: "echoink-finance-section-head echoink-finance-bill-heading", attr: { tabindex: "-1" } });
    heading.createEl("h2", { text: title }); return heading;
  }
  private list(parent: HTMLElement): void {
    const head = this.heading(parent, "账单计划");
    const create = button(head, "新建账单", () => this.actions.edit(), "echoink-finance-primary");
    const notice = capabilityMessage(this.service.finance.access, "finance.bill_plan.write");
    create.disabled = !!notice;
    if (notice) parent.createEl("p", { cls: "echoink-finance-empty", text: notice });
    const plans = this.service.finance.billPlans();
    if (!plans.length) parent.createEl("p", { text: "还没有账单计划。先填名称和总预算，账目可随后添加。", cls: "echoink-finance-empty" });
    const list = parent.createDiv({ cls: "echoink-finance-bill-list" });
    for (const plan of plans) {
      const stats = this.service.finance.billPlanStats(plan.id);
      const row = button(list, "", () => this.showPlan(plan.id), "echoink-finance-bill-list-row"); row.dataset.planFocus = `plan:${plan.id}`;
      row.createEl("strong", { text: plan.name });
      row.createSpan({ text: `预算 ¥ ${money(plan.budgetCents)}` }); row.createSpan({ text: `已花 ¥ ${money(stats.netCents)}` });
      row.createSpan({ text: `${stats.remainingCents < 0 ? "超支" : "剩余"} ¥ ${money(Math.abs(stats.remainingCents))}`, cls: stats.remainingCents < 0 ? "echoink-life-error" : "" });
      setIcon(row.createSpan({ attr: { "aria-hidden": "true" } }), "chevron-right");
    }
  }
  private dashboard(parent: HTMLElement, plan: FinanceBillPlan): void {
    const stats = this.service.finance.billPlanStats(plan.id);
    const head = this.heading(parent, plan.name, () => this.navigate("list", this.state.listScroll, `plan:${plan.id}`));
    const actions = head.createDiv({ cls: "echoink-finance-bill-actions" });
    const writable = this.service.finance.access.checkCapability("finance.bill_plan.write");
    financeActionButton(actions, "修改预算", "pencil", () => this.actions.edit(plan)).disabled = !writable;
    const link = financeActionButton(actions, "关联已有记录", "link", () => this.startAssociation()); link.dataset.planFocus = "associate"; link.disabled = !writable;
    financeActionButton(actions, "记一笔", "plus", () => this.actions.add(plan.id), true).disabled = !writable;
    const summary = parent.createDiv({ cls: "echoink-finance-card echoink-finance-bill-summary" });
    const metrics = summary.createDiv({ cls: "echoink-finance-bill-metrics" });
    for (const [key, label, value] of [["budget", "总预算", plan.budgetCents], ["net", "净支出", stats.netCents], ["remaining", stats.remainingCents < 0 ? "超出预算" : "剩余预算", Math.abs(stats.remainingCents)]] as const) {
      const metric = metrics.createDiv(); metric.createEl("small", { text: label }); this.numbers.mount(metric.createEl("strong"), `bill:${key}`, value);
    }
    const progress = summary.createDiv({ cls: "echoink-finance-progress", attr: { role: "progressbar", "aria-label": "预算使用", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(stats.progress * 100)), "aria-valuetext": `净支出 ${money(stats.netCents)} 元，总预算 ${money(plan.budgetCents)} 元` } });
    progress.createDiv({ attr: { style: `width:${stats.progress * 100}%` } });
    summary.createEl("p", { text: `支出原额 ¥ ${money(stats.grossCents)} · 退款 ¥ ${money(stats.refundsCents)} · 全周期` });
    const extremes = parent.createDiv({ cls: "echoink-finance-bill-extremes" });
    for (const [label, record] of [["最大一笔", stats.largest], ["最小一笔", stats.smallest]] as const) {
      const item = extremes.createDiv(); item.createSpan({ text: label }); item.createEl("strong", { text: record ? `¥ ${money(record.amountCents)}` : "—" });
      item.createEl("small", { text: record ? `${record.merchant} · ${record.date.slice(0, 10)}` : "暂无有效支出" });
    }
    const average = extremes.createDiv(); average.createSpan({ text: "平均每笔支出" }); average.createEl("strong", { text: stats.averageCents === null ? "—" : `¥ ${money(stats.averageCents)}` }); average.createEl("small", { text: `${stats.expenses.length} 笔有效支出` });
    const chart = parent.createDiv({ cls: "echoink-finance-card echoink-finance-bill-category" }); chart.createEl("h3", { text: "消费分类" });
    if (!stats.expenses.length) chart.createEl("p", { text: "尚无有效消费。关联记录或记一笔后，分类统计会自动更新。", cls: "echoink-finance-empty" });
    else {
      const layout = chart.createDiv({ cls: "echoink-finance-bill-chart" });
      this.categoryDonut = financeCategoryDonut(layout, stats.categories.map(([category, value]) => ({ category, amountCents: value.amountCents, color: financeCategoryVisual(category, this.service.plugin.settings.lifestyle.finance).color })), {
        label: "支出原额", bill: true, selected: () => this.state.category,
        onSelect: category => { this.detailPage = 1; this.state.category = category; this.updateDashboardRows(parent, stats.entries); }
      });
    }
    const details = parent.createDiv({ cls: "echoink-finance-card echoink-finance-bill-details" });
    const detailHead = details.createDiv({ cls: "echoink-finance-section-head" }); detailHead.createEl("h3", { text: "关联明细" });
    choice(detailHead, "排序", [["date-desc", "时间从新到旧"], ["amount-desc", "金额从大到小"], ["amount-asc", "金额从小到大"]], this.state.sort, value => { this.detailPage = 1; this.state.sort = value as FinanceBillPlanSort; this.updateDashboardRows(parent, stats.entries); });
    this.updateDashboardRows(parent, stats.entries);
  }
  private updateDashboardRows(parent: HTMLElement, entries: readonly FinanceEntry[]): void {
    this.categoryDonut?.sync(); this.stopDetailSize?.(); this.stopDetailSize = null;
    const details = parent.querySelector<HTMLElement>(".echoink-finance-bill-details")!;
    const old = details.querySelector<HTMLElement>(".echoink-finance-bill-detail-page"); if (old) { disposeOriginControls(old); old.remove(); }
    const pageHost = details.createDiv({ cls: "echoink-finance-bill-detail-page" });
    const rows = pageHost.createDiv({ cls: "echoink-finance-bill-detail-rows", attr: { tabindex: "0" } });
    if (this.state.category !== null) button(rows, `分类：${this.state.category || "未分类"} ×`, () => { this.detailPage = 1; this.state.category = null; this.updateDashboardRows(parent, entries); });
    const visible = sortFinanceBillPlanEntries(entries.filter(entry => this.state.category === null || entry.category === this.state.category), this.state.sort);
    rows.createEl("p", { text: `显示 ${visible.length} / ${entries.length} 笔`, cls: "echoink-finance-bill-note" });
    if (!visible.length) rows.createEl("p", { text: "当前账单没有匹配的记录。", cls: "echoink-finance-empty" });
    const page = financePage(visible, this.detailPage); this.detailPage = page.page;
    for (const entry of page.items) this.actions.transaction(rows, entry);
    const footer = financePagination(pageHost, page.page, page.pages, visible.length, target => {
      this.detailPage = target; this.updateDashboardRows(parent, entries);
      details.querySelector<HTMLElement>('button[aria-current="page"]')?.focus({ preventScroll: true });
    });
    this.stopDetailSize = fitFinanceList(rows, footer, 480, "viewport");
  }
  private association(parent: HTMLElement, plan: FinanceBillPlan): void {
    parent.addClass("echoink-finance-bill-association");
    const content = parent.createDiv({ cls: "echoink-finance-bill-association-content", attr: { tabindex: "0" } });
    const controls = content.createDiv({ cls: "echoink-finance-bill-association-controls" });
    const head = controls.createDiv({ cls: "echoink-finance-bill-association-head" });
    this.heading(head, `关联到「${plan.name}」`, () => this.navigate("dashboard", this.state.detailScroll, "associate"));
    controls.createEl("p", { cls: "echoink-finance-bill-note echoink-finance-bill-filter-result", attr: { role: "status", "aria-live": "polite" } });
    const filter = controls.createDiv({ cls: "echoink-finance-bill-filters" });
    for (const [key, label, type] of [["from", "开始日期", "date"], ["to", "结束日期", "date"], ["search", "搜索商户、说明或备注", "search"]] as const) {
      const wrap = filter.createEl("label", { cls: "echoink-finance-field" }); wrap.createSpan({ text: label });
      const control = wrap.createEl("input", { attr: { type, "data-plan-filter": key } }); control.value = this.filters[key]; control.disabled = this.saving;
      control.oninput = () => { this.filters[key] = control.value; this.updateAssociationRows(parent, plan); };
    }
    const entries = this.service.finance.entries();
    for (const [key, label] of [["category", "分类"], ["merchant", "商户"], ["account", "账户"]] as const) {
      const values = [...new Set(entries.map(entry => entry[key]))].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
      choice(filter, label, [["", `全部${label}`], ...values.map((value): [string, string] => [value, value])], this.filters[key], value => { this.filters[key] = value; this.updateAssociationRows(parent, plan); }).disabled = this.saving;
    }
    choice(filter, "收支类型", [["all", "全部类型"], ["spending", "消费与退款"], ...Object.entries(labels)], this.filters.kind, value => { this.filters.kind = value as FinanceBillPlanFilters["kind"]; this.updateAssociationRows(parent, plan); }).disabled = this.saving;
    this.updateAssociationRows(parent, plan); this.fitAssociation(parent);
    content.scrollTop = this.associationScroll;
  }
  private updateAssociationRows(parent: HTMLElement, plan: FinanceBillPlan): void {
    const focused = parent.ownerDocument.activeElement as HTMLElement | null;
    const focusId = focused?.dataset.planEntryId; const focusAll = focused?.dataset.planSelectAll;
    const content = parent.querySelector<HTMLElement>(".echoink-finance-bill-association-content")!;
    this.associationScroll = content.querySelector(".echoink-finance-bill-select-rows") ? content.scrollTop : this.associationScroll;
    for (const old of Array.from(parent.querySelectorAll<HTMLElement>(".echoink-finance-bill-select-rows, .echoink-finance-bill-association-footer"))) { disposeOriginControls(old); old.remove(); }
    const invalidDates = !!(this.filters.from && this.filters.to && this.filters.from > this.filters.to);
    const visible = invalidDates ? [] : filterFinanceBillPlanEntries(this.service.finance.entries(), this.filters);
    reconcileFinanceBillPlanSelection(this.selected, visible, plan.id);
    const eligible = visible.filter(entry => entry.billPlanId !== plan.id);
    parent.querySelector<HTMLElement>(".echoink-finance-bill-filter-result")?.setText(`筛选 ${visible.length} 笔 · 可关联 ${eligible.length} 笔`);
    const rows = content.createDiv({ cls: "echoink-finance-bill-select-rows", attr: { "aria-label": "可关联账目", tabindex: "0" } });
    const footer = parent.createDiv({ cls: "echoink-finance-bill-association-footer" });
    const heading = footer.createDiv({ cls: "echoink-finance-bill-selection-summary" });
    const allLabel = heading.createEl("label", { cls: "echoink-finance-bill-check-label" });
    const all = createOriginCheck(allLabel, { attr: { "aria-label": "全选当前筛选结果", "data-plan-select-all": "true", "aria-description": "全选只作用于当前筛选结果；改变筛选会移除不可见勾选" } }); allLabel.createSpan({ text: "全选当前结果" });
    all.checked = eligible.length > 0 && eligible.every(entry => this.selected.has(entry.id)); all.indeterminate = this.selected.size > 0 && !all.checked; all.disabled = this.saving || !eligible.length;
    all.onchange = () => { for (const entry of eligible) { if (all.checked) this.selected.add(entry.id); else this.selected.delete(entry.id); } this.updateAssociationRows(parent, plan); };
    const moved = visible.filter(entry => this.selected.has(entry.id) && entry.billPlanId && entry.billPlanId !== plan.id).length;
    heading.createSpan({ text: `已选 ${this.selected.size} 笔${moved ? ` · 从其他账单移入 ${moved} 笔` : ""}`, attr: { role: "status", "aria-live": "polite" } });
    if (moved) rows.createEl("p", { text: `确认后，将有 ${moved} 笔从其他账单移入「${plan.name}」。`, cls: "echoink-finance-bill-move-notice" });
    if (invalidDates) rows.createEl("p", { text: "开始日期不能晚于结束日期。", cls: "echoink-life-error" });
    if (!visible.length) rows.createEl("p", { text: "当前条件没有匹配记录。", cls: "echoink-finance-empty" });
    const plans = new Map(this.service.finance.billPlans().map(item => [item.id, item.name]));
    for (const entry of visible) {
      const row = rows.createEl("label", { cls: "echoink-finance-bill-select-row" });
      const check = createOriginCheck(row, { attr: { "aria-label": `选择${entry.merchant}，${entry.date}，${money(entry.amountCents)}元`, "data-plan-entry-id": entry.id } });
      check.checked = this.selected.has(entry.id); check.disabled = this.saving || entry.billPlanId === plan.id;
      check.onchange = () => { if (check.checked) this.selected.add(entry.id); else this.selected.delete(entry.id); this.updateAssociationRows(parent, plan); };
      const copy = row.createDiv(); copy.createEl("strong", { text: entry.merchant }); copy.createEl("small", { text: `${entry.description || entry.category} · ${entry.date.slice(0, 10)} · ${entry.account}` });
      copy.createEl("small", { text: entry.billPlanId === plan.id ? "已关联当前账单" : entry.billPlanId ? `来自：${plans.get(entry.billPlanId) || "未找到原账单"}` : "未关联" });
      row.createSpan({ text: `${labels[entry.kind]} ¥ ${money(entry.amountCents)}` });
    }
    if (this.message) rows.createEl("p", { text: this.message, cls: "echoink-life-error", attr: { role: "alert" } });
    if (this.message) footer.createSpan({ text: "保存未完成，可重试未成功项", cls: "echoink-life-error" });
    const actions = footer.createDiv({ cls: "echoink-finance-dialog-actions" });
    button(actions, "取消", () => this.navigate("dashboard", this.state.detailScroll, "associate")).disabled = this.saving;
    button(actions, this.saving ? "保存中…" : `确认关联 ${this.selected.size} 笔`, () => void this.confirm(plan), "echoink-finance-primary").disabled = this.saving || !this.selected.size;
    content.scrollTop = this.associationScroll;
    if (focusId || focusAll) Array.from(parent.querySelectorAll<HTMLElement>("[data-plan-entry-id], [data-plan-select-all]")).find(control => focusId ? control.dataset.planEntryId === focusId : control.dataset.planSelectAll)?.focus({ preventScroll: true });
  }
  private async confirm(plan: FinanceBillPlan): Promise<void> {
    if (this.saving || !this.selected.size) return;
    const chosen = [...this.selected]; this.saving = true; this.message = ""; this.actions.redraw();
    try {
      const result = await this.service.finance.associateBillPlan(chosen, plan.id);
      for (const id of result.applied) this.selected.delete(id);
      if (result.failed.length) this.message = `已关联 ${result.applied.length} 笔，${result.failed.length} 笔未成功：${result.failed.map(item => item.error).join("；")}。可重试未成功项。`;
      else { this.selected.clear(); this.saving = false; this.navigate("dashboard", this.state.detailScroll, "associate"); return; }
    } catch (error) { this.message = `保存未完成：${error instanceof Error ? error.message : String(error)}。请核对记录后重试。`; }
    this.saving = false; this.actions.redraw();
  }
}
