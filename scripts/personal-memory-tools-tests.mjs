import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = disposableTestOutputRoot(path.join(rootDir, ".tmp"));
const outputFile = path.join(outputDir, "personal-memory-tools-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");

await mkdir(outputDir, { recursive: true });
await esbuild.build({ banner: desktopNodeTestBanner,
  stdin: {
    contents: [
      'import { runPersonalMemoryToolContractScenarios } from "./src/tests/personal-memory-tools";',
      "await runPersonalMemoryToolContractScenarios();",
      'console.log("Personal Memory tools acceptance: PASS");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "personal-memory-tools-test-entry.ts",
    loader: "ts"
  },
  bundle: true,
  loader: {
    ".md": "text",
    ".webp": "dataurl"
  },
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml"
  ],
  plugins: [{
    name: "personal-memory-tools-test-shims",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: obsidianShimPath
      }));
    }
  }],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  env: {
    ...process.env,
    PI_OFFLINE: "1"
  },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
