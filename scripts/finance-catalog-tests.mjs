import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".tmp/finance-catalog-tests");
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.ECHOINK_JSDOM_PATH || "jsdom");
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
const win = dom.window;
for (const name of ["window", "document", "navigator", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
}
const create = function(tag, options = {}) {
  if (typeof options === "string") options = { cls: options };
  const element = this.ownerDocument.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.value !== undefined) element.value = options.value;
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  this.appendChild(element);
  return element;
};
Object.assign(win.Element.prototype, {
  createEl: create,
  createDiv(options) { return create.call(this, "div", options); },
  createSpan(options) { return create.call(this, "span", options); },
  empty() { this.replaceChildren(); },
  addClass(...names) { this.classList.add(...names); },
  removeClass(...names) { this.classList.remove(...names); },
  setText(text) { this.textContent = text; },
  setAttr(key, value) { this.setAttribute(key, value); },
  toggleClass(key, value) { this.classList.toggle(key, value); },
  hasClass(key) { return this.classList.contains(key); },
});
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const button = (container, label) => {
  const result = [...container.querySelectorAll("button")].find(element => element.textContent === label);
  assert.ok(result, `missing button: ${label}`);
  return result;
};
await mkdir(directory, { recursive: true });
try {
  const target = path.join(directory, "test.mjs");
  await esbuild.build({
    stdin: {
      contents: `export { FinanceCatalogPanel } from "./src/lifestyle/finance-catalog-dialog";
        export { LifestyleSettingsPanel } from "./src/lifestyle/settings-panel";
        export { LifestyleFinanceService } from "./src/lifestyle/finance-service";
        export { DEFAULT_LIFESTYLE_SETTINGS } from "./src/lifestyle/settings";
        export { openTestModals, openTestNoticeMessages } from "./src/tests/obsidian-shim";`,
      resolveDir: root, loader: "ts",
    },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: target,
    external: ["read-excel-file/node", "yaml", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
  });
  const api = await import(pathToFileURL(target).href);
  const modal = () => {
    assert.equal(api.openTestModals.length, 1, "one confirmation is open");
    return api.openTestModals[0];
  };
  const confirm = () => button(modal().contentEl, "删除").click();
  function fixture(kind = "accounts", withSettingsPanel = false) {
    const host = document.body.createDiv();
    const state = { paid: true, writes: 0, redraws: 0, failure: false, saving: null };
    const listeners = new Set();
    const access = {
      checkCapability: () => state.paid,
      requireCapability() { if (!state.paid) throw new Error("PRO_REQUIRED"); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const plugin = {
      app: {}, settings: { lifestyle: structuredClone(api.DEFAULT_LIFESTYLE_SETTINGS), homeModules: { finance: true } },
      async saveSettings() {
        state.writes++;
        if (state.saving) await state.saving;
        if (state.failure) throw new Error("SAVE_FAILED");
      },
    };
    const finance = plugin.settings.lifestyle.finance;
    finance.enabled = true;
    finance[kind] = ["保留", "待删除"].map(name => ({ name, aliases: [], active: true, icon: "package", color: "#5c8977" }));
    plugin.lifestyle = { finance: new api.LifestyleFinanceService({ plugin, store: {}, refresh() {} }, access), label: () => "财务" };
    const redraw = () => { state.redraws++; render(); };
    const panel = withSettingsPanel
      ? new api.LifestyleSettingsPanel(plugin, "finance", () => {}, redraw)
      : new api.FinanceCatalogPanel(plugin, kind, () => {}, redraw);
    function render() { host.empty(); panel.render(host); }
    render();
    if (withSettingsPanel) {
      host.querySelector(`[data-echoink-focus-key="finance-catalog:${kind}"]`).click();
      state.redraws = 0;
    }
    return {
      host, state, panel, render,
      items: () => finance[kind],
      setItems(items) { finance[kind] = items; },
      remove() { return button(host.querySelectorAll(".echoink-finance-catalog-item")[1], "删除"); },
      back() { return host.querySelector(".echoink-life-settings-back"); },
      revoke() { state.paid = false; for (const listener of listeners) listener(); },
      dispose() { panel.dispose(); host.remove(); },
    };
  }

  // Exercise each actual catalog's delete entry point, not a copied helper.
  for (const kind of ["accounts", "merchants", "categories"]) {
    const f = fixture(kind);
    const before = structuredClone(f.items());
    const remove = f.remove();
    remove.click(); remove.click();
    assert.equal(f.panel.isPending(), true);
    assert.equal(remove.disabled, true);
    assert.match(modal().contentEl.textContent, /已有账目和预算不会删除/);
    button(modal().contentEl, "取消").click();
    await flush();
    assert.deepEqual(f.items(), before);
    assert.equal(f.state.writes, 0);
    assert.equal(f.panel.isPending(), false);
    assert.equal(remove.disabled, false);
    remove.click(); modal().close(); await flush();
    assert.equal(f.state.writes, 0, "closing the modal also cancels");
    remove.click(); confirm(); await flush();
    assert.deepEqual(f.items().map(item => item.name), ["保留"]);
    assert.equal(f.state.writes, 1);
    assert.equal(f.state.redraws, 1);
    f.dispose();
  }

  {
    const f = fixture();
    const [keep, remove] = f.items();
    f.remove().click();
    f.setItems([remove, { ...keep, name: "新增" }, keep]);
    confirm(); await flush();
    assert.deepEqual(f.items().map(item => item.name), ["新增", "保留"], "reordering must not delete the old index");
    f.dispose();
  }
  {
    const f = fixture();
    f.remove().click();
    f.setItems(f.items().map(item => ({ ...item })));
    const replacement = f.items();
    confirm(); await flush();
    assert.equal(f.items(), replacement, "replacement objects require a new confirmation");
    assert.equal(f.state.writes, 0);
    f.dispose();
  }
  {
    const f = fixture();
    const before = structuredClone(f.items());
    f.remove().click(); f.revoke(); confirm(); await flush();
    assert.equal(f.state.writes, 0, "the real service rechecks PRO after confirmation");
    assert.deepEqual(f.items(), before);
    assert.equal(api.openTestNoticeMessages.at(-1), "PRO_REQUIRED");
    assert.equal(f.remove().disabled, true);
    f.remove().click();
    assert.equal(api.openTestModals.length, 0);
    f.dispose();
  }
  {
    const f = fixture();
    const before = structuredClone(f.items());
    f.state.failure = true;
    f.remove().click(); confirm(); await flush();
    assert.deepEqual(f.items(), before, "failed persistence rolls back the real catalog");
    assert.equal(api.openTestNoticeMessages.at(-1), "SAVE_FAILED");
    assert.equal(f.panel.isPending(), false);
    assert.equal(f.remove().disabled, false);
    f.dispose();
  }
  {
    const f = fixture();
    let finish;
    f.state.saving = new Promise(resolve => { finish = resolve; });
    const remove = f.remove();
    remove.click(); confirm(); await flush();
    assert.equal(f.panel.isPending(), true);
    remove.click();
    assert.equal(api.openTestModals.length, 0);
    assert.equal(f.state.writes, 1);
    finish(); await flush();
    assert.equal(f.panel.isPending(), false);
    assert.equal(f.state.redraws, 1);
    assert.equal(button(f.host, "新增账户").disabled, false);
    f.dispose();
  }
  for (const close of [f => f.dispose(), f => f.render()]) {
    const f = fixture();
    f.remove().click();
    close(f); await flush();
    assert.equal(api.openTestModals.length, 0, "disposing or redrawing closes a pending confirmation");
    assert.equal(f.state.writes, 0);
    assert.equal(f.panel.isPending(), false);
    f.dispose();
  }
  {
    const f = fixture("accounts", true);
    f.remove().click();
    assert.equal(f.back().disabled, true, "navigation is disabled while confirmation is pending");
    f.render(); await flush();
    assert.equal(api.openTestModals.length, 0);
    assert.equal(f.state.writes, 0);
    assert.equal(f.back().disabled, false, "the outer settings back button recovers after cancelling by redraw");
    f.revoke();
    assert.equal(f.back().disabled, false, "return navigation does not require PRO");
    f.back().click();
    assert.equal(f.host.querySelector("h2").textContent, "财务设置");
    f.dispose();
  }
  console.log("finance catalog: cancel/close, duplicate clicks, confirm, reorder/replacement, PRO expiry, save failure and disposal passed");
} finally {
  dom.window.close();
  await rm(directory, { recursive: true, force: true });
}
