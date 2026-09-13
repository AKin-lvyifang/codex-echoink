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
    saveSettings: async () => undefined
  } as unknown as CodexForObsidianPlugin;
  const store = new EchoInkTodoStore(plugin);
  plugin.getTodoStore = () => store;
  return {
    plugin,
    store,
    content: () => content,
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

    const cleared = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), todoCategories: [] }).settings;
    assert.deepEqual(cleared.todoCategories, []);
    assert.deepEqual(normalizeSettingsData(JSON.parse(JSON.stringify(cleared))).settings.todoCategories, []);
    assert.deepEqual(normalizeSettingsData({}).settings.todoCategories, DEFAULT_SETTINGS.todoCategories);
  } finally {
    console.error = previousError;
  }
}
