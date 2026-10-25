import path from "node:path";
import { createRequire } from "node:module";
import esbuild from "esbuild";

// DOM-only Workbench acceptance, including its existing regression suite.
// No files, Vaults, browsers or native application state are created here.
const require = createRequire(import.meta.url), { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://workbench-fixture.invalid" });
const win = dom.window;
for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "DOMParser", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
}
const create = function(tag, options = {}) {
  if (typeof options === "string") options = { cls: options };
  const node = this.ownerDocument.createElement(tag);
  if (options.cls) node.className = options.cls;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) node.setAttribute(key, String(value));
  this.appendChild(node); return node;
};
Object.assign(win.Element.prototype, {
  createEl: create, createDiv(options) { return create.call(this, "div", options); }, createSpan(options) { return create.call(this, "span", options); },
  empty() { this.replaceChildren(); }, addClass(...names) { this.classList.add(...names); }, removeClass(...names) { this.classList.remove(...names); },
  setText(text) { this.textContent = text; }, setAttr(key, value) { this.setAttribute(key, value); }, toggleClass(key, value) { this.classList.toggle(key, value); },
  scrollIntoView() {}, scrollTo(options) { this.scrollTop = options.top; }
});
win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
try {
  const build = await esbuild.build({
    entryPoints: ["src/tests/workbench-ui.ts"], bundle: true, write: false, platform: "node", target: "node22", format: "cjs",
    alias: { obsidian: path.resolve("src/tests/obsidian-shim.ts") },
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text" },
    plugins: [{ name: "workbench-ui-data-boundary", setup(build) {
      build.onResolve({ filter: /^\.\/workbench-data$/ }, () => ({ path: "workbench-data", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const getWorkbenchDataService = () => globalThis.__p5WorkbenchPort;", loader: "js" }));
    } }]
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", build.outputFiles[0].text)(require, module, module.exports);
  await module.exports.runWorkbenchUiTests();
  console.log("PASS Workbench memory banners, adoption, inline reset/cancel, English copy and existing DOM regressions (native appearance unverified)");
} finally { win.close(); }
