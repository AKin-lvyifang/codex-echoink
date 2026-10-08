import { paidTestAccess } from "./membership-access";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EnglishDiaryRepository as ProductionDiaryRepository, EnglishDiaryRepositoryError, normalizeDiaryPath } from "../english-diary/repository";
import { expressionIdentityMarker, parseExpressionMarkdown, renderExpressionMarkdown } from "../english-diary/markdown";
import { HIDDEN_EXPRESSION_DIRECTORY } from "../english-diary/types";
import type { DiaryFilePort, DiaryRecord, DiaryResult, DiarySource } from "../english-diary/types";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const options = { stateDirectory: ".test-state/english", englishDirectory: "EchoInk/英文日记", expressionDirectory: "EchoInk/表达库" };
type Event = { kind: "write" | "remove" | "move"; path: string; content?: string; phase: "before" | "after" };

class MemoryFiles implements DiaryFilePort {
  data = new Map<string, string>();
  events: Event[] = [];
  hook?: (event: Event) => void;
  async read(path: string) { return this.data.get(path) ?? null; }
  async list(directory: string) { return [...this.data.keys()].filter((path) => path.startsWith(`${directory}/`)); }
  private emit(event: Event) { this.events.push(event); this.hook?.(event); }
  async write(path: string, content: string, expected: string | null) {
    this.emit({ kind: "write", path, content, phase: "before" });
    if ((this.data.get(path) ?? null) !== expected) throw new Error("expected-content conflict");
    this.data.set(path, content);
    this.emit({ kind: "write", path, content, phase: "after" });
  }
  async move(from: string, to: string, expected?: string) {
    this.emit({ kind: "move", path: from, phase: "before" });
    if (expected !== undefined && this.data.get(from) !== expected) throw new Error("move-content conflict");
    if (this.data.has(to) || !this.data.has(from)) throw new Error("move conflict");
    this.data.set(to, this.data.get(from)!);
    this.data.delete(from);
    this.emit({ kind: "move", path: to, phase: "after" });
  }
  async remove(path: string, expected: string) {
    this.emit({ kind: "remove", path, phase: "before" });
    if (this.data.get(path) !== expected) throw new Error("remove conflict");
    this.data.delete(path);
    this.emit({ kind: "remove", path, phase: "after" });
  }
}

function source(day = "2026-10-05", content = "今天记录了一件不会被复制到额外原稿文件的私人经历。") : DiarySource {
  return { path: `Daily/${day}.md`, title: day, date: day, content };
}
function result(record: DiaryRecord, input: DiarySource, sequence: number, meaning = "提出顾虑"): DiaryResult {
  const english = `I raised my concerns. Entry ${sequence}.`;
  return {
    schema: 1, operationId: `operation-${sequence}`, journalId: record.id,
    sourcePath: record.sourcePath, sourceTitle: input.title, date: input.date,
    sourceFingerprint: hash(input.content), english, englishFingerprint: hash(english),
    alignments: [], expressions: [{
      id: "phrase-1", term: "raise concerns", type: "phrase", meaning, category: "工作沟通",
      scene: "在会上指出风险", example: "I raised concerns about the plan.", reason: "主动提出具体顾虑",
      usage: "讨论计划时", sourceExcerpt: "提出顾虑", targetExcerpt: "raised my concerns", status: "verified"
    }], generatedAt: "2026-10-05T08:00:00Z", provider: "fixture", warnings: []
  };
}
const unchanged = { sourceUnchanged: async () => true };
const entryStatePath = (id: string) => `${options.stateDirectory}/expressions/${id}.json`;
const expressionBackup = (id: string, path: string) => `${options.stateDirectory}/expression-migration-backup/${id}-${hash(path).slice(0, 8)}.md`;
async function rejectsCode(action: Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof EnglishDiaryRepositoryError && error.code === code);
}
async function seeded() {
  const files = new MemoryFiles();
  const repo = new EnglishDiaryRepository(files, options);
  const input = source();
  files.data.set(input.path, input.content);
  const initial = await repo.get(input);
  const output = result(initial, input, 1);
  const record = await repo.publish(initial, output, unchanged);
  return { files, repo, input, output, record };
}

export async function runEnglishDiaryRepositoryTests(): Promise<void> {
  assert.equal(normalizeDiaryPath("Daily\\2026-10-05.md"), "Daily/2026-10-05.md");
  for (const path of ["../private", "/etc/passwd", "C:\\private", "a/../b", "a//b", "a\u0000b", "a\u001fb", "a\u007fb", "a\u0085b"]) {
    assert.throws(() => normalizeDiaryPath(path), (error: unknown) => error instanceof EnglishDiaryRepositoryError && error.code === "INVALID_PATH");
  }

  // Durable identity, ordinary Markdown, and same-source reuse without history files.
  {
    const { files, repo, input, output, record } = await seeded();
    assert.equal((await repo.get(input)).id, record.id);
    assert.match(files.data.get(record.englishPath)!, /原稿：\[\[Daily\/2026-10-05\|2026-10-05\]\]/);
    assert.match(files.data.get(record.englishPath)!, /## 本篇表达收获/);
    assert.equal(files.data.get(input.path), input.content);
    assert.equal([...files.data.values()].filter((content) => content.includes(input.content)).length, 1);
    const same = await repo.publish(record, { ...output, operationId: "duplicate", english: "Must not replace" }, unchanged);
    assert.equal(same.result!.operationId, output.operationId);
    assert.equal((await repo.listExpressions()).length, 1);
    const entry = (await repo.listExpressions())[0];
    assert.equal(entry.occurrences.length, 1);
    assert.match(entry.path, /\/raise concerns-[a-f0-9]{8}\.md$/);
    const expressionMarkdown = files.data.get(entry.path)!;
    assert.match(expressionMarkdown, /^# raise concerns\n\n短语 · 提出顾虑/);
    assert.ok(!expressionMarkdown.includes("<!-- echoink-expression:v1"));
    assert.equal(expressionMarkdown.trimEnd().split("\n").at(-1), expressionIdentityMarker(entry.id));
    const metadata = JSON.parse(files.data.get(entryStatePath(entry.id))!);
    assert.equal(metadata.entry.occurrences.length, 1);
    assert.equal(parseExpressionMarkdown(expressionMarkdown, entry.path, metadata.entry)!.id, entry.id);
    assert.equal((await files.list(options.stateDirectory)).filter((path) => /^[a-f0-9]{24}\.json$/.test(path.slice(options.stateDirectory.length + 1))).length, 1);
    assert.equal(JSON.parse(files.data.get(`${options.stateDirectory}/${record.id}.json`)!).transaction, null);
  }

  // Existing success + missing file is restored locally, while an existing user file is preserved.
  {
    const { files, repo, input, record } = await seeded();
    const original = files.data.get(record.englishPath)!;
    files.data.delete(record.englishPath);
    const missing = await repo.get(input);
    assert.equal(missing.missingEnglish, true);
    const restored = await repo.restore(missing);
    assert.equal(restored.missingEnglish, false);
    assert.equal(files.data.get(record.englishPath), original);
    files.data.set(record.englishPath, "My hand-written English");
    const untouched = await repo.restore(await repo.get(input));
    assert.equal(untouched.englishModified, true);
    assert.equal(files.data.get(record.englishPath), "My hand-written English");
  }

  // Confirmation captures the actual current file, and cannot authorize a later edit.
  {
    const { files, repo, input, record } = await seeded();
    const newerSource = { ...input, content: "原稿已修改" };
    files.data.set(record.englishPath, "Manual A");
    const loaded = await repo.get(newerSource);
    const next = result(record, newerSource, 2);
    await rejectsCode(repo.publish(loaded, next, unchanged), "FILE_MODIFIED");
    assert.equal((await repo.get(newerSource)).pending!.operationId, next.operationId);
    files.data.set(record.englishPath, "Manual B");
    await rejectsCode(repo.publish(loaded, next, { ...unchanged, overwriteModified: true }), "CONFLICT");
    assert.equal(files.data.get(record.englishPath), "Manual B");
    const refreshed = await repo.get(newerSource);
    const published = await repo.publish(refreshed, next, { ...unchanged, overwriteModified: true });
    assert.equal(published.englishModified, false);
  }

  // Archive failure leaves the old successful English and a model-free retry package.
  {
    const { files, repo, input, record } = await seeded();
    const oldEnglish = files.data.get(record.englishPath);
    const changed = { ...input, content: "第二段原稿" };
    const next = result(record, changed, 2);
    let injected = false;
    files.hook = (event) => {
      if (!injected && event.kind === "write" && event.phase === "after" && event.path.startsWith(options.expressionDirectory)) {
        injected = true;
        throw new Error("disk failed after write");
      }
    };
    await rejectsCode(repo.publish(record, next, unchanged), "SAVE_FAILED");
    files.hook = undefined;
    assert.equal(files.data.get(record.englishPath), oldEnglish);
    const pending = await repo.get(changed);
    assert.equal(pending.result!.operationId, "operation-1");
    assert.equal(pending.pending!.operationId, "operation-2");
    assert.equal((await repo.listExpressions())[0].occurrences.length, 1);
    const saved = await repo.publish(pending, pending.pending!, unchanged);
    assert.equal(saved.pending, null);
    assert.equal((await repo.listExpressions())[0].occurrences.length, 2);
    await repo.publish(saved, next, unchanged);
    assert.equal((await repo.listExpressions())[0].occurrences.length, 2);
  }

  // Source changes and cancellation after the English write both roll back before success.
  for (const cancel of [false, true]) {
    const { files, repo, input, record } = await seeded();
    const oldEnglish = files.data.get(record.englishPath);
    const changed = { ...input, content: "生成时的原稿" };
    const next = result(record, changed, 2);
    const controller = new AbortController();
    let current = true;
    let injected = false;
    files.hook = (event) => {
      if (!injected && event.kind === "write" && event.phase === "after" && event.path === record.englishPath) {
        injected = true;
        if (cancel) controller.abort();
        else current = false;
      }
    };
    await rejectsCode(repo.publish(record, next, { sourceUnchanged: async () => current, signal: controller.signal }), cancel ? "ABORTED" : "SOURCE_CHANGED");
    files.hook = undefined;
    assert.equal(files.data.get(record.englishPath), oldEnglish);
    const reloaded = await repo.get(changed);
    assert.equal(reloaded.result!.operationId, "operation-1");
    assert.equal(reloaded.pending!.operationId, "operation-2");
  }

  // A late source edit during the metadata commit cannot leave the new English published.
  {
    const { files, repo, input, record } = await seeded();
    const oldEnglish = files.data.get(record.englishPath);
    const changed = { ...input, content: "待生成内容" };
    let current = true;
    files.hook = (event) => {
      if (event.kind === "write" && event.phase === "after" && event.path.endsWith(`${record.id}.json`)) {
        const state = JSON.parse(event.content!);
        if (state.result?.operationId === "operation-2" && state.transaction === null) current = false;
      }
    };
    await rejectsCode(repo.publish(record, result(record, changed, 2), { sourceUnchanged: async () => current }), "SOURCE_CHANGED");
    files.hook = undefined;
    assert.equal(files.data.get(record.englishPath), oldEnglish);
    assert.equal((await repo.get(changed)).result!.operationId, "operation-1");
  }

  // Simulate a process disappearing after file writes but before the metadata commit.
  {
    const { files, repo, input, record } = await seeded();
    const oldEnglish = files.data.get(record.englishPath);
    const changed = { ...input, content: "中断后恢复" };
    let crashedImage: Map<string, string> | null = null;
    files.hook = (event) => {
      if (event.kind === "write" && event.phase === "after" && event.path === record.englishPath) crashedImage = new Map(files.data);
    };
    await repo.publish(record, result(record, changed, 2), unchanged);
    const restartedFiles = new MemoryFiles();
    restartedFiles.data = crashedImage!;
    const restarted = new EnglishDiaryRepository(restartedFiles, options);
    const recoverable = await restarted.get(changed);
    assert.equal(restartedFiles.data.get(record.englishPath), oldEnglish);
    assert.equal(recoverable.pending!.operationId, "operation-2");
    await restarted.publish(recoverable, recoverable.pending!, unchanged);
    assert.equal((await restarted.listExpressions())[0].occurrences.length, 2);
  }

  // Search is rebuilt from portable files; categories, notes, meanings and dates stay distinct.
  {
    const { files, repo, record } = await seeded();
    const firstEntry = (await repo.listExpressions())[0];
    const updated = await repo.updateExpression(firstEntry.id, { category: "我的分类", note: "要保留的用户备注" });
    assert.equal(updated.id, firstEntry.id);
    assert.match(updated.path, /\/我的分类\/raise concerns-[a-f0-9]{8}\.md$/);
    assert.equal(files.data.has(firstEntry.path), false);
    assert.ok(files.events.some((event) => event.kind === "move"));
    files.data.set(updated.path, files.data.get(updated.path)!.replace("\n要保留的用户备注\n", "\n在 Markdown 中改的备注\n"));
    const second = source("2026-10-06", "另一天");
    const secondRecord = await repo.get(second);
    const secondResult = result(secondRecord, second, 3);
    secondResult.expressions[0].term = "  RAISE   concerns ";
    await repo.publish(secondRecord, secondResult, unchanged);
    const rebuilt = await new EnglishDiaryRepository(files, options).listExpressions("2026-10-06", "我的分类");
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0].occurrences.length, 2);
    assert.equal(rebuilt[0].note, "在 Markdown 中改的备注");
    assert.equal(rebuilt[0].userCategory, true);
    const third = source("2026-10-07", "不同含义");
    const thirdRecord = await repo.get(third);
    await repo.publish(thirdRecord, result(thirdRecord, third, 4, "提高关注度"), unchanged);
    assert.equal((await repo.listExpressions()).length, 2);
    assert.equal((await repo.get(source())).id, record.id);
  }

  // Existing hash-only paths and metadata-at-top files remain readable and do not duplicate.
  {
    const { files, repo, input, record } = await seeded();
    const entry = (await repo.listExpressions())[0];
    const legacyPath = `${options.expressionDirectory}/工作沟通/${entry.id}.md`;
    const markdown = files.data.get(entry.path)!;
    const marker = `<!-- echoink-expression:v1 ${Buffer.from(JSON.stringify(entry)).toString("base64")} -->`;
    files.data.delete(entry.path);
    files.data.delete(entryStatePath(entry.id));
    files.data.set(legacyPath, `${marker}\n\n${markdown.replace(expressionIdentityMarker(entry.id), "").trimEnd()}\n`);
    assert.equal((await repo.listExpressions())[0].path, legacyPath);
    const noted = await repo.updateExpression(entry.id, { category: entry.category, note: "旧路径保留备注" });
    assert.equal(noted.path, legacyPath);
    const changed = { ...input, content: "更新后的原稿" };
    await repo.publish(record, result(record, changed, 2), unchanged);
    const reloaded = (await repo.listExpressions())[0];
    assert.equal(reloaded.path, legacyPath);
    assert.equal(reloaded.occurrences.length, 2);
    assert.equal(reloaded.note, "旧路径保留备注");
    assert.equal((await repo.listExpressions()).length, 1);
    const moved = await repo.updateExpression(entry.id, { category: "新的分类", note: reloaded.note });
    assert.equal(moved.id, entry.id);
    assert.match(moved.path, /\/新的分类\/raise concerns-[a-f0-9]{8}\.md$/);
    assert.equal(files.data.has(legacyPath), false);
    assert.match(files.data.get(moved.path)!, /# raise concerns\n/);
  }

  // Deleting one occurrence keeps other days. A changed-back original cannot resurrect it.
  {
    const { repo, input, record, output } = await seeded();
    let entry = (await repo.listExpressions())[0];
    const deletedId = entry.occurrences[0].id;
    const changed = { ...input, content: "另一次日记内容" };
    let saved = await repo.publish(record, result(record, changed, 2), unchanged);
    await repo.removeOccurrence(entry.id, deletedId);
    entry = (await repo.listExpressions())[0];
    assert.equal(entry.occurrences.length, 1);
    saved = await repo.publish(saved, { ...output, operationId: "operation-3" }, unchanged);
    assert.equal((await repo.listExpressions())[0].occurrences.length, 1);
    assert.equal((await repo.listExpressions())[0].occurrences.some((item) => item.id === deletedId), false);
    await repo.removeOccurrence(entry.id, entry.occurrences[0].id);
    const empty = (await repo.listExpressions())[0];
    assert.equal(empty.id, entry.id);
    assert.equal(empty.occurrences.length, 0);
    assert.ok(saved.result);
  }

  // Corrections update the current English and the corresponding archived occurrence together.
  {
    const { files, repo, input, record } = await seeded();
    let marked = await repo.markExpression(record, "phrase-1", "needs-review", "待核实这句的语气");
    assert.equal(marked.result!.expressions[0].status, "needs-review");
    assert.equal((await repo.listExpressions())[0].occurrences[0].reason, "待核实这句的语气");
    assert.match(files.data.get(record.englishPath)!, /这条说明待确认/);
    let injected = false;
    files.hook = (event) => {
      if (!injected && event.kind === "write" && event.phase === "before" && event.path === record.englishPath) {
        injected = true;
        throw new Error("correction save failed");
      }
    };
    await rejectsCode(repo.markExpression(marked, "phrase-1", "verified", "已人工修正的理由"), "SAVE_FAILED");
    files.hook = undefined;
    const pending = await repo.get(input);
    marked = await repo.publish(pending, pending.pending!, unchanged);
    assert.equal(marked.result!.expressions[0].reason, "已人工修正的理由");
    assert.equal((await repo.listExpressions())[0].occurrences[0].reason, "已人工修正的理由");
    assert.equal((await repo.listExpressions())[0].occurrences[0].status, "verified");
  }

  // Rename changes stable links, not identity, and never copies or modifies the original.
  {
    const { files, repo, input, record } = await seeded();
    await repo.savePrivacy(record, { sourceFingerprint: hash(input.content), rules: [{ blockId: "p1", mode: "exclude" }] });
    const newSource = { ...input, path: "Daily/改名后的原稿.md", title: "改名后的原稿" };
    await repo.renameSource(input.path, newSource.path);
    const renamed = await repo.get(newSource);
    assert.equal(renamed.id, record.id);
    assert.equal(renamed.englishPath, record.englishPath);
    assert.equal(renamed.privacy!.rules[0].mode, "exclude");
    assert.equal((await repo.listExpressions())[0].occurrences[0].sourcePath, newSource.path);
    assert.match(files.data.get(record.englishPath)!, /Daily\/改名后的原稿/);
    assert.equal(files.data.get(input.path), input.content);
    assert.equal(files.data.has(newSource.path), false);
    files.data.set(record.englishPath, `${files.data.get(record.englishPath)}\nMy extra paragraph.\n`);
    await repo.renameSource(newSource.path, "Daily/再次改名.md");
    const manualRenamed = await repo.get({ ...newSource, path: "Daily/再次改名.md" });
    assert.equal(manualRenamed.englishModified, true);
    assert.match(files.data.get(record.englishPath)!, /My extra paragraph/);
    assert.match(files.data.get(record.englishPath)!, /source: "Daily\/再次改名.md"/);
  }

  // New result paths never overwrite an unrelated user file, even with replacement permission.
  {
    const files = new MemoryFiles();
    const repo = new EnglishDiaryRepository(files, options);
    const input = source();
    const record = await repo.get(input);
    files.data.set(record.englishPath, "Unrelated user file");
    await rejectsCode(repo.publish(record, result(record, input, 1), { ...unchanged, overwriteModified: true }), "CONFLICT");
    assert.equal(files.data.get(record.englishPath), "Unrelated user file");
    assert.equal((await repo.get(input)).pending!.operationId, "operation-1");
  }

  // Rollback also respects a user edit occurring during the attempted write.
  {
    const { files, repo, input, record } = await seeded();
    const next = result(record, { ...input, content: "发生并发编辑" }, 2);
    let injected = false;
    files.hook = (event) => {
      if (!injected && event.kind === "write" && event.phase === "after" && event.path === record.englishPath) {
        injected = true;
        files.data.set(record.englishPath, "Concurrent user edit");
      }
    };
    await rejectsCode(repo.publish(record, next, unchanged), "SAVE_FAILED");
    files.hook = undefined;
    assert.equal(files.data.get(record.englishPath), "Concurrent user edit");
    assert.equal((await repo.get(input)).englishModified, true);
  }

  // Legacy migration persists full data first, then only removes the exact old comment.
  for (const failedPath of ["private", "markdown", "none"] as const) {
    const { files, repo } = await seeded();
    const entry = (await repo.listExpressions())[0];
    entry.note = "迁移前手写备注\n第二行也保留";
    const legacyPath = `${options.expressionDirectory}/工作沟通/${entry.id}.md`;
    const payload = `<!-- echoink-expression:v1 ${Buffer.from(JSON.stringify(entry)).toString("base64")} -->`;
    const original = `用户自写前言\n\n${payload}\n${renderExpressionMarkdown(entry).replace(expressionIdentityMarker(entry.id), "")}\n用户自写后记\n`;
    files.data.delete(entry.path);
    files.data.delete(entryStatePath(entry.id));
    files.data.set(legacyPath, original);
    let injected = false;
    files.hook = (event) => {
      if (!injected && event.phase === "before" && event.kind === "write"
        && event.path === (failedPath === "private" ? entryStatePath(entry.id) : failedPath === "markdown" ? legacyPath : "never")) {
        injected = true;
        throw new Error("migration write failed");
      }
    };
    if (failedPath !== "none") {
      await assert.rejects(repo.listExpressions());
      assert.equal(files.data.get(legacyPath), original);
      assert.equal(files.data.has(entryStatePath(entry.id)), failedPath === "markdown");
    }
    files.hook = undefined;
    const migrated = (await repo.listExpressions())[0];
    assert.equal(migrated.path, legacyPath);
    assert.equal(migrated.note, entry.note);
    assert.equal(files.data.get(legacyPath), `${original.replace(payload, "")}\n${expressionIdentityMarker(entry.id)}\n`);
    assert.ok(files.data.has(entryStatePath(entry.id)));
    assert.equal(files.data.has(entry.path), false);
    const stable = files.data.get(legacyPath);
    await repo.listExpressions();
    assert.equal(files.data.get(legacyPath), stable);
  }

  // Lost/damaged private data is surfaced without recreating or overwriting the note.
  for (const invalid of [null, "broken json"]) {
    const { files, repo } = await seeded();
    const entry = (await repo.listExpressions())[0];
    const original = files.data.get(entry.path);
    if (invalid === null) files.data.delete(entryStatePath(entry.id));
    else files.data.set(entryStatePath(entry.id), invalid);
    await rejectsCode(repo.listExpressions(), "INVALID_STATE");
    assert.equal(files.data.get(entry.path), original);
  }

  // Extra Markdown survives all supported edits; removing the last source retains the user's note.
  {
    const { files, repo, input, record } = await seeded();
    let entry = (await repo.listExpressions())[0];
    const prefix = "用户的前言\n\n", suffix = "\n用户的学习计划\n- 每周复习\n";
    files.data.set(entry.path, prefix + files.data.get(entry.path)! + suffix);
    entry = await repo.updateExpression(entry.id, { category: "我的分类", note: "独立于出处的备注" });
    const changed = { ...input, content: "再一次归档" };
    let saved = await repo.publish(record, result(record, changed, 2), unchanged);
    saved = await repo.markExpression(saved, "phrase-1", "needs-review", "这里是修正的说明");
    await repo.renameSource(input.path, "Daily/新的标题.md");
    entry = (await repo.listExpressions())[0];
    assert.equal(entry.occurrences.length, 2);
    assert.equal(entry.occurrences[1].reason, "这里是修正的说明");
    assert.ok(entry.occurrences.every((item) => item.sourcePath === "Daily/新的标题.md"));
    for (const occurrence of entry.occurrences) await repo.removeOccurrence(entry.id, occurrence.id);
    const retained = (await repo.listExpressions())[0];
    assert.equal(retained.occurrences.length, 0);
    assert.equal(retained.note, "独立于出处的备注");
    const markdown = files.data.get(retained.path)!;
    assert.ok(markdown.startsWith(prefix));
    assert.ok(markdown.endsWith(suffix));
    assert.match(markdown, /独立于出处的备注/);
    assert.doesNotMatch(markdown, /echoink-expression:v1/);
    assert.equal(JSON.parse(files.data.get(entryStatePath(entry.id))!).managedFingerprint, null);
    await repo.updateExpression(entry.id, { category: "我的分类", note: "最后仍能编辑备注" });
    assert.ok(files.data.get(retained.path)!.endsWith(suffix));
    assert.ok(saved.result);
  }

  // Unsupported external edits to an occurrence are never silently discarded by a correction.
  {
    const { files, repo, record } = await seeded();
    const entry = (await repo.listExpressions())[0];
    const customized = files.data.get(entry.path)!.replace("**本篇场景** 在会上指出风险", "**本篇场景** 用户重新写过这一段");
    files.data.set(entry.path, customized);
    await rejectsCode(repo.markExpression(record, "phrase-1", "needs-review"), "CONFLICT");
    assert.equal(files.data.get(entry.path), customized);
  }

  // A private-data or Markdown failure compensates both files, even after a successful write.
  for (const action of ["note", "move", "remove", "rename"] as const) {
    for (const target of ["private", "markdown"] as const) {
      const { files, repo, input } = await seeded();
      const entry = (await repo.listExpressions())[0];
      const before = new Map(files.data);
      let injected = false;
      files.hook = (event) => {
        if (!injected && event.kind === "write" && event.phase === "after"
          && (target === "private" ? event.path === entryStatePath(entry.id) : event.path.startsWith(options.expressionDirectory))) {
          injected = true;
          throw new Error("late write failure");
        }
      };
      const run = () => action === "note" ? repo.updateExpression(entry.id, { category: entry.category, note: "待保存备注" })
        : action === "move" ? repo.updateExpression(entry.id, { category: "新分类", note: "待保存备注" })
        : action === "remove" ? repo.removeOccurrence(entry.id, entry.occurrences[0].id)
        : repo.renameSource(input.path, "Daily/重命名.md");
      await assert.rejects(run());
      files.hook = undefined;
      assert.deepEqual(files.data, before, `${action}/${target} should preserve the previous files`);
      await run();
      const next = (await repo.listExpressions())[0];
      if (action === "remove") assert.equal(next.occurrences.length, 0);
      else if (action === "rename") assert.equal(next.occurrences[0].sourcePath, "Daily/重命名.md");
      else assert.equal(next.note, "待保存备注");
    }
  }

  // A process disappearing mid-action resumes the exact intent on the next repository access.
  for (const action of ["note", "move", "remove", "rename"] as const) {
    for (const point of ["private", "markdown", "complete"] as const) {
      const { files, repo, input, record } = await seeded();
      const entry = (await repo.listExpressions())[0];
      let snapshot: Map<string, string> | null = null;
      files.hook = (event) => {
        if (snapshot) return;
        const reached = point === "private" ? event.kind === "write" && event.phase === "after" && event.path === entryStatePath(entry.id)
          : point === "markdown" ? event.kind === "write" && event.phase === "after" && event.path.startsWith(options.expressionDirectory)
          : event.kind === "remove" && event.phase === "before" && event.path.endsWith("/expression-operation.json");
        if (reached) snapshot = new Map(files.data);
      };
      if (action === "note") await repo.updateExpression(entry.id, { category: entry.category, note: "中断后继续保存备注" });
      else if (action === "move") await repo.updateExpression(entry.id, { category: "新分类", note: "中断后继续保存备注" });
      else if (action === "remove") await repo.removeOccurrence(entry.id, entry.occurrences[0].id);
      else await repo.renameSource(input.path, "Daily/原稿的新名字.md");
      assert.ok(snapshot, `${action}/${point} captured a process image`);
      const restartedFiles = new MemoryFiles();
      restartedFiles.data = new Map(snapshot!);
      const restarted = new EnglishDiaryRepository(restartedFiles, options);
      const restored = (await restarted.listExpressions())[0];
      assert.equal(restartedFiles.data.has(`${options.stateDirectory}/expression-operation.json`), false);
      assert.equal(restored.id, entry.id);
      if (action === "remove") {
        assert.equal(restored.occurrences.length, 0);
        assert.ok(restartedFiles.data.has(entry.path));
      } else if (action === "rename") {
        assert.equal(restored.occurrences[0].sourcePath, "Daily/原稿的新名字.md");
        assert.equal((await restarted.get({ ...input, path: "Daily/原稿的新名字.md" })).id, record.id);
      } else {
        assert.equal(restored.note, "中断后继续保存备注");
        assert.match(restartedFiles.data.get(restored.path)!, /中断后继续保存备注/);
        if (action === "move") {
          assert.equal(restored.category, "新分类");
          assert.equal(restartedFiles.data.has(entry.path), false);
        }
      }
      const stable = new Map(restartedFiles.data);
      await restarted.listExpressions();
      assert.deepEqual(restartedFiles.data, stable);
    }
  }

  // A category move itself and interruption during rollback are both part of the same journal.
  for (const point of ["move", "rollback"] as const) {
    const { files, repo } = await seeded();
    const entry = (await repo.listExpressions())[0];
    let snapshot: Map<string, string> | null = null;
    let failed = false;
    files.hook = (event) => {
      if (point === "move" && event.kind === "move" && event.phase === "after" && !snapshot) snapshot = new Map(files.data);
      if (point === "rollback" && event.kind === "write" && event.phase === "after" && event.path.startsWith(options.expressionDirectory) && !failed) {
        failed = true;
        throw new Error("fail after markdown write");
      }
      if (point === "rollback" && event.kind === "write" && event.phase === "after"
        && event.path.endsWith("/expression-operation.json") && JSON.parse(event.content!).phase === "rollback") snapshot = new Map(files.data);
    };
    const task = repo.updateExpression(entry.id, { category: "临时分类", note: "修改后的备注" });
    if (point === "rollback") await assert.rejects(task);
    else await task;
    const restartedFiles = new MemoryFiles();
    restartedFiles.data = new Map(snapshot!);
    const restarted = new EnglishDiaryRepository(restartedFiles, options);
    const restored = (await restarted.listExpressions())[0];
    assert.equal(restored.category, point === "rollback" ? entry.category : "临时分类");
    assert.equal(restored.note, point === "rollback" ? entry.note : "修改后的备注");
    assert.equal(restartedFiles.data.has(`${options.stateDirectory}/expression-operation.json`), false);
  }

  // Library-first recovery recognizes only the explicit private expression JSON journal paths.
  {
    const { files, repo, input, record } = await seeded();
    const entry = (await repo.listExpressions())[0];
    const oldMarkdown = files.data.get(entry.path);
    let snapshot: Map<string, string> | null = null;
    files.hook = (event) => {
      if (event.kind === "write" && event.phase === "after" && event.path === entry.path) snapshot = new Map(files.data);
    };
    await repo.publish(record, result(record, { ...input, content: "归档后中断" }, 2), unchanged);
    const restartedFiles = new MemoryFiles();
    restartedFiles.data = new Map(snapshot!);
    const restarted = new EnglishDiaryRepository(restartedFiles, options);
    assert.equal((await restarted.listExpressions())[0].occurrences.length, 1);
    assert.equal(restartedFiles.data.get(entry.path), oldMarkdown);
    const pending = await restarted.get(input);
    await restarted.publish(pending, pending.pending!, unchanged);
    assert.equal((await restarted.listExpressions())[0].occurrences.length, 2);
    const badSnapshot = new MemoryFiles();
    badSnapshot.data = new Map(snapshot!);
    const statePath = `${options.stateDirectory}/${record.id}.json`;
    const state = JSON.parse(badSnapshot.data.get(statePath)!);
    state.transaction.changes[0].path = `${options.stateDirectory}/expressions/../unrelated.json`;
    badSnapshot.data.set(statePath, JSON.stringify(state));
    await assert.rejects(new EnglishDiaryRepository(badSnapshot, options).listExpressions());
  }

  // New installations archive only in the hidden product folder.
  {
    const files = new MemoryFiles();
    const repo = new EnglishDiaryRepository(files, { ...options, expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY });
    const input = source();
    const record = await repo.get(input);
    await repo.publish(record, result(record, input, 1), unchanged);
    const entry = (await repo.listExpressions())[0];
    assert.ok(entry.path.startsWith(`${HIDDEN_EXPRESSION_DIRECTORY}/`));
    assert.equal((await files.list(options.expressionDirectory)).length, 0);
    const updated = await repo.updateExpression(entry.id, { category: "新分类", note: "隐藏备注" });
    await repo.removeOccurrence(entry.id, updated.occurrences[0].id);
    assert.equal((await repo.listExpressions())[0].note, "隐藏备注");
    assert.equal((await repo.listExpressions())[0].occurrences.length, 0);
  }

  // Both old payload notes and short-ID notes move with exact hidden backups; user files stay put.
  for (const base64 of [true, false]) {
    const { files, repo, record } = await seeded();
    let entry = (await repo.listExpressions())[0];
    entry = await repo.updateExpression(entry.id, { category: entry.category, note: "迁移时保留的备注\n第二行" });
    let original = `用户前言\n${files.data.get(entry.path)}\n用户后记\n`;
    if (base64) {
      const payload = `<!-- echoink-expression:v1 ${Buffer.from(JSON.stringify(entry)).toString("base64")} -->`;
      original = original.replace(expressionIdentityMarker(entry.id), payload);
      files.data.delete(entryStatePath(entry.id));
    }
    files.data.set(entry.path, original);
    files.data.set(`${options.expressionDirectory}/用户自己的文件.md`, "没有词条标记的用户文件");
    const beforeEnglish = files.data.get(record.englishPath);
    const hidden = new EnglishDiaryRepository(files, { ...options, expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY });
    const migrated = (await hidden.listExpressions())[0];
    assert.equal(migrated.id, entry.id);
    assert.equal(migrated.note, entry.note);
    assert.deepEqual(migrated.occurrences, entry.occurrences);
    assert.equal(files.data.has(entry.path), false);
    assert.equal(files.data.get(expressionBackup(entry.id, entry.path)), original);
    assert.ok(files.data.get(migrated.path)!.startsWith("用户前言\n"));
    assert.ok(files.data.get(migrated.path)!.includes("用户后记"));
    assert.doesNotMatch(files.data.get(migrated.path)!, /echoink-expression:v1/);
    assert.equal(files.data.get(`${options.expressionDirectory}/用户自己的文件.md`), "没有词条标记的用户文件");
    assert.equal(files.data.get(record.englishPath), beforeEnglish);
    assert.equal(JSON.parse(files.data.get(entryStatePath(entry.id))!).entry.path, migrated.path);
    const stable = new Map(files.data);
    await hidden.listExpressions();
    assert.deepEqual(files.data, stable);
  }

  // Hidden-target and backup conflicts keep every existing byte unchanged.
  for (const conflictAt of ["target", "backup", "duplicate-id"] as const) {
    const { files, repo } = await seeded();
    const entry = (await repo.listExpressions())[0];
    const target = entry.path.replace(options.expressionDirectory, HIDDEN_EXPRESSION_DIRECTORY);
    if (conflictAt === "duplicate-id") files.data.set(`${HIDDEN_EXPRESSION_DIRECTORY}/其他名字.md`, files.data.get(entry.path)!);
    else files.data.set(conflictAt === "target" ? target : expressionBackup(entry.id, entry.path), "已有用户内容");
    const before = new Map(files.data);
    const hidden = new EnglishDiaryRepository(files, { ...options, expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY });
    await rejectsCode(hidden.listExpressions(), "CONFLICT");
    assert.deepEqual(files.data, before);
  }

  // Migration survives a process loss after the backup move or either write.
  for (const point of ["move", "private", "markdown"] as const) {
    const { files, repo } = await seeded();
    const entry = (await repo.listExpressions())[0];
    const original = files.data.get(entry.path)!;
    let snapshot: Map<string, string> | null = null;
    files.hook = (event) => {
      if (snapshot || event.phase !== "after") return;
      if ((point === "move" && event.kind === "move")
        || (point === "private" && event.kind === "write" && event.path === entryStatePath(entry.id))
        || (point === "markdown" && event.kind === "write" && event.path.startsWith(HIDDEN_EXPRESSION_DIRECTORY))) snapshot = new Map(files.data);
    };
    await new EnglishDiaryRepository(files, { ...options, expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY }).listExpressions();
    const restartedFiles = new MemoryFiles();
    restartedFiles.data = new Map(snapshot!);
    const hidden = new EnglishDiaryRepository(restartedFiles, { ...options, expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY });
    const migrated = (await hidden.listExpressions())[0];
    assert.equal(migrated.id, entry.id);
    assert.equal(restartedFiles.data.has(entry.path), false);
    assert.equal(restartedFiles.data.get(expressionBackup(entry.id, entry.path)), original);
    assert.equal(restartedFiles.data.has(`${options.stateDirectory}/expression-operation.json`), false);
  }

  // A thrown migration write restores the old file and metadata, then retries safely.
  {
    const { files, repo } = await seeded();
    const before = new Map(files.data);
    let injected = false;
    files.hook = (event) => {
      if (!injected && event.phase === "after" && event.kind === "write" && event.path.startsWith(HIDDEN_EXPRESSION_DIRECTORY)) {
        injected = true;
        throw new Error("hidden migration failed after write");
      }
    };
    const hidden = new EnglishDiaryRepository(files, { ...options, expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY });
    await assert.rejects(hidden.listExpressions());
    assert.deepEqual(files.data, before);
    files.hook = undefined;
    assert.equal((await hidden.listExpressions()).length, 1);
    assert.ok(repo);
  }

  // Explicit custom visible folders retain their original scope and are never auto-migrated.
  {
    const files = new MemoryFiles();
    const repo = new EnglishDiaryRepository(files, { ...options, expressionDirectory: "My Expressions" });
    const input = source(), record = await repo.get(input);
    await repo.publish(record, result(record, input, 1), unchanged);
    assert.ok((await repo.listExpressions())[0].path.startsWith("My Expressions/"));
    assert.equal((await files.list(HIDDEN_EXPRESSION_DIRECTORY)).length, 0);
  }

  // Outputs aliases migrate only managed files, preserving edited English, notes and every link.
  {
    const { files, repo, input, record } = await seeded();
    const oldEntry = (await repo.listExpressions())[0];
    const oldEnglish = `${files.data.get(record.englishPath)}\n用户手写英文补充\n`;
    files.data.set(record.englishPath, oldEnglish);
    const note = files.data.get(oldEntry.path)!.replace("**本篇场景** 在会上指出风险", "**本篇场景** 用户自行改过的说明") + "\n额外学习计划\n";
    files.data.set(oldEntry.path, note);
    files.data.set(`${options.englishDirectory}/用户文件.md`, "用户自己的英文");
    files.data.set(`${options.expressionDirectory}/用户文件.md`, "用户自己的表达笔记");
    const target = {
      ...options, englishDirectory: "输出（outputs）/.english-diary/diaries", expressionDirectory: "输出（outputs）/.english-diary/expressions",
      legacyEnglishDirectories: [options.englishDirectory], legacyExpressionDirectories: [options.expressionDirectory]
    };
    const migratedRepo = new EnglishDiaryRepository(files, target);
    const migrated = await migratedRepo.get(input);
    const entry = (await migratedRepo.listExpressions())[0];
    assert.equal(migrated.id, record.id);
    assert.ok(migrated.englishPath.startsWith(target.englishDirectory));
    assert.equal(files.data.get(migrated.englishPath), oldEnglish);
    assert.equal(migrated.englishModified, true);
    assert.equal(files.data.has(record.englishPath), false);
    assert.equal(files.data.has(oldEntry.path), false);
    assert.ok(entry.path.startsWith(target.expressionDirectory));
    assert.equal(entry.id, oldEntry.id);
    assert.ok(entry.occurrences.every((item) => item.englishPath === migrated.englishPath));
    assert.match(files.data.get(entry.path)!, /用户自行改过的说明/);
    assert.match(files.data.get(entry.path)!, /额外学习计划/);
    assert.ok(files.data.get(entry.path)!.includes(migrated.englishPath.replace(/\.md$/, "")));
    assert.equal(files.data.get(`${options.englishDirectory}/用户文件.md`), "用户自己的英文");
    assert.equal(files.data.get(`${options.expressionDirectory}/用户文件.md`), "用户自己的表达笔记");
    const backups = await files.list(`${options.stateDirectory}/english-migration-backup`);
    assert.equal(backups.length, 1);
    assert.equal(files.data.get(backups[0]), oldEnglish);
    const stable = new Map(files.data);
    await migratedRepo.get(input);
    await migratedRepo.listExpressions();
    assert.deepEqual(files.data, stable);
  }

  // Previously migrated hidden notes can move again without overwriting their earlier backups.
  {
    const { files, repo } = await seeded();
    const original = (await repo.listExpressions())[0];
    const prior = ".echoink/english-diary/expressions";
    const interim = new EnglishDiaryRepository(files, { ...options, expressionDirectory: prior, legacyExpressionDirectories: [options.expressionDirectory] });
    const oldHidden = (await interim.listExpressions())[0];
    const firstBackup = expressionBackup(original.id, original.path);
    const firstBytes = files.data.get(firstBackup);
    const finalRepo = new EnglishDiaryRepository(files, {
      ...options, expressionDirectory: "输出（outputs）/.english-diary/expressions",
      legacyExpressionDirectories: [options.expressionDirectory, prior]
    });
    const final = (await finalRepo.listExpressions())[0];
    assert.equal(final.id, original.id);
    assert.equal(final.occurrences.length, 1);
    assert.equal(files.data.get(firstBackup), firstBytes);
    assert.equal(files.data.get(expressionBackup(original.id, oldHidden.path)), files.data.get(final.path));
    assert.equal((await files.list(`${options.stateDirectory}/expression-migration-backup`)).length, 2);
  }

  // Captured custom roots are migrated; a missing derived file keeps its local restore path.
  {
    const files = new MemoryFiles();
    const custom = { ...options, englishDirectory: "Custom English", expressionDirectory: "Custom Expressions" };
    const repo = new EnglishDiaryRepository(files, custom);
    const input = source(), initial = await repo.get(input);
    const record = await repo.publish(initial, result(initial, input, 401), unchanged);
    files.data.delete(record.englishPath);
    const next = new EnglishDiaryRepository(files, {
      ...options, englishDirectory: "outputs/.english-diary/diaries", expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY,
      legacyEnglishDirectories: [custom.englishDirectory], legacyExpressionDirectories: [custom.expressionDirectory]
    });
    const migrated = await next.get(input);
    assert.equal(migrated.missingEnglish, true);
    assert.ok(migrated.englishPath.startsWith("outputs/.english-diary/diaries/"));
    assert.equal((await next.listExpressions())[0].occurrences[0].englishPath, migrated.englishPath);
    const restored = await next.restore(migrated);
    assert.equal(restored.missingEnglish, false);
    assert.equal((await next.listGenerationActivity()).reduce((sum, day) => sum + day.generationCount, 0), 1);
  }

  // An English target or backup conflict does not alter either copy or its managed association.
  for (const conflictAt of ["target", "backup"] as const) {
    const { files, input, record } = await seeded();
    const target = "outputs/.english-diary/diaries";
    const path = conflictAt === "target" ? record.englishPath.replace(options.englishDirectory, target)
      : `${options.stateDirectory}/english-migration-backup/${record.id}-${hash(record.englishPath).slice(0, 8)}.md`;
    files.data.set(path, "已有资料，不能覆盖");
    const before = new Map(files.data);
    const repo = new EnglishDiaryRepository(files, { ...options, englishDirectory: target, legacyEnglishDirectories: [options.englishDirectory] });
    await rejectsCode(repo.get(input), "CONFLICT");
    assert.deepEqual(files.data, before);
  }

  // Moving English and all expression links resumes after process loss at every write boundary.
  for (const point of ["move", "entry", "english", "state"] as const) {
    const { files, input, record } = await seeded();
    const config = {
      ...options, englishDirectory: "outputs/.english-diary/diaries", expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY,
      legacyEnglishDirectories: [options.englishDirectory], legacyExpressionDirectories: [options.expressionDirectory]
    };
    let snapshot: Map<string, string> | null = null, englishStarted = false;
    files.hook = (event) => {
      if (event.kind === "move" && event.phase === "after" && event.path.includes("/english-migration-backup/")) englishStarted = true;
      if (!englishStarted || snapshot || event.phase !== "after") return;
      if ((point === "move" && event.kind === "move")
        || (point === "entry" && event.kind === "write" && event.path.startsWith(`${options.stateDirectory}/expressions/`))
        || (point === "english" && event.kind === "write" && event.path.startsWith(config.englishDirectory))
        || (point === "state" && event.kind === "write" && event.path === `${options.stateDirectory}/${record.id}.json`)) snapshot = new Map(files.data);
    };
    await new EnglishDiaryRepository(files, config).get(input);
    assert.ok(snapshot, `English migration ${point} should produce a process image`);
    const restartedFiles = new MemoryFiles();
    restartedFiles.data = new Map(snapshot!);
    const repo = new EnglishDiaryRepository(restartedFiles, config);
    const migrated = await repo.get(input);
    const entry = (await repo.listExpressions())[0];
    assert.equal(migrated.id, record.id);
    assert.equal(migrated.missingEnglish, false);
    assert.equal(migrated.englishModified, false);
    assert.equal(entry.occurrences[0].englishPath, migrated.englishPath);
    assert.equal(restartedFiles.data.has(record.englishPath), false);
    assert.equal(restartedFiles.data.has(`${options.stateDirectory}/expression-operation.json`), false);
  }

  // A failed English copy restores old English and links; the completed expression move remains safe.
  {
    const { files, input, record } = await seeded();
    const original = files.data.get(record.englishPath);
    const config = {
      ...options, englishDirectory: "outputs/.english-diary/diaries", expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY,
      legacyEnglishDirectories: [options.englishDirectory], legacyExpressionDirectories: [options.expressionDirectory]
    };
    let injected = false;
    files.hook = (event) => {
      if (!injected && event.kind === "write" && event.phase === "after" && event.path.startsWith(config.englishDirectory)) {
        injected = true;
        throw new Error("English migration failed after copy");
      }
    };
    const repo = new EnglishDiaryRepository(files, config);
    await assert.rejects(repo.get(input));
    assert.equal(files.data.get(record.englishPath), original);
    assert.equal((await files.list(config.englishDirectory)).length, 0);
    files.hook = undefined;
    const migrated = await repo.get(input);
    assert.equal((await repo.listExpressions())[0].occurrences[0].englishPath, migrated.englishPath);
    assert.equal(files.data.get(migrated.englishPath), original);
  }

  // Ancestor legacy roots never rescan the current target, and English uses its nearest old root.
  {
    const files = new MemoryFiles();
    const original = new EnglishDiaryRepository(files, { ...options, expressionDirectory: "outputs" });
    const input = source(), record = await original.get(input);
    await original.publish(record, result(record, input, 501), unchanged);
    const config = {
      ...options, englishDirectory: "outputs/.english-diary/diaries", expressionDirectory: HIDDEN_EXPRESSION_DIRECTORY,
      legacyEnglishDirectories: ["EchoInk", options.englishDirectory], legacyExpressionDirectories: ["outputs"]
    };
    const repo = new EnglishDiaryRepository(files, config);
    const migrated = await repo.get(input);
    assert.equal(migrated.englishPath, `${config.englishDirectory}/${record.englishPath.slice(options.englishDirectory.length + 1)}`);
    assert.equal((await repo.listExpressions()).length, 1);
    const stable = new Map(files.data);
    assert.equal((await repo.listExpressions()).length, 1);
    await repo.get(input);
    assert.deepEqual(files.data, stable, "reading an ancestor root must not remigrate or conflict with its own target");
  }

  // Successful writes notify once; listener reads do not loop, failures stay silent and unsubscribe works.
  {
    const files = new MemoryFiles(), repo = new EnglishDiaryRepository(files, options);
    const input = source();
    let notifications = 0;
    const reads: Promise<unknown>[] = [];
    const unsubscribe = repo.subscribe(() => { notifications++; reads.push(repo.listGenerationActivity()); });
    const removeBrokenListener = repo.subscribe(() => { throw new Error("broken UI listener"); });
    let record = await repo.get(input);
    await repo.listExpressions();
    await repo.listGenerationActivity();
    assert.equal(notifications, 0);
    record = await repo.publish(record, result(record, input, 601), unchanged);
    await Promise.all(reads);
    assert.equal(notifications, 1);
    await rejectsCode(repo.publish(record, result(record, { ...input, content: "失败生成" }, 602), { sourceUnchanged: async () => false }), "SOURCE_CHANGED");
    assert.equal(notifications, 1);
    let entry = (await repo.listExpressions())[0];
    await repo.updateExpression(entry.id, { category: entry.category, note: "通知后的备注" });
    record = await repo.markExpression(record, "phrase-1", "needs-review");
    entry = (await repo.listExpressions())[0];
    await repo.removeOccurrence(entry.id, entry.occurrences[0].id);
    files.data.delete(record.englishPath);
    await repo.restore(record);
    await repo.renameSource(input.path, "Daily/通知改名.md");
    await Promise.all(reads);
    assert.equal(notifications, 6);
    unsubscribe();
    removeBrokenListener();
    await repo.updateExpression(entry.id, { category: entry.category, note: "退订后仍可保存" });
    assert.equal(notifications, 6);
    assert.equal((await repo.listExpressions())[0].note, "退订后仍可保存");
  }

  // Activity counts successful operations on their local generated date, preserving past days.
  {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      const files = new MemoryFiles(), repo = new EnglishDiaryRepository(files, options);
      const input = source("2000-01-01", "第一篇");
      let record = await repo.get(input);
      const first = result(record, input, 101);
      first.generatedAt = "2026-10-05T23:30:00Z";
      first.expressions.push({ ...first.expressions[0], id: "sentence-1", term: "I see your point.", type: "sentence" });
      record = await repo.publish(record, first, unchanged);
      const firstDay = [{ date: "2026-10-06", expressionCount: 2, generationCount: 1 }];
      assert.deepEqual(await repo.listGenerationActivity(), firstDay);
      const beforeRefresh = new Map(files.data);
      await repo.listGenerationActivity();
      assert.deepEqual(files.data, beforeRefresh);
      record = await repo.publish(record, first, unchanged);
      const marked = await repo.markExpression(record, "phrase-1", "needs-review", "人工修正");
      files.data.delete(marked.englishPath);
      record = await repo.restore(marked);
      assert.deepEqual(await repo.listGenerationActivity(), firstDay);
      const secondInput = { ...input, content: "第二次成功" };
      const second = result(record, secondInput, 102);
      second.generatedAt = "2026-10-06T01:00:00Z";
      record = await repo.publish(record, second, unchanged);
      const third = result(record, { ...input, content: "下一天成功" }, 103);
      third.generatedAt = "2026-10-06T23:00:00Z";
      third.expressions = [];
      record = await repo.publish(record, third, unchanged);
      const expected = [
        { date: "2026-10-06", expressionCount: 3, generationCount: 2 },
        { date: "2026-10-07", expressionCount: 0, generationCount: 1 }
      ];
      assert.deepEqual(await repo.listGenerationActivity(), expected);
      process.env.TZ = "America/Los_Angeles";
      assert.deepEqual(await new EnglishDiaryRepository(files, options).listGenerationActivity(), expected);
      // A replay of an older operation does not create another event.
      await repo.publish(record, first, unchanged);
      assert.deepEqual(await repo.listGenerationActivity(), expected);
    } finally { if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone; }
  }

  // Failure or cancellation after writes never commits a check-in; a later successful retry does.
  for (const cancel of [false, true]) {
    const { files, repo, input, record } = await seeded();
    const before = await repo.listGenerationActivity();
    const next = result(record, { ...input, content: "失败后恢复生成" }, 201);
    const signal = new AbortController();
    let unchangedSource = true;
    files.hook = (event) => {
      if (event.kind === "write" && event.phase === "after" && event.path === record.englishPath) {
        if (cancel) signal.abort(); else unchangedSource = false;
      }
    };
    await rejectsCode(repo.publish(record, next, { sourceUnchanged: async () => unchangedSource, signal: signal.signal }), cancel ? "ABORTED" : "SOURCE_CHANGED");
    files.hook = undefined;
    assert.deepEqual(await repo.listGenerationActivity(), before);
    const pending = await repo.get(input);
    await repo.publish(pending, pending.pending!, unchanged);
    assert.equal((await repo.listGenerationActivity()).reduce((sum, item) => sum + item.generationCount, 0), 2);
  }

  // Legacy backfill can prove only the current result and pins its local date once.
  for (const generatedAt of ["2026-10-05T23:30:00Z", "", "invalid", "2026-02-30T10:00:00Z", "2026-10-05"]) {
    const { files, repo, record } = await seeded();
    const path = `${options.stateDirectory}/${record.id}.json`;
    const state = JSON.parse(files.data.get(path)!);
    delete state.generationActivity;
    state.result.generatedAt = generatedAt;
    state.result.date = "1999-01-01";
    files.data.set(path, JSON.stringify(state));
    const days = await repo.listGenerationActivity();
    assert.equal(days.reduce((sum, item) => sum + item.generationCount, 0), generatedAt === "2026-10-05T23:30:00Z" ? 1 : 0);
    assert.ok(days.every((item) => item.date !== "1999-01-01"));
    assert.ok(Array.isArray(JSON.parse(files.data.get(path)!).generationActivity));
    const stable = new Map(files.data);
    await repo.listGenerationActivity();
    assert.deepEqual(files.data, stable);
  }

  // A crashed generation journal is recovered before activity is read, including first access.
  {
    const { files, repo, input, record } = await seeded();
    const before = await repo.listGenerationActivity();
    let snapshot: Map<string, string> | null = null;
    files.hook = (event) => {
      if (event.kind === "write" && event.phase === "after" && event.path === record.englishPath) snapshot = new Map(files.data);
    };
    await repo.publish(record, result(record, { ...input, content: "生成写入中断" }, 301), unchanged);
    const restartedFiles = new MemoryFiles();
    restartedFiles.data = new Map(snapshot!);
    const restarted = new EnglishDiaryRepository(restartedFiles, options);
    assert.deepEqual(await restarted.listGenerationActivity(), before);
    const pending = await restarted.get(input);
    await restarted.publish(pending, pending.pending!, unchanged);
    assert.equal((await restarted.listGenerationActivity()).reduce((sum, item) => sum + item.generationCount, 0), 2);
  }

  const { files, repo } = await seeded();
  const entry = (await repo.listExpressions())[0];
  assert.equal(parseExpressionMarkdown(files.data.get(entry.path)!, entry.path, JSON.parse(files.data.get(entryStatePath(entry.id))!).entry)!.id, entry.id);
}

class EnglishDiaryRepository extends ProductionDiaryRepository {
  constructor(files: DiaryFilePort, options: ConstructorParameters<typeof ProductionDiaryRepository>[1]) { super(files, options, paidTestAccess); }
}
