import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountStatistics } from "../../settings/account-membership-model";
import { USAGE_TOKEN_STANDARD } from "./token-estimator";
import type { UsageRequestEvent } from "./usage-stream";
import { parseDocument, parseRequest, usageStatistics, type UsageDocument } from "./usage-core";
export type { UsageRequestEvent, UsageSource } from "./usage-stream";

/** Vault-local numeric evidence. Account changes never reset this store. */
export class UsageStore {
  private document: UsageDocument | null = null;
  private initialization: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly filePath: string, private readonly now = Date.now) {}

  initialize(): Promise<void> {
    return this.initialization ??= this.load();
  }

  private async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      this.document = parseDocument(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const value: UsageDocument = { schemaVersion: 1, standard: USAGE_TOKEN_STANDARD,
        startedAt: this.now(), requests: [], completedTurns: [] };
      await this.persist(value);
      this.document = value;
    }
  }

  recordUsage(event: UsageRequestEvent): Promise<void> {
    const safe = parseRequest(event);
    return this.mutate(document => {
      if (document.requests.some(request => request.requestId === safe.requestId)) return null;
      return { ...document, requests: [...document.requests, safe] };
    });
  }

  recordCompletedTurn(runId: string, recordedAt: number): Promise<void> {
    if (typeof runId !== "string" || !runId || runId.length > 512 || !Number.isSafeInteger(recordedAt) || recordedAt < 0) return Promise.reject(new Error("Invalid completed turn evidence"));
    return this.mutate(document => {
      if (document.completedTurns.some(turn => turn.runId === runId)) return null;
      return { ...document, completedTurns: [...document.completedTurns, { runId, recordedAt }] };
    });
  }

  private mutate(update: (document: UsageDocument) => UsageDocument | null): Promise<void> {
    const operation = this.writes.catch(() => {}).then(async () => {
      await this.initialize();
      const next = update(this.document!);
      if (!next) return;
      await this.persist(next);
      this.document = next;
      for (const listener of this.listeners) {
        try { listener(); } catch { /* A view cannot invalidate persisted usage. */ }
      }
    });
    this.writes = operation;
    return operation;
  }

  private async persist(document: UsageDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${globalThis.crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async flush(): Promise<void> { await this.writes; }

  readStatistics(now = this.now()): AccountStatistics {
    return usageStatistics(this.document, now);
  }
}
