import type { FinanceBillPlan, FinanceEntry } from "./store-core";
import { effectiveFinanceEntries, financeSpendingFacts, filterFinanceEntries, localDate, type FinanceFilters } from "./finance-domain";

export function validateFinanceBillPlan(plan: FinanceBillPlan): void {
  if (!plan.id || !plan.name.trim()) throw new Error("请填写账单名称");
  if (!Number.isSafeInteger(plan.budgetCents) || plan.budgetCents <= 0) throw new Error("总预算须为正金额，最多两位小数");
  let allocated=0;
  for(const [name,amount] of Object.entries(plan.allocations??{})) {
    if(!name.trim() || !Number.isSafeInteger(amount) || amount<0) throw new Error("分类额度须为非负金额，最多两位小数");
    allocated+=amount;
  }
  if(allocated>plan.budgetCents) throw new Error("分类额度合计不能超过总预算，请修正后保存");
}

export function financeBillPlanStats(plan: FinanceBillPlan, ledger: readonly FinanceEntry[], today = localDate()) {
  const entries = ledger.filter((entry) => entry.billPlanId === plan.id);
  // An empty month selects the full lifecycle while reusing the monthly validity rules.
  const facts = financeSpendingFacts(entries, "", today);
  const ranked = [...facts.expenses].sort((a, b) => b.amountCents - a.amountCents || b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const netCents = facts.grossCents - facts.refundsCents;
  const categoryNet=new Map<string,number>();
  for(const row of effectiveFinanceEntries(entries,"",today)) if(row.kind==="expense" || row.kind==="refund")
    categoryNet.set(row.category,(categoryNet.get(row.category)??0)+(row.kind==="expense"?row.amountCents:-row.amountCents));
  const categoryBudgets=[...new Set([...Object.keys(plan.allocations??{}),...categoryNet.keys()])].map(category=>{
    const allocation=Object.hasOwn(plan.allocations??{},category)?plan.allocations![category]:null,spent=categoryNet.get(category)??0;
    return {category,allocationCents:allocation,netCents:spent,percentage:allocation!==null && allocation>0?spent/allocation*100:null,
      progress:allocation===null?0:allocation>0?Math.max(0,Math.min(1,spent/allocation)):spent>0?1:0,
      overCents:allocation===null?null:Math.max(0,spent-allocation)};
  });
  return { entries, ...facts, netCents, categoryBudgets,
    unallocatedCents:plan.budgetCents-Object.values(plan.allocations??{}).reduce((total,value)=>total+value,0), remainingCents: plan.budgetCents - netCents,
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
