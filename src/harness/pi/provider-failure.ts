import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface ProviderFailureDetail {
  status?: number;
  code?: string;
  param?: string;
  reason?: "unsupported" | "invalid" | "required" | "out_of_range";
}

export type AssistantProviderFailure = AssistantMessage & {
  echoInkProviderFailure?: ProviderFailureDetail;
};

/** Never retain raw bodies or arbitrary message text. Reasons are a finite vocabulary. */
export function sanitizeProviderFailureDetail(status: number | null, raw: unknown, secrets: readonly string[] = []): ProviderFailureDetail | undefined {
  const text = typeof raw === "string" ? raw.slice(0, 8192) : "";
  let candidate: Record<string, unknown> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) candidate = raw as Record<string, unknown>;
  else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { candidate = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { /* no reliable structured body */ }
    }
  }
  if (candidate?.error && typeof candidate.error === "object" && !Array.isArray(candidate.error)) candidate = candidate.error as Record<string, unknown>;
  const safeField = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.[\]-]{0,63}$/u.test(value)) return undefined;
    if (secrets.some((secret) => secret && value.includes(secret)) || /^(?:authorization|api.?key|access_token|refresh_token|secret|password|prompt|messages|request|content|body)$/iu.test(value)) return undefined;
    return value;
  };
  const message = typeof candidate?.message === "string" ? candidate.message : text;
  const param = safeField(candidate?.param) ?? safeField(message.match(/(?:parameter|param)\s*[:=]?\s*[`'"]?([A-Za-z][A-Za-z0-9_.-]*)/iu)?.[1]);
  const code = safeField(candidate?.code);
  const reason = /unsupported|not supported|unknown parameter/iu.test(message) ? "unsupported"
    : /must|range|exceed|maximum|limit/iu.test(message) ? "out_of_range"
    : /required|missing/iu.test(message) ? "required"
    : /invalid/iu.test(message) ? "invalid" : undefined;
  const effectiveStatus = status ?? (Number(text.match(/^(?:HTTP\s+)?([1-5]\d{2})(?:[:\s]|$)/u)?.[1]) || null);
  const detail: ProviderFailureDetail = {
    ...(Number.isInteger(effectiveStatus) && effectiveStatus! >= 100 && effectiveStatus! <= 599 ? { status: effectiveStatus! } : {}),
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    ...(reason && (param || code) ? { reason } : {})
  };
  return Object.keys(detail).length ? detail : undefined;
}

export function providerFailureDetailText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const raw = value as ProviderFailureDetail;
  const detail = sanitizeProviderFailureDetail(raw.status ?? null, { code: raw.code, param: raw.param });
  if (!detail) return "";
  const reason = { unsupported: "不支持该参数", invalid: "参数无效", required: "缺少必填参数", out_of_range: "参数超出允许范围" };
  return [detail.status ? `HTTP ${detail.status}` : "", detail.code, detail.param,
    raw.reason && Object.hasOwn(reason, raw.reason) ? reason[raw.reason] : ""].filter(Boolean).join(" · ");
}

export function assistantProviderFailureText(message: { errorMessage?: string; echoInkProviderFailure?: unknown }): string {
  const generic = providerFailureText(message.errorMessage) ?? "Provider 请求失败，请检查服务与请求设置。";
  const detail = providerFailureDetailText(message.echoInkProviderFailure);
  return detail ? `${generic}\n${detail}` : generic;
}

const PROVIDER_FAILURE_CODES = new Set([
  "context_length_exceeded",
  "controlled_transport_aborted",
  "provider_api_key_missing",
  "provider_auth_failed",
  "provider_content_filtered",
  "provider_finish_reason_missing",
  "provider_finish_reason_unsupported",
  "provider_http_failed",
  "provider_http_incomplete",
  "provider_model_invalid",
  "provider_model_unavailable",
  "provider_network_error",
  "provider_network_error_http_incomplete",
  "provider_network_failed",
  "provider_network_interrupted",
  "provider_oauth_relogin_required",
  "provider_output_limit_reached",
  "provider_partial_interrupted_context",
  "provider_partial_interrupted_deadline",
  "provider_partial_interrupted_network",
  "provider_partial_interrupted_rate",
  "provider_partial_interrupted_service",
  "provider_protocol_failed",
  "provider_protocol_mismatch",
  "provider_rate_limited",
  "provider_request_rejected",
  "provider_request_timeout",
  "provider_service_failed",
  "provider_service_unavailable",
  "provider_sse_json_invalid",
  "provider_tool_call_missing",
  "provider_unavailable",
  "provider_utf8_invalid"
]);

export function safeProviderFailureCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return PROVIDER_FAILURE_CODES.has(normalized) ? normalized : null;
}

export function providerFailureCodeFromError(error: unknown): string | null {
  if (typeof error === "string") return safeProviderFailureCode(error);
  if (!error || typeof error !== "object") return null;
  return safeProviderFailureCode("code" in error ? error.code : null)
    ?? safeProviderFailureCode("message" in error ? error.message : null);
}

export function assistantHasPartialOutput(
  message: Pick<AssistantMessage, "content"> | undefined
): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (block.type === "toolCall") return true;
    if (block.type === "text") return block.text.length > 0;
    return block.type === "thinking" && block.thinking.length > 0;
  });
}

/**
 * Pi retries by matching transient words in Assistant.errorMessage. Once an
 * attempt exposed any public partial, replace every Pi retry/compact trigger
 * with content-free codes that deliberately match neither retry nor overflow.
 */
export function preventProviderRetryAfterPartial(
  safeCode: string,
  partial: Pick<AssistantMessage, "content"> | undefined
): string {
  if (!assistantHasPartialOutput(partial)) return safeCode;
  if (safeCode === "context_length_exceeded") {
    return "provider_partial_interrupted_context";
  }
  if (safeCode === "provider_request_timeout") {
    return "provider_partial_interrupted_deadline";
  }
  if (
    safeCode === "provider_network_error"
    || safeCode === "provider_network_error_http_incomplete"
  ) {
    return "provider_partial_interrupted_network";
  }
  if (safeCode === "provider_rate_limited") {
    return "provider_partial_interrupted_rate";
  }
  if (safeCode === "provider_service_unavailable") {
    return "provider_partial_interrupted_service";
  }
  return safeCode;
}

export function providerFailureText(value: unknown): string | null {
  const code = safeProviderFailureCode(value);
  if (!code) return null;
  switch (code) {
    case "provider_output_limit_reached":
      return "达到输出上限，回答未完整生成。";
    case "provider_content_filtered":
      return "内容被 Provider 安全策略拦截，回答未完成。";
    case "provider_finish_reason_missing":
      return "Provider 未返回结束原因，回答未完成。";
    case "provider_finish_reason_unsupported":
      return "Provider 返回了不支持的结束原因，回答未完成。";
    case "provider_sse_json_invalid":
      return "Provider 返回的流数据格式损坏，回答未完成。";
    case "provider_http_incomplete":
    case "provider_network_error_http_incomplete":
      return "网络连接提前结束，回答未完整接收。";
    case "provider_utf8_invalid":
      return "Provider 返回的文本编码无效，回答未完成。";
    case "provider_network_error":
    case "provider_network_failed":
    case "provider_network_interrupted":
    case "provider_partial_interrupted_network":
      return "网络连接中断，回答未完成。";
    case "provider_partial_interrupted_context":
      return "本次回答在上下文超限前已产生部分内容，已停止自动重试。";
    case "provider_partial_interrupted_rate":
    case "provider_rate_limited":
      return "Provider 请求过于频繁或额度已用尽，请稍后重试或检查账户额度。";
    case "provider_request_timeout":
      return "等待 Provider 回答超时，请稍后重试。";
    case "provider_partial_interrupted_deadline":
      return "等待后续回答超时，已保留收到的内容并停止自动重试。";
    case "provider_request_rejected":
      return "Provider 拒绝了请求，请检查模型或参数设置。";
    case "provider_partial_interrupted_service":
    case "provider_service_failed":
    case "provider_service_unavailable":
    case "provider_unavailable":
      return "Provider 服务暂时不可用，回答未完成。";
    case "provider_tool_call_missing":
      return "Provider 声明了工具调用，但没有返回完整工具参数。";
    case "provider_auth_failed":
    case "provider_api_key_missing":
      return "Provider 凭证不可用，请检查设置。";
    case "provider_oauth_relogin_required":
      return "OpenAI Codex 授权已失效，请在设置中重新登录。";
    case "provider_model_invalid":
    case "provider_model_unavailable":
      return "当前 Provider 模型不可用，请检查模型设置。";
    case "context_length_exceeded":
      return "当前对话超过模型上下文上限。";
    case "controlled_transport_aborted":
      return "已停止生成。";
    case "provider_http_failed":
      return "Provider 请求失败，请检查服务与请求设置。";
    case "provider_protocol_failed":
    case "provider_protocol_mismatch":
      return "Provider 返回格式不符合当前协议，回答未完成。";
  }
  return null;
}
