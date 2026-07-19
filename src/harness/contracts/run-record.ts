import { createHash } from "node:crypto";
import type {
  HarnessEvent,
  HarnessEventSource,
  HarnessEventType,
  HarnessProcessEventData,
  HarnessRunUsage
} from "./event";
import type { NativeCleanupStatus } from "./native-execution";

export const RUN_RECORD_SCHEMA_VERSION = 1 as const;
export const RUN_RECORD_DAY_MS = 24 * 60 * 60 * 1000;
export const RUN_RECORD_DEFAULT_PAYLOAD_RETENTION_DAYS = 30;
export const RUN_RECORD_DEFAULT_SUMMARY_RETENTION_DAYS = 90;
export const RUN_RECORD_MAX_PAYLOAD_EVENT_COUNT = 100_000;
export const RUN_RECORD_MAX_PAYLOAD_EVENT_LINE_BYTES = 4 * 1024 * 1024;
export const RUN_RECORD_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export const RUN_RECORD_ERROR_CODES = Object.freeze([
  "none",
  "backend-unavailable",
  "process-exited",
  "process-crashed",
  "permission-denied",
  "timeout",
  "cancelled",
  "contract-invalid",
  "local-commit-failed",
  "cleanup-failed",
  "unknown"
] as const);

export const RUN_RECORD_REASON_CODES = Object.freeze([
  "none",
  "cleanup-completed",
  "cleanup-not-needed",
  "cleanup-unsupported",
  "cleanup-retained",
  "cleanup-failed",
  "cleanup-quarantined",
  "failed-before-payload",
  "capture-disabled",
  "no-attempt-required",
  "policy-expired",
  "user-deleted",
  "manual-review"
] as const);

export const RUN_RECORD_RETENTION_HOLD_REASONS = Object.freeze([
  "run-active",
  "payload-unsealed",
  "local-commit-pending",
  "local-commit-recovery-required",
  "wal-present",
  "wal-blocked",
  "cleanup-pending",
  "cleanup-failed",
  "cleanup-quarantined",
  "artifact-lineage-pending",
  "record-missing",
  "record-corrupt",
  "future-schema",
  "manual-hold"
] as const);

export type RunRecordErrorCode = typeof RUN_RECORD_ERROR_CODES[number];
export type RunRecordReasonCode = typeof RUN_RECORD_REASON_CODES[number];
export type RunRecordRetentionHoldReason =
  typeof RUN_RECORD_RETENTION_HOLD_REASONS[number];

export type RunRecordContractErrorCode =
  | "invalid-envelope"
  | "unsupported-schema"
  | "future-schema"
  | "unexpected-field"
  | "invalid-value"
  | "digest-mismatch";

export class RunRecordContractError extends Error {
  constructor(
    public readonly code: RunRecordContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RunRecordContractError";
  }
}

export type RunRecordSurface =
  | "chat"
  | "knowledge"
  | "editor"
  | "review"
  | "system";

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "partial"
  | "recovery-required";

export type AttemptRunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovery-required";

export type RunRecordLocalMutationState =
  | "not-required"
  | "pending"
  | "committed"
  | "aborted"
  | "recovery-required";

export interface RunRecordLocalMutation {
  state: RunRecordLocalMutationState;
  transactionId?: string;
  committedAt?: number;
}

export interface RunRecordRetentionMetadata {
  summaryExpiresAt?: number;
  holdReasons: RunRecordRetentionHoldReason[];
}

export interface WorkflowRunAttemptRef {
  attemptId: string;
  ordinal: number;
}

export type WorkflowArtifactKind =
  | "markdown-report"
  | "ui-card"
  | "tracker"
  | "history"
  | "wiki"
  | "editor-change"
  | "other";

export interface WorkflowRunArtifactRef {
  artifactId: string;
  kind: WorkflowArtifactKind;
}

export interface WorkflowRunConversationRef {
  conversationId: string;
  contextId?: string;
  turnId?: string;
}

export interface WorkflowRunSummaryV1 {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  recordType: "workflow-run-summary";
  workflowRunId: string;
  surface: RunRecordSurface;
  workflow: string;
  conversationRef?: WorkflowRunConversationRef;
  status: WorkflowRunStatus;
  startedAt: number;
  terminalAt?: number;
  usage?: HarnessRunUsage;
  attemptRefs: WorkflowRunAttemptRef[];
  artifactRefs: WorkflowRunArtifactRef[];
  errorCode?: RunRecordErrorCode;
  localMutation: RunRecordLocalMutation;
  retention: RunRecordRetentionMetadata;
  revision: number;
  digest: string;
}

export interface AttemptRunLocalCommit {
  state: RunRecordLocalMutationState;
  authorityKind?: string;
  committedAt?: number;
}

export interface AttemptRunCleanup {
  status: NativeCleanupStatus;
  attempts: number;
  nextAttemptAt?: number;
  settledAt?: number;
  quarantinedAt?: number;
  reasonCode?: RunRecordReasonCode;
}

export interface AttemptRunPayloadRef {
  expected: boolean;
  expiresAt?: number;
  manifestRef?: string;
}

export interface AttemptRunSummaryV1 {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  recordType: "attempt-run-summary";
  workflowRunId: string;
  attemptId: string;
  ordinal: number;
  harnessRunId: string;
  backendId: string;
  nativeExecutionRecordIds: string[];
  status: AttemptRunStatus;
  startedAt: number;
  terminalAt?: number;
  usage?: HarnessRunUsage;
  errorCode?: RunRecordErrorCode;
  reasonCode?: RunRecordReasonCode;
  localCommit: AttemptRunLocalCommit;
  cleanup: AttemptRunCleanup;
  payload: AttemptRunPayloadRef;
  retention: RunRecordRetentionMetadata;
  revision: number;
  digest: string;
}

export interface AttemptPayloadManifestV1 {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  recordType: "attempt-payload-manifest";
  workflowRunId: string;
  attemptId: string;
  harnessRunId: string;
  subjectDigest: string;
  eventSchemaVersion: 1;
  state: "sealed";
  createdAt: number;
  terminalAt: number;
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  byteCount: number;
  payloadSha256: string;
  expiresAt: number;
  revision: number;
  digest: string;
}

/**
 * Strict V1 detailed-event envelope. The duplicated `harnessRunId/runId`
 * equality is intentional: it prevents a valid event body from being moved
 * beneath a different Attempt identity during side-by-side migration.
 */
export interface AttemptHarnessEventV1 {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  recordType: "attempt-harness-event";
  workflowRunId: string;
  attemptId: string;
  harnessRunId: string;
  eventId: string;
  runId: string;
  sequence: number;
  createdAt: number;
  source: HarnessEventSource;
  type: HarnessEventType;
  backendId?: string;
  text?: string;
  title?: string;
  status?: string;
  toolName?: string;
  resourceId?: string;
  error?: string;
  data?: HarnessProcessEventData;
}

export type RunRetentionTombstoneScope =
  | "attempt-payload"
  | "attempt-summary"
  | "workflow-summary";

export interface RunRetentionTombstonePrior {
  schemaVersion: number;
  digest: string;
  eventCount?: number;
  byteCount?: number;
  terminalAt: number;
}

export interface RunRetentionTombstonePolicy {
  version: 1;
  retentionDays: number;
}

export interface RunRetentionTombstoneV1 {
  schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  recordType: "run-retention-tombstone";
  scope: RunRetentionTombstoneScope;
  workflowRunId: string;
  attemptId?: string;
  harnessRunId?: string;
  subjectDigest: string;
  reasonCode: "policy-expired" | "user-deleted";
  eligibleAt: number;
  expiredAt: number;
  prior: RunRetentionTombstonePrior;
  policy: RunRetentionTombstonePolicy;
  retentionTransactionId: string;
  committedAt: number;
  revision: number;
  digest: string;
}

export type RunRecordRetentionDecision =
  | "not-terminal"
  | "forever"
  | "retained"
  | "held"
  | "eligible";

export interface RunRecordRetentionPreview {
  decision: RunRecordRetentionDecision;
  eligible: boolean;
  expiresAt: number | null;
  holdReasons: RunRecordRetentionHoldReason[];
}

export interface RunRecordRetentionPreviewInput {
  scope: RunRetentionTombstoneScope;
  terminalAt?: number;
  retentionDays?: number;
  now: number;
  holdReasons: readonly RunRecordRetentionHoldReason[];
}

type WorkflowRunSummaryInput = Omit<WorkflowRunSummaryV1, "digest">;
type AttemptRunSummaryInput = Omit<AttemptRunSummaryV1, "digest">;
type RetentionTombstoneInput = Omit<RunRetentionTombstoneV1, "digest">;

const ERROR_CODES = new Set<string>(RUN_RECORD_ERROR_CODES);
const REASON_CODES = new Set<string>(RUN_RECORD_REASON_CODES);
const HOLD_REASONS = new Set<string>(RUN_RECORD_RETENTION_HOLD_REASONS);
const SURFACES = new Set<RunRecordSurface>([
  "chat",
  "knowledge",
  "editor",
  "review",
  "system"
]);
const WORKFLOW_STATUSES = new Set<WorkflowRunStatus>([
  "running",
  "completed",
  "failed",
  "cancelled",
  "partial",
  "recovery-required"
]);
const ATTEMPT_STATUSES = new Set<AttemptRunStatus>([
  "created",
  "running",
  "completed",
  "failed",
  "cancelled",
  "recovery-required"
]);
const LOCAL_MUTATION_STATES = new Set<RunRecordLocalMutationState>([
  "not-required",
  "pending",
  "committed",
  "aborted",
  "recovery-required"
]);
const ARTIFACT_KINDS = new Set<WorkflowArtifactKind>([
  "markdown-report",
  "ui-card",
  "tracker",
  "history",
  "wiki",
  "editor-change",
  "other"
]);
const CLEANUP_STATUSES = new Set<NativeCleanupStatus>([
  "not-needed",
  "awaiting-local-commit",
  "pending",
  "disposing",
  "disposed",
  "unsupported",
  "failed",
  "retained-for-recovery",
  "retained",
  "aborted",
  "quarantined"
]);
const TOMBSTONE_SCOPES = new Set<RunRetentionTombstoneScope>([
  "attempt-payload",
  "attempt-summary",
  "workflow-summary"
]);
const EVENT_SOURCES = new Set<HarnessEventSource>([
  "kernel",
  "agent",
  "workflow",
  "tool",
  "memory"
]);
const EVENT_TYPES = new Set<HarnessEventType>([
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.local_commit.started",
  "run.local_commit.completed",
  "run.local_commit.failed",
  "run.surface_terminal.ignored",
  "session.context.snapshot.updated",
  "session.context.bootstrap.compiled",
  "agent.connecting",
  "agent.connected",
  "agent.native_execution.created",
  "agent.native_lease.created",
  "agent.native_lease.reused",
  "agent.native_lease.expired",
  "agent.native_lease.recovery_failed",
  "agent.native_cleanup.scheduled",
  "agent.native_cleanup.started",
  "agent.native_cleanup.completed",
  "agent.native_cleanup.unsupported",
  "agent.native_cleanup.failed",
  "agent.native_cleanup.retained",
  "agent.native_cleanup.quarantined",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.started",
  "agent.reasoning.summary.delta",
  "agent.reasoning.summary.completed",
  "agent.thinking.delta",
  "agent.thinking.completed",
  "agent.plan.updated",
  "tool.requested",
  "tool.approval.requested",
  "tool.approval.resolved",
  "tool.started",
  "tool.output.delta",
  "tool.completed",
  "tool.failed",
  "file.change.proposed",
  "file.change.applied",
  "file.change.reverted",
  "usage.updated",
  "adapter.fallback.started",
  "workflow.started",
  "workflow.phase.started",
  "workflow.phase.progress",
  "workflow.phase.completed",
  "workflow.phase.failed",
  "workflow.validation.started",
  "workflow.validation.result",
  "workflow.transaction.snapshot",
  "workflow.transaction.committed",
  "workflow.transaction.rolled_back",
  "workflow.artifact.created",
  "workflow.report.ready",
  "workflow.completed"
]);
const POST_TERMINAL_EVENT_TYPES = new Set<HarnessEventType>([
  "run.local_commit.started",
  "run.local_commit.completed",
  "run.local_commit.failed",
  "run.surface_terminal.ignored",
  "agent.native_cleanup.scheduled",
  "agent.native_cleanup.started",
  "agent.native_cleanup.completed",
  "agent.native_cleanup.unsupported",
  "agent.native_cleanup.failed",
  "agent.native_cleanup.retained",
  "agent.native_cleanup.quarantined"
]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function finalizeWorkflowRunSummary(
  input: WorkflowRunSummaryInput
): WorkflowRunSummaryV1 {
  const record = withCanonicalDigest(input);
  return validateWorkflowRunSummary(record);
}

export function finalizeAttemptRunSummary(
  input: AttemptRunSummaryInput
): AttemptRunSummaryV1 {
  const record = withCanonicalDigest(input);
  return validateAttemptRunSummary(record);
}

export function buildAttemptPayloadManifest(
  input: {
    workflowRunId: string;
    attemptId: string;
    harnessRunId: string;
    createdAt: number;
    revision: number;
    retentionDays?: number;
  },
  events: readonly AttemptHarnessEventV1[]
): AttemptPayloadManifestV1 {
  const eventBytes = serializeAttemptPayloadEvents(events, {
    workflowRunId: input.workflowRunId,
    attemptId: input.attemptId,
    harnessRunId: input.harnessRunId
  });
  const terminal = events
    .map((event) => validateAttemptHarnessEvent(event))
    .find((event) => isAttemptTerminalEventType(event.type));
  if (!terminal) throw invalidValue("Attempt payload requires a terminal event");
  const retentionDays = input.retentionDays
    ?? RUN_RECORD_DEFAULT_PAYLOAD_RETENTION_DAYS;
  assertRetentionDays(retentionDays, "retentionDays");
  if (retentionDays === 0) {
    throw invalidValue("Payload manifest requires a finite positive retentionDays");
  }
  const expiresAt = terminal.createdAt + retentionDays * RUN_RECORD_DAY_MS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw invalidValue("Payload expiry exceeds safe timestamp range");
  }
  const sequences = events.map((event) => event.sequence);
  const manifest = withCanonicalDigest({
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    recordType: "attempt-payload-manifest",
    workflowRunId: input.workflowRunId,
    attemptId: input.attemptId,
    harnessRunId: input.harnessRunId,
    subjectDigest: runRecordSubjectDigest(
      "attempt-payload",
      input.workflowRunId,
      input.attemptId,
      input.harnessRunId
    ),
    eventSchemaVersion: 1,
    state: "sealed",
    createdAt: input.createdAt,
    terminalAt: terminal.createdAt,
    firstSequence: sequences[0],
    lastSequence: sequences[sequences.length - 1],
    eventCount: events.length,
    byteCount: Buffer.byteLength(eventBytes),
    payloadSha256: sha256(eventBytes),
    expiresAt,
    revision: input.revision
  });
  return validateAttemptPayloadManifest(manifest);
}

export function finalizeRetentionTombstone(
  input: RetentionTombstoneInput
): RunRetentionTombstoneV1 {
  const record = withCanonicalDigest(input);
  return validateRetentionTombstone(record);
}

export function validateWorkflowRunSummary(
  value: unknown
): WorkflowRunSummaryV1 {
  const record = requireEnvelope(value, "workflow-run-summary", [
    "schemaVersion",
    "recordType",
    "workflowRunId",
    "surface",
    "workflow",
    "conversationRef",
    "status",
    "startedAt",
    "terminalAt",
    "usage",
    "attemptRefs",
    "artifactRefs",
    "errorCode",
    "localMutation",
    "retention",
    "revision",
    "digest"
  ]);
  requireSafeText(record.workflowRunId, "workflowRunId", 512);
  if (!SURFACES.has(record.surface as RunRecordSurface)) {
    throw invalidValue("surface is invalid");
  }
  requireSafeText(record.workflow, "workflow", 160);
  if (record.conversationRef !== undefined) {
    const conversationRef = requireExactObject(
      record.conversationRef,
      "conversationRef",
      ["conversationId", "contextId", "turnId"]
    );
    requireSafeText(
      conversationRef.conversationId,
      "conversationRef.conversationId",
      512
    );
    optionalSafeText(
      conversationRef.contextId,
      "conversationRef.contextId",
      512
    );
    optionalSafeText(
      conversationRef.turnId,
      "conversationRef.turnId",
      512
    );
  }
  if (!WORKFLOW_STATUSES.has(record.status as WorkflowRunStatus)) {
    throw invalidValue("workflow status is invalid");
  }
  const startedAt = requireTimestamp(record.startedAt, "startedAt");
  const terminalAt = optionalTimestamp(record.terminalAt, "terminalAt");
  if (terminalAt !== undefined && terminalAt < startedAt) {
    throw invalidValue("terminalAt precedes startedAt");
  }
  if (
    (record.status === "running") !== (terminalAt === undefined)
  ) {
    throw invalidValue("workflow status and terminalAt are inconsistent");
  }
  validateUsage(record.usage);
  const attemptRefs = requireArray(record.attemptRefs, "attemptRefs");
  const attemptIds = new Set<string>();
  const ordinals = new Set<number>();
  for (const [index, item] of attemptRefs.entries()) {
    const ref = requireExactObject(item, `attemptRefs[${index}]`, [
      "attemptId",
      "ordinal"
    ]);
    const attemptId = requireSafeText(
      ref.attemptId,
      `attemptRefs[${index}].attemptId`,
      512
    );
    const ordinal = requirePositiveInteger(
      ref.ordinal,
      `attemptRefs[${index}].ordinal`
    );
    if (attemptIds.has(attemptId) || ordinals.has(ordinal)) {
      throw invalidValue("attemptRefs contain duplicate identity");
    }
    attemptIds.add(attemptId);
    ordinals.add(ordinal);
  }
  const artifactRefs = requireArray(record.artifactRefs, "artifactRefs");
  const artifactIds = new Set<string>();
  for (const [index, item] of artifactRefs.entries()) {
    const ref = requireExactObject(item, `artifactRefs[${index}]`, [
      "artifactId",
      "kind"
    ]);
    const artifactId = requireSafeText(
      ref.artifactId,
      `artifactRefs[${index}].artifactId`,
      512
    );
    if (!ARTIFACT_KINDS.has(ref.kind as WorkflowArtifactKind)) {
      throw invalidValue(`artifactRefs[${index}].kind is invalid`);
    }
    if (artifactIds.has(artifactId)) {
      throw invalidValue("artifactRefs contain duplicate artifactId");
    }
    artifactIds.add(artifactId);
  }
  validateErrorCode(record.errorCode, "errorCode");
  validateLocalMutation(record.localMutation, "localMutation");
  validateRetentionMetadata(record.retention, "retention");
  requireRevision(record.revision);
  validateRecordDigest(record);
  return record as unknown as WorkflowRunSummaryV1;
}

export function validateAttemptRunSummary(
  value: unknown
): AttemptRunSummaryV1 {
  const record = requireEnvelope(value, "attempt-run-summary", [
    "schemaVersion",
    "recordType",
    "workflowRunId",
    "attemptId",
    "ordinal",
    "harnessRunId",
    "backendId",
    "nativeExecutionRecordIds",
    "status",
    "startedAt",
    "terminalAt",
    "usage",
    "errorCode",
    "reasonCode",
    "localCommit",
    "cleanup",
    "payload",
    "retention",
    "revision",
    "digest"
  ]);
  requireSafeText(record.workflowRunId, "workflowRunId", 512);
  requireSafeText(record.attemptId, "attemptId", 512);
  requirePositiveInteger(record.ordinal, "ordinal");
  requireSafeText(record.harnessRunId, "harnessRunId", 512);
  requireSafeText(record.backendId, "backendId", 160);
  const nativeIds = requireArray(
    record.nativeExecutionRecordIds,
    "nativeExecutionRecordIds"
  ).map((item, index) =>
    requireSafeText(item, `nativeExecutionRecordIds[${index}]`, 2048)
  );
  if (new Set(nativeIds).size !== nativeIds.length) {
    throw invalidValue("nativeExecutionRecordIds contain duplicates");
  }
  if (!ATTEMPT_STATUSES.has(record.status as AttemptRunStatus)) {
    throw invalidValue("attempt status is invalid");
  }
  const startedAt = requireTimestamp(record.startedAt, "startedAt");
  const terminalAt = optionalTimestamp(record.terminalAt, "terminalAt");
  if (terminalAt !== undefined && terminalAt < startedAt) {
    throw invalidValue("terminalAt precedes startedAt");
  }
  if (
    (record.status === "created" || record.status === "running")
      !== (terminalAt === undefined)
  ) {
    throw invalidValue("attempt status and terminalAt are inconsistent");
  }
  validateUsage(record.usage);
  validateErrorCode(record.errorCode, "errorCode");
  validateReasonCode(record.reasonCode, "reasonCode");
  validateLocalCommit(record.localCommit);
  validateCleanup(record.cleanup);
  validatePayloadRef(record.payload);
  validateRetentionMetadata(record.retention, "retention");
  requireRevision(record.revision);
  validateRecordDigest(record);
  return record as unknown as AttemptRunSummaryV1;
}

export function validateAttemptPayloadManifest(
  value: unknown
): AttemptPayloadManifestV1 {
  const record = requireEnvelope(value, "attempt-payload-manifest", [
    "schemaVersion",
    "recordType",
    "workflowRunId",
    "attemptId",
    "harnessRunId",
    "subjectDigest",
    "eventSchemaVersion",
    "state",
    "createdAt",
    "terminalAt",
    "firstSequence",
    "lastSequence",
    "eventCount",
    "byteCount",
    "payloadSha256",
    "expiresAt",
    "revision",
    "digest"
  ]);
  const workflowRunId = requireSafeText(
    record.workflowRunId,
    "workflowRunId",
    512
  );
  const attemptId = requireSafeText(record.attemptId, "attemptId", 512);
  const harnessRunId = requireSafeText(
    record.harnessRunId,
    "harnessRunId",
    512
  );
  const expectedSubject = runRecordSubjectDigest(
    "attempt-payload",
    workflowRunId,
    attemptId,
    harnessRunId
  );
  if (record.subjectDigest !== expectedSubject) {
    throw invalidValue("subjectDigest does not match payload identity");
  }
  if (record.eventSchemaVersion !== 1 || record.state !== "sealed") {
    throw invalidValue("payload schema or state is invalid");
  }
  const createdAt = requireTimestamp(record.createdAt, "createdAt");
  const terminalAt = requireTimestamp(record.terminalAt, "terminalAt");
  if (terminalAt < createdAt) {
    throw invalidValue("terminalAt precedes createdAt");
  }
  const firstSequence = requirePositiveInteger(
    record.firstSequence,
    "firstSequence"
  );
  const lastSequence = requirePositiveInteger(
    record.lastSequence,
    "lastSequence"
  );
  const eventCount = requirePositiveInteger(record.eventCount, "eventCount");
  if (
    firstSequence !== 1
    || lastSequence !== eventCount
  ) {
    throw invalidValue("payload sequence range is not contiguous from one");
  }
  requireNonNegativeInteger(record.byteCount, "byteCount");
  requireSha256(record.payloadSha256, "payloadSha256");
  const expiresAt = requireTimestamp(record.expiresAt, "expiresAt");
  if (expiresAt <= terminalAt) {
    throw invalidValue("expiresAt must follow terminalAt");
  }
  requireRevision(record.revision);
  validateRecordDigest(record);
  return record as unknown as AttemptPayloadManifestV1;
}

export function validateAttemptHarnessEvent(
  value: unknown
): AttemptHarnessEventV1 {
  const record = requireEnvelope(value, "attempt-harness-event", [
    "schemaVersion",
    "recordType",
    "workflowRunId",
    "attemptId",
    "harnessRunId",
    "eventId",
    "runId",
    "sequence",
    "createdAt",
    "source",
    "type",
    "backendId",
    "text",
    "title",
    "status",
    "toolName",
    "resourceId",
    "error",
    "data"
  ]);
  requireSafeText(record.workflowRunId, "workflowRunId", 512);
  requireSafeText(record.attemptId, "attemptId", 512);
  const harnessRunId = requireSafeText(
    record.harnessRunId,
    "harnessRunId",
    512
  );
  if (requireSafeText(record.runId, "runId", 512) !== harnessRunId) {
    throw invalidValue("Attempt Harness event runId does not match harnessRunId");
  }
  requireSafeText(record.eventId, "eventId", 1024);
  requirePositiveInteger(record.sequence, "sequence");
  requireTimestamp(record.createdAt, "createdAt");
  if (!EVENT_SOURCES.has(record.source as HarnessEventSource)) {
    throw invalidValue("Attempt Harness event source is invalid");
  }
  if (!EVENT_TYPES.has(record.type as HarnessEventType)) {
    throw invalidValue("Attempt Harness event type is invalid");
  }
  optionalSafeText(record.backendId, "backendId", 160);
  optionalBoundedText(record.text, "text", RUN_RECORD_MAX_PAYLOAD_EVENT_LINE_BYTES);
  optionalBoundedText(record.title, "title", 16_384);
  optionalBoundedText(record.status, "status", 16_384);
  optionalBoundedText(record.toolName, "toolName", 16_384);
  optionalBoundedText(record.resourceId, "resourceId", 65_536);
  optionalBoundedText(record.error, "error", RUN_RECORD_MAX_PAYLOAD_EVENT_LINE_BYTES);
  if (record.data !== undefined) {
    requireObject(record.data, "data");
    canonicalJson(record.data);
  }
  const lineBytes = Buffer.byteLength(canonicalJson(record)) + 1;
  if (lineBytes > RUN_RECORD_MAX_PAYLOAD_EVENT_LINE_BYTES) {
    throw invalidValue("Attempt Harness event exceeds the V1 line byte limit");
  }
  return record as unknown as AttemptHarnessEventV1;
}

export function validateRetentionTombstone(
  value: unknown
): RunRetentionTombstoneV1 {
  const record = requireEnvelope(value, "run-retention-tombstone", [
    "schemaVersion",
    "recordType",
    "scope",
    "workflowRunId",
    "attemptId",
    "harnessRunId",
    "subjectDigest",
    "reasonCode",
    "eligibleAt",
    "expiredAt",
    "prior",
    "policy",
    "retentionTransactionId",
    "committedAt",
    "revision",
    "digest"
  ]);
  if (!TOMBSTONE_SCOPES.has(record.scope as RunRetentionTombstoneScope)) {
    throw invalidValue("tombstone scope is invalid");
  }
  const scope = record.scope as RunRetentionTombstoneScope;
  const workflowRunId = requireSafeText(
    record.workflowRunId,
    "workflowRunId",
    512
  );
  const attemptId = optionalSafeText(record.attemptId, "attemptId", 512);
  const harnessRunId = optionalSafeText(
    record.harnessRunId,
    "harnessRunId",
    512
  );
  if (
    scope === "workflow-summary"
      ? attemptId !== undefined || harnessRunId !== undefined
      : attemptId === undefined
  ) {
    throw invalidValue("tombstone identity does not match scope");
  }
  if (
    scope === "attempt-payload"
      ? harnessRunId === undefined
      : harnessRunId !== undefined
  ) {
    throw invalidValue("tombstone harnessRunId does not match scope");
  }
  const expectedSubject = runRecordSubjectDigest(
    scope,
    workflowRunId,
    attemptId,
    harnessRunId
  );
  if (record.subjectDigest !== expectedSubject) {
    throw invalidValue("subjectDigest does not match tombstone identity");
  }
  if (
    record.reasonCode !== "policy-expired"
    && record.reasonCode !== "user-deleted"
  ) {
    throw invalidValue("tombstone reasonCode is invalid");
  }
  const eligibleAt = requireTimestamp(record.eligibleAt, "eligibleAt");
  const expiredAt = requireTimestamp(record.expiredAt, "expiredAt");
  const committedAt = requireTimestamp(record.committedAt, "committedAt");
  if (expiredAt < eligibleAt || committedAt < expiredAt) {
    throw invalidValue("tombstone timestamps are not monotonic");
  }
  const prior = requireExactObject(record.prior, "prior", [
    "schemaVersion",
    "digest",
    "eventCount",
    "byteCount",
    "terminalAt"
  ]);
  if (prior.schemaVersion !== RUN_RECORD_SCHEMA_VERSION) {
    throw invalidValue("prior.schemaVersion must be V1");
  }
  requireSha256(prior.digest, "prior.digest");
  optionalNonNegativeInteger(prior.eventCount, "prior.eventCount");
  optionalNonNegativeInteger(prior.byteCount, "prior.byteCount");
  requireTimestamp(prior.terminalAt, "prior.terminalAt");
  if (
    scope === "attempt-payload"
    && (
      !Number.isSafeInteger(prior.eventCount)
      || !Number.isSafeInteger(prior.byteCount)
    )
  ) {
    throw invalidValue("payload tombstone requires prior event and byte counts");
  }
  if (
    scope !== "attempt-payload"
    && (
      prior.eventCount !== undefined
      || prior.byteCount !== undefined
    )
  ) {
    throw invalidValue("summary tombstone cannot carry payload counts");
  }
  const policy = requireExactObject(record.policy, "policy", [
    "version",
    "retentionDays"
  ]);
  if (policy.version !== 1) throw invalidValue("policy.version is invalid");
  assertRetentionDays(policy.retentionDays as number, "policy.retentionDays");
  if (record.reasonCode === "policy-expired" && policy.retentionDays === 0) {
    throw invalidValue("policy-expired tombstone requires positive retentionDays");
  }
  if (
    record.reasonCode === "policy-expired"
    && eligibleAt
      !== (prior.terminalAt as number)
        + (policy.retentionDays as number) * RUN_RECORD_DAY_MS
  ) {
    throw invalidValue("policy-expired tombstone eligibility boundary is invalid");
  }
  requireSafeText(
    record.retentionTransactionId,
    "retentionTransactionId",
    512
  );
  requireRevision(record.revision);
  validateRecordDigest(record);
  return record as unknown as RunRetentionTombstoneV1;
}

export function previewRunRecordRetention(
  input: RunRecordRetentionPreviewInput
): RunRecordRetentionPreview {
  if (!TOMBSTONE_SCOPES.has(input.scope)) {
    throw invalidValue("retention scope is invalid");
  }
  requireTimestamp(input.now, "now");
  const holdReasons = Array.from(new Set(input.holdReasons)).sort();
  for (const hold of holdReasons) {
    if (!HOLD_REASONS.has(hold)) {
      throw invalidValue(`Unknown retention hold reason: ${hold}`);
    }
  }
  if (input.terminalAt === undefined) {
    return {
      decision: "not-terminal",
      eligible: false,
      expiresAt: null,
      holdReasons
    };
  }
  const terminalAt = requireTimestamp(input.terminalAt, "terminalAt");
  const retentionDays = input.retentionDays ?? (
    input.scope === "attempt-payload"
      ? RUN_RECORD_DEFAULT_PAYLOAD_RETENTION_DAYS
      : RUN_RECORD_DEFAULT_SUMMARY_RETENTION_DAYS
  );
  assertRetentionDays(retentionDays, "retentionDays");
  if (retentionDays === 0) {
    return {
      decision: "forever",
      eligible: false,
      expiresAt: null,
      holdReasons
    };
  }
  const expiresAt = terminalAt + retentionDays * RUN_RECORD_DAY_MS;
  if (!Number.isSafeInteger(expiresAt)) {
    throw invalidValue("retention expiry exceeds safe timestamp range");
  }
  if (input.now < expiresAt) {
    return {
      decision: "retained",
      eligible: false,
      expiresAt,
      holdReasons
    };
  }
  if (holdReasons.length) {
    return {
      decision: "held",
      eligible: false,
      expiresAt,
      holdReasons
    };
  }
  return {
    decision: "eligible",
    eligible: true,
    expiresAt,
    holdReasons
  };
}

export function safeRunRecordToken(value: string): string {
  const input = requireSafeText(value, "record identity", 512);
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "record";
  return `${slug}-${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

export function runRecordSubjectDigest(
  scope: RunRetentionTombstoneScope,
  workflowRunId: string,
  attemptId?: string,
  harnessRunId?: string
): string {
  return sha256(canonicalJson({
    scope,
    workflowRunId,
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(harnessRunId !== undefined ? { harnessRunId } : {})
  }));
}

export function serializeAttemptPayloadEvents(
  events: readonly AttemptHarnessEventV1[],
  identity: {
    workflowRunId: string;
    attemptId: string;
    harnessRunId: string;
  }
): string {
  requireSafeText(identity.workflowRunId, "workflowRunId", 512);
  requireSafeText(identity.attemptId, "attemptId", 512);
  requireSafeText(identity.harnessRunId, "harnessRunId", 512);
  if (
    !Array.isArray(events)
    || events.length === 0
    || events.length > RUN_RECORD_MAX_PAYLOAD_EVENT_COUNT
  ) {
    throw invalidValue("Attempt payload requires at least one event");
  }
  const eventIds = new Set<string>();
  let terminalCount = 0;
  let terminalSeen = false;
  let previousCreatedAt = -1;
  const lines = events.map((event, index) => {
    const row = validateAttemptHarnessEvent(event);
    const eventId = row.eventId;
    if (eventIds.has(eventId)) {
      throw invalidValue("Attempt payload contains duplicate eventId");
    }
    eventIds.add(eventId);
    if (
      row.workflowRunId !== identity.workflowRunId
      || row.attemptId !== identity.attemptId
      || row.harnessRunId !== identity.harnessRunId
      || row.runId !== identity.harnessRunId
    ) {
      throw invalidValue(
        `events[${index}] does not match Workflow/Attempt/Harness identity`
      );
    }
    if (requirePositiveInteger(row.sequence, `events[${index}].sequence`) !== index + 1) {
      throw invalidValue("Attempt payload sequence is not contiguous from one");
    }
    if (row.createdAt < previousCreatedAt) {
      throw invalidValue("Attempt payload event timestamps are not monotonic");
    }
    previousCreatedAt = row.createdAt;
    if (isAttemptTerminalEventType(row.type)) {
      terminalCount += 1;
      terminalSeen = true;
      if (terminalCount > 1) {
        throw invalidValue("Attempt payload contains multiple terminal events");
      }
    } else if (POST_TERMINAL_EVENT_TYPES.has(row.type)) {
      if (!terminalSeen) {
        throw invalidValue("Attempt payload contains lifecycle event before terminal");
      }
    } else if (terminalSeen) {
      throw invalidValue("Attempt payload contains invalid post-terminal event");
    }
    return canonicalJson(row);
  });
  if (terminalCount !== 1) {
    throw invalidValue("Attempt payload requires exactly one terminal event");
  }
  const payload = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(payload) > RUN_RECORD_MAX_PAYLOAD_BYTES) {
    throw invalidValue("Attempt payload exceeds the V1 byte limit");
  }
  return payload;
}

function isAttemptTerminalEventType(type: HarnessEventType): boolean {
  return type === "run.completed"
    || type === "run.failed"
    || type === "run.cancelled";
}

/**
 * Explicit migration-only adapter. New producers must construct and validate
 * `AttemptHarnessEventV1` directly instead of routing V1 writes through this
 * legacy bridge.
 */
export function adaptLegacyHarnessEventForRunRecordMigration(
  identity: {
    workflowRunId: string;
    attemptId: string;
    harnessRunId: string;
  },
  event: HarnessEvent
): AttemptHarnessEventV1 {
  const candidate = JSON.parse(JSON.stringify({
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    recordType: "attempt-harness-event",
    workflowRunId: identity.workflowRunId,
    attemptId: identity.attemptId,
    harnessRunId: identity.harnessRunId,
    eventId: event.eventId,
    runId: event.runId,
    sequence: event.sequence,
    createdAt: event.createdAt,
    source: event.source,
    type: event.type,
    backendId: event.backendId,
    text: event.text,
    title: event.title,
    status: event.status,
    toolName: event.toolName,
    resourceId: event.resourceId,
    error: event.error,
    data: event.data
  })) as unknown;
  return validateAttemptHarnessEvent(candidate);
}

export function canonicalRunRecordDigest(value: unknown): string {
  const record = requireObject(value, "record");
  const { digest: _digest, ...withoutDigest } = record;
  return sha256(canonicalJson(withoutDigest));
}

function withCanonicalDigest<T extends object>(input: T): T & { digest: string } {
  const persisted = JSON.parse(JSON.stringify(input)) as T;
  return {
    ...persisted,
    digest: canonicalRunRecordDigest(persisted)
  };
}

function validateRecordDigest(record: Record<string, unknown>): void {
  requireSha256(record.digest, "digest");
  const expected = canonicalRunRecordDigest(record);
  if (record.digest !== expected) {
    throw new RunRecordContractError(
      "digest-mismatch",
      "Run record digest does not match canonical content"
    );
  }
}

function requireEnvelope(
  value: unknown,
  recordType: string,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  const record = requireExactObject(value, recordType, allowedKeys);
  const schemaVersion = record.schemaVersion;
  if (!Number.isSafeInteger(schemaVersion)) {
    throw new RunRecordContractError(
      "invalid-envelope",
      `${recordType} schemaVersion is missing or invalid`
    );
  }
  if ((schemaVersion as number) > RUN_RECORD_SCHEMA_VERSION) {
    throw new RunRecordContractError(
      "future-schema",
      `${recordType} schemaVersion ${String(schemaVersion)} is newer than supported V1`
    );
  }
  if (schemaVersion !== RUN_RECORD_SCHEMA_VERSION) {
    throw new RunRecordContractError(
      "unsupported-schema",
      `${recordType} schemaVersion ${String(schemaVersion)} is unsupported`
    );
  }
  if (record.recordType !== recordType) {
    throw new RunRecordContractError(
      "invalid-envelope",
      `Expected recordType ${recordType}`
    );
  }
  return record;
}

function requireExactObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  const record = requireObject(value, label);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new RunRecordContractError(
        "unexpected-field",
        `${label} contains unexpected field ${key}`
      );
    }
  }
  return record;
}

function requireObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidValue(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidValue(`${label} must be an array`);
  return value;
}

function requireSafeText(
  value: unknown,
  label: string,
  maxLength: number
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || containsControlCharacter(value)
  ) {
    throw invalidValue(`${label} is invalid`);
  }
  return value;
}

function optionalSafeText(
  value: unknown,
  label: string,
  maxLength: number
): string | undefined {
  return value === undefined
    ? undefined
    : requireSafeText(value, label, maxLength);
}

function optionalBoundedText(
  value: unknown,
  label: string,
  maxLength: number
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw invalidValue(`${label} exceeds its V1 bound`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidValue(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requireTimestamp(value, label);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidValue(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidValue(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(
  value: unknown,
  label: string
): number | undefined {
  return value === undefined
    ? undefined
    : requireNonNegativeInteger(value, label);
}

function requireRevision(value: unknown): number {
  return requireNonNegativeInteger(value, "revision");
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidValue(`${label} must be canonical sha256`);
  }
  return value;
}

function validateUsage(value: unknown): void {
  if (value === undefined) return;
  const usage = requireExactObject(value, "usage", [
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cost"
  ]);
  for (const [key, item] of Object.entries(usage)) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
      throw invalidValue(`usage.${key} must be a non-negative finite number`);
    }
  }
}

function validateErrorCode(value: unknown, label: string): void {
  if (value !== undefined && !ERROR_CODES.has(value as string)) {
    throw invalidValue(`${label} is not a supported finite error code`);
  }
}

function validateReasonCode(value: unknown, label: string): void {
  if (value !== undefined && !REASON_CODES.has(value as string)) {
    throw invalidValue(`${label} is not a supported finite reason code`);
  }
}

function validateLocalMutation(value: unknown, label: string): void {
  const mutation = requireExactObject(value, label, [
    "state",
    "transactionId",
    "committedAt"
  ]);
  if (!LOCAL_MUTATION_STATES.has(mutation.state as RunRecordLocalMutationState)) {
    throw invalidValue(`${label}.state is invalid`);
  }
  optionalSafeText(mutation.transactionId, `${label}.transactionId`, 512);
  optionalTimestamp(mutation.committedAt, `${label}.committedAt`);
  if (
    mutation.state === "committed"
    && mutation.committedAt === undefined
  ) {
    throw invalidValue(`${label}.committedAt is required for committed state`);
  }
}

function validateLocalCommit(value: unknown): void {
  const commit = requireExactObject(value, "localCommit", [
    "state",
    "authorityKind",
    "committedAt"
  ]);
  if (!LOCAL_MUTATION_STATES.has(commit.state as RunRecordLocalMutationState)) {
    throw invalidValue("localCommit.state is invalid");
  }
  optionalSafeText(commit.authorityKind, "localCommit.authorityKind", 160);
  optionalTimestamp(commit.committedAt, "localCommit.committedAt");
  if (commit.state === "committed" && commit.committedAt === undefined) {
    throw invalidValue("localCommit.committedAt is required for committed state");
  }
}

function validateCleanup(value: unknown): void {
  const cleanup = requireExactObject(value, "cleanup", [
    "status",
    "attempts",
    "nextAttemptAt",
    "settledAt",
    "quarantinedAt",
    "reasonCode"
  ]);
  if (!CLEANUP_STATUSES.has(cleanup.status as NativeCleanupStatus)) {
    throw invalidValue("cleanup.status is invalid");
  }
  requireNonNegativeInteger(cleanup.attempts, "cleanup.attempts");
  optionalTimestamp(cleanup.nextAttemptAt, "cleanup.nextAttemptAt");
  optionalTimestamp(cleanup.settledAt, "cleanup.settledAt");
  optionalTimestamp(cleanup.quarantinedAt, "cleanup.quarantinedAt");
  validateReasonCode(cleanup.reasonCode, "cleanup.reasonCode");
  if (
    cleanup.status === "quarantined"
    && cleanup.quarantinedAt === undefined
  ) {
    throw invalidValue("cleanup.quarantinedAt is required for quarantine");
  }
}

function validatePayloadRef(value: unknown): void {
  const payload = requireExactObject(value, "payload", [
    "expected",
    "expiresAt",
    "manifestRef"
  ]);
  if (typeof payload.expected !== "boolean") {
    throw invalidValue("payload.expected must be boolean");
  }
  optionalTimestamp(payload.expiresAt, "payload.expiresAt");
  optionalSafeText(payload.manifestRef, "payload.manifestRef", 1024);
}

function validateRetentionMetadata(value: unknown, label: string): void {
  const retention = requireExactObject(value, label, [
    "summaryExpiresAt",
    "holdReasons"
  ]);
  optionalTimestamp(retention.summaryExpiresAt, `${label}.summaryExpiresAt`);
  const holds = requireArray(retention.holdReasons, `${label}.holdReasons`);
  const seen = new Set<string>();
  for (const hold of holds) {
    if (typeof hold !== "string" || !HOLD_REASONS.has(hold)) {
      throw invalidValue(`${label}.holdReasons contains an invalid reason`);
    }
    if (seen.has(hold)) {
      throw invalidValue(`${label}.holdReasons contains duplicates`);
    }
    seen.add(hold);
  }
}

function assertRetentionDays(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 36_500) {
    throw invalidValue(`${label} must be an integer from 0 through 36500`);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value, new Set<object>()));
}

function canonicalJsonValue(
  value: unknown,
  ancestors: Set<object>
): unknown {
  if (value === undefined) return undefined;
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidValue("Run record contains non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw invalidValue("Run record contains non-JSON value");
  }
  if (ancestors.has(value)) {
    throw invalidValue("Run record contains a circular value");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const canonical = canonicalJsonValue(item, ancestors);
        if (canonical === undefined) {
          throw invalidValue("Run record arrays cannot contain undefined");
        }
        return canonical;
      });
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [
          key,
          canonicalJsonValue(item, ancestors)
        ])
    );
  } finally {
    ancestors.delete(value);
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function invalidValue(message: string): RunRecordContractError {
  return new RunRecordContractError("invalid-value", message);
}
