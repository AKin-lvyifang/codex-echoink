import type { ChatMessage } from "../../settings/settings";

const ACTIVE_STATUSES = new Set(["running", "in_progress", "inProgress", "approval", "blocked"]);
const FAILED_STATUSES = new Set(["failed", "error", "canceled", "cancelled", "interrupted"]);
const ATTENTION_PROCESS_STATUSES = new Set(["unconfirmed", "interrupted", "failed", "error", "canceled", "cancelled"]);

export interface CompletedAgentTurn {
  key: string;
  runId: string;
  finalAnswer: ChatMessage;
  processMessages: ChatMessage[];
  processIndices: number[];
  processStartIndex: number;
  finalAnswerIndex: number;
  durationMs: number;
  failed: boolean;
  requiresAttention: boolean;
}

export type AgentTurnProjectionItem =
  | { kind: "message"; index: number; message: ChatMessage }
  | { kind: "completedProcess"; index: number; turn: CompletedAgentTurn };

export function isAgentProcessItemType(itemType?: string): boolean {
  return itemType === "thinking" ||
    itemType === "reasoning" ||
    itemType === "commandExecution" ||
    itemType === "fileChange" ||
    itemType === "mcpToolCall" ||
    itemType === "dynamicToolCall" ||
    itemType === "collabAgentToolCall" ||
    itemType === "plan" ||
    itemType === "contextCompaction";
}

export function isAgentAnswerMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.itemType === "knowledgeBase") return false;
  return !isAgentProcessItemType(message.itemType);
}

export function isAgentTurnTerminalMessage(message: ChatMessage): boolean {
  if (isAgentAnswerMessage(message)) return true;
  return message.role === "system" && message.itemType === "error" && (!message.status || FAILED_STATUSES.has(message.status));
}

export function buildCompletedAgentTurns(messages: ChatMessage[]): CompletedAgentTurn[] {
  const indicesByKey = new Map<string, number[]>();
  messages.forEach((message, index) => {
    const key = agentTurnKey(message);
    if (!key) return;
    const indices = indicesByKey.get(key) ?? [];
    indices.push(index);
    indicesByKey.set(key, indices);
  });

  const turns: CompletedAgentTurn[] = [];
  for (const [key, indices] of indicesByKey) {
    const finalAnswerIndex = indices.slice().reverse().find((index) => isAgentTurnTerminalMessage(messages[index]));
    if (finalAnswerIndex === undefined) continue;
    const relevantIndices = indices.filter((index) => index <= finalAnswerIndex);
    if (indices.some((index) => ACTIVE_STATUSES.has(messages[index].status ?? ""))) continue;
    const processIndices = relevantIndices.filter((index) => {
      const message = messages[index];
      if (index === finalAnswerIndex || message.role === "user" || message.itemType === "knowledgeBase") return false;
      return isAgentProcessItemType(message.itemType) || isAgentAnswerMessage(message);
    });
    if (!processIndices.length) continue;
    const processStartIndex = processIndices[0];
    if (hasForeignTurnBetween(messages, processStartIndex, finalAnswerIndex, key)) continue;
    const finalAnswer = messages[finalAnswerIndex];
    const timestamps = relevantIndices.map((index) => messages[index].createdAt).filter(isFiniteTimestamp);
    const startedAt = timestamps.length ? Math.min(...timestamps) : 0;
    const fallbackCompletedAt = timestamps.length ? Math.max(...timestamps) : startedAt;
    const completedAt = isFiniteTimestamp(finalAnswer.completedAt) ? finalAnswer.completedAt : fallbackCompletedAt;
    turns.push({
      key,
      runId: finalAnswer.runId ?? finalAnswer.turnId ?? "",
      finalAnswer,
      processMessages: processIndices.map((index) => messages[index]),
      processIndices,
      processStartIndex,
      finalAnswerIndex,
      durationMs: Math.max(0, completedAt - startedAt),
      failed: finalAnswer.itemType === "error" || FAILED_STATUSES.has(finalAnswer.status ?? ""),
      requiresAttention: processIndices.some((index) => ATTENTION_PROCESS_STATUSES.has(messages[index].status ?? ""))
    });
  }
  return turns.sort((a, b) => a.processStartIndex - b.processStartIndex);
}

export function buildAgentTurnProjection(messages: ChatMessage[]): AgentTurnProjectionItem[] {
  const completedTurns = buildCompletedAgentTurns(messages);
  const completedTurnByStart = new Map(completedTurns.map((turn) => [turn.processStartIndex, turn]));
  const foldedIndices = new Set(completedTurns.flatMap((turn) => turn.processIndices));
  const projection: AgentTurnProjectionItem[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const completedTurn = completedTurnByStart.get(index);
    if (completedTurn) {
      projection.push({ kind: "completedProcess", index, turn: completedTurn });
      continue;
    }
    if (foldedIndices.has(index)) continue;
    projection.push({ kind: "message", index, message: messages[index] });
  }
  return projection;
}

export function insertAgentProcessMessage(messages: ChatMessage[], message: ChatMessage): void {
  const key = agentTurnKey(message);
  const answerIndex = key ? lastMatchingAnswerIndex(messages, key) : -1;
  if (answerIndex >= 0) messages.splice(answerIndex, 0, message);
  else messages.push(message);
}

export function markAgentAnswerStreaming(message: ChatMessage): void {
  message.status = "running";
  delete message.completedAt;
}

export function settleAgentAnswer(
  messages: ChatMessage[],
  runId: string,
  status: "completed" | "failed" | "interrupted",
  completedAt: number
): ChatMessage | null {
  if (!runId) return null;
  const index = lastMatchingAnswerIndex(messages, `run:${runId}`);
  const message = index >= 0 ? messages[index] : null;
  if (!message) return null;
  message.status = status;
  message.completedAt = completedAt;
  return message;
}

export function formatAgentTurnDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `已处理 ${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `已处理 ${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `已处理 ${seconds}s`;
}

function agentTurnKey(message: ChatMessage): string {
  if (message.runId) return `run:${message.runId}`;
  if (message.turnId) return `turn:${message.turnId}`;
  return "";
}

function lastMatchingAnswerIndex(messages: ChatMessage[], key: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (agentTurnKey(messages[index]) === key && isAgentAnswerMessage(messages[index])) return index;
  }
  return -1;
}

function hasForeignTurnBetween(messages: ChatMessage[], startIndex: number, endIndex: number, key: string): boolean {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const message = messages[index];
    const candidate = agentTurnKey(message);
    if (candidate && candidate !== key && (message.role === "user" || isAgentTurnTerminalMessage(message) || isAgentProcessItemType(message.itemType))) return true;
  }
  return false;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
