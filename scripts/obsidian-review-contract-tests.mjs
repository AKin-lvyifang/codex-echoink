import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_HARD_RULES, PACKAGE_HARD_RULES, productionLintFiles, auditResolvedContracts,
  auditLintCoverage, collectFindings, isHardFinding, findingFingerprint, createBaseline,
  validateBaseline, compareBaseline, validateResolvedRules
} from "./obsidian-review-contract.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
const finding = { path: "src/example.ts", rule: "@typescript-eslint/no-unsafe-assignment", severity: 2,
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
  { path: "src/elsewhere.ts" }, { rule: "@typescript-eslint/no-unsafe-call" }
]) check(compareBaseline(createBaseline([{ ...finding, ...changed }]), accepted).regressions.length === 1, "same-count debt substitution must fail");
check(compareBaseline(createBaseline([finding, finding]), accepted).regressions.length === 1, "count increase must fail");
check(compareBaseline(createBaseline([]), accepted).reductions.length === 1, "resolved debt must be tightened");
check(compareBaseline(createBaseline([{ ...finding, line: 300 }]), accepted).regressions.length === 0, "unrelated preceding line changes preserve identity");

for (const rule of ["obsidianmd/platform", "no-eval", "no-implied-eval", "@typescript-eslint/no-implied-eval",
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

check(validateResolvedRules("src/example.ts", { rules: SOURCE_HARD_RULES }).length === 0, "audited source settings pass");
for (const rule of Object.keys(SOURCE_HARD_RULES)) {
  const rules = structuredClone(SOURCE_HARD_RULES); rules[rule][0] = 1;
  check(validateResolvedRules("src/example.ts", { rules }).length > 0, `${rule} downgrade is blocked`);
}
for (const [rule, setting] of [
  ["no-eval", [2, { allowIndirect: true }]],
  ["eslint-comments/disable-enable-pair", [2, { allowWholeFile: true }]],
  ["obsidianmd/no-unsupported-api", [2, { minAppVersion: "99.0.0" }]],
  ["obsidianmd/rule-custom-message", [2, {}]],
  ["eslint-comments/no-restricted-disable", [2, "no-eval"]]
]) check(validateResolvedRules("src/example.ts", { rules: { ...SOURCE_HARD_RULES, [rule]: setting } }).length > 0, `${rule} option weakening is blocked`);
for (const setting of [[2], [2, { presets: ["native"] }], [2, { presets: ["native", "microutilities", "preferred"], allowed: ["axios"] }]]) {
  check(validateResolvedRules("package.json", { rules: { "depend/ban-dependencies": setting } }).length > 0, "dependency presets/options are locked");
}
check(validateResolvedRules("package.json", { rules: PACKAGE_HARD_RULES }).length === 0, "audited dependency settings pass");
check(auditLintCoverage(root, ["src/example.ts"], []).length === 1, "missing production lint result fails");
check(auditLintCoverage(root, ["src/example.ts"], [{ filePath: path.join(root, "src/example.ts") }]).length === 0, "one production result passes");
const ignored = await auditResolvedContracts({ isPathIgnored: async () => true, calculateConfigForFile: async () => ({ rules: SOURCE_HARD_RULES }) }, root, ["src/example.ts"]);
check(ignored.some(error => error.includes("ignored")), "ignored production source fails even with valid rules");

fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, ".tmp/obsidian-review-contract-"));
try {
  fs.mkdirSync(path.join(fixture, "src/nested"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "src/tests"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "src/new.ts"), "export {};");
  fs.writeFileSync(path.join(fixture, "src/nested/new.mjs"), "export {};");
  fs.writeFileSync(path.join(fixture, "src/tests/fixture.ts"), "export {};");
  const files = productionLintFiles(fixture);
  check(files.includes("src/new.ts") && files.includes("src/nested/new.mjs"), "filesystem enumeration includes untracked/nested production code");
  check(!files.includes("src/tests/fixture.ts"), "only declared non-production directories are excluded");
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
console.log(`Obsidian review contract tests: PASS (${checks} negative/positive checks).`);
