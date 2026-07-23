#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => existsSync(file));
}

const rules = [
  {
    reason: "private Codex collaboration state",
    matches: (file) =>
      file === "AGENTS.md"
      || file.endsWith("/AGENTS.md")
      || file.startsWith(".codex-memory/")
      || file.startsWith(".omx/")
  },
  {
    reason: "private release context or design QA",
    matches: (file) => /(?:^|\/)(?:CONTEXT|design-qa)\.md$/i.test(file)
  },
  {
    reason: "internal implementation documentation",
    matches: (file) => file.startsWith("docs/implementation/")
  },
  {
    reason: "internal prototype source or artifact",
    matches: (file) => /(?:^|\/)prototypes?\//i.test(file)
  },
  {
    reason: "internal Superpowers execution documents",
    matches: (file) => file.startsWith("docs/superpowers/")
  },
  {
    reason: "private internal documentation",
    matches: (file) => file.startsWith("docs/internal/")
  },
  {
    reason: "internal documentation directory",
    matches: (file) => /^docs\/(?:.+\/)?(?:plans|specs|design|architecture)\//i.test(file)
  },
  {
    reason: "internal documentation filename",
    matches: (file) =>
      file.startsWith("docs/") &&
      /(?:^|\/)(?:PRD|test-cases|[^/]*-prd)[^/]*\.md$/i.test(file)
  },
  {
    reason: "internal planning or draft document",
    matches: (file) =>
      file.startsWith("docs/") &&
      /(?:^|\/)[^/]*(?:plan|spec|idea|草稿|手稿|思路|方案|计划|内部)[^/]*\.md$/i.test(file)
  }
];

const hardCodedSecretPattern =
  /\b(?:OPENAI|ANTHROPIC|DEEPSEEK|GITHUB|GH|HERMES|OPENCODE)[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)\b\s*[:=]\s*['"](?!\$\{\{)[^'"\n]{8,}['"]/i;

if (!hardCodedSecretPattern.test("GH_" + "TOKEN = '" + "abcdefgh'")) {
  throw new Error("Public repository guard must reject literal secret assignments.");
}
if (hardCodedSecretPattern.test('GH_TOKEN: "${{ github.token }}"')) {
  throw new Error("Public repository guard must allow GitHub Actions secret expressions.");
}

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
  {
    reason: "raw Authorization bearer token",
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i
  },
  {
    reason: "hard-coded secret or API key assignment",
    pattern: hardCodedSecretPattern
  }
];

function readTextFile(file) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

const files = trackedFiles();
const blocked = [];

for (const file of files) {
  const rule = rules.find((candidate) => candidate.matches(file));
  if (rule) blocked.push({ file, reason: rule.reason });

  const text = readTextFile(file);
  if (!text) continue;
  const contentRule = contentRules.find((candidate) => candidate.pattern.test(text));
  if (contentRule) blocked.push({ file, reason: contentRule.reason });
}

if (blocked.length > 0) {
  console.error("Public repository guard failed. Remove these internal files before committing or pushing:");
  for (const item of blocked) {
    console.error(`- ${item.file} (${item.reason})`);
  }
  process.exit(1);
}

console.log(`Public repository guard passed: ${files.length} tracked files checked.`);
