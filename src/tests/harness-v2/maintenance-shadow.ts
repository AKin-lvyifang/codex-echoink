import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createExactWriteFenceReceipt } from "../../agent/write-fence";
import type { AgentExactWriteFenceReceipt } from "../../agent/types";
import {
  maintenanceMarkdownUpdatedSuccessorEvidence
} from "../../harness/maintenance/markdown-metadata-successor";
import {
  MaintenanceShadowError,
  MaintenanceShadowSimulatedCrash,
  assertMaintenanceShadowZeroResultAttestation,
  attestMaintenanceShadowZeroResult,
  abandonMaintenanceShadowVault,
  applyShadowChangeSet,
  cleanupMaintenanceShadowVault,
  confirmMaintenanceShadowWriteFence,
  confirmMaintenanceShadowTransportConfigFence,
  createMaintenanceShadowVault,
  createMaintenanceShadowTransportConfigReceipt,
  isTrustedMaintenanceShadowQuarantineReceipt,
  isTrustedMaintenanceShadowZeroResultAttestation,
  maintenanceExactWriteFenceBindingDigest,
  maintenanceShadowExecutionBoundary,
  markMaintenanceShadowCommittedFromJournal,
  markMaintenanceShadowTerminal,
  quarantineMaintenanceShadowZeroResult,
  recoverMaintenanceShadowApplyTransactions,
  sealMaintenanceShadowVault,
  type CreateMaintenanceShadowOptions,
  type MaintenanceShadowErrorCode,
  type MaintenanceShadowHandle
} from "../../harness/maintenance/shadow-vault";

export async function runHarnessV2MaintenanceShadowTests(): Promise<void> {
  assertMarkdownMetadataSuccessorProofIsStrict();
  await assertShadowCopiesBytesAndAppliesFilteredChanges();
  await assertChunkedTextSourceViewsAreExactAndEphemeral();
  await assertInitialShadowCopyPreservesEvidenceTimes();
  await assertRawMutationFailsAndAbandonedShadowIsRetained();
  await assertTrackerAndRulesAreDeniedWhileReportIsWritable();
  await assertWritesOutsideMaintenanceRootsAreRejected();
  await assertCasConflictPreservesConcurrentLiveContent();
  await assertPersistentParentSymlinkFailsClosed();
  await assertReplacedParentDirectoryFailsClosed();
  await assertMissingParentThirdValueFailsClosed();
  await assertSameContentTargetReplacementFailsCas();
  await assertTransactionThirdValuesArePreserved();
  await assertCommittedCleanupThirdValueBlocksReplay();
  await assertCrashReplayIsIdempotent();
  await assertLaterConflictRollsBackEarlierFilesAndCreatedDirectories();
  await assertSealedBlobIgnoresLateShadowUpsert();
  await assertLateRecreatedShadowDeleteIsRejected();
  await assertLongUtf8FileNameUsesShortTransactionArtifacts();
  await assertUnsafeEntriesAndTraversalFailClosed();
  await assertPersistentPluginStorageIsAllowedButCopiedRootStorageIsDenied();
  await assertTransportConfigReceiptBindsAttemptAndEnablesProductionZeroResult();
  await assertClaimedDeniedProbeWriteFailsFence();
  await assertZeroResultRejectsLateShadowMutation();
  await assertInterruptedExclusiveInstallIsRecovered();
  await assertInterruptedInstallMetadataSuccessorHardlinkIsRecovered();
  await assertInterruptedInstallRejectsExternalHardlink();
  await assertInterruptedInstallAcceptsAtomicMetadataSuccessor();
  await assertInterruptedInstallPreservesConcurrentDeletion();
  await assertInterruptedNoClobberDisplacementIsRecovered();
  await assertMetadataSuccessorsCommitDirectly();
  await assertBlockedMetadataSuccessorsNeedCurrentAttemptAuthority();
  await assertDuplicateAttemptIdCannotDeferAnotherBlockedJournal();
  await assertManagedOverrideConsumesDurableMetadataSuccessorProof();
  await assertCleanupRequiresSafeTerminalState();
  await assertAbandonedChangeSetCannotApplyAfterReload();
  await assertApplyAndAbandonShareOneCommitAuthorityLock();
  await assertQuarantineRejectsForgeryLateWriteApplyAndCleanup();
}

function assertMarkdownMetadataSuccessorProofIsStrict(): void {
  const desired = Buffer.from(metadataMarkdown(
    "Strict",
    "2026-07-21T10:31:00.000Z",
    "BODY"
  ));
  const current = Buffer.from(metadataMarkdown(
    "Strict",
    "2026-07-21T10:35:00.000Z",
    "BODY"
  ));
  const window = {
    lowerBoundMs: Date.parse("2026-07-21T10:30:00.000Z"),
    upperBoundMs: Date.parse("2026-07-21T10:36:00.000Z")
  };
  const prove = (
    currentContent: Buffer,
    overrides: Partial<Parameters<
      typeof maintenanceMarkdownUpdatedSuccessorEvidence
    >[0]> = {}
  ) => maintenanceMarkdownUpdatedSuccessorEvidence({
    relativePath: "wiki/strict.md",
    desiredContent: desired,
    currentContent,
    desiredMode: 0o644,
    currentMode: 0o644,
    window,
    ...overrides
  });
  assert.ok(prove(current));
  for (const rejected of [
    current.toString("utf8").replace("BODY", "BODY DRIFT"),
    current.toString("utf8").replace("durable-proof", "changed-tag"),
    current.toString("utf8").replace("title: Strict", "title: Other"),
    current.toString("utf8").replace("tags:", "created: 2026-07-21\ntags:"),
    current.toString("utf8").replace(
      "updated: 2026-07-21T10:35:00.000Z",
      "updated: 2026-07-21T10:30:00.000Z"
    ),
    current.toString("utf8").replace(
      "updated: 2026-07-21T10:35:00.000Z",
      "updated: 2026-07-21T10:35:00.000Z\nupdated: 2026-07-21T10:35:00.000Z"
    )
  ]) {
    assert.equal(prove(Buffer.from(rejected)), null);
  }
  assert.equal(prove(current, { currentMode: 0o600 }), null);
  for (const relativePath of [
    "raw/source.md",
    "outputs/.ingest-tracker.md",
    "LLM-WIKI.md",
    "wiki/strict.txt"
  ]) {
    assert.equal(prove(current, { relativePath }), null);
  }
  assert.ok(prove(current, {
    relativePath: "raw/source.md",
    allowRawMetadata: true
  }));
  const reportDesired = Buffer.from(desired.toString("utf8").replace(
    "updated: 2026-07-21T10:31:00.000Z\n",
    ""
  ));
  assert.ok(prove(current, {
    relativePath: "outputs/maintenance/report.md",
    desiredContent: reportDesired,
    allowInsertedUpdated: true
  }));
  assert.equal(prove(current, {
    relativePath: "raw/source.md",
    desiredContent: reportDesired,
    allowInsertedUpdated: true,
    allowRawMetadata: true
  }), null, "Raw must never inherit the report insertion allowance");

  const normalizedReportDesired = Buffer.from(
    desired.toString("utf8").replace(
      "tags:\n  - durable-proof",
      "tags: [durable-proof]"
    )
  );
  assert.ok(prove(current, {
    relativePath: "outputs/maintenance/report.md",
    desiredContent: normalizedReportDesired
  }), "maintenance reports may preserve semantic YAML normalization");
  const sameMinuteCurrent = Buffer.from(
    normalizedReportDesired.toString("utf8").replace(
      "tags: [durable-proof]",
      "tags:\n  - durable-proof"
    )
  );
  assert.ok(prove(sameMinuteCurrent, {
    relativePath: "outputs/maintenance/report.md",
    desiredContent: normalizedReportDesired,
    currentContent: sameMinuteCurrent
  }), "maintenance reports may normalize tags without advancing a minute-resolution updated value");
  assert.equal(prove(normalizedReportDesired, {
    relativePath: "outputs/maintenance/report.md",
    desiredContent: normalizedReportDesired,
    currentContent: normalizedReportDesired
  }), null, "byte-identical reports are not metadata successors");
  for (const rejected of [
    current.toString("utf8").replace("durable-proof", "changed-tag"),
    current.toString("utf8").replace("BODY", "BODY DRIFT"),
    current.toString("utf8").replace(
      "title: Strict",
      "title: Strict\nsource: external"
    ),
    current.toString("utf8").replace(
      "tags:",
      "tags: [durable-proof]\ntags:"
    )
  ]) {
    assert.equal(prove(Buffer.from(rejected), {
      relativePath: "outputs/maintenance/report.md",
      desiredContent: normalizedReportDesired
    }), null);
  }
}

async function assertChunkedTextSourceViewsAreExactAndEphemeral(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const relativePath = "raw/source.md";
    const content = Buffer.from([
      "---",
      "title: 分块测试",
      "---",
      "第一段包含中文字符，必须保持 UTF-8 完整。",
      "第二段用于验证换行优先切分。",
      "第三段收口。",
      ""
    ].join("\n"), "utf8");
    await writeFile(path.join(vaultPath, relativePath), content);
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-chunked-text-source",
      storageRootPath: shadowStoragePath,
      requiredSourcePaths: [relativePath],
      chunkedTextSources: [{ relativePath, maxChunkBytes: 32 }]
    });
    const chunks = [...(handle.sourceChunks ?? [])]
      .sort((left, right) => left.index - right.index);
    assert.ok(chunks.length > 1);
    assert.deepEqual(
      chunks.map((chunk) => chunk.index),
      Array.from({ length: chunks.length }, (_, index) => index + 1)
    );
    const reconstructed = Buffer.concat(await Promise.all(
      chunks.map(async (chunk) => {
        assert.equal(chunk.sourceRelativePath, relativePath);
        assert.ok(chunk.size <= 32);
        const absolutePath = path.join(handle.agentVaultPath, chunk.relativePath);
        const stat = await lstat(absolutePath);
        assert.equal(stat.mode & 0o222, 0, "chunk views must be read-only");
        return await readFile(absolutePath);
      })
    ));
    assert.equal(reconstructed.equals(content), true);
    assert.equal(
      (await readFile(path.join(vaultPath, relativePath))).equals(content),
      true,
      "chunking must not rewrite the live Raw"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.equal(changeSet.structuralResult, "zero-result");
    await markMaintenanceShadowTerminal(handle, "noop");
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertInitialShadowCopyPreservesEvidenceTimes(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const rawPath = path.join(vaultPath, "raw/source.md");
    const wikiPath = path.join(vaultPath, "wiki/existing.md");
    const rawTime = new Date("2026-07-18T00:00:00.000Z");
    const wikiTime = new Date("2026-07-10T00:00:00.000Z");
    await utimes(rawPath, rawTime, rawTime);
    await utimes(wikiPath, wikiTime, wikiTime);
    const liveWikiBefore = await lstat(wikiPath);
    const liveRawBefore = await lstat(rawPath);

    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-preserve-evidence-times",
      storageRootPath: shadowStoragePath
    });
    const shadowWiki = await lstat(
      path.join(handle.agentVaultPath, "wiki/existing.md")
    );
    const shadowRaw = await lstat(
      path.join(handle.agentVaultPath, "raw/source.md")
    );
    assert.ok(
      Math.abs(shadowWiki.mtimeMs - liveWikiBefore.mtimeMs) < 1,
      "initial Shadow Wiki copy must retain live evidence mtime"
    );
    assert.ok(
      Math.abs(shadowWiki.atimeMs - liveWikiBefore.atimeMs) < 1,
      "initial Shadow Wiki copy must retain live evidence atime"
    );
    assert.ok(
      Math.abs(shadowRaw.mtimeMs - liveRawBefore.mtimeMs) < 1,
      "initial Shadow Raw copy must retain source mtime"
    );
    assert.ok(
      shadowWiki.mtimeMs < shadowRaw.mtimeMs,
      "an older Wiki evidence file must remain older than its Raw source"
    );

    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.equal(changeSet.structuralResult, "zero-result");
    await markMaintenanceShadowTerminal(handle, "noop");
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertShadowCopiesBytesAndAppliesFilteredChanges(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-main",
      storageRootPath: shadowStoragePath,
      requiredSourcePaths: ["outputs/.ingest-tracker.md"]
    });

    assert.equal(await readFile(path.join(handle.agentVaultPath, "raw/source.md"), "utf8"), "RAW-CONTENT\n");
    assert.equal(await readFile(path.join(handle.agentVaultPath, "LLM-WIKI.md"), "utf8"), "# Rules\n");
    const liveRawStat = await lstat(path.join(vaultPath, "raw/source.md"));
    const shadowRawStat = await lstat(path.join(handle.agentVaultPath, "raw/source.md"));
    assert.notEqual(`${liveRawStat.dev}:${liveRawStat.ino}`, `${shadowRawStat.dev}:${shadowRawStat.ino}`);
    assert.equal(shadowRawStat.nlink, 1);

    await writeFile(path.join(handle.agentVaultPath, "wiki/existing.md"), "WIKI-UPDATED\n", "utf8");
    await writeFile(path.join(handle.agentVaultPath, "wiki/new.md"), "WIKI-NEW\n", "utf8");
    await rm(path.join(handle.agentVaultPath, "projects/old.md"));

    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.deepEqual(
      changeSet.changes.map((change) => `${change.operation}:${change.relativePath}`),
      ["delete:projects/old.md", "upsert:wiki/existing.md", "upsert:wiki/new.md"]
    );
    assert.deepEqual(changeSet.excludedPluginOwnedPaths, []);
    assert.equal(changeSet.structuralResult, "committable");
    assert.match(changeSet.baselineDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(changeSet.changes[1]?.expectedLive.kind, "file");

    const result = await applyShadowChangeSet(vaultPath, changeSet, {
      allowPaths: ["wiki/existing.md", "wiki/new.md"]
    });
    assert.deepEqual(result.appliedPaths, ["wiki/existing.md", "wiki/new.md"]);
    assert.deepEqual(result.skippedPaths, ["projects/old.md"]);
    assert.equal(await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"), "WIKI-UPDATED\n");
    assert.equal(await readFile(path.join(vaultPath, "wiki/new.md"), "utf8"), "WIKI-NEW\n");
    assert.equal(await readFile(path.join(vaultPath, "projects/old.md"), "utf8"), "PROJECT-OLD\n");
    assert.equal(await readFile(path.join(vaultPath, "raw/source.md"), "utf8"), "RAW-CONTENT\n");
    assert.equal(await readFile(path.join(vaultPath, "outputs/.ingest-tracker.md"), "utf8"), "TRACKER\n");
    assert.equal((await lstat(path.join(vaultPath, "wiki/existing.md"))).nlink, 1);
    assert.equal((await lstat(path.join(vaultPath, "wiki/new.md"))).nlink, 1);
    assert.deepEqual(
      (await readdir(path.join(vaultPath, "wiki")))
        .filter((name) => name.startsWith(".echoink-txn-")),
      []
    );

    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: result.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
    await assert.rejects(() => lstat(handle.rootPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
}

async function assertRawMutationFailsAndAbandonedShadowIsRetained(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-raw",
      storageRootPath: shadowStoragePath
    });
    const rawPath = path.join(handle.agentVaultPath, "raw/source.md");
    await chmod(path.dirname(rawPath), 0o755);
    await chmod(rawPath, 0o644);
    await writeFile(rawPath, "MALICIOUS-RAW-CHANGE\n", "utf8");

    await rejectsWithCode(() => sealMaintenanceShadowVault(handle), "raw_modified");
    await abandonMaintenanceShadowVault(handle, "late Agent may still be writing");
    await rejectsWithCode(() => cleanupMaintenanceShadowVault(handle), "invalid_state");
    assert.equal((await lstat(handle.rootPath)).isDirectory(), true);
    assert.equal(await readFile(path.join(vaultPath, "raw/source.md"), "utf8"), "RAW-CONTENT\n");

    await markMaintenanceShadowTerminal(handle, "discarded", { abandonedAgentFenced: true });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertTrackerAndRulesAreDeniedWhileReportIsWritable(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const trackerAttempt = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-tracker-deny",
      storageRootPath: shadowStoragePath,
      requiredSourcePaths: ["outputs/.ingest-tracker.md"]
    });
    const trackerPath = path.join(trackerAttempt.agentVaultPath, "outputs/.ingest-tracker.md");
    await chmod(trackerPath, 0o644);
    await writeFile(trackerPath, "ILLEGAL-TRACKER\n", "utf8");
    await rejectsWithCode(() => sealMaintenanceShadowVault(trackerAttempt), "readonly_modified");
    await abandonMaintenanceShadowVault(trackerAttempt, "tracker deny regression");
    await markMaintenanceShadowTerminal(trackerAttempt, "discarded", { abandonedAgentFenced: true });
    await cleanupMaintenanceShadowVault(trackerAttempt);

    const rulesAttempt = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-rules-deny",
      storageRootPath: shadowStoragePath
    });
    const rulesPath = path.join(rulesAttempt.agentVaultPath, "LLM-WIKI.md");
    await chmod(rulesPath, 0o644);
    await writeFile(rulesPath, "# ILLEGAL RULES\n", "utf8");
    await rejectsWithCode(() => sealMaintenanceShadowVault(rulesAttempt), "readonly_modified");
    await abandonMaintenanceShadowVault(rulesAttempt, "rules deny regression");
    await markMaintenanceShadowTerminal(rulesAttempt, "discarded", { abandonedAgentFenced: true });
    await cleanupMaintenanceShadowVault(rulesAttempt);

    const reportAttempt = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-report-allow",
      storageRootPath: shadowStoragePath
    });
    const reportPath = path.join(reportAttempt.agentVaultPath, "outputs/maintenance/report.md");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, "# Verified report\n", "utf8");
    const reportChangeSet = await sealMaintenanceShadowVault(reportAttempt);
    assert.deepEqual(
      reportChangeSet.changes.map((change) => change.relativePath),
      ["outputs/maintenance/report.md"]
    );
    await markMaintenanceShadowTerminal(reportAttempt, "discarded");
    await cleanupMaintenanceShadowVault(reportAttempt);
  });
}

async function assertWritesOutsideMaintenanceRootsAreRejected(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-rogue-output",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, "rogue.md"), "OUTSIDE-WRITABLE-ROOTS\n", "utf8");
    await rejectsWithCode(() => sealMaintenanceShadowVault(handle), "write_outside_allowed_paths");
    await abandonMaintenanceShadowVault(handle, "Agent wrote outside maintenance roots");
    await markMaintenanceShadowTerminal(handle, "discarded", { abandonedAgentFenced: true });
    await cleanupMaintenanceShadowVault(handle);
    await assert.rejects(() => lstat(path.join(vaultPath, "rogue.md")));
  });
}

async function assertCasConflictPreservesConcurrentLiveContent(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-cas",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, "wiki/existing.md"), "SHADOW-VERSION\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);

    await writeFile(path.join(vaultPath, "wiki/existing.md"), "CONCURRENT-LIVE-VERSION\n", "utf8");
    await rejectsWithCode(() => applyShadowChangeSet(vaultPath, changeSet), "cas_conflict");
    assert.equal(await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"), "CONCURRENT-LIVE-VERSION\n");

    await markMaintenanceShadowTerminal(handle, "discarded");
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertPersistentParentSymlinkFailsClosed(): Promise<void> {
  await withFixture(async ({ rootPath, vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-parent-symlink",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, "wiki/existing.md"),
      "SHADOW-SYMLINK-RESULT\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    const originalWikiPath = path.join(rootPath, "wiki-original");
    const outsidePath = path.join(rootPath, "outside");
    const liveWikiPath = path.join(vaultPath, "wiki");
    await rename(liveWikiPath, originalWikiPath);
    await mkdir(outsidePath);
    await writeFile(path.join(outsidePath, "existing.md"), "OUTSIDE-SENTINEL\n", "utf8");
    await symlink(outsidePath, liveWikiPath);

    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet),
      "unsafe_entry"
    );
    assert.equal(
      await readFile(path.join(outsidePath, "existing.md"), "utf8"),
      "OUTSIDE-SENTINEL\n"
    );

    await rm(liveWikiPath);
    await rename(originalWikiPath, liveWikiPath);
    await markMaintenanceShadowTerminal(handle, "discarded");
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertReplacedParentDirectoryFailsClosed(): Promise<void> {
  await withFixture(async ({ rootPath, vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-parent-replaced",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, "wiki/existing.md"),
      "SHADOW-PARENT-RESULT\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    const liveWikiPath = path.join(vaultPath, "wiki");
    const originalWikiPath = path.join(rootPath, "wiki-original-directory");
    await rename(liveWikiPath, originalWikiPath);
    await mkdir(liveWikiPath);
    await writeFile(path.join(liveWikiPath, "existing.md"), "WIKI-OLD\n", "utf8");

    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet),
      "unsafe_entry"
    );
    assert.equal(
      await readFile(path.join(liveWikiPath, "existing.md"), "utf8"),
      "WIKI-OLD\n"
    );

    await rm(liveWikiPath, { recursive: true });
    await rename(originalWikiPath, liveWikiPath);
    await markMaintenanceShadowTerminal(handle, "discarded");
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertSameContentTargetReplacementFailsCas(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-target-inode-replaced",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, "wiki/existing.md"),
      "SHADOW-TARGET-RESULT\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    const targetPath = path.join(vaultPath, "wiki/existing.md");
    const replacementPath = path.join(vaultPath, "wiki/.same-content-replacement.md");
    await writeFile(replacementPath, "WIKI-OLD\n", "utf8");
    await rename(replacementPath, targetPath);

    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet),
      "cas_conflict"
    );
    assert.equal(await readFile(targetPath, "utf8"), "WIKI-OLD\n");

    await markMaintenanceShadowTerminal(handle, "discarded");
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertMissingParentThirdValueFailsClosed(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-missing-parent-third",
      storageRootPath: shadowStoragePath
    });
    const resultPath = path.join(
      handle.agentVaultPath,
      "projects/concurrent/nested/result.md"
    );
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(resultPath, "SHADOW-NESTED-RESULT\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);
    const concurrentParent = path.join(vaultPath, "projects/concurrent");

    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: async () => {
          await mkdir(concurrentParent);
          await writeFile(
            path.join(concurrentParent, "third.md"),
            "CONCURRENT-PARENT-THIRD\n",
            "utf8"
          );
        }
      }),
      "cas_conflict"
    );
    assert.equal(
      await readFile(path.join(concurrentParent, "third.md"), "utf8"),
      "CONCURRENT-PARENT-THIRD\n"
    );
    await assert.rejects(
      () => lstat(path.join(concurrentParent, "nested/result.md")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  });
}

async function assertTransactionThirdValuesArePreserved(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-third-temp",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, "wiki/existing.md"),
      "SHADOW-TEMP-RESULT\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    let tempPath = "";
    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: async () => {
          const paths = await readFirstTransactionPaths(handle);
          assert.ok(paths.installTempRelativePath);
          tempPath = path.join(
            vaultPath,
            ...paths.installTempRelativePath.split("/")
          );
          await writeFile(tempPath, "THIRD-TEMP\n", "utf8");
        }
      }),
      "cas_conflict"
    );
    assert.equal(await readFile(tempPath, "utf8"), "THIRD-TEMP\n");
    assert.equal(
      await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"),
      "WIKI-OLD\n"
    );
  });

  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-third-displaced",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, "wiki/existing.md"),
      "SHADOW-DISPLACED-RESULT\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    let displacedPath = "";
    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: async () => {
          const paths = await readFirstTransactionPaths(handle);
          assert.ok(paths.displacedLiveRelativePath);
          displacedPath = path.join(
            vaultPath,
            ...paths.displacedLiveRelativePath.split("/")
          );
          await writeFile(displacedPath, "THIRD-DISPLACED\n", "utf8");
        }
      }),
      "cas_conflict"
    );
    assert.equal(
      await readFile(displacedPath, "utf8"),
      "THIRD-DISPLACED\n"
    );
    assert.equal(
      await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"),
      "WIKI-OLD\n"
    );
  });
}

async function assertCommittedCleanupThirdValueBlocksReplay(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-committed-cleanup-third",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, "wiki/existing.md"),
      "COMMITTED-RESULT\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        faultInjector: ({ point }) => {
          if (point === "after-journal-commit") {
            throw new MaintenanceShadowSimulatedCrash(
              "crash before committed displacement cleanup"
            );
          }
        }
      }),
      (error: unknown) => error instanceof MaintenanceShadowSimulatedCrash
    );

    const paths = await readFirstTransactionPaths(handle);
    assert.ok(paths.displacedLiveRelativePath);
    const displacedPath = path.join(
      vaultPath,
      ...paths.displacedLiveRelativePath.split("/")
    );
    await rm(displacedPath);
    await writeFile(displacedPath, "COMMITTED-CLEANUP-THIRD\n", "utf8");

    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet),
      "cas_conflict"
    );
    assert.equal(
      await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"),
      "COMMITTED-RESULT\n"
    );
    assert.equal(
      await readFile(displacedPath, "utf8"),
      "COMMITTED-CLEANUP-THIRD\n"
    );
    const journal = JSON.parse(
      await readFile(path.join(handle.rootPath, "apply-journal/journal.json"), "utf8")
    ) as { state: string };
    assert.equal(journal.state, "blocked");
  });
}

async function assertCrashReplayIsIdempotent(): Promise<void> {
  await assertCrashReplayAt("after-entry");
  await assertCrashReplayAt("after-journal-commit");
}

async function assertCrashReplayAt(
  point: "after-entry" | "after-journal-commit"
): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: `attempt-crash-replay-${point}`,
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, "wiki/existing.md"),
      `RESULT-${point}\n`,
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        faultInjector: (input) => {
          if (input.point === point) {
            throw new MaintenanceShadowSimulatedCrash(`crash at ${point}`);
          }
        }
      }),
      (error: unknown) => error instanceof MaintenanceShadowSimulatedCrash
    );

    const replay = await applyShadowChangeSet(vaultPath, changeSet);
    const replayAgain = await applyShadowChangeSet(vaultPath, changeSet);
    assert.equal(replayAgain.commitReceipt, replay.commitReceipt);
    assert.equal(
      await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"),
      `RESULT-${point}\n`
    );
    assert.deepEqual(
      (await readdir(path.join(vaultPath, "wiki")))
        .filter((name) => name.startsWith(".echoink-txn-")),
      []
    );

    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: replay.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertLaterConflictRollsBackEarlierFilesAndCreatedDirectories(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:2",
      storageRootPath: shadowStoragePath
    });
    const nestedShadowPath = path.join(handle.agentVaultPath, "projects/new/nested/result.md");
    await mkdir(path.dirname(nestedShadowPath), { recursive: true });
    await writeFile(nestedShadowPath, "NEW-NESTED\n", "utf8");
    await writeFile(path.join(handle.agentVaultPath, "projects/old.md"), "PROJECT-SHADOW\n", "utf8");
    await writeFile(path.join(handle.agentVaultPath, "wiki/existing.md"), "WIKI-SHADOW\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);

    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: async ({ relativePath }) => {
          if (relativePath === "wiki/existing.md") {
            await writeFile(path.join(vaultPath, relativePath), "WIKI-CONCURRENT\n", "utf8");
          }
        }
      }),
      "cas_conflict"
    );
    assert.equal(await readFile(path.join(vaultPath, "projects/old.md"), "utf8"), "PROJECT-OLD\n");
    assert.equal(await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"), "WIKI-CONCURRENT\n");
    await assert.rejects(() => lstat(path.join(vaultPath, "projects/new")));
    const transactionArtifacts = [
      ...(await readdir(path.join(vaultPath, "projects"))),
      ...(await readdir(path.join(vaultPath, "wiki")))
    ].filter((name) => name.startsWith(".echoink-txn-"));
    assert.deepEqual(transactionArtifacts, []);

    await rejectsWithCode(
      () => markMaintenanceShadowTerminal(handle, "discarded"),
      "invalid_state"
    );
    await rejectsWithCode(() => cleanupMaintenanceShadowVault(handle), "invalid_state");
  });
}

async function assertSealedBlobIgnoresLateShadowUpsert(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-seal-race",
      storageRootPath: shadowStoragePath
    });
    const shadowWikiPath = path.join(handle.agentVaultPath, "wiki/existing.md");
    await writeFile(shadowWikiPath, "SEALED-VERSION\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);

    await chmod(path.dirname(shadowWikiPath), 0o755);
    await chmod(shadowWikiPath, 0o644);
    await writeFile(shadowWikiPath, "LATE-ZOMBIE-VERSION\n", "utf8");
    const result = await applyShadowChangeSet(vaultPath, changeSet);
    assert.equal(await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"), "SEALED-VERSION\n");

    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: result.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertLateRecreatedShadowDeleteIsRejected(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-delete-race",
      storageRootPath: shadowStoragePath
    });
    const shadowProjectPath = path.join(handle.agentVaultPath, "projects/old.md");
    await rm(shadowProjectPath);
    const changeSet = await sealMaintenanceShadowVault(handle);
    await chmod(path.dirname(shadowProjectPath), 0o755);
    await writeFile(shadowProjectPath, "LATE-RECREATED\n", "utf8");

    await rejectsWithCode(() => applyShadowChangeSet(vaultPath, changeSet), "source_changed");
    assert.equal(await readFile(path.join(vaultPath, "projects/old.md"), "utf8"), "PROJECT-OLD\n");
    await abandonMaintenanceShadowVault(handle, "post-seal delete race");
    await markMaintenanceShadowTerminal(handle, "discarded", { abandonedAgentFenced: true });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertLongUtf8FileNameUsesShortTransactionArtifacts(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const fileName = `${"长".repeat(70)}.md`;
    const relativePath = `wiki/${fileName}`;
    await writeFile(path.join(vaultPath, relativePath), "LONG-BASELINE\n", "utf8");
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:long-name",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, relativePath), "LONG-UPDATED\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);
    const result = await applyShadowChangeSet(vaultPath, changeSet, { allowPaths: [relativePath] });
    assert.equal(await readFile(path.join(vaultPath, relativePath), "utf8"), "LONG-UPDATED\n");
    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: result.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertUnsafeEntriesAndTraversalFailClosed(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    await assert.rejects(
      () => createMaintenanceShadowVault({
        liveVaultPath: vaultPath,
        attemptId: "attempt-traversal",
        storageRootPath: shadowStoragePath,
        requiredSourcePaths: ["../outside.md"]
      }),
      (error: unknown) => isMaintenanceShadowError(error, "invalid_path")
    );

    await symlink(path.join(vaultPath, "wiki/existing.md"), path.join(vaultPath, "raw/linked.md"));
    await rejectsWithCode(
      () => createMaintenanceShadowVault({
        liveVaultPath: vaultPath,
        attemptId: "attempt-symlink",
        storageRootPath: shadowStoragePath
      }),
      "unsafe_entry"
    );
    await rm(path.join(vaultPath, "raw/linked.md"));

    await link(path.join(vaultPath, "raw/source.md"), path.join(vaultPath, "raw/hardlink.md"));
    await rejectsWithCode(
      () => createMaintenanceShadowVault({
        liveVaultPath: vaultPath,
        attemptId: "attempt-hardlink",
        storageRootPath: shadowStoragePath
      }),
      "unsafe_entry"
    );
    await rm(path.join(vaultPath, "raw/hardlink.md"));

    if (process.platform !== "win32") {
      const fifoPath = path.join(vaultPath, "raw/special.fifo");
      try {
        execFileSync("mkfifo", [fifoPath]);
        await rejectsWithCode(
          () => createMaintenanceShadowVault({
            liveVaultPath: vaultPath,
            attemptId: "attempt-special",
            storageRootPath: shadowStoragePath
          }),
          "unsafe_entry"
        );
      } finally {
        await rm(fifoPath, { force: true });
      }
    }
  });
}

async function assertPersistentPluginStorageIsAllowedButCopiedRootStorageIsDenied(): Promise<void> {
  await withFixture(async ({ vaultPath }) => {
    const pluginStoragePath = path.join(
      vaultPath,
      ".obsidian/plugins/codex-echoink/maintenance-shadows"
    );
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:persistent",
      storageRootPath: pluginStoragePath
    });
    assert.match(handle.rootPath, /\/\.obsidian\/plugins\/codex-echoink\/maintenance-shadows\//);
    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.equal(changeSet.structuralResult, "zero-result");
    await markMaintenanceShadowTerminal(handle, "noop");
    await cleanupMaintenanceShadowVault(handle);

    await rejectsWithCode(
      () => createMaintenanceShadowVault({
        liveVaultPath: vaultPath,
        attemptId: "workflow:attempt:recursive-storage",
        storageRootPath: path.join(vaultPath, "wiki/.maintenance-shadows")
      }),
      "invalid_path"
    );
  });
}

async function assertTransportConfigReceiptBindsAttemptAndEnablesProductionZeroResult(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createMaintenanceShadowVault({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:transport",
      storageRootPath: shadowStoragePath
    });
    const boundary = await maintenanceShadowExecutionBoundary(handle);
    const wrongAttemptReceipt = createMaintenanceShadowTransportConfigReceipt({
      backend: "codex",
      attemptId: "workflow:attempt:other",
      leaseId: "lease-other",
      enforcedWritableRootPaths: boundary.writableRootPaths,
      enforcedDeniedShadowPaths: boundary.deniedPaths,
      deniedLiveVaultPath: vaultPath,
      deniedControlPath: boundary.deniedParentPath,
      transportAck: "sandbox-policy-installed",
      transportConfigDigest: sha256Text("wrong transport config")
    });
    await rejectsWithCode(
      () => confirmMaintenanceShadowTransportConfigFence(handle, vaultPath, wrongAttemptReceipt),
      "invalid_state"
    );

    const receipt = createMaintenanceShadowTransportConfigReceipt({
      backend: "codex",
      attemptId: handle.attemptId,
      leaseId: "lease-transport-1",
      enforcedWritableRootPaths: boundary.writableRootPaths,
      enforcedDeniedShadowPaths: boundary.deniedPaths,
      deniedLiveVaultPath: vaultPath,
      deniedControlPath: boundary.deniedParentPath,
      transportAck: "sandbox-policy-installed",
      transportConfigDigest: sha256Text("exact transport config")
    });
    const handFilledClone = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
    await rejectsWithCode(
      () => confirmMaintenanceShadowTransportConfigFence(handle, vaultPath, handFilledClone),
      "invalid_state"
    );
    await confirmMaintenanceShadowTransportConfigFence(handle, vaultPath, receipt);
    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.equal(changeSet.structuralResult, "zero-result");
    const attestation = await attestMaintenanceShadowZeroResult(handle, vaultPath);
    assert.equal(isTrustedMaintenanceShadowZeroResultAttestation(attestation), true);
    assert.equal(
      isTrustedMaintenanceShadowZeroResultAttestation({ ...attestation }),
      false,
      "spread clone must not preserve issuer trust"
    );
    assert.equal(
      isTrustedMaintenanceShadowZeroResultAttestation(JSON.parse(JSON.stringify(attestation))),
      false,
      "JSON clone must not preserve issuer trust"
    );
    const prototypeClone = Object.assign(
      Object.create(Object.getPrototypeOf(attestation)),
      { ...attestation }
    );
    assert.equal(
      isTrustedMaintenanceShadowZeroResultAttestation(prototypeClone),
      false,
      "forged prototype chain must not preserve issuer trust"
    );
    await assertMaintenanceShadowZeroResultAttestation(handle, vaultPath, attestation);
    await markMaintenanceShadowTerminal(handle, "noop");
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertClaimedDeniedProbeWriteFailsFence(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createMaintenanceShadowVault({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:false-deny",
      storageRootPath: shadowStoragePath
    });
    const boundary = await maintenanceShadowExecutionBoundary(handle);
    await rejectsWithCode(
      () => confirmMaintenanceShadowWriteFence(handle, vaultPath, async (challenge) => {
        await writeFile(challenge.writableShadowProbePath, challenge.token, "utf8");
        const deniedCreationProbe = challenge.deniedWriteProbePaths.find((entry) =>
          path.basename(entry).startsWith(".echoink-denied-fence-")
        );
        assert.ok(deniedCreationProbe);
        await chmod(path.dirname(deniedCreationProbe), 0o755);
        await writeFile(deniedCreationProbe, "ACTUALLY-WRITABLE\n", "utf8");
        return {
          backend: "lying-test-runtime",
          evidence: "claimed denied although a probe was created",
          opaqueReceipt: `lying-receipt:${challenge.token}`,
          enforcedWritableRootPaths: boundary.writableRootPaths,
          enforcedDeniedPaths: boundary.deniedPaths,
          deniedProbeAttempts: challenge.deniedWriteProbePaths.map((probePath) => ({
            path: probePath,
            outcome: "denied" as const,
            errorCode: "EACCES"
          }))
        };
      }),
      "source_changed"
    );
    await abandonMaintenanceShadowVault(handle, "false denied probe regression");
    await markMaintenanceShadowTerminal(handle, "discarded", { abandonedAgentFenced: true });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertZeroResultRejectsLateShadowMutation(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:late-zero-result",
      storageRootPath: shadowStoragePath
    });
    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.equal(changeSet.structuralResult, "zero-result");
    await chmod(path.join(handle.agentVaultPath, "wiki"), 0o755);
    await writeFile(path.join(handle.agentVaultPath, "wiki/late-zombie.md"), "LATE\n", "utf8");
    await rejectsWithCode(
      () => attestMaintenanceShadowZeroResult(handle, vaultPath),
      "source_changed"
    );
    await abandonMaintenanceShadowVault(handle, "late Shadow mutation");
    await markMaintenanceShadowTerminal(handle, "discarded", { abandonedAgentFenced: true });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertInterruptedExclusiveInstallIsRecovered(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:install-crash",
      storageRootPath: shadowStoragePath
    });
    const relativePath = "wiki/crash-result.md";
    await writeFile(path.join(handle.agentVaultPath, relativePath), "CRASH-RESULT\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: () => {
          throw new Error("fault before install");
        }
      }),
      /fault before install/
    );

    const journalPath = path.join(handle.rootPath, "apply-journal/journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
      updatedAt: string;
      error?: string;
      digest: string;
      entries: Array<{ installTempRelativePath?: string }>;
      [key: string]: unknown;
    };
    const installTempRelativePath = journal.entries[0]?.installTempRelativePath;
    assert.ok(installTempRelativePath);
    journal.state = "applying";
    journal.updatedAt = new Date().toISOString();
    delete journal.error;
    const { digest: _oldDigest, ...journalWithoutDigest } = journal;
    journal.digest = digestForTest(journalWithoutDigest);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    const tempPath = path.join(vaultPath, ...installTempRelativePath.split("/"));
    const targetPath = path.join(vaultPath, ...relativePath.split("/"));
    await writeFile(tempPath, "CRASH-RESULT\n", "utf8");
    await link(tempPath, targetPath);
    assert.equal((await lstat(targetPath)).nlink, 2);

    await recoverMaintenanceShadowApplyTransactions(vaultPath, shadowStoragePath);
    assert.equal(await readFile(targetPath, "utf8"), "CRASH-RESULT\n");
    assert.equal((await lstat(targetPath)).nlink, 1);
    await assert.rejects(() => lstat(tempPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const result = await applyShadowChangeSet(vaultPath, changeSet);
    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: result.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertInterruptedInstallMetadataSuccessorHardlinkIsRecovered(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const relativePath = "wiki/metadata-hardlink-crash.md";
    const desiredUpdated = new Date(Date.now() - 60_000).toISOString();
    const observedUpdated = new Date().toISOString();
    const desired = metadataMarkdown("Hardlink crash", desiredUpdated, "NEW");
    const observed = metadataMarkdown("Hardlink crash", observedUpdated, "NEW");
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Hardlink crash", desiredUpdated, "OLD"),
      "utf8"
    );
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:metadata-hardlink-crash",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, relativePath), desired, "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);
    const targetPath = path.join(vaultPath, relativePath);

    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        async faultInjector(input) {
          if (
            input.point !== "after-install-link"
            || input.relativePath !== relativePath
          ) return;
          await writeFile(targetPath, observed, "utf8");
          assert.equal(
            (await lstat(targetPath)).nlink,
            2,
            "metadata successor must reproduce while target and install temp share one inode"
          );
          throw new MaintenanceShadowSimulatedCrash(
            "crash after in-place metadata successor during install hardlink window"
          );
        }
      }),
      (error: unknown) => error instanceof MaintenanceShadowSimulatedCrash
    );

    const transactionPaths = await readFirstTransactionPaths(handle);
    assert.ok(transactionPaths.installTempRelativePath);
    const tempPath = path.join(
      vaultPath,
      ...transactionPaths.installTempRelativePath.split("/")
    );
    const interruptedTarget = await lstat(targetPath);
    const interruptedTemp = await lstat(tempPath);
    assert.equal(interruptedTarget.nlink, 2);
    assert.equal(interruptedTemp.nlink, 2);
    assert.equal(interruptedTarget.dev, interruptedTemp.dev);
    assert.equal(interruptedTarget.ino, interruptedTemp.ino);
    assert.equal(await readFile(tempPath, "utf8"), observed);

    const recovered = await applyShadowChangeSet(vaultPath, changeSet);
    assert.ok(recovered.commitReceipt);
    assert.equal(await readFile(targetPath, "utf8"), observed);
    assert.equal((await lstat(targetPath)).nlink, 1);
    await assert.rejects(
      () => lstat(tempPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
    const journal = JSON.parse(await readFile(
      path.join(handle.rootPath, "apply-journal/journal.json"),
      "utf8"
    )) as {
      state: string;
      metadataSuccessors?: Array<{ relativePath: string }>;
    };
    assert.equal(journal.state, "committed");
    assert.deepEqual(
      journal.metadataSuccessors?.map((proof) => proof.relativePath),
      [relativePath]
    );

    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: recovered.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertInterruptedInstallRejectsExternalHardlink(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const relativePath = "wiki/external-hardlink-crash.md";
    const targetPath = path.join(vaultPath, relativePath);
    const externalPath = path.join(vaultPath, "wiki/external-hardlink.md");
    await writeFile(targetPath, "EXTERNAL-HARDLINK-OLD\n", "utf8");
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:external-hardlink-crash",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, relativePath),
      "EXTERNAL-HARDLINK-NEW\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);

    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        async faultInjector(input) {
          if (
            input.point !== "after-install-link"
            || input.relativePath !== relativePath
          ) return;
          await link(targetPath, externalPath);
          assert.equal((await lstat(targetPath)).nlink, 3);
          throw new MaintenanceShadowSimulatedCrash(
            "crash after an external hardlink joined the install inode"
          );
        }
      }),
      (error: unknown) => error instanceof MaintenanceShadowSimulatedCrash
    );

    const transactionPaths = await readFirstTransactionPaths(handle);
    assert.ok(transactionPaths.installTempRelativePath);
    const tempPath = path.join(
      vaultPath,
      ...transactionPaths.installTempRelativePath.split("/")
    );
    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet),
      "cas_conflict"
    );
    const [target, temp, external] = await Promise.all([
      lstat(targetPath),
      lstat(tempPath),
      lstat(externalPath)
    ]);
    assert.equal(target.nlink, 3);
    assert.equal(temp.nlink, 3);
    assert.equal(external.nlink, 3);
    assert.equal(target.dev, temp.dev);
    assert.equal(target.ino, temp.ino);
    assert.equal(target.dev, external.dev);
    assert.equal(target.ino, external.ino);
    assert.equal(await readFile(targetPath, "utf8"), "EXTERNAL-HARDLINK-NEW\n");
    const journal = JSON.parse(await readFile(
      path.join(handle.rootPath, "apply-journal/journal.json"),
      "utf8"
    )) as { state: string };
    assert.equal(journal.state, "blocked");
  });
}

async function assertInterruptedInstallAcceptsAtomicMetadataSuccessor(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const relativePath = "wiki/atomic-metadata-result.md";
    const desiredUpdated = new Date(Date.now() - 60_000).toISOString();
    const observedUpdated = new Date().toISOString();
    const desired = metadataMarkdown("Atomic install", desiredUpdated, "NEW");
    const observed = metadataMarkdown("Atomic install", observedUpdated, "NEW");
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Atomic install", desiredUpdated, "OLD"),
      "utf8"
    );
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:atomic-metadata-install-crash",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, relativePath), desired, "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: () => {
          throw new Error("fault before atomic metadata install");
        }
      }),
      /fault before atomic metadata install/
    );

    const journalPath = path.join(handle.rootPath, "apply-journal/journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
      updatedAt: string;
      error?: string;
      digest: string;
      entries: Array<{
        installTempRelativePath?: string;
        displacedLiveRelativePath?: string;
      }>;
      [key: string]: unknown;
    };
    const installTempRelativePath = journal.entries[0]?.installTempRelativePath;
    const displacedLiveRelativePath =
      journal.entries[0]?.displacedLiveRelativePath;
    assert.ok(installTempRelativePath);
    assert.ok(displacedLiveRelativePath);
    journal.state = "applying";
    journal.updatedAt = new Date().toISOString();
    delete journal.error;
    const { digest: _oldDigest, ...journalWithoutDigest } = journal;
    journal.digest = digestForTest(journalWithoutDigest);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    const tempPath = path.join(vaultPath, ...installTempRelativePath.split("/"));
    const targetPath = path.join(vaultPath, ...relativePath.split("/"));
    const displacedPath = path.join(
      vaultPath,
      ...displacedLiveRelativePath.split("/")
    );
    await link(targetPath, displacedPath);
    await rm(targetPath);
    await writeFile(tempPath, desired, "utf8");
    await link(tempPath, targetPath);
    const replacementPath = `${targetPath}.obsidian-replacement`;
    await writeFile(replacementPath, observed, "utf8");
    await rename(replacementPath, targetPath);
    assert.equal((await lstat(tempPath)).nlink, 1);

    const result = await applyShadowChangeSet(vaultPath, changeSet);
    assert.ok(result.commitReceipt);
    assert.equal(await readFile(targetPath, "utf8"), observed);
    await assert.rejects(
      () => lstat(tempPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
    await markMaintenanceShadowCommittedFromJournal(handle, vaultPath);
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertInterruptedInstallPreservesConcurrentDeletion(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const relativePath = "wiki/deleted-install-result.md";
    const desiredUpdated = new Date(Date.now() - 60_000).toISOString();
    const observedUpdated = new Date().toISOString();
    const desired = metadataMarkdown("Deleted install", desiredUpdated, "NEW");
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Deleted install", desiredUpdated, "OLD"),
      "utf8"
    );
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:deleted-metadata-install",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, relativePath), desired, "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: () => {
          throw new Error("fault before deleted metadata install");
        }
      }),
      /fault before deleted metadata install/
    );
    const journalPath = path.join(handle.rootPath, "apply-journal/journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
      updatedAt: string;
      error?: string;
      digest: string;
      entries: Array<{
        installTempRelativePath?: string;
        displacedLiveRelativePath?: string;
      }>;
      [key: string]: unknown;
    };
    const installTempRelativePath = journal.entries[0]?.installTempRelativePath;
    const displacedLiveRelativePath =
      journal.entries[0]?.displacedLiveRelativePath;
    assert.ok(installTempRelativePath);
    assert.ok(displacedLiveRelativePath);
    journal.state = "applying";
    journal.updatedAt = new Date().toISOString();
    delete journal.error;
    const { digest: _oldDigest, ...journalWithoutDigest } = journal;
    journal.digest = digestForTest(journalWithoutDigest);
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    const targetPath = path.join(vaultPath, ...relativePath.split("/"));
    const tempPath = path.join(vaultPath, ...installTempRelativePath.split("/"));
    const displacedPath = path.join(
      vaultPath,
      ...displacedLiveRelativePath.split("/")
    );
    await link(targetPath, displacedPath);
    await rm(targetPath);
    await writeFile(tempPath, desired, "utf8");
    await link(tempPath, targetPath);
    const replacementPath = `${targetPath}.obsidian-replacement`;
    await writeFile(
      replacementPath,
      metadataMarkdown("Deleted install", observedUpdated, "NEW"),
      "utf8"
    );
    await rename(replacementPath, targetPath);
    await rm(targetPath);

    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, changeSet),
      "cas_conflict"
    );
    await assert.rejects(
      () => lstat(targetPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
    assert.equal(await readFile(tempPath, "utf8"), desired);
    assert.equal(
      await readFile(displacedPath, "utf8"),
      metadataMarkdown("Deleted install", desiredUpdated, "OLD"),
      "ambiguous deletion must preserve both exact install temp and displaced baseline"
    );
  });
}

async function assertInterruptedNoClobberDisplacementIsRecovered(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:displacement-crash",
      storageRootPath: shadowStoragePath
    });
    const relativePath = "wiki/existing.md";
    await writeFile(
      path.join(handle.agentVaultPath, relativePath),
      "WIKI-AFTER\n",
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        beforeApplyChange: () => {
          throw new Error("fault before displacement");
        }
      }),
      /fault before displacement/
    );

    const journalPath = path.join(
      handle.rootPath,
      "apply-journal/journal.json"
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
      updatedAt: string;
      error?: string;
      digest: string;
      entries: Array<{ displacedLiveRelativePath?: string }>;
      [key: string]: unknown;
    };
    const displacedRelativePath =
      journal.entries[0]?.displacedLiveRelativePath;
    assert.ok(displacedRelativePath);
    journal.state = "applying";
    journal.updatedAt = new Date().toISOString();
    delete journal.error;
    const { digest: _oldDigest, ...journalWithoutDigest } = journal;
    journal.digest = digestForTest(journalWithoutDigest);
    await writeFile(
      journalPath,
      `${JSON.stringify(journal, null, 2)}\n`,
      "utf8"
    );

    const targetPath = path.join(vaultPath, ...relativePath.split("/"));
    const displacedPath = path.join(
      vaultPath,
      ...displacedRelativePath.split("/")
    );
    await link(targetPath, displacedPath);
    assert.equal((await lstat(targetPath)).nlink, 2);

    await recoverMaintenanceShadowApplyTransactions(
      vaultPath,
      shadowStoragePath
    );
    assert.equal(await readFile(targetPath, "utf8"), "WIKI-OLD\n");
    assert.equal((await lstat(targetPath)).nlink, 1);
    await assert.rejects(
      () => lstat(displacedPath),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );

    const result = await applyShadowChangeSet(vaultPath, changeSet);
    assert.equal(await readFile(targetPath, "utf8"), "WIKI-AFTER\n");
    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: result.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertMetadataSuccessorsCommitDirectly(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const relativePath = "wiki/metadata-direct.md";
    const desiredUpdated = new Date(Date.now() - 60_000).toISOString();
    const observedUpdated = new Date(Date.now() - 1_000).toISOString();
    const laterObservedUpdated = new Date().toISOString();
    const regressedObservedUpdated = new Date(Date.now() - 30_000).toISOString();
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Direct", desiredUpdated, "OLD"),
      "utf8"
    );
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:metadata-direct",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, relativePath),
      metadataMarkdown("Direct", desiredUpdated, "NEW"),
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    const result = await applyShadowChangeSet(vaultPath, changeSet, {
      async faultInjector(input) {
        if (input.point !== "after-entry" || input.relativePath !== relativePath) return;
        await writeFile(
          path.join(vaultPath, relativePath),
          metadataMarkdown("Direct", observedUpdated, "NEW"),
          "utf8"
        );
      }
    });
    assert.ok(result.commitReceipt);
    const journal = JSON.parse(await readFile(
      path.join(handle.rootPath, "apply-journal/journal.json"),
      "utf8"
    )) as {
      state: string;
      metadataSuccessorPolicy?: unknown;
      metadataSuccessors?: Array<{ relativePath: string }>;
    };
    assert.equal(journal.state, "committed");
    assert.ok(journal.metadataSuccessorPolicy);
    assert.deepEqual(
      journal.metadataSuccessors?.map((proof) => proof.relativePath),
      [relativePath]
    );
    assert.equal(
      await readFile(path.join(vaultPath, relativePath), "utf8"),
      metadataMarkdown("Direct", observedUpdated, "NEW")
    );
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Direct", laterObservedUpdated, "NEW"),
      "utf8"
    );
    await markMaintenanceShadowCommittedFromJournal(handle, vaultPath);
    const refreshedJournal = JSON.parse(await readFile(
      path.join(handle.rootPath, "apply-journal/journal.json"),
      "utf8"
    )) as {
      metadataSuccessors?: Array<{
        relativePath: string;
        updatedAt: number;
      }>;
    };
    assert.equal(
      refreshedJournal.metadataSuccessors?.find(
        (proof) => proof.relativePath === relativePath
      )?.updatedAt,
      Date.parse(laterObservedUpdated),
      "committed proof must durably refresh when updated advances again inside the fixed window"
    );
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Direct", regressedObservedUpdated, "NEW"),
      "utf8"
    );
    await assert.rejects(
      () => markMaintenanceShadowCommittedFromJournal(handle, vaultPath),
      (error: unknown) => error instanceof MaintenanceShadowError
        && error.code === "cas_conflict"
    );
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Direct", laterObservedUpdated, "NEW"),
      "utf8"
    );
    await markMaintenanceShadowCommittedFromJournal(handle, vaultPath);
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertBlockedMetadataSuccessorsNeedCurrentAttemptAuthority(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const successorPaths = [
      "wiki/metadata-a.md",
      "wiki/metadata-b.md",
      "wiki/metadata-c.md"
    ];
    const baselinePaths = [
      "wiki/index.md",
      "outputs/maintenance/metadata-report.md"
    ];
    const atomicRecoveryPath = baselinePaths[0]!;
    const allPaths = [...successorPaths, ...baselinePaths];
    const desiredUpdated = new Date(Date.now() - 60_000).toISOString();
    const observedUpdated = new Date().toISOString();
    for (const relativePath of allPaths) {
      await mkdir(path.dirname(path.join(vaultPath, relativePath)), {
        recursive: true
      });
      await writeFile(
        path.join(vaultPath, relativePath),
        metadataMarkdown(relativePath, desiredUpdated, "OLD"),
        "utf8"
      );
    }
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:metadata-blocked-recovery",
      storageRootPath: shadowStoragePath
    });
    for (const relativePath of allPaths) {
      await writeFile(
        path.join(handle.agentVaultPath, relativePath),
        metadataMarkdown(relativePath, desiredUpdated, "NEW"),
        "utf8"
      );
    }
    const changeSet = await sealMaintenanceShadowVault(handle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, changeSet, {
        async faultInjector(input) {
          if (
            input.point === "after-entry"
            && successorPaths.includes(input.relativePath)
          ) {
            await writeFile(
              path.join(vaultPath, input.relativePath),
              metadataMarkdown(input.relativePath, observedUpdated, "NEW"),
              "utf8"
            );
          }
          if (
            input.point === "after-entry"
            && input.index === changeSet.changes.length - 1
          ) {
            throw new MaintenanceShadowSimulatedCrash(
              "crash after all five targets before journal commit"
            );
          }
        }
      }),
      (error: unknown) => error instanceof MaintenanceShadowSimulatedCrash
    );
    const journalPath = path.join(
      handle.rootPath,
      "apply-journal/journal.json"
    );
    const interrupted = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
      metadataSuccessorPolicy?: unknown;
    };
    assert.equal(
      interrupted.state,
      "applying",
      "crash must leave a durable applying journal for orphan recovery"
    );
    assert.ok(interrupted.metadataSuccessorPolicy);
    for (const relativePath of successorPaths) {
      assert.equal(
        await readFile(path.join(vaultPath, relativePath), "utf8"),
        metadataMarkdown(relativePath, observedUpdated, "NEW")
      );
    }
    for (const relativePath of baselinePaths) {
      assert.equal(
        await readFile(path.join(vaultPath, relativePath), "utf8"),
        metadataMarkdown(relativePath, desiredUpdated, "NEW")
      );
    }

    await rejectsWithCode(
      () => recoverMaintenanceShadowApplyTransactions(
        vaultPath,
        shadowStoragePath
      ),
      "cas_conflict"
    );
    const blocked = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
    };
    assert.equal(blocked.state, "blocked");
    for (const relativePath of successorPaths) {
      assert.equal(
        await readFile(path.join(vaultPath, relativePath), "utf8"),
        metadataMarkdown(relativePath, observedUpdated, "NEW")
      );
    }
    for (const relativePath of baselinePaths) {
      assert.equal(
        await readFile(path.join(vaultPath, relativePath), "utf8"),
        metadataMarkdown(relativePath, desiredUpdated, "OLD")
      );
    }

    let atomicRecoveryUpdated: string | undefined;
    const recovered = await applyShadowChangeSet(vaultPath, changeSet, {
      async faultInjector(input) {
        if (
          input.point !== "after-install-link"
          || input.relativePath !== atomicRecoveryPath
        ) return;
        atomicRecoveryUpdated = new Date().toISOString();
        const targetPath = path.join(vaultPath, atomicRecoveryPath);
        const replacementPath = `${targetPath}.obsidian-replacement`;
        await writeFile(
          replacementPath,
          metadataMarkdown(
            atomicRecoveryPath,
            atomicRecoveryUpdated,
            "NEW"
          ),
          "utf8"
        );
        await rename(replacementPath, targetPath);
      }
    });
    assert.ok(recovered.commitReceipt);
    assert.ok(
      atomicRecoveryUpdated,
      "blocked roll-forward must reach the deterministic post-link replacement"
    );
    const committed = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
      metadataSuccessors?: Array<{ relativePath: string }>;
    };
    assert.equal(committed.state, "committed");
    assert.deepEqual(
      committed.metadataSuccessors?.map((proof) => proof.relativePath),
      [...successorPaths, atomicRecoveryPath].sort()
    );
    for (const relativePath of successorPaths) {
      assert.equal(
        await readFile(path.join(vaultPath, relativePath), "utf8"),
        metadataMarkdown(relativePath, observedUpdated, "NEW")
      );
    }
    for (const relativePath of baselinePaths) {
      assert.equal(
        await readFile(path.join(vaultPath, relativePath), "utf8"),
        relativePath === atomicRecoveryPath
          ? metadataMarkdown(
            relativePath,
            atomicRecoveryUpdated,
            "NEW"
          )
          : metadataMarkdown(relativePath, desiredUpdated, "NEW")
      );
    }
    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: recovered.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertDuplicateAttemptIdCannotDeferAnotherBlockedJournal(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const attemptId = "workflow:attempt:duplicate-id";
    const desiredUpdated = new Date(Date.now() - 60_000).toISOString();
    const observedUpdated = new Date().toISOString();
    const blockedPath = "wiki/duplicate-blocked.md";
    const nextPath = "wiki/duplicate-next.md";
    for (const relativePath of [blockedPath, nextPath]) {
      await writeFile(
        path.join(vaultPath, relativePath),
        metadataMarkdown(relativePath, desiredUpdated, "OLD"),
        "utf8"
      );
    }
    const blockedHandle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId,
      storageRootPath: shadowStoragePath
    });
    const nextHandle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId,
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(blockedHandle.agentVaultPath, blockedPath),
      metadataMarkdown(blockedPath, desiredUpdated, "BLOCKED"),
      "utf8"
    );
    await writeFile(
      path.join(nextHandle.agentVaultPath, nextPath),
      metadataMarkdown(nextPath, desiredUpdated, "NEXT"),
      "utf8"
    );
    const blockedChangeSet = await sealMaintenanceShadowVault(blockedHandle);
    const nextChangeSet = await sealMaintenanceShadowVault(nextHandle);
    await assert.rejects(
      () => applyShadowChangeSet(vaultPath, blockedChangeSet, {
        async faultInjector(input) {
          if (input.point !== "after-entry") return;
          await writeFile(
            path.join(vaultPath, blockedPath),
            metadataMarkdown(blockedPath, observedUpdated, "BLOCKED"),
            "utf8"
          );
          throw new MaintenanceShadowSimulatedCrash(
            "leave the first duplicate-id journal interrupted"
          );
        }
      }),
      (error: unknown) => error instanceof MaintenanceShadowSimulatedCrash
    );
    await rejectsWithCode(
      () => recoverMaintenanceShadowApplyTransactions(
        vaultPath,
        shadowStoragePath
      ),
      "cas_conflict"
    );
    const blockedJournalPath = path.join(
      blockedHandle.rootPath,
      "apply-journal/journal.json"
    );
    assert.equal(
      (JSON.parse(await readFile(blockedJournalPath, "utf8")) as {
        state: string;
      }).state,
      "blocked"
    );
    await rejectsWithCode(
      () => applyShadowChangeSet(vaultPath, nextChangeSet),
      "cas_conflict"
    );
    assert.equal(
      await readFile(path.join(vaultPath, nextPath), "utf8"),
      metadataMarkdown(nextPath, desiredUpdated, "OLD"),
      "a matching attempt id must not skip another control root's blocked journal"
    );
  });
}

async function assertManagedOverrideConsumesDurableMetadataSuccessorProof(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const relativePath = "wiki/metadata-managed-override.md";
    const desiredUpdated = new Date(Date.now() - 60_000).toISOString();
    const observedUpdated = new Date().toISOString();
    await writeFile(
      path.join(vaultPath, relativePath),
      metadataMarkdown("Managed override", desiredUpdated, "OLD"),
      "utf8"
    );
    const handle = await createTransportFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "workflow:attempt:metadata-managed-override",
      storageRootPath: shadowStoragePath
    });
    await writeFile(
      path.join(handle.agentVaultPath, relativePath),
      metadataMarkdown("Managed override", desiredUpdated, "SHADOW"),
      "utf8"
    );
    const changeSet = await sealMaintenanceShadowVault(handle);
    await applyShadowChangeSet(vaultPath, changeSet, {
      async faultInjector(input) {
        if (input.point !== "after-entry" || input.relativePath !== relativePath) return;
        await writeFile(
          path.join(vaultPath, relativePath),
          metadataMarkdown("Managed override", observedUpdated, "SHADOW"),
          "utf8"
        );
      }
    });
    const journalPath = path.join(
      handle.rootPath,
      "apply-journal/journal.json"
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      metadataSuccessors?: Array<{
        relativePath: string;
        result: { kind: "file"; sha256: string; size: number; mode: number };
        updatedAt: number;
        projectionDigest: string;
      }>;
    };
    const accepted = journal.metadataSuccessors?.find(
      (proof) => proof.relativePath === relativePath
    );
    assert.ok(accepted, "Shadow commit must durably record the successor proof");
    const change = changeSet.changes.find(
      (candidate) => candidate.relativePath === relativePath
    );
    assert.ok(change && change.operation === "upsert");
    const managedContent = Buffer.from(
      metadataMarkdown("Managed override", observedUpdated, "MANAGED"),
      "utf8"
    );
    await writeFile(path.join(vaultPath, relativePath), managedContent);
    const override = {
      relativePath,
      expected: {
        kind: "file" as const,
        sha256: change.shadowSha256,
        size: change.size,
        mode: change.expectedLive.kind === "file"
          ? change.expectedLive.mode
          : 0o644
      },
      desired: {
        kind: "file" as const,
        sha256: sha256Text(managedContent.toString("utf8")),
        size: managedContent.byteLength,
        mode: 0o644
      }
    };
    await assert.rejects(
      () => markMaintenanceShadowCommittedFromJournal(
        handle,
        vaultPath,
        { overriddenTargets: [override] }
      ),
      (error: unknown) => error instanceof MaintenanceShadowError
        && error.code === "cas_conflict"
    );
    await markMaintenanceShadowCommittedFromJournal(
      handle,
      vaultPath,
      {
        overriddenTargets: [override],
        acceptedIgnoredMetadataSuccessors: [accepted]
      }
    );
    await cleanupMaintenanceShadowVault(handle);
  });
}

function metadataMarkdown(
  title: string,
  updated: string,
  body: string
): string {
  return [
    "---",
    `title: ${title}`,
    `updated: ${updated}`,
    "tags:",
    "  - durable-proof",
    "---",
    body,
    ""
  ].join("\n");
}

async function assertCleanupRequiresSafeTerminalState(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const active = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-active-cleanup",
      storageRootPath: shadowStoragePath
    });
    await rejectsWithCode(() => cleanupMaintenanceShadowVault(active), "invalid_state");
    const noChanges = await sealMaintenanceShadowVault(active);
    assert.deepEqual(noChanges.changes, []);
    const runtimeSentinelTestOption = { allowRuntimeSentinelForTests: true };
    const zeroResultAttestation = await attestMaintenanceShadowZeroResult(
      active,
      vaultPath,
      runtimeSentinelTestOption
    );
    await assertMaintenanceShadowZeroResultAttestation(
      active,
      vaultPath,
      zeroResultAttestation,
      runtimeSentinelTestOption
    );
    await rejectsWithCode(() => cleanupMaintenanceShadowVault(active), "invalid_state");
    await rejectsWithCode(
      () => markMaintenanceShadowTerminal(active, "committed", { commitReceipt: "forged" }),
      "invalid_state"
    );
    await markMaintenanceShadowTerminal(active, "noop");
    await cleanupMaintenanceShadowVault(active);
  });
}

async function assertAbandonedChangeSetCannotApplyAfterReload(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-abandoned-apply-reload",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, "wiki/existing.md"), "ABANDONED-CANDIDATE\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);
    await abandonMaintenanceShadowVault(handle, "timeout with uncertain native process");

    const reloadedHandle = { ...handle };
    await rejectsWithCode(() => applyShadowChangeSet(vaultPath, changeSet), "invalid_state");
    await rejectsWithCode(() => cleanupMaintenanceShadowVault(reloadedHandle), "invalid_state");
    assert.equal(await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"), "WIKI-OLD\n");

    await markMaintenanceShadowTerminal(reloadedHandle, "discarded", {
      abandonedAgentFenced: true
    });
    await cleanupMaintenanceShadowVault(reloadedHandle);
  });
}

async function assertApplyAndAbandonShareOneCommitAuthorityLock(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const handle = await createFencedShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-apply-abandon-race",
      storageRootPath: shadowStoragePath
    });
    await writeFile(path.join(handle.agentVaultPath, "wiki/existing.md"), "LOCK-WINNER\n", "utf8");
    const changeSet = await sealMaintenanceShadowVault(handle);

    let releaseApply!: () => void;
    let enteredApply!: () => void;
    const applyHeld = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applyEntered = new Promise<void>((resolve) => {
      enteredApply = resolve;
    });
    const applyPromise = applyShadowChangeSet(vaultPath, changeSet, {
      async beforeApplyChange() {
        enteredApply();
        await applyHeld;
      }
    });
    await applyEntered;

    let abandonSettled = false;
    const abandonOutcome = abandonMaintenanceShadowVault(handle, "race loser")
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      )
      .finally(() => {
        abandonSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(abandonSettled, true, "a live apply owner must make racing abandon fail closed");
    const abandoned = await abandonOutcome;
    assert.equal(abandoned.ok, false, "the live apply lock must defeat a racing abandon");
    if (abandoned.ok) throw new Error("expected racing abandon to fail");
    assert.equal(isMaintenanceShadowError(abandoned.error, "commit_locked"), true);

    releaseApply();
    const applyResult = await applyPromise;
    assert.equal(await readFile(path.join(vaultPath, "wiki/existing.md"), "utf8"), "LOCK-WINNER\n");

    await markMaintenanceShadowTerminal(handle, "committed", {
      commitReceipt: applyResult.commitReceipt
    });
    await cleanupMaintenanceShadowVault(handle);
  });
}

async function assertQuarantineRejectsForgeryLateWriteApplyAndCleanup(): Promise<void> {
  await withFixture(async ({ vaultPath, shadowStoragePath }) => {
    const { handle, writeFenceReceipt } = await createQuarantinableShadow({
      liveVaultPath: vaultPath,
      attemptId: "attempt-quarantine-late-write",
      storageRootPath: shadowStoragePath
    });
    const changeSet = await sealMaintenanceShadowVault(handle);
    assert.equal(changeSet.structuralResult, "zero-result");
    const zeroResultAttestation = await attestMaintenanceShadowZeroResult(handle, vaultPath);
    const quarantineReceipt = await quarantineMaintenanceShadowZeroResult(handle, vaultPath, {
      writeFenceReceipt,
      zeroResultAttestation,
      reason: "selected Agent timed out with zero durable result"
    });

    assert.equal(isTrustedMaintenanceShadowQuarantineReceipt(quarantineReceipt), true);
    assert.equal(Object.isFrozen(quarantineReceipt), true);
    assert.equal(
      isTrustedMaintenanceShadowQuarantineReceipt({ ...quarantineReceipt }),
      false,
      "spread clone must not preserve quarantine authority"
    );
    assert.equal(
      isTrustedMaintenanceShadowQuarantineReceipt(JSON.parse(JSON.stringify(quarantineReceipt))),
      false,
      "JSON clone must not preserve quarantine authority"
    );
    const prototypeClone = Object.assign(
      Object.create(Object.getPrototypeOf(quarantineReceipt)),
      { ...quarantineReceipt }
    );
    assert.equal(
      isTrustedMaintenanceShadowQuarantineReceipt(prototypeClone),
      false,
      "forged prototype chain must not preserve quarantine authority"
    );

    // A late/zombie Agent may still mutate its allowed Shadow after timeout.
    // The durable abandoned state must nevertheless make the old changeset
    // permanently non-applicable, including through a reloaded handle.
    const lateWikiPath = path.join(handle.agentVaultPath, "wiki");
    await chmod(lateWikiPath, 0o755);
    await writeFile(path.join(lateWikiPath, "late-zombie.md"), "LATE\n", "utf8");
    await rejectsWithCode(() => applyShadowChangeSet(vaultPath, changeSet), "invalid_state");
    await rejectsWithCode(
      () => quarantineMaintenanceShadowZeroResult({ ...handle }, vaultPath, {
        writeFenceReceipt,
        zeroResultAttestation,
        reason: "forged replay"
      }),
      "invalid_state"
    );
    await rejectsWithCode(() => cleanupMaintenanceShadowVault({ ...handle }), "invalid_state");
    await rejectsWithCode(() => markMaintenanceShadowTerminal({ ...handle }, "noop"), "invalid_state");
    await assert.rejects(
      () => lstat(path.join(vaultPath, "wiki/late-zombie.md")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  });
}

async function readFirstTransactionPaths(
  handle: MaintenanceShadowHandle
): Promise<{
  installTempRelativePath?: string;
  displacedLiveRelativePath?: string;
}> {
  const journal = JSON.parse(
    await readFile(
      path.join(handle.rootPath, "apply-journal/journal.json"),
      "utf8"
    )
  ) as {
    entries: Array<{
      installTempRelativePath?: string;
      displacedLiveRelativePath?: string;
    }>;
  };
  const first = journal.entries[0];
  assert.ok(first, "apply journal must contain the selected Shadow entry");
  return first;
}

async function createFencedShadow(
  options: CreateMaintenanceShadowOptions
): Promise<MaintenanceShadowHandle> {
  const handle = await createMaintenanceShadowVault(options);
  const boundary = await maintenanceShadowExecutionBoundary(handle);
  assert.equal(boundary.writableRootPaths.some((entry) => entry.endsWith("/outputs/maintenance")), true);
  assert.equal(boundary.deniedPaths.some((entry) => entry.endsWith("/raw")), true);
  assert.equal(boundary.deniedPaths.some((entry) => entry.endsWith("/LLM-WIKI.md")), true);
  assert.equal(boundary.deniedPaths.some((entry) => entry.endsWith("/outputs/.ingest-tracker.md")), true);
  await confirmMaintenanceShadowWriteFence(handle, options.liveVaultPath, async (challenge) => {
    await writeFile(challenge.writableShadowProbePath, challenge.token, "utf8");
    return {
      backend: "test-runtime",
      evidence: "fixture executed only the allowed shadow sentinel write",
      opaqueReceipt: `test-receipt:${challenge.token}`,
      enforcedWritableRootPaths: boundary.writableRootPaths,
      enforcedDeniedPaths: boundary.deniedPaths,
      deniedProbeAttempts: challenge.deniedWriteProbePaths.map((probePath) => ({
        path: probePath,
        outcome: "denied" as const,
        errorCode: "EACCES"
      }))
    };
  });
  return handle;
}

async function createQuarantinableShadow(
  options: CreateMaintenanceShadowOptions
): Promise<{
  handle: MaintenanceShadowHandle;
  writeFenceReceipt: AgentExactWriteFenceReceipt;
}> {
  const handle = await createMaintenanceShadowVault(options);
  const boundary = await maintenanceShadowExecutionBoundary(handle);
  const leaseToken = `lease:${handle.attemptId}`;
  const writeFenceReceipt = createExactWriteFenceReceipt({
    backend: "codex-cli",
    task: {
      prompt: "maintain",
      permission: "workspace-write",
      writableRoots: boundary.writableRootPaths,
      requireExactWriteFence: true,
      exactWriteFence: {
        attemptToken: handle.attemptId,
        leaseToken,
        deniedLivePaths: [options.liveVaultPath],
        deniedControlPaths: [boundary.deniedParentPath, ...boundary.deniedPaths]
      }
    },
    transport: "test-transport",
    transportAck: { policy: "installed", attemptId: handle.attemptId }
  });
  const shadowReceipt = createMaintenanceShadowTransportConfigReceipt({
    backend: writeFenceReceipt.backend,
    attemptId: handle.attemptId,
    leaseId: leaseToken,
    enforcedWritableRootPaths: boundary.writableRootPaths,
    enforcedDeniedShadowPaths: boundary.deniedPaths,
    deniedLiveVaultPath: options.liveVaultPath,
    deniedControlPath: boundary.deniedParentPath,
    transportAck: `${writeFenceReceipt.transport}:${writeFenceReceipt.configAckDigest}`,
    transportConfigDigest: maintenanceExactWriteFenceBindingDigest(writeFenceReceipt),
    issuedAt: writeFenceReceipt.configuredAt
  });
  await confirmMaintenanceShadowTransportConfigFence(handle, options.liveVaultPath, shadowReceipt);
  return { handle, writeFenceReceipt };
}

async function createTransportFencedShadow(
  options: CreateMaintenanceShadowOptions
): Promise<MaintenanceShadowHandle> {
  const handle = await createMaintenanceShadowVault(options);
  const boundary = await maintenanceShadowExecutionBoundary(handle);
  const receipt = createMaintenanceShadowTransportConfigReceipt({
    backend: "test-transport",
    attemptId: handle.attemptId,
    leaseId: `lease:${handle.attemptId}`,
    enforcedWritableRootPaths: boundary.writableRootPaths,
    enforcedDeniedShadowPaths: boundary.deniedPaths,
    deniedLiveVaultPath: options.liveVaultPath,
    deniedControlPath: boundary.deniedParentPath,
    transportAck: "test transport policy installed before prompt",
    transportConfigDigest: sha256Text(`transport:${handle.attemptId}`)
  });
  await confirmMaintenanceShadowTransportConfigFence(handle, options.liveVaultPath, receipt);
  return handle;
}

async function withFixture(
  run: (fixture: { rootPath: string; vaultPath: string; shadowStoragePath: string }) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "echoink-maintenance-shadow-test-"));
  const vaultPath = path.join(rootPath, "live-vault");
  const shadowStoragePath = path.join(rootPath, "shadow-storage");
  await mkdir(path.join(vaultPath, "raw"), { recursive: true });
  await mkdir(path.join(vaultPath, "wiki"), { recursive: true });
  await mkdir(path.join(vaultPath, "projects"), { recursive: true });
  await mkdir(path.join(vaultPath, "outputs"), { recursive: true });
  await mkdir(path.join(vaultPath, "inbox"), { recursive: true });
  await writeFile(path.join(vaultPath, "LLM-WIKI.md"), "# Rules\n", "utf8");
  await writeFile(path.join(vaultPath, "raw/source.md"), "RAW-CONTENT\n", "utf8");
  await writeFile(path.join(vaultPath, "wiki/existing.md"), "WIKI-OLD\n", "utf8");
  await writeFile(path.join(vaultPath, "projects/old.md"), "PROJECT-OLD\n", "utf8");
  await writeFile(path.join(vaultPath, "outputs/.ingest-tracker.md"), "TRACKER\n", "utf8");
  try {
    await run({ rootPath, vaultPath, shadowStoragePath });
  } finally {
    await makeOwnerWritable(rootPath);
    await rm(rootPath, { recursive: true, force: true });
  }
}

async function rejectsWithCode(
  operation: () => Promise<unknown>,
  code: MaintenanceShadowErrorCode
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => isMaintenanceShadowError(error, code));
}

function isMaintenanceShadowError(error: unknown, code: MaintenanceShadowErrorCode): boolean {
  return error instanceof MaintenanceShadowError && error.code === code;
}

function sha256Text(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function digestForTest(value: unknown): string {
  return sha256Text(stableStringifyForTest(value));
}

function stableStringifyForTest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringifyForTest).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyForTest(record[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

async function makeOwnerWritable(absolutePath: string): Promise<void> {
  const stat = await lstat(absolutePath).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(absolutePath, 0o700).catch(() => undefined);
    for (const child of await readdir(absolutePath).catch(() => [])) {
      await makeOwnerWritable(path.join(absolutePath, child));
    }
  } else if (stat.isFile()) {
    await chmod(absolutePath, 0o600).catch(() => undefined);
  }
}
