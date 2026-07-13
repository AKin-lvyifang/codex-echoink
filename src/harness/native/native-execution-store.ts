import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { NativeExecutionRecord } from "../contracts/native-execution";

interface NativeExecutionIndex {
  version: 1;
  updatedAt: number;
  records: NativeExecutionRecord[];
}

type NativeExecutionStoreEvent =
  | { type: "upsert"; record: NativeExecutionRecord; createdAt: number }
  | { type: "remove"; id: string; createdAt: number };

export interface NativeExecutionStoreOptions {
  rootPath: string;
  now?: () => number;
}

export class NativeExecutionStore {
  private readonly now: () => number;

  constructor(private readonly options: NativeExecutionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  async upsert(record: NativeExecutionRecord): Promise<void> {
    const index = await this.readIndex();
    const existingIndex = index.records.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) index.records[existingIndex] = record;
    else index.records.push(record);
    index.updatedAt = this.now();
    await this.appendEvent({ type: "upsert", record, createdAt: this.now() });
    await this.writeIndex(index);
  }

  async update(id: string, updater: (record: NativeExecutionRecord) => NativeExecutionRecord): Promise<NativeExecutionRecord | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next = updater({ ...current });
    await this.upsert(next);
    return next;
  }

  async get(id: string): Promise<NativeExecutionRecord | null> {
    const index = await this.readIndex();
    return index.records.find((record) => record.id === id) ?? null;
  }

  async list(): Promise<NativeExecutionRecord[]> {
    const index = await this.readIndex();
    return [...index.records].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  async listDueCleanup(now = this.now(), limit = 20): Promise<NativeExecutionRecord[]> {
    const records = await this.list();
    return records
      .filter((record) => (record.cleanup === "pending" || record.cleanup === "failed") && record.localCommit === "committed" && record.nextAttemptAt <= now)
      .slice(0, Math.max(0, limit));
  }

  async rebuildIndexFromEvents(): Promise<NativeExecutionRecord[]> {
    const text = await readFile(this.eventsPath(), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const records = new Map<string, NativeExecutionRecord>();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as NativeExecutionStoreEvent;
      if (event.type === "upsert") records.set(event.record.id, event.record);
      else if (event.type === "remove") records.delete(event.id);
    }
    const index: NativeExecutionIndex = {
      version: 1,
      updatedAt: this.now(),
      records: Array.from(records.values())
    };
    await this.writeIndex(index);
    return index.records;
  }

  private async readIndex(): Promise<NativeExecutionIndex> {
    const text = await readFile(this.indexPath(), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (!text.trim()) return { version: 1, updatedAt: 0, records: [] };
    const parsed = JSON.parse(text) as Partial<NativeExecutionIndex>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      records: Array.isArray(parsed.records) ? parsed.records.filter(isNativeExecutionRecord) : []
    };
  }

  private async writeIndex(index: NativeExecutionIndex): Promise<void> {
    const target = this.indexPath();
    await mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), `.native-executions-index.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async appendEvent(event: NativeExecutionStoreEvent): Promise<void> {
    const target = this.eventsPath();
    await mkdir(path.dirname(target), { recursive: true });
    const handle = await open(target, "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private indexPath(): string {
    return path.join(this.options.rootPath, "native-executions-index.json");
  }

  private eventsPath(): string {
    return path.join(this.options.rootPath, "native-executions.jsonl");
  }
}

function isNativeExecutionRecord(value: unknown): value is NativeExecutionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<NativeExecutionRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.runId === "string" &&
    typeof record.sessionId === "string" &&
    Boolean(record.native && typeof record.native === "object") &&
    Boolean(record.policy && typeof record.policy === "object") &&
    (record.localCommit === "pending" || record.localCommit === "committed" || record.localCommit === "failed")
  );
}
