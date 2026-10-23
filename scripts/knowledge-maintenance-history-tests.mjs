import { disposableTestRoot } from "./disposable-test-root.mjs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P8自动测试-20261018"), ["ECHOINK_KNOWLEDGE_PAGE_TEST_ROOT"]), "history-tests");
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://maintenance-fixture.invalid" });
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
await mkdir(directory, { recursive: true });
try {
  const output = path.join(directory, "knowledge-maintenance-history.mjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/tests/knowledge-maintenance-history.ts")], outfile: output, bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],

  });
  await (await import(pathToFileURL(output).href)).runKnowledgeMaintenanceHistoryTests();
  if (process.argv.includes("--typecheck")) {
    const ts = require("typescript");
    const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const owned = ["src/settings/knowledge-maintenance-history.ts", "src/settings/settings-tab.ts", "src/tests/knowledge-maintenance-history.ts"].map(file => path.join(root, file));
    const program = ts.createProgram(owned, { ...parsed.options, noEmit: true });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const relevant = diagnostics.filter(item => !item.file || owned.includes(item.file.fileName));
    if (relevant.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(relevant, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
    console.log(`Maintenance history owned-file TypeScript passed; ${diagnostics.length} dependency diagnostics left for integration.`);
  }
} finally {
  win.close();
  await rm(directory, { recursive: true, force: true });
}
