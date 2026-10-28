import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// Audited resolved settings, including default options. Do not derive these
// from the live ESLint config: that would also approve a weakened config.
export const SOURCE_HARD_RULES = {
  "no-eval": [2, { allowIndirect: false }],
  "no-implied-eval": [2],
  "@typescript-eslint/no-implied-eval": [2],
  "@typescript-eslint/no-floating-promises": [2],
  "no-unsanitized/method": [2],
  "no-unsanitized/property": [2],
  "obsidianmd/rule-custom-message": [2, {
    "no-console": {
      messages: {
        "Unexpected console statement. Only these console methods are allowed: warn, error, debug.":
          "Avoid unnecessary logging to console. See https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines#Avoid+unnecessary+logging+to+console"
      },
      options: [{ allow: ["warn", "error", "debug"] }]
    },
    "no-new-func": {
      messages: {
        "The Function constructor is eval": "Using the `Function` constructor is dangerous because it executes arbitrary code, similar to `eval()`"
      }
    }
  }],
  "obsidianmd/settings-tab/no-manual-html-headings": [2],
  "obsidianmd/settings-tab/no-problematic-settings-headings": [2],
  "obsidianmd/detach-leaves": [2],
  "obsidianmd/no-forbidden-elements": [2],
  "obsidianmd/no-sample-code": [2],
  "obsidianmd/no-static-styles-assignment": [2],
  "obsidianmd/platform": [2],
  "obsidianmd/regex-lookbehind": [2],
  "obsidianmd/sample-names": [2],
  "obsidianmd/no-plugin-as-component": [2],
  "obsidianmd/no-view-references-in-plugin": [2],
  "obsidianmd/no-unsupported-api": [2],
  "import/no-extraneous-dependencies": [2],
  "obsidianmd/commands/no-plugin-name-in-command-name": [2],
  "obsidianmd/prefer-file-manager-trash-file": [2],
  "eslint-comments/no-unlimited-disable": [2],
  "eslint-comments/require-description": [2],
  "eslint-comments/disable-enable-pair": [2, { allowWholeFile: false }],
  "eslint-comments/no-restricted-disable": [2,
    "obsidianmd/*", "import/no-extraneous-dependencies", "no-eval", "no-implied-eval", "@typescript-eslint/no-implied-eval",
    "@typescript-eslint/no-floating-promises", "no-unsanitized/method", "no-unsanitized/property"]
};
// Audited source warning settings. Weakening a rule must not masquerade as resolved debt.
export const SOURCE_WARNING_RULES = {
  "@microsoft/sdl/no-document-write": [
    1
  ],
  "@microsoft/sdl/no-inner-html": [
    1
  ],
  "@typescript-eslint/no-deprecated": [
    1
  ],
  "@typescript-eslint/no-explicit-any": [
    1,
    {
      "fixToUnknown": true
    }
  ],
  "@typescript-eslint/no-restricted-imports": [
    1,
    {
      "name": "axios",
      "message": "Use the built-in `requestUrl` function instead of `axios`."
    },
    {
      "name": "superagent",
      "message": "Use the built-in `requestUrl` function instead of `superagent`."
    },
    {
      "name": "got",
      "message": "Use the built-in `requestUrl` function instead of `got`."
    },
    {
      "name": "ofetch",
      "message": "Use the built-in `requestUrl` function instead of `ofetch`."
    },
    {
      "name": "ky",
      "message": "Use the built-in `requestUrl` function instead of `ky`."
    },
    {
      "name": "node-fetch",
      "message": "Use the built-in `requestUrl` function instead of `node-fetch`."
    },
    {
      "name": "moment",
      "message": "The 'moment' package is bundled with Obsidian. Import the `moment` value from 'obsidian' instead. For the `Moment` type, rely on the global `moment` namespace or add `type Moment = moment.Moment;` (type-only imports from 'moment' are allowed).",
      "allowTypeImports": true
    }
  ],
  "@typescript-eslint/no-unused-expressions": [
    1,
    {
      "allowShortCircuit": true,
      "allowTaggedTemplates": false,
      "allowTernary": true
    }
  ],
  "@typescript-eslint/no-unused-vars": [
    1,
    {
      "args": "none",
      "ignoreRestSiblings": true
    }
  ],
  "no-alert": [
    1
  ],
  "no-implicit-globals": [
    1,
    {
      "lexicalBindings": false
    }
  ],
  "no-restricted-globals": [
    1,
    {
      "name": "app",
      "message": "Avoid using the global app object. Instead use the reference provided by your plugin instance."
    },
    "warn",
    {
      "name": "fetch",
      "message": "Use the built-in `requestUrl` function instead of `fetch` for network requests in Obsidian."
    },
    {
      "name": "localStorage",
      "message": "Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that's unique to a vault."
    }
  ],
  "no-self-compare": [
    1
  ],
  "no-undef": [
    1,
    {
      "typeof": false
    }
  ],
  "obsidianmd/commands/no-command-in-command-id": [
    1
  ],
  "obsidianmd/commands/no-command-in-command-name": [
    1
  ],
  "obsidianmd/commands/no-default-hotkeys": [
    1
  ],
  "obsidianmd/commands/no-plugin-id-in-command-id": [
    1
  ],
  "obsidianmd/editor-drop-paste": [
    1
  ],
  "obsidianmd/hardcoded-config-path": [
    1
  ],
  "obsidianmd/no-global-this": [
    1
  ],
  "obsidianmd/no-nodejs-modules": [
    1
  ],
  "obsidianmd/no-tfile-tfolder-cast": [
    1
  ],
  "obsidianmd/object-assign": [
    1
  ],
  "obsidianmd/prefer-abstract-input-suggest": [
    1
  ],
  "obsidianmd/prefer-create-el": [
    1
  ],
  "obsidianmd/prefer-get-language": [
    1
  ],
  "obsidianmd/prefer-instanceof": [
    1
  ],
  "obsidianmd/prefer-window-timers": [
    1
  ],
  "obsidianmd/settings-tab/no-deprecated-display": [
    1
  ],
  "obsidianmd/settings-tab/prefer-setting-definitions": [
    1
  ],
  "obsidianmd/settings-tab/prefer-update-over-display": [
    1
  ],
  "obsidianmd/settings-tab/require-display": [
    1
  ],
  "obsidianmd/ui/sentence-case": [
    1,
    {
      "enforceCamelCaseLower": true
    }
  ],
  "obsidianmd/validate-license": [
    1
  ],
  "obsidianmd/validate-manifest": [
    1
  ],
  "obsidianmd/vault/iterate": [
    1
  ]
};
const JSON_RULES = {
  "json/no-duplicate-keys": [2], "json/no-empty-keys": [2],
  "json/no-unnormalized-keys": [2, { form: "NFC" }], "json/no-unsafe-values": [2]
};
export const PACKAGE_HARD_RULES = {
  "depend/ban-dependencies": [2, { presets: ["native", "microutilities", "preferred"] }]
};
const COMMENT_HARD_RULES = new Set(Object.keys(SOURCE_HARD_RULES).filter(rule => rule.startsWith("eslint-comments/")));
const BASELINE_SOURCE = "eslint-plugin-obsidianmd production errors";
const WARNING_BASELINE_SOURCE = "eslint-plugin-obsidianmd production warnings";
const SOURCE_EXTENSIONS = /\.(?:ts|cts|mts|tsx|js|cjs|mjs|jsx)$/u;
// These are tests and upstream reference material, not plugin runtime code.
const NON_PRODUCTION_DIRECTORIES = new Set(["src/tests", "src/home/magic-ui/provenance"]);

export function productionLintFiles(rootDir) {
  const files = [];
  function visit(relative) {
    if (NON_PRODUCTION_DIRECTORIES.has(relative)) return;
    for (const entry of fs.readdirSync(path.join(rootDir, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Production source must be directly auditable: ${name}`);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) files.push(name);
    }
  }
  visit("src");
  if (!files.length) throw new Error("No production source files found.");
  return [...files.sort(), "manifest.json", "package.json", "versions.json"];
}

function expectedRules(file) {
  if (file === "package.json") return PACKAGE_HARD_RULES;
  if (file === "manifest.json") return { ...JSON_RULES, "obsidianmd/validate-manifest": [2] };
  if (file === "versions.json") return JSON_RULES;
  return { ...SOURCE_HARD_RULES, ...SOURCE_WARNING_RULES };
}

function hardRule(rule) {
  return rule.startsWith("obsidianmd/") || COMMENT_HARD_RULES.has(rule)
    || Object.hasOwn(SOURCE_HARD_RULES, rule) || rule === "depend/ban-dependencies";
}

export function validateResolvedRules(file, config) {
  const errors = [];
  const expected = expectedRules(file);
  if (!config?.rules) return [`${file}: no resolved ESLint rules.`];
  for (const [rule, setting] of Object.entries(expected)) {
    if (!isDeepStrictEqual(config.rules[rule], setting)) errors.push(`${file}: ${rule} must resolve to ${JSON.stringify(setting)}; got ${JSON.stringify(config.rules[rule])}.`);
  }
  for (const [rule, setting] of Object.entries(config.rules)) {
    if (setting[0] === 2 && hardRule(rule) && !Object.hasOwn(expected, rule)) errors.push(`${file}: unaudited hard rule ${rule}; review its full settings and behavior.`);
  }
  return errors;
}

export async function auditResolvedContracts(eslint, rootDir, files) {
  const errors = [];
  for (const file of files) {
    const absolute = path.join(rootDir, file);
    if (await eslint.isPathIgnored(absolute)) errors.push(`${file}: production/release input is ignored by ESLint.`);
    errors.push(...validateResolvedRules(file, await eslint.calculateConfigForFile(absolute)));
  }
  return errors;
}

export function auditLintCoverage(rootDir, files, results) {
  const counts = new Map();
  for (const result of results) {
    const file = path.relative(rootDir, result.filePath).split(path.sep).join("/");
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return files.filter(file => counts.get(file) !== 1).map(file => `${file}: expected exactly one lint result, got ${counts.get(file) ?? 0}.`);
}

export function isHardFinding(finding) {
  return finding.fatal === true || !finding.rule || finding.rule === "<parse>"
    || (finding.severity === 2 && (hardRule(finding.rule) || finding.path === "manifest.json"));
}

export function collectFindings(rootDir, results, { includeWarnings = false } = {}) {
  const findings = [];
  for (const result of results) {
    const file = path.relative(rootDir, result.filePath).split(path.sep).join("/");
    const lines = (result.source ?? fs.readFileSync(result.filePath, "utf8")).split(/\r?\n/u);
    for (const [messages, suppressed] of [[result.messages, false], [result.suppressedMessages ?? [], true]]) {
      for (const message of messages) {
        if (message.severity !== 2 && !(includeWarnings && message.severity === 1) && !message.fatal) continue;
        const finding = {
          path: file, rule: message.ruleId ?? "<parse>", severity: message.severity,
          message: message.message,
          // Whole reported source lines keep the offending expression and its
          // local statement while remaining stable when earlier lines move.
          context: lines.slice(Math.max(0, (message.line ?? 1) - 1), message.endLine ?? message.line ?? 1).map(line => line.trim()).join("\n"),
          line: message.line ?? 0, column: message.column ?? 0,
          fatal: message.fatal === true, suppressed
        };
        if (!suppressed || isHardFinding(finding) || (includeWarnings && finding.severity === 1)) findings.push(finding);
      }
    }
  }
  return findings;
}

function identity(finding) {
  return { path: finding.path, rule: finding.rule, severity: finding.severity, message: finding.message, context: finding.context };
}
export function findingFingerprint(finding) {
  return createHash("sha256").update(JSON.stringify(identity(finding))).digest("hex");
}

export function createBaseline(findings) {
  return createSeverityBaseline(findings, 2, BASELINE_SOURCE);
}

export function createWarningBaseline(findings) {
  return createSeverityBaseline(findings, 1, WARNING_BASELINE_SOURCE);
}

function createSeverityBaseline(findings, severity, source) {
  const entries = new Map();
  for (const finding of findings) {
    if (isHardFinding(finding) || finding.severity !== severity || finding.suppressed) throw new Error("Hard, suppressed or wrong-severity findings cannot enter the baseline.");
    const fingerprint = findingFingerprint(finding);
    const entry = entries.get(fingerprint);
    if (entry) entry.count += 1;
    else entries.set(fingerprint, { fingerprint, ...identity(finding), count: 1 });
  }
  return { schemaVersion: 4, source, total: findings.length,
    findings: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule) || a.fingerprint.localeCompare(b.fingerprint)) };
}

function exactKeys(object, keys) {
  return object !== null && typeof object === "object" && !Array.isArray(object)
    && isDeepStrictEqual(Object.keys(object).sort(), [...keys].sort());
}

export function validateBaseline(value) {
  return validateSeverityBaseline(value, 2, BASELINE_SOURCE);
}

export function validateWarningBaseline(value) {
  return validateSeverityBaseline(value, 1, WARNING_BASELINE_SOURCE);
}

function validateSeverityBaseline(value, severity, source) {
  const errors = [];
  if (!exactKeys(value, ["schemaVersion", "source", "total", "findings"]) || value.schemaVersion !== 4
    || value.source !== source || !Array.isArray(value.findings)
    || !Number.isSafeInteger(value.total) || value.total < 0) return ["Baseline must use the strict schemaVersion 4 fingerprint contract."];
  const seen = new Set();
  let total = 0;
  for (const entry of value.findings) {
    if (!exactKeys(entry, ["fingerprint", "path", "rule", "severity", "message", "context", "count"])) { errors.push("Invalid baseline entry fields."); continue; }
    if (![entry.fingerprint, entry.path, entry.rule, entry.message, entry.context].every(text => typeof text === "string" && text.length > 0)
      || entry.severity !== severity || !Number.isSafeInteger(entry.count) || entry.count <= 0) { errors.push("Baseline strings, severity and positive integer counts must be valid."); continue; }
    if (entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some(part => !part || part === "." || part === "..")) errors.push(`Invalid baseline path: ${entry.path}`);
    if (entry.fingerprint !== findingFingerprint(entry)) errors.push(`Invalid baseline fingerprint for ${entry.path}.`);
    if (seen.has(entry.fingerprint)) errors.push(`Duplicate baseline fingerprint: ${entry.fingerprint}`);
    seen.add(entry.fingerprint);
    if (isHardFinding(entry)) errors.push(`Hard error cannot enter baseline: ${entry.path} ${entry.rule}`);
    total += entry.count;
  }
  if (!Number.isSafeInteger(total) || total !== value.total) errors.push("Baseline total does not equal its entry counts.");
  return errors;
}

export function compareBaseline(current, allowed) {
  const previous = new Map(allowed.findings.map(entry => [entry.fingerprint, entry]));
  const next = new Map(current.findings.map(entry => [entry.fingerprint, entry]));
  const regressions = current.findings.filter(entry => entry.count > (previous.get(entry.fingerprint)?.count ?? 0));
  const reductions = allowed.findings.filter(entry => (next.get(entry.fingerprint)?.count ?? 0) < entry.count);
  return { regressions, reductions };
}

/** Actual ESLint behavior, using the same resolved configuration as production. */
export async function runBehaviorSentinels(eslint, rootDir) {
  const sourcePath = path.join(rootDir, "src/main.ts");
  const probes = [
    { name: "typed unsafe code", file: sourcePath,
      source: `import type { Vault, TFile } from "obsidian";
declare const vault: Vault; declare const file: TFile;
declare const markup: string; declare const element: HTMLElement;
void vault.appendBinary(file, new ArrayBuffer(1));
eval(markup); new Function(markup);
element.innerHTML = markup; element.insertAdjacentHTML("beforeend", markup);
element.style.height = "10px";
Promise.resolve(); window.setTimeout("1", 1);
export {};`,
      expected: ["obsidianmd/no-unsupported-api", "no-eval", "no-implied-eval", "@typescript-eslint/no-implied-eval",
        "obsidianmd/rule-custom-message", "no-unsanitized/property", "no-unsanitized/method",
        "obsidianmd/no-static-styles-assignment", "@typescript-eslint/no-floating-promises"] },
    { name: "trash follows host preference", file: sourcePath,
      source: 'import type { App, TFile } from "obsidian"; declare const app: App; declare const file: TFile; void app.vault.trash(file, false); export {};',
      expected: ["obsidianmd/prefer-file-manager-trash-file"] },
    { name: "command excludes plugin name", file: sourcePath,
      source: 'import type { Plugin } from "obsidian"; declare const plugin: Plugin; plugin.addCommand({id: "open-example", name: "打开 EchoInk Agent 侧栏", callback: () => {}}); export {};',
      expected: ["obsidianmd/commands/no-plugin-name-in-command-name"] },
    { name: "direct dependency declaration", file: sourcePath,
      source: 'import { StreamLanguage } from "@codemirror/streamparser"; void StreamLanguage; export {};',
      expected: ["import/no-extraneous-dependencies"] },
    { name: "restricted suppression", file: sourcePath,
      source: '// eslint-disable-next-line no-eval -- Contract sentinel\neval("1");\nexport {};',
      expected: ["eslint-comments/no-restricted-disable"], suppressed: "no-eval" },
    { name: "unlimited suppression", file: sourcePath,
      source: "/* eslint-disable -- Contract sentinel */\nexport {};\n/* eslint-enable */",
      expected: ["eslint-comments/no-unlimited-disable"] },
    { name: "undescribed suppression", file: sourcePath,
      source: "// eslint-disable-next-line no-undef\nmissing;\nexport {};",
      expected: ["eslint-comments/require-description"] },
    { name: "unpaired suppression", file: sourcePath,
      source: "/* eslint-disable no-undef -- Contract sentinel */\nmissing;\nexport {};",
      expected: ["eslint-comments/disable-enable-pair"] },
    { name: "parse error", file: sourcePath, source: "const = ;", expected: [], fatal: true },
    { name: "dependency presets", file: path.join(rootDir, "package.json"),
      source: JSON.stringify({ name: "contract-sentinel", dependencies: { "is-nan": "1.0.0", "is-number": "1.0.0", axios: "1.0.0" } }),
      expected: ["depend/ban-dependencies"], minimumErrors: 3 },
    { name: "manifest JSON error", file: path.join(rootDir, "manifest.json"),
      source: '{"id":"first","id":"second"}', expected: ["json/no-duplicate-keys"] }
  ];
  const errors = [];
  for (const probe of probes) {
    const [result] = await eslint.lintText(probe.source, { filePath: probe.file });
    if (!result) { errors.push(`${probe.name}: no lint result.`); continue; }
    const reported = result.messages.filter(message => message.severity === 2);
    for (const rule of probe.expected) if (!reported.some(message => message.ruleId === rule && !message.fatal)) errors.push(`${probe.name}: ${rule} did not reject the bad sample at error severity.`);
    if (probe.minimumErrors && reported.filter(message => message.ruleId === "depend/ban-dependencies").length < probe.minimumErrors) errors.push(`${probe.name}: all three dependency presets must reject their sample.`);
    if (probe.fatal && !result.messages.some(message => message.fatal && message.severity === 2)) errors.push(`${probe.name}: parsing did not fail.`);
    if (probe.suppressed && !collectFindings(rootDir, [{ ...result, source: probe.source }]).some(finding => finding.suppressed && finding.rule === probe.suppressed && isHardFinding(finding))) errors.push(`${probe.name}: suppressed hard finding was lost.`);
    if (!probe.fatal && result.messages.some(message => message.fatal)) errors.push(`${probe.name}: unexpected parse failure invalidates the rule probe.`);
  }
  return { count: probes.length, errors };
}
