import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P10自动测试-20261019");
await mkdir(allowed, { recursive: true });
const fixtureRoot = process.env.ECHOINK_PDF_TASK_TEST_ROOT ?? allowed;
await mkdir(fixtureRoot, { recursive: true });
const canonical = await realpath(fixtureRoot), canonicalAllowed = await realpath(allowed);
if (canonical !== canonicalAllowed && !canonical.startsWith(canonicalAllowed + path.sep)) throw new Error("PDF task fixtures must stay under this P10 disposable root");
const directory = await mkdtemp(path.join(canonical, "pdf-task-context-"));
const logPath = path.join(canonical, "pdf-task-context-tests.log");
let log = "Command: node scripts/pdf-task-context-tests.mjs\n";
try {
  const output = path.join(directory, "tests.mjs");
  await esbuild.build({ stdin: { contents: `import { runPdfTaskContextTests } from "./src/tests/pdf-task-context"; await runPdfTaskContextTests(${JSON.stringify(directory)});`, resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: output, logLevel: "silent",
    loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import {createRequire as __pdfTaskRequire} from "node:module"; const require = __pdfTaskRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "pdf-task-offline-host", setup(build) {
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }] });
  const result = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1", TMPDIR: directory } });
  log += (result.stdout ?? "") + (result.stderr ?? "");
  if (result.error) log += `${result.error.stack ?? result.error.message}\n`;
  process.exitCode = result.status ?? 1; log += `Exit code: ${process.exitCode}\n`;
} catch (error) { log += `${error.stack ?? error}\nExit code: 1\n`; process.exitCode = 1; }
finally { process.stdout.write(log); await writeFile(logPath, log); await rm(directory, { recursive: true, force: true }); }
console.log(`Log: ${logPath}`);
