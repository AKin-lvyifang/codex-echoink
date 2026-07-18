import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  ActiveMaintenanceRunJournalError,
  ActiveMaintenanceRunJournalSimulatedCrash,
  createActiveMaintenanceRunJournal,
  listActiveMaintenanceRunJournals,
  loadActiveMaintenanceRunJournal,
  removeActiveMaintenanceRunJournal,
  updateActiveMaintenanceRunJournal,
  type ActiveMaintenanceRunJournalErrorCode,
  type LoadedActiveMaintenanceRunJournal
} from "../../harness/maintenance/active-run-journal";
import type { KnowledgeRunAttemptRecord } from "../../knowledge-base/types";

export async function runHarnessV2MaintenanceActiveRunJournalTests(): Promise<void> {
  await assertZeroAttemptJournalRoundTripsAndRemoves();
  await assertAttemptAndPhaseUpdatesRoundTrip();
  await assertStaleRevisionCannotOverwriteNewerState();
  await assertConcurrentCasHasExactlyOneWinner();
  await assertAttemptEvidenceAndRoutingSequenceAreAppendOnly();
  await assertCorruptAndSymlinkEntriesFailClosed();
  await assertInternalNamespaceSymlinkFailsClosed();
  await assertAtomicCrashReloadShowsOnlyOldOrNewRecord();
  await assertRemoveCrashReplayIsSafe();
}

async function assertZeroAttemptJournalRoundTripsAndRemoves(): Promise<void> {
  await withFixture("zero-attempt", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-zero-attempt",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });

    assert.equal(created.record.revision, 0);
    assert.deepEqual(created.record.attempts, []);
    assert.equal(created.record.selectedBackend, "codex-cli");
    assert.match(created.record.digest, /^sha256:[a-f0-9]{64}$/);

    const loaded = await loadActiveMaintenanceRunJournal(created.handle);
    assert.deepEqual(loaded.record, created.record);
    assert.deepEqual(
      (await listActiveMaintenanceRunJournals(storageRootPath)).map((item) => item.record),
      [created.record]
    );

    assert.equal(
      await removeActiveMaintenanceRunJournal(created.handle, cas(created)),
      true
    );
    assert.deepEqual(await listActiveMaintenanceRunJournals(storageRootPath), []);
    assert.equal(
      await removeActiveMaintenanceRunJournal(created.handle, cas(created)),
      false,
      "replayed cleanup must be idempotent after the exact record was removed"
    );
  });
}

async function assertAttemptAndPhaseUpdatesRoundTrip(): Promise<void> {
  await withFixture("attempt-update", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-attempt-update",
      mode: "reingest",
      startedAt: 1_721_260_800_000,
      selectedBackend: "opencode",
      attempts: [],
      terminalPhase: "preflight"
    });
    const attempt: KnowledgeRunAttemptRecord = {
      attemptId: "attempt-opencode-1",
      ordinal: 1,
      backend: "opencode",
      submitted: {
        at: 1_721_260_800_100,
        harnessRunId: "harness-attempt-opencode-1"
      }
    };

    const execution = await updateActiveMaintenanceRunJournal(created.handle, {
      ...cas(created),
      attempts: [attempt],
      terminalPhase: "execution"
    });
    assert.equal(execution.record.revision, 1);
    assert.deepEqual(execution.record.attempts, [attempt]);
    assert.equal(execution.record.terminalPhase, "execution");
    assert.ok(execution.record.updatedAt > created.record.updatedAt);

    const verifiedAttempt: KnowledgeRunAttemptRecord = {
      ...attempt,
      terminal: {
        status: "completed",
        at: 1_721_260_800_200
      }
    };
    const verification = await updateActiveMaintenanceRunJournal(created.handle, {
      ...cas(execution),
      attempts: [verifiedAttempt],
      terminalPhase: "verification"
    });
    assert.equal(verification.record.revision, 2);
    assert.deepEqual(
      (await loadActiveMaintenanceRunJournal(created.handle)).record,
      verification.record
    );
  });
}

async function assertStaleRevisionCannotOverwriteNewerState(): Promise<void> {
  await withFixture("stale-revision", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-stale-revision",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "hermes",
      attempts: [],
      terminalPhase: "preflight"
    });
    const current = await updateActiveMaintenanceRunJournal(created.handle, {
      ...cas(created),
      attempts: [attempt("attempt-hermes-1", 1, "hermes")],
      terminalPhase: "execution"
    });

    await rejectsWithCode(
      () => updateActiveMaintenanceRunJournal(created.handle, {
        ...cas(created),
        attempts: [],
        terminalPhase: "preflight"
      }),
      "revision_conflict"
    );
    assert.deepEqual(
      (await loadActiveMaintenanceRunJournal(created.handle)).record,
      current.record,
      "a stale caller must never roll back attempts or phase"
    );
  });
}

async function assertConcurrentCasHasExactlyOneWinner(): Promise<void> {
  await withFixture("concurrent-cas", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-concurrent-cas",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    const update = {
      ...cas(created),
      attempts: [attempt("attempt-codex-1", 1, "codex-cli")],
      terminalPhase: "execution" as const
    };
    const results = await Promise.allSettled([
      updateActiveMaintenanceRunJournal(created.handle, update),
      updateActiveMaintenanceRunJournal(created.handle, update)
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
      "the append-only revision slot must have exactly one winner"
    );
    assert.equal(
      results.filter((result) => (
        result.status === "rejected"
        && result.reason instanceof ActiveMaintenanceRunJournalError
        && result.reason.code === "revision_conflict"
      )).length,
      1
    );
    assert.equal(
      (await loadActiveMaintenanceRunJournal(created.handle)).record.revision,
      1
    );
  });
}

async function assertAttemptEvidenceAndRoutingSequenceAreAppendOnly(): Promise<void> {
  await withFixture("attempt-append-only", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-attempt-append-only",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    const evidenced: KnowledgeRunAttemptRecord = {
      attemptId: "attempt-codex-1",
      ordinal: 1,
      backend: "codex-cli",
      native: {
        id: "native-codex-1",
        kind: "thread",
        persistence: "provider-persistent"
      },
      submitted: {
        at: 1_721_260_800_100,
        harnessRunId: "harness-codex-1"
      },
      terminal: {
        status: "completed",
        at: 1_721_260_800_200
      },
      staging: {
        path: "/tmp/shadow-codex-1",
        preparedAt: 1_721_260_800_050
      }
    };
    const verified = await updateActiveMaintenanceRunJournal(created.handle, {
      ...cas(created),
      attempts: [evidenced],
      terminalPhase: "verification"
    });

    await rejectsWithCode(
      () => updateActiveMaintenanceRunJournal(created.handle, {
        ...cas(verified),
        attempts: [attempt("attempt-codex-1", 1, "codex-cli")],
        terminalPhase: "verification"
      }),
      "invalid_transition"
    );
    await rejectsWithCode(
      () => updateActiveMaintenanceRunJournal(created.handle, {
        ...cas(verified),
        attempts: [evidenced, attempt("attempt-opencode-2", 2, "opencode")],
        terminalPhase: "verification"
      }),
      "invalid_transition"
    );
  });

  await withFixture("attempt-sequence", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-attempt-sequence",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    await rejectsWithCode(
      () => updateActiveMaintenanceRunJournal(created.handle, {
        ...cas(created),
        attempts: [attempt("attempt-codex-2", 2, "codex-cli")],
        terminalPhase: "execution"
      }),
      "journal_corrupt"
    );
    const failed: KnowledgeRunAttemptRecord = {
      ...attempt("attempt-codex-1", 1, "codex-cli"),
      failure: {
        code: "NETWORK_ERROR",
        at: 1_721_260_800_100,
        message: "network failed",
        phase: "preflight",
        retryable: true,
        failoverEligible: true
      },
      terminal: {
        status: "failed",
        at: 1_721_260_800_100
      }
    };
    await rejectsWithCode(
      () => updateActiveMaintenanceRunJournal(created.handle, {
        ...cas(created),
        attempts: [failed, attempt("attempt-codex-2", 2, "codex-cli")],
        terminalPhase: "execution"
      }),
      "journal_corrupt"
    );
  });
}

async function assertCorruptAndSymlinkEntriesFailClosed(): Promise<void> {
  await withFixture("corrupt", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-corrupt",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    const tampered = JSON.parse(await readFile(created.recordPath, "utf8"));
    tampered.selectedBackend = "hermes";
    await writeFile(created.recordPath, `${JSON.stringify(tampered)}\n`, "utf8");

    await rejectsWithCode(
      () => loadActiveMaintenanceRunJournal(created.handle),
      "journal_corrupt"
    );
    await rejectsWithCode(
      () => listActiveMaintenanceRunJournals(storageRootPath),
      "journal_corrupt"
    );
  });

  await withFixture("symlink", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-symlink",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    await removeActiveMaintenanceRunJournal(created.handle, cas(created));
    const outsidePath = path.join(storageRootPath, "outside-directory");
    await mkdir(outsidePath);
    await symlink(outsidePath, created.handle.runRootPath);

    await rejectsWithCode(
      () => loadActiveMaintenanceRunJournal(created.handle),
      "unsafe_entry"
    );
    await rejectsWithCode(
      () => listActiveMaintenanceRunJournals(storageRootPath),
      "unsafe_entry"
    );
  });
}

async function assertInternalNamespaceSymlinkFailsClosed(): Promise<void> {
  await withFixture("internal-symlink", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-internal-symlink",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    await symlink(
      storageRootPath,
      path.join(created.handle.stagingRootPath, "unknown-link")
    );
    await rejectsWithCode(
      () => listActiveMaintenanceRunJournals(storageRootPath),
      "unsafe_entry"
    );
  });
}

async function assertAtomicCrashReloadShowsOnlyOldOrNewRecord(): Promise<void> {
  await withFixture("atomic-reload", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-atomic-reload",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    const firstAttempt = attempt("attempt-codex-1", 1, "codex-cli");

    await assert.rejects(
      () => updateActiveMaintenanceRunJournal(created.handle, {
        ...cas(created),
        attempts: [firstAttempt],
        terminalPhase: "execution",
        faultInjector(point) {
          if (point === "after-staging-sync") {
            throw new ActiveMaintenanceRunJournalSimulatedCrash(point);
          }
        }
      }),
      ActiveMaintenanceRunJournalSimulatedCrash
    );
    assert.deepEqual(
      (await loadActiveMaintenanceRunJournal(created.handle)).record,
      created.record,
      "an unpublished staging file must never replace the last durable record"
    );

    const execution = await updateActiveMaintenanceRunJournal(created.handle, {
      ...cas(created),
      attempts: [firstAttempt],
      terminalPhase: "execution"
    });
    await assert.rejects(
      () => updateActiveMaintenanceRunJournal(created.handle, {
        ...cas(execution),
        attempts: [{
          ...firstAttempt,
          terminal: { status: "completed", at: 1_721_260_800_200 }
        }],
        terminalPhase: "verification",
        faultInjector(point) {
          if (point === "after-publish") {
            throw new ActiveMaintenanceRunJournalSimulatedCrash(point);
          }
        }
      }),
      ActiveMaintenanceRunJournalSimulatedCrash
    );
    const afterPublishCrash = await loadActiveMaintenanceRunJournal(created.handle);
    assert.equal(afterPublishCrash.record.revision, 2);
    assert.equal(afterPublishCrash.record.terminalPhase, "verification");
    assert.equal(afterPublishCrash.record.attempts[0]?.terminal?.status, "completed");
  });
}

async function assertRemoveCrashReplayIsSafe(): Promise<void> {
  await withFixture("remove-crash", async (storageRootPath) => {
    const created = await createActiveMaintenanceRunJournal({
      storageRootPath,
      workflowRunId: "workflow-remove-crash",
      mode: "maintain",
      startedAt: 1_721_260_800_000,
      selectedBackend: "codex-cli",
      attempts: [],
      terminalPhase: "preflight"
    });
    await assert.rejects(
      () => removeActiveMaintenanceRunJournal(created.handle, {
        ...cas(created),
        faultInjector(point) {
          if (point === "after-staging-sync") {
            throw new ActiveMaintenanceRunJournalSimulatedCrash(point);
          }
        }
      }),
      ActiveMaintenanceRunJournalSimulatedCrash
    );
    assert.deepEqual(
      (await loadActiveMaintenanceRunJournal(created.handle)).record,
      created.record
    );

    await assert.rejects(
      () => removeActiveMaintenanceRunJournal(created.handle, {
        ...cas(created),
        faultInjector(point) {
          if (point === "after-publish") {
            throw new ActiveMaintenanceRunJournalSimulatedCrash(point);
          }
        }
      }),
      ActiveMaintenanceRunJournalSimulatedCrash
    );
    await rejectsWithCode(
      () => loadActiveMaintenanceRunJournal(created.handle),
      "journal_missing"
    );
    assert.deepEqual(await listActiveMaintenanceRunJournals(storageRootPath), []);
    assert.equal(
      await removeActiveMaintenanceRunJournal(created.handle, cas(created)),
      false,
      "replayed remove must archive a durable tombstone without reviving the run"
    );
  });
}

function attempt(
  attemptId: string,
  ordinal: number,
  backend: KnowledgeRunAttemptRecord["backend"]
): KnowledgeRunAttemptRecord {
  return { attemptId, ordinal, backend };
}

function cas(loaded: LoadedActiveMaintenanceRunJournal): {
  expectedRevision: number;
  expectedDigest: string;
} {
  return {
    expectedRevision: loaded.record.revision,
    expectedDigest: loaded.record.digest
  };
}

async function rejectsWithCode(
  action: () => Promise<unknown>,
  code: ActiveMaintenanceRunJournalErrorCode
): Promise<void> {
  await assert.rejects(action, (error: unknown) => (
    error instanceof ActiveMaintenanceRunJournalError
    && error.code === code
  ));
}

async function withFixture(
  label: string,
  action: (storageRootPath: string) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(path.join(tmpdir(), `echoink-active-run-${label}-`));
  const storageRootPath = path.join(rootPath, "maintenance-shadows", "vault-token");
  await mkdir(storageRootPath, { recursive: true, mode: 0o700 });
  try {
    await action(storageRootPath);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
