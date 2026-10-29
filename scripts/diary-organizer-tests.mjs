import { desktopNodeTestBanner } from "./desktop-node-test-host.mjs";
import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "diary-organizer-tests.mjs");
await mkdir(path.dirname(target), { recursive: true });
await esbuild.build({ banner: desktopNodeTestBanner,
  stdin: { contents: 'import { runDiaryOrganizerTests } from "./src/tests/diary-organizer"; import { runDiaryOrganizerBannerTests } from "./src/tests/diary-organizer-banner"; await runDiaryOrganizerTests(); await runDiaryOrganizerBannerTests();', resolveDir: root, sourcefile: "diary-tests-entry.ts", loader: "ts" },
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
