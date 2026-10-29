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
