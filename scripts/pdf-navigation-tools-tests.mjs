import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P10自动测试-20261019");
await mkdir(fixtureRoot, { recursive: true });
const directory = await mkdtemp(path.join(fixtureRoot, "pdf-tools-"));
try {
  const target = path.join(directory, "run.mjs");
  await esbuild.build({ stdin: { contents: `import { runPdfNavigationToolTests } from "./src/tests/pdf-navigation-tools"; await runPdfNavigationToolTests(${JSON.stringify(path.join(directory, "fixtures"))});`, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile: target,
    banner: { js: `import {createRequire as __pdfToolsRequire} from "node:module"; const require = __pdfToolsRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "pi-workspace-runtime", setup(build) { build.onResolve({ filter: /^@earendil-works\// }, args => ({ path: import.meta.resolve(args.path), external: true })); } }],
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" } });
  const result = spawnSync(process.execPath, [target], { cwd: root, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
