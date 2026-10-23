import { disposableTestRoot } from "./disposable-test-root.mjs";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P8自动测试-20261018"), ["ECHOINK_KNOWLEDGE_PAGE_TEST_ROOT"]);
await access(allowed);
process.env.TZ = "America/Los_Angeles";
const directory = await mkdtemp(path.join(allowed, ".knowledge-page-data-"));
try {
  const output = path.join(directory, "knowledge-page-data.mjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/tests/knowledge-page-data.ts")], outfile: output, bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") }
  });
  await (await import(pathToFileURL(output).href)).runKnowledgePageDataTests(directory);
  if (process.argv.includes("--typecheck")) {
    const ts = createRequire(import.meta.url)("typescript");
    const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const owned = ["src/home/knowledge-page-data.ts", "src/knowledge-base/source-health.ts", "src/knowledge-base/knowledge-agent-index.ts", "src/tests/knowledge-page-data.ts"].map(file => path.join(root, file));
    const program = ts.createProgram(owned, { ...parsed.options, noEmit: true });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const relevant = diagnostics.filter(item => !item.file || owned.includes(item.file.fileName));
    if (relevant.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(relevant, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
    console.log(`P8 data owned-file TypeScript passed; ${diagnostics.length} dependency diagnostics reserved for integration.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
