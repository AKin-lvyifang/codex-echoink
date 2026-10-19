import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { runMobileRecoveryScenarios } from "../tests/mobile-recovery/scenarios.mjs";

const build = await esbuild.build({ entryPoints: ["tests/mobile-recovery/entry.ts"], bundle: true, write: false,
  platform: "browser", target: "es2022", format: "cjs", metafile: true, loader: { ".md": "text" } });
for (const file of Object.keys(build.metafile.inputs)) assert.ok(!["src/settings/settings.ts", "src/plugin/task-resume-safety.ts", "src/agents/capability-policy.ts"].includes(file), `desktop import: ${file}`);
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, TextEncoder, TextDecoder, Uint8Array, structuredClone, crypto: webcrypto, console, AbortController, setTimeout, clearTimeout });
vm.runInContext(build.outputFiles[0].text, context, { filename: "mobile-recovery-browser.cjs" });
assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer + ':' + typeof require", context), "undefined:undefined:undefined");
await runMobileRecoveryScenarios(module.exports);
console.log("OK recovery browser bundle: no Node, desktop recovery or settings adapter");
