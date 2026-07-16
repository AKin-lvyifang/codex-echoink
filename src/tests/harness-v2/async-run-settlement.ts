import * as assert from "node:assert/strict";
import type { AgentTaskRuntime } from "../../agent/runtime";
import type { AgentAdapter, AgentConnectionStatus, AgentRunRequest, AgentRunResult } from "../../harness/agents/adapter";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import { TaskRuntimeAgentAdapter } from "../../harness/agents/adapters/task-runtime-adapter";
import { noCapabilities } from "../../harness/contracts/capability";
import type { HarnessEvent, HarnessEventSink, HarnessEventType } from "../../harness/contracts/event";
import type { NativeExecutionRef } from "../../harness/contracts/native-execution";
import type { HarnessRunRequest } from "../../harness/contracts/run";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { RunOrchestrator } from "../../harness/kernel/run-orchestrator";
import { InMemoryRunLedger, type RunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import type { MemoryProvider } from "../../harness/memory/provider";

export async function runHarnessV2AsyncRunSettlementTests(): Promise<void> {
  await assertKernelSettlesAsyncRunningRunToCompleted();
  await assertAsyncSettlementIsIdempotent();
  await assertPreExistingTerminalShortCircuitsRun();
  await assertConcurrentSameRunIdStartsAdapterOnce();
  await assertHydrationUsesLatestTerminalEvent();
  await assertAsyncSettlementSerializesRaces();
  await assertAppendRunEventDeduplicatesTerminalTypes();
  await assertLateAdapterTerminalAfterExternalSettlementIsIgnored();
  await assertAsyncSettlementMapsFailedAndCancelled();
  await assertSynchronousTerminalOrderRemainsStable();
  await assertTerminalDoesNotWaitForMemoryObservation();
  await assertBlockedDeliveryDoesNotDelayTerminalCommitBeforeAdapterRun();
  await assertTerminalCannotCommitInsideAdapterStartBoundary();
  await assertTerminalSinkThrowStillKeepsTerminalAuthoritativeDuringAdapterRun();
  await assertCommittedTerminalBeatsLateRunningAdapterResult();
  await assertSameRunSinkReentryDoesNotDeadlock();
  await assertSameRunDeliveryRemainsSerialWhileSinkIsPending();
  await assertFireAndForgetSinkThrowIsContained();
  await assertTerminalCommitReleasesOwnerBeforeSinkDeliveryCompletes();
  await assertConcurrentTerminalSourcesResolveToFirstCommittedTerminal();
  await assertTerminalAllowsLifecycleButRejectsLateAgentEvents();
  await assertTerminalRunsRecycleLanes();
  await assertCancelBeforeAdapterRunSettlesCancelledWithoutInvokingAdapterRun();
  await assertExternalSettlementRacingPreRunCancellationHasOneTerminal();
  await assertExternalSettlementBeforeCancellationCheckSkipsAdapterRun();
  await assertCancelDuringAdapterRunStillForwardsToOwner();
  await assertCancelDuringRejectingAdapterRunWritesOneCancelledTerminal();
  await assertCancelTargetsOnlyOwningAdapter();
  await assertCancelOwnerReleasedAfterSynchronousTerminal();
  await assertCancelOwnerReleasedAfterAsyncSettlement();
}

async function assertTerminalDoesNotWaitForMemoryObservation(): Promise<void> {
  const terminalObserved = deferred<void>();
  const releaseObservation = deferred<void>();
  let failingTerminalObserved = false;
  const memoryProvider: MemoryProvider = {
    async retrieve() {
      return { providerId: "test", items: [], sections: [] };
    },
    async propose() {
      return [];
    },
    async commit() {
      return { committed: [], skipped: [] };
    },
    async supersede() {
      return undefined;
    },
    async observeRunEvent(event) {
      if (event.type !== "run.completed" || failingTerminalObserved) return;
      failingTerminalObserved = true;
      terminalObserved.resolve();
      await releaseObservation.promise;
      throw new Error("curator failed after terminal commit");
    }
  };
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "memory-non-blocking",
      result: { status: "completed", outputText: "done" }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider,
    now: fixedClock(1500)
  });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    if (args[0] === "EchoInk Memory lifecycle event failed") warnings.push(args);
    else originalWarn(...args);
  };
  try {
    const run = orchestrator.run(genericChatRequest("run-memory-non-blocking", "memory-non-blocking"));
    const outcome = await Promise.race([
      run.then((result) => result.status),
      waitMs(50).then(() => "timed-out" as const)
    ]);
    assert.equal(outcome, "completed", "terminal run must not wait for memory curator work");
    await terminalObserved.promise;
    releaseObservation.resolve();
    await waitMs(0);
    assert.equal(warnings.length, 1, "memory observation failure must be isolated and reported");

    const next = await orchestrator.run(genericChatRequest("run-memory-after-failure", "memory-non-blocking"));
    assert.equal(next.status, "completed", "memory failure must stay isolated from later runs");
  } finally {
    console.warn = originalWarn;
  }
}

async function assertKernelSettlesAsyncRunningRunToCompleted(): Promise<void> {
  const runId = "run-async-completed";
  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(1000)
  });
  const result = await kernel.runWithAdapter({
    adapter: createStaticAdapter({
      backendId: "fake-async",
      result: {
        status: "running",
        outputText: "still running",
        nativeExecution: nativeThreadExecution("fake-async", "native-thread-1")
      },
      emittedEvents: [{ type: "agent.message.delta", text: "still running" }]
    }),
    request: genericChatRequest(runId, "fake-async")
  });

  assert.equal(result.status, "running");

  await kernel.settleRunTerminal({
    runId,
    status: "completed",
    backendId: "fake-async",
    text: "done"
  });

  const events = await ledger.readRun(runId);
  assert.deepEqual(events.map((event) => event.type), [
    "run.created",
    "run.started",
    "agent.connecting",
    "agent.connected",
    "agent.message.delta",
    "agent.native_execution.created",
    "agent.native_lease.created",
    "run.completed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(events[7].eventId, `${runId}:8`);
  assert.equal(events[7].createdAt, 1000);
  assert.equal(events[7].text, "done");
  assert.equal(countTerminalEvents(events), 1);
}

async function assertAsyncSettlementIsIdempotent(): Promise<void> {
  const runId = "run-async-idempotent";
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "fake-async",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("fake-async", "native-thread-2")
      }
    })],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(2000)
  });

  await orchestrator.run(genericChatRequest(runId, "fake-async"));
  await orchestrator.settleRunTerminal({ runId, status: "completed", backendId: "fake-async", text: "done" });
  const once = await ledger.readRun(runId);
  await orchestrator.settleRunTerminal({ runId, status: "failed", backendId: "fake-async", error: "should no-op" });
  const twice = await ledger.readRun(runId);

  assert.deepEqual(twice, once);
  assert.equal(countTerminalEvents(twice), 1);
  assert.equal(twice.at(-1)?.type, "run.completed");
}

async function assertPreExistingTerminalShortCircuitsRun(): Promise<void> {
  const runId = "run-pre-existing-terminal";
  const ledger = new InMemoryRunLedger();
  let runCalls = 0;
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "pre-settled",
      result: { status: "completed", outputText: "must not run" },
      onRun: () => {
        runCalls += 1;
      }
    })],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(2250)
  });
  await orchestrator.settleRunTerminal({
    runId,
    status: "cancelled",
    backendId: "pre-settled",
    error: "already cancelled"
  });
  const settledEvents = await ledger.readRun(runId);

  const result = await orchestrator.run(genericChatRequest(runId, "pre-settled"));
  const finalEvents = await ledger.readRun(runId);

  assert.equal(runCalls, 0);
  assert.deepEqual(result, { runId, status: "cancelled", error: "already cancelled" });
  assert.deepEqual(finalEvents, settledEvents);
}

async function assertConcurrentSameRunIdStartsAdapterOnce(): Promise<void> {
  const runId = "run-concurrent-start";
  const runEntered = deferred<void>();
  const releaseRun = deferred<void>();
  let runCalls = 0;
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "concurrent-start",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("concurrent-start", "single-native-thread")
      },
      onRun: async () => {
        runCalls += 1;
        runEntered.resolve();
        await releaseRun.promise;
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(2300)
  });

  const first = orchestrator.run(genericChatRequest(runId, "concurrent-start"));
  await runEntered.promise;
  const second = orchestrator.run(genericChatRequest(runId, "concurrent-start"));
  releaseRun.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(runCalls, 1);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.nativeExecution?.id, "single-native-thread");
}

async function assertHydrationUsesLatestTerminalEvent(): Promise<void> {
  const runId = "run-hydrate-latest-terminal";
  const ledger = new InMemoryRunLedger();
  await ledger.append({
    eventId: `${runId}:1`,
    runId,
    sequence: 1,
    createdAt: 1,
    source: "kernel",
    type: "run.failed",
    error: "stale failure"
  });
  await ledger.append({
    eventId: `${runId}:3`,
    runId,
    sequence: 3,
    createdAt: 3,
    source: "kernel",
    type: "run.completed",
    text: "recovered completion"
  });
  let runCalls = 0;
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "hydrate-latest",
      result: { status: "completed", outputText: "must not run" },
      onRun: () => {
        runCalls += 1;
      }
    })],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(2350)
  });

  const result = await orchestrator.run(genericChatRequest(runId, "hydrate-latest"));
  assert.equal(runCalls, 0);
  assert.deepEqual(result, { runId, status: "completed", outputText: "recovered completion" });
}

async function assertAsyncSettlementSerializesRaces(): Promise<void> {
  const runId = "run-async-race";
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(2500)
  });

  await Promise.all([
    orchestrator.settleRunTerminal({ runId, status: "completed", backendId: "fake-async" }),
    orchestrator.settleRunTerminal({ runId, status: "failed", backendId: "fake-async", error: "late failure" })
  ]);

  const events = await ledger.readRun(runId);
  assert.equal(countTerminalEvents(events), 1);
  assert.equal(events[0]?.type, "run.completed");
}

async function assertLateAdapterTerminalAfterExternalSettlementIsIgnored(): Promise<void> {
  const runId = "run-late-adapter-terminal";
  const ledger = new InMemoryRunLedger();
  const sinkEvents: HarnessEvent[] = [];
  let lateEmit: HarnessEventSink | undefined;
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "late-terminal",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("late-terminal", "late-terminal-thread")
      },
      captureEmit: (emit) => {
        lateEmit = emit;
      }
    })],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(2750)
  });
  const sink = (event: HarnessEvent): void => {
    sinkEvents.push(event);
  };

  const result = await orchestrator.run(genericChatRequest(runId, "late-terminal"), sink);
  assert.equal(result.status, "running");
  await orchestrator.settleRunTerminal({
    runId,
    status: "completed",
    backendId: "late-terminal",
    text: "external terminal"
  }, sink);
  assert.ok(lateEmit);
  await lateEmit({
    eventId: "adapter-late-terminal",
    runId,
    sequence: 999,
    createdAt: 2751,
    source: "agent",
    type: "run.failed",
    backendId: "late-terminal",
    error: "late adapter failure"
  });

  const events = await ledger.readRun(runId);
  assert.equal(countTerminalEvents(events), 1);
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(events.map((event) => event.eventId), events.map((_, index) => `${runId}:${index + 1}`));
  assert.equal(sinkEvents.filter(isTerminalEvent).length, 1);
}

async function assertAppendRunEventDeduplicatesTerminalTypes(): Promise<void> {
  const runId = "run-append-terminal-idempotency";
  const ledger = new InMemoryRunLedger();
  const sinkEvents: HarnessEvent[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(2800)
  });
  const sink = (event: HarnessEvent): void => {
    sinkEvents.push(event);
  };

  await orchestrator.appendRunEvent({
    runId,
    source: "agent",
    type: "agent.message.completed",
    text: "done"
  }, sink);
  const completed = await orchestrator.appendRunEvent({
    runId,
    source: "kernel",
    type: "run.completed",
    text: "first terminal"
  }, sink);
  const failed = await orchestrator.appendRunEvent({
    runId,
    source: "kernel",
    type: "run.failed",
    error: "late failure"
  }, sink);

  const events = await ledger.readRun(runId);
  assert.equal(countTerminalEvents(events), 1);
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.equal(failed.eventId, completed.eventId);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(events.map((event) => event.eventId), [`${runId}:1`, `${runId}:2`]);
  assert.equal(sinkEvents.filter(isTerminalEvent).length, 1);
}

async function assertAsyncSettlementMapsFailedAndCancelled(): Promise<void> {
  await assertAsyncSettlementType("failed", "run.failed", "boom");
  await assertAsyncSettlementType("cancelled", "run.cancelled", "stopped");
}

async function assertAsyncSettlementType(
  status: "failed" | "cancelled",
  expectedType: "run.failed" | "run.cancelled",
  error: string
): Promise<void> {
  const runId = `run-async-${status}`;
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "fake-async",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("fake-async", `native-thread-${status}`)
      }
    })],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(3000)
  });

  await orchestrator.run(genericChatRequest(runId, "fake-async"));
  await orchestrator.settleRunTerminal({ runId, status, backendId: "fake-async", error });

  const events = await ledger.readRun(runId);
  assert.equal(events.at(-1)?.type, expectedType);
  assert.equal(events.at(-1)?.error, error);
  assert.equal(countTerminalEvents(events), 1);
}

async function assertSynchronousTerminalOrderRemainsStable(): Promise<void> {
  const fakeTypes = await runSynchronousCompletionTypes(
    "run-sync-fake",
    "fake",
    new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      nativeSessionId: "fake-session-1"
    })
  );
  assert.deepEqual(fakeTypes, [
    "run.created",
    "run.started",
    "agent.connecting",
    "agent.connected",
    "agent.message.delta",
    "agent.message.completed",
    "agent.native_lease.created",
    "run.completed"
  ]);

  const openCodeTypes = await runSynchronousCompletionTypes(
    "run-sync-opencode",
    "opencode",
    new TaskRuntimeAgentAdapter({
      backendId: "opencode",
      displayName: "OpenCode",
      version: "test",
      runtime: createLegacyRuntime("opencode", "opencode-session-1", "OpenCode 完成"),
      capabilities: "legacy"
    })
  );
  assert.deepEqual(openCodeTypes, [
    "run.created",
    "run.started",
    "agent.connecting",
    "agent.connected",
    "agent.message.completed",
    "agent.native_execution.created",
    "agent.native_lease.created",
    "run.completed"
  ]);

  const hermesTypes = await runSynchronousCompletionTypes(
    "run-sync-hermes",
    "hermes",
    new TaskRuntimeAgentAdapter({
      backendId: "hermes",
      displayName: "Hermes",
      version: "test",
      runtime: createLegacyRuntime("hermes", "hermes-run-1", "Hermes 完成"),
      capabilities: "legacy"
    })
  );
  assert.deepEqual(hermesTypes, [
    "run.created",
    "run.started",
    "agent.connecting",
    "agent.connected",
    "agent.message.completed",
    "agent.native_execution.created",
    "agent.native_lease.created",
    "run.completed"
  ]);
}

async function assertBlockedDeliveryDoesNotDelayTerminalCommitBeforeAdapterRun(): Promise<void> {
  const runId = "runlane-terminal-gate-before-adapter";
  const retrieveStarted = deferred<void>();
  const releaseRetrieve = deferred<void>();
  const deliveryStarted = deferred<void>();
  const releaseDelivery = deferred<void>();
  let runCalls = 0;
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "runlane-gate",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("runlane-gate", "runlane-gate-thread")
      },
      onRun: () => {
        runCalls += 1;
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: stalledMemoryProvider(retrieveStarted, releaseRetrieve),
    now: fixedClock(4500)
  });

  const request = genericChatRequest(runId, "runlane-gate");
  request.memoryPolicy.enabled = true;
  const runPromise = orchestrator.run(request);
  await retrieveStarted.promise;
  const blockingAppend = orchestrator.appendRunEvent({
    runId,
    source: "agent",
    type: "agent.message.delta",
    text: "block delivery"
  }, async () => {
    deliveryStarted.resolve();
    await releaseDelivery.promise;
  });
  await deliveryStarted.promise;
  const terminalSettlement = orchestrator.settleRunTerminal({
    runId,
    status: "completed",
    backendId: "runlane-gate",
    text: "terminal wins"
  });

  releaseRetrieve.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseDelivery.resolve();

  const [result] = await Promise.all([runPromise, blockingAppend, terminalSettlement]);
  assert.equal(runCalls, 0);
  assert.deepEqual(result, { runId, status: "completed", outputText: "terminal wins" });
}

async function assertTerminalSinkThrowStillKeepsTerminalAuthoritativeDuringAdapterRun(): Promise<void> {
  const runId = "runlane-terminal-sink-throw";
  const runEntered = deferred<void>();
  const releaseRun = deferred<void>();
  let runCalls = 0;
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "sink-throw",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("sink-throw", "sink-throw-thread")
      },
      onRun: async () => {
        runCalls += 1;
        runEntered.resolve();
        await releaseRun.promise;
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4510)
  });

  const runPromise = orchestrator.run(genericChatRequest(runId, "sink-throw"));
  await runEntered.promise;
  await orchestrator.settleRunTerminal({
    runId,
    status: "completed",
    backendId: "sink-throw",
    text: "terminal survives sink throw"
  }, () => {
    throw new Error("terminal sink exploded");
  });
  releaseRun.resolve();

  const result = await runPromise;
  const replay = await orchestrator.run(genericChatRequest(runId, "sink-throw"));
  assert.equal(runCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "terminal survives sink throw");
  assert.equal(result.nativeExecution?.id, "sink-throw-thread");
  assert.equal(result.backendBinding?.nativeThreadId, "sink-throw-thread");
  assert.deepEqual(replay, { runId, status: "completed", outputText: "terminal survives sink throw" });
}

async function assertTerminalCannotCommitInsideAdapterStartBoundary(): Promise<void> {
  const runId = "runlane-adapter-start-boundary";
  const ledger = new InMemoryRunLedger();
  const runEntered = deferred<void>();
  const releaseRun = deferred<void>();
  let terminalCommittedAtInvocation: boolean | undefined;
  const adapter = createStaticAdapter({
    backendId: "start-boundary",
    result: { status: "running" },
    onRun: async () => {
      terminalCommittedAtInvocation = countTerminalEvents(await ledger.readRun(runId)) > 0;
      runEntered.resolve();
      await releaseRun.promise;
    }
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4525)
  });
  const runPromise = orchestrator.run(genericChatRequest(runId, "start-boundary"));
  await runEntered.promise;
  const terminalPromise = orchestrator.settleRunTerminal({
    runId,
    status: "completed",
    backendId: "start-boundary",
    text: "terminal injected after checkpoint"
  });
  releaseRun.resolve();

  const [result] = await Promise.all([runPromise, terminalPromise]);

  assert.equal(terminalCommittedAtInvocation, false);
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "terminal injected after checkpoint");
  assert.equal(result.backendBinding?.backendId, "start-boundary");
}

async function assertCommittedTerminalBeatsLateRunningAdapterResult(): Promise<void> {
  const runId = "runlane-terminal-beats-running";
  const runEntered = deferred<void>();
  const releaseRun = deferred<void>();
  const sinkStarted = deferred<void>();
  const releaseSink = deferred<void>();
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "late-running",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("late-running", "late-running-thread")
      },
      onRun: async () => {
        runEntered.resolve();
        await releaseRun.promise;
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4520)
  });

  const runPromise = orchestrator.run(genericChatRequest(runId, "late-running"));
  await runEntered.promise;
  const terminalSettlement = orchestrator.settleRunTerminal({
    runId,
    status: "completed",
    backendId: "late-running",
    text: "committed before adapter return"
  }, async () => {
    sinkStarted.resolve();
    await releaseSink.promise;
  });
  await sinkStarted.promise;
  releaseRun.resolve();

  const result = await runPromise;
  releaseSink.resolve();
  await terminalSettlement;
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "committed before adapter return");
  assert.equal(result.nativeExecution?.id, "late-running-thread");
  assert.equal(result.backendBinding?.nativeThreadId, "late-running-thread");
}

async function assertSameRunSinkReentryDoesNotDeadlock(): Promise<void> {
  const runId = "runlane-sink-reentry";
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4530)
  });

  const deliveryOrder: string[] = [];
  const terminalDelivered = deferred<void>();
  await orchestrator.appendRunEvent({
    runId,
    source: "agent",
    type: "agent.message.delta",
    text: "outer"
  }, async () => {
    deliveryOrder.push("outer:start");
    await Promise.resolve();
    await orchestrator.appendRunEvent({
      runId,
      source: "agent",
      type: "agent.message.completed",
      text: "inner"
    }, () => {
      deliveryOrder.push("inner");
    });
    deliveryOrder.push("outer:after-append");
    await orchestrator.settleRunTerminal({
      runId,
      status: "completed",
      text: "done"
    }, () => {
      deliveryOrder.push("terminal");
      terminalDelivered.resolve();
    });
    deliveryOrder.push("outer:end");
  });

  const outcome = await Promise.race([
    terminalDelivered.promise.then(() => "completed"),
    waitMs(50).then(() => "timeout")
  ]);

  assert.equal(outcome, "completed");
  assert.deepEqual(deliveryOrder, [
    "outer:start",
    "outer:after-append",
    "outer:end",
    "inner",
    "terminal"
  ]);
  const events = await ledger.readRun(runId);
  assert.deepEqual(events.map((event) => event.type), [
    "agent.message.delta",
    "agent.message.completed",
    "run.completed"
  ]);
}

async function assertSameRunDeliveryRemainsSerialWhileSinkIsPending(): Promise<void> {
  const runId = "runlane-independent-delivery-serialization";
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondDelivered = deferred<void>();
  let secondStarted = false;
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4535)
  });

  const first = orchestrator.appendRunEvent({
    runId,
    source: "agent",
    type: "agent.message.delta",
    text: "first"
  }, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const second = orchestrator.appendRunEvent({
    runId,
    source: "agent",
    type: "agent.message.delta",
    text: "second"
  }, () => {
    secondStarted = true;
    secondDelivered.resolve();
  });
  await second;
  assert.equal(secondStarted, false);

  releaseFirst.resolve();
  await Promise.all([first, secondDelivered.promise]);
}

async function assertFireAndForgetSinkThrowIsContained(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const orchestrator = new RunOrchestrator({
      adapters: [],
      ledger: new InMemoryRunLedger(),
      memoryProvider: new NoopMemoryProvider(),
      now: fixedClock(4537)
    });

    void orchestrator.appendRunEvent({
      runId: "runlane-fire-and-forget-sink-throw",
      source: "agent",
      type: "agent.message.delta",
      text: "committed"
    }, () => {
      throw new Error("fire-and-forget sink exploded");
    });

    await waitMs(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function assertTerminalCommitReleasesOwnerBeforeSinkDeliveryCompletes(): Promise<void> {
  const runId = "runlane-owner-release-before-delivery";
  const sinkStarted = deferred<void>();
  const releaseSink = deferred<void>();
  const cancelCalls: string[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "owner-release",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("owner-release", "owner-release-thread")
      },
      onCancel: async () => {
        cancelCalls.push("owner-release");
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4540)
  });

  const started = await orchestrator.run(genericChatRequest(runId, "owner-release"));
  assert.equal(started.status, "running");
  const terminalSettlement = orchestrator.settleRunTerminal({
    runId,
    status: "completed",
    backendId: "owner-release",
    text: "owner released at commit"
  }, async () => {
    sinkStarted.resolve();
    await releaseSink.promise;
  });
  await sinkStarted.promise;
  await orchestrator.cancel(runId);

  assert.deepEqual(cancelCalls, []);
  releaseSink.resolve();
  await terminalSettlement;
}

async function assertConcurrentTerminalSourcesResolveToFirstCommittedTerminal(): Promise<void> {
  const runId = "runlane-concurrent-terminal-sources";
  const sinkStarted = deferred<void>();
  const releaseSink = deferred<void>();
  let adapterEmit: HarnessEventSink | undefined;
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "terminal-race",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("terminal-race", "terminal-race-thread")
      },
      captureEmit: (emit) => {
        adapterEmit = emit;
      }
    })],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4550)
  });

  const started = await orchestrator.run(genericChatRequest(runId, "terminal-race"));
  assert.equal(started.status, "running");
  assert.ok(adapterEmit);

  const first = orchestrator.appendRunEvent({
    runId,
    source: "kernel",
    type: "run.completed",
    backendId: "terminal-race",
    text: "first terminal"
  }, async () => {
    sinkStarted.resolve();
    await releaseSink.promise;
  });
  await sinkStarted.promise;
  const second = orchestrator.settleRunTerminal({
    runId,
    status: "failed",
    backendId: "terminal-race",
    error: "late settle"
  });
  const third = adapterEmit({
    eventId: "adapter-terminal",
    runId,
    sequence: 999,
    createdAt: 4551,
    source: "agent",
    type: "run.cancelled",
    backendId: "terminal-race",
    error: "late adapter terminal"
  });

  const concurrentOutcome = await Promise.race([
    Promise.all([second, third]).then(() => "completed"),
    waitMs(50).then(() => "timeout")
  ]);

  assert.equal(concurrentOutcome, "completed");
  const lateSettlementTerminal = await second;
  assert.equal(lateSettlementTerminal.type, "run.completed");
  assert.equal(lateSettlementTerminal.backendId, "terminal-race");
  assert.equal(lateSettlementTerminal.text, "first terminal");
  assert.equal(lateSettlementTerminal.error, undefined);
  releaseSink.resolve();
  await first;

  const events = await ledger.readRun(runId);
  assert.equal(countTerminalEvents(events), 1);
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(events.map((event) => event.eventId), events.map((_, index) => `${runId}:${index + 1}`));
  assert.equal(events.at(-1)?.sequence, 7);
  assert.equal(events.at(-1)?.eventId, `${runId}:7`);
}

async function assertTerminalAllowsLifecycleButRejectsLateAgentEvents(): Promise<void> {
  const runId = "runlane-post-terminal-lifecycle";
  const ledger = new InMemoryRunLedger();
  const terminalDeliveryStarted = deferred<void>();
  const releaseTerminalDelivery = deferred<void>();
  const lifecycleDelivered = deferred<void>();
  const deliveredTypes: HarnessEventType[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4560)
  });

  await orchestrator.settleRunTerminal({
    runId,
    status: "completed",
    text: "authoritative terminal"
  }, async () => {
    terminalDeliveryStarted.resolve();
    await releaseTerminalDelivery.promise;
  });
  await terminalDeliveryStarted.promise;

  const lifecycleTypes: HarnessEventType[] = [
    "run.local_commit.started",
    "run.local_commit.completed",
    "run.local_commit.failed",
    "agent.native_cleanup.scheduled",
    "agent.native_cleanup.started",
    "agent.native_cleanup.completed",
    "agent.native_cleanup.unsupported",
    "agent.native_cleanup.failed",
    "agent.native_cleanup.retained"
  ];
  const lifecycleEvents = await Promise.all(lifecycleTypes.map((type) => orchestrator.appendRunEvent({
    runId,
    source: type.startsWith("run.") ? "workflow" : "agent",
    type
  }, (event) => {
    deliveredTypes.push(event.type);
    if (deliveredTypes.length === lifecycleTypes.length) lifecycleDelivered.resolve();
  })));
  assert.deepEqual(lifecycleEvents.map((event) => event.type), lifecycleTypes);
  assert.deepEqual(deliveredTypes, []);

  const rejectedTypes: HarnessEventType[] = [
    "agent.message.delta",
    "agent.reasoning.started",
    "agent.plan.updated",
    "tool.started",
    "file.change.applied"
  ];
  const rejectedEvents = await Promise.all(rejectedTypes.map((type) => orchestrator.appendRunEvent({
    runId,
    source: type.startsWith("tool.") ? "tool" : "agent",
    type,
    text: "must be rejected"
  })));
  const secondTerminal = await orchestrator.appendRunEvent({
    runId,
    source: "kernel",
    type: "run.failed",
    error: "must not replace terminal"
  });

  releaseTerminalDelivery.resolve();
  const deliveryOutcome = await Promise.race([
    lifecycleDelivered.promise.then(() => "completed"),
    waitMs(50).then(() => "timeout")
  ]);

  const events = await ledger.readRun(runId);
  assert.equal(deliveryOutcome, "completed");
  assert.deepEqual(deliveredTypes, lifecycleTypes);
  assert.ok(rejectedEvents.every((event) => event.type === "run.completed"));
  assert.equal(secondTerminal.type, "run.completed");
  assert.deepEqual(events.map((event) => event.type), ["run.completed", ...lifecycleTypes]);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(events.map((event) => event.eventId), events.map((_, index) => `${runId}:${index + 1}`));
}

async function assertTerminalRunsRecycleLanes(): Promise<void> {
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4570)
  });

  await Promise.all(Array.from({ length: 64 }, (_, index) => orchestrator.settleRunTerminal({
    runId: `runlane-recycled-${index}`,
    status: "completed"
  })));

  assert.equal(inspectRunLanes(orchestrator).size, 0);
}

async function assertCancelTargetsOnlyOwningAdapter(): Promise<void> {
  const calls: string[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [
      createStaticAdapter({
        backendId: "owner",
        result: {
          status: "running",
          nativeExecution: nativeThreadExecution("owner", "owner-thread")
        },
        onCancel: async () => {
          calls.push("owner");
        }
      }),
      createStaticAdapter({
        backendId: "other",
        result: {
          status: "running",
          nativeExecution: nativeThreadExecution("other", "other-thread")
        },
        onCancel: async () => {
          calls.push("other");
        }
      })
    ],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(5000)
  });

  await orchestrator.run(genericChatRequest("run-cancel-owner", "owner"));
  await orchestrator.cancel("run-cancel-owner");

  assert.deepEqual(calls, ["owner"]);
}

async function assertCancelBeforeAdapterRunSettlesCancelledWithoutInvokingAdapterRun(): Promise<void> {
  const runId = "run-cancel-before-adapter-run";
  const retrieveStarted = deferred<void>();
  const releaseRetrieve = deferred<void>();
  let runCalls = 0;
  const events: HarnessEvent[] = [];
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [{
      manifest: {
        id: "pre-run",
        displayName: "pre-run",
        version: "test",
        capabilities: {
          ...noCapabilities(),
          sessions: { resume: "emulated", fork: "none" },
          output: { streaming: "emulated", reasoningSummary: "none", thinkingTrace: "none", planEvents: "none", usage: "none" },
          input: { text: "native", image: "none", pdf: "none" },
          cancellation: "emulated"
        }
      },
      async connect(): Promise<AgentConnectionStatus> {
        return { connected: true, label: "pre-run", version: "test", errors: [] };
      },
      async dispose(): Promise<void> {
        return undefined;
      },
      async listModels(): Promise<Array<{ id: string; displayName: string }>> {
        return [];
      },
      async run(): Promise<AgentRunResult> {
        runCalls += 1;
        return {
          status: "running",
          nativeExecution: nativeThreadExecution("pre-run", "pre-run-thread")
        };
      },
      async cancel(): Promise<void> {
        return undefined;
      }
    }],
    ledger,
    memoryProvider: stalledMemoryProvider(retrieveStarted, releaseRetrieve),
    now: fixedClock(5050)
  });

  const runPromise = orchestrator.run(genericChatRequest(runId, "pre-run"), (event) => {
    events.push(event);
  });

  await retrieveStarted.promise;
  await orchestrator.cancel(runId);
  releaseRetrieve.resolve();

  const result = await runPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(runCalls, 0);

  const recorded = await ledger.readRun(runId);
  assert.deepEqual(recorded.map((event) => event.type), [
    "run.created",
    "run.started",
    "agent.connecting",
    "agent.connected",
    "run.cancelled"
  ]);
  assert.equal(countTerminalEvents(recorded), 1);
  assert.equal(events.at(-1)?.type, "run.cancelled");
}

async function assertExternalSettlementRacingPreRunCancellationHasOneTerminal(): Promise<void> {
  const runId = "run-external-settle-pre-run-cancel-race";
  const retrieveStarted = deferred<void>();
  const releaseRetrieve = deferred<void>();
  const terminalAppendStarted = deferred<void>();
  const releaseTerminalAppend = deferred<void>();
  const backingLedger = new InMemoryRunLedger();
  let terminalAppendCalls = 0;
  let runCalls = 0;
  const sinkEvents: HarnessEvent[] = [];
  const ledger: RunLedger = {
    async append(event) {
      if (isTerminalEvent(event)) {
        terminalAppendCalls += 1;
        if (terminalAppendCalls === 1) {
          terminalAppendStarted.resolve();
          await releaseTerminalAppend.promise;
        }
      }
      await backingLedger.append(event);
    },
    async readRun(targetRunId) {
      return await backingLedger.readRun(targetRunId);
    }
  };
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "pre-run-race",
      result: { status: "running" },
      onRun: () => {
        runCalls += 1;
      }
    })],
    ledger,
    memoryProvider: stalledMemoryProvider(retrieveStarted, releaseRetrieve),
    now: fixedClock(5060)
  });
  const sink = (event: HarnessEvent): void => {
    sinkEvents.push(event);
  };

  const runPromise = orchestrator.run(genericChatRequest(runId, "pre-run-race"), sink);
  await retrieveStarted.promise;
  await orchestrator.cancel(runId);
  const externalSettlement = orchestrator.settleRunTerminal({
    runId,
    status: "cancelled",
    backendId: "pre-run-race",
    error: "用户中断"
  }, sink);
  await terminalAppendStarted.promise;

  releaseRetrieve.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseTerminalAppend.resolve();

  const [result] = await Promise.all([runPromise, externalSettlement]);
  const recorded = await backingLedger.readRun(runId);
  assert.equal(result.status, "cancelled");
  assert.equal(runCalls, 0);
  assert.equal(countTerminalEvents(recorded), 1);
  assert.deepEqual(recorded.map((event) => event.sequence), recorded.map((_, index) => index + 1));
  assert.equal(sinkEvents.filter(isTerminalEvent).length, 1);
}

async function assertExternalSettlementBeforeCancellationCheckSkipsAdapterRun(): Promise<void> {
  const runId = "run-external-settle-before-cancel-check";
  const retrieveStarted = deferred<void>();
  const releaseRetrieve = deferred<void>();
  const ledger = new InMemoryRunLedger();
  let runCalls = 0;
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "pre-run-settled",
      result: { status: "running" },
      onRun: () => {
        runCalls += 1;
      }
    })],
    ledger,
    memoryProvider: stalledMemoryProvider(retrieveStarted, releaseRetrieve),
    now: fixedClock(5065)
  });

  const runPromise = orchestrator.run(genericChatRequest(runId, "pre-run-settled"));
  await retrieveStarted.promise;
  await orchestrator.cancel(runId);
  await orchestrator.settleRunTerminal({
    runId,
    status: "cancelled",
    backendId: "pre-run-settled",
    error: "用户中断"
  });
  releaseRetrieve.resolve();

  const result = await runPromise;
  const recorded = await ledger.readRun(runId);
  assert.equal(result.status, "cancelled");
  assert.equal(runCalls, 0);
  assert.equal(countTerminalEvents(recorded), 1);
  assert.deepEqual(recorded.map((event) => event.sequence), recorded.map((_, index) => index + 1));
}

async function assertCancelDuringAdapterRunStillForwardsToOwner(): Promise<void> {
  const runId = "run-cancel-during-adapter-run";
  const runEntered = deferred<void>();
  const cancelObserved = deferred<void>();
  const calls: string[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [{
      manifest: {
        id: "owner-forward",
        displayName: "owner-forward",
        version: "test",
        capabilities: {
          ...noCapabilities(),
          sessions: { resume: "emulated", fork: "none" },
          output: { streaming: "emulated", reasoningSummary: "none", thinkingTrace: "none", planEvents: "none", usage: "none" },
          input: { text: "native", image: "none", pdf: "none" },
          cancellation: "emulated"
        }
      },
      async connect(): Promise<AgentConnectionStatus> {
        return { connected: true, label: "owner-forward", version: "test", errors: [] };
      },
      async dispose(): Promise<void> {
        return undefined;
      },
      async listModels(): Promise<Array<{ id: string; displayName: string }>> {
        return [];
      },
      async run(): Promise<AgentRunResult> {
        runEntered.resolve();
        await cancelObserved.promise;
        return { status: "cancelled", error: "owner stopped" };
      },
      async cancel(): Promise<void> {
        calls.push("owner-forward");
        cancelObserved.resolve();
      }
    }],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(5075)
  });

  const runPromise = orchestrator.run(genericChatRequest(runId, "owner-forward"));
  await runEntered.promise;
  await orchestrator.cancel(runId);
  const result = await runPromise;

  assert.deepEqual(calls, ["owner-forward"]);
  assert.equal(result.status, "cancelled");
}

async function assertCancelDuringRejectingAdapterRunWritesOneCancelledTerminal(): Promise<void> {
  const runId = "run-cancel-rejecting-adapter";
  const runEntered = deferred<void>();
  const rejectRun = deferred<AgentRunResult>();
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [{
      manifest: {
        id: "rejecting-owner",
        displayName: "rejecting-owner",
        version: "test",
        capabilities: {
          ...noCapabilities(),
          sessions: { resume: "emulated", fork: "none" },
          output: { streaming: "emulated", reasoningSummary: "none", thinkingTrace: "none", planEvents: "none", usage: "none" },
          input: { text: "native", image: "none", pdf: "none" },
          cancellation: "emulated"
        }
      },
      async connect(): Promise<AgentConnectionStatus> {
        return { connected: true, label: "rejecting-owner", version: "test", errors: [] };
      },
      async dispose(): Promise<void> {
        return undefined;
      },
      async listModels(): Promise<Array<{ id: string; displayName: string }>> {
        return [];
      },
      async run(): Promise<AgentRunResult> {
        runEntered.resolve();
        return await rejectRun.promise;
      },
      async cancel(): Promise<void> {
        rejectRun.reject(new Error("Agent task aborted before native id"));
      }
    }],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(5080)
  });

  const runPromise = orchestrator.run(genericChatRequest(runId, "rejecting-owner"));
  await runEntered.promise;
  await orchestrator.cancel(runId);
  const result = await runPromise;
  const events = await ledger.readRun(runId);

  assert.equal(result.status, "cancelled");
  assert.equal(events.at(-1)?.type, "run.cancelled");
  assert.equal(countTerminalEvents(events), 1);
}

async function assertCancelOwnerReleasedAfterSynchronousTerminal(): Promise<void> {
  const calls: string[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "sync-owner",
      result: { status: "completed", outputText: "done" },
      onCancel: async () => {
        calls.push("sync-owner");
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(5100)
  });

  const result = await orchestrator.run(genericChatRequest("run-sync-owner-release", "sync-owner"));
  assert.equal(result.status, "completed");
  await orchestrator.cancel("run-sync-owner-release");

  assert.deepEqual(calls, []);
}

async function assertCancelOwnerReleasedAfterAsyncSettlement(): Promise<void> {
  const calls: string[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [createStaticAdapter({
      backendId: "async-owner",
      result: {
        status: "running",
        nativeExecution: nativeThreadExecution("async-owner", "async-thread")
      },
      onCancel: async () => {
        calls.push("async-owner");
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(5200)
  });

  const result = await orchestrator.run(genericChatRequest("run-async-owner-release", "async-owner"));
  assert.equal(result.status, "running");
  await orchestrator.settleRunTerminal({
    runId: "run-async-owner-release",
    status: "completed",
    backendId: "async-owner",
    text: "done"
  });
  await orchestrator.cancel("run-async-owner-release");

  assert.deepEqual(calls, []);
}

async function runSynchronousCompletionTypes(runId: string, backendId: string, adapter: AgentAdapter): Promise<string[]> {
  const events: HarnessEvent[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(4000)
  });

  const result = await orchestrator.run(genericChatRequest(runId, backendId), (event) => {
    events.push(event);
  });

  assert.equal(result.status, "completed");
  return events.map((event) => event.type);
}

function createStaticAdapter(input: {
  backendId: string;
  result: AgentRunResult;
  emittedEvents?: Array<Pick<HarnessEvent, "type"> & Partial<HarnessEvent>>;
  onCancel?: () => Promise<void> | void;
  onRun?: () => Promise<void> | void;
  captureEmit?: (emit: HarnessEventSink) => void;
}): AgentAdapter {
  return {
    manifest: {
      id: input.backendId,
      displayName: input.backendId,
      version: "test",
      capabilities: {
        ...noCapabilities(),
        sessions: { resume: "emulated", fork: "none" },
        output: { streaming: "emulated", reasoningSummary: "none", thinkingTrace: "none", planEvents: "none", usage: "none" },
        input: { text: "native", image: "none", pdf: "none" },
        cancellation: "emulated"
      }
    },
    async connect(): Promise<AgentConnectionStatus> {
      return { connected: true, label: input.backendId, version: "test", errors: [] };
    },
    async dispose(): Promise<void> {
      return undefined;
    },
    async listModels(): Promise<Array<{ id: string; displayName: string }>> {
      return [];
    },
    async run(_request: AgentRunRequest, emit: HarnessEventSink): Promise<AgentRunResult> {
      await input.onRun?.();
      input.captureEmit?.(emit);
      for (const event of input.emittedEvents ?? []) {
        await emit({
          eventId: "",
          runId: "",
          sequence: 0,
          createdAt: 0,
          source: event.source ?? "agent",
          type: event.type,
          backendId: event.backendId ?? input.backendId,
          text: event.text,
          title: event.title,
          status: event.status,
          toolName: event.toolName,
          resourceId: event.resourceId,
          error: event.error,
          data: event.data
        });
      }
      return input.result;
    },
    async cancel(): Promise<void> {
      await input.onCancel?.();
    }
  };
}

function createLegacyRuntime(
  backendId: "opencode" | "hermes",
  nativeRunId: string,
  text: string
): AgentTaskRuntime {
  return {
    kind: backendId,
    async connect(): Promise<AgentConnectionStatus> {
      return {
        connected: true,
        label: backendId === "opencode" ? "OpenCode" : "Hermes",
        errors: []
      };
    },
    async listModels() {
      return [];
    },
    async runTask() {
      return { text, runId: nativeRunId };
    },
    async abort(): Promise<void> {
      return undefined;
    }
  };
}

function genericChatRequest(runId: string, backendId: string): HarnessRunRequest {
  return {
    runId,
    sessionId: `session-${runId}`,
    surface: "chat",
    workflow: "chat.generic",
    backendId,
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: true, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  };
}

function nativeThreadExecution(backendId: string, id: string): NativeExecutionRef {
  return {
    backendId,
    id,
    kind: "thread",
    persistence: "provider-persistent",
    deviceKey: "local",
    vaultId: "/vault",
    createdAt: 1
  };
}

function countTerminalEvents(events: HarnessEvent[]): number {
  return events.filter(isTerminalEvent).length;
}

function isTerminalEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
}

function inspectRunLanes(orchestrator: RunOrchestrator): Map<string, { commitTail: Promise<void> }> {
  return (orchestrator as unknown as {
    runLanes: Map<string, { commitTail: Promise<void> }>;
  }).runLanes;
}

function fixedClock(value: number): () => number {
  return () => value;
}

function stalledMemoryProvider(started: Deferred<void>, release: Deferred<void>): MemoryProvider {
  return {
    async retrieve() {
      started.resolve();
      await release.promise;
      return { providerId: "noop", items: [], sections: [] };
    },
    async propose() {
      return [];
    },
    async commit() {
      return { committed: [], skipped: [] };
    },
    async supersede() {
      return undefined;
    }
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
