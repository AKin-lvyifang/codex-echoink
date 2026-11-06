import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { FixtureTFile } from "../tests/mobile/host.mjs";
import { taskScenarios } from "../tests/mobile-tasks/scenarios.mjs";

const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-tasks/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(file => file.includes("pi-coding-agent/") || file.includes("node:fs")));
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, crypto: webcrypto, structuredClone, TextEncoder, TextDecoder,
  AbortController, URL, setTimeout, clearTimeout, console, require(id) {
    assert.equal(id, "obsidian"); return { TFile: FixtureTFile, TFolder: class {}, Notice: class { constructor() {} } };
  } });
context.self = context;
vm.runInContext(build.outputFiles[0].text, context, { filename: "mobile-tasks-browser.cjs" });
const unhandled = [];
const collect = error => unhandled.push(error);
process.on("unhandledRejection", collect);
try {
  await taskScenarios(module.exports);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(unhandled.length, 0, `Unhandled task failures: ${unhandled.map(String).join("; ")}`);
} finally { process.off("unhandledRejection", collect); }
