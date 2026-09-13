import { Notice, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { newId } from "../settings/settings";
import {
  appendRecordBlock,
  locateRecord,
  parseTodoMarkdown,
  replaceRecordLines,
  serializeTodoRecord,
  type ParsedTodoRecord
} from "./todo-markdown";

export const TODO_SOURCE_PATH = "EchoInk/待办.md";
const TODO_BACKUP_PATH = "EchoInk/待办-settings-backup.json";
const SOURCE_HEADER = "<!-- EchoInk 待办源文件：任务行即待办记录，缩进子项为元数据；ID 注释无需手动维护。 -->";

export interface TodoInput {
  title: string;
  people?: string;
  dueDate?: string;
  categoryName?: string;
  done?: boolean;
  id?: string;
}

/**
 * Markdown-backed to-do store. The Vault file is the single source of truth:
 * every UI mutation re-reads the latest content before writing, file events
 * push refreshes into open surfaces, and unparsable content is preserved.
 */
export class EchoInkTodoStore {
  private records: ParsedTodoRecord[] = [];
  private listeners = new Set<() => void>();
  private writeQueue: Promise<void> = Promise.resolve();
  private reloadTimer: number | null = null;
  private initialized = false;

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  get sourcePath(): string {
    return TODO_SOURCE_PATH;
  }

  snapshot(): readonly ParsedTodoRecord[] {
    return this.records;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      await this.initializeInner();
    } catch (error) {
      this.initialized = false;
      throw error;
    }
  }

  private async initializeInner(): Promise<void> {
    const vault = this.plugin.app.vault;
    this.plugin.registerEvent(vault.on("modify", (file) => {
      if (file.path === TODO_SOURCE_PATH) this.scheduleReload();
    }));
    this.plugin.registerEvent(vault.on("create", (file) => {
      if (file.path === TODO_SOURCE_PATH) this.scheduleReload();
    }));
    this.plugin.registerEvent(vault.on("delete", (file) => {
      if (file.path !== TODO_SOURCE_PATH) return;
      // Never resurrect from cache: a deleted source means an empty list.
      this.records = [];
      this.notify();
    }));
    await this.migrateLegacySettings();
    await this.reload();
  }

  private async ensureFolder(): Promise<void> {
    const vault = this.plugin.app.vault;
    if (!vault.getAbstractFileByPath("EchoInk")) {
      await vault.createFolder("EchoInk");
    }
  }

  async reload(): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(TODO_SOURCE_PATH);
    if (!(file instanceof TFile)) {
      this.records = [];
      this.notify();
      return;
    }
    const content = await this.plugin.app.vault.cachedRead(file);
    const parsed = parseTodoMarkdown(content);
    this.records = parsed.records;
    if (parsed.warnings.length) {
      console.warn(
        `[EchoInk] ${TODO_SOURCE_PATH} 第 ${parsed.warnings.join(", ")} 行无法解析，已保留原文。`
      );
      new Notice(
        this.plugin.settings.settingsLanguage === "en"
          ? `To-do source: line(s) ${parsed.warnings.join(", ")} could not be parsed and were kept as-is.`
          : `待办源文件第 ${parsed.warnings.join(", ")} 行无法解析，已保留原文。`
      );
    }
    await this.adoptUnknownCategories(parsed.records);
    this.notify();
  }

  private scheduleReload(): void {
    const win = this.plugin.app.workspace.containerEl.ownerDocument.defaultView;
    if (this.reloadTimer !== null) win?.clearTimeout(this.reloadTimer);
    this.reloadTimer = win?.setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, 250) ?? null;
  }

  /** Hand-written category names join the category list; same name never duplicates. */
  private async adoptUnknownCategories(records: readonly ParsedTodoRecord[]): Promise<void> {
    let changed = false;
    for (const record of records) {
      const name = record.categoryName.trim();
      if (!name) continue;
      if (!this.plugin.settings.todoCategories.some((category) => category.name === name)) {
        this.plugin.settings.todoCategories.push({ id: newId("todo-category"), name });
        changed = true;
      }
    }
    if (changed) await this.plugin.saveSettings();
  }

  /** One-time migration of legacy settings.todos into the Markdown source. */
  private async migrateLegacySettings(): Promise<void> {
    const legacy = this.plugin.settings.todos;
    if (!legacy.length) return;
    const vault = this.plugin.app.vault;
    await this.ensureFolder();
    const backup = vault.getAbstractFileByPath(TODO_BACKUP_PATH);
    if (!backup) {
      await vault.create(
        TODO_BACKUP_PATH,
        `${JSON.stringify({ todos: legacy }, null, 2)}\n`
      );
    }
    const file = vault.getAbstractFileByPath(TODO_SOURCE_PATH);
    const existing = file instanceof TFile
      ? await vault.read(file)
      : "";
    const existingKeys = new Set(
      parseTodoMarkdown(existing).records.map((record) => this.recordKey(record.title, record.done, record.dueDate))
    );
    const blocks = legacy
      .filter((todo) => !existingKeys.has(this.recordKey(todo.title, todo.done, todo.dueDate)))
      .map((todo) => serializeTodoRecord({
        id: todo.id,
        title: todo.title,
        people: todo.people,
        dueDate: todo.dueDate,
        categoryName: this.plugin.settings.todoCategories.find((category) => category.id === todo.categoryId)?.name ?? "",
        done: todo.done,
        lineStart: 0,
        lineEnd: 0,
        extraMetaLines: []
      }));
    if (!blocks.length) {
      this.plugin.settings.todos = [];
      await this.plugin.saveSettings();
      return;
    }
    let content = existing;
    if (!content.trim()) content = `${SOURCE_HEADER}\n`;
    for (const block of blocks) content = appendRecordBlock(content, block);
    if (file instanceof TFile) await vault.modify(file, content);
    else await vault.create(TODO_SOURCE_PATH, content);
    const verifyAbstract = vault.getAbstractFileByPath(TODO_SOURCE_PATH);
    if (!(verifyAbstract instanceof TFile)) {
      console.error("[EchoInk] To-do migration read-back verification failed; keeping settings.todos.");
      return;
    }
    const verify = parseTodoMarkdown(await vault.read(verifyAbstract));
    const verifiedTitles = new Set(verify.records.map((record) => record.title));
    const missing = blocks.length && !legacy.every(
      (todo) => verifiedTitles.has(todo.title) || existingKeys.has(this.recordKey(todo.title, todo.done, todo.dueDate))
    );
    if (missing) {
      console.error("[EchoInk] To-do migration read-back verification failed; keeping settings.todos.");
      return;
    }
    this.plugin.settings.todos = [];
    await this.plugin.saveSettings();
  }

  private recordKey(title: string, done: boolean, dueDate: string): string {
    return `${title.trim()}|${done ? 1 : 0}|${dueDate}`;
  }

  async openSourceFile(): Promise<void> {
    const vault = this.plugin.app.vault;
    await this.ensureFolder();
    const abstract = vault.getAbstractFileByPath(TODO_SOURCE_PATH);
    const file = abstract instanceof TFile
      ? abstract
      : await vault.create(TODO_SOURCE_PATH, `${SOURCE_HEADER}\n`);
    const leaf = this.plugin.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true });
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async addTodo(input: TodoInput): Promise<void> {
    const record: ParsedTodoRecord = {
      id: input.id ?? newId("todo"),
      title: input.title.trim(),
      people: (input.people ?? "").trim(),
      dueDate: input.dueDate ?? "",
      categoryName: (input.categoryName ?? "").trim(),
      done: input.done === true,
      lineStart: 0,
      lineEnd: -1,
      extraMetaLines: []
    };
    await this.enqueueWrite((content) => ({
      content: appendRecordBlock(content, serializeTodoRecord(record))
    }));
  }

  async updateTodo(target: ParsedTodoRecord, patch: Partial<TodoInput>): Promise<void> {
    await this.enqueueWrite((content) => {
      const parsed = parseTodoMarkdown(content);
      const current = locateRecord(parsed.records, target);
      if (!current) return { content, skipped: true };
      const next: ParsedTodoRecord = {
        ...current,
        title: patch.title !== undefined ? patch.title.trim() : current.title,
        people: patch.people !== undefined ? patch.people.trim() : current.people,
        dueDate: patch.dueDate !== undefined ? patch.dueDate : current.dueDate,
        categoryName: patch.categoryName !== undefined ? patch.categoryName.trim() : current.categoryName,
        done: patch.done !== undefined ? patch.done === true : current.done
      };
      return { content: replaceRecordLines(content, current, serializeTodoRecord(next)) };
    });
  }

  async toggleDone(target: ParsedTodoRecord, done: boolean): Promise<void> {
    await this.updateTodo(target, { done });
  }

  async removeTodo(target: ParsedTodoRecord): Promise<void> {
    await this.enqueueWrite((content) => {
      const parsed = parseTodoMarkdown(content);
      const current = locateRecord(parsed.records, target);
      if (!current) return { content, skipped: true };
      return { content: replaceRecordLines(content, current, null) };
    });
  }

  /** Rename writes every matching category meta line in the source file. */
  async renameCategoryInSource(oldName: string, newName: string): Promise<void> {
    await this.enqueueWrite((content) => ({
      content: content.split("\n").map((line) => {
        const meta = /^(\s+[-*]\s+分类[：:])\s*(.*)$/u.exec(line);
        if (meta && meta[2].trim() === oldName) return `${meta[1]}${newName}`;
        return line;
      }).join("\n")
    }));
  }

  /** Deleting a category clears its meta lines; todos themselves stay. */
  async removeCategoryFromSource(name: string): Promise<void> {
    await this.enqueueWrite((content) => ({
      content: content
        .split("\n")
        .filter((line) => {
          const meta = /^(\s+[-*]\s+分类[：:])\s*(.*)$/u.exec(line);
          return !(meta && meta[2].trim() === name);
        })
        .join("\n")
    }));
  }

  /** Serialize UI writes and atomically transform the latest Vault content. */
  private enqueueWrite(
    mutate: (content: string) => { content: string; skipped?: boolean }
  ): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const vault = this.plugin.app.vault;
      await this.ensureFolder();
      const abstract = vault.getAbstractFileByPath(TODO_SOURCE_PATH);
      const file = abstract instanceof TFile
        ? abstract
        : await vault.create(TODO_SOURCE_PATH, `${SOURCE_HEADER}\n`);
      await vault.process(file, (content) => {
        const result = mutate(content);
        if (result.skipped) {
          throw new Error(this.plugin.settings.settingsLanguage === "en"
            ? "The to-do changed or was removed. Refresh the list and try again."
            : "这条待办已被修改或删除，请刷新列表后重试。");
        }
        return result.content;
      });
      // A refresh failure after a successful write must not invite a retry
      // that would add the same task twice.
      try {
        await this.reload();
      } catch (error) {
        console.error("[EchoInk] To-do source was saved but could not be refreshed:", error);
        new Notice(this.plugin.settings.settingsLanguage === "en"
          ? "To-do saved. Could not refresh the list; reopen the home page."
          : "待办已保存，但列表刷新失败，请重新打开首页。");
      }
    });
    this.writeQueue = run.catch((error) => {
      console.error("[EchoInk] To-do source write failed:", error);
      new Notice(
        this.plugin.settings.settingsLanguage === "en"
          ? "Could not write the to-do source file."
          : "待办源文件写入失败。"
      );
    });
    // Recover the internal queue, but let the caller keep its draft on failure.
    return run;
  }
}
