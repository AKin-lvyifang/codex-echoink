import { setIcon, type App } from "obsidian";
import { renderActivityHeatmap } from "./activity-heatmap";
import type { EchoInkTodoStore } from "../home/todo-store";
import { disposeOriginControls } from "./origin-controls";

export function renderTodoStatistics(
  container: HTMLElement,
  store: EchoInkTodoStore,
  language: string,
  app?: Pick<App, "keymap" | "scope">
): void {
  disposeOriginControls(container);
  container.empty();
  container.addClass("echoink-todo-statistics");
  const zh = language !== "en";
  const now = new Date();
  const stats = store.completionStatistics(now);
  container.createEl("p", { cls: "todo-history-summary", text: zh ? `累计完成 ${stats.total} · 今日完成 ${stats.today}` : `Total completed: ${stats.total} · Today: ${stats.today}` });
  if (stats.unknown) container.createEl("p", { cls: "settings-note", text: zh ? `其中 ${stats.unknown} 项完成日期未知，未计入每日热力图。` : `${stats.unknown} have no known completion date and are excluded from daily counts.` });

  const history = container.createEl("section", { cls: "history-panel todo-history-panel" });
  const heading = history.createDiv({ cls: "panel-heading" });
  const title = heading.createEl("h3");
  setIcon(title.createEl("span", { attr: { "aria-hidden": "true" } }), "calendar-days");
  title.createEl("span", { text: zh ? "完成记录" : "Completion history" });
  renderActivityHeatmap(history, heading, container, {
    days: stats.activity, thresholds: [3, 6], zh, stateKey: "todoStatistics", app,
    title: zh ? "每日完成待办数" : "Daily completed to-dos",
    summary: days => { const total = days.reduce((sum, day) => sum + (day.count ?? 0), 0); return zh ? `完成 ${total} 项` : `${total} completed`; },
    label: (date, count) => zh ? `${date}：完成 ${count} 个待办` : `${date}: ${count} completed to-dos`
  });
}
