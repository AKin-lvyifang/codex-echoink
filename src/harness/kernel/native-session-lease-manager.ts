import type { ContextCompileMode, ContextSyncCursor } from "../contracts/context";
import type { BackendSessionBinding, HarnessRunRequest } from "../contracts/run";
import type { NativeExecutionDispositionResult, NativeSessionLease } from "../contracts/native-execution";
import type { StoredSession } from "../../settings/settings";

export interface NativeSessionLeaseDecision {
  mode: ContextCompileMode;
  reusable: boolean;
  reason:
    | "workflow"
    | "no-binding"
    | "context-identity-missing"
    | "context-identity-mismatch"
    | "vault-profile-mismatch"
    | "no-lease"
    | "expired"
    | "max-turns"
    | "context-capacity"
    | "revision-mismatch"
    | "incremental"
    | "catch-up";
  cursor?: ContextSyncCursor;
}

export interface NativeSessionLeaseLimits {
  ttlMs: number;
  maxTurns: number;
  maxContextChars: number;
  maxActiveLeasesPerSession: number;
  maxActiveLeasesPerBackend: number;
  gracePeriodMs: number;
}

export interface NativeSessionLeaseManagerOptions {
  limits?: Partial<NativeSessionLeaseLimits>;
}

export interface NativeSessionLeaseCleanupPlanItem {
  leaseId: string;
  backendId: string;
  echoInkSessionId: string;
  reason: "expired" | "max-turns" | "context-capacity" | "session-capacity" | "backend-capacity" | "recovery";
}

export interface NativeSessionLeaseCleanupPlanInput {
  leases: NativeSessionLease[];
  now: number;
}

export interface NativeSessionLeaseCleanupExecutionResult extends NativeSessionLeaseCleanupPlanItem {
  outcome: NativeExecutionDispositionResult["outcome"] | "local-commit-failed" | "retirement-scheduled";
  message?: string;
}

export interface NativeSessionLeaseRetirementInput {
  session: StoredSession;
  binding: BackendSessionBinding;
  lease: NativeSessionLease;
  reason: NativeSessionLeaseCleanupPlanItem["reason"];
}

export interface NativeSessionLeaseCleanupExecutionInput {
  sessions: StoredSession[];
  now: number;
  retire?(input: NativeSessionLeaseRetirementInput): Promise<void>;
  /**
   * @deprecated Direct lease cleanup is unsafe. Kept temporarily so older
   * callers typecheck while they migrate to `retire`; never invoked.
   */
  commit?(): Promise<void>;
  /**
   * @deprecated Provider disposition must be driven by the durable Native
   * retirement index, never directly from the lease manager; never invoked.
   */
  dispose?(
    lease: NativeSessionLease,
    reason: NativeSessionLeaseCleanupPlanItem["reason"]
  ): Promise<NativeExecutionDispositionResult>;
}

export const DEFAULT_NATIVE_SESSION_LEASE_LIMITS: NativeSessionLeaseLimits = {
  ttlMs: 30 * 60_000,
  maxTurns: 20,
  maxContextChars: 120_000,
  maxActiveLeasesPerSession: 2,
  maxActiveLeasesPerBackend: 50,
  gracePeriodMs: 5 * 60_000
};

export interface NativeSessionLeaseDecisionInput {
  request: Pick<HarnessRunRequest, "surface" | "workflow">;
  binding?: BackendSessionBinding | null;
  lease?: NativeSessionLease | null;
  expectedWorkspaceFingerprint?: string;
  expectedSessionGeneration?: number;
  expectedContextId?: string;
  expectedVaultProfileFingerprint: string;
  sessionRevision: number;
  currentContextMessageIds: readonly string[];
  latestMessageId?: string;
  requiresCatchUp?: boolean;
  now: number;
}

export class NativeSessionLeaseManager {
  readonly limits: NativeSessionLeaseLimits;
  private readonly leaseByRun = new Map<string, string>();
  private readonly runsByLease = new Map<string, Set<string>>();

  constructor(options: NativeSessionLeaseManagerOptions = {}) {
    this.limits = { ...DEFAULT_NATIVE_SESSION_LEASE_LIMITS, ...options.limits };
  }

  reserveLeaseForRun(runId: string, leaseId: string): void {
    const normalizedRunId = runId.trim();
    const normalizedLeaseId = leaseId.trim();
    if (!normalizedRunId || !normalizedLeaseId) return;
    const previousLeaseId = this.leaseByRun.get(normalizedRunId);
    if (previousLeaseId === normalizedLeaseId) return;
    if (previousLeaseId) this.releaseLeaseForRun(normalizedRunId);
    this.leaseByRun.set(normalizedRunId, normalizedLeaseId);
    const runs = this.runsByLease.get(normalizedLeaseId) ?? new Set<string>();
    runs.add(normalizedRunId);
    this.runsByLease.set(normalizedLeaseId, runs);
  }

  releaseLeaseForRun(runId: string): void {
    const normalizedRunId = runId.trim();
    const leaseId = this.leaseByRun.get(normalizedRunId);
    if (!leaseId) return;
    this.leaseByRun.delete(normalizedRunId);
    const runs = this.runsByLease.get(leaseId);
    runs?.delete(normalizedRunId);
    if (!runs?.size) this.runsByLease.delete(leaseId);
  }

  isLeaseReserved(leaseId: string): boolean {
    return Boolean(this.runsByLease.get(leaseId.trim())?.size);
  }

  decide(input: NativeSessionLeaseDecisionInput): NativeSessionLeaseDecision {
    if (workflowUsesEphemeralRun(input.request)) {
      return { mode: "workflow", reusable: false, reason: "workflow" };
    }
    const binding = input.binding ?? null;
    if (!binding) {
      return { mode: "bootstrap", reusable: false, reason: "no-binding" };
    }
    const cursor = binding.contextCursor;
    if (
      !binding.workspaceFingerprint
      || !input.expectedWorkspaceFingerprint
      || !cursor
      || !isPositiveSafeInteger(cursor.sessionGeneration)
      || !isPositiveSafeInteger(input.expectedSessionGeneration)
      || !cursor.contextId?.trim()
      || !input.expectedContextId?.trim()
      || !cursor.workspaceFingerprint?.trim()
      || !Array.isArray(input.currentContextMessageIds)
    ) {
      return {
        mode: "bootstrap",
        reusable: false,
        reason: "context-identity-missing"
      };
    }
    if (
      binding.workspaceFingerprint !== input.expectedWorkspaceFingerprint
      || cursor.workspaceFingerprint !== input.expectedWorkspaceFingerprint
      || cursor.sessionGeneration !== input.expectedSessionGeneration
      || cursor.contextId !== input.expectedContextId
    ) {
      return {
        mode: "bootstrap",
        reusable: false,
        reason: "context-identity-mismatch"
      };
    }
    if (
      (binding.vaultProfileFingerprint?.trim() ?? "")
      !== input.expectedVaultProfileFingerprint.trim()
    ) {
      return {
        mode: "bootstrap",
        reusable: false,
        reason: "vault-profile-mismatch"
      };
    }
    const cursorAnchor = cursor.syncedThroughMessageId?.trim();
    if (
      cursorAnchor
      && input.currentContextMessageIds.filter((messageId) =>
        messageId === cursorAnchor
      ).length !== 1
    ) {
      return {
        mode: "bootstrap",
        reusable: false,
        reason: "context-identity-mismatch"
      };
    }
    if (binding.syncedSessionRevision !== input.sessionRevision) {
      return { mode: "bootstrap", reusable: false, reason: "revision-mismatch" };
    }
    const lease = input.lease ?? null;
    if (!lease || lease.status !== "active") {
      return { mode: "bootstrap", reusable: false, reason: "no-lease", cursor: binding.contextCursor };
    }
    if (lease.expiresAt <= input.now) {
      return { mode: "bootstrap", reusable: false, reason: "expired", cursor: binding.contextCursor };
    }
    if (lease.turnCount >= lease.maxTurns) {
      return { mode: "bootstrap", reusable: false, reason: "max-turns", cursor: binding.contextCursor };
    }
    if (lease.maxContextChars && (lease.contextChars ?? 0) >= lease.maxContextChars) {
      return { mode: "bootstrap", reusable: false, reason: "context-capacity", cursor: binding.contextCursor };
    }
    if (input.requiresCatchUp && binding.syncedThroughMessageId && input.latestMessageId && binding.syncedThroughMessageId !== input.latestMessageId) {
      return { mode: "catch-up", reusable: true, reason: "catch-up", cursor: binding.contextCursor };
    }
    return { mode: "incremental", reusable: true, reason: "incremental", cursor: binding.contextCursor };
  }

  planCleanup(input: NativeSessionLeaseCleanupPlanInput): NativeSessionLeaseCleanupPlanItem[] {
    const planned = new Map<string, NativeSessionLeaseCleanupPlanItem>();
    const availableLeases = input.leases.filter((lease) => !this.isLeaseReserved(lease.leaseId));
    for (const lease of availableLeases.filter((item) => item.status === "cleanup-pending")) {
      addPlan(planned, lease, "recovery");
    }
    const active = availableLeases.filter((lease) => lease.status === "active");
    for (const lease of active) {
      const reason = invalidLeaseReason(lease, input.now);
      if (reason) addPlan(planned, lease, reason);
    }
    const eligible = active.filter((lease) => !planned.has(lease.leaseId));
    for (const leases of groupLeases(eligible, (lease) => lease.echoInkSessionId).values()) {
      for (const lease of leasesByLru(leases).slice(this.limits.maxActiveLeasesPerSession)) {
        if (input.now - lease.lastUsedAt > this.limits.gracePeriodMs) addPlan(planned, lease, "session-capacity");
      }
    }
    const afterSessionCapacity = eligible.filter((lease) => !planned.has(lease.leaseId));
    for (const leases of groupLeases(afterSessionCapacity, (lease) => lease.backendId).values()) {
      for (const lease of leasesByLru(leases).slice(this.limits.maxActiveLeasesPerBackend)) {
        if (input.now - lease.lastUsedAt > this.limits.gracePeriodMs) addPlan(planned, lease, "backend-capacity");
      }
    }
    return Array.from(planned.values());
  }

  async cleanupSessions(input: NativeSessionLeaseCleanupExecutionInput): Promise<NativeSessionLeaseCleanupExecutionResult[]> {
    const leases = nativeSessionLeasesFromSessions(input.sessions);
    const plan = this.planCleanup({ leases, now: input.now });
    const results: NativeSessionLeaseCleanupExecutionResult[] = [];
    for (const item of plan) {
      const target = findLeaseBinding(input.sessions, item);
      const lease = leases.find((candidate) => candidate.leaseId === item.leaseId);
      if (!target || !lease) continue;
      if (this.isLeaseReserved(item.leaseId)) continue;
      if (!input.retire) {
        results.push({
          ...item,
          outcome: "local-commit-failed",
          message: "Durable Native binding retirement callback is required"
        });
        continue;
      }
      try {
        await input.retire({
          session: target.session,
          binding: target.binding,
          lease,
          reason: item.reason
        });
      } catch (error) {
        results.push({ ...item, outcome: "local-commit-failed", message: errorMessage(error) });
        continue;
      }
      if (target.session.backendBindings?.[target.binding.backendId]) {
        results.push({
          ...item,
          outcome: "local-commit-failed",
          message: "Durable Native binding retirement did not remove the retired binding"
        });
        continue;
      }
      if (target.binding.backendId === "codex-cli" && target.session.threadId) {
        results.push({
          ...item,
          outcome: "local-commit-failed",
          message: "Durable Native binding retirement did not clear the legacy Codex thread binding"
        });
        continue;
      }
      results.push({ ...item, outcome: "retirement-scheduled" });
    }
    return results;
  }
}

export function nativeSessionLeasesFromSessions(sessions: StoredSession[]): NativeSessionLease[] {
  const leases: NativeSessionLease[] = [];
  for (const session of sessions) {
    for (const binding of Object.values(session.backendBindings ?? {})) {
      if (!binding.leaseId) continue;
      const nativeId = binding.nativeThreadId ?? binding.nativeSessionId;
      if (!nativeId) continue;
      leases.push({
        leaseId: binding.leaseId,
        echoInkSessionId: session.id,
        backendId: binding.backendId,
        native: binding.nativeExecutionRef ?? {
          backendId: binding.backendId,
          id: nativeId,
          kind: binding.nativeExecutionKind ?? (binding.nativeThreadId ? "thread" : "session"),
          persistence: "unknown",
          deviceKey: "unknown",
          vaultId: "unknown",
          createdAt: binding.leaseCreatedAt ?? binding.lastUsedAt
        },
        mode: "leased-conversation",
        status: binding.leaseStatus ?? "active",
        createdAt: binding.leaseCreatedAt ?? binding.lastUsedAt,
        lastUsedAt: binding.leaseLastUsedAt ?? binding.lastUsedAt,
        expiresAt: binding.leaseExpiresAt ?? Number.MAX_SAFE_INTEGER,
        turnCount: binding.leaseTurnCount ?? 0,
        maxTurns: binding.leaseMaxTurns ?? DEFAULT_NATIVE_SESSION_LEASE_LIMITS.maxTurns,
        contextCheckpointMessageId: binding.contextCheckpointMessageId ?? binding.syncedThroughMessageId,
        contextChars: binding.leaseContextChars,
        maxContextChars: binding.leaseMaxContextChars
      });
    }
  }
  return leases;
}

function workflowUsesEphemeralRun(request: Pick<HarnessRunRequest, "surface" | "workflow">): boolean {
  if (request.workflow === "prompt.enhance") return true;
  if (request.surface === "chat") return false;
  if (request.workflow === "knowledge.ask") return false;
  return true;
}

function invalidLeaseReason(lease: NativeSessionLease, now: number): NativeSessionLeaseCleanupPlanItem["reason"] | null {
  if (lease.expiresAt <= now) return "expired";
  if (lease.turnCount >= lease.maxTurns) return "max-turns";
  if (lease.maxContextChars && (lease.contextChars ?? 0) >= lease.maxContextChars) return "context-capacity";
  return null;
}

function addPlan(
  planned: Map<string, NativeSessionLeaseCleanupPlanItem>,
  lease: NativeSessionLease,
  reason: NativeSessionLeaseCleanupPlanItem["reason"]
): void {
  if (planned.has(lease.leaseId)) return;
  planned.set(lease.leaseId, {
    leaseId: lease.leaseId,
    backendId: lease.backendId,
    echoInkSessionId: lease.echoInkSessionId,
    reason
  });
}

function groupLeases(leases: NativeSessionLease[], keyFor: (lease: NativeSessionLease) => string): Map<string, NativeSessionLease[]> {
  const groups = new Map<string, NativeSessionLease[]>();
  for (const lease of leases) {
    const key = keyFor(lease);
    groups.set(key, [...(groups.get(key) ?? []), lease]);
  }
  return groups;
}

function leasesByLru(leases: NativeSessionLease[]): NativeSessionLease[] {
  return leases.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.leaseId.localeCompare(b.leaseId));
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

function findLeaseBinding(
  sessions: StoredSession[],
  item: NativeSessionLeaseCleanupPlanItem
): { session: StoredSession; binding: BackendSessionBinding } | null {
  const session = sessions.find((candidate) => candidate.id === item.echoInkSessionId);
  const binding = session?.backendBindings?.[item.backendId];
  if (!session || !binding || binding.leaseId !== item.leaseId) return null;
  return { session, binding };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
