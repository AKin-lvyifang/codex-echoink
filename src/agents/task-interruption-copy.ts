import { localizeKnownConversationSystemCopy } from "../ui/codex-view/ui-i18n";
import type { TaskInterruptionRecord } from "./task-resume";
import { providerFailureHttpStatus, providerFailureText, safeProviderFailureCode } from "../harness/pi/provider-failure";
import { redactEchoInkLocalSecretsV1 } from "../security/local-secrets";

/** Persist a bounded category when available; never infer that retries happened. */
export function interruptionErrorDetail(message: string): string {
  const status = providerFailureHttpStatus(message);
  return safeProviderFailureCode(message) ?? (status === 429 ? "provider_rate_limited" : status && status >= 500 ? "provider_service_failed" : undefined)
    ?? redactEchoInkLocalSecretsV1(message).slice(0, 1500);
}

/** Only recorded facts replace the historical, genuinely unknown interruption copy. */
export function taskInterruptionExplanation(info: (Pick<TaskInterruptionRecord, "detail" | "retryAttempts"> & { reason: string }) | undefined | null, language: string): string | undefined {
  if (!info) return;
  const en = language === "en";
  if (info.reason === "watchdog") return en
    ? "The agent made no progress for 5 minutes and was stopped. Tap Continue to retry."
    : "Agent 已经 5 分钟没有任何进展，已停止。可以点继续重试。";
  if (info.reason !== "run_failed" || !info.detail) return;
  const known = providerFailureText(info.detail);
  const detail = known ? localizeKnownConversationSystemCopy(en ? "en" : "zh-CN", known) : info.detail;
  if (info.retryAttempts) return en
    ? `A temporary error persisted after ${info.retryAttempts} retries, so the agent stopped. Last error: ${detail}`
    : `临时错误重试 ${info.retryAttempts} 次后仍失败，已停止。最后的错误：${detail}`;
  return en ? `The run failed: ${detail}` : `执行失败：${detail}`;
}
