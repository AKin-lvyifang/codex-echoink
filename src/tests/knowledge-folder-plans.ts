import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { emptyKnowledgeFolderBindings, knowledgeFolderBindingsSignature, knowledgeMaintenanceFolderIssues, normalizeKnowledgeFolderBindings, rebaseKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { nativeJournalFixture } from "./native-journal-fixture";
import CodexForObsidianPlugin from "../main";
import { echoInkKnowledgeMaintenanceProtocolPrompt } from "../knowledge-base/knowledge-maintenance-protocol";
import { knowledgeMayCreateCategoryDirectory } from "../knowledge-base/folder-organization";

function buildBindings() {
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["资料/原文"], writePath: "资料/原文" });
  Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["资料/知识"], writePath: "资料/知识" });
  return bindings;
}

export async function runKnowledgeFolderPlanTests(): Promise<void> {
  const legacy = buildBindings();
  delete legacy.roles.raw.autoOrganizePaths;
  const normalized = normalizeKnowledgeFolderBindings(legacy)!;
  assert.deepEqual(normalized.roles.raw.autoOrganizePaths, [], "legacy settings do not grant ongoing organization");
  legacy.roles.raw.autoOrganizePaths = ["资料/原文", "旧位置"];
  assert.deepEqual(normalizeKnowledgeFolderBindings(legacy)!.roles.raw.autoOrganizePaths, ["资料/原文"]);
  const rebased = rebaseKnowledgeFolderBindings(normalized, "资料", "个人资料");
  normalized.roles.raw.autoOrganizePaths = ["资料/原文"];
  assert.deepEqual(rebaseKnowledgeFolderBindings(normalized, "资料", "个人资料").roles.raw.autoOrganizePaths, ["个人资料/原文"]);
  assert.equal(rebased.roles.raw.readPaths[0], "个人资料/原文");
  const disabled = structuredClone(normalized);
  disabled.roles.raw.enabled = false;
  assert(knowledgeMaintenanceFolderIssues(disabled, normalized).some(issue => issue.includes("来源")));
  assert.deepEqual(knowledgeMaintenanceFolderIssues(disabled, emptyKnowledgeFolderBindings()), [], "old incomplete configurations stay repairable");
  assert(knowledgeMaintenanceFolderIssues(emptyKnowledgeFolderBindings(), null, true).length === 2);
  assert.equal(knowledgeFolderBindingsSignature(buildBindings()), knowledgeFolderBindingsSignature(normalizeKnowledgeFolderBindings(buildBindings())), "legacy absent defaults and normalized settings compare consistently");
  const promptPlugin = Object.create(CodexForObsidianPlugin.prototype) as CodexForObsidianPlugin;
  const promptBindings = buildBindings(); promptBindings.roles.wiki.autoOrganizePaths = ["资料/知识"];
  Object.assign(promptPlugin, { settings: { knowledgeBase: { folderBindings: promptBindings } } });
  const prompt = await promptPlugin.prepareWikiFolderNamesForMaintenance({ initialization: false, assertActive() {} });
  assert.match(prompt, /允许 Agent 自动整理的实际目录：\["资料\/知识"\]/u);
  assert(!prompt.includes("不创建分类树"), "the production maintenance command does not contradict saved consent");
  assert(echoInkKnowledgeMaintenanceProtocolPrompt(promptBindings).includes('允许 Agent 自动整理的实际目录：["资料/知识"]'));

  const baseline = emptyKnowledgeFolderBindings();
  Object.assign(baseline.roles.raw, { enabled: true, readPaths: ["旧来源"], writePath: "旧来源" });
  const pure = await previewKnowledgeDirectoryPlan({ baseRevision: 1, baseline, bindings: buildBindings(), createPaths: ["资料/原文", "资料/知识"], mode: "build",
    kind: async relative => ["旧来源", "资料"].includes(relative) ? "folder" : "missing",
    sourcePaths: ["旧来源/原笔记.md", "课程/材料.md"], files: ["旧来源/原笔记.md", "课程/材料.md", "课程/图片.png", "private/state.json", "config/core.json"].map(relative => ({ path: relative, size: 3, mtime: 1 })), protectedPaths: ["private", "config"] });
  assert.deepEqual(pure.issues, []);
  assert(pure.moves.some(move => move.from === "旧来源/原笔记.md"), "a previous Raw is moved into the replacement Raw during first build");
  assert(pure.moves.some(move => move.from === "课程/图片.png"), "source attachments move with their hierarchy");
  assert.equal(pure.moves.length, 3);
  assert(pure.create.includes("资料/原文/课程"));
  assert.deepEqual(pure.sources, ["资料/原文/旧来源/原笔记.md", "资料/原文/课程/材料.md"].sort());

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "echoink-folder-plan-v2-")));
  try {
    await assertPlanApplication(path.join(root, "success"));
    await assertStaleAndConflicts(path.join(root, "stale"));
    await assertFailedMoveRecovery(path.join(root, "rollback"));
    await assertFailedSaveRecovery(path.join(root, "save-failure"));
    await assertRestoreKeepsNewContent(path.join(root, "restore-retained"));
    await assertRenamedLegacyConsentRestores(path.join(root, "restore-legacy"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log("Knowledge directory plans, relocation and recovery: PASS");
}

async function fixtureAt(root: string) {
  const fixture = await nativeJournalFixture(root);
  fixture.plugin.settings.defaultPermission = "workspace-write";
  fixture.plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  const release = registerKnowledgeFolderBindings(root, () => fixture.plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, "private-state"));
  const service = new EchoInkKnowledgeSurfaceService(fixture.plugin);
  await service.getInitializationState();
  return { ...fixture, release, service };
}

async function assertPlanApplication(root: string) {
  const fixture = await fixtureAt(root);
  try {
    const { plugin, app, service, write } = fixture;
    await write("课程/a.md", "# A\n");
    await write("课程/b.md", "# B\n[[课程/a.md]]\n");
    await write("课程/a.png", "image bytes");
    await write("private-state/runtime.json", "PRIVATE");
    await write("custom-config/plugins/example/state.json", "CONFIG");
    await write("产物/英文日记.md", "DIARY");
    await write("既有项目/result.md", "PROJECT");
    await write("EchoInk/待办.md", "TODO");
    await write("financial/ledger.base", 'properties:\n  note.echoink_id:\n    displayName: ID\n');
    await write("financial/transactions/row.md", "FINANCE");
    (app.vault as any).configDir = "custom-config";
    plugin.settings.englishDiary.englishDirectory = "产物";
    Object.assign(plugin.settings.knowledgeBase.folderBindings.roles.projects, { enabled: true, readPaths: ["既有项目"], writePath: "既有项目" });
    const binds = buildBindings();
    const calls: { from: string; to: string }[] = [];
    const renameFile = app.fileManager.renameFile.bind(app.fileManager);
    app.fileManager.renameFile = async (file, target) => {
      const from = file.path;
      await renameFile(file, target);
      calls.push({ from, to: target });
      // Emulate the native API updating a resolved link in another pending note.
      if (from === "课程/a.md") {
        await fs.writeFile(path.join(root, "课程/b.md"), "# B\n[[资料/原文/课程/a.md]]\n");
      }
    };
    const plan = await service.previewDirectoryPlan(binds, ["资料/原文", "资料/知识"], { mode: "build" });
    assert.deepEqual(plan.issues, []);
    assert.deepEqual(plan.moves.map(move => move.from), ["课程/a.md", "课程/a.png", "课程/b.md"]);
    assert(plan.excluded.some(item => item.path === "private-state/runtime.json"));
    const result = await service.applyDirectoryPlan(plan, true);
    assert.equal(result.configured, true);
    assert.equal(result.refinement, "not-started", "missing Provider cannot block configuring or relocation");
    assert.match(result.refinementError!, /提炼尚未开始/u);
    assert.equal(fixture.providerCalls(), 0);
    assert.deepEqual(calls, plan.moves.map(move => ({ from: move.from, to: move.to })), "every reviewed file goes through Obsidian renameFile");
    assert.equal(await fs.readFile(path.join(root, "资料/原文/课程/b.md"), "utf8"), "# B\n[[资料/原文/课程/a.md]]\n", "link changes caused by this batch do not falsely stale the next move");
    for (const [relative, content] of [["private-state/runtime.json", "PRIVATE"], ["custom-config/plugins/example/state.json", "CONFIG"], ["产物/英文日记.md", "DIARY"], ["既有项目/result.md", "PROJECT"], ["EchoInk/待办.md", "TODO"], ["financial/transactions/row.md", "FINANCE"]]) assert.equal(await fs.readFile(path.join(root, relative), "utf8"), content);
    assert.deepEqual(plugin.settings.knowledgeBase.folderBindings.roles.raw.autoOrganizePaths, []);
    const existing = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    existing.roles.raw.autoOrganizePaths = [existing.roles.raw.writePath!];
    const edit = await service.previewDirectoryPlan(existing, []);
    assert.deepEqual(edit.moves, [], "rebinding or permissions never trigger implicit relocation");
    await service.applyDirectoryPlan(edit);
    assert.deepEqual(plugin.settings.knowledgeBase.folderBindings.roles.raw.autoOrganizePaths, ["资料/原文"]);
    assert.equal((await service.getOriginalDirectoryStatus())!.files > 0, true, "original positions are durably recorded");
    await service.restoreOriginalDirectories();
    assert.equal(await fs.readFile(path.join(root, "课程/a.md"), "utf8"), "# A\n");
    assert.equal(plugin.settings.knowledgeBase.folderBindings.roles.raw.enabled, false, "restoration also restores setup bindings, even when only organization consent changed later");
    assert.equal(plugin.settings.knowledgeBase.folderBindings.roles.projects.writePath, "既有项目");
    assert.equal(await fs.stat(path.join(root, "资料/原文")).catch(() => null), null);
  } finally { fixture.release(); }
}

async function assertStaleAndConflicts(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("notes/source.md", "before");
    const build = () => fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    let plan = await build();
    await fs.writeFile(path.join(root, "notes/source.md"), "changed since preview");
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /重新预览/u);
    assert.equal(await fs.stat(path.join(root, "资料")).catch(() => null), null, "stale plans fail before creating anything");
    plan = await build();
    await fixture.write("资料/原文/notes/source.md", "occupied");
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /重新预览/u);
    assert.equal(await fs.readFile(path.join(root, "资料/原文/notes/source.md"), "utf8"), "occupied");
    const conflicted = await build();
    assert(conflicted.issues.some(issue => issue.includes("不会覆盖")));
    await fs.rm(path.join(root, "资料"), { recursive: true });
    plan = await build();
    fixture.plugin.settings.knowledgeBase.folderBindings.roles.inbox.enabled = true;
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /配置已改变/u);
    fixture.plugin.settings.knowledgeBase.folderBindings.roles.inbox.enabled = false;
    (fixture.app.vault as any).setConfig("alwaysUpdateLinks", false);
    await assert.rejects(fixture.service.applyDirectoryPlan(await build()), /自动更新内部链接/u);
  } finally { fixture.release(); }
}

async function assertFailedMoveRecovery(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("旧来源/a.md", "A"); await fixture.write("旧来源/b.md", "B");
    Object.assign(fixture.plugin.settings.knowledgeBase.folderBindings.roles.raw, { enabled: true, readPaths: ["旧来源"], writePath: "旧来源" });
    await fixture.write("outputs/.ingest-tracker.md", "# Tracker\n- `旧来源/a.md`\n");
    const renameFile = fixture.app.fileManager.renameFile.bind(fixture.app.fileManager);
    fixture.app.fileManager.renameFile = async (file, target) => {
      if (file.path === "旧来源/b.md") throw new Error("fixture move failed");
      await renameFile(file, target);
    };
    const before = knowledgeFolderBindingsSignature(fixture.plugin.settings.knowledgeBase.folderBindings);
    const plan = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /已恢复本次搬迁的 1 个文件/u);
    assert.equal(await fs.readFile(path.join(root, "旧来源/a.md"), "utf8"), "A");
    assert.equal(await fs.readFile(path.join(root, "旧来源/b.md"), "utf8"), "B");
    assert.equal(await fs.readFile(path.join(root, "outputs/.ingest-tracker.md"), "utf8"), "# Tracker\n- `旧来源/a.md`\n", "rollback restores legacy source references as well as positions");
    assert.equal(knowledgeFolderBindingsSignature(fixture.plugin.settings.knowledgeBase.folderBindings), before);
    assert.equal(await fixture.service.getInitializationState(), null, "failure never marks sources processed or starts extraction");
    assert.equal(await fs.stat(path.join(root, "资料")).catch(() => null), null);
    fixture.app.fileManager.renameFile = renameFile;
    const retried = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    await fixture.service.applyDirectoryPlan(retried);
    assert.equal(await fs.readFile(path.join(root, "资料/原文/旧来源/b.md"), "utf8"), "B");
  } finally { fixture.release(); }
}

async function assertRestoreKeepsNewContent(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("旧来源/source.md", "ORIGINAL");
    Object.assign(fixture.plugin.settings.knowledgeBase.folderBindings.roles.raw, { enabled: true, readPaths: ["旧来源"], writePath: "旧来源" });
    const plan = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    await fixture.service.applyDirectoryPlan(plan);
    await fixture.write("资料/原文/new.md", "NEW");
    await fixture.write("后来收件箱/keep.md", "INBOX");
    const edited = structuredClone(fixture.plugin.settings.knowledgeBase.folderBindings);
    Object.assign(edited.roles.inbox, { enabled: true, readPaths: ["后来收件箱"], writePath: "后来收件箱" });
    edited.roles.raw.autoOrganizePaths = ["资料/原文"];
    await fixture.service.applyDirectoryPlan(await fixture.service.previewDirectoryPlan(edited, []));
    await fixture.service.restoreOriginalDirectories();
    const restored = fixture.plugin.settings.knowledgeBase.folderBindings;
    assert.equal(await fs.readFile(path.join(root, "旧来源/source.md"), "utf8"), "ORIGINAL");
    assert.equal(await fs.readFile(path.join(root, "资料/原文/new.md"), "utf8"), "NEW");
    assert.deepEqual(restored.roles.raw.readPaths, ["旧来源", "资料/原文"], "new files retain their current source binding alongside the restored original");
    assert.deepEqual(restored.roles.raw.autoOrganizePaths, ["资料/原文"], "consent stays attached to its actual retained path");
    assert.equal(restored.roles.inbox.writePath, "后来收件箱", "later independent binding changes are preserved");
    assert.equal(restored.roles.wiki.enabled, false);
  } finally { fixture.release(); }
}

async function assertRenamedLegacyConsentRestores(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("知识/original.md", "ORIGINAL");
    Object.assign(fixture.plugin.settings.knowledgeBase.folderBindings.roles.wiki, { enabled: true, readPaths: ["知识"], writePath: "知识", allowedSubdirectories: ["旧分类"], allowedSubdirectoryRoots: ["知识"], autoOrganizePaths: [] });
    await (fixture.service as any).directoryHistory.capture("legacy-consent-restore");
    await (fixture.service as any).renameTracked("知识", "知识（knowledge）");
    await fixture.write("知识（knowledge）/new.md", "NEW");
    await fixture.service.restoreOriginalDirectories();
    const config = fixture.plugin.settings.knowledgeBase.folderBindings;
    assert.deepEqual(config.roles.wiki.readPaths, ["知识", "知识（knowledge）"]);
    assert(knowledgeMayCreateCategoryDirectory(config, "知识/旧分类"), "old child consent follows restored root");
    assert(knowledgeMayCreateCategoryDirectory(config, "知识（knowledge）/旧分类"), "retained new content keeps the same lineage consent");
    assert.equal(await fs.readFile(path.join(root, "知识/original.md"), "utf8"), "ORIGINAL");
    assert.equal(await fs.readFile(path.join(root, "知识（knowledge）/new.md"), "utf8"), "NEW");
  } finally { fixture.release(); }
}

async function assertFailedSaveRecovery(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("source.md", "SAVED CONTENT");
    let failed = false;
    fixture.plugin.saveSettings = async () => {
      if (!failed && fixture.plugin.settings.knowledgeBase.folderBindings.roles.wiki.enabled) { failed = true; throw new Error("settings disk unavailable"); }
    };
    const plan = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /settings disk unavailable/u);
    assert.equal(await fs.readFile(path.join(root, "source.md"), "utf8"), "SAVED CONTENT");
    assert.equal(fixture.plugin.settings.knowledgeBase.folderBindings.roles.wiki.enabled, false);
  } finally { fixture.release(); }
}
