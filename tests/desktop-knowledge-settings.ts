// Run: ECHOINK_MODULES_TEST_ROOT=<registered disposable root> node --experimental-strip-types tests/desktop-knowledge-settings.ts
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

const root = process.cwd();
const registered = path.join(homedir(), "EchoInk-TestVaults/90-任务临时/工作台P12自动测试-20261019");
assert.equal(process.env.ECHOINK_MODULES_TEST_ROOT, registered, "Use only the registered P12 test root");
const temporary = await mkdtemp(path.join(registered, "desktop-knowledge-"));
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
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)); };
const until = async (predicate: () => boolean, description: string) => {
  for (let index = 0; index < 100 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(predicate(), description);
};
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("unhandledRejection", onUnhandled);
let runtime: any;
const failures: string[] = [];
const run = async (name: string, callback: () => Promise<void>) => {
  try { await callback(); console.log(`PASS desktop-knowledge: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL desktop-knowledge: ${name}`, error); }
};

async function inventory(directory: string): Promise<string[]> {
  const items: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) items.push(`${item.name}/`, ...(await inventory(absolute)).map(child => `${item.name}/${child}`));
    else items.push(`${item.name}:${(await readFile(absolute)).toString("base64")}`);
  }
  return items.sort();
}

async function fixture(name: string) {
  const vaultRoot = path.join(temporary, name);
  const data = await runtime.nativeJournalFixture(vaultRoot);
  const { plugin, app } = data;
  plugin.settings.defaultPermission = "workspace-write";
  plugin.settings.journalDirectory = "日记";
  plugin.settings.review.outputDir = "复盘";
  plugin.settings.englishDiary.englishDirectory = "英文";
  plugin.settings.englishDiary.expressionDirectory = "表达";
  plugin.settings.pdfReading.originalDirectory = "PDF原件";
  const bindings = runtime.emptyKnowledgeFolderBindings();
  bindings.configured = true;
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["资料甲", "资料乙"], writePath: "资料乙" });
  Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["旧知识/甲", "旧知识/乙"], writePath: "旧知识/甲", compatibilityReadScopes: true });
  Object.assign(bindings.roles.projects, { enabled: true, readPaths: ["项目"], writePath: "项目" });
  Object.assign(bindings.roles.inbox, { enabled: true, readPaths: ["收件箱"], writePath: "收件箱" });
  plugin.settings.knowledgeBase.folderBindings = bindings;
  for (const directory of ["资料甲", "资料乙", "旧知识/甲", "旧知识/乙", "新知识", "项目", "收件箱", "日记", "复盘", "英文", "表达", "PDF原件"]) await data.write(`${directory}/保留.md`, `保留 ${directory}`);
  await data.write("未整理/新资料.md", "合成待整理来源");
  const release = runtime.registerKnowledgeFolderBindings(vaultRoot, () => plugin.settings.knowledgeBase.folderBindings);
  runtime.registerKnowledgePrivateRoot(vaultRoot, path.join(vaultRoot, "private-state"));
  const events = new EventEmitter();
  app.vault.on = (event: string, callback: (...args: any[]) => void) => { events.on(event, callback); return { event, callback }; };
  app.vault.offref = ({ event, callback }: any) => events.off(event, callback);
  app.vault.getAllFolders = () => app.vault.getAllLoadedFiles().filter((item: any) => item instanceof runtime.TFolder);
  app.keymap = { pushScope() {}, popScope() {} };
  const service = new runtime.EchoInkKnowledgeSurfaceService(plugin);
  plugin.getKnowledgeSurfaceService = () => service;
  await service.getInitializationState(); await service.linking.ready;
  const calls = { saves: 0, previews: 0, applies: 0, creates: 0, moves: 0, deletes: 0 };
  let failSave = false;
  plugin.saveSettings = async () => { calls.saves++; if (failSave) throw new Error("合成保存失败"); };
  for (const [owner, key, counter] of [[app.vault, "createFolder", "creates"], [app.fileManager, "renameFile", "moves"], [app.vault, "delete", "deletes"]] as const) {
    const original = owner[key].bind(owner);
    owner[key] = async (...args: any[]) => { calls[counter]++; return await original(...args); };
  }
  const realPreview = service.previewDirectoryPlan.bind(service), realApply = service.applyDirectoryPlan.bind(service);
  service.previewDirectoryPlan = async (...args: any[]) => { calls.previews++; return await realPreview(...args); };
  service.applyDirectoryPlan = async (...args: any[]) => { calls.applies++; return await realApply(...args); };
  const host = document.createElement("div"); host.className = "echoink-settings-demo"; document.body.appendChild(host);
  let view: any;
  const redraw = () => {
    view.suspend(); runtime.disposeOriginControls(host); host.replaceChildren();
    if (view.isDetail) view.renderDetail(host); else view.renderSummary(host);
  };
  view = new runtime.DesktopKnowledgeSettings(plugin, { redraw, openPreferences() {}, openLinking() {}, openEditor() {} });
  redraw(); await settle();
  const button = (text: string): HTMLButtonElement => {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === text || value.getAttribute("aria-label")?.startsWith(`${text}，`));
    assert(result, `button ${text}`); return result;
  };
  const field = (label: string): HTMLInputElement => { const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`); assert(element, `field ${label}`); return element; };
  const change = (label: string, value: string) => { const element = field(label); element.value = value; element.dispatchEvent(new win.Event("input", { bubbles: true })); };
  const initialize = async (mode: "existing" | "build") => {
    button("重新初始化").click();
    button(mode === "existing" ? "使用现有文件夹" : "帮我搭建").click();
    await until(() => !button("确认初始化").disabled || host.textContent!.includes("settings-error") || !!host.querySelector(".settings-error"), "initial preview settles");
  };
  return { ...data, root: vaultRoot, bindings, service, calls, events, host, view, redraw, button, field, change, initialize,
    failSave(value: boolean) { failSave = value; },
    async cleanup() { view.dispose(); runtime.disposeOriginControls(host); host.remove(); release(); await service.unload(); }
  };
}

try {
  const output = path.join(temporary, "knowledge-ui.mjs");
  await esbuild.build({ stdin: { contents: `
    export { Platform, TFolder } from "obsidian";
    export { DesktopKnowledgeSettings } from "./src/settings/desktop-knowledge-settings";
    export { EchoInkKnowledgeSurfaceService } from "./src/plugin/knowledge-surface-service";
    export { emptyKnowledgeFolderBindings, normalizeKnowledgeFolderBindings, knowledgeFolderBindingsSignature } from "./src/knowledge-base/folder-bindings";
    export { registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "./src/knowledge-base/root-paths";
    export { nativeJournalFixture } from "./src/tests/native-journal-fixture";
    export { disposeOriginControls } from "./src/settings/origin-controls";
    export { createSettingsNavigationRow, attachSettingsTooltip } from "./src/settings/settings-v2";
    export { runKnowledgeFolderActionsTests } from "./src/tests/knowledge-folder-actions";
  `, resolveDir: root, loader: "ts" }, outfile: output, bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: `import {createRequire as knowledgeUiRequire} from "node:module"; const require = knowledgeUiRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "knowledge-ui-host", setup(build: any) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, (args: any) => { if (args.path === "electron") return { path: args.path, external: true }; const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
    } }], logLevel: "silent"
  });
  runtime = await import(pathToFileURL(output).href); runtime.Platform.isDesktopApp = true;

  await run("desktop navigation exposes complete clipped values without replacing activation", async () => {
    const host = document.createElement("div"); host.className = "echoink-settings-demo echoink-settings-aligned"; document.body.appendChild(host);
    let activations = 0;
    try {
      const full = "项目/个人知识管理/EchoInk/资料与设计/长期研究";
      const row = runtime.createSettingsNavigationRow(host, { title: "完整设置名称", value: full, onActivate: () => { activations++; } });
      const value = row.querySelector(".echoink-settings-navigation-value")!;
      Object.defineProperties(value, { scrollWidth: { configurable: true, value: 300 }, clientWidth: { configurable: true, value: 100 } });
      assert.equal(row.getAttribute("aria-label"), `完整设置名称，${full}，进入`);
      assert.equal(row.hasAttribute("aria-describedby"), false, "the complete accessible label does not repeat the tooltip as a description");
      row.focus();
      assert.equal(host.querySelector('[role="tooltip"]:not([hidden])')?.textContent, full);
      assert.equal(row.querySelector('[role="tooltip"]'), null, "visible tooltip content stays outside the button label");
      row.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.equal(host.querySelector('[role="tooltip"]:not([hidden])'), null);
      row.dispatchEvent(new win.MouseEvent("mouseenter"));
      assert.equal(host.querySelector('[role="tooltip"]:not([hidden])')?.textContent, full);
      row.dispatchEvent(new win.MouseEvent("mouseleave"));
      assert.equal(host.querySelector('[role="tooltip"]:not([hidden])'), null);
      row.click(); row.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 0 }));
      assert.equal(activations, 2, "pointer and keyboard-style activation still navigate exactly once");
    } finally { runtime.disposeOriginControls(host); host.remove(); }
  });

  await run("short summaries preserve existing help and mobile navigation behavior", async () => {
    const host = document.createElement("div"); host.className = "echoink-settings-demo echoink-settings-aligned"; document.body.appendChild(host);
    let activations = 0;
    try {
      const row = runtime.createSettingsNavigationRow(host, { title: "已归档会话", value: "23", onActivate: () => { activations++; } });
      row.focus(); assert.equal(host.querySelector('[role="tooltip"]:not([hidden])'), null, "a fitting short value has no summary bubble");
      const help = row.querySelector(".echoink-settings-navigation-title")!.createSpan({ cls: "echoink-settings-help", attr: { "aria-hidden": "true" } });
      const activate = row.onclick; runtime.attachSettingsTooltip(row, "删除后无法恢复", help); row.onclick = activate;
      row.blur(); row.focus();
      assert.equal(document.getElementById(row.getAttribute("aria-describedby")!)?.textContent, "删除后无法恢复");
      row.click(); assert.equal(activations, 1);
      row.blur();
      runtime.Platform.isDesktopApp = false;
      const mobile = runtime.createSettingsNavigationRow(host, { title: "移动端设置", value: "完整移动摘要", valueDescription: "完整移动摘要及原值", onActivate() {} });
      assert.equal(mobile.classList.contains("has-value-summary"), false);
      assert.equal(mobile.getAttribute("aria-label"), "移动端设置，进入");
      assert.equal(mobile.querySelector('[role="tooltip"]'), null);
    } finally { runtime.Platform.isDesktopApp = true; runtime.disposeOriginControls(host); host.remove(); }
  });

  await run("purpose summaries keep the total visible and detail paths complete", async () => {
    const f = await fixture("purpose-summary");
    try {
      const first = "项目/个人知识管理产品/EchoInk/设计资料与竞品研究/需要完整保留的长目录名称";
      await f.write(`${first}/保留.md`, "合成长路径资料");
      Object.assign(f.plugin.settings.knowledgeBase.folderBindings.roles.raw, { readPaths: [first, "资料甲", "资料乙"], writePath: "资料乙" });
      f.redraw();
      const row = f.host.querySelector<HTMLButtonElement>('[data-echoink-focus-key="knowledge:directory:raw"]')!;
      assert.equal(row.querySelector(".echoink-settings-navigation-value")?.textContent, first);
      assert.equal(row.querySelector(".echoink-settings-navigation-value-suffix")?.textContent, "等 3 个");
      assert.equal(row.getAttribute("aria-label"), `资料来源，${first}、资料甲、资料乙，进入`);
      row.focus();
      assert.equal(f.host.querySelector('[role="tooltip"]:not([hidden])')?.textContent, `${first}、资料甲、资料乙`);
      row.click();
      assert.equal(f.host.querySelector(".echoink-knowledge-source-path")?.textContent, first, "detail path is not shortened by summary generation");
      assert.equal(f.host.querySelectorAll(".echoink-knowledge-source").length, 3);
      assert.deepEqual([f.calls.saves, f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("purpose help and actions match the confirmed rows without intercepting navigation", async () => {
    const f = await fixture("purpose-actions");
    try {
      f.plugin.settings.knowledgeBase.folderBindings.roles.inbox.enabled = false;
      f.redraw();
      const purpose = (role: string) => f.host.querySelector<HTMLButtonElement>(`[data-echoink-focus-key="knowledge:directory:${role}"]`)!;
      const raw = purpose("raw"), wiki = purpose("wiki"), inbox = purpose("inbox");
      assert(raw.querySelector(".echoink-settings-navigation-icon"));
      assert.equal(wiki.querySelector(".echoink-settings-navigation-action")?.textContent, "更改");
      assert.equal(wiki.querySelector(".echoink-settings-navigation-icon"), null);
      assert.equal(inbox.querySelector(".echoink-settings-navigation-value")?.textContent, "未启用");
      assert.equal(inbox.querySelector(".echoink-settings-navigation-action")?.textContent, "选择");
      assert.equal(inbox.querySelector(".echoink-settings-navigation-icon"), null);
      assert.equal(raw.querySelector(".echoink-knowledge-purpose-commands")?.textContent, "/ask /maintain 召回");
      assert.equal(inbox.querySelector(".echoink-knowledge-purpose-commands")?.textContent, "召回");
      const help = raw.querySelector<HTMLElement>(".echoink-settings-navigation-help")!;
      assert.equal(help.getAttribute("tabindex"), "0");
      assert.equal(raw.querySelector("button"), null, "purpose help never nests another button");
      raw.dispatchEvent(new win.MouseEvent("mouseenter"));
      help.dispatchEvent(new win.MouseEvent("mouseenter"));
      assert.equal(f.host.querySelectorAll('[role="tooltip"]:not([hidden])').length, 1, "purpose explanation replaces the visible summary bubble");
      help.focus();
      assert.equal(document.activeElement, help);
      assert.equal(document.getElementById(help.getAttribute("aria-describedby")!)?.textContent, "保存原始收藏和材料，网页、公众号、PDF 都放这里");
      help.click();
      for (const key of ["Enter", " "]) help.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      assert.equal(f.view.isDetail, false, "pointer and keyboard help do not navigate");
      help.blur(); raw.click();
      assert.equal(f.view.isDetail, true, "the surrounding row still navigates");
      assert.equal(f.calls.saves, 0);
    } finally { await f.cleanup(); }
  });

  await run("invalid enabled purpose retains an untruncated failure marker", async () => {
    const f = await fixture("purpose-invalid");
    try {
      const missing = "不存在的项目/必须完整保留在详情中的目录名称";
      Object.assign(f.plugin.settings.knowledgeBase.folderBindings.roles.projects, { enabled: true, readPaths: [missing], writePath: missing });
      f.redraw();
      const row = f.host.querySelector<HTMLButtonElement>('[data-echoink-focus-key="knowledge:directory:projects"]')!;
      assert.equal(row.querySelector(".echoink-settings-navigation-value")?.textContent, missing);
      assert(row.querySelector(".echoink-settings-navigation-value-suffix")?.textContent?.includes("原目录已失效"));
      assert(!row.textContent?.includes("未启用"));
      assert.equal(row.querySelector(".echoink-settings-navigation-action")?.textContent, "更改");
      assert.equal(f.calls.saves, 0);
    } finally { await f.cleanup(); }
  });

  await run("refinement summary reads real default and customized states", async () => {
    const f = await fixture("preference-summary");
    try {
      let state = "custom", fails = false;
      f.plugin.getEchoInkKnowledgeMaintenancePreferenceState = async () => { if (fails) throw new Error("合成读取失败"); return { state }; };
      const row = () => f.host.querySelector<HTMLButtonElement>('[data-echoink-focus-key="knowledge:preferences"]')!;
      f.redraw(); await settle();
      assert.equal(row().querySelector(".echoink-settings-navigation-description")?.textContent, "关注维度、颗粒度、组织方式");
      assert.equal(row().querySelector(".echoink-settings-navigation-value")?.textContent, "已自定义");
      assert(row().getAttribute("aria-label")?.includes("已自定义"));
      state = "default"; f.redraw(); await settle();
      assert.equal(row().querySelector(".echoink-settings-navigation-value")?.textContent, "使用默认");
      fails = true; f.redraw(); await settle();
      assert(row().querySelector(".echoink-settings-navigation-description")?.textContent?.includes("知识提炼偏好读取失败"));
      assert.equal(row().querySelector(".echoink-settings-navigation-value"), null);
      assert.equal(f.calls.saves, 0);
    } finally { await f.cleanup(); }
  });

  await run("folder management keeps confirmed order and live restore summaries", async () => {
    const host = document.createElement("div"); host.className = "echoink-settings-demo echoink-settings-aligned"; document.body.appendChild(host);
    try { await runtime.runKnowledgeFolderActionsTests(host, win); }
    finally { runtime.disposeOriginControls(host); host.remove(); }
  });

  await run("confirmation is the first mutation and existing mode retains legacy scopes", async () => {
    const f = await fixture("existing");
    try {
      const before = await inventory(f.root), wiki = runtime.normalizeKnowledgeFolderBindings(f.plugin.settings.knowledgeBase.folderBindings).roles.wiki;
      await f.initialize("existing");
      assert.deepEqual(f.calls, { saves: 0, previews: 1, applies: 0, creates: 0, moves: 0, deletes: 0 });
      assert.deepEqual(await inventory(f.root), before);
      assert.equal(f.field("初始化知识成果").value, "旧知识/甲");
      assert(f.host.textContent.includes("将新建 0 个文件夹 · 移动 0 个文件"));
      f.button("确认初始化").click();
      await until(() => !f.view.isDetail && !f.view.submitting, "existing apply completes");
      assert.equal(f.calls.applies, 1);
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles.wiki, wiki);
      assert.deepEqual(await inventory(f.root), before, "using existing paths does not change original files");
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("native journal and templates replace retired shared paths only in initialization", async () => {
    const f = await fixture("native-owners");
    try {
      await f.write("原生日记/保留.md", "原生日记内容"); await f.write("原生模板/保留.md", "原生模板内容");
      f.records["daily-notes"].enabled = true; f.records["daily-notes"].instance.options = { folder: "原生日记", format: "YYYY-MM-DD" };
      f.records.templates.enabled = true; f.records.templates.instance.options = { folder: "原生模板" };
      const bindings = f.plugin.settings.knowledgeBase.folderBindings;
      Object.assign(bindings.roles.journal, { enabled: true, readPaths: ["已退役日记"], writePath: "已退役日记" });
      Object.assign(bindings.roles.templates, { enabled: true, readPaths: ["已退役模板"], writePath: "已退役模板" });
      const before = await inventory(f.root), wiki = runtime.normalizeKnowledgeFolderBindings(bindings).roles.wiki;
      await f.initialize("existing");
      assert.equal(f.button("确认初始化").disabled, false);
      assert.equal(f.field("初始化日记").value, "原生日记");
      assert(!f.host.textContent.includes("已退役日记")); assert(!f.host.textContent.includes("已退役模板"));
      assert.deepEqual(await inventory(f.root), before, "native ownership projection is preview-only before confirmation");
      assert.deepEqual([f.calls.saves, f.calls.applies, f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0, 0, 0]);
      f.button("确认初始化").click(); await until(() => !f.view.submitting && !f.view.isDetail, "native owner initialization completes");
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles.journal.readPaths, ["原生日记"]);
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles.templates.readPaths, ["原生模板"]);
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles.wiki, wiki);
      assert.deepEqual(await inventory(f.root), before, "native folders and existing notes are never created or moved");
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("checkbox failures return to the latest successful saved value", async () => {
    const f = await fixture("checkbox-rollback");
    try {
      const before = await inventory(f.root);
      assert.equal(f.field("自动补链").checked, true);
      f.field("自动补链").click(); await settle();
      assert.equal(f.plugin.settings.knowledgeBase.autoLinkEnabled, false); assert.equal(f.field("自动补链").checked, false);
      f.failSave(true); f.field("自动补链").click(); await settle();
      assert.equal(f.plugin.settings.knowledgeBase.autoLinkEnabled, false); assert.equal(f.field("自动补链").checked, false, "rollback uses the most recent accepted value");
      assert.deepEqual(await inventory(f.root), before);
      assert.deepEqual([f.calls.applies, f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("directory permissions stay with their source and retrieval does not grant organization", async () => {
    const f = await fixture("source-permissions");
    try {
      const before = await inventory(f.root);
      f.button("资料来源").click();
      const entries = [...f.host.querySelectorAll<HTMLElement>(".echoink-knowledge-source")];
      assert.equal(entries.length, 2);
      for (const [index, entry] of entries.entries()) {
        const folder = ["资料甲", "资料乙"][index];
        assert.equal(entry.querySelector(".echoink-knowledge-source-path")?.textContent, folder);
        assert(entry.querySelector('[aria-label="允许 Agent 自动整理"]'));
        assert(entry.querySelector(`[aria-label="解绑 ${folder}"]`));
      }
      (entries[0].querySelector('[role="checkbox"]') as HTMLButtonElement).click(); await settle();
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles.raw.autoOrganizePaths, ["资料甲"]);
      f.failSave(true); (entries[1].querySelector('[role="checkbox"]') as HTMLButtonElement).click(); await settle();
      assert.equal((entries[1].querySelector('[role="checkbox"]') as HTMLInputElement).checked, false);
      f.failSave(false); f.field("允许 Agent 检索这些资料").click(); await settle();
      const raw = f.plugin.settings.knowledgeBase.folderBindings.roles.raw;
      assert.equal(raw.searchEnabled, false);
      assert.deepEqual(raw.readPaths, ["资料甲", "资料乙"]); assert.equal(raw.writePath, "资料乙");
      assert.deepEqual(raw.autoOrganizePaths, ["资料甲"], "retrieval does not change per-directory organization grants");
      const retrieval = f.field("允许 Agent 检索这些资料").closest(".setting-item")!;
      assert(retrieval.querySelector(".setting-item-name > .echoink-settings-help-trigger")?.getAttribute("aria-label")?.includes("你主动 @ 引用或提交到聊天的内容除外"));
      assert.deepEqual(await inventory(f.root), before);
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("default save rollback, single-source visibility and empty-source recovery preserve files", async () => {
    const f = await fixture("source-save-location");
    try {
      const before = await inventory(f.root), pdf = f.plugin.settings.pdfReading.originalDirectory;
      const collections = structuredClone(f.plugin.settings.knowledgeBase.folderBindings.collectionTargets);
      f.button("资料来源").click();
      assert.deepEqual([...f.host.querySelectorAll(".echoink-settings-section-header h3")].map(item => item.textContent), ["文件夹", "资料检索", "保存位置"]);
      const select = f.field("资料默认保存到");
      select.value = "资料甲"; select.dispatchEvent(new win.Event("change", { bubbles: true })); await settle();
      assert.equal(f.plugin.settings.knowledgeBase.folderBindings.roles.raw.writePath, "资料甲");
      f.failSave(true); select.value = "资料乙"; select.dispatchEvent(new win.Event("change", { bubbles: true })); await settle();
      assert.equal(select.value, "资料甲", "failed selection returns to the latest successful choice");
      assert.equal(f.plugin.settings.knowledgeBase.folderBindings.roles.raw.writePath, "资料甲");
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.collectionTargets, collections);
      assert.equal(f.plugin.settings.pdfReading.originalDirectory, pdf);
      f.failSave(false); f.field("解绑 资料甲").click(); f.button("确认解绑").click(); await settle();
      assert.equal(f.plugin.settings.knowledgeBase.folderBindings.roles.raw.writePath, "资料乙");
      assert.equal(f.host.querySelector('[aria-label="资料默认保存到"]'), null);
      f.field("解绑 资料乙").click(); f.button("确认解绑").click(); await settle();
      assert(f.host.textContent!.includes("还没有资料来源"));
      assert.equal(f.host.querySelector('[aria-label="允许 Agent 检索这些资料"]'), null);
      f.field("添加来源目录").click(); f.button("资料甲").click(); await settle();
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles.raw.readPaths, ["资料甲"]);
      assert.equal(f.host.querySelectorAll(".echoink-knowledge-source").length, 1);
      assert.deepEqual(await inventory(f.root), before);
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("role details retain replacement and one unbind action per directory", async () => {
    const f = await fixture("role-entries");
    try {
      for (const [role, title] of [["wiki", "知识成果"], ["projects", "项目"], ["inbox", "收件箱"]] as const) {
        f.button(title).click();
        const binding = f.plugin.settings.knowledgeBase.folderBindings.roles[role];
        const entries = [...f.host.querySelectorAll<HTMLElement>(".echoink-knowledge-source")];
        assert.equal(entries.length, binding.readPaths.length);
        assert(f.button("更改文件夹"));
        assert.equal(f.host.querySelectorAll(".echoink-knowledge-source-unbind").length, entries.length);
        assert.equal([...f.host.querySelectorAll("button")].filter(button => button.textContent?.trim() === "解绑文件夹").length, 0);
        (entries[0].querySelector('[role="checkbox"]') as HTMLButtonElement).click(); await settle();
        assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles[role].autoOrganizePaths, [binding.readPaths[0]]);
        f.button("返回模块").click();
      }
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("build edits invalidate old preview and moving requires explicit confirmation", async () => {
    const f = await fixture("build");
    try {
      const before = await inventory(f.root);
      await f.initialize("build");
      assert.equal(f.calls.applies, 0); assert.deepEqual(await inventory(f.root), before);
      f.change("初始化资料来源", "新资料");
      assert(f.button("确认初始化").disabled);
      f.button("确认初始化").click(); assert.equal(f.calls.applies, 0);
      f.button("重新核对").click();
      await until(() => !f.button("确认初始化").disabled, "edited preview settles");
      assert(f.host.textContent.includes("新建 新资料"));
      assert.deepEqual(await inventory(f.root), before, "new paths are not created by preview");
      f.button("确认初始化").click();
      await until(() => !f.view.isDetail && !f.view.submitting, "build apply completes");
      assert(f.calls.creates > 0 && f.calls.moves > 0);
      assert.equal(f.calls.deletes, 0);
      assert.equal(await readFile(path.join(f.root, "旧知识/甲/保留.md"), "utf8"), "保留 旧知识/甲");
      assert.equal(await readFile(path.join(f.root, "旧知识/乙/保留.md"), "utf8"), "保留 旧知识/乙");
      assert.equal(await readFile(path.join(f.root, "新资料/未整理/新资料.md"), "utf8"), "合成待整理来源");
    } finally { await f.cleanup(); }
  });

  await run("changed Vault events and settings reject old plans before writes", async () => {
    const f = await fixture("stale");
    try {
      await f.initialize("build");
      f.events.emit("modify", { path: "未整理/新资料.md" });
      assert(f.button("确认初始化").disabled);
      f.button("确认初始化").click(); assert.equal(f.calls.applies, 0);
      f.button("重新核对").click(); await until(() => !f.button("确认初始化").disabled, "rechecked plan ready");
      const before = await inventory(f.root);
      f.plugin.settings.review.outputDir = "外部新配置";
      f.button("确认初始化").click();
      await until(() => !f.view.submitting, "stale settings rejection settles"); await settle();
      assert.deepEqual(await inventory(f.root), before);
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes, f.calls.saves], [0, 0, 0, 0]);
      assert(f.host.textContent.includes("设置已变化"), "stale-plan error remains visible");
      assert(f.view.hasDraft); assert(f.button("确认初始化").disabled);
    } finally { await f.cleanup(); }
  });

  await run("continue editing retains drafts and discard is required to leave", async () => {
    const f = await fixture("leave");
    try {
      const before = await inventory(f.root);
      await f.initialize("existing");
      f.change("初始化复盘输出", "未确认草稿");
      let leaves = 0;
      f.view.requestLeave(() => { leaves++; f.redraw(); });
      assert.equal(leaves, 0); assert(f.host.textContent.includes("还有未确认"));
      f.button("继续编辑").click(); await settle();
      assert(f.view.hasDraft); assert.equal(f.field("初始化复盘输出").value, "未确认草稿");
      f.redraw(); await settle();
      assert.equal(f.host.querySelector(".echoink-settings-inline-confirm"), null, "cancelled leave does not reappear on redraw");
      f.view.requestLeave(() => { leaves++; f.redraw(); });
      f.button("放弃修改").click(); await settle();
      assert.equal(leaves, 1); assert.equal(f.view.hasDraft, false); assert.equal(f.view.isDetail, false);
      assert.deepEqual(await inventory(f.root), before);
      assert.deepEqual([f.calls.saves, f.calls.applies, f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("binding save failure rolls back and reports an inline error", async () => {
    const f = await fixture("binding-failure");
    try {
      const before = await inventory(f.root), old = runtime.knowledgeFolderBindingsSignature(f.plugin.settings.knowledgeBase.folderBindings);
      const errorsBefore = unhandled.length;
      f.failSave(true);
      f.button("资料来源").click();
      f.field("解绑 资料甲").click(); f.button("确认解绑").click(); await settle();
      assert.equal(runtime.knowledgeFolderBindingsSignature(f.plugin.settings.knowledgeBase.folderBindings), old);
      assert.deepEqual(await inventory(f.root), before);
      assert(f.host.textContent.includes("绑定未保存"), "unbind failure is visible without leaving and reopening");
      assert.equal(unhandled.length, errorsBefore, "unbind failure does not become an unhandled rejection");
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  await run("role rebinding keeps old notes and failed picker changes keep old binding", async () => {
    const f = await fixture("rebind");
    try {
      const before = await inventory(f.root), old = runtime.knowledgeFolderBindingsSignature(f.plugin.settings.knowledgeBase.folderBindings);
      f.failSave(true); f.button("知识成果").click(); f.button("更改文件夹").click(); f.button("新知识").click(); await settle();
      assert.equal(runtime.knowledgeFolderBindingsSignature(f.plugin.settings.knowledgeBase.folderBindings), old);
      assert(f.host.textContent.includes("绑定未保存")); assert(f.view.isDetail);
      f.failSave(false); f.button("新知识").click(); await until(() => !f.view.submitting && !f.view.isDetail, "rebind succeeds");
      assert.deepEqual(f.plugin.settings.knowledgeBase.folderBindings.roles.wiki.readPaths, ["新知识"]);
      assert.deepEqual(await inventory(f.root), before);
      assert.deepEqual([f.calls.creates, f.calls.moves, f.calls.deletes], [0, 0, 0]);
    } finally { await f.cleanup(); }
  });

  assert.deepEqual(failures, [], `Failed desktop knowledge scenarios: ${failures.join(", ")}`);
  assert.deepEqual(unhandled, [], "all UI failure paths handle their asynchronous errors");
} finally {
  process.off("unhandledRejection", onUnhandled);
  runtime?.disposeOriginControls(document.body);
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  await rm(temporary, { recursive: true, force: true });
}
