import * as assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildKnowledgeBaseDashboardSnapshot } from "../../knowledge-base/dashboard";
import { buildScheduledMaintenanceChatMessage } from "../../knowledge-base/scheduled-maintenance";
import type {
  KnowledgeBaseRunResult,
  KnowledgeRunAttemptRecord
} from "../../knowledge-base/types";
import { normalizeSettingsData } from "../../settings/settings";

export async function runMaintenanceProjectionTests(): Promise<void> {
  assertScheduledMessageUsesMaintainReportPayload();
  await assertCanceledHistoryRemainsVisibleWithoutBecomingAHealthCheck();
}

function assertScheduledMessageUsesMaintainReportPayload(): void {
  const attempts: KnowledgeRunAttemptRecord[] = [
    attempt(1, "codex-cli", "failed"),
    attempt(2, "opencode", "completed")
  ];
  const result: KnowledgeBaseRunResult = {
    status: "success",
    completion: "recovered",
    reportPath: "outputs/maintenance/report.md",
    summary: "备用 Agent 已安全接续完成。",
    processedSources: [],
    workflowRunId: "knowledge-maintain-real-run",
    selectedBackend: "codex-cli",
    winnerBackend: "opencode",
    terminalPhase: "finalized",
    commitState: "committed",
    attempts,
    failureCode: null
  };

  const message = buildScheduledMaintenanceChatMessage(
    result,
    "## 一眼结论\n维护已完成。",
    123
  );

  assert.equal(message.itemType, "knowledgeBase");
  assert.equal(message.status, "completed");
  assert.equal(message.runId, "knowledge-maintain-real-run");
  assert.equal(message.backendId, "opencode");
  assert.equal(message.createdAt, 123);
  assert.equal(message.completedAt, 123);
  assert.equal(message.knowledgeBaseUi?.kind, "maintain-report");
  if (message.knowledgeBaseUi?.kind !== "maintain-report") {
    assert.fail("scheduled maintenance must persist the unified maintain report payload");
  }
  assert.equal(message.knowledgeBaseUi.completion, "recovered");
  assert.equal(message.knowledgeBaseUi.selectedBackend, "codex-cli");
  assert.equal(message.knowledgeBaseUi.winnerBackend, "opencode");
  assert.equal(message.knowledgeBaseUi.commitState, "committed");
  assert.equal(message.knowledgeBaseUi.backend, "opencode");
  assert.equal(message.knowledgeBaseUi.runId, "knowledge-maintain-real-run");
  assert.equal(message.knowledgeBaseUi.attemptCount, 2);
  assert.deepEqual(message.knowledgeBaseUi.attempts, attempts);

  const withoutProvenance = buildScheduledMaintenanceChatMessage({
    status: "success",
    reportPath: "",
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
  }, "", 456);
  assert.equal(withoutProvenance.backendId, undefined);
  assert.equal(withoutProvenance.runId, "knowledge-maintain-noop");
  assert.equal(withoutProvenance.knowledgeBaseUi?.kind, "maintain-report");
  if (withoutProvenance.knowledgeBaseUi?.kind === "maintain-report") {
    assert.equal(withoutProvenance.knowledgeBaseUi.backend, undefined);
    assert.equal(withoutProvenance.knowledgeBaseUi.selectedBackend, "hermes");
    assert.equal(withoutProvenance.knowledgeBaseUi.winnerBackend, null);
    assert.equal(withoutProvenance.knowledgeBaseUi.runId, "knowledge-maintain-noop");
    assert.deepEqual(withoutProvenance.knowledgeBaseUi.attempts, []);
  }
}

async function assertCanceledHistoryRemainsVisibleWithoutBecomingAHealthCheck(): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-maintenance-projection-"));
  try {
    await Promise.all([
      mkdir(path.join(vaultPath, "raw"), { recursive: true }),
      mkdir(path.join(vaultPath, "wiki"), { recursive: true }),
      mkdir(path.join(vaultPath, "outputs"), { recursive: true }),
      mkdir(path.join(vaultPath, "inbox"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(vaultPath, "LLM-WIKI.md"), "# Rules\n", "utf8"),
      writeFile(path.join(vaultPath, "raw", "index.md"), "# Raw\n", "utf8"),
      writeFile(path.join(vaultPath, "wiki", "index.md"), "# Wiki\n", "utf8"),
      writeFile(path.join(vaultPath, "outputs", ".ingest-tracker.md"), "# Tracker\n", "utf8")
    ]);

    const canceledAt = Date.now() - 1_000;
    const previousDate = new Date(canceledAt);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousAt = previousDate.getTime();
    const previousCanceledAt = previousAt + 1_000;
    const canceledDateKey = localDateKey(canceledAt);
    const previousDateKey = localDateKey(previousAt);
    const settings = normalizeSettingsData({
      knowledgeBase: {
        maintenanceHistory: [
          {
            date: previousDateKey,
            status: "success",
            at: previousAt,
            mode: "maintain",
            reportPath: ""
          },
          {
            date: previousDateKey,
            status: "canceled",
            at: previousCanceledAt,
            mode: "maintain",
            reportPath: ""
          },
          {
            date: canceledDateKey,
            status: "canceled",
            at: canceledAt,
            mode: "maintain",
            reportPath: ""
          }
        ]
      }
    }).settings.knowledgeBase;

    const snapshot = await buildKnowledgeBaseDashboardSnapshot(vaultPath, settings);
    const canceledLog = snapshot.activity.logs.find((item) => item.at === canceledAt);
    assert.equal(canceledLog?.label, "维护已取消");
    assert.equal(canceledLog?.tone, "muted");
    assert.equal(canceledLog?.text, "本轮没有继续改动知识库");
    assert.equal(
      snapshot.checkHeatmap.find((day) => day.date === canceledDateKey)?.status,
      "none",
      "canceled maintenance must not become a successful or failed health check"
    );
    assert.equal(
      snapshot.checkHeatmap.find((day) => day.date === previousDateKey)?.status,
      "success",
      "a later cancellation on the same day must not erase an earlier completed check"
    );
    assert.equal(snapshot.checkFreshness.lastCheckAt, previousAt);
    assert.equal(snapshot.health.lastCheckAt, previousAt);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}

function attempt(
  ordinal: number,
  backend: KnowledgeRunAttemptRecord["backend"],
  status: NonNullable<KnowledgeRunAttemptRecord["terminal"]>["status"]
): KnowledgeRunAttemptRecord {
  return {
    attemptId: `projection-attempt-${ordinal}`,
    ordinal,
    backend,
    terminal: {
      status,
      at: ordinal
    }
  };
}

function localDateKey(value: number): string {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}
