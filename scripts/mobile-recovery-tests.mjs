import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { runMobileRecoveryScenarios } from "../tests/mobile-recovery/scenarios.mjs";

import { mobileBuildOptions } from "./mobile-build.mjs";
import { FixtureTFile } from "../tests/mobile/host.mjs";
import moment from "moment";
const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-recovery/entry.ts"),
  platform: "browser", target: "es2022", format: "cjs", metafile: true, loader: { ".md": "text" } });
for (const file of Object.keys(build.metafile.inputs)) assert.ok(!["src/settings/settings.ts", "src/plugin/task-resume-safety.ts", "src/agents/capability-policy.ts"].includes(file), `desktop import: ${file}`);
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, TextEncoder, TextDecoder, Uint8Array, structuredClone, crypto: webcrypto, console, AbortController, setTimeout, clearTimeout, require(id) { assert.equal(id, "obsidian"); return { TFile: FixtureTFile, TFolder: class {}, moment }; } });
context.self = context;
vm.runInContext(build.outputFiles[0].text, context, { filename: "mobile-recovery-browser.cjs" });
assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer", context), "undefined:undefined");
await runMobileRecoveryScenarios(module.exports);
console.log("OK recovery browser bundle: no Node, desktop recovery or settings adapter");
