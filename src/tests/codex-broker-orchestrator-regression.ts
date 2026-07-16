import * as assert from "node:assert/strict";
import { createEchoInkMcpToolBridgeRuntime } from "../agent/tool-bridge";
import { CodexRichAgentAdapter } from "../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../harness/agents/adapters/codex-rich-notification-hub";
import type { HarnessEvent } from "../harness/contracts/event";
import type { HarnessRunRequest } from "../harness/contracts/run";
import { RunOrchestrator } from "../harness/kernel/run-orchestrator";
import { InMemoryRunLedger } from "../harness/ledger/run-ledger";
import { NoopMemoryProvider } from "../harness/memory/noop-provider";
import type { ChatMessage } from "../settings/settings";
import { HarnessEventProjector, applyHarnessProjectionBatch } from "../ui/codex-view/harness-event-projector";

export async function runCodexBrokerOrchestratorRegressionTests(): Promise<void> {
  await testCompletedBrokerLoopKeepsOneFinalTerminal();
  await testBrokerCallFailureEmitsOneFailedTerminal();
  await testBrokerCancellationEmitsOneCancelledTerminal();
  await testBrokerMaxLoopEmitsOneFailedTerminal();
  await testMalformedControlFenceRemainsVisible();
  await testControlFenceCompletionBarrier();
}

async function testCompletedBrokerLoopKeepsOneFinalTerminal(): Promise<void> {
  const notificationHub = new CodexRichNotificationHub();
  const ledger = new InMemoryRunLedger();
  const sinkEvents: HarnessEvent[] = [];
  const answerMessage: ChatMessage = {
    id: "answer-codex-broker-orchestrator-regression",
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "Codex 正在处理...",
    backendId: "codex-cli",
    runId: "run-codex-broker-orchestrator-regression",
    createdAt: 1
  };
  const projectedMessages: ChatMessage[] = [
    { id: "user-codex-broker-orchestrator-regression", role: "user", text: "search Harness", createdAt: 1 },
    answerMessage
  ];
  const projector = new HarnessEventProjector({
    runId: "run-codex-broker-orchestrator-regression",
    backendId: "codex-cli",
    vaultPath: "/vault",
    answerMessage
  });
  let turnCount = 0;
  let brokerCallCount = 0;
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
        brokerCallCount += 1;
        return { result: "found Harness docs" };
      }
    }),
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "search Harness", text_elements: [] }],
    startThread: async () => ({ threadId: "broker-orchestrator-thread", title: "Broker" }),
    resumeThread: async () => undefined,
    startTurn: async (threadId) => {
      turnCount += 1;
      const turnIndex = turnCount;
      const turnId = `broker-orchestrator-turn-${turnIndex}`;
      setTimeout(() => {
        const deltas = turnIndex === 1
          ? ["```echoink-", "tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```"]
          : ["Harness broker final answer"];
        for (const delta of deltas) {
          notificationHub.dispatch({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId,
              itemId: `broker-orchestrator-assistant-${turnIndex}`,
              delta
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
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: monotonicNow()
  });
  const request: HarnessRunRequest = {
    runId: "run-codex-broker-orchestrator-regression",
    sessionId: "session-codex-broker-orchestrator-regression",
    surface: "chat",
    workflow: "chat.generic",
    backendId: "codex-cli",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "search Harness", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  };

  const initial = await orchestrator.run(request, (event) => {
    sinkEvents.push(event);
    applyHarnessProjectionBatch(projectedMessages, projector.project(event), answerMessage.id);
  });
  const final = await adapter.awaitResult(request.runId);
  await delay(0);

  assert.equal(initial.status, "running");
  assert.equal(final.status, "completed");
  assert.equal(final.outputText, "Harness broker final answer");
  assert.equal(turnCount, 2);
  assert.equal(brokerCallCount, 1);

  const ledgerEvents = await ledger.readRun(request.runId);
  assert.deepEqual(
    ledgerEvents.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.requested", "tool.approval.requested", "tool.completed"]
  );
  assert.equal(
    ledgerEvents.some((event) => event.type === "agent.message.delta" && event.text === "Harness broker final answer"),
    true
  );
  assert.equal(
    ledgerEvents.some((event) => isAgentMessageEvent(event) && event.text?.includes("echoink-tool-call")),
    false,
    "the Broker control fence must never enter the UI-facing agent.message stream"
  );
  assert.equal(JSON.stringify(projectedMessages).includes("echoink-tool-call"), false);
  assert.equal(projectedMessages.at(-1)?.text, "Harness broker final answer");

  const terminalEvents = ledgerEvents.filter((event) => isTerminalEvent(event));
  assert.equal(terminalEvents.length, 1, "one logical Broker run must produce exactly one terminal event");
  assert.equal(terminalEvents[0]?.type, "run.completed");
  assert.equal(terminalEvents[0]?.text, "Harness broker final answer");
  assert.equal(
    terminalEvents[0]?.text?.includes("echoink-tool-call") ?? false,
    false,
    "the intermediate tool protocol must never settle the Harness run"
  );

  const toolCompletedIndex = ledgerEvents.findIndex((event) => event.type === "tool.completed");
  const finalAnswerIndex = ledgerEvents.findIndex((event) => event.type === "agent.message.delta" && event.text === "Harness broker final answer");
  const terminalIndex = ledgerEvents.findIndex((event) => isTerminalEvent(event));
  assert.equal(toolCompletedIndex < finalAnswerIndex && finalAnswerIndex < terminalIndex, true);
  assert.deepEqual(
    sinkEvents.map((event) => event.type),
    ledgerEvents.map((event) => event.type),
    "the UI sink must receive the same post-tool answer and final terminal recorded by the ledger"
  );
}

async function testBrokerCallFailureEmitsOneFailedTerminal(): Promise<void> {
  const scenario = await startBrokerScenario({
    runId: "run-codex-broker-call-failure",
    responseForTurn: () => toolCallFence().replace(/\n/g, "\r\n"),
    callTool: async () => {
      throw new Error("broker offline");
    }
  });

  const result = await scenario.result;
  await delay(0);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /broker offline/);
  const events = await scenario.ledger.readRun(scenario.runId);
  assertSingleTerminal(events, "run.failed", /broker offline/);
  assert.equal(events.some((event) => event.type === "tool.failed"), true);
  assertNoControlFenceMessages(events);
}

async function testBrokerCancellationEmitsOneCancelledTerminal(): Promise<void> {
  let markBridgeStarted!: () => void;
  const bridgeStarted = new Promise<void>((resolve) => {
    markBridgeStarted = resolve;
  });
  const scenario = await startBrokerScenario({
    runId: "run-codex-broker-cancelled",
    responseForTurn: () => toolCallFence(),
    callTool: async (request) => await new Promise<unknown>((_resolve, reject) => {
      markBridgeStarted();
      request.signal?.addEventListener("abort", () => reject(new Error("broker aborted")), { once: true });
    })
  });

  await bridgeStarted;
  await scenario.orchestrator.cancel(scenario.runId);
  const result = await scenario.result;
  await delay(0);
  assert.equal(result.status, "cancelled");
  const events = await scenario.ledger.readRun(scenario.runId);
  assertSingleTerminal(events, "run.cancelled", /Run cancelled/);
  assertNoControlFenceMessages(events);
}

async function testBrokerMaxLoopEmitsOneFailedTerminal(): Promise<void> {
  const scenario = await startBrokerScenario({
    runId: "run-codex-broker-max-loop",
    maxToolCalls: 1,
    responseForTurn: () => toolCallFence(),
    callTool: async () => ({ result: "first result" })
  });

  const result = await scenario.result;
  await delay(0);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /maxToolCalls=1/);
  assert.equal(scenario.turnCount(), 2);
  const events = await scenario.ledger.readRun(scenario.runId);
  assertSingleTerminal(events, "run.failed", /maxToolCalls=1/);
  assert.equal(events.some((event) => event.type === "tool.failed"), true);
  assertNoControlFenceMessages(events);
}

async function testMalformedControlFenceRemainsVisible(): Promise<void> {
  const malformed = "```echoink-tool-call\n{\"tool\":\n```";
  let brokerCalls = 0;
  const scenario = await startBrokerScenario({
    runId: "run-codex-broker-malformed-fence",
    responseForTurn: () => malformed,
    callTool: async () => {
      brokerCalls += 1;
      return "must not run";
    }
  });

  const result = await scenario.result;
  await delay(0);
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, malformed);
  assert.equal(brokerCalls, 0);
  const events = await scenario.ledger.readRun(scenario.runId);
  assert.equal(events.some((event) => isAgentMessageEvent(event) && event.text === malformed), true);
  assertSingleTerminal(events, "run.completed", /echoink-tool-call/);
}

async function testControlFenceCompletionBarrier(): Promise<void> {
  const malformed = "```echoink-tool-call\n{\"tool\":\n```";
  const surrounded = `${toolCallFence()}\nextra explanation`;
  for (const [label, visibleText] of [["malformed", malformed], ["surrounded", surrounded]] as const) {
    let brokerCalls = 0;
    const barrier = createCodexMessageCompletionBarrier(`codex-${label}-completion-barrier`);
    const scenario = await startBrokerScenario({
      runId: `run-codex-broker-${label}-completion-barrier`,
      responseForTurn: () => visibleText,
      firstTurnCompletionBarrier: barrier,
      callTool: async () => {
        brokerCalls += 1;
        return "must not run";
      }
    });

    await barrier.reached;
    const eventsAtCompletionBarrier = await scenario.ledger.readRun(scenario.runId);
    const visibleBeforeTurnCompleted = eventsAtCompletionBarrier.some((event) =>
      isAgentMessageEvent(event) && event.text === visibleText
    );
    const terminalBeforeTurnCompleted = eventsAtCompletionBarrier.some((event) => isTerminalEvent(event));
    const turnCompletedBeforeBarrierRelease = barrier.wasTurnCompletedDispatched();
    barrier.release();
    const result = await scenario.result;
    await delay(0);

    assert.equal(
      visibleBeforeTurnCompleted,
      true,
      `Codex ${label} fence must flush at agent.message.completed before turn/completed`
    );
    assert.equal(terminalBeforeTurnCompleted, false);
    assert.equal(turnCompletedBeforeBarrierRelease, false);
    assert.equal(result.status, "completed");
    assert.equal(result.outputText, visibleText);
    assert.equal(brokerCalls, 0);
  }

  let brokerCalls = 0;
  const barrier = createCodexMessageCompletionBarrier("codex-exact-completion-barrier");
  const scenario = await startBrokerScenario({
    runId: "run-codex-broker-exact-completion-barrier",
    responseForTurn: (turnIndex) => turnIndex === 1 ? toolCallFence() : "Codex final after exact control fence",
    firstTurnCompletionBarrier: barrier,
    firstTurnDeltaBeforeCompletion: toolCallFence(),
    firstTurnCompletedText: "",
    callTool: async () => {
      brokerCalls += 1;
      return { result: "found" };
    }
  });

  await barrier.reached;
  const eventsAtCompletionBarrier = await scenario.ledger.readRun(scenario.runId);
  const exactFenceVisibleBeforeTurnCompleted = eventsAtCompletionBarrier.some((event) =>
    isAgentMessageEvent(event) && event.text?.includes("echoink-tool-call")
  );
  const terminalBeforeTurnCompleted = eventsAtCompletionBarrier.some((event) => isTerminalEvent(event));
  const brokerCallsBeforeTurnCompleted = brokerCalls;
  const turnCompletedBeforeBarrierRelease = barrier.wasTurnCompletedDispatched();
  barrier.release();
  const result = await scenario.result;
  await delay(0);

  assert.equal(exactFenceVisibleBeforeTurnCompleted, false, "Codex exact control fence must stay hidden at agent.message.completed");
  assert.equal(terminalBeforeTurnCompleted, false);
  assert.equal(brokerCallsBeforeTurnCompleted, 0);
  assert.equal(turnCompletedBeforeBarrierRelease, false);
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Codex final after exact control fence");
  assert.equal(brokerCalls, 1, "Codex exact control fence must invoke the broker exactly once");
  assertNoControlFenceMessages(await scenario.ledger.readRun(scenario.runId));
}

async function startBrokerScenario(input: {
  runId: string;
  maxToolCalls?: number;
  responseForTurn(turnIndex: number): string;
  callTool(request: { signal?: AbortSignal }): Promise<unknown>;
  firstTurnCompletionBarrier?: CodexMessageCompletionBarrier;
  firstTurnDeltaBeforeCompletion?: string;
  firstTurnCompletedText?: string;
}): Promise<{
  runId: string;
  adapter: CodexRichAgentAdapter;
  orchestrator: RunOrchestrator;
  ledger: InMemoryRunLedger;
  result: Promise<Awaited<ReturnType<CodexRichAgentAdapter["awaitResult"]>>>;
  turnCount(): number;
}> {
  const notificationHub = new CodexRichNotificationHub();
  const ledger = new InMemoryRunLedger();
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
      maxToolCalls: input.maxToolCalls,
      callTool: input.callTool
    }),
    getNativeThreadId: () => undefined,
    setNativeThreadId: () => undefined,
    buildInput: () => [{ type: "text", text: "broker scenario", text_elements: [] }],
    startThread: async () => ({ threadId: `${input.runId}-thread`, title: "Broker scenario" }),
    resumeThread: async () => undefined,
    startTurn: async (threadId) => {
      turnCount += 1;
      const turnIndex = turnCount;
      const turnId = `${input.runId}-turn-${turnIndex}`;
      setTimeout(() => {
        void (async () => {
          const itemId = `${input.runId}-assistant-${turnIndex}`;
          const response = input.responseForTurn(turnIndex);
          if (turnIndex === 1 && input.firstTurnCompletionBarrier) {
            if (input.firstTurnDeltaBeforeCompletion !== undefined) {
              notificationHub.dispatch({
                method: "item/agentMessage/delta",
                params: {
                  threadId,
                  turnId,
                  itemId,
                  delta: input.firstTurnDeltaBeforeCompletion
                }
              });
            }
            const completedItemId = input.firstTurnDeltaBeforeCompletion === undefined
              ? itemId
              : `${itemId}-completed`;
            notificationHub.dispatch({
              method: "item/completed",
              params: {
                threadId,
                turnId,
                itemId: completedItemId,
                item: {
                  id: completedItemId,
                  threadId,
                  turnId,
                  type: "agentMessage",
                  text: input.firstTurnCompletedText ?? response
                }
              }
            });
            notificationHub.dispatch({
              method: "turn/plan/updated",
              params: { threadId, turnId, delta: input.firstTurnCompletionBarrier.marker }
            });
            await input.firstTurnCompletionBarrier.releasePromise;
          } else {
            notificationHub.dispatch({
              method: "item/agentMessage/delta",
              params: { threadId, turnId, itemId, delta: response }
            });
          }
          input.firstTurnCompletionBarrier?.markTurnCompletedDispatched(turnIndex);
          notificationHub.dispatch({
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "completed" } }
          });
        })();
      }, 0);
      return turnId;
    }
  });
  const orchestrator = new RunOrchestrator({
    adapters: [adapter],
    ledger,
    memoryProvider: new NoopMemoryProvider(),
    now: monotonicNow()
  });
  const initial = await orchestrator.run(harnessRequest(input.runId), (event) => {
    if (event.type === "agent.plan.updated" && event.text === input.firstTurnCompletionBarrier?.marker) {
      input.firstTurnCompletionBarrier.markReached();
    }
  });
  assert.equal(initial.status, "running");
  return {
    runId: input.runId,
    adapter,
    orchestrator,
    ledger,
    result: adapter.awaitResult(input.runId),
    turnCount: () => turnCount
  };
}

interface CodexMessageCompletionBarrier {
  marker: string;
  reached: Promise<void>;
  releasePromise: Promise<void>;
  markReached(): void;
  release(): void;
  markTurnCompletedDispatched(turnIndex: number): void;
  wasTurnCompletedDispatched(): boolean;
}

function createCodexMessageCompletionBarrier(marker: string): CodexMessageCompletionBarrier {
  let markReached!: () => void;
  let release!: () => void;
  let turnCompletedDispatched = false;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    marker,
    reached,
    releasePromise,
    markReached,
    release,
    markTurnCompletedDispatched(turnIndex) {
      if (turnIndex === 1) turnCompletedDispatched = true;
    },
    wasTurnCompletedDispatched: () => turnCompletedDispatched
  };
}

function harnessRequest(runId: string): HarnessRunRequest {
  return {
    runId,
    sessionId: `${runId}-session`,
    surface: "chat",
    workflow: "chat.generic",
    backendId: "codex-cli",
    workspace: { vaultPath: "/vault", cwd: "/vault" },
    input: { text: "broker scenario", attachments: [] },
    permissions: { mode: "read-only", writableRoots: [], requireApproval: true },
    resourceSelection: { selected: [], resolvedAt: 1, warnings: [] },
    memoryPolicy: { enabled: false, maxItems: 0 },
    outputContract: { kind: "plain-text" }
  };
}

function toolCallFence(): string {
  return "```echoink-tool-call\n{\"tool\":\"search.query\",\"arguments\":{\"q\":\"Harness\"}}\n```";
}

function assertSingleTerminal(
  events: HarnessEvent[],
  type: "run.completed" | "run.failed" | "run.cancelled",
  payload: RegExp
): void {
  const terminals = events.filter((event) => isTerminalEvent(event));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.type, type);
  assert.match(terminals[0]?.text ?? terminals[0]?.error ?? "", payload);
}

function assertNoControlFenceMessages(events: HarnessEvent[]): void {
  assert.equal(events.some((event) => isAgentMessageEvent(event) && event.text?.includes("echoink-tool-call")), false);
}

function isAgentMessageEvent(event: HarnessEvent): boolean {
  return event.type === "agent.message.delta" || event.type === "agent.message.completed";
}

function isTerminalEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
}

function monotonicNow(): () => number {
  let now = 1_000;
  return () => {
    now += 1;
    return now;
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
