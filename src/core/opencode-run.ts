import type { AgentModelInfo } from "../agent/types";

export interface OpenCodeRunJsonParseResult {
  text: string;
  hasAuthoritativeFinal: boolean;
  sessionId?: string;
  usage?: Record<string, unknown>;
}

export interface OpenCodeRunArgsInput {
  prompt: string;
  directory: string;
  serverUrl?: string;
  sessionId?: string;
  model?: {
    providerId: string;
    modelId: string;
  };
  agent?: string;
  files?: string[];
  thinking?: boolean;
}

export function buildOpenCodeRunArgs(input: OpenCodeRunArgsInput): string[] {
  const args = ["run", "--format", "json", "--dir", input.directory];
  if (input.serverUrl) args.push("--attach", input.serverUrl);
  if (input.sessionId) args.push("--session", input.sessionId);
  if (input.thinking) args.push("--thinking");
  const model = openCodeCliModelId(input.model);
  if (model) args.push("--model", model);
  if (input.agent) args.push("--agent", input.agent);
  for (const file of input.files ?? []) args.push("--file", file);
  args.push("--", input.prompt);
  return args;
}

export function openCodeAssistantMessageIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of messages) {
    const info = openCodeRecord(openCodeRecord(entry).info);
    if (info.role !== "assistant") continue;
    const id = stringValue(info.id);
    if (id) ids.add(id);
  }
  return ids;
}

export function latestOpenCodeAssistantText(messages: unknown[], excludedMessageIds: ReadonlySet<string> = new Set()): string {
  let selected = "";
  let selectedAt = Number.NEGATIVE_INFINITY;
  let selectedIndex = -1;
  messages.forEach((entry, index) => {
    const record = openCodeRecord(entry);
    const info = openCodeRecord(record.info);
    if (info.role !== "assistant") return;
    const id = stringValue(info.id);
    if (id && excludedMessageIds.has(id)) return;
    const text = openCodeAssistantText(record.parts);
    if (!text) return;
    const time = openCodeRecord(info.time);
    const createdAt = numberValue(time.completed) ?? numberValue(time.created) ?? 0;
    if (createdAt < selectedAt || (createdAt === selectedAt && index <= selectedIndex)) return;
    selected = text;
    selectedAt = createdAt;
    selectedIndex = index;
  });
  return selected;
}

export function parseOpenCodeRunJsonLines(output: string): OpenCodeRunJsonParseResult {
  const textByMessage = new Map<string, string[]>();
  const messageOrder: string[] = [];
  const finishedMessageOrder: string[] = [];
  const finishReasonByMessage = new Map<string, string>();
  const unscopedTextParts: string[] = [];
  const usageByMessage = new Map<string, Record<string, unknown>>();
  let sessionId = "";
  let unscopedUsage: Record<string, unknown> | undefined;
  const registerMessage = (messageId: string): void => {
    if (messageId && !messageOrder.includes(messageId)) messageOrder.push(messageId);
  };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event.sessionID === "string" && event.sessionID) sessionId = event.sessionID;
    const messageId = typeof event.part?.messageID === "string" ? event.part.messageID : "";
    if (event.type === "step_start" || event.type === "text" || event.type === "step_finish") {
      registerMessage(messageId);
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      if (messageId) {
        if (!textByMessage.has(messageId)) {
          textByMessage.set(messageId, []);
        }
        textByMessage.get(messageId)!.push(event.part.text);
      } else {
        unscopedTextParts.push(event.part.text);
      }
    }
    if (event.type === "error") throw new Error(openCodeRunErrorMessage(event));
    if (event.type === "step_finish") {
      if (messageId) {
        const priorFinishIndex = finishedMessageOrder.indexOf(messageId);
        if (priorFinishIndex >= 0) finishedMessageOrder.splice(priorFinishIndex, 1);
        finishedMessageOrder.push(messageId);
        finishReasonByMessage.set(messageId, typeof event.part?.reason === "string" ? event.part.reason : "");
      }
      const tokens = event.part?.tokens;
      if (tokens && typeof tokens === "object") {
        const parsedUsage = {
          inputTokens: numberValue(tokens.input),
          outputTokens: numberValue(tokens.output),
          totalTokens: numberValue(tokens.total)
        };
        if (messageId) usageByMessage.set(messageId, parsedUsage);
        else unscopedUsage = parsedUsage;
      }
    }
  }
  const completedAnswerMessageId = [...finishedMessageOrder]
    .reverse()
    .find((messageId) => !isOpenCodeToolContinuationReason(finishReasonByMessage.get(messageId) ?? ""));
  const hasScopedFinish = finishedMessageOrder.length > 0;
  const selectedMessageId = completedAnswerMessageId
    ?? (hasScopedFinish
      ? ""
      : [...messageOrder].reverse().find((messageId) => textByMessage.has(messageId)) ?? "");
  const textParts = selectedMessageId
    ? textByMessage.get(selectedMessageId) ?? []
    : hasScopedFinish
      ? []
      : unscopedTextParts;
  return {
    text: textParts.join("").trim(),
    hasAuthoritativeFinal: completedAnswerMessageId !== undefined,
    sessionId: sessionId || undefined,
    usage: selectedMessageId ? usageByMessage.get(selectedMessageId) : unscopedUsage
  };
}

function isOpenCodeToolContinuationReason(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return normalized === "tool-calls" || normalized === "tool-call" || normalized === "tool-use" || normalized === "tool-uses";
}

export function parseOpenCodeModelListOutput(output: string): AgentModelInfo[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_.-]+\/\S+$/.test(line))
    .map((id) => {
      const slash = id.indexOf("/");
      return {
        id,
        providerId: id.slice(0, slash),
        modelId: id,
        displayName: id,
        inputModalities: ["text"]
      };
    });
}

export function openCodeRunSessionIdFromLine(line: string): string {
  const event = parseOpenCodeRunJsonLine(line);
  return typeof (event as any)?.sessionID === "string" ? (event as any).sessionID : "";
}

export function parseOpenCodeRunJsonLine(line: string): unknown | null {
  const value = line.trim();
  if (!value.startsWith("{")) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function openCodeCliModelId(model: OpenCodeRunArgsInput["model"]): string {
  if (!model?.providerId || !model.modelId) return "";
  return model.modelId.startsWith(`${model.providerId}/`) ? model.modelId : `${model.providerId}/${model.modelId}`;
}

function openCodeRunErrorMessage(event: any): string {
  const data = event?.error?.data;
  const message = typeof data?.message === "string"
    ? data.message
    : typeof event?.error?.message === "string"
      ? event.error.message
      : "OpenCode run failed";
  return `OpenCode CLI 执行失败：${message}`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function openCodeAssistantText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => openCodeRecord(part))
    .filter((part) => part.type === "text" && part.ignored !== true)
    .map((part) => stringValue(part.text))
    .join("")
    .trim();
}

function openCodeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
