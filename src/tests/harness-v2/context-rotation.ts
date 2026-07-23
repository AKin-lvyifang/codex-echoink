import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  rotateSessionContext,
  type RotateSessionContextOptions,
  type SessionContextRetirement
} from "../../harness/conversation/context-rotation";
import {
  createConversationContentRevision,
  ConversationContextConflictError,
  FileConversationStore
} from "../../harness/conversation/conversation-store";
import {
  FileConversationStoreV2LiveAdapter
} from "../../plugin/conversation-store-v2-live-adapter";
import {
  rotateEchoInkSessionContext
} from "../../plugin/session-context-lifecycle";
import {
  messagesInCurrentSessionContext,
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import {
  durableConversationContentRevisionForLiveSession
} from "../../harness/lifecycle/conversation-migration-projection";
import type { NativeExecutionRecord } from "../../harness/contracts/native-execution";
import {
  assertConversationMutationAuthority,
  ConversationMutationLane,
  type ConversationMutationAuthority
} from "../../harness/conversation/conversation-mutation-lane";
import { reconcileNativeExecutionsAtStartup } from "../../plugin/native-startup-reconciliation";
import type { StoredSession } from "../../settings/settings";

export async function runHarnessV2ContextRotationTests(): Promise<void> {
  await assertConversationMutationLanePreservesQueuedLiveMutations();
  await assertConversationMutationLaneReleasesAfterFailure();
  await assertConversationMutationLaneScopesConcurrencyByConversation();
  await assertConversationMutationAuthorityIsScopedAndUnforgeable();
  await assertLegacyContextBootstrapCreatesDurableIdentity();
  await assertContextGenerationOverflowFailsClosed();
  await assertRotationRegistersOldBindingsBeforeCommit();
  await assertRotationRejectsConcurrentLiveMutationDuringRegistration();
  await assertRotationRollsBackAndAbortsWhenCommitFails();
  await assertPromotionFailureLeavesCommittedStateForRecovery();
  await assertRotationResultStaysBoundToCommittedCandidateDuringPromotion();
  await assertResolvedCommitCannotBeReinterpretedAsFailure();
  await assertRotationContractsRejectAmbiguousIdentity();
  await assertCodexTurnIdentityDoesNotConflictWithLegacyThread();
  await assertConflictingCodexIdentitiesBlockBeforeRegistration();
  await assertNonAdvancingRotationCannotMutateEpoch();
  await assertJournalledRotationCannotRewriteDurableRecords();
  await assertRotationCannotMutateImmutableConversationIdentity();
  await assertWorkspaceClearAdvancesAndInvalidatesAllBindings();
  await assertHistoryRestoreExcludesRestoredMessagesFromModelContext();
  await assertConversationContextFieldsRoundTripAndCas();
  await assertRotationFailsClosedOnUnknownOrCorruptIndex();
  await assertCommittedPayloadReadsFailClosed();
  await assertCommittedPayloadCollectionConsistency();
  await assertPristineConversationCreateContract();
  await assertCandidatePayloadValidationPrecedesWrites();
  await assertOrphanAndDeleteFailClosed();
  await assertConversationMetadataFailsClosed();
  await assertConversationGenerationEvidenceFailsClosed();
  await assertConversationAuthorityProofRelations();
  await assertSettingsHydrationPropagatesConversationRecoveryErrors();
  await assertConcurrentSessionUpsertsPreserveIndex();
  await assertOrdinaryUpsertCannotChangeContextIdentity();
  await assertOrdinaryFirstSaveCannotBeOverwrittenByRotation();
  await assertLeaseRolloverUsesDurableBaselineWithRunningAssistant();
  await assertQueuedStaleSaveCannotOverwriteCommittedRotation();
  await assertContextPayloadRetention();
  await assertContextPayloadGcRetriesAfterCommit();
}

async function assertConversationMutationLanePreservesQueuedLiveMutations(): Promise<void> {
  const lane = new ConversationMutationLane();
  const session = rotationSession();
  let releaseCommit = () => undefined;
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let commitStarted = () => undefined;
  const commitStartedGate = new Promise<void>((resolve) => {
    commitStarted = resolve;
  });
  const calls: string[] = [];
  const rotation = lane.withConversationMutation(session.id, async () => {
    await rotateSessionContext(session, {
      reason: "start-new-context",
      identityFactory: fixedRotationIdentity("commit-lane", "context-lane"),
      workspace: {
        vaultPath: "/vault",
        cwd: "/vault/workspace-a"
      },
      hooks: {
        async register() {
          calls.push("register");
        },
        async commit() {
          calls.push("commit");
          commitStarted();
          await commitGate;
        },
        async promote() {
          calls.push("promote");
        },
        async abort() {
          assert.fail("successful rotation must not abort");
        }
      }
    });
  });
  await commitStartedGate;

  const append = lane.withConversationMutation(session.id, async () => {
    calls.push("append");
    session.messages.push({
      id: "queued-user",
      role: "user",
      text: "排队期间追加的消息",
      createdAt: 3
    });
  });
  const rename = lane.withConversationMutation(session.id, async () => {
    calls.push("rename");
    session.title = "排队后的新标题";
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["register", "commit"]);

  releaseCommit();
  await Promise.all([rotation, append, rename]);
  assert.deepEqual(calls, ["register", "commit", "promote", "append", "rename"]);
  assert.equal(session.title, "排队后的新标题");
  assert.deepEqual(
    session.messages.map((message) => message.id),
    ["m1", "m2", "queued-user"]
  );
}

async function assertConversationMutationLaneReleasesAfterFailure(): Promise<void> {
  const lane = new ConversationMutationLane();
  const calls: string[] = [];
  await assert.rejects(
    lane.withConversationMutation(" \t", async () => {
      calls.push("invalid");
    }),
    /non-empty conversationId/
  );
  await assert.rejects(
    lane.withConversationMutation("failed-conversation", async () => {
      calls.push("failed");
      throw new Error("mutation failed");
    }),
    /mutation failed/
  );
  await lane.withConversationMutation("failed-conversation", async () => {
    calls.push("recovered");
  });
  assert.deepEqual(calls, ["failed", "recovered"]);
}

async function assertConversationMutationLaneScopesConcurrencyByConversation(): Promise<void> {
  const lane = new ConversationMutationLane();
  let releaseFirst = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted = () => undefined;
  const firstStartedGate = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const calls: string[] = [];
  const first = lane.withConversationMutation("conversation-a", async () => {
    calls.push("a:first:start");
    firstStarted();
    await firstGate;
    calls.push("a:first:end");
  });
  await firstStartedGate;
  const second = lane.withConversationMutation("conversation-a", async () => {
    calls.push("a:second");
  });
  const parallel = lane.withConversationMutation("conversation-b", async () => {
    calls.push("b:parallel");
  });
  await parallel;
  assert.deepEqual(calls, ["a:first:start", "b:parallel"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [
    "a:first:start",
    "b:parallel",
    "a:first:end",
    "a:second"
  ]);

  let releaseTrimmed = () => undefined;
  const trimmedGate = new Promise<void>((resolve) => {
    releaseTrimmed = resolve;
  });
  let trimmedStarted = () => undefined;
  const trimmedStartedGate = new Promise<void>((resolve) => {
    trimmedStarted = resolve;
  });
  const trimmedCalls: string[] = [];
  const trimmedFirst = lane.withConversationMutation(
    " conversation-c ",
    async () => {
      trimmedCalls.push("trimmed:first");
      trimmedStarted();
      await trimmedGate;
    }
  );
  await trimmedStartedGate;
  const trimmedSecond = lane.withConversationMutation(
    "conversation-c",
    async () => {
      trimmedCalls.push("trimmed:second");
    }
  );
  await Promise.resolve();
  assert.deepEqual(trimmedCalls, ["trimmed:first"]);
  releaseTrimmed();
  await Promise.all([trimmedFirst, trimmedSecond]);
  assert.deepEqual(trimmedCalls, ["trimmed:first", "trimmed:second"]);
}

async function assertConversationMutationAuthorityIsScopedAndUnforgeable(): Promise<void> {
  const lane = new ConversationMutationLane();
  let captured: ConversationMutationAuthority | null = null;
  await lane.withConversationMutation(
    " conversation-authority ",
    async (authority) => {
      captured = authority;
      assert.doesNotThrow(() => {
        assertConversationMutationAuthority(
          authority,
          "conversation-authority"
        );
      });
      assert.throws(
        () => assertConversationMutationAuthority(
          authority,
          "different-conversation"
        ),
        /different conversation/
      );
      assert.throws(
        () => assertConversationMutationAuthority(
          {} as ConversationMutationAuthority,
          "conversation-authority"
        ),
        /invalid or forged/
      );
    }
  );
  assert.ok(captured);
  assert.throws(
    () => assertConversationMutationAuthority(
      captured as ConversationMutationAuthority,
      "conversation-authority"
    ),
    /expired/
  );
}

async function assertLegacyContextBootstrapCreatesDurableIdentity(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-legacy-bootstrap-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 50 });
    const session = rotationSession();
    session.generation = 1;
    session.revision = 1;
    session.contextStartsAfterMessageId = "m1";
    delete session.contextId;
    delete session.commitId;
    delete session.workspaceFingerprint;
    session.cwd = "";
    delete session.contextSnapshot;
    delete session.rollingSummary;
    for (const binding of Object.values(session.backendBindings ?? {})) {
      delete binding.contextCursor;
      delete binding.workspaceFingerprint;
    }
    await writeLegacyConversationFixture(rootPath, session);

    const calls: string[] = [];
    await rotateSessionContext(session, {
      reason: "legacy-context-bootstrap",
      advanceContext: true,
      identityFactory: fixedRotationIdentity(
        "commit-legacy-bootstrap",
        "context-legacy-bootstrap"
      ),
      contextStartsAfterMessageId: session.contextStartsAfterMessageId,
      workspace: {
        vaultPath: "/vault",
        cwd: "/vault/workspace-a"
      },
      hooks: {
        async register(retirements) {
          calls.push("register");
          assert.equal(retirements.length, 2);
          assert.ok(retirements.every((retirement) =>
            retirement.reason === "legacy-context-bootstrap"
          ));
        },
        async commit(input) {
          calls.push("commit");
          await store.commitSessionContext(input.session, {
            expectedGeneration: input.expectedGeneration,
            expectedCommitId: input.expectedCommitId,
            expectedContentRevision: input.expectedContentRevision
          });
        },
        async promote() {
          calls.push("promote");
        },
        async abort() {
          assert.fail("valid legacy bootstrap must not abort");
        }
      }
    });

    assert.deepEqual(calls, ["register", "commit", "promote"]);
    assert.equal(session.generation, 2);
    assert.equal(session.contextId, "context-legacy-bootstrap");
    assert.equal(session.commitId, "commit-legacy-bootstrap");
    assert.equal(
      session.contextStartsAfterMessageId,
      "m1",
      "legacy bootstrap preserves the existing visible/model history boundary"
    );
    assert.deepEqual(session.messages.map((message) => message.id), ["m1", "m2"]);
    assert.equal(session.backendBindings, undefined);
    const restored = await store.readSession(session.id);
    assert.equal(restored?.generation, 2);
    assert.equal(restored?.contextId, "context-legacy-bootstrap");
    assert.equal(restored?.commitId, "commit-legacy-bootstrap");
    assert.equal(restored?.contextStartsAfterMessageId, "m1");
    assert.deepEqual(restored?.messages.map((message) => message.id), ["m1", "m2"]);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertContextGenerationOverflowFailsClosed(): Promise<void> {
  const session = rotationSession();
  session.generation = Number.MAX_SAFE_INTEGER;
  session.revision = Number.MAX_SAFE_INTEGER;
  const before = JSON.parse(JSON.stringify(session)) as StoredSession;
  const calls: string[] = [];
  await assert.rejects(
    rotateSessionContext(session, {
      reason: "start-new-context",
      identityFactory: fixedRotationIdentity(
        "commit-overflow",
        "context-overflow"
      ),
      workspace: {
        vaultPath: "/vault",
        cwd: "/vault/workspace-a"
      },
      hooks: {
        async register() {
          calls.push("register");
        },
        async commit(input) {
          calls.push("commit");
          return;
        },
        async promote() {
          calls.push("promote");
        },
        async abort() {
          calls.push("abort");
        }
      }
    }),
    /cannot advance beyond MAX_SAFE_INTEGER/
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(session, before);
}

async function assertRotationFailsClosedOnUnknownOrCorruptIndex(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-index-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 700 });
    const session = rotationSession();
    await seedConversationStore(store, session);
    const before = JSON.parse(JSON.stringify(session)) as StoredSession;
    const indexPath = path.join(rootPath, "index.json");
    const validIndex = await readFile(indexPath, "utf8");
    const sessionFilesBefore = await conversationSessionSnapshot(rootPath, session.id);
    const missingIndexTarget = nextContextSession(before, "missing-index", 701);

    await rm(indexPath, { force: true });
    await assert.rejects(
      store.commitSessionContext(missingIndexTarget, {
        expectedGeneration: 2,
        expectedCommitId: "commit-old",
        expectedContentRevision: createConversationContentRevision(before)
      }),
      /Conversation index is missing/
    );
    await assert.rejects(
      store.upsertSession({ ...before, updatedAt: 703 }),
      /Conversation index is missing/
    );
    await assert.rejects(store.deleteSession(session.id), /Conversation index is missing/);
    assert.deepEqual(
      await conversationSessionSnapshot(rootPath, session.id),
      sessionFilesBefore,
      "a missing index must fail before writing any session payload or marker"
    );
    await assert.rejects(readFile(indexPath, "utf8"), { code: "ENOENT" });

    const membershipMissingIndex = JSON.stringify({
      version: 1,
      updatedAt: 700,
      sessions: []
    });
    await writeFile(indexPath, membershipMissingIndex, "utf8");
    await assert.rejects(
      store.commitSessionContext(nextContextSession(before, "membership-missing", 702), {
        expectedGeneration: 2,
        expectedCommitId: "commit-old",
        expectedContentRevision: createConversationContentRevision(before)
      }),
      /Conversation index is missing session session-rotation/
    );
    assert.equal(await readFile(indexPath, "utf8"), membershipMissingIndex);
    assert.deepEqual(
      await conversationSessionSnapshot(rootPath, session.id),
      sessionFilesBefore,
      "an index lineage mismatch must fail before writing any session payload or marker"
    );

    await writeFile(indexPath, JSON.stringify({
      version: 2,
      updatedAt: 700,
      sessions: []
    }), "utf8");
    await assert.rejects(
      store.upsertSession({ ...before, updatedAt: 704 }),
      /Conversation index schema is unknown or corrupt/
    );
    await assert.rejects(
      store.deleteSession(session.id),
      /Conversation index schema is unknown or corrupt/
    );

    let promoted = false;
    let registered: SessionContextRetirement[] = [];
    let aborted: SessionContextRetirement[] = [];
    await assert.rejects(
      rotateSessionContext(session, {
        reason: "start-new-context",
        identityFactory: fixedRotationIdentity(
          "commit-index-failed",
          "context-index-failed"
        ),
        workspace: {
          vaultPath: "/vault",
          cwd: "/vault/workspace-a"
        },
        retirementId: (binding) => `index-${binding.backendId}`,
        now: () => 701,
        hooks: {
          async register(retirements) {
            registered = JSON.parse(JSON.stringify(retirements)) as SessionContextRetirement[];
          },
          async commit(input) {
            await store.commitSessionContext(input.session, {
              expectedGeneration: input.expectedGeneration,
              expectedCommitId: input.expectedCommitId,
              expectedContentRevision: input.expectedContentRevision
            });
          },
          async promote() {
            promoted = true;
          },
          async abort(retirements) {
            aborted = JSON.parse(JSON.stringify(retirements)) as SessionContextRetirement[];
          }
        }
      }),
      ConversationContextConflictError
    );
    assert.deepEqual(session, before);
    assert.equal(promoted, false);
    assert.deepEqual(aborted, registered);
    assert.deepEqual(await conversationSessionSnapshot(rootPath, session.id), sessionFilesBefore);

    await writeFile(indexPath, JSON.stringify({
      version: 1,
      updatedAt: 700,
      sessions: [null]
    }), "utf8");
    await assert.rejects(
      store.commitSessionContext({
        ...before,
        generation: 3,
        revision: 3,
        contextId: "context-corrupt",
        commitId: "commit-corrupt"
      }, {
        expectedGeneration: 2,
        expectedCommitId: "commit-old",
        expectedContentRevision: createConversationContentRevision(before)
      }),
      ConversationContextConflictError
    );
    assert.deepEqual(await conversationSessionSnapshot(rootPath, session.id), sessionFilesBefore);

    await writeFile(indexPath, validIndex, "utf8");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertRotationRegistersOldBindingsBeforeCommit(): Promise<void> {
  const session = rotationSession();
  const calls: string[] = [];
  let registered: SessionContextRetirement[] = [];
  const result = await rotateSessionContext(session, {
    reason: "workspace-switch",
    advanceContext: true,
    identityFactory: fixedRotationIdentity("commit-new", "context-new"),
    contextStartsAfterMessageId: "m2",
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-b"
    },
    retirementId: (binding) => `retirement-${binding.backendId}`,
    now: () => 100,
    hooks: {
      async register(retirements) {
        calls.push("register");
        registered = retirements;
        assert.equal(session.backendBindings?.["codex-cli"]?.nativeThreadId, "thread-old");
        assert.equal(session.generation, 2);
        assert.equal(retirements[0]?.binding.nativeThreadId, "thread-old");
      },
      async commit(input) {
        calls.push("commit");
        assert.equal(input.expectedGeneration, 2);
        assert.equal(input.expectedCommitId, "commit-old");
        assert.equal(input.session.generation, 3);
        assert.equal(input.session.revision, 3);
        assert.equal(input.session.contextId, "context-new");
        assert.equal(input.session.commitId, "commit-new");
        assert.equal(input.session.contextStartsAfterMessageId, "m2");
        assert.equal(input.session.backendBindings, undefined);
        assert.equal(session.generation, 2, "live state stays on the old epoch until CAS succeeds");
        return;
      },
      async promote(retirements) {
        calls.push("promote");
        assert.deepEqual(retirements.map((item) => item.retirementId), [
          "retirement-codex-cli",
          "retirement-opencode"
        ]);
      },
      async abort() {
        assert.fail("successful rotation must not abort retirements");
      }
    }
  });

  assert.deepEqual(calls, ["register", "commit", "promote"]);
  assert.equal(result.committed, true);
  assert.equal(result.retirementPromotion, "promoted");
  assert.equal(session.cwd, path.resolve("/vault/workspace-b"));
  assert.equal(
    session.workspaceFingerprint,
    workspaceFingerprint({ vaultPath: "/vault", cwd: "/vault/workspace-b" })
  );
  assert.equal(session.contextSnapshot, undefined);
  assert.equal(session.rollingSummary, undefined);
  assert.equal(session.threadId, undefined);
  assert.equal(registered.length, 2);
  assert.ok(registered.every((item) =>
    item.targetConversationId === session.id
    && item.targetGeneration === 3
    && item.targetCommitId === "commit-new"
    && item.targetContextId === "context-new"
  ));
}

async function assertRotationRollsBackAndAbortsWhenCommitFails(): Promise<void> {
  const session = rotationSession();
  const before = JSON.parse(JSON.stringify(session)) as StoredSession;
  const calls: string[] = [];

  await assert.rejects(
    rotateSessionContext(session, {
      reason: "start-new-context",
      advanceContext: true,
      identityFactory: fixedRotationIdentity("commit-failed", "context-failed"),
      workspace: {
        vaultPath: "/vault",
        cwd: "/vault/workspace-a"
      },
      retirementId: (binding) => `failed-${binding.backendId}`,
      now: () => 200,
      hooks: {
        async register() {
          calls.push("register");
        },
        async commit(input) {
          calls.push("commit");
          assert.equal(session.generation, 2, "provisional context must not leak into live state");
          assert.equal(input.session.generation, 3);
          throw new Error("conversation commit failed");
        },
        async promote() {
          calls.push("promote");
        },
        async abort(retirements, error) {
          calls.push("abort");
          assert.deepEqual(session, before, "abort hook must observe the fully restored session");
          assert.equal(retirements.length, 2);
          assert.match(error.message, /conversation commit failed/);
        }
      }
    }),
    /conversation commit failed/
  );

  assert.deepEqual(calls, ["register", "commit", "abort"]);
  assert.deepEqual(session, before);
}

async function assertRotationRejectsConcurrentLiveMutationDuringRegistration(): Promise<void> {
  const mutations: Array<{
    label: string;
    apply(session: StoredSession): void;
    verify(session: StoredSession): void;
  }> = [
    {
      label: "title",
      apply(session) {
        session.title = "Concurrent title";
      },
      verify(session) {
        assert.equal(session.title, "Concurrent title");
      }
    },
    {
      label: "backend-binding",
      apply(session) {
        session.backendBindings = {
          ...session.backendBindings,
          hermes: {
            backendId: "hermes",
            nativeSessionId: "concurrent-hermes-session",
            syncedSessionRevision: 2,
            workspaceFingerprint: session.workspaceFingerprint,
            lastUsedAt: 3
          }
        };
      },
      verify(session) {
        assert.equal(
          session.backendBindings?.hermes?.nativeSessionId,
          "concurrent-hermes-session"
        );
      }
    }
  ];

  for (const mutation of mutations) {
    const session = rotationSession();
    let releaseRegistration!: () => void;
    let markRegistrationStarted!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    let commitCalls = 0;
    let providerCleanupCalls = 0;
    let abortCalls = 0;
    const rotation = rotateSessionContext(session, {
      reason: "start-new-context",
      identityFactory: fixedRotationIdentity(
        `commit-concurrent-${mutation.label}`,
        `context-concurrent-${mutation.label}`
      ),
      workspace: {
        vaultPath: "/vault",
        cwd: "/vault/workspace-a"
      },
      hooks: {
        async register() {
          markRegistrationStarted();
          await registrationGate;
        },
        async commit() {
          commitCalls += 1;
        },
        async promote() {
          providerCleanupCalls += 1;
        },
        async abort() {
          abortCalls += 1;
        }
      }
    });

    await registrationStarted;
    mutation.apply(session);
    releaseRegistration();

    await assert.rejects(
      rotation,
      /Conversation changed before context commit while retirement registration was pending/
    );
    mutation.verify(session);
    assert.equal(commitCalls, 0);
    assert.equal(providerCleanupCalls, 0);
    assert.equal(abortCalls, 1);
  }
}

async function assertPromotionFailureLeavesCommittedStateForRecovery(): Promise<void> {
  const session = rotationSession();
  const result = await rotateSessionContext(session, {
    reason: "agent-cache-reset",
    advanceContext: false,
    identityFactory: fixedRotationIdentity("commit-cache-reset"),
    retirementId: (binding) => `cache-${binding.backendId}`,
    now: () => 300,
    hooks: {
      async register() {},
      async commit(input) {
        return;
      },
      async promote() {
        throw new Error("promotion interrupted");
      },
      async abort() {
        assert.fail("a post-commit promotion failure must not roll back local state");
      }
    }
  });

  assert.equal(result.committed, true);
  assert.equal(result.retirementPromotion, "awaiting-recovery");
  assert.match(result.promotionError ?? "", /promotion interrupted/);
  assert.equal(session.generation, 2, "cache reset preserves the current context generation");
  assert.equal(session.contextId, "context-old");
  assert.equal(session.contextStartsAfterMessageId, undefined);
  assert.equal(session.commitId, "commit-cache-reset");
  assert.equal(session.backendBindings, undefined);
}

async function assertRotationResultStaysBoundToCommittedCandidateDuringPromotion(): Promise<void> {
  const session = rotationSession();
  let releasePromotion!: () => void;
  let markPromotionStarted!: () => void;
  const promotionGate = new Promise<void>((resolve) => {
    releasePromotion = resolve;
  });
  const promotionStarted = new Promise<void>((resolve) => {
    markPromotionStarted = resolve;
  });

  const firstRotation = rotateSessionContext(session, {
    reason: "start-new-context",
    identityFactory: fixedRotationIdentity(
      "commit-first-concurrent",
      "context-first-concurrent"
    ),
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    },
    hooks: {
      async register() {},
      async commit() {},
      async promote() {
        markPromotionStarted();
        await promotionGate;
      },
      async abort() {
        assert.fail("the first committed rotation must not abort");
      }
    }
  });

  await promotionStarted;
  const secondRotation = await rotateSessionContext(session, {
    reason: "start-new-context",
    identityFactory: fixedRotationIdentity(
      "commit-second-concurrent",
      "context-second-concurrent"
    ),
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    },
    hooks: {
      async register() {
        assert.fail("the first rotation already retired every binding");
      },
      async commit() {},
      async promote() {
        assert.fail("a binding-free rotation does not require promotion");
      },
      async abort() {
        assert.fail("the second committed rotation must not abort");
      }
    }
  });
  releasePromotion();
  const firstResult = await firstRotation;

  assert.equal(secondRotation.generation, 4);
  assert.equal(secondRotation.contextId, "context-second-concurrent");
  assert.equal(secondRotation.commitId, "commit-second-concurrent");
  assert.equal(session.generation, 4);
  assert.equal(session.contextId, "context-second-concurrent");
  assert.equal(session.commitId, "commit-second-concurrent");
  assert.equal(firstResult.retirementPromotion, "promoted");
  assert.equal(firstResult.generation, 3);
  assert.equal(firstResult.contextId, "context-first-concurrent");
  assert.equal(firstResult.commitId, "commit-first-concurrent");
}

async function assertResolvedCommitCannotBeReinterpretedAsFailure(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-resolved-commit-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 350 });
    const session = rotationSession();
    await seedConversationStore(store, session);
    const calls: string[] = [];
    const result = await rotateSessionContext(session, {
      reason: "agent-cache-reset",
      advanceContext: false,
      identityFactory: fixedRotationIdentity("commit-resolved"),
      hooks: {
        async register() {
          calls.push("register");
        },
        async commit(input) {
          calls.push("commit");
          await store.commitSessionContext(input.session, {
            expectedGeneration: input.expectedGeneration,
            expectedCommitId: input.expectedCommitId,
            expectedContentRevision: input.expectedContentRevision
          });
          return {
            conversationId: input.session.id,
            generation: input.targetGeneration,
            commitId: "unexpected-legacy-return-value"
          } as unknown as void;
        },
        async promote() {
          calls.push("promote");
        },
        async abort() {
          calls.push("abort");
        }
      }
    });

    assert.deepEqual(
      calls,
      ["register", "commit", "promote"],
      "a resolved durable commit must synchronize live state and continue retirement promotion"
    );
    assert.equal(result.committed, true);
    assert.equal(result.retirementPromotion, "promoted");
    assert.equal(session.commitId, "commit-resolved");
    assert.equal(session.backendBindings, undefined);
    const restored = await store.readSession(session.id);
    assert.equal(restored?.commitId, "commit-resolved");
    assert.equal(restored?.backendBindings, undefined);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertRotationContractsRejectAmbiguousIdentity(): Promise<void> {
  await assertRotationRejectedBeforeHooks({
    reason: "start-new-context",
    advanceContext: true,
    identityFactory: fixedRotationIdentity("commit-new-context-reused", "context-old"),
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    }
  }, /cannot reuse the current contextId/);
  await assertRotationRejectedBeforeHooks({
    reason: "start-new-context",
    advanceContext: true,
    identityFactory: fixedRotationIdentity("commit-old", "context-new-commit-reused"),
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    }
  }, /cannot reuse the current commitId/);
  await assertRotationRejectedBeforeHooks({
    reason: "agent-cache-reset",
    advanceContext: true,
    identityFactory: fixedRotationIdentity("commit-invalid-agent-reset")
  }, /agent-cache-reset must preserve the current context/);
  await assertRotationRejectedBeforeHooks({
    reason: "lease-rollover",
    identityFactory: fixedRotationIdentity("commit-invalid-lease-rollover")
  }, /lease-rollover must preserve the current context/);
  await assertRotationRejectedBeforeHooks({
    reason: "start-new-context",
    advanceContext: true,
    identityFactory: fixedRotationIdentity("commit-no-workspace", "context-no-workspace")
  }, /start-new-context requires the current workspace identity/);
  await assertRotationRejectedBeforeHooks({
    reason: "workspace-switch",
    advanceContext: true,
    identityFactory: fixedRotationIdentity(
      "commit-no-workspace-switch",
      "context-no-workspace-switch"
    )
  }, /workspace-switch requires a non-empty workspace identity/);
  await assertRotationRejectedBeforeHooks({
    reason: "workspace-switch",
    advanceContext: true,
    identityFactory: fixedRotationIdentity(
      "commit-null-workspace-switch",
      "context-null-workspace-switch"
    ),
    workspace: null
  }, /workspace-switch requires a non-empty workspace identity/);
  await assertRotationRejectedBeforeHooks({
    reason: "start-new-context",
    advanceContext: true,
    identityFactory: fixedRotationIdentity(
      "commit-partial-retirement",
      "context-partial-retirement"
    ),
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    },
    retireBackendIds: ["codex-cli"]
  }, /Advancing context must invalidate every backend binding/);
  await assertRotationRejectedBeforeHooks({
    reason: "history-restore",
    advanceContext: true,
    identityFactory: fixedRotationIdentity(
      "commit-history-no-boundary",
      "context-history-no-boundary"
    )
  }, /history-restore must advance context with an explicit restored-history boundary/);
}

async function assertConflictingCodexIdentitiesBlockBeforeRegistration(): Promise<void> {
  const session = rotationSession();
  session.threadId = "legacy-thread-conflict";
  const before = JSON.parse(JSON.stringify(session)) as StoredSession;
  const calls: string[] = [];
  await assert.rejects(
    rotateSessionContext(session, {
      reason: "start-new-context",
      identityFactory: fixedRotationIdentity(
        "commit-conflicting-codex",
        "context-conflicting-codex"
      ),
      workspace: {
        vaultPath: "/vault",
        cwd: "/vault/workspace-a"
      },
      hooks: {
        async register() {
          calls.push("register");
        },
        async commit(input) {
          calls.push("commit");
          return;
        },
        async promote() {
          calls.push("promote");
        },
        async abort() {
          calls.push("abort");
        }
      }
    }),
    /Codex binding conflicts with legacy threadId/
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(session, before);
}

async function assertCodexTurnIdentityDoesNotConflictWithLegacyThread(): Promise<void> {
  const session = rotationSession();
  const binding = session.backendBindings?.["codex-cli"];
  assert.ok(binding);
  binding.nativeSessionId = "turn-old";
  binding.nativeExecutionKind = "thread";
  binding.nativeExecutionRef = {
    backendId: "codex-cli",
    id: "thread-old",
    kind: "thread",
    persistence: "provider-persistent",
    createdAt: 2
  };
  const calls: string[] = [];
  await rotateSessionContext(session, {
    reason: "lease-rollover",
    advanceContext: false,
    retireBackendIds: ["codex-cli"],
    identityFactory: fixedRotationIdentity("commit-codex-turn-id"),
    hooks: {
      async register() {
        calls.push("register");
      },
      async commit() {
        calls.push("commit");
      },
      async promote() {
        calls.push("promote");
      },
      async abort() {
        assert.fail("a Codex turn id must not conflict with its thread id");
      }
    }
  });
  assert.deepEqual(calls, ["register", "commit", "promote"]);
  assert.equal(session.threadId, undefined);
  assert.equal(session.backendBindings?.["codex-cli"], undefined);
}

async function assertNonAdvancingRotationCannotMutateEpoch(): Promise<void> {
  const session = rotationSession();
  const before = JSON.parse(JSON.stringify(session)) as StoredSession;
  const calls: string[] = [];
  await assert.rejects(
    rotateSessionContext(session, {
      reason: "agent-cache-reset",
      advanceContext: false,
      identityFactory: fixedRotationIdentity("commit-invalid-cache-mutation"),
      mutate(candidate) {
        candidate.contextId = "context-illegal";
        candidate.contextStartsAfterMessageId = "m1";
        candidate.workspaceFingerprint = "sha256:illegal";
        candidate.cwd = "/vault/illegal";
        candidate.generation = 99;
      },
      hooks: {
        async register() {
          calls.push("register");
        },
        async commit(input) {
          calls.push("commit");
          return;
        },
        async promote() {
          calls.push("promote");
        },
        async abort() {
          calls.push("abort");
        }
      }
    }),
    /agent-cache-reset cannot mutate context or workspace identity/
  );
  assert.deepEqual(
    calls,
    [],
    "invalid candidate must fail before Native registration"
  );
  assert.deepEqual(session, before, "invalid provisional mutations must never reach live state");
}

async function assertJournalledRotationCannotRewriteDurableRecords(): Promise<void> {
  for (const reason of ["start-new-context", "agent-cache-reset"] as const) {
    const session = rotationSession();
    const before = structuredClone(session);
    const calls: string[] = [];
    await assert.rejects(
      rotateSessionContext(session, {
        reason,
        advanceContext: reason === "start-new-context",
        identityFactory: fixedRotationIdentity(
          `commit-retain-${reason}`,
          reason === "start-new-context"
            ? `context-retain-${reason}`
            : undefined
        ),
        ...(reason === "start-new-context"
          ? {
            workspace: {
              vaultPath: "/vault",
              cwd: "/vault/workspace-a"
            }
          }
          : {}),
        mutate(candidate) {
          candidate.messages = [];
        },
        hooks: {
          async register() { calls.push("register"); },
          async commit() { calls.push("commit"); },
          async promote() { calls.push("promote"); },
          async abort() { calls.push("abort"); }
        }
      }),
      /must retain durable Conversation records/
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(session, before);
  }
}

async function assertRotationCannotMutateImmutableConversationIdentity(): Promise<void> {
  const mutations: Array<{
    label: string;
    mutate(session: StoredSession): void;
  }> = [
    { label: "id", mutate: (session) => { session.id = "other-conversation"; } },
    { label: "kind", mutate: (session) => { session.kind = "knowledge-base"; } },
    { label: "createdAt", mutate: (session) => { session.createdAt += 1; } }
  ];

  for (const mutation of mutations) {
    const session = rotationSession();
    const before = JSON.parse(JSON.stringify(session)) as StoredSession;
    const calls: string[] = [];
    await assert.rejects(
      rotateSessionContext(session, {
        reason: "agent-cache-reset",
        advanceContext: false,
        identityFactory: fixedRotationIdentity(`commit-invalid-${mutation.label}`),
        mutate: mutation.mutate,
        hooks: {
          async register() { calls.push("register"); },
          async commit() {
            calls.push("commit");
            assert.fail("invalid Conversation identity must not reach commit");
          },
          async promote() { calls.push("promote"); },
          async abort() { calls.push("abort"); }
        }
      }),
      /cannot mutate immutable Conversation identity/
    );
    assert.deepEqual(
      calls,
      [],
      "invalid immutable identity must fail before Native registration"
    );
    assert.deepEqual(session, before);
  }
}

async function assertWorkspaceClearAdvancesAndInvalidatesAllBindings(): Promise<void> {
  const session = rotationSession();
  const result = await rotateSessionContext(session, {
    reason: "workspace-clear",
    advanceContext: true,
    identityFactory: fixedRotationIdentity(
      "commit-workspace-cleared",
      "context-workspace-cleared"
    ),
    workspace: null,
    hooks: {
      async register() {},
      async commit(input) {
        assert.equal(input.session.cwd, "");
        assert.equal(input.session.workspaceFingerprint, undefined);
        assert.equal(input.session.backendBindings, undefined);
        return;
      },
      async promote() {},
      async abort() {
        assert.fail("valid workspace clear must not abort");
      }
    }
  });

  assert.equal(result.generation, 3);
  assert.equal(session.cwd, "");
  assert.equal(session.workspaceFingerprint, undefined);
  assert.equal(session.backendBindings, undefined);
  assert.equal(session.threadId, undefined);
}

async function assertHistoryRestoreExcludesRestoredMessagesFromModelContext(): Promise<void> {
  const invalid = rotationSession();
  const invalidBefore = JSON.parse(JSON.stringify(invalid)) as StoredSession;
  const invalidCalls: string[] = [];
  await assert.rejects(
    rotateSessionContext(invalid, {
      reason: "history-restore",
      advanceContext: true,
      identityFactory: fixedRotationIdentity(
        "commit-history-invalid",
        "context-history-invalid"
      ),
      contextStartsAfterMessageId: "wrong-restored-boundary",
      mutate(target) {
        target.messages = [
          { id: "restored-invalid", role: "user", text: "restored", createdAt: 10 }
        ];
      },
      hooks: {
        async register() {
          invalidCalls.push("register");
        },
        async commit(input) {
          invalidCalls.push("commit");
          return;
        },
        async promote() {
          invalidCalls.push("promote");
        },
        async abort() {
          invalidCalls.push("abort");
        }
      }
    }),
    /history-restore boundary must match the last restored message/
  );
  assert.deepEqual(
    invalidCalls,
    [],
    "invalid restored boundary must fail before Native registration"
  );
  assert.deepEqual(invalid, invalidBefore);

  const session = rotationSession();
  session.contextStartsAfterMessageId = "m2";
  const calls: string[] = [];
  await rotateSessionContext(session, {
    reason: "history-restore",
    advanceContext: true,
    identityFactory: fixedRotationIdentity(
      "commit-history-restored",
      "context-history-restored"
    ),
    contextStartsAfterMessageId: "restored-m2",
    mutate(target) {
      target.messages = [
        { id: "restored-m1", role: "user", text: "restored question", createdAt: 10 },
        { id: "restored-m2", role: "assistant", text: "restored answer", createdAt: 11 }
      ];
    },
    hooks: {
      async register() {
        calls.push("register");
      },
      async commit(input) {
        calls.push("commit");
        assert.deepEqual(
          input.session.messages.map((message) => message.id),
          ["restored-m1", "restored-m2"]
        );
        assert.equal(input.session.contextStartsAfterMessageId, "restored-m2");
        return;
      },
      async promote() {
        calls.push("promote");
      },
      async abort() {
        assert.fail("valid history restore must not abort");
      }
    }
  });

  assert.deepEqual(calls, ["register", "commit", "promote"]);
  assert.equal(session.contextStartsAfterMessageId, "restored-m2");
  assert.equal(session.contextId, "context-history-restored");
  assert.deepEqual(
    messagesInCurrentSessionContext(session),
    [],
    "restored messages remain visible but must not become model context"
  );
  session.messages.push({
    id: "post-restore-m3",
    role: "user",
    text: "new message after restore",
    createdAt: 12
  });
  assert.deepEqual(
    messagesInCurrentSessionContext(session).map((message) => message.id),
    ["post-restore-m3"],
    "messages added after history restore must enter the new model context"
  );
}

async function assertRotationRejectedBeforeHooks(
  options: Omit<RotateSessionContextOptions, "hooks">,
  expected: RegExp
): Promise<void> {
  const calls: string[] = [];
  await assert.rejects(
    rotateSessionContext(rotationSession(), {
      ...options,
      hooks: {
        async register() {
          calls.push("register");
        },
        async commit(input) {
          calls.push("commit");
          return;
        },
        async promote() {
          calls.push("promote");
        },
        async abort() {
          calls.push("abort");
        }
      }
    }),
    expected
  );
  assert.deepEqual(calls, [], "invalid rotation identity must be rejected before retirement registration");
}

function fixedRotationIdentity(commitId: string, contextId?: string) {
  return {
    commitId: () => commitId,
    ...(contextId ? { contextId: () => contextId } : {})
  };
}

async function assertConversationContextFieldsRoundTripAndCas(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-cas-"));
  try {
    let failBeforeCommitMarker = false;
    let failAfterCommitMarker = false;
    const store = new FileConversationStore({
      rootPath,
      now: () => 500,
      beforeContextCommitMarker: () => {
        if (failBeforeCommitMarker) throw new Error("fault before context commit marker");
      },
      afterContextCommitMarker: () => {
        if (failAfterCommitMarker) throw new Error("fault after context commit marker");
      }
    });
    const session = rotationSession();
    await seedConversationStore(store, session);
    for (let save = 0; save < 100; save += 1) {
      await store.upsertSession({ ...session, updatedAt: 3 + save });
    }
    assert.equal(
      (await readdir(path.join(
        rootPath,
        "sessions",
        session.id,
        "context-payloads"
      ))).length,
      2,
      "100 repeated saves in one context must not grow beyond the seeded active and previous payloads"
    );
    const restored = await store.readSession(session.id);

    assert.equal(restored?.generation, 2);
    assert.equal(restored?.contextId, "context-old");
    assert.equal(restored?.commitId, "commit-old");
    assert.equal(
      restored?.workspaceFingerprint,
      workspaceFingerprint({ vaultPath: "/vault", cwd: "/vault/workspace-a" })
    );
    assert.equal(
      restored?.backendBindings?.["codex-cli"]?.workspaceFingerprint,
      workspaceFingerprint({ vaultPath: "/vault", cwd: "/vault/workspace-a" })
    );

    const target: StoredSession = {
      ...session,
      generation: 3,
      revision: 3,
      contextId: "context-next",
      contextStartsAfterMessageId: "m2",
      commitId: "commit-next",
      backendBindings: undefined,
      contextSnapshot: undefined,
      rollingSummary: undefined,
      updatedAt: 501
    };
    failBeforeCommitMarker = true;
    await assert.rejects(
      store.commitSessionContext(target, {
        expectedGeneration: 2,
        expectedCommitId: "commit-old",
        expectedContentRevision: createConversationContentRevision(restored!)
      }),
      /fault before context commit marker/
    );
    const afterFault = await store.readSession(session.id);
    assert.equal(afterFault?.generation, 2);
    assert.equal(afterFault?.commitId, "commit-old");
    assert.deepEqual(
      afterFault?.messages.map((message) => message.id),
      ["m1", "m2"],
      "a pre-marker crash must keep reading the previous commit-addressed payload"
    );

    failBeforeCommitMarker = false;
    failAfterCommitMarker = true;
    const receipt = await store.commitSessionContext(target, {
      expectedGeneration: 2,
      expectedCommitId: "commit-old",
      expectedContentRevision: createConversationContentRevision(restored!)
    });
    assert.equal(receipt.generation, 3);
    assert.equal(receipt.commitId, "commit-next");
    assert.equal(
      (await store.readSession(session.id))?.commitId,
      "commit-next",
      "a post-marker observer failure cannot reverse a committed context"
    );
    assert.equal((await store.readSession(session.id))?.contextStartsAfterMessageId, "m2");

    await assert.rejects(
      store.commitSessionContext({
        ...target,
        contextId: "context-illegal-same-generation",
        commitId: "commit-illegal-same-generation"
      }, {
        expectedGeneration: 3,
        expectedCommitId: "commit-next",
        expectedContentRevision: createConversationContentRevision(target)
      }),
      /Same-generation context commit cannot change context or workspace identity/
    );
    await assert.rejects(
      store.commitSessionContext({
        ...target,
        generation: 4,
        revision: 4,
        commitId: "commit-illegal-reused-context"
      }, {
        expectedGeneration: 3,
        expectedCommitId: "commit-next",
        expectedContentRevision: createConversationContentRevision(target)
      }),
      /Advanced context generation requires a new contextId/
    );
    await assert.rejects(
      store.commitSessionContext({ ...target, commitId: "commit-stale" }, {
        expectedGeneration: 2,
        expectedCommitId: "commit-old",
        expectedContentRevision: createConversationContentRevision(target)
      }),
      ConversationContextConflictError
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertCommittedPayloadReadsFailClosed(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-payload-read-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 800 });
    const initial = rotationSession();
    await seedConversationStore(store, initial);
    const active = nextContextSession(initial, "payload-active", 801);
    await store.commitSessionContext(active, {
      expectedGeneration: 2,
      expectedCommitId: "commit-old",
      expectedContentRevision: createConversationContentRevision(initial)
    });

    const metadata = await readPayloadMetadata(rootPath, active.id);
    assert.ok(metadata.payloadKey);
    assert.ok(metadata.previousPayloadKey);
    assert.notEqual(metadata.payloadKey, metadata.previousPayloadKey);
    const activePayloadDir = contextPayloadDir(rootPath, active.id, metadata.payloadKey);
    const previousPayloadDir = contextPayloadDir(
      rootPath,
      active.id,
      metadata.previousPayloadKey
    );
    assert.equal((await readdir(previousPayloadDir)).length, 2);

    const messagesPath = path.join(activePayloadDir, "messages.jsonl");
    const snapshotsPath = path.join(activePayloadDir, "snapshots.jsonl");
    const messages = await readFile(messagesPath, "utf8");
    const snapshots = await readFile(snapshotsPath, "utf8");

    await rm(messagesPath, { force: true });
    const markerBeforeMissingPayloadSave = await readFile(
      path.join(rootPath, "sessions", active.id, "metadata.json"),
      "utf8"
    );
    const indexBeforeMissingPayloadSave = await readFile(
      path.join(rootPath, "index.json"),
      "utf8"
    );
    await assert.rejects(
      store.readSession(active.id),
      /Conversation recovery required: committed messages payload is missing/
    );
    await assert.rejects(
      store.upsertSession({ ...active, updatedAt: 802 }),
      /Conversation recovery required: committed messages payload is missing/
    );
    assert.equal(
      await readFile(path.join(rootPath, "sessions", active.id, "metadata.json"), "utf8"),
      markerBeforeMissingPayloadSave
    );
    assert.equal(await readFile(path.join(rootPath, "index.json"), "utf8"), indexBeforeMissingPayloadSave);
    await assert.rejects(readFile(messagesPath, "utf8"), { code: "ENOENT" });
    await writeFile(messagesPath, messages, "utf8");

    await rm(snapshotsPath, { force: true });
    await assert.rejects(
      store.readSession(active.id),
      /Conversation recovery required: committed snapshots payload is missing/
    );
    await writeFile(snapshotsPath, snapshots, "utf8");

    await writeFile(messagesPath, "{invalid-jsonl\n", "utf8");
    await assert.rejects(
      store.readSession(active.id),
      /Conversation recovery required: committed messages payload contains invalid JSONL/
    );
    assert.equal(await readFile(messagesPath, "utf8"), "{invalid-jsonl\n");
    const invalidMessageRow = `${JSON.stringify({ id: "missing-required-fields" })}\n`;
    await writeFile(messagesPath, invalidMessageRow, "utf8");
    await assert.rejects(
      store.readSession(active.id),
      /Conversation recovery required: committed messages payload contains invalid JSONL/
    );
    assert.equal(
      await readFile(messagesPath, "utf8"),
      invalidMessageRow,
      "parseable invalid message bytes must remain untouched for recovery"
    );
    await writeFile(messagesPath, messages, "utf8");
    const invalidSnapshotRow = `${JSON.stringify({
      sessionId: active.id,
      version: "missing-required-fields"
    })}\n`;
    await writeFile(snapshotsPath, invalidSnapshotRow, "utf8");
    await assert.rejects(
      store.readSession(active.id),
      /Conversation recovery required: committed snapshots payload contains invalid JSONL/
    );
    assert.equal(
      await readFile(snapshotsPath, "utf8"),
      invalidSnapshotRow,
      "parseable invalid snapshot bytes must remain untouched for recovery"
    );
    assert.ok(
      await readFile(path.join(previousPayloadDir, "messages.jsonl"), "utf8"),
      "the previous generation remains present but must never be an automatic read fallback"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertCommittedPayloadCollectionConsistency(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-payload-consistency-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 825 });
    const session = rotationSession();
    await seedConversationStore(store, session);
    const metadataPath = path.join(rootPath, "sessions", session.id, "metadata.json");
    const metadataText = await readFile(metadataPath, "utf8");
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    assert.equal(metadata.payloadVersion, 2);
    const payloadKey = String(metadata.payloadKey);
    const payloadDir = contextPayloadDir(rootPath, session.id, payloadKey);
    const messagesPath = path.join(payloadDir, "messages.jsonl");
    const snapshotsPath = path.join(payloadDir, "snapshots.jsonl");
    const messagesText = await readFile(messagesPath, "utf8");
    const snapshotsText = await readFile(snapshotsPath, "utf8");
    const messages = messagesText
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const snapshot = JSON.parse(snapshotsText.trim()) as Record<string, unknown>;

    await writeFile(
      messagesPath,
      `${JSON.stringify(messages[0])}\n${JSON.stringify({
        ...messages[1],
        id: messages[0]?.id
      })}\n`,
      "utf8"
    );
    await assert.rejects(
      store.readSession(session.id),
      /committed messages contain duplicate IDs/
    );
    await writeFile(messagesPath, messagesText, "utf8");

    await writeFile(metadataPath, JSON.stringify({
      ...metadata,
      contextStartsAfterMessageId: "missing-boundary"
    }), "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /context boundary is missing from committed messages/
    );
    await writeFile(metadataPath, metadataText, "utf8");

    await writeFile(metadataPath, JSON.stringify({
      ...metadata,
      contextSnapshot: {
        ...(metadata.contextSnapshot as Record<string, unknown>),
        currentState: "metadata-only mutation"
      }
    }), "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /metadata and payload snapshots are inconsistent/
    );
    await writeFile(metadataPath, metadataText, "utf8");

    await writeFile(snapshotsPath, "", "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /metadata and payload snapshots are inconsistent/
    );
    await writeFile(snapshotsPath, snapshotsText, "utf8");

    const reversedSnapshot = {
      ...snapshot,
      summarizedFromMessageId: "m2",
      summarizedThroughMessageId: "m1"
    };
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, contextSnapshot: reversedSnapshot }),
      "utf8"
    );
    await writeFile(snapshotsPath, `${JSON.stringify(reversedSnapshot)}\n`, "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /snapshot message range is outside the current context/
    );

    const wrongCountSnapshot = {
      ...snapshot,
      sourceMessageCount: 99
    };
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, contextSnapshot: wrongCountSnapshot }),
      "utf8"
    );
    await writeFile(snapshotsPath, `${JSON.stringify(wrongCountSnapshot)}\n`, "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /snapshot source message count is inconsistent/
    );

    await writeFile(metadataPath, metadataText, "utf8");
    await writeFile(snapshotsPath, snapshotsText, "utf8");
    assert.equal((await store.readSession(session.id))?.commitId, "commit-old");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertCandidatePayloadValidationPrecedesWrites(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-candidate-validation-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 835 });
    const duplicate = rotationSession();
    duplicate.messages = [
      duplicate.messages[0]!,
      { ...duplicate.messages[1]!, id: duplicate.messages[0]!.id }
    ];
    await assert.rejects(
      store.upsertSession(duplicate),
      /is missing; use createPristineSession/
    );
    await assert.rejects(
      store.createPristineSession(duplicate),
      /Pristine conversation create requires/
    );
    assert.deepEqual(
      await readdir(rootPath),
      [],
      "candidate validation must run before creating payload or index files"
    );

    const session = rotationSession();
    await seedConversationStore(store, session);
    const before = await conversationSessionSnapshot(rootPath, session.id);
    const indexBefore = await readFile(path.join(rootPath, "index.json"), "utf8");
    const invalidNestedMessage = JSON.parse(JSON.stringify(session)) as StoredSession;
    invalidNestedMessage.messages[0]!.attachments = [{
      type: "image",
      name: "",
      path: ""
    }];
    await assert.rejects(
      store.upsertSession(invalidNestedMessage),
      /message attachments is invalid/
    );
    assert.deepEqual(await conversationSessionSnapshot(rootPath, session.id), before);
    assert.equal(await readFile(path.join(rootPath, "index.json"), "utf8"), indexBefore);

    const invalidSnapshot = JSON.parse(JSON.stringify(session)) as StoredSession;
    invalidSnapshot.contextSnapshot = {
      ...invalidSnapshot.contextSnapshot!,
      summarizedFromMessageId: "missing-message",
      summarizedThroughMessageId: "m2",
      sourceMessageCount: 2
    };
    await assert.rejects(
      store.upsertSession(invalidSnapshot),
      /snapshot message range is outside the current context/
    );
    assert.deepEqual(await conversationSessionSnapshot(rootPath, session.id), before);
    assert.equal(await readFile(path.join(rootPath, "index.json"), "utf8"), indexBefore);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertPristineConversationCreateContract(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-pristine-create-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 840 });
    const fingerprint = workspaceFingerprint({
      vaultPath: "/vault",
      cwd: "/vault"
    });
    const pristine: StoredSession = {
      id: "runtime-pristine",
      title: "Runtime pristine",
      revision: 1,
      generation: 1,
      contextId: "context-pristine",
      commitId: "commit-pristine",
      workspaceFingerprint: fingerprint,
      cwd: "/vault",
      messages: [],
      createdAt: 1,
      updatedAt: 1
    };
    await store.createPristineSession(pristine);
    const before = await conversationSessionSnapshot(rootPath, pristine.id);
    const indexBefore = await readFile(path.join(rootPath, "index.json"), "utf8");

    await store.createPristineSession(pristine);
    assert.deepEqual(await conversationSessionSnapshot(rootPath, pristine.id), before);
    assert.equal(await readFile(path.join(rootPath, "index.json"), "utf8"), indexBefore);

    await assert.rejects(
      store.upsertSession({
        ...pristine,
        id: "unregistered-runtime-pristine",
        contextId: "context-unregistered",
        commitId: "commit-unregistered"
      }),
      /Conversation index is missing session unregistered-runtime-pristine/
    );
    await assert.rejects(
      store.createPristineSession({
        ...pristine,
        id: "partial-identity",
        contextId: "context-partial",
        commitId: undefined,
        workspaceFingerprint: undefined
      }),
      /Context identity must be either fully absent or fully specified/
    );
    const workspaceFreeShell: StoredSession = {
      id: "workspace-free-shell",
      title: "Workspace-free shell",
      revision: 1,
      generation: 1,
      cwd: "",
      messages: [],
      createdAt: 2,
      updatedAt: 2
    };
    await store.createPristineSession(workspaceFreeShell);
    const restoredShell = await store.readSession(workspaceFreeShell.id);
    assert.equal(restoredShell?.generation, 1);
    assert.equal(restoredShell?.revision, 1);
    assert.equal(restoredShell?.cwd, "");
    assert.equal(restoredShell?.contextId, undefined);
    assert.equal(restoredShell?.commitId, undefined);
    assert.equal(restoredShell?.workspaceFingerprint, undefined);
    assert.deepEqual(restoredShell?.messages, []);
    assert.equal(
      await store.readSession("unregistered-runtime-pristine"),
      null
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertOrphanAndDeleteFailClosed(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-orphan-delete-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 845 });
    const orphanId = "orphan-session";
    const orphanDir = path.join(rootPath, "sessions", orphanId);
    await mkdir(orphanDir, { recursive: true });
    const orphanEvidencePath = path.join(orphanDir, "recovery-evidence.bin");
    await writeFile(orphanEvidencePath, "retain-me", "utf8");
    await writeFile(path.join(rootPath, "index.json"), JSON.stringify({
      version: 1,
      updatedAt: 0,
      sessions: []
    }), "utf8");

    await assert.rejects(
      store.readSession(orphanId),
      /unindexed session directory orphan-session already exists/
    );
    await assert.rejects(
      store.upsertSession({ ...rotationSession(), id: orphanId }),
      /unindexed session directory orphan-session already exists/
    );
    await assert.rejects(
      store.deleteSession(orphanId),
      /unindexed session directory orphan-session already exists/
    );
    assert.equal(await readFile(orphanEvidencePath, "utf8"), "retain-me");

    const session = rotationSession();
    await seedConversationStore(store, session);
    const metadata = await readPayloadMetadata(rootPath, session.id);
    const sessionDir = path.join(rootPath, "sessions", session.id);
    const metadataPath = path.join(sessionDir, "metadata.json");
    const activeMessagesPath = path.join(
      contextPayloadDir(rootPath, session.id, metadata.payloadKey),
      "messages.jsonl"
    );
    const activeSnapshotsPath = path.join(
      contextPayloadDir(rootPath, session.id, metadata.payloadKey),
      "snapshots.jsonl"
    );
    const metadataText = await readFile(metadataPath, "utf8");
    const indexText = await readFile(path.join(rootPath, "index.json"), "utf8");
    const snapshotsText = await readFile(activeSnapshotsPath, "utf8");

    await rm(activeMessagesPath, { force: true });
    await assert.rejects(
      store.deleteSession(session.id),
      /committed messages payload is missing/
    );
    assert.equal(await readFile(metadataPath, "utf8"), metadataText);
    assert.equal(await readFile(path.join(rootPath, "index.json"), "utf8"), indexText);
    assert.equal(await readFile(activeSnapshotsPath, "utf8"), snapshotsText);

    await writeFile(
      activeMessagesPath,
      session.messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
      "utf8"
    );
    await rm(metadataPath, { force: true });
    await assert.rejects(
      store.deleteSession(session.id),
      /metadata for indexed conversation session-rotation is missing/
    );
    assert.equal(await readFile(path.join(rootPath, "index.json"), "utf8"), indexText);
    assert.ok(await readFile(activeMessagesPath, "utf8"));
    assert.equal(await readFile(activeSnapshotsPath, "utf8"), snapshotsText);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertConversationMetadataFailsClosed(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-metadata-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 850 });
    const session = rotationSession();
    await seedConversationStore(store, session);
    const metadataPath = path.join(
      rootPath,
      "sessions",
      session.id,
      "metadata.json"
    );
    const originalText = await readFile(metadataPath, "utf8");
    const original = JSON.parse(originalText) as Record<string, unknown>;
    const payloadsBefore = await payloadDirectoryKeys(rootPath, session.id);

    await writeFile(metadataPath, JSON.stringify({
      ...original,
      id: "different-session"
    }), "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /Conversation recovery required: metadata identity or core fields are invalid/
    );
    await assert.rejects(
      store.upsertSession({ ...session, updatedAt: 851 }),
      /Conversation recovery required: metadata identity or core fields are invalid/
    );
    assert.deepEqual(await payloadDirectoryKeys(rootPath, session.id), payloadsBefore);

    await writeFile(metadataPath, JSON.stringify({
      ...original,
      payloadKey: undefined,
      previousPayloadKey: original.payloadKey
    }), "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /previous payload pointer exists without an active payload pointer/
    );
    await assert.rejects(
      store.upsertSession({ ...session, updatedAt: 852 }),
      /previous payload pointer exists without an active payload pointer/
    );
    assert.deepEqual(await payloadDirectoryKeys(rootPath, session.id), payloadsBefore);

    await writeFile(metadataPath, JSON.stringify({
      ...original,
      commitId: "commit-does-not-match-active-pointer"
    }), "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /active payload pointer does not match commitId/
    );
    assert.deepEqual(await payloadDirectoryKeys(rootPath, session.id), payloadsBefore);

    const invalidGenerationText = JSON.stringify({
      ...original,
      generation: 0
    });
    await writeFile(metadataPath, invalidGenerationText, "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /Conversation recovery required: metadata generation is invalid/
    );
    assert.equal(await readFile(metadataPath, "utf8"), invalidGenerationText);

    const invalidBindingText = JSON.stringify({
      ...original,
      backendBindings: {
        "codex-cli": {
          backendId: "different-backend",
          syncedSessionRevision: 2,
          lastUsedAt: 2
        }
      }
    });
    await writeFile(metadataPath, invalidBindingText, "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /Conversation recovery required: backend binding identity is invalid/
    );
    assert.equal(await readFile(metadataPath, "utf8"), invalidBindingText);

    const invalidSnapshotText = JSON.stringify({
      ...original,
      contextSnapshot: {
        sessionId: session.id,
        version: "missing-required-fields"
      }
    });
    await writeFile(metadataPath, invalidSnapshotText, "utf8");
    await assert.rejects(
      store.readSession(session.id),
      /Conversation recovery required: committed context snapshot is invalid/
    );
    assert.equal(await readFile(metadataPath, "utf8"), invalidSnapshotText);

    await writeFile(metadataPath, originalText, "utf8");
    assert.equal((await store.readSession(session.id))?.commitId, "commit-old");
    const indexBeforeMissingMetadata = await readFile(path.join(rootPath, "index.json"), "utf8");
    await rm(metadataPath, { force: true });
    await assert.rejects(
      store.readSession(session.id),
      /metadata for indexed conversation session-rotation is missing/
    );
    assert.equal(
      await readFile(path.join(rootPath, "index.json"), "utf8"),
      indexBeforeMissingMetadata
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertConversationGenerationEvidenceFailsClosed(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-context-generation-evidence-"
  ));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 855 });
    const session: StoredSession = {
      ...rotationSession(),
      messages: [],
      contextSnapshot: undefined,
      rollingSummary: undefined
    };
    await seedConversationStore(store, session);
    const metadataPath = path.join(
      rootPath,
      "sessions",
      session.id,
      "metadata.json"
    );
    const original = JSON.parse(
      await readFile(metadataPath, "utf8")
    ) as Record<string, unknown>;

    const revisionOnly = { ...original };
    delete revisionOnly.generation;
    await writeFile(metadataPath, JSON.stringify(revisionOnly), "utf8");
    const restoredRevisionOnly = await store.readSession(session.id);
    assert.equal(restoredRevisionOnly?.revision, 2);
    assert.equal(restoredRevisionOnly?.generation, undefined);
    assert.equal((await store.proveSessionContextAuthority({
      conversationId: session.id,
      targetGeneration: 2,
      targetContextId: session.contextId,
      targetCommitId: session.commitId!,
      targetWorkspaceFingerprint: session.workspaceFingerprint
    })).relation, "exact");

    const generationOnly = { ...original };
    delete generationOnly.revision;
    await writeFile(metadataPath, JSON.stringify(generationOnly), "utf8");
    const restoredGenerationOnly = await store.readSession(session.id);
    assert.equal(restoredGenerationOnly?.revision, undefined);
    assert.equal(restoredGenerationOnly?.generation, 2);
    assert.equal((await store.proveSessionContextAuthority({
      conversationId: session.id,
      targetGeneration: 2,
      targetContextId: session.contextId,
      targetCommitId: session.commitId!,
      targetWorkspaceFingerprint: session.workspaceFingerprint
    })).relation, "exact");

    for (const [revision, generation] of [[2, 3], [3, 2]] as const) {
      const conflictingText = JSON.stringify({
        ...original,
        revision,
        generation
      });
      await writeFile(metadataPath, conflictingText, "utf8");
      await assert.rejects(
        store.readSession(session.id),
        /Conversation recovery required: metadata revision and generation are inconsistent/
      );
      await assert.rejects(
        store.proveSessionContextAuthority({
          conversationId: session.id,
          targetGeneration: 3,
          targetContextId: session.contextId,
          targetCommitId: session.commitId!,
          targetWorkspaceFingerprint: session.workspaceFingerprint
        }),
        /Conversation recovery required: metadata revision and generation are inconsistent/
      );
      assert.equal(await readFile(metadataPath, "utf8"), conflictingText);
    }

    await writeFile(metadataPath, JSON.stringify({
      ...original,
      revision: 2,
      generation: 3
    }), "utf8");
    let providerCleanupCalls = 0;
    let quarantinedRetirements = 0;
    await assert.rejects(
      reconcileNativeExecutionsAtStartup({
        async listAwaitingRetirements() {
          return [generationEvidenceRetirement(session)];
        },
        async proveConversationAuthority(probe) {
          return await store.proveSessionContextAuthority(probe);
        },
        async promoteRetirement() {
          throw new Error("conflicting generation evidence must not promote");
        },
        async abortRetirement() {
          throw new Error("conflicting generation evidence must not abort");
        },
        async quarantineRetirement() {
          quarantinedRetirements += 1;
        },
        async cleanupDue() {
          providerCleanupCalls += 1;
          return [];
        }
      }),
      /Conversation authority proof failed: Conversation recovery required: metadata revision and generation are inconsistent/
    );
    assert.equal(quarantinedRetirements, 1);
    assert.equal(
      providerCleanupCalls,
      0,
      "conflicting durable generation evidence must block provider cleanup"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertConversationAuthorityProofRelations(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-authority-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 860 });
    const initial = rotationSession();
    await seedConversationStore(store, initial);
    const exact = await store.proveSessionContextAuthority({
      conversationId: initial.id,
      targetGeneration: 2,
      targetContextId: "context-old",
      targetCommitId: "commit-old",
      targetWorkspaceFingerprint: initial.workspaceFingerprint
    });
    assert.equal(exact.relation, "exact");
    assert.equal(exact.targetPayload, "active");

    const before = await store.proveSessionContextAuthority({
      conversationId: initial.id,
      targetGeneration: 3,
      targetContextId: "context-next-authority",
      targetCommitId: "commit-next-authority",
      targetWorkspaceFingerprint: initial.workspaceFingerprint
    });
    assert.equal(before.relation, "before");
    assert.equal(before.targetPayload, "absent");

    const target = nextContextSession(initial, "next-authority", 861);
    await store.commitSessionContext(target, {
      expectedGeneration: 2,
      expectedCommitId: "commit-old",
      expectedContentRevision: createConversationContentRevision(initial)
    });
    const later = await store.proveSessionContextAuthority({
      conversationId: initial.id,
      targetGeneration: 2,
      targetContextId: "context-old",
      targetCommitId: "commit-old",
      targetWorkspaceFingerprint: initial.workspaceFingerprint
    });
    assert.equal(later.relation, "later");
    assert.equal(later.targetPayload, "previous");

    const conflict = await store.proveSessionContextAuthority({
      conversationId: initial.id,
      targetGeneration: 3,
      targetContextId: target.contextId,
      targetCommitId: "commit-conflicting-authority",
      targetWorkspaceFingerprint: target.workspaceFingerprint
    });
    assert.equal(conflict.relation, "conflict");
    assert.equal(conflict.targetPayload, "absent");

    await assert.rejects(
      store.proveSessionContextAuthority({
        conversationId: "missing-conversation",
        targetGeneration: 1,
        targetCommitId: "missing-commit"
      }),
      /Conversation index is missing session missing-conversation/
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

function generationEvidenceRetirement(session: StoredSession): NativeExecutionRecord {
  return {
    id: "generation-evidence-retirement",
    runId: "generation-evidence-run",
    sessionId: session.id,
    surface: "chat",
    workflow: "chat.generic",
    native: {
      backendId: "opencode",
      id: "generation-evidence-native",
      kind: "session",
      persistence: "provider-persistent",
      providerEndpoint: "http://127.0.0.1:4096",
      deviceKey: "test-device",
      vaultId: "/vault",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "leased-conversation",
      preferredDisposition: ["delete"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    runOutcome: "success",
    localCommit: "committed",
    cleanup: "awaiting-local-commit",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt: 1,
    settledAt: 2,
    committedAt: 2,
    disposedAt: 0,
    retirement: {
      targetConversationId: session.id,
      targetGeneration: 3,
      targetContextId: session.contextId,
      targetCommitId: session.commitId!,
      targetWorkspaceFingerprint: session.workspaceFingerprint,
      reason: "context-rotation"
    }
  };
}

async function assertSettingsHydrationPropagatesConversationRecoveryErrors(): Promise<void> {
  const source = await readFile("src/plugin/settings-store.ts", "utf8");
  const hydrateBody = source.match(
    /private async reconcileAndHydrateConversationSessions\(\): Promise<number> \{([\s\S]*?)\n  \}/
  )?.[1] ?? "";
  assert.match(
    hydrateBody,
    /await this\.getConversationStore\(\)\.reconcileCommittedSessionsAtStartup\(\)/
  );
  assert.match(
    hydrateBody,
    /data shell \$\{session\.id\} lacks durable authority/
  );
  assert.doesNotMatch(
    hydrateBody,
    /reconcileCommittedSessionsAtStartup\(\)\.catch/,
    "invalid committed payloads must stop hydration instead of becoming empty conversations"
  );
}

async function assertConcurrentSessionUpsertsPreserveIndex(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-index-lane-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 870 });
    const sessionA: StoredSession = {
      ...rotationSession(),
      id: "session-concurrent-a",
      contextId: "context-concurrent-a",
      commitId: "commit-concurrent-a",
      contextSnapshot: undefined,
      rollingSummary: undefined,
      backendBindings: undefined,
      threadId: undefined
    };
    const sessionB: StoredSession = {
      ...rotationSession(),
      id: "session-concurrent-b",
      contextId: "context-concurrent-b",
      commitId: "commit-concurrent-b",
      contextSnapshot: undefined,
      rollingSummary: undefined,
      backendBindings: undefined,
      threadId: undefined
    };
    await Promise.all([
      seedConversationStore(store, sessionA),
      seedConversationStore(store, sessionB)
    ]);
    assert.deepEqual(
      (await store.readIndex()).sessions.map((summary) => summary.sessionId).sort(),
      [sessionA.id, sessionB.id]
    );

    await Promise.all([
      store.upsertSession({
        ...sessionA,
        messages: [
          ...sessionA.messages,
          { id: "concurrent-a-new", role: "user", text: "A", createdAt: 3 }
        ],
        updatedAt: 871
      }),
      store.upsertSession({
        ...sessionB,
        messages: [
          ...sessionB.messages,
          { id: "concurrent-b-new", role: "user", text: "B", createdAt: 3 }
        ],
        updatedAt: 872
      })
    ]);
    const summaries = await store.readIndex();
    assert.equal(summaries.sessions.length, 2);
    assert.equal(summaries.sessions.find((item) => item.sessionId === sessionA.id)?.messageCount, 3);
    assert.equal(summaries.sessions.find((item) => item.sessionId === sessionB.id)?.messageCount, 3);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertOrdinaryUpsertCannotChangeContextIdentity(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-upsert-guard-"));
  const legacyRootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-context-legacy-upsert-guard-"
  ));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 875 });
    const current = rotationSession();
    await seedConversationStore(store, current);

    const attempts: StoredSession[] = [
      nextContextSession(current, "ordinary-advance", 876),
      {
        ...current,
        commitId: "commit-same-generation-different",
        updatedAt: 877
      },
      {
        ...current,
        revision: 1,
        generation: 1,
        updatedAt: 878
      },
      {
        ...current,
        contextId: "context-changed-without-cas",
        updatedAt: 879
      },
      {
        ...current,
        cwd: "/vault/workspace-b",
        updatedAt: 880
      }
    ];
    for (const attempt of attempts) {
      await assert.rejects(
        store.upsertSession(attempt),
        /Conversation context identity changed outside a CAS context commit/
      );
      assert.equal((await store.readSession(current.id))?.commitId, "commit-old");
      assert.equal((await store.readSession(current.id))?.generation, 2);
    }

    const legacy = {
      ...rotationSession(),
      id: "session-legacy-no-commit",
      commitId: undefined,
      contextId: undefined,
      workspaceFingerprint: undefined,
      cwd: "",
      generation: 1,
      revision: 1,
      contextSnapshot: {
        ...rotationSession().contextSnapshot!,
        sessionId: "session-legacy-no-commit",
        generation: 1,
        contextId: undefined
      }
    };
    await writeLegacyConversationFixture(legacyRootPath, legacy);
    const legacyStore = new FileConversationStore({
      rootPath: legacyRootPath,
      now: () => 881
    });
    await assert.rejects(
      legacyStore.upsertSession({
        ...legacy,
        commitId: "commit-first-must-use-cas",
        updatedAt: 881
      }),
      /Conversation context identity changed outside a CAS context commit/
    );
    assert.equal((await legacyStore.readSession(legacy.id))?.commitId, undefined);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
    await rm(legacyRootPath, { recursive: true, force: true });
  }
}

async function assertOrdinaryFirstSaveCannotBeOverwrittenByRotation(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-ordinary-first-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 885 });
    const live = rotationSession();
    await seedConversationStore(store, live);
    let registerReached!: () => void;
    let releaseRegistration!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      registerReached = resolve;
    });
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let aborted = false;
    const rotation = rotateSessionContext(live, {
      reason: "agent-cache-reset",
      advanceContext: false,
      identityFactory: fixedRotationIdentity("commit-ordinary-first-rotation"),
      hooks: {
        async register() {
          registerReached();
          await registrationGate;
        },
        async commit(input) {
          await store.commitSessionContext(input.session, {
            expectedGeneration: input.expectedGeneration,
            expectedCommitId: input.expectedCommitId,
            expectedContentRevision: input.expectedContentRevision
          });
        },
        async promote() {
          assert.fail("a stale rotation must not promote retirements");
        },
        async abort() {
          aborted = true;
        }
      }
    });
    await registrationStarted;

    live.title = "ordinary save won";
    live.messages.push({
      id: "ordinary-first-message",
      role: "user",
      text: "must survive the stale rotation",
      createdAt: 884
    });
    live.updatedAt = 884;
    await store.upsertSession(live);
    releaseRegistration();

    await assert.rejects(
      rotation,
      /changed before context commit/,
      "a rotation snapshot must conflict when an ordinary body save commits first"
    );
    assert.equal(aborted, true);
    const durable = await store.readSession(live.id);
    assert.equal(durable?.title, "ordinary save won");
    assert.equal(durable?.messages.at(-1)?.id, "ordinary-first-message");
    assert.equal(live.title, "ordinary save won");
    assert.equal(live.messages.at(-1)?.id, "ordinary-first-message");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertLeaseRolloverUsesDurableBaselineWithRunningAssistant(): Promise<void> {
  const storageRootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-v2-running-"));
  try {
    const store = new FileConversationStoreV2LiveAdapter(storageRootPath);
    const workspace = {
      vaultPath: "/vault",
      cwd: "/vault/workspace-a"
    };
    const fingerprint = workspaceFingerprint(workspace);
    const live: StoredSession = {
      id: "session-v2-running-rollover",
      kind: "knowledge-base",
      title: "Knowledge",
      revision: 1,
      generation: 1,
      contextId: "context-v2-running-rollover",
      commitId: "commit-v2-running-rollover",
      workspaceFingerprint: fingerprint,
      cwd: workspace.cwd,
      messages: [],
      backendBindings: {
        "codex-cli": {
          backendId: "codex-cli",
          nativeThreadId: "thread-v2-running-rollover",
          syncedSessionRevision: 1,
          workspaceFingerprint: fingerprint,
          lastUsedAt: 1
        }
      },
      createdAt: 1,
      updatedAt: 1
    };
    await store.createPristineSession(live);

    live.messages.push(
      { id: "m1", role: "user", text: "previous question", createdAt: 2 },
      { id: "m2", role: "assistant", text: "previous answer", createdAt: 3 }
    );
    live.updatedAt = 3;
    await store.persistSettingsSessions({ sessions: [live] });

    live.messages.push(
      { id: "m3", role: "user", text: "/ask follow up", createdAt: 4 },
      {
        id: "m4",
        role: "assistant",
        text: "正在识别命令并执行...",
        status: "running",
        createdAt: 4
      }
    );
    const liveMessages = live.messages;
    const runningAssistant = live.messages.at(-1)!;
    live.updatedAt = 4;
    await store.persistSettingsSessions({ sessions: [live] });
    assert.deepEqual(
      (await store.readSession(live.id))?.messages.map((message) => message.id),
      ["m1", "m2", "m3"],
      "Conversation V2 must keep the running assistant only in live UI state"
    );
    const durable = await store.readSession(live.id);
    assert.ok(durable);
    await assert.rejects(
      store.persistSettingsSessions({
        sessions: [{
          ...live,
          commitId: "commit-v2-running-rollover-forged",
          messages: [
            ...live.messages,
            { id: "m5", role: "user", text: "forged append", createdAt: 5 }
          ],
          updatedAt: 5
        }]
      }),
      /同 generation 不能改变 context\/workspace identity/,
      "an ordinary save must not gain same-generation Context commit authority"
    );
    await assert.rejects(
      store.commitSessionContext({
        ...live,
        commitId: "commit-v2-running-rollover-foreign",
        cwd: "/vault/workspace-b",
        workspaceFingerprint: workspaceFingerprint({
          vaultPath: workspace.vaultPath,
          cwd: "/vault/workspace-b"
        })
      }, {
        expectedGeneration: 1,
        expectedCommitId: "commit-v2-running-rollover",
        expectedContentRevision:
          durableConversationContentRevisionForLiveSession(live, durable)
      }),
      /同 generation 不能改变 context\/workspace identity/,
      "same-generation Context authority must not permit a workspace rewrite"
    );

    const rotation = await rotateEchoInkSessionContext({
      async registerNativeExecutionRetirements() {},
      async promoteNativeExecutionRetirements() {},
      async abortNativeExecutionRetirements() {},
      async cleanupNativeExecutionRecord() {}
    } as never, {
      async readConversationSession(sessionId: string) {
        return await store.readSession(sessionId);
      },
      async withConversationMutation<T>(
        _conversationId: string,
        action: (authority: ConversationMutationAuthority) => Promise<T>
      ): Promise<T> {
        return await action({} as ConversationMutationAuthority);
      },
      async commitConversationSessionContext(
        candidate: StoredSession,
        options: Parameters<
          FileConversationStoreV2LiveAdapter["commitSessionContext"]
        >[1]
      ) {
        return await store.commitSessionContext(candidate, options);
      }
    } as never, live, {
      reason: "lease-rollover",
      advanceContext: false,
      retireBackendIds: ["codex-cli"]
    });

    assert.equal(live.commitId, rotation.commitId);
    assert.match(live.commitId ?? "", /^context-commit-/);
    assert.notEqual(live.commitId, "commit-v2-running-rollover");
    assert.equal(live.backendBindings?.["codex-cli"], undefined);
    assert.equal(
      live.messages,
      liveMessages,
      "lease rollover must preserve the live message array identity"
    );
    assert.equal(live.messages.at(-1)?.id, "m4");
    assert.equal(
      live.messages.at(-1),
      runningAssistant,
      "lease rollover must preserve the running assistant object identity"
    );
    assert.equal(live.messages.at(-1)?.status, "running");
    assert.deepEqual(
      (await store.readSession(live.id))?.messages.map((message) => message.id),
      ["m1", "m2", "m3"],
      "lease rollover must not make the running assistant durable"
    );

    const terminalAt = live.updatedAt + 1;
    runningAssistant.status = "completed";
    runningAssistant.text = "KB_ASK_RECOVERY_FIXED_OK";
    runningAssistant.completedAt = terminalAt;
    live.updatedAt = terminalAt;
    await store.persistSettingsSessions({ sessions: [live] });
    const terminal = await store.readSession(live.id);
    assert.equal(terminal?.messages.at(-1)?.id, "m4");
    assert.equal(terminal?.messages.at(-1)?.status, "completed");
    assert.equal(
      terminal?.messages.at(-1)?.text,
      "KB_ASK_RECOVERY_FIXED_OK",
      "the original running assistant reference must remain the terminal carrier"
    );
  } finally {
    await rm(storageRootPath, { recursive: true, force: true });
  }
}

async function assertQueuedStaleSaveCannotOverwriteCommittedRotation(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-save-race-"));
  try {
    let pauseBeforeMarker = false;
    let releaseMarker!: () => void;
    let markerReached!: () => void;
    const markerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const markerStarted = new Promise<void>((resolve) => {
      markerReached = resolve;
    });
    const store = new FileConversationStore({
      rootPath,
      now: () => 890,
      beforeContextCommitMarker: async () => {
        if (!pauseBeforeMarker) return;
        markerReached();
        await markerGate;
      }
    });
    const initial = rotationSession();
    await seedConversationStore(store, initial);
    const target = nextContextSession(initial, "race-target", 891);

    await assert.rejects(
      store.upsertSession(target),
      /Conversation context identity changed outside a CAS context commit/
    );
    assert.equal((await store.readSession(initial.id))?.commitId, "commit-old");

    pauseBeforeMarker = true;
    const commit = store.commitSessionContext(target, {
      expectedGeneration: 2,
      expectedCommitId: "commit-old",
      expectedContentRevision: createConversationContentRevision(initial)
    });
    await markerStarted;
    const staleSave = store.upsertSession({
      ...initial,
      messages: [
        ...initial.messages,
        { id: "stale-save", role: "user", text: "must not overwrite", createdAt: 3 }
      ],
      updatedAt: 892
    });
    releaseMarker();

    const receipt = await commit;
    assert.equal(receipt.commitId, target.commitId);
    await assert.rejects(
      staleSave,
      /Conversation context identity changed outside a CAS context commit/
    );
    const committed = await store.readSession(initial.id);
    assert.equal(committed?.commitId, target.commitId);
    assert.equal(committed?.generation, 3);
    assert.doesNotMatch(
      committed?.messages.map((message) => message.id).join(",") ?? "",
      /stale-save/
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertContextPayloadRetention(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-retention-"));
  try {
    const store = new FileConversationStore({ rootPath, now: () => 900 });
    let current = rotationSession();
    await seedConversationStore(store, current);
    const legacyMessagesPath = path.join(
      rootPath,
      "sessions",
      current.id,
      "messages.jsonl"
    );
    const legacySnapshotsPath = path.join(
      rootPath,
      "sessions",
      current.id,
      "snapshots.jsonl"
    );
    await writeFile(legacyMessagesPath, "legacy-messages-must-survive\n", "utf8");
    await writeFile(legacySnapshotsPath, "legacy-snapshots-must-survive\n", "utf8");

    for (let rotation = 1; rotation <= 3; rotation += 1) {
      const beforeMetadata = await readPayloadMetadata(rootPath, current.id);
      const target = nextContextSession(current, `retention-${rotation}`, 900 + rotation);
      await store.commitSessionContext(target, {
        expectedGeneration: current.generation ?? 0,
        expectedCommitId: current.commitId,
        expectedContentRevision: createConversationContentRevision(current)
      });
      const metadata = await readPayloadMetadata(rootPath, current.id);
      assert.equal(
        metadata.previousPayloadKey,
        beforeMetadata.payloadKey,
        "the prior active payload must become the explicit rollback generation"
      );
      assert.deepEqual(
        await payloadDirectoryKeys(rootPath, current.id),
        [metadata.payloadKey, metadata.previousPayloadKey].sort(),
        "three rotations must retain only the active and previous payload generations"
      );
      if (rotation === 1) {
        const beforeReuseAttempt = await conversationSessionSnapshot(rootPath, current.id);
        const indexBeforeReuseAttempt = await readFile(path.join(rootPath, "index.json"), "utf8");
        await assert.rejects(
          store.commitSessionContext({
            ...nextContextSession(target, "reuse-previous", 950),
            commitId: "commit-old"
          }, {
            expectedGeneration: target.generation ?? 0,
            expectedCommitId: target.commitId,
            expectedContentRevision: createConversationContentRevision(target)
          }),
          /Context commitId reuses an active or previous payload generation/
        );
        assert.deepEqual(
          await conversationSessionSnapshot(rootPath, current.id),
          beforeReuseAttempt,
          "A to B followed by an attempted reuse of A must be a zero-mutation conflict"
        );
        assert.equal(await readFile(path.join(rootPath, "index.json"), "utf8"), indexBeforeReuseAttempt);
      }
      current = target;
    }

    const metadata = await readPayloadMetadata(rootPath, current.id);
    for (const payloadKey of [metadata.payloadKey, metadata.previousPayloadKey]) {
      const persistedMessages = await readFile(
        path.join(contextPayloadDir(rootPath, current.id, payloadKey), "messages.jsonl"),
        "utf8"
      );
      assert.deepEqual(
        persistedMessages
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { id: string }).id),
        ["m1", "m2"],
        "both retained generations must contain the complete conversation history"
      );
    }
    assert.equal(await readFile(legacyMessagesPath, "utf8"), "legacy-messages-must-survive\n");
    assert.equal(await readFile(legacySnapshotsPath, "utf8"), "legacy-snapshots-must-survive\n");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertContextPayloadGcRetriesAfterCommit(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-context-gc-retry-"));
  try {
    let failGc = false;
    let gcAttempts = 0;
    const store = new FileConversationStore({
      rootPath,
      now: () => 1_000,
      beforeContextPayloadGc: () => {
        gcAttempts += 1;
        if (failGc) throw new Error("fault during context payload GC");
      }
    });
    const initial = rotationSession();
    await seedConversationStore(store, initial);
    const first = nextContextSession(initial, "gc-first", 1_001);
    await store.commitSessionContext(first, {
      expectedGeneration: 2,
      expectedCommitId: "commit-old",
      expectedContentRevision: createConversationContentRevision(initial)
    });

    failGc = true;
    const second = nextContextSession(first, "gc-second", 1_002);
    const receipt = await store.commitSessionContext(second, {
      expectedGeneration: first.generation ?? 0,
      expectedCommitId: first.commitId,
      expectedContentRevision: createConversationContentRevision(first)
    });
    assert.equal(receipt.commitId, second.commitId);
    assert.equal((await store.readSession(second.id))?.commitId, second.commitId);
    assert.ok(
      (await payloadDirectoryKeys(rootPath, second.id)).length > 2,
      "a GC failure may leave one or more orphans but cannot reverse the committed marker"
    );

    failGc = false;
    await store.upsertSession({ ...second, updatedAt: 1_003 });
    const metadata = await readPayloadMetadata(rootPath, second.id);
    assert.deepEqual(
      await payloadDirectoryKeys(rootPath, second.id),
      [metadata.payloadKey, metadata.previousPayloadKey].sort(),
      "the next ordinary save must retry cleanup without creating another payload generation"
    );
    assert.equal(
      gcAttempts,
      4,
      "the legacy snapshot upgrade adds one content-addressed revision before the failed GC retry"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function seedConversationStore(
  store: FileConversationStore,
  source: StoredSession
): Promise<void> {
  const targetGeneration = Math.max(source.generation ?? 1, source.revision ?? 1);
  const hasCompleteIdentity = Boolean(
    source.contextId?.trim()
    && source.commitId?.trim()
    && source.workspaceFingerprint?.trim()
  );
  if (targetGeneration > 1 && !hasCompleteIdentity) {
    throw new Error("test seed requires a complete Context identity after generation 1");
  }

  const initial: StoredSession = {
    id: source.id,
    title: source.title,
    ...(source.kind ? { kind: source.kind } : {}),
    revision: 1,
    generation: 1,
    ...(hasCompleteIdentity
      ? {
        contextId: targetGeneration === 1
          ? source.contextId
          : `${source.contextId}-seed-generation-1`,
        commitId: targetGeneration === 1
          ? source.commitId
          : `${source.commitId}-seed-generation-1`,
        workspaceFingerprint: source.workspaceFingerprint,
        cwd: source.cwd
      }
      : { cwd: "" }),
    messages: [],
    createdAt: source.createdAt,
    updatedAt: source.createdAt
  };
  await store.createPristineSession(initial);

  let committed = initial;
  for (let generation = 2; generation <= targetGeneration; generation += 1) {
    const finalGeneration = generation === targetGeneration;
    const candidate: StoredSession = {
      ...committed,
      revision: generation,
      generation,
      contextId: finalGeneration
        ? source.contextId
        : `${source.contextId}-seed-generation-${generation}`,
      commitId: finalGeneration
        ? source.commitId
        : `${source.commitId}-seed-generation-${generation}`,
      workspaceFingerprint: source.workspaceFingerprint,
      cwd: source.cwd,
      messages: finalGeneration
        ? JSON.parse(JSON.stringify(source.messages)) as StoredSession["messages"]
        : [],
      ...(finalGeneration && source.contextStartsAfterMessageId
        ? { contextStartsAfterMessageId: source.contextStartsAfterMessageId }
        : {}),
      backendBindings: undefined,
      threadId: undefined,
      contextSnapshot: undefined,
      rollingSummary: undefined,
      messagesHiddenBefore: undefined,
      historyActiveDate: undefined,
      tokenUsage: undefined,
      updatedAt: finalGeneration ? source.updatedAt : source.createdAt + generation
    };
    await store.commitSessionContext(candidate, {
      expectedGeneration: generation - 1,
      expectedCommitId: committed.commitId,
      expectedContentRevision: createConversationContentRevision(committed)
    });
    committed = candidate;
  }
  await store.upsertSession(source);
}

async function writeLegacyConversationFixture(
  rootPath: string,
  session: StoredSession
): Promise<void> {
  const sessionRoot = path.join(rootPath, "sessions", session.id);
  await mkdir(sessionRoot, { recursive: true });
  const {
    messages,
    ...metadata
  } = JSON.parse(JSON.stringify(session)) as StoredSession;
  await writeFile(
    path.join(sessionRoot, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(sessionRoot, "messages.jsonl"),
    messages.map((message) => JSON.stringify(message)).join("\n")
      + (messages.length ? "\n" : ""),
    "utf8"
  );
  await writeFile(
    path.join(sessionRoot, "snapshots.jsonl"),
    session.contextSnapshot ? `${JSON.stringify(session.contextSnapshot)}\n` : "",
    "utf8"
  );
  await writeFile(
    path.join(rootPath, "index.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: session.updatedAt,
      sessions: [{
        sessionId: session.id,
        title: session.title,
        ...(session.kind ? { kind: session.kind } : {}),
        messageCount: messages.length,
        updatedAt: session.updatedAt
      }]
    }, null, 2)}\n`,
    "utf8"
  );
}

function nextContextSession(
  source: StoredSession,
  suffix: string,
  updatedAt: number
): StoredSession {
  return {
    ...source,
    revision: (source.revision ?? 0) + 1,
    generation: (source.generation ?? 0) + 1,
    contextId: `context-${suffix}`,
    contextStartsAfterMessageId: undefined,
    commitId: `commit-${suffix}`,
    contextSnapshot: undefined,
    rollingSummary: undefined,
    backendBindings: undefined,
    updatedAt
  };
}

async function readPayloadMetadata(
  rootPath: string,
  sessionId: string
): Promise<{ payloadKey: string; previousPayloadKey: string }> {
  return JSON.parse(await readFile(
    path.join(rootPath, "sessions", sessionId, "metadata.json"),
    "utf8"
  )) as { payloadKey: string; previousPayloadKey: string };
}

async function payloadDirectoryKeys(rootPath: string, sessionId: string): Promise<string[]> {
  return (await readdir(path.join(
    rootPath,
    "sessions",
    sessionId,
    "context-payloads"
  )))
    .filter((entry) => /^payload-[a-f0-9]{64}$/.test(entry))
    .sort();
}

function contextPayloadDir(rootPath: string, sessionId: string, payloadKey: string): string {
  return path.join(
    rootPath,
    "sessions",
    sessionId,
    "context-payloads",
    payloadKey
  );
}

async function conversationSessionSnapshot(
  rootPath: string,
  sessionId: string
): Promise<unknown> {
  const sessionRoot = path.join(rootPath, "sessions", sessionId);
  const payloadKeys = await payloadDirectoryKeys(rootPath, sessionId);
  return {
    metadata: await readFile(path.join(sessionRoot, "metadata.json"), "utf8"),
    payloads: await Promise.all(payloadKeys.map(async (payloadKey) => ({
      payloadKey,
      messages: await readFile(
        path.join(contextPayloadDir(rootPath, sessionId, payloadKey), "messages.jsonl"),
        "utf8"
      ),
      snapshots: await readFile(
        path.join(contextPayloadDir(rootPath, sessionId, payloadKey), "snapshots.jsonl"),
        "utf8"
      )
    })))
  };
}

function rotationSession(): StoredSession {
  const oldWorkspaceFingerprint = workspaceFingerprint({
    vaultPath: "/vault",
    cwd: "/vault/workspace-a"
  });
  return {
    id: "session-rotation",
    title: "Rotation",
    threadId: "thread-old",
    revision: 2,
    generation: 2,
    contextId: "context-old",
    commitId: "commit-old",
    workspaceFingerprint: oldWorkspaceFingerprint,
    cwd: "/vault/workspace-a",
    messages: [
      { id: "m1", role: "user", text: "old secret", createdAt: 1 },
      { id: "m2", role: "assistant", text: "old answer", createdAt: 2 }
    ],
    contextSnapshot: {
      sessionId: "session-rotation",
      contextId: "context-old",
      generation: 2,
      version: "snapshot-old",
      goal: "old goal",
      currentState: "old state",
      decisions: [],
      constraints: [],
      openLoops: [],
      keyReferences: [],
      rollingSummary: "old secret",
      summarizedFromMessageId: "m1",
      summarizedThroughMessageId: "m2",
      sourceMessageCount: 2,
      createdAt: 1,
      updatedAt: 2
    },
    rollingSummary: { text: "old secret", updatedAt: 2 },
    backendBindings: {
      "codex-cli": {
        backendId: "codex-cli",
        nativeThreadId: "thread-old",
        syncedSessionRevision: 2,
        workspaceFingerprint: oldWorkspaceFingerprint,
        lastUsedAt: 2
      },
      opencode: {
        backendId: "opencode",
        nativeSessionId: "session-old",
        syncedSessionRevision: 2,
        workspaceFingerprint: oldWorkspaceFingerprint,
        lastUsedAt: 2
      },
      empty: {
        backendId: "empty",
        syncedSessionRevision: 2,
        workspaceFingerprint: oldWorkspaceFingerprint,
        lastUsedAt: 2
      }
    },
    createdAt: 1,
    updatedAt: 2
  };
}
