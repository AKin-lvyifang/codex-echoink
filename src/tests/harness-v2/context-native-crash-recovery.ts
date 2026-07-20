import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import {
  rotateSessionContext,
  type SessionContextRotationReason,
  type SessionContextRotationResult
} from "../../harness/conversation/context-rotation";
import {
  createConversationContentRevision,
  FileConversationStore,
  type ConversationAuthorityProbe
} from "../../harness/conversation/conversation-store";
import { compileContextBundle } from "../../harness/kernel/context-compiler";
import { sessionGeneration, workspaceFingerprint } from "../../harness/kernel/session-service";
import { NativeExecutionManager } from "../../harness/native/native-execution-manager";
import { NativeExecutionStore } from "../../harness/native/native-execution-store";
import { EchoInkHarnessService } from "../../plugin/harness-service";
import {
  reconcileNativeExecutionsAtStartup,
  type NativeStartupReconciliationHost
} from "../../plugin/native-startup-reconciliation";
import type { StoredSession } from "../../settings/settings";

const TEST_NOW = 10_000;
const TEST_WORKSPACE = {
  vaultPath: "/vault",
  cwd: "/vault/workspace-a"
};

type CrashRecoveryRelation = "exact" | "before" | "later" | "conflict";

interface ProviderDispositionCounter {
  calls: number;
}

interface RotationFixture {
  conversationRoot: string;
  nativeRoot: string;
  conversationStore: FileConversationStore;
  nativeStore: NativeExecutionStore;
  nativeManager: NativeExecutionManager;
  harnessService: EchoInkHarnessService;
  session: StoredSession;
  targetCommitId: string;
  targetContextId: string;
  retirementId: string;
  setFailBeforeCommitMarker(value: boolean): void;
}

export async function runHarnessV2ContextNativeCrashRecoveryTests(): Promise<void> {
  await assertRestartedNewContextDoesNotRehydratePriorContext();
  await assertCommitFailureAbortsDurableRetirementAcrossRestart();
  for (const reason of ["agent-cache-reset", "lease-rollover"] as const) {
    await assertSameGenerationCommitFailureAbortsFromSourceAuthority(reason);
  }
  await assertSameGenerationCompetingCommitQuarantinesRetirement();
  for (const relation of ["exact", "before", "later", "conflict"] as const) {
    await assertRestartReconcilesDurableConversationAndRetirement(relation);
  }
}

async function assertRestartedNewContextDoesNotRehydratePriorContext(): Promise<void> {
  await withFixtureRoot("new-context-restart", async (rootPath) => {
    const provider = { calls: 0 };
    const first = await createRotationFixture(
      rootPath,
      "new-context-restart",
      provider
    );
    const priorSecret = "PRIOR-CONTEXT-SECRET-MUST-NOT-REHYDRATE";
    first.session.messages = [
      {
        id: "prior-secret-user",
        role: "user",
        text: priorSecret,
        createdAt: 2
      },
      {
        id: "prior-secret-assistant",
        role: "assistant",
        text: "prior answer",
        createdAt: 3
      }
    ];
    first.session.contextSnapshot = {
      sessionId: first.session.id,
      contextId: first.session.contextId,
      generation: first.session.generation,
      version: "prior-context-snapshot",
      goal: priorSecret,
      currentState: "prior state",
      decisions: [],
      constraints: [],
      openLoops: [],
      keyReferences: [],
      rollingSummary: priorSecret,
      summarizedFromMessageId: "prior-secret-user",
      summarizedThroughMessageId: "prior-secret-assistant",
      sourceMessageCount: 2,
      createdAt: 2,
      updatedAt: 3
    };
    first.session.rollingSummary = {
      text: priorSecret,
      updatedAt: 3
    };
    first.session.updatedAt = 3;
    await first.conversationStore.upsertSession(first.session);

    const rotation = await rotateWithFault(first, "crash-before-promotion");
    assert.equal(rotation?.retirementPromotion, "awaiting-recovery");

    const restartedConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW
    });
    const restartedNativeStore = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW
    });
    const restartedManager = createNativeManager(
      restartedNativeStore,
      provider
    );
    const startup = await reconcileNativeExecutionsAtStartup(
      startupHost(restartedConversation, restartedManager),
      { cleanupLimit: 0 }
    );
    assert.equal(startup.promotedCount, 1);
    assert.equal(provider.calls, 0);

    const restarted = await restartedConversation.readSession(
      first.session.id
    );
    assert.ok(restarted);
    assert.deepEqual(
      restarted.messages.map((message) => message.id),
      ["prior-secret-user", "prior-secret-assistant"],
      "starting a new context keeps prior messages as visible history"
    );
    assert.equal(
      restarted.contextStartsAfterMessageId,
      "prior-secret-assistant"
    );
    assert.equal(restarted.contextSnapshot, undefined);
    assert.equal(restarted.rollingSummary, undefined);

    const compiled = compileContextBundle({
      runId: "run-after-new-context-restart",
      session: restarted,
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "continue in the new context", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: [],
      mode: "bootstrap",
      now: TEST_NOW + 1
    });
    assert.doesNotMatch(
      JSON.stringify(compiled),
      new RegExp(priorSecret),
      "a restarted Obsidian session must not rehydrate prior messages, summaries, or snapshots"
    );
  });
}

async function assertCommitFailureAbortsDurableRetirementAcrossRestart(): Promise<void> {
  await withFixtureRoot("commit-failure", async (rootPath) => {
    const provider = { calls: 0 };
    const first = await createRotationFixture(rootPath, "commit-failure", provider);
    const before = structuredClone(first.session);

    first.setFailBeforeCommitMarker(true);
    await assert.rejects(
      rotateWithFault(first, "abort-after-commit-failure"),
      /simulated failure before Conversation commit marker/
    );
    first.setFailBeforeCommitMarker(false);

    const restartedConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW
    });
    const restartedNativeStore = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW
    });
    const restartedManager = createNativeManager(
      restartedNativeStore,
      provider
    );
    const startup = await reconcileNativeExecutionsAtStartup(
      startupHost(restartedConversation, restartedManager)
    );

    assert.equal(startup.awaitingCount, 0);
    assert.deepEqual(startup.cleanup, []);
    assert.equal(provider.calls, 0);
    assertConversationIdentity(
      await restartedConversation.readSession(before.id),
      before
    );
    assert.equal(
      (await restartedNativeStore.get(first.retirementId))?.localCommit,
      "failed"
    );
    assert.equal(
      (await restartedNativeStore.get(first.retirementId))?.cleanup,
      "aborted"
    );

    const thirdConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW + 1
    });
    const thirdNative = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW + 1
    });
    assertConversationIdentity(
      await thirdConversation.readSession(before.id),
      before
    );
    assert.equal((await thirdNative.get(first.retirementId))?.cleanup, "aborted");
    assert.equal(provider.calls, 0);
  });
}

async function assertSameGenerationCommitFailureAbortsFromSourceAuthority(
  reason: Extract<
    SessionContextRotationReason,
    "agent-cache-reset" | "lease-rollover"
  >
): Promise<void> {
  await withFixtureRoot(`same-generation-${reason}`, async (rootPath) => {
    const provider = { calls: 0 };
    const first = await createRotationFixture(
      rootPath,
      `same-generation-${reason}`,
      provider
    );
    const source = structuredClone(first.session);

    first.setFailBeforeCommitMarker(true);
    await assert.rejects(
      rotateWithFault(first, "crash-before-abort", {
        reason,
        advanceContext: false
      }),
      /simulated failure before Conversation commit marker/
    );
    first.setFailBeforeCommitMarker(false);

    const registered = await first.nativeStore.get(first.retirementId);
    assert.deepEqual(registered?.retirement, {
      targetConversationId: source.id,
      sourceGeneration: source.generation,
      sourceCommitId: source.commitId,
      sourceContextId: source.contextId,
      sourceWorkspaceFingerprint: source.workspaceFingerprint,
      targetGeneration: source.generation,
      targetCommitId: first.targetCommitId,
      targetContextId: source.contextId,
      targetWorkspaceFingerprint: source.workspaceFingerprint,
      reason
    });

    const restartedConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW
    });
    const restartedNativeStore = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW
    });
    const restartedManager = createNativeManager(
      restartedNativeStore,
      provider
    );
    const startup = await reconcileNativeExecutionsAtStartup(
      startupHost(restartedConversation, restartedManager)
    );

    assert.equal(startup.awaitingCount, 1);
    assert.equal(startup.abortedCount, 1);
    assert.equal(startup.quarantinedCount, 0);
    assert.deepEqual(startup.cleanup, []);
    assert.equal(provider.calls, 0);
    assertConversationIdentity(
      await restartedConversation.readSession(source.id),
      source
    );
    assert.equal(
      (await restartedNativeStore.get(first.retirementId))?.cleanup,
      "aborted"
    );

    const thirdConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW + 1
    });
    const thirdNative = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW + 1
    });
    assertConversationIdentity(
      await thirdConversation.readSession(source.id),
      source
    );
    assert.equal((await thirdNative.get(first.retirementId))?.cleanup, "aborted");
    assert.equal(provider.calls, 0);
  });
}

async function assertSameGenerationCompetingCommitQuarantinesRetirement(): Promise<void> {
  await withFixtureRoot("same-generation-competing-commit", async (rootPath) => {
    const provider = { calls: 0 };
    const first = await createRotationFixture(
      rootPath,
      "same-generation-competing-commit",
      provider
    );
    const source = structuredClone(first.session);

    first.setFailBeforeCommitMarker(true);
    await assert.rejects(
      rotateWithFault(first, "crash-before-abort", {
        reason: "agent-cache-reset",
        advanceContext: false
      }),
      /simulated failure before Conversation commit marker/
    );
    first.setFailBeforeCommitMarker(false);
    await commitCompetingSameGeneration(
      first.conversationStore,
      source.id,
      "same-generation-winner"
    );

    const restartedConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW
    });
    const restartedNativeStore = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW
    });
    const restartedManager = createNativeManager(
      restartedNativeStore,
      provider
    );
    const startup = await reconcileNativeExecutionsAtStartup(
      startupHost(restartedConversation, restartedManager)
    );

    assert.equal(startup.awaitingCount, 1);
    assert.equal(startup.abortedCount, 0);
    assert.equal(startup.quarantinedCount, 1);
    assert.deepEqual(startup.cleanup, []);
    assert.equal(provider.calls, 0);

    const thirdConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW + 1
    });
    const thirdNative = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW + 1
    });
    const durable = await thirdConversation.readSession(source.id);
    assert.ok(durable);
    assert.equal(durable.generation, source.generation);
    assert.equal(durable.contextId, source.contextId);
    assert.equal(durable.workspaceFingerprint, source.workspaceFingerprint);
    assert.equal(durable.commitId, "commit-same-generation-winner");
    assert.notEqual(durable.commitId, source.commitId);
    assert.notEqual(durable.commitId, first.targetCommitId);
    assert.equal(
      (await thirdNative.get(first.retirementId))?.cleanup,
      "quarantined"
    );
    assert.equal(provider.calls, 0);
  });
}

async function assertRestartReconcilesDurableConversationAndRetirement(
  relation: CrashRecoveryRelation
): Promise<void> {
  await withFixtureRoot(`startup-${relation}`, async (rootPath) => {
    const provider = { calls: 0 };
    const first = await createRotationFixture(rootPath, `startup-${relation}`, provider);

    if (relation === "exact" || relation === "later") {
      const rotation = await rotateWithFault(first, "crash-before-promotion");
      assert.ok(rotation);
      assert.equal(rotation.retirementPromotion, "awaiting-recovery");
      assert.equal(rotation.commitId, first.targetCommitId);
      if (relation === "later") {
        await commitCompetingNextGeneration(
          first.conversationStore,
          first.session.id,
          "later-current"
        );
      }
    } else {
      first.setFailBeforeCommitMarker(true);
      await assert.rejects(
        rotateWithFault(first, "crash-before-abort"),
        /simulated failure before Conversation commit marker/
      );
      first.setFailBeforeCommitMarker(false);
      if (relation === "conflict") {
        await commitCompetingNextGeneration(
          first.conversationStore,
          first.session.id,
          "conflicting-current"
        );
      }
    }

    const restartedConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW
    });
    const restartedNativeStore = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW
    });
    const restartedManager = createNativeManager(
      restartedNativeStore,
      provider
    );
    const startup = await reconcileNativeExecutionsAtStartup(
      startupHost(restartedConversation, restartedManager),
      { cleanupLimit: relation === "exact" ? 0 : 20 }
    );

    assert.equal(startup.awaitingCount, 1);
    assert.deepEqual(startup.cleanup, []);
    if (relation === "exact") {
      assert.equal(startup.promotedCount, 1);
    } else if (relation === "before") {
      assert.equal(startup.abortedCount, 1);
    } else {
      assert.equal(startup.quarantinedCount, 1);
    }
    assert.equal(provider.calls, 0);

    const thirdConversation = new FileConversationStore({
      rootPath: first.conversationRoot,
      now: () => TEST_NOW + 1
    });
    const thirdNative = new NativeExecutionStore({
      rootPath: first.nativeRoot,
      now: () => TEST_NOW + 1
    });
    const proof = await thirdConversation.proveSessionContextAuthority(
      targetProbe(first)
    );
    const record = await thirdNative.get(first.retirementId);
    assert.ok(record);
    assert.equal(proof.relation, relation);
    assert.equal(
      proof.targetPayload,
      relation === "exact"
        ? "active"
        : relation === "later"
          ? "previous"
          : "absent"
    );
    if (relation === "exact") {
      assert.equal(record.localCommit, "committed");
      assert.equal(record.cleanup, "pending");
      assert.ok(
        record.nextAttemptAt <= TEST_NOW,
        "an exact retirement must remain due when startup cleanupLimit is zero"
      );
    } else if (relation === "before") {
      assert.equal(record.localCommit, "failed");
      assert.equal(record.cleanup, "aborted");
    } else {
      assert.equal(record.cleanup, "quarantined");
    }
    assert.equal(provider.calls, 0);
  });
}

async function createRotationFixture(
  rootPath: string,
  label: string,
  provider: ProviderDispositionCounter
): Promise<RotationFixture> {
  const conversationRoot = path.join(rootPath, "conversations");
  const nativeRoot = path.join(rootPath, "native-executions");
  let failBeforeCommitMarker = false;
  const conversationStore = new FileConversationStore({
    rootPath: conversationRoot,
    now: () => TEST_NOW,
    beforeContextCommitMarker: () => {
      if (failBeforeCommitMarker) {
        throw new Error("simulated failure before Conversation commit marker");
      }
    }
  });
  const session = await seedConversation(conversationStore, label);
  const nativeStore = new NativeExecutionStore({
    rootPath: nativeRoot,
    now: () => TEST_NOW
  });
  const nativeManager = createNativeManager(nativeStore, provider);
  const harnessService = serviceWithNativeManager(nativeManager);
  return {
    conversationRoot,
    nativeRoot,
    conversationStore,
    nativeStore,
    nativeManager,
    harnessService,
    session,
    targetCommitId: `commit-${label}-target`,
    targetContextId: `context-${label}-target`,
    retirementId: `retirement-${label}`,
    setFailBeforeCommitMarker(value) {
      failBeforeCommitMarker = value;
    }
  };
}

async function seedConversation(
  store: FileConversationStore,
  label: string
): Promise<StoredSession> {
  const fingerprint = workspaceFingerprint(TEST_WORKSPACE);
  const pristine: StoredSession = {
    id: `conversation-${label}`,
    title: `Crash recovery ${label}`,
    cwd: TEST_WORKSPACE.cwd,
    revision: 1,
    generation: 1,
    contextId: `context-${label}-old`,
    commitId: `commit-${label}-old`,
    workspaceFingerprint: fingerprint,
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  await store.createPristineSession(pristine);
  const nativeId = `native-${label}-old`;
  const session: StoredSession = {
    ...structuredClone(pristine),
    backendBindings: {
      "codex-cli": {
        backendId: "codex-cli",
        nativeThreadId: nativeId,
        nativeExecutionKind: "thread",
        nativeExecutionRef: {
          backendId: "codex-cli",
          id: nativeId,
          kind: "thread",
          persistence: "provider-persistent",
          deviceKey: "test-device",
          vaultId: TEST_WORKSPACE.vaultPath,
          createdAt: 1
        },
        syncedSessionRevision: 1,
        workspaceFingerprint: fingerprint,
        leaseCreatedAt: 1,
        lastUsedAt: 2
      }
    },
    updatedAt: 2
  };
  await store.upsertSession(session);
  return session;
}

async function rotateWithFault(
  fixture: RotationFixture,
  fault:
    | "abort-after-commit-failure"
    | "crash-before-abort"
    | "crash-before-promotion",
  options: {
    reason?: SessionContextRotationReason;
    advanceContext?: boolean;
  } = {}
): Promise<SessionContextRotationResult | null> {
  return await rotateSessionContext(fixture.session, {
    reason: options.reason ?? "start-new-context",
    advanceContext: options.advanceContext ?? true,
    ...(options.advanceContext === false ? {} : { workspace: TEST_WORKSPACE }),
    identityFactory: {
      commitId: () => fixture.targetCommitId,
      contextId: () => fixture.targetContextId
    },
    retirementId: () => fixture.retirementId,
    now: () => TEST_NOW,
    hooks: {
      register: async (retirements) => {
        await fixture.harnessService.registerNativeExecutionRetirements(retirements);
      },
      commit: async (input) => {
        await fixture.conversationStore.commitSessionContext(input.session, {
          expectedGeneration: input.expectedGeneration,
          expectedCommitId: input.expectedCommitId,
          expectedContentRevision: input.expectedContentRevision
        });
      },
      promote: async (retirements) => {
        if (fault === "crash-before-promotion") {
          throw new Error("simulated crash before Native retirement promotion");
        }
        await fixture.harnessService.promoteNativeExecutionRetirements(retirements);
      },
      abort: async (retirements, error) => {
        if (fault === "crash-before-abort") {
          // A hard process stop cannot run the in-process abort hook. Leaving
          // the durable record awaiting is the startup reconciler's input.
          return;
        }
        await fixture.harnessService.abortNativeExecutionRetirements(
          retirements,
          error.message
        );
      }
    }
  });
}

async function commitCompetingSameGeneration(
  store: FileConversationStore,
  sessionId: string,
  suffix: string
): Promise<void> {
  const current = await store.readSession(sessionId);
  assert.ok(current);
  const candidate = structuredClone(current);
  candidate.commitId = `commit-${suffix}`;
  candidate.updatedAt = TEST_NOW + 1;
  delete candidate.backendBindings;
  delete candidate.threadId;
  await store.commitSessionContext(candidate, {
    expectedGeneration: sessionGeneration(current),
    expectedCommitId: current.commitId,
    expectedContentRevision: createConversationContentRevision(current)
  });
}

async function commitCompetingNextGeneration(
  store: FileConversationStore,
  sessionId: string,
  suffix: string
): Promise<void> {
  const current = await store.readSession(sessionId);
  assert.ok(current);
  const generation = sessionGeneration(current) + 1;
  const candidate = structuredClone(current);
  candidate.revision = generation;
  candidate.generation = generation;
  candidate.contextId = `context-${suffix}`;
  candidate.commitId = `commit-${suffix}`;
  candidate.updatedAt = TEST_NOW + generation;
  delete candidate.backendBindings;
  delete candidate.threadId;
  delete candidate.contextSnapshot;
  delete candidate.rollingSummary;
  await store.commitSessionContext(candidate, {
    expectedGeneration: sessionGeneration(current),
    expectedCommitId: current.commitId,
    expectedContentRevision: createConversationContentRevision(current)
  });
}

function createNativeManager(
  store: NativeExecutionStore,
  provider: ProviderDispositionCounter
): NativeExecutionManager {
  return new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "codex-cli",
      responseText: "unused",
      onDisposeNativeExecution: async (request) => {
        provider.calls += 1;
        return {
          outcome: "disposed",
          applied: request.requested
        };
      }
    })],
    now: () => TEST_NOW
  });
}

function serviceWithNativeManager(
  manager: NativeExecutionManager
): EchoInkHarnessService {
  const service = new EchoInkHarnessService({
    getVaultPath: () => TEST_WORKSPACE.vaultPath,
    getPluginDataDirName: () => "codex-echoink"
  } as never);
  (service as unknown as {
    getNativeExecutionManager(): NativeExecutionManager;
  }).getNativeExecutionManager = () => manager;
  return service;
}

function startupHost(
  conversationStore: FileConversationStore,
  manager: NativeExecutionManager
): NativeStartupReconciliationHost {
  return {
    async listAwaitingRetirements() {
      return await manager.listAwaitingLocalCommitRetirements();
    },
    async proveConversationAuthority(probe) {
      return await conversationStore.proveSessionContextAuthority(probe);
    },
    async promoteRetirement(record) {
      const promoted = await manager.promoteRetirement(record.id, record);
      if (!promoted) throw new Error(`Native retirement is missing: ${record.id}`);
    },
    async abortRetirement(record, reason) {
      const aborted = await manager.abortRetirement(record.id, reason, record);
      if (!aborted) throw new Error(`Native retirement is missing: ${record.id}`);
    },
    async quarantineRetirement(record, reason) {
      const quarantined = await manager.quarantineRetirement(
        record.id,
        reason,
        record
      );
      if (!quarantined) throw new Error(`Native retirement is missing: ${record.id}`);
    },
    async cleanupDue(limit) {
      return await manager.cleanupDue(limit);
    }
  };
}

function targetProbe(fixture: RotationFixture): ConversationAuthorityProbe {
  return {
    conversationId: fixture.session.id,
    targetGeneration: 2,
    targetCommitId: fixture.targetCommitId,
    targetContextId: fixture.targetContextId,
    targetWorkspaceFingerprint: workspaceFingerprint(TEST_WORKSPACE)
  };
}

function assertConversationIdentity(
  actual: StoredSession | null,
  expected: StoredSession
): void {
  assert.ok(actual);
  assert.equal(actual.revision, expected.revision);
  assert.equal(actual.generation, expected.generation);
  assert.equal(actual.contextId, expected.contextId);
  assert.equal(actual.commitId, expected.commitId);
  assert.deepEqual(actual.backendBindings, expected.backendBindings);
}

async function withFixtureRoot(
  label: string,
  run: (rootPath: string) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-context-native-${label}-`)
  );
  try {
    await run(rootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
