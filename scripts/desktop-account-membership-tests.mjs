import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_ACCOUNT_TEST_ROOT) throw new Error("Explicit ECHOINK_ACCOUNT_TEST_ROOT is required");
const authorized = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
const requested = path.resolve(process.env.ECHOINK_ACCOUNT_TEST_ROOT);
if (!requested.startsWith(authorized + path.sep)) throw new Error("Use disposable test Vaults");
await mkdir(requested, { recursive: true });
const fixture = await realpath(requested);
if (!fixture.startsWith(authorized + path.sep)) throw new Error("Fixture symlinks cannot leave disposable test Vaults");
const run = await mkdtemp(path.join(fixture, "desktop-account-"));
const { JSDOM } = createRequire(import.meta.url)("jsdom");
let dom;
try {
  const output = path.join(run, "tests.mjs");
  await esbuild.build({ entryPoints: [path.join(repo, "src/tests/desktop-account-membership.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl", ".txt": "text" },
    plugins: [{ name: "desktop-account-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repo, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => { const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
    } }], logLevel: "silent" });
  dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://account-ui.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", "XMLSerializer", "FileReader", "ShadowRoot", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const tests = await import(pathToFileURL(output).href);
  await tests.runDesktopAccountMembershipTests();
} finally { dom?.window.close(); await rm(run, { recursive: true, force: true }); }
