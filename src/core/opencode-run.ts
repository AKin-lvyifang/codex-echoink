export interface OpenCodeRunJsonParseResult {
  text: string;
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
}

export function buildOpenCodeRunArgs(input: OpenCodeRunArgsInput): string[] {
  const args = ["run", "--format", "json", "--dir", input.directory];
  if (input.serverUrl) args.push("--attach", input.serverUrl);
  if (input.sessionId) args.push("--session", input.sessionId);
  const model = openCodeCliModelId(input.model);
  if (model) args.push("--model", model);
  if (input.agent) args.push("--agent", input.agent);
  for (const file of input.files ?? []) args.push("--file", file);
  args.push(input.prompt);
  return args;
}

export function parseOpenCodeRunJsonLines(output: string): OpenCodeRunJsonParseResult {
  const textByMessage = new Map<string, string[]>();
  const messageOrder: string[] = [];
  const unscopedTextParts: string[] = [];
  const usageByMessage = new Map<string, Record<string, unknown>>();
  let firstStepMessageId = "";
  let sessionId = "";
  let unscopedUsage: Record<string, unknown> | undefined;
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
    if (event.type === "step_start" && messageId && !firstStepMessageId) firstStepMessageId = messageId;
    if (event.type === "text" && typeof event.part?.text === "string") {
      if (messageId) {
        if (!textByMessage.has(messageId)) {
          textByMessage.set(messageId, []);
          messageOrder.push(messageId);
        }
        textByMessage.get(messageId)!.push(event.part.text);
      } else {
        unscopedTextParts.push(event.part.text);
      }
    }
    if (event.type === "error") throw new Error(openCodeRunErrorMessage(event));
    if (event.type === "step_finish") {
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
  const selectedMessageId = firstStepMessageId && textByMessage.get(firstStepMessageId)?.length
    ? firstStepMessageId
    : messageOrder.find((messageId) => Boolean(textByMessage.get(messageId)?.length)) ?? "";
  const textParts = selectedMessageId ? textByMessage.get(selectedMessageId)! : unscopedTextParts;
  return {
    text: textParts.join("").trim(),
    sessionId: sessionId || undefined,
    usage: selectedMessageId ? usageByMessage.get(selectedMessageId) : unscopedUsage
  };
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
  const value = line.trim();
  if (!value.startsWith("{")) return "";
  try {
    const event = JSON.parse(value);
    return typeof event?.sessionID === "string" ? event.sessionID : "";
  } catch {
    return "";
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
import type { AgentModelInfo } from "../agent/types";
