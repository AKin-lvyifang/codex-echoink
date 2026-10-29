import assert from "node:assert/strict";
import path from "node:path";
import { todoStoreFixture } from "./todo-projects";
import { parseTodoMarkdown, serializeTodoRecord } from "../home/todo-markdown";
import { TodoConflictError, TodoDiaryVersionConflictError } from "../home/todo-store";

export async function runDiaryTodoTests(root: string): Promise<void> {
  assert.ok(root);
  const originalError = console.error;
  console.error = () => undefined;
  const enabled = () => true;
  try {
    const fixture = await todoStoreFixture(path.join(root, "diary"), null);
    fixture.host.settings.diaryOrganizerEnabled = true;
    await fixture.folder("工作项目/Alpha");
    await fixture.store.initialize();
    const added = await fixture.store.addFromDiary("entry-1", "日记/2026-10-28.md", {
      title: "提交报告", project: "Alpha", dueDate: "2026-10-29", dueTime: "14:30"
    }, enabled);
    assert.equal(added.created, true);
    assert.equal(added.record.title, "提交报告");
    assert.equal(added.record.diaryEntryId, "entry-1");
    assert.equal(added.record.diaryJournalPath, "日记/2026-10-28.md");
    assert.match(await fixture.content(), /\n  - 来源：AI 从日记记的 \[\[日记\/2026-10-28.md\]\]\n  - 抽取条目ID：entry-1/u);
    assert.equal(added.version, added.record.sourceBlock);

    // Crash after the source write, before scheduler progress persists: retry is idempotent.
    const retry = await fixture.store.addFromDiary("entry-1", "日记/2026-10-28.md", { title: "不同标题" }, enabled);
    assert.equal(retry.created, false);
    assert.equal(retry.record.id, added.record.id);
    const simultaneous = await Promise.all([1, 2].map(() => fixture.store.addFromDiary("entry-2", "日记/2026-10-28.md", { title: "第二条" }, enabled)));
    assert.equal(simultaneous.filter(result => result.created).length, 1);
    assert.equal(simultaneous[0].record.id, simultaneous[1].record.id);
    const corrected = await fixture.store.updateFromDiary("entry-2", simultaneous[0].version, { title: "确认改正", dueDate: "2026-10-30" }, enabled);
    assert.equal(corrected.record.id, simultaneous[0].record.id);
    assert.equal(corrected.record.diaryEntryId, "entry-2");
    assert.equal(corrected.record.dueDate, "2026-10-30");
    await assert.rejects(fixture.store.updateFromDiary("entry-2", simultaneous[0].version, { title: "过期确认" }, enabled), error => error instanceof TodoDiaryVersionConflictError);

    await fixture.store.updateTodo(added.record, { title: "用户改过", people: "张三", categoryName: "工作" });
    const edited = (await fixture.store.getByDiaryEntryId("entry-1"))!;
    await fixture.store.toggleDone(edited.record, true);
    await fixture.rename("工作项目/Alpha", "工作项目/Beta");
    const renamed = (await fixture.store.getByDiaryEntryId("entry-1"))!;
    assert.equal(renamed.record.project, "Beta");
    assert.equal(renamed.record.diaryEntryId, "entry-1");
    assert.equal(renamed.record.diaryJournalPath, "日记/2026-10-28.md");
    assert.equal(renamed.record.done, true);
    assert.equal(renamed.record.title, "用户改过");

    // The compatibility carrier survives a legacy editor's field whitelist.
    const legacy = { id: renamed.record.id, title: "兼容编辑", people: "", dueDate: "", categoryName: "", done: true,
      lineStart: 0, lineEnd: 0, extraMetaLines: renamed.record.extraMetaLines };
    const roundtrip = parseTodoMarkdown(serializeTodoRecord(legacy)).records[0];
    assert.equal(roundtrip.diaryEntryId, "entry-1");
    assert.equal(roundtrip.diaryJournalPath, "日记/2026-10-28.md");
    assert.equal(roundtrip.project, "Beta");

    let conflict: TodoDiaryVersionConflictError | undefined;
    await assert.rejects(fixture.store.undoFromDiary("entry-1", added.version, false, enabled), error => {
      if (!(error instanceof TodoDiaryVersionConflictError)) return false;
      conflict = error; return true;
    });
    assert.equal(conflict!.current.title, "用户改过");
    assert.equal(conflict!.current.done, true);
    assert.equal(conflict!.currentVersion, renamed.version);
    assert.ok(await fixture.store.getByDiaryEntryId("entry-1"));
    await assert.rejects(fixture.store.undoFromDiary("entry-1", added.version, true, enabled), error => error instanceof TodoDiaryVersionConflictError,
      "force still checks the version the user reviewed");
    await fixture.source(`日记待办说明\n${await fixture.content()}`);
    assert.equal((await fixture.store.getByDiaryEntryId("entry-1"))!.version, renamed.version, "moving the block does not change its version or identity");
    assert.deepEqual(await fixture.store.undoFromDiary("entry-1", conflict!.currentVersion, true, enabled), { removed: true });
    assert.equal(await fixture.store.getByDiaryEntryId("entry-1"), null);
    assert.deepEqual(await fixture.store.undoFromDiary("entry-1", added.version, false, enabled), { removed: false });
    assert.deepEqual(await fixture.store.undoFromDiary("entry-2", corrected.version, false, enabled), { removed: true });

    const beforeGuard = await fixture.content();
    await assert.rejects(fixture.store.addFromDiary("disabled", "日记/a.md", { title: "不应写入" }, () => false), /关闭/u);
    let live = true;
    fixture.beforeProcess(async () => { live = false; });
    await assert.rejects(fixture.store.addFromDiary("turned-off", "日记/a.md", { title: "写前关闭" }, () => live), /关闭/u);
    assert.equal(await fixture.content(), beforeGuard);
    fixture.host.settings.diaryOrganizerEnabled = false;
    await assert.rejects(fixture.store.addFromDiary("direct-switch", "日记/a.md", { title: "入口也检查开关" }, enabled), /关闭/u);
    fixture.host.settings.diaryOrganizerEnabled = true;
    for (const [journal, input] of [["../私人.md", { title: "越界" }], ["日记/a.md", { title: "任务\n- [ ] 注入" }],
      ["日记/a.md", { title: "错误日期", dueDate: "2026-02-30" }], ["日记/a.md", { title: "错误时间", dueDate: "2026-10-28", dueTime: "25:00" }]] as const) {
      await assert.rejects(fixture.store.addFromDiary("invalid", journal, input, enabled));
    }

    const records = Array.from({ length: 140 }, (_, index) => `- [ ] 未完成 ${index} <!-- echoink-todo-id: open-${index} -->`);
    records.push("- [x] 未知完成时间 <!-- echoink-todo-id: unknown -->", "- [x] 近期完成 <!-- echoink-todo-id: recent -->", "- [x] 很早完成 <!-- echoink-todo-id: old -->");
    await fixture.source(`${records.join("\n")}\n`);
    fixture.host.settings.todoCompletions = { unknown: null, recent: "2026-10-22", old: "2026-10-20" };
    const snapshot = await fixture.store.snapshotForDiary(new Date("2026-10-28T12:00:00"));
    assert.equal(snapshot.records.length, 142, "deduplication has no tool/UI limit");
    assert.equal(snapshot.records.find(record => record.id === "unknown")!.completedAt, null);
    assert.equal(snapshot.records.find(record => record.id === "recent")!.completedAt, "2026-10-22");
    assert.ok(!snapshot.records.some(record => record.id === "old"));

    const block = "- [ ] 重复 <!-- echoink-todo-id: duplicate-a -->\n  - 来源：AI 从日记记的 [[日记/a.md]]\n  - 抽取条目ID：duplicate\n";
    await fixture.source(block + block.replace("duplicate-a", "duplicate-b"));
    for (const action of [() => fixture.store.getByDiaryEntryId("duplicate"),
      () => fixture.store.addFromDiary("duplicate", "日记/a.md", { title: "不再新增" }, enabled),
      () => fixture.store.undoFromDiary("duplicate", "", true, enabled)]) {
      await assert.rejects(action(), error => error instanceof TodoConflictError);
    }
    fixture.store.dispose();
    console.log("Diary todo targeted tests: PASS (source, identity, retry/concurrency, editing/toggle/project rename, undo conflict, live guard, full dedupe snapshot)");
  } finally { console.error = originalError; }
}
