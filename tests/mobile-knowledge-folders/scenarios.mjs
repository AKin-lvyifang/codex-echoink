import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { folderFixture } from "./host.mjs";

export async function runFolderScenarios(api, root) {
  let passed = 0, sequence = 0;
  const fixture = seed => folderFixture(api, path.join(root, String(++sequence)), seed);
  const test = async (name, run) => { await run(); console.log(`PASS ${++passed} ${name}`); };
  const plain = value => JSON.parse(JSON.stringify(value));
  const build = () => {
    const bindings = api.emptyKnowledgeFolderBindings();
    Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["资料/原文"], writePath: "资料/原文" });
    Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["资料/知识"], writePath: "资料/知识" });
    return { kind: "initialize", mode: "build", bindings, createPaths: ["资料/原文", "资料/知识"] };
  };
  await test("metadata-only read preserves absent Todo, legacy deep/multi bindings and never initializes files", async () => {
    const f = await fixture({ "deep/a/file.md": "A", "other/file.md": "B", "large/unrelated.bin": new Uint8Array(1024 * 1024) });
    const bindings = api.emptyKnowledgeFolderBindings(); Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["deep/a", "other"], writePath: "other", allowedSubdirectories: ["approved"], allowedSubdirectoryRoots: ["deep/a"] });
    f.settings.knowledgeBase.folderBindings = bindings; f.reset();
    const snapshot = await f.service.read();
    assert.deepEqual(plain(snapshot.bindings), plain(bindings)); assert.equal(snapshot.todoSourcePath, "EchoInk/待办.md"); assert.equal(snapshot.todoSourceExists, false);
    assert.equal(snapshot.moduleDirectories.journal, "journal"); assert.deepEqual(f.calls.binary, []); assert.deepEqual(f.calls.writes, []); assert.deepEqual(f.calls.removes, []);
    await f.write("EchoInk/待办.md", "# Existing source"); assert.equal((await f.service.read()).todoSourceExists, true);
  });
  await test("binding saves only configuration, reject stale/invalid destinations and roll back failed saves", async () => {
    const f = await fixture({ "sources/a.md": "A", "nested/more/b.md": "B" });
    let before = await f.service.read(), next = api.emptyKnowledgeFolderBindings();
    Object.assign(next.roles.raw, { enabled: true, readPaths: ["sources", "nested/more"], writePath: "nested/more" }); next.collectionTargets = { web: "sources", wechat: "nested/more" };
    f.reset(); const saved = await f.service.saveBindings(next, before.token);
    assert.equal(saved.bindings.revision, 1); assert.equal(saved.bindings.collectionTargets.wechat, "nested/more"); assert.equal(f.calls.renames.length, 0);
    assert.ok(f.calls.writes.every(item => item === ".obsidian/plugins/echoink/data.json"));
    await assert.rejects(f.service.saveBindings(next, before.token), /已变化/u);
    before = await f.service.read(); next = structuredClone(before.bindings); next.collectionTargets.web = "outside";
    await assert.rejects(f.service.saveBindings(next, before.token), /收藏目的地/u);
    next = structuredClone(before.bindings); next.roles.raw.searchEnabled = false;
    f.hooks({ save() { throw Error("settings-save-failed"); } });
    await assert.rejects(f.service.saveBindings(next, before.token), /settings-save-failed/u); assert.deepEqual(plain(f.settings.knowledgeBase.folderBindings), plain(before.bindings));
  });
  await test("disabling Sources retains saved collection paths, withdraws access, and re-enabling revalidates them", async () => {
    const f = await fixture({ "deep/sources/a.md": "A", "more/b.md": "B" }), config = api.emptyKnowledgeFolderBindings();
    Object.assign(config.roles.raw, { enabled: true, readPaths: ["deep/sources", "more"], writePath: "deep/sources" }); config.collectionTargets = { web: "deep/sources", wechat: "more" };
    f.settings.knowledgeBase.folderBindings = config;
    let snapshot = await f.service.read(), next = structuredClone(config); next.roles.raw.enabled = false;
    snapshot = await f.service.saveBindings(next, snapshot.token);
    assert.deepEqual(plain(snapshot.bindings.collectionTargets), plain(config.collectionTargets)); assert.deepEqual(plain(snapshot.bindings.roles.raw.readPaths), ["deep/sources", "more"]);
    assert.equal(api.knowledgeCollectionDirectory(snapshot.bindings, "web"), null);
    next = structuredClone(snapshot.bindings); next.roles.raw.enabled = true;
    snapshot = await f.service.saveBindings(next, snapshot.token); assert.equal(api.knowledgeCollectionDirectory(snapshot.bindings, "wechat"), "more");
  });
  await test("initialization preview and cancellation write zero files and hash only actual move/link impacts", async () => {
    const f = await fixture({ "notes/a.md": "A", "notes/picture.png": new Uint8Array([0, 255, 5]), "journal/2026-10-20.md": "JOURNAL", "finance/transactions/row.md": "FINANCE", "EchoInk/待办.md": "TODO", "outputs/english-diary/keep.md": "ENGLISH", "custom-ledger/ledger.base": "properties:\n  note.echoink_id:\n    displayName: ID\n", "custom-ledger/transactions/row.md": "CUSTOM FINANCE", "templates/daily.md": "NATIVE TEMPLATE" });
    const request = build(); f.reset(); const preview = await f.service.preview(request);
    assert.deepEqual(plain(preview.issues), []); assert.ok(preview.moves.some(move => move.from === "notes/picture.png"));
    for (const excluded of ["journal/2026-10-20.md", "finance/transactions/row.md", "EchoInk/待办.md", "custom-ledger/transactions/row.md", "templates/daily.md"]) assert.ok(preview.excluded.some(item => item.path === excluded));
    assert.deepEqual(f.calls.writes, []); assert.deepEqual(f.calls.removes, []); assert.equal(f.calls.model, 0);
    assert.ok(!f.calls.binary.includes("finance/transactions/row.md"));
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(f.service.apply(preview.token, cancelled.signal), /停止/u); assert.deepEqual(f.calls.writes, []);
  });
  await test("real disk relocation updates actual metadata-confirmed links, preserves binary bytes and cold receipts", async () => {
    const f = await fixture({ "notes/a.md": "# Original\n", "notes/b.md": "[[notes/a#Heading|alias]]\n", "notes/p.png": new Uint8Array([0, 255, 5]) });
    const preview = await f.service.preview(build()), applied = await f.service.apply(preview.token);
    assert.equal(applied.status, "completed", JSON.stringify(applied)); assert.equal(applied.moved.length, 3); assert.equal(f.calls.renames.length, 3);
    assert.equal(await f.read("资料/原文/notes/a.md"), "# Original\n"); assert.equal(await f.read("资料/原文/notes/b.md"), "[[资料/原文/notes/a#Heading|alias]]\n");
    assert.deepEqual([...await fs.readFile(f.full("资料/原文/notes/p.png"))], [0, 255, 5]);
    const cold = f.cold(); assert.equal((await cold.read()).restoreRecords[0].status, "completed");
    await assert.rejects(f.service.apply(preview.token), /失效或已使用/u);
    const undo = await cold.preview({ kind: "restore", recordId: applied.recordId }); assert.deepEqual(plain(undo.issues), []);
    const restored = await cold.apply(undo.token); assert.equal(restored.status, "completed");
    assert.equal(await f.read("notes/b.md"), "[[notes/a#Heading|alias]]\n"); assert.equal(await f.read("notes/a.md"), "# Original\n");
    assert.equal(await f.adapter.exists("资料/原文"), true, "created directories are retained, never removed");
  });
  await test("only moving plans require a complete link index; explicit link repair works with automatic updates off", async () => {
    const f = await fixture({ "notes/a.md": "A", "notes/b.md": "[[notes/a]]\n" }), cache = f.app.metadataCache.getFileCache;
    f.app.metadataCache.getFileCache = () => null; f.reset();
    await f.service.read(); assert.deepEqual(f.calls.binary, []);
    await assert.rejects(f.service.preview(build()), /索引尚未就绪/u); assert.deepEqual(f.calls.writes, []);
    const config = api.emptyKnowledgeFolderBindings(); Object.assign(config.roles.raw, { enabled: true, readPaths: ["notes"], writePath: "notes" });
    const bindingOnly = await f.service.preview({ kind: "initialize", mode: "existing", bindings: config, createPaths: [] }); assert.deepEqual(plain(bindingOnly.issues), []); assert.deepEqual(f.calls.writes, []);
    f.app.metadataCache.getFileCache = cache; f.app.vault.getConfig = () => false;
    const result = await f.service.apply((await f.service.preview(build())).token); assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(await f.read("资料/原文/notes/b.md"), "[[资料/原文/notes/a]]\n");
  });
  await test("metadata/settings changes and same-metadata source bytes require a fresh zero-write confirmation", async () => {
    const f = await fixture({ "source.md": "BEFORE", "journal/large.bin": new Uint8Array(1024 * 1024) });
    let preview = await f.service.preview(build()); assert.ok(!f.calls.binary.includes("journal/large.bin"));
    await f.write("added-unrelated.md", "new metadata"); f.reset();
    let result = await f.service.apply(preview.token); assert.equal(result.status, "reconfirm"); assert.deepEqual(f.calls.writes, []);
    preview = result.preview; const stat = await fs.stat(f.full("source.md"));
    await fs.writeFile(f.full("source.md"), "AFTER!"); await fs.utimes(f.full("source.md"), stat.atime, stat.mtime); f.reset();
    result = await f.service.apply(preview.token); assert.equal(result.status, "reconfirm"); assert.deepEqual(f.calls.writes, []);
    preview = result.preview; f.settings.review.outputDir = "different/reviews"; f.reset();
    result = await f.service.apply(preview.token); assert.equal(result.status, "reconfirm"); assert.deepEqual(f.calls.writes, []); assert.equal(f.calls.model, 0);
  });
  await test("current permission is rechecked after durable intent and unknown operations never replay", async () => {
    const f = await fixture({ "source.md": "SOURCE" }); const preview = await f.service.preview(build());
    f.hooks({ write(relative, content) { if (relative.includes("knowledge-folders-v1/") && content.includes('"kind":"move"') && content.includes('"state":"prepared"')) f.settings.defaultPermission = "read-only"; } });
    const result = await f.service.apply(preview.token); assert.equal(result.status, "uncertain"); assert.equal(f.calls.renames.length, 0); assert.equal(await f.read("source.md"), "SOURCE");
    f.hooks({}); f.settings.defaultPermission = "workspace-write";
    const cold = f.cold(), snapshot = await cold.read(); assert.equal(snapshot.restoreRecords[0].status, "uncertain");
    const retry = await cold.preview(build()); await assert.rejects(cold.apply(retry.token), /未知/u); assert.equal(f.calls.renames.length, 0);
    assert.ok((await cold.preview({ kind: "restore", recordId: result.recordId })).issues.some(item => item.includes("未知")));
  });
  await test("a host move followed by failure remains physically preserved and cold-unknown without replay", async () => {
    const f = await fixture({ "a.md": "A", "b.md": "B" }); const preview = await f.service.preview(build()); let once = false;
    f.hooks({ afterRename() { if (!once) { once = true; throw Error("after-physical-rename-failure"); } } });
    const result = await f.service.apply(preview.token); assert.equal(result.status, "uncertain"); assert.equal(f.calls.renames.length, 1); assert.equal(await f.read("资料/原文/a.md"), "A"); assert.equal(await f.read("b.md"), "B");
    f.hooks({}); const cold = f.cold(); assert.equal((await cold.read()).restoreRecords[0].status, "uncertain");
    const retry = await cold.preview(build()); await assert.rejects(cold.apply(retry.token), /未知/u); assert.equal(f.calls.renames.length, 1);
  });
  await test("cancellation stops later actions while completed receipts alone can be restored", async () => {
    const f = await fixture({ "a.md": "A", "b.md": "B" }), controller = new AbortController();
    const preview = await f.service.preview(build()); f.hooks({ afterRename() { controller.abort(); } });
    const result = await f.service.apply(preview.token, controller.signal); assert.equal(result.status, "partial"); assert.equal(result.moved.length, 1); assert.equal(await f.read("b.md"), "B");
    f.hooks({}); const undo = await f.cold().preview({ kind: "restore", recordId: result.recordId }); assert.deepEqual(plain(undo.issues), []);
    const cold = f.cold(), reviewed = await cold.preview({ kind: "restore", recordId: result.recordId }); assert.equal((await cold.apply(reviewed.token)).status, "completed"); assert.equal(await f.read("a.md"), "A");
  });
  await test("restore preserves external edits, occupied originals, new files and all user directories", async () => {
    const f = await fixture({ "a.md": "A", "b.md": "B", "c.md": "C" });
    const result = await f.service.apply((await f.service.preview(build())).token); assert.equal(result.status, "completed");
    await f.write("资料/原文/a.md", "EXTERNALLY EDITED"); await f.write("b.md", "OCCUPIED ORIGINAL"); await f.write("资料/原文/new.md", "NEW USER FILE");
    const cold = f.cold(), preview = await cold.preview({ kind: "restore", recordId: result.recordId });
    assert.equal(preview.excluded.length, 2); assert.deepEqual(plain(preview.moves), [{ from: "资料/原文/c.md", to: "c.md" }]);
    const restored = await cold.apply(preview.token); assert.equal(restored.moved.length, 1);
    assert.equal(await f.read("资料/原文/a.md"), "EXTERNALLY EDITED"); assert.equal(await f.read("b.md"), "OCCUPIED ORIGINAL"); assert.equal(await f.read("资料/原文/b.md"), "B"); assert.equal(await f.read("资料/原文/new.md"), "NEW USER FILE"); assert.equal(await f.read("c.md"), "C");
    assert.ok(f.calls.removes.every(item => item.startsWith(".obsidian/")));
  });
  await test("settings persistence failure after moving retains physical data plus an unknown settings intent", async () => {
    const f = await fixture({ "source.md": "SOURCE" }); const preview = await f.service.preview(build()); f.hooks({ save() { throw Error("settings-write-failed"); } });
    const result = await f.service.apply(preview.token); assert.equal(result.status, "uncertain"); assert.equal(await f.read("资料/原文/source.md"), "SOURCE");
    assert.equal((await f.cold().read()).restoreRecords[0].status, "uncertain");
  });
  await test("name suggestions use the actual model transport and usage observer, then exact scoped rename/restore", async () => {
    const f = await fixture({ "research-notes/a.md": "SOURCE", "outside/keep.md": "KEEP" }); const bindings = api.emptyKnowledgeFolderBindings();
    Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["research-notes"], writePath: "research-notes" }); f.settings.knowledgeBase.folderBindings = bindings; f.reset();
    const preview = await f.service.preview({ kind: "names", scopes: ["research-notes"] });
    assert.equal(f.calls.model, 1); assert.equal(f.calls.usage, 1); assert.equal(preview.moves[0].to, "研究资料（research-notes）"); assert.deepEqual(f.calls.writes, []);
    const result = await f.service.apply(preview.token); assert.equal(result.status, "completed"); assert.equal(await f.read("研究资料（research-notes）/a.md"), "SOURCE"); assert.equal(await f.read("outside/keep.md"), "KEEP");
    assert.equal(f.settings.knowledgeBase.folderBindings.roles.raw.writePath, "研究资料（research-notes）");
    await f.write("研究资料（research-notes）/new.md", "KEEP NEW");
    const cold = f.cold(), undo = await cold.preview({ kind: "restore", recordId: result.recordId }); assert.equal((await cold.apply(undo.token)).status, "completed");
    assert.equal(await f.read("research-notes/a.md"), "SOURCE"); assert.equal(await f.read("研究资料（research-notes）/new.md"), "KEEP NEW");
    assert.deepEqual(plain(f.settings.knowledgeBase.folderBindings.roles.raw.readPaths), ["research-notes", "研究资料（research-notes）"]);
  });
  await test("restoring an empty renamed directory recreates its recorded original without deleting either directory", async () => {
    const f = await fixture({}); await fs.mkdir(f.full("research-notes/empty-child"), { recursive: true });
    const bindings = api.emptyKnowledgeFolderBindings(); Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["research-notes"], writePath: "research-notes" });
    f.settings.knowledgeBase.folderBindings = bindings; f.model('{"0":"空子目录","1":"研究资料"}');
    const named = await f.service.apply((await f.service.preview({ kind: "names", scopes: ["research-notes"] })).token); assert.equal(named.status, "completed", JSON.stringify(named));
    const cold = f.cold(), preview = await cold.preview({ kind: "restore", recordId: named.recordId }); assert.ok(preview.create.includes("research-notes"));
    const restored = await cold.apply(preview.token); assert.equal(restored.status, "completed", JSON.stringify(restored));
    assert.equal(await f.adapter.exists("research-notes/empty-child"), true); assert.equal(await f.adapter.exists("研究资料（research-notes）"), true);
    assert.equal(f.settings.knowledgeBase.folderBindings.roles.raw.writePath, "research-notes");
  });
  await test("module directories save real native journal settings and preserve prior English locations", async () => {
    const f = await fixture({ "source.md": "SOURCE", "journal/2026-10-20.md": "NATIVE" });
    const originalEnglish = f.settings.englishDiary.englishDirectory, request = build();
    request.moduleDirectories = { journal: "新日记", english: "新英文", expressions: "新表达", review: "新回顾", pdfOriginal: "新PDF" };
    const preview = await f.service.preview(request); assert.deepEqual(plain(preview.issues), []); assert.ok(!preview.moves.some(move => move.from === "journal/2026-10-20.md"));
    assert.equal((await f.service.apply(preview.token)).status, "completed");
    const cold = await f.cold().read(); assert.equal(cold.moduleDirectories.journal, "新日记"); assert.equal(cold.moduleDirectories.pdfOriginal, "新PDF"); assert.equal(cold.todoSourcePath, "EchoInk/待办.md");
    assert.ok(f.settings.englishDiary.legacyEnglishDirectories.includes(originalEnglish)); assert.equal(await f.read("journal/2026-10-20.md"), "NATIVE");
  });
  await test("revoking write permission during native settings load prevents the actual native save", async () => {
    const f = await fixture({ "source.md": "SOURCE" }), request = build(); request.moduleDirectories = { journal: "新日记" };
    const preview = await f.service.preview(request); f.hooks({ nativeLoad() { f.settings.defaultPermission = "read-only"; } });
    const result = await f.service.apply(preview.token); assert.equal(result.status, "uncertain"); assert.ok(!f.calls.writes.includes(".obsidian/daily-notes.json"));
    assert.equal(f.app.internalPlugins.plugins["daily-notes"].instance.options.folder, "journal");
  });
  await test("shared child creation consent never grants cross-root moves or a deletion capability", async () => {
    const bindings = api.emptyKnowledgeFolderBindings(); Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["first", "second"], writePath: "first", allowedSubdirectories: ["approved/deep"], allowedSubdirectoryRoots: ["first"] });
    assert.equal(api.knowledgeMayCreateCategoryDirectory(bindings, "first/approved"), true); assert.equal(api.knowledgeMayCreateCategoryDirectory(bindings, "second/approved"), false); assert.equal(api.knowledgeMayOrganizeMove(bindings, "first/a.md", "second/a.md"), false);
  });
  console.log(`PASS ${passed} mobile knowledge folder service groups on registered real-disk fixtures; initialization preview writes=0; no user deletion; name-model usage is measured separately`);
}
