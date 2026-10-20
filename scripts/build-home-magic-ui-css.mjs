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
const pdfReadingSource = await readFile(path.join(rootDir, "src/styles/pdf-reading.css"), "utf8");
const paperGuideSource = await readFile(path.join(rootDir, "src/ui/paper-guide.css"), "utf8");
const boundarySource = await readFile(path.join(rootDir, "src/styles/theme-boundary.css"), "utf8");
const selectionAskSource = await readFile(path.join(rootDir, "src/styles/selection-ask.css"), "utf8");
const moduleSettingsSource = await readFile(path.join(rootDir, "src/styles/desktop-module-settings.css"), "utf8");
const knowledgeSettingsSource = await readFile(path.join(rootDir, "src/styles/desktop-knowledge-settings.css"), "utf8");
const accountSettingsSource = await readFile(path.join(rootDir, "src/styles/desktop-account-settings.css"), "utf8");
const alignedSettingsSource = await readFile(path.join(rootDir, "src/styles/settings-demo-align.css"), "utf8");
const alignedFormsSource = await readFile(path.join(rootDir, "src/styles/settings-demo-forms.css"), "utf8");
const alignedModulesSource = await readFile(path.join(rootDir, "src/styles/settings-demo-modules.css"), "utf8");
const generationUiSource = await readFile(path.join(rootDir, "src/styles/generation-ui.css"), "utf8");
const settingsGenerated = [settingsStart, selectionAskSource.trim(), settingsSource.trim(), originSource.trim(), boundarySource.trim(), paperGuideSource.trim(), pdfReadingSource.trim(), moduleSettingsSource.trim(), knowledgeSettingsSource.trim(), accountSettingsSource.trim(), alignedSettingsSource.trim(), alignedFormsSource.trim(), alignedModulesSource.trim(), generationUiSource.trim(), settingsEnd].join("\n");
const agentStart = "/* ECHOINK_AGENT_WORKBENCH_CSS_START */";
const agentEnd = "/* ECHOINK_AGENT_WORKBENCH_CSS_END */";
const agentCss = await Promise.all(["agent-tasks.css", "agent-editor.css", "agent-approval.css", "workbench.css", "journal-page.css", "todo-page.css", "knowledge-page.css", "english-diary-page.css", "pdf-reading-page.css", "module-navigation.css", "agent-settings.css", "user-profile-settings.css"].map(name => readFile(path.join(rootDir, "src/styles", name), "utf8")));
const agentGenerated = `${agentStart}\n${agentCss.map(css => css.trim()).join("\n\n")}\n${agentEnd}`;
const agentIndex = styles.indexOf(agentStart);
const agentCurrent = agentIndex < 0 ? "" : styles.slice(agentIndex, styles.indexOf(agentEnd, agentIndex) + agentEnd.length);
const settingsIndex = styles.indexOf(settingsStart);
const settingsCurrent = settingsIndex < 0 ? "" : styles.slice(settingsIndex, styles.indexOf(settingsEnd, settingsIndex) + settingsEnd.length);
const diaryStart = "/* ECHOINK_ENGLISH_DIARY_CSS_START */";
const diaryEnd = "/* ECHOINK_ENGLISH_DIARY_CSS_END */";
const diaryCss = await Promise.all(["ui.css", "integration.css"].map((name) => readFile(path.join(rootDir, "src/english-diary", name), "utf8")));
const diaryGenerated = `${diaryStart}\n${diaryCss.map((css) => css.trim()).join("\n\n")}\n${diaryEnd}`;
const diaryIndex = styles.indexOf(diaryStart);
const diaryCurrent = diaryIndex < 0 ? "" : styles.slice(diaryIndex, styles.indexOf(diaryEnd, diaryIndex) + diaryEnd.length);

const iphoneStart = "/* ECHOINK_IPHONE_PAGES_START */";
const iphoneEnd = "/* ECHOINK_IPHONE_PAGES_END */";
const iphoneCss = await Promise.all(["shell.css", "workbench.css", "task-detail.css", "integration.css", "settings.css", "capability-pages.css", "agent-settings-pages.css", "account-pages.css", "modules.css", "knowledge-settings-pages.css", "knowledge-pages.css", "english-diary-pages.css"].map(name => readFile(path.join(rootDir, "src/ui/iphone", name), "utf8")));
const iphoneGenerated = `${iphoneStart}\n${iphoneCss.map(css => css.trim()).join("\n\n")}\n${iphoneEnd}`;
const iphoneIndex = styles.indexOf(iphoneStart);
const iphoneCurrent = iphoneIndex < 0 ? "" : styles.slice(iphoneIndex, styles.indexOf(iphoneEnd, iphoneIndex) + iphoneEnd.length);

const ipadStart = "/* ECHOINK_IPAD_PAGES_START */";
const ipadEnd = "/* ECHOINK_IPAD_PAGES_END */";
const ipadCss = await Promise.all(["shell.css", "workbench.css", "task-detail.css", "agent-pane.css", "integration.css", "settings.css", "capability-pages.css", "agent-settings-pages.css", "account-pages.css", "modules.css", "knowledge-settings-pages.css", "knowledge-pages.css", "english-diary-pages.css"].map(name => readFile(path.join(rootDir, "src/ui/ipad", name), "utf8")));
const ipadGenerated = `${ipadStart}\n${ipadCss.map(css => css.trim()).join("\n\n")}\n${ipadEnd}`;
const ipadIndex = styles.indexOf(ipadStart);
const ipadCurrent = ipadIndex < 0 ? "" : styles.slice(ipadIndex, styles.indexOf(ipadEnd, ipadIndex) + ipadEnd.length);

if (checkOnly) {
  if (ipadCurrent !== ipadGenerated) throw new Error("Generated iPad pages CSS is stale");
  if (iphoneCurrent !== iphoneGenerated) throw new Error("Generated iPhone pages CSS is stale");
  if (agentCurrent !== agentGenerated) throw new Error("Generated Agent workbench CSS is stale");
  if (diaryCurrent !== diaryGenerated) throw new Error("Generated English Diary CSS is stale. Run node scripts/build-home-magic-ui-css.mjs");
  if (current !== generated) throw new Error("Generated Magic UI CSS is stale. Run node scripts/build-home-magic-ui-css.mjs");
  if (settingsCurrent !== settingsGenerated) throw new Error("Generated workspace settings CSS is stale");
  console.log("Home Magic UI and workspace settings CSS: PASS");
} else {
  let next = styles.replace(current, generated);
  next = diaryCurrent ? next.replace(diaryCurrent, diaryGenerated) : `${next.trimEnd()}\n\n${diaryGenerated}\n`;
  next = settingsCurrent ? next.replace(settingsCurrent, settingsGenerated) : `${next.trimEnd()}\n\n${settingsGenerated}\n`;
  next = agentCurrent ? next.replace(agentCurrent, agentGenerated) : `${next.trimEnd()}\n\n${agentGenerated}\n`;
  next = iphoneCurrent ? next.replace(iphoneCurrent, iphoneGenerated) : `${next.trimEnd()}\n\n${iphoneGenerated}\n`;
  next = ipadCurrent ? next.replace(ipadCurrent, ipadGenerated) : `${next.trimEnd()}\n\n${ipadGenerated}\n`;
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
