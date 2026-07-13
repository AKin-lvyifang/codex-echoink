import type { StoredSession } from "../../settings/settings";
import type { BackendSessionBinding } from "../contracts/run";
import type { NativeExecutionRef } from "../contracts/native-execution";

export function sessionBackendBinding(session: Pick<StoredSession, "backendBindings">, backendId: string): BackendSessionBinding | null {
  const id = backendId.trim();
  if (!id) return null;
  return session.backendBindings?.[id] ?? null;
}

export function updateSessionBackendBinding(session: StoredSession, binding: BackendSessionBinding): void {
  const backendId = binding.backendId.trim();
  if (!backendId) return;
  session.backendBindings = {
    ...(session.backendBindings ?? {}),
    [backendId]: {
      ...binding,
      backendId
    }
  };
  if (backendId === "codex-cli" && binding.nativeThreadId) {
    session.threadId = binding.nativeThreadId;
  }
  session.updatedAt = Math.max(session.updatedAt ?? 0, binding.lastUsedAt);
}

export function advanceSessionRevision(session: StoredSession, now = Date.now()): number {
  const current = Number.isSafeInteger(session.revision) && (session.revision ?? 0) > 0
    ? session.revision as number
    : 1;
  session.revision = Math.min(Number.MAX_SAFE_INTEGER, current + 1);
  delete session.contextSnapshot;
  delete session.rollingSummary;
  session.updatedAt = Math.max(session.updatedAt ?? 0, now);
  return session.revision;
}

export function sessionNativeExecutionRefs(session: StoredSession): NativeExecutionRef[] {
  const refs: NativeExecutionRef[] = [];
  for (const binding of Object.values(session.backendBindings ?? {})) {
    const id = binding.nativeThreadId ?? binding.nativeSessionId;
    if (!id) continue;
    refs.push(binding.nativeExecutionRef ?? {
      backendId: binding.backendId,
      id,
      kind: binding.nativeExecutionKind ?? (binding.nativeThreadId ? "thread" : "session"),
      persistence: "unknown",
      deviceKey: "unknown",
      vaultId: "unknown",
      createdAt: binding.leaseCreatedAt ?? binding.lastUsedAt
    });
  }
  return refs;
}
