import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const started = performance.now();
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = await mkdtemp(path.join(tmpdir(), "echoink-linking-runner-"));
let status = 1;
try {
  // Keep generated files out of the shared checkout; external dependencies remain
  // the already-installed repository dependencies, reached through this temp link.
  await symlink(path.join(rootDir, "node_modules"), path.join(outputDir, "node_modules"), "dir");
  const outputFile = path.join(outputDir, "knowledge-linking.mjs");
  await esbuild.build({
    stdin: {
      contents: 'import { runKnowledgeLinkingTests } from "./src/tests/knowledge-linking";\nimport { runKnowledgeLinkingProductionTests } from "./src/tests/knowledge-linking-production";\nimport { runKnowledgeLinkingProgressTests } from "./src/tests/knowledge-linking-progress";\nimport { runKnowledgeFolderSettingsTests } from "./src/tests/knowledge-folder-settings";\nawait runKnowledgeLinkingTests();\nawait runKnowledgeLinkingProductionTests();\nawait runKnowledgeLinkingProgressTests();\nawait runKnowledgeFolderSettingsTests();',
      resolveDir: rootDir, sourcefile: "knowledge-linking-entry.ts", loader: "ts"
    },
    bundle: true, platform: "node", target: "node22", format: "esm",
    loader: { ".md": "text", ".svg": "text", ".webp": "dataurl" },
    external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml", "jsdom"],
    plugins: [{ name: "source-characterization-host-shim", setup(build) {
      build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(rootDir, "src/tests/origin-controls-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(rootDir, "src/tests/obsidian-shim.ts") }));
    } }],
    outfile: outputFile, logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [outputFile], { cwd: rootDir, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  await rm(outputDir, { recursive: true, force: true });
  console.log(`Knowledge linking command elapsedMs=${Math.round(performance.now() - started)}; exit=${status}.`);
}
process.exitCode = status;
