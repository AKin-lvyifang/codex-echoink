import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
  AgentAdapter,
  AgentConnectContext,
  AgentConnectionStatus,
  AgentManifest,
  AgentRunRequest,
  AgentRunResult
} from "../../harness/agents/adapter";
import { noCapabilities } from "../../harness/contracts/capability";
import type { HarnessEventSink } from "../../harness/contracts/event";
import type {
  MemoryTransactionAuthorityReceipt,
  NativeExecutionDispositionRequest,
  NativeExecutionDispositionResult,
  NativeExecutionRecord,
  NativeExecutionRef
} from "../../harness/contracts/native-execution";
import type { HarnessRunRequest } from "../../harness/contracts/run";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { FileRunLedger } from "../../harness/ledger/run-ledger";
import {
  appendPendingMemoryEvent,
  echoInkMemoryV2Layout,
  readMemoryManifestV2,
  readPendingMemoryEvents
} from "../../harness/memory/v2-store";
import {
  applyMemoryCuratorResult,
  commitMemoryTransaction,
  deferredMemoryCuratorInvocation,
  prepareMemoryTransaction,
  resolveMemoryTransactionAuthority,
  syncPendingMemory,
  validateMemoryCuratorResult,
  type MemoryCuratorRequest,
  type MemoryCuratorResult
} from "../../harness/memory/v2-engine";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import {
  type DeferredEphemeralUtilityResult,
  type EphemeralUtilityLifecycleHost,
  runEphemeralUtility
} from "../../harness/native/ephemeral-utility-lifecycle";
import {
  NativeExecutionManager,
  type NativeCleanupResult,
  type SettleNativeExecutionInput
} from "../../harness/native/native-execution-manager";
import { NativeExecutionStore } from "../../harness/native/native-execution-store";
import { EchoInkHarnessService } from "../../plugin/harness-service";

interface NativeAuthorityFixture {
  rootPath: string;
  vaultPath: string;
  nativeRootPath: string;
  ledgerRootPath: string;
  providerCleanupCalls: number;
}

interface CuratorExecution {
  deferred: DeferredEphemeralUtilityResult<MemoryCuratorResult>;
  record: NativeExecutionRecord;
}

export async function runMemoryNativeTransactionAuthorityTests(): Promise<void> {
  await assertLiveSyncFinalizesOnlyAfterFormalCommit();
  await assertPreparedAndAppliedCrashWindowsKeepCleanupAtZero();
  await assertFailAfterIndexWriteRecoversBeforeCleanup();
  await assertDurablePendingAndFailedTransactionsAuthorizeCleanup();
  await assertDurablePendingAndFailedRecoverAtFreshStartup();
  await assertStartupRejectsCorruptFormalAuthorityProof();
}

async function assertLiveSyncFinalizesOnlyAfterFormalCommit(): Promise<void> {
  const fixture = await createFixture("live-commit");
  const receipts: MemoryTransactionAuthorityReceipt[] = [];
  try {
    await appendSourceEvent(fixture.vaultPath, "live-commit");
    let execution: CuratorExecution | null = null;
    const result = await syncPendingMemory(fixture.vaultPath, {
      curate: async (source) => {
        execution = await runCuratorExecution(fixture, source);
        return deferredMemoryCuratorInvocation(
          execution.deferred.value,
          async (receipt) => {
            receipts.push(receipt);
            return await execution!.deferred.finalize(receipt);
          }
        );
      }
    });

    assert.equal(result.outcome, "write");
    assert.ok(result.transactionId);
    assert.deepEqual(receipts, [{
      kind: "memory-transaction",
      transactionId: result.transactionId,
      state: "committed",
      durable: true,
      revision: 1,
      outcome: "write"
    }]);
    const records = await new NativeExecutionStore({
      rootPath: fixture.nativeRootPath
    }).list();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].localCommitAuthority, {
      kind: "memory-transaction",
      transactionId: result.transactionId
    });
    assert.equal(records[0].localCommit, "committed");
    assert.equal(records[0].cleanup, "disposed");
    assert.equal(fixture.providerCleanupCalls, 1);
  } finally {
    await removeFixture(fixture);
  }
}

async function assertPreparedAndAppliedCrashWindowsKeepCleanupAtZero(): Promise<void> {
  const fixture = await createFixture("prepared-applied-crash");
  try {
    const event = await appendSourceEvent(
      fixture.vaultPath,
      "prepared-applied-crash"
    );
    const source = await prepareMemoryTransaction(
      fixture.vaultPath,
      [event.eventId]
    );
    assert.ok(source);
    await runCuratorExecution(fixture, source);

    const preparedRestart = await reconcileAtFreshStartup(fixture);
    assert.deepEqual(preparedRestart.cleanup, []);
    await assertPendingNativeRecord(fixture, source.transactionId);
    assert.equal(fixture.providerCleanupCalls, 0);

    const applied = await applyMemoryCuratorResult(
      fixture.vaultPath,
      source.transactionId,
      curatorWrite(source)
    );
    assert.equal(applied.outcome, "write");
    const appliedRestart = await reconcileAtFreshStartup(fixture);
    assert.deepEqual(appliedRestart.cleanup, []);
    await assertPendingNativeRecord(fixture, source.transactionId);
    assert.equal(
      await resolveMemoryTransactionAuthority(
        fixture.vaultPath,
        source.transactionId
      ),
      null
    );
    assert.equal(fixture.providerCleanupCalls, 0);

    const committed = await commitMemoryTransaction(
      fixture.vaultPath,
      source.transactionId
    );
    assert.equal(committed.outcome, "write");
    const committedRestart = await reconcileAtFreshStartup(fixture);
    assert.equal(committedRestart.cleanup.length, 1);
    const record = (await new NativeExecutionStore({
      rootPath: fixture.nativeRootPath
    }).list())[0];
    assert.equal(record.localCommit, "committed");
    assert.equal(record.cleanup, "disposed");
    assert.equal(fixture.providerCleanupCalls, 1);
  } finally {
    await removeFixture(fixture);
  }
}

async function assertFailAfterIndexWriteRecoversBeforeCleanup(): Promise<void> {
  const fixture = await createFixture("fail-after-index");
  try {
    const event = await appendSourceEvent(
      fixture.vaultPath,
      "fail-after-index"
    );
    const source = await prepareMemoryTransaction(
      fixture.vaultPath,
      [event.eventId]
    );
    assert.ok(source);
    await runCuratorExecution(fixture, source);
    await applyMemoryCuratorResult(
      fixture.vaultPath,
      source.transactionId,
      curatorWrite(source)
    );
    const interrupted = await commitMemoryTransaction(
      fixture.vaultPath,
      source.transactionId,
      { failAfterIndexWrite: true }
    );
    assert.equal(interrupted.outcome, "failed");
    await assertPendingNativeRecord(fixture, source.transactionId);
    assert.equal(fixture.providerCleanupCalls, 0);

    const restart = await reconcileAtFreshStartup(fixture);
    assert.equal(restart.cleanup.length, 1);
    assert.equal((await readMemoryManifestV2(fixture.vaultPath)).revision, 1);
    assert.equal(
      (await readPendingMemoryEvents(fixture.vaultPath)).length,
      0
    );
    const record = (await new NativeExecutionStore({
      rootPath: fixture.nativeRootPath
    }).list())[0];
    assert.equal(record.localCommit, "committed");
    assert.equal(record.cleanup, "disposed");
    assert.equal(fixture.providerCleanupCalls, 1);
  } finally {
    await removeFixture(fixture);
  }
}

async function assertDurablePendingAndFailedTransactionsAuthorizeCleanup(): Promise<void> {
  for (const authorityState of ["durable-pending", "durable-failed"] as const) {
    const fixture = await createFixture(authorityState);
    const receipts: MemoryTransactionAuthorityReceipt[] = [];
    try {
      await appendSourceEvent(fixture.vaultPath, authorityState);
      const result = await syncPendingMemory(fixture.vaultPath, {
        curate: async (source) => {
          const execution = await runCuratorExecution(
            fixture,
            source,
            authorityState === "durable-pending"
              ? curatorPending(source)
              : curatorWrite(source),
            authorityState === "durable-failed"
              ? async () => {
                const target = path.join(
                  echoInkMemoryV2Layout(fixture.vaultPath).transactions,
                  source.transactionId,
                  "curator-result.json"
                );
                await mkdir(target, { recursive: true });
              }
              : undefined
          );
          return deferredMemoryCuratorInvocation(
            execution.deferred.value,
            async (receipt) => {
              receipts.push(receipt);
              return await execution.deferred.finalize(receipt);
            }
          );
        }
      });

      assert.equal(
        result.outcome,
        authorityState === "durable-pending" ? "pending" : "failed"
      );
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].state, authorityState);
      assert.equal(receipts[0].transactionId, result.transactionId);
      const record = (await new NativeExecutionStore({
        rootPath: fixture.nativeRootPath
      }).list())[0];
      assert.equal(record.localCommit, "committed");
      assert.equal(record.cleanup, "disposed");
      assert.equal(fixture.providerCleanupCalls, 1);
      assert.equal(
        (await readPendingMemoryEvents(fixture.vaultPath)).length,
        1,
        "pending/failed Memory authority must retain its source event"
      );
    } finally {
      await removeFixture(fixture);
    }
  }
}

async function assertDurablePendingAndFailedRecoverAtFreshStartup(): Promise<void> {
  for (const authorityState of ["durable-pending", "durable-failed"] as const) {
    const fixture = await createFixture(`startup-${authorityState}`);
    try {
      const event = await appendSourceEvent(
        fixture.vaultPath,
        `startup-${authorityState}`
      );
      const source = await prepareMemoryTransaction(
        fixture.vaultPath,
        [event.eventId]
      );
      assert.ok(source);
      await runCuratorExecution(fixture, source);
      const formalResult = await applyMemoryCuratorResult(
        fixture.vaultPath,
        source.transactionId,
        authorityState === "durable-pending"
          ? curatorPending(source)
          : {
            schemaVersion: 1,
            outcome: "no-op",
            summary: "injected invalid Curator schema",
            candidates: []
          }
      );
      assert.equal(
        formalResult.outcome,
        authorityState === "durable-pending" ? "pending" : "failed"
      );
      assert.equal(
        (await resolveMemoryTransactionAuthority(
          fixture.vaultPath,
          source.transactionId
        ))?.state,
        authorityState
      );

      const restart = await reconcileAtFreshStartup(fixture);
      assert.equal(restart.cleanup.length, 1);
      const record = (await new NativeExecutionStore({
        rootPath: fixture.nativeRootPath
      }).list())[0];
      assert.equal(record.localCommit, "committed");
      assert.equal(record.cleanup, "disposed");
      assert.equal(fixture.providerCleanupCalls, 1);
      assert.equal(
        (await readPendingMemoryEvents(fixture.vaultPath)).length,
        1,
        "startup settlement must preserve pending/failed source events"
      );
    } finally {
      await removeFixture(fixture);
    }
  }
}

async function assertStartupRejectsCorruptFormalAuthorityProof(): Promise<void> {
  for (const corruption of ["identity", "events", "revision"] as const) {
    const fixture = await createFixture(`corrupt-${corruption}`);
    try {
      const event = await appendSourceEvent(
        fixture.vaultPath,
        `corrupt-${corruption}`
      );
      const source = await prepareMemoryTransaction(
        fixture.vaultPath,
        [event.eventId]
      );
      assert.ok(source);
      await runCuratorExecution(fixture, source);
      const failed = await applyMemoryCuratorResult(
        fixture.vaultPath,
        source.transactionId,
        {
          schemaVersion: 1,
          outcome: "no-op",
          summary: "injected invalid Curator schema",
          candidates: []
        }
      );
      assert.equal(failed.outcome, "failed");

      const layout = echoInkMemoryV2Layout(fixture.vaultPath);
      if (corruption === "revision") {
        const manifest = JSON.parse(
          await readFile(layout.manifest, "utf8")
        ) as Record<string, unknown>;
        await writeFile(
          layout.manifest,
          `${JSON.stringify({ ...manifest, revision: 1 })}\n`,
          "utf8"
        );
      } else {
        const transactionPath = path.join(
          layout.transactions,
          source.transactionId,
          "transaction.json"
        );
        const transaction = JSON.parse(
          await readFile(transactionPath, "utf8")
        ) as Record<string, unknown>;
        await writeFile(
          transactionPath,
          `${JSON.stringify({
            ...transaction,
            ...(corruption === "identity"
              ? { transactionId: `${source.transactionId}-tampered` }
              : { eventIds: [`${event.eventId}-tampered`] })
          })}\n`,
          "utf8"
        );
      }

      await assert.rejects(
        reconcileAtFreshStartup(fixture),
        corruption === "revision"
          ? /revision|formal files are inconsistent/
          : /authority identity is invalid/
      );
      await assertPendingNativeRecord(fixture, source.transactionId);
      assert.equal(
        fixture.providerCleanupCalls,
        0,
        `${corruption} corruption must fail closed before provider cleanup`
      );
    } finally {
      await removeFixture(fixture);
    }
  }
}

async function runCuratorExecution(
  fixture: NativeAuthorityFixture,
  source: MemoryCuratorRequest,
  result: MemoryCuratorResult = curatorWrite(source),
  beforeReturn?: () => Promise<void>
): Promise<CuratorExecution> {
  const responseText = JSON.stringify(result);
  const adapter = new MemoryNativeAdapter(
    fixture,
    source.transactionId,
    responseText
  );
  const ledger = new FileRunLedger({ rootPath: fixture.ledgerRootPath });
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider()
  });
  const store = new NativeExecutionStore({
    rootPath: fixture.nativeRootPath
  });
  const manager = nativeManager(fixture, adapter, store, kernel);
  const host: EphemeralUtilityLifecycleHost = {
    runHarnessWithAdapter: async (input) =>
      await kernel.runWithAdapter(input),
    cancelHarnessRun: async (runId) => {
      await kernel.cancelRun(runId);
    },
    settleHarnessRunTerminal: async (input) =>
      await kernel.settleRunTerminal(input),
    recordNativeExecution: async (record) => {
      await manager.recordCreated(record);
    },
    settleNativeExecution: async (input: SettleNativeExecutionInput) =>
      await manager.settleRun(input),
    cleanupNativeExecutionRecord: async (
      recordId: string
    ): Promise<NativeCleanupResult> => await manager.cleanupById(recordId)
  };
  const request: HarnessRunRequest & { workflow: "memory.curate" } = {
    runId: `memory-curator-run:${source.transactionId}`,
    sessionId: `memory-curator:${source.transactionId}`,
    surface: "review",
    workflow: "memory.curate",
    backendId: adapter.manifest.id,
    workspace: {
      vaultPath: fixture.vaultPath,
      cwd: fixture.vaultPath
    },
    input: { text: "curate supplied transaction", attachments: [] },
    permissions: {
      mode: "read-only",
      writableRoots: [],
      requireApproval: true
    },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  };
  const deferred = await runEphemeralUtility({
    host,
    adapter,
    request,
    settlement: {
      mode: "deferred",
      authority: {
        kind: "memory-transaction",
        transactionId: source.transactionId
      }
    },
    validateOutput: async (text) => {
      const validated = validateMemoryCuratorResult(source, text).result;
      await beforeReturn?.();
      return {
        value: validated,
        terminalText: JSON.stringify(validated)
      };
    }
  });
  const records = await store.list();
  assert.equal(records.length, 1);
  return { deferred, record: records[0] };
}

async function reconcileAtFreshStartup(
  fixture: NativeAuthorityFixture
): Promise<Awaited<ReturnType<EchoInkHarnessService["reconcileNativeExecutionStartup"]>>> {
  const ledger = new FileRunLedger({ rootPath: fixture.ledgerRootPath });
  const adapter = new MemoryNativeAdapter(
    fixture,
    "startup-cleanup",
    "{}"
  );
  const manager = new NativeExecutionManager({
    store: new NativeExecutionStore({ rootPath: fixture.nativeRootPath }),
    adapters: [adapter]
  });
  const service = new EchoInkHarnessService({
    settings: { sessions: [] },
    getVaultPath: () => fixture.vaultPath,
    getPluginDataDirName: () => ".obsidian/plugins/codex-echoink"
  } as never);
  (service as unknown as {
    getNativeExecutionManager(): NativeExecutionManager;
  }).getNativeExecutionManager = () => manager;
  (service as unknown as {
    createRunLedger(): FileRunLedger;
  }).createRunLedger = () => ledger;
  return await service.reconcileNativeExecutionStartup(async () => {
    throw new Error("Memory-only startup fixture requested Conversation proof");
  });
}

function nativeManager(
  fixture: NativeAuthorityFixture,
  adapter: AgentAdapter,
  store: NativeExecutionStore,
  kernel: EchoInkHarnessKernel
): NativeExecutionManager {
  return new NativeExecutionManager({
    store,
    adapters: [adapter],
    emitRunEvent: async (event) => {
      await kernel.appendRunEvent(event);
    }
  });
}

async function assertPendingNativeRecord(
  fixture: NativeAuthorityFixture,
  transactionId: string
): Promise<void> {
  const records = await new NativeExecutionStore({
    rootPath: fixture.nativeRootPath
  }).list();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].localCommitAuthority, {
    kind: "memory-transaction",
    transactionId
  });
  assert.equal(records[0].localCommit, "pending");
  assert.equal(records[0].cleanup, "not-needed");
}

async function appendSourceEvent(
  vaultPath: string,
  id: string
) {
  return await appendPendingMemoryEvent(vaultPath, {
    eventId: `memory-event:${id}`,
    runId: `source-run:${id}`,
    sessionId: `source-session:${id}`,
    workflow: "chat.generic",
    backendId: "memory-native-test",
    eventType: "final-result",
    createdAt: 1,
    payload: { text: `remember ${id}` }
  });
}

function curatorWrite(source: MemoryCuratorRequest): MemoryCuratorResult {
  const event = source.events[0];
  return {
    schemaVersion: 2,
    outcome: "write",
    summary: "write durable test memory",
    candidates: [{
      candidateId: `memory-${source.transactionId}`,
      disposition: "write",
      sourceEventIds: [event.eventId],
      reason: "explicit test source",
      kind: "current-state",
      scope: "vault",
      statement: `durable statement ${source.transactionId}`,
      evidenceRefs: [`event:${event.eventId}`],
      sourceRunId: event.runId,
      confidence: 0.9,
      requiresConfirmation: false
    }]
  };
}

function curatorPending(source: MemoryCuratorRequest): MemoryCuratorResult {
  return {
    schemaVersion: 2,
    outcome: "pending",
    summary: "retain unresolved transaction",
    candidates: [{
      candidateId: `pending-${source.transactionId}`,
      disposition: "unresolved",
      sourceEventIds: [source.events[0].eventId],
      reason: "requires explicit resolution"
    }]
  };
}

async function createFixture(slug: string): Promise<NativeAuthorityFixture> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), `echoink-memory-native-${slug}-`)
  );
  return {
    rootPath,
    vaultPath: path.join(rootPath, "vault"),
    nativeRootPath: path.join(rootPath, "native"),
    ledgerRootPath: path.join(rootPath, "ledger"),
    providerCleanupCalls: 0
  };
}

async function removeFixture(fixture: NativeAuthorityFixture): Promise<void> {
  await rm(fixture.rootPath, { recursive: true, force: true });
}

class MemoryNativeAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
  private readonly native: NativeExecutionRef;

  constructor(
    private readonly fixture: NativeAuthorityFixture,
    transactionId: string,
    private readonly responseText: string
  ) {
    this.manifest = {
      id: "memory-native-test",
      displayName: "Memory Native Test",
      version: "test",
      capabilities: noCapabilities(),
      nativeExecution: {
        persistence: "provider-persistent",
        dispositions: {
          processExit: true,
          archive: false,
          delete: false
        },
        idempotentDisposition: true,
        canInspectExistence: false
      }
    };
    this.native = {
      backendId: this.manifest.id,
      id: `native:${transactionId}`,
      kind: "session",
      persistence: "provider-persistent",
      providerEndpoint: "memory-native-test://provider",
      deviceKey: "memory-native-test-device",
      vaultId: fixture.vaultPath,
      createdAt: 1
    };
  }

  async connect(_context: AgentConnectContext): Promise<AgentConnectionStatus> {
    return {
      connected: true,
      label: this.manifest.displayName,
      version: this.manifest.version,
      errors: []
    };
  }

  async dispose(): Promise<void> {
    return undefined;
  }

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return [];
  }

  async run(
    request: AgentRunRequest,
    _emit: HarnessEventSink
  ): Promise<AgentRunResult> {
    await request.registerNativeExecution?.(this.native);
    return {
      status: "completed",
      outputText: this.responseText,
      nativeExecution: this.native
    };
  }

  async cancel(_runId: string): Promise<void> {
    return undefined;
  }

  async disposeNativeExecution(
    request: NativeExecutionDispositionRequest
  ): Promise<NativeExecutionDispositionResult> {
    this.fixture.providerCleanupCalls += 1;
    return {
      outcome: "disposed",
      applied: request.requested
    };
  }
}
