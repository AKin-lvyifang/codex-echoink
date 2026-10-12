import { sha256Hex } from "../utils/sha256";
import type { FinanceEntry, FinanceDefaultBudget, LifestyleData } from "./store-core";
import { effectiveFinanceBudget } from "./finance-budget";

export type FinanceRecordPatch = Partial<Pick<FinanceEntry, "date" | "merchant" | "amountCents" | "kind" | "category" | "account" | "description" | "note" | "icon">> & { billPlanId?: string | null };
export interface FinanceRecordSnapshot { entry: FinanceEntry; path: string; version: string }
export type FinanceBudgetScope = "default" | string;
export interface FinanceBudgetPatch { totalCents?: number; allocations?: Record<string, number>; deltas?: Record<string, number> }
export function financeValueVersion(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, child]) => [k, ordered(child)])) : v;
  return sha256Hex(JSON.stringify(ordered(value)));
}
export function financeBudgetSnapshot(data: Readonly<LifestyleData>, scope: FinanceBudgetScope) {
  if (scope !== "default" && !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(scope)) throw new Error("finance_invalid_month");
  const own = scope === "default" ? data.financeDefaultBudget : data.budgets.find(b => b.month === scope);
  const budget: FinanceDefaultBudget | null = scope === "default" ? data.financeDefaultBudget ?? null : effectiveFinanceBudget(data, scope);
  return { scope, budget, source: own ? scope === "default" ? "default" : "month" : budget ? "default" : "unset",
    version: financeValueVersion({ scope, own: own ?? null, budget }),
    unallocatedCents: budget ? budget.totalCents - Object.values(budget.allocations).reduce((a, b) => a + b, 0) : null };
}
