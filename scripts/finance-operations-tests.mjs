import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(disposableTestOutputRoot(path.join(root, ".tmp")), { recursive: true });
const directory = await mkdtemp(path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "finance-operations-"));
try {
  const target = path.join(directory, "tests.mjs");
  const contents = [
    'import { runFinanceOperationsServiceTests, runFinanceOperationsToolTests, runFinanceFreshMobileBaselineTest } from "./src/tests/finance-operations";',
    'import { runFinanceOperationsPipelineTests } from "./src/tests/pi-native/finance-operations-pipeline";',
    'import { runPiNativePromptEntryStartupTests, runPiNativeConversationRuntimeTests } from "./src/tests/pi-native/pi-native-conversation-runtime";',
    ...(process.argv.includes("--runtime") ? ["await runPiNativeConversationRuntimeTests();"] : [
      `await runFinanceOperationsServiceTests(${JSON.stringify(path.join(directory, "vault"))});`,
      `await runFinanceOperationsToolTests(${JSON.stringify(path.join(directory, "tools"))});`,
      "await runFinanceFreshMobileBaselineTest();",
      `await runFinanceOperationsPipelineTests(${JSON.stringify(path.join(directory, "pipeline"))});`,
      "await runPiNativePromptEntryStartupTests();"
    ])
  ].join("\n");
  await esbuild.build({ stdin: { contents, resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: target, external: ["jsdom", "yaml", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai/providers/faux"], banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root, "package.json"))});` }, alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }, loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" } });
  const run = spawnSync(process.execPath, [target], { stdio: "inherit" });
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
