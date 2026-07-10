import esbuild from "esbuild";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

fs.mkdirSync(".tmp", { recursive: true });

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const obsidianShimPath = path.join(rootDir, "src", "tests", "obsidian-shim.ts");
const openCodeBackendShimPath = path.join(rootDir, "src", "tests", "opencode-backend-shim.ts");

await esbuild.build({
  entryPoints: ["src/tests/run-tests.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: ".tmp/run-tests.mjs",
  logLevel: "silent",
  plugins: [{
    name: "test-shims",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianShimPath }));
      build.onResolve({ filter: /opencode-backend$/ }, () => ({ path: openCodeBackendShimPath }));
    }
  }]
});

const result = spawnSync(process.execPath, [".tmp/run-tests.mjs"], {
  env: { ...process.env, ECHOINK_DISABLE_ACP: "1" },
  stdio: "inherit"
});

process.exit(result.status ?? 1);
