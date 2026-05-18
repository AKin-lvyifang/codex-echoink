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

function firstOpenCodeString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function safeOpenCodeStringify(error: any): string {
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
