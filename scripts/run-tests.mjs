import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, rmdirSync, existsSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDisposableTestRoot } from "./disposable-test-root.mjs";
import { local, integration, indirect, orchestrators, modes } from "./test-suites.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const started = performance.now();
const results = [];
let fixtureRoot;
let createdLegacyParent = false;
let testArtifactsBefore;
const legacyParent = path.join(homedir(), "EchoInk-TestVaults", "90-任务临时");
const workspaceTemporary = path.join(root, ".tmp");

function inventory() {
  const errors = [], found = [];
  function scan(directory) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) scan(file);
      else if (entry.name.endsWith("-tests.mjs")) found.push(file);
    }
  }
  scan("scripts"); scan("src/tests");
  const assigned = new Map();
  for (const [group, files] of [["local", local], ["integration", integration], ["indirect", indirect.map(entry => entry.file)], ["orchestrator", orchestrators]]) {
    for (const file of files) {
      if (!found.includes(file) || !existsSync(path.join(root, file)) || !statSync(path.join(root, file)).isFile()) errors.push(`Missing entry: ${file} (${group})`);
      if (assigned.has(file)) errors.push(`Duplicate classification: ${file} (${assigned.get(file)}, ${group})`);
      assigned.set(file, group);
    }
  }
  for (const file of found) if (!assigned.has(file)) errors.push(`Unclassified entry: ${file}`);
  for (const entry of indirect) if (!local.includes(entry.via)) errors.push(`Indirect entry has no local owner: ${entry.file} -> ${entry.via}`);
  const commands = new Set();
  for (const mode of modes) {
    const key = JSON.stringify([mode.file, mode.args]);
    if (!found.includes(mode.file)) errors.push(`Missing mode entry: ${mode.file}`);
    if (!local.includes(mode.file) && !integration.includes(mode.file)) errors.push(`Mode has no executable owner: ${mode.file}`);
    if (!["local", "integration"].includes(mode.group) || !mode.args.length) errors.push(`Invalid mode: ${mode.file}`);
    if (commands.has(key)) errors.push(`Duplicate mode: ${mode.file} ${mode.args.join(" ")}`);
    commands.add(key);
  }
  if (errors.length) throw new Error(`Test entry inventory failed:\n${errors.join("\n")}`);
  console.log(`Test inventory: PASS (${found.length} files; ${local.length} local direct, ${integration.length} integration, ${indirect.length} indirect/forwarded, ${orchestrators.length} orchestrator).`);
}

function integrationPreflight() {
  const errors = [];
  const backend = process.env.ECHOINK_EXPERT_BACKEND_ROOT;
  for (const relative of ["package.json", "src/experts-content.ts", "test/helpers.ts", "node_modules/tsx/dist/loader.mjs"]) {
    if (!backend || !existsSync(path.join(backend, relative))) errors.push(`scripts/expert-integration-tests.mjs requires ECHOINK_EXPERT_BACKEND_ROOT with ${relative}`);
  }
  for (const [file, refs] of [
    ["scripts/agents-storage-tests.mjs", ["a1bdd5cb:src/harness/pi-native/file-conversation-catalog.ts"]],
    ["scripts/r-da4ae1-tests.mjs", ["2.8.8:src/plugin/pi-knowledge-maintenance-production.ts", "4641cc6e:src/plugin/pi-knowledge-maintenance-production.ts"]]
  ]) for (const ref of refs) {
    const result = spawnSync("git", ["cat-file", "-e", ref], { cwd: root, stdio: "ignore" });
    if (result.status !== 0) errors.push(`${file} requires local Git history ${ref}`);
  }
  if (errors.length) throw new Error(`Integration prerequisites failed:\n${errors.join("\n")}`);
}

function prepareFixtures() {
  createdLegacyParent = !existsSync(legacyParent);
  mkdirSync(legacyParent, { recursive: true });
  // Synthetic fixtures only: no user Vault or saved Provider configuration is read.
  fixtureRoot = path.join(realpathSync(path.dirname(legacyParent)), `测试仓库-npm-test-${randomUUID()}验收`);
  if (!isDisposableTestRoot(fixtureRoot)) throw new Error("Runner fixture root is not disposable");
  mkdirSync(fixtureRoot);
  fixtureRoot = realpathSync(fixtureRoot);
  console.log(`Test fixtures: ${fixtureRoot}`);
}

function environment() {
  // Do not inherit focused-case switches, private replay files or saved paths.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ECHOINK_")));
  const directory = realpathSync(mkdtempSync(path.join(fixtureRoot, "suite-")));
  if (!isDisposableTestRoot(directory)) throw new Error("Suite fixture root is not disposable");
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const variables = [
    "MEMORY", "SETTINGS", "KNOWLEDGE", "ACCOUNT_PRICING", "ACCOUNT", "ONBOARDING",
    "AGENT_CAPABILITIES", "AGENT_EDITOR", "AGENTS", "AGENT_SETTINGS", "TASK", "DELETE_BUTTON",
    "ONBOARDING_AGENT_EDITOR", "ONBOARDING_AGENT_TRANSACTION", "ENGLISH_DIARY_NAVIGATION", "JOURNAL",
    "GENERATION", "FINANCE_UI", "TASK_RESUME", "TODO", "TODO_UI", "MODULES", "MOBILE_MEMORY",
    "MOBILE_NOTE_UPDATE", "USAGE", "PROFILE_UI", "WORKBENCH", "PDF_TASK", "PAPER_GUIDE", "ANSWER_SAVE"
  ];
  for (const name of variables) env[`ECHOINK_${name}_TEST_ROOT`] = directory;
  env.ECHOINK_TEST_ROOT = directory;
  env.ECHOINK_PRODUCT_RUN_SNAPSHOT_ROOT = directory;
  env.ECHOINK_USER_PROFILE_TEST_ROOT = path.join(directory, "runtime");
  env.ECHOINK_PDF_TEST_ROOT = path.join(directory, ".tests", "pdf-reading-index");
  mkdirSync(env.ECHOINK_USER_PROFILE_TEST_ROOT);
  mkdirSync(env.ECHOINK_PDF_TEST_ROOT, { recursive: true });
  env.TMPDIR = env.TMP = env.TEMP = directory;
  env.PI_OFFLINE = "1";
  env.NODE_ENV = "test";
  if (process.env.ECHOINK_EXPERT_BACKEND_ROOT) env.ECHOINK_EXPERT_BACKEND_ROOT = path.resolve(process.env.ECHOINK_EXPERT_BACKEND_ROOT);
  return env;
}

function run(command, args, file, modeArgs = []) {
  console.log(`\n[TEST START] ${file}${modeArgs.length ? ` ${modeArgs.join(" ")}` : ""}`);
  const start = performance.now();
  const result = spawnSync(command, args, { cwd: root, env: environment(), stdio: "inherit" });
  const record = { file, args: modeArgs, seconds: Number(((performance.now() - start) / 1000).toFixed(3)), status: result.status ?? 1 };
  results.push(record);
  console.log(`TEST_RESULT ${JSON.stringify(record)}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed (exit ${result.status ?? result.signal ?? "unknown"})`);
}

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--integration", "--check"].includes(arg))) throw new Error("Usage: node scripts/run-tests.mjs [--integration] [--check]");
  inventory();
  const isIntegration = args.includes("--integration");
  if (isIntegration) integrationPreflight();
  if (!args.includes("--check")) {
    prepareFixtures();
    const entries = isIntegration ? integration : local;
    const extra = modes.filter(mode => mode.group === "local" && !isIntegration);
    console.log(`Test plan: ${entries.length} direct entries + ${extra.length} additional modes; serial; ${isIntegration ? "external prerequisites checked" : "one fresh production build"}.`);
    if (!isIntegration) run(npm, ["run", "build"], "npm run build");
    // A few legacy entries compile into .tmp instead of the supplied fixture.
    // Keep the production build graphs and anything that predates this run.
    testArtifactsBefore = new Set(existsSync(workspaceTemporary) ? readdirSync(workspaceTemporary) : []);
    for (const file of entries) run(process.execPath, [file], file);
    for (const mode of extra) run(process.execPath, [mode.file, ...mode.args], mode.file, mode.args);
    if (isIntegration) console.log("Registered opt-in modes (not run by test:integration):\n" + modes.filter(mode => mode.group === "integration").map(mode => `- node ${mode.file} ${mode.args.join(" ")}: ${mode.reason}`).join("\n"));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (testArtifactsBefore && existsSync(workspaceTemporary)) {
    for (const name of readdirSync(workspaceTemporary)) if (!testArtifactsBefore.has(name)) {
      try { rmSync(path.join(workspaceTemporary, name), { recursive: true, force: true }); }
      catch (error) { console.error(`Test artifact cleanup failed: ${name}: ${error.message}`); process.exitCode = 1; }
    }
  }
  if (fixtureRoot) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
      console.log(`Test fixtures cleaned: ${fixtureRoot}`);
    } catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
  if (createdLegacyParent) {
    try { rmdirSync(legacyParent); }
    catch (error) { if (error.code !== "ENOTEMPTY") { console.error(`Fixture parent cleanup failed: ${error.message}`); process.exitCode = 1; } }
  }
  if (results.length) {
    const summary = { status: process.exitCode || 0, invocations: results.filter(result => result.file !== "npm run build").length, buildCount: results.filter(result => result.file === "npm run build").length, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), slowest: [...results].filter(result => result.file !== "npm run build").sort((a, b) => b.seconds - a.seconds).slice(0, 5) };
    console.log(`TEST_SUMMARY ${JSON.stringify(summary)}`);
  }
}
