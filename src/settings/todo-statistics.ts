import { setIcon, type App } from "obsidian";
import type { EchoInkTodoStore } from "../home/todo-store";
import { createOriginSelect, disposeOriginControls } from "./origin-controls";

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
  const selectedYear = container.dataset.todoStatisticsYear;
  const stats = store.completionStatistics(now, selectedYear ? Number(selectedYear) : now.getFullYear());
  container.createEl("p", { cls: "todo-history-summary", text: zh ? `累计完成 ${stats.total} · 今日完成 ${stats.today}` : `Total completed: ${stats.total} · Today: ${stats.today}` });
  if (stats.unknown) container.createEl("p", { cls: "settings-note", text: zh ? `其中 ${stats.unknown} 项完成日期未知，未计入每日热力图。` : `${stats.unknown} have no known completion date and are excluded from daily counts.` });

  const history = container.createEl("section", { cls: "history-panel todo-history-panel" });
  const heading = history.createDiv({ cls: "panel-heading" });
  const title = heading.createEl("h3");
  setIcon(title.createEl("span", { attr: { "aria-hidden": "true" } }), "calendar-days");
  title.createEl("span", { text: zh ? "全年完成记录" : "Completions throughout the year" });
  heading.createEl("span", { cls: "history-period todo-history-period", text: zh ? `${stats.year} 年 · 完成 ${stats.yearTotal} 项` : `${stats.year} · ${stats.yearTotal} completed` });
  const controls = heading.createDiv({ cls: "todo-history-controls" });
  const yearSelector = createOriginSelect(controls, {
    cls: "todo-history-year",
    attr: { "aria-label": zh ? "完成记录年份" : "Completion history year" }
  }, stats.years.map((year) => ({ value: String(year), label: zh ? `${year} 年` : String(year) })), String(stats.year), app).element;
  yearSelector.onchange = () => {
    container.dataset.todoStatisticsYear = yearSelector.value;
    renderTodoStatistics(container, store, language, app);
    container.querySelector<HTMLElement>(".todo-history-year")?.focus({ preventScroll: true });
  };
  const body = history.createDiv({ cls: "todo-history-body" });
  body.hidden = container.dataset.todoStatisticsCollapsed === "true";
  const toggle = controls.createEl("button", { cls: "text-button todo-history-toggle", attr: { type: "button" } });
  const updateToggle = () => {
    toggle.empty();
    toggle.setAttr("aria-expanded", String(!body.hidden));
    const label = body.hidden ? (zh ? "展开" : "Expand") : (zh ? "收起" : "Collapse");
    toggle.setAttr("aria-label", `${label}${zh ? "全年完成记录" : " yearly completion history"}`);
    setIcon(toggle.createEl("span", { attr: { "aria-hidden": "true" } }), body.hidden ? "chevron-down" : "chevron-up");
    toggle.createEl("span", { text: label });
  };
  toggle.onclick = () => {
    body.hidden = !body.hidden;
    container.dataset.todoStatisticsCollapsed = String(body.hidden);
    updateToggle();
  };
  updateToggle();

  const grid = body.createDiv({ cls: "todo-heatmap-scroll" }).createDiv({ cls: "todo-heatmap-grid", attr: { "aria-label": zh ? `${stats.year} 年每日完成待办数` : `Daily completed to-dos in ${stats.year}` } });
  const first = new Date(stats.year, 0, 1, 12);
  grid.style.setProperty("--todo-heatmap-weeks", String(Math.ceil((stats.days.length + first.getDay()) / 7)));
  for (const [weekday, cn, en] of [[1, "一", "Mon"], [3, "三", "Wed"], [5, "五", "Fri"]] as const) {
    const label = grid.createEl("span", { cls: "todo-heatmap-weekday", text: zh ? cn : en });
    label.style.gridRow = String(weekday + 2);
  }
  const footer = body.createDiv({ cls: "heatmap-footer todo-history-footer" });
  const focusInfo = footer.createDiv({ cls: "settings-note todo-history-day-detail", attr: { role: "status", "aria-live": "polite" } });
  focusInfo.setText(zh ? "指向或聚焦格子查看每日完成数" : "Hover or focus a day to view its count");
  const legend = footer.createDiv({ cls: "heatmap-legend todo-heatmap-legend", attr: { "aria-label": zh ? "每日完成数量" : "Daily completion counts" } });
  for (const [level, label] of ["0", "1–2", "3–5", "6+"].entries()) {
    const item = legend.createEl("span");
    item.createEl("b", { cls: `todo-heatmap-swatch todo-level-${level}`, attr: { "aria-hidden": "true" } });
    item.createEl("span", { text: label });
  }
  for (const [index, day] of stats.days.entries()) {
    const date = new Date(`${day.date}T12:00:00`);
    const column = String(Math.floor((index + first.getDay()) / 7) + 2);
    if (date.getDate() === 1) {
      const month = grid.createEl("span", { cls: "todo-heatmap-month", text: date.toLocaleString(zh ? "zh-CN" : "en-US", { month: "short" }) });
      month.style.gridColumn = column;
    }
    const label = zh ? `${day.date}：完成 ${day.count} 个待办` : `${day.date}: ${day.count} completed to-dos`;
    const level = day.count === 0 ? 0 : day.count < 3 ? 1 : day.count < 6 ? 2 : 3;
    const cell = grid.createEl("button", { cls: `todo-heatmap-cell todo-level-${level}`, attr: { type: "button", title: label, "aria-label": label, "data-date": day.date } });
    cell.style.gridColumn = column;
    cell.style.gridRow = String(date.getDay() + 2);
    cell.onmouseenter = cell.onfocus = () => { focusInfo.setText(label); };
  }
}
