import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { disposableTestRoot } from "./disposable-test-root.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const testRoot = await realpath(disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P8自动测试-20261018"), ["ECHOINK_KNOWLEDGE_PAGE_TEST_ROOT"]));
const fixture = await mkdtemp(path.join(testRoot, "knowledge-ui-"));
try {
  const output = path.join(fixture, "tests.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner, stdin: { contents: 'import {runKnowledgePageUiTests} from "./src/tests/knowledge-page-ui"; await runKnowledgePageUiTests();', resolveDir: root, loader: "ts" }, outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", loader: { ".md": "text", ".svg": "text", ".webp": "dataurl", ".txt": "text" },
    plugins: [{ name: "knowledge-page-local-host", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^\.\/workbench-data$/ }, () => ({ path: "workbench", namespace: "p8-ui" }));
      build.onResolve({ filter: /^\.\/knowledge-page-data$/ }, () => ({ path: "knowledge", namespace: "p8-ui" }));
      build.onLoad({ filter: /.*/, namespace: "p8-ui" }, args => ({ contents: args.path === "workbench" ? "export const getWorkbenchDataService=()=>globalThis.__p8Workbench;" : "export const loadKnowledgePageData=(...args)=>globalThis.__p8Load(...args);", loader: "js" }));
      build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(fixture, { recursive: true, force: true }); }
