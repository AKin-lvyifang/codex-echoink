import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { TFile, TFolder } from "obsidian";
import { KnowledgePageView, KNOWLEDGE_PAGE_VIEW_TYPE } from "../home/knowledge-page";
import { loadKnowledgePageData } from "../home/knowledge-page-data";
import { MAINTENANCE_ACTIVITY_STAGES, type KnowledgeActivitySnapshot, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
import type { MaintenanceUpgradePreview, MaintenanceUpgradeSnapshot } from "../knowledge-base/maintenance-upgrade-contract";

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
  assert.equal(view.field("upgrade").hidden, true, "Old hosts retain unknown upgrade state without inventing zero work");
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
  const counts = { sourceCount: 2, sourceStatusCount: 1, sourceLinkCount: 2, backlinkCount: 2, wikiCount: 3 };
  const preview: MaintenanceUpgradePreview = { id: "preview-current", createdAt: Date.now(), counts,
    automatic: [{ path: "Sources/旧资料.md", title: "旧资料", properties: ["提炼状态：已提炼", "提炼到：知识条目"] },
      { path: "Sources/归档/旧资料.md", title: "旧资料", properties: ["提炼状态：已提炼"] },
      { path: "Wiki/知识条目.md", title: "知识条目", properties: ["类型：确认后由当前模型判断"] }],
    rootAdditions: [{ role: "wiki", path: "Legacy/Wiki" }], issues: [{ title: "同名资料", message: "同名资料有两篇，暂时不补链接。", kind: "review" }, { title: "改名资料", message: "缺少旧正文，暂时无法分辨改动。", kind: "optional-reingest" }] };
  let upgrade: MaintenanceUpgradeSnapshot = { status: "scanning", counts: { sourceCount: 0, sourceStatusCount: 0, sourceLinkCount: 0, backlinkCount: 0, wikiCount: 0 } };
  let scanFails = false;
  const upgradeCalls: string[] = [];
  const service = { getDashboardSnapshot: async () => snapshot.dashboard, getMaintenanceRecords: async () => [],
    getUpgradeSnapshot: async () => { if (scanFails) throw new Error("旧目录暂时读不到"); return upgrade; },
    previewUpgrade: async () => { upgradeCalls.push("preview"); return preview; },
    confirmUpgrade: async (id: string) => { upgradeCalls.push(`confirm:${id}`); return upgrade = { status: "running", counts, recordId: "upgrade-record", taskId: "upgrade-task", preview }; },
    stopUpgrade: async () => { upgradeCalls.push("stop"); upgrade = { ...upgrade, status: "interrupted", completed: { sources: 1, links: 2, wiki: 1 }, message: "已停止，已补好的属性会保留。" }; },
    resumeUpgrade: async () => { upgradeCalls.push("resume"); return upgrade = { ...upgrade, status: "completed", completed: { sources: 2, links: 4, wiki: 3 }, preview, message: "升级完成。" }; } };
  plugin.getKnowledgeSurfaceService = () => service;
  const dataHost: any = { app: { vault: { adapter: {} } }, settings: {}, getKnowledgeSurfaceService: () => service };
  assert.equal((await loadKnowledgePageData(dataHost, async () => snapshot.links)).upgrade?.status, "scanning");
  scanFails = true;
  const failedScan = await loadKnowledgePageData(dataHost, async () => snapshot.links);
  assert.equal(failedScan.upgrade, null); assert.equal(failedScan.errors.upgrade, "旧目录暂时读不到");
  scanFails = false;
  next = { ...snapshot, upgrade }; await view.refresh();
  assert.match(view.field("upgrade").textContent, /正在检查旧资料/u); assert.doesNotMatch(view.field("upgrade").textContent, /0 篇/u);
  scanFails = true; await view.refreshUpgrade(); assert.match(view.field("upgrade").textContent, /旧目录暂时读不到.*重试/u);
  scanFails = false; upgrade = { status: "ready", counts, preview };
  (view.field("upgrade").querySelector("button") as HTMLButtonElement).click(); await tick(); await tick();
  assert.deepEqual(upgradeCalls, ["preview"], "Retry performs another read-only preview scan");
  assert.equal(view.page, "upgrade"); assert.doesNotMatch(view.field("secondary").textContent, /旧目录暂时读不到/u);
  view.openPage("overview"); upgradeCalls.length = 0;
  assert.match(view.field("upgrade").textContent, /有 1 篇资料待补状态，2 篇资料待补链接，3 页 Wiki 待补类型/u);
  view.contentEl.scrollTop = 167;
  await view.openUpgradePreview(); assert.equal(view.field("secondary").querySelectorAll(".knowledge-upgrade-location").length, 2, "only same-title files expose their exact relative location");
  assert.equal(view.page, "upgrade"); assert.equal(view.field("secondary").classList.contains("knowledge-legacy"), false);
  assert.match(view.field("secondary").textContent, /《旧资料》.*提炼状态：已提炼.*《知识条目》.*确认后由当前模型判断/u);
  assert.match(view.field("secondary").textContent, /将登记的旧目录.*Legacy\/Wiki.*可选：重新提炼/u);
  assert.doesNotMatch(view.field("secondary").textContent, /readPaths|revision|preview-current/u);
  assert.equal(root.querySelectorAll('[data-knowledge="secondary"] .is-primary').length, 1);
  assert.equal(root.querySelector(".knowledge-upgrade-actions")?.lastElementChild?.textContent, "确认升级");
  const list = root.querySelector<HTMLElement>(".knowledge-upgrade-list")!; list.scrollTop = 93;
  (root.querySelector('[data-upgrade-action="cancel"]') as HTMLButtonElement).click(); await tick();
  assert.deepEqual(upgradeCalls, ["preview"]); assert.equal(view.contentEl.scrollTop, 167);
  await view.openUpgradePreview(); assert.equal(root.querySelector<HTMLElement>(".knowledge-upgrade-list")?.scrollTop, 93);
  const upgradeActivity: MaintenanceActivity = { kind: "maintenance", taskKind: "upgrade", id: "upgrade-record", originConversationId: "upgrade-task", status: "running", stage: "write", sourceCount: 2, sourcePaths: [], batch: { index: 1, total: 1 }, activeElapsedMs: 0, etaMs: null, updatedAt: Date.now(), failures: [],
    upgradeCounts: { sourceTotal: 2, sourceCompleted: 1, linkTotal: 4, linksCompleted: 2, wikiTotal: 3, wikiCompleted: 1 },
    steps: MAINTENANCE_ACTIVITY_STAGES.map(stage => ({ stage, completed: 0, total: null, state: "pending" })) };
  let activitySnapshot: KnowledgeActivitySnapshot = { primary: upgradeActivity, other: null, maintenance: [upgradeActivity] };
  const activityListeners = new Set<(snapshot: KnowledgeActivitySnapshot) => void>();
  plugin.getKnowledgeActivitySource = () => ({ ready: Promise.resolve(), snapshot: () => activitySnapshot, subscribe: (listener: (snapshot: KnowledgeActivitySnapshot) => void) => { activityListeners.add(listener); return () => activityListeners.delete(listener); } });
  await view.upgradeAction("confirm"); assert.equal(upgradeCalls.at(-1), "confirm:preview-current");
  assert.equal(root.querySelectorAll(".knowledge-upgrade-progress .echoink-maintenance-progress-bar").length, 1);
  assert.equal(root.querySelector('[data-upgrade-action="stop"]')?.textContent, "停止");
  await view.upgradeAction("stop"); assert.match(view.field("secondary").textContent, /已补 1 篇资料状态 · 2 条链接 · 1 页 Wiki 类型/u);
  assert.equal(root.querySelector('[data-upgrade-action="resume"]')?.textContent, "继续升级");
  const upgradeReason = "《旧资料》已有同名属性，原值保留，请核对后继续。";
  upgrade = { ...upgrade, preview: { ...preview, issues: [...preview.issues, { title: "失败页", message: "类型判断未完成。", kind: "review", executionFailure: true }] } }; view.snapshot.upgrade = upgrade;
  const interruptedActivity = { ...upgradeActivity, status: "interrupted" as const, failures: [{ key: "upgrade:review", message: upgradeReason, at: Date.now() }] };
  activitySnapshot = { primary: interruptedActivity, other: null, maintenance: [interruptedActivity] }; view.renderSecondary();
  assert.ok(view.field("secondary").textContent.includes(upgradeReason), "Upgrade reasons keep the actual unresolved property");
  assert.match(view.field("secondary").querySelector(".knowledge-upgrade-review")!.textContent!, /同名资料.*可选：重新提炼.*缺少旧正文/u, "interrupted tasks retain the original review list");
  assert.match(view.field("secondary").querySelector(".knowledge-upgrade-review")!.textContent!, /不属于补写失败/u);
  assert.doesNotMatch(view.field("secondary").querySelector(".knowledge-upgrade-review")!.textContent!, /失败页/u);
  assert.match(view.field("secondary").textContent, /《失败页》：类型判断未完成/u);
  activitySnapshot = { primary: null, other: null, maintenance: [] };
  await view.upgradeAction("resume"); assert.match(view.field("secondary").textContent, /已补 2 篇资料状态 · 4 条链接 · 3 页 Wiki 类型/u);
  assert.doesNotMatch(view.field("secondary").textContent, /生成.*Wiki/u);
  const completedActivity = { ...upgradeActivity, status: "completed" as const, stage: "finalize" as const,
    upgradeCounts: { sourceTotal: 2, sourceCompleted: 2, linkTotal: 4, linksCompleted: 4, wikiTotal: 3, wikiCompleted: 3 }, failures: [] };
  activitySnapshot = { primary: null, other: null, maintenance: [completedActivity] }; view.renderSecondary();
  assert.equal((view.field("secondary").textContent.match(/2 篇资料状态/gu) ?? []).length, 1, "completed counts are shown once");
  assert.match(view.field("secondary").querySelector(".knowledge-upgrade-review")!.textContent!, /同名资料.*可选：重新提炼.*缺少旧正文/u, "completed tasks retain the original review list");
  view.openPage("overview"); upgrade = { status: "ready", counts: { sourceCount: 30, sourceStatusCount: 0, sourceLinkCount: 0, backlinkCount: 0, wikiCount: 0 } };
  await view.refreshUpgrade(); assert.equal(view.field("upgrade").hidden, true, "scanned source totals never create fictitious pending work");
  upgrade = { ...upgrade, preview: { ...preview, counts: upgrade.counts, automatic: [], rootAdditions: [] } };
  await view.refreshUpgrade(); assert.match(view.field("upgrade").textContent, /有 2 项旧资料需要核对/u);
  assert.doesNotMatch(view.field("upgrade").textContent, /30|待补/u);
  assert.equal(view.field("upgrade").querySelector("button")?.textContent, "查看清单");
  next = snapshot;
  let finishOldUpgrade!: (value: any) => void;
  (globalThis as any).__p8Load = () => new Promise(resolve => { finishOldUpgrade = resolve; });
  const oldUpgradeRead = view.refresh();
  upgrade = { status: "completed", counts, completed: { sources: 2, links: 4, wiki: 3 } }; await view.refreshUpgrade();
  finishOldUpgrade({ ...snapshot, upgrade: { status: "ready", counts } }); await oldUpgradeRead;
  assert.equal(view.snapshot.upgrade.status, "completed", "An older page scan cannot overwrite newer shared upgrade progress");
  let finish!: (value: any) => void;
  (globalThis as any).__p8Load = () => new Promise(resolve => { finish = resolve; });
  const stale = view.refresh();
  (globalThis as any).__p8Load = async () => ({ ...snapshot, weekly: { ...snapshot.weekly, added: 9 } }); await view.refresh();
  finish(snapshot); await stale; assert.equal(view.snapshot.weekly.added, 9, "Late responses cannot overwrite new data");
  view.subscribe(); assert.equal(subscriptions, 7); assert.equal(activityListeners.size, 1);
  upgrade = { status: "running", counts, recordId: "upgrade-record", taskId: "upgrade-task", preview };
  activitySnapshot = { primary: upgradeActivity, other: null, maintenance: [upgradeActivity] };
  for (const listener of activityListeners) listener(activitySnapshot);
  await tick(); assert.match(view.field("upgrade").textContent, /查看升级/u);
  view.unsubscribe(); assert.equal(releases, 7); assert.equal(activityListeners.size, 0);
  const historicalUpgrade = { schemaVersion: 1, recordId: "upgrade-history", runId: "upgrade-history-run", originConversationId: "upgrade-history-task", at: Date.now(), date: "2026-10-22", summary: "升级旧知识", sources: [],
    result: { schema: "echoink.knowledge-maintenance-result.v1", status: "noop", notes: [], issues: [], assessments: [], systemPaths: [] },
    upgrade: { version: 1, phase: "completed", rootsRegistered: true, classifications: {}, skipped: {},
      plan: { version: 1, id: "history-preview", createdAt: 1, bindingRevision: 1, rootAdditions: [], issues: [], counts,
        sourceItems: [{ path: "Sources/旧资料.md", title: "旧资料", revision: "before", content: "", state: "digested", addStatus: "已提炼", addTargetPaths: ["Wiki/知识条目.md"] }],
        wikiItems: [{ path: "Wiki/知识条目.md", title: "知识条目", revision: "before", content: "" }] },
      writes: { source: { operationId: "source", path: "Sources/旧资料.md", role: "source", expectedVersion: "before", content: "after", done: true }, wiki: { operationId: "wiki", path: "Wiki/知识条目.md", role: "wiki", expectedVersion: "before", content: "after", done: true } } } };
  view.snapshot = { ...view.snapshot, maintenanceRecords: [historicalUpgrade], maintenanceHistory: [{ recordId: historicalUpgrade.recordId, runId: historicalUpgrade.runId, at: historicalUpgrade.at, date: historicalUpgrade.date, mode: "maintain", status: "success", resultStatus: "noop", reportPath: "" }] };
  view.renderRecent();
  assert.match(view.field("recent").textContent, /旧知识升级.*已完成.*已补好 1 篇资料状态、1 条链接.*1 页 Wiki/u);
  assert.doesNotMatch(view.field("recent").textContent, /无需新增|已检查/u);
  (view.field("recent").querySelector(".knowledge-recent-row") as HTMLButtonElement).click();
  assert.match(view.field("secondary").textContent, /旧知识升级详情.*已补好 1 篇资料状态、1 条链接.*1 页 Wiki/u);
  assert.doesNotMatch(view.field("secondary").textContent, /本轮没有新增或更新|本轮没有选中来源/u);
  view.foreground = { isActive: () => false, dispose() {} };
  let loads = 0; (globalThis as any).__p8Load = async () => { loads++; return snapshot; }; await view.refresh(); assert.equal(loads, 0, "Hidden pages do not scan");
  await view.onClose(); dom.window.close();
  assert.equal(home, 0); console.log("Knowledge page UI tests passed: existing navigation, unknown/error/no-work scans, preview identity, cancel without writes, directory additions, progress/stop/resume, shared events and scroll preservation.");
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
