import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  pluginDataDir,
  readRawText,
  resolveRawRef,
  writeRawText
} from "../../core/raw-message-store";
import {
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import {
  FileConversationStoreV2
} from "../../harness/conversation/conversation-store-v2";
import {
  FileConversationStoreManifest,
  advanceConversationStoreManifestToActive,
  advanceConversationStoreManifestToValidated,
  createCopyingConversationStoreManifest
} from "../../harness/conversation/store-manifest";
import {
  createConversationProductMessageRevision,
  legacyExternalOwnerEdges,
  prepareConversationStoreV2Migration
} from "../../harness/lifecycle/conversation-migration-projection";
import {
  activateConversationStoreV1RestoreRoute,
  prepareConversationStoreV1Export,
  prepareConversationStoreV1RestoreRoute
} from "../../harness/lifecycle/conversation-v1-exporter";
import { workspaceFingerprint } from "../../harness/kernel/session-service";
import {
  KnowledgeBaseHistoryMigrationRequiredError,
  knowledgeBaseHistoryDayPath,
  knowledgeBaseHistoryGenerationDayPath,
  knowledgeBaseHistoryIndexPath,
  knowledgeBaseHistoryRoot,
  knowledgeBaseHistoryV2MigrationPath,
  localDateKeyForTimestamp,
  migrateKnowledgeBaseHistory,
  parseKnowledgeBaseHistoryMessageReferenceV2,
  persistAndCompactKnowledgeBaseHistory,
  persistKnowledgeBaseHistoryMessages,
  pruneKnowledgeBaseHistoryByRetention,
  readKnowledgeBaseHistoryActive,
  readKnowledgeBaseHistoryDay,
  readKnowledgeBaseHistoryIndex,
  rebuildKnowledgeBaseHistoryIndex,
  removeKnowledgeBaseHistory,
  removeKnowledgeBaseHistoryDays
} from "../../knowledge-base/history-store";
import {
  KnowledgeBaseAgentTaskService,
  type KnowledgeBaseNativeLifecycleSummary
} from "../../knowledge-base/agent-task-service";
import { appendKnowledgeBaseWarning } from "../../knowledge-base/maintenance";
import {
  appendScheduledMaintenanceMessage,
  reconcileKnowledgeBaseNativeLifecycleRecovery,
  ScheduledMaintenanceMessageAuthorityError
} from "../../knowledge-base/scheduled-maintenance";
import type { KnowledgeBaseRunResult } from "../../knowledge-base/types";
import { EchoInkConnectionService } from "../../plugin/connection-service";
import {
  EchoInkSettingsStore,
  settingsForDataSave
} from "../../plugin/settings-store";
import {
  normalizeSettingsData,
  type ChatMessage,
  type CodexForObsidianSettings,
  type StoredSession
} from "../../settings/settings";

const PLUGIN_DIR = "codex-echoink";

export async function runHarnessV2HistoryProjectionRetentionTests(): Promise<void> {
  await assertHistoryDayStoresReferencesAndResolvesConversation();
  await assertHistoryReadsActiveConversationV2();
  await assertHistoryRebuildUsesCanonicalConversation();
  await assertCompactedDataShellCannotTruncateCanonicalHistory();
  await assertHistoryV2ReferenceSchemaIsExact();
  await assertGenerationFailureKeepsPreviousActiveProjection();
  await assertGenerationRejectsConversationSourceDrift();
  await assertExplicitDeletionSuppressionAllowsOnlyNewMessages();
  await assertHistoryWriterLaneSerializesConcurrentMutations();
  await assertLegacyStartupAndOrdinarySaveDoNotCutover();
  await assertLegacyMutationsRequireExplicitMigration();
  await assertLegacyConflictLeavesSourceAndActiveUnchanged();
  await assertEmptyLegacyProjectionCanInitializeV2();
  await assertLegacyCutoverPreservesV1Bytes();
  await assertRemoveDayPreservesConversationOwnedRaw();
  await assertRemoveAllPreservesConversationOwnedRaw();
  await assertRetentionPreservesConversationOwnedRaw();
  await assertStartupRetentionPreservesConversationOwnedRaw();
  await assertHistoryWriteRejectsCorruptExistingDay();
  await assertConversationMessageAuthorityRejectsPayloadConflict();
  await assertScheduledRollbackPreservesRaw();
  await assertScheduledRollbackPreservesExternalizationWindowMutation();
  await assertScheduledRollbackPreservesConcurrentSessionMutation();
  await assertScheduledAmbiguousAuthorityFailsClosed();
  await assertScheduledCanonicalWriteFailuresRecoverAcrossRestart();
  await assertScheduledPostSaveFailurePreservesCommittedMessage();
  await assertScheduledLocalCommitFailureKeepsRecoveryReceipt();
  await assertScheduledCleanupFailurePreservesCommittedMessage();
  await assertCrossBatchRecoveryKeepsOldestProvableObligation();
  await assertLocalPersistenceReceiptSurvivesNewRunSettingsWrites();
  await assertSettingsSaveReprojectsDurableRecoveryReceipt();
  await assertConnectionRecoveryClearsScheduledLifecycleWarning();
}

async function assertHistoryReadsActiveConversationV2(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-active-conversation-v2-")
  );
  const date = "2026-01-20";
  const message = {
    ...messageForDate("history-active-v2-message", date),
    runId: "legacy-run-owned-outside-conversation-v2"
  };
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-active-conversation-v2",
    [message]
  );
  const storageRootPath = pluginDataDir(vaultPath, PLUGIN_DIR);
  const sourceStore = new FileConversationStore({
    rootPath: path.join(storageRootPath, "conversations")
  });
  try {
    await persistConversation(sourceStore, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );

    const sourceSnapshot = await sourceStore.inspectMigrationSnapshot();
    const externalOwnerEdges = legacyExternalOwnerEdges(
      sourceSnapshot.sessions
    );
    const targetStore = new FileConversationStoreV2({ storageRootPath });
    const migration = await prepareConversationStoreV2Migration({
      sourceStore,
      targetStore,
      targetExternalOwnerEdges: externalOwnerEdges
    });
    assert.equal(migration.report.status, "ready");
    assert.ok(migration.proof);

    const manifestStore = new FileConversationStoreManifest({
      storageRootPath
    });
    const copying = createCopyingConversationStoreManifest({
      commitId: "history-active-v2-copying",
      sourceFingerprint: migration.source.fingerprint,
      createdAt: timestampForDate(date)
    });
    await manifestStore.compareAndSwap(copying, {
      expectedRevision: null,
      expectedCommitId: null
    });
    const validated = advanceConversationStoreManifestToValidated(copying, {
      commitId: "history-active-v2-validated",
      proof: migration.proof,
      updatedAt: timestampForDate(date) + 1
    });
    await manifestStore.compareAndSwap(validated, {
      expectedRevision: copying.revision,
      expectedCommitId: copying.commitId
    });
    const active = advanceConversationStoreManifestToActive(validated, {
      commitId: "history-active-v2-active",
      activatedAt: timestampForDate(date) + 2
    });
    await manifestStore.compareAndSwap(active, {
      expectedRevision: validated.revision,
      expectedCommitId: validated.commitId
    });

    const { runId: _externalRunOwner, ...expectedProductMessage } = message;
    assert.deepEqual(
      await readKnowledgeBaseHistoryDay(
        vaultPath,
        PLUGIN_DIR,
        session.id,
        date
      ),
      [expectedProductMessage],
      "History must resolve active Conversation V2 product messages without legacy Run ownership fields"
    );
    const rebuilt = await rebuildKnowledgeBaseHistoryIndex(
      vaultPath,
      PLUGIN_DIR
    );
    assert.equal(
      rebuilt.sessions[0]?.messageCount,
      1,
      "History rebuild must read the selected Conversation V2 store"
    );

    const staleLegacySession: StoredSession = {
      ...session,
      messages: session.messages.map((entry) => ({
        ...entry,
        text: "stale retained legacy V1 body"
      })),
      updatedAt: session.updatedAt + 100
    };
    await sourceStore.upsertSession(staleLegacySession);
    const exported = await prepareConversationStoreV1Export({
      storageRootPath,
      externalOwnerEdges
    });
    await prepareConversationStoreV1RestoreRoute({
      storageRootPath,
      generationId: exported.generationId,
      expectedSourceFingerprint: exported.source.fingerprint,
      externalOwnerEdges,
      copyingCommitId: "history-restored-v1-copying",
      validatedCommitId: "history-restored-v1-validated",
      createdAt: timestampForDate(date) + 3,
      validatedAt: timestampForDate(date) + 4
    });
    await activateConversationStoreV1RestoreRoute({
      storageRootPath,
      externalOwnerEdges,
      activeCommitId: "history-restored-v1-active",
      activatedAt: timestampForDate(date) + 5
    });
    assert.deepEqual(
      await readKnowledgeBaseHistoryDay(
        vaultPath,
        PLUGIN_DIR,
        session.id,
        date
      ),
      [expectedProductMessage],
      "History must resolve the exact exported V1 generation instead of the stale retained legacy V1 root"
    );
    const rebuiltFromRestoredV1 = await rebuildKnowledgeBaseHistoryIndex(
      vaultPath,
      PLUGIN_DIR
    );
    assert.equal(
      rebuiltFromRestoredV1.sessions[0]?.messageCount,
      1,
      "History rebuild must continue through the restored V1 route"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertHistoryDayStoresReferencesAndResolvesConversation():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-reference-projection-")
  );
  const date = "2026-01-20";
  const rawRef = "raw/reference-projection.txt";
  const message = {
    ...messageForDate("history-reference-message", date, rawRef),
    runId: "run-history-reference"
  };
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-reference-projection",
    [message]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await writeRawText(
      vaultPath,
      rawRef,
      "canonical raw text must not be copied into History",
      PLUGIN_DIR
    );
    await persistConversation(store, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );

    const active = await readKnowledgeBaseHistoryActive(
      vaultPath,
      PLUGIN_DIR
    );
    assert.ok(active, "V2 projection must publish an active generation");
    const rows = (await readFile(
      knowledgeBaseHistoryGenerationDayPath(
        vaultPath,
        PLUGIN_DIR,
        active.generationId,
        session.id,
        date
      ),
      "utf8"
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "conversation-message");
    assert.equal(rows[0]?.conversationId, session.id);
    assert.equal(rows[0]?.messageId, message.id);
    for (const forbidden of [
      "text",
      "previewText",
      "rawRef",
      "rawSize",
      "rawLines",
      "rawTruncatedForPreview",
      "backendBindings",
      "runId"
    ]) {
      assert.equal(
        forbidden in rows[0]!,
        false,
        `History reference row must not copy ${forbidden}`
      );
    }
    assert.deepEqual(
      await readKnowledgeBaseHistoryDay(
        vaultPath,
        PLUGIN_DIR,
        session.id,
        date
      ),
      [message],
      "History browsing must resolve exact canonical Conversation messages"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertHistoryRebuildUsesCanonicalConversation(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-authoritative-rebuild-")
  );
  const oldDate = "2026-01-19";
  const activeDate = "2026-01-20";
  const oldMessage = messageForDate("history-rebuild-old", oldDate);
  const activeMessage = messageForDate("history-rebuild-active", activeDate);
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-authoritative-rebuild",
    [oldMessage, activeMessage]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(store, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    await removeKnowledgeBaseHistory(vaultPath, PLUGIN_DIR);

    const suppressedRebuild = await rebuildKnowledgeBaseHistoryIndex(
      vaultPath,
      PLUGIN_DIR
    );
    assert.deepEqual(
      suppressedRebuild.sessions,
      [],
      "ordinary rebuild must honor explicit History deletion suppressions"
    );
    const rebuilt = await rebuildKnowledgeBaseHistoryIndex(
      vaultPath,
      PLUGIN_DIR,
      { restoreSuppressed: true }
    );
    assert.equal(rebuilt.sessions[0]?.messageCount, 2);
    assert.deepEqual(
      (
        await readKnowledgeBaseHistoryDay(
          vaultPath,
          PLUGIN_DIR,
          session.id,
          oldDate
        )
      ).map((message) => message.id),
      [oldMessage.id],
      "rebuild must recreate missing projection rows from Conversation authority"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertCompactedDataShellCannotTruncateCanonicalHistory():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-canonical-compaction-")
  );
  const oldDate = "2026-01-19";
  const activeDate = "2026-01-20";
  const oldMessage = messageForDate("history-canonical-old", oldDate);
  const activeMessage = messageForDate("history-canonical-active", activeDate);
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-canonical-compaction",
    [oldMessage, activeMessage]
  );
  const conversationStore = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(conversationStore, session);
    const settings = normalizeSettingsData({
      settingsVersion: 29,
      sessions: [session],
      activeSessionId: session.id,
      knowledgeBase: { sessionId: session.id }
    }).settings;
    await migrateKnowledgeBaseHistory(vaultPath, PLUGIN_DIR, settings);
    assert.deepEqual(
      settings.sessions[0]?.messages.map((message) => message.id),
      [oldMessage.id, activeMessage.id],
      "History V2 must keep the full canonical Conversation in live settings"
    );
    assert.deepEqual(
      settingsForDataSave(settings).sessions[0]?.messages,
      [],
      "the persisted data.json shell must omit Conversation-owned messages"
    );

    const plugin = startupSettingsPlugin(vaultPath, settings);
    const settingsStore = new EchoInkSettingsStore(plugin as never);
    await settingsStore.saveSettings(true, {
      strictConversationStore: true,
      strictKnowledgeBaseHistory: true
    });

    assert.deepEqual(
      (
        await conversationStore.readSession(session.id)
      )?.messages.map((message) => message.id),
      [oldMessage.id, activeMessage.id],
      "saving a compact data shell must preserve the full canonical Conversation"
    );
    await removeKnowledgeBaseHistory(vaultPath, PLUGIN_DIR);
    await rebuildKnowledgeBaseHistoryIndex(
      vaultPath,
      PLUGIN_DIR,
      { restoreSuppressed: true }
    );
    assert.deepEqual(
      (
        await readKnowledgeBaseHistoryDay(
          vaultPath,
          PLUGIN_DIR,
          session.id,
          activeDate
        )
      ).map((message) => message.id),
      [activeMessage.id],
      "a rebuilt projection must recover messages omitted from the data shell"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertHistoryV2ReferenceSchemaIsExact(): Promise<void> {
  const message = messageForDate(
    "history-strict-reference",
    "2026-01-20"
  );
  const valid = {
    version: 2 as const,
    kind: "conversation-message" as const,
    conversationId: "knowledge-history-strict-reference",
    messageId: message.id,
    messageRevision: createConversationProductMessageRevision(message)
  };
  assert.deepEqual(
    parseKnowledgeBaseHistoryMessageReferenceV2(valid),
    valid
  );
  for (const forbidden of [
    "text",
    "previewText",
    "rawRef",
    "backendBindings",
    "createdAt",
    "role",
    "status",
    "runId",
    "unknown"
  ]) {
    assert.throws(
      () => parseKnowledgeBaseHistoryMessageReferenceV2({
        ...valid,
        [forbidden]: "must fail closed"
      }),
      new RegExp(`unknown field ${forbidden}`),
      `History V2 reference rows must reject ${forbidden}`
    );
  }
  assert.throws(
    () => parseKnowledgeBaseHistoryMessageReferenceV2({
      ...valid,
      version: 3
    }),
    /schema is invalid/
  );
}

async function assertGenerationFailureKeepsPreviousActiveProjection():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-generation-failure-")
  );
  const date = "2026-01-20";
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-generation-failure",
    [messageForDate("history-generation-stable", date)]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(store, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    const before = await readKnowledgeBaseHistoryActive(
      vaultPath,
      PLUGIN_DIR
    );
    assert.ok(before);
    await assert.rejects(
      rebuildKnowledgeBaseHistoryIndex(
        vaultPath,
        PLUGIN_DIR,
        {
          hooks: {
            beforeActivePublish: () => {
              throw new Error("fixture failure before active publish");
            }
          }
        }
      ),
      /fixture failure before active publish/
    );
    const after = await readKnowledgeBaseHistoryActive(
      vaultPath,
      PLUGIN_DIR
    );
    assert.deepEqual(
      after,
      before,
      "an orphan complete generation must not replace the previous active projection"
    );
    assert.deepEqual(
      (
        await readKnowledgeBaseHistoryDay(
          vaultPath,
          PLUGIN_DIR,
          session.id,
          date
        )
      ).map((message) => message.id),
      ["history-generation-stable"]
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertGenerationRejectsConversationSourceDrift():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-source-drift-")
  );
  const date = "2026-01-20";
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-source-drift",
    [messageForDate("history-source-before", date)]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(store, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    const activeBefore = await readKnowledgeBaseHistoryActive(
      vaultPath,
      PLUGIN_DIR
    );
    assert.ok(activeBefore);
    let mutated = false;
    await assert.rejects(
      rebuildKnowledgeBaseHistoryIndex(
        vaultPath,
        PLUGIN_DIR,
        {
          hooks: {
            beforeSourceRevalidation: async () => {
              if (mutated) return;
              mutated = true;
              session.messages.push(
                messageForDate("history-source-after", date)
              );
              session.updatedAt += 1;
              await store.upsertSession(session);
            }
          }
        }
      ),
      /canonical Conversation changed during generation build/
    );
    assert.deepEqual(
      await readKnowledgeBaseHistoryActive(vaultPath, PLUGIN_DIR),
      activeBefore,
      "Conversation drift must leave the previous active generation unchanged"
    );
    const rebuilt = await rebuildKnowledgeBaseHistoryIndex(
      vaultPath,
      PLUGIN_DIR
    );
    assert.equal(rebuilt.sessions[0]?.messageCount, 2);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertExplicitDeletionSuppressionAllowsOnlyNewMessages():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-delete-suppression-")
  );
  const date = "2026-01-20";
  const oldMessage = messageForDate("history-suppressed-old", date);
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-delete-suppression",
    [oldMessage]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(store, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    await removeKnowledgeBaseHistoryDays(
      vaultPath,
      PLUGIN_DIR,
      [date],
      session.id
    );
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(vaultPath, PLUGIN_DIR)).sessions,
      [],
      "ordinary saves must not revive explicitly deleted references"
    );

    const newMessage = messageForDate(
      "history-after-suppression",
      date
    );
    session.messages.push(newMessage);
    session.updatedAt += 1;
    await store.upsertSession(session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    assert.deepEqual(
      (
        await readKnowledgeBaseHistoryDay(
          vaultPath,
          PLUGIN_DIR,
          session.id,
          date
        )
      ).map((message) => message.id),
      [newMessage.id],
      "new messages may enter a date without reviving suppressed message IDs"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertHistoryWriterLaneSerializesConcurrentMutations():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-writer-lane-")
  );
  const date = "2026-01-20";
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-writer-lane",
    [messageForDate("history-writer-lane-message", date)]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  let releaseStaged!: () => void;
  const stagedRelease = new Promise<void>((resolve) => {
    releaseStaged = resolve;
  });
  let markStaged!: () => void;
  const staged = new Promise<void>((resolve) => {
    markStaged = resolve;
  });
  try {
    await persistConversation(store, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    const rebuilding = rebuildKnowledgeBaseHistoryIndex(
      vaultPath,
      PLUGIN_DIR,
      {
        hooks: {
          afterGenerationStaged: async () => {
            markStaged();
            await stagedRelease;
          }
        }
      }
    );
    await staged;
    const removing = removeKnowledgeBaseHistoryDays(
      vaultPath,
      PLUGIN_DIR,
      [date],
      session.id
    );
    releaseStaged();
    await Promise.all([rebuilding, removing]);
    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(vaultPath, PLUGIN_DIR)).sessions,
      [],
      "the later delete must run after the in-flight rebuild and remain authoritative"
    );
  } finally {
    releaseStaged();
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertLegacyStartupAndOrdinarySaveDoNotCutover():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-v1-startup-gate-")
  );
  const date = "2026-01-20";
  const message = messageForDate("history-v1-startup-message", date);
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-v1-startup-gate",
    [message]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  const settings = settingsForKnowledgeSession(session, 7);
  let originalConsoleError = console.error;
  let originalConsoleWarn = console.warn;
  try {
    await persistConversation(store, session);
    const legacy = await writeLegacyHistoryFixture(
      vaultPath,
      session,
      message
    );

    const ordinary = await persistAndCompactKnowledgeBaseHistory(
      vaultPath,
      PLUGIN_DIR,
      settings,
      timestampForDate("2026-01-21")
    );
    assert.equal(ordinary.messageCount, 1);
    assert.equal(
      await readKnowledgeBaseHistoryActive(vaultPath, PLUGIN_DIR),
      null,
      "ordinary History persistence must not cut over populated V1 data"
    );

    const startupErrors: unknown[] = [];
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    console.error = (...args: unknown[]) => {
      startupErrors.push(...args);
    };
    console.warn = (...args: unknown[]) => {
      startupErrors.push(...args);
    };
    const plugin = startupSettingsPlugin(vaultPath, settings);
    await new EchoInkSettingsStore(
      plugin as never
    ).runDeferredStartupMaintenance();
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;

    assert.ok(
      startupErrors.some(
        (value) =>
          value instanceof KnowledgeBaseHistoryMigrationRequiredError
      ),
      "startup retention must report the explicit migration gate"
    );
    assert.equal(
      await readKnowledgeBaseHistoryActive(vaultPath, PLUGIN_DIR),
      null,
      "startup maintenance must not cut over populated V1 data"
    );
    await assertLegacyFixtureBytesUnchanged(legacy);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertLegacyMutationsRequireExplicitMigration():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-v1-mutation-gate-")
  );
  const date = "2026-01-20";
  const message = messageForDate("history-v1-mutation-message", date);
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-v1-mutation-gate",
    [message]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(store, session);
    const legacy = await writeLegacyHistoryFixture(
      vaultPath,
      session,
      message
    );
    const operations: Array<() => Promise<unknown>> = [
      () => persistKnowledgeBaseHistoryMessages(
        vaultPath,
        PLUGIN_DIR,
        session,
        session.messages
      ),
      () => rebuildKnowledgeBaseHistoryIndex(vaultPath, PLUGIN_DIR),
      () => removeKnowledgeBaseHistory(vaultPath, PLUGIN_DIR),
      () => removeKnowledgeBaseHistoryDays(
        vaultPath,
        PLUGIN_DIR,
        [date],
        session.id
      ),
      () => pruneKnowledgeBaseHistoryByRetention(
        vaultPath,
        PLUGIN_DIR,
        7,
        timestampForDate("2026-02-20")
      )
    ];
    for (const operation of operations) {
      await assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof KnowledgeBaseHistoryMigrationRequiredError
      );
      assert.equal(
        await readKnowledgeBaseHistoryActive(vaultPath, PLUGIN_DIR),
        null
      );
    }
    await assertLegacyFixtureBytesUnchanged(legacy);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertLegacyConflictLeavesSourceAndActiveUnchanged():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-v1-conflict-")
  );
  const date = "2026-01-20";
  const canonicalMessage = messageForDate(
    "history-v1-conflict-message",
    date
  );
  const legacyMessage = {
    ...canonicalMessage,
    text: "conflicting legacy body"
  };
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-v1-conflict",
    [canonicalMessage]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(store, session);
    const legacy = await writeLegacyHistoryFixture(
      vaultPath,
      session,
      legacyMessage
    );
    await assert.rejects(
      migrateKnowledgeBaseHistory(
        vaultPath,
        PLUGIN_DIR,
        settingsForKnowledgeSession(session),
        { allowLegacyCutover: true }
      ),
      /migration blocked by full subject validation/
    );
    assert.equal(
      await readKnowledgeBaseHistoryActive(vaultPath, PLUGIN_DIR),
      null,
      "a conflicting V1 projection must not publish an active V2 generation"
    );
    await assert.rejects(
      stat(knowledgeBaseHistoryV2MigrationPath(vaultPath, PLUGIN_DIR)),
      isNotFoundError
    );
    const conflictRoot = path.join(
      knowledgeBaseHistoryRoot(vaultPath, PLUGIN_DIR),
      "v2",
      "migration-conflicts"
    );
    const conflictFiles = (await readdir(conflictRoot)).filter(
      (entry) => entry.startsWith("conflict-")
    );
    assert.equal(conflictFiles.length, 1);
    const conflictBytes = await readFile(
      path.join(conflictRoot, conflictFiles[0]!),
      "utf8"
    );
    assert.doesNotMatch(conflictBytes, /history-v1-conflict/);
    assert.doesNotMatch(conflictBytes, /conflicting legacy body/);
    assert.doesNotMatch(conflictBytes, /history-v1-conflict-message/);
    await assertLegacyFixtureBytesUnchanged(legacy);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertEmptyLegacyProjectionCanInitializeV2():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-empty-v1-")
  );
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-empty-v1",
    [messageForDate("history-empty-v1-message", "2026-01-20")]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  const legacyIndexPath = knowledgeBaseHistoryIndexPath(
    vaultPath,
    PLUGIN_DIR
  );
  try {
    await persistConversation(store, session);
    await mkdir(path.dirname(legacyIndexPath), { recursive: true });
    const legacyIndexBytes = `${JSON.stringify({
      version: 1,
      updatedAt: 0,
      sessions: []
    }, null, 2)}\n`;
    await writeFile(legacyIndexPath, legacyIndexBytes, "utf8");
    await persistAndCompactKnowledgeBaseHistory(
      vaultPath,
      PLUGIN_DIR,
      settingsForKnowledgeSession(session)
    );
    assert.ok(
      await readKnowledgeBaseHistoryActive(vaultPath, PLUGIN_DIR),
      "an empty V1 projection may initialize V2 without a migration action"
    );
    assert.equal(
      await readFile(legacyIndexPath, "utf8"),
      legacyIndexBytes,
      "initializing V2 must not rewrite an empty V1 index"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertLegacyCutoverPreservesV1Bytes(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-v1-cutover-")
  );
  const date = "2026-01-20";
  const message = messageForDate("history-v1-message", date);
  const canonicalOnlyMessage = messageForDate(
    "history-v1-canonical-only-message",
    date
  );
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-v1-cutover",
    [message, canonicalOnlyMessage]
  );
  const store = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, PLUGIN_DIR),
      "conversations"
    )
  });
  try {
    await persistConversation(store, session);
    const legacy = await writeLegacyHistoryFixture(
      vaultPath,
      session,
      message
    );
    await migrateKnowledgeBaseHistory(
      vaultPath,
      PLUGIN_DIR,
      settingsForKnowledgeSession(session),
      { allowLegacyCutover: true }
    );
    await assertLegacyFixtureBytesUnchanged(legacy);
    assert.ok(
      await readKnowledgeBaseHistoryActive(vaultPath, PLUGIN_DIR),
      "explicitly validated V1 data must publish a separate V2 active generation"
    );
    await stat(knowledgeBaseHistoryV2MigrationPath(vaultPath, PLUGIN_DIR));
    assert.deepEqual(
      (
        await readKnowledgeBaseHistoryDay(
          vaultPath,
          PLUGIN_DIR,
          session.id,
          date
        )
      ).map((item) => item.id),
      [message.id],
      "first cutover must preserve the exact V1 projection instead of silently adding canonical-only messages"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertRemoveDayPreservesConversationOwnedRaw(): Promise<void> {
  const fixture = await createSharedRawFixture("remove-day", "2026-01-01");
  try {
    const result = await removeKnowledgeBaseHistoryDays(
      fixture.vaultPath,
      PLUGIN_DIR,
      [fixture.date]
    );
    assert.deepEqual(result, { removedDayCount: 1, removedMessageCount: 1 });
    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(fixture.vaultPath, PLUGIN_DIR)).sessions,
      [],
      "removing a History day must remove only that projection"
    );
    await assertConversationRawUnchanged(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function assertRemoveAllPreservesConversationOwnedRaw(): Promise<void> {
  const fixture = await createSharedRawFixture("remove-all", "2026-01-02");
  try {
    const result = await removeKnowledgeBaseHistory(fixture.vaultPath, PLUGIN_DIR);
    assert.deepEqual(result, { removedDayCount: 1, removedMessageCount: 1 });
    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(
        fixture.vaultPath,
        PLUGIN_DIR
      )).sessions,
      [],
      "removing all History must publish an empty V2 projection"
    );
    await stat(knowledgeBaseHistoryRoot(fixture.vaultPath, PLUGIN_DIR));
    await assertConversationRawUnchanged(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function assertRetentionPreservesConversationOwnedRaw(): Promise<void> {
  const fixture = await createSharedRawFixture("retention", "2026-01-03");
  try {
    const result = await pruneKnowledgeBaseHistoryByRetention(
      fixture.vaultPath,
      PLUGIN_DIR,
      7,
      timestampForDate("2026-01-20")
    );
    assert.deepEqual(result, { removedDayCount: 1, removedMessageCount: 1 });
    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(fixture.vaultPath, PLUGIN_DIR)).sessions,
      [],
      "retention must delete only expired History projections"
    );
    await assertConversationRawUnchanged(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function assertStartupRetentionPreservesConversationOwnedRaw(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-history-startup-retention-"));
  const oldDate = "2026-01-04";
  const activeDate = "2026-01-20";
  const rawRef = "raw/startup-retention.txt";
  const rawText = "startup retention must preserve this shared Raw body\n第二行";
  const oldMessage = messageForDate("startup-old", oldDate, rawRef);
  const activeMessage = messageForDate("startup-active", activeDate);
  const session = knowledgeSession(
    vaultPath,
    "knowledge-startup-retention",
    [oldMessage, activeMessage]
  );
  const conversationStore = new FileConversationStore({
    rootPath: path.join(pluginDataDir(vaultPath, PLUGIN_DIR), "conversations")
  });
  try {
    await writeRawText(vaultPath, rawRef, rawText, PLUGIN_DIR);
    const rawBytes = await readFile(resolveRawRef(vaultPath, rawRef, PLUGIN_DIR));
    await persistConversation(conversationStore, session);
    const settings = normalizeSettingsData({
      settingsVersion: 29,
      sessions: [session],
      activeSessionId: session.id,
      knowledgeBase: {
        sessionId: session.id,
        historyRetentionDays: 7
      }
    }).settings;

    await migrateKnowledgeBaseHistory(vaultPath, PLUGIN_DIR, settings);
    assert.deepEqual(
      settings.sessions[0]?.messages.map((message) => message.id),
      [oldMessage.id, activeMessage.id],
      "startup History publication must preserve the full canonical Conversation"
    );

    const plugin = startupSettingsPlugin(vaultPath, settings);
    const settingsStore = new EchoInkSettingsStore(plugin as never);
    await settingsStore.runDeferredStartupMaintenance();

    assert.deepEqual(
      (await readKnowledgeBaseHistoryIndex(vaultPath, PLUGIN_DIR)).sessions,
      [],
      "startup retention must remove expired History projections"
    );
    const restored = await conversationStore.readSession(session.id);
    const restoredRawRef = restored?.messages.find(
      (message) => message.id === oldMessage.id
    )?.rawRef;
    assert.equal(restoredRawRef, rawRef);
    assert.deepEqual(
      await readFile(resolveRawRef(vaultPath, restoredRawRef!, PLUGIN_DIR)),
      rawBytes,
      "startup retention must leave shared Raw bytes unchanged"
    );
    assert.equal(
      await readRawText(vaultPath, restoredRawRef!, PLUGIN_DIR),
      rawText,
      "the canonical Conversation rawRef must remain readable after startup retention"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertHistoryWriteRejectsCorruptExistingDay(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-history-corrupt-write-readback-")
  );
  const date = "2026-01-20";
  const session = knowledgeSession(
    vaultPath,
    "knowledge-history-corrupt-write-readback",
    [messageForDate("history-corrupt-incoming", date)]
  );
  const corruptCases = [
    {
      name: "malformed JSON",
      bytes: "{\"id\":\"broken\"\n"
    },
    {
      name: "schema-invalid JSON",
      bytes: `${JSON.stringify({
        id: "history-schema-invalid-scheduled-id",
        role: "assistant",
        text: "ghost",
        createdAt: null
      })}\n`
    }
  ] as const;
  try {
    const store = new FileConversationStore({
      rootPath: path.join(
        pluginDataDir(vaultPath, PLUGIN_DIR),
        "conversations"
      )
    });
    await persistConversation(store, session);
    await persistKnowledgeBaseHistoryMessages(
      vaultPath,
      PLUGIN_DIR,
      session,
      session.messages
    );
    const active = await readKnowledgeBaseHistoryActive(
      vaultPath,
      PLUGIN_DIR
    );
    assert.ok(active);
    const dayPath = knowledgeBaseHistoryGenerationDayPath(
      vaultPath,
      PLUGIN_DIR,
      active.generationId,
      session.id,
      date
    );
    for (const corruptCase of corruptCases) {
      await writeFile(dayPath, corruptCase.bytes, "utf8");
      await assert.rejects(
        persistKnowledgeBaseHistoryMessages(
          vaultPath,
          PLUGIN_DIR,
          session,
          session.messages
        ),
        /Knowledge History recovery required: staged generation digest mismatch/,
        `${corruptCase.name} must fail closed instead of becoming an empty History day`
      );
      assert.equal(
        await readFile(dayPath, "utf8"),
        corruptCase.bytes,
        `${corruptCase.name} bytes must remain unchanged after the rejected projection`
      );
    }
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertConversationMessageAuthorityRejectsPayloadConflict(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-conversation-message-authority-")
  );
  const message = messageForDate(
    "conversation-message-authority",
    "2026-01-20"
  );
  const session = knowledgeSession(
    vaultPath,
    "knowledge-conversation-message-authority",
    [message]
  );
  const store = new FileConversationStore({
    rootPath: path.join(pluginDataDir(vaultPath, PLUGIN_DIR), "conversations")
  });
  try {
    await persistConversation(store, session);
    const durable = await store.proveMessageAuthority({
      conversationId: session.id,
      messageId: message.id,
      expectedMessage: structuredClone(message)
    });
    assert.equal(durable.state, "durable");

    const conflict = await store.proveMessageAuthority({
      conversationId: session.id,
      messageId: message.id,
      expectedMessage: {
        ...structuredClone(message),
        text: "same ID, different canonical payload"
      }
    });
    assert.equal(conflict.state, "conflict");
    assert.equal(conflict.matchingMessageCount, 1);
    assert.notEqual(
      conflict.currentPayloadDigests[0],
      conflict.expectedPayloadDigest,
      "same-ID payload drift must not receive a durable authority receipt"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertScheduledRollbackPreservesRaw(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-scheduled-rollback-raw-"));
  const rawRef = "raw/scheduled-rollback.txt";
  const rawBytes = Buffer.from(
    "failed scheduled projection commit must not delete this Raw body\n第二行",
    "utf8"
  );
  const seed = messageForDate("scheduled-seed", "2026-01-20");
  const session = knowledgeSession(vaultPath, "knowledge-scheduled-rollback", [seed]);
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [session],
    activeSessionId: session.id,
    knowledgeBase: { sessionId: session.id }
  }).settings;
  let saveCalls = 0;
  const plugin = {
    settings,
    getVaultPath: () => vaultPath,
    getPluginDataDirName: () => PLUGIN_DIR,
    externalizeMessageText: async (message: ChatMessage) => {
      message.rawRef = rawRef;
      await writeRawText(
        vaultPath,
        rawRef,
        rawBytes.toString("utf8"),
        PLUGIN_DIR
      );
    },
    saveSettings: async () => {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("scheduled projection save failed");
    },
    proveEchoInkConversationMessageAuthority: async (probe: {
      conversationId: string;
      messageId: string;
    }) => ({
      conversationId: probe.conversationId,
      messageId: probe.messageId,
      state: "absent" as const,
      expectedPayloadDigest: "fixture",
      matchingMessageCount: 0,
      currentPayloadDigests: []
    }),
    withEchoInkSettingsPersistenceAuthorityGate: async (
      action: () => Promise<unknown>
    ) => await action(),
    readKnowledgeBaseHistoryDay: async () => [],
    getCodexView: () => null
  };
  const result: KnowledgeBaseRunResult = {
    status: "success",
    reportPath: "",
    summary: "scheduled result",
    processedSources: []
  };
  try {
    await appendScheduledMaintenanceMessage(
      plugin as never,
      result,
      async () => {
        throw new Error("afterMessageSaved must not run after save failure");
      }
    );
    assert.equal(saveCalls, 2);
    assert.deepEqual(
      settings.sessions[0]?.messages.map((message) => message.id),
      [seed.id],
      "scheduled rollback must remove only the failed message projection"
    );
    assert.match(
      settings.knowledgeBase.lastError,
      /自动维护消息保存失败：scheduled projection save failed/
    );
    assert.deepEqual(
      await readFile(resolveRawRef(vaultPath, rawRef, PLUGIN_DIR)),
      rawBytes,
      "scheduled rollback must leave Raw bytes unchanged for later reference-graph GC"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertScheduledRollbackPreservesExternalizationWindowMutation(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-scheduled-rollback-externalization-window-")
  );
  const seed = messageForDate(
    "scheduled-externalization-window-seed",
    "2026-01-20"
  );
  const concurrentMessage = messageForDate(
    "scheduled-externalization-window-concurrent",
    "2026-01-20"
  );
  const session = knowledgeSession(
    vaultPath,
    "knowledge-scheduled-rollback-externalization-window",
    [seed]
  );
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [session],
    activeSessionId: session.id,
    knowledgeBase: { sessionId: session.id }
  }).settings;
  let saveCalls = 0;
  let afterMessageSavedCalls = 0;
  const plugin = {
    settings,
    getVaultPath: () => vaultPath,
    getPluginDataDirName: () => PLUGIN_DIR,
    externalizeMessageText: async () => {
      await Promise.resolve();
      const live = settings.sessions.find(
        (candidate) => candidate.id === session.id
      );
      assert.ok(live);
      live.title = "外部化期间并发更新后的知识库标题";
      live.messages.find((message) => message.id === seed.id)!.text =
        "外部化期间并发更新后的 seed 正文";
      live.messages.push(concurrentMessage);
      settings.knowledgeBase.lastError = "外部化期间的并发提醒";
    },
    saveSettings: async () => {
      saveCalls += 1;
      if (saveCalls === 1) {
        throw new Error("scheduled pass-1 write failed after externalization");
      }
    },
    proveEchoInkConversationMessageAuthority: async (probe: {
      conversationId: string;
      messageId: string;
    }) => ({
      conversationId: probe.conversationId,
      messageId: probe.messageId,
      state: "absent" as const,
      expectedPayloadDigest: "fixture",
      matchingMessageCount: 0,
      currentPayloadDigests: []
    }),
    withEchoInkSettingsPersistenceAuthorityGate: async (
      action: () => Promise<unknown>
    ) => await action(),
    readKnowledgeBaseHistoryDay: async () => [],
    getCodexView: () => null
  };
  try {
    await appendScheduledMaintenanceMessage(
      plugin as never,
      {
        status: "success",
        reportPath: "",
        summary: "scheduled rollback externalization window result",
        processedSources: []
      },
      async () => {
        afterMessageSavedCalls += 1;
      }
    );
    const live = settings.sessions.find(
      (candidate) => candidate.id === session.id
    );
    assert.ok(live);
    assert.equal(saveCalls, 2);
    assert.equal(afterMessageSavedCalls, 0);
    assert.equal(
      live.title,
      "外部化期间并发更新后的知识库标题"
    );
    assert.equal(
      live.messages.find((message) => message.id === seed.id)?.text,
      "外部化期间并发更新后的 seed 正文",
      "rollback must not restore a session snapshot captured before Raw externalization"
    );
    assert.equal(
      live.messages.filter((message) => message.id === concurrentMessage.id).length,
      1,
      "rollback must preserve a message appended during Raw externalization"
    );
    assert.equal(
      live.messages.some((message) => message.title === "每日知识库维护"),
      false,
      "rollback must remove the exact scheduled append target"
    );
    assert.match(
      settings.knowledgeBase.lastError,
      /外部化期间的并发提醒/
    );
    assert.match(
      settings.knowledgeBase.lastError,
      /自动维护消息保存失败：scheduled pass-1 write failed after externalization/
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertScheduledRollbackPreservesConcurrentSessionMutation(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-scheduled-rollback-concurrent-session-")
  );
  const seed = messageForDate(
    "scheduled-concurrent-session-seed",
    "2026-01-20"
  );
  const session = knowledgeSession(
    vaultPath,
    "knowledge-scheduled-rollback-concurrent-session",
    [seed]
  );
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [session],
    activeSessionId: session.id,
    knowledgeBase: { sessionId: session.id }
  }).settings;
  let saveCalls = 0;
  let afterMessageSavedCalls = 0;
  const plugin = {
    settings,
    getVaultPath: () => vaultPath,
    getPluginDataDirName: () => PLUGIN_DIR,
    externalizeMessageText: async () => undefined,
    saveSettings: async () => {
      saveCalls += 1;
      if (saveCalls === 1) {
        throw new Error("scheduled pass-1 write failed");
      }
    },
    proveEchoInkConversationMessageAuthority: async (probe: {
      conversationId: string;
      messageId: string;
    }) => {
      const live = settings.sessions.find(
        (candidate) => candidate.id === probe.conversationId
      );
      assert.ok(live);
      live.title = "并发更新后的知识库标题";
      live.messages.find((message) => message.id === seed.id)!.text =
        "并发更新后的 seed 正文";
      return {
        conversationId: probe.conversationId,
        messageId: probe.messageId,
        state: "absent" as const,
        expectedPayloadDigest: "fixture",
        matchingMessageCount: 0,
        currentPayloadDigests: []
      };
    },
    withEchoInkSettingsPersistenceAuthorityGate: async (
      action: () => Promise<unknown>
    ) => await action(),
    readKnowledgeBaseHistoryDay: async () => [],
    getCodexView: () => null
  };
  try {
    await appendScheduledMaintenanceMessage(
      plugin as never,
      {
        status: "success",
        reportPath: "",
        summary: "scheduled rollback concurrent session result",
        processedSources: []
      },
      async () => {
        afterMessageSavedCalls += 1;
      }
    );
    const live = settings.sessions.find(
      (candidate) => candidate.id === session.id
    );
    assert.ok(live);
    assert.equal(saveCalls, 2);
    assert.equal(afterMessageSavedCalls, 0);
    assert.equal(live.title, "并发更新后的知识库标题");
    assert.equal(
      live.messages.find((message) => message.id === seed.id)?.text,
      "并发更新后的 seed 正文",
      "rollback must preserve concurrent payload changes on pre-existing messages"
    );
    assert.equal(
      live.messages.some((message) => message.title === "每日知识库维护"),
      false,
      "rollback must remove only the exact scheduled append target"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertScheduledAmbiguousAuthorityFailsClosed(): Promise<void> {
  for (const scenario of [
    "conversation-read-failure",
    "conversation-payload-conflict",
    "live-payload-drift",
    "history-read-failure",
    "history-row-conflict"
  ] as const) {
    const vaultPath = await mkdtemp(
      path.join(tmpdir(), `echoink-scheduled-ambiguous-${scenario}-`)
    );
    const seed = messageForDate(
      `scheduled-ambiguous-${scenario}-seed`,
      "2026-01-20"
    );
    const session = knowledgeSession(
      vaultPath,
      `knowledge-scheduled-ambiguous-${scenario}`,
      [seed]
    );
    const settings = normalizeSettingsData({
      settingsVersion: 29,
      sessions: [session],
      activeSessionId: session.id,
      knowledgeBase: { sessionId: session.id }
    }).settings;
    let saveCalls = 0;
    let afterMessageSavedCalls = 0;
    let poisonCalls = 0;
    let probedMessageId = "";
    const plugin = {
      settings,
      getVaultPath: () => vaultPath,
      getPluginDataDirName: () => PLUGIN_DIR,
      externalizeMessageText: async () => undefined,
      saveSettings: async () => {
        saveCalls += 1;
        throw new Error("scheduled save outcome is unknown");
      },
      proveEchoInkConversationMessageAuthority: async (probe: {
        conversationId: string;
        messageId: string;
      }) => {
        probedMessageId = probe.messageId;
        if (scenario === "conversation-read-failure") {
          throw new Error("Conversation readback is unavailable");
        }
        if (scenario === "live-payload-drift") {
          const liveTarget = settings.sessions
            .find((candidate) => candidate.id === session.id)
            ?.messages.find((message) => message.id === probe.messageId);
          assert.ok(liveTarget);
          liveTarget.text = "concurrent same-ID payload mutation";
        }
        return {
          conversationId: probe.conversationId,
          messageId: probe.messageId,
          state: scenario === "conversation-payload-conflict"
            ? "conflict" as const
            : "absent" as const,
          expectedPayloadDigest: "sha256:expected",
          matchingMessageCount:
            scenario === "conversation-payload-conflict" ? 1 : 0,
          currentPayloadDigests:
            scenario === "conversation-payload-conflict"
              ? ["sha256:different-payload"]
              : []
        };
      },
      withEchoInkSettingsPersistenceAuthorityGate: async (
        action: () => Promise<unknown>
      ) => await action(),
      readKnowledgeBaseHistoryDay: async () => {
        if (scenario === "history-read-failure") {
          throw Object.assign(
            new Error("History readback is corrupt"),
            { code: "EIO" }
          );
        }
        if (scenario === "history-row-conflict") {
          return [{
            id: probedMessageId,
            role: "assistant" as const,
            text: "same ID, different History payload",
            createdAt: Date.now()
          }];
        }
        return [];
      },
      poisonEchoInkSettingsPersistenceForRecovery: () => {
        poisonCalls += 1;
      },
      getCodexView: () => null
    };
    const result: KnowledgeBaseRunResult = {
      status: "success",
      reportPath: "",
      summary: `scheduled ambiguous ${scenario} result`,
      processedSources: []
    };
    const expectedReason = scenario === "conversation-read-failure"
      ? /Conversation readback is unavailable/
      : scenario === "conversation-payload-conflict"
        ? /payload conflicts/
        : scenario === "live-payload-drift"
          ? /payload changed during authority readback/
        : scenario === "history-read-failure"
          ? /History contradiction readback failed/
          : /remains in History/;
    try {
      await assert.rejects(
        appendScheduledMaintenanceMessage(
          plugin as never,
          result,
          async () => {
            afterMessageSavedCalls += 1;
          }
        ),
        (error: unknown) =>
          error instanceof ScheduledMaintenanceMessageAuthorityError
          && error.code === "scheduled_message_authority_ambiguous"
          && error.receipt.state === "ambiguous"
          && expectedReason.test(error.receipt.reason)
      );
      assert.equal(
        saveCalls,
        1,
        "ambiguous authority must poison this publish attempt before any rollback save"
      );
      assert.equal(
        afterMessageSavedCalls,
        0,
        "ambiguous authority must keep Native cleanup closed"
      );
      assert.equal(
        poisonCalls,
        1,
        "ambiguous authority must poison the settings lane until reload"
      );
      assert.equal(
        settings.sessions
          .find((candidate) => candidate.id === session.id)
          ?.messages.filter((message) => message.title === "每日知识库维护")
          .length,
        1,
        "fail-closed handling must not delete a possibly durable scheduled source"
      );
      assert.match(
        settings.knowledgeBase.lastError,
        /自动维护消息持久化状态不明确/
      );
      if (scenario === "live-payload-drift") {
        assert.equal(
          settings.sessions
            .find((candidate) => candidate.id === session.id)
            ?.messages.find((message) => message.id === probedMessageId)
            ?.text,
          "concurrent same-ID payload mutation",
          "fail-closed handling must preserve a concurrent same-ID payload mutation"
        );
      }
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  }
}

type ScheduledCanonicalFailurePoint =
  | "conversation-pass-1"
  | "history"
  | "conversation-pass-2"
  | "data";

async function assertScheduledCanonicalWriteFailuresRecoverAcrossRestart(): Promise<void> {
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    for (const failurePoint of [
      "conversation-pass-1",
      "history",
      "conversation-pass-2",
      "data"
    ] as const satisfies readonly ScheduledCanonicalFailurePoint[]) {
      const vaultPath = await mkdtemp(
        path.join(tmpdir(), `echoink-scheduled-${failurePoint}-`)
      );
      try {
        const now = Date.now();
        const seed: ChatMessage = {
          id: `scheduled-${failurePoint}-seed`,
          role: "assistant",
          text: "seed",
          createdAt: now - 1_000
        };
        const settings = normalizeSettingsData({
          settingsVersion: 29,
          sessions: [],
          knowledgeBase: {}
        }).settings;
        let persisted = structuredClone(settings);
        let failDataWrites = false;
        let store: EchoInkSettingsStore;
        const plugin: any = {
          settings,
          loadData: async () => structuredClone(persisted),
          saveData: async (data: unknown) => {
            if (failDataWrites) {
              throw new Error("fixture data write failure");
            }
            persisted = structuredClone(
              data as CodexForObsidianSettings
            );
          },
          getVaultPath: () => vaultPath,
          getPluginDataDirName: () => PLUGIN_DIR,
          settleHarnessRunTerminal: async () => undefined,
          saveSettings: async (
            force = false,
            options = {}
          ) => await store.saveSettings(force, options),
          externalizeMessageText: async (
            message: ChatMessage,
            text: string
          ) => await store.externalizeMessageText(message, text),
          proveEchoInkConversationMessageAuthority: async (
            probe: Parameters<
              EchoInkSettingsStore["proveConversationMessageAuthority"]
            >[0]
          ) => await store.proveConversationMessageAuthority(probe),
          withEchoInkSettingsPersistenceAuthorityGate: async (
            action: () => Promise<unknown>
          ) => await store.withSettingsPersistenceAuthorityGate(action),
          readKnowledgeBaseHistoryDay: async (
            sessionId: string,
            date: string
          ) => await store.readKnowledgeBaseHistoryDay(sessionId, date),
          pruneKnowledgeBaseHistoryByRetention: async () =>
            await store.pruneKnowledgeBaseHistoryByRetention(),
          getCodexView: () => null
        };
        store = new EchoInkSettingsStore(plugin);
        const session: StoredSession = {
          id: `knowledge-scheduled-${failurePoint}`,
          title: "知识库管理",
          kind: "knowledge-base",
          cwd: vaultPath,
          revision: 1,
          generation: 1,
          contextId: `context-scheduled-${failurePoint}`,
          commitId: `commit-scheduled-${failurePoint}`,
          workspaceFingerprint: workspaceFingerprint({
            vaultPath,
            cwd: vaultPath
          }),
          messages: [],
          createdAt: now - 1_000,
          updatedAt: now - 1_000
        };
        plugin.settings.sessions.push(session);
        plugin.settings.activeSessionId = session.id;
        plugin.settings.knowledgeBase.sessionId = session.id;
        store.registerPristineConversationSession(session);
        await store.ensureConversationSessionCreated(session);
        session.messages.push(seed);
        await store.saveSettings(true, {
          flushKnowledgeBaseHistory: false
        });

        const internals = store as unknown as {
          getConversationStore(): FileConversationStore;
          projectKnowledgeBaseHistory(
            candidate: CodexForObsidianSettings,
            strict: boolean
          ): Promise<boolean>;
        };
        const conversationStore = internals.getConversationStore();
        const originalUpsert =
          conversationStore.upsertSession.bind(conversationStore);
        const originalProjection =
          internals.projectKnowledgeBaseHistory.bind(store);
        let scheduledConversationPass = 0;
        conversationStore.upsertSession = async (candidate) => {
          const containsScheduled = candidate.id === session.id
            && candidate.messages.some(
              (message) => message.title === "每日知识库维护"
            );
          if (containsScheduled) {
            scheduledConversationPass += 1;
            if (
              failurePoint === "conversation-pass-1"
              || (
                failurePoint === "conversation-pass-2"
                && scheduledConversationPass % 2 === 0
              )
            ) {
              throw new Error(`fixture ${failurePoint} failure`);
            }
          }
          await originalUpsert(candidate);
        };
        internals.projectKnowledgeBaseHistory = async (candidate, strict) => {
          const projected = await originalProjection(candidate, strict);
          if (
            failurePoint === "history"
            && candidate.sessions.some((candidateSession) =>
              candidateSession.id === session.id
              && candidateSession.messages.some(
                (message) => message.title === "每日知识库维护"
              ))
          ) {
            throw new Error("fixture History post-write failure");
          }
          return projected;
        };
        failDataWrites = failurePoint === "data";

        const workflowRunId = `scheduled-authority-${failurePoint}`;
        let afterMessageSavedCalls = 0;
        await appendScheduledMaintenanceMessage(
          plugin,
          {
            status: "success",
            reportPath: "",
            summary: `scheduled ${failurePoint} result`,
            processedSources: [],
            workflowRunId,
            commitState: "committed",
            terminalPhase: "finalized"
          },
          async () => {
            afterMessageSavedCalls += 1;
            return {
              localCommitStatus: "failed" as const,
              cleanupStatuses: ["retained-for-recovery" as const],
              cleanupAttempted: false,
              disposedCount: 0,
              recordIds: [],
              recoveryRequired: true,
              warning: `fixture ${failurePoint} waits for restart`
            };
          }
        );

        const liveAfterFailure = plugin.settings.sessions.find(
          (candidate: StoredSession) => candidate.id === session.id
        );
        const liveScheduledAfterFailure =
          liveAfterFailure?.messages.filter(
            (message: ChatMessage) => message.runId === workflowRunId
          ) ?? [];
        const durableAfterFailure =
          await store.readConversationSession(session.id);
        const durableScheduledAfterFailure =
          durableAfterFailure?.messages.filter(
            (message) => message.runId === workflowRunId
          ) ?? [];
        if (failurePoint === "conversation-pass-1") {
          assert.equal(afterMessageSavedCalls, 0);
          assert.deepEqual(liveScheduledAfterFailure, []);
          assert.deepEqual(
            durableScheduledAfterFailure,
            [],
            "a proven-absent pass-1 failure must not leave a Conversation ghost"
          );
        } else {
          assert.equal(
            afterMessageSavedCalls,
            1,
            "a durable scheduled source must enter recoverable completion"
          );
          assert.equal(liveScheduledAfterFailure.length, 1);
          assert.equal(
            durableScheduledAfterFailure.length,
            1,
            `${failurePoint} failure must not roll back the durable Conversation source`
          );
          assert.equal(
            durableScheduledAfterFailure[0]?.id,
            liveScheduledAfterFailure[0]?.id
          );
        }

        conversationStore.upsertSession = originalUpsert;
        internals.projectKnowledgeBaseHistory = originalProjection;
        failDataWrites = false;
        store = new EchoInkSettingsStore(plugin);
        await store.loadSettings();

        const restartedSession = plugin.settings.sessions.find(
          (candidate: StoredSession) => candidate.id === session.id
        );
        assert.ok(restartedSession);
        if (failurePoint === "conversation-pass-1") {
          assert.equal(
            restartedSession.messages.some(
              (message: ChatMessage) => message.runId === workflowRunId
            ),
            false,
            "fresh restart must not hydrate a scheduled message that never committed"
          );
          await appendScheduledMaintenanceMessage(
            plugin,
            {
              status: "success",
              reportPath: "",
              summary: `scheduled ${failurePoint} retry`,
              processedSources: [],
              workflowRunId,
              commitState: "committed",
              terminalPhase: "finalized"
            },
            async () => ({
              localCommitStatus: "committed" as const,
              cleanupStatuses: ["disposed" as const],
              cleanupAttempted: true,
              disposedCount: 1,
              recordIds: [`native:${workflowRunId}`],
              recoveryRequired: false
            })
          );
        } else {
          assert.equal(
            restartedSession.messages.filter(
              (message: ChatMessage) => message.runId === workflowRunId
            ).length,
            1,
            "fresh restart must hydrate the durable scheduled source"
          );
          await store.saveSettings(true, {
            strictConversationStore: true,
            strictKnowledgeBaseHistory: true
          });
        }

        const finalSession = plugin.settings.sessions.find(
          (candidate: StoredSession) => candidate.id === session.id
        );
        const finalScheduled = finalSession?.messages.filter(
          (message: ChatMessage) => message.runId === workflowRunId
        ) ?? [];
        assert.equal(
          finalScheduled.length,
          1,
          `${failurePoint} recovery must converge to exactly one scheduled message`
        );
        const finalDurable = await store.readConversationSession(session.id);
        assert.equal(
          finalDurable?.messages.filter(
            (message) => message.runId === workflowRunId
          ).length,
          1,
          `${failurePoint} retry must keep exactly one canonical source`
        );
        const historyDay = await store.readKnowledgeBaseHistoryDay(
          session.id,
          localDateKeyForTimestamp(finalScheduled[0]!.createdAt)
        );
        assert.equal(
          historyDay.filter((message) => message.runId === workflowRunId).length,
          1,
          `${failurePoint} retry must converge History without a ghost duplicate`
        );
      } finally {
        await rm(vaultPath, { recursive: true, force: true });
      }
    }
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }
}

async function assertScheduledCleanupFailurePreservesCommittedMessage(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-scheduled-cleanup-recovery-"));
  const originalWarn = console.warn;
  const session = knowledgeSession(
    vaultPath,
    "knowledge-scheduled-cleanup-recovery",
    [messageForDate("scheduled-existing", "2026-01-20")]
  );
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [session],
    activeSessionId: session.id,
    knowledgeBase: {
      sessionId: session.id,
      lastSummary: "维护业务结果已经提交"
    }
  }).settings;
  const persistedSnapshots: CodexForObsidianSettings[] = [];
  const settledRecordIds: string[] = [];
  const plugin: any = {
    settings,
    getVaultPath: () => vaultPath,
    getPluginDataDirName: () => PLUGIN_DIR,
    externalizeMessageText: async () => undefined,
    saveSettings: async () => {
      persistedSnapshots.push(structuredClone(settings));
    },
    appendHarnessRunEvent: async () => undefined,
    commitKnowledgeRunDurably: async () => ({
      committed: true,
      conversationCommitted: true,
      runLedgerCommitted: true,
      artifactsCommitted: true,
      historyIndexCommitted: true
    }),
    recordNativeExecution: async () => undefined,
    settleNativeExecution: async (input: { recordId: string }) => {
      settledRecordIds.push(input.recordId);
      return { cleanup: "pending" };
    },
    cleanupDueNativeExecutions: async () => {
      throw new Error("Native cleanup is blocked until startup reconciliation succeeds");
    },
    settleHarnessRunTerminal: async () => undefined,
    pruneKnowledgeBaseHistoryByRetention: async () => ({
      removedDayCount: 0,
      removedMessageCount: 0
    }),
    getCodexView: () => null
  };
  const service = new KnowledgeBaseAgentTaskService(
    plugin,
    { isCancelRequested: () => false }
  );
  const recordId = "native:scheduled-cleanup-recovery";
  (service as any).pendingNativeExecutionCommits.set(recordId, {
    runId: "run:scheduled-cleanup-recovery",
    runOutcome: "success"
  });
  let lifecycleSummary: KnowledgeBaseNativeLifecycleSummary | null = null;
  const result: KnowledgeBaseRunResult = {
    status: "success",
    reportPath: "",
    summary: "scheduled result",
    processedSources: []
  };

  console.warn = () => undefined;
  try {
    await appendScheduledMaintenanceMessage(
      plugin,
      result,
      async () => {
        await service.settlePendingNativeExecutions();
        lifecycleSummary = service.getLastNativeLifecycleSummary();
        return lifecycleSummary;
      }
    );

    const savedMessage = settings.sessions
      .find((candidate) => candidate.id === session.id)
      ?.messages.find((message) => message.title === "每日知识库维护");
    const persistedMessage = persistedSnapshots.at(-1)?.sessions
      .find((candidate) => candidate.id === session.id)
      ?.messages.find((message) => message.id === savedMessage?.id);

    assert.equal(savedMessage?.status, "completed");
    assert.equal(
      persistedMessage?.status,
      "completed",
      "cleanup failure must not reverse the already persisted scheduled message"
    );
    assert.deepEqual(settledRecordIds, [recordId]);
    assert.equal(
      (service as any).pendingNativeExecutionCommits.has(recordId),
      false,
      "durably settled Native receipts must not return to the pending local-commit queue"
    );
    assert.equal(lifecycleSummary?.localCommitStatus, "committed");
    assert.equal(lifecycleSummary?.recoveryRequired, true);
    assert.equal(
      lifecycleSummary?.cleanupStatuses.includes("retained-for-recovery"),
      true
    );
    assert.match(
      lifecycleSummary?.warning ?? "",
      /startup reconciliation succeeds/
    );
    assert.match(
      settings.knowledgeBase.lastError,
      /自动维护结果已保存.*Native cleanup is blocked until startup reconciliation succeeds/
    );
    assert.match(
      settings.knowledgeBase.lastSummary,
      /维护业务结果已经提交.*清理待恢复/
    );
    assert.equal(
      settings.knowledgeBase.lastWarnings.some(
        (warning) => warning.id === "native-cleanup-recovery"
      ),
      true
    );
    assert.deepEqual(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt,
      {
        schemaVersion: 1,
        issue: "native-cleanup",
        warningId: "native-cleanup-recovery",
        localCommitStatus: "committed",
        cleanupStatuses: ["pending", "retained-for-recovery"],
        cleanupAttempted: false,
        recordIds: [recordId],
        message: settings.knowledgeBase.lastError,
        firstObservedAt: settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.firstObservedAt,
        updatedAt: settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.updatedAt,
        projection: {
          lastErrorBefore: "",
          lastSummaryBefore: "维护业务结果已经提交",
          lastErrorWithRecovery: settings.knowledgeBase.lastError,
          lastSummaryWithRecovery: settings.knowledgeBase.lastSummary
        }
      },
      "cleanup recovery must persist a structured receipt instead of relying on warning text"
    );
    const reloaded = normalizeSettingsData(
      persistedSnapshots.at(-1) ?? settings
    ).settings.knowledgeBase;
    assert.deepEqual(
      reloaded.nativeLifecycleRecoveryReceipt,
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt,
      "the cleanup recovery receipt must survive settings normalization"
    );
  } finally {
    console.warn = originalWarn;
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertScheduledLocalCommitFailureKeepsRecoveryReceipt(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-scheduled-local-commit-recovery-"));
  const originalWarn = console.warn;
  const session = knowledgeSession(
    vaultPath,
    "knowledge-scheduled-local-commit-recovery",
    [messageForDate("scheduled-existing-local-commit", "2026-01-20")]
  );
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [session],
    activeSessionId: session.id,
    knowledgeBase: {
      sessionId: session.id,
      lastSummary: "Agent 已生成维护结果"
    }
  }).settings;
  const persistedSnapshots: CodexForObsidianSettings[] = [];
  let cleanupCalls = 0;
  const plugin: any = {
    settings,
    getVaultPath: () => vaultPath,
    getPluginDataDirName: () => PLUGIN_DIR,
    externalizeMessageText: async () => undefined,
    saveSettings: async () => {
      persistedSnapshots.push(structuredClone(settings));
    },
    appendHarnessRunEvent: async () => undefined,
    commitKnowledgeRunDurably: async () => ({
      committed: false,
      conversationCommitted: false,
      runLedgerCommitted: false,
      artifactsCommitted: true,
      historyIndexCommitted: false,
      error: "Conversation/History/Run 持久化失败"
    }),
    recordNativeExecution: async () => undefined,
    settleNativeExecution: async () => ({
      cleanup: "retained-for-recovery"
    }),
    cleanupDueNativeExecutions: async () => {
      cleanupCalls += 1;
      return [];
    },
    settleHarnessRunTerminal: async () => undefined,
    pruneKnowledgeBaseHistoryByRetention: async () => ({
      removedDayCount: 0,
      removedMessageCount: 0
    }),
    getCodexView: () => null
  };
  const service = new KnowledgeBaseAgentTaskService(
    plugin,
    { isCancelRequested: () => false }
  );
  const recordId = "native:scheduled-local-commit-recovery";
  (service as any).pendingNativeExecutionCommits.set(recordId, {
    runId: "run:scheduled-local-commit-recovery",
    runOutcome: "success"
  });
  let lifecycleSummary: KnowledgeBaseNativeLifecycleSummary | null = null;
  const result: KnowledgeBaseRunResult = {
    status: "success",
    reportPath: "",
    summary: "scheduled result",
    processedSources: []
  };

  console.warn = () => undefined;
  try {
    await appendScheduledMaintenanceMessage(
      plugin,
      result,
      async () => {
        await service.settlePendingNativeExecutions();
        lifecycleSummary = service.getLastNativeLifecycleSummary();
        return lifecycleSummary;
      }
    );

    assert.equal(lifecycleSummary?.localCommitStatus, "failed");
    assert.equal(lifecycleSummary?.recoveryRequired, true);
    assert.equal(cleanupCalls, 0, "Native cleanup must remain closed while local commit is unproven");
    assert.equal(
      (service as any).pendingNativeExecutionCommits.has(recordId),
      true,
      "the Native receipt must remain pending for a later durable commit"
    );
    assert.match(settings.knowledgeBase.lastError, /自动维护结果尚未完全提交/);
    assert.match(settings.knowledgeBase.lastError, /本地提交待恢复/);
    assert.doesNotMatch(settings.knowledgeBase.lastError, /自动维护结果已保存/);
    assert.match(
      settings.knowledgeBase.lastSummary,
      /结果尚未完全提交.*本地持久化待恢复/
    );
    assert.doesNotMatch(
      settings.knowledgeBase.lastSummary,
      /不影响已保存的维护结果/
    );
    assert.deepEqual(
      settings.knowledgeBase.lastWarnings.map((warning) => warning.id),
      ["native-local-commit-recovery"]
    );
    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "local-persistence"
    );
    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.localCommitStatus,
      "failed"
    );
    assert.deepEqual(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.recordIds,
      [recordId]
    );
    assert.deepEqual(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.cleanupStatuses,
      ["retained-for-recovery"]
    );
    assert.deepEqual(
      persistedSnapshots.at(-1)?.knowledgeBase.nativeLifecycleRecoveryReceipt,
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt,
      "local commit failure must durably preserve the structured recovery receipt"
    );
    const cleanupOnlySuccess = reconcileKnowledgeBaseNativeLifecycleRecovery(
      settings.knowledgeBase,
      {
        cleanupStatuses: ["disposed"],
        cleanupAttempted: true,
        disposedCount: 1,
        recordIds: [recordId],
        recoveryRequired: false
      },
      200
    );
    assert.equal(
      cleanupOnlySuccess.state,
      "unchanged",
      "a cleanup result cannot clear a local-persistence receipt without committed local proof"
    );
    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "local-persistence"
    );
    const committedRecovery = reconcileKnowledgeBaseNativeLifecycleRecovery(
      settings.knowledgeBase,
      {
        localCommitStatus: "committed",
        cleanupStatuses: ["pending"],
        cleanupAttempted: false,
        disposedCount: 0,
        recordIds: [recordId],
        recoveryRequired: false
      },
      300
    );
    assert.equal(committedRecovery.state, "cleared");
    assert.equal(settings.knowledgeBase.nativeLifecycleRecoveryReceipt, null);
    assert.equal(settings.knowledgeBase.lastError, "");
    assert.equal(settings.knowledgeBase.lastSummary, "Agent 已生成维护结果");
  } finally {
    console.warn = originalWarn;
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertScheduledPostSaveFailurePreservesCommittedMessage(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-scheduled-post-save-failure-"));
  const originalWarn = console.warn;
  const session = knowledgeSession(
    vaultPath,
    "knowledge-scheduled-post-save-failure",
    [messageForDate("scheduled-existing-post-save", "2026-01-20")]
  );
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [session],
    activeSessionId: session.id,
    knowledgeBase: {
      sessionId: session.id,
      lastSummary: "定时维护已完成"
    }
  }).settings;
  const persistedSnapshots: CodexForObsidianSettings[] = [];
  const plugin: any = {
    settings,
    getVaultPath: () => vaultPath,
    externalizeMessageText: async () => undefined,
    saveSettings: async () => {
      persistedSnapshots.push(structuredClone(settings));
    },
    pruneKnowledgeBaseHistoryByRetention: async () => ({
      removedDayCount: 0,
      removedMessageCount: 0
    }),
    getCodexView: () => null
  };
  const result: KnowledgeBaseRunResult = {
    status: "success",
    reportPath: "",
    summary: "scheduled result",
    processedSources: []
  };

  console.warn = () => undefined;
  try {
    await appendScheduledMaintenanceMessage(
      plugin,
      result,
      async () => {
        throw new Error("cleanup provider became unavailable after commit");
      }
    );

    const savedMessage = settings.sessions
      .find((candidate) => candidate.id === session.id)
      ?.messages.find((message) => message.title === "每日知识库维护");
    const persistedMessage = persistedSnapshots.at(-1)?.sessions
      .find((candidate) => candidate.id === session.id)
      ?.messages.find((message) => message.id === savedMessage?.id);

    assert.equal(savedMessage?.status, "completed");
    assert.equal(
      persistedMessage?.status,
      "completed",
      "a rejected afterMessageSaved cleanup must not roll back the durable message"
    );
    assert.match(
      settings.knowledgeBase.lastError,
      /自动维护结果尚未完全提交.*cleanup provider became unavailable after commit/
    );
    assert.doesNotMatch(settings.knowledgeBase.lastError, /自动维护结果已保存/);
    assert.match(
      settings.knowledgeBase.lastSummary,
      /定时维护已完成.*结果尚未完全提交.*本地持久化待恢复/
    );
    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "local-persistence",
      "an unstructured post-save exception must fail closed instead of claiming the local commit succeeded"
    );
    assert.deepEqual(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.recordIds,
      []
    );
    const uncorrelatedSuccess = reconcileKnowledgeBaseNativeLifecycleRecovery(
      settings.knowledgeBase,
      {
        localCommitStatus: "committed",
        cleanupStatuses: ["disposed"],
        cleanupAttempted: true,
        disposedCount: 1,
        recordIds: ["native:uncorrelated-after-callback-error"],
        recoveryRequired: false
      },
      400
    );
    assert.equal(
      uncorrelatedSuccess.state,
      "unchanged",
      "an empty receipt has no stable correlation and must not be auto-cleared by an unrelated success"
    );
    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "local-persistence"
    );
  } finally {
    console.warn = originalWarn;
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertCrossBatchRecoveryKeepsOldestProvableObligation(): Promise<void> {
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    knowledgeBase: {
      lastError: "批次 A 前的业务提醒",
      lastSummary: "批次 A 前的业务摘要",
      lastWarnings: [{
        id: "business-warning-a",
        message: "批次 A 需要人工复核"
      }]
    }
  }).settings.knowledgeBase;
  const recordA = "native:cross-batch-local-a";
  const recordB = "native:cross-batch-cleanup-b";
  const localFailureA = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings,
    {
      localCommitStatus: "failed",
      cleanupStatuses: ["retained-for-recovery"],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [recordA],
      recoveryRequired: true,
      warning: "批次 A 本地提交待恢复"
    },
    100
  );
  assert.equal(localFailureA.state, "recovery-pending");

  settings.lastError = "批次 B 覆盖后的业务提醒";
  settings.lastSummary = "批次 B 覆盖后的业务摘要";
  settings.lastWarnings = [{
    id: "business-warning-b",
    message: "批次 B 需要人工复核"
  }];
  const noLifecycleSummary = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings,
    null,
    150
  );
  assert.equal(
    noLifecycleSummary.state,
    "recovery-pending",
    "a run without a lifecycle summary must re-project an older durable receipt"
  );
  assert.match(settings.lastError, /批次 A 本地提交待恢复/);
  assert.deepEqual(
    settings.lastWarnings.map((warning) => warning.id),
    ["business-warning-b", "native-local-commit-recovery"]
  );

  settings.lastError = "批次 B 覆盖后的业务提醒";
  settings.lastSummary = "批次 B 覆盖后的业务摘要";
  settings.lastWarnings = [{
    id: "business-warning-b",
    message: "批次 B 需要人工复核"
  }];
  const cleanupFailureB = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings,
    {
      localCommitStatus: "committed",
      cleanupStatuses: ["failed"],
      cleanupAttempted: true,
      disposedCount: 0,
      recordIds: [recordB],
      recoveryRequired: true,
      warning: "批次 B Native cleanup 待恢复"
    },
    200
  );

  assert.equal(cleanupFailureB.state, "recovery-pending");
  assert.equal(
    cleanupFailureB.issue,
    "local-persistence",
    "an unrelated cleanup failure must not downgrade the older local-persistence obligation"
  );
  assert.equal(settings.nativeLifecycleRecoveryReceipt?.issue, "local-persistence");
  assert.deepEqual(
    settings.nativeLifecycleRecoveryReceipt?.recordIds,
    [recordA],
    "one receipt must retain one provable batch instead of unioning records A and B"
  );
  assert.equal(settings.nativeLifecycleRecoveryReceipt?.firstObservedAt, 100);
  assert.match(settings.lastError, /批次 B 覆盖后的业务提醒/);
  assert.match(settings.lastError, /自动维护结果尚未完全提交/);
  assert.match(settings.lastError, /批次 A 本地提交待恢复/);
  assert.doesNotMatch(settings.lastError, /自动维护结果已保存/);
  assert.doesNotMatch(settings.lastError, /批次 B Native cleanup 待恢复/);
  assert.match(settings.lastSummary, /批次 B 覆盖后的业务摘要/);
  assert.match(settings.lastSummary, /结果尚未完全提交.*本地持久化待恢复/);
  assert.doesNotMatch(settings.lastSummary, /不影响已保存的维护结果/);
  assert.deepEqual(
    settings.lastWarnings.map((warning) => warning.id),
    ["business-warning-b", "native-local-commit-recovery"],
    "a new run must not make the durable older obligation invisible"
  );

  const unrelatedSuccessB = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings,
    {
      localCommitStatus: "committed",
      cleanupStatuses: ["disposed"],
      cleanupAttempted: true,
      disposedCount: 1,
      recordIds: [recordB],
      recoveryRequired: false
    },
    300
  );
  assert.equal(unrelatedSuccessB.state, "unchanged");
  assert.deepEqual(settings.nativeLifecycleRecoveryReceipt?.recordIds, [recordA]);

  const exactRecoveryA = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings,
    {
      localCommitStatus: "committed",
      cleanupStatuses: ["pending"],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [recordA],
      recoveryRequired: false
    },
    400
  );
  assert.equal(exactRecoveryA.state, "cleared");
  assert.equal(settings.nativeLifecycleRecoveryReceipt, null);
  assert.equal(
    settings.lastError,
    "批次 B 覆盖后的业务提醒",
    "exact recovery must clear only the recovery projection from the latest run"
  );
  assert.equal(settings.lastSummary, "批次 B 覆盖后的业务摘要");
  assert.deepEqual(settings.lastWarnings, [{
    id: "business-warning-b",
    message: "批次 B 需要人工复核"
  }]);

  const reverseSettings = normalizeSettingsData({
    settingsVersion: 29,
    knowledgeBase: {
      lastError: "旧 cleanup 前的业务提醒",
      lastSummary: "旧 cleanup 前的业务摘要",
      lastWarnings: [{
        id: "business-warning-old-cleanup",
        message: "旧 cleanup 业务提醒"
      }]
    }
  }).settings.knowledgeBase;
  const oldCleanupA = reconcileKnowledgeBaseNativeLifecycleRecovery(
    reverseSettings,
    {
      localCommitStatus: "committed",
      cleanupStatuses: ["failed"],
      cleanupAttempted: true,
      disposedCount: 0,
      recordIds: [recordA],
      recoveryRequired: true,
      warning: "旧批次 A cleanup 待恢复"
    },
    500
  );
  assert.equal(oldCleanupA.issue, "native-cleanup");

  reverseSettings.lastError = "新批次 B 覆盖后的业务提醒";
  reverseSettings.lastSummary = "新批次 B 覆盖后的业务摘要";
  reverseSettings.lastWarnings = [{
    id: "business-warning-new-local",
    message: "新批次 B 业务提醒"
  }];
  const newLocalFailureB = reconcileKnowledgeBaseNativeLifecycleRecovery(
    reverseSettings,
    {
      localCommitStatus: "failed",
      cleanupStatuses: ["retained-for-recovery"],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [recordB],
      recoveryRequired: true,
      warning: "新批次 B 本地提交待恢复"
    },
    600
  );
  assert.equal(
    newLocalFailureB.issue,
    "local-persistence",
    "a newer uncommitted local result must take priority over an older cleanup-only receipt"
  );
  assert.deepEqual(
    reverseSettings.nativeLifecycleRecoveryReceipt?.recordIds,
    [recordB],
    "priority replacement must keep the new local batch exact instead of unioning old cleanup A"
  );
  assert.equal(
    reverseSettings.nativeLifecycleRecoveryReceipt?.firstObservedAt,
    600,
    "a stronger replacement is a new independently provable obligation"
  );
  assert.match(reverseSettings.lastError, /新批次 B 覆盖后的业务提醒/);
  assert.match(reverseSettings.lastError, /新批次 B 本地提交待恢复/);
  assert.doesNotMatch(reverseSettings.lastError, /自动维护结果已保存/);
  assert.doesNotMatch(reverseSettings.lastError, /旧批次 A cleanup 待恢复/);
  assert.match(reverseSettings.lastSummary, /结果尚未完全提交.*本地持久化待恢复/);
  assert.deepEqual(
    reverseSettings.lastWarnings.map((warning) => warning.id),
    ["business-warning-new-local", "native-local-commit-recovery"]
  );

  const exactRecoveryB = reconcileKnowledgeBaseNativeLifecycleRecovery(
    reverseSettings,
    {
      localCommitStatus: "committed",
      cleanupStatuses: ["pending"],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [recordB],
      recoveryRequired: false
    },
    700
  );
  assert.equal(exactRecoveryB.state, "cleared");
  assert.equal(reverseSettings.lastError, "新批次 B 覆盖后的业务提醒");
  assert.equal(reverseSettings.lastSummary, "新批次 B 覆盖后的业务摘要");
  assert.deepEqual(reverseSettings.lastWarnings, [{
    id: "business-warning-new-local",
    message: "新批次 B 业务提醒"
  }]);

  const transitionSettings = normalizeSettingsData({
    settingsVersion: 29,
    knowledgeBase: {
      lastSummary: "同批次业务摘要"
    }
  }).settings.knowledgeBase;
  reconcileKnowledgeBaseNativeLifecycleRecovery(
    transitionSettings,
    {
      localCommitStatus: "failed",
      cleanupStatuses: ["retained-for-recovery"],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [recordA],
      recoveryRequired: true,
      warning: "同批次本地提交待恢复"
    },
    800
  );
  const sameBatchCleanupTransition = reconcileKnowledgeBaseNativeLifecycleRecovery(
    transitionSettings,
    {
      localCommitStatus: "committed",
      cleanupStatuses: ["failed"],
      cleanupAttempted: true,
      disposedCount: 0,
      recordIds: [recordA],
      recoveryRequired: true,
      warning: "同批次本地提交已恢复，cleanup 仍待恢复"
    },
    900
  );
  assert.equal(
    sameBatchCleanupTransition.issue,
    "native-cleanup",
    "proof for the same local batch may transition to its remaining cleanup obligation"
  );
  assert.deepEqual(transitionSettings.nativeLifecycleRecoveryReceipt?.recordIds, [recordA]);
  assert.equal(
    transitionSettings.nativeLifecycleRecoveryReceipt?.firstObservedAt,
    900,
    "the cleanup transition starts a new independently provable obligation"
  );
  assert.match(transitionSettings.lastError, /自动维护结果已保存/);
  assert.doesNotMatch(transitionSettings.lastError, /结果尚未完全提交/);
}

async function assertSettingsSaveReprojectsDurableRecoveryReceipt(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-native-recovery-reprojection-"));
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    knowledgeBase: {
      lastSummary: "批次 A 业务摘要"
    }
  }).settings;
  const plugin = startupSettingsPlugin(vaultPath, settings);
  const store = new EchoInkSettingsStore(plugin as never);
  const recordId = "native:settings-save-reprojection";

  try {
    reconcileKnowledgeBaseNativeLifecycleRecovery(
      settings.knowledgeBase,
      {
        localCommitStatus: "committed",
        cleanupStatuses: ["failed"],
        cleanupAttempted: true,
        disposedCount: 0,
        recordIds: [recordId],
        recoveryRequired: true,
        warning: "批次 A cleanup 待恢复"
      },
      1_000
    );
    await store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });
    await store.withExclusiveTransaction(async (transaction) => {
      const baseline = await transaction.readWithGeneration();
      // Simulate the next maintenance transaction replacing the public result
      // fields without resolving the older durable Native receipt.
      baseline.settings.lastError = "";
      baseline.settings.lastSummary = "批次 B 新维护摘要";
      baseline.settings.lastWarnings = [{
        id: "business-warning-b",
        message: "批次 B 业务提醒"
      }];
      await transaction.persistCas(
        baseline.generation,
        baseline.settings
      );
    });

    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "native-cleanup"
    );
    assert.match(settings.knowledgeBase.lastError, /批次 A cleanup 待恢复/);
    assert.match(settings.knowledgeBase.lastSummary, /批次 B 新维护摘要/);
    assert.match(settings.knowledgeBase.lastSummary, /清理待恢复/);
    assert.deepEqual(
      settings.knowledgeBase.lastWarnings.map((warning) => warning.id),
      ["business-warning-b", "native-cleanup-recovery"],
      "every settings persistence boundary must re-project an unresolved durable receipt"
    );

    const persisted = normalizeSettingsData(
      await plugin.loadData()
    ).settings.knowledgeBase;
    assert.deepEqual(
      persisted.nativeLifecycleRecoveryReceipt?.recordIds,
      [recordId]
    );
    assert.match(persisted.lastError, /批次 A cleanup 待恢复/);
    assert.match(persisted.lastSummary, /批次 B 新维护摘要.*清理待恢复/);
    assert.deepEqual(
      persisted.lastWarnings.map((warning) => warning.id),
      ["business-warning-b", "native-cleanup-recovery"]
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertLocalPersistenceReceiptSurvivesNewRunSettingsWrites(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-local-recovery-reprojection-"));
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    knowledgeBase: {
      lastSummary: "批次 A 业务摘要"
    }
  }).settings;
  const plugin = startupSettingsPlugin(vaultPath, settings);
  const store = new EchoInkSettingsStore(plugin as never);
  const recordId = "native:local-settings-reprojection-a";

  try {
    reconcileKnowledgeBaseNativeLifecycleRecovery(
      settings.knowledgeBase,
      {
        localCommitStatus: "failed",
        cleanupStatuses: ["retained-for-recovery"],
        cleanupAttempted: false,
        disposedCount: 0,
        recordIds: [recordId],
        recoveryRequired: true,
        warning: "批次 A 本地提交待恢复"
      },
      950
    );

    const normalizationInput = structuredClone(settings);
    normalizationInput.knowledgeBase.lastError = "批次 N 重载提醒";
    normalizationInput.knowledgeBase.lastSummary = "批次 N 重载摘要";
    normalizationInput.knowledgeBase.lastWarnings = [{
      id: "business-warning-n",
      message: "批次 N 重载业务提醒"
    }];
    const normalizedOnce = normalizeSettingsData(
      normalizationInput
    ).settings;
    const normalizedTwice = normalizeSettingsData(
      structuredClone(normalizedOnce)
    ).settings;
    assert.equal(
      normalizedOnce.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "local-persistence"
    );
    assert.match(normalizedOnce.knowledgeBase.lastError, /批次 N 重载提醒/);
    assert.match(normalizedOnce.knowledgeBase.lastError, /批次 A 本地提交待恢复/);
    assert.doesNotMatch(normalizedOnce.knowledgeBase.lastError, /自动维护结果已保存/);
    assert.deepEqual(
      normalizedOnce.knowledgeBase.lastWarnings.map((warning) => warning.id),
      ["business-warning-n", "native-local-commit-recovery"]
    );
    assert.deepEqual(
      normalizedTwice.knowledgeBase,
      normalizedOnce.knowledgeBase,
      "recovery re-projection during settings normalization must be idempotent"
    );

    await store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });

    settings.knowledgeBase.lastError = "批次 B 新维护提醒";
    settings.knowledgeBase.lastSummary = "批次 B 新维护摘要";
    settings.knowledgeBase.lastWarnings = [{
      id: "business-warning-b",
      message: "批次 B 业务提醒"
    }];
    await store.saveSettings(true, {
      flushConversationStore: false,
      flushKnowledgeBaseHistory: false
    });

    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "local-persistence"
    );
    assert.deepEqual(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.recordIds,
      [recordId]
    );
    assert.match(settings.knowledgeBase.lastError, /批次 B 新维护提醒/);
    assert.match(settings.knowledgeBase.lastError, /批次 A 本地提交待恢复/);
    assert.doesNotMatch(settings.knowledgeBase.lastError, /自动维护结果已保存/);
    assert.match(settings.knowledgeBase.lastSummary, /批次 B 新维护摘要/);
    assert.match(
      settings.knowledgeBase.lastSummary,
      /结果尚未完全提交.*本地持久化待恢复/
    );
    assert.deepEqual(
      settings.knowledgeBase.lastWarnings.map((warning) => warning.id),
      ["business-warning-b", "native-local-commit-recovery"],
      "an ordinary settings save must re-project the unresolved local receipt"
    );

    await store.withExclusiveTransaction(async (transaction) => {
      const baseline = await transaction.readWithGeneration();
      baseline.settings.lastError = "批次 C workflow 提醒";
      baseline.settings.lastSummary = "批次 C workflow 摘要";
      baseline.settings.lastWarnings = [{
        id: "business-warning-c",
        message: "批次 C workflow 业务提醒"
      }];
      await transaction.persistCas(
        baseline.generation,
        baseline.settings
      );
    });

    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
      "local-persistence"
    );
    assert.deepEqual(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.recordIds,
      [recordId]
    );
    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.projection.lastErrorBefore,
      "批次 C workflow 提醒"
    );
    assert.equal(
      settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.projection.lastSummaryBefore,
      "批次 C workflow 摘要"
    );
    assert.match(settings.knowledgeBase.lastError, /批次 C workflow 提醒/);
    assert.match(settings.knowledgeBase.lastError, /批次 A 本地提交待恢复/);
    assert.doesNotMatch(settings.knowledgeBase.lastError, /自动维护结果已保存/);
    assert.doesNotMatch(settings.knowledgeBase.lastSummary, /不影响已保存的维护结果/);
    assert.deepEqual(
      settings.knowledgeBase.lastWarnings.map((warning) => warning.id),
      ["business-warning-c", "native-local-commit-recovery"],
      "workflow CAS must not hide or downgrade the older local-persistence receipt"
    );

    const persisted = normalizeSettingsData(
      await plugin.loadData()
    ).settings.knowledgeBase;
    assert.equal(persisted.nativeLifecycleRecoveryReceipt?.issue, "local-persistence");
    assert.deepEqual(persisted.nativeLifecycleRecoveryReceipt?.recordIds, [recordId]);
    assert.match(persisted.lastError, /批次 C workflow 提醒/);
    assert.match(persisted.lastError, /批次 A 本地提交待恢复/);
    assert.doesNotMatch(persisted.lastError, /自动维护结果已保存/);
    assert.deepEqual(
      persisted.lastWarnings.map((warning) => warning.id),
      ["business-warning-c", "native-local-commit-recovery"]
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertConnectionRecoveryClearsScheduledLifecycleWarning(): Promise<void> {
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    knowledgeBase: {
      lastError: "业务结果原有提醒",
      lastSummary: "业务结果原有摘要",
      lastWarnings: [{
        id: "business-warning",
        message: "业务结果需要人工复核"
      }]
    }
  }).settings;
  const failedSummary: KnowledgeBaseNativeLifecycleSummary = {
    localCommitStatus: "committed",
    cleanupStatuses: ["failed"],
    cleanupAttempted: true,
    disposedCount: 0,
    recordIds: ["native:connection-recovery"],
    recoveryRequired: true,
    warning: "OpenCode session cleanup failed"
  };
  const seeded = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings.knowledgeBase,
    failedSummary,
    100
  );
  assert.equal(seeded.state, "recovery-pending");
  assert.equal(
    settings.knowledgeBase.nativeLifecycleRecoveryReceipt?.issue,
    "native-cleanup"
  );
  const restartWithoutPendingMemory = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings.knowledgeBase,
    {
      cleanupStatuses: [],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [],
      recoveryRequired: false
    },
    200
  );
  assert.equal(
    restartWithoutPendingMemory.state,
    "unchanged",
    "an empty success summary after restart must not clear a retained Store receipt"
  );
  const unrelatedRecordSuccess = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings.knowledgeBase,
    {
      cleanupStatuses: ["disposed"],
      cleanupAttempted: true,
      disposedCount: 1,
      recordIds: ["native:unrelated-cleanup"],
      recoveryRequired: false
    },
    300
  );
  assert.equal(
    unrelatedRecordSuccess.state,
    "unchanged",
    "a successful cleanup for record B must not clear record A's receipt"
  );
  settings.knowledgeBase.lastError = appendKnowledgeBaseWarning(
    settings.knowledgeBase.lastError,
    "后续业务错误"
  );
  settings.knowledgeBase.lastSummary = appendKnowledgeBaseWarning(
    settings.knowledgeBase.lastSummary,
    "后续业务摘要"
  );

  const recoveredSummary: KnowledgeBaseNativeLifecycleSummary = {
    localCommitStatus: "committed",
    cleanupStatuses: ["disposed"],
    cleanupAttempted: true,
    disposedCount: 1,
    recordIds: ["native:connection-recovery"],
    recoveryRequired: false
  };
  const connectedStatus = {
    connected: true,
    accountLabel: "Fixture",
    loggedIn: true,
    models: [],
    skills: [],
    mcpServers: [],
    rateLimits: null,
    rateLimitsByLimitId: null,
    errors: []
  };
  let saveCalls = 0;
  let recoveryCalls = 0;
  let refreshCalls = 0;
  const plugin: any = {
    settings,
    codex: {
      isConnected: () => false,
      connect: async () => connectedStatus
    },
    lastStatus: null,
    archivePendingKnowledgeBaseThreads: async () => {
      recoveryCalls += 1;
      return 1;
    },
    getKnowledgeBaseManager: () => ({
      getLastNativeLifecycleSummary: () => recoveredSummary
    }),
    saveSettings: async () => {
      saveCalls += 1;
    },
    refreshKnowledgeBaseSurfaces: () => {
      refreshCalls += 1;
    }
  };
  const service = new EchoInkConnectionService(plugin, () => undefined);

  await service.ensureCodexConnected();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(recoveryCalls, 1);
  assert.equal(saveCalls, 1, "successful cleanup recovery must durably clear its warning receipt");
  assert.equal(refreshCalls, 1, "the cleared recovery state must refresh visible Knowledge surfaces");
  assert.equal(settings.knowledgeBase.nativeLifecycleRecoveryReceipt, null);
  assert.equal(
    settings.knowledgeBase.lastError,
    "业务结果原有提醒；后续业务错误",
    "clearing the recovery projection must preserve warnings appended after it"
  );
  assert.equal(
    settings.knowledgeBase.lastSummary,
    "业务结果原有摘要；后续业务摘要",
    "clearing the recovery projection must preserve summary details appended after it"
  );
  assert.deepEqual(settings.knowledgeBase.lastWarnings, [{
    id: "business-warning",
    message: "业务结果需要人工复核"
  }]);
}

interface SharedRawFixture {
  vaultPath: string;
  date: string;
  rawRef: string;
  rawText: string;
  rawBytes: Buffer;
  sessionId: string;
  messageId: string;
  conversationStore: FileConversationStore;
  dispose(): Promise<void>;
}

async function createSharedRawFixture(
  label: string,
  date: string
): Promise<SharedRawFixture> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), `echoink-history-${label}-`));
  const rawRef = `raw/${label}.txt`;
  const rawText = `${label}: canonical Conversation Raw body\n保留原文字节`;
  const message = messageForDate(`${label}-message`, date, rawRef);
  const session = knowledgeSession(vaultPath, `${label}-session`, [message]);
  const conversationStore = new FileConversationStore({
    rootPath: path.join(pluginDataDir(vaultPath, PLUGIN_DIR), "conversations")
  });
  await writeRawText(vaultPath, rawRef, rawText, PLUGIN_DIR);
  const rawBytes = await readFile(resolveRawRef(vaultPath, rawRef, PLUGIN_DIR));
  await persistConversation(conversationStore, session);
  await persistKnowledgeBaseHistoryMessages(
    vaultPath,
    PLUGIN_DIR,
    session,
    session.messages
  );
  return {
    vaultPath,
    date,
    rawRef,
    rawText,
    rawBytes,
    sessionId: session.id,
    messageId: message.id,
    conversationStore,
    dispose: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    }
  };
}

async function assertConversationRawUnchanged(
  fixture: SharedRawFixture
): Promise<void> {
  const restored = await fixture.conversationStore.readSession(fixture.sessionId);
  const restoredRawRef = restored?.messages.find(
    (message) => message.id === fixture.messageId
  )?.rawRef;
  assert.equal(restoredRawRef, fixture.rawRef);
  assert.deepEqual(
    await readFile(resolveRawRef(fixture.vaultPath, restoredRawRef!, PLUGIN_DIR)),
    fixture.rawBytes,
    "History cleanup must leave canonical Conversation Raw bytes unchanged"
  );
  assert.equal(
    await readRawText(fixture.vaultPath, restoredRawRef!, PLUGIN_DIR),
    fixture.rawText,
    "the canonical Conversation rawRef must remain readable after History cleanup"
  );
}

interface LegacyHistoryFixtureBytes {
  dayPath: string;
  dayBytes: string;
  indexPath: string;
  indexBytes: string;
}

async function writeLegacyHistoryFixture(
  vaultPath: string,
  session: StoredSession,
  message: ChatMessage
): Promise<LegacyHistoryFixtureBytes> {
  const date = localDateKeyForTimestamp(message.createdAt);
  const dayPath = knowledgeBaseHistoryDayPath(
    vaultPath,
    PLUGIN_DIR,
    session.id,
    date
  );
  const indexPath = knowledgeBaseHistoryIndexPath(
    vaultPath,
    PLUGIN_DIR
  );
  const dayBytes = `${JSON.stringify(message)}\n`;
  const indexBytes = `${JSON.stringify({
    version: 1,
    updatedAt: message.createdAt,
    sessions: [{
      sessionId: session.id,
      title: session.title,
      kind: "knowledge-base",
      activeDate: date,
      messageCount: 1,
      dayCount: 1,
      updatedAt: message.createdAt,
      days: [{
        date,
        messageCount: 1,
        userMessageCount: message.role === "user" ? 1 : 0,
        assistantMessageCount: message.role === "assistant" ? 1 : 0,
        processMessageCount: message.isProcess ? 1 : 0,
        failedMessageCount: message.isError ? 1 : 0,
        firstMessageAt: message.createdAt,
        lastMessageAt: message.createdAt
      }]
    }]
  }, null, 2)}\n`;
  await mkdir(path.dirname(dayPath), { recursive: true });
  await writeFile(dayPath, dayBytes, "utf8");
  await writeFile(indexPath, indexBytes, "utf8");
  return { dayPath, dayBytes, indexPath, indexBytes };
}

async function assertLegacyFixtureBytesUnchanged(
  fixture: LegacyHistoryFixtureBytes
): Promise<void> {
  assert.equal(await readFile(fixture.dayPath, "utf8"), fixture.dayBytes);
  assert.equal(await readFile(fixture.indexPath, "utf8"), fixture.indexBytes);
}

function settingsForKnowledgeSession(
  session: StoredSession,
  historyRetentionDays = 0
): CodexForObsidianSettings {
  return normalizeSettingsData({
    settingsVersion: 29,
    sessions: [session],
    activeSessionId: session.id,
    knowledgeBase: {
      sessionId: session.id,
      historyRetentionDays
    }
  }).settings;
}

async function persistConversation(
  store: FileConversationStore,
  session: StoredSession
): Promise<void> {
  await store.createPristineSession({
    ...session,
    messages: [],
    historyActiveDate: undefined
  });
  await store.upsertSession(session);
}

function knowledgeSession(
  vaultPath: string,
  sessionId: string,
  messages: ChatMessage[]
): StoredSession {
  const createdAt = Math.min(...messages.map((message) => message.createdAt));
  const updatedAt = Math.max(...messages.map((message) => message.createdAt));
  return {
    id: sessionId,
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: `context-${sessionId}`,
    commitId: `commit-${sessionId}`,
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages,
    createdAt,
    updatedAt
  };
}

function messageForDate(
  id: string,
  date: string,
  rawRef?: string
): ChatMessage {
  const text = rawRef ? `[preview for ${id}]` : id;
  return {
    id,
    role: "assistant",
    text,
    ...(rawRef
      ? {
        previewText: text,
        rawRef,
        rawSize: 100,
        rawLines: 2,
        rawTruncatedForPreview: true
      }
      : {}),
    createdAt: timestampForDate(date)
  };
}

function timestampForDate(date: string): number {
  return new Date(`${date}T12:00:00.000Z`).getTime();
}

function startupSettingsPlugin(
  vaultPath: string,
  settings: CodexForObsidianSettings
): {
  settings: CodexForObsidianSettings;
  loadData(): Promise<CodexForObsidianSettings>;
  saveData(data: unknown): Promise<void>;
  getVaultPath(): string;
  getPluginDataDirName(): string;
} {
  let persisted = JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
  return {
    settings,
    async loadData() {
      return JSON.parse(JSON.stringify(persisted)) as CodexForObsidianSettings;
    },
    async saveData(data) {
      persisted = JSON.parse(JSON.stringify(data)) as CodexForObsidianSettings;
    },
    getVaultPath() {
      return vaultPath;
    },
    getPluginDataDirName() {
      return PLUGIN_DIR;
    }
  };
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

if (process.env.ECHOINK_RUN_HISTORY_PROJECTION_RETENTION_TEST === "1") {
  runHarnessV2HistoryProjectionRetentionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
