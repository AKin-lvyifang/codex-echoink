import { readSheet } from "read-excel-file/node";
import type { FinanceBudget, FinanceEntry, FinanceKind } from "./store";
import { lifeId } from "./store";

export const FINANCE_CATEGORIES = ["居住", "餐饮", "购物", "交通", "订阅", "其他"] as const;
export type FinanceCategory = string;

export function parseYuan(value: string, allowZero = false): number {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(text)) throw new Error("金额须为非负数字，最多两位小数");
  const [yuan, fen = ""] = text.split(".");
  const cents = Number(yuan) * 100 + Number(fen.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || (!allowZero && cents <= 0)) throw new Error("金额须大于 0");
  return cents;
}

export function money(cents: number): string {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function effectiveFinanceEntries(entries: readonly FinanceEntry[], month: string, today = localDate()): FinanceEntry[] {
  return entries.filter((entry) => (!month || entry.date.slice(0, 7) === month) && entry.date.slice(0, 10) <= today
    && entry.status === "completed" && entry.currency === "CNY");
}

export const FINANCE_AMOUNT_BINS = [
  { label: "<50 元", minCents: 0, maxCents: 5_000 },
  { label: "50–200 元", minCents: 5_000, maxCents: 20_000 },
  { label: "200–500 元", minCents: 20_000, maxCents: 50_000 },
  { label: "500–1000 元", minCents: 50_000, maxCents: 100_000 },
  { label: "≥1000 元", minCents: 100_000, maxCents: null }
] as const;

export function financeSpendingFacts(entries: readonly FinanceEntry[], month: string, today = localDate()) {
  const valid = effectiveFinanceEntries(entries, month, today);
  const expenses = valid.filter((entry) => entry.kind === "expense" && entry.amountCents > 0);
  const refundsCents = valid.filter((entry) => entry.kind === "refund").reduce((sum, entry) => sum + entry.amountCents, 0);
  const category = new Map<string, { amountCents: number; count: number }>();
  const account = new Map<string, { amountCents: number; count: number }>();
  const day = new Map<string, { amountCents: number; count: number }>();
  const bins = FINANCE_AMOUNT_BINS.map((bin) => ({ ...bin, amountCents: 0, count: 0 }));
  for (const entry of expenses) {
    const add = (map: Map<string, { amountCents: number; count: number }>, key: string) => {
      const value = map.get(key) ?? { amountCents: 0, count: 0 };
      value.amountCents += entry.amountCents; value.count++; map.set(key, value);
    };
    add(category, entry.category);
    const accountKey = entry.account;
    const current = account.get(accountKey) ?? { amountCents: 0, count: 0 };
    current.amountCents += entry.amountCents; current.count++; account.set(accountKey, current);
    add(day, entry.date.slice(0, 10));
    const bin = bins.find((item) => entry.amountCents >= item.minCents && (item.maxCents === null || entry.amountCents < item.maxCents));
    if (bin) { bin.amountCents += entry.amountCents; bin.count++; }
  }
  const rank = <T extends { amountCents: number }>(map: Map<string, T>) => [...map].sort((a, b) => b[1].amountCents - a[1].amountCents || a[0].localeCompare(b[0], "zh-CN"));
  return { valid, expenses, grossCents: expenses.reduce((sum, entry) => sum + entry.amountCents, 0), refundsCents,
    categories: rank(category), accounts: rank(account), days: day, bins };
}

export interface FinanceSummary {
  incomeCents: number; grossExpenseCents: number; refundCents: number;
  netExpenseCents: number; balanceCents: number; savingsRate: number | null;
  effectiveCount: number; categoryExpenseCents: Record<FinanceCategory, number>;
}

export function financeSummary(entries: readonly FinanceEntry[], month: string, categories: readonly string[] = FINANCE_CATEGORIES): FinanceSummary {
  const current = effectiveFinanceEntries(entries, month);
  const incomeCents = current.filter((entry) => entry.kind === "income").reduce((sum, entry) => sum + entry.amountCents, 0);
  const grossExpenseCents = current.filter((entry) => entry.kind === "expense").reduce((sum, entry) => sum + entry.amountCents, 0);
  const refundCents = current.filter((entry) => entry.kind === "refund").reduce((sum, entry) => sum + entry.amountCents, 0);
  const categoryExpenseCents = Object.fromEntries([...new Set([...categories, ...current.map((entry) => entry.category)])].map((category) => [category, 0])) as Record<FinanceCategory, number>;
  for (const entry of current) {
    if (entry.kind !== "expense" && entry.kind !== "refund") continue;
    categoryExpenseCents[entry.category] += entry.kind === "expense" ? entry.amountCents : -entry.amountCents;
  }
  const netExpenseCents = grossExpenseCents - refundCents;
  const balanceCents = incomeCents - netExpenseCents;
  return {
    incomeCents, grossExpenseCents, refundCents, netExpenseCents, balanceCents,
    savingsRate: incomeCents > 0 ? balanceCents / incomeCents : null,
    effectiveCount: current.filter((entry) => entry.kind !== "transfer").length,
    categoryExpenseCents
  };
}

export interface FinanceFilters {
  search: string; merchant: string; category: string; kind: "all" | "spending" | FinanceKind;
  account: string; excludedCategories: string[]; excludedIds: string[];
  date?: string; minCents?: number; maxCents?: number | null; validExpenseOnly?: boolean; exactAccount?: string; exactCategory?: string;
}

export function filterFinanceEntries(entries: readonly FinanceEntry[], month: string, filters: FinanceFilters): FinanceEntry[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (!entry.date.startsWith(month)) return false;
    if (filters.validExpenseOnly && (entry.kind !== "expense" || entry.status !== "completed" || entry.currency !== "CNY" || entry.date.slice(0, 10) > localDate())) return false;
    if (filters.date && entry.date.slice(0, 10) !== filters.date) return false;
    if (filters.minCents !== undefined && entry.amountCents < filters.minCents) return false;
    if (filters.maxCents != null && entry.amountCents >= filters.maxCents) return false;
    if (filters.exactAccount !== undefined && entry.account !== filters.exactAccount) return false;
    if (filters.exactCategory !== undefined && entry.category !== filters.exactCategory) return false;
    if (query && !`${entry.merchant} ${entry.description} ${entry.note}`.toLocaleLowerCase().includes(query)) return false;
    if (filters.merchant && entry.merchant !== filters.merchant) return false;
    if (filters.category && entry.category !== filters.category) return false;
    if (filters.kind === "spending" && entry.kind !== "expense" && entry.kind !== "refund") return false;
    if (filters.kind !== "all" && filters.kind !== "spending" && entry.kind !== filters.kind) return false;
    if (filters.account && entry.account !== filters.account) return false;
    if (filters.excludedCategories.includes(entry.category)) return false;
    if (filters.excludedIds.includes(entry.id)) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

export function budgetUnallocated(budget: FinanceBudget): number {
  return budget.totalCents - Object.values(budget.allocations).reduce((sum, value) => sum + value, 0);
}

export function validateBudget(budget: FinanceBudget): void {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(budget.month)) throw new Error("预算月份无效");
  if (!Number.isSafeInteger(budget.totalCents) || budget.totalCents < 100 || budget.totalCents > 9_999_999_900) throw new Error("总预算须为 1–99,999,999 元");
  for (const [category, value] of Object.entries(budget.allocations)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${category}预算金额无效`);
  }
  if (budgetUnallocated(budget) < 0) throw new Error("分类预算合计超过月总额");
}

export function parsePercent(value: string): number {
  const text = value.trim().replace(/%$/u, "");
  if (!/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$|^100(?:\.0{1,2})?$/u.test(text)) throw new Error("比例须为 0–100%，最多两位小数");
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function allocateBudgetByPercent(month: string, totalCents: number, percentages: Record<string, number>, categories: readonly string[] = [...FINANCE_CATEGORIES, ...Object.keys(percentages)]): FinanceBudget {
  const names = [...new Set(categories)];
  const sum = names.reduce((value, category) => value + (percentages[category] ?? 0), 0);
  if (sum > 10_000 || sum < 0) throw new Error("分类比例合计不能超过 100%");
  const ratios = [...names.map((category) => percentages[category] ?? 0), 10_000 - sum];
  if (ratios.some((ratio) => !Number.isSafeInteger(ratio) || ratio < 0 || ratio > 10_000)) throw new Error("分类比例无效");
  const floors = ratios.map((ratio) => Math.floor(totalCents * ratio / 10_000));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = ratios.map((ratio, index) => ({ index, fraction: (totalCents * ratio) % 10_000 }))
    .filter((item) => ratios[item.index] > 0)
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remainder > 0; index++, remainder--) floors[order[index % order.length].index]++;
  const allocations = Object.fromEntries(names.map((category, index) => [category, floors[index]]));
  const budget = { month, totalCents, allocations };
  validateBudget(budget);
  return budget;
}

export function financeEntryCsv(entries: readonly FinanceEntry[]): string {
  const quote = (value: string) => `"${value.replace(/"/gu, '""')}"`;
  const header = ["日期", "类型", "商户", "消费说明", "分类", "账户", "金额", "币种", "备注", "账单计划 ID"];
  const rows = entries.map((entry) => [entry.date, entry.kind, entry.merchant, entry.description, entry.category, entry.account, money(entry.amountCents), entry.currency, entry.note, entry.billPlanId || ""]);
  return "\uFEFF" + [header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export type FinanceImportSource = "wechat" | "alipay";
export interface FinanceImportRow {
  entry: FinanceEntry | null; error: string; raw: string[];
  sourceFields?: { counterparty: string; product: string; transactionType: string; paymentMethod: string; direction: string; state: string; merchantOrderId: string; note: string };
  review?: string;
  reason?: string;
}

function headerKey(value: string): string { return value.replace(/[\s\uFEFF()（）/\\]/gu, "").toLocaleLowerCase(); }
function cell(row: readonly string[], header: readonly string[], names: readonly string[]): string {
  for (const name of names) {
    const index = header.findIndex((key) => key === headerKey(name));
    if (index >= 0) return String(row[index] ?? "").trim();
  }
  return "";
}
const meaningful = (value: string): string => value === "/" ? "" : value;

function billSourceFields(row: readonly string[], header: readonly string[], source: FinanceImportSource): NonNullable<FinanceImportRow["sourceFields"]> {
  return {
    counterparty: meaningful(cell(row, header, ["交易对方", "对方", "商家", "商户"])),
    product: meaningful(cell(row, header, ["商品说明", "商品", "商品名称"])),
    transactionType: cell(row, header, ["交易分类", "交易类型", "类型"]),
    paymentMethod: meaningful(cell(row, header, ["收/付款方式", "支付方式", "支付账户", "资金渠道"])),
    direction: cell(row, header, ["收支", "收/支", "收入/支出"]),
    state: cell(row, header, ["当前状态", "交易状态", "状态"]),
    merchantOrderId: meaningful(cell(row, header, source === "wechat" ? ["商户单号"] : ["商家订单号", "订单号"])),
    note: meaningful(cell(row, header, ["备注", "交易备注"]))
  };
}

/** A closed Alipay purchase is retained only when this file proves its full refund. */
function retainRefundedAlipayPurchases(rows: FinanceImportRow[]): void {
  const groups = new Map<string, Map<string, FinanceImportRow>>();
  for (const row of rows) {
    const orderId = row.sourceFields?.merchantOrderId;
    if (!row.entry || !orderId) continue;
    let group = groups.get(orderId);
    if (!group) { group = new Map(); groups.set(orderId, group); }
    if (!group.has(row.entry.sourceId)) group.set(row.entry.sourceId, row);
  }
  for (const row of rows) {
    const original = row.entry, source = row.sourceFields;
    if (!original || !source || original.kind !== "expense" || source.state !== "交易关闭"
      || !source.counterparty || !source.paymentMethod || !source.merchantOrderId) continue;
    const group = [...(groups.get(source.merchantOrderId)?.values() ?? [])];
    if (group.filter((item) => item.entry?.kind === "expense").length !== 1) continue;
    const refunds = group.filter((item) => item.entry?.kind === "refund" && item.entry.status === "completed"
      && item.entry.date > original.date && item.sourceFields?.counterparty === source.counterparty
      && item.sourceFields.paymentMethod === source.paymentMethod);
    if (refunds.length && refunds.reduce((sum, item) => sum + item.entry!.amountCents, 0) === original.amountCents) {
      original.status = "completed";
      row.review = "原支出已全额退款；按账单内独立退款流水分别入账";
    }
  }
}

/** read-excel-file encodes timezone-free Excel wall time in UTC Date fields. */
export function formatExcelWallTime(value: Date): string {
  return new Date(Math.round(value.getTime() / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function parseImportedDate(value: string): string {
  const matched = value.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:[ T日]*(\d{1,2}):?(\d{2})?:?(\d{2})?)?/u);
  if (!matched) throw new Error("日期无法识别");
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = matched;
  const result = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}`;
  const date = new Date(result.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) throw new Error("日期无效");
  return result;
}

export async function readFinanceBill(bytes: Uint8Array, fileName: string, source: FinanceImportSource): Promise<FinanceImportRow[]> {
  let rows: string[][];
  if (/\.xlsx$/iu.test(fileName)) {
    const sheet = await readSheet(Buffer.from(bytes));
    rows = sheet.map((row) => row.map((value) => value instanceof Date
      ? formatExcelWallTime(value)
      : String(value ?? "")));
  } else if (/\.csv$/iu.test(fileName)) {
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.includes("\uFFFD")) text = new TextDecoder("gb18030").decode(bytes);
    rows = parseCsv(text);
  } else throw new Error("只支持 CSV 或 XLSX 账单");
  const headerIndex = rows.findIndex((row) => row.some((value) => /交易时间|交易创建时间|付款时间/u.test(value)) && row.some((value) => /金额/u.test(value)));
  if (headerIndex < 0) throw new Error("未识别到账单表头，请选择微信或支付宝的明细导出文件");
  const header = rows[headerIndex].map(headerKey);
  const results: FinanceImportRow[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (!row.some((value) => String(value).trim())) continue;
    const sourceFields = billSourceFields(row, header, source);
    try {
      const rawDate = cell(row, header, ["交易时间", "付款时间", "交易创建时间"]);
      const amount = cell(row, header, ["金额元", "金额", "交易金额"]);
      const rawId = source === "wechat" ? meaningful(cell(row, header, ["交易单号"])) || sourceFields.merchantOrderId
        : meaningful(cell(row, header, ["交易订单号"])) || meaningful(cell(row, header, ["交易号"]));
      if (!rawDate && !amount && !rawId) continue;
      if (!rawDate) throw new Error("交易日期缺失，需核对账单原行");
      if (!amount) throw new Error("交易金额缺失，需核对账单原行");
      const date = parseImportedDate(rawDate);
      const { counterparty, product, transactionType, paymentMethod, direction, state, note } = sourceFields;
      const merchant = counterparty || "未命名商户";
      const description = product || transactionType;
      const kind: FinanceKind = /退款/u.test(transactionType)
        && (source === "alipay" ? state === "退款成功" : /收入|收款/u.test(direction)) ? "refund"
        : /收入|收款/u.test(direction) ? "income"
        : /支出|付款/u.test(direction) ? "expense"
        : source === "alipay" && /^不计收\/?支$/u.test(direction) ? "transfer"
        : (() => { throw new Error("收支方向无法识别，需核对账单原行"); })();
      const status = /失败|关闭|未支付|已取消/u.test(state) ? "failed"
        : (source === "alipay" ? /^(交易成功|支付成功|退款成功|等待发货|等待确认收货)$/u
          : /支付成功|已存入零钱|已全额退款|交易成功|退款成功/u).test(state) ? "completed"
        : (() => { throw new Error("交易状态待核对，未自动入账"); })();
      const amountCents = parseYuan(amount.replace(/[￥¥,\s]/gu, ""));
      const sourceId = rawId || `${date}|${merchant}|${amountCents}|${kind}|${description}`;
      results.push({ entry: {
        id: lifeId("entry"), source, sourceId, date, merchant,
        description, category: "其他", kind,
        amountCents, status, account: paymentMethod || (source === "wechat" ? "微信" : "支付宝"),
        currency: "CNY", note
      }, error: "", raw: row, sourceFields,
      review: /已全额退款/u.test(state) && kind === "expense" ? "原支出已退款；仅在账单存在独立退款流水时扣减" : "" });
    } catch (error) {
      results.push({ entry: null, error: error instanceof Error ? error.message : String(error), raw: row, sourceFields });
    }
  }
  if (source === "alipay") retainRefundedAlipayPurchases(results);
  if (!results.length) throw new Error("账单中没有可识别的交易行");
  return results;
}

export function classifyImport(existing: readonly FinanceEntry[], rows: readonly FinanceImportRow[]): { added: FinanceEntry[]; updated: FinanceEntry[]; duplicates: number; invalid: number } {
  const added: FinanceEntry[] = [], updated: FinanceEntry[] = [];
  let duplicates = 0, invalid = 0;
  const known = new Map(existing.map((entry) => [`${entry.source}:${entry.sourceId}`, entry]));
  for (const row of rows) {
    if (!row.entry) { invalid++; continue; }
    const key = `${row.entry.source}:${row.entry.sourceId}`;
    const previous = known.get(key);
    if (!previous) { added.push(row.entry); known.set(key, row.entry); }
    else if (previous.status !== row.entry.status) {
      const replacement = { ...previous, status: row.entry.status };
      updated.push(replacement); known.set(key, replacement);
    } else duplicates++;
  }
  return { added, updated, duplicates, invalid };
}
