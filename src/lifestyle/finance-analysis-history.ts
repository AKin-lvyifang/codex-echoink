import type { FinanceBudget, FinanceContinuousGoal, FinanceEntry, LifeReport } from "./store";
import { effectiveFinanceEntries, localDate, money } from "./finance-domain";
import { financeGoalProgress } from "./finance-goals";

export const financeAnalysisLabel = (value: string): string => value.replace(/\p{Cc}/gu, " ")
  .replace(/(?:\d[ -]?){12,}/gu, "[编号]").replace(/\s+/gu, " ").trim().slice(0, 60);
export const financeAnalysisRows = (rows: readonly FinanceEntry[]) => rows.map(row => ({ 日期: row.date,
  交易方向: { income: "收入", expense: "支出", refund: "退款", transfer: "转账（不计收支）" }[row.kind],
  商户: financeAnalysisLabel(row.merchant), 分类: financeAnalysisLabel(row.category), 账户: financeAnalysisLabel(row.account),
  人民币金额: money(row.amountCents), 消费说明: financeAnalysisLabel(row.description) }));

export function financeCategoryBudgetFacts(rows: readonly FinanceEntry[], budget: FinanceBudget | null) {
  const amounts = new Map<string, number>();
  for (const row of rows) if (row.kind === "expense" || row.kind === "refund")
    amounts.set(row.category, (amounts.get(row.category) ?? 0) + (row.kind === "expense" ? row.amountCents : -row.amountCents));
  return [...new Set([...Object.keys(budget?.allocations ?? {}), ...amounts.keys()])].map(name => {
    const configured = !!budget && Object.hasOwn(budget.allocations, name);
    const allocation = configured ? budget!.allocations[name] : null, net = amounts.get(name) ?? 0;
    return { 分类: financeAnalysisLabel(name || "未分类"), 净支出分: net, 额度分: allocation,
      超额分: allocation === null ? null : Math.max(0, net - allocation),
      状态: allocation === null ? "未设额度" : net > allocation ? "超支" : allocation > 0 && net >= allocation * .9 ? "接近额度" : "额度内" };
  });
}

export interface FinanceAnalysisHistoryOptions {
  goals?: readonly FinanceContinuousGoal[];
  budgetSource?: "month-override" | "current-default";
  nextBudget?: FinanceBudget | null;
  nextBudgetSource?: "month-override" | "current-default";
  previousReports?: readonly { report: LifeReport; input?: string }[];
}
const lastDay = (month: string) => { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); };
export const nextFinanceAnalysisMonth = (month: string) => { const [y,m]=month.split("-").map(Number); return localDate(new Date(y,m,1)).slice(0,7); };
const previousMonth = (month: string) => { const [y, m] = month.split("-").map(Number); return localDate(new Date(y, m - 2, 1)).slice(0, 7); };
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
export function financeAnalysisPeriod(month: string, asOf: string) {
  const days = month > asOf.slice(0, 7) ? 0 : month === asOf.slice(0, 7) ? Number(asOf.slice(8, 10)) : lastDay(month);
  return { 月份: month, 起日: `${month}-01`, 止日: days ? `${month}-${String(days).padStart(2, "0")}` : null,
    天数: days, 月天数: lastDay(month), 覆盖: "unknown" };
}
const summary = (rows: readonly FinanceEntry[]) => {
  const total = (kind: FinanceEntry["kind"]) => rows.filter(r => r.kind === kind).reduce((n, r) => n + r.amountCents, 0);
  const income = total("income"), gross = total("expense"), refund = total("refund");
  return { 收入元: income/100, 收入记录缺失: !rows.some(r => r.kind === "income"), 支出原额元: gross/100, 退款元: refund/100,
    净支出元: (gross-refund)/100, 收支差额元: (income-gross+refund)/100, 结余率: income ? (income - gross + refund) / income : null,
    有效收支笔数: rows.filter(r => r.kind !== "transfer").length };
};
export function buildFinanceAnalysisHistory(month: string, ledger: readonly FinanceEntry[], asOf: string,
  options: FinanceAnalysisHistoryOptions) {
  const current = financeAnalysisPeriod(month, asOf), previous = previousMonth(month);
  const nextMonth=nextFinanceAnalysisMonth(month),nextDays=lastDay(nextMonth),nextBudget=options.nextBudget;
  const nextPlanning={月份:nextMonth,月天数:nextDays,预算已配置:!!nextBudget,
    预算:nextBudget ? {额度元:nextBudget.totalCents/100,
      分类额度元:Object.fromEntries(Object.entries(nextBudget.allocations).map(([name,value])=>[financeAnalysisLabel(name),value/100])),
      日均预算参考元:nextBudget.totalCents/100/nextDays,
      规则来源:options.nextBudgetSource==="month-override" ? "下月独立预算" : "当前每月默认预算适用于下月"} : null,
    说明:nextBudget ? "下月从该月新额度开始，本月已用金额不结转。" : "下月预算未知；若沿用本月额度，仅作为条件情景，不代表实际已设置。"};
  const previousDays = month === asOf.slice(0, 7) && current.天数 < current.月天数
    ? Math.min(current.天数, lastDay(previous)) : lastDay(previous);
  const comparable = { ...financeAnalysisPeriod(previous, asOf), 天数: previousDays,
    止日: previousDays ? `${previous}-${String(previousDays).padStart(2, "0")}` : null };
  const previousRows = effectiveFinanceEntries(ledger, previous, comparable.止日 ?? `${previous}-00`);
  const recordedMonths = [...new Set(effectiveFinanceEntries(ledger, "", asOf).filter(r => r.kind !== "transfer")
    .map(r => r.date.slice(0, 7)).filter(m => m < month))].sort().slice(-3);
  const months = recordedMonths.map((m,index) => {
    const rows = effectiveFinanceEntries(ledger, m, asOf);
    return { ...financeAnalysisPeriod(m, asOf), 距上一已有历史月月数:index?monthIndex(m)-monthIndex(recordedMonths[index-1]):null, 距本月月数: monthIndex(month) - monthIndex(m),
      汇总: summary(rows), 原始相关账目: financeAnalysisRows(rows) };
  });
  const missing: string[] = [];
  for (let m = previous; recordedMonths.length && m >= recordedMonths[0]; m = previousMonth(m))
    if (!recordedMonths.includes(m)) missing.push(m);
  const end = current.止日 ?? `${month}-01`;
  const goals = (options.goals ?? []).map(goal => {
    const progress = financeGoalProgress(goal, ledger, end);
    return { 名称: financeAnalysisLabel(goal.name), 指标: goal.metric, 分类: financeAnalysisLabel(goal.category),
      周期: goal.period, 目标值: goal.target/100, 单位: ["savings-rate", "category-share"].includes(goal.metric) ? "%" : "人民币元",
      适用起日: progress.start, 适用止日: progress.end, 实际截至: end, 实际值: progress.actual===null?null:progress.actual/100,
      规则来源: "当前持续目标回算，不能证明当时已设目标" };
  });
  const reports = (options.previousReports ?? []).map(({ report, input }) => {
    let saved: Record<string, unknown> = {};
    try { const value = JSON.parse(input ?? "{}"); if (value && typeof value === "object") saved = value; } catch { /* Legacy reports lack inputs. */ }
    return { 分析ID: report.id, 月份: report.period, 生成时间: report.createdAt, Skill版本: report.promptVersion,
      旧模型解释非原始事实: true, 完整报告: report.financeSnapshot ?? report.text,
      当时资料: { 统计范围: saved.统计范围 ?? null, 基础统计: saved.基础统计 ?? null,
        有效交易明细: saved.有效交易明细 ?? null, 完整分类预算: saved.完整分类预算 ?? null, 持续目标: saved.持续目标 ?? null } };
  });
  const currentRows=effectiveFinanceEntries(ledger,month,current.止日??`${month}-00`);
  const currentSummary=summary(currentRows),previousSummary=summary(previousRows);
  const categoryNet=(rows:readonly FinanceEntry[])=>{
    const net=new Map<string,number>();
    for(const row of rows) if(row.kind==="expense" || row.kind==="refund") net.set(row.category,(net.get(row.category)??0)+(row.kind==="expense"?row.amountCents:-row.amountCents));
    return net;
  };
  const nowCategories=categoryNet(currentRows),beforeCategories=categoryNet(previousRows);
  const hasCurrentRecords=currentSummary.有效收支笔数>0,hasPreviousRecords=previousSummary.有效收支笔数>0;
  const comparableRecords=hasCurrentRecords && hasPreviousRecords && current.天数>0 && previousDays>0;
  const currentDaily=comparableRecords?currentSummary.净支出元/current.天数:null;
  const previousDaily=comparableRecords?previousSummary.净支出元/previousDays:null;
  const changes=comparableRecords ? { 当前:currentSummary, 前月:previousSummary,
    净支出变化元:Math.round((currentSummary.净支出元-previousSummary.净支出元)*100)/100,
    收入变化元:Math.round((currentSummary.收入元-previousSummary.收入元)*100)/100,
    收支差额变化元:Math.round((currentSummary.收支差额元-previousSummary.收支差额元)*100)/100,
    当前每日记录净支出元:currentDaily,
    前月每日记录净支出元:previousDaily,
    每日记录净支出变化元:currentDaily!-previousDaily!,
    分类变化:[...new Set([...nowCategories.keys(),...beforeCategories.keys()])].map(name=>{
      const now=(nowCategories.get(name)??0)/100,before=(beforeCategories.get(name)??0)/100;
      const nowDaily=now/current.天数,beforeDaily=before/previousDays;
      return {分类:financeAnalysisLabel(name),当前净支出元:now,前月净支出元:before,
        变化元:((nowCategories.get(name)??0)-(beforeCategories.get(name)??0))/100,
        当前每日记录净支出元:nowDaily,前月每日记录净支出元:beforeDaily,
        每日记录净支出变化贡献元:nowDaily-beforeDaily,
        当前该类有记录:nowCategories.has(name),前月该类有记录:beforeCategories.has(name),
        当前覆盖:current.覆盖,前月覆盖:comparable.覆盖};
    }),
    说明:"总额变化与日均变化是不同口径；日均分别除以两边可比范围天数，各分类日均变化贡献合计为总日均变化。仅为范围内已记录金额的变化，完整性未知；分类无记录时的0仅用于核算，不代表真实消费为0。记录变化不自动证明行为因果，不能单凭金额差异断言消费习惯改善。" } : null;
  return { 下一统计月份:nextPlanning, 确定计算的前后变化:changes, 统计范围: current, 上个自然月可比: { 当前范围: current, 历史范围: comparable, 缺少记录: !hasPreviousRecords,
    汇总: hasPreviousRecords ? previousSummary : null, 相关账目引用:hasPreviousRecords?{历史月份:previous,字段:"最近三个已有历史月.原始相关账目",筛选起日:comparable.起日,筛选止日:comparable.止日}:null },
    最近三个已有历史月: months, 历史月份连续:recordedMonths.length>=2?recordedMonths.every((m,i)=>!i||monthIndex(m)-monthIndex(recordedMonths[i-1])===1):null, 缺月: missing, 持续目标: goals, 前次成功报告: reports,
    比较边界: "记录完整性均未知；缺记录不等于零消费，非相邻月份不称连续。日数不同应按日均等可比口径。补账、修正分类用途、收入变化及预算/目标调整不证明消费习惯改善。" };
}
