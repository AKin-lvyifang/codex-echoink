/**
 * Post-build gate for the EchoInk Obsidian bundle.
 *
 * Guards four Obsidian community-review requirements that a plain `npm run
 * build` cannot express:
 *
 *   1. `dist/main.js` must be below the 5,000,000-byte project budget.
 *      The 4,500,000-byte internal target leaves room for future changes.
 *   2. The bundle must not contain Pi CLI / self-update / tool-download code
 *      (ZIP extraction, `Expand-Archive`, `windows-self-update`, the fd/rg
 *      downloader). EchoInk ships a narrowed Pi runtime; see esbuild.config.mjs.
 *   3. `dist/main.js` must complete module evaluation under Node with the
 *      browser-side externals stubbed — a top-level `ReferenceError` or similar
 *      from a shim would otherwise pass typecheck/build yet crash the plugin on
 *      startup. Probe the native host and macOS/Linux/Windows path and URL
 *      semantics in separate processes; CI also runs the same asset on all OSes.
 *   4. Pi's public image helpers must retain the version-anchored Photon WASM
 *      bridge inside the single bundle rather than falling back to the old
 *      always-null image-processing shim.
 *
 * It intentionally does NOT flag the generic strings `main.js`, `manifest.json`,
 * `fs`, or `child_process` — the plugin entry is legitimately named `main.js`,
 * and Memory/Resource state contains a legitimate `manifest.json`.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findDynamicScriptCreations, SCRIPT_RESOURCE_DISABLED } from "./react-dom-script-resources.mjs";

const DIST_MAIN_JS = path.join(process.cwd(), "dist", "main.js");

/** Project hard limit, in decimal bytes; reaching it fails the build gate. */
const HARD_LIMIT_BYTES = 5_000_000;
/** Internal target, reported without relaxing the hard limit. */
const TARGET_LIMIT_BYTES = 4_500_000;

/**
 * Definitive violation markers. These name the actual ZIP / self-update /
 * tool-download machinery, not the `// node_modules/...` module-boundary
 * comments esbuild emits for every bundled module, and not unrelated strings
 * such as `Failed to extract accountId from token`.
 */
const VIOLATION_MARKERS = [
  "extractZipArchive",
  "Expand-Archive",
  "windows-self-update",
  "downloadTool",
  "Downloading... fd",
  "Downloading... ripgrep"
];

const CODEX_REQUIRED_MARKERS = [
  "OpenAI Codex OAuth"
];

const CODEX_UNRESOLVED_IMPORT_MARKERS = [
  'importOAuthModule("./openai-codex.ts")',
  'import("./openai-codex.js")'
];

const PI_IMAGE_RUNTIME_MARKER =
  "EchoInk embedded Photon runtime mismatch: photon-node@0.3.4 "
    + "wasm sha256:10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c";
const PI_IMAGE_FORBIDDEN_MARKERS = [
  "EchoInk never processes images through Pi's default read tool",
  "export async function loadPhoton() { return null; }"
];

const failures = [];

function checkSize() {
  if (!existsSync(DIST_MAIN_JS)) {
    failures.push(`missing bundle: ${DIST_MAIN_JS}`);
    return;
  }
  const bytes = readFileSync(DIST_MAIN_JS).length;
  const sizeMiB = (bytes / 1024 / 1024).toFixed(2);

  console.log(`dist/main.js: ${bytes} bytes (${sizeMiB} MiB)`);

  if (bytes >= HARD_LIMIT_BYTES) {
    failures.push(
      `dist/main.js must be below ${HARD_LIMIT_BYTES} bytes; got ${bytes} bytes`
    );
  } else if (bytes > TARGET_LIMIT_BYTES) {
    console.log(
      `note: above the ${TARGET_LIMIT_BYTES}-byte internal target but below `
        + `the ${HARD_LIMIT_BYTES}-byte hard limit.`
    );
  }
}

function checkMarkers() {
  if (!existsSync(DIST_MAIN_JS)) return;
  const contents = readFileSync(DIST_MAIN_JS, "utf8");
  const scriptCreations = findDynamicScriptCreations(contents, DIST_MAIN_JS);
  if (scriptCreations.length) {
    failures.push(`bundle contains ${scriptCreations.length} dynamic script element creations`);
  }
  if (!contents.includes(SCRIPT_RESOURCE_DISABLED)) {
    failures.push("React DOM script-resource adaptation is missing from the bundle");
  }
  for (const marker of VIOLATION_MARKERS) {
    if (contents.includes(marker)) {
      failures.push(`forbidden marker present in bundle: ${marker}`);
    }
  }
  for (const marker of CODEX_REQUIRED_MARKERS) {
    if (!contents.includes(marker)) {
      failures.push(`required Codex OAuth marker missing from bundle: ${marker}`);
    }
  }
  for (const marker of CODEX_UNRESOLVED_IMPORT_MARKERS) {
    if (contents.includes(marker)) {
      failures.push(`unresolved Codex OAuth import present in bundle: ${marker}`);
    }
  }
  if (!contents.includes(PI_IMAGE_RUNTIME_MARKER)) {
    failures.push("embedded Pi Photon runtime marker missing from bundle");
  }
  for (const marker of PI_IMAGE_FORBIDDEN_MARKERS) {
    if (contents.includes(marker)) {
      failures.push(`disabled Pi image-runtime shim present in bundle: ${marker}`);
    }
  }
}

/**
 * Check module evaluation and OS-sensitive URL handling on the actual bundle.
 * Keep this probe standalone so CI can load the same asset on all three OSes
 * without node_modules masking a missing bundled dependency.
 */
function checkLoad() {
  if (!existsSync(DIST_MAIN_JS)) return;

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "check-bundle-load.mjs"),
    DIST_MAIN_JS
  ], {
    stdio: "inherit",
    timeout: 180_000
  });
  if (result.status !== 0) {
    failures.push(`bundle load probe failed${result.error ? `: ${result.error.message}` : ""}`);
  }
}

checkSize();
checkMarkers();
checkLoad();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`check-built-bundle: ${failure}`);
  }
  process.exit(1);
}

console.log("check-built-bundle: OK");
