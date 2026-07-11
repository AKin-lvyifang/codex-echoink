#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { cwd: projectRoot, stdio: "ignore" });
} catch {
  process.exit(0);
}

execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: projectRoot, stdio: "ignore" });

for (const hook of ["pre-commit", "pre-push"]) {
  const hookPath = path.join(projectRoot, ".githooks", hook);
  if (existsSync(hookPath)) chmodSync(hookPath, 0o755);
}

console.log("Git hooks path set to .githooks.");
