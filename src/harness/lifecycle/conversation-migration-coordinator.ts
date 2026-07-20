import { randomUUID } from "node:crypto";
import {
  FileConversationStore
} from "../conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../conversation/conversation-store-v2";
import {
  advanceConversationStoreManifestToActive,
  advanceConversationStoreManifestToValidated,
  createCopyingConversationStoreManifest,
  FileConversationStoreManifest,
  type ConversationStoreManifest
} from "../conversation/store-manifest";
import { FileRunRecordStore } from "../ledger/run-record-store";
import { NativeExecutionStore } from "../native/native-execution-store";
import {
  conversationMigrationInventoryFromLegacySessions,
  inspectAndValidateConversationStoreMigration,
  prepareConversationStoreV2Migration,
  type PrepareConversationStoreV2MigrationResult,
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

export interface ActivateConversationStoreV2WithOwnerStoresInput
extends InspectConversationStoreMigrationWithOwnerStoresInput {
  manifestStore: FileConversationStoreManifest;
  now?: () => number;
  createCommitId?: (
    stage: "copying" | "validated" | "active"
  ) => string;
}

export interface ConversationStoreV2ActivationResult {
  status: "activated" | "already-active" | "blocked";
  manifest: ConversationStoreManifest | null;
  ownerProof: ConversationMigrationOwnerProof | null;
  preparation: PrepareConversationStoreV2MigrationResult | null;
  validation: ConversationStoreMigrationOwnerValidation | null;
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

/**
 * The only production coordinator that may publish the forward active route.
 * Its caller must hold the process-wide migration quiet window; this function
 * then rebuilds every owner proof from the locked Store readbacks immediately
 * before the append-only manifest cutover.
 */
export async function activateConversationStoreV2WithOwnerStores(
  input: ActivateConversationStoreV2WithOwnerStoresInput
): Promise<ConversationStoreV2ActivationResult> {
  const now = input.now ?? Date.now;
  const createCommitId = input.createCommitId
    ?? ((stage: "copying" | "validated" | "active") =>
      `conversation-v2-${stage}-${randomUUID()}`);
  let manifest = await input.manifestStore.read();
  if (manifest?.migrationState === "active") {
    return {
      status: "already-active",
      manifest,
      ownerProof: null,
      preparation: null,
      validation: null
    };
  }

  const sourceSnapshot = await input.sourceStore.inspectMigrationSnapshot();
  const sourceInventory = conversationMigrationInventoryFromLegacySessions(
    sourceSnapshot.sessions,
    { deletionTombstones: sourceSnapshot.deletionTombstones }
  );
  if (
    manifest
    && manifest.sourceFingerprint !== sourceInventory.fingerprint
  ) {
    throw new Error(
      "Conversation migration blocked: source changed after manifest preparation"
    );
  }

  const ownerProof = await inspectConversationMigrationOwnerProof({
    sourceSessions: sourceSnapshot.sessions,
    settingsDataPath: input.settingsDataPath,
    nativeStore: input.nativeStore,
    runStore: input.runStore
  });
  if (ownerProof.status !== "ready") {
    return {
      status: "blocked",
      manifest,
      ownerProof,
      preparation: null,
      validation: null
    };
  }

  if (!manifest) {
    const createdAt = now();
    const copying = createCopyingConversationStoreManifest({
      commitId: createCommitId("copying"),
      sourceFingerprint: sourceInventory.fingerprint,
      createdAt
    });
    manifest = await input.manifestStore.compareAndSwap(copying, {
      expectedRevision: null,
      expectedCommitId: null
    });
  }

  const preparation = await prepareConversationStoreV2Migration({
    sourceStore: input.sourceStore,
    targetStore: input.targetStore,
    targetExternalOwnerEdges: ownerProof.targetExternalOwnerEdges
  });
  const validation =
    await inspectConversationStoreMigrationWithOwnerStores(input);
  if (
    validation.ownerProof.status !== "ready"
    || validation.report.status !== "ready"
    || !validation.proof
  ) {
    return {
      status: "blocked",
      manifest,
      ownerProof: validation.ownerProof,
      preparation,
      validation
    };
  }

  if (manifest.migrationState === "copying") {
    const validated = advanceConversationStoreManifestToValidated(
      manifest,
      {
        commitId: createCommitId("validated"),
        proof: validation.proof,
        updatedAt: now()
      }
    );
    manifest = await input.manifestStore.compareAndSwap(validated, {
      expectedRevision: manifest.revision,
      expectedCommitId: manifest.commitId
    });
  }
  if (
    manifest.migrationState !== "validated"
    || manifest.targetFingerprint !== validation.target.fingerprint
  ) {
    throw new Error(
      "Conversation migration blocked: validated manifest does not match locked target"
    );
  }

  const pending = await input.manifestStore.readPendingActiveCutover();
  if (pending) {
    if (
      pending.sourceFingerprint !== validation.source.fingerprint
      || pending.targetFingerprint !== validation.target.fingerprint
    ) {
      throw new Error(
        "Conversation migration blocked: pending active fence drifted"
      );
    }
    const recovered =
      await input.manifestStore.recoverPendingActiveCutover();
    if (!recovered || recovered.migrationState !== "active") {
      throw new Error(
        "Conversation migration active fence recovery did not reach active"
      );
    }
    return {
      status: "activated",
      manifest: recovered,
      ownerProof: validation.ownerProof,
      preparation,
      validation
    };
  }

  const active = advanceConversationStoreManifestToActive(manifest, {
    commitId: createCommitId("active"),
    activatedAt: now()
  });
  const committed = await input.manifestStore.compareAndSwap(active, {
    expectedRevision: manifest.revision,
    expectedCommitId: manifest.commitId
  });
  return {
    status: "activated",
    manifest: committed,
    ownerProof: validation.ownerProof,
    preparation,
    validation
  };
}
