import * as assert from "node:assert/strict";
import {
  createKnowledgeRunLedger,
  knowledgeRunStatus,
  recordKnowledgeRunAttempt,
  recordKnowledgeRunCompletion,
  recordKnowledgeRunFailure,
  summarizeKnowledgeRunLedger
} from "../../workflows/knowledge/ledger/knowledge-run-ledger";

export async function runHarnessV2KnowledgeLedgerTests(): Promise<void> {
  assertKnowledgeLedgerSuccessDoesNotDependOnAgentText();
  assertKnowledgeLedgerFailureComesFromValidation();
  assertKnowledgeLedgerRecordsSelectedFirstFailoverIdempotently();
  assertKnowledgeLedgerRecordsPartialCompletion();
  assertKnowledgeLedgerRejectsConflictingAttemptIdentity();
  assertKnowledgeLedgerRecordsStructuredFailureIdempotently();
}

function assertKnowledgeLedgerSuccessDoesNotDependOnAgentText(): void {
  const ledger = createKnowledgeRunLedger({
    runId: "kb-run-1",
    mode: "maintain",
    startedAt: 1
  });
  assert.equal(ledger.selectedBackend, undefined, "legacy creation must not require resilience fields");
  assert.equal(ledger.attempts, undefined, "legacy creation shape must remain compatible");
  ledger.sources.push({ path: "raw/a.md", fingerprint: "raw-a", status: "processed" });
  ledger.operations.push({ type: "upsert-page", targetPath: "wiki/a.md", sourcePath: "raw/a.md", status: "applied" });
  ledger.validations.push({ id: "raw-integrity", status: "passed", message: "Raw unchanged" });
  ledger.validations.push({ id: "digest-evidence", status: "passed", message: "Evidence found" });
  ledger.artifacts.push({ kind: "markdown-report", path: "outputs/maintenance/kb.md" });
  ledger.agentFinalText = "我失败了";

  assert.equal(knowledgeRunStatus(ledger), "success");
  assert.deepEqual(summarizeKnowledgeRunLedger(ledger), {
    runId: "kb-run-1",
    mode: "maintain",
    status: "success",
    processedSourceCount: 1,
    appliedOperationCount: 1,
    failedValidationCount: 0,
    reportPath: "outputs/maintenance/kb.md"
  });
}

function assertKnowledgeLedgerFailureComesFromValidation(): void {
  const ledger = createKnowledgeRunLedger({
    runId: "kb-run-2",
    mode: "maintain",
    startedAt: 1
  });
  ledger.sources.push({ path: "raw/b.md", fingerprint: "raw-b", status: "processed" });
  ledger.operations.push({ type: "upsert-page", targetPath: "wiki/b.md", sourcePath: "raw/b.md", status: "applied" });
  ledger.validations.push({ id: "digest-evidence", status: "failed", message: "Missing source evidence" });
  ledger.artifacts.push({ kind: "markdown-report", path: "outputs/maintenance/kb-failed.md" });
  ledger.agentFinalText = "全部成功";

  assert.equal(knowledgeRunStatus(ledger), "failed");
  assert.equal(summarizeKnowledgeRunLedger(ledger).failedValidationCount, 1);
}

function assertKnowledgeLedgerRecordsSelectedFirstFailoverIdempotently(): void {
  const initial = createKnowledgeRunLedger({
    runId: "kb-run-failover",
    mode: "maintain",
    startedAt: 1,
    selectedBackend: "hermes",
    candidateBackends: ["hermes", "codex-cli", "opencode"]
  });
  const selectedAttempt = {
    attemptId: "kb-run-failover:attempt:1:hermes",
    ordinal: 1,
    backend: "hermes" as const,
    submitted: {
      at: 2,
      harnessRunId: "knowledge-hermes-1"
    },
    native: {
      id: "hermes-process-1",
      kind: "process" as const
    },
    terminal: {
      status: "failed" as const,
      at: 3,
      message: "connection closed"
    },
    failure: {
      code: "backend-connection-failed",
      at: 3,
      message: "connection closed",
      phase: "execution" as const,
      retryable: true,
      failoverEligible: true
    },
    termination: {
      requestedAt: 4,
      confirmedAt: 5
    },
    staging: {
      path: ".echoink-staging/kb-run-failover/1",
      preparedAt: 2,
      discardedAt: 5
    }
  };
  const afterSubmitted = recordKnowledgeRunAttempt(initial, {
    attemptId: selectedAttempt.attemptId,
    ordinal: selectedAttempt.ordinal,
    backend: selectedAttempt.backend,
    submitted: selectedAttempt.submitted,
    native: selectedAttempt.native,
    staging: {
      path: selectedAttempt.staging.path,
      preparedAt: selectedAttempt.staging.preparedAt
    }
  });
  const afterSelected = recordKnowledgeRunAttempt(afterSubmitted, selectedAttempt);
  const afterDuplicate = recordKnowledgeRunAttempt(afterSelected, selectedAttempt);

  assert.deepEqual(afterDuplicate, afterSelected, "replaying an attempt must not duplicate it");
  assert.equal(afterDuplicate.attempts?.length, 1);

  const afterFallback = recordKnowledgeRunAttempt(afterDuplicate, {
    attemptId: "kb-run-failover:attempt:2:codex-cli",
    ordinal: 2,
    backend: "codex-cli",
    submitted: {
      at: 6,
      harnessRunId: "knowledge-codex-1"
    },
    terminal: {
      status: "completed",
      at: 8
    },
    staging: {
      path: ".echoink-staging/kb-run-failover/2",
      preparedAt: 6,
      promotedAt: 9
    }
  });
  const completed = recordKnowledgeRunCompletion(afterFallback, {
    completion: "recovered",
    completedAt: 10,
    pendingSources: [],
    checkpoint: {
      checkpointId: "checkpoint-kb-run-failover",
      createdAt: 1,
      stagingPath: ".echoink-staging/kb-run-failover"
    },
    commit: {
      commitId: "commit-kb-run-failover",
      checkpointId: "checkpoint-kb-run-failover",
      committedAt: 10,
      sourcePaths: ["raw/a.md"],
      operationCount: 2
    }
  });
  const completedReplay = recordKnowledgeRunCompletion(completed, {
    completion: "recovered",
    completedAt: 10,
    pendingSources: [],
    checkpoint: {
      checkpointId: "checkpoint-kb-run-failover",
      createdAt: 1,
      stagingPath: ".echoink-staging/kb-run-failover"
    },
    commit: {
      commitId: "commit-kb-run-failover",
      checkpointId: "checkpoint-kb-run-failover",
      committedAt: 10,
      sourcePaths: ["raw/a.md"],
      operationCount: 2
    }
  });

  assert.deepEqual(completedReplay, completed, "replaying completion must be idempotent");
  assert.equal(knowledgeRunStatus(completed), "success", "a settled fallback must make the workflow successful");
  assert.deepEqual(summarizeKnowledgeRunLedger(completed), {
    runId: "kb-run-failover",
    mode: "maintain",
    status: "success",
    processedSourceCount: 0,
    appliedOperationCount: 0,
    failedValidationCount: 0,
    reportPath: "",
    selectedBackend: "hermes",
    candidateBackends: ["hermes", "codex-cli", "opencode"],
    attemptedBackends: ["hermes", "codex-cli"],
    attemptCount: 2,
    completedBackend: "codex-cli",
    completion: "recovered",
    pendingSourceCount: 0,
    checkpointId: "checkpoint-kb-run-failover",
    commitId: "commit-kb-run-failover"
  });
}

function assertKnowledgeLedgerRecordsPartialCompletion(): void {
  const initial = createKnowledgeRunLedger({
    runId: "kb-run-partial",
    mode: "maintain",
    startedAt: 1,
    selectedBackend: "opencode",
    candidateBackends: ["opencode", "hermes", "codex-cli"]
  });
  const completed = recordKnowledgeRunCompletion(initial, {
    completion: "partial",
    completedAt: 4,
    pendingSources: ["raw/b.md", "raw/b.md", "raw/c.md"]
  });

  assert.deepEqual(completed.pendingSources, ["raw/b.md", "raw/c.md"]);
  assert.equal(knowledgeRunStatus(completed), "success");
  assert.equal(summarizeKnowledgeRunLedger(completed).pendingSourceCount, 2);
  assert.throws(
    () => recordKnowledgeRunCompletion(initial, {
      completion: "partial",
      completedAt: 4,
      pendingSources: []
    }),
    /partial completion requires pending sources/
  );
}

function assertKnowledgeLedgerRejectsConflictingAttemptIdentity(): void {
  const initial = createKnowledgeRunLedger({
    runId: "kb-run-attempt-conflict",
    mode: "maintain",
    startedAt: 1,
    selectedBackend: "codex-cli",
    candidateBackends: ["codex-cli", "opencode", "hermes"]
  });
  const recorded = recordKnowledgeRunAttempt(initial, {
    attemptId: "kb-run-attempt-conflict:attempt:1:codex-cli",
    ordinal: 1,
    backend: "codex-cli"
  });

  assert.throws(
    () => recordKnowledgeRunAttempt(recorded, {
      attemptId: "kb-run-attempt-conflict:attempt:1:codex-cli",
      ordinal: 1,
      backend: "opencode"
    }),
    /attempt identity conflict/
  );
  assert.throws(
    () => recordKnowledgeRunAttempt(recorded, {
      attemptId: "another-attempt-id",
      ordinal: 1,
      backend: "codex-cli"
    }),
    /attempt ordinal conflict/
  );
}

function assertKnowledgeLedgerRecordsStructuredFailureIdempotently(): void {
  const initial = createKnowledgeRunLedger({
    runId: "kb-run-hard-failure",
    mode: "maintain",
    startedAt: 1,
    selectedBackend: "codex-cli",
    candidateBackends: ["codex-cli"]
  });
  const failure = {
    failureCode: "termination-unconfirmed",
    completedAt: 9,
    pendingSources: ["raw/a.md"]
  };
  const failed = recordKnowledgeRunFailure(initial, failure);

  assert.deepEqual(recordKnowledgeRunFailure(failed, failure), failed);
  assert.equal(knowledgeRunStatus(failed), "failed");
  assert.equal(summarizeKnowledgeRunLedger(failed).failureCode, "termination-unconfirmed");
  assert.throws(
    () => recordKnowledgeRunCompletion(failed, {
      completion: "full",
      completedAt: 10,
      pendingSources: []
    }),
    /failed ledger cannot be completed/
  );
}
