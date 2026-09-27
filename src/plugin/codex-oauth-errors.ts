export const OPENAI_CODEX_RELOGIN_REQUIRED_MESSAGE =
  "OpenAI Codex 授权已失效，请在设置中重新登录。";

const AUTH_FAILURE_MESSAGES = {
  provider_oauth_relogin_required: OPENAI_CODEX_RELOGIN_REQUIRED_MESSAGE,
  provider_network_error: "OpenAI Codex 授权服务连接失败，请检查网络后重试。",
  provider_rate_limited: "OpenAI Codex 授权请求暂时受限，请稍后重试。",
  provider_request_rejected: "OpenAI Codex 拒绝了授权请求，请检查设置后重试。",
  provider_service_unavailable: "OpenAI Codex 授权服务暂时不可用，请稍后重试。",
  provider_protocol_failed: "OpenAI Codex 授权响应格式异常，请重试。",
  provider_unavailable: "OpenAI Codex 授权暂不可用，请重试。"
} as const;

export type OpenAICodexAuthFailureCode = keyof typeof AUTH_FAILURE_MESSAGES;

/** Only a safe code and fixed message cross the OAuth dependency boundary. */
export class OpenAICodexAuthError extends Error {
  constructor(readonly code: OpenAICodexAuthFailureCode) {
    super(AUTH_FAILURE_MESSAGES[code]);
    this.name = "OpenAICodexAuthError";
  }
}

export function safeOpenAICodexAuthError(error: unknown): OpenAICodexAuthError {
  // Pi adds ModelsError wrappers while preserving the original error as cause.
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") break;
    const entry = current as { code?: unknown; cause?: unknown };
    if (typeof entry.code === "string" && Object.hasOwn(AUTH_FAILURE_MESSAGES, entry.code)) {
      return new OpenAICodexAuthError(entry.code as OpenAICodexAuthFailureCode);
    }
    current = entry.cause;
  }
  return new OpenAICodexAuthError("provider_unavailable");
}

export async function fetchOpenAICodexOAuthToken(
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  input: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch {
    throw new OpenAICodexAuthError("provider_network_error");
  }
}

export async function readOpenAICodexTokenResponse(response: Response): Promise<{
  access: string;
  refresh: string;
  expires: number;
}> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    // HTTP status remains useful even when an intermediary returned HTML.
  }
  const body = value && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new OpenAICodexAuthError("provider_oauth_relogin_required");
    }
    if (response.status === 429) {
      throw new OpenAICodexAuthError("provider_rate_limited");
    }
    if (response.status >= 500) {
      throw new OpenAICodexAuthError("provider_service_unavailable");
    }
    const error = body?.error;
    const errorCode = typeof error === "string" ? error
      : error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
    if (response.status === 400 && typeof errorCode === "string" && [
      "invalid_grant", "invalid_token", "refresh_token_expired",
      "refresh_token_invalidated", "refresh_token_reused"
    ].includes(errorCode)) {
      throw new OpenAICodexAuthError("provider_oauth_relogin_required");
    }
    if (response.status === 400 || response.status === 422) {
      throw new OpenAICodexAuthError("provider_request_rejected");
    }
    if (response.status === 404 || response.status === 405) {
      throw new OpenAICodexAuthError("provider_protocol_failed");
    }
    throw new OpenAICodexAuthError("provider_unavailable");
  }
  if (
    typeof body?.access_token !== "string" || !body.access_token
    || typeof body.refresh_token !== "string" || !body.refresh_token
    || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in)
  ) {
    throw new OpenAICodexAuthError("provider_protocol_failed");
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000
  };
}
