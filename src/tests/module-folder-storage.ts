import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { emptyKnowledgeFolderBindings, knowledgeCollectionDirectory, knowledgeFolderBindingsSignature, normalizeKnowledgeFolderBindings, rebaseKnowledgeFolderBindings, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { EchoInkKnowledgeSurfaceService } from "../plugin/knowledge-surface-service";
import { nativeJournalFixture } from "./native-journal-fixture";

function sourceBindings(): KnowledgeFolderBindings {
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["来源甲", "来源乙"], writePath: "来源乙" });
  Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["知识成果"], writePath: "知识成果" });
  return bindings;
}

async function fixtureAt(root: string) {
  const fixture = await nativeJournalFixture(root);
  fixture.plugin.settings.defaultPermission = "workspace-write";
  fixture.plugin.settings.knowledgeBase.folderBindings = emptyKnowledgeFolderBindings();
  const release = registerKnowledgeFolderBindings(root, () => fixture.plugin.settings.knowledgeBase.folderBindings);
  registerKnowledgePrivateRoot(root, path.join(root, "private-state"));
  const service = new EchoInkKnowledgeSurfaceService(fixture.plugin);
  await service.getInitializationState();
  await service.linking.ready;
  return { ...fixture, release, service };
}

async function inventory(root: string, directory = ""): Promise<string[]> {
  const entries: string[] = [];
  for (const item of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory ? `${directory}/${item.name}` : item.name;
    if (item.isDirectory()) entries.push(`${relative}/`, ...await inventory(root, relative));
    else entries.push(`${relative}:${(await fs.readFile(path.join(root, relative))).toString("base64")}`);
  }
  return entries.sort();
}

function assertBindingCompatibility() {
  const bindings = sourceBindings();
  assert.equal(knowledgeCollectionDirectory(bindings, "web"), "来源乙");
  assert.equal(knowledgeCollectionDirectory(bindings, "wechat"), "来源乙");
  bindings.allowAgentSubfolders = true;
  bindings.collectionTargets = { web: "来源甲", wechat: "来源乙" };
  bindings.inboxRecallExclusions = ["旧收件箱/资料"];
  const normalized = normalizeKnowledgeFolderBindings(bindings)!;
  assert.equal(normalized.allowAgentSubfolders, true);
  assert.deepEqual(normalized.collectionTargets, bindings.collectionTargets);
  assert.equal(knowledgeCollectionDirectory(normalized, "web"), "来源甲");
  const signature = knowledgeFolderBindingsSignature(normalized);
  normalized.collectionTargets!.web = "来源乙";
  assert.notEqual(knowledgeFolderBindingsSignature(normalized), signature);
  normalized.collectionTargets!.web = "不再绑定的来源";
  assert.equal(knowledgeCollectionDirectory(normalized, "web"), null, "withdrawn choices do not silently use the default source");
  normalized.collectionTargets!.web = null;
  assert.equal(knowledgeCollectionDirectory(normalized, "web"), null);
  normalized.allowAgentSubfolders = false;
  assert.equal(normalizeKnowledgeFolderBindings(normalized)!.allowAgentSubfolders, false);
  const rebased = rebaseKnowledgeFolderBindings(bindings, "来源甲", "资料/甲");
  assert.equal(rebased.collectionTargets!.web, "资料/甲");
  assert.equal(rebased.collectionTargets!.wechat, "来源乙");
  assert.deepEqual(rebaseKnowledgeFolderBindings(bindings, "旧收件箱", "原收件箱").inboxRecallExclusions, ["原收件箱/资料"]);
  assert.equal(rebased.revision, bindings.revision + 1);
  const bad = normalizeKnowledgeFolderBindings({ ...bindings, collectionTargets: { web: "../外部", wechat: "来源乙" }, inboxRecallExclusions: ["../外部", "旧收件箱", "旧收件箱"] })!;
  assert.equal(bad.collectionTargets!.web, null);
  assert.deepEqual(bad.inboxRecallExclusions, ["旧收件箱"]);
}

async function assertImmediateBindingSave(root: string) {
  const fixture = await fixtureAt(root);
  try {
    const { plugin, app, service } = fixture;
    for (const folder of ["来源甲", "来源乙", "旧知识/甲", "旧知识/乙", "知识成果", "收件箱"]) await fixture.write(`${folder}/keep.md`, folder);
    const legacy = sourceBindings();
    Object.assign(legacy.roles.wiki, { readPaths: ["旧知识/甲", "旧知识/乙"], writePath: "旧知识/甲", compatibilityReadScopes: true, allowedSubdirectories: ["未建分类"] });
    Object.assign(legacy.roles.outputs, { enabled: true, readPaths: ["旧失效输出"], writePath: "旧失效输出" });
    Object.assign(legacy.roles.archive, { enabled: true, readPaths: ["旧失效归档甲", "旧失效归档乙"], writePath: null });
    Object.assign(legacy.roles.inbox, { enabled: true, readPaths: ["收件箱"], writePath: "收件箱" });
    plugin.settings.knowledgeBase.folderBindings = legacy;
    plugin.settings.defaultPermission = "read-only";
    let creates = 0, moves = 0, deletes = 0, saves = 0;
    app.vault.createFolder = async () => { creates++; throw new Error("binding edits must not create directories"); };
    app.fileManager.renameFile = async () => { moves++; throw new Error("binding edits must not move files"); };
    app.vault.delete = async () => { deletes++; throw new Error("binding edits must not delete files"); };
    plugin.saveSettings = async () => { saves++; };
    const before = await inventory(root);
    const split = structuredClone(legacy);
    split.collectionTargets = { web: "来源甲", wechat: "来源乙" };
    const saved = await service.saveDirectoryBindings(split);
    assert.deepEqual(saved.roles.wiki, legacy.roles.wiki, "saving other settings retains legal deep/multiple legacy scopes");
    assert.deepEqual(saved.roles.outputs, legacy.roles.outputs, "unrelated invalid legacy folders do not block an edit");
    assert.deepEqual(saved.roles.archive, legacy.roles.archive, "an existing unrelated issue does not block an edit");
    assert.equal(saves, 1);
    assert.deepEqual(await inventory(root), before);
    assert.deepEqual([creates, moves, deletes], [0, 0, 0]);
    await assert.rejects(service.saveDirectoryBindings(split), /目录配置已改变/u);
    const oldSignature = knowledgeFolderBindingsSignature(plugin.settings.knowledgeBase.folderBindings);
    const badWiki = structuredClone(saved);
    await assert.rejects(service.saveDirectoryBindings(badWiki, { wikiChanged: true }), /一级文件夹/u);
    assert.equal(knowledgeFolderBindingsSignature(plugin.settings.knowledgeBase.folderBindings), oldSignature);
    const newWiki = structuredClone(saved);
    Object.assign(newWiki.roles.wiki, { readPaths: ["知识成果"], writePath: "知识成果", compatibilityReadScopes: false });
    await service.saveDirectoryBindings(newWiki, { wikiChanged: true });
    assert.deepEqual(await inventory(root), before, "actively replacing the binding retains all old notes");
    const missing = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    missing.roles.raw.readPaths.push("不存在的新来源");
    await assert.rejects(service.saveDirectoryBindings(missing), /原目录已失效/u);
    const badCollection = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    badCollection.collectionTargets!.web = "旧知识/甲";
    await assert.rejects(service.saveDirectoryBindings(badCollection), /资料来源目录/u);
    const previous = plugin.settings.knowledgeBase.folderBindings;
    let failOnce = true;
    plugin.saveSettings = async () => { if (failOnce) { failOnce = false; throw new Error("fixture save unavailable"); } };
    const failed = structuredClone(previous);
    failed.collectionTargets!.web = "来源乙";
    await assert.rejects(service.saveDirectoryBindings(failed), /绑定未保存.*fixture save unavailable/u);
    assert.equal(plugin.settings.knowledgeBase.folderBindings, previous, "failed saves restore the exact previous binding object");
    plugin.saveSettings = async () => {};
    const disabled = structuredClone(previous);
    disabled.roles.inbox.enabled = false;
    await service.saveDirectoryBindings(disabled);
    assert.deepEqual(plugin.settings.knowledgeBase.folderBindings.inboxRecallExclusions, ["收件箱"]);
    const enabled = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    enabled.roles.inbox.enabled = true;
    await service.saveDirectoryBindings(enabled);
    assert.deepEqual(plugin.settings.knowledgeBase.folderBindings.inboxRecallExclusions, []);
    const searchOff = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    searchOff.roles.inbox.searchEnabled = false;
    await service.saveDirectoryBindings(searchOff);
    assert.deepEqual(plugin.settings.knowledgeBase.folderBindings.inboxRecallExclusions, ["收件箱"]);
    assert.deepEqual([creates, moves, deletes], [0, 0, 0]);
  } finally { fixture.release(); }
}

async function assertInitializationSnapshot(root: string) {
  const fixture = await fixtureAt(root);
  try {
    const { service, plugin } = fixture;
    await fixture.write("课程/资料.md", "SOURCE");
    await fixture.write("来源甲/keep.md", "ALREADY BOUND");
    await fixture.write("PDF原件/original.pdf", "ORIGINAL PDF");
    plugin.settings.pdfReading.originalDirectory = "PDF原件";
    const config = sourceBindings();
    const preview = () => service.previewDirectoryPlan(config, ["来源乙", "知识成果"], { mode: "build", wikiChanged: true });
    const before = await inventory(root);
    let plan = await preview();
    assert.deepEqual(plan.issues, []);
    assert.deepEqual(plan.moves.map(item => item.to), ["来源乙/课程/资料.md"], "multiple read roots share one explicit relocation target");
    assert(plan.sources.includes("来源甲/keep.md"), "all source roots remain readable");
    assert.deepEqual(await inventory(root), before, "preview is strictly read-only");
    plugin.settings.review.outputDir = "新的复盘位置";
    await assert.rejects(service.applyDirectoryPlan(plan), /设置已变化/u);
    assert.deepEqual(await inventory(root), before, "module configuration changes reject a stale plan before writes");
    plan = await preview();
    fixture.records["templates"].instance.options = { folder: "新模板位置" };
    await assert.rejects(service.applyDirectoryPlan(plan), /设置已变化/u);
    plan = await preview();
    await fs.writeFile(path.join(root, "PDF原件/original.pdf"), "PDF CHANGED AFTER PREVIEW");
    await assert.rejects(service.applyDirectoryPlan(plan), /重新预览/u);
    assert.equal(await fs.stat(path.join(root, "来源乙")).catch(() => null), null);
    plan = await preview();
    const result = await service.applyDirectoryPlan(plan);
    assert.deepEqual(result.created, plan.create);
    assert.deepEqual(result.moved, plan.moves);
    assert.equal(await fs.readFile(path.join(root, "来源乙/课程/资料.md"), "utf8"), "SOURCE");
    assert.equal(await fs.readFile(path.join(root, "来源甲/keep.md"), "utf8"), "ALREADY BOUND");
    assert.equal(await fs.readFile(path.join(root, "PDF原件/original.pdf"), "utf8"), "PDF CHANGED AFTER PREVIEW");
    assert.equal(fixture.providerCalls(), 0);
    const consent = structuredClone(plugin.settings.knowledgeBase.folderBindings);
    consent.roles.wiki.allowedSubdirectories = ["尚未创建的分类"];
    const existing = await service.previewDirectoryPlan(consent, [], { mode: "existing" });
    assert.deepEqual(existing.create, [], "using existing folders does not create legacy-approved child folders");
    assert.deepEqual(existing.moves, []);
    await service.applyDirectoryPlan(existing);
    assert.equal(await fs.stat(path.join(root, "知识成果/尚未创建的分类")).catch(() => null), null);
  } finally { fixture.release(); }
}

async function assertRollbackRetainsNewUserContent(root: string) {
  const fixture = await fixtureAt(root);
  try {
    await fixture.write("课程/资料.md", "ORIGINAL SOURCE");
    const original = structuredClone(fixture.plugin.settings.knowledgeBase.folderBindings);
    let failOnce = true;
    fixture.plugin.saveSettings = async () => {
      if (failOnce && fixture.plugin.settings.knowledgeBase.folderBindings.configured) {
        failOnce = false;
        await fixture.write("来源乙/用户后来写入.md", "USER CONTENT");
        throw new Error("fixture save failed after user write");
      }
    };
    const plan = await fixture.service.previewDirectoryPlan(sourceBindings(), ["来源甲", "来源乙", "知识成果"], { mode: "build", wikiChanged: true });
    await assert.rejects(fixture.service.applyDirectoryPlan(plan), /fixture save failed/u);
    assert.equal(await fs.readFile(path.join(root, "课程/资料.md"), "utf8"), "ORIGINAL SOURCE");
    assert.equal(await fs.readFile(path.join(root, "来源乙/用户后来写入.md"), "utf8"), "USER CONTENT", "rollback must retain user files written after preview");
    assert.equal(knowledgeFolderBindingsSignature(fixture.plugin.settings.knowledgeBase.folderBindings), knowledgeFolderBindingsSignature(original));
    assert.equal(await fixture.service.getInitializationState(), null);
  } finally { fixture.release(); }
}

async function assertModuleDirectoryChoices(root: string) {
  const fixture = await fixtureAt(root);
  try {
    const { plugin, service, records } = fixture;
    const bindings = sourceBindings();
    plugin.settings.knowledgeBase.folderBindings = bindings;
    const oldNative = { folder: "原日记", format: "YYYY-MM-DD", template: "原模板.md", custom: "PRESERVE" };
    await records["daily-notes"].saveData(oldNative);
    records["daily-notes"].instance.options = structuredClone(oldNative);
    plugin.settings.journalDirectory = "插件旧日记";
    plugin.settings.review.outputDir = "原复盘";
    Object.assign(plugin.settings.englishDiary, { englishDirectory: "原英文", englishDirectoryMode: "custom", expressionDirectory: "原表达", expressionDirectoryMode: "custom" });
    plugin.settings.pdfReading.originalDirectory = "原PDF";
    for (const folder of ["来源甲", "来源乙", "知识成果", "原日记", "原复盘", "原英文", "原表达", "原PDF"]) await fixture.write(`${folder}/keep.md`, folder);
    const oldEnglish = structuredClone(plugin.settings.englishDiary);
    const unchanged = await service.previewDirectoryPlan(bindings, [], { mode: "existing" });
    assert.deepEqual(unchanged.create, []);
    assert.deepEqual(unchanged.moves, []);
    await service.applyDirectoryPlan(unchanged);
    assert.equal(records["daily-notes"].instance.options.folder, "原日记");
    assert.equal(plugin.settings.journalDirectory, "插件旧日记");
    assert.equal(plugin.settings.review.outputDir, "原复盘");
    assert.deepEqual(plugin.settings.englishDiary, oldEnglish, "omitted module choices retain the original custom paths");
    assert.equal(plugin.settings.pdfReading.originalDirectory, "原PDF");
    const moduleDirectories = { journal: "新日记", review: "新复盘", english: "新英文", expressions: "新表达", pdfOriginal: "新PDF" };
    const before = await inventory(root);
    const existing = await service.previewDirectoryPlan(plugin.settings.knowledgeBase.folderBindings, [], { mode: "existing", moduleDirectories });
    assert(existing.issues.some(issue => issue.includes("原位置已失效")), "existing mode does not invent module directories");
    assert.deepEqual(existing.create, []);
    const plan = await service.previewDirectoryPlan(plugin.settings.knowledgeBase.folderBindings, [], { mode: "build", moduleDirectories });
    assert.deepEqual(plan.issues, []);
    assert.deepEqual(new Set(plan.create), new Set(Object.values(moduleDirectories)));
    assert.deepEqual(plan.moves, [], "both old and selected module output paths stay in place");
    assert.deepEqual(await inventory(root), before, "module path preview does not save native or plugin settings");
    assert.equal(plugin.settings.review.outputDir, "原复盘");
    const applied = await service.applyDirectoryPlan(plan);
    assert.deepEqual(applied.created, plan.create);
    assert.equal(plugin.settings.journalDirectory, "新日记");
    assert.equal(records["daily-notes"].instance.options.folder, "新日记");
    assert.deepEqual(await records["daily-notes"].loadData(), { ...oldNative, folder: "新日记" });
    assert.equal(plugin.settings.review.outputDir, "新复盘");
    assert.equal(plugin.settings.englishDiary.englishDirectory, "新英文");
    assert.equal(plugin.settings.englishDiary.englishDirectoryMode, "custom");
    assert(plugin.settings.englishDiary.legacyEnglishDirectories.includes("原英文"));
    assert.equal(plugin.settings.englishDiary.expressionDirectory, "新表达");
    assert(plugin.settings.englishDiary.legacyExpressionDirectories.includes("原表达"));
    assert.equal(plugin.settings.pdfReading.originalDirectory, "新PDF");
    for (const folder of ["原日记", "原复盘", "原英文", "原表达", "原PDF"]) assert.equal(await fs.readFile(path.join(root, folder, "keep.md"), "utf8"), folder);
    await fixture.write("新英文/后来英文稿.md", "NEW ENGLISH");
    await fixture.write("新表达/后来表达.md", "NEW EXPRESSION");
    await fixture.write("后来复盘/keep.md", "LATER REVIEW CHOICE");
    plugin.settings.review.outputDir = "后来复盘";
    await records["daily-notes"].saveData({ ...oldNative, folder: "新日记", format: "YYYY/MM/DD" });
    records["daily-notes"].instance.options = { ...oldNative, folder: "新日记", format: "YYYY/MM/DD" };
    const restarted = new EchoInkKnowledgeSurfaceService(plugin);
    await restarted.getInitializationState();
    await restarted.linking.ready;
    await restarted.restoreOriginalDirectories();
    assert.equal(plugin.settings.journalDirectory, "插件旧日记");
    assert.equal(records["daily-notes"].instance.options.folder, "原日记", "module settings restore from the persistent journal after restart");
    assert.equal(records["daily-notes"].instance.options.format, "YYYY/MM/DD", "restoring a folder retains later native format edits");
    assert.equal(plugin.settings.review.outputDir, "后来复盘", "later independent module choices win");
    assert.equal(plugin.settings.englishDiary.englishDirectory, "原英文");
    assert(plugin.settings.englishDiary.legacyEnglishDirectories.includes("新英文"), "new output content keeps a readable legacy scope");
    assert.equal(plugin.settings.englishDiary.expressionDirectory, "原表达");
    assert.equal(plugin.settings.pdfReading.originalDirectory, "原PDF");
    assert.equal(await fs.readFile(path.join(root, "新英文/后来英文稿.md"), "utf8"), "NEW ENGLISH");
    assert.equal(await fs.readFile(path.join(root, "新表达/后来表达.md"), "utf8"), "NEW EXPRESSION");
    assert.equal(await fs.stat(path.join(root, "新PDF")).catch(() => null), null);
    assert.equal(await fs.stat(path.join(root, "新日记")).catch(() => null), null);
  } finally { fixture.release(); }
}

async function assertPersistentOptionalModuleRestore(root: string) {
  const fixture = await fixtureAt(root);
  try {
    const { plugin, service, records } = fixture;
    await records["daily-notes"].saveData({});
    records["daily-notes"].instance.options = {};
    for (const folder of ["来源甲", "来源乙", "知识成果"]) await fixture.write(`${folder}/keep.md`, folder);
    plugin.settings.knowledgeBase.folderBindings = sourceBindings();
    const originalJournal = plugin.settings.journalDirectory;
    const plan = await service.previewDirectoryPlan(sourceBindings(), [], { mode: "build", moduleDirectories: { journal: "新日记", english: "新英文", pdfOriginal: "新PDF" } });
    await service.applyDirectoryPlan(plan);
    plugin.settings.englishDiary.englishDirectoryMode = "role";
    let failOnce = true;
    plugin.saveSettings = async () => { if (failOnce) { failOnce = false; throw new Error("fixture restore settings unavailable"); } };
    await assert.rejects(service.restoreOriginalDirectories(), /restore settings unavailable/u);
    assert((await fs.stat(path.join(root, "新PDF"))).isDirectory(), "failed settings restoration stops before removing empty module folders");
    await service.restoreOriginalDirectories();
    assert.equal(plugin.settings.journalDirectory, originalJournal);
    assert.deepEqual(await records["daily-notes"].loadData(), {}, "an originally missing native folder remains absent");
    assert.equal(Object.hasOwn(plugin.settings.pdfReading, "originalDirectory"), false);
    assert.equal(plugin.settings.englishDiary.englishDirectoryMode, "role", "later edits to a module setting remain intact");
    assert.equal(plugin.settings.englishDiary.englishDirectory, "新英文");
    assert((await fs.stat(path.join(root, "新英文"))).isDirectory(), "a retained current module path must not be removed just because it is empty");
  } finally { fixture.release(); }
}

async function assertModuleDirectoryFailureRecovery(root: string) {
  const fixture = await fixtureAt(root);
  try {
    const { plugin, service, records } = fixture;
    const native = { folder: "原日记", format: "YYYY-MM-DD", template: "原模板.md" };
    await records["daily-notes"].saveData(native);
    records["daily-notes"].instance.options = structuredClone(native);
    plugin.settings.journalDirectory = "插件旧日记";
    const original = structuredClone(plugin.settings);
    await fixture.write("课程/资料.md", "SOURCE TO RESTORE");
    const moduleDirectories = { journal: "新日记", review: "新复盘", english: "新英文", expressions: "新表达", pdfOriginal: "新PDF" };
    const plan = await service.previewDirectoryPlan(sourceBindings(), ["来源甲", "来源乙", "知识成果"], { mode: "build", moduleDirectories });
    let failOnce = true;
    plugin.saveSettings = async () => { if (failOnce && plugin.settings.knowledgeBase.folderBindings.configured) { failOnce = false; throw new Error("module settings save failed"); } };
    await assert.rejects(service.applyDirectoryPlan(plan), /module settings save failed/u);
    assert.deepEqual(records["daily-notes"].instance.options, native, "native in-memory options roll back");
    assert.deepEqual(await records["daily-notes"].loadData(), native, "native persisted options roll back");
    assert.equal(plugin.settings.journalDirectory, original.journalDirectory);
    assert.equal(plugin.settings.review.outputDir, original.review.outputDir);
    assert.deepEqual(plugin.settings.englishDiary, original.englishDiary);
    assert.deepEqual(plugin.settings.pdfReading, original.pdfReading);
    for (const directory of Object.values(moduleDirectories)) assert.equal(await fs.stat(path.join(root, directory)).catch(() => null), null, "only the transaction's empty new directories are removed");
    assert.equal(await fs.readFile(path.join(root, "课程/资料.md"), "utf8"), "SOURCE TO RESTORE");
  } finally { fixture.release(); }
}

async function assertRootJournalChoice(root: string) {
  const fixture = await fixtureAt(root);
  try {
    fixture.records["daily-notes"].instance.options = { folder: "原日记", format: "YYYY-MM-DD" };
    await fixture.write("2026-10-19.md", "ROOT DAILY NOTE");
    await fixture.write("课程.md", "ORDINARY NOTE");
    const plan = await fixture.service.previewDirectoryPlan(sourceBindings(), ["来源甲", "来源乙", "知识成果"], { mode: "build", moduleDirectories: { journal: "" } });
    assert.deepEqual(plan.issues, []);
    assert(!plan.moves.some(move => move.from === "2026-10-19.md"), "choosing the Vault root protects matching native daily notes");
    assert(plan.moves.some(move => move.from === "课程.md"));
    await fixture.service.applyDirectoryPlan(plan);
    assert.equal(fixture.records["daily-notes"].instance.options.folder, "");
    assert.equal(await fs.readFile(path.join(root, "2026-10-19.md"), "utf8"), "ROOT DAILY NOTE");
  } finally { fixture.release(); }
}

export async function runModuleFolderStorageTests(root: string): Promise<void> {
  assertBindingCompatibility();
  await assertImmediateBindingSave(path.join(root, "binding-save"));
  await assertInitializationSnapshot(path.join(root, "initialization"));
  await assertRollbackRetainsNewUserContent(path.join(root, "rollback-user-content"));
  await assertModuleDirectoryChoices(path.join(root, "module-directories"));
  await assertModuleDirectoryFailureRecovery(path.join(root, "module-failure"));
  await assertRootJournalChoice(path.join(root, "root-journal"));
  await assertPersistentOptionalModuleRestore(path.join(root, "optional-module-restore"));
  console.log("P12 module folder storage and transactions: PASS");
}
