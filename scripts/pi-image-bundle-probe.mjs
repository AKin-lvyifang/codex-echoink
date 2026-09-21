import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as zlib from "node:zlib";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = path.join(
  rootDir,
  ".tmp",
  "pi-image-production-bundle-probe.cjs"
);

const build = spawnSync(
  process.execPath,
  ["esbuild.config.mjs", "pi-image-bundle-probe"],
  { cwd: rootDir, stdio: "inherit" }
);
if (build.status !== 0) process.exit(build.status ?? 1);

const externalModules = new Set([
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr"
]);
const bundledOnlyModulePrefixes = [
  "@earendil-works/pi-coding-agent",
  "@silvia-odwyer/photon-node"
];
const proxy = new Proxy({}, {
  get(_target, property) {
    if (property === "__esModule") return true;
    if (property === "default") return proxy;
    return class {};
  }
});
const originalLoad = Module._load;
const expectedWasm = readFileSync(path.join(rootDir,
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"));
let decompressCalls = 0;
let decompressMs = 0;
Module._load = function (request, parent, isMain) {
  if (request === "node:zlib") return {
    ...zlib,
    brotliDecompressSync(...args) {
      const started = performance.now();
      const bytes = zlib.brotliDecompressSync(...args);
      // Other complete data dictionaries may also use Brotli. Count Photon
      // only; its real conversion/resize assertions still fail on bad bytes.
      if (bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
        decompressMs += performance.now() - started;
        decompressCalls++;
        assert.deepEqual(bytes, expectedWasm, "restored Photon WASM must match every original byte");
      }
      return bytes;
    }
  };
  if (bundledOnlyModulePrefixes.some((prefix) =>
    request === prefix || request.startsWith(`${prefix}/`)
  )) {
    throw new Error(`Pi image bundle escaped to external module: ${request}`);
  }
  if (externalModules.has(request)) return proxy;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const require = createRequire(import.meta.url);
  const bundle = require(bundlePath);
  assert.equal(decompressCalls, 0, "Photon must remain lazy at plugin module evaluation");
  const firstStarted = performance.now();
  const result = await bundle.runPiImageProductionBundleProbe();
  const firstMs = performance.now() - firstStarted;
  const cachedStarted = performance.now();
  await bundle.runPiImageProductionBundleProbe();
  const cachedMs = performance.now() - cachedStarted;
  assert.equal(decompressCalls, 1, "all conversion/resizing calls must reuse one restored WASM");
  console.log(
    `Pi image production bundle probe: OK `
      + `(resize=${result.originalSize}->${result.resizedSize} `
      + `${result.resizedMimeType}, convert=${result.convertedMimeType})`
  );
  console.log(`Photon restore: ${expectedWasm.length} identical bytes, `
    + `decompress=${decompressMs.toFixed(2)}ms, first helpers=${firstMs.toFixed(2)}ms, `
    + `cached helpers=${cachedMs.toFixed(2)}ms (${process.platform}/${process.arch}, ${process.version})`);
} finally {
  Module._load = originalLoad;
}
