import assert from "node:assert/strict";
import { financeMonthFacts, financeYearFacts, parseFinanceQuickEntry, shiftFinanceMonth, type FinanceQuickContext } from "../lifestyle/finance-monthly";
import { financeRecurringEntries, nextFinanceRecurringDate, normalizeFinanceRecurring, suggestFinanceRecurring, validateFinanceRecurring, type FinanceRecurring } from "../lifestyle/finance-recurring";
import { buildFinanceMonthlyReportInput, financeDiaryExcerpt, financeMonthlyReportMarkdown, parseFinanceMonthlyReportResponse } from "../lifestyle/finance-monthly-report";
import type { FinanceEntry } from "../lifestyle/store-core";

let serial = 0;
function entry(date: string, merchant: string, category: string, yuan: number, extra: Partial<FinanceEntry> = {}): FinanceEntry {
  serial++;
  return { id: `e${serial}`, source: "wechat", sourceId: `s${serial}`, date: `${date} 12:00:00`, merchant, category, kind: "expense",
    amountCents: Math.round(yuan * 100), status: "completed", account: "微信", description: "", currency: "CNY", note: "", ...extra };
}

export function runFinanceMonthlyReviewTests(): void {
  const rent: FinanceRecurring = { id: "r1", name: "房租", amountCents: 300000, category: "居住", account: "储蓄卡", cadence: "monthly", day: 1 };
  const gym: FinanceRecurring = { id: "r2", name: "乐刻健身", amountCents: 19900, category: "娱乐", account: "支付宝", cadence: "monthly", day: 31 };
  const insurance: FinanceRecurring = { id: "r3", name: "医疗险", amountCents: 36000, category: "其他", account: "", cadence: "yearly", day: 15, month: 3 };
  // 固定支出：规范化、下次扣款日（短月取月末）、校验
  assert.deepEqual(normalizeFinanceRecurring([rent, { ...rent }, { id: "bad", name: "", amountCents: 1, cadence: "monthly", day: 1 }, { ...insurance, month: 13, id: "x" }]).map(item => item.id), ["r1"]);
  assert.equal(nextFinanceRecurringDate(rent, "2026-12-02"), "2027-01-01");
  assert.equal(nextFinanceRecurringDate(gym, "2026-11-22"), "2026-11-30", "day 31 clamps to November's last day");
  assert.equal(nextFinanceRecurringDate(gym, "2027-02-10"), "2027-02-28");
  assert.equal(nextFinanceRecurringDate(insurance, "2026-12-02"), "2027-03-15");
  assert.throws(() => validateFinanceRecurring({ ...rent, amountCents: 0 }), /金额/u);
  assert.throws(() => validateFinanceRecurring({ ...insurance, month: undefined }), /月份/u);

  // 账本：10 月、11 月；11 月有日记来源、退款、转账、大额日
  const ledger: FinanceEntry[] = [
    entry("2026-09-01", "房租", "居住", 3000), entry("2026-10-01", "房租", "居住", 3000), entry("2026-11-01", "房租", "居住", 3000),
    entry("2026-09-05", "腾讯视频会员", "娱乐", 25), entry("2026-10-05", "腾讯视频会员", "娱乐", 25), entry("2026-11-05", "腾讯视频会员", "娱乐", 25),
    entry("2026-10-08", "海底捞", "餐饮", 300), entry("2026-10-12", "优衣库", "购物", 200),
    entry("2026-11-03", "瑞幸", "餐饮", 16), entry("2026-11-11", "京东", "购物", 1149, { source: "diary", journalPath: "Journal/2026-11-11.md", description: "降噪耳机" }),
    entry("2026-11-12", "京东", "购物", 49, { kind: "refund" }), entry("2026-11-15", "宜家", "居住", 468),
    entry("2026-11-20", "转给自己", "其他", 5000, { kind: "transfer" }), entry("2026-11-10", "工资", "收入", 18500, { kind: "income" }),
    entry("2026-11-26", "乐刻健身", "娱乐", 199), entry("2026-11-28", "失败订单", "购物", 999, { status: "failed" })
  ];
  const budget = { month: "2026-11", totalCents: 500000, allocations: { 购物: 100000, 居住: 350000 } };
  const facts = financeMonthFacts(ledger, "2026-11", [rent, gym], budget, [], "2026-12-02");
  assert.equal(facts.spentCents, (3000 + 25 + 16 + 1149 - 49 + 468 + 199) * 100, "net spending: refunds subtract, transfers and failures do not count");
  assert.equal(facts.incomeCents, 1_850_000);
  assert.equal(facts.previous.month, "2026-10");
  assert.equal(facts.previous.spentCents, 352_500);
  assert.equal(facts.average?.months, 2, "the average uses only months that have records");
  assert.equal(facts.elapsedDays, 30);
  assert.equal(facts.fixedCents, 319_900, "rent and gym are fixed; the membership is not configured");
  assert.ok(!facts.large.some(row => row.merchant === "房租"), "large spending leaves out fixed charges");
  assert.equal(facts.large[0].merchant, "京东");
  const shopping = facts.categories.find(item => item.name === "购物")!;
  assert.deepEqual([shopping.cents, shopping.previousCents, shopping.deltaCents], [110_000, 20_000, 90_000]);
  assert.equal(facts.categories[0].name, "居住", "categories rank by this month's amount");
  assert.deepEqual(facts.budget!.overs.map(item => item.category), ["购物"]);
  assert.ok(facts.days.find(day => day.date === "2026-11-11")!.hot, "a day far above the daily variable average is marked");
  assert.ok(!facts.days.find(day => day.date === "2026-11-01")!.hot, "rent day is not a big-spending day");
  assert.equal(facts.diary.length, 1);
  assert.deepEqual(facts.recent.map(item => item.month), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  const current = financeMonthFacts(ledger, "2026-11", [], null, [], "2026-11-22");
  assert.equal(current.elapsedDays, 22, "the current month counts only elapsed days");
  assert.ok(current.days.slice(22).every(day => !day.cents), "future days have no spending");
  assert.equal(shiftFinanceMonth("2026-01", -1), "2025-12");

  const year = financeYearFacts(ledger, "2026", [], "2026-12-02");
  assert.equal(year.latestMonth, 10);
  assert.equal(year.months[10].spentCents, facts.spentCents);
  assert.equal(year.categories.find(row => row.name === "居住")!.latestCents, 346_800);

  // 识别固定支出：连续 3 个月同商户同金额
  const suggestions = suggestFinanceRecurring([rent], ledger, "2026-11");
  assert.deepEqual(suggestions.map(item => [item.name, item.amountCents, item.day]), [["腾讯视频会员", 2500, 5]]);
  assert.equal(suggestFinanceRecurring([rent], ledger, "2026-10").length, 0, "needs three months in a row");
  assert.equal(financeRecurringEntries([{ ...gym, name: "乐刻" }], ledger).size, 1, "merchant names match by containment");

  // 一句话记账
  const context: FinanceQuickContext = { today: "2026-12-02", month: "2026-11", categories: ["居住", "餐饮", "购物", "交通", "娱乐", "其他"],
    accounts: ["微信", "支付宝", "招行信用卡"], merchants: [{ name: "瑞幸咖啡", category: "餐饮", account: "微信" }, { name: "京东", category: "购物", account: "招行信用卡" }] };
  assert.deepEqual(parseFinanceQuickEntry("15号 午饭 35 微信", context), { kind: "expense", amountCents: 3500, merchant: "午饭", category: "餐饮", account: "微信", date: "2026-11-15" });
  assert.deepEqual(parseFinanceQuickEntry("瑞幸 16", context), { kind: "expense", amountCents: 1600, merchant: "瑞幸咖啡", category: "餐饮", account: "微信", date: "2026-11-30" },
    "known merchants fill category and account; a past month defaults to its last day");
  const card = parseFinanceQuickEntry("打车 42.5 信用卡 昨天", context);
  assert.deepEqual([card.amountCents, card.category, card.account, card.date], [4250, "交通", "招行信用卡", "2026-12-01"]);
  const income = parseFinanceQuickEntry("稿费 1200", context);
  assert.equal(income.kind, "income");
  assert.equal(parseFinanceQuickEntry("午饭", context).amountCents, null, "missing amount stays empty for the user to fill");
  assert.equal(parseFinanceQuickEntry("12-31 年会 100", { ...context, month: "2026-12" }).date, "2026-12-02", "future dates clamp to today");

  for (const [input, expectedAmount, expectedDate] of [
    ["午饭 1,200", 120000, "2026-11-30"],
    ["午饭 1，200.50元", 120050, "2026-11-30"],
    ["咖啡 8.20元", 820, "2026-11-30"],
    ["8.20元 咖啡", 820, "2026-11-30"],
    ["咖啡 8.20", 820, "2026-11-30"],
    ["咖啡 ¥8.20", 820, "2026-11-30"],
    ["8.20 咖啡 12", 1200, "2026-08-20"],
    ["11/15 午饭 8.20元", 820, "2026-11-15"],
    ["午饭 1,20", null, "2026-11-30"]
  ] as const) {
    const draft = parseFinanceQuickEntry(input, context);
    assert.deepEqual([draft.amountCents, draft.date], [expectedAmount, expectedDate], input);
  }

  // 结账报告：事实由程序算，原话必须出自日记
  const journal = "---\ndate: 2026-11-11\n---\n早上开会。等了一年的降噪耳机终于下单，地铁上能安静读书了。晚上吃面。";
  assert.match(financeDiaryExcerpt(journal, ledger[9]), /降噪耳机终于下单/u);
  const play = entry("2026-11-20", "话剧《驴得水》", "娱乐", 280, { source: "diary", journalPath: "Journal/2026-11-20.md", description: "看话剧" });
  const playInput = buildFinanceMonthlyReportInput("2026-11", [play], null, [], new Map([["Journal/2026-11-20.md", "晚饭后出门。一个人去看了《驴得水》，散场时外面下起小雨。"]]), [], "2026-12-02");
  assert.equal(playInput.base.diary[0].quote, "一个人去看了《驴得水》，散场时外面下起小雨。", "titles in book-title marks match the diary sentence");
  const input = buildFinanceMonthlyReportInput("2026-11", ledger, budget, [rent, gym], new Map([["Journal/2026-11-11.md", journal]]), [], "2026-12-02");
  assert.equal(input.base.diary[0].quote, "降噪耳机", "without a mention of the merchant or amount the fallback is the entry description");
  assert.ok(input.excerpts[input.base.diary[0].entryId]);
  assert.equal(input.base.change?.category, "购物");
  assert.equal(input.base.change?.entry?.merchant, "京东");
  assert.equal(input.base.top[0].merchant, "京东");
  assert.equal(input.base.fixed?.cents, 319_900);
  assert.ok(input.text.includes("日记原文片段"));
  const id = input.base.diary[0].entryId;
  const report = parseFinanceMonthlyReportResponse(JSON.stringify({ version: 9, quotes: [{ id, quote: "等了一年的降噪耳机终于下单，地铁上能安静读书了。" }], suggestions: ["购物额度维持 ¥1,000", "x"] }), input);
  assert.equal(report.diary[0].quote, "等了一年的降噪耳机终于下单，地铁上能安静读书了。");
  assert.deepEqual(report.suggestions, ["购物额度维持 ¥1,000"], "too-short suggestions are dropped");
  const rewritten = parseFinanceMonthlyReportResponse(JSON.stringify({ version: 9, quotes: [{ id, quote: "终于买到了心心念念的耳机" }], suggestions: [] }), input);
  assert.equal(rewritten.diary[0].quote, "降噪耳机", "a rewritten quote is rejected in favour of the fallback");
  assert.throws(() => parseFinanceMonthlyReportResponse('{"version":8}', input), /暂时无法显示/u);
  assert.throws(() => parseFinanceMonthlyReportResponse("not json", input), /完整生成/u);
  const markdown = financeMonthlyReportMarkdown(report);
  const order = ["## 花了多少", "## 变化最大", "## 超预算", "## 最大三笔", "## 固定支出", "## 日记里的事", "## 下月可以试试"].map(title => markdown.indexOf(title));
  assert.ok(order.every((index, at) => index >= 0 && (at === 0 || index > order[at - 1])), "the seven sections keep their fixed order");
  assert.match(markdown, /> \[!quote\] \[\[Journal\/2026-11-11\|11-11 日记\]\] · 京东 支出 ¥1,149\n> 等了一年的降噪耳机/u);
  assert.match(markdown, /11 月花了 ¥4,808，比 10 月多 ¥1,283（\+36%）/u);
  const quiet = financeMonthlyReportMarkdown({ ...report, overs: [], diary: [], suggestions: [], fixed: null });
  assert.doesNotMatch(quiet, /超预算|日记里的事|下月可以试试|固定支出/u, "empty sections are left out entirely");
  const sharedDiary = { source: "diary", journalPath: "Journal/2026-11-11.md" } as const;
  const refunds = buildFinanceMonthlyReportInput("2026-11", [
    entry("2026-10-05", "上月来款", "其他", 100, { kind: "income" }),
    entry("2026-11-01", "房租", "居住", 3000),
    entry("2026-11-11", "退货", "购物", 3010, { ...sharedDiary, kind: "refund" }),
    entry("2026-11-11", "收到稿费", "其他", 20, { ...sharedDiary, kind: "income" }),
    entry("2026-11-11", "转入储蓄", "其他", 50, { ...sharedDiary, kind: "transfer",
      sourceLinks: [{ source: "wechat", sourceId: "linked-savings" }] })
  ], null, [rent], new Map([[sharedDiary.journalPath, "办了退货。收到稿费。转入储蓄。"]]), [], "2026-12-02");
  assert.equal(refunds.base.spentCents, -1000);
  assert.equal(refunds.base.incomeCents, 2000, "transfers are only diary context");
  assert.match(refunds.base.conclusion, /净支出为 −¥10（退款超过支出）.*少 ¥10/u);
  const modelFacts = JSON.parse(refunds.text);
  assert.equal(modelFacts.报告事实.支出, "−¥10");
  assert.deepEqual(modelFacts.日记候选.map((item: { 方向: string }) => item.方向), ["退款", "收入", "转账"]);
  const refundsReport = parseFinanceMonthlyReportResponse('{"version":9}', refunds);
  const refundsMarkdown = financeMonthlyReportMarkdown(refundsReport);
  assert.match(refundsMarkdown, /净支出为 −¥10（退款超过支出）.*少 ¥10/u);
  assert.doesNotMatch(refundsMarkdown, /（[+−]0%）|占支出/u, "zero or negative denominators do not produce a share");
  assert.match(refundsMarkdown, /退货 退款 ¥3,010/u);
  assert.match(refundsMarkdown, /收到稿费 收入 ¥20/u);
  assert.match(refundsMarkdown, /转入储蓄 转账 ¥50/u);
  const negativeBaseline = financeMonthlyReportMarkdown({ ...refundsReport, previous: { month: "2026-10", cents: -2500 } });
  assert.match(negativeBaseline, /比 10 月多 ¥15，/u);
  assert.doesNotMatch(negativeBaseline, /（[+−]\d+%）/u);
  const legacyDiary = financeMonthlyReportMarkdown({ ...refundsReport, diary: [{ ...refundsReport.diary[0], kind: undefined }] });
  assert.match(legacyDiary, /退货 退款 ¥3,010/u, "older v9 reports retain their diary direction");
  console.log("PASS finance monthly review: month/year facts, fixed charges and detection, one-line entry, fixed report with verbatim diary quotes");
}
