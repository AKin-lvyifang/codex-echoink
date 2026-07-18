import type { AgentBackendKind } from "../agent/types";
import type { KnowledgeBaseMaintenanceHistoryEntry } from "../settings/settings";
import type {
  KnowledgeBaseDurableMaintenanceResult,
  KnowledgeBaseRunCommitState,
  KnowledgeBaseRunCompletion,
  KnowledgeBaseRunTerminalPhase,
  KnowledgeRunAttemptRecord
} from "./types";

const AGENT_BACKENDS = new Set<AgentBackendKind>([
  "codex-cli",
  "opencode",
  "hermes"
]);
const TERMINAL_PHASES = new Set<KnowledgeBaseRunTerminalPhase>([
  "preflight",
  "execution",
  "verification",
  "commit",
  "cleanup",
  "finalized",
  "recovery-blocked"
]);
const COMMIT_STATES = new Set<KnowledgeBaseRunCommitState>([
  "pre-wal",
  "wal-persisted",
  "committed"
]);
const COMPLETIONS = new Set<KnowledgeBaseRunCompletion>([
  "full",
  "partial",
  "recovered",
  "noop"
]);
const DURABLE_STATUSES = new Set<KnowledgeBaseDurableMaintenanceResult["status"]>([
  "success",
  "failed",
  "canceled"
]);

/**
 * Validates the public terminal contract shared by Runner, Scheduler, history
 * recovery and UI projection. This is deliberately stricter than the legacy
 * KnowledgeBaseRunResult shape.
 */
export function assertDurableMaintenanceResult(
  result: KnowledgeBaseDurableMaintenanceResult
): void {
  if (!DURABLE_STATUSES.has(result.status)) {
    throw new Error("durable maintenance result status 非法");
  }
  if (!TERMINAL_PHASES.has(result.terminalPhase)) {
    throw new Error("durable maintenance result terminalPhase 非法");
  }
  if (!COMMIT_STATES.has(result.commitState)) {
    throw new Error("durable maintenance result commitState 非法");
  }
  if (
    result.completion !== undefined
    && !COMPLETIONS.has(result.completion)
  ) {
    throw new Error("durable maintenance result completion 非法");
  }
  if (
    !result.workflowRunId.trim()
    || result.workflowRunId.length > 512
    || result.workflowRunId.includes("\0")
  ) {
    throw new Error("durable maintenance result 缺少合法 workflowRunId");
  }
  if (!AGENT_BACKENDS.has(result.selectedBackend)) {
    throw new Error("durable maintenance result selectedBackend 非法");
  }
  if (!Array.isArray(result.attempts) || result.attempts.length > 3) {
    throw new Error("durable maintenance result attempts 非法");
  }
  assertAttemptSequence(result.selectedBackend, result.attempts);

  const completedAttempts = result.attempts.filter(
    (attempt) => attempt.terminal?.status === "completed"
  );
  if (result.winnerBackend === null) {
    // An Agent attempt can finish before later verification/planning fails.
    // It is not a workflow winner until the WAL intent locks it.
  } else {
    if (!AGENT_BACKENDS.has(result.winnerBackend)) {
      throw new Error("durable maintenance result winnerBackend 非法");
    }
    if (
      completedAttempts.length !== 1
      || completedAttempts[0].backend !== result.winnerBackend
    ) {
      throw new Error("durable maintenance result winner 与 completed attempt 不一致");
    }
  }
  if (
    result.completion === "noop"
    && (result.attempts.length !== 0 || result.winnerBackend !== null)
  ) {
    throw new Error("noop durable maintenance result 必须零 attempt、零 winner");
  }

  assertDurableStateCombination(result);

  if (result.status === "success") {
    if (result.failureCode !== null) {
      throw new Error("成功 durable maintenance result 的 failureCode 必须为 null");
    }
    if (result.completion !== "noop" && result.winnerBackend === null) {
      throw new Error("非 noop 成功 durable maintenance result 缺少 winner");
    }
  } else {
    if (
      typeof result.failureCode !== "string"
      || !result.failureCode.trim()
      || result.failureCode.length > 160
    ) {
      throw new Error("失败/取消 durable maintenance result 缺少稳定 failureCode");
    }
    if (
      result.commitState === "wal-persisted"
      && result.winnerBackend === null
      && result.completion !== "noop"
    ) {
      throw new Error("WAL-persisted durable maintenance result 必须锁定 winner");
    }
  }
}

export function durableMaintenanceWinnerBackend(
  attempts: readonly KnowledgeRunAttemptRecord[]
): AgentBackendKind | null {
  const completed = attempts.filter(
    (attempt) => attempt.terminal?.status === "completed"
  );
  return completed.length === 1 ? completed[0].backend : null;
}

export function durableMaintenanceResultFromHistory(
  entry: KnowledgeBaseMaintenanceHistoryEntry
): KnowledgeBaseDurableMaintenanceResult | null {
  const hasOwn = (key: keyof KnowledgeBaseMaintenanceHistoryEntry): boolean =>
    Object.prototype.hasOwnProperty.call(entry, key);
  if (
    (entry.mode !== "maintain" && entry.mode !== "reingest")
    || !entry.runId
    || !entry.selectedBackend
    || !hasOwn("winnerBackend")
    || entry.winnerBackend === undefined
    || !Array.isArray(entry.attempts)
    || !entry.terminalPhase
    || !entry.commitState
    || !hasOwn("failureCode")
    || entry.failureCode === undefined
  ) {
    return null;
  }

  const result: KnowledgeBaseDurableMaintenanceResult = {
    status: entry.status,
    reportPath: entry.reportPath,
    summary: "",
    processedSources: [],
    workflowRunId: entry.runId,
    selectedBackend: entry.selectedBackend,
    winnerBackend: entry.winnerBackend ?? null,
    attempts: entry.attempts,
    terminalPhase: entry.terminalPhase,
    commitState: entry.commitState,
    completion: entry.completion,
    pendingSources: entry.pendingSources ?? [],
    failureCode: entry.failureCode ?? null,
    warnings: entry.warnings ?? []
  };
  try {
    assertDurableMaintenanceResult(result);
  } catch {
    return null;
  }
  if (
    (result.status === "success" && result.commitState !== "committed")
    || (
      result.status !== "success"
      && (
        result.commitState !== "pre-wal"
        || result.completion !== undefined
      )
    )
  ) {
    return null;
  }
  return result;
}

function assertAttemptSequence(
  selectedBackend: AgentBackendKind,
  attempts: readonly KnowledgeRunAttemptRecord[]
): void {
  const seenBackends = new Set<AgentBackendKind>();
  const seenAttemptIds = new Set<string>();
  for (const [index, attempt] of attempts.entries()) {
    if (
      !attempt.attemptId.trim()
      || attempt.attemptId.length > 512
      || attempt.attemptId.includes("\0")
      || attempt.ordinal !== index + 1
      || !AGENT_BACKENDS.has(attempt.backend)
      || seenBackends.has(attempt.backend)
      || seenAttemptIds.has(attempt.attemptId)
    ) {
      throw new Error("durable maintenance result attempt 序列非法");
    }
    if (index === 0 && attempt.backend !== selectedBackend) {
      throw new Error("durable maintenance result 首个 attempt 不是 selected Agent");
    }
    seenBackends.add(attempt.backend);
    seenAttemptIds.add(attempt.attemptId);
  }
}

function assertDurableStateCombination(
  result: KnowledgeBaseDurableMaintenanceResult
): void {
  if (result.commitState === "committed") {
    if (
      result.status !== "success"
      || result.terminalPhase !== "finalized"
      || result.completion === undefined
    ) {
      throw new Error(
        "committed durable maintenance result 必须是 success/finalized/completion"
      );
    }
    return;
  }

  if (result.commitState === "wal-persisted") {
    if (
      result.status !== "failed"
      || (
        result.terminalPhase !== "commit"
        && result.terminalPhase !== "cleanup"
      )
      || result.completion === undefined
    ) {
      throw new Error(
        "WAL-persisted durable maintenance result 必须是 failed/commit-or-cleanup/completion"
      );
    }
    return;
  }

  if (
    result.status === "success"
    || result.terminalPhase === "finalized"
    || result.completion !== undefined
    || result.winnerBackend !== null
  ) {
    throw new Error(
      "pre-WAL durable maintenance result 必须是 failed-or-canceled/非 finalized/无 completion/零 winner"
    );
  }
}
