import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { build } from "esbuild";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_USAGE_TEST_ROOT) throw new Error("Explicit ECHOINK_USAGE_TEST_ROOT is required");
const allowed = await realpath(join(homedir(), "EchoInk-TestVaults/90-任务临时"));
const fixture = await realpath(process.env.ECHOINK_USAGE_TEST_ROOT);
if (!fixture.startsWith(allowed + sep)) throw new Error("Use disposable test Vaults");
const output = await mkdtemp(join(fixture, "usage-"));
try {
  const outfile = join(output, "tests.mjs");
  await build({ banner: desktopNodeTestBanner, alias: desktopNodeTestAliases, absWorkingDir: root, entryPoints: ["src/tests/usage-accounting.ts"], outfile,
    bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "silent", plugins: [{name: "package-location", setup(b) {
      b.onResolve({filter: /^[^./]/}, args => {const target=import.meta.resolve(args.path);return {path:target.startsWith("node:")?target:fileURLToPath(target),external:true};});
    }}] });
  await import(pathToFileURL(outfile).href);
  const bundle = await build({ absWorkingDir: root, entryPoints: ["src/harness/usage/token-estimator.ts"],
    bundle: true, format: "esm", platform: "browser", minify: true, write: false, logLevel: "silent" });
  const bytes = bundle.outputFiles[0].contents;
  console.log(JSON.stringify({ tokenizerBundle: { bytes: bytes.length, gzipBytes: gzipSync(bytes).length } }));
} finally { await rm(output, { recursive: true, force: true }); }
