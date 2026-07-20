import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import type { AgentAdapter } from "../../harness/agents/adapter";
import { normalizeSettingsData, type ChatMessage, type StoredSession } from "../../settings/settings";
import {
  advanceSessionRevision,
  sessionBackendBinding,
  updateSessionBackendBinding,
  workspaceFingerprint
} from "../../harness/kernel/session-service";
import { compileContextBundle } from "../../harness/kernel/context-compiler";
import { EchoInkHarnessKernel } from "../../harness/kernel/harness-kernel";
import { NativeSessionLeaseManager, nativeSessionLeasesFromSessions } from "../../harness/kernel/native-session-lease-manager";
import type { BackendSessionBinding } from "../../harness/contracts/run";
import type { NativeSessionLease } from "../../harness/contracts/native-execution";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { runHarnessV2ContextRotationTests } from "./context-rotation";

export async function runHarnessV2SessionContextTests(): Promise<void> {
  await runHarnessV2ContextRotationTests();
  assertLegacyThreadIdMigratesToCodexBinding();
  assertContextCursorWorkspaceFingerprintNormalizes();
  assertSessionBindingHelpersDoNotMixBackends();
  await assertSessionRevisionAdvancesWhenHistoryTruthChanges();
  assertContextCompilerInjectsRecentHistoryForBackendSwitch();
  assertContextCompilerModesAndManifest();
  assertContextCompilerHonorsHardContextBoundary();
  assertNativeSessionLeaseDecisions();
  assertNativeSessionLeaseCleanupPlanHonorsLimits();
  await assertNativeSessionLeaseCleanupExecutesAfterLocalCommit();
  await assertActiveRunReservationPreventsLeaseCleanup();
  await assertReusableLeaseIsReservedBeforeNativeResume();
  await assertCleanupRechecksReservationAfterPlanning();
}

function assertContextCompilerHonorsHardContextBoundary(): void {
  const session = baseSession({
    revision: 3,
    generation: 3,
    contextId: "context-current",
    commitId: "commit-current",
    contextStartsAfterMessageId: "m2",
    contextSnapshot: {
      sessionId: "session-1",
      contextId: "context-old",
      generation: 2,
      version: "snapshot-old",
      goal: "OLD-CONTEXT-SECRET",
      currentState: "",
      decisions: [],
      constraints: [],
      openLoops: [],
      keyReferences: [],
      rollingSummary: "OLD-CONTEXT-SECRET",
      sourceMessageCount: 2,
      createdAt: 1,
      updatedAt: 2
    },
    messages: [
      message("user", "OLD-CONTEXT-SECRET", "m1"),
      message("assistant", "old answer", "m2"),
      message("user", "CURRENT-CONTEXT-MARKER", "m3"),
      message("assistant", "current answer", "m4")
    ]
  });
  const bundle = compileContextBundle({
    runId: "run-current-context",
    session,
    backendId: "codex-cli",
    workflow: "chat.generic",
    userInput: { text: "continue", attachments: [] },
    memory: emptyMemory(),
    corePolicySections: [],
    mode: "bootstrap",
    now: 100
  });
  const text = sectionText(bundle.sessionContext);
  assert.doesNotMatch(text, /OLD-CONTEXT-SECRET/);
  assert.match(text, /CURRENT-CONTEXT-MARKER/);
  assert.equal(bundle.manifest?.compiledThroughMessageId, "m4");
  assert.equal(bundle.manifest?.contextId, "context-current");
  assert.equal(bundle.manifest?.sessionGeneration, 3);
  assert.equal(bundle.manifest?.commitId, "commit-current");

  const missingBoundary = compileContextBundle({
    runId: "run-missing-boundary",
    session: { ...session, contextStartsAfterMessageId: "missing-message" },
    backendId: "codex-cli",
    workflow: "chat.generic",
    userInput: { text: "continue", attachments: [] },
    memory: emptyMemory(),
    corePolicySections: [],
    mode: "bootstrap",
    now: 101
  });
  assert.equal(missingBoundary.sessionContext.length, 0);
  assert.equal(missingBoundary.manifest?.compiledThroughMessageId, undefined);
}

async function assertNativeSessionLeaseCleanupExecutesAfterLocalCommit(): Promise<void> {
  const manager = new NativeSessionLeaseManager({
    limits: {
      maxActiveLeasesPerSession: 4,
      maxActiveLeasesPerBackend: 1,
      gracePeriodMs: 0
    }
  });
  const sessions = [
    leaseSession("session-new", "lease-new", 900),
    leaseSession("session-old", "lease-old", 100)
  ];
  assert.equal(nativeSessionLeasesFromSessions(sessions).length, 2);
  const retired: string[] = [];
  const results = await manager.cleanupSessions({
    sessions,
    now: 1_000,
    retire: async ({ session, binding, lease }) => {
      retired.push(lease.leaseId);
      delete session.backendBindings?.[binding.backendId];
      if (binding.backendId === "codex-cli") delete session.threadId;
    }
  });

  assert.deepEqual(retired, ["lease-old"]);
  assert.equal(results[0]?.reason, "backend-capacity");
  assert.equal(results[0]?.outcome, "retirement-scheduled");
  assert.equal(sessions[0].backendBindings?.opencode?.leaseStatus, "active");
  assert.equal(sessions[1].backendBindings?.opencode, undefined);

  let retirementCalls = 0;
  const commitFailureSession = leaseSession("session-failed", "lease-expired", 100, 500);
  const failed = await manager.cleanupSessions({
    sessions: [commitFailureSession],
    now: 1_000,
    retire: async () => {
      retirementCalls += 1;
      throw new Error("conversation store failed");
    }
  });
  assert.equal(retirementCalls, 1);
  assert.equal(failed[0]?.outcome, "local-commit-failed");
  assert.equal(commitFailureSession.backendBindings?.opencode?.leaseStatus, "active");

  const [harnessSource, turnRunnerSource] = await Promise.all([
    readFile("src/plugin/harness-service.ts", "utf8"),
    readFile("src/ui/codex-view/turn-runner.ts", "utf8")
  ]);
  assert.match(harnessSource, /enforceNativeSessionLeaseLimits[\s\S]*cleanupSessions/);
  assert.match(turnRunnerSource, /afterTurnSettled[\s\S]*enforceNativeSessionLeaseLimits/);
}

async function assertActiveRunReservationPreventsLeaseCleanup(): Promise<void> {
  const manager = new NativeSessionLeaseManager({
    limits: {
      maxActiveLeasesPerSession: 4,
      maxActiveLeasesPerBackend: 4,
      gracePeriodMs: 0
    }
  });
  const session = leaseSession(
    "session-long-running",
    "lease-long-running",
    100,
    500
  );
  let retirementCalls = 0;
  const retire = async ({ session: target, binding }: {
    session: StoredSession;
    binding: BackendSessionBinding;
  }): Promise<void> => {
    retirementCalls += 1;
    delete target.backendBindings?.[binding.backendId];
  };

  manager.reserveLeaseForRun("run-long-running", "lease-long-running");
  manager.reserveLeaseForRun("run-also-running", "lease-long-running");
  const cleanupWhileRunning = manager.cleanupSessions({
    sessions: [session],
    now: 5_000,
    retire
  });
  assert.deepEqual(await cleanupWhileRunning, []);
  assert.equal(retirementCalls, 0);
  assert.equal(session.backendBindings?.opencode?.leaseId, "lease-long-running");

  manager.releaseLeaseForRun("run-long-running");
  const cleanupWhileAnotherRunOwnsLease = await manager.cleanupSessions({
    sessions: [session],
    now: 5_000,
    retire
  });
  assert.deepEqual(cleanupWhileAnotherRunOwnsLease, []);
  assert.equal(retirementCalls, 0);

  manager.releaseLeaseForRun("run-also-running");
  const cleanupAfterTerminal = await manager.cleanupSessions({
    sessions: [session],
    now: 5_000,
    retire
  });
  assert.equal(retirementCalls, 1);
  assert.equal(cleanupAfterTerminal[0]?.outcome, "retirement-scheduled");
  assert.equal(session.backendBindings?.opencode, undefined);
}

async function assertReusableLeaseIsReservedBeforeNativeResume(): Promise<void> {
  const leaseManager = new NativeSessionLeaseManager();
  const workspace = { vaultPath: "/vault", cwd: "/vault" };
  const fingerprint = workspaceFingerprint(workspace);
  const native = {
    backendId: "fake",
    id: "native-resume-race",
    kind: "session" as const,
    persistence: "provider-persistent" as const,
    deviceKey: "device-1",
    vaultId: "/vault",
    createdAt: 1
  };
  const binding: BackendSessionBinding = {
    backendId: "fake",
    nativeSessionId: native.id,
    nativeExecutionKind: native.kind,
    nativeExecutionRef: native,
    leaseId: "lease-resume-race",
    leaseStatus: "active",
    leaseCreatedAt: 1,
    leaseLastUsedAt: 100,
    leaseExpiresAt: 1_000,
    leaseTurnCount: 1,
    leaseMaxTurns: 20,
    syncedSessionRevision: 1,
    contextCursor: {
      syncedSessionRevision: 1,
      sessionGeneration: 1,
      contextId: "context-resume-race",
      workspaceFingerprint: fingerprint
    },
    workspaceFingerprint: fingerprint,
    lastUsedAt: 100
  };
  const session = baseSession({
    id: "session-resume-race",
    revision: 1,
    generation: 1,
    contextId: "context-resume-race",
    commitId: "commit-resume-race",
    workspaceFingerprint: fingerprint,
    backendBindings: { fake: binding }
  });
  const resumeStarted = deferred<void>();
  const releaseResume = deferred<void>();
  const adapter: AgentAdapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "done",
    nativeExecution: native,
    resumeCapability: "native"
  });
  adapter.prepareNativeSession = async (request) => {
    assert.equal(request.action, "resume");
    assert.equal(
      leaseManager.isLeaseReserved("lease-resume-race"),
      true,
      "a reusable lease must be reserved before Native resume can yield"
    );
    resumeStarted.resolve();
    await releaseResume.promise;
    return { status: "resumed", nativeExecutionId: native.id };
  };
  const kernel = new EchoInkHarnessKernel({
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    nativeSessionLeaseManager: leaseManager,
    now: () => 100
  });
  const run = kernel.runWithAdapter({
    adapter,
    sessionProvider: () => session,
    request: {
      runId: "run-resume-race",
      sessionId: session.id,
      surface: "chat",
      workflow: "chat.generic",
      backendId: "fake",
      workspace,
      input: { text: "continue", attachments: [] },
      permissions: {
        mode: "read-only",
        writableRoots: [],
        requireApproval: false
      },
      resourceSelection: {
        selected: [],
        resolvedAt: 100,
        warnings: []
      },
      memoryPolicy: { enabled: false, maxItems: 0 },
      outputContract: { kind: "plain-text" }
    }
  });

  await resumeStarted.promise;
  let retirementCalls = 0;
  const whileResuming = await leaseManager.cleanupSessions({
    sessions: [session],
    now: 5_000,
    retire: async ({ session: target, binding: targetBinding }) => {
      retirementCalls += 1;
      delete target.backendBindings?.[targetBinding.backendId];
    }
  });
  assert.deepEqual(whileResuming, []);
  assert.equal(retirementCalls, 0);
  assert.equal(session.backendBindings?.fake?.leaseId, "lease-resume-race");

  releaseResume.resolve();
  assert.equal((await run).status, "completed");
  const afterTerminal = await leaseManager.cleanupSessions({
    sessions: [session],
    now: 5_000,
    retire: async ({ session: target, binding: targetBinding }) => {
      retirementCalls += 1;
      delete target.backendBindings?.[targetBinding.backendId];
    }
  });
  assert.equal(retirementCalls, 1);
  assert.equal(afterTerminal[0]?.outcome, "retirement-scheduled");
  assert.equal(session.backendBindings?.fake, undefined);
}

async function assertCleanupRechecksReservationAfterPlanning(): Promise<void> {
  const manager = new NativeSessionLeaseManager();
  const first = leaseSession("session-plan-first", "lease-plan-first", 100, 500);
  const second = leaseSession("session-plan-second", "lease-plan-second", 100, 500);
  const retired: string[] = [];

  const firstPass = await manager.cleanupSessions({
    sessions: [first, second],
    now: 5_000,
    retire: async ({ session, binding, lease }) => {
      retired.push(lease.leaseId);
      if (lease.leaseId === "lease-plan-first") {
        manager.reserveLeaseForRun("run-planned-second", "lease-plan-second");
      }
      delete session.backendBindings?.[binding.backendId];
    }
  });

  assert.deepEqual(retired, ["lease-plan-first"]);
  assert.deepEqual(
    firstPass.map((item) => item.leaseId),
    ["lease-plan-first"]
  );
  assert.equal(second.backendBindings?.opencode?.leaseId, "lease-plan-second");

  manager.releaseLeaseForRun("run-planned-second");
  const secondPass = await manager.cleanupSessions({
    sessions: [second],
    now: 5_000,
    retire: async ({ session, binding, lease }) => {
      retired.push(lease.leaseId);
      delete session.backendBindings?.[binding.backendId];
    }
  });
  assert.deepEqual(retired, ["lease-plan-first", "lease-plan-second"]);
  assert.equal(secondPass[0]?.outcome, "retirement-scheduled");
}

async function assertSessionRevisionAdvancesWhenHistoryTruthChanges(): Promise<void> {
  const session = baseSession({
    revision: 4,
    updatedAt: 20,
    rollingSummary: { text: "旧摘要", updatedAt: 20 },
    contextSnapshot: {
      sessionId: "session-1",
      version: "snapshot-old",
      goal: "旧目标",
      currentState: "旧状态",
      decisions: [],
      constraints: [],
      openLoops: [],
      keyReferences: [],
      rollingSummary: "旧摘要",
      sourceMessageCount: 1,
      createdAt: 10,
      updatedAt: 20
    },
    backendBindings: {
      "codex-cli": {
        backendId: "codex-cli",
        nativeThreadId: "thread-old",
        leaseId: "lease-old",
        leaseStatus: "active",
        syncedSessionRevision: 4,
        lastUsedAt: 20
      }
    }
  });

  assert.equal(advanceSessionRevision(session, 30), 5);
  assert.equal(session.contextSnapshot, undefined);
  assert.equal(session.rollingSummary, undefined);
  assert.equal(session.updatedAt, 30);
  assert.equal(session.backendBindings?.["codex-cli"]?.syncedSessionRevision, 4);

  const source = await readFile("src/ui/codex-view/session-controller.ts", "utf8");
  assert.match(
    source,
    /restoreKnowledgeBaseHistoryDate[\s\S]*reason: "history-restore"[\s\S]*candidate\.messages = messages/
  );
}

function assertLegacyThreadIdMigratesToCodexBinding(): void {
  const normalized = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "session-legacy",
      title: "旧 Codex 会话",
      cwd: "/vault",
      threadId: "codex-thread-1",
      messages: [],
      createdAt: 1,
      updatedAt: 2
    }]
  }).settings;

  const session = normalized.sessions[0];
  assert.equal(session.threadId, "codex-thread-1");
  assert.equal(session.backendBindings?.["codex-cli"]?.nativeThreadId, "codex-thread-1");
  assert.equal(session.backendBindings?.["codex-cli"]?.backendId, "codex-cli");
}

function assertContextCursorWorkspaceFingerprintNormalizes(): void {
  const fingerprint = workspaceFingerprint({
    vaultPath: "/vault",
    cwd: "/vault/workspace-a"
  });
  const normalized = normalizeSettingsData({
    settingsVersion: 29,
    sessions: [{
      id: "session-cursor-fingerprint",
      title: "Cursor fingerprint",
      cwd: "/vault/workspace-a",
      backendBindings: {
        opencode: {
          backendId: "opencode",
          nativeSessionId: "session-native",
          syncedSessionRevision: 2,
          workspaceFingerprint: fingerprint,
          contextCursor: {
            syncedThroughMessageId: "m2",
            syncedSessionRevision: 2,
            sessionGeneration: 2,
            contextId: "context-current",
            workspaceFingerprint: fingerprint
          },
          lastUsedAt: 2
        }
      },
      messages: [],
      createdAt: 1,
      updatedAt: 2
    }]
  }).settings;
  assert.equal(
    normalized.sessions[0]?.backendBindings?.opencode?.contextCursor?.workspaceFingerprint,
    fingerprint
  );
}

function assertSessionBindingHelpersDoNotMixBackends(): void {
  const session = baseSession();
  const codexBinding: BackendSessionBinding = {
    backendId: "codex-cli",
    nativeThreadId: "codex-thread-1",
    syncedSessionRevision: 1,
    lastUsedAt: 10
  };
  const hermesBinding: BackendSessionBinding = {
    backendId: "hermes",
    nativeSessionId: "hermes-session-1",
    syncedSessionRevision: 1,
    lastUsedAt: 20
  };

  updateSessionBackendBinding(session, codexBinding);
  updateSessionBackendBinding(session, hermesBinding);

  assert.equal(sessionBackendBinding(session, "codex-cli")?.nativeThreadId, "codex-thread-1");
  assert.equal(sessionBackendBinding(session, "hermes")?.nativeSessionId, "hermes-session-1");
  assert.equal(sessionBackendBinding(session, "opencode"), null);
}

function assertContextCompilerInjectsRecentHistoryForBackendSwitch(): void {
  const session = baseSession({
    messages: [
      message("user", "第一轮：请整理 raw/a.md"),
      message("assistant", "已整理到 wiki/a.md"),
      message("user", "第二轮：继续处理 raw/b.md"),
      message("assistant", "已整理到 wiki/b.md")
    ],
    rollingSummary: {
      text: "此前已经完成 raw/a.md 和 raw/b.md 的整理。",
      updatedAt: 30
    }
  });

  const bundle = compileContextBundle({
    session,
    backendId: "hermes",
    workflow: "chat.generic",
    userInput: { text: "接着说刚才的结果", attachments: [] },
    memory: {
      providerId: "noop",
      items: [],
      sections: []
    },
    corePolicySections: [{
      id: "core-policy",
      priority: 1000,
      channel: "system",
      content: "Core Policy 永远优先。",
      source: "echoink-core",
      required: true,
      sensitive: false
    }]
  });

  assert.match(bundle.corePolicy[0].content, /Core Policy/);
  assert.match(bundle.sessionContext.map((section) => section.content).join("\n"), /raw\/a\.md/);
  assert.match(bundle.sessionContext.map((section) => section.content).join("\n"), /raw\/b\.md/);
  assert.match(bundle.turnInstruction[0].content, /接着说刚才的结果/);
}

function assertContextCompilerModesAndManifest(): void {
  const session = baseSession({
    revision: 5,
    contextSnapshot: {
      sessionId: "session-1",
      version: "snapshot-1",
      goal: "整理 EchoInk Harness 2.0",
      currentState: "已经完成 Phase 1 骨架",
      decisions: ["EchoInk 是 Harness"],
      constraints: ["不能依赖 Agent 隐藏思考链"],
      openLoops: ["补 Native Lease"],
      keyReferences: ["docs/ECHOINK_HARNESS_2_OPTIMIZATION_PLAN.md"],
      rollingSummary: "m1 和 m2 已经被摘要覆盖。",
      summarizedThroughMessageId: "m2",
      sourceMessageCount: 2,
      createdAt: 10,
      updatedAt: 20
    },
    messages: [
      message("user", "旧消息 m1", "m1"),
      message("assistant", "旧回复 m2", "m2"),
      message("user", "Codex 已处理消息 m3", "m3"),
      message("assistant", "Codex 回复 m4", "m4"),
      message("user", "Hermes 新消息 m5", "m5"),
      message("assistant", "Hermes 回复 m6", "m6")
    ]
  });

  const bootstrap = compileContextBundle({
    runId: "run-bootstrap",
    session,
    backendId: "codex-cli",
    workflow: "chat.generic",
    userInput: { text: "继续", attachments: [] },
    memory: emptyMemory(),
    corePolicySections: [],
    mode: "bootstrap",
    sessionRevision: 5,
    now: 100
  });
  assert.equal(bootstrap.manifest?.mode, "bootstrap");
  assert.equal(bootstrap.manifest?.sessionRevision, 5);
  assert.equal(bootstrap.manifest?.compiledThroughMessageId, "m6");
  const bootstrapText = sectionText(bootstrap.sessionContext);
  assert.match(bootstrapText, /整理 EchoInk Harness 2\.0/);
  assert.doesNotMatch(bootstrapText, /旧消息 m1/);
  assert.match(bootstrapText, /Hermes 新消息 m5/);

  const incremental = compileContextBundle({
    runId: "run-incremental",
    session,
    backendId: "codex-cli",
    workflow: "chat.generic",
    userInput: { text: "只发增量", attachments: [] },
    memory: emptyMemory(),
    corePolicySections: [],
    mode: "incremental",
    cursor: { syncedThroughMessageId: "m4", syncedSessionRevision: 5 },
    sessionRevision: 5,
    now: 101
  });
  assert.equal(incremental.manifest?.mode, "incremental");
  assert.doesNotMatch(sectionText(incremental.sessionContext), /整理 EchoInk Harness 2\.0/);
  assert.doesNotMatch(sectionText(incremental.sessionContext), /Codex 已处理消息 m3/);
  assert.match(sectionText(incremental.sessionContext), /Hermes 新消息 m5/);

  const catchUp = compileContextBundle({
    runId: "run-catch-up",
    session,
    backendId: "codex-cli",
    workflow: "chat.generic",
    userInput: { text: "切回 Codex", attachments: [] },
    memory: emptyMemory(),
    corePolicySections: [],
    mode: "catch-up",
    cursor: { syncedThroughMessageId: "m4", syncedSessionRevision: 5 },
    sessionRevision: 5,
    now: 102
  });
  assert.equal(catchUp.manifest?.mode, "catch-up");
  assert.match(sectionText(catchUp.sessionContext), /整理 EchoInk Harness 2\.0/);
  assert.match(sectionText(catchUp.sessionContext), /Hermes 新消息 m5/);

  const currentRunId = "run-current-backend-switch";
  const withCurrentProjection: StoredSession = {
    ...session,
    messages: [
      ...session.messages,
      {
        ...message("user", "CURRENT-RUN-REQUEST", "m7"),
        runId: currentRunId
      },
      {
        ...message("assistant", "", "m8"),
        runId: currentRunId,
        status: "running"
      }
    ]
  };
  const backendSwitch = compileContextBundle({
    runId: currentRunId,
    session: withCurrentProjection,
    backendId: "hermes",
    workflow: "chat.generic",
    userInput: { text: "CURRENT-RUN-REQUEST", attachments: [] },
    memory: emptyMemory(),
    corePolicySections: [],
    mode: "catch-up",
    cursor: { syncedThroughMessageId: "m4", syncedSessionRevision: 5 },
    sessionRevision: 5,
    now: 102
  });
  assert.doesNotMatch(sectionText(backendSwitch.sessionContext), /CURRENT-RUN-REQUEST/);
  assert.match(sectionText(backendSwitch.sessionContext), /Hermes 新消息 m5/);
  assert.equal(
    sectionText([
      ...backendSwitch.sessionContext,
      ...backendSwitch.turnInstruction
    ]).match(/CURRENT-RUN-REQUEST/g)?.length,
    1,
    "the current user turn belongs only in turnInstruction"
  );
  assert.equal(
    backendSwitch.manifest?.compiledThroughMessageId,
    "m6",
    "the cursor must stay on durable history instead of the running placeholder"
  );

  const workflow = compileContextBundle({
    runId: "run-workflow",
    session,
    backendId: "hermes",
    workflow: "knowledge.maintain",
    userInput: { text: "/maintain", attachments: [] },
    memory: emptyMemory(),
    corePolicySections: [],
    mode: "workflow",
    sessionRevision: 5,
    now: 103
  });
  assert.equal(workflow.manifest?.mode, "workflow");
  assert.equal(workflow.sessionContext.length, 0);
}

function assertNativeSessionLeaseDecisions(): void {
  const manager = new NativeSessionLeaseManager();
  const expectedWorkspaceFingerprint = workspaceFingerprint({
    vaultPath: "/vault",
    cwd: "/vault/workspace-a"
  });
  const expectedContextIdentity = {
    expectedWorkspaceFingerprint,
    expectedSessionGeneration: 2,
    expectedContextId: "context-lease",
    expectedVaultProfileFingerprint: "",
    currentContextMessageIds: ["m4", "m5", "m6"]
  };
  const binding: BackendSessionBinding = {
    backendId: "codex-cli",
    nativeThreadId: "thread-1",
    leaseId: "lease-1",
    syncedThroughMessageId: "m4",
    syncedSessionRevision: 2,
    contextCursor: {
      syncedThroughMessageId: "m4",
      syncedSessionRevision: 2,
      sessionGeneration: 2,
      contextId: "context-lease",
      workspaceFingerprint: expectedWorkspaceFingerprint
    },
    workspaceFingerprint: expectedWorkspaceFingerprint,
    lastUsedAt: 100
  };
  const lease: NativeSessionLease = {
    leaseId: "lease-1",
    echoInkSessionId: "session-1",
    backendId: "codex-cli",
    native: {
      backendId: "codex-cli",
      id: "thread-1",
      kind: "thread",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1
    },
    mode: "leased-conversation",
    status: "active",
    createdAt: 1,
    lastUsedAt: 100,
    expiresAt: 1_000,
    turnCount: 2,
    maxTurns: 10
  };

  assert.deepEqual(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding: null,
    expectedVaultProfileFingerprint: "",
    currentContextMessageIds: [],
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }), {
    mode: "bootstrap",
    reusable: false,
    reason: "no-binding"
  });

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding: { ...binding, workspaceFingerprint: undefined },
    lease,
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).reason, "context-identity-missing");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    ...expectedContextIdentity,
    expectedWorkspaceFingerprint: workspaceFingerprint({
      vaultPath: "/vault",
      cwd: "/vault/workspace-b"
    }),
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).reason, "context-identity-mismatch");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    ...expectedContextIdentity,
    currentContextMessageIds: ["m5", "m6"],
    sessionRevision: 2,
    latestMessageId: "m6",
    now: 200
  }).reason, "context-identity-mismatch");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    ...expectedContextIdentity,
    currentContextMessageIds: ["m4", "m4", "m6"],
    sessionRevision: 2,
    latestMessageId: "m6",
    now: 200
  }).reason, "context-identity-mismatch");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).mode, "incremental");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m6",
    now: 200
  }).mode, "incremental");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m6",
    requiresCatchUp: true,
    now: 200
  }).mode, "catch-up");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    ...expectedContextIdentity,
    sessionRevision: 3,
    latestMessageId: "m6",
    now: 200
  }).reason, "revision-mismatch");

  assert.equal(manager.decide({
    request: { surface: "knowledge", workflow: "knowledge.ask" },
    binding,
    lease,
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).mode, "incremental");

  assert.equal(manager.decide({
    request: { surface: "knowledge", workflow: "knowledge.maintain" },
    binding,
    lease,
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m6",
    now: 200
  }).mode, "workflow");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease: { ...lease, turnCount: 10, maxTurns: 10 },
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).reason, "max-turns");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease: { ...lease, contextChars: 12_000, maxContextChars: 10_000 } as NativeSessionLease,
    ...expectedContextIdentity,
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).reason, "context-capacity");
}

function assertNativeSessionLeaseCleanupPlanHonorsLimits(): void {
  const manager = new NativeSessionLeaseManager({
    limits: {
      ttlMs: 1_000,
      maxTurns: 10,
      maxContextChars: 10_000,
      maxActiveLeasesPerSession: 2,
      maxActiveLeasesPerBackend: 2,
      gracePeriodMs: 0
    }
  });
  const leases: NativeSessionLease[] = [
    leaseRecord("lease-expired", "session-a", "codex-cli", 1, { expiresAt: 900 }),
    leaseRecord("lease-context", "session-a", "hermes", 2, { contextChars: 12_000 }),
    leaseRecord("lease-a-new", "session-a", "opencode", 900),
    leaseRecord("lease-a-mid", "session-a", "codex-cli", 800),
    leaseRecord("lease-a-old", "session-a", "hermes", 700),
    leaseRecord("lease-b-1", "session-b", "codex-cli", 600),
    leaseRecord("lease-b-2", "session-c", "codex-cli", 500)
  ];

  const cleanup = manager.planCleanup({ leases, now: 1_000 });
  assert.deepEqual(cleanup.map((item) => [item.leaseId, item.reason]), [
    ["lease-expired", "expired"],
    ["lease-context", "context-capacity"],
    ["lease-a-old", "session-capacity"],
    ["lease-b-2", "backend-capacity"]
  ]);
}

async function assertKnowledgeAskUsesLeasedConversationPolicy(): Promise<void> {
  const source = await readFile("src/knowledge-base/manager.ts", "utf8");
  assert.match(
    source,
    /mode:\s*kind === "ask" \? "leased-conversation" : "ephemeral-run"/,
    "knowledge.ask should use leased-conversation while structured commands stay ephemeral-run"
  );
  assert.match(
    source,
    /preferredDisposition:\s*kind === "ask" \? \["retain"\] : \["delete", "archive", "process-exit", "retain"\]/,
    "knowledge.ask should retain its lease instead of scheduling per-turn cleanup"
  );
}

function leaseSession(sessionId: string, leaseId: string, lastUsedAt: number, expiresAt = 2_000): StoredSession {
  return baseSession({
    id: sessionId,
    backendBindings: {
      opencode: {
        backendId: "opencode",
        nativeSessionId: `${leaseId}-native`,
        nativeExecutionKind: "session",
        nativeExecutionRef: {
          backendId: "opencode",
          id: `${leaseId}-native`,
          kind: "session",
          persistence: "provider-persistent",
          providerEndpoint: "http://127.0.0.1:4096",
          deviceKey: "device-1",
          vaultId: "vault-1",
          createdAt: 1
        },
        leaseId,
        leaseStatus: "active",
        leaseCreatedAt: 1,
        leaseLastUsedAt: lastUsedAt,
        leaseExpiresAt: expiresAt,
        leaseTurnCount: 1,
        leaseMaxTurns: 20,
        syncedSessionRevision: 1,
        lastUsedAt
      }
    }
  });
}

function leaseRecord(
  leaseId: string,
  sessionId: string,
  backendId: string,
  lastUsedAt: number,
  overrides: Partial<NativeSessionLease> = {}
): NativeSessionLease {
  return {
    leaseId,
    echoInkSessionId: sessionId,
    backendId,
    native: {
      backendId,
      id: `${leaseId}-native`,
      kind: "session",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1
    },
    mode: "leased-conversation",
    status: "active",
    createdAt: 1,
    lastUsedAt,
    expiresAt: 2_000,
    turnCount: 1,
    maxTurns: 10,
    maxContextChars: 10_000,
    ...overrides
  };
}

function baseSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    title: "测试会话",
    cwd: "/vault",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function message(role: ChatMessage["role"], text: string, id = `${role}-${text.length}-${Math.random()}`): ChatMessage {
  return {
    id,
    role,
    text,
    createdAt: 1
  };
}

function emptyMemory() {
  return {
    providerId: "noop",
    items: [],
    sections: []
  };
}

function sectionText(sections: Array<{ content: string }>): string {
  return sections.map((section) => section.content).join("\n");
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
