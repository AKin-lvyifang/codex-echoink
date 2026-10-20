import { spawnSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const testRoot = process.env.ECHOINK_MEMORY_TEST_ROOT;
if (!testRoot) throw new Error("Set ECHOINK_MEMORY_TEST_ROOT to the registered task directory under ~/EchoInk-TestVaults/90-任务临时");
const allowedRoot = await realpath(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时"));
const outputRoot = await realpath(testRoot);
const relative = path.relative(allowedRoot, outputRoot);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Memory test root must be a child of 90-任务临时");
if (await realpath(process.env.TMPDIR || "") !== outputRoot) throw new Error("TMPDIR must match ECHOINK_MEMORY_TEST_ROOT");
const outputDir = path.join(outputRoot, "runtime-local-checks");
const runtimeDependencyPlugin = { name: "runtime-test-dependencies", setup(build) {
  build.onResolve({ filter: /^(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent)(?:\/.*)?|yaml)$/ }, (args) => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }));
  build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(rootDir, "src/tests/obsidian-shim.ts") }));
} };
const outputFile = path.join(outputDir, "agent-self-tests.mjs");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import { runAgentSelfMigrationScenarios } from "./src/tests/agent-self-migration";',
      "await runAgentSelfMigrationScenarios();"
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "agent-self-test-entry.ts",
    loader: "ts"
  },
  plugins: [runtimeDependencyPlugin],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: outputFile,
  loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
