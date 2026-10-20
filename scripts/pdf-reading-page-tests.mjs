import { mkdtemp, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const testRoot = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P10自动测试-20261019"));
const fixture = await mkdtemp(path.join(testRoot, "pdf-page-ui-"));
try {
  const output = path.join(fixture, "tests.mjs");
  await esbuild.build({
    stdin: { contents: 'import { runPdfReadingPageTests } from "./src/tests/pdf-reading-page"; await runPdfReadingPageTests();', resolveDir: root, loader: "ts" },
    outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    plugins: [{ name: "pdf-page-local-host", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "pdf-page-ui" }));
      build.onLoad({ filter: /.*/, namespace: "pdf-page-ui" }, () => ({ contents: "export const webUtils={getPathForFile:file=>file.hostPath||''};", loader: "js" }));
      build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
    } }]
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(fixture, { recursive: true, force: true }); }
