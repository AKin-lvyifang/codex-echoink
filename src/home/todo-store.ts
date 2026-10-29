import { localTodoDate, reconcileTodoCompletions, todoCompletionStatistics, validTodoDate } from "./todo-completions";
import { Notice, TFile, TFolder } from "obsidian";
import type { TodoHost } from "./home-host";
import { getTodoProjects, resolveTodoProject, type TodoProject } from "./todo-projects";
import { newId } from "../core/new-id";
import { isTodoDueTime, normalizeTodoDueTime } from "./todo-due";
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
  dueTime?: string;
  categoryName?: string;
  project?: string;
  done?: boolean;
  id?: string;
}

export interface TodoReadSnapshot {
  sourcePath: string;
  exists: boolean;
  /** SHA-256 of the exact file content; null means the source does not exist. */
  contentVersion: string | null;
  records: ParsedTodoRecord[];
  warnings: number[];
}

/** The caller rechecks the live diary automation switch/lifecycle here. */
export type TodoDiaryGuard = () => boolean | void;
export interface TodoDiaryRecord {
  record: ParsedTodoRecord;
  /** Exact persisted block, excluding its location in the file. */
  version: string;
}
export class TodoDiaryVersionConflictError extends Error {
  readonly code = "todo_diary_version_changed";
  constructor(public readonly current: ParsedTodoRecord, public readonly currentVersion: string) {
    super("这条待办已被修改，请先查看当前内容再确认撤销。");
    this.name = "TodoDiaryVersionConflictError";
  }
}

function diaryVersion(record: ParsedTodoRecord): string {
  return record.sourceBlock ?? serializeTodoRecord(record);
}

function requireDiaryGuard(guard: TodoDiaryGuard): void {
  if (guard() === false) throw new Error("日记自动整理已关闭，未写入待办。");
}

function findDiaryRecord(records: readonly ParsedTodoRecord[], entryId: string): ParsedTodoRecord | null {
  const matches = records.filter(record => record.diaryEntryId === entryId);
  if (matches.length > 1) throw new TodoConflictError("todo_record_changed", "发现重复的日记待办来源，请先检查待办源文件。");
  return matches[0] ?? null;
}

export class TodoConflictError extends Error {
  constructor(public readonly code: "todo_source_changed" | "todo_record_changed", message: string) {
    super(message);
    this.name = "TodoConflictError";
  }
}

async function todoContentVersion(content: string, sourcePath = TODO_SOURCE_PATH): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourcePath === TODO_SOURCE_PATH ? content : `${sourcePath}\u0000${content}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
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
  private initialization: Promise<void> | null = null;
  private observing = false;
  private disposed = false;
  private hasObserved = false;
  private observedProjects: TodoProject[] = [];

  constructor(private readonly plugin: TodoHost, private readonly configuredSourcePath?: () => string | undefined) {}

  get sourcePath(): string {
    return this.configuredSourcePath?.() || TODO_SOURCE_PATH;
  }

  /** Serialize source changes with pending mutations; selecting never moves either file. */
  changeSource(expectedPath: string, save: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(async () => {
      if (this.sourcePath !== expectedPath) throw new TodoConflictError("todo_source_changed", "待办源文件已变化，请重新读取后重试。");
      await save(); this.records = []; this.hasObserved = false; await this.reloadInner();
    });
    this.writeQueue = run.catch(() => undefined); return run;
  }

  completionStatistics(now = new Date()) { return todoCompletionStatistics(this.plugin.settings.todoCompletions, now); }

  snapshot(): readonly ParsedTodoRecord[] {
    return this.records;
  }

  /** Agent reads never initialize, migrate, assign IDs, adopt categories or save history. */
  async readOnlySnapshot(): Promise<TodoReadSnapshot> {
    const sourcePath = this.sourcePath, file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!file) return { sourcePath, exists: false, contentVersion: null, records: [], warnings: [] };
    if (!(file instanceof TFile)) throw new Error("待办源文件位置不是文件。");
    const content = await this.plugin.app.vault.read(file);
    const contentVersion = await todoContentVersion(content, sourcePath);
    if (this.sourcePath !== sourcePath) throw new TodoConflictError("todo_source_changed", "待办源文件已变化，请重新读取后重试。");
    return { sourcePath, exists: true, contentVersion, ...parseTodoMarkdown(content) };
  }

  /** Full deduplication scope, with no UI/tool pagination or result truncation. */
  async snapshotForDiary(now = new Date()): Promise<Omit<TodoReadSnapshot, "records"> & { records: (ParsedTodoRecord & { completedAt: string | null })[] }> {
    await this.writeQueue;
    const snapshot = await this.readOnlySnapshot();
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7);
    const cutoffDate = localTodoDate(cutoff);
    const records = snapshot.records.map(record => ({ ...record,
      completedAt: record.done ? this.plugin.settings.todoCompletions[record.id] ?? null : null
    })).filter(record => !record.done || record.completedAt === null || record.completedAt >= cutoffDate);
    return { ...snapshot, records };
  }

  async getByDiaryEntryId(entryId: string): Promise<TodoDiaryRecord | null> {
    if (!entryId.trim()) throw new Error("日记抽取条目 ID 不能为空。");
    await this.writeQueue;
    const record = findDiaryRecord((await this.readOnlySnapshot()).records, entryId);
    return record ? { record, version: diaryVersion(record) } : null;
  }

  /** Internal automation entry; chat confirmation rules remain in the chat tools. */
  async addFromDiary(entryId: string, journalPath: string, input: TodoInput, guard: TodoDiaryGuard): Promise<TodoDiaryRecord & { created: boolean }> {
    guard = this.diaryGuard(guard);
    requireDiaryGuard(guard);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u.test(entryId)) throw new Error("日记抽取条目 ID 无效。");
    if (!journalPath.endsWith(".md") || /[\r\n[\]|#\\]/u.test(journalPath) || journalPath.split("/").some(part => !part || part === "." || part === "..")) throw new Error("日记来源路径无效。");
    this.validateDiaryInput(input);
    const record: ParsedTodoRecord = {
      id: newId("todo"), title: input.title.trim(), people: (input.people ?? "").trim(),
      dueDate: input.dueDate ?? "", dueTime: normalizeTodoDueTime(input.dueTime) || undefined,
      categoryName: (input.categoryName ?? "").trim(), project: input.project?.trim() || undefined,
      done: false, diaryEntryId: entryId, diaryJournalPath: journalPath,
      lineStart: 0, lineEnd: -1, extraMetaLines: []
    };
    let result: (TodoDiaryRecord & { created: boolean }) | undefined;
    let created = false;
    const sourcePath = this.sourcePath;
    await this.enqueueWrite(content => {
      const existing = findDiaryRecord(parseTodoMarkdown(content).records, entryId);
      if (existing) return { content };
      created = true;
      return { content: appendRecordBlock(content, serializeTodoRecord(record)) };
    }, undefined, sourcePath, { guard, verify: content => {
      const saved = findDiaryRecord(parseTodoMarkdown(content).records, entryId);
      if (!saved || (created && (saved.id !== record.id || serializeTodoRecord({ ...saved, sourceBlock: undefined }) !== serializeTodoRecord(record)))) throw new Error("日记待办写后核对失败。");
      result = { record: saved, version: diaryVersion(saved), created };
    } });
    return result!;
  }

  private diaryGuard(guard: TodoDiaryGuard): TodoDiaryGuard {
    return () => {
      if (this.disposed || this.plugin.settings.diaryOrganizerEnabled !== true) return false;
      return guard();
    };
  }

  private validateDiaryInput(input: TodoInput): void {
    for (const field of [input.title, input.people, input.categoryName, input.project]) {
      if (field && /[\r\n]|<!--/u.test(field)) throw new Error("待办字段不能包含换行或内部标记。");
    }
    if (!input.title.trim()) throw new Error("待办事项不能为空。");
    if (input.dueDate && !validTodoDate(input.dueDate)) throw new Error("待办截止日期无效。");
    this.validateDueTime(input.dueTime);
    if (input.dueTime && !input.dueDate) throw new Error("待办截止时间需要截止日期。");
  }

  /** Apply a user-confirmed diary correction to the same task, never add a replacement. */
  async updateFromDiary(entryId: string, expectedVersion: string, input: TodoInput, guard: TodoDiaryGuard): Promise<TodoDiaryRecord> {
    guard = this.diaryGuard(guard);
    requireDiaryGuard(guard);
    this.validateDiaryInput(input);
    let result: TodoDiaryRecord | undefined;
    let expected: string | undefined;
    const sourcePath = this.sourcePath;
    await this.enqueueWrite(content => {
      const current = findDiaryRecord(parseTodoMarkdown(content).records, entryId);
      if (!current) throw new TodoConflictError("todo_record_changed", "日记待办已被删除，请重新核对。");
      if (diaryVersion(current) !== expectedVersion) throw new TodoDiaryVersionConflictError(current, diaryVersion(current));
      const next: ParsedTodoRecord = { ...current, title: input.title.trim(),
        people: input.people !== undefined ? input.people.trim() : current.people,
        dueDate: input.dueDate ?? current.dueDate,
        categoryName: input.categoryName !== undefined ? input.categoryName.trim() : current.categoryName,
        project: input.project !== undefined ? input.project.trim() : current.project,
        done: input.done ?? current.done };
      next.dueTime = input.dueDate === "" ? undefined : input.dueTime !== undefined
        ? normalizeTodoDueTime(input.dueTime) || undefined : current.dueTime;
      expected = serializeTodoRecord(next);
      return { content: replaceRecordLines(content, current, expected) };
    }, undefined, sourcePath, { guard, verify: content => {
      const saved = findDiaryRecord(parseTodoMarkdown(content).records, entryId);
      if (!saved || diaryVersion(saved) !== expected) throw new Error("日记待办修改后核对失败。");
      result = { record: saved, version: diaryVersion(saved) };
    } });
    return result!;
  }

  async undoFromDiary(entryId: string, version: string, _force: boolean, guard: TodoDiaryGuard): Promise<{ removed: boolean }> {
    guard = this.diaryGuard(guard);
    requireDiaryGuard(guard);
    if (!entryId.trim()) throw new Error("日记抽取条目 ID 不能为空。");
    let removed = false;
    const sourcePath = this.sourcePath;
    // Do not create an empty source merely to undo an already missing record.
    await this.writeQueue;
    const snapshot = await this.readOnlySnapshot();
    if (!findDiaryRecord(snapshot.records, entryId)) return { removed: false };
    await this.enqueueWrite(content => {
      const current = findDiaryRecord(parseTodoMarkdown(content).records, entryId);
      if (!current) return { content };
      // Confirmed undo passes the version the user just reviewed; a further edit
      // must be reviewed again even when the caller marks the action as forced.
      if (diaryVersion(current) !== version) throw new TodoDiaryVersionConflictError(current, diaryVersion(current));
      removed = true;
      return { content: replaceRecordLines(content, current, null) };
    }, undefined, sourcePath, { guard, verify: content => {
      if (findDiaryRecord(parseTodoMarkdown(content).records, entryId)) throw new Error("日记待办撤销后核对失败。");
    } });
    return { removed };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;
    if (this.initialized) return;
    if (!this.initialization) this.initialization = this.initializeInner()
      .then(() => { this.initialized = true; })
      .finally(() => { this.initialization = null; });
    await this.initialization;
  }

  dispose(): void {
    this.disposed = true;
    const win = this.plugin.app.workspace.containerEl.ownerDocument.defaultView;
    if (this.reloadTimer !== null) win?.clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.listeners.clear();
  }

  private async initializeInner(): Promise<void> {
    const vault = this.plugin.app.vault;
    this.observedProjects = getTodoProjects(this.plugin);
    if (!this.observing) {
      this.observing = true;
      this.plugin.registerEvent(vault.on("modify", (file) => {
        if (file.path === this.sourcePath) this.scheduleReload();
      }));
      this.plugin.registerEvent(vault.on("create", (file) => {
        if (file.path === this.sourcePath) this.scheduleReload();
        else if (file instanceof TFolder) this.refreshProjects();
      }));
      this.plugin.registerEvent(vault.on("delete", (file) => {
        if (file.path !== this.sourcePath) { if (file instanceof TFolder) this.refreshProjects(); return; }
        // Never resurrect from cache: a deleted source means an empty list.
        this.records = [];
        this.notify();
      }));
      this.plugin.registerEvent(vault.on("rename", (file, oldPath) => {
        if (oldPath === this.sourcePath || file.path === this.sourcePath) this.scheduleReload();
        if (file instanceof TFolder) {
          const before = this.observedProjects;
          const newPath = file.path;
          // The Knowledge listener rebases bound roots through a promise queue.
          // Read its current bindings after this Vault event has been dispatched.
          void Promise.resolve().then(() => {
            if (this.disposed) return;
            const after = getTodoProjects(this.plugin);
            this.observedProjects = after;
            this.notify();
            return this.renameProjectInSource(oldPath, newPath, before, after);
          }).catch(error => console.error("[EchoInk] To-do project rename failed:", error));
        }
      }));
    }
    if (this.sourcePath === TODO_SOURCE_PATH) await this.migrateLegacySettings();
    await this.reload();
  }

  private refreshProjects(): void {
    this.observedProjects = getTodoProjects(this.plugin);
    this.notify();
  }

  /** Only a witnessed folder rename can rewrite a project association. */
  private async renameProjectInSource(oldPath: string, newPath: string, before: readonly TodoProject[], after: readonly TodoProject[]): Promise<void> {
    const renamedProject = after.some(project => {
      if (project.path !== newPath && !project.path.startsWith(`${newPath}/`)) return false;
      const oldProjectPath = oldPath + project.path.slice(newPath.length);
      return before.some(previous => previous.path === oldProjectPath) || !before.some(previous => previous.path === project.path);
    });
    if (!renamedProject) return;
    const mapping = new Map<string, string>();
    for (const project of before) {
      const moved = project.path === oldPath || project.path.startsWith(`${oldPath}/`);
      const nextPath = moved ? newPath + project.path.slice(oldPath.length) : project.path;
      const next = after.find(candidate => candidate.path === nextPath);
      if (next && (moved || project.value !== next.value)) mapping.set(project.path, nextPath);
    }
    if (!mapping.size || !(this.plugin.app.vault.getAbstractFileByPath(this.sourcePath) instanceof TFile)) return;
    await this.enqueueWrite(content => {
      let next = content;
      for (const record of parseTodoMarkdown(content).records.reverse()) {
        const resolution = resolveTodoProject(record.project, before);
        if (resolution.status !== "resolved" || !resolution.project) continue;
        const path = mapping.get(resolution.project.path);
        if (!path) continue;
        const project = after.find(candidate => candidate.path === path)!;
        if (record.project === project.value) continue;
        next = replaceRecordLines(next, record, serializeTodoRecord({ ...record, project: project.value }));
      }
      return { content: next };
    });
  }

  private async ensureFolder(): Promise<void> {
    const vault = this.plugin.app.vault, parts = this.sourcePath.split("/").slice(0, -1); let path = "";
    for (const part of parts) { path = path ? `${path}/${part}` : part; if (!vault.getAbstractFileByPath(path)) await vault.createFolder(path); }
  }

  async reload(): Promise<void> {
    if (this.disposed) return;
    const run = this.writeQueue.then(() => this.reloadInner());
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async saveCompletionHistory(records: readonly ParsedTodoRecord[], previous: readonly ParsedTodoRecord[], observed: boolean, localWrite = false): Promise<void> {
    const next = reconcileTodoCompletions(this.plugin.settings.todoCompletions, records, previous, observed, new Date(), localWrite);
    if (JSON.stringify(next) !== JSON.stringify(this.plugin.settings.todoCompletions)) {
      const previousHistory = this.plugin.settings.todoCompletions;
      this.plugin.settings.todoCompletions = next;
      try { await this.plugin.saveSettings(); }
      catch (error) { this.plugin.settings.todoCompletions = previousHistory; throw error; }
    }
  }

  private assignStableIds(content: string): string {
    const lines = content.split("\n");
    const seen = new Set<string>();
    for (const record of parseTodoMarkdown(content).records) {
      if (!record.id || seen.has(record.id)) {
        const id = newId("todo");
        lines[record.lineStart] = lines[record.lineStart].replace(/\s*<!--\s*echoink-todo-id:[^>]*-->/gu, "") + ` <!-- echoink-todo-id: ${id} -->`;
        seen.add(id);
      } else seen.add(record.id);
    }
    return lines.join("\n");
  }

  private async reloadInner(): Promise<void> {
    if (this.disposed) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) {
      this.records = [];
      this.notify();
      return;
    }
    let content = await this.plugin.app.vault.cachedRead(file);
    if (this.disposed) return;
    if (this.assignStableIds(content) !== content) {
      content = await this.plugin.app.vault.process(file, (latest) => this.assignStableIds(latest));
    }
    const parsed = parseTodoMarkdown(content);
    await this.saveCompletionHistory(parsed.records, this.records, this.hasObserved);
    this.hasObserved = true;
    this.records = parsed.records;
    if (parsed.warnings.length) {
      console.warn(
        `[EchoInk] ${this.sourcePath} 第 ${parsed.warnings.join(", ")} 行无法解析，已保留原文。`
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
    if (this.disposed) return;
    const win = this.plugin.app.workspace.containerEl.ownerDocument.defaultView;
    if (this.reloadTimer !== null) win?.clearTimeout(this.reloadTimer);
    this.reloadTimer = win?.setTimeout(() => {
      this.reloadTimer = null;
      void this.reload().catch((error) => console.error("[EchoInk] To-do source refresh failed:", error));
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
    const file = vault.getAbstractFileByPath(this.sourcePath);
    let existing = file instanceof TFile
      ? await vault.read(file)
      : "";
    if (file instanceof TFile && this.assignStableIds(existing) !== existing) {
      existing = await vault.process(file, (latest) => this.assignStableIds(latest));
    }
    const existingKeys = new Set(
      parseTodoMarkdown(existing).records.map((record) => this.recordKey(record.title, record.done, record.dueDate))
    );
    const existingRecords = parseTodoMarkdown(existing).records;
    for (const todo of legacy) {
      if (!todo.done || typeof todo.completedAt !== "number" || !Number.isFinite(todo.completedAt) || todo.completedAt <= 0 || todo.completedAt > Date.now()) continue;
      const match = existingRecords.find((record) => this.recordKey(record.title, record.done, record.dueDate) === this.recordKey(todo.title, todo.done, todo.dueDate));
      const id = match?.id || todo.id;
      if (id) this.plugin.settings.todoCompletions[id] = localTodoDate(new Date(todo.completedAt));
    }
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
    else await vault.create(this.sourcePath, content);
    const verifyAbstract = vault.getAbstractFileByPath(this.sourcePath);
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
    const abstract = vault.getAbstractFileByPath(this.sourcePath);
    const file = abstract instanceof TFile
      ? abstract
      : await vault.create(this.sourcePath, `${SOURCE_HEADER}\n`);
    const leaf = this.plugin.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true });
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async addTodo(input: TodoInput, expectedVersion?: string | null, expectedSourcePath?: string): Promise<void> {
    this.validateDueTime(input.dueTime);
    const record: ParsedTodoRecord = {
      id: input.id ?? newId("todo"),
      title: input.title.trim(),
      people: (input.people ?? "").trim(),
      dueDate: input.dueDate ?? "",
      dueTime: normalizeTodoDueTime(input.dueTime) || undefined,
      categoryName: (input.categoryName ?? "").trim(),
      project: input.project?.trim() || undefined,
      done: input.done === true,
      lineStart: 0,
      lineEnd: -1,
      extraMetaLines: []
    };
    await this.enqueueWrite((content) => ({
      content: appendRecordBlock(content, serializeTodoRecord(record))
    }), expectedVersion, expectedSourcePath);
  }

  async updateTodo(target: ParsedTodoRecord, patch: Partial<TodoInput>, expectedVersion?: string | null, expectedSourcePath?: string): Promise<void> {
    this.validateDueTime(patch.dueTime);
    await this.enqueueWrite((content) => {
      const parsed = parseTodoMarkdown(content);
      const current = locateRecord(parsed.records, target);
      if (!current || !this.sameRecord(current, target)) return { content, skipped: true };
      const next: ParsedTodoRecord = {
        ...current,
        title: patch.title !== undefined ? patch.title.trim() : current.title,
        people: patch.people !== undefined ? patch.people.trim() : current.people,
        dueDate: patch.dueDate !== undefined ? patch.dueDate : current.dueDate,
        categoryName: patch.categoryName !== undefined ? patch.categoryName.trim() : current.categoryName,
        project: patch.project !== undefined ? patch.project.trim() : current.project,
        done: patch.done !== undefined ? patch.done === true : current.done
      };
      next.dueTime = patch.dueDate === "" ? undefined
        : patch.dueTime !== undefined ? normalizeTodoDueTime(patch.dueTime) || undefined : current.dueTime;
      return { content: replaceRecordLines(content, current, serializeTodoRecord(next)) };
    }, expectedVersion, expectedSourcePath);
  }

  private sameRecord(current: ParsedTodoRecord, target: ParsedTodoRecord): boolean {
    const stripNewId = (value: string): string => {
      if (target.id) return value;
      const lines = value.split("\n");
      lines[0] = lines[0].replace(/ <!-- echoink-todo-id: [^>]* -->$/u, "");
      return lines.join("\n");
    };
    return target.sourceBlock !== undefined ? stripNewId(current.sourceBlock ?? "") === stripNewId(target.sourceBlock)
      : serializeTodoRecord(current) === serializeTodoRecord(target);
  }

  private validateDueTime(value: string | undefined): void {
    if (value?.trim() && !isTodoDueTime(value.trim())) {
      throw new Error(this.plugin.settings.settingsLanguage === "en"
        ? "Use a valid deadline time (HH:mm)." : "截止时间请使用有效的 HH:mm 格式。");
    }
  }

  async toggleDone(target: ParsedTodoRecord, done: boolean, expectedVersion?: string | null, expectedSourcePath?: string): Promise<void> {
    await this.updateTodo(target, { done }, expectedVersion, expectedSourcePath);
  }

  async removeTodo(target: ParsedTodoRecord, expectedVersion?: string | null, expectedSourcePath?: string): Promise<void> {
    await this.enqueueWrite((content) => {
      const parsed = parseTodoMarkdown(content);
      const current = locateRecord(parsed.records, target);
      if (!current || !this.sameRecord(current, target)) return { content, skipped: true };
      return { content: replaceRecordLines(content, current, null) };
    }, expectedVersion, expectedSourcePath);
  }

  /** Rename writes every matching category meta line in the source file. */
  async renameCategoryInSource(oldName: string, newName: string, expectedVersion?: string | null, expectedSourcePath?: string): Promise<void> {
    await this.enqueueWrite((content) => ({
      content: content.split("\n").map((line) => {
        const meta = /^(\s+[-*]\s+分类[：:])\s*(.*)$/u.exec(line);
        if (meta && meta[2].trim() === oldName) return `${meta[1]}${newName}`;
        return line;
      }).join("\n")
    }), expectedVersion, expectedSourcePath);
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
    mutate: (content: string) => { content: string; skipped?: boolean },
    expectedVersion?: string | null,
    expectedSourcePath = this.sourcePath,
    diary?: { guard: TodoDiaryGuard; verify: (content: string) => void }
  ): Promise<void> {
    const run = this.writeQueue.then(async () => {
      if (diary) requireDiaryGuard(diary.guard);
      if (this.sourcePath !== expectedSourcePath) throw new TodoConflictError("todo_source_changed", "待办数据文件已切换，请返回后重新打开；输入已保留。");
      const vault = this.plugin.app.vault;
      const abstract = vault.getAbstractFileByPath(this.sourcePath);
      if (abstract && !(abstract instanceof TFile)) throw new Error("待办源文件位置不是文件。");
      const expectedContent = expectedVersion !== undefined && abstract instanceof TFile ? await vault.read(abstract) : undefined;
      if (expectedVersion !== undefined && (abstract instanceof TFile ? await todoContentVersion(expectedContent!, this.sourcePath) !== expectedVersion : expectedVersion !== null)) {
        throw new TodoConflictError("todo_source_changed", "待办源文件已变化，请重新读取后重试。");
      }
      await this.ensureFolder();
      if (diary) requireDiaryGuard(diary.guard);
      const file = abstract instanceof TFile
        ? abstract
        : await vault.create(this.sourcePath, `${SOURCE_HEADER}\n`);
      let previous: ParsedTodoRecord[] = [];
      let next: ParsedTodoRecord[] = [];
      await vault.process(file, (content) => {
        if (diary) requireDiaryGuard(diary.guard);
        const guardedContent = expectedContent ?? (expectedVersion === null ? `${SOURCE_HEADER}\n` : undefined);
        if (guardedContent !== undefined && content !== guardedContent) throw new TodoConflictError("todo_source_changed", "待办源文件已变化，请重新读取后重试。");
        const stable = this.assignStableIds(content);
        previous = parseTodoMarkdown(stable).records;
        const result = mutate(stable);
        if (result.skipped) {
          throw new TodoConflictError("todo_record_changed", this.plugin.settings.settingsLanguage === "en"
            ? "The to-do changed or was removed. Refresh the list and try again."
            : "这条待办已被修改或删除，请刷新列表后重试。");
        }
        const stableResult = this.assignStableIds(result.content);
        next = parseTodoMarkdown(stableResult).records;
        return stableResult;
      });
      if (diary) {
        if (this.sourcePath !== expectedSourcePath) throw new TodoConflictError("todo_source_changed", "待办数据文件已切换，请重新核对日记待办。");
        diary.verify(await vault.read(file));
      }
      // A refresh failure after a successful write must not invite a retry
      // that would add the same task twice.
      try {
        // Observe the pre-write source too: deleting an old completed task retains its history.
        await this.saveCompletionHistory(previous, this.records, this.hasObserved);
        await this.saveCompletionHistory(next, previous, true, true);
        this.records = next;
        this.hasObserved = true;
        await this.reloadInner();
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
