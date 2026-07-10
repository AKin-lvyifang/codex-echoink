# Agent Events and MCP Bridge Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two known first-version limits: OpenCode/Hermes only have simple task status, and imported MCP resources are not truly cross-agent callable unless EchoInk owns their connection config.

**Architecture:** Add a backend-neutral `AgentEvent` layer first, then move OpenCode/Hermes simple paths onto that event layer without pretending they have Codex-level rich events. In parallel, move MCP callable state from ad hoc `metadata.mcp` into EchoInk-owned resource connection settings, with broker tests, UI status, approval, and logs.

**Tech Stack:** TypeScript, Obsidian plugin APIs, existing `npm run test` harness in `src/tests/run-tests.ts`, `@opencode-ai/sdk/v2`, Hermes CLI/API server, EchoInk Resource Registry.

---

## External Reference Findings

This plan was amended after reviewing Claudian and Agent Client implementation patterns:

- Agent Client uses ACP-compatible adapters such as `codex-acp` and receives `session/update` notifications for `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, permission, and terminal requests.
- Claudian uses a provider-neutral `StreamChunk` contract. Providers emit normalized chunks such as `text`, `thinking`, `tool_use`, `tool_result`, `usage`, and `done`; UI consumes those chunks through a common stream controller.
- Claudian's OpenCode path is ACP-based, not the current EchoInk one-shot `client.session.prompt()` path. Its OpenCode runtime starts an ACP subprocess, listens to session notifications, normalizes them, and queues stream chunks.
- Therefore EchoInk should not stop at lifecycle events. Lifecycle events are the fallback. The preferred path for OpenCode and Hermes is a rich stream adapter that maps native/ACP events into EchoInk events.
- "Thinking" means the backend exposes public thought/reasoning chunks or summaries. Do not promise hidden model chain-of-thought.

## Scope

This iteration is a hardening iteration after the Hermes first pass.

It must fix or reduce these concrete problems:

1. OpenCode/Hermes chat, knowledge tasks, and editor actions currently run through one-shot/simple paths.
2. The UI cannot show reliable non-Codex task phases beyond "running/completed/failed".
3. EchoInk MCP broker only treats resources with explicit `metadata.mcp` as callable.
4. Imported MCP resources can be visible in the catalog but not actually callable by EchoInk.
5. The UI has to keep telling the truth: imported-only is not callable, connectable is callable, verified is tested.
6. OpenCode/Hermes should support ACP-style rich output where available: streaming text, public thinking chunks, tool call start/update/result, plan, usage, permission, and terminal events.

Out of scope:

- Do not add Hermes dream/personality/memory automation in this iteration.
- Do not claim OpenCode/Hermes have Codex-level rich event streams unless the backend API actually exposes them.
- Do not write MCP enable/disable state back to Codex, Hermes, or OpenCode global config.
- Do not run full real Vault `/check` as an acceptance test; it can write real maintenance reports.

## Current Evidence

- `src/agent/registry.ts`: Codex has `richEvents: true`, OpenCode/Hermes have `richEvents: false`, `structuredToolCalls: false`, `nativeMcpPassThrough: false`.
- `src/agent/runtime.ts`: `AgentTaskRuntime` only exposes `runTask()`, not an event stream.
- `src/ui/codex-view/turn-runner.ts`: non-Codex chat goes through `startSimpleAgentChatTurn()` and `runAgentTaskOnce()`.
- `src/ui/codex-view/editor-action-runner.ts`: non-Codex editor actions go through `runSimpleEditorActionPromptTurn()` and `runAgentTaskOnce()`.
- `src/resources/mcp-broker.ts`: broker connection config only comes from `resource.metadata?.mcp`.
- `src/resources/mcp-loader.ts`: Codex/Hermes imported MCP resources do not include broker connection config, only metadata like status/tools count/config path.

## File Structure

Create:

- `src/agent/events.ts`
  - Owns `AgentEvent` types, event helpers, event ordering, and event-to-text helpers.
- `src/agent/event-task.ts`
  - Wraps existing `AgentTaskRuntime.runTask()` into a lifecycle event stream for backends without native rich events.
- `src/agent/rich-stream.ts`
  - Owns provider-neutral rich stream event helpers and capability checks.
- `src/agent/acp-runtime.ts`
  - Owns a small ACP-compatible subprocess/runtime adapter for backends that expose ACP-compatible command streams.
- `src/ui/codex-view/agent-event-renderer.ts`
  - Converts generic `AgentEvent` objects into chat/editor UI state updates.
- `src/resources/mcp-connections.ts`
  - Owns EchoInk MCP connection records, validation, normalization, display status, and config resolution.

Modify:

- `src/agent/types.ts`
  - Add event-capability fields only if needed by runtime contracts.
- `src/agent/runtime.ts`
  - Add optional event runtime interface without breaking current `runTask()`.
- `src/agent/factory.ts`
  - Expose `runTaskEvents()` behavior for OpenCode/Hermes through rich stream runtime, wrapper, or native implementation.
- `src/agent/simple-task.ts`
  - Keep compatibility wrapper but implement it by collecting `AgentEvent` output.
- `src/ui/codex-view/turn-runner.ts`
  - Replace non-Codex chat simple one-shot UI with event-driven rendering.
- `src/ui/codex-view/editor-action-runner.ts`
  - Replace non-Codex editor simple one-shot UI with event-driven status.
- `src/knowledge-base/manager.ts`
  - Wire OpenCode/Hermes task events into knowledge task status/logging where safe.
- `src/resources/types.ts`
  - Add EchoInk-owned MCP connection records to resource settings.
- `src/resources/registry.ts`
  - Resolve MCP callable state through EchoInk connection settings, not just `metadata.mcp`.
- `src/resources/mcp-broker.ts`
  - Accept connection settings and record richer broker statuses.
- `src/settings/settings.ts`
  - Normalize/migrate new `resources.mcpConnections`.
- `src/settings/settings-tab.ts`
  - Add Resource tab affordances: imported-only, missing config, connectable, verified, failed.
- `src/main.ts`
  - Update `listEchoInkMcpTools()` and `callEchoInkMcpTool()` to use EchoInk-owned connection settings.
- `src/tests/run-tests.ts`
  - Add tests before implementation for all behavior below.

Do not create a second test runner unless `src/tests/run-tests.ts` becomes unmaintainable during execution.

## Acceptance Criteria

- `npm run test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- `OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy` passes.
- Real Obsidian opens `/Users/lyuakin/Documents/AKin-note-management`.
- Real testing is limited to `/Users/lyuakin/Documents/AKin-note-management/testing/`.
- Codex chat still shows existing rich timeline events.
- OpenCode/Hermes chat use rich stream mode when the backend exposes it; otherwise they fall back to lifecycle mode.
- OpenCode/Hermes rich stream mode can show: streamed text, public thinking chunks, tool call start/update/result, usage, completed/failed.
- OpenCode/Hermes lifecycle fallback shows at least: connecting, session/run created, prompt sent, waiting, output received, completed/failed.
- OpenCode/Hermes editor actions show phase-specific status and still support candidate generation, `Esc` cancel, `Enter` confirm.
- Resource tab accurately distinguishes:
  - imported-only
  - missing connection config
  - connectable
  - verified
  - failed
- A manually configured MCP can list tools through fake transport in tests and through real UI if a safe local test MCP is available.
- No UI text claims "all imported MCP can be called automatically".

---

### Task 1: Agent Event Contract

**Files:**
- Create: `src/agent/events.ts`
- Modify: `src/agent/runtime.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for event shape and ordering**

Add tests near the existing agent registry/settings tests:

```ts
const agentEvents = makeAgentLifecycleEvents({
  backend: "hermes",
  runId: "run-1",
  title: "EchoInk test"
});
assert.deepEqual(agentEvents.map((event) => event.type), [
  "connecting",
  "run_started",
  "prompt_sent",
  "waiting"
]);
assert.equal(agentEvents[0].backend, "hermes");
assert.equal(agentEvents[0].runId, "run-1");
assert.equal(agentEventDisplayText({ type: "connecting", backend: "opencode", createdAt: 1 }), "OpenCode 连接中");
assert.equal(agentEventDisplayText({ type: "completed", backend: "hermes", createdAt: 1, text: "PONG" }), "PONG");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing `makeAgentLifecycleEvents` / `agentEventDisplayText`.

- [ ] **Step 3: Implement event types and helpers**

Create `src/agent/events.ts`:

```ts
import type { AgentBackendKind } from "./types";

export type AgentEventType =
  | "connecting"
  | "connected"
  | "run_started"
  | "prompt_sent"
  | "waiting"
  | "message_delta"
  | "message_completed"
  | "tool_call_requested"
  | "tool_call_completed"
  | "file_status"
  | "usage"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentEvent {
  type: AgentEventType;
  backend: AgentBackendKind;
  createdAt: number;
  runId?: string;
  title?: string;
  text?: string;
  status?: string;
  toolName?: string;
  resourceId?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
```

Add helpers:

```ts
export function makeAgentLifecycleEvents(input: {
  backend: AgentBackendKind;
  runId?: string;
  title?: string;
  now?: () => number;
}): AgentEvent[] {
  const now = input.now ?? Date.now;
  return ["connecting", "run_started", "prompt_sent", "waiting"].map((type) => ({
    type: type as AgentEventType,
    backend: input.backend,
    runId: input.runId,
    title: input.title,
    createdAt: now()
  }));
}
```

- [ ] **Step 4: Add optional event runtime interface**

Modify `src/agent/runtime.ts`:

```ts
import type { AgentEventSink } from "./events";

export interface AgentEventTaskRuntime extends AgentTaskRuntime {
  runTaskEvents(input: AgentTaskInput, emit: AgentEventSink): Promise<AgentTaskResult>;
}
```

Keep `AgentTaskRuntime.runTask()` intact for compatibility.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/events.ts src/agent/runtime.ts src/tests/run-tests.ts
git commit -m "feat: add agent event contract"
```

---

### Task 2: Event Wrapper for Non-Rich Backends

**Files:**
- Create: `src/agent/event-task.ts`
- Modify: `src/agent/simple-task.ts`
- Modify: `src/agent/factory.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for wrapping existing runtimes**

Add tests using a fake runtime:

```ts
const emitted: AgentEvent[] = [];
const fakeRuntime: AgentTaskRuntime = {
  kind: "hermes",
  async connect() { return { connected: true, label: "Hermes", errors: [] }; },
  async listModels() { return []; },
  async runTask(input) {
    input.onRunId?.("hermes-run-1");
    return { text: "PONG", runId: "hermes-run-1", usage: { outputTokens: 1 } };
  },
  async abort() {}
};
const wrapped = await runTaskWithLifecycleEvents(fakeRuntime, {
  prompt: "只回复 PONG",
  timeoutMs: 1000
}, (event) => emitted.push(event));
assert.equal(wrapped.text, "PONG");
assert.deepEqual(emitted.map((event) => event.type), [
  "connecting",
  "connected",
  "run_started",
  "prompt_sent",
  "waiting",
  "message_completed",
  "usage",
  "completed"
]);
assert.equal(emitted.find((event) => event.type === "run_started")?.runId, "hermes-run-1");
```

Add failure test:

```ts
const failedEvents: AgentEvent[] = [];
await assert.rejects(
  runTaskWithLifecycleEvents({
    ...fakeRuntime,
    async runTask() { throw new Error("provider missing"); }
  }, { prompt: "x" }, (event) => failedEvents.push(event)),
  /provider missing/
);
assert.equal(failedEvents.at(-1)?.type, "failed");
assert.equal(failedEvents.at(-1)?.error, "provider missing");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing `runTaskWithLifecycleEvents`.

- [ ] **Step 3: Implement lifecycle wrapper**

Create `src/agent/event-task.ts`:

```ts
export async function runTaskWithLifecycleEvents(
  runtime: AgentTaskRuntime,
  input: AgentTaskInput,
  emit: AgentEventSink
): Promise<AgentTaskResult> {
  let runId = "";
  const emitNow = async (event: Omit<AgentEvent, "backend" | "createdAt">) => {
    await emit({ ...event, backend: runtime.kind, createdAt: Date.now(), runId: event.runId ?? runId });
  };
  try {
    await emitNow({ type: "connecting" });
    await runtime.connect();
    await emitNow({ type: "connected" });
    const resultPromise = runtime.runTask({
      ...input,
      onRunId: (id) => {
        runId = id;
        input.onRunId?.(id);
        void emitNow({ type: "run_started", runId: id });
      }
    });
    await emitNow({ type: "prompt_sent" });
    await emitNow({ type: "waiting" });
    const result = await resultPromise;
    if (!runId && result.runId) {
      runId = result.runId;
      await emitNow({ type: "run_started", runId });
    }
    await emitNow({ type: "message_completed", text: result.text });
    if (result.usage) await emitNow({ type: "usage", data: result.usage });
    await emitNow({ type: "completed", text: result.text });
    return result;
  } catch (error) {
    await emitNow({ type: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
```

During implementation, avoid duplicate `run_started` events if `onRunId` fires before result.

- [ ] **Step 4: Keep `runAgentTaskOnce()` compatible**

Modify `src/agent/simple-task.ts` so it can either:

- call a new `runAgentTaskWithEvents()` and collect final output, or
- keep current direct backend calls but expose a shared helper used by UI.

Acceptance inside code: no duplicate OpenCode/Hermes backend creation logic should be added.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/event-task.ts src/agent/simple-task.ts src/agent/factory.ts src/tests/run-tests.ts
git commit -m "feat: wrap simple agents with lifecycle events"
```

---

### Task 2A: Rich Agent Stream Adapter for OpenCode and Hermes

**Files:**
- Create: `src/agent/rich-stream.ts`
- Create: `src/agent/acp-runtime.ts`
- Modify: `src/agent/events.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/factory.ts`
- Modify: `src/core/opencode-backend.ts`
- Modify: `src/core/hermes-backend.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for rich stream event contract**

Add tests before implementation:

```ts
const richEvents = normalizeRichStreamEvents([
  { type: "agent_message_chunk", text: "Hel" },
  { type: "agent_message_chunk", text: "lo" },
  { type: "agent_thought_chunk", text: "Need read file" },
  { type: "tool_call", toolCallId: "tool-1", title: "Read note", status: "in_progress", rawInput: { path: "testing/a.md" } },
  { type: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", text: "done" }] },
  { type: "usage_update", inputTokens: 10, outputTokens: 2 }
], { backend: "opencode", runId: "run-1", now: () => 1 });

assert.deepEqual(richEvents.map((event) => event.type), [
  "message_delta",
  "message_delta",
  "thinking_delta",
  "tool_call_requested",
  "tool_call_completed",
  "usage"
]);
assert.equal(richEvents[0].text, "Hel");
assert.equal(richEvents[2].text, "Need read file");
assert.equal(richEvents[3].toolName, "Read note");
```

Add a privacy test:

```ts
assert.equal(agentEventDisplayText({
  type: "thinking_delta",
  backend: "hermes",
  createdAt: 1,
  text: "public summary"
}), "public summary");
assert.doesNotMatch(agentEventDisplayText({
  type: "thinking_delta",
  backend: "hermes",
  createdAt: 1,
  text: ""
}), /chain-of-thought/i);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing `normalizeRichStreamEvents` and `thinking_delta`.

- [ ] **Step 3: Extend AgentEvent for rich stream**

Modify `src/agent/events.ts`:

```ts
export type AgentEventType =
  | "connecting"
  | "connected"
  | "run_started"
  | "prompt_sent"
  | "waiting"
  | "message_delta"
  | "message_completed"
  | "thinking_delta"
  | "thinking_completed"
  | "tool_call_requested"
  | "tool_call_delta"
  | "tool_call_completed"
  | "tool_call_failed"
  | "permission_requested"
  | "terminal_output"
  | "file_status"
  | "plan_updated"
  | "usage"
  | "completed"
  | "failed"
  | "cancelled";
```

Rules:

- `thinking_delta` is only displayed when the backend explicitly provides public thought/reasoning content.
- Do not synthesize hidden chain-of-thought.
- Tool call events must include stable `toolCallId` in `data` or a dedicated field.

- [ ] **Step 4: Add rich stream runtime interface**

Modify `src/agent/runtime.ts`:

```ts
export interface AgentRichStreamRuntime extends AgentTaskRuntime {
  runTaskStream(input: AgentTaskInput, emit: AgentEventSink): Promise<AgentTaskResult>;
}
```

Runtime selection rule:

1. If backend has native rich stream or ACP-compatible adapter, use `runTaskStream`.
2. If not, use lifecycle wrapper from Task 2.

- [ ] **Step 5: Implement ACP-compatible runtime adapter skeleton**

Create `src/agent/acp-runtime.ts`.

Responsibilities:

- Spawn configured ACP-compatible command.
- Speak newline-delimited JSON-RPC / ACP-compatible messages.
- Subscribe to session update notifications.
- Map updates into `AgentEvent`.
- Support cancel.
- Never write files directly; file/tool effects remain owned by the backend or EchoInk broker.

First target:

- OpenCode, if an ACP-compatible command is available.
- Codex can remain on existing app-server path.
- Hermes only uses this path if Hermes exposes ACP-compatible or stream API events.

- [ ] **Step 6: Investigate and wire OpenCode rich path**

Modify `src/core/opencode-backend.ts` or add a sibling runtime path.

Implementation decision:

- Prefer OpenCode ACP mode if available from installed OpenCode or a configured adapter command.
- Fall back to current SDK `sendPrompt()` one-shot path when ACP/rich mode is unavailable.

Test expectations:

- Fake ACP transport emits message/thought/tool events and EchoInk receives rich `AgentEvent`s.
- If fake ACP startup fails, runtime falls back to lifecycle wrapper and emits a clear warning event.

- [ ] **Step 7: Investigate and wire Hermes rich path**

Modify `src/core/hermes-backend.ts` or add a sibling runtime path.

Implementation decision:

- Prefer Hermes API server streaming/events if available.
- If Hermes has no stream endpoint, keep lifecycle fallback.
- If Hermes can output JSON event logs or ACP-compatible events, map those events.

Test expectations:

- Fake Hermes stream endpoint can emit text/thinking/tool events.
- Missing stream support does not break current CLI fallback.

- [ ] **Step 8: Update UI renderer for rich blocks**

Modify `src/ui/codex-view/agent-event-renderer.ts` in Task 3 implementation:

- `message_delta` appends streamed assistant text.
- `thinking_delta` creates/updates a collapsed "Thinking" block.
- `tool_call_requested` creates a tool call block.
- `tool_call_delta` updates input/output preview.
- `tool_call_completed` marks tool call complete.
- `tool_call_failed` marks tool call failed.
- `permission_requested` renders an approval request if available.
- `terminal_output` renders terminal output block if available.

- [ ] **Step 9: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 10: Commit**

```bash
git add src/agent/rich-stream.ts src/agent/acp-runtime.ts src/agent/events.ts src/agent/runtime.ts src/agent/factory.ts src/core/opencode-backend.ts src/core/hermes-backend.ts src/tests/run-tests.ts
git commit -m "feat: add rich agent stream adapter"
```

---

### Task 3: Chat UI Uses Agent Events for OpenCode/Hermes

**Files:**
- Create: `src/ui/codex-view/agent-event-renderer.ts`
- Modify: `src/ui/codex-view/turn-runner.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for event-to-chat rendering**

Add pure tests:

```ts
let state = createAgentEventRenderState("hermes");
state = reduceAgentEventForChat(state, { type: "connecting", backend: "hermes", createdAt: 1 });
assert.equal(state.status, "running");
assert.match(state.text, /Hermes 连接中/);
state = reduceAgentEventForChat(state, { type: "run_started", backend: "hermes", runId: "h1", createdAt: 2 });
assert.match(state.text, /运行已开始/);
state = reduceAgentEventForChat(state, { type: "message_completed", backend: "hermes", text: "PONG", createdAt: 3 });
assert.equal(state.text, "PONG");
state = reduceAgentEventForChat(state, { type: "completed", backend: "hermes", text: "PONG", createdAt: 4 });
assert.equal(state.status, "completed");
assert.equal(state.text, "PONG");
```

Failure case:

```ts
state = reduceAgentEventForChat(state, { type: "failed", backend: "opencode", error: "timeout", createdAt: 5 });
assert.equal(state.status, "failed");
assert.equal(state.itemType, "error");
assert.match(state.text, /timeout/);
```

Add rich stream rendering tests:

```ts
state = createAgentEventRenderState("opencode");
state = reduceAgentEventForChat(state, { type: "message_delta", backend: "opencode", text: "Hel", createdAt: 1 });
state = reduceAgentEventForChat(state, { type: "message_delta", backend: "opencode", text: "lo", createdAt: 2 });
assert.equal(state.text, "Hello");
state = reduceAgentEventForChat(state, { type: "thinking_delta", backend: "opencode", text: "Need inspect file", createdAt: 3 });
assert.equal(state.thinkingBlocks?.at(-1)?.text, "Need inspect file");
state = reduceAgentEventForChat(state, { type: "tool_call_requested", backend: "opencode", toolName: "Read", data: { toolCallId: "t1", input: { path: "testing/a.md" } }, createdAt: 4 });
assert.equal(state.toolCalls?.[0]?.status, "running");
state = reduceAgentEventForChat(state, { type: "tool_call_completed", backend: "opencode", toolName: "Read", data: { toolCallId: "t1", output: "done" }, createdAt: 5 });
assert.equal(state.toolCalls?.[0]?.status, "completed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing renderer helpers.

- [ ] **Step 3: Implement renderer helpers**

Create `src/ui/codex-view/agent-event-renderer.ts` with pure functions only:

```ts
export interface AgentChatRenderState {
  status: "running" | "completed" | "failed";
  itemType: "assistant" | "error";
  title: string;
  text: string;
  runId?: string;
}
```

Rules:

- `message_completed` replaces placeholder text with actual output.
- `message_delta` appends text if the backend later supports streaming.
- `completed` keeps final output and marks completed.
- `failed` marks error.
- `tool_call_requested` and `tool_call_completed` render as process text only if implemented in Task 7.

- [ ] **Step 4: Wire non-Codex chat path**

Modify `src/ui/codex-view/turn-runner.ts`:

- Keep Codex path unchanged.
- Replace `runAgentTaskOnce()` in `startSimpleAgentChatTurn()` with event wrapper.
- On each event:
  - reduce assistant message state
  - persist externalized text only at terminal states or throttled intervals
  - render active session
  - keep queue behavior unchanged

Guardrails:

- Do not introduce Codex-specific notification handling into generic events.
- Do not show "thinking" or "tool" details for OpenCode/Hermes unless the event exists.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/codex-view/agent-event-renderer.ts src/ui/codex-view/turn-runner.ts src/tests/run-tests.ts
git commit -m "feat: render simple agent chat events"
```

---

### Task 4: Editor Actions Use Agent Events for OpenCode/Hermes

**Files:**
- Modify: `src/ui/codex-view/agent-event-renderer.ts`
- Modify: `src/ui/codex-view/editor-action-runner.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for editor event status mapping**

Add pure tests:

```ts
const editorConnecting = agentEventToEditorStatus({
  event: { type: "connecting", backend: "hermes", createdAt: 1 },
  actionLabel: "续写",
  qualityMode: "quality",
  modeLabel: "平衡",
  phase: "generating",
  model: "",
  startedAt: 1
});
assert.equal(editorConnecting.status, "generating");
assert.match(editorConnecting.message ?? "", /Hermes 连接中/);

const editorFailed = agentEventToEditorStatus({
  event: { type: "failed", backend: "opencode", createdAt: 2, error: "model missing" },
  actionLabel: "改写",
  qualityMode: "fast",
  modeLabel: "快速",
  phase: "generating",
  model: "",
  startedAt: 1
});
assert.equal(editorFailed.status, "failed");
assert.match(editorFailed.message ?? "", /model missing/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing `agentEventToEditorStatus`.

- [ ] **Step 3: Implement editor status mapping**

Add pure function to `agent-event-renderer.ts`:

```ts
export function agentEventToEditorStatus(input: {
  event: AgentEvent;
  actionLabel: string;
  qualityMode: EditorActionQualityMode;
  modeLabel: string;
  phase: "understanding" | "generating" | "reviewing";
  model: string;
  startedAt: number;
}): EditorActionStatusPatch
```

Use existing status labels and do not change candidate validation behavior.

- [ ] **Step 4: Wire non-Codex editor action path**

Modify `runSimpleEditorActionPromptTurn()`:

- Use event wrapper.
- Update `view.setEditorActionStatus()` on lifecycle events.
- Keep final clean/validate/confirm logic unchanged.
- Keep `view.resolveEditorActionRun(cleaned)` only after final output is available.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Real Obsidian editor smoke test**

After deployment in Task 9, use `/Users/lyuakin/Documents/AKin-note-management/testing/`:

- Create or reuse `testing/Codex 续写插入验收.md`.
- Temporarily switch editor action backend to Hermes.
- Generate candidate.
- Press `Esc`; file hash must not change.
- Generate again.
- Press `Enter`; file hash must change.
- Restore original settings and test note.

- [ ] **Step 7: Commit**

```bash
git add src/ui/codex-view/agent-event-renderer.ts src/ui/codex-view/editor-action-runner.ts src/tests/run-tests.ts
git commit -m "feat: render simple agent editor events"
```

---

### Task 5: EchoInk-Owned MCP Connection Settings

**Files:**
- Create: `src/resources/mcp-connections.ts`
- Modify: `src/resources/types.ts`
- Modify: `src/settings/settings.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for connection normalization**

Add tests:

```ts
const normalizedMcpConnections = normalizeMcpConnectionRecords({
  "manual:mcp-server:notes": {
    transport: "stdio",
    command: " node ",
    args: ["server.js"],
    env: { TOKEN: "abc", EMPTY: "" },
    cwd: "/vault",
    verifiedAt: 123,
    lastError: ""
  },
  "bad:mcp": { transport: "stdio", command: "" }
});
assert.equal(normalizedMcpConnections["manual:mcp-server:notes"].transport, "stdio");
assert.equal(normalizedMcpConnections["manual:mcp-server:notes"].command, "node");
assert.equal(normalizedMcpConnections["manual:mcp-server:notes"].env?.TOKEN, "abc");
assert.equal(normalizedMcpConnections["bad:mcp"], undefined);
```

Add HTTP test:

```ts
const httpConnections = normalizeMcpConnectionRecords({
  "manual:mcp-server:http": {
    transport: "http",
    url: " http://127.0.0.1:3333/mcp ",
    headers: { Authorization: "Bearer test" }
  }
});
assert.equal(httpConnections["manual:mcp-server:http"].url, "http://127.0.0.1:3333/mcp");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing `normalizeMcpConnectionRecords`.

- [ ] **Step 3: Add connection record types**

Modify `src/resources/types.ts`:

```ts
export type EchoInkMcpConnectionRecord = EchoInkMcpConnectionConfig & {
  verifiedAt?: number;
  lastError?: string;
};

export type EchoInkMcpConnectionRecords = Record<string, EchoInkMcpConnectionRecord>;
```

Modify `EchoInkResourceSettings`:

```ts
mcpConnections: EchoInkMcpConnectionRecords;
```

- [ ] **Step 4: Implement normalization**

Create `src/resources/mcp-connections.ts`:

- `normalizeMcpConnectionRecords(value: unknown): EchoInkMcpConnectionRecords`
- `resolveMcpConnectionConfig(resource, settings)`
- `mcpConnectionStatus(resource, settings)`

Status values:

```ts
type EchoInkMcpConnectionStatus =
  | "not-mcp"
  | "imported-only"
  | "missing-config"
  | "connectable"
  | "verified"
  | "failed";
```

Resolution order:

1. `settings.mcpConnections[resource.id]`
2. legacy `resource.metadata.mcp`
3. none

- [ ] **Step 5: Migrate settings**

Modify `src/settings/settings.ts`:

- `defaultResourceSettings()` includes `mcpConnections: {}`.
- `normalizeResourceSettings()` preserves valid old `resources.mcpConnections`.
- Do not auto-copy every imported MCP into `mcpConnections`; imported resources without config must remain imported-only.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/resources/mcp-connections.ts src/resources/types.ts src/settings/settings.ts src/tests/run-tests.ts
git commit -m "feat: store echoink mcp connections"
```

---

### Task 6: MCP Broker Uses EchoInk Connection Records

**Files:**
- Modify: `src/resources/mcp-broker.ts`
- Modify: `src/resources/registry.ts`
- Modify: `src/main.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for broker config resolution**

Add tests:

```ts
const importedMcp: EchoInkResource = {
  id: "hermes-import:mcp-server:memory",
  kind: "mcp-server",
  source: "hermes-import",
  name: "memory",
  description: "",
  enabled: true,
  scopes: ["chat"],
  bridgeMode: "native-mcp"
};
assert.equal(mcpConnectionStatus(importedMcp, { mcpConnections: {} } as any), "imported-only");
assert.equal(resolveMcpConnectionConfig(importedMcp, { mcpConnections: {} } as any), null);

const withConnection = {
  mcpConnections: {
    "hermes-import:mcp-server:memory": {
      transport: "stdio",
      command: "memory-mcp"
    }
  }
} as any;
assert.equal(mcpConnectionStatus(importedMcp, withConnection), "connectable");
assert.equal(resolveMcpConnectionConfig(importedMcp, withConnection)?.transport, "stdio");
```

Add broker list-tools test with fake transport:

```ts
const broker = new EchoInkMcpBroker({
  settings: { approvalMode: "ask", callLog: [] },
  connections: withConnection.mcpConnections,
  transportFactory: async () => fakeMcpTransportReturningTools(["search_notes"])
});
const tools = await broker.listTools(importedMcp, 1000);
assert.deepEqual(tools.tools.map((tool: any) => tool.name), ["search_notes"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL because broker does not accept `connections`.

- [ ] **Step 3: Update broker options**

Modify `src/resources/mcp-broker.ts`:

```ts
export interface EchoInkMcpBrokerOptions {
  settings: EchoInkMcpBrokerSettings;
  connections?: EchoInkMcpConnectionRecords;
  approval?: ...
}
```

Replace direct `mcpBrokerConnectionConfig(resource)` calls with `resolveMcpConnectionConfig(resource, this.options)`.

Keep legacy `metadata.mcp` support for existing tests and manual resources.

- [ ] **Step 4: Update registry preparation**

Modify `src/resources/registry.ts`:

- `prepareAgentResources()` must accept resource settings or connection records.
- Broker-ready resources are those with `connectable`, `verified`, or legacy metadata connection.
- Imported-only resources must generate warning text, not callable tool bridge.

- [ ] **Step 5: Update plugin broker entrypoints**

Modify `src/main.ts`:

- `listEchoInkMcpTools()` passes `this.settings.resources.mcpConnections`.
- `callEchoInkMcpTool()` passes `this.settings.resources.mcpConnections`.
- On successful list/call, update `verifiedAt`.
- On failure, update `lastError`.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/resources/mcp-broker.ts src/resources/registry.ts src/main.ts src/tests/run-tests.ts
git commit -m "feat: resolve mcp broker connections from echoink settings"
```

---

### Task 7: Resource Tab Connection UX

**Files:**
- Modify: `src/settings/settings-tab.ts`
- Modify: `src/settings/i18n.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for labels and source assertions**

Add source-level assertions near existing settings tab source tests:

```ts
assert.match(settingsTabSource, /mcpConnectionStatus/);
assert.match(settingsTabSource, /补全连接配置|Configure connection/);
assert.match(settingsTabSource, /测试连接|Test connection/);
assert.match(settingsTabSource, /仅导入|Imported only/);
assert.match(settingsTabSource, /已验证|Verified/);
```

Add pure label tests if labels are exported:

```ts
assert.equal(mcpConnectionStatusLabel("imported-only", "zh-CN"), "仅导入");
assert.equal(mcpConnectionStatusLabel("connectable", "zh-CN"), "可连接");
assert.equal(mcpConnectionStatusLabel("verified", "zh-CN"), "已验证");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing labels/actions.

- [ ] **Step 3: Add status labels**

Modify `src/settings/i18n.ts` and/or local helpers:

- `not-mcp`: empty
- `imported-only`: `仅导入`
- `missing-config`: `缺连接配置`
- `connectable`: `可连接`
- `verified`: `已验证`
- `failed`: `连接失败`

- [ ] **Step 4: Add connection actions in Resource tab**

Modify resource cards for MCP:

- Show current status.
- If imported-only or missing config: show `补全连接配置`.
- If connectable/verified/failed: show `测试连接`.
- Do not expose secret values in normal card text.

First implementation can use a small modal or existing settings controls. Required fields:

- stdio: command, args, cwd, env
- http: url, headers

Keep it simple:

- command/url required
- args/env/headers optional JSON textarea or newline key-value textarea
- invalid input shows Notice and does not save

- [ ] **Step 5: Add test connection action**

`测试连接` should call `plugin.listEchoInkMcpTools(resource.id)`.

On success:

- set `verifiedAt`
- clear `lastError`
- save settings
- show tools count

On failure:

- set `lastError`
- save settings
- show Notice

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/settings/settings-tab.ts src/settings/i18n.ts src/tests/run-tests.ts
git commit -m "feat: add mcp connection controls"
```

---

### Task 8: Tool Bridge Truthfulness and Guardrails

**Files:**
- Modify: `src/resources/registry.ts`
- Modify: `src/agent/registry.ts`
- Modify: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for bridge truth table**

Add tests:

```ts
const importedOnlyPrepared = prepareAgentResources([importedMcp], {
  scope: "chat",
  backendCapabilities: getAgentBackendDefinition("hermes").capabilities,
  enabledByScope: { chat: { [importedMcp.id]: true } },
  mcpConnections: {}
});
assert.equal(importedOnlyPrepared.toolBridge?.ready, false);
assert.equal(importedOnlyPrepared.toolBridge?.mode, "disabled");
assert.ok(importedOnlyPrepared.warnings.some((warning) => warning.includes("不可直接调用 MCP")));

const structuredPrepared = prepareAgentResources([importedMcp], {
  scope: "chat",
  backendCapabilities: {
    ...getAgentBackendDefinition("hermes").capabilities,
    structuredToolCalls: true
  },
  enabledByScope: { chat: { [importedMcp.id]: true } },
  mcpConnections: withConnection.mcpConnections
});
assert.equal(structuredPrepared.toolBridge?.ready, true);
assert.equal(structuredPrepared.toolBridge?.mode, "structured-tools");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL if `prepareAgentResources()` cannot accept `mcpConnections`.

- [ ] **Step 3: Update prepare input**

Modify `PrepareAgentResourcesInput`:

```ts
mcpConnections?: EchoInkMcpConnectionRecords;
```

Use it to decide broker-ready status.

- [ ] **Step 4: Keep OpenCode/Hermes honest**

Do not set `structuredToolCalls: true` for OpenCode or Hermes in `src/agent/registry.ts` unless this iteration also implements a real request/response loop from those backends.

The acceptable state after this task:

- Codex native MCP still works through its existing path.
- OpenCode/Hermes get prompt-only skills.
- OpenCode/Hermes see MCP warnings unless a real structured tool bridge is added later.
- Broker can list/call tools from UI and future structured runtimes.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/resources/registry.ts src/agent/registry.ts src/tests/run-tests.ts
git commit -m "fix: keep mcp bridge capability truthful"
```

---

### Task 9: Knowledge Task Event Hooks

**Files:**
- Modify: `src/knowledge-base/manager.ts`
- Modify: `src/knowledge-base/journal.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for non-Codex task failure context**

Add or extend tests that assert failure context includes backend and phase:

```ts
const hermesFailureContext = formatAgentTaskFailureContext({
  backend: "hermes",
  phase: "waiting",
  runId: "h1",
  message: "provider missing"
});
assert.match(hermesFailureContext, /后端：hermes/);
assert.match(hermesFailureContext, /阶段：waiting/);
assert.match(hermesFailureContext, /provider missing/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`

Expected: FAIL with missing helper or missing phase.

- [ ] **Step 3: Track last event phase in knowledge manager**

Modify `sendHermesTaskWithGuards()` and `sendOpenCodeTaskWithGuards()`:

- Use event wrapper.
- Store last event type/phase.
- On timeout/failure, include backend, runId, phase, and original error.

Do not render every knowledge task event into chat messages unless the UI already has a safe place for it. The minimum target is better diagnostics.

- [ ] **Step 4: Update journal evidence wording**

Modify `src/knowledge-base/journal.ts` only if journal currently says Codex-specific text for OpenCode/Hermes evidence.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge-base/manager.ts src/knowledge-base/journal.ts src/tests/run-tests.ts
git commit -m "feat: add agent task phase diagnostics"
```

---

### Task 10: Regression and Real Obsidian Verification

**Files:**
- Modify only if bugs are found during verification.

- [ ] **Step 1: Full local verification**

Run:

```bash
npm run test
npm run typecheck
npm run build
```

Expected:

- `npm run test`: `All tests passed`
- `npm run typecheck`: no TypeScript errors
- `npm run build`: production bundle generated

- [ ] **Step 2: Deploy to real Vault**

Run:

```bash
OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy
```

Expected: deploy succeeds and writes plugin assets under:

`/Users/lyuakin/Documents/AKin-note-management/.obsidian/plugins/codex-echoink`

- [ ] **Step 3: Verify deployed bundle hash**

Run:

```bash
shasum dist/main.js /Users/lyuakin/Documents/AKin-note-management/.obsidian/plugins/codex-echoink/main.js
```

Expected: both hashes match.

- [ ] **Step 4: Real Obsidian chat verification**

In real Obsidian:

- Open `/Users/lyuakin/Documents/AKin-note-management`.
- Temporarily set default backend to Hermes.
- Send normal chat: `只回复 PONG`.
- Verify UI shows rich stream blocks if Hermes exposes stream events; otherwise verify lifecycle fallback.
- Verify final answer is `PONG`.
- Restore default backend.

Repeat with OpenCode:

- Temporarily set default backend to OpenCode.
- Send a safe prompt that requires reading a file in `testing/`.
- Verify streamed text if supported.
- Verify public thinking block if backend emits it.
- Verify tool call block appears for read/search/edit tools if backend emits it.
- If ACP/rich stream is unavailable locally, verify the UI clearly reports lifecycle fallback instead of pretending rich stream exists.

- [ ] **Step 5: Real Obsidian editor verification**

Use only:

`/Users/lyuakin/Documents/AKin-note-management/testing/`

Verify:

- candidate generated
- `Esc` cancel does not change file hash
- `Enter` confirm changes file hash
- Markdown is preserved
- no code block wrapper
- no multiple versions
- no old backend output contamination

- [ ] **Step 6: Resource tab verification**

In real Obsidian settings:

- Open EchoInk Resource tab.
- Confirm imported MCP without config says `仅导入` or `缺连接配置`.
- Add a safe manual MCP connection if available.
- Run `测试连接`.
- Confirm status becomes `已验证` on success or `连接失败` with a clear error.
- Confirm no setting was written back to Codex/Hermes/OpenCode global config.

- [ ] **Step 7: Update project memory**

Update:

- `.codex-memory/current.md`
- `.codex-memory/tasks/active/multi-agent-backend/brief.md`
- `.codex-memory/tasks/active/multi-agent-backend/decisions.md`
- `.codex-memory/tasks/active/multi-agent-backend/refs.md`

Record:

- event layer implemented
- MCP connection settings implemented
- validation evidence
- remaining limitations

- [ ] **Step 8: Commit verification/memory updates**

```bash
git add .codex-memory docs/superpowers/plans src
git commit -m "test: verify agent events and mcp bridge"
```

---

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Event layer becomes fake rich timeline | User may think OpenCode/Hermes can do what Codex does | Use explicit event names: lifecycle events first, rich events only when backend exposes them |
| MCP bridge over-promises | Agent may appear able to call tools it cannot call | Keep status labels strict: imported-only is not callable |
| OpenCode/Hermes rich stream unavailable on user machine | User expects Codex-like timeline but backend/adapter is not installed | Detect rich mode explicitly, show fallback badge, keep lifecycle wrapper |
| "Thinking" is mistaken for hidden chain-of-thought | Privacy and product trust issue | Label as public thinking/reasoning summary and only display backend-emitted content |
| UI persistence becomes noisy | Frequent events may write too often | Persist terminal event immediately; throttle non-terminal updates |
| MCP secrets leak in UI/logs | Security issue | Never render full env/headers in cards or call logs |
| Real Vault validation writes business notes | Data pollution | Only use `testing/`; avoid real `/check` |
| Codex rich timeline regresses | Major user-facing regression | Keep Codex notification handling unchanged; add tests/source assertions for Codex path |

## Commit Strategy

Use small commits per task:

1. `feat: add agent event contract`
2. `feat: wrap simple agents with lifecycle events`
3. `feat: add rich agent stream adapter`
4. `feat: render simple agent chat events`
5. `feat: render simple agent editor events`
6. `feat: store echoink mcp connections`
7. `feat: resolve mcp broker connections from echoink settings`
8. `feat: add mcp connection controls`
9. `fix: keep mcp bridge capability truthful`
10. `feat: add agent task phase diagnostics`
11. `test: verify agent events and mcp bridge`

## Final Delivery Summary Template

When implementation completes, answer with:

- What changed:
  - Agent event layer
  - Rich Agent stream adapter for ACP/native event backends
  - OpenCode/Hermes lifecycle UI
  - EchoInk-owned MCP connection settings
  - MCP broker/status/UI hardening
- What remains true:
  - Codex is still the only rich native timeline backend
  - OpenCode/Hermes only show lifecycle events unless their APIs expose richer events
  - Public thinking blocks are backend-emitted summaries/chunks, not hidden chain-of-thought
  - Imported MCP is not callable until EchoInk has connection config
- Verification:
  - `npm run test`
  - `npm run typecheck`
  - `npm run build`
  - real Vault deploy
  - real Obsidian chat/editor/resource checks
