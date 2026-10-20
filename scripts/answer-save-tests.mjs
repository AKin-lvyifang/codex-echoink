import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const configuredRoot = process.env.ECHOINK_ANSWER_SAVE_TEST_ROOT || process.env.TMPDIR || tmpdir();
await mkdir(configuredRoot, { recursive: true });
const root = await realpath(configuredRoot);
const run = await mkdtemp(path.join(root, "answer-save-"));
try {
  const output = path.join(run, "tests.mjs");
  await esbuild.build({
    entryPoints: ["src/tests/answer-save.ts"], absWorkingDir: repo,
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
    banner: { js: `import {createRequire as createAnswerSaveRequire} from "node:module"; const require = createAnswerSaveRequire(${JSON.stringify(path.join(repo, "package.json"))});` },
    alias: { obsidian: path.join(repo, "src/tests/obsidian-shim.ts") },
    logLevel: "silent"
  });
  const { runAnswerSaveTests } = await import(pathToFileURL(output).href);
  await runAnswerSaveTests(path.join(run, "fixtures"));
} finally {
  await rm(run, { recursive: true, force: true });
}
