import { renderTodoStatistics } from "../settings/todo-statistics";
import { todoCompletionStatistics, localTodoDate } from "../home/todo-completions";
import type { EchoInkTodoStore } from "../home/todo-store";
import { createSettingsNavigationRow } from "../settings/settings-v2";
import { disposeOriginControls } from "../settings/origin-controls";

type FixtureService = { getOriginalDirectoryStatus(): Promise<{ createdAt: number; files: number } | null> };

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
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const host = document.querySelector<HTMLElement>("#fixture")!;
  const settings = document.querySelector<HTMLElement>("#settings")!;
  const stats = host.createDiv();
  const now = new Date();
  const today = localTodoDate(now);
  const history = { a: today, b: today, old: null, leap: "2024-02-29", previous: "2023-12-31" };
  const store = { completionStatistics: (date = now, year = date.getFullYear()) => todoCompletionStatistics(history, date, year) } as EchoInkTodoStore;
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
  report.textContent = "PASS: full year, 12 months, hover/focus counts; 320/480/600/900px square cells and aligned rows; separate action feedback, busy state, restore retry and missing-record state. Year selector is available below for native interaction.";
}
