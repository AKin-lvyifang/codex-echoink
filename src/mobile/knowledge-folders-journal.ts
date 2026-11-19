import type { DataAdapter } from "obsidian";
import { normalizeKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { replaceMobileFile } from "./replace-file";
import { digest, object, parentPath, safePath } from "./knowledge-folders-io";

import type { FolderConfiguration } from "./knowledge-folders-configuration";
import { folderConfigurationKeys, folderConfigurationLabels } from "./knowledge-folders-configuration";
import { assertKnowledgeModulePath } from "../knowledge-base/module-directories";

/** Internal journal checks: one user sentence; the detail only matters to the run report. */
const JOURNAL_INVALID = "目录操作记录无效，未执行或推测恢复。请重新预览后再确认。";
export type { FolderConfiguration } from "./knowledge-folders-configuration";

export interface FolderPosition { original: string; current: string; hash: string; restored?: boolean }
export interface FolderAction {
  kind: "mkdir" | "move" | "settings"; from?: string; to?: string;
  state: "prepared" | "completed" | "uncertain";
}
export interface FolderTransaction {
  schema: 1 | 2; id: string; createdAt: number; kind: "initialize" | "names" | "restore";
  status: "completed" | "partial" | "uncertain";
  before: FolderConfiguration; after?: FolderConfiguration; positions: FolderPosition[];
  directories?: { original: string; current: string }[];
  actions: FolderAction[]; created: string[]; linkHashes: Record<string, string>;
  restoreOf?: string; restoredBy?: string;
}
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export function validateFolderConfiguration(value: unknown, partial = false): FolderConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(JOURNAL_INVALID);
  const input = object(value);
  if (partial && Object.keys(input).some(key => !folderConfigurationKeys.includes(key as typeof folderConfigurationKeys[number]))) throw new Error(JOURNAL_INVALID);
  if ((!partial || Object.hasOwn(input, "bindings")) && input.bindings !== null && !normalizeKnowledgeFolderBindings(input.bindings)) throw new Error(JOURNAL_INVALID);
  const labels = folderConfigurationLabels;
  for (const key of ["journal", "review", "english", "expressions", "pdfOriginal", "nativeJournal"] as const) {
    if ((partial || key === "pdfOriginal" || key === "nativeJournal") && input[key] === undefined) continue;
    if (partial && input[key] === null && (key === "pdfOriginal" || key === "nativeJournal")) continue;
    if (typeof input[key] !== "string") throw new Error(JOURNAL_INVALID);
    if (partial) assertKnowledgeModulePath(input[key], labels[key], key === "journal" || key === "nativeJournal");
    else if (input[key]) safePath(input[key]);
  }
  for (const key of ["legacyEnglish", "legacyExpressions"] as const) if (input[key] !== undefined) {
    if (partial && input[key] === null) continue;
    const label = key === "legacyEnglish" ? "英文日记历史位置" : "表达库历史位置";
    if (!Array.isArray(input[key]) || (input[key] as unknown[]).some(path => typeof path !== "string")) throw new Error(JOURNAL_INVALID);
    for (const [index, path] of (input[key] as string[]).entries()) {
      if (partial) assertKnowledgeModulePath(path, `${label}（第 ${index + 1} 项）`); else safePath(path);
    }
  }
  for (const key of ["englishMode", "expressionMode"]) if (input[key] !== undefined && !(partial && input[key] === null) && input[key] !== "role" && input[key] !== "custom") throw new Error(JOURNAL_INVALID);
  return input;
}
function parse(raw: string, expectedId: string): FolderTransaction {
  const envelope = object(JSON.parse(raw) as unknown), value = object(envelope.payload);
  if (envelope.schema !== 1 || envelope.checksum !== digest(value) || (value.schema !== 1 && value.schema !== 2) || value.id !== expectedId
    || !/^folders-[a-z0-9-]+$/u.test(expectedId) || !Number.isSafeInteger(value.createdAt)
    || !["initialize", "names", "restore"].includes(String(value.kind)) || !["completed", "partial", "uncertain"].includes(String(value.status))
    || !Array.isArray(value.positions) || !Array.isArray(value.actions) || !Array.isArray(value.created)
    || value.schema === 2 && value.after === undefined) throw new Error(JOURNAL_INVALID);
  validateFolderConfiguration(value.before, value.schema === 2); if (value.after !== undefined) validateFolderConfiguration(value.after, value.schema === 2);
  for (const rawPosition of value.positions as unknown[]) {
    const position = object(rawPosition);
    if (typeof position.original !== "string" || typeof position.current !== "string" || !validHash(position.hash)
      || position.restored !== undefined && typeof position.restored !== "boolean") throw new Error(JOURNAL_INVALID);
    safePath(position.original); safePath(position.current);
  }
  if (value.directories !== undefined) {
    if (!Array.isArray(value.directories)) throw new Error(JOURNAL_INVALID);
    for (const rawDirectory of value.directories as unknown[]) {
      const directory = object(rawDirectory);
      if (typeof directory.original !== "string" || typeof directory.current !== "string") throw new Error(JOURNAL_INVALID);
      safePath(directory.original); safePath(directory.current);
    }
  }
  for (const rawAction of value.actions as unknown[]) {
    const action = object(rawAction);
    if (!["mkdir", "move", "settings"].includes(String(action.kind)) || !["prepared", "completed", "uncertain"].includes(String(action.state))) throw new Error(JOURNAL_INVALID);
    if (action.kind !== "settings") { if (typeof action.to !== "string") throw new Error(JOURNAL_INVALID); safePath(action.to); }
    if (action.kind === "move") { if (typeof action.from !== "string") throw new Error(JOURNAL_INVALID); safePath(action.from); }
  }
  for (const path of value.created as unknown[]) { if (typeof path !== "string") throw new Error(JOURNAL_INVALID); safePath(path); }
  for (const [path, hash] of Object.entries(object(value.linkHashes))) { safePath(path); if (!validHash(hash)) throw new Error(JOURNAL_INVALID); }
  if (value.restoreOf !== undefined && typeof value.restoreOf !== "string" || value.restoredBy !== undefined && typeof value.restoredBy !== "string") throw new Error(JOURNAL_INVALID);
  return value as unknown as FolderTransaction;
}
/** Reads never recover/rename backups. Unknown intents remain visible after cold start. */
export class FolderJournal {
  private readonly expected = new Map<string, string | null>();
  constructor(private readonly adapter: DataAdapter, readonly directory: string) {}
  private path(id: string): string {
    if (!/^folders-[a-z0-9-]+$/u.test(id)) throw new Error(JOURNAL_INVALID);
    return `${this.directory}/${id}.json`;
  }
  async read(id: string): Promise<FolderTransaction> {
    const path = this.path(id), backup = `${path}.backup`;
    const raw = await this.adapter.exists(path) ? await this.adapter.read(path) : await this.adapter.exists(backup) ? await this.adapter.read(backup) : null;
    if (raw === null) throw new Error(JOURNAL_INVALID);
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
    if (current !== expected) throw new Error("目录操作记录已变化，未覆盖。请重新读取记录后再操作。");
    let directory = "";
    for (const part of parentPath(path).split("/")) { directory = directory ? `${directory}/${part}` : part; if (!await this.adapter.exists(directory)) await this.adapter.mkdir(directory); }
    const backup = `${path}.backup`;
    if (await this.adapter.exists(backup)) throw new Error("目录操作有未处理的恢复备份，已保留现状。请重新读取记录后再操作。");
    await replaceMobileFile(this.adapter, path, raw, expected, expected === null ? undefined : backup, () => new Error("目录操作记录已变化，未覆盖。请重新读取记录后再操作。"));
    if (await this.adapter.read(path) !== raw) throw new Error(JOURNAL_INVALID);
    this.expected.set(record.id, raw);
    // Only this service's completed private replacement copy is disposable.
    if (await this.adapter.exists(backup)) await this.adapter.remove(backup);
  }
}
