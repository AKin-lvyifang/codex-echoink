import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { disposableTestRoot } from "./disposable-test-root.mjs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P9自动测试-20261019")), { recursive: true });
const testRoot = await realpath(disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P9自动测试-20261019")));
const fixture = await mkdtemp(path.join(testRoot, "english-diary-ui-"));
try {
  const output = path.join(fixture, "tests.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner, stdin: { contents: 'import {runEnglishDiaryNavigationUiTests} from "./src/tests/english-diary-navigation-ui"; await runEnglishDiaryNavigationUiTests();', resolveDir: root, loader: "ts" }, outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", loader: { ".md": "text", ".svg": "text", ".webp": "dataurl", ".txt": "text" },
    plugins: [{ name: "english-diary-navigation-local-host", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /(?:^|\/)ui\/modals$/ }, () => ({ path: "confirm", namespace: "p9-ui" }));
      build.onLoad({ filter: /.*/, namespace: "p9-ui" }, () => ({ contents: "export const confirmModal=(...args)=>globalThis.__p9Confirm(...args);", loader: "js" }));
      build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(fixture, { recursive: true, force: true }); }
