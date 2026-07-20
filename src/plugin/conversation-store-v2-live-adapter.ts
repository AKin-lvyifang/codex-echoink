import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ConversationContextConflictError,
  createConversationContentRevision,
  type CommitConversationContextOptions,
  type CommitConversationDeletionTombstoneOptions,
  type CommitConversationRecordClearOptions,
  type ConversationAuthorityProbe,
  type ConversationAuthorityProof,
  type ConversationContextCommitReceipt,
  type ConversationDeletionTombstoneV1,
  type ConversationMessageAuthorityProbe,
  type ConversationMessageAuthorityProof,
  type ConversationRecordMutationSource,
  type ConversationStoreMigrationResult,
  type ConversationStoreStartupReconciliationResult,
  type PlanConversationRecordMutationSourcesInput
} from "../harness/conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../harness/conversation/conversation-store-v2";
import {
  createConversationProductMessageRevision,
  createConversationProductRevision,
  projectStoredSessionToLiveConversationCommitV2
} from "../harness/lifecycle/conversation-migration-projection";
import {
  projectConversationCommitV2ToStoredSessionV1
} from "../harness/lifecycle/conversation-v1-exporter";
import { sessionGeneration } from "../harness/kernel/session-service";
import type { StoredSession } from "../settings/settings";

/**
 * Product-facing adapter for a manifest-selected canonical V2 Store.
 *
 * V2 owns Conversation product state. Backend bindings, detailed Run state
 * and other Settings projections remain in their dedicated Stores/data shell
 * and are intentionally absent from the returned durable Conversation.
 */
export class FileConversationStoreV2LiveAdapter {
  readonly store: FileConversationStoreV2;

  constructor(storageRootPath: string) {
    this.store = new FileConversationStoreV2({ storageRootPath });
  }

  async readSession(sessionId: string): Promise<StoredSession | null> {
    if (await this.store.readDeletionTombstone(sessionId)) return null;
    const commit = await this.store.readConversation(sessionId);
    return commit
      ? projectConversationCommitV2ToStoredSessionV1(commit)
      : null;
  }

  async proveMessageAuthority(
    probe: ConversationMessageAuthorityProbe
  ): Promise<ConversationMessageAuthorityProof> {
    if (
      !probe.messageId.trim()
      || probe.expectedMessage.id !== probe.messageId
    ) {
      throw new Error(
        "Conversation recovery required: message authority probe is invalid"
      );
    }
    const expectedPayloadDigest =
      createConversationProductMessageRevision(probe.expectedMessage);
    const commit = await this.store.readConversation(probe.conversationId);
    const matching = commit?.payload.messages.filter(
      (message) => message.id === probe.messageId
    ) ?? [];
    const currentPayloadDigests = matching.map(
      createConversationProductMessageRevision
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
  }

  async commitSessionContext(
    session: StoredSession,
    options: CommitConversationContextOptions
  ): Promise<ConversationContextCommitReceipt> {
    const current = await this.requireExpectedSession(session.id, options);
    const committed = await this.commitCandidate(session, current);
    return contextCommitReceipt(
      projectConversationCommitV2ToStoredSessionV1(committed)
    );
  }

  async proveSessionContextAuthority(
    probe: ConversationAuthorityProbe
  ): Promise<ConversationAuthorityProof> {
    if (await this.store.readDeletionTombstone(probe.conversationId)) {
      throw new Error(
        `Conversation recovery required: conversation ${probe.conversationId} is deleted`
      );
    }
    const history = await this.store.readConversationHistory(
      probe.conversationId
    );
    const current = history.at(-1);
    if (!current) {
      throw new Error(
        `Conversation recovery required: conversation ${probe.conversationId} is missing`
      );
    }
    const currentSession =
      projectConversationCommitV2ToStoredSessionV1(current);
    const currentContextCommitId =
      current.metadata.currentContext.commitId
      ?? current.metadata.commitId;
    const matchingTarget = history.filter((commit) => (
      (
        commit.metadata.currentContext.commitId
        ?? commit.metadata.commitId
      ) === probe.targetCommitId
    ));
    const targetPayload = currentContextCommitId === probe.targetCommitId
      ? "active" as const
      : matchingTarget.length
        ? "previous" as const
        : "absent" as const;
    const currentGeneration = sessionGeneration(currentSession);
    const exactIdentity = (
      currentContextCommitId === probe.targetCommitId
      && current.metadata.currentContext.id
        === (probe.targetContextId?.trim()
          || current.metadata.currentContext.id)
      && current.metadata.currentContext.workspaceFingerprint
        === (probe.targetWorkspaceFingerprint?.trim()
          || current.metadata.currentContext.workspaceFingerprint)
    );
    const relation = currentGeneration === probe.targetGeneration
      ? exactIdentity && targetPayload === "active"
        ? "exact" as const
        : "conflict" as const
      : targetPayload === "active"
        ? "conflict" as const
        : currentGeneration < probe.targetGeneration
          ? "before" as const
          : "later" as const;
    return {
      conversationId: probe.conversationId,
      currentGeneration,
      currentContextId: current.metadata.currentContext.id,
      currentCommitId: currentContextCommitId,
      currentWorkspaceFingerprint:
        current.metadata.currentContext.workspaceFingerprint,
      targetPayload,
      relation
    };
  }

  async planConversationRecordMutationSources(
    input: PlanConversationRecordMutationSourcesInput
  ): Promise<ConversationRecordMutationSource[]> {
    await this.requireExpectedSession(input.conversationId, {
      expectedGeneration: input.expectedGeneration,
      expectedCommitId: input.expectedCommitId,
      expectedContentRevision: input.expectedContentRevision
    });
    return (await this.store.planRecordMutationSources({
      operation: input.operation,
      conversationId: input.conversationId
    })).map((sourceRelativePath) => ({ sourceRelativePath }));
  }

  async commitConversationRecordClear(
    session: StoredSession,
    options: CommitConversationRecordClearOptions
  ): Promise<ConversationContextCommitReceipt> {
    const mutationId = options.mutationId?.trim();
    if (!mutationId) {
      throw new ConversationContextConflictError(
        "Conversation V2 record clear requires its mutationId"
      );
    }
    const current = await this.requireExpectedSession(session.id, options);
    const candidate = projectStoredSessionToLiveConversationCommitV2(
      session,
      {
        previous: current,
        metadataCommitId: liveMetadataCommitId()
      }
    );
    const committed = await this.store.commitConversation(candidate, {
      expectedRevision: current.metadata.revision,
      expectedCommitId: current.metadata.commitId,
      recordMutationPayloadReplacement: {
        mutationId,
        sourceRelativePaths: options.sourceRelativePaths
      }
    });
    return contextCommitReceipt(
      projectConversationCommitV2ToStoredSessionV1(committed)
    );
  }

  async commitConversationDeletionTombstone(
    tombstone: ConversationDeletionTombstoneV1,
    options: CommitConversationDeletionTombstoneOptions
  ): Promise<ConversationDeletionTombstoneV1> {
    const existing = await this.store.readDeletionTombstone(
      tombstone.conversationId
    );
    if (existing) {
      if (!isDeepStrictEqual(existing, tombstone)) {
        throw new ConversationContextConflictError(
          `Conversation ${tombstone.conversationId} deletion tombstone conflicts`
        );
      }
      return existing;
    }
    await this.requireExpectedSession(tombstone.conversationId, options);
    if (
      tombstone.sourceGeneration !== options.expectedGeneration
      || tombstone.sourceCommitId
        !== (options.expectedCommitId?.trim() ?? "")
      || tombstone.sourceContentRevision
        !== options.expectedContentRevision
      || !options.sourceRelativePaths?.length
    ) {
      throw new ConversationContextConflictError(
        `Conversation ${tombstone.conversationId} deletion authority changed`
      );
    }
    return await this.store.commitDeletionTombstone(tombstone, {
      recordMutationRetirement: {
        mutationId: tombstone.mutationId,
        sourceRelativePaths: options.sourceRelativePaths
      }
    });
  }

  async readConversationDeletionTombstone(
    conversationId: string
  ): Promise<ConversationDeletionTombstoneV1 | null> {
    return await this.store.readDeletionTombstone(conversationId);
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
      const current = await this.store.readConversation(session.id);
      if (!current) {
        if (await this.store.readDeletionTombstone(session.id)) {
          throw new ConversationContextConflictError(
            `Conversation ${session.id} has a durable deletion tombstone`
          );
        }
        throw new ConversationContextConflictError(
          `Conversation ${session.id} is missing; use createPristineSession`
        );
      }
      await this.commitCandidate(session, current);
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

  async reconcileCommittedSessionsAtStartup():
  Promise<ConversationStoreStartupReconciliationResult> {
    const before = await this.store.readIndex();
    const after = await this.store.reconcileIndex();
    const sessions: StoredSession[] = [];
    for (const shell of after) {
      const session = await this.readSession(shell.conversationId);
      if (!session) {
        throw new ConversationContextConflictError(
          `Conversation V2 index references missing session ${shell.conversationId}`
        );
      }
      sessions.push(session);
    }
    const beforeIds = new Set(
      before.map((shell) => shell.conversationId)
    );
    return {
      sessions,
      repairedIndex: !isDeepStrictEqual(before, after),
      recoveredIndexSessionIds: after
        .map((shell) => shell.conversationId)
        .filter((conversationId) => !beforeIds.has(conversationId)),
      deletedSessionIds: (await this.store.listDeletionTombstones())
        .map((tombstone) => tombstone.conversationId)
        .sort((left, right) => left.localeCompare(right))
    };
  }

  async createPristineSession(session: StoredSession): Promise<void> {
    if (
      session.revision !== 1
      || session.generation !== 1
      || session.messages.length !== 0
    ) {
      throw new ConversationContextConflictError(
        "Pristine Conversation V2 candidate is invalid"
      );
    }
    if (await this.store.readDeletionTombstone(session.id)) {
      throw new ConversationContextConflictError(
        `Conversation ${session.id} has a durable deletion tombstone`
      );
    }
    const current = await this.store.readConversation(session.id);
    if (current) {
      const durable =
        projectConversationCommitV2ToStoredSessionV1(current);
      if (
        createConversationContentRevision(durable)
        !== createConversationContentRevision(session)
      ) {
        throw new ConversationContextConflictError(
          `Conversation ${session.id} already exists`
        );
      }
      return;
    }
    const candidate = projectStoredSessionToLiveConversationCommitV2(
      session,
      {
        previous: null,
        metadataCommitId: liveMetadataCommitId()
      }
    );
    await this.store.commitConversation(candidate, {
      expectedRevision: null,
      expectedCommitId: null
    });
  }

  private async requireExpectedSession(
    conversationId: string,
    options: CommitConversationContextOptions
  ) {
    const current = await this.store.readConversation(conversationId);
    if (!current || await this.store.readDeletionTombstone(conversationId)) {
      throw new ConversationContextConflictError(
        `Conversation ${conversationId} is missing`
      );
    }
    const durable =
      projectConversationCommitV2ToStoredSessionV1(current);
    if (
      sessionGeneration(durable) !== options.expectedGeneration
      || (durable.commitId?.trim() ?? "")
        !== (options.expectedCommitId?.trim() ?? "")
      || createConversationContentRevision(durable)
        !== options.expectedContentRevision
    ) {
      throw new ConversationContextConflictError(
        `Conversation ${conversationId} changed before commit`
      );
    }
    return current;
  }

  private async commitCandidate(session: StoredSession, current: Awaited<
    ReturnType<FileConversationStoreV2["readConversation"]>
  >) {
    const candidate = projectStoredSessionToLiveConversationCommitV2(
      session,
      {
        previous: current,
        metadataCommitId: liveMetadataCommitId()
      }
    );
    if (
      current
      && createConversationProductRevision(current)
        === createConversationProductRevision(candidate)
    ) {
      return current;
    }
    return await this.store.commitConversation(candidate, {
      expectedRevision: current?.metadata.revision ?? null,
      expectedCommitId: current?.metadata.commitId ?? null
    });
  }
}

function contextCommitReceipt(
  session: StoredSession
): ConversationContextCommitReceipt {
  const commitId = session.commitId?.trim();
  if (!commitId) {
    throw new ConversationContextConflictError(
      "Conversation V2 Context commit readback is missing"
    );
  }
  return {
    conversationId: session.id,
    generation: sessionGeneration(session),
    ...(session.contextId ? { contextId: session.contextId } : {}),
    ...(session.contextStartsAfterMessageId
      ? {
        contextStartsAfterMessageId:
          session.contextStartsAfterMessageId
      }
      : {}),
    commitId,
    ...(session.workspaceFingerprint
      ? { workspaceFingerprint: session.workspaceFingerprint }
      : {})
  };
}

function liveMetadataCommitId(): string {
  return `conversation-live-${randomUUID()}`;
}
