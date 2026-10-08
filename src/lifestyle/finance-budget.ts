import type { FinanceBudget, FinanceDefaultBudget, LifestyleData } from "./store";
import { allocateBudgetByPercent, parsePercent, parseYuan, validateBudget } from "./finance-domain";

type BudgetData = Pick<LifestyleData, "budgets" | "financeDefaultBudget">;
export function effectiveFinanceBudget(data: BudgetData, month: string): FinanceBudget | null {
  const budget = data.budgets.find(item => item.month === month) ?? data.financeDefaultBudget;
  return budget ? { month, totalCents: budget.totalCents, allocations: { ...budget.allocations } } : null;
}
export interface FinanceBudgetChanges {
  defaultBudget?: FinanceDefaultBudget; overrides: FinanceBudget[]; removedMonths: string[];
}
export function applyFinanceBudgetChanges(data: LifestyleData, changes: FinanceBudgetChanges): void {
  if (changes.defaultBudget) validateBudget({ ...changes.defaultBudget, month: "2000-01" });
  if (changes.removedMonths.length && !changes.defaultBudget && !data.financeDefaultBudget) throw new Error("请先设置每月默认预算");
  const months = new Set<string>();
  for (const budget of changes.overrides) {
    validateBudget(budget);
    if (months.has(budget.month)) throw new Error("预算月份不能重复");
    months.add(budget.month);
  }
  for (const month of changes.removedMonths) {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month) || months.has(month)) throw new Error("预算月份无效或重复");
  }
  // Validate the whole batch before touching the draft. Store commits it once.
  if (changes.defaultBudget) data.financeDefaultBudget = structuredClone(changes.defaultBudget);
  const replaced = new Set([...months, ...changes.removedMonths]);
  data.budgets = [...data.budgets.filter(budget => !replaced.has(budget.month)), ...structuredClone(changes.overrides)].sort((a, b) => a.month.localeCompare(b.month));
}
export interface FinanceBudgetDraft {
  total: string; values: Record<string, string>; mode: "amount" | "percent"; dirty: boolean;
}
export function financeBudgetDraft(budget: FinanceDefaultBudget): FinanceBudgetDraft {
  return { total: (budget.totalCents / 100).toFixed(2), values: Object.fromEntries(Object.entries(budget.allocations).map(([key, value]) => [key, (value / 100).toFixed(2)])), mode: "amount", dirty: false };
}
export function parseFinanceBudgetDraft(draft: FinanceBudgetDraft, month: string): FinanceBudget {
  const totalCents = parseYuan(draft.total);
  if (draft.mode === "percent") return allocateBudgetByPercent(month, totalCents, Object.fromEntries(Object.entries(draft.values).map(([key, value]) => [key, parsePercent(value)])), Object.keys(draft.values));
  const budget = { month, totalCents, allocations: Object.fromEntries(Object.entries(draft.values).map(([key, value]) => [key, parseYuan(value, true)])) };
  validateBudget(budget); return budget;
}
/** Raw drafts survive scope/month switches, including invalid input and allocation mode. */
export class FinanceBudgetEditor {
  readonly defaultDraft: FinanceBudgetDraft;
  private readonly hasSavedDefault: boolean;
  readonly months = new Map<string, FinanceBudgetDraft>();
  readonly removed = new Set<string>();
  constructor(data: BudgetData, currentMonth: string) {
    this.hasSavedDefault = !!data.financeDefaultBudget;
    this.defaultDraft = financeBudgetDraft(data.financeDefaultBudget ?? effectiveFinanceBudget(data, currentMonth) ?? { totalCents: 1_000_000, allocations: {} });
    for (const budget of data.budgets) this.months.set(budget.month, financeBudgetDraft(budget));
  }
  add(month: string): void {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) throw new Error("请选择月份");
    if (this.months.has(month)) throw new Error("该月份已有独立预算");
    const draft = financeBudgetDraft(parseFinanceBudgetDraft(this.defaultDraft, month));
    draft.dirty = true; this.months.set(month, draft); this.removed.delete(month);
  }
  get canRestore(): boolean {
    if (this.hasSavedDefault && !this.defaultDraft.dirty) return true;
    if (!this.defaultDraft.dirty) return false;
    try { parseFinanceBudgetDraft(this.defaultDraft, "2000-01"); return true; } catch { return false; }
  }
  restore(month: string): void {
    if (!this.canRestore) throw new Error("请先设置有效的每月默认预算");
    if (this.months.delete(month)) this.removed.add(month);
  }
  changes(saveDefault = false): FinanceBudgetChanges {
    const changes: FinanceBudgetChanges = { overrides: [], removedMonths: [...this.removed] };
    if (saveDefault || this.defaultDraft.dirty) {
      try { const { month: _, ...budget } = parseFinanceBudgetDraft(this.defaultDraft, "2000-01"); changes.defaultBudget = budget; }
      catch (error) { throw new Error(`每月默认：${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const [month, draft] of this.months) if (draft.dirty) {
      try { changes.overrides.push(parseFinanceBudgetDraft(draft, month)); }
      catch (error) { throw new Error(`${month}：${error instanceof Error ? error.message : String(error)}`); }
    }
    return changes;
  }
}
