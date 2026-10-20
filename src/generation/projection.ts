import type { ChatMessage } from "../settings/settings";
import type { GenerationRequest, GenerationResult } from "./types";
import { GENERATION_REQUEST_ENTRY, GENERATION_RESULT_ENTRY, generationRequestSummary } from "./request";
import type { GenerationStage } from "./runtime";
export const GENERATION_STAGE_ENTRY = "echoink.generation-stage.v1";
export const GENERATION_STAGE_TITLES: Record<GenerationStage, string> = { reading: "读取资料", writing: "按模板写作", layout: "排版导图", approval: "等你确认写入", saving: "写入文件" };
export interface GenerationStageData { productRunId: string; requestId?: string; stage: GenerationStage; status: "running" | "completed" | "failed" | "cancelled"; at: number }
export function generationStageMessage(data: GenerationStageData): ChatMessage {
  return { id: data.stage === "approval" && data.requestId ? `generation:${data.productRunId}:tool:${encodeURIComponent(`generation-${data.requestId}`)}` : `generation:${data.productRunId}:${data.stage}`, role: "system", text: "", title: GENERATION_STAGE_TITLES[data.stage],
    itemType: data.stage === "approval" ? "dynamicToolCall" : "generationProgress", processKind: data.stage === "reading" ? "view" : data.stage === "saving" ? "edit" : "tool", status: data.stage === "approval" && data.status === "running" ? "waiting_approval" : data.status,
    ...(data.stage === "approval" ? { approval: { status: data.status === "running" ? "pending" as const : data.status === "failed" ? "denied" as const : data.status === "cancelled" ? "cancelled" as const : "approved" as const } } : {}),
    runId: data.productRunId, turnId: data.productRunId, createdAt: data.at, ...(data.status === "running" ? {} : { completedAt: data.at }) };
}
export function generationResultText(result: GenerationResult): string {
  let text = result.writeState === "verified" ? "已生成并核对文件。" : result.writeState === "unconfirmed" ? "写入结果未确认，请先核对，不要重复生成。" : result.error ?? "尚未写入文件。";
  if (result.readFailures.length) text += `\n\n未能读取的资料：\n${result.readFailures.map(failure => `- ${failure.path}：${failure.reason}`).join("\n")}`;
  return text;
}
/** Rebuilds from Pi custom entries, including offline task reopening. */
export function projectGenerationEntries(messages: ChatMessage[], entries: readonly { type: string; customType?: string; data?: unknown }[]): ChatMessage[] {
  const requests = new Map<string, GenerationRequest>(), results = new Map<string, GenerationResult>(), stages = new Map<string, ChatMessage>();
  for (const entry of entries) {
    if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Record<string, unknown>;
    if (typeof data.productRunId !== "string") continue;
    if (entry.customType === GENERATION_REQUEST_ENTRY && data.request && typeof data.request === "object") requests.set(data.productRunId, data.request as GenerationRequest);
    if (entry.customType === GENERATION_RESULT_ENTRY && data.result && typeof data.result === "object") results.set(data.productRunId, data.result as GenerationResult);
    if (entry.customType === GENERATION_STAGE_ENTRY && typeof data.stage === "string" && data.stage in GENERATION_STAGE_TITLES) {
      const stage = generationStageMessage(data as unknown as GenerationStageData);
      const previous = stages.get(stage.id); if (previous) stage.createdAt = previous.createdAt;
      stages.set(stage.id, stage);
    }
  }
  const projected = messages.flatMap(message => {
    const request = message.runId && requests.get(message.runId);
    if (!request) return [message];
    if (message.role === "user") return [{ ...message, text: generationRequestSummary(request), generationRequest: structuredClone(request) }];
    if (message.role === "assistant" && !message.processKind) {
      const result = results.get(message.runId!);
      return result ? [{ ...message, text: generationResultText(result), generationRequest: structuredClone(request), generationResult: structuredClone(result), rawRef: undefined, previewText: undefined }] : [];
    }
    return [message];
  });
  for (const [runId, result] of results) {
    if (projected.some(message => message.runId === runId && message.generationResult)) continue;
    const request = requests.get(runId);
    projected.push({ id: `generation:${runId}:result`, role: "assistant", text: generationResultText(result), runId, turnId: runId,
      generationRequest: request, generationResult: result, status: result.writeState === "verified" ? "completed" : "failed", createdAt: request ? Date.parse(request.createdAt) : 0 });
  }
  for (const stage of stages.values()) {
    const existing = projected.findIndex(message => message.id === stage.id);
    if (existing >= 0) projected[existing] = stage; else {
      const final = projected.findIndex(message => message.runId === stage.runId && message.generationResult);
      if (final >= 0) projected.splice(final, 0, stage); else projected.push(stage);
    }
  }
  return projected;
}
