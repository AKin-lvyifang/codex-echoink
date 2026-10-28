import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { validateManifestSource } from "./manifest-contract.mjs";
import {
  productionLintFiles, auditResolvedContracts, auditLintCoverage, collectFindings,
  isHardFinding, createBaseline, validateBaseline, createWarningBaseline, validateWarningBaseline, compareBaseline, runBehaviorSentinels
} from "./obsidian-review-contract.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = path.join(rootDir, "config", "obsidian-review-baseline.json");
const warningBaselinePath = path.join(rootDir, "config", "obsidian-review-warning-baseline.json");
const writeBaseline = process.argv.includes("--write-baseline");

try {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  requirePass("Invalid Obsidian review baseline", validateBaseline(baseline));
  const warningBaseline = JSON.parse(fs.readFileSync(warningBaselinePath, "utf8"));
  requirePass("Invalid Obsidian review warning baseline", validateWarningBaseline(warningBaseline));
  requirePass("Invalid manifest", validateManifestSource(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8")));
  const eslint = new ESLint({ cwd: rootDir });
  const files = productionLintFiles(rootDir);
  requirePass("Obsidian review rule contract failed", await auditResolvedContracts(eslint, rootDir, files));
  const results = await eslint.lintFiles(files);
  requirePass("Obsidian review source coverage failed", auditLintCoverage(rootDir, files, results));
  const allFindings = collectFindings(rootDir, results, { includeWarnings: true });
  const findings = allFindings.filter(finding => finding.severity !== 1);
  const warnings = allFindings.filter(finding => finding.severity === 1);
  requirePass("Suppressed warnings are forbidden", warnings.filter(finding => finding.suppressed).map(formatFinding));
  requirePass("Obsidian review hard findings are forbidden, including suppressed findings", findings.filter(isHardFinding).map(formatFinding));
  const sentinels = await runBehaviorSentinels(eslint, rootDir);
  requirePass("Obsidian review behavior sentinels failed", sentinels.errors);
  const current = createBaseline(findings);
  requirePass("Invalid current lint findings", validateBaseline(current));
  const comparison = compareBaseline(current, baseline);
  const currentWarnings = createWarningBaseline(warnings);
  requirePass("Invalid current lint warnings", validateWarningBaseline(currentWarnings));
  const warningComparison = compareBaseline(currentWarnings, warningBaseline);
  requirePass("New Obsidian review warning fingerprints or increased counts are forbidden", warningComparison.regressions.map(entry => `${entry.path} ${entry.rule}: ${entry.message}\n  ${entry.context}`));
  requirePass("New Obsidian review fingerprints or increased counts are forbidden", comparison.regressions.map(entry => `${entry.path} ${entry.rule}: ${entry.message}\n  ${entry.context}`));
  if (writeBaseline) {
    // Only delete resolved debt or reduce existing counts; never initialize a
    // missing baseline or approve a new finding.
    if (comparison.reductions.length) fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    if (warningComparison.reductions.length) fs.writeFileSync(warningBaselinePath, `${JSON.stringify(currentWarnings, null, 2)}\n`, "utf8");
    console.log(`Obsidian review baseline: ${baseline.total} -> ${current.total} error(s), ${warningBaseline.total} -> ${currentWarnings.total} warning(s); no new fingerprints.`);
  } else {
    requirePass("Resolved baseline debt must be removed with lint:update-baseline after review", comparison.reductions.map(entry => `${entry.path} ${entry.rule} ${entry.fingerprint}`));
    requirePass("Resolved warning debt must be removed with lint:update-baseline after review", warningComparison.reductions.map(entry => `${entry.path} ${entry.rule} ${entry.fingerprint}`));
  }
  console.log(`Obsidian review lint: PASS (${files.length} covered files, ${current.total} unchanged error(s), ${currentWarnings.total} unchanged warning(s), ${sentinels.count} behavior sentinels).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function requirePass(label, errors) {
  if (errors.length) throw new Error(`${label}:\n${errors.map(error => `- ${error}`).join("\n")}`);
}
function formatFinding(finding) {
  return `${finding.path}:${finding.line}:${finding.column} ${finding.rule}${finding.suppressed ? " (suppressed)" : ""} ${finding.message}`;
}
