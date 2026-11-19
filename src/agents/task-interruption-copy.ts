import { TOOL_ROUND_STOP_MESSAGE } from "./tool-round-budget";
import type { TaskInterruptionRecord } from "./task-resume";
import { PROVIDER_FAILURE_DETAIL_PREFIX, providerFailureHttpStatus, providerFailureText, safeProviderFailureCode } from "../harness/pi/provider-failure";
import { errorText, joinErrorCopy, NEXT, type ErrorCopy } from "../core/error-copy";
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
  if (info.reason === "tool_loop_limit") return TOOL_ROUND_STOP_MESSAGE;
  if (info.reason === "watchdog") return joinErrorCopy(["Agent 已连续 5 分钟无进展，任务已停止。", "The agent made no progress for 5 minutes, so the task was stopped."], NEXT.continueTask, language);
  if (info.reason !== "run_failed" || !info.detail) return;
  // The raw detail stays in the record for "Report a problem"; the card only shows plain words.
  const firstLine = info.detail.split(`\n${PROVIDER_FAILURE_DETAIL_PREFIX}`)[0];
  const knownText = providerFailureText(firstLine, language) ?? undefined;
  if (info.retryAttempts) {
    const stopped: ErrorCopy = [`已自动重试 ${info.retryAttempts} 次仍未成功，任务已停止。`, `Retried automatically ${info.retryAttempts} times without success, so the task was stopped.`];
    return joinErrorCopy(stopped, knownText ? [knownText, knownText] : RETRY_LATER_CONTINUE, language);
  }
  if (knownText) return knownText;
  return errorText(firstLine, TASK_STOPPED, language);
}

const RETRY_LATER_CONTINUE: ErrorCopy = ["请稍后点击“继续”重试。", "Click Continue later to try again."];
/** Scene fallback for a failed run whose reason is not recognised. */
export const TASK_STOPPED: ErrorCopy = ["任务执行出错，已停止。请点击“继续”恢复执行；如问题持续，请点击“上报问题”。", "The task encountered an error and stopped. Click Continue to resume; if the problem persists, click Report a problem."];
