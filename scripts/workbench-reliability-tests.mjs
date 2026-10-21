import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = path.resolve(process.env.ECHOINK_WORKBENCH_TEST_ROOT ?? path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台可靠性-20261021/automatic"));
if (!fixtureRoot.startsWith(path.join(os.homedir(), "EchoInk-TestVaults") + path.sep)) throw new Error("Use an explicitly disposable EchoInk-TestVaults fixture");
await mkdir(fixtureRoot, { recursive: true });
const output = path.join(fixtureRoot, "workbench-reliability-tests.mjs");
const chain = process.argv.includes("--production-chain");
await esbuild.build({
  stdin: { contents: process.argv.includes("--all")
    ? `import { runWorkbenchToolDiagnosticTests } from "./src/tests/workbench-tool-diagnostics";
       import { runWorkbenchMaintenanceSourceTests } from "./src/tests/workbench-maintenance-sources";
       import { runWorkbenchMaintenanceChain } from "./src/tests/workbench-maintenance-chain";
       await runWorkbenchToolDiagnosticTests(); await runWorkbenchMaintenanceSourceTests(${JSON.stringify(fixtureRoot)});
       await runWorkbenchMaintenanceChain(${JSON.stringify(fixtureRoot)}, false); await runWorkbenchMaintenanceChain(${JSON.stringify(fixtureRoot)}, true);
       await runWorkbenchMaintenanceChain(${JSON.stringify(fixtureRoot)}, false, true, true);`
    : process.argv.includes("--second-turn")
    ? `import { runWorkbenchMaintenanceChain } from "./src/tests/workbench-maintenance-chain"; await runWorkbenchMaintenanceChain(${JSON.stringify(fixtureRoot)}, false, true, ${process.argv.includes("--expect-success")});`
    : process.argv.includes("--sources")
    ? `import { runWorkbenchMaintenanceSourceTests } from "./src/tests/workbench-maintenance-sources"; await runWorkbenchMaintenanceSourceTests(${JSON.stringify(fixtureRoot)});`
    : chain
    ? `import { runWorkbenchMaintenanceChain } from "./src/tests/workbench-maintenance-chain"; await runWorkbenchMaintenanceChain(${JSON.stringify(fixtureRoot)}, ${process.argv.includes("--bound")});`
    : 'import { runWorkbenchToolDiagnosticTests } from "./src/tests/workbench-tool-diagnostics"; await runWorkbenchToolDiagnosticTests();', resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", target: "node22", format: "esm", outfile: output,
  loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
  banner: { js: `import { createRequire as createFixtureRequire } from "node:module"; const require = createFixtureRequire(${JSON.stringify(path.join(root, "package.json"))});` },
  plugins: [{ name: "fixture-dependencies", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === "electron") return { path: args.path, external: true };
      const resolved = import.meta.resolve(args.path);
      return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
    });
  } }], logLevel: "silent"
});
const result = spawnSync(process.execPath, [output], { cwd: root, env: { ...process.env, PI_OFFLINE: "1", TMPDIR: fixtureRoot, ECHOINK_KNOWLEDGE_TEST_ROOT: fixtureRoot }, stdio: "inherit" });
process.exit(result.status ?? 1);
