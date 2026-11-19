import fs from "node:fs";
import path from "node:path";
import stylelint from "stylelint";
import obsidian from "stylelint-config-obsidianmd";
import { CSS_HARD_RULES, CSS_HARD_FEATURES, isHardCssFeature } from "./obsidian-review-contract.mjs";

// Obsidian 1.11.4 uses Electron 39. Only the four Community CSS rules in
// scope are selected; the full contents of every production CSS file are read.
const selectedRules = [
  "declaration-no-important",
  "selector-pseudo-class-disallowed-list",
  "selector-type-no-unknown",
  "plugin/no-unsupported-browser-features"
];
const rules = Object.fromEntries(selectedRules.map(rule => [rule, obsidian.rules[rule]]));
for (const rule of CSS_HARD_RULES) rules[rule] = [rules[rule][0], { ...rules[rule][1], severity: "error" }];
rules["plugin/no-unsupported-browser-features"] = [true, {
  ...rules["plugin/no-unsupported-browser-features"][1],
  browsers: ["electron >= 39"]
}];
export const CSS_REVIEW_CONFIG = { plugins: obsidian.plugins, rules, ignoreDisables: true };

export function productionCssFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".css")) files.push(entry.name);
  }
  function visit(relative) {
    // The existing production contract excludes tests and upstream references.
    if (relative === "src/tests" || relative === "src/home/magic-ui/provenance") return;
    for (const entry of fs.readdirSync(path.join(rootDir, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Production source must be directly auditable: ${name}`);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && entry.name.endsWith(".css")) files.push(name);
    }
  }
  visit("src");
  if (!files.includes("styles.css")) throw new Error("Missing release stylesheet styles.css.");
  return files.sort();
}

export function auditCssCoverage(rootDir, files, results) {
  const counts = new Map();
  for (const result of results) {
    const file = path.relative(rootDir, result.source).split(path.sep).join("/");
    counts.set(file, (counts.get(file) ?? 0) + (result.ignored ? 0 : 1));
  }
  return files.filter(file => counts.get(file) !== 1).map(file => `${file}: expected exactly one CSS lint result, got ${counts.get(file) ?? 0}.`);
}

export async function lintProductionCss(rootDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
  if (manifest.minAppVersion !== "1.11.4") throw new Error("Review the CSS browser target when minAppVersion changes.");
  const files = productionCssFiles(rootDir);
  const result = await stylelint.lint({ files: files.map(file => path.join(rootDir, file)), config: CSS_REVIEW_CONFIG, cache: false });
  const errors = auditCssCoverage(rootDir, files, result.results);
  const findings = [];
  for (const file of result.results) {
    const relative = path.relative(rootDir, file.source).split(path.sep).join("/");
    const lines = fs.readFileSync(file.source, "utf8").split(/\r?\n/u);
    for (const invalid of file.invalidOptionWarnings ?? []) errors.push(`${relative}: ${invalid.text}`);
    for (const warning of file.warnings) {
      if (warning.severity !== "warning" || !selectedRules.includes(warning.rule)
        || isHardCssFeature({ rule: warning.rule, message: warning.text })) {
        errors.push(`${relative}:${warning.line}:${warning.column} ${warning.rule}: ${warning.text}`);
        continue;
      }
      findings.push({ path: relative, rule: warning.rule, severity: 1, message: warning.text,
        context: lines.slice(Math.max(0, warning.line - 1), warning.endLine ?? warning.line).map(line => line.trim()).join("\n"),
        line: warning.line, column: warning.column, suppressed: false });
    }
  }
  return { files, findings, errors };
}

export async function runCssBehaviorSentinels() {
  const source = 'article:has(span) { color: red !important; column-gap: 1px; clip-path: inset(50%); display: contents; }\nechoink-unknown-type { display: block; }';
  const result = await stylelint.lint({ code: source, codeFilename: "src/css-review-sentinel.css", config: CSS_REVIEW_CONFIG });
  const found = new Set(result.results.flatMap(item => item.warnings.map(warning => warning.rule)));
  const errors = selectedRules.filter(rule => !found.has(rule)).map(rule => `CSS sentinel: ${rule} did not detect its bad sample.`);
  for (const feature of CSS_HARD_FEATURES) {
    if (!result.results.some(item => item.warnings.some(warning => warning.text.includes(`feature "${feature}"`)
      && isHardCssFeature({ rule: warning.rule, message: warning.text })))) {
      errors.push(`CSS sentinel: ${feature} must reject its bad sample as a hard feature.`);
    }
  }
  for (const rule of CSS_HARD_RULES) {
    if (!result.results.some(item => item.warnings.some(warning => warning.rule === rule && warning.severity === "error"))) {
      errors.push(`CSS sentinel: ${rule} must reject its bad sample as an error.`);
    }
  }
  const suppressed = await stylelint.lint({ code: '/* stylelint-disable declaration-no-important */\na { color: red !important; }',
    codeFilename: "src/css-review-sentinel.css", config: CSS_REVIEW_CONFIG });
  if (!suppressed.results.some(item => item.warnings.some(warning => warning.rule === "declaration-no-important"))) {
    errors.push("CSS sentinel: inline suppression hid an !important finding.");
  }
  const invalid = await stylelint.lint({ code: 'a { color: red;', codeFilename: "src/css-review-sentinel.css", config: CSS_REVIEW_CONFIG });
  if (!invalid.results.some(item => item.warnings.some(warning => warning.rule === "CssSyntaxError" && warning.severity === "error"))) {
    errors.push("CSS sentinel: invalid CSS did not produce a syntax error.");
  }
  return { count: 3, errors };
}

/**
 * 开关只有一套尺寸（origin-controls.css：轨道 36×21、滑块 15、位移 15）。
 * 页面样式另写尺寸或位移，会出现“开到一半”的开关，所以这里直接拦下。
 */
export async function auditUnifiedSwitch(rootDir) {
  const { default: postcss } = await import("postcss");
  const { readdir, readFile } = await import("node:fs/promises");
  const pathModule = await import("node:path");
  const errors = [], geometry = /^(?:width|height|min-width|max-width|min-height|max-height|transform|translate|border-radius|top|left|inset)$/u;
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = pathModule.join(directory, entry.name);
      if (entry.isDirectory()) { if (!/^(?:iphone|ipad|mobile|tests)$/u.test(entry.name)) await walk(full); continue; }
      if (!entry.name.endsWith(".css") || entry.name === "origin-controls.css") continue;
      postcss.parse(await readFile(full, "utf8")).walkRules(rule => {
        for (const selector of rule.selectors ?? []) {
          // 只看以开关或滑块本身为目标的选择器，不看“开关所在的行”。
          let target = selector.split(/[\s>+~]+/u).at(-1) ?? "", previous = "";
          // :not(...) 里提到开关是“排除开关”，不算以开关为目标。
          while (previous !== target) { previous = target; target = target.replace(/:not\((?:[^()]|\([^()]*\))*\)/gu, ""); }
          if (!/\[data-slot=["']?switch(?:-thumb)?["']?\]/u.test(target)) continue;
          rule.walkDecls(declaration => {
            if (geometry.test(declaration.prop)) errors.push(`${pathModule.relative(rootDir, full)}:${declaration.source?.start?.line ?? 0} 开关尺寸只在 origin-controls.css 定义，这里不要写 ${declaration.prop}`);
          });
          break;
        }
      });
    }
  };
  await walk(pathModule.join(rootDir, "src"));
  return { errors };
}
