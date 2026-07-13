import type { AgentAdapter } from "../agents/adapter";
import type { HarnessEventSource, HarnessEventType } from "../contracts/event";
import type {
  LocalRunCommitResult,
  NativeCleanupStatus,
  NativeDisposition,
  NativeExecutionRecord,
  NativeRunOutcome
} from "../contracts/native-execution";
import { NativeExecutionStore } from "./native-execution-store";

export interface NativeExecutionManagerOptions {
  store: NativeExecutionStore;
  adapters: AgentAdapter[];
  now?: () => number;
  emitRunEvent?: (event: {
    runId: string;
    source: HarnessEventSource;
    type: HarnessEventType;
    backendId?: string;
    error?: string;
    data?: Record<string, unknown>;
  }) => void | Promise<void>;
}

export interface SettleNativeExecutionInput {
  recordId: string;
  runOutcome: NativeRunOutcome;
  localCommit: LocalRunCommitResult;
}

export interface NativeCleanupResult {
  recordId: string;
  cleanup: NativeCleanupStatus;
  attempted: boolean;
  message?: string;
}

export interface NativePendingRecoveryFilter {
  surface?: string;
  sessionId?: string;
}

const CLEANUP_BACKOFF_MS = [
  0,
  60_000,
  5 * 60_000,
  30 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000
];

export class NativeExecutionManager {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly now: () => number;

  constructor(private readonly options: NativeExecutionManagerOptions) {
    for (const adapter of options.adapters) this.adapters.set(adapter.manifest.id, adapter);
    this.now = options.now ?? Date.now;
  }

  async recordCreated(record: NativeExecutionRecord): Promise<void> {
    await this.options.store.upsert(record);
  }

  async settleRun(input: SettleNativeExecutionInput): Promise<NativeExecutionRecord | null> {
    const settled = await this.options.store.update(input.recordId, (record) => {
      record.runOutcome = input.runOutcome;
      record.settledAt = this.now();
      if (!input.localCommit.committed) {
        record.localCommit = "failed";
        record.cleanup = "retained-for-recovery";
        record.lastError = input.localCommit.error ?? "Local durable commit failed";
        return record;
      }
      const requestedDisposition = chooseSupportedDisposition(record, this.adapters.get(record.native.backendId));
      record.localCommit = "committed";
      record.committedAt = this.now();
      record.requestedDisposition = cleanupNeeded(record) ? requestedDisposition : undefined;
      record.cleanup = cleanupNeeded(record) ? "pending" : "not-needed";
      record.nextAttemptAt = this.now();
      return record;
    });
    if (settled?.cleanup === "pending") {
      const error = await this.tryEmitRunEvent(settled, {
        type: "agent.native_cleanup.scheduled",
        disposition: settled.requestedDisposition ?? "retain"
      });
      if (error) return await this.noteEventFailure(settled, error);
    }
    return settled;
  }

  async cleanupDue(limit = 20): Promise<NativeCleanupResult[]> {
    const records = await this.options.store.listDueCleanup(this.now(), limit);
    const results: NativeCleanupResult[] = [];
    for (const record of records) {
      results.push(await this.cleanupRecord(record, record.emitEvents !== false));
    }
    return results;
  }

  async cleanupCommitted(record: NativeExecutionRecord): Promise<NativeCleanupResult> {
    const adapter = this.adapters.get(record.native.backendId);
    const requestedDisposition = chooseSupportedDisposition(record, adapter);
    const committed: NativeExecutionRecord = {
      ...record,
      localCommit: "committed",
      cleanup: "pending",
      requestedDisposition,
      committedAt: record.committedAt || this.now(),
      nextAttemptAt: this.now(),
      emitEvents: false
    };
    await this.options.store.upsert(committed);
    return await this.cleanupRecord(committed, false);
  }

  async listPendingLocalCommits(filter: NativePendingRecoveryFilter = {}): Promise<NativeExecutionRecord[]> {
    return (await this.options.store.list()).filter((record) => (
      record.localCommit === "pending" &&
      (!filter.surface || record.surface === filter.surface) &&
      (!filter.sessionId || record.sessionId === filter.sessionId)
    ));
  }

  async markPendingLocalCommitsFailed(reason: string, filter: NativePendingRecoveryFilter = {}): Promise<number> {
    const records = await this.listPendingLocalCommits(filter);
    let updated = 0;
    for (const record of records) {
      const changed = await this.options.store.update(record.id, (current) => ({
        ...current,
        runOutcome: current.runOutcome ?? "failed",
        localCommit: "failed",
        cleanup: "retained-for-recovery",
        settledAt: current.settledAt || this.now(),
        nextAttemptAt: 0,
        lastError: reason
      }));
      if (changed) updated += 1;
    }
    return updated;
  }

  private async cleanupRecord(record: NativeExecutionRecord, emitEvents = true): Promise<NativeCleanupResult> {
    const adapter = this.adapters.get(record.native.backendId);
    const requested = record.requestedDisposition ?? chooseSupportedDisposition(record, adapter);
    const startedError = emitEvents ? await this.tryEmitRunEvent(record, {
      type: "agent.native_cleanup.started",
      disposition: requested
    }) : "";
    if (startedError) {
      await this.markCleanupFailed(record, startedError);
      return { recordId: record.id, cleanup: "failed", attempted: false, message: startedError };
    }
    if (!adapter?.disposeNativeExecution) {
      await this.markCleanupTerminal(record, "unsupported", "Adapter does not support native execution cleanup");
      const unsupportedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
        type: "agent.native_cleanup.unsupported",
        disposition: requested,
        error: "Adapter does not support native execution cleanup"
      }) : "";
      if (unsupportedEventError) {
        await this.noteEventFailure(record, unsupportedEventError);
        return { recordId: record.id, cleanup: "unsupported", attempted: false, message: unsupportedEventError };
      }
      return { recordId: record.id, cleanup: "unsupported", attempted: false };
    }
    if (requested === "retain") {
      await this.markCleanupTerminal(record, "retained", "Policy requested retention");
      const retainedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
        type: "agent.native_cleanup.retained",
        disposition: requested
      }) : "";
      if (retainedEventError) {
        await this.noteEventFailure(record, retainedEventError);
        return { recordId: record.id, cleanup: "retained", attempted: false, message: retainedEventError };
      }
      return { recordId: record.id, cleanup: "retained", attempted: false };
    }
    try {
      await adapter.connect({
        runId: record.runId,
        sessionId: record.sessionId,
        workspace: { vaultPath: record.native.vaultId, cwd: record.native.vaultId }
      });
      const result = await adapter.disposeNativeExecution({
        ref: record.native,
        requested,
        reason: record.dispositionReason ?? cleanupReason(record.runOutcome)
      });
      if (result.outcome === "disposed" || result.outcome === "already-disposed") {
        await this.markDisposed(record, result.applied ?? requested);
        const completedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
          type: "agent.native_cleanup.completed",
          disposition: result.applied ?? requested
        }) : "";
        if (completedEventError) {
          await this.noteEventFailure(record, completedEventError);
          return { recordId: record.id, cleanup: "disposed", attempted: true, message: completedEventError };
        }
        return { recordId: record.id, cleanup: "disposed", attempted: true, message: result.message };
      }
      if (result.outcome === "unsupported") {
        await this.markCleanupTerminal(record, "unsupported", result.message ?? "Native cleanup unsupported");
        const unsupportedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
          type: "agent.native_cleanup.unsupported",
          disposition: requested,
          error: result.message ?? "Native cleanup unsupported"
        }) : "";
        if (unsupportedEventError) {
          await this.noteEventFailure(record, unsupportedEventError);
          return { recordId: record.id, cleanup: "unsupported", attempted: true, message: unsupportedEventError };
        }
        return { recordId: record.id, cleanup: "unsupported", attempted: true, message: result.message };
      }
      if (result.outcome === "retained") {
        await this.markCleanupTerminal(record, "retained", result.message ?? "Native execution retained");
        const retainedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
          type: "agent.native_cleanup.retained",
          disposition: requested,
          error: result.message ?? "Native execution retained"
        }) : "";
        if (retainedEventError) {
          await this.noteEventFailure(record, retainedEventError);
          return { recordId: record.id, cleanup: "retained", attempted: true, message: retainedEventError };
        }
        return { recordId: record.id, cleanup: "retained", attempted: true, message: result.message };
      }
      await this.markCleanupFailed(record, result.message ?? "Native cleanup failed");
      const failedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
        type: "agent.native_cleanup.failed",
        disposition: requested,
        error: result.message ?? "Native cleanup failed"
      }) : "";
      if (failedEventError) {
        await this.noteEventFailure(record, failedEventError);
        return { recordId: record.id, cleanup: "failed", attempted: true, message: failedEventError };
      }
      return { recordId: record.id, cleanup: "failed", attempted: true, message: result.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markCleanupFailed(record, message);
      const failedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
        type: "agent.native_cleanup.failed",
        disposition: requested,
        error: message
      }) : "";
      if (failedEventError) {
        await this.noteEventFailure(record, failedEventError);
        return { recordId: record.id, cleanup: "failed", attempted: true, message: failedEventError };
      }
      return { recordId: record.id, cleanup: "failed", attempted: true, message };
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  }

  private async tryEmitRunEvent(
    record: NativeExecutionRecord,
    input: {
      type: HarnessEventType;
      disposition: NativeDisposition;
      error?: string;
    }
  ): Promise<string> {
    try {
      await this.options.emitRunEvent?.({
        runId: record.runId,
        source: "agent",
        type: input.type,
        backendId: record.native.backendId,
        error: input.error,
        data: {
          recordId: record.id,
          disposition: input.disposition
        }
      });
      return "";
    } catch (eventError) {
      return eventError instanceof Error ? eventError.message : String(eventError);
    }
  }

  private async noteEventFailure(record: NativeExecutionRecord, message: string): Promise<NativeExecutionRecord | null> {
    return await this.options.store.update(record.id, (current) => ({
      ...current,
      lastError: mergeErrorMessage(current.lastError, message)
    }));
  }

  private async markDisposed(record: NativeExecutionRecord, applied: NativeDisposition): Promise<void> {
    await this.options.store.update(record.id, (current) => ({
      ...current,
      cleanup: "disposed",
      appliedDisposition: applied,
      disposedAt: this.now(),
      lastError: ""
    }));
  }

  private async markCleanupTerminal(record: NativeExecutionRecord, cleanup: "unsupported" | "retained", message: string): Promise<void> {
    await this.options.store.update(record.id, (current) => ({
      ...current,
      cleanup,
      lastError: message,
      disposedAt: this.now()
    }));
  }

  private async markCleanupFailed(record: NativeExecutionRecord, message: string): Promise<void> {
    await this.options.store.update(record.id, (current) => {
      const attempts = current.attempts + 1;
      return {
        ...current,
        cleanup: "failed",
        attempts,
        nextAttemptAt: this.now() + backoffForAttempt(attempts),
        lastError: message
      };
    });
  }
}

function cleanupNeeded(record: NativeExecutionRecord): boolean {
  return record.policy.historyAuthority === "echoink" && record.policy.mode !== "persistent-native";
}

function chooseSupportedDisposition(record: NativeExecutionRecord, adapter?: AgentAdapter): NativeDisposition {
  const capabilities = adapter?.manifest.nativeExecution?.dispositions;
  for (const disposition of record.policy.preferredDisposition) {
    if (disposition === "retain") return "retain";
    if (!capabilities) continue;
    if (disposition === "delete" && capabilities.delete) return "delete";
    if (disposition === "archive" && capabilities.archive) return "archive";
    if (disposition === "process-exit" && capabilities.processExit) return "process-exit";
  }
  return "retain";
}

function cleanupReason(outcome: NativeRunOutcome | undefined): "knowledge-run-completed" | "knowledge-run-failed" | "knowledge-run-cancelled" {
  if (outcome === "cancelled") return "knowledge-run-cancelled";
  if (outcome === "failed") return "knowledge-run-failed";
  return "knowledge-run-completed";
}

function backoffForAttempt(attempts: number): number {
  const index = Math.max(0, Math.min(attempts, CLEANUP_BACKOFF_MS.length - 1));
  return CLEANUP_BACKOFF_MS[index];
}

function mergeErrorMessage(current: string, next: string): string {
  if (!current) return next;
  if (!next || current.includes(next)) return current;
  return `${current}; ${next}`;
}
