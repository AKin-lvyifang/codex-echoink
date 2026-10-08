import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.join(root, ".tmp", "finance-tests.mjs");
await mkdir(path.dirname(target), { recursive: true });
await esbuild.build({
  stdin: { contents: 'import { runFinanceBillPlanTests } from "./src/tests/finance-bill-plan"; import { runFinanceThemeIntegrationTests } from "./src/tests/finance-theme-integration"; import { runLifestyleFinanceTests } from "./src/tests/lifestyle-finance"; import { runLifestyleFinanceLedgerTests } from "./src/tests/lifestyle-finance-ledger"; import { runLifestyleFinanceUiTests } from "./src/tests/lifestyle-finance-ui"; import { runLifestyleFinanceAnalysisTests } from "./src/tests/lifestyle-finance-analysis"; import { runLifestyleFinanceIntegrationTests } from "./src/tests/lifestyle-finance-integration"; await runFinanceBillPlanTests(); await runLifestyleFinanceTests(); await runLifestyleFinanceLedgerTests(); await runLifestyleFinanceUiTests(); await runLifestyleFinanceAnalysisTests(); await runLifestyleFinanceIntegrationTests(); await runFinanceThemeIntegrationTests();', resolveDir: root, sourcefile: "finance-test-entry.ts", loader: "ts" },
  bundle: true, platform: "node", target: "node22", format: "esm", outfile: target,
  external: ["read-excel-file/node", "yaml", "postcss"],
  plugins: [{ name: "obsidian-test-shim", setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src", "tests", "obsidian-shim.ts") }));
    build.onResolve({ filter: /(?:^|\/)origin-controls$/ }, () => ({ path: path.join(root, "src", "tests", "origin-controls-shim.ts") }));
  } }]
});
const run = spawnSync(process.execPath, [target], { stdio: "inherit" });
await rm(target, { force: true });
if (run.status !== 0) process.exit(run.status ?? 1);
