import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createExactWriteFenceReceipt } from "../../agent/write-fence";
import type { AgentExactWriteFenceReceipt } from "../../agent/types";
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
  markMaintenanceShadowTerminal,
  quarantineMaintenanceShadowZeroResult,
  recoverMaintenanceShadowApplyTransactions,
  sealMaintenanceShadowVault,
  type CreateMaintenanceShadowOptions,
  type MaintenanceShadowErrorCode,
  type MaintenanceShadowHandle
} from "../../harness/maintenance/shadow-vault";

export async function runHarnessV2MaintenanceShadowTests(): Promise<void> {
  await assertShadowCopiesBytesAndAppliesFilteredChanges();
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
  await assertInterruptedNoClobberDisplacementIsRecovered();
  await assertCleanupRequiresSafeTerminalState();
  await assertAbandonedChangeSetCannotApplyAfterReload();
  await assertApplyAndAbandonShareOneCommitAuthorityLock();
  await assertQuarantineRejectsForgeryLateWriteApplyAndCleanup();
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

    await rejectsWithCode(
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
