import type { EditorActionQualityMode } from "../../editor-actions/types";
import type { AgentBackendKind } from "../../agent/types";
import type { AgentEvent } from "../../agent/events";
import { agentEventDisplayText } from "../../agent/events";

export interface AgentThinkingBlock {
  id: string;
  text: string;
  status: "running" | "completed";
}

export interface AgentToolCallBlock {
  id: string;
  name: string;
  status: "running" | "approval" | "completed" | "failed" | "denied";
  input?: unknown;
  output?: string;
}

export interface AgentChatRenderState {
  backend: AgentBackendKind;
  status: "running" | "completed" | "failed";
  itemType: "assistant" | "error";
  title: string;
  text: string;
  runId?: string;
  thinkingBlocks: AgentThinkingBlock[];
  toolCalls: AgentToolCallBlock[];
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

export function createAgentEventRenderState(backend: AgentBackendKind): AgentChatRenderState {
  return {
    backend,
    status: "running",
    itemType: "assistant",
    title: backendLabel(backend),
    text: "",
    thinkingBlocks: [],
    toolCalls: []
  };
}

export function reduceAgentEventForChat(state: AgentChatRenderState, event: AgentEvent): AgentChatRenderState {
  const next: AgentChatRenderState = {
    ...state,
    runId: event.runId ?? state.runId,
    thinkingBlocks: [...state.thinkingBlocks],
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
    const current = next.thinkingBlocks.at(-1);
    if (current && current.status === "running") {
      next.thinkingBlocks[next.thinkingBlocks.length - 1] = { ...current, text: `${current.text}${event.text ?? ""}` };
    } else {
      next.thinkingBlocks.push({ id: `thinking-${next.thinkingBlocks.length + 1}`, text: event.text ?? "", status: "running" });
    }
    return next;
  }
  if (event.type === "thinking_completed") {
    const current = next.thinkingBlocks.at(-1);
    if (current) next.thinkingBlocks[next.thinkingBlocks.length - 1] = { ...current, status: "completed", text: event.text ?? current.text };
    return next;
  }
  if (event.type === "tool_call_requested") {
    next.toolCalls.push({
      id: toolCallId(event, next.toolCalls.length),
      name: event.toolName ?? "tool",
      status: "running",
      input: truncateToolPreview(event.data?.input)
    });
    return next;
  }
  if (event.type === "permission_requested") {
    const id = toolCallId(event, next.toolCalls.length);
    const index = next.toolCalls.findIndex((tool) => tool.id === id);
    const current = index >= 0 ? next.toolCalls[index] : { id, name: event.toolName ?? "tool", status: "running" as const };
    const updated: AgentToolCallBlock = {
      ...current,
      name: event.toolName ?? current.name,
      status: "approval"
    };
    if (index >= 0) next.toolCalls[index] = updated;
    else next.toolCalls.push(updated);
    return next;
  }
  if (event.type === "tool_call_delta" || event.type === "tool_call_completed" || event.type === "tool_call_failed") {
    const id = toolCallId(event, next.toolCalls.length);
    const index = next.toolCalls.findIndex((tool) => tool.id === id);
    const current = index >= 0 ? next.toolCalls[index] : { id, name: event.toolName ?? "tool", status: "running" as const };
    const updated: AgentToolCallBlock = {
      ...current,
      name: event.toolName ?? current.name,
      status: event.type === "tool_call_completed" ? "completed" : event.type === "tool_call_failed" && event.status === "denied" ? "denied" : event.type === "tool_call_failed" ? "failed" : current.status,
      output: truncateToolPreview(event.error ?? event.text ?? stringValue(event.data?.output) ?? current.output)
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncateToolPreview(value: unknown, maxChars = 1200): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return undefined;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function backendLabel(backend: AgentBackendKind): string {
  if (backend === "opencode") return "OpenCode";
  if (backend === "hermes") return "Hermes";
  return "Codex";
}
