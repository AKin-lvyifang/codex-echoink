export function formatHermesError(error: unknown): string {
  const message = extractHermesErrorMessage(error);
  if (isHermesProviderConfigurationError(message)) {
    return `Hermes 推理 provider 未配置。请在 Hermes Agent 设置里选择 provider/model，并配置对应 API key。\n\n原始错误：${message}`;
  }
  if (/API_SERVER_KEY|unauthorized|401|invalid api key/i.test(message)) {
    return `Hermes API 请求失败：认证失败。请检查 Hermes API Server Key。\n\n原始错误：${message}`;
  }
  return `Hermes API 请求失败：${message}`;
}

export function isHermesProviderConfigurationError(error: unknown): boolean {
  const message = extractHermesErrorMessage(error);
  return /No inference provider configured|provider.*not configured|missing.*api key/i.test(message);
}

function extractHermesErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const anyError = error as any;
  const status = typeof anyError?.status === "number" ? `状态：${anyError.status}。` : "";
  const data = anyError?.data;
  const message = data?.error?.message ?? data?.message ?? anyError?.message ?? String(error);
  return `${status}${String(message)}`.trim();
}
