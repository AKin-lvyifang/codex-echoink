import type { AgentAdapter } from "../agents/adapter";
import type { HarnessEventSource, HarnessEventType } from "../contracts/event";
import type {
  EchoInkHostProcessDispositionReceipt,
  LocalRunCommitResult,
  NativeCleanupStatus,
  NativeDisposition,
  NativeExecutionRecord,
  NativeRunOutcome
} from "../contracts/native-execution";
import {
  hasTrustedNativeExecutionIdentity,
  isNativeCleanupAuthorityEvidenceMissing,
  isValidEchoInkHostProcessDispositionReceipt,
  nativeCleanupAuthorityEvidenceMissingReason,
  nativeRetirementTargetState
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

export class NativeCleanupAdmissionClosedError extends Error {
  constructor(readonly quietWindowId: string) {
    super(
      `Native cleanup admission is closed by migration quiet window ${quietWindowId}`
    );
    this.name = "NativeCleanupAdmissionClosedError";
  }
}

export interface NativePendingRecoveryFilter {
  recordId?: string;
  surface?: string;
  sessionId?: string;
  workflow?: string;
}

const CLEANUP_BACKOFF_MS = [
  0,
  60_000,
  5 * 60_000,
  30 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000
];
const MAX_CLEANUP_ATTEMPTS = 6;
const INTERRUPTED_CLEANUP_REASON = "Native cleanup was interrupted before a terminal receipt";
export const ECHOINK_HOST_DISPOSITION_MISSING_REASON =
  "EchoInk host process disposition authority is missing";

interface NativeCleanupCoordinator {
  cleanupDueFlight: Promise<NativeCleanupResult[]> | null;
  cleanupRecovery: Promise<void> | null;
  cleanupQuietWindowId: string | null;
  readonly activeCleanupRecordIds: Set<string>;
  readonly recordCleanupFlights: Map<string, Promise<NativeCleanupResult>>;
  readonly nativeCleanupFlights: Map<string, NativeIdentityCleanupFlight>;
  readonly adapterCleanupTails: Map<string, Promise<void>>;
}

interface NativeIdentityCleanupFlight {
  readonly recordId: string;
  readonly requested: NativeDisposition;
  conflictMessage: string;
  promise: Promise<NativeCleanupResult>;
}

const cleanupCoordinatorsByRoot = new Map<string, NativeCleanupCoordinator>();

export class NativeExecutionManager {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly now: () => number;
  private readonly cleanupCoordinator: NativeCleanupCoordinator;

  constructor(private readonly options: NativeExecutionManagerOptions) {
    for (const adapter of options.adapters) this.adapters.set(adapter.manifest.id, adapter);
    this.now = options.now ?? Date.now;
    this.cleanupCoordinator = cleanupCoordinatorFor(options.store.coordinationKey());
  }

  async recordCreated(record: NativeExecutionRecord): Promise<void> {
    if (!isInitialNativeExecutionRegistration(record)) {
      throw new Error(`Native execution registration is not in its initial state: ${record.id}`);
    }
    const existing = await this.options.store.insertIfAbsent(record);
    if (!sameNativeExecutionRegistrationIdentity(existing, record)) {
      throw new Error(`Native execution registration id conflicts with an existing identity: ${record.id}`);
    }
    if (record.observedDisposition) {
      const observed = await this.recordObservedDisposition(
        record.id,
        record.observedDisposition
      );
      if (!observed) {
        throw new Error(
          `Native execution disappeared while recording host disposition: ${record.id}`
        );
      }
    }
  }

  /**
   * Persists host-observed process closure without settling the product run.
   * This may run while `localCommit=pending` and never invokes a provider
   * cleanup adapter.
   */
  async recordObservedDisposition(
    recordId: string,
    receipt: EchoInkHostProcessDispositionReceipt
  ): Promise<NativeExecutionRecord | null> {
    let conflictMessage = "";
    const updated = await this.options.store.update(recordId, (record) => {
      if (!isValidEchoInkHostProcessDispositionReceipt(record.native, receipt)) {
        conflictMessage = (
          `EchoInk host process disposition does not match Native identity: ${recordId}`
        );
        return record;
      }
      if (record.observedDisposition) {
        if (sameObservedDisposition(record.observedDisposition, receipt)) {
          return record;
        }
        conflictMessage = (
          `Conflicting EchoInk host process disposition for ${recordId}`
        );
        const {
          cleanupStartedAt: _cleanupStartedAt,
          ...rest
        } = record;
        return {
          ...rest,
          cleanup: "quarantined",
          nextAttemptAt: 0,
          quarantinedAt: record.quarantinedAt || this.now(),
          lastError: mergeErrorMessage(record.lastError, conflictMessage)
        };
      }
      return {
        ...record,
        observedDisposition: receipt
      };
    });
    if (conflictMessage) throw new Error(conflictMessage);
    return updated;
  }

  async settleRun(input: SettleNativeExecutionInput): Promise<NativeExecutionRecord | null> {
    let settlementApplied = false;
    let conflictMessage = "";
    const settled = await this.options.store.update(input.recordId, (record) => {
      if (record.localCommit !== "pending") {
        if (sameNativeSettlementReceipt(record, input)) return record;
        conflictMessage = nativeSettlementConflictMessage(record, input);
        if (canQuarantineNativeSettlementConflict(record)) {
          return {
            ...record,
            cleanup: "quarantined",
            nextAttemptAt: 0,
            quarantinedAt: record.quarantinedAt || this.now(),
            lastError: mergeErrorMessage(record.lastError, conflictMessage)
          };
        }
        return record;
      }
      if (!isPendingRunLocalCommit(record, {})) {
        conflictMessage = nativeSettlementConflictMessage(record, input);
        return record;
      }
      settlementApplied = true;
      record.runOutcome = input.runOutcome;
      record.settledAt = this.now();
      if (!input.localCommit.committed) {
        record.localCommit = "failed";
        record.cleanup = "retained-for-recovery";
        record.lastError = input.localCommit.error ?? "Local durable commit failed";
        return record;
      }
      if (record.native.identityAuthority === "echoink-host") {
        record.localCommit = "committed";
        record.committedAt = this.now();
        if (
          record.observedDisposition
          && isValidEchoInkHostProcessDispositionReceipt(
            record.native,
            record.observedDisposition
          )
        ) {
          const {
            cleanupStartedAt: _cleanupStartedAt,
            quarantinedAt: _quarantinedAt,
            ...rest
          } = record;
          return {
            ...rest,
            requestedDisposition: "process-exit",
            appliedDisposition: "process-exit",
            cleanup: "disposed",
            nextAttemptAt: 0,
            disposedAt: record.observedDisposition.observedAt
          };
        }
        record.cleanup = "quarantined";
        record.nextAttemptAt = 0;
        record.quarantinedAt = record.quarantinedAt || this.now();
        record.lastError = mergeErrorMessage(
          record.lastError,
          ECHOINK_HOST_DISPOSITION_MISSING_REASON
        );
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
    if (conflictMessage) throw new Error(conflictMessage);
    if (settlementApplied && settled?.cleanup === "pending") {
      const error = await this.tryEmitRunEvent(settled, {
        type: "agent.native_cleanup.scheduled",
        disposition: settled.requestedDisposition ?? "retain"
      });
      if (error) return await this.noteEventFailure(settled, error);
    }
    return settled;
  }

  async cleanupDue(limit = 20): Promise<NativeCleanupResult[]> {
    if (this.cleanupCoordinator.cleanupDueFlight) {
      return await this.cleanupCoordinator.cleanupDueFlight;
    }
    this.assertCleanupAdmissionOpen();
    const flight = this.performCleanupDue(limit);
    this.cleanupCoordinator.cleanupDueFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.cleanupCoordinator.cleanupDueFlight === flight) {
        this.cleanupCoordinator.cleanupDueFlight = null;
      }
    }
  }

  /**
   * Cleans one already-committed record without waiting behind the global due
   * queue. Terminal, awaiting, aborted, quarantined, or uncommitted records are
   * returned unchanged and never reach the adapter.
   */
  async cleanupById(recordId: string): Promise<NativeCleanupResult> {
    const existing =
      this.cleanupCoordinator.recordCleanupFlights.get(recordId);
    if (existing) return await existing;
    this.assertCleanupAdmissionOpen();
    return await this.runRecordCleanup(recordId, {
      ignoreSchedule: true
    });
  }

  async cleanupCommitted(record: NativeExecutionRecord): Promise<NativeCleanupResult> {
    const existing =
      this.cleanupCoordinator.recordCleanupFlights.get(record.id);
    if (existing) return await existing;
    this.assertCleanupAdmissionOpen();
    await this.requireDurableCommittedCleanupAuthority(record);
    return await this.runRecordCleanup(record.id, {
      ignoreSchedule: true,
      emitEvents: false,
      // Re-check inside the leader flight after cleanup-claim recovery. Every
      // caller is checked above before it may join an existing record flight;
      // the leader then proves the same Store authority immediately before
      // the claim. cleanupCommitted must never manufacture localCommit.
      prepare: async () =>
        await this.requireDurableCommittedCleanupAuthority(record)
    });
  }

  async withCleanupPaused<T>(
    quietWindowIdInput: string,
    action: () => Promise<T>
  ): Promise<T> {
    const quietWindowId = quietWindowIdInput.trim();
    if (!quietWindowId) {
      throw new Error("Native cleanup quiet window requires an id");
    }
    if (this.cleanupCoordinator.cleanupQuietWindowId) {
      throw new Error(
        `Native cleanup quiet window is already active: ${
          this.cleanupCoordinator.cleanupQuietWindowId
        }`
      );
    }
    this.cleanupCoordinator.cleanupQuietWindowId = quietWindowId;
    try {
      await this.waitForCleanupIdle();
      return await action();
    } finally {
      if (
        this.cleanupCoordinator.cleanupQuietWindowId
        === quietWindowId
      ) {
        this.cleanupCoordinator.cleanupQuietWindowId = null;
      }
    }
  }

  async withStoreMutation<T>(action: () => Promise<T>): Promise<T> {
    return await this.options.store.withMutation(action);
  }

  private async requireDurableCommittedCleanupAuthority(
    record: NativeExecutionRecord
  ): Promise<void> {
    const authorityError =
      `Native cleanup requires durable committed authority in the Native Execution Store: ${record.id}`;
    if (record.localCommit !== "committed") {
      throw new Error(authorityError);
    }
    const existing = await this.options.store.get(record.id);
    if (!existing) {
      throw new Error(authorityError);
    }
    if (existing.localCommit !== "committed") {
      throw new Error(authorityError);
    }
    if (!sameCleanupAuthorityIdentity(existing, record)) {
      throw new Error(
        `Native cleanup record id conflicts with an existing identity: ${record.id}`
      );
    }
  }

  async listPendingLocalCommits(filter: NativePendingRecoveryFilter = {}): Promise<NativeExecutionRecord[]> {
    return (await this.options.store.list()).filter((record) =>
      isPendingRunLocalCommit(record, filter)
    );
  }

  async snapshotPendingLocalCommits(
    filter: NativePendingRecoveryFilter = {}
  ): Promise<NativeExecutionRecord[]> {
    return await this.withStoreMutation(
      async () => await this.listPendingLocalCommits(filter)
    );
  }

  async listAwaitingLocalCommitRetirements(): Promise<NativeExecutionRecord[]> {
    // Preserve authority gaps before generic recovery mutates exhausted
    // pending/failed/disposing records into terminal quarantine. They must
    // still reject this startup pass before unrelated provider cleanup runs.
    const authorityGapIds = new Set(
      (await this.options.store.list())
        .filter(isNativeCleanupAuthorityEvidenceMissing)
        .map((record) => record.id)
    );
    // A crash may leave a promoted retirement in `disposing`. Recover that
    // claim before the startup authority scan so it becomes `failed` (or
    // exhausted/quarantined) and cannot bypass Conversation proof inside the
    // later cleanupDue() recovery pass.
    await this.ensureCleanupRecovery();
    return (await this.options.store.list()).filter((record) => (
      (
        Boolean(record.retirement)
        && (
          record.cleanup === "awaiting-local-commit"
          || record.cleanup === "pending"
          || record.cleanup === "failed"
        )
      )
      || isNativeCleanupAuthorityEvidenceMissing(record)
      || (
        authorityGapIds.has(record.id)
        && isQuarantinedMissingCleanupAuthorityEvidence(record)
      )
    ));
  }

  async registerRetirement(record: NativeExecutionRecord): Promise<NativeExecutionRecord> {
    if (
      !record.retirement
      || record.localCommit !== "pending"
      || record.cleanup !== "awaiting-local-commit"
    ) {
      throw new Error("Native binding retirement registration requires pending/awaiting-local-commit state");
    }
    const existing = await this.options.store.insertIfAbsent(record);
    if (!sameRetirementIdentity(existing, record)) {
      throw new Error(`Native binding retirement id conflicts with an existing record: ${record.id}`);
    }
    return existing;
  }

  async promoteRetirement(
    recordId: string,
    expected?: NativeExecutionRecord
  ): Promise<NativeExecutionRecord | null> {
    return await this.transitionRetirement(recordId, "promote", "", expected);
  }

  async abortRetirement(
    recordId: string,
    reason: string,
    expected?: NativeExecutionRecord
  ): Promise<NativeExecutionRecord | null> {
    return await this.transitionRetirement(recordId, "abort", reason, expected);
  }

  async quarantineRetirement(
    recordId: string,
    reason: string,
    expected?: NativeExecutionRecord
  ): Promise<NativeExecutionRecord | null> {
    return await this.transitionRetirement(recordId, "quarantine", reason, expected);
  }

  async markPendingLocalCommitsFailed(reason: string, filter: NativePendingRecoveryFilter = {}): Promise<number> {
    const records = await this.listPendingLocalCommits(filter);
    let updated = 0;
    for (const record of records) {
      let transitioned = false;
      const changed = await this.options.store.update(record.id, (current) => {
        // The surface may finish its durable commit after the startup scan but
        // before this serialized Store mutation. Re-check the authoritative
        // record under the Store mutation lane so recovery never overwrites a
        // concurrent committed settlement.
        if (!isPendingRunLocalCommit(current, filter)) return current;
        transitioned = true;
        return {
          ...current,
          runOutcome: current.runOutcome ?? "failed",
          localCommit: "failed",
          cleanup: "retained-for-recovery",
          settledAt: current.settledAt || this.now(),
          nextAttemptAt: 0,
          lastError: mergeErrorMessage(current.lastError, reason)
        };
      });
      if (changed && transitioned) updated += 1;
    }
    return updated;
  }

  private async performCleanupDue(limit: number): Promise<NativeCleanupResult[]> {
    await this.ensureCleanupRecovery();
    const records = await this.options.store.listDueCleanup(this.now(), limit);
    const results: NativeCleanupResult[] = [];
    for (const record of records) {
      results.push(await this.runRecordCleanup(record.id, {
        ignoreSchedule: false,
        emitEvents: record.emitEvents !== false
      }));
    }
    return results;
  }

  private async runRecordCleanup(
    recordId: string,
    options: {
      ignoreSchedule: boolean;
      emitEvents?: boolean;
      prepare?: () => Promise<void>;
    }
  ): Promise<NativeCleanupResult> {
    const existing = this.cleanupCoordinator.recordCleanupFlights.get(recordId);
    if (existing) return await existing;
    const flight = (async () => {
      await this.ensureCleanupRecovery();
      await options.prepare?.();
      const authorityFailure =
        await this.quarantineMissingCleanupAuthority(recordId);
      if (authorityFailure) return authorityFailure;
      this.cleanupCoordinator.activeCleanupRecordIds.add(recordId);
      try {
        const claimed = await this.options.store.claimCleanup(
          recordId,
          this.now(),
          { ignoreSchedule: options.ignoreSchedule }
        );
        if (!claimed) {
          const current = await this.options.store.get(recordId);
          return {
            recordId,
            cleanup: current?.cleanup ?? "not-needed",
            attempted: false,
            ...(current?.lastError ? { message: current.lastError } : {})
          };
        }
        try {
          return await this.cleanupRecord(
            claimed,
            options.emitEvents ?? claimed.emitEvents !== false
          );
        } catch (error) {
          const recoveryError = await this.releaseUnexpectedCleanupClaim(
            claimed,
            error
          );
          if (recoveryError) {
            throw new Error(
              `${errorMessage(error)}; Native cleanup claim recovery failed: ${recoveryError}`
            );
          }
          throw error;
        }
      } finally {
        this.cleanupCoordinator.activeCleanupRecordIds.delete(recordId);
      }
    })();
    this.cleanupCoordinator.recordCleanupFlights.set(recordId, flight);
    try {
      return await flight;
    } finally {
      if (this.cleanupCoordinator.recordCleanupFlights.get(recordId) === flight) {
        this.cleanupCoordinator.recordCleanupFlights.delete(recordId);
      }
    }
  }

  private async ensureCleanupRecovery(): Promise<void> {
    if (!this.cleanupCoordinator.cleanupRecovery) {
      this.cleanupCoordinator.cleanupRecovery = (async () => {
        await this.options.store.requeueInterruptedCleanupClaims(
          INTERRUPTED_CLEANUP_REASON,
          this.now(),
          this.cleanupCoordinator.activeCleanupRecordIds
        );
        await this.options.store.quarantineExhaustedCleanupAttempts(
          "Native cleanup retry limit was already exhausted",
          this.now()
        );
      })();
    }
    const recovery = this.cleanupCoordinator.cleanupRecovery;
    try {
      await recovery;
    } finally {
      if (this.cleanupCoordinator.cleanupRecovery === recovery) {
        this.cleanupCoordinator.cleanupRecovery = null;
      }
    }
  }

  private assertCleanupAdmissionOpen(): void {
    const quietWindowId =
      this.cleanupCoordinator.cleanupQuietWindowId;
    if (quietWindowId) {
      throw new NativeCleanupAdmissionClosedError(quietWindowId);
    }
  }

  private async waitForCleanupIdle(): Promise<void> {
    while (true) {
      const flights = new Set<Promise<unknown>>();
      if (this.cleanupCoordinator.cleanupDueFlight) {
        flights.add(this.cleanupCoordinator.cleanupDueFlight);
      }
      if (this.cleanupCoordinator.cleanupRecovery) {
        flights.add(this.cleanupCoordinator.cleanupRecovery);
      }
      for (
        const flight of
        this.cleanupCoordinator.recordCleanupFlights.values()
      ) {
        flights.add(flight);
      }
      for (
        const flight of
        this.cleanupCoordinator.nativeCleanupFlights.values()
      ) {
        flights.add(flight.promise);
      }
      for (
        const tail of
        this.cleanupCoordinator.adapterCleanupTails.values()
      ) {
        flights.add(tail);
      }
      if (flights.size === 0) return;
      await Promise.allSettled(flights);
    }
  }

  private async releaseUnexpectedCleanupClaim(
    claimed: NativeExecutionRecord,
    error: unknown
  ): Promise<string> {
    const reason = mergeErrorMessage(
      INTERRUPTED_CLEANUP_REASON,
      errorMessage(error)
    );
    try {
      await this.options.store.update(claimed.id, (current) => {
        if (
          current.cleanup !== "disposing"
          || current.attempts !== claimed.attempts
          || current.cleanupStartedAt !== claimed.cleanupStartedAt
        ) {
          return current;
        }
        const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
        const exhausted = current.attempts >= MAX_CLEANUP_ATTEMPTS;
        return {
          ...rest,
          cleanup: exhausted ? "quarantined" : "failed",
          nextAttemptAt: exhausted ? 0 : this.now(),
          ...(exhausted
            ? { quarantinedAt: current.quarantinedAt || this.now() }
            : {}),
          lastError: mergeErrorMessage(current.lastError, reason)
        };
      });
      return "";
    } catch (recoveryError) {
      return errorMessage(recoveryError);
    }
  }

  private async quarantineMissingCleanupAuthority(
    recordId: string
  ): Promise<NativeCleanupResult | null> {
    let authorityMissing = false;
    let reason = "";
    const quarantined = await this.options.store.update(recordId, (record) => {
      if (!isNativeCleanupAuthorityEvidenceMissing(record)) return record;
      authorityMissing = true;
      reason = nativeCleanupAuthorityEvidenceMissingReason(record.id);
      const { cleanupStartedAt: _cleanupStartedAt, ...rest } = record;
      return {
        ...rest,
        cleanup: "quarantined",
        nextAttemptAt: 0,
        quarantinedAt: record.quarantinedAt || this.now(),
        lastError: mergeErrorMessage(record.lastError, reason)
      };
    });
    if (!authorityMissing) return null;
    return {
      recordId,
      cleanup: quarantined?.cleanup ?? "quarantined",
      attempted: false,
      message: reason
    };
  }

  private async transitionRetirement(
    recordId: string,
    transition: "promote" | "abort" | "quarantine",
    reason = "",
    expected?: NativeExecutionRecord
  ): Promise<NativeExecutionRecord | null> {
    const normalizedReason = reason.trim();
    if (transition !== "promote" && !normalizedReason) {
      throw new Error(`Native retirement ${transition} requires a reason`);
    }
    return await this.options.store.update(recordId, (record) => {
      if (expected && !sameCleanupAuthorityIdentity(record, expected)) {
        throw new Error(`Native binding retirement identity conflicts with existing record: ${recordId}`);
      }
      const missingAuthorityEvidence =
        isNativeCleanupAuthorityEvidenceMissing(record);
      const quarantinedMissingAuthorityEvidence =
        isQuarantinedMissingCleanupAuthorityEvidence(record);
      if (
        !record.retirement
        && !(
          transition === "quarantine"
          && (
            missingAuthorityEvidence
            || quarantinedMissingAuthorityEvidence
          )
        )
      ) {
        throw new Error(`Native execution ${recordId} is not a binding retirement`);
      }
      if (transition === "promote") {
        if (record.localCommit === "committed" && record.cleanup !== "awaiting-local-commit") {
          return record;
        }
        if (record.cleanup !== "awaiting-local-commit" || record.localCommit !== "pending") {
          throw new Error(`Native retirement ${recordId} cannot be promoted from ${record.localCommit}/${record.cleanup}`);
        }
        return {
          ...record,
          localCommit: "committed",
          cleanup: "pending",
          // Per-run leased records are retained after their durable commit. A
          // binding retirement is the explicit point at which that lease is
          // allowed to schedule a provider disposition.
          requestedDisposition: chooseSupportedDisposition(
            record,
            this.adapters.get(record.native.backendId)
          ),
          committedAt: record.committedAt || this.now(),
          nextAttemptAt: this.now()
        };
      }
      if (transition === "abort") {
        if (record.cleanup === "aborted") return record;
        if (record.cleanup !== "awaiting-local-commit" || record.localCommit !== "pending") {
          throw new Error(`Native retirement ${recordId} cannot be aborted from ${record.localCommit}/${record.cleanup}`);
        }
        return {
          ...record,
          localCommit: "failed",
          cleanup: "aborted",
          settledAt: record.settledAt || this.now(),
          nextAttemptAt: 0,
          lastError: mergeErrorMessage(record.lastError, normalizedReason)
        };
      }
      if (record.cleanup === "quarantined") return record;
      if (record.cleanup !== "awaiting-local-commit" && record.cleanup !== "pending" && record.cleanup !== "failed") {
        throw new Error(`Native retirement ${recordId} cannot be quarantined from ${record.localCommit}/${record.cleanup}`);
      }
      return {
        ...record,
        cleanup: "quarantined",
        nextAttemptAt: 0,
        quarantinedAt: record.quarantinedAt || this.now(),
        lastError: mergeErrorMessage(record.lastError, normalizedReason)
      };
    });
  }

  private async cleanupRecord(record: NativeExecutionRecord, emitEvents = true): Promise<NativeCleanupResult> {
    const adapter = this.adapters.get(record.native.backendId);
    const requested = hasTrustedNativeExecutionIdentity(record.native)
      ? record.requestedDisposition ?? chooseSupportedDisposition(record, adapter)
      : "retain";
    return await this.withNativeIdentityCleanup(record, requested, emitEvents);
  }

  private async withNativeIdentityCleanup(
    record: NativeExecutionRecord,
    requested: NativeDisposition,
    emitEvents: boolean
  ): Promise<NativeCleanupResult> {
    const identityKey = nativeExecutionCleanupIdentityKey(record.native);
    const existing = this.cleanupCoordinator.nativeCleanupFlights.get(identityKey);
    if (existing) {
      if (existing.requested !== requested) {
        const conflict = nativeDispositionConflictMessage(
          record.native,
          [existing.requested, requested]
        );
        existing.conflictMessage = mergeErrorMessage(existing.conflictMessage, conflict);
        await existing.promise.catch(() => undefined);
        return await this.quarantineNativeIdentityConflict(record, conflict);
      }
      const leaderResult = await existing.promise;
      return await this.mirrorNativeCleanupReceipt(record, existing.recordId, leaderResult);
    }

    const flight: NativeIdentityCleanupFlight = {
      recordId: record.id,
      requested,
      conflictMessage: "",
      promise: Promise.resolve({
        recordId: record.id,
        cleanup: record.cleanup,
        attempted: false
      })
    };
    this.cleanupCoordinator.nativeCleanupFlights.set(identityKey, flight);
    const run = (async () => {
      const group = (await this.options.store.list()).filter((candidate) => (
        nativeExecutionCleanupIdentityKey(candidate.native) === identityKey
      ));
      const missingAuthority = group.filter(
        isNativeCleanupAuthorityEvidenceMissing
      );
      if (missingAuthority.length) {
        const reason = missingAuthority
          .map((candidate) =>
            nativeCleanupAuthorityEvidenceMissingReason(candidate.id)
          )
          .join("; ");
        return await this.quarantineNativeIdentityConflict(record, reason);
      }
      const dispositions = new Set<NativeDisposition>([requested]);
      for (const candidate of group) {
        if (!participatesInNativeDisposition(candidate)) continue;
        const adapter = this.adapters.get(candidate.native.backendId);
        dispositions.add(
          hasTrustedNativeExecutionIdentity(candidate.native)
            ? candidate.requestedDisposition ?? chooseSupportedDisposition(candidate, adapter)
            : "retain"
        );
      }
      if (dispositions.size > 1) {
        const conflict = nativeDispositionConflictMessage(
          record.native,
          Array.from(dispositions)
        );
        flight.conflictMessage = mergeErrorMessage(flight.conflictMessage, conflict);
      }
      if (flight.conflictMessage) {
        return await this.quarantineNativeIdentityConflict(record, flight.conflictMessage);
      }

      const receipt = selectNativeIdentityCleanupReceipt(group, record.id, this.now());
      if (receipt) {
        return await this.mirrorNativeCleanupReceipt(record, receipt.id, {
          recordId: receipt.id,
          cleanup: receipt.cleanup,
          attempted: false,
          ...(receipt.lastError ? { message: receipt.lastError } : {})
        });
      }
      return await this.cleanupRecordAsIdentityLeader(record, requested, emitEvents, flight);
    })();
    flight.promise = run;
    try {
      return await run;
    } finally {
      if (this.cleanupCoordinator.nativeCleanupFlights.get(identityKey) === flight) {
        this.cleanupCoordinator.nativeCleanupFlights.delete(identityKey);
      }
    }
  }

  private async mirrorNativeCleanupReceipt(
    target: NativeExecutionRecord,
    sourceRecordId: string,
    sourceResult: NativeCleanupResult
  ): Promise<NativeCleanupResult> {
    const source = await this.options.store.get(sourceRecordId);
    if (!source || source.id === target.id) return sourceResult;
    if (!isNativeCleanupReceipt(source, this.now())) {
      const deferred = await this.markCleanupDeferred(
        target,
        sourceResult.message ?? "Native cleanup is already coordinated by another record",
        source.nextAttemptAt
      );
      return {
        recordId: target.id,
        cleanup: deferred?.cleanup ?? "failed",
        attempted: false,
        ...(sourceResult.message ? { message: sourceResult.message } : {})
      };
    }
    const mirrored = await this.options.store.update(target.id, (current) => {
      const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
      const attempts = current.cleanup === "disposing"
        ? Math.max(0, current.attempts - 1)
        : current.attempts;
      if (source.cleanup === "failed") {
        return {
          ...rest,
          cleanup: "failed",
          attempts,
          nextAttemptAt: source.nextAttemptAt,
          lastError: mergeErrorMessage(current.lastError, source.lastError)
        };
      }
      if (source.cleanup === "quarantined") {
        return {
          ...rest,
          cleanup: "quarantined",
          attempts,
          nextAttemptAt: 0,
          quarantinedAt: source.quarantinedAt || this.now(),
          lastError: mergeErrorMessage(current.lastError, source.lastError)
        };
      }
      return {
        ...rest,
        cleanup: source.cleanup,
        attempts,
        nextAttemptAt: 0,
        ...(source.appliedDisposition
          ? { appliedDisposition: source.appliedDisposition }
          : {}),
        disposedAt: source.disposedAt,
        lastError: mergeErrorMessage(current.lastError, source.lastError)
      };
    });
    return {
      recordId: target.id,
      cleanup: mirrored?.cleanup ?? source.cleanup,
      attempted: false,
      ...(sourceResult.message || source.lastError
        ? { message: sourceResult.message || source.lastError }
        : {})
    };
  }

  private async quarantineNativeIdentityConflict(
    record: NativeExecutionRecord,
    message: string,
    auditWarnings: string[] = [],
    providerAttemptedRecordId = ""
  ): Promise<NativeCleanupResult> {
    const identityKey = nativeExecutionCleanupIdentityKey(record.native);
    const group = (await this.options.store.list()).filter((candidate) => (
      nativeExecutionCleanupIdentityKey(candidate.native) === identityKey
      && participatesInNativeConflictQuarantine(candidate)
    ));
    for (const candidate of group) {
      await this.options.store.update(candidate.id, (current) => {
        if (!participatesInNativeConflictQuarantine(current)) {
          return current;
        }
        const {
          cleanupStartedAt: _cleanupStartedAt,
          appliedDisposition: _appliedDisposition,
          ...rest
        } = current;
        return {
          ...rest,
          cleanup: "quarantined",
          attempts: (
            current.cleanup === "disposing"
            && current.id !== providerAttemptedRecordId
          )
            ? Math.max(0, current.attempts - 1)
            : current.attempts,
          nextAttemptAt: 0,
          disposedAt: 0,
          quarantinedAt: current.quarantinedAt || this.now(),
          lastError: mergeErrorMessage(current.lastError, message)
        };
      });
    }
    return await this.finishCleanupResult({
      recordId: record.id,
      cleanup: "quarantined",
      attempted: record.id === providerAttemptedRecordId,
      message
    }, auditWarnings);
  }

  private async quarantineLateNativeIdentityConflict(
    record: NativeExecutionRecord,
    flight: NativeIdentityCleanupFlight,
    auditWarnings: string[],
    providerReceipt: string
  ): Promise<NativeCleanupResult> {
    const message = mergeErrorMessage(
      flight.conflictMessage,
      `Native provider disposition had already started before the conflict was observed; ${providerReceipt}; cleanup outcome is quarantined`
    );
    flight.conflictMessage = message;
    return await this.quarantineNativeIdentityConflict(
      record,
      message,
      auditWarnings,
      record.id
    );
  }

  private async cleanupRecordAsIdentityLeader(
    record: NativeExecutionRecord,
    requested: NativeDisposition,
    emitEvents: boolean,
    flight: NativeIdentityCleanupFlight
  ): Promise<NativeCleanupResult> {
    const adapter = this.adapters.get(record.native.backendId);
    const auditWarnings: string[] = [];
    const startedError = emitEvents ? await this.tryEmitRunEvent(record, {
      type: "agent.native_cleanup.started",
      disposition: requested
    }) : "";
    if (startedError) auditWarnings.push(startedError);
    if (flight.conflictMessage) {
      return await this.quarantineNativeIdentityConflict(
        record,
        flight.conflictMessage,
        auditWarnings
      );
    }
    if (requested === "retain") {
      await this.markCleanupTerminal(record, "retained", "Policy requested retention");
      const retainedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
        type: "agent.native_cleanup.retained",
        disposition: requested
      }) : "";
      if (retainedEventError) auditWarnings.push(retainedEventError);
      return await this.finishCleanupResult(
        { recordId: record.id, cleanup: "retained", attempted: false },
        auditWarnings
      );
    }
    if (!adapter?.disposeNativeExecution) {
      await this.markCleanupTerminal(record, "unsupported", "Adapter does not support native execution cleanup");
      const unsupportedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
        type: "agent.native_cleanup.unsupported",
        disposition: requested,
        error: "Adapter does not support native execution cleanup"
      }) : "";
      if (unsupportedEventError) auditWarnings.push(unsupportedEventError);
      return await this.finishCleanupResult(
        { recordId: record.id, cleanup: "unsupported", attempted: false },
        auditWarnings
      );
    }
    return await this.withAdapterCleanupLock(record.native.backendId, async () => {
      let providerDispositionStarted = false;
      try {
        const connection = await adapter.connect({
          runId: record.runId,
          sessionId: record.sessionId,
          workspace: { vaultPath: record.native.vaultId, cwd: record.native.vaultId }
        });
        if (!connection.connected) {
          throw new Error(
            connection.errors[0]
            || `${adapter.manifest.displayName} is unavailable for Native cleanup`
          );
        }
        if (flight.conflictMessage) {
          return await this.quarantineNativeIdentityConflict(
            record,
            flight.conflictMessage,
            auditWarnings
          );
        }
        providerDispositionStarted = true;
        const result = await adapter.disposeNativeExecution!({
          ref: record.native,
          requested,
          reason: record.dispositionReason ?? cleanupReason(record.runOutcome)
        });
        if (flight.conflictMessage) {
          return await this.quarantineLateNativeIdentityConflict(
            record,
            flight,
            auditWarnings,
            `provider returned ${result.outcome}`
          );
        }
        if (result.outcome === "disposed" || result.outcome === "already-disposed") {
          await this.markDisposed(record, result.applied ?? requested);
          const completedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
            type: "agent.native_cleanup.completed",
            disposition: result.applied ?? requested
          }) : "";
          if (completedEventError) auditWarnings.push(completedEventError);
          const completed = await this.finishCleanupResult(
            { recordId: record.id, cleanup: "disposed", attempted: true, message: result.message },
            auditWarnings
          );
          if (flight.conflictMessage) {
            return await this.quarantineLateNativeIdentityConflict(
              record,
              flight,
              auditWarnings,
              `provider returned ${result.outcome}`
            );
          }
          return completed;
        }
        if (result.outcome === "unsupported") {
          await this.markCleanupTerminal(record, "unsupported", result.message ?? "Native cleanup unsupported");
          const unsupportedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
            type: "agent.native_cleanup.unsupported",
            disposition: requested,
            error: result.message ?? "Native cleanup unsupported"
          }) : "";
          if (unsupportedEventError) auditWarnings.push(unsupportedEventError);
          return await this.finishCleanupResult(
            { recordId: record.id, cleanup: "unsupported", attempted: true, message: result.message },
            auditWarnings
          );
        }
        if (result.outcome === "retained") {
          await this.markCleanupTerminal(record, "retained", result.message ?? "Native execution retained");
          const retainedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
            type: "agent.native_cleanup.retained",
            disposition: requested,
            error: result.message ?? "Native execution retained"
          }) : "";
          if (retainedEventError) auditWarnings.push(retainedEventError);
          return await this.finishCleanupResult(
            { recordId: record.id, cleanup: "retained", attempted: true, message: result.message },
            auditWarnings
          );
        }
        const failed = await this.markCleanupFailed(record, result.message ?? "Native cleanup failed");
        const cleanup = failed?.cleanup === "quarantined" ? "quarantined" : "failed";
        const failedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
          type: cleanup === "quarantined"
            ? "agent.native_cleanup.quarantined"
            : "agent.native_cleanup.failed",
          disposition: requested,
          error: result.message ?? "Native cleanup failed"
        }) : "";
        if (failedEventError) auditWarnings.push(failedEventError);
        return await this.finishCleanupResult(
          { recordId: record.id, cleanup, attempted: true, message: result.message },
          auditWarnings
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (providerDispositionStarted && flight.conflictMessage) {
          return await this.quarantineLateNativeIdentityConflict(
            record,
            flight,
            auditWarnings,
            `provider disposition raised ${message}`
          );
        }
        const failed = providerDispositionStarted
          ? await this.markCleanupFailed(record, message)
          : await this.markCleanupDeferred(record, message);
        const cleanup = failed?.cleanup === "quarantined" ? "quarantined" : "failed";
        const failedEventError = emitEvents ? await this.tryEmitRunEvent(record, {
          type: cleanup === "quarantined"
            ? "agent.native_cleanup.quarantined"
            : "agent.native_cleanup.failed",
          disposition: requested,
          error: message
        }) : "";
        if (failedEventError) auditWarnings.push(failedEventError);
        return await this.finishCleanupResult(
          { recordId: record.id, cleanup, attempted: providerDispositionStarted, message },
          auditWarnings
        );
      } finally {
        await adapter.dispose().catch(() => undefined);
      }
    });
  }

  /**
   * Cleanup adapters are manager-level singletons. Connecting or disposing one
   * record while another record is using the same adapter can tear down the
   * other cleanup mid-flight, so all adapter lifecycle work is serialized per
   * backend while different backends remain independent.
   */
  private async withAdapterCleanupLock<T>(backendId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.cleanupCoordinator.adapterCleanupTails.get(backendId)
      ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.cleanupCoordinator.adapterCleanupTails.set(backendId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.cleanupCoordinator.adapterCleanupTails.get(backendId) === current) {
        this.cleanupCoordinator.adapterCleanupTails.delete(backendId);
      }
    }
  }

  private async finishCleanupResult(
    result: NativeCleanupResult,
    auditWarnings: string[]
  ): Promise<NativeCleanupResult> {
    const warning = auditWarnings.reduce(mergeErrorMessage, "");
    if (!warning) return result;
    const record = await this.options.store.get(result.recordId);
    if (record) await this.noteEventFailure(record, warning);
    return {
      ...result,
      message: mergeErrorMessage(result.message ?? "", warning)
    };
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
    await this.options.store.update(record.id, (current) => {
      const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
      return {
        ...rest,
        cleanup: "disposed",
        appliedDisposition: applied,
        disposedAt: this.now()
      };
    });
  }

  private async markCleanupTerminal(record: NativeExecutionRecord, cleanup: "unsupported" | "retained", message: string): Promise<void> {
    await this.options.store.update(record.id, (current) => {
      const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
      return {
        ...rest,
        cleanup,
        lastError: message,
        disposedAt: this.now()
      };
    });
  }

  private async markCleanupFailed(record: NativeExecutionRecord, message: string): Promise<NativeExecutionRecord | null> {
    return await this.options.store.update(record.id, (current) => {
      const attempts = current.attempts;
      const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
      if (attempts >= MAX_CLEANUP_ATTEMPTS) {
        return {
          ...rest,
          cleanup: "quarantined",
          attempts,
          nextAttemptAt: 0,
          quarantinedAt: current.quarantinedAt || this.now(),
          lastError: message
        };
      }
      return {
        ...rest,
        cleanup: "failed",
        attempts,
        nextAttemptAt: this.now() + backoffForAttempt(attempts),
        lastError: message
      };
    });
  }

  private async markCleanupDeferred(
    record: NativeExecutionRecord,
    message: string,
    nextAttemptAt?: number
  ): Promise<NativeExecutionRecord | null> {
    return await this.options.store.update(record.id, (current) => {
      const attempts = current.attempts;
      const { cleanupStartedAt: _cleanupStartedAt, ...rest } = current;
      if (attempts >= MAX_CLEANUP_ATTEMPTS) {
        return {
          ...rest,
          cleanup: "quarantined",
          attempts,
          nextAttemptAt: 0,
          quarantinedAt: current.quarantinedAt || this.now(),
          lastError: mergeErrorMessage(current.lastError, message)
        };
      }
      return {
        ...rest,
        cleanup: "failed",
        attempts,
        nextAttemptAt: nextAttemptAt ?? this.now() + backoffForAttempt(attempts),
        lastError: mergeErrorMessage(current.lastError, message)
      };
    });
  }
}

function cleanupNeeded(record: NativeExecutionRecord): boolean {
  return record.policy.mode === "ephemeral-run";
}

function isPendingRunLocalCommit(
  record: NativeExecutionRecord,
  filter: NativePendingRecoveryFilter
): boolean {
  return (
    record.localCommit === "pending"
    && record.cleanup === "not-needed"
    && record.retirement === undefined
    && (!filter.recordId || record.id === filter.recordId)
    && (!filter.surface || record.surface === filter.surface)
    && (!filter.sessionId || record.sessionId === filter.sessionId)
    && (!filter.workflow || record.workflow === filter.workflow)
  );
}

function sameNativeSettlementReceipt(
  record: NativeExecutionRecord,
  input: SettleNativeExecutionInput
): boolean {
  return record.runOutcome === input.runOutcome
    && record.localCommit === (input.localCommit.committed ? "committed" : "failed");
}

function canQuarantineNativeSettlementConflict(record: NativeExecutionRecord): boolean {
  return record.localCommit === "committed"
    && (
      record.cleanup === "not-needed"
      || record.cleanup === "pending"
      || record.cleanup === "failed"
    );
}

function nativeSettlementConflictMessage(
  record: NativeExecutionRecord,
  input: SettleNativeExecutionInput
): string {
  const incomingLocalCommit = input.localCommit.committed ? "committed" : "failed";
  return (
    `Conflicting Native settlement for ${record.id}: `
    + `stored=${record.runOutcome ?? "pending"}/${record.localCommit}/${record.cleanup}, `
    + `incoming=${input.runOutcome}/${incomingLocalCommit}`
  );
}

function chooseSupportedDisposition(record: NativeExecutionRecord, adapter?: AgentAdapter): NativeDisposition {
  if (!hasTrustedNativeExecutionIdentity(record.native)) return "retain";
  const capabilities = adapter?.manifest.nativeExecution?.dispositions;
  let unsupportedFallback: NativeDisposition | null = null;
  for (const disposition of record.policy.preferredDisposition) {
    if (disposition === "retain") return unsupportedFallback ?? "retain";
    unsupportedFallback ??= disposition;
    if (!capabilities) continue;
    if (disposition === "delete" && capabilities.delete) return "delete";
    if (disposition === "archive" && capabilities.archive) return "archive";
    if (disposition === "process-exit" && capabilities.processExit) return "process-exit";
  }
  return unsupportedFallback ?? "retain";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupCoordinatorFor(rootKey: string): NativeCleanupCoordinator {
  const existing = cleanupCoordinatorsByRoot.get(rootKey);
  if (existing) return existing;
  const created: NativeCleanupCoordinator = {
    cleanupDueFlight: null,
    cleanupRecovery: null,
    cleanupQuietWindowId: null,
    activeCleanupRecordIds: new Set(),
    recordCleanupFlights: new Map(),
    nativeCleanupFlights: new Map(),
    adapterCleanupTails: new Map()
  };
  cleanupCoordinatorsByRoot.set(rootKey, created);
  return created;
}

function sameRetirementIdentity(left: NativeExecutionRecord, right: NativeExecutionRecord): boolean {
  const leftRetirement = left.retirement;
  const rightRetirement = right.retirement;
  return Boolean(
    leftRetirement
    && rightRetirement
    && left.id === right.id
    && left.sessionId === right.sessionId
    && sameNativeExecutionRefIdentity(left.native, right.native)
    && leftRetirement.recordMutationId === rightRetirement.recordMutationId
    && leftRetirement.targetConversationId === rightRetirement.targetConversationId
    && leftRetirement.sourceGeneration === rightRetirement.sourceGeneration
    && leftRetirement.sourceCommitId === rightRetirement.sourceCommitId
    && leftRetirement.sourceContextId === rightRetirement.sourceContextId
    && leftRetirement.sourceWorkspaceFingerprint
      === rightRetirement.sourceWorkspaceFingerprint
    && sameRetirementTarget(leftRetirement, rightRetirement)
    && leftRetirement.reason === rightRetirement.reason
  );
}

function sameRetirementTarget(
  left: NonNullable<NativeExecutionRecord["retirement"]>,
  right: NonNullable<NativeExecutionRecord["retirement"]>
): boolean {
  const leftState = nativeRetirementTargetState(left);
  const rightState = nativeRetirementTargetState(right);
  if (leftState !== rightState || leftState === "invalid") return false;
  if (leftState === "deleted") {
    return left.targetStatus === "deleted"
      && right.targetStatus === "deleted"
      && left.targetTombstoneId === right.targetTombstoneId
      && left.targetTombstoneDigest === right.targetTombstoneDigest;
  }
  return left.targetStatus !== "deleted"
    && right.targetStatus !== "deleted"
    && left.targetGeneration === right.targetGeneration
    && left.targetCommitId === right.targetCommitId
    && left.targetContextId === right.targetContextId
    && left.targetWorkspaceFingerprint
      === right.targetWorkspaceFingerprint;
}

function sameCleanupAuthorityIdentity(
  left: NativeExecutionRecord,
  right: NativeExecutionRecord
): boolean {
  if (left.retirement || right.retirement) {
    return sameRetirementIdentity(left, right);
  }
  return (
    left.id === right.id
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.surface === right.surface
    && left.workflow === right.workflow
    && left.createdAt === right.createdAt
    && sameLocalCommitAuthority(
      left.localCommitAuthority,
      right.localCommitAuthority
    )
    && left.requestedDisposition === right.requestedDisposition
    && left.dispositionReason === right.dispositionReason
    && sameNativeExecutionRefIdentity(left.native, right.native)
    && left.policy.historyAuthority === right.policy.historyAuthority
    && left.policy.mode === right.policy.mode
    && left.policy.retainWhenLocalCommitFails === right.policy.retainWhenLocalCommitFails
    && left.policy.cleanupRequiredForTaskSuccess === right.policy.cleanupRequiredForTaskSuccess
    && left.policy.preferredDisposition.length === right.policy.preferredDisposition.length
    && left.policy.preferredDisposition.every((
      disposition,
      index
    ) => disposition === right.policy.preferredDisposition[index])
  );
}

function isQuarantinedMissingCleanupAuthorityEvidence(
  record: NativeExecutionRecord
): boolean {
  return record.policy.mode === "leased-conversation"
    && record.retirement === undefined
    && record.localCommit === "committed"
    && record.cleanup === "quarantined";
}

function isInitialNativeExecutionRegistration(record: NativeExecutionRecord): boolean {
  return record.localCommit === "pending"
    && record.cleanup === "not-needed"
    && record.attempts === 0
    && record.nextAttemptAt === 0
    && record.settledAt === 0
    && record.committedAt === 0
    && record.disposedAt === 0
    && record.cleanupStartedAt === undefined
    && record.quarantinedAt === undefined
    && record.retirement === undefined
    && record.requestedDisposition === undefined
    && record.appliedDisposition === undefined;
}

function sameNativeExecutionRegistrationIdentity(
  left: NativeExecutionRecord,
  right: NativeExecutionRecord
): boolean {
  return (
    left.id === right.id
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.surface === right.surface
    && left.workflow === right.workflow
    && left.createdAt === right.createdAt
    && sameLocalCommitAuthority(
      left.localCommitAuthority,
      right.localCommitAuthority
    )
    && left.emitEvents === right.emitEvents
    && left.dispositionReason === right.dispositionReason
    && sameNativeExecutionRefIdentity(left.native, right.native)
    && left.policy.historyAuthority === right.policy.historyAuthority
    && left.policy.mode === right.policy.mode
    && left.policy.retainWhenLocalCommitFails === right.policy.retainWhenLocalCommitFails
    && left.policy.cleanupRequiredForTaskSuccess === right.policy.cleanupRequiredForTaskSuccess
    && left.policy.preferredDisposition.length === right.policy.preferredDisposition.length
    && left.policy.preferredDisposition.every((
      disposition,
      index
    ) => disposition === right.policy.preferredDisposition[index])
  );
}

function sameLocalCommitAuthority(
  left: NativeExecutionRecord["localCommitAuthority"],
  right: NativeExecutionRecord["localCommitAuthority"]
): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind
    && left.transactionId === right.transactionId;
}

function sameObservedDisposition(
  left: EchoInkHostProcessDispositionReceipt,
  right: EchoInkHostProcessDispositionReceipt
): boolean {
  return left.version === right.version
    && left.owner === right.owner
    && left.executionId === right.executionId
    && left.disposition === right.disposition
    && left.state === right.state
    && left.observedAt === right.observedAt;
}

function sameNativeExecutionRefIdentity(
  left: NativeExecutionRecord["native"],
  right: NativeExecutionRecord["native"]
): boolean {
  return (
    left.backendId === right.backendId
    && left.id === right.id
    && left.kind === right.kind
    && left.persistence === right.persistence
    && compatibleNativeExecutionTransport(left.transport, right.transport)
    && left.identityAuthority === right.identityAuthority
    && sameHostExecutionIdentity(left.hostExecution, right.hostExecution)
    && left.providerEndpoint === right.providerEndpoint
    && left.deviceKey === right.deviceKey
    && left.vaultId === right.vaultId
    && left.createdAt === right.createdAt
  );
}

function compatibleNativeExecutionTransport(
  left: string | undefined,
  right: string | undefined
): boolean {
  const normalizedLeft = left?.trim() ?? "";
  const normalizedRight = right?.trim() ?? "";
  // Missing transport means a legacy record, not evidence of a conflicting
  // identity. Two known transports must still agree on registration replay.
  return !normalizedLeft
    || !normalizedRight
    || normalizedLeft === normalizedRight;
}

function sameHostExecutionIdentity(
  left: NativeExecutionRecord["native"]["hostExecution"],
  right: NativeExecutionRecord["native"]["hostExecution"]
): boolean {
  if (!left || !right) return left === right;
  return left.version === right.version
    && left.owner === right.owner
    && left.executionId === right.executionId
    && left.targetBackendId === right.targetBackendId
    && left.transport === right.transport
    && left.attemptId === right.attemptId
    && left.backendNativeIdentity === right.backendNativeIdentity
    && left.createdAt === right.createdAt;
}

function nativeExecutionCleanupIdentityKey(native: NativeExecutionRecord["native"]): string {
  // Transport is audit metadata today; cleanup routing remains scoped by the
  // backend, Native kind/id and provider/device/Vault context. Keeping the key
  // transport-agnostic preserves dedupe with legacy records that omit it.
  return JSON.stringify([
    native.backendId,
    native.id,
    native.kind,
    native.identityAuthority ?? "backend",
    native.hostExecution?.targetBackendId ?? "",
    native.hostExecution?.transport ?? "",
    native.hostExecution?.attemptId ?? "",
    native.providerEndpoint ?? "",
    native.deviceKey,
    native.vaultId
  ]);
}

function participatesInNativeDisposition(record: NativeExecutionRecord): boolean {
  return record.localCommit === "committed"
    && !isNativeCleanupAuthorityEvidenceMissing(record)
    && record.cleanup !== "not-needed"
    && record.cleanup !== "retained-for-recovery"
    && record.cleanup !== "aborted"
    && record.cleanup !== "awaiting-local-commit";
}

function participatesInNativeConflictQuarantine(record: NativeExecutionRecord): boolean {
  return record.cleanup !== "quarantined"
    && (
      participatesInNativeDisposition(record)
      || isNativeCleanupAuthorityEvidenceMissing(record)
    );
}

function selectNativeIdentityCleanupReceipt(
  records: readonly NativeExecutionRecord[],
  currentRecordId: string,
  now: number
): NativeExecutionRecord | null {
  const siblings = records.filter((record) => record.id !== currentRecordId);
  for (const cleanup of ["disposed", "unsupported", "retained", "quarantined"] as const) {
    const receipt = siblings.find((record) => record.cleanup === cleanup);
    if (receipt) return receipt;
  }
  return siblings.find((record) => (
    record.cleanup === "failed" && record.nextAttemptAt > now
  )) ?? null;
}

function isNativeCleanupReceipt(record: NativeExecutionRecord, now: number): boolean {
  return record.cleanup === "disposed"
    || record.cleanup === "unsupported"
    || record.cleanup === "retained"
    || record.cleanup === "quarantined"
    || (record.cleanup === "failed" && record.nextAttemptAt > now);
}

function nativeDispositionConflictMessage(
  native: NativeExecutionRecord["native"],
  dispositions: readonly NativeDisposition[]
): string {
  return (
    `Conflicting Native disposition requests for ${native.backendId}/${native.id}: `
    + Array.from(new Set(dispositions)).sort().join(", ")
  );
}
