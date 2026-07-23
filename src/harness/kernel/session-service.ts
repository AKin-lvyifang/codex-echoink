import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ChatMessage, StoredSession } from "../../settings/settings";
import type { BackendSessionBinding } from "../contracts/run";
import type { ContextSection } from "../contracts/context";
import type { NativeExecutionRef } from "../contracts/native-execution";
import type { HarnessWorkspace } from "../contracts/run";

export function sessionBackendBinding(session: Pick<StoredSession, "backendBindings">, backendId: string): BackendSessionBinding | null {
  const id = backendId.trim();
  if (!id) return null;
  return session.backendBindings?.[id] ?? null;
}

export function hasLegacyCodexThreadBindingConflict(
  session: Pick<StoredSession, "threadId" | "backendBindings">
): boolean {
  const legacyThreadId = session.threadId?.trim();
  const binding = session.backendBindings?.["codex-cli"];
  if (!legacyThreadId || !binding) return false;
  const bindingThreadIds = new Set([
    binding.nativeThreadId?.trim(),
    binding.nativeExecutionRef?.kind === "thread"
      ? binding.nativeExecutionRef.id.trim()
      : ""
  ].filter(Boolean));
  return bindingThreadIds.size > 1
    || (bindingThreadIds.size === 1 && !bindingThreadIds.has(legacyThreadId));
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
  const current = sessionGeneration(session);
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "Conversation recovery required: session generation cannot advance beyond MAX_SAFE_INTEGER"
    );
  }
  const next = current + 1;
  session.revision = next;
  session.generation = next;
  delete session.contextSnapshot;
  delete session.rollingSummary;
  session.updatedAt = Math.max(session.updatedAt ?? 0, now);
  return session.revision;
}

export function sessionGeneration(session: Pick<StoredSession, "generation" | "revision">): number {
  const generation = positiveSafeInteger(session.generation);
  const revision = positiveSafeInteger(session.revision);
  return Math.max(generation, revision, 1);
}

export function messagesInCurrentSessionContext(
  session: Pick<StoredSession, "messages" | "contextStartsAfterMessageId">
): ChatMessage[] {
  const boundary = session.contextStartsAfterMessageId?.trim();
  if (!boundary) return session.messages;
  const index = session.messages.findIndex((message) => message.id === boundary);
  if (index < 0) return [];
  return session.messages.slice(index + 1);
}

export function workspaceFingerprint(workspace: Pick<HarnessWorkspace, "vaultPath" | "cwd">): string {
  const vaultPath = normalizeWorkspaceIdentityPath(workspace.vaultPath);
  const cwd = normalizeWorkspaceIdentityPath(workspace.cwd || workspace.vaultPath);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ vaultPath, cwd }))
    .digest("hex")}`;
}

export function vaultProfileFingerprint(
  sections: readonly ContextSection[] | undefined
): string {
  const serialized = (sections ?? [])
    .filter((section) => section.channel === "system")
    .map((section) => ({
      id: section.id,
      source: section.source,
      content: section.content
    }))
    .sort((left, right) =>
      left.id.localeCompare(right.id)
      || left.source.localeCompare(right.source)
    );
  if (!serialized.length) return "";
  return createHash("sha256")
    .update(JSON.stringify(serialized))
    .digest("hex");
}

export function sessionNativeExecutionRefs(session: StoredSession): NativeExecutionRef[] {
  const candidates: NativeExecutionRef[] = [];
  for (const binding of Object.values(session.backendBindings ?? {})) {
    const threadId = binding.nativeThreadId?.trim() ?? "";
    const sessionId = binding.nativeSessionId?.trim() ?? "";
    const existing = binding.nativeExecutionRef;
    const existingMatchesBinding = Boolean(
      existing
      && existing.backendId === binding.backendId
      && (!binding.nativeExecutionKind || binding.nativeExecutionKind === existing.kind)
      && (
        existing.kind === "thread"
          ? !threadId || threadId === existing.id
          : !sessionId || sessionId === existing.id
      )
    );
    if (existing && existingMatchesBinding) candidates.push(existing);
    else if (existing) {
      candidates.push(unknownNativeExecutionRef(
        binding,
        existing.id,
        existing.kind
      ));
    }
    if (threadId && (!existing || existing.id !== threadId || existing.kind !== "thread")) {
      candidates.push(unknownNativeExecutionRef(binding, threadId, "thread"));
    }
    if (sessionId && (!existing || existing.id !== sessionId || existing.kind !== "session")) {
      candidates.push(unknownNativeExecutionRef(binding, sessionId, "session"));
    }
  }
  const legacyThreadId = session.threadId?.trim();
  if (legacyThreadId) {
    candidates.push({
      backendId: "codex-cli",
      id: legacyThreadId,
      kind: "thread",
      persistence: "unknown",
      deviceKey: "unknown",
      vaultId: "unknown",
      createdAt: session.updatedAt ?? session.createdAt
    });
  }

  const conflictingIdentityGroups = new Set<string>();
  const idsByIdentityGroup = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = `${candidate.backendId}\u0000${candidate.kind}`;
    const ids = idsByIdentityGroup.get(key) ?? new Set<string>();
    ids.add(candidate.id);
    idsByIdentityGroup.set(key, ids);
    if (ids.size > 1) conflictingIdentityGroups.add(key);
  }
  const unique = new Map<string, NativeExecutionRef>();
  for (const candidate of candidates) {
    const identityGroup = `${candidate.backendId}\u0000${candidate.kind}`;
    const safeCandidate = conflictingIdentityGroups.has(identityGroup)
      ? {
        ...candidate,
        persistence: "unknown" as const,
        providerEndpoint: undefined,
        deviceKey: "unknown",
        vaultId: "unknown"
      }
      : candidate;
    const key = JSON.stringify([
      safeCandidate.backendId,
      safeCandidate.id,
      safeCandidate.kind,
      safeCandidate.persistence,
      safeCandidate.providerEndpoint ?? "",
      safeCandidate.deviceKey,
      safeCandidate.vaultId,
      safeCandidate.createdAt
    ]);
    if (!unique.has(key)) unique.set(key, safeCandidate);
  }
  return Array.from(unique.values());
}

function unknownNativeExecutionRef(
  binding: BackendSessionBinding,
  id: string,
  kind: NativeExecutionRef["kind"]
): NativeExecutionRef {
  return {
    backendId: binding.backendId,
    id,
    kind,
    persistence: "unknown",
    deviceKey: "unknown",
    vaultId: "unknown",
    createdAt: binding.leaseCreatedAt ?? binding.lastUsedAt
  };
}

function normalizeWorkspaceIdentityPath(value: string): string {
  const normalized = path.normalize(path.resolve(value.trim() || "."));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function positiveSafeInteger(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : 0;
}
