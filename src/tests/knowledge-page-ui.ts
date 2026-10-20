import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { TFile, TFolder } from "obsidian";
import { KnowledgePageView, KNOWLEDGE_PAGE_VIEW_TYPE } from "../home/knowledge-page";

/** Local DOM checks use synthetic snapshots; native layout remains an integration check. */
export async function runKnowledgePageUiTests(): Promise<void> {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true });
  const win = dom.window;
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  const proto = win.HTMLElement.prototype as any;
  proto.empty = function () { this.replaceChildren(); };
  proto.setText = function (text: string) { this.textContent = text; };
  proto.addClass = function (...names: string[]) { this.classList.add(...names); };
  proto.removeClass = function (...names: string[]) { this.classList.remove(...names); };
  proto.toggleClass = function (name: string, value: boolean) { this.classList.toggle(name, value); };
  proto.setAttr = function (name: string, value: string) { this.setAttribute(name, value); };
  proto.scrollIntoView = function () {};
  proto.createEl = function (tag: string, options: any = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.value !== undefined) element.value = options.value;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value));
    this.appendChild(element); return element;
  };
  proto.createDiv = function (options: any) { return this.createEl("div", options); };
  proto.createSpan = function (options: any) { return this.createEl("span", options); };
  const root = win.document.querySelector("main")!;
  let scopesPushed = 0, scopesPopped = 0;
  let subscriptions = 0, releases = 0, opened = "", revealed = "", settings = 0, home = 0;
  const eventHost = { on: () => { subscriptions++; return {}; }, offref: () => { releases++; } };
  const files = new Map<string, any>();
  const folders = new Map(["Sources", "Wiki", "OtherWiki", "Projects"].map(path => [path, Object.assign(new TFolder(), { path })]));
  for (let index = 0; index < 25; index++) { const path = `Wiki/note-${index}.md`; files.set(path, Object.assign(new TFile(), { path })); }
  const explorer = { view: { revealInFolder: async (folder: any) => { revealed = folder.path; } } };
  const app: any = { vault: { ...eventHost, getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) }, metadataCache: { ...eventHost }, workspace: { getLeavesOfType: () => [explorer], revealLeaf: async () => {}, getLeaf: () => ({ openFile: async (file: any) => { opened = file.path; } }) }, scope: {}, keymap: { pushScope() { scopesPushed++; }, popScope() { scopesPopped++; } } };
  const prefills: Array<[string, string]> = [];
  const plugin: any = { app, settings: { settingsLanguage: "zh-CN", knowledgeBase: {}, agentRegistry: { agents: [{ id: "general-assistant", name: "总助" }, { id: "keeper", name: "整理员" }], moduleOwners: { "knowledge-base": "keeper" } } },
    getKnowledgeSurfaceService: () => null, activateHomeView: async () => { home++; }, openEchoInkKnowledgeSettings: async () => { settings++; }, openAgentTaskList: async (id: string, text: string) => { prefills.push([id, text]); return true; } };
  const snapshot: any = { generatedAt: Date.now(), bindings: {}, dashboard: null, health: { assessment: "uninitialized", score: 0 }, weekly: { added: 2, organized: 1, unknownCreatedAtCount: 0 },
    activityDays: [{ date: "2026-10-18", added: 2, organized: 1, total: 3 }],
    directories: [
      { role: "raw", state: "ready", count: 3, unit: "份", latestMtime: 1, roots: [{ path: "Sources", state: "ready", count: 3 }] },
      { role: "wiki", state: "ready", count: 25, unit: "篇", latestMtime: 1, roots: [{ path: "Wiki", state: "ready", count: 20 }, { path: "OtherWiki", state: "ready", count: 5 }] },
      { role: "projects", state: "ready", count: 1, unit: "个", latestMtime: 1, roots: [{ path: "Projects", state: "ready", count: 1 }] },
      { role: "inbox", state: "unbound", count: null, unit: "条", latestMtime: 0, roots: [] }
    ], links: { state: "ready", isolatedPaths: [...files.keys()], candidatePaths: [...files.keys()] }, sources: { state: "ready", missing: [{ path: "Wiki/note-0.md", sourcePaths: ["Sources/missing.md"] }], unknownCount: 0 }, maintenanceHistory: [], maintenanceRecords: [], errors: {} };
  let next: any = snapshot;
  (globalThis as any).__p8Load = async () => next;
  (globalThis as any).__p8Workbench = { subscribe: () => { subscriptions++; return () => { releases++; }; }, loadKnowledgeLinkHealth: async () => snapshot.links };
  const view: any = new KnowledgePageView({} as any, plugin);
  Object.assign(view, { app, contentEl: root, containerEl: root, closed: false });
  view.renderShell(); await view.refresh();
  assert.equal(view.getViewType(), KNOWLEDGE_PAGE_VIEW_TYPE);
  assert.equal(root.querySelectorAll(".knowledge-metric").length, 3);
  assert.equal(root.querySelector(".knowledge-metric-number strong")!.textContent, "—", "Uninitialized health never displays a fake zero");
  assert.equal(root.querySelectorAll(".knowledge-directory-row").length, 4);
  assert.equal(root.querySelectorAll(".echoink-activity-heatmap").length, 1);
  assert.ok(root.querySelector('[data-date="2026-10-18"]')!.getAttribute("aria-label")!.includes("新增2篇 · 整理1次"));
  const single = root.querySelector(".knowledge-directory-row") as HTMLButtonElement; single.click(); await tick(); assert.equal(revealed, "Sources");
  (root.querySelectorAll(".knowledge-directory-row")[1] as HTMLButtonElement).click(); await tick(); assert.equal(root.querySelectorAll(".knowledge-root-row").length, 2); assert.equal(revealed, "Sources");
  (root.querySelectorAll(".knowledge-root-row")[1] as HTMLButtonElement).click(); await tick(); assert.equal(revealed, "OtherWiki");
  (root.querySelectorAll(".knowledge-directory-row")[3] as HTMLButtonElement).click(); await tick(); assert.equal(settings, 1);
  const range = root.querySelector(".activity-range-trigger") as HTMLButtonElement; range.click();
  const draft = root.querySelector(".activity-range-start") as HTMLInputElement; draft.value = "2020"; draft.focus();
  next = { ...snapshot, activityDays: [{ date: "2026-10-18", added: 3, organized: 1, total: 4 }] };
  await view.refresh(); assert.equal(root.querySelector(".activity-range-start"), draft); assert.equal(draft.value, "2020", "Refresh preserves an unapplied range");
  view.issue = "isolated"; view.renderSecondary(); assert.equal(view.field("secondary").classList.contains("echoink-settings-demo"), false); assert.equal(scopesPushed, 1); assert.equal(scopesPopped, 1, "Hidden overview releases the editor keyboard scope"); assert.equal(root.querySelectorAll(".knowledge-object-row").length, 20);
  view.issuePage = 2; view.renderSecondary(); assert.equal(root.querySelectorAll(".knowledge-object-row").length, 5);
  (root.querySelector(".knowledge-object-row button") as HTMLButtonElement).click(); await tick(); assert.equal(opened, "Wiki/note-20.md");
  view.openPage("overview"); assert.equal(scopesPushed, 2, "Returning restores the open editor scope"); assert.equal(root.querySelector(".activity-range-start"), draft); assert.equal(draft.value, "2020");
  draft.blur(); (root.querySelector(".activity-range-cancel") as HTMLButtonElement).click(); await tick();
  plugin.settings.agentRegistry.moduleOwners["knowledge-base"] = "general-assistant";
  await view.handoffIssue("sources"); assert.equal(prefills[0][0], "general-assistant"); assert.ok(prefills[0][1].includes("Sources/missing.md")); assert.ok(prefills[0][1].includes("Wiki/note-0.md"));
  next = { ...snapshot, links: { state: "ready", candidatePaths: [], isolatedPaths: [] } };
  await view.handoffIssue("isolated"); assert.equal(prefills.length, 1, "Resolved issues cannot hand off a stale object range");
  next = { ...snapshot, links: { state: "unknown", candidatePaths: [], isolatedPaths: [] }, sources: { state: "unknown", missing: [], unknownCount: 25 } };
  await view.refresh(); assert.ok(view.field("issues").textContent.includes("链接还在解析")); assert.equal(view.field("issues").textContent.includes("暂时没有可处理"), false);
  await assert.rejects(view.handoffIssue("isolated")); assert.equal(prefills.length, 1);
  next = snapshot; await view.refresh(); view.contentEl.scrollTop = 135; view.openPage("history"); assert.equal(view.field("secondary").classList.contains("echoink-settings-demo"), true); view.openPage("health"); assert.equal(view.field("secondary").classList.contains("knowledge-legacy"), true); view.openPage("overview"); assert.equal(view.contentEl.scrollTop, 135);
  let finish!: (value: any) => void;
  (globalThis as any).__p8Load = () => new Promise(resolve => { finish = resolve; });
  const stale = view.refresh();
  (globalThis as any).__p8Load = async () => ({ ...snapshot, weekly: { ...snapshot.weekly, added: 9 } }); await view.refresh();
  finish(snapshot); await stale; assert.equal(view.snapshot.weekly.added, 9, "Late responses cannot overwrite new data");
  view.subscribe(); assert.equal(subscriptions, 7); view.unsubscribe(); assert.equal(releases, 7);
  view.foreground = { isActive: () => false, dispose() {} };
  let loads = 0; (globalThis as any).__p8Load = async () => { loads++; return snapshot; }; await view.refresh(); assert.equal(loads, 0, "Hidden pages do not scan");
  await view.onClose(); dom.window.close();
  assert.equal(home, 0); console.log("Knowledge page UI tests passed: six groups, unknown state, folder navigation, scope recheck, 20 rows, draft preservation, stale response and foreground cleanup.");
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
