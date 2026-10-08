import { paidTestAccess } from "./membership-access";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "obsidian";
import { openTestMarkdownRenders } from "./obsidian-shim";
import { buildFinanceAnalysisInput, financeDailyWeeks, parseFinanceAnalysisResponse,
  FinanceAnalysisValidationError, type FinanceAnalysisErrorCode } from "../lifestyle/finance-analysis";
import { FINANCE_ANALYSIS_OUTPUT_PROTOCOL, FINANCE_ANALYSIS_SKILL } from "../harness/resources/finance-analysis-skill";
import type { FinanceSummary } from "../lifestyle/finance-domain";
import { financeGoalProgress, goalPeriod } from "../lifestyle/finance-goals";
import { FINANCE_ANALYSIS_PROMPT_VERSION, LifestyleFinanceService as ProductionFinanceService } from "../lifestyle/finance-service";
import { FinanceWorkspace } from "../lifestyle/finance-view";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import { LifestyleStore, type FinanceEntry } from "../lifestyle/store";
import type { LifestyleService } from "../lifestyle/service";
import { FakeVault } from "./lifestyle-finance-ledger";
import { TestDocument } from "./lifestyle-finance-ui";

const row = (id: string, amountCents: number, kind: FinanceEntry["kind"], category = "餐饮",
  overrides: Partial<FinanceEntry> = {}): FinanceEntry => ({
  id, source: "wechat", sourceId: id, date: "2026-09-20 10:00:00", merchant: "合成商户", category,
  kind, amountCents, status: "completed", account: "零钱", description: "合成说明", currency: "CNY", note: "", ...overrides
});

export async function runLifestyleFinanceAnalysisTests(): Promise<void> {
  const budget = { month: "2026-09", totalCents: 100_000, allocations: { 餐饮: 40_000, 购物: 60_000 } };
  const sample = [row("a", 4_000, "expense"), row("b", 4_000, "expense"), row("c", 12_000, "expense", "购物", { merchant: "另一商户" }),
    row("failed", 99_900, "expense", "购物", { status: "failed" }),
    row("usd", 10_000, "expense", "购物", { currency: "USD" })];
  const input = buildFinanceAnalysisInput("2026-09", sample, budget, "2026-09-21");
  const facts = JSON.parse(input.text) as any;
  assert.equal(input.facts.gross, "¥ 200.00");
  assert.equal(input.facts.net, "¥ 200.00");
  assert.equal(input.facts.budget_remaining, "¥ 800.00");
  assert.equal(input.facts.budget_total, "¥ 1,000.00");
  assert.equal(input.facts.budget_allocated, "¥ 1,000.00");
  assert.equal(input.facts.budget_unallocated, "¥ 0.00");
  assert.equal(input.facts.daily_20_date, "2026-09-20");
  assert.equal(input.facts.daily_20_amount, "¥ 200.00");
  assert.equal(facts.可选解释图.find((chart: { id: string }) => chart.id === "daily").data[19], "09-20：实际 ¥ 200.00");
  const initialWeeks = financeDailyWeeks(input.candidates.find((chart) => chart.id === "daily")!.points);
  assert.deepEqual(initialWeeks.map((week) => [week.start, week.end, week.totalCents]),
    [["09-01", "09-07", 0], ["09-08", "09-14", 0], ["09-15", "09-21", 20_000]]);
  assert.equal(initialWeeks.reduce((total, week) => total + week.totalCents, 0), 20_000);
  assert.equal(input.facts.week_3_total, "¥ 200.00");
  assert.match(input.facts.week_3_range, /2026-09-15 至 2026-09-21/u);
  const currentMonth = buildFinanceAnalysisInput("2026-10", [row("current-day", 250, "expense", "餐饮", { date: "2026-10-02" })], null, "2026-10-03");
  const currentDays = currentMonth.candidates.find((chart) => chart.id === "daily")!.points;
  assert.deepEqual(currentDays.map((point) => [point.label, point.valueCents]),
    [["10-01", 0], ["10-02", 250], ["10-03", 0]], "current month stops at asOfDate and keeps zero days");
  assert.deepEqual(financeDailyWeeks(currentDays).map((week) => [week.start, week.end, week.totalCents]), [["10-01", "10-03", 250]]);
  assert.equal(currentMonth.facts.week_1_total, "¥ 2.50");
  assert.deepEqual(facts.排除记录, { 失败: 1, 外币: 1, 未来: 0 });
  assert.equal(input.entryCount, 3);
  assert.equal(facts.分类支出原额.length, 2);
  assert.equal(facts.商户支出.length, 2);
  assert.equal(facts.较高单笔样本.length, 3);
  assert.match(input.facts.category_1, /¥ 120.00/u);
  assert.match(input.facts.merchant_1, /¥ 120.00/u);
  assert.equal(input.facts.merchant_1_count, "1 笔");
  assert.equal(input.facts.merchant_2_count, "2 笔");
  assert.doesNotMatch(input.text, /coverageCompleteness|recordedBalanceCents|moneyCents/u);
  const completeRows = Array.from({ length: 66 }, (_, index) => row(`private-id-${index}`, index === 65 ? 1 : 1_000, "expense", "餐饮", {
    merchant: `合成商户${index}`, account: "合成账户 1234567890123456", description: `工作餐${index}`, note: "不发送的私人备注"
  })).concat([
    row("private-income", 200_000, "income", "工资"), row("private-refund", 2_000, "refund"), row("private-transfer", 30_000, "transfer"),
    row("excluded-future", 90_000, "expense", "购物", { date: "2026-09-30", merchant: "未来样本" }),
    row("excluded-month", 90_000, "expense", "购物", { date: "2026-08-20", merchant: "上月样本" }),
    row("excluded-failed", 90_000, "expense", "购物", { status: "failed", merchant: "失败样本" }),
    row("excluded-usd", 90_000, "expense", "购物", { currency: "USD", merchant: "外币样本" })
  ]);
  const completeInput = buildFinanceAnalysisInput("2026-09", completeRows, null, "2026-09-21");
  const completeFacts = JSON.parse(completeInput.text);
  assert.equal(completeFacts.有效交易明细.length, 69, "all effective rows are provided, including transfers with an explicit direction");
  assert.equal(completeInput.entryCount, 68, "transfers remain outside income and expense counts");
  assert.deepEqual([completeFacts.基础统计.gross, completeFacts.基础统计.net, completeFacts.基础统计.difference],
    ["¥ 650.01", "¥ 630.01", "¥ 1,369.99"]);
  assert.deepEqual(completeFacts.有效交易明细[65], { 日期: "2026-09-20 10:00:00", 交易方向: "支出", 商户: "合成商户65",
    分类: "餐饮", 账户: "合成账户 [编号]", 人民币金额: "0.01", 消费说明: "工作餐65" });
  assert.ok(!completeFacts.商户支出.some((item: { 商户: string }) => item.商户 === "合成商户65"), "full details include rows omitted by ranked summaries");
  assert.equal(completeFacts.有效交易明细[68].交易方向, "转账（不计收支）");
  assert.doesNotMatch(completeInput.text, /private-id|sourceId|不发送的私人备注|1234567890123456|未来样本|上月样本|失败样本|外币样本/u);
  const refund = [row("expense", 10_000, "expense"), row("refund-a", 15_000, "refund"),
    row("refund-b", 5_000, "refund"), row("income", 8_000, "income"), row("transfer", 50_000, "transfer")];
  const refundInput = buildFinanceAnalysisInput("2026-09", refund, budget, "2026-09-21");
  assert.deepEqual([refundInput.facts.net, refundInput.facts.difference, refundInput.facts.budget_remaining, refundInput.entryCount],
    ["¥ -100.00", "¥ 180.00", "¥ 1,100.00", 4]);
  assert.equal(refundInput.candidates.find((item) => item.id === "budget")?.points.find((item) => item.label === "餐饮")?.valueCents, -10_000);
  const weekGoal = { id: "week", name: "每周消费", metric: "expense", period: "week", category: "", target: 10_000 } as const;
  assert.deepEqual(goalPeriod(weekGoal, "2026-10-01"), { start: "2026-09-28", end: "2026-10-04" });
  const weekRows = [row("monday", 4_000, "expense", "餐饮", { date: "2026-09-28" }),
    row("thursday", 5_000, "expense", "购物", { date: "2026-10-01" }),
    row("future", 9_000, "expense", "餐饮", { date: "2026-10-03" }),
    row("failed-week", 9_000, "expense", "餐饮", { date: "2026-10-01", status: "failed" }),
    row("usd-week", 9_000, "expense", "餐饮", { date: "2026-10-01", currency: "USD" })];
  assert.equal(financeGoalProgress(weekGoal, weekRows, "2026-10-01").actual, 9_000);
  const savingsGoal = { id: "savings", name: "结余率", metric: "savings-rate", period: "month", category: "", target: 2_000 } as const;
  const exactRows = [row("i", 30_000, "income"), row("e", 24_001, "expense")];
  assert.equal(financeGoalProgress(savingsGoal, exactRows, "2026-09-21").status, "pending", "19.9967% must not round up to a 20% success");
  assert.equal(financeGoalProgress(savingsGoal, [row("e", 100, "expense")], "2026-09-21").actual, null);
  const shareGoal = { id: "share", name: "餐饮占比", metric: "category-share", period: "month", category: "餐饮", target: 2_000 } as const;
  const shareRows = [row("food", 6_001, "expense"), row("other", 23_999, "expense", "购物")];
  assert.equal(financeGoalProgress(shareGoal, shareRows, "2026-09-21").status, "over", "20.0033% must not round down to within 20%");
  const balanceGoal = { id: "balance", name: "结余", metric: "balance", period: "month", category: "", target: 18_000 } as const;
  assert.equal(financeGoalProgress(balanceGoal, refund, "2026-09-21").actual, 18_000, "refund reduces net expense, transfer excluded");
  assert.equal(buildFinanceAnalysisInput("2026-09", [row("t1", 50_000, "transfer"), row("t2", 80_000, "transfer")], null, "2026-09-21").entryCount, 0);
  const wideBudget = { month: "2026-09", totalCents: 100_000,
    allocations: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`分类${index}`, 1_000])) };
  const wideRows = Array.from({ length: 12 }, (_, index) => row(`wide-${index}`, 1_000, "expense", `分类${index}`));
  assert.ok(buildFinanceAnalysisInput("2026-09", wideRows, wideBudget, "2026-09-21").candidates.find((item) => item.id === "budget")!.points.length <= 6);
  const validResponse = JSON.stringify({ conclusion: "{{month}} 已记录消费 {{gross}}。",
    charts: [{ id: "daily", explanation: "最高单日 {{daily_peak}}。" }], suggestions: ["先核对账目覆盖范围。"], detail: "仅按当前记录判断。" });
  const parsed = parseFinanceAnalysisResponse(validResponse, input);
  assert.match(parsed.conclusion, /¥ 200.00/u);
  assert.match(parseFinanceAnalysisResponse(JSON.stringify({ conclusion: "主要分类 {{category_1}}。", charts: [{ id: "daily", explanation: "支出有起伏。" }], suggestions: [] }), input).conclusion, /¥ 120.00/u);
  assert.equal(parsed.charts[0].points.length, 21, "daily snapshot includes zero-spend days without rendering a long list");
  assert.deepEqual(input.tables.map((table) => table.id), ["category", "merchant", "budget"]);
  assert.ok(input.candidates.some((item) => item.id === "flow" && item.points.some((point) => point.valueCents < 0)));
  const frequencyRows = Array.from({ length: 9 }, (_, index) => row(`once-${index}`, 30_000, "expense", "购物", { merchant: `单次商户${index}` }))
    .concat(Array.from({ length: 3 }, (_, index) => row(`repeat-${index}`, 100, "expense", index === 2 ? "购物" : "餐饮",
      { merchant: "小额重复商户", description: index === 2 ? "零食" : "工作餐" })));
  const frequencyInput = buildFinanceAnalysisInput("2026-09", frequencyRows, null, "2026-09-21");
  const frequencyFacts = JSON.parse(frequencyInput.text) as any;
  assert.ok(!frequencyFacts.商户支出.some((item: { 商户: string }) => item.商户 === "小额重复商户"));
  assert.equal(frequencyFacts.重复消费候选[0].商户, "小额重复商户");
  assert.equal(frequencyInput.facts.frequent_1_count, "3 笔");
  assert.equal(frequencyInput.facts.frequent_1_amount, "¥ 3.00");
  assert.equal(frequencyInput.facts.frequent_1_categories, "餐饮 2 笔；购物 1 笔");
  assert.equal(frequencyFacts.重复消费候选[0].已有分类与笔数, frequencyInput.facts.frequent_1_categories);
  const zeroAllocationInput = buildFinanceAnalysisInput("2026-09", sample,
    { month: "2026-09", totalCents: 100_000, allocations: { 餐饮: 0, 购物: 0 } }, "2026-09-21");
  assert.deepEqual([zeroAllocationInput.facts.budget_total, zeroAllocationInput.facts.budget_allocated,
    zeroAllocationInput.facts.budget_unallocated, zeroAllocationInput.facts.budget_remaining],
  ["¥ 1,000.00", "¥ 0.00", "¥ 1,000.00", "¥ 800.00"]);
  assert.match(zeroAllocationInput.facts.budget_allocation_state, /全部分类额度均为 ¥ 0\.00/u);
  const versionedResponse = JSON.stringify({ version: 8, sections: [
    { title: "记录中最显著的支出是什么", blocks: [
      { type: "highlight", tone: "fact", markdown: "**{{category_1_name}}**为 {{category_1_amount}}。" },
      { type: "chart", id: "category", explanation: "这张排名图用于找出重点分类。" },
      { type: "table", id: "merchant", explanation: "表格核对商户聚合，不能当作单笔。" },
      { type: "actions", items: ["先核对用途。", "{{unverified_key}} 应省略。"] }
    ] },
    { title: "收支差额如何理解", blocks: [
      { type: "text", markdown: "只代表已记录范围。" },
      { type: "chart", id: "flow", explanation: "支出原额和退款分列。" }
    ] }
  ] });
  const versioned = parseFinanceAnalysisResponse(versionedResponse, input);
  assert.equal(versioned.version, 8);
  assert.equal(versioned.sections?.length, 2);
  assert.equal(versioned.sections?.[0].blocks.find((block) => block.type === "actions")?.items.length, 1);
  assert.equal(versioned.omittedSuggestionCount, 1);
  assert.match(JSON.stringify(versioned.sections), /¥ 120\.00/u);
  const markedInput = buildFinanceAnalysisInput("2026-09", [row("marked", 200, "expense", "餐饮*<测试>&")], null, "2026-09-21");
  const marked = parseFinanceAnalysisResponse(JSON.stringify({ version: 8, sections: [{ title: "说明", blocks: [
    { type: "text", markdown: "分类 {{category_1_name}} 需要核对。" }] }] }), markedInput);
  assert.match((marked.sections?.[0].blocks[0] as { markdown: string }).markdown, /餐饮\\\*&lt;测试&gt;&amp;/u);
  const citedConclusion = `当前账本已记录{{category_1}}；另有{{merchant_1}}。${"{{category_1_count}}".repeat(8)}`;
  assert.match(parseFinanceAnalysisResponse(JSON.stringify({ conclusion: citedConclusion, charts: [], suggestions: [] }), input).conclusion, /¥ 120.00/u);
  assert.equal(parseFinanceAnalysisResponse(JSON.stringify({ conclusion: "百分比变化十分集中。", charts: [], suggestions: [] }), input).charts.length, 0);
  assert.equal(parseFinanceAnalysisResponse(JSON.stringify({ conclusion: "仅按当前记录判断。", charts: [],
    suggestions: ["确认是否属于一次性消费，逐项核对每一笔，并换一个更合适的方案。"] }), input).suggestions.length, 1);
  assert.match(parseFinanceAnalysisResponse(`\u0060\u0060\u0060json\n${validResponse}\n\u0060\u0060\u0060`, input).conclusion, /¥ 200.00/u);
  const largeInput = buildFinanceAnalysisInput("2026-09", [row("large", 30_000, "expense")], null, "2026-09-21");
  assert.match(parseFinanceAnalysisResponse(JSON.stringify({ conclusion: "大额门槛为 {{large_threshold}}，涉及 {{large_count}}。",
    charts: [{ id: "large", explanation: "这部分占比 {{large_share}}。" }], suggestions: [] }), largeInput).conclusion, /¥ 200.00.*1 笔/u);
  const assertCode = (body: string, code: FinanceAnalysisErrorCode): void => {
    assert.throws(() => parseFinanceAnalysisResponse(body, input), (error: unknown) => error instanceof FinanceAnalysisValidationError && error.code === code);
  };
  const report = (conclusion: string): string => JSON.stringify({ conclusion,
    charts: [{ id: "daily", explanation: "支出有起伏。" }], suggestions: [] });
  const naturalInput = buildFinanceAnalysisInput("2026-09", [row("natural-a", 120_000, "expense", "餐饮", { date: "2026-09-07" }),
    row("natural-b", 120_000, "expense", "餐饮", { date: "2026-09-20" }), row("natural-refund", 10_000, "refund")],
    { ...budget, totalCents: 300_000, allocations: { 餐饮: 0, 购物: 0 } }, "2026-09-30");
  const naturalBlocks = [
    { type: "highlight", tone: "fact", markdown: "本月已记录两笔消费，共2400元；扣除100元退款后净支出为2300元。" },
    { type: "text", markdown: "2026-09-07与9月20日各支出1200元。第1周占支出原额50%，约五成；分类额度为0元不代表没有总预算。" },
    { type: "chart", id: "daily", explanation: "09-01至09-07合计1200元，第1周的集中支付可用于安排后续开支。" },
    { type: "table", id: "merchant", explanation: "合成商户两笔累计2400元，聚合金额与逐笔明细可以对照阅读。" },
    { type: "actions", items: ["1. 每周少1次临时下单，先试7天；若每次30元，按每周30元估算调整效果，这不是已发生的节省金额。"] }
  ];
  const naturalResponse = JSON.stringify({ version: 8, sections: [{ title: "第1周与后续安排", blocks: naturalBlocks }] });
  const naturalParsed = parseFinanceAnalysisResponse(naturalResponse, naturalInput);
  const naturalSection = naturalParsed.sections![0];
  assert.equal(naturalSection.title, "第1周与后续安排");
  assert.deepEqual(naturalSection.blocks.slice(0, 2), naturalBlocks.slice(0, 2).map((block) => ({ ...block, markdown: block.markdown!.normalize("NFKC") })), "natural amounts, dates, ratios and counts survive unchanged");
  assert.deepEqual(naturalSection.blocks[2], { type: "chart", chart: { ...naturalInput.candidates.find((chart) => chart.id === "daily"),
    explanation: naturalBlocks[2].explanation!.normalize("NFKC") } }, "chart data still comes from the local snapshot");
  assert.deepEqual(naturalSection.blocks[3], { type: "table", table: naturalInput.tables.find((table) => table.id === "merchant"),
    explanation: naturalBlocks[3].explanation!.normalize("NFKC") });
  assert.deepEqual(naturalSection.blocks[4], { type: "actions", items: naturalBlocks[4].items!.map((item) => item.normalize("NFKC")) });
  assert.equal(naturalParsed.omittedSuggestionCount, 0, "numeric action targets are not discarded");
  const blocksReport = (blocks: unknown[]): string => JSON.stringify({ version: 8, sections: [{ title: "分析", blocks }] });
  for (const markdown of ["<script>alert(1)</script>", "[查看][x]\n[x]: obsidian://private", "![图片](https://example.com/a.png)",
    "[链接](https://example.com)", "[[私人笔记]]", "```js\nalert(1)\n```"])
    assertCode(blocksReport([{ type: "text", markdown }]), "invalid-structure");
  assertCode(blocksReport([{ type: "highlight", tone: "fact" }]), "invalid-structure");
  assertCode(blocksReport([{ type: "text", markdown: "{{unknown}}" }]), "unknown-reference");
  assertCode(blocksReport([{ type: "text", markdown: "正文" }, { type: "chart", id: "absent", explanation: "2400元" }]), "invalid-chart");
  assertCode(blocksReport([{ type: "text", markdown: "正文" }, { type: "chart", id: "daily", markdown: "2400元" }]), "invalid-chart");
  assertCode(blocksReport([{ type: "text", markdown: "正文" }, { type: "table", id: "merchant" }]), "invalid-structure");
  assertCode(blocksReport([{ type: "text", markdown: "正文" }, { type: "actions", items: ["<b>不安全建议</b>"] }]), "invalid-structure");
  const longConclusion = "已记录消费，仍需核对资料范围。".repeat(20);
  const longExplanation = "这张图显示支出波动，应结合记录日期理解。".repeat(15);
  const longSuggestion = "逐项核对较大消费的用途，再决定是否调整计划。".repeat(15);
  const longDetail = `仅按当前记录判断。\n## 观察\n${"账本只覆盖已记录交易，其他账户仍需自行核对。\n".repeat(60)}`;
  assert.ok(longConclusion.length > 180 && longExplanation.length > 220 && longSuggestion.length > 220 && longDetail.length > 1000);
  const longResponse = JSON.stringify({ conclusion: longConclusion,
    charts: [{ id: "daily", explanation: longExplanation }], suggestions: [longSuggestion], detail: longDetail });
  const longVersionedResponse = JSON.stringify({ version: 8, sections: [{ title: "记录中的观察", blocks: [
    { type: "text", markdown: longConclusion }, { type: "chart", id: "daily", explanation: longExplanation },
    { type: "text", markdown: longDetail.replace("## 观察\n", "") }, { type: "actions", items: [longSuggestion] }] }] });
  const longParsed = parseFinanceAnalysisResponse(longResponse, input);
  assert.equal(longParsed.conclusion, longConclusion.normalize("NFKC"));
  assert.equal(longParsed.charts[0].explanation, longExplanation.normalize("NFKC"));
  assert.equal(longParsed.suggestions[0], longSuggestion.normalize("NFKC"));
  assert.equal(longParsed.detail, longDetail.normalize("NFKC").trim());
  const oversizedResponse = JSON.stringify({ conclusion: "说明".repeat(10_001), charts: [], suggestions: [] });
  assertCode(oversizedResponse, "too-long");
  const withSuggestions = (suggestions: unknown[], detail = "记录仍需核对。"): string => JSON.stringify({ conclusion: "仅按当前记录判断。",
    charts: [{ id: "daily", explanation: "支出有起伏。" }], suggestions, detail });
  const partialResponse = withSuggestions(["{{missing_merchant}} 的建议未完成。",
    "每周少1次临时下单，先试7天。", "{{unknown_private_fact}} 不应展示。"]);
  const partialParsed = parseFinanceAnalysisResponse(partialResponse, input);
  assert.deepEqual(partialParsed.suggestions, ["每周少1次临时下单，先试7天。".normalize("NFKC")]);
  assert.equal(partialParsed.omittedSuggestionCount, 2);
  const partialVersionedResponse = JSON.stringify({ version: 8, sections: [{ title: "已记录账目", blocks: [
    { type: "text", markdown: "记录仍需核对。" }, { type: "chart", id: "daily", explanation: "支出有起伏。" },
    { type: "actions", items: ["{{missing_merchant}} 的建议未完成。",
      "每周少1次临时下单，先试7天。", "{{unknown_private_fact}} 不应展示。"] }] }] });
  assert.doesNotMatch(JSON.stringify(partialParsed), /unknown_private_fact|missing_merchant/u);
  const allOmitted = parseFinanceAnalysisResponse(withSuggestions(["{{unknown_private_fact}}", "{{missing_merchant}}"], ""), input);
  assert.deepEqual(allOmitted.suggestions, []);
  assert.equal(allOmitted.omittedSuggestionCount, 2);
  assertCode(withSuggestions(["<b>不要显示</b>"]), "invalid-structure");
  assertCode(withSuggestions(["<b>{{unknown_private_fact}}</b>"]), "invalid-structure");
  assertCode(withSuggestions(["正常建议。", 5]), "invalid-structure");
  assertCode(withSuggestions(["一", "二", "三", "四"]), "invalid-structure");
  assertCode(JSON.stringify({ conclusion: "正常结论。", charts: [], suggestions: [], omittedSuggestionCount: 2 }), "invalid-structure");
  assertCode(report("{{unknown}}"), "unknown-reference");
  assertCode('{"conclusion":"未完成', "invalid-json");
  assertCode(`${report("正常说明")} trailing`, "invalid-json");
  assertCode(JSON.stringify({ conclusion: "{{gross}}", charts: [{ id: "absent", explanation: "说明" }], suggestions: [] }), "invalid-chart");
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-finance-analysis-"));
  try {
    const store = new LifestyleStore(path.join(directory, "lifestyle.json"));
    await store.initialize();
    const vault = new FakeVault();
    const app = { vault, fileManager: { processFrontMatter: vault.processFrontMatter.bind(vault), renameFile: vault.rename.bind(vault) } } as unknown as App;
    const settings = { lifestyle: structuredClone(DEFAULT_LIFESTYLE_SETTINGS),
      apiProviders: [{ id: "test-provider", name: "合成 Provider", models: [{ id: "test-model", displayName: "合成模型" }] }],
      activeApiProviderId: "test-provider", defaultModel: "test-model" };
    settings.lifestyle.finance.enabled = true; settings.lifestyle.finance.aiEnabled = true;
    let calls = 0, resolutions = 0, uses = 0, available = true, skill = FINANCE_ANALYSIS_SKILL;
    const systemPrompts: string[] = [];
    let hold = false, release: (() => void) | null = null;
    let responseText = versionedResponse;
    const service = { store, plugin: { app, settings, registerEvent: () => undefined,
      getSkillRuntimeCoordinator: () => ({ resolveById: async (id: string) => { assert.equal(id, "finance-analysis"); resolutions++; },
        recordUse: async (id: string) => { assert.equal(id, "finance-analysis"); uses++; } }),
      requireAvailableEchoInkSkill: async (id: string) => { assert.equal(id, "finance-analysis"); if (!available) throw new Error("Skill 已停用"); },
      readEchoInkBuiltinSkill: async () => ({ fileStatus: "ready", content: skill }),
      generateLifestyleText: async (system: string, prompt: string) => {
        calls++; systemPrompts.push(system);
        assert.ok(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)).有效交易明细.length > 0); assert.doesNotMatch(prompt, /coverageCompleteness|moneyCents|sourceId|银行卡号/u);
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
        return responseText;
      }
    } } as unknown as LifestyleService;
    const finance = new LifestyleFinanceService(service);
    await finance.initialize();
    await finance.saveGoal("2026-09", { id: "fraction", name: "手动存钱", mode: "manual", target: 19.99, actual: 0.29, unit: "元" });
    assert.equal(finance.monthlyPlan("2026-09").goals[0].actual, 0.29, "valid two-decimal values survive storage");
    await assert.rejects(finance.saveGoal("2026-09", { id: "bad", name: "坏目标", mode: "manual", target: 0.001, actual: 0, unit: "元" }), /两位小数/u);
    const concurrent = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => finance.saveGoal("2026-09", {
      id: `goal-${index}`, name: `合成目标${index}`, mode: "manual", target: 1, actual: 0, unit: "元"
    })));
    assert.deepEqual(concurrent.map((item) => item.status).sort(), ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected"], "five-goal limit is checked inside serialized updates");
    assert.equal(finance.monthlyPlan("2026-09").goals.length, 5);
    await finance.saveDailyLimit("2026-09", 2_000);
    assert.equal(finance.monthlyPlan("2026-09").dailyLimitCents, 2_000);
    const newGoals = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => finance.saveContinuousGoal({ id: `ongoing-${index}`, name: `持续目标${index}`, metric: "expense", period: "day", category: "", target: 1_000 })));
    assert.deepEqual(newGoals.map((item) => item.status).sort(), ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected"]);
    assert.equal(finance.goals().length, 5);
    await finance.deleteContinuousGoal("ongoing-4");
    await assert.rejects(finance.saveContinuousGoal({ id: "convert-fail", name: "转换失败", metric: "expense", period: "month", category: "", target: 1_000 }, { month: "2026-09", id: "absent" }), /原目标已改变/u);
    assert.equal(finance.monthlyPlan("2026-09").goals.length, 5, "failed conversion preserves all legacy goals");
    await finance.saveContinuousGoal({ id: "converted", name: "新统计", metric: "expense", period: "month", category: "", target: 1_000 }, { month: "2026-09", id: "fraction" });
    assert.equal(finance.monthlyPlan("2026-09").goals.length, 4);
    assert.equal(finance.goals().length, 5, "conversion adds the new rule and removes only the selected old one atomically");
    await finance.ledger.add(row("service-a", 4_000, "expense"));
    const first = await finance.analyze("2026-09", true);
    assert.equal(first.promptVersion, FINANCE_ANALYSIS_PROMPT_VERSION);
    assert.deepEqual([calls, resolutions, uses], [1, 1, 1]);
    assert.equal(systemPrompts[0], `${FINANCE_ANALYSIS_SKILL}\n\n## 固定输出协议\n${FINANCE_ANALYSIS_OUTPUT_PROTOCOL}`,
      "the production request combines the default professional Skill and independent display protocol");
    assert.equal(systemPrompts[0].split(FINANCE_ANALYSIS_OUTPUT_PROTOCOL).length - 1, 1, "the display protocol appears once");
    assert.equal((await finance.analyze("2026-09")).id, first.id, "matching fingerprint and version reuse the saved report");
    assert.equal(calls, 1);
    const saved = finance.ledger.fileFor("service-a")!;
    const note = vault.files.get(saved.path)!;
    assert.match(note.text, /amount: "40.00"/u);
    note.text = note.text.replace('amount: "40.00"', 'amount: "50.00"');
    const changed = await finance.analyze("2026-09", false);
    assert.notEqual(changed.id, first.id, "analysis reloads Markdown before checking the cache");
    assert.equal(calls, 2);
    assert.equal(store.snapshot().reports.filter((item) => item.kind === "finance" && item.period === "2026-09").length, 1,
      "new analysis replaces the same-month finance report");
    available = false;
    await assert.rejects(finance.analyze("2026-09", true), /已停用/u);
    assert.equal(finance.latestReport("2026-09"), null, "forced refresh retires the prior report before provider work");
    available = true; skill = "";
    await assert.rejects(finance.analyze("2026-09", true), /不可读取/u);
    assert.equal(calls, 2);
    skill = FINANCE_ANALYSIS_SKILL;
    responseText = "  ";
    await assert.rejects(finance.analyze("2026-09", true), /没有返回/u);
    assert.equal(finance.latestReport("2026-09"), null, "empty response cannot restore a retired report");
    responseText = JSON.stringify({ version: 8, sections: [{ title: "未完成的报告", blocks: [{ type: "text" }] }] });
    await assert.rejects(finance.analyze("2026-09", true), /暂时无法显示/u);
    assert.equal(finance.latestReport("2026-09"), null, "incomplete report leaves only the failure state");
    responseText = oversizedResponse;
    await assert.rejects(finance.analyze("2026-09", true), /过长/u);
    assert.equal(finance.latestReport("2026-09"), null, "oversized response cannot restore the prior report");
    responseText = longVersionedResponse;
    const refreshed = await finance.analyze("2026-09", true);
    assert.notEqual(refreshed.id, changed.id, "valid refresh writes a new snapshot");
    assert.ok(refreshed.createdAt >= changed.createdAt);
    assert.equal(finance.latestReport("2026-09")?.id, refreshed.id);
    responseText = partialVersionedResponse;
    const partial = await finance.analyze("2026-09", true);
    assert.notEqual(partial.id, refreshed.id, "verified core with a rejected optional suggestion saves a new report");
    assert.equal((partial.financeSnapshot as { omittedSuggestionCount: number }).omittedSuggestionCount, 2);
    assert.equal(finance.latestReport("2026-09")?.id, partial.id);
    responseText = validResponse;
    await assert.rejects(finance.analyze("2026-09", true), /暂时无法显示/u);
    assert.equal(finance.latestReport("2026-09"), null, "failed refresh does not fall back to the last report");
    responseText = partialVersionedResponse;
    hold = true;
    const pendingA = finance.analyze("2026-09", true);
    const pendingB = finance.analyze("2026-09", true);
    assert.equal(pendingA, pendingB, "same-month clicks share one flight before any async wait");
    assert.equal(finance.busyMonth(), "2026-09");
    await assert.rejects(finance.analyze("2026-08", true), /2026-09 的分析正在生成/u);
    for (let index = 0; index < 20 && !release; index++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(release);
    finance.cancel("2026-09"); release!();
    const settled = await Promise.allSettled([pendingA, pendingB]);
    assert.ok(settled.every((item) => item.status === "rejected"));
    assert.equal(finance.busyMonth(), null);
    assert.equal(calls, 9);
    assert.equal(finance.latestReport("2026-09"), null, "cancellation leaves no stale current report");
    hold = false;
    responseText = partialVersionedResponse;
    const displayReport = await finance.analyze("2026-09", true);
    assert.equal(calls, 10);
    await finance.ledger.add(row("transfer-only", 50_000, "transfer", "其他", { date: "2026-08-20 10:00:00" }));
    await assert.rejects(finance.analyze("2026-08", true), /暂无可分析/u);
    assert.equal(calls, 10, "transfer-only months do not call the model");
    (service as unknown as { finance: LifestyleFinanceService }).finance = finance;
    const workspace = new FinanceWorkspace(service);
    (workspace as unknown as { state: { month: string } }).state.month = "2026-09";
    const document = new TestDocument();
    const parent = document.body.createDiv();
    openTestMarkdownRenders.length = 0;
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(parent as unknown as HTMLElement);
    assert.equal(calls, 10, "rendering the analysis card never starts an automatic model call");
    assert.equal(openTestMarkdownRenders.length, 3, "text, chart explanation and action each use the Markdown renderer");
    assert.match(parent.textContent, /有 2 条建议未能完整生成，未展示/u);
    assert.doesNotMatch(parent.textContent, /这两笔较大支出|unknown_private_fact/u);
    assert.equal(parent.querySelectorAll("small").find((node) => node.textContent.includes("未能完整生成"))?.getAttribute("role"), "status");
    assert.match(openTestMarkdownRenders[0].markdown, /记录仍需核对/u, "detail Markdown is sent to Obsidian renderer");
    assert.equal(parent.querySelector(".echoink-finance-ai-text")?.classList.contains("is-lead"), true,
      "a text-first v8 report receives a readable introduction without rewriting its content");
    await store.update((draft) => { draft.reports.find((item) => item.id === displayReport.id)!.financeSnapshot = allOmitted; });
    const allOmittedParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(allOmittedParent as unknown as HTMLElement);
    assert.match(allOmittedParent.textContent, /有 2 条建议未能完整生成，未展示/u);
    assert.doesNotMatch(allOmittedParent.textContent, /可以试试/u, "all omitted suggestions leave no empty heading");
    await store.update((draft) => {
      const snapshot = draft.reports.find((item) => item.id === displayReport.id)!.financeSnapshot as { omittedSuggestionCount?: number };
      delete snapshot.omittedSuggestionCount;
    });
    const legacyParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(legacyParent as unknown as HTMLElement);
    assert.doesNotMatch(legacyParent.textContent, /未能完整生成|undefined/u, "older snapshots without omission metadata remain readable");
    assert.equal(legacyParent.querySelector(".echoink-finance-ai-legacy-summary")?.querySelector("p")?.textContent,
      allOmitted.conclusion, "old conclusions keep their original text while only facts gain emphasis");
    assert.equal(legacyParent.querySelector(".echoink-finance-ai-charts")?.querySelectorAll(".echoink-finance-ai-chart").length,
      allOmitted.charts.length, "old chart snapshots remain visible");
    await store.update((draft) => { draft.reports.find((item) => item.id === displayReport.id)!.financeSnapshot = versioned; });
    const versionedParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(versionedParent as unknown as HTMLElement);
    assert.match(versionedParent.textContent, /记录中最显著的支出是什么.*收支差额如何理解/u);
    assert.equal(versionedParent.querySelector(".echoink-finance-ai-table-panel")?.querySelectorAll("table").length, 1);
    assert.equal(versionedParent.querySelectorAll(".echoink-finance-ai-chart").length, 2);
    assert.equal(versionedParent.querySelector(".echoink-finance-section-head")?.querySelector("button")?.textContent, "刷新分析");
    assert.equal(versionedParent.children.filter((node) => node.tagName === "button").length, 0);
    assert.doesNotMatch(versionedParent.textContent, /支出原额.*退款超过消费/u);
    await store.update((draft) => { draft.reports.find((item) => item.id === displayReport.id)!.financeSnapshot = naturalParsed; });
    const naturalParent = document.body.createDiv();
    const naturalRenderStart = openTestMarkdownRenders.length;
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(naturalParent as unknown as HTMLElement);
    assert.deepEqual(openTestMarkdownRenders.slice(naturalRenderStart).map((render) => render.markdown),
      [naturalBlocks[0].markdown!, naturalBlocks[1].markdown!, naturalBlocks[2].explanation!, naturalBlocks[3].explanation!,
        naturalBlocks[4].items![0]].map((markdown) => markdown.normalize("NFKC")),
      "the card sends numeric content from all five block types to the Markdown renderer");
    assert.match(naturalParent.textContent, /第1周与后续安排/u);
    assert.equal(naturalParent.querySelectorAll(".echoink-finance-ai-chart").length, 1);
    assert.equal(naturalParent.querySelector(".echoink-finance-ai-table-panel")?.querySelectorAll("table").length, 1);
    assert.doesNotMatch(naturalParent.textContent, /未能完整生成/u);
    await store.update((draft) => { draft.reports.find((item) => item.id === displayReport.id)!.financeSnapshot = versioned; });
    const workspaceState = workspace as unknown as { analysisError: { month: string; message: string; reportId: string | null } | null;
      state: { month: string } };
    workspaceState.analysisError = { month: "2026-09", message: "合成存储失败", reportId: displayReport.id };
    const failedParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(failedParent as unknown as HTMLElement);
    assert.equal(failedParent.querySelector(".echoink-finance-ai-report"), null, "failure hides a saved report even if storage retained it");
    assert.doesNotMatch(failedParent.textContent, /合成 Provider|记录中最显著的支出是什么/u);
    assert.match(failedParent.textContent, /合成存储失败/u);
    assert.equal(failedParent.querySelector(".echoink-finance-section-head")?.querySelector("button")?.textContent, "重试分析");
    workspaceState.state.month = "2026-08";
    const isolatedParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(isolatedParent as unknown as HTMLElement);
    assert.doesNotMatch(isolatedParent.textContent, /合成存储失败/u, "failure is scoped to its original month");
    workspaceState.state.month = "2026-09";
    workspaceState.analysisError = null;
    const dailyParent = document.body.createDiv();
    (workspace as unknown as { renderAnalysisChart(parent: HTMLElement, chart: unknown): void }).renderAnalysisChart(dailyParent as unknown as HTMLElement,
      { ...input.candidates.find((candidate) => candidate.id === "daily")!, explanation: "核对日期。" });
    assert.equal(dailyParent.querySelectorAll(".echoink-finance-ai-daily-bar").length, 1, "zero-spend dates have no fake bars");
    const fullMonthInput = buildFinanceAnalysisInput("2026-10", [row("full-day", 250, "expense", "餐饮", { date: "2026-10-01" })], null, "2026-10-31");
    (workspace as unknown as { state: { month: string } }).state.month = "2026-10";
    const fullMonthParent = document.body.createDiv({ cls: "echoink-lifestyle-view" });
    (fullMonthParent as unknown as { getBoundingClientRect(): object }).getBoundingClientRect = () => ({ top: 240, bottom: 500 });
    (workspace as unknown as { renderAnalysisChart(parent: HTMLElement, chart: unknown): void }).renderAnalysisChart(fullMonthParent as unknown as HTMLElement,
      { ...fullMonthInput.candidates.find((candidate) => candidate.id === "daily")!, explanation: "核对日期。" });
    const fullColumns = fullMonthParent.querySelectorAll(".echoink-finance-ai-daily-column");
    assert.equal(fullColumns.length, 31, "narrow plot still represents every calendar date");
    const fullWeeks = financeDailyWeeks(fullMonthInput.candidates.find((chart) => chart.id === "daily")!.points);
    assert.deepEqual(fullWeeks.map((week) => [week.start, week.end, week.points.length]),
      [["10-01", "10-07", 7], ["10-08", "10-14", 7], ["10-15", "10-21", 7], ["10-22", "10-28", 7], ["10-29", "10-31", 3]]);
    assert.equal(fullWeeks.reduce((total, week) => total + week.totalCents, 0), 250);
    assert.equal(fullMonthParent.querySelectorAll(".echoink-finance-ai-daily-week").length, 5);
    assert.ok(fullColumns.every((column) => Boolean(column.querySelector("small")?.textContent)), "every date has its own visible day label");
    assert.equal(fullMonthParent.querySelector("output"), null, "hover does not write a persistent reading below the chart");
    assert.equal(fullColumns[30].getAttribute("tabindex"), "0");
    assert.match(fullColumns[30].getAttribute("aria-label") ?? "", /2026-10-31.*¥ 0\.00/u);
    const dailyPanel = fullMonthParent.querySelector(".echoink-finance-ai-chart")! as unknown as { getBoundingClientRect(): object };
    dailyPanel.getBoundingClientRect = () => ({ left: 0, top: 200, width: 500, height: 400 });
    (fullColumns[30] as unknown as { getBoundingClientRect(): object }).getBoundingClientRect = () => ({ left: 480, top: 250, width: 10 });
    const tooltip = fullMonthParent.querySelector(".echoink-finance-ai-daily-tooltip")!;
    (fullColumns[30] as unknown as { onfocus: () => void }).onfocus();
    assert.equal(tooltip.hidden, false);
    assert.match(tooltip.textContent, /2026-10-31.*¥ 0\.00/u);
    assert.equal(tooltip.getAttribute("aria-hidden"), "false");
    assert.ok(parseFloat((tooltip.style as unknown as { left: string }).left) <= 314, "tooltip is clamped inside the chart edge");
    assert.ok(parseFloat((tooltip.style as unknown as { top: string }).top) >= 54, "tooltip remains within the visible scrollport");
    assert.equal(document.listenerCount("keydown"), 1);
    document.dispatchKey("Escape");
    assert.equal(tooltip.hidden, true, "Escape closes the hover/focus reading from anywhere");
    assert.equal(document.listenerCount("keydown"), 0, "hiding removes the document listener");
    (fullColumns[30] as unknown as { onfocus: () => void; onblur: () => void }).onfocus();
    (fullColumns[30] as unknown as { onblur: () => void }).onblur();
    assert.equal(tooltip.hidden, true, "focus leaving closes the reading");
    (workspace as unknown as { state: { month: string } }).state.month = "2026-09";
    await Promise.resolve();
    assert.equal(openTestMarkdownRenders[0].component.unloaded, false);
    const chartsParent = document.body.createDiv();
    const composeParent = document.body.createDiv();
    const composeWorkspace = workspace as unknown as { composition(parent: HTMLElement, summary: FinanceSummary): void; summary(): FinanceSummary };
    composeWorkspace.composition(composeParent as unknown as HTMLElement, composeWorkspace.summary());
    assert.match(composeParent.textContent, /支出原额.*退款另列.*净支出/u, "composition separates gross spending and refunds");
    (workspace as unknown as { spendingCharts(parent: HTMLElement): void }).spendingCharts(chartsParent as unknown as HTMLElement);
    const bins = chartsParent.querySelectorAll(".echoink-finance-bin");
    assert.equal(bins.length, 5);
    assert.equal(bins[0].getAttribute("role"), "img", "amount rows are read-only details");
    assert.match(bins[0].getAttribute("aria-label") ?? "", /合计/u, "keyboard description exposes total amount");
    const legend = chartsParent.querySelectorAll(".echoink-finance-chart-row");
    const sectors = chartsParent.querySelectorAll(".echoink-finance-donut-sector");
    assert.equal(legend.length, sectors.length, "every category has a matching SVG sector");
    assert.equal(chartsParent.querySelector(".echoink-finance-donut-svg")?.getAttribute("viewBox"), "0 0 200 200");
    legend[0].click();
    const state = (workspace as unknown as { state: { chartCategory?: string | null; recentDate?: string | null; page: string; filters: { date?: string } } }).state;
    assert.match(chartsParent.querySelector(".echoink-finance-chart-selection")?.textContent ?? "", /已选/u);
    assert.equal(sectors[0].getAttribute("aria-pressed"), "true");
    assert.equal(state.page, "overview", "chart selection stays on the overview");
    assert.equal(state.filters.date, undefined);
    legend[0].click();
    assert.equal(state.chartCategory, null, "selecting the same category clears the filter");
    legend[0].click();
    chartsParent.querySelector(".echoink-finance-chart-selection")!.querySelector("button")!.click();
    assert.equal(state.chartCategory, null, "clear restores all categories");
    const calendarParent = document.body.createDiv();
    (workspace as unknown as { dailyCalendar(parent: HTMLElement): void }).dailyCalendar(calendarParent as unknown as HTMLElement);
    const spendingDay = calendarParent.querySelectorAll(".echoink-finance-day").find((node) => node.getAttribute("aria-label")?.includes("2026-09-20"));
    assert.ok(spendingDay?.getAttribute("aria-label")?.includes("超额"), "daily limit reports actual overspend");
    spendingDay!.click();
    assert.equal(state.recentDate, "2026-09-20");
    assert.equal(state.page, "overview", "calendar filters the recent list without navigation");
    (workspace as unknown as { changeMonth(delta: number): void }).changeMonth(1);
    assert.equal(state.recentDate, null);
    assert.equal(state.chartCategory, null, "month changes clear local chart selection");
    (workspace as unknown as { state: { month: string } }).state.month = "2026-09";
    const observedWorkspace = new FinanceWorkspace(service);
    (observedWorkspace as unknown as { state: { month: string }; overview: () => void }).state.month = "2026-08";
    (observedWorkspace as unknown as { overview: () => void }).overview = () => undefined;
    observedWorkspace.render(document.body.createDiv() as unknown as HTMLElement);
    let busyUpdates = 0;
    (observedWorkspace as unknown as { redraw: () => void }).redraw = () => { busyUpdates++; };
    responseText = versionedResponse; hold = true; release = null;
    workspaceState.analysisError = { month: "2026-09", message: "旧一次分析失败", reportId: displayReport.id };
    const callsBeforeRefresh = calls;
    const busyPromise = finance.analyze("2026-09", true);
    assert.equal(busyUpdates, 1, "another month view hears the busy transition");
    const busyParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(busyParent as unknown as HTMLElement);
    const busyAction = busyParent.querySelector(".echoink-finance-section-head")?.querySelector("button");
    assert.equal(busyAction?.disabled, true);
    assert.equal(busyAction?.getAttribute("aria-busy"), "true");
    assert.match(busyParent.textContent, /正在根据最新账目生成本次报告/u);
    assert.doesNotMatch(busyParent.textContent, /旧一次分析失败/u, "new generation takes priority over a prior failure");
    assert.equal(busyParent.querySelector(".echoink-finance-ai-report"), null, "old body is hidden as soon as the new flight starts");
    assert.doesNotMatch(busyParent.textContent, /合成 Provider|记录中最显著的支出是什么/u,
      "old generation time and provider are hidden during refresh");
    busyAction?.click();
    (workspace as unknown as { state: { month: string } }).state.month = "2026-08";
    const otherMonthParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(otherMonthParent as unknown as HTMLElement);
    assert.match(otherMonthParent.textContent, /2026-09 的分析正在生成/u);
    for (let index = 0; index < 200 && !release; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release); release!(); hold = false;
    const busyResult = await busyPromise;
    assert.equal(calls, callsBeforeRefresh + 1, "same-input forced refresh starts exactly one new model call");
    assert.equal(finance.latestReport("2026-09")?.id, busyResult.id, "successful refresh only exposes the new report");
    assert.equal(store.snapshot().reports.filter((item) => item.kind === "finance" && item.period === "2026-09").length, 1);
    workspaceState.state.month = "2026-09";
    workspaceState.analysisError = { month: "2026-09", message: "另一个视图此前失败", reportId: displayReport.id };
    const recoveredParent = document.body.createDiv();
    (workspace as unknown as { aiCard(parent: HTMLElement): void }).aiCard(recoveredParent as unknown as HTMLElement);
    assert.match(recoveredParent.textContent, /记录中最显著的支出是什么/u,
      "a newer same-month report supersedes a stale failure from another view");
    assert.doesNotMatch(recoveredParent.textContent, /另一个视图此前失败/u);
    workspaceState.analysisError = null;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(busyUpdates >= 2, "another month view hears completion and can re-enable its action");
    observedWorkspace.detach();
    const updateCount = busyUpdates;
    await assert.rejects(finance.analyze("2026-08", true), /暂无可分析/u);
    assert.equal(busyUpdates, updateCount, "detached views release the flight subscription");
    const embeddedProtocolSkill = `${FINANCE_ANALYSIS_SKILL}\n\n## 输出协议\n${FINANCE_ANALYSIS_OUTPUT_PROTOCOL}\n`;
    skill = embeddedProtocolSkill;
    const callsBeforeEmbedded = calls;
    await finance.analyze("2026-09", true);
    assert.equal(calls, callsBeforeEmbedded + 1);
    assert.equal(systemPrompts.at(-1), embeddedProtocolSkill,
      "a saved Skill already ending in the current protocol remains compatible without another copy");
    assert.equal(systemPrompts.at(-1)!.split(FINANCE_ANALYSIS_OUTPUT_PROTOCOL).length - 1, 1);
    workspace.detach();
    assert.ok(openTestMarkdownRenders.every((render) => render.component.unloaded), "redraw or close releases every Markdown component");
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
  console.log("OK lifestyle finance analysis facts, Skill chain, fresh reload, cache and cancellation");
}

class LifestyleFinanceService extends ProductionFinanceService {
  constructor(service: ConstructorParameters<typeof ProductionFinanceService>[0]) { super(service, paidTestAccess); }
}
