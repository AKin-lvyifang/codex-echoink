import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
// Reuse an existing DOM runtime; this test adds no production dependency.
const { JSDOM } = require(process.env.ECHOINK_JSDOM_PATH || "jsdom");
const directory = path.join(root, ".tmp/account-membership");
await mkdir(directory, { recursive: true });
try {
  const entry = path.join(directory, "test.mjs");
  await esbuild.build({
    entryPoints: ["src/tests/account-membership.ts"], absWorkingDir: root,
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: entry, sourcemap: "inline",
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    logLevel: "silent"
  });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://settings-fixture.invalid" });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))])
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  const test = await import(pathToFileURL(entry).href);
  const errors = [];
  const previousError = console.error;
  console.error = (...args) => { errors.push(args); previousError(...args); };
  try {
    await test.runAccountMembershipTests(win);
    if (errors.length) throw new Error(`Unexpected console errors during account lifecycle: ${errors.length}`);
  }
  finally { console.error = previousError; dom.window.close(); }
} finally {
  await rm(directory, { recursive: true, force: true });
}
