import type { DataAdapter } from "obsidian";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { normalizeKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { replaceMobileFile } from "./replace-file";
import { digest, object, parentPath, safePath } from "./knowledge-folders-io";

export interface FolderConfiguration {
  bindings: KnowledgeFolderBindings | null;
  journal: string; review: string; english: string; expressions: string;
  englishMode?: "role" | "custom"; expressionMode?: "role" | "custom";
  legacyEnglish?: string[]; legacyExpressions?: string[]; pdfOriginal?: string; nativeJournal?: string;
}
export interface FolderPosition { original: string; current: string; hash: string; restored?: boolean }
export interface FolderAction {
  kind: "mkdir" | "move" | "settings"; from?: string; to?: string;
  state: "prepared" | "completed" | "uncertain";
}
export interface FolderTransaction {
  schema: 1; id: string; createdAt: number; kind: "initialize" | "names" | "restore";
  status: "completed" | "partial" | "uncertain";
  before: FolderConfiguration; after?: FolderConfiguration; positions: FolderPosition[];
  directories?: { original: string; current: string }[];
  actions: FolderAction[]; created: string[]; linkHashes: Record<string, string>;
  restoreOf?: string; restoredBy?: string;
}
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function configuration(value: unknown): FolderConfiguration {
  const input = object(value);
  if (input.bindings !== null && !normalizeKnowledgeFolderBindings(input.bindings)) throw new Error("目录事务绑定损坏。");
  for (const key of ["journal", "review", "english", "expressions"]) {
    if (typeof input[key] !== "string") throw new Error("目录事务设置损坏。");
    if (input[key]) safePath(input[key]);
  }
  for (const key of ["pdfOriginal", "nativeJournal"]) if (input[key] !== undefined) {
    if (typeof input[key] !== "string") throw new Error("目录事务设置损坏。");
    if (input[key]) safePath(input[key]);
  }
  for (const key of ["legacyEnglish", "legacyExpressions"]) if (input[key] !== undefined) {
    if (!Array.isArray(input[key]) || (input[key] as unknown[]).some(path => typeof path !== "string")) throw new Error("目录事务旧位置损坏。");
    for (const path of input[key] as string[]) safePath(path);
  }
  for (const key of ["englishMode", "expressionMode"]) if (input[key] !== undefined && input[key] !== "role" && input[key] !== "custom") throw new Error("目录事务模式损坏。");
  return input as unknown as FolderConfiguration;
}
function parse(raw: string, expectedId: string): FolderTransaction {
  const envelope = object(JSON.parse(raw) as unknown), value = object(envelope.payload);
  if (envelope.schema !== 1 || envelope.checksum !== digest(value) || value.schema !== 1 || value.id !== expectedId
    || !/^folders-[a-z0-9-]+$/u.test(expectedId) || !Number.isSafeInteger(value.createdAt)
    || !["initialize", "names", "restore"].includes(String(value.kind)) || !["completed", "partial", "uncertain"].includes(String(value.status))
    || !Array.isArray(value.positions) || !Array.isArray(value.actions) || !Array.isArray(value.created)) throw new Error("目录事务记录损坏，未执行或推测恢复。");
  configuration(value.before); if (value.after !== undefined) configuration(value.after);
  for (const rawPosition of value.positions as unknown[]) {
    const position = object(rawPosition);
    if (typeof position.original !== "string" || typeof position.current !== "string" || !validHash(position.hash)
      || position.restored !== undefined && typeof position.restored !== "boolean") throw new Error("目录事务文件记录损坏。");
    safePath(position.original); safePath(position.current);
  }
  if (value.directories !== undefined) {
    if (!Array.isArray(value.directories)) throw new Error("目录事务原目录记录损坏。");
    for (const rawDirectory of value.directories as unknown[]) {
      const directory = object(rawDirectory);
      if (typeof directory.original !== "string" || typeof directory.current !== "string") throw new Error("目录事务原目录记录损坏。");
      safePath(directory.original); safePath(directory.current);
    }
  }
  for (const rawAction of value.actions as unknown[]) {
    const action = object(rawAction);
    if (!["mkdir", "move", "settings"].includes(String(action.kind)) || !["prepared", "completed", "uncertain"].includes(String(action.state))) throw new Error("目录事务动作损坏。");
    if (action.kind !== "settings") { if (typeof action.to !== "string") throw new Error("目录事务动作缺少位置。"); safePath(action.to); }
    if (action.kind === "move") { if (typeof action.from !== "string") throw new Error("目录事务动作缺少来源。"); safePath(action.from); }
  }
  for (const path of value.created as unknown[]) { if (typeof path !== "string") throw new Error("目录事务目录损坏。"); safePath(path); }
  for (const [path, hash] of Object.entries(object(value.linkHashes))) { safePath(path); if (!validHash(hash)) throw new Error("目录事务链接版本损坏。"); }
  if (value.restoreOf !== undefined && typeof value.restoreOf !== "string" || value.restoredBy !== undefined && typeof value.restoredBy !== "string") throw new Error("目录事务恢复标记损坏。");
  return value as unknown as FolderTransaction;
}
/** Reads never recover/rename backups. Unknown intents remain visible after cold start. */
export class FolderJournal {
  private readonly expected = new Map<string, string | null>();
  constructor(private readonly adapter: DataAdapter, readonly directory: string) {}
  private path(id: string): string {
    if (!/^folders-[a-z0-9-]+$/u.test(id)) throw new Error("目录事务标识无效。");
    return `${this.directory}/${id}.json`;
  }
  async read(id: string): Promise<FolderTransaction> {
    const path = this.path(id), backup = `${path}.backup`;
    const raw = await this.adapter.exists(path) ? await this.adapter.read(path) : await this.adapter.exists(backup) ? await this.adapter.read(backup) : null;
    if (raw === null) throw new Error("目录事务不存在。");
    const record = parse(raw, id);
    if (!this.expected.has(id)) this.expected.set(id, await this.adapter.exists(path) ? raw : null);
    if (!await this.adapter.exists(path) || record.actions.some(action => action.state !== "completed")) record.status = "uncertain";
    return record;
  }
  async records(): Promise<FolderTransaction[]> {
    if (!await this.adapter.exists(this.directory)) return [];
    const files = await this.adapter.list(this.directory), ids = [...new Set(files.files.flatMap(path => {
      const match = /\/(folders-[a-z0-9-]+)\.json(?:\.backup)?$/u.exec(path); return match ? [match[1]] : [];
    }))];
    return Promise.all(ids.sort().map(id => this.read(id)));
  }
  async write(record: FolderTransaction): Promise<void> {
    const path = this.path(record.id), raw = JSON.stringify({ schema: 1, payload: record, checksum: digest(record) });
    parse(raw, record.id);
    const current = await this.adapter.exists(path) ? await this.adapter.read(path) : null;
    const expected = this.expected.get(record.id) ?? null;
    if (current !== expected) throw new Error("目录事务记录已变化，未覆盖。");
    let directory = "";
    for (const part of parentPath(path).split("/")) { directory = directory ? `${directory}/${part}` : part; if (!await this.adapter.exists(directory)) await this.adapter.mkdir(directory); }
    const backup = `${path}.backup`;
    if (await this.adapter.exists(backup)) throw new Error("目录事务有未处理的恢复备份，保留现状。");
    await replaceMobileFile(this.adapter, path, raw, expected, expected === null ? undefined : backup, () => new Error("目录事务记录已变化，未覆盖。"));
    if (await this.adapter.read(path) !== raw) throw new Error("目录事务回执保存未确认。");
    this.expected.set(record.id, raw);
    // Only this service's completed private replacement copy is disposable.
    if (await this.adapter.exists(backup)) await this.adapter.remove(backup);
  }
}
