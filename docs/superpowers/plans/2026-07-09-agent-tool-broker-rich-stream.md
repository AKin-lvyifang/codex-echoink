# Agent Tool Broker and Rich Stream Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make EchoInk-owned MCP tools truly callable across Agent backends, surface tool calls through AgentEvent, then add real OpenCode/Hermes rich stream adapters where the backends expose public events.

**Architecture:** Build the tool foundation first: MCP tool catalog -> EchoInk agent tool bridge -> broker-mediated tool loop -> AgentEvent rendering. After that, implement OpenCode/Hermes rich stream adapters only when local discovery proves a real event stream exists. Codex keeps its native rich path and native MCP passthrough.

**Tech Stack:** TypeScript, Obsidian plugin APIs, existing `src/tests/run-tests.ts` harness, EchoInk Resource Registry, EchoInk MCP broker, AgentEvent runtime, OpenCode SDK/CLI, Hermes CLI/API.

---

## Source Spec

- `docs/superpowers/specs/2026-07-09-agent-tool-broker-rich-stream-design.md`

## Current Evidence

- `src/resources/mcp-broker.ts` already supports `tools/list`, `tools/call`, approval, timeout, and call log.
- `src/resources/mcp-connections.ts` already resolves EchoInk-owned MCP connection records and status labels.
- `src/main.ts` already exposes `listEchoInkMcpTools()` and `callEchoInkMcpTool()`.
- `src/agent/events.ts` already defines tool event types.
- `src/ui/codex-view/agent-event-renderer.ts` already renders tool events into chat state.
- `src/agent/registry.ts` currently marks OpenCode/Hermes as `structuredToolCalls: false` and `nativeMcpPassThrough: false`.
- `src/agent/factory.ts` currently keeps OpenCode on CLI lifecycle fallback and Hermes on ACP-if-available plus lifecycle fallback.

## Required Order

Do not start with rich stream.

Implementation order:

1. MCP broker callable tool catalog.
2. Agent tool bridge and broker-mediated tool loop.
3. AgentEvent tool visibility in chat / knowledge / editor paths.
4. OpenCode HTTP ACP discovery and adapter if real stream exists.
5. Hermes native stream discovery and adapter if real stream exists.
6. Full verification and real Obsidian deploy.

## File Structure

Create:

- `src/resources/mcp-tool-catalog.ts`
  - Builds callable MCP tool catalog from enabled resources and EchoInk connection records.
  - Normalizes tool names, maps tool name -> resource/tool, caches safe list results.

- `src/agent/tool-bridge.ts`
  - Owns `echoink-tool-call` parser, prompt instructions, tool loop, result truncation, and AgentEvent emission.
  - Calls `plugin.callEchoInkMcpTool()` through an injected executor.

- `src/agent/http-acp-runtime.ts` or `src/agent/opencode-http-acp-runtime.ts`
  - Only if discovery proves OpenCode HTTP ACP has a real event stream.
  - Maps OpenCode public events into `AgentEvent`.

- `src/agent/hermes-stream-runtime.ts`
  - Only if discovery proves Hermes has a real native stream / ACP / event API.
  - Maps Hermes public events into `AgentEvent`.

Modify:

- `src/resources/mcp-broker.ts`
  - Add optional event/call metadata if needed.
  - Keep existing broker API compatible.

- `src/resources/types.ts`
  - Add tool catalog types and optional cached tool metadata if needed.

- `src/resources/registry.ts`
  - Include callable broker tool info in `PreparedAgentResources` only for verified/connectable resources.
  - Keep imported-only resources as warnings, not callable tools.

- `src/agent/runtime.ts`
  - Add runtime-facing tool bridge contract, not persistent settings.

- `src/agent/types.ts`
  - Add optional `toolBridge` or tool-loop settings to `AgentTaskInput` if needed.

- `src/agent/factory.ts`
  - Wrap OpenCode/Hermes `runTaskEvents()` with the tool loop before returning final text.
  - Do not enable native capabilities until adapters are verified.

- `src/agent/event-task.ts`
  - Ensure lifecycle fallback still emits tool events from the bridge.

- `src/ui/codex-view/turn-runner.ts`
  - Inject tool bridge executor for chat turns.
  - Ensure tool events update assistant message details.

- `src/knowledge-base/manager.ts`
  - Inject tool bridge executor for knowledge tasks where safe.
  - Keep raw protection, transaction, timeout, and cancel as the authority.

- `src/ui/codex-view/editor-action-runner.ts`
  - First pass: allow prompt-only resources and read-only verified MCP only.
  - Preserve candidate generation, `Esc`, `Enter`.

- `src/ui/codex-view/agent-event-renderer.ts`
  - Improve tool input/output truncation and denied/failed states.

- `src/settings/settings-tab.ts`
  - Show discovered tool count and last MCP call state if added.
  - Keep current “仅导入 / 补全连接配置” truthfulness.

- `src/tests/run-tests.ts`
  - Add focused tests before each implementation task.

Do not create a second test runner unless `src/tests/run-tests.ts` becomes unmanageable.

## Acceptance Criteria

- `npm run test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- `OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy` passes.
- Real Obsidian opens `/Users/lyuakin/Documents/AKin-note-management`.
- Real testing is limited to `/Users/lyuakin/Documents/AKin-note-management/testing/`.
- An imported-only MCP is never treated as callable.
- A configured MCP can list tools through EchoInk broker.
- OpenCode/Hermes can request a broker tool through the `echoink-tool-call` protocol and receive the result in a follow-up turn.
- Tool calls emit `tool_call_requested`, `permission_requested`, `tool_call_completed` or `tool_call_failed`.
- Chat UI shows the tool call lifecycle in assistant details.
- Broker call log records approved / denied / completed / failed.
- Knowledge tasks can use safe verified MCP tools without bypassing raw protection or transaction rollback.
- Editor actions still pass candidate generation, `Esc` cancel, `Enter` confirm.
- OpenCode rich stream is enabled only if HTTP ACP discovery proves real public event streaming.
- Hermes rich stream is enabled only if Hermes discovery proves real public event streaming.
- If rich stream discovery fails, OpenCode/Hermes remain stable lifecycle fallback with tool events.
- No UI text claims OpenCode/Hermes have Codex-level rich timeline unless verified.

---

### Task 1: MCP Callable Tool Catalog

**Files:**
- Create: `src/resources/mcp-tool-catalog.ts`
- Modify: `src/resources/types.ts`
- Modify: `src/resources/registry.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tests for callable MCP catalog**

Add tests near existing resource/MCP tests in `src/tests/run-tests.ts`.

Test cases:

```ts
const catalogTools = await buildCallableMcpToolCatalog({
  resources: [brokerReadyResource, importedMcpResource],
  scope: "chat",
  enabledByScope: { chat: { [brokerReadyResource.id]: true, [importedMcpResource.id]: true } },
  connections: normalizedMcpConnections,
  listTools: async (resourceId) => resourceId === brokerReadyResource.id
    ? [{ name: "read_note", description: "Read note", inputSchema: { type: "object" } }]
    : [{ name: "search_notes" }]
});

assert.deepEqual(catalogTools.tools.map((tool) => tool.name), ["notes.read_note"]);
assert.equal(catalogTools.tools[0].resourceId, brokerReadyResource.id);
assert.equal(catalogTools.warnings.some((warning) => warning.includes("仅导入") || warning.includes("缺少")), true);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test
```

Expected: FAIL with missing `buildCallableMcpToolCatalog`.

- [ ] **Step 3: Add catalog types**

In `src/resources/types.ts`, add:

```ts
export interface EchoInkCallableMcpTool {
  name: string;
  resourceId: string;
  resourceName: string;
  toolName: string;
  description: string;
  inputSchema?: unknown;
}

export interface EchoInkCallableMcpToolCatalog {
  tools: EchoInkCallableMcpTool[];
  warnings: string[];
}
```

- [ ] **Step 4: Implement `mcp-tool-catalog.ts`**

Create `src/resources/mcp-tool-catalog.ts`.

Core behavior:

- Use `enabledResourcesForScope()`.
- Keep only `kind === "mcp-server"`.
- Keep only resources with `resolveMcpConnectionConfig(...)`.
- Call injected `listTools(resourceId)`.
- Normalize names to `${resource.name}.${tool.name}`.
- Drop tools without a string name.
- Return warnings for enabled MCP resources that are imported-only or missing config.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/resources/mcp-tool-catalog.ts src/resources/types.ts src/resources/registry.ts src/tests/run-tests.ts
git commit -m "feat: add callable mcp tool catalog"
```

---

### Task 2: EchoInk Agent Tool Bridge

**Files:**
- Create: `src/agent/tool-bridge.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/types.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing parser and prompt tests**

Add tests:

```ts
const parsed = parseEchoInkToolCall([
  "Before",
  "```echoink-tool-call",
  JSON.stringify({ tool: "notes.read_note", arguments: { path: "wiki/a.md" } }),
  "```",
  "After"
].join("\n"));

assert.deepEqual(parsed, { tool: "notes.read_note", arguments: { path: "wiki/a.md" } });
assert.equal(parseEchoInkToolCall("```json\n{\"tool\":\"notes.read_note\"}\n```"), null);
assert.match(buildEchoInkToolBridgePrompt([{ name: "notes.read_note", description: "Read note", resourceId: "r1", resourceName: "notes", toolName: "read_note" } as any]), /```echoink-tool-call/);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test
```

Expected: FAIL with missing parser/prompt helpers.

- [ ] **Step 3: Implement parser and prompt helpers**

Create `src/agent/tool-bridge.ts`.

Required exports:

```ts
export interface EchoInkToolCallRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

export function parseEchoInkToolCall(text: string): EchoInkToolCallRequest | null;
export function buildEchoInkToolBridgePrompt(tools: EchoInkCallableMcpTool[]): string;
export function truncateEchoInkToolResult(value: unknown, maxChars?: number): string;
```

Rules:

- Only parse fenced block language `echoink-tool-call`.
- Require JSON object.
- Require string `tool`.
- Require `arguments` to be object or default `{}`.
- Reject JSON over 8KB.

- [ ] **Step 4: Add runtime contract**

In `src/agent/runtime.ts`, add a runtime-only bridge type:

```ts
export interface AgentToolBridgeRuntime {
  enabled: boolean;
  maxToolCalls: number;
  prompt: string;
  callTool(input: {
    tool: string;
    arguments?: Record<string, unknown>;
    scope: EchoInkResourceScope;
    backend: AgentBackendKind;
    emit?: AgentEventSink;
  }): Promise<string>;
}
```

Do not persist this in settings.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm run test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tool-bridge.ts src/agent/runtime.ts src/agent/types.ts src/tests/run-tests.ts
git commit -m "feat: add echoink tool bridge protocol"
```

---

### Task 3: Broker-Mediated Tool Loop

**Files:**
- Modify: `src/agent/tool-bridge.ts`
- Modify: `src/agent/factory.ts`
- Modify: `src/agent/event-task.ts`
- Modify: `src/ui/codex-view/turn-runner.ts`
- Modify: `src/knowledge-base/manager.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing tool loop tests**

Test a fake runtime:

```ts
let calls = 0;
const fakeRuntime = {
  kind: "hermes",
  connect: async () => ({ connected: true, label: "Hermes", errors: [] }),
  listModels: async () => [],
  abort: async () => undefined,
  runTask: async (input: AgentTaskInput) => {
    calls += 1;
    if (calls === 1) return { text: "```echoink-tool-call\n{\"tool\":\"notes.read_note\",\"arguments\":{\"path\":\"wiki/a.md\"}}\n```" };
    assert.match(input.prompt, /TOOL RESULT/);
    return { text: "Final answer from tool result" };
  }
} satisfies AgentTaskRuntime;

const events: AgentEvent[] = [];
const result = await runAgentTaskWithToolBridge(fakeRuntime, {
  prompt: "read note",
  toolBridge: fakeBridge
}, (event) => events.push(event));

assert.equal(result.text, "Final answer from tool result");
assert.ok(events.some((event) => event.type === "tool_call_requested"));
assert.ok(events.some((event) => event.type === "tool_call_completed"));
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test
```

Expected: FAIL with missing `runAgentTaskWithToolBridge`.

- [ ] **Step 3: Implement tool loop**

In `src/agent/tool-bridge.ts`, add:

```ts
export async function runAgentTaskWithToolBridge(
  runtime: AgentEventTaskRuntime | AgentTaskRuntime,
  input: AgentTaskInput & { toolBridge?: AgentToolBridgeRuntime | null },
  emit: AgentEventSink
): Promise<AgentTaskResult>;
```

Behavior:

- If no bridge or no tools, run original task.
- Add bridge prompt before user prompt.
- Run task with events if runtime supports `runTaskEvents`.
- Parse final text.
- If no tool call, return result.
- If tool call:
  - emit `tool_call_requested`.
  - call bridge.
  - emit `tool_call_completed` or `tool_call_failed`.
  - append tool result to prompt.
  - continue up to `maxToolCalls`.
- If max calls exceeded, return a failed result or throw clear error.

- [ ] **Step 4: Wire chat path**

In `src/ui/codex-view/turn-runner.ts`:

- Build callable MCP tool catalog for scope `chat`.
- Create `AgentToolBridgeRuntime` that calls `view.plugin.callEchoInkMcpTool()`.
- Pass bridge into `runAgentTaskWithEvents()` or replace with `runAgentTaskWithToolBridge()`.
- Keep Codex native path unchanged.

- [ ] **Step 5: Wire knowledge path**

In `src/knowledge-base/manager.ts`:

- Build callable MCP tool catalog for scope `knowledge`.
- Pass bridge only for safe configured resources.
- Keep raw protection and transaction verifier unchanged.
- If tool loop fails, task fails normally and transaction rollback remains authority.

- [ ] **Step 6: Defer editor write tools**

In `src/ui/codex-view/editor-action-runner.ts`:

- Do not enable write-class MCP tools in this task.
- Allow only prompt-only skills unless a tool is explicitly marked read-only.
- Add a test ensuring editor candidate `Esc`/`Enter` flow is not touched by tool loop.

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agent/tool-bridge.ts src/agent/factory.ts src/agent/event-task.ts src/ui/codex-view/turn-runner.ts src/knowledge-base/manager.ts src/ui/codex-view/editor-action-runner.ts src/tests/run-tests.ts
git commit -m "feat: route agent mcp calls through echoink broker"
```

---

### Task 4: Tool Events and UI Truthfulness

**Files:**
- Modify: `src/ui/codex-view/agent-event-renderer.ts`
- Modify: `src/ui/codex-view/message-list.ts`
- Modify: `src/settings/settings-tab.ts`
- Modify: `src/resources/mcp-broker.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Write failing rendering tests**

Add tests for:

- Tool request appears in render state.
- Tool completed output is truncated.
- Tool failed/denied state is visible.
- Settings source contains truthful MCP warning text.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test
```

Expected: FAIL for missing denied/truncation behavior if not yet present.

- [ ] **Step 3: Improve event rendering**

In `src/ui/codex-view/agent-event-renderer.ts`:

- Distinguish denied from failed if event data/status says denied.
- Truncate displayed input/output.
- Preserve final assistant text when tool event arrives.
- Do not replace final answer with lifecycle text.

- [ ] **Step 4: Improve message list if needed**

In `src/ui/codex-view/message-list.ts`:

- Ensure `mcpToolCall` / tool details render without overflowing.
- Keep existing process grouping behavior.

- [ ] **Step 5: Improve Resource tab**

In `src/settings/settings-tab.ts`:

- Keep warning: imported MCP is not automatically callable.
- Optionally show discovered tool count after successful test.
- Keep `测试连接` result based on real `listEchoInkMcpTools()`.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/codex-view/agent-event-renderer.ts src/ui/codex-view/message-list.ts src/settings/settings-tab.ts src/resources/mcp-broker.ts src/tests/run-tests.ts
git commit -m "feat: render echoink tool events"
```

---

### Task 5: OpenCode HTTP ACP Discovery and Adapter

**Files:**
- Create if verified: `src/agent/opencode-http-acp-runtime.ts`
- Modify: `src/agent/factory.ts`
- Modify: `src/agent/registry.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Run local discovery**

Run:

```bash
opencode --version
opencode acp --help
```

If safe and non-destructive, inspect how `opencode acp` exposes HTTP event transport. Do not assume stdio.

Record findings in the implementation notes section of this plan or in a short follow-up note.

- [ ] **Step 2: Decide adapter path**

If OpenCode exposes a stable HTTP event stream:

- Implement `src/agent/opencode-http-acp-runtime.ts`.
- Use fake HTTP ACP server tests first.
- Map public events into `AgentEvent`.

If OpenCode does not expose a stable event stream:

- Do not implement adapter.
- Keep lifecycle fallback.
- Add a test/documentation note proving no capability flag was changed.

- [ ] **Step 3: Write fake stream tests if adapter exists**

Test:

- streamed text -> `message_delta`
- public thought -> `thinking_delta`
- tool event -> `tool_call_requested`
- usage -> `usage`
- disconnect / error -> `failed`

- [ ] **Step 4: Implement adapter if verified**

Adapter rules:

- No direct file writes through adapter.
- No terminal execution through adapter.
- Permission requests return controlled denial unless bridged through EchoInk approval.
- Tool calls still go through EchoInk broker.

- [ ] **Step 5: Update capability only after tests**

Only after adapter passes tests:

```ts
richEvents: true
```

Do not set `nativeMcpPassThrough: true` unless OpenCode actually supports EchoInk-generated temporary MCP config with EchoInk logging preserved.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

If adapter implemented:

```bash
git add src/agent/opencode-http-acp-runtime.ts src/agent/factory.ts src/agent/registry.ts src/tests/run-tests.ts
git commit -m "feat: add opencode rich stream adapter"
```

If adapter deferred:

```bash
git add docs/superpowers/plans/2026-07-09-agent-tool-broker-rich-stream.md src/tests/run-tests.ts
git commit -m "docs: record opencode rich stream fallback"
```

---

### Task 6: Hermes Native Stream Discovery and Adapter

**Files:**
- Create if verified: `src/agent/hermes-stream-runtime.ts`
- Modify: `src/agent/factory.ts`
- Modify: `src/agent/registry.ts`
- Test: `src/tests/run-tests.ts`

- [ ] **Step 1: Run local discovery**

Run:

```bash
hermes --version
hermes --help
hermes acp --help
hermes serve --help
```

If local Hermes exposes API docs or an event endpoint, inspect it without writing to the Vault.

- [ ] **Step 2: Decide adapter path**

If Hermes exposes ACP / stream / event API:

- Implement `src/agent/hermes-stream-runtime.ts` or reuse `AcpAgentRuntime` if verified.
- Map only public events.

If Hermes has no stable stream:

- Keep lifecycle fallback.
- Do not change `richEvents`.

- [ ] **Step 3: Write fake stream tests if adapter exists**

Test:

- public text stream -> `message_delta`
- public thinking/details -> `thinking_delta`
- tool event -> broker event or normalized tool event
- completed -> final text
- failed/cancelled -> clear error

- [ ] **Step 4: Implement adapter if verified**

Adapter rules:

- No hidden chain-of-thought.
- No direct Vault writes.
- Tool calls through EchoInk broker.
- `abort()` stops remote run if runId exists.

- [ ] **Step 5: Update capability only after tests**

Only after adapter passes tests:

```ts
richEvents: true
```

Do not mark `structuredToolCalls` true unless Hermes gives structured requests EchoInk can intercept.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

If adapter implemented:

```bash
git add src/agent/hermes-stream-runtime.ts src/agent/factory.ts src/agent/registry.ts src/tests/run-tests.ts
git commit -m "feat: add hermes rich stream adapter"
```

If adapter deferred:

```bash
git add docs/superpowers/plans/2026-07-09-agent-tool-broker-rich-stream.md src/tests/run-tests.ts
git commit -m "docs: record hermes rich stream fallback"
```

---

### Task 7: Verification in Real Obsidian

**Files:**
- Modify only if needed: docs and tests

- [ ] **Step 1: Run full command verification**

Run:

```bash
npm run test
npm run typecheck
npm run build
OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy
```

Expected: all PASS.

- [ ] **Step 2: Verify deployed hash**

Run:

```bash
shasum dist/main.js /Users/lyuakin/Documents/AKin-note-management/.obsidian/plugins/codex-echoink/main.js
```

Expected: both hashes match.

- [ ] **Step 3: Real Obsidian checks**

Open `/Users/lyuakin/Documents/AKin-note-management` in Obsidian.

Use only:

```text
/Users/lyuakin/Documents/AKin-note-management/testing/
```

Check:

- Resource/MCP page still says imported-only is not automatically callable.
- A safe configured MCP can run `测试连接` if macOS auxiliary permissions allow it.
- OpenCode chat still returns a simple test response.
- Hermes chat still returns a simple test response.
- If tool loop is enabled with a fake/safe MCP, tool request -> approval -> result appears in chat.
- Editor action candidate generation still supports `Esc` cancel and `Enter` confirm.

If UI automation cannot click `测试连接`, say so explicitly. Do not call command verification “full UI verification”.

- [ ] **Step 4: Update project memory**

Update:

- `.codex-memory/current.md`
- `.codex-memory/tasks/active/multi-agent-backend/brief.md`
- `.codex-memory/tasks/active/multi-agent-backend/refs.md`
- `.codex-memory/archive/2026-07.md`

Keep `current.md` current-only, not history.

- [ ] **Step 5: Final commit**

```bash
git status --short
git add <only files changed for this work>
git commit -m "feat: complete echoink agent tool broker"
```

## Implementation Notes

- This plan intentionally does not implement Hermes butler features.
- Tool loop is a bridge, not the final ideal API. Replace it with native structured tool calls when OpenCode/Hermes expose a stable interface.
- Do not enable high-risk MCP tools by default.
- Do not broaden real Obsidian testing outside `testing/`.
- 2026-07-10 discovery: local OpenCode is `1.4.3`; `opencode acp --help` and startup logs show an HTTP ACP server with `/global/event`, not stdio ACP. EchoInk does not yet own an HTTP ACP client, so OpenCode remains lifecycle fallback plus EchoInk broker-mediated tool loop.
- 2026-07-10 discovery: local Hermes is `Hermes Agent v0.18.0 (2026.7.1)`; `hermes acp --check` passes, ACP `initialize` returns protocolVersion 1 and agent capabilities, and `session/new` returns a real Hermes session id. EchoInk uses the existing stdio `AcpAgentRuntime` for Hermes rich events when available, with lifecycle fallback if startup or streaming fails.
