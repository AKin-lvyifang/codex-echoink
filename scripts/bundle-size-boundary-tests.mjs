import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SCRIPT_RESOURCE_DISABLED } from "./react-dom-script-resources.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "echoink-bundle-boundary-"));
try {
  mkdirSync(path.join(temporary, "dist"));
  mkdirSync(path.join(temporary, "scripts"));
  copyFileSync(path.join(root, "scripts/check-bundle-load.mjs"),
    path.join(temporary, "scripts/check-bundle-load.mjs"));
  // Synthetic loadable fixture isolates the real gate's exit behavior from
  // product code. Marker/content checks still run, as do all OS path probes.
  const fixture = `module.exports.default = class Fixture {};\n/*
${SCRIPT_RESOURCE_DISABLED}
OpenAI Codex OAuth
EchoInk embedded Photon runtime mismatch: photon-node@0.3.4 wasm sha256:10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c
*/\n`;
  for (const [bytes, advisory] of [
    [7_999_999, false],
    [8_000_000, true],
    [8_000_001, true]
  ]) {
    writeFileSync(path.join(temporary, "dist/main.js"),
      fixture + " ".repeat(bytes - Buffer.byteLength(fixture)));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/check-built-bundle.mjs")], {
      cwd: temporary, encoding: "utf8", timeout: 30_000
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.equal(output.includes("Informational only; size does not block delivery."), advisory, output);
    console.log(`Bundle size review: ${bytes} bytes -> PASS${advisory ? " with advisory" : ""}`);
  }
  // Size is informational, but an actual runtime failure must still block.
  writeFileSync(path.join(temporary, "dist/main.js"), fixture + '\nthrow new Error("fixture load failure");');
  const broken = spawnSync(process.execPath, [path.join(root, "scripts/check-built-bundle.mjs")], {
    cwd: temporary, encoding: "utf8", timeout: 30_000
  });
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stdout + broken.stderr, /fixture load failure/);
  console.log("Bundle runtime failure: FAIL (expected)");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
