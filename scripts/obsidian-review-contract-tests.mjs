import { disposableTestOutputRoot } from "./disposable-test-root.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_HARD_RULES, SOURCE_WARNING_RULES, PACKAGE_HARD_RULES, productionLintFiles, auditResolvedContracts,
  auditLintCoverage, collectFindings, isHardFinding, findingFingerprint, createBaseline,
  validateBaseline, createWarningBaseline, validateWarningBaseline, createCssBaseline, validateCssBaseline, compareBaseline, validateResolvedRules
} from "./obsidian-review-contract.mjs";
import { productionCssFiles, auditCssCoverage, runCssBehaviorSentinels, CSS_REVIEW_CONFIG } from "./obsidian-css-review.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const finding = { path: "src/example.ts", rule: "@typescript-eslint/no-unnecessary-condition", severity: 2,
  message: "Unsafe assignment of an `any` value.", context: "const value = legacy();", line: 3, column: 1 };
const accepted = createBaseline([finding]);
check(validateBaseline(accepted).length === 0, "valid fingerprint baseline");
check(validateBaseline(createBaseline([])).length === 0, "empty baseline");
for (const [name, mutate] of [
  ["schema", b => { b.schemaVersion = 3; }],
  ["source", b => { b.source = "unreviewed"; }],
  ["extra field", b => { b.allowNewErrors = true; }],
  ["negative total", b => { b.total = -1; }],
  ["fractional total", b => { b.total = 1.5; }],
  ["string total", b => { b.total = "1"; }],
  ["total mismatch", b => { b.total = 2; }],
  ["zero count", b => { b.findings[0].count = 0; b.total = 0; }],
  ["negative count", b => { b.findings[0].count = -1; }],
  ["fractional count", b => { b.findings[0].count = 0.5; }],
  ["string count", b => { b.findings[0].count = "1"; }],
  ["infinite count", b => { b.findings[0].count = Infinity; }],
  ["unsafe count", b => { b.findings[0].count = Number.MAX_SAFE_INTEGER + 1; }],
  ["NaN total", b => { b.total = NaN; }],
  ["severity downgrade", b => { b.findings[0].severity = 1; b.findings[0].fingerprint = findingFingerprint(b.findings[0]); }],
  ["duplicate fingerprint", b => { b.findings.push(structuredClone(b.findings[0])); b.total = 2; }],
  ["edited context", b => { b.findings[0].context = "const value = changed();"; }],
  ["missing context", b => { delete b.findings[0].context; }],
  ["extra entry field", b => { b.findings[0].severityOverride = 1; }],
  ["absolute path", b => { b.findings[0].path = "/private-source.ts"; b.findings[0].fingerprint = findingFingerprint(b.findings[0]); }],
  ["parent path", b => { b.findings[0].path = "src/../secret.ts"; b.findings[0].fingerprint = findingFingerprint(b.findings[0]); }],
  ["hard finding", b => { b.findings[0].rule = "@typescript-eslint/no-floating-promises"; b.findings[0].fingerprint = findingFingerprint(b.findings[0]); }]
]) {
  const candidate = structuredClone(accepted); mutate(candidate);
  check(validateBaseline(candidate).length > 0, `must reject ${name}`);
}
for (const changed of [
  { context: "const value = replacement();" }, { message: "Different unsafe error" },
  { path: "src/elsewhere.ts" }, { rule: "@typescript-eslint/no-unnecessary-type-parameters" }
]) check(compareBaseline(createBaseline([{ ...finding, ...changed }]), accepted).regressions.length === 1, "same-count debt substitution must fail");
check(compareBaseline(createBaseline([finding, finding]), accepted).regressions.length === 1, "count increase must fail");
check(compareBaseline(createBaseline([]), accepted).reductions.length === 1, "resolved debt must be tightened");
check(compareBaseline(createBaseline([{ ...finding, line: 300 }]), accepted).regressions.length === 0, "unrelated preceding line changes preserve identity");

const warning = { ...finding, rule: "no-alert", severity: 1, message: "Unexpected alert." };
const warningBaseline = createWarningBaseline([warning]);
check(validateWarningBaseline(warningBaseline).length === 0, "valid warning fingerprint baseline");
check(validateBaseline(warningBaseline).length > 0 && validateWarningBaseline(accepted).length > 0, "error and warning baselines cannot be interchanged");
for (const changed of [{ context: "changed();" }, { path: "src/elsewhere.ts" }, { rule: "no-undef" }, { message: "Different warning." }]) {
  check(compareBaseline(createWarningBaseline([{ ...warning, ...changed }]), warningBaseline).regressions.length === 1, "warning substitution must fail");
}
check(compareBaseline(createWarningBaseline([warning, warning]), warningBaseline).regressions.length === 1, "warning count increase must fail");
check(compareBaseline(createWarningBaseline([]), warningBaseline).reductions.length === 1, "resolved warning must be tightened");
check(compareBaseline(createWarningBaseline([{ ...warning, line: 99 }]), warningBaseline).regressions.length === 0, "line movement preserves warning identity");
const weakenedWarning = structuredClone(warningBaseline); weakenedWarning.findings[0].severity = 2;
weakenedWarning.findings[0].fingerprint = findingFingerprint(weakenedWarning.findings[0]);
check(validateWarningBaseline(weakenedWarning).length > 0, "warning severity change must fail");
const suppressedWarning = collectFindings(root, [{ filePath: path.join(root, "src/example.ts"), source: warning.context, messages: [],
  suppressedMessages: [{ severity: 1, ruleId: warning.rule, message: warning.message, line: 1 }] }], { includeWarnings: true });
check(suppressedWarning.length === 1 && suppressedWarning[0].suppressed, "suppressed warning remains visible");
assert.throws(() => createWarningBaseline(suppressedWarning)); checks += 1;

const cssFinding = { ...warning, path: "src/example.css", rule: "declaration-no-important", message: "Avoid !important.", context: "a { color: red !important; }" };
const cssBaseline = createCssBaseline([cssFinding]);
check(validateCssBaseline(cssBaseline).length === 0, "valid CSS fingerprint baseline");
assert.throws(() => createCssBaseline([{ ...cssFinding, rule: "selector-type-no-unknown" }])); checks += 1;
check(validateWarningBaseline(cssBaseline).length > 0 && validateCssBaseline(warningBaseline).length > 0, "CSS and JavaScript baselines cannot be interchanged");
check(compareBaseline(createCssBaseline([{ ...cssFinding, context: "b { color: red !important; }" }]), cssBaseline).regressions.length === 1, "CSS same-count substitution fails");
check(compareBaseline(createCssBaseline([cssFinding, cssFinding]), cssBaseline).regressions.length === 1, "CSS count increase fails");
check(compareBaseline(createCssBaseline([]), cssBaseline).reductions.length === 1, "resolved CSS debt must be tightened");
const cssSentinels = await runCssBehaviorSentinels();
check(CSS_REVIEW_CONFIG.rules["selector-type-no-unknown"][1].severity === "error", "unknown CSS types are a hard error");
check(cssSentinels.errors.length === 0, `CSS behavior sentinels pass: ${cssSentinels.errors.join(", ")}`);

for (const rule of [...Object.keys(SOURCE_HARD_RULES), "obsidianmd/platform", "obsidianmd/object-assign", "import/no-extraneous-dependencies", "@typescript-eslint/no-misused-promises", "@typescript-eslint/no-unsafe-call", "no-eval", "no-implied-eval", "@typescript-eslint/no-implied-eval",
  "@typescript-eslint/no-floating-promises", "depend/ban-dependencies", "no-unsanitized/method", "no-unsanitized/property",
  "eslint-comments/no-unlimited-disable", "eslint-comments/require-description", "eslint-comments/disable-enable-pair", "eslint-comments/no-restricted-disable", "<parse>"]) {
  check(isHardFinding({ ...finding, rule }), `${rule} is hard`);
  assert.throws(() => createBaseline([{ ...finding, rule }])); checks += 1;
}
check(isHardFinding({ ...finding, fatal: true }), "fatal error is hard");
check(isHardFinding({ ...finding, path: "manifest.json", rule: "json/no-unsafe-values" }), "all manifest JSON errors are hard");
const suppressed = collectFindings(root, [{ filePath: path.join(root, "src/example.ts"), source: "eval(input);", messages: [],
  suppressedMessages: [{ severity: 2, ruleId: "no-eval", message: "eval can be harmful.", line: 1 }] }]);
check(suppressed.length === 1 && suppressed[0].suppressed && isHardFinding(suppressed[0]), "suppressed hard finding cannot disappear");

const sourceRules = { ...SOURCE_HARD_RULES, ...SOURCE_WARNING_RULES };
check(validateResolvedRules("src/example.ts", { rules: sourceRules }).length === 0, "audited source settings pass");
for (const rule of Object.keys(SOURCE_HARD_RULES)) {
  const rules = structuredClone(sourceRules); rules[rule][0] = 1;
  check(validateResolvedRules("src/example.ts", { rules }).length > 0, `${rule} downgrade is blocked`);
}
for (const rule of Object.keys(SOURCE_WARNING_RULES)) {
  const rules = structuredClone(sourceRules); rules[rule][0] = 0;
  check(validateResolvedRules("src/example.ts", { rules }).length > 0, `${rule} disabling is blocked`);
}
for (const [rule, setting] of [
  ["no-eval", [2, { allowIndirect: true }]],
  ["eslint-comments/disable-enable-pair", [2, { allowWholeFile: true }]],
  ["obsidianmd/no-unsupported-api", [2, { minAppVersion: "99.0.0" }]],
  ["obsidianmd/rule-custom-message", [2, {}]],
  ["eslint-comments/no-restricted-disable", [2, "no-eval"]]
]) check(validateResolvedRules("src/example.ts", { rules: { ...sourceRules, [rule]: setting } }).length > 0, `${rule} option weakening is blocked`);
for (const setting of [[2], [2, { presets: ["native"] }], [2, { presets: ["native", "microutilities", "preferred"], allowed: ["axios"] }]]) {
  check(validateResolvedRules("package.json", { rules: { "depend/ban-dependencies": setting } }).length > 0, "dependency presets/options are locked");
}
check(validateResolvedRules("package.json", { rules: PACKAGE_HARD_RULES }).length === 0, "audited dependency settings pass");
check(auditLintCoverage(root, ["src/example.ts"], []).length === 1, "missing production lint result fails");
check(auditLintCoverage(root, ["src/example.ts"], [{ filePath: path.join(root, "src/example.ts") }]).length === 0, "one production result passes");
const ignored = await auditResolvedContracts({ isPathIgnored: async () => true, calculateConfigForFile: async () => ({ rules: sourceRules }) }, root, ["src/example.ts"]);
check(ignored.some(error => error.includes("ignored")), "ignored production source fails even with valid rules");

fs.mkdirSync(disposableTestOutputRoot(path.join(root, ".tmp")), { recursive: true });
const fixture = fs.mkdtempSync(path.join(disposableTestOutputRoot(path.join(root, ".tmp")), "obsidian-review-contract-"));
try {
  fs.mkdirSync(path.join(fixture, "src/nested"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src/tests"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "src/new.ts"), "export {};");
  fs.writeFileSync(path.join(fixture, "src/nested/new.mjs"), "export {};");
  fs.writeFileSync(path.join(fixture, "src/tests/fixture.ts"), "export {};");
  fs.writeFileSync(path.join(fixture, "styles.css"), "a { color: red; }");
  fs.writeFileSync(path.join(fixture, "src/nested/untracked.css"), "a { color: red; }");
  fs.writeFileSync(path.join(fixture, "src/tests/fixture.css"), "a { color: red; }");
  const cssFiles = productionCssFiles(fixture);
  check(cssFiles.includes("styles.css") && cssFiles.includes("src/nested/untracked.css"), "CSS enumeration includes release and untracked production files");
  check(!cssFiles.includes("src/tests/fixture.css"), "test CSS is excluded consistently with production source");
  check(auditCssCoverage(fixture, cssFiles, []).length === cssFiles.length, "missing CSS lint results fail");
  check(auditCssCoverage(fixture, cssFiles, cssFiles.map(file => ({ source: path.join(fixture, file) }))).length === 0, "one result for each CSS file passes");
  check(auditCssCoverage(fixture, ["styles.css"], [{ source: path.join(fixture, "styles.css"), ignored: true }]).length === 1, "ignored production CSS fails");
  const files = productionLintFiles(fixture);
  check(files.includes("src/new.ts") && files.includes("src/nested/new.mjs"), "filesystem enumeration includes untracked/nested production code");
  check(!files.includes("src/tests/fixture.ts"), "only declared non-production directories are excluded");
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
console.log(`Obsidian review contract tests: PASS (${checks} negative/positive checks).`);
