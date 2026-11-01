import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TFolder } from "obsidian";
import { classifyKnowledgePath, emptyKnowledgeFolderBindings, knowledgeFolderBindingsSignature, knowledgeMaintenanceFolderIssues, normalizeKnowledgeFolderBindings, rebaseKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan } from "../knowledge-base/folder-plan";
import { initializationFolderIssues } from "../knowledge-base/initialization-choices";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { InitializationDirectoryHistory } from "../knowledge-base/initialization-directory-history";
import { nativeJournalFixture } from "./native-journal-fixture";
import CodexForObsidianPlugin from "../main";
import { echoInkKnowledgeMaintenanceProtocolPrompt } from "../knowledge-base/knowledge-maintenance-protocol";
import { knowledgeMayCreateCategoryDirectory, knowledgeMayOrganizeMove, knowledgeOrganizationBinding } from "../knowledge-base/folder-organization";

function buildBindings() {
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["资料/原文"], writePath: "资料/原文" });
  Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["资料/知识"], writePath: "资料/知识" });
  return bindings;
}

export async function runKnowledgeFolderPlanTests(): Promise<void> {
  const issues = initializationFolderIssues([
    { key: "raw", title: "资料来源", values: [{ path: "Library", create: false }, { path: "Archive", create: false }] },
    { key: "wiki", title: "知识成果", values: [{ path: "library", create: true }] },
    { key: "projects", title: "项目", values: [{ path: "", create: true }] }
  ], ["Library", "Archive"]);
  assert.match(issues.get("raw")!.join(), /重名/u);
  assert.match(issues.get("wiki")!.join(), /重名/u);
  assert.match(issues.get("projects")!.join(), /请输入新文件夹名/u);
  assert.equal(initializationFolderIssues([{ key: "raw", title: "资料来源", values: [{ path: "Archive/sub", create: true }] }], ["Archive"]).size, 0);
  const legacy = buildBindings();
  delete legacy.roles.raw.autoOrganizePaths;
  const normalized = normalizeKnowledgeFolderBindings(legacy)!;
  const nestedWiki = await previewKnowledgeDirectoryPlan({ baseRevision: normalized.revision, bindings: normalized, baseline: normalized,
    createPaths: [], sourcePaths: [], wikiChanged: true, kind: async () => "folder" });
  assert.deepEqual(nestedWiki.issues, [], "a single nested knowledge folder is selectable during initialization");
  assert.deepEqual(normalized.organization, { enabled: true, scope: "all", paths: [] }, "legacy settings adopt unified default");
  legacy.roles.raw.autoOrganizePaths = ["资料/原文", "旧位置"];
  assert.equal(normalizeKnowledgeFolderBindings(legacy)!.roles.raw.autoOrganizePaths, undefined);
  const rebased = rebaseKnowledgeFolderBindings(normalized, "资料", "个人资料");
  normalized.organization = { enabled: true, scope: "selected", paths: ["资料/原文"] };
  assert.deepEqual(rebaseKnowledgeFolderBindings(normalized, "资料", "个人资料").organization?.paths, ["个人资料/原文"]);
  assert.equal(rebased.roles.raw.readPaths[0], "个人资料/原文");
  const disabled = structuredClone(normalized);
  disabled.roles.raw.enabled = false;
  assert(knowledgeMaintenanceFolderIssues(disabled, normalized).some(issue => issue.includes("来源")));
  assert.deepEqual(knowledgeMaintenanceFolderIssues(disabled, emptyKnowledgeFolderBindings()), [], "old incomplete configurations stay repairable");
  assert(knowledgeMaintenanceFolderIssues(emptyKnowledgeFolderBindings(), null, true).length === 2);
  assert.equal(knowledgeFolderBindingsSignature(buildBindings()), knowledgeFolderBindingsSignature(normalizeKnowledgeFolderBindings(buildBindings())), "legacy absent defaults and normalized settings compare consistently");
  const promptPlugin = Object.create(CodexForObsidianPlugin.prototype) as CodexForObsidianPlugin;
  const promptBindings = buildBindings();
  Object.assign(promptPlugin, { settings: { knowledgeBase: { folderBindings: promptBindings } } });
  const prompt = await promptPlugin.prepareWikiFolderNamesForMaintenance({ initialization: false, assertActive() {} });
  assert.match(prompt, /Agent 分类整理：开启/u);
  assert(!prompt.includes("不创建分类树"), "the production maintenance command does not contradict saved consent");
  assert(echoInkKnowledgeMaintenanceProtocolPrompt(promptBindings).includes("全部已绑定根文件夹"));
  for (const [role, directory] of [["work", "旧工作"], ["archive", "旧存档"], ["projects", "项目/研究"]] as const) {
    Object.assign(promptBindings.roles[role], { enabled: true, readPaths: [directory], writePath: directory, autoOrganizePaths: [directory] });
  }
  const desktopPrompt = echoInkKnowledgeMaintenanceProtocolPrompt(promptBindings, DESKTOP_KNOWLEDGE_ROOT_ROLES);
  assert(!desktopPrompt.includes('"work"') && !desktopPrompt.includes('"archive"') && !desktopPrompt.includes("旧工作") && !desktopPrompt.includes("旧存档"));
  assert(desktopPrompt.includes("项目/研究"));
  assert(echoInkKnowledgeMaintenanceProtocolPrompt(promptBindings).includes("旧工作"), "shared protocol default retains mobile-compatible role data");
  assert(!knowledgeMayCreateCategoryDirectory(promptBindings, "旧工作/新分类"));
  assert(!knowledgeMayOrganizeMove(promptBindings, "旧存档/a.md", "旧存档/新分类/a.md"));
  assert(knowledgeMayCreateCategoryDirectory(promptBindings, "项目/研究/新分类"));
  assert(knowledgeMayOrganizeMove(promptBindings, "项目/研究/a.md", "项目/研究/新分类/a.md"));
  for (const parentRole of ["wiki", "projects"] as const) for (const retiredRole of ["work", "archive"] as const) {
    const nested = emptyKnowledgeFolderBindings();
    const parent = parentRole === "wiki" ? "Knowledge" : "Projects";
    const retired = `${parent}/${retiredRole === "archive" ? "Archive" : "Work"}`;
    Object.assign(nested.roles[parentRole], { enabled: true, readPaths: [parent], writePath: parent, autoOrganizePaths: [parent] });
    Object.assign(nested.roles[retiredRole], { enabled: true, readPaths: [retired], writePath: retired, autoOrganizePaths: [] });
    nested.allowAgentSubfolders = true;
    assert.equal(classifyKnowledgePath(nested, `${retired}/a.md`, DESKTOP_KNOWLEDGE_ROOT_ROLES), null);
    assert.deepEqual({
      owner: knowledgeOrganizationBinding(nested, `${retired}/a.md`)?.role ?? null,
      create: knowledgeMayCreateCategoryDirectory(nested, `${retired}/new`),
      move: knowledgeMayOrganizeMove(nested, `${retired}/a.md`, `${retired}/b.md`)
    }, { owner: null, create: false, move: false }, `${retiredRole} nested in ${parentRole} cannot inherit ancestor organization authority`);
    assert(knowledgeMayCreateCategoryDirectory(nested, `${parent}/Current/new`));
    assert(knowledgeMayOrganizeMove(nested, `${parent}/Current/a.md`, `${parent}/Current/b.md`));
  }
  const desktopPlan = await previewKnowledgeDirectoryPlan({ baseRevision: 1, baseline: promptBindings, bindings: buildBindings(), roleScope: DESKTOP_KNOWLEDGE_ROOT_ROLES,
    createPaths: ["旧工作", "旧存档"], sourcePaths: [], kind: async () => "folder" });
  assert.deepEqual(desktopPlan.bindings.roles.work, promptBindings.roles.work, "desktop plans preserve compatibility fields absent from the draft");
  assert.deepEqual(desktopPlan.bindings.roles.archive, promptBindings.roles.archive);
  assert(!desktopPlan.changes.some(change => change.role === "work" || change.role === "archive"));
  assert(!desktopPlan.reuse.includes("旧工作") && !desktopPlan.reuse.includes("旧存档"));

  const baseline = emptyKnowledgeFolderBindings();
  Object.assign(baseline.roles.raw, { enabled: true, readPaths: ["旧来源"], writePath: "旧来源" });
  const selected = buildBindings();
  selected.roles.raw.readPaths.push("课程");
  selected.roles.wiki.allowedSubdirectories = ["默认分类"];
  const pure = await previewKnowledgeDirectoryPlan({ baseRevision: 1, baseline, bindings: selected, createPaths: ["资料/原文", "资料/知识"], mode: "build",
    kind: async relative => ["旧来源", "资料", "课程"].includes(relative) ? "folder" : "missing",
    sourcePaths: ["旧来源/原笔记.md", "课程/材料.md"], files: ["旧来源/原笔记.md", "课程/材料.md", "课程/图片.png", "private/state.json", "config/core.json"].map(relative => ({ path: relative, size: 3, mtime: 1 })), protectedPaths: ["private", "config"] });
  assert.deepEqual(pure.issues, []);
  assert.deepEqual(pure.moves, [], "building folders never relocates selected or unselected materials");
  assert.deepEqual(pure.create, ["资料/原文", "资料/知识"], "saved category permissions do not implicitly create folders");
  assert.deepEqual(pure.bindings.roles.wiki.allowedSubdirectories, ["默认分类"], "preview preserves legacy metadata without implicitly creating folders");
  assert.deepEqual(pure.sources, ["课程/材料.md"], "selected source folders are consumed in place; unselected old sources are omitted");
  const category = await previewKnowledgeDirectoryPlan({ baseRevision: 1, baseline: selected, bindings: selected, createPaths: ["资料/知识/默认分类"], sourcePaths: [], mode: "build",
    kind: async relative => relative === "资料/知识/默认分类" ? "missing" : "folder" });
  assert.deepEqual(category.create, ["资料/知识/默认分类"], "an explicit category creation still works");

  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.ECHOINK_MODULES_TEST_ROOT ?? os.tmpdir(), "echoink-folder-plan-v2-")));
  try {
    await assertPlanApplication(path.join(root, "success"));
    await assertRestoreNativeEmptyDirectoryCleanup(path.join(root, "restore-native-api"));
    await assertStaleAndConflicts(path.join(root, "stale"));
    await assertFailedCreateRecovery(path.join(root, "rollback"));
    await assertFailedSaveRecovery(path.join(root, "save-failure"));
    await assertRestoreKeepsNewContent(path.join(root, "restore-retained"));
    await assertRenamedLegacyConsentRestores(path.join(root, "restore-legacy"));
    await assertRootNativeJournalProtection(path.join(root, "native-root"));
    await assertRetiredBindingsSurviveDesktopEdits(path.join(root, "retired-roles"));
    await assertInitializationModuleRegression(path.join(root, "module-regression"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log("Knowledge directory plans, in-place sources and recovery: PASS");
}

async function assertRetiredBindingsSurviveDesktopEdits(root: string): Promise<void> {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("原工作/keep.md", "WORK"); await fixture.write("原存档/keep.md", "ARCHIVE");
    const saved = fixture.plugin.settings.knowledgeBase.folderBindings;
    Object.assign(saved.roles.work, { enabled: true, readPaths: ["原工作"], writePath: null, autoOrganizePaths: ["原工作"], allowedSubdirectories: ["旧分类"] });
    Object.assign(saved.roles.archive, { enabled: true, readPaths: ["原存档", "暂缺存档"], writePath: null, autoOrganizePaths: ["原存档"], compatibilityReadScopes: true });
    const retired = structuredClone({ work: saved.roles.work, archive: saved.roles.archive });
    const before = knowledgeFolderBindingsSignature(saved);
    const plan = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    assert.deepEqual(plan.issues, [], "missing retired roots do not block a current desktop plan");
    assert.deepEqual(plan.moves, [], "existing retired files remain in place");
    assert.equal(knowledgeFolderBindingsSignature(fixture.plugin.settings.knowledgeBase.folderBindings), before, "preview cannot save bindings");
    assert.equal(await fs.stat(path.join(root, "资料")).catch(() => null), null, "preview cannot create planned roots");
    assert.deepEqual(fixture.service.folderNameScopes(), [], "retired roots are absent from desktop naming scopes");
    await fixture.service.applyDirectoryPlan(plan);
    assert.deepEqual({ work: fixture.plugin.settings.knowledgeBase.folderBindings.roles.work, archive: fixture.plugin.settings.knowledgeBase.folderBindings.roles.archive }, retired);
    await fixture.service.saveDirectoryBindings({ ...emptyKnowledgeFolderBindings(), revision: fixture.plugin.settings.knowledgeBase.folderBindings.revision });
    assert.deepEqual({ work: fixture.plugin.settings.knowledgeBase.folderBindings.roles.work, archive: fixture.plugin.settings.knowledgeBase.folderBindings.roles.archive }, retired, "immediate desktop saves retain untouched mobile fields");
    assert.equal(await fs.readFile(path.join(root, "原工作/keep.md"), "utf8"), "WORK");
    assert.equal(await fs.readFile(path.join(root, "原存档/keep.md"), "utf8"), "ARCHIVE");
  } finally { fixture.release(); }
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
    app.fileManager.renameFile = async (file, target) => { calls.push({ from: file.path, to: target }); throw new Error("initialization must not rename files"); };
    const plan = await service.previewDirectoryPlan(binds, ["资料/原文", "资料/知识"], { mode: "build" });
    assert.deepEqual(plan.issues, []);
    assert.deepEqual(plan.moves, []);
    assert(plan.excluded.some(item => item.path === "private-state/runtime.json"));
    const result = await service.applyDirectoryPlan(plan, true);
    assert.equal(plugin.settings.knowledgeBase.initialized, true, "successful setup persists the homepage reminder completion marker");
    assert.equal(result.configured, true);
    assert.equal(result.refinement, "not-started", "missing Provider cannot block directory setup");
    assert.equal(result.refinementError, undefined, "unselected loose materials do not start extraction");
    assert.equal(fixture.providerCalls(), 0);
    assert.deepEqual(calls, [], "setup does not invoke the file-moving API");
    assert.equal(await fs.readFile(path.join(root, "课程/b.md"), "utf8"), "# B\n[[课程/a.md]]\n", "source links and locations stay unchanged");
    assert.equal(await fs.readFile(path.join(root, "课程/a.png"), "utf8"), "image bytes");
    for (const [relative, content] of [["private-state/runtime.json", "PRIVATE"], ["custom-config/plugins/example/state.json", "CONFIG"], ["产物/英文日记.md", "DIARY"], ["既有项目/result.md", "PROJECT"], ["EchoInk/待办.md", "TODO"], ["financial/transactions/row.md", "FINANCE"]]) assert.equal(await fs.readFile(path.join(root, relative), "utf8"), content);
    assert.equal(plugin.settings.knowledgeBase.folderBindings.roles.raw.autoOrganizePaths, undefined);
    const existing = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    existing.organization = { enabled: true, scope: "selected", paths: [existing.roles.raw.writePath!] };
    const edit = await service.previewDirectoryPlan(existing, []);
    assert.deepEqual(edit.moves, [], "rebinding or permissions never trigger implicit relocation");
    await service.applyDirectoryPlan(edit);
    assert.deepEqual(plugin.settings.knowledgeBase.folderBindings.organization?.paths, ["资料/原文"]);
    assert((await service.getOriginalDirectoryStatus())!.files > 0, "the original layout snapshot is retained for restoring setup folders and bindings");
    await service.restoreOriginalDirectories();
    assert.equal(await fs.readFile(path.join(root, "课程/a.md"), "utf8"), "# A\n");
    assert.equal(plugin.settings.knowledgeBase.folderBindings.roles.raw.enabled, false, "restoration also restores setup bindings, even when only organization consent changed later");
    assert.equal(plugin.settings.knowledgeBase.folderBindings.roles.projects.writePath, "既有项目");
    assert.equal(await fs.stat(path.join(root, "资料/原文")).catch(() => null), null);
  } finally { fixture.release(); }
}

async function assertRestoreNativeEmptyDirectoryCleanup(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("原有资料/课程/source.md", "ORIGINAL");
    await fs.mkdir(path.join(root, "原有空目录"));
    const plan = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    await fixture.service.applyDirectoryPlan(plan);
    await fixture.write("资料/知识/.keep", "KEEP HIDDEN CONTENT");
    const cachedFolders = new Map(fixture.app.vault.getAllLoadedFiles().filter(item => item instanceof TFolder).map(item => [item.path, item]));
    const find = fixture.app.vault.getAbstractFileByPath.bind(fixture.app.vault);
    // Native adapter events can arrive after rmdir resolves. Keep removed folder
    // objects cached until this restore finishes, including stale child entries.
    fixture.app.vault.getAbstractFileByPath = relative => find(relative) ?? cachedFolders.get(relative) ?? null;
    let deleteCalls = 0;
    fixture.app.vault.delete = async () => { deleteCalls++; throw Object.assign(new Error("Path is a directory: rm returned EISDIR"), { code: "ERR_FS_EISDIR" }); };
    let adapterDeleteCalls = 0;
    fixture.app.vault.adapter.rmdir = async (relative, recursive) => {
      adapterDeleteCalls++;
      assert.equal(recursive, false, "cleanup must never request recursive deletion");
      // Actual Obsidian 1.14.4 implementation also throws EISDIR for folders.
      await fs.rm(path.join(root, relative), { maxRetries: 5, recursive });
    };
    const result = await fixture.service.restoreOriginalDirectories();
    assert.equal(result.restored, 0);
    assert.equal(deleteCalls, 0, "avoid the host file-delete implementation for folders");
    assert.equal(adapterDeleteCalls, 0, "avoid adapter.rmdir(false) routing to fs.rm");
    assert.equal(await fs.stat(path.join(root, "资料/原文")).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(root, "原有资料/课程/source.md"), "utf8"), "ORIGINAL");
    assert.equal(await fs.readFile(path.join(root, "资料/知识/.keep"), "utf8"), "KEEP HIDDEN CONTENT");
    assert((await fs.stat(path.join(root, "原有空目录"))).isDirectory(), "pre-existing empty folders remain");
    assert.equal(fixture.plugin.settings.knowledgeBase.folderBindings.roles.raw.enabled, false, "removed setup folders cannot retain bindings through stale host cache");
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
    const refreshed = await build();
    assert.deepEqual(refreshed.issues, [], "an unrelated file at the old automatic relocation target is harmless");
    assert.deepEqual(refreshed.moves, []);
    await fs.rm(path.join(root, "资料"), { recursive: true });
    plan = await build();
    fixture.plugin.settings.knowledgeBase.folderBindings.roles.inbox.enabled = true;
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /配置已改变/u);
    fixture.plugin.settings.knowledgeBase.folderBindings.roles.inbox.enabled = false;
    (fixture.app.vault as any).setConfig("alwaysUpdateLinks", false);
    await fixture.service.applyDirectoryPlan(await build());
    assert.equal(await fs.readFile(path.join(root, "notes/source.md"), "utf8"), "changed since preview", "setup does not require automatic link updates when no files move");
  } finally { fixture.release(); }
}

async function assertFailedCreateRecovery(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("旧来源/a.md", "A"); await fixture.write("旧来源/b.md", "B");
    Object.assign(fixture.plugin.settings.knowledgeBase.folderBindings.roles.raw, { enabled: true, readPaths: ["旧来源"], writePath: "旧来源" });
    await fixture.write("outputs/.ingest-tracker.md", "# Tracker\n- `旧来源/a.md`\n");
    const createFolder = fixture.app.vault.createFolder.bind(fixture.app.vault);
    fixture.app.vault.createFolder = async directory => {
      if (directory === "资料/知识") throw new Error("fixture create failed");
      return await createFolder(directory);
    };
    const before = knowledgeFolderBindingsSignature(fixture.plugin.settings.knowledgeBase.folderBindings);
    const plan = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /fixture create failed/u);
    assert.equal(await fs.readFile(path.join(root, "旧来源/a.md"), "utf8"), "A");
    assert.equal(await fs.readFile(path.join(root, "旧来源/b.md"), "utf8"), "B");
    assert.equal(await fs.readFile(path.join(root, "outputs/.ingest-tracker.md"), "utf8"), "# Tracker\n- `旧来源/a.md`\n", "failed setup leaves existing source references unchanged");
    assert.equal(knowledgeFolderBindingsSignature(fixture.plugin.settings.knowledgeBase.folderBindings), before);
    assert.equal(await fixture.service.getInitializationState(), null, "failure never marks sources processed or starts extraction");
    assert.equal(await fs.stat(path.join(root, "资料")).catch(() => null), null);
    fixture.app.vault.createFolder = createFolder;
    const retried = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    await fixture.service.applyDirectoryPlan(retried);
    assert.equal(await fs.readFile(path.join(root, "旧来源/b.md"), "utf8"), "B");
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
    edited.organization = { enabled: true, scope: "selected", paths: ["资料/原文"] };
    await fixture.service.applyDirectoryPlan(await fixture.service.previewDirectoryPlan(edited, []));
    await fixture.service.restoreOriginalDirectories();
    const restored = fixture.plugin.settings.knowledgeBase.folderBindings;
    assert.equal(await fs.readFile(path.join(root, "旧来源/source.md"), "utf8"), "ORIGINAL");
    assert.equal(await fs.readFile(path.join(root, "资料/原文/new.md"), "utf8"), "NEW");
    assert.deepEqual(restored.roles.raw.readPaths, ["旧来源", "资料/原文"], "new files retain their current source binding alongside the restored original");
    assert.deepEqual(restored.organization, { enabled: true, scope: "selected", paths: ["资料/原文"] }, "later scope choice survives restore");
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

async function assertRootNativeJournalProtection(root: string) {
  const cases = [
    { format: "YYYY-MM-DD", journal: "2026-10-15.md", ordinary: "2026-02-30.md" },
    { format: "[工作日记]-YYYY年MM月DD日", journal: "工作日记-2026年10月15日.md", ordinary: "工作日记-使用说明.md" },
    { format: "YYYY/[月]MM/DD", journal: "2026/月10/15.md", ordinary: "2026/月10/课程.md" },
    { format: "", journal: "2026-10-15.md", ordinary: "课程.md" }
  ];
  for (const [index, entry] of cases.entries()) {
    const fixture = await fixtureAt(path.join(root, String(index)));
    try {
      fixture.records["daily-notes"].instance.options = { folder: "", format: entry.format };
      await fixture.write(entry.journal, "NATIVE JOURNAL");
      await fixture.write(entry.ordinary, "ORDINARY MATERIAL");
      await fixture.write("普通资料/笔记.md", "MATERIAL");
      const plan = await fixture.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
      assert.deepEqual(plan.issues, []);
      assert(!plan.moves.some(move => move.from === entry.journal), `root native daily note stays in place for ${entry.format || "the native default"}`);
      assert(plan.excluded.some(item => item.path === entry.journal));
      assert.deepEqual(plan.moves, [], "ordinary notes and native daily notes both remain in place");
      assert(!plan.sources.includes(entry.journal), "the preserved native daily note does not enter the new Raw extraction queue");
    } finally { fixture.release(); }
  }
  const unconfigured = await fixtureAt(path.join(root, "unconfigured"));
  try {
    await unconfigured.write("2026-10-15.md", "ORDINARY DATE NOTE");
    const plan = await unconfigured.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    assert.deepEqual(plan.moves, [], "unconfigured date-like notes also remain in place");
  } finally { unconfigured.release(); }
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
    assert.notEqual(fixture.plugin.settings.knowledgeBase.initialized, true, "failed setup restores the completion marker");
  } finally { fixture.release(); }
}

async function assertInitializationModuleRegression(root: string): Promise<void> {
  const f = await fixtureAt(root);
  try {
    Object.assign(f.plugin.settings.englishDiary, { enabled: true, englishDirectoryMode: "role", expressionDirectoryMode: "role" });
    const optionalBefore = JSON.stringify(f.plugin.settings.englishDiary);
    const optional = await f.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build", moduleDirectories: { review: "", pdfOriginal: "" } });
    assert.deepEqual(optional.issues, [], "unbound optional Outputs never blocks knowledge setup");
    assert.equal(optional.moduleDirectories?.english, "");
    await f.service.applyDirectoryPlan(optional);
    assert.equal(JSON.stringify(f.plugin.settings.englishDiary), optionalBefore, "skipped modules preserve their saved settings");
    const custom = await f.service.previewDirectoryPlan(structuredClone(f.plugin.settings.knowledgeBase.folderBindings!), ["custom-english", "custom-journal"], { mode: "existing", moduleDirectories: { english: "custom-english", expressions: "", journal: "custom-journal" } });
    assert.deepEqual(custom.issues, []);
    assert(custom.create.includes("custom-english"), "the custom route can explicitly approve new module folders");
    await f.service.applyDirectoryPlan(custom);
    assert.equal(f.plugin.settings.englishDiary.englishDirectory, "custom-english");
    await f.write("closed-review/keep.md", "REVIEW"); await f.write("closed-english/keep.md", "ENGLISH");
    f.plugin.settings.review.enabled = false; f.plugin.settings.review.outputDir = "closed-review";
    Object.assign(f.plugin.settings.englishDiary, { enabled: false, englishDirectory: "closed-english", legacyEnglishDirectories: ["outputs/.english-diary/diaries"] });
    const before = JSON.stringify(f.plugin.settings.englishDiary);
    let refreshed = 0; f.plugin.englishDiary = { refreshStoragePaths() { refreshed++; } } as any;
    const invalidDisabled = await f.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build", moduleDirectories: { review: "/invalid", english: "/invalid" } });
    assert.match(invalidDisabled.issues.join("；"), /Vault 相对目录/u, "explicit choices are validated even while their modules are disabled");
    const disabled = await f.service.previewDirectoryPlan(buildBindings(), ["资料/原文", "资料/知识"], { mode: "build" });
    assert.deepEqual(disabled.issues, []); assert.ok(!disabled.moves.some(move => /^(closed-review|closed-english)\//u.test(move.from)));
    await f.service.applyDirectoryPlan(disabled); assert.equal(JSON.stringify(f.plugin.settings.englishDiary), before); assert.equal(refreshed, 0);
    await fs.mkdir(path.join(root, "mapped-output"));
    Object.assign(f.plugin.settings.knowledgeBase.folderBindings!.roles.outputs, { enabled: true, readPaths: ["mapped-output"], writePath: "mapped-output" });
    Object.assign(f.plugin.settings.englishDiary, { enabled: true, englishDirectory: "outputs/英文日记", expressionDirectory: "outputs/英文日记/表达库", englishDirectoryMode: "role", expressionDirectoryMode: "role" });
    const role = await f.service.previewDirectoryPlan(structuredClone(f.plugin.settings.knowledgeBase.folderBindings!), ["mapped-output/英文日记", "mapped-output/英文日记/表达库"], { mode: "build" });
    assert.deepEqual(role.issues, []); assert.equal(role.moduleDirectories!.english, "mapped-output/英文日记");
    await f.service.applyDirectoryPlan(role); assert.equal(f.plugin.settings.englishDiary.englishDirectoryMode, "role"); assert.equal(f.plugin.settings.englishDiary.expressionDirectoryMode, "role");
    const explicit = await f.service.previewDirectoryPlan(structuredClone(f.plugin.settings.knowledgeBase.folderBindings!), [], { mode: "existing", moduleDirectories: { english: "mapped-output/英文日记", expressions: "mapped-output/英文日记/表达库" } });
    assert.deepEqual(explicit.moduleDirectoryModes, { english: "custom", expressions: "custom" }, "an explicit choice is a literal folder even if it matches the current role location");
    await f.service.applyDirectoryPlan(explicit);
    assert.equal(f.plugin.settings.englishDiary.englishDirectory, "mapped-output/英文日记");
    assert.equal(f.plugin.settings.englishDiary.englishDirectoryMode, "custom");
    assert.equal(f.plugin.settings.englishDiary.expressionDirectoryMode, "custom");
    f.plugin.settings.englishDiary.enabled = false;
    f.records["daily-notes"].instance.options.folder = "/08-生活/日记";
    const invalid = await f.service.previewDirectoryPlan(structuredClone(f.plugin.settings.knowledgeBase.folderBindings!), [], { mode: "build", moduleDirectories: { journal: "new-journal" } });
    assert.match(invalid.issues.join("；"), /Obsidian 日记文件夹/u); await assert.rejects(f.service.applyDirectoryPlan(invalid));
    const historyRoot = path.join(root, "journal-vault"); await fs.mkdir(historyRoot);
    const history = new InitializationDirectoryHistory({ vaultRoot: historyRoot, privateRoot: path.join(historyRoot, ".private"), mkdir: async () => {}, rename: async () => {}, removeEmptyFolder: async () => {} });
    await history.capture("regression"); const status = await history.status();
    await assert.rejects(history.recordModuleSettings({ nativeJournal: { folder: "/invalid" } }, {}), /Obsidian 日记文件夹/u);
    assert.deepEqual(await history.status(), status, "a rejected write must not poison the existing receipt");
    await history.recordModuleSettings({ english: { directory: "old", legacyDirectories: ["outputs/.english-diary/diaries"] } }, { english: { directory: "new" } });
    assert.deepEqual(await history.status(), status, "every accepted module-settings write remains readable");
    for (const unsafe of ["../outside", "/absolute", "C:/drive", "notes/.hidden", "notes/\u0001bad", "notes/node_modules/cache"]) {
      const plan = await previewKnowledgeDirectoryPlan({ baseRevision: 0, bindings: emptyKnowledgeFolderBindings(), createPaths: [], sourcePaths: [], moduleDirectories: { english: unsafe }, mode: "build", kind: async () => "missing" });
      assert.ok(plan.issues.length, `unsafe operation path rejected: ${JSON.stringify(unsafe)}`);
      const creation = await previewKnowledgeDirectoryPlan({ baseRevision: 0, bindings: emptyKnowledgeFolderBindings(), createPaths: [unsafe], sourcePaths: [], mode: "build", kind: async () => "missing" });
      assert.match(creation.issues.join("；"), /新建目录（第 1 项）/u);
    }
  } finally { f.release(); }
}
