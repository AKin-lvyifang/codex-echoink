import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  prepareMaintenanceWorkflowWal,
  type MaintenanceWorkflowWalIntentDraft
} from "../harness/maintenance/workflow-wal";
import {
  maintenanceContentFileCas,
  readMaintenanceContentFileBaseline
} from "../knowledge-base/maintenance-content-plan";
import {
  planRawDigestMetadataForSources
} from "../knowledge-base/raw-calibration";
import {
  rawDigestFingerprint
} from "../knowledge-base/raw-digest";
import {
  buildKnowledgeBaseRawIndexContent,
  buildKnowledgeBaseTrackerContent,
  planKnowledgeBaseRawIndexWrite,
  planKnowledgeBaseTrackerWrite,
  rawIndexCommitRecord
} from "../knowledge-base/maintenance";
import {
  maintenanceIndexCommitRecords,
  maintenanceIndexManagedWrites,
  planMaintenanceIndexReconciliation,
  reconcileMaintenanceIndexes
} from "../knowledge-base/maintenance-partial-commit";
import {
  appendKnowledgeBaseMaintenanceFinalBlockContent,
  buildKnowledgeBaseFallbackReportContent,
  planKnowledgeBaseMaintenanceReportWrite
} from "../knowledge-base/report";
import type { KnowledgeBaseProcessedSource } from "../settings/settings";
import type {
  KnowledgeBaseSource,
  KnowledgeRunAttemptRecord
} from "../knowledge-base/types";

export async function runMaintenanceContentPlannerRegressionTests(): Promise<void> {
  await assertRawPlannerIsReadOnlyAndPreservesUserBytes();
  await assertReportBuildersUsePostShadowBaseline();
  await assertTrackerAndRawIndexBuildersArePure();
  await assertIndexReconciliationPlansChildBeforeRoot();
  await assertSealedVerifiedPageCanBePlannedBeforeLiveCommit();
  await assertCorruptIndexIsDeferredWithoutWrites();
  await assertPlannerDraftsPrepareInWorkflowWal();
}

async function assertRawPlannerIsReadOnlyAndPreservesUserBytes(): Promise<void> {
  await withVault(async (vaultPath) => {
    const relativePath = "raw/articles/crlf.md";
    const absolutePath = path.join(vaultPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const original = Buffer.from([
      "---\r\n",
      "title: \"Keep: exact\"\r\n",
      "tags:\r\n",
      "  - alpha\r\n",
      "已处理: false\r\n",
      "custom: yes\r\n",
      "---\r\n",
      "# Body\r\n",
      "\r\n",
      "正文必须逐字节保留。\r\n"
    ].join(""), "utf8");
    await writeFile(absolutePath, original);
    await chmod(absolutePath, 0o640);
    const stat = await lstat(absolutePath);
    const source = knowledgeSource(
      vaultPath,
      relativePath,
      original,
      stat.mtimeMs
    );
    const startedAt = Date.parse("2026-07-18T01:02:03.000Z");
    const plan = await planRawDigestMetadataForSources(vaultPath, [source], {
      reportPath: "outputs/maintenance/report.md",
      startedAt,
      evidencePaths: {
        [relativePath]: ["wiki/ai-intelligence/source.md"]
      },
      confidence: "verified"
    });

    assert.deepEqual(
      plan.managedWrites.map((write) => write.kind),
      ["raw-metadata", "raw-registry"]
    );
    assert.equal(
      await readFile(absolutePath).then((value) => value.equals(original)),
      true,
      "planning must not mutate Raw"
    );
    await assert.rejects(
      lstat(path.join(vaultPath, "outputs", ".raw-digest-registry.json")),
      /ENOENT/,
      "planning must not create the registry"
    );

    const rawWrite = plan.managedWrites[0];
    assert.equal(rawWrite.kind, "raw-metadata");
    assert.equal(rawWrite.expected.kind, "file");
    assert.equal(rawWrite.desiredMode, 0o640);
    assert.equal(rawWrite.expectedContent?.equals(original), true);
    assert.deepEqual(
      markdownBody(rawWrite.desiredContent),
      markdownBody(original),
      "Raw body must remain byte-identical"
    );
    const desiredText = rawWrite.desiredContent.toString("utf8");
    assert.match(
      desiredText,
      /title: "Keep: exact"\r\ntags:\r\n  - alpha\r\ncustom: yes\r\n/,
      "unmanaged frontmatter order and bytes must be preserved"
    );
    assert.match(desiredText, /提炼状态: 已提炼/);
    assert.equal(
      plan.registry.entries[relativePath]?.fingerprint,
      source.fingerprint
    );
    assert.equal(
      plan.managedWrites[1].desiredContent.toString("utf8").includes(relativePath),
      true
    );
  });
}

async function assertReportBuildersUsePostShadowBaseline(): Promise<void> {
  const startedAt = Date.parse("2026-07-18T02:00:00.000Z");
  const fallback = buildKnowledgeBaseFallbackReportContent("", null, {
    mode: "maintain",
    output: "fallback summary",
    sources: [{ relativePath: "raw/a.md" }],
    startedAt
  });
  assert.ok(fallback);
  assert.match(fallback, /fallback summary/);

  const shadowReport = Buffer.from([
    "---",
    "source: agent",
    "---",
    "",
    "# Agent report",
    "",
    "Agent 已写入的正文必须保留。",
    ""
  ].join("\n"), "utf8");
  const finalInput = {
    completion: "partial" as const,
    workflowRunId: "workflow-1",
    attemptId: "attempt-1",
    backend: "codex-cli" as const,
    verifiedSources: [{ relativePath: "raw/a.md" }],
    pendingSources: [{
      source: {
        relativePath: "raw/b.md",
        absolutePath: "/vault/raw/b.md",
        size: 1,
        mtime: 1,
        fingerprint: "sha256:1:x",
        mime: "text/markdown",
        modality: "text" as const,
        changed: true
      },
      reason: {
        code: "structure-evidence-missing" as const,
        message: "缺少证据"
      }
    }],
    warnings: []
  };
  const expected = {
    kind: "file" as const,
    sha256: `sha256:${"a".repeat(64)}`,
    size: shadowReport.byteLength,
    mode: 0o600
  };
  const write = planKnowledgeBaseMaintenanceReportWrite({
    reportPath: "outputs/maintenance/report.md",
    expected,
    baselineContent: shadowReport,
    desiredMode: 0o600,
    finalBlock: finalInput
  });
  assert.deepEqual(write.expected, expected);
  assert.equal(write.desiredMode, 0o600);
  assert.match(write.desiredContent.toString("utf8"), /Agent 已写入的正文必须保留/);
  assert.match(write.desiredContent.toString("utf8"), /EchoInk 验证终态/);

  const replaced = appendKnowledgeBaseMaintenanceFinalBlockContent(
    write.desiredContent.toString("utf8"),
    { ...finalInput, completion: "full", pendingSources: [] }
  );
  assert.equal(
    replaced.match(/echoink-maintenance-final:v1:start/g)?.length,
    1,
    "final block append must replace, not duplicate, an existing block"
  );
  assert.match(replaced, /结果：full/);
}

async function assertTrackerAndRawIndexBuildersArePure(): Promise<void> {
  await withVault(async (vaultPath) => {
    await mkdir(path.join(vaultPath, "raw"), { recursive: true });
    await mkdir(path.join(vaultPath, "outputs"), { recursive: true });
    const processed = processedSources();
    const updatedAt = Date.parse("2026-07-18T03:00:00.000Z");
    const trackerCurrent = [
      "# User tracker notes",
      "",
      "<!-- codex-echoink-kb:start -->",
      "old",
      "<!-- codex-echoink-kb:end -->",
      ""
    ].join("\n");
    const rawIndexCurrent = [
      "# Raw",
      "",
      "用户维护说明",
      "",
      "<!-- codex-echoink-raw-index:start -->",
      "old",
      "<!-- codex-echoink-raw-index:end -->",
      ""
    ].join("\n");
    await writeFile(
      path.join(vaultPath, "outputs", ".ingest-tracker.md"),
      trackerCurrent,
      "utf8"
    );
    await writeFile(path.join(vaultPath, "raw", "index.md"), rawIndexCurrent, "utf8");

    const trackerBuilt = buildKnowledgeBaseTrackerContent(
      trackerCurrent,
      processed,
      updatedAt
    );
    const rawIndexBuilt = buildKnowledgeBaseRawIndexContent(
      rawIndexCurrent,
      processed,
      updatedAt
    );
    assert.match(trackerBuilt, /# User tracker notes/);
    assert.match(trackerBuilt, /raw\/a\.md/);
    assert.match(rawIndexBuilt, /用户维护说明/);
    assert.match(rawIndexBuilt, /\[\[raw\/a\]\]/);

    const trackerPlan = await planKnowledgeBaseTrackerWrite(
      vaultPath,
      processed,
      updatedAt
    );
    const rawIndexPlan = await planKnowledgeBaseRawIndexWrite(
      vaultPath,
      processed,
      updatedAt
    );
    assert.equal(trackerPlan.kind, "tracker");
    assert.equal(rawIndexPlan.kind, "index");
    assert.equal(
      await readFile(path.join(vaultPath, "outputs", ".ingest-tracker.md"), "utf8"),
      trackerCurrent
    );
    assert.equal(
      await readFile(path.join(vaultPath, "raw", "index.md"), "utf8"),
      rawIndexCurrent
    );
  });
}

async function assertIndexReconciliationPlansChildBeforeRoot(): Promise<void> {
  await withVault(async (vaultPath) => {
    const verifiedPath = "wiki/new-domain/verified.md";
    await writeText(vaultPath, verifiedPath, "# Verified\n");
    await writeText(vaultPath, "wiki/index.md", "# Wiki\n");
    const plan = await planMaintenanceIndexReconciliation(
      vaultPath,
      ["wiki/index.md", "wiki/new-domain/00-索引.md"],
      {
        verifiedPagePaths: [verifiedPath],
        verifiedEvidencePaths: {
          "raw/source.md": [verifiedPath]
        },
        skippedAgentIndexPaths: ["wiki/new-domain/00-索引.md"]
      }
    );
    assert.deepEqual(plan.deferred, []);
    assert.deepEqual(
      plan.committed.map((item) => item.relativePath),
      ["wiki/new-domain/00-索引.md", "wiki/index.md"]
    );
    assert.deepEqual(plan.committed[0].sourcePaths, ["raw/source.md"]);
    assert.deepEqual(plan.committed[1].sourcePaths, ["raw/source.md"]);
    assert.match(
      plan.committed[1].desiredContent.toString("utf8"),
      /\[\[wiki\/new-domain\/00-索引\|00-索引\]\]/
    );
    assert.equal(
      plan.committed.every((item) =>
        /^sha256:[a-f0-9]{64}$/.test(item.result.sha256)
        && item.result.size === item.desiredContent.byteLength),
      true
    );
    await assert.rejects(
      lstat(path.join(vaultPath, "wiki", "new-domain", "00-索引.md")),
      /ENOENT/,
      "index planning must not create the child index"
    );

    const result = await reconcileMaintenanceIndexes(
      vaultPath,
      ["wiki/index.md", "wiki/new-domain/00-索引.md"],
      { verifiedPagePaths: [verifiedPath] }
    );
    assert.deepEqual(result.updatedPaths, [
      "wiki/new-domain/00-索引.md",
      "wiki/index.md"
    ]);
  });
}

async function assertSealedVerifiedPageCanBePlannedBeforeLiveCommit(): Promise<void> {
  await withVault(async (vaultPath) => {
    await mkdir(path.join(vaultPath, "wiki"), { recursive: true });
    await writeText(vaultPath, "wiki/index.md", "# Wiki\n");
    const sealedPage = "wiki/future-domain/verified.md";
    const plan = await planMaintenanceIndexReconciliation(
      vaultPath,
      ["wiki/future-domain/00-索引.md", "wiki/index.md"],
      {
        verifiedEvidencePaths: {
          "raw/future.md": [sealedPage]
        },
        trustedSealedPagePaths: [sealedPage]
      }
    );
    assert.deepEqual(plan.deferred, []);
    assert.deepEqual(
      plan.committed.map((item) => item.relativePath),
      ["wiki/future-domain/00-索引.md", "wiki/index.md"]
    );
    assert.deepEqual(
      plan.committed.map((item) => item.sourcePaths),
      [["raw/future.md"], ["raw/future.md"]]
    );
    assert.match(
      plan.committed[0].desiredContent.toString("utf8"),
      /\[\[wiki\/future-domain\/verified\|verified\]\]/
    );
    await assert.rejects(
      lstat(path.join(vaultPath, sealedPage)),
      /ENOENT/,
      "trusted sealed pages must not be materialized by the planner"
    );
  });
}

async function assertCorruptIndexIsDeferredWithoutWrites(): Promise<void> {
  await withVault(async (vaultPath) => {
    const indexPath = "wiki/domain/00-索引.md";
    const corrupt = [
      "# Domain",
      "<!-- echoink-maintenance-index:v1:start -->",
      "- [[wiki/domain/old]]"
    ].join("\n");
    await writeText(vaultPath, "wiki/domain/verified.md", "# Verified\n");
    await writeText(vaultPath, indexPath, corrupt);
    const plan = await planMaintenanceIndexReconciliation(
      vaultPath,
      [indexPath],
      { verifiedPagePaths: ["wiki/domain/verified.md"] }
    );
    assert.equal(plan.committed.length, 0);
    assert.equal(plan.deferred.length, 1);
    assert.match(plan.deferred[0].reason, /损坏的开始标记/);
    assert.equal(await readFile(path.join(vaultPath, indexPath), "utf8"), corrupt);
    await assert.rejects(
      reconcileMaintenanceIndexes(vaultPath, [indexPath], {
        verifiedPagePaths: ["wiki/domain/verified.md"]
      }),
      /损坏的开始标记/
    );
  });
}

async function assertPlannerDraftsPrepareInWorkflowWal(): Promise<void> {
  await withVault(async (vaultPath) => {
    const storageRootInput = path.join(vaultPath, ".echoink-storage");
    await mkdir(storageRootInput, { recursive: true });
    const storageRootPath = await realpath(storageRootInput);
    const shadowControlRootPath = path.join(storageRootPath, "shadow-attempt");
    await mkdir(shadowControlRootPath, { recursive: true });
    const relativePath = "raw/source.md";
    const rawContent = Buffer.from("# Source\n\nPlanner to WAL.\n", "utf8");
    await writeText(vaultPath, relativePath, rawContent.toString("utf8"));
    await writeText(vaultPath, "raw/index.md", "# Raw\n");
    await writeText(vaultPath, "wiki/index.md", "# Wiki\n");
    await writeText(
      vaultPath,
      "outputs/maintenance/report.md",
      "# Agent report\n\nverified\n"
    );
    await writeText(
      vaultPath,
      "outputs/.ingest-tracker.md",
      "# Tracker\n"
    );
    const rawStat = await lstat(path.join(vaultPath, relativePath));
    const source = knowledgeSource(
      vaultPath,
      relativePath,
      rawContent,
      rawStat.mtimeMs
    );
    const workflowRunId = "workflow-planner-prepare";
    const startedAt = Date.parse("2026-07-18T04:00:00.000Z");
    const reportPath = "outputs/maintenance/report.md";
    const evidencePaths = {
      [relativePath]: ["wiki/evidence.md"]
    };
    const rawPlan = await planRawDigestMetadataForSources(
      vaultPath,
      [source],
      {
        reportPath,
        startedAt,
        runId: workflowRunId,
        evidencePaths,
        confidence: "verified"
      }
    );
    const plannedSource = rawPlan.updatedSources[0];
    const processed: KnowledgeBaseProcessedSource = {
      path: relativePath,
      size: plannedSource.size,
      mtime: plannedSource.mtime,
      fingerprint: plannedSource.fingerprint,
      digestedAt: startedAt,
      reportPath,
      evidencePaths: evidencePaths[relativePath],
      runId: workflowRunId,
      confidence: "verified"
    };
    const targetProcessedSources = { [relativePath]: processed };
    const trackerWrite = await planKnowledgeBaseTrackerWrite(
      vaultPath,
      targetProcessedSources,
      startedAt
    );
    const rawIndexWrite = await planKnowledgeBaseRawIndexWrite(
      vaultPath,
      targetProcessedSources,
      startedAt,
      { verifiedSourcePaths: [relativePath] }
    );
    const sharedIndexPlan = await planMaintenanceIndexReconciliation(
      vaultPath,
      ["wiki/index.md"],
      {
        verifiedEvidencePaths: evidencePaths,
        trustedSealedPagePaths: evidencePaths[relativePath]
      }
    );
    assert.deepEqual(sharedIndexPlan.deferred, []);
    assert.deepEqual(
      sharedIndexPlan.committed[0]?.sourcePaths,
      [relativePath]
    );
    const reportBaseline = await readMaintenanceContentFileBaseline(
      vaultPath,
      reportPath,
      { requireExisting: true }
    );
    assert.ok(reportBaseline.content);
    const finalBlock = {
      completion: "full" as const,
      workflowRunId,
      attemptId: `${workflowRunId}-attempt-1-codex`,
      backend: "codex-cli" as const,
      verifiedSources: [plannedSource],
      pendingSources: [],
      warnings: []
    };
    const reportWrite = planKnowledgeBaseMaintenanceReportWrite({
      reportPath,
      expected: reportBaseline.expected,
      baselineContent: reportBaseline.content,
      desiredMode: reportBaseline.mode,
      finalBlock
    });
    const reportResult = maintenanceContentFileCas(
      reportWrite.desiredContent,
      reportWrite.desiredMode
    );
    assert.equal(reportResult.kind, "file");
    const attempt: KnowledgeRunAttemptRecord = {
      attemptId: finalBlock.attemptId,
      ordinal: 1,
      backend: "codex-cli",
      terminal: { status: "completed", at: startedAt }
    };
    const baselineTerminal = {
      lastRunAt: 0,
      lastRunStatus: "idle" as const,
      lastReportPath: "",
      lastError: "",
      lastSummary: "",
      lastCompletion: "" as const,
      lastAttempts: [] as KnowledgeRunAttemptRecord[],
      lastPendingSources: [] as string[],
      lastFailureCode: "",
      lastWarnings: []
    };
    const summary = "planner WAL prepare";
    const targetTerminal = {
      lastRunAt: startedAt,
      lastRunStatus: "success" as const,
      lastReportPath: reportPath,
      lastError: "",
      lastSummary: summary,
      lastCompletion: "full" as const,
      lastAttempts: [attempt],
      lastPendingSources: [] as string[],
      lastFailureCode: "",
      lastWarnings: []
    };
    const digest = maintenanceContentFileCas(Buffer.from("digest"), 0o644);
    assert.equal(digest.kind, "file");
    const draft: MaintenanceWorkflowWalIntentDraft = {
      workflowRunId,
      mode: "maintain",
      startedAt,
      createdAt: new Date(startedAt).toISOString(),
      selectedBackend: "codex-cli",
      candidateBackends: ["codex-cli", "opencode", "hermes"],
      winner: {
        attemptId: attempt.attemptId,
        ordinal: attempt.ordinal,
        backend: attempt.backend
      },
      completion: "full",
      attempts: [attempt],
      verifiedSources: [{
        relativePath,
        size: plannedSource.size,
        mtime: plannedSource.mtime,
        fingerprint: plannedSource.fingerprint
      }],
      pendingSources: [],
      evidencePaths,
      warnings: [],
      summary,
      shadow: {
        controlRootPath: shadowControlRootPath,
        changeSetDigest: digest.sha256,
        selectionDigest: digest.sha256,
        liveVaultFingerprint: digest.sha256,
        allowPaths: ["wiki/evidence.md"],
        expectedAppliedPaths: ["wiki/evidence.md"],
        skippedPaths: []
      },
      report: {
        relativePath: reportPath,
        finalBlockDigest: reportResult.sha256
      },
      indexReconciliation: {
        committed: [
          rawIndexCommitRecord(rawIndexWrite),
          ...maintenanceIndexCommitRecords(sharedIndexPlan)
        ],
        deferred: [],
        warnings: sharedIndexPlan.warnings
      },
      settings: {
        scheduled: null,
        baselineProcessedSources: {},
        targetProcessedSources,
        removedProcessedSourcePaths: [],
        baselineTerminal,
        targetTerminal,
        historyEntry: {
          date: "2026-07-18",
          status: "success",
          at: startedAt,
          runId: workflowRunId,
          mode: "maintain",
          reportPath,
          completion: "full",
          selectedBackend: "codex-cli",
          winnerBackend: "codex-cli",
          attempts: [attempt],
          pendingSources: [],
          failureCode: null,
          terminalPhase: "finalized",
          commitState: "committed",
          warnings: []
        }
      }
    };
    const prepared = await prepareMaintenanceWorkflowWal({
      storageRootPath,
      draft,
      managedWrites: [
        ...rawPlan.managedWrites,
        reportWrite,
        rawIndexWrite,
        ...maintenanceIndexManagedWrites(sharedIndexPlan),
        trackerWrite
      ]
    });
    assert.equal(prepared.state.phase, "prepared");
    assert.equal(
      prepared.intent.managedWrites.every((write) =>
        write.expected.kind === "missing"
        || /^sha256:[a-f0-9]{64}$/.test(write.expected.sha256)),
      true
    );
  });
}

function knowledgeSource(
  vaultPath: string,
  relativePath: string,
  content: Buffer,
  mtime: number
): KnowledgeBaseSource {
  return {
    relativePath,
    absolutePath: path.join(vaultPath, relativePath),
    size: content.byteLength,
    mtime,
    fingerprint: rawDigestFingerprint(relativePath, content),
    mime: "text/markdown",
    modality: "text",
    changed: true
  };
}

function processedSources(): Record<string, KnowledgeBaseProcessedSource> {
  return {
    "raw/a.md": {
      path: "raw/a.md",
      size: 10,
      mtime: 20,
      fingerprint: "sha256:10:abc",
      digestedAt: Date.parse("2026-07-18T02:59:00.000Z")
    }
  };
}

function markdownBody(content: Buffer): Buffer {
  const openingEnd = content.indexOf(0x0a);
  if (openingEnd < 0) return content;
  const opening = content.subarray(0, openingEnd).toString("utf8").replace(/\r$/, "");
  if (opening !== "---") return content;
  let cursor = openingEnd + 1;
  while (cursor < content.length) {
    const end = content.indexOf(0x0a, cursor);
    const lineEnd = end < 0 ? content.length : end;
    const line = content.subarray(cursor, lineEnd).toString("utf8").replace(/\r$/, "");
    if (line === "---" || line === "...") {
      return content.subarray(end < 0 ? content.length : end + 1);
    }
    cursor = end < 0 ? content.length : end + 1;
  }
  throw new Error("test fixture frontmatter is not closed");
}

async function writeText(
  vaultPath: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = path.join(vaultPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function withVault(
  callback: (vaultPath: string) => Promise<void>
): Promise<void> {
  const vaultPath = await mkdtemp(
    path.join(tmpdir(), "echoink-maintenance-content-plan-")
  );
  try {
    await callback(vaultPath);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}
