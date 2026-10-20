import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults", "90-任务临时"));
if (!process.env.ECHOINK_AGENT_CAPABILITIES_TEST_ROOT?.trim()) throw new Error("Set ECHOINK_AGENT_CAPABILITIES_TEST_ROOT to an existing task directory under ~/EchoInk-TestVaults/90-任务临时");
const requested = await realpath(path.resolve(process.env.ECHOINK_AGENT_CAPABILITIES_TEST_ROOT));
if (!requested.startsWith(allowed + path.sep)) throw new Error("Capability fixtures must stay inside ~/EchoInk-TestVaults/90-任务临时");
const run = await mkdtemp(path.join(requested, "capabilities-run-"));
try {
  const outfile = path.join(run, "agent-capabilities-tests.mjs");
  await esbuild.build({
    stdin: { contents: 'import { runAgentCapabilitiesTests } from "./src/tests/agent-capabilities"; await runAgentCapabilitiesTests(process.env.ECHOINK_AGENT_CAPABILITIES_FIXTURE_ROOT);', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "silent",
    loader: { ".md": "text", ".svg": "text", ".txt": "text" },
    plugins: [{ name: "capabilities-offline-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [outfile], { cwd: root, stdio: "inherit",
    env: { ...process.env, PI_OFFLINE: "1", TMPDIR: run, ECHOINK_AGENT_CAPABILITIES_FIXTURE_ROOT: run } });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(run, { recursive: true, force: true });
}
