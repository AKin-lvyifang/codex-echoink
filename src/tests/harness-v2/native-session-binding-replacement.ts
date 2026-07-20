import * as assert from "node:assert/strict";
import type {
  AgentAdapter,
  AgentNativeSessionPreparationRequest,
  AgentNativeSessionPreparationResult,
  AgentRunRequest,
  AgentRunResult
} from "../../harness/agents/adapter";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { TaskRuntimeAgentAdapter } from "../../harness/agents/adapters/task-runtime-adapter";
import { NativeSessionStaleError, type AgentTaskInput } from "../../agent/types";
import { noCapabilities } from "../../harness/contracts/capability";
import type { HarnessEventSink } from "../../harness/contracts/event";
import type {
  BackendSessionBinding,
  HarnessRunRequest
} from "../../harness/contracts/run";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import {
  NativeSessionLeaseManager,
  type NativeSessionLeaseDecisionInput
} from "../../harness/kernel/native-session-lease-manager";
import {
  type BeforeBindingReplacement,
  RunOrchestrator
} from "../../harness/kernel/run-orchestrator";
import type { SessionContextRetirement } from "../../harness/conversation/context-rotation";
import type { CommitConversationContextOptions } from "../../harness/conversation/conversation-store";
import {
  vaultProfileFingerprint,
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import {
  rotateEchoInkSessionContext,
  type EchoInkSessionContextRotationOptions
} from "../../plugin/session-context-lifecycle";
import type { StoredSession } from "../../settings/settings";
import { commitChatWorkspaceSelection } from "../../ui/codex-view/workspace-controller";

const WORKSPACE_A = { vaultPath: "/vault", cwd: "/vault/workspace-a" };
const WORKSPACE_B = { vaultPath: "/vault", cwd: "/vault/workspace-b" };

export async function runHarnessV2NativeSessionBindingReplacementTests(): Promise<void> {
  await assertConcurrentSameBackendRunsKeepTheirCapturedAdapters();
  await assertWorkspaceSwitchNeverResumesPreviousNativeBinding();
  assertLeaseDecisionChecksCompleteContextIdentity();
  await assertEveryInvalidationRetiresBeforeReplacement();
  await assertResumeFailureAndUnsupportedRetireBeforeStarting();
  await assertCodexPreparationDoesNotMutateConversationBinding();
  await assertMissingOrFailedRetirementFailsClosed();
  await assertMissingConversationIdentityCannotCreateBinding();
  await assertChatAndKnowledgeAskUseTheSameReplacementContract();
  await assertEphemeralWorkflowDoesNotReplaceConversationLease();
  await assertPersistentWorkspaceIdentityFailsClosed();
  await assertVaultProfileChangeRetiresBeforeReplacement();
  await assertCodexMissingThreadRetiresAndRetriesOnce();
  await assertCodexStaleRetryFailurePreservesBothRecords();
  await assertOpenCodeStaleRetryPreservesOldAndNewRecords();
  await assertCodexWorkflowIsolationIsPerRun();
  await assertCodexNativeRegistrationPrecedesPrompt();
  await assertNativeExecutionRecordIdsSurviveSynchronousTerminals();
  await assertLeaseAnchorBeforeCurrentContextForcesRetirement();
  await assertLeaseCleanupOnlySchedulesDurableRetirement();
}

async function assertConcurrentSameBackendRunsKeepTheirCapturedAdapters(): Promise<void> {
  const kernel = new EchoInkHarnessKernel({
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: () => 100
  });
  const calls: string[] = [];
  const adapterFor = (tag: string): AgentAdapter => ({
    manifest: {
      id: "opencode",
      displayName: tag,
      version: tag,
      capabilities: noCapabilities()
    },
    async connect() {
      calls.push(`connect:${tag}`);
      return { connected: true, label: tag, errors: [] };
    },
    async dispose() {},
    async listModels() { return []; },
    async run(request) {
      calls.push(`run:${tag}:${request.runId}`);
      const native = {
        backendId: "opencode",
        id: `native-${tag}`,
        kind: "session" as const,
        persistence: "provider-persistent" as const,
        deviceKey: "device",
        vaultId: "/vault",
        createdAt: 100
      };
      await request.registerNativeExecution?.(native);
      return {
        status: "completed",
        outputText: tag,
        nativeExecution: native,
        nativeSessionId: native.id
      };
    },
    async cancel() {}
  });
  const run = (tag: string) => kernel.runWithAdapter({
    adapter: adapterFor(tag),
    request: {
      ...makeRequest(`run-captured-${tag}`, "knowledge", "knowledge.maintain"),
      sessionId: `session-captured-${tag}`
    },
    registerNativeExecution: async ({ native }) => ({
      recordId: `record:${tag}:${native.id}`
    })
  });

  const [first, second] = await Promise.all([run("first"), run("second")]);
  assert.equal(first.outputText, "first");
  assert.equal(second.outputText, "second");
  assert.deepEqual(first.nativeExecutionRecordIds, ["record:first:native-first"]);
  assert.deepEqual(second.nativeExecutionRecordIds, ["record:second:native-second"]);
  assert.deepEqual(calls.sort(), [
    "connect:first",
    "connect:second",
    "run:first:run-captured-first",
    "run:second:run-captured-second"
  ]);
}

async function assertWorkspaceSwitchNeverResumesPreviousNativeBinding(): Promise<void> {
  const session = makeSession("codex-cli");
  session.backendBindings!["codex-cli"]!.nativeExecutionRef = {
    backendId: "codex-cli",
    id: "native-old",
    kind: "thread",
    persistence: "provider-persistent",
    deviceKey: "device",
    vaultId: "/vault",
    createdAt: 1
  };
  const previousContextId = session.contextId;
  const previousCommitId = session.commitId;
  const lifecycleOrder: string[] = [];
  let registeredRetirements: SessionContextRetirement[] = [];
  let committedCandidate: StoredSession | null = null;
  let commitOptions: CommitConversationContextOptions | null = null;

  const harnessService = {
    async registerNativeExecutionRetirements(
      retirements: SessionContextRetirement[]
    ): Promise<void> {
      lifecycleOrder.push("register");
      assert.equal(session.cwd, WORKSPACE_A.cwd);
      assert.equal(
        session.backendBindings?.["codex-cli"]?.nativeThreadId,
        "native-old",
        "registration must happen while the old Workspace A binding is still authoritative"
      );
      registeredRetirements = structuredClone(retirements);
    },
    async promoteNativeExecutionRetirements(
      retirements: SessionContextRetirement[]
    ): Promise<void> {
      lifecycleOrder.push("promote");
      assert.deepEqual(
        retirements.map((retirement) => retirement.retirementId),
        registeredRetirements.map((retirement) => retirement.retirementId)
      );
      assert.equal(session.cwd, WORKSPACE_B.cwd);
      assert.equal(session.backendBindings, undefined);
      assert.equal(session.threadId, undefined);
    },
    async abortNativeExecutionRetirements(): Promise<void> {
      lifecycleOrder.push("abort");
    },
    async cleanupNativeExecutionRecord(): Promise<void> {
      lifecycleOrder.push("cleanup");
    }
  };
  const settingsStore = {
    async withConversationMutation<T>(
      _conversationId: string,
      action: () => Promise<T>
    ): Promise<T> {
      return await action();
    },
    async commitConversationSessionContext(
      candidate: StoredSession,
      options: CommitConversationContextOptions
    ): Promise<void> {
      lifecycleOrder.push("commit");
      assert.equal(
        session.backendBindings?.["codex-cli"]?.nativeThreadId,
        "native-old",
        "the live session must keep Workspace A until the durable candidate commits"
      );
      assert.equal(candidate.cwd, WORKSPACE_B.cwd);
      assert.equal(
        candidate.workspaceFingerprint,
        workspaceFingerprint(WORKSPACE_B)
      );
      assert.equal(candidate.backendBindings, undefined);
      assert.equal(candidate.threadId, undefined);
      committedCandidate = structuredClone(candidate);
      commitOptions = { ...options };
    }
  };
  const plugin = {
    async ensureEchoInkConversationSessionCreated(
      candidate: StoredSession
    ): Promise<void> {
      assert.equal(candidate, session);
    },
    getVaultPath(): string {
      return WORKSPACE_B.vaultPath;
    },
    async rotateEchoInkSessionContext(
      candidate: StoredSession,
      options: EchoInkSessionContextRotationOptions
    ) {
      return await rotateEchoInkSessionContext(
        harnessService as never,
        settingsStore as never,
        candidate,
        options
      );
    }
  };

  await commitChatWorkspaceSelection(
    { plugin } as never,
    session,
    WORKSPACE_B.cwd
  );

  assert.deepEqual(
    lifecycleOrder.slice(0, 3),
    ["register", "commit", "promote"],
    "Workspace rotation must register retirement, durably commit, then promote"
  );
  assert.equal(lifecycleOrder.includes("abort"), false);
  assert.equal(registeredRetirements.length, 1);
  const retirement = registeredRetirements[0]!;
  assert.equal(retirement.backendId, "codex-cli");
  assert.equal(retirement.binding.nativeThreadId, "native-old");
  assert.equal(retirement.binding.nativeExecutionRef?.id, "native-old");
  assert.equal(retirement.targetGeneration, 4);
  assert.equal(
    retirement.targetWorkspaceFingerprint,
    workspaceFingerprint(WORKSPACE_B)
  );
  assert.equal(commitOptions?.expectedGeneration, 3);
  assert.equal(commitOptions?.expectedCommitId, previousCommitId);
  assert.ok(commitOptions?.expectedContentRevision);
  assert.ok(committedCandidate);
  assert.equal(committedCandidate.generation, 4);
  assert.notEqual(committedCandidate.contextId, previousContextId);
  assert.notEqual(committedCandidate.commitId, previousCommitId);
  assert.equal(session.cwd, WORKSPACE_B.cwd);
  assert.equal(session.generation, 4);
  assert.equal(session.contextId, committedCandidate.contextId);
  assert.equal(session.commitId, committedCandidate.commitId);
  assert.equal(
    session.workspaceFingerprint,
    workspaceFingerprint(WORKSPACE_B)
  );
  assert.equal(session.backendBindings, undefined);
  assert.equal(session.threadId, undefined);

  let globalThreadReads = 0;
  let globalThreadWrites = 0;
  let startThreadCalls = 0;
  const resumeThreadIds: string[] = [];
  const providerThreadIds: string[] = [];
  const registeredNativeIds: string[] = [];
  let replacementHookCalls = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    getNativeThreadId: () => {
      globalThreadReads += 1;
      return "native-old";
    },
    setNativeThreadId: () => {
      globalThreadWrites += 1;
    },
    resumeThread: async (threadId) => {
      resumeThreadIds.push(threadId);
      providerThreadIds.push(threadId);
    },
    startThread: async (options) => {
      startThreadCalls += 1;
      assert.equal(options?.cwd, WORKSPACE_B.cwd);
      return {
        threadId: "native-workspace-b",
        title: "Workspace B"
      };
    },
    buildInput: (threadId, request) => {
      providerThreadIds.push(threadId);
      assert.equal(request.workspace.cwd, WORKSPACE_B.cwd);
      assert.equal(request.context.manifest?.sessionGeneration, 4);
      assert.equal(request.context.manifest?.contextId, session.contextId);
      return [];
    },
    startTurn: async (threadId) => {
      providerThreadIds.push(threadId);
      return "turn-workspace-b";
    }
  });
  const request: HarnessRunRequest = {
    ...makeRequest(
      "run-after-workspace-switch",
      "chat",
      "chat.generic",
      "codex-cli"
    ),
    workspace: WORKSPACE_B
  };
  const result = await createOrchestrator(adapter).run(
    request,
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async ({ native }) => {
        registeredNativeIds.push(native.id);
        return { recordId: `record:${native.id}` };
      },
      beforeBindingReplacement: async () => {
        replacementHookCalls += 1;
      }
    }
  );

  assert.equal(result.status, "running");
  assert.equal(
    resumeThreadIds.length,
    0,
    "the first Workspace B run must never resume Workspace A"
  );
  assert.equal(globalThreadReads, 0);
  assert.equal(globalThreadWrites, 0);
  assert.equal(startThreadCalls, 1);
  assert.equal(replacementHookCalls, 0);
  assert.deepEqual(registeredNativeIds, ["native-workspace-b"]);
  assert.equal(providerThreadIds.includes("native-old"), false);
  assert.deepEqual(providerThreadIds, [
    "native-workspace-b",
    "native-workspace-b"
  ]);
  assert.equal(
    result.backendBinding?.nativeThreadId,
    "native-workspace-b"
  );
  assert.equal(
    result.backendBinding?.workspaceFingerprint,
    workspaceFingerprint(WORKSPACE_B)
  );
  assert.equal(
    result.backendBinding?.contextCursor?.workspaceFingerprint,
    workspaceFingerprint(WORKSPACE_B)
  );
  assert.equal(result.backendBinding?.contextCursor?.sessionGeneration, 4);
  assert.equal(
    result.backendBinding?.contextCursor?.contextId,
    session.contextId
  );
  assert.equal(
    result.contextManifest?.workspaceFingerprint,
    workspaceFingerprint(WORKSPACE_B)
  );
  assert.equal(result.contextManifest?.sessionGeneration, 4);
  assert.equal(result.contextManifest?.contextId, session.contextId);
  assert.deepEqual(result.nativeExecutionRecordIds, [
    "record:native-workspace-b"
  ]);
}

function assertLeaseDecisionChecksCompleteContextIdentity(): void {
  const manager = new NativeSessionLeaseManager();
  const session = makeSession();
  const binding = session.backendBindings!.opencode!;
  const base: NativeSessionLeaseDecisionInput = {
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease: {
      leaseId: binding.leaseId!,
      echoInkSessionId: session.id,
      backendId: binding.backendId,
      native: {
        backendId: binding.backendId,
        id: binding.nativeSessionId!,
        kind: "session",
        persistence: "provider-persistent",
        deviceKey: "device",
        vaultId: "/vault",
        createdAt: 1
      },
      mode: "leased-conversation",
      status: "active",
      createdAt: 1,
      lastUsedAt: 90,
      expiresAt: 10_000,
      turnCount: 1,
      maxTurns: 20
    },
    expectedWorkspaceFingerprint: workspaceFingerprint(WORKSPACE_A),
    expectedSessionGeneration: 3,
    expectedContextId: "context-current",
    expectedVaultProfileFingerprint: "",
    sessionRevision: 3,
    currentContextMessageIds: ["m1", "m2"],
    latestMessageId: "m2",
    now: 100
  };

  assert.equal(manager.decide(base).mode, "incremental");
  assert.equal(manager.decide({
    ...base,
    expectedWorkspaceFingerprint: workspaceFingerprint(WORKSPACE_B)
  }).reason, "context-identity-mismatch");
  assert.equal(manager.decide({
    ...base,
    binding: {
      ...binding,
      contextCursor: {
        ...binding.contextCursor!,
        workspaceFingerprint: workspaceFingerprint(WORKSPACE_B)
      }
    }
  }).reason, "context-identity-mismatch");
  assert.equal(manager.decide({
    ...base,
    expectedContextId: "context-other"
  }).reason, "context-identity-mismatch");
  assert.equal(manager.decide({
    ...base,
    expectedSessionGeneration: 4
  }).reason, "context-identity-mismatch");
  assert.equal(manager.decide({
    ...base,
    binding: {
      ...binding,
      contextCursor: {
        syncedThroughMessageId: "m2",
        syncedSessionRevision: 3
      }
    }
  }).reason, "context-identity-missing");
  assert.equal(manager.decide({
    ...base,
    currentContextMessageIds: ["m1"]
  }).reason, "context-identity-mismatch");
  assert.equal(manager.decide({
    ...base,
    currentContextMessageIds: ["m1", "m2", "m2"]
  }).reason, "context-identity-mismatch");
  assert.equal(manager.decide({
    ...base,
    binding: {
      ...binding,
      workspaceFingerprint: undefined
    }
  }).reason, "context-identity-missing");
  assert.equal(manager.decide({
    ...base,
    binding: {
      ...binding,
      vaultProfileFingerprint: "profile-old"
    },
    expectedVaultProfileFingerprint: "profile-current"
  }).reason, "vault-profile-mismatch");
}

async function assertEveryInvalidationRetiresBeforeReplacement(): Promise<void> {
  const cases: Array<{
    reason: string;
    mutate(binding: BackendSessionBinding): void;
  }> = [
    {
      reason: "context-identity-missing",
      mutate(binding) {
        binding.contextCursor = {
          syncedThroughMessageId: "m2",
          syncedSessionRevision: 3,
          sessionGeneration: 3
        };
      }
    },
    {
      reason: "context-identity-mismatch",
      mutate(binding) {
        binding.workspaceFingerprint = workspaceFingerprint(WORKSPACE_B);
      }
    },
    {
      reason: "revision-mismatch",
      mutate(binding) {
        binding.syncedSessionRevision = 2;
      }
    },
    {
      reason: "no-lease",
      mutate(binding) {
        delete binding.leaseId;
      }
    },
    {
      reason: "expired",
      mutate(binding) {
        binding.leaseExpiresAt = 50;
      }
    },
    {
      reason: "max-turns",
      mutate(binding) {
        binding.leaseTurnCount = 20;
        binding.leaseMaxTurns = 20;
      }
    },
    {
      reason: "context-capacity",
      mutate(binding) {
        binding.leaseContextChars = 10_000;
        binding.leaseMaxContextChars = 10_000;
      }
    }
  ];

  for (const testCase of cases) {
    const order: string[] = [];
    const session = makeSession();
    testCase.mutate(session.backendBindings!.opencode!);
    const adapter = new LifecycleAdapter("opencode", "native", order);
    const hook = removingHook(order, testCase.reason);
    const result = await createOrchestrator(adapter).run(
      makeRequest(`run-${testCase.reason}`, "chat", "chat.generic"),
      undefined,
      {
        sessionProvider: () => session,
        beforeBindingReplacement: hook
      }
    );

    assert.equal(result.status, "completed", testCase.reason);
    assert.deepEqual(
      order,
      [`retire:${testCase.reason}`, "prepare:reset", "run"],
      testCase.reason
    );
    assert.equal(result.backendBinding?.workspaceFingerprint, workspaceFingerprint(WORKSPACE_A));
    assert.equal(
      result.backendBinding?.contextCursor?.workspaceFingerprint,
      workspaceFingerprint(WORKSPACE_A)
    );
    assert.equal(result.backendBinding?.contextCursor?.sessionGeneration, 3);
    assert.equal(result.backendBinding?.contextCursor?.contextId, "context-current");
    assert.equal(result.contextManifest?.sessionGeneration, 3);
  }
}

async function assertResumeFailureAndUnsupportedRetireBeforeStarting(): Promise<void> {
  {
    const order: string[] = [];
    const session = makeSession();
    const adapter = new LifecycleAdapter("opencode", "native", order, {
      status: "failed",
      nativeExecutionId: "native-old",
      error: "native session missing"
    });
    let bindingPresentAtRetirement = false;
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-resume-failed", "chat", "chat.generic"),
      undefined,
      {
        sessionProvider: () => session,
        beforeBindingReplacement: async (input) => {
          bindingPresentAtRetirement = session.backendBindings?.opencode === input.binding;
          order.push(`retire:${input.reason}`);
          removeBinding(input.session, input.binding.backendId);
        }
      }
    );

    assert.equal(result.status, "completed");
    assert.equal(bindingPresentAtRetirement, true);
    assert.deepEqual(order, ["prepare:resume", "retire:resume-failed", "run"]);
  }

  {
    const order: string[] = [];
    const session = makeSession();
    const adapter = new LifecycleAdapter("opencode", "emulated", order);
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-resume-unsupported", "chat", "chat.generic"),
      undefined,
      {
        sessionProvider: () => session,
        beforeBindingReplacement: removingHook(order, "resume-unsupported")
      }
    );

    assert.equal(result.status, "completed");
    assert.deepEqual(order, ["retire:resume-unsupported", "run"]);
    assert.equal(adapter.prepareCalls, 0);
  }
}

async function assertCodexPreparationDoesNotMutateConversationBinding(): Promise<void> {
  let threadId = "codex-thread-old";
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => threadId,
    setNativeThreadId: (next) => {
      threadId = next;
    },
    buildInput: () => [],
    resumeThread: async () => {
      throw new Error("thread missing");
    },
    startThread: async () => ({ threadId: "unused", title: "unused" }),
    startTurn: async () => "unused"
  });
  const binding = makeBinding("codex-cli");
  const resume = await adapter.prepareNativeSession({
    runId: "run-codex-prepare-resume",
    sessionId: "session-current",
    binding,
    action: "resume",
    reason: "incremental"
  });
  assert.equal(resume.status, "failed");
  assert.equal(
    threadId,
    "codex-thread-old",
    "resume probing must not clear the authoritative Conversation binding"
  );
  const reset = await adapter.prepareNativeSession({
    runId: "run-codex-prepare-reset",
    sessionId: "session-current",
    binding,
    action: "reset",
    reason: "expired"
  });
  assert.equal(reset.status, "reset");
  assert.equal(
    threadId,
    "codex-thread-old",
    "reset preparation must wait for durable retirement to remove the binding"
  );
}

async function assertMissingOrFailedRetirementFailsClosed(): Promise<void> {
  {
    const order: string[] = [];
    const session = makeSession();
    session.backendBindings!.opencode!.leaseExpiresAt = 50;
    const adapter = new LifecycleAdapter("opencode", "native", order);
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-retirement-missing", "chat", "chat.generic"),
      undefined,
      { sessionProvider: () => session }
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /without durable retirement/);
    assert.equal(adapter.runCalls, 0);
    assert.equal(adapter.prepareCalls, 0);
  }

  {
    const order: string[] = [];
    const session = makeSession();
    session.backendBindings!.opencode!.leaseExpiresAt = 50;
    const adapter = new LifecycleAdapter("opencode", "native", order);
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-retirement-failed", "chat", "chat.generic"),
      undefined,
      {
        sessionProvider: () => session,
        beforeBindingReplacement: async () => {
          throw new Error("retirement store unavailable");
        }
      }
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /retirement store unavailable/);
    assert.equal(adapter.runCalls, 0);
    assert.equal(adapter.prepareCalls, 0);
  }

  {
    const order: string[] = [];
    const session = makeSession();
    session.backendBindings!.opencode!.leaseExpiresAt = 50;
    const adapter = new LifecycleAdapter("opencode", "native", order);
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-retirement-not-removed", "chat", "chat.generic"),
      undefined,
      {
        sessionProvider: () => session,
        beforeBindingReplacement: async () => undefined
      }
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /did not remove/);
    assert.equal(adapter.runCalls, 0);
    assert.equal(adapter.prepareCalls, 0);
  }

  {
    const order: string[] = [];
    const session = makeSession("codex-cli");
    session.backendBindings!["codex-cli"]!.leaseExpiresAt = 50;
    const adapter = new LifecycleAdapter("codex-cli", "native", order);
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-codex-thread-not-cleared", "chat", "chat.generic", "codex-cli"),
      undefined,
      {
        sessionProvider: () => session,
        beforeBindingReplacement: async (input) => {
          delete input.session.backendBindings?.[input.binding.backendId];
        }
      }
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /legacy Codex thread/);
    assert.equal(adapter.runCalls, 0);
  }
}

async function assertMissingConversationIdentityCannotCreateBinding(): Promise<void> {
  {
    const order: string[] = [];
    const session = makeSession();
    delete session.contextId;
    delete session.backendBindings;
    const adapter = new LifecycleAdapter("opencode", "native", order);
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-conversation-identity-missing", "chat", "chat.generic"),
      undefined,
      { sessionProvider: () => session }
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /identity must be durably initialized/);
    assert.equal(result.backendBinding, undefined);
    assert.equal(adapter.runCalls, 0);
    assert.equal(adapter.prepareCalls, 0);
  }

  {
    const order: string[] = [];
    const session = makeSession();
    delete session.contextId;
    const adapter = new LifecycleAdapter("opencode", "native", order);
    let retirementCalls = 0;
    const result = await createOrchestrator(adapter).run(
      makeRequest("run-old-binding-without-conversation-identity", "chat", "chat.generic"),
      undefined,
      {
        sessionProvider: () => session,
        beforeBindingReplacement: async (input) => {
          retirementCalls += 1;
          removeBinding(input.session, input.binding.backendId);
        }
      }
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /identity must be durably initialized/);
    assert.equal(retirementCalls, 1);
    assert.equal(adapter.runCalls, 0);
    assert.equal(adapter.prepareCalls, 0);
  }
}

async function assertChatAndKnowledgeAskUseTheSameReplacementContract(): Promise<void> {
  const cases: Array<{
    surface: HarnessRunRequest["surface"];
    workflow: HarnessRunRequest["workflow"];
  }> = [
    { surface: "chat", workflow: "chat.generic" },
    { surface: "knowledge", workflow: "knowledge.ask" }
  ];
  for (const [index, testCase] of cases.entries()) {
    const order: string[] = [];
    const session = makeSession();
    session.backendBindings!.opencode!.leaseExpiresAt = 50;
    const adapter = new LifecycleAdapter("opencode", "native", order);
    const kernel = new EchoInkHarnessKernel({
      ledger: new InMemoryRunLedger(),
      memoryProvider: new NoopMemoryProvider(),
      now: () => 100
    });
    const result = await kernel.runWithAdapter({
      adapter,
      request: makeRequest(
        `run-surface-${index}`,
        testCase.surface,
        testCase.workflow
      ),
      sessionProvider: () => session,
      beforeBindingReplacement: removingHook(order, "expired")
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(order, ["retire:expired", "prepare:reset", "run"]);
  }
}

async function assertEphemeralWorkflowDoesNotReplaceConversationLease(): Promise<void> {
  const order: string[] = [];
  const session = makeSession();
  const originalBinding = session.backendBindings!.opencode!;
  const adapter = new LifecycleAdapter("opencode", "native", order);
  let retirementCalls = 0;
  const result = await createOrchestrator(adapter).run(
    makeRequest("run-maintain-ephemeral", "knowledge", "knowledge.maintain"),
    undefined,
    {
      sessionProvider: () => session,
      beforeBindingReplacement: async () => {
        retirementCalls += 1;
      }
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(retirementCalls, 0);
  assert.equal(adapter.lastNativeSessionId, undefined);
  assert.equal(result.backendBinding, undefined);
  assert.equal(session.backendBindings?.opencode, originalBinding);
  assert.deepEqual(order, ["prepare:none", "run"]);
}

async function assertPersistentWorkspaceIdentityFailsClosed(): Promise<void> {
  for (const [label, mutate] of [
    ["missing", (session: StoredSession) => { delete session.workspaceFingerprint; }],
    ["drift", (session: StoredSession) => {
      session.workspaceFingerprint = workspaceFingerprint(WORKSPACE_B);
    }]
  ] as const) {
    const order: string[] = [];
    const session = makeSession();
    delete session.backendBindings;
    mutate(session);
    const adapter = new LifecycleAdapter("opencode", "native", order);
    const result = await createOrchestrator(adapter).run(
      makeRequest(`run-workspace-${label}`, "chat", "chat.generic"),
      undefined,
      { sessionProvider: () => session }
    );

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /workspace.*durable Conversation identity/);
    assert.equal(adapter.runCalls, 0);
  }

  const workflowSession = makeSession();
  delete workflowSession.workspaceFingerprint;
  const workflowAdapter = new LifecycleAdapter("opencode", "native", []);
  const workflow = await createOrchestrator(workflowAdapter).run(
    makeRequest("run-workflow-workspace-exception", "knowledge", "knowledge.maintain"),
    undefined,
    { sessionProvider: () => workflowSession }
  );
  assert.equal(workflow.status, "completed");
  assert.equal(workflow.backendBinding, undefined);

  for (const [label, compiledFingerprint] of [
    ["missing", undefined],
    ["drift", workspaceFingerprint(WORKSPACE_B)]
  ] as const) {
    const session = makeSession();
    delete session.backendBindings;
    let reads = 0;
    Object.defineProperty(session, "workspaceFingerprint", {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1
          ? workspaceFingerprint(WORKSPACE_A)
          : compiledFingerprint;
      }
    });
    const adapter = new LifecycleAdapter("opencode", "native", []);
    const result = await createOrchestrator(adapter).run(
      makeRequest(`run-manifest-workspace-${label}`, "chat", "chat.generic"),
      undefined,
      { sessionProvider: () => session }
    );

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Compiled context manifest/);
    assert.equal(adapter.runCalls, 0);
  }
}

async function assertVaultProfileChangeRetiresBeforeReplacement(): Promise<void> {
  const oldProfile = [{
    id: "knowledge-rules",
    priority: 100,
    channel: "system" as const,
    content: "RULE-V1",
    source: "vault",
    required: true,
    sensitive: false
  }];
  const currentProfile = [{
    ...oldProfile[0],
    content: "RULE-V2"
  }];
  const session = makeSession();
  session.backendBindings!.opencode!.vaultProfileFingerprint =
    vaultProfileFingerprint(oldProfile);
  const request = makeRequest(
    "run-vault-profile-replacement",
    "knowledge",
    "knowledge.ask"
  );
  request.vaultProfileSections = currentProfile;
  const order: string[] = [];
  const adapter = new LifecycleAdapter("opencode", "native", order);
  const result = await createOrchestrator(adapter).run(
    request,
    undefined,
    {
      sessionProvider: () => session,
      beforeBindingReplacement: removingHook(
        order,
        "vault-profile-mismatch"
      )
    }
  );
  const expectedFingerprint = vaultProfileFingerprint(currentProfile);

  assert.equal(result.status, "completed");
  assert.deepEqual(order, [
    "retire:vault-profile-mismatch",
    "prepare:reset",
    "run"
  ]);
  assert.equal(
    result.contextManifest?.vaultProfileFingerprint,
    expectedFingerprint
  );
  assert.equal(
    result.backendBinding?.vaultProfileFingerprint,
    expectedFingerprint
  );
}

async function assertCodexMissingThreadRetiresAndRetriesOnce(): Promise<void> {
  const order: string[] = [];
  const session = makeSession("codex-cli");
  let setGlobalCalls = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    getNativeThreadId: () => "must-not-be-read",
    setNativeThreadId: () => { setGlobalCalls += 1; },
    buildInput: (threadId) => {
      order.push(`input:${threadId}`);
      return [];
    },
    resumeThread: async (threadId) => {
      order.push(`resume:${threadId}`);
    },
    startThread: async () => {
      order.push("start:replacement");
      return { threadId: "native-replacement", title: "Replacement" };
    },
    startTurn: async (threadId) => {
      order.push(`turn:${threadId}`);
      if (threadId === "native-old") throw new Error("thread not found: native-old");
      return "turn-replacement";
    }
  });

  const result = await createOrchestrator(adapter).run(
    makeRequest(
      "run-codex-start-turn-stale",
      "chat",
      "chat.generic",
      "codex-cli"
    ),
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async ({ native }) => {
        order.push(`register:${native.id}`);
        return { recordId: `record:${native.id}` };
      },
      beforeBindingReplacement: async (input) => {
        order.push(`retire:${input.reason}`);
        removeBinding(input.session, input.binding.backendId);
      }
    }
  );

  assert.equal(result.status, "running");
  assert.equal(result.contextManifest?.mode, "bootstrap");
  assert.equal(result.backendBinding?.nativeThreadId, "native-replacement");
  assert.deepEqual(result.nativeExecutionRecordIds, [
    "record:native-old",
    "record:native-replacement"
  ]);
  assert.equal(setGlobalCalls, 0);
  assert.deepEqual(order, [
    "resume:native-old",
    "resume:native-old",
    "register:native-old",
    "input:native-old",
    "turn:native-old",
    "retire:resume-failed",
    "start:replacement",
    "register:native-replacement",
    "input:native-replacement",
    "turn:native-replacement"
  ]);
}

async function assertCodexStaleRetryFailurePreservesBothRecords(): Promise<void> {
  const session = makeSession("codex-cli");
  const order: string[] = [];
  let starts = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    resumeThread: async () => undefined,
    startThread: async () => {
      starts += 1;
      return {
        threadId: "native-replacement-failed",
        title: "Replacement failed"
      };
    },
    buildInput: () => [],
    startTurn: async (threadId) => {
      order.push(`start-turn:${threadId}`);
      if (threadId === "native-old") {
        throw new Error("thread not found: native-old");
      }
      throw new Error("replacement start turn failed");
    }
  });
  const result = await createOrchestrator(adapter).run(
    makeRequest(
      "run-codex-stale-retry-failed",
      "chat",
      "chat.generic",
      "codex-cli"
    ),
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async ({ native }) => {
        order.push(`register:${native.id}`);
        return { recordId: `record:${native.id}` };
      },
      beforeBindingReplacement: async (input) => {
        order.push(`retire:${input.reason}`);
        removeBinding(input.session, input.binding.backendId);
      }
    }
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /replacement start turn failed/);
  assert.equal(starts, 1);
  assert.deepEqual(result.nativeExecutionRecordIds, [
    "record:native-old",
    "record:native-replacement-failed"
  ]);
  assert.deepEqual(order, [
    "register:native-old",
    "start-turn:native-old",
    "retire:resume-failed",
    "register:native-replacement-failed",
    "start-turn:native-replacement-failed"
  ]);
}

async function assertOpenCodeStaleRetryPreservesOldAndNewRecords(): Promise<void> {
  const session = makeSession("opencode");
  const order: string[] = [];
  let attempts = 0;
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: "opencode",
    displayName: "OpenCode",
    version: "test",
    capabilities: "legacy",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    runtime: {
      kind: "opencode",
      async connect() {
        return { connected: true, label: "OpenCode", errors: [] };
      },
      async listModels() { return []; },
      async hasNativeSession() { return true; },
      async runTask(input: AgentTaskInput) {
        attempts += 1;
        const nativeId = attempts === 1 ? "native-old" : "native-replacement";
        await input.onRunId?.(nativeId);
        order.push(`registered:${nativeId}`);
        if (attempts === 1) {
          throw new NativeSessionStaleError(
            "OpenCode pre-submit fallback requires retirement",
            nativeId
          );
        }
        return { text: "done", runId: nativeId };
      },
      async abort() {}
    }
  });

  const result = await createOrchestrator(adapter).run(
    makeRequest(
      "run-opencode-pre-submit-stale",
      "chat",
      "chat.generic",
      "opencode"
    ),
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async ({ native }) => ({
        recordId: `record:${native.id}`
      }),
      beforeBindingReplacement: async (input) => {
        order.push(`retire:${input.reason}`);
        removeBinding(input.session, input.binding.backendId);
      }
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.backendBinding?.nativeSessionId, "native-replacement");
  assert.deepEqual(result.nativeExecutionRecordIds, [
    "record:native-old",
    "record:native-replacement"
  ]);
  assert.deepEqual(order, [
    "registered:native-old",
    "retire:resume-failed",
    "registered:native-replacement"
  ]);
}

async function assertCodexWorkflowIsolationIsPerRun(): Promise<void> {
  const session = makeSession("codex-cli");
  const threadsByRun = new Map<string, string>();
  let nextThread = 0;
  let globalReads = 0;
  let globalWrites = 0;
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    getNativeThreadId: () => {
      globalReads += 1;
      return "chat-live-thread";
    },
    setNativeThreadId: () => { globalWrites += 1; },
    buildInput: (threadId, request) => {
      threadsByRun.set(request.runId, threadId);
      return [];
    },
    resumeThread: async () => {
      throw new Error("workflow must not resume a Conversation thread");
    },
    startThread: async () => ({
      threadId: `workflow-thread-${++nextThread}`,
      title: "Workflow"
    }),
    startTurn: async (_threadId, _input) => "workflow-turn"
  });
  const orchestrator = createOrchestrator(adapter);
  const first = makeRequest(
    "run-workflow-isolate-a",
    "knowledge",
    "knowledge.maintain",
    "codex-cli"
  );
  const second = makeRequest(
    "run-workflow-isolate-b",
    "knowledge",
    "knowledge.check",
    "codex-cli"
  );

  const results = await Promise.all([
    orchestrator.run(first, undefined, { sessionProvider: () => session }),
    orchestrator.run(second, undefined, { sessionProvider: () => session })
  ]);

  assert.deepEqual(results.map((result) => result.status), ["running", "running"]);
  assert.notEqual(
    threadsByRun.get(first.runId),
    threadsByRun.get(second.runId)
  );
  assert.equal(globalReads, 0);
  assert.equal(globalWrites, 0);
  assert.equal(session.backendBindings?.["codex-cli"]?.nativeThreadId, "native-old");
}

async function assertCodexNativeRegistrationPrecedesPrompt(): Promise<void> {
  const session = makeSession("codex-cli");
  delete session.threadId;
  delete session.backendBindings;
  const order: string[] = [];
  const adapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => {
      throw new Error("Harness-managed binding must not mutate global state");
    },
    startThread: async () => {
      order.push("start");
      return { threadId: "native-registered", title: "Registered" };
    },
    resumeThread: async () => undefined,
    buildInput: () => {
      order.push("input");
      return [];
    },
    startTurn: async () => {
      order.push("prompt");
      return "turn-registered";
    },
    archiveThread: async () => {
      order.push("archive");
    }
  });
  const request = makeRequest(
    "run-codex-registration",
    "chat",
    "chat.generic",
    "codex-cli"
  );
  const result = await createOrchestrator(adapter).run(
    request,
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async ({ native }) => {
        order.push(`register:${native.id}`);
        return { recordId: "record-codex-registration" };
      }
    }
  );

  assert.equal(result.status, "running");
  assert.deepEqual(result.nativeExecutionRecordIds, [
    "record-codex-registration"
  ]);
  assert.deepEqual(order, [
    "start",
    "register:native-registered",
    "input",
    "prompt"
  ]);

  const failedOrder: string[] = [];
  const failedAdapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    startThread: async () => {
      failedOrder.push("start");
      return { threadId: "native-registration-failed", title: "Failed" };
    },
    resumeThread: async () => undefined,
    buildInput: () => {
      failedOrder.push("input");
      return [];
    },
    startTurn: async () => {
      failedOrder.push("prompt");
      return "must-not-start";
    },
    archiveThread: async () => {
      failedOrder.push("archive");
    }
  });
  const failed = await createOrchestrator(failedAdapter).run(
    makeRequest(
      "run-codex-registration-failed",
      "chat",
      "chat.generic",
      "codex-cli"
    ),
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async () => {
        failedOrder.push("register");
        throw new Error("native store unavailable");
      }
    }
  );

  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /registration failed.*native store unavailable/i);
  assert.deepEqual(failedOrder, ["start", "register", "archive"]);

  const startFailureOrder: string[] = [];
  const startFailureAdapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    startThread: async () => ({
      threadId: "native-start-failed",
      title: "Start failed"
    }),
    resumeThread: async () => undefined,
    buildInput: () => [],
    startTurn: async () => {
      startFailureOrder.push("start-turn");
      throw new Error("start turn transport failed");
    }
  });
  const startFailure = await createOrchestrator(startFailureAdapter).run(
    makeRequest(
      "run-codex-start-turn-failed",
      "chat",
      "chat.generic",
      "codex-cli"
    ),
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async ({ native }) => {
        startFailureOrder.push(`register:${native.id}`);
        return { recordId: "record-start-turn-failed" };
      }
    }
  );

  assert.equal(startFailure.status, "failed");
  assert.match(startFailure.error ?? "", /start turn transport failed/);
  assert.deepEqual(
    startFailure.nativeExecutionRecordIds,
    ["record-start-turn-failed"]
  );
  assert.deepEqual(startFailureOrder, [
    "register:native-start-failed",
    "start-turn"
  ]);

  const fenceFailureOrder: string[] = [];
  const fenceFailureAdapter = new CodexRichAgentAdapter({
    displayName: "Codex",
    version: "test",
    nativeRefContext: {
      deviceKey: "device",
      vaultId: "/vault"
    },
    turnOptions: {
      cwd: "/vault",
      model: "test",
      reasoning: "medium",
      serviceTier: "standard",
      permission: "workspace-write",
      mode: "agent",
      mcpEnabled: false,
      writableRoots: ["/vault"]
    },
    requireExactWriteFence: true,
    exactWriteFence: {
      attemptToken: "attempt-registration-fence",
      leaseToken: "lease-registration-fence",
      deniedLivePaths: ["/live"],
      deniedControlPaths: ["/control"]
    },
    onExactWriteFenceConfigured: async () => {
      fenceFailureOrder.push("fence");
      throw new Error("fence receipt store failed");
    },
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    startThread: async () => ({
      threadId: "native-fence-failed",
      title: "Fence failed"
    }),
    resumeThread: async () => undefined,
    buildInput: () => {
      fenceFailureOrder.push("input");
      return [];
    },
    startTurn: async () => {
      fenceFailureOrder.push("start-turn");
      return "must-not-start";
    }
  });
  const fenceFailureRequest = makeRequest(
    "run-codex-fence-failed",
    "chat",
    "chat.generic",
    "codex-cli"
  );
  fenceFailureRequest.permissions.writableRoots = ["/vault/wiki"];
  const fenceFailure = await createOrchestrator(fenceFailureAdapter).run(
    fenceFailureRequest,
    undefined,
    {
      sessionProvider: () => session,
      registerNativeExecution: async ({ native }) => {
        fenceFailureOrder.push(`register:${native.id}`);
        return { recordId: "record-fence-failed" };
      }
    }
  );

  assert.equal(fenceFailure.status, "failed");
  assert.match(fenceFailure.error ?? "", /fence receipt store failed/);
  assert.deepEqual(
    fenceFailure.nativeExecutionRecordIds,
    ["record-fence-failed"]
  );
  assert.deepEqual(fenceFailureOrder, [
    "register:native-fence-failed",
    "fence"
  ]);
}

async function assertNativeExecutionRecordIdsSurviveSynchronousTerminals(): Promise<void> {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const session = makeSession();
    delete session.backendBindings;
    const adapter = new SynchronousTerminalAdapter(status);
    const result = await createOrchestrator(adapter).run(
      makeRequest(
        `run-sync-${status}`,
        "chat",
        "chat.generic"
      ),
      undefined,
      {
        sessionProvider: () => session,
        registerNativeExecution: async ({ native }) => ({
          recordId: `record:${native.id}`
        })
      }
    );

    assert.equal(result.status, status);
    assert.deepEqual(
      result.nativeExecutionRecordIds,
      [`record:sync-native-${status}`]
    );
  }
}

async function assertLeaseAnchorBeforeCurrentContextForcesRetirement(): Promise<void> {
  const order: string[] = [];
  const session = makeSession();
  session.contextStartsAfterMessageId = "m2";
  session.messages = [
    { id: "m1", role: "user", text: "old", backendId: "opencode", createdAt: 1 },
    { id: "m2", role: "assistant", text: "old answer", backendId: "hermes", createdAt: 2 },
    { id: "m3", role: "user", text: "current", backendId: "opencode", createdAt: 3 },
    { id: "m4", role: "assistant", text: "current answer", backendId: "opencode", createdAt: 4 }
  ];
  const binding = session.backendBindings!.opencode!;
  binding.syncedThroughMessageId = "m1";
  binding.contextCursor = {
    ...binding.contextCursor!,
    syncedThroughMessageId: "m1"
  };
  const adapter = new LifecycleAdapter("opencode", "native", order);
  const result = await createOrchestrator(adapter).run(
    makeRequest("run-current-context-only", "chat", "chat.generic"),
    undefined,
    {
      sessionProvider: () => session,
      beforeBindingReplacement: removingHook(order, "context-identity-mismatch")
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.contextManifest?.mode, "bootstrap");
  assert.equal(result.contextManifest?.compiledThroughMessageId, "m4");
  assert.deepEqual(order, [
    "retire:context-identity-mismatch",
    "prepare:reset",
    "run"
  ]);
}

async function assertLeaseCleanupOnlySchedulesDurableRetirement(): Promise<void> {
  const manager = new NativeSessionLeaseManager({
    limits: {
      maxActiveLeasesPerSession: 4,
      maxActiveLeasesPerBackend: 1,
      gracePeriodMs: 0
    }
  });
  let directDisposeCalls = 0;
  const missingCallbackSessions = [
    makeLeaseSession("session-new", "lease-new", 900),
    makeLeaseSession("session-old", "lease-old", 100)
  ];
  const missingCallback = await manager.cleanupSessions({
    sessions: missingCallbackSessions,
    now: 1_000,
    dispose: async () => {
      directDisposeCalls += 1;
      return { outcome: "disposed", applied: "delete" };
    }
  });
  assert.equal(missingCallback[0]?.outcome, "local-commit-failed");
  assert.match(missingCallback[0]?.message ?? "", /retirement callback is required/);
  assert.equal(directDisposeCalls, 0);
  assert.ok(missingCallbackSessions[1]?.backendBindings?.opencode);

  const retiredSessions = [
    makeLeaseSession("session-new", "lease-new", 900),
    makeLeaseSession("session-old", "lease-old", 100)
  ];
  const order: string[] = [];
  const retired = await manager.cleanupSessions({
    sessions: retiredSessions,
    now: 1_000,
    retire: async ({ session, binding, reason }) => {
      order.push(`durable:${reason}`);
      removeBinding(session, binding.backendId);
    },
    dispose: async () => {
      directDisposeCalls += 1;
      return { outcome: "disposed", applied: "delete" };
    }
  });
  assert.deepEqual(order, ["durable:backend-capacity"]);
  assert.equal(retired[0]?.outcome, "retirement-scheduled");
  assert.equal(directDisposeCalls, 0);
  assert.equal(retiredSessions[1]?.backendBindings?.opencode, undefined);

  const crashSessions = [
    makeLeaseSession("session-new", "lease-new", 900),
    makeLeaseSession("session-old", "lease-old", 100)
  ];
  const crash = await manager.cleanupSessions({
    sessions: crashSessions,
    now: 1_000,
    retire: async () => {
      throw new Error("crash before Conversation CAS");
    },
    dispose: async () => {
      directDisposeCalls += 1;
      return { outcome: "disposed", applied: "delete" };
    }
  });
  assert.equal(crash[0]?.outcome, "local-commit-failed");
  assert.match(crash[0]?.message ?? "", /crash before Conversation CAS/);
  assert.ok(crashSessions[1]?.backendBindings?.opencode);
  assert.equal(directDisposeCalls, 0);
}

function createOrchestrator(adapter: AgentAdapter): RunOrchestrator {
  return new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: () => 100
  });
}

function removingHook(
  order: string[],
  expectedReason: string
): BeforeBindingReplacement {
  return async (input) => {
    assert.equal(input.reason, expectedReason);
    assert.equal(
      input.expectedIdentity.workspaceFingerprint,
      workspaceFingerprint(WORKSPACE_A)
    );
    assert.equal(input.expectedIdentity.sessionGeneration, 3);
    assert.equal(input.expectedIdentity.contextId, "context-current");
    order.push(`retire:${input.reason}`);
    removeBinding(input.session, input.binding.backendId);
  };
}

function removeBinding(session: StoredSession, backendId: string): void {
  if (session.backendBindings) {
    delete session.backendBindings[backendId];
    if (!Object.keys(session.backendBindings).length) {
      delete session.backendBindings;
    }
  }
  if (backendId === "codex-cli") delete session.threadId;
}

function makeSession(backendId = "opencode"): StoredSession {
  const binding = makeBinding(backendId);
  return {
    id: "session-current",
    title: "Current",
    cwd: WORKSPACE_A.cwd,
    revision: 3,
    generation: 3,
    contextId: "context-current",
    commitId: "commit-current",
    workspaceFingerprint: workspaceFingerprint(WORKSPACE_A),
    ...(backendId === "codex-cli" ? { threadId: "native-old" } : {}),
    backendBindings: { [backendId]: binding },
    messages: [
      { id: "m1", role: "user", text: "goal", backendId, createdAt: 1 },
      { id: "m2", role: "assistant", text: "state", backendId, createdAt: 2 }
    ],
    createdAt: 1,
    updatedAt: 2
  };
}

function makeBinding(backendId: string): BackendSessionBinding {
  return {
    backendId,
    nativeSessionId: "native-old",
    ...(backendId === "codex-cli" ? { nativeThreadId: "native-old" } : {}),
    nativeExecutionKind: backendId === "codex-cli" ? "thread" : "session",
    leaseId: "lease-old",
    leaseStatus: "active",
    leaseCreatedAt: 1,
    leaseLastUsedAt: 90,
    leaseExpiresAt: 10_000,
    leaseTurnCount: 1,
    leaseMaxTurns: 20,
    leaseContextChars: 100,
    leaseMaxContextChars: 10_000,
    syncedThroughMessageId: "m2",
    syncedSessionRevision: 3,
    contextCursor: {
      syncedThroughMessageId: "m2",
      syncedSessionRevision: 3,
      sessionGeneration: 3,
      contextId: "context-current",
      workspaceFingerprint: workspaceFingerprint(WORKSPACE_A)
    },
    workspaceFingerprint: workspaceFingerprint(WORKSPACE_A),
    lastUsedAt: 90
  };
}

function makeLeaseSession(
  sessionId: string,
  leaseId: string,
  lastUsedAt: number
): StoredSession {
  const binding = makeBinding("opencode");
  binding.leaseId = leaseId;
  binding.leaseLastUsedAt = lastUsedAt;
  binding.lastUsedAt = lastUsedAt;
  return {
    ...makeSession(),
    id: sessionId,
    backendBindings: { opencode: binding }
  };
}

function makeRequest(
  runId: string,
  surface: HarnessRunRequest["surface"],
  workflow: HarnessRunRequest["workflow"],
  backendId = "opencode"
): HarnessRunRequest {
  return {
    runId,
    sessionId: "session-current",
    surface,
    workflow,
    backendId,
    workspace: WORKSPACE_A,
    input: { text: "continue", attachments: [] },
    permissions: {
      mode: "workspace-write",
      writableRoots: ["/vault"],
      requireApproval: true
    },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  };
}

class LifecycleAdapter implements AgentAdapter {
  readonly manifest;
  runCalls = 0;
  prepareCalls = 0;
  lastNativeSessionId: string | undefined;

  constructor(
    backendId: string,
    resume: "native" | "emulated",
    private readonly order: string[],
    private readonly preparation?: AgentNativeSessionPreparationResult
  ) {
    const capabilities = noCapabilities();
    capabilities.sessions.resume = resume;
    this.manifest = {
      id: backendId,
      displayName: backendId,
      version: "test",
      capabilities
    };
  }

  async connect() {
    return {
      connected: true,
      label: this.manifest.displayName,
      errors: []
    };
  }

  async dispose(): Promise<void> {}

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return [];
  }

  async prepareNativeSession(
    request: AgentNativeSessionPreparationRequest
  ): Promise<AgentNativeSessionPreparationResult> {
    this.prepareCalls += 1;
    this.order.push(`prepare:${request.action}`);
    if (request.action === "resume") {
      return this.preparation ?? {
        status: "resumed",
        nativeExecutionId: request.binding?.nativeSessionId
      };
    }
    if (request.action === "reset") {
      return { status: "reset", nativeExecutionId: request.binding?.nativeSessionId };
    }
    return { status: "not-applicable" };
  }

  async run(
    request: AgentRunRequest,
    _emit: HarnessEventSink
  ): Promise<AgentRunResult> {
    this.runCalls += 1;
    this.lastNativeSessionId = request.nativeSessionId;
    this.order.push("run");
    return {
      status: "completed",
      outputText: "done",
      nativeSessionId: `${this.manifest.id}-native-new`
    };
  }

  async cancel(): Promise<void> {}
}

class SynchronousTerminalAdapter implements AgentAdapter {
  readonly manifest;

  constructor(
    private readonly status: "completed" | "failed" | "cancelled"
  ) {
    this.manifest = {
      id: "opencode",
      displayName: "OpenCode",
      version: "test",
      capabilities: noCapabilities()
    };
  }

  async connect() {
    return {
      connected: true,
      label: "OpenCode",
      errors: []
    };
  }

  async dispose(): Promise<void> {}

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return [];
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const nativeExecution = {
      backendId: "opencode",
      id: `sync-native-${this.status}`,
      kind: "session" as const,
      persistence: "provider-persistent" as const,
      deviceKey: "device",
      vaultId: "/vault",
      createdAt: 1
    };
    await request.registerNativeExecution?.(nativeExecution);
    if (this.status === "completed") {
      return {
        status: "completed",
        outputText: "done",
        nativeExecution,
        nativeSessionId: nativeExecution.id
      };
    }
    return {
      status: this.status,
      error: this.status,
      nativeExecution,
      nativeSessionId: nativeExecution.id
    };
  }

  async cancel(): Promise<void> {}
}
