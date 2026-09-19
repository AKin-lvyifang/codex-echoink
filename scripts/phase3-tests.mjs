import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "knowledge-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");
const homeWorkbenchOnly = process.argv.includes("--home-workbench");
const workspaceDataOnly = process.argv.includes("--workspace-data");
const maintenanceRuntimeOnly = process.argv.includes("--maintenance-runtime");
const maintenanceOnly = process.argv.includes("--production-maintenance");
const wikiTodoOnly = process.argv.includes("--wiki-todo");
const nativeJournalOnly = process.argv.includes("--native-journal");

const fullSuiteImports = [
  'import { runKnowledgeAssociativeReadingTests } from "./src/tests/knowledge-associative-reading";',
  'import { runPhase3KnowledgeRetrieverTests } from "./src/tests/phase3-knowledge-retriever";',
  'import { runKnowledgeAgentIndexTests } from "./src/tests/knowledge-agent-index";',
  'import { runKnowledgeMaintenancePreferenceTests } from "./src/tests/knowledge-maintenance-preferences";',
  'import { runPiKnowledgeReadToolTests } from "./src/tests/pi-native/knowledge-read-tools";',
  'import { runPhase3KnowledgeMaintenanceServiceTests } from "./src/tests/pi-native/phase3-maintenance-service";',
  'import { runKnowledgeInitializationTests } from "./src/tests/knowledge-initialization";',
  'import { runNativeJournalTests } from "./src/tests/native-journal";'
];
const fullSuiteRuns = [
  "await runKnowledgeAssociativeReadingTests();",
  "await runKnowledgeAgentIndexTests();",
  "await runKnowledgeMaintenancePreferenceTests();",
  "await runPiKnowledgeReadToolTests();",
  "await runPhase3KnowledgeRetrieverTests();",
  "await runPhase3KnowledgeMaintenanceServiceTests();",
  "await runKnowledgeInitializationTests();",
  "await runNativeJournalTests();"
];

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: (process.argv.includes("--bilingual-lifecycle") ? [
      'import { runKnowledgeBilingualLifecycleTests } from "./src/tests/knowledge-bilingual-lifecycle";',
      'await runKnowledgeBilingualLifecycleTests();'
    ] : maintenanceRuntimeOnly ? [
      'import { runKnowledgeMaintenanceRuntimeTests } from "./src/tests/pi-native/pi-native-conversation-runtime";',
      'import { runVaultDomainServiceTests } from "./src/tests/pi-native/vault-domain-service";',
      'await runKnowledgeMaintenanceRuntimeTests();',
      'await runVaultDomainServiceTests();',
      'import { runKnowledgeAgentIndexTests } from "./src/tests/knowledge-agent-index";',
      'await runKnowledgeAgentIndexTests();'
    ] : wikiTodoOnly ? [
      'import { runWikiBilingualTests } from "./src/tests/wiki-bilingual";',
      'import { runKnowledgeInitializationTests } from "./src/tests/knowledge-initialization";',
      'import { runHomeTodoTests } from "./src/tests/home-todos";',
      'import { runWikiStructurePreflightTests } from "./src/tests/pi-native/pi-native-conversation-runtime";',
      'await runWikiStructurePreflightTests();',
      'await runWikiBilingualTests();',
      'await runKnowledgeInitializationTests();',
      'await runHomeTodoTests();'
    ] : workspaceDataOnly ? [
      'import { runHomeWorkspaceDataTests } from "./src/tests/home-workspace-data";',
      'await runHomeWorkspaceDataTests();'
    ] : maintenanceOnly ? [
      'import { runPhase3KnowledgeMaintenanceServiceTests } from "./src/tests/pi-native/phase3-maintenance-service";',
      'await runPhase3KnowledgeMaintenanceServiceTests();'
    ] : nativeJournalOnly ? [
      'import { runNativeJournalTests } from "./src/tests/native-journal";',
      "await runNativeJournalTests();"
    ] : [
      ...(homeWorkbenchOnly ? [] : fullSuiteImports),
      'import { runHomeWorkbenchTests } from "./src/tests/home-workbench";',
      "await runHomeWorkbenchTests();",
      ...(homeWorkbenchOnly ? [] : fullSuiteRuns),
      `console.log(${JSON.stringify(homeWorkbenchOnly
        ? "Home workbench acceptance: PASS"
        : "Current Knowledge query and maintenance acceptance: PASS")});`
    ]).join("\n"),
    resolveDir: rootDir,
    sourcefile: "knowledge-test-entry.ts",
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
    name: "knowledge-test-shims",
    setup(build) {
      // Node business fixtures retain the real action handlers while using
      // the shared DOM adapter; Origin/Radix rendering has browser coverage.
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({
        path: path.join(rootDir, "src/tests/origin-controls-shim.ts")
      }));
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
