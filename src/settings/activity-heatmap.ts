import { Scope, setIcon, type App } from "obsidian";
import { localTodoDate } from "../home/todo-completions";
import { createOriginButton, createOriginInput, createOriginSelect } from "./origin-controls";

export interface ActivityHeatmapDay { date: string; count?: number; level?: string; label?: string }
interface ActivityHeatmapOptions {
  days: readonly ActivityHeatmapDay[];
  label?: (date: string, count: number) => string;
  title: string;
  thresholds?: [number, number];
  legend?: readonly { level: string; label: string }[];
  emptyLevel?: string;
  summary?: (days: readonly ActivityHeatmapDay[]) => string;
  zh: boolean;
  stateKey: string;
  app?: Pick<App, "keymap" | "scope">;
}

/** One inclusive year or month range for activity counts and check results. */
export function renderActivityHeatmap(parent: HTMLElement, heading: HTMLElement, state: HTMLElement, options: ActivityHeatmapOptions): HTMLElement {
  const { label, title, zh, stateKey } = options;
  const [low, high] = options.thresholds ?? [3, 6];
  const now = new Date();
  const byDate = new Map(options.days.map(day => [day.date, day]));
  type Mode = "year" | "month";
  let mode: Mode = state.dataset[`${stateKey}RangeMode`] === "month" ? "month" : "year";
  let start = state.dataset[`${stateKey}RangeStart`] || String(now.getFullYear());
  let end = state.dataset[`${stateKey}RangeEnd`] || start;
  const period = heading.createEl("span", { cls: "history-period activity-heatmap-period" });
  const controls = heading.createDiv({ cls: "activity-heatmap-controls" });
  const rangeClass = (name: string) => `activity-range-${name}`;
  const scope = options.app ? new Scope(options.app.scope) : null;
  let scopeActive = false;
  const releaseScope = () => { if (scopeActive && scope && options.app) options.app.keymap.popScope(scope); scopeActive = false; };
  const trigger = createOriginButton(controls, { cls: rangeClass("trigger"), attr: { "aria-expanded": "false", "aria-label": zh ? `${title}时间范围` : `${title} date range` } }, releaseScope);
  const body = parent.createDiv({ cls: "todo-history-body echoink-activity-heatmap" });
  const editor = body.createDiv({ cls: rangeClass("editor"), attr: { role: "group", "aria-label": zh ? "选择时间范围" : "Choose date range" } });
  editor.hidden = true;
  const fields = editor.createDiv({ cls: rangeClass("fields") });
  const field = (name: string) => { const el = fields.createEl("label", { cls: rangeClass("field") }); el.createEl("span", { text: name }); return el; };
  const modeSelector = createOriginSelect(field(zh ? "范围单位" : "Period"), { cls: rangeClass("mode"), attr: { "aria-label": zh ? "范围单位" : "Period" } },
    [{ value: "year", label: zh ? "按年" : "Years" }, { value: "month", label: zh ? "按月" : "Months" }], mode, options.app).element;
  const startInput = createOriginInput(field(zh ? "开始" : "From"), { cls: rangeClass("start") });
  const endInput = createOriginInput(field(zh ? "结束" : "To"), { cls: rangeClass("end") });
  const error = editor.createDiv({ cls: rangeClass("error"), attr: { role: "alert" } });
  const actions = editor.createDiv({ cls: rangeClass("actions") });
  const cancel = createOriginButton(actions, { cls: rangeClass("cancel"), text: zh ? "取消" : "Cancel" });
  const apply = createOriginButton(actions, { cls: rangeClass("apply"), text: zh ? "应用" : "Apply" });
  const validate = () => {
    const valid = [startInput, endInput].every(input => input.value && input.checkValidity()) && startInput.valueAsNumber <= endInput.valueAsNumber;
    apply.disabled = !valid;
    error.hidden = valid;
    error.setText(valid ? "" : zh ? "请填有效范围，结束不能早于开始。" : "Enter a valid range; the end must not precede the start.");
    return valid;
  };
  const syncInputs = (nextStart: string, nextEnd: string) => {
    for (const input of [startInput, endInput]) {
      const yearly = modeSelector.value === "year";
      input.type = yearly ? "number" : "month";
      input.min = yearly ? "1000" : "1000-01";
      input.max = yearly ? "9999" : "9999-12";
    }
    startInput.value = nextStart; endInput.value = nextEnd; validate();
  };
  const closeEditor = () => { editor.hidden = true; trigger.setAttr("aria-expanded", "false"); releaseScope(); trigger.focus({ preventScroll: true }); };
  trigger.onclick = () => {
    if (!editor.hidden) { closeEditor(); return; }
    modeSelector.value = mode; syncInputs(start, end); editor.hidden = false; trigger.setAttr("aria-expanded", "true");
    if (scope && options.app) { options.app.keymap.pushScope(scope); scopeActive = true; }
    startInput.focus({ preventScroll: true });
  };
  scope?.register(null, "Escape", () => { closeEditor(); return false; });
  editor.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeEditor(); } };
  cancel.onclick = closeEditor;
  startInput.oninput = endInput.oninput = validate;
  modeSelector.onchange = () => { const monthly = modeSelector.value === "month"; syncInputs(startInput.value.slice(0, 4) + (monthly ? "-01" : ""), endInput.value.slice(0, 4) + (monthly ? "-12" : "")); };
  const footer = body.createDiv({ cls: "heatmap-footer todo-history-footer" });
  const info = footer.createDiv({ cls: "settings-note todo-history-day-detail", attr: { role: "status", "aria-live": "polite" } });
  const legend = footer.createDiv({ cls: "heatmap-legend todo-heatmap-legend", attr: { "aria-label": title } });
  const levels = options.legend ?? ["0", `1–${low - 1}`, `${low}–${high - 1}`, `${high}+`].map((label, level) => ({ level: String(level), label }));
  for (const { level, label: text } of levels) {
    const item = legend.createEl("span");
    item.createEl("b", { cls: `todo-heatmap-swatch todo-level-${level}`, attr: { "aria-hidden": "true" } });
    item.createEl("span", { text });
  }
  let calendar: HTMLElement | undefined;
  const renderDays = () => {
    state.dataset[`${stateKey}RangeMode`] = mode;
    state.dataset[`${stateKey}RangeStart`] = start;
    state.dataset[`${stateKey}RangeEnd`] = end;
    const [firstYear, firstMonth = 1] = start.split("-").map(Number);
    const [lastYear, lastMonth = 12] = end.split("-").map(Number);
    const firstDate = new Date(firstYear, firstMonth - 1, 1, 12), afterLast = new Date(lastYear, lastMonth, 1, 12);
    const days: ActivityHeatmapDay[] = [];
    for (const cursor = new Date(firstDate); cursor < afterLast; cursor.setDate(cursor.getDate() + 1)) {
      const date = localTodoDate(cursor);
      days.push(byDate.get(date) ?? { date, count: 0, level: options.emptyLevel });
    }
    const format = (value: string) => !zh ? value : mode === "year" ? `${value} 年` : `${value.slice(0, 4)} 年 ${Number(value.slice(5))} 月`;
    trigger.empty(); setIcon(trigger.createEl("span", { attr: { "aria-hidden": "true" } }), "calendar-days");
    trigger.createEl("span", { text: start === end ? format(start) : `${format(start)} — ${format(end)}` });
    period.setText(options.summary?.(days) ?? "");
    calendar?.remove();
    calendar = body.createDiv({ cls: "activity-heatmap-calendar" });
    body.insertBefore(calendar, footer);
    const weekdays = calendar.createDiv({ cls: "activity-heatmap-weekdays", attr: { "aria-hidden": "true" } });
    const scroll = calendar.createDiv({ cls: "todo-heatmap-scroll" });
    const grid = scroll.createDiv({ cls: "todo-heatmap-grid", attr: { "aria-label": title } });
    const first = new Date(`${days[0].date}T12:00:00`);
    grid.style.setProperty("--todo-heatmap-weeks", String(Math.ceil((days.length + first.getDay()) / 7)));
    for (const [weekday, cn, en] of [[1, "一", "Mon"], [3, "三", "Wed"], [5, "五", "Fri"]] as const) {
      weekdays.createEl("span", { cls: "todo-heatmap-weekday", text: zh ? cn : en }).style.gridRow = String(weekday + 2);
    }
    const cells: HTMLButtonElement[] = [];
    let focused: HTMLButtonElement | undefined;
    for (const [index, day] of days.entries()) {
      const date = new Date(`${day.date}T12:00:00`);
      const column = Math.floor((index + first.getDay()) / 7) + 1;
      if (date.getDate() === 1) {
        const monthLabel = grid.createEl("span", { cls: "todo-heatmap-month", text: start.slice(0, 4) !== end.slice(0, 4) && (!index || date.getMonth() === 0) ? `${date.getFullYear()}/${date.getMonth() + 1}` : date.toLocaleString(zh ? "zh-CN" : "en-US", { month: "short" }) });
        monthLabel.style.gridColumn = String(column);
      }
      const count = day.count ?? 0;
      const text = day.label ?? label?.(day.date, count) ?? day.date;
      const level = day.level ?? (count === 0 ? 0 : count < low ? 1 : count < high ? 2 : 3);
      const cell = grid.createEl("button", { cls: `todo-heatmap-cell todo-level-${level}`, attr: { type: "button", title: text, "aria-label": text, "data-date": day.date, tabindex: "-1" } });
      cell.style.gridColumn = String(column);
      cell.style.gridRow = String(date.getDay() + 2);
      cell.onmouseenter = cell.onclick = () => { info.setText(text); };
      cell.onfocus = () => { if (focused) focused.tabIndex = -1; focused = cell; cell.tabIndex = 0; info.setText(text); };
      if (day.date <= localTodoDate(now)) focused = cell;
      cells.push(cell);
    }
    focused ??= cells[0];
    focused.tabIndex = 0;
    info.setText(focused.title);
    const initial = focused;
    const scrollKey = `${stateKey}Scroll${mode}${start}To${end}`;
    scroll.onscroll = () => { if (scroll.isConnected) state.dataset[scrollKey] = String(scroll.scrollLeft); };
    body.ownerDocument.defaultView?.requestAnimationFrame(() => {
      if (!scroll.isConnected) return;
      const saved = state.dataset[scrollKey];
      scroll.scrollLeft = saved === undefined
        ? initial.getBoundingClientRect().right - grid.getBoundingClientRect().left - scroll.clientWidth + 24
        : Number(saved);
    });
    const offsets: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    grid.onkeydown = (event) => {
      const index = cells.indexOf(event.target as HTMLButtonElement);
      const offset = offsets[event.key];
      const next = event.key === "Home" ? 0 : event.key === "End" ? cells.length - 1 : offset === undefined ? -1 : Math.max(0, Math.min(cells.length - 1, index + offset));
      if (index < 0 || next < 0) return;
      event.preventDefault();
      cells[next].focus();
    };
  };
  apply.onclick = () => {
    if (!validate()) return;
    mode = modeSelector.value as Mode;
    start = mode === "year" ? String(startInput.valueAsNumber) : startInput.value;
    end = mode === "year" ? String(endInput.valueAsNumber) : endInput.value;
    renderDays(); closeEditor();
  };
  renderDays();
  return footer;
}
