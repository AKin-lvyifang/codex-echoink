import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时"));
if (!process.env.ECHOINK_SETTINGS_TEST_ROOT?.trim()) throw new Error("Explicit ECHOINK_SETTINGS_TEST_ROOT is required");
const fixture = await realpath(path.resolve(process.env.ECHOINK_SETTINGS_TEST_ROOT));
if (!fixture.startsWith(allowed + path.sep)) throw new Error("Settings editor fixtures must stay in 90-任务临时");
const run = await mkdtemp(path.join(fixture, ".settings-editors-run-"));
const { JSDOM } = createRequire(import.meta.url)("jsdom");
let dom;
try {
  const output = path.join(run, "settings-editors.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner,
    entryPoints: [path.join(root, "src/tests/settings-editors.ts")], bundle: true, platform: "node", format: "esm", target: "node22", outfile: output, logLevel: "silent", sourcemap: "inline",
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text", ".txt": "text" },
    plugins: [{ name: "settings-editor-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://settings-editors.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", "XMLSerializer", "FileReader", "ShadowRoot", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))])
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  const tests = await import(pathToFileURL(output).href);
  await tests.runSettingsEditorTests();
} finally {
  dom?.window.close();
  await rm(run, { recursive: true, force: true });
}
