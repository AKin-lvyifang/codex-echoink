import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = process.cwd(), out = path.join(root, ".tmp/pdf-reading-tests.mjs");
const fixture = process.env.ECHOINK_PDF_TEST_ROOT;
if (!fixture || !path.isAbsolute(fixture) || !fixture.endsWith("/.tests/pdf-reading-index")) throw new Error("Set ECHOINK_PDF_TEST_ROOT to an explicit disposable test directory ending in /.tests/pdf-reading-index.");
await mkdir(path.dirname(out), { recursive: true });
await build({ stdin: { contents: 'import { runPdfReadingTests } from "./src/tests/pdf-reading"; await runPdfReadingTests();', resolveDir: root, loader: "ts" }, outfile: out,
  bundle: true, platform: "node", format: "esm", target: "node22", alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "jsdom", "unpdf", "yaml"], loader: { ".md": "text", ".webp": "dataurl", ".svg": "dataurl" },
  banner: { js: 'import {createRequire as __pdfCreateRequire} from "node:module"; const require = __pdfCreateRequire(import.meta.url);' } });
try { const result = spawnSync(process.execPath, [out], { cwd: root, stdio: "inherit", env: { ...process.env, ECHOINK_PDF_TEST_ROOT: fixture } }); process.exitCode = result.status ?? 1; }
finally { await rm(out, { force: true }); }
