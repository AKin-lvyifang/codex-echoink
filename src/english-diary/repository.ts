import { getProPluginAccess, requireProPlugin, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import { createHash } from "node:crypto";
import { DEFAULT_ENGLISH_DIRECTORY, HIDDEN_EXPRESSION_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY } from "./types";
import type {
  DiaryFilePort, DiaryGenerationDay, DiaryPrivacy, DiaryRecord, DiaryRepository, DiaryResult, DiarySource,
  ExpressionEntry, ExpressionOccurrence
} from "./types";
import { diaryWikiLink, expressionIdentity, migrateExpressionMarkdown, parseExpressionMarkdown, patchExpressionMarkdown, renderDiaryMarkdown, renderExpressionMarkdown } from "./markdown";

export type EnglishDiaryRepositoryErrorCode =
  | "INVALID_PATH" | "INVALID_STATE" | "FILE_MODIFIED" | "CONFLICT"
  | "SOURCE_CHANGED" | "ABORTED" | "NOT_FOUND" | "SAVE_FAILED";

export class EnglishDiaryRepositoryError extends Error {
  constructor(public readonly code: EnglishDiaryRepositoryErrorCode, message: string) {
    super(message);
    this.name = "EnglishDiaryRepositoryError";
  }
}

interface RepositoryOptions {
  stateDirectory: string; englishDirectory: string; expressionDirectory: string;
  legacyEnglishDirectories?: string[]; legacyExpressionDirectories?: string[];
}
interface FileChange { path: string; before: string | null; after: string }
interface GenerationEvent { operationId: string; date: string; expressionCount: number }
interface StoredRecord {
  schema: 1;
  id: string;
  sourcePath: string;
  englishPath: string;
  result: DiaryResult | null;
  savedFileFingerprint: string | null;
  privacy: DiaryPrivacy | null;
  pending: DiaryResult | null;
  pendingExpressionsAuthorized?: boolean;
  pendingKind?: "generation" | "correction";
  transaction: Transaction | null;
  generationActivity?: GenerationEvent[];
}
interface Transaction {
  operationId: string;
  kind?: "generation" | "correction";
  changes: FileChange[];
  next: Omit<StoredRecord, "transaction">;
}
interface LoadedState { value: StoredRecord; raw: string }
interface ExpressionMove { from: string; to: string; content: string }
interface ExpressionOperation {
  schema: 1;
  phase: "apply" | "rollback";
  changes: FileChange[];
  move?: ExpressionMove;
  diaryId?: string;
}
interface ExpressionState { schema: 1; entry: ExpressionEntry; managedFingerprint: string | null }
interface EntryFile { entry: ExpressionEntry; previous: ExpressionEntry; content: string; stateRaw: string; managedFingerprint: string | null }
interface PublishOptions {
  expressionPermit?: object;
  overwriteModified?: boolean;
  signal?: AbortSignal;
  sourceUnchanged: () => Promise<boolean>;
}
const fingerprint = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const fail = (code: EnglishDiaryRepositoryErrorCode, message: string): never => { throw new EnglishDiaryRepositoryError(code, message); };
const invalidExpression = (path: string): never => fail("INVALID_STATE", `表达文件或关联数据无法读取，请保留文件后恢复：${path}`);
const inconsistentExpression = (path: string): never => fail("CONFLICT", `表达关联数据不一致，已有内容已保留：${path}`);
const duplicateExpression = (path: string): never => fail("CONFLICT", `同一表达存在多个文件，请保留并整理重复文件：${path}`);
const migrationConflict = (path: string): never => fail("CONFLICT", `迁移目标或备份已有文件，已保留现有内容：${path}`);
const modifiedDuringSave = (): never => fail("CONFLICT", "文件在保存期间被修改，本次操作未覆盖它。");
const assertIdentity = (id: string): string => {
  if (!/^[a-f0-9]{24}$/.test(id)) return fail("INVALID_STATE", "关联标识无效。");
  return id;
};
function replaceDiaryLinks(content: string, from: string, to: string): string {
  const oldTarget = diaryWikiLink(from).slice(2, -2), newTarget = diaryWikiLink(to).slice(2, -2);
  return content.replaceAll(`[[${oldTarget}|`, `[[${newTarget}|`).replaceAll(`[[${oldTarget}]]`, `[[${newTarget}]]`);
}
const normalizedKey = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

function expressionMetadata(content: string, path: string): { legacy: ExpressionEntry | null; id: string | null } {
  let legacy: ExpressionEntry | null;
  try { legacy = parseExpressionMarkdown(content, path); }
  catch { return invalidExpression(path); }
  const marker = expressionIdentity(content), id = legacy?.id ?? marker;
  if (marker && marker !== id) return inconsistentExpression(path);
  return { legacy, id };
}
function expressionState(entry: ExpressionEntry, markdown: string): ExpressionState {
  return { schema: 1, entry, managedFingerprint: markdown === renderExpressionMarkdown(entry) ? fingerprint(markdown) : null };
}

function validGenerationDay(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function generationEvent(result: DiaryResult | null): GenerationEvent | null {
  if (!result || !result.operationId || typeof result.generatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result.generatedAt)
    || !validGenerationDay(result.generatedAt.slice(0, 10))) return null;
  const date = new Date(result.generatedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    operationId: result.operationId,
    date: [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"),
    expressionCount: result.expressions.filter((item) => item.type === "phrase" || item.type === "sentence").length
  };
}

/** Legacy files can prove only their current successful result, never inferred history. */
function generationEvents(state: StoredRecord): GenerationEvent[] {
  const events = state.generationActivity ?? [generationEvent(state.result)];
  return events.filter((item): item is GenerationEvent => !!item && typeof item.operationId === "string"
    && !!item.operationId && validGenerationDay(item.date) && Number.isSafeInteger(item.expressionCount) && item.expressionCount >= 0);
}

/** Normalize Windows-style separators without accepting absolute paths or traversal. */
export function normalizeDiaryPath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/\/$/, "");
  if (!path || path.startsWith("/") || /[\p{Cc}:]/u.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    return fail("INVALID_PATH", "英文日记只接受 Vault 内的相对路径。");
  }
  return path;
}

function filePart(value: string): string {
  const cleaned = value.normalize("NFKC").replace(/[<>:"/\\|?*\p{Cc}]/gu, "-").replace(/[. ]+$/g, "").trim().slice(0, 72);
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "未分类";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}

/** One serialized mutation queue protects shared entries across different diaries. */
export class EnglishDiaryRepository implements DiaryRepository {
  private readonly options: RepositoryOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  private readonly expressionPermits = new WeakMap<object, string>();

  acquireExpressionPermit(operationId: string): object {
    this.access.requireCapability("diary.expression.write");
    const permit = {};
    this.expressionPermits.set(permit, operationId);
    return permit;
  }

  constructor(private readonly files: DiaryFilePort, options: RepositoryOptions, private readonly access: CapabilityAccess = unavailableCapabilityAccess) {
    this.options = {
      stateDirectory: normalizeDiaryPath(options.stateDirectory),
      englishDirectory: normalizeDiaryPath(options.englishDirectory),
      expressionDirectory: normalizeDiaryPath(options.expressionDirectory),
      legacyEnglishDirectories: [...new Set([
        ...(options.legacyEnglishDirectories ?? []),
        ...(options.englishDirectory === DEFAULT_ENGLISH_DIRECTORY ? [LEGACY_ENGLISH_DIRECTORY] : [])
      ].map(normalizeDiaryPath))].filter((path) => path !== normalizeDiaryPath(options.englishDirectory)),
      legacyExpressionDirectories: [...new Set([
        ...(options.legacyExpressionDirectories ?? []),
        ...(options.expressionDirectory === HIDDEN_EXPRESSION_DIRECTORY ? [LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY] : [])
      ].map(normalizeDiaryPath))].filter((path) => path !== normalizeDiaryPath(options.expressionDirectory))
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private exclusive<T>(operation: () => Promise<T>, notify = false): Promise<T> {
    const run = async () => {
      await this.recoverOperation();
      await this.migrateEnglish();
      const result = await operation();
      if (notify) for (const listener of this.listeners) {
        try { listener(); } catch { /* UI listeners cannot invalidate a completed save. */ }
      }
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private statePath(id: string): string {
    return `${this.options.stateDirectory}/${assertIdentity(id)}.json`;
  }

  private assertUnder(path: string, directory: string): string {
    const normalized = normalizeDiaryPath(path);
    if (!normalized.startsWith(`${directory}/`)) return fail("INVALID_PATH", "目标文件不在英文日记配置目录中。");
    return normalized;
  }

  private validateState(value: StoredRecord): StoredRecord {
    if (value?.schema !== 1 || !/^[a-f0-9]{24}$/.test(value.id)
      || !(value.result === null || value.result?.schema === 1)
      || !(value.pending === null || value.pending?.schema === 1)) {
      return fail("INVALID_STATE", "英文日记本地状态损坏，请保留文件并恢复。");
    }
    value.sourcePath = normalizeDiaryPath(value.sourcePath);
    // Previously saved directories remain valid when the user changes defaults.
    value.englishPath = normalizeDiaryPath(value.englishPath);
    if (value.englishPath === value.sourcePath) return fail("INVALID_STATE", "英文与原稿不能使用同一个文件。");
    if (value.transaction) {
      for (const change of value.transaction.changes) {
        normalizeDiaryPath(change.path);
        if ((change.path !== value.englishPath && !this.isEntryPath(change.path)
          && !this.isEntryStatePath(change.path))
          || change.path === value.sourcePath || typeof change.after !== "string"
          || !(change.before === null || typeof change.before === "string")) {
          return fail("INVALID_STATE", "未完成的保存操作无效。");
        }
      }
    }
    return value;
  }

  private async loadState(id: string): Promise<LoadedState> {
    const raw = await this.files.read(this.statePath(id));
    if (raw === null) return fail("NOT_FOUND", "找不到这篇日记的英文关联。");
    try {
      const value = this.validateState(JSON.parse(raw) as StoredRecord);
      if (value.id !== id) return fail("INVALID_STATE", "日记关联标识不一致。");
      return { value, raw };
    } catch (error) {
      if (error instanceof EnglishDiaryRepositoryError) throw error;
      return fail("INVALID_STATE", "无法读取英文日记本地状态，请保留文件并恢复。");
    }
  }

  private async states(): Promise<LoadedState[]> {
    const paths = await this.files.list(this.options.stateDirectory);
    const results: LoadedState[] = [];
    for (const path of paths) {
      const normalized = this.assertUnder(path, this.options.stateDirectory);
      const name = normalized.slice(this.options.stateDirectory.length + 1);
      if (/^[a-f0-9]{24}\.json$/.test(name)) results.push(await this.loadState(name.slice(0, -5)));
    }
    return results;
  }

  private async writeChecked(path: string, content: string, expected: string | null): Promise<void> {
    await this.files.write(normalizeDiaryPath(path), content, expected);
    if (await this.files.read(path) !== content) fail("SAVE_FAILED", "写入后校验失败；已有内容和待恢复操作会保留。");
  }

  private async describe(state: StoredRecord): Promise<DiaryRecord> {
    const english = await this.files.read(state.englishPath);
    const observedFileFingerprint = english === null ? null : fingerprint(english);
    const { transaction: _transaction, pendingKind: _pendingKind, generationActivity: _activity, ...record } = clone(state);
    return {
      ...record,
      observedFileFingerprint,
      missingEnglish: !!state.result && english === null,
      englishModified: english !== null && observedFileFingerprint !== state.savedFileFingerprint
    };
  }

  private async guard(options: PublishOptions): Promise<void> {
    if (options.signal?.aborted) fail("ABORTED", "已取消生成，已有英文保持不变。");
    if (!await options.sourceUnchanged()) fail("SOURCE_CHANGED", "原稿已变化，本次结果未发布。");
    if (options.signal?.aborted) fail("ABORTED", "已取消生成，已有英文保持不变。");
  }

  /** Roll back only bytes still owned by this operation; concurrent edits are retained. */
  private async compensate(changes: FileChange[]): Promise<boolean> {
    let complete = true;
    for (const change of [...changes].reverse()) {
      try {
        const current = await this.files.read(change.path);
        if (current !== change.after) continue;
        if (change.before === null) await this.files.remove(change.path, change.after);
        else await this.writeChecked(change.path, change.before, change.after);
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private async recover(state: LoadedState): Promise<LoadedState> {
    if (!state.value.transaction) return state;
    if (!await this.compensate(state.value.transaction.changes)) {
      return fail("SAVE_FAILED", "上次保存尚未恢复，请关闭冲突文件后重试；生成内容仍保留。");
    }
    const value = { ...state.value, transaction: null };
    const raw = serialize(value);
    await this.writeChecked(this.statePath(value.id), raw, state.raw);
    return { value, raw };
  }

  async get(source: DiarySource): Promise<DiaryRecord> {
    return this.exclusive(async () => {
      const sourcePath = normalizeDiaryPath(source.path);
      const found = (await this.states()).find((state) => state.value.sourcePath === sourcePath);
      if (found) return this.describe((await this.recover(found)).value);
      let salt = 0;
      let id = fingerprint(sourcePath).slice(0, 24);
      while (await this.files.read(this.statePath(id)) !== null) id = fingerprint(`${sourcePath}:${++salt}`).slice(0, 24);
      const basename = `${filePart(source.date || source.title)}-${id.slice(0, 8)}`;
      let englishPath = `${this.options.englishDirectory}/${basename}.md`;
      let suffix = 0;
      while (englishPath === sourcePath || await this.files.read(englishPath) !== null) {
        englishPath = `${this.options.englishDirectory}/${basename}-${++suffix}.md`;
      }
      const value: StoredRecord = {
        schema: 1, id, sourcePath, englishPath, result: null,
        savedFileFingerprint: null, privacy: null, pending: null, transaction: null, generationActivity: []
      };
      if (getProPluginAccess(this.access, true).canWrite) await this.writeChecked(this.statePath(id), serialize(value), null);
      return this.describe(value);
    });
  }

  private isEntryPath(path: string): boolean {
    return path.toLowerCase().endsWith(".md") && [this.options.expressionDirectory, ...(this.options.legacyExpressionDirectories ?? [])]
      .some((root) => path.startsWith(`${root}/`));
  }

  private isEnglishPath(path: string): boolean {
    return path.toLowerCase().endsWith(".md") && [this.options.englishDirectory, ...(this.options.legacyEnglishDirectories ?? [])]
      .some((root) => path.startsWith(`${root}/`));
  }

  private migrationBackupPath(kind: "english" | "expression", id: string, sourcePath: string): string {
    return `${this.options.stateDirectory}/${kind}-migration-backup/${assertIdentity(id)}-${fingerprint(sourcePath).slice(0, 8)}.md`;
  }

  private isMigrationBackupPath(path: string): boolean {
    return path.startsWith(`${this.options.stateDirectory}/`)
      && /^(?:expression|english)-migration-backup\/[a-f0-9]{24}(?:-[a-f0-9]{8})?\.md$/.test(path.slice(this.options.stateDirectory.length + 1));
  }

  private async migrateEnglish(): Promise<void> {
    const roots = this.options.legacyEnglishDirectories ?? [];
    if (!roots.length) return;
    for (const loaded of await this.states()) {
      const oldPath = loaded.value.englishPath;
      if (oldPath.startsWith(`${this.options.englishDirectory}/`)) continue;
      const root = roots.filter((path) => oldPath.startsWith(`${path}/`)).sort((a, b) => b.length - a.length)[0];
      if (!root) continue;
      let state = await this.recover(await this.loadState(loaded.value.id));
      const target = `${this.options.englishDirectory}/${oldPath.slice(root.length + 1)}`;
      const backup = this.migrationBackupPath("english", state.value.id, oldPath);
      if (await this.files.read(target) !== null || await this.files.read(backup) !== null) return migrationConflict(oldPath);
      const content = await this.files.read(oldPath);
      const changes: FileChange[] = [];
      for (const file of await this.entryFiles()) {
        const paths = new Set(file.entry.occurrences.filter((item) => item.journalId === state.value.id).map((item) => item.englishPath));
        if (!paths.size) continue;
        const next = clone(file.entry);
        for (const item of next.occurrences) if (item.journalId === state.value.id) item.englishPath = target;
        let markdown = file.content;
        for (const path of paths) markdown = replaceDiaryLinks(markdown, path, target);
        changes.push(...await this.entryChanges(file, next, markdown));
      }
      // Reading entries may recover other journals; reload this record before its CAS.
      state = await this.loadState(state.value.id);
      if (content !== null) changes.push({ path: target, before: null, after: content });
      changes.push({ path: this.statePath(state.value.id), before: state.raw, after: serialize({ ...state.value, englishPath: target }) });
      await this.applyChanges(changes, content === null ? undefined : { from: oldPath, to: backup, content }, state.value.id);
    }
  }

  private async *markdownFiles(directory: string, exclude?: string): AsyncGenerator<{ path: string; content: string }> {
    for (const candidate of await this.files.list(directory)) {
      const path = this.assertUnder(candidate, directory);
      if (!path.toLowerCase().endsWith(".md") || (exclude && path.startsWith(`${exclude}/`))) continue;
      const content = await this.files.read(path);
      if (content !== null) yield { path, content };
    }
  }

  /** Move only recognized old product files; keep their exact bytes as a hidden backup. */
  private async migrateEntries(): Promise<void> {
    if (!this.options.legacyExpressionDirectories?.length) return;
    const hiddenIds = new Set<string>();
    for await (const { path, content } of this.markdownFiles(this.options.expressionDirectory)) {
      const id = expressionIdentity(content) ?? expressionMetadata(content, path).id;
      if (id) hiddenIds.add(id);
    }
    for (const directory of this.options.legacyExpressionDirectories) {
    for await (const { path, content } of this.markdownFiles(directory, this.options.expressionDirectory)) {
      const { legacy, id } = expressionMetadata(content, path);
      if (!id) continue; // Ordinary user files in the old folder never move.
      if (hiddenIds.has(id)) return duplicateExpression(path);
      const statePath = this.entryStatePath(id);
      const { raw: stateRaw, state } = await this.entryData(id, legacy, content, path);
      const entry = state.entry;
      const relative = path.slice(directory.length + 1);
      const target = `${this.options.expressionDirectory}/${relative}`;
      const backup = this.migrationBackupPath("expression", id, path);
      if (await this.files.read(target) !== null || await this.files.read(backup) !== null) return migrationConflict(path);
      const category = relative.split("/").slice(0, -1).join("/");
      if (category && category !== filePart(entry.category)) { entry.category = category; entry.userCategory = true; }
      entry.path = target;
      const markdown = legacy ? migrateExpressionMarkdown(content, id) : content;
      const nextState = expressionState(entry, markdown);
      await this.applyChanges([
        { path: statePath, before: stateRaw, after: serialize(nextState) },
        { path: target, before: null, after: markdown }
      ], { from: path, to: backup, content });
      hiddenIds.add(id);
    }
    }
  }

  private entryStatePath(id: string): string {
    return `${this.options.stateDirectory}/expressions/${assertIdentity(id)}.json`;
  }

  private isEntryStatePath(path: string): boolean {
    const prefix = `${this.options.stateDirectory}/expressions/`;
    return path.startsWith(prefix) && /^[a-f0-9]{24}\.json$/.test(path.slice(prefix.length));
  }

  private async entryData(id: string, legacy: ExpressionEntry | null, content: string, path: string): Promise<{ raw: string | null; state: ExpressionState }> {
    const raw = await this.files.read(this.entryStatePath(id));
    let state: ExpressionState;
    if (raw === null) {
      if (!legacy) return invalidExpression(path);
      state = { schema: 1, entry: legacy, managedFingerprint: null };
    } else {
      try {
        const value = JSON.parse(raw) as ExpressionState;
        if (value.schema !== 1 || value.entry?.id !== id
          || !(value.managedFingerprint === null || /^[a-f0-9]{64}$/.test(value.managedFingerprint))) throw new Error("invalid");
        const entry = parseExpressionMarkdown(content, path, value.entry);
        if (!entry) throw new Error("invalid");
        state = { ...value, entry };
      } catch { return invalidExpression(path); }
      if (legacy && JSON.stringify(legacy) !== JSON.stringify(state.entry)) return inconsistentExpression(path);
    }
    return { raw, state };
  }

  private async entryFiles(): Promise<EntryFile[]> {
    // A library-first reopen must recover the same journal as reopening its diary.
    for (const state of await this.states()) if (state.value.transaction) await this.recover(state);
    await this.migrateEntries();
    const entries: EntryFile[] = [];
    const seen = new Set<string>();
    for await (const file of this.markdownFiles(this.options.expressionDirectory)) {
      const normalized = file.path;
      let content = file.content;
      const { legacy, id } = expressionMetadata(content, normalized);
      if (!id) {
        if (content.includes("<!-- echoink-expression-id:")) return invalidExpression(normalized);
        continue;
      }
      if (seen.has(id)) return duplicateExpression(normalized);
      seen.add(id);
      const statePath = this.entryStatePath(id);
      const data = await this.entryData(id, legacy, content, normalized);
      let stateRaw = data.raw;
      if (legacy) {
        if (stateRaw === null) {
          stateRaw = serialize(data.state);
          // Keep the original payload until its private copy has been durably written.
          await this.writeChecked(statePath, stateRaw, null);
        }
        let migrated: string;
        try { migrated = migrateExpressionMarkdown(content, id); }
        catch { return inconsistentExpression(normalized); }
        await this.writeChecked(normalized, migrated, content);
        content = migrated;
      }
      if (stateRaw === null) return invalidExpression(normalized);
      const state = data.state, entry = state.entry;
      const previous = clone(entry);
      const relativeDirectory = normalized.slice(this.options.expressionDirectory.length + 1).split("/").slice(0, -1).join("/");
      if (relativeDirectory && relativeDirectory !== filePart(entry.category)) {
        entry.category = relativeDirectory;
        entry.userCategory = true;
      }
      entries.push({ entry, previous, content, stateRaw, managedFingerprint: state.managedFingerprint });
    }
    return entries;
  }

  private async entryChanges(file: EntryFile | null, next: ExpressionEntry, content?: string): Promise<FileChange[]> {
    let markdown: string;
    try {
      markdown = content ?? (!file || (file.managedFingerprint !== null && fingerprint(file.content) === file.managedFingerprint)
        ? renderExpressionMarkdown(next) : patchExpressionMarkdown(file.content, file.previous, next));
    } catch (error) { return fail("CONFLICT", error instanceof Error ? error.message : "表达笔记已变化，请重新打开。"); }
    const path = this.entryStatePath(next.id);
    if (!file && await this.files.read(path) !== null) return fail("CONFLICT", "表达内部数据已存在，请先恢复对应笔记。");
    const state = expressionState(next, markdown);
    return [
      { path, before: file?.stateRaw ?? null, after: serialize(state) },
      { path: next.path, before: file?.content ?? null, after: markdown }
    ].filter((change) => change.before !== change.after);
  }

  private operationPath(): string { return `${this.options.stateDirectory}/expression-operation.json`; }

  private async readOperation(raw: string): Promise<ExpressionOperation> {
    try {
      const operation = JSON.parse(raw) as ExpressionOperation;
      if (operation.schema !== 1 || !["apply", "rollback"].includes(operation.phase) || !Array.isArray(operation.changes)) throw new Error("invalid");
      const diary = operation.diaryId ? (await this.loadState(operation.diaryId)).value : null;
      const movable = (path: string) => this.isEntryPath(path) || this.isMigrationBackupPath(path) || (diary && this.isEnglishPath(path));
      const allowed = (path: string) => normalizeDiaryPath(path) === path && (
        movable(path) || this.isEntryStatePath(path) || path === this.deletedPath()
        || (diary && (path === diary.englishPath || path === this.statePath(diary.id)))
      );
      for (const change of operation.changes) {
        if (!allowed(change.path) || typeof change.after !== "string" || !(change.before === null || typeof change.before === "string")) throw new Error("invalid");
      }
      if (operation.move && (!allowed(operation.move.from) || !allowed(operation.move.to)
        || !movable(operation.move.from) || !movable(operation.move.to)
        || operation.move.from === operation.move.to || typeof operation.move.content !== "string")) throw new Error("invalid");
      return operation;
    } catch { return fail("INVALID_STATE", "表达保存恢复记录损坏，请保留文件后恢复。"); }
  }

  private async applyFileChange(change: FileChange): Promise<void> {
    const current = await this.files.read(change.path);
    if (current === change.after) return;
    if (current !== change.before) return modifiedDuringSave();
    await this.writeChecked(change.path, change.after, change.before);
  }

  private async finishOperation(operation: ExpressionOperation): Promise<void> {
    if (operation.move) {
      const { from, to, content } = operation.move;
      const original = await this.files.read(from), moved = await this.files.read(to);
      if (original === content && moved === null) await this.files.move(from, to, content);
      else if (original !== null || moved === null) return modifiedDuringSave();
    }
    for (const change of operation.changes) await this.applyFileChange(change);
  }

  private async rollbackOperation(operation: ExpressionOperation): Promise<boolean> {
    if (!await this.compensate(operation.changes)) return false;
    if (operation.move) {
      const { from, to, content } = operation.move;
      const original = await this.files.read(from), moved = await this.files.read(to);
      if (original === null && moved === content) {
        try { await this.files.move(to, from, content); } catch { return false; }
      } else if (!(original === content && moved === null)) return false;
    }
    return true;
  }

  private async recoverOperation(): Promise<void> {
    const path = this.operationPath();
    const raw = await this.files.read(path);
    if (raw === null) return;
    const operation = await this.readOperation(raw);
    if (operation.phase === "apply") await this.finishOperation(operation);
    else if (!await this.rollbackOperation(operation)) return fail("SAVE_FAILED", "表达保存尚未恢复，请保留冲突文件后重试。");
    await this.files.remove(path, raw);
  }

  /** One short-lived journal covers expression actions, including a category move. */
  private async applyChanges(changes: FileChange[], move?: ExpressionMove, diaryId?: string): Promise<void> {
    const operation: ExpressionOperation = { schema: 1, phase: "apply", changes, move, diaryId };
    const path = this.operationPath(), raw = serialize(operation);
    await this.writeChecked(path, raw, null);
    try {
      await this.finishOperation(operation);
    } catch (error) {
      const rollback: ExpressionOperation = { ...operation, phase: "rollback" };
      const rollbackRaw = serialize(rollback);
      try {
        // Persist rollback intent before compensation so a second interruption is recoverable.
        await this.writeChecked(path, rollbackRaw, raw);
        if (await this.rollbackOperation(rollback)) await this.files.remove(path, rollbackRaw);
      } catch { /* The durable journal remains for the next repository access. */ }
      throw error;
    }
    await this.files.remove(path, raw);
  }

  private deletedPath(): string { return `${this.options.stateDirectory}/removed-expressions.json`; }

  private async deletedOccurrences(): Promise<{ ids: Set<string>; raw: string | null }> {
    const raw = await this.files.read(this.deletedPath());
    if (raw === null) return { ids: new Set(), raw };
    try {
      const value = JSON.parse(raw) as { schema: number; ids: string[] };
      if (value.schema !== 1 || !Array.isArray(value.ids) || value.ids.some((id) => typeof id !== "string")) throw new Error("invalid");
      return { ids: new Set(value.ids), raw };
    } catch { return fail("INVALID_STATE", "表达删除记录损坏，已停止归档以免恢复已移除的内容。"); }
  }

  private entryId(term: string, meaning: string): string {
    return fingerprint(`${normalizedKey(term)}\u0000${normalizedKey(meaning)}`).slice(0, 24);
  }

  private entryPath(term: string, category: string, id: string): string {
    return `${this.options.expressionDirectory}/${filePart(category)}/${filePart(term)}-${id.slice(0, 8)}.md`;
  }

  private occurrenceId(result: DiaryResult, expressionId: string, entryId: string): string {
    return fingerprint(`${result.journalId}\u0000${result.sourceFingerprint}\u0000${entryId}\u0000${expressionId}`).slice(0, 24);
  }

  private async archiveChanges(result: DiaryResult, englishPath: string, updateExisting = false): Promise<FileChange[]> {
    const existing = await this.entryFiles();
    const entries = new Map<string, { entry: ExpressionEntry; file: EntryFile | null }>(
      existing.map((file) => [file.entry.id, { entry: clone(file.entry), file }])
    );
    const removed = (await this.deletedOccurrences()).ids;
    const changed = new Set<string>();
    for (const expression of result.expressions) {
      const id = this.entryId(expression.term, expression.meaning);
      const occurrenceId = this.occurrenceId(result, expression.id, id);
      if (removed.has(occurrenceId)) continue;
      let file = entries.get(id);
      if (!file) {
        const category = expression.category.trim() || "未分类";
        const path = this.entryPath(expression.term, category, id);
        if (await this.files.read(path) !== null) fail("CONFLICT", `目标表达文件已存在且不属于此词条：${path}`);
        file = { entry: {
          schema: 1, id, path, term: expression.term, type: expression.type,
          meaning: expression.meaning, category, userCategory: false, note: "", occurrences: []
        }, file: null };
        entries.set(id, file);
      }
      // Existing occurrence content may contain a user's correction. Replaying never replaces it.
      const previous = file.entry.occurrences.find((item) => item.id === occurrenceId);
      if (previous) {
        if (updateExisting) {
          previous.status = expression.status;
          previous.reason = expression.reason;
          changed.add(id);
        }
        continue;
      }
      const occurrence: ExpressionOccurrence = {
        id: occurrenceId, journalId: result.journalId, sourcePath: result.sourcePath,
        englishPath, sourceTitle: result.sourceTitle, date: result.date,
        sourceFingerprint: result.sourceFingerprint, scene: expression.scene,
        example: expression.example, reason: expression.reason, usage: expression.usage,
        sourceExcerpt: expression.sourceExcerpt, targetExcerpt: expression.targetExcerpt,
        status: expression.status
      };
      file.entry.occurrences.push(occurrence);
      changed.add(id);
    }
    const changes: FileChange[] = [];
    for (const id of changed) {
      const item = entries.get(id)!;
      changes.push(...await this.entryChanges(item.file, item.entry));
    }
    return changes;
  }

  private async transact(state: LoadedState, transaction: Transaction, options: PublishOptions): Promise<DiaryRecord> {
    const pendingKind = transaction.kind || state.value.pendingKind || "generation";
    const activity = generationEvents(state.value);
    const event = pendingKind === "generation" ? generationEvent(transaction.next.result) : null;
    if (event && !activity.some((item) => item.operationId === event.operationId)) activity.push(event);
    transaction = { ...transaction, next: { ...transaction.next, generationActivity: activity } };
    const value: StoredRecord = { ...state.value, pending: transaction.next.result, pendingKind, transaction };
    const journalRaw = serialize(value);
    await this.writeChecked(this.statePath(value.id), journalRaw, state.raw);
    const committed: StoredRecord = { ...transaction.next, pending: null, pendingKind: undefined, transaction: null };
    const committedRaw = serialize(committed);
    try {
      await this.guard(options);
      for (const change of transaction.changes) {
        await this.guard(options);
        await this.applyFileChange(change);
        await this.guard(options);
      }
      await this.guard(options);
      await this.writeChecked(this.statePath(value.id), committedRaw, journalRaw);
      const published = await this.describe(committed);
      await this.guard(options);
      return published;
    } catch (error) {
      const compensated = await this.compensate(transaction.changes);
      const retry: StoredRecord = { ...state.value, pending: transaction.next.result, pendingKind, transaction: compensated ? null : transaction };
      try {
        const current = await this.files.read(this.statePath(value.id));
        if (current === journalRaw || current === committedRaw) {
          await this.writeChecked(this.statePath(value.id), serialize(retry), current);
        }
      } catch {
        // The already persisted journal remains sufficient for the next recovery attempt.
      }
      if (error instanceof EnglishDiaryRepositoryError) throw error;
      return fail("SAVE_FAILED", "英文日记保存未完成，已有英文和生成结果已保留，可重试恢复。");
    }
  }

  async publish(record: DiaryRecord, result: DiaryResult, options: PublishOptions): Promise<DiaryRecord> {
    return this.exclusive(async () => {
      let state = await this.recover(await this.loadState(record.id));
      if (state.value.sourcePath !== normalizeDiaryPath(result.sourcePath) || result.journalId !== record.id) {
        return fail("CONFLICT", "原稿关联发生变化，请重新打开这篇日记。");
      }
      if (state.value.result?.operationId === result.operationId && !state.value.pending) return this.describe(state.value);
      if (state.value.result?.sourceFingerprint === result.sourceFingerprint && !state.value.pending) return this.describe(state.value);
      if (record.result?.operationId !== state.value.result?.operationId) fail("CONFLICT", "英文结果已变化，请重新打开后确认。");
      await this.guard(options);
      const earned = options.expressionPermit && this.expressionPermits.get(options.expressionPermit) === result.operationId;
      const pendingEarned = state.value.pending?.operationId === result.operationId && state.value.pendingExpressionsAuthorized === true;
      if (!earned && !pendingEarned) {
        requireProPlugin(this.access);
        if (result.expressions.length || result.alignments.length) this.access.requireCapability("diary.expression.write");
      }
      // Persist a model result before archive preparation; any subsequent failure can retry without a model.
      const pendingKind = state.value.pending?.operationId === result.operationId ? state.value.pendingKind : "generation" as const;
      const pending = { ...state.value, pending: clone(result), pendingKind, pendingExpressionsAuthorized: true };
      const pendingRaw = serialize(pending);
      await this.writeChecked(this.statePath(record.id), pendingRaw, state.raw);
      state = { value: pending, raw: pendingRaw };
      const english = await this.files.read(state.value.englishPath);
      const currentFingerprint = english === null ? null : fingerprint(english);
      if (!state.value.result && english !== null) return fail("CONFLICT", "目标英文文件已被其他内容占用，未覆盖该文件。");
      if (options.overwriteModified && (record.observedFileFingerprint === undefined || record.observedFileFingerprint !== currentFingerprint)) {
        return fail("CONFLICT", "确认之后英文文件又有变化，请重新查看并确认。");
      }
      if (english !== null && currentFingerprint !== state.value.savedFileFingerprint && !options.overwriteModified) {
        return fail("FILE_MODIFIED", "英文文件有手工修改，请明确确认替换后再更新。");
      }
      const changes = await this.archiveChanges(result, state.value.englishPath, state.value.pendingKind === "correction");
      const markdown = renderDiaryMarkdown(result);
      changes.push({ path: state.value.englishPath, before: english, after: markdown });
      return this.transact(state, {
        operationId: result.operationId,
        changes,
        next: { ...state.value, result: clone(result), savedFileFingerprint: fingerprint(markdown), pending: null }
      }, options);
    }, true);
  }

  async savePrivacy(record: DiaryRecord, privacy: DiaryPrivacy): Promise<void> {
    requireProPlugin(this.access);
    return this.exclusive(async () => {
      const state = await this.loadState(record.id);
      await this.writeChecked(this.statePath(record.id), serialize({ ...state.value, privacy: clone(privacy) }), state.raw);
    });
  }

  async restore(record: DiaryRecord): Promise<DiaryRecord> {
    return this.exclusive(async () => {
      const state = await this.recover(await this.loadState(record.id));
      if (!state.value.result) return fail("NOT_FOUND", "还没有可恢复的英文结果。");
      if (await this.files.read(state.value.englishPath) !== null) return this.describe(state.value);
      const markdown = renderDiaryMarkdown(state.value.result);
      await this.writeChecked(state.value.englishPath, markdown, null);
      const next = { ...state.value, savedFileFingerprint: fingerprint(markdown) };
      await this.writeChecked(this.statePath(record.id), serialize(next), state.raw);
      return this.describe(next);
    }, true);
  }

  async listGenerationActivity(): Promise<DiaryGenerationDay[]> {
    return this.exclusive(async () => {
      const days = new Map<string, DiaryGenerationDay>(), seen = new Set<string>();
      for (const loaded of await this.states()) {
        const state = await this.recover(loaded);
        const events = generationEvents(state.value);
        // Fix the local day once, including the single provable legacy event.
        if (state.value.generationActivity === undefined) {
          await this.writeChecked(this.statePath(state.value.id), serialize({ ...state.value, generationActivity: events }), state.raw);
        }
        for (const event of events) {
          if (seen.has(event.operationId)) continue;
          seen.add(event.operationId);
          const day = days.get(event.date) ?? { date: event.date, expressionCount: 0, generationCount: 0 };
          day.expressionCount += event.expressionCount;
          day.generationCount++;
          days.set(event.date, day);
        }
      }
      return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    });
  }

  async listExpressions(query = "", category?: string): Promise<ExpressionEntry[]> {
    return this.exclusive(async () => {
    const search = normalizedKey(query);
    return (await this.entryFiles()).map((file) => file.entry)
      .filter((entry) => (!category || entry.category === category)
        && (!search || normalizedKey([
          entry.term, entry.meaning, entry.category, entry.note,
          ...entry.occurrences.flatMap((item) => [item.date, item.sourcePath, item.sourceTitle, item.scene, item.reason])
        ].join("\n")).includes(search)))
      .sort((left, right) => left.term.localeCompare(right.term));
    });
  }

  async updateExpression(id: string, changes: { category: string; note: string }): Promise<ExpressionEntry> {
    return this.exclusive(async () => {
      this.access.requireCapability("diary.expression.write");
      const file = (await this.entryFiles()).find((item) => item.entry.id === id);
      if (!file) return fail("NOT_FOUND", "找不到这条表达。");
      const category = changes.category.trim() || "未分类";
      const path = category === file.entry.category
        ? file.entry.path : this.entryPath(file.entry.term, category, id);
      const next = { ...file.entry, path, category, userCategory: true, note: changes.note };
      const updates = await this.entryChanges(file, next);
      if (path !== file.entry.path && await this.files.read(path) !== null) return fail("CONFLICT", "目标分类已有同名文件，未移动或覆盖任何内容。");
      await this.applyChanges(updates, path === file.entry.path ? undefined : { from: file.entry.path, to: path, content: file.content });
      return next;
    }, true);
  }

  async removeOccurrence(entryId: string, occurrenceId: string): Promise<void> {
    return this.exclusive(async () => {
      this.access.requireCapability("diary.expression.write");
      const file = (await this.entryFiles()).find((item) => item.entry.id === entryId);
      if (!file || !file.entry.occurrences.some((item) => item.id === occurrenceId)) return;
      const removed = await this.deletedOccurrences();
      removed.ids.add(occurrenceId);
      const next = { ...file.entry, occurrences: file.entry.occurrences.filter((item) => item.id !== occurrenceId) };
      await this.applyChanges([
        { path: this.deletedPath(), before: removed.raw, after: serialize({ schema: 1, ids: [...removed.ids].sort() }) },
        ...await this.entryChanges(file, next)
      ]);
    }, true);
  }

  async markExpression(record: DiaryRecord, expressionId: string, status: "verified" | "needs-review", reason?: string): Promise<DiaryRecord> {
    return this.exclusive(async () => {
      this.access.requireCapability("diary.expression.write");
      const state = await this.recover(await this.loadState(record.id));
      if (!state.value.result) return fail("NOT_FOUND", "还没有可修改的英文表达。");
      if (record.result?.operationId !== state.value.result.operationId) return fail("CONFLICT", "本篇表达已变化，请重新打开后修改。");
      if (state.value.pending) return fail("CONFLICT", "请先恢复或完成待保存的英文，再修改说明。");
      const result = clone(state.value.result);
      const expression = result.expressions.find((item) => item.id === expressionId);
      if (!expression) return fail("NOT_FOUND", "找不到这条本篇表达。");
      expression.status = status;
      if (reason !== undefined) expression.reason = reason;
      if (expression.alignmentId) {
        const alignment = result.alignments.find((item) => item.id === expression.alignmentId);
        if (alignment) { alignment.status = status; if (reason !== undefined) alignment.reason = reason; }
      }
      const changes: FileChange[] = [];
      const entryId = this.entryId(expression.term, expression.meaning);
      const occurrenceId = this.occurrenceId(result, expression.id, entryId);
      const entryFile = (await this.entryFiles()).find((file) => file.entry.id === entryId);
      if (entryFile) {
        const occurrence = entryFile.entry.occurrences.find((item) => item.id === occurrenceId);
        if (occurrence) {
          occurrence.status = status;
          if (reason !== undefined) occurrence.reason = reason;
          changes.push(...await this.entryChanges(entryFile, entryFile.entry));
        }
      }
      const english = await this.files.read(state.value.englishPath);
      if (english !== null && fingerprint(english) !== state.value.savedFileFingerprint) {
        return fail("FILE_MODIFIED", "英文文件有手工修改。请先处理该修改，再同步更新说明。");
      }
      const markdown = renderDiaryMarkdown(result);
      changes.push({ path: state.value.englishPath, before: english, after: markdown });
      return this.transact(state, {
        operationId: `correction-${result.operationId}`,
        kind: "correction",
        changes,
        next: { ...state.value, result, savedFileFingerprint: fingerprint(markdown), pending: null }
      }, { sourceUnchanged: async () => true });
    }, true);
  }

  async renameSource(oldPath: string, newPath: string): Promise<void> {
    return this.exclusive(async () => {
      const oldSource = normalizeDiaryPath(oldPath);
      const newSource = normalizeDiaryPath(newPath);
      if (oldSource === newSource) return;
      const all = await this.states();
      const found = all.find((state) => state.value.sourcePath === oldSource);
      if (!found) return;
      if (all.some((state) => state.value.sourcePath === newSource)) return fail("CONFLICT", "新路径已关联另一篇英文日记。");
      const state = await this.recover(found);
      if (newSource === state.value.englishPath) return fail("INVALID_PATH", "原稿不能重命名为它的派生英文文件。");
      const title = newSource.split("/").at(-1)!.replace(/\.md$/i, "");
      const value = clone(state.value);
      value.sourcePath = newSource;
      if (value.result) { value.result.sourcePath = newSource; value.result.sourceTitle = title; }
      if (value.pending) { value.pending.sourcePath = newSource; value.pending.sourceTitle = title; }
      const changes: FileChange[] = [];
      for (const file of await this.entryFiles()) {
        let changed = false;
        for (const occurrence of file.entry.occurrences) {
          if (occurrence.journalId !== value.id) continue;
          occurrence.sourcePath = newSource;
          occurrence.sourceTitle = title;
          changed = true;
        }
        if (changed) changes.push(...await this.entryChanges(file, file.entry));
      }
      const english = await this.files.read(value.englishPath);
      if (english !== null && value.result) {
        const clean = fingerprint(english) === value.savedFileFingerprint;
        const next = clean ? renderDiaryMarkdown(value.result) : replaceDiaryLinks(english, oldSource, newSource)
          .replace(`\nsource: ${JSON.stringify(oldSource)}\n`, `\nsource: ${JSON.stringify(newSource)}\n`);
        if (next !== english) changes.push({ path: value.englishPath, before: english, after: next });
        if (clean) value.savedFileFingerprint = fingerprint(next);
      }
      // Rename preserves pending generation and uses expected writes; no source body is copied.
      changes.push({ path: this.statePath(value.id), before: state.raw, after: serialize(value) });
      await this.applyChanges(changes, undefined, value.id);
    }, true);
  }
}
