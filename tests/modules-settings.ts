// Run: ECHOINK_MODULES_TEST_ROOT=<registered disposable root> node --experimental-strip-types tests/modules-settings.ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

const root = process.cwd();
const registered = path.join(homedir(), "EchoInk-TestVaults/90-任务临时/工作台P12自动测试-20261019");
assert.equal(process.env.ECHOINK_MODULES_TEST_ROOT, registered, "Use only the registered P12 test root");
const temporary = await mkdtemp(path.join(registered, "modules-"));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost" });
const win = dom.window as any;
win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLFormElement", "Element", "Node", "MutationObserver", "ResizeObserver", "navigator", "getComputedStyle", "DocumentFragment", "Event", "CustomEvent", "CSS"];
const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: win[key] });
const create = function(this: any, tag: string, options: any = {}) {
  if (typeof options === "string") options = { cls: options };
  const element = this.ownerDocument.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.value !== undefined) element.value = options.value;
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  this.appendChild(element); return element;
};
Object.assign(win.Element.prototype, {
  empty() { this.replaceChildren(); }, addClass(...names: string[]) { this.classList.add(...names); }, removeClass(...names: string[]) { this.classList.remove(...names); },
  toggleClass(name: string, value: boolean) { this.classList.toggle(name, value); }, hasClass(name: string) { return this.classList.contains(name); },
  setText(value: string) { this.textContent = value; }, setAttr(key: string, value: string) { this.setAttribute(key, value); },
  createEl: create, createDiv(options: any) { return create.call(this, "div", options); }, createSpan(options: any) { return create.call(this, "span", options); },
  attachEvent() {}, detachEvent() {}, scrollIntoView() {}, hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}
});
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
let runtime: any;
try {
  const output = path.join(temporary, "modules.mjs");
  const compiled = await esbuild.build({ stdin: { contents: `
    export { Platform, TFile, TFolder, openTestModals } from "obsidian";
    export { renderDesktopModuleSettings } from "./src/settings/desktop-module-settings";
    export { renderSelectionAnnotationSettings } from "./src/settings/selection-annotation-settings";
    export { normalizeSelectionAskSettings, visibleCharacters } from "./src/selection-ask/settings";
    export { JournalTemplateModal } from "./src/home/journal-template-modal";
    export { HomeWorkbenchDataService } from "./src/home/home-workbench-data";
    export { LifestyleSettingsPanel } from "./src/lifestyle/settings-panel";
    export { FinanceCatalogPanel } from "./src/lifestyle/finance-catalog-dialog";
    export { PdfReadingSettingsPanel } from "./src/pdf-reading/settings-panel";
    export { renderTodoReminderSettings } from "./src/settings/todo-reminder-settings";
    export { disposeOriginControls } from "./src/settings/origin-controls";
    export { fixture, prepareDocument, mountDefinitions } from "./src/tests/settings-search-dom";
    export { resolveDesktopSettingsRoute, resolveDesktopSettingsSearchRoute } from "./src/settings/desktop-settings-route";
  `, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", outfile: output, write: false,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "obsidian-host", setup(build: any) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^(@earendil-works\/pi-(agent-core|ai|coding-agent)(\/|$)|yaml$)/ }, (args: any) => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
    } }], logLevel: "silent" });
  await writeFile(output, compiled.outputFiles[0].contents);
  runtime = await import(pathToFileURL(output).href);
  runtime.Platform.isDesktopApp = true;
  const host = () => { const element = document.createElement("div"); element.className = "echoink-settings-demo"; document.body.appendChild(element); return element; };
  const buttons = (element: Element, text: string) => Array.from(element.querySelectorAll("button")).find(button => button.textContent === text) as HTMLButtonElement;
  const input = (element: Element, label: string) => element.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  const change = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => { element.value = value; element.dispatchEvent(new win.Event("input", { bubbles: true })); };
  let qualified = true, fail = false, saves = 0;
  const subscribers = new Set<() => void>();
  const access = { checkCapability: () => qualified, requireCapability: () => { if (!qualified) throw new Error("需要 PRO"); }, subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn); } };
  const settings = { settingsLanguage: "zh-CN", selectionAsk: { enabled: true, actions: [{ id: "default", name: "提问", template: "" }, { id: "a", name: "总结", template: "总结一下" }] },
    lifestyle: { finance: { enabled: true, aiEnabled: false, importAiEnabled: false, analysisDirectory: "报告", merchants: [], accounts: [], categories: [] } },
    englishDiary: { enabled: true }, homeModules: { finance: true }, pdfReading: { enabled: true, engine: "local", mineruToken: "secret-token", translationLanguage: "中文", originalDirectory: "资料" } };
  const plugin: any = { settings, accountService: access, app: {}, saveSettings: async () => { saves++; if (fail) throw new Error("磁盘已满"); },
    lifestyle: { label: () => "财务", setEnabled: async (_kind: string, value: boolean) => { access.requireCapability(); settings.lifestyle.finance.enabled = value; }, finance: { access, accessState: () => ({ canWrite: qualified, canEnter: true, canToggle: qualified, reason: qualified ? null : "需要 PRO" }), ledger: { paths: () => ({ root: "财务" }) }, saveOption: async (name: string, value: boolean) => { access.requireCapability(); settings.lifestyle.finance[name] = value; }, saveAnalysisDirectory: async () => { access.requireCapability(); } } },
    pdfReading: { api: { deps: { access } }, policy: () => ({ canWrite: qualified, canEnter: true, canToggle: qualified, reason: qualified ? null : "需要 PRO" }), setEnabled: async (value: boolean) => { access.requireCapability(); settings.pdfReading.enabled = value; }, originalDirectories: () => ["资料"], defaultOriginalDirectory: () => "资料" },
    englishDiary: { setEnabled: async (value: boolean) => { access.requireCapability(); settings.englishDiary.enabled = value; } }
  };
  assert.equal(runtime.normalizeSelectionAskSettings({ actions: [{ id: "default", template: "原模板" }, ...[1, 2, 3].map(n => ({ id: String(n), name: `选项${n}`, template: String(n) }))] }).actions.length, 4);
  assert.equal(runtime.visibleCharacters("👨‍👩‍👧‍👦你好").length, 3);

  const modules = host(), expanded = new Set(["knowledge", "finance"]), rendered: string[] = [];
  const disposeModules = runtime.renderDesktopModuleSettings(modules, { plugin, expanded, renderContent: (id: string) => { rendered.push(id); }, summary: () => "真实目录", onProBenefits() {} });
  assert.equal(modules.querySelectorAll(".echoink-module-drawer").length, 8);
  assert.equal(modules.querySelectorAll('[role="switch"]').length, 4);
  const financeTrigger = input(modules, "财务"), financeToggle = input(modules, "启用财务");
  const beforeSave = saves; financeTrigger.click(); financeTrigger.click(); assert.equal(saves, beforeSave);
  financeToggle.click(); await settle(); assert.equal(settings.lifestyle.finance.enabled, false); assert.equal(expanded.has("finance"), false);
  assert.equal(financeTrigger.disabled, true);
  financeToggle.click(); await settle(); assert.equal(settings.lifestyle.finance.enabled, true); assert.equal(expanded.has("finance"), true, "successful enable opens the drawer");
  qualified = false; subscribers.forEach(fn => fn());
  assert.equal(financeToggle.disabled, true); assert.equal(financeTrigger.disabled, false); assert.equal(settings.lifestyle.finance.enabled, true);
  const selectionToggle = input(modules, "启用选文提问"); fail = true; selectionToggle.click(); await settle(); assert.equal(settings.selectionAsk.enabled, true); assert.equal(selectionToggle.checked, true); fail = false;
  disposeModules(); assert.equal(subscribers.size, 0);

  qualified = true;
  const financeHost = host(), finance = new runtime.LifestyleSettingsPanel(plugin, "finance", () => {}, () => {});
  finance.render(financeHost, { embedded: true });
  assert.equal(financeHost.querySelectorAll("h2,.echoink-life-settings-back").length, 0);
  assert.equal(financeHost.querySelectorAll('[role="switch"]').length, 0);
  assert.equal(financeHost.querySelectorAll('[role="checkbox"]').length, 2);
  assert.equal(financeHost.textContent.includes("在首页显示"), false);
  input(financeHost, "AI 分析").click(); await settle(); assert.equal(settings.lifestyle.finance.aiEnabled, true);
  qualified = false; subscribers.forEach(fn => fn()); assert.equal(input(financeHost, "分析保存位置").disabled, true); finance.dispose();
  qualified = true;
  const pdfHost = host(), pdf = new runtime.PdfReadingSettingsPanel(plugin, () => {}); pdf.render(pdfHost, { embedded: true });
  assert.equal(pdfHost.querySelectorAll("h2,[role=switch]").length, 0);
  assert.equal(input(pdfHost, "MinerU 专用 Token").type, "password");
  assert.equal(input(pdfHost, "MinerU 专用 Token").value, "secret-token");
  pdf.dispose();
  let reminderEnabled = false;
  const reminderSubscribers = new Set<() => void>();
  const reminderHost = host();
  const disposeReminders = runtime.renderTodoReminderSettings(reminderHost, { ...plugin, getTodoReminderService: () => ({ status: () => ({ enabled: reminderEnabled, busy: false, permission: "granted", error: "" }), setEnabled: async (value: boolean) => { reminderEnabled = value; reminderSubscribers.forEach(fn => fn()); return { ok: true }; }, subscribe: (fn: () => void) => { reminderSubscribers.add(fn); return () => reminderSubscribers.delete(fn); } }) }, { embedded: true });
  assert.equal(reminderHost.querySelectorAll('[role="switch"]').length, 0);
  input(reminderHost, "待办到期提醒").click(); await settle(); assert.equal(reminderEnabled, true); disposeReminders(); assert.equal(reminderSubscribers.size, 0);

  const selectionHost = host(); let returned = 0;
  const selectionController = runtime.renderSelectionAnnotationSettings(selectionHost, plugin, () => returned++);
  assert.equal(selectionController.hasUnsavedChanges(), false);
  buttons(selectionHost, "编辑").click();
  const fixed = selectionHost.querySelector('[data-action-id="default"]')!;
  assert.equal(input(fixed, "选项名称").disabled, true); assert.equal(buttons(fixed, "删除"), undefined);
  change(input(fixed, "提问模板"), "取消内容"); buttons(fixed, "取消").click(); assert.equal(settings.selectionAsk.actions[0].template, "");
  buttons(selectionHost, "新增选项").click();
  let editor = selectionHost.querySelector(".echoink-selection-inline-editor")!;
  const name = input(editor, "选项名称");
  name.dispatchEvent(new win.CompositionEvent("compositionstart")); change(name, "一二三四五"); assert.notEqual(name.getAttribute("aria-invalid"), "true");
  name.dispatchEvent(new win.CompositionEvent("compositionend")); assert.equal(name.getAttribute("aria-invalid"), "true");
  change(name, "总结"); buttons(editor, "保存").click(); assert.equal(name.getAttribute("aria-invalid"), "true");
  change(name, "补充"); change(input(editor, "提问模板"), "补充问题"); fail = true; buttons(editor, "保存").click(); await settle();
  assert.equal(settings.selectionAsk.actions.length, 2); editor = selectionHost.querySelector(".echoink-selection-inline-editor")!; assert.equal(input(editor, "提问模板").value, "补充问题");
  fail = false; buttons(editor, "保存").click(); assert.equal(selectionController.isPending(), true); await settle(); assert.equal(settings.selectionAsk.actions.length, 3); assert.equal(selectionController.hasUnsavedChanges(), false);
  buttons(selectionHost, "新增选项").click(); editor = selectionHost.querySelector(".echoink-selection-inline-editor")!; change(input(editor, "选项名称"), "改写"); buttons(editor, "保存").click(); await settle(); assert.equal(settings.selectionAsk.actions.length, 4); assert.equal(buttons(selectionHost, "新增选项").hidden, true);
  buttons(selectionHost, "编辑").click(); change(input(selectionHost, "提问模板"), "未保存"); buttons(selectionHost, "返回模块")?.click();
  const backButton = selectionHost.querySelector<HTMLButtonElement>(".settings-back")!; backButton.click(); assert.equal(returned, 0); buttons(selectionHost, "继续编辑").click(); assert.equal(returned, 0); backButton.click(); buttons(selectionHost, "放弃修改").click(); await settle(); assert.equal(returned, 1);
  buttons(selectionHost, "编辑").click(); change(input(selectionHost, "提问模板"), "切页草稿"); let changedTab = 0;
  selectionController.requestBack(() => changedTab++); assert.equal(changedTab, 0); buttons(selectionHost, "继续编辑").click(); assert.equal(selectionController.hasUnsavedChanges(), true);
  selectionController.requestBack(() => changedTab++); buttons(selectionHost, "放弃修改").click(); await settle(); assert.equal(changedTab, 1); assert.equal(selectionController.hasUnsavedChanges(), false);
  runtime.Platform.isDesktopApp = false;
  const legacyHost = host(); runtime.renderSelectionAnnotationSettings(legacyHost, plugin, () => {}); assert.equal(legacyHost.querySelectorAll(".echoink-selection-settings-action").length, 3); buttons(legacyHost, "保存").click(); await settle(); assert.equal(settings.selectionAsk.actions.length, 4); runtime.Platform.isDesktopApp = true;

  settings.lifestyle.finance.categories = [{ name: "餐饮", active: true, icon: "utensils", color: "#5c8977" }];
  plugin.lifestyle.finance.saveCatalog = async (kind: string, items: unknown[]) => { access.requireCapability(); if (fail) throw new Error("分类未保存"); settings.lifestyle.finance[kind] = items; };
  const catalogHost = host(); let catalog: any;
  const drawCatalog = () => { runtime.disposeOriginControls(catalogHost); catalogHost.empty(); catalog.render(catalogHost); };
  catalog = new runtime.FinanceCatalogPanel(plugin, "categories", () => {}, drawCatalog, { embedded: true }); drawCatalog();
  assert.equal(catalogHost.querySelectorAll('[role="checkbox"]').length, 1);
  buttons(catalogHost, "删除").click(); assert.equal(runtime.openTestModals.length, 0); assert.ok(catalogHost.querySelector(".echoink-settings-inline-confirm"));
  buttons(catalogHost.querySelector(".echoink-settings-inline-confirm")!, "取消").click(); assert.equal(settings.lifestyle.finance.categories.length, 1);
  buttons(catalogHost, "删除").click(); fail = true; buttons(catalogHost.querySelector(".echoink-settings-inline-confirm")!, "删除").click(); await settle(); assert.equal(settings.lifestyle.finance.categories.length, 1); assert.ok(catalogHost.textContent.includes("分类未保存"));
  fail = false; buttons(catalogHost, "删除").click(); buttons(catalogHost.querySelector(".echoink-settings-inline-confirm")!, "删除").click(); await settle(); assert.equal(settings.lifestyle.finance.categories.length, 0);
  buttons(catalogHost, "新增分类").click();
  let catalogForm = catalogHost.querySelector("form")!;
  change(catalogForm.querySelector("input")!, "新分类草稿");
  let scopeDepth = 0; plugin.app.keymap = { pushScope() { scopeDepth++; }, popScope() { scopeDepth--; } };
  const iconTrigger = catalogHost.querySelector<HTMLButtonElement>(".echoink-finance-icon-trigger")!; iconTrigger.click();
  assert.equal(scopeDepth, 1); assert.equal(runtime.openTestModals.length, 0); assert.equal(catalogForm.hidden, true);
  const iconSearch = input(catalogHost, "搜索图标"); change(iconSearch, "utensils");
  const iconChoice = catalogHost.querySelector<HTMLButtonElement>(".echoink-finance-icon-item")!; assert.ok(iconChoice); iconChoice.click();
  assert.equal(scopeDepth, 0); assert.equal(catalogForm.hidden, false); assert.equal(catalogForm.querySelector<HTMLInputElement>("input")!.value, "新分类草稿"); assert.equal(document.activeElement, iconTrigger);
  catalogForm.dispatchEvent(new win.Event("submit", { cancelable: true, bubbles: true })); await settle(); assert.equal(settings.lifestyle.finance.categories[0].name, "新分类草稿"); assert.equal(settings.lifestyle.finance.categories[0].icon, "utensils"); catalog.dispose();
  const legacyCatalogHost = host(), legacyCatalog = new runtime.FinanceCatalogPanel(plugin, "categories", () => {}, () => {}); legacyCatalog.render(legacyCatalogHost);
  assert.equal(legacyCatalogHost.querySelectorAll('[role="switch"]').length, 1);
  buttons(legacyCatalogHost, "删除").click(); await settle(); assert.equal(runtime.openTestModals.length, 1); buttons(runtime.openTestModals[0].contentEl, "取消").click(); await settle(); assert.equal(runtime.openTestModals.length, 0); assert.equal(settings.lifestyle.finance.categories.length, 1); legacyCatalog.dispose();

  const memoryFiles = new Map<string, any>(), contents = new Map<string, string>(), creates: string[] = [];
  const original = new runtime.TFile("templates/journal/同名.md"); original.basename = "同名"; memoryFiles.set(original.path, original); contents.set(original.path, "原模板");
  const app: any = { vault: { getAllLoadedFiles: () => [...memoryFiles.values()], getMarkdownFiles: () => [...memoryFiles.values()].filter(value => value instanceof runtime.TFile), getAbstractFileByPath: (target: string) => memoryFiles.get(target), read: async (file: any) => contents.get(file.path), createFolder: async (target: string) => { const folder = new runtime.TFolder(); folder.path = target; memoryFiles.set(target, folder); }, create: async (target: string, content: string) => { assert.equal(memoryFiles.has(target), false); const file = new runtime.TFile(target); file.basename = path.basename(target, ".md"); memoryFiles.set(target, file); contents.set(target, content); creates.push(target); return file; } }, workspace: { getLeaf: () => { throw new Error("Settings must not open a diary"); } } };
  const service = new runtime.HomeWorkbenchDataService(app);
  const templateHost = host(), templates = new runtime.JournalTemplateModal(app, { service, customTemplates: service.listCustomTemplates(), date: new Date(), language: "zh-CN", onEnglish: () => { throw new Error("Settings must not create English diary"); } });
  const disposeTemplates = templates.mountManagement(templateHost); await settle();
  assert.equal(runtime.openTestModals.length, 0); assert.equal(templateHost.querySelectorAll(".echoink-journal-modal-actions").length, 0); assert.equal(templateHost.querySelectorAll(".echoink-journal-template-card").length, 4);
  const fileInput = templateHost.querySelector('input[type="file"]')!;
  Object.defineProperty(fileInput, "files", { configurable: true, value: [{ name: "同名.md", arrayBuffer: async () => new TextEncoder().encode("导入正文").buffer }] }); fileInput.dispatchEvent(new win.Event("change")); await settle();
  buttons(templateHost, "保存到“我的模板”").click(); await settle(); assert.equal(creates.length, 0); assert.equal(contents.get(original.path), "原模板");
  const safeCopy = templateHost.querySelector<HTMLButtonElement>(".echoink-journal-import-preview .mod-cta")!; assert.ok(safeCopy); safeCopy.click(); await settle();
  assert.equal(creates.length, 1); assert.ok(creates[0].startsWith("templates/journal/")); assert.equal(contents.get(original.path), "原模板"); disposeTemplates();
  const documentHarness = runtime.prepareDocument(win);
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: win.ResizeObserver });
  const shell = runtime.fixture(win, "zh-CN");
  Object.assign(shell.plugin.app.vault, { getMarkdownFiles: () => [], getRoot: () => ({ children: [] }), getAllFolders: () => [], getAbstractFileByPath: () => null, on: () => ({}), offref() {} });
  shell.plugin.getKnowledgeSurfaceService = () => null;
  shell.plugin.lifestyle = plugin.lifestyle;
  shell.plugin.accountService = access;
  shell.plugin.pdfReading = plugin.pdfReading;
  shell.plugin.englishDiary = plugin.englishDiary;
  shell.plugin.englishDiaryProviderLabel = () => "默认模型";
  shell.tab.openDesktopRoute({ tab: "modules", section: "journal" }); shell.tab.display(); await documentHarness.flush();
  assert.equal(shell.tab.containerEl.querySelectorAll(".echoink-module-drawer").length, 8);
  assert.ok(input(shell.tab.containerEl, "日记保存文件夹"));
  shell.tab.containerEl.querySelector('[data-echoink-focus-key="journal:templates"]').click(); await documentHarness.flush();
  assert.equal(shell.tab.containerEl.querySelectorAll(".echoink-journal-template-card").length, 4); assert.equal(runtime.openTestModals.length, 0);
  shell.tab.containerEl.querySelector(".settings-back").click(); await documentHarness.flush(); assert.ok(input(shell.tab.containerEl, "日记保存文件夹"));
  shell.tab.openDesktopRoute({ tab: "modules", section: "review" }); await documentHarness.flush();
  assert.equal(shell.tab.containerEl.querySelectorAll(".review-generation").length, 0); assert.ok(shell.tab.containerEl.querySelector('[data-module="review"] [role="checkbox"]'));
  shell.plugin.settings.pdfReading.enabled = true; shell.plugin.settings.englishDiary.enabled = true; shell.plugin.settings.lifestyle.finance.enabled = true;
  for (const module of ["knowledge", "journal", "review", "todo", "selection", "finance", "english", "pdf"]) shell.state.desktopModuleExpanded.add(module);
  shell.state.renderSettingsContent();
  assert.equal(shell.tab.containerEl.querySelectorAll(".echoink-module-drawer.is-expanded").length, 8);
  assert.equal(shell.tab.containerEl.querySelectorAll(".echoink-journal-modal-actions,.review-generation").length, 0);
  assert.equal(shell.tab.containerEl.querySelectorAll('.echoink-module-drawer-content [role="switch"]').length, 0);
  change(input(shell.tab.containerEl, "MinerU 专用 Token"), "unsaved-token-draft"); shell.state.renderSettingsContent(); assert.equal(input(shell.tab.containerEl, "MinerU 专用 Token").value, "unsaved-token-draft");
  shell.tab.openDesktopRoute({ tab: "modules", focus: "selection-ask:settings" }); await documentHarness.flush();
  buttons(shell.tab.containerEl, "编辑").click(); const retainedTemplate = input(shell.tab.containerEl, "提问模板"); change(retainedTemplate, "保留壳重绘草稿");
  shell.state.renderSettingsContent(); assert.equal(input(shell.tab.containerEl, "提问模板"), retainedTemplate); assert.equal(retainedTemplate.value, "保留壳重绘草稿");
  await shell.state.activateSettingsTab("models", true); assert.ok(shell.tab.containerEl.querySelector(".echoink-settings-inline-confirm")); buttons(shell.tab.containerEl, "继续编辑").click(); assert.equal(retainedTemplate.value, "保留壳重绘草稿");
  await shell.state.activateSettingsTab("models", true); buttons(shell.tab.containerEl, "放弃修改").click(); await documentHarness.flush(); assert.equal(shell.state.activeSettingsTab(), "models");
  shell.tab.openDesktopRoute(runtime.resolveDesktopSettingsSearchRoute("modules", "待办分类")); await documentHarness.flush(); assert.equal(shell.state.settingsDetail, "todo-categories");
  assert.equal(runtime.openTestModals.length, 0);
  shell.tab.openDesktopRoute({ tab: "modules", focus: "selection-ask:settings" }); await documentHarness.flush(); buttons(shell.tab.containerEl, "编辑").click(); change(input(shell.tab.containerEl, "提问模板"), "关闭保留草稿");
  shell.plugin.app.setting = { open() {}, openTabById() { shell.tab.display(); }, close() { shell.tab.hide(); } };
  shell.tab.hide(); await documentHarness.flush(); assert.ok(shell.tab.containerEl.querySelector(".echoink-settings-inline-confirm")); buttons(shell.tab.containerEl, "继续编辑").click(); assert.equal(input(shell.tab.containerEl, "提问模板").value, "关闭保留草稿");
  shell.tab.hide(); await documentHarness.flush(); buttons(shell.tab.containerEl, "放弃修改").click(); await documentHarness.flush(); assert.equal(shell.state.settingsVisible, false);
  shell.tab.hide(); shell.registrations.forEach((dispose: () => void) => dispose());
  for (const kind of ["selection", "initialization", "preferences"]) {
    const independent = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://settings-window.invalid" });
    const child = independent.window as any;
    const childHarness = runtime.prepareDocument(child);
    const native = runtime.fixture(child, "zh-CN");
    Object.assign(native.plugin.app.vault, { getMarkdownFiles: () => [], getRoot: () => ({ children: [] }), getAllFolders: () => [], getAbstractFileByPath: () => null, on: () => ({}), offref() {} });
    native.plugin.app.workspace = { containerEl: document.body };
    native.plugin.getKnowledgeSurfaceService = () => null;
    native.state.desktopRoute = { tab: "modules" };
    if (kind === "selection") native.state.settingsDetail = "selection-ask";
    else if (kind === "preferences") {
      native.state.settingsDetail = "knowledge-preferences"; native.state.knowledgePreferenceLoadError = null;
      native.state.knowledgePreferenceState = { state: "custom", revision: "fixture-revision", content: "原偏好" };
      native.state.knowledgePreferenceEditor = { savedState: "custom", expectedRevision: "fixture-revision", savedContent: "原偏好", draftContent: "未提交偏好草稿", saving: false, error: null };
    }
    let definitions = runtime.mountDefinitions(native.tab); await childHarness.flush();
    if (kind === "selection") { buttons(native.tab.containerEl, "编辑").click(); change(input(native.tab.containerEl, "提问模板"), "原生定义清理前的草稿"); }
    else if (kind === "initialization") {
      const knowledge = native.state.ensureDesktopKnowledge(); knowledge.page = "initialize"; knowledge.mode = "existing"; knowledge.draft = knowledge.bindings(); knowledge.moduleDraft = { journal: "未提交目录草稿" };
      native.state.renderSettingsContent(); await childHarness.flush();
    }
    let closing = false, reopenCount = 0;
    native.plugin.app.setting = {
      open() { assert.equal(closing, false, "reopen must wait for the host's close cycle"); reopenCount++; },
      openTabById() { definitions = runtime.mountDefinitions(native.tab); },
      close() { closing = true; definitions.cleanup(); native.tab.hide(); queueMicrotask(() => { closing = false; }); }
    };
    native.plugin.app.setting.close();
    assert.equal(native.state.preserveDesktopCloseDraft, true, `${kind}: definition cleanup must retain dirty state before hide`);
    assert.equal(native.state.desktopCloseReopenTimer.owner, win, "use the main workspace timer rather than the closing settings window");
    await childHarness.flush(); assert.equal(reopenCount, 1); assert.ok(native.tab.containerEl.querySelector(".echoink-settings-inline-confirm")); assert.equal(runtime.openTestModals.length, 0);
    buttons(native.tab.containerEl, "继续编辑").click();
    if (kind === "selection") assert.equal(input(native.tab.containerEl, "提问模板").value, "原生定义清理前的草稿");
    else if (kind === "initialization") assert.equal(native.state.desktopKnowledge.moduleDraft.journal, "未提交目录草稿");
    else assert.equal(native.state.knowledgePreferenceEditor.draftContent, "未提交偏好草稿");
    native.plugin.app.setting.close(); await childHarness.flush();
    buttons(native.tab.containerEl, kind === "preferences" ? "舍弃修改" : "放弃修改").click(); await childHarness.flush();
    assert.equal(reopenCount, 2); assert.equal(native.state.settingsVisible, false); assert.equal(native.state.desktopSelection, null); assert.equal(native.state.desktopKnowledge, null);
    if (kind === "selection") {
      native.state.settingsDetail = "selection-ask"; definitions = runtime.mountDefinitions(native.tab); await childHarness.flush();
      buttons(native.tab.containerEl, "编辑").click(); change(input(native.tab.containerEl, "提问模板"), "卸载时清理草稿");
      native.plugin.app.setting.close(); native.registrations.forEach((dispose: () => void) => dispose()); await childHarness.flush();
      assert.equal(reopenCount, 2, "plugin unload must cancel an already scheduled reopen"); assert.equal(native.state.desktopCloseReopenTimer, null); assert.equal(native.state.desktopSelection, null); assert.equal(native.state.desktopKnowledge, null);
      native.tab.hide(); await childHarness.flush(); assert.equal(reopenCount, 2, "hide after plugin unload must not reopen");
    } else native.registrations.forEach((dispose: () => void) => dispose());
    independent.window.close();
  }
  console.log("PASS modules-settings: real drawers/panels, permissions, row drafts/IME/rollback/navigation guard, mobile 4-action preservation, catalog deletion/icon picker, template conflict, real settings-shell routing and draft retention");
} finally {
  runtime?.disposeOriginControls(document.body);
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  await rm(temporary, { recursive: true, force: true });
}
