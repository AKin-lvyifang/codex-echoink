import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { TFile, TFolder } from "obsidian";
import { EchoInkJournalView } from "../home/journal-page";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import { journalMonthSelection, journalPageEntries, journalStats, journalSummary } from "../home/journal-stats";
import { renderPhotoCalendar } from "../home/photo-calendar";
import { EchoInkHomeView } from "../home/home-view";

export async function runJournalPageTests(root: string): Promise<void> {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true });
  const win = dom.window;
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  const proto = win.HTMLElement.prototype as any;
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (text: string) { this.textContent = text; };
  proto.addClass = function (...names: string[]) { this.classList.add(...names); };
  proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
  proto.toggleClass = function (name: string, active: boolean) { this.classList.toggle(name, active); };
  proto.setAttr = function (name: string, value: string) { this.setAttribute(name, value); };
  proto.createEl = function (tag: string, options: any = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    if (options.value) el.value = options.value;
    for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, String(value));
    this.appendChild(el); return el;
  };
  proto.createDiv = function (options: any = {}) { return this.createEl("div", options); };
  proto.createSpan = function (options: any = {}) { return this.createEl("span", options); };
  const record = (file: string) => ({ path: file, title: file.split("/").at(-1)!.slice(0, -3), folder: file.split("/").slice(0, -1).join("/"), mtime: 1 });
  const records = ["Daily/2025-12-31.md", "Daily/2026-01-01.md", "Daily/2026-01/2026-01-01.md", "Daily/2026-01-02.md", "Daily/2027-01-01.md", "Daily/2024-02-29.md", "Daily/2023-02-29.md", "Else/2026-01-02.md"].map(record);
  const stats = journalStats(records, "Daily", "YYYY-MM-DD", new Date(2026, 0, 2));
  assert.equal(stats.currentYearCount, 3, "Empty templates and duplicate dates count as separate files");
  assert.equal(stats.streak, 3, "Streak crosses New Year and deduplicates dates");
  assert.equal(journalStats(records, "Daily", "YYYY-MM-DD", new Date(2026, 0, 3)).streak, 3, "Today may still be blank");
  assert.equal(journalStats(records, "Daily", "YYYY-MM-DD", new Date(2026, 0, 4)).streak, 0);
  assert.ok(stats.entries.some(entry => entry.date === "2024-02-29"));
  assert.equal(stats.entries.some(entry => entry.date === "2023-02-29"), false);
  assert.equal(stats.days.find(day => day.date === "2026-01-01")!.count, 2);
  assert.equal(journalMonthSelection(new Date(2024, 1, 1), "2024-01-31"), "2024-02-29");
  assert.equal(journalSummary("---\ndate: 2026-01-01\n---\n# 空模板\n![[photo.png]]"), "空模板");
  assert.equal(journalStats([record("日志/2024/week/02-29.md")], "日志", "YYYY/[week]/MM-DD", new Date(2024, 1, 29)).streak, 1);

  const files = new Map<string, TFile>();
  let reads = 0, writes = 0;
  for (let day = 1; day <= 13; day++) for (const prefix of ["", "2026-01/"]) {
    const relative = `Daily/${prefix}2026-01-${String(day).padStart(2, "0")}.md`;
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), day === 1 ? "" : `# 原文 ${day}\n正文 ${day}`);
    files.set(relative, Object.assign(new TFile(), { path: relative, basename: relative.split("/").at(-1)!.slice(0, -3), parent: { path: path.dirname(relative) }, stat: { mtime: 1, ctime: 1 } }));
  }
  const options = { folder: "Daily", format: "YYYY-MM-DD" };
  const folders = new Map(["Daily", "Other"].map(path => [path, Object.assign(new TFolder(), { path })]));
  const app: any = { vault: { getMarkdownFiles: () => [...files.values()], getRoot: () => ({ children: [{ path: "Daily" }] }), getAbstractFileByPath: (relative: string) => files.get(relative) ?? folders.get(relative),
    cachedRead: async (file: TFile) => { reads++; return readFile(path.join(root, file.path), "utf8"); }, create: async () => { writes++; throw new Error("Unexpected write"); }, getResourcePath: () => "app://fixture/photo.png" },
    metadataCache: { getFileCache: () => ({ embeds: [] }), getFirstLinkpathDest: () => undefined }, internalPlugins: { plugins: { "daily-notes": { instance: { options } } } },
    scope: {}, keymap: { pushScope() {}, popScope() {} }, workspace: { getLeaf: () => ({ openFile: async (file: TFile) => { opened = file.path; } }) } };
  let opened = "", prefills = 0;
  const plugin: any = { app, settings: { settingsLanguage: "zh-CN", journalDirectory: "Legacy", englishDiary: { enabled: false }, agentRegistry: { agents: [{ id: "sol", name: "总助" }], moduleOwners: { journal: "sol" } } },
    activateHomeView: async () => undefined, openAgentTaskList: async () => { prefills++; return true; }, openEchoInkKnowledgeSettings: async () => undefined };
  const service = new HomeWorkbenchDataService(app, () => "Legacy");
  const snapshot = await service.buildJournalRecords();
  assert.equal(snapshot.records.length, 26); assert.equal(reads, 0, "Enumerating all journals never reads their bodies");
  const view: any = new EchoInkJournalView({} as any, plugin);
  Object.assign(view, { app, contentEl: win.document.querySelector("main"), dataService: service, closed: false, month: new Date(2026, 0, 1), selected: "2026-01-31", listYear: 2026 });
  view.renderShell(); await view.refresh();
  assert.equal(view.field("list").querySelectorAll(".journal-entry-row").length, 20);
  assert.equal(reads, 20, "Only the visible 20 summaries read original files");
  assert.equal(journalPageEntries(view.stats.entries, 2026, 0, 2).entries.length, 6);
  const heatmap = view.field("heatmap"), range = heatmap.querySelector(".activity-range-trigger") as HTMLButtonElement;
  range.click(); const draft = heatmap.querySelector(".activity-range-start") as HTMLInputElement; draft.value = "2020"; draft.focus();
  view.changeMonth(1); assert.equal(view.selected, "2026-02-28"); assert.equal(view.field("heatmap"), heatmap); assert.equal(draft.value, "2020"); assert.equal(win.document.activeElement, draft, "Flipping month preserves the heatmap draft and focus");
  assert.equal(writes, 0, "Browsing and date selection do not create files");
  view.month = new Date(2026, 0, 1); view.listYear = 2026; view.page = 2; await view.renderList();
  assert.equal(view.field("list").querySelectorAll(".journal-entry-row").length, 6); assert.equal(reads, 26);
  const row = view.field("list").querySelector(".journal-entry-row") as HTMLButtonElement; row.click(); await Promise.resolve(); assert.ok(opened.startsWith("Daily/"));
  view.mode = "year"; await view.renderList(); assert.equal(view.field("list").querySelectorAll(".journal-month-row").length, 1);
  view.field("list").querySelector(".journal-month-row").click(); await Promise.resolve(); assert.equal(view.mode, "month");
  view.selected = "2026-01-31";
  const obsidian = await import("obsidian") as any;
  await view.openSelected();
  assert.equal(obsidian.openTestModals.length, 1, "An explicit empty-day action opens the original template picker");
  obsidian.openTestModals.at(-1).close(); assert.equal(writes, 0, "Cancelling the original template picker writes nothing");
  let releaseOwner!: () => void;
  const ownerFlight = new Promise<void>(resolve => { releaseOwner = resolve; });
  plugin.openAgentTaskList = async (id: string, text: string) => { assert.equal(id, "new-owner"); assert.equal(text, "聊聊今天"); prefills++; await ownerFlight; return true; };
  plugin.settings.agentRegistry.agents.push({ id: "new-owner", name: "新负责人" }); plugin.settings.agentRegistry.moduleOwners.journal = "new-owner";
  const owner = view.field("owner") as HTMLButtonElement; owner.click(); owner.click();
  assert.equal(prefills, 1); assert.equal(owner.disabled, true); assert.equal(owner.getAttribute("aria-busy"), "true");
  releaseOwner(); await ownerFlight; await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(owner.disabled, false, "Owner action restores the same control when its async prefill finishes");
  view.mode = "year"; view.listYear = 2025; await view.renderList();
  Array.from(view.field("toolbar").querySelectorAll("[role=tab]")).find((button: any) => button.textContent === "按月")!.click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(view.month.getFullYear(), 2025, "Switching from a historical year to month keeps the selected year");
  assert.match(view.field("toolbar").textContent, /2025/);
  view.month = new Date(2026, 0, 1); view.listYear = 2026; await view.renderList();
  let finish!: (value: any) => void;
  const build = service.buildJournalRecords.bind(service);
  service.buildJournalRecords = () => new Promise(resolve => { finish = resolve; });
  const stale = view.refresh();
  service.buildJournalRecords = build;
  view.changeMonth(1); await view.refresh(); finish(snapshot); await stale;
  assert.equal(view.month.getMonth(), 1, "An old async snapshot cannot move the user back to an old month");
  const originalRead = app.vault.cachedRead;
  app.vault.cachedRead = async () => { throw new Error("read denied"); };
  view.month = new Date(2026, 0, 1); view.page = 1; view.summaries.clear(); await view.renderList();
  assert.match(view.field("list").textContent, /尚未更新/); app.vault.cachedRead = originalRead;
  const oldStats = view.stats; service.buildJournalRecords = async () => { throw new Error("metadata unavailable"); }; await view.refresh();
  assert.equal(view.stats, oldStats); assert.match(view.field("status").textContent, /尚未更新/); service.buildJournalRecords = build;
  options.folder = "Other"; view.refreshIfSettingsChanged(); await Promise.resolve(); await Promise.resolve(); assert.equal(view.snapshot.settings.folder, "Other", "Native folder changes participate in the settings signature");
  await view.onClose(); assert.equal(writes, 0); assert.equal(prefills, 1);

  const parent = win.document.body.createDiv(); const weekdays = parent.createDiv(); const days = parent.createDiv();
  renderPhotoCalendar({ weekdays, days, month: new Date(2026, 0, 1), selected: "2026-01-01", folder: "Daily", format: "YYYY-MM-DD", language: "en", records: [{ ...records[1], firstImageUrl: "app://missing-image" }] });
  const photoDay = days.querySelector('[data-date="2026-01-01"]')!; photoDay.querySelector("img")!.dispatchEvent(new win.Event("error"));
  assert.equal(photoDay.classList.contains("has-photo"), false); assert.ok(photoDay.classList.contains("has-record"));
  assert.equal(photoDay.textContent, "1");
  // The original home invokes this same renderer and retains its selection/open actions.
  const oldHome: any = Object.create(EchoInkHomeView.prototype);
  const host = win.document.body.createDiv(); host.innerHTML = '<div data-home="month-label"></div><div class="calendar-weekdays"></div><div data-home="calendar-days"></div><div data-home="month-record-count"></div><div data-home="journal-label"></div><div data-home="journal-hint"></div>';
  options.folder = "Daily"; Object.assign(oldHome, { app, plugin, contentEl: host, month: new Date(2026, 0, 1), selectedDate: "2026-01-01", data: snapshot, dataService: service });
  oldHome.renderCalendar(); assert.ok(host.querySelector('[data-date="2026-01-01"]')!.classList.contains("has-record"));
  console.log("Journal page PASS: real data service/view, cross-year/leap/duplicates/future/empty templates/custom native paths, 20-row paging, photo fallback, bounded summaries/read failure, stale month, heatmap draft, legacy calendar, zero writes");
  win.close();
}
