import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = process.env.ECHOINK_TODO_TEST_ROOT ? path.join(process.env.ECHOINK_TODO_TEST_ROOT, "navigation") : path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台改版-20261017/.p6-nav-tests");
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://module-navigation.invalid" });
const win = dom.window;
const globals = new Map();
for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "DOMParser", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
}
// Same Obsidian host adapter used by workbench-ui-tests. Product DOM and
// handlers stay real; only Obsidian's convenience methods are supplied here.
const create = function(tag, options = {}) {
  if (typeof options === "string") options = { cls: options };
  const node = this.ownerDocument.createElement(tag);
  if (options.cls) node.className = options.cls;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.value !== undefined) node.value = options.value;
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
await mkdir(fixtureRoot, { recursive: true });
const directory = await mkdtemp(path.join(fixtureRoot, "run-"));
try {
  const output = path.join(directory, "tests.mjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/tests/module-navigation.ts")], outfile: output,
    bundle: true, platform: "node", target: "node22", format: "esm", packages: "external",
    banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text", ".txt": "text" },
    plugins: [{ name: "unrelated-view-shells", setup(build) {
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "obsidian") return { path: path.join(root, "src/tests/obsidian-shim.ts") };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
      // Keep every ViewService method verbatim. Stub only unrelated view class
      // imports to avoid loading the full chat/runtime/settings application.
      build.onResolve({ filter: /^\.\.\/(home\/(home-view|workbench-view)|review\/preview-view|ui\/codex-view)$/ }, args => {
        if (args.importer !== path.join(root, "src/plugin/view-service.ts")) return;
        return { path: args.path, namespace: "p6-view-shell" };
      });
      build.onLoad({ filter: /.*/, namespace: "p6-view-shell" }, () => ({ contents: `
        export class EchoInkHomeView {} export class EchoInkLegacyHomeView {}
        export class EchoInkWorkbenchView {} export class ReviewPreviewView {} export class CodexView {}
        export const VIEW_TYPE_ECHOINK_HOME = "echoink-home";
        export const VIEW_TYPE_REVIEW_PREVIEW = "echoink-review-preview";
        export const VIEW_TYPE_CODEX = "codex-for-obsidian";`, loader: "js" }));
    } }]
  });
  await (await import(pathToFileURL(output).href)).runModuleNavigationTests();
} finally {
  dom.window.close();
  for (const [name, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  await rm(directory, { recursive: true, force: true });
  await rmdir(fixtureRoot).catch(error => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
}
