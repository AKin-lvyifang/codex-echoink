import * as assert from "node:assert/strict";
import { buildKnowledgeBaseMaintainReportPayload } from "../../knowledge-base/maintain-report-card";
import { assertDurableMaintenanceResult } from "../../knowledge-base/maintenance-terminal";
import { buildScheduledKnowledgeBaseMessage } from "../../knowledge-base/scheduled-message";
import type {
  KnowledgeBaseDurableMaintenanceResult,
  KnowledgeBaseRunResult,
  KnowledgeBaseSource,
  KnowledgeRunAttemptRecord
} from "../../knowledge-base/types";
import {
  normalizeSettingsData,
  recordKnowledgeBaseMaintenanceRun
} from "../../settings/settings";

export function runHarnessV2MaintenanceResultStateTests(): void {
  assertLegacyResultStateRemainsReadable();
  assertPersistedResultStateIsBounded();
  assertRecordPersistsCompatibleOutcomeMetadata();
  assertPartialRecoveredAndNoopStaySuccessfulButReadable();
  assertDurableTerminalStateMatrix();
  assertCanonicalDurableTerminalInvariants();
}

function assertLegacyResultStateRemainsReadable(): void {
  const settings = normalizeSettingsData({
    knowledgeBase: {
      maintenanceHistory: [{
        date: "2026-07-17",
        status: "success",
        at: 17,
        mode: "maintain",
        reportPath: "outputs/maintenance/legacy.md"
      }]
    }
  }).settings.knowledgeBase;

  assert.equal(settings.lastCompletion, "");
  assert.deepEqual(settings.lastAttempts, []);
  assert.deepEqual(settings.lastPendingSources, []);
  assert.equal(settings.lastFailureCode, "");
  assert.deepEqual(settings.lastWarnings, []);
  assert.deepEqual(settings.maintenanceHistory, [{
    date: "2026-07-17",
    status: "success",
    at: 17,
    mode: "maintain",
    reportPath: "outputs/maintenance/legacy.md"
  }]);

  const payload = buildKnowledgeBaseMaintainReportPayload("maintain", successfulResult());
  assert.equal(payload.status, "success");
  assert.equal(payload.completion, undefined);
  assert.equal(payload.title, "知识库维护完成");
  assert.match(buildScheduledKnowledgeBaseMessage(successfulResult()), /- 状态：成功/);
}

function assertPersistedResultStateIsBounded(): void {
  const longMessage = "x".repeat(800);
  const attempts = Array.from({ length: 5 }, (_, index) => attempt(index + 1, longMessage));
  const pendingSources = Array.from({ length: 60 }, (_, index) => `raw/source-${index}.md`);
  const warnings = Array.from({ length: 15 }, (_, index) => ({
    id: `warning-${index}`,
    message: longMessage
  }));
  const settings = normalizeSettingsData({
    knowledgeBase: {
      lastCompletion: "partial",
      lastAttempts: attempts,
      lastPendingSources: pendingSources,
      lastFailureCode: "evidence-invalid",
      lastWarnings: warnings,
      maintenanceHistory: [{
        date: "2026-07-18",
        status: "success",
        at: 18,
        mode: "maintain",
        reportPath: "outputs/maintenance/partial.md",
        completion: "partial",
        attempts,
        pendingSources,
        warnings
      }]
    }
  }).settings.knowledgeBase;

  assert.equal(settings.lastCompletion, "partial");
  assert.equal(settings.lastAttempts.length, 3);
  assert.equal(settings.lastAttempts[0].terminal?.message?.length, 500);
  assert.equal(settings.lastPendingSources.length, 50);
  assert.equal(settings.lastWarnings.length, 10);
  assert.equal(settings.lastWarnings[0].message.length, 500);
  assert.equal(settings.maintenanceHistory[0].attempts?.length, 3);
  assert.equal(settings.maintenanceHistory[0].pendingSources?.length, 50);
  assert.equal(settings.maintenanceHistory[0].warnings?.length, 10);
}

function assertRecordPersistsCompatibleOutcomeMetadata(): void {
  const settings = normalizeSettingsData({}).settings.knowledgeBase;
  const attempts = [attempt(1), attempt(2)];
  recordKnowledgeBaseMaintenanceRun(settings, {
    status: "success",
    mode: "maintain",
    at: new Date(2026, 6, 18, 9, 0).getTime(),
    runId: "knowledge-maintain-partial",
    reportPath: "outputs/maintenance/partial.md",
    completion: "partial",
    selectedBackend: "codex-cli",
    winnerBackend: "opencode",
    attempts,
    pendingSources: ["raw/b.md", "raw/b.md", "raw/c.md"],
    failureCode: null,
    terminalPhase: "finalized",
    commitState: "committed",
    warnings: [{ id: "notification-failed", message: "通知没有送达，不影响已提交成果。" }]
  });

  assert.equal(settings.lastCompletion, "partial");
  assert.equal(settings.lastAttempts.length, 2);
  assert.deepEqual(settings.lastPendingSources, ["raw/b.md", "raw/c.md"]);
  assert.equal(settings.lastFailureCode, "");
  assert.deepEqual(settings.maintenanceHistory.at(-1), {
    date: "2026-07-18",
    status: "success",
    at: new Date(2026, 6, 18, 9, 0).getTime(),
    runId: "knowledge-maintain-partial",
    mode: "maintain",
    reportPath: "outputs/maintenance/partial.md",
    completion: "partial",
    selectedBackend: "codex-cli",
    winnerBackend: "opencode",
    attempts,
    pendingSources: ["raw/b.md", "raw/c.md"],
    failureCode: null,
    terminalPhase: "finalized",
    commitState: "committed",
    warnings: [{ id: "notification-failed", message: "通知没有送达，不影响已提交成果。" }]
  });
}

function assertPartialRecoveredAndNoopStaySuccessfulButReadable(): void {
  const partial: KnowledgeBaseRunResult = {
    ...successfulResult(),
    completion: "partial",
    processedSources: [source("raw/a.md")],
    pendingSources: ["raw/b.md"],
    warnings: [{ id: "thread-cleanup", message: "后台线程稍后清理。" }]
  };
  const partialPayload = buildKnowledgeBaseMaintainReportPayload("maintain", partial);
  assert.equal(partialPayload.status, "success");
  assert.equal(partialPayload.completion, "partial");
  assert.equal(partialPayload.title, "知识库维护部分完成");
  assert.equal(partialPayload.sections.some((section) => section.id === "pending-sources"), true);
  assert.match(buildScheduledKnowledgeBaseMessage(partial), /状态：部分完成/);
  assert.match(buildScheduledKnowledgeBaseMessage(partial), /1 个来源已安全留待下轮/);

  const recovered: KnowledgeBaseRunResult = {
    ...successfulResult(),
    completion: "recovered",
    attempts: [attempt(1), attempt(2)]
  };
  const recoveredPayload = buildKnowledgeBaseMaintainReportPayload("maintain", recovered);
  assert.equal(recoveredPayload.status, "success");
  assert.equal(recoveredPayload.title, "知识库维护已恢复完成");
  assert.match(buildScheduledKnowledgeBaseMessage(recovered), /状态：恢复后完成/);
  assert.match(buildScheduledKnowledgeBaseMessage(recovered), /共 2 次尝试/);

  const noop: KnowledgeBaseRunResult = {
    ...successfulResult(),
    completion: "noop"
  };
  const noopPayload = buildKnowledgeBaseMaintainReportPayload("maintain", noop);
  assert.equal(noopPayload.status, "success");
  assert.equal(noopPayload.title, "知识库维护完成（无新来源）");
  assert.match(buildScheduledKnowledgeBaseMessage(noop), /状态：已检查（无新来源）/);
}

function assertCanonicalDurableTerminalInvariants(): void {
  const noop: KnowledgeBaseDurableMaintenanceResult = {
    status: "success",
    reportPath: "outputs/maintenance/noop.md",
    summary: "无需处理",
    processedSources: [],
    workflowRunId: "knowledge-maintain-noop",
    selectedBackend: "hermes",
    winnerBackend: null,
    terminalPhase: "finalized",
    commitState: "committed",
    attempts: [],
    completion: "noop",
    failureCode: null
  };
  assert.doesNotThrow(() => assertDurableMaintenanceResult(noop));

  assert.throws(
    () => assertDurableMaintenanceResult({
      ...noop,
      attempts: [{
        attemptId: "knowledge-maintain-noop:attempt:1:hermes",
        ordinal: 1,
        backend: "hermes"
      }]
    }),
    /noop.*零 attempt/
  );
  assert.throws(
    () => assertDurableMaintenanceResult({
      ...noop,
      status: "failed",
      commitState: "wal-persisted",
      failureCode: "maintenance-commit-pending",
      attempts: [{
        attemptId: "knowledge-maintain-noop:attempt:1:hermes",
        ordinal: 1,
        backend: "hermes"
      }]
    }),
    /noop.*零 attempt/
  );
  assert.throws(
    () => assertDurableMaintenanceResult({
      ...noop,
      failureCode: "should-not-exist"
    }),
    /failureCode 必须为 null/
  );

  const recovered: KnowledgeBaseDurableMaintenanceResult = {
    ...noop,
    workflowRunId: "knowledge-maintain-recovered",
    selectedBackend: "codex-cli",
    winnerBackend: "opencode",
    attempts: [attempt(1), attempt(2)],
    completion: "recovered"
  };
  assert.doesNotThrow(() => assertDurableMaintenanceResult(recovered));
  assert.throws(
    () => assertDurableMaintenanceResult({
      ...recovered,
      winnerBackend: "hermes"
    }),
    /winner 与 completed attempt/
  );

  const roundTripped = normalizeSettingsData({
    knowledgeBase: {
      maintenanceHistory: [{
        date: "2026-07-18",
        status: "success",
        at: 20,
        runId: noop.workflowRunId,
        mode: "maintain",
        reportPath: noop.reportPath,
        completion: "noop",
        selectedBackend: noop.selectedBackend,
        winnerBackend: null,
        attempts: [],
        pendingSources: [],
        failureCode: null,
        terminalPhase: "finalized",
        commitState: "committed",
        warnings: []
      }]
    }
  }).settings.knowledgeBase.maintenanceHistory[0];
  assert.deepEqual(roundTripped, {
    date: "2026-07-18",
    status: "success",
    at: 20,
    runId: noop.workflowRunId,
    mode: "maintain",
    reportPath: noop.reportPath,
    completion: "noop",
    selectedBackend: "hermes",
    winnerBackend: null,
    attempts: [],
    pendingSources: [],
    failureCode: null,
    terminalPhase: "finalized",
    commitState: "committed",
    warnings: []
  });

  const workflowRunId = `workflow-${"w".repeat(503)}`;
  const attemptId = `attempt-${"a".repeat(504)}`;
  assert.equal(workflowRunId.length, 512);
  assert.equal(attemptId.length, 512);
  const longIdRoundTrip = normalizeSettingsData({
    knowledgeBase: {
      maintenanceHistory: [{
        date: "2026-07-18",
        status: "failed",
        at: 21,
        runId: workflowRunId,
        mode: "maintain",
        reportPath: "",
        selectedBackend: "codex-cli",
        winnerBackend: null,
        attempts: [{
          attemptId,
          ordinal: 1,
          backend: "codex-cli",
          terminal: {
            status: "failed",
            at: 21
          }
        }],
        failureCode: "backend-unavailable",
        terminalPhase: "preflight",
        commitState: "pre-wal"
      }]
    }
  }).settings.knowledgeBase.maintenanceHistory[0];
  assert.equal(longIdRoundTrip.runId, workflowRunId);
  assert.equal(longIdRoundTrip.attempts?.[0]?.attemptId, attemptId);
  assert.equal(longIdRoundTrip.commitState, "pre-wal");
}

function assertDurableTerminalStateMatrix(): void {
  const completedAttempt: KnowledgeRunAttemptRecord = {
    attemptId: "durable-state-matrix:attempt:1:codex-cli",
    ordinal: 1,
    backend: "codex-cli",
    terminal: {
      status: "completed",
      at: 100
    }
  };
  const committed: KnowledgeBaseDurableMaintenanceResult = {
    status: "success",
    reportPath: "outputs/maintenance/state-matrix.md",
    summary: "完成",
    processedSources: [],
    workflowRunId: "durable-state-matrix",
    selectedBackend: "codex-cli",
    winnerBackend: "codex-cli",
    terminalPhase: "finalized",
    commitState: "committed",
    attempts: [completedAttempt],
    completion: "full",
    failureCode: null
  };
  const failedPreWal: KnowledgeBaseDurableMaintenanceResult = {
    ...committed,
    status: "failed",
    summary: "",
    winnerBackend: null,
    terminalPhase: "verification",
    commitState: "pre-wal",
    completion: undefined,
    failureCode: "evidence-invalid"
  };
  const canceledPreWal: KnowledgeBaseDurableMaintenanceResult = {
    ...failedPreWal,
    status: "canceled",
    terminalPhase: "execution",
    attempts: [],
    failureCode: "cancelled"
  };
  const failedWalPersisted: KnowledgeBaseDurableMaintenanceResult = {
    ...committed,
    status: "failed",
    summary: "",
    terminalPhase: "commit",
    commitState: "wal-persisted",
    failureCode: "maintenance-commit-pending"
  };
  const failedWalPersistedNoop: KnowledgeBaseDurableMaintenanceResult = {
    ...failedWalPersisted,
    workflowRunId: "durable-state-matrix-noop",
    winnerBackend: null,
    attempts: [],
    completion: "noop"
  };

  for (const [label, result] of [
    ["committed success", committed],
    ["failed pre-WAL", failedPreWal],
    ["canceled pre-WAL", canceledPreWal],
    ["failed WAL commit", failedWalPersisted],
    [
      "failed WAL cleanup",
      { ...failedWalPersisted, terminalPhase: "cleanup" as const }
    ],
    ["failed WAL noop", failedWalPersistedNoop]
  ] as const) {
    assert.doesNotThrow(
      () => assertDurableMaintenanceResult(result),
      `${label} must remain a legal durable terminal`
    );
  }

  const invalidCases: Array<{
    label: string;
    result: KnowledgeBaseDurableMaintenanceResult;
    expected: RegExp;
  }> = [
    {
      label: "invented terminal phase",
      result: {
        ...committed,
        terminalPhase: "invented-phase" as never
      },
      expected: /terminalPhase 非法/
    },
    {
      label: "invented commit state",
      result: {
        ...committed,
        commitState: "invented-state" as never
      },
      expected: /commitState 非法/
    },
    {
      label: "invented completion",
      result: {
        ...committed,
        completion: "invented-completion" as never
      },
      expected: /completion 非法/
    },
    {
      label: "failed pre-WAL with completion",
      result: {
        ...failedPreWal,
        completion: "partial"
      },
      expected: /pre-WAL durable maintenance result/
    },
    {
      label: "canceled pre-WAL with completion",
      result: {
        ...canceledPreWal,
        completion: "noop"
      },
      expected: /pre-WAL durable maintenance result/
    },
    {
      label: "failed WAL without completion",
      result: {
        ...failedWalPersisted,
        completion: undefined
      },
      expected: /WAL-persisted durable maintenance result/
    },
    {
      label: "canceled WAL",
      result: {
        ...failedWalPersisted,
        status: "canceled",
        failureCode: "cancelled"
      },
      expected: /WAL-persisted durable maintenance result/
    },
    {
      label: "WAL persisted before commit phase",
      result: {
        ...failedWalPersisted,
        terminalPhase: "verification"
      },
      expected: /WAL-persisted durable maintenance result/
    },
    {
      label: "failed committed",
      result: {
        ...committed,
        status: "failed",
        failureCode: "invented-commit"
      },
      expected: /committed durable maintenance result/
    },
    {
      label: "success pre-WAL",
      result: {
        ...failedPreWal,
        status: "success",
        failureCode: null
      },
      expected: /pre-WAL durable maintenance result/
    },
    {
      label: "committed before finalized",
      result: {
        ...committed,
        terminalPhase: "cleanup"
      },
      expected: /committed durable maintenance result/
    },
    {
      label: "pre-WAL finalized",
      result: {
        ...failedPreWal,
        terminalPhase: "finalized"
      },
      expected: /pre-WAL durable maintenance result/
    },
    {
      label: "WAL recovery-blocked",
      result: {
        ...failedWalPersisted,
        terminalPhase: "recovery-blocked"
      },
      expected: /WAL-persisted durable maintenance result/
    }
  ];

  for (const testCase of invalidCases) {
    assert.throws(
      () => assertDurableMaintenanceResult(testCase.result),
      testCase.expected,
      `${testCase.label} must be rejected`
    );
  }
}

function successfulResult(): KnowledgeBaseRunResult {
  return {
    status: "success",
    reportPath: "outputs/maintenance/report.md",
    summary: "维护完成",
    processedSources: []
  };
}

function source(relativePath: string): KnowledgeBaseSource {
  return {
    relativePath,
    absolutePath: `/vault/${relativePath}`,
    size: 10,
    mtime: 1,
    fingerprint: `fingerprint-${relativePath}`,
    mime: "text/markdown",
    modality: "text",
    changed: true
  };
}

function attempt(ordinal: number, message = ""): KnowledgeRunAttemptRecord {
  const backend = ordinal % 3 === 1 ? "codex-cli" : ordinal % 3 === 2 ? "opencode" : "hermes";
  return {
    attemptId: `maintain-result-state:attempt:${ordinal}:${backend}`,
    ordinal,
    backend,
    terminal: {
      status: ordinal === 1 ? "failed" : "completed",
      at: ordinal,
      ...(message ? { message } : {})
    }
  };
}
