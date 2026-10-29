import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import path from "node:path";
import { createRequire } from "node:module";
import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const configuredRoot = process.env.ECHOINK_SETTINGS_TEST_ROOT;
if (!configuredRoot) throw new Error("Set ECHOINK_SETTINGS_TEST_ROOT to a newly registered directory under ~/EchoInk-TestVaults/90-任务临时");
const root = await realpath(configuredRoot);
const allowed = await realpath(path.join(homedir(), "EchoInk-TestVaults/90-任务临时"));
if (!root.startsWith(allowed + path.sep)) throw new Error("Settings test root must be inside 90-任务临时");
const output = path.join(root, "routing-update");
await mkdir(output, { recursive: true });
let dom;
try {
  const entry = path.join(output, "test.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner, entryPoints: ["src/tests/settings-routing-update.ts"], absWorkingDir: repo, bundle: true, platform: "node", format: "esm", outfile: entry,
    plugins: [{ name: "offline-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "offline-host" }));
      build.onLoad({ filter: /.*/, namespace: "offline-host" }, () => ({ contents: `
        export * from ${JSON.stringify(path.join(repo, "src/tests/obsidian-shim.ts"))};
        export function requestUrl(){throw new Error("Tests must not contact external services");}
        export function setIcon(element, icon){element.dataset.testIcon=icon;}
        export function setTooltip(element, label){element.dataset.testTooltip=label;}
      `, resolveDir: repo }));
      build.onResolve({ filter: /^[^./]/ }, args => { const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
    } }], logLevel: "silent" });
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://about-fixture.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "ShadowRoot", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const tests = await import(pathToFileURL(entry).href);
  await tests.runCompactAboutTests(repo);
} finally { dom?.window.close(); await rm(output, { recursive: true, force: true }); }
