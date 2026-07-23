import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  messagesInCurrentSessionContext,
  sessionGeneration,
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import type { NativeCleanupResult } from "../../harness/native/native-execution-manager";
import { NativeSessionLeaseManager } from "../../harness/kernel/native-session-lease-manager";
import {
  legacyWorkspaceMigrationPlaceholderFingerprint
} from "../../harness/lifecycle/legacy-workspace-migration-identity";
import { EchoInkHarnessService } from "../../plugin/harness-service";
import { EchoInkSettingsStore } from "../../plugin/settings-store";
import {
  ensureEchoInkSessionContextIdentity,
  rotateEchoInkSessionContext,
  type EchoInkSessionContextRotationOptions
} from "../../plugin/session-context-lifecycle";
import type { SessionContextRetirement } from "../../harness/conversation/context-rotation";
import {
  ConversationMutationLane,
  type ConversationMutationAuthority
} from "../../harness/conversation/conversation-mutation-lane";
import {
  ensureKnowledgeBaseSession,
  normalizeSettingsData,
  type ChatMessage,
  type StoredSession
} from "../../settings/settings";
import { messageProvenanceMetaItems } from "../../ui/codex-view/message-list";
import {
  clearKnowledgeBasePage,
  createSession,
  ensureSession,
  resetSessionNativeCache,
  restoreKnowledgeBaseHistoryDate
} from "../../ui/codex-view/session-controller";
import {
  clearChatWorkspace,
  commitChatWorkspaceSelection
} from "../../ui/codex-view/workspace-controller";

export async function runHarnessV2UiContextRotationTests(): Promise<void> {
  await assertFacadeOrdersCommitPromotionAndAsyncCleanup();
  await assertFacadeQueuesLiveMutationsDuringCommit();
  await assertFacadePreconditionRunsInsideConversationLane();
  await assertFacadeCommitFailureKeepsLiveStateAndSkipsCleanup();
  await assertFacadeJournalSettlementFailureBlocksPromotion();
  await assertFacadePromotionFailureKeepsCommittedStateForRecovery();
  await assertResetSessionNativeCacheProductContract();
  await assertLegacyCodexThreadConflictFailsBeforeMutation();
  await assertLegacyPersistentContextBootstrapGate();
  await assertHistoryRestoreCreatesAVisibleOnlyBoundary();
  await assertHistoryRestoreRejectsActiveRunsBeforeAndAfterRead();
  await assertUiCommitFailuresKeepComposerMessagesAndWorkspaceUnchanged();
  await assertClearPostCommitSaveFailureCannotReverseSuccess();
  await assertSettingsStoreRuntimePristineCreateRegistry();
  await assertFirstInstallChatIsCreatedBeforeWorkspaceRotation();
  await assertPersistentRunPreflightAndEphemeralIsolation();
  await assertHarnessServiceSuppliesDurableReplacementAndLeaseRetirement();
  assertNewSessionsUseDurablePristineShells();
  assertNativeCleanupStatusesNormalizeAndRenderTruthfully();
  await assertProductEntrypointsUseTheTypedRotationFacade();
}

async function assertFacadeQueuesLiveMutationsDuringCommit(): Promise<void> {
  let releaseCommit = () => undefined;
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let commitStarted = () => undefined;
  const commitStartedGate = new Promise<void>((resolve) => {
    commitStarted = resolve;
  });
  const fixture = lifecycleFixture({
    commitGate,
    onCommit: () => commitStarted()
  });
  const session = rotationSession();
  const rotation = fixture.rotate(session, {
    reason: "start-new-context",
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    }
  });
  await commitStartedGate;

  const append = fixture.settingsStore.withConversationMutation(
    session.id,
    async () => {
      session.messages.push({
        id: "queued-ui-user",
        role: "user",
        text: "等待 rotation 的新消息",
        createdAt: 3
      });
    }
  );
  const rename = fixture.settingsStore.withConversationMutation(
    session.id,
    async () => {
      session.title = "等待 rotation 的新标题";
    }
  );
  await Promise.resolve();
  assert.equal(session.title, "UI rotation");
  assert.deepEqual(
    session.messages.map((message) => message.id),
    ["old-user", "old-answer"]
  );

  releaseCommit();
  await Promise.all([rotation, append, rename]);
  assert.equal(session.title, "等待 rotation 的新标题");
  assert.deepEqual(
    session.messages.map((message) => message.id),
    ["old-user", "old-answer", "queued-ui-user"]
  );
}

async function assertFacadePreconditionRunsInsideConversationLane(): Promise<void> {
  const fixture = lifecycleFixture();
  const session = rotationSession();
  const before = clone(session);
  let running = false;
  let releaseRunStart = () => undefined;
  const runStartGate = new Promise<void>((resolve) => {
    releaseRunStart = resolve;
  });
  let runLaneAcquired = () => undefined;
  const runLaneAcquiredGate = new Promise<void>((resolve) => {
    runLaneAcquired = resolve;
  });
  const runStart = fixture.settingsStore.withConversationMutation(
    session.id,
    async () => {
      runLaneAcquired();
      await runStartGate;
      running = true;
    }
  );
  await runLaneAcquiredGate;
  assert.equal(running, false, "the outer UI check can still pass at this point");

  const rotation = fixture.rotate(session, {
    reason: "history-restore",
    precondition: () => {
      if (running) throw new Error("run started before rotation acquired its lane");
    },
    mutate: (candidate) => {
      candidate.messages = [];
    }
  });
  releaseRunStart();
  await runStart;
  await assert.rejects(rotation, /run started before rotation acquired its lane/);
  assert.deepEqual(session, before);
  assert.deepEqual(fixture.calls, []);
}

async function assertFacadeOrdersCommitPromotionAndAsyncCleanup(): Promise<void> {
  let releaseCleanup = () => undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const fixture = lifecycleFixture({ cleanupGate });
  const session = rotationSession();
  const rotationPromise = fixture.rotate(session, {
    reason: "agent-cache-reset",
    advanceContext: false,
    mutate: (candidate) => {
      delete candidate.tokenUsage;
    }
  });
  const result = await Promise.race([
    rotationPromise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("rotation waited for provider cleanup")), 200);
    })
  ]);

  assert.equal(result.retirementPromotion, "promoted");
  assert.equal(result.recordMutationState, "committed");
  assert.equal(result.recordMutationId, "context-mutation-ui-fixture");
  assert.ok(result.retirements.every((retirement) =>
    retirement.recordMutationId === result.recordMutationId
  ));
  assert.equal(sessionGeneration(session), 2);
  assert.equal(session.contextId, "context-old");
  assert.equal(session.backendBindings, undefined);
  assert.equal(session.threadId, undefined);
  assert.deepEqual(fixture.calls.slice(0, 6), [
    "journal-stage",
    "register",
    "commit",
    "journal-settle",
    "promote",
    "cleanup"
  ]);
  releaseCleanup();
  await Promise.resolve();
}

async function assertFacadeCommitFailureKeepsLiveStateAndSkipsCleanup(): Promise<void> {
  const fixture = lifecycleFixture({ commitError: new Error("conversation CAS failed") });
  const session = rotationSession();
  const before = clone(session);

  await assert.rejects(
    fixture.rotate(session, {
      reason: "agent-cache-reset",
      advanceContext: false,
      mutate: (candidate) => {
        delete candidate.tokenUsage;
      }
    }),
    /conversation CAS failed/
  );

  assert.deepEqual(session, before);
  assert.deepEqual(fixture.calls, [
    "journal-stage",
    "register",
    "commit",
    "journal-settle",
    "abort"
  ]);
  assert.equal(fixture.cleanupCalls(), 0);
  await fixture.settingsStore.withConversationMutation(session.id, async () => {
    session.title = "lane released after failure";
  });
  assert.equal(session.title, "lane released after failure");
}

async function assertFacadeJournalSettlementFailureBlocksPromotion(): Promise<void> {
  const fixture = lifecycleFixture({
    journalSettleError: new Error("journal terminal unavailable")
  });
  const session = rotationSession();
  const previousCommitId = session.commitId;
  const result = await fixture.rotate(session, {
    reason: "agent-cache-reset",
    advanceContext: false
  });

  assert.equal(result.recordMutationState, "awaiting-recovery");
  assert.equal(result.retirementPromotion, "awaiting-recovery");
  assert.match(result.promotionError ?? "", /Journal terminal is awaiting recovery/);
  assert.notEqual(session.commitId, previousCommitId);
  assert.equal(session.backendBindings, undefined);
  assert.deepEqual(fixture.calls, [
    "journal-stage",
    "register",
    "commit",
    "journal-settle"
  ]);
  assert.equal(fixture.cleanupCalls(), 0);
}

async function assertFacadePromotionFailureKeepsCommittedStateForRecovery(): Promise<void> {
  const fixture = lifecycleFixture({ promotionError: new Error("promotion unavailable") });
  const session = rotationSession();
  const previousCommitId = session.commitId;
  const result = await fixture.rotate(session, {
    reason: "agent-cache-reset",
    advanceContext: false
  });

  assert.equal(result.retirementPromotion, "awaiting-recovery");
  assert.equal(result.promotionError, "promotion unavailable");
  assert.notEqual(session.commitId, previousCommitId);
  assert.equal(session.backendBindings, undefined);
  assert.equal(session.threadId, undefined);
  assert.deepEqual(fixture.calls, [
    "journal-stage",
    "register",
    "commit",
    "journal-settle",
    "promote"
  ]);
  assert.equal(fixture.cleanupCalls(), 0);
}

async function assertResetSessionNativeCacheProductContract(): Promise<void> {
  let releaseCleanup = () => undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const session = rotationSession({
    contextSnapshot: {
      sessionId: "ui-rotation-session",
      contextId: "context-old",
      generation: 2,
      version: "snapshot-old",
      goal: "keep the current context",
      currentState: "cache reset must preserve this state",
      decisions: ["EchoInk owns conversation history"],
      constraints: ["Native executions are disposable"],
      openLoops: [],
      keyReferences: ["old-answer"],
      rollingSummary: "preserved snapshot summary",
      summarizedThroughMessageId: "old-answer",
      sourceMessageCount: 2,
      createdAt: 1,
      updatedAt: 2
    },
    rollingSummary: {
      text: "preserved live summary",
      updatedAt: 2
    }
  });
  session.backendBindings!.opencode = {
    backendId: "opencode",
    nativeSessionId: "opencode-session-old",
    nativeExecutionKind: "session",
    nativeExecutionRef: {
      backendId: "opencode",
      id: "opencode-session-old",
      kind: "session",
      persistence: "provider-persistent",
      providerEndpoint: "http://127.0.0.1:4096",
      deviceKey: "device-test",
      vaultId: "/vault",
      createdAt: 1
    },
    syncedSessionRevision: 2,
    workspaceFingerprint: session.workspaceFingerprint,
    lastUsedAt: 2
  };
  const before = clone(session);
  let durableRegistrationObserved = false;
  const fixture = lifecycleFixture({
    cleanupGate,
    onRegister: (retirements) => {
      assert.deepEqual(
        retirements.map((retirement) => retirement.backendId).sort(),
        ["codex-cli", "opencode"]
      );
      assert.equal(session.threadId, "thread-old");
      assert.deepEqual(session.backendBindings, before.backendBindings);
      assert.equal(session.commitId, before.commitId);
      durableRegistrationObserved = true;
    },
    onCommit: (candidate) => {
      assert.equal(durableRegistrationObserved, true);
      assert.deepEqual(
        session.backendBindings,
        before.backendBindings,
        "the live bindings must stay active until the Conversation commit is durable"
      );
      assert.equal(candidate.backendBindings, undefined);
      assert.equal(candidate.threadId, undefined);
    }
  });
  const host = sessionMenuHost(fixture);

  await Promise.race([
    resetSessionNativeCache(host as never, session),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("Reset Agent cache waited for provider cleanup")),
        200
      );
    })
  ]);

  assert.deepEqual(session.messages, before.messages);
  assert.equal(session.contextId, before.contextId);
  assert.equal(
    session.contextStartsAfterMessageId,
    before.contextStartsAfterMessageId
  );
  assert.equal(session.revision, before.revision);
  assert.equal(session.generation, before.generation);
  assert.equal(session.workspaceFingerprint, before.workspaceFingerprint);
  assert.equal(session.cwd, before.cwd);
  assert.deepEqual(session.contextSnapshot, before.contextSnapshot);
  assert.deepEqual(session.rollingSummary, before.rollingSummary);
  assert.notEqual(
    session.commitId,
    before.commitId,
    "the binding-only commit still needs a fresh durable commit identity"
  );
  assert.equal(session.tokenUsage, undefined);
  assert.equal(session.backendBindings, undefined);
  assert.equal(session.threadId, undefined);
  assert.deepEqual(fixture.calls, [
    "journal-stage",
    "register",
    "commit",
    "journal-settle",
    "promote",
    "cleanup",
    "cleanup"
  ]);
  assert.equal(fixture.cleanupCalls(), 2);
  assert.equal(
    fixture.cleanupCompletionCalls(),
    0,
    "the product action must settle before provider cleanup finishes"
  );

  releaseCleanup();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.cleanupCompletionCalls(), 2);
}

async function assertLegacyCodexThreadConflictFailsBeforeMutation(): Promise<void> {
  const fixture = lifecycleFixture();
  const session = rotationSession();
  session.threadId = "legacy-thread-conflict";
  const before = clone(session);

  await assert.rejects(
    fixture.rotate(session, {
      reason: "agent-cache-reset",
      advanceContext: false
    }),
    /legacy Codex thread conflicts/
  );
  assert.deepEqual(session, before);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.cleanupCalls(), 0);
}

async function assertLegacyPersistentContextBootstrapGate(): Promise<void> {
  const workspace = {
    vaultPath: "/vault",
    cwd: "/vault/workspace-a"
  };
  const legacy = rotationSession({
    revision: 1,
    generation: 1,
    contextId: undefined,
    commitId: undefined,
    workspaceFingerprint: undefined
  });
  const beforeMessages = clone(legacy.messages);
  const fixture = lifecycleFixture();
  fixture.setDurableSession(legacy);
  const result = await ensureEchoInkSessionContextIdentity(
    fixture.harnessService as never,
    fixture.settingsStore as never,
    legacy,
    workspace
  );

  assert.equal(result?.generation, 2);
  assert.match(legacy.contextId ?? "", /^context-/);
  assert.match(legacy.commitId ?? "", /^context-commit-/);
  assert.equal(legacy.workspaceFingerprint, workspaceFingerprint(workspace));
  assert.equal(legacy.contextStartsAfterMessageId, "old-answer");
  assert.deepEqual(legacy.messages, beforeMessages);
  assert.equal(legacy.backendBindings, undefined);
  assert.equal(legacy.threadId, undefined);
  assert.deepEqual(fixture.calls.slice(0, 4), [
    "register",
    "commit",
    "promote",
    "cleanup"
  ]);

  const complete = rotationSession();
  const completeFixture = lifecycleFixture();
  assert.equal(
    await ensureEchoInkSessionContextIdentity(
      completeFixture.harnessService as never,
      completeFixture.settingsStore as never,
      complete,
      workspace
    ),
    null
  );
  assert.deepEqual(completeFixture.calls, []);

  const migratedWorkspacePlaceholder =
    legacyWorkspaceMigrationPlaceholderFingerprint(workspace.cwd);
  const migrated = rotationSession({
    workspaceFingerprint: migratedWorkspacePlaceholder
  });
  migrated.backendBindings!["codex-cli"]!.workspaceFingerprint =
    migratedWorkspacePlaceholder;
  const migratedBeforeMessages = clone(migrated.messages);
  const migratedFixture = lifecycleFixture();
  migratedFixture.setDurableSession(migrated);
  const migratedResult = await ensureEchoInkSessionContextIdentity(
    migratedFixture.harnessService as never,
    migratedFixture.settingsStore as never,
    migrated,
    workspace
  );

  assert.equal(migratedResult?.generation, 3);
  assert.notEqual(migrated.contextId, "context-old");
  assert.notEqual(migrated.commitId, "commit-old");
  assert.equal(migrated.workspaceFingerprint, workspaceFingerprint(workspace));
  assert.equal(migrated.contextStartsAfterMessageId, "old-answer");
  assert.deepEqual(migrated.messages, migratedBeforeMessages);
  assert.equal(migrated.threadId, undefined);
  assert.equal(migrated.backendBindings, undefined);
  assert.deepEqual(migratedFixture.calls, [
    "register",
    "commit",
    "promote",
    "cleanup"
  ]);
  assert.equal(
    await ensureEchoInkSessionContextIdentity(
      migratedFixture.harnessService as never,
      migratedFixture.settingsStore as never,
      migrated,
      workspace
    ),
    null,
    "the migration placeholder must be upgraded exactly once"
  );

  const mismatched = rotationSession({
    contextId: undefined,
    commitId: undefined
  });
  const mismatchFixture = lifecycleFixture();
  await assert.rejects(
    ensureEchoInkSessionContextIdentity(
      mismatchFixture.harnessService as never,
      mismatchFixture.settingsStore as never,
      mismatched,
      { vaultPath: "/vault", cwd: "/vault/workspace-b" }
    ),
    /different workspace/
  );
  assert.deepEqual(mismatchFixture.calls, []);

  const foreignPlaceholder = rotationSession({
    workspaceFingerprint:
      legacyWorkspaceMigrationPlaceholderFingerprint("/vault/workspace-b")
  });
  const foreignPlaceholderFixture = lifecycleFixture();
  await assert.rejects(
    ensureEchoInkSessionContextIdentity(
      foreignPlaceholderFixture.harnessService as never,
      foreignPlaceholderFixture.settingsStore as never,
      foreignPlaceholder,
      workspace
    ),
    /different workspace/
  );
  assert.deepEqual(foreignPlaceholderFixture.calls, []);

  const failed = rotationSession({
    revision: 1,
    generation: 1,
    contextId: undefined,
    commitId: undefined,
    workspaceFingerprint: undefined
  });
  const failedBefore = clone(failed);
  const failedFixture = lifecycleFixture({
    commitError: new Error("legacy bootstrap commit failed")
  });
  failedFixture.setDurableSession(failed);
  await assert.rejects(
    ensureEchoInkSessionContextIdentity(
      failedFixture.harnessService as never,
      failedFixture.settingsStore as never,
      failed,
      workspace
    ),
    /legacy bootstrap commit failed/
  );
  assert.deepEqual(clone(failed), failedBefore);
  assert.deepEqual(failedFixture.calls, ["register", "commit", "abort"]);
  assert.equal(failedFixture.cleanupCalls(), 0);
}

async function assertHistoryRestoreCreatesAVisibleOnlyBoundary(): Promise<void> {
  const fixture = lifecycleFixture();
  const session = rotationSession();
  const restoredMessages: ChatMessage[] = [
    { id: "restored-user", role: "user", text: "旧问题", createdAt: 10 },
    { id: "restored-answer", role: "assistant", text: "旧回答", createdAt: 11 }
  ];
  const host = knowledgeHost(session, fixture, restoredMessages);

  await restoreKnowledgeBaseHistoryDate(host as never, session, "2026-07-18");

  assert.deepEqual(session.messages.map((message) => message.id), [
    "restored-user",
    "restored-answer"
  ]);
  assert.equal(session.contextStartsAfterMessageId, "restored-answer");
  assert.deepEqual(messagesInCurrentSessionContext(session), []);
  session.messages.push({
    id: "new-context-user",
    role: "user",
    text: "恢复后继续",
    createdAt: 12
  });
  assert.deepEqual(
    messagesInCurrentSessionContext(session).map((message) => message.id),
    ["new-context-user"]
  );
  assert.equal(host.renderMessagesCalls(), 1);
  assert.equal(host.resetVirtualWindowCalls(), 1);
}

async function assertHistoryRestoreRejectsActiveRunsBeforeAndAfterRead(): Promise<void> {
  const restoredMessages: ChatMessage[] = [
    { id: "history-user", role: "user", text: "历史问题", createdAt: 10 }
  ];

  let activeReadCalls = 0;
  const activeFixture = lifecycleFixture();
  const activeSession = rotationSession({ kind: "knowledge-base" });
  const activeHost = knowledgeHost(activeSession, activeFixture, restoredMessages, {
    onRead: () => {
      activeReadCalls += 1;
    }
  });
  activeHost.running = true;
  await restoreKnowledgeBaseHistoryDate(
    activeHost as never,
    activeSession,
    "2026-07-18"
  );
  assert.equal(activeReadCalls, 0);
  assert.deepEqual(activeFixture.calls, []);

  let managerReadCalls = 0;
  const managerFixture = lifecycleFixture();
  const managerSession = rotationSession({ kind: "knowledge-base" });
  const managerHost = knowledgeHost(managerSession, managerFixture, restoredMessages, {
    managerRunning: true,
    onRead: () => {
      managerReadCalls += 1;
    }
  });
  await restoreKnowledgeBaseHistoryDate(
    managerHost as never,
    managerSession,
    "2026-07-18"
  );
  assert.equal(managerReadCalls, 0);
  assert.deepEqual(managerFixture.calls, []);

  let duringReadCalls = 0;
  const duringFixture = lifecycleFixture();
  const duringSession = rotationSession({ kind: "knowledge-base" });
  let duringHost: ReturnType<typeof knowledgeHost>;
  duringHost = knowledgeHost(duringSession, duringFixture, restoredMessages, {
    onRead: () => {
      duringReadCalls += 1;
      duringHost.running = true;
    }
  });
  await restoreKnowledgeBaseHistoryDate(
    duringHost as never,
    duringSession,
    "2026-07-18"
  );
  assert.equal(duringReadCalls, 1);
  assert.deepEqual(duringFixture.calls, []);
}

async function assertUiCommitFailuresKeepComposerMessagesAndWorkspaceUnchanged(): Promise<void> {
  const restoredMessages: ChatMessage[] = [
    { id: "history-user", role: "user", text: "历史问题", createdAt: 10 }
  ];
  const clearFixture = lifecycleFixture({ commitError: new Error("clear commit failed") });
  const clearSession = rotationSession({ kind: "knowledge-base" });
  const clearHost = knowledgeHost(clearSession, clearFixture, restoredMessages);
  const clearBefore = clone(clearSession);
  const inputBefore = clearHost.inputEl.value;
  const attachmentsBefore = clone(clearHost.attachments);

  await clearKnowledgeBasePage(clearHost as never, clearSession);
  assert.deepEqual(clearSession, clearBefore);
  assert.equal(clearHost.inputEl.value, inputBefore);
  assert.deepEqual(clearHost.attachments, attachmentsBefore);
  assert.equal(clearHost.closeComposerMenuCalls(), 0);
  assert.equal(clearHost.renderMessagesCalls(), 0);
  assert.equal(clearFixture.cleanupCalls(), 0);

  const historyFixture = lifecycleFixture({ commitError: new Error("history commit failed") });
  const historySession = rotationSession({ kind: "knowledge-base" });
  const historyHost = knowledgeHost(historySession, historyFixture, restoredMessages);
  const historyBefore = clone(historySession);
  await restoreKnowledgeBaseHistoryDate(historyHost as never, historySession, "2026-07-18");
  assert.deepEqual(historySession, historyBefore);
  assert.equal(historyHost.renderMessagesCalls(), 0);
  assert.equal(historyFixture.cleanupCalls(), 0);

  const workspaceFixture = lifecycleFixture({ commitError: new Error("workspace commit failed") });
  const workspaceSession = rotationSession();
  const workspaceHost = chatWorkspaceHost(workspaceFixture);
  const workspaceBefore = clone(workspaceSession);
  await clearChatWorkspace(workspaceHost as never, workspaceSession);
  assert.deepEqual(workspaceSession, workspaceBefore);
  assert.equal(workspaceHost.renderCalls(), 0);
  assert.equal(workspaceFixture.cleanupCalls(), 0);

  const resetFixture = lifecycleFixture({ commitError: new Error("reset commit failed") });
  const resetSession = rotationSession();
  const resetHost = sessionMenuHost(resetFixture);
  const resetBefore = clone(resetSession);
  await resetSessionNativeCache(resetHost as never, resetSession);
  assert.deepEqual(resetSession, resetBefore);
  assert.deepEqual(resetFixture.calls, [
    "journal-stage",
    "register",
    "commit",
    "journal-settle",
    "abort"
  ]);
  assert.equal(resetFixture.cleanupCalls(), 0);
  assert.equal(resetFixture.cleanupCompletionCalls(), 0);
}

async function assertClearPostCommitSaveFailureCannotReverseSuccess(): Promise<void> {
  const fixture = lifecycleFixture();
  const session = rotationSession({ kind: "knowledge-base" });
  const host = knowledgeHost(session, fixture, [], {
    saveError: new Error("post-commit settings projection failed")
  });
  const previousGeneration = sessionGeneration(session);

  await clearKnowledgeBasePage(host as never, session);

  assert.equal(sessionGeneration(session), previousGeneration + 1);
  assert.equal(host.inputEl.value, "");
  assert.deepEqual(host.attachments, []);
  assert.equal(host.closeComposerMenuCalls(), 1);
  assert.equal(host.renderMessagesCalls(), 1);
  assert.equal(host.saveSettingsCalls(), 0);
}

async function assertSettingsStoreRuntimePristineCreateRegistry(): Promise<void> {
  const session: StoredSession = {
    id: "runtime-pristine-chat",
    title: "新会话",
    cwd: "",
    revision: 1,
    generation: 1,
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const plugin = {
    settings: { sessions: [session] },
    getVaultPath: () => "/vault",
    getPluginDataDirName: () => "codex-echoink"
  };
  const settingsStore = new EchoInkSettingsStore(plugin as never);
  let createCalls = 0;
  let stored: StoredSession | null = null;
  let releaseCreate = () => undefined;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const fakeConversationStore = {
    createPristineSession: async (snapshot: StoredSession) => {
      createCalls += 1;
      assert.equal(snapshot.messages.length, 0);
      await createGate;
      stored = clone(snapshot);
    },
    readSession: async (sessionId: string) =>
      stored?.id === sessionId ? clone(stored) : null
  };
  (settingsStore as unknown as {
    getConversationStore(): typeof fakeConversationStore;
  }).getConversationStore = () => fakeConversationStore;

  settingsStore.registerPristineConversationSession(session);
  session.messages.push({
    id: "current-turn",
    role: "user",
    text: "first turn",
    createdAt: 2
  });
  const first = settingsStore.ensureConversationSessionCreated(session);
  const second = settingsStore.ensureConversationSessionCreated(session);
  assert.equal(createCalls, 1);
  releaseCreate();
  await Promise.all([first, second]);
  assert.equal(stored?.messages.length, 0);

  const unregistered: StoredSession = {
    ...clone(session),
    id: "unregistered-missing",
    messages: []
  };
  plugin.settings.sessions.push(unregistered);
  await assert.rejects(
    settingsStore.ensureConversationSessionCreated(unregistered),
    /conversation unregistered-missing is missing/
  );
  assert.equal(createCalls, 1);

  const nonPristine: StoredSession = {
    ...clone(unregistered),
    id: "explicit-non-pristine",
    messages: [{
      id: "legacy-message",
      role: "user",
      text: "already used",
      createdAt: 3
    }]
  };
  plugin.settings.sessions.push(nonPristine);
  assert.throws(
    () => settingsStore.registerPristineConversationSession(nonPristine),
    /not a runtime pristine conversation/
  );
}

async function assertFirstInstallChatIsCreatedBeforeWorkspaceRotation(): Promise<void> {
  const calls: string[] = [];
  const settings = {
    sessions: [] as StoredSession[],
    activeSessionId: "invalid-active-id",
    knowledgeBase: { sessionId: "" }
  };
  const plugin = {
    settings,
    getVaultPath: () => "/vault",
    registerEchoInkPristineConversationSession: (session: StoredSession) => {
      calls.push(`register:${session.kind ?? "chat"}:${session.id}`);
    },
    ensureEchoInkConversationSessionCreated: async (session: StoredSession) => {
      calls.push(`create:${session.id}`);
    },
    rotateEchoInkSessionContext: async (
      session: StoredSession,
      options: EchoInkSessionContextRotationOptions
    ) => {
      calls.push(`rotate:${session.id}:${options.reason}`);
      return {
        committed: true as const,
        conversationId: session.id,
        generation: 2,
        contextId: "context-first-workspace",
        commitId: "commit-first-workspace",
        retirements: [],
        retirementPromotion: "not-required" as const
      };
    }
  };
  const host = {
    plugin,
    createSession: (title?: string) => createSession(host as never, title),
    running: false,
    renderToolbar: () => undefined,
    renderMessages: () => undefined,
    updateInputPlaceholder: () => undefined
  };

  const session = ensureSession(host as never);
  assert.equal(session.kind, undefined);
  assert.equal(settings.activeSessionId, session.id);
  assert.equal(
    settings.sessions.filter((candidate) => candidate.kind === "knowledge-base").length,
    1
  );
  assert.ok(calls.some((call) => call.startsWith("register:knowledge-base:")));
  assert.ok(calls.includes(`register:chat:${session.id}`));

  await commitChatWorkspaceSelection(
    host as never,
    session,
    "/vault/workspace-first"
  );
  assert.ok(
    calls.indexOf(`create:${session.id}`)
      < calls.indexOf(`rotate:${session.id}:workspace-switch`)
  );
}

async function assertPersistentRunPreflightAndEphemeralIsolation(): Promise<void> {
  const session = rotationSession();
  const calls: string[] = [];
  const plugin = lifecycleServicePlugin([session], [], () => undefined, {
    onEnsureCreated: () => calls.push("ensure-created"),
    onEnsureIdentity: () => calls.push("ensure-identity")
  });
  const service = new EchoInkHarnessService(plugin as never);
  let kernelSessionProvider:
    | ((sessionId: string) => StoredSession | null | Promise<StoredSession | null>)
    | undefined;
  (service as unknown as { getHarnessKernel(): unknown }).getHarnessKernel = () => ({
    runWithAdapter: async (input: {
      sessionProvider?: (
        sessionId: string
      ) => StoredSession | null | Promise<StoredSession | null>;
    }) => {
      calls.push("kernel");
      kernelSessionProvider = input.sessionProvider;
      return { runId: "persistent-run", status: "completed" };
    }
  });

  for (const workflow of ["chat.generic", "knowledge.ask"] as const) {
    calls.length = 0;
    await service.runWithAdapter({
      adapter: { manifest: { id: "codex-cli" } } as never,
      sessionProvider: () => session,
      request: persistentHarnessRequest(session, workflow)
    });
    assert.deepEqual(calls, ["ensure-created", "ensure-identity", "kernel"]);
    assert.equal(await kernelSessionProvider?.(session.id), session);
  }

  calls.length = 0;
  await service.runWithAdapter({
    adapter: { manifest: { id: "codex-cli" } } as never,
    request: {
      ...persistentHarnessRequest(session, "knowledge.ask"),
      sessionId: "ephemeral-maintenance",
      workflow: "knowledge.maintain"
    }
  });
  assert.deepEqual(calls, ["kernel"]);

  calls.length = 0;
  await assert.rejects(
    service.runWithAdapter({
      adapter: { manifest: { id: "codex-cli" } } as never,
      sessionProvider: () => clone(session),
      request: persistentHarnessRequest(session, "chat.generic")
    }),
    /authoritative live session/
  );
  assert.deepEqual(calls, []);
}

async function assertHarnessServiceSuppliesDurableReplacementAndLeaseRetirement(): Promise<void> {
  {
    const session = rotationSession();
    const capturedBinding = clone(session.backendBindings!["codex-cli"]!);
    const rotations: EchoInkSessionContextRotationOptions[] = [];
    let callerReplacementCalls = 0;
    const plugin = lifecycleServicePlugin([session], rotations);
    const service = new EchoInkHarnessService(plugin as never);
    (service as unknown as { getHarnessKernel(): unknown }).getHarnessKernel = () => ({
      runWithAdapter: async (input: {
        beforeBindingReplacement?: (replacement: unknown) => Promise<void>;
      }) => {
        await input.beforeBindingReplacement?.({
          request: {
            runId: "replacement-main",
            sessionId: session.id,
            backendId: "codex-cli"
          },
          session,
          binding: capturedBinding,
          reason: "expired",
          expectedIdentity: {
            workspaceFingerprint: session.workspaceFingerprint!,
            sessionGeneration: 2,
            contextId: "context-old"
          }
        });
        return { runId: "replacement-main", status: "completed" };
      }
    });
    const result = await service.runWithAdapter({
      adapter: { manifest: { id: "codex-cli" } } as never,
      request: { runId: "replacement-main" } as never,
      beforeBindingReplacement: async () => {
        callerReplacementCalls += 1;
      }
    });
    assert.equal(result.status, "completed");
    assert.equal(callerReplacementCalls, 0);
    assert.equal(rotations[0]?.reason, "lease-rollover");
    assert.equal(rotations[0]?.advanceContext, false);
    assert.deepEqual(rotations[0]?.retireBackendIds, ["codex-cli"]);
  }

  {
    const session = rotationSession();
    const capturedBinding = clone(session.backendBindings!["codex-cli"]!);
    let rotationCalls = 0;
    const plugin = lifecycleServicePlugin([session], [], () => {
      rotationCalls += 1;
    });
    const service = new EchoInkHarnessService(plugin as never);
    (service as unknown as { getHarnessKernel(): unknown }).getHarnessKernel = () => ({
      runWithAdapter: async (input: {
        beforeBindingReplacement?: (replacement: unknown) => Promise<void>;
      }) => {
        session.backendBindings!["codex-cli"]!.leaseId = "concurrent-lease";
        await input.beforeBindingReplacement?.({
          request: {
            runId: "replacement-race",
            sessionId: session.id,
            backendId: "codex-cli"
          },
          session,
          binding: capturedBinding,
          reason: "expired",
          expectedIdentity: {
            workspaceFingerprint: session.workspaceFingerprint!,
            sessionGeneration: 2,
            contextId: "context-old"
          }
        });
        return { runId: "replacement-race", status: "completed" };
      }
    });
    await assert.rejects(
      service.runWithAdapter({
        adapter: { manifest: { id: "codex-cli" } } as never,
        request: { runId: "replacement-race" } as never
      }),
      /Native binding changed before durable retirement/
    );
    assert.equal(rotationCalls, 0);
    assert.equal(session.backendBindings?.["codex-cli"]?.leaseId, "concurrent-lease");
  }

  {
    const session = rotationSession({ workspaceFingerprint: undefined });
    const capturedBinding = clone(session.backendBindings!["codex-cli"]!);
    let rotationCalls = 0;
    const plugin = lifecycleServicePlugin([session], [], () => {
      rotationCalls += 1;
    });
    const service = new EchoInkHarnessService(plugin as never);
    (service as unknown as { getHarnessKernel(): unknown }).getHarnessKernel = () => ({
      runWithAdapter: async (input: {
        beforeBindingReplacement?: (replacement: unknown) => Promise<void>;
      }) => {
        await input.beforeBindingReplacement?.({
          request: {
            runId: "replacement-missing-workspace",
            sessionId: session.id,
            backendId: "codex-cli"
          },
          session,
          binding: capturedBinding,
          reason: "expired",
          expectedIdentity: {
            workspaceFingerprint: workspaceFingerprint({
              vaultPath: "/vault",
              cwd: "/vault/workspace-a"
            }),
            sessionGeneration: 2,
            contextId: "context-old"
          }
        });
        return { runId: "replacement-missing-workspace", status: "completed" };
      }
    });
    await assert.rejects(
      service.runWithAdapter({
        adapter: { manifest: { id: "codex-cli" } } as never,
        request: { runId: "replacement-missing-workspace" } as never
      }),
      /session identity changed/
    );
    assert.equal(rotationCalls, 0);
  }

  {
    const sessions = [
      leaseSession("lease-session-new", "lease-new", 900),
      leaseSession("lease-session-old", "lease-old", 100)
    ];
    const rotations: EchoInkSessionContextRotationOptions[] = [];
    const plugin = lifecycleServicePlugin(sessions, rotations);
    const service = new EchoInkHarnessService(plugin as never);
    (service as unknown as { nativeSessionLeaseManager: NativeSessionLeaseManager })
      .nativeSessionLeaseManager = new NativeSessionLeaseManager({
        limits: {
          maxActiveLeasesPerSession: 4,
          maxActiveLeasesPerBackend: 1,
          gracePeriodMs: 0
        }
      });
    const results = await service.enforceNativeSessionLeaseLimits();
    assert.equal(results[0]?.outcome, "retirement-scheduled");
    assert.equal(rotations[0]?.reason, "lease-rollover");
    assert.equal(rotations[0]?.advanceContext, false);
    assert.deepEqual(rotations[0]?.retireBackendIds, ["opencode"]);
    assert.equal(sessions[1]?.backendBindings?.opencode, undefined);
  }
}

function assertNewSessionsUseDurablePristineShells(): void {
  const registered: StoredSession[] = [];
  const settings = {
    sessions: [] as StoredSession[],
    activeSessionId: "",
    knowledgeBase: { sessionId: "" }
  };
  const chat = createSession({
    plugin: {
      settings,
      registerEchoInkPristineConversationSession: (session: StoredSession) => {
        registered.push(session);
      }
    },
    createSession: () => {
      throw new Error("unexpected recursive create");
    }
  } as never);
  assert.equal(chat.generation, 1);
  assert.equal(chat.revision, 1);
  assert.equal(chat.contextId, undefined);
  assert.equal(chat.commitId, undefined);
  assert.equal(chat.workspaceFingerprint, undefined);
  assert.deepEqual(registered, [chat]);

  const knowledgeSettings = {
    sessions: [] as StoredSession[],
    activeSessionId: "",
    knowledgeBase: { sessionId: "" }
  };
  const knowledge = ensureKnowledgeBaseSession(
    knowledgeSettings as never,
    "/vault",
    () => "knowledge-new"
  );
  assert.equal(knowledge.generation, 1);
  assert.equal(knowledge.revision, 1);
  assert.match(knowledge.contextId ?? "", /^context-/);
  assert.match(knowledge.commitId ?? "", /^context-commit-/);
  assert.equal(
    knowledge.workspaceFingerprint,
    workspaceFingerprint({ vaultPath: "/vault", cwd: "/vault" })
  );
  assert.equal(
    ensureKnowledgeBaseSession(
      knowledgeSettings as never,
      "/vault-next",
      () => "unexpected-new-knowledge"
    ),
    knowledge
  );
  assert.equal(knowledge.cwd, "/vault");
  assert.equal(
    knowledge.workspaceFingerprint,
    workspaceFingerprint({ vaultPath: "/vault", cwd: "/vault" })
  );
  assert.match(knowledge.workspaceFingerprint ?? "", /^sha256:[a-f0-9]{64}$/);

  const legacy = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "legacy-no-identity",
      title: "Legacy",
      cwd: "/vault",
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }]
  }).settings.sessions[0];
  assert.equal(legacy?.generation, 1);
  assert.equal(legacy?.contextId, undefined);
  assert.equal(legacy?.commitId, undefined);
}

function assertNativeCleanupStatusesNormalizeAndRenderTruthfully(): void {
  const statuses = [
    "awaiting-local-commit",
    "disposing",
    "aborted",
    "quarantined"
  ] as const;
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "cleanup-statuses",
      title: "Cleanup statuses",
      cwd: "/vault",
      messages: statuses.map((status, index) => ({
        id: `cleanup-${index}`,
        role: "assistant",
        text: "",
        nativeCleanupStatus: status,
        createdAt: index + 1
      })),
      createdAt: 1,
      updatedAt: 1
    }]
  }).settings;
  assert.deepEqual(
    settings.sessions[0]?.messages.map((message) => message.nativeCleanupStatus),
    statuses
  );
  assert.deepEqual(
    statuses.map((status) => messageProvenanceMetaItems({
      id: status,
      role: "assistant",
      text: "",
      nativeCleanupStatus: status,
      createdAt: 1
    })[0]),
    [
      "原生记录等待本地提交",
      "原生记录清理中",
      "原生记录清理已中止",
      "原生记录已隔离"
    ]
  );
}

async function assertProductEntrypointsUseTheTypedRotationFacade(): Promise<void> {
  const [mainSource, lifecycleSource, sessionSource, workspaceSource, turnSource] = await Promise.all([
    readFile("src/main.ts", "utf8"),
    readFile("src/plugin/session-context-lifecycle.ts", "utf8"),
    readFile("src/ui/codex-view/session-controller.ts", "utf8"),
    readFile("src/ui/codex-view/workspace-controller.ts", "utf8"),
    readFile("src/ui/codex-view/turn-runner.ts", "utf8")
  ]);
  assert.match(
    mainSource,
    /rotateEchoInkSessionContext\(session:[\s\S]*rotateEchoInkSessionContext\(this\.getHarnessService\(\), this\.getSettingsStore\(\), session, options\)/
  );
  assert.match(
    mainSource,
    /withEchoInkConversationMutation<R>\(conversationId:[\s\S]*getSettingsStore\(\)\.withConversationMutation\(conversationId, action\)/
  );
  assert.match(
    lifecycleSource,
    /precondition\?\.\(\)[\s\S]*rotateSessionContext\(session[\s\S]*settingsStore\.withConversationMutation\([\s\S]*session\.id,[\s\S]*rotate/
  );
  assert.ok(
    lifecycleSource.indexOf("registerNativeExecutionRetirements")
      < lifecycleSource.indexOf("commitConversationSessionContext")
  );
  assert.ok(
    lifecycleSource.indexOf("commitConversationSessionContext")
      < lifecycleSource.indexOf("promoteNativeExecutionRetirements")
  );
  assert.match(
    lifecycleSource,
    /retirementPromotion === "promoted"[\s\S]*void harnessService\.cleanupNativeExecutionRecord\(retirement\.retirementId\)/
  );
  assert.doesNotMatch(
    lifecycleSource,
    /await harnessService\.cleanupNativeExecutionRecord/
  );
  assert.match(sessionSource, /reason: "agent-cache-reset"[\s\S]*advanceContext: false/);
  assert.match(
    sessionSource,
    /renameSession\([\s\S]*withEchoInkConversationMutation\(session\.id,[\s\S]*session\.title = name[\s\S]*saveSettings\(true\)/
  );
  const resetSource = sessionSource.slice(
    sessionSource.indexOf("export async function resetSessionNativeCache"),
    sessionSource.indexOf("export async function renameSession")
  );
  assert.match(resetSource, /precondition:[\s\S]*host\.activeRunSessionId === session\.id/);
  assert.match(sessionSource, /reason: "start-new-context"/);
  const clearKnowledgeSource = sessionSource.slice(
    sessionSource.indexOf("export async function clearKnowledgeBasePage"),
    sessionSource.indexOf("export async function openKnowledgeBaseHistory")
  );
  assert.match(
    clearKnowledgeSource,
    /precondition:[\s\S]*host\.running[\s\S]*getKnowledgeBaseManager\(\)\?\.isRunning/
  );
  const restoreHistorySource = sessionSource.slice(
    sessionSource.indexOf("export async function restoreKnowledgeBaseHistoryDate"),
    sessionSource.indexOf("export function contextRotationCleanupNoticeSuffix")
  );
  assert.match(
    restoreHistorySource,
    /readKnowledgeBaseHistoryDay[\s\S]*if \(host\.running \|\| host\.plugin\.getKnowledgeBaseManager\(\)\?\.isRunning\)[\s\S]*reason: "history-restore"[\s\S]*precondition:/
  );
  assert.match(
    sessionSource,
    /restoredThroughMessageId = messages\.at\(-1\)\?\.id[\s\S]*reason: "history-restore"[\s\S]*contextStartsAfterMessageId: restoredThroughMessageId/
  );
  assert.doesNotMatch(sessionSource, /resetEchoInkSessionNativeCache\(session\)/);
  assert.doesNotMatch(sessionSource, /advanceSessionRevision\(session\)/);
  assert.match(workspaceSource, /reason: "workspace-switch"[\s\S]*workspace:[\s\S]*cwd: workspacePath/);
  assert.match(workspaceSource, /reason: "workspace-clear"[\s\S]*workspace: null/);
  const chooserSource = workspaceSource.slice(
    workspaceSource.indexOf("export async function chooseChatWorkspace"),
    workspaceSource.indexOf("export async function clearChatWorkspace")
  );
  const pickerIndex = chooserSource.indexOf("await pickWorkspaceDirectory");
  assert.ok(pickerIndex >= 0);
  assert.ok(
    chooserSource.indexOf("if (host.running)", pickerIndex) > pickerIndex,
    "workspace running state must be rechecked after the picker returns"
  );
  assert.match(
    workspaceSource,
    /reason: "workspace-switch"[\s\S]*precondition: \(\) => \{[\s\S]*host\.running/
  );
  assert.match(
    workspaceSource,
    /reason: "workspace-clear"[\s\S]*precondition: \(\) => \{[\s\S]*host\.running/
  );
  const chatTurnSource = turnSource.slice(
    turnSource.indexOf("export async function startChatTurn"),
    turnSource.indexOf("export async function startKnowledgeBaseTurn")
  );
  assert.ok(
    chatTurnSource.indexOf(
      "await upgradeLegacyWorkspaceMigrationIdentity(view, session)"
    ) >= 0
  );
  assert.ok(
    chatTurnSource.indexOf(
      "await upgradeLegacyWorkspaceMigrationIdentity(view, session)"
    ) < chatTurnSource.indexOf("session.messages.push(userMessage, assistantMessage)")
  );
  assert.match(
    chatTurnSource,
    /withConversationMutation\(view, session\.id,[\s\S]*session\.messages\.push\(userMessage, assistantMessage\)[\s\S]*view\.running = true[\s\S]*saveSettings\(true\)[\s\S]*prepareChatBackendConnection/
  );
  const knowledgeTurnSource = turnSource.slice(
    turnSource.indexOf("export async function startKnowledgeBaseTurn"),
    turnSource.indexOf("export async function runKnowledgeBaseShortcut")
  );
  assert.match(
    knowledgeTurnSource,
    /command\.intent === "ask"[\s\S]*await upgradeLegacyWorkspaceMigrationIdentity\(view, session\)/
  );
  assert.ok(
    knowledgeTurnSource.indexOf(
      "await upgradeLegacyWorkspaceMigrationIdentity(view, session)"
    ) < knowledgeTurnSource.indexOf("session.messages.push(userMessage, assistantMessage)")
  );
  assert.match(
    knowledgeTurnSource,
    /withConversationMutation\(view, session\.id,[\s\S]*session\.messages\.push\(userMessage, assistantMessage\)[\s\S]*view\.running = true[\s\S]*saveSettings\(true\)[\s\S]*manager\.handleUserMessage/
  );
  const shortcutSource = turnSource.slice(
    turnSource.indexOf("export async function runKnowledgeBaseShortcut"),
    turnSource.indexOf("function appendSettlementFailure")
  );
  assert.match(
    shortcutSource,
    /withConversationMutation\(view, active\.id,[\s\S]*active\.messages\.push\(userMessage, assistantMessage\)[\s\S]*view\.running = true[\s\S]*saveSettings\(true\)/
  );
  assert.match(
    turnSource,
    /function withConversationMutation<T>[\s\S]*view\.plugin\.withEchoInkConversationMutation\([\s\S]*conversationId,[\s\S]*action/
  );
  const cleanupPriority = [
    "\"quarantined\"",
    "\"failed\"",
    "\"retained-for-recovery\"",
    "\"disposing\"",
    "\"awaiting-local-commit\"",
    "\"pending\"",
    "\"aborted\"",
    "\"unsupported\"",
    "\"retained\"",
    "\"disposed\"",
    "\"not-needed\""
  ];
  const prioritySource = turnSource.slice(
    turnSource.indexOf("function dominantNativeCleanupStatus")
  );
  for (let index = 1; index < cleanupPriority.length; index += 1) {
    assert.ok(
      prioritySource.indexOf(cleanupPriority[index - 1])
        < prioritySource.indexOf(cleanupPriority[index]),
      `${cleanupPriority[index - 1]} must outrank ${cleanupPriority[index]}`
    );
  }
}

function lifecycleFixture(options: {
  commitError?: Error;
  commitGate?: Promise<void>;
  promotionError?: Error;
  journalSettleError?: Error;
  cleanupGate?: Promise<void>;
  onRegister?: (retirements: readonly SessionContextRetirement[]) => void;
  onCommit?: (session: StoredSession) => void;
} = {}) {
  const calls: string[] = [];
  const mutationLane = new ConversationMutationLane();
  let cleanupCalls = 0;
  let cleanupCompletionCalls = 0;
  let conversationCommitted = false;
  let durableSession: StoredSession | null = null;
  const harnessService = {
    async registerNativeExecutionRetirements(
      retirements: readonly SessionContextRetirement[]
    ): Promise<void> {
      calls.push("register");
      options.onRegister?.(retirements);
    },
    async promoteNativeExecutionRetirements(): Promise<void> {
      calls.push("promote");
      if (options.promotionError) throw options.promotionError;
    },
    async abortNativeExecutionRetirements(): Promise<void> {
      calls.push("abort");
    },
    async cleanupNativeExecutionRecord(recordId: string): Promise<NativeCleanupResult> {
      calls.push("cleanup");
      cleanupCalls += 1;
      await options.cleanupGate;
      cleanupCompletionCalls += 1;
      return { recordId, cleanup: "disposed", attempted: true };
    }
  };
  const settingsStore = {
    async readConversationSession(): Promise<StoredSession | null> {
      return durableSession ? structuredClone(durableSession) : null;
    },
    async withConversationMutation<T>(
      conversationId: string,
      action: (authority: ConversationMutationAuthority) => Promise<T>
    ): Promise<T> {
      return await mutationLane.withConversationMutation(conversationId, action);
    },
    async stageSessionContextRecordMutation() {
      calls.push("journal-stage");
      return { mutationId: "context-mutation-ui-fixture" };
    },
    async settleSessionContextRecordMutation() {
      calls.push("journal-settle");
      if (options.journalSettleError) throw options.journalSettleError;
      return conversationCommitted ? "committed" as const : "aborted" as const;
    },
    async commitConversationSessionContext(session: StoredSession) {
      calls.push("commit");
      options.onCommit?.(session);
      await options.commitGate;
      if (options.commitError) throw options.commitError;
      conversationCommitted = true;
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
  };
  return {
    calls,
    cleanupCalls: () => cleanupCalls,
    cleanupCompletionCalls: () => cleanupCompletionCalls,
    harnessService,
    settingsStore,
    setDurableSession(session: StoredSession) {
      durableSession = structuredClone(session);
    },
    rotate: async (
      session: StoredSession,
      rotationOptions: EchoInkSessionContextRotationOptions
    ) => {
      durableSession = structuredClone(session);
      return await rotateEchoInkSessionContext(
        harnessService as never,
        settingsStore as never,
        session,
        rotationOptions
      );
    }
  };
}

function rotationSession(
  overrides: Partial<StoredSession> = {}
): StoredSession {
  const fingerprint = workspaceFingerprint({
    vaultPath: "/vault",
    cwd: "/vault/workspace-a"
  });
  return {
    id: "ui-rotation-session",
    title: "UI rotation",
    cwd: "/vault/workspace-a",
    revision: 2,
    generation: 2,
    contextId: "context-old",
    commitId: "commit-old",
    workspaceFingerprint: fingerprint,
    contextStartsAfterMessageId: "old-answer",
    threadId: "thread-old",
    backendBindings: {
      "codex-cli": {
        backendId: "codex-cli",
        nativeThreadId: "thread-old",
        nativeExecutionKind: "thread",
        nativeExecutionRef: {
          backendId: "codex-cli",
          id: "thread-old",
          kind: "thread",
          persistence: "provider-persistent",
          deviceKey: "device-test",
          vaultId: "/vault",
          createdAt: 1
        },
        syncedSessionRevision: 2,
        sessionGeneration: 2,
        contextId: "context-old",
        workspaceFingerprint: fingerprint,
        lastUsedAt: 2
      }
    },
    messages: [
      { id: "old-user", role: "user", text: "旧问题", createdAt: 1 },
      { id: "old-answer", role: "assistant", text: "旧回答", createdAt: 2 }
    ],
    tokenUsage: { totalTokens: 20, inputTokens: 10, outputTokens: 10 },
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

function knowledgeHost(
  session: StoredSession,
  fixture: ReturnType<typeof lifecycleFixture>,
  restoredMessages: ChatMessage[],
  options: {
    managerRunning?: boolean;
    onRead?: () => void;
    saveError?: Error;
  } = {}
) {
  let renderMessagesCalls = 0;
  let resetVirtualWindowCalls = 0;
  let closeComposerMenuCalls = 0;
  let saveSettingsCalls = 0;
  return {
    plugin: {
      settings: { sessions: [session] },
      getVaultPath: () => "/vault",
      getKnowledgeBaseManager: () => options.managerRunning
        ? { isRunning: true }
        : null,
      rotateEchoInkSessionContext: fixture.rotate,
      saveSettings: async () => {
        saveSettingsCalls += 1;
        if (options.saveError) throw options.saveError;
      },
      readKnowledgeBaseHistoryDay: async () => {
        options.onRead?.();
        return clone(restoredMessages);
      }
    },
    running: false,
    activeRunSessionId: "",
    inputEl: { value: "/clear" },
    attachments: [{ type: "file", name: "draft.md", path: "draft.md" }],
    selectedSkill: { id: "test-skill" },
    isKnowledgeBaseSession: () => true,
    resetVirtualWindow: () => { resetVirtualWindowCalls += 1; },
    renderMessages: () => { renderMessagesCalls += 1; },
    renderTabs: () => undefined,
    renderToolbar: () => undefined,
    updateInputPlaceholder: () => undefined,
    closeComposerMenus: () => { closeComposerMenuCalls += 1; },
    renderKnowledgeDashboard: () => undefined,
    refreshKnowledgeDashboard: async () => undefined,
    renderMessagesCalls: () => renderMessagesCalls,
    resetVirtualWindowCalls: () => resetVirtualWindowCalls,
    closeComposerMenuCalls: () => closeComposerMenuCalls,
    saveSettingsCalls: () => saveSettingsCalls
  };
}

function chatWorkspaceHost(fixture: ReturnType<typeof lifecycleFixture>) {
  let renderCalls = 0;
  return {
    plugin: {
      getVaultPath: () => "/vault",
      rotateEchoInkSessionContext: fixture.rotate
    },
    running: false,
    renderToolbar: () => { renderCalls += 1; },
    renderMessages: () => { renderCalls += 1; },
    updateInputPlaceholder: () => { renderCalls += 1; },
    renderCalls: () => renderCalls
  };
}

function sessionMenuHost(fixture: ReturnType<typeof lifecycleFixture>) {
  return {
    plugin: {
      rotateEchoInkSessionContext: fixture.rotate
    },
    running: false,
    activeRunSessionId: ""
  };
}

function lifecycleServicePlugin(
  sessions: StoredSession[],
  rotations: EchoInkSessionContextRotationOptions[],
  onRotate: () => void = () => undefined,
  hooks: {
    onEnsureCreated?: (session: StoredSession) => void;
    onEnsureIdentity?: (session: StoredSession) => void;
  } = {}
) {
  return {
    settings: {
      sessions
    },
    agentRuntimeHealth: {
      reportHealthy: () => undefined,
      reportFailure: () => undefined
    },
    ensureEchoInkConversationSessionCreated: async (session: StoredSession) => {
      hooks.onEnsureCreated?.(session);
    },
    ensureEchoInkSessionContextIdentity: async (session: StoredSession) => {
      hooks.onEnsureIdentity?.(session);
      return null;
    },
    rotateEchoInkSessionContext: async (
      session: StoredSession,
      options: EchoInkSessionContextRotationOptions
    ) => {
      onRotate();
      rotations.push(options);
      const backendIds = options.retireBackendIds ?? Object.keys(session.backendBindings ?? {});
      for (const backendId of backendIds) {
        if (session.backendBindings) delete session.backendBindings[backendId];
        if (backendId === "codex-cli") delete session.threadId;
      }
      if (session.backendBindings && !Object.keys(session.backendBindings).length) {
        delete session.backendBindings;
      }
      return {
        committed: true as const,
        conversationId: session.id,
        generation: sessionGeneration(session),
        ...(session.contextId ? { contextId: session.contextId } : {}),
        commitId: session.commitId ?? "commit-test",
        retirements: [],
        retirementPromotion: "not-required" as const
      };
    }
  };
}

function leaseSession(
  id: string,
  leaseId: string,
  lastUsedAt: number
): StoredSession {
  const fingerprint = workspaceFingerprint({
    vaultPath: "/vault",
    cwd: "/vault/workspace-a"
  });
  return {
    id,
    title: id,
    cwd: "/vault/workspace-a",
    revision: 1,
    generation: 1,
    contextId: `context-${id}`,
    commitId: `commit-${id}`,
    workspaceFingerprint: fingerprint,
    backendBindings: {
      opencode: {
        backendId: "opencode",
        nativeSessionId: `native-${id}`,
        nativeExecutionKind: "session",
        nativeExecutionRef: {
          backendId: "opencode",
          id: `native-${id}`,
          kind: "session",
          persistence: "provider-persistent",
          providerEndpoint: "http://127.0.0.1:4096",
          deviceKey: "device-test",
          vaultId: "/vault",
          createdAt: 1
        },
        leaseId,
        leaseStatus: "active",
        leaseCreatedAt: 1,
        leaseLastUsedAt: lastUsedAt,
        leaseExpiresAt: 10_000,
        leaseTurnCount: 1,
        leaseMaxTurns: 20,
        syncedSessionRevision: 1,
        sessionGeneration: 1,
        contextId: `context-${id}`,
        workspaceFingerprint: fingerprint,
        lastUsedAt
      }
    },
    messages: [],
    createdAt: 1,
    updatedAt: lastUsedAt
  };
}

function persistentHarnessRequest(
  session: StoredSession,
  workflow: "chat.generic" | "knowledge.ask"
) {
  return {
    runId: `run-${workflow}`,
    sessionId: session.id,
    surface: workflow === "chat.generic" ? "chat" as const : "knowledge" as const,
    workflow,
    backendId: "codex-cli",
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    },
    input: {
      text: "test",
      attachments: []
    },
    permissions: {
      mode: "workspace-write" as const,
      writableRoots: ["/vault"],
      requireApproval: true
    },
    resourceSelection: {
      selected: [],
      resolvedAt: 1,
      warnings: []
    },
    memoryPolicy: {
      enabled: false,
      maxItems: 0
    },
    outputContract: {
      kind: "plain-text" as const
    }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
