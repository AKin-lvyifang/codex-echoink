import type { AgentBackendKind } from "./types";
import type { AgentEvent } from "./events";

export interface NormalizeRichStreamOptions {
  backend: AgentBackendKind;
  runId?: string;
  now?: () => number;
}

export function normalizeRichStreamEvents(rawEvents: unknown[], options: NormalizeRichStreamOptions): AgentEvent[] {
  const now = options.now ?? Date.now;
  const events: AgentEvent[] = [];
  for (const raw of rawEvents) {
    const item = plainObject(raw);
    if (!item) continue;
    const base = {
      backend: options.backend,
      runId: options.runId,
      createdAt: now()
    };
    const type = stringValue(item.type ?? item.sessionUpdate);
    if (type === "agent_message_chunk") {
      const text = contentText(item);
      if (text) events.push({ ...base, type: "message_delta", text });
      continue;
    }
    if (type === "agent_thought_chunk") {
      const text = contentText(item);
      if (text) events.push({ ...base, type: "thinking_delta", text });
      continue;
    }
    if (type === "tool_call") {
      const toolCallId = stringValue(item.toolCallId ?? item.id);
      events.push({
        ...base,
        type: "tool_call_requested",
        toolName: stringValue(item.title ?? item.name ?? item.tool) || "tool",
        status: stringValue(item.status),
        data: {
          ...(toolCallId ? { toolCallId } : {}),
          input: plainObject(item.rawInput ?? item.input) ?? {},
          content: item.content
        }
      });
      continue;
    }
    if (type === "tool_call_update") {
      const status = stringValue(item.status).toLowerCase();
      const toolCallId = stringValue(item.toolCallId ?? item.id);
      const eventType = status === "completed" || status === "success"
        ? "tool_call_completed"
        : status === "failed" || status === "error"
          ? "tool_call_failed"
          : "tool_call_delta";
      events.push({
        ...base,
        type: eventType,
        toolName: stringValue(item.title ?? item.name ?? item.tool) || "tool",
        status,
        text: toolContentText(item.content),
        error: eventType === "tool_call_failed" ? toolContentText(item.content) || stringValue(item.error) : undefined,
        data: {
          ...(toolCallId ? { toolCallId } : {}),
          input: plainObject(item.rawInput ?? item.input) ?? {},
          content: item.content
        }
      });
      continue;
    }
    if (type === "usage_update") {
      events.push({ ...base, type: "usage", data: { ...item } });
      continue;
    }
    if (type === "plan") {
      events.push({ ...base, type: "plan_updated", data: { ...item }, text: stringValue(item.text ?? item.title) });
    }
  }
  return events;
}

function contentText(item: Record<string, unknown>): string {
  const direct = stringValue(item.text);
  if (direct) return direct;
  const content = plainObject(item.content);
  return content ? stringValue(content.text) : "";
}

function toolContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === "string") return entry;
      const object = plainObject(entry);
      return object ? stringValue(object.text ?? object.content ?? object.output) : "";
    }).filter(Boolean).join("\n");
  }
  const object = plainObject(value);
  return object ? stringValue(object.text ?? object.content ?? object.output) : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
