import { createHash } from "node:crypto";
import type { FinanceBudget, FinanceEntry } from "./store";
import { effectiveFinanceEntries, financeSpendingFacts, localDate, money } from "./finance-domain";

export type FinanceChartId = "daily" | "large" | "budget" | "category" | "merchant" | "flow";
export interface FinanceChartPoint { label: string; valueCents: number; comparisonCents?: number }
export interface FinanceDailyWeek { number: number; start: string; end: string; totalCents: number; points: FinanceChartPoint[] }
/** Calendar days are already ordered from day one; the final group may be shorter. */
export function financeDailyWeeks(points: readonly FinanceChartPoint[]): FinanceDailyWeek[] {
  const weeks: FinanceDailyWeek[] = [];
  for (let start = 0; start < points.length; start += 7) {
    const group = points.slice(start, start + 7);
    weeks.push({ number: weeks.length + 1, start: group[0].label, end: group[group.length - 1].label,
      totalCents: group.reduce((total, point) => total + point.valueCents, 0), points: group });
  }
  return weeks;
}
export interface FinanceChartSnapshot { id: FinanceChartId; title: string; points: FinanceChartPoint[]; explanation: string }
export interface FinanceTableSnapshot { id: "category" | "merchant" | "budget"; title: string; headers: string[]; rows: string[][] }
export type FinanceReportBlock =
  | { type: "text"; markdown: string }
  | { type: "highlight"; tone: "fact" | "notice" | "positive"; markdown: string }
  | { type: "chart"; chart: FinanceChartSnapshot }
  | { type: "table"; table: FinanceTableSnapshot; explanation: string }
  | { type: "actions"; items: string[] };
export interface FinanceReportSection { title: string; blocks: FinanceReportBlock[] }
export interface FinanceReportSnapshot { version?: 8; sections?: FinanceReportSection[]; conclusion: string; charts: FinanceChartSnapshot[]; suggestions: string[]; omittedSuggestionCount: number; detail: string; facts: Record<string, string> }
export interface FinanceAnalysisInput {
  text: string; fingerprint: string; entryCount: number;
  facts: Record<string, string>; candidates: Omit<FinanceChartSnapshot, "explanation">[]; tables: FinanceTableSnapshot[];
}

export type FinanceAnalysisErrorCode = "invalid-json" | "invalid-structure" | "unknown-reference" | "too-long" | "invalid-chart";
const validationMessages: Record<FinanceAnalysisErrorCode, string> = {
  "invalid-json": "分析内容未能完整生成，请重试",
  "invalid-structure": "分析内容暂时无法显示，请重试",
  "unknown-reference": "分析中的部分内容未能完整生成，请重试",
  "too-long": "分析内容过长，暂时无法显示，请重试",
  "invalid-chart": "分析图表暂时无法显示，请重试"
};
export class FinanceAnalysisValidationError extends Error {
  constructor(readonly code: FinanceAnalysisErrorCode) { super(validationMessages[code]); this.name = "FinanceAnalysisValidationError"; }
}
function invalid(code: FinanceAnalysisErrorCode): never { throw new FinanceAnalysisValidationError(code); }

const safeLabel = (value: string): string => value.replace(/\p{Cc}/gu, " ")
  .replace(/(?:\d[ -]?){12,}/gu, "[编号]").replace(/\s+/gu, " ").trim().slice(0, 60);
const sum = (rows: readonly FinanceEntry[]): number => rows.reduce((total, row) => total + row.amountCents, 0);

/** Prepare recorded transactions, deterministic statistics and display candidates for the model. */
export function buildFinanceAnalysisInput(month: string, ledger: readonly FinanceEntry[], budget: FinanceBudget | null,
  asOfDate = localDate()): FinanceAnalysisInput {
  const valid = effectiveFinanceEntries(ledger, month, asOfDate);
  const facts = financeSpendingFacts(ledger, month, asOfDate);
  const incomeCents = sum(valid.filter((row) => row.kind === "income"));
  const refundCents = facts.refundsCents;
  const netCents = facts.grossCents - refundCents;
  const dates = valid.map((row) => row.date.slice(0, 10)).sort();
  const refs: Record<string, string> = {
    month: month.replace("-", " 年 ") + " 月",
    range: dates.length ? `${dates[0]} 至 ${dates.at(-1)}` : "本月暂无记录",
    income: `¥ ${money(incomeCents)}`,
    gross: `¥ ${money(facts.grossCents)}`,
    refunds: `¥ ${money(refundCents)}`,
    net: `¥ ${money(netCents)}`,
    difference: `¥ ${money(incomeCents - netCents)}`,
    expense_count: `${facts.expenses.length} 笔`,
    account_count: `${new Set(valid.map((row) => row.account.trim()).filter(Boolean)).size} 个已记录账户`
  };
  if (budget) {
    const allocatedCents = Object.values(budget.allocations).reduce((total, cents) => total + cents, 0);
    refs.budget_total = `¥ ${money(budget.totalCents)}`;
    refs.budget_remaining = `¥ ${money(budget.totalCents - netCents)}`;
    refs.budget_allocated = `¥ ${money(allocatedCents)}`;
    refs.budget_unallocated = `¥ ${money(budget.totalCents - allocatedCents)}`;
    refs.budget_allocation_state = !Object.keys(budget.allocations).length ? "尚未设置分类额度"
      : allocatedCents === 0 ? "全部分类额度均为 ¥ 0.00" : "已有非零分类额度";
  }
  const candidates: FinanceAnalysisInput["candidates"] = [];
  if (facts.days.size) {
    const [year, number] = month.split("-").map(Number);
    const end = month === asOfDate.slice(0, 7) ? Number(asOfDate.slice(8, 10)) : new Date(year, number, 0).getDate();
    const daily = Array.from({ length: end }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      return [date, facts.days.get(date) ?? { amountCents: 0, count: 0 }] as const;
    });
    const peak = daily.reduce((best, item) => item[1].amountCents > best[1].amountCents ? item : best);
    refs.daily_peak = `${peak[0]} 的 ¥ ${money(peak[1].amountCents)}`;
    candidates.push({ id: "daily", title: "每日支出节奏", points: daily.map(([date, value]) => {
      const day = date.slice(8);
      refs[`daily_${day}_date`] = date;
      refs[`daily_${day}_amount`] = `¥ ${money(value.amountCents)}`;
      return { label: date.slice(5), valueCents: value.amountCents };
    }) });
    for (const week of financeDailyWeeks(candidates.at(-1)!.points)) {
      refs[`week_${week.number}_name`] = `第 ${week.number} 周`;
      refs[`week_${week.number}_range`] = `${month.slice(0, 4)}-${week.start} 至 ${month.slice(0, 4)}-${week.end}`;
      refs[`week_${week.number}_total`] = `¥ ${money(week.totalCents)}`;
    }
  }
  const largeThresholdCents = 20_000;
  const large = facts.expenses.filter((row) => row.amountCents >= largeThresholdCents);
  if (large.length) {
    refs.large_threshold = `¥ ${money(largeThresholdCents)}`;
    refs.large_count = `${large.length} 笔`;
    refs.large_total = `¥ ${money(sum(large))}`;
    refs.large_share = `${(sum(large) / facts.grossCents * 100).toFixed(1)}%`;
    candidates.push({ id: "large", title: "大额消费贡献", points: [
      { label: `单笔 ≥${money(largeThresholdCents)} 元`, valueCents: sum(large) },
      { label: "其余消费", valueCents: facts.grossCents - sum(large) }
    ] });
  }
  if (budget && Object.keys(budget.allocations).length && facts.expenses.length) {
    const categoryNet = new Map<string, number>();
    for (const row of valid) {
      if (row.kind !== "expense" && row.kind !== "refund") continue;
      categoryNet.set(row.category, (categoryNet.get(row.category) ?? 0) + (row.kind === "expense" ? row.amountCents : -row.amountCents));
    }
    const names = [...new Set([...Object.keys(budget.allocations), ...categoryNet.keys()])];
    const ranked = names.map((name) => ({ label: safeLabel(name), valueCents: categoryNet.get(name) ?? 0,
      comparisonCents: budget.allocations[name] ?? 0 }))
      .sort((a, b) => Math.max(Math.abs(b.valueCents), b.comparisonCents) - Math.max(Math.abs(a.valueCents), a.comparisonCents));
    const points = ranked.slice(0, 5);
    if (ranked.length > 5) points.push({ label: "其他分类（合并）", valueCents: ranked.slice(5).reduce((total, point) => total + point.valueCents, 0),
      comparisonCents: ranked.slice(5).reduce((total, point) => total + point.comparisonCents, 0) });
    refs.budget_note = "分类实际为消费减退款；负值表示当月该类退款超过消费";
    candidates.push({ id: "budget", title: "分类预算与实际", points });
  }
  const category = facts.categories.slice(0, 12).map(([name, value], index) => {
    const item = { 分类: safeLabel(name || "未分类"), 金额: `¥ ${money(value.amountCents)}`,
      占支出原额: `${(value.amountCents / facts.grossCents * 100).toFixed(1)}%`, 笔数: value.count };
    refs[`category_${index + 1}`] = `${item.分类} ${item.金额}、${item.占支出原额}、${item.笔数} 笔`;
    refs[`category_${index + 1}_name`] = item.分类;
    refs[`category_${index + 1}_amount`] = item.金额;
    refs[`category_${index + 1}_share`] = item.占支出原额;
    refs[`category_${index + 1}_count`] = `${item.笔数} 笔`;
    return item;
  });
  const merchantMap = new Map<string, { amountCents: number; count: number; descriptions: string[]; categories: Map<string, number> }>();
  for (const row of facts.expenses) {
    const name = safeLabel(row.merchant) || "未命名商户";
    const item = merchantMap.get(name) ?? { amountCents: 0, count: 0, descriptions: [], categories: new Map<string, number>() };
    item.amountCents += row.amountCents; item.count++;
    const categoryName = safeLabel(row.category) || "未分类";
    item.categories.set(categoryName, (item.categories.get(categoryName) ?? 0) + 1);
    const description = safeLabel(row.description);
    if (description && !item.descriptions.includes(description) && item.descriptions.length < 2) item.descriptions.push(description);
    merchantMap.set(name, item);
  }
  const merchants = [...merchantMap].sort((a, b) => b[1].amountCents - a[1].amountCents).slice(0, 8)
    .map(([name, value], index) => {
      const item = { 商户: name, 金额: `¥ ${money(value.amountCents)}`,
        占支出原额: `${(value.amountCents / facts.grossCents * 100).toFixed(1)}%`, 笔数: value.count, 用途样本: value.descriptions };
      refs[`merchant_${index + 1}`] = `${item.商户} ${item.金额}、${item.占支出原额}、${item.笔数} 笔`;
      refs[`merchant_${index + 1}_name`] = item.商户;
      refs[`merchant_${index + 1}_amount`] = item.金额;
      refs[`merchant_${index + 1}_share`] = item.占支出原额;
      refs[`merchant_${index + 1}_count`] = `${item.笔数} 笔`;
      return item;
    });
  const frequentMerchants = [...merchantMap].filter(([, value]) => value.count > 1)
    .sort((a, b) => b[1].count - a[1].count || b[1].amountCents - a[1].amountCents).slice(0, 5)
    .map(([name, value], index) => {
      const key = `frequent_${index + 1}`;
      refs[`${key}_name`] = name;
      refs[`${key}_count`] = `${value.count} 笔`;
      refs[`${key}_amount`] = `¥ ${money(value.amountCents)}`;
      const rankedCategories = [...value.categories].sort((a, b) => b[1] - a[1]);
      const shownCategories = rankedCategories.slice(0, 3).map(([categoryName, count]) => `${categoryName} ${count} 笔`);
      const remainingCount = rankedCategories.slice(3).reduce((total, [, count]) => total + count, 0);
      if (remainingCount) shownCategories.push(`其余分类合计 ${remainingCount} 笔`);
      refs[`${key}_categories`] = shownCategories.join("；");
      return { 商户: name, 笔数: value.count, 金额: `¥ ${money(value.amountCents)}`, 用途样本: value.descriptions,
        已有分类与笔数: refs[`${key}_categories`] };
    });
  if (category.length) candidates.push({ id: "category", title: "主要分类支出排名（已列样本）", points: category.slice(0, 6).map((item) =>
    ({ label: item.分类, valueCents: Math.round(Number(item.金额.replace(/[^\d.]/gu, "")) * 100) })) });
  if (merchants.length) candidates.push({ id: "merchant", title: "主要商户支出排名（已列样本）", points: merchants.slice(0, 6).map((item) =>
    ({ label: item.商户, valueCents: Math.round(Number(item.金额.replace(/[^\d.]/gu, "")) * 100) })) });
  if (incomeCents || facts.grossCents || refundCents) candidates.push({ id: "flow", title: "收入、支出和退款如何影响差额", points: [
    { label: "收入", valueCents: incomeCents }, { label: "支出原额", valueCents: -facts.grossCents },
    { label: "退款", valueCents: refundCents }, { label: "收支差额", valueCents: incomeCents - netCents }
  ] });
  const tables: FinanceTableSnapshot[] = [];
  if (category.length) tables.push({ id: "category", title: "分类支出核对", headers: ["分类", "支出原额", "占比", "笔数"],
    rows: category.map((item) => [item.分类, item.金额, item.占支出原额, `${item.笔数}`]) });
  if (merchants.length) tables.push({ id: "merchant", title: "商户支出核对", headers: ["商户", "支出原额", "占比", "笔数"],
    rows: merchants.map((item) => [item.商户, item.金额, item.占支出原额, `${item.笔数}`]) });
  const budgetChart = candidates.find((item) => item.id === "budget");
  if (budgetChart) tables.push({ id: "budget", title: "分类预算核对", headers: ["分类", "净支出", "预算"], rows: budgetChart.points.map((point) =>
    [point.label, `¥ ${money(point.valueCents)}`, `¥ ${money(point.comparisonCents ?? 0)}`]) });
  const highest = facts.expenses.slice().sort((a, b) => b.amountCents - a.amountCents || a.date.localeCompare(b.date)).slice(0, 8)
    .map((row, index) => {
      const item = { 日期: row.date.slice(0, 10), 商户: safeLabel(row.merchant), 分类: safeLabel(row.category),
        金额: `¥ ${money(row.amountCents)}`, 用途: safeLabel(row.description) };
      refs[`expense_${index + 1}`] = `${item.日期} ${item.商户} ${item.金额}`;
      return item;
    });
  const input = {
    月份: refs.month, 已记录日期: refs.range, 资料边界: "只代表此账本已记录的已完成人民币交易；不能判断全部账户或完整月份。",
    排除记录: {
      失败: ledger.filter((row) => row.date.startsWith(month) && row.status !== "completed").length,
      外币: ledger.filter((row) => row.date.startsWith(month) && row.status === "completed" && row.currency !== "CNY").length,
      未来: ledger.filter((row) => row.date.startsWith(month) && row.date.slice(0, 10) > asOfDate).length
    },
    基础统计: refs,
    有效交易明细: valid.map((row) => ({ 日期: row.date, 交易方向: { income: "收入", expense: "支出", refund: "退款", transfer: "转账（不计收支）" }[row.kind],
      商户: safeLabel(row.merchant), 分类: safeLabel(row.category), 账户: safeLabel(row.account),
      人民币金额: money(row.amountCents), 消费说明: safeLabel(row.description) })),
    分类支出原额: category, 其余分类数: Math.max(0, facts.categories.length - 12),
    商户支出: merchants, 其余商户数: Math.max(0, merchantMap.size - 8),
    重复消费候选: frequentMerchants,
    较高单笔样本: highest, 其余单笔数: Math.max(0, facts.expenses.length - 8),
    可选解释图: candidates.map((chart) => ({ id: chart.id, title: chart.title,
      周段: chart.id === "daily" ? financeDailyWeeks(chart.points).map((week) =>
        `第 ${week.number} 周 · ${month.slice(0, 4)}-${week.start} 至 ${month.slice(0, 4)}-${week.end} · 合计 ¥ ${money(week.totalCents)}`) : undefined,
      data: chart.points.map((point) =>
        `${point.label}：实际 ¥ ${money(point.valueCents)}${point.comparisonCents === undefined ? "" : `，预算 ¥ ${money(point.comparisonCents)}`}`) })),
    可选核对表: tables.map((table) => ({ id: table.id, title: table.title, headers: table.headers, rows: table.rows }))
  };
  const text = JSON.stringify(input);
  return { text, fingerprint: createHash("sha256").update(text).digest("hex"), entryCount: valid.filter((row) => row.kind !== "transfer").length,
    facts: refs, candidates, tables };
}

/** Validate the response before it can replace a saved report. */
export function parseFinanceAnalysisResponse(raw: string, input: FinanceAnalysisInput): FinanceReportSnapshot {
  if (raw.length > 20_000) invalid("too-long");
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  const json = fenced ? fenced[1] : trimmed;
  let object: unknown;
  try { object = JSON.parse(json); } catch { invalid("invalid-json"); }
  if (!object || typeof object !== "object" || Array.isArray(object)) invalid("invalid-structure");
  const value = object as Record<string, unknown>;
  const resolve = (field: unknown, markdown = false): string => {
    if (typeof field !== "string" || !field.trim()) invalid("invalid-structure");
    const normalized = field.normalize("NFKC");
    const references = /\{\{([a-z][a-z0-9_]*)\}\}/gu;
    const prose = normalized.replace(references, "引用");
    if (/[{}]/u.test(prose)) invalid("invalid-structure");
    if (/<[^>]*>|```/u.test(prose) || (markdown &&
      /!\[\[|\[\[|!\[[^\]]*\]\(|\[[^\]]+\]\(|\[[^\]]+\]\[[^\]]*\]|^\s*\[[^\]]+\]:|https?:\/\/|obsidian:|^\s*#/mu.test(prose))) invalid("invalid-structure");
    for (const match of normalized.matchAll(references)) if (!Object.hasOwn(input.facts, match[1])) invalid("unknown-reference");
    const referenced = normalized.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gu, (_match, key: string) => {
      const fact = input.facts[key];
      return markdown ? fact.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
        .replace(/([\\`*_{}[\]()#+.!|~-])/gu, "\\$1") : fact;
    });
    return referenced.trim();
  };
  if (value.version === 8) {
    if (Object.keys(value).some((key) => !["version", "sections"].includes(key)) || !Array.isArray(value.sections) ||
      !value.sections.length || value.sections.length > 8) invalid("invalid-structure");
    const usedVisuals = new Set<string>();
    let omittedSuggestionCount = 0;
    const sections: FinanceReportSection[] = value.sections.map((unknownSection) => {
      if (!unknownSection || typeof unknownSection !== "object" || Array.isArray(unknownSection)) invalid("invalid-structure");
      const section = unknownSection as Record<string, unknown>;
      if (Object.keys(section).some((key) => !["title", "blocks"].includes(key)) || !Array.isArray(section.blocks) ||
        !section.blocks.length || section.blocks.length > 12) invalid("invalid-structure");
      const title = resolve(section.title);
      const blocks: FinanceReportBlock[] = section.blocks.map((unknownBlock) => {
        if (!unknownBlock || typeof unknownBlock !== "object" || Array.isArray(unknownBlock)) invalid("invalid-structure");
        const block = unknownBlock as Record<string, unknown>;
        if (block.type === "text" || block.type === "highlight") {
          const allowed = block.type === "text" ? ["type", "markdown"] : ["type", "tone", "markdown"];
          if (Object.keys(block).some((key) => !allowed.includes(key)) ||
            (block.type === "highlight" && !["fact", "notice", "positive"].includes(String(block.tone)))) invalid("invalid-structure");
          const markdown = resolve(block.markdown, true);
          return block.type === "text" ? { type: "text", markdown } : { type: "highlight", tone: block.tone as "fact" | "notice" | "positive", markdown };
        }
        if (block.type === "chart" || block.type === "table") {
          if (Object.keys(block).some((key) => !["type", "id", "explanation"].includes(key)) || typeof block.id !== "string" ||
            usedVisuals.has(`${block.type}:${block.id}`)) invalid(block.type === "chart" ? "invalid-chart" : "invalid-structure");
          usedVisuals.add(`${block.type}:${block.id}`);
          const explanation = resolve(block.explanation, true);
          if (block.type === "chart") {
            const chart = input.candidates.find((candidate) => candidate.id === block.id);
            if (!chart) invalid("invalid-chart");
            return { type: "chart", chart: { ...structuredClone(chart), explanation } };
          }
          const table = input.tables.find((candidate) => candidate.id === block.id);
          if (!table) invalid("invalid-structure");
          return { type: "table", table: structuredClone(table), explanation };
        }
        if (block.type === "actions") {
          if (Object.keys(block).some((key) => !["type", "items"].includes(key)) || !Array.isArray(block.items) ||
            block.items.some((item) => typeof item !== "string")) invalid("invalid-structure");
          const items: string[] = [];
          for (const item of block.items) {
            try { items.push(resolve(item, true)); }
            catch (error) {
              if (error instanceof FinanceAnalysisValidationError && error.code === "unknown-reference")
                omittedSuggestionCount++;
              else throw error;
            }
          }
          return { type: "actions", items };
        }
        invalid("invalid-structure");
      });
      return { title, blocks: blocks.filter((block) => block.type !== "actions" || block.items.length) };
    });
    const first = sections.flatMap((section) => section.blocks).find((block) => block.type === "text" || block.type === "highlight");
    if (!first) invalid("invalid-structure");
    return { version: 8, sections, conclusion: first.markdown, charts: [], suggestions: [], omittedSuggestionCount,
      detail: "", facts: { ...input.facts } };
  }
  if (Object.keys(value).some((key) => !["conclusion", "charts", "suggestions", "detail"].includes(key))) invalid("invalid-structure");
  const conclusion = resolve(value.conclusion);
  if (!Array.isArray(value.charts) || value.charts.length > 2) invalid("invalid-chart");
  const used = new Set<string>();
  const charts = value.charts.map((item): FinanceChartSnapshot => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("invalid-chart");
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["id", "explanation"].includes(key)) || typeof row.id !== "string" || used.has(row.id)) invalid("invalid-chart");
    const chart = input.candidates.find((candidate) => candidate.id === row.id);
    if (!chart) invalid("invalid-chart");
    used.add(row.id);
    return { ...structuredClone(chart), explanation: resolve(row.explanation) };
  });
  if (!Array.isArray(value.suggestions) || value.suggestions.length > 3 || value.suggestions.some((item) => typeof item !== "string"))
    invalid("invalid-structure");
  const suggestions: string[] = [];
  let omittedSuggestionCount = 0;
  for (const item of value.suggestions) {
    try { suggestions.push(resolve(item)); }
    catch (error) {
      if (error instanceof FinanceAnalysisValidationError && error.code === "unknown-reference")
        omittedSuggestionCount++;
      else throw error;
    }
  }
  const detail = value.detail === undefined || value.detail === "" ? "" : resolve(value.detail);
  return { conclusion, charts, suggestions, omittedSuggestionCount, detail, facts: { ...input.facts } };
}
