import assert from "node:assert/strict";
import { parse } from "yaml";
import { patchMaintenanceSourceFrontmatter } from "../knowledge-base/maintenance-source-frontmatter";
import { isMaintenanceSourceProcessed, maintenanceSourceState, resolveMaintenanceSourceState, planMaintenanceSourceMigration } from "../knowledge-base/maintenance-source-state";
import type { MaintenanceSourceFields } from "../knowledge-base/maintenance-p1-contract";

const fields: MaintenanceSourceFields = {
  status: "已提炼",
  summary: "新摘要：保留来源。",
  targetPaths: ["Wiki/条目 A.md", "Wiki/条目 B"]
};

export async function runMaintenanceSourceFieldsTests(): Promise<void> {
  assertCurrentStatusOnly();
  assertReadOnlyLegacyTransition();
  assertMigrationPlans();
  assertExactBytePreservation();
  assertCreationAndEmptyValues();
  assertManagedCommentsAndMultilineValues();
  assertUnsafeInputsRejected();
}

function assertCurrentStatusOnly(): void {
  for (const markdown of [
    "---\n提炼状态: 已提炼\n---\n旧正文",
    "---\n提炼状态: 已提炼\n---\n正文已完全改变，不需要重新计算指纹。",
    "\uFEFF---\r\n提炼状态: '已提炼' # state\r\n---\r\n正文\r\n",
    "---\n提炼状态: \"已提炼\"\n...\n提炼状态: 未提炼"
  ]) assert.equal(isMaintenanceSourceProcessed(markdown), true);
  for (const markdown of [
    "提炼状态: 已提炼\n正文",
    "# 笔记\n```yaml\n提炼状态: 已提炼\n```",
    "---\n提炼状态: 未提炼\n已处理: true\n---\n提炼状态: 已提炼",
    "---\nnested:\n  提炼状态: 已提炼\n---\n正文",
    "---\n提炼状态: 已提炼\n提炼状态: 未提炼\n---\n正文",
    "---\n提炼状态: [已提炼\n---\n正文",
    "---\n提炼状态: 已提炼",
    "---\n提炼状态: !!str 已提炼\n---\n正文",
    "---\n提炼状态: &state 已提炼\n---\n正文",
    "---\n提炼状态: |\n  已提炼\n---\n正文"
  ]) assert.equal(isMaintenanceSourceProcessed(markdown), false, markdown);
}

function assertMigrationPlans(): void {
  const oldEvidence = [
    { legacyProcessed: true },
    { legacyProcessed: "已处理" },
    { legacyProcessed: "processed" },
    { privateProcessed: true },
    { registryProcessed: true },
    { legacyProcessed: true, legacyDigest: `sha256:${"a".repeat(64)}` }
  ];
  for (const evidence of oldEvidence) {
    assert.deepEqual(planMaintenanceSourceMigration(evidence), {
      status: "已提炼", targetPaths: [], needsReview: true, shouldWrite: true
    });
    assert.deepEqual(planMaintenanceSourceMigration({ ...evidence, status: "未提炼" }), {
      status: "未提炼", targetPaths: [], needsReview: false, shouldWrite: false
    }, "an explicit reset wins over every legacy source");
  }
  for (const evidence of [
    {}, { legacyProcessed: false }, { legacyProcessed: "true" }, { legacyProcessed: "yes" },
    { legacyProcessed: "Processed" }, { legacyProcessed: 1 }, { legacyProcessed: {} },
    { legacyDigest: `sha256:${"a".repeat(64)}` }, { legacyDigest: "B".repeat(64) },
    { legacyDigest: "sha256:short" }, { legacyDigest: "g".repeat(64) },
    { legacyDigest: `before sha256:${"a".repeat(64)}` }
  ]) assert.deepEqual(planMaintenanceSourceMigration(evidence), {
    status: "未提炼", targetPaths: [], needsReview: false, shouldWrite: true
  });
  assert.deepEqual(planMaintenanceSourceMigration({
    status: "已提炼", legacyProcessed: false, targetPaths: ["Wiki/A.md"],
    reverseSourceTargets: ["Wiki/A.md", "Wiki/B.md"]
  }), { status: "已提炼", targetPaths: ["Wiki/A.md"], needsReview: false, shouldWrite: false }, "existing target properties are preserved, including their omissions");
  assert.deepEqual(planMaintenanceSourceMigration({ status: "已提炼", targetPaths: ["Wiki/A.md"] }), {
    status: "已提炼", targetPaths: ["Wiki/A.md"], needsReview: false, shouldWrite: false
  });
  assert.deepEqual(planMaintenanceSourceMigration({ status: "已提炼" }), {
    status: "已提炼", targetPaths: [], needsReview: true, shouldWrite: false
  });
  assert.deepEqual(planMaintenanceSourceMigration({ status: "待校准", privateProcessed: true }), {
    status: "待校准", targetPaths: [], needsReview: false, shouldWrite: false
  });
  for (const evidence of [
    { privateProcessed: false, registryProcessed: true },
    { privateProcessed: true, registryProcessed: false },
    { legacyProcessed: false, privateProcessed: true },
    { legacyProcessed: true, registryProcessed: false }
  ]) {
    const processed = evidence.privateProcessed ?? evidence.registryProcessed ?? evidence.legacyProcessed;
    assert.deepEqual(planMaintenanceSourceMigration(evidence), {
      status: processed ? "已提炼" : "未提炼", targetPaths: [], needsReview: Boolean(processed), shouldWrite: true
    }, "private receipts outrank registry, which outranks old headers");
    assert.deepEqual(planMaintenanceSourceMigration({ ...evidence, status: "未提炼" }), {
      status: "未提炼", targetPaths: [], needsReview: false, shouldWrite: false
    });
    assert.deepEqual(planMaintenanceSourceMigration({ ...evidence, status: "已提炼", targetPaths: ["Wiki/A.md"] }), {
      status: "已提炼", targetPaths: ["Wiki/A.md"], needsReview: false, shouldWrite: false
    }, "the explicit current status resolves legacy contradictions");
  }
  assert.deepEqual(planMaintenanceSourceMigration({
    legacyProcessed: true, reverseSourceTargets: ["../other.md", "Wiki/A.md", "Wiki/A.md", "Wiki/B\n.md"]
  }), { status: "已提炼", targetPaths: ["Wiki/A.md"], needsReview: true, shouldWrite: true });
}

function assertExactBytePreservation(): void {
  const opening = "\uFEFF--- \r\n";
  const before = "# 文件头注释\r\naliases: [Alpha, \"别名\"] # 原生属性\r\n"
    + "nested:\r\n  摘要: 不属于受管字段\r\n  rows:\r\n    - label: |\r\n        提炼状态: 已提炼\r\n        正文样式 # 原样\r\n";
  const after = "# 与下一字段关联的注释\r\ncustom: >-\r\n  第一行\r\n  第二行\r\ntags: [one, two]\r\n";
  const closingAndBody = "... \r\n\r\n# 原文\r\n摘要: 这在正文里\r\n"
    + "```yaml\r\n提炼状态: 已提炼\r\n```\r\n最后一行没有换行";
  const original = opening + before + "提炼状态: 未提炼 # 状态注释\r\n"
    + "摘要: | # 摘要头注释\r\n  旧摘要第一行\r\n  旧摘要第二行\r\n"
    + "提炼到:\r\n  - \"[[Wiki/旧条目.md]]\"\r\n" + after + closingAndBody;
  const expected = opening + before + "提炼状态: \"已提炼\" # 状态注释\r\n"
    + "摘要: \"新摘要：保留来源。\" # 摘要头注释\r\n"
    + "提炼到:\r\n  [\"[[Wiki/条目 A.md]]\", \"[[Wiki/条目 B]]\"]\r\n" + after + closingAndBody;
  const patched = patchMaintenanceSourceFrontmatter(original, fields);
  assert.equal(patched, expected, "BOM, CRLF, nested blocks, aliases, comments and body are exact slices");
  assert.equal(patched.replaceAll("\r\n", "").includes("\n"), false);
  assert.equal(patchMaintenanceSourceFrontmatter(patched, fields), patched, "a repeated patch is byte-idempotent");
  assert.equal(isMaintenanceSourceProcessed(patched), true);
  assert.deepEqual(frontmatterValues(patched), {
    aliases: ["Alpha", "别名"], nested: { 摘要: "不属于受管字段", rows: [{ label: "提炼状态: 已提炼\n正文样式 # 原样\n" }] },
    提炼状态: "已提炼", 摘要: fields.summary, 提炼到: ["[[Wiki/条目 A.md]]", "[[Wiki/条目 B]]"],
    custom: "第一行 第二行", tags: ["one", "two"]
  });
}

function assertCreationAndEmptyValues(): void {
  const body = "\uFEFF# 原文\r\n\r\n内容 [[原样]]\r\n";
  const newFields: MaintenanceSourceFields = { status: "未提炼", summary: "一行\n二行\t\"引号\" # 文本", targetPaths: [] };
  const created = patchMaintenanceSourceFrontmatter(body, newFields);
  assert.equal(created, "\uFEFF---\r\n提炼状态: \"未提炼\"\r\n摘要: \"一行\\n二行\\t\\\"引号\\\" # 文本\"\r\n提炼到: []\r\n---\r\n" + body.slice(1));
  assert.equal(patchMaintenanceSourceFrontmatter(created, newFields), created);
  const existing = "---\n# 保留\naliases: ['A']\n---\n正文";
  const appended = patchMaintenanceSourceFrontmatter(existing, fields);
  assert.ok(appended.startsWith("---\n# 保留\naliases: ['A']\n提炼状态:"));
  assert.ok(appended.endsWith("---\n正文"));
  assert.equal(patchMaintenanceSourceFrontmatter(appended, fields), appended);
  const nulls = "---\n提炼状态: # 空状态\n摘要: null\n提炼到: null # 空目标\n---\n正文";
  const patched = patchMaintenanceSourceFrontmatter(nulls, newFields);
  assert.ok(patched.includes("提炼状态: \"未提炼\" # 空状态\n"));
  assert.ok(patched.includes("提炼到: [] # 空目标\n"));
  assert.deepEqual(frontmatterValues(patched), { 提炼状态: "未提炼", 摘要: newFields.summary, 提炼到: [] });
  assert.equal(patchMaintenanceSourceFrontmatter("---\n---\nbody", newFields).endsWith("---\nbody"), true);
  const quotedPath = { ...fields, targetPaths: ["Wiki/It's a note.md", "Wiki/It's a note.md"] };
  assert.deepEqual(frontmatterValues(patchMaintenanceSourceFrontmatter("body", quotedPath)).提炼到, ["[[Wiki/It's a note.md]]"]);
  const empty = patchMaintenanceSourceFrontmatter(created, { status: "已提炼", summary: "", targetPaths: [] });
  assert.deepEqual(frontmatterValues(empty), { 提炼状态: "已提炼", 摘要: "", 提炼到: [] });
  assert.ok(empty.endsWith(body.slice(1)), "a source with no extracted units still preserves its body");
  const noClosingNewline = patchMaintenanceSourceFrontmatter("---\naliases: [A]\n---", fields);
  assert.ok(noClosingNewline.endsWith("\n---"), "preserve a closing delimiter without a final newline");
}

function assertManagedCommentsAndMultilineValues(): void {
  const original = "---\n提炼状态: 未提炼\n摘要: >- # folded\n  第一段\n  第二段\n"
    + "提炼到:\n  # list prefix\n  - '[[Wiki/old.md]]' # first item\n  # between items\n  - \"[[Wiki/second.md]]\" # second item\n"
    + "# next property\nother:\n  text: |\n    保留多行\n    # 内容不是注释\n---\n原文\n";
  const patched = patchMaintenanceSourceFrontmatter(original, fields);
  for (const comment of ["# folded", "# list prefix", "# first item", "# between items", "# second item", "# next property"]) {
    assert.equal(patched.split(comment).length, 2, `preserve ${comment} once`);
  }
  assert.ok(patched.endsWith("# next property\nother:\n  text: |\n    保留多行\n    # 内容不是注释\n---\n原文\n"));
  assert.deepEqual(frontmatterValues(patched).提炼到, fields.targetPaths.map((target) => `[[${target}]]`));
  assert.equal(patchMaintenanceSourceFrontmatter(patched, fields), patched);
  const multiline = "---\n提炼状态: '未提炼'\n摘要: old first\n  old second\n提炼到: [\"[[Wiki/old.md]]\"] # targets\n---\nbody";
  const multiPatched = patchMaintenanceSourceFrontmatter(multiline, fields);
  assert.ok(multiPatched.includes("# targets\n---\nbody"));
  assert.equal(patchMaintenanceSourceFrontmatter(multiPatched, fields), multiPatched);
  const same = "---\n提炼状态: 已提炼\n摘要: |\n  新摘要：保留来源。\n提炼到:\n  - '[[Wiki/条目 A.md]]'\n  - \"[[Wiki/条目 B]]\"\n---\nbody";
  assert.equal(patchMaintenanceSourceFrontmatter(same, { ...fields, summary: fields.summary + "\n" }), same, "matching multiline values keep their original spelling");
}

function assertUnsafeInputsRejected(): void {
  for (const yaml of [
    "提炼状态: 未提炼\n提炼状态: 已提炼\n",
    "other: one\nother: two\n",
    "other: [unclosed\n",
    "- list\n- root\n",
    "{提炼状态: 未提炼}\n",
    "? [complex, key]\n: value\n",
    "提炼状态: &state 未提炼\n",
    "other: &text hello\n摘要: *text\n",
    "摘要: !!str text\n",
    "摘要:\n  nested: value\n",
    "提炼到: '[[Wiki/A.md]]'\n",
    "提炼到:\n  - [[Wiki/A.md]]\n",
    "提炼到:\n  - \"[[../A.md]]\"\n",
    "提炼到: &links []\n"
  ]) assert.throws(() => patchMaintenanceSourceFrontmatter(`---\n${yaml}---\nunchanged body`, fields), undefined, yaml);
  for (const markdown of ["---\n提炼状态: 未提炼", "\uFEFF---", "---\r\ninvalid: [\r\n"]) {
    assert.throws(() => patchMaintenanceSourceFrontmatter(markdown, fields));
  }
  for (const target of ["", "../A.md", "Wiki/../A.md", "Wiki/./A.md", "/Wiki/A.md", "Wiki//A.md",
    "Wiki/A\n.md", "Wiki/A\r.md", "Wiki/A\u0000.md", "Wiki\\A.md", "Wiki/A|alias.md", "Wiki/A#heading", "[[Wiki/A.md]]", "https://example.com/A.md"]) {
    assert.throws(() => patchMaintenanceSourceFrontmatter("body", { ...fields, targetPaths: [target] }), undefined, target);
  }
}

function frontmatterValues(markdown: string): Record<string, any> {
  const withoutBom = markdown.replace(/^\uFEFF/u, "");
  const lines = withoutBom.split(/\r\n|\n|\r/u);
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/u.test(line));
  assert.ok(end > 0);
  return parse(lines.slice(1, end).join("\n"));
}

function assertReadOnlyLegacyTransition(): void {
  const fingerprint = "sha256:5:" + "a".repeat(64);
  const registry = { rawPath: "raw/a.md", fingerprint, size: 5, mtime: 1, digestedAt: 1, runId: "legacy-success", reportPath: "", evidencePaths: [], confidence: "verified" as const };
  let hashes = 0; const current = () => { hashes++; return fingerprint; };
  assert.equal(maintenanceSourceState("body", { fingerprint: current, registry }), "digested");
  assert.equal(hashes, 0);
  for (const value of ["已提炼", "未提炼", "null", "''", "", "[invalid"]) {
    const result = resolveMaintenanceSourceState(`---\n提炼状态: ${value}\n---\nbody`, { fingerprint: current, registry });
    assert.equal(result.state, value === "未提炼" ? "pending" : "digested", value);
    assert.equal(result.origin, ["已提炼", "未提炼"].includes(value) ? "new" : "registry"); assert.ok(result.reason);
  }
  assert.equal(hashes, 0, "daily source state never compares old fingerprints; nonstandard values preserve bytes and fall back to receipt priority");
  assert.equal(maintenanceSourceState("body", { fingerprint: () => "changed", registry }), "digested");
  assert.equal(maintenanceSourceState("body", { fingerprint: current, registry, maintenance: { fingerprint, status: "failed" } }), "failed");
  assert.equal(maintenanceSourceState("body", { fingerprint: current, registry, maintenance: { fingerprint, status: "unread" } }), "pending");
  assert.equal(maintenanceSourceState("body", { fingerprint: current, registry, maintenance: { fingerprint: "old", status: "processed" } }), "digested");
  assert.equal(maintenanceSourceState("body", { fingerprint: current, maintenance: { fingerprint, status: "processed" } }), "digested");
  assert.equal(maintenanceSourceState("body", { fingerprint: current, previous: {} }), "pending", "mtime/boolean hints cannot prove completion");
}
