import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryVaults = await realpath(path.join(homedir(), "EchoInk-TestVaults/90-任务临时"));
const fixture = await realpath(process.env.ECHOINK_WORKBENCH_TEST_ROOT?.trim() || path.join(temporaryVaults, "工作台改版-20261017"));
const relativeFixture = path.relative(temporaryVaults, fixture);
if (!relativeFixture || relativeFixture === ".." || relativeFixture.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFixture) || !(await stat(fixture)).isDirectory()) {
  throw new Error("Workbench signals fixtures must use an existing directory inside EchoInk-TestVaults/90-任务临时");
}
const directory = await mkdtemp(path.join(fixture, ".p5-signal-tests-"));
try {
  const target = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: { contents: `import { runWorkbenchSignalsTests } from "./src/tests/workbench-signals"; import { runWorkbenchDataTests } from "./src/tests/workbench-data"; await runWorkbenchSignalsTests(); await runWorkbenchDataTests(${JSON.stringify(path.join(directory, "vaults"))});`, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: target,
    banner: { js: `import { createRequire as __workbenchSignalsRequire } from "node:module"; const require = __workbenchSignalsRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" }
  });
  const run = spawnSync(process.execPath, [target], { stdio: "inherit" });
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
