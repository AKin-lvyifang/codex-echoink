import * as assert from "node:assert/strict";
import { createKnowledgeRunLedger, knowledgeRunStatus, summarizeKnowledgeRunLedger } from "../../workflows/knowledge/ledger/knowledge-run-ledger";

export async function runHarnessV2KnowledgeLedgerTests(): Promise<void> {
  assertKnowledgeLedgerSuccessDoesNotDependOnAgentText();
  assertKnowledgeLedgerFailureComesFromValidation();
}

function assertKnowledgeLedgerSuccessDoesNotDependOnAgentText(): void {
  const ledger = createKnowledgeRunLedger({
    runId: "kb-run-1",
    mode: "maintain",
    startedAt: 1
  });
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
