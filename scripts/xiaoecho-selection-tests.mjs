import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(rootDir, ".tmp/xiaoecho-selection");
await mkdir(directory, { recursive: true });
const outfile = path.join(directory, "selection-tests.mjs");
await esbuild.build({
  banner: desktopNodeTestBanner,
  stdin: { contents: 'import { runXiaoechoSelectionTests } from "./src/tests/xiaoecho-selection"; await runXiaoechoSelectionTests();', resolveDir: rootDir, loader: "ts" },
  bundle: true, platform: "node", target: "node22", format: "esm", outfile,
  loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" },
  plugins: [{ name: "selection-host-services", setup(build) {
    build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(rootDir, "src/tests/composer-provider-brand-shim.ts") }));
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(rootDir, "src/tests/obsidian-shim.ts") }));
    build.onResolve({ filter: /^[^./]/ }, args => { const resolved = import.meta.resolve(args.path); return { path: resolved.startsWith("node:") ? resolved : fileURLToPath(resolved), external: true }; });
  } }], logLevel: "silent"
});
const result = spawnSync(process.execPath, [outfile], { cwd: rootDir, env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
process.exit(result.status ?? 1);
