import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "appearance-theme");
await mkdir(out, { recursive: true });
const common = { loader: { ".md": "text", ".svg": "dataurl", ".webp": "dataurl" }, absWorkingDir: root, bundle: true, logLevel: "silent", alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") } };
await esbuild.build({ ...common, entryPoints: ["src/settings/settings.ts"], platform: "node", format: "esm", outfile: path.join(out, "settings.mjs"),
  external: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "yaml"],
  banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' } });
const { DEFAULT_SETTINGS, normalizeSettingsData } = await import(pathToFileURL(path.join(out, "settings.mjs")));
const old = structuredClone(DEFAULT_SETTINGS); delete old.colorTheme;
assert.equal(normalizeSettingsData(old).settings.colorTheme, "minimal");
assert.equal(normalizeSettingsData({ ...old, colorTheme: "unknown" }).settings.colorTheme, "minimal");
for (const colorTheme of ["minimal", "highlighter", "manifesto"]) {
  const settings = normalizeSettingsData({ ...old, colorTheme }).settings;
  assert.equal(normalizeSettingsData(JSON.parse(JSON.stringify(settings))).settings.colorTheme, colorTheme);
}
for (const legacy of ["green", "violet", undefined, "unknown"]) {
  const original = { ...old, colorTheme: legacy, autoOpenHome: true };
  const result = normalizeSettingsData(original);
  assert.equal(result.settings.colorTheme, "minimal");
  assert.equal(result.settings.autoOpenHome, true, "Migration preserves unrelated settings");
  assert.equal(normalizeSettingsData(JSON.parse(JSON.stringify(result.settings))).settings.colorTheme, "minimal", "Migrated selection survives restart serialization");
}
console.log("Theme defaults, invalid-value fallback and persistence round-trip passed.");
// Resolve the palette selector cascade on actual container hierarchies; no layout
// or browser-computed-color claim is made by this contract test.
const { JSDOM } = await import("jsdom");
const { parse } = await import("postcss");
const paletteRules = [];
parse(await readFile(path.join(root, "styles.css"), "utf8")).walkRules(rule => {
  if (rule.nodes.some(node => node.prop === "--echoink-theme-scheme")) paletteRules.push(rule);
});
const fixture = new JSDOM('<body><div class="echoink-workbench"></div><div class="modal mod-settings"><div class="echoink-settings-host"><div class="echoink-settings-demo"><div class="echoink-theme-boundary"></div></div></div></div><div class="echoink-theme-overlay echoink-settings-overlay"></div></body>');
const doc = fixture.window.document;
const resolve = element => {
  const ancestors = []; for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
  const tokens = {};
  for (const node of ancestors) for (const rule of paletteRules) if (node.matches(rule.selector)) for (const decl of rule.nodes) if (decl.type === "decl") tokens[decl.prop] = decl.value;
  return tokens;
};
for (const dark of [false, true]) {
  doc.body.classList.toggle("theme-dark", dark); doc.body.dataset.echoinkTheme = "minimal";
  const minimal = resolve(doc.querySelector(".echoink-workbench"));
  assert.equal(minimal["--echoink-theme-accent"], dark ? "#fafafa" : "#18181b");
  for (const skin of ["minimal", "highlighter", "manifesto", "unknown"]) {
    doc.body.dataset.echoinkTheme = skin;
    for (const element of doc.querySelectorAll(".mod-settings,.echoink-settings-host,.echoink-settings-demo,.echoink-theme-boundary,.echoink-settings-overlay")) assert.deepEqual(resolve(element), minimal, `${skin}/${dark}: settings and nested/portal surfaces stay Minimal`);
    if (skin !== "unknown") assert.equal(resolve(doc.querySelector(".echoink-workbench"))["--echoink-theme-accent"], skin === "minimal" ? minimal["--echoink-theme-accent"] : skin === "highlighter" ? "#ffd700" : "#f2d741", "Workbench retains its selected palette");
    doc.body.classList.add("is-popout-modal");
    assert.deepEqual(resolve(doc.body), minimal, "Dedicated settings-window chrome inherits Minimal too");
    doc.body.classList.remove("is-popout-modal");
  }
}
fixture.window.close();
console.log("Settings neutral palette: PASS; 6 appearances, nested surfaces, settings portals, unknown identifiers, workbench isolation.");
await esbuild.build({ ...common, entryPoints: ["src/tests/appearance-pro.ts"], platform: "node", format: "esm", outfile: path.join(out,"pro.mjs"), external: ["jsdom"] });
const proChecks = spawnSync(process.execPath,[path.join(out,"pro.mjs")],{stdio:"inherit"});
if (proChecks.status !== 0) process.exit(proChecks.status ?? 1);

if (process.argv.includes("--browser")) {
  await esbuild.build({ ...common, entryPoints: ["src/tests/appearance-theme-dom.ts"], platform: "browser", format: "iife", outfile: path.join(out, "test.js") });
  await writeFile(path.join(out, "styles.css"), await readFile(path.join(root, "styles.css")));
  await writeFile(path.join(out, "index.html"), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EchoInk appearance checks</title><link rel="stylesheet" href="styles.css"><body class="theme-dark"><main class="echoink-settings-demo" style="padding:24px"><h2>外观主链验证</h2><div id="picker"></div><p id="result" role="status">运行中</p></main><iframe id="second-window" title="Second document"></iframe><script src="test.js"></script></body></html>');
  console.log(`Browser fixture: ${out}/index.html`);
}
