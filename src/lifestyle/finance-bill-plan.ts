import type { FinanceBillPlan, FinanceEntry } from "./store";
import { financeSpendingFacts, filterFinanceEntries, localDate, type FinanceFilters } from "./finance-domain";

export function validateFinanceBillPlan(plan: FinanceBillPlan): void {
  if (!plan.id || !plan.name.trim()) throw new Error("请填写账单名称");
  if (!Number.isSafeInteger(plan.budgetCents) || plan.budgetCents <= 0) throw new Error("总预算须为正金额，最多两位小数");
}

export function financeBillPlanStats(plan: FinanceBillPlan, ledger: readonly FinanceEntry[], today = localDate()) {
  const entries = ledger.filter((entry) => entry.billPlanId === plan.id);
  // An empty month selects the full lifecycle while reusing the monthly validity rules.
  const facts = financeSpendingFacts(entries, "", today);
  const ranked = [...facts.expenses].sort((a, b) => b.amountCents - a.amountCents || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const netCents = facts.grossCents - facts.refundsCents;
  return { entries, ...facts, netCents, remainingCents: plan.budgetCents - netCents,
    progress: Math.max(0, Math.min(1, netCents / plan.budgetCents)),
    largest: ranked[0] ?? null, smallest: ranked.at(-1) ?? null,
    averageCents: ranked.length ? facts.grossCents / ranked.length : null };
}

export type FinanceBillPlanSort = "date-desc" | "amount-desc" | "amount-asc";
export function sortFinanceBillPlanEntries(entries: readonly FinanceEntry[], sort: FinanceBillPlanSort): FinanceEntry[] {
  return [...entries].sort((a, b) => (sort === "date-desc" ? b.date.localeCompare(a.date)
    : sort === "amount-desc" ? b.amountCents - a.amountCents : a.amountCents - b.amountCents)
    || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

export interface FinanceBillPlanFilters extends FinanceFilters { from: string; to: string }
export function emptyFinanceBillPlanFilters(): FinanceBillPlanFilters {
  return { search: "", merchant: "", category: "", kind: "all", account: "", excludedCategories: [], excludedIds: [], from: "", to: "" };
}
export function filterFinanceBillPlanEntries(entries: readonly FinanceEntry[], filters: FinanceBillPlanFilters): FinanceEntry[] {
  return filterFinanceEntries(entries, "", filters).filter((entry) => (!filters.from || entry.date.slice(0, 10) >= filters.from)
    && (!filters.to || entry.date.slice(0, 10) <= filters.to));
}
export function reconcileFinanceBillPlanSelection(selected: Set<string>, visible: readonly FinanceEntry[], planId: string): void {
  const eligible = new Set(visible.filter((entry) => entry.billPlanId !== planId).map((entry) => entry.id));
  for (const id of selected) if (!eligible.has(id)) selected.delete(id);
}
