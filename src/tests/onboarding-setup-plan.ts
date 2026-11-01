import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { emptyKnowledgeFolderBindings, knowledgeCollectionDirectory, knowledgeFolderBindingsSignature, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { previewKnowledgeDirectoryPlan, type KnowledgeDirectoryFile } from "../knowledge-base/folder-plan";
import { generateOnboardingSetupPlan, yieldOnboardingScan, type OnboardingSetupInput } from "../knowledge-base/onboarding-setup-plan";
import { registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { nativeJournalFixture } from "./native-journal-fixture";
import { loadNativeJournalSettings } from "../home/native-journal";
import { InitializationDirectoryHistory } from "../knowledge-base/initialization-directory-history";
import { VaultBodySearch } from "../knowledge-base/vault-body-search";
import { knowledgeRecallCandidateAllowed } from "../knowledge-base/folder-organization";
import { normalizeKnowledgeFolderBindings, rebaseKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { resolveEnglishStoragePaths } from "../english-diary/storage-paths";
import { privateMaintenanceSourceScope } from "../plugin/pi-knowledge-maintenance-production";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";

function memoryInput(paths: string[] = [], extra: Partial<OnboardingSetupInput> = {}): OnboardingSetupInput {
  const files: KnowledgeDirectoryFile[] = paths.filter(value => !value.endsWith("/")).map(path => ({ path, size: 17, mtime: 23 }));
  const folders = new Set<string>();
  for (const value of paths) {
    const parts = value.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const input: OnboardingSetupInput = { language: "zh", files, folders: [...folders], protectedPaths: [], ...extra,
    preview: (bindings, createPaths, options) => previewKnowledgeDirectoryPlan({
      ...options, bindings, createPaths, baseline: input.baseline, baseRevision: input.baseline?.revision ?? 0,
      files: input.files, sourcePaths: input.files.filter(file => /\.(?:md|markdown)$/iu.test(file.path)).map(file => file.path),
      protectedPaths: input.protectedPaths.map(item => item.path), yieldToHost: yieldOnboardingScan,
      kind: async value => input.folders.includes(value) ? "folder" : input.files.some(file => file.path === value) ? "other" : "missing"
    }) };
  return input;
}

function bound(roles: Partial<Record<keyof KnowledgeFolderBindings["roles"], string[]>>) {
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, paths] of Object.entries(roles)) Object.assign(bindings.roles[role], { enabled: true, readPaths: paths, writePath: paths[0] });
  return bindings;
}

export async function runOnboardingSetupPlanTests(): Promise<void> {
  const empty = await generateOnboardingSetupPlan(memoryInput());
  assert.deepEqual(empty.directoryPlan.issues, []);
  assert.deepEqual(new Set(empty.directoryPlan.create), new Set(["资料来源", "知识成果", "项目", "收件箱", "产出", "日记"]));
  assert.equal(empty.noteCount, 0);
  assert.equal(empty.rootNotes.count, 0);
  assert.deepEqual(empty.outputLocations, { answer: "产出", generation: "产出" });
  assert.deepEqual(empty.guide, { path: "产出/开始使用 EchoInk.md", action: "create" });
  assert.deepEqual(empty.directoryPlan.moves, []);
  const english = await generateOnboardingSetupPlan(memoryInput([], { language: "en" }));
  assert.deepEqual(new Set(english.directoryPlan.create), new Set(["raw", "wiki", "projects", "inbox", "outputs", "journal"]));
  assert.equal(english.guide.path, "outputs/Getting started with EchoInk.md");

  const notes = await generateOnboardingSetupPlan(memoryInput(["课程/a.md", "课程/b.markdown", "课程/image.png", "工作/记录.md", "根笔记.md", "readme.txt"]));
  assert.deepEqual(notes.directoryPlan.issues, []);
  assert.equal(notes.noteCount, 3);
  assert.equal(notes.sources.find(item => item.path === "课程")?.noteCount, 2);
  assert.equal(notes.rootNotes.count, 1);
  assert.equal(notes.rootNotes.description, "留在原位（对话能搜到，/ask 默认不含）");
  assert(!notes.directoryPlan.sources.includes("根笔记.md"));
  for (const kind of ["web", "wechat", "files", "images"] as const) assert.equal(knowledgeCollectionDirectory(notes.directoryPlan.bindings, kind), "资料来源");

  const baseline = bound({ raw: ["旧来源/文章"], wiki: ["已有成果"], outputs: ["已有输出"], journal: ["日常/日记"] });
  baseline.collectionTargets = { web: "旧来源/文章", wechat: "旧来源/文章", answer: "回答存档", generation: "生成存档" };
  const before = structuredClone(baseline);
  const input = memoryInput(["旧来源/文章/a.md", "旧来源/其他/b.md", "已有成果/a.md", "已有输出/", "日常/日记/", "回答存档/", "生成存档/", "课程/a.md"], { baseline, journalDirectory: "日常/日记" });
  const existing = await generateOnboardingSetupPlan(input);
  assert.deepEqual(baseline, before, "planning must not mutate saved bindings");
  assert.deepEqual(existing.directoryPlan.issues, []);
  for (const role of ["wiki", "outputs", "journal"] as const) assert.deepEqual(existing.directoryPlan.bindings.roles[role], baseline.roles[role]);
  assert.equal(existing.directoryPlan.bindings.roles.raw.writePath, "旧来源/文章");
  assert(!existing.directoryPlan.bindings.roles.raw.readPaths.includes("旧来源"), "a nested saved source must not widen to its parent");
  assert.deepEqual(existing.outputLocations, { answer: "回答存档", generation: "生成存档" });
  assert(existing.skipped.some(item => item.path === "日常"));
  assert(!existing.directoryPlan.create.includes("知识成果"));

  const implicit = bound({ raw: ["原来源"] });
  implicit.roles.raw.writePath = null;
  const implicitPlan = await generateOnboardingSetupPlan(memoryInput(["原来源/旧.md", "新增来源/新.md"], { baseline: implicit }));
  assert.equal(knowledgeCollectionDirectory(implicitPlan.directoryPlan.bindings, "web"), "原来源", "adding sources retains the former implicit collection destination");
  const ambiguous = bound({ raw: ["甲", "乙"] });
  ambiguous.roles.raw.writePath = null;
  const defaulted = await generateOnboardingSetupPlan(memoryInput(["甲/一.md", "乙/二.md"], { baseline: ambiguous }));
  assert.deepEqual(defaulted.directoryPlan.issues, []);
  assert.equal(knowledgeCollectionDirectory(defaulted.directoryPlan.bindings, "web"), "资料来源");
  assert(defaulted.directoryPlan.bindings.roles.raw.readPaths.includes("甲") && defaulted.directoryPlan.bindings.roles.raw.readPaths.includes("乙"));

  const reused = await generateOnboardingSetupPlan(memoryInput(["raw/旧.md", "wiki/知识.md", "projects/", "inbox/", "outputs/", "journal/"], { journalDirectory: "journal" }));
  assert.deepEqual(reused.directoryPlan.create, [], "language changes only newly created defaults");
  assert.deepEqual(reused.directoryPlan.bindings.roles.wiki.readPaths, ["wiki"]);
  const blocked = await generateOnboardingSetupPlan(memoryInput(["资料来源", "知识成果", "项目", "收件箱", "产出", "日记"]));
  assert.deepEqual(blocked.directoryPlan.issues, []);
  assert.deepEqual(new Set(blocked.directoryPlan.create), new Set(["资料来源 2", "知识成果 2", "项目 2", "收件箱 2", "产出 2", "日记 2"]));
  const guide = await generateOnboardingSetupPlan(memoryInput(["产出/开始使用 EchoInk.md"]));
  assert.equal(guide.guide.action, "preserve");
  assert.equal(guide.guide.path, "产出/开始使用 EchoInk.md");

  const nested = await generateOnboardingSetupPlan(memoryInput(["资料/a.md", "资料/私有日记/", "模板/", "笔记/.hidden/", "其他/node_modules/", "复盘/report.md", "资料来源/模板/", "安全/a.md"], {
    protectedPaths: [{ path: "资料/私有日记", reason: "日记" }]
  }));
  assert.deepEqual(nested.directoryPlan.issues, []);
  assert.deepEqual(new Set(nested.sources.map(item => item.path)), new Set(["资料来源 2", "安全"]));
  for (const folder of ["资料", "模板", "笔记", "其他", "复盘", "资料来源"]) assert(nested.skipped.some(item => item.path === folder), folder);
  assert.equal(nested.noteCount, 1);

  const reservedDefault = await generateOnboardingSetupPlan(memoryInput(["知识成果/原文.md", "项目/日记/"], {
    baseline: bound({ raw: ["知识成果"] }), journalDirectory: "项目/日记"
  }));
  assert.deepEqual(reservedDefault.directoryPlan.issues, []);
  assert.deepEqual(reservedDefault.directoryPlan.bindings.roles.wiki.readPaths, ["知识成果 2"]);
  assert.deepEqual(reservedDefault.directoryPlan.bindings.roles.projects.readPaths, ["项目 2"]);

  const conflict = await generateOnboardingSetupPlan(memoryInput(["共用/a.md"], { baseline: bound({ raw: ["共用"], wiki: ["共用"] }) }));
  assert(conflict.directoryPlan.issues.some(issue => issue.includes("用途冲突")));
  assert.deepEqual(conflict.directoryPlan.bindings.roles.raw.readPaths, ["共用"]);
  assert.deepEqual(conflict.directoryPlan.bindings.roles.wiki.readPaths, ["共用"]);
  const guideFolder = await generateOnboardingSetupPlan(memoryInput(["产出/开始使用 EchoInk.md/"]));
  assert.equal(guideFolder.guide.action, "blocked");
  assert(guideFolder.directoryPlan.issues.some(issue => issue.includes("指南路径")));

  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 0);
  try {
    const large = await generateOnboardingSetupPlan(memoryInput(Array.from({ length: 50_000 }, (_, index) => `主题${index % 100}/笔记${index}.md`)));
    assert.deepEqual(large.directoryPlan.issues, []);
    assert.equal(large.noteCount, 50_000);
    assert.equal(large.sources.find(item => item.path === "主题0")?.noteCount, 500);
    assert(heartbeats > 10, "large scans must yield to host events throughout processing");
  } finally { clearInterval(timer); }

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "echoink-onboarding-plan-")));
  try {
    await assertServiceIntegration(path.join(root, "existing"));
    await assertEmptyServiceIntegration(path.join(root, "empty"));
    await assertConfirmationAndUndo(path.join(root, "confirmation"));
    await assertBindingOnlyUndo(path.join(root, "binding-only"));
    await assertOnboardingRollback(path.join(root, "rollback"));
    for (const state of ["created", "preserved", "modified", "failed", "english", "moved", "moved-preserved"] as const) await assertGuideLifecycle(path.join(root, `guide-${state}`), state);
    for (const mode of ["new", "reused", "user-history", "content"] as const) await assertRepeatableSetup(path.join(root, `repeat-${mode}`), mode);
  }
  finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log("Onboarding setup plans: empty/existing/bindings/reuse/collisions/protected/conflicts/50k/integration PASS");
}

async function assertGuideLifecycle(root: string, state: "created" | "preserved" | "modified" | "failed" | "english" | "moved" | "moved-preserved") {
  const fixture = await nativeJournalFixture(root);
  const userGuide = state === "preserved" || state === "moved-preserved";
  const { plugin, app } = fixture;
  plugin.settings.defaultPermission = "workspace-write";
  const before = emptyKnowledgeFolderBindings(); plugin.settings.knowledgeBase.folderBindings = before;
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, ".private"));
  const service = new EchoInkKnowledgeSurfaceService(plugin);
  await service.getInitializationState(); await service.linking.ready;
  try {
    await fixture.write("原有资料/记录.md", "# 原有资料\nR3_GUIDE_TOKEN 源笔记");
    // A same-name file forces the actual output folder to differ from the default.
    if (!userGuide) await fixture.write(state === "english" ? "outputs" : "产出", "occupied");
    const language = state === "english" ? "en" : "zh";
    if (userGuide) await fixture.write("产出/开始使用 EchoInk.md", "USER_GUIDE R3_GUIDE_TOKEN");
    const plan = await service.previewOnboardingSetupPlan(language);
    assert(plan.guide.path.startsWith(userGuide ? "产出/" : language === "en" ? "outputs 2/" : "产出 2/"), `${state}: ${plan.guide.path}`);
    const applied = await service.applyOnboardingSetupPlan(plan);
    const signature = knowledgeFolderBindingsSignature(plugin.settings.knowledgeBase.folderBindings);
    const create = app.vault.create.bind(app.vault);
    if (state === "failed") {
      app.vault.create = async () => { throw new Error("fixture guide write denied"); };
      await assert.rejects(service.writeOnboardingSetupGuide(plan, applied.created), /fixture guide write denied/u);
      assert.equal(knowledgeFolderBindingsSignature(plugin.settings.knowledgeBase.folderBindings), signature);
      for (const directory of applied.created) assert((await fs.stat(path.join(root, directory))).isDirectory(), "guide failure never rolls back directories");
      app.vault.create = create;
    }
    const result = await service.writeOnboardingSetupGuide(plan, applied.created);
    assert.equal(result.action, userGuide ? "preserved" : "created");
    const content = await fs.readFile(path.join(root, result.path), "utf8");
    if (userGuide) assert.equal(content, "USER_GUIDE R3_GUIDE_TOKEN");
    else {
      assert(content.startsWith(language === "en" ? "# Getting started with EchoInk" : "# 开始使用 EchoInk"));
      assert(!/\{\w+\}/u.test(content)); assert(content.includes(plan.outputLocations.answer));
      assert(content.includes("原有资料")); assert(content.includes(String(plan.noteCount)));
    }
    let opened = "";
    app.workspace.getLeaf = (() => ({ async openFile(file: { path: string }) { opened = file.path; } })) as never;
    await service.openOnboardingSetupGuide(result.path); assert.equal(opened, result.path);
    if (state === "moved" || state === "moved-preserved") {
      const moved = "原有资料/改名后的指南.md";
      await app.fileManager.renameFile(app.vault.getFileByPath(result.path)!, moved);
      await (service as unknown as { syncRenamedPaths(from: string, to: string, folder: boolean): Promise<void> }).syncRenamedPaths(result.path, moved, false);
      result.path = moved;
      const next = await service.previewOnboardingSetupPlan("zh");
      assert.equal(next.noteCount, 1, "the moved guide is not counted as an included source note");
      assert(!(await privateMaintenanceSourceScope(root, { readMaintenanceHistory: false, limit: Infinity })).sourcePaths.includes(moved));
      const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, ".guide-index") });
      await index.refresh();
      assert(!(await index.search({ mode: "recent", limit: 50 })).hits.some(hit => hit.vaultRelativePath === moved));
    }
    const saved = normalizeKnowledgeFolderBindings(plugin.settings.knowledgeBase.folderBindings)!;
    assert.equal(saved.onboardingGuidePath, result.path, "the exact exclusion survives settings normalization");
    assert.equal(rebaseKnowledgeFolderBindings(saved, plan.outputLocations.answer, "新产出").onboardingGuidePath, state.startsWith("moved") ? result.path : `新产出/${path.basename(result.path)}`);
    assert(!knowledgeRecallCandidateAllowed(saved, result.path));
    const sibling = `${plan.outputLocations.answer}/其他笔记.md`;
    await fixture.write(sibling, "R3_GUIDE_TOKEN 普通产出笔记");
    assert(knowledgeRecallCandidateAllowed(saved, sibling), "the output folder remains searchable");
    const port = new VaultBodySearch(app, () => plugin.settings.knowledgeBase.folderBindings);
    const hits = await port.search({ query: "R3_GUIDE_TOKEN", limit: 20 });
    assert(!hits.hits.some(hit => hit.vaultRelativePath === result.path));
    assert(hits.hits.some(hit => hit.vaultRelativePath === sibling));
    assert(!(await port.search({ mode: "recent", limit: 20 })).hits.some(hit => hit.vaultRelativePath === result.path));
    await fixture.write("原有资料/新笔记.md", "R3_FRESH_NOTE_TOKEN 新增记录");
    assert((await port.search({ query: "R3_FRESH_NOTE_TOKEN", limit: 20 })).hits.some(hit => hit.vaultRelativePath === "原有资料/新笔记.md"), "new notes are searchable without rebuilding or manual invalidation");
    port.dispose();
    await fs.unlink(path.join(root, sibling));
    if (state === "modified") await fs.appendFile(path.join(root, result.path), "\nUSER_EDIT");
    await service.restoreOriginalDirectories();
    assert.equal(knowledgeFolderBindingsSignature(plugin.settings.knowledgeBase.folderBindings), knowledgeFolderBindingsSignature(before));
    const remains = await fs.stat(path.join(root, result.path)).then(() => true, () => false);
    assert.equal(remains, userGuide || state === "modified");
    if (!remains) assert.equal(await fs.stat(path.join(root, plan.outputLocations.answer)).then(() => true, () => false), false);
    assert.equal(await fs.readFile(path.join(root, "原有资料/记录.md"), "utf8"), "# 原有资料\nR3_GUIDE_TOKEN 源笔记");
    assert.equal(fixture.providerCalls(), 0, "guide generation is entirely local");
  } finally { release(); }
}

async function assertRepeatableSetup(root: string, mode: "new" | "reused" | "user-history" | "content") {
  const { plugin, app, write } = await nativeJournalFixture(root);
  plugin.settings.defaultPermission = "workspace-write";
  plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  const originalEnglish = ["用户旧英文库", ...(mode === "user-history" ? ["产出/用户旧历史"] : [])];
  const originalExpressions = ["用户旧表达库"];
  Object.assign(plugin.settings.englishDiary, { legacyEnglishDirectories: [...originalEnglish], legacyExpressionDirectories: [...originalExpressions] });
  await write("用户旧英文库/内容.md", "USER_ENGLISH");
  if (mode === "reused") await fs.mkdir(path.join(root, "产出"));
  // Use the real resolver: runtime refresh persists derived output migration roots.
  plugin.englishDiary = { refreshStoragePaths() {
    const resolved = resolveEnglishStoragePaths(plugin.settings.englishDiary, plugin.settings.knowledgeBase.folderBindings,
      app.vault.getAllLoadedFiles().filter(file => !file.path.includes("/") && "children" in file).map(file => file.path));
    plugin.settings.englishDiary.legacyEnglishDirectories = resolved.legacyEnglishDirectories;
    plugin.settings.englishDiary.legacyExpressionDirectories = resolved.legacyExpressionDirectories;
  } };
  plugin.englishDiary.refreshStoragePaths();
  const beforeEnglish = [...plugin.settings.englishDiary.legacyEnglishDirectories];
  const beforeExpressions = [...plugin.settings.englishDiary.legacyExpressionDirectories];
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, ".private"));
  const service = new EchoInkKnowledgeSurfaceService(plugin);
  await service.getInitializationState(); await service.linking.ready;
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const plan = await service.previewOnboardingSetupPlan("zh");
      assert.equal(plan.outputLocations.answer, mode === "user-history" ? "产出 2" : "产出", `repeat ${mode} cycle ${cycle}`);
      const applied = await service.applyOnboardingSetupPlan(plan);
      plugin.englishDiary.refreshStoragePaths();
      assert(plugin.settings.englishDiary.legacyEnglishDirectories.some((directory: string) => directory.startsWith(plan.outputLocations.answer + "/")));
      await service.writeOnboardingSetupGuide(plan, applied.created);
      if (mode === "content") await write("产出/英文日记/用户内容.md", "KEEP_NEW_DIARY");
      await service.restoreOriginalDirectories();
      if (mode === "content") {
        assert(plugin.settings.englishDiary.legacyEnglishDirectories.includes("产出/英文日记"));
        assert.equal(await fs.readFile(path.join(root, "产出/英文日记/用户内容.md"), "utf8"), "KEEP_NEW_DIARY");
        return;
      }
      assert.deepEqual(plugin.settings.englishDiary.legacyEnglishDirectories, beforeEnglish, "only the setup's synthetic, missing history roots are removed");
      assert.deepEqual(plugin.settings.englishDiary.legacyExpressionDirectories, beforeExpressions);
      assert.equal(await fs.readFile(path.join(root, "用户旧英文库/内容.md"), "utf8"), "USER_ENGLISH");
    }
  } finally { release(); }
}

async function assertConfirmationAndUndo(root: string) {
  const fixture = await nativeJournalFixture(root);
  const { plugin, app } = fixture;
  plugin.settings.defaultPermission = "workspace-write";
  const original = bound({ raw: ["旧来源"], wiki: ["旧成果"] });
  plugin.settings.knowledgeBase.folderBindings = structuredClone(original);
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  const privateRoot = path.join(root, ".private"); registerKnowledgePrivateRoot(root, privateRoot);
  const service = new EchoInkKnowledgeSurfaceService(plugin);
  await service.getInitializationState(); await service.linking.ready;
  try {
    await fixture.write("旧来源/旧笔记.md", "OLD"); await fixture.write("旧成果/成果.md", "WIKI"); await fixture.write("课程/文章.md", "SOURCE");
    const history = new InitializationDirectoryHistory({ vaultRoot: root, privateRoot, currentBindings: () => original,
      mkdir: async directory => { await fs.mkdir(path.join(root, directory), { recursive: true }); },
      rename: async (from, to) => { await fs.rename(path.join(root, from), path.join(root, to)); },
      removeEmptyFolder: async directory => { await fs.rmdir(path.join(root, directory)); } });
    await history.capture("older-layout");
    const olderIndex = await fs.readFile(path.join(privateRoot, "knowledge/initialization/original-directory-index.json"), "utf8");
    const before = structuredClone(original); before.roles.raw.searchEnabled = false;
    plugin.settings.knowledgeBase.folderBindings = before;
    const cachedFiles = app.vault.getFiles.bind(app.vault);
    app.vault.getFiles = () => cachedFiles().map(file => { file.stat = { ...file.stat, mtime: Math.floor(file.stat.mtime) - 123 }; return file; });
    const shown = await service.previewOnboardingSetupPlan("zh");
    assert.deepEqual(shown.directoryPlan.issues, []);
    await assert.rejects(service.applyDirectoryPlan(shown.directoryPlan), /目录或文件已改变/u, "other entry points retain their strict snapshot check");
    const events: string[] = [];
    const result = await service.applyOnboardingSetupPlan(shown, (step, done, total) => events.push(`${step}:${done}/${total}`));
    assert(result.created.length > 0); assert(events.includes("bindings:1/1"));
    assert.deepEqual(result.moved, []);
    await fixture.write("项目/保留.md", "KEEP");
    const restored = await service.restoreOriginalDirectories();
    assert(restored.skipped.some(item => item.path === "项目"));
    for (const role of ["raw", "wiki", "projects", "inbox", "outputs", "journal"] as const) {
      assert.deepEqual(plugin.settings.knowledgeBase.folderBindings.roles[role].readPaths, before.roles[role].readPaths);
      assert.equal(plugin.settings.knowledgeBase.folderBindings.roles[role].enabled, before.roles[role].enabled);
    }
    assert.equal(plugin.settings.knowledgeBase.folderBindings.roles.raw.searchEnabled, false);
    assert.equal(await fs.readFile(path.join(root, "课程/文章.md"), "utf8"), "SOURCE");
    assert.equal(await fs.readFile(path.join(root, "项目/保留.md"), "utf8"), "KEEP");
    assert.equal(await fs.stat(path.join(root, "产出")).then(() => true, () => false), false);
    const older = JSON.parse(await fs.readFile(path.join(privateRoot, "knowledge/initialization/original-directory-index.json"), "utf8"));
    assert.deepEqual(older.bindings, original, "the original layout journal is retained separately");
    assert.equal(await fs.readFile(path.join(privateRoot, "knowledge/initialization/original-directory-index.json"), "utf8"), olderIndex, "onboarding does not mutate the older layout journal");
    const next = await service.previewOnboardingSetupPlan("zh");
    await fixture.write("后来新增/新笔记.md", "NEW");
    await assert.rejects(service.applyOnboardingSetupPlan(next), /重新扫描并核对/u, "visible changes require a fresh confirmation");
  } finally { release(); }
}

async function assertBindingOnlyUndo(root: string) {
  const fixture = await nativeJournalFixture(root);
  const { plugin } = fixture;
  plugin.settings.defaultPermission = "workspace-write";
  plugin.settings.journalDirectory = "日记";
  const original = emptyKnowledgeFolderBindings(); plugin.settings.knowledgeBase.folderBindings = original;
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, ".private"));
  for (const folder of ["资料来源", "知识成果", "项目", "收件箱", "产出", "日记"]) await fs.mkdir(path.join(root, folder));
  const service = new EchoInkKnowledgeSurfaceService(plugin);
  await service.getInitializationState(); await service.linking.ready;
  try {
    const plan = await service.previewOnboardingSetupPlan();
    assert.deepEqual(plan.directoryPlan.create, []);
    await service.applyOnboardingSetupPlan(plan);
    assert(await service.getOriginalDirectoryStatus(), "binding-only setup has its own restore record");
    await service.restoreOriginalDirectories();
    assert.equal(knowledgeFolderBindingsSignature(plugin.settings.knowledgeBase.folderBindings), knowledgeFolderBindingsSignature(original));
    assert.equal(plugin.settings.knowledgeBase.folderBindings.configured, false);
    assert.equal(await service.getOriginalDirectoryStatus(), null);
    for (const folder of ["资料来源", "知识成果", "项目", "收件箱", "产出", "日记"]) assert((await fs.stat(path.join(root, folder))).isDirectory(), "reused directories are never deleted");
  } finally { release(); }
}

async function assertEmptyServiceIntegration(root: string) {
  const fixture = await nativeJournalFixture(root);
  const { plugin } = fixture;
  plugin.settings.defaultPermission = "workspace-write";
  plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, ".private"));
  const service = new EchoInkKnowledgeSurfaceService(plugin);
  await service.getInitializationState(); await service.linking.ready;
  try {
    const result = await service.previewOnboardingSetupPlan();
    assert.deepEqual(result.directoryPlan.issues, []);
    assert.equal(result.directoryPlan.moduleDirectories?.journal, "日记");
    assert.equal(plugin.settings.journalDirectory, "journal", "preview leaves the default setting unchanged");
    await service.applyDirectoryPlan(result.directoryPlan);
    assert.equal(plugin.settings.journalDirectory, "日记");
    assert.equal(plugin.settings.knowledgeBase.folderBindings.collectionTargets?.web, "资料来源");
    assert.equal(fixture.providerCalls(), 0);
  } finally { release(); }
}

async function assertServiceIntegration(root: string) {
  const fixture = await nativeJournalFixture(root);
  const { plugin, app } = fixture;
  plugin.settings.defaultPermission = "workspace-write";
  plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, "私有"));
  const service = new EchoInkKnowledgeSurfaceService(plugin);
  await service.getInitializationState(); await service.linking.ready;
  try {
    for (const relative of ["笔记/原文.md", "根笔记.md", "附件父/素材/图.png", "英文父/旧英文/a.md", "PDF父/原件/a.pdf", "复盘父/报告/a.md", "模板父/自用/a.md", "EchoInk/待办.md", "账本/ledger.base"]) await fixture.write(relative, "KEEP");
    for (const directory of ["隐藏父/.secret", "依赖父/node_modules", "私有", "财务（finance）", "日常"]) await fs.mkdir(path.join(root, directory), { recursive: true });
    plugin.settings.journalDirectory = "日常";
    plugin.settings.knowledgeBase.folderBindings.collectionTargets = { web: null, wechat: null, answer: "定制回答/正文" };
    plugin.settings.review.outputDir = "复盘父/报告";
    plugin.settings.englishDiary.legacyEnglishDirectories = ["英文父/旧英文"];
    plugin.settings.pdfReading.originalDirectory = "PDF父/原件";
    fixture.records.templates.instance.options.folder = "模板父/自用";
    await fixture.write("未启用模板父/存放/片段.md", "KEEP");
    await fixture.write(".obsidian/templates.json", JSON.stringify({ folder: "未启用模板父/存放" }));
    await loadNativeJournalSettings(app);
    const config = app.vault as unknown as { setConfig(key: string, value: unknown): void };
    config.setConfig("attachmentFolderPath", "./素材"); config.setConfig("alwaysUpdateLinks", false);
    let saves = 0;
    plugin.saveSettings = async () => { saves++; };
    const settingsBefore = structuredClone(plugin.settings);
    app.vault.read = app.vault.cachedRead = async () => { throw new Error("preview must not read bodies"); };
    app.fileManager.renameFile = async () => { throw new Error("onboarding must not move notes"); };
    config.setConfig = () => { throw new Error("onboarding must not change host settings"); };
    const result = await service.previewOnboardingSetupPlan("zh");
    assert.deepEqual(result.directoryPlan.issues, []);
    assert.deepEqual(plugin.settings, settingsBefore);
    assert.equal(saves, 0);
    assert.equal(result.rootNotes.count, 1);
    assert.equal(result.noteCount, 1);
    for (const directory of ["附件父", "英文父", "PDF父", "复盘父", "模板父", "未启用模板父", "EchoInk", "账本", "隐藏父", "依赖父", "私有", "财务（finance）", "日常"]) {
      assert(result.skipped.some(item => item.path === directory), directory);
      assert(!result.sources.some(item => item.path === directory), directory);
    }
    assert(!result.directoryPlan.create.includes("日记"));
    // Save validation must reject the not-yet-created plan without writing settings.
    await assert.rejects(service.saveDirectoryBindings(result.directoryPlan.bindings), /原目录已失效/u);
    assert.equal(saves, 0);
    // The existing executor rechecks finance markers; only preview has the stricter
    // cache-only contract. Markdown bodies must still stay untouched here.
    app.vault.cachedRead = async file => {
      assert.equal(file.path.endsWith("/ledger.base"), true);
      return await fs.readFile(path.join(root, file.path), "utf8");
    };
    const applied = await service.applyDirectoryPlan(result.directoryPlan);
    assert.deepEqual(applied.moved, []);
    assert.equal(applied.refinement, "not-started");
    assert.deepEqual(new Set(applied.created), new Set(result.directoryPlan.create));
    assert.equal(await fs.readFile(path.join(root, "根笔记.md"), "utf8"), "KEEP");
    assert.equal(await fs.readFile(path.join(root, "笔记/原文.md"), "utf8"), "KEEP");
    assert.equal(await fs.stat(path.join(root, result.guide.path)).then(() => true, () => false), false, "round 1 never writes guide contents");
    assert.equal(plugin.settings.journalDirectory, "日常");
    assert.deepEqual(plugin.settings.englishDiary, settingsBefore.englishDiary);
    const saved = await service.saveDirectoryBindings(structuredClone(plugin.settings.knowledgeBase.folderBindings));
    assert.equal(saved.collectionTargets?.answer, "定制回答/正文");
    assert.equal(saved.collectionTargets?.generation, "产出");
    assert.equal(fixture.providerCalls(), 0);
  } finally { release(); }
}

async function assertOnboardingRollback(root: string) {
  const fixture = await nativeJournalFixture(root);
  const { plugin } = fixture;
  plugin.settings.defaultPermission = "workspace-write";
  const before = emptyKnowledgeFolderBindings(); plugin.settings.knowledgeBase.folderBindings = before;
  const release = registerKnowledgeFolderBindings(root, () => plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, ".private"));
  const service = new EchoInkKnowledgeSurfaceService(plugin);
  await service.getInitializationState(); await service.linking.ready;
  let failed = false;
  plugin.saveSettings = async () => { if (!failed && plugin.settings.knowledgeBase.folderBindings?.configured) { failed = true; throw new Error("fixture binding save failed"); } };
  try {
    const plan = await service.previewOnboardingSetupPlan();
    await assert.rejects(service.applyOnboardingSetupPlan(plan), /fixture binding save failed/u);
    assert.equal(knowledgeFolderBindingsSignature(plugin.settings.knowledgeBase.folderBindings), knowledgeFolderBindingsSignature(before));
    for (const folder of plan.directoryPlan.create) assert.equal(await fs.stat(path.join(root, folder)).then(() => true, () => false), false);
    assert.equal(await service.getOriginalDirectoryStatus(), null, "a rolled-back attempt leaves no stale onboarding undo record");
    plugin.saveSettings = async () => {};
    const retry = await service.applyOnboardingSetupPlan(await service.previewOnboardingSetupPlan());
    assert.equal(retry.configured, true);
  } finally { release(); }
}
