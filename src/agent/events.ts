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
  | "thinking_delta"
  | "thinking_completed"
  | "tool_call_delta"
  | "tool_call_completed"
  | "tool_call_failed"
  | "permission_requested"
  | "terminal_output"
  | "file_status"
  | "plan_updated"
  | "fallback_started"
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

export function makeAgentLifecycleEvents(input: {
  backend: AgentBackendKind;
  runId?: string;
  title?: string;
  now?: () => number;
}): AgentEvent[] {
  const now = input.now ?? Date.now;
  return (["connecting", "run_started", "prompt_sent", "waiting"] as const).map((type) => ({
    type,
    backend: input.backend,
    runId: input.runId,
    title: input.title,
    createdAt: now()
  }));
}

export function agentEventDisplayText(event: AgentEvent): string {
  if ((event.type === "completed" || event.type === "message_completed") && event.text) return event.text;
  if ((event.type === "failed" || event.type === "cancelled") && event.error) return event.error;
  const label = agentBackendLabel(event.backend);
  switch (event.type) {
    case "connecting":
      return `${label} 连接中`;
    case "connected":
      return `${label} 已连接`;
    case "run_started":
      return `${label} 运行已开始`;
    case "prompt_sent":
      return `${label} 已发送请求`;
    case "waiting":
      return `${label} 等待返回`;
    case "message_delta":
      return event.text ?? "";
    case "thinking_delta":
      return event.text ?? "";
    case "thinking_completed":
      return event.text ?? `${label} 思考完成`;
    case "tool_call_requested":
      return event.toolName ? `${label} 调用工具：${event.toolName}` : `${label} 调用工具`;
    case "tool_call_delta":
      return event.text ?? (event.toolName ? `${label} 工具更新：${event.toolName}` : `${label} 工具更新`);
    case "tool_call_completed":
      return event.toolName ? `${label} 工具完成：${event.toolName}` : `${label} 工具完成`;
    case "tool_call_failed":
      return event.error ?? (event.toolName ? `${label} 工具失败：${event.toolName}` : `${label} 工具失败`);
    case "permission_requested":
      return event.toolName ? `${label} 请求权限：${event.toolName}` : `${label} 请求权限`;
    case "terminal_output":
      return event.text ?? "";
    case "file_status":
      return `${label} 文件状态更新`;
    case "plan_updated":
      return event.text ?? `${label} 计划更新`;
    case "fallback_started":
      return event.error ? `${label} rich stream 不可用，回退到普通模式：${event.error}` : `${label} rich stream 不可用，回退到普通模式`;
    case "usage":
      return `${label} 用量更新`;
    case "completed":
      return event.text ?? `${label} 已完成`;
    case "failed":
      return event.error ?? `${label} 失败`;
    case "cancelled":
      return event.error ?? `${label} 已取消`;
  }
  return event.text ?? event.error ?? label;
}

function agentBackendLabel(backend: AgentBackendKind): string {
  if (backend === "opencode") return "OpenCode";
  if (backend === "hermes") return "Hermes";
  return "Codex";
}
