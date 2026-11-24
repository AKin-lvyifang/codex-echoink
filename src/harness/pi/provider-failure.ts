import { replaceKnownSecrets } from "../../security/local-secrets";
import { XIAOECHO_REQUEST_REJECTED, xiaoechoFailureCode, xiaoechoFailureText } from "../../membership/xiaoecho-catalog";
import { CAUSE, pickErrorCopy } from "../../core/error-copy";
import { PROVIDER_CODES, PROVIDER_FAILURE_CODE_IDS } from "../../core/error-copy/codes/provider";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isOpenCodeGoApiProviderUrl } from "../../settings/provider-presets";

export interface ProviderFailureDetail {
  status?: number;
  code?: string;
  param?: string;
  message?: string;
  reason?: "unsupported" | "invalid" | "required" | "out_of_range";
}

/** Classify the last request, never the accumulated answer or prior tool calls. */
export function isReasoningOutputLimit(message: {
  stopReason?: string;
  errorMessage?: string;
  content?: string | readonly { type: string; text?: string; thinking?: string }[];
  usage?: { reasoning?: number };
} | undefined): boolean {
  if (!message || (message.stopReason !== "length"
    && !(message.stopReason === "error" && message.errorMessage === "provider_output_limit_reached"))) return false;
  const content = message.content;
  if (typeof content === "string") return !content.trim() && (message.usage?.reasoning ?? 0) > 0;
  if (content?.some(block => block.type !== "thinking" && (block.type !== "text" || Boolean(block.text?.trim())))) return false;
  return (message.usage?.reasoning ?? 0) > 0 || Boolean(content?.some(block => block.type === "thinking" && block.thinking?.trim()));
}

/** Billing/account exhaustion can arrive as HTTP 429, without being a throttle. */
export function isProviderQuotaExhausted(message: string): boolean {
  return /insufficient[_ -]?quota|quota[_ -]?(?:exceeded|exhausted)|out of (?:budget|credits?)|insufficient (?:balance|credits?)|billing|gousagelimiterror|freeusagelimiterror|monthly usage limit reached|available balance|余额不足|额度(?:不足|用尽|耗尽)/iu.test(message.slice(0, 8_192));
}

export type ProviderPlanFailureCode =
  | "provider_plan_subscription_required"
  | "provider_plan_usage_limited";

/** Recognize the raw provider error and the safe code emitted by the desktop adapter. */
export function providerPlanFailureCode(message: string): ProviderPlanFailureCode | null {
  const head = message.slice(0, 8_192);
  if (head === "provider_plan_subscription_required" || /\bEntitlementError\b|subscription required/iu.test(head)) return "provider_plan_subscription_required";
  if (head === "provider_plan_usage_limited" || /\b(?:Go|Free)UsageLimitError\b/iu.test(head)) return "provider_plan_usage_limited";
  return null;
}

export function openCodeGoPlanFailureCode(baseUrl: string, status: number | null, raw: unknown): ProviderPlanFailureCode | null {
  if (!isOpenCodeGoApiProviderUrl(baseUrl)) return null;
  const error = raw && typeof raw === "object" && "error" in raw ? raw.error : raw;
  const message = error && typeof error === "object"
    ? ["type", "code", "message"].map(key => (error as Record<string, unknown>)[key])
      .filter((value): value is string => typeof value === "string").join(" ")
    : typeof error === "string" ? error : "";
  const code = providerPlanFailureCode(message);
  const httpStatus = status ?? providerFailureHttpStatus(message);
  if (httpStatus === 403) return code === "provider_plan_subscription_required" ? code : null;
  if (httpStatus === 429) return code === "provider_plan_usage_limited" ? code : null;
  return httpStatus === null ? code : null;
}

export type AssistantProviderFailure = AssistantMessage & {
  echoInkProviderFailure?: ProviderFailureDetail;
};

/** Known SDK status prefixes only; never infer status from arbitrary provider prose. */
export function providerFailureHttpStatus(message: string): number | null {
  const match = message.match(/^(?:(?:HTTP\s+)?([1-5]\d{2})(?:[:\s]|$)|OpenAI API error \(([1-5]\d{2})\):)/u);
  return match ? Number(match[1] ?? match[2]) : null;
}

/** Keep bounded, redacted upstream message text, never the full response or request. */
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
  else if (typeof candidate?.error === "string") candidate = { message: candidate.error };
  const safeField = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.[\]-]{0,63}$/u.test(value)) return undefined;
    if (secrets.some((secret) => secret && value.includes(secret)) || /^(?:authorization|api.?key|access_token|refresh_token|secret|password|prompt|messages|request|content|body)$/iu.test(value)) return undefined;
    return value;
  };
  const message = typeof candidate?.message === "string" ? candidate.message : text;
  const param = safeField(candidate?.param) ?? safeField(message.match(/(?:parameter|param)\s*[:=]?\s*[`'"]?([A-Za-z][A-Za-z0-9_.-]*)/iu)?.[1]);
  const code = safeField(candidate?.code);
  const effectiveStatus = status ?? (typeof candidate?.status === "number" ? candidate.status : providerFailureHttpStatus(text));
  const reason = effectiveStatus === 401 || effectiveStatus === 403 ? undefined
    : /unsupported|not supported|unknown parameter/iu.test(message) ? "unsupported"
    : /must|range|exceed|maximum|limit/iu.test(message) ? "out_of_range"
    : /required|missing/iu.test(message) ? "required"
    : /invalid/iu.test(message) ? "invalid" : undefined;
  const upstreamMessage = typeof candidate?.message === "string"
    ? sanitizeProviderMessage(candidate.message, secrets) : "";
  const detail: ProviderFailureDetail = {
    ...(Number.isInteger(effectiveStatus) && effectiveStatus! >= 100 && effectiveStatus! <= 599 ? { status: effectiveStatus! } : {}),
    ...(code ? { code } : {}),
    ...(upstreamMessage ? { message: upstreamMessage } : {}),
    ...(param ? { param } : {}),
    ...(reason && (param || code) ? { reason } : {})
  };
  return Object.keys(detail).length ? detail : undefined;
}

function sanitizeProviderMessage(value: string, secrets: readonly string[]): string {
  const message = replaceKnownSecrets(value, secrets, "[已隐藏凭据]");
  return message
    .replace(/\bauthorization\s*:\s*[^;\r\n]+/giu, "[已隐藏凭据]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "[已隐藏凭据]")
    .replace(/\b(?:sk|pk|sess)-[A-Za-z0-9_-]{8,}/gu, "[已隐藏凭据]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,;]+/giu, "$1[已隐藏凭据]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim().slice(0, 512);
}

export function providerFailureDetailText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const raw = value as ProviderFailureDetail;
  const detail = sanitizeProviderFailureDetail(raw.status ?? null, { code: raw.code, param: raw.param, message: raw.message });
  if (!detail) return "";
  const reason = { unsupported: "不支持该参数", invalid: "参数无效", required: "缺少必填参数", out_of_range: "参数超出允许范围" };
  return [detail.status ? `HTTP ${detail.status}` : "", detail.code, detail.param,
    !detail.message && detail.status !== 401 && detail.status !== 403 && raw.reason && Object.hasOwn(reason, raw.reason) ? reason[raw.reason] : "", detail.message].filter(Boolean).join(" · ");
}

/** Technical upstream detail stays available for support, on its own labelled line. */
export const PROVIDER_FAILURE_DETAIL_PREFIX = "模型服务返回的原始信息（可提供给客服排查）：";

export function assistantProviderFailureText(message: { errorMessage?: string; echoInkProviderFailure?: unknown }): string {
  // 小echo answers with fixed EchoInk codes ({ error: "POINTS_INSUFFICIENT" }); those read as plain words, not as "HTTP 402 · CODE".
  const own = xiaoechoProviderFailureText(message.echoInkProviderFailure);
  if (own) return own;
  // Raw upstream detail never reaches the bubble; "上报问题" carries it in the run report.
  return providerFailureText(message.errorMessage) ?? CAUSE.providerNotResponding[0];
}
export function xiaoechoProviderFailureText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as ProviderFailureDetail;
  if (raw.code === XIAOECHO_REQUEST_REJECTED) return xiaoechoFailureText(raw.code, undefined, raw.message);
  for (const candidate of [raw.code, raw.message]) {
    if (typeof candidate !== "string" || !/^[A-Z][A-Z_]{3,40}$/u.test(candidate)) continue;
    const text = xiaoechoFailureText(candidate);
    if (text) return text;
  }
  return null;
}

export function xiaoechoProviderFailureDetail(value: unknown): ProviderFailureDetail {
  const code = xiaoechoFailureCode(value);
  if (code === XIAOECHO_REQUEST_REJECTED) return { code };
  return xiaoechoFailureText(code) ? { message: code } : { code: XIAOECHO_REQUEST_REJECTED, message: code };
}

const PROVIDER_FAILURE_CODES: ReadonlySet<string> = new Set(PROVIDER_FAILURE_CODE_IDS);

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

/** Code → sentence from core/error-copy/codes/provider.ts; Chinese unless a language is given. */
export function providerFailureText(value: unknown, language?: string): string | null {
  if (typeof value !== "string") return null;
  const [reason, diagnostic] = value.split(`\n${PROVIDER_FAILURE_DETAIL_PREFIX}`, 2);
  if (diagnostic === "CONTENT_TOO_LONG") return xiaoechoFailureText(diagnostic, language);
  const [serviceCode, serverCode] = diagnostic?.split(" · ", 2) ?? [];
  if (serviceCode === XIAOECHO_REQUEST_REJECTED) return xiaoechoFailureText(serviceCode, language, serverCode);
  const code = safeProviderFailureCode(reason);
  return code ? pickErrorCopy(PROVIDER_CODES[code], language) : null;
}
