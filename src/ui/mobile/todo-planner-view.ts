import { setIcon } from "obsidian";
import { ownedEl, ownedSvg } from "../owned-dom";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import type { TodoInput } from "../../home/todo-store";
import type { MobileTodoSnapshot } from "../../mobile/module-contracts";
import { resolveTodoProject } from "../../home/todo-projects";
import { projectKey } from "../../home/todo-page-model";
import { joinPeopleNames, parsePeopleNames } from "../../home/todo-people";
import {
  addDays, addMonths, categoryColor, groupTodos, layoutTimed, matchesSmartList, monthGrid, parseDateKey, parseQuickAdd, projectIcon,
  removeQuickAddToken, searchTodos, smartListCounts, timeOf, todoBucket, todoSubtasks, weekdayOf, type TodoBucket, type TodoPlannerFilter, type TodoSmartList
} from "../../home/todo-planner";

/** iPhone and iPad share the planner body; each platform keeps its own sizes in CSS. */
export interface MobileTodoPlannerState {
  filter: TodoPlannerFilter;
  view: "list" | "calendar";
  calendar: "month" | "day";
  anchor: string;
  day: string;
  query: string;
  search: boolean;
  draft: string;
  doneOpen: boolean;
  expanded: string[];
}
export interface MobileTodoPlannerOps {
  platform: "iphone" | "ipad";
  language: string;
  today: string;
  rerender(): void;
  toggle(record: ParsedTodoRecord, done: boolean): Promise<void>;
  add(input: TodoInput): Promise<void>;
  open(record: ParsedTodoRecord): void;
  sheet(title: string, content: HTMLElement): void;
  closeSheet(): void;
}
export const newMobileTodoPlannerState = (today: string): MobileTodoPlannerState => ({ filter: { kind: "smart", id: "today" }, view: "list", calendar: "month", anchor: today, day: today, query: "", search: false, draft: "", doneOpen: false, expanded: [] });
const keyOf = (record: ParsedTodoRecord) => record.id || `line:${record.lineStart}`;

export function renderMobileTodoPlanner(host: HTMLElement, snapshot: MobileTodoSnapshot, state: MobileTodoPlannerState, ops: MobileTodoPlannerOps): void {
  const doc = host.ownerDocument, en = ops.language === "en", t = (zh: string, english: string) => en ? english : zh;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] => { const node = ownedEl(doc, tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const icon = (name: string, cls = "em-todo-icon") => { const node = el("span", cls); node.setAttribute("aria-hidden", "true"); setIcon(node, name); return node; };
  const color = (name: string) => categoryColor(name, snapshot.categories);
  const project = (record: ParsedTodoRecord) => { const resolved = resolveTodoProject(record.project, snapshot.projects); return resolved.status === "none" ? null : resolved; };
  const inFilter = (record: ParsedTodoRecord) => state.filter.kind === "smart" ? matchesSmartList(record, state.filter.id, ops.today)
    : state.filter.kind === "category" ? record.categoryName === (state.filter as { name: string }).name : projectKey(record, snapshot.projects) === (state.filter as { key: string }).key;
  const visible = () => searchTodos(snapshot.records.filter(inFilter), state.query, record => project(record)?.label ?? "");
  const ring = (value: number, size: number) => {
    const svg = ownedSvg(doc, "svg"), stroke = 2.4, radius = (size - stroke) / 2, length = 2 * Math.PI * radius;
    svg.setAttribute("class", "em-todo-ring"); svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size)); svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    for (const [cls, offset] of [["is-bg", 0], ["is-fg", length * (1 - value)]] as const) {
      const circle = ownedSvg(doc, "circle");
      for (const [key, val] of Object.entries({ cx: size / 2, cy: size / 2, r: radius, fill: "none", "stroke-width": stroke, "stroke-dasharray": length, "stroke-dashoffset": offset, "stroke-linecap": "round", class: cls })) circle.setAttribute(key, String(val));
      svg.append(circle);
    }
    return svg;
  };
  const dot = (value: string) => { const node = el("span", "em-todo-dot"); node.style.setProperty("--todo-c", value); return node; };
  const shortDate = (key: string) => { const date = parseDateKey(key); return en ? date.toLocaleDateString("en", { month: "short", day: "numeric" }) : `${date.getMonth() + 1}月${date.getDate()}日`; };
  const week = (key: string) => en ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekdayOf(key)] : `周${"日一二三四五六"[weekdayOf(key)]}`;
  const dayLabel = (key: string) => `${shortDate(key)} ${week(key)}`;
  const timeLabel = (record: ParsedTodoRecord) => {
    if (!record.dueDate) return "";
    if (record.done) return shortDate(record.dueDate);
    const bucket = todoBucket(record, ops.today), time = record.dueTime ? ` ${record.dueTime}` : "";
    if (bucket === "overdue") return shortDate(record.dueDate);
    if (bucket === "today" || bucket === "tomorrow") return record.dueTime ?? "";
    return bucket === "week" ? `${week(record.dueDate)}${time}` : `${shortDate(record.dueDate)}${time}`;
  };
  const filters: [TodoSmartList, string, string][] = [["today", "sun", t("今天", "Today")], ["upcoming", "calendar-clock", t("接下来", "Upcoming")], ["all", "inbox", t("全部", "All")], ["done", "circle-check", t("已完成", "Done")]];
  const filterList = (onPick: () => void) => {
    const list = el("div", "em-todo-filter-list"), counts = smartListCounts(snapshot.records, ops.today);
    const row = (selected: boolean, lead: Node, name: string, count: number, filter: TodoPlannerFilter) => {
      const button = el("button", `em-todo-filter-row${selected ? " is-selected" : ""}`); button.type = "button"; button.setAttribute("aria-current", String(selected));
      const leadBox = el("span", "em-todo-filter-lead"); leadBox.append(lead);
      button.append(leadBox, el("span", "em-todo-filter-name", name), el("span", "em-todo-count", String(count)));
      button.addEventListener("click", () => { state.filter = filter; onPick(); ops.rerender(); }); return button;
    };
    const group = (title: string | null) => { if (title) list.append(el("div", "em-todo-filter-heading", title)); const box = el("div", "em-todo-filter-group"); list.append(box); return box; };
    const smart = group(null);
    for (const [id, name, label] of filters) smart.append(row(state.filter.kind === "smart" && state.filter.id === id, icon(name), label, counts[id], { kind: "smart", id }));
    if (snapshot.projects.length) {
      const box = group(t("项目", "Projects"));
      for (const item of snapshot.projects) {
        const key = `path:${item.path}`, mine = snapshot.records.filter(record => projectKey(record, snapshot.projects) === key), done = mine.filter(record => record.done).length;
        box.append(row(state.filter.kind === "project" && state.filter.key === key, ring(mine.length ? done / mine.length : 0, 18), item.label, mine.length - done, { kind: "project", key }));
      }
    }
    const names = [...new Set([...snapshot.categories.map(item => item.name), ...snapshot.records.map(record => record.categoryName).filter(Boolean)])];
    if (names.length) { const box = group(t("分类", "Categories")); for (const name of names) box.append(row(state.filter.kind === "category" && state.filter.name === name, dot(color(name)), name, snapshot.records.filter(record => !record.done && record.categoryName === name).length, { kind: "category", name })); }
    return list;
  };
  const currentLabel = (): { lead: Node; name: string } => {
    const filter = state.filter;
    if (filter.kind === "smart") { const found = filters.find(item => item[0] === filter.id)!; return { lead: icon(found[1]), name: found[2] }; }
    if (filter.kind === "category") return { lead: dot(color(filter.name)), name: filter.name };
    const mine = snapshot.records.filter(record => projectKey(record, snapshot.projects) === filter.key), done = mine.filter(record => record.done).length;
    return { lead: ring(mine.length ? done / mine.length : 0, 18), name: snapshot.projects.find(item => `path:${item.path}` === filter.key)?.label ?? filter.key.slice(5) };
  };

  host.replaceChildren();
  host.classList.add("em-todo", `is-${ops.platform}`);
  const layout = el("div", "em-todo-layout"); host.append(layout);
  if (ops.platform === "ipad") { const rail = el("nav", "em-todo-rail"); rail.setAttribute("aria-label", t("待办筛选", "To-do lists")); rail.append(filterList(() => {})); layout.append(rail); }
  const main = el("div", "em-todo-main"); layout.append(main);
  const head = el("div", "em-todo-head"), label = currentLabel();
  if (ops.platform === "iphone") {
    const trigger = el("button", "em-todo-filter-trigger"); trigger.type = "button"; trigger.setAttribute("aria-haspopup", "dialog");
    const lead = el("span", "em-todo-filter-lead"); lead.append(label.lead);
    trigger.append(lead, el("span", "", label.name), icon("chevron-down", "em-todo-icon is-chevron"));
    trigger.addEventListener("click", () => ops.sheet(t("筛选", "Lists"), filterList(() => ops.closeSheet())));
    head.append(trigger);
  } else { const title = el("h2", "em-todo-title"); title.append(el("span", "em-todo-filter-lead"), el("span", "", label.name)); title.firstElementChild!.append(label.lead); head.append(title); }
  const searchButton = el("button", `em-todo-icon-button${state.search || state.query ? " is-on" : ""}`); searchButton.type = "button"; searchButton.setAttribute("aria-label", t("搜索", "Search")); searchButton.append(icon("search"));
  searchButton.addEventListener("click", () => { state.search = !state.search; if (!state.search) state.query = ""; ops.rerender(); });
  head.append(el("span", "em-todo-grow"), searchButton); main.append(head);
  if (state.filter.kind === "smart" && state.filter.id === "done") main.append(el("div", "em-todo-summary", t(`累计完成 ${snapshot.completion.total} · 今日完成 ${snapshot.completion.today}`, `Total completed ${snapshot.completion.total} · Today ${snapshot.completion.today}`)));
  const segments = el("div", "em-todo-segments"); segments.setAttribute("role", "group"); segments.setAttribute("aria-label", t("待办视图", "To-do view"));
  for (const [value, text] of [["list", t("列表", "List")], ["calendar", t("日历", "Calendar")]] as const) {
    const button = el("button", `em-todo-segment${state.view === value ? " is-selected" : ""}`, text); button.type = "button"; button.setAttribute("aria-pressed", String(state.view === value));
    button.addEventListener("click", () => { state.view = value; ops.rerender(); }); segments.append(button);
  }
  main.append(segments);
  if (state.search || state.query) {
    const box = el("label", "em-todo-field"); box.append(icon("search"));
    const input = el("input"); input.type = "search"; input.placeholder = t("搜索", "Search"); input.value = state.query; input.setAttribute("aria-label", t("搜索待办", "Search to-dos"));
    input.addEventListener("input", () => { state.query = input.value; renderBody(); }); box.append(input); main.append(box);
  }
  const quick = el("div", "em-todo-quick"), quickBox = el("label", "em-todo-field"), quickInput = el("input"), chips = el("div", "em-todo-chips");
  quickInput.type = "text"; quickInput.placeholder = t("添加待办", "Add a to-do"); quickInput.setAttribute("aria-label", t("添加待办", "Add a to-do")); quickInput.setAttribute("enterkeyhint", "done"); quickInput.value = state.draft;
  quickBox.append(icon("plus"), quickInput); quick.append(quickBox, chips); main.append(quick);
  const context = { today: ops.today, categories: snapshot.categories.map(item => item.name), projects: snapshot.projects.map(item => ({ value: item.value, name: item.name, label: item.label })) };
  const defaults = () => ({ date: state.filter.kind === "smart" && state.filter.id === "today" ? ops.today : undefined, category: state.filter.kind === "category" ? state.filter.name : undefined,
    project: state.filter.kind === "project" ? snapshot.projects.find(item => `path:${item.path}` === (state.filter as { key: string }).key)?.value : undefined });
  const drawChips = () => {
    chips.replaceChildren(); if (!state.draft.trim()) return;
    const parsed = parseQuickAdd(state.draft, context), fallback = defaults();
    const chip = (lead: Node, text: string, remove?: () => void) => {
      const node = el("span", `em-todo-chip${remove ? "" : " is-implied"}`); node.append(lead, el("span", "", text));
      if (remove) { const close = el("button", "em-todo-chip-remove"); close.type = "button"; close.setAttribute("aria-label", t(`去掉 ${text}`, `Remove ${text}`)); close.append(icon("x")); close.addEventListener("click", event => { event.preventDefault(); remove(); quickInput.value = state.draft; drawChips(); }); node.append(close); }
      chips.append(node);
    };
    for (const token of parsed.tokens) {
      const remove = () => { state.draft = removeQuickAddToken(state.draft, token); };
      if (token.kind === "date") chip(icon("calendar"), dayLabel(token.value), remove);
      else if (token.kind === "time") chip(icon("clock"), token.value, remove);
      else if (token.kind === "category") chip(dot(color(token.value)), token.value, remove);
      else if (token.kind === "project") { const name = snapshot.projects.find(item => item.value === token.value)?.label ?? token.value; chip(icon(projectIcon(name)), name, remove); }
      else chip(icon("user"), token.value, remove);
    }
    if (!parsed.dueDate && fallback.date) chip(icon("calendar"), t("今天", "Today"));
    if (!parsed.categoryName && fallback.category) chip(dot(color(fallback.category)), fallback.category);
    if (!parsed.project && fallback.project) chip(icon(projectIcon(fallback.project)), snapshot.projects.find(item => item.value === fallback.project)?.label ?? fallback.project);
  };
  quickInput.addEventListener("input", () => { state.draft = quickInput.value; drawChips(); });
  quickInput.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const parsed = parseQuickAdd(state.draft, context), fallback = defaults();
    if (!parsed.title) return;
    const dueDate = parsed.dueDate ?? fallback.date ?? "";
    quickInput.disabled = true;
    void ops.add({ title: parsed.title, dueDate, dueTime: dueDate ? parsed.dueTime ?? "" : "", categoryName: parsed.categoryName ?? fallback.category ?? "", project: parsed.project ?? fallback.project ?? "", people: joinPeopleNames(parsed.people) })
      .then(() => { state.draft = ""; ops.rerender(); }).finally(() => { quickInput.disabled = false; });
  });
  drawChips();
  const body = el("div", "em-todo-body"); main.append(body);

  const check = (record: ParsedTodoRecord) => {
    const button = el("button", `em-todo-check${record.done ? " is-checked" : ""}`); button.type = "button"; button.setAttribute("role", "checkbox"); button.setAttribute("aria-checked", String(record.done));
    button.setAttribute("aria-label", record.done ? t(`取消完成 ${record.title}`, `Reopen ${record.title}`) : t(`完成 ${record.title}`, `Complete ${record.title}`));
    const mark = el("span", "em-todo-check-mark"); mark.style.setProperty("--todo-c", color(record.categoryName)); mark.append(icon("check")); button.append(mark);
    button.addEventListener("click", event => { event.stopPropagation(); if (button.disabled) return; button.disabled = true; button.classList.add("is-checked"); void ops.toggle(record, !record.done).finally(() => { button.disabled = false; }); });
    return button;
  };
  const row = (record: ParsedTodoRecord) => {
    const key = keyOf(record), item = el("div", "em-todo-item"), line = el("div", `em-todo-row${record.done ? " is-done" : ""}`);
    const main = el("button", "em-todo-row-main"); main.type = "button"; main.addEventListener("click", () => ops.open(record));
    const title = el("span", "em-todo-row-title", record.title); const meta = el("span", "em-todo-row-meta");
    const owner = project(record);
    if (owner && state.filter.kind !== "project") { const tag = el("span"); tag.append(icon(projectIcon(owner.name)), el("span", "", owner.status === "resolved" ? owner.label : t("项目不可用", "Project unavailable"))); meta.append(tag); }
    const people = parsePeopleNames(record.people); if (people.length) { const tag = el("span"); tag.append(icon("user"), el("span", "", people.join("、"))); meta.append(tag); }
    if (record.diaryJournalPath) meta.append(icon("notebook-pen"));
    main.append(title); if (meta.childElementCount) main.append(meta);
    const late = !record.done && todoBucket(record, ops.today) === "overdue";
    line.append(check(record), main);
    const subtasks = todoSubtasks(record);
    if (subtasks.length) {
      const open = state.expanded.includes(key), toggle = el("button", `em-todo-subcount${open ? " is-open" : ""}`); toggle.type = "button"; toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", t("子任务", "Subtasks"));
      toggle.append(icon("chevron-right"), el("span", "", `${subtasks.filter(task => task.done).length}/${subtasks.length}`));
      toggle.addEventListener("click", () => { state.expanded = open ? state.expanded.filter(value => value !== key) : [...state.expanded, key]; ops.rerender(); }); line.append(toggle);
    }
    line.append(el("span", `em-todo-time${late ? " is-late" : ""}`, timeLabel(record)));
    item.append(line);
    if (subtasks.length && state.expanded.includes(key)) {
      const list = el("div", "em-todo-subrows");
      for (const task of subtasks) { const sub = el("div", `em-todo-subrow${task.done ? " is-done" : ""}`); sub.append(icon(task.done ? "circle-check" : "circle"), el("span", "", task.title)); list.append(sub); }
      item.append(list);
    }
    return item;
  };
  const rows = (parent: HTMLElement, records: readonly ParsedTodoRecord[]) => { const box = el("div", "em-todo-rows"); for (const record of records) box.append(row(record)); parent.append(box); };
  const labels: Record<TodoBucket, string> = { overdue: t("逾期", "Overdue"), today: t("今天", "Today"), tomorrow: t("明天", "Tomorrow"), week: t("7 天内", "Next 7 days"), later: t("以后", "Later"), none: t("没有日期", "No date") };
  const section = (title: string, count: number, cls = "") => { const node = el("section", `em-todo-section ${cls}`.trim()), heading = el("div", "em-todo-section-head"); heading.append(el("h3", "", title), el("span", "em-todo-count", String(count))); node.append(heading); body.append(node); return node; };

  function renderBody(): void {
    body.replaceChildren();
    if (state.view === "calendar") { renderCalendar(); return; }
    const records = visible();
    if (!records.length) { body.append(el("div", "em-todo-empty", snapshot.records.length ? t("没有符合条件的待办", "No matching to-dos") : t("暂时没有待办", "No to-dos yet"))); return; }
    const { groups, done } = groupTodos(records, ops.today);
    if (state.filter.kind === "smart" && state.filter.id === "done") { rows(body, done); return; }
    for (const group of groups) rows(section(labels[group.bucket], group.records.length, `is-${group.bucket}`), group.records);
    if (done.length) {
      const node = el("section", "em-todo-section"), toggle = el("button", `em-todo-done-toggle${state.doneOpen ? " is-open" : ""}`); toggle.type = "button"; toggle.setAttribute("aria-expanded", String(state.doneOpen));
      toggle.append(icon("chevron-right"), el("span", "", t("已完成", "Done")), el("span", "em-todo-count", String(done.length)));
      toggle.addEventListener("click", () => { state.doneOpen = !state.doneOpen; renderBody(); }); node.append(toggle); body.append(node);
      if (state.doneOpen) rows(node, done);
    }
  }
  function renderCalendar(): void {
    const modes = el("div", "em-todo-segments is-sub");
    for (const [value, text] of [["month", t("月", "Month")], ["day", t("日", "Day")]] as const) {
      const button = el("button", `em-todo-segment${state.calendar === value ? " is-selected" : ""}`, text); button.type = "button"; button.setAttribute("aria-pressed", String(state.calendar === value));
      button.addEventListener("click", () => { state.calendar = value; state.anchor = value === "day" ? state.day : state.anchor; ops.rerender(); }); modes.append(button);
    }
    body.append(modes);
    const bar = el("div", "em-todo-cal-bar"), records = visible().filter(record => !!record.dueDate);
    const step = (delta: number) => { if (state.calendar === "month") state.anchor = addMonths(state.anchor, delta); else { state.day = addDays(state.day, delta); state.anchor = state.day; } ops.rerender(); };
    const nav = (name: string, label: string, delta: number) => { const button = el("button", "em-todo-icon-button"); button.type = "button"; button.setAttribute("aria-label", label); button.append(icon(name)); button.addEventListener("click", () => step(delta)); return button; };
    const anchor = parseDateKey(state.anchor);
    bar.append(nav("chevron-left", t("上一个", "Previous"), -1), el("h3", "", state.calendar === "month" ? (en ? anchor.toLocaleDateString("en", { year: "numeric", month: "long" }) : `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`) : dayLabel(state.day)), nav("chevron-right", t("下一个", "Next"), 1), el("span", "em-todo-grow"));
    const todayButton = el("button", "em-todo-compact", t("今天", "Today")); todayButton.type = "button"; todayButton.addEventListener("click", () => { state.anchor = ops.today; state.day = ops.today; ops.rerender(); }); bar.append(todayButton);
    body.append(bar);
    if (state.calendar === "day") { timeline(records.filter(record => record.dueDate === state.day)); return; }
    const { days, month } = monthGrid(state.anchor), grid = el("div", "em-todo-month"), headRow = el("div", "em-todo-month-head");
    for (const name of en ? ["M", "T", "W", "T", "F", "S", "S"] : "一二三四五六日".split("")) headRow.append(el("span", "", name));
    const cells = el("div", "em-todo-month-grid");
    for (const day of days) {
      const date = parseDateKey(day), list = records.filter(record => record.dueDate === day && !record.done);
      const cell = el("button", `em-todo-day${date.getMonth() + 1 !== month ? " is-other" : ""}${day === ops.today ? " is-today" : ""}${day === state.day ? " is-selected" : ""}`); cell.type = "button";
      cell.setAttribute("aria-label", `${dayLabel(day)}，${t(`${list.length} 件`, `${list.length} items`)}`);
      cell.append(el("span", "em-todo-day-number", String(date.getDate())));
      if (ops.platform === "ipad") { for (const record of list.slice(0, 3)) { const chip = el("span", `em-todo-bar${todoBucket(record, ops.today) === "overdue" ? " is-late" : ""}`); chip.style.setProperty("--todo-c", color(record.categoryName)); chip.append(el("span", "", record.title)); cell.append(chip); } if (list.length > 3) cell.append(el("span", "em-todo-more", `+${list.length - 3}`)); }
      else { const dots = el("span", "em-todo-dots"); for (const name of [...new Set(list.map(record => record.categoryName))].slice(0, 3)) dots.append(dot(color(name))); if (list.some(record => todoBucket(record, ops.today) === "overdue")) dots.append(el("span", "em-todo-dot is-late")); cell.append(dots); }
      cell.addEventListener("click", () => { state.day = day; ops.rerender(); }); cells.append(cell);
    }
    grid.append(headRow, cells); body.append(grid);
    const chosen = records.filter(record => record.dueDate === state.day).sort((a, b) => Number(a.done) - Number(b.done) || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99"));
    const node = section(dayLabel(state.day), chosen.length);
    if (chosen.length) rows(node, chosen); else node.append(el("div", "em-todo-empty", t("这天没有待办", "Nothing on this day")));
  }
  function timeline(records: readonly ParsedTodoRecord[]): void {
    const start = 7, end = 23, hour = 44, frame = el("div", "em-todo-timeline"), column = el("div", "em-todo-timeline-col");
    frame.style.height = `${(end - start) * hour}px`;
    const gutter = el("div", "em-todo-timeline-gutter");
    for (let value = start + 1; value < end; value++) { const label = el("span", "", `${String(value).padStart(2, "0")}:00`); label.style.top = `${(value - start) * hour}px`; gutter.append(label); }
    for (const block of layoutTimed(records)) {
      const from = Math.max(block.start, start * 60), record = block.record, node = el("button", `em-todo-block${record.done ? " is-done" : ""}${!record.done && todoBucket(record, ops.today) === "overdue" ? " is-late" : ""}`); node.type = "button";
      node.style.setProperty("--todo-c", color(record.categoryName));
      Object.assign(node.style, { top: `${(from - start * 60) / 60 * hour}px`, height: `${Math.max(22, (block.end - from) / 60 * hour - 2)}px`, left: `calc(${100 / block.lanes * block.lane}% + 3px)`, width: `calc(${100 / block.lanes}% - 6px)` });
      node.append(el("span", "em-todo-block-title", record.title), el("span", "em-todo-block-meta", `${record.dueTime}–${timeOf(block.end)}`));
      node.addEventListener("click", () => ops.open(record)); column.append(node);
    }
    frame.append(gutter, column); body.append(frame);
    const unscheduled = records.filter(record => !record.dueTime && !record.done);
    if (unscheduled.length) rows(section(t("未排时间", "Unscheduled"), unscheduled.length), unscheduled);
  }
  renderBody();
}
