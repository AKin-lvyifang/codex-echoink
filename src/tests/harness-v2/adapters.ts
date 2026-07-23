import * as assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { TaskRuntimeAgentAdapter } from "../../harness/agents/adapters/task-runtime-adapter";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { CodexRichRunDriver } from "../../harness/agents/adapters/codex-rich-driver";
import { CodexRichNotificationHub } from "../../harness/agents/adapters/codex-rich-notification-hub";
import { FakeFourthAgentAdapter } from "../../harness/agents/adapters/fake-fourth";
import { createHarnessAgentAdapter } from "../../harness/agents/adapter-factory";
import { createEchoInkMcpToolBridgeRuntime } from "../../agent/tool-bridge";
import { createAgentEventRuntimeWithFallback } from "../../agent/event-task";
import { hermesAcpLaunchArgs } from "../../agent/factory";
import { isTrustedExactWriteFenceReceipt } from "../../agent/write-fence";
import { AcpAgentRuntime, type AcpSubprocessLike } from "../../agent/acp-runtime";
import { HermesBackend } from "../../core/hermes-backend";
import {
  RunOrchestrator,
  type BeforeBindingReplacementInput
} from "../../harness/kernel/run-orchestrator";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import {
  DEFAULT_SETTINGS,
  type ChatMessage
} from "../../settings/settings";
import type { AgentTaskRuntime } from "../../agent/runtime";
import type {
  AgentNativeExecutionDescriptor,
  AgentTaskInput,
  AgentTaskResult
} from "../../agent/types";
import type { AgentConnectionStatus } from "../../agent/types";
import type { AgentRunResult } from "../../harness/agents/adapter";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { NativeExecutionRef } from "../../harness/contracts/native-execution";
import { compileContextBundle } from "../../harness/kernel/context-compiler";
import { workspaceFingerprint } from "../../harness/kernel/session-service";
import { harnessInitialMessageModelId, harnessMessageModelId } from "../../harness/agents/backend-runtime-profile";
import { HarnessEventProjector } from "../../ui/codex-view/harness-event-projector";
import { runCodexBrokerOrchestratorRegressionTests } from "../codex-broker-orchestrator-regression";

export async function runHarnessV2AdapterTests(): Promise<void> {
  await assertTaskRuntimeAdapterRunsThroughHarnessContract();
  await assertTaskRuntimeAdaptersAwaitDurableRegistration();
  await assertLegacyRegistrationBarrierRejectsMissingRuntimeCallback();
  await assertUnsafeNativeTransportFailsClosedBeforeRegistration();
  await assertTaskRuntimeRegistrationFailureCleansUpExactlyOnce();
  await assertHermesAvailableTransportsEnforceRegistrationBarrier();
  await assertHermesProductionFactoryFailsClosedBeforeCliFallback();
  await assertHermesAcpAppliesSelectedProfileAndModelBeforePrompt();
  await assertHermesAcpResumesAdvertisedSessionAndBlocksStaleLoad();
  await assertOpenCodeProductionFactoryMapsRichSseToHarnessEvents();
  await assertOpenCodeShortBudgetSdkPathAwaitsRegistration();
  await assertOpenCodeManagedResumeCannotFallbackBelowHarness();
  await assertOpenCodeProductionRegistrationFailureCleansPrecisely();
  await assertTaskRuntimeAdapterPreservesNativeMemoryWhileInjectingEchoInkContext();
  await assertTaskRuntimeAdapterMapsFallbackEvents();
  await assertLifecycleFallbackKeepsOneStableAnswerMessage();
  await assertTaskRuntimeAdapterMapsToolBridgeResourceEvents();
  await assertTaskRuntimeAdapterPreservesLegacyTaskDefaults();
  await assertTaskRuntimeAdapterCancelsBeforeNativeRunId();
  await assertTaskRuntimeAdapterMergesLegacyAbortSignal();
  await assertHermesAcpConsumesAbortBeforePromptAndWhileWaiting();
  await assertTaskRuntimeAdapterDeclaresTruthfulNativeCleanupFallback();
  await assertAdaptersExposeNativeResourceProvider();
  await assertCodexRichAdapterStartsThreadAndTurn();
  await assertCodexRichNotificationHubRoutesByIdsAndNoIdErrors();
  await assertCodexTokenUsageRoutesWithoutConsumingViewNotifications();
  await assertCodexRichRunDriverMapsNotificationsToHarnessEvents();
  await assertHarnessProjectorPreservesProvidedCommandChannels();
  await assertCodexRichRunDriverNormalizesMissingIdsAndNonSuccessStatuses();
  await assertCodexRichRunDriverAggregatesAssistantTextAndTerminalIsIdempotent();
  await assertCodexRichRunDriverMapsInterruptedTerminalStatusesToCancelled();
  await assertCodexRichRunDriverUsesCompletedOnlyAssistantAsFinalOutput();
  await assertCodexRichRunDriverSettlesFinalAnswerWithoutTurnCompleted();
  await assertCodexRichRunDriverPrefersOfficialTurnCompletedDuringGrace();
  await assertCodexRichRunDriverCancelsFinalAnswerFallbackForFollowUpWork();
  await assertCodexRichRunDriverPreservesCompletedOnlyAssistantOrder();
  await assertCodexRichRunDriverDoesNotDuplicateDeltaAndCompletedAssistantText();
  await assertCodexRichRunDriverDoesNotMisselectEmptyProcessAssistant();
  await assertCodexRichRunDriverIgnoresRetryingErrors();
  await assertCodexRichRunDriverSettlesWhenTerminalEmitRejects();
  await assertCodexRichRunDriverCatchesNotificationEmitRejection();
  await assertCodexRichAdapterInterruptsStartedTurnOnCancel();
  await assertCodexRichAdapterCleansUpCancelBeforeStartTurn();
  await assertCodexRichAdapterCancelsPendingStartTurnWithoutReturningRunning();
  await assertCodexRichAdapterKeepsTerminalThatArrivesBeforeStartTurnResolves();
  await assertCodexRichAdapterSettlesFailedAfterInterruptFailure();
  await assertCodexRichAdapterRecoversArtifactsAfterInactivity();
  await assertCodexRichAdapterRecoversArtifactsAfterInactivityInterruptFailure();
  await assertCodexRichAdapterInterruptsAfterInactivityWithoutArtifactRecovery();
  await assertCodexRichAdapterFailsWhenArtifactRecoveryFails();
  await assertCodexRichAdapterFailsWhenArtifactRecoveryIsEmpty();
  await assertCodexRichRunDriverWaitsForInactivityInterruptBeforeRecovery();
  await assertCodexRichRunDriverBoundsInactivityInterruptBeforeRecovery();
  await assertCodexRichAdapterUnregistersCompletedRunFromNotificationHub();
  await assertCodexRichAdapterReleasesTerminalRunStatesAfterAwaitResult();
  await assertCodexRichAdapterDisposeCancelsAllActiveRuns();
  await assertCodexRichAdapterFallsBackToStartThreadWhenResumeThreadThrows();
  await assertCodexRichAdapterReplacesStalePrewarmedThreadBeforePromptSubmission();
  await assertCodexRichAdapterInjectsBootstrapContextIntoStartTurn();
  await assertCodexRichAdapterInjectsEchoInkMemoryIntoStartTurn();
  await assertCodexRichAdapterInjectsCatchUpContextIntoStartTurn();
  await assertCodexRichAdapterRemovesCurrentUserBeforeTrailingAssistantPlaceholder();
  await assertCodexRichAdapterPreservesBlankAndSubstringHistory();
  await assertCodexRichAdapterOnlyInjectsIncrementalDeltaIntoStartTurn();
  await assertAdapterFactoryPassesCodexToolBridgeIntoCodexRichAdapter();
  await assertCodexRichAdapterSignsTrustedWriteFenceBeforeStartTurn();
  await assertCodexRichAdapterUsesHarnessWorkspaceForExactWriteFence();
  await assertCodexRichAdapterRunsEchoInkBrokerLoopAcrossTurns();
  await assertCodexRichAdapterDisposeCancelsHangingBrokerCall();
  await assertCodexRichAdapterCancelCancelsHangingBrokerCall();
  await assertCodexRichAdapterFailsUnknownBrokerToolWithoutHanging();
  await assertCodexRichAdapterFailsBrokerErrorWithoutHanging();
  await assertCodexRichAdapterFailsWhenBrokerLoopExceedsMaxToolCalls();
  await runCodexBrokerOrchestratorRegressionTests();
  await assertOrchestratorRebuildsContextWhenNativeSessionResumeFails();
  await assertOpenCodeNativeSessionIsReusedAcrossHarnessTurns();
  await assertOpenCodeMissingNativeSessionRebuildsFromEchoInkContext();
  await assertEmulatedResumeBackendRebuildsContextForEachRun();
  await assertAdapterFactoryUsesRegisteredBuilders();
  await assertFakeFourthAgentOnlyNeedsAdapterAndManifest();
}

async function assertOpenCodeProductionFactoryMapsRichSseToHarnessEvents(): Promise<void> {
  const order: string[] = [];
  const hooks: any = {
    models: [{
      id: "opencode/big-pickle",
      providerId: "opencode",
      modelId: "opencode/big-pickle",
      displayName: "OpenCode",
      inputModalities: ["text"]
    }],
    session: { sessionId: "factory-rich-session", title: "Factory rich" },
    sessionMessages: []
  };
  hooks.onStartSession = () => {
    order.push("native:factory-rich-session");
  };
  hooks.onSendPromptAsync = () => {
    order.push("prompt");
  };
  hooks.onSubscribeEvents = () => (async function* () {
    yield { type: "server.connected", properties: {} };
    while (!hooks.sendPromptAsyncCalls) await new Promise((resolve) => setTimeout(resolve, 0));
    yield {
      type: "message.updated",
      properties: { info: { id: "factory-assistant", sessionID: "factory-rich-session", role: "assistant" } }
    };
    yield {
      type: "message.part.updated",
      properties: { part: {
        id: "factory-reasoning",
        sessionID: "factory-rich-session",
        messageID: "factory-assistant",
        type: "reasoning",
        text: "先检查文件"
      } }
    };
    yield {
      type: "message.part.updated",
      properties: { part: {
        id: "factory-tool",
        sessionID: "factory-rich-session",
        messageID: "factory-assistant",
        type: "tool",
        callID: "factory-call",
        tool: "read",
        state: { status: "pending", input: { filePath: "testing/a.md" } }
      } }
    };
    yield {
      type: "message.part.updated",
      properties: { part: {
        id: "factory-tool",
        sessionID: "factory-rich-session",
        messageID: "factory-assistant",
        type: "tool",
        callID: "factory-call",
        tool: "read",
        state: { status: "completed", input: { filePath: "testing/a.md" }, output: "file contents" }
      } }
    };
    yield {
      type: "message.part.updated",
      properties: { part: {
        id: "factory-text",
        sessionID: "factory-rich-session",
        messageID: "factory-assistant",
        type: "text",
        text: "FACTORY_DONE"
      } }
    };
    yield { type: "session.idle", properties: { sessionID: "factory-rich-session" } };
  })();
  (globalThis as any).__opencodeBackendTestHooks = hooks;

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.opencode.providerId = "opencode";
  settings.opencode.modelId = "opencode/big-pickle";
  const adapter = createHarnessAgentAdapter({
    backendId: "opencode",
    settings,
    vaultPath: "/vault",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    task: { timeoutMs: 2_000 }
  });
  const events: HarnessEvent[] = [];
  try {
    const result = await adapter.run({
      runId: "factory-rich-run",
      sessionId: "factory-rich-chat",
      workflow: "chat.generic",
      registerNativeExecution: async (native) => {
        order.push(`register:${native.id}`);
      },
      input: { text: "inspect", attachments: [] },
      permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
      resources: { selected: [], resolvedAt: 0, warnings: [] },
      context: compileContextBundle({
        session: { id: "factory-rich-chat", title: "Factory rich", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
        backendId: "opencode",
        workflow: "chat.generic",
        userInput: { text: "inspect", attachments: [] },
        memory: { providerId: "noop", items: [], sections: [] },
        corePolicySections: []
      }),
      outputContract: { kind: "plain-text" }
    }, (event) => events.push(event));

    assert.equal(result.outputText, "FACTORY_DONE");
    assert.deepEqual(order, [
      "native:factory-rich-session",
      "register:factory-rich-session",
      "prompt"
    ]);
    assert.equal(hooks.sendPromptAsyncCalls, 1);
    assert.equal(hooks.runCliTaskCalls ?? 0, 0);
    assert.equal(events.some((event) => event.type === "agent.reasoning.summary.delta" && event.text === "先检查文件"), true);
    assert.equal(events.some((event) => event.type === "agent.reasoning.summary.completed"), true);
    assert.equal(events.some((event) => event.type === "tool.requested" && event.data?.callId === "factory-call"), true);
    assert.equal(events.some((event) => event.type === "tool.completed" && event.data?.output === "file contents"), true);
    assert.equal(events.some((event) => event.type === "agent.message.delta" && event.text === "FACTORY_DONE"), true);
    assert.ok(events.filter((event) => event.backendId === "opencode").every((event) => event.data?.streamSource === "sse"));
  } finally {
    await adapter.dispose();
    delete (globalThis as any).__opencodeBackendTestHooks;
  }
}

async function assertOpenCodeShortBudgetSdkPathAwaitsRegistration(): Promise<void> {
  const hooks: any = {
    models: [],
    session: {
      sessionId: "factory-sdk-session",
      title: "Factory SDK"
    },
    sendPromptResult: "SDK_DONE"
  };
  const order: string[] = [];
  hooks.onStartSession = () => {
    order.push("native:factory-sdk-session");
  };
  hooks.onSendPrompt = () => {
    order.push("prompt");
  };
  (globalThis as any).__opencodeBackendTestHooks = hooks;
  let releaseRegistration!: () => void;
  const registrationGate = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  let markRegistrationStarted!: () => void;
  const registrationStarted = new Promise<void>((resolve) => {
    markRegistrationStarted = resolve;
  });
  const adapter = createHarnessAgentAdapter({
    backendId: "opencode",
    settings: structuredClone(DEFAULT_SETTINGS),
    vaultPath: "/vault",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    task: { timeoutMs: 500 }
  });
  try {
    const run = adapter.run({
      ...agentRunRequest("factory-sdk-registration"),
      registerNativeExecution: async (native) => {
        order.push(`register:start:${native.id}`);
        markRegistrationStarted();
        await registrationGate;
        order.push(`register:end:${native.id}`);
      }
    }, () => undefined);

    await registrationStarted;
    assert.equal(hooks.sendPromptCalls ?? 0, 0);
    releaseRegistration();
    const result = await run;

    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "SDK_DONE");
    assert.equal(hooks.runCliTaskCalls ?? 0, 0);
    assert.deepEqual(order, [
      "native:factory-sdk-session",
      "register:start:factory-sdk-session",
      "register:end:factory-sdk-session",
      "prompt"
    ]);
  } finally {
    await adapter.dispose();
    delete (globalThis as any).__opencodeBackendTestHooks;
  }
}

async function assertOpenCodeManagedResumeCannotFallbackBelowHarness(): Promise<void> {
  for (const testCase of [
    {
      name: "short-budget",
      timeoutMs: 500,
      hasSessionResult: true,
      permissionFailure: false
    },
    {
      name: "missing-after-prepare",
      timeoutMs: 2_000,
      hasSessionResult: false,
      permissionFailure: false
    },
    {
      name: "rich-pre-submit-fallback",
      timeoutMs: 2_000,
      hasSessionResult: true,
      permissionFailure: true
    }
  ]) {
    const nativeId = `managed-${testCase.name}`;
    const registrations: string[] = [];
    const hooks: any = {
      models: [],
      hasSessionResult: testCase.hasSessionResult,
      session: {
        sessionId: `replacement-${testCase.name}`,
        title: "must not silently replace"
      },
      startSessionOptions: [],
      hasSessionCalls: [],
      updateSessionPermissionCalls: [],
      onUpdateSessionPermissions: testCase.permissionFailure
        ? async () => {
          throw new Error("permission transport unavailable");
        }
        : undefined
    };
    (globalThis as any).__opencodeBackendTestHooks = hooks;
    const adapter = createHarnessAgentAdapter({
      backendId: "opencode",
      settings: structuredClone(DEFAULT_SETTINGS),
      vaultPath: "/vault",
      nativeRefContext: {
        deviceKey: "device",
        vaultId: "/vault"
      },
      task: { timeoutMs: testCase.timeoutMs }
    });
    try {
      const error = await adapter.run({
        ...agentRunRequest(`managed-resume-${testCase.name}`),
        nativeSessionId: nativeId,
        nativeBindingManagedByHarness: true,
        registerNativeExecution: async (native) => {
          registrations.push(native.id);
        }
      }, () => undefined).then(
        () => null,
        (caught: unknown) => caught
      );

      assert.equal(
        (error as { code?: unknown } | null)?.code,
        "AGENT_NATIVE_SESSION_STALE"
      );
      assert.equal(hooks.sendPromptCalls ?? 0, 0);
      assert.equal(hooks.runCliTaskCalls ?? 0, 0);
      assert.deepEqual(hooks.startSessionOptions, []);
      assert.deepEqual(
        registrations,
        testCase.permissionFailure ? [nativeId] : []
      );
    } finally {
      await adapter.dispose();
      delete (globalThis as any).__opencodeBackendTestHooks;
    }
  }
}

async function assertOpenCodeProductionRegistrationFailureCleansPrecisely(): Promise<void> {
  for (const resumed of [false, true]) {
    const nativeId = resumed
      ? "factory-registration-resumed"
      : "factory-registration-new";
    const hooks: any = {
      models: [],
      session: {
        sessionId: nativeId,
        title: "Factory registration failure"
      },
      hasSessionResult: resumed,
      deleteSessionCalls: []
    };
    (globalThis as any).__opencodeBackendTestHooks = hooks;
    const adapter = createHarnessAgentAdapter({
      backendId: "opencode",
      settings: structuredClone(DEFAULT_SETTINGS),
      vaultPath: "/vault",
      nativeRefContext: {
        deviceKey: "device",
        vaultId: "/vault"
      },
      task: { timeoutMs: 2_000 }
    });
    try {
      await assert.rejects(
        adapter.run({
          ...agentRunRequest(`factory-registration-failure-${resumed}`),
          ...(resumed ? { nativeSessionId: nativeId } : {}),
          registerNativeExecution: async () => {
            throw new Error("native store unavailable");
          }
        }, () => undefined),
        /registration failed.*native store unavailable/i
      );

      assert.equal(hooks.sendPromptCalls ?? 0, 0);
      assert.equal(hooks.subscribeEventsCalls ?? 0, 0);
      assert.equal(hooks.runCliTaskCalls ?? 0, 0);
      assert.deepEqual(
        hooks.deleteSessionCalls,
        resumed ? [] : [nativeId]
      );
    } finally {
      await adapter.dispose();
      delete (globalThis as any).__opencodeBackendTestHooks;
    }
  }
}

async function assertTaskRuntimeAdaptersAwaitDurableRegistration(): Promise<void> {
  for (const backendId of ["opencode", "hermes"] as const) {
    const order: string[] = [];
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let markRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      markRegistrationStarted = resolve;
    });
    const nativeId = `${backendId}-barrier-native`;
    const runtime: AgentTaskRuntime = {
      kind: backendId,
      async connect() {
        return { connected: true, label: backendId, errors: [] };
      },
      async listModels() {
        return [];
      },
      async runTask(input) {
        order.push(`native:${nativeId}`);
        await input.onRunId?.(nativeId);
        order.push("prompt");
        return { text: "done", runId: nativeId };
      },
      async abort() {}
    };
    const adapter = new TaskRuntimeAgentAdapter({
      backendId,
      displayName: backendId,
      version: "test",
      runtime,
      nativeRefContext: {
        deviceKey: "device",
        vaultId: "/vault"
      },
      capabilities: "legacy"
    });
    const run = adapter.run({
      ...agentRunRequest(`run-${backendId}-registration-barrier`),
      registerNativeExecution: async (native) => {
        order.push(`register:start:${native.id}`);
        markRegistrationStarted();
        await registrationGate;
        order.push(`register:end:${native.id}`);
      }
    }, () => undefined);

    await registrationStarted;
    assert.equal(
      order.includes("prompt"),
      false,
      `${backendId} must not submit before durable registration settles`
    );
    releaseRegistration();
    const result = await run;

    assert.equal(result.status, "completed");
    assert.equal(result.nativeExecution?.id, nativeId);
    assert.deepEqual(order, [
      `native:${nativeId}`,
      `register:start:${nativeId}`,
      `register:end:${nativeId}`,
      "prompt"
    ]);
  }
}

async function assertLegacyRegistrationBarrierRejectsMissingRuntimeCallback(): Promise<void> {
  for (const returnedRunId of [
    "hermes-runtime-skipped-registration-callback",
    undefined
  ]) {
    let legacyRegistrationCalls = 0;
    const adapter = new TaskRuntimeAgentAdapter({
      backendId: "hermes",
      displayName: "Hermes",
      version: "test",
      runtime: {
        kind: "hermes",
        async connect() {
          return { connected: true, label: "Hermes", errors: [] };
        },
        async listModels() {
          return [];
        },
        async runTask() {
          return {
            text: "unsafe result",
            ...(returnedRunId ? { runId: returnedRunId } : {})
          };
        },
        async abort() {
          return undefined;
        }
      },
      capabilities: "legacy",
      legacyTaskDefaults: {
        requireNativeRegistrationBeforePrompt: true,
        onRunId: async () => {
          legacyRegistrationCalls += 1;
        }
      }
    });

    await assert.rejects(
      adapter.run(agentRunRequest(
        `run-legacy-registration-postcondition-${returnedRunId ?? "missing-id"}`
      ), () => undefined),
      (error: unknown) =>
        (error as { code?: unknown })?.code === "NATIVE_EXECUTION_REGISTRATION_FAILED"
        && /successful result without crossing the pre-prompt registration barrier/.test(
          error instanceof Error ? error.message : String(error)
        )
    );
    assert.equal(
      legacyRegistrationCalls,
      0,
      "a successful result must not be mistaken for a crossed legacy registration barrier"
    );
    await adapter.dispose();
  }
}

async function assertUnsafeNativeTransportFailsClosedBeforeRegistration(): Promise<void> {
  for (const unsafeTransport of [
    "acp-stdio?token=TOP_SECRET",
    `a-${"x".repeat(128)}`
  ]) {
    let promptCalls = 0;
    let registrationCalls = 0;
    let abortCalls = 0;
    const nativeId = "hermes-unsafe-transport-session";
    const adapter = new TaskRuntimeAgentAdapter({
      backendId: "hermes",
      displayName: "Hermes",
      version: "test",
      runtime: {
        kind: "hermes",
        async connect() {
          return { connected: true, label: "Hermes", errors: [] };
        },
        async listModels() {
          return [];
        },
        async runTask(input) {
          await input.onRunId?.(nativeId, {
            kind: "session",
            persistence: "provider-persistent",
            transport: unsafeTransport
          });
          promptCalls += 1;
          return { text: "unsafe result", runId: nativeId };
        },
        async abort(runId) {
          assert.equal(runId, nativeId);
          abortCalls += 1;
        }
      },
      capabilities: "legacy"
    });

    await assert.rejects(
      adapter.run({
        ...agentRunRequest(`run-unsafe-transport-${unsafeTransport.length}`),
        registerNativeExecution: async () => {
          registrationCalls += 1;
        }
      }, () => undefined),
      /unsafe Native execution transport/
    );
    assert.equal(promptCalls, 0);
    assert.equal(registrationCalls, 0);
    assert.equal(abortCalls, 1);
    await adapter.dispose();
  }
}

async function assertTaskRuntimeRegistrationFailureCleansUpExactlyOnce(): Promise<void> {
  const cases = [
    {
      backendId: "opencode" as const,
      nativeId: "opencode-new-registration-failed",
      resumed: false,
      expectedDeletes: ["opencode-new-registration-failed"],
      expectedAborts: [] as string[]
    },
    {
      backendId: "opencode" as const,
      nativeId: "opencode-resumed-registration-failed",
      resumed: true,
      expectedDeletes: [] as string[],
      expectedAborts: [] as string[]
    },
    {
      backendId: "hermes" as const,
      nativeId: "hermes-registration-failed",
      resumed: false,
      expectedDeletes: [] as string[],
      expectedAborts: ["hermes-registration-failed"]
    }
  ];
  for (const testCase of cases) {
    const deleted: string[] = [];
    const aborted: string[] = [];
    let promptSubmitted = false;
    const runtime: AgentTaskRuntime = {
      kind: testCase.backendId,
      async connect() {
        return {
          connected: true,
          label: testCase.backendId,
          errors: []
        };
      },
      async listModels() {
        return [];
      },
      async runTask(input) {
        await input.onRunId?.(testCase.nativeId);
        promptSubmitted = true;
        return { text: "must not run", runId: testCase.nativeId };
      },
      async abort(runId) {
        aborted.push(runId);
      },
      async deleteNativeSession(sessionId) {
        deleted.push(sessionId);
        return true;
      }
    };
    const adapter = new TaskRuntimeAgentAdapter({
      backendId: testCase.backendId,
      displayName: testCase.backendId,
      version: "test",
      runtime,
      nativeRefContext: {
        deviceKey: "device",
        vaultId: "/vault"
      },
      capabilities: "legacy"
    });

    await assert.rejects(
      adapter.run({
        ...agentRunRequest(`run-${testCase.nativeId}`),
        ...(testCase.resumed
          ? { nativeSessionId: testCase.nativeId }
          : {}),
        registerNativeExecution: async () => {
          throw new Error("native store unavailable");
        }
      }, () => undefined),
      /registration failed.*native store unavailable/i
    );

    assert.equal(promptSubmitted, false);
    assert.deepEqual(deleted, testCase.expectedDeletes);
    assert.deepEqual(aborted, testCase.expectedAborts);
  }
}

async function assertHermesAvailableTransportsEnforceRegistrationBarrier(): Promise<void> {
  let cliPromptCalls = 0;
  const registeredNativeIds: string[] = [];
  const cli = new HermesBackend({
    ...DEFAULT_SETTINGS.agents.hermes,
    serverUrl: "",
    vaultPath: "/vault",
    commandExists: () => true,
    processRunner: async () => {
      cliPromptCalls += 1;
      return { stdout: "done", stderr: "" };
    }
  });
  await assert.rejects(
    cli.runTask({
      prompt: "ping",
      requireNativeRegistrationBeforePrompt: true,
      onRunId: async (runId) => {
        registeredNativeIds.push(runId);
      }
    }),
    (error: unknown) =>
      (error as { code?: unknown })?.code === "NATIVE_EXECUTION_REGISTRATION_FAILED"
      && /backend-owned Native execution ID/.test(
        error instanceof Error ? error.message : String(error)
      )
  );
  assert.equal(cliPromptCalls, 0);
  assert.deepEqual(
    registeredNativeIds,
    [],
    "Hermes CLI must not register a locally synthesized ID as backend-owned identity"
  );

  const legacyCliResult = await cli.runTask({ prompt: "legacy ping" });
  assert.equal(legacyCliResult.text, "done");
  assert.equal(
    cliPromptCalls,
    1,
    "non-barrier legacy CLI tasks remain compatible"
  );

  let httpCalls = 0;
  const http = new HermesBackend({
    ...DEFAULT_SETTINGS.agents.hermes,
    serverUrl: "http://127.0.0.1:9999",
    vaultPath: "/vault",
    fetch: async () => {
      httpCalls += 1;
      throw new Error("HTTP must not be called");
    }
  });
  await assert.rejects(
    http.runTask({
      prompt: "ping",
      requireNativeRegistrationBeforePrompt: true,
      onRunId: async () => undefined
    }),
    /无法满足 Native 提前登记边界/
  );
  assert.equal(httpCalls, 0);
}

export async function assertHermesProductionFactoryFailsClosedBeforeCliFallback(): Promise<void> {
  if (process.platform === "win32") return;
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "echoink-hermes-identity-barrier-"));
  const commandPath = path.join(fixtureRoot, "hermes");
  const invocationLogPath = path.join(fixtureRoot, "invocations.jsonl");
  await writeFile(invocationLogPath, "", "utf8");
  await writeFile(commandPath, [
    "#!/bin/sh",
    `invocation_log_path=${JSON.stringify(invocationLogPath)}`,
    "if [ \"$1\" = \"--version\" ]; then",
    "  printf '%s\\n' '[\"--version\"]' >> \"$invocation_log_path\"",
    "  printf '%s\\n' 'Hermes Agent 0.1.0'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"acp\" ]; then",
    "  printf '%s\\n' '[\"acp\"]' >> \"$invocation_log_path\"",
    "  printf '%s\\n' 'fixture ACP startup failed' >&2",
    "  exit 1",
    "fi",
    "printf '%s\\n' '[\"unsafe-cli\"]' >> \"$invocation_log_path\"",
    "printf '%s\\n' 'unsafe CLI fallback executed'"
  ].join("\n"), "utf8");
  await chmod(commandPath, 0o700);

  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agents.hermes.cliPath = commandPath;
  settings.agents.hermes.serverUrl = "";
  const previousDisableAcp = process.env.ECHOINK_DISABLE_ACP;
  delete process.env.ECHOINK_DISABLE_ACP;
  const nativeRegistrations: string[] = [];
  const events: HarnessEvent[] = [];
  const adapter = createHarnessAgentAdapter({
    backendId: "hermes",
    settings,
    vaultPath: fixtureRoot,
    nativeRefContext: {
      deviceKey: "device",
      vaultId: fixtureRoot
    },
    // The production ACP startup window is capped at 1.5 seconds. A 2-second
    // task budget would reduce it to 500ms. Keep the real cap and use a shell
    // receipt so this test does not measure a nested Node process cold start.
    task: { timeoutMs: 8_000 }
  });

  try {
    const error = await adapter.run({
      ...agentRunRequest("hermes-production-identity-barrier", {
        workspace: { vaultPath: fixtureRoot, cwd: fixtureRoot },
        permissions: {
          mode: "read-only",
          writableRoots: [],
          requireApproval: true
        }
      }),
      registerNativeExecution: async (native) => {
        nativeRegistrations.push(native.id);
      }
    }, (event) => events.push(event)).then(
      () => null,
      (caught: unknown) => caught
    );

    assert.equal(
      (error as { code?: unknown } | null)?.code,
      "NATIVE_EXECUTION_REGISTRATION_FAILED"
    );
    assert.match(
      error instanceof Error ? error.message : String(error),
      /backend-owned Native execution ID.*禁止降级/
    );
    assert.notEqual(
      (error as { cause?: unknown } | null)?.cause,
      undefined,
      "default Hermes factory must route through ACP and preserve the rich transport failure"
    );
    assert.deepEqual(
      nativeRegistrations,
      [],
      "default Hermes factory must not put a synthesized CLI ID into the Native Store"
    );
    const invocations = (await readFile(invocationLogPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      invocations.filter((args) => args[0] === "acp").length <= 1,
      true,
      "default Hermes factory must never execute ACP more than once"
    );
    assert.equal(
      invocations.filter((args) => args[0] !== "acp" && args[0] !== "--version").length,
      0,
      "ACP startup failure must not launch a CLI Prompt or synthetic cleanup target"
    );
    assert.equal(
      events.some((event) => event.type === "adapter.fallback.started"),
      false,
      "a transport that cannot preserve the identity barrier is not a valid fallback"
    );
  } finally {
    if (previousDisableAcp === undefined) {
      delete process.env.ECHOINK_DISABLE_ACP;
    } else {
      process.env.ECHOINK_DISABLE_ACP = previousDisableAcp;
    }
    await adapter.dispose();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

export async function assertHermesAcpAppliesSelectedProfileAndModelBeforePrompt(): Promise<void> {
  const selectedModel = {
    providerId: "openrouter",
    modelId: "anthropic/claude-sonnet-4"
  };
  const selectedProfile = "echoink-probe";
  const harness = createAcpCancellationHarness();
  let launchedArgs: string[] = [];
  const runtime = new AcpAgentRuntime({
    backend: "hermes",
    command: {
      command: "hermes",
      args: () => hermesAcpLaunchArgs(selectedProfile),
      cwd: "/vault"
    },
    processFactory: (_command, args) => {
      launchedArgs = [...args];
      return harness.process;
    },
    requestTimeoutMs: 1_000
  });
  const registrationOrder: string[] = [];
  let registeredNativeDescriptor:
    | AgentNativeExecutionDescriptor
    | undefined;
  const run = runtime.runTaskStream({
    prompt: "只回复 PONG",
    model: selectedModel,
    onRunId: async (_runId, native) => {
      registeredNativeDescriptor = native;
      registrationOrder.push("native:registered");
    }
  }, (event) => {
    if (event.type === "prompt_sent") registrationOrder.push("prompt:sent");
  });
  try {
    const newSession = await settleWithin(harness.next("session/new"), 250);
    harness.respond(newSession, { sessionId: "hermes-configured-probe" });
    const setModel = await settleWithin(
      harness.next("session/set_model"),
      250
    );
    assert.deepEqual(
      registrationOrder,
      ["native:registered"],
      "the real ACP session must be durably registered before set_model can fail"
    );
    assert.equal(
      harness.count("session/prompt"),
      0,
      "Hermes must configure the selected model before prompt submission"
    );
    assert.deepEqual(setModel.params, {
      sessionId: "hermes-configured-probe",
      modelId: "openrouter:anthropic/claude-sonnet-4"
    });
    harness.respond(setModel, {});
    const prompt = await settleWithin(harness.next("session/prompt"), 250);
    harness.respond(prompt, { stopReason: "end_turn" });
    const result = await run;

    assert.deepEqual(
      launchedArgs,
      ["--profile", selectedProfile, "acp"],
      "the selected Hermes profile must be part of the real ACP process launch"
    );
    assert.deepEqual(result.effectiveModel, selectedModel);
    assert.deepEqual(registeredNativeDescriptor, {
      kind: "session",
      persistence: "provider-persistent",
      transport: "acp-stdio"
    });
    assert.deepEqual(registrationOrder, [
      "native:registered",
      "prompt:sent"
    ]);
  } finally {
    await runtime.disconnect();
  }

  const mappedNativeRefs: NativeExecutionRef[] = [];
  const mappedAdapter = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime: {
      kind: "hermes",
      async connect() {
        return { connected: true, label: "Hermes", errors: [] };
      },
      async listModels() {
        return [];
      },
      async runTask(task) {
        await task.onRunId?.("hermes-acp-probe-session", {
          kind: "session",
          persistence: "provider-persistent",
          transport: "acp-stdio"
        });
        return {
          text: "PONG",
          runId: "hermes-acp-probe-session",
          effectiveModel: selectedModel
        };
      },
      async abort() {
        return undefined;
      }
    },
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault",
      providerEndpoint:
        "hermes-acp+stdio://local/echoink-probe"
    },
    capabilities: "legacy",
    legacyTaskDefaults: {
      model: selectedModel,
      requireNativeRegistrationBeforePrompt: true
    }
  });
  const mappedResult = await mappedAdapter.run({
    ...agentRunRequest("run-hermes-acp-probe-native-kind", {
      inputText: "只回复 PONG"
    }),
    workflow: "backend.probe",
    registerNativeExecution: async (native) => {
      mappedNativeRefs.push(native);
    }
  }, () => undefined);
  assert.equal(mappedResult.status, "completed");
  assert.equal(mappedNativeRefs.length, 1);
  assert.equal(
    mappedNativeRefs[0].kind,
    "session",
    "Hermes ACP probe Native identity must not be guessed as a run"
  );
  assert.equal(
    mappedNativeRefs[0].persistence,
    "provider-persistent"
  );
  assert.equal(mappedNativeRefs[0].transport, "acp-stdio");
  assert.equal(
    mappedNativeRefs[0].providerEndpoint,
    "hermes-acp+stdio://local/echoink-probe"
  );
  assert.deepEqual(mappedResult.nativeExecution, mappedNativeRefs[0]);
  await mappedAdapter.dispose();

  const rejectedAckHarness = createAcpCancellationHarness();
  const rejectedAckRuntime = new AcpAgentRuntime({
    backend: "hermes",
    command: {
      command: "hermes",
      args: hermesAcpLaunchArgs(selectedProfile),
      cwd: "/vault"
    },
    processFactory: () => rejectedAckHarness.process,
    requestTimeoutMs: 1_000
  });
  const rejectedNativeRegistrations: string[] = [];
  const rejected = rejectedAckRuntime.runTaskStream({
    prompt: "must not submit",
    model: selectedModel,
    onRunId: async (runId) => {
      rejectedNativeRegistrations.push(runId);
    }
  }, () => undefined);
  try {
    const newSession = await settleWithin(
      rejectedAckHarness.next("session/new"),
      250
    );
    rejectedAckHarness.respond(newSession, {
      sessionId: "hermes-rejected-model-probe"
    });
    const setModel = await settleWithin(
      rejectedAckHarness.next("session/set_model"),
      250
    );
    assert.deepEqual(
      rejectedNativeRegistrations,
      ["hermes-rejected-model-probe"],
      "set_model rejection must leave an exact Native identity for settlement"
    );
    rejectedAckHarness.respond(setModel, null);
    await assert.rejects(
      rejected,
      /did not acknowledge the selected model/
    );
    assert.equal(
      rejectedAckHarness.count("session/prompt"),
      0,
      "a missing set_model acknowledgement must fail closed before Prompt"
    );
    assert.deepEqual(
      rejectedNativeRegistrations,
      ["hermes-rejected-model-probe"],
      "the rejected ACP session must remain addressable by one durable identity"
    );
  } finally {
    await rejectedAckRuntime.disconnect();
  }
}

export async function assertHermesAcpResumesAdvertisedSessionAndBlocksStaleLoad(): Promise<void> {
  const advertisedCapabilities = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {} }
    }
  };
  const harness = createAcpCancellationHarness(advertisedCapabilities);
  const acpRuntime = new AcpAgentRuntime({
    backend: "hermes",
    command: { command: "hermes", args: ["acp"], cwd: "/vault" },
    processFactory: () => harness.process,
    requestTimeoutMs: 1_000
  });
  const runtime = createAgentEventRuntimeWithFallback(
    fakeRuntime({
      kind: "hermes",
      result: { text: "fallback must not run" }
    }),
    acpRuntime,
    {
      nativeRegistrationBeforePromptSupport: "rich-only"
    }
  );
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime,
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault",
      providerEndpoint: "hermes-acp+stdio://local/default"
    },
    capabilities: "legacy"
  });
  await adapter.connect({
    runId: "connect-hermes-resume",
    sessionId: "conversation-hermes-resume",
    workspace: {
      vaultPath: "/vault",
      cwd: "/vault"
    }
  });
  assert.equal(adapter.manifest.capabilities.sessions.resume, "native");
  assert.equal(
    adapter.manifest.nativeExecution?.persistence,
    "provider-persistent"
  );
  assert.equal(adapter.manifest.nativeExecution?.canInspectExistence, true);
  assert.equal(adapter.manifest.nativeExecution?.dispositions.delete, false);

  const preparation = adapter.prepareNativeSession!({
    runId: "run-hermes-resume",
    sessionId: "conversation-hermes-resume",
    binding: {
      backendId: "hermes",
      nativeSessionId: "hermes-existing-session",
      syncedSessionRevision: 1,
      workspaceFingerprint: "workspace",
      contextCursor: {
        syncedSessionRevision: 1,
        sessionGeneration: 1,
        workspaceFingerprint: "workspace"
      },
      lastUsedAt: 1
    },
    action: "resume",
    reason: "reusable"
  });
  const listRequest = await settleWithin(
    harness.next("session/list"),
    250
  );
  harness.respond(listRequest, {
    sessions: [{
      sessionId: "hermes-existing-session",
      cwd: "/vault",
      title: "Existing"
    }]
  });
  assert.equal((await preparation).status, "resumed");

  const registered: NativeExecutionRef[] = [];
  const events: HarnessEvent[] = [];
  const run = adapter.run({
    ...agentRunRequest("run-hermes-resume", {
      inputText: "继续"
    }),
    nativeSessionId: "hermes-existing-session",
    nativeBindingManagedByHarness: true,
    registerNativeExecution: async (native) => {
      registered.push(native);
    }
  }, (event) => {
    events.push(event);
  });
  const loadRequest = await settleWithin(
    harness.next("session/load"),
    250
  );
  harness.notify("session/update", {
    sessionId: "hermes-existing-session",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "旧历史不能冒充本轮回答" }
    }
  });
  harness.respond(loadRequest, {});
  const promptRequest = await settleWithin(
    harness.next("session/prompt"),
    250
  );
  harness.notify("session/update", {
    sessionId: "hermes-existing-session",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "本轮回答" }
    }
  });
  harness.respond(promptRequest, { stopReason: "end_turn" });
  const result = await run;
  assert.equal(result.outputText, "本轮回答");
  assert.equal(harness.count("session/new"), 0);
  assert.equal(
    events.some((event) => event.text?.includes("旧历史不能冒充本轮回答")),
    false
  );
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, "hermes-existing-session");
  assert.equal(registered[0].kind, "session");
  assert.equal(registered[0].persistence, "provider-persistent");
  await adapter.dispose();

  const staleHarness = createAcpCancellationHarness(
    advertisedCapabilities
  );
  const staleRuntime = new AcpAgentRuntime({
    backend: "hermes",
    command: { command: "hermes", args: ["acp"], cwd: "/vault" },
    processFactory: () => staleHarness.process,
    requestTimeoutMs: 1_000
  });
  const staleRun = staleRuntime.runTaskStream({
    prompt: "must not submit",
    nativeSessionId: "hermes-stale-session",
    requireNativeSessionResume: true
  }, () => undefined);
  const staleLoad = await settleWithin(
    staleHarness.next("session/load"),
    250
  );
  staleHarness.respond(staleLoad, null);
  await assert.rejects(staleRun, /no longer exists/);
  assert.equal(staleHarness.count("session/new"), 0);
  assert.equal(staleHarness.count("session/prompt"), 0);
  await staleRuntime.disconnect();
}

async function assertTaskRuntimeAdapterPreservesNativeMemoryWhileInjectingEchoInkContext(): Promise<void> {
  for (const backendId of ["opencode", "hermes"] as const) {
    const calls: AgentTaskInput[] = [];
    const adapter = new TaskRuntimeAgentAdapter({
      backendId,
      displayName: backendId,
      version: "test",
      runtime: fakeRuntime({
        kind: backendId,
        result: { text: "ok", runId: `${backendId}-native-memory` },
        onRunTask: (input) => calls.push(input)
      }),
      capabilities: "legacy"
    });
    await adapter.run({
      runId: `run-${backendId}-native-memory`,
      sessionId: "session-native-memory",
      workflow: "chat.generic",
      input: { text: "查找旧记录", attachments: [] },
      permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
      resources: { selected: [], resolvedAt: 0, warnings: [] },
      context: compileContextBundle({
        session: { id: "session-native-memory", title: "Native memory", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
        backendId,
        workflow: "chat.generic",
        userInput: { text: "查找旧记录", attachments: [] },
        memory: {
          providerId: "file-memory",
          items: [],
          sections: [{
            id: "memory:local-usage-archive",
            priority: 560,
            channel: "system",
            content: "[EchoInk Local Usage Archive]\nSearch on demand.",
            source: "echoink-local-history",
            required: true,
            sensitive: false
          }]
        },
        corePolicySections: []
      }),
      outputContract: { kind: "plain-text" }
    }, () => undefined);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].system, undefined, `${backendId} ordinary runs must not receive a system override that suppresses native memory or rules`);
    assert.match(calls[0].prompt, /EchoInk Local Usage Archive/, `${backendId} must still receive the EchoInk local archive catalog`);
  }
}

async function assertTaskRuntimeAdapterMapsToolBridgeResourceEvents(): Promise<void> {
  let calls = 0;
  const runtime = fakeRuntime({
    kind: "opencode",
    result: { text: "final", runId: "native-run-1" },
    onRunTask: () => {
      calls += 1;
      return calls === 1
        ? { text: "```echoink-tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```", runId: "native-run-1" }
        : { text: "final", runId: "native-run-1" };
    }
  });
  const toolBridge = createEchoInkMcpToolBridgeRuntime({
    catalog: {
      tools: [{
        name: "search.query",
        resourceId: "echoink-local:mcp-server:mcp-search",
        resourceName: "search",
        toolName: "query",
        description: "Search"
      }],
      warnings: []
    },
    scope: "chat",
    callTool: async () => ({ result: "found" })
  });
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime,
    capabilities: "legacy",
    legacyTaskDefaults: {
      toolBridge
    }
  });
  const events: HarnessEvent[] = [];

  await adapter.run({
    runId: "run-tool-resource",
    sessionId: "session-1",
    input: { text: "search", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "opencode",
      workflow: "chat.generic",
      userInput: { text: "search", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: []
    }),
    outputContract: { kind: "plain-text" }
  }, (event) => events.push(event));

  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("tool."))
      .map((event) => [event.type, event.toolName, event.resourceId]),
    [
      ["tool.requested", "search.query", "echoink-local:mcp-server:mcp-search"],
      ["tool.approval.requested", "search.query", "echoink-local:mcp-server:mcp-search"],
      ["tool.completed", "search.query", "echoink-local:mcp-server:mcp-search"]
    ]
  );
}

async function assertTaskRuntimeAdapterRunsThroughHarnessContract(): Promise<void> {
  const calls: AgentTaskInput[] = [];
  const runtime = fakeRuntime({
    kind: "opencode",
    result: { text: "runtime pong", runId: "native-run-1" },
    onRunTask: (input) => calls.push(input)
  });
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime,
    capabilities: "legacy"
  });
  const events: HarnessEvent[] = [];
  const result = await adapter.run({
    runId: "run-adapter",
    sessionId: "session-1",
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "opencode",
      workflow: "chat.generic",
      userInput: { text: "ping", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: [],
      vaultProfileSections: [{
        id: "vault-profile:knowledge-rules",
        priority: 9_000,
        channel: "system",
        content: "INJECTED-KNOWLEDGE-RULES",
        source: "vault:LLM-WIKI.md#sha256:test",
        required: true,
        sensitive: true
      }]
    }),
    outputContract: { kind: "plain-text" }
  }, (event) => events.push(event));

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "runtime pong");
  assert.equal(result.nativeSessionId, "native-run-1");
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /ping/);
  assert.doesNotMatch(calls[0].prompt, /INJECTED-KNOWLEDGE-RULES/);
  assert.match(calls[0].system ?? "", /INJECTED-KNOWLEDGE-RULES/);
  assert.deepEqual(events.map((event) => event.type), ["agent.message.completed"]);
}

async function assertAdaptersExposeNativeResourceProvider(): Promise<void> {
  const taskAdapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime: fakeRuntime({ kind: "opencode", result: { text: "pong", runId: "opencode-session" } }),
    capabilities: "legacy",
    legacyTaskDefaults: {
      resources: {
        promptPrefix: "",
        warnings: [],
        mcpConfig: null,
        toolBridge: null,
        enabledResources: [
          {
            id: "opencode-import:skill:reviewer",
            kind: "skill",
            source: "opencode-import",
            name: "reviewer",
            description: "",
            enabled: true,
            scopes: ["chat"],
            bridgeMode: "prompt-only"
          },
          {
            id: "opencode-import:mcp-server:browser",
            kind: "mcp-server",
            source: "opencode-import",
            name: "browser",
            description: "",
            enabled: true,
            scopes: ["chat"],
            bridgeMode: "native-mcp"
          },
          {
            id: "hermes-import:mcp-server:browser",
            kind: "mcp-server",
            source: "hermes-import",
            name: "browser",
            description: "",
            enabled: true,
            scopes: ["chat"],
            bridgeMode: "native-mcp"
          }
        ]
      }
    }
  });
  const taskSnapshot = await taskAdapter.listNativeResources?.();
  assert.deepEqual(taskSnapshot?.resources.map((resource) => [resource.id, resource.type, resource.name]), [
    ["opencode-import:skill:reviewer", "skill", "reviewer"],
    ["opencode-import:mcp-server:browser", "mcp", "browser"]
  ]);

  const codexAdapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [],
    startThread: async () => ({ threadId: "thread", title: "Thread" }),
    resumeThread: async () => undefined,
    startTurn: async () => "turn",
    nativeResources: [
      { id: "codex-import:skill:answer", type: "skill", name: "answer" },
      { id: "codex-import:mcp-server:github", type: "mcp", name: "github" }
    ]
  });
  const codexSnapshot = await codexAdapter.listNativeResources?.();
  assert.equal(codexSnapshot?.backendId, "codex-cli");
  assert.equal(typeof codexSnapshot?.capturedAt, "number");
  assert.deepEqual(codexSnapshot?.resources, [
    { id: "codex-import:skill:answer", type: "skill", name: "answer" },
    { id: "codex-import:mcp-server:github", type: "mcp", name: "github" }
  ]);
}

async function assertTaskRuntimeAdapterMapsFallbackEvents(): Promise<void> {
  const runtime = {
    ...fakeRuntime({ kind: "hermes", result: { text: "rich pong", runId: "hermes-run" } }),
    async runTaskEvents(input: AgentTaskInput, emit: any): Promise<AgentTaskResult> {
      emit({ type: "fallback_started", backend: "hermes", createdAt: 1, error: "ACP unavailable" });
      emit({ type: "message_delta", backend: "hermes", createdAt: 2, text: "rich " });
      emit({ type: "thinking_delta", backend: "hermes", createdAt: 3, text: "raw internal thought" });
      emit({ type: "thinking_completed", backend: "hermes", createdAt: 4, text: "raw internal thought" });
      emit({
        type: "usage",
        backend: "hermes",
        createdAt: 5,
        data: { input_tokens: 12, output_tokens: 3, reasoning_tokens: 2 }
      });
      emit({ type: "message_completed", backend: "hermes", createdAt: 5, text: "rich pong" });
      return {
        text: "rich pong",
        runId: input.onRunId ? "ignored" : "hermes-run",
        terminalData: {
          streamSource: "acp",
          promptSubmitted: true,
          unconfirmedToolCallCount: 2,
          unconfirmedToolCallIds: ["tool-a", "tool-b"]
        }
      };
    }
  };
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime,
    capabilities: "legacy"
  });
  const events: HarnessEvent[] = [];
  const result = await adapter.run({
    runId: "run-hermes",
    sessionId: "session-1",
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "hermes",
      workflow: "chat.generic",
      userInput: { text: "ping", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: []
    }),
    outputContract: { kind: "plain-text" }
  }, (event) => events.push(event));

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "rich pong");
  assert.deepEqual(result.terminalData, {
    streamSource: "acp",
    promptSubmitted: true,
    unconfirmedToolCallCount: 2,
    unconfirmedToolCallIds: ["tool-a", "tool-b"]
  });
  assert.equal(events.some((event) => event.type.startsWith("agent.reasoning.")), false);
  assert.equal(events.some((event) => event.type.startsWith("agent.thinking.")), true);
  assert.deepEqual(events.map((event) => event.type), [
    "adapter.fallback.started",
    "agent.message.delta",
    "agent.thinking.delta",
    "agent.thinking.completed",
    "usage.updated",
    "agent.message.completed"
  ]);
  assert.deepEqual(events.find((event) => event.type === "usage.updated")?.data, {
    input_tokens: 12,
    output_tokens: 3,
    reasoning_tokens: 2,
    usage: { totalTokens: 15, inputTokens: 12, outputTokens: 3, reasoningTokens: 2 }
  });

  const orchestratorEvents: HarnessEvent[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: () => 100,
    sessionProvider: () => ({
      id: "session-terminal-data",
      title: "Terminal data",
      cwd: "/vault",
      ...testConversationIdentity("context-session-terminal-data", 1),
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
  });
  const orchestrated = await orchestrator.run({
    runId: "run-hermes-terminal-data",
    sessionId: "session-terminal-data",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "hermes",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 0, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  }, (event) => orchestratorEvents.push(event));
  assert.equal(orchestrated.status, "completed");
  assert.deepEqual(orchestratorEvents.find((event) => event.type === "run.completed")?.data, {
    streamSource: "acp",
    promptSubmitted: true,
    unconfirmedToolCallCount: 2,
    unconfirmedToolCallIds: ["tool-a", "tool-b"]
  });
}

async function assertLifecycleFallbackKeepsOneStableAnswerMessage(): Promise<void> {
  const runtime = createAgentEventRuntimeWithFallback(fakeRuntime({
    kind: "hermes",
    result: { text: "LIFECYCLE ONCE", runId: "hermes-lifecycle-run" }
  }));
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime,
    capabilities: "legacy"
  });
  const events: HarnessEvent[] = [];
  await adapter.run({
    runId: "run-lifecycle-answer",
    sessionId: "session-lifecycle-answer",
    workflow: "chat.generic",
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-lifecycle-answer", title: "Lifecycle", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "hermes",
      workflow: "chat.generic",
      userInput: { text: "ping", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: []
    }),
    outputContract: { kind: "plain-text" }
  }, (event) => events.push(event));

  const completions = events.filter((event) => event.type === "agent.message.completed");
  assert.equal(completions.length, 1, "legacy run completion must not be projected as a second answer row");
  assert.equal(new Set(completions.map((event) => event.data?.messageId)).size, 1);
  assert.ok(completions.every((event) => typeof event.data?.messageId === "string"));

  const answer: ChatMessage = {
    id: "answer:lifecycle",
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "Agent 正在处理...",
    backendId: "hermes",
    runId: "run-lifecycle-answer",
    createdAt: 1
  };
  const projector = new HarnessEventProjector({
    runId: "run-lifecycle-answer",
    backendId: "hermes",
    vaultPath: "/vault",
    answerMessage: answer
  });
  completions.forEach((event, index) => {
    projector.project({
      ...event,
      eventId: `lifecycle:${index + 1}`,
      runId: "run-lifecycle-answer",
      sequence: index + 1,
      createdAt: index + 1
    });
  });
  assert.equal(projector.snapshot().at(-1)?.text, "LIFECYCLE ONCE");
  assert.equal(projector.snapshot().filter((message) => message.itemType === "assistant").length, 1);
}

async function assertTaskRuntimeAdapterPreservesLegacyTaskDefaults(): Promise<void> {
  const calls: AgentTaskInput[] = [];
  const runtime = fakeRuntime({
    kind: "opencode",
    result: { text: "runtime pong", runId: "native-run-1" },
    onRunTask: (input) => calls.push(input)
  });
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime,
    capabilities: "legacy",
    legacyTaskDefaults: {
      resources: {
        promptPrefix: "legacy resource prefix",
        enabledResources: [],
        warnings: [],
        mcpConfig: null,
        toolBridge: null
      },
      toolBridge: null,
      timeoutMs: 1234,
      tools: { read: true, write: false },
      requireExactWriteFence: true,
      exactWriteFence: {
        attemptToken: "attempt-adapter-default",
        leaseToken: "lease-adapter-default",
        deniedLivePaths: ["/live"],
        deniedControlPaths: ["/control"]
      }
    }
  });

  await adapter.run({
    runId: "run-adapter",
    sessionId: "session-1",
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "opencode",
      workflow: "chat.generic",
      userInput: { text: "ping", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: []
    }),
    outputContract: { kind: "plain-text" }
  }, () => undefined);

  assert.equal(calls[0].resources?.promptPrefix, "legacy resource prefix");
  assert.equal(calls[0].timeoutMs, 1234);
  assert.equal(calls[0].tools?.write, false);
  assert.equal(calls[0].requireExactWriteFence, true);
  assert.equal(calls[0].exactWriteFence?.leaseToken, "lease-adapter-default");
}

async function assertTaskRuntimeAdapterCancelsBeforeNativeRunId(): Promise<void> {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseRun!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  let observedSignal: AbortSignal | undefined;
  let promptSubmitted = false;
  const abortedNativeRuns: string[] = [];
  const runtime: AgentTaskRuntime = {
    kind: "opencode",
    async connect() { return { connected: true, label: "OpenCode", errors: [] }; },
    async listModels() { return []; },
    async runTask(input) {
      observedSignal = input.abortSignal;
      markStarted();
      await blocked;
      // Simulate a backend that learns its native id just after cancellation.
      input.onRunId?.("late-native-run");
      await delay(0);
      if (input.abortSignal?.aborted) throw new Error("Agent 任务已取消。");
      promptSubmitted = true;
      return { text: "must not execute", runId: "late-native-run" };
    },
    async abort(runId) { abortedNativeRuns.push(runId); }
  };
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime,
    capabilities: "legacy"
  });

  const runPromise = adapter.run(agentRunRequest("run-cancel-before-native-id", { inputText: "cancel early" }), () => undefined);
  const rejected = assert.rejects(runPromise, /任务已取消/);
  await started;
  await adapter.cancel("run-cancel-before-native-id");
  assert.equal(observedSignal?.aborted, true);
  assert.deepEqual(abortedNativeRuns, [], "cancel before onRunId must use the per-run AbortSignal first");
  releaseRun();
  await rejected;
  assert.equal(promptSubmitted, false);
  assert.deepEqual(abortedNativeRuns, ["late-native-run"], "a native id reported after cancellation must be aborted immediately");

  const cancelledSignal = observedSignal;
  const nextResult = await adapter.run(agentRunRequest("run-after-early-cancel", { inputText: "fresh run" }), () => undefined);
  assert.notEqual(observedSignal, cancelledSignal, "a later Harness run must receive a fresh AbortController");
  assert.equal(observedSignal?.aborted, false);
  assert.equal(nextResult.status, "completed");
}

async function assertTaskRuntimeAdapterMergesLegacyAbortSignal(): Promise<void> {
  const legacyController = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseRun!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseRun = resolve; });
  let observedSignal: AbortSignal | undefined;
  const runtime: AgentTaskRuntime = {
    kind: "opencode",
    async connect() { return { connected: true, label: "OpenCode", errors: [] }; },
    async listModels() { return []; },
    async runTask(input) {
      observedSignal = input.abortSignal;
      markStarted();
      await blocked;
      if (input.abortSignal?.aborted) throw new Error("Agent 任务已取消。");
      return { text: "must not execute" };
    },
    async abort() {}
  };
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime,
    capabilities: "legacy",
    legacyTaskDefaults: { abortSignal: legacyController.signal }
  });

  const runPromise = adapter.run(agentRunRequest("run-legacy-abort", { inputText: "legacy abort" }), () => undefined);
  const rejected = assert.rejects(runPromise, /任务已取消/);
  await started;
  assert.notEqual(observedSignal, legacyController.signal, "each Harness run must own an independent AbortController");
  legacyController.abort();
  assert.equal(observedSignal?.aborted, true);
  releaseRun();
  await rejected;
}

async function assertHermesAcpConsumesAbortBeforePromptAndWhileWaiting(): Promise<void> {
  const beforePrompt = createAcpCancellationHarness();
  const beforePromptAdapter = taskRuntimeAdapterForAcp(beforePrompt.process);
  const beforePromptRun = beforePromptAdapter.run(
    agentRunRequest("run-hermes-cancel-before-prompt", { inputText: "cancel before prompt" }),
    () => undefined
  );
  const beforePromptRejected = assert.rejects(beforePromptRun, /任务已取消/);
  await settleWithin(beforePrompt.next("session/new"), 250);
  await beforePromptAdapter.cancel("run-hermes-cancel-before-prompt");
  await beforePromptRejected;
  assert.equal(beforePrompt.count("session/prompt"), 0, "ACP must not submit a prompt after an early cancel");
  assert.equal(beforePrompt.killed(), true);

  const waiting = createAcpCancellationHarness();
  const waitingAdapter = taskRuntimeAdapterForAcp(waiting.process);
  const waitingRun = waitingAdapter.run(
    agentRunRequest("run-hermes-cancel-waiting", { inputText: "cancel while waiting" }),
    () => undefined
  );
  const waitingRejected = assert.rejects(waitingRun, /任务已取消/);
  const newSession = await settleWithin(waiting.next("session/new"), 250);
  waiting.respond(newSession, { sessionId: "hermes-waiting-session" });
  await settleWithin(waiting.next("session/prompt"), 250);
  await waitingAdapter.cancel("run-hermes-cancel-waiting");
  await waitingRejected;
  assert.equal(waiting.count("session/prompt"), 1, "cancelling a submitted ACP prompt must not replay it");
  assert.equal(waiting.count("session/cancel") >= 1, true, "a waiting ACP prompt must receive native cancellation");
  assert.equal(waiting.killed(), true);
}

function taskRuntimeAdapterForAcp(process: AcpSubprocessLike): TaskRuntimeAgentAdapter {
  return new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime: new AcpAgentRuntime({
      backend: "hermes",
      command: { command: "hermes", args: ["acp"], cwd: "/vault" },
      processFactory: () => process,
      requestTimeoutMs: 1_000
    }),
    capabilities: "legacy"
  });
}

async function assertTaskRuntimeAdapterDeclaresTruthfulNativeCleanupFallback(): Promise<void> {
  let disconnectCalls = 0;
  const deletedSessions: string[] = [];
  const opencode = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime: {
      ...fakeRuntime({ kind: "opencode", result: { text: "pong", runId: "opencode-session-1" } }),
      disconnect: async () => {
        disconnectCalls += 1;
      },
      deleteNativeSession: async (sessionId) => {
        deletedSessions.push(sessionId);
        return true;
      }
    },
    nativeRefContext: {
      providerEndpoint: "http://127.0.0.1:4096",
      deviceKey: "device-1",
      vaultId: "vault-1"
    },
    capabilities: "legacy"
  });
  const opencodeResult = await opencode.run({
    runId: "run-opencode-native",
    sessionId: "session-1",
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "opencode",
      workflow: "chat.generic",
      userInput: { text: "ping", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: []
    }),
    outputContract: { kind: "plain-text" }
  }, () => undefined);

  assert.equal(opencodeResult.nativeExecution?.kind, "session");
  assert.equal(opencodeResult.nativeExecution?.persistence, "provider-persistent");
  assert.equal(opencodeResult.nativeExecution?.providerEndpoint, "http://127.0.0.1:4096");
  assert.equal(opencode.manifest.nativeExecution?.dispositions.delete, true);
  assert.equal(opencode.manifest.nativeExecution?.dispositions.archive, false);
  assert.equal(opencode.manifest.nativeExecution?.dispositions.processExit, false);
  const opencodeCleanup = await opencode.disposeNativeExecution?.({
    ref: opencodeResult.nativeExecution!,
    requested: "archive",
    reason: "knowledge-run-completed"
  });
  assert.equal(opencodeCleanup?.outcome, "unsupported");
  const opencodeDelete = await opencode.disposeNativeExecution?.({
    ref: opencodeResult.nativeExecution!,
    requested: "delete",
    reason: "manual"
  });
  assert.equal(opencodeDelete?.outcome, "disposed");
  assert.deepEqual(deletedSessions, ["opencode-session-1"]);
  const mismatchedDelete = await opencode.disposeNativeExecution?.({
    ref: { ...opencodeResult.nativeExecution!, providerEndpoint: "http://127.0.0.1:4999" },
    requested: "delete",
    reason: "manual"
  });
  assert.equal(mismatchedDelete?.outcome, "retained");
  assert.deepEqual(deletedSessions, ["opencode-session-1"]);
  assert.equal(disconnectCalls, 0, "native cleanup must not be implemented as runtime.disconnect()");

  const hermes = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime: fakeRuntime({ kind: "hermes", result: { text: "pong", runId: "hermes-run-1" } }),
    capabilities: "legacy"
  });
  const hermesResult = await hermes.run({
    runId: "run-hermes-native",
    sessionId: "session-1",
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "hermes",
      workflow: "chat.generic",
      userInput: { text: "ping", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: []
    }),
    outputContract: { kind: "plain-text" }
  }, () => undefined);

  assert.equal(hermesResult.nativeExecution?.kind, "run");
  assert.equal(hermesResult.nativeExecution?.persistence, "unknown");
  assert.equal(hermes.manifest.nativeExecution?.dispositions.delete, false);
  assert.equal(hermes.manifest.nativeExecution?.dispositions.archive, false);
  assert.equal(hermes.manifest.nativeExecution?.dispositions.processExit, false);
  const hermesCleanup = await hermes.disposeNativeExecution?.({
    ref: hermesResult.nativeExecution!,
    requested: "delete",
    reason: "knowledge-run-completed"
  });
  assert.equal(hermesCleanup?.outcome, "unsupported");
}

async function assertCodexRichAdapterStartsThreadAndTurn(): Promise<void> {
  const calls: string[] = [];
  const archived: string[] = [];
  let threadId = "";
  let turnId = "";
  let startThreadDeveloperInstructions = "";
  let startTurnDeveloperInstructions = "";
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => threadId,
    setNativeThreadId: (next) => {
      threadId = next;
    },
    buildInput: (currentThreadId) => {
      calls.push(`buildInput:${currentThreadId}`);
      return [{ type: "text" as const, text: "ping", text_elements: [] }];
    },
    startThread: async (options) => {
      calls.push("startThread");
      startThreadDeveloperInstructions = options?.developerInstructions ?? "";
      return { threadId: "codex-thread-1", title: "Thread" };
    },
    resumeThread: async (id) => {
      calls.push(`resumeThread:${id}`);
    },
    startTurn: async (id, input, options) => {
      calls.push(`startTurn:${id}:${input[0]?.type}`);
      startTurnDeveloperInstructions = options?.developerInstructions ?? "";
      return "codex-turn-1";
    },
    archiveThread: async (id) => {
      archived.push(id);
    },
    nativeRefContext: {
      deviceKey: "device-1",
      vaultId: "vault-1"
    },
    onTurnStarted: (ids) => {
      turnId = ids.turnId;
    }
  });
  const result = await adapter.run({
    runId: "run-codex",
    sessionId: "session-1",
    input: { text: "ping", attachments: [] },
    permissions: { mode: "workspace-write", writableRoots: [], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context: compileContextBundle({
      session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "ping", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: [],
      vaultProfileSections: [{
        id: "vault-profile:knowledge-rules",
        priority: 9_000,
        channel: "system",
        content: "CODEX-INJECTED-KNOWLEDGE-RULES",
        source: "vault:LLM-WIKI.md#sha256:test",
        required: true,
        sensitive: true
      }]
    }),
    outputContract: { kind: "plain-text" }
  }, () => undefined);

  assert.equal(result.status, "running");
  assert.equal(result.nativeThreadId, "codex-thread-1");
  assert.equal(result.nativeSessionId, "codex-turn-1");
  assert.equal(result.nativeExecution?.kind, "thread");
  assert.equal(result.nativeExecution?.persistence, "provider-persistent");
  assert.equal(adapter.manifest.nativeExecution?.dispositions.archive, true);
  assert.equal(adapter.manifest.nativeExecution?.dispositions.delete, false);
  assert.equal(turnId, "codex-turn-1");
  assert.match(startThreadDeveloperInstructions, /CODEX-INJECTED-KNOWLEDGE-RULES/);
  assert.match(startTurnDeveloperInstructions, /CODEX-INJECTED-KNOWLEDGE-RULES/);
  assert.deepEqual(calls, ["startThread", "buildInput:codex-thread-1", "startTurn:codex-thread-1:text"]);
  const disposed = await adapter.disposeNativeExecution({
    ref: result.nativeExecution!,
    requested: "archive",
    reason: "knowledge-run-completed"
  });
  const deleteResult = await adapter.disposeNativeExecution({
    ref: result.nativeExecution!,
    requested: "delete",
    reason: "manual"
  });
  assert.deepEqual(archived, ["codex-thread-1"]);
  assert.equal(disposed.outcome, "disposed");
  assert.equal(disposed.applied, "archive");
  assert.equal(deleteResult.outcome, "unsupported");
}

async function assertCodexRichAdapterFallsBackToStartThreadWhenResumeThreadThrows(): Promise<void> {
  const calls: string[] = [];
  let threadId = "missing-thread";
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => threadId,
    setNativeThreadId: (next) => { threadId = next; },
    buildInput: () => [{ type: "text", text: "continue", text_elements: [] }],
    resumeThread: async (id) => {
      calls.push(`resume:${id}`);
      throw new Error("thread not found");
    },
    startThread: async () => {
      calls.push("start");
      return { threadId: "replacement-thread", title: "Replacement" };
    },
    startTurn: async (id) => {
      calls.push(`turn:${id}`);
      return "replacement-turn";
    }
  });

  const result = await adapter.run(agentRunRequest("run-resume-fallback"), () => undefined);

  assert.equal(result.nativeThreadId, "replacement-thread");
  assert.equal(threadId, "replacement-thread");
  assert.deepEqual(calls, ["resume:missing-thread", "start", "turn:replacement-thread"]);
}

async function assertCodexRichAdapterReplacesStalePrewarmedThreadBeforePromptSubmission(): Promise<void> {
  const calls: string[] = [];
  let started = 0;
  let activeThreadId = "";
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: (threadId) => { activeThreadId = threadId; },
    buildInput: (threadId) => {
      calls.push(`input:${threadId}`);
      return [{ type: "text", text: "translate", text_elements: [] }];
    },
    resumeThread: async () => undefined,
    startThread: async () => {
      const threadId = started++ === 0 ? "stale-prewarm" : "replacement-thread";
      calls.push(`start:${threadId}`);
      return { threadId, title: "Editor action" };
    },
    startTurn: async (threadId) => {
      calls.push(`turn:${threadId}`);
      if (threadId === "stale-prewarm") throw new Error("JSON-RPC -32600: thread not found: stale-prewarm");
      return "replacement-turn";
    }
  });

  const result = await adapter.run(agentRunRequest("run-stale-prewarm-recovery"), () => undefined);

  assert.equal(result.nativeThreadId, "replacement-thread");
  assert.equal(activeThreadId, "replacement-thread");
  assert.deepEqual(calls, [
    "start:stale-prewarm",
    "input:stale-prewarm",
    "turn:stale-prewarm",
    "start:replacement-thread",
    "input:replacement-thread",
    "turn:replacement-thread"
  ]);

  let ambiguousStarts = 0;
  const ambiguousAdapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "do not duplicate", text_elements: [] }],
    resumeThread: async () => undefined,
    startThread: async () => ({ threadId: `ambiguous-${++ambiguousStarts}`, title: "Ambiguous" }),
    startTurn: async () => { throw new Error("connection closed after write"); }
  });

  await assert.rejects(
    ambiguousAdapter.run(agentRunRequest("run-ambiguous-start-turn"), () => undefined),
    /connection closed after write/
  );
  assert.equal(ambiguousStarts, 1, "ambiguous startTurn failures must never resubmit the prompt");

  let releaseReplacement: (() => void) | undefined;
  let replacementStarted: (() => void) | undefined;
  const replacementStartedPromise = new Promise<void>((resolve) => { replacementStarted = resolve; });
  const releaseReplacementPromise = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  const cancellationTurns: string[] = [];
  let cancellationStarts = 0;
  const cancellationAdapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: (threadId) => [{ type: "text", text: threadId, text_elements: [] }],
    resumeThread: async () => undefined,
    startThread: async () => {
      cancellationStarts += 1;
      if (cancellationStarts === 1) return { threadId: "cancel-stale", title: "Stale" };
      replacementStarted?.();
      await releaseReplacementPromise;
      return { threadId: "cancel-replacement", title: "Replacement" };
    },
    startTurn: async (threadId) => {
      cancellationTurns.push(threadId);
      if (threadId === "cancel-stale") throw new Error("thread not found: cancel-stale");
      return "must-not-submit";
    }
  });
  const cancellationRun = cancellationAdapter.run(agentRunRequest("run-cancel-stale-recovery"), () => undefined);
  await replacementStartedPromise;
  await cancellationAdapter.cancel("run-cancel-stale-recovery");
  releaseReplacement?.();
  const cancellationResult = await cancellationRun;
  assert.equal(cancellationResult.status, "cancelled");
  assert.deepEqual(cancellationTurns, ["cancel-stale"], "cancellation during recovery must not submit on the replacement thread");
}

async function assertCodexRichNotificationHubRoutesByIdsAndNoIdErrors(): Promise<void> {
  const hub = new CodexRichNotificationHub();
  const runA = createDriverHarness("run-a", { threadId: "thread-a", turnId: "turn-a" });
  const runB = createDriverHarness("run-b", { threadId: "thread-b", turnId: "turn-b" });
  hub.register(runA.driver);
  hub.register(runB.driver);

  assert.equal(hub.dispatch({
    method: "item/started",
    params: {
      threadId: "thread-a",
      turnId: "turn-a",
      itemId: "item-a",
      item: { id: "item-a", type: "commandExecution", title: "ls" }
    }
  }), true);
  assert.equal(hub.dispatch({
    method: "item/commandExecution/outputDelta",
    params: {
      itemId: "item-a",
      delta: "stdout"
    }
  }), true);
  assert.equal(hub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "thread-b",
      turn: { id: "turn-b", status: "completed" }
    }
  }), true);
  assert.equal(hub.dispatch({
    method: "error",
    params: { message: "ambiguous error" }
  }), true);

  hub.unregister("run-b");

  assert.equal(hub.dispatch({
    method: "error",
    params: { message: "single active error" }
  }), true);

  const resultA = await runA.driver.awaitResult();
  const resultB = await runB.driver.awaitResult();

  assert.equal(resultA.status, "failed");
  assert.equal(resultB.status, "completed");
  assert.deepEqual(
    runA.events.map((event) => event.type),
    ["tool.started", "tool.output.delta", "run.failed"]
  );
  assert.deepEqual(
    runB.events.map((event) => event.type),
    ["run.completed"]
  );
}

async function assertCodexTokenUsageRoutesWithoutConsumingViewNotifications(): Promise<void> {
  const hub = new CodexRichNotificationHub();
  const usageBeforeTerminal = createDriverHarness("run-usage-before-terminal", {
    threadId: "thread-usage-before-terminal",
    turnId: "turn-usage-before-terminal"
  });
  hub.register(usageBeforeTerminal.driver);

  assert.equal(hub.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-usage-before-terminal",
      tokenUsage: {
        last: { inputTokens: 8, outputTokens: 3 },
        total: { totalTokens: 999 }
      }
    }
  } as any), false, "usage must continue to the View router after reaching the active driver");
  assert.equal(hub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "thread-usage-before-terminal",
      turn: { id: "turn-usage-before-terminal", status: "completed" }
    }
  }), true);
  await usageBeforeTerminal.driver.awaitResult();
  await delay(0);
  assert.deepEqual(usageBeforeTerminal.events.map((event) => event.type), ["usage.updated", "run.completed"]);
  assert.deepEqual(usageBeforeTerminal.events[0]?.data?.usage, {
    totalTokens: 11,
    inputTokens: 8,
    outputTokens: 3
  });

  const usageAfterTerminal = createDriverHarness("run-usage-after-terminal", {
    threadId: "thread-usage-after-terminal",
    turnId: "turn-usage-after-terminal"
  });
  hub.register(usageAfterTerminal.driver);
  assert.equal(hub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "thread-usage-after-terminal",
      turn: { id: "turn-usage-after-terminal", status: "completed" }
    }
  }), true);
  assert.equal(hub.dispatch({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-usage-after-terminal",
      tokenUsage: {
        last: { inputTokens: 13, outputTokens: 5 },
        total: { totalTokens: 1_111 }
      }
    }
  } as any), false);
  await usageAfterTerminal.driver.awaitResult();
  await delay(0);
  assert.deepEqual(usageAfterTerminal.events.map((event) => event.type), ["run.completed", "usage.updated"], "queued usage immediately after the terminal must not be dropped");
  assert.equal(usageAfterTerminal.events.filter((event) => event.type === "run.completed").length, 1);
  assert.deepEqual(usageAfterTerminal.events[1]?.data?.usage, {
    totalTokens: 18,
    inputTokens: 13,
    outputTokens: 5
  });

  const countBeforeCompaction = usageAfterTerminal.events.length;
  assert.equal(hub.dispatch({
    method: "thread/compacted",
    params: { threadId: "thread-usage-after-terminal", tokenUsage: { total: { totalTokens: 7 } } }
  } as any), false);
  await delay(0);
  assert.equal(usageAfterTerminal.events.length, countBeforeCompaction, "compaction must remain a View-only notification");
}

async function assertCodexRichRunDriverMapsNotificationsToHarnessEvents(): Promise<void> {
  const { driver, events } = createDriverHarness("run-map", {
    threadId: "thread-map",
    turnId: "turn-map"
  });

  driver.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "assistant-1",
      delta: "Hello "
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "agentMessage",
        text: "Hello world"
      }
    }
  });
  driver.handleNotification({
    method: "item/reasoning/summaryPartAdded",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "reason-1"
    }
  });
  driver.handleNotification({
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "reason-1",
      delta: "Thinking"
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "reason-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "reasoning",
        text: "Thinking done"
      }
    }
  });
  driver.handleNotification({
    method: "turn/plan/updated",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      plan: [{ step: "收集", status: "completed" }]
    }
  });
  driver.handleNotification({
    method: "item/started",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "cmd-1",
      item: {
        id: "cmd-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "commandExecution",
        command: "pwd",
        cwd: "/vault",
        processId: null,
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    }
  });
  driver.handleNotification({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "cmd-1",
      delta: "/vault\n"
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "cmd-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "commandExecution",
        status: "completed",
        command: "pwd",
        cwd: "/vault",
        processId: null,
        aggregatedOutput: "/vault\n",
        exitCode: 0,
        durationMs: 8
      }
    }
  });
  driver.handleNotification({
    method: "item/started",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "tool-1",
      item: {
        id: "tool-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "mcpToolCall",
        title: "search.query",
        toolName: "search.query"
      }
    }
  });
  driver.handleNotification({
    method: "item/mcpToolCall/progress",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "tool-1",
      message: "searching"
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "tool-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "mcpToolCall",
        status: "failed",
        error: "network"
      }
    }
  });
  driver.handleNotification({
    method: "item/started",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "file-1",
      item: {
        id: "file-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "fileChange",
        title: "main.ts"
      }
    }
  });
  driver.handleNotification({
    method: "item/fileChange/outputDelta",
    params: {
      threadId: "thread-map",
      turnId: "turn-map",
      itemId: "file-1",
      delta: "updated main.ts"
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "file-1",
        threadId: "thread-map",
        turnId: "turn-map",
        type: "fileChange",
        status: "completed"
      }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-map",
      turn: { id: "turn-map", status: "completed" },
      usage: {
        last: { inputTokens: 6, outputTokens: 5 },
        total: { totalTokens: 999 }
      }
    }
  });

  const result = await driver.awaitResult();

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Hello world");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "agent.message.delta",
      "agent.message.completed",
      "agent.reasoning.started",
      "agent.reasoning.summary.delta",
      "agent.reasoning.summary.completed",
      "agent.plan.updated",
      "tool.started",
      "tool.output.delta",
      "tool.completed",
      "tool.started",
      "tool.output.delta",
      "tool.failed",
      "file.change.proposed",
      "file.change.proposed",
      "file.change.applied",
      "usage.updated",
      "run.completed"
    ]
  );
  for (const event of events) {
    assert.equal("threadId" in (event.data ?? {}), false);
    assert.equal("turnId" in (event.data ?? {}), false);
    assert.equal("itemId" in (event.data ?? {}), false);
  }
  assert.equal(events.find((event) => event.type === "agent.message.delta")?.data?.messageId, "assistant-1");
  assert.deepEqual(
    pickProcessIdentity(events.find((event) => event.type === "agent.reasoning.summary.delta")?.data),
    { blockId: "reason-1", reasoningKind: "summary", visibility: "public" }
  );
  const commandStarted = events.find((event) => event.type === "tool.started" && event.data?.callId === "cmd-1");
  assert.equal(commandStarted?.data?.semanticKind, "command");
  assert.equal(commandStarted?.data?.inputState, "provided");
  assert.equal(commandStarted?.data?.input, "pwd");
  assert.equal(commandStarted?.data?.outputState, "unavailable");
  const commandDelta = events.find((event) => event.type === "tool.output.delta" && event.data?.callId === "cmd-1");
  assert.equal(commandDelta?.data?.outputState, "provided", "streamed command stdout must remain expandable before completion");
  const mcpProgress = events.find((event) => event.type === "tool.output.delta" && event.data?.callId === "tool-1");
  assert.notEqual(mcpProgress?.data?.outputState, "provided", "MCP progress text is not raw tool output");
  const commandCompleted = events.find((event) => event.type === "tool.completed" && event.data?.callId === "cmd-1");
  assert.equal(commandCompleted?.data?.outputState, "provided");
  assert.equal(commandCompleted?.data?.output, "/vault\n");
  assert.equal(commandCompleted?.text, "/vault\n");
  assert.equal(events.find((event) => event.type === "file.change.proposed" && event.data?.callId === "file-1")?.data?.semanticKind, "edit");
  assert.deepEqual(events.find((event) => event.type === "usage.updated")?.data?.usage, {
    totalTokens: 11,
    inputTokens: 6,
    outputTokens: 5
  }, "Codex usage must expose the per-turn last snapshot, not cumulative totals");
}

async function assertHarnessProjectorPreservesProvidedCommandChannels(): Promise<void> {
  const answer: ChatMessage = {
    id: "answer:run-command-projection",
    role: "assistant",
    itemType: "assistant",
    status: "running",
    title: "Codex",
    text: "Agent 正在处理...",
    backendId: "codex-cli",
    runId: "run-command-projection",
    createdAt: 1_000
  };
  const projector = new HarnessEventProjector({
    runId: "run-command-projection",
    backendId: "codex-cli",
    vaultPath: "/vault",
    answerMessage: answer
  });
  const project = (sequence: number, type: HarnessEvent["type"], patch: Partial<HarnessEvent>): void => {
    projector.project({
      eventId: `run-command-projection:${sequence}`,
      runId: "run-command-projection",
      sequence,
      createdAt: 1_000 + sequence,
      source: "tool",
      type,
      backendId: "codex-cli",
      ...patch
    });
  };

  project(1, "tool.started", {
    toolName: "pwd",
    data: {
      callId: "cmd-real-shape",
      semanticKind: "command",
      toolStatus: "running",
      inputState: "provided",
      input: "pwd",
      outputState: "unavailable",
      aggregatedOutput: null
    }
  });
  project(2, "tool.output.delta", {
    toolName: "pwd",
    text: "/vault\n",
    data: {
      callId: "cmd-real-shape",
      semanticKind: "command",
      toolStatus: "running",
      outputState: "provided"
    }
  });
  project(3, "tool.completed", {
    toolName: "pwd",
    data: {
      callId: "cmd-real-shape",
      semanticKind: "command",
      toolStatus: "completed",
      inputState: "empty",
      outputState: "unavailable",
      aggregatedOutput: "/vault\n"
    }
  });
  project(4, "tool.completed", {
    toolName: "pwd",
    data: {
      callId: "cmd-real-shape",
      semanticKind: "command",
      toolStatus: "completed",
      outputState: "empty"
    }
  });

  const command = projector.snapshot().find((message) => message.id.endsWith("cmd-real-shape"));
  assert.equal(command?.status, "completed");
  assert.equal(command?.processInputAvailability, "provided", "a sparse completion must not erase a provided command input");
  assert.equal(command?.processInput, "pwd");
  assert.equal(command?.processOutputAvailability, "provided", "unavailable/empty completion metadata must not erase streamed stdout");
  assert.equal(command?.processOutput, "/vault\n");
  assert.equal(command?.text, "/vault\n");
}

function pickProcessIdentity(data: HarnessEvent["data"]): Record<string, unknown> {
  return {
    blockId: data?.blockId,
    reasoningKind: data?.reasoningKind,
    visibility: data?.visibility
  };
}

async function assertCodexRichRunDriverNormalizesMissingIdsAndNonSuccessStatuses(): Promise<void> {
  const { driver, events } = createDriverHarness("run-missing-ids", {
    threadId: "thread-missing-ids",
    turnId: "turn-missing-ids"
  });

  driver.handleNotification({ method: "item/agentMessage/delta", params: { delta: "Before tool" } });
  driver.handleNotification({
    method: "item/started",
    params: { item: { type: "mcpToolCall", title: "boundary tool" } }
  });
  driver.handleNotification({
    method: "item/completed",
    params: { item: { type: "mcpToolCall", status: "completed", output: "boundary done" } }
  });
  driver.handleNotification({ method: "item/agentMessage/delta", params: { delta: "After tool" } });

  for (const text of ["First", "Second"]) {
    driver.handleNotification({
      method: "item/completed",
      params: { item: { type: "agentMessage", text } }
    });
  }
  for (const text of ["Reason one", "Reason two"]) {
    driver.handleNotification({ method: "item/reasoning/summaryPartAdded", params: {} });
    driver.handleNotification({ method: "item/reasoning/summaryTextDelta", params: { delta: text } });
    driver.handleNotification({ method: "item/completed", params: { item: { type: "reasoning", text } } });
  }
  driver.handleNotification({
    method: "item/started",
    params: { item: { type: "commandExecution", title: "first command", command: "echo first" } }
  });
  driver.handleNotification({
    method: "item/started",
    params: { item: { type: "commandExecution", title: "second command", command: "echo second" } }
  });
  driver.handleNotification({
    method: "item/completed",
    params: { item: { type: "commandExecution", status: "cancelled", error: "stopped" } }
  });
  driver.handleNotification({
    method: "item/completed",
    params: { item: { type: "commandExecution", status: "denied", error: "not approved" } }
  });
  driver.handleNotification({
    method: "item/started",
    params: {
      item: {
        type: "fileChange",
        title: "testing/a.md",
        changes: [{ path: "testing/a.md", kind: "update", added: 1, removed: 0 }]
      }
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        type: "fileChange",
        status: "error",
        error: "patch failed",
        changes: [{ path: "testing/a.md", kind: "update", added: 1, removed: 0 }]
      }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: { turn: { status: "error", error: "provider error" } }
  });

  const result = await driver.awaitResult();
  assert.equal(result.status, "failed");

  const messageIds = events
    .filter((event) => event.type === "agent.message.completed")
    .map((event) => event.data?.messageId);
  assert.equal(new Set(messageIds).size, 2);
  assert.ok(messageIds.every(Boolean));
  const boundaryMessageIds = events
    .filter((event) => event.type === "agent.message.delta")
    .map((event) => event.data?.messageId);
  assert.equal(new Set(boundaryMessageIds).size, 2);

  const blockIds = events
    .filter((event) => event.type === "agent.reasoning.summary.completed")
    .map((event) => event.data?.blockId);
  assert.equal(new Set(blockIds).size, 2);
  assert.ok(blockIds.every(Boolean));

  const startedCommands = events.filter((event) => event.type === "tool.started" && event.data?.semanticKind === "command");
  assert.equal(startedCommands.length, 2);
  assert.equal(new Set(startedCommands.map((event) => event.data?.callId)).size, 2);
  const interrupted = events.find((event) => event.type === "tool.failed" && event.data?.toolStatus === "interrupted");
  const denied = events.find((event) => event.type === "tool.failed" && event.data?.toolStatus === "denied");
  assert.equal(interrupted?.data?.callId, startedCommands[0].data?.callId);
  assert.equal(denied?.data?.callId, startedCommands[1].data?.callId);

  const proposedFile = events.find((event) => event.type === "file.change.proposed" && Array.isArray(event.data?.files));
  const revertedFile = events.find((event) => event.type === "file.change.reverted");
  assert.deepEqual(proposedFile?.data?.files, ["testing/a.md"]);
  assert.deepEqual(proposedFile?.data?.diff, [{ path: "testing/a.md", kind: "update", added: 1, removed: 0 }]);
  assert.equal(revertedFile?.data?.toolStatus, "failed");
  assert.equal(revertedFile?.data?.callId, proposedFile?.data?.callId);
  assert.equal(events.at(-1)?.type, "run.failed");
}

async function assertCodexRichRunDriverAggregatesAssistantTextAndTerminalIsIdempotent(): Promise<void> {
  const { driver, events } = createDriverHarness("run-terminal", {
    threadId: "thread-terminal",
    turnId: "turn-terminal"
  });

  driver.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-terminal",
      turnId: "turn-terminal",
      itemId: "assistant-terminal",
      delta: "Hello"
    }
  });
  driver.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      itemId: "assistant-terminal",
      delta: " world"
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-terminal",
      turn: { id: "turn-terminal", status: "completed" }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-terminal",
      turn: { id: "turn-terminal", status: "completed" }
    }
  });
  driver.handleNotification({
    method: "error",
    params: {
      threadId: "thread-terminal",
      turnId: "turn-terminal",
      message: "late error"
    }
  });

  const result = await driver.awaitResult();

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Hello world");
  assert.deepEqual(events.map((event) => event.type), [
    "agent.message.delta",
    "agent.message.delta",
    "run.completed"
  ]);
}

async function assertCodexRichRunDriverMapsInterruptedTerminalStatusesToCancelled(): Promise<void> {
  for (const status of ["cancelled", "canceled", "interrupted", "aborted"]) {
    const { driver, events } = createDriverHarness(`run-${status}`, {
      threadId: `thread-${status}`,
      turnId: `turn-${status}`
    });

    driver.handleNotification({
      method: "turn/completed",
      params: {
        threadId: `thread-${status}`,
        turn: { id: `turn-${status}`, status }
      }
    });

    const result = await driver.awaitResult();
    assert.equal(result.status, "cancelled", `${status} 不能被误记为 completed`);
    assert.equal(result.outputText, undefined);
    assert.deepEqual(events.map((event) => event.type), ["run.cancelled"]);
  }
}

async function assertCodexRichRunDriverUsesCompletedOnlyAssistantAsFinalOutput(): Promise<void> {
  const { driver, events } = createDriverHarness("run-completed-only-final", {
    threadId: "thread-completed-only-final",
    turnId: "turn-completed-only-final"
  });

  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-completed-only-final",
        threadId: "thread-completed-only-final",
        turnId: "turn-completed-only-final",
        type: "agentMessage",
        text: "Final only"
      }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-completed-only-final",
      turn: { id: "turn-completed-only-final", status: "completed" }
    }
  });

  const result = await driver.awaitResult();

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Final only");
  assert.deepEqual(events.map((event) => event.type), [
    "agent.message.completed",
    "run.completed"
  ]);
}

async function assertCodexRichRunDriverSettlesFinalAnswerWithoutTurnCompleted(): Promise<void> {
  const { driver, events } = createDriverHarness("run-final-answer-fallback", {
    threadId: "thread-final-answer-fallback",
    turnId: "turn-final-answer-fallback",
    finalAnswerGraceMs: 5
  });

  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-final-answer-fallback",
        threadId: "thread-final-answer-fallback",
        turnId: "turn-final-answer-fallback",
        type: "agentMessage",
        phase: "final_answer",
        text: "Recovered terminal answer"
      }
    }
  });

  const result = await driver.awaitResult();
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-final-answer-fallback",
      turn: { id: "turn-final-answer-fallback", status: "completed" }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Recovered terminal answer");
  assert.deepEqual(events.map((event) => event.type), ["agent.message.completed", "run.completed"]);
  assert.equal(events.at(-1)?.data?.settlement, "final-answer-grace");
}

async function assertCodexRichRunDriverPrefersOfficialTurnCompletedDuringGrace(): Promise<void> {
  const { driver, events } = createDriverHarness("run-final-answer-official", {
    threadId: "thread-final-answer-official",
    turnId: "turn-final-answer-official",
    finalAnswerGraceMs: 20
  });

  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-final-answer-official",
        threadId: "thread-final-answer-official",
        turnId: "turn-final-answer-official",
        type: "agentMessage",
        phase: "final_answer",
        text: "Official terminal answer"
      }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-final-answer-official",
      turn: { id: "turn-final-answer-official", status: "completed" }
    }
  });

  const result = await driver.awaitResult();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Official terminal answer");
  assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(events.at(-1)?.data?.settlement, undefined);
}

async function assertCodexRichRunDriverCancelsFinalAnswerFallbackForFollowUpWork(): Promise<void> {
  const { driver, events } = createDriverHarness("run-final-answer-follow-up", {
    threadId: "thread-final-answer-follow-up",
    turnId: "turn-final-answer-follow-up",
    finalAnswerGraceMs: 5
  });

  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-final-answer-follow-up",
        threadId: "thread-final-answer-follow-up",
        turnId: "turn-final-answer-follow-up",
        type: "agentMessage",
        phase: "final_answer",
        text: "Answer before follow-up"
      }
    }
  });
  driver.handleNotification({
    method: "item/started",
    params: {
      item: {
        id: "tool-after-final-answer",
        threadId: "thread-final-answer-follow-up",
        turnId: "turn-final-answer-follow-up",
        type: "commandExecution",
        command: "echo follow-up"
      }
    }
  });

  const pending = await Promise.race([
    driver.awaitResult().then(() => "settled"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 15))
  ]);
  assert.equal(pending, "pending");

  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-final-answer-follow-up",
      turn: { id: "turn-final-answer-follow-up", status: "completed" }
    }
  });
  assert.equal((await driver.awaitResult()).status, "completed");
  assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
}

async function assertCodexRichRunDriverPreservesCompletedOnlyAssistantOrder(): Promise<void> {
  const { driver, events } = createDriverHarness("run-completed-only-order", {
    threadId: "thread-completed-only-order",
    turnId: "turn-completed-only-order"
  });

  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-completed-only-order-1",
        threadId: "thread-completed-only-order",
        turnId: "turn-completed-only-order",
        type: "agentMessage",
        text: "Hello "
      }
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-completed-only-order-2",
        threadId: "thread-completed-only-order",
        turnId: "turn-completed-only-order",
        type: "agentMessage",
        text: "world"
      }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-completed-only-order",
      turn: { id: "turn-completed-only-order", status: "completed" }
    }
  });

  const result = await driver.awaitResult();

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Hello world");
  assert.deepEqual(events.map((event) => event.type), [
    "agent.message.completed",
    "agent.message.completed",
    "run.completed"
  ]);
}

async function assertCodexRichRunDriverDoesNotDuplicateDeltaAndCompletedAssistantText(): Promise<void> {
  const { driver, events } = createDriverHarness("run-delta-completed-dedup", {
    threadId: "thread-delta-completed-dedup",
    turnId: "turn-delta-completed-dedup"
  });

  driver.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-delta-completed-dedup",
      turnId: "turn-delta-completed-dedup",
      itemId: "assistant-delta-completed-dedup",
      delta: "Hello "
    }
  });
  driver.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      itemId: "assistant-delta-completed-dedup",
      delta: "world"
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-delta-completed-dedup",
        threadId: "thread-delta-completed-dedup",
        turnId: "turn-delta-completed-dedup",
        type: "agentMessage",
        text: "Hello world"
      }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-delta-completed-dedup",
      turn: { id: "turn-delta-completed-dedup", status: "completed" }
    }
  });

  const result = await driver.awaitResult();

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Hello world");
  assert.deepEqual(events.map((event) => event.type), [
    "agent.message.delta",
    "agent.message.delta",
    "agent.message.completed",
    "run.completed"
  ]);
}

async function assertCodexRichRunDriverDoesNotMisselectEmptyProcessAssistant(): Promise<void> {
  const { driver, events } = createDriverHarness("run-empty-process-assistant", {
    threadId: "thread-empty-process-assistant",
    turnId: "turn-empty-process-assistant"
  });

  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-empty-process",
        threadId: "thread-empty-process-assistant",
        turnId: "turn-empty-process-assistant",
        type: "agentMessage",
        text: ""
      }
    }
  });
  driver.handleNotification({
    method: "item/completed",
    params: {
      item: {
        id: "assistant-final-process",
        threadId: "thread-empty-process-assistant",
        turnId: "turn-empty-process-assistant",
        type: "agentMessage",
        text: "Final answer"
      }
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-empty-process-assistant",
      turn: { id: "turn-empty-process-assistant", status: "completed" }
    }
  });

  const result = await driver.awaitResult();

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Final answer");
  assert.deepEqual(events.map((event) => event.type), [
    "agent.message.completed",
    "agent.message.completed",
    "run.completed"
  ]);
}

async function assertCodexRichRunDriverIgnoresRetryingErrors(): Promise<void> {
  const { driver, events } = createDriverHarness("run-retrying-error", {
    threadId: "retrying-error-thread",
    turnId: "retrying-error-turn"
  });

  driver.handleNotification({
    method: "error",
    params: {
      threadId: "retrying-error-thread",
      turnId: "retrying-error-turn",
      message: "transient top-level error",
      willRetry: true
    }
  });
  driver.handleNotification({
    method: "error",
    params: {
      threadId: "retrying-error-thread",
      turnId: "retrying-error-turn",
      message: "transient nested error",
      error: { willRetry: true }
    }
  });

  assert.equal(await promiseStillPending(driver.awaitResult()), true);

  driver.handleNotification({
    method: "item/agentMessage/delta",
    params: {
      threadId: "retrying-error-thread",
      turnId: "retrying-error-turn",
      itemId: "retrying-answer",
      delta: "Recovered after retry"
    }
  });
  driver.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "retrying-error-thread",
      turn: { id: "retrying-error-turn", status: "completed" }
    }
  });

  const result = await driver.awaitResult();
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Recovered after retry");
  assert.deepEqual(events.map((event) => event.type), ["agent.message.delta", "run.completed"]);
}

async function assertCodexRichRunDriverSettlesWhenTerminalEmitRejects(): Promise<void> {
  const settled: AgentRunResult[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const driver = new CodexRichRunDriver({
      runId: "run-terminal-emit-reject",
      backendId: "codex-cli",
      threadId: "terminal-emit-reject-thread",
      turnId: "terminal-emit-reject-turn",
      emit: async () => {
        throw new Error("terminal emit rejected");
      },
      onSettled: (result) => {
        settled.push(result);
      }
    });

    driver.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "terminal-emit-reject-thread",
        turn: { id: "terminal-emit-reject-turn", status: "completed" }
      }
    });

    const timeout = Symbol("timeout");
    const result = await Promise.race([
      driver.awaitResult(),
      delay(20).then(() => timeout)
    ]);
    assert.notEqual(result, timeout, "terminal emit rejection must not leave awaitResult pending");
    assert.equal((result as AgentRunResult).status, "failed");
    assert.match((result as AgentRunResult).error ?? "", /terminal emit rejected/);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].status, "failed");
    await delay(0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function assertCodexRichRunDriverCatchesNotificationEmitRejection(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const driver = new CodexRichRunDriver({
      runId: "run-notification-emit-reject",
      backendId: "codex-cli",
      threadId: "notification-emit-reject-thread",
      turnId: "notification-emit-reject-turn",
      emit: async (event) => {
        if (event.type === "agent.message.delta") throw new Error("delta emit rejected");
      }
    });

    driver.handleNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "notification-emit-reject-thread",
        turnId: "notification-emit-reject-turn",
        itemId: "notification-emit-reject-item",
        delta: "still aggregated"
      }
    });
    await delay(0);
    driver.handleNotification({
      method: "turn/completed",
      params: {
        threadId: "notification-emit-reject-thread",
        turn: { id: "notification-emit-reject-turn", status: "completed" }
      }
    });

    const result = await driver.awaitResult();
    await delay(0);
    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "still aggregated");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function assertCodexRichAdapterInterruptsStartedTurnOnCancel(): Promise<void> {
  const interrupts: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "stop", text_elements: [] }],
    startThread: async () => ({ threadId: "cancel-thread", title: "Cancel thread" }),
    resumeThread: async () => undefined,
    startTurn: async () => "cancel-turn",
    interruptTurn: async (threadId, turnId) => {
      interrupts.push(`${threadId}:${turnId}`);
    }
  });

  const result = await adapter.run(agentRunRequest("run-codex-cancel-started"), () => undefined);
  assert.equal(result.status, "running");

  await adapter.cancel("run-codex-cancel-started");

  assert.deepEqual(interrupts, ["cancel-thread:cancel-turn"]);
}

async function assertCodexRichAdapterCleansUpCancelBeforeStartTurn(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  let releaseInput!: () => void;
  const inputBlocked = new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
  let inputStarted!: () => void;
  const inputPending = new Promise<void>((resolve) => {
    inputStarted = resolve;
  });
  let startTurnCalls = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: async () => {
      inputStarted();
      await inputBlocked;
      return [{ type: "text", text: "cancel before turn", text_elements: [] }];
    },
    startThread: async () => ({ threadId: "pre-turn-cancel-thread", title: "Pre-turn cancel" }),
    resumeThread: async () => undefined,
    startTurn: async () => {
      startTurnCalls += 1;
      return "must-not-start";
    }
  });

  const runPromise = adapter.run(agentRunRequest("run-codex-pre-turn-cancel"), () => undefined);
  await inputPending;
  await adapter.cancel("run-codex-pre-turn-cancel");
  releaseInput();

  const result = await runPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(startTurnCalls, 0);
  assert.equal(notificationHub.dispatch({
    method: "error",
    params: { message: "stale notification" }
  }), false);
  await assert.rejects(adapter.awaitResult("run-codex-pre-turn-cancel"), /Unknown Codex run/);
}

async function assertCodexRichAdapterCancelsPendingStartTurnWithoutReturningRunning(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const interrupts: string[] = [];
  let markStartTurnPending!: () => void;
  const startTurnPending = new Promise<void>((resolve) => {
    markStartTurnPending = resolve;
  });
  let resolveTurn!: (turnId: string) => void;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "late stop", text_elements: [] }],
    startThread: async () => ({ threadId: "pending-thread", title: "Pending thread" }),
    resumeThread: async () => undefined,
    startTurn: async () => await new Promise<string>((resolve) => {
      markStartTurnPending();
      resolveTurn = resolve;
    }),
    interruptTurn: async (threadId, turnId) => {
      interrupts.push(`${threadId}:${turnId}`);
    }
  });

  const runPromise = adapter.run(agentRunRequest("run-codex-pending-cancel"), () => undefined);
  await startTurnPending;
  await adapter.cancel("run-codex-pending-cancel");
  resolveTurn("pending-turn");

  const result = await runPromise;
  const awaited = await adapter.awaitResult("run-codex-pending-cancel");

  assert.equal(result.status, "cancelled");
  assert.equal(result.error, "Run cancelled");
  assert.equal(awaited.status, "cancelled");
  assert.deepEqual(interrupts, ["pending-thread:pending-turn"]);
}

async function assertCodexRichAdapterKeepsTerminalThatArrivesBeforeStartTurnResolves(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  let releaseTurn!: (turnId: string) => void;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "race", text_elements: [] }],
    startThread: async () => ({ threadId: "race-thread", title: "Race" }),
    resumeThread: async () => undefined,
    startTurn: async () => await new Promise<string>((resolve) => {
      releaseTurn = resolve;
    })
  });

  const runPromise = adapter.run(agentRunRequest("run-codex-race"), () => undefined);
  await delay(0);
  assert.equal(notificationHub.dispatch({
    method: "item/agentMessage/delta",
    params: {
      threadId: "race-thread",
      itemId: "assistant-race",
      delta: "Race done"
    }
  }), true);
  assert.equal(notificationHub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "race-thread",
      turn: { id: "race-turn", status: "completed" }
    }
  }), true);
  releaseTurn("race-turn");

  const runResult = await runPromise;
  const awaited = await adapter.awaitResult("run-codex-race");

  assert.equal(runResult.status, "running");
  assert.equal(awaited.status, "completed");
  assert.equal(awaited.outputText, "Race done");
}

async function assertCodexRichAdapterSettlesFailedAfterInterruptFailure(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const interrupts: string[] = [];
  let attempt = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "cancel retry", text_elements: [] }],
    startThread: async () => ({ threadId: "retry-thread", title: "Retry" }),
    resumeThread: async () => undefined,
    startTurn: async () => "retry-turn",
    interruptTurn: async (threadId, turnId) => {
      interrupts.push(`${threadId}:${turnId}:${++attempt}`);
      if (attempt === 1) throw new Error("interrupt failed");
    }
  });

  const runResult = await adapter.run(agentRunRequest("run-codex-cancel-retry"), () => undefined);
  assert.equal(runResult.status, "running");

  await assert.rejects(adapter.cancel("run-codex-cancel-retry"), /interrupt failed/);
  const awaited = await adapter.awaitResult("run-codex-cancel-retry");

  assert.deepEqual(interrupts, ["retry-thread:retry-turn:1"]);
  assert.equal(awaited.status, "failed");
  assert.match(awaited.error ?? "", /Codex interrupt failed/);
}

async function assertCodexRichAdapterRecoversArtifactsAfterInactivity(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const interrupts: string[] = [];
  const lifecycle: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    inactivityTimeoutMs: 5,
    artifactRecovery: async () => {
      lifecycle.push("recover");
      return "Recovered artifact answer";
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "recover", text_elements: [] }],
    startThread: async () => ({ threadId: "recover-thread", title: "Recover" }),
    resumeThread: async () => undefined,
    startTurn: async () => "recover-turn",
    interruptTurn: async (threadId, turnId) => {
      lifecycle.push("interrupt");
      interrupts.push(`${threadId}:${turnId}`);
    }
  });

  const runResult = await adapter.run(agentRunRequest("run-codex-recover"), () => undefined);
  const awaited = await adapter.awaitResult("run-codex-recover");

  assert.equal(runResult.status, "running");
  assert.equal(awaited.status, "completed");
  assert.equal(awaited.outputText, "Recovered artifact answer");
  assert.deepEqual(interrupts, ["recover-thread:recover-turn"]);
  assert.deepEqual(lifecycle, ["interrupt", "recover"]);
}

async function assertCodexRichAdapterRecoversArtifactsAfterInactivityInterruptFailure(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const lifecycle: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    inactivityTimeoutMs: 5,
    artifactRecovery: async () => {
      lifecycle.push("recover");
      return "Recovered after interrupt failure";
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "recover after interrupt failure", text_elements: [] }],
    startThread: async () => ({ threadId: "interrupt-fail-thread", title: "Interrupt failure" }),
    resumeThread: async () => undefined,
    startTurn: async () => "interrupt-fail-turn",
    interruptTurn: async () => {
      lifecycle.push("interrupt");
      throw new Error("interrupt failed before recovery");
    }
  });

  await adapter.run(agentRunRequest("run-codex-interrupt-fail-recover"), () => undefined);
  const result = await adapter.awaitResult("run-codex-interrupt-fail-recover");

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Recovered after interrupt failure");
  assert.deepEqual(lifecycle, ["interrupt", "recover"]);
}

async function assertCodexRichAdapterInterruptsAfterInactivityWithoutArtifactRecovery(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const interrupts: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    inactivityTimeoutMs: 5,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "timeout without recovery", text_elements: [] }],
    startThread: async () => ({ threadId: "no-recovery-thread", title: "No recovery" }),
    resumeThread: async () => undefined,
    startTurn: async () => "no-recovery-turn",
    interruptTurn: async (threadId, turnId) => {
      interrupts.push(`${threadId}:${turnId}`);
    }
  });

  await adapter.run(agentRunRequest("run-codex-no-recovery"), () => undefined);
  const result = await adapter.awaitResult("run-codex-no-recovery");

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Codex inactivity timeout/);
  assert.deepEqual(interrupts, ["no-recovery-thread:no-recovery-turn"]);
}

async function assertCodexRichAdapterFailsWhenArtifactRecoveryFails(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const interrupts: string[] = [];
  const lifecycle: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    inactivityTimeoutMs: 5,
    artifactRecovery: async () => {
      lifecycle.push("recover");
      throw new Error("artifact recovery failed");
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "recover fail", text_elements: [] }],
    startThread: async () => ({ threadId: "recover-fail-thread", title: "Recover fail" }),
    resumeThread: async () => undefined,
    startTurn: async () => "recover-fail-turn",
    interruptTurn: async (threadId, turnId) => {
      lifecycle.push("interrupt");
      interrupts.push(`${threadId}:${turnId}`);
    }
  });

  await adapter.run(agentRunRequest("run-codex-recover-fail"), () => undefined);
  const awaited = await adapter.awaitResult("run-codex-recover-fail");

  assert.equal(awaited.status, "failed");
  assert.match(awaited.error ?? "", /artifact recovery failed/);
  assert.deepEqual(interrupts, ["recover-fail-thread:recover-fail-turn"]);
  assert.deepEqual(lifecycle, ["interrupt", "recover"]);
}

async function assertCodexRichAdapterFailsWhenArtifactRecoveryIsEmpty(): Promise<void> {
  for (const [suffix, recovered] of [["null", null], ["blank", "   "]] as const) {
    const notificationHub = new CodexRichNotificationHub();
    const interrupts: string[] = [];
    const lifecycle: string[] = [];
    const adapter = new CodexRichAgentAdapter({
      displayName: "Codex",
      version: "test",
      notificationHub,
      inactivityTimeoutMs: 5,
      artifactRecovery: async () => {
        lifecycle.push("recover");
        return recovered;
      },
      getNativeThreadId: () => undefined,
      setNativeThreadId: () => undefined,
      buildInput: () => [{ type: "text", text: "empty recovery", text_elements: [] }],
      startThread: async () => ({ threadId: `empty-recovery-${suffix}-thread`, title: "Empty recovery" }),
      resumeThread: async () => undefined,
      startTurn: async () => `empty-recovery-${suffix}-turn`,
      interruptTurn: async (threadId, turnId) => {
        lifecycle.push("interrupt");
        interrupts.push(`${threadId}:${turnId}`);
      }
    });

    await adapter.run(agentRunRequest(`run-codex-empty-recovery-${suffix}`), () => undefined);
    const result = await adapter.awaitResult(`run-codex-empty-recovery-${suffix}`);

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Codex inactivity timeout/);
    assert.deepEqual(interrupts, [`empty-recovery-${suffix}-thread:empty-recovery-${suffix}-turn`]);
    assert.deepEqual(lifecycle, ["interrupt", "recover"]);
  }
}

async function assertCodexRichRunDriverBoundsInactivityInterruptBeforeRecovery(): Promise<void> {
  const lifecycle: string[] = [];
  const driver = new CodexRichRunDriver({
    runId: "run-codex-bounded-inactivity-interrupt",
    backendId: "codex-cli",
    threadId: "bounded-interrupt-thread",
    inactivityTimeoutMs: 5,
    interruptBarrierTimeoutMs: 5,
    artifactRecovery: async () => {
      lifecycle.push("recover");
      return "Recovered after bounded interrupt";
    },
    interruptTurn: async () => {
      lifecycle.push("interrupt");
      await new Promise<void>(() => undefined);
    },
    emit: async () => undefined
  });
  driver.setTurnId("bounded-interrupt-turn");

  const result = await settleWithin(driver.awaitResult(), 100);

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Recovered after bounded interrupt");
  assert.deepEqual(lifecycle, ["interrupt", "recover"]);
}

async function assertCodexRichRunDriverWaitsForInactivityInterruptBeforeRecovery(): Promise<void> {
  const lifecycle: string[] = [];
  let signalInterruptStarted!: () => void;
  const interruptStarted = new Promise<void>((resolve) => {
    signalInterruptStarted = resolve;
  });
  let releaseInterrupt!: () => void;
  const interruptReleased = new Promise<void>((resolve) => {
    releaseInterrupt = resolve;
  });
  const driver = new CodexRichRunDriver({
    runId: "run-codex-inactivity-interrupt-barrier",
    backendId: "codex-cli",
    threadId: "interrupt-barrier-thread",
    inactivityTimeoutMs: 5,
    interruptBarrierTimeoutMs: 100,
    artifactRecovery: async () => {
      lifecycle.push("recover");
      return "Recovered after interrupt barrier";
    },
    interruptTurn: async () => {
      lifecycle.push("interrupt");
      signalInterruptStarted();
      await interruptReleased;
    },
    emit: async () => undefined
  });
  driver.setTurnId("interrupt-barrier-turn");

  await interruptStarted;
  assert.deepEqual(lifecycle, ["interrupt"]);
  assert.equal(await promiseStillPending(driver.awaitResult()), true);
  releaseInterrupt();
  const result = await settleWithin(driver.awaitResult(), 100);

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Recovered after interrupt barrier");
  assert.deepEqual(lifecycle, ["interrupt", "recover"]);
}

async function assertCodexRichAdapterUnregistersCompletedRunFromNotificationHub(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  let threadId = "old-thread";
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: (next) => {
      threadId = next;
    },
    buildInput: () => [{ type: "text", text: "reuse", text_elements: [] }],
    startThread: async () => ({ threadId, title: "Thread" }),
    resumeThread: async () => undefined,
    startTurn: async () => threadId === "old-thread" ? "old-turn" : "new-turn"
  });

  await adapter.run(agentRunRequest("run-codex-old"), () => undefined);
  assert.equal(notificationHub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "old-thread",
      turn: { id: "old-turn", status: "completed" }
    }
  }), true);
  const oldResult = await adapter.awaitResult("run-codex-old");
  assert.equal(oldResult.status, "completed");

  threadId = "new-thread";
  await adapter.run(agentRunRequest("run-codex-new"), () => undefined);

  assert.equal(notificationHub.dispatch({
    method: "item/agentMessage/delta",
    params: {
      threadId: "old-thread",
      turnId: "old-turn",
      itemId: "stale-item",
      delta: "stale"
    }
  }), false);
  assert.equal(notificationHub.dispatch({
    method: "item/agentMessage/delta",
    params: {
      threadId: "new-thread",
      turnId: "new-turn",
      itemId: "fresh-item",
      delta: "fresh"
    }
  }), true);
  assert.equal(notificationHub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "new-thread",
      turn: { id: "new-turn", status: "completed" }
    }
  }), true);

  const newResult = await adapter.awaitResult("run-codex-new");
  assert.equal(newResult.outputText, "fresh");
}

async function assertCodexRichAdapterReleasesTerminalRunStatesAfterAwaitResult(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  let runIndex = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "terminal cleanup", text_elements: [] }],
    startThread: async () => {
      runIndex += 1;
      return { threadId: `terminal-thread-${runIndex}`, title: "Terminal cleanup" };
    },
    resumeThread: async () => undefined,
    startTurn: async (_threadId) => `terminal-turn-${runIndex}`,
    interruptTurn: async () => undefined
  });

  const completedRunId = "run-codex-terminal-completed";
  await adapter.run(agentRunRequest(completedRunId), () => undefined);
  notificationHub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "terminal-thread-1",
      turn: { id: "terminal-turn-1", status: "completed" }
    }
  });
  assert.equal((await adapter.awaitResult(completedRunId)).status, "completed");
  await assert.rejects(adapter.awaitResult(completedRunId), /Unknown Codex run/);

  const failedRunId = "run-codex-terminal-failed";
  await adapter.run(agentRunRequest(failedRunId), () => undefined);
  notificationHub.dispatch({
    method: "turn/completed",
    params: {
      threadId: "terminal-thread-2",
      turn: { id: "terminal-turn-2", status: "failed", error: "terminal failure" }
    }
  });
  assert.equal((await adapter.awaitResult(failedRunId)).status, "failed");
  await assert.rejects(adapter.awaitResult(failedRunId), /Unknown Codex run/);

  const cancelledRunId = "run-codex-terminal-cancelled";
  await adapter.run(agentRunRequest(cancelledRunId), () => undefined);
  await adapter.cancel(cancelledRunId);
  assert.equal((await adapter.awaitResult(cancelledRunId)).status, "cancelled");
  await assert.rejects(adapter.awaitResult(cancelledRunId), /Unknown Codex run/);
}

async function assertCodexRichAdapterDisposeCancelsAllActiveRuns(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const interrupts: string[] = [];
  let runIndex = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "dispose active run", text_elements: [] }],
    startThread: async () => {
      runIndex += 1;
      return { threadId: `dispose-thread-${runIndex}`, title: "Dispose" };
    },
    resumeThread: async () => undefined,
    startTurn: async (_threadId) => `dispose-turn-${runIndex}`,
    interruptTurn: async (threadId, turnId) => {
      interrupts.push(`${threadId}:${turnId}`);
      if (threadId === "dispose-thread-1") throw new Error("interrupt failed during dispose");
    }
  });

  await adapter.run(agentRunRequest("run-codex-dispose-1"), () => undefined);
  await adapter.run(agentRunRequest("run-codex-dispose-2"), () => undefined);
  const firstResult = adapter.awaitResult("run-codex-dispose-1");
  const secondResult = adapter.awaitResult("run-codex-dispose-2");

  await adapter.dispose();
  assert.deepEqual(
    await Promise.all([firstResult, secondResult]).then((results) => results.map((result) => result.status)),
    ["failed", "cancelled"]
  );
  assert.deepEqual(interrupts.sort(), [
    "dispose-thread-1:dispose-turn-1",
    "dispose-thread-2:dispose-turn-2"
  ]);
  assert.equal(notificationHub.dispatch({
    method: "error",
    params: { message: "stale after dispose" }
  }), false);
  await assert.rejects(adapter.awaitResult("run-codex-dispose-1"), /Unknown Codex run/);
  await adapter.dispose();
  assert.equal(interrupts.length, 2);
}

async function assertCodexRichAdapterInjectsBootstrapContextIntoStartTurn(): Promise<void> {
  let startedInput: Array<{ type: string; text?: string }> = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "继续收口", text_elements: [] }],
    startThread: async () => ({ threadId: "bootstrap-thread", title: "Bootstrap" }),
    resumeThread: async () => undefined,
    startTurn: async (_id, input) => {
      startedInput = input as Array<{ type: string; text?: string }>;
      return "bootstrap-turn";
    }
  });

  await adapter.run(agentRunRequest("run-codex-bootstrap-context", {
    inputText: "继续收口",
    context: compileContextBundle({
      session: {
        id: "session-bootstrap",
        title: "Bootstrap context",
        cwd: "/vault",
        contextSnapshot: {
          sessionId: "session-bootstrap",
          version: "v3",
          goal: "完成 Harness V3",
          currentState: "Native thread 需要补上下文",
          decisions: ["EchoInk 是权威真源"],
          constraints: [],
          openLoops: [],
          keyReferences: [],
          rollingSummary: "",
          sourceMessageCount: 3,
          createdAt: 1,
          updatedAt: 3
        },
        messages: [
          { id: "m1", role: "user", text: "先记住 Harness V3", createdAt: 1 },
          { id: "m2", role: "assistant", text: "Hermes assistant BETA-204", createdAt: 2 },
          { id: "m3", role: "user", text: "继续收口", createdAt: 3 }
        ],
        createdAt: 1,
        updatedAt: 3
      },
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "继续收口", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: []
    })
  }), () => undefined);

  const injectedText = joinedTextInput(startedInput);
  assert.match(injectedText, /Goal: 完成 Harness V3/);
  assert.match(injectedText, /Hermes assistant BETA-204/);
  assert.equal(countOccurrences(injectedText, "继续收口"), 1);
}

async function assertCodexRichAdapterInjectsEchoInkMemoryIntoStartTurn(): Promise<void> {
  let startedInput: Array<{ type: string; text?: string }> = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "口令是什么？", text_elements: [] }],
    startThread: async () => ({ threadId: "memory-thread", title: "Memory" }),
    resumeThread: async () => undefined,
    startTurn: async (_id, input) => {
      startedInput = input as Array<{ type: string; text?: string }>;
      return "memory-turn";
    }
  });

  await adapter.run(agentRunRequest("run-codex-memory-context", {
    inputText: "口令是什么？",
    context: compileContextBundle({
      session: {
        id: "session-memory",
        title: "Memory context",
        cwd: "/vault",
        messages: [{ id: "m1", role: "user", text: "口令是什么？", createdAt: 1 }],
        createdAt: 1,
        updatedAt: 1
      },
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "口令是什么？", attachments: [] },
      memory: {
        providerId: "file-memory",
        items: [],
        sections: [{
          id: "memory:cross-agent-passphrase",
          priority: 500,
          channel: "memory",
          content: "跨会话口令 MEMORY-713",
          source: "echoink-memory",
          required: false,
          sensitive: false
        }]
      },
      corePolicySections: []
    })
  }), () => undefined);

  const injectedText = joinedTextInput(startedInput);
  assert.match(injectedText, /\[EchoInk Long-term Memory\]/);
  assert.match(injectedText, /on-demand local search paths/);
  assert.match(injectedText, /跨会话口令 MEMORY-713/);
  assert.equal(countOccurrences(injectedText, "口令是什么？"), 1);
}

async function assertCodexRichAdapterInjectsCatchUpContextIntoStartTurn(): Promise<void> {
  let startedInput: Array<{ type: string; text?: string }> = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => "catch-up-thread",
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "继续", text_elements: [] }],
    resumeThread: async () => undefined,
    startThread: async () => ({ threadId: "catch-up-thread", title: "Catch up" }),
    startTurn: async (_id, input) => {
      startedInput = input as Array<{ type: string; text?: string }>;
      return "catch-up-turn";
    }
  });

  await adapter.run(agentRunRequest("run-codex-catch-up-context", {
    inputText: "继续",
    context: compileContextBundle({
      session: {
        id: "session-catch-up",
        title: "Catch up context",
        cwd: "/vault",
        messages: [
          { id: "m1", role: "user", text: "旧线程已经同步过的历史", createdAt: 1 },
          { id: "m2", role: "assistant", text: "Hermes assistant BETA-204", createdAt: 2 },
          { id: "m3", role: "user", text: "继续", createdAt: 3 }
        ],
        createdAt: 1,
        updatedAt: 3
      },
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "继续", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: [],
      mode: "catch-up",
      cursor: { syncedThroughMessageId: "m1", syncedSessionRevision: 1 }
    })
  }), () => undefined);

  const injectedText = joinedTextInput(startedInput);
  assert.match(injectedText, /Hermes assistant BETA-204/);
  assert.equal(countOccurrences(injectedText, "继续"), 1);
}

async function assertCodexRichAdapterRemovesCurrentUserBeforeTrailingAssistantPlaceholder(): Promise<void> {
  let startedInput: Array<{ type: string; text?: string }> = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => "catch-up-thread",
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "继续", text_elements: [] }],
    resumeThread: async () => undefined,
    startThread: async () => ({ threadId: "catch-up-thread", title: "Catch up" }),
    startTurn: async (_id, input) => {
      startedInput = input as Array<{ type: string; text?: string }>;
      return "catch-up-turn";
    }
  });

  await adapter.run(agentRunRequest("run-codex-catch-up-trailing-assistant", {
    inputText: "继续",
    context: compileContextBundle({
      session: {
        id: "session-catch-up-trailing-assistant",
        title: "Catch up trailing assistant",
        cwd: "/vault",
        messages: [
          { id: "m1", role: "user", text: "旧线程已经同步过的历史", createdAt: 1 },
          { id: "m2", role: "assistant", text: "Hermes assistant BETA-204", createdAt: 2 },
          { id: "m3", role: "user", text: "继续", createdAt: 3 },
          { id: "m4", role: "assistant", text: "正在连接 Codex...", createdAt: 4 }
        ],
        createdAt: 1,
        updatedAt: 4
      },
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "继续", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: [],
      mode: "catch-up",
      cursor: { syncedThroughMessageId: "m1", syncedSessionRevision: 1 }
    })
  }), () => undefined);

  const injectedText = joinedTextInput(startedInput);
  assert.match(injectedText, /Hermes assistant BETA-204/);
  assert.match(injectedText, /assistant: 正在连接 Codex\.\.\./);
  assert.equal(countOccurrences(injectedText, "继续"), 1);
}

async function assertCodexRichAdapterOnlyInjectsIncrementalDeltaIntoStartTurn(): Promise<void> {
  let startedInput: Array<{ type: string; text?: string }> = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => "incremental-thread",
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "继续收口", text_elements: [] }],
    resumeThread: async () => undefined,
    startThread: async () => ({ threadId: "incremental-thread", title: "Incremental" }),
    startTurn: async (_id, input) => {
      startedInput = input as Array<{ type: string; text?: string }>;
      return "incremental-turn";
    }
  });

  await adapter.run(agentRunRequest("run-codex-incremental-context", {
    inputText: "继续收口",
    context: compileContextBundle({
      session: {
        id: "session-incremental",
        title: "Incremental context",
        cwd: "/vault",
        messages: [
          { id: "m1", role: "user", text: "早期历史：不要重复发给原生线程", createdAt: 1 },
          { id: "m2", role: "assistant", text: "已同步到原生线程", createdAt: 2 },
          { id: "m3", role: "assistant", text: "新的约束：不能删除 Raw", createdAt: 3 },
          { id: "m4", role: "user", text: "继续收口", createdAt: 4 }
        ],
        createdAt: 1,
        updatedAt: 4
      },
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "继续收口", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: [],
      mode: "incremental",
      cursor: { syncedThroughMessageId: "m2", syncedSessionRevision: 2 }
    })
  }), () => undefined);

  const injectedText = joinedTextInput(startedInput);
  assert.doesNotMatch(injectedText, /早期历史：不要重复发给原生线程/);
  assert.match(injectedText, /新的约束：不能删除 Raw/);
  assert.equal(countOccurrences(injectedText, "继续收口"), 1);
}

async function assertAdapterFactoryPassesCodexToolBridgeIntoCodexRichAdapter(): Promise<void> {
  const toolBridge = createEchoInkMcpToolBridgeRuntime({
    catalog: {
      tools: [{
        name: "search.query",
        resourceId: "echoink-local:mcp-server:mcp-search",
        resourceName: "search",
        toolName: "query",
        description: "Search"
      }],
      warnings: []
    },
    scope: "chat",
    callTool: async () => ({ result: "ok" })
  });
  let capturedToolBridge: unknown = Symbol("unset");

  createHarnessAgentAdapter({
    backendId: "codex-cli",
    settings: DEFAULT_SETTINGS,
    vaultPath: "/vault",
    codexRich: {
      getNativeThreadId: () => undefined,
      setNativeThreadId: () => undefined,
      buildInput: () => [{ type: "text", text: "continue", text_elements: [] }]
    },
    task: {
      toolBridge
    },
    createCodexRichAdapter: (options: any) => {
      capturedToolBridge = options.toolBridge;
      return new CodexRichAgentAdapter({
        ...options,
        startThread: async () => ({ threadId: "factory-thread", title: "Factory" }),
        resumeThread: async () => undefined,
        startTurn: async () => "factory-turn"
      });
    }
  });

  assert.equal(capturedToolBridge, toolBridge);
}

async function assertCodexRichAdapterSignsTrustedWriteFenceBeforeStartTurn(): Promise<void> {
  const receipts: any[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    turnOptions: {
      cwd: "/shadow",
      model: "gpt-test",
      reasoning: "medium",
      serviceTier: "standard",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false,
      writableRoots: ["/shadow/wiki", "/shadow/outputs"]
    },
    requireExactWriteFence: true,
    exactWriteFence: {
      attemptToken: "attempt-codex-receipt",
      leaseToken: "lease-codex-receipt",
      deniedLivePaths: ["/live-vault"],
      deniedControlPaths: ["/shadow-control"]
    },
    onExactWriteFenceConfigured: (receipt) => {
      assert.equal(isTrustedExactWriteFenceReceipt(receipt), true);
      receipts.push(receipt);
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "maintain", text_elements: [] }],
    startThread: async () => ({ threadId: "codex-fence-thread", title: "Fence" }),
    resumeThread: async () => undefined,
    startTurn: async () => {
      assert.equal(receipts.length, 1, "trusted receipt must be delivered before prompt submission");
      throw new Error("stop after pre-submit receipt");
    }
  });

  await assert.rejects(
    adapter.run(agentRunRequest("run-codex-fence-receipt", {
      workflow: "knowledge.maintain",
      permissions: {
        mode: "workspace-write",
        writableRoots: ["/shadow/wiki", "/shadow/outputs"],
        requireApproval: true
      }
    }), () => undefined),
    /stop after pre-submit receipt/
  );
  assert.equal(receipts[0]?.backend, "codex-cli");
  assert.match(receipts[0]?.configAckDigest ?? "", /^[a-f0-9]{64}$/);
}

async function assertCodexRichAdapterUsesHarnessWorkspaceForExactWriteFence(): Promise<void> {
  const shadowVault = "/shadow/maintenance-attempt/vault";
  const writableRoots = [
    `${shadowVault}/wiki`,
    `${shadowVault}/outputs/maintenance`
  ];
  const seenThreadOptions: Array<{ cwd?: string; writableRoots?: string[] }> = [];
  const receipts: any[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    turnOptions: {
      model: "gpt-test",
      reasoning: "medium",
      serviceTier: "standard",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false,
      writableRoots
    },
    requireExactWriteFence: true,
    exactWriteFence: {
      attemptToken: "attempt-codex-workspace-fallback",
      leaseToken: "lease-codex-workspace-fallback",
      deniedLivePaths: ["/live-vault"],
      deniedControlPaths: ["/shadow/maintenance-attempt"]
    },
    onExactWriteFenceConfigured: (receipt) => receipts.push(receipt),
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "maintain", text_elements: [] }],
    startThread: async (options) => {
      seenThreadOptions.push(options ?? {});
      return { threadId: "codex-workspace-thread", title: "Workspace fallback" };
    },
    resumeThread: async () => undefined,
    startTurn: async (_threadId, _input, options) => {
      seenThreadOptions.push(options ?? {});
      throw new Error("stop after workspace-scoped pre-submit receipt");
    }
  });

  await assert.rejects(
    adapter.run({
      ...agentRunRequest("run-codex-workspace-fallback"),
      workflow: "knowledge.maintain",
      workspace: { vaultPath: shadowVault, cwd: shadowVault },
      permissions: {
        mode: "workspace-write",
        writableRoots,
        requireApproval: true
      }
    }, () => undefined),
    /stop after workspace-scoped pre-submit receipt/
  );

  assert.equal(seenThreadOptions.length, 2);
  assert.equal(seenThreadOptions[0]?.cwd, shadowVault);
  assert.equal(seenThreadOptions[1]?.cwd, shadowVault);
  assert.deepEqual(seenThreadOptions[0]?.writableRoots, writableRoots);
  assert.deepEqual(
    [...(receipts[0]?.enforcedWritableRoots ?? [])].sort(),
    [...writableRoots].sort()
  );
}

async function assertCodexRichAdapterRunsEchoInkBrokerLoopAcrossTurns(): Promise<void> {
  const notificationHub = new TrackingCodexRichNotificationHub();
  const brokerCalls: Array<Record<string, unknown>> = [];
  const startTurns: Array<{ threadId: string; input: Array<{ type: string; text?: string }> }> = [];
  const toolBridge = createEchoInkMcpToolBridgeRuntime({
    catalog: {
      tools: [{
        name: "search.query",
        resourceId: "echoink-local:mcp-server:mcp-search",
        resourceName: "search",
        toolName: "query",
        description: "Search"
      }],
      warnings: []
    },
    scope: "chat",
    maxToolCalls: 2,
    callTool: async (request) => {
      brokerCalls.push({
        resourceId: request.resourceId,
        scope: request.scope,
        backend: request.backend,
        toolName: request.toolName,
        arguments: request.arguments
      });
      return { result: "found Harness docs" };
    }
  });
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    toolBridge,
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "search Harness", text_elements: [] }],
    startThread: async () => ({ threadId: "broker-thread", title: "Broker" }),
    resumeThread: async () => undefined,
    startTurn: async (threadId, input) => {
      const turnIndex = startTurns.length + 1;
      const turnId = `broker-turn-${turnIndex}`;
      startTurns.push({ threadId, input: input as Array<{ type: string; text?: string }> });
      setTimeout(() => {
        if (turnIndex === 1) {
          notificationHub.dispatch({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId,
              itemId: "broker-assistant-1",
              delta: "```echoink-tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```"
            }
          });
        } else {
          notificationHub.dispatch({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId,
              itemId: "broker-assistant-2",
              delta: "Harness broker final answer"
            }
          });
        }
        notificationHub.dispatch({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed" }
          }
        });
      }, 0);
      return turnId;
    }
  });
  const events: HarnessEvent[] = [];

  const runResult = await adapter.run(agentRunRequest("run-codex-broker-loop"), (event) => events.push(event));
  const awaited = await adapter.awaitResult("run-codex-broker-loop");

  assert.equal(runResult.status, "running");
  assert.equal(awaited.status, "completed");
  assert.equal(awaited.outputText, "Harness broker final answer");
  assert.equal(startTurns.length, 2);
  assert.deepEqual(startTurns.map((turn) => turn.threadId), ["broker-thread", "broker-thread"]);
  assert.match(joinedTextInput(startTurns[0]?.input ?? []), /EchoInk broker tools are available for this turn\./);
  assert.match(joinedTextInput(startTurns[1]?.input ?? []), /TOOL RESULT search\.query:/);
  assert.match(joinedTextInput(startTurns[1]?.input ?? []), /found Harness docs/);
  assert.deepEqual(brokerCalls, [{
    resourceId: "echoink-local:mcp-server:mcp-search",
    scope: "chat",
    backend: "codex-cli",
    toolName: "query",
    arguments: { q: "Harness" }
  }]);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("tool."))
      .map((event) => [event.type, event.toolName, event.resourceId]),
    [
      ["tool.requested", "search.query", "echoink-local:mcp-server:mcp-search"],
      ["tool.approval.requested", "search.query", "echoink-local:mcp-server:mcp-search"],
      ["tool.completed", "search.query", "echoink-local:mcp-server:mcp-search"]
    ]
  );
  assert.equal(notificationHub.registerCalls, 2);
  assert.equal(notificationHub.unregisterCalls, 2);
}

async function assertCodexRichAdapterDisposeCancelsHangingBrokerCall(): Promise<void> {
  const harness = createCodexHangingBrokerHarness("dispose-hanging-broker");
  const runId = "run-codex-dispose-hanging-broker";

  await harness.adapter.run(agentRunRequest(runId), (event) => harness.events.push(event));
  const resultPromise = harness.adapter.awaitResult(runId);
  await harness.bridgeStarted;
  await harness.adapter.dispose();

  const result = await settleWithin(resultPromise);
  assert.equal(result.status, "cancelled");
  assert.equal(harness.bridgeAborted(), true);
  harness.resolveBridge({ result: "late broker result" });
  await delay(0);
  assert.equal(harness.startTurnCalls(), 1);
  assert.deepEqual(
    harness.events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.requested", "tool.approval.requested"]
  );
  assert.equal(harness.notificationHub.dispatch({
    method: "error",
    params: { message: "stale after hanging broker dispose" }
  }), false);
  await assert.rejects(harness.adapter.awaitResult(runId), /Unknown Codex run/);
}

async function assertCodexRichAdapterCancelCancelsHangingBrokerCall(): Promise<void> {
  const harness = createCodexHangingBrokerHarness("cancel-hanging-broker");
  const runId = "run-codex-cancel-hanging-broker";

  await harness.adapter.run(agentRunRequest(runId), (event) => harness.events.push(event));
  const resultPromise = harness.adapter.awaitResult(runId);
  await harness.bridgeStarted;
  await harness.adapter.cancel(runId);

  const result = await settleWithin(resultPromise);
  assert.equal(result.status, "cancelled");
  assert.equal(harness.bridgeAborted(), true);
  assert.equal(harness.startTurnCalls(), 1);
  assert.deepEqual(
    harness.events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.requested", "tool.approval.requested"]
  );
  await assert.rejects(harness.adapter.awaitResult(runId), /Unknown Codex run/);
}

async function assertCodexRichAdapterFailsUnknownBrokerToolWithoutHanging(): Promise<void> {
  const notificationHub = new TrackingCodexRichNotificationHub();
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    toolBridge: createEchoInkMcpToolBridgeRuntime({
      catalog: {
        tools: [{
          name: "search.query",
          resourceId: "echoink-local:mcp-server:mcp-search",
          resourceName: "search",
          toolName: "query",
          description: "Search"
        }],
        warnings: []
      },
      scope: "chat",
      callTool: async () => ({ result: "ok" })
    }),
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "unknown tool", text_elements: [] }],
    startThread: async () => ({ threadId: "unknown-tool-thread", title: "Unknown tool" }),
    resumeThread: async () => undefined,
    startTurn: async (threadId) => {
      const turnId = "unknown-tool-turn";
      setTimeout(() => {
        notificationHub.dispatch({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId: "unknown-tool-assistant",
            delta: "```echoink-tool-call\n{\"tool\":\"missing.query\",\"arguments\":{}}\n```"
          }
        });
        notificationHub.dispatch({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed" }
          }
        });
      }, 0);
      return turnId;
    }
  });
  const events: HarnessEvent[] = [];

  await adapter.run(agentRunRequest("run-codex-broker-unknown-tool"), (event) => events.push(event));
  const awaited = await adapter.awaitResult("run-codex-broker-unknown-tool");

  assert.equal(awaited.status, "failed");
  assert.match(awaited.error ?? "", /missing\.query/);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("tool."))
      .map((event) => event.type),
    ["tool.requested", "tool.failed"]
  );
}

async function assertCodexRichAdapterFailsBrokerErrorWithoutHanging(): Promise<void> {
  const notificationHub = new TrackingCodexRichNotificationHub();
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    toolBridge: createEchoInkMcpToolBridgeRuntime({
      catalog: {
        tools: [{
          name: "search.query",
          resourceId: "echoink-local:mcp-server:mcp-search",
          resourceName: "search",
          toolName: "query",
          description: "Search"
        }],
        warnings: []
      },
      scope: "chat",
      callTool: async () => {
        throw new Error("broker offline");
      }
    }),
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "broker fail", text_elements: [] }],
    startThread: async () => ({ threadId: "broker-fail-thread", title: "Broker fail" }),
    resumeThread: async () => undefined,
    startTurn: async (threadId) => {
      const turnId = "broker-fail-turn";
      setTimeout(() => {
        notificationHub.dispatch({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId: "broker-fail-assistant",
            delta: "```echoink-tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```"
          }
        });
        notificationHub.dispatch({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed" }
          }
        });
      }, 0);
      return turnId;
    }
  });
  const events: HarnessEvent[] = [];

  await adapter.run(agentRunRequest("run-codex-broker-failure"), (event) => events.push(event));
  const awaited = await adapter.awaitResult("run-codex-broker-failure");

  assert.equal(awaited.status, "failed");
  assert.match(awaited.error ?? "", /broker offline/);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("tool."))
      .map((event) => event.type),
    ["tool.requested", "tool.approval.requested", "tool.failed"]
  );
}

async function assertCodexRichAdapterFailsWhenBrokerLoopExceedsMaxToolCalls(): Promise<void> {
  const notificationHub = new TrackingCodexRichNotificationHub();
  let turnCount = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    toolBridge: createEchoInkMcpToolBridgeRuntime({
      catalog: {
        tools: [{
          name: "search.query",
          resourceId: "echoink-local:mcp-server:mcp-search",
          resourceName: "search",
          toolName: "query",
          description: "Search"
        }],
        warnings: []
      },
      scope: "chat",
      maxToolCalls: 1,
      callTool: async () => ({ result: "first result" })
    }),
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "too many tools", text_elements: [] }],
    startThread: async () => ({ threadId: "max-tool-thread", title: "Max tool" }),
    resumeThread: async () => undefined,
    startTurn: async (threadId) => {
      turnCount += 1;
      const turnId = `max-tool-turn-${turnCount}`;
      setTimeout(() => {
        notificationHub.dispatch({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId: `max-tool-assistant-${turnCount}`,
            delta: "```echoink-tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```"
          }
        });
        notificationHub.dispatch({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed" }
          }
        });
      }, 0);
      return turnId;
    }
  });
  const events: HarnessEvent[] = [];

  await adapter.run(agentRunRequest("run-codex-broker-max-tool-calls"), (event) => events.push(event));
  const awaited = await adapter.awaitResult("run-codex-broker-max-tool-calls");

  assert.equal(awaited.status, "failed");
  assert.match(awaited.error ?? "", /maxToolCalls=1/);
  assert.equal(turnCount, 2);
  assert.equal(events.some((event) => event.type === "tool.failed"), true);
}

async function assertCodexRichAdapterPreservesBlankAndSubstringHistory(): Promise<void> {
  let startedInput: Array<{ type: string; text?: string }> = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => "exact-match-thread",
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "继续收口", text_elements: [] }],
    resumeThread: async () => undefined,
    startThread: async () => ({ threadId: "exact-match-thread", title: "Exact match" }),
    startTurn: async (_id, input) => {
      startedInput = input as Array<{ type: string; text?: string }>;
      return "exact-match-turn";
    }
  });

  await adapter.run(agentRunRequest("run-codex-exact-context", {
    inputText: "继续收口",
    context: compileContextBundle({
      session: {
        id: "session-exact-context",
        title: "Exact context",
        cwd: "/vault",
        messages: [
          { id: "m1", role: "assistant", text: "已同步到原生线程", createdAt: 1 },
          { id: "m2", role: "user", text: "继续", createdAt: 2 },
          { id: "m3", role: "user", text: "   ", createdAt: 3 },
          { id: "m4", role: "user", text: "继续收口", createdAt: 4 }
        ],
        createdAt: 1,
        updatedAt: 4
      },
      backendId: "codex-cli",
      workflow: "chat.generic",
      userInput: { text: "继续收口", attachments: [] },
      memory: { providerId: "noop", items: [], sections: [] },
      corePolicySections: [],
      mode: "incremental",
      cursor: { syncedThroughMessageId: "m1", syncedSessionRevision: 1 }
    })
  }), () => undefined);

  const injectedText = joinedTextInput(startedInput);
  assert.match(injectedText, /user: 继续\n/);
  assert.match(injectedText, /user:\s*\n/);
  assert.equal(countOccurrences(injectedText, "继续收口"), 1);
}

async function assertOrchestratorRebuildsContextWhenNativeSessionResumeFails(): Promise<void> {
  const events: HarnessEvent[] = [];
  let threadId = "missing-thread";
  let contextMode = "";
  let compiledContext = "";
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => threadId,
    setNativeThreadId: (next) => { threadId = next; },
    buildInput: (_threadId, request) => {
      contextMode = request.context.manifest?.mode ?? "";
      compiledContext = request.context.sessionContext.map((section) => section.content).join("\n");
      return [{ type: "text", text: "continue", text_elements: [] }];
    },
    resumeThread: async () => { throw new Error("thread not found"); },
    startThread: async () => ({ threadId: "replacement-thread", title: "Replacement" }),
    startTurn: async () => "replacement-turn"
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: () => 100,
    sessionProvider: () => ({
      id: "session-resume-recovery",
      title: "Resume recovery",
      cwd: "/vault",
      ...testConversationIdentity("context-session-resume-recovery", 2),
      backendBindings: {
        "codex-cli": {
          backendId: "codex-cli",
          nativeThreadId: "missing-thread",
          leaseId: "lease-missing-thread",
          leaseStatus: "active",
          leaseCreatedAt: 1,
          leaseLastUsedAt: 90,
          leaseExpiresAt: 10_000,
          leaseTurnCount: 1,
          leaseMaxTurns: 20,
          syncedThroughMessageId: "m2",
          syncedSessionRevision: 2,
          workspaceFingerprint: testWorkspaceFingerprint(),
          contextCursor: {
            syncedThroughMessageId: "m2",
            syncedSessionRevision: 2,
            sessionGeneration: 2,
            contextId: "context-session-resume-recovery",
            workspaceFingerprint: testWorkspaceFingerprint()
          },
          lastUsedAt: 90
        }
      },
      messages: [
        { id: "m1", role: "user", text: "关键目标：完成 Harness V3", createdAt: 1 },
        { id: "m2", role: "assistant", text: "当前决定：EchoInk 是权威真源", createdAt: 2 }
      ],
      createdAt: 1,
      updatedAt: 2
    })
  });

  const result = await orchestrator.run({
    runId: "run-native-resume-recovery",
    sessionId: "session-resume-recovery",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "codex-cli",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "继续", attachments: [] },
    permissions: { mode: "workspace-write", writableRoots: ["/vault"], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  }, (event) => events.push(event), {
    beforeBindingReplacement: retireTestBinding
  });

  assert.equal(result.status, "running");
  assert.equal(result.contextManifest?.mode, "bootstrap");
  assert.equal(contextMode, "bootstrap");
  assert.match(compiledContext, /完成 Harness V3/);
  assert.match(compiledContext, /EchoInk 是权威真源/);
  assert.equal(result.backendBinding?.nativeThreadId, "replacement-thread");
  assert.notEqual(result.backendBinding?.leaseId, "lease-missing-thread");
  assert.equal(events.some((event) => event.type === "agent.native_lease.recovery_failed"), true);
  assert.equal(events.some((event) => event.type === "agent.native_lease.reused"), false);
  assert.equal(events.some((event) => event.type === "agent.native_lease.created"), true);
}

async function assertEmulatedResumeBackendRebuildsContextForEachRun(): Promise<void> {
  const prompts: string[] = [];
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "hermes",
    displayName: "Hermes",
    version: "test",
    runtime: fakeRuntime({
      kind: "hermes",
      result: { text: "继续完成", runId: "hermes-run-new" },
      onRunTask: (input) => { prompts.push(input.prompt); }
    }),
    capabilities: "legacy"
  });
  assert.equal(adapter.manifest.capabilities.output.streaming, "native");
  assert.equal(adapter.manifest.capabilities.output.reasoningSummary, "none");
  assert.equal(adapter.manifest.capabilities.output.thinkingTrace, "native");
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: () => 200,
    sessionProvider: () => ({
      id: "session-hermes-emulated",
      title: "Hermes emulated resume",
      cwd: "/vault",
      ...testConversationIdentity("context-session-hermes-emulated", 1),
      backendBindings: {
        hermes: {
          backendId: "hermes",
          nativeSessionId: "hermes-run-old",
          nativeExecutionKind: "run",
          leaseId: "lease-hermes-old",
          leaseStatus: "active",
          leaseCreatedAt: 1,
          leaseLastUsedAt: 190,
          leaseExpiresAt: 10_000,
          leaseTurnCount: 1,
          leaseMaxTurns: 20,
          syncedThroughMessageId: "m2",
          syncedSessionRevision: 1,
          workspaceFingerprint: testWorkspaceFingerprint(),
          contextCursor: {
            syncedThroughMessageId: "m2",
            syncedSessionRevision: 1,
            sessionGeneration: 1,
            contextId: "context-session-hermes-emulated",
            workspaceFingerprint: testWorkspaceFingerprint()
          },
          lastUsedAt: 190
        }
      },
      messages: [
        { id: "m1", role: "user", text: "关键约束：不能删除 Raw", createdAt: 1 },
        { id: "m2", role: "assistant", text: "已记录约束", createdAt: 2 }
      ],
      createdAt: 1,
      updatedAt: 2
    })
  });

  const result = await orchestrator.run({
    runId: "run-hermes-emulated-resume",
    sessionId: "session-hermes-emulated",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "hermes",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "继续", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  }, undefined, {
    beforeBindingReplacement: retireTestBinding
  });

  assert.equal(result.contextManifest?.mode, "bootstrap");
  assert.match(prompts[0] ?? "", /不能删除 Raw/);
  assert.notEqual(result.backendBinding?.leaseId, "lease-hermes-old");
}

async function assertOpenCodeNativeSessionIsReusedAcrossHarnessTurns(): Promise<void> {
  let taskNativeSessionId = "";
  const runtime = fakeRuntime({
    kind: "opencode",
    result: {
      text: "继续完成",
      runId: "opencode-session-old",
      effectiveModel: { providerId: "opencode", modelId: "opencode/big-pickle" }
    } as AgentTaskResult,
    onRunTask: (input) => { taskNativeSessionId = (input as AgentTaskInput & { nativeSessionId?: string }).nativeSessionId ?? ""; }
  }) as AgentTaskRuntime & { hasNativeSession(sessionId: string): Promise<boolean> };
  runtime.hasNativeSession = async (sessionId) => sessionId === "opencode-session-old";
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime,
    capabilities: "legacy"
  });
  assert.equal(adapter.manifest.capabilities.sessions.resume, "native");
  assert.equal(adapter.manifest.capabilities.output.streaming, "native");
  assert.equal(adapter.manifest.capabilities.output.reasoningSummary, "native");
  assert.equal(adapter.manifest.capabilities.tools.structuredCalls, "native");
  assert.equal(adapter.manifest.capabilities.files.diffEvents, "native");
  const events: HarnessEvent[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: () => 300,
    sessionProvider: () => ({
      id: "session-opencode-native",
      title: "OpenCode native resume",
      cwd: "/vault",
      ...testConversationIdentity("context-session-opencode-native", 1),
      backendBindings: {
        opencode: {
          backendId: "opencode",
          nativeSessionId: "opencode-session-old",
          nativeExecutionKind: "session",
          leaseId: "lease-opencode-old",
          leaseStatus: "active",
          leaseCreatedAt: 1,
          leaseLastUsedAt: 290,
          leaseExpiresAt: 10_000,
          leaseTurnCount: 1,
          leaseMaxTurns: 20,
          syncedThroughMessageId: "m2",
          syncedSessionRevision: 1,
          workspaceFingerprint: testWorkspaceFingerprint(),
          contextCursor: {
            syncedThroughMessageId: "m2",
            syncedSessionRevision: 1,
            sessionGeneration: 1,
            contextId: "context-session-opencode-native",
            workspaceFingerprint: testWorkspaceFingerprint()
          },
          lastUsedAt: 290
        }
      },
      messages: [
        { id: "m1", role: "user", text: "记住 O5-842", backendId: "opencode", createdAt: 1 },
        { id: "m2", role: "assistant", text: "已记住", backendId: "opencode", createdAt: 2 }
      ],
      createdAt: 1,
      updatedAt: 2
    })
  });

  const result = await orchestrator.run({
    runId: "run-opencode-native-resume",
    sessionId: "session-opencode-native",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "opencode",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "继续", attachments: [] },
    permissions: { mode: "workspace-write", writableRoots: ["/vault"], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  }, (event) => events.push(event));

  assert.equal(result.contextManifest?.mode, "incremental");
  assert.equal(taskNativeSessionId, "opencode-session-old");
  assert.equal(result.backendBinding?.nativeSessionId, "opencode-session-old");
  assert.equal(result.backendBinding?.leaseId, "lease-opencode-old");
  assert.equal(result.backendBinding?.leaseTurnCount, 2);
  assert.deepEqual((result as AgentRunResult & { effectiveModel?: { providerId: string; modelId: string } }).effectiveModel, {
    providerId: "opencode",
    modelId: "opencode/big-pickle"
  });
  assert.equal(events.some((event) => event.type === "agent.native_lease.reused"), true);
  assert.equal(harnessMessageModelId({
    ...DEFAULT_SETTINGS,
    opencode: { ...DEFAULT_SETTINGS.opencode, providerId: "opencode", modelId: "opencode/big-pickle" }
  }, "opencode"), "opencode/big-pickle");
  assert.equal(harnessInitialMessageModelId({
    ...DEFAULT_SETTINGS,
    opencode: { ...DEFAULT_SETTINGS.opencode, providerId: "invalid", modelId: "missing" }
  }, "opencode"), "");
}

async function assertOpenCodeMissingNativeSessionRebuildsFromEchoInkContext(): Promise<void> {
  let taskNativeSessionId = "unexpected";
  let taskPrompt = "";
  const runtime = fakeRuntime({
    kind: "opencode",
    result: { text: "重建完成", runId: "opencode-session-new" },
    onRunTask: (input) => {
      taskNativeSessionId = (input as AgentTaskInput & { nativeSessionId?: string }).nativeSessionId ?? "";
      taskPrompt = input.prompt;
    }
  }) as AgentTaskRuntime & { hasNativeSession(sessionId: string): Promise<boolean> };
  runtime.hasNativeSession = async () => false;
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    runtime,
    capabilities: "legacy"
  });
  const events: HarnessEvent[] = [];
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: () => 400,
    sessionProvider: () => ({
      id: "session-opencode-missing",
      title: "OpenCode missing session",
      cwd: "/vault",
      ...testConversationIdentity("context-session-opencode-missing", 1),
      backendBindings: {
        opencode: {
          backendId: "opencode",
          nativeSessionId: "opencode-session-missing",
          nativeExecutionKind: "session",
          leaseId: "lease-opencode-missing",
          leaseStatus: "active",
          leaseCreatedAt: 1,
          leaseLastUsedAt: 390,
          leaseExpiresAt: 10_000,
          leaseTurnCount: 1,
          leaseMaxTurns: 20,
          syncedThroughMessageId: "m2",
          syncedSessionRevision: 1,
          workspaceFingerprint: testWorkspaceFingerprint(),
          contextCursor: {
            syncedThroughMessageId: "m2",
            syncedSessionRevision: 1,
            sessionGeneration: 1,
            contextId: "context-session-opencode-missing",
            workspaceFingerprint: testWorkspaceFingerprint()
          },
          lastUsedAt: 390
        }
      },
      messages: [
        { id: "m1", role: "user", text: "关键目标：保留 EchoInk 上下文", backendId: "opencode", createdAt: 1 },
        { id: "m2", role: "assistant", text: "当前状态：继续修复", backendId: "opencode", createdAt: 2 }
      ],
      createdAt: 1,
      updatedAt: 2
    })
  });

  const result = await orchestrator.run({
    runId: "run-opencode-missing-rebuild",
    sessionId: "session-opencode-missing",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "opencode",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "继续", attachments: [] },
    permissions: { mode: "workspace-write", writableRoots: ["/vault"], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  }, (event) => events.push(event), {
    beforeBindingReplacement: retireTestBinding
  });

  assert.equal(result.contextManifest?.mode, "bootstrap");
  assert.equal(taskNativeSessionId, "");
  assert.match(taskPrompt, /保留 EchoInk 上下文/);
  assert.match(taskPrompt, /继续修复/);
  assert.equal(result.backendBinding?.nativeSessionId, "opencode-session-new");
  assert.notEqual(result.backendBinding?.leaseId, "lease-opencode-missing");
  assert.equal(events.some((event) => event.type === "agent.native_lease.recovery_failed"), true);
  assert.equal(events.some((event) => event.type === "agent.native_lease.created"), true);
}

async function assertFakeFourthAgentOnlyNeedsAdapterAndManifest(): Promise<void> {
  const adapter = new FakeFourthAgentAdapter();
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: () => ({
      id: "session-fourth",
      title: "Fourth adapter",
      cwd: "/vault",
      ...testConversationIdentity("context-session-fourth", 1),
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
  });
  const result = await orchestrator.run({
    runId: "run-fourth",
    sessionId: "session-fourth",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "fake-fourth",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "ping", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "fake-fourth:pong");
  for (const file of [
    "src/ui/codex-view/turn-runner.ts",
    "src/ui/codex-view/editor-action-runner.ts",
    "src/knowledge-base/manager.ts"
  ]) {
    const source = await readFile(path.join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /fake-fourth/);
  }
}

async function assertAdapterFactoryUsesRegisteredBuilders(): Promise<void> {
  const adapter = (createHarnessAgentAdapter as any)({
    backendId: "fake-fourth",
    settings: DEFAULT_SETTINGS,
    vaultPath: "/vault",
    adapterFactories: {
      "fake-fourth": () => new FakeFourthAgentAdapter()
    }
  });
  assert.equal(adapter instanceof FakeFourthAgentAdapter, true);

  const source = await readFile(path.join(process.cwd(), "src/harness/agents/adapter-factory.ts"), "utf8");
  assert.doesNotMatch(source, /backendId\s*===\s*"codex-cli"/);
}

function fakeRuntime(input: {
  kind: AgentTaskRuntime["kind"];
  result: AgentTaskResult;
  onRunTask?: (input: AgentTaskInput) => AgentTaskResult | void;
}): AgentTaskRuntime {
  return {
    kind: input.kind,
    async connect(): Promise<AgentConnectionStatus> {
      return { connected: true, label: input.kind, errors: [] };
    },
    async listModels() {
      return [];
    },
    async runTask(task: AgentTaskInput): Promise<AgentTaskResult> {
      const override = input.onRunTask?.(task);
      const result = isAgentTaskResult(override) ? override : input.result;
      await task.onRunId?.(result.runId ?? "runtime-run");
      return result;
    },
    async abort(): Promise<void> {
      return undefined;
    }
  };
}

function agentRunRequest(
  runId: string,
  options?: {
    inputText?: string;
    context?: ReturnType<typeof compileContextBundle>;
    workflow?: "chat.generic" | "knowledge.maintain";
    workspace?: { vaultPath: string; cwd: string };
    permissions?: {
      mode: "read-only" | "workspace-write" | "danger-full-access";
      writableRoots: string[];
      requireApproval: boolean;
    };
  }
) {
  const inputText = options?.inputText ?? "continue";
  const context = options?.context ?? compileContextBundle({
    session: { id: "session-1", title: "Test", cwd: "/vault", messages: [], createdAt: 1, updatedAt: 1 },
    backendId: "codex-cli",
    workflow: "chat.generic",
    userInput: { text: inputText, attachments: [] },
    memory: { providerId: "noop", items: [], sections: [] },
    corePolicySections: []
  });
  return {
    runId,
    sessionId: "session-1",
    ...(options?.workflow ? { workflow: options.workflow } : {}),
    ...(options?.workspace ? { workspace: options.workspace } : {}),
    input: { text: inputText, attachments: [] },
    permissions: options?.permissions
      ?? { mode: "workspace-write" as const, writableRoots: ["/vault"], requireApproval: true },
    resources: { selected: [], resolvedAt: 0, warnings: [] },
    context,
    outputContract: { kind: "plain-text" as const }
  };
}

function isAgentTaskResult(value: unknown): value is AgentTaskResult {
  return Boolean(value && typeof value === "object" && typeof (value as AgentTaskResult).text === "string");
}

function joinedTextInput(input: Array<{ type: string; text?: string }>): string {
  return input
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text ?? "")
    .join("\n\n");
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function createDriverHarness(
  runId: string,
  options: { threadId?: string; turnId?: string; finalAnswerGraceMs?: number } = {}
): { driver: CodexRichRunDriver; events: HarnessEvent[] } {
  const events: HarnessEvent[] = [];
  const driver = new CodexRichRunDriver({
    runId,
    backendId: "codex-cli",
    threadId: options.threadId,
    turnId: options.turnId,
    finalAnswerGraceMs: options.finalAnswerGraceMs,
    emit: async (event) => {
      events.push(event);
    }
  });
  return { driver, events };
}

class TrackingCodexRichNotificationHub extends CodexRichNotificationHub {
  registerCalls = 0;
  unregisterCalls = 0;

  register(driver: CodexRichRunDriver): void {
    this.registerCalls += 1;
    super.register(driver);
  }

  unregister(runId: string): void {
    this.unregisterCalls += 1;
    super.unregister(runId);
  }
}

function createCodexHangingBrokerHarness(prefix: string): {
  adapter: CodexRichAgentAdapter;
  bridgeStarted: Promise<void>;
  events: HarnessEvent[];
  notificationHub: TrackingCodexRichNotificationHub;
  resolveBridge(value: unknown): void;
  bridgeAborted(): boolean;
  startTurnCalls(): number;
} {
  const notificationHub = new TrackingCodexRichNotificationHub();
  const events: HarnessEvent[] = [];
  let signalBridgeStarted!: () => void;
  const bridgeStarted = new Promise<void>((resolve) => {
    signalBridgeStarted = resolve;
  });
  let resolveBridge!: (value: unknown) => void;
  let rejectBridge!: (error: Error) => void;
  let bridgeAborted = false;
  const bridgeResult = new Promise<unknown>((resolve, reject) => {
    resolveBridge = resolve;
    rejectBridge = reject;
  });
  let turnCount = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    notificationHub,
    toolBridge: createEchoInkMcpToolBridgeRuntime({
      catalog: {
        tools: [{
          name: "search.query",
          resourceId: "echoink-local:mcp-server:mcp-search",
          resourceName: "search",
          toolName: "query",
          description: "Search"
        }],
        warnings: []
      },
      scope: "chat",
      callTool: async (request) => {
        signalBridgeStarted();
        request.signal?.addEventListener("abort", () => {
          bridgeAborted = true;
          rejectBridge(new Error("bridge aborted"));
        }, { once: true });
        return await bridgeResult;
      }
    }),
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "hang in broker", text_elements: [] }],
    startThread: async () => ({ threadId: `${prefix}-thread`, title: "Hanging broker" }),
    resumeThread: async () => undefined,
    startTurn: async (threadId) => {
      turnCount += 1;
      const turnId = `${prefix}-turn-${turnCount}`;
      setTimeout(() => {
        notificationHub.dispatch({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId: `${prefix}-assistant-${turnCount}`,
            delta: "```echoink-tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```"
          }
        });
        notificationHub.dispatch({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed" }
          }
        });
      }, 0);
      return turnId;
    }
  });
  return {
    adapter,
    bridgeStarted,
    events,
    notificationHub,
    resolveBridge,
    bridgeAborted: () => bridgeAborted,
    startTurnCalls: () => turnCount
  };
}

function createAcpCancellationHarness(
  initializeResult: Record<string, unknown> = {
    protocolVersion: 1,
    agentCapabilities: {}
  }
): {
  process: AcpSubprocessLike;
  next(method: string): Promise<Record<string, unknown>>;
  respond(request: Record<string, unknown>, result: unknown): void;
  notify(method: string, params: unknown): void;
  count(method: string): number;
  killed(): boolean;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  const queued = new Map<string, Record<string, unknown>[]>();
  const waiters = new Map<string, Array<(message: Record<string, unknown>) => void>>();
  let inputBuffer = "";
  let processKilled = false;
  const respond = (request: Record<string, unknown>, result: unknown): void => {
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  };
  const record = (message: Record<string, unknown>): void => {
    messages.push(message);
    if (message.method === "initialize") {
      respond(message, initializeResult);
    }
    const method = typeof message.method === "string" ? message.method : "";
    const waiter = waiters.get(method)?.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    const current = queued.get(method) ?? [];
    current.push(message);
    queued.set(method, current);
  };
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    inputBuffer += String(chunk);
    for (;;) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      record(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const process: AcpSubprocessLike = {
    stdin,
    stdout,
    stderr,
    get killed() { return processKilled; },
    kill() {
      processKilled = true;
      return true;
    }
  };
  return {
    process,
    next(method) {
      const current = queued.get(method);
      const message = current?.shift();
      if (message) return Promise.resolve(message);
      return new Promise<Record<string, unknown>>((resolve) => {
        const currentWaiters = waiters.get(method) ?? [];
        currentWaiters.push(resolve);
        waiters.set(method, currentWaiters);
      });
    },
    respond,
    notify(method, params) {
      stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method,
        params
      })}\n`);
    },
    count: (method) => messages.filter((message) => message.method === method).length,
    killed: () => processKilled
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testWorkspaceFingerprint(): string {
  return workspaceFingerprint({ vaultPath: "/vault", cwd: "/vault" });
}

function testConversationIdentity(contextId: string, generation: number) {
  return {
    revision: generation,
    generation,
    contextId,
    workspaceFingerprint: testWorkspaceFingerprint()
  };
}

async function retireTestBinding(
  input: BeforeBindingReplacementInput
): Promise<void> {
  if (input.session.backendBindings) {
    delete input.session.backendBindings[input.binding.backendId];
  }
  if (input.binding.backendId === "codex-cli") {
    delete input.session.threadId;
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 50): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function promiseStillPending<T>(promise: Promise<T>): Promise<boolean> {
  const sentinel = Symbol("pending");
  return await Promise.race([
    promise.then(() => false, () => false),
    delay(5).then(() => sentinel)
  ]) === sentinel;
}
