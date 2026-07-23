import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BackendSessionBinding } from "../contracts/run";
import type { SessionContextSnapshot } from "../contracts/context";
import { isSafeNativeExecutionTransport } from "../contracts/native-execution";
import type { ChatMessage, StoredSession, StoredSessionKind } from "../../settings/settings";
import { messagesInCurrentSessionContext, sessionGeneration } from "../kernel/session-service";
import {
  isSafeConversationSessionId
} from "./storage-contract";
import {
  projectDurableKnowledgeBaseUi
} from "./conversation-content-projection";

const V1_EXPORT_ROOT_DIRECTORY = "conversation-v1-exports";
const V1_EXPORT_GENERATION_PATTERN = /^export-[a-f0-9]{64}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const V1_EXPORT_PLAN_FILE = "plan.json";
const V1_EXPORT_PLAN_MAX_BYTES = 64 * 1024;
const V1_EXPORT_PLAN_KEYS = new Set([
  "schemaVersion",
  "recordType",
  "projection",
  "generationId",
  "sourceStoreVersion",
  "targetStoreVersion",
  "sourceManifestDigest",
  "sourceFingerprint",
  "digest"
]);
const PORTABLE_MIGRATION_SESSION_KEYS = new Set([
  "id",
  "title",
  "kind",
  "revision",
  "generation",
  "contextId",
  "contextStartsAfterMessageId",
  "commitId",
  "workspaceFingerprint",
  "contextSnapshot",
  "rollingSummary",
  "cwd",
  "messages",
  "createdAt",
  "updatedAt"
]);
const PORTABLE_MIGRATION_MESSAGE_KEYS = new Set([
  "id",
  "role",
  "text",
  "previewText",
  "rawRef",
  "rawSize",
  "rawLines",
  "rawTruncatedForPreview",
  "turnId",
  "itemType",
  "title",
  "status",
  "details",
  "diffSummary",
  "citations",
  "knowledgeBaseUi",
  "attachments",
  "files",
  "images",
  "createdAt",
  "completedAt"
]);

export interface ConversationStoreOptions {
  rootPath: string;
  now?: () => number;
  beforeContextCommitMarker?: (sessionId: string) => void | Promise<void>;
  afterContextCommitMarker?: (sessionId: string) => void;
  afterContextPayloadAddressed?: (
    sessionId: string,
    payloadKey: string | undefined
  ) => void | Promise<void>;
  beforeContextPayloadGc?: (sessionId: string, payloadKey: string) => void | Promise<void>;
  afterPristineDirectoryCommitBeforeIndex?: (
    sessionId: string
  ) => void | Promise<void>;
  afterDeletionTombstoneBeforeIndex?: (
    sessionId: string
  ) => void | Promise<void>;
}

export interface ConversationSessionSummary {
  sessionId: string;
  title: string;
  kind?: StoredSessionKind;
  messageCount: number;
  updatedAt: number;
}

interface ConversationStoreIndex {
  version: 1;
  updatedAt: number;
  sessions: ConversationSessionSummary[];
}

interface ConversationSessionMetadata {
  id: string;
  title: string;
  kind?: StoredSessionKind;
  threadId?: string;
  backendBindings?: Record<string, BackendSessionBinding>;
  revision?: number;
  generation?: number;
  contextId?: string;
  contextStartsAfterMessageId?: string;
  commitId?: string;
  workspaceFingerprint?: string;
  contextSnapshot?: SessionContextSnapshot;
  cwd: string;
  rollingSummary?: StoredSession["rollingSummary"];
  messagesHiddenBefore?: number;
  historyActiveDate?: string;
  tokenUsage?: StoredSession["tokenUsage"];
  payloadVersion?: 2;
  payloadKey?: string;
  previousPayloadKey?: string;
  previousPayloadCommitId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationStoreMigrationResult {
  sessionCount: number;
  messageCount: number;
  trimmedSettingsMessageCount: number;
}

export interface ConversationStoreMigrationSnapshot {
  sessions: StoredSession[];
  deletionTombstones: ConversationDeletionTombstoneV1[];
}

export type ConversationStoreMigrationImportStatus =
  | "created"
  | "reused"
  | "conflict";

export interface ConversationStoreMigrationImportPlanBinding {
  generationId: string;
  planDigest: string;
}

export interface ConversationStoreStartupReconciliationResult {
  sessions: StoredSession[];
  repairedIndex: boolean;
  recoveredIndexSessionIds: string[];
  deletedSessionIds: string[];
}

export interface CommitConversationContextOptions {
  expectedGeneration: number;
  expectedCommitId?: string;
  expectedContentRevision: string;
}

export interface ConversationRecordMutationSource {
  sourceRelativePath: string;
}

export interface PlanConversationRecordMutationSourcesInput {
  operation: "clear-conversation-records" | "delete-conversation";
  conversationId: string;
  expectedGeneration: number;
  expectedCommitId: string;
  expectedContentRevision: string;
}

export interface CommitConversationRecordClearOptions
extends CommitConversationContextOptions {
  mutationId?: string;
  sourceRelativePaths: readonly string[];
}

export interface CommitConversationHistoryRestoreOptions
extends CommitConversationContextOptions {
  mutationId: string;
}

export interface CommitConversationDeletionTombstoneOptions
extends CommitConversationContextOptions {
  sourceRelativePaths?: readonly string[];
}

export interface ConversationDeletionTombstoneV1 {
  schemaVersion: 1;
  kind: "conversation-deletion-tombstone";
  conversationId: string;
  mutationId: string;
  tombstoneId: string;
  sourceGeneration: number;
  sourceCommitId: string;
  sourceContentRevision: string;
  deletedAt: number;
  digest: string;
}

export interface ConversationContextCommitReceipt {
  conversationId: string;
  generation: number;
  contextId?: string;
  contextStartsAfterMessageId?: string;
  commitId: string;
  workspaceFingerprint?: string;
}

export interface ConversationAuthorityProbe {
  conversationId: string;
  targetGeneration: number;
  targetContextId?: string;
  targetCommitId: string;
  targetWorkspaceFingerprint?: string;
}

export interface ConversationAuthorityProof {
  conversationId: string;
  currentGeneration: number;
  currentContextId?: string;
  currentCommitId?: string;
  currentWorkspaceFingerprint?: string;
  targetPayload: "active" | "previous" | "absent";
  relation: "exact" | "before" | "later" | "conflict";
}

export interface ConversationMessageAuthorityProbe {
  conversationId: string;
  messageId: string;
  expectedMessage: ChatMessage;
}

export interface ConversationMessageAuthorityProof {
  conversationId: string;
  messageId: string;
  state: "durable" | "absent" | "conflict";
  expectedPayloadDigest: string;
  matchingMessageCount: number;
  currentPayloadDigests: string[];
}

export class ConversationContextConflictError extends Error {
  readonly code = "conversation_context_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ConversationContextConflictError";
  }
}

export class FileConversationStore {
  private readonly now: () => number;
  private readonly sessionCommitTails = new Map<string, Promise<void>>();
  private indexCommitTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConversationStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get rootPath(): string {
    return path.resolve(this.options.rootPath);
  }

  async persistSettingsSessions(
    settings: { sessions: StoredSession[] },
    options: {
      trimSettingsMessages?: boolean;
      afterSessionPersisted?: (session: StoredSession) => void;
    } = {}
  ): Promise<ConversationStoreMigrationResult> {
    let messageCount = 0;
    let trimmedSettingsMessageCount = 0;
    for (const session of settings.sessions) {
      messageCount += session.messages.length;
      await this.upsertSession(session);
      options.afterSessionPersisted?.(session);
      if (options.trimSettingsMessages && session.messages.length) {
        trimmedSettingsMessageCount += session.messages.length;
        session.messages = [];
      }
    }
    return {
      sessionCount: settings.sessions.length,
      messageCount,
      trimmedSettingsMessageCount
    };
  }

  async upsertSession(session: StoredSession): Promise<void> {
    this.sessionDir(session.id);
    const callerContentRevision = createConversationContentRevision(session);
    const callerThreadId = normalizedOptionalString(session.threadId);
    const candidate = cloneStoredSession(session);
    await this.withSessionCommit(
      candidate.id,
      async () => await this.upsertSessionUnlocked(candidate)
    );
    if (
      createConversationContentRevision(session) === callerContentRevision
      && normalizedOptionalString(session.threadId) === callerThreadId
    ) {
      synchronizeDerivedSessionContext(session, candidate);
    }
  }

  async createPristineSession(session: StoredSession): Promise<void> {
    assertPristineConversationCandidate(session);
    this.sessionDir(session.id);
    await this.withSessionCommit(session.id, async () =>
      await this.withIndexCommit(async () =>
        await this.createPristineSessionWithIndexLock(session)
      )
    );
  }

  /**
   * Restore-only V1 compatibility writer. It is deliberately unavailable for
   * the live legacy root and only accepts an exporter-managed generation.
   * Missing records are created, exact records are reused, and conflicts are
   * never overwritten.
   */
  async importMigrationSession(
    sessionInput: StoredSession,
    planBinding: ConversationStoreMigrationImportPlanBinding
  ): Promise<ConversationStoreMigrationImportStatus> {
    await assertConversationV1ExportTargetRoot(
      this.rootPath,
      planBinding
    );
    const candidate = validateConversationMigrationImportSession(sessionInput);
    const seed = migrationImportSeed(candidate);
    return await this.withSessionCommit(candidate.id, async () => {
      if (await this.readConversationDeletionTombstone(candidate.id)) {
        return "conflict";
      }
      const existing = await this.readMigrationImportSession(candidate.id);
      const normalizedExisting = existing
        ? cloneStoredSession(existing)
        : null;
      if (normalizedExisting && isDeepStrictEqual(
        normalizedExisting,
        candidate
      )) {
        await this.withIndexCommit(async () =>
          await this.ensureMigrationImportIndex(
            normalizedExisting,
            candidate
          ));
        return "reused";
      }
      if (
        normalizedExisting
        && !isDeepStrictEqual(normalizedExisting, seed)
      ) {
        return "conflict";
      }

      await this.withIndexCommit(async () => {
        if (normalizedExisting) {
          await this.ensureMigrationImportIndex(
            normalizedExisting,
            candidate
          );
        } else {
          await this.createPristineSessionWithIndexLock(seed);
        }
        if (!isDeepStrictEqual(seed, candidate)) {
          await this.upsertSessionWithIndexLock(candidate, {
            strictIndex: true,
            preserveContextSnapshot: true
          });
        }
      });

      const readback = await this.readSession(candidate.id);
      if (!readback || !isDeepStrictEqual(readback, candidate)) {
        throw new ConversationContextConflictError(
          "Conversation migration import readback does not match its candidate"
        );
      }
      return "created";
    });
  }

  /**
   * Restore-only deletion import. A V2 tombstone is copied as immutable
   * authority without manufacturing a fake active V1 Conversation first.
   */
  async importMigrationDeletionTombstone(
    tombstoneInput: ConversationDeletionTombstoneV1,
    planBinding: ConversationStoreMigrationImportPlanBinding
  ): Promise<ConversationStoreMigrationImportStatus> {
    await assertConversationV1ExportTargetRoot(
      this.rootPath,
      planBinding
    );
    const tombstone = parseConversationDeletionTombstone(tombstoneInput);
    this.sessionDir(tombstone.conversationId);
    return await this.withSessionCommit(
      tombstone.conversationId,
      async () => await this.withIndexCommit(async () => {
        const existing = await this.readConversationDeletionTombstone(
          tombstone.conversationId
        );
        if (existing) {
          if (!isDeepStrictEqual(existing, tombstone)) return "conflict";
          await this.removeConversationFromIndexProjection(
            tombstone.conversationId
          );
          return "reused";
        }
        if (await this.readMigrationImportSession(tombstone.conversationId)) {
          return "conflict";
        }
        await this.writeJsonFile(
          this.deletionTombstonePath(tombstone.conversationId),
          tombstone
        );
        const readback = await this.readConversationDeletionTombstone(
          tombstone.conversationId
        );
        if (!readback || !isDeepStrictEqual(readback, tombstone)) {
          throw new ConversationContextConflictError(
            "Conversation migration tombstone readback does not match"
          );
        }
        await this.options.afterDeletionTombstoneBeforeIndex?.(
          tombstone.conversationId
        );
        await this.removeConversationFromIndexProjection(
          tombstone.conversationId
        );
        return "created";
      })
    );
  }

  async commitSessionContext(
    session: StoredSession,
    options: CommitConversationContextOptions
  ): Promise<ConversationContextCommitReceipt> {
    this.sessionDir(session.id);
    return await this.withSessionCommit(session.id, async () => {
      const currentMetadata = await this.readSessionMetadata(session.id);
      if (!currentMetadata) {
        throw new ConversationContextConflictError(`Conversation ${session.id} is missing`);
      }
      const current = await this.readSession(session.id);
      if (!current) {
        throw new ConversationContextConflictError(`Conversation ${session.id} is missing`);
      }
      const currentGeneration = sessionGeneration(current);
      const currentCommitId = current.commitId?.trim() || undefined;
      const currentContentRevision = createConversationContentRevision(current);
      if (
        currentGeneration !== options.expectedGeneration
        || currentCommitId !== (options.expectedCommitId?.trim() || undefined)
        || currentContentRevision !== options.expectedContentRevision
      ) {
        throw new ConversationContextConflictError(
          `Conversation ${session.id} changed before context commit`
        );
      }

      assertContextCommitCandidate(session, current, currentMetadata);

      await this.upsertSessionUnlocked(session, { strictIndex: true });
      return contextCommitReceipt(session);
    });
  }

  async planConversationRecordMutationSources(
    input: PlanConversationRecordMutationSourcesInput
  ): Promise<ConversationRecordMutationSource[]> {
    this.sessionDir(input.conversationId);
    return await this.withSessionCommit(input.conversationId, async () => {
      const metadata = await this.readSessionMetadata(input.conversationId);
      const current = await this.readSession(input.conversationId);
      if (!metadata || !current) {
        throw new ConversationContextConflictError(
          `Conversation ${input.conversationId} is missing`
        );
      }
      assertExpectedConversation(
        current,
        input.expectedGeneration,
        input.expectedCommitId,
        input.expectedContentRevision
      );
      const sourceRelativePaths = input.operation === "delete-conversation"
        ? [conversationSessionRelativePath(input.conversationId)]
        : await this.discoverConversationPayloadSourceRelativePaths(
          input.conversationId,
          metadata
        );
      await this.assertRecordMutationSources(sourceRelativePaths);
      return sourceRelativePaths.map((sourceRelativePath) => ({
        sourceRelativePath
      }));
    });
  }

  async commitConversationRecordClear(
    session: StoredSession,
    options: CommitConversationRecordClearOptions
  ): Promise<ConversationContextCommitReceipt> {
    this.sessionDir(session.id);
    return await this.withSessionCommit(session.id, async () => {
      const metadata = await this.readSessionMetadata(session.id);
      const current = await this.readSession(session.id);
      if (!metadata || !current) {
        throw new ConversationContextConflictError(
          `Conversation ${session.id} is missing`
        );
      }
      assertExpectedConversation(
        current,
        options.expectedGeneration,
        options.expectedCommitId,
        options.expectedContentRevision
      );
      const currentSources = await this.discoverConversationPayloadSourceRelativePaths(
        session.id,
        metadata
      );
      const plannedSources = normalizeRecordMutationSourceRelativePaths(
        options.sourceRelativePaths
      );
      if (!isDeepStrictEqual(currentSources, plannedSources)) {
        throw new ConversationContextConflictError(
          `Conversation ${session.id} source plan changed before record clear`
        );
      }
      await this.assertRecordMutationSources(currentSources);
      assertConversationRecordClearCandidate(session, current, metadata);
      await this.upsertSessionUnlocked(session, {
        strictIndex: true,
        recordMutationPayloadReplacement: true
      });
      return contextCommitReceipt(session);
    });
  }

  async commitConversationHistoryRestore(
    session: StoredSession,
    options: CommitConversationHistoryRestoreOptions
  ): Promise<ConversationContextCommitReceipt> {
    this.sessionDir(session.id);
    return await this.withSessionCommit(session.id, async () => {
      const metadata = await this.readSessionMetadata(session.id);
      const current = await this.readSession(session.id);
      if (!metadata || !current) {
        throw new ConversationContextConflictError(
          `Conversation ${session.id} is missing`
        );
      }
      if (!options.mutationId.trim()) {
        throw new ConversationContextConflictError(
          "Conversation history restore requires its mutationId"
        );
      }
      assertExpectedConversation(
        current,
        options.expectedGeneration,
        options.expectedCommitId,
        options.expectedContentRevision
      );
      assertConversationHistoryRestoreCandidate(session, current, metadata);
      await this.upsertSessionUnlocked(session, {
        strictIndex: true,
        recordMutationPayloadReplacement: true
      });
      return contextCommitReceipt(session);
    });
  }

  async commitConversationDeletionTombstone(
    tombstoneInput: ConversationDeletionTombstoneV1,
    options: CommitConversationDeletionTombstoneOptions
  ): Promise<ConversationDeletionTombstoneV1> {
    const tombstone = parseConversationDeletionTombstone(tombstoneInput);
    this.sessionDir(tombstone.conversationId);
    if (
      tombstone.sourceGeneration !== options.expectedGeneration
      || tombstone.sourceCommitId
        !== normalizedOptionalString(options.expectedCommitId)
      || tombstone.sourceContentRevision !== options.expectedContentRevision
    ) {
      throw new ConversationContextConflictError(
        `Conversation ${tombstone.conversationId} tombstone source authority changed`
      );
    }
    return await this.withSessionCommit(
      tombstone.conversationId,
      async () => await this.withIndexCommit(async () => {
        const existing = await this.readConversationDeletionTombstone(
          tombstone.conversationId
        );
        if (existing) {
          if (existing.digest !== tombstone.digest) {
            throw new ConversationContextConflictError(
              `Conversation ${tombstone.conversationId} deletion tombstone conflicts`
            );
          }
          await this.removeConversationFromIndexProjection(
            tombstone.conversationId
          );
          return existing;
        }
        const current = await this.readSession(tombstone.conversationId);
        if (!current) {
          throw new ConversationContextConflictError(
            `Conversation ${tombstone.conversationId} is missing`
          );
        }
        assertExpectedConversation(
          current,
          options.expectedGeneration,
          options.expectedCommitId,
          options.expectedContentRevision
        );
        await this.writeJsonFile(
          this.deletionTombstonePath(tombstone.conversationId),
          tombstone
        );
        const readback = await this.readConversationDeletionTombstone(
          tombstone.conversationId
        );
        if (!readback || readback.digest !== tombstone.digest) {
          throw new ConversationContextConflictError(
            `Conversation ${tombstone.conversationId} deletion tombstone readback failed`
          );
        }
        await this.options.afterDeletionTombstoneBeforeIndex?.(
          tombstone.conversationId
        );
        await this.removeConversationFromIndexProjection(
          tombstone.conversationId
        );
        return readback;
      })
    );
  }

  async readConversationDeletionTombstone(
    conversationId: string
  ): Promise<ConversationDeletionTombstoneV1 | null> {
    const text = await this.readTextFile(
      this.deletionTombstonePath(conversationId),
      { allowMissing: true }
    );
    if (!text?.trim()) return null;
    try {
      return parseConversationDeletionTombstone(
        JSON.parse(text) as unknown
      );
    } catch (error) {
      throw new ConversationContextConflictError(
        `Conversation ${conversationId} deletion tombstone is corrupt: ${errorMessage(error)}`
      );
    }
  }

  async proveSessionContextAuthority(
    probe: ConversationAuthorityProbe
  ): Promise<ConversationAuthorityProof> {
    this.sessionDir(probe.conversationId);
    return await this.withSessionCommit(probe.conversationId, async () => {
      if (!isPositiveSafeInteger(probe.targetGeneration) || !probe.targetCommitId.trim()) {
        throw new Error("Conversation recovery required: authority probe target is invalid");
      }
      await this.readIndexStrict(probe.conversationId);
      const metadata = await this.readSessionMetadata(probe.conversationId);
      if (!metadata) {
        throw new Error(
          `Conversation recovery required: conversation ${probe.conversationId} is missing`
        );
      }
      const current = await this.readSession(probe.conversationId);
      if (!current) {
        throw new Error(
          `Conversation recovery required: conversation ${probe.conversationId} is missing`
        );
      }
      const activePayloadKey = normalizePayloadKey(metadata.payloadKey);
      const previousPayloadKey = normalizePayloadKey(metadata.previousPayloadKey);
      const targetCommitId = probe.targetCommitId.trim();
      const targetPayload = (
        activePayloadKey
        && normalizedOptionalString(metadata.commitId) === targetCommitId
      )
        ? "active"
        : (
          previousPayloadKey
          && metadataPreviousPayloadMatchesCommitId(metadata, targetCommitId)
        )
          ? "previous"
          : "absent";
      const currentGeneration = sessionGeneration(current);
      const exactIdentity = current.commitId?.trim() === probe.targetCommitId.trim()
        && normalizedOptionalString(current.contextId)
          === normalizedOptionalString(probe.targetContextId)
        && normalizedOptionalString(current.workspaceFingerprint)
          === normalizedOptionalString(probe.targetWorkspaceFingerprint);
      const relation = currentGeneration === probe.targetGeneration
        ? exactIdentity && targetPayload === "active" ? "exact" : "conflict"
        : targetPayload === "active"
          ? "conflict"
          : currentGeneration < probe.targetGeneration
            ? "before"
            : "later";
      return {
        conversationId: current.id,
        currentGeneration,
        ...(current.contextId ? { currentContextId: current.contextId } : {}),
        ...(current.commitId ? { currentCommitId: current.commitId } : {}),
        ...(current.workspaceFingerprint
          ? { currentWorkspaceFingerprint: current.workspaceFingerprint }
          : {}),
        targetPayload,
        relation
      };
    });
  }

  async proveMessageAuthority(
    probe: ConversationMessageAuthorityProbe
  ): Promise<ConversationMessageAuthorityProof> {
    this.sessionDir(probe.conversationId);
    if (
      !probe.messageId.trim()
      || probe.expectedMessage.id !== probe.messageId
    ) {
      throw new Error(
        "Conversation recovery required: message authority probe is invalid"
      );
    }
    validateChatMessage(probe.expectedMessage);
    const expectedPayloadDigest = createConversationMessageRevision(
      probe.expectedMessage
    );
    return await this.withSessionCommit(probe.conversationId, async () => {
      const current = await this.readSession(probe.conversationId);
      const matching = current?.messages.filter(
        (message) => message.id === probe.messageId
      ) ?? [];
      const currentPayloadDigests = matching.map(
        createConversationMessageRevision
      );
      const state = matching.length === 0
        ? "absent"
        : matching.length === 1
          && currentPayloadDigests[0] === expectedPayloadDigest
          ? "durable"
          : "conflict";
      return {
        conversationId: probe.conversationId,
        messageId: probe.messageId,
        state,
        expectedPayloadDigest,
        matchingMessageCount: matching.length,
        currentPayloadDigests
      };
    });
  }

  private async upsertSessionUnlocked(
    session: StoredSession,
    options: {
      strictIndex?: boolean;
      createPristine?: boolean;
      recordMutationPayloadReplacement?: boolean;
      preserveContextSnapshot?: boolean;
    } = {}
  ): Promise<void> {
    await this.withIndexCommit(async () => {
      await this.upsertSessionWithIndexLock(session, options);
    });
  }

  private async createPristineSessionWithIndexLock(
    session: StoredSession
  ): Promise<void> {
    if (await this.readConversationDeletionTombstone(session.id)) {
      throw new ConversationContextConflictError(
        `Conversation ${session.id} has a durable deletion tombstone`
      );
    }
    const candidate = JSON.parse(JSON.stringify(session)) as StoredSession;
    const candidateMessages = candidate.messages.map(validateChatMessage);
    const candidateSnapshots: SessionContextSnapshot[] = [];
    const payloadKey = candidate.commitId
      ? createConversationPayloadKeyV2(
        candidate.commitId,
        candidateMessages,
        candidateSnapshots
      )
      : undefined;
    const metadata = metadataFromSession(candidate, payloadKey);
    validateConversationSessionMetadata(metadata, candidate.id);
    validateCommittedConversationPayload(
      metadata,
      candidateMessages,
      candidateSnapshots
    );
    const summary: ConversationSessionSummary = {
      sessionId: candidate.id,
      title: candidate.title,
      kind: candidate.kind,
      messageCount: 0,
      updatedAt: candidate.updatedAt
    };
    if (!isConversationSessionSummary(summary)) {
      throw new ConversationContextConflictError(
        "Pristine conversation index summary is invalid"
      );
    }

    const target = this.sessionDir(candidate.id);
    if (await this.sessionDirectoryExists(candidate.id)) {
      const existingMetadata = await this.readSessionMetadata(candidate.id);
      if (!existingMetadata) {
        throw new Error(
          `Conversation recovery required: prepared conversation ${candidate.id} has no durable marker`
        );
      }
      const existingPayload = await this.readCommittedPayload(
        candidate.id,
        existingMetadata
      );
      const existing = storedSessionFromCommittedPayload(
        existingMetadata,
        existingPayload
      );
      if (
        createConversationContentRevision(existing)
        !== createConversationContentRevision(candidate)
      ) {
        throw new ConversationContextConflictError(
          `Conversation ${candidate.id} already exists with different durable content`
        );
      }
      const repairIndex = await this.readIndexForPristineRepair(candidate.id);
      await this.upsertIndex(summary, repairIndex, true);
      return;
    }

    const index = await this.readIndexForMutation(candidate.id, true);
    const prepareRoot = path.join(
      path.resolve(this.options.rootPath),
      ".conversation-prepares"
    );
    await this.assertDirectoryBoundary(prepareRoot, { create: true });
    const prepared = path.join(
      prepareRoot,
      `${candidate.id}-${randomUUID()}`
    );
    await this.assertDirectoryBoundary(prepared, { create: true });
    try {
      const messagesPath = payloadKey
        ? path.join(prepared, "context-payloads", payloadKey, "messages.jsonl")
        : path.join(prepared, "messages.jsonl");
      const snapshotsPath = payloadKey
        ? path.join(prepared, "context-payloads", payloadKey, "snapshots.jsonl")
        : path.join(prepared, "snapshots.jsonl");
      await this.writeJsonlFile(messagesPath, candidateMessages);
      await this.writeJsonlFile(snapshotsPath, candidateSnapshots);
      await this.writeJsonFile(path.join(prepared, "metadata.json"), metadata);
      await this.options.beforeContextCommitMarker?.(candidate.id);
      if (await this.sessionDirectoryExists(candidate.id)) {
        throw new ConversationContextConflictError(
          `Conversation ${candidate.id} appeared before pristine commit`
        );
      }
      await this.assertDirectoryBoundary(prepared);
      await this.assertDirectoryBoundary(path.dirname(target), { create: true });
      await rename(prepared, target);
      await this.assertDirectoryBoundary(target);
      await this.options.afterPristineDirectoryCommitBeforeIndex?.(candidate.id);
      await this.upsertIndex(summary, index, true);
      try {
        this.options.afterContextCommitMarker?.(candidate.id);
      } catch {
        // Diagnostic observers cannot reverse the committed create.
      }
    } catch (error) {
      const preparedExists = await this.assertDirectoryBoundary(prepared, {
        allowMissing: true
      }).catch(() => false);
      if (preparedExists) {
        await rm(prepared, { recursive: true, force: false }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async upsertSessionWithIndexLock(
    session: StoredSession,
    options: {
      strictIndex?: boolean;
      createPristine?: boolean;
      recordMutationPayloadReplacement?: boolean;
      preserveContextSnapshot?: boolean;
    }
  ): Promise<void> {
    if (await this.readConversationDeletionTombstone(session.id)) {
      throw new ConversationContextConflictError(
        `Conversation ${session.id} has a durable deletion tombstone`
      );
    }
    const previousMetadata = await this.readSessionMetadata(session.id);
    const sessionDirectoryExists = await this.sessionDirectoryExists(session.id);
    if (options.createPristine && (previousMetadata || sessionDirectoryExists)) {
      throw new ConversationContextConflictError(
        `Conversation ${session.id} already exists`
      );
    }
    if (!previousMetadata && sessionDirectoryExists) {
      throw new Error(
        `Conversation recovery required: unindexed session directory ${session.id} already exists`
      );
    }
    const allowInsert = options.createPristine === true
      && previousMetadata === null
      && !sessionDirectoryExists;
    const index = options.strictIndex
      ? await this.readIndexStrict(session.id)
      : await this.readIndexForMutation(
        session.id,
        allowInsert
      );
    if (!previousMetadata && !sessionDirectoryExists) {
      if (index.sessions.some((summary) => summary.sessionId === session.id)) {
        throw new Error(
          `Conversation recovery required: metadata for indexed conversation ${session.id} is missing`
        );
      }
      if (!allowInsert) {
        throw new ConversationContextConflictError(
          `Conversation ${session.id} is missing; use createPristineSession for an explicit runtime create`
        );
      }
    }
    const previousPayload = previousMetadata
      ? await this.readCommittedPayload(session.id, previousMetadata)
      : null;
    if (previousMetadata && !options.strictIndex) {
      assertOrdinaryUpsertContextIdentity(session, previousMetadata);
    }
    if (!options.preserveContextSnapshot) {
      refreshSessionContextSnapshot(session, this.now());
    }
    const candidateMessages = session.messages.map(validateChatMessage);
    const candidateSnapshots = session.contextSnapshot ? [session.contextSnapshot] : [];
    const validatedSnapshots = candidateSnapshots.map((snapshot) =>
      validateSessionContextSnapshot(snapshot, session.id)
    );
    if (
      previousMetadata
      && !options.strictIndex
      && !hasCompleteConversationContextIdentity(previousMetadata)
      && (
        !isDeepStrictEqual(candidateMessages, previousPayload?.messages ?? [])
        || !isDeepStrictEqual(validatedSnapshots, previousPayload?.snapshots ?? [])
      )
    ) {
      throw new ConversationContextConflictError(
        "Conversation payload mutation requires a complete durable Context identity"
      );
    }
    const payloadKey = session.commitId
      ? createConversationPayloadKeyV2(
        session.commitId,
        candidateMessages,
        validatedSnapshots
      )
      : undefined;
    const previousPayloadPointer = options.recordMutationPayloadReplacement
      ? {}
      : resolvePreviousPayload(payloadKey, previousMetadata);
    const metadata = metadataFromSession(
      session,
      payloadKey,
      previousPayloadPointer
    );
    validateConversationSessionMetadata(metadata, session.id);
    validateCommittedConversationPayload(
      metadata,
      candidateMessages,
      validatedSnapshots
    );
    const candidateIndexSummary: ConversationSessionSummary = {
      sessionId: session.id,
      title: session.title,
      kind: session.kind,
      messageCount: session.messages.length,
      updatedAt: session.updatedAt
    };
    if (!isConversationSessionSummary(candidateIndexSummary)) {
      throw new Error(
        "Conversation recovery required: candidate conversation index summary is invalid"
      );
    }
    await this.options.afterContextPayloadAddressed?.(session.id, payloadKey);
    const messagesPath = payloadKey
      ? this.commitMessagesPath(session.id, payloadKey)
      : this.messagesPath(session.id);
    const snapshotsPath = payloadKey
      ? this.commitSnapshotsPath(session.id, payloadKey)
      : this.snapshotsPath(session.id);
    // metadata.json is the context commit marker. Payload and non-authoritative
    // index projections must finish first; no authoritative or outward-failing
    // work may follow it.
    await this.writeJsonlFile(messagesPath, candidateMessages);
    await this.writeJsonlFile(snapshotsPath, validatedSnapshots);
    await this.upsertIndex(
      candidateIndexSummary,
      index,
      allowInsert
    );
    await this.options.beforeContextCommitMarker?.(session.id);
    await this.writeJsonFile(this.metadataPath(session.id), metadata);
    try {
      this.options.afterContextCommitMarker?.(session.id);
    } catch {
      // The authoritative marker is already durable. Diagnostic observers can
      // never turn this committed state into an apparent failure.
    }
    if (!options.recordMutationPayloadReplacement) {
      try {
        await this.gcContextPayloads(
          session.id,
          payloadKey,
          previousPayloadPointer.previousPayloadKey
        );
      } catch {
        // Context payload retention is non-authoritative. A failed cleanup must
        // not reverse the committed marker and will be retried by the next save.
      }
    }
  }

  async readSession(sessionId: string): Promise<StoredSession | null> {
    this.sessionDir(sessionId);
    if (await this.readConversationDeletionTombstone(sessionId)) {
      return null;
    }
    const metadata = await this.readSessionMetadata(sessionId);
    const index = await this.readIndexForMutation(sessionId, metadata === null);
    if (!metadata) {
      if (index.sessions.some((summary) => summary.sessionId === sessionId)) {
        throw new Error(
          `Conversation recovery required: metadata for indexed conversation ${sessionId} is missing`
        );
      }
      if (await this.sessionDirectoryExists(sessionId)) {
        throw new Error(
          `Conversation recovery required: unindexed session directory ${sessionId} already exists`
        );
      }
      return null;
    }
    const { messages, snapshots } = await this.readCommittedPayload(sessionId, metadata);
    return storedSessionFromCommittedPayload(metadata, { messages, snapshots });
  }

  async listSessions(): Promise<StoredSession[]> {
    const index = await this.readIndexForMutation(undefined, false);
    const sessions: StoredSession[] = [];
    for (const summary of index.sessions) {
      const session = await this.readSession(summary.sessionId);
      if (!session) {
        throw new Error(
          `Conversation recovery required: indexed conversation ${summary.sessionId} is unavailable`
        );
      }
      sessions.push(session);
    }
    return sessions;
  }

  /**
   * Strict read-only migration source scan. It reports index or directory
   * drift instead of invoking startup reconciliation or creating empty roots.
   */
  async inspectMigrationSnapshot():
  Promise<ConversationStoreMigrationSnapshot> {
    const rootReady = await this.assertDirectoryBoundary(
      this.options.rootPath,
      { allowMissing: true }
    );
    if (!rootReady) {
      return { sessions: [], deletionTombstones: [] };
    }
    const allowedRootEntries = new Set([
      "index.json",
      "sessions",
      "deletions",
      ".conversation-prepares"
    ]);
    const rootEntries = await readdir(
      this.options.rootPath,
      { withFileTypes: true }
    );
    for (const entry of rootEntries) {
      if (
        !allowedRootEntries.has(entry.name)
        || entry.isSymbolicLink()
        || (
          entry.name === "index.json"
            ? !entry.isFile()
            : !entry.isDirectory()
        )
      ) {
        throw new ConversationContextConflictError(
          `Conversation migration source has an unsafe root entry: ${entry.name}`
        );
      }
    }
    const preparesRoot = path.join(
      this.options.rootPath,
      ".conversation-prepares"
    );
    if (
      await this.assertDirectoryBoundary(preparesRoot, {
        allowMissing: true
      })
      && (await readdir(preparesRoot)).length > 0
    ) {
      throw new ConversationContextConflictError(
        "Conversation migration source has an incomplete prepare"
      );
    }
    const index = await this.readIndex();
    const deletionTombstones =
      await this.readConversationDeletionTombstones();
    const sessions = await this.readCommittedSessionsFromDirectories(
      new Set(deletionTombstones.keys())
    );
    const expectedSummaries = sessions
      .map(conversationSessionSummary)
      .sort(compareConversationSessionSummaries);
    if (!isDeepStrictEqual(index.sessions, expectedSummaries)) {
      throw new ConversationContextConflictError(
        "Conversation migration source index does not match committed sessions"
      );
    }
    return {
      sessions: sessions.sort((left, right) => left.id.localeCompare(right.id)),
      deletionTombstones: [...deletionTombstones.values()].sort(
        (left, right) =>
          left.conversationId.localeCompare(right.conversationId)
      )
    };
  }

  private async readMigrationImportSession(
    sessionId: string
  ): Promise<StoredSession | null> {
    const metadata = await this.readSessionMetadata(sessionId);
    const directoryExists = await this.sessionDirectoryExists(sessionId);
    if (!metadata) {
      if (directoryExists) {
        throw new ConversationContextConflictError(
          `Conversation migration target has an uncommitted session directory: ${sessionId}`
        );
      }
      return null;
    }
    const payload = await this.readCommittedPayload(sessionId, metadata);
    return storedSessionFromCommittedPayload(metadata, payload);
  }

  private async ensureMigrationImportIndex(
    existing: StoredSession,
    pendingCandidate: StoredSession
  ): Promise<void> {
    const index = await this.readIndex();
    const tombstones = await this.readConversationDeletionTombstones();
    const committed = await this.readCommittedSessionsFromDirectories(
      new Set(tombstones.keys())
    );
    const expectedById = new Map(
      committed.map((session) => [
        session.id,
        conversationSessionSummary(session)
      ])
    );
    const existingSummary = conversationSessionSummary(existing);
    const pendingSummary = conversationSessionSummary(pendingCandidate);
    const currentById = new Map(
      index.sessions.map((summary) => [summary.sessionId, summary])
    );
    for (const summary of index.sessions) {
      const expected = expectedById.get(summary.sessionId);
      const currentImportMayBeAhead = (
        summary.sessionId === existing.id
        && isDeepStrictEqual(summary, pendingSummary)
      );
      if (
        !expected
        || (
          !isDeepStrictEqual(summary, expected)
          && !currentImportMayBeAhead
        )
      ) {
        throw new ConversationContextConflictError(
          "Conversation migration target index contains a conflicting projection"
        );
      }
    }
    for (const sessionId of expectedById.keys()) {
      if (currentById.has(sessionId) || sessionId === existing.id) continue;
      throw new ConversationContextConflictError(
        "Conversation migration target index is missing an unrelated session"
      );
    }
    if (currentById.has(existing.id)) return;
    const sessions = [...index.sessions, existingSummary]
      .sort(compareConversationSessionSummaries);
    await this.writeJsonFile(this.indexPath(), {
      version: 1,
      updatedAt: Math.max(index.updatedAt, this.now()),
      sessions
    } satisfies ConversationStoreIndex);
  }

  private async readCommittedPayload(
    sessionId: string,
    metadata: ConversationSessionMetadata
  ): Promise<{
    messages: ChatMessage[];
    snapshots: SessionContextSnapshot[];
  }> {
    const payloadKey = normalizePayloadKey(metadata.payloadKey);
    const messagesPath = payloadKey
      ? this.commitMessagesPath(sessionId, payloadKey)
      : this.messagesPath(sessionId);
    const snapshotsPath = payloadKey
      ? this.commitSnapshotsPath(sessionId, payloadKey)
      : this.snapshotsPath(sessionId);
    await Promise.all([
      this.assertFileBoundary(messagesPath, { allowMissing: true }),
      this.assertFileBoundary(snapshotsPath, { allowMissing: true })
    ]);
    const [messages, snapshots] = await Promise.all([
      readRequiredJsonl<ChatMessage>(
        messagesPath,
        payloadKey
          ? "committed messages payload"
          : "legacy committed messages payload",
        validateChatMessage
      ),
      readRequiredJsonl<SessionContextSnapshot>(
        snapshotsPath,
        payloadKey
          ? "committed snapshots payload"
          : "legacy committed snapshots payload",
        (value) => validateSessionContextSnapshot(value, sessionId)
      )
    ]);
    validateCommittedConversationPayload(metadata, messages, snapshots);
    return { messages, snapshots };
  }

  async readIndex(): Promise<ConversationStoreIndex> {
    const text = await this.readTextFile(this.indexPath(), { allowMissing: true }) ?? "";
    if (!text.trim()) return emptyConversationIndex();
    return parseConversationIndexStrict(text);
  }

  async reconcileCommittedSessionsAtStartup(): Promise<ConversationStoreStartupReconciliationResult> {
    return await this.withIndexCommit(async () => {
      const indexText = await this.readTextFile(this.indexPath(), {
        allowMissing: true
      }) ?? "";
      const hasDurableIndex = Boolean(indexText.trim());
      const currentIndex = hasDurableIndex
        ? parseConversationIndexStrict(indexText)
        : emptyConversationIndex();
      const deletionTombstones =
        await this.readConversationDeletionTombstones();
      const deletedSessionIds = [...deletionTombstones.keys()].sort(
        compareText
      );
      const committedSessions = await this.readCommittedSessionsFromDirectories(
        new Set(deletedSessionIds)
      );
      const committedById = new Map(
        committedSessions.map((session) => [session.id, session])
      );
      const missingCommitted = currentIndex.sessions.find(
        (summary) => (
          !committedById.has(summary.sessionId)
          && !deletionTombstones.has(summary.sessionId)
        )
      );
      if (missingCommitted) {
        throw new ConversationContextConflictError(
          "Conversation index references missing committed session "
          + missingCommitted.sessionId
        );
      }

      const expectedSummaries = committedSessions
        .map(conversationSessionSummary)
        .sort(compareConversationSessionSummaries);
      const currentIds = new Set(
        currentIndex.sessions.map((summary) => summary.sessionId)
      );
      const recoveredIndexSessionIds = expectedSummaries
        .filter((summary) => !currentIds.has(summary.sessionId))
        .map((summary) => summary.sessionId);
      const repairedIndex = !isDeepStrictEqual(
        currentIndex.sessions,
        expectedSummaries
      );
      if (repairedIndex) {
        await this.writeJsonFile(this.indexPath(), {
          version: 1,
          updatedAt: this.now(),
          sessions: expectedSummaries
        } satisfies ConversationStoreIndex);
      }

      return {
        sessions: expectedSummaries.map(
          (summary) => committedById.get(summary.sessionId)!
        ),
        repairedIndex,
        recoveredIndexSessionIds,
        deletedSessionIds
      };
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const sessionDirectory = this.sessionDir(sessionId);
    return await this.withSessionCommit(sessionId, async () =>
      await this.withIndexCommit(async () => {
        const current = await this.readSession(sessionId);
        if (!current) return false;
        if (current.id !== sessionId) {
          throw new Error(
            `Conversation recovery required: session directory ownership mismatch for ${sessionId}`
          );
        }
        const index = await this.readIndexStrict(sessionId);
        const nextSessions = index.sessions.filter((item) => item.sessionId !== sessionId);
        const existed = nextSessions.length !== index.sessions.length;
        if (existed) {
          await this.writeJsonFile(this.indexPath(), {
            version: 1,
            updatedAt: this.now(),
            sessions: nextSessions
          } satisfies ConversationStoreIndex);
        }
        await this.assertDirectoryBoundary(sessionDirectory);
        await rm(sessionDirectory, { recursive: true, force: true });
        return existed;
      })
    );
  }

  private async upsertIndex(
    summary: ConversationSessionSummary,
    index: ConversationStoreIndex,
    allowInsert: boolean
  ): Promise<void> {
    const existingIndex = index.sessions.findIndex((item) => item.sessionId === summary.sessionId);
    if (existingIndex >= 0) index.sessions[existingIndex] = summary;
    else if (!allowInsert) {
      throw new ConversationContextConflictError(
        `Conversation index is missing session ${summary.sessionId}`
      );
    } else {
      index.sessions.push(summary);
    }
    index.sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
    index.updatedAt = this.now();
    await this.writeJsonFile(this.indexPath(), index);
  }

  private async readIndexStrict(requiredSessionId: string): Promise<ConversationStoreIndex> {
    return await this.readIndexForMutation(requiredSessionId, false);
  }

  private async readIndexForPristineRepair(
    sessionId: string
  ): Promise<ConversationStoreIndex> {
    const text = await this.readTextFile(this.indexPath(), {
      allowMissing: true
    });
    if (text?.trim()) return parseConversationIndexStrict(text);

    const sessionsRoot = path.join(this.options.rootPath, "sessions");
    const ready = await this.assertDirectoryBoundary(sessionsRoot, {
      allowMissing: true
    });
    const entries = ready ? await readdir(sessionsRoot) : [];
    if (
      entries.length !== 1
      || entries[0] !== safeSessionPathPart(sessionId)
    ) {
      throw new ConversationContextConflictError(
        "Conversation index is missing and cannot be repaired from one verified pristine create"
      );
    }
    return emptyConversationIndex();
  }

  private async readIndexForMutation(
    requiredSessionId: string | undefined,
    allowNewSession: boolean
  ): Promise<ConversationStoreIndex> {
    let text: string;
    try {
      text = await this.readTextFile(this.indexPath()) ?? "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (await this.hasConversationStoreEntries()) {
          throw new ConversationContextConflictError("Conversation index is missing");
        }
        return emptyConversationIndex();
      }
      throw error;
    }
    if (!text.trim()) {
      if (await this.hasConversationStoreEntries()) {
        throw new ConversationContextConflictError("Conversation index is empty");
      }
      return emptyConversationIndex();
    }
    const index = parseConversationIndexStrict(text);
    const ids = index.sessions.map((session) => session.sessionId);
    if (
      requiredSessionId
      && !ids.includes(requiredSessionId)
      && !allowNewSession
    ) {
      throw new ConversationContextConflictError(
        `Conversation index is missing session ${requiredSessionId}`
      );
    }
    return index;
  }

  private async hasConversationStoreEntries(): Promise<boolean> {
    const sessionsRoot = path.join(this.options.rootPath, "sessions");
    const ready = await this.assertDirectoryBoundary(sessionsRoot, {
      allowMissing: true
    });
    if (!ready) return false;
    const entries = await readdir(sessionsRoot);
    return entries.length > 0;
  }

  private async sessionDirectoryExists(sessionId: string): Promise<boolean> {
    try {
      const ready = await this.assertDirectoryBoundary(this.sessionDir(sessionId), {
        allowMissing: true
      });
      if (!ready) return false;
      const stats = await lstat(this.sessionDir(sessionId));
      if (!stats.isDirectory()) {
        throw new Error(
          `Conversation recovery required: session path is not a directory for ${sessionId}`
        );
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async readSessionMetadata(sessionId: string): Promise<ConversationSessionMetadata | null> {
    if (!await this.sessionDirectoryExists(sessionId)) return null;
    let text: string;
    try {
      text = await this.readTextFile(this.metadataPath(sessionId)) ?? "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        "Conversation recovery required: metadata is not valid JSON",
        { cause: error }
      );
    }
    return validateConversationSessionMetadata(parsed, sessionId);
  }

  private async readCommittedSessionsFromDirectories(
    deletedSessionIds: ReadonlySet<string> = new Set()
  ): Promise<StoredSession[]> {
    const sessionsRoot = path.join(this.options.rootPath, "sessions");
    const ready = await this.assertDirectoryBoundary(sessionsRoot, {
      allowMissing: true
    });
    if (!ready) return [];
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    const sessions: StoredSession[] = [];
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (!entry.isDirectory()) {
        throw new ConversationContextConflictError(
          `Conversation recovery required: unexpected session entry ${entry.name}`
        );
      }
      const sessionId = safeSessionPathPart(entry.name);
      if (deletedSessionIds.has(sessionId)) continue;
      await this.assertDirectoryBoundary(this.sessionDir(sessionId));
      const metadata = await this.readSessionMetadata(sessionId);
      if (!metadata) {
        throw new Error(
          `Conversation recovery required: committed metadata is missing for ${sessionId}`
        );
      }
      const payload = await this.readCommittedPayload(sessionId, metadata);
      sessions.push(storedSessionFromCommittedPayload(metadata, payload));
    }
    return sessions;
  }

  private async gcContextPayloads(
    sessionId: string,
    activePayloadKey: string | undefined,
    previousPayloadKey: string | undefined
  ): Promise<void> {
    if (!activePayloadKey) return;
    const payloadRoot = path.join(this.sessionDir(sessionId), "context-payloads");
    const ready = await this.assertDirectoryBoundary(payloadRoot, {
      allowMissing: true
    });
    if (!ready) return;
    const entries = await readdir(payloadRoot, { withFileTypes: true });
    const retained = new Set([activePayloadKey, previousPayloadKey].filter(Boolean));
    for (const entry of entries) {
      if (
        !entry.isDirectory()
        || !isPayloadKey(entry.name)
        || retained.has(entry.name)
      ) {
        continue;
      }
      await this.options.beforeContextPayloadGc?.(sessionId, entry.name);
      const target = path.join(payloadRoot, entry.name);
      await this.assertDirectoryBoundary(target);
      await rm(target, { recursive: true, force: false });
    }
  }

  private async discoverConversationPayloadSourceRelativePaths(
    sessionId: string,
    metadata: ConversationSessionMetadata
  ): Promise<string[]> {
    const sessionPath = conversationSessionRelativePath(sessionId);
    const sources: string[] = [];
    const payloadRoot = path.join(
      this.sessionDir(sessionId),
      "context-payloads"
    );
    const payloadRootReady = await this.assertDirectoryBoundary(payloadRoot, {
      allowMissing: true
    });
    if (payloadRootReady) {
      const entries = await readdir(payloadRoot, { withFileTypes: true });
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        if (
          !entry.isDirectory()
          || entry.isSymbolicLink()
          || !isPayloadKey(entry.name)
        ) {
          throw new ConversationContextConflictError(
            `Conversation ${sessionId} has an unsafe payload entry: ${entry.name}`
          );
        }
        sources.push(`${sessionPath}/context-payloads/${entry.name}`);
      }
    }
    for (const legacyName of ["messages.jsonl", "snapshots.jsonl"]) {
      const target = path.join(this.sessionDir(sessionId), legacyName);
      if (await this.assertFileBoundary(target, { allowMissing: true })) {
        sources.push(`${sessionPath}/${legacyName}`);
      }
    }
    const activePayloadKey = normalizePayloadKey(metadata.payloadKey);
    if (
      activePayloadKey
      && !sources.includes(
        `${sessionPath}/context-payloads/${activePayloadKey}`
      )
    ) {
      throw new ConversationContextConflictError(
        `Conversation ${sessionId} active payload is missing from its source plan`
      );
    }
    return normalizeRecordMutationSourceRelativePaths(sources);
  }

  private async assertRecordMutationSources(
    sourceRelativePaths: readonly string[]
  ): Promise<void> {
    const normalized = normalizeRecordMutationSourceRelativePaths(
      sourceRelativePaths
    );
    if (!normalized.length) {
      throw new ConversationContextConflictError(
        "Conversation record mutation has no durable source payload"
      );
    }
    const root = path.resolve(this.options.rootPath);
    for (const relativePath of normalized) {
      const target = path.resolve(
        root,
        ...relativePath.split("/")
      );
      if (!isPathWithin(root, target) || target === root) {
        throw new ConversationContextConflictError(
          `Conversation record mutation source escapes its root: ${relativePath}`
        );
      }
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        throw new ConversationContextConflictError(
          `Conversation record mutation source is a symlink: ${relativePath}`
        );
      }
      if (stats.isDirectory()) {
        await this.assertDirectoryBoundary(target);
      } else if (stats.isFile()) {
        await this.assertFileBoundary(target);
      } else {
        throw new ConversationContextConflictError(
          `Conversation record mutation source is not a regular entry: ${relativePath}`
        );
      }
    }
  }

  private async removeConversationFromIndexProjection(
    conversationId: string
  ): Promise<void> {
    const index = await this.readIndex();
    const sessions = index.sessions.filter(
      (summary) => summary.sessionId !== conversationId
    );
    if (sessions.length === index.sessions.length) return;
    await this.writeJsonFile(this.indexPath(), {
      version: 1,
      updatedAt: this.now(),
      sessions
    } satisfies ConversationStoreIndex);
  }

  private async readConversationDeletionTombstones(): Promise<
    Map<string, ConversationDeletionTombstoneV1>
  > {
    const root = this.deletionTombstonesRoot();
    const ready = await this.assertDirectoryBoundary(root, {
      allowMissing: true
    });
    if (!ready) return new Map();
    const entries = await readdir(root, { withFileTypes: true });
    const tombstones = new Map<string, ConversationDeletionTombstoneV1>();
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || !entry.name.endsWith(".json")
      ) {
        throw new ConversationContextConflictError(
          `Conversation deletion tombstone entry is unsafe: ${entry.name}`
        );
      }
      const conversationId = safeSessionPathPart(
        entry.name.slice(0, -".json".length)
      );
      const tombstone = await this.readConversationDeletionTombstone(
        conversationId
      );
      if (!tombstone || tombstone.conversationId !== conversationId) {
        throw new ConversationContextConflictError(
          `Conversation deletion tombstone identity mismatch: ${entry.name}`
        );
      }
      tombstones.set(conversationId, tombstone);
    }
    return tombstones;
  }

  private indexPath(): string {
    return path.join(this.options.rootPath, "index.json");
  }

  private deletionTombstonesRoot(): string {
    return path.join(this.options.rootPath, "deletions");
  }

  private deletionTombstonePath(conversationId: string): string {
    return path.join(
      this.deletionTombstonesRoot(),
      `${safeSessionPathPart(conversationId)}.json`
    );
  }

  private async assertDirectoryBoundary(
    directoryPath: string,
    options: { create?: boolean; allowMissing?: boolean } = {}
  ): Promise<boolean> {
    const root = path.resolve(this.options.rootPath);
    const target = path.resolve(directoryPath);
    if (!isPathWithin(root, target)) {
      throw new ConversationContextConflictError(
        `Conversation store path resolves outside its boundary: ${directoryPath}`
      );
    }

    if (options.create) await mkdir(root, { recursive: true });
    let rootStats: Stats;
    try {
      rootStats = await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) {
        return false;
      }
      throw error;
    }
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new ConversationContextConflictError(
        "Conversation store root must be a real directory"
      );
    }
    const canonicalRoot = await realpath(root);
    if (target === root) return true;

    const relative = path.relative(root, target);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stats: Stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!options.create) {
          if (options.allowMissing) return false;
          throw error;
        }
        await mkdir(current);
        stats = await lstat(current);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new ConversationContextConflictError(
          `Conversation store directory must not be a symlink or non-directory: ${current}`
        );
      }
      const canonical = await realpath(current);
      if (!isPathWithin(canonicalRoot, canonical)) {
        throw new ConversationContextConflictError(
          `Conversation store directory resolves outside its boundary: ${current}`
        );
      }
    }
    return true;
  }

  private async assertFileBoundary(
    filePath: string,
    options: { createParent?: boolean; allowMissing?: boolean } = {}
  ): Promise<boolean> {
    const parentReady = await this.assertDirectoryBoundary(path.dirname(filePath), {
      create: options.createParent,
      allowMissing: options.allowMissing
    });
    if (!parentReady) return false;
    let stats: Stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (options.allowMissing || options.createParent) return false;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ConversationContextConflictError(
        `Conversation store file must not be a symlink or non-file: ${filePath}`
      );
    }
    const canonicalRoot = await realpath(path.resolve(this.options.rootPath));
    const canonical = await realpath(filePath);
    if (!isPathWithin(canonicalRoot, canonical)) {
      throw new ConversationContextConflictError(
        `Conversation store file resolves outside its boundary: ${filePath}`
      );
    }
    return true;
  }

  private async readTextFile(
    filePath: string,
    options: { allowMissing?: boolean } = {}
  ): Promise<string | null> {
    const exists = await this.assertFileBoundary(filePath, {
      allowMissing: options.allowMissing
    });
    if (!exists) return null;
    return await readFile(filePath, "utf8");
  }

  private async writeJsonFile(filePath: string, data: unknown): Promise<void> {
    await this.assertFileBoundary(filePath, {
      createParent: true,
      allowMissing: true
    });
    await writeJsonAtomic(filePath, data);
  }

  private async writeJsonlFile(filePath: string, rows: unknown[]): Promise<void> {
    await this.assertFileBoundary(filePath, {
      createParent: true,
      allowMissing: true
    });
    await writeJsonlAtomic(filePath, rows);
  }

  private metadataPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "metadata.json");
  }

  private messagesPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "messages.jsonl");
  }

  private snapshotsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "snapshots.jsonl");
  }

  private commitMessagesPath(sessionId: string, payloadKey: string): string {
    return path.join(this.commitPayloadDir(sessionId, payloadKey), "messages.jsonl");
  }

  private commitSnapshotsPath(sessionId: string, payloadKey: string): string {
    return path.join(this.commitPayloadDir(sessionId, payloadKey), "snapshots.jsonl");
  }

  private commitPayloadDir(sessionId: string, payloadKey: string): string {
    return path.join(this.sessionDir(sessionId), "context-payloads", normalizePayloadKey(payloadKey));
  }

  private sessionDir(sessionId: string): string {
    const sessionsRoot = path.resolve(this.options.rootPath, "sessions");
    const pathPart = safeSessionPathPart(sessionId);
    const target = path.resolve(sessionsRoot, pathPart);
    const relative = path.relative(sessionsRoot, target);
    if (
      !relative
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new ConversationContextConflictError(
        `Conversation session ID resolves outside its store boundary: ${sessionId}`
      );
    }
    return target;
  }

  private async withSessionCommit<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionCommitTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.sessionCommitTails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionCommitTails.get(sessionId) === tail) {
        this.sessionCommitTails.delete(sessionId);
      }
    }
  }

  private async withIndexCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.indexCommitTail;
    let release!: () => void;
    this.indexCommitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function refreshSessionContextSnapshot(session: StoredSession, now: number): void {
  const sourceMessages = summarizableMessages(messagesInCurrentSessionContext(session));
  if (!sourceMessages.length) return;
  const first = sourceMessages[0];
  const last = sourceMessages[sourceMessages.length - 1];
  const snapshotVersion = `snapshot-v2:${sha256StableJson({
    title: session.title,
    contextId: normalizedOptionalString(session.contextId) || null,
    contextStartsAfterMessageId:
      normalizedOptionalString(session.contextStartsAfterMessageId) || null,
    generation: sessionGeneration(session),
    messages: sourceMessages
  })}`;
  if (session.contextSnapshot?.version === snapshotVersion) {
    return;
  }
  const firstUser = sourceMessages.find((message) => message.role === "user");
  const lastAssistant = sourceMessages.slice().reverse().find((message) => message.role === "assistant");
  const titleGoal = session.title && session.title !== "新会话" ? session.title : "";
  session.contextSnapshot = {
    sessionId: session.id,
    ...(session.contextId ? { contextId: session.contextId } : {}),
    generation: sessionGeneration(session),
    version: snapshotVersion,
    goal: compactSnapshotText(titleGoal || firstUser?.text || "", 600),
    currentState: compactSnapshotText(lastAssistant?.text || last.text, 1200),
    decisions: [],
    constraints: [],
    openLoops: last.role === "user" ? [compactSnapshotText(last.text, 600)].filter(Boolean) : [],
    keyReferences: [],
    rollingSummary: sourceMessages.slice(-12).map(snapshotMessageLine).join("\n").slice(0, 8000),
    summarizedFromMessageId: first.id,
    summarizedThroughMessageId: last.id,
    sourceMessageCount: sourceMessages.length,
    createdAt: session.contextSnapshot?.createdAt ?? now,
    updatedAt: now
  };
  session.rollingSummary = {
    text: session.contextSnapshot.rollingSummary,
    updatedAt: now
  };
}

function validateConversationMigrationImportSession(
  sessionInput: StoredSession
): StoredSession {
  const session = cloneStoredSession(sessionInput);
  assertExactObjectKeys(
    session,
    PORTABLE_MIGRATION_SESSION_KEYS,
    "portable V1 migration Session"
  );
  for (const message of session.messages) {
    assertExactObjectKeys(
      message,
      PORTABLE_MIGRATION_MESSAGE_KEYS,
      "portable V1 migration message"
    );
  }
  if (
    !isPositiveSafeInteger(session.revision)
    || session.generation !== session.revision
    || !hasCompleteConversationContextIdentity(session)
  ) {
    throw new ConversationContextConflictError(
      "Portable V1 migration Session requires one complete positive Context identity"
    );
  }
  const messages = session.messages.map(validateChatMessage);
  const snapshots = session.contextSnapshot
    ? [validateSessionContextSnapshot(session.contextSnapshot, session.id)]
    : [];
  const payloadKey = createConversationPayloadKeyV2(
    session.commitId!,
    messages,
    snapshots
  );
  const metadata = metadataFromSession(session, payloadKey);
  validateConversationSessionMetadata(metadata, session.id);
  validateCommittedConversationPayload(metadata, messages, snapshots);
  return session;
}

function migrationImportSeed(candidate: StoredSession): StoredSession {
  return {
    id: candidate.id,
    title: candidate.title,
    ...(candidate.kind ? { kind: candidate.kind } : {}),
    revision: 1,
    generation: 1,
    contextId: candidate.contextId,
    commitId: candidate.commitId,
    workspaceFingerprint: candidate.workspaceFingerprint,
    cwd: candidate.cwd,
    messages: [],
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  };
}

async function assertConversationV1ExportTargetRoot(
  rootPath: string,
  binding: ConversationStoreMigrationImportPlanBinding
): Promise<void> {
  const resolved = path.resolve(rootPath);
  const generationRoot = path.dirname(resolved);
  const exportsRoot = path.dirname(generationRoot);
  const generationId = path.basename(generationRoot);
  if (
    path.basename(resolved) !== "store"
    || !V1_EXPORT_GENERATION_PATTERN.test(generationId)
    || path.basename(exportsRoot) !== V1_EXPORT_ROOT_DIRECTORY
    || binding.generationId !== generationId
    || !SHA256_DIGEST_PATTERN.test(binding.planDigest)
  ) {
    throw new ConversationContextConflictError(
      "Conversation migration import requires an exporter-managed V1 generation root"
    );
  }
  const [exportsStat, generationStat] = await Promise.all([
    lstat(exportsRoot),
    lstat(generationRoot)
  ]);
  if (
    exportsStat.isSymbolicLink()
    || !exportsStat.isDirectory()
    || generationStat.isSymbolicLink()
    || !generationStat.isDirectory()
  ) {
    throw new ConversationContextConflictError(
      "Conversation migration import generation ancestry is unsafe"
    );
  }
  const canonicalExportsRoot = await realpath(exportsRoot);
  const canonicalGenerationRoot = await realpath(generationRoot);
  if (!isPathWithin(canonicalExportsRoot, canonicalGenerationRoot)) {
    throw new ConversationContextConflictError(
      "Conversation migration import generation escapes its export root"
    );
  }
  const planPath = path.join(generationRoot, V1_EXPORT_PLAN_FILE);
  const before = await lstat(planPath);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || Number(before.nlink) !== 1
    || before.size <= 0
    || before.size > V1_EXPORT_PLAN_MAX_BYTES
  ) {
    throw new ConversationContextConflictError(
      "Conversation migration import plan is unsafe"
    );
  }
  const canonicalPlanPath = await realpath(planPath);
  if (!isPathWithin(canonicalGenerationRoot, canonicalPlanPath)) {
    throw new ConversationContextConflictError(
      "Conversation migration import plan escapes its generation"
    );
  }
  const bytes = await readFile(planPath);
  const after = await lstat(planPath);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || Number(after.nlink) !== 1
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || bytes.byteLength !== before.size
  ) {
    throw new ConversationContextConflictError(
      "Conversation migration import plan changed during read"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ConversationContextConflictError(
      "Conversation migration import plan is invalid JSON"
    );
  }
  if (!isRecord(parsed)) {
    throw new ConversationContextConflictError(
      "Conversation migration import plan must be an object"
    );
  }
  assertExactRequiredObjectKeys(
    parsed,
    V1_EXPORT_PLAN_KEYS,
    "Conversation migration import plan"
  );
  if (
    parsed.schemaVersion !== 1
    || parsed.recordType !== "conversation-store-v1-export-plan"
    || parsed.projection !== "conversation-portable-v1"
    || parsed.generationId !== generationId
    || parsed.sourceStoreVersion !== "v2"
    || parsed.targetStoreVersion !== "v1"
    || typeof parsed.sourceManifestDigest !== "string"
    || !SHA256_DIGEST_PATTERN.test(parsed.sourceManifestDigest)
    || typeof parsed.sourceFingerprint !== "string"
    || !SHA256_DIGEST_PATTERN.test(parsed.sourceFingerprint)
    || typeof parsed.digest !== "string"
    || !SHA256_DIGEST_PATTERN.test(parsed.digest)
  ) {
    throw new ConversationContextConflictError(
      "Conversation migration import plan schema is invalid"
    );
  }
  const {
    digest,
    ...draft
  } = parsed;
  const expectedDigest = `sha256:${sha256StableJson(draft)}`;
  if (
    digest !== expectedDigest
    || digest !== binding.planDigest
  ) {
    throw new ConversationContextConflictError(
      "Conversation migration import plan binding is invalid"
    );
  }
}

function assertExactObjectKeys(
  value: object,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConversationContextConflictError(
        `${label} contains unsupported field ${key}`
      );
    }
  }
}

function assertExactRequiredObjectKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  label: string
): void {
  if (
    Object.keys(value).length !== required.size
    || Object.keys(value).some((key) => !required.has(key))
    || [...required].some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key)
    )
  ) {
    throw new ConversationContextConflictError(
      `${label} fields are invalid`
    );
  }
}

function assertPristineConversationCandidate(session: StoredSession): void {
  const bindingCount = Object.keys(session.backendBindings ?? {}).length;
  const contextId = normalizedOptionalString(session.contextId);
  const commitId = normalizedOptionalString(session.commitId);
  const fingerprint = normalizedOptionalString(session.workspaceFingerprint);
  const hasCompleteIdentity = Boolean(contextId && commitId && fingerprint);
  const hasAnyIdentity = Boolean(contextId || commitId || fingerprint);
  if (
    !isNonEmptyString(session.id)
    || !isNonEmptyString(session.title)
    || session.revision !== 1
    || session.generation !== 1
    || session.messages.length !== 0
    || bindingCount !== 0
    || normalizedOptionalString(session.threadId)
    || normalizedOptionalString(session.contextStartsAfterMessageId)
    || session.contextSnapshot !== undefined
    || session.rollingSummary !== undefined
    || session.messagesHiddenBefore !== undefined
    || session.historyActiveDate !== undefined
    || session.tokenUsage !== undefined
    || !isNonNegativeInteger(session.createdAt)
    || !isNonNegativeInteger(session.updatedAt)
    || session.updatedAt < session.createdAt
  ) {
    throw new ConversationContextConflictError(
      "Pristine conversation create requires a new empty generation-1 session with no durable history or Native bindings"
    );
  }
  if (
    hasAnyIdentity
    && (
      !hasCompleteIdentity
      || !session.cwd.trim()
      || !/^sha256:[a-f0-9]{16,128}$/i.test(fingerprint)
    )
  ) {
    throw new ConversationContextConflictError(
      "Pristine conversation Context identity must be either fully absent or fully specified"
    );
  }
  if (!hasAnyIdentity && session.cwd.trim()) {
    throw new ConversationContextConflictError(
      "Pristine conversation without a Context identity cannot claim a workspace"
    );
  }
}

function summarizableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) =>
    (message.role === "user" || message.role === "assistant")
    && typeof message.text === "string"
    && message.text.trim().length > 0
  );
}

function cloneStoredSession(session: StoredSession): StoredSession {
  return JSON.parse(JSON.stringify(session)) as StoredSession;
}

function synchronizeDerivedSessionContext(
  target: StoredSession,
  candidate: StoredSession
): void {
  const derived = JSON.parse(JSON.stringify({
    contextSnapshot: candidate.contextSnapshot,
    rollingSummary: candidate.rollingSummary
  })) as Pick<StoredSession, "contextSnapshot" | "rollingSummary">;
  if (derived.contextSnapshot) target.contextSnapshot = derived.contextSnapshot;
  else delete target.contextSnapshot;
  if (derived.rollingSummary) target.rollingSummary = derived.rollingSummary;
  else delete target.rollingSummary;
}

function snapshotMessageLine(message: ChatMessage): string {
  const source = [message.backendId, message.modelId].filter(Boolean).join("/");
  const prefix = source ? `${message.role}(${source})` : message.role;
  return `${prefix}: ${compactSnapshotText(message.text, 700)}`;
}

function compactSnapshotText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
}

function metadataFromSession(
  session: StoredSession,
  payloadKey?: string,
  previousPayload: {
    previousPayloadKey?: string;
    previousPayloadCommitId?: string;
  } = {}
): ConversationSessionMetadata {
  return {
    id: session.id,
    title: session.title,
    ...(session.kind ? { kind: session.kind } : {}),
    ...(session.backendBindings ? { backendBindings: session.backendBindings } : {}),
    ...(session.revision ? { revision: session.revision } : {}),
    ...(session.generation ? { generation: session.generation } : {}),
    ...(session.contextId ? { contextId: session.contextId } : {}),
    ...(session.contextStartsAfterMessageId
      ? { contextStartsAfterMessageId: session.contextStartsAfterMessageId }
      : {}),
    ...(session.commitId ? { commitId: session.commitId } : {}),
    ...(session.workspaceFingerprint
      ? { workspaceFingerprint: session.workspaceFingerprint }
      : {}),
    ...(session.contextSnapshot ? { contextSnapshot: session.contextSnapshot } : {}),
    cwd: session.cwd,
    ...(session.rollingSummary ? { rollingSummary: session.rollingSummary } : {}),
    ...(session.messagesHiddenBefore ? { messagesHiddenBefore: session.messagesHiddenBefore } : {}),
    ...(session.historyActiveDate ? { historyActiveDate: session.historyActiveDate } : {}),
    ...(session.tokenUsage ? { tokenUsage: session.tokenUsage } : {}),
    ...(payloadKey ? { payloadVersion: 2 as const, payloadKey } : {}),
    ...(previousPayload.previousPayloadKey
      ? { previousPayloadKey: previousPayload.previousPayloadKey }
      : {}),
    ...(previousPayload.previousPayloadCommitId
      ? { previousPayloadCommitId: previousPayload.previousPayloadCommitId }
      : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function resolvePreviousPayload(
  targetPayloadKey: string | undefined,
  previousMetadata: ConversationSessionMetadata | null
): {
  previousPayloadKey?: string;
  previousPayloadCommitId?: string;
} {
  if (!targetPayloadKey) return {};
  const activePayloadKey = normalizePayloadKey(previousMetadata?.payloadKey) || undefined;
  const previousPayloadKey = normalizePayloadKey(previousMetadata?.previousPayloadKey) || undefined;
  if (previousPayloadKey && !activePayloadKey) {
    throw new Error(
      "Conversation recovery required: previous payload pointer exists without an active payload pointer"
    );
  }
  if (activePayloadKey === targetPayloadKey) {
    if (!previousPayloadKey) return {};
    const previousPayloadCommitId = normalizedOptionalString(
      previousMetadata?.previousPayloadCommitId
    );
    if (!previousPayloadCommitId) {
      throw new Error(
        "Conversation recovery required: previous payload commit identity is missing"
      );
    }
    return { previousPayloadKey, previousPayloadCommitId };
  }
  if (!activePayloadKey) return {};
  const activePayloadCommitId = normalizedOptionalString(previousMetadata?.commitId);
  if (!activePayloadCommitId) {
    throw new Error(
      "Conversation recovery required: active payload commit identity is missing"
    );
  }
  return {
    previousPayloadKey: activePayloadKey,
    previousPayloadCommitId: activePayloadCommitId
  };
}

function assertOrdinaryUpsertContextIdentity(
  session: StoredSession,
  metadata: ConversationSessionMetadata
): void {
  const currentGeneration = sessionGeneration(metadata);
  const incomingGeneration = sessionGeneration(session);
  const sameIdentity = incomingGeneration === currentGeneration
    && normalizedOptionalString(session.commitId) === normalizedOptionalString(metadata.commitId)
    && normalizedOptionalString(session.contextId) === normalizedOptionalString(metadata.contextId)
    && normalizedOptionalString(session.contextStartsAfterMessageId)
      === normalizedOptionalString(metadata.contextStartsAfterMessageId)
    && normalizedOptionalString(session.workspaceFingerprint)
      === normalizedOptionalString(metadata.workspaceFingerprint)
    && session.cwd === metadata.cwd;
  if (!sameIdentity) {
    throw new ConversationContextConflictError(
      "Conversation context identity changed outside a CAS context commit"
    );
  }
}

function assertExpectedConversation(
  current: StoredSession,
  expectedGeneration: number,
  expectedCommitId: string | undefined,
  expectedContentRevision: string
): void {
  if (
    sessionGeneration(current) !== expectedGeneration
    || normalizedOptionalString(current.commitId)
      !== normalizedOptionalString(expectedCommitId)
    || createConversationContentRevision(current) !== expectedContentRevision
  ) {
    throw new ConversationContextConflictError(
      `Conversation ${current.id} changed before record mutation`
    );
  }
}

function assertContextCommitCandidate(
  session: StoredSession,
  current: StoredSession,
  currentMetadata: ConversationSessionMetadata
): void {
  const currentGeneration = sessionGeneration(current);
  const currentCommitId = normalizedOptionalString(current.commitId);
  const targetGeneration = sessionGeneration(session);
  const targetCommitId = normalizedOptionalString(session.commitId);
  if (!targetCommitId) {
    throw new ConversationContextConflictError(
      "Context commit requires a commitId"
    );
  }
  if (
    targetGeneration < currentGeneration
    || targetGeneration > currentGeneration + 1
  ) {
    throw new ConversationContextConflictError(
      `Context generation must stay at ${currentGeneration} or advance to ${currentGeneration + 1}`
    );
  }
  if (targetGeneration === currentGeneration) {
    const preservesContextIdentity = normalizedOptionalString(session.contextId)
      === normalizedOptionalString(current.contextId)
      && normalizedOptionalString(session.contextStartsAfterMessageId)
        === normalizedOptionalString(current.contextStartsAfterMessageId)
      && normalizedOptionalString(session.workspaceFingerprint)
        === normalizedOptionalString(current.workspaceFingerprint)
      && session.cwd === current.cwd;
    if (!preservesContextIdentity) {
      throw new ConversationContextConflictError(
        "Same-generation context commit cannot change context or workspace identity"
      );
    }
  } else if (
    !normalizedOptionalString(session.contextId)
    || normalizedOptionalString(session.contextId)
      === normalizedOptionalString(current.contextId)
  ) {
    throw new ConversationContextConflictError(
      "Advanced context generation requires a new contextId"
    );
  }
  if (targetCommitId === currentCommitId) {
    throw new ConversationContextConflictError(
      "Context commitId must be unique"
    );
  }
  if (metadataReferencesCommitId(currentMetadata, targetCommitId)) {
    throw new ConversationContextConflictError(
      "Context commitId reuses an active or previous payload generation"
    );
  }
}

function assertConversationRecordClearCandidate(
  session: StoredSession,
  current: StoredSession,
  currentMetadata: ConversationSessionMetadata
): void {
  assertContextCommitCandidate(session, current, currentMetadata);
  if (
    sessionGeneration(session) !== sessionGeneration(current) + 1
    || session.id !== current.id
    || session.title !== current.title
    || session.kind !== current.kind
    || session.cwd !== current.cwd
    || normalizedOptionalString(session.workspaceFingerprint)
      !== normalizedOptionalString(current.workspaceFingerprint)
    || session.createdAt !== current.createdAt
    || session.messages.length !== 0
    || session.backendBindings !== undefined
    || session.threadId !== undefined
    || session.contextSnapshot !== undefined
    || session.rollingSummary !== undefined
    || session.messagesHiddenBefore !== undefined
    || session.historyActiveDate !== undefined
    || session.tokenUsage !== undefined
  ) {
    throw new ConversationContextConflictError(
      `Conversation ${session.id} record-clear target violates the durable shell contract`
    );
  }
}

function assertConversationHistoryRestoreCandidate(
  session: StoredSession,
  current: StoredSession,
  currentMetadata: ConversationSessionMetadata
): void {
  assertContextCommitCandidate(session, current, currentMetadata);
  const restoredThroughMessageId = session.messages.at(-1)?.id;
  if (
    sessionGeneration(session) !== sessionGeneration(current) + 1
    || session.id !== current.id
    || session.title !== current.title
    || session.kind !== current.kind
    || session.cwd !== current.cwd
    || normalizedOptionalString(session.workspaceFingerprint)
      !== normalizedOptionalString(current.workspaceFingerprint)
    || session.createdAt !== current.createdAt
    || session.messages.length === 0
    || session.contextStartsAfterMessageId !== restoredThroughMessageId
    || !session.historyActiveDate?.trim()
    || session.backendBindings !== undefined
    || session.threadId !== undefined
    || session.contextSnapshot !== undefined
    || session.rollingSummary !== undefined
    || session.messagesHiddenBefore !== undefined
    || session.tokenUsage !== undefined
  ) {
    throw new ConversationContextConflictError(
      `Conversation ${session.id} history-restore target violates the durable replacement contract`
    );
  }
}

function conversationSessionRelativePath(conversationId: string): string {
  return `sessions/${safeSessionPathPart(conversationId)}`;
}

function normalizeRecordMutationSourceRelativePaths(
  sourceRelativePaths: readonly string[]
): string[] {
  if (!Array.isArray(sourceRelativePaths)) {
    throw new ConversationContextConflictError(
      "Conversation record mutation source plan is not an array"
    );
  }
  const normalized = sourceRelativePaths.map((value) => {
    if (
      typeof value !== "string"
      || !value
      || value !== value.trim()
      || value.includes("\\")
      || path.posix.isAbsolute(value)
      || value.split("/").some((segment) => (
        !segment || segment === "." || segment === ".."
      ))
    ) {
      throw new ConversationContextConflictError(
        `Conversation record mutation source path is invalid: ${String(value)}`
      );
    }
    return value;
  }).sort(compareText);
  if (new Set(normalized).size !== normalized.length) {
    throw new ConversationContextConflictError(
      "Conversation record mutation source plan contains duplicates"
    );
  }
  return normalized;
}

export function createConversationDeletionTombstone(input: {
  conversationId: string;
  mutationId: string;
  tombstoneId: string;
  sourceGeneration: number;
  sourceCommitId: string;
  sourceContentRevision: string;
  deletedAt: number;
}): ConversationDeletionTombstoneV1 {
  const draft = {
    schemaVersion: 1 as const,
    kind: "conversation-deletion-tombstone" as const,
    conversationId: safeSessionPathPart(input.conversationId),
    mutationId: requiredLifecycleId(input.mutationId, "mutationId"),
    tombstoneId: requiredLifecycleId(input.tombstoneId, "tombstoneId"),
    sourceGeneration: requiredSafeInteger(
      input.sourceGeneration,
      "sourceGeneration"
    ),
    sourceCommitId: requiredLifecycleId(
      input.sourceCommitId,
      "sourceCommitId"
    ),
    sourceContentRevision: requiredSha256(
      input.sourceContentRevision,
      "sourceContentRevision"
    ),
    deletedAt: requiredSafeInteger(input.deletedAt, "deletedAt")
  };
  return parseConversationDeletionTombstone({
    ...draft,
    digest: `sha256:${sha256StableJson(draft)}`
  });
}

export function parseConversationDeletionTombstone(
  value: unknown
): ConversationDeletionTombstoneV1 {
  if (!isRecord(value)) {
    throw new Error("Conversation deletion tombstone is not an object");
  }
  const keys = Object.keys(value).sort(compareText);
  const expectedKeys = [
    "conversationId",
    "deletedAt",
    "digest",
    "kind",
    "mutationId",
    "schemaVersion",
    "sourceCommitId",
    "sourceContentRevision",
    "sourceGeneration",
    "tombstoneId"
  ].sort(compareText);
  if (!isDeepStrictEqual(keys, expectedKeys)) {
    throw new Error("Conversation deletion tombstone fields are invalid");
  }
  if (
    value.schemaVersion !== 1
    || value.kind !== "conversation-deletion-tombstone"
  ) {
    throw new Error("Conversation deletion tombstone schema is unsupported");
  }
  const draft = {
    schemaVersion: 1 as const,
    kind: "conversation-deletion-tombstone" as const,
    conversationId: safeSessionPathPart(
      requiredLifecycleId(value.conversationId, "conversationId")
    ),
    mutationId: requiredLifecycleId(value.mutationId, "mutationId"),
    tombstoneId: requiredLifecycleId(value.tombstoneId, "tombstoneId"),
    sourceGeneration: requiredSafeInteger(
      value.sourceGeneration,
      "sourceGeneration"
    ),
    sourceCommitId: requiredLifecycleId(
      value.sourceCommitId,
      "sourceCommitId"
    ),
    sourceContentRevision: requiredSha256(
      value.sourceContentRevision,
      "sourceContentRevision"
    ),
    deletedAt: requiredSafeInteger(value.deletedAt, "deletedAt")
  };
  const digest = requiredSha256(value.digest, "digest");
  if (digest !== `sha256:${sha256StableJson(draft)}`) {
    throw new Error("Conversation deletion tombstone digest mismatch");
  }
  return { ...draft, digest };
}

function requiredLifecycleId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > 320
    || containsUnsafeControlCharacter(value)
  ) {
    throw new Error(`Conversation deletion tombstone ${label} is invalid`);
  }
  return value;
}

function containsUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requiredSha256(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(value)
  ) {
    throw new Error(`Conversation deletion tombstone ${label} is invalid`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Conversation deletion tombstone ${label} is invalid`);
  }
  return value as number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createLegacyPayloadKey(commitId: string): string {
  return `payload-${createHash("sha256")
    .update(commitId)
    .digest("hex")}`;
}

export function createConversationPayloadKeyV2(
  commitId: string,
  messages: readonly unknown[],
  snapshots: readonly unknown[]
): string {
  return `payload-${sha256StableJson({
    version: 2,
    commitId,
    messages,
    snapshots
  })}`;
}

export function createConversationContentRevision(
  session: StoredSession
): string {
  return `sha256:${sha256StableJson({
    id: session.id,
    title: session.title,
    kind: session.kind ?? "chat",
    generation: sessionGeneration(session),
    contextId: normalizedOptionalString(session.contextId) ?? null,
    contextStartsAfterMessageId:
      normalizedOptionalString(session.contextStartsAfterMessageId) ?? null,
    commitId: normalizedOptionalString(session.commitId) ?? null,
    workspaceFingerprint:
      normalizedOptionalString(session.workspaceFingerprint) ?? null,
    contextSnapshot: session.contextSnapshot ?? null,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map(conversationProductMessageRecord)
  })}`;
}

function conversationProductMessageRecord(message: ChatMessage): unknown {
  const knowledgeBaseUi = projectDurableKnowledgeBaseUi(message);
  const presentation = {
    schemaVersion: 1,
    ...(message.itemType !== undefined
      ? { itemType: message.itemType }
      : {}),
    ...(message.title !== undefined ? { title: message.title } : {}),
    ...(message.status !== undefined ? { status: message.status } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
    ...(message.attachments !== undefined
      ? { attachments: message.attachments }
      : {}),
    ...(message.images !== undefined ? { images: message.images } : {}),
    ...(message.files !== undefined ? { files: message.files } : {}),
    ...(message.citations !== undefined
      ? { citations: message.citations }
      : {}),
    ...(message.diffSummary !== undefined
      ? { diffSummary: message.diffSummary }
      : {}),
    ...(knowledgeBaseUi !== undefined
      ? { knowledgeBaseUi }
      : {})
  };
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId ?? null,
    previewText: message.previewText ?? null,
    raw: message.rawRef
      ? {
        ref: message.rawRef,
        size: isNonNegativeInteger(message.rawSize)
          ? message.rawSize
          : 0,
        lines: isNonNegativeInteger(message.rawLines)
          ? message.rawLines
          : 0,
        truncatedForPreview: message.rawTruncatedForPreview === true
      }
      : null,
    presentation: Object.keys(presentation).length === 1
      ? null
      : presentation,
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? null
  };
}

export function createConversationMessageRevision(
  message: ChatMessage
): string {
  return `sha256:${sha256StableJson(message)}`;
}

function sha256StableJson(value: unknown): string {
  return createHash("sha256")
    .update(stableJsonStringify(value))
    .digest("hex");
}

function stableJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(stableJsonValue(value));
  if (serialized === undefined) {
    throw new Error("Conversation recovery required: durable payload is not JSON serializable");
  }
  return serialized;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : stableJsonValue(item));
  }
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      sorted[key] = stableJsonValue(value[key]);
    }
  }
  return sorted;
}

function metadataReferencesCommitId(
  metadata: ConversationSessionMetadata,
  commitId: string
): boolean {
  return (
    Boolean(normalizePayloadKey(metadata.payloadKey))
    && normalizedOptionalString(metadata.commitId) === commitId
  ) || (
    Boolean(normalizePayloadKey(metadata.previousPayloadKey))
    && metadataPreviousPayloadMatchesCommitId(metadata, commitId)
  );
}

function metadataPreviousPayloadMatchesCommitId(
  metadata: ConversationSessionMetadata,
  commitId: string
): boolean {
  const previousPayloadCommitId = normalizedOptionalString(
    metadata.previousPayloadCommitId
  );
  if (previousPayloadCommitId) {
    return previousPayloadCommitId === commitId;
  }
  return metadata.payloadVersion === undefined
    && normalizePayloadKey(metadata.previousPayloadKey) === createLegacyPayloadKey(commitId);
}

function normalizePayloadKey(value: string | undefined): string {
  if (!value) return "";
  if (!isPayloadKey(value)) {
    throw new Error("Conversation recovery required: payload pointer is invalid");
  }
  return value;
}

function isPayloadKey(value: string): boolean {
  return /^payload-[a-f0-9]{64}$/.test(value);
}

function normalizedOptionalString(value: string | undefined): string {
  return value?.trim() || "";
}

function hasCompleteConversationContextIdentity(
  session: Pick<
    StoredSession,
    "contextId" | "commitId" | "workspaceFingerprint" | "cwd"
  >
): boolean {
  return Boolean(
    normalizedOptionalString(session.contextId)
    && normalizedOptionalString(session.commitId)
    && normalizedOptionalString(session.workspaceFingerprint)
    && session.cwd.trim()
  );
}

function contextCommitReceipt(session: StoredSession): ConversationContextCommitReceipt {
  return {
    conversationId: session.id,
    generation: sessionGeneration(session),
    ...(session.contextId ? { contextId: session.contextId } : {}),
    ...(session.contextStartsAfterMessageId
      ? { contextStartsAfterMessageId: session.contextStartsAfterMessageId }
      : {}),
    commitId: session.commitId!,
    ...(session.workspaceFingerprint
      ? { workspaceFingerprint: session.workspaceFingerprint }
      : {})
  };
}

function storedSessionFromCommittedPayload(
  metadata: ConversationSessionMetadata,
  payload: {
    messages: ChatMessage[];
    snapshots: SessionContextSnapshot[];
  }
): StoredSession {
  const {
    payloadVersion: _payloadVersion,
    payloadKey: _payloadKey,
    previousPayloadKey: _previousPayloadKey,
    previousPayloadCommitId: _previousPayloadCommitId,
    ...sessionMetadata
  } = metadata;
  return {
    ...sessionMetadata,
    contextSnapshot: metadata.contextSnapshot ?? payload.snapshots.at(-1),
    messages: payload.messages
  };
}

function validateConversationSessionMetadata(
  value: unknown,
  expectedSessionId: string
): ConversationSessionMetadata {
  if (!isRecord(value)) {
    throw new Error("Conversation recovery required: metadata must be an object");
  }
  if (
    typeof value.id !== "string"
    || value.id !== expectedSessionId
    || typeof value.title !== "string"
    || typeof value.cwd !== "string"
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)
  ) {
    throw new Error("Conversation recovery required: metadata identity or core fields are invalid");
  }
  if (value.kind !== undefined && value.kind !== "chat" && value.kind !== "knowledge-base") {
    throw new Error("Conversation recovery required: metadata kind is invalid");
  }
  assertOptionalNonEmptyString(value.threadId, "metadata threadId");
  assertOptionalPositiveInteger(value.revision, "metadata revision");
  assertOptionalPositiveInteger(value.generation, "metadata generation");
  if (
    value.revision !== undefined
    && value.generation !== undefined
    && value.revision !== value.generation
  ) {
    throw new Error(
      "Conversation recovery required: metadata revision and generation are inconsistent"
    );
  }
  assertOptionalNonEmptyString(value.contextId, "metadata contextId");
  assertOptionalNonEmptyString(
    value.contextStartsAfterMessageId,
    "metadata context boundary"
  );
  assertOptionalNonEmptyString(value.commitId, "metadata commitId");
  assertOptionalFingerprint(value.workspaceFingerprint, "metadata workspace fingerprint");
  if (value.backendBindings !== undefined) {
    validateBackendSessionBindings(value.backendBindings);
  }
  if (value.contextSnapshot !== undefined) {
    const snapshot = validateSessionContextSnapshot(value.contextSnapshot, expectedSessionId);
    if (
      snapshot.contextId !== undefined
      && normalizedOptionalString(snapshot.contextId)
        !== normalizedOptionalString(
          typeof value.contextId === "string" ? value.contextId : undefined
        )
    ) {
      throw new Error("Conversation recovery required: snapshot contextId is inconsistent");
    }
    if (
      snapshot.generation !== undefined
      && snapshot.generation !== sessionGeneration(value)
    ) {
      throw new Error("Conversation recovery required: snapshot generation is inconsistent");
    }
  }
  if (value.rollingSummary !== undefined) {
    if (
      !isRecord(value.rollingSummary)
      || typeof value.rollingSummary.text !== "string"
      || !isNonNegativeFiniteNumber(value.rollingSummary.updatedAt)
    ) {
      throw new Error("Conversation recovery required: rolling summary is invalid");
    }
  }
  assertOptionalNonNegativeInteger(value.messagesHiddenBefore, "metadata hidden-message count");
  assertOptionalNonEmptyString(value.historyActiveDate, "metadata history date");
  if (value.tokenUsage !== undefined && !isRecord(value.tokenUsage)) {
    throw new Error("Conversation recovery required: token usage is invalid");
  }
  if (
    (value.payloadVersion !== undefined && value.payloadVersion !== 2)
    || (value.payloadKey !== undefined && typeof value.payloadKey !== "string")
    || (value.previousPayloadKey !== undefined && typeof value.previousPayloadKey !== "string")
    || (
      value.previousPayloadCommitId !== undefined
      && typeof value.previousPayloadCommitId !== "string"
    )
  ) {
    throw new Error("Conversation recovery required: payload pointer fields are invalid");
  }
  assertOptionalNonEmptyString(
    value.previousPayloadCommitId,
    "previous payload commit identity"
  );
  const activePayloadKey = normalizePayloadKey(value.payloadKey) || undefined;
  const previousPayloadKey = normalizePayloadKey(
    value.previousPayloadKey
  ) || undefined;
  if (previousPayloadKey && !activePayloadKey) {
    throw new Error(
      "Conversation recovery required: previous payload pointer exists without an active payload pointer"
    );
  }
  if (previousPayloadKey === activePayloadKey && previousPayloadKey) {
    throw new Error("Conversation recovery required: active and previous payload pointers are identical");
  }
  const previousPayloadCommitId = normalizedOptionalString(
    typeof value.previousPayloadCommitId === "string"
      ? value.previousPayloadCommitId
      : undefined
  ) || undefined;
  if (value.payloadVersion === 2) {
    if (!activePayloadKey) {
      throw new Error(
        "Conversation recovery required: payload v2 requires an active payload pointer"
      );
    }
    if (Boolean(previousPayloadKey) !== Boolean(previousPayloadCommitId)) {
      throw new Error(
        "Conversation recovery required: previous payload pointer and commit identity are inconsistent"
      );
    }
  } else {
    if (previousPayloadCommitId) {
      throw new Error(
        "Conversation recovery required: legacy payload metadata cannot claim a previous commit identity"
      );
    }
    const commitId = typeof value.commitId === "string" ? value.commitId.trim() : "";
    if (activePayloadKey && (!commitId || createLegacyPayloadKey(commitId) !== activePayloadKey)) {
      throw new Error(
        "Conversation recovery required: active payload pointer does not match commitId"
      );
    }
  }
  return value as unknown as ConversationSessionMetadata;
}

function validateCommittedConversationPayload(
  metadata: ConversationSessionMetadata,
  messages: ChatMessage[],
  snapshots: SessionContextSnapshot[]
): void {
  const messageIds = messages.map((message) => message.id);
  if (new Set(messageIds).size !== messageIds.length) {
    throw new Error(
      "Conversation recovery required: committed messages contain duplicate IDs"
    );
  }

  const boundary = normalizedOptionalString(metadata.contextStartsAfterMessageId);
  const boundaryIndex = boundary
    ? messages.findIndex((message) => message.id === boundary)
    : -1;
  if (boundary && boundaryIndex < 0) {
    throw new Error(
      "Conversation recovery required: context boundary is missing from committed messages"
    );
  }

  if (snapshots.length > 1) {
    throw new Error(
      "Conversation recovery required: committed snapshots contain multiple current snapshots"
    );
  }
  const metadataSnapshot = metadata.contextSnapshot;
  const payloadSnapshot = snapshots[0];
  if (
    Boolean(metadataSnapshot) !== Boolean(payloadSnapshot)
    || (
      metadataSnapshot
      && payloadSnapshot
      && !isDeepStrictEqual(metadataSnapshot, payloadSnapshot)
    )
  ) {
    throw new Error(
      "Conversation recovery required: metadata and payload snapshots are inconsistent"
    );
  }
  if (!payloadSnapshot) {
    validatePayloadAddress(metadata, messages, snapshots);
    return;
  }

  const fromId = normalizedOptionalString(payloadSnapshot.summarizedFromMessageId);
  const throughId = normalizedOptionalString(payloadSnapshot.summarizedThroughMessageId);
  if (payloadSnapshot.sourceMessageCount === 0) {
    if (fromId || throughId) {
      throw new Error(
        "Conversation recovery required: empty snapshot has a summarized message range"
      );
    }
    validatePayloadAddress(metadata, messages, snapshots);
    return;
  }
  if (!fromId || !throughId) {
    throw new Error(
      "Conversation recovery required: snapshot message range is incomplete"
    );
  }

  const contextStartIndex = boundaryIndex + 1;
  const fromIndex = messages.findIndex((message) => message.id === fromId);
  const throughIndex = messages.findIndex((message) => message.id === throughId);
  if (
    fromIndex < contextStartIndex
    || throughIndex < contextStartIndex
    || fromIndex > throughIndex
  ) {
    throw new Error(
      "Conversation recovery required: snapshot message range is outside the current context"
    );
  }
  const coveredMessages = summarizableMessages(
    messages.slice(fromIndex, throughIndex + 1)
  );
  if (
    coveredMessages[0]?.id !== fromId
    || coveredMessages.at(-1)?.id !== throughId
    || coveredMessages.length !== payloadSnapshot.sourceMessageCount
  ) {
    throw new Error(
      "Conversation recovery required: snapshot source message count is inconsistent"
    );
  }
  validatePayloadAddress(metadata, messages, snapshots);
}

function validatePayloadAddress(
  metadata: ConversationSessionMetadata,
  messages: ChatMessage[],
  snapshots: SessionContextSnapshot[]
): void {
  if (metadata.payloadVersion !== 2) return;
  const commitId = normalizedOptionalString(metadata.commitId);
  const activePayloadKey = normalizePayloadKey(metadata.payloadKey);
  if (
    !commitId
    || !activePayloadKey
    || createConversationPayloadKeyV2(commitId, messages, snapshots) !== activePayloadKey
  ) {
    throw new Error(
      "Conversation recovery required: active payload pointer does not match commitId or payload content"
    );
  }
}

export function validateChatMessage(value: unknown): ChatMessage {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || !["user", "assistant", "system", "tool"].includes(
      typeof value.role === "string" ? value.role : ""
    )
    || typeof value.text !== "string"
    || !isNonNegativeFiniteNumber(value.createdAt)
  ) {
    throw new Error("Conversation recovery required: committed message row is invalid");
  }
  for (const field of [
    "backendId",
    "modelId",
    "profileId",
    "nativeExecutionIdHash",
    "contextCompiledThroughMessageId",
    "contextSnapshotVersion",
    "nativeLeaseId",
    "runId",
    "turnId",
    "itemType",
    "title",
    "status",
    "details",
    "processInput",
    "processOutput",
    "previewText",
    "rawRef"
  ] as const) {
    assertOptionalString(value[field], `message ${field}`);
  }
  for (const field of [
    "completedAt",
    "nativeLeaseTurnCount",
    "rawSize",
    "rawLines"
  ] as const) {
    assertOptionalNonNegativeNumber(value[field], `message ${field}`);
  }
  for (const field of [
    "nativeLeaseReused",
    "runTerminalRecovered",
    "rawTruncatedForPreview"
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new Error(`Conversation recovery required: message ${field} is invalid`);
    }
  }
  if (
    value.phase !== undefined
    && value.phase !== null
    && typeof value.phase !== "string"
  ) {
    throw new Error("Conversation recovery required: message phase is invalid");
  }
  assertOptionalEnum(
    value.contextMode,
    ["bootstrap", "incremental", "catch-up", "workflow"],
    "message context mode"
  );
  assertOptionalEnum(
    value.nativeLocalCommitStatus,
    ["pending", "committed", "failed"],
    "message native local commit status"
  );
  assertOptionalEnum(
    value.nativeCleanupStatus,
    [
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
    ],
    "message native cleanup status"
  );
  assertOptionalEnum(
    value.nativeLeaseStatus,
    ["active", "expired", "cleanup-pending", "disposed", "failed"],
    "message native lease status"
  );
  assertOptionalEnum(
    value.runTerminalRecoveryPending,
    ["completed", "cancelled", "failed"],
    "message terminal recovery status"
  );
  validateEchoInkChatRunTerminalRecovery(
    value.echoInkRunTerminalRecovery
  );
  assertOptionalEnum(
    value.processKind,
    ["reasoning", "plan", "search", "view", "edit", "run", "tool", "command", "other"],
    "message process kind"
  );
  for (const field of [
    "processContentAvailability",
    "processInputAvailability",
    "processOutputAvailability"
  ] as const) {
    assertOptionalEnum(
      value[field],
      ["provided", "empty", "unavailable"],
      `message ${field}`
    );
  }
  validateStoredAttachments(value.attachments, "message attachments");
  validateStoredAttachments(value.images, "message images");
  validateProcessFiles(value.files);
  validateDiffSummary(value.diffSummary);
  validateKnowledgeBaseCitations(value.citations);
  validateKnowledgeBaseUi(value.knowledgeBaseUi);
  validateHarnessRunUsage(value.runUsage);
  return value as unknown as ChatMessage;
}

function validateEchoInkChatRunTerminalRecovery(value: unknown): void {
  if (value === undefined) return;
  if (
    !isRecord(value)
    || value.namespace !== "echoink.chat-terminal"
    || value.schemaVersion !== 1
    || !isNonEmptyString(value.runId)
    || !["completed", "cancelled", "failed"].includes(
      typeof value.status === "string" ? value.status : ""
    )
    || (value.backendId !== undefined && !isNonEmptyString(value.backendId))
    || typeof value.payloadPresent !== "boolean"
    || !isNonEmptyString(value.payloadHash)
    || !isNonEmptyString(value.terminalCommitId)
    || !isNonEmptyString(value.carrierMessageId)
  ) {
    throw new Error(
      "Conversation recovery required: message terminal authority marker is invalid"
    );
  }
  if (value.data !== undefined) {
    assertPersistableJsonValue(value.data, "message terminal authority data");
    if (!isRecord(value.data)) {
      throw new Error(
        "Conversation recovery required: message terminal authority data is invalid"
      );
    }
  }
  const source = value.payloadSource;
  if (
    !isRecord(source)
    || !isNonEmptyString(source.contentHash)
    || !Number.isSafeInteger(source.size)
    || (source.size as number) < 0
    || !Number.isSafeInteger(source.lines)
    || (source.lines as number) < 0
  ) {
    throw new Error(
      "Conversation recovery required: message terminal payload source is invalid"
    );
  }
  if (source.kind === "inline") {
    if (typeof source.value !== "string") {
      throw new Error(
        "Conversation recovery required: inline terminal payload is invalid"
      );
    }
    return;
  }
  if (
    source.kind !== "raw"
    || !isNonEmptyString(source.rawRef)
    || !isNonEmptyString(source.previewHash)
  ) {
    throw new Error(
      "Conversation recovery required: Raw terminal payload identity is invalid"
    );
  }
}

function assertPersistableJsonValue(value: unknown, label: string): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertPersistableJsonValue(item, label);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      assertPersistableJsonValue(item, label);
    }
    return;
  }
  throw new Error(`Conversation recovery required: ${label} is invalid`);
}

function validateStoredAttachments(value: unknown, label: string): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value)
    || value.some((item) =>
      !isRecord(item)
      || (item.type !== "file" && item.type !== "image")
      || !isNonEmptyString(item.name)
      || !isNonEmptyString(item.path)
    )
  ) {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function validateProcessFiles(value: unknown): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value)
    || value.some((item) =>
      !isRecord(item)
      || !isNonEmptyString(item.name)
      || !isNonEmptyString(item.path)
      || typeof item.displayPath !== "string"
      || !["vault", "external", "unknown"].includes(
        typeof item.kind === "string" ? item.kind : ""
      )
      || typeof item.openable !== "boolean"
      || (item.absolutePath !== undefined && typeof item.absolutePath !== "string")
    )
  ) {
    throw new Error("Conversation recovery required: message files are invalid");
  }
}

function validateDiffSummary(value: unknown): void {
  if (value === undefined) return;
  if (
    !isRecord(value)
    || !isNonNegativeInteger(value.totalFiles)
    || !isNonNegativeInteger(value.added)
    || !isNonNegativeInteger(value.removed)
    || !Array.isArray(value.files)
  ) {
    throw new Error("Conversation recovery required: message diff summary is invalid");
  }
  let added = 0;
  let removed = 0;
  for (const file of value.files) {
    if (
      !isRecord(file)
      || !isNonEmptyString(file.path)
      || (file.previousPath !== undefined && !isNonEmptyString(file.previousPath))
      || !["add", "delete", "update", "move", "unknown"].includes(
        typeof file.kind === "string" ? file.kind : ""
      )
      || !isNonNegativeInteger(file.added)
      || !isNonNegativeInteger(file.removed)
    ) {
      throw new Error("Conversation recovery required: message diff summary is invalid");
    }
    added += file.added;
    removed += file.removed;
  }
  if (
    value.totalFiles !== value.files.length
    || value.added !== added
    || value.removed !== removed
  ) {
    throw new Error("Conversation recovery required: message diff summary totals are inconsistent");
  }
}

function validateKnowledgeBaseCitations(value: unknown): void {
  if (value === undefined) return;
  if (
    !isRecord(value)
    || !["strong", "weak", "none"].includes(
      typeof value.status === "string" ? value.status : ""
    )
    || !isRecord(value.counts)
    || !["wiki", "journal", "outputs"].every((bucket) =>
      isNonNegativeInteger(value.counts?.[bucket])
    )
    || !Array.isArray(value.citations)
  ) {
    throw new Error("Conversation recovery required: message citations are invalid");
  }
  for (const citation of value.citations) {
    if (
      !isRecord(citation)
      || !["wiki", "journal", "outputs"].includes(
        typeof citation.bucket === "string" ? citation.bucket : ""
      )
      || typeof citation.title !== "string"
      || !isNonEmptyString(citation.path)
      || !isStringArray(citation.excerptLines)
      || !["strong", "weak"].includes(
        typeof citation.relevance === "string" ? citation.relevance : ""
      )
      || typeof citation.reason !== "string"
      || typeof citation.score !== "number"
      || !Number.isFinite(citation.score)
    ) {
      throw new Error("Conversation recovery required: message citations are invalid");
    }
  }
}

function validateKnowledgeBaseUi(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new Error("Conversation recovery required: message knowledge UI is invalid");
  }
  if (value.kind === "maintain-run") {
    validateKnowledgeBaseRunUi(value);
    return;
  }
  if (value.kind === "maintain-report") {
    validateKnowledgeBaseReportUi(value);
    return;
  }
  throw new Error("Conversation recovery required: message knowledge UI kind is invalid");
}

function validateKnowledgeBaseRunUi(value: Record<string, unknown>): void {
  if (
    !isKnowledgeBaseMode(value.mode)
    || !isNonEmptyString(value.title)
    || typeof value.subtitle !== "string"
    || !isKnowledgeBaseIcon(value.icon)
    || !Array.isArray(value.phases)
  ) {
    throw new Error("Conversation recovery required: message knowledge run UI is invalid");
  }
  for (const phase of value.phases) {
    if (
      !isRecord(phase)
      || !["prepare", "digest", "organize", "report", "complete"].includes(
        typeof phase.id === "string" ? phase.id : ""
      )
      || !isNonEmptyString(phase.label)
      || !isKnowledgeBaseIcon(phase.icon)
      || !["scan", "check", "work", "report", "complete"].includes(
        typeof phase.motion === "string" ? phase.motion : ""
      )
    ) {
      throw new Error("Conversation recovery required: message knowledge run UI is invalid");
    }
  }
  if (value.events !== undefined) {
    if (!Array.isArray(value.events)) {
      throw new Error("Conversation recovery required: message knowledge run events are invalid");
    }
    value.events.forEach(validateKnowledgeWorkflowEvent);
  }
}

function validateKnowledgeWorkflowEvent(value: unknown): void {
  if (
    !isRecord(value)
    || ![
      "workflow.started",
      "workflow.phase.started",
      "workflow.phase.progress",
      "workflow.phase.completed",
      "workflow.phase.failed",
      "workflow.validation.result",
      "workflow.transaction.committed",
      "workflow.transaction.rolled_back",
      "workflow.artifact.created",
      "workflow.report.ready",
      "workflow.completed"
    ].includes(typeof value.type === "string" ? value.type : "")
    || !isNonNegativeFiniteNumber(value.createdAt)
  ) {
    throw new Error("Conversation recovery required: message knowledge run event is invalid");
  }
  assertOptionalEnum(
    value.phaseId,
    ["prepare", "digest", "organize", "report", "complete"],
    "knowledge run event phase"
  );
  assertOptionalEnum(
    value.status,
    ["running", "success", "failed", "canceled"],
    "knowledge run event status"
  );
  assertOptionalString(value.title, "knowledge run event title");
  assertOptionalString(value.message, "knowledge run event message");
  assertOptionalNonNegativeNumber(value.current, "knowledge run event current");
  assertOptionalNonNegativeNumber(value.total, "knowledge run event total");
}

function validateKnowledgeBaseReportUi(value: Record<string, unknown>): void {
  if (
    !isKnowledgeBaseMode(value.mode)
    || !["success", "failed", "canceled"].includes(
      typeof value.status === "string" ? value.status : ""
    )
    || !isNonEmptyString(value.title)
    || typeof value.reportPath !== "string"
    || !Array.isArray(value.careItems)
    || !Array.isArray(value.sections)
  ) {
    throw new Error("Conversation recovery required: message knowledge report UI is invalid");
  }
  for (const item of value.careItems) {
    if (
      !isRecord(item)
      || !["success", "warning", "info"].includes(
        typeof item.tone === "string" ? item.tone : ""
      )
      || !isNonEmptyString(item.text)
    ) {
      throw new Error("Conversation recovery required: message knowledge report UI is invalid");
    }
  }
  for (const section of value.sections) {
    if (
      !isRecord(section)
      || !isNonEmptyString(section.id)
      || !isNonEmptyString(section.title)
      || !isNonNegativeInteger(section.count)
      || typeof section.emptyText !== "string"
      || !Array.isArray(section.items)
    ) {
      throw new Error("Conversation recovery required: message knowledge report UI is invalid");
    }
    for (const item of section.items) {
      if (
        !isRecord(item)
        || !isNonEmptyString(item.title)
        || (item.path !== undefined && !isNonEmptyString(item.path))
        || typeof item.description !== "string"
        || (
          item.tone !== undefined
          && !["success", "warning", "info"].includes(
            typeof item.tone === "string" ? item.tone : ""
          )
        )
      ) {
        throw new Error("Conversation recovery required: message knowledge report UI is invalid");
      }
    }
  }
}

function isKnowledgeBaseMode(value: unknown): boolean {
  return ["maintain", "lint", "reingest", "outputs", "inbox", "calibrate"].includes(
    typeof value === "string" ? value : ""
  );
}

function isKnowledgeBaseIcon(value: unknown): boolean {
  return [
    "archive",
    "badge-check",
    "book-open",
    "bot",
    "check",
    "check-circle",
    "clipboard-check",
    "database",
    "file-pen",
    "folder-down",
    "gauge",
    "inbox",
    "network",
    "route",
    "search",
    "shield-check",
    "tag"
  ].includes(typeof value === "string" ? value : "");
}

function validateHarnessRunUsage(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new Error("Conversation recovery required: message run usage is invalid");
  }
  for (const field of [
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cost"
  ]) {
    assertOptionalNonNegativeNumber(value[field], `message run usage ${field}`);
  }
}

function validateSessionContextSnapshot(
  value: unknown,
  expectedSessionId: string
): SessionContextSnapshot {
  if (
    !isRecord(value)
    || value.sessionId !== expectedSessionId
    || !isNonEmptyString(value.version)
    || typeof value.goal !== "string"
    || typeof value.currentState !== "string"
    || typeof value.rollingSummary !== "string"
    || !isStringArray(value.decisions)
    || !isStringArray(value.constraints)
    || !isStringArray(value.openLoops)
    || !isStringArray(value.keyReferences)
    || !isNonNegativeInteger(value.sourceMessageCount)
    || !isNonNegativeFiniteNumber(value.createdAt)
    || !isNonNegativeFiniteNumber(value.updatedAt)
  ) {
    throw new Error("Conversation recovery required: committed context snapshot is invalid");
  }
  assertOptionalNonEmptyString(value.contextId, "snapshot contextId");
  assertOptionalPositiveInteger(value.generation, "snapshot generation");
  assertOptionalNonEmptyString(value.summarizedFromMessageId, "snapshot start message");
  assertOptionalNonEmptyString(value.summarizedThroughMessageId, "snapshot end message");
  return value as unknown as SessionContextSnapshot;
}

function validateBackendSessionBindings(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("Conversation recovery required: backend bindings are invalid");
  }
  for (const [backendId, rawBinding] of Object.entries(value)) {
    if (!isNonEmptyString(backendId) || !isRecord(rawBinding)) {
      throw new Error("Conversation recovery required: backend binding is invalid");
    }
    if (
      rawBinding.backendId !== backendId
      || !isPositiveSafeInteger(rawBinding.syncedSessionRevision)
      || !isNonNegativeFiniteNumber(rawBinding.lastUsedAt)
    ) {
      throw new Error("Conversation recovery required: backend binding identity is invalid");
    }
    for (const field of [
      "nativeSessionId",
      "nativeThreadId",
      "leaseId",
      "contextCheckpointMessageId",
      "syncedThroughMessageId",
      "snapshotVersion",
      "vaultProfileFingerprint"
    ] as const) {
      assertOptionalNonEmptyString(rawBinding[field], `backend binding ${field}`);
    }
    assertOptionalEnum(
      rawBinding.nativeExecutionKind,
      ["thread", "session", "run", "process"],
      "backend binding native kind"
    );
    assertOptionalEnum(
      rawBinding.leaseStatus,
      ["active", "expired", "cleanup-pending", "disposed", "failed"],
      "backend binding lease status"
    );
    for (const field of [
      "leaseCreatedAt",
      "leaseLastUsedAt",
      "leaseExpiresAt",
      "leaseTurnCount",
      "leaseMaxTurns",
      "leaseContextChars",
      "leaseMaxContextChars"
    ] as const) {
      assertOptionalNonNegativeNumber(rawBinding[field], `backend binding ${field}`);
    }
    assertOptionalFingerprint(
      rawBinding.workspaceFingerprint,
      "backend binding workspace fingerprint"
    );
    if (rawBinding.contextCursor !== undefined) {
      validateContextCursor(rawBinding.contextCursor);
    }
    if (rawBinding.nativeExecutionRef !== undefined) {
      validateNativeExecutionRef(rawBinding.nativeExecutionRef, backendId);
    }
  }
}

function validateContextCursor(value: unknown): void {
  if (!isRecord(value) || !isPositiveSafeInteger(value.syncedSessionRevision)) {
    throw new Error("Conversation recovery required: backend context cursor is invalid");
  }
  assertOptionalNonEmptyString(value.syncedThroughMessageId, "cursor message");
  assertOptionalPositiveInteger(value.sessionGeneration, "cursor generation");
  assertOptionalNonEmptyString(value.contextId, "cursor contextId");
  assertOptionalFingerprint(value.workspaceFingerprint, "cursor workspace fingerprint");
  assertOptionalNonEmptyString(value.snapshotVersion, "cursor snapshot");
}

function validateNativeExecutionRef(value: unknown, backendId: string): void {
  if (
    !isRecord(value)
    || value.backendId !== backendId
    || !isNonEmptyString(value.id)
    || !["thread", "session", "run", "process"].includes(
      typeof value.kind === "string" ? value.kind : ""
    )
    || !["none", "process-local", "provider-persistent", "unknown"].includes(
      typeof value.persistence === "string" ? value.persistence : ""
    )
    || !isNonEmptyString(value.deviceKey)
    || !isNonEmptyString(value.vaultId)
    || !isNonNegativeFiniteNumber(value.createdAt)
  ) {
    throw new Error("Conversation recovery required: native execution reference is invalid");
  }
  if (
    value.transport !== undefined
    && !isSafeNativeExecutionTransport(value.transport)
  ) {
    throw new Error(
      "Conversation recovery required: native execution transport is invalid"
    );
  }
  assertOptionalNonEmptyString(value.providerEndpoint, "native execution endpoint");
}

async function readRequiredJsonl<T>(
  filePath: string,
  label: string,
  validateRow?: (value: unknown) => T
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Conversation recovery required: ${label} is missing`);
    }
    throw error;
  }
  try {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const value = JSON.parse(line) as unknown;
        return validateRow ? validateRow(value) : value as T;
      });
  } catch (error) {
    throw new Error(
      `Conversation recovery required: ${label} contains invalid JSONL`,
      { cause: error }
    );
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeJsonlAtomic(filePath: string, rows: unknown[]): Promise<void> {
  await writeTextAtomic(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(
    path.dirname(filePath),
    `.conversation-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function safeSessionPathPart(value: string): string {
  if (!isSafeConversationSessionId(value)) {
    throw new ConversationContextConflictError(
      `Conversation session ID is unsafe for durable storage: ${value}`
    );
  }
  return value;
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyConversationIndex(): ConversationStoreIndex {
  return { version: 1, updatedAt: 0, sessions: [] };
}

function conversationSessionSummary(
  session: StoredSession
): ConversationSessionSummary {
  const summary: ConversationSessionSummary = {
    sessionId: session.id,
    title: session.title,
    ...(session.kind ? { kind: session.kind } : {}),
    messageCount: session.messages.length,
    updatedAt: session.updatedAt
  };
  if (!isConversationSessionSummary(summary)) {
    throw new ConversationContextConflictError(
      `Conversation recovery required: committed summary is invalid for ${session.id}`
    );
  }
  return summary;
}

function compareConversationSessionSummaries(
  left: ConversationSessionSummary,
  right: ConversationSessionSummary
): number {
  return right.updatedAt - left.updatedAt
    || left.sessionId.localeCompare(right.sessionId);
}

function parseConversationIndexStrict(text: string): ConversationStoreIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConversationContextConflictError(
      `Conversation index is not valid JSON: ${errorMessage(error)}`
    );
  }
  if (
    !isRecord(parsed)
    || !hasExactObjectKeys(parsed, ["version", "updatedAt", "sessions"])
    || parsed.version !== 1
    || !isNonNegativeInteger(parsed.updatedAt)
    || !Array.isArray(parsed.sessions)
    || !parsed.sessions.every(isConversationSessionSummary)
  ) {
    throw new ConversationContextConflictError(
      "Conversation index schema is unknown or corrupt"
    );
  }
  const ids = parsed.sessions.map((session) => session.sessionId);
  for (const id of ids) safeSessionPathPart(id);
  if (new Set(ids).size !== ids.length) {
    throw new ConversationContextConflictError(
      "Conversation index contains duplicate session IDs"
    );
  }
  return {
    version: 1,
    updatedAt: parsed.updatedAt,
    sessions: parsed.sessions
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function assertOptionalNonNegativeNumber(value: unknown, label: string): void {
  if (value !== undefined && !isNonNegativeFiniteNumber(value)) {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function assertOptionalNonNegativeInteger(value: unknown, label: string): void {
  if (value !== undefined && !isNonNegativeInteger(value)) {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function assertOptionalPositiveInteger(value: unknown, label: string): void {
  if (value !== undefined && !isPositiveSafeInteger(value)) {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function assertOptionalFingerprint(value: unknown, label: string): void {
  if (
    value !== undefined
    && (
      typeof value !== "string"
      || !/^sha256:[a-f0-9]{16,128}$/i.test(value)
    )
  ) {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function assertOptionalEnum(
  value: unknown,
  allowed: readonly string[],
  label: string
): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    throw new Error(`Conversation recovery required: ${label} is invalid`);
  }
}

function isConversationSessionSummary(value: unknown): value is ConversationSessionSummary {
  if (
    !isRecord(value)
    || !hasExactObjectKeys(
      value,
      ["sessionId", "title", "messageCount", "updatedAt"],
      ["kind"]
    )
  ) return false;
  const summary = value as Partial<ConversationSessionSummary>;
  return Boolean(
    summary
      && isNonEmptyString(summary.sessionId)
      && isNonEmptyString(summary.title)
      && (
        summary.kind === undefined
        || summary.kind === "chat"
        || summary.kind === "knowledge-base"
      )
      && isNonNegativeInteger(summary.messageCount)
      && isNonNegativeInteger(summary.updatedAt)
  );
}

function hasExactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}
