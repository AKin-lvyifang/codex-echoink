import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeSettingsData, type ChatMessage, type StoredSession } from "../../settings/settings";
import { advanceSessionRevision, sessionBackendBinding, updateSessionBackendBinding } from "../../harness/kernel/session-service";
import { compileContextBundle } from "../../harness/kernel/context-compiler";
import { NativeSessionLeaseManager, nativeSessionLeasesFromSessions } from "../../harness/kernel/native-session-lease-manager";
import type { BackendSessionBinding } from "../../harness/contracts/run";
import type { NativeSessionLease } from "../../harness/contracts/native-execution";

export async function runHarnessV2SessionContextTests(): Promise<void> {
  assertLegacyThreadIdMigratesToCodexBinding();
  assertSessionBindingHelpersDoNotMixBackends();
  await assertSessionRevisionAdvancesWhenHistoryTruthChanges();
  assertContextCompilerInjectsRecentHistoryForBackendSwitch();
  assertContextCompilerModesAndManifest();
  assertNativeSessionLeaseDecisions();
  assertNativeSessionLeaseCleanupPlanHonorsLimits();
  await assertNativeSessionLeaseCleanupExecutesAfterLocalCommit();
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
  let commitCalls = 0;
  const disposed: string[] = [];
  const results = await manager.cleanupSessions({
    sessions,
    now: 1_000,
    commit: async () => { commitCalls += 1; },
    dispose: async (lease) => {
      assert.equal(commitCalls, 1, "cleanup must start only after cleanup-pending is durably committed");
      disposed.push(lease.leaseId);
      return { outcome: "disposed", applied: "delete" };
    }
  });

  assert.deepEqual(disposed, ["lease-old"]);
  assert.equal(commitCalls, 2);
  assert.equal(results[0]?.reason, "backend-capacity");
  assert.equal(sessions[0].backendBindings?.opencode?.leaseStatus, "active");
  assert.equal(sessions[1].backendBindings?.opencode?.leaseStatus, "disposed");

  let cleanupCalls = 0;
  const commitFailureSession = leaseSession("session-failed", "lease-expired", 100, 500);
  const failed = await manager.cleanupSessions({
    sessions: [commitFailureSession],
    now: 1_000,
    commit: async () => { throw new Error("conversation store failed"); },
    dispose: async () => {
      cleanupCalls += 1;
      return { outcome: "disposed", applied: "delete" };
    }
  });
  assert.equal(cleanupCalls, 0);
  assert.equal(failed[0]?.outcome, "local-commit-failed");
  assert.equal(commitFailureSession.backendBindings?.opencode?.leaseStatus, "active");

  const [harnessSource, turnRunnerSource] = await Promise.all([
    readFile("src/plugin/harness-service.ts", "utf8"),
    readFile("src/ui/codex-view/turn-runner.ts", "utf8")
  ]);
  assert.match(harnessSource, /enforceNativeSessionLeaseLimits[\s\S]*cleanupSessions/);
  assert.match(turnRunnerSource, /afterTurnSettled[\s\S]*enforceNativeSessionLeaseLimits/);
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
  assert.match(source, /restoreKnowledgeBaseHistoryDate[\s\S]*advanceSessionRevision\(session\)[\s\S]*session\.messages = messages/);
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
  const binding: BackendSessionBinding = {
    backendId: "codex-cli",
    nativeThreadId: "thread-1",
    leaseId: "lease-1",
    syncedThroughMessageId: "m4",
    syncedSessionRevision: 2,
    contextCursor: {
      syncedThroughMessageId: "m4",
      syncedSessionRevision: 2
    },
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
    binding,
    lease,
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).mode, "incremental");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    sessionRevision: 2,
    latestMessageId: "m6",
    now: 200
  }).mode, "incremental");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    sessionRevision: 2,
    latestMessageId: "m6",
    requiresCatchUp: true,
    now: 200
  }).mode, "catch-up");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease,
    sessionRevision: 3,
    latestMessageId: "m6",
    now: 200
  }).reason, "revision-mismatch");

  assert.equal(manager.decide({
    request: { surface: "knowledge", workflow: "knowledge.ask" },
    binding,
    lease,
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).mode, "incremental");

  assert.equal(manager.decide({
    request: { surface: "knowledge", workflow: "knowledge.maintain" },
    binding,
    lease,
    sessionRevision: 2,
    latestMessageId: "m6",
    now: 200
  }).mode, "workflow");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease: { ...lease, turnCount: 10, maxTurns: 10 },
    sessionRevision: 2,
    latestMessageId: "m4",
    now: 200
  }).reason, "max-turns");

  assert.equal(manager.decide({
    request: { surface: "chat", workflow: "chat.generic" },
    binding,
    lease: { ...lease, contextChars: 12_000, maxContextChars: 10_000 } as NativeSessionLease,
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
