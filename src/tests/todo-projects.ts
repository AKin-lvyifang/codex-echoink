import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { TFile, TFolder } from "obsidian";
import type { TodoHost } from "../home/home-host";
import { emptyKnowledgeFolderBindings, rebaseKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { getTodoProjects, resolveTodoProject, serializeTodoProject } from "../home/todo-projects";
import { parseTodoMarkdown, serializeTodoRecord } from "../home/todo-markdown";
import { EchoInkTodoStore, TODO_SOURCE_PATH, TodoConflictError } from "../home/todo-store";

export async function todoStoreFixture(root: string, initial: string | null) {
  await mkdir(root, { recursive: true });
  const files = new Map<string, TFile | TFolder>();
  const events = new Map<string, ((...args: unknown[]) => void)[]>();
  let writes = 0, saves = 0;
  let beforeProcess: (() => Promise<void>) | undefined;
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.projects = { enabled: true, readPaths: ["工作项目", "生活项目"], writePath: "工作项目", allowedSubdirectories: [], compatibilityReadScopes: true };
  async function folder(relative: string): Promise<TFolder> {
    const existing = files.get(relative);
    if (existing instanceof TFolder) return existing;
    const parentPath = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    const parent = parentPath ? await folder(parentPath) : undefined;
    await mkdir(path.join(root, relative), { recursive: true });
    const result = Object.assign(new TFolder(), { path: relative, name: relative.split("/").at(-1), children: [] });
    files.set(relative, result); parent?.children.push(result); return result;
  }
  async function source(next: string): Promise<void> {
    await folder("EchoInk");
    await writeFile(path.join(root, TODO_SOURCE_PATH), next);
    files.set(TODO_SOURCE_PATH, Object.assign(new TFile(), { path: TODO_SOURCE_PATH }));
  }
  if (initial !== null) await source(initial);
  const vault = {
    getAbstractFileByPath: (relative: string) => files.get(relative) ?? null,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      const list = events.get(event) ?? []; list.push(callback); events.set(event, list); return {};
    },
    read: (file: TFile) => readFile(path.join(root, file.path), "utf8"),
    cachedRead: (file: TFile) => readFile(path.join(root, file.path), "utf8"),
    createFolder: async (relative: string) => { writes++; return folder(relative); },
    create: async (relative: string, content: string) => {
      if (files.has(relative)) throw new Error("already exists");
      writes++; await writeFile(path.join(root, relative), content); const file = Object.assign(new TFile(), { path: relative }); files.set(relative, file); return file;
    },
    modify: async (file: TFile, content: string) => { writes++; await writeFile(path.join(root, file.path), content); },
    process: async (file: TFile, transform: (content: string) => string) => {
      const pending = beforeProcess; beforeProcess = undefined; await pending?.();
      const current = await readFile(path.join(root, file.path), "utf8");
      const next = transform(current);
      if (next !== current) { writes++; await writeFile(path.join(root, file.path), next); }
      return next;
    }
  };
  const host = {
    app: { vault, workspace: { containerEl: { ownerDocument: { defaultView: globalThis } } } },
    settings: { settingsLanguage: "zh-CN", todos: [], todoCategories: [], todoCompletions: {}, knowledgeBase: { folderBindings: bindings } },
    saveSettings: async () => { saves++; }, registerEvent: () => undefined,
    getTodoStore: () => store
  } as unknown as TodoHost;
  const store = new EchoInkTodoStore(host);
  const emit = (event: string, ...args: unknown[]) => { for (const listener of events.get(event) ?? []) listener(...args); };
  return { store, host, bindings, folder, source, files, emit,
    writes: () => writes, saves: () => saves,
    content: () => readFile(path.join(root, TODO_SOURCE_PATH), "utf8"),
    beforeProcess: (callback: () => Promise<void>) => { beforeProcess = callback; },
    rename: async (oldPath: string, nextPath: string) => {
      const entry = files.get(oldPath); assert.ok(entry instanceof TFolder);
      const oldParent = files.get(oldPath.slice(0, oldPath.lastIndexOf("/")));
      if (oldParent instanceof TFolder) oldParent.children = oldParent.children.filter(child => child !== entry);
      const newParent = files.get(nextPath.slice(0, nextPath.lastIndexOf("/")));
      if (newParent instanceof TFolder) newParent.children.push(entry);
      await rename(path.join(root, oldPath), path.join(root, nextPath));
      for (const [saved, file] of [...files]) if (saved === oldPath || saved.startsWith(`${oldPath}/`)) {
        files.delete(saved); Object.assign(file, { path: nextPath + saved.slice(oldPath.length) }); files.set(file.path, file);
      }
      emit("rename", entry, oldPath); await Promise.resolve(); await store.reload();
    }
  };
}

const fixture = todoStoreFixture;

export async function runTodoProjectTests(root: string): Promise<void> {
  assert.ok(root);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const raw = "说明正文\n* [ ] 原任务 <!-- echoink-todo-id: one -->\n\t* 项目: EchoInk\n    - 未知字段：原样保留\n    自由正文 <!-- 自定义注释 -->\n\n末尾正文\n";
    const parsed = parseTodoMarkdown(raw).records[0];
    assert.equal(parsed.project, "EchoInk");
    assert.equal(serializeTodoRecord(parsed), parsed.sourceBlock);
    const oldWhitelist = { id: parsed.id, title: "旧入口编辑", people: parsed.people, dueDate: parsed.dueDate,
      categoryName: parsed.categoryName, done: parsed.done, lineStart: parsed.lineStart, lineEnd: parsed.lineEnd, extraMetaLines: parsed.extraMetaLines };
    assert.equal(parseTodoMarkdown(serializeTodoRecord(oldWhitelist)).records[0].project, "EchoInk", "old field-whitelist editors retain the project carrier");
    const oldParser = { ...oldWhitelist, extraMetaLines: ["  - 项目：EchoInk", "    - 其它：保留"] };
    assert.match(serializeTodoRecord(oldParser), /其它：保留/u);
    assert.equal(parseTodoMarkdown("- [ ] 无项目\n").records[0].project, undefined);

    const enumeration = await fixture(path.join(root, "enumeration"), raw);
    await enumeration.folder("工作项目/EchoInk"); await enumeration.folder("生活项目/EchoInk");
    await enumeration.folder("工作项目/Only"); await enumeration.folder("工作项目/Only/二级");
    enumeration.files.set("普通文件.md", Object.assign(new TFile(), { path: "普通文件.md" }));
    enumeration.bindings.roles.projects.readPaths.push("不存在", "普通文件.md", "../越界", "工作项目");
    const projects = getTodoProjects(enumeration.host);
    assert.deepEqual(projects.map(project => project.path).sort(), ["工作项目/EchoInk", "工作项目/Only", "生活项目/EchoInk"].sort());
    assert.equal(serializeTodoProject("工作项目/Only", projects), "Only");
    assert.equal(serializeTodoProject("工作项目/EchoInk", projects), "工作项目/EchoInk");
    assert.equal(resolveTodoProject("EchoInk", projects).status, "ambiguous");
    assert.equal(resolveTodoProject("工作项目/EchoInk", projects).project?.parentPath, "工作项目");
    assert.equal(resolveTodoProject("", projects).status, "none");
    assert.equal(resolveTodoProject("不存在", projects).status, "missing");
    assert.throws(() => serializeTodoProject("EchoInk", projects), /同名/u);
    enumeration.bindings.roles.projects.enabled = false;
    assert.deepEqual(getTodoProjects(enumeration.host), []);

    const readonly = await fixture(path.join(root, "readonly"), "- [x] 手写无ID\n  - 项目：EchoInk\n  - 分类：未知分类\n");
    readonly.host.settings.todos.push({ id: "legacy", title: "旧设置记录", done: false, people: "", dueDate: "", categoryId: "", createdAt: 1 });
    const read = await readonly.store.readOnlySnapshot();
    assert.match(read.contentVersion!, /^[a-f0-9]{64}$/u);
    assert.equal(read.records[0].id, ""); assert.equal(read.records[0].project, "EchoInk");
    assert.equal(readonly.writes(), 0); assert.equal(readonly.saves(), 0);
    assert.equal(readonly.host.settings.todos.length, 1); assert.deepEqual(readonly.host.settings.todoCompletions, {});
    assert.deepEqual(readonly.host.settings.todoCategories, []); assert.deepEqual(readonly.store.snapshot(), []);
    const handwritten = await fixture(path.join(root, "handwritten"), "- [ ] 手写无ID   \n  - 项目：EchoInk\n");
    const handwrittenRead = await handwritten.store.readOnlySnapshot();
    await handwritten.store.updateTodo(handwrittenRead.records[0], { people: "张三" }, handwrittenRead.contentVersion);
    assert.ok(handwritten.store.snapshot()[0].id, "an authorized write may assign the existing stable ID");
    assert.equal(handwritten.store.snapshot()[0].people, "张三");
    assert.equal(handwritten.store.snapshot()[0].project, "EchoInk");
    const absent = await fixture(path.join(root, "absent"), null);
    assert.equal((await absent.store.readOnlySnapshot()).contentVersion, null); assert.equal(absent.writes(), 0);
    await absent.store.addTodo({ id: "first", title: "首次新增" }, null);
    assert.equal((await absent.store.readOnlySnapshot()).records[0].id, "first");

    const editing = await fixture(path.join(root, "editing"), raw);
    await editing.store.initialize();
    await editing.store.updateTodo(editing.store.snapshot()[0], { title: "只改标题" });
    assert.match(await editing.content(), /\t\* 项目: EchoInk\n    - 未知字段：原样保留\n    自由正文 <!-- 自定义注释 -->/u);
    assert.match(await editing.content(), /说明正文[\s\S]*\n\n末尾正文/u);
    await editing.store.updateTodo(editing.store.snapshot()[0], { dueDate: "2026-10-20" });
    assert.equal(editing.store.snapshot()[0].project, "EchoInk", "legacy update whitelist retains the current project");
    await editing.store.updateTodo(editing.store.snapshot()[0], { project: "" });
    assert.doesNotMatch(await editing.content(), /项目[:：]/u);
    const stale = editing.store.snapshot()[0];
    await editing.source((await editing.content()).replace("只改标题", "源文件手改"));
    await assert.rejects(editing.store.updateTodo(stale, { dueDate: "2026-10-21" }), error => error instanceof TodoConflictError && error.code === "todo_record_changed");
    assert.match(await editing.content(), /源文件手改/u); assert.doesNotMatch(await editing.content(), /2026-10-21/u);
    await editing.store.reload();
    const current = editing.store.snapshot()[0];
    await editing.source(`前插一行\n${await editing.content()}- [ ] 另一条手写任务\n`);
    await editing.store.updateTodo(current, { people: "张三" });
    assert.match(await editing.content(), /前插一行/u); assert.match(await editing.content(), /另一条手写任务/u);

    const conditional = await fixture(path.join(root, "conditional"), "- [ ] 初始 <!-- echoink-todo-id: initial -->\n");
    const version = await conditional.store.readOnlySnapshot();
    await conditional.source((await conditional.content()) + "文件被修改\n");
    const beforeRejectedWrites = conditional.writes();
    for (const action of [
      () => conditional.store.addTodo({ title: "不能新增" }, version.contentVersion),
      () => conditional.store.updateTodo(version.records[0], { done: true }, version.contentVersion),
      () => conditional.store.removeTodo(version.records[0], version.contentVersion)
    ]) await assert.rejects(action(), error => error instanceof TodoConflictError && error.code === "todo_source_changed");
    assert.equal(conditional.writes(), beforeRejectedWrites);
    const currentVersion = await conditional.store.readOnlySnapshot();
    conditional.beforeProcess(async () => { await conditional.source((await conditional.content()) + "process前竞争\n"); });
    await assert.rejects(conditional.store.updateTodo(currentVersion.records[0], { done: true }, currentVersion.contentVersion), error => error instanceof TodoConflictError && error.code === "todo_source_changed");
    assert.equal((await conditional.store.readOnlySnapshot()).records[0].done, false);
    const nextVersion = await conditional.store.readOnlySnapshot();
    await conditional.store.updateTodo(nextVersion.records[0], { done: true }, nextVersion.contentVersion);
    assert.equal(conditional.store.completionStatistics().total, 1);
    const completed = (await conditional.store.readOnlySnapshot()).records[0];
    await conditional.store.removeTodo(completed);
    assert.equal(conditional.store.completionStatistics().total, 1, "deleting a completed task retains existing history semantics");

    const renaming = await fixture(path.join(root, "renaming"), "- [ ] A <!-- echoink-todo-id: a -->\n\t* 项目: Alpha\n  - 截止日期：2026-10-20\n    自由正文\n- [ ] B <!-- echoink-todo-id: b -->\n  - 项目：Beta\n");
    await renaming.folder("工作项目/Alpha"); await renaming.folder("生活项目/Beta");
    await renaming.store.initialize();
    const beforeUnrelatedRename = renaming.writes();
    await renaming.folder("其它/旧目录");
    await renaming.rename("其它/旧目录", "其它/新目录");
    assert.equal(renaming.writes(), beforeUnrelatedRename, "unrelated directory renames never rewrite the to-do source");
    await renaming.rename("工作项目/Alpha", "工作项目/Beta");
    assert.deepEqual(renaming.store.snapshot().map(record => record.project), ["工作项目/Beta", "生活项目/Beta"], "a known rename disambiguates both formerly unique associations");
    assert.match(await renaming.content(), /\t\* 项目: 工作项目\/Beta\n  - 截止日期：2026-10-20\n    自由正文/u);
    await renaming.rename("工作项目/Beta", "工作项目/Gamma");
    assert.deepEqual(renaming.store.snapshot().map(record => record.project), ["Gamma", "Beta"]);
    const removed = renaming.files.get("工作项目/Gamma")!;
    renaming.files.delete("工作项目/Gamma");
    const parent = renaming.files.get("工作项目") as TFolder; parent.children = parent.children.filter(child => child !== removed);
    await rm(path.join(root, "renaming/工作项目/Gamma"), { recursive: true });
    renaming.emit("delete", removed);
    assert.equal(resolveTodoProject("Gamma", getTodoProjects(renaming.host)).status, "missing");
    assert.equal(renaming.store.snapshot()[0].project, "Gamma");
    const beforeUnbind = await renaming.content();
    renaming.bindings.roles.projects.enabled = false;
    assert.equal(resolveTodoProject("Beta", getTodoProjects(renaming.host)).status, "missing");
    assert.equal(await renaming.content(), beforeUnbind);

    const rootRename = await fixture(path.join(root, "root-rename"), "- [ ] Root <!-- echoink-todo-id: root -->\n  - 项目：工作项目/EchoInk\n");
    await rootRename.folder("工作项目/EchoInk"); await rootRename.folder("生活项目/EchoInk");
    // Production Knowledge binding updates are scheduled by the earlier listener.
    let bindingQueue = Promise.resolve();
    rootRename.host.app.vault.on("rename", (file, oldPath) => {
      bindingQueue = bindingQueue.then(() => {
        rootRename.host.settings.knowledgeBase!.folderBindings = rebaseKnowledgeFolderBindings(rootRename.host.settings.knowledgeBase!.folderBindings!, oldPath, file.path);
      });
    });
    await rootRename.store.initialize();
    await rootRename.rename("工作项目", "已改名项目");
    assert.equal(rootRename.store.snapshot()[0].project, "已改名项目/EchoInk", "a witnessed bound-root rename follows the queued Knowledge binding update");

    const laterDuplicate = await fixture(path.join(root, "later-duplicate"), "- [ ] A <!-- echoink-todo-id: a -->\n  - 项目：Only\n");
    await laterDuplicate.folder("工作项目/Only"); await laterDuplicate.store.initialize();
    const added = await laterDuplicate.folder("生活项目/Only"); laterDuplicate.emit("create", added);
    assert.equal(resolveTodoProject("Only", getTodoProjects(laterDuplicate.host)).status, "ambiguous");
    assert.equal(laterDuplicate.store.snapshot()[0].project, "Only"); assert.equal(laterDuplicate.writes(), 0);
    await laterDuplicate.rename("生活项目/Only", "生活项目/Renamed");
    assert.equal(laterDuplicate.store.snapshot()[0].project, "Only", "ambiguous old names are never guessed during rename");
    for (const item of [enumeration, readonly, handwritten, absent, editing, conditional, renaming, rootRename, laterDuplicate]) item.store.dispose();
    console.log("Todo projects/store targeted tests: PASS (projects, multi-root, rename/delete, legacy metadata, conflicts, read-only, history)");
  } finally { console.error = originalError; }
}
