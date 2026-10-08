import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, ".tmp/appearance-theme");
await mkdir(out, { recursive: true });
const common = { absWorkingDir: root, bundle: true, logLevel: "silent", alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") } };
await esbuild.build({ ...common, entryPoints: ["src/settings/settings.ts"], platform: "node", format: "esm", outfile: path.join(out, "settings.mjs"),
  external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
  banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' } });
const { DEFAULT_SETTINGS, normalizeSettingsData } = await import(pathToFileURL(path.join(out, "settings.mjs")));
const old = structuredClone(DEFAULT_SETTINGS); delete old.colorTheme;
assert.equal(normalizeSettingsData(old).settings.colorTheme, "green");
assert.equal(normalizeSettingsData({ ...old, colorTheme: "unknown" }).settings.colorTheme, "green");
for (const colorTheme of ["green", "violet"]) {
  const settings = normalizeSettingsData({ ...old, colorTheme }).settings;
  assert.equal(normalizeSettingsData(JSON.parse(JSON.stringify(settings))).settings.colorTheme, colorTheme);
}
console.log("Theme defaults, invalid-value fallback and persistence round-trip passed.");
if (process.argv.includes("--browser")) {
  await esbuild.build({ ...common, entryPoints: ["src/tests/appearance-theme-dom.ts"], platform: "browser", format: "iife", outfile: path.join(out, "test.js") });
  await writeFile(path.join(out, "styles.css"), await readFile(path.join(root, "styles.css")));
  await writeFile(path.join(out, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EchoInk appearance checks</title><link rel="stylesheet" href="styles.css"><body class="theme-dark"><main class="echoink-settings-demo" style="padding:24px"><h2>外观主链验证</h2><div id="picker"></div><p id="result" role="status">运行中</p></main><iframe id="second-window" title="Second document"></iframe><script src="test.js"></script></body></html>');
  console.log(`Browser fixture: ${out}/index.html`);
}
