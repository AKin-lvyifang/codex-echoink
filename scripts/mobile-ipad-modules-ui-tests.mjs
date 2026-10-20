import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { runMobileFinanceWorkspaceUiTests } from "./mobile-finance-workspace-ui-tests.mjs";

const build = await esbuild.build(mobileBuildOptions("tests/mobile-modules/ipad-entry.ts"));
const shimBuild = await esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><body><aside><textarea>right Agent draft</textarea></aside><main></main><div id='settings'></div></body>", { pretendToBeVisual: true, url: "https://ipad-modules.invalid" });
const document = dom.window.document, shim = { exports: {} }, module = { exports: {} }, notices = [], unhandled = [];
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
vm.runInNewContext(shimBuild.outputFiles[0].text, { module: shim, exports: shim.exports, window: dom.window, document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, DOMParser: dom.window.DOMParser, console });
const fixed = new Date(2026, 9, 20, 12).getTime(); class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, window: dom.window, document, Date: TestDate,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, SVGElement: dom.window.SVGElement, DOMParser: dom.window.DOMParser, MutationObserver: dom.window.MutationObserver,
  AbortController, structuredClone, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), console, atob, btoa,
  require(id) { assert.equal(id, "obsidian"); return { ...shim.exports, Notice: class { constructor(message) { notices.push(String(message)); } } }; } });
const ui = module.exports, tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const root = document.querySelector("main"), right = document.querySelector("aside textarea"), settingsRoot = document.querySelector("#settings");
const subscriptions = () => { const listeners = new Set(); return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, emit: () => [...listeners].forEach(listener => listener()), listeners }; };
const journalEvents = subscriptions(), todoEvents = subscriptions(), financeEvents = subscriptions(), accessEvents = subscriptions(), workbenchEvents = subscriptions();
const settings = ui.loadMobileSettings({ settingsLanguage: "zh-CN", journalDirectory: "Journal", lifestyle: { finance: { enabled: true, aiEnabled: true, importAiEnabled: true } } });
settings.lifestyle.finance.categories = [{ name: "餐饮", active: true, icon: "utensils", color: "#112233" }, { name: "交通", active: true, icon: "bus", color: "#334455" }];
const calls = { opened: [], created: [], importedTemplates: [], handoff: [], agents: [], todos: [], patches: [], budgets: [], goals: [], csv: [], imports: 0, apply: 0, complete: 0, cancelled: 0, savedSettings: 0 };
let journalAvailable = true, templateFailure = false, toggleFailure = false, todoFailure = false, financeWrite = true, busyAnalysis = null, pendingSave = false, analysisDeferred, importMode = "normal", importRelease, summaryDeferred = false;
const pendingSummaries = [];
const records = Array.from({ length: 23 }, (_, index) => ({ path: `Journal/2026-10-${String(index + 1).padStart(2, "0")}.md`, title: `2026-10-${String(index + 1).padStart(2, "0")}`, folder: "Journal", mtime: fixed, ...(index === 9 ? { firstImageUrl: "https://invalid.local/photo.png" } : {}) }));
const journal = {
  ...journalEvents, openSettings() { calls.opened.push("native-daily-notes-settings"); },
  async read() { return { settings: { available: journalAvailable, folder: "Journal", format: "YYYY-MM-DD" }, records: structuredClone(records), stats: ui.journalStats(records, "Journal", "YYYY-MM-DD", new TestDate()), templates: [] }; },
  async readSummary(path) { if (summaryDeferred) return new Promise(resolve => pendingSummaries.push(resolve)); return `Actual summary ${path}`; },
  async readTemplate() { if (templateFailure) throw new Error("模板不可读取"); return "# Actual template"; },
  previewImportedTemplate(name, content) { return { name: name.replace(/\.md$/u, ""), content }; },
  async saveImportedTemplate(template, resolution) { calls.importedTemplates.push({ template, resolution }); return { status: resolution === "safe-copy" ? "saved" : "conflict", path: "Templates/Imported-safe.md" }; },
  async create(date, choice) { calls.created.push({ date, choice }); return { path: "Journal/created.md", created: true }; }
};
let todoState = { sourcePath: "todos.md", exists: true, contentVersion: "todo-v1", warnings: [], categories: [{ id: "work", name: "工作" }],
  projects: ["A", "B"].map(parent => ({ path: `${parent}/Same`, name: "Same", rootPath: parent, parentPath: parent, label: `Same · ${parent}`, value: `${parent}/Same` })),
  completion: { total: 12, today: 3, unknown: 1, activity: [] }, records: Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, title: `Todo ${i}`, people: "", project: i % 2 ? "A/Same" : "B/Same", categoryName: "工作", dueDate: "2026-10-20", dueTime: "09:30", done: false, lineStart: i, lineEnd: i, extraMetaLines: [] })) };
const todos = { ...todoEvents, read: async () => structuredClone(todoState),
  async toggle(record, done, version) { calls.todos.push({ action: "toggle", version, done }); if (toggleFailure) throw new Error("完成保存失败"); todoState.records.find(item => item.id === record.id).done = done; todoEvents.emit(); },
  async add(values, version) { calls.todos.push({ action: "add", values, version }); if (todoFailure) throw new Error("todo_source_changed"); todoEvents.emit(); },
  async update(record, values, version) { calls.todos.push({ action: "update", values, version }); if (todoFailure) throw new Error("todo_source_changed"); Object.assign(todoState.records.find(item => item.id === record.id), values); todoEvents.emit(); },
  async remove(record, version) { calls.todos.push({ action: "remove", version }); todoState.records = todoState.records.filter(item => item.id !== record.id); todoEvents.emit(); },
  async addCategory(name) { todoState.categories.push({ id: name, name }); todoEvents.emit(); },
  async renameCategory(oldName, name, version) { assert.equal(version, todoState.contentVersion); todoState.categories.find(item => item.name === oldName).name = name; todoEvents.emit(); }
};
const entry = (id, patch = {}) => ({ id, source: "manual", sourceId: id, date: "2026-10-20 09:30:45", merchant: `Shop ${id}`, category: "餐饮", kind: "expense", amountCents: 2000, status: "completed", account: "Bank", description: "actual", currency: "CNY", note: "", ...patch });
let financeRecords = [{ entry: entry("one", { billPlanId: "trip" }), path: "finance/one.md", version: "f1" }, { entry: entry("two", { amountCents: 9000 }), path: "finance/two.md", version: "f2" }];
let financeData = { version: 1, financeEntries: [], budgets: [], financeDefaultBudget: { totalCents: 100000, allocations: { 餐饮: 60000, 交通: 40000 } }, financePlans: [{ month: "2026-10", dailyLimitCents: 8000, goals: [{ id: "legacy", name: "Old target", mode: "manual", target: 30, actual: 7, unit: "days" }] }], financeBillPlans: [{ id: "trip", name: "Actual Trip", budgetCents: 200000, allocations: { 餐饮: 100000 } }], financeGoals: [], reports: [], financeAnalysisArchives: [] };
const requireWrite = () => { if (!financeWrite) throw new Error("权限已失效"); };
const service = {
  ledger: { readSnapshots: async () => structuredClone(financeRecords) }, subscribeEntries: financeEvents.subscribe, subscribe: financeEvents.subscribe, access: accessEvents,
  accessState: () => ({ canWrite: financeWrite, reason: financeWrite ? "" : "权限已失效" }), issues: () => [], openBase: async () => calls.opened.push("base"),
  monthlyPlan: month => financeData.financePlans.find(item => item.month === month) ?? { month, dailyLimitCents: null, goals: [] },
  latestReport: () => ({ text: "fallback must not replace structured report", financeSnapshot: { version: 8, sections: [{ title: "Actual analysis", blocks: [{ type: "table", table: { title: "Amounts", headers: ["Value"], rows: [["22.00"]] }, explanation: "actual explanation" }] }] } }),
  pendingAnalysisSave: () => pendingSave, busyMonth: () => busyAnalysis,
  async analyze(month) { requireWrite(); busyAnalysis = month; financeEvents.emit(); await new Promise(resolve => { analysisDeferred = resolve; }); busyAnalysis = null; },
  async retryAnalysisSave() { pendingSave = false; financeEvents.emit(); }, cancel() { calls.cancelled++; busyAnalysis = null; analysisDeferred?.(); financeEvents.emit(); },
  exportCsv(entries) { requireWrite(); return entries.map(item => item.id).join(","); },
  async addManual(values) { requireWrite(); calls.patches.push(values); },
  async patchConversationRecord(id, version, patch) { requireWrite(); const record = financeRecords.find(item => item.entry.id === id); assert.equal(version, record.version); calls.patches.push({ id, version, patch }); Object.assign(record.entry, patch); record.version += "x"; financeEvents.emit(); return structuredClone(record); },
  async deleteConversationRecord(id) { requireWrite(); financeRecords = financeRecords.filter(record => record.entry.id !== id); financeEvents.emit(); },
  async patchConversationBudget(scope, version, patch) { requireWrite(); calls.budgets.push({ scope, version, patch }); financeData.financeDefaultBudget = patch; financeEvents.emit(); },
  async saveBudgetChanges() { requireWrite(); }, async saveDailyLimit(month, cents) { requireWrite(); service.monthlyPlan(month).dailyLimitCents = cents; financeEvents.emit(); },
  async saveContinuousGoal(goal, legacy) { requireWrite(); calls.goals.push({ ...goal, legacy }); financeData.financeGoals.push(goal); if (legacy) service.monthlyPlan(legacy.month).goals = service.monthlyPlan(legacy.month).goals.filter(item => item.id !== legacy.id); financeEvents.emit(); }, async deleteContinuousGoal() { requireWrite(); }, async saveGoal() { requireWrite(); }, async deleteGoal() { requireWrite(); },
  async writeConversationBill(action, id, version, patch) { requireWrite(); Object.assign(financeData.financeBillPlans.find(item => item.id === id), patch); financeEvents.emit(); },
  async saveOption(key, value) { requireWrite(); settings.lifestyle.finance[key] = value; }, async saveAnalysisDirectory(value) { requireWrite(); settings.lifestyle.finance.analysisDirectory = value; },
  async saveCatalog(kind, values) { requireWrite(); settings.lifestyle.finance[kind] = values; },
  async confirmImport(rows, { signal }) { requireWrite(); calls.imports++; if (importMode === "cancel") await new Promise(resolve => { importRelease = resolve; signal.addEventListener("abort", resolve, { once: true }); }); const result = { added: 1, updated: 0, duplicates: 1, invalid: 0, created: [{ entry: rows[0].entry, path: "import.md" }], ...(importMode === "partial" ? { writeError: "部分写入，需核对" } : {}) }; return result; },
  async prepareImport(created) { service.lastCreated = created; service.organization = { rows: [{ entry: { ...created[0].entry }, review: "", reason: "" }], warnings: [] }; return service.organization; },
  async applyImportSuggestions(created, rows) { assert.equal(created, service.lastCreated, "created identity is retained"); assert.equal(rows, service.organization.rows, "organization row identity is retained"); calls.apply++; return { applied: 1, skipped: 0 }; },
  async finalizeImportedAccounts() {}, async completeImport() { calls.complete++; return true; }
};
const finance = { service, readData: async () => structuredClone(financeData), readBill: async () => [{ entry: entry("import"), error: "", review: "", reason: "" }], saveCsv: async (name, csv) => { calls.csv.push({ name, csv }); return `exports/${name}`; } };
const host = { settings: () => settings, saveSettings: async () => { calls.savedSettings++; }, services: { modules: { journal, todos, finance, owner: () => ({ id: "owner", name: "Actual Owner", avatar: { kind: "emoji", value: "🌿" } }), async handoff(module, prompt, replaceDraft = false) { calls.handoff.push({ module, prompt, replaceDraft }); return { agentId: "owner", conflict: !replaceDraft }; } }, getTodoStore: () => ({ openSourceFile: async () => calls.opened.push("todos.md") }), subscribeIdentity: () => () => {}, usageObserver: {} },
  workbench: workbenchEvents, agents: { snapshot: async () => ({ agents: [] }) }, openNote: async path => calls.opened.push(path), openAgent: async route => calls.agents.push(route), renderMarkdown: (markdown, node) => { node.textContent = markdown; } };
const shell = new ui.IPadShell(root, { onError: error => notices.push(String(error)) }), ctx = { root, document, shell, host, error: error => notices.push(String(error)), navigate: async () => {} };
const current = () => root.querySelector('.echoink-ipad-page:not([hidden])'), buttons = scope => [...(scope ?? current()).querySelectorAll("button")].filter(node => !node.closest("[hidden]"));
const button = (label, scope) => buttons(scope).find(node => node.textContent.trim() === label || node.getAttribute("aria-label") === label);
const click = async (label, scope) => { const node = button(label, scope); assert.ok(node, `button exists: ${label}`); node.click(); await tick(); };
const fill = (label, value) => { const node = current().querySelector(`[aria-label="${label}"]`); assert.ok(node, `field exists: ${label}`); node.value = value; node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); return node; };
const upload = async (label, name, text) => { const node = current().querySelector(`[aria-label="${label}"]`); Object.defineProperty(node, "files", { configurable: true, value: [{ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer }] }); node.dispatchEvent(new dom.window.Event("change")); await tick(); };
let mounts = 0; const mount = async page => { shell.mount({ id: `fixture-${mounts++}`, title: "Fixture", content: document.createElement("div") }); shell.mount(page); await tick(); };
const collect = error => unhandled.push(error); process.on("unhandledRejection", collect);
let settingsController;
try {
  await mount(ui.createJournalPage(ctx));
  assert.equal(current().querySelectorAll('.pd-journal-heat-cell:not([aria-hidden="true"])').length, 365);
  assert.equal(current().querySelector('.pd-journal-heat-cell').dataset.date, "2026-10-19");
  assert.equal(current().querySelectorAll('.pd-journal-entry').length, 20);
  const photo = current().querySelector('.echoink-calendar-photo'); photo.dispatchEvent(new dom.window.Event("error")); assert.equal(photo.isConnected, false); assert.equal(current().querySelector('.pd-journal-days .has-photo'), null);
  current().querySelector('[data-date="2026-10-01"]').click(); await tick(); assert.equal(calls.created.length, 0); assert.equal(current().querySelector('.pd-journal-entry.is-selected').dataset.path, "Journal/2026-10-01.md");
  await click("按年"); const monthRow = current().querySelector('.pd-journal-month'); assert.equal(monthRow.querySelector('.pd-grow').textContent, "2026 年 10 月"); assert.equal(monthRow.querySelector('.pd-module-secondary').textContent, "23 篇"); monthRow.click(); await tick(); assert.equal(button("按月").getAttribute("aria-pressed"), "true");
  summaryDeferred = true; journalEvents.emit(); await tick(); const oldSummary = current().querySelector('.pd-journal-entry .pd-module-secondary'); await click("下个月"); pendingSummaries.forEach(resolve => resolve("late stale summary")); await tick(); assert.equal(oldSummary.textContent, ""); summaryDeferred = false;
  await click("写这天日记"); templateFailure = true; current().querySelector('.pd-module-body > button').click(); await tick(); assert.equal(button("使用这个模板").disabled, true); assert.match(current().textContent, /模板不可读取/); await shell.back(); templateFailure = false;
  await upload("导入模板", "Imported.md", "# Imported actual content"); assert.equal(shell.activePageId, "ipad-journal-import-template"); await click("保存模板"); assert.equal(calls.importedTemplates.length, 1); assert.equal(calls.importedTemplates[0].resolution, undefined); await click("另存副本"); assert.equal(calls.importedTemplates[1].resolution, "safe-copy"); await click("使用这个模板"); assert.equal(shell.activePageId, "module:journal"); assert.equal(calls.created.length, 1); assert.equal(calls.created[0].choice.path, "Templates/Imported-safe.md");
  await click("和Actual Owner聊今天"); assert.equal(calls.agents.length, 0); assert.equal(calls.handoff.at(-1).replaceDraft, false); await click("替换草稿"); assert.equal(calls.handoff.at(-1).replaceDraft, true); assert.equal(calls.agents.length, 1);
  journalAvailable = false; journalEvents.emit(); await tick(); assert.equal(current().querySelector('.pd-journal-heatmap'), null); await click("配置日记"); assert.ok(calls.opened.includes("native-daily-notes-settings")); journalAvailable = true;

  await mount(ui.createTodoPage(ctx)); assert.equal(current().querySelectorAll('.pd-todo-table tbody tr').length, 20); assert.match(current().textContent, /累计完成 12 · 今日完成 3/); assert.equal(current().querySelector('[class*=heat]'), null);
  await click("下一页"); assert.equal(current().querySelectorAll('.pd-todo-table tbody tr').length, 5); fill("项目", "path:A/Same"); assert.equal(current().querySelectorAll('.pd-todo-table tbody tr').length, 12); assert.match(current().textContent, /Same · A/); assert.match(current().textContent, /累计完成 12 · 今日完成 3/); fill("项目", "");
  toggleFailure = true; const check = current().querySelector('input[type="checkbox"]'); check.checked = true; check.dispatchEvent(new dom.window.Event("change")); await tick(); assert.equal(check.checked, false); assert.match(current().textContent, /完成保存失败/); toggleFailure = false;
  await click("新增待办"); assert.equal(current().querySelector('input[type="time"]').parentElement.hidden, true); fill("事项", "Retained task"); fill("相关人员", "Actual person"); fill("截止日期", "2026-10-21"); assert.equal(current().querySelector('input[type="time"]').parentElement.hidden, false); fill("截止时间", "18:00"); fill("截止日期", ""); assert.equal(current().querySelector('input[type="time"]').value, ""); assert.equal(current().querySelector('input[type="time"]').disabled, true); fill("截止日期", "2026-10-21"); fill("截止时间", "18:00"); assert.match(current().textContent, /此设备不会发送系统提醒/); todoFailure = true; await click("保存"); assert.equal(shell.activePageId, "ipad-todo-form-new"); assert.equal(current().querySelector('[aria-label="事项"]').value, "Retained task"); assert.match(current().textContent, /内容已变化/); todoFailure = false; await click("保存"); assert.equal(shell.activePageId, "module:todos"); assert.equal(calls.todos.at(-1).version, "todo-v1");
  await shell.push(ui.createTodoSettings(ctx)); await tick(); await click("新增分类"); fill("分类名称", "Personal"); await click("保存"); assert.ok(button("Personal")); await click("Personal"); fill("分类名称", "Renamed"); await click("保存"); assert.ok(button("Renamed")); await shell.back();
  await click("Todo 0"); fill("事项", "Unsaved detail"); await click("删除"); assert.equal(calls.todos.filter(item => item.action === "remove").length, 0); await click("删除", current().querySelector('.pd-module-confirm-area')); assert.equal(shell.activePageId, "module:todos"); assert.equal(todoState.completion.total, 12);

  // Formal finance UI uses the original workspace; the dedicated entry suite owns
  // its four tabs, motion, dialogs, permissions and retained settings coverage.
  await runMobileFinanceWorkspaceUiTests("ipad");

  await mount(ui.createFinanceImportPage(ctx)); await upload("选择账单文件", "actual.csv", "fixture"); await click("确认导入"); assert.match(current().textContent, /重复 1/); fill("商户", "Reviewed Merchant"); await click("应用整理并完成"); assert.equal(calls.apply, 1); assert.equal(calls.complete, 1); assert.match(current().textContent, /导入完成/);
  importMode = "cancel"; await mount(ui.createFinanceImportPage(ctx)); await upload("选择账单文件", "cancel.csv", "fixture"); await click("确认导入"); assert.equal(button("停止导入").hidden, false); await click("停止导入"); importRelease?.(); await tick(); assert.match(current().textContent, /导入已取消/); const cancelledCount = calls.imports; await tick(); assert.equal(calls.imports, cancelledCount, "cancelled import is not replayed");
  importMode = "partial"; await mount(ui.createFinanceImportPage(ctx)); await upload("选择账单文件", "partial.csv", "fixture"); await click("确认导入"); assert.match(current().textContent, /部分写入/); assert.equal(button("确认导入"), undefined); assert.equal(calls.apply, 1);

  settingsController = new ui.IPadSettings(settingsRoot, host); await settingsController.mount("mods"); await tick(); const scope = () => settingsRoot.querySelector('.echoink-ipad-page:not([hidden])'); await click("待办", scope()); assert.equal(settingsController.shell.activePageId, "ipad-todo-settings"); await click("新增分类", scope()); fillForSettings("Settings category"); await click("保存", scope()); assert.equal(settingsController.shell.activePageId, "ipad-todo-settings"); await settingsController.shell.back(); assert.equal(button("财务", scope()), undefined, "module settings has no finance details route"); assert.match(scope().textContent, /启用财务/); assert.equal(root.querySelectorAll('.echoink-ipad-page').length, 1, "settings operations do not replace the Home stack");
  assert.equal(document.querySelector("aside textarea"), right); assert.equal(right.value, "right Agent draft"); assert.equal(notices.length, 0, notices.join("\n")); assert.equal(unhandled.length, 0, unhandled.map(String).join("\n"));
  console.log("PASS iPad module UI: journal/calendar/templates, to-do history/conflicts/categories, formal finance workspace entry plus legacy import/cancel, module toggle without finance details, settings-owned children and right-pane preservation");
} finally { settingsController?.dispose(); shell.dispose(); process.off("unhandledRejection", collect); dom.window.close(); }
function fillForSettings(value) { const input = settingsRoot.querySelector('.echoink-ipad-page:not([hidden]) [aria-label="分类名称"]'); input.value = value; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }
