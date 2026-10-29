import type { FinanceEntry } from "./store-core";

export const FINANCE_SOURCE_LABELS: Record<FinanceEntry["source"], string> = {
  manual: "手动", wechat: "微信", alipay: "支付宝", diary: "日记（AI）"
};
export type DiaryFinanceInput = Omit<FinanceEntry, "id" | "source" | "sourceId" | "journalPath" | "sourceLinks"> & {
  /** Every close candidate explicitly judged to be a distinct transaction, bound to its snapshot. */
  reviewedDistinct?: { id: string; version: string }[];
};

export function validFinanceDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === `${year}-${month}-${day}`
    && (hour === undefined || Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60);
}

/** Retrieval only. An equal date and amount never proves that two entries are the same. */
export function diaryFinanceCandidates(existing: readonly FinanceEntry[], input: Pick<FinanceEntry, "kind" | "currency" | "amountCents" | "date">): FinanceEntry[] {
  const date = Date.parse(`${input.date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date)) return [];
  return existing.filter(entry => entry.status === "completed" && entry.kind === input.kind && entry.currency === input.currency
    && entry.amountCents === input.amountCents && Math.abs(Date.parse(`${entry.date.slice(0, 10)}T00:00:00Z`) - date) <= 2 * 86400000);
}

const clean = (value: string): string => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const specific = (value: string, min: number): string => {
  const text = clean(value);
  return text.length >= min && !/^(?:微信|支付宝|商户|未知|其他|餐饮|购物|支出|消费|付款|收款|退款|转账|早餐|午餐|晚餐|商品|日记|ai)+$/u.test(text) ? text : "";
};
/** Conservative, unique-candidate evidence. Generic merchant names and meal labels are insufficient. */
export function sameDiaryFinanceTransaction(a: FinanceEntry, b: FinanceEntry): boolean {
  const merchantA = specific(a.merchant, 2), merchantB = specific(b.merchant, 2);
  if (merchantA && merchantB && merchantA !== merchantB) return false;
  const shared = (left: string, right: string, min: number): boolean => {
    const l = specific(left, min), r = specific(right, min);
    return !!l && !!r && (l === r || Math.min(l.length, r.length) >= 8 && (l.includes(r) || r.includes(l)));
  };
  return !!merchantA && merchantA === merchantB && (shared(a.description, b.description, 4) || shared(a.note, b.note, 6))
    || a.date.slice(0, 10) === b.date.slice(0, 10) && shared(a.note, b.note, 10);
}
