import type { EchoInkTodoStore } from "../home/todo-store";

export function renderTodoStatistics(container: HTMLElement, store: EchoInkTodoStore, language: string): void {
  container.empty();
  container.addClass("echoink-todo-statistics");
  const zh = language !== "en";
  const stats = store.completionStatistics();
  container.createEl("h3", { text: zh ? "完成记录" : "Completion history" });
  container.createEl("p", { text: zh ? `累计完成 ${stats.total} · 今日完成 ${stats.today}` : `Total completed: ${stats.total} · Today: ${stats.today}` });
  if (stats.unknown) container.createEl("p", { cls: "settings-note", text: zh ? `其中 ${stats.unknown} 项完成日期未知，未计入每日热力图。` : `${stats.unknown} have no known completion date and are excluded from daily counts.` });
  const focusInfo = container.createDiv({ cls: "settings-note", attr: { role: "status", "aria-live": "polite" } });
  focusInfo.setText(zh ? "最近一年 · 指向或聚焦格子查看每日完成数" : "Past year · Hover or focus a day to view its count");
  const grid = container.createDiv({ cls: "heatmap-scroll" }).createDiv({ cls: "heatmap todo-heatmap", attr: { "aria-label": zh ? "最近一年每日完成待办数" : "Daily completed to-dos in the past year" } });
  const first = new Date(`${stats.days[0].date}T12:00:00`);
  for (const [index, day] of stats.days.entries()) {
    const date = new Date(`${day.date}T12:00:00`);
    const label = zh ? `${day.date}：完成 ${day.count} 个待办` : `${day.date}: ${day.count} completed to-dos`;
    const level = day.count === 0 ? 0 : day.count < 3 ? 1 : day.count < 6 ? 2 : 3;
    const cell = grid.createEl("button", { cls: `heatmap-cell todo-level-${level}`, attr: { type: "button", title: label, "aria-label": label } });
    cell.style.gridColumn = String(Math.floor((index + first.getDay()) / 7) + 1);
    cell.style.gridRow = String(date.getDay() + 1);
    cell.onmouseenter = cell.onfocus = () => { focusInfo.setText(label); };
  }
}
