import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
if (!process.env.ECHOINK_TODO_UI_TEST_ROOT) throw new Error("Explicit ECHOINK_TODO_UI_TEST_ROOT required");
const testRoot = await realpath(process.env.ECHOINK_TODO_UI_TEST_ROOT);
if (!testRoot.startsWith(allowed + path.sep)) throw new Error("Fixtures must stay in 90-任务临时");
const fixture = await mkdtemp(path.join(testRoot, "todo-ui-"));
try {
  const output = path.join(fixture, "tests.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner, stdin: { contents: 'import { runTodoPageModelTests } from "./src/tests/todo-page-model"; await runTodoPageModelTests();', resolveDir: root, loader: "ts" },
    outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    loader: { ".md": "text", ".svg": "text", ".txt": "text", ".webp": "dataurl" },
    plugins: [{ name: "todo-ui-local-host", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => { const url = import.meta.resolve(args.path); return { path: url.startsWith("node:") ? url : fileURLToPath(url), external: true }; });
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit", env: { ...process.env, ECHOINK_TODO_UI_FIXTURE: fixture } });
  process.exitCode = result.status ?? 1;
} finally { await rm(fixture, { recursive: true, force: true }); }
