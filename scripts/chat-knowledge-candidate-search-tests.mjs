import { desktopNodeTestBanner, desktopNodeTestAliases } from "./desktop-node-test-host.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = await mkdtemp(path.join(tmpdir(), "echoink-candidate-search-runner-"));
try {
  await symlink(path.join(rootDir, "node_modules"), path.join(outputDir, "node_modules"), "dir");
  const outputFile = path.join(outputDir, "candidate-search.mjs");
  await esbuild.build({
    banner: { js: `${desktopNodeTestBanner.js}\nglobalThis.window = globalThis;` },
    stdin: { contents: 'import { runChatKnowledgeCandidateSearchTests } from "./src/tests/chat-knowledge-candidate-search";\nawait runChatKnowledgeCandidateSearchTests();',
      resolveDir: rootDir, sourcefile: "candidate-search-entry.ts", loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", alias: desktopNodeTestAliases,
    external: ["jsdom", "yaml"], loader: { ".md": "text", ".svg": "text", ".webp": "dataurl" },
    outfile: outputFile, logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [outputFile], { cwd: rootDir, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(outputDir, { recursive: true, force: true }); }
