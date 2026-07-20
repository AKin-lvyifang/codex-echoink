import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pluginDataDir } from "../../core/raw-message-store";
import {
  createConversationDeletionTombstone,
  createConversationContentRevision,
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import { compileContextBundle } from "../../harness/kernel/context-compiler";
import {
  sessionGeneration,
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import {
  createRecordMutationExecutionPlan,
  recordMutationExecutionBundleParticipantId,
  type RecordMutationExecutionParticipant
} from "../../harness/lifecycle/record-mutation-execution-plan";
import {
  materializeRecordMutationExecution
} from "../../harness/lifecycle/record-mutation-execution-runtime";
import {
  createRecordMutationJournal
} from "../../harness/lifecycle/record-mutation-journal";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  prepareEchoInkRecordMutationRuntimeRoots
} from "../../harness/lifecycle/record-mutation-production";
import { rotateEchoInkSessionContext } from "../../plugin/session-context-lifecycle";
import { EchoInkSettingsStore } from "../../plugin/settings-store";
import {
  normalizeSettingsData,
  type CodexForObsidianSettings,
  type StoredSession
} from "../../settings/settings";
import { clearKnowledgeBasePage } from "../../ui/codex-view/session-controller";

export async function runHarnessV2ConversationStoreTests(): Promise<void> {
  await assertConversationStoreRequiresExplicitWorkspaceFreeChatCreate();
  await assertConversationStoreRejectsUnsafeSessionPaths();
  await assertConversationStoreRejectsSymlinkedStoragePaths();
  await assertPristineCreateRecoversOnlyFromVerifiedCommittedDirectory();
  await assertStartupReconciliationReturnsDurableSessionsMissingFromDataShell();
  await assertStartupReconciliationFailsClosedOnAmbiguousEvidence();
  await assertIncompleteContextCannotMutatePayload();
  await assertOrdinaryUpsertUsesDetachedPayloadRevision();
  await assertLegacyCommitAddressedPayloadUpgradesToV2();
  await assertSnapshotRefreshesWhenMessageContentChanges();
  await assertConversationStorePersistsChatAndKnowledgeSessions();
  await assertConversationNativeTransportRoundTripAndValidation();
  await assertConversationStoreCanTrimMigratedSettingsMessages();
  await assertConversationStoreDeletesSessionAndIndexEntry();
  await assertConversationRecordClearRetainsSourcesForJournalRetirement();
  await assertConversationDeletionTombstoneSurvivesIndexCrash();
  await assertSettingsStoreMigratesAndRestoresConversationHistory();
  await assertSettingsStoreRecoversDurableConversationMissingDataShell();
  await assertClearSurvivesRestartAndExcludesOldContext();
  await assertContextRotationRecordMutationRecoversCrashWindows();
  await assertDestructiveRecordMutationRebuildsParticipantsAtStartup();
  await assertDestructiveRetainProofReplaysAfterTargetDeletion();
  await assertSettingsStoreBlocksUnmigratedLegacyConversation();
  await assertConversationStoreParticipatesInDurableCommit();
}

async function assertContextRotationRecordMutationRecoversCrashWindows(): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-context-record-mutation-")
  );
  const sessionId = "context-record-mutation";
  const initialSession: StoredSession = {
    id: sessionId,
    title: "Context RecordMutation",
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: "context-record-mutation-1",
    commitId: "commit-record-mutation-1",
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages: [{
      id: "message-record-mutation",
      role: "user",
      text: "durable history",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 2
  };
  let persisted: unknown = {
    settingsVersion: 29,
    sessions: [initialSession]
  };
  try {
    const seedStore = new FileConversationStore({
      rootPath: path.join(
        pluginDataDir(vaultPath, "codex-echoink"),
        "conversations"
      )
    });
    await createPristineSettingsSessions(seedStore, [initialSession]);
    await seedStore.persistSettingsSessions({ sessions: [initialSession] });
    const plugin = fakeSettingsPlugin(
      vaultPath,
      () => persisted,
      (next) => { persisted = next; }
    );
    const store = new EchoInkSettingsStore(plugin as never);
    await store.loadSettings();
    const live = plugin.settings.sessions.find(
      (candidate) => candidate.id === sessionId
    );
    assert.ok(live);

    const beforeTarget = structuredClone(live);
    beforeTarget.commitId = "commit-record-mutation-before-target";
    beforeTarget.updatedAt += 1;
    const beforeReceipt = await store.withConversationMutation(
      live.id,
      async () => await store.stageSessionContextRecordMutation({
        reason: "agent-cache-reset",
        session: beforeTarget,
        expectedGeneration: sessionGeneration(live),
        expectedCommitId: live.commitId,
        expectedContentRevision: createConversationContentRevision(live),
        targetGeneration: sessionGeneration(beforeTarget),
        targetCommitId: beforeTarget.commitId
      })
    );
    assert.equal(
      await store.reconcileSessionContextRecordMutationsAtStartup(),
      1
    );
    assert.equal(
      (await store.readRecordMutationAuthority(beforeReceipt.mutationId)).state,
      "aborted",
      "crash after Journal stage but before Conversation commit must abort"
    );

    const exactTarget = structuredClone(live);
    exactTarget.commitId = "commit-record-mutation-exact-target";
    exactTarget.updatedAt += 2;
    const exactReceipt = await store.withConversationMutation(
      live.id,
      async () => {
        const receipt = await store.stageSessionContextRecordMutation({
          reason: "agent-cache-reset",
          session: exactTarget,
          expectedGeneration: sessionGeneration(live),
          expectedCommitId: live.commitId,
          expectedContentRevision: createConversationContentRevision(live),
          targetGeneration: sessionGeneration(exactTarget),
          targetCommitId: exactTarget.commitId
        });
        await store.commitConversationSessionContext(exactTarget, {
          expectedGeneration: sessionGeneration(live),
          expectedCommitId: live.commitId,
          expectedContentRevision: createConversationContentRevision(live)
        });
        return receipt;
      }
    );
    assert.equal(
      await store.reconcileSessionContextRecordMutationsAtStartup(),
      1
    );
    assert.equal(
      (await store.readRecordMutationAuthority(exactReceipt.mutationId)).state,
      "committed",
      "crash after Conversation commit but before Journal terminal must roll forward"
    );
    assert.equal(
      await store.reconcileSessionContextRecordMutationsAtStartup(),
      0,
      "terminal Journal recovery must be idempotent"
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertDestructiveRecordMutationRebuildsParticipantsAtStartup():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-destructive-record-mutation-startup-")
  );
  const sessionId = "destructive-record-mutation-startup";
  const source: StoredSession = {
    id: sessionId,
    title: "Destructive RecordMutation",
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: "context-destructive-record-mutation",
    commitId: "commit-destructive-record-mutation",
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages: [{
      id: "message-destructive-record-mutation",
      role: "user",
      text: "durable history",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 2
  };
  let persisted: unknown = {
    settingsVersion: 29,
    sessions: [source]
  };
  try {
    const storageRootPath = pluginDataDir(vaultPath, "codex-echoink");
    const conversationRootPath = path.join(
      storageRootPath,
      "conversations"
    );
    const seedStore = new FileConversationStore({
      rootPath: conversationRootPath
    });
    await createPristineSettingsSessions(seedStore, [source]);
    await seedStore.persistSettingsSessions({ sessions: [source] });
    const current = await seedStore.readSession(sessionId);
    assert.ok(current);
    const roots = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath,
      pluginDir: "codex-echoink",
      rootIds: [
        ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation,
        ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
      ],
      createdAt: 100
    });
    const conversationBinding = roots.roots.find(
      (root) =>
        root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation
    );
    const trashBinding = roots.roots.find(
      (root) => root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
    );
    assert.ok(conversationBinding);
    assert.ok(trashBinding);
    const mutationId = "destructive-startup-recovery";
    const tombstone = createConversationDeletionTombstone({
      conversationId: current.id,
      mutationId,
      tombstoneId: "tombstone-destructive-startup-recovery",
      sourceGeneration: sessionGeneration(current),
      sourceCommitId: current.commitId!,
      sourceContentRevision: createConversationContentRevision(current),
      deletedAt: 101
    });
    const journal = await createRecordMutationJournal({
      storageRootPath,
      mutationId,
      intent: {
        operation: "delete-conversation",
        conversationId: current.id,
        expectedConversationGeneration: sessionGeneration(current),
        expectedConversationCommitId: current.commitId!,
        expectedConversationContentRevision:
          createConversationContentRevision(current),
        targetConversation: {
          status: "deleted",
          tombstoneId: tombstone.tombstoneId,
          digest: tombstone.digest
        },
        participants: [{
          id: "conversation-session",
          recordKind: "conversation",
          action: "stage"
        }],
        rootBindings: roots.roots.map((root) => root.rootBinding),
        trashPolicy: "required"
      },
      createdAt: 102
    });
    await createRecordMutationExecutionPlan({
      journal,
      participants: [{
        participantId: "conversation-session",
        recordKind: "conversation",
        action: "stage",
        execution: {
          kind: "trash",
          sourceRootId:
            ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation,
          trashRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.trash,
          sourceRelativePath: `sessions/${sessionId}`
        }
      }],
      createdAt: 103
    });
    await seedStore.commitConversationDeletionTombstone(tombstone, {
      expectedGeneration: sessionGeneration(current),
      expectedCommitId: current.commitId!,
      expectedContentRevision: createConversationContentRevision(current)
    });

    const plugin = fakeSettingsPlugin(
      vaultPath,
      () => persisted,
      (next) => { persisted = next; }
    );
    const settingsStore = new EchoInkSettingsStore(plugin as never);
    await settingsStore.loadSettings();
    assert.equal(
      plugin.settings.sessions.some((session) => session.id === sessionId),
      false,
      "deletion tombstone must remove the stale data shell before recovery"
    );
    assert.equal(
      await settingsStore.reconcileSessionContextRecordMutationsAtStartup(),
      1
    );
    assert.equal(
      (await settingsStore.readRecordMutationAuthority(mutationId)).state,
      "committed"
    );
    await assert.rejects(
      readdir(path.join(conversationRootPath, "sessions", sessionId)),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: string }).code === "ENOENT"
      )
    );
    assert.equal(
      await settingsStore.reconcileSessionContextRecordMutationsAtStartup(),
      0
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertDestructiveRetainProofReplaysAfterTargetDeletion():
Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-destructive-retain-startup-")
  );
  const sessionId = "destructive-retain-startup";
  const source: StoredSession = {
    id: sessionId,
    title: "Destructive Retain Recovery",
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: "context-destructive-retain",
    commitId: "commit-destructive-retain",
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages: [{
      id: "message-destructive-retain",
      role: "user",
      text: "durable history",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 2
  };
  let persisted: unknown = {
    settingsVersion: 29,
    sessions: [source]
  };
  try {
    const storageRootPath = pluginDataDir(vaultPath, "codex-echoink");
    const conversationRootPath = path.join(
      storageRootPath,
      "conversations"
    );
    const seedStore = new FileConversationStore({
      rootPath: conversationRootPath
    });
    await createPristineSettingsSessions(seedStore, [source]);
    await seedStore.persistSettingsSessions({ sessions: [source] });
    const current = await seedStore.readSession(sessionId);
    assert.ok(current);
    const roots = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath,
      pluginDir: "codex-echoink",
      rootIds: [
        ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation,
        ECHOINK_RECORD_MUTATION_ROOT_IDS.trash,
        ECHOINK_RECORD_MUTATION_ROOT_IDS.run
      ],
      createdAt: 200
    });
    const selectionDigest = `sha256:${"a".repeat(64)}`;
    const retainExecution = {
      kind: "retain-bundle" as const,
      rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
      selectionDigest,
      subjects: [{
        kind: "attempt-payload-not-captured" as const,
        workflowRunId: "workflow-retained-at-startup",
        attemptId: "attempt-retained-at-startup",
        reasonCode: "capture-disabled" as const
      }]
    };
    const trashExecution = {
      kind: "trash-bundle" as const,
      sourceRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.conversation,
      trashRootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.trash,
      selectionDigest,
      items: [{
        itemId: "conversation-session",
        sourceRelativePath: `sessions/${sessionId}`
      }]
    };
    const participants: RecordMutationExecutionParticipant[] = [
      {
        participantId: recordMutationExecutionBundleParticipantId({
          recordKind: "workflow-run",
          action: "retain",
          execution: retainExecution
        }),
        recordKind: "workflow-run",
        action: "retain",
        execution: retainExecution
      },
      {
        participantId: recordMutationExecutionBundleParticipantId({
          recordKind: "conversation",
          action: "stage",
          execution: trashExecution
        }),
        recordKind: "conversation",
        action: "stage",
        execution: trashExecution
      }
    ].sort((left, right) => (
      left.participantId.localeCompare(right.participantId)
    ));
    const mutationId = "destructive-retain-startup-recovery";
    const tombstone = createConversationDeletionTombstone({
      conversationId: current.id,
      mutationId,
      tombstoneId: "tombstone-destructive-retain-startup",
      sourceGeneration: sessionGeneration(current),
      sourceCommitId: current.commitId!,
      sourceContentRevision: createConversationContentRevision(current),
      deletedAt: 201
    });
    const journal = await createRecordMutationJournal({
      storageRootPath,
      mutationId,
      intent: {
        operation: "delete-conversation",
        conversationId: current.id,
        expectedConversationGeneration: sessionGeneration(current),
        expectedConversationCommitId: current.commitId!,
        expectedConversationContentRevision:
          createConversationContentRevision(current),
        targetConversation: {
          status: "deleted",
          tombstoneId: tombstone.tombstoneId,
          digest: tombstone.digest
        },
        participants: participants.map((participant) => ({
          id: participant.participantId,
          recordKind: participant.recordKind,
          action: participant.action
        })),
        rootBindings: roots.roots.map((root) => root.rootBinding),
        trashPolicy: "required"
      },
      createdAt: 202
    });
    const plan = await createRecordMutationExecutionPlan({
      journal,
      participants,
      createdAt: 203
    });
    let now = 203;
    let verificationCalls = 0;
    const materialized = await materializeRecordMutationExecution({
      journal,
      plan,
      roots: roots.roots,
      verifyFrozenSelection: async () => {
        verificationCalls += 1;
      },
      now: () => {
        now += 1;
        return now;
      }
    });
    assert.equal(verificationCalls, 1);
    assert.equal(materialized.journal.record.state, "staged");
    await seedStore.commitConversationDeletionTombstone(tombstone, {
      expectedGeneration: sessionGeneration(current),
      expectedCommitId: current.commitId!,
      expectedContentRevision: createConversationContentRevision(current)
    });

    const plugin = fakeSettingsPlugin(
      vaultPath,
      () => persisted,
      (next) => { persisted = next; }
    );
    const settingsStore = new EchoInkSettingsStore(plugin as never);
    await settingsStore.loadSettings();
    assert.equal(
      plugin.settings.sessions.some((session) => session.id === sessionId),
      false,
      "deleted target must be absent before startup recovery"
    );
    assert.equal(
      await settingsStore.reconcileSessionContextRecordMutationsAtStartup(),
      1,
      "startup must reuse durable retain proof without re-inventorying the deleted target"
    );
    assert.equal(
      (await settingsStore.readRecordMutationAuthority(mutationId)).state,
      "committed"
    );
    await assert.rejects(
      readdir(path.join(conversationRootPath, "sessions", sessionId)),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: string }).code === "ENOENT"
      )
    );
    assert.equal(
      await settingsStore.reconcileSessionContextRecordMutationsAtStartup(),
      0
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertConversationStoreRejectsUnsafeSessionPaths(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-unsafe-id-"));
  const store = new FileConversationStore({ rootPath });
  const safeSession: StoredSession = {
    id: "safe-session",
    title: "Safe",
    revision: 1,
    generation: 1,
    cwd: "",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  await store.createPristineSession(safeSession);

  const collidingPrefix = "x".repeat(120);
  const unsafeIds = [
    ".",
    "..",
    "../",
    "a/b",
    "a\\b",
    "a?b",
    `${collidingPrefix}a`,
    `${collidingPrefix}b`
  ];
  for (const id of unsafeIds) {
    await assert.rejects(
      store.createPristineSession({ ...safeSession, id }),
      /Conversation session ID is unsafe for durable storage/,
      `unsafe session ID must fail closed before touching durable storage: ${id}`
    );
  }
  await assert.rejects(
    store.deleteSession("."),
    /Conversation session ID is unsafe for durable storage/,
    "delete must never resolve a dot segment to the sessions root"
  );
  await assert.rejects(
    store.readSession(".."),
    /Conversation session ID is unsafe for durable storage/,
    "read must never resolve a dot segment to the Conversation Store root"
  );

  const safeMetadataPath = path.join(
    rootPath,
    "sessions",
    safeSession.id,
    "metadata.json"
  );
  const safeMetadataText = await readFile(safeMetadataPath, "utf8");
  await writeFile(safeMetadataPath, JSON.stringify({
    ...JSON.parse(safeMetadataText) as Record<string, unknown>,
    id: "different-session"
  }), "utf8");
  await assert.rejects(
    store.deleteSession(safeSession.id),
    /metadata identity or core fields are invalid/,
    "delete must recheck metadata ownership before removing a session directory"
  );
  assert.deepEqual(
    (await store.readIndex()).sessions.map((session) => session.sessionId),
    [safeSession.id],
    "an ownership mismatch must not remove the indexed conversation"
  );
  await writeFile(safeMetadataPath, safeMetadataText, "utf8");

  assert.equal((await store.readSession(safeSession.id))?.id, safeSession.id);
  assert.deepEqual(
    (await store.readIndex()).sessions.map((session) => session.sessionId),
    [safeSession.id],
    "rejected IDs must not mutate the normal session or Conversation index"
  );
}

async function assertConversationStoreRejectsSymlinkedStoragePaths(): Promise<void> {
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "echoink-conversations-outside-"));
  const proxyRoot = await mkdtemp(path.join(tmpdir(), "echoink-conversations-symlink-root-"));
  const session: StoredSession = {
    id: "symlink-session",
    title: "Symlink",
    revision: 1,
    generation: 1,
    cwd: "",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const outsideStore = new FileConversationStore({ rootPath: outsideRoot });
  await outsideStore.createPristineSession(session);
  await symlink(
    path.join(outsideRoot, "sessions"),
    path.join(proxyRoot, "sessions"),
    "dir"
  );
  await writeFile(
    path.join(proxyRoot, "index.json"),
    await readFile(path.join(outsideRoot, "index.json"), "utf8"),
    "utf8"
  );
  const proxyStore = new FileConversationStore({ rootPath: proxyRoot });
  await assert.rejects(
    proxyStore.readSession(session.id),
    /must not be a symlink or non-directory/,
    "an intermediate sessions symlink must fail before a durable read"
  );
  await assert.rejects(
    proxyStore.deleteSession(session.id),
    /must not be a symlink or non-directory/,
    "delete must never follow an intermediate sessions symlink"
  );
  assert.equal((await outsideStore.readSession(session.id))?.id, session.id);

  const payloadRoot = await mkdtemp(path.join(tmpdir(), "echoink-conversations-payload-link-"));
  const payloadOutside = await mkdtemp(path.join(tmpdir(), "echoink-conversations-payload-outside-"));
  const payloadStore = new FileConversationStore({ rootPath: payloadRoot });
  const payloadSession: StoredSession = {
    id: "payload-symlink-session",
    title: "Payload symlink",
    cwd: "/vault",
    ...workspaceBoundIdentity("payload-symlink-session"),
    messages: [
      { id: "payload-link-message", role: "user", text: "safe", createdAt: 1 }
    ],
    createdAt: 1,
    updatedAt: 1
  };
  await createPristineSettingsSessions(payloadStore, [payloadSession]);
  await payloadStore.upsertSession(payloadSession);
  const contextPayloadsPath = path.join(
    payloadRoot,
    "sessions",
    payloadSession.id,
    "context-payloads"
  );
  await rm(contextPayloadsPath, { recursive: true, force: true });
  await symlink(payloadOutside, contextPayloadsPath, "dir");
  await assert.rejects(
    payloadStore.readSession(payloadSession.id),
    /must not be a symlink or non-directory/,
    "active payload reads must reject a context-payloads symlink"
  );
  assert.deepEqual(
    await readdir(payloadOutside),
    [],
    "a rejected payload symlink must not write outside the Conversation Store"
  );
}

async function assertPristineCreateRecoversOnlyFromVerifiedCommittedDirectory(): Promise<void> {
  const beforeMarkerRoot = await mkdtemp(path.join(tmpdir(), "echoink-pristine-before-marker-"));
  let failBeforeMarker = true;
  const beforeMarkerStore = new FileConversationStore({
    rootPath: beforeMarkerRoot,
    beforeContextCommitMarker: () => {
      if (failBeforeMarker) throw new Error("fault before pristine directory commit");
    }
  });
  const candidate: StoredSession = {
    id: "pristine-fault",
    title: "Pristine fault",
    revision: 1,
    generation: 1,
    cwd: "",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  await assert.rejects(
    beforeMarkerStore.createPristineSession(candidate),
    /fault before pristine directory commit/
  );
  assert.equal(
    await beforeMarkerStore.readSession(candidate.id),
    null,
    "a pre-rename fault must not expose a half-created session directory"
  );
  failBeforeMarker = false;
  await beforeMarkerStore.createPristineSession(candidate);
  assert.equal((await beforeMarkerStore.readSession(candidate.id))?.id, candidate.id);

  const afterRenameRoot = await mkdtemp(path.join(tmpdir(), "echoink-pristine-after-rename-"));
  let failAfterRename = true;
  const afterRenameStore = new FileConversationStore({
    rootPath: afterRenameRoot,
    afterPristineDirectoryCommitBeforeIndex: () => {
      if (failAfterRename) throw new Error("fault after pristine directory commit");
    }
  });
  await assert.rejects(
    afterRenameStore.createPristineSession(candidate),
    /fault after pristine directory commit/
  );
  await assert.rejects(
    afterRenameStore.createPristineSession({ ...candidate, title: "different" }),
    /already exists with different durable content/,
    "index recovery must not guess that a different half-transaction owns the directory"
  );
  let cleanupCalls = 0;
  const restartedStore = new FileConversationStore({
    rootPath: afterRenameRoot,
    now: () => 2,
    beforeContextPayloadGc: () => {
      cleanupCalls += 1;
    }
  });
  const recovered = await restartedStore.reconcileCommittedSessionsAtStartup();
  assert.equal(recovered.repairedIndex, true);
  assert.deepEqual(recovered.recoveredIndexSessionIds, [candidate.id]);
  assert.deepEqual(recovered.sessions.map((session) => session.id), [candidate.id]);
  assert.equal((await restartedStore.readSession(candidate.id))?.title, candidate.title);
  const secondRestart = await new FileConversationStore({
    rootPath: afterRenameRoot,
    now: () => 3,
    beforeContextPayloadGc: () => {
      cleanupCalls += 1;
    }
  }).reconcileCommittedSessionsAtStartup();
  assert.equal(secondRestart.repairedIndex, false);
  assert.deepEqual(secondRestart.recoveredIndexSessionIds, []);
  assert.deepEqual(secondRestart.sessions.map((session) => session.id), [candidate.id]);
  assert.equal(cleanupCalls, 0, "startup projection repair must not run payload cleanup");

  failAfterRename = false;
  await afterRenameStore.createPristineSession(candidate);
  assert.equal((await afterRenameStore.readSession(candidate.id))?.title, candidate.title);
  assert.deepEqual(
    (await afterRenameStore.readIndex()).sessions.map((item) => item.sessionId),
    [candidate.id]
  );

  const halfRoot = await mkdtemp(path.join(tmpdir(), "echoink-pristine-half-dir-"));
  await mkdir(path.join(halfRoot, "sessions", candidate.id), { recursive: true });
  const halfStore = new FileConversationStore({ rootPath: halfRoot });
  await assert.rejects(
    halfStore.createPristineSession(candidate),
    /has no durable marker/,
    "a pre-existing directory without a valid marker must never be inferred as committed"
  );
}

async function assertStartupReconciliationReturnsDurableSessionsMissingFromDataShell(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-conversation-reconcile-missing-shell-"
  ));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 4 });
    const durable: StoredSession = {
      id: "durable-without-data-shell",
      title: "Durable authority",
      cwd: "/vault",
      ...workspaceBoundIdentity("durable-without-data-shell"),
      messages: [{
        id: "durable-message",
        role: "user",
        text: "committed before data shell",
        createdAt: 1
      }],
      createdAt: 1,
      updatedAt: 2
    };
    await createPristineSettingsSessions(store, [durable]);
    await store.upsertSession(durable);

    const dataShellSessionIds: string[] = [];
    const recovered = await new FileConversationStore({
      rootPath,
      now: () => 5
    }).reconcileCommittedSessionsAtStartup();
    const missingDataShells = recovered.sessions.filter(
      (session) => !dataShellSessionIds.includes(session.id)
    );

    assert.equal(recovered.repairedIndex, false);
    assert.deepEqual(missingDataShells.map((session) => session.id), [durable.id]);
    assert.deepEqual(
      missingDataShells[0]?.messages.map((message) => message.text),
      ["committed before data shell"],
      "startup hydration must be able to rebuild a missing data.json shell from durable authority"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertStartupReconciliationFailsClosedOnAmbiguousEvidence(): Promise<void> {
  const duplicateRoot = await mkdtemp(path.join(
    tmpdir(),
    "echoink-conversation-reconcile-duplicate-message-"
  ));
  try {
    const store = new FileConversationStore({ rootPath: duplicateRoot, now: () => 6 });
    const session: StoredSession = {
      id: "duplicate-message-recovery",
      title: "Duplicate message recovery",
      cwd: "/vault",
      ...workspaceBoundIdentity("duplicate-message-recovery"),
      messages: [
        { id: "duplicate-id", role: "user", text: "first", createdAt: 1 },
        { id: "second-id", role: "assistant", text: "second", createdAt: 2 }
      ],
      createdAt: 1,
      updatedAt: 2
    };
    await createPristineSettingsSessions(store, [session]);
    await store.upsertSession(session);
    const metadata = JSON.parse(await readFile(path.join(
      duplicateRoot,
      "sessions",
      session.id,
      "metadata.json"
    ), "utf8")) as { payloadKey: string };
    const messagesPath = path.join(
      duplicateRoot,
      "sessions",
      session.id,
      "context-payloads",
      metadata.payloadKey,
      "messages.jsonl"
    );
    const duplicatePayload = [
      session.messages[0],
      { ...session.messages[1], id: session.messages[0]!.id }
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    await writeFile(messagesPath, duplicatePayload, "utf8");
    const indexPath = path.join(duplicateRoot, "index.json");
    const indexBefore = await readFile(indexPath, "utf8");
    let cleanupCalls = 0;

    await assert.rejects(
      new FileConversationStore({
        rootPath: duplicateRoot,
        beforeContextPayloadGc: () => {
          cleanupCalls += 1;
        }
      }).reconcileCommittedSessionsAtStartup(),
      /committed messages contain duplicate IDs/
    );
    assert.equal(await readFile(indexPath, "utf8"), indexBefore);
    assert.equal(await readFile(messagesPath, "utf8"), duplicatePayload);
    assert.equal(cleanupCalls, 0);
  } finally {
    await rm(duplicateRoot, { recursive: true, force: true });
  }

  const unknownSchemaRoot = await mkdtemp(path.join(
    tmpdir(),
    "echoink-conversation-reconcile-unknown-schema-"
  ));
  try {
    const store = new FileConversationStore({ rootPath: unknownSchemaRoot, now: () => 7 });
    const session: StoredSession = {
      id: "unknown-index-schema",
      title: "Unknown index schema",
      revision: 1,
      generation: 1,
      cwd: "",
      messages: [],
      createdAt: 1,
      updatedAt: 1
    };
    await store.createPristineSession(session);
    const indexPath = path.join(unknownSchemaRoot, "index.json");
    const unknownIndex = JSON.stringify({
      version: 99,
      updatedAt: 1,
      sessions: []
    });
    await writeFile(indexPath, unknownIndex, "utf8");
    let cleanupCalls = 0;
    await assert.rejects(
      new FileConversationStore({
        rootPath: unknownSchemaRoot,
        beforeContextPayloadGc: () => {
          cleanupCalls += 1;
        }
      }).reconcileCommittedSessionsAtStartup(),
      /Conversation index schema is unknown or corrupt/
    );
    assert.equal(await readFile(indexPath, "utf8"), unknownIndex);
    assert.equal(cleanupCalls, 0);
  } finally {
    await rm(unknownSchemaRoot, { recursive: true, force: true });
  }

  const incompleteRoot = await mkdtemp(path.join(
    tmpdir(),
    "echoink-conversation-reconcile-incomplete-directory-"
  ));
  try {
    const incompleteDir = path.join(incompleteRoot, "sessions", "incomplete-session");
    await mkdir(incompleteDir, { recursive: true });
    const evidencePath = path.join(incompleteDir, "recovery-evidence.bin");
    await writeFile(evidencePath, "retain incomplete evidence", "utf8");
    const indexPath = path.join(incompleteRoot, "index.json");
    const emptyIndex = JSON.stringify({ version: 1, updatedAt: 0, sessions: [] });
    await writeFile(indexPath, emptyIndex, "utf8");
    let cleanupCalls = 0;
    await assert.rejects(
      new FileConversationStore({
        rootPath: incompleteRoot,
        beforeContextPayloadGc: () => {
          cleanupCalls += 1;
        }
      }).reconcileCommittedSessionsAtStartup(),
      /committed metadata is missing for incomplete-session/
    );
    assert.equal(await readFile(indexPath, "utf8"), emptyIndex);
    assert.equal(await readFile(evidencePath, "utf8"), "retain incomplete evidence");
    assert.equal(cleanupCalls, 0);
  } finally {
    await rm(incompleteRoot, { recursive: true, force: true });
  }
}

async function assertIncompleteContextCannotMutatePayload(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-incomplete-context-payload-"));
  const store = new FileConversationStore({ rootPath, now: () => 10 });
  const shell: StoredSession = {
    id: "incomplete-context-shell",
    title: "Shell",
    revision: 1,
    generation: 1,
    cwd: "",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  await store.createPristineSession(shell);
  await assert.rejects(
    store.upsertSession({
      ...shell,
      messages: [
        { id: "must-bootstrap-first", role: "user", text: "hello", createdAt: 2 }
      ],
      updatedAt: 2
    }),
    /payload mutation requires a complete durable Context identity/
  );
  assert.deepEqual((await store.readSession(shell.id))?.messages, []);

  await store.upsertSession({ ...shell, title: "Metadata only", updatedAt: 2 });
  const metadataOnly = await store.readSession(shell.id);
  assert.equal(metadataOnly?.title, "Metadata only");
  assert.deepEqual(metadataOnly?.messages, []);

  const bootstrapped: StoredSession = {
    ...metadataOnly!,
    cwd: "/vault",
    revision: 2,
    generation: 2,
    contextId: "context-after-bootstrap",
    commitId: "commit-after-bootstrap",
    workspaceFingerprint: workspaceFingerprint({
      vaultPath: "/vault",
      cwd: "/vault"
    }),
    messages: [
      { id: "after-bootstrap", role: "user", text: "hello", createdAt: 3 }
    ],
    updatedAt: 3
  };
  await store.commitSessionContext(bootstrapped, {
    expectedGeneration: 1,
    expectedContentRevision: createConversationContentRevision(metadataOnly!)
  });
  assert.deepEqual(
    (await store.readSession(shell.id))?.messages.map((message) => message.id),
    ["after-bootstrap"]
  );
}

async function assertOrdinaryUpsertUsesDetachedPayloadRevision(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-detached-payload-"));
  let failBeforeCommitMarker = false;
  let commitMarkerAttempts = 0;
  let mutateAfterPayloadAddressed = false;
  let liveMutationCandidate: StoredSession | null = null;
  const store = new FileConversationStore({
    rootPath,
    now: () => 10,
    afterContextPayloadAddressed: () => {
      if (!mutateAfterPayloadAddressed || !liveMutationCandidate) return;
      liveMutationCandidate.messages.at(-1)!.text = "mutated after payload address";
    },
    beforeContextCommitMarker: () => {
      commitMarkerAttempts += 1;
      if (failBeforeCommitMarker) {
        throw new Error("fault before ordinary upsert commit marker");
      }
    }
  });
  const session: StoredSession = {
    id: "chat-detached-payload",
    title: "Detached payload",
    cwd: "/vault",
    ...workspaceBoundIdentity("chat-detached-payload"),
    messages: [
      { id: "m1", role: "user", text: "first durable message", createdAt: 1 }
    ],
    createdAt: 1,
    updatedAt: 1
  };
  await createPristineSettingsSessions(store, [session]);
  await store.upsertSession(session);

  const metadataPath = path.join(
    rootPath,
    "sessions",
    session.id,
    "metadata.json"
  );
  const firstMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    payloadVersion?: number;
    payloadKey?: string;
  };
  assert.equal(firstMetadata.payloadVersion, 2);
  assert.ok(firstMetadata.payloadKey);

  const candidate: StoredSession = {
    ...session,
    messages: [
      ...session.messages,
      { id: "m2", role: "assistant", text: "second durable message", createdAt: 2 }
    ],
    updatedAt: 2
  };
  const candidateBeforeFault = JSON.parse(JSON.stringify(candidate)) as StoredSession;
  failBeforeCommitMarker = true;
  await assert.rejects(
    store.upsertSession(candidate),
    /fault before ordinary upsert commit marker/
  );
  assert.deepEqual(
    candidate,
    candidateBeforeFault,
    "a pre-marker failure must not mutate the caller-owned session"
  );

  const metadataAfterFault = JSON.parse(await readFile(metadataPath, "utf8")) as {
    payloadKey?: string;
  };
  assert.equal(
    metadataAfterFault.payloadKey,
    firstMetadata.payloadKey,
    "a pre-marker failure must leave the old active payload pointer untouched"
  );
  assert.deepEqual(
    (await store.readSession(session.id))?.messages.map((message) => message.id),
    ["m1"],
    "the old marker must still read exactly the old payload"
  );

  failBeforeCommitMarker = false;
  commitMarkerAttempts = 0;
  await store.upsertSession(candidate);
  assert.equal(
    commitMarkerAttempts,
    1,
    "one logical upsert must cross the durable commit marker exactly once"
  );
  const committedMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    payloadVersion?: number;
    payloadKey?: string;
    previousPayloadKey?: string;
    previousPayloadCommitId?: string;
  };
  assert.equal(committedMetadata.payloadVersion, 2);
  assert.notEqual(committedMetadata.payloadKey, firstMetadata.payloadKey);
  assert.equal(committedMetadata.previousPayloadKey, firstMetadata.payloadKey);
  assert.equal(committedMetadata.previousPayloadCommitId, session.commitId);
  const restored = await store.readSession(session.id);
  assert.ok(restored);
  assert.deepEqual(restored.messages.map((message) => message.id), ["m1", "m2"]);
  assert.equal(
    "payloadVersion" in (restored as unknown as Record<string, unknown>),
    false,
    "internal payload schema fields must not leak into StoredSession"
  );
  assert.equal(
    "previousPayloadCommitId" in (restored as unknown as Record<string, unknown>),
    false,
    "internal rollback authority fields must not leak into StoredSession"
  );

  const postAddressCandidate: StoredSession = {
    ...candidate,
    messages: [
      ...candidate.messages,
      {
        id: "m3",
        role: "assistant",
        text: "payload address source",
        createdAt: 3
      }
    ],
    updatedAt: 3
  };
  liveMutationCandidate = postAddressCandidate;
  mutateAfterPayloadAddressed = true;
  await store.upsertSession(postAddressCandidate);
  assert.equal(
    postAddressCandidate.messages.at(-1)?.text,
    "mutated after payload address",
    "the injected mutation must occur after the Store has computed its payload address"
  );
  const strictRestored = await store.readSession(session.id);
  assert.equal(
    strictRestored?.messages.at(-1)?.text,
    "payload address source",
    "the committed payload must remain the detached call-time candidate"
  );
}

async function assertSnapshotRefreshesWhenMessageContentChanges(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-snapshot-content-"));
  let now = 20;
  const store = new FileConversationStore({ rootPath, now: () => now });
  const session: StoredSession = {
    id: "chat-snapshot-content",
    title: "Snapshot content",
    cwd: "/vault",
    ...workspaceBoundIdentity("chat-snapshot-content"),
    messages: [
      { id: "user-1", role: "user", text: "请完成任务", createdAt: 1 },
      {
        id: "assistant-1",
        role: "assistant",
        text: "正在执行...",
        status: "running",
        createdAt: 2
      }
    ],
    createdAt: 1,
    updatedAt: 2
  };
  await createPristineSettingsSessions(store, [session]);
  await store.upsertSession(session);
  const running = await store.readSession(session.id);
  const runningVersion = running?.contextSnapshot?.version;
  assert.ok(runningVersion);
  assert.match(running?.contextSnapshot?.currentState ?? "", /正在执行/);

  now = 30;
  const completed: StoredSession = {
    ...session,
    messages: session.messages.map((message) => message.id === "assistant-1"
      ? {
        ...message,
        text: "任务已经完成",
        status: "success",
        completedAt: 3
      }
      : message),
    updatedAt: 3
  };
  await store.upsertSession(completed);
  const restored = await store.readSession(session.id);
  assert.notEqual(restored?.contextSnapshot?.version, runningVersion);
  assert.match(restored?.contextSnapshot?.currentState ?? "", /任务已经完成/);
  assert.match(restored?.contextSnapshot?.rollingSummary ?? "", /任务已经完成/);
  assert.doesNotMatch(restored?.contextSnapshot?.rollingSummary ?? "", /正在执行/);
  assert.doesNotMatch(restored?.rollingSummary?.text ?? "", /正在执行/);

  const completedVersion = restored?.contextSnapshot?.version;
  now = 40;
  await store.upsertSession({
    ...completed,
    messages: completed.messages.map((message) => message.id === "assistant-1"
      ? { ...message, status: "verified" }
      : message),
    updatedAt: 4
  });
  assert.notEqual(
    (await store.readSession(session.id))?.contextSnapshot?.version,
    completedVersion,
    "status-only changes on the same message ID must invalidate the snapshot version"
  );
}

async function assertLegacyCommitAddressedPayloadUpgradesToV2(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-payload-v1-"));
  const store = new FileConversationStore({ rootPath, now: () => 50 });
  const session: StoredSession = {
    id: "chat-payload-v1",
    title: "Legacy payload",
    cwd: "/vault",
    ...workspaceBoundIdentity("chat-payload-v1"),
    messages: [
      { id: "legacy-m1", role: "user", text: "legacy payload", createdAt: 1 }
    ],
    createdAt: 1,
    updatedAt: 1
  };
  await createPristineSettingsSessions(store, [session]);
  await store.upsertSession(session);

  const sessionRoot = path.join(rootPath, "sessions", session.id);
  const metadataPath = path.join(sessionRoot, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  const v2PayloadKey = String(metadata.payloadKey);
  const legacyPayloadKey = `payload-${createHash("sha256")
    .update(session.commitId!)
    .digest("hex")}`;
  const v2PayloadRoot = path.join(sessionRoot, "context-payloads", v2PayloadKey);
  const legacyPayloadRoot = path.join(sessionRoot, "context-payloads", legacyPayloadKey);
  await mkdir(legacyPayloadRoot, { recursive: true });
  await writeFile(
    path.join(legacyPayloadRoot, "messages.jsonl"),
    await readFile(path.join(v2PayloadRoot, "messages.jsonl"), "utf8"),
    "utf8"
  );
  await writeFile(
    path.join(legacyPayloadRoot, "snapshots.jsonl"),
    await readFile(path.join(v2PayloadRoot, "snapshots.jsonl"), "utf8"),
    "utf8"
  );
  delete metadata.payloadVersion;
  delete metadata.previousPayloadKey;
  delete metadata.previousPayloadCommitId;
  metadata.payloadKey = legacyPayloadKey;
  await writeFile(metadataPath, JSON.stringify(metadata), "utf8");

  assert.deepEqual(
    (await store.readSession(session.id))?.messages.map((message) => message.id),
    ["legacy-m1"],
    "metadata without payloadVersion must keep reading commit-addressed payloads"
  );
  await store.upsertSession({
    ...session,
    messages: [
      ...session.messages,
      { id: "legacy-m2", role: "assistant", text: "upgraded", createdAt: 2 }
    ],
    updatedAt: 2
  });
  const upgraded = JSON.parse(await readFile(metadataPath, "utf8")) as {
    payloadVersion?: number;
    payloadKey?: string;
    previousPayloadKey?: string;
    previousPayloadCommitId?: string;
  };
  assert.equal(upgraded.payloadVersion, 2);
  assert.notEqual(upgraded.payloadKey, legacyPayloadKey);
  assert.equal(upgraded.previousPayloadKey, legacyPayloadKey);
  assert.equal(upgraded.previousPayloadCommitId, session.commitId);
  assert.deepEqual(
    (await store.readSession(session.id))?.messages.map((message) => message.id),
    ["legacy-m1", "legacy-m2"]
  );
}

async function assertConversationStoreRequiresExplicitWorkspaceFreeChatCreate(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-pristine-chat-"));
  const store = new FileConversationStore({ rootPath });
  const pristineChat: StoredSession = {
    id: "chat-pristine",
    title: "新会话",
    revision: 1,
    generation: 1,
    cwd: "",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };

  await assert.rejects(
    store.upsertSession(pristineChat),
    /Conversation chat-pristine is missing; use createPristineSession/,
    "ordinary upsert must not create a missing runtime conversation"
  );
  await assert.rejects(
    store.persistSettingsSessions({ sessions: [pristineChat] }),
    /Conversation chat-pristine is missing; use createPristineSession/,
    "settings persistence must not insert a missing runtime conversation"
  );

  await store.createPristineSession(pristineChat);
  const restored = await store.readSession(pristineChat.id);
  assert.equal(restored?.revision, 1);
  assert.equal(restored?.generation, 1);
  assert.equal(restored?.cwd, "");
  assert.equal(restored?.contextId, undefined);
  assert.equal(restored?.commitId, undefined);
  assert.equal(restored?.workspaceFingerprint, undefined);
  assert.deepEqual(restored?.messages, []);
}

async function assertSettingsStoreMigratesAndRestoresConversationHistory(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-settings-conversation-"));
  let persisted: unknown = {
    settingsVersion: 29,
    activeSessionId: "chat-reload",
    editorActions: {
      enabled: true,
      model: "gpt-5.5",
      actions: []
    },
    sessions: [{
      id: "chat-reload",
      title: "重载会话",
      cwd: vaultPath,
      revision: 1,
      generation: 1,
      contextId: "context-chat-reload",
      commitId: "commit-chat-reload",
      workspaceFingerprint: workspaceFingerprint({
        vaultPath,
        cwd: vaultPath
      }),
      threadId: "legacy-thread-reload",
      messages: [
        { id: "reload-user", role: "user", text: "记住 V3 口令", createdAt: 1 },
        {
          id: "reload-assistant",
          role: "assistant",
          text: "已记住",
          createdAt: 2,
          backendId: "codex-cli",
          runUsage: { total_tokens: 3, input_tokens: 2, output_tokens: 1 }
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }]
  };

  const seededSettings = normalizeSettingsData(persisted).settings;
  const seededChat = seededSettings.sessions.find((session) => session.id === "chat-reload");
  assert.ok(seededChat);
  const conversationStore = new FileConversationStore({
    rootPath: path.join(pluginDataDir(vaultPath, "codex-echoink"), "conversations")
  });
  await createPristineSettingsSessions(conversationStore, [seededChat]);
  await conversationStore.persistSettingsSessions({ sessions: [seededChat] });

  const firstPlugin = fakeSettingsPlugin(vaultPath, () => persisted, (next) => { persisted = next; });
  const firstStore = new EchoInkSettingsStore(firstPlugin as any);
  await firstStore.loadSettings();
  await firstStore.saveSettings(true, { flushKnowledgeBaseHistory: false });

  const saved = persisted as CodexForObsidianSettings;
  const savedChat = saved.sessions.find((session) => session.id === "chat-reload");
  assert.deepEqual(savedChat?.messages, [], "settings data must not keep full chat history");
  assert.equal(savedChat?.threadId, undefined, "legacy native thread id must not remain in settings data");
  assert.equal(saved.editorActions.enabled, true, "main editor settings must survive conversation migration");

  const secondPlugin = fakeSettingsPlugin(vaultPath, () => persisted, (next) => { persisted = next; });
  const secondStore = new EchoInkSettingsStore(secondPlugin as any);
  await secondStore.loadSettings();
  const restored = secondPlugin.settings.sessions.find((session) => session.id === "chat-reload");
  assert.deepEqual(restored?.messages.map((message) => message.text), ["记住 V3 口令", "已记住"]);
  assert.deepEqual(restored?.messages[1]?.runUsage, { totalTokens: 3, inputTokens: 2, outputTokens: 1 });
  assert.equal(restored?.backendBindings?.["codex-cli"]?.nativeThreadId, "legacy-thread-reload");
  assert.equal(restored?.contextSnapshot?.summarizedThroughMessageId, "reload-assistant");
}

async function assertSettingsStoreRecoversDurableConversationMissingDataShell(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-settings-missing-shell-recovery-"
  ));
  try {
    const durable: StoredSession = {
      id: "committed-before-data-shell",
      title: "Committed before data shell",
      kind: "chat",
      cwd: vaultPath,
      revision: 1,
      generation: 1,
      contextId: "context-committed-before-shell",
      commitId: "commit-committed-before-shell",
      workspaceFingerprint: workspaceFingerprint({
        vaultPath,
        cwd: vaultPath
      }),
      messages: [{
        id: "committed-before-shell-message",
        role: "user",
        text: "Conversation committed before data.json",
        createdAt: 1
      }],
      createdAt: 1,
      updatedAt: 2
    };
    const conversationStore = new FileConversationStore({
      rootPath: path.join(
        pluginDataDir(vaultPath, "codex-echoink"),
        "conversations"
      )
    });
    await createPristineSettingsSessions(conversationStore, [durable]);
    await conversationStore.upsertSession(durable);

    let persisted: unknown = normalizeSettingsData({
      settingsVersion: 29,
      sessions: []
    }).settings;
    const firstPlugin = fakeSettingsPlugin(
      vaultPath,
      () => persisted,
      (next) => { persisted = next; }
    );
    await new EchoInkSettingsStore(firstPlugin as never).loadSettings();
    const firstRecovered = firstPlugin.settings.sessions.filter(
      (session) => session.id === durable.id
    );
    assert.equal(firstRecovered.length, 1);
    assert.deepEqual(
      firstRecovered[0]?.messages.map((message) => message.text),
      ["Conversation committed before data.json"]
    );
    assert.deepEqual(
      (persisted as CodexForObsidianSettings).sessions.find(
        (session) => session.id === durable.id
      )?.messages,
      [],
      "startup recovery must persist only the reconstructed data shell"
    );

    const secondPlugin = fakeSettingsPlugin(
      vaultPath,
      () => persisted,
      (next) => { persisted = next; }
    );
    await new EchoInkSettingsStore(secondPlugin as never).loadSettings();
    const secondRecovered = secondPlugin.settings.sessions.filter(
      (session) => session.id === durable.id
    );
    assert.equal(secondRecovered.length, 1);
    assert.deepEqual(
      secondRecovered[0]?.messages.map((message) => message.id),
      ["committed-before-shell-message"]
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertClearSurvivesRestartAndExcludesOldContext(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-clear-restart-context-"
  ));
  const sessionId = "knowledge-clear-restart";
  const oldSecret = "CLEAR_RESTART_OLD_CONTEXT_SENTINEL";
  const oldAnswer = "clear-restart-old-answer";
  const createdAt = Date.now() - 2_000;
  let persisted: unknown = {
    settingsVersion: 29,
    activeSessionId: sessionId,
    knowledgeBase: { sessionId },
    sessions: [{
      id: sessionId,
      kind: "knowledge-base",
      title: "知识库管理",
      cwd: vaultPath,
      revision: 1,
      generation: 1,
      contextId: "context-before-clear-restart",
      commitId: "commit-before-clear-restart",
      workspaceFingerprint: workspaceFingerprint({
        vaultPath,
        cwd: vaultPath
      }),
      messages: [
        {
          id: "clear-restart-old-user",
          role: "user",
          text: oldSecret,
          createdAt
        },
        {
          id: oldAnswer,
          role: "assistant",
          text: `acknowledged ${oldSecret}`,
          createdAt: createdAt + 1
        }
      ],
      createdAt,
      updatedAt: createdAt + 1
    }]
  };

  try {
    const seededSettings = normalizeSettingsData(persisted).settings;
    const seededSession = seededSettings.sessions.find(
      (session) => session.id === sessionId
    );
    assert.ok(seededSession);
    const seedStore = new FileConversationStore({
      rootPath: path.join(
        pluginDataDir(vaultPath, "codex-echoink"),
        "conversations"
      )
    });
    await createPristineSettingsSessions(seedStore, [seededSession]);
    await seedStore.persistSettingsSessions({ sessions: [seededSession] });

    const firstPlugin = fakeSettingsPlugin(
      vaultPath,
      () => persisted,
      (next) => { persisted = next; }
    ) as ReturnType<typeof fakeSettingsPlugin> & Record<string, unknown>;
    const firstSettingsStore = new EchoInkSettingsStore(firstPlugin as never);
    const retirementHost = {
      async registerNativeExecutionRetirements() {},
      async promoteNativeExecutionRetirements() {},
      async abortNativeExecutionRetirements() {},
      async cleanupNativeExecutionRecord() {}
    };
    firstPlugin.getKnowledgeBaseManager = () => null;
    firstPlugin.rotateEchoInkSessionContext = async (
      session: StoredSession,
      options: Parameters<typeof rotateEchoInkSessionContext>[3]
    ) => await rotateEchoInkSessionContext(
      retirementHost as never,
      firstSettingsStore,
      session,
      options
    );

    await firstSettingsStore.loadSettings();
    await firstSettingsStore.saveSettings(true, {
      flushKnowledgeBaseHistory: false
    });
    const liveSession = firstPlugin.settings.sessions.find(
      (session) => session.id === sessionId
    );
    assert.ok(liveSession);
    const generationBeforeClear = liveSession.generation;
    const host = {
      plugin: firstPlugin,
      isKnowledgeBaseSession: (session: StoredSession) =>
        session.kind === "knowledge-base",
      running: false,
      inputEl: { value: "must be cleared" },
      attachments: [],
      selectedSkill: null,
      closeComposerMenus() {},
      resetVirtualWindow() {},
      renderTabs() {},
      renderMessages() {},
      renderToolbar() {},
      updateInputPlaceholder() {}
    };

    await clearKnowledgeBasePage(host as never, liveSession);

    assert.equal(liveSession.contextStartsAfterMessageId, oldAnswer);
    assert.equal(liveSession.generation, (generationBeforeClear ?? 1) + 1);
    assert.equal(liveSession.backendBindings, undefined);

    // Simulate an Obsidian process restart immediately after the Conversation
    // commit. The shell in data.json is intentionally not saved again here;
    // the new SettingsStore must hydrate the authoritative boundary from a new
    // FileConversationStore instance.
    const restartedPlugin = fakeSettingsPlugin(
      vaultPath,
      () => persisted,
      (next) => { persisted = next; }
    );
    const restartedSettingsStore = new EchoInkSettingsStore(
      restartedPlugin as never
    );
    await restartedSettingsStore.loadSettings();
    const restartedSession = restartedPlugin.settings.sessions.find(
      (session) => session.id === sessionId
    );
    assert.ok(restartedSession);
    assert.deepEqual(
      restartedSession.messages.map((message) => message.id),
      ["clear-restart-old-user", oldAnswer],
      "starting a new context must retain the Conversation record"
    );
    assert.equal(restartedSession.contextStartsAfterMessageId, oldAnswer);
    assert.equal(restartedSession.generation, liveSession.generation);

    const bundle = compileContextBundle({
      runId: "run-after-clear-restart",
      session: restartedSession,
      backendId: "codex-cli",
      workflow: "knowledge.ask",
      userInput: {
        text: "NEW_CONTEXT_TURN",
        attachments: []
      },
      memory: {
        providerId: "disabled",
        items: [],
        sections: []
      },
      corePolicySections: [],
      mode: "bootstrap",
      now: Date.now()
    });
    const compiledContext = bundle.sessionContext
      .map((section) => section.content)
      .join("\n");
    assert.doesNotMatch(compiledContext, new RegExp(oldSecret));
    assert.equal(
      bundle.manifest?.contextId,
      restartedSession.contextId
    );
    assert.equal(
      bundle.manifest?.sessionGeneration,
      restartedSession.generation
    );
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertSettingsStoreBlocksUnmigratedLegacyConversation(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-settings-unmigrated-"));
  let persisted: unknown = {
    settingsVersion: 29,
    activeSessionId: "legacy-missing",
    sessions: [{
      id: "legacy-missing",
      title: "尚未迁移",
      cwd: vaultPath,
      messages: [
        { id: "legacy-user", role: "user", text: "must not be imported implicitly", createdAt: 1 }
      ],
      createdAt: 1,
      updatedAt: 1
    }]
  };
  const plugin = fakeSettingsPlugin(vaultPath, () => persisted, (next) => { persisted = next; });
  const settingsStore = new EchoInkSettingsStore(plugin as any);

  await assert.rejects(
    settingsStore.loadSettings(),
    /data shell legacy-missing lacks durable authority/,
    "Phase 1 must fail closed until the explicit legacy migration owns this import"
  );
}

async function assertConversationStoreDeletesSessionAndIndexEntry(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-delete-"));
  const store = new FileConversationStore({ rootPath, now: () => 20 });
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "chat-delete",
      title: "待删除",
      cwd: "/vault",
      ...workspaceBoundIdentity("chat-delete"),
      messages: [{ id: "m1", role: "user", text: "delete me", createdAt: 1 }],
      createdAt: 1,
      updatedAt: 1
    }]
  }).settings;
  await createPristineSettingsSessions(store, settings.sessions);
  await store.persistSettingsSessions(settings);

  assert.equal(await store.deleteSession("chat-delete"), true);
  assert.equal(await store.readSession("chat-delete"), null);
  assert.deepEqual((await store.readIndex()).sessions, []);
  assert.equal(await store.deleteSession("chat-delete"), false);
}

async function assertConversationRecordClearRetainsSourcesForJournalRetirement():
Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-conversations-record-clear-")
  );
  try {
    const store = new FileConversationStore({ rootPath, now: () => 20 });
    const source: StoredSession = {
      id: "chat-record-clear",
      title: "清空记录",
      cwd: "/vault",
      ...workspaceBoundIdentity("chat-record-clear"),
      messages: [{
        id: "clear-message",
        role: "user",
        text: "remove durable payload",
        createdAt: 1
      }],
      rollingSummary: {
        text: "old summary",
        throughMessageId: "clear-message",
        messageCount: 1,
        updatedAt: 2
      },
      createdAt: 1,
      updatedAt: 2
    };
    await createPristineSettingsSessions(store, [source]);
    await store.persistSettingsSessions({ sessions: [source] });
    const current = await store.readSession(source.id);
    assert.ok(current);
    const expectedContentRevision = createConversationContentRevision(current);
    const planned = await store.planConversationRecordMutationSources({
      operation: "clear-conversation-records",
      conversationId: current.id,
      expectedGeneration: sessionGeneration(current),
      expectedCommitId: current.commitId!,
      expectedContentRevision
    });
    assert.ok(planned.length >= 1);
    assert.ok(planned.every((entry) => (
      /^sessions\/chat-record-clear\/context-payloads\/payload-[a-f0-9]{64}$/
        .test(entry.sourceRelativePath)
    )));

    const target = structuredClone(current);
    target.messages = [];
    target.revision = sessionGeneration(current) + 1;
    target.generation = sessionGeneration(current) + 1;
    target.contextId = "context-chat-record-clear-target";
    target.commitId = "commit-chat-record-clear-target";
    target.updatedAt = 3;
    delete target.backendBindings;
    delete target.threadId;
    delete target.contextSnapshot;
    delete target.rollingSummary;
    delete target.messagesHiddenBefore;
    delete target.tokenUsage;

    await store.commitConversationRecordClear(target, {
      expectedGeneration: sessionGeneration(current),
      expectedCommitId: current.commitId!,
      expectedContentRevision,
      sourceRelativePaths: planned.map((entry) => entry.sourceRelativePath)
    });

    const committed = await store.readSession(source.id);
    assert.ok(committed);
    assert.equal(sessionGeneration(committed), sessionGeneration(current) + 1);
    assert.deepEqual(committed.messages, []);
    assert.equal(committed.contextSnapshot, undefined);
    assert.equal(committed.rollingSummary, undefined);
    const metadata = JSON.parse(await readFile(
      path.join(rootPath, "sessions", source.id, "metadata.json"),
      "utf8"
    )) as Record<string, unknown>;
    assert.equal(metadata.previousPayloadKey, undefined);
    for (const sourceEntry of planned) {
      await readdir(path.join(
        rootPath,
        ...sourceEntry.sourceRelativePath.split("/")
      ));
    }

    const conflicting = structuredClone(committed);
    conflicting.generation = sessionGeneration(committed) + 1;
    conflicting.revision = sessionGeneration(committed) + 1;
    conflicting.contextId = "context-chat-record-clear-conflict";
    conflicting.commitId = "commit-chat-record-clear-conflict";
    await assert.rejects(
      store.commitConversationRecordClear(conflicting, {
        expectedGeneration: sessionGeneration(committed),
        expectedCommitId: committed.commitId!,
        expectedContentRevision:
          createConversationContentRevision(committed),
        sourceRelativePaths: ["sessions/chat-record-clear/messages.jsonl"]
      }),
      /source plan changed/
    );
    assert.equal(
      (await store.readSession(source.id))?.commitId,
      committed.commitId
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertConversationDeletionTombstoneSurvivesIndexCrash():
Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-conversations-delete-tombstone-")
  );
  try {
    const source: StoredSession = {
      id: "chat-delete-tombstone",
      title: "删除 tombstone",
      cwd: "/vault",
      ...workspaceBoundIdentity("chat-delete-tombstone"),
      messages: [{
        id: "delete-tombstone-message",
        role: "user",
        text: "delete me recoverably",
        createdAt: 1
      }],
      createdAt: 1,
      updatedAt: 2
    };
    let failIndexProjection = true;
    const store = new FileConversationStore({
      rootPath,
      now: () => 20,
      afterDeletionTombstoneBeforeIndex: async () => {
        if (!failIndexProjection) return;
        failIndexProjection = false;
        throw new Error("simulated deletion index crash");
      }
    });
    await createPristineSettingsSessions(store, [source]);
    await store.persistSettingsSessions({ sessions: [source] });
    const current = await store.readSession(source.id);
    assert.ok(current);
    const tombstone = createConversationDeletionTombstone({
      conversationId: current.id,
      mutationId: "mutation-delete-tombstone",
      tombstoneId: "tombstone-delete-tombstone",
      sourceGeneration: sessionGeneration(current),
      sourceCommitId: current.commitId!,
      sourceContentRevision: createConversationContentRevision(current),
      deletedAt: 30
    });

    await assert.rejects(
      store.commitConversationDeletionTombstone(tombstone, {
        expectedGeneration: sessionGeneration(current),
        expectedCommitId: current.commitId!,
        expectedContentRevision:
          createConversationContentRevision(current)
      }),
      /simulated deletion index crash/
    );
    assert.equal(
      (await store.readConversationDeletionTombstone(current.id))?.digest,
      tombstone.digest
    );
    assert.equal(await store.readSession(current.id), null);
    await readdir(path.join(rootPath, "sessions", current.id));

    const recoveredStore = new FileConversationStore({
      rootPath,
      now: () => 40
    });
    const reconciliation =
      await recoveredStore.reconcileCommittedSessionsAtStartup();
    assert.deepEqual(reconciliation.sessions, []);
    assert.deepEqual(reconciliation.deletedSessionIds, [current.id]);
    assert.deepEqual((await recoveredStore.readIndex()).sessions, []);

    await recoveredStore.commitConversationDeletionTombstone(tombstone, {
      expectedGeneration: sessionGeneration(current),
      expectedCommitId: current.commitId!,
      expectedContentRevision: createConversationContentRevision(current)
    });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertConversationStorePersistsChatAndKnowledgeSessions(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-"));
  const store = new FileConversationStore({ rootPath, now: () => 10 });
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [
      {
        id: "chat-1",
        title: "普通对话",
        cwd: "/vault",
        ...workspaceBoundIdentity("chat-1"),
        threadId: "legacy-thread-1",
        backendBindings: {
          "codex-cli": {
            backendId: "codex-cli",
            nativeThreadId: "codex-thread-1",
            nativeExecutionKind: "thread",
            syncedSessionRevision: 1,
            lastUsedAt: 2
          }
        },
        messages: [
          { id: "c1", role: "user", text: "hello", createdAt: 1 },
          {
            id: "c2",
            role: "assistant",
            text: "world",
            createdAt: 2,
            backendId: "codex-cli",
            model: "gpt-5.5",
            profile: "writer",
            runUsage: { totalTokens: 11, inputTokens: 8, outputTokens: 3 }
          }
        ],
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: "knowledge-1",
        kind: "knowledge-base",
        title: "Knowledge",
        cwd: "/vault",
        ...workspaceBoundIdentity("knowledge-1"),
        messages: [
          { id: "k1", role: "user", text: "/ask Harness?", createdAt: 3 },
          { id: "k2", role: "assistant", text: "Harness 是主控。", createdAt: 4, backendId: "hermes" }
        ],
        createdAt: 3,
        updatedAt: 4
      }
    ]
  }).settings;

  await createPristineSettingsSessions(store, settings.sessions);
  const result = await store.persistSettingsSessions(settings);
  const index = await store.readIndex();
  const chat = await store.readSession("chat-1");
  const knowledge = await store.readSession("knowledge-1");
  const chatMetadata = await readFile(path.join(rootPath, "sessions", "chat-1", "metadata.json"), "utf8");
  const payloadKey = (JSON.parse(chatMetadata) as { payloadKey?: string }).payloadKey;
  assert.ok(payloadKey, "workspace-bound conversation metadata must address its committed payload");
  const chatPayloadDir = path.join(
    rootPath,
    "sessions",
    "chat-1",
    "context-payloads",
    payloadKey
  );
  const chatMessages = await readFile(path.join(chatPayloadDir, "messages.jsonl"), "utf8");
  const chatSnapshots = await readFile(path.join(chatPayloadDir, "snapshots.jsonl"), "utf8");

  assert.deepEqual(result, { sessionCount: 2, messageCount: 4, trimmedSettingsMessageCount: 0 });
  assert.deepEqual(index.sessions.map((session) => session.sessionId), ["knowledge-1", "chat-1"]);
  assert.equal(chat?.messages.length, 2);
  assert.equal(chat?.backendBindings?.["codex-cli"]?.nativeThreadId, "codex-thread-1");
  assert.doesNotMatch(chatMetadata, /legacy-thread-1|"threadId"/);
  assert.equal(chat?.messages[1]?.backendId, "codex-cli");
  assert.equal(chat?.messages[1]?.modelId, "gpt-5.5");
  assert.equal(chat?.messages[1]?.profileId, "writer");
  assert.deepEqual(chat?.messages[1]?.runUsage, { totalTokens: 11, inputTokens: 8, outputTokens: 3 });
  assert.equal(chat?.contextSnapshot?.summarizedFromMessageId, "c1");
  assert.equal(chat?.contextSnapshot?.summarizedThroughMessageId, "c2");
  assert.equal(chat?.contextSnapshot?.sourceMessageCount, 2);
  assert.match(chat?.contextSnapshot?.rollingSummary ?? "", /user: hello/);
  assert.match(chatSnapshots, /"summarizedThroughMessageId":"c2"/);
  assert.equal(knowledge?.kind, "knowledge-base");
  assert.equal(knowledge?.messages[1]?.backendId, "hermes");
  assert.match(chatMessages, /"id":"c1"/);
  assert.match(chatMessages, /"runUsage":\{"totalTokens":11,"inputTokens":8,"outputTokens":3\}/);
}

async function assertConversationNativeTransportRoundTripAndValidation(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversation-native-transport-"));
  const store = new FileConversationStore({ rootPath, now: () => 20 });
  const base: StoredSession = {
    id: "conversation-native-transport",
    title: "Native transport",
    cwd: "/vault",
    ...workspaceBoundIdentity("conversation-native-transport"),
    messages: [],
    createdAt: 1,
    updatedAt: 2
  };
  await store.createPristineSession(base);
  const safe: StoredSession = {
    ...base,
    backendBindings: {
      hermes: {
        backendId: "hermes",
        nativeSessionId: "hermes-acp-session",
        nativeExecutionKind: "session",
        nativeExecutionRef: {
          backendId: "hermes",
          id: "hermes-acp-session",
          kind: "session",
          persistence: "provider-persistent",
          transport: "acp-stdio",
          deviceKey: "device-test",
          vaultId: "/vault",
          createdAt: 2
        },
        syncedSessionRevision: 1,
        lastUsedAt: 2
      }
    }
  };
  await store.upsertSession(safe);
  assert.equal(
    (await store.readSession(base.id))
      ?.backendBindings?.hermes?.nativeExecutionRef?.transport,
    "acp-stdio"
  );

  const metadataPath = path.join(
    rootPath,
    "sessions",
    base.id,
    "metadata.json"
  );
  const metadataBeforeUnsafe = await readFile(metadataPath, "utf8");
  const unsafe = structuredClone(safe);
  unsafe.backendBindings!.hermes!.nativeExecutionRef!.transport =
    "acp-stdio?token=TOP_SECRET";
  await assert.rejects(
    store.upsertSession(unsafe),
    /native execution transport is invalid/
  );
  assert.equal(await readFile(metadataPath, "utf8"), metadataBeforeUnsafe);

  const normalizedUnsafe = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [unsafe]
  }).settings.sessions[0];
  assert.equal(
    normalizedUnsafe?.backendBindings?.hermes?.nativeExecutionRef,
    undefined,
    "Settings normalization must not retain an unsafe Native transport"
  );

  const legacy = structuredClone(safe);
  delete legacy.backendBindings!.hermes!.nativeExecutionRef!.transport;
  await store.upsertSession(legacy);
  assert.equal(
    (await store.readSession(base.id))
      ?.backendBindings?.hermes?.nativeExecutionRef?.transport,
    undefined,
    "transport-less legacy Conversation refs must remain readable"
  );
}

async function assertConversationStoreCanTrimMigratedSettingsMessages(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-conversations-trim-"));
  const store = new FileConversationStore({ rootPath });
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "legacy-chat",
      title: "旧对话",
      cwd: "/vault",
      ...workspaceBoundIdentity("legacy-chat"),
      messages: [
        { id: "m1", role: "user", text: "旧消息", createdAt: 1 }
      ],
      createdAt: 1,
      updatedAt: 1
    }]
  }).settings;

  await createPristineSettingsSessions(store, settings.sessions);
  const result = await store.persistSettingsSessions(settings, { trimSettingsMessages: true });
  const restored = await store.readSession("legacy-chat");

  assert.equal(result.trimmedSettingsMessageCount, 1);
  assert.deepEqual(settings.sessions[0].messages, []);
  assert.equal(restored?.messages[0]?.text, "旧消息");
}

async function assertConversationStoreParticipatesInDurableCommit(): Promise<void> {
  const [
    settingsSource,
    harnessSource,
    sessionSource,
    lifecycleSource,
    recordLifecycleSource,
    mainSource
  ] = await Promise.all([
    readFile("src/plugin/settings-store.ts", "utf8"),
    readFile("src/plugin/harness-service.ts", "utf8"),
    readFile("src/ui/codex-view/session-controller.ts", "utf8"),
    readFile("src/plugin/session-context-lifecycle.ts", "utf8"),
    readFile(
      "src/plugin/conversation-record-mutation-lifecycle.ts",
      "utf8"
    ),
    readFile("src/main.ts", "utf8")
  ]);
  assert.match(
    settingsSource,
    /const prepared = await this\.prepareCanonicalSettingsCandidate\(\)/
  );
  assert.match(
    settingsSource,
    /persistCanonicalConversationAndHistory\(\s*prepared\.candidate,\s*prepared\.liveBefore,\s*\{[\s\S]*flushKnowledgeBaseHistory: options\.flushKnowledgeBaseHistory !== false/
  );
  assert.match(settingsSource, /recoveredLintReportSummary\(settings\.lastReportPath\)/);
  assert.doesNotMatch(settingsSource, /上次 Codex 返回失败状态/);
  assert.match(
    settingsSource,
    /await this\.flushConversationStore\(\s*true,\s*fullCandidate,\s*synchronizeCanonicalSession\s*\)[\s\S]*const historyCandidate = cloneSettings\(fullCandidate\)[\s\S]*await this\.projectKnowledgeBaseHistory\([\s\S]*await this\.flushConversationStore\(\s*true,\s*historyCandidate,\s*synchronizeCanonicalSession\s*\)/
  );
  assert.match(
    settingsSource,
    /persistSettingsDataCandidate\(\s*candidate,\s*prepared\.persistedBefore\s*\)/
  );
  assert.match(settingsSource, /createAdvancingCanonicalSessionSynchronizer/);
  assert.match(
    settingsSource,
    /const expectedBySessionId = new Map\([\s\S]*stableJson\(liveSession\) !== stableJson\(expected\)[\s\S]*expectedBySessionId\.set/
  );
  assert.match(settingsSource, /delete session\.threadId/);
  assert.match(settingsSource, /readSession\(session\.id\)/);
  assert.match(settingsSource, /session\.messages = \[\]/);
  const confirmDeletion = sourceSection(
    sessionSource,
    "export async function confirmDeleteSessions",
    "export async function deleteSessions"
  );
  assert.match(confirmDeletion, /await deleteSessions\(host, sessionIds\)/);
  const productDeletion = sourceSection(
    sessionSource,
    "export async function deleteSessions",
    "function deletableSessions"
  );
  assert.match(productDeletion, /previewEchoInkSessionDeletion/);
  assert.match(productDeletion, /commitEchoInkSessionDeletion/);
  assert.match(productDeletion, /clearSessionQueue/);
  assert.doesNotMatch(productDeletion, /deleteStoredConversationSession/);
  assert.doesNotMatch(settingsSource, /deleteConversationSession\(/);
  assert.doesNotMatch(harnessSource, /commitEchoInkSessionDeletion\(/);
  assert.match(
    recordLifecycleSource,
    /materializeRecordMutationExecution[\s\S]*registerNativeExecutionRetirements[\s\S]*commitConversation(?:DeletionTombstone|RecordClear)[\s\S]*settleConversationRecordMutationExecution[\s\S]*promoteNativeExecutionRetirements/
  );
  assert.match(
    mainSource,
    /commitEchoInkSessionDeletion[\s\S]*commitEchoInkConversationRecordMutation/
  );
  assert.match(
    mainSource,
    /previewEchoInkConversationRecordClear[\s\S]*clearEchoInkConversationRecords/
  );
  assert.doesNotMatch(harnessSource, /resetEchoInkSessionNativeCache/);
  assert.match(sessionSource, /resetSessionNativeCache[\s\S]*reason: "agent-cache-reset"[\s\S]*advanceContext: false/);
  assert.match(lifecycleSource, /registerNativeExecutionRetirements[\s\S]*commitConversationSessionContext[\s\S]*promoteNativeExecutionRetirements/);
  const menuSource = await readFile("src/ui/codex-view/menus.ts", "utf8");
  assert.match(menuSource, /重置 Agent 缓存[\s\S]*onResetCache/);
  assert.match(menuSource, /清空会话记录[\s\S]*onClearRecords/);
}

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function fakeSettingsPlugin(
  vaultPath: string,
  load: () => unknown,
  save: (data: unknown) => void
): { settings: CodexForObsidianSettings; loadData(): Promise<unknown>; saveData(data: unknown): Promise<void>; getVaultPath(): string; getPluginDataDirName(): string } {
  return {
    settings: undefined as unknown as CodexForObsidianSettings,
    async loadData() { return load(); },
    async saveData(data) { save(JSON.parse(JSON.stringify(data))); },
    getVaultPath() { return vaultPath; },
    getPluginDataDirName() { return "codex-echoink"; }
  };
}

function workspaceBoundIdentity(id: string): Pick<
  StoredSession,
  "revision" | "generation" | "contextId" | "commitId" | "workspaceFingerprint"
> {
  return {
    revision: 1,
    generation: 1,
    contextId: `context-${id}`,
    commitId: `commit-${id}`,
    workspaceFingerprint: workspaceFingerprint({
      vaultPath: "/vault",
      cwd: "/vault"
    })
  };
}

async function createPristineSettingsSessions(
  store: FileConversationStore,
  sessions: StoredSession[]
): Promise<void> {
  for (const session of sessions) {
    await store.createPristineSession({
      ...session,
      threadId: undefined,
      backendBindings: undefined,
      messages: [],
      contextStartsAfterMessageId: undefined,
      contextSnapshot: undefined,
      rollingSummary: undefined,
      messagesHiddenBefore: undefined,
      historyActiveDate: undefined,
      tokenUsage: undefined
    });
  }
}
