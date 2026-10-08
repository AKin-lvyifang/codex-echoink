import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  BUILTIN_SKILLS,
  getBuiltinSkillDefinition,
  renderBuiltinSkill
} from "../harness/resources/builtin-skills";
import { initializeVaultResourceStore } from "../harness/resources/vault-store";
import {
  AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS,
  SkillRuntimeCoordinator
} from "../harness/resources/skill-runtime";
import { loadVaultSkill } from "../harness/resources/skill-loader";
import { EchoInkResourceCatalogService, requireAvailableEchoInkSkillResource } from "../plugin/resource-catalog-service";
import { defaultResourceSettings } from "../resources/registry";

export async function runSkillRuntimeScenarios(): Promise<void> {
  await assertBuiltinSkillManagementScenarios();
  await assertBuiltinSkillCatalogDegradesPerEntry();
  await withVault(async (vaultPath) => {
    const initialized = await initializeVaultResourceStore({ vaultPath });
    assert.equal(
      initialized.created.filter((file) => file.endsWith("/SKILL.md")).length,
      BUILTIN_SKILLS.length
    );
    await initializeVaultResourceStore({ vaultPath });
    for (const definition of BUILTIN_SKILLS) {
      const loaded = await loadVaultSkill({
        vaultPath,
        skillId: definition.id,
        maxBytes: 200_000
      });
      assert.equal(loaded.frontmatter.id, definition.id);
      assert.equal(loaded.frontmatter.permissions.length, 0);
      assert.match(loaded.instruction, new RegExp(definition.title, "u"));
      assert.equal(loaded.instruction, `# ${definition.title}\n\n${definition.body}`.trim(),
        "installed Skills retain their complete current guidance");
    }
    const knowledgeReview = BUILTIN_SKILLS.find(
      (definition) => definition.id === "knowledge-review"
    );
    assert.ok(knowledgeReview);
    assert.match(knowledgeReview.body, /recent 模式、kinds=\[wiki\]、limit=8/u);
    assert.match(knowledgeReview.body, /对返回的真实 Wiki 候选逐一调用 knowledge_read/u);
    assert.match(knowledgeReview.body, /分页读完所选 Wiki 的全部正文/u);
    assert.match(knowledgeReview.body, /每个 available Raw[\s\S]*changed 或 missing/u);
    assert.match(knowledgeReview.body, /每次回复只处理一个知识节点/u);
    assert.match(knowledgeReview.body, /不得调用 note_create 或 note_update/u);
    assert.match(knowledgeReview.body, /Journal 的保存授权不能推导为 Outputs 授权/u);

    let now = 10_000;
    let candidate = {
      eligible: true,
      candidate: {
        name: "Release evidence checklist",
        description: "复用已跑通的发布前证据核对流程。",
        triggerPhrases: ["发布前证据", "release evidence"],
        steps: ["列出本次交付声明。", "逐项绑定已有验证结果。"],
        output: "输出声明、证据和未验证项。",
        boundaries: ["不发布、不推送，也不新增权限。"],
        existingCapabilities: ["knowledge_read"]
      }
    };
    const reviewPrompts: string[] = [];
    const coordinator = new SkillRuntimeCoordinator(vaultPath, {
      now: () => now,
      reviewLlm: () => ({ call: async (input) => {
        reviewPrompts.push(input.userPrompt);
        return JSON.stringify(candidate);
      } })
    });
    const initial = await coordinator.initialize();
    assert.equal(Object.keys(initial.records).length, BUILTIN_SKILLS.length);
    assert.equal(Object.values(initial.records).every((record) =>
      record.origin === "builtin" && record.status === "active"
    ), true);

    assert.equal(await coordinator.selectForTask({
      text: "把 hello 翻译成中文",
      preferredSkillIds: ["evidence-freshness-audit"]
    }), null, "personality preference cannot trigger a Skill for a simple task");

    const review = await coordinator.selectForTask({
      text: "请做知识复盘，带我回看这些知识"
    });
    assert.equal(review?.id, "knowledge-review");

    const preferred = await coordinator.selectForTask({
      text: "请用小白能懂的方式，从第一性原理和多视角拆解这个复杂矛盾",
      preferredSkillIds: ["multi-lens-problem-solving", "two-layer-explanation"]
    });
    assert.equal(preferred?.id, "multi-lens-problem-solving");
    assert.deepEqual(preferred?.applicableSkillIds.slice(0, 2), [
      "multi-lens-problem-solving",
      "two-layer-explanation"
    ]);
    assert.equal(preferred?.applicableSkillIds.includes("deep-understanding"), true,
      "all matching Skills remain visible as routing evidence");
    assert.deepEqual(preferred?.skills.map((skill) => skill.id), [
      "multi-lens-problem-solving",
      "two-layer-explanation"
    ], "analysis and explanation combine, while overlapping analysis keeps only the more specific route");

    const requiredAndMethod = await coordinator.selectForTask({
      text: "请用第一性原理核验当前 AI 产品价格是否真实",
      preferredSkillIds: ["multi-lens-problem-solving"]
    });
    assert.deepEqual(requiredAndMethod?.skills.map((skill) => skill.id), [
      "evidence-freshness-audit",
      "multi-lens-problem-solving"
    ], "freshness is mandatory while only one complementary method is loaded");

    const freshness = await coordinator.selectForTask({
      text: "请核验当前 AI 产品价格是否真实，并给出最新来源",
      preferredSkillIds: ["multi-lens-problem-solving"]
    });
    assert.equal(freshness?.id, "evidence-freshness-audit",
      "freshness verification is a shared product requirement, not a personality option");
    assert.equal(freshness?.requiresFreshnessVerification, true);

    const selfExplorationAndAnalysis = await coordinator.selectForTask({
      text: "请用第一性原理分析我过去的真实经历，探索我的职业方向和长期优势",
      preferredSkillIds: ["multi-lens-problem-solving"]
    });
    assert.equal(
      selfExplorationAndAnalysis?.skills.some(
        (skill) => skill.id === "self-discovery-life-design"
      ),
      true,
      "self exploration remains an independent responsibility from analysis"
    );
    assert.equal(
      selfExplorationAndAnalysis?.skills.some(
        (skill) => skill.id === "multi-lens-problem-solving"
      ),
      true,
      "an explicitly requested analysis method can combine with self exploration"
    );

    const created = await coordinator.reviewCompletedTask({
      productRunId: "run-skill-review",
      request: "完成发布前证据核对",
      result: "所有声明均已由现有验证结果证明",
      terminalState: "completed",
      existingCapabilityIds: ["knowledge_read"]
    });
    assert.equal(created.outcome, "created");
    if (created.outcome !== "created") return;
    assert.equal(created.record.origin, "auto");
    assert.equal(created.record.userModified, false);
    assert.equal(created.record.status, "active");
    assert.equal(created.record.usageCount, 1);
    assert.equal(await readFile(created.skillPath, "utf8").then(Boolean), true);
    assert.match(reviewPrompts[0] ?? "", /existingSkills/u);
    assert.match(reviewPrompts[0] ?? "", /evidence-freshness-audit/u,
      "post-task review receives semantic summaries of existing Skills");

    candidate = {
      eligible: true,
      candidate: {
        name: "Release evidence review",
        description: "发布交付前逐项复核声明与已有验证证据。",
        triggerPhrases: ["发布前证据核对", "release evidence check"],
        steps: ["列出本次交付结论。", "逐个绑定已经完成的验证结果。"],
        output: "输出交付声明、对应证据与未核验部分。",
        boundaries: ["不执行发布、推送或扩权。"],
        existingCapabilities: ["knowledge_read"]
      }
    };
    const duplicate = await coordinator.reviewCompletedTask({
      productRunId: "run-skill-review-2",
      request: "再次完成同一流程",
      result: "同一流程再次通过",
      terminalState: "completed",
      existingCapabilityIds: ["knowledge_read"]
    });
    assert.equal(duplicate.outcome, "duplicate");

    candidate = {
      eligible: true,
      candidate: {
        name: "Decision handoff note",
        description: "把已完成任务的判断整理成可复用的交接说明。",
        triggerPhrases: ["决策交接说明"],
        steps: ["提炼已经确认的决定。", "列出执行边界和下一步。"],
        output: "输出决定、边界和下一步。",
        boundaries: ["只整理本轮已经确认的公开信息。"],
        existingCapabilities: []
      }
    };
    const methodOnly = await coordinator.reviewCompletedTask({
      productRunId: "run-method-only-review",
      request: "整理这次讨论形成的决策交接说明",
      result: "已形成决定、边界和下一步",
      terminalState: "completed",
      existingCapabilityIds: []
    });
    assert.equal(methodOnly.outcome, "created",
      "a successful reusable method can become a Skill without Tool or preselected Skill capabilities");
    if (methodOnly.outcome === "created") {
      assert.match(await readFile(methodOnly.skillPath, "utf8"), /无需 Tool/u);
    }

    now += AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.activeToDownranked + 1;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "downranked");
    now = 10_000 + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.downrankedToDisabled + 1;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "disabled");
    now = 10_000 + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.disabledToArchived + 1;
    const archived = await coordinator.advanceLifecycle();
    assert.equal(archived.records[created.record.id]?.status, "archived");
    await assert.rejects(readFile(created.skillPath, "utf8"));
    const archivedSkillPath = path.join(
      vaultPath,
      ".echoink/resources/skills-archive",
      created.record.id,
      "SKILL.md"
    );
    assert.equal(await readFile(archivedSkillPath, "utf8").then(Boolean), true,
      "archiving moves the auto Skill into the recoverable archive area");
    const archivedAt = archived.records[created.record.id]!.statusChangedAt;
    now = archivedAt + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.archivedToCleaned - 1;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "archived",
      "physical cleanup is forbidden before a full 180 days in archived state");
    now += 2;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "cleaned");
    await assert.rejects(readFile(archivedSkillPath, "utf8"));

    candidate = {
      eligible: true,
      candidate: {
        name: "Knowledge source ledger",
        description: "把本轮读取过的知识来源整理成可复用的来源核对清单。",
        triggerPhrases: ["来源核对清单"],
        steps: ["收集已成功读取的来源。", "按结论关联来源与日期。"],
        output: "输出来源、日期和对应结论。",
        boundaries: ["只使用本轮已成功读取的来源。"],
        existingCapabilities: ["knowledge_read"]
      }
    };
    const userTouched = await coordinator.reviewCompletedTask({
      productRunId: "run-user-touched-skill",
      request: "整理本轮已读取来源",
      result: "来源已读取并完成对应",
      terminalState: "completed",
      existingCapabilityIds: ["knowledge_read"]
    });
    assert.equal(userTouched.outcome, "created");
    if (userTouched.outcome !== "created") return;
    const userTouchedCreatedAt = now;
    now = userTouchedCreatedAt
      + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.activeToDownranked + 1;
    await coordinator.advanceLifecycle();
    now = userTouchedCreatedAt
      + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.downrankedToDisabled + 1;
    assert.equal(
      (await coordinator.advanceLifecycle()).records[userTouched.record.id]?.status,
      "disabled"
    );
    const beforeUserEdit = (await coordinator.read()).records[userTouched.record.id]!;
    await writeFile(
      userTouched.skillPath,
      `${await readFile(userTouched.skillPath, "utf8")}\n<!-- user edit after disable -->\n`,
      "utf8"
    );
    now += 1;
    const restarted = new SkillRuntimeCoordinator(vaultPath, { now: () => now });
    const restartedState = await restarted.initialize();
    const restartedRecord = restartedState.records[userTouched.record.id]!;
    assert.equal(restartedRecord.userModified, true);
    assert.equal(restartedRecord.status, "active",
      "a user edit observed during restart reactivates a disabled auto Skill");
    assert.equal(restartedRecord.statusChangedAt, now);
    assert.notEqual(restartedRecord.contentHash, beforeUserEdit.contentHash,
      "restart records the user's current content hash");
    assert.equal(restartedRecord.createdAt, beforeUserEdit.createdAt);
    assert.equal(restartedRecord.usageCount, beforeUserEdit.usageCount);
    assert.equal(restartedRecord.lastUsedAt, beforeUserEdit.lastUsedAt);
    const restartedRoute = await restarted.selectForTask({
      text: "请按来源核对清单整理这次已经读取的资料"
    });
    assert.equal(
      restartedRoute?.applicableSkillIds.includes(userTouched.record.id),
      true,
      "the reactivated user-modified Skill is routable after restart"
    );
    await coordinator.recordUse(userTouched.record.id, now + 1);
    const manuallyUsed = await coordinator.read();
    assert.equal(manuallyUsed.records[userTouched.record.id]?.status, "active");
    assert.equal(manuallyUsed.records[userTouched.record.id]?.usageCount, 2,
      "manual use reactivates and records an auto Skill");
    now += AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.disabledToArchived + 1;
    const userModifiedAuto = await coordinator.advanceLifecycle();
    assert.equal(userModifiedAuto.records[userTouched.record.id]?.userModified, true);
    assert.equal(userModifiedAuto.records[userTouched.record.id]?.status, "active",
      "a user edit observed before transition permanently exits auto cleanup");

    const builtinPath = path.join(
      vaultPath,
      ".echoink/resources/skills/evidence-freshness-audit/SKILL.md"
    );
    await writeFile(builtinPath, `${await readFile(builtinPath, "utf8")}\n<!-- user edit -->\n`, "utf8");
    const reloaded = new SkillRuntimeCoordinator(vaultPath, { now: () => now });
    const state = await reloaded.initialize();
    assert.equal(state.records["evidence-freshness-audit"]?.userModified, true);
    now += 10 * AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.archivedToCleaned;
    const preserved = await reloaded.advanceLifecycle();
    assert.equal(preserved.records["evidence-freshness-audit"]?.status, "active");
    assert.equal(await readFile(builtinPath, "utf8").then(Boolean), true,
      "preinstalled and user-modified Skills never enter automatic cleanup");

    candidate = {
      eligible: true,
      candidate: {
        name: "Incident decision ledger",
        description: "把一次处理过程中的决定整理成后续可复用的决策记录。",
        triggerPhrases: ["事故决策记录"],
        steps: ["提取已执行的关键决定。", "记录结果与适用边界。"],
        output: "输出决定、结果和适用边界。",
        boundaries: ["不补写本轮没有发生的动作。"],
        existingCapabilities: []
      }
    };
    now += 1;
    const concurrentReviews = await Promise.all([
      coordinator.reviewCompletedTask({
        productRunId: "run-concurrent-review-a",
        request: "整理事故处理决策",
        result: "决策已经执行并验证",
        terminalState: "completed",
        existingCapabilityIds: []
      }),
      coordinator.reviewCompletedTask({
        productRunId: "run-concurrent-review-b",
        request: "沉淀同一事故处理决策",
        result: "同一方法已经执行并验证",
        terminalState: "completed",
        existingCapabilityIds: []
      })
    ]);
    assert.deepEqual(
      concurrentReviews.map((result) => result.outcome).sort(),
      ["created", "duplicate"],
      "concurrent reviews recheck the latest state and create only one semantic Skill"
    );
    const concurrentCreated = concurrentReviews.find(
      (result) => result.outcome === "created"
    );
    assert.ok(concurrentCreated?.outcome === "created");
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      coordinator.recordUse(concurrentCreated.record.id, now + index + 1)
    ));
    assert.equal(
      (await coordinator.read()).records[concurrentCreated.record.id]?.usageCount,
      9,
      "concurrent usage recording preserves every increment"
    );
  });
  console.log("PASS EchoInk Skill installation, routing, learning, and lifecycle contracts");
}

async function assertBuiltinSkillManagementScenarios(): Promise<void> {
  await withVault(async (vaultPath) => {
    await initializeVaultResourceStore({ vaultPath });
    const definition = getBuiltinSkillDefinition("daily-journal");
    assert.ok(definition);
    const canonicalContent = renderBuiltinSkill(definition);
    const entryPath = path.join(
      vaultPath,
      ".echoink/resources/skills/daily-journal/SKILL.md"
    );
    const coordinator = new SkillRuntimeCoordinator(vaultPath, {
      now: () => 20_000
    });
    const initial = await coordinator.initialize();
    assert.equal(initial.records["daily-journal"]?.origin, "builtin");
    assert.equal(initial.records["daily-journal"]?.userModified, false);
    const ordinaryJournalSelection = await coordinator.selectForTask({
      text: "我想写一篇今天的日记"
    });
    assert.equal(
      ordinaryJournalSelection?.applicableSkillIds.includes("daily-journal")
        ?? false,
      false,
      "daily-journal is never selected from ordinary chat text"
    );

    const previousBuiltinContent = canonicalContent.replace(
      "version: 1.0.0",
      "version: 0.9.0"
    );
    await writeFile(entryPath, previousBuiltinContent, "utf8");
    const stateDocument = JSON.parse(
      await readFile(coordinator.statePath, "utf8")
    ) as {
      records: Record<string, {
        contentHash: string;
        userModified: boolean;
      }>;
    };
    stateDocument.records["daily-journal"]!.contentHash = sha256Text(
      previousBuiltinContent
    );
    stateDocument.records["daily-journal"]!.userModified = false;
    await writeFile(
      coordinator.statePath,
      `${JSON.stringify(stateDocument, null, 2)}\n`,
      "utf8"
    );
    const upgraded = new SkillRuntimeCoordinator(vaultPath, {
      now: () => 21_000
    });
    const upgradedState = await upgraded.initialize();
    assert.equal(await readFile(entryPath, "utf8"), canonicalContent,
      "an untouched built-in Skill upgrades to the current bundled content");
    assert.equal(upgradedState.records["daily-journal"]?.userModified, false);

    const customizedContent = canonicalContent.replace(
      "## 交谈",
      "## 我的交谈方式"
    );
    const saved = await upgraded.saveBuiltinSkillContent(
      "daily-journal",
      customizedContent
    );
    assert.equal(saved.fileStatus, "ready");
    assert.equal(saved.userModified, true);
    assert.equal(await readFile(entryPath, "utf8"), customizedContent);
    const customizedRestart = new SkillRuntimeCoordinator(vaultPath, {
      now: () => 22_000
    });
    assert.equal(
      (await customizedRestart.initialize()).records["daily-journal"]?.userModified,
      true
    );
    assert.equal(await readFile(entryPath, "utf8"), customizedContent,
      "a customized built-in Skill is not overwritten during startup");

    await rm(entryPath);
    const missingRestart = new SkillRuntimeCoordinator(vaultPath, {
      now: () => 23_000
    });
    await missingRestart.initialize();
    const missing = await missingRestart.inspectBuiltinSkill("daily-journal");
    assert.equal(missing.fileStatus, "missing");
    await assert.rejects(readFile(entryPath, "utf8"),
      "a recorded but missing built-in Skill is not silently recreated");
    await assert.rejects(
      missingRestart.saveBuiltinSkillContent("daily-journal", canonicalContent),
      /builtin_skill_file_missing/u
    );

    const restored = await missingRestart.restoreBuiltinSkill("daily-journal");
    assert.equal(restored.fileStatus, "ready");
    assert.equal(restored.userModified, false);
    assert.equal(await readFile(entryPath, "utf8"), canonicalContent);

    await writeFile(entryPath, "", "utf8");
    const invalidRestart = new SkillRuntimeCoordinator(vaultPath, {
      now: () => 24_000
    });
    await invalidRestart.initialize();
    const invalid = await invalidRestart.inspectBuiltinSkill("daily-journal");
    assert.equal(invalid.fileStatus, "invalid");
    assert.equal(await readFile(entryPath, "utf8"), "",
      "a recorded but invalid built-in Skill is preserved for explicit repair");
    const repaired = await invalidRestart.saveBuiltinSkillContent(
      "daily-journal",
      customizedContent
    );
    assert.equal(repaired.fileStatus, "ready");
    assert.equal(repaired.userModified, true);
    const reset = await invalidRestart.restoreBuiltinSkill("daily-journal");
    assert.equal(reset.userModified, false);
    assert.equal(await readFile(entryPath, "utf8"), canonicalContent);
  });
}

async function assertBuiltinSkillCatalogDegradesPerEntry(): Promise<void> {
  await withVault(async (vaultPath) => {
    await initializeVaultResourceStore({ vaultPath });
    const coordinator = new SkillRuntimeCoordinator(vaultPath, {
      now: () => 30_000
    });
    await coordinator.initialize();
    await rm(path.join(
      vaultPath,
      ".echoink/resources/skills/daily-journal/SKILL.md"
    ));
    await writeFile(path.join(
      vaultPath,
      ".echoink/resources/skills/evidence-freshness-audit/SKILL.md"
    ), "", "utf8");
    const resources = defaultResourceSettings();
    const plugin = {
      settings: { resources },
      getVaultPath: () => vaultPath,
      getSkillRuntimeCoordinator: () => coordinator,
      withEchoInkResourceMutation: async <T>(action: () => Promise<T>) =>
        await action(),
      saveEchoInkResourceMutation: async () => undefined
    };
    const catalog = await new EchoInkResourceCatalogService(plugin as never)
      .buildRuntimeCatalog();
    const finance = requireAvailableEchoInkSkillResource(catalog, "finance-bill-import");
    assert.ok(finance.contentPath?.endsWith("finance-bill-import/SKILL.md"));
    await coordinator.resolveById("finance-bill-import");
    assert.match((await coordinator.inspectBuiltinSkill("finance-bill-import")).content, /五项语义属性/u);
    const analysis = requireAvailableEchoInkSkillResource(catalog, "finance-analysis");
    assert.ok(analysis.contentPath?.endsWith("finance-analysis/SKILL.md"));
    await coordinator.resolveById("finance-analysis");
    const analysisContent = (await coordinator.inspectBuiltinSkill("finance-analysis")).content;
    const analysisDefinition = getBuiltinSkillDefinition("finance-analysis");
    assert.ok(analysisDefinition);
    assert.equal(analysisContent, renderBuiltinSkill(analysisDefinition),
      "the runtime reads the current built-in analysis guidance");
    const editedAnalysis = `${analysisContent}\n\n## 我的消费安排\n优先讨论可以执行的消费调整。\n`;
    const savedAnalysis = await coordinator.saveBuiltinSkillContent("finance-analysis", editedAnalysis);
    assert.equal(savedAnalysis.userModified, true, "finance analysis is editable through the existing Skill runtime");
    assert.equal((await coordinator.inspectBuiltinSkill("finance-analysis")).content, editedAnalysis);
    resources.catalog = catalog.map((resource) => resource.id === analysis.id ? { ...resource, enabled: false } : resource);
    const disabledAnalysisCatalog = await new EchoInkResourceCatalogService(plugin as never).buildRuntimeCatalog();
    assert.throws(() => requireAvailableEchoInkSkillResource(disabledAnalysisCatalog, "finance-analysis"), /已停用/u);
    resources.catalog = catalog.map((resource) => resource.id === finance.id ? { ...resource, enabled: false } : resource);
    const disabledCatalog = await new EchoInkResourceCatalogService(plugin as never).buildRuntimeCatalog();
    assert.throws(() => requireAvailableEchoInkSkillResource(disabledCatalog, "finance-bill-import"), /已停用/u);
    assert.equal(
      catalog.filter((resource) => resource.kind === "skill").length,
      BUILTIN_SKILLS.length,
      "one damaged Skill does not hide the rest of the catalog"
    );
    assert.equal(
      catalog.find((resource) => resource.metadata?.resourceId === "daily-journal")
        ?.metadata?.fileStatus,
      "missing"
    );
    assert.equal(
      catalog.find((resource) =>
        resource.metadata?.resourceId === "evidence-freshness-audit"
      )?.metadata?.fileStatus,
      "invalid"
    );
    assert.match(resources.lastError, /daily-journal/u);
    assert.match(resources.lastError, /evidence-freshness-audit/u);
  });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function withVault(run: (vaultPath: string) => Promise<void>): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-skill-runtime-"));
  try {
    await run(vaultPath);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}
