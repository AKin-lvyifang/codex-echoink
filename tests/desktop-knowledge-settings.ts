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
    const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === text || value.querySelector(".echoink-settings-navigation-title")?.textContent === text);
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
