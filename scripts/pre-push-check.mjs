import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isDisposableTestRoot } from "./disposable-test-root.mjs";

const updates = await readUpdates();
const changed = changedFiles(updates);

run("npm", ["run", "typecheck"]);
run("npm", ["run", "build"]);
const commands = affectedTests(changed);
if (commands.length) {
  const parent = path.join(homedir(), "EchoInk-TestVaults", "90-任务临时");
  mkdirSync(parent, { recursive: true });
  const fixture = realpathSync(mkdtempSync(path.join(parent, "pre-push-")));
  try {
    if (!isDisposableTestRoot(fixture)) throw new Error("Pre-push fixtures must stay in disposable test directories");
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ECHOINK_")));
    for (const name of ["ECHOINK_TEST_ROOT", "ECHOINK_MEMORY_TEST_ROOT", "ECHOINK_SETTINGS_TEST_ROOT", "ECHOINK_KNOWLEDGE_TEST_ROOT", "TMPDIR", "TMP", "TEMP"]) env[name] = fixture;
    env.PI_OFFLINE = "1";
    symlinkSync(path.resolve("node_modules"), path.join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    console.log(`Pre-push affected suites: ${commands.join(", ")}; fixtures: ${fixture}`);
    for (const command of commands) run("npm", ["run", command], env);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    console.log(`Pre-push fixtures cleaned: ${fixture}`);
  }
}

async function readUpdates() {
  const input = await readStdin();
  return input.split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((update) => update.localSha && !/^0+$/u.test(update.localSha));
}

function changedFiles(updates) {
  const files = new Set();
  for (const update of updates) {
    const range = /^0+$/u.test(update.remoteSha)
      ? ["diff-tree", "--no-commit-id", "--name-only", "-r", update.localSha]
      : ["diff", "--name-only", `${update.remoteSha}...${update.localSha}`];
    const output = execFileSync("git", range, { encoding: "utf8" });
    for (const file of output.split(/\r?\n/u).filter(Boolean)) files.add(file);
  }
  return files;
}

function affectedTests(files) {
  const paths = [...files];
  const commands = [];
  if (paths.some((file) => /^(src\/(settings|plugin)\/|src\/harness\/pi\/|src\/harness\/pi-native\/|src\/resources\/)/u.test(file))) {
    commands.push("test:provider-settings", "test:conversation-ui");
  }
  if (paths.some((file) => /^src\/harness\/memory\//u.test(file))) {
    commands.push("test:personal-memory");
  }
  if (paths.some((file) => /^src\/knowledge-base\//u.test(file) || /pi-knowledge/u.test(file))) {
    commands.push("test:knowledge");
  }
  if (paths.some((file) => /^src\/resources\/mcp/u.test(file) || /pi-mcp/u.test(file))) {
    commands.push("test:mcp-vault");
  }
  return [...new Set(commands)];
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pre-push ${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal ?? "unknown"})`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}
