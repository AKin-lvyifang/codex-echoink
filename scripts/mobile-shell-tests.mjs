import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await esbuild.build({ entryPoints: ["tests/mobile-shell/entry.ts"], bundle: true, write: false,
  platform: "browser", format: "cjs", external: ["obsidian"], metafile: true, logLevel: "silent" });
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://fixture.example" });
const { window } = dom, { document } = window;
window.HTMLElement.prototype.createDiv = function(options = {}) {
  const element = this.ownerDocument.createElement("div"); element.className = options.cls ?? ""; this.append(element); return element;
};
const observers = new Set();
class ResizeObserver {
  constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); }
  observe(target) { this.targets.add(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
  unobserve(target) { this.targets.delete(target); }
}
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, window, document,
  HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, ResizeObserver,
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  console, setTimeout, clearTimeout, require: name => {
    assert.equal(name, "obsidian", `Unexpected mobile dependency: ${name}`);
    return { setIcon: (element, icon) => { element.dataset.icon = icon; } };
  } });
const api = module.exports;
let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`OK ${name}`); }
const flush = () => new Promise(resolve => setTimeout(resolve, 35));
function root(width = 390) {
  const element = document.createElement("main"); document.body.append(element);
  let currentWidth = width;
  Object.defineProperty(element, "clientWidth", { get: () => currentWidth });
  element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: currentWidth, bottom: 600, width: currentWidth, height: 600 });
  element.resize = value => {
    currentWidth = value;
    for (const observer of [...observers]) if (observer.targets.has(element)) observer.callback([{ target: element, contentRect: element.getBoundingClientRect() }]);
    window.dispatchEvent(new window.Event("resize"));
  };
  return element;
}
function page(id, extra = {}) {
  const content = document.createElement("div"), input = document.createElement("textarea");
  input.setAttribute("aria-label", `${id} draft`); content.append(input);
  return { id, title: `<${id}>`, content, input, ...extra };
}

for (const name of ["IPhoneShell", "IPadShell"]) {
  const Shell = api[name];
  await test(`${name}: route return preserves exact input, draft, selection, scroll and focus`, async () => {
    const element = root(), first = page("first"), shell = new Shell(element); shell.mount(first);
    first.input.value = "未发送的中文草稿"; first.input.focus(); first.input.setSelectionRange(2, 5);
    const scroll = first.content.closest(".scroll, .echoink-ipad-content"); assert.ok(scroll); scroll.scrollTop = 125;
    assert.equal(await shell.push(page("second")), true); assert.equal(shell.activePageId, "second");
    assert.ok(first.input.isConnected); assert.equal(await shell.back(), true);
    assert.equal(first.input.value, "未发送的中文草稿"); assert.equal(first.input.selectionStart, 2);
    assert.equal(scroll.scrollTop, 125); assert.equal(document.activeElement, first.input);
    assert.equal(element.querySelectorAll("h1").length, 1); assert.equal(element.querySelector("h1").textContent, "<first>");
    shell.dispose(); element.remove();
  });
  await test(`${name}: saving form rejects navigation and restores after rejected async save`, async () => {
    const errors = [], element = root(), first = page("saving", { canLeave: () => false });
    const shell = new Shell(element, { onError: error => errors.push(String(error)) }); shell.mount(first);
    first.input.value = "必须保留";
    assert.equal(await shell.push(page("blocked")), false); assert.equal(shell.activePageId, "saving");
    first.canLeave = async () => { throw new Error("save failed"); };
    assert.equal(await shell.push(page("failed")), false); assert.equal(first.input.value, "必须保留"); assert.equal(errors.length, 1);
    first.canLeave = () => true; assert.equal(await shell.push(page("accepted")), true);
    shell.dispose(); element.remove();
  });
  await test(`${name}: duplicate navigation and late leave results cannot pop twice or revive a disposed pane`, async () => {
    let release; const element = root(), shell = new Shell(element), first = page("first"); shell.mount(first);
    first.canLeave = () => new Promise(resolve => { release = resolve; });
    const moving = shell.push(page("second")); await Promise.resolve();
    assert.equal(await shell.push(page("third")), false);
    shell.dispose(); release(true); assert.equal(await moving, false); assert.equal(element.childElementCount, 0);
    element.remove();
  });
  await test(`${name}: sheet Escape closes only the sheet and preserves the composer node`, async () => {
    const element = root(), shell = new Shell(element), first = page("root"); shell.mount(first);
    const child = page("detail"); await shell.push(child); child.input.value = "正在输入"; child.input.focus();
    const content = document.createElement("div"); content.append(document.createElement("input"));
    shell.openSheet({ title: "选择模型", content });
    const dialog = element.querySelector("[role=dialog]"); assert.ok(dialog);
    assert.ok(child.input.isConnected); assert.equal(child.input.value, "正在输入");
    const focusables = dialog.querySelectorAll("button,input");
    focusables[focusables.length - 1].focus();
    focusables[focusables.length - 1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(document.activeElement, focusables[0]);
    dialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(element.querySelector("[role=dialog]"), null); assert.equal(shell.activePageId, "detail");
    assert.equal(document.activeElement, child.input); assert.equal(await shell.back(), true); assert.equal(shell.activePageId, "root");
    shell.dispose(); element.remove();
  });
  await test(`${name}: replace and dispose release page resources once, without touching a sibling`, async () => {
    let count = 0; const element = root(), sibling = root(), other = new Shell(sibling); other.mount(page("other"));
    const shell = new Shell(element); shell.mount(page("old", { dispose: () => { count++; } }));
    await shell.replace(page("new", { dispose: () => { count++; } })); assert.equal(count, 1);
    shell.dispose(); shell.dispose(); assert.equal(count, 2); assert.equal(other.activePageId, "other");
    other.dispose(); element.remove(); sibling.remove();
  });
  await test(`${name}: same-route replacement accepts fresh nodes; duplicate routes and reused slots keep the old page`, async () => {
    let disposed = 0;
    const element = root(), shell = new Shell(element), first = page("root");
    shell.mount(first);
    const loading = page("detail", { dispose: () => { disposed++; } });
    await shell.push(loading);
    const ready = page("detail"); ready.input.value = "加载后的真实内容";
    assert.equal(await shell.replace(ready), true); assert.equal(disposed, 1);
    assert.equal(loading.content.isConnected, false); assert.ok(ready.content.isConnected);
    assert.equal(await shell.push(page("root")), false);
    assert.equal(await shell.push({ ...ready, id: "reused" }), false);
    const overlapping = page("overlapping"); overlapping.footer = overlapping.input;
    assert.equal(await shell.push(overlapping), false);
    assert.equal(shell.activePageId, "detail"); assert.equal(ready.input.value, "加载后的真实内容");
    shell.dispose(); element.remove();
  });
  await test(`${name}: host reservation and keyboard occlusion are not double-counted; zoom and disposal are safe`, async () => {
    const previousHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const previousViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const previousStyle = window.getComputedStyle;
    const viewport = Object.assign(new window.EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    // jsdom has no layout engine. Only the probe's computed safe-area height is
    // supplied here; the production MobileViewport performs all compensation.
    window.getComputedStyle = element => element.classList.contains("echoink-mobile-bottom-probe")
      ? { height: "34px" } : previousStyle.call(window, element);
    const element = root(); let bottom = 810;
    element.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 390, bottom, width: 390, height: bottom });
    const shell = new Shell(element); shell.mount(page("viewport"));
    const compensation = () => element.style.getPropertyValue("--em-bottom-compensation");
    assert.equal(compensation(), "0px", "host already reserves the 34px safe area");
    bottom = 834; window.dispatchEvent(new window.Event("resize")); await flush();
    assert.equal(compensation(), "24px", "only the missing host reservation is added");
    bottom = 810; viewport.height = 500; viewport.dispatchEvent(new window.Event("resize")); await flush();
    assert.equal(compensation(), "310px", "keyboard overlay is measured against this pane");
    bottom = 500; window.dispatchEvent(new window.Event("resize")); await flush();
    assert.equal(compensation(), "0px", "an already-shrunk host needs no second keyboard inset");
    bottom = 810; viewport.scale = 2; viewport.height = 300; viewport.dispatchEvent(new window.Event("resize")); await flush();
    assert.equal(compensation(), "0px", "pinch zoom is not a keyboard");
    shell.dispose(); viewport.dispatchEvent(new window.Event("resize")); await flush();
    assert.equal(compensation(), ""); element.remove(); window.getComputedStyle = previousStyle;
    Object.defineProperty(window, "innerHeight", previousHeight);
    if (previousViewport) Object.defineProperty(window, "visualViewport", previousViewport); else delete window.visualViewport;
  });
}

await test("contained sheet replacement restores original pane focus and pre-existing accessibility state", () => {
  const element = root(), background = document.createElement("div"), input = document.createElement("textarea");
  background.append(input); element.append(background); background.setAttribute("aria-hidden", "false"); input.focus();
  const layer = new api.ContainedShellSheet(element, background);
  layer.open({ title: "first", content: document.createElement("input") });
  layer.open({ title: "second", content: document.createElement("input") });
  layer.close(); assert.equal(document.activeElement, input); assert.equal(background.getAttribute("aria-hidden"), "false");
  assert.equal(Boolean(background.inert), false); element.remove();
});

await test("iPad settings starts at narrow categories, caches each form and survives width changes", async () => {
  const element = root(500), calls = { a: 0, b: 0 }, pages = {};
  const categories = ["a", "b"].map(id => ({ id, label: id, icon: "bot", createPage: () => {
    calls[id]++; return pages[id] = page(id);
  } }));
  const shell = new api.IPadSettingsShell(element, categories); await shell.mount();
  assert.equal(calls.a, 0); await shell.selectCategory("a"); pages.a.input.value = "模型配置草稿";
  await shell.push(page("deep")); element.resize(900); await flush();
  assert.equal(shell.activePageId, "deep"); assert.equal(calls.a, 1);
  await shell.back(); assert.equal(pages.a.input.value, "模型配置草稿");
  await shell.selectCategory("b"); await shell.selectCategory("a"); assert.equal(calls.a, 1);
  assert.equal(pages.a.input.value, "模型配置草稿"); element.resize(420); await flush();
  await shell.back(); assert.ok(element.querySelector("[data-category-id='a'],[data-category='a'],nav button"));
  shell.dispose(); element.remove();
});
await test("iPad settings refuses changing categories during save and ignores a late factory after dispose", async () => {
  const element = root(900), first = page("a", { canLeave: () => false }); let release;
  const shell = new api.IPadSettingsShell(element, [
    { id: "a", label: "A", icon: "bot", createPage: () => first },
    { id: "b", label: "B", icon: "bot", createPage: () => new Promise(resolve => { release = resolve; }) }
  ]);
  await shell.mount("a"); assert.equal(await shell.selectCategory("b"), false); assert.equal(shell.activeCategoryId, "a");
  first.canLeave = () => true; const changing = shell.selectCategory("b");
  while (!release) await Promise.resolve();
  shell.dispose(); release(page("b")); assert.equal(await changing, false); assert.equal(element.childElementCount, 0); element.remove();
});
await test("iPad settings loads the first wide detail only once when expanding an untouched narrow root", async () => {
  const element = root(400); let count = 0;
  const shell = new api.IPadSettingsShell(element, [{ id: "a", label: "A", icon: "bot", createPage: () => { count++; return page("a"); } }]);
  await shell.mount(); element.resize(760); await flush(); assert.equal(count, 1);
  element.resize(759); element.resize(900); await flush(); assert.equal(count, 1); shell.dispose(); element.remove();
});

function workspace() {
  const leaves = [], center = {}, right = {}; let allowRight = true;
  const create = root => {
    let state = { type: "empty" }; const leaf = { getRoot: () => root, view: { getViewType: () => state.type },
      getViewState: () => state, async setViewState(value) { await Promise.resolve(); state = value; },
      async openFile(file) { state = { type: "markdown", state: { file: file.path } }; } };
    leaves.push(leaf); return leaf;
  };
  return { leaves, rootSplit: center, rightSplit: right, create,
    getLeavesOfType: type => leaves.filter(leaf => leaf.view.getViewType() === type),
    getLeaf: () => create(center), getRightLeaf: () => allowRight ? create(right) : null,
    iterateAllLeaves: action => leaves.forEach(action), revealLeaf: async leaf => { leaf.reveals = (leaf.reveals ?? 0) + 1; },
    refuseRight: () => { allowRight = false; } };
}
await test("iPad workspace concurrent settings opens reuse one central leaf without replacing the Agent or outline", async () => {
  const host = workspace(), outline = host.create(host.rightSplit); await outline.setViewState({ type: "outline" });
  const navigation = new api.IPadShellWorkspace(host);
  const agent = await navigation.openAgent(); const [first, second] = await Promise.all([navigation.openSettings(), navigation.openSettings()]);
  assert.equal(first, second); assert.equal(host.getLeavesOfType(api.IPAD_SHELL_SETTINGS_VIEW).length, 1);
  assert.equal(agent.getRoot(), host.rightSplit); assert.ok(host.leaves.includes(outline));
  const note = await navigation.openNote({ path: "合成笔记.md" }); assert.equal(await navigation.openNote({ path: "合成笔记.md" }), note);
  navigation.dispose(); await assert.rejects(navigation.openHome()); assert.ok(host.leaves.includes(agent));
});
await test("iPad missing native sidebar fails explicitly; phone opening stays central", async () => {
  const host = workspace(); host.refuseRight();
  await assert.rejects(new api.IPadShellWorkspace(host).openAgent(), /原生右侧栏/); assert.equal(host.leaves.length, 0);
  const phone = new api.IPhoneShellWorkspace(host); const [a, b] = await Promise.all([phone.open(), phone.open()]);
  assert.equal(a, b); assert.equal(a.getRoot(), host.rootSplit);
});

await test("new shell source is isolated from legacy pages, desktop runtime and production entry", async () => {
  const inputs = Object.keys(bundle.metafile.inputs);
  assert.ok(!inputs.some(input => /node_modules|mobile-ui\.ts|src\/main\.ts|pi-native/.test(input)));
  const production = JSON.parse(await fs.readFile(".tmp/mobile-production-metafile.json", "utf8"));
  assert.ok(!Object.keys(production.inputs).some(input => /ui\/(iphone|ipad)\/|mobile-shell|shell-workspace/.test(input)));
  for (const device of ["iphone", "ipad"]) {
    const files = await fs.readdir(`src/ui/${device}`);
    for (const file of files.filter(file => file.endsWith(".ts"))) {
      const source = await fs.readFile(`src/ui/${device}/${file}`, "utf8");
      assert.ok(!source.includes("isTablet")); assert.ok(!source.includes(`../${device === "iphone" ? "ipad" : "iphone"}`));
    }
  }
});

console.log(`Mobile shell checks: ${passed} passed`);
dom.window.close();
