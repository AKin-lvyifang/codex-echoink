import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { runAgentScenarios } from "../tests/mobile-agents/scenarios.mjs";

// Browser compilation and a Node-free VM exercise the real service, using memory only.
const build = await esbuild.build({ entryPoints: ["tests/mobile-agents/entry.ts"], bundle: true, write: false,
  platform: "browser", target: "es2022", format: "cjs", metafile: true });
const inputs = Object.keys(build.metafile.inputs);
for (const forbidden of ["src/settings/settings.ts", "src/agents/migration.ts", "src/agents/task-workspace.ts", "src/harness/memory/legacy-personality-reader.ts", "src/harness/memory/mobile-profile-protocol.ts"]) {
  assert.ok(!inputs.includes(forbidden), `browser imported ${forbidden}`);
}
assert.ok(!inputs.some(file => /(?:^|\/)node:|file-conversation-catalog/u.test(file)));
const module = { exports: {} };
const context = vm.createContext({ module, exports: module.exports, TextEncoder, Uint8Array, structuredClone, console });
vm.runInContext(build.outputFiles[0].text, context, { filename: "mobile-agents-browser.cjs" });
assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer + ':' + typeof require", context), "undefined:undefined:undefined");
await runAgentScenarios(module.exports);
console.log("OK browser bundle: no Node, desktop settings aggregate, legacy writer or migration import");
