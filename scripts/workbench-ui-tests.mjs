import { mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryVaults = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
const fixture = await realpath(process.env.ECHOINK_WORKBENCH_TEST_ROOT || path.join(temporaryVaults, "工作台改版-20261017"));
const relativeFixture = path.relative(temporaryVaults, fixture);
if (!relativeFixture || relativeFixture === ".." || relativeFixture.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFixture)) throw new Error("Workbench UI fixtures must be inside EchoInk-TestVaults/90-任务临时");
const directory = path.join(fixture, ".p5-ui-tests");
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
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
await mkdir(directory, { recursive: true });
try {
  const output = path.join(directory, "workbench-ui.mjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/tests/workbench-ui.ts")], outfile: output, bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
    plugins: [{ name: "workbench-ui-data-boundary", setup(build) {
      build.onResolve({ filter: /^\.\/workbench-data$/ }, () => ({ path: "workbench-data", namespace: "p5-ui" }));
      build.onLoad({ filter: /.*/, namespace: "p5-ui" }, () => ({ contents: "export const getWorkbenchDataService = () => globalThis.__p5WorkbenchPort;", loader: "js" }));
    } }]
  });
  await (await import(pathToFileURL(output).href)).runWorkbenchUiTests();
  if (process.argv.includes("--typecheck")) {
    const ts = require("typescript");
    const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const owned = ["src/home/workbench-view.ts", "src/home/module-navigation.ts", "src/home/home-view.ts", "src/tests/workbench-ui.ts"].map(file => path.join(root, file));
    const program = ts.createProgram(owned, { ...parsed.options, noEmit: true });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const relevant = diagnostics.filter(item => !item.file || owned.includes(item.file.fileName));
    if (relevant.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(relevant, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
    console.log(`Workbench owned-file TypeScript passed; ${diagnostics.length} dependency diagnostics left for integration.`);
  }
} finally {
  win.close();
  await rm(directory, { recursive: true, force: true });
}
