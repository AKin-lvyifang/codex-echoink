import type { ContextCompileMode, ContextSyncCursor } from "../contracts/context";
import type { BackendSessionBinding, HarnessRunRequest } from "../contracts/run";
import type { NativeExecutionDispositionResult, NativeSessionLease } from "../contracts/native-execution";
import type { StoredSession } from "../../settings/settings";

export interface NativeSessionLeaseDecision {
  mode: ContextCompileMode;
  reusable: boolean;
  reason: "workflow" | "no-binding" | "no-lease" | "expired" | "max-turns" | "context-capacity" | "revision-mismatch" | "incremental" | "catch-up";
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
  outcome: NativeExecutionDispositionResult["outcome"] | "local-commit-failed";
  message?: string;
}

export interface NativeSessionLeaseCleanupExecutionInput {
  sessions: StoredSession[];
  now: number;
  commit(): Promise<void>;
  dispose(lease: NativeSessionLease, reason: NativeSessionLeaseCleanupPlanItem["reason"]): Promise<NativeExecutionDispositionResult>;
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
  sessionRevision: number;
  latestMessageId?: string;
  requiresCatchUp?: boolean;
  now: number;
}

export class NativeSessionLeaseManager {
  readonly limits: NativeSessionLeaseLimits;

  constructor(options: NativeSessionLeaseManagerOptions = {}) {
    this.limits = { ...DEFAULT_NATIVE_SESSION_LEASE_LIMITS, ...options.limits };
  }

  decide(input: NativeSessionLeaseDecisionInput): NativeSessionLeaseDecision {
    if (workflowUsesEphemeralRun(input.request)) {
      return { mode: "workflow", reusable: false, reason: "workflow" };
    }
    const binding = input.binding ?? null;
    if (!binding) {
      return { mode: "bootstrap", reusable: false, reason: "no-binding" };
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
    for (const lease of input.leases.filter((item) => item.status === "cleanup-pending")) {
      addPlan(planned, lease, "recovery");
    }
    const active = input.leases.filter((lease) => lease.status === "active");
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
      const previousStatus = target.binding.leaseStatus ?? "active";
      target.binding.leaseStatus = "cleanup-pending";
      try {
        await input.commit();
      } catch (error) {
        target.binding.leaseStatus = previousStatus;
        results.push({ ...item, outcome: "local-commit-failed", message: errorMessage(error) });
        continue;
      }

      let disposition: NativeExecutionDispositionResult;
      try {
        disposition = await input.dispose(lease, item.reason);
      } catch (error) {
        disposition = { outcome: "failed", message: errorMessage(error) };
      }
      target.binding.leaseStatus = cleanupLeaseStatus(disposition.outcome);
      target.binding.leaseExpiresAt = Math.min(target.binding.leaseExpiresAt ?? input.now, input.now);
      try {
        await input.commit();
      } catch (error) {
        results.push({ ...item, outcome: "failed", message: `Native cleanup completed but local state commit failed: ${errorMessage(error)}` });
        continue;
      }
      results.push({ ...item, outcome: disposition.outcome, message: disposition.message });
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

function findLeaseBinding(
  sessions: StoredSession[],
  item: NativeSessionLeaseCleanupPlanItem
): { session: StoredSession; binding: BackendSessionBinding } | null {
  const session = sessions.find((candidate) => candidate.id === item.echoInkSessionId);
  const binding = session?.backendBindings?.[item.backendId];
  if (!session || !binding || binding.leaseId !== item.leaseId) return null;
  return { session, binding };
}

function cleanupLeaseStatus(outcome: NativeExecutionDispositionResult["outcome"]): NativeSessionLease["status"] {
  if (outcome === "disposed" || outcome === "already-disposed") return "disposed";
  if (outcome === "failed") return "failed";
  return "expired";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
