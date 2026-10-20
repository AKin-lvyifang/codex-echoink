import type { FinanceEntry, FinanceBillPlan, LifestyleData } from "../../lifestyle/store-core";
import { financeSummary, financeSpendingFacts, effectiveFinanceEntries, filterFinanceEntries, money, localDate, type FinanceFilters } from "../../lifestyle/finance-domain";
import { financeCategoryDonut } from "../../lifestyle/finance-category-donut";
import { financeCategoryVisual } from "../../lifestyle/finance-catalog";
import { effectiveFinanceBudget } from "../../lifestyle/finance-budget";
import { financeGoalProgress } from "../../lifestyle/finance-goals";
import { financeBillPlanStats, sortFinanceBillPlanEntries, emptyFinanceBillPlanFilters, filterFinanceBillPlanEntries, type FinanceBillPlanSort } from "../../lifestyle/finance-bill-plan";
import { financePage } from "../../lifestyle/finance-pagination";
import { createOriginCheck, createOriginPagination } from "../mobile/origin-controls";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneButton, iphoneElement as el } from "./workbench-elements";
import { IPhoneModulePage, moduleMonth, moduleSegments, moduleStat, moduleText, moduleIconButton } from "./module-elements";
import { FINANCE_KIND_LABELS, openFinanceEntry, openFinanceImport, openFinanceBudget, openFinanceBillPlan, openFinanceGoal, openFinanceDailyLimit, renderFinanceReport } from "./finance-forms";
import { formatMobileDateGroup, formatMobileDateTime } from "../../mobile/date-display";

const emptyFilters = (): FinanceFilters => ({ search: "", merchant: "", category: "", kind: "all", account: "", excludedCategories: [], excludedIds: [], date: undefined, minCents: undefined, maxCents: undefined, validExpenseOnly: undefined, exactAccount: undefined, exactCategory: undefined, exactMerchant: undefined });
export async function openIPhoneFinance(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-module-finance"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const port = ctx.host.services.modules.finance, service = port.service, view = new IPhoneModulePage(ctx, id, "财务", "finance", "看看这个月的收支和预算");
  let data: Readonly<LifestyleData> | undefined, month = moduleMonth(new Date()), tab = "overview", page = 1, generation = 0;
  const filters = emptyFilters(); view.content.classList.add("ip-finance-page");
  const render = () => {
    if (!view.alive || !data) return; view.body.replaceChildren(); const policy = service.accessState();
    if (!policy.canEnter) { view.error.show(policy.reason); view.button(view.body, "账号与会员", () => ctx.host.openLegacy("account")); return; }
    if (policy.reason) view.error.show(policy.reason);
    const entries = service.entries(), summary = financeSummary(entries, month), budget = effectiveFinanceBudget(data, month), pending = entries.filter(entry => entry.date.startsWith(month) && entry.classificationPending).length;
    const allocation = budget && Object.entries(budget.allocations).find(([, amount]) => amount > 0), budgetAmount = allocation ? allocation[1] : budget?.totalCents, spent = allocation ? summary.categoryExpenseCents[allocation[0]] ?? 0 : summary.netExpenseCents;
    const selectedDate = new Date(`${month}-01T12:00:00`), monthNumber = selectedDate.getMonth() + 1;
    const stats = el(ctx.document, "div", "ip-module-stats ip-finance-summary"); moduleStat(view, stats, moduleText(ctx, `${monthNumber} 月支出`, `${selectedDate.toLocaleDateString("en", { month: "short" })} spending`), `¥${money(summary.netExpenseCents)}`); moduleStat(view, stats, allocation ? moduleText(ctx, `${allocation[0]}预算`, `${allocation[0]} budget`) : moduleText(ctx, budgetAmount ? "总预算" : "未设预算", budgetAmount ? "Total budget" : "No budget set"), budgetAmount ? `${Math.round(spent / budgetAmount * 100)}%` : "—"); moduleStat(view, stats, moduleText(ctx, "笔待分类", "To categorize"), String(pending)); view.body.append(stats);
    const navigation = el(ctx.document, "div", "ip-finance-navigation"), monthControl = el(ctx.document, "div", "ip-finance-month");
    moduleSegments(view, navigation, "财务页面", [["overview", "总览"], ["ledger", "明细"], ["budget", "预算"]], tab, value => { tab = value; page = 1; render(); });
    monthControl.append(el(ctx.document, "span", "ip-finance-month-label", moduleText(ctx, `${selectedDate.getFullYear()} 年 ${monthNumber} 月`, selectedDate.toLocaleDateString("en", { year: "numeric", month: "long" }))));
    const moveMonth = (offset: number) => { selectedDate.setMonth(selectedDate.getMonth() + offset); month = moduleMonth(selectedDate); page = 1; render(); };
    moduleIconButton(view, monthControl, "上个月", "chevron-left", () => moveMonth(-1)); moduleIconButton(view, monthControl, "下个月", "chevron-right", () => moveMonth(1)); navigation.append(monthControl); view.body.append(navigation);
    if (tab === "overview") {
      const recent = el(ctx.document, "div", "ip-finance-recent"); view.body.append(recent); renderEntries(view, recent, filterFinanceEntries(entries, month, emptyFilters()).slice(0, 8), refresh);
    } else if (tab === "ledger") {
      const toolbar = el(ctx.document, "div", "ip-module-inline-actions ip-finance-ledger-actions"); view.body.append(toolbar);
      view.button(toolbar, moduleText(ctx, "消费统计", "Spending statistics"), () => openFinanceStatistics(ctx, month, refresh, async next => { Object.assign(filters, emptyFilters(), next); tab = "ledger"; page = 1; await ctx.shell.back(); render(); }));
      view.button(toolbar, "导入账单", () => openFinanceImport(ctx, refresh)).disabled = !policy.canWrite; view.button(toolbar, "记一笔", () => openFinanceEntry(ctx, refresh), true).disabled = !policy.canWrite;
      const controls = el(ctx.document, "div", "ip-module-filters"); view.body.append(controls); view.field(controls, "搜索账目", filters.search, value => { filters.search = value; page = 1; drawLedger(); }, "search");
      view.select(controls, "交易类型", [["all", moduleText(ctx, "全部类型")], ["spending", moduleText(ctx, "消费与退款")], ...Object.entries(FINANCE_KIND_LABELS).map(([key, label]) => [key, moduleText(ctx, label)] as const)], filters.kind, value => { filters.kind = value as FinanceFilters["kind"]; page = 1; drawLedger(); });
      for (const [key, label] of [["category", "分类"], ["account", "账户"], ["merchant", "商户"]] as const) view.select(controls, label, [["", moduleText(ctx, "全部")], ...[...new Set(entries.filter(entry => entry.date.startsWith(month)).map(entry => entry[key]).filter(Boolean))].map(name => [name, name] as const)], filters[key], value => { filters[key] = value; page = 1; drawLedger(); });
      view.field(controls, "日期", filters.date ?? "", value => { filters.date = value || undefined; page = 1; drawLedger(); }, "date");
      const list = el(ctx.document, "div", "ip-finance-ledger"), navigation = el(ctx.document, "div", "ip-finance-pagination"); view.body.append(list, navigation);
      view.button(controls, "清除筛选", () => { Object.assign(filters, emptyFilters(), { date: undefined }); page = 1; render(); });
      view.button(controls, "CSV 导出", async () => { await view.run(async () => { const content = service.exportCsv(filterFinanceEntries(service.entries(), month, filters)); const path = await port.saveCsv(`finance-${month}.csv`, content); const output = el(ctx.document, "div", "ip-module-status", path); view.body.append(output); view.button(output, "打开导出文件", () => ctx.host.openNote(path)); }); });
      view.button(controls, "打开账本", () => service.openBase());
      function drawLedger() { list.replaceChildren(); navigation.replaceChildren(); const result = financePage(filterFinanceEntries(service.entries(), month, filters), page); page = result.page; list.append(el(ctx.document, "div", "ip-module-status", moduleText(ctx, `符合条件 ${result.total} 笔`, `${result.total} matching entries`))); renderEntries(view, list, result.items, refresh); if (result.pages > 1) createOriginPagination(navigation, result.page, result.pages, next => { page = next; drawLedger(); }); } drawLedger();
    } else if (tab === "budget") {
      const plans = view.group(); view.button(plans, "账单计划", () => openFinanceBills(ctx, refresh));
      const group = view.group("月度预算"); if (budget) {
        const total = el(ctx.document, "div", "ip-module-fact"); total.append(el(ctx.document, "span", "", moduleText(ctx, "总预算")), el(ctx.document, "strong", "", `¥${money(budget.totalCents)}`)); group.append(total);
        for (const [category, amount] of Object.entries(budget.allocations)) { const row = el(ctx.document, "div", "ip-module-fact"); row.append(el(ctx.document, "span", "", category), el(ctx.document, "span", "", `¥${money(summary.categoryExpenseCents[category] ?? 0)} / ¥${money(amount)}`)); group.append(row); }
      } else view.empty(group, "尚未设置预算"); view.button(group, "调整月度预算", () => openFinanceBudget(ctx, data!, month, refresh)).disabled = !policy.canWrite;
      const plan = service.monthlyPlan(month); const daily = view.group("每日额度"); daily.append(el(ctx.document, "div", "ip-module-copy", plan.dailyLimitCents === null ? "—" : `¥${money(plan.dailyLimitCents)}`)); view.button(daily, "设置每日额度", () => openFinanceDailyLimit(ctx, month, plan.dailyLimitCents, refresh)).disabled = !policy.canWrite;
      const goals = view.group("持续目标"); for (const goal of service.goals()) { const progress = financeGoalProgress(goal, entries), unit = goal.metric === "savings-rate" || goal.metric === "category-share" ? "%" : moduleText(ctx, "元"), actual = progress.actual === null ? "—" : (progress.actual / 100).toFixed(2), button = iphoneButton(ctx.document, `${goal.name} · ${actual} / ${(goal.target / 100).toFixed(2)} ${unit}`, () => { void openFinanceGoal(ctx, refresh, goal).catch(error => ctx.error(error)); }); button.classList.add("ip-module-navigation-row"); goals.append(button); } if (!service.goals().length) view.empty(goals, "还没有目标"); view.button(goals, "新增目标", () => openFinanceGoal(ctx, refresh)).disabled = !policy.canWrite;
      const oldGoals = data.financePlans.flatMap(item => item.goals.map(goal => ({ month: item.month, goal }))); if (oldGoals.length) { const old = el(ctx.document, "details", "ip-finance-old-goals"); old.append(el(ctx.document, "summary", "", moduleText(ctx, `旧目标待重新设置 · ${oldGoals.length} 项`, `Reset previous goals · ${oldGoals.length}`))); for (const legacy of oldGoals) { const row = iphoneButton(ctx.document, `${legacy.month} · ${legacy.goal.name} · ${legacy.goal.target} ${legacy.goal.unit}`, () => { void openFinanceGoal(ctx, refresh, undefined, legacy).catch(ctx.error); }); row.classList.add("ip-module-navigation-row"); old.append(row); } goals.append(old); }
    }
  };
  const refresh = async () => { const current = ++generation; try { const next = await port.readData(); if (!view.alive || current !== generation) return; data = next; view.error.show(); render(); } catch (error) { if (view.alive && current === generation) view.error.show(error); } };
  view.cleanup(service.subscribeEntries(() => { if (!view.busy) void refresh(); })); view.cleanup(service.subscribe(() => { if (!view.busy) void refresh(); })); if (ctx.host.accountService) view.cleanup(ctx.host.accountService.subscribe(() => render())); view.empty(view.body, "正在加载…"); await view.push(); if (view.alive) await refresh();
}


async function openFinanceBills(ctx: IPhonePageContext, saved: () => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, "iphone-finance-bills", "账单计划"), service = ctx.host.services.modules.finance.service;
  const render = () => {
    if (!view.alive) return; view.body.replaceChildren(); const policy = service.accessState(); if (!policy.canEnter) { view.error.show(policy.reason); return; } const entries = service.entries(), refresh = async () => { await saved(); render(); };
      const plans = service.billPlans(); for (const plan of plans) { const facts = financeBillPlanStats(plan, entries), card = view.group(); const button = iphoneButton(ctx.document, plan.name, () => { void openBillDetails(ctx, plan, refresh).catch(error => ctx.error(error)); }); button.classList.add("ip-module-navigation-row"); card.append(button, el(ctx.document, "div", "ip-module-copy", `¥${money(facts.netCents)} / ¥${money(plan.budgetCents)}`)); }
      if (!plans.length) view.empty(view.body, "还没有账单计划"); view.button(view.body, "新建账单", () => openFinanceBillPlan(ctx, refresh)).disabled = !policy.canWrite;
  };
  view.cleanup(service.subscribe(render)); view.cleanup(service.subscribeEntries(render)); if (ctx.host.accountService) view.cleanup(ctx.host.accountService.subscribe(render)); render(); await view.push();
}
async function openFinanceStatistics(ctx: IPhonePageContext, month: string, saved: () => Promise<void>, open: (filters: Partial<FinanceFilters>) => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-statistics-${month}`, moduleText(ctx, "消费统计", "Spending statistics")), service = ctx.host.services.modules.finance.service;
  const render = () => {
    if (!view.alive) return; view.body.replaceChildren(); const policy = service.accessState(); if (!policy.canEnter) { view.error.show(policy.reason); return; }
    const entries = service.entries(), summary = financeSummary(entries, month), totals = view.group("本月收支");
    for (const [label, value] of [["收入", summary.incomeCents], ["退款", summary.refundCents], ["收支结余", summary.balanceCents]] as const) { const row = el(ctx.document, "div", "ip-module-fact"); row.append(el(ctx.document, "span", "", moduleText(ctx, label)), el(ctx.document, "span", "", `¥${money(value)}`)); totals.append(row); }
    const rate = el(ctx.document, "div", "ip-module-fact"); rate.append(el(ctx.document, "span", "", moduleText(ctx, "本月结余率")), el(ctx.document, "span", "", summary.savingsRate === null ? "—" : `${(summary.savingsRate * 100).toFixed(1)}%`)); totals.append(rate);
    renderFinanceBreakdown(view, view.body, entries, month, next => { void open(next).catch(ctx.error); });
    renderSpendingCalendar(view, view.body, entries, month, service.monthlyPlan(month).dailyLimitCents, date => { void open({ date, kind: "expense", validExpenseOnly: true }).catch(ctx.error); });
    const actions = el(ctx.document, "div", "ip-module-inline-actions"); view.button(actions, "查看分析", () => openFinanceAnalysis(ctx, month, saved)); view.button(actions, "分析记录", async () => { const data = await ctx.host.services.modules.finance.readData(); if (view.alive) await openAnalysisHistory(ctx, data); }); view.body.append(actions);
  };
  view.cleanup(service.subscribe(render)); view.cleanup(service.subscribeEntries(render)); if (ctx.host.accountService) view.cleanup(ctx.host.accountService.subscribe(render)); render(); await view.push();
}

function renderEntries(view: IPhoneModulePage, parent: HTMLElement, entries: readonly FinanceEntry[], saved: () => Promise<void>): void {
  for (const entry of entries) { const row = el(view.ctx.document, "button", "ip-finance-entry-row"); row.type = "button"; row.dataset.entryId = entry.id; const text = el(view.ctx.document, "span", "ip-grow"); text.append(el(view.ctx.document, "span", "ip-module-row-title", entry.merchant), el(view.ctx.document, "span", "ip-sub", entry.classificationPending ? moduleText(view.ctx, "待分类") : entry.category)); const right = el(view.ctx.document, "span", "ip-finance-entry-amount"); right.append(el(view.ctx.document, "span", "", `${entry.kind === "expense" ? "−" : entry.kind === "income" || entry.kind === "refund" ? "+" : ""}${money(entry.amountCents)}`), el(view.ctx.document, "time", "ip-sub", formatMobileDateGroup(entry.date, Date.now(), view.ctx.host.settings().settingsLanguage))); row.append(text, right); row.addEventListener("click", () => { void openFinanceEntry(view.ctx, saved, entry).catch(error => view.ctx.error(error)); }); parent.append(row); }
  if (!entries.length) view.empty(parent, "还没有账目");
}

/** Reuse the formal finance calculations and category ring, with iPhone-owned layout. */
function renderFinanceBreakdown(view: IPhoneModulePage, parent: HTMLElement, entries: readonly FinanceEntry[], month: string, open: (filters: Partial<FinanceFilters>) => void): void {
  const { ctx } = view, section = el(ctx.document, "section", "ip-finance-breakdown"), chart = el(ctx.document, "div", "ip-finance-category-chart"), details = el(ctx.document, "div", "ip-finance-statistics"); let mode = "expense", selected: string | null = null;
  view.heading(section, "收支分布"); moduleSegments(view, section, "收支分布类型", [["expense", "支出"], ["income", "收入"]], mode, value => { mode = value; selected = null; draw(); }); section.append(chart, details); parent.append(section);
  const drawDetails = () => {
    details.replaceChildren(); const current = effectiveFinanceEntries(entries, month).filter(entry => entry.kind === mode && (selected === null || entry.category === selected));
    const accounts = new Map<string, number>(); for (const entry of current) accounts.set(entry.account, (accounts.get(entry.account) ?? 0) + entry.amountCents);
    view.heading(details, "账户分布"); for (const [account, amount] of [...accounts].sort(([, a], [, b]) => b - a)) { const row = el(ctx.document, "div", "ip-module-fact"); const button = view.button(row, account || moduleText(ctx, "未指定"), () => open({ kind: mode as "expense" | "income", validExpenseOnly: mode === "expense", exactAccount: account, ...(selected === null ? {} : { exactCategory: selected }) })); button.classList.add("is-text"); row.append(el(ctx.document, "span", "", `¥${money(amount)}`)); details.append(row); }
    if (!accounts.size) view.empty(details, "还没有账目");
    if (mode === "expense") { const facts = financeSpendingFacts(current, month); view.heading(details, "单笔金额分布"); for (const bin of facts.bins) { const row = el(ctx.document, "div", "ip-module-fact"), label = bin.label.replace("元", moduleText(ctx, "元")); view.button(row, label, () => open({ kind: "expense", validExpenseOnly: true, minCents: bin.minCents, maxCents: bin.maxCents, ...(selected === null ? {} : { exactCategory: selected }) })); row.append(el(ctx.document, "span", "", moduleText(ctx, `${bin.count} 笔 · ¥${money(bin.amountCents)}`, `${bin.count} entries · ¥${money(bin.amountCents)}`))); details.append(row); } }
    if (selected !== null) view.button(details, "全部明细", () => open({ kind: mode as "expense" | "income", ...(selected === null ? {} : { exactCategory: selected }) }));
  };
  const draw = () => { chart.replaceChildren(); const totals = new Map<string, number>(); for (const entry of effectiveFinanceEntries(entries, month)) if (entry.kind === mode && entry.amountCents > 0) totals.set(entry.category, (totals.get(entry.category) ?? 0) + entry.amountCents);
    if (!totals.size) view.empty(chart, "还没有账目"); else financeCategoryDonut(chart, [...totals].sort(([, a], [, b]) => b - a).map(([category, amountCents]) => ({ category, amountCents, color: financeCategoryVisual(category, ctx.host.settings().lifestyle.finance).color })), { label: moduleText(ctx, mode === "expense" ? "支出原额" : "收入"), selected: () => selected, onSelect: value => { selected = value; drawDetails(); } }); drawDetails();
  }; draw();
}

function renderSpendingCalendar(view: IPhoneModulePage, parent: HTMLElement, entries: readonly FinanceEntry[], month: string, limit: number | null, select: (date: string) => void): void {
  const { ctx } = view, facts = financeSpendingFacts(entries, month), section = el(ctx.document, "section", "ip-finance-calendar-section"), grid = el(ctx.document, "div", "ip-finance-calendar"); view.heading(section, "每日消费");
  const language = ctx.host.settings().settingsLanguage; for (let index = 0; index < 7; index++) grid.append(el(ctx.document, "span", "ip-finance-weekday", new Intl.DateTimeFormat(language, { weekday: "narrow" }).format(new Date(2024, 0, index + 1))));
  const [year, number] = month.split("-").map(Number), first = new Date(year, number - 1, 1), end = new Date(year, number, 0).getDate();
  for (let index = 0; index < (first.getDay() + 6) % 7; index++) grid.append(el(ctx.document, "span", ""));
  for (let day = 1; day <= end; day++) { const date = `${month}-${String(day).padStart(2, "0")}`, spent = facts.days.get(date)?.amountCents ?? 0, future = date > localDate(), state = !future && spent > 0 && limit !== null ? spent <= limit ? "is-within" : "is-over" : "is-idle";
    const button = el(ctx.document, "button", `ip-finance-day ${state}`, String(day)); button.type = "button"; button.dataset.date = date; button.disabled = !spent || future;
    button.setAttribute("aria-label", `${date} · ${moduleText(ctx, "支出")} ¥${money(spent)}${limit === null ? "" : ` · ${moduleText(ctx, "每日额度")} ¥${money(limit)}`}`); button.title = button.getAttribute("aria-label")!;
    if (state !== "is-idle") button.append(el(ctx.document, "span", "", state === "is-within" ? "✓" : "!")); button.addEventListener("click", () => select(date)); grid.append(button);
  } section.append(grid); parent.append(section);
}

async function openBillDetails(ctx: IPhonePageContext, plan: FinanceBillPlan, saved: () => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-bill-${plan.id}`, plan.name), service = ctx.host.services.modules.finance.service, filters = emptyFinanceBillPlanFilters(); let sort: FinanceBillPlanSort = "date-desc", page = 1;
  const render = () => {
    if (!view.alive) return; view.body.replaceChildren(); const facts = service.billPlanStats(plan.id); const stats = el(ctx.document, "div", "ip-module-stats"); moduleStat(view, stats, "已用预算", `¥${money(facts.netCents)}`); moduleStat(view, stats, "总预算", `¥${money(plan.budgetCents)}`); moduleStat(view, stats, "关联账目", String(facts.entries.length)); view.body.append(stats);
    const factsGroup = view.group(); for (const [label, value] of [["剩余预算", `¥${money(facts.remainingCents)}`], ["支出原额", `¥${money(facts.grossCents)}`], ["退款", `¥${money(facts.refundsCents)}`], ["最大一笔", facts.largest ? `¥${money(facts.largest.amountCents)} · ${facts.largest.merchant}` : "—"], ["最小一笔", facts.smallest ? `¥${money(facts.smallest.amountCents)} · ${facts.smallest.merchant}` : "—"], ["平均每笔支出", facts.averageCents === null ? "—" : `¥${money(facts.averageCents)}`]]) { const row = el(ctx.document, "div", "ip-module-fact"); row.append(el(ctx.document, "span", "", moduleText(ctx, label)), el(ctx.document, "span", "", value)); factsGroup.append(row); }
    const allocationHost = view.group("分类预算"), allocations = el(ctx.document, "div", "ip-finance-allocation-values"); let allocationMode = "amount"; moduleSegments(view, allocationHost, "分类预算读数", [["amount", "金额"], ["percent", "百分比"]], allocationMode, value => { allocationMode = value; drawAllocations(); }); allocationHost.append(allocations);
    const drawAllocations = () => { allocations.replaceChildren(); for (const category of facts.categoryBudgets) { const row = el(ctx.document, "div", "ip-module-fact"); row.append(el(ctx.document, "span", "", category.category || moduleText(ctx, "未分类")), el(ctx.document, "span", "", category.allocationCents === null ? `¥${money(category.netCents)} · ${moduleText(ctx, "未设额度")}` : allocationMode === "amount" ? `¥${money(category.netCents)} / ¥${money(category.allocationCents)}` : category.percentage === null ? "—" : `${category.percentage.toFixed(1)}%`)); if (category.overCents) row.append(el(ctx.document, "span", "ip-module-error", moduleText(ctx, `超出 ¥${money(category.overCents)}`, `Over ¥${money(category.overCents)}`))); allocations.append(row); } }; drawAllocations();
    const toolbar = el(ctx.document, "div", "ip-module-toolbar"); view.button(toolbar, "修改预算", () => openFinanceBillPlan(ctx, async () => { await saved(); const latest = service.billPlans().find(value => value.id === plan.id); if (latest) plan = latest; render(); }, plan)); view.button(toolbar, "记一笔", () => openFinanceEntry(ctx, async () => { await saved(); render(); }, undefined, plan.id)); view.button(toolbar, "关联已有账目", () => associateEntries(ctx, plan, async () => { await saved(); render(); })); view.body.append(toolbar);
    const controls = el(ctx.document, "div", "ip-module-filters"); view.body.append(controls); view.field(controls, "搜索账目", filters.search, value => { filters.search = value; page = 1; draw(); }, "search"); view.select(controls, "排序", [["date-desc", moduleText(ctx, "日期从新到旧")], ["amount-desc", moduleText(ctx, "金额从大到小")], ["amount-asc", moduleText(ctx, "金额从小到大")]], sort, value => { sort = value as FinanceBillPlanSort; page = 1; draw(); });
    for (const [key, label] of [["from", "起始日期"], ["to", "结束日期"]] as const) view.field(controls, label, filters[key], value => { filters[key] = value; page = 1; draw(); }, "date");
    view.select(controls, "交易类型", [["all", moduleText(ctx, "全部类型")], ["spending", moduleText(ctx, "消费与退款")], ...Object.entries(FINANCE_KIND_LABELS).map(([key, label]) => [key, moduleText(ctx, label)] as const)], filters.kind, value => { filters.kind = value as typeof filters.kind; page = 1; draw(); });
    for (const [key, label] of [["category", "分类"], ["account", "账户"], ["merchant", "商户"]] as const) view.select(controls, label, [["", moduleText(ctx, "全部")], ...[...new Set(facts.entries.map(entry => entry[key]).filter(Boolean))].map(name => [name, name] as const)], filters[key], value => { filters[key] = value; page = 1; draw(); });
    view.button(controls, "CSV 导出", async () => { await view.run(async () => { const selected = filterFinanceBillPlanEntries(service.entries().filter(entry => entry.billPlanId === plan.id), filters); await ctx.host.services.modules.finance.saveCsv(`bill-${plan.id}.csv`, service.exportCsv(selected)); }); });
    renderFinanceBreakdown(view, view.body, facts.entries, "", next => { Object.assign(filters, emptyFilters(), { from: "", to: "" }, next); page = 1; render(); });
    const list = el(ctx.document, "div", "ip-finance-ledger"), footer = el(ctx.document, "div", ""); view.body.append(list, footer); function draw() { list.replaceChildren(); footer.replaceChildren(); const result = financePage(sortFinanceBillPlanEntries(filterFinanceBillPlanEntries(service.entries().filter(entry => entry.billPlanId === plan.id), filters), sort), page); page = result.page; renderEntries(view, list, result.items, async () => { await saved(); render(); }); if (result.pages > 1) createOriginPagination(footer, result.page, result.pages, next => { page = next; draw(); }); } draw();
  }; render(); await view.push();
}
async function associateEntries(ctx: IPhonePageContext, plan: FinanceBillPlan, saved: () => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-associate-${plan.id}`, "关联已有账目"), service = ctx.host.services.modules.finance.service, selected = new Set<string>(); let query = "", page = 1; view.dirty = () => selected.size > 0;
  view.field(view.body, "搜索账目", "", value => { query = value; page = 1; render(); }, "search"); const list = el(ctx.document, "div", "ip-module-rows"), pagination = el(ctx.document, "div", ""); view.body.append(list, pagination);
  const render = () => { list.replaceChildren(); pagination.replaceChildren(); const result = financePage(service.entries().filter(entry => entry.billPlanId !== plan.id && `${entry.merchant} ${entry.description} ${entry.date}`.includes(query)), page); page = result.page; for (const entry of result.items) { const row = el(ctx.document, "label", "ip-module-choice"), check = createOriginCheck(row, { attr: { "aria-label": entry.merchant } }); check.checked = selected.has(entry.id); check.addEventListener("change", () => { if (check.checked) selected.add(entry.id); else selected.delete(entry.id); view.changed(); }); row.append(el(ctx.document, "span", "", `${entry.date} · ${entry.merchant} · ¥${money(entry.amountCents)}`)); list.append(row); } if (!result.items.length) view.empty(list, "没有符合条件的账目"); if (result.pages > 1) createOriginPagination(pagination, result.page, result.pages, next => { page = next; render(); }); };
  view.button(view.footer, "取消", async () => { view.allow(); await ctx.shell.back(); }); view.button(view.footer, "确认关联", async () => { const success = await view.run(async () => { const result = await service.associateBillPlan([...selected], plan.id); for (const id of result.applied) selected.delete(id); await saved(); if (result.failed.length) throw new Error(result.failed.map(item => item.error).join("\n")); }); if (success) { view.allow(); await ctx.shell.back(); } else render(); }, true); render(); await view.push();
}

async function openFinanceAnalysis(ctx: IPhonePageContext, month: string, saved: () => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-analysis-${month}`, "财务分析"), service = ctx.host.services.modules.finance.service, result = el(ctx.document, "div", "ip-finance-analysis"); view.body.append(result);
  const render = () => { if (!view.alive) return; result.replaceChildren(); const report = service.latestReport(month); if (report) renderFinanceReport(view, result, report); else view.empty(result, "尚未生成分析"); retry.hidden = !service.pendingAnalysisSave(month); };
  const run = async (force: boolean) => { stop.hidden = false; await view.run(async () => { await service.analyze(month, force); await saved(); }); if (view.alive) { stop.hidden = true; render(); } };
  const stop = view.button(view.footer, "停止", () => { service.cancel(month); }); stop.dataset.moduleStop = "true"; stop.hidden = true;
  const retry = view.button(view.footer, "重试保存", async () => { await view.run(async () => { await service.retryAnalysisSave(month); await saved(); }); render(); });
  view.button(view.footer, "重新分析", () => run(true)); view.button(view.footer, "生成分析", () => run(false), true);
  const hide = () => { if (ctx.document.hidden) service.cancel(month); }; ctx.document.addEventListener("visibilitychange", hide); view.cleanup(() => { service.cancel(month); ctx.document.removeEventListener("visibilitychange", hide); }); render(); await view.push();
}
async function openAnalysisHistory(ctx: IPhonePageContext, data: Readonly<LifestyleData>): Promise<void> {
  const view = new IPhoneModulePage(ctx, "iphone-finance-analysis-history", "分析记录");
  for (const record of [...(data.financeAnalysisArchives ?? [])].sort((a, b) => b.createdAt - a.createdAt)) { const row = iphoneButton(ctx.document, `${record.period} · ${formatMobileDateTime(record.createdAt, Date.now(), ctx.host.settings().settingsLanguage === "en" ? "en" : "zh-CN")} · ${moduleText(ctx, record.status === "success" ? "已完成" : record.status === "parse-failed" ? "解析失败" : "待核对")}`, () => { void ctx.host.openNote(record.path).catch(error => ctx.error(error)); }); row.classList.add("ip-module-navigation-row"); view.body.append(row); }
  if (!view.body.childElementCount) view.empty(view.body, "还没有分析记录"); await view.push();
}
