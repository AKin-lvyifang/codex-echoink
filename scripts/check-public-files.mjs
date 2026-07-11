#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

const rules = [
  {
    reason: "private Codex collaboration state",
    matches: (file) => file === "AGENTS.md" || file.startsWith(".codex-memory/") || file.startsWith(".omx/")
  },
  {
    reason: "internal Superpowers execution documents",
    matches: (file) => file.startsWith("docs/superpowers/")
  },
  {
    reason: "internal documentation directory",
    matches: (file) => /^docs\/(?:.+\/)?(?:plans|specs|design|architecture)\//i.test(file)
  },
  {
    reason: "internal documentation filename",
    matches: (file) =>
      file.startsWith("docs/") &&
      /(?:^|\/)(?:PRD|test-cases)[^/]*\.md$/i.test(file)
  },
  {
    reason: "internal planning or draft document",
    matches: (file) =>
      file.startsWith("docs/") &&
      /(?:^|\/)[^/]*(?:plan|spec|idea|草稿|手稿|思路|方案|计划|内部)[^/]*\.md$/i.test(file)
  }
];

const files = trackedFiles();
const blocked = [];

for (const file of files) {
  const rule = rules.find((candidate) => candidate.matches(file));
  if (rule) blocked.push({ file, reason: rule.reason });
}

if (blocked.length > 0) {
  console.error("Public repository guard failed. Remove these internal files before committing or pushing:");
  for (const item of blocked) {
    console.error(`- ${item.file} (${item.reason})`);
  }
  process.exit(1);
}

console.log(`Public repository guard passed: ${files.length} tracked files checked.`);
