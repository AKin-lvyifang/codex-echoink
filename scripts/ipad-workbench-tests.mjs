import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { FixtureTFile } from "../tests/mobile/host.mjs";
import { runIPadWorkbenchScenarios } from "../tests/ipad-workbench/scenarios.mjs";

const build = await esbuild.build({ ...mobileBuildOptions("tests/ipad-workbench/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(path => /src\/ui\/iphone\//u.test(path)), "iPad entry must never import iPhone pages");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://ipad-workbench.invalid" });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const observers = new Set();
class ResizeObserver {
  constructor(callback) { this.callback = callback; observers.add(this); }
  observe() {}
  unobserve() {}
  disconnect() { observers.delete(this); }
}
const shim = { exports: {} };
const shimBuild = await esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" });
vm.runInNewContext(shimBuild.outputFiles[0].text, { module: shim, exports: shim.exports, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, DOMParser: dom.window.DOMParser, console });
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, {
  module, exports: module.exports, window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, SVGElement: dom.window.SVGElement,
  DOMParser: dom.window.DOMParser, MutationObserver: dom.window.MutationObserver, ResizeObserver, TextEncoder, TextDecoder, URL, AbortController, structuredClone,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  crypto: webcrypto, setTimeout, clearTimeout, console, btoa, atob, Blob, FormData, Response,
  require(id) {
    assert.equal(id, "obsidian", `Unexpected browser dependency: ${id}`);
    return { ...shim.exports, TFile: FixtureTFile, Platform: { ...shim.exports.Platform, isTablet: true } };
  }
});
const unhandled = [];
const collect = error => unhandled.push(error);
process.on("unhandledRejection", collect);
try {
  await runIPadWorkbenchScenarios(module.exports, dom.window);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(unhandled.length, 0, `Unhandled async failures: ${unhandled.map(String).join("; ")}`);
  assert.equal(observers.size, 0, "disposed iPad panes release resize observers");
} finally { process.off("unhandledRejection", collect); dom.window.close(); }
