import { disposableTestRoot } from "./disposable-test-root.mjs";
import { access, mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P10自动测试-20261019"));
await access(allowed);
const directory = await mkdtemp(path.join(allowed, ".pdf-navigation-storage-"));
try {
  const output = path.join(directory, "tests.mjs"), legacyRoot = path.join(directory, ".tests/pdf-reading-index");
  await mkdir(legacyRoot, { recursive: true });
  const legacy = process.argv.includes("--legacy") ? 'import { runPdfReadingTests } from "./src/tests/pdf-reading"; await runPdfReadingTests(); console.log("P10 existing PDF regressions passed.");' : "";
  await esbuild.build({ stdin: { contents: `import { runPdfNavigationStorageTests } from "./src/tests/pdf-navigation-storage"; await runPdfNavigationStorageTests(${JSON.stringify(directory)});\n${legacy}`, resolveDir: root, loader: "ts" }, outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", loader: { ".md": "text", ".webp": "dataurl", ".svg": "dataurl", ".txt": "text" },
    banner: { js: `import {createRequire as createPdfStorageRequire} from "node:module"; const require = createPdfStorageRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "pdf-storage-workspace-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => { if (args.path === "electron") return { path: args.path, external: true }; const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, env: { ...process.env, PI_OFFLINE: "1", TMPDIR: directory, ECHOINK_PDF_TEST_ROOT: legacyRoot }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
  if (!process.exitCode && process.argv.includes("--typecheck")) {
    const ts = createRequire(import.meta.url)("typescript"), config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const owned = ["src/pdf-reading/service.ts", "src/pdf-reading/vault-files.ts", "src/pdf-reading/controller.ts", "src/tests/pdf-navigation-storage.ts"].map(file => path.join(root, file));
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...owned, path.join(root, "node_modules/obsidian/obsidian.d.ts")], { ...parsed.options, noEmit: true }));
    const relevant = diagnostics.filter(item => !item.file || owned.includes(item.file.fileName));
    if (relevant.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(relevant, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
    console.log(`P10 PDF data owned-file TypeScript passed; ${diagnostics.length} dependency diagnostics reserved for integration.`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
