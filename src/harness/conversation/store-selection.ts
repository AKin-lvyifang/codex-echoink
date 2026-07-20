import * as path from "node:path";
import {
  assertConversationStoreV1ExportDirectoryChain,
  conversationStoreV1ExportStoreRoot,
  conversationStoreV1LegacyRoot
} from "./conversation-store-paths";
import { conversationStoreV2Root } from "./conversation-store-v2";
import {
  FileConversationStoreManifest,
  type ConversationStoreManifest
} from "./store-manifest";
import {
  FileConversationStoreRestoreManifest,
  type ConversationStoreRestoreManifest
} from "./store-restore-manifest";

export type ConversationStoreRef =
  | "legacy-v1"
  | "canonical-v2"
  | `v1-export:${string}`;

export interface ConversationStoreSelection {
  activeStore: "v1" | "v2";
  storeRef: ConversationStoreRef;
  rootPath: string;
  routeRevision: number | null;
  routeDigest: string | null;
  reason:
    | "manifest-absent"
    | "migration-incomplete"
    | "active-cutover-pending"
    | "manifest-active"
    | "restore-migration-incomplete"
    | "restore-active-cutover-pending"
    | "restore-manifest-active";
  manifest: ConversationStoreManifest | null;
  restoreManifest: ConversationStoreRestoreManifest | null;
}

export async function resolveConversationStoreSelection(
  storageRootPathInput: string
): Promise<ConversationStoreSelection> {
  const storageRootPath = path.resolve(storageRootPathInput);
  const forwardStore = new FileConversationStoreManifest({
    storageRootPath
  });
  const manifest = await forwardStore.read();
  const restoreStore = new FileConversationStoreRestoreManifest({
    storageRootPath
  });
  const restoreManifest = await restoreStore.read();
  if (!manifest) {
    return legacySelection({
      storageRootPath,
      reason: "manifest-absent",
      manifest: null
    });
  }
  const pendingActive = await forwardStore.readPendingActiveCutover();
  if (pendingActive) {
    return legacySelection({
      storageRootPath,
      reason: "active-cutover-pending",
      manifest
    });
  }
  if (manifest.migrationState !== "active") {
    return legacySelection({
      storageRootPath,
      reason: "migration-incomplete",
      manifest
    });
  }
  if (!restoreManifest) {
    return v2Selection({
      storageRootPath,
      reason: "manifest-active",
      manifest,
      restoreManifest: null
    });
  }
  const pendingRestore = await restoreStore.readPendingActiveCutover();
  if (pendingRestore) {
    return v2Selection({
      storageRootPath,
      reason: "restore-active-cutover-pending",
      manifest,
      restoreManifest
    });
  }
  if (restoreManifest.migrationState !== "reverse-active") {
    return v2Selection({
      storageRootPath,
      reason: "restore-migration-incomplete",
      manifest,
      restoreManifest
    });
  }
  const rootPath = conversationStoreV1ExportStoreRoot(
    storageRootPath,
    restoreManifest.generationId
  );
  await assertConversationStoreV1ExportDirectoryChain(
    storageRootPath,
    restoreManifest.generationId,
    { requireStore: true }
  );
  return {
    activeStore: "v1",
    storeRef: `v1-export:${restoreManifest.generationId}`,
    rootPath,
    routeRevision: restoreManifest.revision,
    routeDigest: restoreManifest.digest,
    reason: "restore-manifest-active",
    manifest,
    restoreManifest
  };
}

function legacySelection(input: {
  storageRootPath: string;
  reason:
    | "manifest-absent"
    | "migration-incomplete"
    | "active-cutover-pending";
  manifest: ConversationStoreManifest | null;
}): ConversationStoreSelection {
  return {
    activeStore: "v1",
    storeRef: "legacy-v1",
    rootPath: conversationStoreV1LegacyRoot(input.storageRootPath),
    routeRevision: input.manifest?.revision ?? null,
    routeDigest: input.manifest?.digest ?? null,
    reason: input.reason,
    manifest: input.manifest,
    restoreManifest: null
  };
}

function v2Selection(input: {
  storageRootPath: string;
  reason:
    | "manifest-active"
    | "restore-migration-incomplete"
    | "restore-active-cutover-pending";
  manifest: ConversationStoreManifest;
  restoreManifest: ConversationStoreRestoreManifest | null;
}): ConversationStoreSelection {
  return {
    activeStore: "v2",
    storeRef: "canonical-v2",
    rootPath: conversationStoreV2Root(input.storageRootPath),
    routeRevision:
      input.restoreManifest?.revision ?? input.manifest.revision,
    routeDigest:
      input.restoreManifest?.digest ?? input.manifest.digest,
    reason: input.reason,
    manifest: input.manifest,
    restoreManifest: input.restoreManifest
  };
}
