import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import esbuild from "esbuild";
const root = process.cwd(), output = path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "selection-annotations-tests.mjs");
await mkdir(path.dirname(output), { recursive: true });
await esbuild.build({ stdin: { contents: 'import { runSelectionAnnotationTests } from "./src/tests/selection-annotations"; await runSelectionAnnotationTests();', resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", outfile: output,
  loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" }, external: ["jsdom", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
  banner: { js: 'import { createRequire as createSelectionTestRequire } from "node:module"; const require = createSelectionTestRequire(import.meta.url);' },
  plugins: [{ name: "fixture", setup(build) { build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "src/tests/obsidian-shim.ts") })); build.onResolve({ filter: /provider-brand-icons$/ }, () => ({ path: path.join(root, "src/tests/composer-provider-brand-shim.ts") })); } }], logLevel: "silent" });
const result = spawnSync(process.execPath, [output], { env: { ...process.env, PI_OFFLINE: "1" }, stdio: "inherit" });
process.exit(result.status ?? 1);
