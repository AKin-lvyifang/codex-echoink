import * as assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  evaluateDigestEvidence,
  verifyDigestEvidence,
  type KnowledgeTransactionSnapshot
} from "../../knowledge-base/digest-evidence";
import {
  disposeKnowledgeTransactionSnapshot,
  snapshotKnowledgeTransactionEntries
} from "../../knowledge-base/transaction-snapshot-core";
import {
  maintenanceIndexReconciliationWarning,
  planMaintenancePartialCommit,
  reconcileMaintenanceIndexes
} from "../../knowledge-base/maintenance-partial-commit";
import type { KnowledgeBaseSource } from "../../knowledge-base/types";

export async function runHarnessV2MaintenancePartialEvidenceTests(): Promise<void> {
  await assertIndependentSourceCanCommit();
  await assertReportCoverageIsEvaluatedPerSource();
  await assertSharedTargetDependencyGroupIsDeferredTransitively();
  await assertHistoricalReferenceDoesNotJoinDependencyGroup();
  await assertExistingVerifiedEvidenceDefersPendingChangeInSameTarget();
  await assertRemovedExistingEvidenceDefersSharedChangeset();
  await assertRepairableExistingEvidenceStillWorks();
  await assertGlobalPrerequisitesAreExplicit();
  await assertEmptySourceCompatibility();
  assertSharedIndexWithVerifiedAndPendingSourcesIsDeferred();
  assertVerifiedPageSchedulesHostIndexesWithoutAgentIndexChanges();
  await assertSharedIndexIsRebuiltFromCommittedLivePages();
  await assertChildIndexIsRebuiltBeforeWikiRootIndex();
  await assertCorruptManagedIndexFailsClosed();
  await assertUnsafeIndexLinksFailClosed();
}

function assertSharedIndexWithVerifiedAndPendingSourcesIsDeferred(): void {
  const reportPath = "outputs/maintenance/kb-maintenance-partial.md";
  const changes = [
    "wiki/ai-intelligence/verified.md",
    "wiki/ai-intelligence/pending.md",
    "wiki/index.md",
    "wiki/ai-intelligence/00-索引.md",
    "projects/00-索引.md",
    reportPath
  ].map((relativePath) => ({
    operation: "upsert" as const,
    relativePath,
    expectedLive: { kind: "missing" as const },
    shadowSha256: "a".repeat(64),
    size: 1,
    blobRelativePath: `blobs/${relativePath}`
  }));
  const result = planMaintenancePartialCommit({
    changeSet: { changes },
    reportPath,
    evidencePaths: {
      "raw/articles/verified.md": [
        "wiki/ai-intelligence/verified.md",
        // Defense in depth: an index must never become evidence-commit eligible
        // even if a future evaluator accidentally returns it.
        "wiki/ai-intelligence/00-索引.md"
      ]
    }
  });

  assert.deepEqual(result.allowPaths, [
    reportPath,
    "wiki/ai-intelligence/verified.md"
  ]);
  assert.deepEqual(result.skippedAgentIndexPaths, [
    "projects/00-索引.md",
    "wiki/ai-intelligence/00-索引.md",
    "wiki/index.md"
  ]);
  assert.deepEqual(result.reconciliationIndexPaths, [
    "projects/00-索引.md",
    "wiki/ai-intelligence/00-索引.md",
    "wiki/index.md"
  ]);
}

function assertVerifiedPageSchedulesHostIndexesWithoutAgentIndexChanges(): void {
  const reportPath = "outputs/maintenance/kb-maintenance-partial.md";
  const changes = [
    "wiki/ai-intelligence/verified.md",
    reportPath
  ].map((relativePath) => ({
    operation: "upsert" as const,
    relativePath,
    expectedLive: { kind: "missing" as const },
    shadowSha256: "b".repeat(64),
    size: 1,
    blobRelativePath: `blobs/${relativePath}`
  }));
  const result = planMaintenancePartialCommit({
    changeSet: { changes },
    reportPath,
    evidencePaths: {
      "raw/articles/verified.md": ["wiki/ai-intelligence/verified.md"]
    }
  });

  assert.deepEqual(result.skippedAgentIndexPaths, []);
  assert.deepEqual(result.reconciliationIndexPaths, [
    "wiki/ai-intelligence/00-索引.md",
    "wiki/index.md"
  ]);
}

async function assertSharedIndexIsRebuiltFromCommittedLivePages(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const indexPath = "wiki/ai-intelligence/00-索引.md";
    await writeFileAt(vaultPath, "wiki/ai-intelligence/verified.md", "# Verified\n");
    await writeFileAt(vaultPath, "wiki/ai-intelligence/prior-verified.md", "# Prior verified\n");
    await writeFileAt(vaultPath, indexPath, [
      "# AI Intelligence",
      "",
      "- [[wiki/ai-intelligence/curated|人工维护条目]]",
      "- [[wiki/ai-intelligence/verified-extra|前缀相似但不是 verified]]",
      "",
      "<!-- echoink-maintenance-index:v1:start -->",
      "## EchoInk 已验证页面",
      "",
      "- [[wiki/ai-intelligence/prior-verified|先前已验证页面]]",
      "- [[wiki/ai-intelligence/pending|不应保留的 Shadow 页面]]",
      "<!-- echoink-maintenance-index:v1:end -->",
      ""
    ].join("\n"));

    const reconciled = await reconcileMaintenanceIndexes(vaultPath, [indexPath], {
      verifiedPagePaths: ["wiki/ai-intelligence/verified.md"]
    });
    const indexText = await readFile(path.join(vaultPath, indexPath), "utf8");
    assert.deepEqual(reconciled.reconciledPaths, [indexPath]);
    assert.deepEqual(reconciled.updatedPaths, [indexPath]);
    assert.match(indexText, /\[\[wiki\/ai-intelligence\/curated\|人工维护条目\]\]/);
    assert.match(indexText, /\[\[wiki\/ai-intelligence\/prior-verified\|prior-verified\]\]/);
    assert.match(indexText, /\[\[wiki\/ai-intelligence\/verified\|verified\]\]/);
    assert.doesNotMatch(indexText, /wiki\/ai-intelligence\/pending/);
    assert.equal(indexText.match(/echoink-maintenance-index:v1:start/g)?.length, 1);
    assert.equal(indexText.match(/echoink-maintenance-index:v1:end/g)?.length, 1);

    const warnings = maintenanceIndexReconciliationWarning(reconciled, {
      skippedAgentIndexPaths: [indexPath]
    });
    assert.equal(warnings[0]?.id, "partial-index-reconciled");
    assert.match(warnings[0]?.message ?? "", /真实已提交页面/);
  });
}

async function assertChildIndexIsRebuiltBeforeWikiRootIndex(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    await writeFileAt(vaultPath, "wiki/new-domain/verified.md", "# Verified\n");
    await writeFileAt(vaultPath, "wiki/index.md", "# Wiki\n");

    const reconciled = await reconcileMaintenanceIndexes(vaultPath, [
      "wiki/index.md",
      "wiki/new-domain/00-索引.md"
    ], {
      verifiedPagePaths: ["wiki/new-domain/verified.md"]
    });
    const domainIndex = await readFile(path.join(vaultPath, "wiki/new-domain/00-索引.md"), "utf8");
    const rootIndex = await readFile(path.join(vaultPath, "wiki/index.md"), "utf8");

    assert.deepEqual(reconciled.reconciledPaths, [
      "wiki/new-domain/00-索引.md",
      "wiki/index.md"
    ]);
    assert.match(domainIndex, /\[\[wiki\/new-domain\/verified\|verified\]\]/);
    assert.match(rootIndex, /\[\[wiki\/new-domain\/00-索引\|00-索引\]\]/);
  });
}

async function assertCorruptManagedIndexFailsClosed(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const indexPath = "wiki/ai-intelligence/00-索引.md";
    const corrupt = [
      "# AI Intelligence",
      "",
      "<!-- echoink-maintenance-index:v1:start -->",
      "- [[wiki/ai-intelligence/old]]"
    ].join("\n");
    await writeFileAt(vaultPath, "wiki/ai-intelligence/verified.md", "# Verified\n");
    await writeFileAt(vaultPath, indexPath, corrupt);

    await assert.rejects(
      reconcileMaintenanceIndexes(vaultPath, [indexPath], {
        verifiedPagePaths: ["wiki/ai-intelligence/verified.md"]
      }),
      /损坏的开始标记/
    );
    assert.equal(await readFile(path.join(vaultPath, indexPath), "utf8"), corrupt);
  });
}

async function assertUnsafeIndexLinksFailClosed(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const directory = path.join(vaultPath, "wiki", "ai-intelligence");
    await mkdir(directory, { recursive: true });
    const realIndex = path.join(directory, "real-index.md");
    const hardlinkedIndex = path.join(directory, "00-索引.md");
    await writeFile(realIndex, "# Real\n", "utf8");
    await link(realIndex, hardlinkedIndex);
    await assert.rejects(
      reconcileMaintenanceIndexes(vaultPath, ["wiki/ai-intelligence/00-索引.md"]),
      /索引不是普通文件/
    );
  });

  if (process.platform !== "win32") {
    await withTestVault(async (vaultPath) => {
      const directory = path.join(vaultPath, "wiki", "ai-intelligence");
      await mkdir(directory, { recursive: true });
      const realIndex = path.join(directory, "real-index.md");
      const symlinkedIndex = path.join(directory, "00-索引.md");
      await writeFile(realIndex, "# Real\n", "utf8");
      await symlink("real-index.md", symlinkedIndex);
      await assert.rejects(
        reconcileMaintenanceIndexes(vaultPath, ["wiki/ai-intelligence/00-索引.md"]),
        /索引不是普通文件/
      );
    });
  }
}

async function assertIndependentSourceCanCommit(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const alpha = source(vaultPath, "raw/articles/alpha.md");
    const bravo = source(vaultPath, "raw/articles/bravo.md");
    const reportPath = "outputs/maintenance/kb-maintenance-partial.md";
    const startedAt = Date.now() - 10_000;
    await writeReport(vaultPath, reportPath, [alpha, bravo]);
    await writeKnowledgePage(vaultPath, "wiki/alpha.md", alpha, "Alpha 的结论已经完整写入独立知识页，可安全单独登记为已提炼。");

    const result = await evaluateDigestEvidence({
      vaultPath,
      reportPath,
      sources: [alpha, bravo],
      startedAt,
      transactionBefore: emptySnapshot(vaultPath),
      processedSourcesBeforeRun: {}
    });

    assert.deepEqual(result.verifiedSources.map((item) => item.relativePath), [alpha.relativePath]);
    assert.deepEqual(result.evidencePaths, {
      [alpha.relativePath]: ["wiki/alpha.md"]
    });
    assert.equal(result.pendingSources.length, 1);
    assert.equal(result.pendingSources[0].source.relativePath, bravo.relativePath);
    assert.equal(result.pendingSources[0].reason.code, "structure-evidence-missing");

    await assert.rejects(
      verifyDigestEvidence({
        vaultPath,
        reportPath,
        sources: [alpha, bravo],
        startedAt,
        transactionBefore: emptySnapshot(vaultPath),
        processedSourcesBeforeRun: {}
      }),
      /结构层消化证据.*raw\/articles\/bravo\.md/
    );
  });
}

async function assertReportCoverageIsEvaluatedPerSource(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const alpha = source(vaultPath, "raw/articles/alpha.md");
    const bravo = source(vaultPath, "raw/articles/bravo.md");
    const delta = source(vaultPath, "raw/articles/delta.md");
    const reportPath = "outputs/maintenance/kb-maintenance-report-partial.md";
    const startedAt = Date.now() - 10_000;
    await writeReport(vaultPath, reportPath, [alpha, delta]);
    await writeFileAt(vaultPath, "wiki/shared-report-gap.md", [
      "## Alpha",
      `- 来源：[[${withoutMarkdownExtension(alpha.relativePath)}]]`,
      "- Alpha 的结构化知识证据已经写入共享页面并完成来源绑定。",
      "",
      "## Bravo",
      `- 来源：[[${withoutMarkdownExtension(bravo.relativePath)}]]`,
      "- Bravo 的结构化知识证据也已完整写入，只是维护报告遗漏了来源。"
    ].join("\n"));
    await writeKnowledgePage(vaultPath, "wiki/delta.md", delta, "Delta 使用独立目标文件，因此不受共享页报告漏项的影响。");

    const result = await evaluateDigestEvidence({
      vaultPath,
      reportPath,
      sources: [alpha, bravo, delta],
      startedAt,
      transactionBefore: emptySnapshot(vaultPath),
      processedSourcesBeforeRun: {}
    });

    assert.deepEqual(result.verifiedSources.map((item) => item.relativePath), [delta.relativePath]);
    assert.deepEqual(result.evidencePaths, {
      [delta.relativePath]: ["wiki/delta.md"]
    });
    assert.deepEqual(
      result.pendingSources.map((item) => [item.source.relativePath, item.reason.code]),
      [
        [alpha.relativePath, "shared-target-dependency"],
        [bravo.relativePath, "maintenance-report-source-missing"]
      ]
    );
    assert.deepEqual(result.pendingSources[0].reason.relatedSources, [bravo.relativePath]);
    assert.deepEqual(result.pendingSources[0].reason.targetPaths, ["wiki/shared-report-gap.md"]);
    assert.deepEqual(result.pendingSources[1].reason.targetPaths, ["wiki/shared-report-gap.md"]);

    await assert.rejects(
      verifyDigestEvidence({
        vaultPath,
        reportPath,
        sources: [alpha, bravo, delta],
        startedAt,
        transactionBefore: emptySnapshot(vaultPath),
        processedSourcesBeforeRun: {}
      }),
      /维护报告缺少本轮来源证据.*raw\/articles\/bravo\.md/
    );
  });
}

async function assertSharedTargetDependencyGroupIsDeferredTransitively(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const alpha = source(vaultPath, "raw/articles/alpha.md");
    const bravo = source(vaultPath, "raw/articles/bravo.md");
    const charlie = source(vaultPath, "raw/articles/charlie.md");
    const delta = source(vaultPath, "raw/articles/delta.md");
    const reportPath = "outputs/maintenance/kb-maintenance-shared-target.md";
    const startedAt = Date.now() - 10_000;
    await writeReport(vaultPath, reportPath, [alpha, bravo, charlie, delta]);
    await writeFileAt(vaultPath, "wiki/group-one.md", [
      "## Alpha",
      `- 来源：[[${withoutMarkdownExtension(alpha.relativePath)}]]`,
      "- Alpha 已形成可复用的第一组知识结论，并保留了明确的原始来源。",
      "",
      "## Bravo",
      `- 来源：[[${withoutMarkdownExtension(bravo.relativePath)}]]`,
      "- Bravo 已形成可复用的第一组知识结论，并保留了明确的原始来源。"
    ].join("\n"));
    await writeFileAt(vaultPath, "wiki/group-two.md", [
      "## Bravo 补充",
      `- 来源：[[${withoutMarkdownExtension(bravo.relativePath)}]]`,
      "- Bravo 的补充结论与下一来源共用目标页，因此属于同一个提交依赖组。",
      "",
      "## Charlie",
      `- 来源：[[${withoutMarkdownExtension(charlie.relativePath)}]]`
    ].join("\n"));
    await writeKnowledgePage(vaultPath, "wiki/delta.md", delta, "Delta 写入独立目标页，不受共享目标依赖组失败的影响。");

    const result = await evaluateDigestEvidence({
      vaultPath,
      reportPath,
      sources: [alpha, bravo, charlie, delta],
      startedAt,
      transactionBefore: emptySnapshot(vaultPath),
      processedSourcesBeforeRun: {}
    });

    assert.deepEqual(result.verifiedSources.map((item) => item.relativePath), [delta.relativePath]);
    assert.deepEqual(result.evidencePaths, {
      [delta.relativePath]: ["wiki/delta.md"]
    });
    assert.deepEqual(
      result.pendingSources.map((item) => [item.source.relativePath, item.reason.code]),
      [
        [alpha.relativePath, "shared-target-dependency"],
        [bravo.relativePath, "shared-target-dependency"],
        [charlie.relativePath, "structure-evidence-missing"]
      ]
    );
    for (const item of result.pendingSources.slice(0, 2)) {
      assert.deepEqual(item.reason.relatedSources, [charlie.relativePath]);
      assert.deepEqual(item.reason.targetPaths, ["wiki/group-one.md", "wiki/group-two.md"]);
    }
    assert.deepEqual(result.pendingSources[2].reason.targetPaths, ["wiki/group-two.md"]);

    await assert.rejects(
      verifyDigestEvidence({
        vaultPath,
        reportPath,
        sources: [alpha, bravo, charlie, delta],
        startedAt,
        transactionBefore: emptySnapshot(vaultPath),
        processedSourcesBeforeRun: {}
      }),
      (error: unknown) => {
        assert.match(String(error), /结构层消化证据.*raw\/articles\/charlie\.md/);
        assert.doesNotMatch(String(error), /raw\/articles\/alpha\.md/);
        return true;
      }
    );
  });
}

async function assertHistoricalReferenceDoesNotJoinDependencyGroup(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const alpha = source(vaultPath, "raw/articles/alpha.md");
    const historical = source(vaultPath, "raw/articles/historical.md");
    const targetPath = "wiki/aggregate.md";
    await writeFileAt(vaultPath, targetPath, [
      "## 历史引用",
      `- 来源：[[${withoutMarkdownExtension(historical.relativePath)}]]`
    ].join("\n"));
    const transactionBefore = await snapshotKnowledgeTransactionEntries(vaultPath, ["wiki", "projects", "outputs"]);
    try {
      await writeFileAt(vaultPath, targetPath, [
        "## 历史引用",
        `- 来源：[[${withoutMarkdownExtension(historical.relativePath)}]]`,
        "",
        "## Alpha",
        `- 来源：[[${withoutMarkdownExtension(alpha.relativePath)}]]`,
        "- Alpha 本轮新增了完整的结构化结论，历史引用块本身没有发生变化。"
      ].join("\n"));
      const reportPath = "outputs/maintenance/kb-maintenance-history.md";
      const startedAt = Date.now() - 10_000;
      await writeReport(vaultPath, reportPath, [alpha, historical]);

      const result = await evaluateDigestEvidence({
        vaultPath,
        reportPath,
        sources: [alpha, historical],
        startedAt,
        transactionBefore,
        processedSourcesBeforeRun: {}
      });

      assert.deepEqual(result.verifiedSources.map((item) => item.relativePath), [alpha.relativePath]);
      assert.deepEqual(result.evidencePaths, {
        [alpha.relativePath]: [targetPath]
      });
      assert.equal(result.pendingSources[0].source.relativePath, historical.relativePath);
      assert.equal(result.pendingSources[0].reason.code, "structure-evidence-missing");
      assert.deepEqual(result.pendingSources[0].reason.targetPaths, []);
    } finally {
      await disposeKnowledgeTransactionSnapshot(transactionBefore);
    }
  });
}

async function assertExistingVerifiedEvidenceDefersPendingChangeInSameTarget(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const alpha = source(vaultPath, "raw/articles/alpha.md");
    const bravo = source(vaultPath, "raw/articles/bravo.md");
    const targetPath = "wiki/existing-alpha-pending-bravo.md";
    await writeRepairableKnowledgePage(
      vaultPath,
      targetPath,
      alpha,
      "Alpha 的既有证据保持有效，但共享文件本轮还会加入一个未完成的 Bravo 块。"
    );
    const transactionBefore = await snapshotKnowledgeTransactionEntries(vaultPath, ["wiki", "projects", "outputs"]);
    try {
      await writeFileAt(vaultPath, targetPath, [
        `> 来源：[[${withoutMarkdownExtension(alpha.relativePath)}]]`,
        "",
        "## 关键结论",
        "",
        "- Alpha 的既有证据保持有效，但共享文件本轮还会加入一个未完成的 Bravo 块。",
        "",
        "## Bravo",
        `- 来源：[[${withoutMarkdownExtension(bravo.relativePath)}]]`
      ].join("\n"));
      const reportPath = "outputs/maintenance/kb-maintenance-existing-shared-pending.md";
      const startedAt = Date.now() - 10_000;
      await writeReport(vaultPath, reportPath, [alpha, bravo]);

      const result = await evaluateDigestEvidence({
        vaultPath,
        reportPath,
        sources: [alpha, bravo],
        startedAt,
        transactionBefore,
        processedSourcesBeforeRun: {}
      });

      assert.deepEqual(result.verifiedSources, []);
      assert.deepEqual(result.evidencePaths, {});
      assert.deepEqual(
        result.pendingSources.map((item) => [item.source.relativePath, item.reason.code]),
        [
          [alpha.relativePath, "shared-target-dependency"],
          [bravo.relativePath, "structure-evidence-missing"]
        ]
      );
      assert.deepEqual(result.pendingSources[0].reason.relatedSources, [bravo.relativePath]);
      assert.deepEqual(result.pendingSources[0].reason.targetPaths, [targetPath]);
      assert.deepEqual(result.pendingSources[1].reason.targetPaths, [targetPath]);
    } finally {
      await disposeKnowledgeTransactionSnapshot(transactionBefore);
    }
  });
}

async function assertRemovedExistingEvidenceDefersSharedChangeset(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const alpha = source(vaultPath, "raw/articles/alpha.md");
    const bravo = source(vaultPath, "raw/articles/bravo.md");
    const targetPath = "wiki/replaced-shared-page.md";
    await writeRepairableKnowledgePage(vaultPath, targetPath, bravo, "Bravo 原本有可复验的结构化证据，稍后会被本轮改动删除。");
    const transactionBefore = await snapshotKnowledgeTransactionEntries(vaultPath, ["wiki", "projects", "outputs"]);
    try {
      await writeKnowledgePage(vaultPath, targetPath, alpha, "Alpha 写入了新结论，但同一文件中 Bravo 的旧证据已被删除。");
      const reportPath = "outputs/maintenance/kb-maintenance-removed-evidence.md";
      const startedAt = Date.now() - 10_000;
      await writeReport(vaultPath, reportPath, [alpha, bravo]);

      const result = await evaluateDigestEvidence({
        vaultPath,
        reportPath,
        sources: [alpha, bravo],
        startedAt,
        transactionBefore,
        processedSourcesBeforeRun: {}
      });

      assert.deepEqual(result.verifiedSources, []);
      assert.deepEqual(result.evidencePaths, {});
      assert.deepEqual(
        result.pendingSources.map((item) => [item.source.relativePath, item.reason.code]),
        [
          [alpha.relativePath, "shared-target-dependency"],
          [bravo.relativePath, "structure-evidence-missing"]
        ]
      );
      assert.deepEqual(result.pendingSources[0].reason.relatedSources, [bravo.relativePath]);
      assert.deepEqual(result.pendingSources[0].reason.targetPaths, [targetPath]);
      assert.deepEqual(result.pendingSources[1].reason.targetPaths, [targetPath]);
    } finally {
      await disposeKnowledgeTransactionSnapshot(transactionBefore);
    }
  });
}

async function assertRepairableExistingEvidenceStillWorks(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const bravo = source(vaultPath, "raw/articles/bravo.md");
    const targetPath = "wiki/existing-bravo.md";
    await writeRepairableKnowledgePage(vaultPath, targetPath, bravo, "Bravo 的既有知识证据保持不变，可以继续用于旧数据校准兼容。");
    const transactionBefore = await snapshotKnowledgeTransactionEntries(vaultPath, ["wiki", "projects", "outputs"]);
    try {
      const reportPath = "outputs/maintenance/kb-maintenance-existing.md";
      const startedAt = Date.now() - 10_000;
      await writeReport(vaultPath, reportPath, [bravo]);

      const result = await evaluateDigestEvidence({
        vaultPath,
        reportPath,
        sources: [bravo],
        startedAt,
        transactionBefore,
        processedSourcesBeforeRun: {}
      });
      assert.deepEqual(result.verifiedSources.map((item) => item.relativePath), [bravo.relativePath]);
      assert.deepEqual(result.evidencePaths, {
        [bravo.relativePath]: [targetPath]
      });
      assert.deepEqual(result.pendingSources, []);

      const legacy = await verifyDigestEvidence({
        vaultPath,
        reportPath,
        sources: [bravo],
        startedAt,
        transactionBefore,
        processedSourcesBeforeRun: {}
      });
      assert.deepEqual(legacy, {
        [bravo.relativePath]: [targetPath]
      });
    } finally {
      await disposeKnowledgeTransactionSnapshot(transactionBefore);
    }
  });
}

async function assertGlobalPrerequisitesAreExplicit(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const alpha = source(vaultPath, "raw/articles/alpha.md");
    const reportPath = "outputs/maintenance/kb-maintenance-global.md";
    const missingReportResult = await evaluateDigestEvidence({
      vaultPath,
      reportPath,
      sources: [alpha],
      startedAt: Date.now() - 10_000,
      transactionBefore: emptySnapshot(vaultPath),
      processedSourcesBeforeRun: {}
    });
    assert.equal(missingReportResult.globalIssue?.code, "maintenance-report-missing");
    assert.equal(missingReportResult.pendingSources[0].reason.code, "maintenance-report-missing");

    const staleStartedAt = Date.now();
    await writeReport(vaultPath, reportPath, [alpha]);
    const staleTime = new Date(staleStartedAt - 60_000);
    await utimes(path.join(vaultPath, reportPath), staleTime, staleTime);
    const staleReportResult = await evaluateDigestEvidence({
      vaultPath,
      reportPath,
      sources: [alpha],
      startedAt: staleStartedAt,
      transactionBefore: emptySnapshot(vaultPath),
      processedSourcesBeforeRun: {}
    });
    assert.equal(staleReportResult.globalIssue?.code, "maintenance-report-missing");

    const snapshotStartedAt = Date.now() - 1_000;
    await writeReport(vaultPath, reportPath, [alpha]);
    const missingSnapshotResult = await evaluateDigestEvidence({
      vaultPath,
      reportPath,
      sources: [alpha],
      startedAt: snapshotStartedAt,
      transactionBefore: null,
      processedSourcesBeforeRun: {}
    });
    assert.equal(missingSnapshotResult.globalIssue?.code, "transaction-snapshot-missing");
    assert.equal(missingSnapshotResult.pendingSources[0].reason.code, "transaction-snapshot-missing");

    await assert.rejects(
      verifyDigestEvidence({
        vaultPath,
        reportPath,
        sources: [alpha],
        startedAt: snapshotStartedAt,
        transactionBefore: null,
        processedSourcesBeforeRun: {}
      }),
      /结构层消化证据/
    );
  });
}

async function assertEmptySourceCompatibility(): Promise<void> {
  await withTestVault(async (vaultPath) => {
    const input = {
      vaultPath,
      reportPath: "outputs/maintenance/unused.md",
      sources: [],
      startedAt: Date.now(),
      transactionBefore: null,
      processedSourcesBeforeRun: {}
    };
    assert.deepEqual(await evaluateDigestEvidence(input), {
      verifiedSources: [],
      evidencePaths: {},
      pendingSources: []
    });
    assert.deepEqual(await verifyDigestEvidence(input), {});
  });
}

function source(vaultPath: string, relativePath: string): KnowledgeBaseSource {
  return {
    relativePath,
    absolutePath: path.join(vaultPath, relativePath),
    size: 100,
    mtime: Date.now(),
    fingerprint: `fingerprint:${relativePath}`,
    mime: "text/markdown",
    modality: "text",
    changed: true
  };
}

function emptySnapshot(vaultPath: string): KnowledgeTransactionSnapshot {
  return {
    vaultPath,
    roots: ["wiki", "projects", "outputs"],
    entries: new Map()
  };
}

async function writeReport(
  vaultPath: string,
  reportPath: string,
  sources: KnowledgeBaseSource[]
): Promise<void> {
  await writeFileAt(vaultPath, reportPath, [
    "# KB Maintenance",
    "",
    "## 本轮来源",
    ...sources.map((item) => `- [[${withoutMarkdownExtension(item.relativePath)}]]`)
  ].join("\n"));
}

async function writeKnowledgePage(
  vaultPath: string,
  relativePath: string,
  sourceItem: KnowledgeBaseSource,
  digest: string
): Promise<void> {
  await writeFileAt(vaultPath, relativePath, [
    "## 关键结论",
    "",
    `- 来源：[[${withoutMarkdownExtension(sourceItem.relativePath)}]]`,
    `- ${digest}`
  ].join("\n"));
}

async function writeRepairableKnowledgePage(
  vaultPath: string,
  relativePath: string,
  sourceItem: KnowledgeBaseSource,
  digest: string
): Promise<void> {
  await writeFileAt(vaultPath, relativePath, [
    `> 来源：[[${withoutMarkdownExtension(sourceItem.relativePath)}]]`,
    "",
    "## 关键结论",
    "",
    `- ${digest}`
  ].join("\n"));
}

async function writeFileAt(vaultPath: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(vaultPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function withoutMarkdownExtension(relativePath: string): string {
  return relativePath.replace(/\.md$/i, "");
}

async function withTestVault(run: (vaultPath: string) => Promise<void>): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-maintenance-partial-evidence-"));
  try {
    await run(vaultPath);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}
