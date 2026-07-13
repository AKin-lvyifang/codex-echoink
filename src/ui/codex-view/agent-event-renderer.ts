import type { EditorActionQualityMode } from "../../editor-actions/types";
import type { AgentBackendKind } from "../../agent/types";
import type { AgentEvent } from "../../agent/events";
import type { ChatMessage } from "../../settings/settings";
import { agentEventDisplayText } from "../../agent/events";
import { extractProcessFileRefs, summarizeProcessEvent } from "../../core/mapping";
import type { ProcessEventKind } from "../../types/app-server";

export interface AgentThinkingBlock {
  id: string;
  text: string;
  status: "running" | "completed";
  order?: number;
}

export interface AgentPlanBlock {
  id: string;
  text: string;
  status: "running" | "completed";
  order?: number;
}

export interface AgentToolCallBlock {
  id: string;
  name: string;
  status: "running" | "approval" | "completed" | "failed" | "denied";
  input?: unknown;
  output?: string;
  resourceId?: string;
  data?: Record<string, unknown>;
  order?: number;
}

export interface AgentChatRenderState {
  backend: AgentBackendKind;
  status: "running" | "completed" | "failed";
  itemType: "assistant" | "error";
  title: string;
  text: string;
  runId?: string;
  thinkingBlocks: AgentThinkingBlock[];
  planBlocks: AgentPlanBlock[];
  toolCalls: AgentToolCallBlock[];
  nextProcessOrder: number;
}

export interface EditorActionStatusPatch {
  status: "generating" | "failed";
  actionLabel: string;
  qualityMode: EditorActionQualityMode;
  modeLabel: string;
  phase: "understanding" | "generating" | "reviewing";
  model: string;
  message?: string;
  startedAt: number;
}

export interface InlineAgentProcessMessageInput {
  runId: string;
  backendId: AgentBackendKind;
  modelId?: string;
  profileId?: string;
  createdAt: number;
  vaultPath?: string;
}

export function createAgentEventRenderState(backend: AgentBackendKind): AgentChatRenderState {
  return {
    backend,
    status: "running",
    itemType: "assistant",
    title: backendLabel(backend),
    text: "",
    thinkingBlocks: [],
    planBlocks: [],
    toolCalls: [],
    nextProcessOrder: 0
  };
}

export function reduceAgentEventForChat(state: AgentChatRenderState, event: AgentEvent): AgentChatRenderState {
  const next: AgentChatRenderState = {
    ...state,
    runId: event.runId ?? state.runId,
    thinkingBlocks: [...state.thinkingBlocks],
    planBlocks: [...state.planBlocks],
    toolCalls: [...state.toolCalls]
  };
  if (event.type === "message_delta") {
    next.text = appendMessageDelta(next.text, event.text ?? "");
    return next;
  }
  if (event.type === "message_completed") {
    next.text = event.text ?? next.text;
    return next;
  }
  if (event.type === "thinking_delta") {
    if (state.backend === "hermes") return next;
    const current = next.thinkingBlocks.at(-1);
    if (current && current.status === "running") {
      next.thinkingBlocks[next.thinkingBlocks.length - 1] = { ...current, text: `${current.text}${event.text ?? ""}` };
    } else {
      next.thinkingBlocks.push({ id: `thinking-${next.thinkingBlocks.length + 1}`, text: event.text ?? "", status: "running", order: next.nextProcessOrder++ });
    }
    return next;
  }
  if (event.type === "thinking_completed") {
    if (state.backend === "hermes") return next;
    const current = next.thinkingBlocks.at(-1);
    if (current) {
      next.thinkingBlocks[next.thinkingBlocks.length - 1] = { ...current, status: "completed", text: event.text ?? current.text };
    } else {
      next.thinkingBlocks.push({
        id: "thinking-1",
        text: event.text ?? "思考完成",
        status: "completed",
        order: next.nextProcessOrder++
      });
    }
    return next;
  }
  if (event.type === "tool_call_requested") {
    next.toolCalls.push({
      id: toolCallId(event, next.toolCalls.length),
      name: event.toolName ?? "tool",
      status: "running",
      input: truncateToolInput(event.data?.input),
      resourceId: event.resourceId,
      data: event.data,
      order: next.nextProcessOrder++
    });
    return next;
  }
  if (event.type === "permission_requested") {
    const index = toolCallIndex(next.toolCalls, event);
    const id = index >= 0 ? next.toolCalls[index].id : toolCallId(event, next.toolCalls.length);
    const current = index >= 0 ? next.toolCalls[index] : { id, name: event.toolName ?? "tool", status: "running" as const, order: next.nextProcessOrder++ };
    const updated: AgentToolCallBlock = {
      ...current,
      name: event.toolName ?? current.name,
      status: "approval"
    };
    if (index >= 0) next.toolCalls[index] = updated;
    else next.toolCalls.push(updated);
    return next;
  }
  if (event.type === "plan_updated") {
    const planId = stringValue(event.data?.planId) ?? stringValue(event.data?.id) ?? "plan";
    const index = next.planBlocks.findIndex((plan) => plan.id === planId);
    if (index >= 0) {
      next.planBlocks[index] = { ...next.planBlocks[index], text: event.text ?? next.planBlocks[index].text, status: "completed" };
    } else {
      next.planBlocks.push({
        id: planId,
        text: event.text ?? "计划已更新",
        status: "completed",
        order: next.nextProcessOrder++
      });
    }
    return next;
  }
  if (event.type === "tool_call_delta" || event.type === "terminal_output" || event.type === "tool_call_completed" || event.type === "tool_call_failed") {
    const index = toolCallIndex(next.toolCalls, event);
    const id = index >= 0 ? next.toolCalls[index].id : toolCallId(event, next.toolCalls.length);
    const current = index >= 0 ? next.toolCalls[index] : { id, name: event.toolName ?? "tool", status: "running" as const, order: next.nextProcessOrder++ };
    const delta = truncateToolPreview(event.text ?? event.data?.output);
    const completedOutput = truncateToolPreview(event.data?.output ?? event.text);
    const updated: AgentToolCallBlock = {
      ...current,
      name: event.toolName ?? current.name,
      status: event.type === "tool_call_completed" ? "completed" : event.type === "tool_call_failed" && event.status === "denied" ? "denied" : event.type === "tool_call_failed" ? "failed" : current.status,
      input: event.data?.input === undefined ? current.input : truncateToolInput(event.data.input),
      output: event.type === "tool_call_delta" || event.type === "terminal_output"
        ? appendToolDelta(current.output, delta)
        : truncateToolPreview(event.error) ?? completedOutput ?? current.output,
      resourceId: event.resourceId ?? current.resourceId,
      data: { ...current.data, ...event.data }
    };
    if (index >= 0) next.toolCalls[index] = updated;
    else next.toolCalls.push(updated);
    return next;
  }
  if (event.type === "completed") {
    next.status = "completed";
    next.itemType = "assistant";
    if (event.text) next.text = event.text;
    return next;
  }
  if (event.type === "failed" || event.type === "cancelled") {
    next.status = "failed";
    next.itemType = "error";
    next.title = `${backendLabel(event.backend)} 发送失败`;
    next.text = event.error ?? event.text ?? agentEventDisplayText(event);
    return next;
  }
  const displayText = agentEventDisplayText(event);
  if (displayText) next.text = displayText;
  return next;
}

export function buildInlineAgentProcessMessages(state: AgentChatRenderState, input: InlineAgentProcessMessageInput): ChatMessage[] {
  const shared = {
    backendId: input.backendId,
    modelId: input.modelId,
    profileId: input.profileId,
    runId: input.runId
  };
  let fallbackOrder = nextInlineProcessFallbackOrder(state);
  const thinkingMessages = state.thinkingBlocks
    .filter((block) => block.text.trim())
    .map((block) => {
      const order = orderedProcessMessage(block.order, () => fallbackOrder++);
      return {
        order,
        message: {
          id: inlineAgentProcessMessageId(input.runId, "reasoning", block.id),
          role: "assistant" as const,
          itemType: "reasoning",
          processKind: "reasoning" as const,
          title: "推理过程",
          text: block.text,
          status: block.status,
          createdAt: input.createdAt + order,
          ...shared
        }
      };
    });
  const planMessages = state.planBlocks
    .filter((block) => block.text.trim())
    .map((block) => {
      const order = orderedProcessMessage(block.order, () => fallbackOrder++);
      return {
        order,
        message: {
          id: inlineAgentProcessMessageId(input.runId, "plan", block.id),
          role: "assistant" as const,
          itemType: "plan",
          processKind: "plan" as const,
          title: "更新计划",
          text: block.text,
          status: block.status,
          createdAt: input.createdAt + order,
          ...shared
        }
      };
    });
  const toolMessages = state.toolCalls.map((tool) => {
    const order = orderedProcessMessage(tool.order, () => fallbackOrder++);
    return {
      order,
      message: projectInlineToolMessage(tool, { ...input, createdAt: input.createdAt + order }, shared)
    };
  });
  return [...thinkingMessages, ...planMessages, ...toolMessages]
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.message);
}

export function inlineAgentProcessMessagePrefix(runId: string): string {
  return `inline-process:${runId}:`;
}

export function agentEventToEditorStatus(input: {
  event: AgentEvent;
  actionLabel: string;
  qualityMode: EditorActionQualityMode;
  modeLabel: string;
  phase: "understanding" | "generating" | "reviewing";
  model: string;
  startedAt: number;
}): EditorActionStatusPatch {
  return {
    status: input.event.type === "failed" || input.event.type === "cancelled" ? "failed" : "generating",
    actionLabel: input.actionLabel,
    qualityMode: input.qualityMode,
    modeLabel: input.modeLabel,
    phase: input.phase,
    model: input.model,
    message: agentEventDisplayText(input.event),
    startedAt: input.startedAt
  };
}

function appendMessageDelta(current: string, delta: string): string {
  if (!delta) return current;
  if (/连接中|已连接|运行已开始|已发送请求|等待返回|rich stream 不可用/.test(current)) return delta;
  return `${current}${delta}`;
}

function toolCallId(event: AgentEvent, fallbackIndex: number): string {
  return stringValue(event.data?.toolCallId) ?? `tool-${fallbackIndex + 1}`;
}

function toolCallIndex(tools: AgentToolCallBlock[], event: AgentEvent): number {
  const explicitId = stringValue(event.data?.toolCallId);
  if (explicitId) return tools.findIndex((tool) => tool.id === explicitId);
  if (!event.toolName) return -1;
  const candidates = tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => tool.name === event.toolName && (tool.status === "running" || tool.status === "approval"));
  return candidates.length === 1 ? candidates[0].index : -1;
}

function nextInlineProcessFallbackOrder(state: AgentChatRenderState): number {
  const explicitOrders = [
    ...state.thinkingBlocks.map((block) => block.order),
    ...state.planBlocks.map((block) => block.order),
    ...state.toolCalls.map((tool) => tool.order)
  ].filter((order): order is number => typeof order === "number" && Number.isFinite(order));
  return explicitOrders.length ? Math.max(...explicitOrders) + 1 : 0;
}

function orderedProcessMessage(order: number | undefined, nextFallback: () => number): number {
  return typeof order === "number" && Number.isFinite(order) ? order : nextFallback();
}

function inlineAgentProcessMessageId(runId: string, kind: "reasoning" | "plan" | "tool", id: string): string {
  return `${inlineAgentProcessMessagePrefix(runId)}${kind}:${id}`;
}

function inlineToolStatus(status: AgentToolCallBlock["status"]): string {
  if (status === "approval") return "approval";
  if (status === "failed" || status === "denied") return "failed";
  return status;
}

function projectInlineToolMessage(
  tool: AgentToolCallBlock,
  input: InlineAgentProcessMessageInput,
  shared: Pick<ChatMessage, "backendId" | "modelId" | "profileId" | "runId">
): ChatMessage {
  const itemType = inlineToolItemType(tool);
  const payload = inlineToolPayload(tool);
  const summary = summarizeProcessEvent(itemType, payload, input.vaultPath ?? "");
  const processKind = inlineToolProcessKind(tool, itemType, summary.kind);
  const command = itemType === "commandExecution" ? commandText(tool.input, tool.data, true) : "";
  const files = extractProcessFileRefs(payload, input.vaultPath ?? "");
  const text = command
    ? [command, tool.output].filter(Boolean).join("\n\n")
    : tool.output ?? truncateToolPreview(tool.input) ?? "";
  return {
    id: inlineAgentProcessMessageId(input.runId, "tool", tool.id),
    role: "tool",
    itemType,
    processKind,
    title: summary.title || tool.name || "工具",
    details: command || summary.detail || undefined,
    text,
    status: inlineToolStatus(tool.status),
    files: files.length ? files : undefined,
    diffSummary: itemType === "fileChange" ? inlineDiffSummary(tool.data) : undefined,
    createdAt: input.createdAt,
    ...shared
  };
}

function inlineToolItemType(tool: AgentToolCallBlock): string {
  const hinted = stringValue(tool.data?.itemType);
  if (hinted === "commandExecution" || hinted === "fileChange" || hinted === "collabAgentToolCall" || hinted === "dynamicToolCall" || hinted === "mcpToolCall") return hinted;
  const name = normalizedToolName(tool.name);
  if (commandText(tool.input, tool.data) || /(^|[._\/-])(shell|bash|terminal|command|exec|execute|run)([._\/-]|$)/.test(name)) return "commandExecution";
  if (/(^|[._\/-])(edit|write|patch|apply[_-]?patch|replace|file[_-]?change)([._\/-]|$)/.test(name)) return "fileChange";
  if (/(^|[._\/-])(agent|spawn|delegate|subagent|task)([._\/-]|$)/.test(name)) return "collabAgentToolCall";
  return "dynamicToolCall";
}

function inlineToolProcessKind(tool: AgentToolCallBlock, itemType: string, fallback: ProcessEventKind): ProcessEventKind {
  const hinted = stringValue(tool.data?.processKind);
  if (hinted === "reasoning" || hinted === "plan" || hinted === "search" || hinted === "view" || hinted === "edit" || hinted === "run" || hinted === "tool" || hinted === "command" || hinted === "other") return hinted;
  if (itemType === "commandExecution") return fallback === "run" ? "run" : fallback === "search" ? "search" : fallback === "view" ? "view" : "command";
  if (itemType === "fileChange") return "edit";
  if (itemType === "collabAgentToolCall") return "tool";
  const name = normalizedToolName(tool.name);
  if (/(^|[._\/-])(read|open|view|cat|fetch[_-]?file)([._\/-]|$)/.test(name)) return "view";
  if (/(^|[._\/-])(search|grep|find|glob|rg|lookup|list[_-]?files)([._\/-]|$)/.test(name)) return "search";
  return "tool";
}

function inlineToolPayload(tool: AgentToolCallBlock): Record<string, unknown> {
  return {
    tool: tool.name,
    resourceId: tool.resourceId,
    input: tool.input,
    output: tool.output,
    ...tool.data
  };
}

function commandText(input: unknown, data?: Record<string, unknown>, allowDirectString = false): string {
  const candidates = [input, data?.input, data];
  for (const candidate of candidates) {
    if (allowDirectString && typeof candidate === "string" && candidate.trim()) return candidate.trim();
    const object = plainObject(candidate);
    if (!object) continue;
    for (const key of ["command", "cmd", "script", "shellCommand"]) {
      const value = object[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function inlineDiffSummary(data?: Record<string, unknown>): ChatMessage["diffSummary"] {
  const value = plainObject(data?.diffSummary);
  if (!value || !Array.isArray(value.files)) return undefined;
  const files: NonNullable<ChatMessage["diffSummary"]>["files"] = [];
  for (const entry of value.files) {
    const file = plainObject(entry);
    const path = typeof file?.path === "string" ? file.path : "";
    if (!file || !path) continue;
    const kind = file.kind === "add" || file.kind === "delete" || file.kind === "update" || file.kind === "move" ? file.kind : "unknown";
    files.push({
      path,
      previousPath: typeof file.previousPath === "string" ? file.previousPath : undefined,
      kind,
      added: numericValue(file.added),
      removed: numericValue(file.removed)
    });
  }
  if (!files.length) return undefined;
  return {
    totalFiles: files.length,
    added: numericValue(value.added) || files.reduce((sum, file) => sum + file.added, 0),
    removed: numericValue(value.removed) || files.reduce((sum, file) => sum + file.removed, 0),
    files
  };
}

function normalizedToolName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function appendToolDelta(current: string | undefined, delta: string | undefined): string | undefined {
  if (!delta) return current;
  return truncateToolPreview(`${current ?? ""}${delta}`);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncateToolPreview(value: unknown, maxChars = 1200): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return undefined;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function truncateToolInput(value: unknown): unknown {
  if (value === undefined) return undefined;
  const preview = truncateToolPreview(value);
  const full = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return preview === full ? value : preview;
}

function backendLabel(backend: AgentBackendKind): string {
  if (backend === "opencode") return "OpenCode";
  if (backend === "hermes") return "Hermes";
  return "Codex";
}
