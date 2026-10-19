import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_ONBOARDING_TEST_ROOT) throw new Error("Explicit ECHOINK_ONBOARDING_TEST_ROOT is required");
const allowed = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
const requested = path.resolve(process.env.ECHOINK_ONBOARDING_TEST_ROOT);
if (!requested.startsWith(allowed + path.sep)) throw new Error("Use disposable test Vaults");
await mkdir(requested, { recursive: true });
const fixture = await realpath(requested);
if (!fixture.startsWith(allowed + path.sep)) throw new Error("Fixture symlinks cannot leave disposable test Vaults");
const run = await mkdtemp(path.join(fixture, "desktop-onboarding-"));
try {
  const output = path.join(run, "tests.mjs");
  await esbuild.build({ entryPoints: [path.join(repo, "src/tests/desktop-onboarding.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl", ".txt": "text" },
    plugins: [{ name: "onboarding-model-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repo, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => { const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
    } }], logLevel: "silent" });
  const tests = await import(pathToFileURL(output).href);
  await tests.runDesktopOnboardingTests(run);
} finally { await rm(run, { recursive: true, force: true }); }
