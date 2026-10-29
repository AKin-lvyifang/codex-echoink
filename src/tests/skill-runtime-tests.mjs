import { desktopNodeTestBanner, desktopNodeTestAliases } from "../../scripts/desktop-node-test-host.mjs";
import { disposableTestOutputRoot } from "../../scripts/disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = disposableTestOutputRoot(path.join(rootDir, ".tmp"));
const outputFile = path.join(outputDir, "skill-runtime-tests.mjs");

await mkdir(outputDir, { recursive: true });
await esbuild.build({ banner: desktopNodeTestBanner, alias: desktopNodeTestAliases,
  stdin: {
    contents: [
      'import { runSkillRuntimeScenarios } from "./src/tests/skill-runtime";',
      "await runSkillRuntimeScenarios();"
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "skill-runtime-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  loader: { ".md": "text" },
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
