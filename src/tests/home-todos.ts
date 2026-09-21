import assert from "node:assert/strict";
import { TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { EchoInkTodoStore, TODO_SOURCE_PATH } from "../home/todo-store";
import { EchoInkTodoFormModal } from "../home/todo-edit-modal";
import { parseTodoMarkdown } from "../home/todo-markdown";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";

function createTodoFixture(initial = "- [ ] Existing <!-- echoink-todo-id: existing -->\n") {
  let content = initial;
  let writeError: Error | null = null;
  let beforeWrite: (() => void) | null = null;
  let failRefresh = false;
  const file = new TFile();
  Object.assign(file, { path: TODO_SOURCE_PATH });
  const beginWrite = (): void => {
    const pending = beforeWrite;
    beforeWrite = null;
    pending?.();
    if (writeError) throw writeError;
  };
  const vault = {
    on: () => ({}),
    getAbstractFileByPath: (path: string) => path === "EchoInk" ? {} : file,
    read: async () => content,
    cachedRead: async () => {
      if (failRefresh) throw new Error("refresh unavailable");
      return content;
    },
    modify: async (_file: TFile, next: string) => {
      beginWrite();
      content = next;
    },
    process: async (_file: TFile, transform: (latest: string) => string) => {
      beginWrite();
      content = transform(content);
      return content;
    }
  };
  const plugin = {
    app: { vault },
    settings: structuredClone(DEFAULT_SETTINGS),
    saveSettings: async () => undefined,
    registerEvent: () => undefined
  } as unknown as CodexForObsidianPlugin;
  const store = new EchoInkTodoStore(plugin);
  plugin.getTodoStore = () => store;
  return {
    plugin,
    store,
    content: () => content,
    externalEdit: (next: string) => { content = next; },
    failWrite: (value: boolean) => { writeError = value ? new Error("disk write failed") : null; },
    failRefresh: () => { failRefresh = true; },
    editBeforeWrite: (line: string) => { beforeWrite = () => { content += `${line}\n`; }; }
  };
}

export async function runHomeTodoTests(): Promise<void> {
  const previousError = console.error;
  console.error = () => undefined;
  try {
    const failed = createTodoFixture();
    failed.failWrite(true);
    await assert.rejects(failed.store.addTodo({ title: "Failed draft" }), /disk write failed/);
    assert.equal(parseTodoMarkdown(failed.content()).records.length, 1);
    failed.failWrite(false);
    await failed.store.addTodo({ title: "Next save" });
    assert.deepEqual(parseTodoMarkdown(failed.content()).records.map((record) => record.title), ["Existing", "Next save"]);

    // Exercise the actual form save lifecycle; only DOM painting and the host
    // close operation are replaced. A failed save must leave the draft open.
    const editing = createTodoFixture();
    editing.failWrite(true);
    let closed = false;
    const form = Object.assign(Object.create(EchoInkTodoFormModal.prototype), {
      plugin: editing.plugin,
      saving: false,
      titleValue: "Keep this draft",
      peopleNames: ["张三"],
      dueValue: "2026-09-20",
      categoryName: "",
      record: null,
      render: () => undefined,
      requestClose: () => { closed = true; }
    }) as { save(): Promise<void>; saving: boolean; titleValue: string; peopleNames: string[]; dueValue: string };
    await form.save();
    assert.equal(closed, false);
    assert.equal(form.saving, false);
    assert.equal(form.titleValue, "Keep this draft");
    assert.deepEqual(form.peopleNames, ["张三"]);
    assert.equal(form.dueValue, "2026-09-20");
    editing.failWrite(false);
    await form.save();
    assert.equal(closed, true);
    assert.equal(parseTodoMarkdown(editing.content()).records.at(-1)?.title, "Keep this draft");

    // An editor write arriving before the UI write commits must survive.
    const concurrent = createTodoFixture();
    concurrent.editBeforeWrite("- [ ] Added in the source editor");
    await concurrent.store.addTodo({ title: "Added in the UI" });
    assert.deepEqual(parseTodoMarkdown(concurrent.content()).records.map((record) => record.title), [
      "Existing", "Added in the source editor", "Added in the UI"
    ]);

    const categories = createTodoFixture("- [ ] Task\n  - 分类：工作\n");
    categories.editBeforeWrite("- [ ] Another task\n  - 分类：工作");
    await categories.store.renameCategoryInSource("工作", "项目");
    assert.deepEqual(parseTodoMarkdown(categories.content()).records.map((record) => record.categoryName), ["项目", "项目"]);
    await categories.store.removeCategoryFromSource("项目");
    assert.deepEqual(parseTodoMarkdown(categories.content()).records.map((record) => record.categoryName), ["", ""]);

    // Saving is successful even if the following list read is temporarily
    // unavailable: presenting a failure would encourage a duplicate retry.
    const refresh = createTodoFixture();
    refresh.failRefresh();
    await refresh.store.addTodo({ title: "Saved once" });
    assert.equal(parseTodoMarkdown(refresh.content()).records.filter((record) => record.title === "Saved once").length, 1);

    const history = createTodoFixture("- [x] Old without a date\n- [ ] Today <!-- echoink-todo-id: today -->\n");
    await history.store.reload();
    assert.equal(history.store.completionStatistics().total, 1);
    assert.equal(history.store.completionStatistics().unknown, 1);
    const today = history.store.snapshot().find((record) => record.id === "today")!;
    await history.store.toggleDone(today, true);
    assert.equal(history.store.completionStatistics().total, 2);
    assert.equal(history.store.completionStatistics().today, 1);
    await history.store.updateTodo(today, { title: "Edited title" });
    await history.store.reload();
    assert.equal(history.store.completionStatistics().total, 2);
    await history.store.toggleDone(today, false);
    assert.equal(history.store.completionStatistics().total, 1);
    history.externalEdit(history.content().replace("- [ ] Edited title", "- [x] Edited title"));
    await history.store.reload();
    assert.equal(history.store.completionStatistics().today, 1);
    const persisted = JSON.parse(JSON.stringify(history.plugin.settings));
    history.plugin.settings = normalizeSettingsData(persisted).settings;
    const restarted = new EchoInkTodoStore(history.plugin);
    await restarted.reload();
    assert.equal(restarted.completionStatistics().total, 2);
    await restarted.removeTodo(restarted.snapshot().find((record) => record.id === "today")!);
    assert.equal(restarted.completionStatistics().total, 2, "completed deletion retains history");
    history.externalEdit(history.content() + "- [x] Offline addition <!-- echoink-todo-id: offline -->\n");
    const offline = new EchoInkTodoStore(history.plugin);
    await offline.reload();
    assert.equal(offline.completionStatistics().unknown, 2);
    await offline.reload();
    assert.equal(offline.completionStatistics().total, 3);

    const legacy = createTodoFixture("- [x] Migrated\n");
    legacy.plugin.settings.todos = [{ id: "legacy-id", title: "Migrated", done: true, people: "", dueDate: "", categoryId: "", createdAt: 1, completedAt: new Date(2025, 11, 10, 23, 30).getTime() }];
    await legacy.store.initialize();
    assert.deepEqual(Object.values(legacy.plugin.settings.todoCompletions), ["2025-12-10"]);
    assert.equal(legacy.store.completionStatistics().total, 1);
    assert.equal(legacy.store.completionStatistics().unknown, 0);
    assert.deepEqual(legacy.plugin.settings.todos, []);

    const retryHistory = createTodoFixture("- [ ] Retry <!-- echoink-todo-id: retry -->\n");
    await retryHistory.store.reload();
    let persistenceFails = true;
    retryHistory.plugin.saveSettings = async () => { if (persistenceFails) throw new Error("settings persistence unavailable"); };
    await retryHistory.store.toggleDone(retryHistory.store.snapshot()[0], true);
    assert.deepEqual(retryHistory.plugin.settings.todoCompletions, {}, "failed history save restores memory so persistence can retry");
    persistenceFails = false;
    await retryHistory.store.reload();
    assert.equal(retryHistory.store.completionStatistics().today, 1);

    const cleared = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), todoCategories: [] }).settings;
    assert.deepEqual(cleared.todoCategories, []);
    assert.deepEqual(normalizeSettingsData(JSON.parse(JSON.stringify(cleared))).settings.todoCategories, []);
    assert.deepEqual(normalizeSettingsData({}).settings.todoCategories, DEFAULT_SETTINGS.todoCategories);
  } finally {
    console.error = previousError;
  }
}
