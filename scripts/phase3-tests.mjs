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
  'import { runKnowledgeBodySearchTests, runKnowledgeBodySearchCacheTests, runKnowledgeBodySearchSchedulingTests, runKnowledgeBodySearchInvalidationTests, runKnowledgeBodySearchConcurrencyTests, runKnowledgeBodySearchTopicTests, runKnowledgeBodySearchBoilerplateTests, runKnowledgeBodySearchMetadataTests, runKnowledgeBodySearchReferenceTests, runKnowledgeBodySearchReferenceBoundaryTests, runKnowledgeBodySearchOutlineTests, runKnowledgeBodySearchOutlineEligibilityTests } from "./src/tests/knowledge-body-search";',
  'import { runVaultBodySearchTests, runVaultBodySearchCacheTests, runVaultBodySearchConcurrencyTests, runVaultBodySearchMetadataTests, runVaultBodySearchReferenceTests, runVaultBodySearchOutlineTests } from "./src/tests/vault-body-search";',
  'import { runKnowledgeFolderPlanTests } from "./src/tests/knowledge-folder-plans";',
  'import { runKnowledgeFolderSettingsTests } from "./src/tests/knowledge-folder-settings";',
  'import { runKnowledgeFolderOrganizationTests } from "./src/tests/knowledge-folder-organization";',
  'import { runKnowledgeFolderBindingsTests } from "./src/tests/knowledge-folder-bindings";',
  'import { runKnowledgeAssociativeReadingTests } from "./src/tests/knowledge-associative-reading";',
  'import { runPhase3KnowledgeRetrieverTests } from "./src/tests/phase3-knowledge-retriever";',
  'import { runKnowledgeAgentIndexTests } from "./src/tests/knowledge-agent-index";',
  'import { runKnowledgeMaintenancePreferenceTests } from "./src/tests/knowledge-maintenance-preferences";',
  'import { runPiKnowledgeReadToolTests, runPiKnowledgeMetadataToolTests, runPiKnowledgeReferenceToolTests, runPiKnowledgeOutlineBudgetTests } from "./src/tests/pi-native/knowledge-read-tools";',
  'import { runPhase3KnowledgeMaintenanceServiceTests } from "./src/tests/pi-native/phase3-maintenance-service";',
  'import { runKnowledgeInitializationTests } from "./src/tests/knowledge-initialization";',
  'import { runNativeJournalTests } from "./src/tests/native-journal";'
];
const fullSuiteRuns = [
  "await runKnowledgeBodySearchOutlineEligibilityTests();",
  "await runKnowledgeBodySearchOutlineTests();",
  "await runVaultBodySearchOutlineTests();",
  "await runPiKnowledgeOutlineBudgetTests();",
  "await runKnowledgeBodySearchReferenceBoundaryTests();",
  "await runKnowledgeBodySearchReferenceTests();",
  "await runVaultBodySearchReferenceTests();",
  "await runPiKnowledgeReferenceToolTests();",
  "await runKnowledgeBodySearchMetadataTests();",
  "await runVaultBodySearchMetadataTests();",
  "await runPiKnowledgeMetadataToolTests();",
  "await runKnowledgeBodySearchBoilerplateTests();",
  "await runKnowledgeBodySearchTopicTests();",
  "await runKnowledgeBodySearchConcurrencyTests();",
  "await runVaultBodySearchConcurrencyTests();",
  "await runKnowledgeBodySearchInvalidationTests();",
  "await runKnowledgeBodySearchSchedulingTests();",
  "await runKnowledgeBodySearchCacheTests();",
  "await runVaultBodySearchCacheTests();",
  "await runVaultBodySearchTests();",
  "await runKnowledgeFolderPlanTests();",
  "await runKnowledgeFolderSettingsTests();",
  "await runKnowledgeFolderOrganizationTests();",
  "await runKnowledgeFolderBindingsTests();",
  "await runKnowledgeAssociativeReadingTests();",
  "await runKnowledgeAgentIndexTests();",
  "await runKnowledgeMaintenancePreferenceTests();",
  "await runPiKnowledgeReadToolTests();",
  "await runPhase3KnowledgeRetrieverTests();",
  "await runPhase3KnowledgeMaintenanceServiceTests();",
  "await runKnowledgeInitializationTests();",
  "await runNativeJournalTests();",
  "await runKnowledgeBodySearchTests();"
];

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: (process.argv.includes("--body-search-outline-eligibility") ? [
      'import { runKnowledgeBodySearchOutlineEligibilityTests } from "./src/tests/knowledge-body-search";',
      'await runKnowledgeBodySearchOutlineEligibilityTests();'
    ] : process.argv.includes("--body-search-outline") ? [
      'import { runKnowledgeBodySearchOutlineTests, runKnowledgeBodySearchOutlineEligibilityTests, runKnowledgeBodySearchTests, runKnowledgeBodySearchMetadataTests, runKnowledgeBodySearchReferenceTests, runKnowledgeBodySearchReferenceBoundaryTests, runKnowledgeBodySearchCacheTests, runKnowledgeBodySearchConcurrencyTests } from "./src/tests/knowledge-body-search";',
      'import { runVaultBodySearchOutlineTests, runVaultBodySearchTests, runVaultBodySearchMetadataTests, runVaultBodySearchReferenceTests, runVaultBodySearchCacheTests, runVaultBodySearchConcurrencyTests } from "./src/tests/vault-body-search";',
      'import { runPiKnowledgeOutlineBudgetTests, runPiKnowledgeReadToolTests, runPiKnowledgeMetadataToolTests, runPiKnowledgeReferenceToolTests } from "./src/tests/pi-native/knowledge-read-tools";',
      'await runKnowledgeBodySearchOutlineTests();',
      'await runKnowledgeBodySearchOutlineEligibilityTests();',
      'await runVaultBodySearchOutlineTests();',
      'await runPiKnowledgeOutlineBudgetTests();',
      'await runKnowledgeBodySearchTests();',
      'await runKnowledgeBodySearchMetadataTests();',
      'await runKnowledgeBodySearchReferenceTests();',
      'await runKnowledgeBodySearchReferenceBoundaryTests();',
      'await runKnowledgeBodySearchCacheTests();',
      'await runKnowledgeBodySearchConcurrencyTests();',
      'await runVaultBodySearchTests();',
      'await runVaultBodySearchMetadataTests();',
      'await runVaultBodySearchReferenceTests();',
      'await runVaultBodySearchCacheTests();',
      'await runVaultBodySearchConcurrencyTests();',
      'await runPiKnowledgeReadToolTests();',
      'await runPiKnowledgeMetadataToolTests();',
      'await runPiKnowledgeReferenceToolTests();'
    ] : process.argv.includes("--body-search-reference-boundary") ? [
      'import { runKnowledgeBodySearchReferenceBoundaryTests } from "./src/tests/knowledge-body-search";',
      'await runKnowledgeBodySearchReferenceBoundaryTests();'
    ] : process.argv.includes("--body-search-reference") ? [
      'import { runKnowledgeBodySearchReferenceTests, runKnowledgeBodySearchReferenceBoundaryTests, runKnowledgeBodySearchMetadataTests, runKnowledgeBodySearchTests, runKnowledgeBodySearchCacheTests, runKnowledgeBodySearchConcurrencyTests } from "./src/tests/knowledge-body-search";',
      'import { runVaultBodySearchReferenceTests, runVaultBodySearchMetadataTests, runVaultBodySearchTests, runVaultBodySearchCacheTests, runVaultBodySearchConcurrencyTests } from "./src/tests/vault-body-search";',
      'import { runPiKnowledgeReferenceToolTests, runPiKnowledgeMetadataToolTests, runPiKnowledgeReadToolTests } from "./src/tests/pi-native/knowledge-read-tools";',
      'await runKnowledgeBodySearchReferenceTests();',
      'await runKnowledgeBodySearchReferenceBoundaryTests();',
      'await runVaultBodySearchReferenceTests();',
      'await runPiKnowledgeReferenceToolTests();',
      'await runKnowledgeBodySearchMetadataTests();',
      'await runVaultBodySearchMetadataTests();',
      'await runPiKnowledgeMetadataToolTests();',
      'await runKnowledgeBodySearchTests();',
      'await runKnowledgeBodySearchCacheTests();',
      'await runKnowledgeBodySearchConcurrencyTests();',
      'await runVaultBodySearchTests();',
      'await runVaultBodySearchCacheTests();',
      'await runVaultBodySearchConcurrencyTests();',
      'await runPiKnowledgeReadToolTests();'
    ] : process.argv.includes("--body-search-metadata") ? [
      'import { runKnowledgeBodySearchMetadataTests, runKnowledgeBodySearchTests, runKnowledgeBodySearchCacheTests, runKnowledgeBodySearchTopicTests, runKnowledgeBodySearchBoilerplateTests } from "./src/tests/knowledge-body-search";',
      'import { runVaultBodySearchMetadataTests, runVaultBodySearchTests, runVaultBodySearchCacheTests } from "./src/tests/vault-body-search";',
      'import { runPiKnowledgeMetadataToolTests, runPiKnowledgeReadToolTests } from "./src/tests/pi-native/knowledge-read-tools";',
      'await runKnowledgeBodySearchMetadataTests();',
      'await runVaultBodySearchMetadataTests();',
      'await runPiKnowledgeMetadataToolTests();',
      'await runKnowledgeBodySearchTests();',
      'await runKnowledgeBodySearchCacheTests();',
      'await runKnowledgeBodySearchTopicTests();',
      'await runKnowledgeBodySearchBoilerplateTests();',
      'await runVaultBodySearchTests();',
      'await runVaultBodySearchCacheTests();',
      'await runPiKnowledgeReadToolTests();'
    ] : process.argv.includes("--body-search-boilerplate") ? [
      'import { runKnowledgeBodySearchBoilerplateTests } from "./src/tests/knowledge-body-search";',
      'await runKnowledgeBodySearchBoilerplateTests();'
    ] : process.argv.includes("--body-search-topic") ? [
      'import { runKnowledgeBodySearchTopicTests } from "./src/tests/knowledge-body-search";',
      'await runKnowledgeBodySearchTopicTests();'
    ] : process.argv.includes("--body-search-concurrency") ? [
      'import { runKnowledgeBodySearchConcurrencyTests } from "./src/tests/knowledge-body-search";',
      'import { runVaultBodySearchConcurrencyTests } from "./src/tests/vault-body-search";',
      'await runKnowledgeBodySearchConcurrencyTests();',
      'await runVaultBodySearchConcurrencyTests();'
    ] : process.argv.includes("--maintenance-fingerprints") ? [
      'import { runMaintenanceReadFingerprintTests } from "./src/tests/pi-native/phase3-maintenance-service";',
      'await runMaintenanceReadFingerprintTests();'
    ] : process.argv.includes("--submission-cancellation") ? [
      'import { runPiSubmissionCancellationTests } from "./src/tests/pi-native/pi-native-conversation-runtime";',
      'import { runPiPluginConversationBoundaryTests } from "./src/tests/pi-native/plugin-conversation-boundary";',
      'import { runPiNativeTurnRunnerTests } from "./src/tests/pi-native/turn-runner";',
      'await runPiSubmissionCancellationTests();',
      'await runPiPluginConversationBoundaryTests();',
      'await runPiNativeTurnRunnerTests();'
    ] : process.argv.includes("--body-search-scheduling") ? [
      'import { runKnowledgeBodySearchSchedulingTests, runKnowledgeBodySearchCacheTests, runKnowledgeBodySearchInvalidationTests } from "./src/tests/knowledge-body-search";',
      'import { runVaultBodySearchTests, runVaultBodySearchCacheTests } from "./src/tests/vault-body-search";',
      'await runKnowledgeBodySearchSchedulingTests();',
      'await runKnowledgeBodySearchInvalidationTests();',
      'await runKnowledgeBodySearchCacheTests();',
      'await runVaultBodySearchCacheTests();',
      'await runVaultBodySearchTests();'
    ] : process.argv.includes("--body-search-cache") ? [
      'import { runKnowledgeBodySearchCacheTests } from "./src/tests/knowledge-body-search";',
      'import { runVaultBodySearchTests, runVaultBodySearchCacheTests } from "./src/tests/vault-body-search";',
      'await runKnowledgeBodySearchCacheTests();',
      'await runVaultBodySearchCacheTests();',
      'await runVaultBodySearchTests();'
    ] : process.argv.includes("--folder-settings") ? [
      'import { runKnowledgeFolderSettingsTests } from "./src/tests/knowledge-folder-settings";',
      'await runKnowledgeFolderSettingsTests();'
    ] : process.argv.includes("--folder-organization") ? [
      'import { runKnowledgeFolderOrganizationTests } from "./src/tests/knowledge-folder-organization";',
      'await runKnowledgeFolderOrganizationTests();'
    ] : process.argv.includes("--folder-plans") ? [
      'import { runKnowledgeFolderPlanTests } from "./src/tests/knowledge-folder-plans";',
      'await runKnowledgeFolderPlanTests();'
    ] : process.argv.includes("--folder-bindings") ? [
      'import { runKnowledgeFolderBindingsTests } from "./src/tests/knowledge-folder-bindings";',
      'await runKnowledgeFolderBindingsTests();'
    ] : process.argv.includes("--bilingual-lifecycle") ? [
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
    ".svg": "text",
    ".webp": "dataurl"
  },
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "yaml",
    "jsdom"
  ],
  plugins: [{
    name: "knowledge-test-shims",
    setup(build) {
      if (process.argv.includes("--submission-cancellation")) build.onResolve({ filter: /provider-brand-icons$/ }, () => ({
        path: path.join(rootDir, "src", "tests", "composer-provider-brand-shim.ts")
      }));
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
