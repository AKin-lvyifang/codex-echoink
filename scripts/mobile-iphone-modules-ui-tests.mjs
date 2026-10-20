import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import esbuild from "esbuild";
import moment from "moment";
import { parse as parseYaml } from "yaml";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

const built = await esbuild.build({ ...mobileBuildOptions("tests/mobile-modules/iphone-entry.ts"), metafile: true });
assert.equal(Object.keys(built.metafile.inputs).some(path => /(?:finance-view|todo-edit-modal|mobile-ui)\.ts$/.test(path)), false, "New iPhone modules own their DOM");
const dom = new JSDOM("<!doctype html><body><main class='echoink-iphone'></main></body>", { pretendToBeVisual: true, url: "https://iphone-modules.invalid" });
const { document, Event } = dom.window, root = document.querySelector("main");
const css = document.createElement("style"); css.textContent = await fs.readFile("src/ui/iphone/modules.css", "utf8"); document.head.append(css);
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.empty = function () { this.replaceChildren(); };
dom.window.HTMLElement.prototype.toggleClass = function (name, active) { this.classList.toggle(name, active); };
dom.window.HTMLElement.prototype.setText = function (text) { this.textContent = text; };
dom.window.HTMLElement.prototype.createEl = function (tag, options = {}) { const node = document.createElement(tag); node.className = options.cls ?? ""; node.textContent = options.text ?? ""; for (const [key, value] of Object.entries(options.attr ?? {})) node.setAttribute(key, value); this.append(node); return node; };
dom.window.HTMLElement.prototype.createDiv = function (options = {}) { return this.createEl("div", options); };
dom.window.HTMLElement.prototype.createSpan = function (options = {}) { const node = document.createElement("span"); node.className = options.cls ?? ""; node.textContent = options.text ?? ""; for (const [key, value] of Object.entries(options.attr ?? {})) node.setAttribute(key, value); this.append(node); return node; };
const icon = (parent, name) => { const node = document.createElementNS("http://www.w3.org/2000/svg", "svg"); node.dataset.icon = name; parent.replaceChildren(node); }, compiled = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module: compiled, exports: compiled.exports, document, window: dom.window, Error, console, structuredClone, AbortController, setTimeout, clearTimeout, Date, Intl, atob, btoa, TextEncoder, TextDecoder, Uint8Array,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement,
  require(name) { assert.equal(name, "obsidian"); return { moment, parseYaml, normalizePath: path => path.replaceAll("\\", "/"), setIcon: icon, getIcon: name => { const parent = document.createElement("span"); icon(parent, name); return parent.firstChild; }, sanitizeHTMLToDom: html => { const template = document.createElement("template"); template.innerHTML = html; return template.content; } }; }
});
const ui = compiled.exports, clone = structuredClone, tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const today = moment().format("YYYY-MM-DD"), month = today.slice(0, 7), yesterday = moment().subtract(1, "day").format("YYYY-MM-DD");
const settings = { settingsLanguage: "zh-CN", lifestyle: clone(ui.DEFAULT_LIFESTYLE_SETTINGS), homeModules: { finance: true }, mobileUi: {} };
settings.lifestyle.finance.enabled = true; settings.lifestyle.finance.categories = [{ name: "餐饮", active: true, color: "#00a000", icon: "utensils" }];
settings.lifestyle.finance.accounts = [{ name: "现金", active: true, aliases: [] }]; settings.lifestyle.finance.merchants = [{ name: "饭店", active: true, aliases: [], iconId: "auto", defaultCategory: "餐饮" }];
const data = clone(ui.EMPTY_LIFESTYLE_DATA); data.financeDefaultBudget = { totalCents: 100000, allocations: { 餐饮: 40000 } };
data.financePlans = [{ month, dailyLimitCents: 5000, goals: [{ id: "old-goal", name: "旧目标", mode: "manual", target: 10, actual: 3, unit: "次" }] }];
data.financeBillPlans = [{ id: "trip", name: "旅行", budgetCents: 200000, allocations: { 餐饮: 50000 } }];
data.financeGoals = [{ id: "goal", name: "餐饮目标", metric: "expense", period: "month", target: 50000, category: "餐饮" }];
data.financeAnalysisArchives = [{ id: "archive", period: month, createdAt: Date.now(), status: "success", path: "Reports/actual.md" }];
const entry = { id: "entry-1", kind: "expense", amountCents: 3200, merchant: "饭店", category: "餐饮", account: "现金", date: today, description: "晚饭", note: "原备注", status: "completed", currency: "CNY", source: "manual", icon: "auto", billPlanId: "trip" };
let entries = [clone(entry), { ...clone(entry), id: "entry-2", billPlanId: undefined, merchant: "午饭", amountCents: 2000 }], journalAvailable = true, todoConflict = true, entryConflict = true, importPaused = false, analysisResolve;
const records = [{ path: `Journal/${yesterday}.md`, basename: yesterday, mtime: 1, ctime: 1, firstImageUrl: "https://invalid.test/bad.png" }];
const todos = ui.parseTodoMarkdown(`- [ ] 写报告 <!-- echoink-todo-id: todo-1 -->\n  - 项目：Missing Project\n  - 相关人员：张三\n  - 截止日期：${today}\n  - 分类：工作\n- [x] 已完成报告 <!-- echoink-todo-id: todo-2 -->`).records;
let todoVersion = "v1", entryVersion = "e1", rights = { canEnter: true, canWrite: true, reason: "" }, pendingReport = false;
const listeners = { journal: new Set(), todos: new Set(), finance: new Set(), entries: new Set(), account: new Set() }, calls = { create: [], template: [], todo: [], toggle: [], categories: [], manual: [], patch: [], import: [], budget: [], plans: [], goal: [], options: [], catalog: [], csv: [], open: [], handoff: [], navigate: [], cancel: [], analyze: [], submit: 0 };
const subscribe = key => listener => { listeners[key].add(listener); return () => listeners[key].delete(listener); };
const emit = key => { for (const listener of listeners[key]) listener(); };
const journal = {
  async read() { return { settings: { available: journalAvailable, folder: "Journal", format: "YYYY-MM-DD" }, records: clone(records), stats: ui.journalStats(records, "Journal", "YYYY-MM-DD"), templates: [] }; },
  readSummary: async () => "真实日记摘要", subscribe: subscribe("journal"), openSettings() { calls.open.push("native-daily-settings"); },
  async readTemplate(choice) { return choice.kind === "built-in" ? choice.template.content : "# imported template"; }, previewImportedTemplate: ui.parseImportedJournalTemplate,
  async saveImportedTemplate(template, resolution) { calls.template.push({ template: clone(template), resolution }); return resolution ? { status: "saved", path: "Templates/duplicate copy.md", file: { basename: "duplicate copy" } } : { status: "conflict", path: "Templates/duplicate.md", safeCopyPath: "Templates/duplicate copy.md" }; },
  async create(date, choice) { calls.create.push({ date, choice: clone(choice) }); return { path: `Journal/${moment(date).format("YYYY-MM-DD")}.md`, created: true }; }
};
const todoApi = {
  async read() { return { records: clone(todos), sourcePath: "Todos.md", exists: true, contentVersion: todoVersion, warnings: [], projects: [], categories: [{ name: "工作" }], completion: { total: 17, today: 2 } }; }, subscribe: subscribe("todos"),
  async toggle(record, done, version) { calls.toggle.push({ record, done, version }); if (todoConflict) throw new Error("源文件已改变"); todos.find(item => item.id === record.id).done = done; todoVersion = "v2"; },
  async add(draft, version) { calls.todo.push({ draft: clone(draft), version }); if (todoConflict) throw new Error("源文件已改变"); },
  async update(record, patch, version) { calls.todo.push({ record, patch: clone(patch), version }); if (todoConflict) throw new Error("源文件已改变"); },
  async remove(record, version) { calls.todo.push({ remove: record.id, version }); },
  async addCategory(name) { calls.categories.push({ add: name }); }, async renameCategory(oldName, name, version) { calls.categories.push({ oldName, name, version }); }
};
const finance = {
  accessState: () => rights, entries: () => clone(entries), subscribe: subscribe("finance"), subscribeEntries: subscribe("entries"),
  goals: () => clone(data.financeGoals), billPlans: () => clone(data.financeBillPlans), monthlyPlan: () => clone(data.financePlans[0]), billPlanStats: id => ui.financeBillPlanStats(data.financeBillPlans.find(plan => plan.id === id), entries),
  async readForConversation() { return { records: entries.map(entry => ({ entry: clone(entry), version: entryVersion })) }; },
  async addManual(value) { calls.manual.push(clone(value)); if (!rights.canWrite) throw new Error("无写入权限"); },
  async patchConversationRecord(id, version, patch) { calls.patch.push({ id, version, patch: clone(patch) }); if (entryConflict) throw new Error("账本已改变"); Object.assign(entries.find(entry => entry.id === id), patch); },
  async openBase(id) { calls.open.push(id ?? "ledger"); },
  previewImport: rows => ({ added: rows.filter(row => row.entry).slice(0, 1), updated: [], duplicates: 1, invalid: 0 }),
  async confirmImport(rows, options) { calls.import.push("confirm"); options.onSaved(entry); if (importPaused) await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true })); return { created: [entry], added: 1, updated: 0, duplicates: 1, invalid: 0 }; },
  async prepareImport() { calls.import.push("prepare"); return { rows: [], warnings: [] }; }, async applyImportSuggestions() { calls.import.push("suggestions"); return {}; }, async finalizeImportedAccounts(ids) { calls.import.push(`finalize:${ids.size}`); }, async completeImport(_result, options) { calls.import.push(options.signal.aborted ? "complete:aborted" : "complete"); },
  async saveBudgetChanges(value) { calls.budget.push(clone(value)); ui.applyFinanceBudgetChanges(data, value); }, async saveBillPlan(value) { calls.plans.push(clone(value)); }, async saveDailyLimit(_month, value) { calls.plans.push({ dailyLimit: value }); },
  async saveContinuousGoal(value, legacy) { calls.goal.push({ value: clone(value), legacy }); }, async deleteContinuousGoal(id) { calls.goal.push({ delete: id }); },
  async associateBillPlan(ids, planId) { calls.plans.push({ ids, planId }); return { applied: ids, failed: [] }; },
  exportCsv(values) { calls.csv.push(clone(values)); return "merchant,amount\n"; },
  latestReport() { return pendingReport ? { createdAt: Date.now(), provider: "fixture", text: "真实分析结果" } : undefined; }, pendingAnalysisSave: () => pendingReport,
  async analyze(period, force) { calls.analyze.push({ period, force }); await new Promise(resolve => { analysisResolve = resolve; }); }, cancel(period) { calls.cancel.push(period); pendingReport = true; analysisResolve?.(); }, async retryAnalysisSave() { pendingReport = false; },
  async saveOption(key, value) { calls.options.push({ key, value }); if (key === "showOnHome") settings.homeModules.finance = value; else settings.lifestyle.finance[key] = value; },
  async saveAnalysisDirectory(path) { settings.lifestyle.finance.analysisDirectory = path; }, async saveCatalog(kind, value) { calls.catalog.push({ kind, value: clone(value) }); settings.lifestyle.finance[kind] = clone(value); }
};
const modulePort = { journal, todos: todoApi, finance: { service: finance, readData: async () => clone(data), readBill: async () => [{ entry: clone(entry) }, { entry: clone(entry) }], saveCsv: async name => `Exports/${name}` }, owner: () => ({ id: "owner", name: "小助", avatar: { kind: "default" } }),
  async handoff(module, prompt, replaceDraft) { calls.handoff.push({ module, prompt, replaceDraft }); return { agentId: "owner", conflict: !replaceDraft }; }
};
const pages = [{ id: "base", content: document.createElement("div"), panel: document.createElement("div") }]; root.append(pages[0].panel);
const shell = {
  hasPage: id => pages.some(page => page.id === id), get activePageId() { return pages.at(-1).id; },
  async push(page) { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; pages.at(-1).panel.hidden = true; page.panel = document.createElement("article"); if (page.actions) page.panel.append(page.actions); page.panel.append(page.content); if (page.footer) page.panel.append(page.footer); pages.push(page); root.append(page.panel); return true; },
  async back() { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; const page = pages.pop(); page.dispose?.(); page.panel.remove(); pages.at(-1).panel.hidden = false; return true; },
  async backTo(id) { while (pages.at(-1).id !== id) if (!await this.back()) return false; return true; }
};
const ctx = { document, shell, host: { services: { modules: modulePort, lifestyle: { async setEnabled(_kind, value) { settings.lifestyle.finance.enabled = value; } } }, settings: () => settings, saveSettings: async () => {}, accountService: { subscribe: subscribe("account"), checkCapability: () => true }, openNote: async path => { calls.open.push(path); }, renderMarkdown: (text, parent) => { parent.textContent = text; }, runtime: { submit() { calls.submit++; } } }, navigate: async route => { calls.navigate.push(route); }, error: error => { throw error; } };
const body = () => pages.at(-1).panel, button = label => [...body().querySelectorAll("button")].find(node => node.textContent.trim() === label), click = async label => { const target = button(label); assert.ok(target, `Button exists: ${label}`); assert.equal(target.disabled, false, `Button enabled: ${label}`); target.click(); await tick(); }, input = (label, value, event = "input") => { const node = body().querySelector(`[aria-label="${label}"]`); assert.ok(node, `Field exists: ${label}`); node.value = value; node.dispatchEvent(new Event(event, { bubbles: true })); return node; }, select = (label, value) => input(label, value, "change");
const chooseFile = async (label, file) => { const node = body().querySelector(`[aria-label="${label}"]`); assert.ok(node); Object.defineProperty(node, "files", { configurable: true, value: [file] }); node.dispatchEvent(new Event("change", { bubbles: true })); await tick(); };
try {
  await ui.openIPhoneJournal(ctx); assert.equal(body().querySelectorAll(".ip-module-stat").length, 2); assert.equal(body().querySelectorAll("[class*='heatmap']").length, 0);
  body().querySelector(`.ip-journal-days [data-date="${today}"]`).click(); await tick(); assert.equal(calls.create.length, 0);
  const bad = body().querySelector(".echoink-calendar-photo"); if (bad) { bad.dispatchEvent(new Event("error")); assert.equal(bad.isConnected, false); }
  const originalRecords = clone(records);
  records.splice(0, records.length, ...Array.from({ length: moment().daysInMonth() }, (_, index) => moment().date(index + 1).format("YYYY-MM-DD")).filter(date => date !== today).map(date => ({ path: `Journal/${date}.md`, basename: date, mtime: 1, ctime: 1 })));
  emit("journal"); await tick();
  body().querySelector(`.ip-journal-days [data-date="${month}-01"]`).click(); await tick();
  assert.ok(body().querySelector(`[data-journal-date="${month}-01"]`), "Selecting a date locates its record beyond page one"); assert.equal(calls.create.length, 0);
  records.splice(0, records.length, ...originalRecords); emit("journal"); await tick(); body().querySelector(`.ip-journal-days [data-date="${today}"]`).click(); await tick();
  await click("按年"); assert.equal(body().querySelector('[aria-label="年份"]'), null); const monthRow = body().querySelector('.ip-journal-list .ip-module-navigation-row'); assert.match(monthRow.querySelector('.ip-grow').textContent, /\d{4} 年 \d{1,2} 月/u); assert.match(monthRow.querySelector('.ip-sub').textContent, /\d+ 篇/u); monthRow.click(); await tick(); assert.equal(button("按月").getAttribute("aria-pressed"), "true"); body().querySelector(`.ip-journal-days [data-date="${today}"]`).click(); await tick();
  await click("写这天日记"); assert.match(body().textContent, /模板预览/); await click("导入 Markdown 模板");
  await chooseFile("选择 Markdown 文件", { name: "duplicate.md", text: async () => "# 我的模板\n\n今天" }); assert.match(body().textContent, /我的模板/); await click("保存模板"); assert.equal(calls.template.length, 1); assert.match(body().textContent, /同名模板/); assert.equal(calls.create.length, 0);
  await click("保存安全副本"); assert.equal(calls.template[1].resolution, "safe-copy"); assert.equal(shell.activePageId, `iphone-journal-create-${today}`); await click("创建日记"); assert.equal(calls.create.length, 1); assert.equal(calls.create[0].choice.path, "Templates/duplicate copy.md");
  await click("和小助聊今天"); assert.equal(calls.handoff.length, 1); assert.equal(calls.navigate.length, 0); await click("替换草稿"); assert.equal(calls.handoff[1].replaceDraft, true); assert.equal(calls.navigate[0].kind, "agent"); assert.equal(calls.submit, 0); await shell.back();
  journalAvailable = false; await ui.openIPhoneJournal(ctx); await click("设置日记位置"); assert.ok(calls.open.includes("native-daily-settings")); await shell.back(); journalAvailable = true;
  await ui.openIPhoneTodos(ctx); assert.match(body().textContent, /累计完成 17 · 今日完成 2/); const todoCount = body().querySelector(".ip-todo-count"); assert.equal(dom.window.getComputedStyle(todoCount).flexDirection, "row"); assert.equal(dom.window.getComputedStyle(todoCount).flexWrap, "wrap"); assert.equal(todoCount.lastChild.textContent, "累计完成 17 · 今日完成 2"); assert.equal(dom.window.getComputedStyle(todoCount.lastChild).whiteSpace, "nowrap"); assert.equal(body().querySelectorAll(".ip-todo-row").length, 1); body().querySelector('[role="checkbox"]').click(); await tick(); assert.equal(body().querySelector('[role="checkbox"]').getAttribute("aria-checked"), "false"); assert.match(body().textContent, /源文件已改变/);
  await click("已完成"); assert.equal(body().querySelectorAll(".ip-todo-row").length, 1); assert.match(body().textContent, /已完成报告/); await click("未完成"); body().querySelector(".ip-todo-main").click(); await tick();
  assert.equal(body().querySelector('[aria-label="项目"]').value, "Missing Project"); assert.match(body().textContent, /截止时间会保存，此设备不会发送系统提醒。/); input("事项", "保留的草稿"); await click("保存"); assert.equal(body().querySelector('[aria-label="事项"]').value, "保留的草稿"); assert.equal(calls.todo.at(-1).version, "v1"); assert.deepEqual(Object.keys(calls.todo.at(-1).patch), ["title"]);
  todoConflict = false; todoVersion = "v3"; await click("重新读取"); await click("保存"); assert.equal(calls.todo.at(-1).version, "v3");
  await click("新增待办"); input("事项", "新待办"); input("相关人员（选填）", "李四，王五").dispatchEvent(new Event("blur")); input("截止日期（选填）", today); input("截止时间（选填，默认 09:00）", "11:30"); await click("新建分类"); input("新分类名称", "新分类"); await click("选用分类"); assert.equal(calls.categories.length, 0); await click("保存"); assert.equal(calls.todo.at(-1).draft.people, "李四、王五"); assert.equal(calls.todo.at(-1).draft.categoryName, "新分类");
  await ui.openIPhoneTodoSettings(ctx); await click("工作"); input("分类名称", "重点工作"); await click("保存"); assert.deepEqual(calls.categories.at(-1), { oldName: "工作", name: "重点工作", version: "v3" }); await shell.back(); await shell.back();
  await ui.openIPhoneFinance(ctx); assert.equal(body().querySelector('[aria-label="财务页面"]').querySelectorAll(".ip-module-segment").length, 3); assert.equal(body().querySelector(".echoink-finance-donut-svg"), null); assert.equal(button("财务设置"), undefined); assert.ok(body().querySelector(".ip-finance-recent")); await click("明细"); await click("消费统计"); assert.ok(body().querySelector(".echoink-finance-donut-svg")); assert.match(body().textContent, /账户分布|单笔金额分布/); const calendarDay = body().querySelector(`.ip-finance-day[data-date="${today}"]`); assert.equal(calendarDay.disabled, false); calendarDay.click(); await tick(); assert.equal(body().querySelector('[aria-label="日期"]').value, today); await click("清除筛选"); select("交易类型", "income"); assert.equal(body().querySelectorAll(".ip-finance-entry-row").length, 0); select("交易类型", "all"); await click("CSV 导出"); assert.equal(calls.csv.at(-1).length, 2);
  body().querySelector(".ip-finance-entry-row").click(); await tick(); input("商户 / 对方", "修改保留"); await click("保存"); assert.equal(body().querySelector('[aria-label="商户 / 对方"]').value, "修改保留"); assert.equal(calls.patch.at(-1).version, "e1"); entryConflict = false; entryVersion = "e2"; await click("重新读取"); await click("保存"); assert.equal(calls.patch.at(-1).version, "e2");
  await click("记一笔"); input("金额 · 元", "12.34"); input("商户 / 对方", "手动商户"); await click("保存"); assert.equal(calls.manual.at(-1).amountCents, 1234);
  await click("导入账单"); await chooseFile("选择账单文件", { name: "bill.csv", arrayBuffer: async () => new ArrayBuffer(1) }); assert.match(body().textContent, /已存在 1/); await click("开始导入"); assert.deepEqual(calls.import, ["confirm", "prepare", "suggestions", "finalize:1", "complete"]); await shell.back();
  importPaused = true; await click("导入账单"); await chooseFile("选择账单文件", { name: "bill.csv", arrayBuffer: async () => new ArrayBuffer(1) }); await click("开始导入"); assert.equal(button("停止").disabled, false); await click("停止"); assert.match(body().textContent, /已停止 · 已保存 1 笔/); assert.deepEqual(calls.import.slice(-3), ["confirm", "finalize:1", "complete:aborted"]); await shell.back();
  await click("预算"); await click("调整月度预算"); input("月度总预算 · 元", "1200"); await click("按比例"); input("餐饮", "50"); await click("保存预算"); assert.equal(calls.budget.at(-1).defaultBudget.allocations.餐饮, 60000);
  await click("新增目标"); input("目标名称", "收入目标"); input("目标金额 · 元", "100"); await click("保存"); assert.equal(calls.goal.at(-1).value.target, 10000);
  const legacy = [...body().querySelectorAll("button")].find(node => node.textContent.includes("旧目标")); legacy.click(); await tick(); input("目标金额 · 元", "200"); await click("保存"); assert.equal(calls.goal.at(-1).legacy.id, "old-goal");
  await click("账单计划"); await click("旅行"); assert.ok(body().querySelector('[aria-label="起始日期"]')); await click("关联已有账目"); body().querySelector('[role="checkbox"]').click(); await tick(); await click("确认关联"); assert.equal(calls.plans.at(-1).planId, "trip"); await shell.back();
  await click("新建账单"); input("账单名称", "新账单"); input("总预算 · 元", "200"); await click("保存账单"); assert.equal(calls.plans.at(-1).budgetCents, 20000);
  await shell.back(); await click("明细"); await click("消费统计"); await click("查看分析"); await click("生成分析"); assert.equal(button("停止").disabled, false); await click("停止"); assert.match(body().textContent, /真实分析结果/); await click("重试保存"); assert.equal(pendingReport, false); await shell.back(); await click("分析记录"); await click(`${month} · 今天 ${moment().format("HH:mm")} · 已完成`); assert.ok(calls.open.includes("Reports/actual.md")); await shell.back();
  await ui.openIPhoneFinanceSettings(ctx); input("分析保存位置", "Reports/Draft"); const check = [...body().querySelectorAll("label")].find(node => node.textContent === "AI 分析").querySelector("input"); check.checked = true; check.dispatchEvent(new Event("change")); await tick(); assert.equal(body().querySelector('[aria-label="分析保存位置"]').value, "Reports/Draft"); await click("保存位置"); await click("商户管理"); await click("饭店"); input("名称", "别名商户"); input("别名（用逗号分隔）", "A，B"); await click("保存"); assert.deepEqual(calls.catalog.at(-1).value[0].aliases, ["A", "B"]); await shell.back(); await shell.back();
  await shell.back(); rights = { canEnter: true, canWrite: false, reason: "只读权益" }; emit("account"); await tick(); assert.equal(button("记一笔").disabled, true); rights = { canEnter: false, canWrite: false, reason: "无查看权限" }; emit("account"); await tick(); assert.match(body().textContent, /无查看权限/); assert.equal(body().querySelector(".ip-finance-entry-row"), null); await shell.back();
  settings.settingsLanguage = "en"; await ui.openIPhoneTodos(ctx); assert.match(body().textContent, /Total completed 17/); assert.equal(button("Add to-do") !== undefined, true); await shell.back();
  assert.equal(document.querySelector(".modal-container"), null); assert.equal(calls.submit, 0); assert.equal(Object.values(listeners).reduce((sum, set) => sum + set.size, 0), 0);
  const routeSource = await fs.readFile("src/ui/iphone/workbench.ts", "utf8"); assert.match(routeSource, /module === "journal"\) return openIPhoneJournal/); assert.match(routeSource, /page === "todos" \|\| page === "todos-settings"\) return openIPhoneTodoSettings/); assert.match(routeSource, /page === "finance-settings"\) return openIPhoneFinanceSettings/);
  console.log("PASS iPhone M11: journal selection is read-only; template preview/import/conflict-copy; handoff conflict without submit; todo filters/history/full form/CAS rollback/categories; finance overview/secondary statistics/detail CAS/manual/import duplicate and abort/budget/legacy goals/bill association/settings/analysis stop/retry/rights; independent DOM, disposal and English controls.");
} finally { for (const page of pages) page.dispose?.(); dom.window.close(); }
