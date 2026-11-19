import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const outputDir = await mkdtemp(path.join(tmpdir(), "echoink-chat-candidates-runner-"));
try {
  const outputFile = path.join(outputDir, "chat-knowledge-candidates.mjs");
  await esbuild.build({
    banner: { js: `${desktopNodeTestBanner.js}\nglobalThis.window = globalThis;` },
    stdin: {
      contents: 'import { runChatKnowledgeCandidatesTests } from "./src/tests/chat-knowledge-candidates";\nawait runChatKnowledgeCandidatesTests();',
      resolveDir: rootDir, sourcefile: "chat-knowledge-candidates-entry.ts", loader: "ts"
    },
    bundle: true, platform: "node", target: "node22", format: "esm",
    // These in-memory cases need only the desktop flag used by path bindings.
    plugins: [{ name: "candidate-desktop-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "candidate-host" }));
      build.onLoad({ filter: /.*/, namespace: "candidate-host" }, () => ({
        contents: "export const Platform = { isDesktop: true };", loader: "js"
      }));
    } }],
    outfile: outputFile, logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [outputFile], {
    cwd: rootDir, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
