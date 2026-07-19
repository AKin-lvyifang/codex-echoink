import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import type {
  ConversationAuthorityProbe,
  ConversationAuthorityProof
} from "../../harness/conversation/conversation-store";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { NativeExecutionRecord } from "../../harness/contracts/native-execution";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { appendPendingMemoryEvent } from "../../harness/memory/v2-store";
import {
  applyMemoryCuratorResult,
  prepareMemoryTransaction
} from "../../harness/memory/v2-engine";
import {
  NativeExecutionManager,
  type NativeCleanupResult
} from "../../harness/native/native-execution-manager";
import { NativeExecutionStore } from "../../harness/native/native-execution-store";
import { EchoInkHarnessService } from "../../plugin/harness-service";
import {
  createEchoInkChatRunTerminalRecovery,
  echoInkChatTerminalRawRef,
  type PendingRunTerminalRecovery
} from "../../core/message-state";
import { prepareRawMessage } from "../../core/raw-message-store";
import {
  DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT,
  reconcileNativeExecutionsAtStartup,
  type NativeStartupReconciliationHost
} from "../../plugin/native-startup-reconciliation";

export async function runHarnessV2NativeStartupReconciliationTests(): Promise<void> {
  await assertAuthorityProofClassificationPrecedesBoundedCleanup();
  await assertIncompleteAuthorityIsQuarantinedWithoutPromoteOrAbort();
  await assertPartialSourceIdentityFailsClosedWhileLegacyRemainsReadable();
  await assertAuthorityReadFailureIsQuarantinedBeforeCleanup();
  await assertStoreFailureSkipsCleanupCompletely();
  await assertTransitionFailureSkipsCleanupCompletely();
  await assertCleanupLimitIsBounded();
  await assertOnlyExactAuthorityReachesProviderCleanup();
  await assertPreexistingRetirementCleanupStatesRequireAuthorityProof();
  await assertMissingLeasedRetirementFailsStartupClosed();
  await assertExhaustedMissingLeasedRetirementFailsStartupClosed();
  await assertUnsafeNativeStoresAndUnknownIdentityNeverReachProvider();
  await assertStartupCleanupConnectsCodexWithoutManualPreconnect();
  await assertHarnessServiceRunsAuthorityGateBeforeCleanup();
  await assertHarnessServiceCleanupGateIsSingleFlight();
  await assertHarnessServiceCleanupGateStaysClosedUntilSuccessfulRetry();
  await assertPostGateCleanupByIdCannotBypassMissingLeasedAuthority();
  await assertEditorCrashBeforeLedgerIsRetainedIdempotently();
  await assertEditorCrashAfterLedgerSettlesAndCleansIdempotently();
  await assertEditorFailedAndCancelledTerminalsRemainDurableCommits();
  await assertEditorTerminalConflictAndLedgerCorruptionBlockCleanup();
  await assertEditorLedgerReadAndSettlementFailuresBlockCleanup();
  await assertEphemeralUtilityRunLedgerRecovery();
  await assertEphemeralUtilityRecoveryValidatesAllRunsBeforeMutation();
  await assertEphemeralUtilityRecoveryRejectsImpossibleLedgerOrder();
  await assertBackendProbeStartupTerminalRecovery();
  await assertBackendProbeStartupCorruptLedgerIsAtomic();
  await assertHermesProposalStartupReceiptAndCommitMatrix();
  await assertHermesProposalStartupValidationIsAtomicAndFailClosed();
  await assertKnowledgeRecoveryCannotPreemptHermesProposalStartupAuthority();
  await assertChatRecoveryFilterDoesNotSweepPromptEnhancer();
  await assertChatRecoveryValidatesAllRunsBeforeSettlement();
  await assertChatRecoveryRejectsDuplicateAndConflictingTerminals();
  await assertChatRegistrationWithoutSurfaceCommitIsRetainedOnRestart();
  await assertDurableChatTerminalWithoutConversationMarkerRemainsRetained();
  await assertStartupRequiresFullChatTerminalIdentity();
  await assertStartupVerifiesImmutableRawTerminalIdentity();
  await assertPendingChatRecoveryLeavesRetirementsForAuthorityGate();
  await assertConcurrentCommittedChatSettlementWinsStartupRecovery();
  await assertProductionStartupWiringUsesConversationAuthority();
}

async function assertAuthorityProofClassificationPrecedesBoundedCleanup(): Promise<void> {
  const records = [
    retirementRecord("exact", 2, "commit-exact"),
    retirementRecord("before", 3, "commit-before"),
    retirementRecord("later", 2, "commit-later"),
    retirementRecord("conflict", 2, "commit-conflict")
  ];
  const calls: string[] = [];
  const proofs = new Map<string, ConversationAuthorityProof>([
    ["commit-exact", authorityProof("exact", "active", 2, "commit-exact")],
    ["commit-before", authorityProof("before", "absent", 2, "commit-current")],
    ["commit-later", authorityProof("later", "previous", 3, "commit-current")],
    ["commit-conflict", authorityProof("conflict", "absent", 2, "commit-current")]
  ]);
  const host = reconciliationHost({
    records,
    calls,
    prove: async (probe) => proofs.get(probe.targetCommitId)!
  });

  const result = await reconcileNativeExecutionsAtStartup(host);

  assert.deepEqual(calls, [
    "list",
    "prove:commit-exact",
    "promote:exact",
    "prove:commit-before",
    "abort:before",
    "prove:commit-later",
    "quarantine:later",
    "prove:commit-conflict",
    "quarantine:conflict",
    `cleanup:${DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT}`
  ]);
  assert.deepEqual(
    result.retirements.map(({ recordId, action }) => ({ recordId, action })),
    [
      { recordId: "exact", action: "promoted" },
      { recordId: "before", action: "aborted" },
      { recordId: "later", action: "quarantined" },
      { recordId: "conflict", action: "quarantined" }
    ]
  );
  assert.equal(result.awaitingCount, 4);
  assert.equal(result.promotedCount, 1);
  assert.equal(result.abortedCount, 1);
  assert.equal(result.quarantinedCount, 2);
  assert.deepEqual(result.cleanup, [{
    recordId: "due",
    cleanup: "disposed",
    attempted: true
  }]);
}

async function assertIncompleteAuthorityIsQuarantinedWithoutPromoteOrAbort(): Promise<void> {
  for (const [relation, targetPayload] of [
    ["exact", "previous"],
    ["before", "previous"],
    ["later", "absent"],
    ["conflict", "active"]
  ] as const) {
    const calls: string[] = [];
    const record = retirementRecord(
      `${relation}-${targetPayload}`,
      2,
      `commit-${relation}-${targetPayload}`
    );
    const host = reconciliationHost({
      records: [record],
      calls,
      prove: async () => authorityProof(
        relation,
        targetPayload,
        relation === "later" ? 3 : 2,
        "commit-current"
      )
    });

    const result = await reconcileNativeExecutionsAtStartup(host);

    assert.equal(result.retirements[0]?.action, "quarantined");
    assert.equal(calls.some((call) => call.startsWith("promote:")), false);
    assert.equal(calls.some((call) => call.startsWith("abort:")), false);
    assert.equal(calls.filter((call) => call.startsWith("quarantine:")).length, 1);
  }
}

async function assertPartialSourceIdentityFailsClosedWhileLegacyRemainsReadable(): Promise<void> {
  const partial = retirementRecord(
    "partial-source-identity",
    2,
    "commit-partial-source"
  );
  partial.retirement = {
    ...partial.retirement!,
    sourceGeneration: 1
  };
  const calls: string[] = [];
  const host = reconciliationHost({
    records: [partial],
    calls,
    prove: async () => {
      throw new Error("partial source identity must fail before Conversation proof");
    }
  });

  await assert.rejects(
    reconcileNativeExecutionsAtStartup(host),
    /Native retirement source identity is partial or invalid/
  );
  assert.deepEqual(calls, [
    "list",
    "quarantine:partial-source-identity"
  ]);

  const explicitNullSource = retirementRecord(
    "complete-null-source-identity",
    1,
    "commit-complete-null-source"
  );
  explicitNullSource.retirement = {
    ...explicitNullSource.retirement!,
    sourceGeneration: 1,
    sourceCommitId: null,
    sourceContextId: null,
    sourceWorkspaceFingerprint: null
  };
  const nullSourceCalls: string[] = [];
  const nullSourceResult = await reconcileNativeExecutionsAtStartup(
    reconciliationHost({
      records: [explicitNullSource],
      calls: nullSourceCalls,
      prove: async () => ({
        conversationId: "conversation-1",
        currentGeneration: 1,
        targetPayload: "absent",
        relation: "conflict"
      })
    })
  );
  assert.equal(nullSourceResult.abortedCount, 1);
  assert.deepEqual(nullSourceCalls, [
    "list",
    "prove:commit-complete-null-source",
    "abort:complete-null-source-identity",
    `cleanup:${DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT}`
  ]);

  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-native-source-identity-validation-")
  );
  try {
    const store = new NativeExecutionStore({
      rootPath,
      now: () => 1
    });
    const legacy = retirementRecord(
      "legacy-source-identity",
      2,
      "commit-legacy-source"
    );
    await store.upsert(legacy);
    assert.equal(
      (await store.get(legacy.id))?.retirement?.sourceGeneration,
      undefined,
      "a retirement with no source fields must retain legacy conservative semantics"
    );
    await store.upsert(explicitNullSource);
    assert.equal(
      (await store.get(explicitNullSource.id))?.retirement?.sourceCommitId,
      null
    );
    await assert.rejects(
      store.upsert(partial),
      /Invalid Native Execution Store record mutation/
    );
    assert.equal(await store.get(partial.id), null);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertAuthorityReadFailureIsQuarantinedBeforeCleanup(): Promise<void> {
  const calls: string[] = [];
  const host = reconciliationHost({
    records: [retirementRecord("corrupt-conversation", 2, "commit-corrupt")],
    calls,
    prove: async () => {
      throw new Error("Conversation index schema is unknown or corrupt");
    }
  });

  await assert.rejects(
    reconcileNativeExecutionsAtStartup(host),
    /Conversation authority proof failed: Conversation index schema is unknown or corrupt/
  );
  assert.deepEqual(calls, [
    "list",
    "prove:commit-corrupt",
    "quarantine:corrupt-conversation"
  ]);
}

async function assertStoreFailureSkipsCleanupCompletely(): Promise<void> {
  let cleanupCalls = 0;
  const host: NativeStartupReconciliationHost = {
    async listAwaitingRetirements() {
      throw new Error("Unsupported Native Execution Store schema version: 3");
    },
    async proveConversationAuthority() {
      throw new Error("must not prove");
    },
    async promoteRetirement() {
      throw new Error("must not promote");
    },
    async abortRetirement() {
      throw new Error("must not abort");
    },
    async quarantineRetirement() {
      throw new Error("must not quarantine");
    },
    async cleanupDue() {
      cleanupCalls += 1;
      return [];
    }
  };

  await assert.rejects(
    reconcileNativeExecutionsAtStartup(host),
    /Unsupported Native Execution Store schema version: 3/
  );
  assert.equal(cleanupCalls, 0);
}

async function assertTransitionFailureSkipsCleanupCompletely(): Promise<void> {
  let cleanupCalls = 0;
  const host = reconciliationHost({
    records: [retirementRecord("v1", 2, "commit-v1")],
    prove: async () => authorityProof("exact", "active", 2, "commit-v1"),
    promote: async () => {
      throw new Error("explicit migration to v2 is required");
    },
    cleanup: async () => {
      cleanupCalls += 1;
      return [];
    }
  });

  await assert.rejects(
    reconcileNativeExecutionsAtStartup(host),
    /explicit migration to v2 is required/
  );
  assert.equal(cleanupCalls, 0);
}

async function assertCleanupLimitIsBounded(): Promise<void> {
  const seen: number[] = [];
  const host = reconciliationHost({
    records: [],
    cleanup: async (limit) => {
      seen.push(limit);
      return [];
    }
  });
  await reconcileNativeExecutionsAtStartup(host, { cleanupLimit: 1_000 });
  await reconcileNativeExecutionsAtStartup(host, { cleanupLimit: -2 });
  await reconcileNativeExecutionsAtStartup(host, { cleanupLimit: Number.NaN });
  assert.deepEqual(seen, [100, 0, DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT]);
}

async function assertOnlyExactAuthorityReachesProviderCleanup(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-authority-gate-"));
  try {
    const records = [
      trustedFakeRetirementRecord("exact-real", 2, "commit-exact-real"),
      trustedFakeRetirementRecord("before-real", 3, "commit-before-real"),
      trustedFakeRetirementRecord("later-real", 2, "commit-later-real")
    ];
    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    for (const record of records) await store.upsert(record);
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const baseHost = managerHost(manager);
    const host: NativeStartupReconciliationHost = {
      ...baseHost,
      async proveConversationAuthority(probe) {
        if (probe.targetCommitId === "commit-exact-real") {
          return authorityProof("exact", "active", 2, probe.targetCommitId);
        }
        if (probe.targetCommitId === "commit-before-real") {
          return authorityProof("before", "absent", 2, "commit-current");
        }
        return authorityProof("later", "previous", 3, "commit-current");
      }
    };

    const result = await reconcileNativeExecutionsAtStartup(host);

    assert.equal(result.promotedCount, 1);
    assert.equal(result.abortedCount, 1);
    assert.equal(result.quarantinedCount, 1);
    assert.equal(providerDispositionCalls, 1);
    assert.equal((await store.get("exact-real"))?.cleanup, "disposed");
    assert.equal((await store.get("before-real"))?.cleanup, "aborted");
    assert.equal((await store.get("later-real"))?.cleanup, "quarantined");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertPreexistingRetirementCleanupStatesRequireAuthorityProof(): Promise<void> {
  for (const [cleanup, proof] of [
    ["pending", authorityProof("later", "previous", 3, "commit-current")],
    ["failed", authorityProof("before", "absent", 1, "commit-current")]
  ] as const) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-${cleanup}-retirement-authority-`
    ));
    try {
      const store = new NativeExecutionStore({ rootPath, now: () => 100 });
      const retirement = trustedFakeRetirementRecord(
        `${cleanup}-contradictory`,
        2,
        `commit-${cleanup}-contradictory`
      );
      await store.upsert({
        ...retirement,
        localCommit: "committed",
        cleanup,
        requestedDisposition: "delete",
        attempts: cleanup === "failed" ? 1 : 0,
        committedAt: 1,
        nextAttemptAt: 0,
        lastError: cleanup === "failed" ? "prior cleanup failure" : ""
      });
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });

      const result = await reconcileNativeExecutionsAtStartup(
        managerHost(manager, async () => proof)
      );

      assert.equal(result.quarantinedCount, 1);
      assert.equal((await store.get(retirement.id))?.cleanup, "quarantined");
      assert.equal(providerDispositionCalls, 0);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }

  const corruptRoot = await mkdtemp(path.join(
    tmpdir(),
    "echoink-startup-corrupt-pending-retirement-authority-"
  ));
  try {
    const store = new NativeExecutionStore({ rootPath: corruptRoot, now: () => 100 });
    const retirement = trustedFakeRetirementRecord(
      "pending-corrupt-authority",
      2,
      "commit-pending-corrupt-authority"
    );
    await store.upsert({
      ...retirement,
      localCommit: "committed",
      cleanup: "pending",
      requestedDisposition: "delete",
      committedAt: 1
    });
    await store.upsert(pendingCleanupRecord("unrelated-provider-cleanup"));
    let providerDispositionCalls = 0;
    const manager = nativeManager(corruptRoot, () => {
      providerDispositionCalls += 1;
    });

    await assert.rejects(
      reconcileNativeExecutionsAtStartup(managerHost(manager, async () => {
        throw new Error("Conversation authority index is corrupt");
      })),
      /Conversation authority proof failed: Conversation authority index is corrupt/
    );

    assert.equal((await store.get(retirement.id))?.cleanup, "quarantined");
    assert.equal(
      (await store.get("unrelated-provider-cleanup"))?.cleanup,
      "pending",
      "authority read failure must fail closed before unrelated provider cleanup"
    );
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(corruptRoot, { recursive: true, force: true });
  }
}

async function assertMissingLeasedRetirementFailsStartupClosed(): Promise<void> {
  for (const cleanup of ["pending", "failed"] as const) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-missing-${cleanup}-leased-retirement-`
    ));
    try {
      const store = new NativeExecutionStore({ rootPath, now: () => 100 });
      const missing = missingLeasedRetirementCleanupRecord(
        `missing-${cleanup}-leased-retirement`,
        cleanup
      );
      const unrelated = pendingCleanupRecord(
        `unrelated-ephemeral-after-missing-${cleanup}`
      );
      await store.upsert(missing);
      await store.upsert(unrelated);
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });

      await assert.rejects(
        reconcileNativeExecutionsAtStartup(managerHost(manager)),
        /leased-conversation cleanup authority is missing durable retirement evidence/
      );

      const quarantined = await store.get(missing.id);
      assert.equal(quarantined?.cleanup, "quarantined");
      assert.equal(quarantined?.quarantinedAt, 100);
      assert.match(
        quarantined?.lastError ?? "",
        /missing durable retirement evidence/
      );
      assert.equal(
        (await store.get(unrelated.id))?.cleanup,
        "pending",
        "an authority gap must close the startup gate before unrelated cleanup"
      );
      assert.equal(providerDispositionCalls, 0);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertExhaustedMissingLeasedRetirementFailsStartupClosed(): Promise<void> {
  for (const cleanup of ["pending", "failed", "disposing"] as const) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-exhausted-missing-${cleanup}-leased-retirement-`
    ));
    try {
      const store = new NativeExecutionStore({ rootPath, now: () => 100 });
      const missing = missingLeasedRetirementCleanupRecord(
        `exhausted-missing-${cleanup}-leased-retirement`,
        cleanup,
        6
      );
      const unrelated = pendingCleanupRecord(
        `unrelated-ephemeral-after-exhausted-missing-${cleanup}`
      );
      await store.upsert(missing);
      await store.upsert(unrelated);
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });

      await assert.rejects(
        reconcileNativeExecutionsAtStartup(managerHost(manager)),
        /leased-conversation cleanup authority is missing durable retirement evidence/
      );

      assert.equal((await store.get(missing.id))?.cleanup, "quarantined");
      assert.equal(
        (await store.get(unrelated.id))?.cleanup,
        "pending",
        "exhausted authority gaps must close startup before unrelated cleanup"
      );
      assert.equal(providerDispositionCalls, 0);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertUnsafeNativeStoresAndUnknownIdentityNeverReachProvider(): Promise<void> {
  for (const storeState of ["future", "corrupt", "v1"] as const) {
    const rootPath = await mkdtemp(path.join(tmpdir(), `echoink-startup-${storeState}-`));
    try {
      const record = pendingCleanupRecord(`record-${storeState}`);
      const indexPath = path.join(rootPath, "native-executions-index.json");
      if (storeState === "future") {
        await writeFile(indexPath, `${JSON.stringify({
          version: 3,
          updatedAt: 1,
          records: [record]
        })}\n`, "utf8");
      } else if (storeState === "corrupt") {
        await writeFile(indexPath, "{\"version\":2,\"records\":[", "utf8");
      } else {
        await writeFile(indexPath, `${JSON.stringify({
          version: 1,
          updatedAt: 1,
          records: [record]
        })}\n`, "utf8");
      }
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });

      await assert.rejects(
        reconcileNativeExecutionsAtStartup(managerHost(manager)),
        storeState === "future"
          ? /Unsupported Native Execution Store schema version/
          : storeState === "v1"
            ? /explicit migration to v2 is required/
            : /JSON/
      );
      assert.equal(
        providerDispositionCalls,
        0,
        `${storeState} Native authority must fail before provider disposition`
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }

  const unknownRoot = await mkdtemp(path.join(tmpdir(), "echoink-startup-unknown-"));
  try {
    let providerDispositionCalls = 0;
    const store = new NativeExecutionStore({ rootPath: unknownRoot, now: () => 100 });
    const manager = nativeManager(unknownRoot, () => {
      providerDispositionCalls += 1;
    });
    await store.upsert(pendingCleanupRecord("record-unknown", {
      native: {
        ...pendingCleanupRecord("record-unknown").native,
        deviceKey: "unknown",
        vaultId: "unknown"
      }
    }));

    const result = await reconcileNativeExecutionsAtStartup(managerHost(manager));

    assert.equal(result.cleanup[0]?.cleanup, "retained");
    assert.equal(result.cleanup[0]?.attempted, false);
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(unknownRoot, { recursive: true, force: true });
  }
}

async function assertStartupCleanupConnectsCodexWithoutManualPreconnect(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-codex-connect-"));
  try {
    let transportReady = false;
    let ensureConnectedCalls = 0;
    let archiveCalls = 0;
    const adapter = new CodexRichAgentAdapter({
      displayName: "Codex",
      version: "test",
      ensureConnected: async () => {
        ensureConnectedCalls += 1;
        transportReady = true;
        return {
          connected: true,
          label: "Codex",
          version: "test",
          errors: []
        };
      },
      getNativeThreadId: () => undefined,
      setNativeThreadId: () => undefined,
      buildInput: () => [],
      startThread: async () => {
        throw new Error("startup cleanup must not start a thread");
      },
      resumeThread: async () => undefined,
      startTurn: async () => {
        throw new Error("startup cleanup must not start a turn");
      },
      archiveThread: async () => {
        assert.equal(transportReady, true);
        archiveCalls += 1;
      },
      nativeRefContext: {
        deviceKey: "device-1",
        vaultId: "/vault"
      }
    });
    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    await store.upsert({
      ...pendingCleanupRecord("codex-startup"),
      native: {
        backendId: "codex-cli",
        id: "thread-startup",
        kind: "thread",
        persistence: "provider-persistent",
        deviceKey: "device-1",
        vaultId: "/vault",
        createdAt: 1
      },
      policy: {
        historyAuthority: "echoink",
        mode: "ephemeral-run",
        preferredDisposition: ["archive", "retain"],
        retainWhenLocalCommitFails: true,
        cleanupRequiredForTaskSuccess: false
      },
      requestedDisposition: "archive"
    });
    const manager = new NativeExecutionManager({
      store,
      adapters: [adapter],
      now: () => 100
    });

    const result = await reconcileNativeExecutionsAtStartup(managerHost(manager));

    assert.equal(result.cleanup[0]?.cleanup, "disposed");
    assert.equal(ensureConnectedCalls, 1);
    assert.equal(archiveCalls, 1);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertHarnessServiceRunsAuthorityGateBeforeCleanup(): Promise<void> {
  const calls: string[] = [];
  const record = trustedFakeRetirementRecord(
    "service-exact",
    2,
    "commit-service-exact"
  );
  const fakeManager = {
    async listPendingLocalCommits(
      filter: { surface?: string; workflow?: string } = {}
    ) {
      calls.push(
        `list-pending:${filter.surface ?? ""}:${filter.workflow ?? ""}`
      );
      return [];
    },
    async markPendingLocalCommitsFailed(
      _reason: string,
      filter: { surface?: string; workflow?: string }
    ) {
      calls.push(
        `recover-pending:${filter.surface ?? ""}:${filter.workflow ?? ""}`
      );
      return 0;
    },
    async listAwaitingLocalCommitRetirements() {
      calls.push("list");
      return [record];
    },
    async promoteRetirement(recordId: string, expected: NativeExecutionRecord) {
      calls.push(`promote:${recordId}`);
      assert.equal(expected, record);
      return record;
    },
    async abortRetirement() {
      throw new Error("exact authority must not abort");
    },
    async quarantineRetirement() {
      throw new Error("exact authority must not quarantine");
    },
    async cleanupDue(limit: number) {
      calls.push(`cleanup:${limit}`);
      return [{
        recordId: record.id,
        cleanup: "disposed" as const,
        attempted: true
      }];
    }
  };
  const service = new EchoInkHarnessService({
    getVaultPath: () => "/vault",
    getPluginDataDirName: () => ".obsidian/plugins/codex-echoink"
  } as never);
  (service as unknown as {
    getNativeExecutionManager(): typeof fakeManager;
  }).getNativeExecutionManager = () => fakeManager;

  const result = await service.reconcileNativeExecutionStartup(async (probe) => {
    calls.push(`prove:${probe.targetCommitId}`);
    return authorityProof(
      "exact",
      "active",
      probe.targetGeneration,
      probe.targetCommitId
    );
  });

  assert.deepEqual(calls, [
    "list-pending:chat:",
    "recover-pending:chat:chat.generic",
    "list-pending:editor:",
    "list-pending::",
    "list-pending:knowledge:",
    "list",
    "prove:commit-service-exact",
    "promote:service-exact",
    `cleanup:${DEFAULT_STARTUP_NATIVE_CLEANUP_LIMIT}`
  ]);
  assert.equal(result.promotedCount, 1);
  assert.equal(result.recoveredPendingChatCount, 0);
  assert.equal(result.recoveredPendingHermesProposalCount, 0);
  assert.equal(result.cleanup[0]?.cleanup, "disposed");
}

async function assertHarnessServiceCleanupGateIsSingleFlight(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-service-gate-"));
  try {
    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    await store.upsert(
      trustedFakeRetirementRecord(
        "service-gate-retirement",
        2,
        "commit-service-gate"
      )
    );
    await store.upsert(pendingCleanupRecord("service-gate-due"));
    await store.upsert(pendingCleanupRecord("service-gate-by-id"));
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const service = serviceWithNativeManager(manager);
    stubRunTerminalSettlement(service);

    await assert.rejects(
      service.cleanupDueNativeExecutions(),
      /Native cleanup is blocked until startup reconciliation succeeds/
    );
    await assert.rejects(
      service.cleanupNativeExecutionRecord("service-gate-by-id"),
      /Native cleanup is blocked until startup reconciliation succeeds/
    );
    assert.equal(providerDispositionCalls, 0);

    let proofCalls = 0;
    let markProofStarted!: () => void;
    const proofStarted = new Promise<void>((resolve) => {
      markProofStarted = resolve;
    });
    let releaseProof!: () => void;
    const proofGate = new Promise<void>((resolve) => {
      releaseProof = resolve;
    });
    const startup = service.reconcileNativeExecutionStartup(async (probe) => {
      proofCalls += 1;
      markProofStarted();
      await proofGate;
      return authorityProof(
        "exact",
        "active",
        probe.targetGeneration,
        probe.targetCommitId
      );
    });
    const concurrent = service.reconcileNativeExecutionStartup(async () => {
      throw new Error("concurrent reconciliation must share the first flight");
    });
    assert.equal(concurrent, startup);
    await proofStarted;

    let dueSettled = false;
    let byIdSettled = false;
    const dueCleanup = service.cleanupDueNativeExecutions().finally(() => {
      dueSettled = true;
    });
    const byIdCleanup = service.cleanupNativeExecutionRecord(
      "service-gate-by-id"
    ).finally(() => {
      byIdSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dueSettled, false);
    assert.equal(byIdSettled, false);
    assert.equal(providerDispositionCalls, 0);

    releaseProof();
    const [startupResult, concurrentResult] = await Promise.all([
      startup,
      concurrent
    ]);
    await Promise.all([dueCleanup, byIdCleanup]);

    assert.equal(startupResult, concurrentResult);
    assert.equal(proofCalls, 1);
    assert.equal(startupResult.promotedCount, 1);
    assert.equal(providerDispositionCalls, 3);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertHarnessServiceCleanupGateStaysClosedUntilSuccessfulRetry(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-service-retry-"));
  try {
    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    await store.upsert(
      trustedFakeRetirementRecord(
        "service-failed-proof",
        2,
        "commit-service-failed-proof"
      )
    );
    await store.upsert(pendingCleanupRecord("service-retry-due"));
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const service = serviceWithNativeManager(manager);
    stubRunTerminalSettlement(service);

    await assert.rejects(
      service.reconcileNativeExecutionStartup(async () => {
        throw new Error("Conversation authority index is corrupt");
      }),
      /Conversation authority proof failed: Conversation authority index is corrupt/
    );
    await assert.rejects(
      service.cleanupDueNativeExecutions(),
      /Native cleanup is blocked until startup reconciliation succeeds: Conversation authority proof failed/
    );
    await assert.rejects(
      service.cleanupNativeExecutionRecord("service-retry-due"),
      /Native cleanup is blocked until startup reconciliation succeeds: Conversation authority proof failed/
    );
    assert.equal(providerDispositionCalls, 0);

    await manager.registerRetirement(
      trustedFakeRetirementRecord(
        "service-retry-exact",
        3,
        "commit-service-retry-exact"
      )
    );
    const retry = await service.reconcileNativeExecutionStartup(async (probe) =>
      authorityProof(
        "exact",
        "active",
        probe.targetGeneration,
        probe.targetCommitId
      )
    );
    assert.equal(retry.promotedCount, 1);
    assert.equal(providerDispositionCalls, 2);

    await store.upsert(pendingCleanupRecord("service-after-unlock"));
    const cleanup = await service.cleanupNativeExecutionRecord(
      "service-after-unlock"
    );
    assert.equal(cleanup.cleanup, "disposed");
    assert.equal(providerDispositionCalls, 3);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertPostGateCleanupByIdCannotBypassMissingLeasedAuthority(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-startup-post-gate-missing-leased-retirement-"
  ));
  try {
    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const service = serviceWithNativeManager(manager);

    const startup = await service.reconcileNativeExecutionStartup(async () => {
      throw new Error("an empty startup pass must not request Conversation authority");
    });
    assert.equal(startup.awaitingCount, 0);
    assert.equal(providerDispositionCalls, 0);

    const missing = missingLeasedRetirementCleanupRecord(
      "post-gate-missing-leased-retirement",
      "pending"
    );
    await store.upsert(missing);

    const result = await service.cleanupNativeExecutionRecord(missing.id);

    assert.deepEqual(result, {
      recordId: missing.id,
      cleanup: "quarantined",
      attempted: false,
      message: (
        "Native leased-conversation cleanup authority is missing durable "
        + `retirement evidence: ${missing.id}`
      )
    });
    assert.equal((await store.get(missing.id))?.cleanup, "quarantined");
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertEditorCrashBeforeLedgerIsRetainedIdempotently(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-editor-before-ledger-"));
  try {
    let providerDispositionCalls = 0;
    const firstManager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const record = pendingEditorRunRecord("editor-before-ledger");
    await firstManager.recordCreated(record);

    const firstRestart = serviceWithNativeManager(
      nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      }),
      { ledger: new InMemoryRunLedger() }
    );
    const firstResult = await firstRestart.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    const retained = await store.get(record.id);
    assert.equal(retained?.runOutcome, "failed");
    assert.equal(retained?.localCommit, "failed");
    assert.equal(retained?.cleanup, "retained-for-recovery");
    assert.match(retained?.lastError ?? "", /before a durable Run Ledger terminal/);
    assert.deepEqual(firstResult.cleanup, []);
    assert.equal(providerDispositionCalls, 0);

    const secondRestart = serviceWithNativeManager(
      nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      }),
      { ledger: new InMemoryRunLedger() }
    );
    const secondResult = await secondRestart.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );

    assert.deepEqual(secondResult.cleanup, []);
    assert.deepEqual(await store.get(record.id), retained);
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertEditorCrashAfterLedgerSettlesAndCleansIdempotently(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-editor-after-ledger-"));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const first = pendingEditorRunRecord("editor-after-ledger-a", {
      runId: "run:editor-after-ledger",
      sessionId: "editor-action:run:editor-after-ledger"
    });
    const replacement = pendingEditorRunRecord("editor-after-ledger-b", {
      runId: first.runId,
      sessionId: first.sessionId,
      native: {
        ...first.native,
        id: "native-editor-after-ledger-b"
      }
    });
    await manager.recordCreated(first);
    await manager.recordCreated(replacement);
    const ledger = new InMemoryRunLedger();
    await ledger.append(editorTerminalEvent(first.runId, "run.completed", {
      backendId: first.native.backendId,
      text: "durable editor candidate"
    }));

    const firstRestart = serviceWithNativeManager(manager, { ledger });
    const firstResult = await firstRestart.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    for (const recordId of [first.id, replacement.id]) {
      const stored = await store.get(recordId);
      assert.equal(stored?.runOutcome, "success");
      assert.equal(stored?.localCommit, "committed");
      assert.equal(stored?.cleanup, "disposed");
    }
    assert.equal(firstResult.cleanup.length, 2);
    assert.equal(providerDispositionCalls, 2);

    const secondRestart = serviceWithNativeManager(
      nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      }),
      { ledger }
    );
    const secondResult = await secondRestart.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );

    assert.deepEqual(secondResult.cleanup, []);
    assert.equal(providerDispositionCalls, 2);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertEditorFailedAndCancelledTerminalsRemainDurableCommits(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-editor-terminal-outcomes-"));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const ledger = new InMemoryRunLedger();
    const fixtures = [
      {
        record: pendingEditorRunRecord("editor-terminal-failed"),
        type: "run.failed" as const,
        outcome: "failed" as const,
        error: "provider failed"
      },
      {
        record: pendingEditorRunRecord("editor-terminal-cancelled"),
        type: "run.cancelled" as const,
        outcome: "cancelled" as const,
        error: "user cancelled"
      }
    ];
    for (const fixture of fixtures) {
      await manager.recordCreated(fixture.record);
      await ledger.append(editorTerminalEvent(fixture.record.runId, fixture.type, {
        backendId: fixture.record.native.backendId,
        error: fixture.error
      }));
    }

    const service = serviceWithNativeManager(manager, { ledger });
    const result = await service.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );
    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    for (const fixture of fixtures) {
      const stored = await store.get(fixture.record.id);
      assert.equal(stored?.runOutcome, fixture.outcome);
      assert.equal(stored?.localCommit, "committed");
      assert.equal(stored?.cleanup, "disposed");
    }
    assert.equal(result.cleanup.length, fixtures.length);
    assert.equal(providerDispositionCalls, fixtures.length);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertEditorTerminalConflictAndLedgerCorruptionBlockCleanup(): Promise<void> {
  for (const fixture of ["terminal-conflict", "sequence-corrupt"] as const) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-editor-${fixture}-`
    ));
    try {
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });
      const record = pendingEditorRunRecord(`editor-${fixture}`);
      await manager.recordCreated(record);
      const ledger = new InMemoryRunLedger();
      if (fixture === "terminal-conflict") {
        await ledger.append(editorTerminalEvent(record.runId, "run.completed", {
          backendId: record.native.backendId,
          sequence: 1,
          text: "candidate"
        }));
        await ledger.append(editorTerminalEvent(record.runId, "run.failed", {
          backendId: record.native.backendId,
          sequence: 2,
          error: "contradictory terminal"
        }));
      } else {
        await ledger.append(editorTerminalEvent(record.runId, "run.completed", {
          backendId: record.native.backendId,
          sequence: 2,
          text: "candidate"
        }));
      }
      const service = serviceWithNativeManager(manager, { ledger });

      await assert.rejects(
        service.reconcileNativeExecutionStartup(unexpectedConversationProof),
        fixture === "terminal-conflict"
          ? /ambiguous terminal authority/
          : /invalid event sequence/
      );

      const stored = await new NativeExecutionStore({
        rootPath,
        now: () => 100
      }).get(record.id);
      assert.equal(stored?.localCommit, "pending");
      assert.equal(stored?.cleanup, "not-needed");
      assert.equal(providerDispositionCalls, 0);
      await assert.rejects(
        service.cleanupDueNativeExecutions(),
        /Native cleanup is blocked until startup reconciliation succeeds/
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertEditorLedgerReadAndSettlementFailuresBlockCleanup(): Promise<void> {
  for (const fixture of ["ledger-unreadable", "settlement-write-failed"] as const) {
    const record = pendingEditorRunRecord(`editor-${fixture}`);
    const ledger = new InMemoryRunLedger();
    if (fixture === "ledger-unreadable") {
      ledger.readRun = async () => {
        throw new Error("Run Ledger storage unavailable");
      };
    } else {
      await ledger.append(editorTerminalEvent(record.runId, "run.completed", {
        backendId: record.native.backendId,
        text: "durable editor candidate"
      }));
    }
    let cleanupCalls = 0;
    const fakeManager = {
      async listPendingLocalCommits(filter: { surface?: string }) {
        return filter.surface === "editor" ? [record] : [];
      },
      async markPendingLocalCommitsFailed() {
        return 0;
      },
      async settleRun() {
        throw new Error("Native settlement Store write failed");
      },
      async listAwaitingLocalCommitRetirements() {
        throw new Error("retirement scan must not run after Editor recovery failure");
      },
      async cleanupDue() {
        cleanupCalls += 1;
        return [];
      }
    };
    const service = serviceWithNativeManager(fakeManager as never, { ledger });

    await assert.rejects(
      service.reconcileNativeExecutionStartup(unexpectedConversationProof),
      fixture === "ledger-unreadable"
        ? /Run Ledger authority read failed.*Run Ledger storage unavailable/
        : /Native settlement Store write failed/
    );
    assert.equal(cleanupCalls, 0);
    await assert.rejects(
      service.cleanupDueNativeExecutions(),
      /Native cleanup is blocked until startup reconciliation succeeds/
    );
  }
}

async function assertEphemeralUtilityRunLedgerRecovery(): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-startup-ephemeral-utility-")
  );
  try {
    const nativeRootPath = path.join(rootPath, "native");
    let providerDispositionCalls = 0;
    const manager = nativeManager(nativeRootPath, () => {
      providerDispositionCalls += 1;
    });
    const ledger = new InMemoryRunLedger();
    const failedTransactionId =
      await createDurableFailedMemoryTransaction(
        rootPath,
        "utility-memory-failed"
      );
    const cancelledTransactionId =
      await createDurableFailedMemoryTransaction(
        rootPath,
        "utility-memory-cancelled"
      );
    const fixtures = [
      {
        record: pendingUtilityRunRecord(
          "utility-prompt-completed",
          "prompt.enhance"
        ),
        type: "run.completed" as const,
        outcome: "success" as const,
        text: "validated prompt"
      },
      {
        record: pendingUtilityRunRecord(
          "utility-memory-failed",
          "memory.curate",
          failedTransactionId
        ),
        type: "run.failed" as const,
        outcome: "failed" as const,
        error: "curator failed"
      },
      {
        record: pendingUtilityRunRecord(
          "utility-memory-cancelled",
          "memory.curate",
          cancelledTransactionId
        ),
        type: "run.cancelled" as const,
        outcome: "cancelled" as const,
        error: "curator cancelled"
      }
    ];
    for (const fixture of fixtures) {
      await manager.recordCreated(fixture.record);
      for (const event of utilityRunLedgerEvents(
        fixture.record,
        fixture.type,
        {
          text: fixture.text,
          error: fixture.error
        }
      )) {
        await ledger.append(event);
      }
    }

    const service = serviceWithNativeManager(manager, {
      ledger,
      vaultPath: rootPath
    });
    const result = await service.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );
    const store = new NativeExecutionStore({
      rootPath: nativeRootPath,
      now: () => 100
    });
    for (const fixture of fixtures) {
      const stored = await store.get(fixture.record.id);
      assert.equal(stored?.runOutcome, fixture.outcome);
      assert.equal(stored?.localCommit, "committed");
      assert.equal(stored?.cleanup, "disposed");
    }
    assert.equal(result.cleanup.length, fixtures.length);
    assert.equal(providerDispositionCalls, fixtures.length);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertEphemeralUtilityRecoveryValidatesAllRunsBeforeMutation(): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-startup-utility-all-authority-")
  );
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const valid = pendingUtilityRunRecord(
      "utility-a-valid",
      "prompt.enhance"
    );
    const corrupt = pendingUtilityRunRecord(
      "utility-z-corrupt",
      "memory.curate",
      "memory-tx-corrupt-ledger"
    );
    await manager.recordCreated(valid);
    await manager.recordCreated(corrupt);
    const ledger = new InMemoryRunLedger();
    for (const event of utilityRunLedgerEvents(
      valid,
      "run.completed",
      { text: "validated prompt" }
    )) {
      await ledger.append(event);
    }
    const corruptEvents = utilityRunLedgerEvents(
      corrupt,
      "run.completed",
      { text: "validated memory" }
    );
    corruptEvents[1] = {
      ...corruptEvents[1],
      data: {
        ...corruptEvents[1].data,
        surface: "chat"
      }
    };
    for (const event of corruptEvents) await ledger.append(event);
    const service = serviceWithNativeManager(manager, { ledger });

    await assert.rejects(
      service.reconcileNativeExecutionStartup(unexpectedConversationProof),
      /start authority does not match Native records/
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    for (const record of [valid, corrupt]) {
      const stored = await store.get(record.id);
      assert.equal(stored?.localCommit, "pending");
      assert.equal(stored?.cleanup, "not-needed");
    }
    assert.equal(providerDispositionCalls, 0);
    await assert.rejects(
      service.cleanupDueNativeExecutions(),
      /Native cleanup is blocked until startup reconciliation succeeds/
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertEphemeralUtilityRecoveryRejectsImpossibleLedgerOrder(): Promise<void> {
  const cases = [
    {
      name: "terminal-before-started",
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceUtilityEvents([
          events[0],
          events[2],
          events[1]
        ]);
      },
      error: /run\.started immediately after run\.created/
    },
    {
      name: "started-not-first-lifecycle-event",
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceUtilityEvents([
          events[0],
          {
            ...events[1],
            type: "agent.connecting",
            source: "agent",
            data: undefined
          },
          events[1],
          events[2]
        ]);
      },
      error: /run\.started immediately after run\.created/
    },
    {
      name: "event-after-terminal",
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceUtilityEvents([
          ...events,
          {
            ...events[2],
            type: "agent.message.completed",
            source: "agent",
            text: "late event"
          }
        ]);
      },
      error: /terminal must follow run\.started and be the final event/
    }
  ] as const;

  for (const testCase of cases) {
    const rootPath = await mkdtemp(
      path.join(tmpdir(), `echoink-startup-utility-${testCase.name}-`)
    );
    try {
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });
      const record = pendingUtilityRunRecord(
        `utility-${testCase.name}`,
        "prompt.enhance"
      );
      await manager.recordCreated(record);
      const ledger = new InMemoryRunLedger();
      const events = testCase.mutate(utilityRunLedgerEvents(
        record,
        "run.completed",
        { text: "validated prompt" }
      ));
      for (const event of events) await ledger.append(event);
      const service = serviceWithNativeManager(manager, { ledger });

      await assert.rejects(
        service.reconcileNativeExecutionStartup(unexpectedConversationProof),
        testCase.error
      );

      const stored = await new NativeExecutionStore({
        rootPath,
        now: () => 100
      }).get(record.id);
      assert.equal(stored?.localCommit, "pending");
      assert.equal(stored?.cleanup, "not-needed");
      assert.equal(providerDispositionCalls, 0);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertBackendProbeStartupTerminalRecovery(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-startup-backend-probe-terminals-"
  ));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const fixtures = [
      {
        record: pendingUtilityRunRecord(
          "backend-probe-completed",
          "backend.probe"
        ),
        terminal: "run.completed" as const,
        outcome: "success" as const,
        payload: { text: "OPENCODE_PONG" }
      },
      {
        record: pendingUtilityRunRecord(
          "backend-probe-failed",
          "backend.probe"
        ),
        terminal: "run.failed" as const,
        outcome: "failed" as const,
        payload: { error: "probe token mismatch" }
      }
    ];
    const ledger = new InMemoryRunLedger();
    for (const fixture of fixtures) {
      await manager.recordCreated(fixture.record);
      for (const event of utilityRunLedgerEvents(
        fixture.record,
        fixture.terminal,
        fixture.payload
      )) {
        await ledger.append(event);
      }
    }
    const service = serviceWithNativeManager(manager, { ledger });

    const result = await service.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    for (const fixture of fixtures) {
      const stored = await store.get(fixture.record.id);
      assert.equal(stored?.surface, "system");
      assert.equal(stored?.workflow, "backend.probe");
      assert.equal(stored?.runOutcome, fixture.outcome);
      assert.equal(stored?.localCommit, "committed");
      assert.equal(stored?.cleanup, "disposed");
    }
    assert.equal(result.cleanup.length, fixtures.length);
    assert.equal(providerDispositionCalls, fixtures.length);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertBackendProbeStartupCorruptLedgerIsAtomic(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-startup-backend-probe-corrupt-ledger-"
  ));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const valid = pendingUtilityRunRecord(
      "backend-probe-a-valid",
      "backend.probe"
    );
    const corrupt = pendingUtilityRunRecord(
      "backend-probe-z-corrupt",
      "backend.probe"
    );
    await manager.recordCreated(valid);
    await manager.recordCreated(corrupt);
    const ledger = new InMemoryRunLedger();
    for (const event of utilityRunLedgerEvents(
      valid,
      "run.completed",
      { text: "OPENCODE_PONG" }
    )) {
      await ledger.append(event);
    }
    const corruptEvents = utilityRunLedgerEvents(
      corrupt,
      "run.failed",
      { error: "probe transport failed" }
    );
    corruptEvents[1] = {
      ...corruptEvents[1],
      data: {
        ...corruptEvents[1].data,
        surface: "chat"
      }
    };
    for (const event of corruptEvents) await ledger.append(event);
    let nativeSettlementCalls = 0;
    const settleRun = manager.settleRun.bind(manager);
    manager.settleRun = async (input) => {
      nativeSettlementCalls += 1;
      return await settleRun(input);
    };
    const service = serviceWithNativeManager(manager, { ledger });

    await assert.rejects(
      service.reconcileNativeExecutionStartup(unexpectedConversationProof),
      /start authority does not match Native records/
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    for (const record of [valid, corrupt]) {
      const stored = await store.get(record.id);
      assert.equal(stored?.runOutcome, undefined);
      assert.equal(stored?.localCommit, "pending");
      assert.equal(stored?.cleanup, "not-needed");
    }
    assert.equal(nativeSettlementCalls, 0);
    assert.equal(providerDispositionCalls, 0);
    await assert.rejects(
      service.cleanupDueNativeExecutions(),
      /Native cleanup is blocked until startup reconciliation succeeds/
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertHermesProposalStartupReceiptAndCommitMatrix(): Promise<void> {
  const cases = [
    {
      name: "receipt-and-commit",
      receipt: true,
      terminal: true,
      localCommit: true,
      expectedRunOutcome: "success" as const,
      expectedLocalCommit: "committed" as const,
      expectedCleanup: "disposed" as const,
      expectedTerminalAppends: 0
    },
    {
      name: "missing-receipt",
      receipt: false,
      terminal: true,
      localCommit: true,
      expectedRunOutcome: "failed" as const,
      expectedLocalCommit: "committed" as const,
      expectedCleanup: "quarantined" as const,
      expectedTerminalAppends: 0
    },
    {
      name: "missing-local-commit",
      receipt: true,
      terminal: true,
      localCommit: false,
      expectedRunOutcome: "success" as const,
      expectedLocalCommit: "failed" as const,
      expectedCleanup: "retained-for-recovery" as const,
      expectedTerminalAppends: 0
    },
    {
      name: "missing-terminal",
      receipt: true,
      terminal: false,
      localCommit: false,
      expectedRunOutcome: "failed" as const,
      expectedLocalCommit: "failed" as const,
      expectedCleanup: "retained-for-recovery" as const,
      expectedTerminalAppends: 1
    }
  ];

  for (const testCase of cases) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-hermes-${testCase.name}-`
    ));
    try {
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });
      const record = pendingHermesProposalHostRecord(
        `hermes-${testCase.name}`,
        { receipt: testCase.receipt }
      );
      await manager.recordCreated(record);
      const ledger = new InMemoryRunLedger();
      for (const event of hermesProposalRunLedgerEvents(record, {
        terminal: testCase.terminal,
        localCommit: testCase.localCommit,
        terminalType: testCase.name === "missing-receipt"
          ? "run.failed"
          : "run.completed"
      })) {
        await ledger.append(event);
      }
      const service = serviceWithNativeManager(manager, { ledger });
      let terminalAppends = 0;
      stubHermesStartupTerminalSettlement(service, ledger, () => {
        terminalAppends += 1;
      });

      const result = await service.reconcileNativeExecutionStartup(
        unexpectedConversationProof
      );

      const stored = await new NativeExecutionStore({
        rootPath,
        now: () => 100
      }).get(record.id);
      assert.equal(result.recoveredPendingHermesProposalCount, 1);
      assert.equal(stored?.runOutcome, testCase.expectedRunOutcome);
      assert.equal(stored?.localCommit, testCase.expectedLocalCommit);
      assert.equal(stored?.cleanup, testCase.expectedCleanup);
      assert.equal(terminalAppends, testCase.expectedTerminalAppends);
      assert.equal(providerDispositionCalls, 0);
      assert.deepEqual(result.cleanup, []);
      assert.deepEqual(await service.cleanupDueNativeExecutions(), []);

      const durableEvents = await ledger.readRun(record.runId);
      const terminals = durableEvents.filter((event) => (
        event.type === "run.completed"
        || event.type === "run.failed"
        || event.type === "run.cancelled"
      ));
      assert.equal(terminals.length, 1);
      if (testCase.name === "missing-terminal") {
        assert.equal(terminals[0]?.type, "run.failed");
        assert.match(
          terminals[0]?.error ?? "",
          /before the Hermes proposal Harness run reached a terminal/
        );
      }
      if (testCase.name === "receipt-and-commit") {
        assert.equal(stored?.requestedDisposition, "process-exit");
        assert.equal(stored?.appliedDisposition, "process-exit");
        assert.equal(
          stored?.disposedAt,
          record.observedDisposition?.observedAt
        );
      } else if (testCase.name === "missing-receipt") {
        assert.match(
          stored?.lastError ?? "",
          /EchoInk host process disposition authority is missing/
        );
      } else {
        assert.match(
          stored?.lastError ?? "",
          /durable Knowledge local-commit receipt settled the Hermes proposal/
        );
      }
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertHermesProposalStartupValidationIsAtomicAndFailClosed(): Promise<void> {
  const cases = [
    {
      name: "corrupt-ledger",
      error: /Hermes proposal Run Ledger authority read failed/,
      corruptRead: true
    },
    {
      name: "duplicate-store-registration",
      error: /conflicting Native registrations/,
      duplicateStoreRegistration: true
    },
    {
      name: "duplicate-ledger-registration",
      error: /ambiguous Native creation authority/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceHermesProposalEvents([
          ...events.slice(0, 3),
          { ...events[2] },
          ...events.slice(3)
        ]);
      }
    },
    {
      name: "identity-conflict",
      error: /Native creation event does not match the host identity/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        events[2] = {
          ...events[2],
          data: {
            ...events[2].data,
            nativeExecutionId: "echoink-host-process:conflicting-identity"
          }
        };
        return events;
      }
    },
    {
      name: "sequence-conflict",
      error: /invalid event sequence or identity/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        events[2] = { ...events[2], sequence: 9 };
        return events;
      }
    },
    {
      name: "terminal-conflict",
      error: /ambiguous terminal authority/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceHermesProposalEvents([
          ...events.slice(0, 4),
          {
            ...events[3],
            type: "run.failed",
            text: undefined,
            error: "conflicting durable terminal"
          },
          ...events.slice(4)
        ]);
      }
    },
    {
      name: "success-terminal-missing-host-data",
      error: /completed terminal is missing exact host disposition authority/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        events[3] = { ...events[3], data: undefined };
        return events;
      }
    },
    {
      name: "success-terminal-disposition-state-conflict",
      error: /terminal host disposition does not match Native receipt/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        events[3] = {
          ...events[3],
          data: {
            ...events[3].data,
            hostProcessDisposition: "not-started"
          }
        };
        return events;
      }
    },
    {
      name: "success-terminal-disposition-time-conflict",
      error: /terminal host disposition does not match Native receipt/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        events[3] = {
          ...events[3],
          data: {
            ...events[3].data,
            hostProcessDispositionObservedAt: 21
          }
        };
        return events;
      }
    },
    {
      name: "success-terminal-not-started-receipt",
      error: /completed terminal requires an exited host process receipt/,
      receiptState: "not-started" as const
    },
    {
      name: "local-commit-completed-without-started",
      error: /local-commit events are out of order/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceHermesProposalEvents(events.filter(
          (event) => event.type !== "run.local_commit.started"
        ));
      }
    },
    {
      name: "local-commit-failed-without-started",
      error: /local-commit events are out of order/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceHermesProposalEvents([
          ...events.slice(0, 4),
          {
            ...events[events.length - 1],
            type: "run.local_commit.failed",
            error: "local commit failed without a start receipt"
          }
        ]);
      }
    },
    {
      name: "local-commit-conflict",
      error: /conflicting local-commit authority/,
      mutate(events: HarnessEvent[]): HarnessEvent[] {
        return resequenceHermesProposalEvents([
          ...events,
          {
            ...events[events.length - 1],
            type: "run.local_commit.failed",
            error: "conflicting local commit"
          }
        ]);
      }
    }
  ] as const;

  for (const testCase of cases) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-hermes-${testCase.name}-`
    ));
    try {
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });
      const valid = pendingHermesProposalHostRecord(
        `hermes-a-valid-${testCase.name}`,
        { receipt: true }
      );
      const invalid = pendingHermesProposalHostRecord(
        `hermes-z-invalid-${testCase.name}`,
        {
          receipt: true,
          ...("receiptState" in testCase
            ? { receiptState: testCase.receiptState }
            : {})
        }
      );
      const records = [valid, invalid];
      await manager.recordCreated(valid);
      await manager.recordCreated(invalid);
      if ("duplicateStoreRegistration" in testCase) {
        const duplicate = pendingHermesProposalHostRecord(
          `hermes-z-duplicate-${testCase.name}`,
          { receipt: true, runId: invalid.runId }
        );
        records.push(duplicate);
        await manager.recordCreated(duplicate);
      }
      const due = pendingCleanupRecord(`hermes-gate-${testCase.name}`);
      await new NativeExecutionStore({
        rootPath,
        now: () => 100
      }).upsert(due);

      const ledger = new InMemoryRunLedger();
      for (const event of hermesProposalRunLedgerEvents(valid, {
        terminal: true,
        localCommit: true
      })) {
        await ledger.append(event);
      }
      let invalidEvents = hermesProposalRunLedgerEvents(invalid, {
        terminal: true,
        localCommit: true
      });
      if ("mutate" in testCase) {
        invalidEvents = testCase.mutate([...invalidEvents]);
      }
      for (const event of invalidEvents) await ledger.append(event);
      if ("corruptRead" in testCase) {
        const readRun = ledger.readRun.bind(ledger);
        ledger.readRun = async (runId: string) => {
          if (runId === invalid.runId) {
            throw new SyntaxError("Unexpected token in durable JSONL");
          }
          return await readRun(runId);
        };
      }

      let nativeSettlementCalls = 0;
      const settleRun = manager.settleRun.bind(manager);
      manager.settleRun = async (input) => {
        nativeSettlementCalls += 1;
        return await settleRun(input);
      };
      const service = serviceWithNativeManager(manager, { ledger });
      let recoveryTerminalAppends = 0;
      stubHermesStartupTerminalSettlement(service, ledger, () => {
        recoveryTerminalAppends += 1;
      });

      await assert.rejects(
        service.reconcileNativeExecutionStartup(unexpectedConversationProof),
        testCase.error
      );

      const store = new NativeExecutionStore({ rootPath, now: () => 100 });
      for (const record of records) {
        const stored = await store.get(record.id);
        assert.equal(stored?.runOutcome, undefined);
        assert.equal(stored?.localCommit, "pending");
        assert.equal(stored?.cleanup, "not-needed");
      }
      assert.equal(nativeSettlementCalls, 0);
      assert.equal(recoveryTerminalAppends, 0);
      assert.equal(providerDispositionCalls, 0);
      assert.equal((await store.get(due.id))?.cleanup, "pending");
      await assert.rejects(
        service.cleanupDueNativeExecutions(),
        /Native cleanup is blocked until startup reconciliation succeeds/
      );
      await assert.rejects(
        service.cleanupNativeExecutionRecord(due.id),
        /Native cleanup is blocked until startup reconciliation succeeds/
      );
      assert.equal(providerDispositionCalls, 0);
      assert.equal((await store.get(due.id))?.cleanup, "pending");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertKnowledgeRecoveryCannotPreemptHermesProposalStartupAuthority(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-startup-hermes-knowledge-race-"
  ));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const hermes = pendingHermesProposalHostRecord(
      "hermes-knowledge-recovery-race",
      { receipt: true }
    );
    const generic = pendingRunRecord(
      "generic-knowledge-recovery-race",
      "knowledge"
    );
    await manager.recordCreated(hermes);
    await manager.recordCreated(generic);
    const ledger = new InMemoryRunLedger();
    for (const event of hermesProposalRunLedgerEvents(hermes, {
      terminal: true,
      localCommit: true
    })) {
      await ledger.append(event);
    }
    const service = serviceWithNativeManager(manager, { ledger });
    let genericRecoveryTerminalAppends = 0;
    stubHermesStartupTerminalSettlement(service, ledger, () => {
      genericRecoveryTerminalAppends += 1;
    });

    // KnowledgeBaseManager.register() starts its generic workflow recovery
    // before layoutReady starts the global Native reconciliation. The generic
    // pass may retain ordinary legacy Knowledge records, but it must leave the
    // Hermes host record pending for its receipt + Ledger authority resolver.
    const genericallyRecovered = await service.failPendingNativeExecutionsForRecovery({
      reason: "knowledge workflow startup recovery",
      surface: "knowledge"
    });

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    assert.equal(genericallyRecovered, 1);
    assert.equal((await store.get(generic.id))?.localCommit, "failed");
    assert.equal((await store.get(generic.id))?.cleanup, "retained-for-recovery");
    assert.equal((await store.get(hermes.id))?.localCommit, "pending");
    assert.equal((await store.get(hermes.id))?.cleanup, "not-needed");
    assert.equal(genericRecoveryTerminalAppends, 1);

    const result = await service.reconcileNativeExecutionStartup(
      unexpectedConversationProof
    );
    const settledHermes = await store.get(hermes.id);
    assert.equal(result.recoveredPendingHermesProposalCount, 1);
    assert.equal(settledHermes?.localCommit, "committed");
    assert.equal(settledHermes?.cleanup, "disposed");
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertChatRecoveryFilterDoesNotSweepPromptEnhancer(): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-startup-chat-workflow-filter-")
  );
  try {
    const manager = nativeManager(rootPath, () => undefined);
    const chat = pendingRunRecord("chat-workflow-filter", "chat");
    const prompt = pendingUtilityRunRecord(
      "prompt-workflow-filter",
      "prompt.enhance"
    );
    await manager.recordCreated(chat);
    await manager.recordCreated(prompt);

    const updated = await manager.markPendingLocalCommitsFailed(
      "chat recovery only",
      { surface: "chat", workflow: "chat.generic" }
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    assert.equal(updated, 1);
    assert.equal((await store.get(chat.id))?.localCommit, "failed");
    assert.equal((await store.get(prompt.id))?.localCommit, "pending");
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertChatRecoveryValidatesAllRunsBeforeSettlement(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-startup-chat-all-runs-validation-"
  ));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const valid = pendingRunRecord("chat-a-valid-before-corrupt-ledger");
    const corrupt = pendingRunRecord("chat-z-corrupt-ledger");
    await manager.recordCreated(valid);
    await manager.recordCreated(corrupt);

    const terminal: PendingRunTerminalRecovery = {
      runId: valid.runId,
      status: "completed",
      backendId: valid.native.backendId,
      text: "durable answer before later corrupt run",
      data: { authority: "conversation" }
    };
    const message: any = {
      id: "answer-before-corrupt-ledger",
      role: "assistant",
      itemType: "assistant",
      status: "completed",
      text: terminal.text,
      runId: valid.runId,
      backendId: terminal.backendId,
      createdAt: 1,
      completedAt: 2,
      runTerminalRecoveryPending: "completed"
    };
    message.echoInkRunTerminalRecovery =
      createEchoInkChatRunTerminalRecovery(terminal, message);
    const ledger = new InMemoryRunLedger();
    await ledger.append({
      eventId: `${valid.runId}:terminal`,
      runId: valid.runId,
      sequence: 1,
      createdAt: 2,
      source: "kernel",
      type: "run.completed",
      backendId: terminal.backendId,
      text: terminal.text,
      data: terminal.data
    });
    const readRun = ledger.readRun.bind(ledger);
    ledger.readRun = async (runId: string) => {
      if (runId === corrupt.runId) {
        throw new SyntaxError("Unexpected token in later Chat Run Ledger");
      }
      return await readRun(runId);
    };
    const service = serviceWithNativeManager(manager, {
      ledger,
      settings: {
        sessions: [{
          id: valid.sessionId,
          title: "All Chat startup runs validation",
          cwd: "/vault",
          messages: [message],
          backendBindings: {
            [valid.native.backendId]: {
              backendId: valid.native.backendId,
              nativeSessionId: valid.native.id,
              nativeExecutionKind: valid.native.kind,
              nativeExecutionRef: valid.native
            }
          },
          createdAt: 1,
          updatedAt: 2
        }]
      }
    });

    await assert.rejects(
      service.reconcileNativeExecutionStartup(unexpectedConversationProof),
      /Chat Run Ledger authority read failed.*Unexpected token in later Chat Run Ledger/
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    for (const record of [valid, corrupt]) {
      const stored = await store.get(record.id);
      assert.equal(stored?.runOutcome, undefined);
      assert.equal(stored?.localCommit, "pending");
      assert.equal(stored?.cleanup, "not-needed");
    }
    assert.equal(providerDispositionCalls, 0);
    await assert.rejects(
      service.cleanupDueNativeExecutions(),
      /Native cleanup is blocked until startup reconciliation succeeds/
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertChatRecoveryRejectsDuplicateAndConflictingTerminals(): Promise<void> {
  for (const terminalCase of ["duplicate", "conflicting"] as const) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-chat-${terminalCase}-terminal-`
    ));
    try {
      let providerDispositionCalls = 0;
      const manager = nativeManager(rootPath, () => {
        providerDispositionCalls += 1;
      });
      const valid = pendingRunRecord(
        `chat-a-valid-before-${terminalCase}-terminal`
      );
      const invalid: NativeExecutionRecord = {
        ...pendingRunRecord(`chat-z-${terminalCase}-terminal`),
        sessionId: `conversation-${terminalCase}-terminal`
      };
      await manager.recordCreated(valid);
      await manager.recordCreated(invalid);
      const validTerminal: PendingRunTerminalRecovery = {
        runId: valid.runId,
        status: "completed",
        backendId: valid.native.backendId,
        text: "valid durable Chat terminal"
      };
      const winningInvalidTerminal: PendingRunTerminalRecovery = {
        runId: invalid.runId,
        status: "completed",
        backendId: invalid.native.backendId,
        text: "last conflicting Chat terminal"
      };
      const ledger = new InMemoryRunLedger();
      await ledger.append(chatTerminalEvent(validTerminal, 1));
      await ledger.append(chatTerminalEvent(
        terminalCase === "duplicate"
          ? winningInvalidTerminal
          : {
            ...winningInvalidTerminal,
            status: "failed",
            text: undefined,
            error: "first conflicting Chat terminal"
          },
        1
      ));
      await ledger.append(chatTerminalEvent(winningInvalidTerminal, 2));
      const service = serviceWithNativeManager(manager, {
        ledger,
        settings: {
          sessions: [
            chatStartupAuthoritySession(
              valid,
              validTerminal,
              `answer-valid-${terminalCase}`
            ),
            chatStartupAuthoritySession(
              invalid,
              winningInvalidTerminal,
              `answer-invalid-${terminalCase}`
            )
          ]
        }
      });

      await assert.rejects(
        service.reconcileNativeExecutionStartup(unexpectedConversationProof),
        /Chat Run Ledger has ambiguous terminal authority/
      );

      const store = new NativeExecutionStore({ rootPath, now: () => 100 });
      for (const record of [valid, invalid]) {
        const stored = await store.get(record.id);
        assert.equal(stored?.runOutcome, undefined);
        assert.equal(stored?.localCommit, "pending");
        assert.equal(stored?.cleanup, "not-needed");
      }
      assert.equal(providerDispositionCalls, 0);
      await assert.rejects(
        service.cleanupDueNativeExecutions(),
        /Native cleanup is blocked until startup reconciliation succeeds/
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertChatRegistrationWithoutSurfaceCommitIsRetainedOnRestart(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-chat-pending-"));
  try {
    let providerDispositionCalls = 0;
    const firstManager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const firstService = serviceWithNativeManager(firstManager);
    await firstService.recordNativeExecution(pendingRunRecord("chat-save-crash"));
    await firstService.recordNativeExecution(
      pendingRunRecord("knowledge-save-crash", "knowledge")
    );

    // Simulate the process disappearing after Native registration but before
    // the Chat surface can durably save Conversation + Run Ledger and settle
    // the registration receipt.
    const restartedManager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const restartedService = serviceWithNativeManager(restartedManager);
    let runTerminalRecoveryCalls = 0;
    stubRunTerminalSettlement(restartedService, () => {
      runTerminalRecoveryCalls += 1;
    });

    const result = await restartedService.reconcileNativeExecutionStartup(
      async (probe) => authorityProof(
        "exact",
        "active",
        probe.targetGeneration,
        probe.targetCommitId
      )
    );

    const restartedStore = new NativeExecutionStore({ rootPath, now: () => 100 });
    const chat = await restartedStore.get("chat-save-crash");
    const knowledge = await restartedStore.get("knowledge-save-crash");
    assert.equal(result.recoveredPendingChatCount, 1);
    assert.equal(
      runTerminalRecoveryCalls,
      0,
      "startup must not fabricate a Run terminal without durable Conversation evidence"
    );
    assert.equal(chat?.localCommit, "failed");
    assert.equal(chat?.cleanup, "retained-for-recovery");
    assert.equal(chat?.runOutcome, "failed");
    assert.match(chat?.lastError ?? "", /Chat surface durable commit was proven/);
    assert.equal(knowledge?.localCommit, "pending");
    assert.equal(knowledge?.cleanup, "not-needed");
    assert.deepEqual(result.cleanup, []);
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertDurableChatTerminalWithoutConversationMarkerRemainsRetained(): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-startup-chat-terminal-without-marker-"
  ));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    const record = pendingRunRecord("chat-terminal-without-marker");
    await manager.recordCreated(record);
    const ledger = new InMemoryRunLedger();
    await ledger.append({
      eventId: "chat-terminal-without-marker:terminal",
      runId: record.runId,
      sequence: 1,
      createdAt: 1,
      source: "kernel",
      type: "run.completed",
      backendId: record.native.backendId,
      text: "durable answer"
    });
    const service = serviceWithNativeManager(manager, {
      ledger,
      settings: {
        sessions: [{
          id: record.sessionId,
          title: "Conversation without marker",
          cwd: "/vault",
          messages: [],
          backendBindings: {
            [record.native.backendId]: {
              backendId: record.native.backendId,
              nativeSessionId: record.native.id,
              nativeExecutionKind: record.native.kind,
              nativeExecutionRef: record.native
            }
          },
          createdAt: 1,
          updatedAt: 1
        }]
      }
    });

    const result = await service.reconcileNativeExecutionStartup(
      async (probe) => authorityProof(
        "exact",
        "active",
        probe.targetGeneration,
        probe.targetCommitId
      )
    );

    const stored = await new NativeExecutionStore({
      rootPath,
      now: () => 100
    }).get(record.id);
    assert.equal(result.recoveredPendingChatCount, 1);
    assert.equal(stored?.localCommit, "failed");
    assert.equal(stored?.cleanup, "retained-for-recovery");
    assert.equal(
      providerDispositionCalls,
      0,
      "Ledger and binding alone must not prove a durable Conversation commit"
    );
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertStartupRequiresFullChatTerminalIdentity(): Promise<void> {
  for (const mismatch of [
    "none",
    "text",
    "backend",
    "data",
    "legacy-marker"
  ] as const) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-chat-full-terminal-${mismatch}-`
    ));
    try {
      const record = pendingRunRecord(`chat-full-terminal-${mismatch}`);
      const manager = nativeManager(rootPath, () => undefined);
      await manager.recordCreated(record);
      const terminal: PendingRunTerminalRecovery = {
        runId: record.runId,
        status: "completed",
        backendId: record.native.backendId,
        text: "durable winner",
        data: {
          authority: "conversation-a",
          nested: { value: 1 }
        }
      };
      const message: any = {
        id: `answer-${mismatch}`,
        role: "assistant",
        itemType: "assistant",
        status: "completed",
        text: terminal.text,
        runId: record.runId,
        backendId: terminal.backendId,
        createdAt: 1,
        completedAt: 2,
        runTerminalRecoveryPending: "completed"
      };
      if (mismatch !== "legacy-marker") {
        message.echoInkRunTerminalRecovery =
          createEchoInkChatRunTerminalRecovery(terminal, message);
      }
      const session = {
        id: record.sessionId,
        title: `Full terminal ${mismatch}`,
        cwd: "/vault",
        messages: [message],
        backendBindings: {
          [record.native.backendId]: {
            backendId: record.native.backendId,
            nativeSessionId: record.native.id,
            nativeExecutionKind: record.native.kind,
            nativeExecutionRef: record.native
          }
        },
        createdAt: 1,
        updatedAt: 2
      };
      const ledger = new InMemoryRunLedger();
      const ledgerTerminal = {
        ...terminal,
        ...(mismatch === "text" ? { text: "ledger loser" } : {}),
        ...(mismatch === "backend" ? { backendId: "other-backend" } : {}),
        ...(mismatch === "data"
          ? { data: { authority: "ledger-b", nested: { value: 2 } } }
          : {})
      };
      await ledger.append({
        eventId: `${record.runId}:terminal`,
        runId: record.runId,
        sequence: 1,
        createdAt: 2,
        source: "kernel",
        type: "run.completed",
        backendId: ledgerTerminal.backendId,
        text: ledgerTerminal.text,
        data: ledgerTerminal.data
      });
      const service = serviceWithNativeManager(manager, {
        ledger,
        settings: { sessions: [session] }
      });

      await service.reconcileNativeExecutionStartup(
        async (probe) => authorityProof(
          "exact",
          "active",
          probe.targetGeneration,
          probe.targetCommitId
        )
      );

      const stored = await new NativeExecutionStore({
        rootPath,
        now: () => 100
      }).get(record.id);
      if (mismatch === "none") {
        assert.equal(stored?.localCommit, "committed");
        assert.equal(stored?.runOutcome, "success");
      } else {
        assert.equal(stored?.localCommit, "failed");
        assert.equal(stored?.cleanup, "retained-for-recovery");
        assert.match(
          stored?.lastError ?? "",
          /Chat surface durable commit was proven/
        );
      }
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertStartupVerifiesImmutableRawTerminalIdentity(): Promise<void> {
  for (const tampered of [false, true]) {
    const rootPath = await mkdtemp(path.join(
      tmpdir(),
      `echoink-startup-chat-raw-${tampered ? "tampered" : "exact"}-`
    ));
    try {
      const record = pendingRunRecord(
        `chat-raw-${tampered ? "tampered" : "exact"}`
      );
      const manager = nativeManager(rootPath, () => undefined);
      await manager.recordCreated(record);
      const text = `durable-raw:${"R".repeat(90_000)}`;
      const terminal: PendingRunTerminalRecovery = {
        runId: record.runId,
        status: "completed",
        backendId: record.native.backendId,
        text,
        data: { authority: "raw-winner" }
      };
      const message: any = {
        id: `answer-${record.id}`,
        role: "assistant",
        itemType: "assistant",
        status: "completed",
        text,
        runId: record.runId,
        backendId: record.native.backendId,
        createdAt: 1,
        completedAt: 2
      };
      message.rawRef = echoInkChatTerminalRawRef(terminal, message.id);
      const rawWrite = prepareRawMessage(message, text);
      assert.ok(rawWrite);
      message.runTerminalRecoveryPending = "completed";
      message.echoInkRunTerminalRecovery =
        createEchoInkChatRunTerminalRecovery(terminal, message);
      const rawTexts = new Map<string, string>([[
        rawWrite.rawRef,
        tampered ? `tampered:${"T".repeat(90_000)}` : text
      ]]);
      const ledger = new InMemoryRunLedger();
      await ledger.append({
        eventId: `${record.runId}:terminal`,
        runId: record.runId,
        sequence: 1,
        createdAt: 2,
        source: "kernel",
        type: "run.completed",
        backendId: terminal.backendId,
        text,
        data: terminal.data
      });
      const service = serviceWithNativeManager(manager, {
        ledger,
        rawTexts,
        settings: {
          sessions: [{
            id: record.sessionId,
            title: "Raw terminal identity",
            cwd: "/vault",
            messages: [message],
            backendBindings: {
              [record.native.backendId]: {
                backendId: record.native.backendId,
                nativeSessionId: record.native.id,
                nativeExecutionKind: record.native.kind,
                nativeExecutionRef: record.native
              }
            },
            createdAt: 1,
            updatedAt: 2
          }]
        }
      });

      await service.reconcileNativeExecutionStartup(
        async (probe) => authorityProof(
          "exact",
          "active",
          probe.targetGeneration,
          probe.targetCommitId
        )
      );

      const stored = await new NativeExecutionStore({
        rootPath,
        now: () => 100
      }).get(record.id);
      assert.equal(
        stored?.localCommit,
        tampered ? "failed" : "committed"
      );
      if (tampered) {
        assert.equal(stored?.cleanup, "retained-for-recovery");
      }
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }
}

async function assertConcurrentCommittedChatSettlementWinsStartupRecovery(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-chat-race-"));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    await manager.recordCreated(pendingRunRecord("chat-concurrent-commit"));

    const originalListPending = manager.listPendingLocalCommits.bind(manager);
    let pendingScans = 0;
    let releaseSecondScan!: () => void;
    let secondScanCaptured!: () => void;
    const secondScanReady = new Promise<void>((resolve) => {
      secondScanCaptured = resolve;
    });
    const secondScanGate = new Promise<void>((resolve) => {
      releaseSecondScan = resolve;
    });
    manager.listPendingLocalCommits = async (filter = {}) => {
      const records = await originalListPending(filter);
      pendingScans += 1;
      if (pendingScans === 2) {
        secondScanCaptured();
        await secondScanGate;
      }
      return records;
    };

    const service = serviceWithNativeManager(manager);
    stubRunTerminalSettlement(service);
    const startup = service.reconcileNativeExecutionStartup(
      async (probe) => authorityProof(
        "exact",
        "active",
        probe.targetGeneration,
        probe.targetCommitId
      )
    );
    await secondScanReady;
    await manager.settleRun({
      recordId: "chat-concurrent-commit",
      runOutcome: "success",
      localCommit: {
        committed: true,
        conversationCommitted: true,
        runLedgerCommitted: true,
        artifactsCommitted: true,
        historyIndexCommitted: true
      }
    });
    releaseSecondScan();
    const result = await startup;

    const stored = await new NativeExecutionStore({
      rootPath,
      now: () => 100
    }).get("chat-concurrent-commit");
    assert.equal(result.recoveredPendingChatCount, 0);
    assert.equal(stored?.localCommit, "committed");
    assert.equal(stored?.cleanup, "not-needed");
    assert.equal(stored?.runOutcome, "success");
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertPendingChatRecoveryLeavesRetirementsForAuthorityGate(): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-startup-chat-retirement-"));
  try {
    let providerDispositionCalls = 0;
    const manager = nativeManager(rootPath, () => {
      providerDispositionCalls += 1;
    });
    await manager.recordCreated(pendingRunRecord("chat-uncommitted-run"));
    await manager.registerRetirement(
      trustedFakeRetirementRecord(
        "chat-awaiting-retirement",
        2,
        "commit-chat-retirement"
      )
    );
    const service = serviceWithNativeManager(manager);
    stubRunTerminalSettlement(service);

    const result = await service.reconcileNativeExecutionStartup(
      async () => authorityProof("before", "absent", 1, "commit-current")
    );

    const store = new NativeExecutionStore({ rootPath, now: () => 100 });
    const run = await store.get("chat-uncommitted-run");
    const retirement = await store.get("chat-awaiting-retirement");
    assert.equal(result.recoveredPendingChatCount, 1);
    assert.equal(result.abortedCount, 1);
    assert.equal(run?.cleanup, "retained-for-recovery");
    assert.equal(retirement?.localCommit, "failed");
    assert.equal(retirement?.cleanup, "aborted");
    assert.deepEqual(result.cleanup, []);
    assert.equal(providerDispositionCalls, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertProductionStartupWiringUsesConversationAuthority(): Promise<void> {
  const [bootstrapSource, mainSource, harnessSource, settingsSource] = await Promise.all([
    readFile("src/plugin/bootstrap.ts", "utf8"),
    readFile("src/main.ts", "utf8"),
    readFile("src/plugin/harness-service.ts", "utf8"),
    readFile("src/plugin/settings-store.ts", "utf8")
  ]);
  assert.match(
    bootstrapSource,
    /onLayoutReady\(\(\) => \{[\s\S]*reconcileNativeExecutionsAtStartup\(\)/
  );
  assert.match(
    mainSource,
    /reconcileNativeExecutionsAtStartup[\s\S]*reconcileNativeExecutionStartup[\s\S]*proveConversationSessionContextAuthority/
  );
  assert.match(
    harnessSource,
    /reconcileNativeExecutionStartup[\s\S]*reconcileNativeExecutionsAtStartup[\s\S]*cleanupDue/
  );
  assert.match(
    harnessSource,
    /cleanupDueNativeExecutions[\s\S]*requireNativeCleanupAuthority\(\)[\s\S]*getNativeExecutionManager\(\)\.cleanupDue/
  );
  assert.match(
    harnessSource,
    /cleanupNativeExecutionRecord[\s\S]*requireNativeCleanupAuthority\(\)[\s\S]*getNativeExecutionManager\(\)\.cleanupById/
  );
  assert.deepEqual(
    Array.from(
      harnessSource.matchAll(/manager\.(cleanupDue|cleanupById|cleanupCommitted)\(/g),
      (match) => match[0]
    ),
    ["manager.cleanupDue("],
    "startup reconciliation must be the only ungated direct manager cleanup path"
  );
  assert.match(
    harnessSource,
    /createNativeCleanupAdapter[\s\S]*ensureConnected[\s\S]*ensureHarnessBackendConnected/
  );
  assert.match(
    settingsSource,
    /proveConversationSessionContextAuthority[\s\S]*proveSessionContextAuthority/
  );
}

function reconciliationHost(input: {
  records: NativeExecutionRecord[];
  calls?: string[];
  prove?: (probe: ConversationAuthorityProbe) => Promise<ConversationAuthorityProof>;
  promote?: (record: NativeExecutionRecord) => Promise<void>;
  abort?: (record: NativeExecutionRecord, reason: string) => Promise<void>;
  quarantine?: (record: NativeExecutionRecord, reason: string) => Promise<void>;
  cleanup?: (limit: number) => Promise<NativeCleanupResult[]>;
}): NativeStartupReconciliationHost {
  const calls = input.calls ?? [];
  return {
    async listAwaitingRetirements() {
      calls.push("list");
      return input.records;
    },
    async proveConversationAuthority(probe) {
      calls.push(`prove:${probe.targetCommitId}`);
      return input.prove
        ? await input.prove(probe)
        : authorityProof("exact", "active", probe.targetGeneration, probe.targetCommitId);
    },
    async promoteRetirement(record) {
      calls.push(`promote:${record.id}`);
      await input.promote?.(record);
    },
    async abortRetirement(record, reason) {
      calls.push(`abort:${record.id}`);
      await input.abort?.(record, reason);
    },
    async quarantineRetirement(record, reason) {
      calls.push(`quarantine:${record.id}`);
      await input.quarantine?.(record, reason);
    },
    async cleanupDue(limit) {
      calls.push(`cleanup:${limit}`);
      return input.cleanup
        ? await input.cleanup(limit)
        : [{ recordId: "due", cleanup: "disposed", attempted: true }];
    }
  };
}

function managerHost(
  manager: NativeExecutionManager,
  prove: (
    probe: ConversationAuthorityProbe
  ) => Promise<ConversationAuthorityProof> = async (probe) => authorityProof(
    "exact",
    "active",
    probe.targetGeneration,
    probe.targetCommitId
  )
): NativeStartupReconciliationHost {
  return {
    async listAwaitingRetirements() {
      return await manager.listAwaitingLocalCommitRetirements();
    },
    async proveConversationAuthority(probe) {
      return await prove(probe);
    },
    async promoteRetirement(record) {
      const promoted = await manager.promoteRetirement(record.id, record);
      if (!promoted) throw new Error(`missing retirement ${record.id}`);
    },
    async abortRetirement(record, reason) {
      const aborted = await manager.abortRetirement(record.id, reason, record);
      if (!aborted) throw new Error(`missing retirement ${record.id}`);
    },
    async quarantineRetirement(record, reason) {
      const quarantined = await manager.quarantineRetirement(
        record.id,
        reason,
        record
      );
      if (!quarantined) throw new Error(`missing retirement ${record.id}`);
    },
    async cleanupDue(limit) {
      return await manager.cleanupDue(limit);
    }
  };
}

function serviceWithNativeManager(
  manager: NativeExecutionManager,
  options: {
    ledger?: InMemoryRunLedger;
    settings?: { sessions: unknown[] };
    rawTexts?: Map<string, string>;
    vaultPath?: string;
  } = {}
): EchoInkHarnessService {
  const service = new EchoInkHarnessService({
    settings: options.settings ?? { sessions: [] },
    getVaultPath: () => options.vaultPath ?? "/vault",
    getPluginDataDirName: () => ".obsidian/plugins/codex-echoink",
    readRawMessageText: async (rawRef: string) => {
      const text = options.rawTexts?.get(rawRef);
      if (text === undefined) {
        throw new Error(`Raw terminal text not found: ${rawRef}`);
      }
      return text;
    }
  } as never);
  (service as unknown as {
    getNativeExecutionManager(): NativeExecutionManager;
  }).getNativeExecutionManager = () => manager;
  if (options.ledger) {
    (service as unknown as {
      createRunLedger(): InMemoryRunLedger;
    }).createRunLedger = () => options.ledger!;
  }
  return service;
}

function stubRunTerminalSettlement(
  service: EchoInkHarnessService,
  onCall: () => void = () => undefined
): void {
  (service as unknown as {
    settleRunTerminal(input: unknown): Promise<unknown>;
  }).settleRunTerminal = async () => {
    onCall();
    return undefined;
  };
}

function stubHermesStartupTerminalSettlement(
  service: EchoInkHarnessService,
  ledger: InMemoryRunLedger,
  onCall: () => void = () => undefined
): void {
  (service as unknown as {
    settleRunTerminal(input: {
      runId: string;
      status: "completed" | "failed" | "cancelled";
      backendId?: string;
      text?: string;
      error?: string;
    }): Promise<HarnessEvent>;
  }).settleRunTerminal = async (input) => {
    onCall();
    const durable = await ledger.readRun(input.runId);
    const sequence = durable.length + 1;
    const terminal: HarnessEvent = {
      eventId: `${input.runId}:${sequence}`,
      runId: input.runId,
      sequence,
      createdAt: sequence,
      source: "kernel",
      type: `run.${input.status}` as HarnessEvent["type"],
      backendId: input.backendId,
      text: input.text,
      error: input.error
    };
    await ledger.append(terminal);
    return terminal;
  };
}

function nativeManager(
  rootPath: string,
  onProviderDisposition: () => void
): NativeExecutionManager {
  return new NativeExecutionManager({
    store: new NativeExecutionStore({ rootPath, now: () => 100 }),
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "done",
      onDisposeNativeExecution: async (request) => {
        onProviderDisposition();
        return { outcome: "disposed", applied: request.requested };
      }
    })],
    now: () => 100
  });
}

function retirementRecord(
  id: string,
  targetGeneration: number,
  targetCommitId: string
): NativeExecutionRecord {
  return {
    id,
    runId: `retirement:${id}`,
    sessionId: "conversation-1",
    surface: "chat",
    workflow: "session.context-rotation.start-new-context",
    native: {
      backendId: "codex-cli",
      id: `thread-${id}`,
      kind: "thread",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "/vault",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "leased-conversation",
      preferredDisposition: ["archive", "retain"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    localCommit: "pending",
    cleanup: "awaiting-local-commit",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt: 1,
    settledAt: 0,
    committedAt: 0,
    disposedAt: 0,
    retirement: {
      targetConversationId: "conversation-1",
      targetGeneration,
      targetCommitId,
      targetContextId: `context-${targetGeneration}`,
      targetWorkspaceFingerprint: "sha256:0123456789abcdef",
      reason: "start-new-context"
    }
  };
}

function trustedFakeRetirementRecord(
  id: string,
  targetGeneration: number,
  targetCommitId: string
): NativeExecutionRecord {
  const record = retirementRecord(id, targetGeneration, targetCommitId);
  return {
    ...record,
    native: {
      ...record.native,
      backendId: "fake",
      id: `native-${id}`
    },
    policy: {
      ...record.policy,
      preferredDisposition: ["delete", "retain"]
    }
  };
}

function pendingRunRecord(
  id: string,
  surface: NativeExecutionRecord["surface"] = "chat"
): NativeExecutionRecord {
  return {
    id,
    runId: `run:${id}`,
    sessionId: "conversation-1",
    surface,
    workflow: surface === "chat" ? "chat.generic" : "knowledge.ask",
    native: {
      backendId: "fake",
      id: `native-${id}`,
      kind: "session",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "/vault",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "leased-conversation",
      preferredDisposition: ["retain"],
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
    disposedAt: 0
  };
}

function pendingEditorRunRecord(
  id: string,
  overrides: Partial<NativeExecutionRecord> = {}
): NativeExecutionRecord {
  const record: NativeExecutionRecord = {
    id,
    runId: `run:${id}`,
    sessionId: `editor-action:run:${id}`,
    surface: "editor",
    workflow: "editor.rewrite",
    native: {
      backendId: "fake",
      id: `native-${id}`,
      kind: "session",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "/vault",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["delete", "retain"],
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
    disposedAt: 0
  };
  return { ...record, ...overrides };
}

function pendingHermesProposalHostRecord(
  id: string,
  options: {
    receipt?: boolean;
    receiptState?: "not-started" | "exited";
    runId?: string;
  } = {}
): NativeExecutionRecord {
  const createdAt = 10;
  const executionId = `echoink-host-process:${id}`;
  const runId = options.runId ?? `run:${id}`;
  return {
    id,
    runId,
    sessionId: "knowledge-maintenance",
    surface: "knowledge",
    workflow: "knowledge.maintain",
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
        attemptId: `attempt:${id}`,
        backendNativeIdentity: "unavailable-before-prompt",
        createdAt
      },
      deviceKey: "device-1",
      vaultId: "/vault",
      createdAt
    },
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["process-exit", "retain"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    ...(options.receipt
      ? {
        observedDisposition: {
          version: 1 as const,
          owner: "echoink-host" as const,
          executionId,
          disposition: "process-exit" as const,
          state: options.receiptState ?? "exited",
          observedAt: 20
        }
      }
      : {}),
    localCommit: "pending",
    cleanup: "not-needed",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt,
    settledAt: 0,
    committedAt: 0,
    disposedAt: 0
  };
}

function hermesProposalRunLedgerEvents(
  record: NativeExecutionRecord,
  options: {
    terminal: boolean;
    localCommit: boolean;
    terminalType?: "run.completed" | "run.failed" | "run.cancelled";
  }
): HarnessEvent[] {
  const events: HarnessEvent[] = [
    {
      eventId: `${record.runId}:1`,
      runId: record.runId,
      sequence: 1,
      createdAt: 1,
      source: "kernel",
      type: "run.created"
    },
    {
      eventId: `${record.runId}:2`,
      runId: record.runId,
      sequence: 2,
      createdAt: 2,
      source: "kernel",
      type: "run.started",
      backendId: "hermes",
      text: "maintain",
      data: {
        sessionId: record.sessionId,
        surface: record.surface,
        workflow: record.workflow,
        attachments: []
      }
    },
    {
      eventId: `${record.runId}:3`,
      runId: record.runId,
      sequence: 3,
      createdAt: 3,
      source: "agent",
      type: "agent.native_execution.created",
      backendId: "hermes",
      data: {
        nativeExecutionId: record.native.id,
        nativeExecutionKind: "process",
        nativeExecutionPersistence: "process-local",
        identityAuthority: "echoink-host",
        identityOwner: "echoink-host",
        targetBackendId: "hermes",
        transport: "hermes-proposal-v1",
        attemptId: record.native.hostExecution?.attemptId,
        backendNativeIdentity: "unavailable-before-prompt"
      }
    }
  ];
  if (!options.terminal) return events;
  const terminalType = options.terminalType ?? "run.completed";
  events.push({
    eventId: `${record.runId}:4`,
    runId: record.runId,
    sequence: 4,
    createdAt: 4,
    source: "kernel",
    type: terminalType,
    backendId: "hermes",
    ...(terminalType === "run.completed"
      ? {
        text: "proposal committed",
        data: {
          hostExecutionId: record.native.id,
          identityAuthority: "echoink-host",
          backendNativeIdentity: "unavailable-before-prompt",
          hostProcessDisposition: record.observedDisposition?.state,
          hostProcessDispositionObservedAt:
            record.observedDisposition?.observedAt
        }
      }
      : { error: "Hermes proposal failed before completion" })
  });
  if (options.localCommit) {
    events.push(
      {
        eventId: `${record.runId}:5`,
        runId: record.runId,
        sequence: 5,
        createdAt: 5,
        source: "workflow",
        type: "run.local_commit.started"
      },
      {
        eventId: `${record.runId}:6`,
        runId: record.runId,
        sequence: 6,
        createdAt: 6,
        source: "workflow",
        type: "run.local_commit.completed"
      }
    );
  }
  return events;
}

function resequenceHermesProposalEvents(
  events: HarnessEvent[]
): HarnessEvent[] {
  return events.map((event, index) => ({
    ...event,
    eventId: `${event.runId}:${index + 1}`,
    sequence: index + 1,
    createdAt: index + 1
  }));
}

function chatTerminalEvent(
  terminal: PendingRunTerminalRecovery,
  sequence: number
): HarnessEvent {
  return {
    eventId: `${terminal.runId}:terminal:${sequence}`,
    runId: terminal.runId,
    sequence,
    createdAt: sequence,
    source: "kernel",
    type: terminal.status === "completed"
      ? "run.completed"
      : terminal.status === "cancelled"
      ? "run.cancelled"
      : "run.failed",
    backendId: terminal.backendId,
    text: terminal.text,
    error: terminal.error,
    data: terminal.data
  };
}

function chatStartupAuthoritySession(
  record: NativeExecutionRecord,
  terminal: PendingRunTerminalRecovery,
  messageId: string
): Record<string, unknown> {
  const message: any = {
    id: messageId,
    role: "assistant",
    itemType: "assistant",
    status: terminal.status,
    text: terminal.text ?? "",
    error: terminal.error,
    runId: terminal.runId,
    backendId: terminal.backendId,
    createdAt: 1,
    completedAt: 2,
    runTerminalRecoveryPending: terminal.status
  };
  message.echoInkRunTerminalRecovery =
    createEchoInkChatRunTerminalRecovery(terminal, message);
  return {
    id: record.sessionId,
    title: `Startup authority ${record.id}`,
    cwd: "/vault",
    messages: [message],
    backendBindings: {
      [record.native.backendId]: {
        backendId: record.native.backendId,
        nativeSessionId: record.native.id,
        nativeExecutionKind: record.native.kind,
        nativeExecutionRef: record.native
      }
    },
    createdAt: 1,
    updatedAt: 2
  };
}

function pendingUtilityRunRecord(
  id: string,
  workflow: "backend.probe" | "prompt.enhance" | "memory.curate",
  transactionId?: string
): NativeExecutionRecord {
  const surface = workflow === "backend.probe"
    ? "system"
    : workflow === "prompt.enhance"
      ? "chat"
      : "review";
  return {
    id,
    runId: `run:${id}`,
    sessionId: `${workflow}:run:${id}`,
    surface,
    workflow,
    ...(transactionId
      ? {
        localCommitAuthority: {
          kind: "memory-transaction" as const,
          transactionId
        }
      }
      : {}),
    native: {
      backendId: "fake",
      id: `native-${id}`,
      kind: "session",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "/vault",
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
    disposedAt: 0
  };
}

async function createDurableFailedMemoryTransaction(
  vaultPath: string,
  id: string
): Promise<string> {
  await appendPendingMemoryEvent(vaultPath, {
    eventId: `memory-event:${id}`,
    runId: `memory-source-run:${id}`,
    sessionId: `memory-source-session:${id}`,
    workflow: "chat.generic",
    backendId: "fake",
    eventType: "final-result",
    createdAt: 1,
    payload: { text: `durable failed Memory transaction ${id}` }
  });
  const source = await prepareMemoryTransaction(vaultPath, [
    `memory-event:${id}`
  ]);
  assert.ok(source);
  const failed = await applyMemoryCuratorResult(
    vaultPath,
    source.transactionId,
    {
      schemaVersion: 1,
      outcome: "no-op",
      summary: "injected invalid Curator schema",
      candidates: []
    }
  );
  assert.equal(failed.outcome, "failed");
  return source.transactionId;
}

function utilityRunLedgerEvents(
  record: NativeExecutionRecord,
  terminalType: "run.completed" | "run.failed" | "run.cancelled",
  terminalPayload: { text?: string; error?: string }
): HarnessEvent[] {
  return [
    {
      eventId: `${record.runId}:1`,
      runId: record.runId,
      sequence: 1,
      createdAt: 1,
      source: "kernel",
      type: "run.created"
    },
    {
      eventId: `${record.runId}:2`,
      runId: record.runId,
      sequence: 2,
      createdAt: 2,
      source: "kernel",
      type: "run.started",
      text: "utility input",
      data: {
        sessionId: record.sessionId,
        surface: record.surface,
        workflow: record.workflow,
        attachments: []
      }
    },
    {
      eventId: `${record.runId}:3`,
      runId: record.runId,
      sequence: 3,
      createdAt: 3,
      source: "kernel",
      type: terminalType,
      backendId: record.native.backendId,
      ...terminalPayload
    }
  ];
}

function resequenceUtilityEvents(events: HarnessEvent[]): HarnessEvent[] {
  return events.map((event, index) => ({
    ...event,
    eventId: `${event.runId}:${index + 1}`,
    sequence: index + 1,
    createdAt: index + 1
  }));
}

function editorTerminalEvent(
  runId: string,
  type: "run.completed" | "run.failed" | "run.cancelled",
  overrides: Partial<HarnessEvent> = {}
): HarnessEvent {
  const sequence = overrides.sequence ?? 1;
  return {
    eventId: `${runId}:${sequence}`,
    runId,
    sequence,
    createdAt: sequence,
    source: "kernel",
    type,
    ...overrides
  };
}

async function unexpectedConversationProof(): Promise<ConversationAuthorityProof> {
  throw new Error("Editor-only startup fixture must not request Conversation authority");
}

function pendingCleanupRecord(
  id: string,
  overrides: Partial<NativeExecutionRecord> = {}
): NativeExecutionRecord {
  const record: NativeExecutionRecord = {
    id,
    runId: `run:${id}`,
    sessionId: "conversation-1",
    surface: "knowledge",
    workflow: "knowledge.maintain",
    native: {
      backendId: "fake",
      id: `native-${id}`,
      kind: "session",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "/vault",
      createdAt: 1
    },
    policy: {
      historyAuthority: "echoink",
      mode: "ephemeral-run",
      preferredDisposition: ["delete", "retain"],
      retainWhenLocalCommitFails: true,
      cleanupRequiredForTaskSuccess: false
    },
    runOutcome: "success",
    localCommit: "committed",
    cleanup: "pending",
    requestedDisposition: "delete",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    createdAt: 1,
    settledAt: 1,
    committedAt: 1,
    disposedAt: 0
  };
  return { ...record, ...overrides };
}

function missingLeasedRetirementCleanupRecord(
  id: string,
  cleanup: "pending" | "failed" | "disposing",
  attempts = cleanup === "pending" ? 0 : 1
): NativeExecutionRecord {
  return {
    ...pendingCleanupRecord(id),
    surface: "chat",
    workflow: "chat.generic",
    policy: {
      ...pendingCleanupRecord(id).policy,
      mode: "leased-conversation"
    },
    cleanup,
    attempts,
    lastError: cleanup === "pending" ? "" : "prior cleanup interruption",
    ...(cleanup === "disposing" ? { cleanupStartedAt: 50 } : {})
  };
}

function authorityProof(
  relation: ConversationAuthorityProof["relation"],
  targetPayload: ConversationAuthorityProof["targetPayload"],
  currentGeneration: number,
  currentCommitId: string
): ConversationAuthorityProof {
  return {
    conversationId: "conversation-1",
    currentGeneration,
    currentContextId: `context-${currentGeneration}`,
    currentCommitId,
    currentWorkspaceFingerprint: "sha256:0123456789abcdef",
    targetPayload,
    relation
  };
}
