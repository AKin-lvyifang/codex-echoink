import { createHash } from "node:crypto";

export const CONVERSATION_V2_SCHEMA_VERSION = 2 as const;
export const CONVERSATION_PRESENTATION_SCHEMA_VERSION = 1 as const;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_MESSAGE_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_PREVIEW_TEXT_LENGTH = 64 * 1024;
const MAX_SNAPSHOT_TEXT_LENGTH = 1024 * 1024;
const MAX_SNAPSHOT_LIST_ITEMS = 10_000;
const MAX_MESSAGES = 100_000;
const MAX_PRESENTATION_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PRESENTATION_JSON_DEPTH = 12;
const MAX_PRESENTATION_JSON_NODES = 20_000;
const MAX_PRESENTATION_CONTAINER_ITEMS = 2_000;

const PRESENTATION_COMPLEX_FIELDS = [
  "attachments",
  "images",
  "files",
  "citations",
  "diffSummary",
  "knowledgeBaseUi"
] as const;

const FORBIDDEN_PRESENTATION_KEYS = new Set([
  "attempts",
  "backend",
  "backendid",
  "events",
  "native",
  "nativeexecution",
  "nativeexecutionid",
  "performance",
  "processinput",
  "processinputavailability",
  "processoutput",
  "processoutputavailability",
  "rawref",
  "rawtext",
  "runid",
  "runterminalrecovery",
  "selectedbackend",
  "terminal",
  "tokenusage",
  "usage",
  "winnerbackend"
]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ConversationV2ContractErrorCode =
  | "invalid-record"
  | "missing-field"
  | "unexpected-field"
  | "forbidden-field"
  | "unknown-schema"
  | "future-schema"
  | "invalid-value"
  | "context-sequence"
  | "lineage-mismatch"
  | "snapshot-mismatch"
  | "digest-mismatch";

export class ConversationV2ContractError extends Error {
  constructor(
    public readonly code: ConversationV2ContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ConversationV2ContractError";
  }
}

export type ConversationKindV2 = "chat" | "knowledge-base";
export type ConversationMessageRoleV2 = "user" | "assistant" | "system" | "tool";

export interface ConversationCurrentContextV2 {
  id: string;
  generation: number;
  cwd: string;
  workspaceFingerprint: string;
}

export interface ConversationRawDescriptorV2 {
  ref: string;
  size: number;
  lines: number;
  truncatedForPreview: boolean;
}

/**
 * Versioned, product-visible message presentation only.
 *
 * Diagnostic/backend/native/run fields have no representation here. Complex
 * product display payloads are bounded JSON and recursively reject execution
 * keys such as backend, native, usage, terminal, events, and process I/O.
 */
export interface Presentation {
  schemaVersion: typeof CONVERSATION_PRESENTATION_SCHEMA_VERSION;
  itemType?: string;
  title?: string;
  status?: string;
  details?: string;
  attachments?: JsonValue;
  images?: JsonValue;
  files?: JsonValue;
  citations?: JsonValue;
  diffSummary?: JsonValue;
  knowledgeBaseUi?: JsonValue;
}

export type PresentationV2 = Presentation;
export type MessagePresentationV2 = Presentation;

export interface MessageV2 {
  schemaVersion: typeof CONVERSATION_V2_SCHEMA_VERSION;
  recordType: "conversation-message";
  id: string;
  role: ConversationMessageRoleV2;
  text: string;
  contextId: string;
  turnId?: string;
  workflowRunId?: string;
  attemptId?: string;
  previewText?: string;
  raw?: ConversationRawDescriptorV2;
  presentation?: Presentation;
  createdAt: number;
  completedAt?: number;
}

export type ConversationMessageV2 = MessageV2;

export interface SnapshotV2 {
  schemaVersion: typeof CONVERSATION_V2_SCHEMA_VERSION;
  recordType: "conversation-snapshot";
  conversationId: string;
  contextId: string;
  contextGeneration: number;
  version: string;
  goal: string;
  currentState: string;
  decisions: string[];
  constraints: string[];
  openLoops: string[];
  keyReferences: string[];
  rollingSummary: string;
  summarizedFromMessageId?: string;
  summarizedThroughMessageId?: string;
  sourceMessageCount: number;
  createdAt: number;
  updatedAt: number;
}

export type ConversationSnapshotV2 = SnapshotV2;

/**
 * Immutable body addressed by `ConversationMetadataV2.payloadDigest`.
 * Conversation title/kind/current workspace live in the metadata commit marker.
 */
export interface ConversationPayloadV2 {
  schemaVersion: typeof CONVERSATION_V2_SCHEMA_VERSION;
  recordType: "conversation-payload";
  conversationId: string;
  messages: MessageV2[];
  snapshot: SnapshotV2 | null;
}

/**
 * Sole visibility/commit marker for one Conversation revision.
 * A payload without matching metadata is unreachable immutable residue.
 */
export interface ConversationMetadataV2 {
  schemaVersion: typeof CONVERSATION_V2_SCHEMA_VERSION;
  recordType: "conversation-metadata";
  conversationId: string;
  title: string;
  kind: ConversationKindV2;
  revision: number;
  commitId: string;
  previousRevision: number | null;
  previousCommitId: string | null;
  previousDigest: string | null;
  currentContext: ConversationCurrentContextV2;
  payloadDigest: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  digest: string;
}

export interface ConversationCommitV2 {
  metadata: ConversationMetadataV2;
  payload: ConversationPayloadV2;
}

export interface FinalizeConversationCommitV2Input {
  conversationId: string;
  title: string;
  kind: ConversationKindV2;
  revision: number;
  commitId: string;
  previousMetadata?: ConversationMetadataV2 | null;
  currentContext: ConversationCurrentContextV2;
  messages: readonly MessageV2[];
  snapshot: SnapshotV2 | null;
  createdAt: number;
  updatedAt: number;
}

export function validateConversationPresentationV2(
  value: unknown
): Presentation {
  const record = requireRecord(value, "Conversation Presentation V2");
  assertExactKeys(record, ["schemaVersion"], [
    "itemType",
    "title",
    "status",
    "details",
    ...PRESENTATION_COMPLEX_FIELDS
  ], "Conversation Presentation V2");
  assertPresentationSchemaVersion(record.schemaVersion);
  for (const key of ["itemType", "title", "status", "details"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      requireText(
        record[key],
        `Conversation Presentation ${key}`,
        key === "details" ? MAX_PREVIEW_TEXT_LENGTH : MAX_TITLE_LENGTH,
        true
      );
    }
  }
  for (const key of PRESENTATION_COMPLEX_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      validateBoundedProductJson(record[key], `Conversation Presentation ${key}`);
    }
  }
  const byteLength = Buffer.byteLength(canonicalJson(record), "utf8");
  if (byteLength > MAX_PRESENTATION_JSON_BYTES) {
    throw contractError(
      "invalid-value",
      "Conversation Presentation 超过安全大小上限"
    );
  }
  return record as unknown as Presentation;
}

export const validatePresentationV2 = validateConversationPresentationV2;

export function validateConversationMessageV2(value: unknown): MessageV2 {
  const record = requireRecord(value, "Conversation Message V2");
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "id",
    "role",
    "text",
    "contextId",
    "createdAt"
  ], [
    "turnId",
    "workflowRunId",
    "attemptId",
    "previewText",
    "raw",
    "presentation",
    "completedAt"
  ], "Conversation Message V2");
  assertConversationSchemaVersion(record.schemaVersion, "Conversation Message V2");
  if (record.recordType !== "conversation-message") {
    throw contractError("invalid-value", "Conversation Message recordType 非法");
  }
  requireIdentifier(record.id, "Conversation Message id");
  if (
    record.role !== "user"
    && record.role !== "assistant"
    && record.role !== "system"
    && record.role !== "tool"
  ) {
    throw contractError("invalid-value", "Conversation Message role 非法");
  }
  requireText(record.text, "Conversation Message text", MAX_MESSAGE_TEXT_LENGTH, true);
  requireIdentifier(record.contextId, "Conversation Message contextId");
  validateOptionalIdentifier(record, "turnId");
  validateOptionalIdentifier(record, "workflowRunId");
  validateOptionalIdentifier(record, "attemptId");
  if (record.attemptId !== undefined && record.workflowRunId === undefined) {
    throw contractError(
      "lineage-mismatch",
      "Conversation Message attemptId 必须同时绑定 workflowRunId"
    );
  }
  if (record.previewText !== undefined) {
    requireText(
      record.previewText,
      "Conversation Message previewText",
      MAX_PREVIEW_TEXT_LENGTH,
      true
    );
  }
  if (record.raw !== undefined) validateRawDescriptor(record.raw);
  if (record.presentation !== undefined) {
    validateConversationPresentationV2(record.presentation);
  }
  requireTimestamp(record.createdAt, "Conversation Message createdAt");
  if (record.completedAt !== undefined) {
    requireTimestamp(record.completedAt, "Conversation Message completedAt");
    if ((record.completedAt as number) < (record.createdAt as number)) {
      throw contractError(
        "invalid-value",
        "Conversation Message completedAt 早于 createdAt"
      );
    }
  }
  return record as unknown as MessageV2;
}

export const validateMessageV2 = validateConversationMessageV2;

export function validateConversationSnapshotV2(value: unknown): SnapshotV2 {
  const record = requireRecord(value, "Conversation Snapshot V2");
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "conversationId",
    "contextId",
    "contextGeneration",
    "version",
    "goal",
    "currentState",
    "decisions",
    "constraints",
    "openLoops",
    "keyReferences",
    "rollingSummary",
    "sourceMessageCount",
    "createdAt",
    "updatedAt"
  ], [
    "summarizedFromMessageId",
    "summarizedThroughMessageId"
  ], "Conversation Snapshot V2");
  assertConversationSchemaVersion(record.schemaVersion, "Conversation Snapshot V2");
  if (record.recordType !== "conversation-snapshot") {
    throw contractError("invalid-value", "Conversation Snapshot recordType 非法");
  }
  requireIdentifier(record.conversationId, "Conversation Snapshot conversationId");
  requireIdentifier(record.contextId, "Conversation Snapshot contextId");
  requirePositiveInteger(
    record.contextGeneration,
    "Conversation Snapshot contextGeneration"
  );
  requireIdentifier(record.version, "Conversation Snapshot version");
  for (const key of ["goal", "currentState", "rollingSummary"]) {
    requireText(
      record[key],
      `Conversation Snapshot ${key}`,
      MAX_SNAPSHOT_TEXT_LENGTH,
      true
    );
  }
  for (const key of ["decisions", "constraints", "openLoops", "keyReferences"]) {
    validateBoundedStringArray(record[key], `Conversation Snapshot ${key}`);
  }
  validateOptionalIdentifier(record, "summarizedFromMessageId");
  validateOptionalIdentifier(record, "summarizedThroughMessageId");
  requireNonNegativeInteger(
    record.sourceMessageCount,
    "Conversation Snapshot sourceMessageCount"
  );
  const hasFrom = record.summarizedFromMessageId !== undefined;
  const hasThrough = record.summarizedThroughMessageId !== undefined;
  if (
    (record.sourceMessageCount === 0 && (hasFrom || hasThrough))
    || (record.sourceMessageCount !== 0 && (!hasFrom || !hasThrough))
  ) {
    throw contractError(
      "snapshot-mismatch",
      "Conversation Snapshot 消息范围与 sourceMessageCount 不一致"
    );
  }
  requireTimestamp(record.createdAt, "Conversation Snapshot createdAt");
  requireTimestamp(record.updatedAt, "Conversation Snapshot updatedAt");
  if ((record.updatedAt as number) < (record.createdAt as number)) {
    throw contractError("invalid-value", "Conversation Snapshot updatedAt 早于 createdAt");
  }
  return record as unknown as SnapshotV2;
}

export const validateSnapshotV2 = validateConversationSnapshotV2;

export function validateConversationPayloadV2(
  value: unknown
): ConversationPayloadV2 {
  const record = requireRecord(value, "Conversation Payload V2");
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "conversationId",
    "messages",
    "snapshot"
  ], [], "Conversation Payload V2");
  assertConversationSchemaVersion(record.schemaVersion, "Conversation Payload V2");
  if (record.recordType !== "conversation-payload") {
    throw contractError("invalid-value", "Conversation Payload recordType 非法");
  }
  requireIdentifier(record.conversationId, "Conversation Payload conversationId");
  if (!Array.isArray(record.messages) || record.messages.length > MAX_MESSAGES) {
    throw contractError(
      "invalid-value",
      "Conversation Payload messages 非数组或超过上限"
    );
  }
  const messages = record.messages.map((message) => validateConversationMessageV2(message));
  assertMessageIdentifiersUnique(messages);
  assertContextSegmentsContinuous(messages);
  assertLineageDoesNotCrossContexts(messages);
  if (record.snapshot !== null) validateConversationSnapshotV2(record.snapshot);
  return record as unknown as ConversationPayloadV2;
}

export function validateConversationMetadataV2(
  value: unknown
): ConversationMetadataV2 {
  const record = requireRecord(value, "Conversation Metadata V2");
  assertExactKeys(record, [
    "schemaVersion",
    "recordType",
    "conversationId",
    "title",
    "kind",
    "revision",
    "commitId",
    "previousRevision",
    "previousCommitId",
    "previousDigest",
    "currentContext",
    "payloadDigest",
    "messageCount",
    "createdAt",
    "updatedAt",
    "digest"
  ], [], "Conversation Metadata V2");
  assertConversationSchemaVersion(record.schemaVersion, "Conversation Metadata V2");
  if (record.recordType !== "conversation-metadata") {
    throw contractError("invalid-value", "Conversation Metadata recordType 非法");
  }
  requireIdentifier(record.conversationId, "Conversation Metadata conversationId");
  requireText(record.title, "Conversation Metadata title", MAX_TITLE_LENGTH, false);
  if (record.kind !== "chat" && record.kind !== "knowledge-base") {
    throw contractError("invalid-value", "Conversation Metadata kind 非法");
  }
  requireNonNegativeInteger(record.revision, "Conversation Metadata revision");
  requireIdentifier(record.commitId, "Conversation Metadata commitId");
  if (record.previousRevision !== null) {
    requireNonNegativeInteger(
      record.previousRevision,
      "Conversation Metadata previousRevision"
    );
  }
  if (record.previousCommitId !== null) {
    requireIdentifier(record.previousCommitId, "Conversation Metadata previousCommitId");
  }
  if (
    record.previousDigest !== null
    && (typeof record.previousDigest !== "string" || !SHA256_PATTERN.test(record.previousDigest))
  ) {
    throw contractError("invalid-value", "Conversation Metadata previousDigest 非法");
  }
  const revision = record.revision as number;
  const hasNoPrevious = record.previousRevision === null
    && record.previousCommitId === null
    && record.previousDigest === null;
  const hasCompletePrevious = record.previousRevision !== null
    && record.previousCommitId !== null
    && record.previousDigest !== null;
  if (
    (revision === 0 && !hasNoPrevious)
    || (
      revision > 0
      && (
        !hasCompletePrevious
        || record.previousRevision !== revision - 1
      )
    )
  ) {
    throw contractError("lineage-mismatch", "Conversation Metadata previous linkage 非法");
  }
  validateCurrentContext(record.currentContext);
  if (typeof record.payloadDigest !== "string" || !SHA256_PATTERN.test(record.payloadDigest)) {
    throw contractError("invalid-value", "Conversation Metadata payloadDigest 非法");
  }
  requireNonNegativeInteger(record.messageCount, "Conversation Metadata messageCount");
  requireTimestamp(record.createdAt, "Conversation Metadata createdAt");
  requireTimestamp(record.updatedAt, "Conversation Metadata updatedAt");
  if ((record.updatedAt as number) < (record.createdAt as number)) {
    throw contractError("invalid-value", "Conversation Metadata updatedAt 早于 createdAt");
  }
  if (typeof record.digest !== "string" || !SHA256_PATTERN.test(record.digest)) {
    throw contractError("invalid-value", "Conversation Metadata digest 非法");
  }
  if (record.digest !== conversationMetadataDigestV2(record)) {
    throw contractError("digest-mismatch", "Conversation Metadata digest 不匹配");
  }
  return record as unknown as ConversationMetadataV2;
}

export function validateConversationCommitV2(
  value: unknown
): ConversationCommitV2 {
  const record = requireRecord(value, "Conversation Commit V2");
  assertExactKeys(record, ["metadata", "payload"], [], "Conversation Commit V2");
  const metadata = validateConversationMetadataV2(record.metadata);
  const payload = validateConversationPayloadV2(record.payload);
  if (metadata.conversationId !== payload.conversationId) {
    throw contractError(
      "invalid-value",
      "Conversation Metadata 与 Payload conversationId 不一致"
    );
  }
  if (metadata.messageCount !== payload.messages.length) {
    throw contractError(
      "invalid-value",
      "Conversation Metadata messageCount 与 Payload 不一致"
    );
  }
  if (metadata.payloadDigest !== conversationPayloadDigestV2(payload)) {
    throw contractError(
      "digest-mismatch",
      "Conversation Metadata payloadDigest 与 immutable payload 不一致"
    );
  }
  assertCurrentContextIsFinalSegment(payload.messages, metadata.currentContext.id);
  if (payload.snapshot !== null) {
    assertSnapshotMatchesCurrentContext(
      payload.snapshot,
      payload.messages,
      metadata
    );
  }
  return record as unknown as ConversationCommitV2;
}

export function finalizeConversationCommitV2(
  input: FinalizeConversationCommitV2Input
): ConversationCommitV2 {
  const payload: ConversationPayloadV2 = {
    schemaVersion: CONVERSATION_V2_SCHEMA_VERSION,
    recordType: "conversation-payload",
    conversationId: input.conversationId,
    messages: input.messages.map((message) => cloneJson(message)),
    snapshot: input.snapshot === null ? null : cloneJson(input.snapshot)
  };
  validateConversationPayloadV2(payload);
  const previous = input.previousMetadata ?? null;
  if (previous !== null) validateConversationMetadataV2(previous);
  if (
    (input.revision === 0 && previous !== null)
    || (
      input.revision > 0
      && (
        previous === null
        || previous.conversationId !== input.conversationId
        || previous.revision !== input.revision - 1
      )
    )
  ) {
    throw contractError("lineage-mismatch", "Conversation commit previous metadata 非法");
  }
  const metadataWithoutDigest: Omit<ConversationMetadataV2, "digest"> = {
    schemaVersion: CONVERSATION_V2_SCHEMA_VERSION,
    recordType: "conversation-metadata",
    conversationId: input.conversationId,
    title: input.title,
    kind: input.kind,
    revision: input.revision,
    commitId: input.commitId,
    previousRevision: previous?.revision ?? null,
    previousCommitId: previous?.commitId ?? null,
    previousDigest: previous?.digest ?? null,
    currentContext: cloneJson(input.currentContext),
    payloadDigest: conversationPayloadDigestV2(payload),
    messageCount: payload.messages.length,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
  const metadata: ConversationMetadataV2 = {
    ...metadataWithoutDigest,
    digest: conversationMetadataDigestV2(metadataWithoutDigest)
  };
  const commit = { metadata, payload };
  validateConversationCommitV2(commit);
  return commit;
}

export function conversationPayloadDigestV2(
  payload: ConversationPayloadV2
): string {
  validateConversationPayloadV2(payload);
  return `sha256:${createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex")}`;
}

export function conversationMetadataDigestV2(value: unknown): string {
  const record = requireRecord(value, "Conversation Metadata digest input");
  const { digest: _digest, ...withoutDigest } = record;
  return `sha256:${createHash("sha256")
    .update(canonicalJson(withoutDigest), "utf8")
    .digest("hex")}`;
}

export function canonicalConversationV2Json(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function validateCurrentContext(value: unknown): ConversationCurrentContextV2 {
  const record = requireRecord(value, "Conversation currentContext");
  assertExactKeys(record, [
    "id",
    "generation",
    "cwd",
    "workspaceFingerprint"
  ], [], "Conversation currentContext");
  requireIdentifier(record.id, "Conversation currentContext id");
  requirePositiveInteger(record.generation, "Conversation currentContext generation");
  requireText(
    record.cwd,
    "Conversation currentContext cwd",
    MAX_PATH_LENGTH,
    true
  );
  if (
    typeof record.workspaceFingerprint !== "string"
    || !SHA256_PATTERN.test(record.workspaceFingerprint)
  ) {
    throw contractError(
      "invalid-value",
      "Conversation currentContext workspaceFingerprint 非法"
    );
  }
  return record as unknown as ConversationCurrentContextV2;
}

function validateRawDescriptor(value: unknown): ConversationRawDescriptorV2 {
  const record = requireRecord(value, "Conversation raw descriptor");
  assertExactKeys(record, [
    "ref",
    "size",
    "lines",
    "truncatedForPreview"
  ], [], "Conversation raw descriptor");
  requireSafeRelativeReference(record.ref, "Conversation raw descriptor ref");
  requireNonNegativeInteger(record.size, "Conversation raw descriptor size");
  requireNonNegativeInteger(record.lines, "Conversation raw descriptor lines");
  if (typeof record.truncatedForPreview !== "boolean") {
    throw contractError(
      "invalid-value",
      "Conversation raw descriptor truncatedForPreview 非法"
    );
  }
  return record as unknown as ConversationRawDescriptorV2;
}

function assertMessageIdentifiersUnique(messages: readonly MessageV2[]): void {
  const seen = new Set<string>();
  for (const message of messages) {
    if (seen.has(message.id)) {
      throw contractError(
        "invalid-value",
        `Conversation Message id 重复：${message.id}`
      );
    }
    seen.add(message.id);
  }
}

function assertContextSegmentsContinuous(messages: readonly MessageV2[]): void {
  const seenContexts = new Set<string>();
  let previousContextId: string | null = null;
  for (const message of messages) {
    if (message.contextId === previousContextId) continue;
    if (seenContexts.has(message.contextId)) {
      throw contractError(
        "context-sequence",
        `Conversation context 区段不连续：${message.contextId}`
      );
    }
    seenContexts.add(message.contextId);
    previousContextId = message.contextId;
  }
}

function assertLineageDoesNotCrossContexts(messages: readonly MessageV2[]): void {
  const owners = new Map<string, string>();
  for (const message of messages) {
    for (const [kind, id] of [
      ["turn", message.turnId],
      ["workflow", message.workflowRunId],
      ["attempt", message.attemptId]
    ] as const) {
      if (!id) continue;
      const key = kind === "attempt"
        ? `${kind}:${message.workflowRunId}:${id}`
        : `${kind}:${id}`;
      const owner = owners.get(key);
      if (owner && owner !== message.contextId) {
        throw contractError(
          "lineage-mismatch",
          `Conversation ${kind} lineage 跨越多个 context`
        );
      }
      owners.set(key, message.contextId);
    }
  }
}

function assertCurrentContextIsFinalSegment(
  messages: readonly MessageV2[],
  currentContextId: string
): void {
  const finalContextId = messages[messages.length - 1]?.contextId;
  if (finalContextId !== undefined && finalContextId !== currentContextId) {
    throw contractError(
      "context-sequence",
      "Conversation currentContext 必须指向最后一个连续 context 区段"
    );
  }
}

function assertSnapshotMatchesCurrentContext(
  snapshot: SnapshotV2,
  messages: readonly MessageV2[],
  metadata: ConversationMetadataV2
): void {
  if (
    snapshot.conversationId !== metadata.conversationId
    || snapshot.contextId !== metadata.currentContext.id
    || snapshot.contextGeneration !== metadata.currentContext.generation
  ) {
    throw contractError(
      "snapshot-mismatch",
      "Conversation Snapshot identity 必须精确匹配 currentContext"
    );
  }
  if (snapshot.sourceMessageCount === 0) return;
  const currentMessages = messages.filter(
    (message) => message.contextId === metadata.currentContext.id
  );
  const fromIndex = currentMessages.findIndex(
    (message) => message.id === snapshot.summarizedFromMessageId
  );
  const throughIndex = currentMessages.findIndex(
    (message) => message.id === snapshot.summarizedThroughMessageId
  );
  if (
    fromIndex < 0
    || throughIndex < fromIndex
    || throughIndex - fromIndex + 1 !== snapshot.sourceMessageCount
  ) {
    throw contractError(
      "snapshot-mismatch",
      "Conversation Snapshot 消息范围必须完全位于 currentContext"
    );
  }
}

function validateBoundedStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_LIST_ITEMS) {
    throw contractError("invalid-value", `${label} 非数组或超过上限`);
  }
  for (const entry of value) {
    requireText(entry, `${label} item`, MAX_PREVIEW_TEXT_LENGTH, true);
  }
}

function validateBoundedProductJson(value: unknown, label: string): void {
  const state = { nodes: 0 };
  validateProductJsonNode(value, label, 0, state);
  if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_PRESENTATION_JSON_BYTES) {
    throw contractError("invalid-value", `${label} 超过安全大小上限`);
  }
}

function validateProductJsonNode(
  value: unknown,
  label: string,
  depth: number,
  state: { nodes: number }
): void {
  state.nodes += 1;
  if (
    state.nodes > MAX_PRESENTATION_JSON_NODES
    || depth > MAX_PRESENTATION_JSON_DEPTH
  ) {
    throw contractError("invalid-value", `${label} JSON 结构超过安全上限`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw contractError("invalid-value", `${label} 含非有限数字`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PRESENTATION_CONTAINER_ITEMS) {
      throw contractError("invalid-value", `${label} 数组超过安全上限`);
    }
    value.forEach((entry, index) =>
      validateProductJsonNode(entry, `${label}[${index}]`, depth + 1, state)
    );
    return;
  }
  const record = requireRecord(value, label);
  const entries = Object.entries(record);
  if (entries.length > MAX_PRESENTATION_CONTAINER_ITEMS) {
    throw contractError("invalid-value", `${label} 对象字段超过安全上限`);
  }
  for (const [key, entry] of entries) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (
      FORBIDDEN_PRESENTATION_KEYS.has(normalizedKey)
      || normalizedKey.includes("backend")
      || normalizedKey.includes("native")
      || normalizedKey.includes("terminal")
      || normalizedKey.includes("attempt")
      || normalizedKey.includes("event")
      || normalizedKey.endsWith("runid")
      || normalizedKey.endsWith("runids")
      || (
        normalizedKey.includes("process")
        && (
          normalizedKey.includes("input")
          || normalizedKey.includes("output")
          || normalizedKey.includes("stdin")
          || normalizedKey.includes("stdout")
          || normalizedKey.includes("stderr")
        )
      )
      || normalizedKey.endsWith("usage")
    ) {
      throw contractError(
        "forbidden-field",
        `${label} 含执行态字段：${key}`
      );
    }
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw contractError("forbidden-field", `${label} 含危险字段：${key}`);
    }
    validateProductJsonNode(entry, `${label}.${key}`, depth + 1, state);
  }
}

function assertConversationSchemaVersion(value: unknown, label: string): void {
  assertSchemaVersion(value, CONVERSATION_V2_SCHEMA_VERSION, label);
}

function assertPresentationSchemaVersion(value: unknown): void {
  assertSchemaVersion(
    value,
    CONVERSATION_PRESENTATION_SCHEMA_VERSION,
    "Conversation Presentation V2"
  );
}

function assertSchemaVersion(
  value: unknown,
  supported: number,
  label: string
): void {
  if (value === supported) return;
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > supported
  ) {
    throw contractError("future-schema", `${label} 使用 future schema：${value}`);
  }
  throw contractError("unknown-schema", `${label} schemaVersion 未知`);
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw contractError("invalid-record", `${label} 必须是普通对象`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw contractError("unexpected-field", `${label} 含未知字段：${key}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw contractError("missing-field", `${label} 缺少字段：${key}`);
    }
  }
}

function validateOptionalIdentifier(
  value: Record<string, unknown>,
  key: string
): void {
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    requireIdentifier(value[key], key);
  }
}

function requireSafeRelativeReference(value: unknown, label: string): string {
  const reference = requireText(value, label, MAX_PATH_LENGTH, false);
  if (
    reference.startsWith("/")
    || reference.startsWith("\\")
    || reference.includes("\\")
    || reference.split("/").some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
    ))
  ) {
    throw contractError("invalid-value", `${label} 必须是安全相对引用`);
  }
  return reference;
}

function requireIdentifier(value: unknown, label: string): string {
  return requireText(value, label, MAX_IDENTIFIER_LENGTH, false);
}

function requireText(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty: boolean
): string {
  if (
    typeof value !== "string"
    || value.length > maxLength
    || hasUnsafeControlCharacter(value)
    || (!allowEmpty && (!value.length || value.trim() !== value))
  ) {
    throw contractError("invalid-value", `${label} 非法`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): number {
  return requireNonNegativeInteger(value, label);
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 8
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127
    ) return true;
  }
  return false;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    throw contractError("invalid-value", `${label} 非法`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw contractError("invalid-value", `${label} 非法`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw contractError("invalid-value", "Conversation V2 canonical JSON 含非有限数字");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = requireRecord(value, "Conversation V2 canonical JSON");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function contractError(
  code: ConversationV2ContractErrorCode,
  message: string
): ConversationV2ContractError {
  return new ConversationV2ContractError(code, message);
}
