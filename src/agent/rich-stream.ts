import type { AgentBackendKind } from "./types";
import type { AgentEvent } from "./events";

export type RichStreamValueState = "provided" | "empty" | "unavailable";

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
      if (text) {
        const messageId = stringValue(item.messageId ?? item.id);
        events.push({
          ...base,
          type: "message_delta",
          text,
          data: messageId ? { messageId } : undefined
        });
      }
      continue;
    }
    if (type === "agent_thought_chunk") {
      const text = contentText(item);
      if (text) {
        const blockId = stringValue(item.blockId ?? item.messageId ?? item.id);
        events.push({
          ...base,
          type: "thinking_delta",
          text,
          data: {
            ...(blockId ? { blockId } : {}),
            reasoningKind: "provider",
            visibility: "public"
          }
        });
      }
      continue;
    }
    if (type === "tool_call") {
      const toolCallId = stringValue(item.toolCallId ?? item.callId ?? item.id);
      const input = readChannel(item, "rawInput", "input");
      const displayPreview = toolContentText(item.content);
      const toolStatus = normalizeToolStatus(item.status, "requested");
      events.push({
        ...base,
        type: "tool_call_requested",
        toolName: stringValue(item.title ?? item.name ?? item.tool) || "tool",
        status: toolStatus,
        text: displayPreview || undefined,
        data: toolEventData(item, {
          toolCallId,
          input,
          output: unavailableChannel(),
          displayPreview,
          toolStatus
        })
      });
      continue;
    }
    if (type === "tool_call_update") {
      const status = stringValue(item.status).toLowerCase();
      const toolCallId = stringValue(item.toolCallId ?? item.callId ?? item.id);
      const eventType = status === "completed" || status === "success"
        ? "tool_call_completed"
        : isTerminalToolFailureStatus(status)
          ? "tool_call_failed"
          : "tool_call_delta";
      const input = readChannel(item, "rawInput", "input");
      const rawOutput = readChannel(item, "rawOutput", "output");
      const displayPreview = toolContentText(item.content);
      // ACP `content` is a provider-authored display preview, not the raw tool
      // result. Keep it visible without claiming that Hermes supplied output.
      const output = rawOutput;
      const toolStatus = normalizeToolStatus(status, eventType === "tool_call_completed"
        ? "completed"
        : eventType === "tool_call_failed"
          ? "failed"
          : "running");
      events.push({
        ...base,
        type: eventType,
        toolName: optionalStringValue(item.title ?? item.name ?? item.tool),
        status: toolStatus,
        text: displayPreview || stringChannelText(rawOutput) || undefined,
        error: eventType === "tool_call_failed"
          ? displayPreview || stringChannelText(rawOutput) || stringValue(item.error) || undefined
          : undefined,
        data: toolEventData(item, {
          toolCallId,
          input,
          output,
          displayPreview,
          rawOutput,
          toolStatus
        })
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

interface ChannelValue {
  present: boolean;
  state: RichStreamValueState;
  value?: unknown;
}

interface ToolEventDataOptions {
  toolCallId: string;
  input: ChannelValue;
  output: ChannelValue;
  displayPreview: string;
  rawOutput?: ChannelValue;
  toolStatus: string;
}

function toolEventData(item: Record<string, unknown>, options: ToolEventDataOptions): Record<string, unknown> {
  const data: Record<string, unknown> = {
    inputState: options.input.state,
    outputState: options.output.state,
    rawInputState: options.input.state,
    rawOutputState: (options.rawOutput ?? unavailableChannel()).state
  };
  if (options.toolCallId) {
    data.toolCallId = options.toolCallId;
    data.callId = options.toolCallId;
  }
  const providerKind = stringValue(item.kind);
  if (providerKind) data.providerKind = providerKind;
  data.semanticKind = normalizeSemanticKind(providerKind);
  const providerStatus = stringValue(item.status);
  if (providerStatus) data.providerStatus = providerStatus;
  data.status = options.toolStatus;
  data.toolStatus = options.toolStatus;
  if (options.input.present) data.rawInput = options.input.value;
  if (options.input.state !== "unavailable") data.input = options.input.value;
  if (options.rawOutput?.present) data.rawOutput = options.rawOutput.value;
  if (options.output.state !== "unavailable") data.output = options.output.value;
  if (options.displayPreview) data.displayPreview = options.displayPreview;
  if (hasOwn(item, "content")) data.content = item.content;
  if (hasOwn(item, "locations")) data.locations = item.locations;
  const files = normalizedToolFiles(item.files ?? item.locations);
  if (files.length) data.files = files;
  if (hasOwn(item, "diff")) data.diff = item.diff;
  else if (hasOwn(item, "changes")) data.diff = item.changes;
  return data;
}

function contentText(item: Record<string, unknown>): string {
  const direct = stringValue(item.text);
  if (direct) return direct;
  return toolContentText(item.content);
}

function toolContentText(value: unknown): string {
  return collectText(value, new Set<object>(), 0).filter(Boolean).join("\n");
}

function collectText(value: unknown, seen: Set<object>, depth: number): string[] {
  if (depth > 12 || value === null || value === undefined) return [];
  if (typeof value === "string") return value ? [value] : [];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectText(entry, seen, depth + 1));
  }
  const object = value as Record<string, unknown>;
  const direct = stringValue(object.text);
  if (direct) return [direct];
  const fragments: string[] = [];
  for (const key of ["content", "output", "message", "data"]) {
    if (hasOwn(object, key)) fragments.push(...collectText(object[key], seen, depth + 1));
  }
  return fragments;
}

function stringChannelText(channel: ChannelValue): string {
  return channel.state === "provided" && typeof channel.value === "string" ? channel.value : "";
}

function normalizeSemanticKind(value: string): "read" | "search" | "command" | "edit" | "mcp" | "agent" | "plan" | "tool" {
  switch (value.trim().toLowerCase().replace(/[-\s]+/g, "_")) {
    case "read":
      return "read";
    case "search":
    case "fetch":
      return "search";
    case "execute":
    case "command":
    case "terminal":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "mcp":
      return "mcp";
    case "agent":
    case "switch_mode":
      return "agent";
    case "plan":
    case "think":
      return "plan";
    default:
      return "tool";
  }
}

function normalizeToolStatus(value: unknown, fallback: string): string {
  switch (stringValue(value).trim().toLowerCase().replace(/[-\s]+/g, "_")) {
    case "pending":
    case "requested":
      return "requested";
    case "in_progress":
    case "running":
      return "running";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "approval":
    case "awaiting_approval":
      return "approval";
    case "denied":
    case "rejected":
      return "denied";
    case "cancelled":
    case "canceled":
    case "aborted":
    case "interrupted":
      return "interrupted";
    case "unconfirmed":
      return "unconfirmed";
    default:
      return fallback;
  }
}

function isTerminalToolFailureStatus(status: string): boolean {
  return status === "failed"
    || status === "error"
    || status === "denied"
    || status === "rejected"
    || status === "cancelled"
    || status === "canceled"
    || status === "aborted"
    || status === "interrupted";
}

function normalizedToolFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const files = value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const record = plainObject(entry);
    if (!record) return [];
    const path = stringValue(record.path ?? record.file ?? record.uri ?? record.url);
    return path ? [path] : [];
  });
  return [...new Set(files)];
}

function readChannel(item: Record<string, unknown>, primary: string, fallback: string): ChannelValue {
  if (hasOwn(item, primary)) return channelValue(item[primary], true);
  if (hasOwn(item, fallback)) return channelValue(item[fallback], true);
  return unavailableChannel();
}

function channelValue(value: unknown, present: boolean): ChannelValue {
  if (!present || value === null || value === undefined) return unavailableChannel(present, value);
  return { present, state: isEmptyValue(value) ? "empty" : "provided", value };
}

function unavailableChannel(present = false, value?: unknown): ChannelValue {
  return { present, state: "unavailable", ...(present ? { value } : {}) };
}

function isEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  const object = plainObject(value);
  return object !== null && Object.keys(object).length === 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalStringValue(value: unknown): string | undefined {
  const text = stringValue(value);
  return text || undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
