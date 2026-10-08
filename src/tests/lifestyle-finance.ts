import assert from "node:assert/strict";
import { allocateBudgetByPercent, budgetUnallocated, classifyImport, filterFinanceEntries, financeSpendingFacts, financeSummary, formatExcelWallTime, localDate, readFinanceBill, validateBudget } from "../lifestyle/finance-domain";
import { organizeFinanceRows } from "../lifestyle/finance-import";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import type { FinanceImportRow } from "../lifestyle/finance-domain";

export async function runLifestyleFinanceTests(): Promise<void> {
  const header = "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注";
  const parse = (line: string) => readFinanceBill(new TextEncoder().encode(`${header}\n${line}\n`), "wechat.csv", "wechat");

  const transfer = await parse("2026-09-20 10:00:00,转账,朋友,还款,收入,100.00,微信,已存入零钱,W-1");
  assert.equal(transfer[0].entry?.kind, "income", "来自他人的转账收入必须计入收入");
  assert.equal(financeSummary([transfer[0].entry!], "2026-09").incomeCents, 10_000);

  const refundedOriginal = await parse("2026-09-21 10:00:00,商户消费,商店,商品,支出,100.00,微信,已全额退款,W-2");
  assert.equal(refundedOriginal[0].entry?.kind, "expense", "已全额退款的原支出仍需保留");
  assert.equal(refundedOriginal[0].entry?.amountCents, 10_000);
  const refund = await parse("2026-09-22 10:00:00,退款,商店,退货,收入,100.00,微信,已存入零钱,W-3");
  assert.equal(refund[0].entry?.kind, "refund", "独立退款流水按自己日期入账");
  assert.equal(financeSummary([refundedOriginal[0].entry!, refund[0].entry!], "2026-09").netExpenseCents, 0);

  // Synthetic personal-statement shape; no private transaction data.
  const alipayHeader = "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,";
  const alipayLine = (id: string, order: string, amount: string, state: string, direction = "支出", type = "日用百货", date = "2026-09-20 10:00:00", account = "合成付款账户") =>
    `${date},${type},合成商户,PRIVATE_COUNTERPARTY_ACCOUNT,合成商品,${direction},${amount},${account},${state},${id},${order},合成备注,`;
  const parseAlipay = (lines: string[]) => readFinanceBill(new TextEncoder().encode(
    `${Array.from({ length: 23 }, () => "合成账单说明").join("\n")}\n${alipayHeader}\n${lines.join("\n")}\n,\n`), "alipay.csv", "alipay");
  const alipayId = "000123456789012345678901234567890";
  const alipayRows = await parseAlipay([
    alipayLine(`\t${alipayId}\t`, "ORDER-FULL", "80.00", "交易关闭"),
    alipayLine("REFUND-FULL", "ORDER-FULL", "80.00", "退款成功", "不计收支", "退款", "2026-09-21 10:00:00"),
    alipayLine("PURCHASE-PARTIAL", "ORDER-PARTIAL", "100.00", "交易成功"),
    alipayLine("REFUND-PARTIAL", "ORDER-PARTIAL", "30.00", "退款成功", "不计收支", "退款", "2026-09-21 10:00:00"),
    alipayLine("WAIT-SHIP", "", "20.00", "等待发货"),
    alipayLine("WAIT-RECEIVE", "", "25.00", "等待确认收货"),
    alipayLine("INCOME", "", "50.00", "交易成功", "收入", "转账"),
    alipayLine("TRANSFER", "", "0.02", "交易成功", "不计收支", "其他"),
    alipayLine("UNMATCHED-CLOSED", "ORDER-NO-REFUND", "10.00", "交易关闭"),
    alipayLine("UNKNOWN", "", "1.00", "处理中")
  ]);
  assert.equal(alipayRows.length, 10);
  assert.equal(alipayRows[0].entry?.sourceId, alipayId, "trim whitespace without losing leading zeros or long order digits");
  assert.deepEqual([alipayRows[0].entry?.description, alipayRows[0].entry?.account], ["合成商品", "合成付款账户"]);
  assert.equal(alipayRows[0].sourceFields?.transactionType, "日用百货");
  assert.equal(alipayRows[0].sourceFields?.state, "交易关闭", "refund proof changes effective status, not the source state");
  assert.equal(alipayRows[0].entry?.status, "completed");
  assert.equal(alipayRows[1].entry?.kind, "refund");
  assert.notEqual(alipayRows[0].entry?.sourceId, alipayRows[1].entry?.sourceId, "purchase and refund keep distinct transaction identities");
  assert.ok(alipayRows.slice(4, 6).every((row) => row.entry?.status === "completed"), "paid fulfillment states count as completed");
  assert.equal(alipayRows[7].entry?.kind, "transfer");
  assert.equal(alipayRows[8].entry?.status, "failed");
  assert.equal(alipayRows[9].entry, null, "unknown status remains in problem preview");
  const alipaySummary = financeSummary(classifyImport([], alipayRows).added, "2026-09");
  assert.deepEqual([alipaySummary.grossExpenseCents, alipaySummary.refundCents, alipaySummary.netExpenseCents, alipaySummary.incomeCents],
    [22500, 11000, 11500, 5000], "full and partial refunds retain their original spending; transfer is excluded");
  assert.equal(classifyImport(classifyImport([], alipayRows).added, alipayRows).added.length, 0);
  const duplicateRefund = alipayLine("HALF-REFUND", "ORDER-HALF", "50.00", "退款成功", "不计收支", "退款", "2026-09-21 10:00:00");
  const repeatedRefundRows = await parseAlipay([alipayLine("CLOSED-HALF", "ORDER-HALF", "100.00", "交易关闭"), duplicateRefund, duplicateRefund]);
  assert.equal(repeatedRefundRows[0].entry?.status, "failed", "duplicate refund IDs cannot fabricate a full-refund proof");
  assert.equal(classifyImport([], repeatedRefundRows).duplicates, 1);
  for (const [order, date, account] of [["OTHER-ORDER", "2026-09-21 10:00:00", "合成付款账户"],
    ["PROOF-ORDER", "2026-09-19 10:00:00", "合成付款账户"], ["PROOF-ORDER", "2026-09-21 10:00:00", "其他账户"]]) {
    const unproven = await parseAlipay([alipayLine("CLOSED-PROOF", "PROOF-ORDER", "10.00", "交易关闭"),
      alipayLine("REFUND-PROOF", order, "10.00", "退款成功", "不计收支", "退款", date, account)]);
    assert.equal(unproven[0].entry?.status, "failed", "order, chronology and payment account must support the association");
  }
  const waitingWechat = await parse("2026-09-22 10:00:00,商户消费,商店,商品,支出,1.00,微信,等待发货,WAIT-WECHAT");
  assert.equal(waitingWechat[0].entry, null, "Alipay fulfillment rules do not expand WeChat status handling");
  const fallbackIds = await parseAlipay([
    alipayLine("", "SAME-MERCHANT-ORDER", "10.00", "交易成功"),
    alipayLine("", "SAME-MERCHANT-ORDER", "10.00", "退款成功", "不计收支", "退款", "2026-09-21 10:00:00")
  ]);
  assert.notEqual(fallbackIds[0].entry?.sourceId, fallbackIds[1].entry?.sourceId, "merchant order is not a fallback event identity for Alipay");
  const unknownAlipay = await parseAlipay([alipayLine("UNKNOWN-SUCCESS-TEXT", "", "1.00", "等待交易成功")]);
  assert.equal(unknownAlipay[0].entry, null, "an unsupported Alipay state is not successful just because it contains a known state");
  const legacyAlipay = await readFinanceBill(new TextEncoder().encode(
    `${alipayHeader.replace("交易订单号", "交易号")}\n${alipayLine("000-LEGACY", "", "1.00", "交易成功")}\n`), "alipay-legacy.csv", "alipay");
  assert.equal(legacyAlipay[0].entry?.sourceId, "000-LEGACY", "legacy transaction-ID header remains supported");

  const previousTz = process.env.TZ;
  process.env.TZ = "Asia/Bangkok";
  try { assert.equal(formatExcelWallTime(new Date(Date.UTC(2026, 8, 30, 20, 23, 0))), "2026-09-30 20:23:00"); }
  finally { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; }

  const unknown = await parse("2026-09-22 10:00:00,商户消费,商店,商品,支出,1.00,/,处理中,W-unknown");
  assert.equal(unknown[0].entry, null, "未知状态不得记成已完成");
  assert.match(unknown[0].error, /待核对/u);

  const missingAmount = await parse("2026-09-22 10:00:00,商户消费,商店,商品,支出,,微信,支付成功,W-3");
  assert.equal(missingAmount[0].entry, null, "有交易单号但缺金额的行必须进入异常预览");
  assert.equal(classifyImport([], missingAmount).invalid, 1);

  const old = { ...transfer[0].entry!, status: "failed" as const, category: "其他", note: "我手写的备注" };
  const result = classifyImport([old], transfer);
  assert.equal(result.updated.length, 1);
  assert.equal(result.updated[0].category, "其他");
  assert.equal(result.updated[0].note, "我手写的备注", "重导账单不能覆盖人工备注");

  const longId = "1234567890123456789012345678901234567890";
  const merchantOrderId = "MERCHANT_ORDER_PRIVATE_123456789";
  const keyword = await parse(`2026-09-20 12:00:00,商户消费,淘宝,外卖,支出,12.34,/,支付成功,${longId},${merchantOrderId},备注仅用于语义`);
  assert.equal(keyword[0].entry?.sourceId, longId);
  assert.equal(keyword[0].entry?.account, "微信", "斜杠支付方式视为缺失");
  const settings = structuredClone(DEFAULT_LIFESTYLE_SETTINGS.finance);
  settings.merchants.push({ name: "我的淘宝", aliases: ["淘宝"], iconId: "taobao", defaultCategory: "购物", active: true });
  let called = 0;
  const organized = await organizeFinanceRows(keyword, settings, [], {
    signal: new AbortController().signal, skillContent: "test skill",
    generate: async (_system, prompt) => {
      called++;
      assert.equal(prompt.includes(longId), false, "模型输入不能含完整交易单号");
      assert.equal(prompt.includes(merchantOrderId), false, "模型输入不能含完整商户单号");
      assert.match(prompt, /备注仅用于语义/u, "有效备注应参与语义整理");
      assert.match(prompt, /淘宝/u, "关键词已命中的普通行仍须进入模型");
      const sent = JSON.parse(prompt) as { rows: { brandCandidates: unknown[]; merchantCandidates: unknown[]; noMatchAllowed: boolean }[] };
      assert.ok(sent.rows[0].brandCandidates.length <= 4, "每行只给少量品牌候选");
      assert.ok(sent.rows[0].merchantCandidates.length <= 8, "每行只给少量商户候选");
      assert.equal(sent.rows[0].noMatchAllowed, true);
      return JSON.stringify({ rows: [{ ref: 0, merchant: "模型改名", description: "平台消费", category: "餐饮", account: "零钱", iconId: "meituan", kind: "transfer", reason: "普通转账", review: "" }] });
    }
  });
  assert.equal(called, 1);
  assert.equal(organized.rows[0].entry?.merchant, "我的淘宝", "用户别名优先于模型");
  assert.equal(organized.rows[0].entry?.category, "购物", "用户默认分类优先于模型");
  assert.equal(organized.rows[0].entry?.icon, "taobao", "用户图标优先于模型");
  assert.equal(organized.rows[0].entry?.kind, "expense", "没有本人互转证据不能改业务类型");
  assert.equal(organized.rows[0].entry?.kind, "expense", "模型不能改已入库的业务类型");

  const partial = await organizeFinanceRows(keyword, settings, [], {
    signal: new AbortController().signal, skillContent: "test skill", generate: async () => '{"rows":[]}'
  });
  assert.match(partial.rows[0].review || "", /未返回有效建议/u);
  const malformed = await organizeFinanceRows(keyword, settings, [], {
    signal: new AbortController().signal, skillContent: "test skill", generate: async () => "not json"
  });
  assert.equal(malformed.warnings.length, 1);
  assert.match(malformed.rows[0].review || "", /智能整理失败/u);
  const normalChoice = await organizeFinanceRows(keyword, settings, [], {
    signal: new AbortController().signal, skillContent: "test skill",
    generate: async () => JSON.stringify({ rows: [{ ref: 0, category: "购物", kind: "expense" }] })
  });
  assert.equal(normalChoice.rows[0].review || "", "", "正常结构化选择不强制自由文本理由");
  const secondRecord: FinanceImportRow = { ...keyword[0], entry: { ...keyword[0].entry!, id: "same-content-second", sourceId: "same-content-second" } };
  let processedRecords = 0;
  const grouped = await organizeFinanceRows([keyword[0], secondRecord], structuredClone(DEFAULT_LIFESTYLE_SETTINGS.finance), [], {
    signal: new AbortController().signal, skillContent: "test skill",
    generate: async () => JSON.stringify({ rows: [{ ref: 0, category: "餐饮" }] }),
    onProgress: (_done, _total, batchRows) => { processedRecords += batchRows.length; }
  });
  assert.equal(grouped.rows.length, 2);
  assert.equal(processedRecords, 2, "进度按实际账目笔数而非去重后的模型候选数");
  const cleanedText = await organizeFinanceRows(keyword, structuredClone(DEFAULT_LIFESTYLE_SETTINGS.finance), [], {
    signal: new AbortController().signal, skillContent: "test skill",
    generate: async () => JSON.stringify({ rows: [{ ref: 0, merchant: "整理后的商户", description: "整理后的说明", category: "餐饮" }] })
  });
  assert.equal(cleanedText.rows[0].review || "", "", "仅整理商户和说明不要求逐笔确认");
  const explicitReview = await organizeFinanceRows(keyword, structuredClone(DEFAULT_LIFESTYLE_SETTINGS.finance), [], {
    signal: new AbortController().signal, skillContent: "test skill",
    generate: async () => JSON.stringify({ rows: [{ ref: 0, merchant: "整理后的商户", category: "餐饮", review: "分类仍不确定" }] })
  });
  assert.match(explicitReview.rows[0].review || "", /分类仍不确定/u, "模型明确不确定仍需确认");
  settings.merchants.push({ name: "星河咖啡", aliases: [], iconId: "taobao", defaultCategory: "餐饮", active: true });
  const nearMatch = await parse("2026-09-20 12:00:00,商户消费,星合咖啡,拿铁,支出,20.00,零钱,支付成功,SYNTHETIC-NEAR");
  const picked = await organizeFinanceRows(nearMatch, settings, [], {
    signal: new AbortController().signal, skillContent: "test skill",
    generate: async () => JSON.stringify({ rows: [{ ref: 0, merchantChoice: "m0", category: "购物", iconId: "none", kind: "expense" }] })
  });
  assert.equal(picked.rows[0].entry?.merchant, "星河咖啡");
  assert.equal(picked.rows[0].entry?.category, "餐饮", "选中用户商户后沿用其默认分类");
  assert.equal(picked.rows[0].entry?.icon, "taobao", "选中用户商户后沿用其显式图标");
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(organizeFinanceRows(keyword, settings, [], {
    signal: aborted.signal, skillContent: "test skill", generate: async () => { throw new Error("不应调用模型"); }
  }), /取消/u);
  const inFlight = new AbortController();
  await assert.rejects(organizeFinanceRows(keyword, settings, [], {
    signal: inFlight.signal, skillContent: "test skill", generate: async () => {
      inFlight.abort(); return '{"rows":[]}';
    }
  }), /取消/u);

  const budget = allocateBudgetByPercent("2026-09", 10_001, { "旅行": 3333, "餐饮": 3333 }, ["餐饮", "旅行", "其他"]);
  validateBudget(budget);
  assert.equal(budgetUnallocated(budget) + Object.values(budget.allocations).reduce((sum, value) => sum + value, 0), 10_001);
  assert.ok("旅行" in budget.allocations, "自定义分类参与预算");
  const retained = { ...budget, allocations: { ...budget.allocations, "旧分类": 101 } };
  assert.equal(budgetUnallocated(retained), budgetUnallocated(budget) - 101, "停用后的历史预算键仍计入未分配");
  assert.equal(financeSummary([{ ...keyword[0].entry!, category: "旅行" }], "2026-09").categoryExpenseCents["旅行"], 1234);
  const amounts = [4_999, 5_000, 19_999, 20_000, 49_999, 50_000, 99_999, 100_000];
  const entries = amounts.map((amountCents, index) => ({ ...keyword[0].entry!, id: `bin-${index}`, amountCents,
    category: index === 0 ? "" : index === 1 ? "其他" : "餐饮", account: index === 0 ? "" : "零钱" }));
  entries.push({ ...entries[0], id: "refund", kind: "refund", amountCents: 8_000 });
  entries.push({ ...entries[0], id: "failed", status: "failed", amountCents: 50_000 });
  entries.push({ ...entries[0], id: "foreign", currency: "USD", amountCents: 50_000 });
  entries.push({ ...entries[0], id: "future", date: "2026-09-22 10:00:00", amountCents: 50_000 });
  const spending = financeSpendingFacts(entries, "2026-09", "2026-09-21");
  assert.deepEqual(spending.bins.map((bin) => bin.count), [1, 2, 2, 2, 1], "cent boundaries are exclusive at the upper edge");
  assert.equal(spending.expenses.length, 8);
  assert.equal(spending.refundsCents, 8_000);
  assert.equal(spending.categories.find(([category]) => category === "")?.[1].count, 1, "empty category keeps its raw key");
  assert.equal(spending.accounts.find(([account]) => account === "")?.[1].count, 1, "unspecified account remains distinct");
  const chartRows = filterFinanceEntries(entries, "2026-09", { search: "", merchant: "", category: "", kind: "all", account: "",
    excludedCategories: [], excludedIds: [], validExpenseOnly: true, minCents: 5_000, maxCents: 20_000 });
  assert.deepEqual(chartRows.map((item) => item.amountCents).sort((a, b) => a - b), [5_000, 19_999]);
  const uncategorized = filterFinanceEntries(entries.filter((item) => item.id !== "future"), "2026-09", { search: "", merchant: "", category: "", kind: "all", account: "",
    excludedCategories: [], excludedIds: [], validExpenseOnly: true, exactCategory: "" });
  assert.equal(uncategorized.length, 1);
  assert.equal(localDate(new Date(2026, 8, 30)).slice(0, 7), "2026-09");
}
