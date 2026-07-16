import type { EchoInkCallableMcpTool, EchoInkCallableMcpToolCatalog, EchoInkResourceScope } from "../resources/types";
import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentEventTaskRuntime, AgentTaskRuntime, AgentToolBridgeRuntime } from "./runtime";
import type { AgentTaskInput, AgentTaskResult } from "./types";

const TOOL_CALL_LANGUAGE = "echoink-tool-call";
const TOOL_CALL_FENCE_PREFIX = `\`\`\`${TOOL_CALL_LANGUAGE}`;
const MAX_TOOL_CALL_JSON_CHARS = 8 * 1024;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 20 * 1024;

export interface EchoInkToolCallRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

export type EchoInkToolCallCandidateState = "undecided" | "control" | "visible";

export interface EchoInkToolCallCandidateContext {
  /** True only when the provider has declared the current message complete. */
  messageCompleted?: boolean;
}

export interface EchoInkMcpToolBridgeExecutorInput {
  toolCallId?: string;
  resourceId: string;
  scope: EchoInkResourceScope;
  backend: AgentTaskRuntime["kind"];
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function createEchoInkMcpToolBridgeRuntime(input: {
  catalog: EchoInkCallableMcpToolCatalog;
  scope: EchoInkResourceScope;
  maxToolCalls?: number;
  callTool(request: EchoInkMcpToolBridgeExecutorInput): Promise<unknown>;
}): AgentToolBridgeRuntime | null {
  if (!input.catalog.tools.length) return null;
  const toolsByName = new Map(input.catalog.tools.map((tool) => [tool.name, tool]));
  return {
    enabled: true,
    scope: input.scope,
    maxToolCalls: input.maxToolCalls ?? 3,
    toolResourceIds: Object.fromEntries(input.catalog.tools.map((tool) => [tool.name, tool.resourceId])),
    prompt: buildEchoInkToolBridgePrompt(input.catalog.tools),
    callTool: async (request) => {
      const tool = toolsByName.get(request.tool);
      if (!tool) throw new Error(`EchoInk broker tool is not available: ${request.tool}`);
      const callIdentity = request.toolCallId
        ? { callId: request.toolCallId, toolCallId: request.toolCallId }
        : {};
      await request.emit?.({
        type: "permission_requested",
        backend: request.backend,
        createdAt: Date.now(),
        toolName: request.tool,
        resourceId: tool.resourceId,
        data: { ...callIdentity, input: request.arguments ?? {} }
      });
      return truncateEchoInkToolResult(await input.callTool({
        toolCallId: request.toolCallId,
        resourceId: tool.resourceId,
        scope: request.scope,
        backend: request.backend,
        toolName: tool.toolName,
        arguments: request.arguments,
        timeoutMs: 30000,
        signal: request.signal
      }));
    }
  };
}

export async function runAgentTaskWithToolBridge(
  runtime: AgentEventTaskRuntime | AgentTaskRuntime,
  input: AgentTaskInput & { toolBridge?: AgentToolBridgeRuntime | null },
  emit: AgentEventSink
): Promise<AgentTaskResult> {
  const bridge = input.toolBridge;
  if (!bridge?.enabled || !bridge.prompt.trim() || bridge.maxToolCalls <= 0) {
    return runRuntimeTask(runtime, stripToolBridgeInput(input), emit);
  }
  let prompt = `${bridge.prompt.trim()}\n\n${input.prompt}`;
  let lastResult: AgentTaskResult | null = null;
  for (let callIndex = 0; callIndex <= bridge.maxToolCalls; callIndex += 1) {
    const turn = await runRuntimeTaskWithToolCallMessageGate(
      runtime,
      { ...stripToolBridgeInput(input), prompt },
      emit
    );
    lastResult = turn.result;
    const request = turn.request;
    if (!request) return lastResult;
    const toolCallId = `echoink-tool-${Date.now()}-${callIndex}`;
    if (callIndex >= bridge.maxToolCalls) {
      const error = buildEchoInkToolLoopExceededError(bridge.maxToolCalls);
      await emitToolEvent(emit, runtime.kind, {
        type: "tool_call_failed",
        toolName: request.tool,
        resourceId: bridge.toolResourceIds?.[request.tool],
        status: "failed",
        error,
        data: { callId: toolCallId, toolCallId, toolStatus: "failed", input: request.arguments }
      });
      throw new Error(error);
    }
    await emitToolEvent(emit, runtime.kind, {
      type: "tool_call_requested",
      toolName: request.tool,
      resourceId: bridge.toolResourceIds?.[request.tool],
      status: "requested",
      data: { callId: toolCallId, toolCallId, toolStatus: "requested", input: request.arguments }
    });
    try {
      const output = await bridge.callTool({
        toolCallId,
        tool: request.tool,
        arguments: request.arguments,
        scope: bridge.scope,
        backend: runtime.kind,
        emit,
        signal: input.abortSignal
      });
      const truncatedOutput = truncateEchoInkToolResult(output);
      await emitToolEvent(emit, runtime.kind, {
        type: "tool_call_completed",
        toolName: request.tool,
        resourceId: bridge.toolResourceIds?.[request.tool],
        status: "completed",
        data: { callId: toolCallId, toolCallId, toolStatus: "completed", output: truncatedOutput }
      });
      prompt = appendToolResultPrompt(prompt, request, truncatedOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const interrupted = input.abortSignal?.aborted === true;
      await emitToolEvent(emit, runtime.kind, {
        type: "tool_call_failed",
        toolName: request.tool,
        resourceId: bridge.toolResourceIds?.[request.tool],
        status: interrupted ? "interrupted" : "failed",
        error: message,
        data: {
          callId: toolCallId,
          toolCallId,
          toolStatus: interrupted ? "interrupted" : "failed",
          input: request.arguments
        }
      });
      throw error;
    }
  }
  return lastResult ?? runRuntimeTask(runtime, stripToolBridgeInput(input), emit);
}

export function parseEchoInkToolCall(text: string): EchoInkToolCallRequest | null {
  const match = text.match(/```echoink-tool-call[ \t]*\r?\n([\s\S]*?)\r?\n?```/);
  if (!match) return null;
  return parseEchoInkToolCallJson(match[1] ?? "");
}

function parseEchoInkToolCallJson(rawJson: string): EchoInkToolCallRequest | null {
  const json = rawJson.trim();
  if (!json || json.length > MAX_TOOL_CALL_JSON_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const tool = typeof parsed.tool === "string" ? parsed.tool.trim() : "";
  if (!tool) return null;
  const rawArguments = parsed.arguments;
  if (rawArguments === undefined || rawArguments === null) return { tool, arguments: {} };
  if (!isPlainObject(rawArguments)) return null;
  return { tool, arguments: rawArguments };
}

/**
 * Returns a bridge request only when the whole provider answer is the control
 * fence. This keeps examples, malformed JSON, and answers with surrounding
 * prose as ordinary visible text.
 */
export function parseExactEchoInkToolCall(text: string): EchoInkToolCallRequest | null {
  const normalized = text.trim();
  const match = normalized.match(/^```echoink-tool-call[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  return match ? parseEchoInkToolCallJson(match[1] ?? "") : null;
}

/**
 * Prefix predicate shared by streaming gates. Empty/whitespace-only chunks
 * remain undecided; ordinary text is released as soon as it cannot become an
 * exact EchoInk tool-call fence.
 */
export function couldBeEchoInkToolCallPrefix(text: string): boolean {
  const normalized = text.trimStart();
  return TOOL_CALL_FENCE_PREFIX.startsWith(normalized) || normalized.startsWith(TOOL_CALL_FENCE_PREFIX);
}

/**
 * Classifies a streamed answer without exposing a possible control message.
 *
 * Before message completion, a provider may still replace an invalid-looking
 * snapshot with a valid control fence, so prefix candidates remain buffered.
 * Once completion is authoritative, only a valid exact fence stays hidden;
 * malformed or surrounded content is ordinary visible assistant text.
 */
export function classifyEchoInkToolCallCandidate(
  text: string,
  context: EchoInkToolCallCandidateContext = {}
): EchoInkToolCallCandidateState {
  if (context.messageCompleted) {
    return parseExactEchoInkToolCall(text) ? "control" : "visible";
  }
  return couldBeEchoInkToolCallPrefix(text) ? "undecided" : "visible";
}

export function buildEchoInkToolBridgePrompt(tools: EchoInkCallableMcpTool[]): string {
  if (!tools.length) return "";
  const toolLines = tools.map((tool) => {
    const schema = tool.inputSchema === undefined ? "" : ` schema=${truncateEchoInkToolResult(tool.inputSchema, 1200)}`;
    return `- ${tool.name}: ${tool.description || "无描述"}${schema}`;
  });
  return [
    "EchoInk broker tools are available for this turn.",
    "Use a tool only when it is necessary to answer the user.",
    `To request one tool, output exactly one fenced code block with language ${TOOL_CALL_LANGUAGE}.`,
    "Do not wrap the final answer in a tool-call block.",
    "",
    "Format:",
    `\`\`\`${TOOL_CALL_LANGUAGE}`,
    "{",
    '  "tool": "resource.tool_name",',
    '  "arguments": {}',
    "}",
    "```",
    "",
    "Available tools:",
    ...toolLines
  ].join("\n");
}

export function buildEchoInkToolLoopExceededError(maxToolCalls: number): string {
  return `EchoInk tool loop exceeded maxToolCalls=${maxToolCalls}`;
}

export function truncateEchoInkToolResult(value: unknown, maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS): string {
  const text = stringifyToolValue(value);
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 3)}...`;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripToolBridgeInput(input: AgentTaskInput & { toolBridge?: AgentToolBridgeRuntime | null }): AgentTaskInput {
  const { toolBridge: _toolBridge, ...taskInput } = input;
  return taskInput;
}

async function runRuntimeTask(runtime: AgentEventTaskRuntime | AgentTaskRuntime, input: AgentTaskInput, emit: AgentEventSink): Promise<AgentTaskResult> {
  if ("runTaskEvents" in runtime && typeof runtime.runTaskEvents === "function") {
    return await runtime.runTaskEvents(input, emit);
  }
  return await runtime.runTask(input);
}

async function runRuntimeTaskWithToolCallMessageGate(
  runtime: AgentEventTaskRuntime | AgentTaskRuntime,
  input: AgentTaskInput,
  emit: AgentEventSink
): Promise<{ result: AgentTaskResult; request: EchoInkToolCallRequest | null }> {
  if (!("runTaskEvents" in runtime) || typeof runtime.runTaskEvents !== "function") {
    const result = await runRuntimeTask(runtime, input, emit);
    return { result, request: parseExactEchoInkToolCall(result.text) };
  }

  const gate = new EchoInkToolCallMessageGate(emit);
  try {
    const result = await runRuntimeTask(runtime, input, gate.emit);
    const request = parseExactEchoInkToolCall(result.text);
    await gate.settle(request !== null);
    return { result, request };
  } catch (error) {
    await gate.settleFailure();
    throw error;
  }
}

class EchoInkToolCallMessageGate {
  private readonly buffered: AgentEvent[] = [];
  private bufferedText = "";
  private prefixResolved = false;
  private queue = Promise.resolve();

  constructor(private readonly downstream: AgentEventSink) {}

  readonly emit: AgentEventSink = (event) => {
    const operation = this.queue.then(async () => await this.process(event));
    this.queue = operation;
    return operation;
  };

  async settle(validControlFence: boolean): Promise<void> {
    await this.queue;
    if (validControlFence) {
      this.discardBuffered();
      return;
    }
    await this.flushBuffered();
  }

  async settleFailure(): Promise<void> {
    await this.queue;
    if (parseExactEchoInkToolCall(this.bufferedText)) {
      this.discardBuffered();
      return;
    }
    await this.flushBuffered();
  }

  private async process(event: AgentEvent): Promise<void> {
    if (this.prefixResolved || !isMessageEvent(event)) {
      await this.downstream(event);
      return;
    }

    this.buffered.push(event);
    const replacement = event.type === "message_completed" || event.data?.replace === true;
    const eventText = event.text ?? "";
    if (!replacement) this.bufferedText = `${this.bufferedText}${eventText}`;
    else if (eventText) this.bufferedText = eventText;
    const candidate = classifyEchoInkToolCallCandidate(this.bufferedText, {
      messageCompleted: event.type === "message_completed"
    });
    if (candidate !== "visible") return;

    this.prefixResolved = true;
    await this.flushBuffered();
  }

  private async flushBuffered(): Promise<void> {
    while (this.buffered.length) await this.downstream(this.buffered.shift()!);
    this.bufferedText = "";
  }

  private discardBuffered(): void {
    this.buffered.length = 0;
    this.bufferedText = "";
  }
}

function isMessageEvent(event: AgentEvent): boolean {
  return event.type === "message_delta" || event.type === "message_completed";
}

async function emitToolEvent(emit: AgentEventSink, backend: AgentTaskRuntime["kind"], event: Omit<AgentEvent, "backend" | "createdAt">): Promise<void> {
  await emit({ ...event, backend, createdAt: Date.now() });
}

function appendToolResultPrompt(prompt: string, request: EchoInkToolCallRequest, output: string): string {
  return [
    prompt,
    "",
    `TOOL RESULT ${request.tool}:`,
    output,
    "",
    "Continue from the tool result. If no more tools are needed, answer normally without an echoink-tool-call block."
  ].join("\n");
}

export function buildEchoInkToolResultTurnPrompt(request: EchoInkToolCallRequest, output: string): string {
  return appendToolResultPrompt("", request, output).trim();
}
