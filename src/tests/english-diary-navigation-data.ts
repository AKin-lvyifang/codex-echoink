import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MarkdownView, TFile, TFolder, type App } from "obsidian";
import { EnglishDiaryRepository, EnglishDiaryRepositoryError } from "../english-diary/repository";
import { EnglishDiaryVaultPort } from "../english-diary/vault-port";
import { EnglishDiaryService } from "../english-diary/service";
import { splitDiaryBlocks } from "../english-diary/model";
import { loadEnglishDiaryPageData } from "../home/english-diary-page-data";
import type { DiaryFilePort, DiaryRecord, DiaryResult, DiarySource } from "../english-diary/types";
import { paidTestAccess } from "./membership-access";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const options = { stateDirectory: ".state/english", englishDirectory: "English", expressionDirectory: "Expressions" };
const statePath = (id: string): string => `${options.stateDirectory}/${id}.json`;
const now = new Date("2027-01-02T12:00:00-08:00");
class MemoryFiles implements DiaryFilePort {
  data = new Map<string, string>();
  mutations: string[] = [];
  failRead = new Set<string>();
  failList = new Set<string>();
  duplicateLists = false;
  async read(path: string): Promise<string | null> {
    if (this.failRead.has(path)) throw new Error("fixture read failed");
    return this.data.get(path) ?? null;
  }
  async list(directory: string): Promise<string[]> {
    if (this.failList.has(directory)) throw new Error("fixture list failed");
    const paths = [...this.data.keys()].filter(path => path.startsWith(`${directory}/`));
    return this.duplicateLists ? [...paths, ...paths] : paths;
  }
  async write(path: string, content: string, expected: string | null): Promise<void> {
    assert.equal(this.data.get(path) ?? null, expected);
    this.mutations.push(`write:${path}`); this.data.set(path, content);
  }
  async move(from: string, to: string, expected?: string): Promise<void> {
    assert.ok(this.data.has(from)); assert.equal(this.data.has(to), false);
    if (expected !== undefined) assert.equal(this.data.get(from), expected);
    this.mutations.push(`move:${from}`); this.data.set(to, this.data.get(from)!); this.data.delete(from);
  }
  async remove(path: string, expected: string): Promise<void> {
    assert.equal(this.data.get(path), expected);
    this.mutations.push(`remove:${path}`); this.data.delete(path);
  }
}
const source = (name: string, date: string): DiarySource => ({ path: `Daily/${name}.md`, title: name, date, content: `私密原稿-${name}` });
function result(record: DiaryRecord, input: DiarySource, operationId: string, generatedAt: string, expressionCount = 1): DiaryResult {
  const english = `I **raised** my concerns.\nA [second line](https://example.com).`;
  return {
    schema: 1, operationId, journalId: record.id, sourcePath: input.path, sourceTitle: input.title, date: input.date,
    sourceFingerprint: hash(input.content), english, englishFingerprint: hash(english), generatedAt, provider: "offline-fixture", warnings: [], alignments: [],
    expressions: expressionCount ? [{
      id: "phrase-1", term: "raise concerns", type: "phrase", meaning: "提出顾虑", category: "沟通", scene: "讨论方案", example: "I raised concerns.",
      reason: "提出顾虑", usage: "沟通", sourceExcerpt: input.content, targetExcerpt: "raised my concerns", status: "verified"
    }] : []
  };
}
function editState(files: MemoryFiles, record: DiaryRecord, edit: (state: any) => void): void {
  const state = JSON.parse(files.data.get(statePath(record.id))!); edit(state);
  files.data.set(statePath(record.id), JSON.stringify(state));
}
async function publish(files: MemoryFiles, repo: EnglishDiaryRepository, input: DiarySource, operationId: string, generatedAt: string, expressionCount = 1) {
  files.data.set(input.path, input.content);
  const record = await repo.get(input);
  return repo.publish(record, result(record, input, operationId, generatedAt, expressionCount), { sourceUnchanged: async () => true });
}
async function seeded() {
  const files = new MemoryFiles(), repo = new EnglishDiaryRepository(files, options, paidTestAccess);
  const a = source("A", "2000-01-01"), b = source("B", "2000-01-02"), c = source("C", "2000-01-01");
  let ar = await publish(files, repo, a, "a-first", "2027-01-01T07:10:00Z"); // Local Dec 31.
  ar = await repo.publish(ar, result(ar, a, "a-second", "2027-01-01T07:30:00Z"), { sourceUnchanged: async () => true });
  const br = await publish(files, repo, b, "b-zero", "2027-01-01T23:00:00-08:00", 0);
  const cr = await publish(files, repo, c, "c-first", "2027-01-01T23:30:00-08:00");
  return { files, repo, a, b, c, ar, br, cr };
}
async function unchangedRead<T>(files: MemoryFiles, read: () => Promise<T>): Promise<T> {
  const before = new Map(files.data); files.mutations = [];
  const value = await read();
  assert.deepEqual(files.mutations, [], "navigation reads must not write, recover, migrate, move or remove");
  assert.deepEqual(files.data, before, "all existing bytes remain unchanged");
  return value;
}

/** Actual Vault port with output-only roots; the original lives in Daily, as in production. */
function nativePortFixture(files: MemoryFiles) {
  const entries = new Map<string, TFile>(), views: MarkdownView[] = [], diskReads: string[] = [];
  let editorSaves = 0;
  const file = (value: string): TFile => {
    if (!entries.has(value)) entries.set(value, Object.assign(Object.create(TFile.prototype), {
      path: value, name: value.split("/").at(-1), basename: value.split("/").at(-1)!.replace(/\.[^.]+$/, ""), extension: value.split(".").at(-1)
    }));
    return entries.get(value)!;
  };
  const exists = (value: string) => files.data.has(value) || [...files.data.keys()].some(path => path.startsWith(`${value}/`));
  const unexpectedWrite = () => { files.mutations.push("unexpected native write"); throw new Error("navigation must not save or mutate files"); };
  const app = {
    workspace: { getLeavesOfType: () => views.map(view => ({ view })) },
    vault: {
      adapter: {
        exists: async (value: string) => exists(value),
        read: async (value: string) => { if (!files.data.has(value)) throw new Error("missing fixture file"); return files.data.get(value)!; },
        list: async (root: string) => {
          const paths = [...files.data.keys()].filter(path => path.startsWith(`${root}/`));
          return { files: paths.filter(path => !path.slice(root.length + 1).includes("/")),
            folders: [...new Set(paths.filter(path => path.slice(root.length + 1).includes("/")).map(path => `${root}/${path.slice(root.length + 1).split("/")[0]}`))] };
        },
        write: unexpectedWrite, process: unexpectedWrite, mkdir: unexpectedWrite, remove: unexpectedWrite, rename: unexpectedWrite
      },
      getAbstractFileByPath: (value: string) => files.data.has(value) ? file(value)
        : exists(value) ? Object.assign(Object.create(TFolder.prototype), { path: value }) : null,
      read: async (entry: TFile) => { diskReads.push(entry.path); return files.data.get(entry.path)!; },
      create: unexpectedWrite, createFolder: unexpectedWrite, process: unexpectedWrite, trash: unexpectedWrite
    }
  } as unknown as App;
  return {
    port: new EnglishDiaryVaultPort(app, [options.stateDirectory, options.englishDirectory, options.expressionDirectory]),
    diskReads, editorSaves: () => editorSaves,
    editor: (sourcePath: string, content: string) => {
      const view = Object.assign(Object.create(MarkdownView.prototype), { file: file(sourcePath),
        editor: { getValue: () => content, setValue: unexpectedWrite }, save: async () => { editorSaves++; unexpectedWrite(); } });
      views.push(view); return view;
    }
  };
}

export async function runEnglishDiaryNavigationDataTests(): Promise<void> {
  let cases = 0;
  // The formal service keeps excluded source text locally, but the navigation preview must not show it.
  {
    const files = new MemoryFiles(), repo = new EnglishDiaryRepository(files, options, paidTestAccess);
    const secret = "**PRIVATE-MEDICAL-DETAIL**", allowed = "I kept this allowed sentence.";
    const input = { ...source("privacy-preview", "2027-01-02"), content: `${secret}\n${allowed}\n${secret}` };
    files.data.set(input.path, input.content);
    const blocks = splitDiaryBlocks(input.content);
    const privacy = { sourceFingerprint: hash(input.content), rules: blocks.map((block, index) => ({ blockId: block.id, mode: index === 0 ? "exclude" as const : "preserve" as const })) };
    const service = new EnglishDiaryService(repo, {
      generate: async () => { throw new Error("preserve/exclude fixture must not call a model"); },
      skill: async () => { throw new Error("preserve/exclude fixture must not load a Skill"); }, providerLabel: () => "unused"
    }, async () => ({ ...input, content: files.data.get(input.path)! }), paidTestAccess);
    const saved = await service.generate(input.path, { privacy, operationId: "privacy-preview" });
    assert.equal(saved.result!.english, input.content, "the real service retains the original private blocks in the full local English");
    const fullEnglish = files.data.get(saved.englishPath)!;
    assert.equal(fullEnglish.split(secret).length - 1, 2);
    const listed = await unchangedRead(files, () => repo.listSavedDiaries());
    assert.deepEqual(listed.errors, []);
    assert.equal(listed.entries[0].preview, allowed, "private text at the beginning and all same-text occurrences stay out of preview");
    assert.equal(files.data.get(saved.englishPath), fullEnglish, "summary filtering never changes the complete English file");
    files.data.set(input.path, `${input.content}\nLater source changes.`);
    const changed = await unchangedRead(files, () => repo.listSavedDiaries());
    assert.equal(changed.entries[0].sourceChanged, true); assert.equal(changed.entries[0].preview, "");
    files.data.delete(input.path);
    const missing = await unchangedRead(files, () => repo.listSavedDiaries());
    assert.equal(missing.entries[0].missingSource, true); assert.equal(missing.entries[0].preview, "");
    files.data.set(input.path, input.content);
    const editedEnglish = `${fullEnglish}\nA manual English addition.`;
    files.data.set(saved.englishPath, editedEnglish);
    const edited = await unchangedRead(files, () => repo.listSavedDiaries());
    assert.equal(edited.entries[0].englishModified, true); assert.equal(edited.entries[0].preview, "", "manual English edits with excluded blocks require a conservative empty preview");
    assert.equal(files.data.get(saved.englishPath), editedEnglish);
    files.data.set(saved.englishPath, fullEnglish);
    editState(files, saved, state => { state.privacy.rules[0].blockId = "unverifiable-excluded-block"; });
    const unverifiable = await unchangedRead(files, () => repo.listSavedDiaries());
    assert.equal(unverifiable.entries[0].preview, ""); cases++;
  }
  // Without excluded blocks, pure translation and explicitly sendable preserve still have useful previews.
  {
    for (const mode of ["translate", "preserve"] as const) {
      const files = new MemoryFiles(), repo = new EnglishDiaryRepository(files, options, paidTestAccess);
      const input = { ...source(`allowed-${mode}`, "2027-01-02"), content: `Allowed ${mode} sentence.` };
      files.data.set(input.path, input.content);
      const initial = await repo.get(input);
      await repo.savePrivacy(initial, { sourceFingerprint: hash(input.content), rules: splitDiaryBlocks(input.content).map(block => ({ blockId: block.id, mode })) });
      const output = result(initial, input, `allowed-${mode}`, "2027-01-02T12:00:00-08:00", 0);
      output.english = input.content; output.englishFingerprint = hash(output.english);
      await repo.publish(initial, output, { sourceUnchanged: async () => true });
      for (const nextSource of [input.content, `${input.content}\nA later change.`, null]) {
        if (nextSource === null) files.data.delete(input.path); else files.data.set(input.path, nextSource);
        const list = await unchangedRead(files, () => repo.listSavedDiaries());
        assert.equal(list.entries[0].preview, input.content, `${mode} with no private exclusions keeps the existing preview rule`);
      }
    }
    cases++;
  }
  // Native output roots must not block existing source reads or become writable source roots.
  {
    const { files, a, ar } = await seeded();
    const native = nativePortFixture(files), repository = new EnglishDiaryRepository(native.port, options);
    const invalidPath = (error: unknown) => error instanceof EnglishDiaryRepositoryError && error.code === "INVALID_PATH";
    await assert.rejects(() => native.port.read(a.path), invalidPath, "ordinary output read still excludes Daily");
    const saved = await unchangedRead(files, () => repository.listSavedDiaries());
    assert.deepEqual(saved.errors, [], "a saved original outside output roots must not cause INVALID_PATH");
    assert.equal(saved.entries.length, 3); assert.equal(saved.entries.find(entry => entry.id === ar.id)!.sourceChanged, false);
    const draft = `${a.content}\n未保存的原稿私密段落`;
    native.editor(a.path, draft);
    native.diskReads.length = 0;
    const live = await unchangedRead(files, () => repository.listSavedDiaries());
    assert.equal(live.entries.find(entry => entry.id === ar.id)!.sourceChanged, true, "native unsaved content takes priority over disk");
    assert.equal(native.diskReads.includes(a.path), false); assert.equal(native.editorSaves(), 0);
    assert.ok(live.entries.every(entry => !entry.preview.includes("私密段落")));
    await unchangedRead(files, () => assert.rejects(() => native.port.write(a.path, "must not write original", a.content), invalidPath));
    files.data.delete(a.path);
    const missing = await unchangedRead(files, () => repository.listSavedDiaries());
    assert.deepEqual(missing.errors, []); assert.equal(missing.entries.find(entry => entry.id === ar.id)!.missingSource, true);
    const page = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(page.diaryCount, 3, "a missing source still counts when its saved English exists"); assert.deepEqual(page.errors, {});
    assert.equal(native.editorSaves(), 0); cases++;
  }
  // Confirmation inspection computes the same empty identity/path as get, without creating state.
  {
    const files = new MemoryFiles(), input = source("new-entry", "2027-01-02");
    files.data.set(input.path, input.content);
    const repository = new EnglishDiaryRepository(files, options, paidTestAccess);
    const empty = await unchangedRead(files, () => repository.inspect(input));
    assert.equal(empty.result, null); assert.equal(empty.pending, null);
    assert.equal(files.data.has(statePath(empty.id)), false);
    assert.equal(files.data.has(empty.englishPath), false);
    files.data.set(empty.englishPath, "An unrelated existing English note.");
    const collision = await unchangedRead(files, () => repository.inspect(input));
    assert.equal(collision.id, empty.id); assert.notEqual(collision.englishPath, empty.englishPath);
    assert.equal(collision.englishModified, false);
    assert.deepEqual(await repository.get(input), collision, "get and inspect share identity and occupied-path handling"); cases++;
  }
  // A pending transaction and expression journal stay untouched before explicit confirmation.
  {
    const { files, a, ar } = await seeded();
    const pending = result(ar, a, "awaiting-confirmation", "2027-01-02T12:00:00-08:00");
    const unfinishedEnglish = "English bytes from an interrupted save.";
    editState(files, ar, state => {
      const next = { ...state, result: pending, pending: null };
      state.pending = pending;
      state.transaction = { operationId: pending.operationId, changes: [{ path: state.englishPath, before: files.data.get(state.englishPath), after: unfinishedEnglish }], next };
    });
    files.data.set(ar.englishPath, unfinishedEnglish);
    files.data.set(`${options.stateDirectory}/expression-operation.json`, "Pending expression operation must not be recovered.");
    const repository = new EnglishDiaryRepository(files, {
      ...options, englishDirectory: "New English", expressionDirectory: "New Expressions",
      legacyEnglishDirectories: [options.englishDirectory], legacyExpressionDirectories: [options.expressionDirectory]
    });
    const inspected = await unchangedRead(files, () => repository.inspect(a));
    assert.equal(inspected.id, ar.id); assert.equal(inspected.englishPath, ar.englishPath);
    assert.equal(inspected.result!.operationId, "a-second"); assert.deepEqual(inspected.pending, pending);
    assert.equal(inspected.englishModified, true);
    files.data.delete(ar.englishPath);
    const missing = await unchangedRead(files, () => repository.inspect(a));
    assert.equal(missing.missingEnglish, true); assert.deepEqual(missing.pending, pending); cases++;
  }
  // Saved source paths own identity after a rename; malformed state remains a read error.
  {
    const { files, repo, a, ar } = await seeded();
    const renamed = { ...a, path: "Daily/renamed-source.md", title: "renamed-source" };
    await repo.renameSource(a.path, renamed.path);
    files.data.set(renamed.path, a.content); files.data.delete(a.path);
    const repository = new EnglishDiaryRepository(files, options);
    const inspected = await unchangedRead(files, () => repository.inspect(renamed));
    assert.equal(inspected.id, ar.id); assert.equal(inspected.sourcePath, renamed.path);
    assert.equal(inspected.result!.sourcePath, renamed.path);
    editState(files, ar, state => { state.pending = { schema: 99 }; });
    await unchangedRead(files, () => assert.rejects(() => repository.inspect(renamed), /状态损坏/)); cases++;
  }
  // Empty is a known zero; opening does not create a diary association.
  {
    const files = new MemoryFiles(), repository = new EnglishDiaryRepository(files, options);
    repository.get = async () => { throw new Error("navigation must never call get"); };
    const page = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.deepEqual([page.streak, page.expressionCount, page.diaryCount], [0, 0, 0]);
    assert.deepEqual(page.errors, {}); cases++;
  }
  // Current documents, unique library terms and generated days are separate measures.
  {
    const { files, a, ar, br, cr } = await seeded();
    files.data.set(a.path, `${a.content}\n后来写的私密原稿`);
    files.data.delete(cr.sourcePath);
    files.data.set(cr.englishPath, "# Manual English\n\nA **fresh** [line](https://example.com).\nNext line.");
    const repository = new EnglishDiaryRepository(files, options); // No paid/model access is needed to read.
    const page = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.deepEqual([page.streak, page.expressionCount, page.diaryCount], [2, 1, 3]);
    assert.deepEqual(page.activity, [
      { date: "2026-12-31", expressionCount: 2, generationCount: 2 },
      { date: "2027-01-01", expressionCount: 1, generationCount: 2 }
    ]);
    assert.equal(page.expressions[0].occurrences.length, 2, "the same term from two diaries is still one entry");
    assert.equal(page.diaries.find(entry => entry.id === ar.id)!.sourceChanged, true);
    const edited = page.diaries.find(entry => entry.id === cr.id)!;
    assert.equal(edited.missingSource, true); assert.equal(edited.englishModified, true);
    assert.equal(edited.preview, "Manual English A fresh line. Next line.");
    assert.equal(page.diaries.find(entry => entry.id === br.id)!.expressionCount, 0);
    for (const entry of page.diaries) {
      assert.ok(!entry.preview.includes("私密")); assert.ok(!/[\r\n]|\[\[|\*\*/.test(entry.preview));
      assert.ok(!entry.preview.includes("本篇表达收获")); assert.ok(!entry.preview.includes("source-fingerprint"));
    }
    files.data.delete(br.englishPath);
    const missing = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(missing.diaryCount, 2); assert.equal(missing.diaries.length, 3);
    assert.equal(missing.diaries.find(entry => entry.id === br.id)!.missingEnglish, true);
    assert.equal(missing.diaries.find(entry => entry.id === br.id)!.preview, "");
    assert.equal(missing.streak, 2, "deleting a result does not erase a successful generation day"); cases++;
  }
  // Old records prove only their current event; operation IDs and list paths are deduplicated.
  {
    const { files, ar, cr } = await seeded();
    editState(files, ar, state => { delete state.generationActivity; });
    editState(files, cr, state => { state.generationActivity.push({ operationId: "a-second", date: "2026-12-31", expressionCount: 1 }); });
    files.duplicateLists = true;
    const repository = new EnglishDiaryRepository(files, options);
    const diaries = await unchangedRead(files, () => repository.listSavedDiaries());
    assert.equal(diaries.entries.length, 3);
    // Real file adapters do not repeat paths, but an activity record can repeat an operation across states.
    files.duplicateLists = false;
    const activity = await unchangedRead(files, () => repository.listGenerationActivity({ readOnly: true }));
    assert.deepEqual(activity, [
      { date: "2026-12-31", expressionCount: 1, generationCount: 1 },
      { date: "2027-01-01", expressionCount: 1, generationCount: 2 }
    ]);
    assert.equal("generationActivity" in JSON.parse(files.data.get(statePath(ar.id))!), false, "legacy read must not backfill state"); cases++;
  }
  // Legacy expressions and previous configured directories can be projected without migration.
  {
    const { files, repo } = await seeded();
    const entry = (await repo.listExpressions())[0];
    const markdown = files.data.get(entry.path)!;
    files.data.delete(`${options.stateDirectory}/expressions/${entry.id}.json`);
    files.data.set(entry.path, markdown.replace(/<!-- echoink-expression-id: [a-f0-9]+ -->/, `<!-- echoink-expression:v1 ${Buffer.from(JSON.stringify(entry)).toString("base64")} -->`));
    const repository = new EnglishDiaryRepository(files, {
      ...options, englishDirectory: "New English", expressionDirectory: "New Expressions",
      legacyEnglishDirectories: [options.englishDirectory], legacyExpressionDirectories: [options.expressionDirectory]
    });
    const page = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(page.diaryCount, 3); assert.equal(page.expressionCount, 1); assert.deepEqual(page.errors, {});
    assert.equal(page.expressions[0].path, entry.path); cases++;
  }
  // Pending or cancelled work never becomes a success; interrupted transactions are not recovered by navigation.
  {
    const { files, repo, ar } = await seeded();
    const draft = source("draft", "2027-01-02"); files.data.set(draft.path, draft.content);
    const record = await repo.get(draft);
    editState(files, record, state => { state.pending = result(record, draft, "not-published", "2027-01-02T12:00:00-08:00"); });
    const repository = new EnglishDiaryRepository(files, options);
    const pending = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(pending.diaryCount, 3); assert.equal(pending.streak, 2);
    editState(files, ar, state => { state.transaction = { operationId: "interrupted", changes: [], next: { ...state, transaction: undefined } }; });
    const interrupted = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(interrupted.diaryCount, null); assert.equal(interrupted.streak, null); assert.equal(interrupted.expressionCount, null);
    assert.ok(interrupted.errors.diaries); assert.ok(interrupted.diaries.length > 0);
    editState(files, ar, state => { state.transaction = null; });
    files.data.set(`${options.stateDirectory}/expression-operation.json`, "unrecovered operation");
    const operation = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(operation.expressionCount, null); assert.equal(operation.diaryCount, 3); assert.equal(operation.streak, 2); cases++;
  }
  // Bad state and filesystem failures keep healthy rows but never report an incomplete total as zero.
  {
    const { files, ar } = await seeded();
    const repository = new EnglishDiaryRepository(files, options);
    const corruptPath = `${options.stateDirectory}/${"f".repeat(24)}.json`;
    files.data.set(corruptPath, "{broken");
    const list = await unchangedRead(files, () => repository.listSavedDiaries());
    assert.equal(list.entries.length, 3); assert.equal(list.errors.length, 1);
    const page = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.deepEqual([page.streak, page.expressionCount, page.diaryCount], [null, null, null]);
    files.data.delete(corruptPath);
    files.failRead.add(ar.englishPath);
    const readFailure = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(readFailure.diaryCount, null); assert.equal(readFailure.streak, 2); assert.ok(readFailure.errors.diaries);
    files.failRead.clear(); files.failList.add(options.expressionDirectory);
    const expressionFailure = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(expressionFailure.expressionCount, null); assert.equal(expressionFailure.diaryCount, 3); assert.equal(expressionFailure.streak, 2);
    files.failList.clear(); files.failList.add(options.stateDirectory);
    const listingFailure = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(listingFailure.diaryCount, null); assert.ok(listingFailure.errors.diaries); cases++;
  }
  // Dates are stored diary dates, never guessed from paths or save time; ordering remains stable.
  {
    const { files, ar, br, cr } = await seeded();
    editState(files, ar, state => { delete state.result.date; state.result.sourceTitle = "An undated entry"; state.result.generatedAt = "2027-01-02T12:00:00-08:00"; });
    editState(files, br, state => { state.result.date = "2000-01-01"; state.result.sourceTitle = "B"; });
    editState(files, cr, state => { state.result.date = "2000-01-01"; state.result.sourceTitle = "A"; });
    const list = await unchangedRead(files, () => new EnglishDiaryRepository(files, options).listSavedDiaries());
    assert.deepEqual(list.entries.map(entry => entry.title), ["An undated entry", "A", "B"]);
    assert.equal(list.entries[0].date, ""); assert.equal(list.entries[0].sourcePath, ar.sourcePath); cases++;
  }
  // A malformed event/result is a read error, rather than a fabricated no-activity/zero-diary state.
  {
    const { files, ar } = await seeded();
    editState(files, ar, state => { state.generationActivity = [{ operationId: "bad-day", date: "2026-02-30", expressionCount: 0 }]; });
    const repository = new EnglishDiaryRepository(files, options);
    const badEvent = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(badEvent.streak, null); assert.equal(badEvent.diaryCount, 3);
    editState(files, ar, state => { state.generationActivity = []; });
    const missingEvent = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(missingEvent.streak, null, "a saved success with missing events must not fabricate zero activity");
    editState(files, ar, state => { delete state.generationActivity; state.result.expressions = null; });
    const badResult = await unchangedRead(files, () => loadEnglishDiaryPageData({ repository }, now));
    assert.equal(badResult.streak, null); assert.equal(badResult.diaryCount, null); assert.ok(badResult.errors.diaries); cases++;
  }
  console.log(`P9 English diary navigation data: ${cases} scenario groups passed.`);
}
