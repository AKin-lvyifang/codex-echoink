import * as assert from "node:assert/strict";
import type { AgentEvent, AgentEventSink } from "../agent/events";
import type { AgentEventTaskRuntime, AgentToolBridgeRuntime } from "../agent/runtime";
import { createEchoInkMcpToolBridgeRuntime, parseExactEchoInkToolCall, runAgentTaskWithToolBridge } from "../agent/tool-bridge";
import type { AgentBackendKind, AgentTaskInput, AgentTaskResult } from "../agent/types";
import { TaskRuntimeAgentAdapter } from "../harness/agents/adapters/task-runtime-adapter";
import type { HarnessEvent } from "../harness/contracts/event";
import type { HarnessRunRequest } from "../harness/contracts/run";
import { RunOrchestrator } from "../harness/kernel/run-orchestrator";
import { workspaceFingerprint } from "../harness/kernel/session-service";
import { InMemoryRunLedger } from "../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../harness/memory/noop-provider";
import type { ChatMessage } from "../settings/settings";
import { HarnessEventProjector } from "../ui/codex-view/harness-event-projector";

const TOOL_CALL_LF = "```echoink-tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```";
const TOOL_CALL_CRLF = TOOL_CALL_LF.replace(/\n/g, "\r\n");

export async function runToolBridgeRichEventRegressionTests(): Promise<void> {
  assert.deepEqual(parseExactEchoInkToolCall(TOOL_CALL_CRLF), {
    tool: "search.query",
    arguments: { q: "Harness" }
  });
  assert.equal(parseExactEchoInkToolCall(`${TOOL_CALL_LF}\nextra`), null);
  assert.equal(parseExactEchoInkToolCall(`${TOOL_CALL_LF}\nextra that ends like a fence\n\`\`\``), null);

  for (const backend of ["hermes", "opencode"] as const) {
    await assertRichToolControlFenceIsHiddenAndProjectedOnce(backend);
    await assertOrdinaryRichAnswerFlushesBeforeRuntimeSettlement(backend);
    await assertMalformedAndSurroundedFencesRemainVisible(backend);
    await assertPartialFenceFlushesWhenRuntimeFails(backend);
    await assertCompletedEmptyDoesNotLeakValidFenceOnRuntimeFailure(backend);
  }

  await assertBridgeFailureHasOneTerminalAndOneToolRow();
  await assertBridgeCancellationInterruptsOneToolRow();
  await assertBridgeMaxLoopHasOneTerminal();
}

async function assertRichToolControlFenceIsHiddenAndProjectedOnce(backend: AgentBackendKind): Promise<void> {
  let turn = 0;
  const controlMessageCompleted = deferredSignal();
  const allowFirstRuntimeReturn = deferredSignal();
  const runtime = richRuntime(backend, async (_input, emit) => {
    turn += 1;
    if (turn === 1) {
      await emit(agentEvent(backend, "thinking_delta", "先查询", { blockId: "reasoning-before-tool" }));
      await emitFragmentedMessage(backend, emit, TOOL_CALL_CRLF, "control-message");
      controlMessageCompleted.resolve();
      await allowFirstRuntimeReturn.promise;
      return { text: TOOL_CALL_CRLF, runId: `${backend}-native-rich` };
    }
    await emit(agentEvent(backend, "thinking_delta", "整理结果", { blockId: "reasoning-after-tool" }));
    await emit(agentEvent(backend, "message_delta", "FINAL_", { messageId: "final-message" }));
    await emit(agentEvent(backend, "message_delta", "OK", { messageId: "final-message" }));
    await emit(agentEvent(backend, "message_completed", "FINAL_OK", { messageId: "final-message", replace: true }));
    return { text: "FINAL_OK", runId: `${backend}-native-rich` };
  });
  const bridgeCalls: Array<{ toolCallId?: string; signal?: AbortSignal }> = [];
  const toolBridge = toolBridgeFor(async (request) => {
    bridgeCalls.push({ toolCallId: request.toolCallId, signal: request.signal });
    return { result: "found" };
  });
  const harness = createHarness(backend, runtime, toolBridge, `valid-${backend}`);
  const runPromise = harness.orchestrator.run(harness.request);
  await controlMessageCompleted.promise;
  const eventsBeforeRuntimeReturn = await harness.ledger.readRun(harness.request.runId);
  const controlWasVisibleBeforeRuntimeReturn = eventsBeforeRuntimeReturn.some((event) =>
    isHarnessMessageEvent(event) && event.text?.includes("echoink-tool-call")
  );
  const bridgeCallsBeforeRuntimeReturn = bridgeCalls.length;
  const terminalBeforeRuntimeReturn = eventsBeforeRuntimeReturn.some((event) => isHarnessTerminalEvent(event));
  allowFirstRuntimeReturn.resolve();

  const result = await runPromise;
  const events = await harness.ledger.readRun(harness.request.runId);

  assert.equal(controlWasVisibleBeforeRuntimeReturn, false, `${backend} exact control fence must stay hidden at message_completed`);
  assert.equal(bridgeCallsBeforeRuntimeReturn, 0, `${backend} broker call must wait for the runtime result`);
  assert.equal(terminalBeforeRuntimeReturn, false, `${backend} message_completed barrier must precede run settlement`);
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "FINAL_OK");
  assert.equal(bridgeCalls.length, 1);
  assert.ok(bridgeCalls[0]?.toolCallId);
  assertNoControlProtocolInMessageEvents(events);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.requested", "tool.approval.requested", "tool.completed"]
  );
  const toolEvents = events.filter((event) => event.type.startsWith("tool."));
  const callIds = new Set(toolEvents.map((event) => event.data?.callId ?? event.data?.toolCallId));
  assert.equal(callIds.size, 1, `${backend} broker lifecycle must retain one stable call id`);
  assertSingleTerminal(events, "run.completed");

  const snapshot = project(events, backend);
  const toolRows = snapshot.filter((message) => message.role === "tool");
  assert.equal(toolRows.length, 1, `${backend} requested/approval/completed must project to one row`);
  assert.equal(toolRows[0]?.status, "completed");
  assert.equal(toolRows[0]?.processInputAvailability, "provided");
  assert.equal(toolRows[0]?.processOutputAvailability, "provided");
  assert.equal(snapshot.at(-1)?.text, "FINAL_OK");
  assert.equal(snapshot.at(-1)?.status, "completed");
  assert.equal(JSON.stringify(snapshot).includes("echoink-tool-call"), false);
}

async function assertOrdinaryRichAnswerFlushesBeforeRuntimeSettlement(backend: AgentBackendKind): Promise<void> {
  const captured: AgentEvent[] = [];
  let observedBeforeReturn = false;
  const runtime = richRuntime(backend, async (_input, emit) => {
    await emit(agentEvent(backend, "message_delta", "普通", { messageId: "ordinary" }));
    observedBeforeReturn = captured.some((event) => event.type === "message_delta" && event.text === "普通");
    await emit(agentEvent(backend, "message_completed", "普通答案", { messageId: "ordinary", replace: true }));
    return { text: "普通答案", runId: `${backend}-ordinary` };
  });

  const result = await runAgentTaskWithToolBridge(runtime, {
    prompt: "answer",
    toolBridge: inertToolBridge()
  }, (event) => captured.push(event));

  assert.equal(result.text, "普通答案");
  assert.equal(observedBeforeReturn, true, `${backend} ordinary first delta must not wait for task settlement`);
  assert.equal(captured.some((event) => event.type === "message_completed" && event.text === "普通答案"), true);
}

async function assertMalformedAndSurroundedFencesRemainVisible(backend: AgentBackendKind): Promise<void> {
  for (const visibleText of [
    "```echoink-tool-call\r\n{\"tool\":\r\n```",
    `${TOOL_CALL_LF}\nextra explanation`
  ]) {
    const captured: AgentEvent[] = [];
    let bridgeCalls = 0;
    const messageCompleted = deferredSignal();
    const allowRuntimeReturn = deferredSignal();
    const runtime = richRuntime(backend, async (_input, emit) => {
      await emitFragmentedMessage(backend, emit, visibleText, "malformed-message");
      messageCompleted.resolve();
      await allowRuntimeReturn.promise;
      return { text: visibleText, runId: `${backend}-malformed` };
    });
    const bridge = inertToolBridge(async () => {
      bridgeCalls += 1;
      return "unexpected";
    });
    const runPromise = runAgentTaskWithToolBridge(runtime, { prompt: "answer", toolBridge: bridge }, (event) => captured.push(event));
    await messageCompleted.promise;
    const visibleAtCompletionBarrier = captured.some((event) => event.type === "message_completed" && event.text === visibleText);
    const bridgeCallsAtCompletionBarrier = bridgeCalls;
    allowRuntimeReturn.resolve();
    const result = await runPromise;

    assert.equal(
      visibleAtCompletionBarrier,
      true,
      `${backend} malformed/surrounded fence must flush at message_completed before runtime settlement`
    );
    assert.equal(bridgeCallsAtCompletionBarrier, 0);
    assert.equal(result.text, visibleText);
    assert.equal(bridgeCalls, 0, `${backend} malformed/surrounded fence must not call the broker`);
    assert.equal(captured.some((event) => event.type === "message_completed" && event.text === visibleText), true);
  }
}

async function assertPartialFenceFlushesWhenRuntimeFails(backend: AgentBackendKind): Promise<void> {
  const captured: AgentEvent[] = [];
  const runtime = richRuntime(backend, async (_input, emit) => {
    await emit(agentEvent(backend, "message_delta", "```echoink", { messageId: "partial-control" }));
    throw new Error("provider stream failed");
  });

  await assert.rejects(
    runAgentTaskWithToolBridge(runtime, { prompt: "answer", toolBridge: inertToolBridge() }, (event) => captured.push(event)),
    /provider stream failed/
  );
  assert.equal(captured.some((event) => event.type === "message_delta" && event.text === "```echoink"), true);
}

async function assertCompletedEmptyDoesNotLeakValidFenceOnRuntimeFailure(backend: AgentBackendKind): Promise<void> {
  const captured: AgentEvent[] = [];
  const runtime = richRuntime(backend, async (_input, emit) => {
    const split = Math.floor(TOOL_CALL_CRLF.length / 2);
    await emit(agentEvent(backend, "message_delta", TOOL_CALL_CRLF.slice(0, split), { messageId: "failed-control" }));
    await emit(agentEvent(backend, "message_delta", TOOL_CALL_CRLF.slice(split), { messageId: "failed-control" }));
    await emit(agentEvent(backend, "message_completed", "", { messageId: "failed-control" }));
    throw new Error("provider failed after completion signal");
  });

  await assert.rejects(
    runAgentTaskWithToolBridge(runtime, { prompt: "answer", toolBridge: inertToolBridge() }, (event) => captured.push(event)),
    /provider failed after completion signal/
  );
  assert.equal(captured.some((event) => event.type === "message_delta" || event.type === "message_completed"), false);
}

async function assertBridgeFailureHasOneTerminalAndOneToolRow(): Promise<void> {
  const backend = "hermes" as const;
  const runtime = alwaysRequestsToolRuntime(backend);
  const harness = createHarness(backend, runtime, toolBridgeFor(async () => {
    throw new Error("broker exploded");
  }), "bridge-failure");
  const result = await harness.orchestrator.run(harness.request);
  const events = await harness.ledger.readRun(harness.request.runId);

  assert.equal(result.status, "failed");
  assertSingleTerminal(events, "run.failed");
  assertNoControlProtocolInMessageEvents(events);
  const toolRows = project(events, backend).filter((message) => message.role === "tool");
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0]?.status, "failed");
}

async function assertBridgeCancellationInterruptsOneToolRow(): Promise<void> {
  const backend = "opencode" as const;
  const runtime = alwaysRequestsToolRuntime(backend);
  let markToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
  const harness = createHarness(backend, runtime, toolBridgeFor(async (request) => {
    markToolStarted();
    await waitForAbort(request.signal);
    throw new Error("broker call aborted");
  }), "bridge-cancel");

  const runPromise = harness.orchestrator.run(harness.request);
  await toolStarted;
  await harness.orchestrator.cancel(harness.request.runId);
  const result = await runPromise;
  const events = await harness.ledger.readRun(harness.request.runId);

  assert.equal(result.status, "cancelled");
  assertSingleTerminal(events, "run.cancelled");
  assertNoControlProtocolInMessageEvents(events);
  const toolRows = project(events, backend).filter((message) => message.role === "tool");
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0]?.status, "interrupted");
}

async function assertBridgeMaxLoopHasOneTerminal(): Promise<void> {
  const backend = "hermes" as const;
  let bridgeCalls = 0;
  const toolBridge = toolBridgeFor(async () => {
    bridgeCalls += 1;
    return { result: "again" };
  }, 1);
  const harness = createHarness(backend, alwaysRequestsToolRuntime(backend), toolBridge, "bridge-max-loop");
  const result = await harness.orchestrator.run(harness.request);
  const events = await harness.ledger.readRun(harness.request.runId);

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /maxToolCalls=1/);
  assert.equal(bridgeCalls, 1);
  assertSingleTerminal(events, "run.failed");
  assertNoControlProtocolInMessageEvents(events);
}

function createHarness(
  backend: AgentBackendKind,
  runtime: AgentEventTaskRuntime,
  toolBridge: AgentToolBridgeRuntime,
  suffix: string
): {
  orchestrator: RunOrchestrator;
  ledger: InMemoryRunLedger;
  request: HarnessRunRequest;
} {
  const adapter = new TaskRuntimeAgentAdapter({
    backendId: backend,
    displayName: backend,
    version: "test",
    runtime,
    capabilities: "legacy",
    legacyTaskDefaults: { toolBridge }
  });
  const ledger = new InMemoryRunLedger();
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: () => 1_000,
    sessionProvider: (sessionId) => ({
      id: sessionId,
      title: "Tool bridge regression",
      cwd: "/vault",
      revision: 1,
      generation: 1,
      contextId: `context-${sessionId}`,
      workspaceFingerprint: workspaceFingerprint({
        vaultPath: "/vault",
        cwd: "/vault"
      }),
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
  });
  return {
    orchestrator,
    ledger,
    request: {
      runId: `run-${suffix}`,
      sessionId: `session-${suffix}`,
      surface: "chat",
      workflow: "chat.generic",
      backendId: backend,
      workspace: { vaultPath: "/vault", cwd: "/vault" },
      input: { text: "search", attachments: [] },
      permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
      resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
      memoryPolicy: { enabled: false, maxItems: 0 },
      outputContract: { kind: "plain-text" }
    }
  };
}

function richRuntime(
  backend: AgentBackendKind,
  runTaskEvents: (input: AgentTaskInput, emit: AgentEventSink) => Promise<AgentTaskResult>
): AgentEventTaskRuntime {
  return {
    kind: backend,
    async connect() { return { connected: true, label: backend, errors: [] }; },
    async listModels() { return []; },
    async runTask() { throw new Error("rich regression must use runTaskEvents"); },
    runTaskEvents,
    async abort() { /* AbortSignal is the authoritative cancellation path. */ }
  };
}

function alwaysRequestsToolRuntime(backend: AgentBackendKind): AgentEventTaskRuntime {
  return richRuntime(backend, async (_input, emit) => {
    await emitFragmentedMessage(backend, emit, TOOL_CALL_CRLF, "control-message");
    return { text: TOOL_CALL_CRLF, runId: `${backend}-tool-loop` };
  });
}

function toolBridgeFor(
  callTool: Parameters<typeof createEchoInkMcpToolBridgeRuntime>[0]["callTool"],
  maxToolCalls = 3
): AgentToolBridgeRuntime {
  const bridge = createEchoInkMcpToolBridgeRuntime({
    catalog: {
      tools: [{
        name: "search.query",
        resourceId: "echoink-local:mcp-server:search",
        resourceName: "search",
        toolName: "query",
        description: "Search"
      }],
      warnings: []
    },
    scope: "chat",
    maxToolCalls,
    callTool
  });
  assert.ok(bridge);
  return bridge;
}

function inertToolBridge(callTool: AgentToolBridgeRuntime["callTool"] = async () => "unused"): AgentToolBridgeRuntime {
  return {
    enabled: true,
    scope: "chat",
    maxToolCalls: 3,
    prompt: "tool bridge enabled",
    callTool
  };
}

async function emitFragmentedMessage(
  backend: AgentBackendKind,
  emit: AgentEventSink,
  text: string,
  messageId: string
): Promise<void> {
  const splitPoints = [1, 7, 19, Math.max(20, text.length - 8), text.length];
  let offset = 0;
  for (const end of splitPoints) {
    if (end <= offset || end > text.length) continue;
    await emit(agentEvent(backend, "message_delta", text.slice(offset, end), { messageId }));
    offset = end;
  }
  if (offset < text.length) await emit(agentEvent(backend, "message_delta", text.slice(offset), { messageId }));
  await emit(agentEvent(backend, "message_completed", text, { messageId, replace: true }));
}

function agentEvent(
  backend: AgentBackendKind,
  type: AgentEvent["type"],
  text: string,
  data?: Record<string, unknown>
): AgentEvent {
  return { type, backend, createdAt: Date.now(), text, data };
}

function project(events: HarnessEvent[], backend: AgentBackendKind): ChatMessage[] {
  const projector = new HarnessEventProjector({
    runId: events[0]?.runId ?? "missing-run",
    backendId: backend,
    vaultPath: "/vault",
    answerMessage: {
      id: `answer-${backend}`,
      role: "assistant",
      itemType: "assistant",
      text: "Agent 正在处理...",
      status: "running",
      backendId: backend,
      runId: events[0]?.runId,
      createdAt: 1
    }
  });
  for (const event of events) projector.project(event);
  return projector.snapshot();
}

function assertNoControlProtocolInMessageEvents(events: HarnessEvent[]): void {
  const messageEvents = events.filter((event) => event.type === "agent.message.delta" || event.type === "agent.message.completed");
  assert.equal(JSON.stringify(messageEvents).includes("echoink-tool-call"), false);
}

function assertSingleTerminal(events: HarnessEvent[], expected: HarnessEvent["type"]): void {
  const terminals = events.filter((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.type, expected);
}

function isHarnessMessageEvent(event: HarnessEvent): boolean {
  return event.type === "agent.message.delta" || event.type === "agent.message.completed";
}

function isHarnessTerminalEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
}

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error("missing broker AbortSignal");
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
