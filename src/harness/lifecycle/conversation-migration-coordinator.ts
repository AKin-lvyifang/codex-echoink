import {
  FileConversationStore
} from "../conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../conversation/conversation-store-v2";
import { FileRunRecordStore } from "../ledger/run-record-store";
import { NativeExecutionStore } from "../native/native-execution-store";
import {
  conversationMigrationInventoryFromLegacySessions,
  inspectAndValidateConversationStoreMigration,
  type ConversationStoreMigrationValidation
} from "./conversation-migration-projection";
import {
  inspectConversationMigrationOwnerProof,
  type ConversationMigrationOwnerProof
} from "./conversation-migration-owner-proof";

export interface InspectConversationStoreMigrationWithOwnerStoresInput {
  sourceStore: FileConversationStore;
  targetStore: FileConversationStoreV2;
  settingsDataPath: string;
  nativeStore: NativeExecutionStore;
  runStore: FileRunRecordStore;
}

export interface ConversationStoreMigrationOwnerValidation
extends ConversationStoreMigrationValidation {
  ownerProof: ConversationMigrationOwnerProof;
}

/**
 * Production-grade validation entrypoint. External owner edges are always
 * rebuilt from Store readback and are checked again after Conversation
 * validation so stale caller snapshots cannot authorize cutover.
 */
export async function inspectConversationStoreMigrationWithOwnerStores(
  input: InspectConversationStoreMigrationWithOwnerStoresInput
): Promise<ConversationStoreMigrationOwnerValidation> {
  const before = await input.sourceStore.inspectMigrationSnapshot();
  const firstOwnerProof = await inspectConversationMigrationOwnerProof({
    sourceSessions: before.sessions,
    settingsDataPath: input.settingsDataPath,
    nativeStore: input.nativeStore,
    runStore: input.runStore
  });
  const validation = await inspectAndValidateConversationStoreMigration({
    sourceStore: input.sourceStore,
    targetStore: input.targetStore,
    targetExternalOwnerEdges: firstOwnerProof.targetExternalOwnerEdges
  });
  const sourceBefore = conversationMigrationInventoryFromLegacySessions(
    before.sessions,
    { deletionTombstones: before.deletionTombstones }
  );
  if (sourceBefore.fingerprint !== validation.source.fingerprint) {
    throw new Error(
      "Conversation migration blocked: source changed after owner proof"
    );
  }
  const after = await input.sourceStore.inspectMigrationSnapshot();
  const secondOwnerProof = await inspectConversationMigrationOwnerProof({
    sourceSessions: after.sessions,
    settingsDataPath: input.settingsDataPath,
    nativeStore: input.nativeStore,
    runStore: input.runStore
  });
  if (firstOwnerProof.fingerprint !== secondOwnerProof.fingerprint) {
    throw new Error(
      "Conversation migration blocked: owner Stores changed during validation"
    );
  }
  return {
    ...validation,
    ownerProof: secondOwnerProof
  };
}
