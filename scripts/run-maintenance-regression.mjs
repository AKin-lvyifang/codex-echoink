import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { disposableTestRoot } from "./disposable-test-root.mjs";

if (!process.env.ECHOINK_TEST_ROOT) throw new Error("Set ECHOINK_TEST_ROOT to the explicitly selected disposable task root");
const project = fileURLToPath(new URL("../", import.meta.url));
const taskRoot = disposableTestRoot(process.env.ECHOINK_TEST_ROOT);
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const evidence = argument("--evidence") ? path.resolve(argument("--evidence")) : path.join(taskRoot, "regression-evidence", `run-${Date.now()}`);
const runRoot = path.join(taskRoot, "script-fixtures", `run-${Date.now()}`);
await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(runRoot, { recursive: true });
const scripts = (await fs.readdir(path.join(project, "scripts"))).filter(name => /(?:knowledge|workbench).*tests\.mjs$/u.test(name)).map(name => `scripts/${name}`).sort();
scripts.push("scripts/module-folder-storage-tests.mjs", "scripts/mcp-vault-tests.mjs", "scripts/task-resume-safety-tests.mjs", "scripts/phase3-tests.mjs", ...["selftest.mjs", "performance-selftest.mjs", "v13-rules-selftest.mjs"].map(name => `scripts/knowledge-recall-eval/${name}`));
const results = [];
for (const script of scripts) {
  const id = script.replace(/^scripts\//u, "").replaceAll("/", "-").replace(/\.mjs$/u, "");
  const fixture = path.join(runRoot, id); await fs.mkdir(fixture);
  await fs.symlink(path.join(project, "node_modules"), path.join(fixture, "node_modules"), "dir");
  const roots = Object.fromEntries(["ECHOINK_TEST_ROOT", "ECHOINK_WORKBENCH_TEST_ROOT", "ECHOINK_KNOWLEDGE_TEST_ROOT", "ECHOINK_KNOWLEDGE_PAGE_TEST_ROOT", "ECHOINK_MODULES_TEST_ROOT", "ECHOINK_TASK_RESUME_TEST_ROOT", "ECHOINK_TASK_TEST_ROOT", "ECHOINK_SETTINGS_TEST_OUTPUT", "TMPDIR"].map(name => [name, fixture]));
  const startedAt = new Date().toISOString(), start = Date.now();
  const child = spawnSync(process.execPath, [script], { cwd: project, env: { ...process.env, ...roots, PI_OFFLINE: "1", TZ: "America/Los_Angeles" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const log = path.join(evidence, `${id}.log`); await fs.writeFile(log, (child.stdout ?? "") + (child.stderr ?? ""));
  results.push({ script, command: `node ${script}`, startedAt, elapsedMs: Date.now() - start, fixtureRoot: fixture, roots, exitCode: child.status, signal: child.signal, error: child.error?.message, log, explanation: child.status === 0 ? "Passed" : "See preserved assertion/error in log; requires diagnosis" });
  await fs.writeFile(path.join(evidence, "results.json"), JSON.stringify({ runRoot, inventory: scripts, results }, null, 2) + "\n");
  console.log(`${child.status === 0 ? "PASS" : "FAIL"} ${script} (${Date.now() - start}ms; exit=${child.status})`);
}
console.log(`Inventory: ${results.length} scripts; failed: ${results.filter(result => result.exitCode !== 0).length}; evidence: ${evidence}`);
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
