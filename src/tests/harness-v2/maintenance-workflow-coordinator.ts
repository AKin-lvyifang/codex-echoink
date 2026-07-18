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
  MaintenanceWorkflowSimulatedCrash,
  snapshotMaintenanceWorkflowFileCas,
  type MaintenanceWorkflowSettingsHost,
  type MaintenanceWorkflowSettingsSnapshot
} from "../../harness/maintenance/workflow-wal";
import { maintenanceBackendOrder } from "../../knowledge-base/maintenance-routing";
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
  KnowledgeBaseProcessedSource
} from "../../settings/settings";

interface FixtureSettings extends MaintenanceWorkflowSettingsSnapshot {
  unrelatedPreference: string;
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
  await assertEveryCoordinatorFaultPointRecovers();
  await assertSeededCoordinatorCrashSoak();
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
  fixture: Awaited<ReturnType<typeof createShadowFixture>>
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
    fixture.reportContent.toString("utf8")
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
  const reportRelativePath = "outputs/maintenance/noop.md";
  const reportPath = path.join(vaultPath, reportRelativePath);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(storageRootPath, { recursive: true });

  const workflowRunId = `workflow-noop-${suffix}`;
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
  const trackerRelativePath = "outputs/.ingest-tracker.md";
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
      },
      {
        kind: "tracker" as const,
        operation: "upsert" as const,
        relativePath: trackerRelativePath,
        expected: await snapshotMaintenanceWorkflowFileCas(
          vaultPath,
          trackerRelativePath
        ),
        desiredContent: Buffer.from("TRACKER-NOOP\n", "utf8"),
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
