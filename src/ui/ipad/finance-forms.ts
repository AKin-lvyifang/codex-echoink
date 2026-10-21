import type { FinanceEntry, FinanceBillPlan, FinanceContinuousGoal, FinanceGoal, LifestyleData } from "../../lifestyle/store-core";
import type { FinanceRecordSnapshot, FinanceRecordPatch } from "../../lifestyle/finance-operation-types";
import { financeBudgetSnapshot, financeValueVersion } from "../../lifestyle/finance-operation-types";
import { financeBudgetDraft, parseFinanceBudgetDraft } from "../../lifestyle/finance-budget";
import { localDate, money, parsePercent, parseYuan } from "../../lifestyle/finance-domain";
import { formatMobileDateTime } from "../../mobile/date-display";
import { financeIconOptions, renderFinanceIcon, type FinanceIconScope } from "../../lifestyle/finance-icon-picker";
import { resolveFinanceAccount, resolveFinanceMerchant } from "../../lifestyle/finance-catalog";
import type { FinanceSettings } from "../../lifestyle/settings";
import type { IPadPageContext } from "./workbench-contract";
import type { MobileShellPage } from "../mobile/shell-types";
import { createModuleForm, el, moduleActions, moduleButton, moduleConfirm, moduleEmpty, moduleField, moduleView, moduleSettingsGroup, moduleNavigationRow, moduleText as t, type ModuleFormField } from "./module-elements";

const port = (ctx: IPadPageContext) => ctx.host.services.modules.finance;
const categories = (ctx: IPadPageContext) => ctx.host.settings().lifestyle.finance.categories.filter(item => item.active).map(item => item.name);
const key = (ctx: IPadPageContext, prefix: string) => `${prefix}-${ctx.document.defaultView!.crypto.randomUUID()}`;
const option = (values: string[], current = "") => [...new Set([current, ...values].filter(Boolean))].map(value => [value, value] as const);
function iconField(ctx: IPadPageContext, key: string, value: string, scope: FinanceIconScope): ModuleFormField {
  return { key, value, label: t(ctx, "选择图标", "Choose icon"), renderChoice: renderFinanceIcon,
    picker: (selected, select) => { const v = moduleView(ctx, `ipad-finance-icon-${scope}`, t(ctx, "选择图标", "Choose icon")), list = el(ctx.document, "div", "pd-finance-icon-grid");
      const draw = (search = "") => { list.replaceChildren(); const choices = financeIconOptions(scope).filter(item => `${item.name} ${item.id} ${item.aliases.join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
        for (const choice of choices) { const button = moduleButton(ctx, choice.name, async () => { select(choice.id); await ctx.shell.back(); }), art = el(ctx.document, "span", "pd-finance-icon-art"); renderFinanceIcon(art, choice.id); button.firstElementChild!.prepend(art); button.setAttribute("aria-pressed", String(choice.id === selected)); list.append(button); } if (!choices.length) moduleEmpty(ctx, list, t(ctx, "没有匹配的图标", "No matching icons")); };
      moduleField(ctx, v.body, t(ctx, "搜索图标", "Search icons"), "", draw, "search"); v.body.append(list); draw(); return v.finish(); }
  };
}

export function createFinanceEntryForm(ctx: IPadPageContext, data: Readonly<LifestyleData>, snapshot?: FinanceRecordSnapshot): MobileShellPage {
  const service = port(ctx).service, entry = snapshot?.entry;
  const fields: ModuleFormField[] = [
    { key: "date", label: t(ctx, "交易时间", "Transaction time"), value: entry?.date.replace(" ", "T").slice(0, 16) ?? `${localDate()}T09:00`, type: "datetime-local" },
    { key: "merchant", label: t(ctx, "商户", "Merchant"), value: entry?.merchant ?? "" },
    { key: "kind", label: t(ctx, "类型", "Type"), value: entry?.kind ?? "expense", options: [["expense", t(ctx, "支出", "Expense")], ["income", t(ctx, "收入", "Income")], ["refund", t(ctx, "退款", "Refund")], ["transfer", t(ctx, "转账", "Transfer")]] },
    { key: "amount", label: t(ctx, "金额 · 元", "Amount · CNY"), value: entry ? (entry.amountCents / 100).toFixed(2) : "", type: "number" },
    { key: "category", label: t(ctx, "分类", "Category"), value: entry?.classificationPending ? "" : entry?.category ?? categories(ctx)[0] ?? "", options: [...(entry?.classificationPending ? [["", t(ctx, "待分类", "To categorize")]] as const : []), ...option(categories(ctx), entry?.category)] },
    { key: "account", label: t(ctx, "账户", "Account"), value: entry?.account ?? "" },
    { key: "description", label: t(ctx, "说明", "Description"), value: entry?.description ?? "" },
    { key: "note", label: t(ctx, "备注", "Note"), value: entry?.note ?? "", multiline: true },
    { key: "billPlanId", label: t(ctx, "账单计划", "Bill plan"), value: entry?.billPlanId ?? "", options: [["", t(ctx, "不关联", "None")], ...data.financeBillPlans.map(item => [item.id, item.name] as const), ...(entry?.billPlanId && !data.financeBillPlans.some(item => item.id === entry.billPlanId) ? [[entry.billPlanId, t(ctx, "原账单未找到（保留关联）", "Original bill missing (keep link)")]] as const : [])] },
    iconField(ctx, "icon", entry?.icon ?? "auto", "entry")
  ];
  return createModuleForm(ctx, `ipad-finance-entry-${entry?.id ?? "new"}`, t(ctx, entry ? "编辑账目" : "记一笔", entry ? "Edit transaction" : "Add transaction"), fields, async values => {
    const date = values.date.replace("T", " "), sameDate = entry && values.date === entry.date.replace(" ", "T").slice(0, 16);
    const proposed = { date: sameDate ? entry.date : date.length === 16 ? `${date}:00` : date, merchant: values.merchant, kind: values.kind as FinanceEntry["kind"], amountCents: parseYuan(values.amount), category: values.category || (entry?.classificationPending ? entry.category : ""), account: values.account, description: values.description, note: values.note, icon: values.icon, billPlanId: values.billPlanId || null };
    if (snapshot) { const patch: FinanceRecordPatch = Object.fromEntries(Object.entries(proposed).filter(([key, value]) => value !== (key === "billPlanId" ? snapshot.entry.billPlanId ?? null : snapshot.entry[key as keyof FinanceEntry]))); if (entry?.classificationPending && values.category) patch.category = values.category; await service.patchConversationRecord(snapshot.entry.id, snapshot.version, patch); }
    else { const { billPlanId, ...input } = proposed, config = ctx.host.settings().lifestyle.finance, merchant = resolveFinanceMerchant(input.merchant, config); await service.addManual({ ...input, merchant: merchant.name, account: resolveFinanceAccount(input.account, config) || t(ctx, "手动记录", "Manual"), currency: "CNY", status: "completed", ...(billPlanId ? { billPlanId } : {}) }); }
  });
}

export function createFinanceRecordPage(ctx: IPadPageContext, data: Readonly<LifestyleData>, snapshot: FinanceRecordSnapshot): MobileShellPage {
  const service = port(ctx).service, id = snapshot.entry.id, v = moduleView(ctx, `ipad-finance-record-${id}`, snapshot.entry.merchant || t(ctx, "账目详情", "Transaction"));
  const render = () => { const entry = snapshot.entry; v.setTitle(entry.merchant || t(ctx, "账目详情", "Transaction")); v.body.replaceChildren();
  const facts = [[t(ctx, "交易时间", "Date"), formatMobileDateTime(entry.date, Date.now(), ctx.host.settings().settingsLanguage)], [t(ctx, "金额", "Amount"), money(entry.amountCents)], [t(ctx, "分类", "Category"), entry.category], [t(ctx, "账户", "Account"), entry.account], [t(ctx, "说明", "Description"), entry.description], [t(ctx, "备注", "Note"), entry.note]];
  for (const [name, value] of facts) { const row = el(ctx.document, "div", "pd-finance-fact"); row.append(el(ctx.document, "span", "pd-module-secondary", name), el(ctx.document, "span", "", value || "—")); v.body.append(row); }
  const actions = moduleActions(ctx, v.body), confirmation = el(ctx.document, "div", "pd-module-confirm-area"); v.body.append(confirmation);
  actions.append(moduleButton(ctx, t(ctx, "打开账目原件", "Open source note"), () => ctx.host.openNote(snapshot.path)));
  if (service.accessState().canWrite) {
    actions.append(moduleButton(ctx, t(ctx, "编辑", "Edit"), () => v.push(createFinanceEntryForm(ctx, data, snapshot))));
    const remove = moduleButton(ctx, t(ctx, "删除", "Delete"), () => moduleConfirm(ctx, confirmation, t(ctx, "删除这笔账目？原件会进入可恢复状态。", "Delete this transaction? Its source remains recoverable."), async () => { const saved = await v.run(() => service.deleteConversationRecord(entry.id, snapshot.version)); if (saved) await ctx.shell.back(); }, t(ctx, "删除", "Delete"))); remove.classList.add("is-danger"); actions.append(remove);
  }
  };
  const reload = () => { if (!v.busy) void v.read(async () => ({ records: await service.ledger.readSnapshots(), data: await port(ctx).readData() }), value => { const current = value.records.find(item => item.entry.id === id); if (!current) { v.body.replaceChildren(); moduleEmpty(ctx, v.body, t(ctx, "账目已不存在", "This transaction no longer exists")); return; } snapshot = current; data = value.data; render(); }); };
  v.cleanup(service.subscribeEntries(reload)); v.cleanup(service.access.subscribe(reload)); render(); return v.finish();
}

export function createFinanceBudgetForm(ctx: IPadPageContext, data: Readonly<LifestyleData>, scope: string): MobileShellPage {
  const before = financeBudgetSnapshot(data, scope), draft = before.budget ? financeBudgetDraft(before.budget) : { total: "", values: {}, mode: "amount" as const, dirty: false };
  const names = [...new Set([...categories(ctx), ...Object.keys(before.budget?.allocations ?? {})])];
  return createModuleForm(ctx, `ipad-finance-budget-${scope}`, scope === "default" ? t(ctx, "每月默认预算", "Default monthly budget") : `${scope} ${t(ctx, "独立预算", "budget override")}`, [
    { key: "mode", label: t(ctx, "分配方式", "Allocation method"), value: draft.mode, options: [["amount", t(ctx, "金额", "Amounts")], ["percent", t(ctx, "百分比", "Percentages")]], segmented: true },
    { key: "total", label: t(ctx, "总预算 · 元", "Total budget · CNY"), value: draft.total, type: "number" },
    ...names.map((name, index) => ({ key: `category-${index}`, label: name, value: draft.values[name] ?? "0", type: "number" }))
  ], async values => {
    const budget = parseFinanceBudgetDraft({ total: values.total, mode: values.mode as "amount" | "percent", values: Object.fromEntries(names.map((name, index) => [name, values[`category-${index}`]])), dirty: true }, scope === "default" ? "2000-01" : scope);
    await port(ctx).service.patchConversationBudget(scope, before.version, { totalCents: budget.totalCents, allocations: budget.allocations });
  }, { change: (key, values, previous) => {
    if (key !== "mode" || values.mode === previous) return; const total = parseYuan(values.total);
    const converted = names.map((_, index) => { const value = values[`category-${index}`] || "0"; return values.mode === "percent" ? (parseYuan(value, true) / total * 100).toFixed(2) : (parsePercent(value) / 10000 * total / 100).toFixed(2); });
    converted.forEach((value, index) => { values[`category-${index}`] = value; });
  } });
}

export function createFinanceDailyLimitForm(ctx: IPadPageContext, month: string): MobileShellPage {
  const service = port(ctx).service, limit = service.monthlyPlan(month).dailyLimitCents;
  return createModuleForm(ctx, `ipad-finance-daily-${month}`, t(ctx, "每日消费额度", "Daily spending limit"), [{ key: "amount", label: t(ctx, "每日额度 · 元", "Daily limit · CNY"), value: limit === null ? "" : (limit / 100).toFixed(2), type: "number" }], values => service.saveDailyLimit(month, values.amount.trim() ? parseYuan(values.amount) : null));
}
export function createFinanceGoalForm(ctx: IPadPageContext, goal?: FinanceContinuousGoal, legacy?: { month: string; goal: FinanceGoal }): MobileShellPage {
  const service = port(ctx).service;
  const page = createModuleForm(ctx, `ipad-finance-goal-${goal?.id ?? "new"}`, t(ctx, "持续目标", "Ongoing goal"), [
    { key: "name", label: t(ctx, "名称", "Name"), value: goal?.name ?? legacy?.goal.name ?? "" },
    { key: "metric", label: t(ctx, "目标类型", "Metric"), value: goal?.metric ?? "expense", options: [["expense", t(ctx, "支出", "Expense")], ["income", t(ctx, "收入", "Income")], ["balance", t(ctx, "结余", "Balance")], ["savings-rate", t(ctx, "结余率", "Savings rate")], ["category-share", t(ctx, "分类占比", "Category share")]] },
    { key: "period", label: t(ctx, "周期", "Period"), value: goal?.period ?? "month", options: [["day", t(ctx, "每天", "Daily")], ["week", t(ctx, "每周", "Weekly")], ["month", t(ctx, "每月", "Monthly")]] },
    { key: "category", label: t(ctx, "分类", "Category"), value: goal?.category ?? "", options: [["", t(ctx, "全部分类", "All categories")], ...option(categories(ctx), goal?.category)] },
    { key: "target", label: t(ctx, "目标值（金额为元，比例为%）", "Target (CNY or %)"), value: goal ? String(goal.target / 100) : "", type: "number" }
  ], values => {
    const proportional = values.metric === "savings-rate" || values.metric === "category-share";
    const next = { id: goal?.id ?? key(ctx, "goal"), name: values.name, metric: values.metric, period: proportional ? "month" : values.period, category: values.metric === "balance" || values.metric === "savings-rate" ? "" : values.category, target: proportional ? parsePercent(values.target) : parseYuan(values.target) } as FinanceContinuousGoal;
    return service.saveContinuousGoal(next, legacy ? { month: legacy.month, id: legacy.goal.id } : undefined);
  });
  if (legacy) page.content.querySelector(".pd-module-body")?.prepend(el(ctx.document, "p", "", t(ctx, "旧实际值不会作为新目标的统计结果；保存后才移走这项旧目标。", "The old value is excluded from the new goal. The old goal is removed only after saving."))); return page;
}
export function createFinanceMonthlyGoalForm(ctx: IPadPageContext, month: string, goal?: FinanceGoal): MobileShellPage {
  return createModuleForm(ctx, `ipad-finance-month-goal-${goal?.id ?? "new"}`, t(ctx, "月度目标", "Monthly goal"), [
    { key: "name", label: t(ctx, "名称", "Name"), value: goal?.name ?? "" },
    { key: "mode", label: t(ctx, "进度来源", "Progress source"), value: goal?.mode ?? "manual", options: [["manual", t(ctx, "手动填写", "Manual")], ["income", t(ctx, "收入", "Income")], ["within-limit-days", t(ctx, "额度内天数", "Days within limit")]] },
    { key: "target", label: t(ctx, "目标", "Target"), value: String(goal?.target ?? ""), type: "number" }, { key: "actual", label: t(ctx, "当前值", "Current value"), value: String(goal?.actual ?? ""), type: "number" }, { key: "unit", label: t(ctx, "单位", "Unit"), value: goal?.unit ?? "" }
  ], values => port(ctx).service.saveGoal(month, { id: goal?.id ?? key(ctx, "monthly-goal"), name: values.name, mode: values.mode as FinanceGoal["mode"], target: Number(values.target), actual: Number(values.actual), unit: values.unit }));
}
export function createFinanceBillForm(ctx: IPadPageContext, plan?: FinanceBillPlan): MobileShellPage {
  const names = [...new Set([...categories(ctx), ...Object.keys(plan?.allocations ?? {})])], id = plan?.id ?? key(ctx, "bill");
  return createModuleForm(ctx, `ipad-finance-bill-form-${id}`, t(ctx, plan ? "编辑账单计划" : "新增账单计划", plan ? "Edit bill plan" : "Add bill plan"), [
    { key: "name", label: t(ctx, "计划名称", "Plan name"), value: plan?.name ?? "" }, { key: "budget", label: t(ctx, "总预算 · 元", "Total budget · CNY"), value: plan ? (plan.budgetCents / 100).toFixed(2) : "", type: "number" },
    ...names.map((name, index) => ({ key: `category-${index}`, label: name, value: String((plan?.allocations?.[name] ?? 0) / 100), type: "number" }))
  ], values => port(ctx).service.writeConversationBill(plan ? "update" : "create", id, financeValueVersion(plan ?? null), { name: values.name, budgetCents: parseYuan(values.budget), allocations: Object.fromEntries(names.map((name, index) => [name, parseYuan(values[`category-${index}`], true)])) }));
}

export function createFinanceSettingsPage(ctx: IPadPageContext): MobileShellPage {
  const service = port(ctx).service, v = moduleView(ctx, "ipad-finance-settings", t(ctx, "财务设置", "Finance settings"));
  v.content.classList.add("is-settings");
  const settings = ctx.host.settings().lifestyle.finance, options = moduleSettingsGroup(ctx, v.body);
  for (const [key, label] of [["aiEnabled", t(ctx, "AI 分析", "AI analysis")], ["importAiEnabled", t(ctx, "账单智能整理", "Organize imported bills")], ["showOnHome", t(ctx, "在首页显示", "Show on home")]] as const) {
    const row = el(ctx.document, "label", "pd-module-check-row"), input = el(ctx.document, "input", ""); input.type = "checkbox"; input.checked = key === "showOnHome" ? ctx.host.settings().homeModules.finance !== false : settings[key]; input.setAttribute("aria-label", label); row.append(el(ctx.document, "span", "", label), input); options.append(row);
    input.addEventListener("change", () => { const requested = input.checked; void v.run(() => service.saveOption(key, requested)).then(saved => { if (!saved) input.checked = !requested; }); });
  }
  const location = moduleNavigationRow(ctx, options, t(ctx, "分析保存位置", "Analysis location"), settings.analysisDirectory || t(ctx, "未设置", "Not set"), () => v.push(createModuleForm(ctx, "ipad-finance-analysis-location", t(ctx, "分析保存位置", "Analysis location"), [{ key: "directory", label: t(ctx, "文件夹", "Folder"), value: ctx.host.settings().lifestyle.finance.analysisDirectory ?? "" }], async values => { await service.saveAnalysisDirectory(values.directory); location.querySelector(".pd-module-settings-value")!.textContent = values.directory || t(ctx, "未设置", "Not set"); })));
  const catalog = moduleSettingsGroup(ctx, v.body, t(ctx, "目录", "Catalogs"));
  for (const [kind, label] of [["merchants", t(ctx, "商户", "Merchants")], ["accounts", t(ctx, "账户", "Accounts")], ["categories", t(ctx, "分类", "Categories")]] as const) moduleNavigationRow(ctx, catalog, label, "", () => v.push(createCatalogPage(ctx, kind)));
  return v.finish();
}
function createCatalogPage<K extends "merchants" | "accounts" | "categories">(ctx: IPadPageContext, kind: K): MobileShellPage {
  const service = port(ctx).service, labels = { merchants: t(ctx, "商户", "Merchants"), accounts: t(ctx, "账户", "Accounts"), categories: t(ctx, "分类", "Categories") }, v = moduleView(ctx, `ipad-finance-catalog-${kind}`, labels[kind]);
  const draw = () => {
    const list = ctx.host.settings().lifestyle.finance[kind]; v.body.replaceChildren(); const group = moduleSettingsGroup(ctx, v.body); v.content.classList.add("is-settings");
    for (const [index, item] of list.entries()) {
      const row = el(ctx.document, "div", "pd-finance-catalog-row"), confirmation = el(ctx.document, "div", "pd-module-confirm-area"); moduleNavigationRow(ctx, row, item.name, "", () => v.push(edit(index)));
      const remove = moduleButton(ctx, t(ctx, "删除", "Delete"), () => moduleConfirm(ctx, confirmation, t(ctx, "删除这项配置？已有账目保留。", "Remove this setting? Existing transactions remain."), async () => { const saved = await v.run(() => service.saveCatalog(kind, list.filter((_, position) => position !== index) as FinanceSettings[K])); if (saved) draw(); }, t(ctx, "删除", "Delete"))); remove.classList.add("is-danger"); row.append(remove); group.append(row, confirmation);
    }
    if (!list.length) moduleEmpty(ctx, group, t(ctx, "还没有配置", "No settings yet")); moduleNavigationRow(ctx, group, t(ctx, "新增", "Add"), "", () => v.push(edit()));
  };
  const edit = (index?: number) => {
    const list = structuredClone(ctx.host.settings().lifestyle.finance[kind]), old = index === undefined ? undefined : list[index], base = old as { name: string; aliases?: string[]; iconId?: string; defaultCategory?: string; icon?: string; color?: string; active: boolean } | undefined;
    const definitions: ModuleFormField[] = [{ key: "name", label: t(ctx, "名称", "Name"), value: base?.name ?? "" }, { key: "active", label: t(ctx, "启用", "Enabled"), value: base?.active === false ? "no" : "yes", checkbox: true }];
    if (kind !== "categories") definitions.push({ key: "aliases", label: t(ctx, "别名（逗号分隔）", "Aliases (comma separated)"), value: base?.aliases?.join(", ") ?? "" });
    if (kind === "merchants") definitions.push(iconField(ctx, "iconId", base?.iconId ?? "auto", "merchant"), { key: "defaultCategory", label: t(ctx, "默认分类", "Default category"), value: base?.defaultCategory ?? "", options: [["", "—"], ...option(categories(ctx))] });
    if (kind === "categories") definitions.push(iconField(ctx, "icon", base?.icon ?? "package", "category"), { key: "color", label: t(ctx, "颜色", "Color"), value: base?.color ?? "", type: "color" });
    return createModuleForm(ctx, `ipad-finance-catalog-edit-${kind}-${index ?? "new"}`, labels[kind], definitions, async values => {
      const next = { ...old, name: values.name, active: values.active === "yes", ...(kind !== "categories" ? { aliases: values.aliases.split(/[,，]/u).map(value => value.trim()).filter(Boolean) } : { icon: values.icon, color: values.color }), ...(kind === "merchants" ? { iconId: values.iconId, defaultCategory: values.defaultCategory } : {}) };
      if (JSON.stringify(ctx.host.settings().lifestyle.finance[kind]) !== JSON.stringify(list)) throw new Error(t(ctx, "配置已变化，请返回后重新打开；输入已保留。", "Settings changed. Return and reopen; your draft is retained."));
      const updated = [...list]; if (index === undefined) updated.push(next); else updated[index] = next; await service.saveCatalog(kind, updated as FinanceSettings[K]); draw();
    });
  };
  draw(); return v.finish();
}
