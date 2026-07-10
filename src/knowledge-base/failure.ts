export const KNOWLEDGE_BASE_CANCEL_ERROR = "知识库任务已取消";

export function isKnowledgeBaseCancelError(message: string): boolean {
  return message.trim() === KNOWLEDGE_BASE_CANCEL_ERROR;
}

export function formatKnowledgeBaseCodexFailureSignal(method: string, params: any, fallbackMessage: string): string {
  const status = firstString(params?.turn?.status, params?.status, params?.error?.status, params?.turn?.error?.status);
  const code = firstString(params?.code, params?.error?.code, params?.turn?.error?.code, params?.exitCode);
  const signal = firstString(params?.signal);
  const message = firstString(params?.message, params?.error?.message, params?.turn?.error?.message, params?.turn?.error, fallbackMessage);
  const threadId = firstString(params?.threadId, params?.thread?.id, params?.turn?.threadId, params?.item?.threadId);
  const turnId = firstString(params?.turnId, params?.turn?.id, params?.item?.turnId);
  const stderr = firstString(params?.stderr);
  return [
    `错误信号：${method || "unknown"}`,
    status ? `状态：${status}` : "",
    code ? `错误码：${code}` : "",
    signal ? `断流信号：${signal}` : "",
    message ? `原始消息：${message}` : "",
    threadId ? `threadId：${threadId}` : "",
    turnId ? `turnId：${turnId}` : "",
    stderr ? `stderr：${compactText(stderr, 1200)}` : "",
    `原始信号：${compactJson(params, 1500)}`
  ].filter(Boolean).join("\n");
}

export function formatAgentTaskFailureContext(input: {
  backend: string;
  phase: string;
  runId?: string;
  message: string;
}): string {
  return [
    `后端：${input.backend}`,
    `阶段：${input.phase || "unknown"}`,
    input.runId ? `runId：${input.runId}` : "",
    `错误：${input.message}`
  ].filter(Boolean).join("\n");
}

function firstString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function compactJson(value: any, maxLength: number): string {
  try {
    return compactText(JSON.stringify(value ?? {}, null, 2), maxLength);
  } catch {
    return compactText(String(value), maxLength);
  }
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
