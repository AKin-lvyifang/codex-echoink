import * as assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import { TaskRuntimeAgentAdapter } from "../../harness/agents/adapters/task-runtime-adapter";
import type { SessionContextRetirement } from "../../harness/conversation/context-rotation";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { LocalRunCommitResult, NativeExecutionDispositionRequest, NativeExecutionRecord } from "../../harness/contracts/native-execution";
import {
  createPlannedRecordMutationRevision,
  transitionRecordMutationRevision,
  type RecordMutationRevision
} from "../../harness/lifecycle/record-mutation-contract";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { sessionNativeExecutionRefs } from "../../harness/kernel/session-service";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { NativeExecutionManager } from "../../harness/native/native-execution-manager";
import {
  NativeExecutionStore,
  NativeExecutionStoreMigrationRequiredError,
  NativeExecutionStoreRebuildUnsupportedError,
  NativeExecutionStoreRecoveryRequiredError
} from "../../harness/native/native-execution-store";
import { KnowledgeBaseManager } from "../../knowledge-base/manager";
import { EchoInkHarnessService } from "../../plugin/harness-service";
import { DEFAULT_SETTINGS, normalizeSettingsData, type StoredSession } from "../../settings/settings";

export async function runHarnessV2NativeExecutionTests(): Promise<void> {
  await assertEchoInkHostProcessDispositionClosesWithoutCleanupAdapter();
  await assertCleanupCommittedRequiresDurableCommittedAuthority();
  await assertMigrationQuietWindowPausesCleanupAndNativeMutation();
  await assertKnowledgeLocalCommitAndCleanupEventsUseCentralLedgerSequence();
  await assertKnowledgeScopedNativeSettlementIsSerializedAndBounded();
  await assertMissingNativeSettlementReceiptIsDurablyRetainedAcrossRestart();
  await assertKnowledgeLocalCommitEventFailureKeepsDurableCommitGateClosed();
  await assertKnowledgeLocalCommitFailureEmitsFailedEventWithoutCleanup();
  await assertNativeExecutionAuditEventsCannotRebuildAuthorityIndex();
  await assertLocalCommitFailureRetainsNativeExecution();
  await assertRepeatedSettlementAfterDisposedCleanupIsIdempotent();
  await assertSettlementReceiptsAreMonotonicAcrossConflictingArrivalOrder();
  await assertCleanupUsesAdapterCapabilityAndRetriesFailures();
  await assertCleanupQuarantinesAfterSixFailures();
  await assertCleanupDueIsSingleFlight();
  await assertCleanupDueAndCleanupByIdShareRecordSingleFlight();
  await assertCleanupDeduplicatesDifferentRecordsForSameNativeIdentity();
  await assertCleanupQuarantinesConflictingDispositionForSameNativeIdentity();
  await assertLateNativeDispositionConflictQuarantinesStartedProviderAttempt();
  await assertLeasedConversationCleanupWaitsForBindingRetirement();
  await assertCleanupSerializesDifferentRecordsForSharedAdapter();
  await assertCleanupCoordinatesAcrossManagerReplacement();
  await assertCleanupFairnessReservesCapacityForNewRecords();
  await assertPreciseCleanupBypassesRetryBacklog();
  await assertCleanupStartedEventFailureDoesNotBlockDisposition();
  await assertCleanupConnectionFailureIsBoundedWithoutProviderDisposition();
  await assertInterruptedDisposingRecordRecoveryDoesNotDoubleCountClaim();
  await assertPostClaimFailureReleasesCleanupWithoutRestart();
  await assertPostClaimRecoveryRetriesAfterReleaseFailure();
  await assertSixthInterruptedDispositionIsQuarantinedBeforeAnotherAdapterCall();
  await assertExhaustedLegacyFailureIsQuarantinedBeforeDisposition();
  await assertNonExecutableCleanupStatesStayOutOfDueQueue();
  await assertMissingLeasedCleanupAuthorityCannotReachProvider();
  await assertRetirementTransitionsAreExplicitAndIdempotent();
  await assertRetirementBatchCollisionCannotMutateExistingIdentity();
  await assertRecordCreatedCannotOverwriteOrReviveExistingRegistration();
  await assertNativeTransportValidationAndLegacyReplay();
  await assertHarnessServiceJournalPromotionGate();
  await assertHarnessServiceExposesTypedNativeLifecycleFacade();
  await assertNativeExecutionStoreRequiresExplicitV1MigrationBeforeMutation();
  await assertNativeExecutionStoreRequiresRecoveryWhenIndexIsMissingWithAuditHistory();
  await assertNativeExecutionStoreRequiresRecoveryForExistingBlankStorageMarkers();
  await assertNativeExecutionStoreRequiresRecoveryForTempResidueBesideCommittedIndex();
  await assertNativeExecutionStoreCommitsAuthorityBeforeBestEffortAudit();
  await assertNativeExecutionStoreRejectsFutureAndCorruptIndexesWithoutWrites();
  await assertNativeExecutionStoreRejectsContradictoryLifecycleStatesWithoutDisposition();
  await assertCleanupUnsupportedAndRetainedEvents();
  await assertUntrustedHermesCleanupIsRetainedWithoutAdapterDisposition();
  await assertUntrustedNativeIdentityNeverReachesAdapter();
  await assertScheduledEventFailureKeepsCleanupRecoverable();
  await assertCleanupTerminalEventFailureDoesNotThrowAfterStoreUpdate();
  await assertCommittedSessionDeletionCleanupPersistsWithoutRunEvents();
  await assertCleanupCommittedNeverOverwritesQuarantineOrConflictingIdentity();
  await assertSessionNativeExecutionRefsIncludesRefOnlyAndDowngradesConflicts();
  await assertPendingLocalCommitsAreMarkedFailedOnRecovery();
  await assertPendingRecoverySnapshotExcludesLaterRecords();
  await assertPendingRecoveryCannotOverwriteConcurrentSuccessfulSettlement();
}

export async function runHarnessV2NativeExecutionP1RegressionTests(): Promise<void> {
  await assertEchoInkHostProcessDispositionClosesWithoutCleanupAdapter();
  await assertCleanupCommittedRequiresDurableCommittedAuthority();
  await assertLateNativeDispositionConflictQuarantinesStartedProviderAttempt();
  await assertPostClaimFailureReleasesCleanupWithoutRestart();
  await assertPostClaimRecoveryRetriesAfterReleaseFailure();
  await assertNativeExecutionStoreRequiresExplicitV1MigrationBeforeMutation();
  await assertNativeExecutionStoreRequiresRecoveryForTempResidueBesideCommittedIndex();
  await assertNativeTransportValidationAndLegacyReplay();
}

async function assertMigrationQuietWindowPausesCleanupAndNativeMutation():
Promise<void> {
  const rootPath = await tempRoot(
    "echoink-native-migration-quiet-window-"
  );
  const manager = new NativeExecutionManager({
    store: new NativeExecutionStore({ rootPath }),
    adapters: []
  });
  let releaseStore!: () => void;
  const storeReleased = new Promise<void>((resolve) => {
    releaseStore = resolve;
  });
  let announceStoreHeld!: () => void;
  const storeHeld = new Promise<void>((resolve) => {
    announceStoreHeld = resolve;
  });
  const quiet = manager.withCleanupPaused(
    "migration-test",
    async () => await manager.withStoreMutation(async () => {
      announceStoreHeld();
      await storeReleased;
    })
  );
  await storeHeld;
  await assert.rejects(
    () => manager.cleanupDue(),
    /cleanup admission is closed/
  );
  await assert.rejects(
    () => manager.cleanupById("missing-record"),
    /cleanup admission is closed/
  );

  let writeFinished = false;
  const queuedWrite = manager.recordCreated(baseRecord({
    id: "quiet-window-record",
    runId: "quiet-window-run",
    sessionId: "quiet-window-session"
  })).then(() => {
    writeFinished = true;
  });
  await Promise.resolve();
  assert.equal(writeFinished, false);
  releaseStore();
  await quiet;
  await queuedWrite;
  assert.equal(writeFinished, true);
  assert.deepEqual(await manager.cleanupDue(), []);
}

async function assertEchoInkHostProcessDispositionClosesWithoutCleanupAdapter(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-host-process-disposition-");
  const store = new NativeExecutionStore({ rootPath, now: () => 30 });
  let providerDispositionCalls = 0;
  const unexpectedHostAdapter = new FakeAgentAdapter({
    backendId: "echoink-host",
    responseText: "unused",
    onDisposeNativeExecution: async (request) => {
      providerDispositionCalls += 1;
      return {
        outcome: "disposed",
        applied: request.requested
      };
    }
  });
  const manager = new NativeExecutionManager({
    store,
    adapters: [unexpectedHostAdapter],
    now: () => 30
  });

  for (const [index, runOutcome, state] of [
    [1, "success", "exited"],
    [2, "failed", "not-started"],
    [3, "cancelled", "exited"]
  ] as const) {
    const executionId = `echoink-host-process:fixture-${index}`;
    const record = baseRecord({
      id: `host-process-${index}`,
      runId: `host-process-run-${index}`,
      native: {
        backendId: "echoink-host",
        id: executionId,
        kind: "process",
        persistence: "process-local",
        identityAuthority: "echoink-host",
        hostExecution: {
          version: 1,
          owner: "echoink-host",
          executionId,
          targetBackendId: "hermes",
          transport: "hermes-proposal-v1",
          attemptId: `attempt-${index}`,
          backendNativeIdentity: "unavailable-before-prompt",
          createdAt: 10
        },
        deviceKey: "device-1",
        vaultId: "vault-1",
        createdAt: 10
      },
      createdAt: 10
    });
    await manager.recordCreated(record);
    await manager.recordCreated({
      ...record,
      observedDisposition: {
        version: 1,
        owner: "echoink-host",
        executionId,
        disposition: "process-exit",
        state,
        observedAt: 20
      }
    });

    const observed = await store.get(record.id);
    assert.equal(observed?.localCommit, "pending");
    assert.equal(observed?.cleanup, "not-needed");
    assert.equal(observed?.observedDisposition?.state, state);
    assert.deepEqual(await manager.cleanupDue(), []);

    const settlementManager = index === 1
      ? new NativeExecutionManager({
        store: new NativeExecutionStore({ rootPath, now: () => 30 }),
        adapters: [unexpectedHostAdapter],
        now: () => 30
      })
      : manager;
    const settled = await settlementManager.settleRun({
      recordId: record.id,
      runOutcome,
      localCommit: localCommit(true)
    });
    assert.equal(settled?.localCommit, "committed");
    assert.equal(settled?.cleanup, "disposed");
    assert.equal(settled?.requestedDisposition, "process-exit");
    assert.equal(settled?.appliedDisposition, "process-exit");
    assert.equal(settled?.disposedAt, 20);
    assert.equal(settled?.attempts, 0);
  }
  assert.equal(providerDispositionCalls, 0);

  const restartedStore = new NativeExecutionStore({
    rootPath,
    now: () => 40
  });
  const restarted = await restartedStore.get("host-process-1");
  assert.equal(restarted?.cleanup, "disposed");
  assert.notEqual(restarted?.cleanup, "unsupported");
  const restartedManager = new NativeExecutionManager({
    store: restartedStore,
    adapters: [],
    now: () => 40
  });
  assert.deepEqual(await restartedManager.cleanupDue(), []);
  assert.deepEqual(
    await restartedManager.cleanupById("host-process-1"),
    {
      recordId: "host-process-1",
      cleanup: "disposed",
      attempted: false
    }
  );
  assert.equal((await restartedStore.get("host-process-1"))?.cleanup, "disposed");
  assert.equal(providerDispositionCalls, 0);

  const failedCommitExecutionId =
    "echoink-host-process:failed-local-commit";
  const failedCommitRecord = baseRecord({
    id: "host-process-failed-local-commit",
    runId: "host-process-run-failed-local-commit",
    native: {
      backendId: "echoink-host",
      id: failedCommitExecutionId,
      kind: "process",
      persistence: "process-local",
      identityAuthority: "echoink-host",
      hostExecution: {
        version: 1,
        owner: "echoink-host",
        executionId: failedCommitExecutionId,
        targetBackendId: "hermes",
        transport: "hermes-proposal-v1",
        attemptId: "attempt-failed-local-commit",
        backendNativeIdentity: "unavailable-before-prompt",
        createdAt: 10
      },
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 10
    },
    createdAt: 10
  });
  const failedCommitReceipt = {
    version: 1 as const,
    owner: "echoink-host" as const,
    executionId: failedCommitExecutionId,
    disposition: "process-exit" as const,
    state: "exited" as const,
    observedAt: 20
  };
  await manager.recordCreated({
    ...failedCommitRecord,
    observedDisposition: failedCommitReceipt
  });
  const failedCommit = await manager.settleRun({
    recordId: failedCommitRecord.id,
    runOutcome: "failed",
    localCommit: localCommit(false, "durable Knowledge commit failed")
  });
  assert.equal(failedCommit?.localCommit, "failed");
  assert.equal(failedCommit?.cleanup, "retained-for-recovery");
  assert.deepEqual(
    (await store.get(failedCommitRecord.id))?.observedDisposition,
    failedCommitReceipt
  );
  assert.equal(providerDispositionCalls, 0);

  const missingExecutionId = "echoink-host-process:missing-receipt";
  const missingReceipt = baseRecord({
    id: "host-process-missing-receipt",
    runId: "host-process-run-missing-receipt",
    native: {
      backendId: "echoink-host",
      id: missingExecutionId,
      kind: "process",
      persistence: "process-local",
      identityAuthority: "echoink-host",
      hostExecution: {
        version: 1,
        owner: "echoink-host",
        executionId: missingExecutionId,
        targetBackendId: "hermes",
        transport: "hermes-proposal-v1",
        attemptId: "attempt-missing-receipt",
        backendNativeIdentity: "unavailable-before-prompt",
        createdAt: 10
      },
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 10
    },
    createdAt: 10
  });
  await manager.recordCreated(missingReceipt);
  const quarantined = await manager.settleRun({
    recordId: missingReceipt.id,
    runOutcome: "failed",
    localCommit: localCommit(true)
  });
  assert.equal(quarantined?.cleanup, "quarantined");
  assert.match(
    quarantined?.lastError ?? "",
    /host process disposition authority is missing/i
  );
  assert.deepEqual(await manager.cleanupDue(), []);

  const conflictExecutionId = "echoink-host-process:conflict";
  const conflictRecord = baseRecord({
    id: "host-process-conflict",
    runId: "host-process-run-conflict",
    native: {
      backendId: "echoink-host",
      id: conflictExecutionId,
      kind: "process",
      persistence: "process-local",
      identityAuthority: "echoink-host",
      hostExecution: {
        version: 1,
        owner: "echoink-host",
        executionId: conflictExecutionId,
        targetBackendId: "hermes",
        transport: "hermes-proposal-v1",
        attemptId: "attempt-conflict",
        backendNativeIdentity: "unavailable-before-prompt",
        createdAt: 10
      },
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 10
    },
    createdAt: 10
  });
  await manager.recordCreated({
    ...conflictRecord,
    observedDisposition: {
      version: 1,
      owner: "echoink-host",
      executionId: conflictExecutionId,
      disposition: "process-exit",
      state: "not-started",
      observedAt: 20
    }
  });
  await assert.rejects(
    manager.recordCreated({
      ...conflictRecord,
      observedDisposition: {
        version: 1,
        owner: "echoink-host",
        executionId: conflictExecutionId,
        disposition: "process-exit",
        state: "exited",
        observedAt: 21
      }
    }),
    /Conflicting EchoInk host process disposition/
  );
  const conflicted = await store.get(conflictRecord.id);
  assert.equal(conflicted?.cleanup, "quarantined");
  assert.equal(conflicted?.localCommit, "pending");
  assert.equal(conflicted?.observedDisposition?.state, "not-started");
  assert.equal(providerDispositionCalls, 0);
}

async function assertCleanupCommittedRequiresDurableCommittedAuthority(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-cleanup-committed-authority-");
  const store = new NativeExecutionStore({ rootPath, now: () => 35 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "unused",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return {
          outcome: "disposed",
          applied: request.requested
        };
      }
    })],
    now: () => 35
  });

  const absentPending = baseRecord({
    id: "cleanup-committed-absent-pending",
    native: {
      ...baseRecord().native,
      id: "cleanup-committed-absent-pending-native"
    }
  });
  await assert.rejects(
    () => manager.cleanupCommitted(absentPending),
    /durable committed authority/i
  );
  assert.equal(await store.get(absentPending.id), null);

  const absentClaimedCommitted = baseRecord({
    id: "cleanup-committed-absent-claimed",
    native: {
      ...baseRecord().native,
      id: "cleanup-committed-absent-claimed-native"
    },
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    committedAt: 34,
    nextAttemptAt: 0
  });
  await assert.rejects(
    () => manager.cleanupCommitted(absentClaimedCommitted),
    /durable committed authority/i
  );
  assert.equal(await store.get(absentClaimedCommitted.id), null);

  const durablePending = baseRecord({
    id: "cleanup-committed-durable-pending",
    native: {
      ...baseRecord().native,
      id: "cleanup-committed-durable-pending-native"
    }
  });
  await manager.recordCreated(durablePending);
  await assert.rejects(
    () => manager.cleanupCommitted({
      ...durablePending,
      localCommit: "committed",
      cleanup: "pending",
      requestedDisposition: "delete",
      committedAt: 34,
      nextAttemptAt: 0
    }),
    /durable committed authority/i
  );
  assert.deepEqual(await store.get(durablePending.id), durablePending);

  const missingRetirementAuthority = baseRecord({
    id: "cleanup-committed-missing-retirement-authority",
    runId: "cleanup-committed-missing-retirement-authority-run",
    sessionId: "cleanup-committed-missing-retirement-authority-session",
    surface: "chat",
    workflow: "chat.generic",
    native: {
      ...baseRecord().native,
      id: "cleanup-committed-missing-retirement-authority-native"
    },
    policy: {
      ...baseRecord().policy,
      mode: "leased-conversation"
    },
    runOutcome: "success",
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    settledAt: 34,
    committedAt: 34,
    nextAttemptAt: 0
  });
  await store.upsert(missingRetirementAuthority);
  const missingAuthority = await manager.cleanupCommitted(
    missingRetirementAuthority
  );
  assert.equal(missingAuthority.cleanup, "quarantined");
  assert.equal(missingAuthority.attempted, false);
  assert.match(
    missingAuthority.message ?? "",
    /missing durable retirement evidence/i
  );
  assert.equal(dispositionCalls, 0);
}

async function assertUntrustedHermesCleanupIsRetainedWithoutAdapterDisposition(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-hermes-untrusted-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(65_000) });
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime: {
      kind: "hermes",
      async connect() { return { connected: true, label: "Hermes", errors: [] }; },
      async listModels() { return []; },
      async runTask() { return { text: "done", runId: "hermes-run-1" }; },
      async abort() { return undefined; }
    },
    capabilities: "legacy"
  });
  const manager = new NativeExecutionManager({ store, adapters: [adapter], now: fixedClock(65_000) });
  await manager.recordCreated(baseRecord({
    id: "native-hermes-unsupported",
    native: {
      backendId: "hermes",
      id: "hermes-run-1",
      kind: "run",
      persistence: "unknown",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1
    }
  }));
  const settled = await manager.settleRun({
    recordId: "native-hermes-unsupported",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const cleanup = await manager.cleanupDue();

  assert.equal(settled?.requestedDisposition, "retain");
  assert.equal(cleanup[0]?.cleanup, "retained");
  assert.equal(cleanup[0]?.attempted, false);
  assert.equal((await store.get("native-hermes-unsupported"))?.cleanup, "retained");
}

async function assertUntrustedNativeIdentityNeverReachesAdapter(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-untrusted-identity-");
  const store = new NativeExecutionStore({ rootPath, now: () => 66_000 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "opencode",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 66_000
  });
  for (const [id, native] of [
    ["unknown-device", {
      ...baseRecord().native,
      backendId: "opencode",
      id: "session-unknown-device",
      providerEndpoint: "http://127.0.0.1:4096",
      deviceKey: "unknown"
    }],
    ["missing-endpoint", {
      ...baseRecord().native,
      backendId: "opencode",
      id: "session-missing-endpoint",
      providerEndpoint: undefined
    }]
  ] as const) {
    await store.upsert(baseRecord({
      id,
      native,
      localCommit: "committed",
      cleanup: "pending",
      requestedDisposition: "delete",
      nextAttemptAt: 0
    }));
    const result = await manager.cleanupById(id);
    assert.equal(result.cleanup, "retained");
    assert.equal(result.attempted, false);
  }
  assert.equal(dispositionCalls, 0);
}

async function assertCommittedSessionDeletionCleanupPersistsWithoutRunEvents(): Promise<void> {
  const rootPath = await tempRoot("echoink-session-delete-cleanup-");
  const store = new NativeExecutionStore({ rootPath, now: () => 9_000 });
  const requests: NativeExecutionDispositionRequest[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        requests.push(request);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 9_000,
    emitRunEvent: async () => { throw new Error("synthetic cleanup must not emit run events"); }
  });

  const committed = baseRecord({
    id: "session-delete-native",
    runId: "session-delete:chat-1",
    workflow: "session.delete",
    localCommit: "committed",
    cleanup: "pending",
    committedAt: 9_000,
    nextAttemptAt: 0,
    emitEvents: false,
    dispositionReason: "manual"
  });
  await store.upsert(committed);
  const result = await manager.cleanupCommitted(committed);
  const stored = await store.get("session-delete-native");

  assert.equal(result.cleanup, "disposed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.reason, "manual");
  assert.equal(stored?.localCommit, "committed");
  assert.equal(stored?.cleanup, "disposed");
  assert.equal(stored?.emitEvents, false);
}

async function assertCleanupCommittedNeverOverwritesQuarantineOrConflictingIdentity(): Promise<void> {
  const rootPath = await tempRoot("echoink-session-cleanup-collision-");
  const store = new NativeExecutionStore({ rootPath, now: () => 9_500 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 9_500
  });
  const cleanupInput = baseRecord({
    id: "session-cleanup-stable-id",
    runId: "session.cache-reset:chat-1",
    sessionId: "chat-1",
    workflow: "session.cache-reset",
    localCommit: "committed",
    cleanup: "pending",
    committedAt: 9_500,
    emitEvents: false,
    dispositionReason: "manual"
  });
  const quarantined = {
    ...cleanupInput,
    cleanup: "quarantined" as const,
    attempts: 6,
    nextAttemptAt: 0,
    quarantinedAt: 9_400,
    lastError: "manual review required"
  };
  await store.upsert(quarantined);
  const indexPath = path.join(rootPath, "native-executions-index.json");
  const eventsPath = path.join(rootPath, "native-executions.jsonl");
  const indexBefore = await readFile(indexPath, "utf8");
  const eventsBefore = await readFile(eventsPath, "utf8");

  const result = await manager.cleanupCommitted(cleanupInput);
  assert.equal(result.cleanup, "quarantined");
  assert.equal(result.attempted, false);
  assert.equal(await readFile(indexPath, "utf8"), indexBefore);
  assert.equal(await readFile(eventsPath, "utf8"), eventsBefore);

  await assert.rejects(
    () => manager.cleanupCommitted({
      ...cleanupInput,
      native: {
        ...cleanupInput.native,
        id: "different-native-id"
      }
    }),
    /cleanup record id conflicts/
  );
  assert.deepEqual(await store.get(cleanupInput.id), quarantined);
  assert.equal(dispositionCalls, 0);
}

async function assertSessionNativeExecutionRefsIncludesRefOnlyAndDowngradesConflicts(): Promise<void> {
  const refOnlySession = {
    id: "ref-only-session",
    title: "Ref only",
    messages: [],
    createdAt: 1,
    updatedAt: 2,
    backendBindings: {
      opencode: {
        backendId: "opencode",
        nativeExecutionKind: "session",
        nativeExecutionRef: {
          backendId: "opencode",
          id: "opencode-ref-only",
          kind: "session",
          persistence: "provider-persistent",
          providerEndpoint: "http://127.0.0.1:4096",
          deviceKey: "device-ref",
          vaultId: "vault-ref",
          createdAt: 1
        },
        syncedSessionRevision: 1,
        lastUsedAt: 2
      }
    }
  } satisfies StoredSession;
  assert.deepEqual(sessionNativeExecutionRefs(refOnlySession), [
    refOnlySession.backendBindings.opencode.nativeExecutionRef
  ]);

  const conflictingCodexSession = {
    id: "conflicting-codex-session",
    title: "Conflicting Codex",
    threadId: "legacy-thread-b",
    messages: [],
    createdAt: 1,
    updatedAt: 3,
    backendBindings: {
      "codex-cli": {
        backendId: "codex-cli",
        nativeThreadId: "trusted-thread-a",
        nativeSessionId: "turn-auxiliary",
        nativeExecutionKind: "thread",
        nativeExecutionRef: {
          backendId: "codex-cli",
          id: "trusted-thread-a",
          kind: "thread",
          persistence: "provider-persistent",
          deviceKey: "device-codex",
          vaultId: "vault-codex",
          createdAt: 1
        },
        syncedSessionRevision: 1,
        lastUsedAt: 2
      }
    }
  } satisfies StoredSession;
  const conflictingRefs = sessionNativeExecutionRefs(conflictingCodexSession);
  assert.deepEqual(
    conflictingRefs.filter((ref) => ref.kind === "thread").map((ref) => ref.id).sort(),
    ["legacy-thread-b", "trusted-thread-a"]
  );
  assert.equal(
    conflictingRefs
      .filter((ref) => ref.kind === "thread")
      .every((ref) => ref.deviceKey === "unknown" && ref.vaultId === "unknown"),
    true,
    "conflicting thread identities must be retained instead of auto-disposed"
  );
}

async function assertKnowledgeLocalCommitAndCleanupEventsUseCentralLedgerSequence(): Promise<void> {
  let now = 20_000;
  const rootPath = await tempRoot("echoink-native-ledger-events-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const disposeCalls: NativeExecutionDispositionRequest[] = [];
  const nativeManager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls.push(request);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await nativeManager.recordCreated(baseRecord({
    id: "native-ledger-events",
    runId: "run-ledger-events"
  }));
  await kernel.appendRunEvent({
    runId: "run-ledger-events",
    source: "kernel",
    type: "run.completed",
    backendId: "fake",
    text: "业务成功"
  });

  const seenBeforeCommit: string[] = [];
  const manager = new KnowledgeBaseManager({
    settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings,
    getVaultPath: () => rootPath,
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async (event: HarnessEvent) => {
      seenBeforeCommit.push(event.type);
      await kernel.appendRunEvent(event);
    },
    commitKnowledgeRunDurably: async () => {
      assert.deepEqual(seenBeforeCommit, ["run.local_commit.started"]);
      return localCommit(true);
    },
    recordNativeExecution: async (record: NativeExecutionRecord) => await nativeManager.recordCreated(record),
    settleNativeExecution: async (input: any) => await nativeManager.settleRun(input),
    cleanupDueNativeExecutions: async (limit?: number) => await nativeManager.cleanupDue(limit),
    codex: null
  } as any);

  (manager as any).agentTaskService.pendingNativeExecutionCommits.set("native-ledger-events", {
    runId: "run-ledger-events",
    runOutcome: "success"
  });

  const disposedCount = await manager.settlePendingKnowledgeBaseNativeExecutions();
  const events = await ledger.readRun("run-ledger-events");

  assert.equal(disposedCount, 1);
  assert.deepEqual(events.map((event) => event.type), [
    "run.completed",
    "run.local_commit.started",
    "run.local_commit.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.completed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events[3]?.data, {
    recordId: "native-ledger-events",
    disposition: "process-exit"
  });
  assert.deepEqual(events[4]?.data, {
    recordId: "native-ledger-events",
    disposition: "process-exit"
  });
  assert.deepEqual(events[5]?.data, {
    recordId: "native-ledger-events",
    disposition: "process-exit"
  });
  assert.equal(JSON.stringify(events).includes("fake-native"), false);
  assert.equal(disposeCalls[0]?.ref.id, "fake-native");
  assert.equal(
    (manager as any).agentTaskService.pendingNativeExecutionCommits.has("native-ledger-events"),
    false,
    "a normal durable settlement must leave no in-memory recovery intent"
  );
  assert.equal(manager.getLastNativeLifecycleSummary()?.recoveryRequired, false);
}

async function assertKnowledgeScopedNativeSettlementIsSerializedAndBounded(): Promise<void> {
  const settings = normalizeSettingsData({
    settingsVersion: DEFAULT_SETTINGS.settingsVersion
  }).settings;
  let commitSucceeds = true;
  let cleanupFails = false;
  const settlementCalls = new Map<string, number>();
  const settlementOutcomes = new Map<string, string>();
  let service: any;
  const manager = new KnowledgeBaseManager({
    settings,
    getVaultPath: () => "/vault",
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async () => undefined,
    commitKnowledgeRunDurably: async () => localCommit(
      commitSucceeds,
      commitSucceeds ? undefined : "durable local commit failed"
    ),
    recordNativeExecution: async () => undefined,
    settleNativeExecution: async (input: any) => {
      settlementCalls.set(
        input.recordId,
        (settlementCalls.get(input.recordId) ?? 0) + 1
      );
      settlementOutcomes.set(input.recordId, input.runOutcome);
      const recoveryRecord = service.pendingNativeExecutionCommits
        .get(input.recordId)?.recoveryRecord
        ?? baseRecord({ id: input.recordId, runId: `fallback:${input.recordId}` });
      return {
        ...recoveryRecord,
        runOutcome: input.runOutcome,
        localCommit: input.localCommit.committed ? "committed" : "failed",
        cleanup: input.localCommit.committed
          ? "pending"
          : "retained-for-recovery"
      } satisfies NativeExecutionRecord;
    },
    cleanupDueNativeExecutions: async () => [],
    cleanupNativeExecutionRecord: async (recordId: string) => {
      if (cleanupFails) throw new Error("cleanup delayed");
      return {
        recordId,
        cleanup: "disposed" as const,
        attempted: true
      };
    },
    codex: null
  } as any);
  service = (manager as any).agentTaskService;
  const queue = (
    recordId: string,
    runId: string,
    runOutcome: "success" | "failed" | "cancelled" = "success"
  ) => {
    service.pendingNativeExecutionCommits.set(recordId, {
      runId,
      runOutcome,
      recoveryRecord: baseRecord({ id: recordId, runId })
    });
  };

  queue("scoped-after-unscoped-record", "scoped-after-unscoped-run");
  const unscopedFirst = service.settlePendingNativeExecutions();
  const scopedSecond = service.settlePendingNativeExecutionsForRunIds([
    "scoped-after-unscoped-run"
  ]);
  await unscopedFirst;
  const afterUnscoped = await scopedSecond;
  assert.deepEqual(afterUnscoped.matchedRunIds, [
    "scoped-after-unscoped-run"
  ]);
  assert.equal(afterUnscoped.localCommitStatus, "committed");
  assert.equal(
    settlementCalls.get("scoped-after-unscoped-record"),
    1,
    "unscoped then scoped settlement must settle the record exactly once"
  );

  queue("unscoped-after-scoped-record", "unscoped-after-scoped-run");
  const scopedFirst = service.settlePendingNativeExecutionsForRunIds([
    "unscoped-after-scoped-run"
  ]);
  const unscopedSecond = service.settlePendingNativeExecutions();
  const beforeUnscoped = await scopedFirst;
  await unscopedSecond;
  assert.deepEqual(beforeUnscoped.matchedRunIds, [
    "unscoped-after-scoped-run"
  ]);
  assert.equal(beforeUnscoped.localCommitStatus, "committed");
  assert.equal(
    settlementCalls.get("unscoped-after-scoped-record"),
    1,
    "scoped then unscoped settlement must settle the record exactly once"
  );

  queue("failover-failed-record", "failover-failed-run", "failed");
  queue("failover-winner-record", "failover-winner-run", "success");
  const failover = await service.settlePendingNativeExecutionsForRunIds([
    "failover-failed-run",
    "failover-winner-run"
  ]);
  assert.deepEqual(failover.matchedRunIds, [
    "failover-failed-run",
    "failover-winner-run"
  ]);
  assert.equal(settlementOutcomes.get("failover-failed-record"), "failed");
  assert.equal(settlementOutcomes.get("failover-winner-record"), "success");

  const missing = await service.settlePendingNativeExecutionsForRunIds([
    "missing-scoped-run"
  ]);
  assert.deepEqual(missing.matchedRunIds, []);

  commitSucceeds = false;
  queue("failed-local-commit-record", "failed-local-commit-run");
  const failedCommit = await service.settlePendingNativeExecutionsForRunIds([
    "failed-local-commit-run"
  ]);
  assert.deepEqual(failedCommit.matchedRunIds, ["failed-local-commit-run"]);
  assert.equal(failedCommit.localCommitStatus, "failed");
  assert.equal(failedCommit.cleanupRecoveryRequired, true);
  service.pendingNativeExecutionCommits.delete("failed-local-commit-record");

  commitSucceeds = true;
  cleanupFails = true;
  queue("delayed-cleanup-record", "delayed-cleanup-run");
  const delayedCleanup = await service.settlePendingNativeExecutionsForRunIds([
    "delayed-cleanup-run"
  ]);
  assert.deepEqual(delayedCleanup.matchedRunIds, ["delayed-cleanup-run"]);
  assert.equal(delayedCleanup.localCommitStatus, "committed");
  assert.equal(delayedCleanup.cleanupRecoveryRequired, true);

  for (let index = 0; index < 300; index += 1) {
    service.rememberSettledNativeExecutionRunReceipt(`bounded-run-${index}`);
  }
  assert.equal(service.settledNativeExecutionRunIds.size, 256);
  assert.equal(service.settledNativeExecutionRunIds.has("bounded-run-0"), false);
  assert.equal(service.settledNativeExecutionRunIds.has("bounded-run-299"), true);
}

async function assertMissingNativeSettlementReceiptIsDurablyRetainedAcrossRestart(): Promise<void> {
  let now = 30_000;
  const rootPath = await tempRoot("echoink-native-missing-settlement-receipt-");
  const firstStore = new NativeExecutionStore({ rootPath, now: () => now++ });
  let providerDispositionCalls = 0;
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    onDisposeNativeExecution: async (request) => {
      providerDispositionCalls += 1;
      return { outcome: "disposed", applied: request.requested };
    }
  });
  const firstNativeManager = new NativeExecutionManager({
    store: firstStore,
    adapters: [adapter],
    now: () => now++
  });
  const recoveryRecord = baseRecord({
    id: "native-missing-settlement-receipt",
    runId: "run-missing-settlement-receipt"
  });
  let registrationCalls = 0;
  let settlementCalls = 0;
  const manager = new KnowledgeBaseManager({
    settings: normalizeSettingsData({
      settingsVersion: DEFAULT_SETTINGS.settingsVersion
    }).settings,
    getVaultPath: () => rootPath,
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async () => undefined,
    commitKnowledgeRunDurably: async () => localCommit(true),
    recordNativeExecution: async (record: NativeExecutionRecord) => {
      registrationCalls += 1;
      await firstNativeManager.recordCreated(record);
    },
    settleNativeExecution: async (input: any) => {
      settlementCalls += 1;
      return await firstNativeManager.settleRun(input);
    },
    cleanupDueNativeExecutions: async (limit?: number) =>
      await firstNativeManager.cleanupDue(limit),
    codex: null
  } as any);

  (manager as any).agentTaskService.pendingNativeExecutionCommits.set(
    recoveryRecord.id,
    {
      runId: recoveryRecord.runId,
      runOutcome: "success",
      recoveryRecord
    }
  );

  const disposedCount = await manager.settlePendingKnowledgeBaseNativeExecutions();
  const summary = manager.getLastNativeLifecycleSummary();
  const retained = await firstStore.get(recoveryRecord.id);

  assert.equal(disposedCount, 0);
  assert.equal(settlementCalls, 2, "a missing first receipt must be rebuilt and settled fail-closed");
  assert.equal(registrationCalls, 1);
  assert.equal(retained?.runOutcome, "success");
  assert.equal(retained?.localCommit, "failed");
  assert.equal(retained?.cleanup, "retained-for-recovery");
  assert.match(retained?.lastError ?? "", /结算回执缺失/);
  assert.equal(summary?.localCommitStatus, "committed");
  assert.deepEqual(summary?.cleanupStatuses, ["retained-for-recovery"]);
  assert.equal(summary?.recoveryRequired, true);
  assert.match(summary?.warning ?? "", /结算回执缺失/);
  assert.equal(
    (manager as any).agentTaskService.pendingNativeExecutionCommits.has(recoveryRecord.id),
    true,
    "missing-receipt intent must remain pending in the live process"
  );
  assert.equal(providerDispositionCalls, 0);

  const restartedStore = new NativeExecutionStore({ rootPath, now: () => now++ });
  const restartedManager = new NativeExecutionManager({
    store: restartedStore,
    adapters: [adapter],
    now: () => now++
  });
  const afterRestart = await restartedStore.get(recoveryRecord.id);
  assert.equal(afterRestart?.cleanup, "retained-for-recovery");
  assert.match(afterRestart?.lastError ?? "", /结算回执缺失/);
  assert.deepEqual(await restartedManager.cleanupDue(), []);
  assert.equal(providerDispositionCalls, 0, "restart recovery evidence must never become executable cleanup");

  await manager.settlePendingKnowledgeBaseNativeExecutions();
  assert.equal(
    registrationCalls,
    1,
    "replaying a durable missing-receipt settlement must be idempotent"
  );
  assert.equal(
    (await restartedStore.get(recoveryRecord.id))?.cleanup,
    "retained-for-recovery"
  );
}

async function assertKnowledgeLocalCommitEventFailureKeepsDurableCommitGateClosed(): Promise<void> {
  let now = 40_000;
  const rootPath = await tempRoot("echoink-native-ledger-failure-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const nativeManager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await nativeManager.recordCreated(baseRecord({
    id: "native-ledger-failure",
    runId: "run-ledger-failure"
  }));

  let durableCommitCalls = 0;
  const settledInputs: Array<{ localCommit: LocalRunCommitResult }> = [];
  let cleanupCalls = 0;
  const manager = new KnowledgeBaseManager({
    settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings,
    getVaultPath: () => rootPath,
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async (event: HarnessEvent) => {
      if (event.type === "run.local_commit.started") throw new Error("ledger append failed");
      await kernel.appendRunEvent(event);
    },
    commitKnowledgeRunDurably: async () => {
      durableCommitCalls += 1;
      return localCommit(true);
    },
    recordNativeExecution: async (record: NativeExecutionRecord) => await nativeManager.recordCreated(record),
    settleNativeExecution: async (input: any) => {
      settledInputs.push(input);
      return await nativeManager.settleRun(input);
    },
    cleanupDueNativeExecutions: async (limit?: number) => {
      cleanupCalls += limit ?? 0;
      return await nativeManager.cleanupDue(limit);
    },
    codex: null
  } as any);

  (manager as any).agentTaskService.pendingNativeExecutionCommits.set("native-ledger-failure", {
    runId: "run-ledger-failure",
    runOutcome: "success"
  });

  const disposedCount = await manager.settlePendingKnowledgeBaseNativeExecutions();
  const record = await store.get("native-ledger-failure");

  assert.equal(disposedCount, 0);
  assert.equal(durableCommitCalls, 0);
  assert.equal(cleanupCalls, 0);
  assert.equal(settledInputs[0]?.localCommit.committed, false);
  assert.match(settledInputs[0]?.localCommit.error ?? "", /ledger append failed/);
  assert.equal(record?.localCommit, "failed");
  assert.equal(record?.cleanup, "retained-for-recovery");
  assert.deepEqual(await ledger.readRun("run-ledger-failure"), []);
}

async function assertKnowledgeLocalCommitFailureEmitsFailedEventWithoutCleanup(): Promise<void> {
  let now = 50_000;
  const rootPath = await tempRoot("echoink-local-commit-failed-events-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const nativeManager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await nativeManager.recordCreated(baseRecord({
    id: "native-local-commit-failed",
    runId: "run-local-commit-failed"
  }));
  await kernel.appendRunEvent({
    runId: "run-local-commit-failed",
    source: "kernel",
    type: "run.completed",
    backendId: "fake"
  });

  let cleanupCalls = 0;
  const manager = new KnowledgeBaseManager({
    settings: normalizeSettingsData({ settingsVersion: DEFAULT_SETTINGS.settingsVersion }).settings,
    getVaultPath: () => rootPath,
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async (event: HarnessEvent) => {
      await kernel.appendRunEvent(event);
    },
    commitKnowledgeRunDurably: async () => localCommit(false, "history index failed"),
    recordNativeExecution: async (record: NativeExecutionRecord) => await nativeManager.recordCreated(record),
    settleNativeExecution: async (input: any) => await nativeManager.settleRun(input),
    cleanupDueNativeExecutions: async (limit?: number) => {
      cleanupCalls += limit ?? 0;
      return await nativeManager.cleanupDue(limit);
    },
    codex: null
  } as any);

  (manager as any).agentTaskService.pendingNativeExecutionCommits.set("native-local-commit-failed", {
    runId: "run-local-commit-failed",
    runOutcome: "success"
  });

  await manager.settlePendingKnowledgeBaseNativeExecutions();
  const events = await ledger.readRun("run-local-commit-failed");
  const record = await store.get("native-local-commit-failed");

  assert.deepEqual(events.map((event) => event.type), [
    "run.completed",
    "run.local_commit.started",
    "run.local_commit.failed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events[2]?.error, "history index failed");
  assert.equal(cleanupCalls, 0);
  assert.equal(record?.localCommit, "failed");
  assert.equal(record?.cleanup, "retained-for-recovery");
}

async function assertNativeExecutionAuditEventsCannotRebuildAuthorityIndex(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-audit-not-authority-");
  const eventsPath = path.join(rootPath, "native-executions.jsonl");
  const eventText = `${JSON.stringify({
    type: "upsert",
    record: baseRecord({ id: "must-not-be-revived" }),
    createdAt: 1
  })}\n`;
  await writeFile(eventsPath, eventText, "utf8");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(2000) });

  await assertRebuildUnsupported(() => store.rebuildIndexFromEvents());
  await assert.rejects(
    readFile(path.join(rootPath, "native-executions-index.json"), "utf8"),
    { code: "ENOENT" }
  );
  assert.equal(await readFile(eventsPath, "utf8"), eventText);
}

async function assertLocalCommitFailureRetainsNativeExecution(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-commit-gate-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(3000) });
  const disposeCalls: NativeExecutionDispositionRequest[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls.push(request);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: fixedClock(3000)
  });

  await manager.recordCreated(baseRecord({ id: "native-commit-failed" }));
  await manager.settleRun({
    recordId: "native-commit-failed",
    runOutcome: "success",
    localCommit: localCommit(false, "history index failed")
  });
  const cleanup = await manager.cleanupDue();
  const record = await store.get("native-commit-failed");

  assert.deepEqual(cleanup, []);
  assert.equal(disposeCalls.length, 0);
  assert.equal(record?.localCommit, "failed");
  assert.equal(record?.cleanup, "retained-for-recovery");
  assert.match(record?.lastError ?? "", /history index failed/);
}

async function assertRepeatedSettlementAfterDisposedCleanupIsIdempotent(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-settlement-replay-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(4_000) });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: fixedClock(4_000)
  });
  const settlement = {
    recordId: "native-settlement-replay",
    runOutcome: "success" as const,
    localCommit: localCommit(true)
  };

  await manager.recordCreated(baseRecord({ id: settlement.recordId }));
  await manager.settleRun(settlement);
  await manager.cleanupDue();
  const terminal = await store.get(settlement.recordId);
  const replayed = await manager.settleRun(settlement);
  const afterReplay = await store.get(settlement.recordId);

  assert.equal(dispositionCalls, 1);
  assert.equal(terminal?.cleanup, "disposed");
  assert.deepEqual(replayed, terminal);
  assert.deepEqual(afterReplay, terminal);
  await assert.rejects(
    () => manager.settleRun({
      recordId: settlement.recordId,
      runOutcome: "failed",
      localCommit: localCommit(false, "late contradictory failure")
    }),
    /Conflicting Native settlement/
  );
  assert.deepEqual(await store.get(settlement.recordId), terminal);
  assert.deepEqual(await manager.cleanupDue(), []);
  assert.equal(dispositionCalls, 1);
}

async function assertSettlementReceiptsAreMonotonicAcrossConflictingArrivalOrder(): Promise<void> {
  const committedRoot = await tempRoot("echoink-native-settlement-committed-first-");
  const committedStore = new NativeExecutionStore({ rootPath: committedRoot, now: () => 4_500 });
  let committedDispositionCalls = 0;
  const committedManager = new NativeExecutionManager({
    store: committedStore,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        committedDispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 4_500
  });
  await committedManager.recordCreated(baseRecord({ id: "native-settlement-committed-first" }));
  await committedManager.settleRun({
    recordId: "native-settlement-committed-first",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  await assert.rejects(
    () => committedManager.settleRun({
      recordId: "native-settlement-committed-first",
      runOutcome: "failed",
      localCommit: localCommit(false, "late failure")
    }),
    /Conflicting Native settlement/
  );
  const committed = await committedStore.get("native-settlement-committed-first");
  assert.equal(committed?.runOutcome, "success");
  assert.equal(committed?.localCommit, "committed");
  assert.equal(committed?.cleanup, "quarantined");
  assert.deepEqual(await committedManager.cleanupDue(), []);
  assert.equal(committedDispositionCalls, 0);

  const failedRoot = await tempRoot("echoink-native-settlement-failed-first-");
  const failedStore = new NativeExecutionStore({ rootPath: failedRoot, now: () => 4_600 });
  let failedDispositionCalls = 0;
  const failedManager = new NativeExecutionManager({
    store: failedStore,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        failedDispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 4_600
  });
  await failedManager.recordCreated(baseRecord({ id: "native-settlement-failed-first" }));
  await failedManager.settleRun({
    recordId: "native-settlement-failed-first",
    runOutcome: "failed",
    localCommit: localCommit(false, "first failure")
  });
  await assert.rejects(
    () => failedManager.settleRun({
      recordId: "native-settlement-failed-first",
      runOutcome: "success",
      localCommit: localCommit(true)
    }),
    /Conflicting Native settlement/
  );
  const failed = await failedStore.get("native-settlement-failed-first");
  assert.equal(failed?.runOutcome, "failed");
  assert.equal(failed?.localCommit, "failed");
  assert.equal(failed?.cleanup, "retained-for-recovery");
  assert.deepEqual(await failedManager.cleanupDue(), []);
  assert.equal(failedDispositionCalls, 0);
}

async function assertCleanupUsesAdapterCapabilityAndRetriesFailures(): Promise<void> {
  let storeNow = 10_000;
  let eventNow = 30_000;
  const rootPath = await tempRoot("echoink-native-cleanup-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => eventNow++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => storeNow });
  const disposeCalls: NativeExecutionDispositionRequest[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls.push(request);
        if (disposeCalls.length === 1) return { outcome: "failed", message: "temporary failure" };
        return { outcome: "already-disposed", applied: request.requested };
      }
    })],
    now: () => storeNow,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });

  await manager.recordCreated(baseRecord({ id: "native-cleanup" }));
  await kernel.appendRunEvent({
    runId: "run-native",
    source: "kernel",
    type: "run.completed",
    backendId: "fake"
  });
  await manager.settleRun({
    recordId: "native-cleanup",
    runOutcome: "success",
    localCommit: localCommit(true)
  });

  const first = await manager.cleanupDue();
  const failed = await store.get("native-cleanup");
  assert.equal(first[0]?.cleanup, "failed");
  assert.equal(disposeCalls[0]?.requested, "process-exit");
  assert.equal(failed?.cleanup, "failed");
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.nextAttemptAt, 70_000);

  assert.deepEqual(await manager.cleanupDue(), []);
  storeNow = 70_000;
  const second = await manager.cleanupDue();
  const disposed = await store.get("native-cleanup");

  assert.equal(second[0]?.cleanup, "disposed");
  assert.equal(disposeCalls.length, 2);
  assert.equal(disposed?.cleanup, "disposed");
  assert.equal(disposed?.appliedDisposition, "process-exit");
  const events = await ledger.readRun("run-native");
  assert.deepEqual(events.map((event) => event.type), [
    "run.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.failed",
    "agent.native_cleanup.started",
    "agent.native_cleanup.completed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events[1]?.data, { recordId: "native-cleanup", disposition: "process-exit" });
  assert.deepEqual(events[3]?.data, { recordId: "native-cleanup", disposition: "process-exit" });
  assert.equal(events[3]?.error, "temporary failure");
  assert.deepEqual(events[5]?.data, { recordId: "native-cleanup", disposition: "process-exit" });
}

async function assertCleanupQuarantinesAfterSixFailures(): Promise<void> {
  let now = 100_000;
  const rootPath = await tempRoot("echoink-native-quarantine-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now
  });
  let disposeCalls = 0;
  const manager = new NativeExecutionManager({
    store: new NativeExecutionStore({ rootPath, now: () => now }),
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async () => {
        disposeCalls += 1;
        return { outcome: "failed", message: `failure-${disposeCalls}` };
      }
    })],
    now: () => now,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });

  await manager.recordCreated(baseRecord({
    id: "native-quarantine",
    runId: "run-quarantine"
  }));
  await manager.settleRun({
    recordId: "native-quarantine",
    runOutcome: "success",
    localCommit: localCommit(true)
  });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const result = await manager.cleanupDue();
    assert.equal(result.length, 1);
    const record = await (manager as any).options.store.get("native-quarantine") as NativeExecutionRecord;
    assert.equal(record.attempts, attempt);
    if (attempt < 6) {
      assert.equal(result[0]?.cleanup, "failed");
      now = record.nextAttemptAt;
    } else {
      assert.equal(result[0]?.cleanup, "quarantined");
      assert.equal(record.cleanup, "quarantined");
      assert.equal(record.nextAttemptAt, 0);
      assert.equal(record.quarantinedAt, now);
    }
  }

  now += 365 * 24 * 60 * 60_000;
  assert.deepEqual(await manager.cleanupDue(), []);
  assert.equal(disposeCalls, 6);
  const eventTypes = (await ledger.readRun("run-quarantine")).map((event) => event.type);
  assert.equal(eventTypes.filter((type) => type === "agent.native_cleanup.started").length, 6);
  assert.equal(eventTypes.filter((type) => type === "agent.native_cleanup.failed").length, 5);
  assert.equal(eventTypes.filter((type) => type === "agent.native_cleanup.quarantined").length, 1);
}

async function assertCleanupDueIsSingleFlight(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-single-flight-");
  const store = new NativeExecutionStore({ rootPath, now: () => 200_000 });
  const dispositionStarted = deferred<void>();
  const releaseDisposition = deferred<void>();
  let disposeCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls += 1;
        dispositionStarted.resolve();
        await releaseDisposition.promise;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 200_000
  });
  await store.upsert(baseRecord({
    id: "native-single-flight",
    localCommit: "committed",
    cleanup: "pending",
    nextAttemptAt: 200_000
  }));

  const first = manager.cleanupDue();
  await dispositionStarted.promise;
  const second = manager.cleanupDue();
  releaseDisposition.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(disposeCalls, 1);
  assert.deepEqual(secondResult, firstResult);
  assert.equal((await store.get("native-single-flight"))?.cleanup, "disposed");
}

async function assertCleanupDueAndCleanupByIdShareRecordSingleFlight(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-cross-entry-single-flight-");
  const store = new NativeExecutionStore({ rootPath, now: () => 250_000 });
  const dispositionStarted = deferred<void>();
  const releaseDisposition = deferred<void>();
  let disposeCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls += 1;
        dispositionStarted.resolve();
        await releaseDisposition.promise;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 250_000
  });
  await store.upsert(baseRecord({
    id: "native-cross-entry",
    localCommit: "committed",
    cleanup: "pending",
    nextAttemptAt: 0
  }));

  const due = manager.cleanupDue();
  await dispositionStarted.promise;
  const precise = manager.cleanupById("native-cross-entry");
  releaseDisposition.resolve();
  const [dueResult, preciseResult] = await Promise.all([due, precise]);

  assert.equal(disposeCalls, 1);
  assert.equal(dueResult[0]?.cleanup, "disposed");
  assert.deepEqual(preciseResult, dueResult[0]);
}

async function assertCleanupDeduplicatesDifferentRecordsForSameNativeIdentity(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-identity-single-flight-");
  const store = new NativeExecutionStore({ rootPath, now: () => 260_000 });
  const dispositionStarted = deferred<void>();
  const releaseDisposition = deferred<void>();
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        dispositionStarted.resolve();
        await releaseDisposition.promise;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 260_000
  });
  const sharedNative = {
    ...baseRecord().native,
    id: "shared-native-identity",
    transport: "acp-stdio"
  };
  await store.upsert(baseRecord({
    id: "shared-native-record-a",
    runId: "shared-native-run-a",
    native: sharedNative,
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "process-exit"
  }));
  await store.upsert(baseRecord({
    id: "shared-native-record-b",
    runId: "shared-native-run-b",
    native: {
      ...sharedNative,
      persistence: "unknown",
      transport: undefined,
      createdAt: sharedNative.createdAt + 1
    },
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "process-exit"
  }));

  const first = manager.cleanupById("shared-native-record-a");
  await dispositionStarted.promise;
  const second = manager.cleanupById("shared-native-record-b");
  releaseDisposition.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(dispositionCalls, 1);
  assert.equal(firstResult.cleanup, "disposed");
  assert.equal(firstResult.attempted, true);
  assert.equal(secondResult.cleanup, "disposed");
  assert.equal(secondResult.attempted, false);
  assert.equal((await store.get("shared-native-record-a"))?.cleanup, "disposed");
  assert.equal((await store.get("shared-native-record-b"))?.cleanup, "disposed");
  assert.equal((await store.get("shared-native-record-b"))?.attempts, 0);
}

async function assertCleanupQuarantinesConflictingDispositionForSameNativeIdentity(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-identity-disposition-conflict-");
  const store = new NativeExecutionStore({ rootPath, now: () => 265_000 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 265_000
  });
  const sharedNative = {
    ...baseRecord().native,
    id: "conflicting-native-identity"
  };
  await store.upsert(baseRecord({
    id: "conflicting-native-record-delete",
    native: sharedNative,
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete"
  }));
  await store.upsert(baseRecord({
    id: "conflicting-native-record-archive",
    native: {
      ...sharedNative,
      persistence: "provider-persistent",
      createdAt: sharedNative.createdAt + 1
    },
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "archive"
  }));

  const result = await manager.cleanupById("conflicting-native-record-delete");
  assert.equal(result.cleanup, "quarantined");
  assert.equal(result.attempted, false);
  assert.match(result.message ?? "", /Conflicting Native disposition requests/);
  assert.equal(dispositionCalls, 0);
  for (const id of [
    "conflicting-native-record-delete",
    "conflicting-native-record-archive"
  ]) {
    const record = await store.get(id);
    assert.equal(record?.cleanup, "quarantined");
    assert.match(record?.lastError ?? "", /archive, delete/);
  }
}

async function assertLateNativeDispositionConflictQuarantinesStartedProviderAttempt(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-late-identity-conflict-");
  const store = new NativeExecutionStore({ rootPath, now: () => 267_000 });
  const providerStarted = deferred<void>();
  const releaseProvider = deferred<void>();
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        providerStarted.resolve();
        await releaseProvider.promise;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 267_000
  });
  const sharedNative = {
    ...baseRecord().native,
    id: "late-conflicting-native-identity"
  };
  await store.upsert(baseRecord({
    id: "late-conflicting-native-delete",
    runId: "late-conflicting-native-delete-run",
    native: sharedNative,
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete"
  }));

  const deleteCleanup = manager.cleanupById("late-conflicting-native-delete");
  await providerStarted.promise;
  await store.upsert(baseRecord({
    id: "late-conflicting-native-retain",
    runId: "late-conflicting-native-retain-run",
    native: {
      ...sharedNative,
      persistence: "unknown",
      createdAt: sharedNative.createdAt + 1
    },
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "retain"
  }));
  const retainCleanup = manager.cleanupById("late-conflicting-native-retain");
  await waitForRecordCleanupState(
    store,
    "late-conflicting-native-retain",
    "disposing"
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseProvider.resolve();

  const [deleteResult, retainResult] = await Promise.all([
    deleteCleanup,
    retainCleanup
  ]);
  assert.equal(dispositionCalls, 1);
  assert.equal(deleteResult.cleanup, "quarantined");
  assert.equal(deleteResult.attempted, true);
  assert.match(deleteResult.message ?? "", /Conflicting Native disposition requests/);
  assert.match(deleteResult.message ?? "", /provider disposition/i);
  assert.equal(retainResult.cleanup, "quarantined");
  assert.equal(retainResult.attempted, false);
  assert.equal((await store.get("late-conflicting-native-delete"))?.cleanup, "quarantined");
  assert.equal((await store.get("late-conflicting-native-delete"))?.attempts, 1);
  assert.equal((await store.get("late-conflicting-native-delete"))?.appliedDisposition, undefined);
  assert.equal((await store.get("late-conflicting-native-delete"))?.disposedAt, 0);
  assert.equal((await store.get("late-conflicting-native-retain"))?.cleanup, "quarantined");
  assert.equal((await store.get("late-conflicting-native-retain"))?.attempts, 0);
}

async function assertLeasedConversationCleanupWaitsForBindingRetirement(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-leased-retirement-");
  const store = new NativeExecutionStore({ rootPath, now: () => 270_000 });
  const requests: NativeExecutionDispositionRequest[] = [];
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    onDisposeNativeExecution: async (request) => {
      requests.push(request);
      return { outcome: "disposed", applied: request.requested };
    }
  });
  // A retirement should prefer the provider's durable delete capability.
  adapter.manifest.nativeExecution!.dispositions.delete = true;
  const manager = new NativeExecutionManager({
    store,
    adapters: [adapter],
    now: () => 270_000
  });

  for (const [surface, workflow] of [
    ["chat", "chat.generic"],
    ["knowledge", "knowledge.ask"]
  ] as const) {
    const native = {
      ...baseRecord().native,
      id: `leased-${surface}-native`
    };
    const turn = baseRecord({
      id: `leased-${surface}-turn`,
      runId: `leased-${surface}-run`,
      sessionId: `leased-${surface}-session`,
      surface,
      workflow,
      native,
      policy: {
        ...baseRecord().policy,
        mode: "leased-conversation",
        preferredDisposition: ["retain"]
      }
    });
    await manager.recordCreated(turn);
    const settled = await manager.settleRun({
      recordId: turn.id,
      runOutcome: "success",
      localCommit: localCommit(true)
    });

    assert.equal(settled?.localCommit, "committed");
    assert.equal(settled?.cleanup, "not-needed");
    assert.equal(settled?.requestedDisposition, undefined);
    assert.deepEqual(await store.listDueCleanup(), []);

    const retirement = baseRecord({
      id: `leased-${surface}-retirement`,
      runId: `context-retirement:${surface}`,
      sessionId: turn.sessionId,
      surface,
      workflow: "session.context-rotation.lease-rollover",
      native,
      policy: {
        ...baseRecord().policy,
        mode: "leased-conversation",
        preferredDisposition: ["delete", "archive", "process-exit", "retain"]
      },
      localCommit: "pending",
      cleanup: "awaiting-local-commit",
      retirement: {
        targetConversationId: turn.sessionId,
        targetGeneration: 2,
        targetCommitId: `commit-${surface}`,
        reason: "lease-rollover"
      }
    });
    await manager.registerRetirement(retirement);
    const promoted = await manager.promoteRetirement(retirement.id);

    assert.equal(promoted?.cleanup, "pending");
    assert.equal(promoted?.requestedDisposition, "delete");
    const cleanup = await manager.cleanupById(retirement.id);
    assert.equal(cleanup.cleanup, "disposed");
    assert.equal(cleanup.attempted, true);
    assert.equal((await store.get(turn.id))?.cleanup, "not-needed");
    assert.equal((await store.get(turn.id))?.requestedDisposition, undefined);
    assert.equal((await store.get(retirement.id))?.cleanup, "disposed");
  }

  assert.deepEqual(requests.map((request) => [request.ref.id, request.requested]), [
    ["leased-chat-native", "delete"],
    ["leased-knowledge-native", "delete"]
  ]);
  assert.equal(
    (await store.list()).some((record) => record.cleanup === "quarantined"),
    false,
    "completed leased turns must not create retain/delete disposition conflicts with their retirement"
  );
}

async function assertCleanupSerializesDifferentRecordsForSharedAdapter(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-shared-adapter-mutex-");
  const store = new NativeExecutionStore({ rootPath, now: () => 275_000 });
  const firstDispositionStarted = deferred<void>();
  const releaseDispositions = deferred<void>();
  let activeDispositions = 0;
  let maximumConcurrentDispositions = 0;
  let disposeCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls += 1;
        activeDispositions += 1;
        maximumConcurrentDispositions = Math.max(maximumConcurrentDispositions, activeDispositions);
        if (request.ref.id === "shared-adapter-native-1") firstDispositionStarted.resolve();
        await releaseDispositions.promise;
        activeDispositions -= 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 275_000
  });
  await store.upsert(baseRecord({
    id: "shared-adapter-record-1",
    native: { ...baseRecord().native, id: "shared-adapter-native-1" },
    localCommit: "committed",
    cleanup: "pending",
    nextAttemptAt: 0
  }));
  await store.upsert(baseRecord({
    id: "shared-adapter-record-2",
    native: { ...baseRecord().native, id: "shared-adapter-native-2" },
    localCommit: "committed",
    cleanup: "pending",
    nextAttemptAt: 0
  }));

  const first = manager.cleanupById("shared-adapter-record-1");
  await firstDispositionStarted.promise;
  const second = manager.cleanupById("shared-adapter-record-2");
  await waitForRecordCleanupState(store, "shared-adapter-record-2", "disposing");
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.equal(disposeCalls, 1);
  assert.equal(maximumConcurrentDispositions, 1);
  releaseDispositions.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.cleanup, "disposed");
  assert.equal(secondResult.cleanup, "disposed");
  assert.equal(disposeCalls, 2);
  assert.equal(maximumConcurrentDispositions, 1);
}

async function assertCleanupCoordinatesAcrossManagerReplacement(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-manager-replacement-");
  const firstStore = new NativeExecutionStore({ rootPath, now: () => 285_000 });
  const secondStore = new NativeExecutionStore({ rootPath, now: () => 285_000 });
  await Promise.all([
    firstStore.upsert(baseRecord({
      id: "manager-replacement-target",
      native: { ...baseRecord().native, id: "manager-replacement-native" },
      localCommit: "committed",
      cleanup: "pending",
      nextAttemptAt: 0
    })),
    secondStore.upsert(baseRecord({
      id: "manager-replacement-neighbor",
      native: { ...baseRecord().native, id: "manager-replacement-neighbor-native" }
    }))
  ]);
  assert.deepEqual(
    (await firstStore.list()).map((record) => record.id),
    ["manager-replacement-target", "manager-replacement-neighbor"].sort()
  );

  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let firstAdapterCalls = 0;
  let replacementAdapterCalls = 0;
  const firstManager = new NativeExecutionManager({
    store: firstStore,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        firstAdapterCalls += 1;
        firstStarted.resolve();
        await releaseFirst.promise;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 285_000
  });
  const replacementManager = new NativeExecutionManager({
    store: secondStore,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        replacementAdapterCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 285_000
  });

  const first = firstManager.cleanupById("manager-replacement-target");
  await firstStarted.promise;
  const replacement = replacementManager.cleanupById("manager-replacement-target");
  releaseFirst.resolve();
  const [firstResult, replacementResult] = await Promise.all([first, replacement]);

  assert.deepEqual(replacementResult, firstResult);
  assert.equal(firstAdapterCalls, 1);
  assert.equal(replacementAdapterCalls, 0);
  assert.equal((await secondStore.get("manager-replacement-target"))?.cleanup, "disposed");
}

async function assertCleanupFairnessReservesCapacityForNewRecords(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-cleanup-fairness-");
  const store = new NativeExecutionStore({ rootPath, now: () => 300_000 });
  const disposed: string[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposed.push(request.ref.id);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 300_000
  });

  for (let index = 0; index < 20; index += 1) {
    await store.upsert(baseRecord({
      id: `retry-${index}`,
      native: { ...baseRecord().native, id: `retry-native-${index}` },
      localCommit: "committed",
      cleanup: "failed",
      attempts: 1,
      nextAttemptAt: 0,
      createdAt: index + 1
    }));
  }
  await store.upsert(baseRecord({
    id: "new-cleanup",
    native: { ...baseRecord().native, id: "new-native" },
    localCommit: "committed",
    cleanup: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1_000
  }));

  const results = await manager.cleanupDue(20);

  assert.equal(results.length, 20);
  assert.ok(results.some((result) => result.recordId === "new-cleanup"));
  assert.ok(disposed.includes("new-native"));
  assert.equal(results.filter((result) => result.recordId.startsWith("retry-")).length, 19);
}

async function assertPreciseCleanupBypassesRetryBacklog(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-precise-cleanup-");
  const store = new NativeExecutionStore({ rootPath, now: () => 400_000 });
  const disposed: string[] = [];
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposed.push(request.ref.id);
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 400_000
  });
  for (let index = 0; index < 20; index += 1) {
    await store.upsert(baseRecord({
      id: `precise-backlog-${index}`,
      native: { ...baseRecord().native, id: `precise-backlog-native-${index}` },
      localCommit: "committed",
      cleanup: "failed",
      attempts: 3,
      nextAttemptAt: 0
    }));
  }

  await store.upsert(baseRecord({
    id: "precise-new",
    native: { ...baseRecord().native, id: "precise-native-new" },
    localCommit: "committed",
    cleanup: "pending",
    nextAttemptAt: 0
  }));
  const result = await manager.cleanupById("precise-new");

  assert.equal(result.cleanup, "disposed");
  assert.deepEqual(disposed, ["precise-native-new"]);
  assert.equal((await store.get("precise-new"))?.cleanup, "disposed");
}

async function assertCleanupStartedEventFailureDoesNotBlockDisposition(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-start-event-warning-");
  const store = new NativeExecutionStore({ rootPath, now: () => 500_000 });
  let disposeCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 500_000,
    emitRunEvent: async (event) => {
      if (event.type === "agent.native_cleanup.started") throw new Error("started event failed");
    }
  });
  await store.upsert(baseRecord({
    id: "native-start-event-warning",
    localCommit: "committed",
    cleanup: "pending",
    nextAttemptAt: 0
  }));

  const result = await manager.cleanupDue();
  const record = await store.get("native-start-event-warning");

  assert.equal(disposeCalls, 1);
  assert.equal(result[0]?.cleanup, "disposed");
  assert.match(result[0]?.message ?? "", /started event failed/);
  assert.equal(record?.cleanup, "disposed");
  assert.match(record?.lastError ?? "", /started event failed/);
  assert.equal(record?.attempts, 1);
}

async function assertCleanupConnectionFailureIsBoundedWithoutProviderDisposition(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-cleanup-connect-defer-");
  let now = 525_000;
  const store = new NativeExecutionStore({ rootPath, now: () => now });
  let connectionCalls = 0;
  let dispositionCalls = 0;
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    onDisposeNativeExecution: async (request) => {
      dispositionCalls += 1;
      return { outcome: "disposed", applied: request.requested };
    }
  });
  adapter.connect = async () => {
    connectionCalls += 1;
    return {
      connected: false,
      label: "Fake Agent",
      errors: ["backend transport unavailable"]
    };
  };
  const manager = new NativeExecutionManager({
    store,
    adapters: [adapter],
    now: () => now
  });
  await store.upsert(baseRecord({
    id: "native-connect-defer",
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "process-exit",
    nextAttemptAt: 0
  }));

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const result = await manager.cleanupById("native-connect-defer");
    const record = await store.get("native-connect-defer");
    assert.equal(result.cleanup, attempt < 6 ? "failed" : "quarantined");
    assert.equal(result.attempted, false);
    assert.match(result.message ?? "", /backend transport unavailable/);
    assert.equal(record?.cleanup, attempt < 6 ? "failed" : "quarantined");
    assert.equal(record?.attempts, attempt);
    assert.equal(record?.disposedAt, 0);
    assert.equal(record?.appliedDisposition, undefined);
    if (attempt < 6) {
      assert.ok((record?.nextAttemptAt ?? 0) > now);
      now = record?.nextAttemptAt ?? now;
    } else {
      assert.equal(record?.nextAttemptAt, 0);
      assert.equal(record?.quarantinedAt, now);
    }
  }
  const seventh = await manager.cleanupById("native-connect-defer");
  assert.equal(seventh.cleanup, "quarantined");
  assert.equal(seventh.attempted, false);
  assert.equal(connectionCalls, 6);
  assert.equal(dispositionCalls, 0);
}

async function assertInterruptedDisposingRecordRecoveryDoesNotDoubleCountClaim(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-interrupted-disposition-");
  const store = new NativeExecutionStore({ rootPath, now: () => 550_000 });
  let attemptsSeenByAdapter = -1;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        attemptsSeenByAdapter = (await store.get("native-interrupted-disposition"))?.attempts ?? -1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 550_000
  });
  await store.upsert(baseRecord({
    id: "native-interrupted-disposition",
    localCommit: "committed",
    cleanup: "disposing",
    cleanupStartedAt: 540_000,
    attempts: 2,
    nextAttemptAt: 0
  }));

  const result = await manager.cleanupDue();
  const record = await store.get("native-interrupted-disposition");

  assert.equal(result[0]?.cleanup, "disposed");
  assert.equal(attemptsSeenByAdapter, 3);
  assert.equal(record?.attempts, 3);
  assert.match(record?.lastError ?? "", /interrupted before a terminal receipt/);
}

async function assertPostClaimFailureReleasesCleanupWithoutRestart(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-post-claim-release-");
  const store = new NativeExecutionStore({ rootPath, now: () => 555_000 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 555_000
  });
  await store.upsert(baseRecord({
    id: "native-post-claim-release",
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    nextAttemptAt: 0
  }));
  const realList = store.list.bind(store);
  let failIdentityRead = true;
  store.list = async () => {
    if (failIdentityRead) {
      failIdentityRead = false;
      throw new Error("transient identity read after cleanup claim");
    }
    return await realList();
  };

  await assert.rejects(
    manager.cleanupById("native-post-claim-release"),
    /transient identity read after cleanup claim/
  );
  const released = await store.get("native-post-claim-release");
  assert.equal(released?.cleanup, "failed");
  assert.equal(released?.attempts, 1);
  assert.equal(released?.cleanupStartedAt, undefined);
  assert.match(released?.lastError ?? "", /transient identity read after cleanup claim/);
  assert.equal(dispositionCalls, 0);

  const retry = await manager.cleanupById("native-post-claim-release");
  assert.equal(retry.cleanup, "disposed");
  assert.equal(retry.attempted, true);
  assert.equal((await store.get("native-post-claim-release"))?.attempts, 2);
  assert.equal(dispositionCalls, 1);
}

async function assertPostClaimRecoveryRetriesAfterReleaseFailure(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-post-claim-release-retry-");
  const store = new NativeExecutionStore({ rootPath, now: () => 557_000 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 557_000
  });
  await store.upsert(baseRecord({
    id: "native-post-claim-release-retry",
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    nextAttemptAt: 0
  }));
  const realList = store.list.bind(store);
  let failIdentityRead = true;
  store.list = async () => {
    if (failIdentityRead) {
      failIdentityRead = false;
      throw new Error("transient identity read before release retry");
    }
    return await realList();
  };
  const realUpdate = store.update.bind(store);
  let failReleaseWrite = true;
  store.update = async (id, updater) => {
    const current = await store.get(id);
    if (failReleaseWrite && current?.cleanup === "disposing") {
      failReleaseWrite = false;
      throw new Error("transient cleanup claim release write failure");
    }
    return await realUpdate(id, updater);
  };

  await assert.rejects(
    manager.cleanupById("native-post-claim-release-retry"),
    /transient identity read before release retry.*transient cleanup claim release write failure/
  );
  assert.equal((await store.get("native-post-claim-release-retry"))?.cleanup, "disposing");
  assert.equal(dispositionCalls, 0);

  const retry = await manager.cleanupById("native-post-claim-release-retry");
  assert.equal(retry.cleanup, "disposed");
  assert.equal(retry.attempted, true);
  assert.equal((await store.get("native-post-claim-release-retry"))?.attempts, 2);
  assert.match(
    (await store.get("native-post-claim-release-retry"))?.lastError ?? "",
    /interrupted before a terminal receipt/
  );
  assert.equal(dispositionCalls, 1);
}

async function assertSixthInterruptedDispositionIsQuarantinedBeforeAnotherAdapterCall(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-sixth-interrupted-disposition-");
  const store = new NativeExecutionStore({ rootPath, now: () => 560_000 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 560_000
  });
  await store.upsert(baseRecord({
    id: "native-sixth-interrupted-disposition",
    localCommit: "committed",
    cleanup: "disposing",
    cleanupStartedAt: 559_000,
    attempts: 6,
    nextAttemptAt: 0,
    requestedDisposition: "delete"
  }));

  assert.deepEqual(await manager.cleanupDue(), []);
  const record = await store.get("native-sixth-interrupted-disposition");
  assert.equal(record?.cleanup, "quarantined");
  assert.equal(record?.attempts, 6);
  assert.equal(record?.nextAttemptAt, 0);
  assert.match(record?.lastError ?? "", /interrupted before a terminal receipt/);
  assert.equal(dispositionCalls, 0);
}

async function assertExhaustedLegacyFailureIsQuarantinedBeforeDisposition(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-exhausted-legacy-");
  const store = new NativeExecutionStore({ rootPath, now: () => 575_000 });
  let disposeCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        disposeCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 575_000
  });
  await store.upsert(baseRecord({
    id: "native-exhausted-legacy",
    localCommit: "committed",
    cleanup: "failed",
    attempts: 6,
    nextAttemptAt: 0,
    lastError: "sixth legacy failure"
  }));

  assert.deepEqual(await manager.cleanupDue(), []);
  const record = await store.get("native-exhausted-legacy");
  assert.equal(disposeCalls, 0);
  assert.equal(record?.cleanup, "quarantined");
  assert.equal(record?.attempts, 6);
  assert.equal(record?.nextAttemptAt, 0);
  assert.match(record?.lastError ?? "", /retry limit was already exhausted/);
}

async function assertNonExecutableCleanupStatesStayOutOfDueQueue(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-non-executable-states-");
  const store = new NativeExecutionStore({ rootPath, now: () => 600_000 });
  for (const cleanup of ["awaiting-local-commit", "aborted", "quarantined"] as const) {
    const isAwaiting = cleanup === "awaiting-local-commit";
    const isAborted = cleanup === "aborted";
    await store.upsert(baseRecord({
      id: `native-${cleanup}`,
      cleanup,
      localCommit: isAwaiting ? "pending" : isAborted ? "failed" : "committed",
      nextAttemptAt: 0,
      retirement: isAwaiting || isAborted ? {
        targetConversationId: "conversation-1",
        targetGeneration: 2,
        targetCommitId: "commit-2",
        reason: "new-context"
      } : undefined,
      quarantinedAt: cleanup === "quarantined" ? 599_000 : undefined
    }));
  }
  await store.upsert(baseRecord({
    id: "native-executable",
    localCommit: "committed",
    cleanup: "pending",
    nextAttemptAt: 0
  }));

  assert.deepEqual((await store.listDueCleanup()).map((record) => record.id), ["native-executable"]);
}

async function assertMissingLeasedCleanupAuthorityCannotReachProvider(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-missing-leased-cleanup-authority-");
  const store = new NativeExecutionStore({ rootPath, now: () => 625_000 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 625_000
  });
  const missing = baseRecord({
    id: "native-missing-leased-retirement",
    runId: "run-missing-leased-retirement",
    sessionId: "conversation-missing-leased-retirement",
    surface: "chat",
    workflow: "chat.generic",
    policy: {
      ...baseRecord().policy,
      mode: "leased-conversation"
    },
    runOutcome: "success",
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    settledAt: 1,
    committedAt: 1
  });
  await store.upsert(missing);

  assert.deepEqual(await store.listDueCleanup(), []);
  assert.equal(
    await store.claimCleanup(missing.id, 625_000, { ignoreSchedule: true }),
    null,
    "the Store claim boundary must reject leased cleanup without retirement proof"
  );
  assert.deepEqual(
    (await manager.listAwaitingLocalCommitRetirements()).map((record) => record.id),
    [missing.id],
    "startup authority scanning must retain and expose malformed leased evidence"
  );

  const precise = await manager.cleanupById(missing.id);

  assert.equal(precise.cleanup, "quarantined");
  assert.equal(precise.attempted, false);
  assert.match(
    precise.message ?? "",
    /missing durable retirement evidence/
  );
  assert.equal((await store.get(missing.id))?.cleanup, "quarantined");
  assert.equal(dispositionCalls, 0);

  const sharedNative = {
    ...missing.native,
    id: "shared-native-with-missing-authority"
  };
  const indirectMissing = {
    ...missing,
    id: "native-indirect-missing-leased-retirement",
    runId: "run-indirect-missing-leased-retirement",
    native: sharedNative
  };
  const authorizedEphemeral = baseRecord({
    id: "native-authorized-ephemeral-shared-identity",
    runId: "run-authorized-ephemeral-shared-identity",
    native: sharedNative,
    runOutcome: "success",
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    settledAt: 1,
    committedAt: 1
  });
  await store.upsert(indirectMissing);
  await store.upsert(authorizedEphemeral);

  assert.deepEqual(
    (await store.listDueCleanup()).map((record) => record.id),
    [authorizedEphemeral.id]
  );
  const sharedIdentityCleanup = await manager.cleanupDue();

  assert.equal(sharedIdentityCleanup[0]?.recordId, authorizedEphemeral.id);
  assert.equal(sharedIdentityCleanup[0]?.cleanup, "quarantined");
  assert.equal(sharedIdentityCleanup[0]?.attempted, false);
  assert.equal((await store.get(indirectMissing.id))?.cleanup, "quarantined");
  assert.equal((await store.get(authorizedEphemeral.id))?.cleanup, "quarantined");
  assert.equal(dispositionCalls, 0);
}

async function assertRetirementTransitionsAreExplicitAndIdempotent(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-retirement-transitions-");
  const store = new NativeExecutionStore({ rootPath, now: () => 650_000 });
  const manager = new NativeExecutionManager({ store, adapters: [], now: () => 650_000 });
  const retirement = {
    targetConversationId: "conversation-1",
    targetGeneration: 2,
    targetCommitId: "commit-2",
    reason: "new-context"
  };
  const promoteRegistration = baseRecord({
    id: "retirement-promote",
    localCommit: "pending",
    cleanup: "awaiting-local-commit",
    retirement
  });
  assert.deepEqual(
    await manager.registerRetirement(promoteRegistration),
    promoteRegistration
  );
  assert.deepEqual(
    await manager.registerRetirement(promoteRegistration),
    promoteRegistration
  );
  await manager.registerRetirement(baseRecord({
    id: "retirement-abort",
    localCommit: "pending",
    cleanup: "awaiting-local-commit",
    retirement: { ...retirement, targetCommitId: "commit-abort" }
  }));
  await manager.registerRetirement(baseRecord({
    id: "retirement-quarantine",
    localCommit: "pending",
    cleanup: "awaiting-local-commit",
    retirement: { ...retirement, targetCommitId: "commit-quarantine" }
  }));

  assert.deepEqual(
    (await manager.listAwaitingLocalCommitRetirements()).map((record) => record.id),
    ["retirement-abort", "retirement-promote", "retirement-quarantine"]
  );
  const promoted = await manager.promoteRetirement("retirement-promote");
  const promotedAgain = await manager.promoteRetirement("retirement-promote");
  assert.equal(promoted?.localCommit, "committed");
  assert.equal(promoted?.cleanup, "pending");
  assert.equal(promoted?.nextAttemptAt, 650_000);
  assert.deepEqual(promotedAgain, promoted);
  assert.deepEqual(
    await manager.registerRetirement(promoteRegistration),
    promoted,
    "re-registering a promoted retirement must not reset it to awaiting"
  );
  await assert.rejects(
    () => manager.registerRetirement({
      ...promoteRegistration,
      retirement: {
        ...retirement,
        targetCommitId: "conflicting-commit"
      }
    }),
    /retirement id conflicts/
  );
  assert.deepEqual(await store.get("retirement-promote"), promoted);

  const aborted = await manager.abortRetirement("retirement-abort", "target commit absent");
  const abortedAgain = await manager.abortRetirement("retirement-abort", "target commit absent");
  assert.equal(aborted?.localCommit, "failed");
  assert.equal(aborted?.cleanup, "aborted");
  assert.deepEqual(abortedAgain, aborted);

  const quarantined = await manager.quarantineRetirement("retirement-quarantine", "commit evidence conflicts");
  const quarantinedAgain = await manager.quarantineRetirement("retirement-quarantine", "commit evidence conflicts");
  assert.equal(quarantined?.cleanup, "quarantined");
  assert.equal(quarantined?.localCommit, "pending");
  assert.deepEqual(quarantinedAgain, quarantined);
  assert.deepEqual((await store.listDueCleanup()).map((record) => record.id), ["retirement-promote"]);
}

async function assertHarnessServiceJournalPromotionGate(): Promise<void> {
  const promoted: string[] = [];
  const service = new EchoInkHarnessService({
    settings: {
      opencode: { serverUrl: "", hostname: "127.0.0.1", port: 4096 },
      agents: { hermes: { serverUrl: "" } }
    },
    getVaultPath: () => "/vault",
    getPluginDataDirName: () => "codex-echoink"
  } as never);
  (service as any).getNativeExecutionManager = () => ({
    async promoteRetirement(recordId: string) {
      promoted.push(recordId);
      return {};
    }
  });
  (service as any).getNativeExecutionRefContext = () => ({
    deviceKey: "device-journal-gate",
    vaultId: "/vault"
  });
  const retirement: SessionContextRetirement = {
    retirementId: "journal-gated-retirement",
    recordMutationId: "mutation-journal-gated-retirement",
    reason: "start-new-context",
    targetConversationId: "conversation-journal-gate",
    sourceGeneration: 2,
    sourceCommitId: "commit-journal-source",
    sourceContextId: "context-journal-source",
    sourceWorkspaceFingerprint: "sha256:journal-workspace",
    targetGeneration: 3,
    targetCommitId: "commit-journal-target",
    targetContextId: "context-journal-target",
    targetWorkspaceFingerprint: "sha256:journal-workspace",
    backendId: "codex-cli",
    binding: {
      backendId: "codex-cli",
      nativeThreadId: "thread-journal-gate",
      nativeExecutionKind: "thread",
      syncedSessionRevision: 2,
      lastUsedAt: 1
    }
  };

  await assert.rejects(
    service.promoteNativeExecutionRetirements([retirement]),
    /authority reader is unavailable/
  );
  await assert.rejects(
    service.promoteNativeExecutionRetirements(
      [retirement],
      async () => journalRevisionForRetirement(retirement, false)
    ),
    /Journal is not committed/
  );
  assert.deepEqual(promoted, []);

  await service.promoteNativeExecutionRetirements(
    [retirement],
    async () => journalRevisionForRetirement(retirement, true)
  );
  assert.deepEqual(promoted, [retirement.retirementId]);
}

async function assertHarnessServiceExposesTypedNativeLifecycleFacade(): Promise<void> {
  const calls: string[] = [];
  const registered: NativeExecutionRecord[] = [];
  let awaitingListCalls = 0;
  const awaiting = baseRecord({
    id: "facade-retirement",
    localCommit: "pending",
    cleanup: "awaiting-local-commit",
    retirement: {
      targetConversationId: "conversation-facade",
      targetGeneration: 3,
      targetCommitId: "commit-facade",
      targetContextId: "context-facade",
      targetWorkspaceFingerprint: "sha256:workspace-facade",
      reason: "workspace-switch"
    }
  });
  const fakeManager = {
    async listPendingLocalCommits() {
      calls.push("list-pending");
      return [];
    },
    async markPendingLocalCommitsFailed() {
      calls.push("mark-pending");
      return 0;
    },
    async cleanupDue(limit: number) {
      calls.push(`cleanup-due:${limit}`);
      return [];
    },
    async cleanupById(recordId: string) {
      calls.push(`cleanup:${recordId}`);
      return { recordId, cleanup: "disposed" as const, attempted: true };
    },
    async registerRetirement(record: NativeExecutionRecord) {
      calls.push(`register:${record.id}`);
      registered.push(record);
      return record;
    },
    async listAwaitingLocalCommitRetirements() {
      calls.push("list");
      awaitingListCalls += 1;
      return awaitingListCalls === 1 ? [] : [awaiting];
    },
    async promoteRetirement(recordId: string, expected: NativeExecutionRecord) {
      calls.push(`promote:${recordId}`);
      assert.equal(expected.native.deviceKey, "unknown");
      assert.equal(expected.retirement?.targetCommitId, "commit-facade");
      return awaiting;
    },
    async abortRetirement(recordId: string, reason: string, expected: NativeExecutionRecord) {
      calls.push(`abort:${recordId}:${reason}`);
      assert.equal(expected.native.vaultId, "unknown");
      return awaiting;
    },
    async quarantineRetirement(recordId: string, reason: string, expected: NativeExecutionRecord) {
      calls.push(`quarantine:${recordId}:${reason}`);
      assert.equal(expected.native.providerEndpoint, undefined);
      return awaiting;
    }
  };
  const service = new EchoInkHarnessService({
    settings: {
      opencode: { serverUrl: "", hostname: "127.0.0.1", port: 4096 },
      agents: { hermes: { serverUrl: "" } }
    },
    getVaultPath: () => "/vault",
    getPluginDataDirName: () => "codex-echoink"
  } as any);
  (service as any).getNativeExecutionManager = () => fakeManager;
  (service as any).getNativeExecutionRefContext = () => ({
    deviceKey: "device-facade",
    vaultId: "/vault"
  });
  const retirement: SessionContextRetirement = {
    retirementId: "facade-retirement",
    reason: "workspace-switch",
    targetConversationId: "conversation-facade",
    targetGeneration: 3,
    targetCommitId: "commit-facade",
    targetContextId: "context-facade",
    targetWorkspaceFingerprint: "sha256:workspace-facade",
    backendId: "codex-cli",
    binding: {
      backendId: "codex-cli",
      nativeThreadId: "thread-facade",
      nativeExecutionKind: "thread",
      syncedSessionRevision: 2,
      lastUsedAt: 123
    }
  };

  await assert.rejects(
    () => service.cleanupNativeExecutionRecord("facade-retirement"),
    /Native cleanup is blocked until startup reconciliation succeeds/
  );
  assert.deepEqual(
    calls,
    [],
    "cleanup must fail closed before the startup authority pass reaches the manager"
  );
  assert.deepEqual(
    await service.reconcileNativeExecutionStartup(
      async () => {
        throw new Error("the empty startup fixture must not request Conversation authority");
      },
      { cleanupLimit: 0 }
    ),
    {
      recoveredPendingRecordMutationCount: 0,
      recoveredPendingChatCount: 0,
      recoveredPendingHermesProposalCount: 0,
      recoveredStartedRunRetentionCount: 0,
      awaitingCount: 0,
      promotedCount: 0,
      abortedCount: 0,
      quarantinedCount: 0,
      retirements: [],
      cleanup: []
    }
  );
  assert.deepEqual(
    await service.cleanupNativeExecutionRecord("facade-retirement"),
    { recordId: "facade-retirement", cleanup: "disposed", attempted: true }
  );
  const conflictingBatchRetirement: SessionContextRetirement = {
    ...retirement,
    binding: {
      ...retirement.binding,
      nativeThreadId: "thread-conflicting"
    }
  };
  const callsBeforeRegisterConflict = [...calls];
  await assert.rejects(
    () => service.registerNativeExecutionRetirements([
      retirement,
      conflictingBatchRetirement
    ]),
    /retirement batch identity conflict/
  );
  assert.deepEqual(calls, callsBeforeRegisterConflict);
  assert.equal(registered.length, 0);
  const invalidSecondRetirement: SessionContextRetirement = {
    ...retirement,
    retirementId: "facade-invalid-second",
    backendId: "opencode",
    binding: {
      ...retirement.binding,
      backendId: "codex-cli"
    }
  };
  await assert.rejects(
    () => service.registerNativeExecutionRetirements([
      retirement,
      invalidSecondRetirement
    ]),
    /backend mismatch/
  );
  assert.deepEqual(calls, callsBeforeRegisterConflict);
  assert.equal(
    registered.length,
    0,
    "the full retirement batch must materialize before the first durable mutation"
  );
  const partialSourceRetirement: SessionContextRetirement = {
    ...retirement,
    retirementId: "facade-partial-source",
    sourceGeneration: 2
  };
  await assert.rejects(
    () => service.registerNativeExecutionRetirements([
      retirement,
      partialSourceRetirement
    ]),
    /source identity is partial or invalid/
  );
  assert.deepEqual(calls, callsBeforeRegisterConflict);
  assert.equal(
    registered.length,
    0,
    "partial source identity must reject the whole batch before durable registration"
  );
  await service.registerNativeExecutionRetirements([retirement, retirement]);
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.id, retirement.retirementId);
  assert.equal(registered[0]?.native.id, "thread-facade");
  assert.equal(registered[0]?.native.backendId, "codex-cli");
  assert.equal(registered[0]?.native.deviceKey, "unknown");
  assert.equal(registered[0]?.native.vaultId, "unknown");
  assert.equal(registered[0]?.native.providerEndpoint, undefined);
  assert.deepEqual(registered[0]?.policy.preferredDisposition, ["retain"]);
  assert.equal(registered[0]?.cleanup, "awaiting-local-commit");
  assert.equal(registered[0]?.localCommit, "pending");
  assert.equal(registered[0]?.retirement?.targetContextId, "context-facade");
  assert.equal(
    registered[0]?.retirement?.targetWorkspaceFingerprint,
    "sha256:workspace-facade"
  );
  const untrustedRefRetirement: SessionContextRetirement = {
    ...retirement,
    retirementId: "facade-untrusted-ref",
    backendId: "opencode",
    binding: {
      ...retirement.binding,
      backendId: "opencode",
      nativeThreadId: undefined,
      nativeExecutionKind: "session",
      nativeExecutionRef: {
        backendId: "opencode",
        id: "session-untrusted",
        kind: "session",
        persistence: "provider-persistent",
        providerEndpoint: "http://127.0.0.1:4096",
        deviceKey: "unknown",
        vaultId: "unknown",
        createdAt: 123
      }
    }
  };
  await service.registerNativeExecutionRetirements([untrustedRefRetirement]);
  assert.deepEqual(registered[1]?.policy.preferredDisposition, ["retain"]);
  assert.deepEqual(await service.listAwaitingNativeExecutionRetirements(), [awaiting]);
  const callsBeforeBatchConflict = [...calls];
  await assert.rejects(
    () => service.promoteNativeExecutionRetirements([
      retirement,
      conflictingBatchRetirement
    ]),
    /retirement batch identity conflict/
  );
  assert.deepEqual(
    calls,
    callsBeforeBatchConflict,
    "a conflicting duplicate retirement ID must fail before any transition"
  );
  await service.promoteNativeExecutionRetirements([retirement, retirement]);
  await service.abortNativeExecutionRetirements([retirement, retirement], "commit missing");
  await service.quarantineNativeExecutionRetirements([retirement, retirement], "evidence conflict");
  assert.deepEqual(calls, [
    "list-pending",
    "mark-pending",
    "list-pending",
    "list-pending",
    "list-pending",
    "list",
    "cleanup-due:0",
    "cleanup:facade-retirement",
    "register:facade-retirement",
    "register:facade-untrusted-ref",
    "list",
    "promote:facade-retirement",
    "abort:facade-retirement:commit missing",
    "quarantine:facade-retirement:evidence conflict"
  ]);

  const mainSource = await readFile(path.join(process.cwd(), "src/main.ts"), "utf8");
  assert.match(
    mainSource,
    /cleanupNativeExecutionRecord\(recordId: string\): Promise<NativeCleanupResult>[\s\S]*getHarnessService\(\)\.cleanupNativeExecutionRecord\(recordId\)/
  );
  const harnessServiceSource = await readFile(
    path.join(process.cwd(), "src/plugin/harness-service.ts"),
    "utf8"
  );
  for (const method of [
    "registerNativeExecutionRetirements",
    "listAwaitingNativeExecutionRetirements",
    "promoteNativeExecutionRetirements",
    "abortNativeExecutionRetirements",
    "quarantineNativeExecutionRetirements"
  ]) {
    assert.match(harnessServiceSource, new RegExp(`async ${method}\\(`));
  }
}

async function assertRetirementBatchCollisionCannotMutateExistingIdentity(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-retirement-collision-");
  const store = new NativeExecutionStore({ rootPath, now: () => 675_000 });
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 675_000
  });
  const existing = baseRecord({
    id: "retirement-collision",
    sessionId: "conversation-existing",
    native: {
      ...baseRecord().native,
      id: "native-existing",
      deviceKey: "device-existing",
      vaultId: "vault-existing"
    },
    localCommit: "pending",
    cleanup: "awaiting-local-commit",
    retirement: {
      targetConversationId: "conversation-existing",
      targetGeneration: 4,
      targetCommitId: "commit-existing",
      reason: "history-restore"
    }
  });
  const first = baseRecord({
    id: "retirement-first",
    sessionId: "conversation-first",
    native: { ...baseRecord().native, id: "native-first" },
    localCommit: "pending",
    cleanup: "awaiting-local-commit",
    retirement: {
      targetConversationId: "conversation-first",
      targetGeneration: 2,
      targetCommitId: "commit-first",
      reason: "start-new-context"
    }
  });
  const colliding = baseRecord({
    ...existing,
    id: existing.id,
    sessionId: "conversation-colliding",
    native: {
      ...existing.native,
      id: "native-colliding",
      deviceKey: "device-colliding"
    },
    retirement: {
      targetConversationId: "conversation-colliding",
      targetGeneration: 9,
      targetCommitId: "commit-colliding",
      reason: "workspace-switch"
    }
  });
  await manager.registerRetirement(existing);
  const existingBefore = JSON.stringify(await store.get(existing.id));
  await manager.registerRetirement(first);

  await assert.rejects(
    () => manager.registerRetirement(colliding),
    /retirement id conflicts/
  );
  await assert.rejects(
    () => manager.promoteRetirement(colliding.id, colliding),
    /retirement identity conflicts/
  );
  assert.equal(JSON.stringify(await store.get(existing.id)), existingBefore);

  await manager.abortRetirement(first.id, "batch registration failed", first);
  await assert.rejects(
    () => manager.abortRetirement(colliding.id, "batch registration failed", colliding),
    /retirement identity conflicts/
  );
  assert.equal((await store.get(first.id))?.cleanup, "aborted");
  assert.equal(JSON.stringify(await store.get(existing.id)), existingBefore);

  const events = (await readFile(
    path.join(rootPath, "native-executions.jsonl"),
    "utf8"
  ))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(
    events.filter((event) =>
      event.type === "upsert" && event.record?.id === existing.id).length,
    1,
    "collision and compensating abort must not append an event for the pre-existing identity"
  );
  assert.deepEqual(await manager.cleanupDue(), []);
  assert.equal(dispositionCalls, 0);
}

async function assertRecordCreatedCannotOverwriteOrReviveExistingRegistration(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-registration-idempotency-");
  const store = new NativeExecutionStore({ rootPath, now: () => 690_000 });
  const manager = new NativeExecutionManager({ store, adapters: [], now: () => 690_000 });
  const initial = baseRecord({
    id: "stable-native-registration",
    runId: "stable-native-run",
    sessionId: "stable-native-session"
  });

  await manager.recordCreated(initial);
  await manager.recordCreated(initial);
  const terminal: NativeExecutionRecord = {
    ...initial,
    runOutcome: "success",
    localCommit: "committed",
    cleanup: "quarantined",
    attempts: 6,
    nextAttemptAt: 0,
    lastError: "manual recovery required",
    settledAt: 689_000,
    committedAt: 689_000,
    quarantinedAt: 689_500
  };
  await store.upsert(terminal);
  const indexPath = path.join(rootPath, "native-executions-index.json");
  const eventsPath = path.join(rootPath, "native-executions.jsonl");
  const indexBeforeReplay = await readFile(indexPath, "utf8");
  const eventsBeforeReplay = await readFile(eventsPath, "utf8");

  await manager.recordCreated(initial);
  assert.deepEqual(await store.get(initial.id), terminal);
  assert.equal(await readFile(indexPath, "utf8"), indexBeforeReplay);
  assert.equal(await readFile(eventsPath, "utf8"), eventsBeforeReplay);

  await assert.rejects(
    () => manager.recordCreated({
      ...initial,
      native: {
        ...initial.native,
        id: "conflicting-native-registration"
      }
    }),
    /registration id conflicts/
  );
  assert.deepEqual(await store.get(initial.id), terminal);
  assert.equal(await readFile(indexPath, "utf8"), indexBeforeReplay);
  assert.equal(await readFile(eventsPath, "utf8"), eventsBeforeReplay);
}

async function assertNativeTransportValidationAndLegacyReplay(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-transport-");
  const store = new NativeExecutionStore({ rootPath, now: () => 695_000 });
  const manager = new NativeExecutionManager({
    store,
    adapters: [],
    now: () => 695_000
  });
  const initial = baseRecord({
    id: "native-transport-safe",
    runId: "run-transport-safe",
    sessionId: "session-transport-safe",
    native: {
      ...baseRecord().native,
      backendId: "hermes",
      id: "hermes-acp-safe",
      kind: "session",
      persistence: "provider-persistent",
      transport: "acp-stdio"
    }
  });

  await manager.recordCreated(initial);
  assert.equal(
    (await store.get(initial.id))?.native.transport,
    "acp-stdio"
  );

  const legacyReplay = structuredClone(initial);
  delete legacyReplay.native.transport;
  await manager.recordCreated(legacyReplay);
  assert.equal(
    (await store.get(initial.id))?.native.transport,
    "acp-stdio",
    "a transport-less legacy replay must remain compatible without erasing audited metadata"
  );

  await assert.rejects(
    manager.recordCreated({
      ...structuredClone(initial),
      native: {
        ...structuredClone(initial.native),
        transport: "acp-http"
      }
    }),
    /registration id conflicts/,
    "two known transports must not replay as the same registration identity"
  );

  const indexPath = path.join(rootPath, "native-executions-index.json");
  const eventsPath = path.join(rootPath, "native-executions.jsonl");
  const indexBeforeUnsafe = await readFile(indexPath, "utf8");
  const eventsBeforeUnsafe = await readFile(eventsPath, "utf8");
  for (const [ordinal, transport] of [
    "acp-stdio?token=TOP_SECRET",
    `a-${"x".repeat(128)}`
  ].entries()) {
    await assert.rejects(
      manager.recordCreated(baseRecord({
        id: `native-transport-unsafe-${ordinal}`,
        runId: `run-transport-unsafe-${ordinal}`,
        native: {
          ...baseRecord().native,
          id: `unsafe-native-${ordinal}`,
          transport
        }
      })),
      /Invalid Native Execution Store record mutation/
    );
  }
  assert.equal(await readFile(indexPath, "utf8"), indexBeforeUnsafe);
  assert.equal(await readFile(eventsPath, "utf8"), eventsBeforeUnsafe);
}

async function assertNativeExecutionStoreRequiresExplicitV1MigrationBeforeMutation(): Promise<void> {
  const v1Root = await tempRoot("echoink-native-store-v1-");
  const v1Record = baseRecord({ id: "native-v1" });
  const v1IndexPath = path.join(v1Root, "native-executions-index.json");
  const v1EventsPath = path.join(v1Root, "native-executions.jsonl");
  const v1IndexText = `${JSON.stringify({
    version: 1,
    updatedAt: 1,
    records: [v1Record]
  })}\n`;
  const v1EventsText = `${JSON.stringify({
    type: "upsert",
    record: v1Record,
    createdAt: 1
  })}\n`;
  await writeFile(v1IndexPath, v1IndexText, "utf8");
  await writeFile(v1EventsPath, v1EventsText, "utf8");
  const v1Store = new NativeExecutionStore({ rootPath: v1Root, now: () => 700_000 });
  assert.equal((await v1Store.get("native-v1"))?.id, "native-v1");
  assert.deepEqual((await v1Store.list()).map((record) => record.id), ["native-v1"]);

  await assertMigrationRequired(() => v1Store.upsert(baseRecord({ id: "must-not-upgrade-v1" })));
  await assertMigrationRequired(() => v1Store.insertIfAbsent(baseRecord({ id: "must-not-insert-v1" })));
  await assertMigrationRequired(() => v1Store.update("native-v1", (record) => ({ ...record, attempts: 1 })));
  await assertMigrationRequired(() => v1Store.claimCleanup("native-v1", 700_000, { ignoreSchedule: true }));
  await assertMigrationRequired(() => v1Store.requeueInterruptedCleanupClaims("recovery", 700_000));
  await assertMigrationRequired(() => v1Store.quarantineExhaustedCleanupAttempts("exhausted", 700_000));
  await assertRebuildUnsupported(() => v1Store.rebuildIndexFromEvents());

  let cleanupCalls = 0;
  const manager = new NativeExecutionManager({
    store: v1Store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        cleanupCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 700_000
  });
  await assertMigrationRequired(() => manager.cleanupDue());
  await assertMigrationRequired(() => manager.cleanupById("native-v1"));
  assert.equal(cleanupCalls, 0);
  assert.equal(await readFile(v1IndexPath, "utf8"), v1IndexText);
  assert.equal(await readFile(v1EventsPath, "utf8"), v1EventsText);

  const migration = await v1Store.migrateSchemaV1ToV2();
  assert.equal(migration.status, "migrated");
  assert.equal(migration.recordCount, 1);
  assert.notEqual(migration.beforeFingerprint, migration.afterFingerprint);
  assert.deepEqual(
    JSON.parse(await readFile(v1IndexPath, "utf8")),
    {
      version: 2,
      updatedAt: 1,
      records: [v1Record]
    }
  );
  assert.equal(await readFile(v1EventsPath, "utf8"), v1EventsText);
  assert.deepEqual(await v1Store.migrateSchemaV1ToV2(), {
    status: "already-v2",
    recordCount: 1,
    beforeFingerprint: migration.afterFingerprint,
    afterFingerprint: migration.afterFingerprint
  });
  const nestedReader = new NativeExecutionStore({ rootPath: v1Root });
  const nestedSnapshot = await Promise.race([
    v1Store.withMutation(
      async () => await nestedReader.inspectMigrationSnapshot()
    ),
    delay(2_000).then(() => {
      throw new Error(
        "Native Store nested migration readback deadlocked"
      );
    })
  ]);
  assert.equal(nestedSnapshot.schemaVersion, 2);
  assert.equal(nestedSnapshot.records.length, 1);
  await v1Store.insertIfAbsent(
    baseRecord({ id: "native-v2-after-migration" })
  );
  assert.deepEqual(
    (await v1Store.list()).map((record) => record.id).sort(),
    ["native-v1", "native-v2-after-migration"]
  );
}

async function assertNativeExecutionStoreRequiresRecoveryWhenIndexIsMissingWithAuditHistory(): Promise<void> {
  for (const indexState of ["missing", "empty"] as const) {
    const rootPath = await tempRoot(`echoink-native-store-${indexState}-index-`);
    const indexPath = path.join(rootPath, "native-executions-index.json");
    const eventsPath = path.join(rootPath, "native-executions.jsonl");
    const auditRecord = baseRecord({ id: `audit-only-${indexState}` });
    const eventsText = `${JSON.stringify({
      type: "upsert",
      record: auditRecord,
      createdAt: 1
    })}\n`;
    if (indexState === "empty") await writeFile(indexPath, "", "utf8");
    await writeFile(eventsPath, eventsText, "utf8");
    const store = new NativeExecutionStore({ rootPath, now: () => 710_000 });

    await assertRecoveryRequired(() => store.list());
    await assertRecoveryRequired(() => store.get(auditRecord.id));
    await assertRecoveryRequired(() => store.upsert(baseRecord({ id: "must-not-create-authority" })));
    await assertRecoveryRequired(() => store.insertIfAbsent(baseRecord({ id: "must-not-insert-authority" })));
    await assertRecoveryRequired(() => store.update(auditRecord.id, (record) => ({ ...record, attempts: 1 })));
    await assertRecoveryRequired(() => store.claimCleanup(auditRecord.id, 710_000, { ignoreSchedule: true }));
    await assertRecoveryRequired(() => store.requeueInterruptedCleanupClaims("recovery", 710_000));
    await assertRecoveryRequired(() => store.quarantineExhaustedCleanupAttempts("exhausted", 710_000));
    await assertRebuildUnsupported(() => store.rebuildIndexFromEvents());

    let dispositionCalls = 0;
    const manager = new NativeExecutionManager({
      store,
      adapters: [new FakeAgentAdapter({
        backendId: "fake",
        responseText: "pong",
        onDisposeNativeExecution: async (request) => {
          dispositionCalls += 1;
          return { outcome: "disposed", applied: request.requested };
        }
      })],
      now: () => 710_000
    });
    await assertRecoveryRequired(() => manager.cleanupDue());
    assert.equal(dispositionCalls, 0);
    assert.equal(await readFile(eventsPath, "utf8"), eventsText);
    if (indexState === "empty") {
      assert.equal(await readFile(indexPath, "utf8"), "");
    } else {
      await assert.rejects(readFile(indexPath, "utf8"), { code: "ENOENT" });
    }
  }
}

async function assertNativeExecutionStoreRequiresRecoveryForExistingBlankStorageMarkers(): Promise<void> {
  for (const [name, indexText, eventsText] of [
    ["empty-index", "", null],
    ["whitespace-index", " \n\t", null],
    ["missing-index-empty-events", null, ""],
    ["missing-index-whitespace-events", null, " \n\t"]
  ] as const) {
    const rootPath = await tempRoot(`echoink-native-store-${name}-`);
    const indexPath = path.join(rootPath, "native-executions-index.json");
    const eventsPath = path.join(rootPath, "native-executions.jsonl");
    if (indexText !== null) await writeFile(indexPath, indexText, "utf8");
    if (eventsText !== null) await writeFile(eventsPath, eventsText, "utf8");
    const store = new NativeExecutionStore({ rootPath, now: () => 715_000 });

    await assertRecoveryRequired(() => store.list());
    await assertRecoveryRequired(() => store.upsert(baseRecord({ id: `must-not-overwrite-${name}` })));
    await assertRecoveryRequired(() => store.claimCleanup("missing", 715_000, { ignoreSchedule: true }));

    let dispositionCalls = 0;
    const manager = new NativeExecutionManager({
      store,
      adapters: [new FakeAgentAdapter({
        backendId: "fake",
        responseText: "pong",
        onDisposeNativeExecution: async (request) => {
          dispositionCalls += 1;
          return { outcome: "disposed", applied: request.requested };
        }
      })],
      now: () => 715_000
    });
    await assertRecoveryRequired(() => manager.cleanupDue());
    assert.equal(dispositionCalls, 0);
    if (indexText === null) {
      await assert.rejects(readFile(indexPath, "utf8"), { code: "ENOENT" });
    } else {
      assert.equal(await readFile(indexPath, "utf8"), indexText);
    }
    if (eventsText === null) {
      await assert.rejects(readFile(eventsPath, "utf8"), { code: "ENOENT" });
    } else {
      assert.equal(await readFile(eventsPath, "utf8"), eventsText);
    }
  }

  for (const residueName of [
    ".native-executions-index.123.456.tmp",
    "unexpected-recovery-artifact"
  ]) {
    const rootPath = await tempRoot("echoink-native-store-orphan-residue-");
    const residuePath = path.join(rootPath, residueName);
    await writeFile(residuePath, "recovery evidence", "utf8");
    const store = new NativeExecutionStore({ rootPath, now: () => 716_000 });

    await assertRecoveryRequired(() => store.list());
    await assertRecoveryRequired(() => store.upsert(baseRecord({
      id: `must-not-overwrite-${residueName}`
    })));
    assert.equal(await readFile(residuePath, "utf8"), "recovery evidence");
    await assert.rejects(
      readFile(path.join(rootPath, "native-executions-index.json"), "utf8"),
      { code: "ENOENT" }
    );
    await assert.rejects(
      readFile(path.join(rootPath, "native-executions.jsonl"), "utf8"),
      { code: "ENOENT" }
    );
  }
}

async function assertNativeExecutionStoreRequiresRecoveryForTempResidueBesideCommittedIndex(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-store-committed-index-temp-residue-");
  const indexPath = path.join(rootPath, "native-executions-index.json");
  const tempPath = path.join(
    rootPath,
    ".native-executions-index.123.456.tmp"
  );
  const store = new NativeExecutionStore({ rootPath, now: () => 718_000 });
  const committed = baseRecord({
    id: "committed-before-temp-residue",
    native: {
      ...baseRecord().native,
      id: "committed-before-temp-residue-native"
    },
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    nextAttemptAt: 0
  });
  const uncertain = baseRecord({
    id: "uncertain-temp-residue",
    native: {
      ...baseRecord().native,
      id: "uncertain-temp-residue-native"
    }
  });
  await store.upsert(committed);
  const committedIndex = await readFile(indexPath, "utf8");
  const residue = `${JSON.stringify({
    version: 2,
    updatedAt: 718_001,
    records: [committed, uncertain]
  }, null, 2)}\n`;
  await writeFile(tempPath, residue, "utf8");

  const reopened = new NativeExecutionStore({ rootPath, now: () => 718_001 });
  await assertRecoveryRequired(() => reopened.list());
  await assertRecoveryRequired(() => reopened.get(committed.id));
  await assertRecoveryRequired(() => reopened.upsert(baseRecord({
    id: "must-not-overwrite-temp-residue"
  })));
  let dispositionCalls = 0;
  const manager = new NativeExecutionManager({
    store: reopened,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution: async (request) => {
        dispositionCalls += 1;
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 718_001
  });
  await assertRecoveryRequired(() => manager.cleanupDue());
  assert.equal(dispositionCalls, 0);
  assert.equal(await readFile(indexPath, "utf8"), committedIndex);
  assert.equal(await readFile(tempPath, "utf8"), residue);
}

async function assertNativeExecutionStoreCommitsAuthorityBeforeBestEffortAudit(): Promise<void> {
  const indexFailureRoot = await tempRoot("echoink-native-store-index-write-failure-");
  const indexFailureStore = new NativeExecutionStore({
    rootPath: indexFailureRoot,
    now: () => 720_000
  });
  await indexFailureStore.upsert(baseRecord({ id: "authority-before-failure" }));
  const indexFailureIndexPath = path.join(indexFailureRoot, "native-executions-index.json");
  const indexFailureEventsPath = path.join(indexFailureRoot, "native-executions.jsonl");
  const authorityBefore = await readFile(indexFailureIndexPath, "utf8");
  const auditBefore = await readFile(indexFailureEventsPath, "utf8");
  (indexFailureStore as any).writeIndex = async () => {
    throw new Error("index write failed");
  };

  await assert.rejects(
    () => indexFailureStore.upsert(baseRecord({ id: "must-not-commit" })),
    /index write failed/
  );
  assert.equal(await readFile(indexFailureIndexPath, "utf8"), authorityBefore);
  assert.equal(await readFile(indexFailureEventsPath, "utf8"), auditBefore);
  assert.equal(await indexFailureStore.get("must-not-commit"), null);

  const auditFailureRoot = await tempRoot("echoink-native-store-audit-write-failure-");
  const observedWarnings: string[] = [];
  const auditFailureStore = new NativeExecutionStore({
    rootPath: auditFailureRoot,
    now: () => 730_000,
    onAuditWarning: (warning) => observedWarnings.push(warning)
  });
  (auditFailureStore as any).appendEvent = async () => {
    throw new Error("audit append failed");
  };
  await auditFailureStore.upsert(baseRecord({ id: "authority-committed" }));

  assert.equal((await auditFailureStore.get("authority-committed"))?.id, "authority-committed");
  assert.match(auditFailureStore.listAuditWarnings()[0] ?? "", /audit append failed/);
  assert.deepEqual(observedWarnings, auditFailureStore.listAuditWarnings());
  await assert.rejects(
    readFile(path.join(auditFailureRoot, "native-executions.jsonl"), "utf8"),
    { code: "ENOENT" }
  );
}

async function assertNativeExecutionStoreRejectsFutureAndCorruptIndexesWithoutWrites(): Promise<void> {
  const futureRoot = await tempRoot("echoink-native-store-future-");
  const futureIndexPath = path.join(futureRoot, "native-executions-index.json");
  const futureText = `${JSON.stringify({
    version: 3,
    updatedAt: 1,
    records: [baseRecord({ id: "native-future" })]
  })}\n`;
  await writeFile(futureIndexPath, futureText, "utf8");
  const futureStore = new NativeExecutionStore({ rootPath: futureRoot, now: () => 700_000 });
  await assert.rejects(() => futureStore.list(), /Unsupported Native Execution Store schema version: 3/);
  await assert.rejects(
    () => futureStore.upsert(baseRecord({ id: "must-not-overwrite-future" })),
    /Unsupported Native Execution Store schema version: 3/
  );
  await assertRebuildUnsupported(() => futureStore.rebuildIndexFromEvents());
  assert.equal(await readFile(futureIndexPath, "utf8"), futureText);

  for (const version of [1, 2]) {
    const corruptRoot = await tempRoot(`echoink-native-store-corrupt-v${version}-`);
    const corruptIndexPath = path.join(corruptRoot, "native-executions-index.json");
    const corruptEventsPath = path.join(corruptRoot, "native-executions.jsonl");
    const corruptText = `${JSON.stringify({
      version,
      updatedAt: 1,
      records: [
        baseRecord({ id: `native-valid-v${version}` }),
        { id: `native-corrupt-v${version}` }
      ]
    })}\n`;
    const eventsText = `${JSON.stringify({
      type: "remove",
      id: `native-valid-v${version}`,
      createdAt: 1
    })}\n`;
    await writeFile(corruptIndexPath, corruptText, "utf8");
    await writeFile(corruptEventsPath, eventsText, "utf8");
    const corruptStore = new NativeExecutionStore({ rootPath: corruptRoot, now: () => 700_000 });

    await assert.rejects(
      () => corruptStore.list(),
      /Invalid Native Execution Store record at index 1/
    );
    await assert.rejects(
      () => corruptStore.upsert(baseRecord({ id: `must-not-overwrite-corrupt-v${version}` })),
      /Invalid Native Execution Store record at index 1/
    );
    await assert.rejects(
      () => corruptStore.update(`native-valid-v${version}`, (record) => ({ ...record, attempts: 99 })),
      /Invalid Native Execution Store record at index 1/
    );
    await assertRebuildUnsupported(() => corruptStore.rebuildIndexFromEvents());
    let cleanupCalls = 0;
    const manager = new NativeExecutionManager({
      store: corruptStore,
      adapters: [new FakeAgentAdapter({
        backendId: "fake",
        responseText: "pong",
        onDisposeNativeExecution: async (request) => {
          cleanupCalls += 1;
          return { outcome: "disposed", applied: request.requested };
        }
      })],
      now: () => 700_000
    });
    await assert.rejects(
      () => manager.cleanupDue(),
      /Invalid Native Execution Store record at index 1/
    );
    assert.equal(cleanupCalls, 0);
    assert.equal(await readFile(corruptIndexPath, "utf8"), corruptText);
    assert.equal(await readFile(corruptEventsPath, "utf8"), eventsText);
  }

  const corruptEventRoot = await tempRoot("echoink-native-store-corrupt-event-");
  const corruptEventIndexPath = path.join(corruptEventRoot, "native-executions-index.json");
  const corruptEventLogPath = path.join(corruptEventRoot, "native-executions.jsonl");
  const validIndexText = `${JSON.stringify({
    version: 2,
    updatedAt: 1,
    records: [baseRecord({ id: "native-valid-before-corrupt-event" })]
  })}\n`;
  const corruptEventText = `${JSON.stringify({
    type: "upsert",
    record: { id: "native-invalid-event-record" },
    createdAt: 1
  })}\n`;
  await writeFile(corruptEventIndexPath, validIndexText, "utf8");
  await writeFile(corruptEventLogPath, corruptEventText, "utf8");
  const corruptEventStore = new NativeExecutionStore({ rootPath: corruptEventRoot, now: () => 700_000 });
  assert.deepEqual(
    (await corruptEventStore.list()).map((record) => record.id),
    ["native-valid-before-corrupt-event"],
    "audit corruption must not invalidate the authoritative index"
  );
  await assertRebuildUnsupported(() => corruptEventStore.rebuildIndexFromEvents());
  assert.equal(await readFile(corruptEventIndexPath, "utf8"), validIndexText);
  assert.equal(await readFile(corruptEventLogPath, "utf8"), corruptEventText);

  const duplicateRoot = await tempRoot("echoink-native-store-duplicate-id-");
  const duplicateIndexPath = path.join(duplicateRoot, "native-executions-index.json");
  const duplicateEventsPath = path.join(duplicateRoot, "native-executions.jsonl");
  const duplicateRecord = baseRecord({ id: "native-duplicate" });
  const duplicateText = `${JSON.stringify({
    version: 2,
    updatedAt: 1,
    records: [duplicateRecord, duplicateRecord]
  })}\n`;
  const duplicateEventsText = `${JSON.stringify({
    type: "upsert",
    record: duplicateRecord,
    createdAt: 1
  })}\n`;
  await writeFile(duplicateIndexPath, duplicateText, "utf8");
  await writeFile(duplicateEventsPath, duplicateEventsText, "utf8");
  const duplicateStore = new NativeExecutionStore({ rootPath: duplicateRoot, now: () => 700_000 });
  await assert.rejects(() => duplicateStore.list(), /Duplicate Native Execution Store record id at index 1/);
  await assert.rejects(
    () => duplicateStore.upsert(baseRecord({ id: "must-not-rewrite-duplicates" })),
    /Duplicate Native Execution Store record id at index 1/
  );
  await assertRebuildUnsupported(() => duplicateStore.rebuildIndexFromEvents());
  assert.equal(await readFile(duplicateIndexPath, "utf8"), duplicateText);
  assert.equal(await readFile(duplicateEventsPath, "utf8"), duplicateEventsText);

  const invalidUpdatedAtRoot = await tempRoot("echoink-native-store-invalid-updated-at-");
  const invalidUpdatedAtIndexPath = path.join(invalidUpdatedAtRoot, "native-executions-index.json");
  const invalidUpdatedAtEventsPath = path.join(invalidUpdatedAtRoot, "native-executions.jsonl");
  const invalidUpdatedAtRecord = baseRecord({ id: "native-invalid-updated-at" });
  const invalidUpdatedAtText = `{"version":2,"updatedAt":1e400,"records":[${JSON.stringify(invalidUpdatedAtRecord)}]}\n`;
  const invalidUpdatedAtEventsText = `${JSON.stringify({
    type: "upsert",
    record: invalidUpdatedAtRecord,
    createdAt: 1
  })}\n`;
  await writeFile(invalidUpdatedAtIndexPath, invalidUpdatedAtText, "utf8");
  await writeFile(invalidUpdatedAtEventsPath, invalidUpdatedAtEventsText, "utf8");
  const invalidUpdatedAtStore = new NativeExecutionStore({ rootPath: invalidUpdatedAtRoot, now: () => 700_000 });
  await assert.rejects(() => invalidUpdatedAtStore.list(), /updatedAt must be a finite non-negative safe integer/);
  await assert.rejects(
    () => invalidUpdatedAtStore.upsert(baseRecord({ id: "must-not-rewrite-invalid-updated-at" })),
    /updatedAt must be a finite non-negative safe integer/
  );
  await assertRebuildUnsupported(() => invalidUpdatedAtStore.rebuildIndexFromEvents());
  assert.equal(await readFile(invalidUpdatedAtIndexPath, "utf8"), invalidUpdatedAtText);
  assert.equal(await readFile(invalidUpdatedAtEventsPath, "utf8"), invalidUpdatedAtEventsText);
}

async function assertNativeExecutionStoreRejectsContradictoryLifecycleStatesWithoutDisposition(): Promise<void> {
  const retirement = {
    targetConversationId: "conversation-invalid",
    targetGeneration: 2,
    targetCommitId: "commit-invalid",
    reason: "start-new-context"
  };
  const invalidRecords: Array<[string, NativeExecutionRecord]> = [
    ["awaiting-with-committed-local-state", baseRecord({
      id: "invalid-awaiting-committed",
      localCommit: "committed",
      cleanup: "awaiting-local-commit",
      retirement
    })],
    ["disposing-with-pending-local-state", baseRecord({
      id: "invalid-disposing-pending",
      localCommit: "pending",
      cleanup: "disposing",
      attempts: 1,
      cleanupStartedAt: 1
    })],
    ["aborted-without-retirement", baseRecord({
      id: "invalid-aborted-without-retirement",
      localCommit: "failed",
      cleanup: "aborted"
    })],
    ["disposed-with-pending-local-state", baseRecord({
      id: "invalid-disposed-pending",
      localCommit: "pending",
      cleanup: "disposed",
      disposedAt: 1,
      appliedDisposition: "delete"
    })]
  ];

  for (const [name, invalidRecord] of invalidRecords) {
    const rootPath = await tempRoot(`echoink-native-store-invalid-lifecycle-${name}-`);
    const indexPath = path.join(rootPath, "native-executions-index.json");
    const eventsPath = path.join(rootPath, "native-executions.jsonl");
    const indexText = `${JSON.stringify({
      version: 2,
      updatedAt: 1,
      records: [invalidRecord]
    })}\n`;
    await writeFile(indexPath, indexText, "utf8");
    const store = new NativeExecutionStore({ rootPath, now: () => 735_000 });
    let dispositionCalls = 0;
    const manager = new NativeExecutionManager({
      store,
      adapters: [new FakeAgentAdapter({
        backendId: "fake",
        responseText: "pong",
        onDisposeNativeExecution: async (request) => {
          dispositionCalls += 1;
          return { outcome: "disposed", applied: request.requested };
        }
      })],
      now: () => 735_000
    });

    await assert.rejects(() => store.list(), /Invalid Native Execution Store record at index 0/);
    await assert.rejects(
      () => store.upsert(baseRecord({ id: `must-not-overwrite-${name}` })),
      /Invalid Native Execution Store record at index 0/
    );
    await assert.rejects(
      () => manager.cleanupDue(),
      /Invalid Native Execution Store record at index 0/
    );
    assert.equal(dispositionCalls, 0);
    assert.equal(await readFile(indexPath, "utf8"), indexText);
    await assert.rejects(readFile(eventsPath, "utf8"), { code: "ENOENT" });
  }
}

async function assertCleanupUnsupportedAndRetainedEvents(): Promise<void> {
  await assertCleanupTerminalEventSequence("unsupported", async (request) => ({
    outcome: "unsupported",
    message: `unsupported:${request.requested}`
  }), [
    "run.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.unsupported"
  ], "unsupported:process-exit");
  await assertCleanupTerminalEventSequence("retained", async (request) => ({
    outcome: "retained",
    message: `retained:${request.requested}`
  }), [
    "run.completed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.retained"
  ], "retained:process-exit");
}

async function assertCleanupTerminalEventSequence(
  suffix: string,
  onDisposeNativeExecution: (request: NativeExecutionDispositionRequest) => Promise<{ outcome: "unsupported" | "retained"; message: string }>,
  expectedTypes: string[],
  expectedError: string
): Promise<void> {
  let now = 60_000;
  const rootPath = await tempRoot(`echoink-native-cleanup-${suffix}-`);
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onDisposeNativeExecution
    })],
    now: () => now++,
    emitRunEvent: async (event) => await kernel.appendRunEvent(event)
  });
  await manager.recordCreated(baseRecord({
    id: `native-cleanup-${suffix}`,
    runId: `run-cleanup-${suffix}`
  }));
  await kernel.appendRunEvent({
    runId: `run-cleanup-${suffix}`,
    source: "kernel",
    type: "run.completed",
    backendId: "fake"
  });
  await manager.settleRun({
    recordId: `native-cleanup-${suffix}`,
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const result = await manager.cleanupDue();
  const events = await ledger.readRun(`run-cleanup-${suffix}`);

  assert.deepEqual(events.map((event) => event.type), expectedTypes);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(events[1]?.data, {
    recordId: `native-cleanup-${suffix}`,
    disposition: "process-exit"
  });
  assert.equal(events[3]?.error, expectedError);
  assert.equal(result[0]?.recordId, `native-cleanup-${suffix}`);
}

async function assertScheduledEventFailureKeepsCleanupRecoverable(): Promise<void> {
  let now = 70_000;
  const rootPath = await tempRoot("echoink-native-scheduled-event-failure-");
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => now++
  });
  let failScheduled = true;
  const manager = new NativeExecutionManager({
    store: new NativeExecutionStore({ rootPath, now: () => now++ }),
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => {
      if (failScheduled && event.type === "agent.native_cleanup.scheduled") throw new Error("scheduled event failed");
      await kernel.appendRunEvent(event);
    }
  });

  await manager.recordCreated(baseRecord({
    id: "native-scheduled-event-failure",
    runId: "run-scheduled-event-failure"
  }));
  const settled = await manager.settleRun({
    recordId: "native-scheduled-event-failure",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const afterFailedSchedule = settled ? await (manager as any).options.store.get("native-scheduled-event-failure") : null;

  failScheduled = false;
  const cleanup = await manager.cleanupDue();

  assert.equal(settled?.cleanup, "pending");
  assert.match(afterFailedSchedule?.lastError ?? "", /scheduled event failed/);
  assert.equal(cleanup[0]?.cleanup, "disposed");
}

async function assertCleanupTerminalEventFailureDoesNotThrowAfterStoreUpdate(): Promise<void> {
  let now = 80_000;
  const rootPath = await tempRoot("echoink-native-terminal-event-failure-");
  const store = new NativeExecutionStore({ rootPath, now: () => now++ });
  const manager = new NativeExecutionManager({
    store,
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong"
    })],
    now: () => now++,
    emitRunEvent: async (event) => {
      if (event.type === "agent.native_cleanup.completed") throw new Error("completed event failed");
    }
  });

  await manager.recordCreated(baseRecord({
    id: "native-terminal-event-failure",
    runId: "run-terminal-event-failure"
  }));
  await manager.settleRun({
    recordId: "native-terminal-event-failure",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  const cleanup = await manager.cleanupDue();
  const record = await store.get("native-terminal-event-failure");

  assert.equal(cleanup[0]?.cleanup, "disposed");
  assert.match(cleanup[0]?.message ?? "", /completed event failed/);
  assert.equal(record?.cleanup, "disposed");
  assert.match(record?.lastError ?? "", /completed event failed/);
}

async function assertPendingLocalCommitsAreMarkedFailedOnRecovery(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-recovery-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(7000) });
  const manager = new NativeExecutionManager({ store, adapters: [], now: fixedClock(8000) });
  await manager.recordCreated(baseRecord({ id: "knowledge-pending", surface: "knowledge" }));
  await manager.recordCreated(baseRecord({ id: "chat-pending", surface: "chat" }));

  assert.deepEqual(
    (await manager.listPendingLocalCommits({ surface: "knowledge" })).map((record) => record.id),
    ["knowledge-pending"]
  );

  const updated = await manager.markPendingLocalCommitsFailed("plugin reloaded", { surface: "knowledge" });
  assert.equal(updated, 1);

  const knowledge = await store.get("knowledge-pending");
  assert.equal(knowledge?.localCommit, "failed");
  assert.equal(knowledge?.cleanup, "retained-for-recovery");
  assert.equal(knowledge?.runOutcome, "failed");
  assert.equal(knowledge?.settledAt, 8000);
  assert.equal(knowledge?.lastError, "plugin reloaded");

  const chat = await store.get("chat-pending");
  assert.equal(chat?.localCommit, "pending");
}

async function assertPendingRecoverySnapshotExcludesLaterRecords(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-recovery-exact-snapshot-");
  const store = new NativeExecutionStore({ rootPath, now: fixedClock(8_000) });
  const manager = new NativeExecutionManager({
    store,
    adapters: [],
    now: fixedClock(8_100)
  });
  await manager.recordCreated(baseRecord({
    id: "knowledge-before-startup-snapshot",
    surface: "knowledge"
  }));

  const snapshot = manager.snapshotPendingLocalCommits({
    surface: "knowledge"
  });
  const laterRegistration = manager.recordCreated(baseRecord({
    id: "knowledge-after-startup-snapshot",
    runId: "run-after-startup-snapshot",
    surface: "knowledge"
  }));
  const snapshottedRecords = await snapshot;
  await laterRegistration;
  assert.deepEqual(
    snapshottedRecords.map((record) => record.id),
    ["knowledge-before-startup-snapshot"]
  );

  for (const record of snapshottedRecords) {
    await manager.markPendingLocalCommitsFailed("plugin reloaded", {
      recordId: record.id,
      surface: "knowledge"
    });
  }
  assert.equal(
    (await store.get("knowledge-before-startup-snapshot"))?.localCommit,
    "failed"
  );
  assert.equal(
    (await store.get("knowledge-after-startup-snapshot"))?.localCommit,
    "pending",
    "a knowledge execution registered after the exact snapshot must stay live"
  );
}

async function assertPendingRecoveryCannotOverwriteConcurrentSuccessfulSettlement(): Promise<void> {
  const rootPath = await tempRoot("echoink-native-recovery-settlement-race-");
  const store = new NativeExecutionStore({ rootPath, now: () => 8_500 });
  const manager = new NativeExecutionManager({ store, adapters: [], now: () => 8_500 });
  await manager.recordCreated(baseRecord({
    id: "knowledge-pending-race",
    surface: "knowledge",
    policy: {
      ...baseRecord().policy,
      mode: "leased-conversation"
    }
  }));

  const listed = deferred<void>();
  const continueRecovery = deferred<void>();
  const listPendingLocalCommits = manager.listPendingLocalCommits.bind(manager);
  manager.listPendingLocalCommits = async (filter = {}) => {
    const records = await listPendingLocalCommits(filter);
    listed.resolve();
    await continueRecovery.promise;
    return records;
  };

  const recovery = manager.markPendingLocalCommitsFailed(
    "plugin reloaded",
    { surface: "knowledge" }
  );
  await listed.promise;
  await manager.settleRun({
    recordId: "knowledge-pending-race",
    runOutcome: "success",
    localCommit: localCommit(true)
  });
  continueRecovery.resolve();

  assert.equal(await recovery, 0);
  const record = await store.get("knowledge-pending-race");
  assert.equal(record?.runOutcome, "success");
  assert.equal(record?.localCommit, "committed");
  assert.equal(record?.cleanup, "not-needed");
  assert.equal(record?.lastError, "");
}

function journalRevisionForRetirement(
  retirement: SessionContextRetirement,
  committed: boolean
): RecordMutationRevision {
  const planned = createPlannedRecordMutationRevision({
    mutationId: retirement.recordMutationId!,
    intent: {
      operation: "start-new-context",
      conversationId: retirement.targetConversationId,
      expectedConversationGeneration: retirement.sourceGeneration!,
      expectedConversationCommitId: retirement.sourceCommitId!,
      expectedConversationContentRevision: `sha256:${"1".repeat(64)}`,
      targetConversation: {
        status: "present",
        generation: retirement.targetGeneration,
        commitId: retirement.targetCommitId,
        contentRevision: `sha256:${"2".repeat(64)}`
      },
      participants: [{
        id: "conversation",
        recordKind: "conversation",
        action: "retain"
      }],
      rootBindings: [],
      trashPolicy: "not-required"
    },
    createdAt: 1
  });
  const staged = transitionRecordMutationRevision(planned, {
    state: "staged",
    step: {
      direction: "forward",
      ordinal: 1,
      participantId: "conversation",
      action: "prepared",
      evidenceDigest: planned.intentDigest
    },
    terminal: null,
    updatedAt: 2
  });
  return committed
    ? transitionRecordMutationRevision(staged, {
      state: "committed",
      step: null,
      terminal: {
        at: 3,
        code: "committed",
        message: "journal promotion test"
      },
      updatedAt: 3
    })
    : staged;
}

function baseRecord(overrides: Partial<NativeExecutionRecord> = {}): NativeExecutionRecord {
  return {
    id: "native-1",
    runId: "run-native",
    sessionId: "session-native",
    surface: "knowledge",
    workflow: "knowledge.maintain",
    native: {
      backendId: "fake",
      id: "fake-native",
      kind: "process",
      persistence: "process-local",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["delete", "archive", "process-exit", "retain"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    localCommit: "pending",
    cleanup: "not-needed",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt: 1,
    settledAt: 0,
    committedAt: 0,
    disposedAt: 0,
    ...overrides
  };
}

function localCommit(committed: boolean, error = ""): LocalRunCommitResult {
  return {
    committed,
    conversationCommitted: committed,
    runLedgerCommitted: committed,
    artifactsCommitted: committed,
    historyIndexCommitted: committed,
    ...(error ? { error } : {})
  };
}

function fixedClock(start: number): () => number {
  let current = start;
  return () => current++;
}

async function tempRoot(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForRecordCleanupState(
  store: NativeExecutionStore,
  recordId: string,
  cleanup: NativeExecutionRecord["cleanup"]
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await store.get(recordId))?.cleanup === cleanup) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${recordId} to enter cleanup state ${cleanup}`);
}

async function assertMigrationRequired(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof NativeExecutionStoreMigrationRequiredError);
    assert.equal(error.code, "NATIVE_EXECUTION_STORE_MIGRATION_REQUIRED");
    assert.equal(error.currentVersion, 1);
    return true;
  });
}

async function assertRecoveryRequired(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof NativeExecutionStoreRecoveryRequiredError);
    assert.equal(error.code, "NATIVE_EXECUTION_STORE_RECOVERY_REQUIRED");
    return true;
  });
}

async function assertRebuildUnsupported(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof NativeExecutionStoreRebuildUnsupportedError);
    assert.equal(error.code, "NATIVE_EXECUTION_STORE_REBUILD_UNSUPPORTED");
    return true;
  });
}
