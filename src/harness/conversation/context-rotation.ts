import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendSessionBinding } from "../contracts/run";
import type { StoredSession } from "../../settings/settings";
import { sessionGeneration, workspaceFingerprint } from "../kernel/session-service";
import { createConversationContentRevision } from "./conversation-store";

export type SessionContextRotationReason =
  | "legacy-context-bootstrap"
  | "start-new-context"
  | "history-restore"
  | "workspace-switch"
  | "workspace-clear"
  | "agent-cache-reset"
  | "lease-rollover";

export interface SessionContextRetirement {
  retirementId: string;
  recordMutationId?: string;
  reason: SessionContextRotationReason;
  targetConversationId: string;
  sourceGeneration?: number;
  sourceCommitId?: string | null;
  sourceContextId?: string | null;
  sourceWorkspaceFingerprint?: string | null;
  targetGeneration: number;
  targetCommitId: string;
  targetContextId?: string;
  targetWorkspaceFingerprint?: string;
  backendId: string;
  binding: BackendSessionBinding;
}

export interface SessionContextCommitInput {
  session: StoredSession;
  expectedGeneration: number;
  expectedCommitId?: string;
  expectedContentRevision: string;
  targetGeneration: number;
  targetCommitId: string;
  targetContextId?: string;
}

export interface SessionContextRecordMutationStageInput
extends SessionContextCommitInput {
  reason: SessionContextRotationReason;
  retirements: readonly SessionContextRetirement[];
}

export interface SessionContextRecordMutationReceipt {
  mutationId: string;
}

export interface SessionContextRotationHooks {
  recordMutation?: {
    /**
     * Creates and stages the durable RecordMutation Journal before the first
     * Native registration or Conversation Store effect.
     */
    stage(
      input: SessionContextRecordMutationStageInput
    ): Promise<SessionContextRecordMutationReceipt>;
    /**
     * Re-reads Conversation authority and publishes the Journal terminal while
     * the caller still holds the same ConversationMutationAuthority.
     */
    settle(
      receipt: SessionContextRecordMutationReceipt
    ): Promise<"committed" | "aborted">;
  };
  /**
   * Must be atomic or idempotent by retirementId. A later abort call may
   * include IDs that were never inserted when registration failed partway.
  */
  register(retirements: SessionContextRetirement[]): Promise<void>;
  /**
   * Must contain only the authoritative Conversation Store CAS commit. Once
   * its promise resolves, metadata.json is durable and this hook must not run
   * any later work that can reject.
   */
  commit(input: SessionContextCommitInput): Promise<void>;
  promote(retirements: SessionContextRetirement[]): Promise<void>;
  /** Must tolerate already-aborted and not-found retirement IDs. */
  abort(retirements: SessionContextRetirement[], error: Error): Promise<void>;
}

export interface RotateSessionContextOptions {
  reason: SessionContextRotationReason;
  hooks: SessionContextRotationHooks;
  advanceContext?: boolean;
  /**
   * Deterministic ID injection for tests. Production callers must omit this
   * so commit/context identities always come from the helper's UUID factory.
   */
  identityFactory?: {
    commitId(): string;
    contextId?(): string;
  };
  contextStartsAfterMessageId?: string | null;
  workspace?: {
    vaultPath: string;
    cwd: string;
  } | null;
  retireBackendIds?: readonly string[];
  mutate?: (session: StoredSession) => void;
  retirementId?: (binding: BackendSessionBinding, index: number) => string;
  now?: () => number;
}

export interface SessionContextRotationResult {
  committed: true;
  conversationId: string;
  generation: number;
  contextId?: string;
  commitId: string;
  retirements: SessionContextRetirement[];
  recordMutationId?: string;
  recordMutationState?: "committed" | "awaiting-recovery";
  retirementPromotion: "not-required" | "promoted" | "awaiting-recovery";
  promotionError?: string;
}

export async function rotateSessionContext(
  session: StoredSession,
  options: RotateSessionContextOptions
): Promise<SessionContextRotationResult> {
  const before = cloneSession(session);
  const candidate = cloneSession(before);
  const expectedGeneration = sessionGeneration(before);
  const expectedCommitId = before.commitId?.trim() || undefined;
  const expectedContentRevision = createConversationContentRevision(before);
  const advanceContext = options.advanceContext !== false;
  validateRotationContract(before, options, advanceContext);
  if (advanceContext && expectedGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "Conversation recovery required: context generation cannot advance beyond MAX_SAFE_INTEGER"
    );
  }
  const targetGeneration = advanceContext
    ? expectedGeneration + 1
    : expectedGeneration;
  const targetCommitId = requiredIdentity(
    options.identityFactory?.commitId() ?? `context-commit-${randomUUID()}`,
    "commitId"
  );
  const targetContextId = advanceContext
    ? requiredIdentity(
      options.identityFactory?.contextId?.() ?? `context-${randomUUID()}`,
      "contextId"
    )
    : before.contextId?.trim() || undefined;
  if (targetCommitId === expectedCommitId) {
    throw new Error("Context rotation cannot reuse the current commitId");
  }
  if (advanceContext && targetContextId === before.contextId?.trim()) {
    throw new Error("Context rotation cannot reuse the current contextId");
  }
  const targetWorkspaceFingerprint = options.workspace === null
    ? undefined
    : options.workspace
      ? workspaceFingerprint(options.workspace)
      : before.workspaceFingerprint;
  const oldLastMessageId = before.messages.at(-1)?.id;
  const bindings = retirementBindings(before);
  const requestedBackends = new Set(
    options.retireBackendIds?.map((backendId) => backendId.trim()).filter(Boolean)
    ?? backendIdsToInvalidate(before)
  );
  const retirementId = options.retirementId
    ?? ((binding: BackendSessionBinding, index: number) =>
      `binding-retirement-${targetCommitId}-${binding.backendId}-${index + 1}`);
  let retirements = Array.from(bindings.entries())
    .filter(([backendId]) => requestedBackends.has(backendId))
    .map(([, binding], index): SessionContextRetirement => ({
      retirementId: retirementId(binding, index),
      reason: options.reason,
      targetConversationId: before.id,
      sourceGeneration: expectedGeneration,
      sourceCommitId: expectedCommitId ?? null,
      sourceContextId: before.contextId?.trim() || null,
      sourceWorkspaceFingerprint:
        before.workspaceFingerprint?.trim() || null,
      targetGeneration,
      targetCommitId,
      ...(targetContextId ? { targetContextId } : {}),
      ...(targetWorkspaceFingerprint ? { targetWorkspaceFingerprint } : {}),
      backendId: binding.backendId,
      binding: cloneBinding(binding)
    }));

  options.mutate?.(candidate);
  validatePostMutationContract(candidate, before, options);
  removeRetiredBindings(candidate, requestedBackends);
  if (advanceContext) {
    delete candidate.backendBindings;
    delete candidate.threadId;
  }
  if (options.workspace === null) {
    candidate.cwd = "";
    delete candidate.workspaceFingerprint;
  } else if (options.workspace) {
    candidate.cwd = path.resolve(options.workspace.cwd.trim() || options.workspace.vaultPath);
    candidate.workspaceFingerprint = targetWorkspaceFingerprint;
  }
  if (advanceContext) {
    candidate.revision = targetGeneration;
    candidate.generation = targetGeneration;
  } else {
    candidate.revision = before.revision;
    candidate.generation = before.generation;
  }
  candidate.commitId = targetCommitId;
  if (advanceContext) {
    candidate.contextId = targetContextId;
    setContextBoundary(candidate, options, oldLastMessageId);
    delete candidate.contextSnapshot;
    delete candidate.rollingSummary;
  }
  candidate.updatedAt = Math.max(candidate.updatedAt ?? 0, options.now?.() ?? Date.now());

  const committedCandidate = cloneSession(candidate);
  const liveCandidate = cloneSession(candidate);
  const commitInput: SessionContextCommitInput = {
    session: committedCandidate,
    expectedGeneration,
    ...(expectedCommitId ? { expectedCommitId } : {}),
    expectedContentRevision,
    targetGeneration,
    targetCommitId,
    ...(targetContextId ? { targetContextId } : {})
  };

  let recordMutationReceipt: SessionContextRecordMutationReceipt | null = null;
  let recordMutationState: "committed" | "aborted" | "awaiting-recovery" | null =
    null;
  let localCommitCompleted = false;
  let commitError: Error | null = null;
  try {
    if (options.hooks.recordMutation) {
      recordMutationReceipt = await options.hooks.recordMutation.stage({
        ...commitInput,
        reason: options.reason,
        retirements
      });
      const mutationId = requiredRecordMutationId(
        recordMutationReceipt.mutationId
      );
      recordMutationReceipt = { mutationId };
      retirements = retirements.map((retirement) => ({
        ...retirement,
        recordMutationId: mutationId
      }));
      assertLiveRotationBaseUnchanged(
        session,
        before,
        expectedGeneration,
        expectedContentRevision
      );
    }
    if (retirements.length) {
      await options.hooks.register(retirements);
      assertLiveRotationBaseUnchanged(
        session,
        before,
        expectedGeneration,
        expectedContentRevision
      );
    }

    await options.hooks.commit(commitInput);
    localCommitCompleted = true;
  } catch (error) {
    commitError = asError(error);
  }

  if (recordMutationReceipt && options.hooks.recordMutation) {
    const commitPromiseResolved = localCommitCompleted;
    try {
      recordMutationState = await options.hooks.recordMutation.settle(
        recordMutationReceipt
      );
    } catch {
      recordMutationState = "awaiting-recovery";
    }
    if (recordMutationState === "committed") {
      localCommitCompleted = true;
    } else if (commitPromiseResolved && recordMutationState === "aborted") {
      recordMutationState = "awaiting-recovery";
    }
  }

  if (!localCommitCompleted) {
    const normalized = commitError
      ?? new Error("Conversation context commit did not complete");
    if (
      retirements.length
      && (
        !recordMutationReceipt
        || recordMutationState === "aborted"
      )
    ) {
      await options.hooks.abort(retirements, normalized).catch(() => undefined);
    }
    throw normalized;
  }

  restorePreparedSession(session, liveCandidate);
  const committedResult = rotationResult(
    liveCandidate,
    targetCommitId,
    retirements,
    "not-required",
    recordMutationReceipt,
    recordMutationState
  );

  if (recordMutationState === "awaiting-recovery") {
    return {
      ...committedResult,
      retirementPromotion: "awaiting-recovery",
      promotionError:
        "RecordMutation Journal terminal is awaiting recovery"
    };
  }
  if (!retirements.length) {
    return committedResult;
  }
  try {
    await options.hooks.promote(retirements);
    return {
      ...committedResult,
      retirementPromotion: "promoted"
    };
  } catch (error) {
    return {
      ...committedResult,
      retirementPromotion: "awaiting-recovery",
      promotionError: asError(error).message
    };
  }
}

function setContextBoundary(
  session: StoredSession,
  options: RotateSessionContextOptions,
  oldLastMessageId: string | undefined
): void {
  const explicit = "contextStartsAfterMessageId" in options;
  const boundary = explicit ? options.contextStartsAfterMessageId : oldLastMessageId;
  if (typeof boundary === "string" && boundary.trim()) {
    session.contextStartsAfterMessageId = boundary.trim();
  } else {
    delete session.contextStartsAfterMessageId;
  }
}

function validateRotationContract(
  session: StoredSession,
  options: RotateSessionContextOptions,
  advanceContext: boolean
): void {
  validateCodexLegacyIdentity(session);
  if (
    (options.reason === "agent-cache-reset" || options.reason === "lease-rollover")
    && options.advanceContext !== false
  ) {
    throw new Error(`${options.reason} must preserve the current context`);
  }
  if (
    (
      options.reason === "legacy-context-bootstrap"
      || options.reason === "start-new-context"
      || options.reason === "workspace-switch"
      || options.reason === "workspace-clear"
    )
    && !advanceContext
  ) {
    throw new Error(`${options.reason} must advance the context`);
  }
  if (
    (options.reason === "legacy-context-bootstrap" || options.reason === "start-new-context")
    && (!("workspace" in options) || !options.workspace)
  ) {
    throw new Error(`${options.reason} requires the current workspace identity`);
  }
  if (
    options.reason === "workspace-switch"
    && (!("workspace" in options) || !options.workspace)
  ) {
    throw new Error("workspace-switch requires a non-empty workspace identity");
  }
  if (
    options.reason === "workspace-clear"
    && (!("workspace" in options) || options.workspace !== null)
  ) {
    throw new Error("workspace-clear requires an explicit null workspace");
  }
  if (options.workspace === null && options.reason !== "workspace-clear") {
    throw new Error("Only workspace-clear may use a null workspace");
  }
  if (
    options.workspace !== undefined
    && options.reason !== "legacy-context-bootstrap"
    && options.reason !== "start-new-context"
    && options.reason !== "workspace-switch"
    && options.reason !== "workspace-clear"
  ) {
    throw new Error(`${options.reason} cannot change workspace identity`);
  }
  if (
    options.reason === "history-restore"
    && (
      !advanceContext
      || !("contextStartsAfterMessageId" in options)
    )
  ) {
    throw new Error("history-restore must advance context with an explicit restored-history boundary");
  }
  if (advanceContext && options.retireBackendIds) {
    const allBackendIds = new Set(backendIdsToInvalidate(session));
    const requestedBackendIds = new Set(
      options.retireBackendIds.map((backendId) => backendId.trim()).filter(Boolean)
    );
    if (
      requestedBackendIds.size !== allBackendIds.size
      || Array.from(allBackendIds).some((backendId) => !requestedBackendIds.has(backendId))
    ) {
      throw new Error("Advancing context must invalidate every backend binding");
    }
  }
}

function validateCodexLegacyIdentity(session: StoredSession): void {
  const legacyThreadId = session.threadId?.trim();
  if (!legacyThreadId) return;
  const binding = session.backendBindings?.["codex-cli"];
  const bindingIds = new Set([
    binding?.nativeThreadId?.trim(),
    binding?.nativeSessionId?.trim(),
    binding?.nativeExecutionRef?.id.trim()
  ].filter((value): value is string => Boolean(value)));
  if (Array.from(bindingIds).some((id) => id !== legacyThreadId)) {
    throw new Error(
      "Conversation recovery required: Codex binding conflicts with legacy threadId"
    );
  }
}

function validatePostMutationContract(
  session: StoredSession,
  before: StoredSession,
  options: RotateSessionContextOptions
): void {
  if (
    session.id !== before.id
    || session.kind !== before.kind
    || session.createdAt !== before.createdAt
  ) {
    throw new Error(
      `${options.reason} cannot mutate immutable Conversation identity`
    );
  }
  if (options.reason === "history-restore") {
    const restoredThroughMessageId = session.messages.at(-1)?.id.trim() || undefined;
    const boundary = typeof options.contextStartsAfterMessageId === "string"
      ? options.contextStartsAfterMessageId.trim() || undefined
      : undefined;
    if (boundary !== restoredThroughMessageId) {
      throw new Error(
        "history-restore boundary must match the last restored message"
      );
    }
  }
  if (
    session.revision !== before.revision
    || session.generation !== before.generation
    || normalizedOptional(session.contextId) !== normalizedOptional(before.contextId)
    || normalizedOptional(session.contextStartsAfterMessageId)
      !== normalizedOptional(before.contextStartsAfterMessageId)
    || normalizedOptional(session.commitId) !== normalizedOptional(before.commitId)
    || normalizedOptional(session.workspaceFingerprint)
      !== normalizedOptional(before.workspaceFingerprint)
    || session.cwd !== before.cwd
  ) {
    throw new Error(
      `${options.reason} cannot mutate context or workspace identity`
    );
  }
  assertRetainedRecordMutationCandidate(session, before, options.reason);
}

function assertRetainedRecordMutationCandidate(
  session: StoredSession,
  before: StoredSession,
  reason: SessionContextRotationReason
): void {
  if (reason !== "start-new-context" && reason !== "agent-cache-reset") {
    return;
  }
  const candidate = cloneSession(session);
  const baseline = cloneSession(before);
  candidate.updatedAt = 0;
  baseline.updatedAt = 0;
  delete candidate.tokenUsage;
  delete baseline.tokenUsage;
  if (reason === "start-new-context") {
    delete candidate.threadId;
    delete baseline.threadId;
    delete candidate.messagesHiddenBefore;
    delete baseline.messagesHiddenBefore;
  }
  if (JSON.stringify(candidate) !== JSON.stringify(baseline)) {
    throw new Error(
      `${reason} must retain durable Conversation records`
    );
  }
}

function assertLiveRotationBaseUnchanged(
  session: StoredSession,
  before: StoredSession,
  expectedGeneration: number,
  expectedContentRevision: string
): void {
  if (
    sessionGeneration(session) !== expectedGeneration
    || normalizedOptional(session.threadId) !== normalizedOptional(before.threadId)
    || createConversationContentRevision(session) !== expectedContentRevision
  ) {
    throw new Error(
      "Conversation changed before context commit while retirement registration was pending"
    );
  }
}

function normalizedOptional(value: string | undefined): string {
  return value?.trim() || "";
}

function requiredIdentity(value: string, label: "commitId" | "contextId"): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Context rotation ${label} factory returned an empty value`);
  return normalized;
}

function requiredRecordMutationId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(
      "Context rotation RecordMutation stage returned an empty mutationId"
    );
  }
  return normalized;
}

function retirementBindings(session: StoredSession): Map<string, BackendSessionBinding> {
  const bindings = new Map(
    Object.entries(session.backendBindings ?? {})
      .filter(([, binding]) => hasNativeExecutionRef(binding))
      .map(([backendId, binding]) => [backendId, cloneBinding(binding)])
  );
  if (session.threadId && !bindings.has("codex-cli")) {
    bindings.set("codex-cli", {
      backendId: "codex-cli",
      nativeThreadId: session.threadId,
      nativeExecutionKind: "thread",
      syncedSessionRevision: session.revision ?? 1,
      ...(session.workspaceFingerprint
        ? { workspaceFingerprint: session.workspaceFingerprint }
        : {}),
      lastUsedAt: session.updatedAt
    });
  }
  return bindings;
}

function backendIdsToInvalidate(session: StoredSession): string[] {
  const backendIds = new Set(Object.keys(session.backendBindings ?? {}));
  if (session.threadId) backendIds.add("codex-cli");
  return Array.from(backendIds);
}

function hasNativeExecutionRef(binding: BackendSessionBinding): boolean {
  return Boolean(
    binding.nativeThreadId?.trim()
    || binding.nativeSessionId?.trim()
    || binding.nativeExecutionRef?.id.trim()
  );
}

function removeRetiredBindings(session: StoredSession, backendIds: Set<string>): void {
  if (session.backendBindings) {
    const remaining = Object.fromEntries(
      Object.entries(session.backendBindings)
        .filter(([backendId]) => !backendIds.has(backendId))
    );
    if (Object.keys(remaining).length) session.backendBindings = remaining;
    else delete session.backendBindings;
  }
  if (backendIds.has("codex-cli")) delete session.threadId;
}

function rotationResult(
  session: StoredSession,
  commitId: string,
  retirements: SessionContextRetirement[],
  retirementPromotion: SessionContextRotationResult["retirementPromotion"],
  recordMutationReceipt: SessionContextRecordMutationReceipt | null,
  recordMutationState:
    | "committed"
    | "aborted"
    | "awaiting-recovery"
    | null
): SessionContextRotationResult {
  return {
    committed: true,
    conversationId: session.id,
    generation: sessionGeneration(session),
    ...(session.contextId ? { contextId: session.contextId } : {}),
    commitId,
    retirements,
    ...(recordMutationReceipt
      ? { recordMutationId: recordMutationReceipt.mutationId }
      : {}),
    ...(recordMutationState === "committed"
      ? { recordMutationState: "committed" as const }
      : recordMutationState === "awaiting-recovery"
        ? { recordMutationState: "awaiting-recovery" as const }
        : {}),
    retirementPromotion
  };
}

function cloneSession(session: StoredSession): StoredSession {
  return JSON.parse(JSON.stringify(session)) as StoredSession;
}

function cloneBinding(binding: BackendSessionBinding): BackendSessionBinding {
  return JSON.parse(JSON.stringify(binding)) as BackendSessionBinding;
}

function restorePreparedSession(target: StoredSession, source: StoredSession): void {
  for (const key of Object.keys(target) as Array<keyof StoredSession>) {
    delete target[key];
  }
  Object.assign(target, source);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
