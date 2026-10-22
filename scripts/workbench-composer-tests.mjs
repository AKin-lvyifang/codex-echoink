import { disposableTestRoot } from "./disposable-test-root.mjs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = disposableTestRoot(path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台可靠性-20261021/composer"), ["ECHOINK_WORKBENCH_TEST_ROOT"]);

await mkdir(fixture, { recursive: true });
const output = path.join(fixture, "workbench-composer.mjs");
await esbuild.build({ stdin: { contents: 'import { runWorkbenchComposerTests, runPiNativeTurnRunnerTests } from "./src/tests/pi-native/turn-runner"; await '+(process.argv.includes("--runner") ? 'runPiNativeTurnRunnerTests' : 'runWorkbenchComposerTests')+'();', resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
  banner: { js: `import { createRequire as createFixtureRequire } from "node:module"; const require = createFixtureRequire(${JSON.stringify(path.join(root, "package.json"))});` },
  loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
  plugins: [{ name: "fixture-dependencies", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
    build.onResolve({ filter: /^[^./]/ }, args => { if (args.path === "electron") return { path: args.path, external: true }; const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
  } }], logLevel: "silent"
});
const result = spawnSync(process.execPath, [output], { cwd: root, env: { ...process.env, PI_OFFLINE: "1", TMPDIR: fixture, ECHOINK_KNOWLEDGE_TEST_ROOT: fixture }, stdio: "inherit" });
if (result.status) process.exit(result.status);
if (process.argv.includes("--typecheck")) {
  const require = createRequire(import.meta.url), ts = require("typescript");
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const owned = ["src/ui/codex-view.ts", "src/ui/codex-view/runner-context.ts", "src/ui/codex-view/turn-runner.ts", "src/ui/codex-view/composer.ts", "src/ui/codex-view/composer-controller.ts", "src/ui/composer-state.ts", "src/ui/turn-queue.ts", "src/home/workbench-view.ts"].map(file => path.join(root, file));
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(owned, { ...parsed.options, noEmit: true })).filter(item => !item.file || owned.includes(item.file.fileName));
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => "\n" }));
  console.log("Workbench Composer owned-file TypeScript: PASS");
}
