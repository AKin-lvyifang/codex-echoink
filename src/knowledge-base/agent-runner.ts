import * as path from "path";
import { runAgentTaskWithToolBridge } from "../agent/tool-bridge";
import type { AgentTaskRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind, AgentInputModality, AgentModelInfo, AgentPromptPart, AgentTaskInput } from "../agent/types";
import { requiredModalityForMime } from "../core/opencode-models";
import type { UserInput } from "../types/app-server";
import { formatAgentTaskFailureContext, isKnowledgeBaseCancelError } from "./failure";
import type { KnowledgeBaseSource } from "./types";

const MAX_ATTACHED_SOURCES = 20;
const CODEX_KNOWLEDGE_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const OPENCODE_KNOWLEDGE_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const HERMES_KNOWLEDGE_TASK_TIMEOUT_MS = 20 * 60 * 1000;

export function buildCodexKnowledgeInput(prompt: string, sources: KnowledgeBaseSource[]): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const source of sources.slice(0, MAX_ATTACHED_SOURCES)) {
    if (source.modality === "image") {
      input.push({ type: "localImage", path: source.absolutePath });
    } else {
      input.push({ type: "mention", name: path.basename(source.absolutePath), path: source.absolutePath });
    }
  }
  return input;
}

export function buildOpenCodeKnowledgeParts(prompt: string, sources: KnowledgeBaseSource[]): AgentPromptPart[] {
  return [
    { type: "text", text: prompt },
    ...sources.slice(0, MAX_ATTACHED_SOURCES).map((source): AgentPromptPart => ({
      type: "file",
      path: source.absolutePath,
      filename: path.basename(source.absolutePath),
      mime: source.mime
    }))
  ];
}

export function requiredModalities(parts: AgentPromptPart[]): AgentInputModality[] {
  const modalities = new Set<AgentInputModality>(["text"]);
  for (const part of parts) {
    if (part.type === "file") modalities.add(requiredModalityForMime(part.mime));
  }
  return Array.from(modalities);
}

export function selectOpenCodeModel(models: AgentModelInfo[], providerId: string, modelId: string, required: AgentInputModality[]): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  if (configured) return configured;
  return models.find((model) => required.every((modality) => model.inputModalities.includes(modality))) ?? models[0] ?? null;
}

export function selectAgentModel(models: AgentModelInfo[], providerId: string, modelId: string): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  return configured ?? models[0] ?? null;
}

export async function runKnowledgeAgentTask(runtime: AgentTaskRuntime, input: AgentTaskInput, onEvent?: (event: { type: string; runId?: string }) => void) {
  return await runAgentTaskWithToolBridge(runtime, input, (event) => {
    onEvent?.(event);
  });
}

export function formatAgentTaskGuardError(backend: AgentBackendKind, phase: string, runId: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isKnowledgeBaseCancelError(message)) return error instanceof Error ? error : new Error(message);
  return new Error(formatAgentTaskFailureContext({ backend, phase, runId, message }));
}

export function buildPromptWithPreparedResources(prompt: string, resources: PreparedAgentResources): string {
  return [
    resources.promptPrefix,
    resources.warnings.length ? `资源提示：\n${resources.warnings.map((item) => `- ${item}`).join("\n")}` : "",
    prompt
  ].filter(Boolean).join("\n\n");
}

export function normalizeCodexInactivityTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return CODEX_KNOWLEDGE_INACTIVITY_TIMEOUT_MS;
}

export function rejectAfterTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
      reject(new Error(message));
    }, Math.max(1, timeoutMs));
    promise.then((value) => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(value);
    }, (error) => {
      if (timer) clearTimeout(timer);
      timer = null;
      reject(error);
    });
  });
}

export function normalizeOpenCodeTaskTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return OPENCODE_KNOWLEDGE_TASK_TIMEOUT_MS;
}

export function normalizeHermesTaskTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return HERMES_KNOWLEDGE_TASK_TIMEOUT_MS;
}

export function formatDurationForError(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}
