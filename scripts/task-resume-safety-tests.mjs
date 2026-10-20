import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
if (!process.env.ECHOINK_TASK_RESUME_TEST_ROOT) throw new Error("Explicit ECHOINK_TASK_RESUME_TEST_ROOT is required");
const fixture = await realpath(process.env.ECHOINK_TASK_RESUME_TEST_ROOT);
if (!fixture.startsWith(allowed + path.sep)) throw new Error("Task resume fixtures must stay in 90-任务临时");
const output = await mkdtemp(path.join(fixture, "run-task-resume-safety-"));
try {
  await esbuild.build({
    stdin: { contents: 'import { runTaskResumeSafetyTests } from "./src/tests/task-resume-safety"; await runTaskResumeSafetyTests(process.env.ECHOINK_P4_SAFETY_TEST_ROOT);', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: path.join(output, "run.mjs"), logLevel: "silent",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "obsidian-test-shim", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [path.join(output, "run.mjs")], { cwd: root, env: { ...process.env, PI_OFFLINE: "1", TMPDIR: output, ECHOINK_P4_SAFETY_TEST_ROOT: output }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { recursive: true, force: true }); }
