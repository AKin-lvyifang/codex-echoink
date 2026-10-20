import type { FinanceEntry, FinanceBillPlan, FinanceContinuousGoal, FinanceGoal, LifestyleData, LifeReport } from "../../lifestyle/store-core";
import { lifeId } from "../../lifestyle/store-core";
import { parseYuan, parsePercent, money, localDate, type FinanceImportRow } from "../../lifestyle/finance-domain";
import { FinanceBudgetEditor, parseFinanceBudgetDraft, type FinanceBudgetDraft } from "../../lifestyle/finance-budget";
import { financeIconOptions, renderFinanceIcon, type FinanceIconScope } from "../../lifestyle/finance-icon-picker";
import type { FinanceImportCompletionOptions } from "../../lifestyle/finance-service";
import type { FinanceImportResult } from "../../lifestyle/finance-ledger";
import type { FinanceReportSnapshot, FinanceReportBlock, FinanceChartSnapshot, FinanceTableSnapshot } from "../../lifestyle/finance-analysis";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneButton, iphoneElement as el } from "./workbench-elements";
import { IPhoneModulePage, moduleSegments, moduleText } from "./module-elements";
import { formatMobileDateTime } from "../../mobile/date-display";

export const FINANCE_KIND_LABELS = { expense: "支出", income: "收入", refund: "退款", transfer: "转账" } as const;
const yuan = (cents: number) => (cents / 100).toFixed(2);
const categories = (ctx: IPhonePageContext) => ctx.host.settings().lifestyle.finance.categories.filter(item => item.active).map(item => item.name);
const categoryChoices = (ctx: IPhonePageContext, current = ""): [string, string][] => [["", moduleText(ctx, "未分类")], ...[...new Set([...categories(ctx), current].filter(Boolean))].map(name => [name, name] as [string, string])];
const back = async (view: IPhoneModulePage) => { view.allow(); await view.ctx.shell.back(); };

export async function financeIconPage(view: IPhoneModulePage, scope: FinanceIconScope, current: string, change: (value: string) => void): Promise<void> {
  const { ctx } = view, picker = new IPhoneModulePage(ctx, `iphone-finance-icon-${scope}`, "选择图标"), list = el(ctx.document, "div", "ip-finance-icon-grid"); let query = "";
  picker.field(picker.body, "搜索图标", "", value => { query = value; render(); }); picker.body.append(list);
  const render = () => { list.replaceChildren(); for (const option of financeIconOptions(scope).filter(option => `${option.name} ${option.id} ${option.aliases.join(" ")}`.toLowerCase().includes(query.toLowerCase()))) {
    const button = iphoneButton(ctx.document, option.name, () => { change(option.id); view.changed(); void ctx.shell.back().catch(error => ctx.error(error)); }); button.classList.add("ip-finance-icon-choice"); button.setAttribute("aria-pressed", String(option.id === current)); const icon = el(ctx.document, "span", "ip-finance-brand"); renderFinanceIcon(icon, option.id); button.querySelector(".ip-button-visible")!.prepend(icon); list.append(button);
  } }; render(); await view.child(() => picker.push());
}
export function financeIconField(view: IPhoneModulePage, parent: HTMLElement, scope: FinanceIconScope, initial: string, change: (value: string) => void): void {
  const icon = el(view.ctx.document, "span", "ip-finance-brand"), button = view.button(parent, "选择图标", () => financeIconPage(view, scope, value, next => { value = next; change(next); renderFinanceIcon(icon, value); })); let value = initial;
  renderFinanceIcon(icon, value); button.querySelector(".ip-button-visible")!.prepend(icon);
}

export async function openFinanceEntry(ctx: IPhonePageContext, saved: () => Promise<void>, entry?: FinanceEntry, billPlanId?: string): Promise<void> {
  const service = ctx.host.services.modules.finance.service, view = new IPhoneModulePage(ctx, `iphone-finance-entry-${entry?.id ?? "new"}`, entry ? "账目详情" : "记一笔");
  let target = entry, version = "";
  const draft = { kind: entry?.kind ?? "expense", amount: entry ? yuan(entry.amountCents) : "", merchant: entry?.merchant ?? "", category: entry?.classificationPending ? "" : entry?.category ?? categories(ctx)[0] ?? "", account: entry?.account ?? "手动记录", date: entry?.date.slice(0, 10) ?? localDate(), description: entry?.description ?? "", note: entry?.note ?? "", icon: entry?.icon ?? "auto", billPlanId: entry?.billPlanId ?? billPlanId ?? "" };
  let baseline = JSON.stringify(draft); view.dirty = () => JSON.stringify(draft) !== baseline;
  const render = () => {
    view.body.replaceChildren();
    if (target) { const facts = view.group(); for (const [key, value] of [["金额", `¥ ${money(target.amountCents)}`], ["交易类型", moduleText(ctx, FINANCE_KIND_LABELS[target.kind])], ["日期", target.date], ["状态", moduleText(ctx, target.status === "completed" ? "已完成" : "未完成")], ["备注", target.note || "—"]]) { const row = el(ctx.document, "div", "ip-module-fact"); row.append(el(ctx.document, "span", "", moduleText(ctx, key)), el(ctx.document, "span", "", value)); facts.append(row); } }
    else { view.select(view.body, "交易类型", Object.entries(FINANCE_KIND_LABELS).map(([key, label]) => [key, moduleText(ctx, label)]), draft.kind, value => { draft.kind = value as typeof draft.kind; }); const amount = view.field(view.body, "金额 · 元", draft.amount, value => { draft.amount = value; }, "number"); amount.min = "0.01"; amount.step = "0.01"; }
    view.field(view.body, "商户 / 对方", draft.merchant, value => { draft.merchant = value; }).maxLength = 60;
    view.textarea(view.body, "消费说明", draft.description, value => { draft.description = value; }); view.select(view.body, "分类", categoryChoices(ctx, draft.category), draft.category, value => { draft.category = value; });
    const accounts = ctx.host.settings().lifestyle.finance.accounts.filter(item => item.active).map(item => item.name);
    view.select(view.body, "账户", [["", moduleText(ctx, "未指定")], ...[...new Set([...accounts, draft.account].filter(Boolean))].map(name => [name, name] as const)], draft.account, value => { draft.account = value; });
    if (!target) { view.field(view.body, "日期", draft.date, value => { draft.date = value; }, "date"); view.field(view.body, "备注", draft.note, value => { draft.note = value; }); }
    const plans = service.billPlans(); view.select(view.body, "账单计划", [["", moduleText(ctx, "不关联账单")], ...plans.map(plan => [plan.id, plan.name] as const), ...(draft.billPlanId && !plans.some(plan => plan.id === draft.billPlanId) ? [[draft.billPlanId, moduleText(ctx, "原账单未找到（保留关联）")] as const] : [])], draft.billPlanId, value => { draft.billPlanId = value; });
    financeIconField(view, view.body, "entry", draft.icon, value => { draft.icon = value; });
    if (target) view.button(view.body, "在笔记中查看 Bases", () => service.openBase(target!.id));
  };
  if (target) view.button(view.footer, "重新读取", async () => { await view.run(async () => { const fresh = await service.readForConversation(), record = fresh.records.find(item => item.entry.id === target!.id); if (!record) throw new Error(moduleText(ctx, "账目已不存在。")); target = record.entry; version = record.version; render(); }); });
  view.button(view.footer, "取消", () => back(view)); view.button(view.footer, "保存", async () => {
    const success = await view.run(async () => {
      if (target) await service.patchConversationRecord(target.id, version, { merchant: draft.merchant, description: draft.description, category: draft.category || undefined, account: draft.account, icon: draft.icon, billPlanId: draft.billPlanId === (target.billPlanId ?? "") ? undefined : draft.billPlanId || null });
      else await service.addManual({ kind: draft.kind, amountCents: parseYuan(draft.amount), merchant: draft.merchant, category: draft.category, account: draft.account, date: draft.date, description: draft.description, note: draft.note, status: "completed", currency: "CNY", icon: draft.icon, ...(draft.billPlanId ? { billPlanId: draft.billPlanId } : {}) });
      await saved(); baseline = JSON.stringify(draft);
    }); if (success) await back(view);
  }, true);
  await view.push(); if (!view.alive) return;
  if (target) await view.run(async () => { const fresh = await service.readForConversation(), record = fresh.records.find(item => item.entry.id === target!.id); if (!record) throw new Error(moduleText(ctx, "账目已不存在。")); target = record.entry; version = record.version; Object.assign(draft, { merchant: target.merchant, category: target.category, account: target.account, description: target.description, icon: target.icon ?? "auto", billPlanId: target.billPlanId ?? "" }); baseline = JSON.stringify(draft); render(); }); else render();
}

export async function openFinanceImport(ctx: IPhonePageContext, saved: () => Promise<void>): Promise<void> {
  const port = ctx.host.services.modules.finance, service = port.service, view = new IPhoneModulePage(ctx, "iphone-finance-import", "导入账单"); let source = "wechat", rows: FinanceImportRow[] = [], revision = 0, controller: AbortController | undefined;
  const select = view.select(view.body, "账单来源", [["wechat", moduleText(ctx, "微信")], ["alipay", moduleText(ctx, "支付宝")]], source, value => { source = value; rows = []; revision++; drawPreview(); });
  const file = view.field(view.body, "选择账单文件", "", () => {}, "file"); file.accept = ".csv,.xlsx";
  const status = el(ctx.document, "div", "ip-module-status"), preview = el(ctx.document, "div", "ip-finance-import-preview"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); view.body.append(status, preview);
  const drawPreview = () => {
    preview.replaceChildren(); if (!rows.length) { status.textContent = ""; start.disabled = true; return; }
    try { const result = service.previewImport(rows); status.textContent = moduleText(ctx, `可导入 ${result.added.length + result.updated.length} · 已存在 ${result.duplicates} · 无效 ${result.invalid}`, `Ready ${result.added.length + result.updated.length} · Existing ${result.duplicates} · Invalid ${result.invalid}`); start.disabled = !rows.some(row => row.entry); for (const row of rows.filter(row => row.error || row.review)) preview.append(el(ctx.document, "p", "", row.error || row.review)); }
    catch (error) { view.error.show(error); start.disabled = true; }
  };
  file.addEventListener("change", () => { const selected = file.files?.[0], current = ++revision; if (!selected) return; rows = []; start.disabled = true; void view.run(async () => { const bytes = new Uint8Array(await selected.arrayBuffer()); const next = await port.readBill(bytes, selected.name, source as "wechat" | "alipay"); if (!view.alive || current !== revision) return; rows = next; }).then(ok => { if (ok && current === revision) drawPreview(); }); });
  view.button(view.footer, "取消", () => back(view)); const stop = view.button(view.footer, "停止", () => { controller?.abort(); status.textContent = moduleText(ctx, "正在停止…"); }); stop.dataset.moduleStop = "true"; stop.hidden = true;
  const start = view.button(view.footer, "开始导入", async () => {
    if (!rows.length || controller) return; controller = new AbortController(); const request = controller, ids = new Set<string>(); stop.hidden = false;
    const complete: FinanceImportCompletionOptions = { signal: request.signal }; let result: FinanceImportResult | undefined, failure: unknown;
    await view.run(async () => {
      try {
        result = await service.confirmImport(rows, { signal: request.signal, onSaved: entry => { ids.add(entry.id); if (view.alive) status.textContent = moduleText(ctx, `已保存 ${ids.size} 笔`, `${ids.size} records saved`); } });
        if (result.writeError) throw new Error(result.writeError);
        if (!request.signal.aborted && result.created.length) {
          complete.organization = await service.prepareImport(result.created, request.signal, (done, total) => { if (view.alive) status.textContent = moduleText(ctx, `正在整理 ${done} / ${total}`, `Organizing ${done} / ${total}`); });
          if (!request.signal.aborted) complete.suggestions = await service.applyImportSuggestions(result.created, complete.organization.rows, request.signal);
          for (const warning of complete.organization.warnings) if (view.alive) preview.append(el(ctx.document, "p", "", warning));
        }
      } catch (error) { failure = error; complete.failed = true; }
      finally {
        try { if (ids.size) await service.finalizeImportedAccounts(ids); if (result) await service.completeImport(result, complete); }
        catch (error) { failure ??= error; }
        if (view.alive) { await saved(); status.textContent = request.signal.aborted ? moduleText(ctx, `已停止 · 已保存 ${ids.size} 笔`, `Stopped · ${ids.size} saved`) : result ? moduleText(ctx, `新增 ${result.added} · 更新 ${result.updated} · 重复 ${result.duplicates} · 无效 ${result.invalid}`, `Added ${result.added} · Updated ${result.updated} · Existing ${result.duplicates} · Invalid ${result.invalid}`) : moduleText(ctx, "导入失败"); }
      }
      if (failure && !request.signal.aborted) throw failure instanceof Error ? failure : new Error(typeof failure === "string" ? failure : moduleText(ctx, "导入失败"));
    });
    if (!view.alive) return; stop.hidden = true; controller = undefined; start.disabled = true; select.disabled = true; file.disabled = true;
  }, true); start.disabled = true;
  view.cleanup(() => { revision++; controller?.abort(); }); view.beforeLeave = () => { controller?.abort(); }; await view.push();
}

export async function openFinanceBudget(ctx: IPhonePageContext, data: Readonly<LifestyleData>, selectedMonth: string, saved: () => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, "iphone-finance-budget", "调整月度预算"), editor = new FinanceBudgetEditor(data, selectedMonth); let scope = editor.months.has(selectedMonth) ? "monthly" : "default", month = selectedMonth, modeDraft: FinanceBudgetDraft | undefined;
  view.dirty = () => editor.defaultDraft.dirty || [...editor.months.values()].some(value => value.dirty) || editor.removed.size > 0;
  const render = () => {
    view.body.replaceChildren(); moduleSegments(view, view.body, "预算编辑范围", [["default", "每月默认"], ["monthly", "按月独立"]], scope, value => { scope = value; render(); });
    if (scope === "monthly") {
      view.field(view.body, "独立月份", month, value => { month = value; }, "month"); const actions = el(ctx.document, "div", "ip-module-inline-actions");
      view.button(actions, "新增", () => { try { editor.add(month); render(); } catch (error) { view.error.show(error); } }); view.button(actions, "恢复默认", () => { try { editor.restore(month); render(); } catch (error) { view.error.show(error); } }); view.body.append(actions);
      view.select(view.body, "已有独立月份", [...editor.months.keys()].sort().map(key => [key, key]), editor.months.has(month) ? month : "", value => { month = value; render(); });
    }
    const draft = scope === "default" ? editor.defaultDraft : editor.months.get(month); modeDraft = draft; if (!draft) { view.empty(view.body, "暂无独立月份"); return; }
    const allCategories = [...new Set([...categories(ctx), ...Object.keys(draft.values)])];
    view.field(view.body, "月度总预算 · 元", draft.total, value => { draft.total = value; draft.dirty = true; }, "number").step = "0.01";
    moduleSegments(view, view.body, "预算分配方式", [["amount", "按金额"], ["percent", "按比例"]], draft.mode, value => {
      try { const parsed = parseFinanceBudgetDraft(draft, month); draft.values = Object.fromEntries(Object.entries(parsed.allocations).map(([key, amount]) => [key, value === "amount" ? yuan(amount) : (amount / parsed.totalCents * 100).toFixed(2)])); draft.mode = value as typeof draft.mode; draft.dirty = true; render(); } catch (error) { view.error.show(error); }
    });
    for (const category of allCategories) view.field(view.body, category, draft.values[category] ?? "0.00", value => { draft.values[category] = value; draft.dirty = true; }, "number").step = "0.01";
  };
  view.button(view.footer, "取消", () => back(view)); view.button(view.footer, "保存预算", async () => {
    if (!modeDraft) return; if (await view.run(async () => { await ctx.host.services.modules.finance.service.saveBudgetChanges(editor.changes(scope === "default")); await saved(); })) await back(view);
  }, true); render(); await view.push();
}

export async function openFinanceBillPlan(ctx: IPhonePageContext, saved: () => Promise<void>, plan?: FinanceBillPlan): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-plan-form-${plan?.id ?? "new"}`, plan ? "修改账单预算" : "新建账单"), draft = { name: plan?.name ?? "", total: plan ? yuan(plan.budgetCents) : "", allocations: Object.fromEntries(Object.entries(plan?.allocations ?? {}).map(([key, value]) => [key, yuan(value)])) }, baseline = JSON.stringify(draft);
  view.dirty = () => JSON.stringify(draft) !== baseline; view.field(view.body, "账单名称", draft.name, value => { draft.name = value; }); view.field(view.body, "总预算 · 元", draft.total, value => { draft.total = value; }, "number").step = "0.01";
  const allocationHost = el(ctx.document, "div", "ip-finance-allocations"); view.body.append(allocationHost);
  const render = () => { allocationHost.replaceChildren(); for (const category of Object.keys(draft.allocations)) { const row = el(ctx.document, "div", "ip-module-inline-editor"); view.field(row, category, draft.allocations[category], value => { draft.allocations[category] = value; }, "number").step = "0.01"; view.button(row, "移除", () => { delete draft.allocations[category]; view.changed(); render(); }); allocationHost.append(row); } };
  view.select(view.body, "添加已有分类", [["", moduleText(ctx, "选择分类")], ...categories(ctx).map(name => [name, name] as const)], "", value => { if (value && !(value in draft.allocations)) { draft.allocations[value] = ""; render(); } });
  view.button(view.footer, "取消", () => back(view)); view.button(view.footer, "保存账单", async () => { if (await view.run(async () => { await ctx.host.services.modules.finance.service.saveBillPlan({ id: plan?.id ?? lifeId("bill-plan"), name: draft.name.trim(), budgetCents: parseYuan(draft.total), allocations: Object.fromEntries(Object.entries(draft.allocations).filter(([, value]) => value.trim()).map(([key, value]) => [key, parseYuan(value, true)])) }); await saved(); })) await back(view); }, true); render(); await view.push();
}

export async function openFinanceGoal(ctx: IPhonePageContext, saved: () => Promise<void>, goal?: FinanceContinuousGoal, legacy?: { month: string; goal: FinanceGoal }): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-goal-${goal?.id ?? legacy?.goal.id ?? "new"}`, legacy ? "重新设置旧目标" : goal ? "编辑目标" : "新增目标"), draft = { name: goal?.name ?? legacy?.goal.name ?? "", metric: goal?.metric ?? "expense", category: goal?.category ?? "", target: goal ? yuan(goal.target) : "", period: goal?.period ?? "month" }, baseline = JSON.stringify(draft); view.dirty = () => JSON.stringify(draft) !== baseline;
  const render = () => { view.body.replaceChildren(); if (legacy) view.empty(view.body, "请选择自动统计方式；旧实际值不会转入新目标。"); view.field(view.body, "目标名称", draft.name, value => { draft.name = value; }).maxLength = 40;
    view.select(view.body, "统计项", [["expense", "支出不超过"], ["income", "收入达到"], ["balance", "收支结余达到"], ["savings-rate", "本月结余率达到"], ["category-share", "分类消费占比不超过"]].map(([key, name]) => [key, moduleText(ctx, name)]), draft.metric, value => { draft.metric = value as typeof draft.metric; if (value === "balance" || value === "savings-rate") draft.category = ""; if (value === "savings-rate" || value === "category-share") draft.period = "month"; render(); });
    if (draft.metric !== "balance" && draft.metric !== "savings-rate") view.select(view.body, "分类", [["", moduleText(ctx, "全部分类")], ...categories(ctx).map(name => [name, name] as const)], draft.category, value => { draft.category = value; });
    view.field(view.body, draft.metric === "savings-rate" || draft.metric === "category-share" ? "目标比例 · %" : "目标金额 · 元", draft.target, value => { draft.target = value; }, "number").step = "0.01";
    if (draft.metric !== "savings-rate" && draft.metric !== "category-share") view.select(view.body, "周期", [["day", moduleText(ctx, "每天")], ["week", moduleText(ctx, "本周")], ["month", moduleText(ctx, "本月")]], draft.period, value => { draft.period = value as typeof draft.period; });
    if (goal) view.button(view.body, "删除目标", () => view.confirm(view.content, "删除这个目标？", "删除", async () => { if (await view.run(async () => { await ctx.host.services.modules.finance.service.deleteContinuousGoal(goal.id); await saved(); })) await back(view); }, true));
  };
  view.button(view.footer, "取消", () => back(view)); view.button(view.footer, "保存", async () => { if (await view.run(async () => { const identity = { id: goal?.id ?? lifeId("finance-goal"), name: draft.name, category: draft.category, target: draft.metric === "savings-rate" || draft.metric === "category-share" ? parsePercent(draft.target) : parseYuan(draft.target) }; const next: FinanceContinuousGoal = draft.metric === "savings-rate" || draft.metric === "category-share" ? { ...identity, metric: draft.metric, period: "month" } : { ...identity, metric: draft.metric, period: draft.period }; await ctx.host.services.modules.finance.service.saveContinuousGoal(next, legacy ? { month: legacy.month, id: legacy.goal.id } : undefined); await saved(); })) await back(view); }, true);
  render(); await view.push();
}

export async function openFinanceDailyLimit(ctx: IPhonePageContext, month: string, current: number | null, saved: () => Promise<void>): Promise<void> {
  const view = new IPhoneModulePage(ctx, `iphone-finance-daily-limit-${month}`, "每日额度"); let draft = current === null ? "" : yuan(current); const original = draft; view.dirty = () => draft !== original;
  view.field(view.body, "每日额度 · 元", draft, value => { draft = value; }, "number").step = "0.01"; view.button(view.footer, "取消", () => back(view)); view.button(view.footer, "保存", async () => { if (await view.run(async () => { await ctx.host.services.modules.finance.service.saveDailyLimit(month, draft.trim() ? parseYuan(draft) : null); await saved(); })) await back(view); }, true); await view.push();
}

export function renderFinanceReport(view: IPhoneModulePage, parent: HTMLElement, report: LifeReport): void {
  const { ctx } = view, metadata = el(ctx.document, "div", "ip-module-status", `${formatMobileDateTime(report.createdAt, Date.now(), ctx.host.settings().settingsLanguage === "en" ? "en" : "zh-CN")} · ${report.provider}`); parent.append(metadata);
  const markdown = (host: HTMLElement, text: string) => { const content = el(ctx.document, "div", "ip-finance-report markdown-rendered"); host.append(content); ctx.host.renderMarkdown(text, content); };
  const chart = (host: HTMLElement, value: FinanceChartSnapshot) => { const section = el(ctx.document, "section", "ip-finance-report-chart"); section.append(el(ctx.document, "h3", "", value.title)); const max = Math.max(1, ...value.points.map(point => Math.abs(point.valueCents))); for (const point of value.points) { const row = el(ctx.document, "div", "ip-finance-chart-row"); row.append(el(ctx.document, "span", "", point.label)); const track = el(ctx.document, "span", "ip-finance-chart-track"), bar = el(ctx.document, "i", ""); bar.style.width = `${Math.abs(point.valueCents) / max * 100}%`; track.append(bar); row.append(track, el(ctx.document, "span", "", money(point.valueCents))); if (point.comparisonCents !== undefined) row.append(el(ctx.document, "span", "ip-sub", money(point.comparisonCents))); section.append(row); } if (value.explanation) markdown(section, value.explanation); host.append(section); };
  const table = (host: HTMLElement, value: FinanceTableSnapshot) => { const scroll = el(ctx.document, "div", "ip-finance-table-scroll"), element = el(ctx.document, "table", "ip-finance-table"); scroll.append(element); const header = el(ctx.document, "tr", ""); for (const label of value.headers) header.append(el(ctx.document, "th", "", label)); element.append(header); for (const values of value.rows) { const row = el(ctx.document, "tr", ""); for (const text of values) row.append(el(ctx.document, "td", "", text)); element.append(row); } host.append(el(ctx.document, "h3", "", value.title), scroll); };
  const block = (host: HTMLElement, value: FinanceReportBlock) => { if (value.type === "chart") chart(host, value.chart); else if (value.type === "table") { table(host, value.table); if (value.explanation) markdown(host, value.explanation); } else if (value.type === "actions") { const list = el(ctx.document, "ul", ""); for (const text of value.items) list.append(el(ctx.document, "li", "", text)); host.append(list); } else markdown(host, value.markdown); };
  const snapshot = report.financeSnapshot as FinanceReportSnapshot | undefined;
  if (snapshot?.version === 8 && Array.isArray(snapshot.sections)) for (const section of snapshot.sections) { const host = el(ctx.document, "section", "ip-finance-report-section"); host.append(el(ctx.document, "h3", "", section.title)); for (const value of section.blocks) block(host, value); parent.append(host); }
  else if (snapshot && typeof snapshot.conclusion === "string" && Array.isArray(snapshot.charts) && Array.isArray(snapshot.suggestions)) { markdown(parent, snapshot.conclusion); for (const value of snapshot.charts) chart(parent, value); for (const suggestion of snapshot.suggestions) markdown(parent, suggestion); if (snapshot.detail) markdown(parent, snapshot.detail); }
  else markdown(parent, report.text);
  if (snapshot?.omittedSuggestionCount) parent.append(el(ctx.document, "div", "ip-module-status", moduleText(ctx, `有 ${snapshot.omittedSuggestionCount} 条建议未完整生成，未展示。`, `${snapshot.omittedSuggestionCount} incomplete suggestions were not shown.`)));
}
