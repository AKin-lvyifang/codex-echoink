import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryVaults = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
const requestedRoot = process.env.ECHOINK_APPROVAL_PRESENTATION_TEST_ROOT?.trim() || process.env.ECHOINK_WORKBENCH_TEST_ROOT?.trim() || path.join(temporaryVaults, "工作台改版-20261017");
const fixture = await realpath(requestedRoot);
const relativeFixture = path.relative(temporaryVaults, fixture);
if (!relativeFixture || relativeFixture === ".." || relativeFixture.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFixture) || !(await stat(fixture)).isDirectory()) {
  throw new Error("Approval presentation fixtures must use an existing directory inside EchoInk-TestVaults/90-任务临时");
}
const run = await mkdtemp(path.join(fixture, ".approval-presentation-"));
try {
  const outfile = path.join(run, "approval-presentation-tests.mjs");
  await esbuild.build({ banner: desktopNodeTestBanner,
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
