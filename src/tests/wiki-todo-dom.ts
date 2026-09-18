import { renderTodoStatistics } from "../settings/todo-statistics";
import { todoCompletionStatistics, localTodoDate } from "../home/todo-completions";
import type { EchoInkTodoStore } from "../home/todo-store";

export async function runWikiTodoDom(Fixture: new () => { mountKnowledgeDashboard(page: HTMLElement, zh: boolean): void; refreshes: number; plugin: { getKnowledgeSurfaceService(): unknown } }) {
  const create = function (this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
    this.appendChild(el); return el;
  };
  Object.assign(HTMLElement.prototype, {
    empty() { this.replaceChildren(); }, addClass(...tokens: string[]) { this.classList.add(...tokens); },
    setText(text: string) { this.textContent = text; }, setAttr(name: string, value: string) { this.setAttribute(name, value); },
    createEl: create, createDiv(options: Parameters<typeof create>[1]) { return create.call(this, "div", options); }
  });
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const host = document.querySelector<HTMLElement>("#fixture")!;
  const stats = host.createDiv();
  const today = localTodoDate(new Date());
  renderTodoStatistics(stats, { completionStatistics: () => todoCompletionStatistics({ a: today, b: today, old: null }) } as EchoInkTodoStore, "zh");
  const cells = stats.querySelectorAll<HTMLButtonElement>(".heatmap-cell");
  assert(cells.length === 365, "365 calendar days");
  const last = cells[cells.length - 1];
  last.dispatchEvent(new MouseEvent("mouseenter"));
  assert(stats.querySelector('[role="status"]')?.textContent === `${today}：完成 2 个待办`, "hover count");
  cells[0].focus();
  assert(stats.querySelector('[role="status"]')?.textContent === cells[0].getAttribute("aria-label"), "keyboard focus matches date and count");
  host.style.width = "320px";
  const scroller = stats.querySelector<HTMLElement>(".heatmap-scroll")!;
  assert(scroller.scrollWidth > scroller.clientWidth && getComputedStyle(scroller).overflowX === "auto", "narrow width scrolls locally");
  const fixture = new Fixture();
  const page = host.createDiv();
  fixture.mountKnowledgeDashboard(page, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restore = [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "恢复初始化前目录")!;
  assert(restore && !restore.disabled, "restore available with failed/cancelled initialization and hidden dashboard");
  restore.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(fixture.refreshes === 1, "partial restoration refreshes page");
  page.empty(); fixture.mountKnowledgeDashboard(page, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retry = [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "恢复初始化前目录")!;
  assert(retry && !retry.disabled, "restore remains available to retry a conflict");
  assert(page.textContent?.includes("未恢复 1"), "conflict result remains visible");
  const report = document.querySelector<HTMLElement>("#report")!;
  report.dataset.result = "passed";
  report.textContent = "PASS: 365 days, hover/focus date counts, 320px scroll, restore for failed/cancelled initialization, partial restore retry.";
}
