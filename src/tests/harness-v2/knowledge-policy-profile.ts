import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CORE_KNOWLEDGE_POLICY, coreKnowledgePolicySections } from "../../workflows/knowledge/policy/core-policy";
import { buildVaultProfileTemplate, parseVaultProfile } from "../../workflows/knowledge/profile/profile-parser";
import { buildKnowledgeBaseRulesTemplate } from "../../knowledge-base/initializer";
import { buildKnowledgeBaseAskPrompt, buildKnowledgeBasePrompt } from "../../knowledge-base/prompt";
import { loadKnowledgeBaseRulesContext } from "../../knowledge-base/rules-context";

export async function runHarnessV2KnowledgePolicyProfileTests(): Promise<void> {
  assertCorePolicyContainsNonOverridableRules();
  assertKnowledgePromptsInjectCorePolicy();
  assertVaultProfileParserKeepsUserPreferencesSeparate();
  assertVaultProfileTemplateDoesNotContainCorePolicy();
  assertInitializerRulesTemplateUsesVaultProfileOnly();
  assertInvalidVaultProfileFallsBackSafely();
  await assertKnowledgeRulesAreLoadedFreshAsRequiredSystemContext();
  await assertKnowledgeRulesFailClosedBeforeAgentStart();
}

function assertCorePolicyContainsNonOverridableRules(): void {
  assert.equal(CORE_KNOWLEDGE_POLICY.id, "echoink-core-knowledge-policy");
  assert.equal(CORE_KNOWLEDGE_POLICY.rules.some((rule) => rule.id === "raw-source-readonly"), true);
  assert.equal(CORE_KNOWLEDGE_POLICY.rules.some((rule) => rule.id === "check-is-readonly"), true);
  assert.equal(CORE_KNOWLEDGE_POLICY.rules.some((rule) => rule.id === "agent-final-text-not-success-source"), true);

  const sections = coreKnowledgePolicySections();
  assert.equal(sections.every((section) => section.required), true);
  assert.match(sections.map((section) => section.content).join("\n"), /Raw/);
  assert.match(sections.map((section) => section.content).join("\n"), /Agent 最终文本不能决定业务成功/);
}

function assertKnowledgePromptsInjectCorePolicy(): void {
  const maintainPrompt = buildKnowledgeBasePrompt({
    vaultPath: "/vault",
    mode: "maintain",
    reportPath: "outputs/maintenance/report.md",
    sources: [],
    rulesFilePath: "LLM-WIKI.md",
    rulesFileExists: true,
    useCustomRulesFile: true,
    hasRawIndex: true,
    hasWikiIndex: true,
    hasTracker: true
  });
  const askPrompt = buildKnowledgeBaseAskPrompt({
    vaultPath: "/vault",
    userRequest: "问一个问题",
    rulesFilePath: "LLM-WIKI.md",
    rulesFileExists: true,
    useCustomRulesFile: true,
    matches: []
  });

  assert.match(maintainPrompt, /## EchoInk Core Policy/);
  assert.match(maintainPrompt, /Raw source is read-only for agents/);
  assert.match(maintainPrompt, /Agent final text is not business state/);
  assert.match(askPrompt, /## EchoInk Core Policy/);
  assert.match(askPrompt, /Check is read-only/);
}

function assertVaultProfileParserKeepsUserPreferencesSeparate(): void {
  const parsed = parseVaultProfile([
    "---",
    "echoink_profile_version: 1",
    "language: zh-CN",
    "roots:",
    "  raw: raw",
    "  wiki: wiki",
    "  projects: projects",
    "protected_paths:",
    "  - templates",
    "  - work",
    "ignored_paths: [testing, archive]",
    "naming:",
    "  prefer_existing_pages: true",
    "automation:",
    "  delete: false",
    "---",
    "# 当前知识库说明",
    "",
    "## 领域与分类",
    "AI、产品、内容。"
  ].join("\n"));

  assert.equal(parsed.profile.language, "zh-CN");
  assert.equal(parsed.profile.roots.raw, "raw");
  assert.deepEqual(parsed.profile.protectedPaths, ["templates", "work"]);
  assert.deepEqual(parsed.profile.ignoredPaths, ["testing", "archive"]);
  assert.equal(parsed.profile.naming.preferExistingPages, true);
  assert.equal(parsed.profile.automation.delete, false);
  assert.match(parsed.body, /领域与分类/);
  assert.deepEqual(parsed.issues, []);
}

function assertVaultProfileTemplateDoesNotContainCorePolicy(): void {
  const template = buildVaultProfileTemplate(new Date("2026-07-11T00:00:00Z"));
  assert.match(template, /echoink_profile_version: 1/);
  assert.match(template, /# 当前知识库说明/);
  assert.doesNotMatch(template, /四步提炼协议/);
  assert.doesNotMatch(template, /Raw 自动维护保护/);
  assert.doesNotMatch(template, /Agent 最终文本/);
}

function assertInitializerRulesTemplateUsesVaultProfileOnly(): void {
  const template = buildKnowledgeBaseRulesTemplate(new Date("2026-07-11T00:00:00Z"));
  assert.match(template, /echoink_profile_version: 1/);
  assert.match(template, /# 当前知识库说明/);
  assert.doesNotMatch(template, /四步提炼协议/);
  assert.doesNotMatch(template, /Raw.*不可由 Agent 改写/);
  assert.doesNotMatch(template, /Agent 最终文本不能决定业务成功/);
}

function assertInvalidVaultProfileFallsBackSafely(): void {
  const parsed = parseVaultProfile([
    "---",
    "echoink_profile_version: nope",
    "language: ",
    "roots:",
    "  raw: ../raw",
    "automation:",
    "  delete: true",
    "---",
    "正文保留"
  ].join("\n"));

  assert.equal(parsed.profile.version, 1);
  assert.equal(parsed.profile.language, "zh-CN");
  assert.equal(parsed.profile.roots.raw, "raw");
  assert.equal(parsed.profile.automation.delete, false);
  assert.match(parsed.body, /正文保留/);
  assert.equal(parsed.issues.length > 0, true);
}

async function assertKnowledgeRulesAreLoadedFreshAsRequiredSystemContext(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-rules-context-"));
  try {
    const rulesPath = path.join(vaultPath, "rules", "knowledge.md");
    await mkdir(path.dirname(rulesPath), { recursive: true });
    await writeFile(rulesPath, "# Knowledge Rules\n\nRULE-V1", "utf8");

    const first = await loadKnowledgeBaseRulesContext(vaultPath, "rules/knowledge.md");
    assert.equal(first.section.channel, "system");
    assert.equal(first.section.required, true);
    assert.equal(first.section.sensitive, true);
    assert.match(first.section.content, /RULE-V1/);
    assert.match(first.section.source, /sha256:/);

    await writeFile(rulesPath, "# Knowledge Rules\n\nRULE-V2", "utf8");
    const second = await loadKnowledgeBaseRulesContext(vaultPath, "rules/knowledge.md");
    assert.match(second.section.content, /RULE-V2/);
    assert.notEqual(second.sha256, first.sha256);
    assert.notEqual(second.section.source, first.section.source);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertKnowledgeRulesFailClosedBeforeAgentStart(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-rules-context-failure-"));
  try {
    await assert.rejects(
      () => loadKnowledgeBaseRulesContext(vaultPath, "missing.md"),
      /知识库规则文件不存在/
    );
    await writeFile(path.join(vaultPath, "empty.md"), "  \n", "utf8");
    await assert.rejects(
      () => loadKnowledgeBaseRulesContext(vaultPath, "empty.md"),
      /知识库规则文件为空/
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}
