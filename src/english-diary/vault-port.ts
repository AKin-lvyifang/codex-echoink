import { MarkdownView, TFile, TFolder, type App } from "obsidian";
import type { DiaryFilePort, DiarySource } from "./types";
import { EnglishDiaryRepositoryError, normalizeDiaryPath } from "./repository";

const conflict = (): never => {
  throw new EnglishDiaryRepositoryError("FILE_MODIFIED", "内容已在其他窗口修改，当前编辑内容已保留，请重新查看后再保存。");
};
const locks = new WeakMap<App, Map<string, Promise<unknown>>>();

/** Serialize this product's mutations of one path without flushing unrelated documents. */
async function withPathLock<T>(app: App, path: string, action: () => Promise<T>): Promise<T> {
  let pending = locks.get(app);
  if (!pending) { pending = new Map(); locks.set(app, pending); }
  const previous = pending.get(path) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  pending.set(path, result);
  try { return await result; }
  finally { if (pending.get(path) === result) pending.delete(path); }
}

function nativeEditors(app: App, path: string): MarkdownView[] {
  return app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view)
    .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path
      && (typeof view.getMode !== "function" || view.getMode() !== "preview"));
}

function nativeSnapshot(app: App, path: string): { views: MarkdownView[]; content: string | null } {
  const views = nativeEditors(app, path);
  const values = new Set(views.map((view) => view.editor.getValue()));
  if (values.size > 1) conflict();
  return { views, content: views.length ? views[0].editor.getValue() : null };
}

function requireFile(app: App, path: string): TFile {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    throw new EnglishDiaryRepositoryError("NOT_FOUND", "日记文件不存在，请重新打开原日记。");
  }
  return file;
}

async function readNativeContent(app: App, file: TFile): Promise<string> {
  const before = nativeSnapshot(app, file.path);
  if (before.content !== null) return before.content;
  const disk = await app.vault.read(file);
  // A native editor may have opened or acquired a newer draft during the disk read.
  return nativeSnapshot(app, file.path).content ?? disk;
}

async function flushNativeEditorsUnlocked(app: App, path: string): Promise<void> {
  const snapshot = nativeSnapshot(app, path);
  if (snapshot.content === null) return;
  const file = requireFile(app, path);
  const disk = await app.vault.read(file);
  if (nativeSnapshot(app, path).content !== snapshot.content) conflict();
  if (disk === snapshot.content) return;
  // All open copies agree. Saving one avoids replaying stale copies in later tabs.
  await snapshot.views[0].save();
  if (nativeSnapshot(app, path).content !== snapshot.content) conflict();
  const saved = await app.vault.read(file);
  if (saved !== snapshot.content || nativeSnapshot(app, path).content !== snapshot.content) conflict();
}

export async function flushNativeEditors(app: App, value: string): Promise<void> {
  const path = normalizeDiaryPath(value);
  await withPathLock(app, path, () => flushNativeEditorsUnlocked(app, path));
}

async function preserveLateEdit(app: App, path: string): Promise<never> {
  // A late keystroke stays in its native editor. If copies agree, let the native
  // save path persist that latest content; never setValue on a diverged editor.
  await flushNativeEditorsUnlocked(app, path);
  return conflict();
}

/** Compare both the disk and live editors at the actual native process boundary. */
async function writeNativeFile(app: App, file: TFile, content: string, expected: string): Promise<void> {
  const path = file.path;
  if (await readNativeContent(app, file) !== expected) conflict();
  await flushNativeEditorsUnlocked(app, path);
  await app.vault.process(file, (current) => {
    if (current !== expected) conflict();
    const live = nativeSnapshot(app, path);
    if (live.content !== null && live.content !== expected) conflict();
    return content;
  });
  const views = nativeEditors(app, path);
  if (views.some((view) => ![expected, content].includes(view.editor.getValue()))) {
    return preserveLateEdit(app, path);
  }
  for (const view of views) {
    if (view.editor.getValue() === expected && expected !== content) view.editor.setValue(content);
  }
  const saved = await app.vault.read(file);
  const live = nativeSnapshot(app, path);
  if (live.content !== null && live.content !== content) return preserveLateEdit(app, path);
  if (saved !== content) conflict();
}

const hiddenPath = (path: string): boolean => path.split("/").some((part) => part.startsWith("."));

/** Hidden product files use the adapter; ordinary Markdown uses the native Vault API. */
export class EnglishDiaryVaultPort implements DiaryFilePort {
  private readonly roots: readonly string[];
  constructor(private readonly app: App, roots: readonly string[]) {
    this.roots = roots.map(normalizeDiaryPath);
  }

  private path(value: string): string {
    const path = normalizeDiaryPath(value);
    if (!this.roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      throw new EnglishDiaryRepositoryError("INVALID_PATH", "路径不在英文日记的数据目录内。");
    }
    return path;
  }

  async read(value: string): Promise<string | null> {
    const path = this.path(value);
    if (hiddenPath(path)) {
      if (!await this.app.vault.adapter.exists(path)) return null;
      return this.app.vault.adapter.read(path);
    }
    if (!await this.app.vault.adapter.exists(path)) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFolder) throw new Error("文件路径被文件夹占用。");
    if (file instanceof TFile) return readNativeContent(this.app, file);
    return this.app.vault.adapter.read(path);
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current)) {
        try {
          if (hiddenPath(current)) await this.app.vault.adapter.mkdir(current);
          else await this.app.vault.createFolder(current);
        }
        catch (error) { if (!await this.app.vault.adapter.exists(current)) throw error; }
      }
    }
  }

  async write(value: string, content: string, expected: string | null): Promise<void> {
    const path = this.path(value);
    await withPathLock(this.app, path, async () => {
      if (await this.read(path) !== expected) conflict();
      await this.ensureParent(path);
      const file = hiddenPath(path) ? null : this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFolder) conflict();
      if (file instanceof TFile) {
        if (expected === null) return conflict();
        await writeNativeFile(this.app, file, content, expected);
      } else if (!hiddenPath(path) && path.toLowerCase().endsWith(".md")) {
        if (expected !== null) conflict();
        // Native create refuses a destination which appeared after the read.
        await this.app.vault.create(path, content);
      } else if (expected !== null) {
        await this.app.vault.adapter.process(path, (current) => {
          if (current !== expected) conflict();
          return content;
        });
      } else {
        // DataAdapter has no exclusive-create operation. Serialize our creates
        // and recheck immediately before writing the managed private state file.
        if (await this.app.vault.adapter.exists(path)) conflict();
        await this.app.vault.adapter.write(path, content);
      }
    });
  }

  async list(value: string): Promise<string[]> {
    const directory = this.path(value);
    if (!await this.app.vault.adapter.exists(directory)) return [];
    const result = await this.app.vault.adapter.list(directory);
    const nested = await Promise.all(result.folders.map((folder) => this.list(folder)));
    return [...result.files, ...nested.flat()];
  }

  async move(from: string, to: string, expected?: string): Promise<void> {
    from = this.path(from);
    to = this.path(to);
    await withPathLock(this.app, from, async () => {
      if (expected !== undefined && await this.read(from) !== expected) conflict();
      if (await this.read(to) !== null) conflict();
      await this.ensureParent(to);
      if (!hiddenPath(from)) await flushNativeEditorsUnlocked(this.app, from);
      const file = this.app.vault.getAbstractFileByPath(from);
      if (expected !== undefined && await this.read(from) !== expected) conflict();
      if (await this.read(to) !== null) conflict();
      if (!hiddenPath(from) && !hiddenPath(to) && file instanceof TFile) await this.app.fileManager.renameFile(file, to);
      else await this.app.vault.adapter.rename(from, to);
    });
  }

  async remove(value: string, expected: string): Promise<void> {
    const path = this.path(value);
    await withPathLock(this.app, path, async () => {
      if (await this.read(path) !== expected) conflict();
      if (!hiddenPath(path)) await flushNativeEditorsUnlocked(this.app, path);
      if (await this.read(path) !== expected) conflict();
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!hiddenPath(path) && file instanceof TFile) await this.app.vault.trash(file, false);
      else await this.app.vault.adapter.remove(path);
    });
  }
}

export async function readDiarySource(app: App, value: string): Promise<DiarySource> {
  const path = normalizeDiaryPath(value);
  const file = requireFile(app, path);
  if (file.extension !== "md") throw new Error("日记原稿不是 Markdown 文件。");
  const content = await readNativeContent(app, file);
  return { path, title: file.basename, date: file.basename, content };
}

export async function saveDiarySource(app: App, value: string, content: string, expected: string): Promise<void> {
  const path = normalizeDiaryPath(value);
  await withPathLock(app, path, async () => {
    const file = requireFile(app, path);
    if (file.extension !== "md") throw new Error("日记原稿不是 Markdown 文件。");
    await writeNativeFile(app, file, content, expected);
  });
}
