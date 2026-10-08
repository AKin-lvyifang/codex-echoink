import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { createRequire } from "node:module";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".tmp/finance-bill-plan-tests");
await mkdir(directory, { recursive: true });
try {
  const target = path.join(directory, "test.mjs");
  await esbuild.build({
    stdin: { contents: 'export { runFinanceBillPlanTests, runFinanceBillPlanDomTests } from "./src/tests/finance-bill-plan";', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: target,
    external: ["read-excel-file/node", "yaml", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
  });
  const test = await import(pathToFileURL(target).href);
  await test.runFinanceBillPlanTests();
  if (process.argv.includes("--dom")) {
    const require = createRequire(import.meta.url);
    const { JSDOM } = require(process.env.ECHOINK_JSDOM_PATH || "jsdom");
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://bill-plan-fixture.invalid" });
    const win = dom.window;
    for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))])
      Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
    globalThis.getComputedStyle = win.getComputedStyle.bind(win);
    globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
    globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    try { await test.runFinanceBillPlanDomTests(win); } finally { dom.window.close(); }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
