import { ProPluginControls } from "../ui/pro-plugin-controls";
import type { Capability } from "../membership/types";
import { capabilityMessage } from "../membership/access";
import { Component, MarkdownRenderer, Modal, Notice, setIcon } from "obsidian";
import type { LifestyleService } from "./service";
import { lifeId, type FinanceBillPlan, type FinanceBudget, type FinanceContinuousGoal, type FinanceEntry, type FinanceGoal, type FinanceKind } from "./store";
import { effectiveFinanceBudget, FinanceBudgetEditor, parseFinanceBudgetDraft, type FinanceBudgetChanges, type FinanceBudgetDraft } from "./finance-budget";
import { financeGoalProgress } from "./finance-goals";
import {
  budgetUnallocated, effectiveFinanceEntries, filterFinanceEntries,
  financeSummary, financeSpendingFacts, localDate, money, parseYuan, readFinanceBill,
  type FinanceCategory, type FinanceFilters, type FinanceImportRow, type FinanceSummary
} from "./finance-domain";
import { FINANCE_CATEGORY_ICONS, financeBrandDataUri, financeBrandLightBackdrop, financeCategoryNames, financeCategoryVisual, financeSelectableCategoryNames, resolveFinanceAccount, resolveFinanceMerchant } from "./finance-catalog";
import type { FinanceSettings } from "./settings";
import { financeIconOptions, openFinanceIconPicker, renderFinanceIcon } from "./finance-icon-picker";
import { FINANCE_ANALYSIS_PROMPT_VERSION } from "./finance-service";
import { financeDailyWeeks, type FinanceReportSnapshot, type FinanceChartSnapshot, type FinanceReportBlock, type FinanceTableSnapshot } from "./finance-analysis";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { renderAnimateIcon } from "../ui/animate-icon";

import { disposeOriginControls } from "../settings/origin-controls";
import { financePage, financePagination, fitFinanceList } from "./finance-pagination";
import { FinanceNumbers } from "./finance-number";
import { financeCategoryDonut } from "./finance-category-donut";
import { financeActionButton } from "./finance-action-button";
import { FinanceBillPlanView, initialFinanceBillPlanViewState, type FinanceBillPlanViewState } from "./finance-bill-plan-view";

type FinancePage = "overview" | "ledger" | "budget" | "billPlans";
type BudgetMode = "amount" | "percent";
interface FinanceState { billPlans?: FinanceBillPlanViewState; page: FinancePage; month: string; mix: "expense" | "income"; chartCategory?: string | null; recentDate?: string | null; groupIntent: "expense-rest" | "income-rest" | null; filters: FinanceFilters; filterLabel?: string; returnScroll?: number; scroll: number }
const emptyFilters = (): FinanceFilters => ({ search: "", merchant: "", category: "", kind: "all", account: "", excludedCategories: [], excludedIds: [] });
const initialState = (): FinanceState => ({ page: "overview", month: localDate().slice(0, 7), mix: "expense", groupIntent: null, filters: emptyFilters(), scroll: 0 });
let lastClosedState: FinanceState | null = null;
const labels: Record<FinanceKind, string> = { expense: "支出", income: "收入", refund: "退款", transfer: "转账" };
function categoryIcon(parent: HTMLElement, category: FinanceCategory, cls: string, settings: FinanceSettings): HTMLElement {
  const visual = financeCategoryVisual(category, settings);
  const icon = parent.createSpan({ cls, attr: { "aria-hidden": "true" } });
  icon.style.setProperty("--finance-category-color", visual.color);
  setIcon(icon, visual.icon);
  return icon;
}
function merchantIcon(parent: HTMLElement, entry: FinanceEntry, settings: FinanceSettings): HTMLElement {
  const icon = parent.createSpan({ cls: "echoink-finance-merchant-icon", attr: { "aria-hidden": "true" } });
  const choice = entry.icon && entry.icon !== "auto" ? entry.icon : resolveFinanceMerchant(entry.merchant, settings).iconId;
  const artwork = financeBrandDataUri(choice);
  if (artwork) { icon.toggleClass("has-light-backdrop", financeBrandLightBackdrop(choice)); icon.createEl("img", { attr: { src: artwork, alt: "" } }); }
  else setIcon(icon, FINANCE_CATEGORY_ICONS.includes(choice) ? choice : financeCategoryVisual(entry.category, settings).icon);
  return icon;
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const yuanInput = (value: number): string => (value / 100).toFixed(2);

function monthShift(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number);
  const date = new Date(year, number - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function button(parent: HTMLElement, label: string, action: () => void, cls = ""): HTMLButtonElement {
  const element = parent.createEl("button", { text: label, cls });
  element.type = "button";
  element.onclick = action;
  return element;
}

function field(parent: HTMLElement, label: string, type = "text", value = ""): HTMLInputElement {
  const row = parent.createEl("label", { cls: "echoink-finance-field" });
  row.createEl("span", { text: label });
  const input = row.createEl("input", { attr: { type } });
  input.value = value;
  return input;
}

function select(parent: HTMLElement, label: string, choices: readonly [string, string][], value: string, onChange: (value: string) => void): HTMLSelectElement {
  const row = parent.createEl("label", { cls: "echoink-finance-select" });
  row.createEl("span", { text: label });
  const element = row.createEl("select");
  for (const [key, text] of choices) element.createEl("option", { value: key, text });
  element.value = value;
  element.onchange = () => onChange(element.value);
  return element;
}

class FinanceDialog extends Modal {
  whenClosed?: () => void;
  private controls?: ProPluginControls;
  bindWrite(control: HTMLButtonElement, businessDisabled: () => boolean = () => false, needsWrite?: () => boolean, capability?: Capability): void { this.controls?.bind(control, { businessDisabled, needsWrite, capability }); }
  refreshAccess(): void { this.controls?.refresh(); }
  constructor(private readonly service: LifestyleService, private readonly title: string, private readonly draw: (content: HTMLElement, dialog: FinanceDialog) => void) {
    super(service.plugin.app);
  }
  onOpen(): void {
    this.modalEl.addClass("echoink-finance-dialog");
    this.titleEl.setText(this.title);
    this.controls = new ProPluginControls(this.service.finance.access, () => this.service.finance.accessState());
    this.draw(this.contentEl, this);
  }
  onClose(): void { this.controls?.dispose(); this.whenClosed?.(); this.contentEl.empty(); }
}

export class FinanceWorkspace {
  private state: FinanceState = lastClosedState ? structuredClone(lastClosedState) : initialState();
  private host: HTMLElement | null = null;
  private inlineControls: ProPluginControls | null = null;
  private analysisError: { month: string; message: string; reportId: string | null } | null = null;
  private reportComponents: Component[] = [];
  private reportRenderTicket = 0;
  private unsubscribeMembership: (() => void) | null = null;
  private unsubscribeAnalysis: (() => void) | null = null;
  private tabsObserver: ResizeObserver | null = null;
  private recentObserver: ResizeObserver | null = null;
  private recentFrame = 0;
  private analysisTooltipCleanups: Array<() => void> = [];
  private ledgerPage = 1;
  private ledgerFilterKey = "";
  private stopLedgerSize: (() => void) | null = null;
  private renderedPage: FinancePage | null = null;
  private readonly numbers = new FinanceNumbers();
  private readonly billPlanView: FinanceBillPlanView;
  constructor(private readonly service: LifestyleService) {
    this.state.billPlans ??= initialFinanceBillPlanViewState();
    this.billPlanView = new FinanceBillPlanView(service, this.state.billPlans, {
      redraw: () => this.redraw(), edit: (plan) => this.billPlanDialog(plan), add: (id) => this.addDialog(id),
      transaction: (parent, entry) => this.transactionRow(parent, entry)
    });
  }
  private catalog(): FinanceSettings { return this.service.plugin.settings.lifestyle.finance; }
  private categories(month = this.state.month): string[] { const data = this.data(); return [...new Set([...financeCategoryNames(this.catalog(), this.entries(), data.budgets, month), ...Object.keys(effectiveFinanceBudget(data, month)?.allocations ?? {})])]; }
  close(scroll: number): void { this.detach(); this.state.scroll = scroll; lastClosedState = structuredClone(this.state); }
  detach(): void { this.inlineControls?.dispose(); this.inlineControls = null; if (this.host) disposeOriginControls(this.host); this.numbers.release(); this.renderedPage = null; this.tabsObserver?.disconnect(); this.tabsObserver = null; this.billPlanView.dispose(true); this.unsubscribeAnalysis?.(); this.unsubscribeAnalysis = null; this.unsubscribeMembership?.(); this.unsubscribeMembership = null; this.disposeRecentSizer(); this.releaseMarkdown(); this.host = null; }
  private disposeRecentSizer(): void {
    this.stopLedgerSize?.(); this.stopLedgerSize = null;
    this.recentObserver?.disconnect(); this.recentObserver = null;
    if (this.recentFrame) this.host?.ownerDocument.defaultView?.cancelAnimationFrame(this.recentFrame);
    this.recentFrame = 0;
  }
  releaseMarkdown(): void {
    this.reportRenderTicket++;
    for (const cleanup of this.analysisTooltipCleanups) cleanup();
    this.analysisTooltipCleanups = [];
    for (const component of this.reportComponents) component.unload();
    this.reportComponents = [];
  }
  private renderAnalysisMarkdown(container: HTMLElement, markdown: string): void {
    const component = new Component(); component.load();
    this.reportComponents.push(component);
    const ticket = this.reportRenderTicket;
    void MarkdownRenderer.render(this.service.plugin.app, markdown, container, "", component).catch((error) => {
      if (ticket === this.reportRenderTicket && container.isConnected) container.setText(`报告显示失败：${errorText(error)}`);
    }).finally(() => {
      if (ticket === this.reportRenderTicket && !container.isConnected) this.releaseMarkdown();
    });
  }
  render(body: HTMLElement): void {
    this.inlineControls?.dispose(); this.inlineControls = null;
    const entering = this.renderedPage !== this.state.page;
    this.numbers.begin(entering); if (entering) this.billPlanView.enterNumbers(); this.renderedPage = this.state.page;
    this.tabsObserver?.disconnect(); this.tabsObserver = null;
    this.billPlanView.dispose();
    this.host = body;
    this.unsubscribeAnalysis ??= this.service.finance.subscribe(() => this.redraw());
    this.unsubscribeMembership ??= this.service.finance.access.subscribe(() => { if (this.inlineControls) this.inlineControls.refresh(); else this.redraw(); });
    body.addClass("echoink-finance-workspace");
    const top = body.createDiv({ cls: "echoink-finance-top" });
    const tabs = top.createDiv({ cls: "echoink-finance-tabs echoink-page-tabs", attr: { role: "tablist", "aria-label": "财务页面" } });
    const pages: [FinancePage, string, string][] = [["overview", "财务总览", "layout-dashboard"], ["ledger", "收支明细", "list"], ["budget", "月度预算", "chart-pie"], ["billPlans", "账单计划", "receipt"]];
    const entryCount = this.entries().filter((entry) => entry.date.slice(0, 7) === this.state.month).length;
    for (const [page, label, icon] of pages) {
      const tab = button(tabs, "", () => this.go(page), this.state.page === page ? "is-active" : "");
      setIcon(tab.createSpan({ cls: "echoink-page-tab-icon", attr: { "aria-hidden": "true" } }), icon);
      tab.createSpan({ text: label });
      if (page === "ledger") tab.createSpan({ cls: "echoink-finance-tab-count", text: String(entryCount) });
      tab.disabled = this.billPlanView.busy;
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(this.state.page === page)); tab.setAttribute("tabindex", this.state.page === page ? "0" : "-1");
      tab.onkeydown = (event) => {
        const index = pages.findIndex(([item]) => item === page);
        const target = event.key === "ArrowRight" ? (index + 1) % pages.length : event.key === "ArrowLeft" ? (index + pages.length - 1) % pages.length : event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1 : -1;
        if (target < 0) return;
        event.preventDefault(); this.go(pages[target][0]);
        this.host?.querySelectorAll<HTMLButtonElement>(".echoink-finance-tabs [role=tab]")[target]?.focus();
      };
    }
    const revealActiveTab = () => {
      const active = tabs.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!active || typeof active.getBoundingClientRect !== "function") return;
      const current = active.getBoundingClientRect(), track = tabs.getBoundingClientRect();
      if (current.right > track.right) tabs.scrollLeft += current.right - track.right;
      else if (current.left < track.left) tabs.scrollLeft -= track.left - current.left;
    };
    if (typeof ResizeObserver !== "undefined") { this.tabsObserver = new ResizeObserver(revealActiveTab); this.tabsObserver.observe(tabs); }
    body.ownerDocument.defaultView?.requestAnimationFrame(revealActiveTab);
    if (this.state.page !== "billPlans") {
      const actions = top.createDiv({ cls: "echoink-finance-actions" });
      const month = actions.createDiv({ cls: "echoink-finance-month" });
      const previousMonth = button(month, "", () => this.changeMonth(-1));
      previousMonth.setAttribute("aria-label", "上一个月"); setIcon(previousMonth, "chevron-left");
      month.createEl("strong", { text: this.state.month.replace("-", " 年 ") + " 月" });
      const nextMonth = button(month, "", () => this.changeMonth(1));
      nextMonth.setAttribute("aria-label", "下一个月"); setIcon(nextMonth, "chevron-right");
      const business = actions.createDiv({ cls: "echoink-finance-business" });
      financeActionButton(business, "导入账单", "upload", () => this.importDialog()).disabled = !this.service.finance.accessState().canWrite;
      financeActionButton(business, "打开账本", "book-open", () => void this.service.finance.openBase().catch((cause) => new Notice(errorText(cause))));
      financeActionButton(business, "记一笔", "plus", () => this.addDialog(), true).disabled = !this.service.finance.accessState().canWrite;
    }
    const issues = this.service.finance.issues();
    if (issues.length) {
      const warning = body.createEl("details", { cls: "echoink-finance-file-issues" });
      warning.createEl("summary", { text: `${issues.length} 份账目笔记的属性需要修正，暂未计入统计或再次导入。` });
      for (const issue of issues) warning.createEl("p", { text: `${issue.path}：${issue.reason}` });
    }
    if (this.state.page === "overview") this.overview(body);
    else if (this.state.page === "ledger") this.ledger(body);
    else if (this.state.page === "budget") this.budget(body);
    else this.billPlanView.render(body);
    this.numbers.end(); this.billPlanView.finishNumbers();
  }
  private redraw(): void { if (!this.host?.isConnected || !this.service.plugin.settings.lifestyle.finance.enabled) return; const scroll = this.host.closest(".echoink-lifestyle-view")?.scrollTop ?? 0; this.disposeRecentSizer(); this.releaseMarkdown(); this.billPlanView.dispose(); disposeOriginControls(this.host); this.host.empty(); this.render(this.host); const view = this.host.closest(".echoink-lifestyle-view"); if (view) view.scrollTop = scroll; }
  private go(page: FinancePage, category = "", kind: FinanceFilters["kind"] = "all"): void {
    if (this.billPlanView.busy) return;
    this.state.page = page;
    if (page === "ledger" && category) { this.state.filters = { ...emptyFilters(), category, kind }; this.state.groupIntent = null; this.state.filterLabel = undefined; }
    this.redraw();
  }
  private allLedger(): void { this.state.filters = emptyFilters(); this.state.groupIntent = null; this.state.filterLabel = undefined; this.go("ledger"); }
  private spendingLedger(label: string, filters: Partial<FinanceFilters>): void {
    if (this.state.page === "overview") this.state.returnScroll = this.host?.closest(".echoink-lifestyle-view")?.scrollTop ?? 0;
    this.state.filters = { ...emptyFilters(), validExpenseOnly: true, ...filters };
    this.state.filterLabel = label; this.state.groupIntent = null; this.go("ledger");
    const view = this.host?.closest(".echoink-lifestyle-view"); if (view) view.scrollTop = 0;
  }
  private returnFromLedger(): void {
    const scroll = this.state.returnScroll ?? 0;
    this.state.page = "overview"; this.state.filters = emptyFilters(); this.state.groupIntent = null;
    this.state.filterLabel = undefined; this.state.returnScroll = undefined; this.redraw();
    const view = this.host?.closest(".echoink-lifestyle-view"); if (view) view.scrollTop = scroll;
  }
  private changeMonth(delta: number): void {
    this.state.month = monthShift(this.state.month, delta);
    this.state.chartCategory = null; this.state.recentDate = null;
    if (this.state.filters.date) { this.state.filters = emptyFilters(); this.state.filterLabel = undefined; }
    this.state.returnScroll = undefined;
    this.applyGroupIntent(); this.redraw();
  }
  private data() { return this.service.store.snapshot(); }
  private entries() { return this.service.finance.entries(); }
  private summary() { return financeSummary(this.entries(), this.state.month, this.categories()); }
  private applyGroupIntent(): void {
    const intent = this.state.groupIntent;
    if (!intent) return;
    this.state.filters.excludedCategories = [];
    this.state.filters.excludedIds = [];
    if (intent === "expense-rest") {
      const summary = this.summary();
      this.state.filters.excludedCategories = this.categories().map((category) => ({ category, amount: Math.max(0, summary.categoryExpenseCents[category] ?? 0) }))
        .filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 2).map((item) => item.category);
    } else {
      this.state.filters.excludedIds = this.entries().filter((entry) => entry.date.startsWith(this.state.month) && entry.kind === "income" && entry.status === "completed" && entry.currency === "CNY")
        .sort((a, b) => b.amountCents - a.amountCents || b.date.localeCompare(a.date)).slice(0, 2).map((entry) => entry.id);
    }
  }
  private plan(): FinanceBudget | null { return effectiveFinanceBudget(this.data(), this.state.month); }
  private spending() { return financeSpendingFacts(this.entries(), this.state.month); }
  private filterSummary(): string[] {
    const f = this.state.filters;
    const parts: string[] = [];
    if (f.validExpenseOnly) parts.push("有效人民币消费");
    else if (f.kind !== "all") parts.push(f.kind === "spending" ? "消费与退款" : labels[f.kind]);
    if (f.date) parts.push(`日期 ${f.date}`);
    if (f.minCents !== undefined || f.maxCents != null) parts.push(`单笔 ${f.minCents === undefined ? "不限" : `¥ ${money(f.minCents)}`} 至 ${f.maxCents == null ? "不限" : `¥ ${money(f.maxCents)}（不含）`}`);
    if (f.exactCategory !== undefined) parts.push(`分类 ${f.exactCategory || "未分类"}`);
    else if (f.category) parts.push(`分类 ${f.category}`);
    if (f.excludedCategories.length) parts.push(`排除分类 ${f.excludedCategories.map((item) => item || "未分类").join("、")}`);
    if (f.exactAccount !== undefined) parts.push(`账户 ${f.exactAccount || "未指定账户"}`);
    else if (f.account) parts.push(`账户 ${f.account}`);
    if (f.merchant) parts.push(`商户 ${f.merchant}`);
    if (f.search) parts.push(`搜索 ${f.search}`);
    if (f.excludedIds.length) parts.push(`排除 ${f.excludedIds.length} 笔`);
    return parts;
  }
  private card(parent: HTMLElement, eyebrow: string, value: string | number, note = "", key = `card:${eyebrow}`): HTMLElement {
    const card = parent.createDiv({ cls: "echoink-finance-card" });
    card.createEl("small", { text: eyebrow });
    const number = card.createEl("strong", { cls: "echoink-finance-number" });
    if (typeof value === "number") this.numbers.mount(number, key, value); else number.setText(value);
    if (note) card.createEl("p", { text: note });
    return card;
  }
  private metric(parent: HTMLElement, label: string, value: string | number, note: string, detail: string): void {
    const card = parent.createDiv({ cls: "echoink-finance-metric" });
    card.createEl("small", { text: label });
    const number = card.createEl("strong");
    if (typeof value === "number") this.numbers.mount(number, `metric:${label}`, value); else number.setText(value);
    const foot = card.createDiv();
    foot.createEl("span", { text: note });
    foot.createEl("span", { text: detail });
  }
  private balanceInfo(): void {
    new FinanceDialog(this.service, "收支差额是什么？", (content, dialog) => {
      content.createEl("p", { text: "收支差额 = 已记录收入 − 净支出；净支出 = 已完成消费 − 已完成退款。" });
      content.createEl("p", { text: "自己账户之间的转账不算收入或消费。这个数字不代表银行卡余额或个人总资产。" });
      button(content, "明白了", () => dialog.close(), "echoink-finance-primary");
    }).open();
  }
  private composition(parent: HTMLElement, summary: FinanceSummary): void {
    type Segment = { label: string; amount: number };
    const colors = ["var(--finance-accent)", "#91a487", "#c2ae8b"];
    let segments: Segment[] = [];
    if (this.state.mix === "expense") {
      const categories = this.spending().categories.map(([category, value]) => ({ category, amount: value.amountCents }));
      segments = categories.slice(0, 2).map((item) => ({ label: item.category || "未分类", amount: item.amount }));
      const rest = categories.slice(2).reduce((sum, item) => sum + item.amount, 0);
      if (rest) segments.push({ label: "其余分类", amount: rest });
    } else {
      const entries = effectiveFinanceEntries(this.entries(), this.state.month).filter((entry) => entry.kind === "income")
        .sort((a, b) => b.amountCents - a.amountCents || b.date.localeCompare(a.date));
      segments = entries.slice(0, 2).map((entry) => ({ label: entry.description || entry.merchant, amount: entry.amountCents }));
      const rest = entries.slice(2).reduce((sum, entry) => sum + entry.amountCents, 0);
      if (rest) segments.push({ label: "其余收入", amount: rest });
    }
    if (!segments.length) {
      parent.createEl("p", { text: "这个月还没有相关记录。", cls: "echoink-finance-empty" });
      if (this.state.mix === "expense") parent.createEl("small", { text: `支出原额 ¥ 0.00 · 退款另列 ¥ ${money(summary.refundCents)} · 净支出 ¥ ${money(summary.netExpenseCents)}` });
      return;
    }
    const total = segments.reduce((sum, item) => sum + item.amount, 0);
    const labels = parent.createDiv({ cls: "echoink-finance-compose-labels" });
    segments.forEach((item, index) => {
      const label = labels.createDiv();
      const name = label.createEl("small", { text: item.label });
      name.style.setProperty("--finance-segment-color", colors[index]);
      label.createEl("strong", { text: `¥ ${money(item.amount)}` });
      label.createEl("small", { text: `占${this.state.mix === "expense" ? "支出原额" : "收入"} ${total ? (item.amount / total * 100).toFixed(1) : "0.0"}%` });
    });
    const bars = parent.createDiv({ cls: "echoink-finance-compose-bars" });
    segments.forEach((item, index) => {
      const bar = bars.createDiv();
      bar.style.flexGrow = String(item.amount);
      bar.style.backgroundColor = colors[index];
      bar.setAttribute("aria-label", `${item.label} ¥ ${money(item.amount)}`);
      bar.title = `${item.label} ¥ ${money(item.amount)}`;
    });
    const foot = parent.createDiv({ cls: "echoink-finance-compose-foot" });
    foot.createEl("span", { text: this.state.mix === "expense" ? `支出原额 ¥ ${money(total)} · 退款另列 ¥ ${money(summary.refundCents)}` : "有效人民币收入" });
    foot.createEl("span", { text: this.state.mix === "expense" ? `净支出 ¥ ${money(summary.netExpenseCents)}` : `合计 ¥ ${money(total)}` });
  }
  private intro(body: HTMLElement, title: string, description: string): HTMLElement {
    const intro = body.createDiv({ cls: "echoink-finance-intro" });
    const copy = intro.createDiv(); copy.createEl("h2", { text: title }); copy.createEl("p", { text: description });
    return intro;
  }
  private overview(body: HTMLElement): void {
    const summary = this.summary();
    this.intro(body, "每一笔，都有自己的去处。", "把这个月的收支与计划放在一起看。");
    const layout = body.createDiv({ cls: "echoink-finance-overview" });
    const main = layout.createDiv({ cls: "echoink-finance-main" });
    const hero = main.createDiv({ cls: "echoink-finance-hero" });
    const heroMain = hero.createDiv({ cls: "echoink-finance-hero-main" });
    const label = heroMain.createDiv({ cls: "echoink-finance-hero-label" });
    label.createEl("span", { text: "本月收支差额" });
    button(label, "ⓘ", () => this.balanceInfo()).setAttribute("aria-label", "了解收支差额");
    this.numbers.mount(heroMain.createEl("strong"), "overview.balance", summary.balanceCents);
    const previous = financeSummary(this.entries(), monthShift(this.state.month, -1));
    if (previous.effectiveCount) hero.createEl("p", { cls: "echoink-finance-hero-change", text: `比上月${summary.balanceCents >= previous.balanceCents ? "多留下" : "少留下"} ¥ ${money(Math.abs(summary.balanceCents - previous.balanceCents))}` });
    const metrics = hero.createDiv({ cls: "echoink-finance-metrics" });
    this.metric(metrics, "本月收入", summary.incomeCents, "已入账收入", `${this.entries().filter((entry) => entry.date.startsWith(this.state.month) && entry.kind === "income" && entry.status === "completed" && entry.currency === "CNY").length} 笔`);
    this.metric(metrics, "本月净支出", summary.netExpenseCents, "已扣除退款", `¥ ${money(summary.refundCents)}`);
    this.metric(metrics, "本月结余率", summary.savingsRate === null ? "—" : `${(summary.savingsRate * 100).toFixed(1)}%`, "收支差额 / 收入", summary.balanceCents >= 0 ? "有所积累" : "支出较多");
    const compose = main.createDiv({ cls: "echoink-finance-card echoink-finance-composition" });
    const composeHead = compose.createDiv({ cls: "echoink-finance-section-head" });
    const composeTitle = composeHead.createEl("h3", { text: "钱花在了哪里" });
    const switcher = composeHead.createDiv({ cls: "echoink-finance-segment" });
    const content = compose.createDiv({ cls: "echoink-finance-composition-content" });
    const tabs: HTMLButtonElement[] = [];
    const drawComposition = (): void => {
      content.empty();
      composeTitle.setText(this.state.mix === "expense" ? "钱花在了哪里" : "收入从哪里来");
      tabs.forEach((tab, index) => { const active = this.state.mix === (index ? "income" : "expense"); tab.toggleClass("is-active", active); tab.setAttribute("aria-pressed", String(active)); });
      this.composition(content, summary);
    };
    for (const [mode, label] of [["expense", "支出"], ["income", "收入"]] as const)
      tabs.push(button(switcher, label, () => { this.state.mix = mode; drawComposition(); }));
    drawComposition();
    const recent = main.createDiv({ cls: "echoink-finance-card" });
    const recentHead = recent.createDiv({ cls: "echoink-finance-section-head" });
    recentHead.createEl("h3", { text: "近期交易" }); button(recentHead, "查看全部 ↗", () => this.allLedger());
    const recentInfo = recent.createDiv({ cls: "echoink-finance-recent-info" });
    recentInfo.createEl("small", { text: this.state.recentDate ? `${this.state.recentDate} 消费` : `本月共 ${this.entries().filter((item) => item.date.startsWith(this.state.month)).length} 笔账目` });
    if (this.state.recentDate) button(recentInfo, "清除日期 · 回到本月", () => { this.state.recentDate = null; this.redraw(); });
    const recentSource = this.state.recentDate ? effectiveFinanceEntries(this.entries(), this.state.month) : this.entries();
    const recentEntries = recentSource.filter((item) => item.date.startsWith(this.state.month) && (item.kind === "expense" || item.kind === "refund")
      && (!this.state.recentDate || (item.kind === "expense" && item.date.slice(0, 10) === this.state.recentDate)))
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!recentEntries.length) recent.createEl("p", { text: "还没有近期交易。", cls: "echoink-finance-empty" });
    const recentList = recent.createDiv({ cls: "echoink-finance-recent-list" });
    if (recentEntries[0]) this.transactionRow(recentList, recentEntries[0], true);
    const side = layout.createDiv({ cls: "echoink-finance-side" });
    this.budgetSummary(side, summary.netExpenseCents);
    this.monthlyGoals(side);
    this.dailyCalendar(side);
    if (recentEntries.length) this.sizeRecentTransactions(layout, main, side, recentList, recentEntries);
    this.spendingCharts(body);
    if (this.service.plugin.settings.lifestyle.finance.aiEnabled) this.aiCard(body);
  }
  private sizeRecentTransactions(layout: HTMLElement, main: HTMLElement, side: HTMLElement, list: HTMLElement, entries: FinanceEntry[]): void {
    const win = layout.ownerDocument.defaultView;
    if (!win) return;
    const geometry = (): { wide: boolean; available: number; width: number; height: number } => {
      const sideRect = side.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      return {
        wide: sideRect.left >= main.getBoundingClientRect().right - 2,
        available: sideRect.bottom - listRect.top - 20,
        width: listRect.width,
        height: listRect.height
      };
    };
    let lastGeometry: ReturnType<typeof geometry> | null = null;
    const measure = (): void => {
      this.recentFrame = 0;
      if (!layout.isConnected) return;
      const current = geometry();
      if (lastGeometry && current.wide === lastGeometry.wide &&
        Math.abs(current.available - lastGeometry.available) < 1 &&
        Math.abs(current.width - lastGeometry.width) < 1 &&
        Math.abs(current.height - lastGeometry.height) < 1) return;
      if (!current.wide) {
        const desired = Math.min(5, entries.length);
        while (list.children.length > desired) list.lastElementChild?.remove();
        while (list.children.length < desired) this.transactionRow(list, entries[list.children.length], true);
      } else {
        const bottom = side.getBoundingClientRect().bottom - 20;
        while (list.children.length > 1 && (list.lastElementChild as HTMLElement).getBoundingClientRect().bottom > bottom)
          list.lastElementChild?.remove();
        while (list.children.length < entries.length) {
          this.transactionRow(list, entries[list.children.length], true);
          if ((list.lastElementChild as HTMLElement).getBoundingClientRect().bottom <= bottom) continue;
          if (list.children.length > 1) list.lastElementChild?.remove();
          break;
        }
      }
      lastGeometry = geometry();
    };
    const schedule = (): void => { if (!this.recentFrame) this.recentFrame = win.requestAnimationFrame(measure); };
    if (typeof ResizeObserver !== "undefined") {
      this.recentObserver = new ResizeObserver(schedule);
      this.recentObserver.observe(side); this.recentObserver.observe(layout); this.recentObserver.observe(list);
    }
    schedule();
  }
  private budgetSummary(parent: HTMLElement, expense: number): void {
    const plan = this.plan(); const card = parent.createDiv({ cls: "echoink-finance-card echoink-finance-budget-summary" });
    const head = card.createDiv({ cls: "echoink-finance-budget-head" });
    head.createEl("small", { text: "月度预算" });
    if (!plan) { card.createEl("h3", { text: "还没有设置预算" }); this.writeButton(card, "设置预算", () => this.budgetDialog(), "echoink-finance-primary"); return; }
    this.writeButton(head, "调整预算 ↗", () => this.budgetDialog());
    const remaining = plan.totalCents - expense;
    const amount = card.createDiv({ cls: "echoink-finance-budget-amount" });
    amount.createEl("p", { text: remaining >= 0 ? "可用预算" : "超出预算" });
    this.numbers.mount(amount.createEl("strong", { cls: "echoink-finance-number" }), "overview.budgetRemaining", Math.abs(remaining));
    amount.createEl("small", { text: `本月总预算 ¥ ${money(plan.totalCents)}` });
    const percent = Math.max(0, expense / plan.totalCents * 100);
    const gauge = card.createDiv({ cls: "echoink-finance-gauge", attr: { "aria-label": `已使用预算 ${percent.toFixed(1)}%` } });
    const svg = gauge.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 240 135"); svg.setAttribute("aria-hidden", "true");
    for (const [className, fill] of [["is-track", 100], [remaining < 0 ? "is-over" : "is-fill", Math.min(100, percent)]] as const) {
      const path = gauge.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M15 126 A108 108 0 0 1 231 126"); path.setAttribute("pathLength", "100");
      path.setAttribute("stroke-dasharray", `${fill} 100`); path.setAttribute("class", className);
      svg.appendChild(path);
    }
    gauge.appendChild(svg);
    const gaugeLabel = gauge.createDiv({ cls: "echoink-finance-gauge-label" });
    gaugeLabel.createEl("strong", { text: `${percent.toFixed(1)}%` });
    gaugeLabel.createEl("small", { text: "本月预算已用" });
    button(card, "查看六类额度", () => this.go("budget"), "echoink-finance-budget-link");
  }
  private monthlyGoals(parent: HTMLElement): void {
    const goals = this.service.finance.goals();
    const card = parent.createDiv({ cls: "echoink-finance-card echoink-finance-goals" });
    const head = card.createDiv({ cls: "echoink-finance-section-head" });
    head.createEl("h3", { text: `目标 · 当前周期 ${goals.length}/5` });
    if (goals.length < 5) this.writeButton(head, "新增目标", () => this.goalEditor());
    card.createEl("small", { text: "按本地今天统计，切换概览月份不改变目标周期。" });
    if (!goals.length) card.createEl("p", { text: "还没有设置持续目标。" });
    for (const goal of goals) {
      const progress = financeGoalProgress(goal, this.entries());
      const ratio = goal.metric === "savings-rate" || goal.metric === "category-share";
      const display = (value: number): string => ratio ? `${(value / 100).toFixed(2)}%` : `¥ ${money(value)}`;
      const status = { "no-data": "暂无数据", within: "额度内", over: "已超出", reached: "已达到", pending: "进行中" }[progress.status];
      const row = card.createDiv({ cls: "echoink-finance-goal" });
      const title = row.createDiv({ cls: "echoink-finance-section-head" });
      title.createEl("strong", { text: goal.name });
      this.writeButton(title, "编辑", () => this.goalEditor(goal));
      this.writeButton(title, "删除", () => void this.service.finance.deleteContinuousGoal(goal.id).then(() => this.redraw()).catch((error) => new Notice(errorText(error))));
      row.createEl("small", { text: `${progress.start} 至 ${progress.end}` });
      row.createEl("p", { text: `${progress.actual === null ? "—" : display(progress.actual)} / ${display(goal.target)} · ${status}` });
      const bar = row.createDiv({ cls: "echoink-finance-progress", attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(goal.target), "aria-valuenow": String(Math.min(Math.max(progress.actual ?? 0, 0), goal.target)) } });
      bar.createDiv().style.width = `${progress.fraction * 100}%`;
    }
    const legacy = this.data().financePlans.flatMap((plan) => plan.goals.map((goal) => ({ month: plan.month, goal })));
    if (legacy.length) {
      const old = card.createEl("details", { cls: "echoink-finance-legacy-goals" });
      old.createEl("summary", { text: `旧目标待重新设置 · ${legacy.length} 项` });
      old.createEl("small", { text: "旧实际值不会作为新目标的自动统计结果。选择新规则并保存后，才移走对应旧目标。" });
      for (const { month, goal } of legacy) {
        const line = old.createDiv({ cls: "echoink-finance-legacy-goal" });
        line.createSpan({ text: `${month} · ${goal.name} · ${goal.target} ${goal.unit}` });
        this.writeButton(line, "重新设置", () => this.goalEditor(undefined, { month, goal }));
      }
    }
  }
  private goalEditor(existing?: FinanceContinuousGoal, legacy?: { month: string; goal: FinanceGoal }): void {
    new FinanceDialog(this.service, legacy ? "重新设置旧目标" : existing ? "编辑目标" : "新增目标", (content, dialog) => {
      const form = content.createEl("form", { cls: "echoink-finance-form echoink-finance-goal-form" });
      if (legacy) form.createEl("p", { text: "请明确选择新的自动统计方式；旧实际值不会转入新目标。" });
      const name = field(form, "目标名称", "text", existing?.name ?? legacy?.goal.name ?? ""); name.maxLength = 40;
      const metric = select(form, "统计项", [["expense", "支出不超过"], ["income", "收入达到"], ["balance", "收支结余达到"], ["savings-rate", "本月结余率达到"], ["category-share", "分类消费占比不超过"]], existing?.metric ?? "expense", () => sync());
      const categories = [...new Set([...financeSelectableCategoryNames(this.catalog()), ...this.entries().map((entry) => entry.category), existing?.category ?? ""].filter(Boolean))];
      const category = select(form, "分类", [["", "全部分类"], ...categories.map((item): [string, string] => [item, item])], existing?.category ?? "", () => undefined);
      const target = field(form, "目标金额 · 元", "number", existing ? String(existing.target / 100) : "");
      target.min = "0.01"; target.step = "0.01";
      const period = select(form, "周期", [["day", "每天"], ["week", "本周（周一至周日）"], ["month", "本月"]], existing?.period ?? "month", () => undefined);
      const sync = (): void => {
        const ratio = metric.value === "savings-rate" || metric.value === "category-share";
        target.parentElement?.querySelector("span")?.setText(ratio ? "目标比例 · %" : "目标金额 · 元");
        target.max = ratio ? "100" : "";
        if (ratio) { period.value = "month"; period.disabled = true; }
        else period.disabled = false;
        category.disabled = metric.value === "balance" || metric.value === "savings-rate";
        if (category.disabled) category.value = "";
        const all = category.querySelector<HTMLOptionElement>("option[value='']");
        if (all) all.disabled = metric.value === "category-share";
        if (metric.value === "category-share" && !category.value) category.value = categories[0] ?? "";
      };
      sync();
      const error = form.createEl("p", { cls: "echoink-life-error", attr: { role: "alert" } });
      const actions = form.createDiv({ cls: "echoink-finance-dialog-actions" });
      const cancel = button(actions, "取消", () => dialog.close());
      const save = actions.createEl("button", { text: "保存目标", cls: "echoink-finance-primary", attr: { type: "submit" } });
      let saving = false;
      dialog.bindWrite(save, () => saving, undefined, "finance.category_budget.write");
      form.onsubmit = (event) => {
        event.preventDefault(); if (saving) return;
        try {
          const ratio = metric.value === "savings-rate" || metric.value === "category-share";
          const goal = { id: existing?.id ?? lifeId("goal"), name: name.value, metric: metric.value,
            period: ratio ? "month" : period.value, category: category.value,
            target: parseYuan(target.value) } as FinanceContinuousGoal;
          saving = true; dialog.refreshAccess(); cancel.disabled = true; error.setText("");
          void this.service.finance.saveContinuousGoal(goal, legacy ? { month: legacy.month, id: legacy.goal.id } : undefined)
            .then(() => { dialog.close(); this.redraw(); })
            .catch((cause) => { error.setText(errorText(cause)); saving = false; dialog.refreshAccess(); cancel.disabled = false; });
        } catch (cause) { error.setText(errorText(cause)); }
      };
    }).open();
  }
  private dailyCalendar(parent: HTMLElement): void {
    const month = this.state.month, plan = this.service.finance.monthlyPlan(month), facts = this.spending();
    const card = parent.createDiv({ cls: "echoink-finance-card echoink-finance-calendar-card" });
    const head = card.createDiv({ cls: "echoink-finance-section-head" });
    head.createEl("h3", { text: "每日消费额度" });
    this.writeButton(head, plan.dailyLimitCents === null ? "设置额度" : "调整额度", () => {
      card.empty(); button(card, "← 返回日历", () => this.redraw(), "echoink-finance-calendar-back");
      card.createEl("h3", { text: "设置每日消费额度" });
      const form = card.createEl("form", { cls: "echoink-finance-goal-form" });
      const input = field(form, "每日额度 · 元", "number", plan.dailyLimitCents === null ? "" : yuanInput(plan.dailyLimitCents));
      input.min = "0.01"; input.step = "0.01";
      const error = form.createEl("p", { cls: "echoink-life-error", attr: { role: "alert" } });
      const actions = form.createDiv({ cls: "echoink-finance-dialog-actions" });
      button(actions, "取消", () => this.redraw());
      const save = actions.createEl("button", { text: "保存额度", cls: "echoink-finance-primary", attr: { type: "submit" } });
      let saving = false;
      this.inlineControls = new ProPluginControls(this.service.finance.access, () => this.service.finance.accessState());
      this.inlineControls.bind(save, { businessDisabled: () => saving, capability: "finance.category_budget.write" });
      form.onsubmit = (event) => { event.preventDefault(); if (this.state.month !== month) { error.setText("月份已改变，请返回后重新设置。"); return; }
        if (saving) return;
        try { const cents = parseYuan(input.value); saving = true; this.inlineControls?.refresh();
          void this.service.finance.saveDailyLimit(month, cents).then(() => { if (this.state.month === month) this.redraw(); })
            .catch((cause) => { error.setText(errorText(cause)); saving = false; this.inlineControls?.refresh(); }); }
        catch (cause) { error.setText(errorText(cause)); }
      };
    });
    card.createEl("p", { text: plan.dailyLimitCents === null ? "尚未设置 · 按月独立" : `每日 ¥ ${money(plan.dailyLimitCents)} · 按月独立` });
    const grid = card.createDiv({ cls: "echoink-finance-calendar", attr: { "aria-label": `${month} 每日消费` } });
    for (const weekday of ["一", "二", "三", "四", "五", "六", "日"]) grid.createSpan({ text: weekday });
    const [year, number] = month.split("-").map(Number);
    const first = new Date(year, number - 1, 1), days = new Date(year, number, 0).getDate();
    for (let pad = 0; pad < (first.getDay() + 6) % 7; pad++) grid.createSpan();
    for (let day = 1; day <= days; day++) {
      const date = `${month}-${String(day).padStart(2, "0")}`, spent = facts.days.get(date)?.amountCents ?? 0;
      const future = date > localDate();
      const state = !future && spent > 0 && plan.dailyLimitCents !== null ? spent <= plan.dailyLimitCents ? "is-within" : "is-over" : "is-idle";
      const cell = button(grid, String(day), () => {
        this.state.recentDate = this.state.recentDate === date ? null : date;
        this.redraw();
        this.host?.querySelector<HTMLButtonElement>(`.echoink-finance-day[data-date="${date}"]`)?.focus({ preventScroll: true });
      }, `echoink-finance-day ${state}`);
      cell.disabled = !spent || future;
      cell.setAttribute("data-date", date);
      cell.setAttribute("aria-pressed", String(this.state.recentDate === date));
      cell.setAttribute("aria-label", `${date}：${spent ? `消费 ¥ ${money(spent)}` : "无消费"}${spent && plan.dailyLimitCents !== null ? spent <= plan.dailyLimitCents ? `，额度剩余 ¥ ${money(plan.dailyLimitCents - spent)}` : `，超额 ¥ ${money(spent - plan.dailyLimitCents)}` : ""}`);
      if (spent) cell.title = cell.getAttribute("aria-label") ?? "";
    }
    card.createEl("small", { text: "绿色：有消费且未超额；红色：超额；灰色：无消费或未来日期。" });
  }
  private spendingCharts(parent: HTMLElement): void {
    const facts = this.spending();
    const card = parent.createDiv({ cls: "echoink-finance-card echoink-finance-spending-charts" });
    const head = card.createDiv({ cls: "echoink-finance-section-head" });
    head.createEl("h3", { text: "消费统计" });
    head.createEl("small", { text: "支出原额 ¥ " + money(facts.grossCents) + " · " + facts.expenses.length + " 笔 · 退款另列 ¥ " + money(facts.refundsCents) });
    if (!facts.expenses.length) { card.createEl("p", { text: "本月尚无有效人民币消费。", cls: "echoink-finance-empty" }); return; }

    const category = card.createDiv({ cls: "echoink-finance-category-chart" });
    const title = category.createDiv({ cls: "echoink-finance-stat-title" });
    title.createEl("h4", { text: "消费分类" });
    title.createEl("small", { text: "共 " + facts.categories.length + " 类 · 选择分类查看账户与金额分布" });
    const chart = category.createDiv({ cls: "echoink-finance-category-chart-body" });
    let donut: ReturnType<typeof financeCategoryDonut>;
    const selection = card.createDiv({ cls: "echoink-finance-chart-selection" });
    const secondary = card.createDiv({ cls: "echoink-finance-stat-secondary" });
    const drawSecondary = (): void => {
      secondary.empty(); selection.empty();
      const selected = this.state.chartCategory;
      const current = selected == null ? facts : financeSpendingFacts(facts.expenses.filter((entry) => entry.category === selected), this.state.month);
      if (selected != null) {
        const label = selected || "未分类";
        selection.createSpan({ text: "已选 " + label + " · " + current.expenses.length + " 笔 · ¥ " + money(current.grossCents) });
        button(selection, "清除筛选", () => { donut.clear(); donut.focus(selected); });
      } else selection.createSpan({ text: "账户和金额分布：全部分类" });
      const accountCard = secondary.createDiv({ cls: "echoink-finance-stat-subcard" });
      accountCard.createEl("h4", { text: "账户支出" });
      accountCard.createEl("small", { text: selected == null ? "占全部支出原额" : "占所选分类支出原额" });
      const accounts = accountCard.createDiv({ cls: "echoink-finance-account-list" });
      for (const [account, value] of current.accounts) {
        const row = accounts.createDiv({ cls: "echoink-finance-account-bar", attr: { tabindex: "0", title: (account || "未指定账户") + " · " + value.count + " 笔 · ¥ " + money(value.amountCents) } });
        const line = row.createDiv({ cls: "echoink-finance-account-line" });
        line.createSpan({ text: account || "未指定账户" });
        line.createSpan({ text: "¥ " + money(value.amountCents) + " · " + (current.grossCents ? (value.amountCents / current.grossCents * 100).toFixed(1) : "0.0") + "%" });
        const bar = row.createDiv({ cls: "echoink-finance-account-track" });
        bar.createDiv({ cls: "echoink-finance-account-fill" }).style.width = (current.grossCents ? value.amountCents / current.grossCents * 100 : 0) + "%";
      }
      if (!current.accounts.length) accounts.createEl("p", { text: "没有账户支出。", cls: "echoink-finance-empty" });
      const binCard = secondary.createDiv({ cls: "echoink-finance-stat-subcard" });
      binCard.createEl("h4", { text: "单笔金额分布" });
      binCard.createEl("small", { text: "条长按笔数比较 · 悬浮或聚焦看总金额" });
      const bins = binCard.createDiv({ cls: "echoink-finance-bin-chart" });
      for (const bin of current.bins) {
        const detail = bin.label + " · " + bin.count + " 笔 · 合计 ¥ " + money(bin.amountCents);
        const row = bins.createDiv({ cls: "echoink-finance-bin", attr: { tabindex: "0", role: "img", "aria-label": detail, "data-tooltip": detail } });
        row.createSpan({ text: bin.label, cls: "echoink-finance-bin-name" });
        const rail = row.createDiv({ cls: "echoink-finance-bin-plot" });
        if (bin.count) rail.createDiv({ cls: "echoink-finance-bin-fill" }).style.width = (bin.count / current.expenses.length * 100) + "%";
        row.createSpan({ text: bin.count + " 笔 · " + (current.expenses.length ? (bin.count / current.expenses.length * 100).toFixed(1) : "0.0") + "%", cls: "echoink-finance-bin-count" });
      }
    };
    donut = financeCategoryDonut(chart, facts.categories.map(([category, value]) => ({ category, amountCents: value.amountCents, color: financeCategoryVisual(category, this.catalog()).color })), {
      label: "本月支出原额", selected: () => this.state.chartCategory ?? null,
      onSelect: category => { this.state.chartCategory = category; drawSecondary(); }
    });
    drawSecondary();
  }
  private aiCard(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "echoink-finance-card echoink-finance-analysis-card" });
    const notice = capabilityMessage(this.service.finance.access, "finance.analysis.generate");
    if (notice) card.createEl("p", { text: notice, cls: "echoink-life-hint" });
    const header = card.createDiv({ cls: "echoink-finance-section-head" }); header.createEl("h3", { text: "AI 分析" });
    const savedReport = this.service.finance.latestReport(this.state.month);
    const input = this.service.finance.analysisInput(this.state.month);
    const busyMonth = this.service.finance.busyMonth();
    const busy = busyMonth === this.state.month;
    const failed = !busy && this.analysisError?.month === this.state.month && this.analysisError.reportId === (savedReport?.id ?? null);
    const report = busy || failed ? null : savedReport;
    const action = button(header, busy ? "生成中…" : failed ? "重试分析" : report ? "刷新分析" : "生成分析", () => {
      if (this.service.finance.busyMonth()) return;
      const month = this.state.month;
      this.analysisError = null;
      void this.service.finance.analyze(month, true).then(() => { if (this.state.month === month) { this.analysisError = null; this.redraw(); } })
        .catch((error) => {
          this.analysisError = { month, message: errorText(error), reportId: this.service.finance.latestReport(month)?.id ?? null };
          if (this.state.month === month) this.redraw();
        });
      this.redraw();
    }, "echoink-finance-ai-action");
    action.disabled = Boolean(busyMonth) || !input.entryCount || !this.service.finance.access.checkCapability("finance.analysis.generate");
    if (notice) action.title = notice;
    if (busy) action.setAttribute("aria-busy", "true");
    if (busyMonth && !busy) action.title = `${busyMonth} 的分析正在生成`;
    if (report) {
      card.createEl("small", { text: `${new Date(report.createdAt).toLocaleString("zh-CN")} · ${report.provider}` });
      const snapshot = report.financeSnapshot as FinanceReportSnapshot | undefined;
      if (snapshot?.version === 8 && Array.isArray(snapshot.sections)) {
        const reportBody = card.createDiv({ cls: "echoink-finance-ai-report" });
        for (const section of snapshot.sections) {
          const sectionEl = reportBody.createEl("section", { cls: "echoink-finance-ai-section" });
          sectionEl.createEl("h4", { text: section.title });
          const overviewIndex = section.blocks.findIndex((block) => block.type === "highlight" && block.tone === "fact");
          const leadIndex = overviewIndex >= 0 ? overviewIndex : section.blocks.findIndex((block) => block.type === "text");
          if (leadIndex >= 0) this.renderAnalysisBlock(sectionEl, section.blocks[leadIndex], true);
          section.blocks.forEach((block, index) => { if (index !== leadIndex) this.renderAnalysisBlock(sectionEl, block); });
        }
        if (snapshot.omittedSuggestionCount) card.createEl("small", { text: `有 ${snapshot.omittedSuggestionCount} 条建议未能完整生成，未展示。`, attr: { role: "status" } });
      } else if (snapshot && typeof snapshot.conclusion === "string" && Array.isArray(snapshot.charts) && Array.isArray(snapshot.suggestions)) {
        const summary = card.createDiv({ cls: "echoink-finance-ai-legacy-summary" });
        setIcon(summary.createSpan({ cls: "echoink-finance-ai-legacy-icon", attr: { "aria-hidden": "true" } }), "lightbulb");
        const summaryBody = summary.createDiv();
        summaryBody.createEl("small", { text: "已保存报告的核心观察" });
        this.renderAnalysisPlainText(summaryBody.createEl("p", { cls: "echoink-finance-ai-conclusion" }), snapshot.conclusion);
        const charts = card.createDiv({ cls: "echoink-finance-ai-charts" });
        for (const chart of snapshot.charts) this.renderAnalysisChart(charts, chart);
        if (snapshot.suggestions.length) {
          card.createEl("h4", { text: "可以试试" });
          const list = card.createEl("ul", { cls: "echoink-finance-ai-suggestions" });
          for (const suggestion of snapshot.suggestions) {
            const item = list.createEl("li");
            setIcon(item.createSpan({ attr: { "aria-hidden": "true" } }), "arrow-right");
            item.createSpan({ text: suggestion });
          }
        }
        const omittedCount = Number.isSafeInteger(snapshot.omittedSuggestionCount) && snapshot.omittedSuggestionCount > 0
          ? snapshot.omittedSuggestionCount : 0;
        if (omittedCount) card.createEl("small", { text: `有 ${omittedCount} 条建议未能完整生成，未展示。`, attr: { role: "status" } });
        if (snapshot.detail) {
          const detail = card.createEl("details", { cls: "echoink-finance-ai-detail" });
          detail.createEl("summary", { text: "展开详细分析" });
          this.renderAnalysisMarkdown(detail.createDiv({ cls: "echoink-finance-report markdown-rendered" }), snapshot.detail);
        }
      } else {
        const detail = card.createEl("details", { cls: "echoink-finance-ai-detail" });
        detail.createEl("summary", { text: "旧版文字报告 · 建议刷新生成图文" });
        detail.open = true;
        this.renderAnalysisMarkdown(detail.createDiv({ cls: "echoink-finance-report markdown-rendered" }), report.text);
      }
      if (report.inputFingerprint !== input.fingerprint || report.promptVersion !== FINANCE_ANALYSIS_PROMPT_VERSION)
        card.createEl("small", { text: "可刷新查看当前账目与分析方法下的最新结果。" });
    } else if (!busy && !failed) card.createEl("p", { text: input.entryCount ? "点击生成分析，回看本月已记录的收支。" : "暂无可分析的收支记录。" });
    if (failed) card.createEl("p", { text: this.analysisError!.message, cls: "echoink-life-error", attr: { role: "alert" } });
    card.createEl("small", { text: `${this.state.month} · ${input.entryCount} 笔有效收支 · 记录范围可能不完整` });
    if (busy) card.createEl("p", { text: "正在根据最新账目生成本次报告。", attr: { role: "status" } });
    else if (busyMonth) card.createEl("p", { text: `${busyMonth} 的分析正在生成，完成后可分析当前月份。`, attr: { role: "status" } });
  }
  private renderAnalysisPlainText(parent: HTMLElement, value: string): void {
    const facts = /[¥￥]\s*-?\d[\d,]*(?:\.\d+)?|-?\d+(?:\.\d+)?%/gu;
    let offset = 0;
    for (const match of value.matchAll(facts)) {
      if (match.index > offset) parent.createSpan({ text: value.slice(offset, match.index) });
      parent.createEl("strong", { text: match[0] });
      offset = match.index + match[0].length;
    }
    if (offset < value.length) parent.createSpan({ text: value.slice(offset) });
  }
  private renderAnalysisBlock(parent: HTMLElement, block: FinanceReportBlock, lead = false): void {
    if (block.type === "text" || block.type === "highlight") {
      const shell = parent.createDiv({ cls: block.type === "text" ? lead ? "echoink-finance-ai-text is-lead" : "echoink-finance-ai-text" :
        `echoink-finance-ai-highlight is-${block.tone}${lead ? " is-overview" : ""}` });
      if (block.type === "highlight") {
        setIcon(shell.createSpan({ cls: "echoink-finance-ai-highlight-icon", attr: { "aria-hidden": "true" } }),
          block.tone === "notice" ? "info" : block.tone === "positive" ? "circle-check" : "lightbulb");
        const body = shell.createDiv();
        body.createEl("small", { text: lead ? "本章概要" : block.tone === "notice" ? "需要留意" : block.tone === "positive" ? "积极信号" : "重点观察",
          cls: "echoink-finance-ai-highlight-label" });
        this.renderAnalysisMarkdown(body.createDiv({ cls: "echoink-finance-report markdown-rendered" }), block.markdown);
      } else {
        if (lead) shell.createEl("small", { text: "本章概要", cls: "echoink-finance-ai-highlight-label" });
        this.renderAnalysisMarkdown(shell.createDiv({ cls: "echoink-finance-report markdown-rendered" }), block.markdown);
      }
    } else if (block.type === "chart") this.renderAnalysisChart(parent, block.chart, true);
    else if (block.type === "table") this.renderAnalysisTable(parent, block.table, block.explanation);
    else if (block.items.length) {
      const list = parent.createEl("ul", { cls: "echoink-finance-ai-suggestions" });
      for (const item of block.items) {
        const row = list.createEl("li");
        setIcon(row.createSpan({ attr: { "aria-hidden": "true" } }), "arrow-right");
        this.renderAnalysisMarkdown(row.createDiv({ cls: "echoink-finance-report markdown-rendered" }), item);
      }
    }
  }
  private renderAnalysisTable(parent: HTMLElement, table: FinanceTableSnapshot, explanation: string): void {
    const panel = parent.createDiv({ cls: "echoink-finance-ai-table-panel" });
    panel.createEl("h5", { text: table.title });
    const scroll = panel.createDiv({ cls: "echoink-finance-ai-table-scroll" });
    const element = scroll.createEl("table");
    const head = element.createEl("thead").createEl("tr");
    for (const label of table.headers) head.createEl("th", { text: label });
    const body = element.createEl("tbody");
    for (const values of table.rows) {
      const row = body.createEl("tr");
      for (const value of values) row.createEl("td", { text: value });
    }
    this.renderAnalysisMarkdown(panel.createDiv({ cls: "echoink-finance-report markdown-rendered" }), explanation);
  }
  private renderAnalysisChart(parent: HTMLElement, chart: FinanceChartSnapshot, markdown = false): void {
    const panel = parent.createDiv({ cls: "echoink-finance-ai-chart" });
    panel.createEl("h5", { text: chart.title });
    panel.createEl("small", { text: chart.id === "daily" ? "单位：人民币元 · 每日柱形悬浮或聚焦可读确切金额" : "单位：人民币元 · 悬浮或聚焦读取确切金额" });
    const max = Math.max(1, ...chart.points.map((point) => Math.abs(point.valueCents)),
      ...chart.points.map((point) => Math.abs(point.comparisonCents ?? 0)));
    if (chart.id === "daily") {
      panel.addClass("is-daily");
      const weeks = financeDailyWeeks(chart.points);
      panel.createEl("small", { text: `全部周段共用 ¥ 0—¥ ${money(max)} 的金额尺度。`, cls: "echoink-finance-ai-daily-scale" });
      const grid = panel.createDiv({ cls: "echoink-finance-ai-daily-weeks", attr: { role: "group", "aria-label": "按月内七日一组展示每日支出及每组合计" } });
      grid.style.setProperty("--finance-week-count", String(weeks.length));
      const tooltip = panel.createDiv({ cls: "echoink-finance-ai-daily-tooltip", attr: { role: "tooltip", "aria-hidden": "true" } });
      tooltip.hidden = true;
      const scrollHost = panel.closest(".echoink-lifestyle-view");
      const onEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") hide(); };
      const hide = (): void => {
        tooltip.hidden = true; tooltip.setAttribute("aria-hidden", "true");
        panel.ownerDocument.removeEventListener("keydown", onEscape);
        scrollHost?.removeEventListener("scroll", hide);
      };
      this.analysisTooltipCleanups.push(hide);
      const position = (column: HTMLElement, event?: MouseEvent): void => {
        const bounds = panel.getBoundingClientRect();
        const columnBounds = column.getBoundingClientRect();
        const width = tooltip.offsetWidth || 180;
        const height = tooltip.offsetHeight || 34;
        const panelWidth = panel.clientWidth || bounds.width;
        const x = event ? event.clientX - bounds.left : columnBounds.left + columnBounds.width / 2 - bounds.left;
        const y = event ? event.clientY - bounds.top : columnBounds.top - bounds.top;
        tooltip.style.left = `${Math.max(6, Math.min(x - width / 2, panelWidth - width - 6))}px`;
        const scrollBounds = scrollHost?.getBoundingClientRect();
        const visibleTop = Math.max(8, scrollBounds?.top ?? 8);
        const visibleBottom = Math.min(panel.ownerDocument.defaultView?.innerHeight ?? Infinity, scrollBounds?.bottom ?? Infinity) - 8;
        const minTop = Math.max(6, visibleTop - bounds.top + 6);
        const maxTop = Math.max(minTop, Math.min((panel.clientHeight || bounds.height || Infinity) - height - 6, visibleBottom - bounds.top - height));
        const above = y - height - 10;
        tooltip.style.top = `${Math.max(minTop, Math.min(above >= minTop ? above : y + 10, maxTop))}px`;
      };
      for (const week of weeks) {
        const group = grid.createDiv({ cls: "echoink-finance-ai-daily-week" });
        const header = group.createDiv({ cls: "echoink-finance-ai-daily-week-head" });
        header.createEl("strong", { text: `第 ${week.number} 周` });
        header.createSpan({ text: `${week.start}—${week.end}` });
        header.createEl("small", { text: `合计 ¥ ${money(week.totalCents)}` });
        const plot = group.createDiv({ cls: "echoink-finance-ai-daily", attr: { role: "group",
          "aria-label": `第 ${week.number} 周 ${week.start} 至 ${week.end}，合计 ¥ ${money(week.totalCents)}` } });
        plot.style.setProperty("--finance-week-days", String(week.points.length));
        for (const point of week.points) {
          const date = /^\d{2}-\d{2}$/u.test(point.label) ? `${this.state.month.slice(0, 4)}-${point.label}` : point.label;
          const label = `${date} · ¥ ${money(point.valueCents)}`;
          const column = plot.createDiv({ cls: "echoink-finance-ai-daily-column", attr: { tabindex: "0", "aria-label": label } });
          const barArea = column.createDiv({ cls: "echoink-finance-ai-daily-bar-area" });
          if (point.valueCents > 0) barArea.createDiv({ cls: "echoink-finance-ai-daily-bar" }).style.height = `${Math.max(2, point.valueCents / max * 126)}px`;
          column.createEl("small", { text: point.label.slice(-2), attr: { "aria-hidden": "true" } });
          const show = (event?: MouseEvent): void => {
            tooltip.setText(label); tooltip.hidden = false; tooltip.setAttribute("aria-hidden", "false");
            panel.ownerDocument.addEventListener("keydown", onEscape);
            scrollHost?.addEventListener("scroll", hide, { passive: true });
            position(column, event);
          };
          column.onmouseenter = (event) => show(event);
          column.onmousemove = (event) => { if (!tooltip.hidden) position(column, event); };
          column.onfocus = () => show();
          column.onmouseleave = column.onblur = hide;
        }
      }
    } else if (chart.id === "large") {
      const total = chart.points.reduce((value, point) => value + Math.max(0, point.valueCents), 0);
      const stack = panel.createDiv({ cls: "echoink-finance-ai-stack", attr: { role: "img", "aria-label": chart.points.map((point) =>
        `${point.label} ¥ ${money(point.valueCents)}`).join("；") } });
      for (const [index, point] of chart.points.entries()) {
        const share = total ? point.valueCents / total * 100 : 0;
        const segment = stack.createDiv({ cls: index ? "is-rest" : "is-large" });
        segment.style.width = `${Math.max(0, share)}%`;
        segment.title = `${point.label} · ¥ ${money(point.valueCents)} · ${share.toFixed(1)}%`;
      }
      const legend = panel.createDiv({ cls: "echoink-finance-ai-legend" });
      for (const [index, point] of chart.points.entries()) {
        const share = total ? point.valueCents / total * 100 : 0;
        const row = legend.createDiv({ cls: "echoink-finance-ai-legend-item", attr: { tabindex: "0",
          "aria-label": `${point.label} ¥ ${money(point.valueCents)}，占 ${share.toFixed(1)}%`,
          "data-value": `¥ ${money(point.valueCents)} · ${share.toFixed(1)}%` } });
        row.createSpan({ cls: index ? "is-rest" : "is-large", attr: { "aria-hidden": "true" } });
        row.createSpan({ text: point.label }); row.createEl("strong", { text: `${share.toFixed(1)}%` });
      }
    } else {
      if (chart.id === "budget") {
        const key = panel.createDiv({ cls: "echoink-finance-ai-chart-key is-comparison-key" });
        key.createSpan({ text: "实际净支出", cls: "is-actual" });
        key.createSpan({ text: "预算", cls: "is-budget" });
        key.createSpan({ text: "中线为零" });
      }
      if (chart.id === "flow") panel.createEl("p", { text: "中线为零；负值向左，正值向右。", cls: "echoink-finance-ai-chart-key" });
      for (const point of chart.points) {
        const negativeBudget = chart.id === "budget" && point.valueCents < 0;
        const label = `${point.label}：¥ ${money(point.valueCents)}${point.comparisonCents === undefined ? "" : `；预算 ¥ ${money(point.comparisonCents)}`}`;
        const row = panel.createDiv({ cls: "echoink-finance-ai-chart-row", attr: { tabindex: "0", "aria-label": label, "data-value": label } });
        row.title = label;
        row.createSpan({ text: point.label });
        row.createSpan({ text: `¥ ${money(point.valueCents)}${negativeBudget ? "（退款超过消费）" : ""}${point.comparisonCents === undefined ? "" : ` / 预算 ¥ ${money(point.comparisonCents)}`}` });
        const track = row.createDiv({ cls: chart.id === "flow" ? "echoink-finance-ai-chart-track is-flow" :
          chart.id === "budget" ? "echoink-finance-ai-chart-track is-comparison" : "echoink-finance-ai-chart-track" });
        const bar = track.createDiv({ cls: point.valueCents < 0 ? "is-negative" : "" });
        if (chart.id === "flow" || chart.id === "budget") {
          bar.style.left = point.valueCents < 0 ? `${50 - Math.abs(point.valueCents) / max * 50}%` : "50%";
          bar.style.width = `${Math.abs(point.valueCents) / max * 50}%`;
        } else bar.style.width = `${Math.abs(point.valueCents) / max * 100}%`;
        if (point.comparisonCents !== undefined) {
          const comparison = track.createDiv({ cls: "is-budget" });
          comparison.style.width = `${point.comparisonCents / max * 50}%`;
        }
      }
    }
    const takeaway = panel.createDiv({ cls: "echoink-finance-ai-chart-explanation" });
    takeaway.createSpan({ text: "图中发现", cls: "echoink-finance-ai-chart-explanation-label" });
    if (markdown) this.renderAnalysisMarkdown(takeaway.createDiv({ cls: "echoink-finance-report markdown-rendered" }), chart.explanation);
    else takeaway.createEl("p", { text: chart.explanation });
  }
  private ledger(body: HTMLElement): void {
    if (this.state.returnScroll !== undefined) button(body, "← 返回概览", () => this.returnFromLedger(), "echoink-finance-ledger-return");
    this.intro(body, "每笔收支，都能查清。", "搜索、筛选和导出当前月的账目。");
    body.createDiv({ cls: "echoink-finance-metrics echoink-finance-ledger-metrics" });
    const panel = body.createDiv({ cls: "echoink-finance-card echoink-finance-ledger" });
    const heading = panel.createDiv({ cls: "echoink-finance-ledger-heading" });
    heading.createEl("h3", { text: "每一笔，都有来处" });
    const exportButton = button(heading, "", () => this.exportCsv(), "echoink-finance-export");
    exportButton.disabled = !this.service.finance.access.checkCapability("finance.export");
    const exportNotice = capabilityMessage(this.service.finance.access, "finance.export");
    if (exportNotice) exportButton.title = exportNotice;
    setIcon(exportButton.createSpan({ attr: { "aria-hidden": "true" } }), "download");
    exportButton.createSpan({ text: "导出 CSV" });
    const toolbar = panel.createDiv({ cls: "echoink-finance-toolbar" });
    const searchLabel = toolbar.createEl("label", { cls: "echoink-finance-ledger-search" });
    searchLabel.createSpan({ cls: "echoink-finance-visually-hidden", text: "搜索商户、说明、备注" });
    setIcon(searchLabel.createSpan({ cls: "echoink-finance-search-icon", attr: { "aria-hidden": "true" } }), "search");
    const search = searchLabel.createEl("input", { attr: { type: "search", placeholder: "搜索商户、消费说明…" } });
    search.value = this.state.filters.search;
    search.oninput = () => { this.state.filters.search = search.value; this.updateLedgerRows(panel); };
    const allEntries = this.entries().filter((entry) => entry.date.startsWith(this.state.month));
    const merchants = [...new Set(allEntries.map((entry) => entry.merchant))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    if (this.state.filters.merchant && !merchants.includes(this.state.filters.merchant)) merchants.push(this.state.filters.merchant);
    const filters = toolbar.createDiv({ cls: "echoink-finance-ledger-filters", attr: { role: "group", "aria-label": "账目筛选" } });
    select(filters, "类型", [["all", "全部类型"], ["spending", "消费与退款"], ...Object.entries(labels)], this.state.filters.kind, (value) => {
      this.state.filters.kind = value as FinanceFilters["kind"];
      this.state.filters.validExpenseOnly = false; this.state.filters.date = undefined;
      this.state.filters.minCents = undefined; this.state.filters.maxCents = undefined;
      this.state.filters.exactAccount = undefined; this.state.filters.exactCategory = undefined;
      this.state.filters.excludedCategories = []; this.state.filters.excludedIds = []; this.state.groupIntent = null;
      this.state.filterLabel = undefined; this.redraw();
    });
    const accounts = [...new Set(allEntries.map((entry) => entry.account).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    if (this.state.filters.account && !accounts.includes(this.state.filters.account)) accounts.push(this.state.filters.account);
    const noAccount = "__echoink_unassigned__";
    select(filters, "账户", [["", "全部账户"], [noAccount, "未指定账户"], ...accounts.map((name): [string, string] => [name, name])],
      this.state.filters.exactAccount === "" ? noAccount : this.state.filters.exactAccount ?? this.state.filters.account,
      (value) => { this.state.filters.exactAccount = value === noAccount ? "" : undefined;
        this.state.filters.account = value === noAccount ? "" : value; this.state.filterLabel = undefined; this.redraw(); });
    select(filters, "商户", [["", "全部商户"], ...merchants.map((name): [string, string] => [name, name === this.state.filters.merchant && !allEntries.some((entry) => entry.merchant === name) ? `${name}（本月无记录）` : name])], this.state.filters.merchant, (value) => { this.state.filters.merchant = value; this.updateLedgerRows(panel); });
    const noCategory = "__echoink_uncategorized__";
    select(filters, "分类", [["", "全部分类"], [noCategory, "未分类"], ...this.categories().filter(Boolean).map((category): [string, string] => [category, category])],
      this.state.filters.exactCategory === "" ? noCategory : this.state.filters.exactCategory ?? this.state.filters.category,
      (value) => { this.state.filters.category = value === noCategory ? "" : value;
        this.state.filters.exactCategory = value === noCategory ? "" : undefined;
        this.state.filters.excludedCategories = []; this.state.filters.excludedIds = [];
        this.state.groupIntent = null; this.state.filterLabel = undefined; this.redraw(); });
    this.updateLedgerRows(panel);
  }
  private updateLedgerRows(panel: HTMLElement): void {
    this.applyGroupIntent();
    this.stopLedgerSize?.(); this.stopLedgerSize = null;
    const old = panel.querySelector<HTMLElement>(".echoink-finance-ledger-rows"); if (old) { disposeOriginControls(old); old.remove(); }
    const rows = panel.createDiv({ cls: "echoink-finance-ledger-rows" });
    const entries = filterFinanceEntries(this.entries(), this.state.month, this.state.filters);
    const metrics = this.host?.querySelector<HTMLElement>(".echoink-finance-ledger-metrics");
    if (metrics) {
      metrics.empty();
      const summary = financeSummary(entries, this.state.month, this.categories());
      const prefix = this.filterSummary().length ? "筛选" : "本月";
      this.card(metrics, `${prefix}收入`, summary.incomeCents, "", "ledger.income");
      this.card(metrics, `${prefix}净支出`, summary.netExpenseCents, "", "ledger.net");
      this.card(metrics, `${prefix}收支差额`, summary.balanceCents, "不是账户余额", "ledger.balance");
    }
    const filterKey = JSON.stringify([this.state.month, this.state.filters]);
    if (filterKey !== this.ledgerFilterKey) { this.ledgerPage = 1; this.ledgerFilterKey = filterKey; }
    const page = financePage(entries, this.ledgerPage); this.ledgerPage = page.page;
    const active = this.filterSummary();
    if (active.length) {
      const controls = rows.createDiv({ cls: "echoink-finance-ledger-controls" });
      controls.createSpan({ text: `筛选：${active.join(" · ")}` });
      button(controls, "清除筛选", () => { this.state.filters = emptyFilters(); this.state.groupIntent = null; this.state.filterLabel = undefined; this.redraw(); });
      if (this.state.groupIntent) button(controls, "其他分组 ×", () => { this.state.groupIntent = null; this.state.filters.excludedCategories = []; this.state.filters.excludedIds = []; this.updateLedgerRows(panel); }, "echoink-finance-group-chip");
    }
    const list = rows.createDiv({ cls: "echoink-finance-ledger-list", attr: { tabindex: "0" } });
    const columns = list.createDiv({ cls: "echoink-finance-transaction-head" });
    for (const name of ["商户 / 说明", "分类", "日期", "金额", "账户"]) columns.createSpan({ text: name });
    if (!entries.length) list.createEl("p", { text: "当前条件下没有匹配的账目。", cls: "echoink-finance-empty" });
    for (const entry of page.items) this.transactionRow(list, entry);
    const foot = rows.createDiv({ cls: "echoink-finance-ledger-foot" });
    foot.createSpan({ text: `共 ${entries.length} 笔${this.state.filters.validExpenseOnly ? ` · 消费原额 ¥ ${money(entries.reduce((sum, entry) => sum + entry.amountCents, 0))}` : ""}` });
    foot.createSpan({ text: "退款抵扣支出 · 内部转账不计收支" });
    const pagination = financePagination(rows, page.page, page.pages, entries.length, target => {
      this.ledgerPage = target; this.updateLedgerRows(panel);
      panel.querySelector<HTMLElement>('button[aria-current="page"]')?.focus({ preventScroll: true });
    });
    this.stopLedgerSize = fitFinanceList(list, pagination);
  }
  private transactionRow(parent: HTMLElement, entry: FinanceEntry, compact = false): void {
    const row = parent.createDiv({ cls: `echoink-finance-transaction${compact ? " is-compact" : ""}`, attr: { role: "button", tabindex: "0" } });
    row.setAttribute("aria-label", `${entry.merchant}，${labels[entry.kind]} ${money(entry.amountCents)} 元，查看详情`);
    row.onclick = () => this.detailDialog(entry);
    row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); row.click(); } };
    const merchant = row.createDiv({ cls: "echoink-finance-transaction-merchant" });
    merchantIcon(merchant, entry, this.catalog());
    const copy = merchant.createDiv({ cls: "echoink-finance-transaction-copy" });
    copy.createEl("strong", { text: entry.merchant }); copy.createEl("small", { text: entry.description || entry.category });
    const category = row.createDiv({ cls: "echoink-finance-transaction-category" });
    const categoryLine = category.createSpan({ cls: "echoink-finance-transaction-category-line" });
    const dot = categoryLine.createSpan({ cls: "echoink-finance-category-dot", attr: { "aria-hidden": "true" } });
    dot.style.setProperty("--finance-category-color", financeCategoryVisual(entry.category, this.catalog()).color);
    categoryLine.createSpan({ text: entry.category });
    if (entry.kind === "refund") category.createEl("small", { text: "退款", cls: "echoink-finance-refund-label" });
    row.createEl("time", { text: this.state.page === "billPlans" ? entry.date.slice(0, 10) : entry.date.slice(5, 10).replace("-", " / "), attr: { datetime: entry.date.slice(0, 10) } });
    const amount = entry.kind === "expense" ? "−" : entry.kind === "transfer" ? "" : "+";
    row.createEl("strong", { text: `${amount}¥ ${money(entry.amountCents)}`, cls: `echoink-finance-transaction-amount${entry.kind === "expense" ? "" : " is-positive"}` });
    row.createEl("small", { text: entry.account, cls: "echoink-finance-transaction-account" });
  }
  private writeButton(parent: HTMLElement, label: string, run: () => void, cls = ""): HTMLButtonElement {
    const control = button(parent, label, run, cls);
    control.disabled = !this.service.finance.accessState().canWrite;
    return control;
  }

  private budget(body: HTMLElement): void {
    const summary = this.summary(); const plan = this.plan();
    const intro = this.intro(body, "花得有数，也留得从容。", "看看每一类支出，还剩下多少空间。");
    const actions = intro.createDiv({ cls: "echoink-finance-budget-page-actions" });
    this.writeButton(actions, plan ? "调整预算" : "设置预算", () => this.budgetDialog(), "echoink-finance-primary");
    if (plan) actions.createSpan({ cls: "echoink-finance-budget-source", text: this.data().budgets.some(budget => budget.month === this.state.month) ? "本月独立" : "沿用每月默认" });
    if (!plan) { body.createEl("p", { text: "还没有为这个月设置预算。", cls: "echoink-finance-empty" }); return; }
    const overview = body.createDiv({ cls: "echoink-finance-budget-overview" });
    const total = this.card(overview, "本月总预算", plan.totalCents, `已使用 ¥ ${money(summary.netExpenseCents)} · ${Math.max(0, summary.netExpenseCents / plan.totalCents * 100).toFixed(1)}%`);
    const totalProgress = total.createDiv({ cls: "echoink-finance-progress" }); totalProgress.createDiv({ attr: { style: `width:${Math.min(100, Math.max(0, summary.netExpenseCents / plan.totalCents * 100))}%` } });
    if (budgetUnallocated(plan)) total.createEl("small", { text: `未分配到分类 ¥ ${money(budgetUnallocated(plan))}，保留在总预算中。` });
    const remaining = plan.totalCents - summary.netExpenseCents;
    const rest = this.card(overview, remaining >= 0 ? "可用预算" : "超出预算", Math.abs(remaining), "总预算减本月净支出", "budget.remaining");
    button(rest, "回看本月账目 ↗", () => this.allLedger());
    const grid = body.createDiv({ cls: "echoink-finance-budget-grid" });
    for (const category of this.categories()) {
      const allocation = plan.allocations[category] ?? 0, spent = summary.categoryExpenseCents[category] ?? 0, left = allocation - spent;
      const card = grid.createDiv({ cls: "echoink-finance-card" });
      const head = card.createDiv({ cls: "echoink-finance-section-head" });
      const title = head.createEl("h3", { cls: "echoink-finance-budget-category-title" });
      categoryIcon(title, category, "echoink-finance-category-icon", this.catalog()); title.createSpan({ text: category });
      this.writeButton(head, "调整额度", () => this.budgetDialog(category));
      card.createEl("strong", { text: `¥ ${money(spent)} / ${money(allocation)}`, cls: "echoink-finance-number" });
      const progress = card.createDiv({ cls: "echoink-finance-progress" }); progress.createDiv({ attr: { style: `width:${allocation ? Math.min(100, Math.max(0, spent / allocation * 100)) : spent > 0 ? 100 : 0}%` } });
      const foot = card.createDiv({ cls: "echoink-finance-section-head" });
      foot.createEl("small", { text: `${left >= 0 ? "剩余" : "超出"} ¥ ${money(Math.abs(left))}` });
      button(foot, "查看账目 ↗", () => this.go("ledger", category, "spending"));
    }
  }
  private billPlanDialog(plan?: FinanceBillPlan): void {
    new FinanceDialog(this.service, plan ? "修改预算" : "新建账单", (content, dialog) => {
      const form = content.createEl("form", { cls: "echoink-finance-form" });
      const name = field(form, "账单名称", "text", plan?.name || ""); name.required = true;
      const budget = field(form, "总预算 · 元", "number", plan ? yuanInput(plan.budgetCents) : ""); budget.min = "0.01"; budget.step = "0.01"; budget.required = true;
      const error = form.createEl("p", { cls: "echoink-life-error", attr: { role: "alert" } });
      const actions = form.createDiv({ cls: "echoink-finance-dialog-actions" });
      const cancel = button(actions, "取消", () => dialog.close());
      const save = actions.createEl("button", { text: plan ? "保存预算" : "保存账单", cls: "echoink-finance-primary", attr: { type: "submit" } });
      const id = plan?.id || lifeId("bill-plan"); let saving = false;
      dialog.bindWrite(save, () => saving, undefined, "finance.bill_plan.write");
      form.onsubmit = (event) => {
        event.preventDefault(); if (saving) return;
        try {
          const next = { id, name: name.value.trim(), budgetCents: parseYuan(budget.value) };
          if (!next.name) throw new Error("请填写账单名称");
          saving = true; dialog.refreshAccess(); cancel.disabled = name.disabled = budget.disabled = true;
          void this.service.finance.saveBillPlan(next).then(() => {
            dialog.close(); if (plan) this.redraw(); else this.billPlanView.showPlan(id);
          }).catch((cause) => { error.setText(errorText(cause)); saving = false; dialog.refreshAccess(); cancel.disabled = name.disabled = budget.disabled = false; });
        } catch (cause) { error.setText(errorText(cause)); }
      };
    }).open();
  }
  private addDialog(billPlanId?: string): void {
    new FinanceDialog(this.service, "记一笔", (content, dialog) => {
      const form = content.createEl("form", { cls: "echoink-finance-form" });
      const kind = select(form, "交易类型", Object.entries(labels), "expense", () => undefined);
      const amount = field(form, "金额 · 元", "number"); amount.min = "0.01"; amount.step = "0.01"; amount.required = true;
      const merchant = field(form, "商户／对方名称"); merchant.required = true;
      const categoryNames = financeSelectableCategoryNames(this.catalog());
      const category = select(form, "分类", categoryNames.map((item): [string, string] => [item, item]), categoryNames.includes("餐饮") ? "餐饮" : categoryNames[0], () => undefined);
      merchant.onchange = () => { const suggested = resolveFinanceMerchant(merchant.value, this.catalog()).defaultCategory; if (suggested && categoryNames.includes(suggested)) category.value = suggested; };
      const account = field(form, "账户", "text", "手动记录");
      const date = field(form, "日期", "date", new Date().toLocaleDateString("sv-SE"));
      const description = field(form, "消费说明");
      const note = field(form, "备注");
      const error = form.createEl("p", { cls: "echoink-life-error" });
      const actions = form.createDiv({ cls: "echoink-finance-dialog-actions" });
      button(actions, "取消", () => dialog.close());
      const save = actions.createEl("button", { text: "保存记录", cls: "echoink-finance-primary", attr: { type: "submit" } });
      let saving = false;
      dialog.bindWrite(save, () => saving, undefined, billPlanId ? "finance.bill_plan.write" : undefined);
      form.onsubmit = (event) => {
        event.preventDefault(); if (saving) return; saving = true; dialog.refreshAccess();
        void (async () => {
          try {
            const resolvedMerchant = resolveFinanceMerchant(merchant.value, this.catalog());
            const created = await this.service.finance.addManual({ date: `${date.value} 12:00:00`, merchant: resolvedMerchant.name,
              category: category.value, kind: kind.value as FinanceKind, amountCents: parseYuan(amount.value), status: "completed",
              account: resolveFinanceAccount(account.value, this.catalog()) || "手动记录", description: description.value.trim(), currency: "CNY", note: note.value.trim(), icon: resolvedMerchant.iconId || "auto", ...(billPlanId ? { billPlanId } : {}) });
            if (!billPlanId) { this.state.month = created.date.slice(0, 7); this.applyGroupIntent(); } dialog.close(); this.redraw(); new Notice("已记下这笔账目");
          } catch (cause) { error.setText(errorText(cause)); saving = false; dialog.refreshAccess(); }
        })();
      };
    }).open();
  }
  private detailDialog(entry: FinanceEntry): void {
    new FinanceDialog(this.service, "账目详情", (content, dialog) => {
      const detail = content.createDiv({ cls: "echoink-finance-detail-page" });
      const brand = detail.createDiv({ cls: "echoink-finance-detail-brand" });
      merchantIcon(brand, entry, this.catalog());
      const amount = detail.createEl("strong", { text: `${entry.kind === "expense" ? "−" : "+"}¥ ${money(entry.amountCents)}`, cls: "echoink-finance-detail-amount" });
      amount.setAttribute("aria-label", `${labels[entry.kind]} ${money(entry.amountCents)} 元`);
      const form = detail.createEl("form", { cls: "echoink-finance-detail-form" });
      const merchant = field(form, "商户 / 对方", "text", entry.merchant);
      merchant.maxLength = 60; merchant.required = true;
      const candidates = form.createEl("datalist", { attr: { id: "echoink-finance-merchants" } });
      for (const name of [...new Set(this.entries().map((item) => item.merchant))]) candidates.createEl("option", { value: name });
      merchant.setAttribute("list", "echoink-finance-merchants");
      const descriptionRow = form.createEl("label", { cls: "echoink-finance-field" });
      descriptionRow.createEl("span", { text: "消费说明" });
      const description = descriptionRow.createEl("textarea");
      description.value = entry.description; description.maxLength = 200;
      const category = select(form, "分类", this.categories(entry.date.slice(0, 7)).map((item): [string, string] => [item, item]), entry.category, () => undefined);
      const accountNames = [...new Set([
        ...this.catalog().accounts.filter((item) => item.active).map((item) => item.name),
        ...this.entries().map((item) => item.account), entry.account
      ].filter(Boolean))];
      const account = select(form, "账户", accountNames.map((name): [string, string] => [name, name]), entry.account, () => undefined);
      const plans = this.service.finance.billPlans();
      const planChoices: [string, string][] = [["", "不关联账单"], ...plans.map((plan): [string, string] => [plan.id, plan.name])];
      if (entry.billPlanId && !plans.some(plan => plan.id === entry.billPlanId)) planChoices.push([entry.billPlanId, "原账单未找到（保留关联）"]);
      const billPlan = select(form, "账单计划", planChoices, entry.billPlanId || "", () => undefined);
      let iconValue = entry.icon || "auto";
      const iconRow = form.createDiv({ cls: "echoink-finance-icon-field" });
      iconRow.createSpan({ text: "图标" });
      const iconTrigger = iconRow.createEl("button", { cls: "echoink-finance-icon-trigger", attr: { type: "button" } });
      const art = iconTrigger.createSpan({ cls: "echoink-finance-icon-art", attr: { "aria-hidden": "true" } });
      const iconLabel = iconTrigger.createSpan(); iconTrigger.createSpan({ text: "›", attr: { "aria-hidden": "true" } });
      const drawIcon = (): void => {
        renderFinanceIcon(art, iconValue);
        iconLabel.setText(financeIconOptions("entry").find((option) => option.id === iconValue)?.name || iconValue);
        iconTrigger.setAttr("aria-label", `图标：${iconLabel.textContent}，进入选择`);
      };
      iconTrigger.onclick = () => openFinanceIconPicker(content, detail, "entry", iconValue, (id) => { iconValue = id; drawIcon(); }, iconTrigger, this.service.plugin.app);
      drawIcon();
      const error = form.createEl("p", { cls: "echoink-finance-error", attr: { role: "alert" } });
      const list = detail.createEl("dl", { cls: "echoink-finance-details" });
      for (const [key, value] of [["类型", labels[entry.kind]], ["日期", entry.date], ["备注", entry.note || "—"], ["状态", entry.status === "completed" ? "已完成" : "未完成"]]) {
        list.createEl("dt", { text: key }); list.createEl("dd", { text: value });
      }
      const actions = detail.createDiv({ cls: "echoink-finance-dialog-actions" });
      button(actions, "在笔记中查看 Bases", () => void this.service.finance.openBase(entry.id)
        .then(() => dialog.close()).catch((cause) => new Notice(errorText(cause))));
      button(actions, "取消", () => dialog.close());
      const save = button(actions, "保存修改", () => form.requestSubmit(), "echoink-finance-primary");
      let saving = false;
      dialog.bindWrite(save, () => saving);
      form.onsubmit = (event) => {
        event.preventDefault(); if (saving) return; saving = true; dialog.refreshAccess();
        void this.service.finance.updateDetails(entry.id, merchant.value, description.value, iconValue, category.value, account.value, billPlan.value === (entry.billPlanId || "") ? undefined : billPlan.value || null)
          .then(() => { dialog.close(); this.redraw(); new Notice("已保存当前账目的修改"); })
          .catch((cause) => { error.setText(errorText(cause)); saving = false; dialog.refreshAccess(); });
      };
    }).open();
  }
  private importDialog(): void {
    new FinanceDialog(this.service, "导入账单", (content, dialog) => {
      dialog.modalEl.addClass("echoink-finance-import-dialog");
      content.createEl("p", { cls: "echoink-finance-import-intro", text: "选择微信或支付宝的 CSV／XLSX 账单。" });
      const help = content.createEl("details", { cls: "echoink-finance-import-help" });
      const helpSummary = help.createEl("summary");
      helpSummary.createSpan({ text: "如何获取账单流水？" });
      const helpArrow = helpSummary.createSpan({ cls: "echoink-finance-import-help-arrow", attr: { "aria-hidden": "true" } });
      setIcon(helpArrow, "chevron-right");
      const helpBody = help.createDiv({ cls: "echoink-finance-import-help-body" });
      helpBody.createEl("p", { text: "微信：我 → 服务 → 钱包 → 账单 → 常见问题（部分版本为客服中心）→ 下载账单 → 用于个人对账。" });
      helpBody.createEl("p", { text: "支付宝：我的 → 账单 → 右上角… → 开具交易流水证明 → 用于个人对账。" });
      helpBody.createEl("p", { text: "选择日期，按提示下载或发送到邮箱。ZIP 先解压，再导入 CSV／XLSX，不选 PDF。" });
      helpBody.createEl("p", { text: "支付宝如提供“展示交易对手信息”“展示商品说明信息”，请勾选，便于整理账目。" });
      const fields = content.createDiv({ cls: "echoink-finance-import-fields" });
      const source = select(fields, "账单来源", [["wechat", "微信"], ["alipay", "支付宝"]], "wechat", () => undefined);
      const file = field(fields, "选择账单文件", "file"); file.accept = ".csv,.xlsx";
      const status = content.createEl("p", { cls: "echoink-finance-import-status", attr: { role: "status" } });
      const progress = content.createEl("progress", { cls: "echoink-finance-import-read-progress", attr: { "aria-label": "读取账单进度" } });
      progress.hidden = true;
      const details = content.createDiv({ cls: "echoink-finance-import-preview", attr: { "aria-label": "导入明细" } });
      const issues = content.createEl("details", { cls: "echoink-finance-import-issues" });
      const issueSummary = issues.createEl("summary");
      const issueList = issues.createDiv();
      issues.hidden = true;
      const actions = content.createDiv({ cls: "echoink-finance-dialog-actions echoink-finance-import-actions" });
      const cancel = button(actions, "取消", () => dialog.close());
      const confirm = applyAmicroButton(button(actions, "开始导入", () => void run(), "echoink-finance-primary"), { variant: "primary" });

      let revision = 0;
      let controller: AbortController | null = null;
      let reader: FileReader | null = null;
      let rows: FinanceImportRow[] = [];
      let phase: "ready" | "reading" | "running" | "stopping" | "done" | "stopped" | "error" = "ready";
      let closed = false;
      let saved = 0;
      let updated = 0;
      let noRows = true;
      dialog.bindWrite(confirm, () => phase === "reading" || phase === "stopping" || phase === "ready" && noRows, () => phase === "ready");
      const stop = (): void => {
        controller?.abort();
        if (reader?.readyState === FileReader.LOADING) reader.abort();
        if (phase === "running") { phase = "stopping"; status.setText("正在停止，当前账目保存完成后结束…"); dialog.refreshAccess(); }
      };
      dialog.whenClosed = () => { closed = true; ++revision; stop(); };
      const action = (state: "ready" | "running" | "done" | "stopped" | "error"): void => {
        confirm.empty(); confirm.removeClass("is-finance-running", "is-finance-done");
        confirm.setAttr("aria-busy", state === "running" ? "true" : "false");
        if (state === "running") {
          confirm.addClass("is-finance-running");
          const icon = confirm.createSpan({ cls: "echoink-finance-import-action-icon" });
          renderAnimateIcon(icon, "circle-stop");
          confirm.createSpan({ text: "停止" });
          confirm.setAttr("aria-label", "停止导入"); confirm.title = "停止导入";
          confirm.onclick = stop;
        } else if (state === "done") {
          confirm.addClass("is-finance-done");
          const icon = confirm.createSpan({ cls: "echoink-finance-import-action-icon" }); setIcon(icon, "check");
          confirm.createSpan({ text: "完成" }); confirm.setAttr("aria-label", "完成并关闭"); confirm.title = "完成并关闭";
          confirm.onclick = () => dialog.close();
        } else {
          confirm.setText(state === "ready" ? "开始导入" : "关闭");
          confirm.setAttr("aria-label", state === "ready" ? "开始导入" : "关闭导入窗口");
          confirm.title = state === "ready" ? "开始导入" : "关闭导入窗口";
          confirm.onclick = state === "ready" ? () => void run() : () => dialog.close();
        }
        cancel.hidden = state !== "ready";
        dialog.refreshAccess();
      };
      const append = (entry: FinanceImportRow["entry"], verb: string): void => {
        if (!entry || closed) return;
        const follow = details.scrollHeight - details.scrollTop - details.clientHeight < 32;
        details.createEl("p", { cls: "echoink-finance-import-event", text: `${verb} · ${entry.merchant} · ¥ ${money(entry.amountCents)}` });
        if (follow && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) details.scrollTop = details.scrollHeight;
      };
      const showIssues = (items: ReadonlyMap<string, string>, warnings: readonly string[] = []): void => {
        issueList.empty(); issues.hidden = items.size === 0 && warnings.length === 0;
        issueSummary.setText(items.size ? `有 ${items.size} 笔需要确认` : "整理提示");
        for (const reason of items.values()) issueList.createEl("p", { text: reason });
        for (const warning of warnings) issueList.createEl("p", { text: warning });
      };
      const baseIssues = (): Map<string, string> => {
        const found = new Map<string, string>();
        for (const [index, row] of rows.entries()) {
          if (!row.entry && row.error) found.set(`invalid:${index}`, `未导入：${row.error}`);
          else if (row.entry && row.review) found.set(`${row.entry.source}:${row.entry.sourceId}`, `${row.entry.merchant}：${row.review}`);
        }
        return found;
      };
      const renderReady = (): void => {
        details.empty(); issues.hidden = true;
        const result = this.service.finance.previewImport(rows);
        const writable = result.added.length + result.updated.length;
        status.setText(writable ? `已读取 ${rows.length} 行记录，点击开始导入` : !rows.length ? "没有可导入的记录" : result.invalid ? `已读取 ${rows.length} 行记录，部分记录无法导入` : "这些记录已导入");
        noRows = !result.added.length && !result.updated.length; dialog.refreshAccess();
        if (result.duplicates) details.createEl("p", { text: `${result.duplicates} 笔已存在，将跳过` });
        showIssues(baseIssues());
      };
      const run = async (): Promise<void> => {
        if (phase !== "ready" || confirm.disabled) return;
        phase = "running"; saved = 0; updated = 0;
        controller = new AbortController(); const signal = controller.signal;
        const current = revision;
        const savedIds = new Set<string>();
        const problems = baseIssues();
        let warnings: string[] = [];
        let writeError = "";
        let failure = "";
        source.disabled = true; file.disabled = true; details.empty(); issues.hidden = true;
        action("running"); status.setText("正在保存账目…");
        try {
          const result = await this.service.finance.confirmImport(rows, { signal, onSaved: (entry, kind) => {
            savedIds.add(entry.id);
            if (kind === "added") saved++; else updated++;
            append(entry, kind === "added" ? "已保存" : "已更新");
            if (!closed && !signal.aborted) status.setText(`已保存 ${saved} 笔账目${updated ? `，更新 ${updated} 笔` : ""}`);
          } });
          if (closed || current !== revision) return;
          if (result.added || result.updated) {
            this.state.filters = emptyFilters(); this.state.groupIntent = null; this.state.page = "ledger";
            this.state.month = rows.find((row) => row.entry)?.entry?.date.slice(0, 7) ?? this.state.month;
            this.redraw();
          }
          writeError = result.writeError || "";
          warnings = writeError ? [`保存中断：${writeError}`] : [];
          if (!signal.aborted && !result.writeError && result.created.length) {
            status.setText(`已保存 ${saved} 笔账目，正在识别…`);
            let processed = 0;
            const organized = await this.service.finance.prepareImport(result.created, signal, (_done, _total, batchRows) => {
              if (closed || signal.aborted) return;
              processed += batchRows.length;
              for (const row of batchRows) append(row.entry, row.review ? "需确认" : "已识别");
              status.setText(`已保存 ${saved} 笔账目，已处理 ${processed}/${result.created.length} 笔`);
            });
            if (closed || current !== revision) return;
            warnings = [...new Set(organized.warnings.map((warning) => warning.includes("未启用") ? "" : "部分账目整理未完成；基础账目已保存，可在账目详情检查").filter(Boolean))];
            for (const row of organized.rows) if (row.entry && row.review) {
              const key = `${row.entry.source}:${row.entry.sourceId}`;
              problems.set(key, `${row.entry.merchant}：${row.review}`);
            }
            if (!signal.aborted) {
              status.setText(`已保存 ${saved} 笔账目，正在保存整理结果…`);
              await this.service.finance.applyImportSuggestions(result.created, organized.rows, signal,
                (entry) => append(entry, "已整理"),
                (entry, reason) => problems.set(`${entry.source}:${entry.sourceId}`, `${entry.merchant}：${reason}`));
              if (closed || current !== revision) return;
              this.redraw();
            }
          }
        } catch (error) {
          if (!signal.aborted) failure = errorText(error);
        } finally {
          if (savedIds.size) {
            if (!closed) status.setText(`已保存 ${saved} 笔账目，正在整理账户目录…`);
            try { await this.service.finance.finalizeImportedAccounts(savedIds); }
            catch { warnings.push("账户目录未补全；已保存账目保留，可在财务设置中补充"); }
          }
          if (closed || current !== revision) {
            if (warnings.some((item) => item.includes("账户目录"))) new Notice("账户目录未补全；已保存账目保留");
          } else {
            showIssues(problems, warnings);
            if (signal.aborted) {
              phase = "stopped"; status.setText(`已停止；已导入 ${saved} 笔账目${updated ? `，更新 ${updated} 笔` : ""}，已保存内容保留。`); action("stopped");
            } else if (writeError || failure || warnings.length) {
              phase = "error"; status.setText(`已导入 ${saved} 笔账目；${writeError ? "保存中断" : failure || "部分后续整理未完成"}，请展开问题查看。`); action("error");
            } else {
              phase = "done"; status.setText(`已导入 ${saved} 笔账目${updated ? `，更新 ${updated} 笔` : ""}${problems.size ? `；有 ${problems.size} 笔需要确认` : ""}。`); action("done");
            }
          }
        }
      };
      const load = (): void => {
        stop(); const current = ++revision;
        controller = null; reader = null; phase = "ready"; rows = []; details.empty(); issues.hidden = true; progress.hidden = true; noRows = true; action("ready"); dialog.refreshAccess();
        const chosen = file.files?.[0];
        if (!chosen) { status.setText("请选择账单文件"); return; }
        phase = "reading"; progress.hidden = false; progress.removeAttribute("value");
        status.setText("正在读取账单…");
        const activeReader = new FileReader(); reader = activeReader;
        activeReader.onprogress = (event) => {
          if (current !== revision || !event.lengthComputable) return;
          progress.max = event.total; progress.value = event.loaded;
        };
        activeReader.onload = () => { void (async () => {
          try {
            if (current !== revision || !(activeReader.result instanceof ArrayBuffer)) return;
            progress.removeAttribute("value"); status.setText("正在解析账单…");
            const parsed = await readFinanceBill(new Uint8Array(activeReader.result), chosen.name, source.value as "wechat" | "alipay");
            if (current !== revision) return;
            progress.hidden = true; phase = "ready"; rows = parsed; renderReady();
          } catch (error) {
            if (current !== revision) return;
            progress.hidden = true; phase = "ready"; rows = []; status.setText(errorText(error));
          }
        })(); };
        activeReader.onerror = () => { if (current === revision) { progress.hidden = true; phase = "ready"; status.setText("账单读取失败，请重试"); } };
        activeReader.readAsArrayBuffer(chosen);
      };
      source.onchange = load;
      file.onchange = load;
    }).open();
  }
  private exportCsv(): void {
    const entries = filterFinanceEntries(this.entries(), this.state.month, this.state.filters);
    let csv: string;
    try { csv = this.service.finance.exportCsv(entries); } catch (error) { new Notice(errorText(error)); return; }
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `EchoInk-财务-${this.state.month}.csv`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  private budgetDialog(focusCategory?: FinanceCategory): void {
    const editor = new FinanceBudgetEditor(this.data(), this.state.month);
    let scope: "default" | "monthly" = editor.months.has(this.state.month) ? "monthly" : "default";
    let month = editor.months.has(this.state.month) ? this.state.month : [...editor.months.keys()].sort()[0] ?? this.state.month;
    let saving = false;
    new FinanceDialog(this.service, "调整月度预算", (content, modal) => {
      modal.modalEl.addClass("echoink-finance-budget-dialog"); modal.titleEl.addClass("echoink-finance-budget-title");
      const form = content.createEl("form", { cls: "echoink-finance-form echoink-finance-budget-form", attr: { novalidate: "true" } });
      const scroll = form.createDiv({ cls: "echoink-finance-budget-scroll" });
      const range = scroll.createDiv({ cls: "echoink-finance-segment echoink-finance-budget-scope", attr: { role: "group", "aria-label": "预算编辑范围" } });
      const defaultButton = button(range, "每月默认", () => { scope = "default"; draw(); });
      const monthlyButton = button(range, "按月独立", () => { scope = "monthly"; draw(); });
      scroll.createEl("p", { cls: "echoink-finance-budget-subtitle", text: "独立月份优先，其余月份沿用默认预算。" });
      const months = scroll.createDiv({ cls: "echoink-finance-budget-months" });
      const panel = scroll.createDiv({ cls: "echoink-finance-budget-draft" });
      const footer = form.createDiv({ cls: "echoink-finance-budget-footer" });
      const error = footer.createEl("p", { cls: "echoink-life-error", attr: { role: "alert" } });
      const actions = footer.createDiv({ cls: "echoink-finance-dialog-actions echoink-finance-budget-actions" });
      button(actions, "取消", () => modal.close());
      const save = actions.createEl("button", { text: "保存预算", cls: "echoink-finance-primary", attr: { type: "submit" } });
      let current: FinanceBudgetDraft | undefined;
      let invalidDraft = true;
      modal.bindWrite(save, () => saving || invalidDraft);
      const validateAll = (): void => {
        try {
          editor.changes(scope === "default"); error.setText("");
          invalidDraft = (scope === "monthly" && !editor.removed.size && ![...editor.months.values()].some(draft => draft.dirty) && !editor.defaultDraft.dirty);
        } catch (cause) { error.setText(errorText(cause)); invalidDraft = true; }
        modal.refreshAccess();
        for (const chip of Array.from(months.querySelectorAll<HTMLElement>("[data-budget-month]"))) {
          const draft = editor.months.get(chip.dataset.budgetMonth!);
          let invalid = false; try { if (draft?.dirty) parseFinanceBudgetDraft(draft, chip.dataset.budgetMonth!); } catch { invalid = true; }
          chip.setAttribute("aria-invalid", String(invalid));
        }
      };
      const draw = (): void => {
        defaultButton.toggleClass("is-active", scope === "default"); monthlyButton.toggleClass("is-active", scope === "monthly");
        defaultButton.setAttribute("aria-pressed", String(scope === "default")); monthlyButton.setAttribute("aria-pressed", String(scope === "monthly"));
        months.empty(); months.hidden = scope === "default"; panel.empty();
        if (scope === "monthly") {
          const controls = months.createDiv({ cls: "echoink-finance-budget-month-controls" });
          const picker = field(controls, "独立月份", "month", this.state.month); picker.setAttribute("aria-label", "新增独立预算月份");
          button(controls, "新增", () => { try { if (!editor.months.has(picker.value)) editor.add(picker.value); month = picker.value; draw(); } catch (cause) { error.setText(errorText(cause)); } });
          const tabs = months.createDiv({ cls: "echoink-finance-budget-month-tabs", attr: { role: "group", "aria-label": "独立预算月份" } });
          for (const key of [...editor.months.keys()].sort()) {
            const chip = button(tabs, key, () => { month = key; draw(); }, key === month ? "is-active" : "");
            chip.setAttribute("data-budget-month", key); chip.setAttribute("aria-pressed", String(key === month));
          }
          if (editor.months.has(month)) {
            const restore = button(controls, "恢复默认", () => { editor.restore(month); month = [...editor.months.keys()].sort()[0] ?? this.state.month; draw(); });
            restore.disabled = !editor.canRestore;
            if (!editor.canRestore) months.createEl("p", { cls: "echoink-finance-budget-hint", text: "先设置每月默认预算，再恢复默认。" });
          }
        }
        current = scope === "default" ? editor.defaultDraft : editor.months.get(month);
        if (!current) { panel.createEl("p", { cls: "echoink-finance-budget-hint", text: "暂无独立月份。选择月份后新增，或编辑每月默认预算。" }); validateAll(); return; }
        const draft = current;
        const categoryNotice = capabilityMessage(this.service.finance.access, "finance.category_budget.write");
        if (categoryNotice) panel.createEl("p", { cls: "echoink-finance-budget-hint", text: `总预算免费，分类分配：${categoryNotice}` });
        panel.createEl("p", { cls: "echoink-finance-budget-editing", text: scope === "default" ? "每月默认" : `${month} 独立预算` });
        const total = field(panel, "月度总预算 · 元", "number", draft.total); total.parentElement?.addClass("echoink-finance-budget-total");
        total.min = "1"; total.max = "99999999"; total.step = "0.01";
        const modeRow = panel.createDiv({ cls: "echoink-finance-budget-mode-row" }); modeRow.createEl("span", { text: "分类分配" });
        const segment = modeRow.createDiv({ cls: "echoink-finance-segment echoink-finance-budget-segment", attr: { role: "group", "aria-label": "预算分配方式" } });
        const switchMode = (next: BudgetMode): void => {
          if (next === draft.mode) return;
          try {
            const budget = parseFinanceBudgetDraft(draft, month);
            draft.values = Object.fromEntries(Object.entries(budget.allocations).map(([category, cents]) => [category, next === "amount" ? yuanInput(cents) : (cents / budget.totalCents * 100).toFixed(2)]));
            draft.mode = next; draft.dirty = true; draw();
          } catch (cause) { error.setText(errorText(cause)); }
        };
        const amount = button(segment, "按金额", () => switchMode("amount"), draft.mode === "amount" ? "is-active" : "");
        const percent = button(segment, "按比例", () => switchMode("percent"), draft.mode === "percent" ? "is-active" : "");
        amount.disabled = !!categoryNotice; percent.disabled = !!categoryNotice;
        amount.setAttribute("aria-pressed", String(draft.mode === "amount")); percent.setAttribute("aria-pressed", String(draft.mode === "percent"));
        panel.createEl("p", { cls: "echoink-finance-budget-hint", text: draft.mode === "amount" ? "修改总额不会缩放分类额度。" : "修改总额会重新计算分类额度；切换时四舍五入到两位小数。" });
        const head = panel.createDiv({ cls: "echoink-finance-budget-editor-head" });
        for (const label of ["分类", draft.mode === "amount" ? "预算金额" : "预算比例", draft.mode === "amount" ? "占比" : "折合金额"]) head.createSpan({ text: label });
        const rows = panel.createDiv({ cls: "echoink-finance-budget-editor" });
        const conversions = new Map<string, HTMLElement>(); const fields = new Map<string, HTMLInputElement>();
        for (const category of [...new Set([...this.categories(scope === "monthly" ? month : this.state.month), ...Object.keys(draft.values)])]) {
          const row = rows.createDiv({ cls: "echoink-finance-budget-editor-row" });
          const label = row.createEl("label", { cls: "echoink-finance-budget-editor-category", attr: { for: `echoink-budget-${category}` } });
          categoryIcon(label, category, "echoink-finance-category-icon", this.catalog()); label.createSpan({ text: category });
          const wrap = row.createDiv({ cls: "echoink-finance-budget-input-wrap" });
          const input = wrap.createEl("input", { attr: { id: `echoink-budget-${category}`, type: "number", min: "0", step: "0.01", "aria-label": `${category}预算${draft.mode === "amount" ? "金额" : "比例"}` } });
          input.value = draft.values[category] ?? "0.00"; fields.set(category, input); input.disabled = !!categoryNotice;
          wrap.createSpan({ cls: "echoink-finance-budget-unit", text: draft.mode === "amount" ? "元" : "%", attr: { "aria-hidden": "true" } });
          conversions.set(category, row.createSpan({ cls: "echoink-finance-budget-conversion" }));
          input.oninput = () => { draft.values[category] = input.value; draft.dirty = true; update(); };
        }
        const summary = panel.createDiv({ cls: "echoink-finance-allocation" });
        const update = (): void => {
          try {
            const budget = parseFinanceBudgetDraft(draft, month); summary.removeClass("is-error"); summary.empty();
            summary.createSpan({ text: `已分配 ¥ ${money(budget.totalCents - budgetUnallocated(budget))}` }); summary.createSpan({ text: `未分配 ¥ ${money(budgetUnallocated(budget))}` });
            for (const [category, converted] of conversions) converted.setText(draft.mode === "amount" ? `${((budget.allocations[category] ?? 0) / budget.totalCents * 100).toFixed(1)}%` : `¥ ${money(budget.allocations[category] ?? 0)}`);
          } catch (cause) { summary.addClass("is-error"); summary.setText(errorText(cause)); }
          validateAll();
        };
        total.oninput = () => { draft.total = total.value; draft.dirty = true; update(); };
        update();
        if (focusCategory) fields.get(focusCategory)?.focus({ preventScroll: true });
      };
      form.onsubmit = event => {
        event.preventDefault(); if (saving) return;
        let changes: FinanceBudgetChanges; try { changes = editor.changes(scope === "default"); } catch (cause) { error.setText(errorText(cause)); return; }
        saving = true; modal.refreshAccess(); for (const control of Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button"))) control.disabled = true;
        void this.service.finance.saveBudgetChanges(changes).then(() => { modal.close(); this.redraw(); new Notice("预算已保存"); }).catch(cause => {
          saving = false; for (const control of Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button"))) control.disabled = false;
          validateAll(); error.setText(errorText(cause));
        });
      };
      draw();
    }).open();
  }
}
