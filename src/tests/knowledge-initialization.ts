import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildKnowledgeInitializationGuideTemplate,
  isKnowledgeInitializationRole,
  KnowledgeBaseInitializer,
  KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS,
  KNOWLEDGE_INITIALIZATION_GUIDE_PATH,
  KNOWLEDGE_INITIALIZATION_MARKDOWN_ROLES,
  KNOWLEDGE_INITIALIZATION_ROOTS,
  knowledgeInitializationParentFolder,
  knowledgeInitializationPathExists,
  type KnowledgeInitializationBatchResult,
  type KnowledgeInitializationHost,
  type KnowledgeInitializationJob,
  type KnowledgeInitializationProviderSnapshot,
  type KnowledgeInitializationVaultFile
} from "../knowledge-base/initializer";
import { buildKnowledgeInitializationProgress } from "../knowledge-base/initialization-progress";
import { deriveKnowledgeInitializationRecovery } from "../settings/knowledge-initialization-recovery";

export async function runKnowledgeInitializationTests(): Promise<void> {
  await assertDirectorySnapshotAndNamingCancellation();
  await assertPartialRecoveryAndSaveOnlyRetry();
  await assertCorruptJobCanBeRescanned();
  assertRootLevelInitializationFileHasNoFolderCreation();
  await assertHiddenInitializationFileExistsOutsideVaultIndex();
  await assertKnowledgeBaseStructureInspectionAndRepair();
  await assertRecommendedAndCustomPreview();
  await assertCustomPreviewIncludesCurrentManagedMarkdown();
  await assertArchiveAndTemplatesRoles();
  await assertAssignManyBatchSemantics();
  await assertAssignManyCloneOnWriteFailureSemantics();
  await assertPreviewStageNeverMovesOrCallsProvider();
  assertKnowledgeInitializationProgressContract();
  assertKnowledgeInitializationRecoveryDerivation();
  await assertProviderOrModelChangeKeepsPlan();
  await assertInitializationDoesNotGenerateLegacyRulesFile();
  await assertGeneratedGuideIncludesOfflineAssets();
  await assertManagedLegacyGuideRefreshIsSafe();
  await assertRecommendedArchivesOrdinaryFilesAndOnlyExtractsMarkdown();
  await assertZeroQueuePreservesUserFilesAndSkipsProvider();
  await assertSerialBatchSizes();
  await assertCurrentExtractionSourcesAndNoProgress();
  await assertArchiveLinkUpdatesDoNotBlockExtraction();
  await assertVerifiedMoveAcceptsCurrentContent();
  await assertConflictCancellationAndProviderRecoveryStops();
  await assertGuideConflictPreservesUserFile();
  await assertGuideAssetConflictPreservesUserFile();
  await assertPriorGeneratedGuideIsReusableAfterNewPreview();
  await assertRestartPausesWithoutProviderReplay();
}

async function assertCorruptJobCanBeRescanned(): Promise<void> {
  await withHost(async (host) => {
    const directory = path.join(host.privateRootPath, "knowledge/initialization/onboarding-v1");
    await fsp.mkdir(directory, { recursive: true });
    const damaged = '{"status":';
    await fsp.writeFile(path.join(directory, "job.json"), damaged);
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    assert.throws(() => initializer.snapshot(), /读取初始化记录.*重新扫描/u);
    host.addFile("raw/recovered.md", "readable source");
    const preview = await initializer.startPreview();
    assert.equal(preview.phase, "preview");
    assert.deepEqual(preview.extractionQueue, ["raw/recovered.md"]);
    const backup = (await fsp.readdir(directory)).find((name) => name.startsWith("job.json.invalid-"));
    assert.ok(backup);
    assert.equal(await fsp.readFile(path.join(directory, backup), "utf8"), damaged);
    const reopened = new KnowledgeBaseInitializer(host);
    await reopened.initialize();
    assert.equal(reopened.snapshot()?.jobId, preview.jobId);
  });
}

async function assertPartialRecoveryAndSaveOnlyRetry(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("notes/conflict.md", "original source");
    host.addFile("raw/imported/notes/conflict.md", "unrelated target");
    host.addFile("good.md", "independent source");
    const markInitialized = host.markInitialized.bind(host);
    let first = true;
    host.markInitialized = async (job) => {
      await markInitialized(job);
      if (first) { first = false; host.failNextJobPersist = new Error("disk temporarily unavailable"); }
    };
    let initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize(); await initializer.startPreview(); await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(completed.savePending, true);
    assert.deepEqual(host.batchCalls, [["raw/imported/good.md"]]);
    assert.deepEqual(completed.pendingSourcePaths, ["raw/imported/notes/conflict.md"]);
    assert.equal(host.read("raw/imported/notes/conflict.md"), "unrelated target");
    initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.continueJob(); // Saving has priority over pending content.
    assert.equal(initializer.snapshot()?.savePending, false);
    assert.equal(host.batchCalls.length, 1);
    assert.equal(host.moveCalls, 1);
    assert.doesNotMatch(initializer.snapshot()?.warnings?.join("\n") ?? "", /保存初始化状态：/u);
    host.addFile("archive/preserved-target.md", host.read("raw/imported/notes/conflict.md")!);
    host.files.delete("raw/imported/notes/conflict.md");
    await initializer.continueJob();
    const resumed = await waitForTerminal(initializer);
    assert.equal(host.read("raw/imported/notes/conflict.md"), "original source");
    assert.equal(host.read("archive/preserved-target.md"), "unrelated target");
    assert.deepEqual(host.batchCalls, [["raw/imported/good.md"], ["raw/imported/notes/conflict.md"]]);
    assert.deepEqual(resumed.pendingSourcePaths, []);
    assert.doesNotMatch(resumed.warnings?.join("\n") ?? "", /来源待处理：|保存初始化状态：/u);
  });
  await withHost(async (host) => {
    host.addFile("raw/missing.md", "missing later");
    host.addFile("raw/good.md", "readable");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize(); await initializer.startPreview();
    host.files.delete("raw/missing.md");
    host.openGuide = async () => { throw new Error("open denied api_key=sk-fixture-secret"); };
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.deepEqual(host.batchCalls, [["raw/good.md"]]);
    const reloaded = new KnowledgeBaseInitializer(host); await reloaded.initialize();
    assert.deepEqual(reloaded.snapshot()?.pendingSourcePaths, ["raw/missing.md"]);
    assert.match(reloaded.snapshot()?.warnings?.join("\n") ?? "", /打开指南/u);
    assert.doesNotMatch(completed.warnings?.join("\n") ?? "", /sk-fixture-secret/u);
  });
}

async function assertKnowledgeBaseStructureInspectionAndRepair(): Promise<void> {
  await withHost(async (host) => {
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();

    const empty = await initializer.inspectStructure();
    assert.equal(empty.state, "uninitialized");
    assert.deepEqual(empty.existingRoots, []);
    assert.deepEqual(empty.missingRoots, KNOWLEDGE_INITIALIZATION_ROOTS);
    assert.deepEqual(empty.conflictingRoots, []);

    host.folders.add("raw");
    host.folders.add("wiki");
    host.addFile("projects", "same-name user file");
    const incomplete = await initializer.inspectStructure();
    assert.equal(incomplete.state, "incomplete");
    assert.deepEqual(incomplete.existingRoots, ["raw", "wiki"]);
    assert.deepEqual(incomplete.conflictingRoots, ["projects"]);

    const progress: Array<{ completed: number; percent: number }> = [];
    const repaired = await initializer.restoreStructure((entry) => {
      progress.push({ completed: entry.completed, percent: entry.percent });
    });
    assert.equal(repaired.structure.state, "incomplete");
    assert.deepEqual(repaired.structure.missingRoots, []);
    assert.deepEqual(repaired.structure.conflictingRoots, ["projects"]);
    assert.equal(host.read("projects"), "same-name user file");
    assert.equal(host.moveCalls, 0);
    assert.equal(host.batchCalls.length, 0);
    assert.deepEqual(progress[0], { completed: 0, percent: 0 });
    assert.deepEqual(progress.at(-1), { completed: 10, percent: 100 });
    assert.equal(progress.length, 11);

    host.files.delete("projects");
    const completed = await initializer.restoreStructure();
    assert.equal(completed.structure.state, "ready");
    assert.deepEqual(completed.structure.existingRoots, KNOWLEDGE_INITIALIZATION_ROOTS);
    assert.deepEqual(completed.createdRoots, ["projects"]);
  });
}

async function assertCustomPreviewIncludesCurrentManagedMarkdown(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("10-root.md", "ten");
    host.addFile("2-root.md", "two");
    host.addFile("wiki/Alpha.md", "wiki");
    host.addFile("raw/9.md", "raw");
    host.addFile("inbox/Beta.md", "inbox");
    host.addFile("assets/readme.md", "asset markdown is not assignable");

    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();

    const custom = await initializer.startPreview("custom");
    const byPath = new Map(custom.items.map((item) => [item.sourcePath, item] as const));
    assert.deepEqual([...byPath.keys()], [
      "10-root.md",
      "2-root.md",
      "inbox/Beta.md",
      "raw/9.md",
      "wiki/Alpha.md"
    ]);
    assert.equal(byPath.get("wiki/Alpha.md")?.role, "wiki");
    assert.equal(byPath.get("wiki/Alpha.md")?.targetPath, null);
    assert.equal(byPath.get("wiki/Alpha.md")?.state, "kept");
    assert.equal(byPath.get("raw/9.md")?.role, "raw");
    assert.equal(byPath.get("raw/9.md")?.targetPath, null);
    assert.deepEqual(custom.extractionQueue, [
      "raw/9.md",
      "raw/imported/10-root.md",
      "raw/imported/2-root.md"
    ]);
    assert.equal(byPath.has("assets/readme.md"), false);

    // 点击选择器前重新生成 preview 必须看到此刻刚创建的笔记，而不是
    // 继续复用上一次冻结列表。
    host.addFile("3-new.md", "new");
    const refreshed = await initializer.startPreview("custom");
    assert.ok(refreshed.items.some((item) => item.sourcePath === "3-new.md"));

    // 已在固定目录里的笔记可以改分配；选回它实际所在的目录时恢复原位，
    // 不产生一次毫无意义的同目录 imported 移动。
    const moved = await initializer.assignMany([
      { sourcePath: "wiki/Alpha.md", role: "projects" }
    ]);
    const movedWiki = moved.items.find((item) => item.sourcePath === "wiki/Alpha.md");
    assert.equal(movedWiki?.targetPath, "projects/imported/wiki/Alpha.md");
    assert.equal(movedWiki?.state, "pending");

    const restored = await initializer.assignMany([
      { sourcePath: "wiki/Alpha.md", role: "wiki" }
    ]);
    const restoredWiki = restored.items.find((item) => item.sourcePath === "wiki/Alpha.md");
    assert.equal(restoredWiki?.targetPath, null);
    assert.equal(restoredWiki?.state, "kept");

    // Raw 中的原笔记若被分配到其他目录，就不能仍留在待提炼队列里。
    const rawMovedAway = await initializer.assignMany([
      { sourcePath: "raw/9.md", role: "wiki" }
    ]);
    assert.equal(rawMovedAway.extractionQueue.includes("raw/9.md"), false);

    const rawMovedBack = await initializer.assignMany([
      { sourcePath: "raw/9.md", role: "raw" }
    ]);
    assert.equal(
      rawMovedBack.extractionQueue.includes("raw/9.md"),
      true,
      "moving an existing Raw note back to Raw must restore its extraction source"
    );
  });
}

function assertRootLevelInitializationFileHasNoFolderCreation(): void {
  assert.equal(knowledgeInitializationParentFolder("README.md"), null);
  assert.equal(
    knowledgeInitializationParentFolder("wiki/开始使用 EchoInk 知识库.md"),
    "wiki"
  );
}

async function assertHiddenInitializationFileExistsOutsideVaultIndex(): Promise<void> {
  const vaultRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-kb-path-exists-"));
  try {
    await fsp.mkdir(path.join(vaultRoot, "outputs"));
    await fsp.writeFile(path.join(vaultRoot, "outputs", ".ingest-tracker.md"), "tracker");
    assert.equal(
      await knowledgeInitializationPathExists(
        vaultRoot,
        "outputs/.ingest-tracker.md",
        false
      ),
      true,
      "disk files hidden from Obsidian's Vault index must still count as existing"
    );
  } finally {
    await fsp.rm(vaultRoot, { recursive: true, force: true });
  }
}

async function assertInitializationDoesNotGenerateLegacyRulesFile(): Promise<void> {
  await withHost(async (host) => {
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.deepEqual(preview.extractionQueue, []);
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(
      host.read("LLM-WIKI.md"),
      null,
      "fresh initialization must not generate the retired LLM-WIKI rules file"
    );
    assert.ok(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH));
  }, null);
}

async function assertGeneratedGuideIncludesOfflineAssets(): Promise<void> {
  await withHost(async (host) => {
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");

    const guide = host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH) ?? "";
    assert.match(guide, /template: echoink-knowledge-guide-v2/u);
    assert.match(guide, /日常怎么整理知识/u);
    assert.match(guide, /五类长期记忆/u);
    assert.match(guide, /人格会影响什么/u);
    assert.match(guide, /当前自我由自然语言写成/u);
    assert.match(guide, /不会形成分数、能力值/u);
    assert.doesNotMatch(guide, /六维|锋利度|主导度/u);
    assert.doesNotMatch(guide, /memory-personality-v1\.webp/u);
    for (const assetPath of KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS) {
      assert.match(guide, new RegExp(assetPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.ok(
        (host.readBinary(assetPath)?.byteLength ?? 0) > 10_000,
        `guide asset must be written as real offline image bytes: ${assetPath}`
      );
    }
  }, null);
}

async function assertManagedLegacyGuideRefreshIsSafe(): Promise<void> {
  const created = "2026-08-20T08:30";
  const legacyGuide = buildLegacyGuideFixture(created);
  await withHost(async (host) => {
    host.addFile(KNOWLEDGE_INITIALIZATION_GUIDE_PATH, legacyGuide);
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    assert.equal(await initializer.refreshManagedGuide(), true);
    const refreshed = host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH) ?? "";
    assert.match(refreshed, new RegExp(`created: ${created}`, "u"));
    assert.match(refreshed, /template: echoink-knowledge-guide-v2/u);
    assert.match(refreshed, /日常怎么整理知识/u);
    for (const assetPath of KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS) {
      assert.ok((host.readBinary(assetPath)?.byteLength ?? 0) > 10_000);
    }
  }, null);

  await withHost(async (host) => {
    const editedGuide = `${legacyGuide}\n用户补充的一行。\n`;
    host.addFile(KNOWLEDGE_INITIALIZATION_GUIDE_PATH, editedGuide);
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    assert.equal(await initializer.refreshManagedGuide(), false);
    assert.equal(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), editedGuide);
    assert.equal(host.binaryFiles.size, 0);
  }, null);
}

async function assertProviderOrModelChangeKeepsPlan(): Promise<void> {
  for (const changedProvider of [
    { providerId: "provider-changed", model: "model-ready" },
    { providerId: "provider-ready", model: "model-changed" }
  ]) {
    await withHost(async (host) => {
      host.addFile("raw/a.md", "a");
      const initializer = new KnowledgeBaseInitializer(host);
      await initializer.initialize();
      const preview = await initializer.startPreview("recommended");
      assert.deepEqual(preview.provider, {
        providerId: "provider-ready",
        model: "model-ready"
      });
      host.setProvider(changedProvider);
      await initializer.confirm();
      const completed = await waitForTerminal(initializer);
      assert.equal(completed.status, "initialized");
      assert.equal(completed.confirmedDigest, preview.planDigest);
      assert.deepEqual(completed.provider, changedProvider);
      assert.equal(host.batchCalls.length, 1);

    });
  }
}

async function assertRecommendedAndCustomPreview(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("outside/note.md", "alpha");
    host.addFile("outside/long.markdown", "beta");
    host.addFile("outside/rejected.mdown", "nope");
    host.addFile("outside/image.png", "binary image bytes");
    host.addFile("raw/existing.md", "raw");
    host.addFile("wiki/existing.md", "wiki");
    host.addFile("LLM-WIKI.md", "profile");
    host.addFile("assets/image.png", "binary");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const recommended = await initializer.startPreview("recommended");
    assert.deepEqual(
      recommended.items.map((item) => item.sourcePath),
      [
        "outside/image.png",
        "outside/long.markdown",
        "outside/note.md",
        "outside/rejected.mdown"
      ]
    );
    assert.deepEqual(
      recommended.items.map((item) => item.targetPath),
      [
        "raw/imported/outside/image.png",
        "raw/imported/outside/long.markdown",
        "raw/imported/outside/note.md",
        "raw/imported/outside/rejected.mdown"
      ]
    );
    assert.deepEqual(recommended.extractionQueue, [
      "raw/existing.md",
      "raw/imported/outside/long.markdown",
      "raw/imported/outside/note.md"
    ]);
    assert.deepEqual(
      recommended.extractionSources.map((source) => source.path),
      recommended.extractionQueue
    );
    assert.equal(recommended.expectedBatches, 1);

    const custom = await initializer.startPreview("custom");
    await assert.rejects(
      initializer.assign("outside/image.png", "wiki"),
      /附件不能分配到笔记目录/u
    );
    const assigned = await initializer.assign("outside/note.md", "wiki");
    assert.equal(
      assigned.items.find((item) => item.sourcePath === "outside/note.md")?.targetPath,
      "wiki/imported/outside/note.md"
    );
    assert.equal(assigned.extractionQueue.includes("wiki/imported/outside/note.md"), false);
    assert.equal(assigned.extractionQueue.includes("raw/imported/outside/note.md"), false);
    assert.equal(custom.mode, "custom");
  });
}

async function assertRecommendedArchivesOrdinaryFilesAndOnlyExtractsMarkdown(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("old-folder/note.md", "useful note");
    host.addFile("old-folder/diagram.png", "\u0000\u0001image bytes");
    host.addFile("old-folder/reference.pdf", "%PDF fixture");

    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.deepEqual(
      preview.items.map((item) => item.targetPath),
      [
        "raw/imported/old-folder/diagram.png",
        "raw/imported/old-folder/note.md",
        "raw/imported/old-folder/reference.pdf"
      ]
    );
    assert.deepEqual(preview.extractionQueue, [
      "raw/imported/old-folder/note.md"
    ]);

    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(host.read("old-folder/diagram.png"), null);
    assert.equal(host.read("old-folder/reference.pdf"), null);
    assert.equal(
      host.read("raw/imported/old-folder/diagram.png"),
      "\u0000\u0001image bytes"
    );
    assert.equal(
      host.read("raw/imported/old-folder/reference.pdf"),
      "%PDF fixture"
    );
    assert.deepEqual(host.batchCalls, [["raw/imported/old-folder/note.md"]]);
  });
}

async function assertArchiveAndTemplatesRoles(): Promise<void> {
  // archive/templates 是新 UI 的合法 Markdown 目标；assets 不是角色；
  // keep 仅保留给旧状态兼容。
  assert.deepEqual(KNOWLEDGE_INITIALIZATION_MARKDOWN_ROLES, [
    "raw", "wiki", "projects", "outputs", "inbox", "journal",
    "work", "archive", "templates"
  ]);
  assert.equal(isKnowledgeInitializationRole("archive"), true);
  assert.equal(isKnowledgeInitializationRole("templates"), true);
  assert.equal(isKnowledgeInitializationRole("keep"), true);
  assert.equal(isKnowledgeInitializationRole("assets"), false);
  assert.equal(isKnowledgeInitializationRole("unknown"), false);
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    host.addFile("outside/b.md", "beta");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("custom");
    const assigned = await initializer.assignMany([
      { sourcePath: "outside/a.md", role: "archive" },
      { sourcePath: "outside/b.md", role: "templates" }
    ]);
    assert.equal(
      assigned.items.find((item) => item.sourcePath === "outside/a.md")?.targetPath,
      "archive/imported/outside/a.md"
    );
    assert.equal(
      assigned.items.find((item) => item.sourcePath === "outside/b.md")?.targetPath,
      "templates/imported/outside/b.md"
    );
    // archive/templates 与 wiki 一样只做安全移动，不进入提炼队列；
    // 只有分配到 raw 的笔记才参与 /maintain 提炼。
    assert.deepEqual(assigned.extractionQueue, []);
    assert.equal(assigned.expectedBatches, 0);
    assert.equal(assigned.counts.move, 2);
  });
}

async function assertAssignManyBatchSemantics(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    host.addFile("outside/b.md", "beta");
    host.addFile("outside/c.md", "gamma");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("custom");

    // 10. 批量分配：同一 sourcePath 只处理一次，整批只刷新一次冻结计划、
    // 只持久化一次（onStateChanged 恰好一次）。
    const stateChangesBefore = host.stateChangedCalls;
    const batched = await initializer.assignMany([
      { sourcePath: "outside/a.md", role: "wiki" },
      { sourcePath: "outside/b.md", role: "projects" },
      { sourcePath: "outside/a.md", role: "archive" }
    ]);
    assert.equal(host.stateChangedCalls, stateChangesBefore + 1);
    const byPath = new Map(batched.items.map((item) => [item.sourcePath, item]));
    assert.equal(byPath.get("outside/a.md")?.role, "archive");
    assert.equal(byPath.get("outside/a.md")?.targetPath, "archive/imported/outside/a.md");
    assert.equal(byPath.get("outside/b.md")?.role, "projects");
    assert.equal(byPath.get("outside/c.md")?.role, "raw");
    // 只有 raw 目标的笔记进入提炼队列；archive/projects 只移动不提炼。
    assert.deepEqual(batched.extractionQueue, ["raw/imported/outside/c.md"]);
    assert.notEqual(batched.planDigest, "");

    // 11. 非法输入（未知路径）：整批零部分修改。
    const digestBefore = batched.planDigest;
    const stateBeforeInvalid = host.stateChangedCalls;
    await assert.rejects(
      initializer.assignMany([
        { sourcePath: "outside/c.md", role: "wiki" },
        { sourcePath: "outside/missing.md", role: "wiki" }
      ]),
      /找不到待分配的笔记/u
    );
    const afterInvalid = initializer.snapshot();
    assert.equal(afterInvalid?.planDigest, digestBefore);
    assert.equal(
      afterInvalid?.items.find((item) => item.sourcePath === "outside/c.md")?.role,
      "raw"
    );
    assert.equal(host.stateChangedCalls, stateBeforeInvalid);

    // 11. 非法输入（未知角色）：同样整批拒绝。
    await assert.rejects(
      initializer.assignMany([
        { sourcePath: "outside/c.md", role: "assets" as never }
      ]),
      /无效的知识库目录角色/u
    );
    assert.equal(
      initializer.snapshot()?.items.find((item) => item.sourcePath === "outside/c.md")?.role,
      "raw"
    );

    // 7/9. 单条 assign 委托批量接口：把同一笔记从 archive 移到 wiki 后，
    // 它只属于 wiki 一个目录；archive 目标不再出现在任何计划字段里。
    const moved = await initializer.assign("outside/a.md", "wiki");
    const movedItem = moved.items.find((item) => item.sourcePath === "outside/a.md");
    assert.equal(movedItem?.role, "wiki");
    assert.equal(movedItem?.targetPath, "wiki/imported/outside/a.md");
    assert.equal(moved.extractionQueue.includes("archive/imported/outside/a.md"), false);
    assert.equal(moved.extractionQueue.includes("wiki/imported/outside/a.md"), false);
    assert.deepEqual(moved.extractionQueue, ["raw/imported/outside/c.md"]);
  });
}

function assertKnowledgeInitializationProgressContract(): void {
  const baseJob = makeProgressJobFixture();

  // 无 job / 各阶段权重。
  assert.deepEqual(buildKnowledgeInitializationProgress(null, false), {
    stage: "idle", percent: 0, completed: 0, total: 0
  });
  assert.deepEqual(
    buildKnowledgeInitializationProgress({ ...baseJob, phase: "preview" }, false),
    { stage: "plan", percent: 5, completed: 0, total: 0 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({
      ...baseJob, phase: "create_directories", createdDirectories: ["raw", "wiki", "projects", "outputs"]
    }, false),
    { stage: "directories", percent: 11, completed: 4, total: 10 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({
      ...baseJob, phase: "move_notes", moveCursor: 4, items: makeProgressItems(10)
    }, false),
    { stage: "moving", percent: 30, completed: 4, total: 10 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({
      ...baseJob, phase: "batch_extraction",
      extractionQueue: makeProgressItems(20), extractionCursor: 8
    }, false),
    { stage: "extracting", percent: 63, completed: 8, total: 20 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress({ ...baseJob, phase: "generate_guide" }, false),
    { stage: "guide", percent: 95, completed: 0, total: 0 }
  );

  // 16/17. 正式完成即进入 100%/完成态：无论 settings 标记先后，
  // job.status/phase 一旦完成就是 done；不存在永远无法展示的 99→100 死逻辑。
  assert.deepEqual(
    buildKnowledgeInitializationProgress(
      { ...baseJob, phase: "complete", status: "initialized" },
      false
    ),
    { stage: "done", percent: 100, completed: 0, total: 0 }
  );
  assert.deepEqual(
    buildKnowledgeInitializationProgress(
      { ...baseJob, phase: "complete", status: "initialized" },
      true
    ),
    { stage: "done", percent: 100, completed: 0, total: 0 }
  );
  // 运行中的任何阶段都不得提前显示 100%。
  assert.ok(buildKnowledgeInitializationProgress(
    { ...baseJob, phase: "generate_guide", status: "active" }, false
  ).percent < 100, "running job must never show 100% early");

  // 15. 空目录 / 0 篇移动 / 0 篇提炼不产生 NaN，按区间完成处理。
  const emptyDirs = buildKnowledgeInitializationProgress(
    { ...baseJob, phase: "create_directories", createdDirectories: [] },
    false
  );
  assert.equal(emptyDirs.percent, 5);
  const emptyMoves = buildKnowledgeInitializationProgress(
    { ...baseJob, phase: "move_notes", items: [], moveCursor: 0 },
    false
  );
  assert.equal(emptyMoves.percent, 45);
  const emptyExtractions = buildKnowledgeInitializationProgress(
    { ...baseJob, phase: "batch_extraction", extractionQueue: [], extractionCursor: 0 },
    false
  );
  assert.equal(emptyExtractions.percent, 90);
  for (const progress of [emptyDirs, emptyMoves, emptyExtractions]) {
    assert.equal(Number.isFinite(progress.percent), true);
    assert.equal(Number.isNaN(progress.percent), false);
    assert.ok(progress.percent >= 0 && progress.percent <= 100);
  }
}

/**
 * 修复2 回归：暂停/冲突态的恢复方式完全由结构化字段派生
 * （status / confirmedDigest / planDigest / Provider 快照），
 * 禁止解析 lastError 中文字符串。
 */
function assertKnowledgeInitializationRecoveryDerivation(): void {
  const planDigest = "sha256:plan-fixture";
  const provider: KnowledgeInitializationProviderSnapshot = {
    providerId: "provider-ready", model: "model-ready"
  };
  const base = {
    mode: "recommended" as const,
    planDigest,
    extractionQueue: [] as string[],
    lastError: "这段中文错误文案不应该影响恢复分支判断",
    recoveryAction: "这段中文恢复指引也不应该影响恢复分支判断"
  };

  // A. digest 一致 + Provider 一致 + 非冲突 → continue。
  for (const status of ["paused", "cancelled", "failed_recoverable", "write_uncertain"] as const) {
    const recovery = deriveKnowledgeInitializationRecovery({
      job: { ...base, status, provider, confirmedDigest: planDigest } as never,
      currentProvider: provider
    });
    assert.equal(recovery.kind, "continue", `${status} with matching digest/provider`);
    assert.equal(recovery.digestMismatch, false);
    assert.equal(recovery.providerOutdated, false);
  }

  // B. blocked_conflict → recheck-conflict，即使 digest/Provider 都一致。
  assert.equal(deriveKnowledgeInitializationRecovery({
    job: { ...base, status: "blocked_conflict", provider, confirmedDigest: planDigest } as never,
    currentProvider: provider
  }).kind, "recheck-conflict");

  // C. 从未确认（confirmedDigest 为 null）→ recheck-preview。
  assert.equal(deriveKnowledgeInitializationRecovery({
    job: { ...base, status: "paused", provider, confirmedDigest: null } as never,
    currentProvider: provider
  }).kind, "recheck-preview");

  // D. digest 不一致 → recheck-preview。
  assert.equal(deriveKnowledgeInitializationRecovery({
    job: { ...base, status: "paused", provider, confirmedDigest: "sha256:other" } as never,
    currentProvider: provider
  }).kind, "recheck-preview");

  // E. Provider 模型或 id 变化 → recheck-preview。
  assert.equal(deriveKnowledgeInitializationRecovery({
    job: { ...base, status: "paused", provider, confirmedDigest: planDigest } as never,
    currentProvider: { providerId: "provider-ready", model: "model-new" }
  }).kind, "continue");
  assert.equal(deriveKnowledgeInitializationRecovery({
    job: { ...base, status: "paused", provider, confirmedDigest: planDigest } as never,
    currentProvider: { providerId: "provider-other", model: "model-ready" }
  }).kind, "continue");

  // F. 待提炼队列非空但当前无可用 Provider → recheck-preview。
  const queueRecovery = deriveKnowledgeInitializationRecovery({
    job: {
      ...base, status: "paused", provider, confirmedDigest: planDigest,
      extractionQueue: ["raw/imported/note-0.md"]
    } as never,
    currentProvider: null
  });
  assert.equal(queueRecovery.kind, "continue");
  assert.equal(queueRecovery.providerOutdated, true);

  // G. 队列为空时，当前没有 Provider 也不算 Provider 变化（两边都视为空键），
  //    digest 一致即可 continue；这与 continueJob 只在有队列时要求 Provider 一致。
  assert.equal(deriveKnowledgeInitializationRecovery({
    job: { ...base, status: "paused", provider: null, confirmedDigest: planDigest } as never,
    currentProvider: null
  }).kind, "continue");
}

function makeProgressItems(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `raw/imported/note-${index}.md`);
}

function makeProgressJobFixture(): KnowledgeInitializationJob {
  return {
    schemaVersion: 1,
    jobId: "progress-fixture",
    templateVersion: "onboarding-v1",
    mode: "recommended",
    phase: "move_notes",
    status: "active",
    createdAt: 1,
    updatedAt: 2,
    provider: { providerId: "provider-ready", model: "model-ready" },
    planDigest: "sha256:progress-fixture",
    confirmedDigest: null,
    items: [],
    extractionSources: [],
    extractionQueue: [],
    extractionCursor: 0,
    expectedBatches: 0,
    moveCursor: 0,
    createdDirectories: [],
    conversationId: null,
    productRunIds: [],
    counts: { move: 0, keep: 0, conflict: 0, ignored: 0, extraction: 0 },
    guidePath: KNOWLEDGE_INITIALIZATION_GUIDE_PATH,
    lastError: "",
    recoveryAction: ""
  };
}

async function assertCurrentExtractionSourcesAndNoProgress(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("raw/a.md", "before");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.match(preview.extractionSources[0]?.sourceRevision ?? "", /^sha256:/u);
    host.addFile("raw/a.md", "after");
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(completed.extractionCursor, 1);
    assert.equal(host.read("raw/a.md"), "after");
    assert.deepEqual(host.batchCalls, [["raw/a.md"]]);
    assert.deepEqual(completed.extractionSources, preview.extractionSources,
      "reading current Raw must not rewrite the confirmed move plan");
  });

  await withHost(async (host) => {
    host.addFile("raw/a.md", "before");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    host.files.delete("raw/a.md");
    await initializer.confirm();
    const paused = await waitForTerminal(initializer);
    assert.equal(paused.status, "initialized");
    assert.match(paused.warnings?.join("\n") ?? "", /raw\/a.md.*文件不存在/u);
    assert.deepEqual(paused.pendingSourcePaths, ["raw/a.md"]);
    assert.equal(host.batchCalls.length, 0);
  });

  await withHost(async (host) => {
    host.addFile("raw/a.md", "a");
    host.addFile("raw/b.md", "b");
    host.processedBatchPaths = ["raw/a.md"];
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const paused = await waitForTerminal(initializer);
    assert.equal(paused.status, "initialized");
    assert.equal(paused.extractionCursor, 2);
    assert.deepEqual(paused.pendingSourcePaths, ["raw/b.md"]);
  });
}

async function assertArchiveLinkUpdatesDoNotBlockExtraction(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("entry.md", "See [[notes/project]]");
    host.addFile("notes/project.md", "A short note with nothing to distill.");
    // Obsidian updates incoming links after moving their target. The earlier
    // entry has already passed move verification when this update arrives.
    host.optimizeWikiFolders = async () => {
      host.addFile("raw/imported/entry.md", "See [[project]]");
    };
    const runBatch = host.runMaintenanceBatch.bind(host);
    host.runMaintenanceBatch = async (input) => {
      assert.equal(host.read("raw/imported/entry.md"), "See [[project]]");
      return runBatch(input); // A successful check need not create a Wiki note.
    };
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(completed.extractionCursor, 2);
    assert.equal(host.moveCalls, 2);
    assert.equal(host.batchCalls.length, 1);
    assert.equal(host.read("raw/imported/entry.md"), "See [[project]]");
    assert.deepEqual(completed.extractionSources, preview.extractionSources);
  });
}

async function assertGuideConflictPreservesUserFile(): Promise<void> {
  await withHost(async (host) => {
    host.addFile(KNOWLEDGE_INITIALIZATION_GUIDE_PATH, "# User guide\n");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const blocked = await waitForTerminal(initializer);
    assert.equal(blocked.status, "initialized");
    assert.equal(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), "# User guide\n");
    assert.equal(host.initializedJob?.status, "initialized");
    assert.ok(blocked.warnings?.length);
  }, null);
}

async function assertGuideAssetConflictPreservesUserFile(): Promise<void> {
  await withHost(async (host) => {
    const conflictPath = KNOWLEDGE_INITIALIZATION_GUIDE_ASSET_PATHS[0];
    const userBytes = Uint8Array.from([1, 2, 3, 4]);
    host.addBinary(conflictPath, userBytes);
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const blocked = await waitForTerminal(initializer);
    assert.equal(blocked.status, "initialized");
    assert.deepEqual(host.readBinary(conflictPath), userBytes);
    assert.ok(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH));
    assert.equal(host.initializedJob?.status, "initialized");
    assert.ok(blocked.warnings?.length);
  }, null);
}

async function assertPriorGeneratedGuideIsReusableAfterNewPreview(): Promise<void> {
  await withHost(async (host) => {
    const priorGuide = buildKnowledgeInitializationGuideTemplate(
      new Date("2026-08-20T08:30:00.000Z")
    );
    host.addFile(KNOWLEDGE_INITIALIZATION_GUIDE_PATH, priorGuide);
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), priorGuide);
    assert.equal(host.openedGuide, KNOWLEDGE_INITIALIZATION_GUIDE_PATH);
  }, null);
}

async function assertConflictCancellationAndProviderRecoveryStops(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("notes/conflict.md", "source");
    host.addFile("raw/imported/notes/conflict.md", "user target");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.equal(preview.items[0]?.state, "conflict");
    await initializer.confirm();
    const blocked = await waitForTerminal(initializer);
    assert.equal(blocked.status, "initialized");
    assert.equal(host.read("raw/imported/notes/conflict.md"), "user target");
  });

  await withHost(async (host) => {
    host.addFile("notes/move-before-cancel.md", "preserve moved bytes");
    host.blockBatchUntilAbort = true;
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    await waitUntil(() => host.batchCalls.length === 1);
    const cancelled = await initializer.cancel();
    assert.equal(cancelled?.status, "cancelled");
    await waitForTerminal(initializer);
    assert.equal(host.read("notes/move-before-cancel.md"), null);
    assert.equal(
      host.read("raw/imported/notes/move-before-cancel.md"),
      "preserve moved bytes"
    );
    assert.equal(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH), null);
    assert.equal(host.initializedJob, null);
  });

  for (const [outcome, expectedCalls] of [
    ["failed", 1],
    ["write_uncertain", 1]
  ] as const) {
    await withHost(async (host) => {
      host.addFile("raw/a.md", "a");
      host.batchOutcome = outcome;
      const initializer = new KnowledgeBaseInitializer(host);
      await initializer.initialize();
      await initializer.startPreview("recommended");
      await initializer.confirm();
      const stopped = await waitForTerminal(initializer);
      assert.equal(
        stopped.status,
        outcome === "failed" ? "failed_recoverable" : "write_uncertain"
      );
      assert.equal(host.batchCalls.length, expectedCalls);
      assert.equal(stopped.extractionCursor, 0);
    });
  }
}

async function assertZeroQueuePreservesUserFilesAndSkipsProvider(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("wiki/index.md", "# User index\n\nKeep me.\n");
    host.addFile("LLM-WIKI.md", "# Existing user-authored legacy file\n");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("recommended");
    assert.equal(preview.extractionQueue.length, 0);
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(host.batchCalls.length, 0);
    assert.match(host.read("wiki/index.md") ?? "", /Keep me/u);
    assert.match(host.read("wiki/index.md") ?? "", /echoink-onboarding-kb-init:start/u);
    assert.equal(
      host.read("LLM-WIKI.md"),
      "# Existing user-authored legacy file\n",
      "existing legacy files must remain byte-for-byte untouched"
    );
    assert.ok(host.read(KNOWLEDGE_INITIALIZATION_GUIDE_PATH));
    assert.equal(host.openedGuide, KNOWLEDGE_INITIALIZATION_GUIDE_PATH);
    await waitUntil(() => host.initializedJob?.status === "initialized");
    assert.equal(host.initializedJob?.status, "initialized");
  }, null);
}

async function assertSerialBatchSizes(): Promise<void> {
  for (const [count, expected] of [
    [1, [1]],
    [20, [20]],
    [21, [20, 1]]
  ] as const) {
    await withHost(async (host) => {
      for (let index = 0; index < count; index += 1) {
        host.addFile(`raw/note-${String(index).padStart(2, "0")}.md`, `note ${index}`);
      }
      const initializer = new KnowledgeBaseInitializer(host);
      await initializer.initialize();
      const preview = await initializer.startPreview("recommended");
      assert.equal(preview.extractionQueue.length, count);
      await initializer.confirm();
      const completed = await waitForTerminal(initializer);
      assert.equal(completed.status, "initialized");
      assert.deepEqual(host.batchCalls.map((batch) => batch.length), expected);
      assert.equal(new Set(host.batchConversationIds).size, 1);
    });
  }
}

async function assertVerifiedMoveAcceptsCurrentContent(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("notes/a.md", "original");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    await initializer.confirm();
    const completed = await waitForTerminal(initializer);
    assert.equal(completed.status, "initialized");
    assert.equal(host.read("notes/a.md"), null);
    assert.equal(host.read("raw/imported/notes/a.md"), "original");
  });

  await withHost(async (host) => {
    host.addFile("notes/changed.md", "before");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("recommended");
    host.addFile("notes/changed.md", "after");
    await initializer.confirm();
    const paused = await waitForTerminal(initializer);
    assert.equal(paused.status, "initialized");
    assert.equal(host.read("raw/imported/notes/changed.md"), "after");
  });
}

async function assertRestartPausesWithoutProviderReplay(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("raw/a.md", "a");
    host.blockFolders = true;
    const first = new KnowledgeBaseInitializer(host);
    await first.initialize();
    await first.startPreview("recommended");
    await first.confirm();
    await waitUntil(() => host.folderCreationBlocked);
    const resumed = new KnowledgeBaseInitializer(host);
    await resumed.initialize();
    assert.equal(resumed.snapshot()?.status, "paused");
    assert.equal(host.batchCalls.length, 0);
  });
}

/**
 * assignMany clone-on-write 失败注入回归：
 * 1. persist 前失败（pathExists 注入）：磁盘、缓存、digest、角色不变；
 * 2. plan 写入失败：缓存与磁盘保持完整旧状态，不回传半成功结果；
 * 3. job 写入失败（plan 已写）：plan 被回滚为旧内容，重新读取仍为完整旧状态；
 * 4. 成功时仍只通知一次；
 * 5. 同一 sourcePath 最后一个 assignment 获胜（与基线语义一致）。
 */
async function assertAssignManyCloneOnWriteFailureSemantics(): Promise<void> {
  // 1. persist 前失败：磁盘、缓存、digest、角色全部不变，且不通知。
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    host.addFile("outside/b.md", "beta");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("custom");
    host.failPathExists = true;
    const stateBeforeInvalid = host.stateChangedCalls;
    await assert.rejects(
      initializer.assignMany([
        { sourcePath: "outside/a.md", role: "wiki" },
        { sourcePath: "outside/b.md", role: "projects" }
      ]),
      /injected pathExists failure/u
    );
    const afterFail = initializer.snapshot();
    assert.equal(afterFail?.planDigest, preview.planDigest, "digest unchanged after pre-persist failure");
    assert.deepEqual(
      afterFail?.items.map((item) => item.role),
      ["raw", "raw"],
      "roles unchanged after pre-persist failure"
    );
    assert.equal(host.stateChangedCalls, stateBeforeInvalid, "no notification on pre-persist failure");
  });

  // 2. plan 写入失败：缓存与磁盘保持完整旧状态。
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("custom");
    const diskJobBefore = await readPrivateFile(host, "knowledge/initialization/onboarding-v1/job.json");
    host.failNextPlanPersist = new Error("injected plan write failure");
    await assert.rejects(
      initializer.assignMany([{ sourcePath: "outside/a.md", role: "wiki" }]),
      /injected plan write failure/u
    );
    const cacheAfterPlanFail = initializer.snapshot();
    assert.equal(cacheAfterPlanFail?.items[0]?.role, "raw", "cache keeps old role after plan write failure");
    assert.equal(cacheAfterPlanFail?.planDigest, preview.planDigest);
    assert.equal(
      await readPrivateFile(host, "knowledge/initialization/onboarding-v1/job.json"),
      diskJobBefore,
      "disk job file unchanged after plan write failure"
    );
  });

  // 3. job 写入失败（plan 已写）：plan 回滚为写入前内容；重新读取仍是完整旧状态。
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    const preview = await initializer.startPreview("custom");
    const planRelPath = `knowledge/initialization/onboarding-v1/plans/${preview.jobId}.json`;
    const planBefore = await readPrivateFile(host, planRelPath);
    assert.ok(planBefore !== null, "plan file exists after startPreview");
    const diskJobBefore = await readPrivateFile(host, "knowledge/initialization/onboarding-v1/job.json");
    host.failNextJobPersist = new Error("injected job write failure");
    await assert.rejects(
      initializer.assignMany([{ sourcePath: "outside/a.md", role: "wiki" }]),
      /injected job write failure/u
    );
    assert.equal(
      await readPrivateFile(host, planRelPath),
      planBefore,
      "plan file rolled back to pre-write content after job write failure"
    );
    assert.equal(
      await readPrivateFile(host, "knowledge/initialization/onboarding-v1/job.json"),
      diskJobBefore,
      "job file unchanged after job write failure"
    );
    // 重新读取（新实例）得到的必须是完整旧状态，不能是混合状态。
    const reloaded = new KnowledgeBaseInitializer(host);
    await reloaded.initialize();
    const reloadedJob = reloaded.snapshot();
    assert.equal(reloadedJob?.planDigest, preview.planDigest);
    assert.equal(reloadedJob?.items[0]?.role, "raw");
    assert.equal(reloadedJob?.confirmedDigest, null);
  });

  // 4. 成功时只通知一次；同一 sourcePath 最后一个 assignment 获胜。
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("custom");
    const stateBefore = host.stateChangedCalls;
    const assigned = await initializer.assignMany([
      { sourcePath: "outside/a.md", role: "wiki" },
      { sourcePath: "outside/a.md", role: "projects" }
    ]);
    assert.equal(host.stateChangedCalls, stateBefore + 1, "exactly one notification on success");
    assert.equal(assigned.items[0]?.role, "projects", "last assignment wins for same sourcePath");
  });
}

/** preview 阶段（startPreview + assignMany）绝不移动文件、绝不调用 Provider。 */
async function assertPreviewStageNeverMovesOrCallsProvider(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("outside/a.md", "alpha");
    host.addFile("outside/b.md", "beta");
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize();
    await initializer.startPreview("custom");
    await initializer.assignMany([{ sourcePath: "outside/a.md", role: "wiki" }]);
    assert.equal(host.moveCalls, 0, "preview stage must not move any file");
    assert.equal(host.batchCalls.length, 0, "preview stage must not call Provider");
    assert.equal(host.read("outside/a.md"), "alpha", "source untouched during preview");
  });
}

async function waitForTerminal(
  initializer: KnowledgeBaseInitializer
): Promise<Readonly<KnowledgeInitializationJob>> {
  await waitUntil(() => {
    const status = initializer.snapshot()?.status;
    // Terminal status precedes its final disk write. Keep the temporary host
    // alive until that write and the execution's cleanup have both finished.
    const execution = initializer as unknown as { runFlight: Promise<void> | null };
    return Boolean(status && status !== "active" && status !== "preview" && execution.runFlight === null);
  });
  const snapshot = initializer.snapshot();
  assert.ok(snapshot);
  return snapshot;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("knowledge initialization test timed out");
}

async function withHost(
  run: (host: MemoryKnowledgeInitializationHost) => Promise<void>,
  provider: KnowledgeInitializationProviderSnapshot | null = {
    providerId: "provider-ready",
    model: "model-ready"
  }
): Promise<void> {
  const privateRootPath = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-kb-init-"));
  const host = new MemoryKnowledgeInitializationHost(privateRootPath, provider);
  try {
    await run(host);
  } finally {
    await fsp.rm(privateRootPath, { recursive: true, force: true });
  }
}

class MemoryKnowledgeInitializationHost implements KnowledgeInitializationHost {
  readonly vaultRootPath = "/virtual/vault";
  readonly files = new Map<string, string>();
  readonly binaryFiles = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly batchCalls: string[][] = [];
  readonly batchConversationIds: string[] = [];
  readonly processed = new Set<string>();
  openedGuide = "";
  initializedJob: Readonly<KnowledgeInitializationJob> | null = null;
  processedBatchPaths: string[] | null = null;
  batchOutcome: "completed" | "failed" | "write_uncertain" = "completed";
  blockBatchUntilAbort = false;
  blockFolders = false;
  folderCreationBlocked = false;
  stateChangedCalls = 0;
  moveCalls = 0;
  failPathExists = false;
  /** 下一次 plan 写入注入的错误；触发一次后清空。 */
  failNextPlanPersist: Error | null = null;
  /** 下一次 job 写入注入的错误；触发一次后清空。 */
  failNextJobPersist: Error | null = null;
  private clock = 1_700_000_000_000;

  faultInjectPersist = (stage: "plan" | "job"): Error | null => {
    if (stage === "plan" && this.failNextPlanPersist) {
      const error = this.failNextPlanPersist;
      this.failNextPlanPersist = null;
      return error;
    }
    if (stage === "job" && this.failNextJobPersist) {
      const error = this.failNextJobPersist;
      this.failNextJobPersist = null;
      return error;
    }
    return null;
  };

  constructor(
    readonly privateRootPath: string,
    private provider: KnowledgeInitializationProviderSnapshot | null
  ) {}

  now = (): number => ++this.clock;

  onStateChanged = (): void => {
    this.stateChangedCalls += 1;
  };

  addFile(relativePath: string, content: string): void {
    this.files.set(relativePath, content);
  }

  addBinary(relativePath: string, content: Uint8Array): void {
    this.binaryFiles.set(relativePath, Uint8Array.from(content));
  }

  read(relativePath: string): string | null {
    return this.files.get(relativePath) ?? null;
  }

  readBinary(relativePath: string): Uint8Array | null {
    const content = this.binaryFiles.get(relativePath);
    return content ? Uint8Array.from(content) : null;
  }

  async listVaultFiles(): Promise<readonly KnowledgeInitializationVaultFile[]> {
    const entries = [
      ...[...this.files.entries()].map(([filePath, content]) => ({
        filePath,
        size: Buffer.byteLength(content)
      })),
      ...[...this.binaryFiles.entries()].map(([filePath, content]) => ({
        filePath,
        size: content.byteLength
      }))
    ].sort((left, right) => left.filePath.localeCompare(right.filePath));
    return entries.map(({ filePath, size }) => ({
        path: filePath,
        size,
        mtime: 100,
        extension: path.posix.extname(filePath).slice(1),
        symbolicLink: false
      }));
  }

  async readText(relativePath: string): Promise<string | null> {
    return this.read(relativePath);
  }

  async readFileHash(relativePath: string): Promise<string | null> {
    const content = this.read(relativePath);
    if (content !== null) return hash(content);
    const binary = this.binaryFiles.get(relativePath);
    return binary ? hashBytes(binary) : null;
  }

  async pathExists(relativePath: string): Promise<boolean> {
    if (this.failPathExists) throw new Error("injected pathExists failure");
    return this.files.has(relativePath)
      || this.binaryFiles.has(relativePath)
      || this.folders.has(relativePath);
  }

  async pathKind(relativePath: string): Promise<"missing" | "folder" | "other"> {
    if (this.failPathExists) throw new Error("injected pathKind failure");
    if (this.folders.has(relativePath)) return "folder";
    if (this.files.has(relativePath) || this.binaryFiles.has(relativePath)) return "other";
    return "missing";
  }

  async createFolder(relativePath: string): Promise<void> {
    if (this.blockFolders) {
      this.folderCreationBlocked = true;
      await new Promise<void>(() => {});
    }
    if (
      !relativePath
      || relativePath === "."
      || this.folders.has(relativePath)
      || this.files.has(relativePath)
      || this.binaryFiles.has(relativePath)
    ) {
      throw new Error("Folder already exists.");
    }
    this.folders.add(relativePath);
  }

  async createText(relativePath: string, content: string): Promise<void> {
    if (this.files.has(relativePath) || this.binaryFiles.has(relativePath)) {
      throw new Error("already_exists");
    }
    const parentFolder = knowledgeInitializationParentFolder(relativePath);
    if (parentFolder && !await this.pathExists(parentFolder)) {
      await this.createFolder(parentFolder);
    }
    this.files.set(relativePath, content);
  }

  async createBinary(relativePath: string, content: ArrayBuffer): Promise<void> {
    if (this.files.has(relativePath) || this.binaryFiles.has(relativePath)) {
      throw new Error("already_exists");
    }
    const parentFolder = knowledgeInitializationParentFolder(relativePath);
    if (parentFolder && !await this.pathExists(parentFolder)) {
      await this.createFolder(parentFolder);
    }
    this.binaryFiles.set(relativePath, Uint8Array.from(new Uint8Array(content)));
  }

  async updateText(relativePath: string, expectedContentHash: string, content: string): Promise<void> {
    const current = this.files.get(relativePath);
    if (current === undefined || hash(current) !== expectedContentHash) throw new Error("version_conflict");
    this.files.set(relativePath, content);
  }

  async moveFile(sourcePath: string, targetPath: string, expectedContentHash: string): Promise<void> {
    this.moveCalls += 1;
    const source = this.files.get(sourcePath);
    if (source === undefined) throw new Error("source_missing");
    if (this.files.has(targetPath)) throw new Error("already_exists");
    this.files.delete(sourcePath);
    this.files.set(targetPath, source);
  }

  currentProvider(): KnowledgeInitializationProviderSnapshot | null {
    return this.provider;
  }

  setProvider(provider: KnowledgeInitializationProviderSnapshot | null): void {
    this.provider = provider;
  }

  processedRawPaths(): ReadonlySet<string> {
    return this.processed;
  }

  async ensureInitializationConversation(existingConversationId: string | null): Promise<string> {
    return existingConversationId ?? "knowledge-initialization-conversation";
  }

  async runMaintenanceBatch(input: Readonly<{
    conversationId: string;
    sourcePaths: readonly string[];
    signal: AbortSignal;
  }>): Promise<Readonly<KnowledgeInitializationBatchResult>> {
    this.batchCalls.push([...input.sourcePaths]);
    this.batchConversationIds.push(input.conversationId);
    if (this.blockBatchUntilAbort) {
      return await new Promise((resolve) => {
        input.signal.addEventListener("abort", () => resolve({
          status: "cancelled",
          productRunId: `run-${this.batchCalls.length}`
        }), { once: true });
      });
    }
    if (this.batchOutcome !== "completed") {
      return {
        status: this.batchOutcome,
        productRunId: `run-${this.batchCalls.length}`,
        message: `fixture-${this.batchOutcome}`
      };
    }
    return {
      status: "completed",
      productRunId: `run-${this.batchCalls.length}`,
      processedSourcePaths: this.processedBatchPaths ?? [...input.sourcePaths]
    };
  }

  async openGuide(relativePath: string): Promise<void> {
    this.openedGuide = relativePath;
  }

  async markInitialized(job: Readonly<KnowledgeInitializationJob>): Promise<void> {
    this.initializedJob = structuredClone(job);
  }
}

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function hashBytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function buildLegacyGuideFixture(created: string): string {
  return [
    "---", `created: ${created}`, "type: echoink-knowledge-guide", "---", "",
    "# 开始使用 EchoInk 知识库", "",
    "EchoInk 使用十个固定顶层目录：`raw`、`wiki`、`projects`、`outputs`、`inbox`、`journal`、`work`、`archive`、`templates`、`assets`。",
    "", "## 核心流程", "",
    "1. 把未经提炼的 Markdown 放在 `raw/`。",
    "2. 在普通 EchoInk 会话中使用 `/maintain`，让 Agent 提炼并安全写入 `wiki/` 或 `projects/`。",
    "3. 使用 `/ask` 从 Wiki、Projects 与 Raw 中检索和回答。",
    "4. 新增资料后，在设置页点击“整理新增笔记”进行增量维护。", "",
    "> 非 Markdown 文件和附件保持原位；EchoInk 不会覆盖或删除你的既有笔记。", ""
  ].join("\n");
}

/** 从 host 的 privateRootPath（真实临时磁盘）读取私有文件。 */
async function readPrivateFile(
  host: MemoryKnowledgeInitializationHost,
  relativePath: string
): Promise<string | null> {
  try {
    return await fsp.readFile(path.join(host.privateRootPath, relativePath), "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function assertDirectorySnapshotAndNamingCancellation(): Promise<void> {
  await withHost(async (host) => {
    host.addFile("Note.md", "body");
    (host as KnowledgeInitializationHost).beforeStructureChange = async () => { throw new Error("directory index unavailable"); };
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize(); await initializer.startPreview(); await initializer.confirm();
    const failed = await waitForTerminal(initializer);
    assert.equal(failed.status, "initialized");
    assert.equal(failed.pendingMoves, true);
    assert.match(failed.warnings?.join("\n") ?? "", /directory index unavailable/);
    assert.equal(host.folders.size, 0, "failed original index must precede all folder creation");
    assert.equal(host.moveCalls, 0);
  });
  await withHost(async (host) => {
    let release: (() => void) | undefined;
    let entered = false;
    let renamed = false;
    (host as KnowledgeInitializationHost).optimizeWikiFolders = async (assertActive) => {
      entered = true;
      await new Promise<void>((resolve) => { release = resolve; });
      assertActive(); renamed = true;
    };
    const initializer = new KnowledgeBaseInitializer(host);
    await initializer.initialize(); await initializer.startPreview(); await initializer.confirm();
    await waitUntil(() => entered);
    await initializer.cancel(); release?.();
    await waitUntil(() => !initializer.isRunning);
    assert.equal(renamed, false, "cancel during naming must prevent later structural writes");
  });
}
