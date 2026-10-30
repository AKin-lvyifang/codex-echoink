import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";

const directory = await mkdtemp(path.resolve(".tmp-web-search-key-dom-"));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://web-search-fixture.invalid" });
try {
  const entry = path.join(directory, "test.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner, entryPoints: ["src/tests/web-search-key-dom.ts"], bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: "inline", outfile: entry, alias: { obsidian: path.resolve("src/tests/obsidian-shim.ts") }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" } });
  const win = dom.window;
  for (const name of ["window", "document", "navigator", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "SVGElement", "SVGSVGElement", "DOMParser", ...Object.getOwnPropertyNames(win).filter(name => /^HTML.*Element$/.test(name))]) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
  }
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  const test = await import(pathToFileURL(entry).href);
  await test.runWebSearchKeyDomTests(win);
} finally { dom.window.close(); await rm(directory, { recursive: true, force: true }); }
