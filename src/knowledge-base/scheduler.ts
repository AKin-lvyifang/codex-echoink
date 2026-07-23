import type {
  KnowledgeBaseMaintenanceHistoryEntry,
  KnowledgeBaseSettings
} from "../settings/settings";
import {
  scheduledMaintenanceRetryDelayMs,
  shouldRunScheduledKnowledgeBaseMaintenance
} from "./schedule";
import {
  assertDurableMaintenanceResult,
  durableMaintenanceResultFromHistory
} from "./maintenance-terminal";
import type {
  KnowledgeBaseDurableMaintenanceResult,
  KnowledgeBaseRunResult
} from "./types";

export interface ScheduledMaintenanceInvocation {
  workflowRunId: string;
  scheduledStartedAt: number;
}

export interface KnowledgeBaseSchedulerHost {
  getSettings(): KnowledgeBaseSettings;
  isRunning(): boolean;
  registerInterval(intervalId: number): void;
  waitUntilMaintenanceReady(): Promise<void>;
  persistSettings(): Promise<void>;
  runMaintenance(invocation: ScheduledMaintenanceInvocation): Promise<KnowledgeBaseRunResult>;
  settleScheduledMaintenance(result: KnowledgeBaseRunResult): Promise<void>;
  refreshKnowledgeBaseSurfaces(): void;
}

export class KnowledgeBaseScheduler {
  private scheduleTimer: number | null = null;
  private schedulerStartedAt = 0;
  private scheduledRunPromise: Promise<void> | null = null;
  private recoveryPendingRunId = "";

  constructor(private readonly host: KnowledgeBaseSchedulerHost) {}

  start(): void {
    this.schedulerStartedAt = Date.now();
    this.armSchedule();
    void this.runCatchUpIfNeeded();
  }

  unload(): void {
    if (!this.scheduleTimer) return;
    window.clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  runScheduledIfDue(forceCatchUp = false): Promise<void> {
    if (this.scheduledRunPromise) return this.scheduledRunPromise;
    let guardedRun!: Promise<void>;
    guardedRun = this.runScheduledIfDueOnce(forceCatchUp).finally(() => {
      if (this.scheduledRunPromise === guardedRun) this.scheduledRunPromise = null;
    });
    this.scheduledRunPromise = guardedRun;
    return guardedRun;
  }

  private async runScheduledIfDueOnce(forceCatchUp: boolean): Promise<void> {
    const settings = this.host.getSettings();
    if (!settings.enabled) return;
    if (this.recoveryPendingRunId) {
      if (!this.hasRecoveredScheduledTerminal(
        settings,
        this.recoveryPendingRunId
      )) {
        return;
      }
      this.recoveryPendingRunId = "";
    }
    if (!shouldRunScheduledKnowledgeBaseMaintenance(
      settings,
      new Date(Date.now()),
      this.schedulerStartedAt,
      forceCatchUp
    )) return;

    try {
      await this.host.waitUntilMaintenanceReady();
    } catch (error) {
      console.warn("每日知识库维护等待恢复门禁失败，本次调度未启动", error);
      return;
    }

    // Recovery may have reconciled the scheduled terminal while this trigger
    // was waiting. Re-evaluate before touching durable scheduler state.
    const readySettings = this.host.getSettings();
    if (this.host.isRunning()) return;
    if (!readySettings.enabled) return;
    if (!shouldRunScheduledKnowledgeBaseMaintenance(
      readySettings,
      new Date(Date.now()),
      this.schedulerStartedAt,
      forceCatchUp
    )) return;

    const scheduledStartedAt = Math.max(
      Date.now(),
      readySettings.lastScheduledRunAt + 1
    );
    const invocation: ScheduledMaintenanceInvocation = {
      scheduledStartedAt,
      workflowRunId: `knowledge-maintain-scheduled-${scheduledStartedAt}`
    };
    const previousScheduledState = {
      lastScheduledRunAt: readySettings.lastScheduledRunAt,
      lastScheduledRunStatus: readySettings.lastScheduledRunStatus,
      lastScheduledRunId: readySettings.lastScheduledRunId,
      scheduledAttemptCount: readySettings.scheduledAttemptCount,
      scheduledNextRetryAt: readySettings.scheduledNextRetryAt
    };
    readySettings.scheduledAttemptCount = scheduledAttemptCountForInvocation(
      readySettings,
      invocation.scheduledStartedAt
    );
    readySettings.scheduledNextRetryAt = 0;
    readySettings.lastScheduledRunAt = invocation.scheduledStartedAt;
    readySettings.lastScheduledRunStatus = "running";
    readySettings.lastScheduledRunId = invocation.workflowRunId;
    try {
      await this.host.persistSettings();
    } catch (error) {
      this.restoreScheduledStateIfOwned(
        readySettings,
        invocation,
        "running",
        previousScheduledState
      );
      console.warn("每日知识库维护运行状态保存失败，本次调度未启动", error);
      return;
    }

    let result: KnowledgeBaseRunResult;
    try {
      result = await this.host.runMaintenance(invocation);
    } catch (error) {
      this.recoveryPendingRunId = invocation.workflowRunId;
      console.warn(
        "每日知识库维护运行异常，提交边界未知，保持 running 等待恢复",
        error
      );
      return;
    }
    try {
      assertDurableMaintenanceResult(
        result as KnowledgeBaseDurableMaintenanceResult
      );
    } catch (error) {
      this.recoveryPendingRunId = invocation.workflowRunId;
      console.warn(
        "每日知识库维护返回了不可信终态，保持 running 等待恢复",
        error
      );
      return;
    }

    if (result.commitState === "committed") {
      const projected = this.host.getSettings();
      if (!this.matchesCommittedProjection(
        projected,
        invocation,
        result as KnowledgeBaseDurableMaintenanceResult
      )) {
        this.recoveryPendingRunId = invocation.workflowRunId;
        console.warn(
          "每日知识库维护已返回 committed，但 WAL 定时终态投影不匹配，保持现状等待恢复"
        );
        return;
      }
      await this.publishScheduledTerminal(result);
      return;
    }

    if (result.commitState === "wal-persisted") {
      this.recoveryPendingRunId = invocation.workflowRunId;
      console.warn("每日知识库维护 WAL 已持久化，保持 running 等待恢复");
      return;
    }

    if (
      result.commitState !== "pre-wal"
      || result.workflowRunId !== invocation.workflowRunId
      || (result.status !== "failed" && result.status !== "canceled")
    ) {
      this.recoveryPendingRunId = invocation.workflowRunId;
      console.warn(
        "每日知识库维护缺少可信 pre-WAL 终态，保持 running 等待恢复"
      );
      return;
    }

    const currentSettings = this.host.getSettings();
    if (!this.matchesScheduledState(currentSettings, invocation, "running")) {
      this.recoveryPendingRunId = invocation.workflowRunId;
      console.warn(
        "每日知识库维护运行状态已被其他事务更新，拒绝覆盖 scheduled 终态"
      );
      return;
    }
    currentSettings.lastScheduledRunStatus = result.status;
    currentSettings.scheduledNextRetryAt =
      scheduledMaintenanceNextRetryAt(result, currentSettings);
    try {
      await this.host.persistSettings();
    } catch (error) {
      if (this.matchesScheduledState(currentSettings, invocation, result.status)) {
        currentSettings.lastScheduledRunStatus = "running";
        currentSettings.scheduledNextRetryAt = 0;
      }
      this.recoveryPendingRunId = invocation.workflowRunId;
      console.warn(
        "每日知识库维护 pre-WAL 终态保存失败，保持 running 等待恢复",
        error
      );
      return;
    }
    await this.publishScheduledTerminal(result);
  }

  private matchesCommittedProjection(
    settings: KnowledgeBaseSettings,
    invocation: ScheduledMaintenanceInvocation,
    result: KnowledgeBaseDurableMaintenanceResult
  ): boolean {
    if (
      result.status !== "success"
      || result.workflowRunId !== invocation.workflowRunId
      || !this.matchesScheduledState(settings, invocation, result.status)
    ) {
      return false;
    }
    const historyResult = this.uniqueDurableHistoryResult(
      settings,
      invocation.workflowRunId
    );
    return historyResult !== null
      && durableHistoryMatchesResult(historyResult, result);
  }

  private hasRecoveredScheduledTerminal(
    settings: KnowledgeBaseSettings,
    workflowRunId: string
  ): boolean {
    const status = settings.lastScheduledRunStatus;
    if (
      settings.lastScheduledRunId !== workflowRunId
      || status === "idle"
      || status === "running"
    ) {
      return false;
    }
    const historyResult = this.uniqueDurableHistoryResult(
      settings,
      workflowRunId
    );
    return historyResult !== null
      && historyResult.status === status;
  }

  private uniqueDurableHistoryResult(
    settings: KnowledgeBaseSettings,
    workflowRunId: string
  ): KnowledgeBaseDurableMaintenanceResult | null {
    const matching = (settings.maintenanceHistory ?? []).filter(
      (entry) => entry.runId === workflowRunId
    );
    if (matching.length !== 1) return null;
    return durableMaintenanceResultFromHistory(matching[0]);
  }

  private matchesScheduledState(
    settings: KnowledgeBaseSettings,
    invocation: ScheduledMaintenanceInvocation,
    status: KnowledgeBaseSettings["lastScheduledRunStatus"]
  ): boolean {
    return settings.lastScheduledRunId === invocation.workflowRunId
      && settings.lastScheduledRunAt === invocation.scheduledStartedAt
      && settings.lastScheduledRunStatus === status;
  }

  private restoreScheduledStateIfOwned(
    settings: KnowledgeBaseSettings,
    invocation: ScheduledMaintenanceInvocation,
    status: KnowledgeBaseSettings["lastScheduledRunStatus"],
    previous: Pick<
      KnowledgeBaseSettings,
      | "lastScheduledRunAt"
      | "lastScheduledRunStatus"
      | "lastScheduledRunId"
      | "scheduledAttemptCount"
      | "scheduledNextRetryAt"
    >
  ): void {
    if (!this.matchesScheduledState(settings, invocation, status)) return;
    settings.lastScheduledRunAt = previous.lastScheduledRunAt;
    settings.lastScheduledRunStatus = previous.lastScheduledRunStatus;
    settings.lastScheduledRunId = previous.lastScheduledRunId;
    settings.scheduledAttemptCount = previous.scheduledAttemptCount;
    settings.scheduledNextRetryAt = previous.scheduledNextRetryAt;
  }

  private async publishScheduledTerminal(
    result: KnowledgeBaseRunResult
  ): Promise<void> {
    try {
      await this.host.settleScheduledMaintenance(result);
    } catch (error) {
      console.warn("每日知识库维护终态收口失败", error);
    }
    try {
      this.host.refreshKnowledgeBaseSurfaces();
    } catch (error) {
      console.warn("每日知识库维护界面刷新失败", error);
    }
  }

  private armSchedule(): void {
    if (this.scheduleTimer) window.clearInterval(this.scheduleTimer);
    this.scheduleTimer = window.setInterval(() => void this.runScheduledIfDue(), 60 * 1000);
    this.host.registerInterval(this.scheduleTimer);
  }

  private async runCatchUpIfNeeded(): Promise<void> {
    if (!this.host.getSettings().catchUpOnStartup) return;
    await this.runScheduledIfDue(true);
  }

}

function scheduledAttemptCountForInvocation(
  settings: KnowledgeBaseSettings,
  scheduledStartedAt: number
): number {
  const previous = settings.lastScheduledRunAt > 0
    ? new Date(settings.lastScheduledRunAt)
    : null;
  const current = new Date(scheduledStartedAt);
  const previousAttemptCount = Number.isSafeInteger(
    settings.scheduledAttemptCount
  )
    ? Math.max(0, settings.scheduledAttemptCount)
    : 0;
  return previous?.toDateString() === current.toDateString()
    ? previousAttemptCount + 1
    : 1;
}

function scheduledMaintenanceNextRetryAt(
  result: KnowledgeBaseRunResult,
  settings: KnowledgeBaseSettings
): number {
  if (result.status !== "failed") return 0;
  const terminalFailure = [...(result.attempts ?? [])]
    .reverse()
    .find((attempt) => attempt.failure)?.failure;
  if (terminalFailure?.retryable !== true) return 0;
  const delay = scheduledMaintenanceRetryDelayMs(
    settings.scheduledAttemptCount
  );
  return delay === null ? 0 : Date.now() + delay;
}

function durableHistoryMatchesResult(
  history: KnowledgeBaseDurableMaintenanceResult,
  result: KnowledgeBaseDurableMaintenanceResult
): boolean {
  return history.status === result.status
    && history.workflowRunId === result.workflowRunId
    && history.reportPath === result.reportPath
    && history.completion === result.completion
    && history.selectedBackend === result.selectedBackend
    && history.winnerBackend === result.winnerBackend
    && maintenanceJsonEquals(history.attempts, result.attempts)
    && history.terminalPhase === result.terminalPhase
    && history.commitState === result.commitState
    && history.failureCode === result.failureCode
    && maintenanceJsonEquals(
      history.pendingSources ?? [],
      result.pendingSources ?? []
    )
    && maintenanceJsonEquals(
      history.warnings ?? [],
      result.warnings ?? []
    );
}

function maintenanceJsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) =>
        maintenanceJsonEquals(value, right[index])
      );
  }
  if (
    !left
    || !right
    || typeof left !== "object"
    || typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index]
      && maintenanceJsonEquals(leftRecord[key], rightRecord[key])
    );
}
