import type { ChatMessage } from "../settings/settings";
import type { GenerationRequest, GenerationResult } from "./types";
import { GENERATION_REQUEST_ENTRY, GENERATION_RESULT_ENTRY, generationRequestSummary } from "./request";
import type { GenerationStage } from "./runtime";
export const GENERATION_STAGE_ENTRY = "echoink.generation-stage.v1";
export const GENERATION_ATTEMPT_ENTRY = "echoink.generation-attempt.v1";
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
  const attemptUsers = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Record<string, unknown>;
    if (typeof data.productRunId !== "string") continue;
    if (entry.customType === GENERATION_REQUEST_ENTRY && data.request && typeof data.request === "object") requests.set(data.productRunId, data.request as GenerationRequest);
    if (entry.customType === GENERATION_ATTEMPT_ENTRY && typeof data.userEntryId === "string") attemptUsers.set(data.userEntryId, data.productRunId);
    if (entry.customType === GENERATION_RESULT_ENTRY && data.result && typeof data.result === "object") results.set(data.productRunId, data.result as GenerationResult);
    if (entry.customType === GENERATION_STAGE_ENTRY && typeof data.stage === "string" && data.stage in GENERATION_STAGE_TITLES) {
      const stage = generationStageMessage(data as unknown as GenerationStageData);
      const previous = stages.get(stage.id); if (previous) stage.createdAt = previous.createdAt;
      stages.set(stage.id, stage);
    }
  }
  // Ordinary Pi replay assigns each retry user a synthetic turn. Persisted
  // attempt identities bring every response back under its one generation run.
  const attemptRuns = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "user" || !message.runId) continue;
    for (const [entryId, runId] of attemptUsers) {
      if (message.id.endsWith(`:entry:${encodeURIComponent(entryId)}`) && requests.has(runId)) attemptRuns.set(message.runId, runId);
    }
  }
  messages = messages.map(message => {
    const runId = message.runId && attemptRuns.get(message.runId);
    return runId ? { ...message, runId, turnId: runId } : message;
  });
  const lastAssistant = new Map<string, string>();
  for (const message of messages) {
    if (message.runId && requests.has(message.runId) && message.role === "assistant" && !message.processKind) lastAssistant.set(message.runId, message.id);
  }
  const shownUsers = new Set<string>();
  const projected = messages.flatMap(message => {
    const request = message.runId && requests.get(message.runId);
    if (!request) return [message];
    if (message.role === "user") {
      if (shownUsers.has(message.runId!)) return [];
      shownUsers.add(message.runId!);
      return [{ ...message, text: generationRequestSummary(request), generationRequest: structuredClone(request) }];
    }
    if (message.role === "assistant" && !message.processKind) {
      if (lastAssistant.get(message.runId!) !== message.id) return [];
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
  for (const [runId, result] of results) {
    const runStages = [...stages.values()].filter(stage => stage.runId === runId);
    const terminalReasoning = messages.filter(message => message.reasoningSummary?.productRunId === runId && message.reasoningSummary.terminalAt !== undefined)
      .map(message => message.reasoningSummary!).sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const status = runStages.some(stage => stage.status === "cancelled") ? "cancelled"
      : terminalReasoning && (terminalReasoning.status === "cancelled" || terminalReasoning.status === "interrupted" || terminalReasoning.status === "failed") ? terminalReasoning.status
        : result.writeState === "verified" ? "completed" : result.writeState === "unconfirmed" ? "interrupted" : "failed";
    const terminalAt = Math.max(terminalReasoning?.terminalAt ?? 0, ...runStages.map(stage => stage.completedAt ?? stage.createdAt));
    for (let index = 0; index < projected.length; index++) {
      const message = projected[index];
      if (message.runId !== runId || !message.assistantTurn && !message.generationResult) continue;
      // A model can finish its public thinking before the controlled write is
      // cancelled. Its completed segment is not the generation turn outcome.
      projected[index] = { ...message,
        ...(message.generationResult ? { status } : {}),
        ...(message.assistantTurn ? { assistantTurn: { ...message.assistantTurn, status,
          updatedAt: Math.max(message.assistantTurn.updatedAt, terminalAt),
          completedAt: Math.max(message.assistantTurn.completedAt ?? 0, terminalAt) } } : {}) };
    }
  }
  return positionGenerationMessages(projected);
}

export function isGenerationProgressMessage(message: Pick<ChatMessage, "id" | "itemType">): boolean {
  return message.itemType === "generationProgress" || message.itemType === "dynamicToolCall" && message.id.startsWith("generation:") && message.id.includes(":tool:generation-");
}
export function generationProgressStage(message: Pick<ChatMessage, "id" | "itemType">): GenerationStage | undefined {
  if (!isGenerationProgressMessage(message)) return undefined;
  if (message.itemType === "dynamicToolCall") return "approval";
  const stage = message.id.split(":").at(-1);
  return stage && stage in GENERATION_STAGE_TITLES ? stage as GenerationStage : undefined;
}
export function generationProgressTitle(message: ChatMessage): string {
  const stage = generationProgressStage(message);
  return stage ? GENERATION_STAGE_TITLES[stage] : message.title ?? "生成资料";
}
/** A replayed user event replaces the accepted seed. Keep its generation
 * members after it so the ordinary Assistant Turn grouping has no user gap. */
export function positionGenerationMessages(messages: ChatMessage[], targetRunId?: string): ChatMessage[] {
  const runs = new Set(messages.filter(message => (!targetRunId || message.runId === targetRunId)
    && (message.generationRequest || message.generationResult || isGenerationProgressMessage(message))).map(message => message.runId).filter((id): id is string => Boolean(id)));
  for (const runId of runs) {
    const user = messages.find(message => message.role === "user" && message.runId === runId);
    if (!user) continue;
    const members = messages.filter(message => message.runId === runId && message.role !== "user");
    if (!members.length) continue;
    const retained = messages.filter(message => message.runId !== runId || message.role === "user");
    retained.splice(retained.indexOf(user) + 1, 0, ...members);
    messages.splice(0, messages.length, ...retained);
  }
  return messages;
}
/** Display-only conversion; authorization strings and decision binding stay untouched. */
export function generationApprovalPresentation(target?: string, preview?: string): { target?: string; preview?: string } {
  let readableTarget = target, readablePreview = preview;
  try {
    const value = JSON.parse(target ?? "") as { relativePath?: unknown };
    if (typeof value?.relativePath === "string") readableTarget = value.relativePath;
  } catch { /* An already readable path remains literal. */ }
  try {
    const value = JSON.parse(preview ?? "") as { content?: unknown; change?: { diff?: unknown; truncated?: unknown } };
    if (typeof value?.change?.diff === "string") readablePreview = value.change.diff + (value.change.truncated === true ? "\n差异预览已截短。" : "");
    else if (typeof value?.content === "string") readablePreview = value.content;
  } catch { /* An already readable preview remains literal. */ }
  return { target: readableTarget, preview: readablePreview };
}
