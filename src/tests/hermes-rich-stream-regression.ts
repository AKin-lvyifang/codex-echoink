import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { AgentEvent } from "../agent/events";
import { AcpAgentRuntime } from "../agent/acp-runtime";
import { normalizeRichStreamEvents } from "../agent/rich-stream";

const HERMES_018_FIXTURE = JSON.parse(readFileSync(
  path.join(process.cwd(), "src/tests/fixtures/hermes-0.18-acp-rich-stream.json"),
  "utf8"
)) as {
  metadata: { version: string; transport: string };
  sessionId: string;
  updates: Record<string, unknown>[];
};

const REAL_HERMES_TOOL_CONTENT = [{
  type: "content",
  content: { type: "text", text: "Memory manage (memory)" }
}];

const normalized = normalizeRichStreamEvents([
  {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "I need to save this." }
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-hidden-input",
    title: "memory manage: memory",
    kind: "other",
    status: "pending",
    rawInput: null,
    content: REAL_HERMES_TOOL_CONTENT
  },
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-empty-input",
    title: "empty tool",
    rawInput: {},
    content: []
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-hidden-input",
    status: "completed",
    rawOutput: null,
    content: [{
      type: "content",
      content: { type: "text", text: "Memory saved" }
    }]
  }
], { backend: "hermes", runId: "hermes-run", now: () => 1 });

assert.equal(normalized[0].type, "thinking_delta");
assert.equal(normalized[0].text, "I need to save this.");
assert.equal(normalized[0].data?.reasoningKind, "provider");
assert.equal(normalized[0].data?.visibility, "public");

const hiddenInput = normalized[1];
assert.equal(hiddenInput.text, "Memory manage (memory)");
assert.equal(hiddenInput.data?.toolCallId, "tc-hidden-input");
assert.equal(hiddenInput.data?.callId, "tc-hidden-input");
assert.equal(hiddenInput.data?.toolStatus, "requested");
assert.equal(hiddenInput.data?.semanticKind, "tool");
assert.equal(hiddenInput.data?.providerKind, "other");
assert.equal(hiddenInput.data?.inputState, "unavailable");
assert.equal(hiddenInput.data?.rawInputState, "unavailable");
assert.equal(hiddenInput.data?.rawInput, null);
assert.equal(Object.prototype.hasOwnProperty.call(hiddenInput.data, "input"), false);
assert.equal(hiddenInput.data?.displayPreview, "Memory manage (memory)");

const emptyInput = normalized[2];
assert.equal(emptyInput.data?.inputState, "empty");
assert.deepEqual(emptyInput.data?.input, {});
assert.equal(emptyInput.data?.outputState, "unavailable");

const polishedCompletion = normalized[3];
assert.equal(polishedCompletion.type, "tool_call_completed");
assert.equal(polishedCompletion.text, "Memory saved");
assert.equal(polishedCompletion.data?.rawOutputState, "unavailable");
assert.equal(polishedCompletion.data?.rawOutput, null);
assert.equal(polishedCompletion.data?.outputState, "unavailable");
assert.equal(Object.prototype.hasOwnProperty.call(polishedCompletion.data ?? {}, "output"), false);
assert.equal(polishedCompletion.data?.displayPreview, "Memory saved");

const interrupted = normalizeRichStreamEvents([{
  sessionUpdate: "tool_call_update",
  toolCallId: "tc-cancelled",
  status: "cancelled",
  content: [{ type: "content", content: { type: "text", text: "Cancelled by provider" } }]
}], { backend: "hermes", runId: "hermes-run", now: () => 1 })[0];
assert.equal(interrupted.type, "tool_call_failed");
assert.equal(interrupted.status, "interrupted");
assert.equal(interrupted.data?.toolStatus, "interrupted");

let submittedPromptText = "";

const fakeAcp = createFakeAcpProcess((message, write) => {
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId: HERMES_018_FIXTURE.sessionId } });
    return;
  }
  if (message.method !== "session/prompt") return;
  submittedPromptText = String(message.params?.prompt?.[0]?.text ?? "");
  for (const update of HERMES_018_FIXTURE.updates) {
    notifyForSession(write, HERMES_018_FIXTURE.sessionId, update);
  }
  write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
});

const runtime = new AcpAgentRuntime({
  backend: "hermes",
  command: { command: "hermes", args: ["acp"], cwd: "/vault" },
  processFactory: () => fakeAcp.process
});
const streamed: AgentEvent[] = [];
const result = await runtime.runTaskStream({
  prompt: "remember marker",
  system: "CORE POLICY: read-only"
}, (event) => streamed.push(event));

assert.equal(HERMES_018_FIXTURE.metadata.version, "0.18.0");
assert.equal(HERMES_018_FIXTURE.metadata.transport, "ACP session/update");
assert.equal(result.text, "FIXTURE_DONE");
assert.deepEqual(result.terminalData, {
  messageId: `${HERMES_018_FIXTURE.sessionId}:message:1`,
  streamSource: "acp",
  promptSubmitted: true,
  unconfirmedToolCallCount: 1,
  unconfirmedToolCallIds: ["tc-fixture-a"]
});
const processEvents = streamed.filter((event) => [
  "thinking_delta",
  "thinking_completed",
  "tool_call_requested",
  "tool_call_delta",
  "tool_call_completed",
  "message_delta",
  "completed"
].includes(event.type));
assert.deepEqual(processEvents.map((event) => event.type), [
  "thinking_delta",
  "thinking_completed",
  "tool_call_requested",
  "thinking_delta",
  "thinking_completed",
  "tool_call_requested",
  "thinking_delta",
  "thinking_completed",
  "tool_call_completed",
  "message_delta",
  "tool_call_delta",
  "completed"
]);

const thoughtDeltas = processEvents.filter((event) => event.type === "thinking_delta");
assert.deepEqual(thoughtDeltas.map((event) => event.text), [
  "First provider thought.",
  "Second provider thought.",
  "Third provider thought."
]);
assert.equal(thoughtDeltas[0].data?.blockId, `${HERMES_018_FIXTURE.sessionId}:reasoning:1`);
assert.equal(thoughtDeltas[1].data?.blockId, `${HERMES_018_FIXTURE.sessionId}:reasoning:2`);
assert.equal(thoughtDeltas[2].data?.blockId, `${HERMES_018_FIXTURE.sessionId}:reasoning:3`);
assert.equal(processEvents[1].data?.boundary, "tool");
assert.equal(processEvents[4].data?.boundary, "tool");
assert.equal(processEvents[7].data?.boundary, "tool_terminal");

const completedTool = processEvents.find((event) => event.type === "tool_call_completed");
assert.equal(completedTool?.data?.callId, "tc-fixture-b");
assert.equal(completedTool?.toolName, "memory manage: memory");
assert.equal(completedTool?.data?.semanticKind, "edit");
assert.equal(completedTool?.data?.inputState, "provided");
assert.deepEqual(completedTool?.data?.input, { operation: "add", content: "fixture marker" });
assert.equal(completedTool?.data?.outputState, "unavailable");
assert.equal(Object.prototype.hasOwnProperty.call(completedTool?.data ?? {}, "output"), false);
assert.equal(completedTool?.data?.displayPreview, "Saved fixture marker");

const unconfirmedTool = processEvents.find((event) => event.type === "tool_call_delta" && event.status === "unconfirmed");
assert.equal(unconfirmedTool?.data?.callId, "tc-fixture-a");
assert.equal(unconfirmedTool?.toolName, "memory manage: memory");
assert.equal(unconfirmedTool?.data?.completionState, "unconfirmed");
assert.equal(unconfirmedTool?.data?.toolStatus, "unconfirmed");
assert.equal(unconfirmedTool?.data?.inputState, "unavailable");
assert.equal(Object.prototype.hasOwnProperty.call(unconfirmedTool?.data ?? {}, "input"), false);
assert.equal(unconfirmedTool?.text, "Memory manage (memory)");
assert.equal(unconfirmedTool?.data?.displayPreview, "Memory manage (memory)");
assert.equal(JSON.stringify(unconfirmedTool?.data).includes("2 B"), false);
assert.equal(processEvents.at(-1)?.data?.unconfirmedToolCallCount, 1);
assert.equal(processEvents.at(-1)?.data?.streamSource, "acp");
assert.equal(processEvents.at(-1)?.data?.promptSubmitted, true);
assert.deepEqual(processEvents.at(-1)?.data?.unconfirmedToolCallIds, ["tc-fixture-a"]);
assert.equal(
  processEvents.slice(0, -1).every((event) => event.data?.streamSource === "acp"),
  true,
  "Hermes provider events must retain their real stream source in Harness diagnostics"
);
assert.equal(streamed.some((event) => event.type === "tool_call_completed" && event.data?.callId === "tc-fixture-a"), false);
assert.match(submittedPromptText, /CORE POLICY: read-only/);
assert.equal(streamed.find((event) => event.type === "prompt_sent")?.data?.promptSubmitted, true);

await runtime.disconnect();

let permissionPromptRequestId: number | string | undefined;
const noIdAndPermissionAcp = createFakeAcpProcess((message, write) => {
  if (!message.method && message.id === 900 && permissionPromptRequestId !== undefined) {
    write({ jsonrpc: "2.0", id: permissionPromptRequestId, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === "session/new") {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "hermes-session-2" } });
    return;
  }
  if (message.method !== "session/prompt") return;
  permissionPromptRequestId = message.id;
  notifyForSession(write, "hermes-session-2", {
    sessionUpdate: "tool_call",
    title: "read note",
    kind: "read",
    status: "pending",
    rawInput: { path: "testing/no-id.md" }
  });
  notifyForSession(write, "hermes-session-2", {
    sessionUpdate: "tool_call_update",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "no-id done" } }]
  });
  write({
    jsonrpc: "2.0",
    id: 900,
    method: "session/request_permission",
    params: {
      sessionId: "hermes-session-2",
      toolCall: { id: "permission-call-1", title: "write note", kind: "edit", rawInput: { path: "testing/no-id.md" } }
    }
  });
});
const noIdRuntime = new AcpAgentRuntime({
  backend: "hermes",
  command: { command: "hermes", args: ["acp"], cwd: "/vault" },
  processFactory: () => noIdAndPermissionAcp.process
});
const noIdEvents: AgentEvent[] = [];
await noIdRuntime.runTaskStream({ prompt: "exercise missing ids" }, (event) => noIdEvents.push(event));
const noIdStart = noIdEvents.find((event) => event.type === "tool_call_requested" && event.toolName === "read note");
const noIdCompletion = noIdEvents.find((event) => event.type === "tool_call_completed");
assert.ok(noIdStart?.data?.callId);
assert.ok(noIdCompletion?.data?.callId);
assert.notEqual(
  noIdCompletion?.data?.callId,
  noIdStart?.data?.callId,
  "a completion without toolCallId must not be guessed onto an active Hermes tool"
);
const noIdUnconfirmed = noIdEvents.find((event) => event.type === "tool_call_delta"
  && event.status === "unconfirmed"
  && event.data?.callId === noIdStart?.data?.callId);
assert.ok(noIdUnconfirmed, "the unmatched Hermes tool start must settle as status unconfirmed");
const permission = noIdEvents.find((event) => event.type === "permission_requested");
const denied = noIdEvents.find((event) => event.type === "tool_call_failed" && event.status === "denied");
assert.equal(permission?.data?.callId, "permission-call-1");
assert.equal(permission?.data?.toolStatus, "approval");
assert.equal(permission?.data?.inputState, "provided");
assert.equal(denied?.data?.callId, "permission-call-1");
assert.equal(denied?.data?.toolStatus, "denied");
assert.equal(noIdEvents.at(-1)?.data?.unconfirmedToolCallCount, 1);
assert.ok(noIdEvents.findIndex((event) => event.type === "prompt_sent") < noIdEvents.findIndex((event) => event.type === "permission_requested"));
assert.ok(noIdEvents.findIndex((event) => event.type === "waiting") < noIdEvents.findIndex((event) => event.type === "permission_requested"));
await noIdRuntime.disconnect();

function notifyForSession(write: (message: unknown) => void, sessionId: string, update: Record<string, unknown>): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update }
  });
}

function createFakeAcpProcess(onRequest: (message: any, write: (message: unknown) => void) => void) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let inputBuffer = "";
  const write = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on("data", (chunk) => {
    inputBuffer += chunk.toString();
    for (;;) {
      const index = inputBuffer.indexOf("\n");
      if (index < 0) break;
      const line = inputBuffer.slice(0, index).trim();
      inputBuffer = inputBuffer.slice(index + 1);
      if (!line) continue;
      onRequest(JSON.parse(line), write);
    }
  });
  return {
    process: {
      stdin,
      stdout,
      stderr,
      kill: () => {
        stdin.end();
        stdout.end();
        stderr.end();
      },
      on: () => undefined
    }
  };
}
