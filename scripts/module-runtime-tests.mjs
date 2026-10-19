import { access, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = path.join(os.homedir(), "EchoInk-TestVaults/90-任务临时/工作台P12自动测试-20261019");
const fixtureRoot = process.env.ECHOINK_MODULES_TEST_ROOT ?? allowed;
if (path.resolve(fixtureRoot) !== allowed) throw new Error("P12 runtime tests require the registered disposable root");
await access(fixtureRoot);
const directory = await mkdtemp(path.join(fixtureRoot, "runtime-"));
try {
  const output = path.join(directory, "tests.mjs");
  await esbuild.build({
    stdin: { contents: `import { JSDOM } from "jsdom"; import { runModuleRuntimeTests } from "./src/tests/module-runtime";
      const dom = new JSDOM("<!doctype html><body></body>"); globalThis.DOMParser = dom.window.DOMParser; globalThis.Node = dom.window.Node;
      try { await runModuleRuntimeTests(${JSON.stringify(directory)}); } finally { dom.window.close(); }`, resolveDir: root, loader: "ts" },
    outfile: output, bundle: true, platform: "node", target: "node22", format: "esm",
    banner: { js: `import {createRequire as runtimeRequire} from "node:module"; const require = runtimeRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    loader: { ".md": "text", ".txt": "text", ".svg": "dataurl", ".webp": "dataurl" },
    plugins: [{ name: "runtime-workspace-host", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
