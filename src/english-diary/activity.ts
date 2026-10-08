import type { DiaryGenerationDay } from "./types";
import { localTodoDate as dateKey } from "../home/todo-completions";

/** Today stays open: yesterday's streak remains current until the next local day. */
export function summarizeDiaryActivity(activity: readonly DiaryGenerationDay[], now = new Date()): { streak: number; days: number } {
  const today = dateKey(now);
  const active = new Set(activity.filter((day) => day.generationCount > 0 && day.date <= today).map((day) => day.date));
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (!active.has(today)) date.setDate(date.getDate() - 1);
  let streak = 0;
  while (active.has(dateKey(date))) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return { streak, days: active.size };
}

export function renderDiaryProgress(container: HTMLElement, activity: readonly DiaryGenerationDay[], expressionCount: number): void {
  const summary = summarizeDiaryActivity(activity);
  const progress = container.createEl("dl", { cls: "echoink-diary-progress" });
  for (const [label, value, unit] of [["连续打卡", summary.streak, "天"], ["累计打卡", summary.days, "天"], ["累计收录", expressionCount, "个表达"]] as const) {
    const item = progress.createDiv();
    item.createEl("dt", { text: label });
    const count = item.createEl("dd");
    count.createEl("strong", { text: String(value) });
    count.createEl("span", { text: unit });
  }
}
