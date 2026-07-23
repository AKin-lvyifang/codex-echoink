import * as path from "node:path";
import {
  FileConversationStore,
  type CommitConversationContextOptions,
  type CommitConversationDeletionTombstoneOptions,
  type CommitConversationHistoryRestoreOptions,
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
import {
  FileConversationStoreV2LiveAdapter
} from "./conversation-store-v2-live-adapter";

type RoutedConversationStore =
  | FileConversationStore
  | FileConversationStoreV2LiveAdapter;

/**
 * Single production entrypoint for legacy V1, canonical V2 and restored V1.
 *
 * Every operation resolves the append-only route first. This makes forward or
 * reverse cutover visible to both readers and writers.
 */
export class FileConversationStoreRouter {
  readonly storageRootPath: string;
  private selected:
    | {
        storeRef: ConversationStoreSelection["storeRef"];
        rootPath: string;
        store: RoutedConversationStore;
      }
    | null = null;

  constructor(storageRootPathInput: string) {
    this.storageRootPath = path.resolve(storageRootPathInput);
  }

  async resolveLiveRootPath(): Promise<string> {
    const { selection } = await this.resolveStore();
    return selection.rootPath;
  }

  async resolveSelection(): Promise<ConversationStoreSelection> {
    return (await this.resolveStore()).selection;
  }

  async resolveRecordMutationRoute(): Promise<{
    rootId: EchoInkRecordMutationRootId;
    rootPath: string;
    storeVersion: "v1" | "v2";
  }> {
    const { selection } = await this.resolveStore();
    const rootPath = selection.rootPath;
    return {
      rootId: echoInkConversationRecordMutationRootId({
        storageRootPath: this.storageRootPath,
        conversationRootPath: rootPath
      }),
      rootPath,
      storeVersion: selection.activeStore
    };
  }

  async readSession(sessionId: string): Promise<StoredSession | null> {
    const { store } = await this.resolveStore();
    return await store.readSession(sessionId);
  }

  async proveMessageAuthority(
    probe: ConversationMessageAuthorityProbe
  ): Promise<ConversationMessageAuthorityProof> {
    const { store } = await this.resolveStore();
    return await store.proveMessageAuthority(probe);
  }

  async commitSessionContext(
    session: StoredSession,
    options: CommitConversationContextOptions
  ): Promise<ConversationContextCommitReceipt> {
    const { store } = await this.resolveStore();
    return await store.commitSessionContext(session, options);
  }

  async proveSessionContextAuthority(
    probe: ConversationAuthorityProbe
  ): Promise<ConversationAuthorityProof> {
    const { store } = await this.resolveStore();
    return await store.proveSessionContextAuthority(probe);
  }

  async planConversationRecordMutationSources(
    input: PlanConversationRecordMutationSourcesInput
  ): Promise<ConversationRecordMutationSource[]> {
    const { store } = await this.resolveStore();
    return await store.planConversationRecordMutationSources(input);
  }

  async commitConversationRecordClear(
    session: StoredSession,
    options: CommitConversationRecordClearOptions
  ): Promise<ConversationContextCommitReceipt> {
    const { store } = await this.resolveStore();
    return await store.commitConversationRecordClear(session, options);
  }

  async commitConversationHistoryRestore(
    session: StoredSession,
    options: CommitConversationHistoryRestoreOptions
  ): Promise<ConversationContextCommitReceipt> {
    const { store } = await this.resolveStore();
    return await store.commitConversationHistoryRestore(session, options);
  }

  async commitConversationDeletionTombstone(
    tombstone: ConversationDeletionTombstoneV1,
    options: CommitConversationDeletionTombstoneOptions
  ): Promise<ConversationDeletionTombstoneV1> {
    const { store } = await this.resolveStore();
    return await store.commitConversationDeletionTombstone(
      tombstone,
      options
    );
  }

  async readConversationDeletionTombstone(
    conversationId: string
  ): Promise<ConversationDeletionTombstoneV1 | null> {
    const { store } = await this.resolveStore();
    return await store.readConversationDeletionTombstone(conversationId);
  }

  async persistSettingsSessions(
    settings: { sessions: StoredSession[] },
    options: {
      trimSettingsMessages?: boolean;
      afterSessionPersisted?: (session: StoredSession) => void;
    } = {}
  ): Promise<ConversationStoreMigrationResult> {
    const { store } = await this.resolveStore();
    return await store.persistSettingsSessions(settings, options);
  }

  async reconcileCommittedSessionsAtStartup():
  Promise<ConversationStoreStartupReconciliationResult> {
    const { store } = await this.resolveStore();
    return await store.reconcileCommittedSessionsAtStartup();
  }

  async createPristineSession(session: StoredSession): Promise<void> {
    const { store } = await this.resolveStore();
    await store.createPristineSession(session);
  }

  private async resolveStore(): Promise<{
    selection: ConversationStoreSelection;
    store: RoutedConversationStore;
  }> {
    const selection = await resolveConversationStoreSelection(
      this.storageRootPath
    );
    const rootPath = path.resolve(selection.rootPath);
    if (
      this.selected?.rootPath !== rootPath
      || this.selected.storeRef !== selection.storeRef
    ) {
      this.selected = {
        storeRef: selection.storeRef,
        rootPath,
        store: selection.activeStore === "v2"
          ? new FileConversationStoreV2LiveAdapter(
            this.storageRootPath
          )
          : new FileConversationStore({ rootPath })
      };
    }
    return {
      selection,
      store: this.selected.store
    };
  }
}
