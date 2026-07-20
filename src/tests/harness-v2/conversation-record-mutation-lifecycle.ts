import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pluginDataDir } from "../../core/raw-message-store";
import {
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import {
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import { NativeExecutionStore } from "../../harness/native/native-execution-store";
import {
  commitEchoInkConversationRecordMutation,
  previewEchoInkConversationRecordMutation
} from "../../plugin/conversation-record-mutation-lifecycle";
import { EchoInkHarnessService } from "../../plugin/harness-service";
import { EchoInkSettingsStore } from "../../plugin/settings-store";
import {
  DEFAULT_SETTINGS,
  type CodexForObsidianSettings,
  type StoredSession
} from "../../settings/settings";

export async function runHarnessV2ConversationRecordMutationLifecycleTests():
Promise<void> {
  await assertLiveDeleteCommitsTombstoneJournalAndProjection();
  await assertLiveClearCommitsEmptyShellAndRetiresOldPayload();
  await assertTargetCommitFailureCompensatesWithoutDeletingConversation();
  await assertPersistedTombstoneWinsOverThrownCommitPromise();
  await assertProjectionFailureReturnsCommittedReceiptAndRestartRepairs();
  await assertPartialNativeRegistrationCompensatesRegisteredRetirements();
  await assertPreviewBlockerFailsClosedBeforeConversationMutation();
}

async function assertLiveDeleteCommitsTombstoneJournalAndProjection():
Promise<void> {
  await withFixture("delete", async (fixture) => {
    const preview = await previewEchoInkConversationRecordMutation(
      fixture.plugin,
      fixture.session,
      "delete-conversation"
    );
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual(preview.disposition, {
      retainMemoryIds: [],
      retainArtifactIds: []
    });

    const receipt = await commitEchoInkConversationRecordMutation({
      plugin: fixture.plugin,
      settingsStore: fixture.settingsStore,
      harnessService: fixture.harnessService,
      session: fixture.session,
      operation: "delete-conversation",
      disposition: preview.disposition
    });

    assert.equal(receipt.localState, "committed");
    assert.equal(receipt.projection, "updated");
    assert.equal(receipt.nativeRetirement, "promoted");
    assert.equal(receipt.nativeRetirementIds.length, 1);
    assert.equal(fixture.plugin.settings.sessions.length, 0);
    assert.equal(
      await fixture.conversationStore.readSession(fixture.session.id),
      null
    );
    const tombstone =
      await fixture.conversationStore.readConversationDeletionTombstone(
        fixture.session.id
      );
    assert.equal(tombstone?.mutationId, receipt.mutationId);
    assert.equal(
      fixture.persistedSettings().sessions.some(
        (session) => session.id === fixture.session.id
      ),
      false
    );
    const retirements =
      await fixture.harnessService.listAwaitingNativeExecutionRetirements();
    const retirement = retirements.find(
      (record) => record.id === receipt.nativeRetirementIds[0]
    );
    assert.equal(retirement?.localCommit, "committed");
    assert.equal(retirement?.cleanup, "pending");
    assert.equal(retirement?.retirement?.targetStatus, "deleted");
    if (retirement?.retirement?.targetStatus === "deleted") {
      assert.equal(
        retirement.retirement.targetTombstoneId,
        tombstone?.tombstoneId
      );
      assert.equal(
        retirement.retirement.targetTombstoneDigest,
        tombstone?.digest
      );
    }
  });
}

async function assertLiveClearCommitsEmptyShellAndRetiresOldPayload():
Promise<void> {
  await withFixture("clear", async (fixture) => {
    const sourceGeneration = fixture.session.generation!;
    const preview = await previewEchoInkConversationRecordMutation(
      fixture.plugin,
      fixture.session,
      "clear-conversation-records"
    );
    assert.deepEqual(preview.blockers, []);

    const receipt = await commitEchoInkConversationRecordMutation({
      plugin: fixture.plugin,
      settingsStore: fixture.settingsStore,
      harnessService: fixture.harnessService,
      session: fixture.session,
      operation: "clear-conversation-records",
      disposition: preview.disposition
    });

    assert.equal(receipt.localState, "committed");
    assert.equal(receipt.projection, "updated");
    assert.equal(fixture.session.messages.length, 0);
    assert.equal(fixture.session.generation, sourceGeneration + 1);
    assert.equal(fixture.session.backendBindings, undefined);
    const durable = await fixture.conversationStore.readSession(
      fixture.session.id
    );
    assert.equal(durable?.messages.length, 0);
    assert.equal(durable?.generation, sourceGeneration + 1);
  });
}

async function assertTargetCommitFailureCompensatesWithoutDeletingConversation():
Promise<void> {
  await withFixture("commit-failure", async (fixture) => {
    fixture.settingsStore.commitConversationDeletionTombstone =
      async () => {
        throw new Error("simulated target CAS failure");
      };
    const preview = await previewEchoInkConversationRecordMutation(
      fixture.plugin,
      fixture.session,
      "delete-conversation"
    );

    const receipt = await commitEchoInkConversationRecordMutation({
      plugin: fixture.plugin,
      settingsStore: fixture.settingsStore,
      harnessService: fixture.harnessService,
      session: fixture.session,
      operation: "delete-conversation",
      disposition: preview.disposition
    });

    assert.equal(receipt.localState, "aborted");
    assert.match(receipt.error ?? "", /simulated target CAS failure/);
    assert.equal(fixture.plugin.settings.sessions[0], fixture.session);
    assert.ok(
      await fixture.conversationStore.readSession(fixture.session.id)
    );
    assert.equal(
      await fixture.conversationStore.readConversationDeletionTombstone(
        fixture.session.id
      ),
      null
    );
  });
}

async function assertPersistedTombstoneWinsOverThrownCommitPromise():
Promise<void> {
  await withFixture("commit-readback", async (fixture) => {
    const commit =
      fixture.settingsStore.commitConversationDeletionTombstone
        .bind(fixture.settingsStore);
    fixture.settingsStore.commitConversationDeletionTombstone =
      async (...args) => {
        await commit(...args);
        throw new Error("simulated throw after durable tombstone");
      };
    const preview = await previewEchoInkConversationRecordMutation(
      fixture.plugin,
      fixture.session,
      "delete-conversation"
    );

    const receipt = await commitEchoInkConversationRecordMutation({
      plugin: fixture.plugin,
      settingsStore: fixture.settingsStore,
      harnessService: fixture.harnessService,
      session: fixture.session,
      operation: "delete-conversation",
      disposition: preview.disposition
    });

    assert.equal(receipt.localState, "committed");
    assert.equal(receipt.projection, "updated");
    assert.equal(fixture.plugin.settings.sessions.length, 0);
    assert.equal(
      (
        await fixture.conversationStore
          .readConversationDeletionTombstone(fixture.session.id)
      )?.mutationId,
      receipt.mutationId
    );
  });
}

async function assertProjectionFailureReturnsCommittedReceiptAndRestartRepairs():
Promise<void> {
  await withFixture("projection-restart", async (fixture) => {
    const saveData = fixture.plugin.saveData.bind(fixture.plugin);
    fixture.plugin.saveData = async () => {
      throw new Error("simulated data shell projection failure");
    };
    const preview = await previewEchoInkConversationRecordMutation(
      fixture.plugin,
      fixture.session,
      "delete-conversation"
    );

    const receipt = await commitEchoInkConversationRecordMutation({
      plugin: fixture.plugin,
      settingsStore: fixture.settingsStore,
      harnessService: fixture.harnessService,
      session: fixture.session,
      operation: "delete-conversation",
      disposition: preview.disposition
    });

    assert.equal(receipt.localState, "committed");
    assert.equal(receipt.projection, "awaiting-recovery");
    assert.equal(fixture.plugin.settings.sessions.length, 0);
    assert.equal(
      fixture.persistedSettings().sessions.some(
        (session) => session.id === fixture.session.id
      ),
      true,
      "the failed projection must leave the stale data shell for restart repair"
    );

    const restartedPlugin: TestPlugin = {
      settings: structuredClone(DEFAULT_SETTINGS),
      loadData: fixture.plugin.loadData.bind(fixture.plugin),
      saveData,
      getVaultPath: fixture.plugin.getVaultPath.bind(fixture.plugin),
      getPluginDataDirName:
        fixture.plugin.getPluginDataDirName.bind(fixture.plugin)
    };
    const restartedStore = new EchoInkSettingsStore(
      restartedPlugin as never
    );
    await restartedStore.loadSettings();
    assert.equal(
      restartedPlugin.settings.sessions.some(
        (session) => session.id === fixture.session.id
      ),
      false
    );
    assert.equal(
      fixture.persistedSettings().sessions.some(
        (session) => session.id === fixture.session.id
      ),
      false,
      "startup hydration must persist the deletion tombstone projection"
    );
  });
}

async function assertPartialNativeRegistrationCompensatesRegisteredRetirements():
Promise<void> {
  await withFixture("partial-retirement", async (fixture) => {
    const register =
      fixture.harnessService.registerNativeExecutionRetirements
        .bind(fixture.harnessService);
    fixture.harnessService.registerNativeExecutionRetirements =
      async (retirements) => {
        assert.equal(retirements.length, 2);
        await register(retirements.slice(0, 1));
        throw new Error("simulated partial Native retirement registration");
      };
    const preview = await previewEchoInkConversationRecordMutation(
      fixture.plugin,
      fixture.session,
      "delete-conversation"
    );

    const receipt = await commitEchoInkConversationRecordMutation({
      plugin: fixture.plugin,
      settingsStore: fixture.settingsStore,
      harnessService: fixture.harnessService,
      session: fixture.session,
      operation: "delete-conversation",
      disposition: preview.disposition
    });

    assert.equal(receipt.localState, "aborted");
    assert.equal(receipt.nativeRetirement, "aborted");
    assert.match(
      receipt.error ?? "",
      /simulated partial Native retirement registration/
    );
    assert.ok(
      await fixture.conversationStore.readSession(fixture.session.id)
    );
    assert.equal(
      await fixture.conversationStore
        .readConversationDeletionTombstone(fixture.session.id),
      null
    );
    const nativeStore = new NativeExecutionStore({
      rootPath: path.join(
        pluginDataDir(
          fixture.plugin.getVaultPath(),
          fixture.plugin.getPluginDataDirName()
        ),
        "harness-native-executions"
      )
    });
    const records = await nativeStore.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].localCommit, "failed");
    assert.equal(records[0].cleanup, "aborted");
  });
}

async function assertPreviewBlockerFailsClosedBeforeConversationMutation():
Promise<void> {
  await withFixture("preview-blocker", async (fixture) => {
    const preview = await previewEchoInkConversationRecordMutation(
      fixture.plugin,
      fixture.session,
      "delete-conversation"
    );
    assert.deepEqual(
      preview.blockers.map((blocker) => blocker.code),
      ["raw-reference-missing"]
    );
    await assert.rejects(
      commitEchoInkConversationRecordMutation({
        plugin: fixture.plugin,
        settingsStore: fixture.settingsStore,
        harnessService: fixture.harnessService,
        session: fixture.session,
        operation: "delete-conversation",
        disposition: preview.disposition
      }),
      /raw-reference-missing/
    );
    assert.ok(
      await fixture.conversationStore.readSession(fixture.session.id)
    );
    assert.equal(
      await fixture.conversationStore
        .readConversationDeletionTombstone(fixture.session.id),
      null
    );
  });
}

interface LifecycleFixture {
  plugin: TestPlugin;
  settingsStore: EchoInkSettingsStore;
  harnessService: EchoInkHarnessService;
  conversationStore: FileConversationStore;
  session: StoredSession;
  persistedSettings(): CodexForObsidianSettings;
}

interface TestPlugin {
  settings: CodexForObsidianSettings;
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
  getVaultPath(): string;
  getPluginDataDirName(): string;
}

async function withFixture(
  suffix: string,
  action: (fixture: LifecycleFixture) => Promise<void>
): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), `echoink-live-record-mutation-${suffix}-`)
  );
  const pluginDir = "codex-echoink";
  const conversationStore = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, pluginDir),
      "conversations"
    )
  });
  const session: StoredSession = {
    id: `conversation-${suffix}`,
    title: `Conversation ${suffix}`,
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: `context-${suffix}-1`,
    commitId: `commit-${suffix}-1`,
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages: [{
      id: `message-${suffix}`,
      role: "user",
      text: "durable message",
      createdAt: 2
    }],
    createdAt: 1,
    updatedAt: 2
  };
  if (suffix === "preview-blocker") {
    session.messages[0] = {
      ...session.messages[0],
      rawRef: "raw/missing.txt",
      rawSize: 16,
      rawLines: 1,
      rawTruncatedForPreview: true
    };
  }
  if (suffix === "delete" || suffix === "partial-retirement") {
    session.backendBindings = {
      opencode: {
        backendId: "opencode",
        nativeSessionId: `native-${suffix}`,
        nativeExecutionKind: "session",
        nativeExecutionRef: {
          backendId: "opencode",
          id: `native-${suffix}`,
          kind: "session",
          persistence: "provider-persistent",
          deviceKey: "device-test",
          vaultId: vaultPath,
          createdAt: 2
        },
        syncedSessionRevision: 1,
        lastUsedAt: 2
      }
    };
    if (suffix === "partial-retirement") {
      session.backendBindings["codex-cli"] = {
        backendId: "codex-cli",
        nativeThreadId: `native-${suffix}-codex`,
        nativeExecutionKind: "thread",
        nativeExecutionRef: {
          backendId: "codex-cli",
          id: `native-${suffix}-codex`,
          kind: "thread",
          persistence: "provider-persistent",
          deviceKey: "device-test",
          vaultId: vaultPath,
          createdAt: 2
        },
        syncedSessionRevision: 1,
        lastUsedAt: 2
      };
    }
  }
  const pristine = structuredClone(session);
  pristine.messages = [];
  delete pristine.backendBindings;
  await conversationStore.createPristineSession(pristine);
  await conversationStore.upsertSession(session);

  let persisted = {
    ...structuredClone(DEFAULT_SETTINGS),
    sessions: [structuredClone(session)],
    activeSessionId: session.id
  } as CodexForObsidianSettings;
  const plugin: TestPlugin = {
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      sessions: [session],
      activeSessionId: session.id
    },
    async loadData() {
      return structuredClone(persisted);
    },
    async saveData(data) {
      persisted = structuredClone(data) as CodexForObsidianSettings;
    },
    getVaultPath() {
      return vaultPath;
    },
    getPluginDataDirName() {
      return pluginDir;
    }
  };
  const settingsStore = new EchoInkSettingsStore(plugin as never);
  const harnessService = new EchoInkHarnessService(plugin as never);
  try {
    await action({
      plugin,
      settingsStore,
      harnessService,
      conversationStore,
      session,
      persistedSettings: () => persisted
    });
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}
