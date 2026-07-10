export interface OpenCodeRunJsonParseResult {
  text: string;
  sessionId?: string;
  usage?: Record<string, unknown>;
}

export interface OpenCodeRunArgsInput {
  prompt: string;
  directory: string;
  serverUrl?: string;
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
  const model = openCodeCliModelId(input.model);
  if (model) args.push("--model", model);
  if (input.agent) args.push("--agent", input.agent);
  for (const file of input.files ?? []) args.push("--file", file);
  args.push(input.prompt);
  return args;
}

export function parseOpenCodeRunJsonLines(output: string): OpenCodeRunJsonParseResult {
  const textParts: string[] = [];
  let sessionId = "";
  let usage: Record<string, unknown> | undefined;
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
    if (event.type === "text" && typeof event.part?.text === "string") textParts.push(event.part.text);
    if (event.type === "error") throw new Error(openCodeRunErrorMessage(event));
    if (event.type === "step_finish") {
      const tokens = event.part?.tokens;
      if (tokens && typeof tokens === "object") {
        usage = {
          inputTokens: numberValue(tokens.input),
          outputTokens: numberValue(tokens.output),
          totalTokens: numberValue(tokens.total)
        };
      }
    }
  }
  return {
    text: textParts.join("").trim(),
    sessionId: sessionId || undefined,
    usage
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
