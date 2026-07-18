import crypto from "crypto";
import fs from "fs";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";
import esbuild from "esbuild";
import { ESLint } from "eslint";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = path.join(rootDir, "config", "obsidian-review-baseline.json");
const writeBaseline = process.argv.includes("--write-baseline");
const productionSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const productionSourceDiscovery = await discoverProductionSources();
const productionSourcePaths = productionSourceDiscovery.paths;
const eslint = new ESLint({ cwd: rootDir });
const results = await eslint.lintFiles(["."]);
const hardErrorRules = new Set([
  "no-eval",
  "no-implied-eval",
  "@typescript-eslint/no-implied-eval",
  "no-unsanitized/method",
  "no-unsanitized/property",
  "@typescript-eslint/no-floating-promises",
  "depend/ban-dependencies",
  "eslint-comments/disable-enable-pair",
  "eslint-comments/no-restricted-disable",
  "eslint-comments/no-unlimited-disable",
  "eslint-comments/require-description",
]);
const requiredSourceHardRuleSettings = new Map([
  ["no-eval", [2, { allowIndirect: false }]],
  ["no-implied-eval", [2]],
  ["@typescript-eslint/no-implied-eval", [2]],
  ["@typescript-eslint/no-floating-promises", [2]],
  ["no-unsanitized/method", [2]],
  ["no-unsanitized/property", [2]],
  [
    "obsidianmd/rule-custom-message",
    [
      2,
      {
        "no-console": {
          messages: {
            "Unexpected console statement. Only these console methods are allowed: warn, error, debug.":
              "Avoid unnecessary logging to console. See https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines#Avoid+unnecessary+logging+to+console",
          },
          options: [{ allow: ["warn", "error", "debug"] }],
        },
        "no-new-func": {
          messages: {
            "The Function constructor is eval":
              "Using the `Function` constructor is dangerous because it executes arbitrary code, similar to `eval()`",
          },
        },
      },
    ],
  ],
  ["obsidianmd/settings-tab/no-manual-html-headings", [2]],
  ["obsidianmd/settings-tab/no-problematic-settings-headings", [2]],
  ["obsidianmd/detach-leaves", [2]],
  ["obsidianmd/no-forbidden-elements", [2]],
  ["obsidianmd/no-sample-code", [2]],
  ["obsidianmd/no-static-styles-assignment", [2]],
  ["obsidianmd/platform", [2]],
  ["obsidianmd/regex-lookbehind", [2]],
  ["obsidianmd/sample-names", [2]],
  ["obsidianmd/no-plugin-as-component", [2]],
  ["obsidianmd/no-view-references-in-plugin", [2]],
  ["obsidianmd/no-unsupported-api", [2]],
  ["eslint-comments/disable-enable-pair", [2, { allowWholeFile: false }]],
  [
    "eslint-comments/no-restricted-disable",
    [
      2,
      "obsidianmd/*",
      "no-eval",
      "no-implied-eval",
      "@typescript-eslint/no-implied-eval",
      "@typescript-eslint/no-floating-promises",
      "no-unsanitized/method",
      "no-unsanitized/property",
    ],
  ],
  ["eslint-comments/no-unlimited-disable", [2]],
  ["eslint-comments/require-description", [2]],
]);
const requiredManifestHardRuleSettings = new Map([
  ["obsidianmd/validate-manifest", [2]],
]);
const requiredPackageHardRuleSettings = new Map([
  ["depend/ban-dependencies", [2, { presets: ["native", "microutilities", "preferred"] }]],
]);
const configFailures = await reviewConfigFailures(
  eslint,
  results,
  productionSourcePaths,
  productionSourceDiscovery.failures,
);

const findings = [];
const suppressedFindings = [];
for (const result of results) {
  const relativePath = path.relative(rootDir, result.filePath).split(path.sep).join("/");
  collectFindings(result.messages, findings, result, relativePath, false);
  collectFindings(result.suppressedMessages ?? [], suppressedFindings, result, relativePath, true);
}

function collectFindings(messages, target, result, relativePath, suppressed) {
  for (const message of messages) {
    const finding = {
      path: relativePath,
      rule: message.ruleId ?? "<parse>",
      severity: message.severity === 2 ? "error" : "warning",
      messageId: message.messageId ?? "",
      line: message.line ?? 0,
      column: message.column ?? 0,
      endLine: message.endLine ?? message.line ?? 0,
      endColumn: message.endColumn ?? message.column ?? 0,
      message: message.message,
      evidence: findingEvidence(result.source, message),
      suppressed,
    };
    target.push({
      ...finding,
      fingerprint: fingerprintFinding(finding),
    });
  }
}

const groupedFindings = groupFindings(findings);
const ruleCounts = countRules(findings);
const blockingHardErrors = [...findings, ...suppressedFindings].filter(isHardError);
const snapshot = {
  schemaVersion: 2,
  source: "eslint-plugin-obsidianmd recommended",
  total: findings.length,
  errors: findings.filter((finding) => finding.severity === "error").length,
  warnings: findings.filter((finding) => finding.severity === "warning").length,
  ruleCounts,
  findings: groupedFindings,
};

let baseline = null;
if (fs.existsSync(baselinePath)) {
  baseline = readAndValidateBaseline();
} else if (!writeBaseline) {
  console.error("Missing config/obsidian-review-baseline.json. Run npm run lint:update-baseline after reviewing every finding.");
  process.exit(1);
}

if (writeBaseline) {
  const writeRegressions = baseline ? findRegressions(groupedFindings, baseline) : [];
  const writeImprovements = baseline ? findImprovements(groupedFindings, baseline) : [];
  if (configFailures.length > 0) {
    printConfigFailures(configFailures);
  }
  if (blockingHardErrors.length > 0) {
    console.error("The Obsidian review baseline cannot approve hard-rule errors:");
    for (const finding of blockingHardErrors) printFinding(finding);
  }
  if (writeRegressions.length > 0) {
    console.error("\nThe baseline update cannot approve new or increased review debt:");
    printRegressions(writeRegressions);
  }
  if (configFailures.length > 0 || blockingHardErrors.length > 0 || writeRegressions.length > 0) process.exit(1);
  if (baseline && writeImprovements.length === 0) {
    console.log("Obsidian review baseline already matches the current debt; no update was written.");
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Obsidian review baseline written: ${snapshot.total} findings (${snapshot.errors} errors, ${snapshot.warnings} warnings).`);
  process.exit(0);
}

const regressions = findRegressions(groupedFindings, baseline);
const improvements = findImprovements(groupedFindings, baseline);

console.log(
  `Obsidian review lint: ${snapshot.total} findings `
  + `(${snapshot.errors} errors, ${snapshot.warnings} warnings); `
  + `baseline ${baseline.total} (${baseline.errors} errors, ${baseline.warnings} warnings).`
);

if (configFailures.length > 0) {
  printConfigFailures(configFailures);
}

if (blockingHardErrors.length > 0) {
  console.error("\nObsidian hard-rule errors must be zero:");
  for (const finding of blockingHardErrors) printFinding(finding);
}

if (regressions.length > 0) {
  console.error("\nNew Obsidian review findings are not allowed:");
  printRegressions(regressions);
  console.error("\nRun npm run lint:report for details. Update the baseline only after an explicit review.");
}

if (improvements.length > 0) {
  console.error("\nThe review debt decreased; the baseline must be tightened before this change can pass:");
  for (const improvement of improvements) {
    const { finding, current } = improvement;
    console.error(
      `- ${finding.path} ${finding.rule} ${finding.severity}: `
      + `${current} current finding(s) (baseline ${finding.count})`,
    );
  }
  console.error("\nReview the reductions, then run npm run lint:update-baseline so removed debt cannot silently return.");
}

if (configFailures.length > 0 || blockingHardErrors.length > 0 || regressions.length > 0 || improvements.length > 0) process.exit(1);

function countRules(items) {
  const result = {};
  for (const finding of items) {
    const key = `${finding.path}::${finding.rule}::${finding.severity}`;
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function groupFindings(items) {
  const groups = new Map();
  for (const finding of items) {
    const key = findingComparisonKey(finding);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      fingerprint: finding.fingerprint,
      path: finding.path,
      rule: finding.rule,
      severity: finding.severity,
      messageId: finding.messageId,
      message: finding.message,
      evidence: finding.evidence,
      count: 1,
    });
  }
  return [...groups.values()].sort((left, right) => {
    const leftKey = `${left.path}\0${left.rule}\0${left.severity}\0${left.evidence}\0${left.fingerprint}`;
    const rightKey = `${right.path}\0${right.rule}\0${right.severity}\0${right.evidence}\0${right.fingerprint}`;
    return leftKey.localeCompare(rightKey);
  });
}

function findingEvidence(source, message) {
  if (!source || !message.line) return "";
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, message.line - 2);
  const end = Math.min(lines.length, (message.endLine ?? message.line) + 1);
  return lines
    .slice(start, end)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function fingerprintFinding(finding) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([
      finding.path,
      finding.rule,
      finding.severity,
      finding.messageId,
      finding.message,
      finding.evidence,
    ]))
    .digest("hex");
}

function findingComparisonKey(finding) {
  return fingerprintFinding(finding);
}

function isHardError(finding) {
  return finding.severity === "error"
    && (
      ["manifest.json", "package.json", "versions.json"].includes(finding.path)
      || finding.rule === "<parse>"
      || finding.rule.startsWith("obsidianmd/")
      || hardErrorRules.has(finding.rule)
    );
}

function printFinding(finding) {
  console.error(
    `- ${finding.path}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}`
    + `${finding.suppressed ? " (suppressed by an ESLint directive)" : ""}`,
  );
}

async function discoverProductionSources() {
  const sourceRoot = path.join(rootDir, "src");
  const testRoot = path.join(sourceRoot, "tests");
  const paths = new Set();
  const failures = [];

  if (fs.existsSync(sourceRoot)) visit(sourceRoot);

  try {
    const bundleResult = await esbuild.build({
      absWorkingDir: rootDir,
      entryPoints: ["src/main.ts"],
      bundle: true,
      format: "cjs",
      logLevel: "silent",
      metafile: true,
      packages: "external",
      platform: "neutral",
      target: "es2022",
      treeShaking: true,
      write: false,
    });
    const bundledPaths = Object.keys(bundleResult.metafile.inputs)
      .map(projectRelativePath)
      .filter((bundledPath) => bundledPath !== null);
    const bundledTestPaths = bundledPaths.filter(
      (bundledPath) => bundledPath === "src/tests" || bundledPath.startsWith("src/tests/"),
    );
    if (bundledTestPaths.length > 0) {
      failures.push(`Production bundle includes src/tests input(s): ${bundledTestPaths.join(", ")}.`);
    }
    for (const bundledPath of bundledPaths) {
      if (
        !bundledPath.startsWith("node_modules/")
        && productionSourceExtensions.has(path.extname(bundledPath).toLowerCase())
      ) {
        paths.add(bundledPath);
      }
    }
  } catch (error) {
    failures.push(
      `Production bundle inputs could not be inspected: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (absolutePath !== testRoot) visit(absolutePath);
        continue;
      }
      if (
        (entry.isFile() || entry.isSymbolicLink())
        && productionSourceExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        paths.add(path.relative(rootDir, absolutePath).split(path.sep).join("/"));
      }
    }
  }

  return {
    failures,
    paths: [...paths].sort((left, right) => left.localeCompare(right)),
  };
}

function projectRelativePath(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
  const relativePath = path.relative(rootDir, absolutePath);
  if (
    !relativePath
    || relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(path.sep).join("/");
}

async function reviewConfigFailures(eslintInstance, lintResults, sourcePaths, discoveryFailures) {
  const failures = [...discoveryFailures];
  const lintedPaths = new Set(
    lintResults.map((result) => path.relative(rootDir, result.filePath).split(path.sep).join("/")),
  );
  if (sourcePaths.length === 0) failures.push("No production source files were found under src/.");
  if (!sourcePaths.includes("src/main.ts")) failures.push("Required production entry point is missing: src/main.ts.");

  const requiredPaths = [...new Set(["manifest.json", "package.json", "versions.json", ...sourcePaths])];
  for (const requiredPath of requiredPaths) {
    if (await eslintInstance.isPathIgnored(requiredPath)) {
      failures.push(`ESLint ignores required path: ${requiredPath}.`);
    }
    if (!lintedPaths.has(requiredPath)) {
      failures.push(`ESLint did not scan required path: ${requiredPath}.`);
    }
  }

  const manifestConfig = await eslintInstance.calculateConfigForFile("manifest.json");
  const packageConfig = await eslintInstance.calculateConfigForFile("package.json");
  for (const sourcePath of sourcePaths) {
    const sourceConfig = await eslintInstance.calculateConfigForFile(sourcePath);
    if (!sourceConfig) {
      failures.push(`ESLint has no configuration for production source: ${sourcePath}.`);
      continue;
    }
    const alteredRules = alteredRuleNames(sourceConfig, requiredSourceHardRuleSettings);
    if (alteredRules.length > 0) {
      failures.push(
        `Production source does not enforce the exact hard-rule settings: ${sourcePath} `
        + `(${alteredRules.join(", ")}).`,
      );
    }
  }
  const alteredManifestRules = alteredRuleNames(manifestConfig, requiredManifestHardRuleSettings);
  if (alteredManifestRules.length > 0) {
    failures.push(`manifest.json hard-rule settings changed: ${alteredManifestRules.join(", ")}.`);
  }
  const alteredPackageRules = alteredRuleNames(packageConfig, requiredPackageHardRuleSettings);
  if (alteredPackageRules.length > 0) {
    failures.push(`package.json hard-rule settings changed: ${alteredPackageRules.join(", ")}.`);
  }
  failures.push(...await reviewHardRuleBehavior(eslintInstance));
  return failures;
}

function alteredRuleNames(config, expectedSettings) {
  return [...expectedSettings]
    .filter(([rule, expectedSetting]) => stableJson(config?.rules?.[rule]) !== stableJson(expectedSetting))
    .map(([rule]) => rule);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function reviewHardRuleBehavior(eslintInstance) {
  const failures = [];

  try {
    const [sourceResult] = await eslintInstance.lintText(
      `
import { AbstractInputSuggest } from "obsidian";
declare class ReviewGateSuggest extends AbstractInputSuggest<string> {}
new Function("return 1");
eval("1");
declare const unsafeHtml: string;
const element = document.createElement("div");
element.innerHTML = unsafeHtml;
element.style.color = "red";
`,
      { filePath: "src/main.ts" },
    );
    const expectedSourceFindings = [
      ["obsidianmd/no-unsupported-api", "apiNotAvailable"],
      ["@typescript-eslint/no-implied-eval", "noFunctionConstructor"],
      ["obsidianmd/rule-custom-message", "customMessage"],
      ["no-eval", "unexpected"],
      ["no-unsanitized/property", null],
      ["obsidianmd/no-static-styles-assignment", "avoidStyleAssignment"],
    ];
    for (const [rule, messageId] of expectedSourceFindings) {
      const detected = sourceResult.messages.some(
        (message) => message.ruleId === rule
          && message.severity === 2
          && (messageId === null || message.messageId === messageId),
      );
      if (!detected) failures.push(`Hard-rule behavior sentinel did not detect ${rule}.`);
    }

    const [suppressionResult] = await eslintInstance.lintText(
      `
/* eslint-disable no-eval -- review gate suppression sentinel */
eval("1");
/* eslint-enable no-eval -- review gate suppression sentinel */
`,
      { filePath: "src/main.ts" },
    );
    if (!suppressionResult.suppressedMessages.some(
      (message) => message.ruleId === "no-eval" && message.severity === 2,
    )) {
      failures.push("Hard-rule suppression sentinel did not preserve the suppressed no-eval finding.");
    }
    if (!suppressionResult.messages.some(
      (message) => message.ruleId === "eslint-comments/no-restricted-disable" && message.severity === 2,
    )) {
      failures.push("Hard-rule suppression sentinel did not reject disabling no-eval.");
    }

    const [packageResult] = await eslintInstance.lintText(
      "{\"name\":\"review-gate-sentinel\",\"dependencies\":{\"is-number\":\"1.0.0\"}}",
      { filePath: "package.json" },
    );
    if (!packageResult.messages.some(
      (message) => message.ruleId === "depend/ban-dependencies"
        && message.severity === 2
        && message.messageId === "simpleReplacement",
    )) {
      failures.push("Package hard-rule behavior sentinel did not reject a banned micro-utility dependency.");
    }
  } catch (error) {
    failures.push(
      `Hard-rule behavior sentinels could not run: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  return failures;
}

function readAndValidateBaseline() {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    console.error(`Invalid Obsidian review baseline JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const failures = validateBaseline(value);
  if (failures.length > 0) {
    console.error("Invalid Obsidian review baseline:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  return value;
}

function validateBaseline(value) {
  const failures = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Baseline must be a JSON object."];
  if (value.schemaVersion !== 2) failures.push("schemaVersion must be 2.");
  if (typeof value.source !== "string" || !value.source.trim()) failures.push("source must be a non-empty string.");
  if (!Array.isArray(value.findings)) return [...failures, "findings must be an array."];

  const seen = new Set();
  const expectedRuleCounts = {};
  let total = 0;
  let errors = 0;
  let warnings = 0;
  for (const [index, finding] of value.findings.entries()) {
    const label = `findings[${index}]`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      failures.push(`${label} must be an object.`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(finding.fingerprint ?? "")) failures.push(`${label}.fingerprint must be a SHA-256 hex string.`);
    if (seen.has(finding.fingerprint)) failures.push(`${label}.fingerprint is duplicated.`);
    seen.add(finding.fingerprint);
    if (!Number.isSafeInteger(finding.count) || finding.count <= 0) failures.push(`${label}.count must be a positive safe integer.`);
    if (finding.severity !== "error" && finding.severity !== "warning") failures.push(`${label}.severity must be error or warning.`);
    for (const key of ["path", "rule", "messageId", "message", "evidence"]) {
      if (typeof finding[key] !== "string") failures.push(`${label}.${key} must be a string.`);
    }
    if (
      typeof finding.path === "string"
      && typeof finding.rule === "string"
      && typeof finding.severity === "string"
      && typeof finding.messageId === "string"
      && typeof finding.message === "string"
      && typeof finding.evidence === "string"
      && finding.fingerprint !== fingerprintFinding(finding)
    ) {
      failures.push(`${label}.fingerprint does not match its finding fields.`);
    }
    if (Number.isSafeInteger(finding.count) && finding.count > 0) {
      total += finding.count;
      if (finding.severity === "error") errors += finding.count;
      if (finding.severity === "warning") warnings += finding.count;
      if (typeof finding.path === "string" && typeof finding.rule === "string") {
        const ruleKey = `${finding.path}::${finding.rule}::${finding.severity}`;
        expectedRuleCounts[ruleKey] = (expectedRuleCounts[ruleKey] ?? 0) + finding.count;
      }
    }
  }
  if (!Number.isSafeInteger(value.total) || value.total !== total) failures.push(`total must equal ${total}.`);
  if (!Number.isSafeInteger(value.errors) || value.errors !== errors) failures.push(`errors must equal ${errors}.`);
  if (!Number.isSafeInteger(value.warnings) || value.warnings !== warnings) failures.push(`warnings must equal ${warnings}.`);
  const normalizedExpectedRuleCounts = Object.fromEntries(
    Object.entries(expectedRuleCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  if (
    !value.ruleCounts
    || typeof value.ruleCounts !== "object"
    || Array.isArray(value.ruleCounts)
    || JSON.stringify(value.ruleCounts) !== JSON.stringify(normalizedExpectedRuleCounts)
  ) {
    failures.push("ruleCounts must exactly match the aggregated findings.");
  }
  return failures;
}

function findRegressions(currentFindings, approvedBaseline) {
  const counts = new Map(
    aggregateFindings(approvedBaseline.findings)
      .map((finding) => [findingComparisonKey(finding), finding.count]),
  );
  return currentFindings
    .map((finding) => ({ finding, allowed: counts.get(findingComparisonKey(finding)) ?? 0 }))
    .filter(({ finding, allowed }) => finding.count > allowed);
}

function findImprovements(currentFindings, approvedBaseline) {
  const currentCounts = new Map(
    currentFindings.map((finding) => [findingComparisonKey(finding), finding.count]),
  );
  return aggregateFindings(approvedBaseline.findings)
    .map((finding) => ({
      finding,
      current: currentCounts.get(findingComparisonKey(finding)) ?? 0,
    }))
    .filter(({ finding, current }) => current < finding.count);
}

function aggregateFindings(items) {
  const groups = new Map();
  for (const finding of items) {
    const key = findingComparisonKey(finding);
    const existing = groups.get(key);
    if (existing) {
      existing.count += finding.count;
      continue;
    }
    groups.set(key, { ...finding });
  }
  return [...groups.values()];
}

function printRegressions(regressions) {
  for (const regression of regressions) {
    const { finding } = regression;
    console.error(
      `- ${finding.path} ${finding.rule} ${finding.severity}: `
      + `${finding.count} matching finding(s) (baseline ${regression.allowed})`,
    );
    console.error(`  ${finding.message}`);
    if (finding.evidence) console.error(`  Evidence: ${finding.evidence}`);
  }
}

function printConfigFailures(failures) {
  console.error("\nObsidian review lint configuration is not enforceable:");
  for (const failure of failures) console.error(`- ${failure}`);
}
