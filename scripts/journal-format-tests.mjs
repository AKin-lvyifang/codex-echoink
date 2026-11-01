import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "journal-format-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
try {
  await esbuild.build({ banner: desktopNodeTestBanner, stdin: { contents: 'import { runJournalFormatTests } from "./src/tests/journal-format"; await runJournalFormatTests();', resolveDir: root, loader: "ts" },
    outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", plugins: [{ name: "journal-format-test-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: "inherit" }); process.exitCode = result.status ?? 1;
} finally { await rm(output, { force: true }); }
