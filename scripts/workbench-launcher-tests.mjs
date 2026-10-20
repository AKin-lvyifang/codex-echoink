import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryVaults = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
const fixture = await realpath(process.env.ECHOINK_WORKBENCH_TEST_ROOT?.trim() || path.join(temporaryVaults, "工作台改版-20261017"));
const relativeFixture = path.relative(temporaryVaults, fixture);
if (!relativeFixture || relativeFixture === ".." || relativeFixture.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFixture) || !(await stat(fixture)).isDirectory()) {
  throw new Error("Workbench launcher fixtures must use an existing directory inside EchoInk-TestVaults/90-任务临时");
}
const runRoot = await mkdtemp(path.join(fixture, ".workbench-launcher-tests-"));
try {
  const output = path.join(runRoot, "workbench-launcher.mjs");
  await esbuild.build({ stdin: { contents: `import { runWorkbenchLauncherTests } from "./src/tests/workbench-launcher"; await runWorkbenchLauncherTests(${JSON.stringify(runRoot)});`, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: output, logLevel: "silent", loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import { createRequire as createAgentTaskRequire } from "node:module"; const require = createAgentTaskRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "agent-task-local-host", setup(build) {
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1", TMPDIR: runRoot, ECHOINK_TASK_TEST_ROOT: runRoot } });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(runRoot, { recursive: true, force: true });
}
