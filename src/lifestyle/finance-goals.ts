import type { FinanceContinuousGoal, FinanceEntry } from "./store";
import { localDate } from "./finance-domain";

export interface FinanceGoalProgress {
  start: string; end: string; today: string;
  actual: number | null; target: number; status: "no-data" | "within" | "over" | "reached" | "pending";
  fraction: number;
}

export function goalPeriod(goal: FinanceContinuousGoal, today = localDate()): { start: string; end: string } {
  const [year, month, day] = today.split("-").map(Number);
  if (goal.period === "day") return { start: today, end: today };
  if (goal.period === "month") return { start: `${today.slice(0, 7)}-01`, end: localDate(new Date(year, month, 0)) };
  const date = new Date(year, month - 1, day);
  const monday = new Date(year, month - 1, day - (date.getDay() + 6) % 7);
  return { start: localDate(monday), end: localDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)) };
}

export function financeGoalProgress(goal: FinanceContinuousGoal, entries: readonly FinanceEntry[], today = localDate()): FinanceGoalProgress {
  const { start, end } = goalPeriod(goal, today);
  const relevant = entries.filter((entry) => entry.status === "completed" && entry.currency === "CNY"
    && entry.date.slice(0, 10) >= start && entry.date.slice(0, 10) <= end && entry.date.slice(0, 10) <= today);
  const sum = (kind: FinanceEntry["kind"], category = "") => relevant.filter((entry) => entry.kind === kind && (!category || entry.category === category))
    .reduce((total, entry) => total + entry.amountCents, 0);
  const expense = sum("expense"), income = sum("income"), refund = sum("refund");
  let actual: number | null;
  if (goal.metric === "expense") actual = sum("expense", goal.category);
  else if (goal.metric === "income") actual = sum("income", goal.category);
  else if (goal.metric === "balance") actual = income - (expense - refund);
  else if (goal.metric === "savings-rate") actual = income > 0 ? (income - (expense - refund)) / income * 10000 : null;
  else actual = expense > 0 ? sum("expense", goal.category) / expense * 10000 : null;
  const hasData = goal.metric === "expense" ? relevant.some((entry) => entry.kind === "expense" && (!goal.category || entry.category === goal.category))
    : goal.metric === "income" ? relevant.some((entry) => entry.kind === "income" && (!goal.category || entry.category === goal.category))
      : goal.metric === "category-share" ? expense > 0
        : goal.metric === "savings-rate" ? income > 0
          : relevant.some((entry) => entry.kind === "expense" || entry.kind === "income" || entry.kind === "refund");
  const upperBound = goal.metric === "expense" || goal.metric === "category-share";
  const status = actual === null || !hasData ? "no-data" : upperBound ? actual > goal.target ? "over" : "within" : actual >= goal.target ? "reached" : "pending";
  const fraction = actual === null ? 0 : Math.min(1, Math.max(0, actual / goal.target));
  return { start, end, today, actual, target: goal.target, status, fraction };
}

export function validateFinanceGoal(goal: FinanceContinuousGoal): void {
  if (!goal.id || !goal.name.trim() || goal.name.trim().length > 40) throw new Error("目标名称须为 1–40 字");
  if (!Number.isSafeInteger(goal.target) || goal.target <= 0) throw new Error("目标值须为正数，最多两位小数");
  if (goal.metric === "savings-rate" || goal.metric === "category-share") {
    if (goal.period !== "month" || goal.target > 10000) throw new Error("比例目标须为当前月 0–100%");
    if (goal.metric === "category-share" && !goal.category) throw new Error("请选择消费分类");
    if (goal.metric === "savings-rate" && goal.category) throw new Error("结余率不能指定分类");
  } else {
    if (!["day", "week", "month"].includes(goal.period)) throw new Error("目标周期无效");
    if (goal.metric === "balance" && goal.category) throw new Error("收支结余不能指定分类");
  }
}
