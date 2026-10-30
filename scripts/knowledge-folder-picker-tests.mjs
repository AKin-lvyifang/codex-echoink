import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "echoink-folder-picker-"));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const win = dom.window;
const previous = new Map();
for (const name of ["window", "document", "navigator", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "CompositionEvent", "SVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const value = ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? win[name].bind(win) : name === "window" ? win : win[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
previous.set("ResizeObserver", Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"));
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
try {
  await symlink(path.join(rootDir, "node_modules"), path.join(temporary, "node_modules"), "dir");
  const output = path.join(temporary, "tests.mjs");
  await esbuild.build({
    entryPoints: [path.join(rootDir, "src/tests/knowledge-folder-picker.ts")],
    bundle: true, platform: "node", target: "node22", format: "esm", packages: "external", outfile: output, logLevel: "silent",
    plugins: [{ name: "folder-picker-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "folder-picker-host" }));
      build.onLoad({ filter: /.*/, namespace: "folder-picker-host" }, () => ({
        contents: `export {Scope} from ${JSON.stringify(path.join(rootDir, "src/tests/origin-obsidian-dom-shim.ts"))}; export function setIcon(element, icon) { element.dataset.testIcon = icon; }`, loader: "js", resolveDir: rootDir
      }));
    } }]
  });
  const { runKnowledgeFolderPickerTests } = await import(pathToFileURL(output));
  await runKnowledgeFolderPickerTests(win);
} finally {
  win.close();
  for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  await rm(temporary, { recursive: true, force: true });
}
