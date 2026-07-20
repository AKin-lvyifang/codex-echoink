import * as assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../../harness/conversation/conversation-store-v2";
import { conversationStoreV1LegacyRoot } from "../../harness/conversation/conversation-store-paths";
import {
  advanceConversationStoreManifestToActive,
  advanceConversationStoreManifestToValidated,
  createCopyingConversationStoreManifest,
  FileConversationStoreManifest
} from "../../harness/conversation/store-manifest";
import {
  prepareConversationStoreV2Migration
} from "../../harness/lifecycle/conversation-migration-projection";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  echoInkConversationRecordMutationRootId,
  echoInkRecordMutationRootPath
} from "../../harness/lifecycle/record-mutation-production";
import { pluginDataDir } from "../../core/raw-message-store";
import {
  ConversationStoreRoutingError,
  FileConversationStoreRouter
} from "../../plugin/conversation-store-router";
import type { StoredSession } from "../../settings/settings";

const BASE_TIME = 1_721_347_200_000;

export async function runHarnessV2ConversationStoreRouterTests():
Promise<void> {
  await assertV2ActiveBlocksLegacyWrites();
  await assertRecordMutationRootUsesSelectedConversationRoot();
}

async function assertV2ActiveBlocksLegacyWrites():
Promise<void> {
  const storageRootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-conversation-router-")
  );
  const legacyRootPath = conversationStoreV1LegacyRoot(storageRootPath);
  const sourceStore = new FileConversationStore({
    rootPath: legacyRootPath
  });
  const router = new FileConversationStoreRouter(storageRootPath);
  const legacySession = pristineSession("legacy-conversation");
  await router.createPristineSession(legacySession);
  const routedLegacy = await router.readSession(legacySession.id);
  assert.equal(routedLegacy?.id, legacySession.id);
  assert.equal(routedLegacy?.commitId, legacySession.commitId);
  assert.deepEqual(routedLegacy?.messages, []);
  assert.equal(await router.resolveLiveRootPath(), legacyRootPath);

  const targetStore = new FileConversationStoreV2({ storageRootPath });
  const migrated = await prepareConversationStoreV2Migration({
    sourceStore,
    targetStore
  });
  assert.equal(migrated.report.status, "ready");
  assert.ok(migrated.proof);

  const manifestStore = new FileConversationStoreManifest({
    storageRootPath
  });
  const copying = createCopyingConversationStoreManifest({
    commitId: "router-copying",
    sourceFingerprint: migrated.source.fingerprint,
    createdAt: BASE_TIME
  });
  await manifestStore.compareAndSwap(copying, {
    expectedRevision: null,
    expectedCommitId: null
  });
  const validated = advanceConversationStoreManifestToValidated(copying, {
    commitId: "router-validated",
    proof: migrated.proof,
    updatedAt: BASE_TIME + 1
  });
  await manifestStore.compareAndSwap(validated, {
    expectedRevision: copying.revision,
    expectedCommitId: copying.commitId
  });
  const active = advanceConversationStoreManifestToActive(validated, {
    commitId: "router-active",
    activatedAt: BASE_TIME + 2
  });
  await manifestStore.compareAndSwap(active, {
    expectedRevision: validated.revision,
    expectedCommitId: validated.commitId
  });

  const beforeBlockedWrite = await treeEntries(storageRootPath);
  await assert.rejects(
    () => router.createPristineSession(
      pristineSession("blocked-conversation")
    ),
    (error: unknown) => (
      error instanceof ConversationStoreRoutingError
      && error.code === "v2-live-route-unavailable"
      && error.selection.storeRef === "canonical-v2"
    )
  );
  assert.deepEqual(
    await treeEntries(storageRootPath),
    beforeBlockedWrite,
    "blocked V2 live write must not create or modify the legacy Store"
  );
  assert.equal(
    await sourceStore.readSession("blocked-conversation"),
    null
  );
}

async function assertRecordMutationRootUsesSelectedConversationRoot():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-conversation-root-route-")
  );
  const pluginDir = "codex-echoink";
  const storageRootPath = pluginDataDir(vaultPath, pluginDir);
  const selectedRootPath = path.join(
    storageRootPath,
    "conversation-v1-exports",
    "export-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "store"
  );
  const selectedRootId = echoInkConversationRecordMutationRootId({
    storageRootPath,
    conversationRootPath: selectedRootPath
  });
  assert.notEqual(
    selectedRootId,
    ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation
  );
  assert.equal(
    echoInkRecordMutationRootPath({
      vaultPath,
      pluginDir,
      rootId: selectedRootId,
      conversationRootPath: selectedRootPath
    }),
    selectedRootPath
  );
  assert.throws(
    () => echoInkConversationRecordMutationRootId({
      storageRootPath,
      conversationRootPath: path.join(vaultPath, "outside-plugin-storage")
    }),
    /must stay inside plugin storage/
  );
}

function pristineSession(id: string): StoredSession {
  return {
    id,
    title: `Router conversation ${id}`,
    kind: "chat",
    revision: 1,
    generation: 1,
    contextId: "router-context",
    commitId: "router-commit",
    workspaceFingerprint:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    cwd: "/vault",
    messages: [],
    createdAt: BASE_TIME + 6,
    updatedAt: BASE_TIME + 6
  };
}

async function treeEntries(rootPath: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (currentPath: string, prefix: string): Promise<void> => {
    const children = await readdir(currentPath, { withFileTypes: true });
    for (const child of children.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const relativePath = prefix
        ? `${prefix}/${child.name}`
        : child.name;
      entries.push(`${child.isDirectory() ? "d" : "f"}:${relativePath}`);
      if (child.isDirectory()) {
        await visit(path.join(currentPath, child.name), relativePath);
      }
    }
  };
  await visit(rootPath, "");
  return entries;
}

if (process.env.ECHOINK_RUN_CONVERSATION_STORE_ROUTER_TEST === "1") {
  runHarnessV2ConversationStoreRouterTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
