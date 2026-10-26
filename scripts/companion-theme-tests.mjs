import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { parse } from "postcss";
import { companionThemeTestDirectory } from "./theme-test-directory.mjs";
const directory = await companionThemeTestDirectory();
if (!directory) {
  console.log("跳过：未找到主题目录。请设置 ECHOINK_THEME_DIR 后运行配套主题专项。");
  process.exit(0);
}
const css = await readFile(new URL("theme.css", directory), "utf8");
const tree = parse(css);
tree.walkRules(rule => {
  const functions = [];
  for (let at = 0; at < rule.selector.length; at++) {
    const char = rule.selector[at];
    if (char === "(") {
      const has = rule.selector.slice(Math.max(0, at - 4), at) === ":has";
      assert.ok(!has || !functions.includes(true), "CSS :has cannot be nested inside :has"); functions.push(has);
    } else if (char === ")") functions.pop();
  }
  if (rule.selector === "body") assert.ok(!rule.nodes.some(node => /^--(?:h[1-6]-font|font-text-theme)$/u.test(node.prop ?? "")), "Notebook fonts cannot be inherited by plugin headings");
  if (!/markdown-(?:preview|source)-view|metadata-property/u.test(rule.selector)) return;
  let scope = rule.parent;
  while (scope && !(scope.type === "atrule" && scope.name === "scope")) scope = scope.parent;
  assert.ok(scope?.params.includes('[class^="echoink-"]') && scope.params.includes('[class*=" echoink-"]'), "Notebook rules stop at EchoInk container boundaries");
  if (rule.nodes.some(node => node.prop === "--file-line-width")) {
    assert.ok(rule.selector.split(",").every(selector => selector.includes('[data-type="markdown"]') && selector.includes(".is-readable-line-width")), "Line-width overrides require a readable native note view, never plugin UI or unrestricted notes");
  }
});
assert.ok(Buffer.byteLength(css) <= 500 * 1024, "Offline theme stays within its 500 KiB budget");
for (const match of css.matchAll(/url\(([^)]+)\)/gu)) assert.match(match[1].replace(/^["']|["']$/gu, ""), /^data:/u, "Every CSS resource is embedded");
assert.doesNotMatch(css, /@import/iu);
assert.match(css, /--echoink-gallery:1/u, "Gallery capability is advertised by the active theme");
assert.doesNotMatch(css, /\.cm-line:has\(>\.image-embed|\.markdown-preview-view p:has\(> \.image-embed/u, "No implicit image-row grouping");
const metadata = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
assert.deepEqual(metadata, { name: "echoink-theme", version: "0.1.0", minAppVersion: "1.11.4", author: "AKin-lvyifang" });
const palettes = [];
tree.walkRules(rule => { if (rule.nodes.some(node => node.prop === "--ei-bg" && node.value.startsWith("#"))) palettes.push(rule); });
assert.equal(palettes.length, 6, "Six native light/dark palettes");
assert.equal(palettes[0].selector, "body", "Minimal is unconditional for absent and unknown attributes");
assert.equal(palettes[1].selector, "body.theme-dark");
assert.match(css, /task-list-item-checkbox:not\(:checked\)::after/u, "Unchecked tasks are blank even when native data-task is empty");
const states = ['x',' ','/','-','>','<','?','!','*','I','i','b','f','"','l','k','p','c','w'];
for (const state of states) {
  const selector = `[data-task="${state.replaceAll('"', '\\"')}"]`;
  let found = false;
  tree.walkRules(rule => { if (rule.selector.includes(selector) && rule.nodes.some(node => node.prop === "--ei-task-icon")) found = true; });
  assert.ok(found, `Task character ${state} has its own glyph mapping`);
}
for (const state of ["x", "X"]) {
  let completionSvg = "";
  tree.walkRules(rule => {
    if (rule.selector.includes(`[data-task="${state}"]`)) for (const decl of rule.nodes) if (decl.prop === "--ei-task-icon") {
      const payload = decl.value.match(/data:image\/svg\+xml,([^"\)]+)/u)?.[1];
      if (payload) completionSvg = decodeURIComponent(payload);
    }
  });
  assert.match(completionSvg, /viewBox="0 0 24 24"/u);
  assert.match(completionSvg, /d="M20 6 9 17l-5-5"/u);
  assert.match(completionSvg, /stroke-width="3.4"/u);
  assert.equal((completionSvg.match(/<path\b/gu) ?? []).length, 1, "Completion is one pure stroke, without an inner checkbox frame");
  assert.doesNotMatch(completionSvg, /<(?:rect|circle|g|clipPath)\b/u);
}
const names = [];
tree.walkAtRules("font-face", rule => { names.push(rule.nodes.find(node => node.prop === "font-family").value); });
assert.equal(new Set(names).size, 5, "All five approved font families are embedded");
assert.match(css, /@media\s*\(prefers-reduced-motion:reduce\)/u);
assert.match(css, /transition:none!important/u, "Reduced motion overrides native inline transitions");
for (const name of await readdir(directory)) assert.ok(!/\.(ttf|otf|woff2?)$/iu.test(name), "No downloaded font sources in deliverables");
console.log(`Companion theme: PASS; ${Buffer.byteLength(css)} bytes, 6 palettes, 19 task states, 5 offline OFL font families`);
if (process.argv.includes("--dom")) {
  const { build } = await import("esbuild");
  await mkdir(new URL("../.tmp/companion-theme/round5/", import.meta.url), { recursive: true });
  await build({ entryPoints: ["src/tests/companion-theme-dom.ts"], bundle: true, platform: "browser", format: "iife", globalName: "EchoInkCompanionChecks", outfile: ".tmp/companion-theme/round5/dom-checks.js", logLevel: "silent" });
  console.log("Native renderer regression bundle generated; execution is recorded separately.");
}
