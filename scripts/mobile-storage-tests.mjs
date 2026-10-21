import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { runStorageScenarios } from "../tests/mobile-storage/scenarios.mjs";

// Build the actual production entry as a browser bundle; fixtures never touch a Vault.
const build = await esbuild.build({ entryPoints: ["tests/mobile-storage/entry.ts"], bundle: true, write: false,
  format: "cjs", platform: "browser", target: "es2022", metafile: true });
const inputs = Object.keys(build.metafile.inputs);
assert.ok(inputs.includes("src/mobile/store.ts"));
assert.ok(!inputs.some(file => file.startsWith("node:") || /(?:tool-authorization|knowledge-maintenance-protocol)\.ts$/u.test(file)), "storage stays a browser-safe pure contract graph");
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, crypto: webcrypto, structuredClone, TextEncoder, Uint8Array, console }, { filename: "mobile-storage-browser.cjs" });
await runStorageScenarios(module.exports);
