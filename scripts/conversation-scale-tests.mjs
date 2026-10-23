import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = disposableTestOutputRoot(path.join(rootDir, ".tmp"));
const outputFile = path.join(outputDir, "conversation-scale-tests.mjs");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import { runProductRunScaleTests } from "./src/tests/pi-native/product-run-scale";',
      'import { runPiConversationStartupTests } from "./src/tests/pi-native/conversation-startup";',
      'import { runPiConversationTabsTests } from "./src/tests/pi-native/conversation-tabs";',
      "await runProductRunScaleTests();",
      "await runPiConversationStartupTests();",
      "await runPiConversationTabsTests();",
      'console.log("Conversation scale acceptance: PASS");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "conversation-scale-test-entry.ts",
    loader: "ts"
  },
  loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
  bundle: true,
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
    name: "conversation-scale-test-shims",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: path.join(rootDir, "src", "tests", "obsidian-shim.ts")
      }));
    }
  }],
  outfile: outputFile,
  logLevel: "silent"
});

const result = spawnSync(process.execPath, [outputFile], {
  cwd: rootDir,
  stdio: "inherit"
});

process.exit(result.status ?? 1);
