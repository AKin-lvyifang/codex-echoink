export function formatOpenCodeError(error: any): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  const message = typeof error?.message === "string"
    ? error.message
    : typeof error?.data?.message === "string"
      ? error.data.message
      : "";
  const code = firstOpenCodeString(error?.code, error?.data?.code, error?.status, error?.data?.status);
  const status = firstOpenCodeString(error?.status, error?.statusText, error?.data?.status, error?.data?.statusText);
  const details = [
    code ? `错误码：${code}` : "",
    status && status !== code ? `状态：${status}` : "",
    message ? `原始消息：${message}` : "",
    `原始错误：${safeOpenCodeStringify(error)}`
  ].filter(Boolean);
  if (details.length) return details.join("\n");
  return safeOpenCodeStringify(error);
}

export function isOpenCodeNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, any>;
  const status = firstFiniteOpenCodeNumber(
    value.status,
    value.statusCode,
    value.code,
    value.data?.status,
    value.data?.statusCode,
    value.data?.code
  );
  if (status === 404) return true;
  const name = firstOpenCodeString(value.name, value.data?.name).toLowerCase();
  if (name === "notfounderror" || name === "not_found") return true;
  const message = firstOpenCodeString(value.message, value.data?.message).toLowerCase();
  return /\bsession\s+not\s+found\b/.test(message);
}

function firstOpenCodeString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstFiniteOpenCodeNumber(...values: any[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function safeOpenCodeStringify(error: any): string {
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
