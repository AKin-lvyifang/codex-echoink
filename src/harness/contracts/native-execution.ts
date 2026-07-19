export type HistoryAuthority = "echoink" | "backend" | "hybrid";

export type NativeExecutionKind = "thread" | "session" | "run" | "process";

export type NativeExecutionPersistence = "none" | "process-local" | "provider-persistent" | "unknown";

export const NATIVE_EXECUTION_TRANSPORT_MAX_LENGTH = 96;

export function isSafeNativeExecutionTransport(
  value: unknown
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= NATIVE_EXECUTION_TRANSPORT_MAX_LENGTH
    && value === value.trim()
    && /^[a-z][a-z0-9]*(?:[._+-][a-z0-9]+)*$/i.test(value);
}

export type NativeExecutionMode = "ephemeral-run" | "leased-conversation" | "persistent-native";

export type NativeDisposition = "process-exit" | "archive" | "delete" | "retain";

export const ECHOINK_HOST_EXECUTION_BACKEND_ID = "echoink-host";
export const HERMES_PROPOSAL_HOST_TRANSPORT = "hermes-proposal-v1";

export type NativeExecutionIdentityAuthority = "backend" | "echoink-host";

/**
 * EchoInk-owned launch identity used when a backend cannot expose a real
 * thread/session/run identity before the prompt crosses the process boundary.
 *
 * This is deliberately not a Hermes session or run ID. It names one child
 * process launch owned by EchoInk and records that no backend-owned identity
 * was available at the registration barrier.
 */
export interface EchoInkHostExecutionIdentity {
  version: 1;
  owner: "echoink-host";
  executionId: string;
  targetBackendId: string;
  transport: string;
  attemptId: string;
  backendNativeIdentity: "unavailable-before-prompt";
  createdAt: number;
}

/**
 * Durable host-side proof that the EchoInk-owned process identity can no
 * longer name a live child. This receipt is intentionally orthogonal to the
 * product local-commit state: it may be recorded while `localCommit=pending`,
 * but it never authorizes product settlement by itself.
 */
export interface EchoInkHostProcessDispositionReceipt {
  version: 1;
  owner: "echoink-host";
  executionId: string;
  disposition: "process-exit";
  state: "not-started" | "exited";
  observedAt: number;
}

export interface NativeExecutionRef {
  backendId: string;
  id: string;
  kind: NativeExecutionKind;
  persistence: NativeExecutionPersistence;
  /**
   * Backend-reported transport that issued the Native identity. Legacy refs
   * omit this audit metadata and remain valid. New values must satisfy
   * isSafeNativeExecutionTransport() before registration or replay.
   */
  transport?: string;
  /**
   * Omitted legacy refs are backend-owned. New host-owned refs must persist
   * the complete `hostExecution` contract below.
   */
  identityAuthority?: NativeExecutionIdentityAuthority;
  hostExecution?: EchoInkHostExecutionIdentity;
  providerEndpoint?: string;
  deviceKey: string;
  vaultId: string;
  createdAt: number;
}

export interface NativeSessionPolicy {
  historyAuthority: HistoryAuthority;
  mode: NativeExecutionMode;
  preferredDisposition: NativeDisposition[];
  retainWhenLocalCommitFails: boolean;
  cleanupRequiredForTaskSuccess: false;
}

export interface NativeExecutionCapabilities {
  persistence: NativeExecutionPersistence;
  dispositions: {
    processExit: boolean;
    archive: boolean;
    delete: boolean;
  };
  idempotentDisposition: boolean;
  canInspectExistence: boolean;
}

export interface NativeExecutionDispositionRequest {
  ref: NativeExecutionRef;
  requested: NativeDisposition;
  reason: "knowledge-run-completed" | "knowledge-run-failed" | "knowledge-run-cancelled" | "recovery" | "manual";
}

export interface NativeExecutionDispositionResult {
  outcome: "disposed" | "already-disposed" | "retained" | "unsupported" | "failed";
  applied?: NativeDisposition;
  message?: string;
}

export interface LocalRunCommitResult {
  committed: boolean;
  conversationCommitted: boolean;
  runLedgerCommitted: boolean;
  artifactsCommitted: boolean;
  historyIndexCommitted: boolean;
  error?: string;
}

export type NativeRunOutcome = "success" | "failed" | "cancelled";

export type NativeLocalCommitStatus = "pending" | "committed" | "failed";

/**
 * Durable authority that must be proven before an ephemeral Native execution
 * can be promoted from `localCommit=pending` into provider cleanup.
 *
 * Memory Curator runs deliberately point at the formal Memory transaction
 * identity instead of treating their Run Ledger terminal as the business
 * commit. The authority receipt itself is resolved from the Memory Store at
 * settlement/recovery time and is not copied into this record.
 */
export interface NativeMemoryTransactionCommitAuthority {
  kind: "memory-transaction";
  transactionId: string;
}

export type NativeLocalCommitAuthority =
  NativeMemoryTransactionCommitAuthority;

interface MemoryTransactionAuthorityReceiptBase {
  kind: "memory-transaction";
  transactionId: string;
  durable: true;
  revision: number;
}

/**
 * Formal Memory Store proof used to settle a deferred Memory Curator Native
 * execution. This is an internal lifecycle receipt, not part of the stable
 * Memory Curator result schema.
 */
export type MemoryTransactionAuthorityReceipt =
  | (MemoryTransactionAuthorityReceiptBase & {
    state: "committed";
    outcome: "write" | "no-op";
  })
  | (MemoryTransactionAuthorityReceiptBase & {
    state: "durable-pending";
    outcome: "pending";
    error: string;
  })
  | (MemoryTransactionAuthorityReceiptBase & {
    state: "durable-failed";
    outcome: "failed";
    error: string;
  });

export type NativeCleanupStatus =
  | "not-needed"
  | "awaiting-local-commit"
  | "pending"
  | "disposing"
  | "disposed"
  | "unsupported"
  | "failed"
  | "retained-for-recovery"
  | "retained"
  | "aborted"
  | "quarantined";

/**
 * Durable proof target for retiring a Conversation backend binding.
 *
 * The lifecycle layer may promote an awaiting retirement only after the
 * Conversation Store proves this exact generation and commit identity.
 */
export interface NativeBindingRetirement {
  recordMutationId?: string;
  targetConversationId: string;
  sourceGeneration?: number;
  sourceCommitId?: string | null;
  sourceContextId?: string | null;
  sourceWorkspaceFingerprint?: string | null;
  targetGeneration: number;
  targetCommitId: string;
  targetContextId?: string;
  targetWorkspaceFingerprint?: string;
  reason: string;
}

export type NativeRetirementSourceIdentityState =
  | "legacy"
  | "complete"
  | "invalid";

/**
 * Legacy retirements have no source fields at all. New retirements persist all
 * four fields; nullable values are explicit proof that an optional
 * Conversation identity component was absent. Any mixed representation is
 * ambiguous and must fail closed.
 */
export function nativeRetirementSourceIdentityState(
  value: unknown
): NativeRetirementSourceIdentityState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "invalid";
  }
  const source = value as Record<string, unknown>;
  const fields = [
    "sourceGeneration",
    "sourceCommitId",
    "sourceContextId",
    "sourceWorkspaceFingerprint"
  ] as const;
  const presentCount = fields.filter((field) =>
    Object.prototype.hasOwnProperty.call(source, field)
  ).length;
  if (presentCount === 0) return "legacy";
  if (presentCount !== fields.length) return "invalid";
  if (
    !Number.isSafeInteger(source.sourceGeneration)
    || (source.sourceGeneration as number) <= 0
  ) {
    return "invalid";
  }
  return [
    source.sourceCommitId,
    source.sourceContextId,
    source.sourceWorkspaceFingerprint
  ].every((part) =>
    part === null
    || (typeof part === "string" && Boolean(part.trim()))
  )
    ? "complete"
    : "invalid";
}

export interface NativeExecutionRecord {
  id: string;
  runId: string;
  sessionId: string;
  surface: "knowledge" | "editor" | "review" | "chat" | "system";
  workflow: string;
  native: NativeExecutionRef;
  policy: NativeSessionPolicy;
  localCommitAuthority?: NativeLocalCommitAuthority;
  observedDisposition?: EchoInkHostProcessDispositionReceipt;
  runOutcome?: NativeRunOutcome;
  localCommit: NativeLocalCommitStatus;
  cleanup: NativeCleanupStatus;
  requestedDisposition?: NativeDisposition;
  appliedDisposition?: NativeDisposition;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  createdAt: number;
  settledAt: number;
  committedAt: number;
  disposedAt: number;
  cleanupStartedAt?: number;
  quarantinedAt?: number;
  retirement?: NativeBindingRetirement;
  emitEvents?: boolean;
  dispositionReason?: NativeExecutionDispositionRequest["reason"];
}

/**
 * A leased Conversation execution may reach provider cleanup only through a
 * durable binding retirement. Missing evidence stays readable as recovery
 * state so startup can quarantine it, but it is never executable cleanup.
 */
export function isNativeCleanupAuthorityEvidenceMissing(
  record: NativeExecutionRecord
): boolean {
  return record.policy.mode === "leased-conversation"
    && record.retirement === undefined
    && record.localCommit === "committed"
    && (
      record.cleanup === "pending"
      || record.cleanup === "disposing"
      || record.cleanup === "failed"
    );
}

export function nativeCleanupAuthorityEvidenceMissingReason(recordId: string): string {
  return (
    "Native leased-conversation cleanup authority is missing durable retirement evidence: "
    + recordId
  );
}

export interface NativeSessionLease {
  leaseId: string;
  echoInkSessionId: string;
  backendId: string;
  native: NativeExecutionRef;
  mode: "leased-conversation";
  status: "active" | "expired" | "cleanup-pending" | "disposed" | "failed";
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  turnCount: number;
  maxTurns: number;
  contextCheckpointMessageId?: string;
  providerContextWindow?: number;
  contextChars?: number;
  maxContextChars?: number;
}

export function hasTrustedNativeExecutionIdentity(ref: NativeExecutionRef): boolean {
  if (!hasValidNativeExecutionIdentityContract(ref)) return false;
  if (
    !knownIdentityPart(ref.backendId)
    || !knownIdentityPart(ref.id)
    || !knownIdentityPart(ref.deviceKey)
    || !knownIdentityPart(ref.vaultId)
  ) {
    return false;
  }
  if (ref.backendId === "opencode" || ref.backendId === "hermes") {
    return knownIdentityPart(ref.providerEndpoint);
  }
  return true;
}

export function hasValidNativeExecutionIdentityContract(
  ref: NativeExecutionRef
): boolean {
  const authority = ref.identityAuthority ?? "backend";
  if (authority === "backend") return ref.hostExecution === undefined;
  if (authority !== "echoink-host") return false;
  const host = ref.hostExecution;
  return Boolean(
    host
    && host.version === 1
    && host.owner === "echoink-host"
    && ref.backendId === ECHOINK_HOST_EXECUTION_BACKEND_ID
    && ref.kind === "process"
    && ref.persistence === "process-local"
    && host.executionId === ref.id
    && knownIdentityPart(host.executionId)
    && knownIdentityPart(host.targetBackendId)
    && knownIdentityPart(host.transport)
    && knownIdentityPart(host.attemptId)
    && host.backendNativeIdentity === "unavailable-before-prompt"
    && Number.isSafeInteger(host.createdAt)
    && host.createdAt >= 0
    && host.createdAt === ref.createdAt
  );
}

export function isHermesProposalHostExecutionRef(
  ref: NativeExecutionRef
): boolean {
  return hasValidNativeExecutionIdentityContract(ref)
    && ref.identityAuthority === "echoink-host"
    && ref.hostExecution?.targetBackendId === "hermes"
    && ref.hostExecution.transport === HERMES_PROPOSAL_HOST_TRANSPORT;
}

export function isValidEchoInkHostProcessDispositionReceipt(
  ref: NativeExecutionRef,
  receipt: EchoInkHostProcessDispositionReceipt
): boolean {
  return hasValidNativeExecutionIdentityContract(ref)
    && ref.identityAuthority === "echoink-host"
    && receipt.version === 1
    && receipt.owner === "echoink-host"
    && receipt.executionId === ref.id
    && receipt.disposition === "process-exit"
    && (
      receipt.state === "not-started"
      || receipt.state === "exited"
    )
    && Number.isSafeInteger(receipt.observedAt)
    && receipt.observedAt >= ref.createdAt;
}

function knownIdentityPart(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return Boolean(normalized && normalized !== "unknown");
}
