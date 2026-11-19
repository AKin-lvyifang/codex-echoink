import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { disposableTestRoot } from "./disposable-test-root.mjs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const requested = disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/资讯Tab自动测试"));
await mkdir(requested, { recursive: true });
const fixture = await mkdtemp(path.join(await realpath(requested), "news-"));
try {
  const output = path.join(fixture, "tests.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner,
    stdin: { contents: 'import { runNewsTests } from "./src/tests/news"; await runNewsTests();', resolveDir: root, loader: "ts" },
    outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl", ".md": "text" },
    plugins: [{ name: "news-local-host", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
    } }]
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(fixture, { recursive: true, force: true }); }
