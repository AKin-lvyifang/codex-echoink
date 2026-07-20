import { createHash } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ChatMessage, StoredSession } from "../../settings/settings";
import {
  FileConversationStore,
  parseConversationDeletionTombstone,
  type ConversationDeletionTombstoneV1
} from "../conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../conversation/conversation-store-v2";
import {
  publishRecordMigrationConflictQuarantine,
  type RecordMigrationConflictQuarantineReceipt
} from "./record-migration-conflict-quarantine";
import {
  CONVERSATION_PRESENTATION_SCHEMA_VERSION,
  CONVERSATION_V2_SCHEMA_VERSION,
  finalizeConversationCommitV2,
  validateConversationCommitV2,
  validateConversationMessageV2,
  type ConversationCommitV2,
  type JsonValue,
  type MessageV2,
  type Presentation,
  type SnapshotV2
} from "../contracts/conversation-v2";
import {
  finalizeRecordMigrationInventory,
  migrationContentDigest,
  opaqueMigrationRef,
  validateRecordMigration,
  type RecordMigrationInventory,
  type RecordMigrationOwnerEdge,
  type RecordMigrationSubject,
  type RecordMigrationValidationProof,
  type RecordMigrationValidationReport
} from "./record-migration-validator";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LEGACY_SESSION_KEYS = new Set([
  "id",
  "title",
  "kind",
  "threadId",
  "backendBindings",
  "revision",
  "generation",
  "contextId",
  "contextStartsAfterMessageId",
  "commitId",
  "workspaceFingerprint",
  "contextSnapshot",
  "cwd",
  "messages",
  "rollingSummary",
  "messagesHiddenBefore",
  "historyActiveDate",
  "tokenUsage",
  "payloadVersion",
  "payloadKey",
  "previousPayloadKey",
  "previousPayloadCommitId",
  "createdAt",
  "updatedAt"
]);
const LEGACY_MESSAGE_KEYS = new Set([
  "id",
  "role",
  "text",
  "backendId",
  "modelId",
  "profileId",
  "nativeExecutionIdHash",
  "contextMode",
  "contextCompiledThroughMessageId",
  "contextSnapshotVersion",
  "nativeLeaseId",
  "nativeLeaseStatus",
  "nativeLeaseTurnCount",
  "nativeLeaseReused",
  "nativeLocalCommitStatus",
  "nativeCleanupStatus",
  "runTerminalRecoveryPending",
  "echoInkRunTerminalRecovery",
  "runTerminalRecovered",
  "previewText",
  "rawRef",
  "rawSize",
  "rawLines",
  "rawTruncatedForPreview",
  "phase",
  "itemType",
  "runId",
  "turnId",
  "processKind",
  "title",
  "status",
  "details",
  "processContentAvailability",
  "processInput",
  "processOutput",
  "processInputAvailability",
  "processOutputAvailability",
  "diffSummary",
  "citations",
  "knowledgeBaseUi",
  "attachments",
  "files",
  "images",
  "runUsage",
  "createdAt",
  "completedAt"
]);
const LEGACY_SNAPSHOT_KEYS = new Set([
  "sessionId",
  "contextId",
  "generation",
  "version",
  "goal",
  "currentState",
  "decisions",
  "constraints",
  "openLoops",
  "keyReferences",
  "rollingSummary",
  "summarizedFromMessageId",
  "summarizedThroughMessageId",
  "sourceMessageCount",
  "createdAt",
  "updatedAt"
]);

export interface ConversationMigrationProjectionOptions {
  externalOwnerEdges?: readonly RecordMigrationOwnerEdge[];
  deletionTombstones?: readonly ConversationDeletionTombstoneV1[];
}

export interface HistoryMigrationReferenceInput {
  conversationId: string;
  messageId: string;
  messageRevision: string;
  date: string;
  ordinal: number;
}

export interface InspectConversationStoreMigrationInput {
  sourceStore: FileConversationStore;
  targetStore: FileConversationStoreV2;
  sourceExternalOwnerEdges?: readonly RecordMigrationOwnerEdge[];
  targetExternalOwnerEdges?: readonly RecordMigrationOwnerEdge[];
  conflictQuarantineRootPath?: string;
}

export interface ConversationStoreMigrationValidation {
  source: RecordMigrationInventory;
  target: RecordMigrationInventory;
  report: RecordMigrationValidationReport;
  proof: RecordMigrationValidationProof | null;
}

export interface PrepareConversationStoreV2MigrationResult
extends ConversationStoreMigrationValidation {
  createdConversationCount: number;
  reusedConversationCount: number;
  conflictingConversationCount: number;
  createdDeletionTombstoneCount: number;
  reusedDeletionTombstoneCount: number;
  conflictingDeletionTombstoneCount: number;
  conflictQuarantineReceipt:
    | RecordMigrationConflictQuarantineReceipt
    | null;
}

/**
 * Side-by-side copier used before validation. Existing V2 identities are
 * either exact and reusable or left untouched for conflict quarantine.
 */
export async function prepareConversationStoreV2Migration(
  input: InspectConversationStoreMigrationInput
): Promise<PrepareConversationStoreV2MigrationResult> {
  const sourceSnapshot = await input.sourceStore.inspectMigrationSnapshot();
  let createdConversationCount = 0;
  let reusedConversationCount = 0;
  let conflictingConversationCount = 0;
  let createdDeletionTombstoneCount = 0;
  let reusedDeletionTombstoneCount = 0;
  let conflictingDeletionTombstoneCount = 0;
  for (const tombstone of sourceSnapshot.deletionTombstones) {
    const [existing, activeConversation] = await Promise.all([
      input.targetStore.readDeletionTombstone(tombstone.conversationId),
      input.targetStore.readConversation(tombstone.conversationId)
    ]);
    if (activeConversation || (existing && !isDeepStrictEqual(
      existing,
      tombstone
    ))) {
      conflictingDeletionTombstoneCount += 1;
    } else if (existing) {
      reusedDeletionTombstoneCount += 1;
    } else {
      await input.targetStore.commitDeletionTombstone(tombstone);
      createdDeletionTombstoneCount += 1;
    }
  }
  for (const session of sourceSnapshot.sessions) {
    const candidate = projectStoredSessionToConversationCommitV2(session);
    const [existing, deletionTombstone] = await Promise.all([
      input.targetStore.readConversation(session.id),
      input.targetStore.readDeletionTombstone(session.id)
    ]);
    if (deletionTombstone) {
      conflictingConversationCount += 1;
    } else if (!existing) {
      await input.targetStore.commitConversation(candidate, {
        expectedRevision: null,
        expectedCommitId: null
      });
      createdConversationCount += 1;
    } else if (isDeepStrictEqual(existing, candidate)) {
      reusedConversationCount += 1;
    } else {
      conflictingConversationCount += 1;
    }
  }
  const validation = await inspectAndValidateConversationStoreMigration(
    input
  );
  const conflictQuarantineReceipt = (
    validation.report.quarantine
  )
    ? await publishRecordMigrationConflictQuarantine({
      rootPath: input.conflictQuarantineRootPath
        ?? path.join(input.targetStore.rootPath, "migration-conflicts"),
      quarantine: validation.report.quarantine
    })
    : null;
  return {
    ...validation,
    createdConversationCount,
    reusedConversationCount,
    conflictingConversationCount,
    createdDeletionTombstoneCount,
    reusedDeletionTombstoneCount,
    conflictingDeletionTombstoneCount,
    conflictQuarantineReceipt
  };
}

export async function inspectAndValidateConversationStoreMigration(
  input: InspectConversationStoreMigrationInput
): Promise<ConversationStoreMigrationValidation> {
  const inspect = async (): Promise<{
    source: RecordMigrationInventory;
    target: RecordMigrationInventory;
  }> => {
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      input.sourceStore.inspectMigrationSnapshot(),
      input.targetStore.inspectMigrationSnapshot()
    ]);
    return {
      source: conversationMigrationInventoryFromLegacySessions(
        sourceSnapshot.sessions,
        {
          externalOwnerEdges: input.sourceExternalOwnerEdges,
          deletionTombstones: sourceSnapshot.deletionTombstones
        }
      ),
      target: conversationMigrationInventoryFromV2Commits(
        targetSnapshot.commits,
        "v2",
        {
          externalOwnerEdges: input.targetExternalOwnerEdges,
          deletionTombstones: targetSnapshot.deletionTombstones
        }
      )
    };
  };
  const first = await inspect();
  const second = await inspect();
  if (
    first.source.fingerprint !== second.source.fingerprint
    || first.target.fingerprint !== second.target.fingerprint
  ) {
    throw new Error(
      "Conversation migration blocked: source or target inventory drifted"
    );
  }
  const validation = validateRecordMigration(second.source, second.target);
  return {
    ...second,
    report: validation.report,
    proof: validation.proof
  };
}

export function projectStoredSessionToConversationCommitV2(
  session: StoredSession
): ConversationCommitV2 {
  assertExactLegacyKeys(session, LEGACY_SESSION_KEYS, "StoredSession");
  const currentContextId = normalizedIdentifier(session.contextId)
    ?? legacyContextId(session.id, "current");
  const boundary = session.contextStartsAfterMessageId?.trim() || null;
  const boundaryIndex = boundary === null
    ? -1
    : session.messages.findIndex((message) => message.id === boundary);
  if (boundary !== null && boundaryIndex < 0) {
    throw new Error(
      `Conversation migration blocked: context boundary ${boundary} is missing`
    );
  }
  const previousContextId = boundary === null
    ? null
    : legacyContextId(session.id, `before:${boundary}`);
  const messages = session.messages.map((message, index) =>
    projectStoredChatMessageToConversationMessageV2(
      message,
      previousContextId !== null && index <= boundaryIndex
        ? previousContextId
        : currentContextId
    )
  );
  const generation = positiveSafeInteger(session.generation)
    ?? positiveSafeInteger(session.revision)
    ?? 1;
  const workspaceFingerprint = (
    typeof session.workspaceFingerprint === "string"
    && SHA256_PATTERN.test(session.workspaceFingerprint)
  )
    ? session.workspaceFingerprint
    : migrationContentDigest({
      kind: "legacy-workspace",
      cwd: session.cwd
    });
  const snapshot = projectStoredSessionSnapshot(
    session,
    currentContextId,
    generation
  );
  const sourceDigest = migrationContentDigest({
    session: migrationConversationSourceRecord(session),
    messages: messages.map((message) => messageProductRecord(message)),
    snapshot
  });
  return finalizeConversationCommitV2({
    conversationId: session.id,
    title: session.title,
    kind: session.kind ?? "chat",
    revision: 0,
    commitId: `migration-${sourceDigest.slice("sha256:".length)}`,
    currentContext: {
      id: currentContextId,
      generation,
      ...(session.commitId ? { commitId: session.commitId } : {}),
      cwd: session.cwd,
      workspaceFingerprint
    },
    messages,
    snapshot,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  });
}

/**
 * Projects a live Settings candidate onto the append-only V2 Store.
 *
 * Existing product messages retain their original Context and lineage. New
 * messages join the current Context. The Store revision commit is independent
 * from the stable product Context commit carried by currentContext.commitId.
 */
export function projectStoredSessionToLiveConversationCommitV2(
  session: StoredSession,
  input: {
    previous: ConversationCommitV2 | null;
    metadataCommitId: string;
  }
): ConversationCommitV2 {
  assertExactLegacyKeys(session, LEGACY_SESSION_KEYS, "StoredSession");
  const currentContextId = normalizedIdentifier(session.contextId);
  const contextCommitId = normalizedIdentifier(session.commitId);
  const generation = positiveSafeInteger(session.generation)
    ?? positiveSafeInteger(session.revision);
  if (!currentContextId || !contextCommitId || !generation) {
    throw new Error(
      "Conversation live V2 commit requires a complete Context identity"
    );
  }
  const workspaceFingerprint = session.workspaceFingerprint;
  if (
    typeof workspaceFingerprint !== "string"
    || !SHA256_PATTERN.test(workspaceFingerprint)
  ) {
    throw new Error(
      "Conversation live V2 commit requires a workspace fingerprint"
    );
  }
  const boundary = session.contextStartsAfterMessageId?.trim() || null;
  const boundaryIndex = boundary === null
    ? -1
    : session.messages.findIndex((message) => message.id === boundary);
  if (boundary !== null && boundaryIndex < 0) {
    throw new Error(
      `Conversation live V2 context boundary ${boundary} is missing`
    );
  }
  const previousMessages = input.previous?.payload.messages ?? [];
  const messages = session.messages.map((message, index) => {
    const projected = projectStoredChatMessageToConversationMessageV2(
      message,
      currentContextId
    );
    const existing = previousMessages[index];
    if (
      existing
      && existing.id === projected.id
      && createConversationProductMessageRevision(existing)
        === createConversationProductMessageRevision(projected)
    ) {
      return existing;
    }
    const contextId = boundaryIndex >= 0 && index <= boundaryIndex
      ? (
        existing?.contextId
        ?? legacyContextId(session.id, `before:${boundary}`)
      )
      : currentContextId;
    return contextId === currentContextId
      ? projected
      : projectStoredChatMessageToConversationMessageV2(
        message,
        contextId
      );
  });
  const snapshot = projectStoredSessionSnapshot(
    session,
    currentContextId,
    generation
  );
  const previousMetadata = input.previous?.metadata ?? null;
  return finalizeConversationCommitV2({
    conversationId: session.id,
    title: session.title,
    kind: session.kind ?? "chat",
    revision: previousMetadata ? previousMetadata.revision + 1 : 0,
    commitId: input.metadataCommitId,
    previousMetadata,
    currentContext: {
      id: currentContextId,
      generation,
      commitId: contextCommitId,
      cwd: session.cwd,
      workspaceFingerprint
    },
    messages,
    snapshot,
    createdAt: previousMetadata?.createdAt ?? session.createdAt,
    updatedAt: session.updatedAt
  });
}

export function projectStoredChatMessageToConversationMessageV2(
  message: ChatMessage,
  contextId: string
): MessageV2 {
  assertExactLegacyKeys(message, LEGACY_MESSAGE_KEYS, "ChatMessage");
  const product = legacyMessageProductRecord(message);
  const projected: MessageV2 = {
    schemaVersion: CONVERSATION_V2_SCHEMA_VERSION,
    recordType: "conversation-message",
    id: message.id,
    role: message.role,
    text: message.text,
    contextId,
    createdAt: message.createdAt,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.previewText !== undefined
      ? { previewText: message.previewText }
      : {}),
    ...(product.raw ? { raw: product.raw } : {}),
    ...(product.presentation ? { presentation: product.presentation } : {}),
    ...(message.completedAt !== undefined
      ? { completedAt: message.completedAt }
      : {})
  };
  return validateConversationMessageV2(projected);
}

export function createConversationProductMessageRevision(
  message: ChatMessage | MessageV2
): string {
  return migrationContentDigest(
    isConversationMessageV2(message)
      ? messageProductRecord(message)
      : legacyMessageProductRecord(message)
  );
}

export function createConversationProductRevision(
  commitInput: ConversationCommitV2
): string {
  const commit = validateConversationCommitV2(commitInput);
  const { metadata, payload } = commit;
  return migrationContentDigest({
    conversationId: metadata.conversationId,
    title: metadata.title,
    kind: metadata.kind,
    currentContext: {
      id: metadata.currentContext.id,
      generation: metadata.currentContext.generation,
      cwd: metadata.currentContext.cwd,
      workspaceFingerprint: metadata.currentContext.workspaceFingerprint
    },
    contextStartsAfterMessageId:
      currentContextBoundaryMessageId(commit),
    messages: payload.messages.map((message) =>
      messageProductRecord(message)),
    snapshot: payload.snapshot,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt
  });
}

export function conversationMigrationInventoryFromLegacySessions(
  sessions: readonly StoredSession[],
  options: ConversationMigrationProjectionOptions = {}
): RecordMigrationInventory {
  const commits = sessions.map((session) =>
    projectStoredSessionToConversationCommitV2(session)
  );
  const requiredExternalOwners = legacyExternalOwnerEdges(sessions);
  return conversationMigrationInventoryFromV2Commits(
    commits,
    "v1",
    {
      externalOwnerEdges: [
        ...requiredExternalOwners,
        ...(options.externalOwnerEdges ?? [])
      ],
      deletionTombstones: options.deletionTombstones
    }
  );
}

export function conversationMigrationInventoryFromV2Commits(
  commitsInput: readonly ConversationCommitV2[],
  storeVersion: "v1" | "v2" = "v2",
  options: ConversationMigrationProjectionOptions = {}
): RecordMigrationInventory {
  const commits = commitsInput
    .map((commit) => validateConversationCommitV2(commit))
    .sort((left, right) =>
      left.metadata.conversationId.localeCompare(
        right.metadata.conversationId
      ));
  const subjects: RecordMigrationSubject[] = [];
  const ownerEdges: RecordMigrationOwnerEdge[] = [
    ...(options.externalOwnerEdges ?? [])
  ];
  const conversationIds = new Set<string>();
  for (const commit of commits) {
    const { metadata, payload } = commit;
    if (conversationIds.has(metadata.conversationId)) {
      throw new Error(
        "Conversation migration blocked: duplicate conversation identity"
      );
    }
    conversationIds.add(metadata.conversationId);
    const conversationRef = opaqueMigrationRef(
      "conversation",
      metadata.conversationId
    );
    const conversationProductRevision =
      createConversationProductRevision(commit);
    subjects.push({
      kind: "conversation",
      subjectRef: conversationRef,
      parentRef: null,
      ordinal: 0,
      revision: conversationProductRevision,
      contentDigest: conversationProductRevision
    });
    payload.messages.forEach((message, ordinal) => {
      const messageRef = opaqueMigrationRef(
        "message",
        metadata.conversationId,
        message.id
      );
      const revision = createConversationProductMessageRevision(message);
      subjects.push({
        kind: "message",
        subjectRef: messageRef,
        parentRef: conversationRef,
        ordinal,
        revision,
        contentDigest: revision
      });
      if (message.raw) {
        ownerEdges.push({
          kind: "raw-owner",
          ownerRef: messageRef,
          resourceRef: opaqueMigrationRef("raw", message.raw.ref)
        });
      }
    });
    if (payload.snapshot) {
      const digest = migrationContentDigest(payload.snapshot);
      subjects.push({
        kind: "snapshot",
        subjectRef: opaqueMigrationRef(
          "snapshot",
          metadata.conversationId,
          payload.snapshot.version
        ),
        parentRef: conversationRef,
        ordinal: payload.messages.length,
        revision: digest,
        contentDigest: digest
      });
    }
  }
  for (const tombstoneInput of options.deletionTombstones ?? []) {
    const tombstone = parseConversationDeletionTombstone(tombstoneInput);
    subjects.push({
      kind: "deletion-tombstone",
      subjectRef: opaqueMigrationRef(
        "conversation-deletion-tombstone",
        tombstone.conversationId
      ),
      parentRef: null,
      ordinal: 0,
      revision: tombstone.digest,
      contentDigest: tombstone.digest
    });
  }
  return finalizeRecordMigrationInventory({
    domain: "conversation",
    projection: "conversation-portable-v1",
    storeVersion,
    subjects,
    ownerEdges
  });
}

export function historyMigrationInventoryFromReferences(
  storeVersion: "v1" | "v2",
  referencesInput: readonly HistoryMigrationReferenceInput[]
): RecordMigrationInventory {
  const references = referencesInput
    .map((reference) => ({ ...reference }))
    .sort((left, right) =>
      left.conversationId.localeCompare(right.conversationId)
      || left.date.localeCompare(right.date)
      || left.ordinal - right.ordinal
      || left.messageId.localeCompare(right.messageId));
  const subjects: RecordMigrationSubject[] = [];
  const conversationRefs = new Set<string>();
  for (const reference of references) {
    const conversationRef = opaqueMigrationRef(
      "history-conversation",
      reference.conversationId
    );
    if (!conversationRefs.has(conversationRef)) {
      conversationRefs.add(conversationRef);
      const digest = migrationContentDigest({
        conversationId: reference.conversationId
      });
      subjects.push({
        kind: "conversation",
        subjectRef: conversationRef,
        parentRef: null,
        ordinal: 0,
        revision: digest,
        contentDigest: digest
      });
    }
    const subjectRef = opaqueMigrationRef(
      "history-reference",
      reference.conversationId,
      reference.messageId,
      reference.date
    );
    subjects.push({
      kind: "history-reference",
      subjectRef,
      parentRef: conversationRef,
      ordinal: reference.ordinal,
      revision: reference.messageRevision,
      contentDigest: migrationContentDigest({
        conversationId: reference.conversationId,
        messageId: reference.messageId,
        messageRevision: reference.messageRevision,
        date: reference.date,
        ordinal: reference.ordinal
      })
    });
  }
  return finalizeRecordMigrationInventory({
    domain: "history",
    projection: "history-reference-v2",
    storeVersion,
    subjects,
    ownerEdges: references.map((reference) => ({
      kind: "history-source",
      ownerRef: opaqueMigrationRef(
        "history-reference",
        reference.conversationId,
        reference.messageId,
        reference.date
      ),
      resourceRef: opaqueMigrationRef(
        "message",
        reference.conversationId,
        reference.messageId
      )
    }))
  });
}

export function legacyExternalOwnerEdges(
  sessions: readonly StoredSession[]
): RecordMigrationOwnerEdge[] {
  const edges: RecordMigrationOwnerEdge[] = [];
  for (const session of sessions) {
    const conversationRef = opaqueMigrationRef("conversation", session.id);
    const nativeEvidence = sessionNativeEvidence(session);
    if (nativeEvidence !== null) {
      edges.push({
        kind: "native-execution-owner",
        ownerRef: conversationRef,
        resourceRef: migrationContentDigest(nativeEvidence)
      });
    }
    const settingsEvidence = sessionSettingsProjectionEvidence(session);
    if (settingsEvidence !== null) {
      edges.push({
        kind: "settings-projection-owner",
        ownerRef: conversationRef,
        resourceRef: migrationContentDigest(settingsEvidence)
      });
    }
    if (session.tokenUsage !== undefined) {
      edges.push({
        kind: "run-record-owner",
        ownerRef: conversationRef,
        resourceRef: migrationContentDigest({
          tokenUsage: session.tokenUsage
        })
      });
    }
    for (const message of session.messages) {
      const messageRef = opaqueMigrationRef(
        "message",
        session.id,
        message.id
      );
      const nativeMessageEvidence = messageNativeEvidence(message);
      if (nativeMessageEvidence !== null) {
        edges.push({
          kind: "native-execution-owner",
          ownerRef: messageRef,
          resourceRef: migrationContentDigest(nativeMessageEvidence)
        });
      }
      const runEvidence = messageRunEvidence(message);
      if (runEvidence !== null) {
        edges.push({
          kind: "run-record-owner",
          ownerRef: messageRef,
          resourceRef: migrationContentDigest(runEvidence)
        });
      }
    }
  }
  return edges;
}

function projectStoredSessionSnapshot(
  session: StoredSession,
  contextId: string,
  contextGeneration: number
): SnapshotV2 | null {
  const snapshot = session.contextSnapshot;
  if (!snapshot) return null;
  assertExactLegacyKeys(
    snapshot,
    LEGACY_SNAPSHOT_KEYS,
    "SessionContextSnapshot"
  );
  return {
    schemaVersion: CONVERSATION_V2_SCHEMA_VERSION,
    recordType: "conversation-snapshot",
    conversationId: session.id,
    contextId,
    contextGeneration,
    version: snapshot.version,
    goal: snapshot.goal,
    currentState: snapshot.currentState,
    decisions: [...snapshot.decisions],
    constraints: [...snapshot.constraints],
    openLoops: [...snapshot.openLoops],
    keyReferences: [...snapshot.keyReferences],
    rollingSummary: snapshot.rollingSummary,
    ...(snapshot.summarizedFromMessageId
      ? { summarizedFromMessageId: snapshot.summarizedFromMessageId }
      : {}),
    ...(snapshot.summarizedThroughMessageId
      ? { summarizedThroughMessageId: snapshot.summarizedThroughMessageId }
      : {}),
    sourceMessageCount: snapshot.sourceMessageCount,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt
  };
}

function migrationConversationSourceRecord(session: StoredSession): unknown {
  return {
    id: session.id,
    title: session.title,
    kind: session.kind ?? "chat",
    revision: session.revision ?? null,
    generation: session.generation ?? null,
    contextId: session.contextId ?? null,
    contextStartsAfterMessageId: session.contextStartsAfterMessageId ?? null,
    workspaceFingerprint: session.workspaceFingerprint ?? null,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function legacyMessageProductRecord(message: ChatMessage): {
  id: string;
  role: ChatMessage["role"];
  text: string;
  turnId: string | null;
  previewText: string | null;
  raw: MessageV2["raw"] | null;
  presentation: Presentation | null;
  createdAt: number;
  completedAt: number | null;
} {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId ?? null,
    previewText: message.previewText ?? null,
    raw: message.rawRef
      ? {
        ref: message.rawRef,
        size: nonNegativeSafeInteger(message.rawSize) ?? 0,
        lines: nonNegativeSafeInteger(message.rawLines) ?? 0,
        truncatedForPreview: message.rawTruncatedForPreview === true
      }
      : null,
    presentation: legacyMessagePresentation(message),
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? null
  };
}

function messageProductRecord(message: MessageV2): unknown {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId ?? null,
    previewText: message.previewText ?? null,
    raw: message.raw ?? null,
    presentation: message.presentation ?? null,
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? null
  };
}

function currentContextBoundaryMessageId(
  commit: ConversationCommitV2
): string | null {
  const firstCurrentIndex = commit.payload.messages.findIndex(
    (message) => message.contextId === commit.metadata.currentContext.id
  );
  return firstCurrentIndex > 0
    ? commit.payload.messages[firstCurrentIndex - 1].id
    : null;
}

function legacyMessagePresentation(
  message: ChatMessage
): Presentation | null {
  const candidate: Presentation = {
    schemaVersion: CONVERSATION_PRESENTATION_SCHEMA_VERSION,
    ...(message.itemType !== undefined
      ? { itemType: message.itemType }
      : {}),
    ...(message.title !== undefined ? { title: message.title } : {}),
    ...(message.status !== undefined ? { status: message.status } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
    ...(message.attachments !== undefined
      ? { attachments: cloneJsonValue(message.attachments) }
      : {}),
    ...(message.images !== undefined
      ? { images: cloneJsonValue(message.images) }
      : {}),
    ...(message.files !== undefined
      ? { files: cloneJsonValue(message.files) }
      : {}),
    ...(message.citations !== undefined
      ? { citations: cloneJsonValue(message.citations) }
      : {}),
    ...(message.diffSummary !== undefined
      ? { diffSummary: cloneJsonValue(message.diffSummary) }
      : {}),
    ...(message.knowledgeBaseUi !== undefined
      ? { knowledgeBaseUi: cloneJsonValue(message.knowledgeBaseUi) }
      : {})
  };
  return Object.keys(candidate).length === 1 ? null : candidate;
}

function sessionNativeEvidence(
  session: StoredSession
): Record<string, unknown> | null {
  const value = {
    threadId: session.threadId ?? null,
    backendBindings: session.backendBindings ?? null
  };
  return value.threadId === null && value.backendBindings === null
    ? null
    : value;
}

function sessionSettingsProjectionEvidence(
  session: StoredSession
): Record<string, unknown> | null {
  const value = {
    messagesHiddenBefore: session.messagesHiddenBefore ?? null,
    historyActiveDate: session.historyActiveDate ?? null,
    rollingSummary: session.rollingSummary ?? null
  };
  return Object.values(value).every((item) => item === null)
    ? null
    : value;
}

function messageNativeEvidence(
  message: ChatMessage
): Record<string, unknown> | null {
  const value = {
    backendId: message.backendId ?? null,
    modelId: message.modelId ?? null,
    profileId: message.profileId ?? null,
    nativeExecutionIdHash: message.nativeExecutionIdHash ?? null,
    contextMode: message.contextMode ?? null,
    contextCompiledThroughMessageId:
      message.contextCompiledThroughMessageId ?? null,
    contextSnapshotVersion: message.contextSnapshotVersion ?? null,
    nativeLeaseId: message.nativeLeaseId ?? null,
    nativeLeaseStatus: message.nativeLeaseStatus ?? null,
    nativeLeaseTurnCount: message.nativeLeaseTurnCount ?? null,
    nativeLeaseReused: message.nativeLeaseReused ?? null,
    nativeLocalCommitStatus: message.nativeLocalCommitStatus ?? null,
    nativeCleanupStatus: message.nativeCleanupStatus ?? null
  };
  return Object.values(value).every((item) => item === null) ? null : value;
}

function messageRunEvidence(
  message: ChatMessage
): Record<string, unknown> | null {
  const value = {
    runId: message.runId ?? null,
    phase: message.phase ?? null,
    processKind: message.processKind ?? null,
    processContentAvailability: message.processContentAvailability ?? null,
    processInput: message.processInput ?? null,
    processOutput: message.processOutput ?? null,
    processInputAvailability: message.processInputAvailability ?? null,
    processOutputAvailability: message.processOutputAvailability ?? null,
    runUsage: message.runUsage ?? null,
    runTerminalRecoveryPending: message.runTerminalRecoveryPending ?? null,
    echoInkRunTerminalRecovery: message.echoInkRunTerminalRecovery ?? null,
    runTerminalRecovered: message.runTerminalRecovered ?? null
  };
  return Object.values(value).every((item) => item === null) ? null : value;
}

function cloneJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isConversationMessageV2(
  value: ChatMessage | MessageV2
): value is MessageV2 {
  return (
    "schemaVersion" in value
    && value.schemaVersion === CONVERSATION_V2_SCHEMA_VERSION
    && "recordType" in value
    && value.recordType === "conversation-message"
  );
}

function legacyContextId(conversationId: string, segment: string): string {
  return `legacy-context-${createHash("sha256")
    .update(JSON.stringify([conversationId, segment]), "utf8")
    .digest("hex")}`;
}

function normalizedIdentifier(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value.length <= 512
    ? value
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function assertExactLegacyKeys(
  value: object,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Conversation migration blocked: ${label} contains unknown field ${key}`
      );
    }
  }
}
