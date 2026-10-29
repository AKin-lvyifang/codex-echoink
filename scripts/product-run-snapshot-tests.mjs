import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { disposableTestRoot } from "./disposable-test-root.mjs";

const outputRoot = disposableTestRoot(path.join(homedir(), "EchoInk-TestVaults", "90-任务临时", "expert-product-run-snapshots"));
await mkdir(outputRoot, { recursive: true });
const temporary = await mkdtemp(path.join(outputRoot, "product-run-snapshots-"));
try {
  const output = path.join(temporary, "tests.mjs");
  const source = process.argv.includes("--with-file-stores")
    ? 'import { runPiNativeFileStoreTests } from "./src/tests/harness-v2/pi-native-file-stores"; await runPiNativeFileStoreTests(); console.log("Existing Pi file-store lifecycle/corruption checks: PASS");'
    : 'import { runProductRunSnapshotTests } from "./src/tests/pi-native/product-run-snapshots"; await runProductRunSnapshotTests(process.env.ECHOINK_PRODUCT_RUN_SNAPSHOT_ROOT);';
  await esbuild.build({ banner: desktopNodeTestBanner, stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: output, logLevel: "silent", plugins: [{ name: "snapshot-test-node-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: desktopNodeTestAliases.obsidian }));
      build.onResolve({ filter: /^[^./]/ }, args => { const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
    } }] });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", ECHOINK_PRODUCT_RUN_SNAPSHOT_ROOT: path.join(temporary, "store") } });
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
