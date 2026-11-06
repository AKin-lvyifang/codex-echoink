#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { internalReason } from "./public-boundary.mjs";

// 默认/--staged：检查私有仓库的提交。内部资料（docs/、AGENTS.md 等）允许存在，只查密钥；其余文件按公开标准全查。
// --tree <rev>：检查准备推到公开仓库的快照，出现任何内部资料都拒绝。
const stagedOnly = process.argv.includes("--staged");
const treeIndex = process.argv.indexOf("--tree");
const treeRev = treeIndex >= 0 ? process.argv[treeIndex + 1] : null;
if (treeIndex >= 0 && !treeRev) throw new Error("--tree needs a commit or tree id");

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => existsSync(file));
}

function stagedFiles() {
  const output = execFileSync("git", ["ls-files", "--cached", "-z"], {
    encoding: "utf8"
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

const hardCodedSecretPattern =
  /\b(?:OPENAI|ANTHROPIC|DEEPSEEK|GITHUB|GH|HERMES|OPENCODE)[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)\b\s*[:=]\s*['"](?!\$\{\{)[^'"\n]{8,}['"]/i;

if (!hardCodedSecretPattern.test("GH_" + "TOKEN = '" + "abcdefgh'")) {
  throw new Error("Public repository guard must reject literal secret assignments.");
}
if (hardCodedSecretPattern.test('GH_TOKEN: "${{ github.token }}"')) {
  throw new Error("Public repository guard must allow GitHub Actions secret expressions.");
}

const secretRules = [
  {
    reason: "raw Authorization bearer token",
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i
  },
  {
    reason: "hard-coded secret or API key assignment",
    pattern: hardCodedSecretPattern
  }
];

const contentRules = [
  {
    reason: "local absolute user path",
    pattern: /\/Users\/lyuakin\//
  },
  {
    reason: "local macOS temporary path",
    pattern: /\/(?:private\/tmp|var\/folders)\//
  },
  {
    reason: "private vault path or name",
    pattern: new RegExp("AKin-" + "note-management")
  },
  ...secretRules
];

function treeFiles(rev) {
  const output = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", rev], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

function readTextFile(file) {
  const buffer = treeRev
    ? execFileSync("git", ["show", `${treeRev}:${file}`], { maxBuffer: 64 * 1024 * 1024 })
    : stagedOnly
      ? execFileSync("git", ["show", `:${file}`], { maxBuffer: 64 * 1024 * 1024 })
      : readFileSync(file);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

const files = treeRev ? treeFiles(treeRev) : stagedOnly ? stagedFiles() : trackedFiles();
const scope = treeRev ? `public snapshot ${treeRev}` : stagedOnly ? "staged changes" : "tracked files";
const blocked = [];

for (const file of files) {
  const internal = internalReason(file);
  if (internal && treeRev) blocked.push({ file, reason: internal });

  const text = readTextFile(file);
  if (!text) continue;
  const contentRule = (internal ? secretRules : contentRules).find((candidate) => candidate.pattern.test(text));
  if (contentRule) blocked.push({ file, reason: contentRule.reason });
}

if (blocked.length > 0) {
  console.error(`Public repository guard failed for ${scope}.`);
  for (const item of blocked) {
    console.error(`- ${item.file} (${item.reason})`);
  }
  process.exit(1);
}

console.log(`Public repository guard passed: ${files.length} file(s) checked in ${scope}.`);
