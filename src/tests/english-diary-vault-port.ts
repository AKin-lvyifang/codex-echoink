import * as assert from "node:assert/strict";
import { MarkdownView, TFile, TFolder, type App } from "obsidian";
import { EnglishDiaryVaultPort, flushNativeEditors, readDiarySource, saveDiarySource } from "../english-diary/vault-port";
import { EnglishDiaryRepositoryError } from "../english-diary/repository";

type TestView = MarkdownView & { value: string; saves: number; setValues: string[]; onSave?: () => void };
function fixture() {
  const data = new Map<string, string>();
  const files = new Map<string, TFile>();
  const folders = new Set<string>();
  const views: TestView[] = [];
  const calls: string[] = [];
  const hooks: {
    read?: (path: string) => void;
    beforeProcess?: (path: string) => void;
    afterProcess?: (path: string) => void;
    beforeCreate?: (path: string) => void;
  } = {};
  function file(path: string, content: string): TFile {
    data.set(path, content);
    const value = Object.assign(Object.create(TFile.prototype), {
      path, name: path.split("/").at(-1), basename: path.split("/").at(-1)!.replace(/\.[^.]+$/, ""), extension: path.split(".").at(-1)
    }) as TFile;
    files.set(path, value);
    return value;
  }
  function editor(path: string, content: string): TestView {
    const view = Object.assign(Object.create(MarkdownView.prototype), {
      file: files.get(path), value: content, saves: 0, setValues: []
    }) as TestView;
    view.editor = {
      getValue: () => view.value,
      setValue: (value: string) => { view.setValues.push(value); view.value = value; }
    } as MarkdownView["editor"];
    view.save = async () => {
      view.saves++;
      const captured = view.value;
      view.onSave?.();
      data.set(path, captured);
    };
    views.push(view);
    return view;
  }
  const adapter = {
    exists: async (path: string) => data.has(path) || folders.has(path),
    mkdir: async (path: string) => { calls.push(`adapter.mkdir:${path}`); folders.add(path); },
    read: async (path: string) => { hooks.read?.(path); if (!data.has(path)) throw new Error("missing"); return data.get(path)!; },
    write: async (path: string, content: string) => { calls.push(`adapter.write:${path}`); data.set(path, content); },
    process: async (path: string, update: (before: string) => string) => {
      calls.push(`adapter.process:${path}`);
      hooks.beforeProcess?.(path);
      if (!data.has(path)) throw new Error("missing");
      const next = update(data.get(path)!);
      data.set(path, next);
      hooks.afterProcess?.(path);
      return next;
    },
    list: async (root: string) => ({ files: [...data.keys()].filter((path) => path.startsWith(`${root}/`) && !path.slice(root.length + 1).includes("/")), folders: [...folders].filter((path) => path.startsWith(`${root}/`) && !path.slice(root.length + 1).includes("/")) }),
    remove: async (path: string) => { calls.push(`adapter.remove:${path}`); data.delete(path); },
    rename: async (from: string, to: string) => {
      calls.push(`adapter.rename:${from}->${to}`);
      if (data.has(to)) throw new Error("exists");
      data.set(to, data.get(from)!); data.delete(from);
    }
  };
  const app = {
    workspace: { getLeavesOfType: (kind: string) => { assert.equal(kind, "markdown"); return views.map((view) => ({ view })); } },
    vault: {
      adapter,
      getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? Object.assign(Object.create(TFolder.prototype), { path }) : null),
      read: async (entry: TFile) => { calls.push(`read:${entry.path}`); const captured = data.get(entry.path)!; hooks.read?.(entry.path); return captured; },
      process: async (entry: TFile, update: (before: string) => string) => {
        calls.push(`process:${entry.path}`);
        hooks.beforeProcess?.(entry.path);
        const next = update(data.get(entry.path)!);
        data.set(entry.path, next);
        hooks.afterProcess?.(entry.path);
        return next;
      },
      create: async (path: string, content: string) => {
        hooks.beforeCreate?.(path);
        if (data.has(path)) throw new Error("exists");
        return file(path, content);
      },
      createFolder: async (path: string) => { folders.add(path); },
      trash: async (entry: TFile) => { calls.push(`trash:${entry.path}`); data.delete(entry.path); files.delete(entry.path); }
    },
    fileManager: { renameFile: async (entry: TFile, to: string) => { await adapter.rename(entry.path, to); files.delete(entry.path); file(to, data.get(to)!); } }
  } as unknown as App;
  return { app, data, files, views, calls, hooks, file, editor, port: new EnglishDiaryVaultPort(app, ["English", "Expressions", ".state", ".echoink/english-diary/expressions"]) };
}
async function conflict(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: unknown) => error instanceof EnglishDiaryRepositoryError && error.code === "FILE_MODIFIED");
}

export async function runEnglishDiaryVaultPortTests(): Promise<void> {
  // Read-only operations use the latest native draft and never save any editor.
  {
    const f = fixture();
    f.file("Daily/today.md", "old disk");
    f.file("Daily/other.md", "other disk");
    f.file("English/today.md", "generated");
    const sourceView = f.editor("Daily/today.md", "latest native draft");
    const unrelated = f.editor("Daily/other.md", "unrelated unsaved draft");
    const englishView = f.editor("English/today.md", "hand-edited English");
    const preview = f.editor("Daily/today.md", "inactive preview cache");
    preview.getMode = () => "preview";
    assert.equal((await readDiarySource(f.app, "Daily/today.md")).content, "latest native draft");
    assert.equal(await f.port.read("English/today.md"), "hand-edited English");
    assert.equal(sourceView.saves + unrelated.saves + englishView.saves, 0);
    assert.equal(preview.saves, 0);
    assert.equal(f.data.get("Daily/today.md"), "old disk");
    assert.equal(f.data.get("Daily/other.md"), "other disk");
  }

  // An editor opened during a disk read wins over the earlier disk snapshot.
  {
    const f = fixture();
    f.file("Daily/today.md", "disk");
    f.hooks.read = () => { f.hooks.read = undefined; f.editor("Daily/today.md", "newly opened draft"); };
    assert.equal((await readDiarySource(f.app, "Daily/today.md")).content, "newly opened draft");
  }

  // Divergent copies of one document fail without guessing which user's edit to discard.
  {
    const f = fixture();
    f.file("Daily/today.md", "disk");
    const a = f.editor("Daily/today.md", "draft A");
    const b = f.editor("Daily/today.md", "draft B");
    await conflict(readDiarySource(f.app, "Daily/today.md"));
    await conflict(saveDiarySource(f.app, "Daily/today.md", "replacement", "draft A"));
    assert.equal(a.value, "draft A"); assert.equal(b.value, "draft B");
    assert.equal(a.saves + b.saves, 0);
    assert.equal(f.data.get("Daily/today.md"), "disk");
  }

  // Flushing targets one file and saves only one agreeing copy, never every tab.
  {
    const f = fixture();
    f.file("Daily/today.md", "old"); f.file("Daily/other.md", "other");
    const a = f.editor("Daily/today.md", "latest");
    const b = f.editor("Daily/today.md", "latest");
    const other = f.editor("Daily/other.md", "unrelated");
    await flushNativeEditors(f.app, "Daily/today.md");
    assert.equal(a.saves + b.saves, 1); assert.equal(other.saves, 0);
    assert.equal(f.data.get("Daily/today.md"), "latest");
    assert.equal(f.data.get("Daily/other.md"), "other");
  }

  // A keystroke during the native save is not overwritten by a later tab's save.
  {
    const f = fixture();
    f.file("Daily/today.md", "old");
    const a = f.editor("Daily/today.md", "expected");
    const b = f.editor("Daily/today.md", "expected");
    a.onSave = () => { a.value = "new keystroke"; };
    await conflict(flushNativeEditors(f.app, "Daily/today.md"));
    assert.equal(a.value, "new keystroke"); assert.equal(b.saves, 0);
    assert.deepEqual(a.setValues, []); assert.deepEqual(b.setValues, []);
  }

  // A successful source write starts from the native draft and updates its agreeing copies.
  {
    const f = fixture();
    f.file("Daily/today.md", "stale disk");
    const a = f.editor("Daily/today.md", "native expected");
    const b = f.editor("Daily/today.md", "native expected");
    await saveDiarySource(f.app, "Daily/today.md", "accepted replacement", "native expected");
    assert.equal(f.data.get("Daily/today.md"), "accepted replacement");
    assert.equal(a.value, "accepted replacement"); assert.equal(b.value, "accepted replacement");
  }

  // Both external disk edits and native edits arriving after the initial read stop the CAS.
  for (const native of [false, true]) {
    const f = fixture();
    f.file("Daily/today.md", "expected");
    const view = native ? f.editor("Daily/today.md", "expected") : null;
    f.hooks.beforeProcess = () => {
      if (view) view.value = "new native input";
      else f.data.set("Daily/today.md", "external disk edit");
    };
    await conflict(saveDiarySource(f.app, "Daily/today.md", "replacement", "expected"));
    assert.equal(f.data.get("Daily/today.md"), native ? "expected" : "external disk edit");
    if (view) assert.equal(view.value, "new native input");
  }

  // Late typing during the disk write is preserved in editor and disk and reported as a conflict.
  {
    const f = fixture();
    f.file("Daily/today.md", "expected");
    const view = f.editor("Daily/today.md", "expected");
    f.hooks.afterProcess = () => { view.value = "typed while saving"; };
    await conflict(saveDiarySource(f.app, "Daily/today.md", "replacement", "expected"));
    assert.equal(view.value, "typed while saving");
    assert.equal(f.data.get("Daily/today.md"), "typed while saving");
    assert.deepEqual(view.setValues, []);
  }

  // The same boundary protects hand-edited derived English from repository writes.
  {
    const f = fixture();
    f.file("English/today.md", "machine version");
    const view = f.editor("English/today.md", "handwritten expected");
    f.hooks.afterProcess = () => { view.value = "late handwritten version"; };
    await conflict(f.port.write("English/today.md", "new result", "handwritten expected"));
    assert.equal(f.data.get("English/today.md"), "late handwritten version");
    assert.equal(view.value, "late handwritten version");
  }

  // Existing hidden metadata uses atomic adapter.process rather than read + unconditional write.
  {
    const f = fixture();
    f.data.set(".state/diary.json", "expected");
    f.hooks.beforeProcess = () => { f.data.set(".state/diary.json", "another operation"); };
    await conflict(f.port.write(".state/diary.json", "replacement", "expected"));
    assert.equal(f.data.get(".state/diary.json"), "another operation");
    assert.ok(f.calls.includes("adapter.process:.state/diary.json"));
    assert.equal(f.calls.some((call) => call.startsWith("adapter.write:")), false);
  }

  // Product writes of the same managed path are serialized, including initial creation.
  {
    const f = fixture();
    const results = await Promise.allSettled([
      f.port.write(".state/new.json", "first", null), f.port.write(".state/new.json", "second", null)
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(f.data.get(".state/new.json"), "first");
    await assert.rejects(f.port.write("Daily/private.md", "bad", null), (error: unknown) => error instanceof EnglishDiaryRepositoryError && error.code === "INVALID_PATH");
  }

  // Native creation also refuses a user's file which appeared after the absence check.
  {
    const f = fixture();
    f.hooks.beforeCreate = (path) => { f.file(path, "user created this"); };
    await assert.rejects(f.port.write("English/new.md", "generated", null));
    assert.equal(f.data.get("English/new.md"), "user created this");
  }

  // Hidden Markdown is fully managed through adapter APIs, even if a stale native file exists.
  {
    const f = fixture();
    const root = ".echoink/english-diary/expressions";
    const path = `${root}/工作/term.md`, moved = `${root}/学习/term.md`;
    f.hooks.beforeCreate = () => { throw new Error("hidden Markdown must not use Vault.create"); };
    await f.port.write(path, "first hidden note", null);
    assert.ok(f.calls.includes(`adapter.write:${path}`));
    assert.ok(f.calls.includes("adapter.mkdir:.echoink"));
    assert.equal(f.files.has(path), false);
    f.file(path, "first hidden note");
    const staleEditor = f.editor(path, "stale native buffer");
    assert.equal(await f.port.read(path), "first hidden note");
    await f.port.write(path, "updated hidden note", "first hidden note");
    assert.ok(f.calls.includes(`adapter.process:${path}`));
    assert.deepEqual(await f.port.list(root), [path]);
    await f.port.move(path, moved, "updated hidden note");
    assert.equal(await f.port.read(path), null);
    assert.equal(await f.port.read(moved), "updated hidden note");
    assert.ok(f.calls.includes(`adapter.rename:${path}->${moved}`));
    await f.port.remove(moved, "updated hidden note");
    assert.equal(await f.port.read(moved), null);
    assert.ok(f.calls.includes(`adapter.remove:${moved}`));
    assert.equal(staleEditor.saves, 0);
    assert.deepEqual(staleEditor.setValues, []);
  }

  // The visible-to-hidden backup move first saves the agreeing native draft and checks its bytes.
  {
    const f = fixture();
    f.file("Expressions/term.md", "old disk");
    const editor = f.editor("Expressions/term.md", "user note from editor");
    const target = ".state/expression-migration-backup/id.md";
    await f.port.move("Expressions/term.md", target, "user note from editor");
    assert.equal(f.data.get(target), "user note from editor");
    assert.equal(await f.port.read("Expressions/term.md"), null);
    assert.equal(editor.saves, 1);
    assert.ok(f.calls.includes(`adapter.rename:Expressions/term.md->${target}`));
  }

  // A changed source or occupied destination is retained when a hidden move is refused.
  {
    const f = fixture();
    const root = ".echoink/english-diary/expressions";
    await f.port.write(`${root}/a.md`, "original", null);
    await f.port.write(`${root}/b.md`, "other", null);
    await conflict(f.port.move(`${root}/a.md`, `${root}/b.md`, "original"));
    await conflict(f.port.move(`${root}/a.md`, `${root}/c.md`, "stale snapshot"));
    assert.equal(await f.port.read(`${root}/a.md`), "original");
    assert.equal(await f.port.read(`${root}/b.md`), "other");
    assert.equal(await f.port.read(`${root}/c.md`), null);
  }

}
