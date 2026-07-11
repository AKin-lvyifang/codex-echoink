import type CodexForObsidianPlugin from "../main";
import { newId, type KnowledgeBaseManagedThreadKind } from "../settings/settings";
import { saveSettingsSafely } from "./maintenance";

export class KnowledgeBaseManagedThreadStore {
  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  remember(threadId: string, kind: KnowledgeBaseManagedThreadKind): string {
    const id = threadId.trim();
    const runId = newId("kb-codex-thread");
    if (!id) return runId;
    const now = Date.now();
    this.plugin.settings.knowledgeBase.managedThreads[id] = {
      threadId: id,
      runId,
      kind,
      vaultPath: this.plugin.getVaultPath(),
      archiveState: "running",
      createdAt: now,
      settledAt: 0,
      archivedAt: 0,
      attempts: 0,
      lastError: ""
    };
    return runId;
  }

  markPendingArchive(threadId: string, runId: string): void {
    const id = threadId.trim();
    if (!id) return;
    const existing = this.plugin.settings.knowledgeBase.managedThreads[id];
    if (!existing || existing.runId !== runId || existing.archiveState === "archived") return;
    existing.archiveState = "pending-archive";
    existing.settledAt = Date.now();
    existing.lastError = "";
  }

  async archivePending(options: { recoverStaleReason?: string } = {}): Promise<number> {
    const recovered = options.recoverStaleReason ? this.recoverStaleRunning(options.recoverStaleReason) : 0;
    const codex = this.plugin.codex;
    if (!codex?.archiveThread) {
      if (recovered) await saveSettingsSafely(this.plugin);
      return 0;
    }
    const managed = this.plugin.settings.knowledgeBase.managedThreads;
    const pending = Object.values(managed)
      .filter((thread) => thread.archiveState === "pending-archive" || thread.archiveState === "archive-failed")
      .sort((left, right) => (left.settledAt || left.createdAt) - (right.settledAt || right.createdAt));
    let archived = 0;
    for (const thread of pending) {
      try {
        thread.attempts += 1;
        await codex.archiveThread(thread.threadId);
        thread.archiveState = "archived";
        thread.archivedAt = Date.now();
        thread.lastError = "";
        archived += 1;
      } catch (error) {
        thread.archiveState = "archive-failed";
        thread.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (pending.length || recovered) await saveSettingsSafely(this.plugin);
    return archived;
  }

  recoverStaleRunning(reason: string): number {
    const managed = this.plugin.settings.knowledgeBase.managedThreads;
    const now = Date.now();
    let recovered = 0;
    for (const thread of Object.values(managed)) {
      if (thread.archiveState !== "running") continue;
      thread.archiveState = "pending-archive";
      thread.settledAt = thread.settledAt || now;
      thread.lastError = reason;
      recovered += 1;
    }
    return recovered;
  }
}
