import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { FixtureTFile } from "../tests/mobile/host.mjs";
import { runMobileCompanyUIScenarios } from "../tests/mobile-company-ui/scenarios.mjs";

const build = await esbuild.build(mobileBuildOptions("tests/mobile-company-ui/entry.ts"));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://mobile-task-fixture.invalid" });
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const shim = { exports: {} };
const shimBuild = await esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" });
vm.runInNewContext(shimBuild.outputFiles[0].text, { module: shim, exports: shim.exports, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, DOMParser: dom.window.DOMParser, console });
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, {
  module, exports: module.exports, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement,
  DOMParser: dom.window.DOMParser, MutationObserver: dom.window.MutationObserver, TextEncoder, TextDecoder, URL, AbortController, structuredClone,
  crypto: webcrypto, setTimeout, clearTimeout, console, btoa, atob, Blob, FormData, Response,
  require(id) { assert.equal(id, "obsidian", `Unexpected mobile Node import: ${id}`); return { ...shim.exports, TFile: FixtureTFile }; }
});
const unhandled = [];
const collect = error => unhandled.push(error);
process.on("unhandledRejection", collect);
try {
  await runMobileCompanyUIScenarios(module.exports, dom.window);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(unhandled.length, 0, "accepted completion failures must always be handled");
} finally { process.off("unhandledRejection", collect); dom.window.close(); }

