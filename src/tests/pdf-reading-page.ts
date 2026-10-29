import { installObsidianDom } from "./obsidian-dom";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { openTestNoticeMessages } from "obsidian";
import { PdfReadingPageView, PDF_READING_PAGE_VIEW_TYPE } from "../home/pdf-reading-page";
import { PdfReadingUploadModal } from "../home/pdf-reading-upload-modal";
import type { PdfNavigationData, PdfNavigationEntry, PdfNavigationStart } from "../pdf-reading/types";

/** Real page/form classes with local host and Origin stubs; no provider or Vault writes. */
export async function runPdfReadingPageTests(): Promise<void> {
  const dom = new JSDOM("<body><main></main><button id=upload>Upload</button></body>", { pretendToBeVisual: true });
  installObsidianDom(dom.window);
  const win = dom.window;
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  const proto = win.HTMLElement.prototype as any;
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (text: string) { this.textContent = text; };
  proto.addClass = function (...names: string[]) { this.classList.add(...names); };
  proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
  proto.toggleClass = function (name: string, value: boolean) { this.classList.toggle(name, value); };
  proto.setAttr = function (name: string, value: string) { this.setAttribute(name, value); };
  proto.createEl = function (tag: string, options: any = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.value !== undefined) element.value = options.value;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
    this.appendChild(element); return element;
  };
  proto.createDiv = function (options: any) { return this.createEl("div", options); };
  proto.createSpan = function (options: any) { return this.createEl("span", options); };
  const root = win.document.querySelector("main")!;
  let subscriptions = 0, releases = 0, home = 0, settings = 0, loads = 0, cancels = 0;
  let directories = ["Sources/PDF"], startReason = "";
  let opened = "", task = "", admissionError = "";
  const tasks: PdfNavigationStart[] = [], validates: PdfNavigationStart[] = [];
  const eventHost = { on: () => { subscriptions++; return {}; }, offref: () => { releases++; } };
  const subscribe = () => { subscriptions++; return () => { releases++; }; };
  const app: any = { vault: eventHost, workspace: eventHost, scope: {}, keymap: { pushScope() {}, popScope() {} } };
  const entries = Array.from({ length: 25 }, (_, index) => entry(index));
  let next: PdfNavigationData = { entries, errors: [] };
  let readError = false, failOpen = false;
  const plugin: any = {
    app, settings: { settingsLanguage: "zh-CN", pdfReading: { enabled: true, engine: "local", translationLanguage: "中文" }, agentRegistry: { moduleOwners: { "pdf-reading": "researcher" }, agents: [{ id: "general-assistant", name: "总助" }, { id: "researcher", name: "研究员" }] } },
    pdfReading: {
      api: { subscribe, deps: { access: { subscribe } }, cancel() { cancels++; } },
      navigationData: async () => { loads++; if (readError) throw new Error("disk unavailable"); return next; },
      originalDirectories: () => directories, defaultOriginalDirectory: () => directories[0] ?? "",
      openNote: async (path: string) => { if (failOpen) throw new Error("成果已移动或不存在。"); opened = path; }
    },
    pdfNavigationStartReason: () => startReason,
    validatePdfNavigationStart: async (input: PdfNavigationStart) => { validates.push(input); },
    startPdfNavigationTask: async (input: PdfNavigationStart) => { if (admissionError) throw new Error(admissionError); tasks.push(input); return "new-task"; },
    openTaskDetail: async (id: string) => { task = id; }, activateHomeView: async () => { home++; }, openEchoInkKnowledgeSettings: async () => { settings++; }
  };
  const view: any = new PdfReadingPageView({} as any, plugin);
  Object.assign(view, { app, contentEl: root, containerEl: root, closed: false });
  view.renderShell(); await view.refresh();
  assert.equal(view.getViewType(), PDF_READING_PAGE_VIEW_TYPE);
  assert.equal(root.querySelectorAll(".pdf-page-history-row").length, 20);
  assert.ok(root.textContent!.includes("选择一份PDF查看成果"));
  assert.equal(tasks.length, 0); assert.equal(validates.length, 0);
  const list = view.field("history"); list.scrollTop = 123;
  (list.querySelector("button") as HTMLButtonElement).click();
  assert.equal(list.scrollTop, 123); assert.equal(view.selectedId, "pdf-0");
  assert.equal(root.querySelector('[aria-current="true"]')?.getAttribute("data-pdf-job"), "pdf-0");
  assert.ok(view.field("detail").textContent.includes("这份历史记录没有保存原件"));
  (view.field("detail").querySelector(".pdf-page-artifact-row") as HTMLButtonElement).click(); await tick(); assert.equal(opened, "Sources/raw-0.md");
  (view.field("detail").querySelector(".pdf-page-task") as HTMLButtonElement).click(); await tick(); assert.equal(task, "task-0");
  const savedFirst = structuredClone(entries[0]);
  entries[0].job.options.reading = true; entries[0].job.options.wiki = true; entries[0].job.state = "completed";
  entries[0].taskStatus = "running"; await view.refresh();
  assert.ok(view.field("detail").querySelector(".pdf-page-run-state").textContent.includes("正在核对成果"), "extractor completion cannot impersonate saved knowledge while task runs");
  entries[0].taskStatus = "interrupted"; await view.refresh();
  assert.equal(view.field("detail").querySelector(".pdf-page-run-state").textContent, "已中断", "Catalog interruption wins over completed chunks");
  delete entries[0].taskStatus; await view.refresh();
  assert.equal(view.field("detail").querySelector(".pdf-page-run-state").textContent, "部分完成", "missing selected knowledge is not completed without task proof");
  entries[0] = savedFirst; await view.refresh();
  const pagination = view.field("pagination").querySelectorAll("nav button"); (pagination[1] as HTMLButtonElement).click();
  assert.equal(root.querySelectorAll(".pdf-page-history-row").length, 5); assert.equal(view.selectedId, "pdf-0");
  assert.ok(view.field("detail").textContent.includes("paper-0.pdf"), "Paging keeps the selected outputs");
  view.field("history").scrollTop = 42;
  next = { entries: entries.map(item => item.job.id === "pdf-0" ? { ...item, originalState: "changed", artifacts: [{ kind: "original", path: "Sources/original.pdf", label: "原文件" }, { kind: "wiki", path: "Wiki/missing.md", label: "知识成果", missing: true }] } : item), errors: ["bad record"] };
  await view.refresh();
  assert.equal(view.page, 2); assert.equal(view.field("history").scrollTop, 42);
  assert.ok(view.field("status").textContent.includes("部分记录暂时读不到"));
  assert.ok(view.field("detail").textContent.includes("原PDF已经改过"));
  assert.equal(view.field("detail").querySelectorAll("button.pdf-page-artifact-row").length, 0);
  assert.ok(view.field("detail").textContent.includes("这个成果文件找不到了"));
  next = { entries: [entries[0]], errors: [] }; await view.refresh();
  failOpen = true;
  (view.field("detail").querySelector("button.pdf-page-artifact-row") as HTMLButtonElement).click(); await tick();
  assert.ok(openTestNoticeMessages.at(-1)?.includes("成果已移动")); failOpen = false;
  readError = true; await view.refresh();
  assert.ok(view.field("status").textContent.includes("暂时读不到PDF记录"));
  assert.ok(view.field("detail").textContent.includes("paper-0.pdf"), "A failed refresh keeps the last readable detail");
  readError = false; next = { entries: [], errors: ["malformed"] }; await view.refresh();
  assert.ok(view.field("status").textContent.includes("暂时读不到PDF记录"));
  assert.equal(view.field("history").textContent.includes("还没有处理过PDF"), false);
  next = { entries: [], errors: [] }; await view.refresh(); assert.ok(view.field("history").textContent.includes("还没有处理过PDF"));
  let finish!: (value: PdfNavigationData) => void;
  plugin.pdfReading.navigationData = () => new Promise(resolve => { finish = resolve; });
  const stale = view.refresh();
  plugin.pdfReading.navigationData = async () => ({ entries: [entries[1]], errors: [] }); await view.refresh(); finish({ entries, errors: [] }); await stale;
  assert.equal(view.snapshot.entries.length, 1); assert.equal(view.snapshot.entries[0].job.id, "pdf-1");
  view.subscribe(); assert.equal(subscriptions, 6); view.unsubscribe(); assert.equal(releases, 6);
  view.foreground = { isActive: () => false, dispose() {} }; const oldLoads = loads; await view.refresh(); assert.equal(loads, oldLoads);
  await view.onClose(); assert.equal(cancels, 0); assert.equal(home, 0);

  const focus = win.document.querySelector<HTMLElement>("#upload")!;
  const openForm = () => { const modal: any = new PdfReadingUploadModal(plugin, focus); modal.open(); return modal; };
  const file = (name = "paper.pdf", size = 1024, path = "/synthetic/selected.pdf") => ({ name, size, path, type: "application/pdf" });
  let modal = openForm();
  assert.equal(modal.options().translation, true); assert.equal(modal.options().reading, true); assert.equal(modal.options().summary, true);
  assert.equal(modal.startButton.disabled, true);
  assert.equal(modal.contentEl.querySelector('[data-pdf-upload="raw"]').checked, true);
  assert.equal(modal.contentEl.querySelector('[data-pdf-upload="raw"]').disabled, true);
  modal.selectFiles([file()]); assert.equal(Object.isFrozen(modal.attachment), true); assert.equal(tasks.length, 0);
  modal.selectFiles([file("replacement.pdf", 2048)]); assert.equal(modal.attachment.name, "replacement.pdf");
  modal.close(); assert.equal(modal.attachment, null); assert.equal(tasks.length, 0); assert.equal(validates.length, 0);
  assert.equal(win.document.activeElement, focus);
  modal = openForm();
  for (const invalid of [[file("wrong.txt")], [file("empty.pdf", 0)], [file("large.pdf", 20 * 1024 * 1024 + 1)], [file(), file()]]) {
    modal.selectFiles(invalid); assert.equal(modal.attachment, null); assert.equal(modal.startButton.disabled, true);
  }
  modal.selectFiles([{ name: "host.pdf", size: 1024, hostPath: "/synthetic/electron.pdf" }]); assert.equal(modal.attachment.path, "/synthetic/electron.pdf");
  modal.selectFiles([file()]); startReason = "研究员还不能整理知识库"; modal.update(); assert.equal(modal.startButton.disabled, true); assert.ok(modal.status.textContent.includes("还不能整理知识库"));
  startReason = "";
  const check = (key: string, value: boolean) => { const control = modal.contentEl.querySelector(`[data-pdf-upload="${key}"]`); control.checked = value; control.dispatchEvent(new win.Event("change", { bubbles: true })); };
  check("translation", false); check("reading", false); check("summary", true);
  admissionError = "原件目录已经失效"; await modal.start();
  assert.equal(tasks.length, 0); assert.equal(modal.attachment.name, "paper.pdf"); assert.ok(modal.status.textContent.includes(admissionError));
  assert.equal(modal.startButton.disabled, false, "A failed admission can be retried with the same form");
  admissionError = "";
  let validateDone!: () => void;
  plugin.validatePdfNavigationStart = (input: PdfNavigationStart) => { validates.push(input); return new Promise<void>(resolve => { validateDone = resolve; }); };
  const pending = modal.start(); await modal.start(); assert.equal(modal.busy, true); validateDone(); await pending;
  assert.equal(tasks.length, 1, "Repeated start is admitted once");
  assert.equal(tasks[0].options.reading, false); assert.equal(tasks[0].options.summary, true); assert.equal(tasks[0].options.wiki, true); assert.equal(tasks[0].options.translation, false);
  assert.equal(Object.isFrozen(tasks[0]), true); assert.equal(Object.isFrozen(tasks[0].options), true); assert.equal(modal.closed, true);
  plugin.validatePdfNavigationStart = () => new Promise<void>(resolve => { validateDone = resolve; });
  modal = openForm(); modal.selectFiles([file()]); const cancelled = modal.start(); modal.close(); validateDone(); await cancelled;
  assert.equal(tasks.length, 1, "Cancel during validation does not create a task");
  directories = []; modal = openForm(); assert.equal(modal.startButton.disabled, true);
  const config = Array.from(modal.contentEl.querySelectorAll("button")).find((button: any) => button.textContent === "去设置资料来源") as HTMLButtonElement;
  config.click(); await tick(); assert.equal(settings, 1);
  plugin.settings.settingsLanguage = "en"; directories = ["Sources/PDF"];
  modal = openForm(); assert.ok(modal.contentEl.textContent.includes("Extract source text (for citations)")); modal.close();
  plugin.validatePdfNavigationStart = async () => {};
  for (const [translation, reading, summary] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true], [false, true, true]]) {
    modal = openForm(); modal.selectFiles([file()]);
    modal.translation = translation; modal.reading = reading; modal.summary = summary; modal.update();
    await modal.start();
    const actual = tasks.at(-1)!.options;
    assert.deepEqual([actual.translation, actual.reading, actual.summary, actual.wiki], [translation, reading, summary, reading || summary]);
  }
  assert.equal(subscriptions, releases, "Closing views and forms releases all local subscriptions");
  dom.window.close();
  console.log("PDF page UI tests passed: read-only history, 20-row pagination, selected/scroll preservation, missing/changed/error states, stale/foreground cleanup, file selection/replace/cancel, frozen independent outputs, retry and single admission.");
}
function entry(index: number): PdfNavigationEntry {
  return { job: { version: 1, id: `pdf-${index}`, name: `paper-${index}.pdf`, createdAt: 1700000000000 - index * 1000, options: { engine: "local", reading: true, translation: true, wiki: true, summary: true }, state: "completed", stage: "处理完成", rawDirectory: "Sources", artifacts: [{ kind: "raw", path: `Sources/raw-${index}.md` }], pages: [], chunks: [], warnings: [], published: {} }, artifacts: [{ kind: "raw", path: `Sources/raw-${index}.md`, label: "提取原文" }], originalState: "not-saved", taskId: `task-${index}` };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
