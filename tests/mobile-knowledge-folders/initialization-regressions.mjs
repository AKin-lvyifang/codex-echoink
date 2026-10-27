import assert from "node:assert/strict";
import fs from "node:fs/promises";

export async function runInitializationRegressions(api, fixture, build) {
  const plain = value => JSON.parse(JSON.stringify(value));
  let passed = 0;
  const test = async (name, run) => { await run(); console.log(`PASS initialization regression ${++passed}: ${name}`); };
  const mkdir = (f, path) => fs.mkdir(f.full(path), { recursive: true });
  const existing = (f, modules) => ({ kind: "initialize", mode: "existing", bindings: f.settings.knowledgeBase.folderBindings ?? api.emptyKnowledgeFolderBindings(), createPaths: [], moduleDirectories: modules });
  const enableCustom = f => Object.assign(f.settings.englishDiary, { enabled: true, englishDirectoryMode: "custom", expressionDirectoryMode: "custom", englishDirectory: "old-english", expressionDirectory: "old-expressions" });
  const receipt = async (f, id) => JSON.parse(await f.read(`.obsidian/plugins/echoink/mobile/knowledge-folders-v1/${id}.json`)).payload;

  await test("disabled modules ignore stale requests, retain every setting, and protect stored, role and historical files", async () => {
    const f = await fixture({ "source.md": "SOURCE", "old-reviews/r.md": "REVIEW", "old-english/e.md": "ENGLISH", "old-expressions/x.md": "EXPRESSION", "mapped/英文日记/a.md": "ROLE", "historical/h.md": "HISTORY" });
    Object.assign(f.settings.review, { enabled: false, outputDir: "old-reviews" });
    Object.assign(f.settings.englishDiary, { enabled: false, englishDirectory: "old-english", expressionDirectory: "old-expressions", englishDirectoryMode: "role", legacyEnglishDirectories: ["outputs/.english-diary/diaries", "historical"] });
    const bindings = api.emptyKnowledgeFolderBindings(); Object.assign(bindings.roles.outputs, { enabled: false, readPaths: ["mapped"], writePath: "mapped" }); f.settings.knowledgeBase.folderBindings = bindings;
    const before = plain({ review: f.settings.review, english: f.settings.englishDiary });
    const request = build(); request.bindings.roles.outputs = structuredClone(bindings.roles.outputs);
    request.moduleDirectories = { review: "missing-review", english: "/ignored-old-request", expressions: "missing-expression" };
    f.reset(); const preview = await f.service.preview(request); assert.deepEqual(plain(preview.issues), []); assert.equal(f.calls.writes.length, 0);
    assert.ok(preview.moves.every(move => !/^(old-reviews|old-english|old-expressions|mapped|historical)\//u.test(move.from)));
    const result = await f.service.apply(preview.token); assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(plain({ review: f.settings.review, english: f.settings.englishDiary }), before);
    assert.ok(!JSON.stringify(await receipt(f, result.recordId)).includes(".english-diary"));
    assert.deepEqual(plain((await f.cold().read()).moduleDirectories), { journal: "journal" });
  });

  await test("role paths follow draft Outputs and retain role mode and hidden compatibility lists", async () => {
    const f = await fixture({}); Object.assign(f.settings.englishDiary, { enabled: true, englishDirectoryMode: "role", expressionDirectoryMode: "role", legacyEnglishDirectories: ["outputs/.english-diary/diaries"] });
    const before = plain(f.settings.englishDiary), request = build();
    Object.assign(request.bindings.roles.outputs, { enabled: true, readPaths: ["本次输出"], writePath: "本次输出" }); request.createPaths.push("本次输出");
    request.moduleDirectories = { english: "outputs/英文日记", expressions: "outputs/英文日记/表达库" };
    const preview = await f.service.preview(request); assert.deepEqual(plain(preview.issues), []);
    assert.ok(preview.create.includes("本次输出/英文日记/表达库"));
    const result = await f.service.apply(preview.token); assert.equal(result.status, "completed"); assert.deepEqual(plain(f.settings.englishDiary), before);
    assert.equal((await f.service.read()).moduleDirectories.english, "本次输出/英文日记");
  });

  await test("only enabled role locations require Outputs; custom locations remain independent", async () => {
    const f = await fixture({}); f.settings.englishDiary.enabled = true;
    const missing = await f.service.preview(existing(f)); assert.match(missing.issues.join("；"), /请先绑定输出目录/u); assert.doesNotMatch(missing.issues.join("；"), /原位置已失效/u);
    enableCustom(f); await mkdir(f, "old-english"); await mkdir(f, "old-expressions");
    const custom = await f.service.preview(existing(f)); assert.deepEqual(plain(custom.issues), []); assert.equal((await f.service.apply(custom.token)).status, "completed");
  });

  await test("custom directory changes record only added history entries; cold restore preserves older and newer entries", async () => {
    const f = await fixture({}); enableCustom(f); await mkdir(f, "old-english"); await mkdir(f, "old-expressions");
    f.settings.englishDiary.legacyEnglishDirectories = ["outputs/.english-diary/diaries"];
    f.settings.englishDiary.legacyExpressionDirectories = [".echoink/english-diary/expressions"];
    const request = build(); request.moduleDirectories = { english: "new-english", expressions: "new-expressions" };
    const preview = await f.service.preview(request); assert.deepEqual(plain(preview.issues), []);
    const result = await f.service.apply(preview.token); assert.equal(result.status, "completed");
    const record = await receipt(f, result.recordId); assert.equal(record.schema, 2);
    assert.deepEqual(record.before.legacyEnglish, []); assert.deepEqual(record.after.legacyEnglish, ["old-english"]);
    assert.deepEqual(record.after.legacyExpressions, ["old-expressions"]); assert.ok(!JSON.stringify(record).includes(".english-diary"));
    f.settings.englishDiary.legacyEnglishDirectories.push("later-location");
    const cold = f.cold(), restore = await cold.preview({ kind: "restore", recordId: result.recordId }); assert.deepEqual(plain(restore.issues), []);
    assert.equal((await cold.apply(restore.token)).status, "completed"); assert.equal(f.settings.englishDiary.englishDirectory, "old-english");
    assert.deepEqual(plain(f.settings.englishDiary.legacyEnglishDirectories), ["outputs/.english-diary/diaries", "later-location"]);
    assert.deepEqual(plain(f.settings.englishDiary.legacyExpressionDirectories), [".echoink/english-diary/expressions"]);
  });

  await test("an already-known history entry is never removed during restore", async () => {
    const f = await fixture({}); enableCustom(f); await mkdir(f, "old-expressions");
    f.settings.englishDiary.legacyEnglishDirectories = ["old-english", "outputs/.english-diary/diaries"];
    const request = build(); request.moduleDirectories = { english: "new-english" };
    const result = await f.service.apply((await f.service.preview(request)).token); assert.equal(result.status, "completed");
    const record = await receipt(f, result.recordId); assert.equal(record.after.legacyEnglish, undefined);
    const cold = f.cold(); assert.equal((await cold.apply((await cold.preview({ kind: "restore", recordId: result.recordId })).token)).status, "completed");
    assert.deepEqual(plain(f.settings.englishDiary.legacyEnglishDirectories), ["old-english", "outputs/.english-diary/diaries"]);
  });

  await test("unsafe original fields fail during preview with field context and zero writes", async () => {
    for (const field of ["journal", "nativeJournal", "english"]) {
      const f = await fixture({}); let modules;
      if (field === "journal") { f.settings.journalDirectory = "/08-生活/日记"; modules = { journal: "new-journal" }; }
      if (field === "nativeJournal") { f.app.internalPlugins.plugins["daily-notes"].instance.options.folder = "/08-生活/日记"; modules = { journal: "new-journal" }; }
      if (field === "english") { enableCustom(f); f.settings.englishDiary.englishDirectory = "outputs/.english-diary/diaries"; modules = { english: "new-english" }; }
      const request = build(); request.moduleDirectories = modules; f.reset();
      const preview = await f.service.preview(request); assert.match(preview.issues.join("；"), field === "nativeJournal" ? /Obsidian 日记文件夹/u : field === "journal" ? /EchoInk 日记目录/u : /英文日记目录/u);
      await assert.rejects(f.service.apply(preview.token)); assert.deepEqual(f.calls.writes, []); assert.deepEqual(plain((await f.cold().read()).restoreRecords), []);
    }
  });

  await test("traversal, absolute, drive, hidden, control and node_modules paths never become operation paths", async () => {
    for (const unsafe of ["../outside", "/absolute", "C:/drive", "notes/.hidden", "notes/\u0001bad", "notes/node_modules/cache"]) {
      const f = await fixture({}); enableCustom(f); const request = build(); request.moduleDirectories = { english: unsafe };
      f.reset(); const preview = await f.service.preview(request); assert.ok(preview.issues.length, unsafe); await assert.rejects(f.service.apply(preview.token)); assert.deepEqual(f.calls.writes, []);
      assert.throws(() => api.safePath(unsafe));
    }
  });

  await test("absent history and mode options restore without producing a full-list receipt", async () => {
    const f = await fixture({}); enableCustom(f); delete f.settings.englishDiary.legacyEnglishDirectories; await mkdir(f, "old-expressions");
    const request = build(); request.moduleDirectories = { english: "new-english" };
    const result = await f.service.apply((await f.service.preview(request)).token); assert.equal(result.status, "completed");
    const record = await receipt(f, result.recordId); assert.equal(record.before.legacyEnglish, null);
    const cold = f.cold(); assert.equal((await cold.apply((await cold.preview({ kind: "restore", recordId: result.recordId })).token)).status, "completed");
    assert.equal(Object.hasOwn(f.settings.englishDiary, "legacyEnglishDirectories"), false);
  });

  await test("restore keeps a custom mode when new content retains its directory", async () => {
    const f = await fixture({ "mapped/keep.md": "OUTPUT" });
    Object.assign(f.settings.englishDiary, { enabled: true, englishDirectoryMode: "role", expressionDirectoryMode: "role" });
    const bindings = api.emptyKnowledgeFolderBindings(); Object.assign(bindings.roles.outputs, { enabled: true, readPaths: ["mapped"], writePath: "mapped" }); f.settings.knowledgeBase.folderBindings = bindings;
    const request = build(); request.bindings.roles.outputs = structuredClone(bindings.roles.outputs); request.moduleDirectories = { english: "new-custom-english" };
    const result = await f.service.apply((await f.service.preview(request)).token); assert.equal(result.status, "completed");
    await f.write("new-custom-english/manual.md", "NEW USER CONTENT");
    const cold = f.cold(), preview = await cold.preview({ kind: "restore", recordId: result.recordId }); assert.deepEqual(plain(preview.issues), []);
    assert.equal((await cold.apply(preview.token)).status, "completed");
    assert.equal(f.settings.englishDiary.englishDirectory, "new-custom-english"); assert.equal(f.settings.englishDiary.englishDirectoryMode, "custom");
    assert.equal(await f.read("new-custom-english/manual.md"), "NEW USER CONTENT");
  });

  await test("schema 1 receipts remain readable and restorable", async () => {
    const f = await fixture({}); const snapshot = { bindings: null, journal: "journal", nativeJournal: "journal", review: f.settings.review.outputDir,
      english: f.settings.englishDiary.englishDirectory, expressions: f.settings.englishDiary.expressionDirectory, legacyEnglish: [], legacyExpressions: [] };
    f.settings.journalDirectory = "new-journal"; f.app.internalPlugins.plugins["daily-notes"].instance.options.folder = "new-journal";
    const record = { schema: 1, id: "folders-old-format", createdAt: Date.now(), kind: "initialize", status: "completed", before: snapshot,
      after: { ...snapshot, journal: "new-journal", nativeJournal: "new-journal" }, positions: [], actions: [{ kind: "settings", state: "completed" }], created: [], linkHashes: {} };
    await f.write(`.obsidian/plugins/echoink/mobile/knowledge-folders-v1/${record.id}.json`, JSON.stringify({ schema: 1, payload: record, checksum: api.digest(record) }));
    const cold = f.cold(); assert.equal((await cold.read()).restoreRecords[0].status, "completed");
    const preview = await cold.preview({ kind: "restore", recordId: record.id }); assert.deepEqual(plain(preview.issues), []);
    assert.equal((await cold.apply(preview.token)).status, "completed"); assert.equal(f.settings.journalDirectory, "journal");
    assert.equal(f.app.internalPlugins.plugins["daily-notes"].instance.options.folder, "journal");
  });
  await test("schema 2 never accepts missing or non-object change snapshots even with a valid checksum", async () => {
    const f = await fixture({});
    for (const invalid of [{ before: "invalid", after: {} }, { before: {} }]) {
      const record = { schema: 2, id: "folders-invalid-delta", createdAt: Date.now(), kind: "initialize", status: "completed",
        positions: [], actions: [], created: [], linkHashes: {}, ...invalid };
      await f.write(`.obsidian/plugins/echoink/mobile/knowledge-folders-v1/${record.id}.json`, JSON.stringify({ schema: 1, payload: record, checksum: api.digest(record) }));
      await assert.rejects(f.cold().read(), /目录事务/u);
    }
  });
  return passed;
}
