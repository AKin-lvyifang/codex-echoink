import type { App } from "obsidian";
import { renderTodoStatistics } from "../settings/todo-statistics";
import { todoCompletionStatistics, localTodoDate } from "../home/todo-completions";
import type { EchoInkTodoStore } from "../home/todo-store";
import { createSettingsNavigationRow } from "../settings/settings-v2";
import { disposeOriginControls } from "../settings/origin-controls";
import { renderActivityHeatmap } from "../settings/activity-heatmap";
import { renderEnglishDiaryActivity } from "../settings/english-diary-activity";

type FixtureService = { getOriginalDirectoryStatus(): Promise<{ createdAt: number; files: number } | null> };
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function runWikiTodoDom(Fixture: new () => { mountKnowledgeDashboard(page: HTMLElement, zh: boolean): void; refreshes: number; plugin: { getKnowledgeSurfaceService(): FixtureService } }) {
  const create = function (this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
    this.appendChild(el); return el;
  };
  Object.assign(HTMLElement.prototype, {
    empty() { this.replaceChildren(); }, addClass(...tokens: string[]) { this.classList.add(...tokens); },
    removeClass(...tokens: string[]) { this.classList.remove(...tokens); },
    setText(text: string) { this.textContent = text; }, setAttr(name: string, value: string) { this.setAttribute(name, value); },
    createEl: create, createDiv(options: Parameters<typeof create>[1]) { return create.call(this, "div", options); },
    createSpan(options: Parameters<typeof create>[1]) { return create.call(this, "span", options); }
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const host = document.querySelector<HTMLElement>("#fixture")!;
  const settings = document.querySelector<HTMLElement>("#settings")!;
  const stats = host.createDiv();
  const now = new Date();
  const today = localTodoDate(now);
  const history = { a: today, b: today, old: null, leap: "2024-02-29", previous: "2023-12-31" };
  const store = { completionStatistics: (date = now) => todoCompletionStatistics(history, date) } as EchoInkTodoStore;
  renderTodoStatistics(stats, store, "zh");
  const expectedDays = new Date(now.getFullYear(), 1, 29).getMonth() === 1 ? 366 : 365;
  const cells = stats.querySelectorAll<HTMLButtonElement>(".todo-heatmap-cell");
  assert(cells.length === expectedDays, "full current calendar year");
  assert(stats.querySelectorAll(".todo-heatmap-month").length === 12, "all month labels");
  const todayCell = [...cells].find((cell) => cell.title.startsWith(`${today}：`))!;
  todayCell.dispatchEvent(new MouseEvent("mouseenter"));
  assert(stats.textContent?.includes(`${today}：完成 2 个待办`), "hover count");
  cells[1].focus();
  await frame();
  assert(stats.textContent?.includes(cells[1].getAttribute("aria-label")!), "keyboard date and count");
  await runActivityHeatmapDom(host, settings);

  const fixture = new Fixture();
  const page = host.createDiv({ cls: "codex-knowledge-settings" });
  fixture.mountKnowledgeDashboard(page, true);
  await tick();
  const rows = page.querySelectorAll<HTMLElement>(".echoink-settings-row");
  assert(rows.length === 2, "two independent folder setting rows");
  const section = page.querySelector<HTMLElement>(".echoink-knowledge-folder-actions")!;
  const cards = section.querySelectorAll<HTMLElement>(":scope > .settings-card");
  assert(section.querySelector("h3")?.textContent === "目录管理" && cards.length === 2, "one section heading with two independent cards");
  assert(rows[0].parentElement === cards[0] && rows[1].parentElement === cards[1], "each action owns its card");
  assert(rows[0].textContent?.includes("文件夹名称优化") && rows[1].textContent?.includes("复原仓库"), "concise row titles");
  assert(!rows[0].textContent?.includes("原始目录记录") && rows[1].textContent?.includes("原始目录记录"), "record belongs to restore only");
  const nav = host.createDiv();
  for (const title of ["维护日志", "已归档会话"]) createSettingsNavigationRow(nav, {
    title, description: title === "维护日志" ? "查看每次维护结果。" : "查看和恢复归档的会话，保留原有记录与内容。",
    actionLabel: "查看", onActivate: () => {}
  });
  for (const width of [320, 480, 600, 900]) {
    settings.style.width = `${width}px`;
    await frame();
    for (const card of cards) {
      const style = getComputedStyle(card);
      assert(style.borderTopStyle === "solid" && parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderRadius) > 0, `folder cards retain visible boundaries at ${width}`);
    }
    assert(cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().bottom >= 12, `independent card spacing at ${width}`);
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      const copy = row.querySelector<HTMLElement>(".setting-copy")!.getBoundingClientRect();
      const button = row.querySelector<HTMLButtonElement>("button")!;
      const control = button.getBoundingClientRect();
      assert(copy.left >= bounds.left - 1 && control.right <= bounds.right + 1, `folder row contains its content at ${width}`);
      assert(getComputedStyle(button).borderStyle !== "none", `action is a visible button at ${width}`);
    }
    assert(rows[1].getBoundingClientRect().top >= rows[0].getBoundingClientRect().bottom - 1, `folder actions stay separate at ${width}`);
    const rect = cells[0].getBoundingClientRect();
    assert(rect.width >= 8 && Math.abs(rect.width - rect.height) < 1, `square heatmap dates at ${width}: ${rect.width}x${rect.height}`);
    const next = cells[1].getBoundingClientRect();
    assert(next.top >= rect.bottom || next.left >= rect.right, `date cells do not overlap at ${width}`);
    const scroller = stats.querySelector<HTMLElement>(".todo-heatmap-scroll")!;
    assert(scroller.clientWidth <= stats.clientWidth && getComputedStyle(scroller).overflowX === "auto", `heatmap scroll stays inside at ${width}`);
    if (width <= 600) {
      for (const row of nav.querySelectorAll<HTMLElement>(".echoink-settings-navigation-row")) {
        const copy = row.querySelector<HTMLElement>(".setting-copy")!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        assert(copy.width > bounds.width - 30 && copy.left - bounds.left < 16, `navigation copy stretches at ${width}`);
      }
    }
  }
  const restore = rows[1].querySelector<HTMLButtonElement>("button")!;
  assert(restore.textContent === "复原" && !restore.disabled, "restore available while initialization dashboard hidden");
  restore.click();
  assert(rows[0].querySelector<HTMLButtonElement>("button")!.disabled && restore.disabled, "directory actions disabled together while running");
  await tick();
  assert(fixture.refreshes === 1, "partial restoration refreshes page");
  disposeOriginControls(page); page.empty(); fixture.mountKnowledgeDashboard(page, true);
  await tick();
  const retry = [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "复原")!;
  assert(retry && !retry.disabled, "restore remains available to retry a conflict");
  assert(retry.closest(".setting-row")?.textContent?.includes("未恢复 1"), "conflict remains in restore row after rerender");
  assert(!page.querySelector(".setting-row")?.textContent?.includes("未恢复 1"), "restore result does not appear on optimize row");
  fixture.plugin.getKnowledgeSurfaceService().getOriginalDirectoryStatus = async () => null;
  const missing = host.createDiv(); fixture.mountKnowledgeDashboard(missing, true); await tick();
  assert([...missing.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "复原")?.disabled, "no record disables restore");
  assert(missing.textContent?.includes("暂无初始化前目录记录"), "no record explains unavailable restore");
  disposeOriginControls(missing); missing.remove();
  const report = document.querySelector<HTMLElement>("#report")!;
  report.dataset.result = "passed";
  report.textContent = "PASS: three shared heatmaps retain count/status legends and titles; arrow/Home/End navigation, inclusive year/month ranges, draft validation/cancel, leap days and per-range scroll; full year, 12 months, hover/focus counts; 320/480/600/900px square cells and aligned rows; separate action feedback, busy state, restore retry and missing-record state. Range selector is available below for native interaction.";
}

export async function runActivityHeatmapDom(host: HTMLElement, settings: HTMLElement, app?: Pick<App, "keymap" | "scope">): Promise<void> {
  const scratch = host.createDiv();
  const previousWidth = settings.style.width;
  settings.style.width = "320px";
  const cells = (parent: HTMLElement) => [...parent.querySelectorAll<HTMLButtonElement>(".todo-heatmap-cell")];
  const legend = (parent: HTMLElement) => [...parent.querySelectorAll<HTMLElement>(".todo-heatmap-legend > span > span")].map((item) => item.textContent).join("|");
  const applied = (parent: HTMLElement, key: string) => ["Mode", "Start", "End"].map((part) => parent.dataset[`${key}Range${part}`]).join("|");
  const write = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const open = (parent: HTMLElement) => {
    const trigger = parent.querySelector<HTMLButtonElement>(".activity-range-trigger")!;
    trigger.click();
    const editor = parent.querySelector<HTMLElement>(".activity-range-editor")!;
    assert(!editor.hidden && trigger.getAttribute("aria-expanded") === "true", "range trigger opens its editor");
    return {
      trigger, editor,
      mode: editor.querySelector<HTMLButtonElement & { value: string }>(".activity-range-mode")!,
      start: editor.querySelector<HTMLInputElement>(".activity-range-start")!,
      end: editor.querySelector<HTMLInputElement>(".activity-range-end")!,
      apply: editor.querySelector<HTMLButtonElement>(".activity-range-apply")!,
      cancel: editor.querySelector<HTMLButtonElement>(".activity-range-cancel")!
    };
  };
  const setMode = (draft: ReturnType<typeof open>, mode: "year" | "month") => {
    if (draft.mode.value !== mode) { draft.mode.value = mode; draft.mode.dispatchEvent(new Event("change")); }
  };
  const edit = (parent: HTMLElement, mode: "year" | "month", start: string, end: string) => {
    const draft = open(parent); setMode(draft, mode); write(draft.start, start); write(draft.end, end); return draft;
  };
  const select = async (parent: HTMLElement, key: string, mode: "year" | "month", start: string, end: string) => {
    const draft = edit(parent, mode, start, end);
    assert(!draft.apply.disabled, `${mode} ${start} through ${end} is an applicable range`);
    draft.apply.click(); await frame();
    assert(applied(parent, key) === `${mode}|${start}|${end}`, `${key} stores the applied inclusive range`);
    assert(draft.editor.hidden && draft.trigger.getAttribute("aria-expanded") === "false" && document.activeElement === draft.trigger, "apply closes editor and restores trigger focus");
  };
  const assertRange = (parent: HTMLElement, first: string, last: string, count: number) => {
    const days = cells(parent);
    assert(days.length === count && days[0].dataset.date === first && days[count - 1].dataset.date === last && new Set(days.map((day) => day.dataset.date)).size === count, `${first} through ${last} includes both boundaries and ${count} distinct days`);
    assert(parent.querySelectorAll(".activity-range-trigger").length === 1 && !parent.querySelector(".activity-heatmap-year, .activity-heatmap-month-select, .todo-history-toggle"), "one range trigger replaces old independent filters and collapse");
    assert(!parent.querySelector<HTMLElement>(".todo-history-body")!.hidden, "calendar stays visible");
  };
  const now = new Date(), currentYear = String(now.getFullYear());
  const currentYearDays = new Date(now.getFullYear(), 1, 29).getMonth() === 1 ? 366 : 365;
  try {
    const counts = [0, 1, 2, 3, 5, 6];
    const history: Record<string, string | null> = { previous: "2023-12-31", leap: "2024-02-29" };
    counts.forEach((count, index) => {
      for (let item = 0; item < count; item++) history[`${index}-${item}`] = `2024-01-0${index + 1}`;
    });
    const store = { completionStatistics: (date = now) => todoCompletionStatistics(history, date) } as EchoInkTodoStore;
    const todo = scratch.createDiv();
    const renderTodo = () => renderTodoStatistics(todo, store, "zh", app);
    const scroller = () => todo.querySelector<HTMLElement>(".todo-heatmap-scroll")!;
    const saveScroll = (offset: number) => { scroller().scrollLeft = offset; scroller().dispatchEvent(new Event("scroll")); return scroller().scrollLeft; };
    renderTodo(); await frame();
    assert(applied(todo, "todoStatistics") === `year|${currentYear}|${currentYear}`, "default range is current year through current year despite historical data");
    assertRange(todo, `${currentYear}-01-01`, `${currentYear}-12-31`, currentYearDays);
    assert(cells(todo).find((cell) => cell.tabIndex === 0)?.dataset.date === localTodoDate(now), "current-year keyboard entry is today");
    await select(todo, "todoStatistics", "year", "2024", "2024");
    assertRange(todo, "2024-01-01", "2024-12-31", 366);
    let dates = cells(todo);
    assert(legend(todo) === "0|1–2|3–5|6+", "to-do count legend remains unchanged");
    [0, 1, 1, 2, 2, 3].forEach((level, index) => assert(dates[index].classList.contains(`todo-level-${level}`), `to-do count ${counts[index]} uses level ${level}`));
    assert(dates[0].style.gridColumn === "1" && dates[0].style.gridRow === "3" && dates[365].style.gridColumn === "53" && dates[365].style.gridRow === "4", "leap-year first and last columns preserve weekdays");
    assert(scroller().scrollWidth > scroller().clientWidth && scroller().scrollLeft > 0, "first past-year view reveals its most recent day");
    const lastBounds = dates[365].getBoundingClientRect(), scrollBounds = scroller().getBoundingClientRect();
    assert(lastBounds.left >= scrollBounds.left - 1 && lastBounds.right <= scrollBounds.right + 1, "latest date is visible on first render");
    const rail = todo.querySelector<HTMLElement>(".activity-heatmap-weekdays")!;
    assert(!scroller().contains(rail) && rail.getBoundingClientRect().right <= scrollBounds.left + 1, "weekday rail stays outside date scroller");
    dates[10].focus();
    for (const [key, index] of [["ArrowUp", 9], ["ArrowDown", 10], ["ArrowLeft", 3], ["ArrowRight", 10], ["Home", 0], ["ArrowUp", 0], ["ArrowLeft", 0], ["End", 365], ["ArrowDown", 365], ["ArrowRight", 365]] as const) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      assert(document.activeElement === dates[index] && event.defaultPrevented && dates.filter((cell) => cell.tabIndex === 0).length === 1, `${key} moves focus with one keyboard entry and suppresses page scroll`);
    }
    const saved2024 = saveScroll(104);
    renderTodo(); await frame();
    assert(applied(todo, "todoStatistics") === "year|2024|2024" && Math.abs(scroller().scrollLeft - saved2024) < 1, "refresh restores applied range and scroll");
    const beforeGrid = todo.querySelector(".todo-heatmap-grid"), beforeSummary = todo.querySelector(".activity-heatmap-period")!.textContent;
    const unchanged = () => assert(todo.querySelector(".todo-heatmap-grid") === beforeGrid && todo.querySelector(".activity-heatmap-period")!.textContent === beforeSummary && applied(todo, "todoStatistics") === "year|2024|2024", "unapplied draft leaves calendar, statistics and saved range unchanged");
    let draft = edit(todo, "year", "2023", "2024");
    assert(draft.start.type === "number" && draft.end.type === "number", "year range uses numeric inputs");
    unchanged(); draft.cancel.click(); unchanged();
    assert(draft.editor.hidden, "cancel closes range editor");
    draft = open(todo);
    assert(draft.start.value === "2024" && draft.end.value === "2024", "reopening discards canceled draft");
    setMode(draft, "month");
    assert(draft.start.type === "month" && draft.end.type === "month" && draft.start.value === "2024-01" && draft.end.value === "2024-12", "year to month expands to January and December");
    write(draft.start, "2023-12"); write(draft.end, "2024-02");
    setMode(draft, "year");
    assert(draft.start.value === "2023" && draft.end.value === "2024", "month to year retains endpoint years");
    draft.editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert(draft.editor.hidden, "Escape closes draft editor"); unchanged();
    draft = open(todo);
    assert(draft.mode.value === "year" && draft.start.value === "2024" && draft.end.value === "2024", "Escape discards mode and endpoint edits");
    const invalid = (start: string, end: string) => {
      write(draft.start, start); write(draft.end, end);
      const error = draft.editor.querySelector<HTMLElement>(".activity-range-error[role=alert]")!;
      assert(draft.apply.disabled && !error.hidden && Boolean(error.textContent), "invalid range disables apply and explains error");
      draft.apply.click(); unchanged();
    };
    invalid("2024", "2023"); invalid("", "2024"); invalid("999", "2024");
    setMode(draft, "month"); invalid("2024-02", "2023-12"); invalid("2023-12", "");
    draft.cancel.click();

    await select(todo, "todoStatistics", "year", "2023", "2024");
    assertRange(todo, "2023-01-01", "2024-12-31", 731);
    assert(todo.querySelector(".activity-heatmap-period")?.textContent === "完成 19 项", "multi-year summary includes both years");
    const savedTwoYears = saveScroll(42);
    await select(todo, "todoStatistics", "year", "2023", "2023");
    const saved2023 = saveScroll(66);
    await select(todo, "todoStatistics", "year", "2023", "2024");
    assert(Math.abs(scroller().scrollLeft - savedTwoYears) < 1, "same start with different end has independent scroll");
    await select(todo, "todoStatistics", "year", "2023", "2023");
    assert(Math.abs(scroller().scrollLeft - saved2023) < 1, "single-year range retains its own scroll");
    await select(todo, "todoStatistics", "month", "2023-12", "2024-11");
    const savedMonths = saveScroll(74);
    await select(todo, "todoStatistics", "month", "2023-12", "2024-02");
    assertRange(todo, "2023-12-01", "2024-02-29", 91);
    assert(cells(todo)[90].title === "2024-02-29：完成 1 个待办", "cross-year month range includes leap-day endpoint");
    const monthLabels = [...todo.querySelectorAll(".todo-heatmap-month")].map((label) => label.textContent ?? "");
    assert(monthLabels.length === 3 && monthLabels[0].includes("2023") && monthLabels[1].includes("2024"), "cross-year month labels identify years at range start and January");
    assert(todo.querySelector(".activity-heatmap-period")?.textContent === "完成 19 项", "cross-year month summary includes the full selected interval");
    await select(todo, "todoStatistics", "month", "2023-12", "2024-11");
    assert(Math.abs(scroller().scrollLeft - savedMonths) < 1, "month range restores scroll independently of its shorter range");
    await select(todo, "todoStatistics", "year", "2024", "2024");
    assert(Math.abs(scroller().scrollLeft - saved2024) < 1, "year range scroll survives switching granularity");
    await select(todo, "todoStatistics", "month", "2024-02", "2024-02");
    assertRange(todo, "2024-02-01", "2024-02-29", 29);
    assert(cells(todo).filter((cell) => !cell.classList.contains("todo-level-0")).length === 1, "single month excludes January completions");
    renderTodo(); await frame();
    assert(applied(todo, "todoStatistics") === "month|2024-02|2024-02", "refresh retains applied month range");
    assertRange(todo, "2024-02-01", "2024-02-29", 29);

    const sparse = scratch.createDiv();
    const sparseDays = [{ date: "2023-11-30", count: 16 }, { date: "2023-12-01", count: 4 }, { date: "2023-12-31", count: 2 }, { date: "2024-01-01", count: 3 }, { date: "2024-02-29", count: 5 }, { date: "2024-03-01", count: 32 }, { date: "2028-01-01", count: 1 }, { date: "2028-12-31", count: 1 }];
    let selectedDates: string[] = [];
    renderActivityHeatmap(sparse, sparse.createDiv(), sparse, {
      days: sparseDays, title: "稀疏活动", zh: true, stateKey: "sparse", app,
      summary: (days) => { selectedDates = days.map((day) => day.date); return `本期合计 ${days.reduce((sum, day) => sum + (day.count ?? 0), 0)}`; }
    });
    await select(sparse, "sparse", "month", "2023-12", "2024-02");
    assert(selectedDates.length === 91 && selectedDates[0] === "2023-12-01" && selectedDates[90] === "2024-02-29" && sparse.textContent?.includes("本期合计 14"), "range includes first and last activity but excludes adjacent days outside it");
    await select(sparse, "sparse", "month", "2025-01", "2025-03");
    assertRange(sparse, "2025-01-01", "2025-03-31", 90);
    assert(cells(sparse).every((cell) => cell.classList.contains("todo-level-0")) && sparse.textContent?.includes("本期合计 0"), "data-free interval fills days and resets summary");
    await select(sparse, "sparse", "year", "2028", "2028");
    assertRange(sparse, "2028-01-01", "2028-12-31", 366);
    dates = cells(sparse);
    assert(sparse.querySelector<HTMLElement>(".todo-heatmap-grid")!.style.getPropertyValue("--todo-heatmap-weeks") === "54" && dates[0].style.gridRow === "8" && dates[365].style.gridColumn === "54" && dates[365].style.gridRow === "2", "Saturday-start leap year keeps final Sunday in column 54");
    const empty = scratch.createDiv();
    renderActivityHeatmap(empty, empty.createDiv(), empty, { days: [], title: "尚无活动", zh: true, stateKey: "empty", app });
    assertRange(empty, `${currentYear}-01-01`, `${currentYear}-12-31`, currentYearDays);
    assert(cells(empty).every((cell) => cell.classList.contains("todo-level-0")), "no source records still produces a usable calendar");

    const diary = scratch.createDiv();
    const expressionCounts = [0, 1, 5, 6, 10, 11];
    const activity = expressionCounts.map((expressionCount, index) => ({ date: `2024-01-0${index + 1}`, generationCount: 1, expressionCount }));
    const repository = { listGenerationActivity: async () => activity, listExpressions: async () => [] };
    await renderEnglishDiaryActivity(diary, repository, app); await frame();
    assert(applied(diary, "diaryActivity") === `year|${currentYear}|${currentYear}`, "diary uses the same default range");
    await select(diary, "diaryActivity", "month", "2024-01", "2024-01");
    assertRange(diary, "2024-01-01", "2024-01-31", 31);
    assert(diary.querySelector(".activity-heatmap-period")?.textContent === "生成 33 个表达 · 打卡 6 天", "diary counts zero-expression successful generations as active days");
    assert(legend(diary) === "0|1–5|6–10|11+", "diary retains expression-count legend");
    [0, 1, 1, 2, 2, 3].forEach((level, index) => {
      const day = cells(diary)[index];
      assert(day.classList.contains(`todo-level-${level}`) && day.title === `${activity[index].date} · ${expressionCounts[index]} 个表达 · 生成 1 次`, `diary expression count ${expressionCounts[index]} preserves level and title`);
    });
    await select(diary, "diaryActivity", "month", "2024-02", "2024-03");
    assertRange(diary, "2024-02-01", "2024-03-31", 60);
    assert(cells(diary).every((cell) => cell.classList.contains("todo-level-0") && cell.title.endsWith("0 个表达 · 生成 0 次")), "empty diary interval has zero expressions and generations");
    await renderEnglishDiaryActivity(diary, repository, app); await frame();
    assert(applied(diary, "diaryActivity") === "month|2024-02|2024-03", "async diary refresh retains applied endpoints");

    const categories = scratch.createDiv();
    const statuses = ["none", "success", "failed"] as const, labels = ["无记录", "成功", "失败"];
    const days = statuses.map((level, index) => ({ date: `2024-01-0${index + 1}`, count: 99, level, label: `2024-01-0${index + 1} · ${labels[index]}` }));
    const footer = renderActivityHeatmap(categories, categories.createDiv(), categories, {
      days, legend: statuses.map((level, index) => ({ level, label: labels[index] })), emptyLevel: "none",
      label: (date) => `${date} · 无记录`, title: "每日体检状态", zh: true, stateKey: "knowledgeHeatmap", app
    });
    let historyOpens = 0;
    const historyButton = footer.createEl("button", { text: "维护日志" }); historyButton.onclick = () => { historyOpens++; };
    await select(categories, "knowledgeHeatmap", "month", "2024-01", "2024-01");
    assert(legend(categories) === labels.join("|"), "categorical legend preserves none/success/failed");
    days.forEach((day, index) => {
      const cell = cells(categories)[index];
      assert(cell.classList.contains(`todo-level-${statuses[index]}`) && !cell.classList.contains("todo-level-3") && cell.title === day.label && cell.getAttribute("aria-label") === cell.title, "explicit categorical status and accessible label override count");
    });
    assert(cells(categories)[3].classList.contains("todo-level-none") && cells(categories)[3].title === "2024-01-04 · 无记录", "missing categorical day uses no-record status");
    await select(categories, "knowledgeHeatmap", "month", "2024-02", "2024-03");
    assert(cells(categories).every((cell) => cell.classList.contains("todo-level-none")), "empty categorical interval preserves none status");
    historyButton.click();
    assert(footer === categories.querySelector(".todo-history-footer") && footer.querySelector('[role="status"][aria-live="polite"]') && historyButton.isConnected && historyOpens === 1, "shared footer, live detail and caller action survive range changes");
  } finally {
    disposeOriginControls(scratch); scratch.remove(); settings.style.width = previousWidth;
  }
}
