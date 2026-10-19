import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P9自动测试-20261019");
if (!process.env.ECHOINK_ENGLISH_DIARY_NAVIGATION_TEST_ROOT || path.resolve(process.env.ECHOINK_ENGLISH_DIARY_NAVIGATION_TEST_ROOT) !== allowed) {
  throw new Error("Set ECHOINK_ENGLISH_DIARY_NAVIGATION_TEST_ROOT to the registered P9 disposable test directory.");
}
await access(allowed);
process.env.TZ = "America/Los_Angeles";
const directory = await mkdtemp(path.join(allowed, ".english-diary-navigation-data-"));
try {
  const output = path.join(directory, "english-diary-navigation-data.mjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/tests/english-diary-navigation-data.ts")], outfile: output,
    bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }
  });
  await (await import(pathToFileURL(output).href)).runEnglishDiaryNavigationDataTests();
  if (process.argv.includes("--repository-regression")) {
    const regression = path.join(directory, "english-diary-repository.mjs");
    await esbuild.build({
      entryPoints: [path.join(root, "src/tests/english-diary-repository.ts")], outfile: regression,
      bundle: true, platform: "node", target: "node22", format: "esm"
    });
    await (await import(pathToFileURL(regression).href)).runEnglishDiaryRepositoryTests();
    console.log("P9 existing English diary repository regression passed.");
  }
  if (process.argv.includes("--vault-port-regression")) {
    const regression = path.join(directory, "english-diary-vault-port.mjs");
    await esbuild.build({
      entryPoints: [path.join(root, "src/tests/english-diary-vault-port.ts")], outfile: regression,
      bundle: true, platform: "node", target: "node22", format: "esm",
      alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }
    });
    await (await import(pathToFileURL(regression).href)).runEnglishDiaryVaultPortTests();
    console.log("P9 existing English diary native Vault port regression passed.");
  }
  if (process.argv.includes("--typecheck")) {
    const ts = createRequire(import.meta.url)("typescript");
    const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const owned = ["src/english-diary/repository.ts", "src/english-diary/vault-port.ts", "src/english-diary/types.ts", "src/home/english-diary-page-data.ts", "src/tests/english-diary-navigation-data.ts"].map(file => path.join(root, file));
    const program = ts.createProgram([...owned, path.join(root, "node_modules/obsidian/obsidian.d.ts")], { ...parsed.options, noEmit: true });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const relevant = diagnostics.filter(item => !item.file || owned.includes(item.file.fileName));
    if (relevant.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(relevant, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
    console.log(`P9 data owned-file TypeScript passed; ${diagnostics.length} dependency diagnostics reserved for integration.`);
    for (const diagnostic of diagnostics) {
      const location = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
      console.log(`${diagnostic.file ? path.relative(root, diagnostic.file.fileName) : "dependency"}${location ? `:${location.line + 1}` : ""}: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
