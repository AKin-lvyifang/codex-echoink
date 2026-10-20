import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
if (!process.env.ECHOINK_PROFILE_UI_TEST_ROOT) throw new Error("Explicit ECHOINK_PROFILE_UI_TEST_ROOT is required");
const configured = path.resolve(process.env.ECHOINK_PROFILE_UI_TEST_ROOT);
if (!configured.startsWith(allowed + path.sep)) throw new Error("Use disposable test Vaults");
await mkdir(configured, { recursive: true });
const root = await realpath(configured);
if (!root.startsWith(allowed + path.sep)) throw new Error("Fixture symlinks must stay in disposable test Vaults");
const run = await mkdtemp(path.join(root, "run-"));
const { JSDOM } = createRequire(import.meta.url)("jsdom");
let dom;
try {
  const output = path.join(run, "tests.mjs");
  await esbuild.build({ entryPoints: [path.join(repo, "src/tests/user-profile-settings.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl", ".txt": "text" },
    plugins: [{ name: "profile-ui-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repo, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => { const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
    } }], logLevel: "silent" });
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://profile-ui.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", "XMLSerializer", "FileReader", "ShadowRoot", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const tests = await import(pathToFileURL(output).href);
  await tests.runUserProfileSettingsTests(run);
} finally { dom?.window.close(); await rm(run, { recursive: true, force: true }); }
