import type { FinanceBudget, FinanceEntry } from "./store";
import { money } from "./finance-domain";
import { financeAnalysisLabel, nextFinanceAnalysisMonth, type FinanceAnalysisHistoryOptions } from "./finance-analysis-history";

export interface FinanceAnalysisPurposeGroup {
  category: string; description: string; amountCents: number; count: number;
  merchants: Set<string>; dates: Set<string>; prices: Set<number>;
}
/** The same exact category/nonempty description grouping feeds accumulation and conditional choices. */
export function financeAnalysisPurposeGroups(rows: readonly FinanceEntry[]): FinanceAnalysisPurposeGroup[] {
  const groups = new Map<string, FinanceAnalysisPurposeGroup>();
  for (const row of rows) {
    if (row.kind !== "expense" || !row.description.trim()) continue;
    const description = row.description.trim(), key = JSON.stringify([row.category, description]);
    const group = groups.get(key) ?? { category: row.category, description, amountCents: 0, count: 0,
      merchants: new Set<string>(), dates: new Set<string>(), prices: new Set<number>() };
    group.amountCents += row.amountCents; group.count++; group.prices.add(row.amountCents);
    group.merchants.add(row.merchant.trim()); group.dates.add(row.date.slice(0, 10)); groups.set(key, group);
  }
  return [...groups.values()];
}
interface PurposeChoice {
  消费说明: string; 本期用途金额元: number; 本期其余金额元: number;
  保留用途后其余上限元: number | null; 保留其余后用途上限元: number | null;
  用途单价元: number | null; 同价次数上限: number | null;
  需减少同价次数: number | null; 减少同价金额元: number | null;
  引用: { 保留用途: string; 保留其余: string; 同价次数?: string };
}
interface AdjustmentScenario {
  分类: string; 目标月份: string; 条件: string; 本期净支出元: number;
  本期分类额度元: number; 情景分类额度元: number; 需减少或增加额度元: number;
  未分配余量元: number | null; 单独调拨后余量元: number | null;
  引用: { 总额: string; 单独调拨?: string }; 用途取舍: PurposeChoice[];
}
const yuan = (cents: number) => `¥ ${money(cents)}`;

/** Narrow arithmetic support for overspent categories, not a judgement or recommendation engine. */
export function financeAnalysisAdjustmentScenarios(month: string, rows: readonly FinanceEntry[], budget: FinanceBudget | null,
  groups: readonly FinanceAnalysisPurposeGroup[], options: FinanceAnalysisHistoryOptions = {}) {
  const scenarios: AdjustmentScenario[] = [], facts: Record<string, string> = {};
  const nextMonth = nextFinanceAnalysisMonth(month);
  for (const [category, allocation] of Object.entries(budget?.allocations ?? {})) {
    const categoryRows = rows.filter(row => row.category === category);
    const net = categoryRows.reduce((total, row) => total + (row.kind === "expense" ? row.amountCents : row.kind === "refund" ? -row.amountCents : 0), 0);
    if (net <= allocation) continue;
    const label = financeAnalysisLabel(category);
    const configured = !!options.nextBudget && Object.hasOwn(options.nextBudget.allocations, category);
    const limit = configured ? options.nextBudget!.allocations[category] : allocation;
    const source = configured ? `${nextMonth}${options.nextBudgetSource === "month-override" ? "独立预算" : "当前默认预算"}的${label}额度`
      : `若${nextMonth}沿用本月${label}额度`;
    const condition = `${source} ${yuan(limit)}，以本期该分类已记录金额作对照；本月已用金额不结转`;
    const difference = Math.max(0, net - limit), key = `adjustment_${scenarios.length}`;
    const reference: AdjustmentScenario["引用"] = { 总额: `${key}_total` };
    facts[reference.总额] = difference > 0
      ? `${condition}。保留本期净支出 ${yuan(net)} 需要额度 ${yuan(net)}，比 ${yuan(limit)} 增加 ${yuan(difference)}；保持额度 ${yuan(limit)} 则需减少 ${yuan(difference)}，不能同时保留本期全部消费金额。`
      : `${condition}。本期净支出 ${yuan(net)} 已可由该情景额度覆盖，不需增额或减支，剩余 ${yuan(limit - net)}；这不代表本期超支事实改变。`;
    // A missing category in a real next-month plan has no reliable combined allocation baseline.
    const poolBudget = configured ? options.nextBudget! : !options.nextBudget ? budget : null;
    const available = poolBudget ? poolBudget.totalCents - Object.values(poolBudget.allocations).reduce((total, value) => total + value, 0) : null;
    const canReallocate = difference > 0 && available !== null && available >= difference;
    if (canReallocate) {
      reference.单独调拨 = `${key}_reallocation`;
      const poolSource = configured ? `${nextMonth}已配置预算` : `若${nextMonth}沿用本月总预算与全部分类额度`;
      facts[reference.单独调拨] = `${poolSource}的未分配余量为 ${yuan(available!)}。若单独给${label}增加 ${yuan(difference)}，额度为 ${yuan(net)}，公共余量剩 ${yuan(available! - difference)}。这是独立替代选择，不能与其他调拨同时各用原始余量。`;
    }
    const choices: PurposeChoice[] = [];
    if (difference > 0 && !categoryRows.some(row => row.kind === "refund")) {
      let categoryGroups = groups.filter(group => group.category === category && group.amountCents > 0);
      // Two complementary groups have the same pair of choices; describe it once without assigning purpose roles.
      if (categoryGroups.length === 2 && categoryGroups.reduce((total, group) => total + group.amountCents, 0) === net)
        categoryGroups = [categoryGroups.slice().sort((a, b) => a.count - b.count || b.amountCents - a.amountCents)[0]];
      for (const group of categoryGroups) {
        const other = net - group.amountCents;
        if (other < 0) continue;
        const name = financeAnalysisLabel(group.description), prefix = `${key}_purpose_${choices.length}`;
        const keepUse = limit - group.amountCents, keepOther = limit - other;
        const references: PurposeChoice["引用"] = { 保留用途: `${prefix}_keep_use`, 保留其余: `${prefix}_keep_other` };
        facts[references.保留用途] = keepUse >= 0
          ? `${condition}。保留“${name}”本期 ${yuan(group.amountCents)} 后，该分类其余消费最多 ${yuan(keepUse)}；相比本期其余 ${yuan(other)} 需减少 ${yuan(Math.max(0, other - keepUse))}。合计 ${yuan(group.amountCents)} + ${yuan(keepUse)} = ${yuan(limit)}。`
          : `${condition}。仅保留“${name}”本期 ${yuan(group.amountCents)} 就超过额度 ${yuan(-keepUse)}，无法在此额度内同时保留该用途和其余消费；需调整用途金额或额度。`;
        facts[references.保留其余] = keepOther >= 0
          ? `${condition}。保留其余消费本期 ${yuan(other)} 后，“${name}”最多 ${yuan(keepOther)}；相比本期该用途 ${yuan(group.amountCents)} 需减少 ${yuan(Math.max(0, group.amountCents - keepOther))}。合计 ${yuan(other)} + ${yuan(keepOther)} = ${yuan(limit)}。`
          : `${condition}。仅保留其余消费本期 ${yuan(other)} 就超过额度 ${yuan(-keepOther)}，不能为“${name}”保留可花金额；需调整其余消费或额度。`;
        const price = group.prices.size === 1 ? [...group.prices][0] : null;
        const count = price !== null && price > 0 && keepOther >= 0 ? Math.floor(keepOther / price) : null;
        const removed = count === null ? null : Math.max(0, group.count - count);
        if (count !== null) {
          references.同价次数 = `${prefix}_count`;
          facts[references.同价次数] = `${condition}。若“${name}”继续按本期每笔 ${yuan(price!)}，并保留其余消费 ${yuan(other)}，该用途可用 ${yuan(keepOther)}，最多 ${count} 笔；本期 ${group.count} 笔需减少 ${removed} 笔、${yuan(removed! * price!)}。此次数上限按该相同单价计算，是金额取舍的另一种选择。`;
        }
        choices.push({ 消费说明: name, 本期用途金额元: group.amountCents / 100, 本期其余金额元: other / 100,
          保留用途后其余上限元: keepUse >= 0 ? keepUse / 100 : null, 保留其余后用途上限元: keepOther >= 0 ? keepOther / 100 : null,
          用途单价元: price === null ? null : price / 100, 同价次数上限: count, 需减少同价次数: removed,
          减少同价金额元: removed === null ? null : removed * price! / 100, 引用: references });
      }
    }
    scenarios.push({ 分类: label, 目标月份: nextMonth, 条件: condition, 本期净支出元: net / 100,
      本期分类额度元: allocation / 100, 情景分类额度元: limit / 100, 需减少或增加额度元: difference / 100,
      未分配余量元: available === null ? null : available / 100, 单独调拨后余量元: canReallocate ? (available! - difference) / 100 : null,
      引用: reference, 用途取舍: choices });
  }
  return { scenarios, facts };
}
