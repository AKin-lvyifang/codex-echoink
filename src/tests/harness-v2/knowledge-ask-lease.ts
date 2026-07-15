import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CodexRichAgentAdapter } from "../../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../../harness/agents/adapters/codex-rich-notification-hub";
import type { AgentTaskRuntime } from "../../agent/runtime";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { HarnessRunResult } from "../../harness/contracts/run";
import { RunOrchestrator } from "../../harness/kernel/run-orchestrator";
import { InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import { runKnowledgeAgentTask } from "../../knowledge-base/agent-runner";
import { KnowledgeBaseManager } from "../../knowledge-base/manager";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../../knowledge-base/constants";
import { KNOWLEDGE_BASE_SESSION_TITLE, normalizeSettingsData, type CodexForObsidianSettings } from "../../settings/settings";

export async function runHarnessV2KnowledgeAskLeaseTests(): Promise<void> {
  await assertKnowledgeAskFollowUpPersistsAndReusesCodexLease();
  await assertKnowledgeRulesChangeStartsFreshCodexThread();
  await assertKnowledgeAgentSwitchBootstrapsFromStoredSession();
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

    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
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

    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
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
      return await orchestrator.run(input.request, input.sink, { sessionProvider: input.sessionProvider });
    }
  });

  assert.match(capturedPrompt, /KB-CODEX-271/, "switched Knowledge backend must receive prior EchoInk session context");
  assert.equal(output.harnessResult?.contextManifest?.mode, "bootstrap");
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
      }, { sessionProvider: input.sessionProvider });
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
