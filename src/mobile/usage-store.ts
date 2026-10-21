import type { DataAdapter } from "obsidian";
import type { AccountStatistics } from "../settings/account-membership-model";
import { parseDocument, parseRequest, usageStatistics, type UsageDocument } from "../harness/usage/usage-core";
import { USAGE_TOKEN_STANDARD } from "../harness/usage/token-estimator";
import type { UsageRequestEvent } from "../harness/usage/usage-stream";
import { assertMobileTaskInstanceId } from "./task-identity";
import { readMobileFile, replaceMobileFile } from "./replace-file";

/** Only numeric request evidence; scoped exactly like local mobile tasks. */
export class MobileUsageStore {
  readonly path: string;
  private document: UsageDocument | null = null;
  private expected: string | null = null;
  private initialization?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly adapter: DataAdapter, directory: string, instanceId: string, private readonly now = Date.now) {
    assertMobileTaskInstanceId(instanceId);
    this.path = `${directory}/devices/${instanceId}/usage.json`;
  }
  initialize(): Promise<void> { return this.initialization ??= this.load().catch(error => { this.initialization = undefined; throw error; }); }
  private async load(): Promise<void> {
    const backup = `${this.path}.replace-backup`;
    if (!await this.adapter.exists(this.path) && await this.adapter.exists(backup)) await this.adapter.rename(backup, this.path);
    const content = await readMobileFile(this.adapter, this.path);
    if (content !== null) { this.document = parseDocument(JSON.parse(content)); this.expected = content; return; }
    const value: UsageDocument = { schemaVersion: 1, standard: USAGE_TOKEN_STANDARD, startedAt: this.now(), requests: [], completedTurns: [] };
    await this.persist(value); this.document = value;
  }
  recordUsage(event: UsageRequestEvent): Promise<void> {
    const safe = parseRequest(event);
    return this.mutate(doc => doc.requests.some(item => item.requestId === safe.requestId) ? null : { ...doc, requests: [...doc.requests, safe] });
  }
  recordCompletedTurn(runId: string, recordedAt: number): Promise<void> {
    if (typeof runId !== "string" || !runId || runId.length > 512 || !Number.isSafeInteger(recordedAt) || recordedAt < 0) return Promise.reject(new Error("Invalid completed turn evidence"));
    return this.mutate(doc => doc.completedTurns.some(item => item.runId === runId) ? null : { ...doc, completedTurns: [...doc.completedTurns, { runId, recordedAt }] });
  }
  private mutate(update: (document: UsageDocument) => UsageDocument | null): Promise<void> {
    const operation = this.writes.catch(() => {}).then(async () => {
      await this.initialize(); const next = update(this.document!); if (!next) return;
      await this.persist(next); this.document = next;
      for (const listener of this.listeners) { try { listener(); } catch { /* Views cannot undo evidence. */ } }
    }); this.writes = operation; return operation;
  }
  private async persist(value: UsageDocument): Promise<void> {
    let parent = "";
    for (const part of this.path.slice(0, this.path.lastIndexOf("/")).split("/")) { parent = parent ? `${parent}/${part}` : part; if (!await this.adapter.exists(parent)) await this.adapter.mkdir(parent); }
    const backup = `${this.path}.replace-backup`, content = JSON.stringify(value);
    const conflict = () => new Error("使用统计已变化，原记录已保留，请重新加载后重试。");
    if (await readMobileFile(this.adapter, this.path) !== this.expected) throw conflict();
    if (await this.adapter.exists(backup)) await this.adapter.remove(backup);
    await replaceMobileFile(this.adapter, this.path, content, this.expected, backup, conflict);
    this.expected = content;
    try { if (await this.adapter.exists(backup)) await this.adapter.remove(backup); } catch { /* The installed copy is authoritative. */ }
  }
  readStatistics(now = this.now()): AccountStatistics { return usageStatistics(this.document, now); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async flush(): Promise<void> { await this.writes; }
}
