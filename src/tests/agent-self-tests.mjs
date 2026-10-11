import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
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
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: outputFile,
  loader: { ".md": "text" },
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
