import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = path.join(rootDir, "dist", "main.js");
const bundle = await readFile(bundlePath, "utf8");
const metafile = JSON.parse(await readFile(path.join(rootDir, ".tmp/production-metafile.json"), "utf8"));
const output = metafile.outputs["dist/main.js"];
assert.equal(output?.bytes, Buffer.byteLength(bundle), "production metafile must match the current bundle size");
const bundledInputs = Object.entries(output.inputs)
  .filter(([, contribution]) => contribution.bytesInOutput > 0)
  .map(([name]) => name);

// npm may deduplicate these SDKs to the root. Minification also removes module
// path comments, so use actual emitted contributions instead of path strings.
assert.ok(
  bundledInputs.some((name) => /node_modules\/openai\//u.test(name)),
  "production bundle must include the real OpenAI provider SDK"
);
assert.ok(
  bundledInputs.some((name) => /node_modules\/@anthropic-ai\/sdk\//u.test(name)),
  "production bundle must include the real Anthropic provider SDK"
);
assert.ok(
  !bundledInputs.some((name) => /node_modules\/undici\//u.test(name)),
  "production bundle must not evaluate Pi's Node 22-only undici dependency"
);
assert.doesNotMatch(
  bundle,
  /require\(["']node:sqlite["']\)/,
  "production bundle must not load node:sqlite on Obsidian Node 20"
);
assert.doesNotMatch(
  bundle,
  /Promise\.withResolvers\s*\(/,
  "production bundle must not call Node 22-only Promise.withResolvers"
);
assert.ok(
  bundledInputs.some((name) => /auth\/oauth\/openai-codex\.js$/u.test(name)),
  "production bundle must statically contain the OpenAI Codex OAuth flow"
);
assert.ok(
  bundledInputs.some((name) => /api\/openai-codex-responses\.js$/u.test(name)),
  "production bundle must contain the OpenAI Codex Responses SSE adapter"
);
assert.ok(
  !bundledInputs.some((name) => /node_modules\/(?:unpdf|pdfjs-dist)\//u.test(name)),
  "production bundle must reuse Obsidian PDF.js instead of embedding a second PDF engine"
);
assert.doesNotMatch(
  bundle,
  /importOAuthModule\(["']\.\/openai-codex\.(?:ts|js)["']\)/,
  "production bundle must not retain the package-relative Codex OAuth import"
);

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
let shim;
shim = new Proxy(function shimmedObsidianModule() {
  return shim;
}, {
  get(_target, property) {
    if (property === Symbol.toPrimitive) return () => "";
    if (property === "then") return undefined;
    if (property === "prototype") return {};
    return shim;
  },
  apply() {
    return shim;
  },
  construct() {
    return shim;
  }
});

Module._load = function echoInkNode20Probe(request, parent, isMain) {
  if (request === "node:sqlite") {
    throw new Error("node:sqlite is unavailable in the Obsidian Node runtime");
  }
  if (
    request === "obsidian"
    || request === "electron"
    || request.startsWith("@codemirror/")
    || request.startsWith("@lezer/")
  ) {
    return shim;
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const loaded = require(bundlePath);
  assert.equal(typeof loaded, "object");
} finally {
  Module._load = originalLoad;
}

console.log(`Phase 1 Obsidian runtime bundle: ok (${process.version})`);
