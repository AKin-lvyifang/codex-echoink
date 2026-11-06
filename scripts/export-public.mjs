#!/usr/bin/env node
// 发版用：从私有 main 生成一份去掉内部资料的公开快照提交，只在本地生成，不推送。
// 用法：node scripts/export-public.mjs [--source main] [--base public/main] [--message "EchoInk 2.8.10"]
// 输出快照提交号；发版时由方哥授权后再推：git push public <提交号>:refs/heads/main，Tag 也打在这个提交上。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { internalReason } from "./public-boundary.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const source = arg("--source", "main");
const base = arg("--base", "public/main");
const git = (args, options = {}) => execFileSync("git", args, { encoding: "utf8", ...options }).trim();

execFileSync("git", ["fetch", "-q", "public", "main"], { stdio: "inherit" });
const sourceSha = git(["rev-parse", "--verify", `${source}^{commit}`]);
const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]);
const version = JSON.parse(git(["show", `${sourceSha}:manifest.json`])).version;
const message = arg("--message", `EchoInk ${version}`);

const indexDir = mkdtempSync(path.join(tmpdir(), "echoink-public-"));
const env = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, "index") };
try {
  execFileSync("git", ["read-tree", sourceSha], { env });
  const files = git(["ls-files", "-z"], { env }).split("\0").filter(Boolean);
  const internal = files.filter((file) => internalReason(file));
  if (internal.length) {
    execFileSync("git", ["update-index", "--force-remove", "-z", "--stdin"], { env, input: `${internal.join("\0")}\0` });
  }
  const tree = git(["write-tree"], { env });
  execFileSync("node", ["scripts/check-public-files.mjs", "--tree", tree], { stdio: "inherit" });
  const commit = git(["commit-tree", tree, "-p", baseSha, "-m", message]);
  console.log(`Public snapshot ready: ${commit}`);
  console.log(`  from ${source} ${sourceSha.slice(0, 8)} (version ${version}), parent ${base} ${baseSha.slice(0, 8)}, removed ${internal.length} internal file(s)`);
  console.log("  Nothing was pushed. After 方哥 authorizes the release:");
  console.log(`  git push public ${commit}:refs/heads/main`);
  console.log(`  git tag ${version} ${commit} && git push public ${version} && git push origin ${version}`);
} finally {
  rmSync(indexDir, { recursive: true, force: true });
}
