import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.ECHOINK_KNOWLEDGE_TEST_ROOT)
  throw new Error("Set an explicit disposable ECHOINK_KNOWLEDGE_TEST_ROOT.");
const output = path.join(process.env.ECHOINK_KNOWLEDGE_TEST_ROOT, "knowledge-system");
await mkdir(output, { recursive: true });
const entry = path.join(output, "test.mjs");
await esbuild.build({
  stdin: {
    contents: `
      import { runKnowledgePreferenceWizardTests } from './src/tests/knowledge-preference-wizard';
      import { runKnowledgeDeepRepairTests } from './src/tests/knowledge-deep-repair';
      import { runKnowledgeHealthTests } from './src/tests/knowledge-health';
      import { runKnowledgeCheckupTests } from './src/tests/knowledge-checkup';
      import { runKnowledgeDeepCheckupTests } from './src/tests/knowledge-deep-checkup';
      import { runKnowledgeSystemMoveTests } from './src/tests/knowledge-system-move';
      import { runKnowledgeSystemTaskTests } from './src/tests/knowledge-system-task';
      import { runKnowledgeSystemTests } from './src/tests/knowledge-system';
      await runKnowledgeSystemTests(${JSON.stringify(output)});
      await runKnowledgeSystemTaskTests();
      await runKnowledgeSystemMoveTests();
      await runKnowledgeCheckupTests();
      runKnowledgeHealthTests();
      await runKnowledgeDeepRepairTests();
      await runKnowledgePreferenceWizardTests(${JSON.stringify(output)});
      await runKnowledgeDeepCheckupTests();
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: entry,
  alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
  external: ["electron"],
  plugins: [
    {
      name: "system-test-pi",
      setup(build) {
        build.onResolve({ filter: /^@earendil-works\/pi-/ }, (args) => ({
          path: fileURLToPath(import.meta.resolve(args.path)),
          external: true,
        }));
      },
    },
  ],
  banner: {
    js: `import { createRequire } from 'node:module';const require=createRequire(${JSON.stringify(path.join(root, "package.json"))});`,
  },
});
const result = spawnSync(process.execPath, [entry], { cwd: root, stdio: "inherit" });
process.exitCode = result.status ?? 1;
