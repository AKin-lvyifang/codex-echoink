import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../../harness/agents/adapters/codex-rich-notification-hub";
import type { AgentTaskRuntime } from "../../agent/runtime";
import { NATIVE_RUN_REGISTRATION_ERROR_CODE } from "../../agent/types";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { HarnessRunResult } from "../../harness/contracts/run";
import { RunOrchestrator } from "../../harness/kernel/run-orchestrator";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { workspaceFingerprint } from "../../harness/kernel/session-service";
import { runKnowledgeAgentTask } from "../../knowledge-base/agent-runner";
import { KnowledgeBaseAgentTaskService } from "../../knowledge-base/agent-task-service";
import { KnowledgeBaseManager } from "../../knowledge-base/manager";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../../knowledge-base/constants";
import { EchoInkConnectionService } from "../../plugin/connection-service";
import { KNOWLEDGE_BASE_SESSION_TITLE, normalizeSettingsData, type CodexForObsidianSettings } from "../../settings/settings";

export async function runHarnessV2KnowledgeAskLeaseTests(): Promise<void> {
  await assertKnowledgeAskFollowUpPersistsAndReusesCodexLease();
  await assertKnowledgeRulesChangeStartsFreshCodexThread();
  await assertKnowledgeAgentSwitchBootstrapsFromStoredSession();
  await runHarnessV2KnowledgeAskNativeSettlementTests();
}

export async function runHarnessV2KnowledgeAskNativeSettlementTests(): Promise<void> {
  await assertStructuredTaskRuntimesWaitForDurableNativeRegistration();
  await assertStructuredCodexWaitsForDurableNativeRegistration();
  await assertTaskRuntimeKnowledgeAskUsesCentralNativeReceipts();
  await assertCodexKnowledgeAskUsesCentralNativeReceipt();
  await assertFailedKnowledgeAskKeepsCentralNativeReceiptForRecovery();
  await assertKnowledgeAgentFailureCarriesCentralNativeReceipt();
  await assertReturnedNativeCleanupFailureRequiresRecovery();
  await assertConnectionRecoverySettlementRejectionIsHandled();
}

async function assertKnowledgeAskFollowUpPersistsAndReusesCodexLease(): Promise<void> {
  const vaultPath = await createKnowledgeVault();
  try {
    const settings = normalizeSettingsData({
      settingsVersion: 29,
      agentBackend: "codex-cli",
      knowledgeBase: {
        backend: "codex-cli",
        sessionId: "kb-session",
        useCustomRulesFile: true,
        rulesFilePath: AGENTS_RULES_FILE
      },
      sessions: [{
        id: "kb-session",
        kind: "knowledge-base",
        title: KNOWLEDGE_BASE_SESSION_TITLE,
        cwd: vaultPath,
        revision: 1,
        generation: 1,
        contextId: "context-kb-session",
        commitId: "commit-kb-session",
        workspaceFingerprint: workspaceFingerprint({ vaultPath, cwd: vaultPath }),
        messages: [
          { id: "m1", role: "user", text: "/ask EchoInk 是什么？", createdAt: 1 },
          { id: "m2", role: "assistant", text: "EchoInk 是知识库 Harness。", backendId: "codex-cli", createdAt: 2 }
        ],
        createdAt: 1,
        updatedAt: 2
      }]
    }).settings;
    const harness = createKnowledgeAskHarness(settings, vaultPath);

    const first = await harness.manager.handleUserMessage("/ask EchoInk 是什么？");
    const second = await harness.manager.handleUserMessage("/ask 继续展开刚才的回答");

    assert.equal(first.status, "success", first.message);
    assert.equal(second.status, "success", second.message);
    assert.ok(first.harnessResult?.backendBinding?.nativeThreadId, "first Knowledge /ask should produce a codex nativeThreadId binding");
    assert.ok(second.harnessResult?.backendBinding?.nativeThreadId, "second Knowledge /ask should produce a codex nativeThreadId binding");

    const knowledgeSession = settings.sessions.find((session) => session.id === settings.knowledgeBase.sessionId);
    const savedBinding = knowledgeSession?.backendBindings?.["codex-cli"];
    const diagnostics = [
      ...harness.requestSessionIds.every((sessionId) => sessionId === knowledgeSession?.id)
        ? []
        : [`request.sessionId=${JSON.stringify(harness.requestSessionIds)} expected ${knowledgeSession?.id}`],
      savedBinding?.nativeThreadId === first.harnessResult?.backendBinding?.nativeThreadId
        ? ""
        : `savedBinding.nativeThreadId=${savedBinding?.nativeThreadId ?? "<missing>"} expected ${first.harnessResult?.backendBinding?.nativeThreadId}`,
      second.harnessResult?.backendBinding?.nativeThreadId === first.harnessResult?.backendBinding?.nativeThreadId
        ? ""
        : `second.nativeThreadId=${second.harnessResult?.backendBinding?.nativeThreadId} expected reuse ${first.harnessResult?.backendBinding?.nativeThreadId}`,
      second.harnessResult?.contextManifest?.mode === "incremental"
        ? ""
        : `second.contextManifest.mode=${second.harnessResult?.contextManifest?.mode ?? "<missing>"} expected incremental`,
      harness.events.some((event) => event.type === "agent.native_lease.reused")
        ? ""
        : "missing agent.native_lease.reused event"
    ].filter(Boolean);

    if (diagnostics.length) {
      assert.fail(`Knowledge /ask follow-up did not reuse leased conversation: ${diagnostics.join("; ")}`);
    }
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertKnowledgeRulesChangeStartsFreshCodexThread(): Promise<void> {
  const vaultPath = await createKnowledgeVault();
  try {
    const settings = normalizeSettingsData({
      settingsVersion: 29,
      agentBackend: "codex-cli",
      knowledgeBase: {
        backend: "codex-cli",
        sessionId: "kb-rules-session",
        rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE
      },
      sessions: [{
        id: "kb-rules-session",
        kind: "knowledge-base",
        title: KNOWLEDGE_BASE_SESSION_TITLE,
        cwd: vaultPath,
        revision: 1,
        generation: 1,
        contextId: "context-kb-rules-session",
        commitId: "commit-kb-rules-session",
        workspaceFingerprint: workspaceFingerprint({ vaultPath, cwd: vaultPath }),
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }]
    }).settings;
    const harness = createKnowledgeAskHarness(settings, vaultPath);

    await writeFile(path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# Knowledge Rules\n\nRULE-V1\n", "utf8");
    const first = await harness.manager.handleUserMessage("/ask current acceptance marker");
    const firstFingerprint = settings.sessions[0]?.backendBindings?.["codex-cli"]?.vaultProfileFingerprint;

    await writeFile(path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# Knowledge Rules\n\nRULE-V2\n", "utf8");
    const second = await harness.manager.handleUserMessage("/ask current acceptance marker");
    const secondFingerprint = settings.sessions[0]?.backendBindings?.["codex-cli"]?.vaultProfileFingerprint;

    assert.equal(first.status, "success", first.message);
    assert.equal(second.status, "success", second.message);
    assert.ok(firstFingerprint);
    assert.ok(secondFingerprint);
    assert.notEqual(secondFingerprint, firstFingerprint, "changed rules must replace the persisted Vault profile fingerprint");
    assert.notEqual(
      second.harnessResult?.backendBinding?.nativeThreadId,
      first.harnessResult?.backendBinding?.nativeThreadId,
      "Codex must start a fresh native thread when required Vault rules change"
    );
    assert.equal(harness.startedThreads.length, 2);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

async function assertKnowledgeAgentSwitchBootstrapsFromStoredSession(): Promise<void> {
  const session = {
    id: "kb-switch-session",
    kind: "knowledge-base" as const,
    title: KNOWLEDGE_BASE_SESSION_TITLE,
    cwd: "/tmp/echoink-vault",
    revision: 1,
    generation: 1,
    contextId: "context-kb-switch-session",
    commitId: "commit-kb-switch-session",
    workspaceFingerprint: workspaceFingerprint({
      vaultPath: "/tmp/echoink-vault",
      cwd: "/tmp/echoink-vault"
    }),
    messages: [
      { id: "m1", role: "user" as const, text: "/ask 记住口令 KB-CODEX-271", backendId: "codex-cli", createdAt: 1 },
      { id: "m2", role: "assistant" as const, text: "已记住 KB-CODEX-271", backendId: "codex-cli", createdAt: 2 }
    ],
    createdAt: 1,
    updatedAt: 2
  };
  let capturedPrompt = "";
  const runtime: AgentTaskRuntime = {
    kind: "hermes",
    async connect() {
      return { connected: true, label: "Hermes", errors: [] };
    },
    async listModels() {
      return [];
    },
    async runTask(input) {
      capturedPrompt = input.prompt;
      input.onRunId?.("hermes-run-1");
      return { text: "KB-CODEX-271", runId: "hermes-run-1" };
    },
    async abort() {
      return undefined;
    }
  };
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(20_000)
  });

  const output = await runKnowledgeAgentTask(runtime, {
    prompt: "/ask 切换 Hermes 后回答刚才的口令",
    workflow: "knowledge.ask",
    outputKind: "plain-text",
    permission: "read-only"
  }, undefined, {
    vaultPath: session.cwd,
    sessionId: session.id,
    sessionProvider: (sessionId) => sessionId === session.id ? session : null,
    async runWithAdapter(input) {
      orchestrator.registerAdapter(input.adapter);
      return await orchestrator.run(input.request, input.sink, {
        sessionProvider: input.sessionProvider,
        registerNativeExecution: async ({ request, native }) => ({
          recordId: `fixture-native:${request.runId}:${native.backendId}:${native.id}`
        })
      });
    }
  });

  assert.match(capturedPrompt, /KB-CODEX-271/, "switched Knowledge backend must receive prior EchoInk session context");
  assert.equal(output.harnessResult?.contextManifest?.mode, "bootstrap");
}

async function assertStructuredTaskRuntimesWaitForDurableNativeRegistration(): Promise<void> {
  for (const backend of ["opencode", "hermes"] as const) {
    const harness = createKnowledgeNativeLifecycleServiceHarness(backend);
    const orchestrator = new RunOrchestrator({
      adapters: [],
      ledger: new InMemoryRunLedger(),
      memoryProvider: new NoopMemoryProvider(),
      now: fixedClock(30_000)
    });
    const registrationGate = nativeRegistrationDeferred();
    const registrationStarted = nativeRegistrationDeferred();
    const order: string[] = [];
    let registeredNativeRecord: any = null;
    let promptCalls = 0;
    let registrationCalls = 0;
    harness.plugin.getNativeExecutionRefContext = () => ({
      deviceKey: "device-test",
      vaultId: "vault-test"
    });
    harness.plugin.runHarnessWithAdapter = async (input: any) =>
      await orchestrator.run(input.request, input.sink, {
        adapter: input.adapter,
        sessionProvider: input.sessionProvider,
        registerNativeExecution: input.registerNativeExecution
      });
    harness.plugin.recordNativeExecution = async (record: any) => {
      registrationCalls += 1;
      registeredNativeRecord = structuredClone(record);
      assert.equal(record.workflow, "knowledge.journal");
      assert.equal(record.policy.mode, "ephemeral-run");
      order.push("record:start");
      registrationStarted.resolve();
      await registrationGate.promise;
      order.push("record:end");
    };
    const runtime: AgentTaskRuntime = {
      kind: backend,
      connect: async () => ({ connected: true, label: backend, errors: [] }),
      disconnect: async () => undefined,
      listModels: async () => [],
      runTask: async (input) => {
        assert.equal(
          input.requireNativeRegistrationBeforePrompt,
          true,
          `${backend} structured Knowledge must require the pre-prompt Native barrier`
        );
        order.push("native-id");
        await input.onRunId?.(
          `${backend}-structured-native`,
          backend === "hermes"
            ? {
              kind: "session",
              persistence: "provider-persistent",
              transport: "acp-stdio"
            }
            : undefined
        );
        promptCalls += 1;
        order.push("prompt");
        return {
          text: `${backend} structured answer`,
          runId: `${backend}-structured-native`
        };
      },
      abort: async () => undefined
    };
    (harness.service as any).runtimeController.createRuntime = () => runtime;

    const run = harness.service.runTask(structuredKnowledgeTaskInput(backend));
    await registrationStarted.promise;
    await Promise.resolve();
    assert.equal(promptCalls, 0, `${backend} prompt must wait for durable Native registration`);
    registrationGate.resolve();
    const output = await run;

    assert.equal(output.text, `${backend} structured answer`);
    assert.equal(promptCalls, 1);
    assert.equal(registrationCalls, 1);
    assert.equal(registeredNativeRecord?.native.kind, "session");
    assert.equal(
      registeredNativeRecord?.native.persistence,
      "provider-persistent"
    );
    assert.equal(
      registeredNativeRecord?.native.transport,
      backend === "hermes" ? "acp-stdio" : undefined
    );
    assert.equal(registeredNativeRecord?.native.deviceKey, "device-test");
    assert.equal(registeredNativeRecord?.native.vaultId, "vault-test");
    assert.deepEqual(order, ["native-id", "record:start", "record:end", "prompt"]);
  }

  for (const backend of ["opencode", "hermes"] as const) {
    const harness = createKnowledgeNativeLifecycleServiceHarness(backend);
    const orchestrator = new RunOrchestrator({
      adapters: [],
      ledger: new InMemoryRunLedger(),
      memoryProvider: new NoopMemoryProvider(),
      now: fixedClock(31_000)
    });
    let promptCalls = 0;
    let deleteCalls = 0;
    let abortCalls = 0;
    harness.plugin.getNativeExecutionRefContext = () => ({
      deviceKey: "device-test",
      vaultId: "vault-test"
    });
    harness.plugin.runHarnessWithAdapter = async (input: any) =>
      await orchestrator.run(input.request, input.sink, {
        adapter: input.adapter,
        sessionProvider: input.sessionProvider,
        registerNativeExecution: input.registerNativeExecution
      });
    harness.plugin.recordNativeExecution = async () => {
      throw new Error("native store unavailable");
    };
    const runtime: AgentTaskRuntime = {
      kind: backend,
      connect: async () => ({ connected: true, label: backend, errors: [] }),
      disconnect: async () => undefined,
      listModels: async () => [],
      runTask: async (input) => {
        assert.equal(input.requireNativeRegistrationBeforePrompt, true);
        await input.onRunId?.(`${backend}-registration-rejected`);
        promptCalls += 1;
        return { text: "must not run", runId: `${backend}-registration-rejected` };
      },
      deleteNativeSession: async () => {
        deleteCalls += 1;
        return true;
      },
      abort: async () => {
        abortCalls += 1;
      }
    };
    (harness.service as any).runtimeController.createRuntime = () => runtime;

    await assert.rejects(
      () => harness.service.runTask(structuredKnowledgeTaskInput(backend)),
      (error: unknown) =>
        error instanceof Error
        && (error as Error & { code?: string }).code === NATIVE_RUN_REGISTRATION_ERROR_CODE
        && error.message.includes("Native execution registration failed")
        && error.message.includes("native store unavailable")
    );
    assert.equal(promptCalls, 0, `${backend} must fail closed before Prompt`);
    assert.equal(deleteCalls, backend === "opencode" ? 1 : 0);
    assert.equal(abortCalls, backend === "hermes" ? 1 : 0);
  }
}

async function assertStructuredCodexWaitsForDurableNativeRegistration(): Promise<void> {
  const deferredHarness = createStructuredCodexRegistrationHarness();
  const registrationGate = nativeRegistrationDeferred();
  const registrationStarted = nativeRegistrationDeferred();
  deferredHarness.plugin.recordNativeExecution = async (record: any) => {
    assert.equal(record.workflow, "knowledge.journal");
    assert.equal(record.policy.mode, "ephemeral-run");
    registrationStarted.resolve();
    await registrationGate.promise;
  };

  const run = deferredHarness.service.runTask(structuredKnowledgeTaskInput("codex-cli"));
  await registrationStarted.promise;
  await Promise.resolve();
  assert.equal(
    deferredHarness.startTurnCalls(),
    0,
    "Codex startTurn must wait for durable Native registration"
  );
  registrationGate.resolve();
  const output = await run;
  assert.equal(output.text, "answer from codex-structured-thread");
  assert.equal(deferredHarness.startTurnCalls(), 1);
  assert.deepEqual(deferredHarness.archivedThreads(), []);

  const rejectedHarness = createStructuredCodexRegistrationHarness();
  rejectedHarness.plugin.recordNativeExecution = async () => {
    throw Object.assign(
      new Error("codex native store unavailable"),
      { code: NATIVE_RUN_REGISTRATION_ERROR_CODE }
    );
  };
  await assert.rejects(
    () => rejectedHarness.service.runTask(structuredKnowledgeTaskInput("codex-cli")),
    (error: unknown) =>
      error instanceof Error
      && (error as Error & { code?: string }).code === NATIVE_RUN_REGISTRATION_ERROR_CODE
      && error.message.includes("codex native store unavailable")
  );
  assert.equal(rejectedHarness.startTurnCalls(), 0);
  assert.deepEqual(
    rejectedHarness.archivedThreads(),
    ["codex-structured-thread"],
    "Codex must best-effort archive the newly created thread after registration rejection"
  );
}

async function assertTaskRuntimeKnowledgeAskUsesCentralNativeReceipts(): Promise<void> {
  for (const backend of ["opencode", "hermes"] as const) {
    const harness = createKnowledgeNativeLifecycleServiceHarness(backend);
    const centralRecordId = `harness-native:knowledge-${backend}:central`;
    const nativeId = `${backend}-native-session`;
    (harness.service as any).runtimeController = {
      run: async (input: any) => {
        input.onNativeRunId?.(backend, nativeId);
        return {
          text: `${backend} answer`,
          harnessResult: knowledgeAskHarnessResult(
            input.harnessRunId,
            backend,
            nativeId,
            centralRecordId
          )
        };
      }
    };

    const output = await harness.service.runTask(knowledgeAskTaskInput(backend));
    assert.deepEqual(
      output.harnessResult?.nativeExecutionRecordIds,
      [centralRecordId, ` ${centralRecordId} `],
      `${backend} should return the central registration receipts unchanged`
    );
    assert.deepEqual(
      harness.recordedRecordIds,
      [],
      `${backend} onRunId must not create a duplicate legacy Knowledge ask record`
    );

    await harness.service.settlePendingNativeExecutions();

    assert.deepEqual(harness.settledRecordIds, [centralRecordId]);
    assert.deepEqual(harness.calls.slice(0, 4), [
      "event:run.local_commit.started",
      "commit",
      "event:run.local_commit.completed",
      `settle:${centralRecordId}:committed`
    ]);
  }
}

async function assertCodexKnowledgeAskUsesCentralNativeReceipt(): Promise<void> {
  const harness = createKnowledgeNativeLifecycleServiceHarness("codex-cli");
  const centralRecordId = "harness-native:knowledge-codex:central";
  const nativeId = "codex-central-thread";
  let adapterOptions: any = null;
  harness.plugin.ensureCodexConnected = async () => ({
    connected: true,
    errors: [],
    models: [{ model: "gpt-test", isDefault: true }]
  });
  harness.plugin.hasCodexHarnessTransport = () => true;
  harness.plugin.getNativeExecutionRefContext = () => ({
    deviceKey: "device-test",
    vaultId: "vault-test"
  });
  harness.plugin.setCodexHarnessThreadName = async () => undefined;
  harness.plugin.createCodexRichAgentAdapter = (options: any) => {
    adapterOptions = options;
    return {
      awaitResult: async () => ({
        status: "completed",
        outputText: "codex answer"
      }),
      dispose: async () => undefined
    };
  };
  harness.plugin.runHarnessWithAdapter = async (input: any) => {
    await adapterOptions.buildInput(nativeId);
    return knowledgeAskHarnessResult(
      input.request.runId,
      "codex-cli",
      nativeId,
      centralRecordId,
      "running"
    );
  };

  const output = await harness.service.runTask(knowledgeAskTaskInput("codex-cli"));
  assert.equal(output.text, "codex answer");
  assert.deepEqual(
    harness.recordedRecordIds,
    [],
    "Codex buildInput must not create a duplicate legacy Knowledge ask record"
  );

  await harness.service.settlePendingNativeExecutions();

  assert.deepEqual(harness.settledRecordIds, [centralRecordId]);
  assert.ok(
    harness.calls.indexOf("commit") < harness.calls.indexOf(`settle:${centralRecordId}:committed`),
    "Codex central receipt may settle only after the durable Knowledge commit"
  );
}

async function assertFailedKnowledgeAskKeepsCentralNativeReceiptForRecovery(): Promise<void> {
  const harness = createKnowledgeNativeLifecycleServiceHarness("opencode", false);
  const centralRecordId = "harness-native:knowledge-opencode:failed";
  (harness.service as any).runtimeController = {
    run: async (input: any) => {
      input.onNativeRunId?.("opencode", "opencode-failed-session");
      throw Object.assign(new Error("OpenCode failed after prompt submission"), {
        harnessResult: knowledgeAskHarnessResult(
          input.harnessRunId,
          "opencode",
          "opencode-failed-session",
          centralRecordId,
          "failed"
        )
      });
    }
  };

  await assert.rejects(
    () => harness.service.runTask(knowledgeAskTaskInput("opencode")),
    /OpenCode failed after prompt submission/
  );
  assert.deepEqual(harness.recordedRecordIds, []);

  await harness.service.settlePendingNativeExecutions();

  assert.deepEqual(harness.settledRecordIds, [centralRecordId]);
  assert.ok(harness.calls.includes(`settle:${centralRecordId}:failed`));
  assert.equal(
    (harness.service as any).pendingNativeExecutionCommits.has(centralRecordId),
    true,
    "failed local persistence must keep the central receipt pending for recovery"
  );
  assert.equal(
    harness.calls.some((call) => call === "cleanup"),
    false,
    "Native cleanup must stay closed when the Knowledge durable commit is unproven"
  );
}

async function assertKnowledgeAgentFailureCarriesCentralNativeReceipt(): Promise<void> {
  const centralRecordId = "harness-native:knowledge-agent:failed";
  const runtime: AgentTaskRuntime = {
    kind: "opencode",
    async connect() {
      return { connected: true, label: "OpenCode", errors: [] };
    },
    async listModels() {
      return [];
    },
    async runTask() {
      throw new Error("runtime must not be called by this receipt propagation fixture");
    },
    async abort() {
      return undefined;
    }
  };
  let caught: unknown;
  try {
    await runKnowledgeAgentTask(runtime, {
      prompt: "failure receipt",
      workflow: "knowledge.ask",
      outputKind: "plain-text",
      permission: "read-only"
    }, undefined, {
      vaultPath: "/vault",
      async runWithAdapter(input) {
        return knowledgeAskHarnessResult(
          input.request.runId,
          "opencode",
          "opencode-failed-session",
          centralRecordId,
          "failed"
        );
      }
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.deepEqual(
    (caught as Error & { harnessResult?: HarnessRunResult }).harnessResult
      ?.nativeExecutionRecordIds,
    [centralRecordId, ` ${centralRecordId} `],
    "failed Harness results must carry central receipts through the Knowledge error boundary"
  );
}

async function assertConnectionRecoverySettlementRejectionIsHandled(): Promise<void> {
  const unhandled: unknown[] = [];
  const warnings: unknown[][] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const connectedStatus = {
      connected: true,
      accountLabel: "Fixture",
      loggedIn: true,
      models: [],
      skills: [],
      mcpServers: [],
      rateLimits: null,
      rateLimitsByLimitId: null,
      errors: []
    };
    const plugin: any = {
      codex: {
        isConnected: () => false,
        connect: async () => connectedStatus
      },
      lastStatus: null,
      archivePendingKnowledgeBaseThreads: async () => {
        throw new Error("Native cleanup gate is not ready");
      }
    };
    const service = new EchoInkConnectionService(plugin, () => undefined);

    const status = await service.ensureCodexConnected();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(status.connected, true);
    assert.deepEqual(
      unhandled,
      [],
      "connection-triggered Native recovery must sink its rejected Promise"
    );
    assert.equal(
      warnings.some((args) => args.some((value) => String(value).includes("Native cleanup gate is not ready"))),
      true,
      "connection-triggered Native recovery rejection must remain observable"
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    console.warn = originalWarn;
  }
}

async function assertReturnedNativeCleanupFailureRequiresRecovery(): Promise<void> {
  const harness = createKnowledgeNativeLifecycleServiceHarness("opencode");
  harness.plugin.cleanupDueNativeExecutions = async () => [{
    recordId: "native:provider-cleanup-failure",
    cleanup: "failed",
    attempted: true,
    message: "OpenCode provider refused session disposal"
  }];

  const disposed = await harness.service.settlePendingNativeExecutions();
  const summary = harness.service.getLastNativeLifecycleSummary();

  assert.equal(disposed, 0);
  assert.equal(summary?.recoveryRequired, true);
  assert.deepEqual(summary?.cleanupStatuses, ["failed"]);
  assert.equal(summary?.cleanupAttempted, true);
  assert.deepEqual(summary?.recordIds, ["native:provider-cleanup-failure"]);
  assert.match(
    summary?.warning ?? "",
    /OpenCode provider refused session disposal/
  );
}

function createKnowledgeNativeLifecycleServiceHarness(
  backend: "codex-cli" | "opencode" | "hermes",
  commitSucceeds = true
): {
  service: KnowledgeBaseAgentTaskService;
  plugin: any;
  calls: string[];
  recordedRecordIds: string[];
  settledRecordIds: string[];
} {
  const calls: string[] = [];
  const recordedRecordIds: string[] = [];
  const settledRecordIds: string[] = [];
  const settings = normalizeSettingsData({
    settingsVersion: 29,
    agentBackend: backend,
    knowledgeBase: {
      backend,
      sessionId: `knowledge-central-${backend}`
    },
    sessions: [{
      id: `knowledge-central-${backend}`,
      kind: "knowledge-base",
      title: KNOWLEDGE_BASE_SESSION_TITLE,
      cwd: "/vault",
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }]
  }).settings;
  const plugin: any = {
    settings,
    getVaultPath: () => "/vault",
    saveSettings: async () => undefined,
    appendHarnessRunEvent: async (event: { type: string }) => {
      calls.push(`event:${event.type}`);
    },
    commitKnowledgeRunDurably: async () => {
      calls.push("commit");
      return {
        committed: commitSucceeds,
        conversationCommitted: commitSucceeds,
        runLedgerCommitted: commitSucceeds,
        artifactsCommitted: commitSucceeds,
        historyIndexCommitted: commitSucceeds,
        ...(!commitSucceeds ? { error: "Conversation/History commit failed" } : {})
      };
    },
    recordNativeExecution: async (record: { id: string }) => {
      recordedRecordIds.push(record.id);
    },
    settleNativeExecution: async (input: {
      recordId: string;
      localCommit: { committed: boolean };
    }) => {
      settledRecordIds.push(input.recordId);
      calls.push(
        `settle:${input.recordId}:${input.localCommit.committed ? "committed" : "failed"}`
      );
      return {
        cleanup: input.localCommit.committed
          ? "not-needed"
          : "retained-for-recovery"
      };
    },
    cleanupDueNativeExecutions: async () => {
      calls.push("cleanup");
      return [];
    },
    settleHarnessRunTerminal: async () => undefined
  };
  return {
    service: new KnowledgeBaseAgentTaskService(
      plugin,
      { isCancelRequested: () => false }
    ),
    plugin,
    calls,
    recordedRecordIds,
    settledRecordIds
  };
}

function knowledgeAskTaskInput(
  backend: "codex-cli" | "opencode" | "hermes"
) {
  return {
    backend,
    prompt: "question",
    sources: [],
    permission: "read-only" as const,
    codexWriteScope: "knowledge-base" as const,
    managedKind: "ask" as const
  };
}

function structuredKnowledgeTaskInput(
  backend: "codex-cli" | "opencode" | "hermes"
) {
  return {
    backend,
    prompt: "structured journal",
    sources: [],
    permission: "read-only" as const,
    codexWriteScope: "journal" as const,
    managedKind: "journal" as const
  };
}

function createStructuredCodexRegistrationHarness(): {
  service: KnowledgeBaseAgentTaskService;
  plugin: any;
  startTurnCalls(): number;
  archivedThreads(): string[];
} {
  const harness = createKnowledgeNativeLifecycleServiceHarness("codex-cli");
  const notificationHub = new CodexRichNotificationHub();
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(32_000)
  });
  let turnCalls = 0;
  const archivedThreads: string[] = [];

  harness.plugin.ensureCodexConnected = async () => ({
    connected: true,
    errors: [],
    models: [{ model: "gpt-test", isDefault: true }]
  });
  harness.plugin.hasCodexHarnessTransport = () => true;
  harness.plugin.getNativeExecutionRefContext = () => ({
    deviceKey: "device-test",
    vaultId: "vault-test"
  });
  harness.plugin.setCodexHarnessThreadName = async () => undefined;
  harness.plugin.startCodexHarnessThread = async () => ({
    threadId: "codex-structured-thread",
    title: "Structured thread"
  });
  harness.plugin.resumeCodexHarnessThread = async () => undefined;
  harness.plugin.startCodexHarnessTurn = async (threadId: string) => {
    turnCalls += 1;
    const turnId = `codex-structured-turn-${turnCalls}`;
    setTimeout(() => completeCodexTurn(notificationHub, threadId, turnId), 0);
    return turnId;
  };
  harness.plugin.createCodexRichAgentAdapter = (options: any) =>
    new CodexRichAgentAdapter({
      ...options,
      notificationHub,
      archiveThread: async (threadId) => {
        archivedThreads.push(threadId);
      }
    });
  harness.plugin.runHarnessWithAdapter = async (input: any) =>
    await orchestrator.run(input.request, input.sink, {
      adapter: input.adapter,
      sessionProvider: input.sessionProvider,
      registerNativeExecution: input.registerNativeExecution
    });
  harness.plugin.settleHarnessRunTerminal = async (input: any) => {
    await orchestrator.settleRunTerminal(input);
  };

  return {
    service: harness.service,
    plugin: harness.plugin,
    startTurnCalls: () => turnCalls,
    archivedThreads: () => [...archivedThreads]
  };
}

function nativeRegistrationDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function knowledgeAskHarnessResult(
  runId: string,
  backend: "codex-cli" | "opencode" | "hermes",
  nativeId: string,
  centralRecordId: string,
  status: HarnessRunResult["status"] = "completed"
): HarnessRunResult {
  return {
    runId,
    status,
    ...(status === "failed" ? { error: `${backend} failed` } : {}),
    nativeExecution: {
      backendId: backend,
      id: nativeId,
      kind: backend === "codex-cli" ? "thread" : "session",
      persistence: "provider-persistent",
      deviceKey: "device-test",
      vaultId: "vault-test",
      createdAt: 1
    },
    nativeExecutionRecordIds: [centralRecordId, ` ${centralRecordId} `]
  };
}

function createKnowledgeAskHarness(settings: CodexForObsidianSettings, vaultPath: string): {
  manager: KnowledgeBaseManager;
  requestSessionIds: string[];
  events: HarnessEvent[];
  startedThreads: string[];
  resumedThreads: string[];
} {
  const requestSessionIds: string[] = [];
  const events: HarnessEvent[] = [];
  const notificationHub = new CodexRichNotificationHub();
  const startedThreads: string[] = [];
  const resumedThreads: string[] = [];
  let turnCount = 0;
  const orchestrator = new RunOrchestrator({
    adapters: [],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: (sessionId) => settings.sessions.find((session) => session.id === sessionId) ?? null,
    now: fixedClock(10_000)
  });
  let manager: KnowledgeBaseManager;

  const plugin = {
    settings,
    getVaultPath: () => vaultPath,
    ensureCodexConnected: async () => ({ connected: true, errors: [], models: [{ model: "gpt-test", isDefault: true }] }),
    hasCodexHarnessTransport: () => true,
    createCodexRichAgentAdapter: (options: ConstructorParameters<typeof CodexRichAgentAdapter>[0]) => new CodexRichAgentAdapter({
      ...options,
      notificationHub: options.notificationHub ?? notificationHub
    }),
    startCodexHarnessThread: async () => {
      const threadId = `codex-thread-${startedThreads.length + 1}`;
      startedThreads.push(threadId);
      return { threadId, title: `Thread ${startedThreads.length}` };
    },
    resumeCodexHarnessThread: async (threadId: string) => {
      resumedThreads.push(threadId);
    },
    startCodexHarnessTurn: async (threadId: string) => {
      turnCount += 1;
      const turnId = `turn-${turnCount}`;
      setTimeout(() => completeCodexTurn(notificationHub, threadId, turnId), 0);
      return turnId;
    },
    setCodexHarnessThreadName: async () => undefined,
    interruptCodexHarnessTurn: async () => undefined,
    runHarnessWithAdapter: async (input: {
      adapter: CodexRichAgentAdapter;
      request: any;
      sink?: (event: HarnessEvent) => void;
      sessionProvider?: (sessionId: string) => any;
    }): Promise<HarnessRunResult> => {
      requestSessionIds.push(input.request.sessionId);
      orchestrator.registerAdapter(input.adapter);
      return await orchestrator.run(input.request, async (event) => {
        events.push(event);
        await input.sink?.(event);
      }, {
        sessionProvider: input.sessionProvider,
        beforeBindingReplacement: async ({ session, binding }) => {
          const nextBindings = { ...(session.backendBindings ?? {}) };
          delete nextBindings[binding.backendId];
          session.backendBindings = nextBindings;
          if (binding.backendId === "codex-cli") delete session.threadId;
        },
        registerNativeExecution: async ({ request, native }) => ({
          recordId: `fixture-native:${request.runId}:${native.backendId}:${native.id}`
        })
      });
    },
    settleHarnessRunTerminal: async (input: Parameters<RunOrchestrator["settleRunTerminal"]>[0]) => {
      await orchestrator.settleRunTerminal(input, async (event) => {
        events.push(event);
      });
    },
    saveSettings: async () => undefined,
    getCodexView: () => ({ refreshKnowledgeBaseDashboard: () => undefined }),
    getNativeExecutionRefContext: () => ({ deviceKey: "device-test", vaultId: "vault-test" }),
    recordNativeExecution: async () => undefined,
    settleNativeExecution: async () => ({ cleanup: "pending" }),
    cleanupDueNativeExecutions: async () => [],
    getReviewManager: () => null,
    externalizeMessageText: async () => undefined,
    pruneKnowledgeBaseHistoryByRetention: async () => ({ removedDayCount: 0, removedMessageCount: 0 }),
    activateKnowledgeBaseChannel: async () => undefined,
    addCommand: () => undefined,
    addRibbonIcon: () => undefined,
    registerInterval: () => undefined,
    app: {
      workspace: {
        onLayoutReady: () => undefined,
        getActiveFile: () => null
      }
    }
  };

  manager = new KnowledgeBaseManager(plugin as any);
  // These tests exercise /ask lease semantics, not startup WAL recovery. The
  // real plugin completes recovery before user commands become available, so
  // mirror that ready-state contract in this focused fixture.
  (manager as any).maintenanceRecoveryState = "ready";
  return { manager, requestSessionIds, events, startedThreads, resumedThreads };
}

function completeCodexTurn(notificationHub: CodexRichNotificationHub, threadId: string, turnId: string): void {
  const itemId = `item-${turnId}`;
  notificationHub.dispatch({
    method: "item/started",
    params: { threadId, turnId, item: { id: itemId, threadId, turnId } }
  } as any);
  notificationHub.dispatch({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, itemId, delta: `answer from ${threadId}` }
  } as any);
  notificationHub.dispatch({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, threadId, status: "completed" } }
  } as any);
}

async function createKnowledgeVault(): Promise<string> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-kb-ask-lease-"));
  await mkdir(path.join(vaultPath, "raw", "articles"), { recursive: true });
  await mkdir(path.join(vaultPath, "wiki"), { recursive: true });
  await writeFile(path.join(vaultPath, AGENTS_RULES_FILE), "# Knowledge Rules\n", "utf8");
  await writeFile(path.join(vaultPath, DEFAULT_KNOWLEDGE_BASE_RULES_FILE), "# Knowledge Rules\n", "utf8");
  await writeFile(path.join(vaultPath, "raw", "articles", "echoink.md"), "# EchoInk\n\nEchoInk 是知识库 Harness。\n", "utf8");
  await writeFile(path.join(vaultPath, "wiki", "echoink.md"), "# EchoInk\n\nEchoInk 是知识库 Harness。\n", "utf8");
  return vaultPath;
}

function fixedClock(start: number): () => number {
  let current = start;
  return () => current++;
}
