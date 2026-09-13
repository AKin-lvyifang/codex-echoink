import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import prefixSelector from "postcss-prefix-selector";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = path.join(rootDir, "src", "home", "magic-ui");
const stylesPath = path.join(rootDir, "styles.css");
const checkOnly = process.argv.includes("--check");
const scope = ".echoink-home-magic-ui";
const startMarker = "/* ECHOINK_HOME_MAGIC_UI_CSS_START */";
const endMarker = "/* ECHOINK_HOME_MAGIC_UI_CSS_END */";

const upstreamCss = await readFile(path.join(sourceDir, "provenance", "globals.css.reference"), "utf8");
const animationNames = ["shiny-text"];
const animationVariables = animationNames.map((name) => extractDeclaration(upstreamCss, `--animate-${name}`));
const keyframes = animationNames.map((name) => extractKeyframes(upstreamCss, name));
const inputCss = [
  '@import "tailwindcss/theme.css" layer(theme);',
  '@import "tailwindcss/utilities.css" layer(utilities) source(none);',
  '@source "../src/home/magic-ui/bento-grid.tsx";',
  '@source "../src/home/magic-ui/animated-shiny-text.tsx";',
  '@source "../src/home/magic-ui/button.tsx";',
  '@source "../src/home/home-*-island.tsx";',
  '@custom-variant dark (&:where(.theme-dark, .theme-dark *));',
  "@theme inline {",
  ...animationVariables.map((value) => `  ${value}`),
  ...keyframes.map((value) => indent(value, 2)),
  "}",
  ""
].join("\n");

// Tailwind resolves explicit sources relative to this directory. Ensure it
// exists even when a clean checkout is built before running any tests.
await mkdir(path.join(rootDir, ".tmp"), { recursive: true });
const result = await postcss([
  tailwindcss(),
  prefixSelector({
    prefix: scope,
    exclude: [/^(?:from|to|\d+(?:\.\d+)?%)$/u],
    transform(prefix, selector, prefixedSelector) {
      if (/(^|[^\\])&/u.test(selector)) return selector;
      if (selector === ":root" || selector === ":host") return prefix;
      return prefixedSelector;
    }
  })
]).process(inputCss, {
  from: path.join(rootDir, ".tmp", "home-magic-ui.css")
});

assertScopedSelectors(result.root);
if (result.css.includes(`${scope} &`)) throw new Error("Nested Magic UI selector was prefixed twice");
const generated = [
  startMarker,
  "/* Generated from fixed Magic UI sources. Run: node scripts/build-home-magic-ui-css.mjs */",
  result.css.trim(),
  endMarker
].join("\n");
const styles = await readFile(stylesPath, "utf8");
const current = extractGeneratedBlock(styles);
const settingsStart = "/* ECHOINK_WORKSPACE_SETTINGS_START */";
const settingsEnd = "/* ECHOINK_WORKSPACE_SETTINGS_END */";
const settingsSource = await readFile(path.join(rootDir, "src/styles/workspace-settings.css"), "utf8");
const originSource = await readFile(path.join(rootDir, "src/styles/origin-controls.css"), "utf8");
const settingsGenerated = [settingsStart, settingsSource.trim(), originSource.trim(), settingsEnd].join("\n");
const settingsIndex = styles.indexOf(settingsStart);
const settingsCurrent = settingsIndex < 0 ? "" : styles.slice(settingsIndex, styles.indexOf(settingsEnd, settingsIndex) + settingsEnd.length);

if (checkOnly) {
  if (current !== generated) throw new Error("Generated Magic UI CSS is stale. Run node scripts/build-home-magic-ui-css.mjs");
  if (settingsCurrent !== settingsGenerated) throw new Error("Generated workspace settings CSS is stale");
  console.log("Home Magic UI and workspace settings CSS: PASS");
} else {
  let next = styles.replace(current, generated);
  next = settingsCurrent ? next.replace(settingsCurrent, settingsGenerated) : `${next.trimEnd()}\n\n${settingsGenerated}\n`;
  if (next !== styles) await writeFile(stylesPath, next, "utf8");
  console.log("Home Magic UI CSS: updated");
}

function extractDeclaration(css, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`^[ \\t]*${escaped}:[^;]+;`, "mu"));
  if (!match) throw new Error(`Missing upstream animation declaration: ${name}`);
  return match[0].trim();
}

function extractKeyframes(css, name) {
  const token = `@keyframes ${name}`;
  const start = css.indexOf(token);
  if (start < 0) throw new Error(`Missing upstream keyframes: ${name}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`Unclosed upstream keyframes: ${name}`);
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function assertScopedSelectors(root) {
  root.walkRules((rule) => {
    const insideKeyframes = rule.parent?.type === "atrule" && /keyframes$/u.test(rule.parent.name);
    if (insideKeyframes) return;
    for (const selector of rule.selectors ?? []) {
      if (/(^|[^\\])&/u.test(selector) && hasScopedParent(rule)) continue;
      if (!selector.includes(scope)) throw new Error(`Unscoped Magic UI selector: ${selector}`);
    }
  });
}

function hasScopedParent(rule) {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === "rule" && parent.selectors?.some((selector) => selector.includes(scope))) return true;
    parent = parent.parent;
  }
  return false;
}

function extractGeneratedBlock(styles) {
  const start = styles.indexOf(startMarker);
  const end = styles.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error("Missing Magic UI CSS markers in styles.css");
  return styles.slice(start, end + endMarker.length);
}
