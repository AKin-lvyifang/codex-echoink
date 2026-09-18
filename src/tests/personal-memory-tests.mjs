import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const outputDir = path.join(rootDir, ".tmp");
const outputFile = path.join(outputDir, "personal-memory-tests.mjs");
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");

await mkdir(outputDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      'import assert from "node:assert/strict";',
      'import { withPersonalMemoryFixture } from "./src/tests/personal-memory-fixture";',
      'import { runMemoryRecallHarnessContractScenarios } from "./src/tests/memory-recall-harness";',
      'import { runPersonalMemoryToolContractScenarios } from "./src/tests/personal-memory-tools";',
      'import { runPersonalMemoryCorrectionTests } from "./src/tests/personal-memory-correction";',
      'import { runPersonalMemoryPathSafetyScenarios } from "./src/tests/personal-memory-path-safety";',
      'import { runAgentSelfMigrationScenarios } from "./src/tests/agent-self-migration";',
      'import { runDreamGrowthScenarios } from "./src/tests/dream-growth";',
      'import { runDreamLedgerScenarios } from "./src/tests/dream-ledger";',
      'import { buildEchoInkSystemConstitutionPrompt } from "./src/harness/memory/personal-memory-contracts";',
      "await runMemoryRecallHarnessContractScenarios();",
      "await runPersonalMemoryToolContractScenarios();",
      "await runPersonalMemoryCorrectionTests();",
      "await runPersonalMemoryPathSafetyScenarios();",
      "await runAgentSelfMigrationScenarios();",
      "await runDreamGrowthScenarios();",
      "await runDreamLedgerScenarios();",
      "await withPersonalMemoryFixture(async (fixture) => {",
      "  const fixed = await fixture.repository.loadFixedContext({ memoryMode: 'normal' });",
      "  assert.ok(fixed.agent && fixed.user && fixed.memory);",
      "  assert.match(fixture.repository.layout.agent, /AGENT\\.md$/u);",
      "  assert.match(fixture.repository.layout.user, /USER\\.md$/u);",
      "  assert.match(fixture.repository.layout.memory, /MEMORY\\.md$/u);",
      "  assert.equal(Object.hasOwn(fixed, 'personalityState'), false);",
      "});",
      "const constitutionPrompt = buildEchoInkSystemConstitutionPrompt();",
      "assert.match(constitutionPrompt, /产品身份与使命/u);",
      "assert.match(constitutionPrompt, /不得虚构事实、来源、引用、执行过程、Tool 结果或写入成功/u);",
      "assert.doesNotMatch(constitutionPrompt, /targetId|nextCursor|outcome=created/u);",
      'console.log("Current file-based Personal Memory acceptance: PASS");'
    ].join("\n"),
    resolveDir: rootDir,
    sourcefile: "personal-memory-test-entry.ts",
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
  plugins: [{
    name: "personal-memory-obsidian-stub",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianShimPath }));
    }
  }],
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

if (result.status !== 0) process.exit(result.status ?? 1);

const identityPathsResult = spawnSync(process.execPath, [path.join(rootDir, "src/tests/agent-identity-paths-tests.mjs")], {
  cwd: rootDir,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: "inherit"
});
process.exit(identityPathsResult.status ?? 1);
