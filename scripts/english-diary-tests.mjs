import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = path.join(root, ".tmp");
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(path.join(temporaryRoot, "english-diary-tests-"));
const outputFile = path.join(directory, "tests.mjs");
try {
  await esbuild.build({
    stdin: {
      contents: [
        'import { JSDOM } from "jsdom";',
        'import { runEnglishDiaryServiceTests } from "./src/tests/english-diary-service";',
        'import { runEnglishDiaryRepositoryTests } from "./src/tests/english-diary-repository";',
        'import { runEnglishDiaryVaultPortTests } from "./src/tests/english-diary-vault-port";',
        'import { runEnglishDiaryActivityTests } from "./src/tests/english-diary-activity";',
        'import { runDailyExpressionTests } from "./src/tests/english-diary-daily-expression";',
        'import { runEnglishDiaryReadingTests } from "./src/tests/english-diary-reading";',
        'runDailyExpressionTests();',
        'console.log("English Diary daily expression: PASS");',
        'const dom = new JSDOM("<!doctype html><html><body></body></html>");',
        'try { await runEnglishDiaryReadingTests(dom.window.document); } finally { dom.window.close(); }',
        'console.log("English Diary rendered Markdown alignment: PASS");',
        "runEnglishDiaryActivityTests();",
        'console.log("English Diary activity statistics: PASS");',
        "await runEnglishDiaryServiceTests();",
        'console.log("English Diary service: PASS");',
        "await runEnglishDiaryRepositoryTests();",
        'console.log("English Diary repository: PASS");',
        "await runEnglishDiaryVaultPortTests();",
        'console.log("English Diary native editor and Vault port: PASS");'
      ].join("\n"),
      resolveDir: root, sourcefile: "english-diary-test-entry.ts", loader: "ts"
    },
    bundle: true, platform: "node", target: "node22", format: "esm", external: ["jsdom"],
    loader: { ".md": "text" },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") },
    outfile: outputFile, logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [outputFile], {
    cwd: root, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
