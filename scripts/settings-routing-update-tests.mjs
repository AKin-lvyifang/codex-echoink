import path from "node:path";
import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const repo = fileURLToPath(new URL("../", import.meta.url));
const configuredRoot = process.env.ECHOINK_SETTINGS_TEST_ROOT;
if (!configuredRoot) throw new Error("Set ECHOINK_SETTINGS_TEST_ROOT to a newly registered directory under ~/EchoInk-TestVaults/90-任务临时");
const root = await realpath(configuredRoot);
const allowed = await realpath(path.join(homedir(), "EchoInk-TestVaults/90-任务临时"));
if (!root.startsWith(allowed + path.sep)) throw new Error("Settings test root must be inside 90-任务临时");
const output = path.join(root, "routing-update");
await mkdir(output, { recursive: true });
try {
  const entry = path.join(output, "test.mjs");
  await esbuild.build({ entryPoints: ["src/tests/settings-routing-update.ts"], absWorkingDir: repo, bundle: true, platform: "node", format: "esm", outfile: entry,
    plugins: [{ name: "offline-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "offline-host" }));
      build.onLoad({ filter: /.*/, namespace: "offline-host" }, () => ({ contents: 'export function requestUrl(){throw new Error("Tests must not contact external services");}' }));
    } }], logLevel: "silent" });
  await import(pathToFileURL(entry).href);
} finally { await rm(output, { recursive: true, force: true }); }
