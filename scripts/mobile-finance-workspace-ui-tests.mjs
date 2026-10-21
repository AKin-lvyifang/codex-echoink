import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

// DOM/animation host mirrors finance-ui-tests.mjs; only the entry and shell are mobile.
export async function runMobileFinanceWorkspaceUiTests(device) {
  assert.ok(["iphone", "ipad"].includes(device));
  const [build, shimBuild] = await Promise.all([
    esbuild.build({ ...mobileBuildOptions(`tests/mobile-modules/${device}-entry.ts`), metafile: true }),
    esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" })
  ]);
  assert.ok(Object.keys(build.metafile.inputs).includes("src/lifestyle/finance-view.ts"), "the official workspace is in the formal mobile entry");
  assert.ok(Object.keys(build.metafile.inputs).some(path => path.includes("node_modules/number-flow/")), "the official NumberFlow module is retained");
  const dom = new JSDOM("<!doctype html><body class='is-mobile'><aside><textarea>Agent draft retained</textarea></aside><main></main></body>", { pretendToBeVisual: true, url: `https://${device}-finance.invalid` });
  const win = dom.window, document = win.document, root = document.querySelector("main"), draft = document.querySelector("textarea"), observed = new Map(), resizeObservers = new Set(), mediaListeners = new Set(), frames = new Map(), animations = new Set(), notices = [], errors = [];
  win.addEventListener("error", event => { errors.push(event.error); event.preventDefault(); });
  const fixed = new Date(2026, 9, 20, 12).getTime(); class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }
  win.matchMedia = () => ({ matches: false, addEventListener(_, listener) { mediaListeners.add(listener); }, removeEventListener(_, listener) { mediaListeners.delete(listener); } });
  win.CSS = { supports: (_, value) => !/mod\(|round\(|linear\(/.test(value), registerProperty() {} };
  const CSSStyleSheet = class { constructor() { this.cssRules = []; } replaceSync(css) { this.cssRules = [{ cssText: css }]; } };
  Object.defineProperty(win.ShadowRoot.prototype, "adoptedStyleSheets", { configurable: true, get() { return this.sheets ?? []; }, set(value) { this.sheets = value; } });
  win.IntersectionObserver = class { constructor(callback) { this.callback = callback; } observe(node) { observed.set(node, this); } unobserve(node) { observed.delete(node); } disconnect() { for (const [node, observer] of observed) if (observer === this) observed.delete(node); } };
  const ResizeObserver = class { constructor(callback) { this.callback = callback; resizeObservers.add(this); } observe() {} disconnect() { resizeObservers.delete(this); } };
  let frameId = 0, animationCount = 0;
  win.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; }; win.cancelAnimationFrame = id => frames.delete(id);
  const frame = () => { const batch = [...frames]; frames.clear(); for (const [, callback] of batch) callback(0); };
  win.Element.prototype.animate = function (keyframes, timing) { let resolve; const finished = new Promise(done => { resolve = done; }); const animation = { owner: this, keyframes, timing, finished, finish() { animations.delete(animation); this.onfinish?.(); resolve(); }, cancel() { animations.delete(animation); resolve(); } }; animations.add(animation); animationCount++; if (!timing?.duration) animation.finish(); return animation; };
  win.ShadowRoot.prototype.getAnimations = function () { return [...animations].filter(animation => this.contains(animation.owner)); };
  Object.defineProperties(win.HTMLElement.prototype, { offsetWidth: { configurable: true, get: () => 100 }, offsetHeight: { configurable: true, get: () => 20 } });
  win.HTMLElement.prototype.scrollIntoView = function () {};
  const sandbox = { window: win, document, Date: TestDate, console, Error, AbortController, structuredClone, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout, atob, btoa, CSS: win.CSS, CSSStyleSheet, ResizeObserver, requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame, getComputedStyle: win.getComputedStyle.bind(win) };
  for (const name of ["navigator", "customElements", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "DOMParser", "DOMRect", "FileReader", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) sandbox[name] = win[name];
  const shim = { exports: {} }, compiled = { exports: {} };
  vm.runInNewContext(shimBuild.outputFiles[0].text, { ...sandbox, module: shim, exports: shim.exports });
  vm.runInNewContext(build.outputFiles[0].text, { ...sandbox, module: compiled, exports: compiled.exports, require(id) { assert.equal(id, "obsidian"); return { ...shim.exports, Platform: { isMobileApp: true, isMobile: true, isTablet: device === "ipad" }, Notice: class { constructor(message) { notices.push(String(message)); } } }; } });
  const ui = compiled.exports, tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const events = () => { const listeners = new Set(); return { listeners, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, emit() { for (const listener of [...listeners]) listener(); } }; };
  const storeEvents = events(), entryEvents = events(), financeEvents = events(), accessEvents = events(), ownerEvents = events(), views = new Set();
  const settings = { settingsLanguage: "zh-CN", lifestyle: structuredClone(ui.DEFAULT_LIFESTYLE_SETTINGS), homeModules: { finance: true }, mobileUi: {} };
  Object.assign(settings.lifestyle.finance, { enabled: true, aiEnabled: false, categories: [{ name: "餐饮", active: true, icon: "utensils", color: "#238000" }], accounts: [{ name: "现金", active: true, aliases: [] }] });
  const data = structuredClone(ui.EMPTY_LIFESTYLE_DATA); data.financeDefaultBudget = { totalCents: 100000, allocations: { 餐饮: 50000 } }; data.financeBillPlans = [{ id: "trip", name: "真实计划", budgetCents: 200000 }];
  let entries = Array.from({ length: 61 }, (_, index) => ({ id: `row-${index}`, merchant: `商户${index}`, category: "餐饮", amountCents: 1000 + index, date: `2026-10-${String(index % 28 + 1).padStart(2, "0")}`, kind: "expense", status: "completed", currency: "CNY", account: "现金", description: "真实读取夹具", note: "", source: "manual", sourceId: `row-${index}`, icon: "auto", billPlanId: "trip" }));
  let rights = { canEnter: true, canWrite: true, reason: null }, failSave = false, failInitialize = false, initializeRelease, deferInitialize = false, ownerName = "真实负责人";
  const calls = { initialize: 0, storeInitialize: 0, manual: [], update: [], budget: [], open: [], csv: [], handoff: [], navigate: [] };
  const access = { subscribe: accessEvents.subscribe, checkCapability: () => rights.canWrite, requireCapability() { if (!rights.canWrite) throw new Error("写入权限已失效"); } };
  const refresh = () => views.forEach(view => view.render());
  const finance = {
    access, accessState: () => rights, subscribe: financeEvents.subscribe, subscribeEntries: entryEvents.subscribe,
    async initialize() { calls.initialize++; storeEvents.emit(); entryEvents.emit(); if (deferInitialize) await new Promise(resolve => { initializeRelease = resolve; }); if (failInitialize) throw new Error("账本初始化失败"); },
    entries: () => entries, issues: () => [], billPlans: () => data.financeBillPlans, goals: () => [], latestReport: () => null, busyMonth: () => null,
    billPlanStats: id => ui.financeBillPlanStats(data.financeBillPlans.find(plan => plan.id === id), entries),
    monthlyPlan: month => ({ month, dailyLimitCents: null, goals: [] }), async openBase(id) { calls.open.push(id ?? "ledger"); },
    exportCsv(values) { calls.csv.push(values); return "merchant,amount\n"; },
    async addManual(value) { access.requireCapability(); if (failSave) throw new Error("写入失败，输入保留"); calls.manual.push(value); const created = { ...value, id: `manual-${calls.manual.length}`, source: "manual" }; entries.push(created); entryEvents.emit(); refresh(); return created; },
    async updateDetails(id, merchant, description, icon, category, account, billPlanId) { access.requireCapability(); if (failSave) throw new Error("写入失败，输入保留"); calls.update.push({ id, merchant, description, icon, category, account, billPlanId }); Object.assign(entries.find(entry => entry.id === id), { merchant, description, icon, category, account }); entryEvents.emit(); refresh(); },
    async saveOption(key, value) { access.requireCapability(); if (key === "showOnHome") settings.homeModules.finance = value; else settings.lifestyle.finance[key] = value; refresh(); }, async saveAnalysisDirectory(value) { settings.lifestyle.finance.analysisDirectory = value; refresh(); }, async saveCatalog(kind, value) { settings.lifestyle.finance[kind] = value; refresh(); },
    async saveBudgetChanges(value) { access.requireCapability(); if (failSave) throw new Error("预算保存失败"); calls.budget.push(value); if (value.defaultBudget !== undefined) data.financeDefaultBudget = value.defaultBudget; storeEvents.emit(); refresh(); }
  };
  const lifestyle = { plugin: { app: {}, settings, saveFinanceCsv: async name => { calls.open.push(name); return `Exports/${name}`; } }, store: { snapshot: () => data, subscribe: storeEvents.subscribe }, finance,
    async initialize() { calls.storeInitialize++; storeEvents.emit(); }, refresh, registerView(view) { views.add(view); }, unregisterView(view) { views.delete(view); }, viewportRoot: () => [...views][0]?.contentEl };
  const host = { settings: () => settings, services: { lifestyle, modules: { finance: { service: finance }, owner: () => ({ id: "owner", name: ownerName, avatar: { kind: "emoji", value: "🌿" } }), async handoff(module, prompt, replaceDraft) { calls.handoff.push({ module, prompt, replaceDraft }); return { agentId: "owner", conflict: !replaceDraft }; } } }, workbench: { subscribe: ownerEvents.subscribe }, openAgent: async route => calls.navigate.push(route), openNote: async path => calls.open.push(path), renderMarkdown(text, node) { node.textContent = text; } };
  const shell = device === "iphone" ? new ui.IPhoneShell(root, { onError: error => errors.push(error) }) : new ui.IPadShell(root, { onError: error => errors.push(error) });
  const ctx = { root, document, shell, host, navigate: async route => calls.navigate.push(route), error: error => errors.push(error) };
  let baseIndex = 0;
  const base = () => ({ id: `base-${baseIndex++}`, title: "工作台", content: document.createElement("div") });
  const current = () => root.querySelector(device === "iphone" ? ".eis-page:not([hidden])" : ".echoink-ipad-page:not([hidden])");
  const findButton = (text, area = current()) => [...area.querySelectorAll("button")].find(node => node.textContent.trim() === text || node.getAttribute("aria-label") === text);
  const click = async (text, area) => { const button = findButton(text, area); assert.ok(button, `${device} button: ${text}`); assert.equal(button.disabled, false, text); button.click(); await tick(); };
  const tab = async name => { const button = [...current().querySelectorAll('[role="tab"]')].find(node => node.textContent.startsWith(name)); assert.ok(button, name); button.click(); await tick(); };
  const selected = () => current().querySelector('[role="tab"][aria-selected="true"]')?.textContent;
  const mount = async () => { shell.mount(base()); if (device === "iphone") await ui.openIPhoneFinance(ctx); else shell.mount(ui.createFinancePage(ctx)); await tick(); };
  const modal = () => document.querySelector(".modal-container");
  const input = (label, value, area = modal()) => { const row = [...area.querySelectorAll("label")].find(node => node.firstElementChild?.textContent === label), field = row?.querySelector("input,select,textarea"); assert.ok(field, label); field.value = value; field.dispatchEvent(new win.Event("input", { bubbles: true })); return field; };
  const animateNumbers = async () => { await tick(); for (const [node, observer] of [...observed]) observer.callback([{ target: node, isIntersecting: true }]); frame(); frame(); };
  const assertDisposed = () => { assert.equal(views.size, 0); assert.equal(root.querySelector(".echoink-lifestyle-view,.echoink-mobile-finance,.ip-finance-viewport,.pd-finance-viewport"), null, "root page has no finance viewport classes"); for (const bus of [storeEvents, entryEvents, financeEvents, accessEvents, ownerEvents]) assert.equal(bus.listeners.size, 0, "all view subscriptions released"); assert.equal(observed.size, 0); assert.equal(mediaListeners.size, 0); };
  try {
    await mount();
    assert.equal(calls.initialize, 1); assert.equal(calls.storeInitialize, 1); assert.equal(views.size, 1);
    assert.match(current().textContent, /每一笔，都有自己的去处。/);
    assert.deepEqual([...current().querySelectorAll('[role="tab"]')].map(node => node.firstElementChild.nextSibling.textContent), ["财务总览", "收支明细", "月度预算", "账单计划"]);
    assert.equal(current().querySelector('.ip-finance-summary,.pd-finance-summary,input[type="month"]'), null);
    assert.ok(current().querySelector(".echoink-finance-donut-svg")); assert.ok(current().querySelector(".echoink-finance-calendar"));
    assert.ok(findButton("交给真实负责人")); ownerName = "新负责人"; ownerEvents.emit(); assert.ok(findButton("交给新负责人"));
    await click("交给新负责人"); assert.equal(calls.handoff.at(-1).replaceDraft, false); assert.equal(calls.navigate.length, 0); await click("替换草稿"); assert.equal(calls.handoff.at(-1).replaceDraft, true); assert.equal(calls.navigate.at(-1).agentId, "owner");
    await animateNumbers(); assert.ok(current().querySelector("echoink-finance-number-flow-v023")); assert.ok(animationCount > 0, "official digit animations are executed");
    await click("下一个月"); assert.match(current().querySelector(".echoink-finance-month").textContent, /2026 年 11 月/); await click("上一个月");
    await tab("收支明细"); assert.equal(current().querySelectorAll(".echoink-finance-ledger-list .echoink-finance-transaction").length, 20); await click("下一页"); assert.equal(current().querySelector('[aria-current="page"]').textContent, "2");
    const original = current(), originalWorkspace = current().querySelector(".echoink-finance-workspace"), viewport = current().querySelector(".echoink-lifestyle-view"); assert.ok(viewport.classList.contains("echoink-mobile-finance"), "the original mobile compact controls and 16px input family are active"); viewport.scrollTop = 312;
    await click("设置"); assert.equal(current().querySelector(".echoink-lifestyle-view,.echoink-mobile-finance,.ip-finance-viewport,.pd-finance-viewport"), null, "nested settings has no finance viewport classes"); assert.equal(shell.activePageId, device === "iphone" ? "iphone-settings-finance" : "ipad-finance-settings");
    await click(device === "iphone" ? "分类管理" : "分类"); await shell.back(); await shell.back(); await tick();
    assert.equal(current(), original); assert.equal(current().querySelector(".echoink-finance-workspace"), originalWorkspace); assert.match(selected(), /收支明细/); assert.equal(viewport.scrollTop, 312); assert.equal(current().querySelector('[aria-current="page"]').textContent, "2"); assert.equal(calls.initialize, 1);
    await click("设置"); const homeToggle = [...current().querySelectorAll("label")].find(label => label.textContent.trim() === "在首页显示")?.querySelector("input"); assert.ok(homeToggle, "the original home-visibility option is retained on both devices"); const homeBefore = settings.homeModules.finance; assert.equal(homeToggle.checked, homeBefore !== false); homeToggle.checked = !homeBefore; homeToggle.dispatchEvent(new win.Event("change")); await tick(); assert.equal(settings.homeModules.finance, !homeBefore); await shell.back(); await tick(); assert.match(selected(), /收支明细/); assert.equal(viewport.scrollTop, 312); assert.equal(current().querySelector('[aria-current="page"]').textContent, "2"); assert.equal(calls.initialize, 1, "saving settings must retain the initialized financial workspace");
    await click("打开账本"); assert.equal(calls.open.at(-1), "ledger"); await click("导出 CSV"); assert.equal(calls.csv.at(-1).length, 61);
    await click("记一笔"); input("金额 · 元", "12.34"); input("商户／对方名称", "保留的商户"); failSave = true; modal().querySelector("form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await tick(); assert.match(modal().textContent, /写入失败/); assert.equal(input("商户／对方名称", "保留的商户").value, "保留的商户");
    rights = { canEnter: true, canWrite: false, reason: "权限已失效" }; accessEvents.emit(); await tick(); assert.equal(findButton("保存记录", modal()).disabled, true); assert.equal(findButton("记一笔").disabled, true);
    rights = { canEnter: true, canWrite: true, reason: null }; accessEvents.emit(); await tick(); failSave = false; modal().querySelector("form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await tick(); assert.equal(modal(), null); assert.equal(calls.manual.at(-1).amountCents, 1234);
    current().querySelector(".echoink-finance-transaction").click(); await tick(); input("商户 / 对方", "编辑后商户"); failSave = true; await click("保存修改", modal()); assert.match(modal().textContent, /写入失败/); assert.equal(input("商户 / 对方", "编辑后商户").value, "编辑后商户"); failSave = false; await click("保存修改", modal()); assert.equal(calls.update.at(-1).merchant, "编辑后商户"); assert.equal(calls.update.at(-1).billPlanId, undefined, "unchanged association is preserved");
    await click("导入账单"); assert.ok(modal().querySelector('input[type="file"]')); await click("取消", modal());
    await tab("月度预算"); await animateNumbers(); assert.equal(current().querySelectorAll("echoink-finance-number-flow-v023").length, 2);
    await click("调整预算"); input("月度总预算 · 元", "1300"); failSave = true; modal().querySelector("form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await tick(); assert.match(modal().textContent, /预算保存失败/); failSave = false; modal().querySelector("form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await tick(); assert.equal(modal(), null); assert.equal(calls.budget.at(-1).defaultBudget.totalCents, 130000);
    await tab("账单计划"); current().querySelector('[data-plan-focus="plan:trip"]').click(); await tick(); await animateNumbers(); assert.equal(current().querySelectorAll("echoink-finance-number-flow-v023").length, 3);
    const plan = current().querySelector(".echoink-finance-bill-details"); assert.ok(plan); await click("设置"); await shell.back(); await tick(); assert.equal(current().querySelector(".echoink-finance-bill-details"), plan, "bill dashboard survives nested settings");
    rights = { canEnter: false, canWrite: false, reason: "无查看权限" }; accessEvents.emit(); await tick(); assert.equal(current().querySelector(".echoink-finance-tabs"), null); assert.match(current().textContent, /无查看权限/);
    rights = { canEnter: true, canWrite: true, reason: null }; accessEvents.emit(); await tick(); assert.match(selected(), /账单计划/); assert.equal(calls.initialize, 1);
    shell.mount(base()); await tick(); assertDisposed();
    // A failed initialization retries only on explicit action, never its own notifications.
    failInitialize = true; const beforeFailure = calls.initialize; await mount(); assert.equal(calls.initialize, beforeFailure + 1); assert.match(current().textContent, /账本初始化失败/); await tick(); assert.equal(calls.initialize, beforeFailure + 1); failInitialize = false; await click("重试"); assert.equal(calls.initialize, beforeFailure + 2);
    shell.mount(base()); await tick(); assertDisposed();
    // Initial access denial neither opens the ledger nor repeats initialization.
    rights = { canEnter: false, canWrite: false, reason: "无查看权限" }; const beforeLocked = calls.initialize; await mount(); assert.equal(calls.initialize, beforeLocked); assert.equal(current().querySelector(".echoink-finance-tabs"), null);
    rights = { canEnter: true, canWrite: true, reason: null }; accessEvents.emit(); await tick(); assert.equal(calls.initialize, beforeLocked + 1); assert.ok(current().querySelector(".echoink-finance-tabs"));
    settings.lifestyle.finance.enabled = false; refresh(); await tick(); assert.match(current().textContent, /财务插件已关闭/); settings.lifestyle.finance.enabled = true; refresh(); await tick(); assert.ok(current().querySelector(".echoink-finance-tabs")); assert.equal(calls.initialize, beforeLocked + 1);
    for (const view of [...views]) view.releaseResources(); await tick(); assertDisposed(); shell.mount(base());
    // Closing during initialization must leave no late render or subscription behind.
    deferInitialize = true; shell.mount(base()); const pending = device === "iphone" ? ui.openIPhoneFinance(ctx) : Promise.resolve(shell.mount(ui.createFinancePage(ctx))); await tick(); assert.ok(initializeRelease); shell.mount(base()); initializeRelease(); await pending; await tick(); assertDisposed(); assert.match(shell.activePageId, /^base-/);
    assert.equal(document.querySelector("aside textarea"), draft); assert.equal(draft.value, "Agent draft retained"); assert.equal(errors.length, 0, errors.map(String).join("\n"));
    console.log(`PASS ${device} formal FinanceWorkspace: four tabs/charts/NumberFlow, month/pagination/CSV, retained settings return and right draft, manual/detail/budget failure + permissions, import entry, bill dashboard, single initialization/retry/close/disposal.`);
  } finally { shell.dispose(); for (const modal of [...document.querySelectorAll(".modal-container")]) modal.remove(); for (const animation of [...animations]) animation.finish(); dom.window.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const device of ["iphone", "ipad"]) await runMobileFinanceWorkspaceUiTests(device);
}
