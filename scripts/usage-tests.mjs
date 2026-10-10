import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(join(root, ".tmp-usage-"));
try {
  const outfile = join(output, "tests.mjs");
  await build({ absWorkingDir: root, entryPoints: ["src/tests/usage-accounting.ts"], outfile,
    bundle: true, format: "esm", platform: "node", target: "node22", packages: "external", logLevel: "silent" });
  await import(pathToFileURL(outfile).href);
  const bundle = await build({ absWorkingDir: root, entryPoints: ["src/harness/usage/token-estimator.ts"],
    bundle: true, format: "esm", platform: "browser", minify: true, write: false, logLevel: "silent" });
  const bytes = bundle.outputFiles[0].contents;
  console.log(JSON.stringify({ tokenizerBundle: { bytes: bytes.length, gzipBytes: gzipSync(bytes).length } }));
} finally { await rm(output, { recursive: true, force: true }); }
