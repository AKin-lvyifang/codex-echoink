import type { EchoInkCallableMcpTool, EchoInkCallableMcpToolCatalog, EchoInkResourceScope } from "../resources/types";
import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentEventTaskRuntime, AgentTaskRuntime, AgentToolBridgeRuntime } from "./runtime";
import type { AgentTaskInput, AgentTaskResult } from "./types";

const TOOL_CALL_LANGUAGE = "echoink-tool-call";
const MAX_TOOL_CALL_JSON_CHARS = 8 * 1024;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 20 * 1024;

export interface EchoInkToolCallRequest {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface EchoInkMcpToolBridgeExecutorInput {
  resourceId: string;
  scope: EchoInkResourceScope;
  backend: AgentTaskRuntime["kind"];
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
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
    prompt: buildEchoInkToolBridgePrompt(input.catalog.tools),
    callTool: async (request) => {
      const tool = toolsByName.get(request.tool);
      if (!tool) throw new Error(`EchoInk broker tool is not available: ${request.tool}`);
      await request.emit?.({
        type: "permission_requested",
        backend: request.backend,
        createdAt: Date.now(),
        toolName: request.tool,
        resourceId: tool.resourceId,
        data: { input: request.arguments ?? {} }
      });
      return truncateEchoInkToolResult(await input.callTool({
        resourceId: tool.resourceId,
        scope: request.scope,
        backend: request.backend,
        toolName: tool.toolName,
        arguments: request.arguments,
        timeoutMs: 30000
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
    lastResult = await runRuntimeTask(runtime, { ...stripToolBridgeInput(input), prompt }, emit);
    const request = parseEchoInkToolCall(lastResult.text);
    if (!request) return lastResult;
    if (callIndex >= bridge.maxToolCalls) {
      const error = `EchoInk tool loop exceeded maxToolCalls=${bridge.maxToolCalls}`;
      await emitToolEvent(emit, runtime.kind, { type: "tool_call_failed", toolName: request.tool, error });
      throw new Error(error);
    }
    const toolCallId = `echoink-tool-${Date.now()}-${callIndex}`;
    await emitToolEvent(emit, runtime.kind, {
      type: "tool_call_requested",
      toolName: request.tool,
      data: { toolCallId, input: request.arguments }
    });
    try {
      const output = await bridge.callTool({
        tool: request.tool,
        arguments: request.arguments,
        scope: bridge.scope,
        backend: runtime.kind,
        emit
      });
      const truncatedOutput = truncateEchoInkToolResult(output);
      await emitToolEvent(emit, runtime.kind, {
        type: "tool_call_completed",
        toolName: request.tool,
        data: { toolCallId, output: truncatedOutput }
      });
      prompt = appendToolResultPrompt(prompt, request, truncatedOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await emitToolEvent(emit, runtime.kind, {
        type: "tool_call_failed",
        toolName: request.tool,
        error: message,
        data: { toolCallId, input: request.arguments }
      });
      throw error;
    }
  }
  return lastResult ?? runRuntimeTask(runtime, stripToolBridgeInput(input), emit);
}

export function parseEchoInkToolCall(text: string): EchoInkToolCallRequest | null {
  const match = text.match(/```echoink-tool-call[ \t]*\n([\s\S]*?)\n?```/);
  if (!match) return null;
  const json = match[1]?.trim() ?? "";
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
