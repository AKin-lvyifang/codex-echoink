import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  confirmMaintenanceShadowTransportConfigFence,
  createMaintenanceShadowTransportConfigReceipt,
  createMaintenanceShadowVault,
  maintenanceShadowExecutionBoundary,
  sealMaintenanceShadowVault
} from "../../harness/maintenance/shadow-vault";
import {
  listMaintenanceWorkflowWals,
  MAINTENANCE_WORKFLOW_NOOP_RECEIPT_SCHEMA_VERSION,
  maintenanceWorkflowNoopReceiptPath,
  MaintenanceWorkflowSimulatedCrash,
  MaintenanceWorkflowWalError,
  applyMaintenanceWorkflowManagedWrites,
  markMaintenanceWorkflowWalBlocked,
  snapshotMaintenanceWorkflowFileCas,
  type MaintenanceWorkflowSettingsHost,
  type MaintenanceWorkflowSettingsSnapshot
} from "../../harness/maintenance/workflow-wal";
import { maintenanceBackendOrder } from "../../knowledge-base/maintenance-routing";
import { reconcileKnowledgeBaseNativeLifecycleRecovery } from "../../knowledge-base/scheduled-maintenance";
import {
  prepareAndCommitMaintenanceWorkflow,
  recoverPendingMaintenanceWorkflows,
  resumeMaintenanceWorkflow,
  type MaintenanceWorkflowCoordinatorFaultPoint,
  type PrepareAndCommitMaintenanceWorkflowInput
} from "../../knowledge-base/maintenance-workflow";
import {
  RAW_DIGEST_REGISTRY_PATH,
  RAW_DIGEST_SCHEMA_VERSION,
  applyRawDigestFrontmatter,
  buildRawDigestRegistryContent,
  rawDigestFingerprint,
  rawDigestRecordFromMarkdown,
  rawDigestRecordIsTrusted
} from "../../knowledge-base/raw-digest";
import type {
  KnowledgeBaseMaintenanceHistoryEntry,
  KnowledgeBaseNativeLifecycleRecoveryReceipt,
  KnowledgeBaseProcessedSource,
  KnowledgeBaseSettings
} from "../../settings/settings";

interface FixtureSettings extends MaintenanceWorkflowSettingsSnapshot {
  unrelatedPreference: string;
  nativeLifecycleRecoveryReceipt?: KnowledgeBaseNativeLifecycleRecoveryReceipt | null;
}

const COORDINATOR_FAULT_POINTS = [
  "after-prepare",
  "after-shadow-apply",
  "after-shadow-confirm",
  "after-managed-commit",
  "after-settings-commit",
  "after-finalize",
  "before-wal-remove"
] as const satisfies readonly MaintenanceWorkflowCoordinatorFaultPoint[];

const EXPECTED_PHASE_AFTER_FAULT: Record<
  MaintenanceWorkflowCoordinatorFaultPoint,
  "prepared"
    | "shadow_committed"
    | "managed_committed"
    | "settings_committed"
    | "finalized"
> = {
  "after-prepare": "prepared",
  "after-shadow-apply": "prepared",
  "after-shadow-confirm": "shadow_committed",
  "after-managed-commit": "managed_committed",
  "after-settings-commit": "settings_committed",
  "after-finalize": "finalized",
  "before-wal-remove": "finalized"
};

const CRASH_SOAK_SEED = 0x5eedc0de;
const CRASH_SOAK_ROUNDS = 30;

export async function runMaintenanceWorkflowCoordinatorTests(): Promise<void> {
  await assertFreshVaultWithoutStorageRootIsReady();
  await assertShadowRootAndWalShareTrustedStorage();
  await assertPreparePrecedesFirstLiveWriteAndResumeDoesNotRoute();
  await assertRecoveryGateReplaysReadyWalExactlyOnce();
  await runMaintenanceManagedBlockedRecoveryTests();
  await runMaintenanceManagedSettingsBlockedRecoveryTests();
  await assertBlockedReportTimestampSuccessorRecovers();
  await assertBlockedReportWithNativeCleanupProjectionRecovers();
  await assertInvalidNativeCleanupProjectionsRemainBlocked();
  await assertUnsafeReportMetadataSuccessorsRemainBlocked();
  await assertEveryCoordinatorFaultPointRecovers();
  await assertSeededCoordinatorCrashSoak();
}

export async function runMaintenanceManagedSettingsBlockedRecoveryTests(): Promise<void> {
  await withShadowFixture("managed-settings-blocked-retry", async (fixture) => {
    await crashAfterManagedCommit(fixture);
    const listed = await listMaintenanceWorkflowWals(
      await realpath(fixture.storageRootPath)
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "ready");
    if (listed[0]?.status !== "ready") throw new Error("expected ready WAL");
    assert.equal(listed[0].wal.state.phase, "managed_committed");
    await markMaintenanceWorkflowWalBlocked(listed[0].wal.handle, {
      code: "settings_cas_conflict",
      message: "持久化知识库终态字段未达到 WAL target"
    });

    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(recovered, {
      recovered: 1,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    await assertCommittedShadowFixture(fixture);
  });

  await withShadowFixture("managed-settings-third-value", async (fixture) => {
    await crashAfterManagedCommit(fixture);
    fixture.host.mutate((settings) => {
      settings.lastSummary = "第三方并发终态";
    });
    const listed = await listMaintenanceWorkflowWals(
      await realpath(fixture.storageRootPath)
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "ready");
    if (listed[0]?.status !== "ready") throw new Error("expected ready WAL");
    await markMaintenanceWorkflowWalBlocked(listed[0].wal.handle, {
      code: "settings_cas_conflict",
      message: "持久化知识库终态字段未达到 WAL target"
    });

    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.equal(recovered.recovered, 0);
    assert.equal(recovered.blocked, 1);
    assert.equal(fixture.host.current().lastSummary, "第三方并发终态");
    assert.equal(
      (await listMaintenanceWorkflowWals(
        await realpath(fixture.storageRootPath)
      ))[0]?.status,
      "blocked"
    );
  });
}

async function crashAfterManagedCommit(
  fixture: Awaited<ReturnType<typeof createShadowFixture>>
): Promise<void> {
  await assert.rejects(
    () => prepareAndCommitMaintenanceWorkflow({
      ...fixture.input,
      faultInjector(point) {
        if (point === "after-managed-commit") {
          throw new MaintenanceWorkflowSimulatedCrash(
            "simulated crash after managed commit"
          );
        }
      }
    }),
    MaintenanceWorkflowSimulatedCrash
  );
}

export async function runMaintenanceManagedBlockedRecoveryTests(): Promise<void> {
  await withShadowFixture("blocked-managed-retry", async (fixture) => {
    const blocked = await blockManagedJournalOnReportConflict(fixture);
    await writeFile(fixture.reportPath, blocked.baselineReport);
    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(recovered, {
      recovered: 1,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    await drainMaintenanceRecoveryTails();
    await assertCommittedShadowFixture(fixture);
  });

  await withShadowFixture("blocked-managed-third-value", async (fixture) => {
    const blocked = await blockManagedJournalOnReportConflict(fixture);
    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.equal(recovered.recovered, 0);
    assert.equal(recovered.blocked, 1);
    assert.equal(recovered.invalid, 0);
    assert.deepEqual(await readFile(fixture.reportPath), blocked.thirdValue);
    const stillBlocked = await requireSingleBlockedWal(
      fixture.storageRootPath
    );
    assert.equal(stillBlocked.state.phase, "shadow_committed");
    assert.equal(
      stillBlocked.state.blocked?.code,
      "managed_cas_conflict"
    );
  });

  await withShadowFixture("blocked-managed-report-normalization", async (fixture) => {
    const desiredReport = Buffer.from([
      "---",
      "created: 1970-01-01",
      "updated: 1970-01-01T00:00Z",
      "tags: [knowledge, maintenance, ingest]",
      "---",
      "",
      "# Maintenance report",
      "",
      "BODY MUST REMAIN IDENTICAL",
      ""
    ].join("\n"), "utf8");
    const normalizedReport = Buffer.from([
      "---",
      "created: 1970-01-01",
      "updated: 1970-01-01T00:01Z",
      "tags:",
      "  - knowledge",
      "  - maintenance",
      "  - ingest",
      "---",
      "",
      "# Maintenance report",
      "",
      "BODY MUST REMAIN IDENTICAL",
      ""
    ].join("\n"), "utf8");
    setShadowFixtureReportContent(fixture, desiredReport);
    await blockManagedJournalOnReportConflict(fixture);
    await writeFile(fixture.reportPath, normalizedReport);
    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(recovered, {
      recovered: 1,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    await drainMaintenanceRecoveryTails();
    await assertCommittedShadowFixture(fixture, normalizedReport);
  });
}

function setShadowFixtureReportContent(
  fixture: Awaited<ReturnType<typeof createShadowFixture>>,
  desiredContent: Buffer
): void {
  const reportWrite = fixture.input.managedWrites.find(
    (entry) => entry.kind === "report"
  );
  assert.ok(reportWrite && reportWrite.operation === "upsert");
  reportWrite.desiredContent = desiredContent;
  fixture.input.draft.report.finalBlockDigest = sha256(desiredContent);
  fixture.reportContent = desiredContent;
}

async function blockManagedJournalOnReportConflict(
  fixture: Awaited<ReturnType<typeof createShadowFixture>>
): Promise<{ baselineReport: Buffer; thirdValue: Buffer }> {
  const baselineReport = Buffer.from(
    "BASELINE REPORT BEFORE MAINTENANCE\n",
    "utf8"
  );
  await writeFile(fixture.reportPath, baselineReport);
  const reportWrite = fixture.input.managedWrites.find(
    (entry) => entry.kind === "report"
  );
  assert.ok(reportWrite);
  reportWrite.expected = await snapshotMaintenanceWorkflowFileCas(
    fixture.vaultPath,
    fixture.input.draft.report.relativePath
  );
  await assert.rejects(
    () => prepareAndCommitMaintenanceWorkflow({
      ...fixture.input,
      faultInjector(point) {
        if (point === "after-shadow-confirm") {
          throw new MaintenanceWorkflowSimulatedCrash(
            "leave shadow_committed before managed apply"
          );
        }
      }
    }),
    MaintenanceWorkflowSimulatedCrash
  );
  const handle = await requireSingleReadyWal(
    fixture.storageRootPath,
    "shadow_committed",
    "prepare managed blocker"
  );
  await assert.rejects(
    () => applyMaintenanceWorkflowManagedWrites(
      handle,
      fixture.vaultPath,
      {
        faultInjector(input) {
          if (input.point === "before-entry") {
            throw new MaintenanceWorkflowSimulatedCrash(
              "leave durable managed journal before first entry"
            );
          }
        }
      }
    ),
    MaintenanceWorkflowSimulatedCrash
  );
  const thirdValue = Buffer.from("EXTERNAL REPORT THIRD VALUE\n", "utf8");
  await writeFile(fixture.reportPath, thirdValue);
  await assert.rejects(
    () => applyMaintenanceWorkflowManagedWrites(
      handle,
      fixture.vaultPath
    ),
    (error: unknown) =>
      error instanceof MaintenanceWorkflowWalError
      && error.code === "managed_cas_conflict"
  );
  const blocked = await requireSingleBlockedWal(fixture.storageRootPath);
  assert.equal(blocked.state.phase, "shadow_committed");
  assert.equal(blocked.state.blocked?.code, "managed_cas_conflict");
  const journal = JSON.parse(await readFile(
    blocked.handle.managedJournalPath,
    "utf8"
  )) as { state: string; error?: string };
  assert.equal(journal.state, "blocked");
  assert.equal(journal.error, blocked.state.blocked?.message);
  return { baselineReport, thirdValue };
}

async function assertBlockedReportTimestampSuccessorRecovers(): Promise<void> {
  await withFixture("report-updated-successor", async (fixture) => {
    const legacy = await prepareLegacyBlockedReportFixture(fixture);
    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(recovered, {
      recovered: 1,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    assert.equal(
      await readFile(fixture.reportPath, "utf8"),
      legacy.liveReport,
      "recovery must preserve the metadata plugin's timestamp instead of overwriting the report"
    );
    assert.equal(fixture.host.current().maintenanceHistory.length, 1);
    assert.equal(
      (await listMaintenanceWorkflowWals(
        await realpath(fixture.storageRootPath)
      )).length,
      0
    );
  });
}

async function assertBlockedReportWithNativeCleanupProjectionRecovers(): Promise<void> {
  await withFixture("report-updated-native-cleanup", async (fixture) => {
    const legacy = await prepareLegacyBlockedReportFixture(fixture);
    fixture.host.mutate((settings) => {
      projectNativeCleanupRecovery(settings);
    });
    const beforeRecovery = fixture.host.current();
    const blocked = await requireSingleBlockedWal(fixture.storageRootPath);
    await markMaintenanceWorkflowWalBlocked(blocked.handle, {
      code: "settings_cas_conflict",
      message: "持久化知识库终态字段未达到 WAL target"
    });

    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(recovered, {
      recovered: 1,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    assert.deepEqual(
      fixture.host.current(),
      beforeRecovery,
      "WAL recovery must preserve the structured Native cleanup receipt projection"
    );
    assert.equal(await readFile(fixture.reportPath, "utf8"), legacy.liveReport);
    assert.equal(
      (await listMaintenanceWorkflowWals(
        await realpath(fixture.storageRootPath)
      )).length,
      0
    );
  });
}

async function assertInvalidNativeCleanupProjectionsRemainBlocked(): Promise<void> {
  const cases: Array<{
    name: string;
    mutate(settings: FixtureSettings): void;
  }> = [
    {
      name: "summary-drift",
      mutate(settings) {
        settings.lastSummary += "\nEXTERNAL TERMINAL DRIFT";
      }
    },
    {
      name: "self-consistent-non-production-projection",
      mutate(settings) {
        const receipt = settings.nativeLifecycleRecoveryReceipt;
        assert.ok(receipt);
        const fakeProjection =
          `${receipt.projection.lastSummaryBefore}\n\n${receipt.projection.lastSummaryWithRecovery}`;
        receipt.projection.lastSummaryWithRecovery = fakeProjection;
        settings.lastSummary = fakeProjection;
      }
    },
    {
      name: "extra-business-warning",
      mutate(settings) {
        settings.lastWarnings.push({
          id: "external-business-warning",
          message: "must remain visible to the WAL target digest"
        });
      }
    },
    {
      name: "stale-receipt",
      mutate(settings) {
        const receipt = settings.nativeLifecycleRecoveryReceipt;
        assert.ok(receipt);
        receipt.firstObservedAt = settings.lastRunAt - 1;
      }
    },
    {
      name: "receipt-time-reversed",
      mutate(settings) {
        const receipt = settings.nativeLifecycleRecoveryReceipt;
        assert.ok(receipt);
        receipt.updatedAt = receipt.firstObservedAt - 1;
      }
    },
    {
      name: "warning-mismatch",
      mutate(settings) {
        const warning = settings.lastWarnings.find(
          (entry) => entry.id === "native-cleanup-recovery"
        );
        assert.ok(warning);
        warning.message = "tampered Native cleanup warning";
      }
    },
    {
      name: "local-persistence-receipt",
      mutate(settings) {
        const receipt = settings.nativeLifecycleRecoveryReceipt;
        assert.ok(receipt);
        receipt.issue = "local-persistence";
        receipt.warningId = "native-local-commit-recovery";
        const warning = settings.lastWarnings.find(
          (entry) => entry.id === "native-cleanup-recovery"
        );
        assert.ok(warning);
        warning.id = "native-local-commit-recovery";
      }
    },
    {
      name: "failed-local-commit-status",
      mutate(settings) {
        const receipt = settings.nativeLifecycleRecoveryReceipt;
        assert.ok(receipt);
        receipt.localCommitStatus = "failed";
      }
    },
    {
      name: "duplicate-native-warning",
      mutate(settings) {
        const warning = settings.lastWarnings.find(
          (entry) => entry.id === "native-cleanup-recovery"
        );
        assert.ok(warning);
        settings.lastWarnings.push({ ...warning });
      }
    },
    {
      name: "history-drift",
      mutate(settings) {
        const historyEntry = settings.maintenanceHistory.at(-1);
        assert.ok(historyEntry);
        historyEntry.reportPath += ".external-drift";
      }
    },
    {
      name: "missing-receipt",
      mutate(settings) {
        settings.nativeLifecycleRecoveryReceipt = null;
      }
    }
  ];

  for (const testCase of cases) {
    await withFixture(`report-native-${testCase.name}`, async (fixture) => {
      const legacy = await prepareLegacyBlockedReportFixture(fixture);
      fixture.host.mutate((settings) => {
        projectNativeCleanupRecovery(settings);
        testCase.mutate(settings);
      });
      const blocked = await requireSingleBlockedWal(fixture.storageRootPath);
      const settingsBlocked = await markMaintenanceWorkflowWalBlocked(blocked.handle, {
        code: "settings_cas_conflict",
        message: "持久化知识库终态字段未达到 WAL target"
      });
      const recovered = await recoverPendingMaintenanceWorkflows({
        storageRootPath: fixture.storageRootPath,
        liveVaultPath: fixture.vaultPath,
        settingsHost: fixture.host
      });
      assert.equal(recovered.recovered, 0, testCase.name);
      assert.equal(recovered.blocked, 1, testCase.name);
      assert.equal(recovered.invalid, 0, testCase.name);
      assert.equal(await readFile(fixture.reportPath, "utf8"), legacy.liveReport);
      const after = await requireSingleBlockedWal(fixture.storageRootPath);
      assert.equal(after.state.blocked?.code, "settings_cas_conflict");
      assert.equal(
        after.state.sequence,
        settingsBlocked.sequence,
        "invalid settings conflicts must be rejected by preflight without replay mutation"
      );
    });
  }
}

function projectNativeCleanupRecovery(settings: FixtureSettings): void {
  const reconciliation = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings as unknown as KnowledgeBaseSettings,
    {
      cleanupStatuses: ["retained-for-recovery"],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [],
      recoveryRequired: true,
      warning: "Native cleanup is blocked until startup reconciliation succeeds"
    },
    settings.lastRunAt
  );
  assert.deepEqual(reconciliation, {
    changed: true,
    state: "recovery-pending",
    issue: "native-cleanup",
    message:
      "自动维护结果已保存；Native cleanup is blocked until startup reconciliation succeeds"
  });
  assert.deepEqual(settings.nativeLifecycleRecoveryReceipt, {
    schemaVersion: 1,
    issue: "native-cleanup",
    warningId: "native-cleanup-recovery",
    localCommitStatus: "unknown",
    cleanupStatuses: ["retained-for-recovery"],
    cleanupAttempted: false,
    recordIds: [],
    message:
      "自动维护结果已保存；Native cleanup is blocked until startup reconciliation succeeds",
    firstObservedAt: settings.lastRunAt,
    updatedAt: settings.lastRunAt,
    projection: {
      lastErrorBefore: "",
      lastSummaryBefore: "没有待处理来源",
      lastErrorWithRecovery:
        "自动维护结果已保存；Native cleanup is blocked until startup reconciliation succeeds",
      lastSummaryWithRecovery:
        "没有待处理来源；Native Execution 清理待恢复，不影响已保存的维护结果。"
    }
  });
}

async function requireSingleBlockedWal(storageRootPath: string) {
  const listed = await listMaintenanceWorkflowWals(
    await realpath(storageRootPath)
  );
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, "blocked");
  if (listed[0]?.status !== "blocked") {
    throw new Error("expected one blocked maintenance WAL");
  }
  return listed[0].wal;
}

async function assertUnsafeReportMetadataSuccessorsRemainBlocked(): Promise<void> {
  const reportCases: Array<{
    name: string;
    mutate(report: string): string;
    startedAt?: number;
  }> = [
    {
      name: "body-drift",
      mutate: (report) => report.replace(
        "## EchoInk 验证终态",
        "## EchoInk 验证终态（被外部改写）"
      )
    },
    {
      name: "source-drift",
      mutate: (report) => report.replace(
        "source: codex-echoink",
        "source: external-editor"
      )
    },
    {
      name: "status-drift",
      mutate: (report) => report.replace(
        "status: success",
        "status: failed"
      )
    },
    {
      name: "fallback-drift",
      mutate: (report) => report.replace(
        "fallback: true",
        "fallback: false"
      )
    },
    {
      name: "duplicate-updated",
      mutate: (report) => report.replace(
        /updated: ([^\n]+)\n/,
        "updated: $1\nupdated: $1\n"
      )
    },
    {
      name: "invalid-updated",
      mutate: (report) => report.replace(
        /updated: [^\n]+/,
        "updated: not-a-timestamp"
      )
    },
    {
      name: "out-of-window-updated",
      mutate: (report) => report.replace(
        /updated: [^\n]+/,
        "updated: 2099-01-01T00:00"
      )
    },
    {
      name: "before-completion-updated",
      mutate: (report) => report.replace(
        /updated: [^\n]+/,
        "updated: 2026-07-19T09:20"
      )
    },
    {
      name: "invalid-calendar-updated",
      startedAt: new Date(2026, 1, 28, 23, 58, 30).getTime(),
      mutate: (report) => report.replace(
        /updated: [^\n]+/,
        "updated: 2026-02-29T00:00"
      )
    }
  ];
  for (const reportCase of reportCases) {
    await withFixture(`report-${reportCase.name}`, async (fixture) => {
      const legacy = await prepareLegacyBlockedReportFixture(
        fixture,
        reportCase.mutate,
        reportCase.startedAt
      );
      await assertBlockedReportRecovery(fixture, legacy.liveReport);
    });
  }

  await withFixture("report-mode-drift", async (fixture) => {
    const legacy = await prepareLegacyBlockedReportFixture(fixture);
    await chmod(fixture.reportPath, 0o600);
    await assertBlockedReportRecovery(fixture, legacy.liveReport);
  });

  await withFixture("report-unmanaged-tracker-drift", async (fixture) => {
    const legacy = await prepareLegacyBlockedReportFixture(fixture);
    await writeFile(fixture.trackerPath, "EXTERNAL TRACKER DRIFT\n", "utf8");
    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(recovered, {
      recovered: 1,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    assert.equal(await readFile(fixture.reportPath, "utf8"), legacy.liveReport);
    assert.equal(
      await readFile(fixture.trackerPath, "utf8"),
      "EXTERNAL TRACKER DRIFT\n",
      "new noop recovery must not own or rewrite tracker"
    );
  });
}

async function prepareLegacyBlockedReportFixture(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mutateReport: (report: string) => string = (report) => report,
  startedAtInput?: number
): Promise<{ liveReport: string }> {
  const startedAt = startedAtInput
    ?? new Date(2026, 6, 19, 9, 20, 58).getTime();
  const updatedAt = new Date(startedAt + 60_000);
  const updated = [
    updatedAt.getFullYear(),
    String(updatedAt.getMonth() + 1).padStart(2, "0"),
    String(updatedAt.getDate()).padStart(2, "0")
  ].join("-") + `T${String(updatedAt.getHours()).padStart(2, "0")}:${String(updatedAt.getMinutes()).padStart(2, "0")}`;
  const desiredReport = [
    "---",
    "created: 2026-07-19T01:20:58.126Z",
    "source: codex-echoink",
    "status: success",
    "fallback: true",
    "---",
    "",
    "# 知识库维护报告 — 2026-07-19",
    "",
    "<!-- echoink-maintenance-final:v1:start -->",
    "## EchoInk 验证终态",
    "",
    "- 结果：noop",
    `- workflow：\`${fixture.input.draft.workflowRunId}\``,
    "<!-- echoink-maintenance-final:v1:end -->",
    ""
  ].join("\n");
  const input: PrepareAndCommitMaintenanceWorkflowInput<FixtureSettings> = {
    ...fixture.input,
    draft: {
      ...fixture.input.draft,
      startedAt,
      createdAt: new Date(startedAt).toISOString(),
      report: {
        ...fixture.input.draft.report,
        finalBlockDigest: sha256(Buffer.from(desiredReport, "utf8"))
      },
      settings: {
        ...fixture.input.draft.settings,
        targetTerminal: {
          ...fixture.input.draft.settings.targetTerminal,
          lastRunAt: updatedAt.getTime()
        },
        historyEntry: {
          ...fixture.input.draft.settings.historyEntry,
          at: updatedAt.getTime()
        }
      }
    },
    managedWrites: fixture.input.managedWrites.map((write) =>
      write.kind === "report"
        ? {
          ...write,
          desiredContent: Buffer.from(desiredReport, "utf8")
        }
        : write
    )
  };
  await assert.rejects(
    () => prepareAndCommitMaintenanceWorkflow({
      ...input,
      faultInjector(point) {
        if (point === "after-settings-commit") {
          throw new MaintenanceWorkflowSimulatedCrash(
            "legacy crash before report metadata reaction"
          );
        }
      }
    }),
    MaintenanceWorkflowSimulatedCrash
  );
  const listed = await listMaintenanceWorkflowWals(
    await realpath(fixture.storageRootPath)
  );
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, "ready");
  if (listed[0]?.status !== "ready") throw new Error("expected ready legacy WAL");
  assert.equal(listed[0].wal.state.phase, "settings_committed");

  const liveReport = mutateReport(desiredReport.replace(
    "fallback: true\n---",
    [
      "fallback: true",
      `updated: ${updated}`,
      "---"
    ].join("\n")
  ));
  await writeFile(fixture.reportPath, liveReport, "utf8");
  await markMaintenanceWorkflowWalBlocked(listed[0].wal.handle, {
    code: "managed_cas_conflict",
    message: "managed CAS 冲突：报告被 metadata plugin 更新"
  });
  return { liveReport };
}

async function assertBlockedReportRecovery(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  expectedReport: string
): Promise<void> {
  const recovered = await recoverPendingMaintenanceWorkflows({
    storageRootPath: fixture.storageRootPath,
    liveVaultPath: fixture.vaultPath,
    settingsHost: fixture.host
  });
  assert.equal(recovered.recovered, 0);
  assert.equal(recovered.blocked, 1);
  assert.equal(recovered.invalid, 0);
  assert.match(recovered.issues[0] ?? "", /managed CAS/);
  assert.equal(await readFile(fixture.reportPath, "utf8"), expectedReport);
  const listed = await listMaintenanceWorkflowWals(
    await realpath(fixture.storageRootPath)
  );
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.status, "blocked");
}

async function assertFreshVaultWithoutStorageRootIsReady(): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-workflow-fresh-vault-")
  );
  try {
    const vaultPath = path.join(rootPath, "vault");
    const storageRootPath = path.join(rootPath, "missing-storage");
    await mkdir(vaultPath, { recursive: true });
    const baselineSettings: FixtureSettings = {
      lastRunAt: 0,
      lastRunStatus: "idle",
      lastReportPath: "",
      lastError: "",
      lastSummary: "",
      lastCompletion: "",
      lastAttempts: [],
      lastPendingSources: [],
      lastFailureCode: "",
      lastWarnings: [],
      processedSources: {},
      maintenanceHistory: [],
      unrelatedPreference: "preserve"
    };
    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath,
      liveVaultPath: vaultPath,
      settingsHost: new MemorySettingsHost(baselineSettings)
    });
    assert.deepEqual(recovered, {
      recovered: 0,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    assert.equal((await lstat(storageRootPath)).isDirectory(), true);
  } finally {
    await makeOwnerWritable(rootPath);
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function assertShadowRootAndWalShareTrustedStorage(): Promise<void> {
  await withShadowFixture("shadow-storage", async (fixture) => {
    await assert.rejects(
      () => prepareAndCommitMaintenanceWorkflow({
        ...fixture.input,
        faultInjector(point) {
          if (point === "after-prepare") {
            throw new MaintenanceWorkflowSimulatedCrash(
              "prepared with real sealed Shadow"
            );
          }
        }
      }),
      MaintenanceWorkflowSimulatedCrash
    );
    await assert.rejects(
      () => readFile(fixture.resultPath, "utf8"),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
    const handle = await requireSingleReadyWal(
      fixture.storageRootPath,
      "prepared",
      "trusted Shadow/WAL storage"
    );
    await resumeMaintenanceWorkflow({
      handle,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    await assertCommittedShadowFixture(fixture);
  });
}

async function assertPreparePrecedesFirstLiveWriteAndResumeDoesNotRoute(): Promise<void> {
  await withFixture("prepare-order", async (fixture) => {
    let observedPrepare = false;
    await assert.rejects(
      () => prepareAndCommitMaintenanceWorkflow({
        ...fixture.input,
        faultInjector(point) {
          if (point === "after-prepare") {
            observedPrepare = true;
            throw new Error("crash after prepare");
          }
        }
      }),
      /crash after prepare/
    );
    assert.equal(observedPrepare, true);
    await assert.rejects(
      () => readFile(fixture.reportPath, "utf8"),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
    assert.deepEqual(fixture.host.current(), fixture.baselineSettings);

    const listed = await listMaintenanceWorkflowWals(
      await realpath(fixture.storageRootPath)
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "ready");
    if (listed[0]?.status !== "ready") throw new Error("expected ready WAL");
    const completed = await resumeMaintenanceWorkflow({
      handle: listed[0].wal.handle,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.equal(completed.state.phase, "finalized");
    assert.equal(await readFile(fixture.reportPath, "utf8"), "NOOP-REPORT\n");
    assert.equal(fixture.host.current().lastCompletion, "noop");
    assert.equal(fixture.host.current().maintenanceHistory.length, 1);
    assert.equal(
      (await listMaintenanceWorkflowWals(
        await realpath(fixture.storageRootPath)
      )).length,
      0
    );
  });
}

async function assertRecoveryGateReplaysReadyWalExactlyOnce(): Promise<void> {
  await withFixture("startup-recovery", async (fixture) => {
    await assert.rejects(
      () => prepareAndCommitMaintenanceWorkflow({
        ...fixture.input,
        faultInjector(point) {
          if (point === "after-prepare") {
            throw new Error("simulated process death");
          }
        }
      }),
      /simulated process death/
    );
    const recovered = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(recovered, {
      recovered: 1,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    assert.equal(fixture.host.current().maintenanceHistory.length, 1);

    const replay = await recoverPendingMaintenanceWorkflows({
      storageRootPath: fixture.storageRootPath,
      liveVaultPath: fixture.vaultPath,
      settingsHost: fixture.host
    });
    assert.deepEqual(replay, {
      recovered: 0,
      blocked: 0,
      invalid: 0,
      issues: []
    });
    assert.equal(fixture.host.current().maintenanceHistory.length, 1);
  });
}

async function assertEveryCoordinatorFaultPointRecovers(): Promise<void> {
  for (const point of COORDINATOR_FAULT_POINTS) {
    await withShadowFixture(`fault-${point}`, async (fixture) => {
      let crashes = 0;
      await assert.rejects(
        () => prepareAndCommitMaintenanceWorkflow({
          ...fixture.input,
          faultInjector(current) {
            if (current !== point) return;
            crashes += 1;
            throw new MaintenanceWorkflowSimulatedCrash(
              `deterministic coordinator crash at ${point}`
            );
          }
        }),
        (error: unknown) =>
          error instanceof MaintenanceWorkflowSimulatedCrash
          && error.message === `deterministic coordinator crash at ${point}`
      );
      assert.equal(
        crashes,
        1,
        `${point} must be reached exactly once before recovery`
      );
      await requireSingleReadyWal(
        fixture.storageRootPath,
        EXPECTED_PHASE_AFTER_FAULT[point],
        `deterministic fault ${point}`
      );
      await recoverShadowFixtureExactlyOnce(fixture);
    });
  }
}

async function assertSeededCoordinatorCrashSoak(): Promise<void> {
  const random = createSeededRandom(CRASH_SOAK_SEED);
  const observedCrashCounts = new Set<number>();
  for (let round = 1; round <= CRASH_SOAK_ROUNDS; round += 1) {
    const crashPoints = sampleOrderedFaultPoints(random);
    observedCrashCounts.add(crashPoints.length);
    const context =
      `seed=${formatSeed(CRASH_SOAK_SEED)} round=${round}/${CRASH_SOAK_ROUNDS}`
      + ` points=${crashPoints.join(",")}`;
    try {
      await withShadowFixture(`soak-${round}`, async (fixture) => {
        let handle:
          | Awaited<ReturnType<typeof requireSingleReadyWal>>
          | undefined;
        for (
          let crashIndex = 0;
          crashIndex < crashPoints.length;
          crashIndex += 1
        ) {
          const point = crashPoints[crashIndex]!;
          let crashes = 0;
          const faultInjector = (
            current: MaintenanceWorkflowCoordinatorFaultPoint
          ): void => {
            if (current !== point) return;
            crashes += 1;
            throw new MaintenanceWorkflowSimulatedCrash(
              `${context} crash=${crashIndex + 1}/${crashPoints.length}`
            );
          };
          const operation = crashIndex === 0
            ? prepareAndCommitMaintenanceWorkflow({
              ...fixture.input,
              faultInjector
            })
            : resumeMaintenanceWorkflow({
              handle: handle!,
              liveVaultPath: fixture.vaultPath,
              settingsHost: fixture.host,
              faultInjector
            });
          await assert.rejects(
            () => operation,
            MaintenanceWorkflowSimulatedCrash,
            context
          );
          assert.equal(
            crashes,
            1,
            `${context}: ${point} must be reached exactly once`
          );
          handle = await requireSingleReadyWal(
            fixture.storageRootPath,
            EXPECTED_PHASE_AFTER_FAULT[point],
            context
          );
        }
        await recoverShadowFixtureExactlyOnce(fixture);
      });
    } catch (error) {
      throw new Error(
        `maintenance coordinator crash soak failed: ${context}: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }
  assert.deepEqual(
    Array.from(observedCrashCounts).sort(),
    [1, 2, 3],
    `seed=${formatSeed(CRASH_SOAK_SEED)} must exercise 1-3 crashes per round`
  );
}

async function recoverShadowFixtureExactlyOnce(
  fixture: Awaited<ReturnType<typeof createShadowFixture>>
): Promise<void> {
  const recovered = await recoverPendingMaintenanceWorkflows({
    storageRootPath: fixture.storageRootPath,
    liveVaultPath: fixture.vaultPath,
    settingsHost: fixture.host
  });
  assert.deepEqual(recovered, {
    recovered: 1,
    blocked: 0,
    invalid: 0,
    issues: []
  });
  await drainMaintenanceRecoveryTails();
  const firstTerminalSnapshot =
    await snapshotCommittedWorkflowTerminal(fixture);
  const replay = await recoverPendingMaintenanceWorkflows({
    storageRootPath: fixture.storageRootPath,
    liveVaultPath: fixture.vaultPath,
    settingsHost: fixture.host
  });
  assert.deepEqual(replay, {
    recovered: 0,
    blocked: 0,
    invalid: 0,
    issues: []
  });
  await drainMaintenanceRecoveryTails();
  assert.deepEqual(
    await snapshotCommittedWorkflowTerminal(fixture),
    firstTerminalSnapshot,
    "a second terminal recovery must not rewrite identical live files or settings"
  );
  await assertCommittedShadowFixture(fixture);
}

async function snapshotCommittedWorkflowTerminal(
  fixture: Awaited<ReturnType<typeof createShadowFixture>>
) {
  const files = await Promise.all(
    [
      ["raw", fixture.rawPath],
      ["rawRegistry", fixture.rawRegistryPath],
      ["result", fixture.resultPath],
      ["report", fixture.reportPath],
      ["tracker", fixture.trackerPath]
    ].map(async ([name, absolutePath]) => {
      const entry = await lstat(absolutePath!);
      return [
        name,
        {
          path: absolutePath,
          content: await readFile(absolutePath!),
          mode: entry.mode & 0o777,
          mtimeMs: entry.mtimeMs,
          ino: entry.ino
        }
      ] as const;
    })
  );
  const settings = fixture.host.current();
  return {
    files: Object.fromEntries(files),
    settings,
    history: structuredClone(settings.maintenanceHistory)
  };
}

async function drainMaintenanceRecoveryTails(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function assertCommittedShadowFixture(
  fixture: Awaited<ReturnType<typeof createShadowFixture>>,
  expectedReportContent = fixture.reportContent
): Promise<void> {
  const committedRaw = await readFile(fixture.rawPath);
  assert.equal(
    committedRaw.toString("utf8"),
    fixture.rawDesiredContent.toString("utf8"),
    "Harness must apply exactly one verified Raw metadata update"
  );
  assert.equal(
    rawDigestFingerprint(fixture.rawRelativePath, committedRaw),
    fixture.expectedProcessedSource.fingerprint,
    "Raw body fingerprint must remain unchanged by managed metadata"
  );
  const rawRecord = rawDigestRecordFromMarkdown(committedRaw);
  assert.equal(
    rawDigestRecordIsTrusted(
      rawRecord,
      fixture.expectedProcessedSource.fingerprint ?? ""
    ),
    true,
    "committed Raw metadata must remain trusted after crash replay"
  );
  assert.match(
    committedRaw.toString("utf8"),
    /^title: Source$/m,
    "user-owned Raw frontmatter must survive managed metadata"
  );
  assert.match(committedRaw.toString("utf8"), /^  - user-owned$/m);
  assert.match(committedRaw.toString("utf8"), /^  - User Alias$/m);
  assert.match(committedRaw.toString("utf8"), /^custom-key: keep-me$/m);
  const processedMetadataCount =
    committedRaw.toString("utf8").match(/^已处理:/gm)?.length ?? 0;
  assert.equal(
    processedMetadataCount,
    1,
    "Raw metadata must not duplicate after repeated recovery"
  );
  const committedRawStat = await lstat(fixture.rawPath);
  assert.equal(committedRawStat.isFile(), true);
  assert.equal(committedRawStat.isSymbolicLink(), false);
  assert.equal(
    path.relative(fixture.vaultPath, fixture.rawPath),
    fixture.rawRelativePath,
    "Markdown Raw must retain its logical path identity"
  );
  assert.equal(
    committedRawStat.mode & 0o777,
    0o640,
    "Markdown Raw must retain its user-owned mode"
  );
  assert.equal(
    await readFile(fixture.rawRegistryPath, "utf8"),
    fixture.rawRegistryContent.toString("utf8"),
    "Raw registry must remain exactly aligned after repeated recovery"
  );
  const committedResult = await readFile(fixture.resultPath, "utf8");
  assert.equal(
    committedResult,
    fixture.resultContent.toString("utf8"),
    "Shadow result content must match the sealed winner"
  );
  assert.equal(
    await readFile(fixture.reportPath, "utf8"),
    expectedReportContent.toString("utf8")
  );
  assert.equal(
    await readFile(fixture.trackerPath, "utf8"),
    fixture.trackerContent.toString("utf8")
  );

  const current = fixture.host.current();
  assert.deepEqual(Object.keys(current.processedSources), [
    fixture.rawRelativePath
  ]);
  assert.deepEqual(
    current.processedSources[fixture.rawRelativePath],
    fixture.expectedProcessedSource
  );
  assert.equal(
    current.maintenanceHistory.filter(
      (entry) => entry.runId === fixture.workflowRunId
    ).length,
    1,
    "workflow history must not duplicate after replay"
  );
  assert.equal(current.maintenanceHistory.length, 1);
  assert.equal(current.unrelatedPreference, "preserve");
  assert.equal(
    (await listMaintenanceWorkflowWals(
      await realpath(fixture.storageRootPath)
    )).length,
    0,
    "finalized workflow WAL must be safely removed"
  );
  await assert.rejects(
    () => lstat(fixture.shadowControlRootPath),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "committed Shadow control root must be safely removed"
  );
}

async function requireSingleReadyWal(
  storageRootPath: string,
  expectedPhase:
    | "prepared"
    | "shadow_committed"
    | "managed_committed"
    | "settings_committed"
    | "finalized",
  context: string
) {
  const listed = await listMaintenanceWorkflowWals(
    await realpath(storageRootPath)
  );
  assert.equal(listed.length, 1, `${context}: expected exactly one WAL`);
  const entry = listed[0];
  assert.equal(entry?.status, "ready", `${context}: WAL must remain recoverable`);
  if (!entry || entry.status !== "ready") {
    throw new Error(`${context}: expected one ready WAL`);
  }
  assert.equal(
    entry.wal.state.phase,
    expectedPhase,
    `${context}: durable phase mismatch`
  );
  return entry.wal.handle;
}

function sampleOrderedFaultPoints(
  random: () => number
): MaintenanceWorkflowCoordinatorFaultPoint[] {
  const count = 1 + Math.floor(random() * 3);
  const shuffled = [...COORDINATOR_FAULT_POINTS];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex]!,
      shuffled[index]!
    ];
  }
  return shuffled
    .slice(0, count)
    .sort(
      (left, right) =>
        COORDINATOR_FAULT_POINTS.indexOf(left)
        - COORDINATOR_FAULT_POINTS.indexOf(right)
    );
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function formatSeed(seed: number): string {
  return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

async function withFixture(
  suffix: string,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-workflow-coordinator-")
  );
  try {
    await run(await createFixture(rootPath, suffix));
  } finally {
    await makeOwnerWritable(rootPath);
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function withShadowFixture(
  suffix: string,
  run: (
    fixture: Awaited<ReturnType<typeof createShadowFixture>>
  ) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "echoink-workflow-crash-fixture-")
  );
  try {
    await run(await createShadowFixture(rootPath, suffix));
  } finally {
    await makeOwnerWritable(rootPath);
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function createShadowFixture(rootPath: string, suffix: string) {
  const base = await createFixture(rootPath, `base-${suffix}`);
  const safeSuffix = suffix.replace(/[^a-z0-9-]/gi, "-");
  const workflowRunId = `workflow-shadow-${safeSuffix}`;
  const attemptId = `${workflowRunId}-attempt-1-codex-cli`;
  const rawRelativePath = "raw/source.md";
  const rawPath = path.join(base.vaultPath, rawRelativePath);
  const resultRelativePath = "outputs/result.md";
  const resultPath = path.join(base.vaultPath, resultRelativePath);
  const reportRelativePath =
    `outputs/maintenance/${safeSuffix}-report.md`;
  const reportPath = path.join(base.vaultPath, reportRelativePath);
  const trackerRelativePath = "outputs/.ingest-tracker.md";
  const trackerPath = path.join(base.vaultPath, trackerRelativePath);
  const rawContent = Buffer.from(
    [
      "---",
      "title: Source",
      "tags:",
      "  - user-owned",
      "aliases:",
      "  - User Alias",
      "custom-key: keep-me",
      "---",
      "RAW BODY MUST NOT CHANGE",
      ""
    ].join("\n"),
    "utf8"
  );
  const resultContent = Buffer.from(
    `SHADOW-RESULT ${safeSuffix}\n`,
    "utf8"
  );
  const reportContent = Buffer.from(
    `MAINTENANCE-REPORT ${safeSuffix}\n`,
    "utf8"
  );
  const trackerContent = Buffer.from(
    `TRACKER ${safeSuffix}\n`,
    "utf8"
  );

  await mkdir(path.dirname(rawPath), { recursive: true });
  await mkdir(path.join(base.vaultPath, "wiki"), { recursive: true });
  await mkdir(path.join(base.vaultPath, "projects"), { recursive: true });
  await mkdir(path.join(base.vaultPath, "inbox"), { recursive: true });
  await writeFile(
    path.join(base.vaultPath, "LLM-WIKI.md"),
    "# Harness rules\n",
    "utf8"
  );
  await writeFile(rawPath, rawContent, { mode: 0o640 });
  await chmod(rawPath, 0o640);
  const rawBaselineCas = await snapshotMaintenanceWorkflowFileCas(
    base.vaultPath,
    rawRelativePath
  );
  const rawFingerprint = rawDigestFingerprint(
    rawRelativePath,
    rawContent
  );
  const rawDesiredContent = applyRawDigestFrontmatter(
    rawContent,
    {
      rawPath: rawRelativePath,
      fingerprint: rawFingerprint,
      size: rawContent.byteLength,
      mtime: base.input.draft.startedAt,
      digestedAt: base.input.draft.startedAt,
      runId: workflowRunId,
      reportPath: reportRelativePath,
      evidencePaths: [resultRelativePath],
      confidence: "verified"
    }
  );
  const sourceRecord = {
    relativePath: rawRelativePath,
    size: rawDesiredContent.byteLength,
    mtime: base.input.draft.startedAt,
    fingerprint: rawFingerprint
  };

  const shadowHandle = await createMaintenanceShadowVault({
    liveVaultPath: base.vaultPath,
    attemptId,
    storageRootPath: base.storageRootPath,
    writablePaths: ["outputs"]
  });
  const boundary = await maintenanceShadowExecutionBoundary(shadowHandle);
  await confirmMaintenanceShadowTransportConfigFence(
    shadowHandle,
    base.vaultPath,
    createMaintenanceShadowTransportConfigReceipt({
      backend: "codex-cli",
      attemptId,
      leaseId: `lease:${attemptId}`,
      enforcedWritableRootPaths: boundary.writableRootPaths,
      enforcedDeniedShadowPaths: boundary.deniedPaths,
      deniedLiveVaultPath: base.vaultPath,
      deniedControlPath: boundary.deniedParentPath,
      transportAck: "local test transport fence installed",
      transportConfigDigest: sha256(Buffer.from(attemptId, "utf8"))
    })
  );
  await mkdir(
    path.dirname(path.join(shadowHandle.agentVaultPath, resultRelativePath)),
    { recursive: true }
  );
  await writeFile(
    path.join(shadowHandle.agentVaultPath, resultRelativePath),
    resultContent
  );
  const changeSet = await sealMaintenanceShadowVault(shadowHandle);

  const attempt = {
    attemptId,
    ordinal: 1,
    backend: "codex-cli" as const,
    terminal: {
      status: "completed" as const,
      at: 20
    }
  };
  const baselineTerminal = base.input.draft.settings.baselineTerminal;
  const targetTerminal = {
    ...baselineTerminal,
    lastRunAt: 20,
    lastRunStatus: "success" as const,
    lastReportPath: reportRelativePath,
    lastSummary: "maintenance complete",
    lastCompletion: "full" as const,
    lastAttempts: [attempt]
  };
  const expectedProcessedSource: KnowledgeBaseProcessedSource = {
    path: rawRelativePath,
    size: sourceRecord.size,
    mtime: sourceRecord.mtime,
    fingerprint: sourceRecord.fingerprint,
    digestedAt: base.input.draft.startedAt,
    reportPath: reportRelativePath,
    evidencePaths: [resultRelativePath],
    runId: workflowRunId,
    confidence: "verified"
  };
  const rawRegistryContent = buildRawDigestRegistryContent({
    schemaVersion: RAW_DIGEST_SCHEMA_VERSION,
    updatedAt: new Date(base.input.draft.startedAt).toISOString(),
    entries: {
      [rawRelativePath]: {
        rawPath: rawRelativePath,
        fingerprint: sourceRecord.fingerprint,
        size: sourceRecord.size,
        mtime: sourceRecord.mtime,
        digestedAt: base.input.draft.startedAt,
        runId: workflowRunId,
        reportPath: reportRelativePath,
        evidencePaths: [resultRelativePath],
        confidence: "verified"
      }
    }
  });
  const historyEntry: KnowledgeBaseMaintenanceHistoryEntry = {
    date: "2026-07-18",
    status: "success",
    at: 20,
    runId: workflowRunId,
    mode: "maintain",
    reportPath: reportRelativePath,
    completion: "full",
    selectedBackend: "codex-cli",
    winnerBackend: "codex-cli",
    attempts: [attempt],
    pendingSources: [],
    failureCode: null,
    terminalPhase: "finalized",
    commitState: "committed",
    warnings: []
  };
  const input: PrepareAndCommitMaintenanceWorkflowInput<FixtureSettings> = {
    storageRootPath: base.storageRootPath,
    liveVaultPath: base.vaultPath,
    draft: {
      workflowRunId,
      mode: "maintain",
      startedAt: base.input.draft.startedAt,
      createdAt: base.input.draft.createdAt,
      selectedBackend: "codex-cli",
      candidateBackends: maintenanceBackendOrder("codex-cli"),
      winner: {
        attemptId,
        ordinal: 1,
        backend: "codex-cli"
      },
      completion: "full",
      attempts: [attempt],
      verifiedSources: [sourceRecord],
      pendingSources: [],
      evidencePaths: {
        [rawRelativePath]: [resultRelativePath]
      },
      warnings: [],
      summary: "maintenance complete",
      report: {
        relativePath: reportRelativePath,
        finalBlockDigest: sha256(reportContent)
      },
      indexReconciliation: {
        committed: [],
        deferred: [],
        warnings: []
      },
      settings: {
        baselineProcessedSources: {},
        targetProcessedSources: {
          [rawRelativePath]: expectedProcessedSource
        },
        removedProcessedSourcePaths: [],
        baselineTerminal,
        targetTerminal,
        historyEntry,
        scheduled: null
      }
    },
    managedWrites: [
      {
        kind: "report",
        operation: "upsert",
        relativePath: reportRelativePath,
        expected: await snapshotMaintenanceWorkflowFileCas(
          base.vaultPath,
          reportRelativePath
        ),
        desiredContent: reportContent,
        desiredMode: 0o644
      },
      {
        kind: "tracker",
        operation: "upsert",
        relativePath: trackerRelativePath,
        expected: await snapshotMaintenanceWorkflowFileCas(
          base.vaultPath,
          trackerRelativePath
        ),
        desiredContent: trackerContent,
        desiredMode: 0o644
      },
      {
        kind: "raw-metadata",
        operation: "upsert",
        relativePath: rawRelativePath,
        expected: rawBaselineCas,
        expectedContent: rawContent,
        desiredContent: rawDesiredContent,
        desiredMode: 0o640
      },
      {
        kind: "raw-registry",
        operation: "upsert",
        relativePath: RAW_DIGEST_REGISTRY_PATH,
        expected: await snapshotMaintenanceWorkflowFileCas(
          base.vaultPath,
          RAW_DIGEST_REGISTRY_PATH
        ),
        desiredContent: rawRegistryContent,
        desiredMode: 0o644
      }
    ],
    outcome: {
      kind: "shadow",
      changeSet
    },
    settingsHost: base.host
  };
  return {
    ...base,
    workflowRunId,
    input,
    rawRelativePath,
    rawPath,
    rawContent,
    rawDesiredContent,
    rawBaselineCas,
    rawRegistryPath: path.join(
      base.vaultPath,
      RAW_DIGEST_REGISTRY_PATH
    ),
    rawRegistryContent,
    resultPath,
    resultContent,
    reportPath,
    reportContent,
    trackerPath,
    trackerContent,
    expectedProcessedSource,
    shadowControlRootPath: changeSet.controlRootPath
  };
}

async function createFixture(rootPath: string, suffix: string) {
  const vaultPath = path.join(rootPath, "vault");
  const storageRootPath = path.join(rootPath, "workflow-storage");
  const workflowRunId = `workflow-noop-${suffix}`;
  const noopReceipt = {
    schemaVersion: MAINTENANCE_WORKFLOW_NOOP_RECEIPT_SCHEMA_VERSION,
    kind: "run-scoped-report" as const,
    pathStrategy: "workflow-run-id-sha256-v1" as const,
    dateKey: "2026-07-18"
  };
  const reportRelativePath = maintenanceWorkflowNoopReceiptPath({
    mode: "maintain",
    workflowRunId,
    receipt: noopReceipt
  });
  const reportPath = path.join(vaultPath, reportRelativePath);
  const trackerRelativePath = "outputs/.ingest-tracker.md";
  const trackerPath = path.join(vaultPath, trackerRelativePath);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(storageRootPath, { recursive: true });

  const baselineTerminal = {
    lastRunAt: 10,
    lastRunStatus: "idle" as const,
    lastReportPath: "",
    lastError: "",
    lastSummary: "",
    lastCompletion: "" as const,
    lastAttempts: [],
    lastPendingSources: [],
    lastFailureCode: "",
    lastWarnings: []
  };
  const targetTerminal = {
    lastRunAt: 20,
    lastRunStatus: "success" as const,
    lastReportPath: reportRelativePath,
    lastError: "",
    lastSummary: "没有待处理来源",
    lastCompletion: "noop" as const,
    lastAttempts: [],
    lastPendingSources: [],
    lastFailureCode: "",
    lastWarnings: []
  };
  const historyEntry: KnowledgeBaseMaintenanceHistoryEntry = {
    date: "2026-07-18",
    status: "success",
    at: 20,
    runId: workflowRunId,
    mode: "maintain",
    reportPath: reportRelativePath,
    completion: "noop",
    selectedBackend: "codex-cli",
    winnerBackend: null,
    attempts: [],
    pendingSources: [],
    failureCode: null,
    terminalPhase: "finalized",
    commitState: "committed",
    warnings: []
  };
  const baselineSettings: FixtureSettings = {
    ...baselineTerminal,
    processedSources: {} as Record<string, KnowledgeBaseProcessedSource>,
    maintenanceHistory: [],
    unrelatedPreference: "preserve"
  };
  const host = new MemorySettingsHost(baselineSettings);
  const desiredReport = Buffer.from("NOOP-REPORT\n", "utf8");
  const input = {
    storageRootPath,
    liveVaultPath: vaultPath,
    draft: {
      workflowRunId,
      mode: "maintain" as const,
      startedAt: 10,
      createdAt: "2026-07-18T00:00:00.000Z",
      selectedBackend: "codex-cli" as const,
      candidateBackends: maintenanceBackendOrder("codex-cli"),
      winner: null,
      completion: "noop" as const,
      noopReceipt,
      attempts: [],
      verifiedSources: [],
      pendingSources: [],
      evidencePaths: {},
      warnings: [],
      summary: "没有待处理来源",
      report: {
        relativePath: reportRelativePath,
        finalBlockDigest: sha256(desiredReport)
      },
      indexReconciliation: {
        committed: [],
        deferred: [],
        warnings: []
      },
      settings: {
        baselineProcessedSources: {},
        targetProcessedSources: {},
        removedProcessedSourcePaths: [],
        baselineTerminal,
        targetTerminal,
        historyEntry,
        scheduled: null
      }
    },
    managedWrites: [
      {
        kind: "report" as const,
        operation: "upsert" as const,
        relativePath: reportRelativePath,
        expected: await snapshotMaintenanceWorkflowFileCas(
          vaultPath,
          reportRelativePath
        ),
        desiredContent: desiredReport,
        desiredMode: 0o644
      }
    ],
    outcome: {
      kind: "noop" as const,
      discoveredSources: [],
      changedSources: []
    },
    settingsHost: host
  };
  return {
    vaultPath,
    storageRootPath,
    reportPath,
    trackerPath,
    baselineSettings,
    host,
    input
  };
}

class MemorySettingsHost
implements MaintenanceWorkflowSettingsHost<FixtureSettings> {
  private settings: FixtureSettings;
  private generation = 0;

  constructor(initial: FixtureSettings) {
    this.settings = structuredClone(initial);
  }

  current(): FixtureSettings {
    return structuredClone(this.settings);
  }

  mutate(action: (settings: FixtureSettings) => void): void {
    action(this.settings);
    this.generation += 1;
  }

  async withExclusiveTransaction<R>(
    action: Parameters<
      MaintenanceWorkflowSettingsHost<FixtureSettings>["withExclusiveTransaction"]
    >[0]
  ): Promise<R> {
    return await action({
      readWithGeneration: () => ({
        settings: this.current(),
        generation: String(this.generation)
      }),
      persistCas: (expectedGeneration, settings) => {
        assert.equal(expectedGeneration, String(this.generation));
        this.settings = structuredClone(settings);
        this.generation += 1;
        return {
          settings: this.current(),
          generation: String(this.generation)
        };
      }
    });
  }
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function makeOwnerWritable(absolutePath: string): Promise<void> {
  const stat = await lstat(absolutePath).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(absolutePath, 0o700).catch(() => undefined);
    for (const child of await readdir(absolutePath).catch(() => [])) {
      await makeOwnerWritable(path.join(absolutePath, child));
    }
    return;
  }
  if (stat.isFile()) {
    await chmod(absolutePath, 0o600).catch(() => undefined);
  }
}

if (process.env.ECHOINK_RUN_MAINTENANCE_WORKFLOW_COORDINATOR_TEST === "1") {
  runMaintenanceWorkflowCoordinatorTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
