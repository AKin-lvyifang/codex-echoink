import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { AgentEvent } from "../agent/events";
import { createAgentEventRuntimeWithFallback } from "../agent/event-task";
import { createAgentTaskRuntime } from "../agent/factory";
import { createExactWriteFenceReceipt, isTrustedExactWriteFenceReceipt } from "../agent/write-fence";
import {
  OpenCodeEventProjector,
  OpenCodeRichRuntime,
  eventBelongsToSession,
  openCodePermissionReply,
  type OpenCodeRichRuntimeBackend
} from "../agent/opencode-rich-runtime";
import type { AgentTaskRuntime } from "../agent/runtime";
import type { AgentExactWriteFenceReceipt, AgentPromptOptions, AgentSessionOptions, AgentTaskInput, AgentTaskResult } from "../agent/types";
import { openCodePermissionRules, type OpenCodeCliTaskOptions } from "../core/opencode-backend";
import { nodeFetch } from "../core/opencode-fetch";
import { runOpenCodeCommand } from "../core/opencode-process";
import { buildOpenCodeRunArgs } from "../core/opencode-run";
import type { HarnessEvent, HarnessEventType } from "../harness/contracts/event";
import { DEFAULT_SETTINGS, type ChatMessage } from "../settings/settings";
import {
  HarnessEventProjector,
  applyHarnessProjectionBatch
} from "../ui/codex-view/harness-event-projector";

const OPEN_CODE_143_FIXTURE = JSON.parse(readFileSync(
  path.join(process.cwd(), "src/tests/fixtures/opencode-1.4.3-sse-jsonl.json"),
  "utf8"
)) as {
  sessionId: string;
  sseEvents: unknown[];
  cliJsonl: unknown[];
};

export async function runOpenCodeRichRuntimeRegressionTests(): Promise<void> {
  testCapturedOpenCode143SseAndJsonlFixture();
  testProjectorPreservesReasoningToolOrderAndDataStates();
  testReasoningSnapshotReplacementCompletesWithCorrectedText();
  testProjectorTreatsFailedToolStateAsTerminal();
  testProjectorMapsProviderSideChannels();
  testCliProjectorSupportsOpenCode143ToolUse();
  testProjectorSettlesPendingToolsHonestly();
  testPermissionPoliciesAreDeterministic();
  testTypedWriteFenceReceiptIsCodeGeneratedAndDeterministic();
  await testCliFallbackIsOnlyUsedBeforeSubmission();
  await testResumedSessionRefreshesPermissionPolicy();
  await testPrePromptIdleDoesNotSettleNewTurn();
  await testPermissionRequestsAreAnsweredWithoutHanging();
  await testImmediateSessionErrorAfterSubmissionFailsWithoutPolling();
  await testCompletedRunMarksPendingToolsUnconfirmed();
  await testFailedRunInterruptsPendingTools();
  await testInterleavedAnswersDoNotReplayAggregateCompletion();
  await testPromptRequestHonorsAbortSignal();
  await testPromptRequestHonorsDeadline();
  await testStreamFailureBeforePromptResponseIsHandled();
  await testPromptFailureIsHandledBeforeSlowEventSink();
  await testResumedSessionRequiresReadablePreSubmitBaseline();
  await testSubmittedPromptRecoversSameSessionWithoutReplay();
  await testSubmittedPromptReadbackProviderErrorFailsImmediately();
  await testFinalReadbackProviderErrorOverridesIdle();
  await testLaterSuccessfulReadbackClearsOlderProviderError();
  await testSubmittedEmptyAnswerRecoversAfterStreamLoss();
  await testCompletedEmptyReadbackOverridesStreamedPartialText();
  await testStaleIdleDoesNotCompleteSubmittedRecovery();
  await testMissingStatusDoesNotTrustIncompleteAssistantText();
  await testMissingStatusWaitsPastCompletedToolStep();
  await testIdleStatusDoesNotTreatToolContinuationTextAsFinal();
  await testLatestCompletedEmptyAnswerOverridesEarlierToolText();
  await testSubmittedSdkFailureNeverStartsLifecycleFallback();
  await testPreSpawnCliFailureAllowsLifecycleFallback();
  await testExactWriteFenceDisablesCliFallbacks();
  await testHermesExactWriteFenceFailsBeforePromptSubmission();
  await testSubmittedCliFailureRecoversSameSessionWithoutLifecycleFallback();
  await testSubmittedCliFailureNeverStartsLifecycleFallback();
  await testOpenCodeCommandSubmissionBoundary();
  await testNodeFetchAcceptsNoContentResponse();
  await testNodeFetchBridgesSseBodyWithoutReadableToWeb();
}

function testCapturedOpenCode143SseAndJsonlFixture(): void {
  const sseProjector = new OpenCodeEventProjector(OPEN_CODE_143_FIXTURE.sessionId);
  const sseEvents: AgentEvent[] = [];
  const terminalTypes: string[] = [];
  for (const wireEvent of OPEN_CODE_143_FIXTURE.sseEvents) {
    const projection = sseProjector.project(wireEvent);
    sseEvents.push(...projection.events.map((event) => ({
      ...event,
      backend: "opencode" as const,
      createdAt: 1
    })));
    if (projection.terminal) terminalTypes.push(projection.terminal.type);
  }

  assert.deepEqual(
    sseEvents.filter((event) => event.type === "thinking_delta").map((event) => event.text),
    ["Inspect ", "the fixture.", "Prepare ", "the edit.", "Confirm ", "the result."],
    "the captured OpenCode 1.4.3 reasoning deltas must remain split across provider tool boundaries"
  );
  assert.deepEqual(
    sseEvents.filter((event) => event.type === "thinking_completed").map((event) => event.text),
    ["Inspect the fixture.", "Prepare the edit.", "Confirm the result."],
    "each captured provider reasoning part must complete as its own block"
  );

  const readRequested = sseEvents.find((event) => event.type === "tool_call_requested" && event.data?.callId === "call_fixture_read");
  const readRunning = sseEvents.find((event) => event.type === "tool_call_delta"
    && event.data?.callId === "call_fixture_read"
    && event.data?.toolStatus === "running");
  const readCompleted = sseEvents.find((event) => event.type === "tool_call_completed" && event.data?.callId === "call_fixture_read");
  assert.ok(readRequested && readRunning && readCompleted, "the captured read tool must project requested, running, and completed states");
  assert.equal(readRequested.status, "requested");
  assert.equal(readRequested.data?.inputState, "empty");
  assert.equal(readRequested.data?.outputState, "unavailable");
  assert.equal(readRunning.status, "running");
  assert.equal(readRunning.data?.inputState, "provided");
  assert.ok(Object.keys(fixtureRecord(readRunning.data?.input)).length > 0, "the read running state must preserve its non-empty input");
  assert.equal(readCompleted.status, "completed");
  assert.equal(readCompleted.data?.inputState, "provided");
  assert.equal(readCompleted.data?.outputState, "provided");
  assert.ok(String(readCompleted.data?.output ?? "").length > 0, "the read completion must preserve its non-empty output");

  const editRequested = sseEvents.find((event) => event.type === "tool_call_requested" && event.data?.callId === "call_fixture_edit");
  const editRunning = sseEvents.find((event) => event.type === "tool_call_delta"
    && event.data?.callId === "call_fixture_edit"
    && event.data?.toolStatus === "running"
    && event.data?.permissionReply === undefined);
  const editCompleted = sseEvents.find((event) => event.type === "tool_call_completed" && event.data?.callId === "call_fixture_edit");
  assert.ok(editRequested && editRunning && editCompleted, "the captured edit tool must project requested, running, and completed states");
  assert.equal(editRequested.status, "requested");
  assert.equal(editRequested.data?.inputState, "empty");
  assert.equal(editRequested.data?.outputState, "unavailable");
  assert.equal(editRunning.status, "running");
  assert.equal(editRunning.data?.inputState, "provided");
  assert.ok(Object.keys(fixtureRecord(editRunning.data?.input)).length > 0, "the edit running state must preserve its non-empty input");
  assert.equal(editCompleted.status, "completed");
  assert.equal(editCompleted.data?.inputState, "provided");
  assert.equal(editCompleted.data?.outputState, "provided");
  assert.ok(String(editCompleted.data?.output ?? "").length > 0, "the edit completion must preserve its non-empty output");
  assert.match(String(editCompleted.data?.diff ?? ""), /\+FIXTURE_MARKER/, "the edit completion must expose the real tool metadata diff");

  const permissionRequested = sseEvents.find((event) => event.type === "permission_requested");
  assert.ok(permissionRequested, "the captured permission.asked event must be projected");
  assert.equal(permissionRequested.data?.callId, "call_fixture_edit");
  assert.match(
    String(fixtureRecord(fixtureRecord(permissionRequested.data?.request).metadata).diff ?? ""),
    /\+FIXTURE_MARKER/,
    "permission.asked metadata.diff must survive projection"
  );
  const permissionReply = sseEvents.find((event) => event.type === "tool_call_delta" && event.data?.permissionReply === "once");
  assert.ok(permissionReply, "the captured permission.replied event must be projected");
  assert.equal(permissionReply.data?.callId, "call_fixture_edit");
  assert.equal(permissionReply.data?.toolStatus, "running");

  const rawEditCompleted = OPEN_CODE_143_FIXTURE.sseEvents.find((wireEvent) => {
    const part = fixtureRecord(fixtureRecord(fixtureRecord(wireEvent).properties).part);
    const state = fixtureRecord(part.state);
    return part.type === "tool" && part.tool === "edit" && state.status === "completed";
  });
  assert.ok(rawEditCompleted, "the wire fixture must retain the completed edit tool state");
  const rawEditPart = fixtureRecord(fixtureRecord(fixtureRecord(rawEditCompleted).properties).part);
  const rawEditMetadata = fixtureRecord(fixtureRecord(rawEditPart.state).metadata);
  assert.match(String(rawEditMetadata.diff ?? ""), /\+FIXTURE_MARKER/);
  assert.equal(fixtureRecord(rawEditMetadata.filediff).additions, 1);

  const rawSessionDiffs = OPEN_CODE_143_FIXTURE.sseEvents
    .filter((wireEvent) => fixtureRecord(wireEvent).type === "session.diff")
    .map((wireEvent) => fixtureRecord(fixtureRecord(wireEvent).properties).diff);
  assert.deepEqual(rawSessionDiffs, [[]], "the real provider session.diff was empty and must not be backfilled from tool metadata");
  assert.deepEqual(
    sseEvents.filter((event) => event.type === "file_status"),
    [],
    "an empty provider session.diff must not become a fake applied file change"
  );

  assert.deepEqual(
    sseEvents.filter((event) => event.type === "message_delta").map((event) => event.text),
    ["FIX", "TURE_CAPTURE_DONE"],
    "OpenCode 1.4.3 answer deltas must stream without replaying the final part snapshot"
  );
  assert.equal(
    sseEvents.filter((event) => event.type === "message_delta").map((event) => event.text ?? "").join(""),
    "FIXTURE_CAPTURE_DONE"
  );
  assert.equal(sseEvents.filter((event) => event.type === "usage").length, 3, "each captured step-finish must expose usage");
  assert.deepEqual(terminalTypes, ["idle", "idle"], "session.status idle and session.idle must both be recognized as terminal events");

  const cliProjector = new OpenCodeEventProjector(OPEN_CODE_143_FIXTURE.sessionId);
  const cliEvents = OPEN_CODE_143_FIXTURE.cliJsonl.flatMap((wireEvent) => cliProjector.projectCli(wireEvent).events);
  assert.deepEqual(cliEvents.filter((event) => event.type === "thinking_delta").map((event) => event.text), ["Inspect the request."]);
  assert.deepEqual(cliEvents.filter((event) => event.type === "message_delta").map((event) => event.text), ["FIXTURE_OK"]);
  assert.equal(cliEvents.filter((event) => event.type === "usage").length, 1);
}

function testProjectorPreservesReasoningToolOrderAndDataStates(): void {
  const projector = new OpenCodeEventProjector("session-a");
  projector.project(messageUpdated("session-a", "assistant-a"));
  const events = [
    ...projector.project(partUpdated("session-a", {
      id: "reason-1",
      messageID: "assistant-a",
      type: "reasoning",
      text: "先检查文件"
    })).events,
    ...projector.project(partUpdated("session-a", {
      id: "tool-1",
      messageID: "assistant-a",
      type: "tool",
      callID: "call-1",
      tool: "read",
      state: { status: "running", input: {}, time: { start: 1 } }
    })).events,
    ...projector.project(partUpdated("session-a", {
      id: "tool-1",
      messageID: "assistant-a",
      type: "tool",
      callID: "call-1",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "testing/a.md" },
        output: "done",
        title: "Read testing/a.md",
        metadata: {},
        time: { start: 1, end: 2 }
      }
    })).events,
    ...projector.project(partUpdated("session-a", {
      id: "reason-2",
      messageID: "assistant-a",
      type: "reasoning",
      text: "再整理答案"
    })).events,
    ...projector.project(partUpdated("session-a", {
      id: "text-1",
      messageID: "assistant-a",
      type: "text",
      text: "PONG"
    })).events
  ];
  assert.deepEqual(events.map((event) => event.type), [
    "thinking_delta",
    "thinking_completed",
    "tool_call_requested",
    "tool_call_completed",
    "thinking_delta",
    "thinking_completed",
    "message_delta"
  ]);
  const emptyTool = events.find((event) => event.type === "tool_call_requested");
  assert.equal(emptyTool?.data?.callId, "call-1");
  assert.equal(emptyTool?.data?.toolCallId, "call-1");
  assert.equal(emptyTool?.data?.semanticKind, "read");
  assert.equal(emptyTool?.status, "requested");
  assert.equal(emptyTool?.data?.toolStatus, "requested");
  assert.equal(emptyTool?.data?.inputState, "empty");
  assert.equal("input" in (emptyTool?.data ?? {}), false, "empty input must not be rendered as fake {}");
  assert.equal(emptyTool?.data?.outputState, "unavailable");
  const reasoning = events[0];
  assert.equal(reasoning.data?.reasoningKind, "provider");
  assert.equal(reasoning.data?.visibility, "public");
  assert.equal(reasoning.data?.blockId, "reason-1");
  assert.equal(eventBelongsToSession(partUpdated("other", { type: "text" }), "session-a"), false);
  assert.equal(eventBelongsToSession({ type: "server.connected", properties: {} }, "session-a"), true);
  assert.equal(eventBelongsToSession({ type: "session.error", properties: { error: { message: "other run" } } }, "session-a"), false);
}

function testReasoningSnapshotReplacementCompletesWithCorrectedText(): void {
  const projector = new OpenCodeEventProjector("session-a");
  projector.project(messageUpdated("session-a", "assistant-a"));
  const first = projector.project(partUpdated("session-a", {
    id: "reasoning-replaced",
    messageID: "assistant-a",
    type: "reasoning",
    text: "old snapshot"
  })).events;
  const corrected = projector.project(partUpdated("session-a", {
    id: "reasoning-replaced",
    messageID: "assistant-a",
    type: "reasoning",
    text: "corrected snapshot",
    time: { start: 1, end: 2 }
  })).events;

  assert.equal(first[0]?.type, "thinking_delta");
  assert.equal(corrected[0]?.type, "thinking_delta");
  assert.equal(corrected[0]?.data?.replace, true);
  assert.equal(corrected[0]?.data?.fullText, "corrected snapshot");
  assert.equal(corrected[1]?.type, "thinking_completed");
  assert.equal(corrected[1]?.text, "corrected snapshot");
}

function testProjectorTreatsFailedToolStateAsTerminal(): void {
  const projector = new OpenCodeEventProjector("session-a");
  projector.project(messageUpdated("session-a", "assistant-a"));
  const events = projector.project(partUpdated("session-a", {
    id: "tool-failed",
    messageID: "assistant-a",
    type: "tool",
    callID: "call-failed",
    tool: "read",
    state: {
      status: "failed",
      input: { path: "testing/missing.md" },
      error: "missing"
    }
  })).events;

  assert.deepEqual(events.map((event) => event.type), ["tool_call_requested", "tool_call_failed"]);
  assert.equal(events[1]?.status, "failed");
  assert.equal(events[1]?.data?.toolStatus, "failed");
  assert.equal(projector.finish("unconfirmed").settledToolCallIds, undefined);
}

function testProjectorMapsProviderSideChannels(): void {
  const projector = new OpenCodeEventProjector("session-a");
  const usage = projector.project({
    type: "message.updated",
    properties: {
      sessionID: "session-a",
      info: {
        id: "assistant-a",
        sessionID: "session-a",
        role: "assistant",
        tokens: { input: 10, output: 2, reasoning: 3, total: 15, cache: { read: 4, write: 1 } },
        cost: 0.01
      }
    }
  }).events;
  projector.project(partUpdated("session-a", {
    id: "tool-before-permission",
    messageID: "assistant-a",
    type: "tool",
    callID: "call-edit",
    tool: "edit",
    state: { status: "pending", input: { filePath: "testing/a.md" } }
  }));
  projector.project(partUpdated("session-a", {
    id: "reason-before-permission",
    messageID: "assistant-a",
    type: "reasoning",
    text: "准备申请权限"
  }));
  const permission = projector.project({
    type: "permission.asked",
    properties: {
      id: "permission-1",
      sessionID: "session-a",
      permission: "edit",
      patterns: ["testing/**"],
      always: [],
      metadata: {},
      tool: { messageID: "assistant-a", callID: "call-edit" }
    }
  }).events;
  const permissionReply = projector.project({
    type: "permission.replied",
    properties: {
      sessionID: "session-a",
      requestID: "permission-1",
      reply: "reject"
    }
  }).events;
  const plan = projector.project({
    type: "todo.updated",
    properties: { sessionID: "session-a", todos: [{ content: "验证", status: "completed", priority: "high" }] }
  }).events;
  const emptyDiff = projector.project({
    type: "session.diff",
    properties: { sessionID: "session-a", diff: [] }
  }).events;
  const diff = projector.project({
    type: "session.diff",
    properties: { sessionID: "session-a", diff: [{ file: "testing/a.md", additions: 1, deletions: 0 }] }
  }).events;
  assert.equal(usage[0]?.type, "usage");
  assert.equal(usage[0]?.data?.reasoningTokens, 3);
  assert.deepEqual(permission.map((event) => event.type), ["thinking_completed", "permission_requested"]);
  assert.equal(permission[1]?.data?.toolStatus, "approval");
  assert.equal(permission[1]?.data?.callId, "call-edit");
  assert.equal(permission[1]?.data?.inputState, "provided");
  assert.deepEqual(permission[1]?.data?.input, { filePath: "testing/a.md" });
  assert.equal(permissionReply[0]?.type, "tool_call_delta");
  assert.equal(permissionReply[0]?.data?.callId, "call-edit");
  assert.equal(permissionReply[0]?.data?.toolStatus, "denied");
  assert.equal(permissionReply[0]?.data?.inputState, "provided");
  assert.deepEqual(permissionReply[0]?.data?.input, { filePath: "testing/a.md" });
  assert.equal(plan[0]?.type, "plan_updated");
  assert.match(plan[0]?.text ?? "", /\[x\] 验证/);
  assert.deepEqual(emptyDiff, [], "empty session diffs must not produce file status events");
  assert.equal(diff[0]?.type, "file_status");
  assert.deepEqual(diff[0]?.data?.files, ["testing/a.md"]);
}

function testCliProjectorSupportsOpenCode143ToolUse(): void {
  const projector = new OpenCodeEventProjector("session-a");
  const toolUse = {
    type: "tool_use",
    sessionID: "session-a",
    part: {
      id: "tool-bash",
      messageID: "assistant-cli",
      type: "tool",
      callID: "call-bash",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/vault",
        title: "pwd",
        metadata: {},
        time: { start: 1, end: 2 }
      }
    }
  };
  const events = projector.projectCli(toolUse).events;
  assert.deepEqual(events.map((event) => event.type), ["tool_call_requested", "tool_call_completed"]);
  assert.equal(events[0]?.data?.semanticKind, "command");
  assert.equal(events[0]?.data?.toolStatus, "requested");
  assert.equal(events[1]?.data?.toolStatus, "completed");
  assert.deepEqual(projector.projectCli(toolUse).events, [], "OpenCode 1.4.3 tool_use completion must be projected once");
}

function testPermissionPoliciesAreDeterministic(): void {
  const readOnly = openCodePermissionRules("read-only");
  assert.deepEqual(readOnly[0], { permission: "*", pattern: "*", action: "deny" });
  assert.equal(readOnly.some((rule) => rule.permission === "read" && rule.action === "allow"), true);
  assert.equal(readOnly.some((rule) => rule.permission === "edit" && rule.action === "allow"), false);

  const workspaceWrite = openCodePermissionRules("workspace-write");
  assert.deepEqual(workspaceWrite[0], { permission: "*", pattern: "*", action: "allow" });
  assert.equal(workspaceWrite.some((rule) => rule.permission === "external_directory" && rule.action === "deny"), true);
  assert.equal(workspaceWrite.some((rule) => rule.permission === "question" && rule.action === "deny"), true);
  const scopedWorkspaceWrite = openCodePermissionRules(
    "workspace-write",
    ["/vault", "/external-notes"],
    "/vault"
  );
  assert.equal(scopedWorkspaceWrite.some((rule) => rule.permission === "external_directory" && rule.pattern === "/external-notes/**" && rule.action === "allow"), true);
  assert.equal(scopedWorkspaceWrite.some((rule) => rule.permission === "external_directory" && rule.pattern.startsWith("/vault/") && rule.action === "allow"), false);

  const maintenanceShadowWrite = openCodePermissionRules(
    "workspace-write",
    ["/shadow/wiki", "/shadow/projects", "/shadow/outputs", "/shadow/inbox"],
    "/shadow"
  );
  assert.deepEqual(
    maintenanceShadowWrite[0],
    { permission: "*", pattern: "*", action: "deny" },
    "scoped Shadow permissions must fail closed instead of inheriting workspace-wide writes"
  );
  assert.equal(maintenanceShadowWrite.some((rule) =>
    rule.permission === "edit" && rule.pattern === "wiki/**" && rule.action === "allow"
  ), true);
  assert.equal(maintenanceShadowWrite.some((rule) =>
    rule.permission === "edit" && rule.pattern === "outputs/**" && rule.action === "allow"
  ), true);
  const trackerAllowIndex = maintenanceShadowWrite.findIndex((rule) =>
    rule.permission === "edit" && rule.pattern === "outputs/**" && rule.action === "allow"
  );
  const trackerDenyIndex = maintenanceShadowWrite.findIndex((rule) =>
    rule.permission === "edit" && rule.pattern === "outputs/.ingest-tracker.md" && rule.action === "deny"
  );
  assert.equal(trackerDenyIndex > trackerAllowIndex, true, "the last matching tracker rule must deny Agent writes");
  assert.equal(maintenanceShadowWrite.some((rule) =>
    rule.permission === "edit" && rule.pattern.startsWith("raw") && rule.action === "allow"
  ), false);
  for (const permission of ["bash", "task", "skill"]) {
    assert.equal(
      maintenanceShadowWrite.some((rule) => rule.permission === permission && rule.action === "allow"),
      false,
      `scoped Shadow permissions must not expose ${permission}`
    );
  }

  const dangerFullAccess = openCodePermissionRules("danger-full-access");
  assert.deepEqual(dangerFullAccess[0], { permission: "*", pattern: "*", action: "allow" });
  assert.equal(dangerFullAccess.some((rule) => rule.permission === "question" && rule.action === "deny"), true);

  assert.equal(openCodePermissionReply("read-only", "edit"), "reject");
  assert.equal(openCodePermissionReply("workspace-write", "external_directory"), "reject");
  assert.equal(openCodePermissionReply("workspace-write", "edit"), "once");
  assert.equal(openCodePermissionReply("danger-full-access", "bash"), "once");
}

function testProjectorSettlesPendingToolsHonestly(): void {
  const unconfirmed = new OpenCodeEventProjector("session-a");
  unconfirmed.project(messageUpdated("session-a", "assistant-a"));
  unconfirmed.project(partUpdated("session-a", {
    id: "tool-write",
    messageID: "assistant-a",
    type: "tool",
    callID: "call-write",
    tool: "write",
    state: { status: "running", input: { filePath: "testing/a.md" }, time: { start: 1 } }
  }));
  const unconfirmedFinish = unconfirmed.finish("unconfirmed");
  assert.deepEqual(unconfirmedFinish.settledToolCallIds, ["call-write"]);
  assert.equal(unconfirmedFinish.events.at(-1)?.type, "tool_call_delta");
  assert.equal(unconfirmedFinish.events.at(-1)?.status, "unconfirmed");
  assert.equal(unconfirmedFinish.events.at(-1)?.data?.semanticKind, "edit");
  assert.equal(unconfirmedFinish.events.at(-1)?.data?.toolStatus, "unconfirmed");
  assert.deepEqual(unconfirmed.finish("unconfirmed").settledToolCallIds, undefined, "a settled tool must not be emitted twice");

  const interrupted = new OpenCodeEventProjector("session-b");
  interrupted.project(messageUpdated("session-b", "assistant-b"));
  interrupted.project(partUpdated("session-b", {
    id: "tool-search",
    messageID: "assistant-b",
    type: "tool",
    callID: "call-search",
    tool: "grep",
    state: { status: "pending", input: { pattern: "TODO" } }
  }));
  const interruptedFinish = interrupted.finish("interrupted");
  assert.equal(interruptedFinish.events.at(-1)?.status, "interrupted");
  assert.equal(interruptedFinish.events.at(-1)?.data?.semanticKind, "search");
}

function testTypedWriteFenceReceiptIsCodeGeneratedAndDeterministic(): void {
  const task: AgentTaskInput = {
    prompt: "maintenance",
    permission: "workspace-write",
    writableRoots: ["/shadow/wiki", "/shadow/outputs"],
    requireExactWriteFence: true,
    exactWriteFence: {
      attemptToken: "attempt-token",
      leaseToken: "lease-token",
      deniedLivePaths: ["/live-vault"],
      deniedControlPaths: ["/shadow-control"]
    }
  };
  const receiptInput = {
    backend: "codex-cli" as const,
    task,
    transport: "codex-app-server-sandbox",
    transportAck: {
      sandbox: "workspace-write",
      threadId: "thread-1",
      writableRoots: ["/shadow/wiki", "/shadow/outputs"]
    },
    configuredAt: "2026-07-18T00:00:00.000Z"
  };
  const first = createExactWriteFenceReceipt(receiptInput);
  const second = createExactWriteFenceReceipt({
    ...receiptInput,
    transportAck: {
      writableRoots: ["/shadow/wiki", "/shadow/outputs"],
      threadId: "thread-1",
      sandbox: "workspace-write"
    }
  });
  const changed = createExactWriteFenceReceipt({
    ...receiptInput,
    transportAck: { ...receiptInput.transportAck, threadId: "thread-2" }
  });

  assert.equal(first.backend, "codex-cli");
  assert.equal(first.attemptToken, "attempt-token");
  assert.equal(first.leaseToken, "lease-token");
  assert.deepEqual(first.enforcedWritableRoots, ["/shadow/outputs", "/shadow/wiki"]);
  assert.match(first.configAckDigest, /^[a-f0-9]{64}$/);
  assert.equal(second.configAckDigest, first.configAckDigest, "key order must not change the config ack digest");
  assert.notEqual(changed.configAckDigest, first.configAckDigest, "a different transport ack must produce a different digest");
  assert.equal(isTrustedExactWriteFenceReceipt(first), true);
  assert.equal(
    isTrustedExactWriteFenceReceipt(structuredClone(first)),
    false,
    "a JSON-compatible clone must not inherit trusted issuer identity"
  );
  assert.equal(isTrustedExactWriteFenceReceipt({ ...first }), false, "a spread copy must not inherit trusted issuer identity");
}

async function testCliFallbackIsOnlyUsedBeforeSubmission(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    throw new Error("SSE unavailable");
  };
  backend.cliResult = { text: "CLI PONG", runId: "session-a" };
  backend.cliEvents = [
    { type: "reasoning", sessionID: "session-a", part: { messageID: "assistant-cli", text: "检查" } },
    { type: "text", sessionID: "session-a", part: { messageID: "assistant-cli", text: "CLI PONG" } }
  ];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  const result = await runtime.runTaskStream({
    prompt: "ping",
    system: "SYSTEM-BOUNDARY",
    resources: testResources(),
    timeoutMs: 200
  }, (event) => {
    events.push(event);
  });
  assert.equal(result.text, "CLI PONG");
  assert.equal(result.terminalData?.streamSource, "cli-jsonl");
  assert.equal(backend.promptAsyncCalls, 0);
  assert.equal(backend.cliCalls, 1);
  assert.equal(backend.lastCliOptions?.thinking, true);
  assert.match(backend.lastCliOptions?.prompt ?? "", /SYSTEM-BOUNDARY/);
  assert.match(backend.lastCliOptions?.prompt ?? "", /RESOURCE-PREFIX/);
  assert.match(backend.lastCliOptions?.prompt ?? "", /RESOURCE-WARNING/);
  assert.equal(events.find((event) => event.type === "fallback_started")?.data?.promptSubmitted, false);
  assert.equal(events.find((event) => event.type === "prompt_sent")?.data?.promptSubmitted, true);
  assert.equal(events.some((event) => event.type === "message_completed"), false,
    "CLI rich events must not replay their aggregate result as a message completion");
  assert.deepEqual(buildOpenCodeRunArgs({
    prompt: "ping",
    directory: "/vault",
    serverUrl: "http://127.0.0.1:4096",
    sessionId: "session-a",
    thinking: true
  }).slice(0, 10), [
    "run", "--format", "json", "--dir", "/vault", "--attach", "http://127.0.0.1:4096", "--session", "session-a", "--thinking"
  ]);
}

async function testPrePromptIdleDoesNotSettleNewTurn(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    yield { type: "session.idle", properties: { sessionID: "session-a" } };
    while (backend.promptAsyncCalls === 0) await delay(1);
    yield messageUpdated("session-a", "assistant-live");
    yield partUpdated("session-a", {
      id: "text-live",
      messageID: "assistant-live",
      type: "text",
      text: "LIVE"
    });
    yield { type: "session.idle", properties: { sessionID: "session-a" } };
  };
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  const result = await runtime.runTaskStream({
    prompt: "ping",
    system: "SYSTEM-BOUNDARY",
    resources: testResources(),
    timeoutMs: 250
  }, (event) => {
    events.push(event);
  });
  assert.equal(result.text, "LIVE");
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.lastPromptOptions?.system, "SYSTEM-BOUNDARY");
  const submittedText = backend.lastPromptOptions?.parts[0]?.type === "text"
    ? backend.lastPromptOptions.parts[0].text
    : "";
  assert.match(submittedText, /RESOURCE-PREFIX/);
  assert.match(submittedText, /RESOURCE-WARNING/);
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
}

async function testResumedSessionRefreshesPermissionPolicy(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.hasSessionResult = true;
  backend.subscribe = async function* () {
    throw new Error("SSE unavailable");
  };
  backend.cliResult = { text: "RESUMED", runId: "session-existing" };
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  const result = await runtime.runTaskStream({
    prompt: "continue",
    nativeSessionId: "session-existing",
    permission: "read-only",
    writableRoots: ["/vault/testing"],
    timeoutMs: 250
  }, () => undefined);
  assert.equal(result.text, "RESUMED");
  assert.equal(backend.startSessionCalls, 0);
  assert.deepEqual(backend.permissionUpdates, [{
    sessionId: "session-existing",
    permission: "read-only",
    writableRoots: ["/vault/testing"]
  }]);
}

async function testPermissionRequestsAreAnsweredWithoutHanging(): Promise<void> {
  const cases = [
    { mode: "read-only" as const, permission: "edit", expectedReply: "reject" as const, expectedStatus: "denied" },
    { mode: "workspace-write" as const, permission: "external_directory", expectedReply: "reject" as const, expectedStatus: "denied" },
    { mode: "danger-full-access" as const, permission: "bash", expectedReply: "once" as const, expectedStatus: "running" }
  ];
  for (const testCase of cases) {
    const backend = new FakeOpenCodeRichBackend();
    backend.subscribe = async function* () {
      yield { type: "server.connected", properties: {} };
      while (backend.promptAsyncCalls === 0) await delay(1);
      yield messageUpdated("session-a", "assistant-permission");
      yield {
        type: "permission.asked",
        properties: {
          id: "permission-1",
          sessionID: "session-a",
          permission: testCase.permission,
          tool: { messageID: "assistant-permission", callID: "call-permission" }
        }
      };
      while (backend.permissionReplies.length === 0) await delay(1);
      yield {
        type: "permission.replied",
        properties: {
          sessionID: "session-a",
          requestID: "permission-1",
          reply: backend.permissionReplies[0]?.reply
        }
      };
      yield partUpdated("session-a", {
        id: "text-after-permission",
        messageID: "assistant-permission",
        type: "text",
        text: "DONE"
      });
      yield { type: "session.idle", properties: { sessionID: "session-a" } };
    };
    const events: AgentEvent[] = [];
    const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
    const result = await runtime.runTaskStream({
      prompt: "ping",
      permission: testCase.mode,
      timeoutMs: 250
    }, (event) => events.push(event));
    assert.equal(result.text, "DONE");
    assert.deepEqual(backend.permissionReplies, [{ requestId: "permission-1", reply: testCase.expectedReply }]);
    assert.equal(events.some((event) => event.type === "permission_requested"), true);
    assert.equal(events.some((event) => event.type === "tool_call_delta"
      && event.data?.permissionReply === testCase.expectedReply
      && event.data?.toolStatus === testCase.expectedStatus), true);
  }
}

async function testFailedRunInterruptsPendingTools(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (backend.promptAsyncCalls === 0) await delay(1);
    yield messageUpdated("session-a", "assistant-failed");
    yield partUpdated("session-a", {
      id: "tool-running",
      messageID: "assistant-failed",
      type: "tool",
      callID: "call-running",
      tool: "read",
      state: { status: "running", input: { filePath: "testing/a.md" }, time: { start: 1 } }
    });
    yield {
      type: "session.error",
      properties: { sessionID: "session-a", error: { data: { message: "provider failed" } } }
    };
  };
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  await assert.rejects(
    runtime.runTaskStream({ prompt: "ping", timeoutMs: 250 }, (event) => {
      events.push(event);
    }),
    /provider failed/
  );
  const interrupted = events.find((event) => event.type === "tool_call_delta" && event.data?.toolStatus === "interrupted");
  assert.equal(interrupted?.data?.callId, "call-running");
  assert.equal(events.find((event) => event.type === "failed")?.data?.interruptedToolCallCount, 1);
}

async function testImmediateSessionErrorAfterSubmissionFailsWithoutPolling(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (backend.promptAsyncCalls === 0) await delay(1);
    yield {
      type: "session.error",
      properties: { sessionID: "session-a", error: { data: { message: "provider auth failed" } } }
    };
  };
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  await assert.rejects(
    runtime.runTaskStream({ prompt: "ping", timeoutMs: 150 }, () => undefined),
    /provider auth failed/
  );
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0);
}

async function testCompletedRunMarksPendingToolsUnconfirmed(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (backend.promptAsyncCalls === 0) await delay(1);
    yield messageUpdated("session-a", "assistant-unconfirmed");
    yield partUpdated("session-a", {
      id: "tool-running-success",
      messageID: "assistant-unconfirmed",
      type: "tool",
      callID: "call-unconfirmed",
      tool: "read",
      state: { status: "running", input: { filePath: "testing/a.md" }, time: { start: 1 } }
    });
    yield partUpdated("session-a", {
      id: "text-success",
      messageID: "assistant-unconfirmed",
      type: "text",
      text: "DONE"
    });
    yield { type: "session.idle", properties: { sessionID: "session-a" } };
  };
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  const result = await runtime.runTaskStream({ prompt: "ping", timeoutMs: 250 }, (event) => {
    events.push(event);
  });
  assert.equal(result.text, "DONE");
  assert.equal(result.terminalData?.streamSource, "sse");
  assert.equal(result.terminalData?.promptSubmitted, true);
  assert.equal(result.terminalData?.unconfirmedToolCallCount, 1);
  assert.equal(events.some((event) => event.type === "tool_call_delta" && event.data?.toolStatus === "unconfirmed"), true);
  const completed = events.find((event) => event.type === "completed");
  assert.equal(completed?.data?.unconfirmedToolCallCount, 1);
  assert.deepEqual(completed?.data?.unconfirmedToolCallIds, ["call-unconfirmed"]);
}

async function testInterleavedAnswersDoNotReplayAggregateCompletion(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (backend.promptAsyncCalls === 0) await delay(1);
    yield messageUpdated("session-a", "assistant-interleaved");
    yield partUpdated("session-a", {
      id: "text-before-tool",
      messageID: "assistant-interleaved",
      type: "text",
      text: "A"
    });
    yield partUpdated("session-a", {
      id: "tool-between-answers",
      messageID: "assistant-interleaved",
      type: "tool",
      callID: "call-between-answers",
      tool: "read",
      state: { status: "completed", input: { filePath: "testing/a.md" }, output: "ok" }
    });
    yield partUpdated("session-a", {
      id: "text-after-tool",
      messageID: "assistant-interleaved",
      type: "text",
      text: "B"
    });
    yield { type: "session.idle", properties: { sessionID: "session-a" } };
  };
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  const result = await runtime.runTaskStream({ prompt: "interleave", timeoutMs: 250 }, (event) => events.push(event));

  assert.equal(result.text, "AB");
  assert.equal(events.some((event) => event.type === "message_completed"), false,
    "a whole-turn completion must not replace the final interleaved answer segment");

  const runId = "harness-open-code-interleaved";
  const answer: ChatMessage = {
    id: "answer-interleaved",
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "OpenCode 正在处理...",
    backendId: "opencode",
    runId,
    createdAt: 1
  };
  const messages: ChatMessage[] = [answer];
  const projector = new HarnessEventProjector({
    runId,
    backendId: "opencode",
    vaultPath: "/vault",
    answerMessage: answer
  });
  let sequence = 0;
  for (const event of events) {
    const type = harnessTypeForOpenCodeAgentEvent(event.type);
    if (!type) continue;
    sequence += 1;
    const harnessEvent: HarnessEvent = {
      eventId: `${runId}:${sequence}`,
      runId,
      sequence,
      createdAt: event.createdAt,
      source: type.startsWith("tool.") ? "tool" : type.startsWith("run.") ? "kernel" : "agent",
      type,
      backendId: "opencode",
      text: event.text,
      error: event.error,
      toolName: event.toolName,
      status: event.status,
      data: event.data
    };
    applyHarnessProjectionBatch(messages, projector.project(harnessEvent), answer.id);
  }
  assert.deepEqual(
    messages.filter((message) => message.itemType === "assistant").map((message) => message.text),
    ["A", "B"],
    "the shared Codex-style projection must preserve answer/tool/answer segments without replay"
  );
}

async function testPromptRequestHonorsAbortSignal(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.promptAsyncHandler = async (_options, signal) => await waitForAbort(signal);
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (!backend.subscriptionSignal?.aborted) await delay(1);
  };
  const controller = new AbortController();
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  const run = runtime.runTaskStream({ prompt: "cancel", timeoutMs: 1_000, abortSignal: controller.signal }, () => undefined);
  while (backend.promptAsyncCalls === 0) await delay(1);
  controller.abort();

  await assert.rejects(withTestTimeout(run, 250, "OpenCode prompt request ignored AbortSignal"), /取消/);
  assert.equal(backend.lastPromptSignal?.aborted, true);
  assert.equal(backend.abortCalls, 1);
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0, "a cancelled submitted prompt must never be replayed through CLI");
}

async function testPromptRequestHonorsDeadline(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.promptAsyncHandler = async (_options, signal) => await waitForAbort(signal);
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (!backend.subscriptionSignal?.aborted) await delay(1);
  };
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  await assert.rejects(
    withTestTimeout(
      runtime.runTaskStream({ prompt: "timeout", timeoutMs: 30 }, () => undefined),
      250,
      "OpenCode prompt request ignored the task deadline"
    ),
    /超时前完成|等待超时/
  );
  assert.equal(backend.lastPromptSignal?.aborted, true);
  assert.equal(backend.abortCalls, 1, "a final deadline failure must stop the submitted OpenCode session");
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0, "a timed-out submitted prompt must never be replayed through CLI");
}

async function testStreamFailureBeforePromptResponseIsHandled(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.promptAsyncHandler = async () => await delay(40);
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (backend.promptAsyncCalls === 0) await delay(1);
    throw new Error("socket closed before prompt response");
  };
  const recoveredMessage = completedAssistantMessage("assistant-early-stream-failure", "RECOVERED");
  backend.messages = [[], [recoveredMessage], [recoveredMessage]];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
    const result = await runtime.runTaskStream({ prompt: "recover", timeoutMs: 250 }, () => undefined);
    await delay(0);
    assert.equal(result.text, "RECOVERED");
    assert.deepEqual(unhandled, [], "an early SSE failure must have a rejection handler before promptAsync settles");
    assert.equal(backend.promptAsyncCalls, 1);
    assert.equal(backend.cliCalls, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function testPromptFailureIsHandledBeforeSlowEventSink(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.promptAsyncError = new Error("immediate prompt failure");
  backend.readMessagesError = new Error("readback after prompt failure failed");
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (!backend.subscriptionSignal?.aborted) await delay(1);
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
    await assert.rejects(
      runtime.runTaskStream({ prompt: "fail", timeoutMs: 250 }, async (event) => {
        if (event.type === "prompt_sent") await delay(20);
      }),
      /readback after prompt failure failed/
    );
    await delay(0);
    assert.deepEqual(unhandled, [], "promptAsync rejection must be handled before a slow prompt_sent sink completes");
    assert.equal(backend.promptAsyncCalls, 1);
    assert.equal(backend.cliCalls, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

async function testSubmittedPromptRecoversSameSessionWithoutReplay(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed");
  };
  const recoveredMessage = {
      info: {
        id: "assistant-recovered",
        sessionID: "session-a",
        role: "assistant",
        time: { created: 1, completed: 2 },
        tokens: { input: 2, output: 1, reasoning: 0, total: 3, cache: { read: 0, write: 0 } },
        cost: 0
      },
      parts: [{ id: "text-recovered", sessionID: "session-a", messageID: "assistant-recovered", type: "text", text: "RECOVERED" }]
    };
  backend.messages = [[], [recoveredMessage], [recoveredMessage]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });
  const result = await runtime.runTaskStream({ prompt: "ping", timeoutMs: 250 }, (event) => {
    events.push(event);
  });
  assert.equal(result.text, "RECOVERED");
  assert.equal(backend.promptAsyncCalls, 1, "promptAsync must run exactly once");
  assert.equal(backend.cliCalls, 0, "post-submit stream loss must never use CLI fallback");
  assert.equal(events.filter((event) => event.type === "prompt_sent").length, 1);
  assert.equal(events.find((event) => event.type === "prompt_sent")?.data?.promptSubmitted, true);
  assert.equal(events.some((event) => event.data?.streamSource === "session-readback"), true);
}

async function testSubmittedPromptReadbackProviderErrorFailsImmediately(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed before provider error readback");
  };
  const providerFailure = failedAssistantMessage("assistant-readback-failed", "PARTIAL", "provider readback failed");
  backend.messages = [[], [providerFailure]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  await assert.rejects(
    runtime.runTaskStream({ prompt: "fail during recovery", timeoutMs: 250 }, (event) => events.push(event)),
    /provider readback failed/
  );

  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0, "a provider error after submission must never replay the prompt through CLI");
  assert.equal(backend.abortCalls, 1);
  assert.equal(events.filter((event) => event.type === "failed").length, 1);
  assert.equal(events.some((event) => event.type === "completed"), false);
}

async function testFinalReadbackProviderErrorOverridesIdle(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (backend.promptAsyncCalls === 0) await delay(1);
    yield messageUpdated("session-a", "assistant-final-readback-failed");
    yield { type: "session.idle", properties: { sessionID: "session-a" } };
  };
  const providerFailure = failedAssistantMessage("assistant-final-readback-failed", "PARTIAL", "provider failed after idle");
  backend.messages = [[], [providerFailure]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  await assert.rejects(
    runtime.runTaskStream({ prompt: "idle then error", timeoutMs: 250 }, (event) => events.push(event)),
    /provider failed after idle/
  );

  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0);
  assert.equal(backend.abortCalls, 1);
  assert.equal(events.filter((event) => event.type === "failed").length, 1);
  assert.equal(events.some((event) => event.type === "completed"), false);
}

async function testLaterSuccessfulReadbackClearsOlderProviderError(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.sessionStatus = "idle";
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed before mixed readback");
  };
  const olderFailure = failedAssistantMessage("assistant-older-failure", "STALE_PARTIAL", "older provider failure", 1);
  const finalAnswer = completedAssistantMessage("assistant-after-failure", "RECOVERED_AFTER_FAILURE");
  backend.messages = [[], [olderFailure, finalAnswer], [olderFailure, finalAnswer]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  const result = await runtime.runTaskStream({ prompt: "recover after older failure", timeoutMs: 250 }, (event) => events.push(event));

  assert.equal(result.text, "RECOVERED_AFTER_FAILURE");
  assert.equal(events.filter((event) => event.type === "failed").length, 0);
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
}

async function testResumedSessionRequiresReadablePreSubmitBaseline(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.hasSessionResult = true;
  backend.sessionStatus = "idle";
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed after prompt submission");
  };
  const staleMessage = completedAssistantMessage("assistant-stale", "STALE");
  let readCalls = 0;
  backend.readSessionMessages = async () => {
    readCalls += 1;
    if (readCalls === 1) throw new Error("pre-submit baseline unavailable");
    return [staleMessage];
  };
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  await assert.rejects(
    runtime.runTaskStream({
      prompt: "new turn",
      nativeSessionId: "session-a",
      timeoutMs: 100
    }, (event) => events.push(event)),
    /pre-submit baseline unavailable/
  );

  assert.equal(readCalls, 1, "a failed resumed-session baseline must stop before recovery readback");
  assert.equal(backend.promptAsyncCalls, 0, "baseline failure must remain before the prompt submission boundary");
  assert.equal(backend.cliCalls, 0, "the rich runtime itself must not replay through CLI");
  assert.equal(backend.abortCalls, 0, "an unsubmitted prompt does not need a provider abort");
  assert.equal(events.some((event) => event.type === "completed"), false);
  assert.equal(events.some((event) => event.type === "failed"), true);
  assert.equal(events.some((event) => event.text === "STALE"), false);
}

async function testSubmittedEmptyAnswerRecoversAfterStreamLoss(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.sessionStatus = "idle";
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed after empty answer");
  };
  const emptyCompletedMessage = completedAssistantMessage("assistant-empty", "");
  backend.messages = [[], [emptyCompletedMessage], [emptyCompletedMessage]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  const result = await runtime.runTaskStream({ prompt: "empty", timeoutMs: 50 }, (event) => {
    events.push(event);
  });

  assert.equal(result.text, "", "a completed empty assistant message is a valid answer");
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0, "post-submit recovery must not replay an empty answer through CLI");
  assert.equal(backend.abortCalls, 0, "successful empty-answer recovery must not abort the session");
  assert.equal(events.filter((event) => event.type === "completed").length, 1);
  assert.equal(events.some((event) => event.type === "failed"), false);
}

async function testCompletedEmptyReadbackOverridesStreamedPartialText(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  const recoveryStatuses = ["busy", "idle"];
  backend.getSessionStatus = async () => recoveryStatuses.shift();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    yield messageUpdated("session-a", "assistant-empty");
    yield partUpdated("session-a", {
      id: "assistant-partial-text",
      messageID: "assistant-empty",
      type: "text",
      text: "PARTIAL"
    });
    throw new Error("socket closed before empty final readback");
  };
  const incompleteMessage = {
    info: {
      id: "assistant-empty",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 1 }
    },
    parts: [{
      id: "assistant-partial-text",
      sessionID: "session-a",
      messageID: "assistant-empty",
      type: "text",
      text: "PARTIAL"
    }]
  };
  const emptyCompletedMessage = completedAssistantMessage("assistant-empty", "");
  let readCalls = 0;
  backend.readSessionMessages = async () => {
    readCalls += 1;
    if (readCalls === 1) return [];
    if (readCalls === 2) return [incompleteMessage];
    if (readCalls === 3) return [emptyCompletedMessage];
    throw new Error("final readback unavailable");
  };
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  const result = await runtime.runTaskStream({ prompt: "empty after partial", timeoutMs: 100 }, (event) => {
    events.push(event);
  });

  assert.equal(result.text, "", "an authoritative completed empty readback must replace a streamed partial snapshot");
  assert.equal(events.filter((event) => event.type === "completed").at(-1)?.text, "");
  assert.equal(readCalls, 4, "the final readback failure must not revive the earlier partial snapshot");
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0);
}

async function testStaleIdleDoesNotCompleteSubmittedRecovery(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.sessionStatus = "idle";
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed while stale idle remained");
  };
  const staleMessage = completedAssistantMessage("assistant-before-prompt", "STALE");
  backend.messages = [[staleMessage], [staleMessage], [staleMessage]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  await assert.rejects(
    runtime.runTaskStream({ prompt: "new turn", timeoutMs: 40 }, (event) => events.push(event)),
    /同一会话仍未在超时前完成/
  );

  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0);
  assert.equal(backend.abortCalls, 1, "a submitted turn with only stale idle evidence must be stopped at its deadline");
  assert.equal(events.some((event) => event.type === "completed"), false);
}

async function testMissingStatusDoesNotTrustIncompleteAssistantText(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed before assistant completion");
  };
  const incompleteMessage = {
    info: {
      id: "assistant-incomplete",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 1 }
    },
    parts: [{
      id: "assistant-incomplete-text",
      sessionID: "session-a",
      messageID: "assistant-incomplete",
      type: "text",
      text: "PARTIAL"
    }]
  };
  backend.messages = [[], [incompleteMessage], [incompleteMessage]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  await assert.rejects(
    runtime.runTaskStream({ prompt: "partial", timeoutMs: 40 }, (event) => events.push(event)),
    /同一会话仍未在超时前完成/
  );

  assert.equal(events.some((event) => event.type === "completed"), false);
}

async function testMissingStatusWaitsPastCompletedToolStep(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed after tool step");
  };
  const toolStep = completedToolAssistantMessage("assistant-tool-step");
  const finalMessage = completedAssistantMessage("assistant-after-tool", "FINAL_AFTER_TOOL");
  backend.messages = [[], [toolStep], [toolStep, finalMessage], [toolStep, finalMessage]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  const result = await runtime.runTaskStream({ prompt: "recover after tool", timeoutMs: 1_000 }, (event) => events.push(event));

  assert.equal(result.text, "FINAL_AFTER_TOOL");
  assert.equal(events.filter((event) => event.type === "completed").at(-1)?.text, "FINAL_AFTER_TOOL");
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0);
  assert.equal(backend.abortCalls, 0);
}

async function testIdleStatusDoesNotTreatToolContinuationTextAsFinal(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.sessionStatus = "idle";
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed on tool continuation");
  };
  const toolStep = completedToolAssistantMessage("assistant-tool-text", "PRE_TOOL_TEXT");
  backend.messages = [[], [toolStep], [toolStep], [toolStep]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  await assert.rejects(
    runtime.runTaskStream({ prompt: "do not stop at tool", timeoutMs: 40 }, (event) => events.push(event)),
    /同一会话仍未在超时前完成/
  );

  assert.equal(events.some((event) => event.type === "completed"), false);
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0);
  assert.equal(backend.abortCalls, 1);
}

async function testLatestCompletedEmptyAnswerOverridesEarlierToolText(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.sessionStatus = "idle";
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    throw new Error("socket closed before empty final");
  };
  const toolStep = completedToolAssistantMessage("assistant-tool-before-empty", "EARLIER_TOOL_TEXT");
  const emptyFinal = completedAssistantMessage("assistant-latest-empty", "");
  backend.messages = [[], [toolStep, emptyFinal], [toolStep, emptyFinal]];
  const events: AgentEvent[] = [];
  const runtime = new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 });

  const result = await runtime.runTaskStream({ prompt: "empty final", timeoutMs: 100 }, (event) => events.push(event));

  assert.equal(result.text, "");
  assert.equal(events.filter((event) => event.type === "completed").at(-1)?.text, "");
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.abortCalls, 0);
}

async function testSubmittedSdkFailureNeverStartsLifecycleFallback(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.promptAsyncError = new Error("SDK submit failed");
  backend.readMessagesError = new Error("readback failed");
  backend.subscribe = async function* () {
    yield { type: "server.connected", properties: {} };
    while (!backend.subscriptionSignal?.aborted) await delay(1);
  };
  let lifecycleCalls = 0;
  const runtime = createAgentEventRuntimeWithFallback(
    lifecycleFallback(() => { lifecycleCalls += 1; }),
    new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 })
  );
  const events: AgentEvent[] = [];
  await assert.rejects(
    runtime.runTaskEvents({ prompt: "ping", timeoutMs: 1_000 }, (event) => events.push(event)),
    /readback failed/
  );
  assert.equal(backend.promptAsyncCalls, 1);
  assert.equal(backend.cliCalls, 0);
  assert.equal(lifecycleCalls, 0, "post-submit SDK failure must not execute lifecycle fallback");
  assert.equal(events.some((event) => event.data?.promptSubmitted === true), true);
}

async function testPreSpawnCliFailureAllowsLifecycleFallback(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    throw new Error("SSE unavailable");
  };
  backend.cliPromptSubmitted = false;
  backend.cliError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  let lifecycleCalls = 0;
  const runtime = createAgentEventRuntimeWithFallback(
    lifecycleFallback(() => { lifecycleCalls += 1; }),
    new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 })
  );
  const events: AgentEvent[] = [];
  const result = await runtime.runTaskEvents({ prompt: "ping", timeoutMs: 1_000 }, (event) => events.push(event));
  assert.equal(result.text, "LIFECYCLE");
  assert.equal(backend.cliCalls, 1);
  assert.equal(lifecycleCalls, 1, "a CLI failure before spawn must remain eligible for lifecycle fallback");
  assert.equal(events.some((event) => event.type === "prompt_sent" && event.data?.promptSubmitted === true), false);
}

async function testExactWriteFenceDisablesCliFallbacks(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    throw new Error("SSE unavailable");
  };
  let lifecycleCalls = 0;
  const runtime = createAgentEventRuntimeWithFallback(
    lifecycleFallback(() => { lifecycleCalls += 1; }),
    new OpenCodeRichRuntime({
      backend,
      sseReadyTimeoutMs: 20,
      recoveryPollMs: 1,
      vaultPath: "/vault"
    }),
    { exactWriteFenceSupport: "rich-only" }
  );
  const events: AgentEvent[] = [];
  const receipts: AgentExactWriteFenceReceipt[] = [];

  await assert.rejects(
    runtime.runTaskEvents({
      prompt: "maintain safely",
      permission: "workspace-write",
      writableRoots: ["/vault/wiki", "/vault/outputs"],
      requireExactWriteFence: true,
      exactWriteFence: {
        attemptToken: "attempt-opencode-fence",
        leaseToken: "lease-opencode-fence",
        deniedLivePaths: ["/live-vault"],
        deniedControlPaths: ["/shadow-control"]
      },
      onExactWriteFenceConfigured: (receipt) => {
        assert.equal(backend.promptAsyncCalls, 0, "the receipt callback must run before prompt submission");
        receipts.push(receipt);
      },
      timeoutMs: 1_000
    }, (event) => events.push(event)),
    /EXACT_WRITE_FENCE_UNAVAILABLE/
  );

  assert.equal(backend.promptAsyncCalls, 0, "an unavailable exact-fence rich transport must fail before prompt submission");
  assert.equal(backend.cliCalls, 0, "exact-fence tasks must never use OpenCode CLI fallback");
  assert.equal(lifecycleCalls, 0, "exact-fence tasks must never use the outer lifecycle fallback");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.backend, "opencode");
  assert.equal(receipts[0]?.attemptToken, "attempt-opencode-fence");
  assert.equal(receipts[0]?.leaseToken, "lease-opencode-fence");
  assert.deepEqual(receipts[0]?.enforcedWritableRoots, ["/vault/outputs", "/vault/wiki"]);
  assert.deepEqual(receipts[0]?.deniedLivePaths, ["/live-vault"]);
  assert.deepEqual(receipts[0]?.deniedControlPaths, ["/shadow-control"]);
  assert.match(receipts[0]?.configAckDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(events.some((event) => event.type === "fallback_started"), false);
  assert.equal(events.some((event) => event.type === "prompt_sent"), false);
  assert.equal(
    events.some((event) => event.type === "failed"
      && event.data?.failureCode === "EXACT_WRITE_FENCE_UNAVAILABLE"
      && event.data?.promptSubmitted === false),
    true
  );

  const cancelled = new AbortController();
  cancelled.abort();
  events.length = 0;
  await assert.rejects(
    (runtime as typeof runtime & {
      runTaskEvents(input: Parameters<typeof runtime.runTask>[0], emit: (event: AgentEvent) => void): Promise<AgentTaskResult>;
    }).runTaskEvents({
      prompt: "already canceled",
      permission: "workspace-write",
      writableRoots: ["/vault/wiki"],
      requireExactWriteFence: true,
      abortSignal: cancelled.signal
    }, (event) => events.push(event)),
    /取消/
  );
  assert.equal(
    events.some((event) => event.data?.failureCode === "EXACT_WRITE_FENCE_UNAVAILABLE"),
    false,
    "cancellation must not be reclassified as a switchable exact-fence capability failure"
  );
}

async function testHermesExactWriteFenceFailsBeforePromptSubmission(): Promise<void> {
  const runtime = createAgentTaskRuntime({
    backend: "hermes",
    settings: structuredClone(DEFAULT_SETTINGS),
    vaultPath: "/vault"
  });
  const events: AgentEvent[] = [];

  await assert.rejects(
    (runtime as typeof runtime & {
      runTaskEvents(input: Parameters<typeof runtime.runTask>[0], emit: (event: AgentEvent) => void): Promise<AgentTaskResult>;
    }).runTaskEvents({
      prompt: "maintain safely",
      permission: "workspace-write",
      writableRoots: ["/vault/wiki"],
      requireExactWriteFence: true
    }, (event) => events.push(event)),
    /EXACT_WRITE_FENCE_UNAVAILABLE.*Hermes CLI\/ACP/
  );

  assert.equal(events.some((event) => event.type === "prompt_sent"), false);
  assert.equal(events.some((event) => event.type === "fallback_started"), false);
  assert.equal(
    events.some((event) => event.type === "failed"
      && event.data?.failureCode === "EXACT_WRITE_FENCE_UNAVAILABLE"
      && event.data?.promptSubmitted === false),
    true
  );
}

async function testSubmittedCliFailureRecoversSameSessionWithoutLifecycleFallback(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    throw new Error("SSE unavailable");
  };
  backend.cliError = new Error("CLI stream disconnected");
  backend.sessionStatus = "idle";
  const recoveredMessage = completedAssistantMessage("assistant-cli-recovered", "CLI_RECOVERED");
  backend.messages = [[], [recoveredMessage], [recoveredMessage]];
  let lifecycleCalls = 0;
  const runtime = createAgentEventRuntimeWithFallback(
    lifecycleFallback(() => { lifecycleCalls += 1; }),
    new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 })
  );
  const events: AgentEvent[] = [];

  const result = await runtime.runTaskEvents({ prompt: "ping", timeoutMs: 1_000 }, (event) => events.push(event));

  assert.equal(result.text, "CLI_RECOVERED");
  assert.equal(backend.promptAsyncCalls, 0);
  assert.equal(backend.cliCalls, 1);
  assert.equal(lifecycleCalls, 0);
  assert.equal(backend.abortCalls, 0);
  assert.equal(events.filter((event) => event.type === "prompt_sent").length, 1);
  assert.equal(events.filter((event) => event.type === "completed").at(-1)?.data?.streamSource, "session-readback");
}

async function testSubmittedCliFailureNeverStartsLifecycleFallback(): Promise<void> {
  const backend = new FakeOpenCodeRichBackend();
  backend.subscribe = async function* () {
    throw new Error("SSE unavailable");
  };
  backend.cliError = new Error("CLI submit failed");
  backend.readMessagesError = new Error("CLI recovery readback failed");
  let lifecycleCalls = 0;
  const runtime = createAgentEventRuntimeWithFallback(
    lifecycleFallback(() => { lifecycleCalls += 1; }),
    new OpenCodeRichRuntime({ backend, sseReadyTimeoutMs: 20, recoveryPollMs: 1 })
  );
  const events: AgentEvent[] = [];
  await assert.rejects(
    runtime.runTaskEvents({ prompt: "ping", timeoutMs: 1_000 }, (event) => events.push(event)),
    /CLI recovery readback failed/
  );
  assert.equal(backend.promptAsyncCalls, 0);
  assert.equal(backend.cliCalls, 1);
  assert.equal(lifecycleCalls, 0, "post-submit CLI failure must not execute lifecycle fallback");
  assert.equal(events.some((event) => event.type === "prompt_sent" && event.data?.promptSubmitted === true), true);
}

async function testOpenCodeCommandSubmissionBoundary(): Promise<void> {
  let preSpawnSubmitted = false;
  await assert.rejects(
    runOpenCodeCommand({
      command: process.cwd(),
      args: [],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onSpawn: () => { preSpawnSubmitted = true; }
    }),
    /EACCES|permission denied/i
  );
  assert.equal(preSpawnSubmitted, false, "an asynchronous spawn error must remain before the submission boundary");

  let postSpawnSubmitted = false;
  await assert.rejects(
    runOpenCodeCommand({
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      onSpawn: () => { postSpawnSubmitted = true; }
    })
  );
  assert.equal(postSpawnSubmitted, true, "a successfully spawned CLI crosses the no-replay submission boundary even if it later fails");
}

function lifecycleFallback(onRun: () => void): AgentTaskRuntime {
  return {
    kind: "opencode",
    async connect() { return { connected: true, label: "OpenCode", errors: [] }; },
    async disconnect() {},
    async listModels() { return []; },
    async runTask() {
      onRun();
      return { text: "LIFECYCLE" };
    },
    async abort() {}
  };
}

async function testNodeFetchAcceptsNoContentResponse(): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await nodeFetch(`http://127.0.0.1:${address.port}/prompt-async`, { method: "POST" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testNodeFetchBridgesSseBodyWithoutReadableToWeb(): Promise<void> {
  let resolveConnectionClosed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    resolveConnectionClosed = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.once("close", resolveConnectionClosed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"type\":\"server.connected\"}\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  const originalToWeb = Readable.toWeb;
  Readable.toWeb = () => {
    throw new Error("Readable.toWeb must not bridge Electron response bodies");
  };
  try {
    const response = await Promise.race([
      nodeFetch(`http://127.0.0.1:${address.port}/event`, { signal: controller.signal }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE response was buffered")), 100))
    ]);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const chunk = await withTestTimeout(reader.read(), 250, "SSE body did not expose server.connected");
    assert.equal(chunk.done, false, "an open SSE response must not surface as an immediate EOF");
    assert.match(new TextDecoder().decode(chunk.value), /server\.connected/);
    const pendingRead = reader.read().then(
      (result) => result.done ? "done" : "value",
      (error) => error instanceof Error ? error.name : "error"
    );
    const beforeAbort = await Promise.race([
      pendingRead,
      delay(25).then(() => "pending")
    ]);
    assert.equal(beforeAbort, "pending", "the SSE body must remain open while the server connection is open");
    controller.abort();
    const abortResult = await Promise.race([
      pendingRead,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AbortSignal did not close SSE body")), 250))
    ]);
    assert.notEqual(abortResult, "value");
    await Promise.race([
      connectionClosed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AbortSignal did not close SSE socket")), 250))
    ]);
    await reader.cancel().catch(() => undefined);
  } finally {
    Readable.toWeb = originalToWeb;
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return await new Promise<void>(() => undefined);
  if (signal.aborted) throw abortErrorForTest();
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortErrorForTest()), { once: true });
  });
}

function abortErrorForTest(): Error {
  const error = new Error("test prompt aborted");
  error.name = "AbortError";
  return error;
}

function completedAssistantMessage(messageId: string, text: string): unknown {
  return {
    info: {
      id: messageId,
      sessionID: "session-a",
      role: "assistant",
      time: { created: 1, completed: 2 }
    },
    parts: [{ id: `${messageId}-text`, sessionID: "session-a", messageID: messageId, type: "text", text }]
  };
}

function completedToolAssistantMessage(messageId: string, text = ""): unknown {
  return {
    info: {
      id: messageId,
      sessionID: "session-a",
      role: "assistant",
      time: { created: 1, completed: 2 }
    },
    parts: [
      ...(text ? [{
        id: `${messageId}-text`,
        sessionID: "session-a",
        messageID: messageId,
        type: "text",
        text
      }] : []),
      {
        id: `${messageId}-tool`,
        sessionID: "session-a",
        messageID: messageId,
        type: "tool",
        callID: `${messageId}-call`,
        tool: "read",
        state: { status: "completed", input: { filePath: "testing/a.md" }, output: "A" }
      },
      {
        id: `${messageId}-finish`,
        sessionID: "session-a",
        messageID: messageId,
        type: "step-finish",
        reason: "tool-calls"
      }
    ]
  };
}

function failedAssistantMessage(messageId: string, text: string, message: string, createdAt = 1): unknown {
  return {
    info: {
      id: messageId,
      sessionID: "session-a",
      role: "assistant",
      finish: "error",
      error: { data: { message } },
      time: { created: createdAt, completed: createdAt + 1 }
    },
    parts: [
      ...(text ? [{ id: `${messageId}-text`, sessionID: "session-a", messageID: messageId, type: "text", text }] : []),
      { id: `${messageId}-finish`, sessionID: "session-a", messageID: messageId, type: "step-finish", reason: "error" }
    ]
  };
}

function harnessTypeForOpenCodeAgentEvent(type: AgentEvent["type"]): HarnessEventType | null {
  switch (type) {
    case "message_delta": return "agent.message.delta";
    case "message_completed": return "agent.message.completed";
    case "thinking_delta": return "agent.thinking.delta";
    case "thinking_completed": return "agent.thinking.completed";
    case "tool_call_requested": return "tool.requested";
    case "tool_call_delta": return "tool.output.delta";
    case "tool_call_completed": return "tool.completed";
    case "tool_call_failed": return "tool.failed";
    case "completed": return "run.completed";
    case "failed": return "run.failed";
    case "cancelled": return "run.cancelled";
    default: return null;
  }
}

function testResources() {
  return {
    promptPrefix: "RESOURCE-PREFIX",
    enabledResources: [],
    warnings: ["RESOURCE-WARNING"],
    mcpConfig: null,
    toolBridge: null
  };
}

function messageUpdated(sessionID: string, messageID: string): unknown {
  return {
    type: "message.updated",
    properties: { sessionID, info: { id: messageID, sessionID, role: "assistant" } }
  };
}

function partUpdated(sessionID: string, part: Record<string, unknown>): unknown {
  return {
    type: "message.part.updated",
    properties: { sessionID, part: { sessionID, ...part } }
  };
}

function fixtureRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class FakeOpenCodeRichBackend implements OpenCodeRichRuntimeBackend {
  promptAsyncCalls = 0;
  promptAsyncError: Error | null = null;
  cliCalls = 0;
  cliError: Error | null = null;
  cliPromptSubmitted = true;
  cliEvents: unknown[] = [];
  cliResult: AgentTaskResult = { text: "" };
  lastCliOptions: OpenCodeCliTaskOptions | null = null;
  lastPromptOptions: AgentPromptOptions | null = null;
  lastPromptSignal: AbortSignal | null = null;
  promptAsyncHandler: ((options: AgentPromptOptions, signal?: AbortSignal) => Promise<void>) | null = null;
  abortCalls = 0;
  permissionReplies: Array<{ requestId: string; reply: "once" | "always" | "reject" }> = [];
  messages: unknown[][] = [];
  readMessagesError: Error | null = null;
  sessionStatus: string | undefined;
  subscriptionSignal: AbortSignal | null = null;
  hasSessionResult = false;
  startSessionCalls = 0;
  permissionUpdates: Array<{ sessionId: string; permission: "read-only" | "workspace-write" | "danger-full-access"; writableRoots: string[] }> = [];
  subscribe: () => AsyncIterable<unknown> = async function* () {
    yield { type: "server.connected", properties: {} };
    yield { type: "session.idle", properties: { sessionID: "session-a" } };
  };

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  getConnectionInfo() {
    return { connected: true, serverUrl: "http://127.0.0.1:4096", command: "opencode", version: "1.4.3", errors: [] };
  }
  async listModels() { return []; }
  async listAgents() { return []; }
  async hasSession() { return this.hasSessionResult; }
  async updateSessionPermissions(sessionId: string, permission: "read-only" | "workspace-write" | "danger-full-access", writableRoots: string[] = []) {
    this.permissionUpdates.push({ sessionId, permission, writableRoots });
  }
  async deleteSession() { return true; }
  async startSession(_options: AgentSessionOptions) {
    this.startSessionCalls += 1;
    return { sessionId: "session-a", title: "test" };
  }
  async sendPromptAsync(options: AgentPromptOptions, signal?: AbortSignal) {
    this.promptAsyncCalls += 1;
    this.lastPromptOptions = options;
    this.lastPromptSignal = signal ?? null;
    if (this.promptAsyncError) throw this.promptAsyncError;
    if (this.promptAsyncHandler) await this.promptAsyncHandler(options, signal);
  }
  async subscribeEvents(signal: AbortSignal) {
    this.subscriptionSignal = signal;
    return this.subscribe();
  }
  async replyPermission(requestId: string, reply: "once" | "always" | "reject") {
    this.permissionReplies.push({ requestId, reply });
  }
  async getSessionStatus() { return this.sessionStatus; }
  async readSessionMessages() {
    if (this.readMessagesError) throw this.readMessagesError;
    return this.messages.shift() ?? [];
  }
  async runCliTask(options: OpenCodeCliTaskOptions) {
    this.cliCalls += 1;
    this.lastCliOptions = options;
    if (this.cliPromptSubmitted) options.onPromptSubmitted?.();
    if (this.cliError) throw this.cliError;
    for (const event of this.cliEvents) options.onEvent?.(event);
    return this.cliResult;
  }
  async abort() { this.abortCalls += 1; }
}
