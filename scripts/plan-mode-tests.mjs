import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "echoink-plan-mode-tests-"));
try {
  const file = path.join(output, "run.mjs");
  await build({ stdin: { contents: 'import { runPlanModeTests } from "./src/tests/plan-mode"; import { runPiNativeTaskPlanRuntimeTests, runPlanModeFailureTests } from "./src/tests/pi-native/pi-native-conversation-runtime"; await runPlanModeTests(); await runPiNativeTaskPlanRuntimeTests(); await runPlanModeFailureTests();', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", target: "node22", format: "esm", outfile: file, logLevel: "silent",
    loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
    banner: { js: `import { createRequire as createPlanRequire } from "node:module"; const require = createPlanRequire(${JSON.stringify(path.join(root, "package.json"))});` },
    plugins: [{ name: "plan-mode-test-dependencies", setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") }));
      builder.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") }));
      builder.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === "electron") return { path: args.path, external: true };
        const resolved = import.meta.resolve(args.path);
        return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true };
      });
    } }]
  });
  const result = spawnSync(process.execPath, [file], { cwd: root, env: { ...process.env, TMPDIR: output, PI_OFFLINE: "1" }, stdio: "inherit", timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { recursive: true, force: true }); }
