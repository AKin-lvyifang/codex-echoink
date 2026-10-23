import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const configured = process.env.ECHOINK_GENERATION_TEST_ROOT;
if (!configured || !path.isAbsolute(configured)) throw new Error("Set ECHOINK_GENERATION_TEST_ROOT to the explicitly authorized disposable test Vault.");
const fixture = await mkdtemp(path.join(configured, ".generation-unit-"));
const tempRoot = disposableTestOutputRoot(path.join(root, ".tmp")); await mkdir(tempRoot, { recursive: true });
const directory = await mkdtemp(path.join(tempRoot, "generation-tests-"));
try {
  const file = path.join(directory, "tests.mjs");
  await esbuild.build({ stdin: { contents: 'import { runGenerationTests } from "./src/tests/generation"; import { runGenerationRuntimeTests } from "./src/tests/pi-native/pi-native-conversation-runtime"; await runGenerationTests(process.env.GENERATION_FIXTURE_ROOT); await runGenerationRuntimeTests();', resolveDir: root, sourcefile: "generation-test-entry.ts", loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml", "jsdom"],
    loader: { ".md": "text", ".svg": "text", ".webp": "dataurl" },
    plugins: [{ name: "generation-host-shim", setup(build) { build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src/tests/origin-controls-shim.ts") })); build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") })); } }], outfile: file, logLevel: "silent" });
  const run = spawnSync(process.execPath, [file], { cwd: root, env: { ...process.env, PI_OFFLINE: "1", GENERATION_FIXTURE_ROOT: fixture, TMPDIR: fixture }, stdio: "inherit" });
  process.exitCode = run.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true }); }
