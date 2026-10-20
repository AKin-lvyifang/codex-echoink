import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.resolve(process.env.ECHOINK_TODO_TEST_ROOT || path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P7自动测试-20261018"));
const allowed = path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时") + path.sep;
if (!fixtureRoot.startsWith(allowed)) throw new Error("Todo tool fixtures must be in the disposable 90-任务临时 directory");
await mkdir(fixtureRoot, { recursive: true });
const directory = await mkdtemp(path.join(fixtureRoot, "tools-"));
try {
  const target = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: { contents: `import { runTodoToolTests } from "./src/tests/todo-tools"; await runTodoToolTests(${JSON.stringify(path.join(directory, "vault"))});`, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", outfile: target,
    banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "pi-runtime-from-workspace", setup(build) { build.onResolve({ filter: /^@earendil-works\// }, args => ({ path: import.meta.resolve(args.path), external: true })); } }],
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" }
  });
  const run = spawnSync(process.execPath, [target], { stdio: "inherit" });
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
