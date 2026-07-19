import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DEFAULT_SETTINGS, type StoredSession } from "../../settings/settings";
import type {
  AgentAdapter,
  AgentConnectionStatus,
  AgentRunRequest,
  AgentRunResult
} from "../../harness/agents/adapter";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../../harness/agents/adapters/codex-rich-notification-hub";
import { noCapabilities } from "../../harness/contracts/capability";
import type { HarnessEvent, HarnessEventSink } from "../../harness/contracts/event";
import type {
  NativeExecutionRecord,
  NativeExecutionRef
} from "../../harness/contracts/native-execution";
import type { HarnessRunRequest } from "../../harness/contracts/run";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import {
  updateSessionBackendBinding,
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import { InMemoryRunLedger, type RunLedger } from "../../harness/ledger/run-ledger";
import { FileConversationStore } from "../../harness/conversation/conversation-store";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { emptyContextBundle } from "../../harness/contracts/context";
import type { SettleNativeExecutionInput } from "../../harness/native/native-execution-manager";
import { EchoInkHarnessService } from "../../plugin/harness-service";
import { EchoInkSettingsStore } from "../../plugin/settings-store";
import { RuntimeTurnQueue } from "../../ui/turn-queue";
import { CodexView } from "../../ui/codex-view";
import { CodexNotificationRouter } from "../../ui/codex-view/notification-router";
import {
  afterTurnSettled,
  startChatTurn,
  startKnowledgeBaseTurn,
  startNextQueuedTurn,
  startQueuedTurnItem,
  startQueuedTurnItemSafely
} from "../../ui/codex-view/turn-runner";
import {
  armTurnWatchdog,
  chatSurfaceTerminalClaim,
  claimChatSurfaceTerminal,
  persistAndSettleChatRun,
  prepareChatSurfaceTerminal,
  recordIgnoredLateChatTerminal,
  stopTurn
} from "../../ui/codex-view/turn-lifecycle";
import {
  applyChatRunTerminalWinner,
  echoInkChatTerminalRawRef,
  recoverStaleChatHarnessRuns,
  recoverStaleHarnessRuns
} from "../../core/message-state";
import { pluginDataDir, prepareRawMessage } from "../../core/raw-message-store";
import { KnowledgeBaseAgentTaskService } from "../../knowledge-base/agent-task-service";

export async function runHarnessV2SurfaceRunSettlementTests(): Promise<void> {
  await assertChatTerminalPersistsHistoryBeforeLedger();
  await assertChatTerminalRequiresConversationMarker();
  await assertLiveCommitProjectsExistingDurableWinner();
  await assertDurableConversationWinnerRejectsSameStatusPayloadReplacement();
  await assertConcurrentDurableConversationWinnerSurvivesLedgerFailure();
  await assertLargeDurableWinnerUsesImmutableRawIdentity();
  await assertRestartRejectsNonCommitAddressedRawAuthority();
  await assertRestartRetainsMissingRawAuthorityForRecovery();
  await assertTerminalDataRejectsNonPersistableValues();
  await assertConversationMarkerRollsBackWhenSaveFails();
  await assertConversationMarkerRollsForwardAfterDataSaveFails();
  await assertConversationReadbackFailurePreservesTerminalCandidate();
  await assertTerminalMarkerClearRollsBackWhenSaveFails();
  await assertTerminalMarkerClearStaysClearedAfterDataSaveFails();
  await assertClearReadbackFailurePreservesClearedCandidate();
  await assertServiceOwnedSynchronousChatTerminalsWaitForConversationCommit();
  await assertTerminalGateFailureDoesNotRewriteBusinessWinner();
  await assertChatNativeReceiptRegistrationBeforeIntent();
  await assertChatNativeReceiptIntentBeforeRegistration();
  await assertChatNativeReceiptIdentityAndIntentConflictsFailClosed();
  await assertChatNativeSettlementFailureRemainsRetryable();
  await assertLedgerFailureRecoversSameWinnerAfterRestart();
  await assertLiveNativeSettlementExhaustionRecoversAfterRestart();
  await assertSynchronousChatConversationCommitFailureRetainsNative();
  await assertSynchronousChatLedgerCommitFailureRetainsNative();
  await assertChatStopCommitsCancellationTerminal();
  await assertChatStopUsesActualBackend();
  await assertChatStopPropagatesCancelFailureAndAllowsRetry();
  await assertChatStopBeforeNativeRegistrationRetainsRecoveryEvidence();
  await assertChatStopIgnoresLateCompletedTerminal();
  await assertChatWatchdogSettlesNativeAfterDurableCommit();
  await assertChatWatchdogBeforeNativeRegistrationRetainsRecoveryEvidence();
  await assertChatWatchdogIgnoresLateFailedTerminal();
  await assertLateChatTerminalAuditRetriesAfterAppendFailure();
  await assertLateChatTerminalAuditWaitsForTimerTransient();
  await assertLateChatTerminalAuditCanRetryAfterBoundedExhaustion();
  await assertConcurrentLateChatTerminalAuditsAppendExactlyOnce();
  await assertChatNativeSettlementWaitsForTimerTransient();
  await assertKnowledgeStopDelegatesToManager();
  await assertKnowledgeStopDoesNotPauseAfterCommitLock();
  await assertKnowledgeTurnSettlesNativeBeforePostRunSaveFailure();
  await assertKnowledgeCleanupFailureDoesNotFailCompletedTurn();
  await assertKnowledgeUnloadWaitsForActiveRunSettlement();
  await assertEditorStopUsesHarnessCancel();
  await assertEditorStopPropagatesCancelFailureAndAllowsRetry();
  await assertKnowledgeWatchdogUsesHarnessCancel();
  await assertCodexChatProcessEventsRenderThroughHarnessSink();
  await assertQueuedCodexChatSettlesViaAwaitResultAndAdvancesQueue();
  await assertLateRunScopedNotificationsDoNotPolluteNextRunView();
  await assertUsageNotificationsReachDriverWithoutConsumingViewRoute();
  await assertUsageAndCompactionOnlyUpdateMatchingSessionThread();
  await assertViewCloseCancelsActiveRunDuringReload();
  await assertViewClosePreservesExistingAdapterWinner();
  await assertPromptEnhancerPreStartViewCloseAbortsWithoutCancelIntent();
  await assertViewCloseCancellationWinsLateAsyncCompletion();
  await assertViewCloseBeforeNativeRegistrationKeepsIntentRecoverable();
  await assertViewCloseDisposesRendererWhenRecoveryFails();
  await assertReloadChatRecoveryUsesCentralTerminalAndRetries();
  await assertReloadProjectsDurableTerminalWinnerBeforeConversationSave();
  await assertReloadRecoveryCommitsLocalHistoryBeforeLedgerTerminal();
  await assertReloadRecoveryKeepsTerminalPendingWhenLocalCommitFails();
  await assertReloadRecoveryRetriesFailedLedgerTerminal();
  await assertReloadRecoveryBackfillsLegacyInterruptedRunOnce();
  await assertEachSurfaceHasOneTerminalOwner();
}

async function assertCodexChatProcessEventsRenderThroughHarnessSink(): Promise<void> {
  const session: StoredSession = {
    id: "session-chat-process",
    title: "Chat process",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-chat-process",
    turnId: "turn-chat-process",
    text: "最终答案",
    autoComplete: false
  }]);

  const outcome = await startChatTurn(harness.view, session, queuedTurn("chat-process", session.id, "请检查"), "composer");
  assert.equal(outcome, "running");
  assert.deepEqual(harness.startedThreads, ["thread-chat-process"], "a real user Turn must create its Codex thread through the adapter");

  harness.notificationHub.dispatch({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread-chat-process", turnId: "turn-chat-process", itemId: "reasoning-1", delta: "正在分析" }
  } as any);
  harness.notificationHub.dispatch({
    method: "item/started",
    params: {
      threadId: "thread-chat-process",
      turnId: "turn-chat-process",
      item: { id: "command-1", threadId: "thread-chat-process", turnId: "turn-chat-process", type: "commandExecution", command: "rg target" }
    }
  } as any);
  harness.notificationHub.dispatch({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-chat-process", turnId: "turn-chat-process", itemId: "command-1", delta: "match.ts:1" }
  } as any);

  await waitFor(() => session.messages.some((message) => message.itemType === "reasoning")
    && session.messages.some((message) => message.itemType === "commandExecution"));
  assert.equal(session.messages.find((message) => message.role === "assistant" && message.itemType === "assistant")?.status, "running");
  assert.match(session.messages.find((message) => message.itemType === "reasoning")?.text ?? "", /正在分析/);
  assert.match(session.messages.find((message) => message.itemType === "commandExecution")?.text ?? "", /match\.ts:1/);
  assert.ok(harness.renderedSnapshots.some((messages) => messages.some((message) => message.itemType === "reasoning")));

  harness.notificationHub.dispatch({
    method: "item/completed",
    params: { item: { id: "assistant-turn-chat-process", threadId: "thread-chat-process", turnId: "turn-chat-process", type: "agentMessage", text: "最终答案" } }
  } as any);
  harness.notificationHub.dispatch({
    method: "turn/completed",
    params: { threadId: "thread-chat-process", turn: { id: "turn-chat-process", threadId: "thread-chat-process", status: "completed" } }
  } as any);
  await waitFor(() => harness.view.running === false);
}

async function assertChatTerminalPersistsHistoryBeforeLedger(): Promise<void> {
  const calls: string[] = [];
  const plugin: any = {
    settings: {
      sessions: [{
        messages: [{
          id: "run-chat-order-answer",
          role: "assistant",
          itemType: "assistant",
          status: "completed",
          text: "done",
          runId: "run-chat-order",
          createdAt: 1
        }]
      }]
    },
    saveSettings: async () => { calls.push("history"); },
    agentRuntimeHealth: {
      reportHealthy: () => undefined,
      reportFailure: () => undefined
    }
  };
  const service = new EchoInkHarnessService(plugin);
  (service as any).getHarnessKernel = () => ({
    commitSurfaceRunTerminal: async (
      _input: unknown,
      beforeTerminalCommit: (winner: HarnessEvent) => Promise<void>
    ) => {
      const winner = terminalEvent(
        "run-chat-order",
        "completed",
        "codex-cli"
      );
      await beforeTerminalCommit(winner);
      calls.push("ledger");
      return winner;
    }
  });
  plugin.commitChatSurfaceTerminal = async (input: any) =>
    await service.commitChatSurfaceTerminal(input);

  await persistAndSettleChatRun(
    plugin,
    { runId: "run-chat-order", status: "completed", backendId: "codex-cli" }
  );
  assert.deepEqual(calls, ["history", "ledger"]);
}

async function assertChatTerminalRequiresConversationMarker(): Promise<void> {
  const harness = createServiceReceiptTestBed({
    sessionId: "session-chat-terminal-without-marker"
  });

  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal({
      runId: "run-chat-terminal-without-marker",
      status: "completed",
      backendId: "codex-cli",
      text: "orphaned"
    }),
    /requires a Conversation marker/
  );

  assert.equal(harness.saveCalls.length, 0);
  assert.equal(
    terminalEvents(
      await harness.ledger.readRun("run-chat-terminal-without-marker")
    ).length,
    0
  );
  assert.equal(harness.nativeManager.settlementAttempts.length, 0);
}

async function assertLiveCommitProjectsExistingDurableWinner(): Promise<void> {
  const runId = "run-live-existing-durable-winner";
  const session: StoredSession = {
    id: "session-live-existing-durable-winner",
    title: "Existing durable winner",
    cwd: "/vault",
    messages: [{
      id: "existing-winner-answer",
      role: "assistant",
      itemType: "assistant",
      status: "completed",
      text: "requested completed answer",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const ledger = new InMemoryRunLedger();
  await ledger.append(terminalEvent(runId, "cancelled", "codex-cli"));
  const harness = createServiceReceiptTestBed({
    sessionId: session.id,
    session,
    ledger
  });

  await harness.service.commitChatSurfaceTerminal({
    runId,
    status: "completed",
    backendId: "codex-cli",
    text: "requested completed answer"
  });

  assert.equal(session.messages[0]?.status, "interrupted");
  assert.equal(session.messages[0]?.title, "已中断");
  assert.equal(
    session.messages[0]?.runTerminalRecoveryPending,
    "cancelled"
  );
  const terminals = terminalEvents(await ledger.readRun(runId));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.type, "run.cancelled");
  assert.equal(harness.nativeManager.settlementAttempts.length, 0);

  const completedRunId = "run-live-existing-completed-payload-winner";
  const completedSession: StoredSession = {
    id: "session-live-existing-completed-payload-winner",
    title: "Existing durable completed payload winner",
    cwd: "/vault",
    messages: [{
      id: "existing-completed-payload-answer",
      role: "assistant",
      itemType: "assistant",
      status: "completed",
      text: "late completed answer",
      runId: completedRunId,
      backendId: "codex-cli",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const completedLedger = new InMemoryRunLedger();
  await completedLedger.append({
    ...terminalEvent(completedRunId, "completed", "codex-cli"),
    text: "durable completed answer"
  });
  const completedHarness = createServiceReceiptTestBed({
    sessionId: completedSession.id,
    session: completedSession,
    ledger: completedLedger
  });

  await completedHarness.service.commitChatSurfaceTerminal({
    runId: completedRunId,
    status: "completed",
    backendId: "codex-cli",
    text: "late completed answer"
  });

  assert.equal(
    completedSession.messages[0]?.text,
    "durable completed answer",
    "Conversation must project the durable Ledger payload even when the status matches"
  );
  assert.equal(
    completedSession.messages[0]?.runTerminalRecoveryPending,
    "completed"
  );
  assert.equal(
    terminalEvents(await completedLedger.readRun(completedRunId)).length,
    1
  );
}

async function assertDurableConversationWinnerRejectsSameStatusPayloadReplacement(): Promise<void> {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const runId = `run-durable-authority-${status}`;
    const answer: any = {
      id: `answer-durable-authority-${status}`,
      role: "assistant",
      itemType: "assistant",
      status: "running",
      text: "",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    };
    const session: StoredSession = {
      id: `session-durable-authority-${status}`,
      title: `Durable authority ${status}`,
      cwd: "/vault",
      messages: [answer],
      createdAt: 1,
      updatedAt: 1
    };
    const backingLedger = new InMemoryRunLedger();
    let terminalAppendFailures = 1;
    const ledger: RunLedger = {
      async append(event) {
        if (isTerminalHarnessEvent(event) && terminalAppendFailures > 0) {
          terminalAppendFailures -= 1;
          throw new Error("Run Ledger unavailable");
        }
        await backingLedger.append(event);
      },
      async readRun(targetRunId) {
        return await backingLedger.readRun(targetRunId);
      }
    };
    const harness = createServiceReceiptTestBed({
      sessionId: session.id,
      session,
      ledger
    });
    const winnerPayload = {
      runId,
      status,
      backendId: "codex-cli",
      ...(status === "completed"
        ? { text: `winner-${status}` }
        : { error: `winner-${status}` }),
      data: {
        authority: "winner-a",
        nested: { order: 1, values: ["alpha", "beta"] }
      }
    } as const;

    await assert.rejects(
      () => harness.service.commitChatSurfaceTerminal(winnerPayload),
      /Run Ledger unavailable/
    );
    const durableMarker = structuredClone(
      answer.echoInkRunTerminalRecovery
    );
    assert.equal(
      durableMarker?.namespace,
      "echoink.chat-terminal"
    );
    assert.equal(durableMarker?.status, status);
    assert.equal(durableMarker?.backendId, "codex-cli");
    assert.deepEqual(
      durableMarker?.data,
      winnerPayload.data
    );
    assert.equal(terminalEvents(await backingLedger.readRun(runId)).length, 0);

    answer.text = `loser-${status}`;
    answer.backendId = "opencode";
    answer.status = status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : "interrupted";
    await harness.service.commitChatSurfaceTerminal({
      runId,
      status,
      backendId: "opencode",
      ...(status === "completed"
        ? { text: `loser-${status}` }
        : { error: `loser-${status}` }),
      data: {
        authority: "loser-b",
        nested: { order: 2, values: ["wrong"] }
      }
    });

    const [terminal] = terminalEvents(await backingLedger.readRun(runId));
    assert.ok(terminal);
    assert.equal(terminal.backendId, "codex-cli");
    assert.equal(
      status === "completed" ? terminal.text : terminal.error,
      `winner-${status}`
    );
    assert.deepEqual(terminal.data, winnerPayload.data);
    assert.equal(answer.text, `winner-${status}`);
    assert.equal(answer.backendId, "codex-cli");
    assert.deepEqual(
      answer.echoInkRunTerminalRecovery,
      durableMarker,
      "a retry may heal the missing Ledger terminal but cannot replace the durable Conversation authority"
    );
  }
}

async function assertConcurrentDurableConversationWinnerSurvivesLedgerFailure(): Promise<void> {
  for (const loserStatus of ["completed", "failed", "cancelled"] as const) {
    const runId = `run-concurrent-durable-authority-${loserStatus}`;
    const answer: any = {
      id: `answer-concurrent-durable-authority-${loserStatus}`,
      role: "assistant",
      itemType: "assistant",
      status: "running",
      text: "",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    };
    const session: StoredSession = {
      id: `session-concurrent-durable-authority-${loserStatus}`,
      title: `Concurrent durable authority ${loserStatus}`,
      cwd: "/vault",
      messages: [answer],
      createdAt: 1,
      updatedAt: 1
    };
    const backingLedger = new InMemoryRunLedger();
    const firstTerminalAppendEntered = deferred();
    const releaseFirstTerminalAppend = deferred();
    let terminalAppendAttempts = 0;
    const ledger: RunLedger = {
      async append(event) {
        if (isTerminalHarnessEvent(event)) {
          terminalAppendAttempts += 1;
          if (terminalAppendAttempts === 1) {
            firstTerminalAppendEntered.resolve();
            await releaseFirstTerminalAppend.promise;
            throw new Error("Run Ledger unavailable");
          }
        }
        await backingLedger.append(event);
      },
      async readRun(targetRunId) {
        return await backingLedger.readRun(targetRunId);
      }
    };
    const harness = createServiceReceiptTestBed({
      sessionId: session.id,
      session,
      ledger
    });
    const winner = {
      runId,
      status: "completed" as const,
      backendId: "codex-cli",
      text: `winner-completed-${loserStatus}`,
      data: {
        authority: "winner-a",
        nested: { order: 1, values: ["alpha", "beta"] }
      }
    };
    const loser = {
      runId,
      status: loserStatus,
      backendId: "opencode",
      ...(loserStatus === "completed"
        ? { text: `loser-completed-${loserStatus}` }
        : { error: `loser-${loserStatus}` }),
      data: {
        authority: "loser-b",
        nested: { order: 2, values: ["wrong"] }
      }
    };

    const winnerCommit = harness.service.commitChatSurfaceTerminal(winner);
    const loserCommit = harness.service.commitChatSurfaceTerminal(loser);
    await firstTerminalAppendEntered.promise;
    releaseFirstTerminalAppend.resolve();
    const [winnerResult, loserResult] = await Promise.allSettled([
      winnerCommit,
      loserCommit
    ]);

    assert.equal(winnerResult.status, "rejected");
    if (winnerResult.status === "rejected") {
      assert.match(String(winnerResult.reason), /Run Ledger unavailable/);
    }
    assert.equal(loserResult.status, "fulfilled");
    const [terminal] = terminalEvents(await backingLedger.readRun(runId));
    assert.ok(terminal);
    assert.equal(terminal.type, "run.completed");
    assert.equal(terminal.backendId, winner.backendId);
    assert.equal(terminal.text, winner.text);
    assert.deepEqual(terminal.data, winner.data);
    assert.equal(answer.status, "completed");
    assert.equal(answer.backendId, winner.backendId);
    assert.equal(answer.text, winner.text);
    assert.equal(answer.runTerminalRecoveryPending, "completed");
    assert.deepEqual(
      answer.echoInkRunTerminalRecovery?.data,
      winner.data
    );
    assert.equal(
      (harness.service as any).chatTerminalAuthorityTails.size,
      0,
      "the per-run authority lane must be reclaimed after the queued retry"
    );
  }
}

async function assertLargeDurableWinnerUsesImmutableRawIdentity(): Promise<void> {
  const runId = "run-large-durable-authority";
  const answer: any = {
    id: "answer-large-durable-authority",
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "",
    runId,
    backendId: "codex-cli",
    createdAt: 1
  };
  const session: StoredSession = {
    id: "session-large-durable-authority",
    title: "Large durable authority",
    cwd: "/vault",
    messages: [answer],
    createdAt: 1,
    updatedAt: 1
  };
  const rawTexts = new Map<string, string>();
  const backingLedger = new InMemoryRunLedger();
  let terminalAppendFailures = 1;
  const ledger: RunLedger = {
    async append(event) {
      if (isTerminalHarnessEvent(event) && terminalAppendFailures > 0) {
        terminalAppendFailures -= 1;
        throw new Error("Run Ledger unavailable");
      }
      await backingLedger.append(event);
    },
    async readRun(targetRunId) {
      return await backingLedger.readRun(targetRunId);
    }
  };
  const harness = createServiceReceiptTestBed({
    sessionId: session.id,
    session,
    ledger,
    rawTexts
  });
  const winnerText = `winner-a:${"A".repeat(90_000)}`;
  const loserText = `loser-b:${"B".repeat(90_000)}`;

  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "hermes",
      text: winnerText,
      data: { source: "winner-a" }
    }),
    /Run Ledger unavailable/
  );

  const durableMarker = structuredClone(answer.echoInkRunTerminalRecovery);
  assert.equal(durableMarker?.payloadSource?.kind, "raw");
  const winnerRawRef = durableMarker?.payloadSource?.rawRef;
  assert.equal(typeof winnerRawRef, "string");
  assert.match(winnerRawRef, /echoink-chat-terminal/);
  assert.equal(rawTexts.get(winnerRawRef), winnerText);
  assert.equal(
    JSON.stringify(durableMarker).includes("A".repeat(1_000)),
    false,
    "the >80k body must not be duplicated inside the settings marker"
  );

  const loserTerminal = {
    runId,
    status: "completed" as const,
    backendId: "opencode",
    text: loserText,
    data: { source: "loser-b" }
  };
  const loserRawRef = echoInkChatTerminalRawRef(
    loserTerminal,
    answer.id
  );
  const loserProjection: any = {
    ...answer,
    rawRef: loserRawRef,
    rawTruncatedForPreview: false
  };
  const loserRawWrite = prepareRawMessage(loserProjection, loserText);
  assert.ok(loserRawWrite);
  rawTexts.set(loserRawWrite.rawRef, loserText);
  assert.match(loserRawRef, /echoink-chat-terminal-[a-f0-9]{24}/);

  await harness.service.commitChatSurfaceTerminal(loserTerminal);

  const [terminal] = terminalEvents(await backingLedger.readRun(runId));
  assert.equal(terminal?.backendId, "hermes");
  assert.equal(terminal?.text, winnerText);
  assert.deepEqual(terminal?.data, { source: "winner-a" });
  assert.equal(answer.rawRef, winnerRawRef);
  assert.equal(rawTexts.get(answer.rawRef!), winnerText);
  assert.notEqual(
    loserRawRef,
    winnerRawRef,
    "each terminal candidate needs an immutable Raw identity"
  );
  assert.equal(
    rawTexts.get(loserRawRef),
    loserText,
    "the losing Raw may remain as an orphan for later reference-graph GC, but must never be linked as the winner"
  );
  assert.deepEqual(answer.echoInkRunTerminalRecovery, durableMarker);
}

async function assertRestartRejectsNonCommitAddressedRawAuthority(): Promise<void> {
  const fixture = await createPendingLargeRawAuthorityFixture(
    "non-commit-addressed"
  );
  const marker = fixture.answer.echoInkRunTerminalRecovery;
  assert.equal(marker?.payloadSource?.kind, "raw");
  const originalRawRef = marker.payloadSource.rawRef;
  const mutableRawRef = "raw/mutable-terminal-copy.txt";
  fixture.rawTexts.set(
    mutableRawRef,
    fixture.terminal.text
  );
  marker.payloadSource.rawRef = mutableRawRef;
  fixture.answer.rawRef = mutableRawRef;
  assert.notEqual(mutableRawRef, originalRawRef);

  const recovery = await recoverPendingLargeRawAuthority(fixture);

  assert.deepEqual(recovery.settledRunIds, []);
  assert.deepEqual(recovery.failedRunIds, [fixture.terminal.runId]);
  assert.equal(
    fixture.answer.echoInkRunTerminalRecovery?.payloadSource.kind,
    "raw"
  );
  assert.equal(
    fixture.answer.echoInkRunTerminalRecovery?.payloadSource.rawRef,
    mutableRawRef,
    "startup recovery must leave a suspicious marker pending for diagnosis"
  );
  assert.equal(
    terminalEvents(
      await fixture.backingLedger.readRun(fixture.terminal.runId)
    ).length,
    0
  );
}

async function assertRestartRetainsMissingRawAuthorityForRecovery(): Promise<void> {
  const fixture = await createPendingLargeRawAuthorityFixture("missing-raw");
  const marker = fixture.answer.echoInkRunTerminalRecovery;
  assert.equal(marker?.payloadSource?.kind, "raw");
  fixture.rawTexts.delete(marker.payloadSource.rawRef);

  const recovery = await recoverPendingLargeRawAuthority(fixture);

  assert.deepEqual(recovery.settledRunIds, []);
  assert.deepEqual(recovery.failedRunIds, [fixture.terminal.runId]);
  assert.equal(
    fixture.answer.runTerminalRecoveryPending,
    "completed",
    "a missing Raw payload must remain pending instead of committing a guessed terminal"
  );
  assert.equal(
    terminalEvents(
      await fixture.backingLedger.readRun(fixture.terminal.runId)
    ).length,
    0
  );
}

async function assertTerminalDataRejectsNonPersistableValues(): Promise<void> {
  const runId = "run-terminal-data-non-persistable";
  const session: StoredSession = {
    id: "session-terminal-data-non-persistable",
    title: "Terminal data validation",
    cwd: "/vault",
    messages: [{
      id: "answer-terminal-data-non-persistable",
      role: "assistant",
      itemType: "assistant",
      status: "running",
      text: "",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createServiceReceiptTestBed({
    sessionId: session.id,
    session
  });

  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "candidate",
      data: { invalid: undefined }
    }),
    /non-persistable value/
  );
  assert.equal(harness.saveCalls.length, 0);
  assert.equal(terminalEvents(await harness.ledger.readRun(runId)).length, 0);
  assert.equal(
    (session.messages[0] as any).echoInkRunTerminalRecovery,
    undefined
  );
}

async function assertConversationMarkerRollsBackWhenSaveFails(): Promise<void> {
  const runId = "run-terminal-marker-save-rollback";
  const answer: any = {
    id: "answer-terminal-marker-save-rollback",
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "streaming candidate",
    runId,
    backendId: "codex-cli",
    createdAt: 1
  };
  const session: StoredSession = {
    id: "session-terminal-marker-save-rollback",
    title: "Terminal marker save rollback",
    cwd: "/vault",
    messages: [answer],
    createdAt: 1,
    updatedAt: 1
  };
  const rawTexts = new Map<string, string>();
  const harness = createServiceReceiptTestBed({
    sessionId: session.id,
    session,
    rawTexts,
    saveFailureAtCalls: [1]
  });
  const before = structuredClone(session.messages);
  const failedText = `failed-save:${"X".repeat(90_000)}`;

  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: failedText
    }),
    /Conversation persistence unavailable/
  );

  assert.deepEqual(
    session.messages,
    before,
    "an uncommitted marker and its in-memory projection must roll back together"
  );
  assert.equal(terminalEvents(await harness.ledger.readRun(runId)).length, 0);
  assert.equal(rawTexts.size, 1, "Raw-first failure may leave one safe orphan");
  const [orphanRef] = rawTexts.keys();

  const retryText = `retry-winner:${"Y".repeat(90_000)}`;
  await harness.service.commitChatSurfaceTerminal({
    runId,
    status: "completed",
    backendId: "hermes",
    text: retryText
  });
  assert.equal(answer.backendId, "hermes");
  assert.equal(
    rawTexts.get(answer.rawRef!),
    retryText
  );
  assert.notEqual(answer.rawRef, orphanRef);
}

async function assertConversationMarkerRollsForwardAfterDataSaveFails(): Promise<void> {
  const fixture = await createRealConversationPartialSaveFixture(
    "terminal-marker-forward"
  );
  try {
    const answer = fixture.session.messages[0]!;
    const terminal = {
      runId: fixture.runId,
      status: "completed" as const,
      backendId: "codex-cli" as const,
      text: "durable despite data.json failure",
      data: { source: "conversation-store" }
    };
    fixture.failNextDataSave();
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await fixture.service.commitChatSurfaceTerminal(terminal);
    } finally {
      console.error = originalError;
    }

    const marker = answer.echoInkRunTerminalRecovery;
    assert.ok(marker);
    assert.equal(fixture.dataSaveFailures(), 1);
    assert.equal(answer.runTerminalRecoveryPending, "completed");
    assert.equal(answer.text, terminal.text);
    assert.strictEqual(
      fixture.session.messages[0],
      answer,
      "strict Conversation readback should reuse the live message object"
    );
    const [committedTerminal] = terminalEvents(
      await fixture.ledger.readRun(fixture.runId)
    );
    assert.equal(committedTerminal?.type, "run.completed");
    assert.equal(committedTerminal?.backendId, terminal.backendId);
    assert.equal(committedTerminal?.text, terminal.text);
    assert.deepEqual(committedTerminal?.data, terminal.data);

    const restarted = fixture.createRestartedSettingsStore();
    const stored = await restarted.readConversationSession(
      fixture.session.id
    );
    const restartedMarker = stored?.messages.find(
      (message) => message.id === answer.id
    )?.echoInkRunTerminalRecovery;
    assert.equal(
      restartedMarker?.terminalCommitId,
      marker.terminalCommitId
    );
    assert.equal(restartedMarker?.payloadHash, marker.payloadHash);
  } finally {
    await fixture.dispose();
  }
}

async function assertConversationReadbackFailurePreservesTerminalCandidate(): Promise<void> {
  const runId = "run-terminal-readback-unknown";
  const session: StoredSession = {
    id: "session-terminal-readback-unknown",
    title: "Terminal readback unknown",
    cwd: "/vault",
    messages: [{
      id: "answer-terminal-readback-unknown",
      role: "assistant",
      itemType: "assistant",
      status: "running",
      text: "streaming",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createServiceReceiptTestBed({
    sessionId: session.id,
    session,
    saveFailureAtCalls: [1],
    conversationReadFailures: 1
  });

  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "candidate with unknown durable state"
    }),
    /readback is indeterminate.*recovery required/
  );

  const answer = session.messages[0]!;
  assert.equal(answer.status, "completed");
  assert.equal(answer.text, "candidate with unknown durable state");
  assert.equal(answer.runTerminalRecoveryPending, "completed");
  assert.ok(answer.echoInkRunTerminalRecovery?.terminalCommitId);
  assert.equal(
    terminalEvents(await harness.ledger.readRun(runId)).length,
    0,
    "an indeterminate Conversation readback must not advance the Run Ledger"
  );
}

async function assertTerminalMarkerClearRollsBackWhenSaveFails(): Promise<void> {
  const runId = "run-terminal-marker-clear-rollback";
  const native = serviceTestNative("thread-terminal-marker-clear-rollback");
  const harness = createServiceReceiptTestBed({
    sessionId: "session-terminal-marker-clear-rollback",
    saveFailureAtCalls: [2]
  });
  const result = await harness.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "completed",
        outputText: "durable answer",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, harness.session.id),
    sessionProvider: () => harness.session
  });
  assert.ok(result.backendBinding);
  updateSessionBackendBinding(harness.session, result.backendBinding!);
  const answer: any = harness.session.messages.find((message) =>
    message.runId === runId && message.itemType === "assistant"
  );
  assert.ok(answer);
  answer.status = "completed";
  answer.text = "durable answer";

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "durable answer"
    });
  } finally {
    console.error = originalError;
  }

  const marker = structuredClone(answer.echoInkRunTerminalRecovery);
  assert.ok(marker?.terminalCommitId);
  assert.equal(answer.runTerminalRecoveryPending, "completed");
  assert.equal(answer.runTerminalRecovered, undefined);
  assert.equal(
    harness.nativeManager.records.values().next().value?.localCommit,
    "committed"
  );

  const restarted = createServiceReceiptTestBed({
    sessionId: harness.session.id,
    session: harness.session,
    ledger: harness.ledger,
    nativeManager: harness.nativeManager
  });
  const recovery = await recoverStaleChatHarnessRuns({
    messages: harness.session.messages,
    commitLocalHistory: async () => {
      await restarted.plugin.saveSettings(true);
    },
    commitRunTerminal: async (terminal, persistWinner) => {
      await restarted.service.commitChatSurfaceTerminal(terminal, {
        mode: "recovery-restart",
        persistConversation: persistWinner
      });
    }
  });
  assert.deepEqual(recovery.settledRunIds, [runId]);
  assert.equal(answer.echoInkRunTerminalRecovery, undefined);
  assert.equal(answer.runTerminalRecoveryPending, undefined);
  assert.equal(answer.runTerminalRecovered, true);
}

async function assertTerminalMarkerClearStaysClearedAfterDataSaveFails(): Promise<void> {
  const fixture = await createRealConversationPartialSaveFixture(
    "terminal-marker-clear-forward"
  );
  try {
    const answer = fixture.session.messages[0]!;
    await fixture.service.commitChatSurfaceTerminal({
      runId: fixture.runId,
      status: "completed",
      backendId: "codex-cli",
      text: "durable answer before clear"
    });
    const marker = answer.echoInkRunTerminalRecovery;
    assert.ok(marker);

    fixture.failNextDataSave();
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await (fixture.service as any).clearChatTerminalRecoveryPending(
        fixture.runId,
        marker.terminalCommitId
      );
    } finally {
      console.error = originalError;
    }

    assert.equal(fixture.dataSaveFailures(), 1);
    assert.strictEqual(
      fixture.session.messages[0],
      answer,
      "clear readback should preserve the live message object"
    );
    assert.equal(answer.runTerminalRecoveryPending, undefined);
    assert.equal(answer.echoInkRunTerminalRecovery, undefined);
    assert.equal(answer.runTerminalRecovered, true);

    const restarted = fixture.createRestartedSettingsStore();
    const stored = await restarted.readConversationSession(
      fixture.session.id
    );
    const restartedAnswer = stored?.messages.find(
      (message) => message.id === answer.id
    );
    assert.ok(restartedAnswer);
    assert.equal(restartedAnswer.runTerminalRecoveryPending, undefined);
    assert.equal(restartedAnswer.echoInkRunTerminalRecovery, undefined);
    assert.equal(restartedAnswer.runTerminalRecovered, true);
  } finally {
    await fixture.dispose();
  }
}

async function assertClearReadbackFailurePreservesClearedCandidate(): Promise<void> {
  const runId = "run-terminal-clear-readback-unknown";
  const session: StoredSession = {
    id: "session-terminal-clear-readback-unknown",
    title: "Terminal clear readback unknown",
    cwd: "/vault",
    messages: [{
      id: "answer-terminal-clear-readback-unknown",
      role: "assistant",
      itemType: "assistant",
      status: "running",
      text: "streaming",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createServiceReceiptTestBed({
    sessionId: session.id,
    session,
    saveFailureAtCalls: [2],
    conversationReadFailures: 1
  });
  await harness.service.commitChatSurfaceTerminal({
    runId,
    status: "completed",
    backendId: "codex-cli",
    text: "durable before unknown clear"
  });
  const answer = session.messages[0]!;
  const marker = answer.echoInkRunTerminalRecovery;
  assert.ok(marker);

  await assert.rejects(
    () => (harness.service as any).clearChatTerminalRecoveryPending(
      runId,
      marker.terminalCommitId
    ),
    /clear readback is indeterminate.*recovery required/
  );

  assert.equal(answer.runTerminalRecoveryPending, undefined);
  assert.equal(answer.echoInkRunTerminalRecovery, undefined);
  assert.equal(answer.runTerminalRecovered, true);
}

async function assertServiceOwnedSynchronousChatTerminalsWaitForConversationCommit(): Promise<void> {
  for (const status of ["completed", "cancelled", "failed"] as const) {
    const runId = `run-service-sync-${status}`;
    const native = serviceTestNative(`thread-service-sync-${status}`);
    const harness = createServiceReceiptTestBed({
      sessionId: `session-service-sync-${status}`
    });
    const result = await harness.service.runWithAdapter({
      adapter: createServiceTestAdapter({
        result: {
          status,
          ...(status === "completed"
            ? { outputText: "synchronous answer" }
            : { error: `synchronous ${status}` }),
          nativeExecution: native,
          nativeThreadId: native.id
        },
        native,
        emittedTerminal: status
      }),
      request: serviceChatRequest(runId, harness.session.id),
      sessionProvider: () => harness.session
    });

    assert.equal(result.status, status);
    assert.equal(
      terminalEvents(await harness.ledger.readRun(runId)).length,
      0,
      `the real HarnessService must set terminalAuthority=surface for synchronous ${status}`
    );
    if (result.backendBinding) {
      updateSessionBackendBinding(harness.session, result.backendBinding);
    }

    await harness.service.commitChatSurfaceTerminal({
      runId,
      status,
      backendId: "codex-cli",
      ...(status === "completed"
        ? { text: "synchronous answer" }
        : { error: `synchronous ${status}` })
    });

    const terminals = terminalEvents(await harness.ledger.readRun(runId));
    assert.equal(terminals.length, 1);
    assert.equal(
      terminals[0]?.type,
      status === "completed"
        ? "run.completed"
        : status === "cancelled"
          ? "run.cancelled"
          : "run.failed"
    );
    assert.equal(harness.nativeManager.settlementAttempts.length, 1);
  }
}

async function assertTerminalGateFailureDoesNotRewriteBusinessWinner(): Promise<void> {
  const session: StoredSession = {
    id: "session-terminal-gate-business-winner",
    title: "Terminal gate business winner",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const backingLedger = new InMemoryRunLedger();
  let terminalAppendFailures = 1;
  const ledger: RunLedger = {
    async append(event) {
      if (isTerminalHarnessEvent(event) && terminalAppendFailures > 0) {
        terminalAppendFailures -= 1;
        throw new Error("Run Ledger unavailable");
      }
      await backingLedger.append(event);
    },
    async readRun(runId) {
      return await backingLedger.readRun(runId);
    }
  };
  const harness = createChatSurfaceHarness(
    session,
    [{
      threadId: "thread-terminal-gate-business-winner",
      turnId: "turn-terminal-gate-business-winner",
      text: "unused"
    }],
    { ledger }
  );
  harness.view.plugin.runHarnessWithAdapter = async (input: any) => ({
    runId: input.request.runId,
    status: "completed",
    outputText: "business winner"
  });

  const originalError = console.error;
  console.error = () => undefined;
  let outcome: string;
  try {
    outcome = await startChatTurn(
      harness.view,
      session,
      queuedTurn(
        "terminal-gate-business-winner",
        session.id,
        "give me the winner"
      ),
      "composer"
    );
  } finally {
    console.error = originalError;
  }

  const answer: any = session.messages.find((message) =>
    message.role === "assistant" && message.itemType === "assistant"
  );
  assert.equal(outcome, "completed");
  assert.equal(answer?.status, "completed");
  assert.equal(answer?.title, undefined);
  assert.equal(answer?.text, "business winner");
  assert.equal(answer?.runTerminalRecoveryPending, "completed");
  assert.equal(answer?.echoInkRunTerminalRecovery?.status, "completed");
  assert.equal(
    terminalEvents(await backingLedger.readRun(answer.runId)).length,
    0,
    "the lifecycle gate may remain pending, but it cannot rewrite the business winner as a failed response"
  );
}

async function assertChatNativeReceiptRegistrationBeforeIntent(): Promise<void> {
  const runId = "run-receipt-registration-before-intent";
  const native = serviceTestNative("thread-registration-before-intent");
  const harness = createServiceReceiptTestBed({
    sessionId: "session-receipt-registration-before-intent"
  });
  const result = await harness.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "running",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, harness.session.id),
    sessionProvider: () => harness.session
  });
  assert.equal(result.status, "running");
  assert.ok(result.backendBinding);
  updateSessionBackendBinding(harness.session, result.backendBinding!);

  const stateBeforeIntent = receiptStateForRun(harness.service, runId);
  assert.ok(stateBeforeIntent);
  assert.equal(stateBeforeIntent.registrationsClosed, true);
  assert.equal(stateBeforeIntent.receipts.size, 1);
  assert.equal(stateBeforeIntent.intent, undefined);

  await harness.service.commitChatSurfaceTerminal({
    runId,
    status: "completed",
    backendId: "codex-cli",
    text: "done"
  });

  assert.equal(harness.nativeManager.settlementAttempts.length, 1);
  assert.equal(
    harness.nativeManager.settlementAttempts[0]?.localCommit.committed,
    true,
    "a receipt matching the durable Conversation binding must commit locally"
  );
  assert.equal(receiptStateForRun(harness.service, runId), undefined);
}

async function assertChatNativeReceiptIntentBeforeRegistration(): Promise<void> {
  const runId = "run-receipt-intent-before-registration";
  const native = serviceTestNative("thread-intent-before-registration");
  const registrationEntered = deferred<void>();
  const releaseRegistration = deferred<void>();
  const harness = createServiceReceiptTestBed({
    sessionId: "session-receipt-intent-before-registration"
  });
  const run = harness.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "running",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native,
      beforeRegistration: async () => {
        registrationEntered.resolve();
        await releaseRegistration.promise;
      }
    }),
    request: serviceChatRequest(runId, harness.session.id),
    sessionProvider: () => harness.session
  });
  await registrationEntered.promise;

  await harness.service.commitChatSurfaceTerminal({
    runId,
    status: "cancelled",
    backendId: "codex-cli",
    error: "stopped before Native registration"
  });
  const stateBeforeRegistration = receiptStateForRun(harness.service, runId);
  assert.ok(stateBeforeRegistration);
  assert.equal(stateBeforeRegistration.registrationsClosed, false);
  assert.equal(stateBeforeRegistration.receipts.size, 0);
  assert.equal(stateBeforeRegistration.intent?.status, "cancelled");
  assert.equal(harness.nativeManager.settlementAttempts.length, 0);

  releaseRegistration.resolve();
  await run;

  assert.equal(harness.nativeManager.settlementAttempts.length, 1);
  assert.equal(
    harness.nativeManager.settlementAttempts[0]?.localCommit.committed,
    false
  );
  assert.match(
    harness.nativeManager.settlementAttempts[0]?.localCommit.error ?? "",
    /no durable Conversation binding/
  );
  assert.equal(receiptStateForRun(harness.service, runId), undefined);
}

async function assertChatNativeReceiptIdentityAndIntentConflictsFailClosed(): Promise<void> {
  const runId = "run-receipt-idempotency-conflict";
  const harness = createServiceReceiptTestBed({
    sessionId: "session-receipt-idempotency-conflict"
  });
  const captureReceipt = (harness.service as any).captureChatNativeExecutionReceipt.bind(
    harness.service
  ) as (receipt: unknown, targetRunId: string) => Promise<void>;
  const recordIntent = (harness.service as any).recordChatNativeSettlementIntent.bind(
    harness.service
  ) as (targetRunId: string, intent: unknown) => Promise<void>;
  const receipt = {
    recordId: "receipt-stable-id",
    sessionId: harness.session.id,
    native: serviceTestNative("thread-receipt-stable")
  };
  await harness.nativeManager.recordCreated({
    id: receipt.recordId,
    runId,
    sessionId: receipt.sessionId,
    surface: "chat",
    workflow: "chat.generic",
    native: receipt.native,
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
  });

  await captureReceipt(receipt, runId);
  await captureReceipt(structuredClone(receipt), runId);
  assert.equal(receiptStateForRun(harness.service, runId)?.receipts.size, 1);
  await assert.rejects(
    () => captureReceipt({
      ...receipt,
      native: serviceTestNative("thread-receipt-conflict")
    }, runId),
    /receipt conflicts/
  );

  const stableIntent = {
    status: "completed",
    runOutcome: "success",
    terminalCommitId: "echoink:chat-terminal:v1:stable-intent"
  };
  await recordIntent(runId, stableIntent);
  await recordIntent(runId, stableIntent);
  await assert.rejects(
    () => recordIntent(runId, {
      status: "failed",
      runOutcome: "failed",
      terminalCommitId: "echoink:chat-terminal:v1:conflicting-intent"
    }),
    /settlement intent conflicts/
  );
  assert.equal(
    harness.nativeManager.settlementAttempts.length,
    1,
    "idempotent receipt and intent observations must settle a record only once"
  );
}

async function assertChatNativeSettlementFailureRemainsRetryable(): Promise<void> {
  const runId = "run-receipt-settlement-retry";
  const native = serviceTestNative("thread-receipt-settlement-retry");
  const harness = createServiceReceiptTestBed({
    sessionId: "session-receipt-settlement-retry",
    settlementFailures: 1
  });
  const result = await harness.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "completed",
        outputText: "done",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, harness.session.id),
    sessionProvider: () => harness.session
  });
  assert.ok(result.backendBinding);
  updateSessionBackendBinding(harness.session, result.backendBinding!);

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "done"
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(harness.nativeManager.settlementAttempts.length, 2);
  assert.equal(
    terminalEvents(await harness.ledger.readRun(runId)).length,
    1
  );
  assert.equal(receiptStateForRun(harness.service, runId), undefined);
}

async function assertLedgerFailureRecoversSameWinnerAfterRestart(): Promise<void> {
  const runId = "run-chat-ledger-restart-recovery";
  const native = serviceTestNative("thread-chat-ledger-restart-recovery");
  const backingLedger = new InMemoryRunLedger();
  let terminalAppendFailures = 1;
  const ledger: RunLedger = {
    async append(event) {
      if (isTerminalHarnessEvent(event) && terminalAppendFailures > 0) {
        terminalAppendFailures -= 1;
        throw new Error("Run Ledger unavailable");
      }
      await backingLedger.append(event);
    },
    async readRun(targetRunId) {
      return await backingLedger.readRun(targetRunId);
    }
  };
  const serviceA = createServiceReceiptTestBed({
    sessionId: "session-chat-ledger-restart-recovery",
    ledger
  });
  const result = await serviceA.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "completed",
        outputText: "durable winner",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, serviceA.session.id),
    sessionProvider: () => serviceA.session
  });
  assert.ok(result.backendBinding);
  updateSessionBackendBinding(serviceA.session, result.backendBinding!);
  const answer = serviceA.session.messages.find((message) =>
    message.runId === runId && message.itemType === "assistant"
  );
  assert.ok(answer);
  answer.status = "completed";
  answer.text = "durable winner";

  await assert.rejects(
    () => serviceA.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "durable winner"
    }),
    /Run Ledger unavailable/
  );
  assert.equal(answer.runTerminalRecoveryPending, "completed");
  assert.equal(terminalEvents(await backingLedger.readRun(runId)).length, 0);
  assert.equal(serviceA.nativeManager.settlementAttempts.length, 0);

  const serviceB = createServiceReceiptTestBed({
    sessionId: serviceA.session.id,
    session: serviceA.session,
    ledger,
    nativeManager: serviceA.nativeManager
  });
  assert.equal(receiptStateForRun(serviceB.service, runId), undefined);
  const recover = async () => {
    await serviceB.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "durable winner"
    }, {
      mode: "recovery-restart",
      persistConversation: async (winner) => {
        applyChatRunTerminalWinner(serviceB.session.messages, winner);
        await serviceB.plugin.saveSettings(true);
      }
    });
  };

  await recover();
  await recover();

  const terminals = terminalEvents(await backingLedger.readRun(runId));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.type, "run.completed");
  assert.equal(serviceA.nativeManager.settlementAttempts.length, 1);
  assert.equal(
    serviceA.nativeManager.records.values().next().value?.localCommit,
    "committed"
  );
  assert.equal(receiptStateForRun(serviceB.service, runId), undefined);
}

async function assertLiveNativeSettlementExhaustionRecoversAfterRestart(): Promise<void> {
  const runId = "run-chat-live-native-exhaustion";
  const native = serviceTestNative("thread-chat-live-native-exhaustion");
  const ledger = new InMemoryRunLedger();
  const serviceA = createServiceReceiptTestBed({
    sessionId: "session-chat-live-native-exhaustion",
    ledger,
    settlementFailures: 3
  });
  const result = await serviceA.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "completed",
        outputText: "winner survives Native failure",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, serviceA.session.id),
    sessionProvider: () => serviceA.session
  });
  assert.ok(result.backendBinding);
  updateSessionBackendBinding(serviceA.session, result.backendBinding!);
  const answer = serviceA.session.messages.find((message) =>
    message.runId === runId && message.itemType === "assistant"
  );
  assert.ok(answer);
  answer.status = "completed";
  answer.text = "winner survives Native failure";

  const originalError = console.error;
  console.error = () => undefined;
  try {
    await serviceA.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: answer.text
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(terminalEvents(await ledger.readRun(runId)).length, 1);
  assert.equal(serviceA.nativeManager.settlementAttempts.length, 3);
  assert.equal(answer.runTerminalRecoveryPending, "completed");
  assert.equal(receiptStateForRun(serviceA.service, runId), undefined);
  assert.equal(
    serviceA.nativeManager.records.values().next().value?.localCommit,
    "pending"
  );

  const serviceB = createServiceReceiptTestBed({
    sessionId: serviceA.session.id,
    session: serviceA.session,
    ledger,
    nativeManager: serviceA.nativeManager
  });
  await serviceB.service.commitChatSurfaceTerminal({
    runId,
    status: "completed",
    backendId: "codex-cli",
    text: answer.text
  }, {
    mode: "recovery-restart",
    persistConversation: async (winner) => {
      applyChatRunTerminalWinner(serviceB.session.messages, winner);
      await serviceB.plugin.saveSettings(true);
    }
  });

  assert.equal(terminalEvents(await ledger.readRun(runId)).length, 1);
  assert.equal(serviceA.nativeManager.settlementAttempts.length, 4);
  assert.equal(
    serviceA.nativeManager.records.values().next().value?.localCommit,
    "committed"
  );
  assert.equal(receiptStateForRun(serviceB.service, runId), undefined);
}

async function assertSynchronousChatConversationCommitFailureRetainsNative(): Promise<void> {
  const runId = "run-chat-conversation-commit-failure";
  const native = serviceTestNative("thread-chat-conversation-commit-failure");
  const harness = createServiceReceiptTestBed({
    sessionId: "session-chat-conversation-commit-failure",
    saveFailures: 1
  });
  await harness.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "completed",
        outputText: "candidate",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, harness.session.id),
    sessionProvider: () => harness.session
  });

  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "candidate"
    }),
    /Conversation persistence unavailable/
  );
  assert.equal(harness.saveCalls.length, 1);
  assert.equal(terminalEvents(await harness.ledger.readRun(runId)).length, 0);
  assert.equal(harness.nativeManager.settlementAttempts.length, 0);
  assert.ok(receiptStateForRun(harness.service, runId));
}

async function assertSynchronousChatLedgerCommitFailureRetainsNative(): Promise<void> {
  const runId = "run-chat-ledger-commit-failure";
  const native = serviceTestNative("thread-chat-ledger-commit-failure");
  const backingLedger = new InMemoryRunLedger();
  const ledger: RunLedger = {
    async append(event) {
      if (isTerminalHarnessEvent(event)) throw new Error("Run Ledger unavailable");
      await backingLedger.append(event);
    },
    async readRun(targetRunId) {
      return await backingLedger.readRun(targetRunId);
    }
  };
  const harness = createServiceReceiptTestBed({
    sessionId: "session-chat-ledger-commit-failure",
    ledger
  });
  await harness.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "completed",
        outputText: "candidate",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, harness.session.id),
    sessionProvider: () => harness.session
  });

  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal({
      runId,
      status: "completed",
      backendId: "codex-cli",
      text: "candidate"
    }),
    /Run Ledger unavailable/
  );
  assert.equal(harness.saveCalls.length, 1);
  assert.equal(terminalEvents(await backingLedger.readRun(runId)).length, 0);
  assert.equal(harness.nativeManager.settlementAttempts.length, 0);
  assert.ok(receiptStateForRun(harness.service, runId));
}

async function assertChatStopCommitsCancellationTerminal(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-chat-stop",
    title: "Chat",
    cwd: "/vault",
    threadId: "thread-chat-stop",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "run-chat-stop",
    activeTurnId: "turn-chat-stop",
    activeRunKind: "chat",
    activeRunNativeExecutionRecordIds: [" record-chat-stop ", "record-chat-stop"],
    editorActionActiveTimeoutMs: 1,
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        calls.push(`cancel:${runId}`);
      },
      commitChatSurfaceTerminal: async (input: any) => {
        calls.push("history");
        calls.push("ledger");
        assert.deepEqual(input, {
          runId: "run-chat-stop",
          status: "cancelled",
          backendId: "codex-cli",
          error: "用户中断"
        });
      }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: () => undefined,
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: (_session: StoredSession, message: any) => session.messages.push({ id: "cancel-message", createdAt: 2, ...message }),
    clearActiveRun: () => { calls.push("clear"); view.activeRunId = ""; },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, [
    "cancel:run-chat-stop",
    "clear",
    "history",
    "ledger"
  ]);
  assert.equal(session.messages.at(-1)?.runId, "run-chat-stop");
  assert.equal(session.messages.at(-1)?.status, "canceled");
  assert.equal(view.activeRunId, "");
}

async function assertChatStopUsesActualBackend(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-hermes-stop",
    title: "Hermes chat",
    cwd: "/vault",
    messages: [{ id: "hermes-user", role: "user", text: "继续", runId: "run-hermes-stop", backendId: "hermes", createdAt: 1 }],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "run-hermes-stop",
    activeTurnId: "",
    activeRunKind: "chat",
    editorActionActiveTimeoutMs: 1,
    running: true,
    plugin: {
      interruptCodexHarnessTurn: async () => { calls.push("wrong-interrupt"); },
      cancelHarnessRun: async (runId: string) => { calls.push(`cancel:${runId}`); },
      commitChatSurfaceTerminal: async (input: any) => {
        calls.push("history");
        calls.push("ledger");
        assert.equal(input.backendId, "hermes");
      }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: () => undefined,
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: (_session: StoredSession, message: any) => session.messages.push({ id: "hermes-cancel", createdAt: 2, ...message }),
    clearActiveRun: () => { calls.push("clear"); view.activeRunId = ""; },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, ["cancel:run-hermes-stop", "clear", "history", "ledger"]);
}

async function assertEditorStopUsesHarnessCancel(): Promise<void> {
  const calls: string[] = [];
  const view: any = {
    activeRunId: "run-editor-stop",
    activeTurnId: "turn-editor-stop",
    activeRunKind: "chat",
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        calls.push(`cancel:${runId}`);
      }
    },
    editorActionCurrentItemIds: new Set(["item-1"]),
    isEditorActionRunActive: () => true,
    rejectEditorActionRun: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => {
      calls.push("clear");
      view.activeRunId = "";
    },
    setEditorActionStatus: (status: { status: string; message: string }) => {
      calls.push(`${status.status}:${status.message}`);
    },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, [
    "cancel:run-editor-stop",
    "clear",
    "canceled:已中断"
  ]);
  assert.equal(view.activeRunId, "");
  assert.equal(view.activeTurnId, "");
  assert.equal(view.running, false);
  assert.equal(view.editorActionCurrentItemIds.size, 0);
}

async function assertKnowledgeStopDelegatesToManager(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-knowledge-stop",
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "kb-run-knowledge-stop",
    activeTurnId: "turn-knowledge-stop",
    activeRunKind: "knowledge-base",
    running: true,
    plugin: {
      getKnowledgeBaseManager: () => ({
        cancelMaintenance: async () => {
          calls.push("cancel-knowledge");
          return { accepted: true, message: "已取消知识库任务" };
        }
      }),
      cancelHarnessRun: async () => { calls.push("cancel-outer-run"); },
      settleHarnessRunTerminal: async () => { calls.push("settle-outer-run"); },
      saveSettings: async () => { calls.push("history"); }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: (sessionId: string) => { calls.push(`pause:${sessionId}`); },
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: () => undefined,
    clearActiveRun: () => { calls.push("clear"); },
    applyStatus: () => undefined
  };

  await stopTurn(view);

  assert.deepEqual(calls, ["cancel-knowledge", "pause:session-knowledge-stop"]);
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "kb-run-knowledge-stop");
}

async function assertKnowledgeStopDoesNotPauseAfterCommitLock(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-knowledge-commit-locked",
    title: "Knowledge commit locked",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "kb-run-commit-locked",
    activeTurnId: "turn-commit-locked",
    activeRunKind: "knowledge-base",
    running: true,
    plugin: {
      getKnowledgeBaseManager: () => ({
        cancelMaintenance: async () => {
          calls.push("cancel-rejected");
          return {
            accepted: false,
            message: "知识库维护已进入安全提交，不能取消。"
          };
        }
      })
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: (sessionId: string) => {
      calls.push(`pause:${sessionId}`);
    }
  };

  await stopTurn(view);

  assert.deepEqual(
    calls,
    ["cancel-rejected"],
    "commit-locked cancellation must not pause the knowledge queue"
  );
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "kb-run-commit-locked");
}

async function assertKnowledgeTurnSettlesNativeBeforePostRunSaveFailure(): Promise<void> {
  const calls: string[] = [];
  let saveCalls = 0;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "opencode";
  settings.knowledgeBase.backend = "opencode";
  settings.activeSessionId = "session-knowledge-local-fail";
  const session: StoredSession = {
    id: settings.activeSessionId,
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const manager = {
    handleUserMessage: async () => ({
      status: "success" as const,
      message: "知识任务完成",
      harnessResult: {
        runId: "knowledge-opencode-local-fail",
        status: "completed" as const,
        nativeExecution: {
          backendId: "opencode",
          id: "native-local-fail",
          kind: "session" as const,
          persistence: "provider-persistent" as const,
          deviceKey: "device",
          vaultId: "vault",
          createdAt: 1
        }
      }
    }),
    getLastNativeLifecycleSummary: () => ({
      localCommitStatus: "failed" as const,
      cleanupStatuses: ["retained-for-recovery" as const]
    })
  };
  const view: any = {
    plugin: {
      settings,
      getKnowledgeBaseManager: () => manager,
      externalizeMessageText: async (_message: unknown, _text: string) => { calls.push("externalize"); },
      saveSettings: async () => {
        saveCalls += 1;
        calls.push(`save:${saveCalls}`);
        if (saveCalls >= 2) throw new Error("conversation store failed");
      },
      settlePendingKnowledgeBaseNativeExecutions: async () => { calls.push("settle-native"); }
    },
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    messagesBottomFollowPaused: false,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    moveMessageToEnd: () => undefined,
    fillKnowledgeBaseCommand: () => undefined,
    refreshKnowledgeDashboard: async () => undefined
  };
  const item = { ...queuedTurn("knowledge-local-fail", session.id, "/check test"), kind: "knowledge-base" };

  await assert.rejects(startKnowledgeBaseTurn(view, session, item, "composer"), /conversation store failed/);

  assert.ok(calls.indexOf("settle-native") > calls.indexOf("externalize"));
  assert.ok(calls.indexOf("settle-native") < calls.indexOf("save:2"));
  assert.equal(session.messages.find((message) => message.role === "assistant")?.nativeLocalCommitStatus, "failed");
  assert.equal(session.messages.find((message) => message.role === "assistant")?.nativeCleanupStatus, "retained-for-recovery");
}

async function assertKnowledgeCleanupFailureDoesNotFailCompletedTurn(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "opencode";
  settings.knowledgeBase.backend = "opencode";
  settings.activeSessionId = "session-knowledge-cleanup-fail";
  const session: StoredSession = {
    id: settings.activeSessionId,
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const manager = {
    handleUserMessage: async () => ({
      status: "success" as const,
      message: "知识任务完成",
      harnessResult: {
        runId: "knowledge-opencode-cleanup-fail",
        status: "completed" as const,
        nativeExecution: {
          backendId: "opencode",
          id: "native-cleanup-fail",
          kind: "session" as const,
          persistence: "provider-persistent" as const,
          deviceKey: "device",
          vaultId: "vault",
          createdAt: 1
        }
      }
    }),
    getLastNativeLifecycleSummary: () => ({
      localCommitStatus: "committed" as const,
      cleanupStatuses: ["failed" as const]
    })
  };
  const view: any = {
    plugin: {
      settings,
      getKnowledgeBaseManager: () => manager,
      externalizeMessageText: async () => undefined,
      saveSettings: async () => undefined,
      settlePendingKnowledgeBaseNativeExecutions: async () => {
        throw new Error("native cleanup failed");
      }
    },
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    messagesBottomFollowPaused: false,
    clearComposerDraft: () => undefined,
    renderTabs: () => undefined,
    renderMessagesIfActive: () => undefined,
    renderMessages: () => undefined,
    renderToolbar: () => undefined,
    applyStatus: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => undefined,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    moveMessageToEnd: () => undefined,
    fillKnowledgeBaseCommand: () => undefined,
    refreshKnowledgeDashboard: async () => undefined
  };
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const outcome = await startKnowledgeBaseTurn(
      view,
      session,
      { ...queuedTurn("knowledge-cleanup-fail", session.id, "/check test"), kind: "knowledge-base" },
      "composer"
    );
    const assistant = session.messages.find((message) => message.role === "assistant");
    await waitFor(() => assistant?.nativeCleanupStatus === "failed");
    assert.equal(outcome, "completed");
    assert.equal(assistant?.status, "completed");
    assert.equal(assistant?.text, "知识任务完成");
    assert.equal(assistant?.nativeLocalCommitStatus, "committed");
    assert.equal(assistant?.nativeCleanupStatus, "failed");
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /native execution settle failed/);
  } finally {
    console.warn = originalWarn;
  }
}

async function assertKnowledgeUnloadWaitsForActiveRunSettlement(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  let resolveRun: ((value: { text: string }) => void) | null = null;
  let runtimeCleared = false;
  const service = new KnowledgeBaseAgentTaskService({
    settings,
    getVaultPath: () => "/vault",
    saveSettings: async () => undefined,
    settleHarnessRunTerminal: async () => undefined,
    cancelHarnessRun: async () => undefined
  } as any, { isCancelRequested: () => false });
  (service as any).runtimeController = {
    hasActiveRun: true,
    preflight: async () => undefined,
    run: async () => await new Promise<{ text: string }>((resolve) => { resolveRun = resolve; }),
    cancel: async () => {
      setTimeout(() => resolveRun?.({ text: "cancelled and settled" }), 15);
      return true;
    },
    clear: () => { runtimeCleared = true; }
  };

  const runPromise = service.runTask({
    backend: "opencode",
    prompt: "wait for unload",
    sources: [],
    permission: "read-only",
    codexWriteScope: "knowledge-lint",
    managedKind: "lint",
    workflowRunId: "workflow-unload-settlement",
    attemptId: "workflow-unload-settlement:attempt:1:opencode",
    attemptOrdinal: 1,
    vaultPathOverride: "/shadow-vault",
    writableRootsOverride: [],
    exactWriteFence: {
      attemptToken: "workflow-unload-settlement:attempt:1:opencode",
      leaseToken: "workflow-unload-settlement-lease",
      deniedLivePaths: ["/vault"],
      deniedControlPaths: ["/control"]
    }
  });
  await Promise.resolve();
  let unloadCompleted = false;
  const unloadPromise = service.unload().then(() => { unloadCompleted = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unloadCompleted, false, "plugin unload must wait for the active Knowledge run promise");
  await unloadPromise;
  await runPromise;
  assert.equal(runtimeCleared, true);
}

async function assertChatStopPropagatesCancelFailureAndAllowsRetry(): Promise<void> {
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-chat-stop-retry",
    title: "Chat retry",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  let attempts = 0;
  const failure = new Error("cancel failed");
  const view: any = {
    activeRunId: "run-chat-stop-retry",
    activeTurnId: "turn-chat-stop-retry",
    activeRunKind: "chat",
    editorActionActiveTimeoutMs: 1,
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        attempts += 1;
        calls.push(`cancel:${attempts}:${runId}`);
        if (attempts === 1) throw failure;
      },
      commitChatSurfaceTerminal: async () => {
        calls.push("history");
        calls.push("ledger");
      }
    },
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    pauseQueueForSession: () => { calls.push("pause"); },
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => { calls.push("thinking"); },
    finishRunningProcessMessages: () => { calls.push("process"); },
    addMessageToSession: (_session: StoredSession, message: any) => session.messages.push({ id: `msg-${session.messages.length}`, createdAt: 2, ...message }),
    clearActiveRun: () => {
      calls.push("clear");
      view.activeRunId = "";
    },
    applyStatus: () => { calls.push("apply"); }
  };

  await assert.rejects(() => stopTurn(view), failure);
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "run-chat-stop-retry");
  assert.equal(view.activeTurnId, "turn-chat-stop-retry");
  assert.equal(session.messages.length, 0);
  assert.deepEqual(calls, ["cancel:1:run-chat-stop-retry"]);

  await stopTurn(view);

  assert.deepEqual(calls, [
    "cancel:1:run-chat-stop-retry",
    "cancel:2:run-chat-stop-retry",
    "pause",
    "thinking",
    "process",
    "clear",
    "history",
    "ledger",
    "apply"
  ]);
  assert.equal(view.running, false);
  assert.equal(view.activeRunId, "");
  assert.equal(session.messages.at(-1)?.status, "canceled");
}

async function assertChatStopBeforeNativeRegistrationRetainsRecoveryEvidence(): Promise<void> {
  const registrationEntered = deferred<void>();
  const releaseRegistration = deferred<void>();
  const session: StoredSession = {
    id: "session-chat-stop-before-registration",
    title: "Chat stop before registration",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-chat-stop-before-registration",
    turnId: "turn-chat-stop-before-registration",
    text: "",
    autoComplete: false,
    beforeStartThread: async () => {
      registrationEntered.resolve();
      await releaseRegistration.promise;
    }
  }]);

  const turn = startChatTurn(
    harness.view,
    session,
    queuedTurn("chat-stop-before-registration", session.id, "continue"),
    "composer"
  );
  await registrationEntered.promise;
  const runId = harness.view.activeRunId;

  await stopTurn(harness.view);
  assert.deepEqual(harness.terminalCalls, [{ runId, status: "cancelled" }]);
  assert.equal(
    harness.nativeSettlements.length,
    0,
    "Stop must be able to commit before the Native registration receipt exists"
  );

  releaseRegistration.resolve();
  assert.equal(await turn, "cancelled");
  await waitFor(() => harness.nativeSettlements.length === 1);

  const settlement = harness.nativeSettlements[0]!;
  assert.equal(settlement.runOutcome, "cancelled");
  assert.equal(settlement.localCommit.committed, false);
  const record = harness.nativeRecords.get(settlement.recordId);
  assert.equal(record?.localCommit, "failed");
  assert.equal(record?.cleanup, "retained-for-recovery");
  assert.match(record?.lastError ?? "", /no durable Conversation binding/);
}

async function assertChatStopIgnoresLateCompletedTerminal(): Promise<void> {
  const session: StoredSession = {
    id: "session-chat-stop-late-completed",
    title: "Chat stop late completed",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-chat-stop-late-completed",
    turnId: "turn-chat-stop-late-completed",
    text: "late answer",
    autoComplete: false
  }]);

  const outcome = await startChatTurn(
    harness.view,
    session,
    queuedTurn("chat-stop-late-completed", session.id, "continue"),
    "composer"
  );
  assert.equal(outcome, "running");
  const runId = harness.view.activeRunId;

  await stopTurn(harness.view);
  assert.equal(harness.nativeSettlements.length, 1);
  assert.equal(harness.nativeSettlements[0]?.localCommit.committed, true);
  const stoppedRecord = harness.nativeRecords.get(
    harness.nativeSettlements[0]?.recordId
  );
  assert.equal(stoppedRecord?.localCommit, "committed");
  assert.equal(stoppedRecord?.cleanup, "not-needed");
  const messagesAfterWinner = structuredClone(session.messages);
  const terminalCountAfterWinner = harness.terminalCalls.length;
  const nativeCountAfterWinner = harness.nativeSettlements.length;
  const saveCountAfterWinner = harness.saveCalls.length;
  const queueCountAfterWinner = harness.afterTurnSettledCalls.length;

  harness.notificationHub.dispatch({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-turn-chat-stop-late-completed",
        threadId: "thread-chat-stop-late-completed",
        turnId: "turn-chat-stop-late-completed",
        type: "agentMessage",
        text: "late answer"
      }
    }
  } as any);
  harness.notificationHub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "thread-chat-stop-late-completed",
      turn: {
        id: "turn-chat-stop-late-completed",
        threadId: "thread-chat-stop-late-completed",
        status: "completed"
      }
    }
  } as any);

  await waitFor(() => harness.ignoredLateTerminalAppendInputs.length === 1);
  const ledgerEvents = await harness.ledger.readRun(runId);
  assert.equal(
    ledgerEvents.filter((event) => event.type === "run.surface_terminal.ignored").length,
    1,
    "the late terminal warning must be durably appended exactly once"
  );
  assert.equal(
    ledgerEvents.filter((event) => event.type === "run.completed").length,
    0,
    "the late adapter completion must not replace the stop terminal"
  );
  assert.equal(
    ledgerEvents.filter((event) => event.type === "run.cancelled").length,
    1
  );
  assert.deepEqual(session.messages, messagesAfterWinner);
  assert.equal(harness.terminalCalls.length, terminalCountAfterWinner);
  assert.equal(harness.nativeSettlements.length, nativeCountAfterWinner);
  assert.equal(harness.saveCalls.length, saveCountAfterWinner);
  assert.equal(harness.afterTurnSettledCalls.length, queueCountAfterWinner);
}

async function assertEditorStopPropagatesCancelFailureAndAllowsRetry(): Promise<void> {
  const calls: string[] = [];
  let attempts = 0;
  const failure = new Error("editor cancel failed");
  const view: any = {
    activeRunId: "run-editor-stop-retry",
    activeTurnId: "turn-editor-stop-retry",
    activeRunKind: "chat",
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => {
        attempts += 1;
        calls.push(`cancel:${attempts}:${runId}`);
        if (attempts === 1) throw failure;
      }
    },
    editorActionCurrentItemIds: new Set(["item-1"]),
    isEditorActionRunActive: () => true,
    rejectEditorActionRun: () => undefined,
    clearTurnWatchdog: () => undefined,
    clearActiveRun: () => {
      calls.push("clear");
      view.activeRunId = "";
    },
    setEditorActionStatus: (status: { status: string; message: string }) => {
      calls.push(`${status.status}:${status.message}`);
    },
    applyStatus: () => { calls.push("apply"); }
  };

  await assert.rejects(() => stopTurn(view), failure);
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, "run-editor-stop-retry");
  assert.equal(view.activeTurnId, "turn-editor-stop-retry");
  assert.equal(view.editorActionCurrentItemIds.size, 1);
  assert.deepEqual(calls, ["cancel:1:run-editor-stop-retry"]);

  await stopTurn(view);

  assert.deepEqual(calls, [
    "cancel:1:run-editor-stop-retry",
    "cancel:2:run-editor-stop-retry",
    "clear",
    "canceled:已中断",
    "apply"
  ]);
  assert.equal(view.running, false);
  assert.equal(view.activeRunId, "");
  assert.equal(view.activeTurnId, "");
  assert.equal(view.editorActionCurrentItemIds.size, 0);
}

async function assertChatWatchdogSettlesNativeAfterDurableCommit(): Promise<void> {
  const calls: string[] = [];
  let watchdog: (() => void) | undefined;
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    setTimeout: (callback: () => void) => {
      watchdog = callback;
      return 1;
    }
  };
  const session: StoredSession = {
    id: "session-chat-watchdog",
    title: "Chat watchdog",
    cwd: "/vault",
    messages: [{
      id: "chat-watchdog-user",
      role: "user",
      text: "continue",
      runId: "run-chat-watchdog",
      backendId: "opencode",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "run-chat-watchdog",
    activeTurnId: "turn-chat-watchdog",
    activeRunKind: "chat",
    activeRunNativeExecutionRecordIds: ["record-chat-watchdog"],
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => { calls.push(`cancel:${runId}`); },
      commitChatSurfaceTerminal: async (input: any) => {
        calls.push("history");
        calls.push(`ledger:${input.status}:${input.backendId}`);
      }
    },
    clearTurnWatchdog: () => undefined,
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: () => undefined,
    clearActiveRun: () => {
      view.activeRunId = "";
      view.activeRunNativeExecutionRecordIds = [];
    },
    applyStatus: () => undefined,
    afterTurnSettled: async () => undefined
  };

  try {
    armTurnWatchdog(view, 1, "timeout");
    assert.ok(watchdog);
    watchdog();
    await waitFor(() => calls.some((call) => call.startsWith("ledger:")));
    assert.deepEqual(calls, [
      "cancel:run-chat-watchdog",
      "history",
      "ledger:failed:opencode"
    ]);
  } finally {
    (globalThis as any).window = previousWindow;
  }
}

async function assertChatWatchdogBeforeNativeRegistrationRetainsRecoveryEvidence(): Promise<void> {
  const registrationEntered = deferred<void>();
  const releaseRegistration = deferred<void>();
  let watchdog: (() => void) | undefined;
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    setTimeout: (callback: () => void) => {
      watchdog = callback;
      return 1;
    }
  };
  const session: StoredSession = {
    id: "session-chat-watchdog-before-registration",
    title: "Chat watchdog before registration",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-chat-watchdog-before-registration",
    turnId: "turn-chat-watchdog-before-registration",
    text: "",
    autoComplete: false,
    beforeStartThread: async () => {
      registrationEntered.resolve();
      await releaseRegistration.promise;
    }
  }]);

  try {
    const turn = startChatTurn(
      harness.view,
      session,
      queuedTurn("chat-watchdog-before-registration", session.id, "continue"),
      "composer"
    );
    await registrationEntered.promise;
    const runId = harness.view.activeRunId;

    armTurnWatchdog(harness.view, 1, "timeout before Native registration");
    assert.ok(watchdog);
    watchdog();
    await waitFor(() => harness.terminalCalls.length === 1);
    assert.deepEqual(harness.terminalCalls, [{ runId, status: "failed" }]);
    assert.equal(harness.nativeSettlements.length, 0);

    releaseRegistration.resolve();
    assert.equal(await turn, "failed");
    await waitFor(() => harness.nativeSettlements.length === 1);
    const settlement = harness.nativeSettlements[0]!;
    assert.equal(settlement.runOutcome, "failed");
    assert.equal(settlement.localCommit.committed, false);
    const record = harness.nativeRecords.get(settlement.recordId);
    assert.equal(record?.localCommit, "failed");
    assert.equal(record?.cleanup, "retained-for-recovery");
  } finally {
    releaseRegistration.resolve();
    (globalThis as any).window = previousWindow;
  }
}

async function assertChatWatchdogIgnoresLateFailedTerminal(): Promise<void> {
  let watchdog: (() => void) | undefined;
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    setTimeout: (callback: () => void) => {
      watchdog = callback;
      return 1;
    }
  };
  const session: StoredSession = {
    id: "session-chat-watchdog-late-failed",
    title: "Chat watchdog late failed",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-chat-watchdog-late-failed",
    turnId: "turn-chat-watchdog-late-failed",
    text: "",
    autoComplete: false
  }]);

  try {
    const outcome = await startChatTurn(
      harness.view,
      session,
      queuedTurn("chat-watchdog-late-failed", session.id, "continue"),
      "composer"
    );
    assert.equal(outcome, "running");
    const runId = harness.view.activeRunId;

    armTurnWatchdog(harness.view, 1, "timeout");
    assert.ok(watchdog);
    watchdog();
    await waitFor(() => harness.nativeSettlements.length === 1);
    assert.equal(harness.nativeSettlements[0]?.localCommit.committed, true);
    const watchdogRecord = harness.nativeRecords.get(
      harness.nativeSettlements[0]?.recordId
    );
    assert.equal(watchdogRecord?.localCommit, "committed");
    assert.equal(watchdogRecord?.cleanup, "not-needed");

    const messagesAfterWinner = structuredClone(session.messages);
    const terminalCountAfterWinner = harness.terminalCalls.length;
    const nativeCountAfterWinner = harness.nativeSettlements.length;
    const saveCountAfterWinner = harness.saveCalls.length;
    const queueCountAfterWinner = harness.afterTurnSettledCalls.length;

    harness.notificationHub.dispatch({
      method: "turn/completed",
      params: {
        threadId: "thread-chat-watchdog-late-failed",
        turn: {
          id: "turn-chat-watchdog-late-failed",
          threadId: "thread-chat-watchdog-late-failed",
          status: "failed",
          error: "late provider failure"
        }
      }
    } as any);

    await waitFor(() => harness.ignoredLateTerminalAppendInputs.length === 1);
    const ledgerEvents = await harness.ledger.readRun(runId);
    assert.equal(
      ledgerEvents.filter((event) => event.type === "run.surface_terminal.ignored").length,
      1
    );
    assert.equal(
      ledgerEvents.filter((event) => event.type === "run.failed").length,
      1,
      "the watchdog failure must remain the only failed Run terminal"
    );
    assert.deepEqual(session.messages, messagesAfterWinner);
    assert.equal(harness.terminalCalls.length, terminalCountAfterWinner);
    assert.equal(harness.nativeSettlements.length, nativeCountAfterWinner);
    assert.equal(harness.saveCalls.length, saveCountAfterWinner);
    assert.equal(harness.afterTurnSettledCalls.length, queueCountAfterWinner);
  } finally {
    (globalThis as any).window = previousWindow;
  }
}

async function assertLateChatTerminalAuditRetriesAfterAppendFailure(): Promise<void> {
  const runId = "run-late-audit-retry";
  prepareChatSurfaceTerminal(runId);
  const winner = claimChatSurfaceTerminal(runId, "stop", "cancelled").winner;
  let appendAttempts = 0;
  const durableAudits: unknown[] = [];
  const plugin = {
    appendHarnessRunEvent: async (input: unknown) => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error("audit ledger unavailable");
      durableAudits.push(input);
    }
  };
  const input = {
    runId,
    backendId: "codex-cli",
    lateStatus: "completed" as const,
    winner
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await recordIgnoredLateChatTerminal(plugin, input);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(appendAttempts, 2);
  assert.equal(durableAudits.length, 1);
}

async function assertLateChatTerminalAuditWaitsForTimerTransient(): Promise<void> {
  const runId = "run-late-audit-timer-transient";
  prepareChatSurfaceTerminal(runId);
  const winner = claimChatSurfaceTerminal(runId, "stop", "cancelled").winner;
  let appendAttempts = 0;
  let ready = false;
  let durableAudits = 0;
  const plugin = {
    appendHarnessRunEvent: async () => {
      appendAttempts += 1;
      if (!ready) {
        if (appendAttempts === 1) {
          globalThis.setTimeout(() => {
            ready = true;
          }, 1);
        }
        throw new Error("audit ledger recovers on the next timer tick");
      }
      durableAudits += 1;
    }
  };

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await recordIgnoredLateChatTerminal(plugin, {
      runId,
      backendId: "codex-cli",
      lateStatus: "completed",
      winner
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(appendAttempts, 2);
  assert.equal(durableAudits, 1);
}

async function assertLateChatTerminalAuditCanRetryAfterBoundedExhaustion(): Promise<void> {
  const runId = "run-late-audit-bounded-exhaustion";
  prepareChatSurfaceTerminal(runId);
  const winner = claimChatSurfaceTerminal(runId, "view-close", "cancelled").winner;
  let appendAttempts = 0;
  let durableAudits = 0;
  let allowSuccess = false;
  const plugin = {
    appendHarnessRunEvent: async () => {
      appendAttempts += 1;
      if (!allowSuccess) throw new Error("audit ledger unavailable");
      durableAudits += 1;
    }
  };
  const input = {
    runId,
    backendId: "hermes",
    lateStatus: "completed" as const,
    winner
  };
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await recordIgnoredLateChatTerminal(plugin, input);
    assert.equal(appendAttempts, 3);
    assert.equal(durableAudits, 0);

    allowSuccess = true;
    await recordIgnoredLateChatTerminal(plugin, input);
    await recordIgnoredLateChatTerminal(plugin, input);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(appendAttempts, 4);
  assert.equal(durableAudits, 1);
}

async function assertChatNativeSettlementWaitsForTimerTransient(): Promise<void> {
  const runId = "run-chat-native-timer-transient";
  const native = serviceTestNative("thread-chat-native-timer-transient");
  const harness = createServiceReceiptTestBed({
    sessionId: "session-chat-native-timer-transient"
  });
  const originalSettle = harness.nativeManager.settleRun.bind(
    harness.nativeManager
  );
  let attempts = 0;
  let ready = false;
  harness.nativeManager.settleRun = async (input) => {
    attempts += 1;
    if (!ready) {
      if (attempts === 1) {
        globalThis.setTimeout(() => {
          ready = true;
        }, 1);
      }
      throw new Error("Native Store recovers on the next timer tick");
    }
    return await originalSettle(input);
  };

  const result = await harness.service.runWithAdapter({
    adapter: createServiceTestAdapter({
      result: {
        status: "completed",
        outputText: "timer winner",
        nativeExecution: native,
        nativeThreadId: native.id
      },
      native
    }),
    request: serviceChatRequest(runId, harness.session.id),
    sessionProvider: () => harness.session
  });
  assert.ok(result.backendBinding);
  updateSessionBackendBinding(harness.session, result.backendBinding!);
  const answer = harness.session.messages.find((message) =>
    message.runId === runId && message.itemType === "assistant"
  );
  assert.ok(answer);
  answer.status = "completed";
  answer.text = "timer winner";

  await harness.service.commitChatSurfaceTerminal({
    runId,
    status: "completed",
    backendId: "codex-cli",
    text: "timer winner"
  });

  assert.equal(attempts, 2);
  assert.equal(
    harness.nativeManager.records.values().next().value?.localCommit,
    "committed"
  );
}

async function assertConcurrentLateChatTerminalAuditsAppendExactlyOnce(): Promise<void> {
  const runId = "run-late-audit-single-flight";
  prepareChatSurfaceTerminal(runId);
  const winner = claimChatSurfaceTerminal(runId, "watchdog", "failed").winner;
  const appendStarted = deferred<void>();
  const releaseAppend = deferred<void>();
  let appendAttempts = 0;
  const plugin = {
    appendHarnessRunEvent: async () => {
      appendAttempts += 1;
      appendStarted.resolve();
      await releaseAppend.promise;
    }
  };
  const input = {
    runId,
    backendId: "opencode",
    lateStatus: "failed" as const,
    winner
  };

  const observations = Array.from(
    { length: 8 },
    () => recordIgnoredLateChatTerminal(plugin, input)
  );
  await appendStarted.promise;
  assert.equal(appendAttempts, 1);
  releaseAppend.resolve();
  await Promise.all(observations);
  await recordIgnoredLateChatTerminal(plugin, input);
  assert.equal(appendAttempts, 1);
}

async function assertKnowledgeWatchdogUsesHarnessCancel(): Promise<void> {
  const calls: string[] = [];
  let watchdog: (() => void) | undefined;
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    setTimeout: (callback: () => void) => {
      watchdog = callback;
      return 1;
    }
  };
  const session: StoredSession = {
    id: "session-knowledge-watchdog",
    title: "Knowledge",
    kind: "knowledge-base",
    cwd: "/vault",
    threadId: "thread-knowledge-watchdog",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: "run-knowledge-watchdog",
    activeTurnId: "turn-knowledge-watchdog",
    activeRunKind: "knowledge-base",
    running: true,
    plugin: {
      cancelHarnessRun: async (runId: string) => { calls.push(`cancel:${runId}`); },
      interruptCodexHarnessTurn: async () => { calls.push("direct-interrupt"); },
      saveSettings: async () => { calls.push("history"); }
    },
    clearTurnWatchdog: () => undefined,
    isEditorActionRunActive: () => false,
    activeRunSession: () => session,
    isKnowledgeBaseSession: () => true,
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    addMessageToSession: () => undefined,
    clearActiveRun: () => { view.activeRunId = ""; },
    applyStatus: () => undefined
  };

  try {
    armTurnWatchdog(view, 1);
    assert.ok(watchdog);
    watchdog();
    assert.deepEqual(calls, ["cancel:run-knowledge-watchdog", "history"]);
  } finally {
    (globalThis as any).window = previousWindow;
  }
}

async function assertQueuedCodexChatSettlesViaAwaitResultAndAdvancesQueue(): Promise<void> {
  const firstMarkdown = "\n\n- **第一轮答案**\n- [保留链接](https://example.com)\n\n";
  const session: StoredSession = {
    id: "session-chat-await",
    title: "Chat await",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [
    { threadId: "thread-chat-await", turnId: "turn-chat-await-1", text: firstMarkdown },
    { threadId: "thread-chat-await", turnId: "turn-chat-await-2", text: "第二轮答案" }
  ]);

  harness.view.turnQueue.enqueue(queuedTurn("queued-chat-1", session.id, "第一问"));
  harness.view.turnQueue.enqueue(queuedTurn("queued-chat-2", session.id, "第二问"));

  await startNextQueuedTurn(harness.view, session.id);
  await waitFor(() => harness.startedTurns.length === 2 && harness.view.running === false, 500);

  assert.deepEqual(harness.startedTurns.map((item) => item.turnId), ["turn-chat-await-1", "turn-chat-await-2"]);
  assert.equal(harness.terminalCalls.length, 2);
  assert.equal(new Set(harness.terminalCalls.map((item) => item.runId)).size, 2);
  assert.equal(harness.harnessOutputs[0]?.backendBinding?.nativeThreadId, "thread-chat-await");
  assert.ok(harness.harnessOutputs[0]?.backendBinding?.leaseId);
  assert.equal(
    session.messages.filter((message) => message.role === "assistant" && message.itemType === "assistant" && message.status === "completed").length,
    2
  );
  assert.equal(
    session.messages.find((message) => message.role === "assistant" && message.runId === harness.terminalCalls[0]?.runId)?.text,
    firstMarkdown,
    "asynchronous settlement must preserve nonblank Markdown byte-for-byte"
  );
}

async function assertLateRunScopedNotificationsDoNotPolluteNextRunView(): Promise<void> {
  const session: StoredSession = {
    id: "session-active-b",
    title: "Chat B",
    cwd: "/vault",
    threadId: "thread-b",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const touched: string[] = [];
  const view: any = {
    activeRunId: "run-b",
    activeRunKind: "chat",
    activeRunSession: () => session,
    sessionForThread: () => null,
    clearTurnWatchdog: () => undefined,
    finishThinkingMessage: () => { touched.push("finish-thinking"); },
    finishRunningProcessMessages: () => { touched.push("finish-process"); },
    finishPlanMessage: () => { touched.push("finish-plan"); },
    addMessageToSession: () => { touched.push("error-message"); },
    clearActiveRun: () => { touched.push("clear-run"); },
    applyStatus: () => { touched.push("status"); },
    diagnoseCodexFailure: () => ({ title: "失败", text: "失败" }),
    afterTurnSettled: async () => { touched.push("queue"); }
  };
  const router = new CodexNotificationRouter(view);

  router.handle({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "item-a",
      delta: "stale"
    }
  });
  router.handle({
    method: "turn/completed",
    params: {
      threadId: "thread-a",
      turn: { id: "turn-a", threadId: "thread-a", status: "completed" }
    }
  });
  router.handle({
    method: "error",
    params: {
      threadId: "thread-a",
      message: "old run error"
    }
  });

  assert.deepEqual(touched, []);
  assert.equal(session.messages.length, 0);
}

async function assertUsageNotificationsReachDriverWithoutConsumingViewRoute(): Promise<void> {
  const hub = new CodexRichNotificationHub();
  const events: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub: hub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "hello", text_elements: [] }],
    startThread: async () => ({ threadId: "thread-usage-active", title: "Thread" }),
    resumeThread: async () => undefined,
    startTurn: async () => "turn-usage-active"
  });

  await adapter.run({
    runId: "run-usage-active",
    sessionId: "session-usage-active",
    input: { text: "hello", attachments: [] },
    permissions: { mode: "workspace-write", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: emptyContextBundle(),
    outputContract: { kind: "plain-text" }
  }, (event) => { events.push(event.type); });

  assert.equal(hub.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-usage-active",
      tokenUsage: { last: { inputTokens: 8, outputTokens: 3 }, total: { totalTokens: 11 } }
    }
  } as any), false);
  assert.equal(hub.dispatch({
    method: "thread/compacted",
    params: {
      threadId: "thread-usage-active",
      tokenUsage: { total: { totalTokens: 7 } }
    }
  } as any), false);
  assert.equal(hub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "thread-usage-active",
      turn: { id: "turn-usage-active", status: "completed" }
    }
  } as any), true);
  await adapter.awaitResult("run-usage-active");
  assert.deepEqual(
    events.filter((type) => type === "usage.updated" || type === "run.completed"),
    ["usage.updated", "run.completed"],
    "usage must reach the active driver while remaining available to the View router"
  );
}

async function assertUsageAndCompactionOnlyUpdateMatchingSessionThread(): Promise<void> {
  const sessionA: StoredSession = {
    id: "session-thread-a",
    title: "A",
    cwd: "/vault",
    threadId: "thread-a",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const sessionB: StoredSession = {
    id: "session-thread-b",
    title: "B",
    cwd: "/vault",
    threadId: "thread-b",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const usageUpdates: string[] = [];
  const compactions: string[] = [];
  const view: any = {
    activeRunSession: () => sessionB,
    activeRunKind: "chat",
    sessionForThread: (threadId: string) => {
      if (threadId === sessionA.threadId) return sessionA;
      if (threadId === sessionB.threadId) return sessionB;
      return null;
    },
    updateContextForSession: (session: StoredSession, usage: any) => {
      usageUpdates.push(`${session.id}:${usage?.total?.totalTokens ?? "<missing>"}`);
    },
    addContextCompactionMessage: (session: StoredSession) => {
      compactions.push(session.id);
    },
    plugin: { lastStatus: null }
  };
  const router = new CodexNotificationRouter(view);

  router.handle({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-a",
      tokenUsage: { total: { totalTokens: 23 } }
    }
  });
  router.handle({
    method: "thread/compacted",
    params: {
      threadId: "thread-b",
      tokenUsage: { total: { totalTokens: 17 } }
    }
  });
  router.handle({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "editor-thread",
      tokenUsage: { total: { totalTokens: 99 } }
    }
  });
  router.handle({
    method: "thread/compacted",
    params: {
      threadId: "unrelated-thread",
      tokenUsage: { total: { totalTokens: 101 } }
    }
  });

  assert.deepEqual(usageUpdates, ["session-thread-a:23", "session-thread-b:17"]);
  assert.deepEqual(compactions, ["session-thread-b"]);
}

async function assertViewCloseCancelsActiveRunDuringReload(): Promise<void> {
  const calls: string[] = [];
  const session = {
    id: "session-view-close",
    messages: [{ id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-view-close", createdAt: 1 }]
  };
  const view: any = {
    activeRunId: "run-view-close",
    activeRunKind: "chat",
    running: true,
    activeRunSession: () => session,
    clearTurnWatchdog: () => { calls.push("watchdog"); },
    clearEditorActionStatusTimers: () => { calls.push("editor-status-timers"); },
    clearEditorSummaryTimers: () => { calls.push("editor-summary-timers"); },
    clearKnowledgeBaseRunProgressTimer: () => { calls.push("kb-timer"); },
    knowledgeDashboardTooltipState: { panels: [], tooltips: [], closeTimers: new Set(), cleanups: [] },
    clearActiveRun: () => { calls.push("clear"); view.activeRunId = ""; },
    rejectEditorActionRun: () => undefined,
    rejectEditorSummaryRun: () => undefined,
    messageListRenderer: { dispose: () => { calls.push("message-list-dispose"); } },
    flushSessionSave: async () => { calls.push("save"); },
    plugin: {
      cancelHarnessRun: async (runId: string) => { calls.push(`cancel:${runId}`); },
      recoverInterruptedHarnessRuns: async (sessionId: string) => { calls.push(`recover:${sessionId}`); },
      saveSettings: async () => { calls.push("save"); }
    }
  };

  await CodexView.prototype.onClose.call(view);

  assert.ok(calls.includes("cancel:run-view-close"));
  assert.ok(calls.includes("recover:session-view-close"));
  assert.ok(calls.includes("save"));
  assert.ok(calls.includes("message-list-dispose"));
}

async function assertViewClosePreservesExistingAdapterWinner(): Promise<void> {
  const runId = "run-view-close-existing-adapter-winner";
  prepareChatSurfaceTerminal(runId);
  claimChatSurfaceTerminal(runId, "adapter", "completed");
  const calls: string[] = [];
  const session: StoredSession = {
    id: "session-view-close-existing-adapter-winner",
    title: "Existing adapter winner",
    cwd: "/vault",
    messages: [{
      id: "existing-adapter-answer",
      role: "assistant",
      itemType: "assistant",
      status: "completed",
      text: "durable answer",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const view: any = {
    activeRunId: runId,
    activeRunKind: "chat",
    running: true,
    activeRunSession: () => session,
    clearTurnWatchdog: () => undefined,
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    clearActiveRun: () => {
      view.activeRunId = "";
      view.activeRunKind = "";
    },
    messageListRenderer: { dispose: () => undefined },
    flushSessionSave: async () => {
      calls.push("flush");
    },
    plugin: {
      cancelHarnessRun: async () => {
        calls.push("cancel");
      },
      recoverInterruptedHarnessRuns: async () => {
        calls.push("recover");
      }
    }
  };

  await CodexView.prototype.onClose.call(view);

  assert.deepEqual(calls, ["cancel", "flush"]);
  assert.equal(session.messages[0]?.status, "completed");
  assert.equal(session.messages[0]?.text, "durable answer");
}

async function assertPromptEnhancerPreStartViewCloseAbortsWithoutCancelIntent(): Promise<void> {
  const calls: string[] = [];
  const lifecycle = new AbortController();
  const view: any = {
    viewLifecycleGeneration: 7,
    viewLifecycleAbortController: lifecycle,
    activeRunId: "",
    activeRunKind: "",
    promptEnhancerRunning: true,
    // Workspace/backend setup has not entered runEphemeralUtility yet, so the
    // service must not have published a cancellable Harness ID to the View.
    promptEnhancerRunId: "",
    promptEnhancerTurnId: "",
    clearTurnWatchdog: () => undefined,
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    flushSessionSave: async () => {
      calls.push("flush");
    },
    messageListRenderer: {
      dispose: () => {
        calls.push("dispose");
      }
    },
    plugin: {
      cancelHarnessRun: async () => {
        calls.push("cancel");
      }
    }
  };

  await CodexView.prototype.onClose.call(view);

  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(view.viewLifecycleGeneration, 8);
  assert.equal(view.promptEnhancerRunning, false);
  assert.equal(view.promptEnhancerRunId, "");
  assert.equal(view.promptEnhancerTurnId, "");
  assert.deepEqual(calls, ["flush", "dispose"]);
}

async function assertViewCloseCancellationWinsLateAsyncCompletion(): Promise<void> {
  const session: StoredSession = {
    id: "session-view-close-late-completed",
    title: "View close late completed",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-view-close-late-completed",
    turnId: "turn-view-close-late-completed",
    text: "late answer",
    autoComplete: false
  }]);
  const outcome = await startChatTurn(
    harness.view,
    session,
    queuedTurn(
      "view-close-late-completed",
      session.id,
      "continue"
    ),
    "composer"
  );
  assert.equal(outcome, "running");
  const runId = harness.view.activeRunId;
  const promptEnhancerRunId = "run-view-close-prompt-enhancer";
  const promptCancellationEntered = deferred<void>();
  const releasePromptCancellation = deferred<void>();
  const cancellationEntered = deferred<void>();
  const releaseCancellation = deferred<void>();
  let rendererDisposed = 0;

  harness.view.plugin.cancelHarnessRun = async (targetRunId: string) => {
    if (targetRunId === promptEnhancerRunId) {
      promptCancellationEntered.resolve();
      await releasePromptCancellation.promise;
      return;
    }
    assert.equal(targetRunId, runId);
    cancellationEntered.resolve();
    await releaseCancellation.promise;
  };
  harness.view.plugin.recoverInterruptedHarnessRuns = async (
    sessionId: string,
    options: { liveChatRunIds?: readonly string[] } = {}
  ) => {
    assert.equal(sessionId, session.id);
    assert.deepEqual(options.liveChatRunIds, [runId]);
    const recovery = await recoverStaleChatHarnessRuns({
      messages: session.messages,
      commitLocalHistory: async () => {
        await harness.view.plugin.saveSettings(true);
      },
      commitRunTerminal: async (terminal, persistWinner) => {
        await harness.view.plugin.commitChatSurfaceTerminal(terminal, {
          mode: "recovery-live",
          persistConversation: persistWinner
        });
      }
    });
    return recovery.settledRunIds.length;
  };
  Object.assign(harness.view, {
    promptEnhancerRunning: true,
    promptEnhancerRunId,
    promptEnhancerTurnId: "turn-view-close-prompt-enhancer",
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    flushSessionSave: async () => {
      await harness.view.plugin.saveSettings(true);
    },
    messageListRenderer: {
      dispose: () => {
        rendererDisposed += 1;
      }
    }
  });

  const close = CodexView.prototype.onClose.call(harness.view);
  await promptCancellationEntered.promise;
  assert.deepEqual(chatSurfaceTerminalClaim(runId), {
    runId,
    owner: "view-close",
    status: "cancelled",
    claimedAt: chatSurfaceTerminalClaim(runId)?.claimedAt
  });

  harness.notificationHub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "thread-view-close-late-completed",
      turn: {
        id: "turn-view-close-late-completed",
        threadId: "thread-view-close-late-completed",
        status: "completed"
      }
    }
  } as any);
  await waitFor(() => harness.ignoredLateTerminalAppendInputs.length === 1);
  releasePromptCancellation.resolve();
  await cancellationEntered.promise;
  releaseCancellation.resolve();
  await close;

  const ledgerEvents = await harness.ledger.readRun(runId);
  assert.equal(
    ledgerEvents.filter((event) => event.type === "run.cancelled").length,
    1
  );
  assert.equal(
    ledgerEvents.filter((event) => event.type === "run.completed").length,
    0,
    "a late async completion must not replace the view-close cancellation"
  );
  assert.equal(
    ledgerEvents.filter((event) => event.type === "run.surface_terminal.ignored").length,
    1
  );
  assert.deepEqual(harness.terminalCalls, [{ runId, status: "cancelled" }]);
  assert.equal(
    session.messages.find((message) => message.itemType === "assistant")?.status,
    "interrupted"
  );
  assert.equal(
    session.messages.some((message) => message.runTerminalRecoveryPending),
    false
  );
  assert.equal(harness.nativeSettlements.length, 1);
  assert.equal(harness.nativeSettlements[0]?.runOutcome, "cancelled");
  assert.equal(harness.nativeSettlements[0]?.localCommit.committed, true);
  assert.equal(rendererDisposed, 1);
}

async function assertViewCloseBeforeNativeRegistrationKeepsIntentRecoverable(): Promise<void> {
  const registrationEntered = deferred<void>();
  const releaseRegistration = deferred<void>();
  const session: StoredSession = {
    id: "session-view-close-before-native-registration",
    title: "View close before Native registration",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  const harness = createChatSurfaceHarness(session, [{
    threadId: "thread-view-close-before-native-registration",
    turnId: "turn-view-close-before-native-registration",
    text: "",
    autoComplete: false,
    beforeStartThread: async () => {
      registrationEntered.resolve();
      await releaseRegistration.promise;
    }
  }]);
  const turn = startChatTurn(
    harness.view,
    session,
    queuedTurn(
      "view-close-before-native-registration",
      session.id,
      "continue"
    ),
    "composer"
  );
  await registrationEntered.promise;
  const runId = harness.view.activeRunId;

  harness.view.plugin.recoverInterruptedHarnessRuns = async (
    sessionId: string,
    options: { liveChatRunIds?: readonly string[] } = {}
  ) => {
    assert.equal(sessionId, session.id);
    const recovery = await recoverStaleChatHarnessRuns({
      messages: session.messages,
      commitLocalHistory: async () => {
        await harness.view.plugin.saveSettings(true);
      },
      commitRunTerminal: async (terminal, persistWinner) => {
        await harness.view.plugin.commitChatSurfaceTerminal(terminal, {
          mode: options.liveChatRunIds?.includes(terminal.runId)
            ? "recovery-live"
            : "recovery-restart",
          persistConversation: persistWinner
        });
      }
    });
    return recovery.settledRunIds.length;
  };
  Object.assign(harness.view, {
    promptEnhancerRunning: false,
    promptEnhancerRunId: "",
    promptEnhancerTurnId: "",
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    knowledgeDashboardTooltipState: {
      panels: [],
      tooltips: [],
      closeTimers: new Set(),
      cleanups: []
    },
    flushSessionSave: async () => {
      await harness.view.plugin.saveSettings(true);
    },
    messageListRenderer: { dispose: () => undefined }
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await CodexView.prototype.onClose.call(harness.view);
  } finally {
    console.error = originalError;
  }

  assert.equal(
    session.messages.some((message) =>
      message.runId === runId
      && message.runTerminalRecoveryPending === "cancelled"
    ),
    true
  );
  assert.equal(harness.nativeSettlements.length, 0);

  releaseRegistration.resolve();
  assert.equal(await turn, "cancelled");
  await waitFor(() => harness.nativeSettlements.length === 1);
  assert.equal(harness.nativeSettlements[0]?.runOutcome, "cancelled");
  assert.equal(harness.nativeSettlements[0]?.localCommit.committed, false);

  assert.equal(
    await harness.view.plugin.recoverInterruptedHarnessRuns(session.id),
    1
  );
  assert.equal(
    session.messages.some((message) =>
      message.runId === runId
      && message.runTerminalRecoveryPending
    ),
    false
  );
  assert.equal(terminalEvents(await harness.ledger.readRun(runId)).length, 1);
  assert.equal(harness.nativeSettlements.length, 1);
}

async function assertViewCloseDisposesRendererWhenRecoveryFails(): Promise<void> {
  let disposeCalls = 0;
  const session = {
    id: "session-view-close-failure",
    messages: [{ id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-view-close-failure", createdAt: 1 }]
  };
  const view: any = {
    activeRunId: "run-view-close-failure",
    activeRunKind: "chat",
    running: true,
    activeRunSession: () => session,
    clearTurnWatchdog: () => undefined,
    clearEditorActionStatusTimers: () => undefined,
    clearKnowledgeBaseRunProgressTimer: () => undefined,
    knowledgeDashboardTooltipState: { panels: [], tooltips: [], closeTimers: new Set(), cleanups: [] },
    clearActiveRun: () => { view.activeRunId = ""; },
    messageListRenderer: { dispose: () => { disposeCalls += 1; } },
    flushSessionSave: async () => undefined,
    plugin: {
      cancelHarnessRun: async () => undefined,
      recoverInterruptedHarnessRuns: async () => { throw new Error("recovery failed"); }
    }
  };

  await assert.rejects(
    () => CodexView.prototype.onClose.call(view),
    /recovery failed/
  );
  assert.equal(disposeCalls, 1);
}

async function assertReloadChatRecoveryUsesCentralTerminalAndRetries(): Promise<void> {
  const session: StoredSession = {
    id: "session-reload-central-chat-terminal",
    title: "Reload central Chat terminal",
    kind: "chat",
    cwd: "/vault",
    messages: [{
      id: "reload-central-answer",
      role: "assistant",
      text: "partial",
      status: "running",
      runId: "run-reload-central-chat-terminal",
      backendId: "opencode",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sessions = [session];
  settings.activeSessionId = session.id;
  const centralInputs: any[] = [];
  let directTerminalCalls = 0;
  let centralAttempts = 0;
  let localCommits = 0;
  const plugin: any = {
    settings,
    commitChatSurfaceTerminal: async (input: any, options: any) => {
      centralAttempts += 1;
      centralInputs.push(structuredClone(input));
      assert.equal(options.mode, "recovery-restart");
      await options.persistConversation(input);
      if (centralAttempts === 1) {
        throw new Error("Native settlement intent unavailable");
      }
    },
    settleHarnessRunTerminal: async () => {
      directTerminalCalls += 1;
    }
  };
  const store = new EchoInkSettingsStore(plugin);
  (store as any).saveSettings = async () => {
    localCommits += 1;
  };

  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(
      await store.recoverInterruptedHarnessRuns(session.id),
      0,
      "a failed central settlement must remain pending"
    );
    assert.equal(session.messages[0]?.status, "interrupted");
    assert.equal(
      session.messages[0]?.runTerminalRecoveryPending,
      "cancelled"
    );
    assert.equal(centralAttempts, 1);
    assert.equal(directTerminalCalls, 0);

    assert.equal(await store.recoverInterruptedHarnessRuns(session.id), 1);
    assert.equal(centralAttempts, 2);
    assert.equal(directTerminalCalls, 0);
    assert.equal(session.messages[0]?.runTerminalRecoveryPending, undefined);
    assert.equal(session.messages[0]?.runTerminalRecovered, true);

    assert.equal(await store.recoverInterruptedHarnessRuns(session.id), 0);
  } finally {
    console.error = originalError;
  }

  assert.equal(centralAttempts, 2, "recovered terminals must be idempotent");
  assert.equal(localCommits, 3);
  assert.deepEqual(centralInputs, [
    {
      runId: "run-reload-central-chat-terminal",
      backendId: "opencode",
      status: "cancelled",
      error: "插件重载导致运行中断"
    },
    {
      runId: "run-reload-central-chat-terminal",
      backendId: "opencode",
      status: "cancelled",
      error: "插件重载导致运行中断"
    }
  ]);
}

async function assertReloadProjectsDurableTerminalWinnerBeforeConversationSave(): Promise<void> {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const runId = `run-reload-durable-${status}`;
    const session: StoredSession = {
      id: `session-reload-durable-${status}`,
      title: `Reload durable ${status}`,
      kind: "chat",
      cwd: "/vault",
      messages: [{
        id: `answer-reload-durable-${status}`,
        role: "assistant",
        itemType: "assistant",
        status: "running",
        text: "partial",
        runId,
        backendId: "hermes",
        createdAt: 1
      }],
      createdAt: 1,
      updatedAt: 1
    };
    const ledger = new InMemoryRunLedger();
    await ledger.append({
      ...terminalEvent(runId, status, "hermes"),
      ...(status === "completed"
        ? { text: "durable completed answer" }
        : { error: `durable ${status}` })
    });
    const harness = createServiceReceiptTestBed({
      sessionId: session.id,
      session,
      ledger
    });
    const persistedStatuses: Array<string | undefined> = [];

    await harness.service.commitChatSurfaceTerminal({
      runId,
      status: "cancelled",
      backendId: "hermes",
      error: "reload candidate"
    }, {
      mode: "recovery-restart",
      persistConversation: async (winner) => {
        applyChatRunTerminalWinner(session.messages, winner);
        persistedStatuses.push(session.messages[0]?.status);
        await harness.plugin.saveSettings(true);
      }
    });

    assert.deepEqual(persistedStatuses, [
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : "interrupted"
    ]);
    assert.equal(
      session.messages[0]?.runTerminalRecoveryPending,
      status
    );
    assert.equal(terminalEvents(await ledger.readRun(runId)).length, 1);
    if (status === "completed") {
      assert.equal(session.messages[0]?.text, "durable completed answer");
    }
  }
}

async function assertReloadRecoveryCommitsLocalHistoryBeforeLedgerTerminal(): Promise<void> {
  const calls: string[] = [];
  const messages: any[] = [
    { id: "user", role: "user", text: "start", runId: "run-reload", backendId: "hermes", createdAt: 1 },
    { id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-reload", backendId: "hermes", createdAt: 2 },
    { id: "thinking", role: "assistant", text: "", itemType: "thinking", status: "running", runId: "run-reload", createdAt: 3 }
  ];

  const result = await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => { calls.push("local"); },
    settleRunTerminal: async (terminal) => { calls.push(`terminal:${terminal.status}:${terminal.backendId}`); }
  });

  assert.deepEqual(calls, ["local", "terminal:cancelled:hermes", "local"]);
  assert.equal(result.settledMessageCount, 2);
  assert.deepEqual(result.settledRunIds, ["run-reload"]);
  assert.equal(messages.find((message) => message.id === "answer")?.status, "interrupted");
  assert.equal(messages.some((message) => message.runTerminalRecoveryPending), false);
}

async function assertReloadRecoveryKeepsTerminalPendingWhenLocalCommitFails(): Promise<void> {
  const messages: any[] = [
    { id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-local-fail", createdAt: 1 }
  ];
  let terminalCalls = 0;

  await assert.rejects(recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => { throw new Error("disk full"); },
    settleRunTerminal: async () => { terminalCalls += 1; }
  }), /disk full/);

  assert.equal(terminalCalls, 0, "ledger terminal must wait for durable local history");
  assert.equal(messages[0].status, "interrupted");
  assert.equal(messages[0].runTerminalRecoveryPending, "cancelled");
}

async function assertReloadRecoveryRetriesFailedLedgerTerminal(): Promise<void> {
  const messages: any[] = [
    { id: "answer", role: "assistant", text: "partial", status: "running", runId: "run-ledger-retry", createdAt: 1 }
  ];
  let attempts = 0;
  const first = await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => undefined,
    settleRunTerminal: async () => { attempts += 1; throw new Error("ledger unavailable"); }
  });
  assert.deepEqual(first.failedRunIds, ["run-ledger-retry"]);
  assert.equal(messages[0].runTerminalRecoveryPending, "cancelled");

  const second = await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => undefined,
    settleRunTerminal: async () => { attempts += 1; }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(second.settledRunIds, ["run-ledger-retry"]);
  assert.equal(messages[0].runTerminalRecoveryPending, undefined);
}

async function assertReloadRecoveryBackfillsLegacyInterruptedRunOnce(): Promise<void> {
  const messages: any[] = [
    { id: "legacy", role: "assistant", text: "partial", status: "interrupted", runId: "run-legacy-interrupted", backendId: "codex-cli", createdAt: 1 }
  ];
  let terminals = 0;
  const recover = async () => await recoverStaleHarnessRuns({
    messages,
    commitLocalHistory: async () => undefined,
    settleRunTerminal: async () => { terminals += 1; }
  });

  assert.deepEqual((await recover()).settledRunIds, ["run-legacy-interrupted"]);
  assert.equal(messages[0].runTerminalRecovered, true);
  assert.deepEqual((await recover()).settledRunIds, []);
  assert.equal(terminals, 1);
}

async function assertEachSurfaceHasOneTerminalOwner(): Promise<void> {
  const root = process.cwd();
  const [main, chatRunner, lifecycle, knowledge, knowledgeManager, editor] = await Promise.all([
    readFile(path.join(root, "src/main.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/turn-runner.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/turn-lifecycle.ts"), "utf8"),
    readFile(path.join(root, "src/knowledge-base/agent-task-service.ts"), "utf8"),
    readFile(path.join(root, "src/knowledge-base/manager.ts"), "utf8"),
    readFile(path.join(root, "src/ui/codex-view/editor-action-runner.ts"), "utf8")
  ]);

  assert.match(main, /settleHarnessRunTerminal\(input: SettleRunTerminalInput/);
  assert.match(
    main,
    /commitChatSurfaceTerminal\(\s*input: SettleRunTerminalInput/
  );
  assert.match(chatRunner, /persistAndSettleChatRun\(view\.plugin/);
  assert.match(
    lifecycle,
    /export async function persistAndSettleChatRun[\s\S]*await plugin\.commitChatSurfaceTerminal\(input\)/
  );
  assert.doesNotMatch(
    chatRunner,
    /\.settleHarnessRunTerminal\(/,
    "Chat terminal persistence must go through the durable Conversation + Run Ledger gate"
  );
  assert.match(lifecycle, /status: "cancelled"/);
  assert.match(lifecycle, /status: "failed"/);
  assert.doesNotMatch(methodBody(lifecycle, "export async function stopTurn(", "export function armTurnWatchdog("), /interruptCodexHarnessTurn|backendId === "codex-cli"/);
  assert.match(methodBody(lifecycle, "export async function stopTurn(", "export function armTurnWatchdog("), /cancelHarnessRun\(runId\)/);
  assert.match(knowledge, /settleKnowledgeHarnessRun\(\{[\s\S]*status: "completed"/);
  assert.doesNotMatch(`${knowledge}\n${knowledgeManager}`, /CodexKbWaiter|codexWaiter|finishCodexWaiter|markCodexWaiterActivity/);
  assert.match(editor, /awaitResult\(/);
  assert.doesNotMatch(editor, /waitForResult|resolveEditorActionHarnessOutput|editorSummaryRun/);
}

function methodBody(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Expected method range ${start} -> ${end}`);
  return source.slice(startIndex, endIndex);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

interface ServiceReceiptStateView {
  receipts: Map<string, unknown>;
  settledRecordIds: Set<string>;
  registrationsClosed: boolean;
  intent?: {
    status: "completed" | "failed" | "cancelled";
    runOutcome: "success" | "failed" | "cancelled";
    terminalCommitId: string;
  };
}

interface ServiceNativeManagerDouble {
  records: Map<string, NativeExecutionRecord>;
  settlementAttempts: SettleNativeExecutionInput[];
  recordCreated(record: NativeExecutionRecord): Promise<void>;
  settleRun(input: SettleNativeExecutionInput): Promise<NativeExecutionRecord | null>;
  listPendingLocalCommits(filter?: {
    surface?: string;
    sessionId?: string;
  }): Promise<NativeExecutionRecord[]>;
}

interface PendingLargeRawAuthorityFixture {
  answer: any;
  session: StoredSession;
  terminal: {
    runId: string;
    status: "completed";
    backendId: "hermes";
    text: string;
    data: { source: string };
  };
  rawTexts: Map<string, string>;
  backingLedger: InMemoryRunLedger;
  harness: ReturnType<typeof createServiceReceiptTestBed>;
}

async function createPendingLargeRawAuthorityFixture(
  label: string
): Promise<PendingLargeRawAuthorityFixture> {
  const runId = `run-raw-restart-${label}`;
  const answer: any = {
    id: `answer-raw-restart-${label}`,
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "",
    runId,
    backendId: "hermes",
    createdAt: 1
  };
  const session: StoredSession = {
    id: `session-raw-restart-${label}`,
    title: `Raw restart ${label}`,
    cwd: "/vault",
    messages: [answer],
    createdAt: 1,
    updatedAt: 1
  };
  const rawTexts = new Map<string, string>();
  const backingLedger = new InMemoryRunLedger();
  let failFirstTerminalAppend = true;
  const ledger: RunLedger = {
    async append(event) {
      if (isTerminalHarnessEvent(event) && failFirstTerminalAppend) {
        failFirstTerminalAppend = false;
        throw new Error("Run Ledger unavailable");
      }
      await backingLedger.append(event);
    },
    async readRun(targetRunId) {
      return await backingLedger.readRun(targetRunId);
    }
  };
  const harness = createServiceReceiptTestBed({
    sessionId: session.id,
    session,
    ledger,
    rawTexts
  });
  const terminal = {
    runId,
    status: "completed" as const,
    backendId: "hermes" as const,
    text: `${label}:${"R".repeat(90_000)}`,
    data: { source: label }
  };
  await assert.rejects(
    () => harness.service.commitChatSurfaceTerminal(terminal),
    /Run Ledger unavailable/
  );
  assert.equal(answer.runTerminalRecoveryPending, "completed");
  assert.equal(answer.echoInkRunTerminalRecovery?.payloadSource.kind, "raw");
  return {
    answer,
    session,
    terminal,
    rawTexts,
    backingLedger,
    harness
  };
}

async function recoverPendingLargeRawAuthority(
  fixture: PendingLargeRawAuthorityFixture
) {
  return await recoverStaleChatHarnessRuns({
    messages: fixture.session.messages,
    commitLocalHistory: async () => {
      await fixture.harness.plugin.saveSettings(true);
    },
    commitRunTerminal: async (terminal, persistWinner) => {
      await fixture.harness.service.commitChatSurfaceTerminal(terminal, {
        mode: "recovery-restart",
        persistConversation: persistWinner
      });
    }
  });
}

interface RealConversationPartialSaveFixture {
  runId: string;
  session: StoredSession;
  service: EchoInkHarnessService;
  ledger: InMemoryRunLedger;
  failNextDataSave(): void;
  dataSaveFailures(): number;
  createRestartedSettingsStore(): EchoInkSettingsStore;
  dispose(): Promise<void>;
}

async function createRealConversationPartialSaveFixture(
  label: string
): Promise<RealConversationPartialSaveFixture> {
  const vaultPath = await mkdtemp(path.join(
    tmpdir(),
    `echoink-chat-partial-save-${label}-`
  ));
  const runId = `run-${label}`;
  const session: StoredSession = {
    id: `session-${label}`,
    title: `Partial save ${label}`,
    cwd: vaultPath,
    revision: 1,
    generation: 1,
    contextId: `context-${label}`,
    commitId: `commit-${label}`,
    workspaceFingerprint: workspaceFingerprint({
      vaultPath,
      cwd: vaultPath
    }),
    messages: [{
      id: `answer-${label}`,
      role: "assistant",
      itemType: "assistant",
      status: "running",
      text: "streaming",
      runId,
      backendId: "codex-cli",
      createdAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "codex-cli";
  settings.capabilities.chatBackend = "default";
  settings.sessions = [session];
  settings.activeSessionId = session.id;
  let persistedData: unknown = structuredClone(settings);
  let failNextSave = false;
  let dataSaveFailureCount = 0;
  const plugin: any = {
    settings,
    loadData: async () => structuredClone(persistedData),
    saveData: async (data: unknown) => {
      if (failNextSave) {
        failNextSave = false;
        dataSaveFailureCount += 1;
        throw new Error("data.json persistence unavailable");
      }
      persistedData = structuredClone(data);
    },
    getVaultPath: () => vaultPath,
    getPluginDataDirName: () => "codex-echoink",
    ensureEchoInkConversationSessionCreated: async () => undefined,
    ensureEchoInkSessionContextIdentity: async () => undefined,
    agentRuntimeHealth: {
      reportHealthy: () => undefined,
      reportFailure: () => undefined
    }
  };
  const seedConversationStore = new FileConversationStore({
    rootPath: path.join(
      pluginDataDir(vaultPath, "codex-echoink"),
      "conversations"
    )
  });
  await seedConversationStore.createPristineSession({
    ...structuredClone(session),
    messages: []
  });
  const settingsStore = new EchoInkSettingsStore(plugin);
  plugin.saveSettings = async (
    force = false,
    options: Record<string, unknown> = {}
  ) => await settingsStore.saveSettings(force, {
    ...options,
    flushKnowledgeBaseHistory: false
  });
  plugin.readEchoInkConversationSession = async (sessionId: string) =>
    await settingsStore.readConversationSession(sessionId);
  plugin.externalizeMessageText = async (message: any, text: string) =>
    await settingsStore.externalizeMessageText(message, text);
  plugin.readRawMessageText = async (rawRef: string) =>
    await settingsStore.readRawMessageText(rawRef);
  await settingsStore.saveSettings(true, {
    flushKnowledgeBaseHistory: false
  });

  const ledger = new InMemoryRunLedger();
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: () => session
  });
  const service = new EchoInkHarnessService(plugin);
  (service as any).getHarnessKernel = () => kernel;

  return {
    runId,
    session,
    service,
    ledger,
    failNextDataSave() {
      failNextSave = true;
    },
    dataSaveFailures() {
      return dataSaveFailureCount;
    },
    createRestartedSettingsStore() {
      return new EchoInkSettingsStore({
        settings: structuredClone(DEFAULT_SETTINGS),
        getVaultPath: () => vaultPath,
        getPluginDataDirName: () => "codex-echoink"
      } as never);
    },
    async dispose() {
      await rm(vaultPath, { recursive: true, force: true });
    }
  };
}

function createServiceReceiptTestBed(options: {
  sessionId: string;
  session?: StoredSession;
  ledger?: RunLedger;
  nativeManager?: ServiceNativeManagerDouble;
  saveFailures?: number;
  saveFailureAtCalls?: number[];
  conversationReadFailures?: number;
  settlementFailures?: number;
  rawTexts?: Map<string, string>;
}): {
  service: EchoInkHarnessService;
  session: StoredSession;
  ledger: RunLedger;
  nativeManager: ServiceNativeManagerDouble;
  saveCalls: string[];
  plugin: any;
} {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agentBackend = "codex-cli";
  settings.capabilities.chatBackend = "default";
  const session: StoredSession = options.session ?? {
    id: options.sessionId,
    title: "Service receipt fixture",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1
  };
  session.revision = session.revision ?? 1;
  session.generation = session.generation ?? session.revision;
  session.contextId = session.contextId ?? `context-${options.sessionId}`;
  session.commitId = session.commitId ?? `commit-${options.sessionId}`;
  session.workspaceFingerprint = session.workspaceFingerprint ?? workspaceFingerprint({
    vaultPath: "/vault",
    cwd: "/vault"
  });
  settings.sessions = [session];
  settings.activeSessionId = session.id;
  const ledger = options.ledger ?? new InMemoryRunLedger();
  const saveCalls: string[] = [];
  let remainingSaveFailures = options.saveFailures ?? 0;
  const saveFailureAtCalls = new Set(options.saveFailureAtCalls ?? []);
  let remainingConversationReadFailures =
    options.conversationReadFailures ?? 0;
  let remainingSettlementFailures = options.settlementFailures ?? 0;
  const rawTexts = options.rawTexts ?? new Map<string, string>();
  let persistedSession = structuredClone(session);
  const records = options.nativeManager?.records
    ?? new Map<string, NativeExecutionRecord>();
  const settlementAttempts = options.nativeManager?.settlementAttempts ?? [];
  const nativeManager: ServiceNativeManagerDouble = options.nativeManager ?? {
    records,
    settlementAttempts,
    async recordCreated(record) {
      const existing = records.get(record.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`Native record identity conflict: ${record.id}`);
      }
      if (!existing) records.set(record.id, structuredClone(record));
    },
    async settleRun(input) {
      settlementAttempts.push(structuredClone(input));
      if (remainingSettlementFailures > 0) {
        remainingSettlementFailures -= 1;
        throw new Error("Transient Native settlement failure");
      }
      const record = records.get(input.recordId);
      if (!record) return null;
      record.runOutcome = input.runOutcome;
      record.settledAt = Date.now();
      if (input.localCommit.committed) {
        record.localCommit = "committed";
        record.cleanup = "not-needed";
        record.committedAt = Date.now();
        record.lastError = "";
      } else {
        record.localCommit = "failed";
        record.cleanup = "retained-for-recovery";
        record.lastError = input.localCommit.error ?? "Local durable commit failed";
      }
      return structuredClone(record);
    },
    async listPendingLocalCommits(filter = {}) {
      return Array.from(records.values())
        .filter((record) =>
          record.localCommit === "pending"
          && (!filter.surface || record.surface === filter.surface)
          && (!filter.sessionId || record.sessionId === filter.sessionId)
        )
        .map((record) => structuredClone(record));
    }
  };
  const plugin: any = {
    settings,
    getVaultPath: () => "/vault",
    getPluginDataDirName: () => "codex-echoink",
    externalizeMessageText: async (message: any, text: string) => {
      const write = prepareRawMessage(message, text);
      if (write) rawTexts.set(write.rawRef, write.text);
    },
    readRawMessageText: async (rawRef: string) => {
      const text = rawTexts.get(rawRef);
      if (text === undefined) throw new Error(`Raw text not found: ${rawRef}`);
      return text;
    },
    readEchoInkConversationSession: async (sessionId: string) => {
      if (remainingConversationReadFailures > 0) {
        remainingConversationReadFailures -= 1;
        throw new Error("Conversation strict readback unavailable");
      }
      return sessionId === persistedSession.id
        ? structuredClone(persistedSession)
        : null;
    },
    saveSettings: async () => {
      saveCalls.push("save");
      const shouldFail = remainingSaveFailures > 0
        || saveFailureAtCalls.has(saveCalls.length);
      if (shouldFail) {
        if (remainingSaveFailures > 0) remainingSaveFailures -= 1;
        throw new Error("Conversation persistence unavailable");
      }
      persistedSession = structuredClone(session);
    },
    ensureEchoInkConversationSessionCreated: async () => undefined,
    ensureEchoInkSessionContextIdentity: async () => undefined,
    agentRuntimeHealth: {
      reportHealthy: () => undefined,
      reportFailure: () => undefined
    }
  };
  const kernel = new EchoInkHarnessKernel({
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: () => session
  });
  const service = new EchoInkHarnessService(plugin);
  (service as any).getHarnessKernel = () => kernel;
  (service as any).getNativeExecutionManager = () => nativeManager;
  const runWithAdapter = service.runWithAdapter.bind(service);
  service.runWithAdapter = async (input) => {
    if (
      input.request.workflow === "chat.generic"
      && !session.messages.some((message) => message.runId === input.request.runId)
    ) {
      session.messages.push({
        id: `${input.request.runId}-user`,
        role: "user",
        text: input.request.input.text,
        runId: input.request.runId,
        backendId: input.request.backendId,
        createdAt: 1
      }, {
        id: `${input.request.runId}-answer`,
        role: "assistant",
        itemType: "assistant",
        status: "running",
        text: "",
        runId: input.request.runId,
        backendId: input.request.backendId,
        createdAt: 2
      });
    }
    return await runWithAdapter(input);
  };

  return {
    service,
    session,
    ledger,
    nativeManager,
    saveCalls,
    plugin
  };
}

function createServiceTestAdapter(input: {
  result: AgentRunResult;
  native?: NativeExecutionRef;
  beforeRegistration?: () => Promise<void> | void;
  emittedTerminal?: "completed" | "failed" | "cancelled";
}): AgentAdapter {
  return {
    manifest: {
      id: "codex-cli",
      displayName: "Codex test",
      version: "test",
      capabilities: {
        ...noCapabilities(),
        sessions: { resume: "emulated", fork: "none" },
        output: {
          streaming: "emulated",
          reasoningSummary: "none",
          thinkingTrace: "none",
          planEvents: "none",
          usage: "none"
        },
        input: { text: "native", image: "none", pdf: "none" },
        cancellation: "emulated"
      }
    },
    async connect(): Promise<AgentConnectionStatus> {
      return {
        connected: true,
        label: "Codex test",
        version: "test",
        errors: []
      };
    },
    async dispose(): Promise<void> {
      return undefined;
    },
    async listModels(): Promise<Array<{ id: string; displayName: string }>> {
      return [];
    },
    async run(request: AgentRunRequest, emit: HarnessEventSink): Promise<AgentRunResult> {
      await input.beforeRegistration?.();
      if (input.native) {
        await request.registerNativeExecution?.(input.native);
      }
      if (input.emittedTerminal) {
        await emit(terminalEvent(
          request.runId,
          input.emittedTerminal,
          "codex-cli"
        ));
      }
      return input.result;
    }
  };
}

function serviceChatRequest(runId: string, sessionId: string): HarnessRunRequest {
  return {
    runId,
    sessionId,
    surface: "chat",
    workflow: "chat.generic",
    backendId: "codex-cli",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "ping", attachments: [] },
    permissions: {
      mode: "workspace-write",
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
    outputContract: { kind: "plain-text" }
  };
}

function serviceTestNative(id: string): NativeExecutionRef {
  return {
    backendId: "codex-cli",
    id,
    kind: "thread",
    persistence: "provider-persistent",
    deviceKey: "device-surface-test",
    vaultId: "/vault",
    createdAt: 1
  };
}

function receiptStateForRun(
  service: EchoInkHarnessService,
  runId: string
): ServiceReceiptStateView | undefined {
  return ((service as any).chatNativeReceipts as Map<string, ServiceReceiptStateView>)
    .get(runId);
}

function terminalEvents(events: HarnessEvent[]): HarnessEvent[] {
  return events.filter(isTerminalHarnessEvent);
}

function isTerminalHarnessEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled";
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function queuedTurn(id: string, sessionId: string, text: string): any {
  return {
    id,
    sessionId,
    text,
    attachments: [],
    skill: null,
    turnOptions: {
      model: "gpt-test",
      permission: "workspace-write",
      serviceTier: "auto",
      reasoningEffort: "medium",
      mcpEnabled: true,
      codexResourceOverrides: { plugins: {}, mcpServers: {}, skills: {} }
    },
    kind: "chat",
    createdAt: Date.now()
  };
}

function terminalEvent(
  runId: string,
  status: "completed" | "failed" | "cancelled",
  backendId: string
): HarnessEvent {
  return {
    eventId: `${runId}:terminal`,
    runId,
    sequence: 1,
    createdAt: 1,
    source: "kernel",
    type: status === "completed"
      ? "run.completed"
      : status === "cancelled"
        ? "run.cancelled"
        : "run.failed",
    backendId
  };
}

interface PlannedChatTurn {
  threadId: string;
  turnId: string;
  text: string;
  autoComplete?: boolean;
  beforeStartThread?: () => Promise<void>;
}

function createChatSurfaceHarness(
  session: StoredSession,
  plannedTurns: PlannedChatTurn[],
  options: {
    ledger?: RunLedger;
  } = {}
): {
  view: any;
  terminalCalls: Array<{ runId: string; status: string }>;
  startedTurns: Array<{ threadId: string; turnId: string }>;
  startedThreads: string[];
  notificationHub: CodexRichNotificationHub;
  renderedSnapshots: StoredSession["messages"][];
  harnessOutputs: any[];
  ledger: RunLedger;
  nativeSettlements: any[];
  nativeRecords: Map<string, NativeExecutionRecord>;
  saveCalls: string[];
  afterTurnSettledCalls: Array<{ sessionId: string; succeeded: boolean }>;
  ignoredLateTerminalAppendInputs: any[];
} {
  session.revision = session.revision ?? 1;
  session.generation = session.generation ?? session.revision;
  session.contextId = session.contextId ?? `context-${session.id}`;
  session.commitId = session.commitId ?? `commit-${session.id}`;
  session.workspaceFingerprint = session.workspaceFingerprint ?? workspaceFingerprint({
    vaultPath: "/vault",
    cwd: "/vault"
  });
  const notificationHub = new CodexRichNotificationHub();
  const serviceBed = createServiceReceiptTestBed({
    sessionId: session.id,
    session,
    ledger: options.ledger
  });
  const { service, ledger, nativeManager } = serviceBed;
  const settings = serviceBed.plugin.settings;
  const terminalCalls: Array<{ runId: string; status: string }> = [];
  const startedTurns: Array<{ threadId: string; turnId: string }> = [];
  const startedThreads: string[] = [];
  const renderedSnapshots: StoredSession["messages"][] = [];
  const harnessOutputs: any[] = [];
  const nativeSettlements = nativeManager.settlementAttempts;
  const saveCalls = serviceBed.saveCalls;
  const afterTurnSettledCalls: Array<{ sessionId: string; succeeded: boolean }> = [];
  const ignoredLateTerminalAppendInputs: any[] = [];
  const view: any = {
    plugin: {
      ...serviceBed.plugin,
      settings,
      getVaultPath: () => "/vault",
      getNativeExecutionRefContext: () => ({
        deviceKey: "device-surface-test",
        vaultId: "/vault"
      }),
      ensureHarnessBackendConnected: async () => null,
      runHarnessWithAdapter: async (input: any) => {
        const output = await service.runWithAdapter(input);
        harnessOutputs.push(output);
        return output;
      },
      commitChatSurfaceTerminal: async (input: any, options?: any) => {
        terminalCalls.push({ runId: input.runId, status: input.status });
        await service.commitChatSurfaceTerminal(input, options);
      },
      appendHarnessRunEvent: async (input: any) => {
        if (input.type === "run.surface_terminal.ignored") {
          ignoredLateTerminalAppendInputs.push(input);
        }
        return await service.appendRunEvent(input);
      },
      cancelHarnessRun: async (runId: string) => await service.cancelRun(runId),
      createCodexRichAgentAdapter: (options: any) => new CodexRichAgentAdapter({
        ...options,
        notificationHub,
        startThread: async () => {
          const plan = plannedTurns[startedThreads.length] ?? plannedTurns[0];
          await plan?.beforeStartThread?.();
          const threadId = plan?.threadId ?? "thread-chat-await";
          startedThreads.push(threadId);
          return { threadId, title: "Thread" };
        },
        resumeThread: async () => undefined,
        startTurn: async (threadId: string) => {
          const plan = plannedTurns[startedTurns.length];
          assert.ok(plan, "missing planned Codex turn");
          startedTurns.push({ threadId, turnId: plan.turnId });
          if (plan.autoComplete === false) return plan.turnId;
          setTimeout(() => {
            notificationHub.dispatch({
              method: "item/completed",
              params: {
                item: {
                  id: `assistant-${plan.turnId}`,
                  threadId,
                  turnId: plan.turnId,
                  type: "agentMessage",
                  text: plan.text
                }
              }
            } as any);
            notificationHub.dispatch({
              method: "turn/completed",
              params: {
                threadId,
                turn: {
                  id: plan.turnId,
                  threadId,
                  status: "completed"
                }
              }
            } as any);
          }, 0);
          return plan.turnId;
        },
        interruptTurn: async () => undefined
      }),
      externalizeMessageText: async () => undefined,
      getKnowledgeBaseManager: () => null,
      listEchoInkMcpTools: async () => []
    },
    turnQueue: new RuntimeTurnQueue(),
    queueStartInProgress: false,
    running: false,
    activeRunId: "",
    activeRunKind: "",
    activeRunSessionId: "",
    activeTurnId: "",
    activeRunNativeExecutionRecordIds: [],
    turnStartedAt: 0,
    turnWatchdog: null,
    editorActionActiveTimeoutMs: 0,
    editorActionThreadId: "",
    editorActionCurrentItemIds: new Set<string>(),
    messagesBottomFollowPaused: false,
    sessionById: (sessionId: string) => sessionId === session.id ? session : null,
    clearComposerDraft: () => undefined,
    pauseQueueForSession: () => undefined,
    isEditorActionRunActive: () => false,
    setEditorActionStatus: () => undefined,
    renderQueue: () => undefined,
    renderToolbar: () => undefined,
    renderTabs: () => undefined,
    renderMessages: () => undefined,
    renderMessagesIfActive: () => { renderedSnapshots.push(structuredClone(session.messages)); },
    applyStatus: () => undefined,
    ensureThinkingMessage: () => undefined,
    armTurnWatchdog: () => undefined,
    clearTurnWatchdog: () => {
      view.turnWatchdog = null;
    },
    finishThinkingMessage: () => undefined,
    finishRunningProcessMessages: () => undefined,
    finishPlanMessage: () => undefined,
    addMessageToSession: (_session: StoredSession, message: any) => {
      session.messages.push({ id: `message-${session.messages.length}`, createdAt: Date.now(), ...message });
    },
    clearActiveRun: () => {
      view.activeRunId = "";
      view.activeRunKind = "";
      view.activeRunSessionId = "";
      view.activeRunNativeExecutionRecordIds = [];
    },
    attachTurnIdToRun: () => undefined,
    isKnowledgeBaseSession: () => false,
    diagnoseCodexFailure: () => ({ title: "失败", text: "失败" }),
    activeRunSession: () => session
  };
  view.startQueuedTurnItem = (item: any, source: "composer" | "queue") => startQueuedTurnItem(view, item, source);
  view.startQueuedTurnItemSafely = (item: any, source: "composer" | "queue") => startQueuedTurnItemSafely(view, item, source);
  view.startChatTurn = (target: StoredSession, item: any, source: "composer" | "queue") => startChatTurn(view, target, item, source);
  view.startNextQueuedTurn = (sessionId: string) => startNextQueuedTurn(view, sessionId);
  view.afterTurnSettled = async (sessionId: string, succeeded: boolean) => {
    afterTurnSettledCalls.push({ sessionId, succeeded });
    await afterTurnSettled(view, sessionId, succeeded);
  };
  return {
    view,
    terminalCalls,
    startedTurns,
    startedThreads,
    notificationHub,
    renderedSnapshots,
    harnessOutputs,
    ledger,
    nativeSettlements,
    nativeRecords: nativeManager.records,
    saveCalls,
    afterTurnSettledCalls,
    ignoredLateTerminalAppendInputs
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 120): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`Timed out after ${timeoutMs}ms`);
}
