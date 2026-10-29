import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { runMobileCapabilityScenarios } from "../tests/mobile-capabilities/scenarios.mjs";
import { FixtureTFile } from "../tests/mobile/host.mjs";

const build = await esbuild.build({ entryPoints: ["tests/mobile-capabilities/entry.ts"], bundle: true, write: false,
  alias: { obsidian: new URL("../tests/mobile-capabilities/obsidian.ts", import.meta.url).pathname },
  platform: "browser", target: "es2022", format: "cjs", metafile: true, loader: { ".md": "text" } });
const inputs = Object.keys(build.metafile.inputs);
for (const forbidden of ["src/settings/settings.ts", "src/agents/capability-policy.ts", "src/harness/pi-native/obsidian-cli-policy.ts", "src/harness/pi-native/todo-tool-policy.ts"]) {
  assert.ok(!inputs.includes(forbidden), `mobile bundle imported desktop ${forbidden}`);
}
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, __echoinkFixtureTFile: FixtureTFile, TextEncoder, TextDecoder, Uint8Array, structuredClone, crypto: webcrypto, console, AbortController, setTimeout, clearTimeout });
context.self = context;
vm.runInContext(build.outputFiles[0].text, context, { filename: "mobile-capabilities-browser.cjs" });
assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer + ':' + typeof require", context), "undefined:undefined:undefined");
await runMobileCapabilityScenarios(module.exports);
console.log("OK mobile capability bundle: shared pure core, no Node or desktop policy/settings adapters");
