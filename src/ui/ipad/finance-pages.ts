import type { LifestyleData, FinanceBillPlan, FinanceEntry } from "../../lifestyle/store-core";
import type { FinanceRecordSnapshot } from "../../lifestyle/finance-operation-types";
import { effectiveFinanceBudget } from "../../lifestyle/finance-budget";
import { financeSummary, financeSpendingFacts, effectiveFinanceEntries, filterFinanceEntries, localDate, money, type FinanceFilters } from "../../lifestyle/finance-domain";
import { financeGoalProgress } from "../../lifestyle/finance-goals";
import { formatMobileDate, formatMobileDateTime } from "../../mobile/date-display";
import { financeBillPlanStats, filterFinanceBillPlanEntries, emptyFinanceBillPlanFilters } from "../../lifestyle/finance-bill-plan";
import { financeReportMarkdown } from "../../lifestyle/finance-analysis-archive";
import type { IPadPageContext } from "./workbench-contract";
import type { MobileShellPage } from "../mobile/shell-types";
import { createFinanceImportPage } from "./finance-import-page";
import { createFinanceEntryForm, createFinanceRecordPage, createFinanceBudgetForm, createFinanceDailyLimitForm, createFinanceGoalForm, createFinanceMonthlyGoalForm, createFinanceBillForm, createFinanceSettingsPage } from "./finance-forms";
import { el, moduleActions, moduleButton, moduleConfirm, moduleEmpty, moduleField, moduleSelect, moduleSegments, selectModuleSegment, moduleView, moduleText as t } from "./module-elements";

interface FinanceSnapshot { data: Readonly<LifestyleData>; records: FinanceRecordSnapshot[] }
type FinanceTab = "overview" | "ledger" | "budget" | "billPlans";
const filterDefaults = (): FinanceFilters => ({ search: "", merchant: "", category: "", account: "", kind: "all", excludedCategories: [], excludedIds: [] });

export function createFinancePage(ctx: IPadPageContext): MobileShellPage {
  const port = ctx.host.services.modules.finance, service = port.service, v = moduleView(ctx, "module:finance", t(ctx, "财务", "Finance"), "finance");
  let snapshot: FinanceSnapshot | undefined, month = localDate().slice(0, 7), tab: FinanceTab = "overview", filters = filterDefaults(), page = 1, ownedAnalysis: string | undefined, chartCategory: string | null = null, recentDate: string | null = null, mix = "expense";
  const controls = el(ctx.document, "div", "pd-finance-toolbar"), facts = el(ctx.document, "div", "pd-finance-summary"), tabs = moduleSegments(ctx, [["overview", t(ctx, "总览", "Overview")], ["ledger", t(ctx, "收支明细", "Transactions")], ["budget", t(ctx, "预算", "Budget")], ["billPlans", t(ctx, "账单计划", "Bill plans")]], tab, value => { tab = value as FinanceTab; page = 1; draw(); }), panel = el(ctx.document, "div", "pd-finance-panel");
  const previous = moduleButton(ctx, "", () => moveMonth(-1), false, "chevron-left"), next = moduleButton(ctx, "", () => moveMonth(1), false, "chevron-right"); previous.setAttribute("aria-label", t(ctx, "上个月", "Previous month")); next.setAttribute("aria-label", t(ctx, "下个月", "Next month"));
  controls.append(previous); const selectedMonth = moduleField(ctx, controls, t(ctx, "月份", "Month"), month, value => { if (!/^\d{4}-\d{2}$/u.test(value)) return; month = value; page = 1; recentDate = null; draw(); }, "month"); controls.append(next, moduleButton(ctx, t(ctx, "设置", "Settings"), () => v.push(createFinanceSettingsPage(ctx)), false, "settings")); v.body.append(controls, facts, tabs, panel);
  function moveMonth(delta: number): void { const date = new Date(`${month}-01T12:00:00`); date.setMonth(date.getMonth() + delta); month = localDate(date).slice(0, 7); selectedMonth.value = month; page = 1; recentDate = null; draw(); }
  function canWrite(): boolean { return service.accessState().canWrite; }
  function guarded(button: HTMLButtonElement): HTMLButtonElement { button.disabled = !canWrite(); return button; }
  function draw(): void {
    if (!snapshot || !v.alive) return; facts.replaceChildren(); panel.replaceChildren();
    const entries = snapshot.records.map(record => record.entry), summary = financeSummary(entries, month), budget = effectiveFinanceBudget(snapshot.data, month), pending = entries.filter(entry => entry.date.startsWith(month) && entry.classificationPending).length;
    for (const [value, label] of [[`¥${money(summary.netExpenseCents)}`, t(ctx, "本月支出", "Monthly spending")], [budget ? `${(summary.netExpenseCents / Math.max(1, budget.totalCents) * 100).toFixed(1)}%` : "—", t(ctx, "预算已用", "Budget used")], [String(pending), t(ctx, "待分类", "To categorize")]]) { const fact = el(ctx.document, "div", "pd-finance-stat"); fact.append(el(ctx.document, "strong", "", value), el(ctx.document, "span", "", label)); facts.append(fact); }
    const access = service.accessState(); if (!access.canWrite && access.reason) panel.append(el(ctx.document, "div", "pd-module-secondary", access.reason));
    const issues = service.issues(); if (issues.length) { const details = el(ctx.document, "details", "pd-finance-issues"); details.append(el(ctx.document, "summary", "", t(ctx, `${issues.length} 份账目需要核对`, `${issues.length} records need review`))); for (const issue of issues) details.append(moduleButton(ctx, `${issue.path} · ${issue.reason}`, () => ctx.host.openNote(issue.path))); panel.append(details); }
    if (tab === "overview") overview(entries, summary.balanceCents, budget?.totalCents ?? null);
    else if (tab === "ledger") ledger(entries);
    else if (tab === "budget") budgets();
    else bills();
  }
  function overview(entries: FinanceEntry[], balance: number, totalBudget: number | null): void {
    const actions = moduleActions(ctx, panel); actions.append(guarded(moduleButton(ctx, t(ctx, "记一笔", "Add transaction"), () => v.push(createFinanceEntryForm(ctx, snapshot!.data)))), guarded(moduleButton(ctx, t(ctx, "导入账单", "Import bills"), () => v.push(createFinanceImportPage(ctx)))), moduleButton(ctx, t(ctx, "打开账本", "Open ledger"), () => service.openBase()), moduleButton(ctx, t(ctx, "导出本月", "Export month"), () => exportEntries(entries.filter(entry => entry.date.startsWith(month)))));
    const info = el(ctx.document, "div", "pd-finance-overview-facts"); info.append(el(ctx.document, "div", "", `${t(ctx, "本月结余", "Monthly balance")} ¥${money(balance)}`), el(ctx.document, "div", "", totalBudget === null ? t(ctx, "还没有设置预算", "No budget set") : `${t(ctx, "总预算", "Budget")} ¥${money(totalBudget)}`)); panel.append(info);
    const composition = el(ctx.document, "section", "pd-finance-composition"); composition.append(moduleSegments(ctx, [["expense", t(ctx, "支出", "Expense")], ["income", t(ctx, "收入", "Income")]], mix, value => { mix = value; draw(); })); panel.append(composition);
    const valid = effectiveFinanceEntries(entries, month), segments = mix === "expense" ? financeSpendingFacts(entries, month).categories.map(([name, value]) => [name || t(ctx, "未分类", "Uncategorized"), value.amountCents] as const) : valid.filter(entry => entry.kind === "income").map(entry => [entry.merchant || entry.description, entry.amountCents] as const), total = segments.reduce((sum, [, amount]) => sum + amount, 0);
    for (const [name, amount] of segments) { const row = el(ctx.document, "div", "pd-finance-bar-row"), bar = el(ctx.document, "meter", "pd-finance-meter"); bar.min = 0; bar.max = Math.max(1, total); bar.value = amount; bar.setAttribute("aria-label", `${name} · ¥${money(amount)}`); row.append(el(ctx.document, "span", "", name), bar, el(ctx.document, "span", "is-number", `¥${money(amount)} · ${total ? (amount / total * 100).toFixed(1) : "0"}%`)); composition.append(row); }
    if (!segments.length) moduleEmpty(ctx, composition, t(ctx, "本月没有相关收支", "No matching income or spending this month"));
    const spending = financeSpendingFacts(entries, month), charts = el(ctx.document, "section", "pd-finance-charts"); charts.append(el(ctx.document, "h2", "", t(ctx, "消费统计", "Spending statistics"))); panel.append(charts);
    for (const [name, value] of spending.categories) charts.append(moduleButton(ctx, `${name || t(ctx, "未分类", "Uncategorized")} · ¥${money(value.amountCents)}`, () => { chartCategory = chartCategory === name ? null : name; draw(); }));
    const current = chartCategory === null ? spending : financeSpendingFacts(entries.filter(entry => entry.category === chartCategory), month);
    if (chartCategory !== null) charts.append(moduleButton(ctx, t(ctx, "清除分类筛选", "Clear category filter"), () => { chartCategory = null; draw(); }), moduleButton(ctx, t(ctx, "查看分类明细", "View category transactions"), () => drilldown({ exactCategory: chartCategory!, validExpenseOnly: true })));
    const distributions = el(ctx.document, "div", "pd-finance-distributions"); charts.append(distributions);
    for (const [title, choices] of [[t(ctx, "账户分布", "By account"), current.accounts.map(([name, value]) => ({ label: `${name || t(ctx, "未指定账户", "No account")} · ¥${money(value.amountCents)}`, filter: { exactAccount: name } }))], [t(ctx, "金额分布", "By amount"), current.bins.filter(bin => bin.count).map(bin => ({ label: `${bin.label} · ${bin.count}`, filter: { minCents: bin.minCents, maxCents: bin.maxCents } }))]] as const) { const group = el(ctx.document, "div", ""); group.append(el(ctx.document, "h3", "", title)); for (const choice of choices) group.append(moduleButton(ctx, choice.label, () => drilldown({ ...choice.filter, validExpenseOnly: true, ...(chartCategory === null ? {} : { exactCategory: chartCategory }) }))); distributions.append(group); }
    const calendar = el(ctx.document, "section", "pd-finance-daily"); calendar.append(el(ctx.document, "h2", "", t(ctx, "每日消费额度", "Daily spending limit"))); panel.append(calendar); const limit = service.monthlyPlan(month).dailyLimitCents;
    calendar.append(el(ctx.document, "p", "", limit === null ? t(ctx, "尚未设置", "Not set") : `¥${money(limit)}`), guarded(moduleButton(ctx, t(ctx, "调整额度", "Edit limit"), () => v.push(createFinanceDailyLimitForm(ctx, month)))));
    const grid = el(ctx.document, "div", "pd-finance-calendar"), [year, number] = month.split("-").map(Number); calendar.append(grid); for (const name of t(ctx, "一二三四五六日", "MTWTFSS")) grid.append(el(ctx.document, "span", "", name)); for (let pad = 0; pad < (new Date(year, number - 1, 1).getDay() + 6) % 7; pad++) grid.append(el(ctx.document, "span", ""));
    for (let day = 1; day <= new Date(year, number, 0).getDate(); day++) { const date = `${month}-${String(day).padStart(2, "0")}`, spent = spending.days.get(date)?.amountCents ?? 0, state = spent && limit !== null ? spent > limit ? "is-over" : "is-within" : "is-idle", cell = el(ctx.document, "button", `pd-finance-day ${state}`, String(day)); cell.type = "button"; cell.dataset.date = date; cell.disabled = !spent || date > localDate(); cell.setAttribute("aria-label", `${formatMobileDate(date)} · ¥${money(spent)}${spent && limit !== null ? spent > limit ? t(ctx, " · 超额", " · Over limit") : t(ctx, " · 额度内", " · Within limit") : ""}`); cell.setAttribute("aria-pressed", String(recentDate === date)); cell.addEventListener("click", () => { recentDate = recentDate === date ? null : date; draw(); }); grid.append(cell); }
    if (recentDate) panel.append(moduleButton(ctx, t(ctx, "清除日期筛选", "Clear date filter"), () => { recentDate = null; draw(); }));
    const recent = entries.filter(entry => entry.date.startsWith(recentDate ?? month)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8); renderEntries(ctx, panel, recent, entry => openRecord(entry.id)); renderAnalysis();
  }
  function drilldown(patch: Partial<FinanceFilters>): void { filters = { ...filterDefaults(), ...patch }; tab = "ledger"; selectModuleSegment(tabs, tab); page = 1; draw(); }
  function ledger(entries: FinanceEntry[]): void {
    const toolbar = el(ctx.document, "div", "pd-finance-filters"); panel.append(toolbar);
    moduleField(ctx, toolbar, t(ctx, "搜索账目", "Search transactions"), filters.search, value => { filters.search = value; page = 1; drawRows(); });
    moduleSelect(ctx, toolbar, t(ctx, "类型", "Type"), [["all", t(ctx, "全部", "All")], ["spending", t(ctx, "净支出", "Net spending")], ["expense", t(ctx, "支出", "Expense")], ["income", t(ctx, "收入", "Income")], ["refund", t(ctx, "退款", "Refund")], ["transfer", t(ctx, "转账", "Transfer")]], filters.kind, value => { filters.kind = value as FinanceFilters["kind"]; page = 1; drawRows(); });
    for (const [key, label] of [["merchant", t(ctx, "商户", "Merchant")], ["category", t(ctx, "分类", "Category")], ["account", t(ctx, "账户", "Account")]] as const) moduleSelect(ctx, toolbar, label, [["", t(ctx, "全部", "All")], ...[...new Set(entries.map(entry => entry[key]).filter(Boolean))].map(value => [value, value] as const)], filters[key], value => { filters[key] = value; page = 1; drawRows(); });
    const rows = el(ctx.document, "div", "pd-finance-ledger-rows"); panel.append(rows); const actions = moduleActions(ctx, panel);
    if (filters.date || filters.minCents !== undefined || filters.maxCents != null || filters.validExpenseOnly || filters.exactCategory !== undefined || filters.exactAccount !== undefined) actions.append(moduleButton(ctx, t(ctx, "清除筛选", "Clear filters"), () => { filters = filterDefaults(); page = 1; draw(); }));
    actions.append(guarded(moduleButton(ctx, t(ctx, "记一笔", "Add transaction"), () => v.push(createFinanceEntryForm(ctx, snapshot!.data)))), guarded(moduleButton(ctx, t(ctx, "导入账单", "Import bills"), () => v.push(createFinanceImportPage(ctx)))), moduleButton(ctx, t(ctx, "导出筛选结果", "Export filtered results"), () => exportEntries(filterFinanceEntries(entries, month, filters))));
    function drawRows(): void { rows.replaceChildren(); const filtered = filterFinanceEntries(entries, month, filters).sort((a, b) => b.date.localeCompare(a.date)), pages = Math.max(1, Math.ceil(filtered.length / 20)); page = Math.min(page, pages); rows.append(el(ctx.document, "div", "pd-module-secondary", t(ctx, `${filtered.length} 笔`, `${filtered.length} transactions`))); renderEntries(ctx, rows, filtered.slice((page - 1) * 20, page * 20), entry => openRecord(entry.id)); pagination(ctx, rows, page, pages, value => { page = value; drawRows(); }); } drawRows();
  }
  async function openRecord(id: string): Promise<void> { const record = snapshot?.records.find(item => item.entry.id === id); if (record && snapshot) await v.push(createFinanceRecordPage(ctx, snapshot.data, record)); }
  async function exportEntries(entries: FinanceEntry[]): Promise<void> { await v.run(async () => { const csv = service.exportCsv(entries), path = await port.saveCsv(`finance-${month}.csv`, csv); v.status(path); v.feedback.append(moduleButton(ctx, t(ctx, "打开导出文件", "Open exported file"), () => ctx.host.openNote(path))); }); }
  function renderAnalysis(): void {
    const section = el(ctx.document, "section", "pd-finance-analysis"), heading = el(ctx.document, "div", "pd-module-section-head"), activeMonth = service.busyMonth(), report = service.latestReport(month), waitingSave = service.pendingAnalysisSave(month); section.append(heading); panel.append(section); heading.append(el(ctx.document, "h2", "", t(ctx, "AI 分析", "AI analysis")));
    const requestedMonth = month, run = guarded(moduleButton(ctx, waitingSave ? t(ctx, "重试保存", "Retry saving") : activeMonth === month ? t(ctx, "生成中…", "Generating…") : report ? t(ctx, "刷新分析", "Refresh analysis") : t(ctx, "生成分析", "Generate analysis"), async () => {
      if (service.busyMonth()) return; ownedAnalysis = requestedMonth;
      try { if (waitingSave) await service.retryAnalysisSave(requestedMonth); else await service.analyze(requestedMonth, !!report); if (v.alive) reload(); }
      catch (error) { v.report(error); }
      finally { if (ownedAnalysis === requestedMonth) ownedAnalysis = undefined; if (v.alive) reload(); }
    })); run.disabled ||= !!activeMonth; heading.append(run);
    if (activeMonth) heading.append(moduleButton(ctx, t(ctx, "停止分析", "Stop analysis"), () => service.cancel(activeMonth)));
    if (waitingSave) section.append(el(ctx.document, "div", "pd-module-secondary", t(ctx, "分析尚未完成保存，内容已保留。", "Analysis is retained and awaiting save.")));
    if (report) { const body = el(ctx.document, "div", "pd-finance-report markdown-rendered"); ctx.host.renderMarkdown(financeReportMarkdown(report), body); section.append(body); }
    else if (!activeMonth) moduleEmpty(ctx, section, t(ctx, "还没有分析记录", "No analysis yet"));
    const history = snapshot!.data.financeAnalysisArchives?.filter(item => item.period === month) ?? []; if (history.length) {
      const details = el(ctx.document, "details", "pd-finance-history"); details.append(el(ctx.document, "summary", "", t(ctx, "分析历史", "Analysis history"))); for (const item of history) details.append(moduleButton(ctx, `${item.period} · ${formatMobileDateTime(item.createdAt, Date.now(), ctx.host.settings().settingsLanguage)} · ${item.status === "success" ? t(ctx, "已保存", "Saved") : t(ctx, "需核对", "Needs review")}`, () => ctx.host.openNote(item.path))); section.append(details);
    }
  }
  function budgets(): void {
    const data = snapshot!.data, budget = effectiveFinanceBudget(data, month), plan = service.monthlyPlan(month), section = el(ctx.document, "section", "pd-finance-budget"); panel.append(section);
    if (budget) { section.append(el(ctx.document, "h2", "", `${month} · ¥${money(budget.totalCents)}`)); for (const [category, amount] of Object.entries(budget.allocations)) section.append(el(ctx.document, "div", "pd-finance-fact", `${category} · ¥${money(amount)}`)); }
    else moduleEmpty(ctx, section, t(ctx, "还没有设置预算", "No budget set"));
    const actions = moduleActions(ctx, section), resetArea = el(ctx.document, "div", "pd-module-confirm-area"); section.append(resetArea);
    actions.append(guarded(moduleButton(ctx, t(ctx, "每月默认预算", "Default monthly budget"), () => v.push(createFinanceBudgetForm(ctx, data, "default")))), guarded(moduleButton(ctx, t(ctx, "本月独立预算", "Override this month"), () => v.push(createFinanceBudgetForm(ctx, data, month)))));
    if (data.budgets.some(item => item.month === month)) actions.append(guarded(moduleButton(ctx, t(ctx, "恢复每月默认", "Use default budget"), () => moduleConfirm(ctx, resetArea, t(ctx, "移除本月独立预算，恢复默认？", "Remove this month's override and use the default?"), async () => { const saved = await v.run(() => service.saveBudgetChanges({ overrides: [], removedMonths: [month] })); if (saved) reload(); }))));
    section.append(el(ctx.document, "h2", "", t(ctx, "每日消费额度", "Daily spending limit")), el(ctx.document, "div", "", plan.dailyLimitCents === null ? "—" : `¥${money(plan.dailyLimitCents)}`), guarded(moduleButton(ctx, t(ctx, "调整额度", "Edit limit"), () => v.push(createFinanceDailyLimitForm(ctx, month)))));
    section.append(el(ctx.document, "h2", "", t(ctx, "持续目标", "Ongoing goals")));
    for (const goal of data.financeGoals) { const progress = financeGoalProgress(goal, snapshot!.records.map(record => record.entry)), ratio = goal.metric === "savings-rate" || goal.metric === "category-share", format = (value: number) => ratio ? `${(value / 100).toFixed(2)}%` : `¥${money(value)}`, row = el(ctx.document, "div", "pd-finance-goal"), area = el(ctx.document, "div", "pd-module-confirm-area"); row.append(el(ctx.document, "span", "", `${goal.name} · ${progress.status === "no-data" ? t(ctx, "暂无数据", "No data") : format(progress.actual!)} / ${format(goal.target)}`), guarded(moduleButton(ctx, t(ctx, "编辑", "Edit"), () => v.push(createFinanceGoalForm(ctx, goal)))), guarded(moduleButton(ctx, t(ctx, "删除", "Delete"), () => moduleConfirm(ctx, area, t(ctx, "删除这个目标？", "Delete this goal?"), async () => { const saved = await v.run(() => service.deleteContinuousGoal(goal.id)); if (saved) reload(); }, t(ctx, "删除", "Delete"))))); section.append(row, area); }
    section.append(guarded(moduleButton(ctx, t(ctx, "新增持续目标", "Add ongoing goal"), () => v.push(createFinanceGoalForm(ctx)))));
    section.append(el(ctx.document, "h2", "", t(ctx, "月度目标", "Monthly goals")));
    for (const goal of plan.goals) { const row = el(ctx.document, "div", "pd-finance-goal"), area = el(ctx.document, "div", "pd-module-confirm-area"); row.append(el(ctx.document, "span", "", `${goal.name} · ${goal.actual}/${goal.target} ${goal.unit}`), guarded(moduleButton(ctx, t(ctx, "编辑", "Edit"), () => v.push(createFinanceMonthlyGoalForm(ctx, month, goal)))), guarded(moduleButton(ctx, t(ctx, "删除", "Delete"), () => moduleConfirm(ctx, area, t(ctx, "删除这个目标？", "Delete this goal?"), async () => { const saved = await v.run(() => service.deleteGoal(month, goal.id)); if (saved) reload(); }, t(ctx, "删除", "Delete"))))); section.append(row, area); }
    section.append(guarded(moduleButton(ctx, t(ctx, "新增月度目标", "Add monthly goal"), () => v.push(createFinanceMonthlyGoalForm(ctx, month)))));
    const legacy = data.financePlans.flatMap(plan => plan.goals.map(goal => ({ month: plan.month, goal })));
    if (legacy.length) { const details = el(ctx.document, "details", "pd-finance-legacy-goals"); details.append(el(ctx.document, "summary", "", t(ctx, `旧目标待重新设置 · ${legacy.length}`, `Older goals to reset · ${legacy.length}`)));
      for (const item of legacy) { const row = el(ctx.document, "div", "pd-finance-goal"); row.append(el(ctx.document, "span", "", `${item.month} · ${item.goal.name} · ${item.goal.target} ${item.goal.unit}`), guarded(moduleButton(ctx, t(ctx, "重新设置", "Reset goal"), () => v.push(createFinanceGoalForm(ctx, undefined, item))))); details.append(row); } section.append(details); }
  }
  function bills(): void { for (const plan of snapshot!.data.financeBillPlans) { const facts = financeBillPlanStats(plan, snapshot!.records.map(record => record.entry)); panel.append(moduleButton(ctx, `${plan.name} · ¥${money(facts.netCents)} / ¥${money(plan.budgetCents)}`, () => v.push(createBillPage(ctx, snapshot!, plan)))); } if (!snapshot!.data.financeBillPlans.length) moduleEmpty(ctx, panel, t(ctx, "还没有账单计划", "No bill plans yet")); panel.append(guarded(moduleButton(ctx, t(ctx, "新增账单计划", "Add bill plan"), () => v.push(createFinanceBillForm(ctx))))); }
  const reload = () => { if (!v.busy) void v.read(async () => ({ data: await port.readData(), records: await service.ledger.readSnapshots({ notify: false }) }), value => { snapshot = value; draw(); }); };
  v.cleanup(service.subscribeEntries(reload)); v.cleanup(service.subscribe(reload)); v.cleanup(service.access.subscribe(reload)); v.cleanup(() => { if (ownedAnalysis) service.cancel(ownedAnalysis); }); reload(); return v.finish();
}

function renderEntries(ctx: IPadPageContext, parent: HTMLElement, entries: readonly FinanceEntry[], open: (entry: FinanceEntry) => void | Promise<void>): void {
  const scroll = el(ctx.document, "div", "pd-module-table-scroll"), table = el(ctx.document, "table", "pd-finance-table"), head = el(ctx.document, "thead", ""), header = el(ctx.document, "tr", "");
  for (const title of [t(ctx, "商户", "Merchant"), t(ctx, "分类", "Category"), t(ctx, "日期", "Date"), t(ctx, "金额", "Amount")]) header.append(el(ctx.document, "th", "", title)); head.append(header); table.append(head); const body = el(ctx.document, "tbody", "");
  for (const entry of entries) { const row = el(ctx.document, "tr", ""), title = el(ctx.document, "td", ""); title.append(moduleButton(ctx, entry.merchant || entry.description || "—", () => open(entry))); row.append(title, el(ctx.document, "td", "", entry.category), el(ctx.document, "td", "", formatMobileDateTime(entry.date, Date.now(), ctx.host.settings().settingsLanguage)), el(ctx.document, "td", "is-number", `${entry.kind === "expense" ? "−" : entry.kind === "income" || entry.kind === "refund" ? "+" : ""}${money(entry.amountCents)}`)); body.append(row); } table.append(body); scroll.append(table); parent.append(scroll); if (!entries.length) moduleEmpty(ctx, parent, t(ctx, "没有符合条件的账目", "No matching transactions"));
}
function pagination(ctx: IPadPageContext, parent: HTMLElement, page: number, pages: number, change: (page: number) => void): void { if (pages <= 1) return; const actions = moduleActions(ctx, parent), previous = moduleButton(ctx, t(ctx, "上一页", "Previous"), () => change(page - 1)), next = moduleButton(ctx, t(ctx, "下一页", "Next"), () => change(page + 1)); previous.disabled = page === 1; next.disabled = page === pages; actions.append(previous, el(ctx.document, "span", "", `${page}/${pages}`), next); }
function createBillPage(ctx: IPadPageContext, snapshot: FinanceSnapshot, plan: FinanceBillPlan): MobileShellPage {
  const port = ctx.host.services.modules.finance, service = port.service, id = plan.id, v = moduleView(ctx, `ipad-finance-bill-${id}`, plan.name), filters = emptyFinanceBillPlanFilters(); let page = 1;
  const render = () => {
    v.setTitle(plan.name); v.body.replaceChildren(); const stats = financeBillPlanStats(plan, snapshot.records.map(record => record.entry));
    const summary = el(ctx.document, "div", "pd-finance-summary"); for (const [name, value] of [[t(ctx, "已用", "Spent"), stats.netCents], [t(ctx, "剩余", "Remaining"), stats.remainingCents], [t(ctx, "平均", "Average"), stats.averageCents]] as const) summary.append(el(ctx.document, "div", "", `${name} · ${value === null ? "—" : `¥${money(value)}`}`)); v.body.append(summary);
    const actions = moduleActions(ctx, v.body); if (service.accessState().canWrite) actions.append(moduleButton(ctx, t(ctx, "编辑计划", "Edit plan"), () => v.push(createFinanceBillForm(ctx, plan))), moduleButton(ctx, t(ctx, "关联账目", "Link transactions"), () => v.push(createBillAssociationPage(ctx, snapshot, plan))));
    actions.append(moduleButton(ctx, t(ctx, "导出", "Export"), () => v.run(async () => { const path = await port.saveCsv(`bill-${id}.csv`, service.exportCsv(stats.entries)); v.status(path); })));
    const list = el(ctx.document, "div", "pd-finance-bill-entries"); moduleField(ctx, v.body, t(ctx, "搜索账目", "Search transactions"), filters.search, value => { filters.search = value; page = 1; renderRows(); }); v.body.append(list);
    for (const category of stats.categoryBudgets) v.body.append(el(ctx.document, "div", "pd-finance-fact", `${category.category} · ¥${money(category.netCents)} / ${category.allocationCents === null ? "—" : `¥${money(category.allocationCents)}`}`));
    function renderRows(): void { const entries = filterFinanceBillPlanEntries(stats.entries, filters), pages = Math.max(1, Math.ceil(entries.length / 20)); page = Math.min(page, pages); list.replaceChildren(); renderEntries(ctx, list, entries.slice((page - 1) * 20, page * 20), entry => { const record = snapshot.records.find(item => item.entry.id === entry.id); if (record) return v.push(createFinanceRecordPage(ctx, snapshot.data, record)); }); pagination(ctx, list, page, pages, value => { page = value; renderRows(); }); } renderRows();
  };
  const reload = () => { if (!v.busy) void v.read(async () => ({ data: await port.readData(), records: await service.ledger.readSnapshots({ notify: false }) }), value => { const current = value.data.financeBillPlans.find(item => item.id === id); if (!current) { v.body.replaceChildren(); moduleEmpty(ctx, v.body, t(ctx, "账单计划已不存在", "This bill plan no longer exists")); return; } snapshot = value; plan = current; render(); }); };
  v.cleanup(service.subscribeEntries(reload)); v.cleanup(service.subscribe(reload)); v.cleanup(service.access.subscribe(reload)); render(); return v.finish();
}
function createBillAssociationPage(ctx: IPadPageContext, snapshot: FinanceSnapshot, plan: FinanceBillPlan): MobileShellPage {
  const v = moduleView(ctx, `ipad-finance-associate-${plan.id}`, t(ctx, "关联账目", "Link transactions")), service = ctx.host.services.modules.finance.service;
  const selected = new Set(snapshot.records.filter(record => record.entry.billPlanId === plan.id).map(record => record.entry.id)), original = new Set(selected); let search = "", page = 1;
  moduleField(ctx, v.body, t(ctx, "搜索账目", "Search transactions"), "", value => { search = value; page = 1; render(); });
  const list = el(ctx.document, "div", "pd-finance-associate-list"); v.body.append(list);
  const render = () => {
    list.replaceChildren(); const records = snapshot.records.filter(record => `${record.entry.merchant} ${record.entry.description} ${record.entry.date}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())), pages = Math.max(1, Math.ceil(records.length / 20)); page = Math.min(page, pages);
    for (const record of records.slice((page - 1) * 20, page * 20)) { const entry = record.entry, row = el(ctx.document, "label", "pd-module-check-row"), input = el(ctx.document, "input", ""); input.type = "checkbox"; input.checked = selected.has(entry.id); input.setAttribute("aria-label", `${entry.merchant} ${money(entry.amountCents)}`); input.addEventListener("change", () => { if (input.checked) selected.add(entry.id); else selected.delete(entry.id); v.changed(); }); row.append(el(ctx.document, "span", "", `${formatMobileDate(entry.date)} · ${entry.merchant} · ¥${money(entry.amountCents)}`), input); list.append(row); }
    pagination(ctx, list, page, pages, value => { page = value; render(); });
  };
  const actions = moduleActions(ctx, v.body); actions.append(moduleButton(ctx, t(ctx, "保存关联", "Save links"), async () => {
    const saved = await v.run(async () => {
      for (const record of snapshot.records) { const id = record.entry.id; if (selected.has(id) === original.has(id)) continue;
        const result = await service.patchConversationRecord(id, record.version, { billPlanId: selected.has(id) ? plan.id : null });
        record.version = result.version; if (selected.has(id)) original.add(id); else original.delete(id);
      }
      v.status(t(ctx, "关联已保存", "Links saved"));
    }); if (saved) { v.allow(); await ctx.shell.back(); }
  }, true));
  v.dirty = () => selected.size !== original.size || [...selected].some(id => !original.has(id)); render(); return v.finish();
}
