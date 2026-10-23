import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const run = await mkdtemp(path.join(tmpdir(), "answer-markdown-"));
try {
  const output = path.join(run, "tests.mjs");
  await esbuild.build({
    entryPoints: ["src/tests/answer-markdown.ts"], absWorkingDir: repo,
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
    banner: { js: `import {createRequire as createTestRequire} from "node:module"; const require = createTestRequire(${JSON.stringify(path.join(repo, "package.json"))});` },
    alias: { obsidian: path.join(repo, "src/tests/obsidian-shim.ts") },
    loader: { ".svg": "dataurl", ".webp": "dataurl", ".md": "text" },
    external: ["jsdom"], logLevel: "silent"
  });
  const { runAnswerMarkdownTests } = await import(pathToFileURL(output).href);
  await runAnswerMarkdownTests();
} finally {
  await rm(run, { recursive: true, force: true });
}
