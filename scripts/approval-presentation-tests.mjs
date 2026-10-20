import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时", "工作台改版-20261017"));
const requestedRoot = process.env.ECHOINK_APPROVAL_PRESENTATION_TEST_ROOT?.trim();
if (!requestedRoot) throw new Error("Set ECHOINK_APPROVAL_PRESENTATION_TEST_ROOT to ~/EchoInk-TestVaults/90-任务临时/工作台改版-20261017");
const requested = await realpath(path.resolve(requestedRoot));
if (requested !== allowed) throw new Error("Approval presentation fixtures must use the dedicated 工作台改版-20261017 test Vault");
const run = await mkdtemp(path.join(allowed, ".approval-presentation-"));
try {
  const outfile = path.join(run, "approval-presentation-tests.mjs");
  await esbuild.build({
    stdin: { contents: 'import { runApprovalPresentationTests } from "./src/tests/approval-presentation"; await runApprovalPresentationTests();', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "silent",
    loader: { ".md": "text", ".svg": "text", ".txt": "text" },
    plugins: [{ name: "approval-offline-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [outfile], { cwd: root, stdio: "inherit",
    env: { ...process.env, PI_OFFLINE: "1", TMPDIR: run } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(run, { recursive: true, force: true });
}
