import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { HarnessEvent } from "../../harness/contracts/event";
import type { HarnessRunRequest } from "../../harness/contracts/run";
import type { ContextBundle, ContextSection } from "../../harness/contracts/context";
import { CAPABILITY_LEVELS } from "../../harness/contracts/capability";
import type { NativeExecutionRef } from "../../harness/contracts/native-execution";
import { getAgentBackendDefinition } from "../../agent/registry";
import { legacyCapabilitySnapshotFromDefinition } from "../../harness/agents/legacy-capabilities";
import { RunOrchestrator } from "../../harness/kernel/run-orchestrator";
import { FileRunLedger, InMemoryRunLedger } from "../../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../../harness/memory/noop-provider";
import type { MemoryProvider, MemoryRetrievalRequest } from "../../harness/memory/provider";
import { FakeAgentAdapter } from "../../harness/agents/adapters/fake";
import type { AgentRunRequest } from "../../harness/agents/adapter";
import type { StoredSession } from "../../settings/settings";

export async function runHarnessV2ContractTests(): Promise<void> {
  await assertArchitectureDecisionRecords();
  await assertNoopMemoryProviderContract();
  await assertFakeAdapterGenericChatRun();
  await assertNativeExecutionContractEventsAndBinding();
  await assertOrchestratorPassesCompiledContextToAdapter();
  await assertOrchestratorUsesLeaseDecisionForContextMode();
  await assertOrchestratorUsesCatchUpForOtherBackendMessages();
  await assertChatRunBootstrapsAndRecordsLeaseOnBackendSwitch();
  await assertOrchestratorPassesSelectedVaultSkillToAdapter();
  await assertFileRunLedgerPersistsJsonlEvents();
  assertCapabilityContractUsesLevels();
  assertLegacyBackendCapabilitySnapshots();
}

async function assertArchitectureDecisionRecords(): Promise<void> {
  const docs = [
    ["0001-echoink-is-harness.md", "Agent 是 Adapter"],
    ["0002-dual-resource-layers.md", "EchoInk Resource Plane"],
    ["0003-core-policy-and-vault-profile.md", "Core Policy"],
    ["0004-memory-authority.md", "MemoryProvider"]
  ] as const;

  for (const [file, expected] of docs) {
    const text = await readFile(path.join(process.cwd(), "docs", "implementation", "adrs", file), "utf8");
    assert.match(text, new RegExp(expected), `${file} should document ${expected}`);
  }
}

async function assertNoopMemoryProviderContract(): Promise<void> {
  const provider = new NoopMemoryProvider();
  const bundle = await provider.retrieve({
    runId: "run-memory",
    sessionId: "session-1",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    query: "当前任务状态",
    maxItems: 5
  });

  assert.deepEqual(bundle.items, []);
  assert.deepEqual(bundle.sections, []);
  assert.equal(bundle.providerId, "noop");

  const candidates = await provider.propose({
    runId: "run-memory",
    sessionId: "session-1",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    transcript: "用户：测试\n助手：完成"
  });
  assert.deepEqual(candidates, []);

  const commit = await provider.commit([]);
  assert.deepEqual(commit, { committed: [], skipped: [] });
}

async function assertFakeAdapterGenericChatRun(): Promise<void> {
  const ledger = new InMemoryRunLedger();
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    nativeSessionId: "fake-session-1"
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(1000)
  });

  const events: HarnessEvent[] = [];
  const result = await orchestrator.run(genericChatRequest(), (event) => {
    events.push(event);
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "pong");
  assert.equal(result.backendBinding?.nativeSessionId, "fake-session-1");
  assert.deepEqual(events.map((event) => event.type), [
    "run.created",
    "run.started",
    "agent.connecting",
    "agent.connected",
    "agent.message.delta",
    "agent.message.completed",
    "agent.native_lease.created",
    "run.completed"
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(events.every((event) => event.runId === "run-chat"), true);
  assert.deepEqual((await ledger.readRun("run-chat")).map((event) => event.type), events.map((event) => event.type));
}

async function assertNativeExecutionContractEventsAndBinding(): Promise<void> {
  const nativeExecution: NativeExecutionRef = {
    backendId: "fake",
    id: "fake-native-session",
    kind: "session",
    persistence: "provider-persistent",
    deviceKey: "device-1",
    vaultId: "vault-1",
    createdAt: 1
  };
  const ledger = new InMemoryRunLedger();
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    nativeExecution
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: async () => ({
      id: "session-chat",
      title: "Native lease test",
      cwd: "/vault",
      revision: 3,
      contextSnapshot: {
        sessionId: "session-chat",
        version: "snapshot-native-1",
        goal: "验证 Native Lease",
        currentState: "合同测试",
        decisions: [],
        constraints: [],
        openLoops: [],
        keyReferences: [],
        rollingSummary: "Native lease 测试摘要。",
        sourceMessageCount: 2,
        createdAt: 1,
        updatedAt: 2
      },
      messages: [
        { id: "m1", role: "user", text: "hello", createdAt: 1 },
        { id: "m2", role: "assistant", text: "world", createdAt: 2 }
      ],
      createdAt: 1,
      updatedAt: 2
    }),
    now: fixedClock(4000)
  });

  const events: HarnessEvent[] = [];
  const result = await orchestrator.run(genericChatRequest(), (event) => {
    events.push(event);
  });

  assert.equal(result.status, "completed");
  assert.equal((result as any).nativeExecution?.id, "fake-native-session");
  assert.equal(result.backendBinding?.nativeSessionId, "fake-native-session");
  assert.equal(result.backendBinding?.nativeExecutionKind, "session");
  assert.equal((result.backendBinding as any)?.leaseTurnCount, 1);
  assert.equal((result.backendBinding as any)?.leaseMaxTurns, 20);
  assert.ok(((result.backendBinding as any)?.leaseExpiresAt ?? 0) > 4000);
  assert.ok(((result.backendBinding as any)?.leaseContextChars ?? 0) > 0);
  assert.equal(result.backendBinding?.syncedThroughMessageId, "m2");
  assert.equal(result.backendBinding?.syncedSessionRevision, 3);
  assert.equal(result.backendBinding?.snapshotVersion, "snapshot-native-1");
  assert.equal(result.backendBinding?.contextCursor?.syncedSessionRevision, 3);
  assert.equal(result.backendBinding?.contextCursor?.snapshotVersion, "snapshot-native-1");
  assert.ok(events.some((event) => event.type === "agent.native_execution.created"));
  assert.deepEqual(events.find((event) => event.type === "agent.native_execution.created")?.data, {
    kind: "session",
    persistence: "provider-persistent"
  });
}

async function assertOrchestratorPassesCompiledContextToAdapter(): Promise<void> {
  let capturedContext: ContextBundle | null = null;
  const events: HarnessEvent[] = [];
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    resumeCapability: "native",
    onRun: (request: AgentRunRequest) => {
      capturedContext = request.context;
    }
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new StaticMemoryProvider(),
    sessionProvider: async () => ({
      id: "session-chat",
      title: "跨 Agent 会话",
      cwd: "/vault",
      messages: [
        { id: "m1", role: "user", text: "第一轮整理 raw/a.md", createdAt: 1 },
        { id: "m2", role: "assistant", text: "已写入 wiki/a.md", createdAt: 2 }
      ],
      rollingSummary: { text: "此前已经完成 raw/a.md 的整理。", updatedAt: 3 },
      createdAt: 1,
      updatedAt: 3
    } satisfies StoredSession),
    corePolicySections: [{
      id: "core-policy:test",
      priority: 10_000,
      channel: "system",
      content: "Core Policy 不能被用户 Profile 覆盖。",
      source: "test",
      required: true,
      sensitive: false
    }],
    now: fixedClock(2000)
  });

  const result = await orchestrator.run(genericChatRequest(), (event) => events.push(event));

  assert.equal(result.status, "completed");
  assert.ok(capturedContext, "adapter should receive compiled context");
  assert.match(sectionText(capturedContext!.corePolicy), /Core Policy/);
  assert.match(sectionText(capturedContext!.sessionContext), /raw\/a\.md/);
  assert.match(sectionText(capturedContext!.memoryContext), /用户偏好使用中文/);
  assert.match(sectionText(capturedContext!.turnInstruction), /ping/);
  const compiledEvent = events.find((event) => event.type === "session.context.bootstrap.compiled");
  assert.equal(compiledEvent?.data?.mode, "bootstrap");
  assert.equal(compiledEvent?.data?.memorySectionCount, 1);
  assert.deepEqual(
    (compiledEvent?.data?.sections as Array<{ id: string }>).filter((section) => section.id.startsWith("memory:")).length,
    1
  );
}

async function assertOrchestratorUsesLeaseDecisionForContextMode(): Promise<void> {
  const session = leasedSession();
  const capturedModes: Array<string | undefined> = [];
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    resumeCapability: "native",
    onRun: (request: AgentRunRequest) => {
      capturedModes.push(request.context.manifest?.mode);
    }
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: async () => session,
    now: fixedClock(5000)
  });

  const chatRequest = genericChatRequest();
  chatRequest.runId = "run-chat-lease";
  chatRequest.sessionId = session.id;
  chatRequest.input.text = "只同步这一轮";
  await orchestrator.run(chatRequest);
  assert.equal(capturedModes.at(-1), "incremental", "chat.generic should reuse incremental context when the same backend lease is still active");

  const askRequest = genericChatRequest();
  askRequest.runId = "run-knowledge-ask-lease";
  askRequest.sessionId = session.id;
  askRequest.surface = "knowledge";
  askRequest.workflow = "knowledge.ask";
  askRequest.input.text = "/ask 继续刚才的问题";
  await orchestrator.run(askRequest);
  assert.equal(capturedModes.at(-1), "incremental", "knowledge.ask should reuse leased-conversation context instead of bootstrapping every turn");

  const maintainRequest = genericChatRequest();
  maintainRequest.runId = "run-knowledge-maintain-workflow";
  maintainRequest.sessionId = session.id;
  maintainRequest.surface = "knowledge";
  maintainRequest.workflow = "knowledge.maintain";
  maintainRequest.input.text = "/maintain";
  await orchestrator.run(maintainRequest);
  assert.equal(capturedModes.at(-1), "workflow", "structured knowledge workflows should stay on workflow mode");
}

async function assertOrchestratorUsesCatchUpForOtherBackendMessages(): Promise<void> {
  const session = leasedSession();
  session.messages = [
    { id: "m1", role: "user", text: "Codex 先处理 A", backendId: "fake", createdAt: 1 },
    { id: "m2", role: "assistant", text: "A 已处理", backendId: "fake", createdAt: 2 },
    { id: "m3", role: "user", text: "Hermes 又补充 B", backendId: "hermes", createdAt: 3 },
    { id: "m4", role: "assistant", text: "B 已处理", backendId: "hermes", createdAt: 4 }
  ];
  let capturedContext: ContextBundle | null = null;
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    nativeSessionId: "fake-native-session",
    onRun: (request) => {
      capturedContext = request.context;
    }
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: async () => session,
    now: fixedClock(5050)
  });

  const request = genericChatRequest();
  request.runId = "run-chat-catch-up";
  request.sessionId = session.id;
  await orchestrator.run(request);

  assert.equal(capturedContext?.manifest?.mode, "catch-up");
  assert.match(sectionText(capturedContext?.sessionContext ?? []), /Hermes 又补充 B/);
}

async function assertChatRunBootstrapsAndRecordsLeaseOnBackendSwitch(): Promise<void> {
  const session = leasedSession();
  session.backendBindings = {
    codex: {
      backendId: "codex",
      nativeThreadId: "codex-thread-1",
      nativeExecutionKind: "thread",
      leaseId: "lease-codex",
      syncedThroughMessageId: "m2",
      syncedSessionRevision: 2,
      contextCursor: {
        syncedThroughMessageId: "m2",
        syncedSessionRevision: 2
      },
      lastUsedAt: 90
    }
  };

  let capturedContext: ContextBundle | null = null;
  const adapter = new FakeAgentAdapter({
    backendId: "fake",
    responseText: "pong",
    nativeExecution: {
      backendId: "fake",
      id: "fake-native-thread-2",
      kind: "thread",
      persistence: "provider-persistent",
      deviceKey: "device-1",
      vaultId: "vault-1",
      createdAt: 1
    },
    onRun: (request) => {
      capturedContext = request.context;
    }
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    sessionProvider: async () => session,
    now: fixedClock(6000)
  });

  const events: HarnessEvent[] = [];
  const result = await orchestrator.run(genericChatRequest(), (event) => {
    events.push(event);
  });

  assert.equal(capturedContext?.manifest?.mode, "bootstrap", "switching to a new backend should rebuild full bootstrap context");
  assert.equal(result.backendBinding?.nativeThreadId, "fake-native-thread-2");
  assert.match(
    result.backendBinding?.leaseId ?? "",
    /^lease-/,
    "switching to a new backend should create and record a leased-conversation lease"
  );
  assert.deepEqual(events.filter((event) => event.type === "agent.native_lease.created").map((event) => event.data), [{
    mode: "bootstrap",
    leaseId: result.backendBinding?.leaseId,
    nativeExecutionKind: "thread"
  }]);
}

async function assertOrchestratorPassesSelectedVaultSkillToAdapter(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-orchestrator-skill-"));
  await createVaultSkill(vaultPath, "product-review", "产品评审", "看目标、风险和验收。");
  let capturedContext: ContextBundle | null = null;
  const orchestrator = new RunOrchestrator({
    adapters: [new FakeAgentAdapter({
      backendId: "fake",
      responseText: "pong",
      onRun: (request) => {
        capturedContext = request.context;
      }
    })],
    ledger: new InMemoryRunLedger(),
    memoryProvider: new NoopMemoryProvider(),
    now: fixedClock(3000)
  });
  const request = genericChatRequest();
  request.workspace = { vaultPath, cwd: vaultPath };
  request.resourceSelection = {
    selected: [{ plane: "echoink-vault", resourceId: "product-review" }],
    resolvedAt: 1,
    warnings: []
  };

  await orchestrator.run(request);

  assert.ok(capturedContext, "adapter should receive context");
  assert.match(sectionText(capturedContext!.echoInkSkills), /# EchoInk Skill: 产品评审/);
  assert.match(sectionText(capturedContext!.echoInkSkills), /看目标、风险和验收/);
}

async function assertFileRunLedgerPersistsJsonlEvents(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "echoink-run-ledger-"));
  const ledger = new FileRunLedger({ rootPath: root });
  await ledger.append({
    eventId: "e1",
    runId: "run-ledger",
    sequence: 1,
    createdAt: 1,
    source: "kernel",
    type: "run.created"
  });
  await ledger.append({
    eventId: "e2",
    runId: "run-ledger",
    sequence: 2,
    createdAt: 2,
    source: "kernel",
    type: "run.completed",
    text: "ok"
  });

  const reloaded = new FileRunLedger({ rootPath: root });
  const events = await reloaded.readRun("run-ledger");

  assert.deepEqual(events.map((event) => event.type), ["run.created", "run.completed"]);
  assert.equal(events[1].text, "ok");
}

function assertCapabilityContractUsesLevels(): void {
  assert.deepEqual(CAPABILITY_LEVELS, ["none", "emulated", "native"]);

  const adapter = new FakeAgentAdapter({ backendId: "fake", responseText: "pong" });
  assert.equal(adapter.manifest.capabilities.output.streaming, "emulated");
  assert.equal(adapter.manifest.capabilities.tools.nativeMcp, "none");
  assert.equal(Object.prototype.hasOwnProperty.call(adapter.manifest.capabilities, "richEvents"), false);
}

function assertLegacyBackendCapabilitySnapshots(): void {
  const codex = legacyCapabilitySnapshotFromDefinition(getAgentBackendDefinition("codex-cli"));
  const opencode = legacyCapabilitySnapshotFromDefinition(getAgentBackendDefinition("opencode"));
  const hermes = legacyCapabilitySnapshotFromDefinition(getAgentBackendDefinition("hermes"));

  assert.equal(codex.tools.nativeMcp, "native");
  assert.equal(codex.tools.structuredCalls, "none");
  assert.equal(codex.output.streaming, "emulated");

  assert.equal(opencode.tools.nativeMcp, "none");
  assert.equal(opencode.files.diffEvents, "native");
  assert.equal(opencode.output.streaming, "emulated");

  assert.equal(hermes.output.streaming, "native");
  assert.equal(hermes.tools.structuredCalls, "none");
  assert.equal(hermes.tools.nativeMcp, "none");
}

function genericChatRequest(): HarnessRunRequest {
  return {
    runId: "run-chat",
    sessionId: "session-chat",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "fake",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: {
      text: "ping",
      attachments: []
    },
    permissions: {
      mode: "read-only",
      writableRoots: [],
      requireApproval: true
    },
    resourceSelection: {
      selected: [],
      resolvedAt: 0,
      warnings: []
    },
    memoryPolicy: {
      enabled: true,
      maxItems: 5
    },
    outputContract: {
      kind: "plain-text"
    }
  };
}

function leasedSession(): StoredSession {
  return {
    id: "session-chat",
    title: "Lease session",
    cwd: "/vault",
    revision: 2,
    backendBindings: {
      fake: {
        backendId: "fake",
        nativeSessionId: "fake-native-session",
        nativeExecutionKind: "session",
        leaseId: "lease-fake",
        syncedThroughMessageId: "m2",
        syncedSessionRevision: 2,
        contextCursor: {
          syncedThroughMessageId: "m2",
          syncedSessionRevision: 2
        },
        lastUsedAt: 100
      }
    },
    messages: [
      { id: "m1", role: "user", text: "先整理 A", createdAt: 1 },
      { id: "m2", role: "assistant", text: "A 已整理", createdAt: 2 },
      { id: "m3", role: "user", text: "当前这轮继续", createdAt: 3 }
    ],
    createdAt: 1,
    updatedAt: 3
  };
}

function fixedClock(start: number): () => number {
  let current = start;
  return () => current++;
}

function sectionText(sections: ContextSection[]): string {
  return sections.map((section) => section.content).join("\n");
}

class StaticMemoryProvider implements MemoryProvider {
  async retrieve(_request: MemoryRetrievalRequest) {
    return {
      providerId: "static",
      items: [],
      sections: [{
        id: "memory:preference",
        priority: 500,
        channel: "memory" as const,
        content: "用户偏好使用中文。",
        source: "test-memory",
        required: false,
        sensitive: false
      }]
    };
  }

  async propose() {
    return [];
  }

  async commit() {
    return { committed: [], skipped: [] };
  }

  async supersede() {
    return undefined;
  }
}

async function createVaultSkill(vaultPath: string, id: string, name: string, body: string): Promise<void> {
  const skillRoot = path.join(vaultPath, ".echoink", "resources", "skills", id);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), [
    "---",
    `id: ${id}`,
    `name: ${name}`,
    "version: 1",
    "description: 测试 Skill",
    "scopes: [chat, knowledge]",
    "permissions: [vault-read]",
    "entry: instruction",
    "---",
    "",
    `# ${name}`,
    "",
    body
  ].join("\n"));
}
