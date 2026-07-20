import * as path from "node:path";
import {
  FileConversationStore,
  type CommitConversationContextOptions,
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
  resolveConversationStoreSelection,
  type ConversationStoreSelection
} from "../harness/conversation/store-selection";
import {
  echoInkConversationRecordMutationRootId,
  type EchoInkRecordMutationRootId
} from "../harness/lifecycle/record-mutation-production";
import type { StoredSession } from "../settings/settings";

export type ConversationStoreRoutingErrorCode =
  | "v2-live-route-unavailable";

/**
 * Production routing must never infer a writable Store from a hard-coded
 * directory. A forward V2 cutover is allowed only after the live V2 adapter
 * implements the complete settings/mutation contract.
 */
export class ConversationStoreRoutingError extends Error {
  constructor(
    public readonly code: ConversationStoreRoutingErrorCode,
    public readonly selection: ConversationStoreSelection,
    operation: string
  ) {
    super(
      `Conversation Store route ${selection.storeRef} cannot execute live operation ${operation}`
    );
    this.name = "ConversationStoreRoutingError";
  }
}

/**
 * Single production entrypoint for the legacy and restored-V1 live Stores.
 *
 * Every operation resolves the append-only route first. This makes forward or
 * reverse cutover visible to both readers and writers, and prevents an active
 * V2 reader from being paired with a hidden write to the legacy V1 root.
 */
export class FileConversationStoreRouter {
  readonly storageRootPath: string;
  private selectedV1:
    | {
        rootPath: string;
        store: FileConversationStore;
      }
    | null = null;

  constructor(storageRootPathInput: string) {
    this.storageRootPath = path.resolve(storageRootPathInput);
  }

  async resolveLiveRootPath(): Promise<string> {
    const { selection } = await this.resolveV1("resolve-live-root");
    return selection.rootPath;
  }

  async resolveRecordMutationRoute(): Promise<{
    rootId: EchoInkRecordMutationRootId;
    rootPath: string;
  }> {
    const rootPath = await this.resolveLiveRootPath();
    return {
      rootId: echoInkConversationRecordMutationRootId({
        storageRootPath: this.storageRootPath,
        conversationRootPath: rootPath
      }),
      rootPath
    };
  }

  async readSession(sessionId: string): Promise<StoredSession | null> {
    const { store } = await this.resolveV1("read-session");
    return await store.readSession(sessionId);
  }

  async proveMessageAuthority(
    probe: ConversationMessageAuthorityProbe
  ): Promise<ConversationMessageAuthorityProof> {
    const { store } = await this.resolveV1("prove-message-authority");
    return await store.proveMessageAuthority(probe);
  }

  async commitSessionContext(
    session: StoredSession,
    options: CommitConversationContextOptions
  ): Promise<ConversationContextCommitReceipt> {
    const { store } = await this.resolveV1("commit-session-context");
    return await store.commitSessionContext(session, options);
  }

  async proveSessionContextAuthority(
    probe: ConversationAuthorityProbe
  ): Promise<ConversationAuthorityProof> {
    const { store } = await this.resolveV1(
      "prove-session-context-authority"
    );
    return await store.proveSessionContextAuthority(probe);
  }

  async planConversationRecordMutationSources(
    input: PlanConversationRecordMutationSourcesInput
  ): Promise<ConversationRecordMutationSource[]> {
    const { store } = await this.resolveV1(
      "plan-conversation-record-mutation"
    );
    return await store.planConversationRecordMutationSources(input);
  }

  async commitConversationRecordClear(
    session: StoredSession,
    options: CommitConversationRecordClearOptions
  ): Promise<ConversationContextCommitReceipt> {
    const { store } = await this.resolveV1(
      "commit-conversation-record-clear"
    );
    return await store.commitConversationRecordClear(session, options);
  }

  async commitConversationDeletionTombstone(
    tombstone: ConversationDeletionTombstoneV1,
    options: CommitConversationContextOptions
  ): Promise<ConversationDeletionTombstoneV1> {
    const { store } = await this.resolveV1(
      "commit-conversation-deletion-tombstone"
    );
    return await store.commitConversationDeletionTombstone(
      tombstone,
      options
    );
  }

  async readConversationDeletionTombstone(
    conversationId: string
  ): Promise<ConversationDeletionTombstoneV1 | null> {
    const { store } = await this.resolveV1(
      "read-conversation-deletion-tombstone"
    );
    return await store.readConversationDeletionTombstone(conversationId);
  }

  async persistSettingsSessions(
    settings: { sessions: StoredSession[] },
    options: {
      trimSettingsMessages?: boolean;
      afterSessionPersisted?: (session: StoredSession) => void;
    } = {}
  ): Promise<ConversationStoreMigrationResult> {
    const { store } = await this.resolveV1("persist-settings-sessions");
    return await store.persistSettingsSessions(settings, options);
  }

  async reconcileCommittedSessionsAtStartup():
  Promise<ConversationStoreStartupReconciliationResult> {
    const { store } = await this.resolveV1(
      "reconcile-committed-sessions"
    );
    return await store.reconcileCommittedSessionsAtStartup();
  }

  async createPristineSession(session: StoredSession): Promise<void> {
    const { store } = await this.resolveV1("create-pristine-session");
    await store.createPristineSession(session);
  }

  private async resolveV1(operation: string): Promise<{
    selection: ConversationStoreSelection;
    store: FileConversationStore;
  }> {
    const selection = await resolveConversationStoreSelection(
      this.storageRootPath
    );
    if (selection.activeStore === "v2") {
      throw new ConversationStoreRoutingError(
        "v2-live-route-unavailable",
        selection,
        operation
      );
    }
    const rootPath = path.resolve(selection.rootPath);
    if (this.selectedV1?.rootPath !== rootPath) {
      this.selectedV1 = {
        rootPath,
        store: new FileConversationStore({ rootPath })
      };
    }
    return {
      selection,
      store: this.selectedV1.store
    };
  }
}
